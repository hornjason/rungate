/**
 * Posting a reading's findings as review threads, and the states that are
 * not a posting.
 *
 * The producer half of #1612. `reviewThreadRequests` decides WHICH comments;
 * this decides what happened when they were sent, which is a different
 * question with a worse failure mode: "zero comments posted" is the same
 * observation whether the review found nothing, could not run, was handed a
 * read-only token, or is simply broken. Four states, one channel — the sixth
 * shape in `.claude/rules/checks-must-be-able-to-fail.md`. So the outcome is
 * named, and only one of the four is a refusal.
 *
 * No network: the poster is injected, so every case here is the real
 * decision over a recorded response.
 */
import { describe, expect, test } from "bun:test";
import {
  AI_REVIEW_PR_IS_FORK_VAR,
  AI_REVIEW_THREADS_REFUSAL,
  aiReviewThreadsExitCode,
  postReviewThreads,
  prIsForkReading,
  threadsDetailLines,
  threadsLandedPhrase,
  type AiReviewThreadPoster,
} from "../lib/ai-review-threads";
import type { AiReviewFindingsReading } from "../lib/scaffold/ai-review-findings";

function reading(
  reported: unknown[] | null,
  outcome: "CLEAN" | "BLOCKED" | "UNMEASURED" = "BLOCKED",
): AiReviewFindingsReading {
  return { outcome, reported, unlocatableReported: null } as unknown as AiReviewFindingsReading;
}

const finding = { file: "src/a.ts", line: 12, summary: "off-by-one", failure_scenario: "n=0" };

/** The #1740 shape: a carried finding on a path the pull request never touched. */
const carried = { file: "lib/github.ts", line: 259, summary: "carried from an earlier round" };

function withScope(reported: unknown[], files: string[]): AiReviewFindingsReading {
  return {
    outcome: "BLOCKED",
    reported,
    unlocatableReported: null,
    scope: { status: "MEASURED", files, reason: null, detail: "" },
  } as unknown as AiReviewFindingsReading;
}

/** Two findings on a path absent from the changed set — nothing is postable. */
const outOfDiff = () => withScope([carried, { ...carried, line: 266 }], ["lib/work-status.ts"]);
/** The same two, with the path present — both ARE postable, so a 422 is real. */
const inDiff = () => withScope([carried, { ...carried, line: 266 }], ["lib/github.ts"]);

/** Records what it was asked to send and answers however the case wants. */
function recorder(answer: (n: number) => Awaited<ReturnType<AiReviewThreadPoster>>) {
  const sent: { path: string; line: number | null }[] = [];
  const post: AiReviewThreadPoster = async req => {
    sent.push({ path: req.path, line: req.line });
    return answer(sent.length);
  };
  return { sent, post };
}

const ok = async () => ({ ok: true }) as const;

describe("postReviewThreads", () => {
  test("a finding that posts is POSTED, and the request reaches the poster", async () => {
    const { sent, post } = recorder(() => ({ ok: true }));
    const r = await postReviewThreads(reading([finding]), post);
    expect(r.outcome).toBe("POSTED");
    expect(r.posted).toBe(1);
    expect(sent).toEqual([{ path: "src/a.ts", line: 12 }]);
  });

  test("an UNMEASURED reading posts nothing and is not a refusal", async () => {
    const { sent, post } = recorder(() => ({ ok: true }));
    const r = await postReviewThreads(reading([finding], "UNMEASURED"), post);
    expect(r.outcome).toBe("UNMEASURED");
    expect(sent).toEqual([]);
    expect(aiReviewThreadsExitCode(r)).toBe(0);
  });

  test("CONTROL: the same payload under a measured reading IS posted", async () => {
    // Without this, the case above passes over a function that posts nothing
    // ever. It is the one input that separates "withheld because UNMEASURED"
    // from "withheld because the poster is dead".
    const { sent, post } = recorder(() => ({ ok: true }));
    await postReviewThreads(reading([finding], "BLOCKED"), post);
    expect(sent).toHaveLength(1);
  });

  test("a clean review has nothing to post, and that is not a failure", async () => {
    const r = await postReviewThreads(reading([], "CLEAN"), ok);
    expect(r.outcome).toBe("NOTHING_TO_POST");
    expect(aiReviewThreadsExitCode(r)).toBe(0);
  });

  test("a 422 on a line demotes to a file-level comment rather than losing the finding", async () => {
    // The documented refusal for a line outside a diff hunk. Being in the
    // changed set proves a FILE, never a hunk, so this is an expected
    // response and not an error.
    const { sent, post } = recorder(n =>
      n === 1 ? { ok: false, status: 422, message: "line must be part of the diff" } : { ok: true },
    );
    const r = await postReviewThreads(reading([finding]), post);
    expect(sent).toEqual([
      { path: "src/a.ts", line: 12 },
      { path: "src/a.ts", line: null },
    ]);
    expect(r.outcome).toBe("POSTED");
    expect(r.demoted).toBe(1);
  });

  test("a 422 that survives the demotion is a real failure", async () => {
    const { post } = recorder(() => ({ ok: false, status: 422, message: "nope" }));
    const r = await postReviewThreads(reading([finding]), post);
    expect(r.outcome).toBe("FAILED");
    // `.not.toBe(0)` and not only the constant comparison: asserting
    // `toBe(AI_REVIEW_THREADS_REFUSAL)` alone compares the constant to
    // itself, so zeroing it keeps BOTH sides at 0 and the case stays
    // green over a refusal that stopped happening. Measured — the
    // mutant passed 9 of 9 until this line was added.
    expect(aiReviewThreadsExitCode(r)).not.toBe(0);
    expect(aiReviewThreadsExitCode(r)).toBe(AI_REVIEW_THREADS_REFUSAL);
  });

  test("a carried finding whose file left the diff does not redden the job", async () => {
    // #1740, head `1d95e1da457cf5fc91298bd017a94087b8244d46`, run
    // `41950364518`: two findings carried onto `lib/github.ts`, which that
    // pull request does not touch. GitHub answered the line AND the
    // file-level retry with
    //   422 pull_request_review_thread.path "could not be resolved"
    // so both landed in `failed`, the job exited 1, and a required check
    // sat red over a branch with nothing wrong in it.
    //
    // The finding is not dropped — it stays in `reported`, in the ledger,
    // and in the adjudicator's annotation. It simply stops being posted to
    // a diff that has no such path, which is the only honest thing to do
    // with it and is not a defect in this producer.
    const { sent, post } = recorder(() => ({
      ok: false,
      status: 422,
      message: 'Validation Failed: {"field":"pull_request_review_thread.path"}',
    }));
    const r = await postReviewThreads(outOfDiff(), post);
    expect(sent).toEqual([]);
    expect(r.outcome).toBe("NOTHING_TO_POST");
    expect(aiReviewThreadsExitCode(r)).toBe(0);
  });

  test("CONTROL: the identical 422 for a path IN the diff still refuses", async () => {
    // The case above must not become a blanket excuse. This is the fifth
    // shape in checks-must-be-able-to-fail.md — the cheap wrong fix here is
    // "make a surviving 422 non-fatal", which turns a genuinely broken
    // producer into a green required check. Same response, same assertion
    // target, one input changed: the path is one the pull request touches.
    const { sent, post } = recorder(() => ({
      ok: false,
      status: 422,
      message: 'Validation Failed: {"field":"pull_request_review_thread.path"}',
    }));
    const r = await postReviewThreads(inDiff(), post);
    // FOUR, not two: each finding is attempted at its line and then again at
    // file level, because a 422 on a line is the documented answer for a
    // line outside a hunk and the demotion is part of the contract. Both
    // retries are what the out-of-diff case above must not spend.
    expect(sent).toHaveLength(4);
    expect(r.outcome).toBe("FAILED");
    expect(aiReviewThreadsExitCode(r)).not.toBe(0);
  });

  test("a 403 is the fork token, and degrades instead of reddening the job", async () => {
    // A `pull_request` from a fork gets write permissions downgraded to read
    // whatever the workflow declares. The annotation is still produced by the
    // adjudicator, so the review is not lost — but this producer cannot run,
    // and failing here would red every fork pull request for a reason the
    // contributor cannot fix.
    const { post } = recorder(() => ({ ok: false, status: 403, message: "Resource not accessible" }));
    const r = await postReviewThreads(reading([finding]), post);
    expect(r.outcome).toBe("DEGRADED_NO_WRITE");
    expect(aiReviewThreadsExitCode(r)).toBe(0);
    expect(r.detail.join(" ")).toContain("403");
  });

  test("DEGRADED_NO_WRITE does not swallow a failure that is not the token", async () => {
    // Two findings, one 403 and one 500. A reading that reported only the
    // degradation would hide a broken producer behind a fork.
    const { post } = recorder(n =>
      n === 1
        ? { ok: false, status: 403, message: "Resource not accessible" }
        : { ok: false, status: 500, message: "boom" },
    );
    const r = await postReviewThreads(reading([finding, { ...finding, file: "src/b.ts" }]), post);
    expect(r.outcome).toBe("FAILED");
    // `.not.toBe(0)` and not only the constant comparison: asserting
    // `toBe(AI_REVIEW_THREADS_REFUSAL)` alone compares the constant to
    // itself, so zeroing it keeps BOTH sides at 0 and the case stays
    // green over a refusal that stopped happening. Measured — the
    // mutant passed 9 of 9 until this line was added.
    expect(aiReviewThreadsExitCode(r)).not.toBe(0);
    expect(aiReviewThreadsExitCode(r)).toBe(AI_REVIEW_THREADS_REFUSAL);
  });

  // #1736. The 422 the demotion cannot clear.
  //
  // Both strings below are the API's real responses, copied from a run. They
  // differ in the ONE thing the branch is allowed to read — the condition —
  // and in nothing else: same status, same shape, same plausibility. That is
  // the pair, and without the second one the first is green over a branch
  // that degrades every 422 it sees.
  const PENDING_422 =
    'Validation Failed: {"resource":"PullRequestReview","code":"custom",' +
    '"field":"user_id","message":"user_id can only have one pending review per pull request"}';
  const LINE_422 =
    'Validation Failed: {"resource":"PullRequestReviewComment","code":"custom",' +
    '"field":"line","message":"line must be part of the diff"}';

  test("a pending review is a state of the pull request, not a broken producer", async () => {
    // Observed on #1731 across three runs. The identity holding the pending
    // review is the job's own `github-actions[bot]`, so nobody can clear it
    // from the UI; reddening a required check for it blocks a pull request
    // whose review PASSED, for a reason no author can act on.
    const { sent, post } = recorder(() => ({ ok: false, status: 422, message: PENDING_422 }));
    const r = await postReviewThreads(reading([finding]), post);
    expect(r.outcome).toBe("BLOCKED_BY_PENDING_REVIEW");
    expect(aiReviewThreadsExitCode(r)).toBe(0);
    expect(r.detail.join(" ")).toContain("pending review");

    // Only this branch can produce a single request. The demotion is the
    // generic 422 path and sends a second, file-level one — so a length of 1
    // is an observation the status code alone cannot make, which is the sixth
    // shape in `.claude/rules/checks-must-be-able-to-fail.md`. Retrying at
    // file level here cannot work: the lock is on the review, not the anchor.
    expect(sent).toEqual([{ path: "src/a.ts", line: 12 }]);
  });

  test("CONTROL: a 422 that is NOT the pending review still demotes, then fails", async () => {
    // The row that differs. Same status, the other condition — and it must
    // reach neither the new outcome nor a free pass. If this goes green as
    // BLOCKED_BY_PENDING_REVIEW the detector is reading the status code.
    const { sent, post } = recorder(() => ({ ok: false, status: 422, message: LINE_422 }));
    const r = await postReviewThreads(reading([finding]), post);
    expect(sent).toHaveLength(2);
    expect(r.outcome).toBe("FAILED");
    expect(aiReviewThreadsExitCode(r)).not.toBe(0);
    expect(aiReviewThreadsExitCode(r)).toBe(AI_REVIEW_THREADS_REFUSAL);
  });

  test("CONTROL: the condition alone is not enough — a 500 that says it is still a failure", async () => {
    // The other half of the conjunction. Without this row, dropping the
    // status check from the predicate reddens nothing and the test above
    // measures one operand of two — half a conjunction is green by
    // construction. A 5xx is the producer being broken whatever its body says.
    const { post } = recorder(() => ({ ok: false, status: 500, message: PENDING_422 }));
    const r = await postReviewThreads(reading([finding]), post);
    expect(r.outcome).toBe("FAILED");
    expect(aiReviewThreadsExitCode(r)).toBe(AI_REVIEW_THREADS_REFUSAL);
  });

  test("a pending review does not swallow a failure that is not the lock", async () => {
    // Same ordering argument as the 403 case: a real failure outranks a state
    // of the pull request, or a broken producer hides behind one.
    const { post } = recorder(n =>
      n === 1
        ? { ok: false, status: 422, message: PENDING_422 }
        : { ok: false, status: 500, message: "boom" },
    );
    const r = await postReviewThreads(reading([finding, { ...finding, file: "src/b.ts" }]), post);
    expect(r.outcome).toBe("FAILED");
    expect(aiReviewThreadsExitCode(r)).not.toBe(0);
    expect(aiReviewThreadsExitCode(r)).toBe(AI_REVIEW_THREADS_REFUSAL);
  });

  test("the pending-review condition is decided in exactly one place", async () => {
    // One binding to mutate. A second site deciding the same question would
    // hold every case above up on its own, so a mutation of either would
    // leave the suite green — the fourth shape in
    // `.claude/rules/checks-must-be-able-to-fail.md`.
    const src = await Bun.file(new URL("../lib/ai-review-threads.ts", import.meta.url)).text();
    expect(src.match(/function isPendingReviewRefusal/g) ?? []).toHaveLength(1);
    expect(src.match(/PENDING_REVIEW_CONDITION/g) ?? []).toHaveLength(2);
  });

  // Round 1 of review on #1737, and the finding is about BOTH degradations
  // rather than the one that was named. Each is selected on a COUNT of
  // refusals, never on `posted === 0`, so each can be reached with comments
  // already on the diff — and each opened its annotation by denying them.
  test("a round that posted some and then hit the lock does not claim it posted none", async () => {
    const { post } = recorder(n =>
      n === 1 ? { ok: true } : { ok: false, status: 422, message: PENDING_422 },
    );
    const r = await postReviewThreads(reading([finding, { ...finding, file: "src/b.ts" }]), post);
    expect(r.outcome).toBe("BLOCKED_BY_PENDING_REVIEW");
    expect(r.posted).toBe(1);
    expect(threadsLandedPhrase(r)).toBe("Only 1 of 2 review threads were created");
  });

  test("the same is true of the fork degradation — one phrase, both outcomes", async () => {
    // The other member of the population. Fixing only the outcome a reviewer
    // named leaves the identical false claim one branch above it.
    const { post } = recorder(n =>
      n === 1 ? { ok: true } : { ok: false, status: 403, message: "Resource not accessible" },
    );
    const r = await postReviewThreads(reading([finding, { ...finding, file: "src/b.ts" }]), post);
    expect(r.outcome).toBe("DEGRADED_NO_WRITE");
    expect(threadsLandedPhrase(r)).toBe("Only 1 of 2 review threads were created");
  });

  test("a round that really posted nothing still says so", async () => {
    // The control. Without it the phrase could return the qualified form
    // always and both cases above would stay green over a sentence that is
    // now wrong in the other direction.
    const { post } = recorder(() => ({ ok: false, status: 422, message: PENDING_422 }));
    const r = await postReviewThreads(reading([finding]), post);
    expect(threadsLandedPhrase(r)).toBe("No review threads were created");
  });

  test("no annotation spells the claim for itself", async () => {
    // One binding. A branch that inlines the sentence keeps its own copy of
    // the bug, and a behavioural case cannot see the branch it did not take.
    const script = await Bun.file(
      new URL("../scripts/ai-review-threads.ts", import.meta.url),
    ).text();
    expect(script.match(/review threads were created/g) ?? []).toHaveLength(0);
    // Call sites, not mentions — counting the symbol would count the import
    // too, and the number would then move for a reason that is not a branch
    // spelling the claim for itself.
    expect(script.match(/threadsLandedPhrase\(result\)/g) ?? []).toHaveLength(2);
  });

  test("every refusal comes through the one constant", async () => {
    // So a mutant that zeroes it can be observed. A second literal exit code
    // somewhere in the module would survive the mutation and the case would
    // go green over a refusal that no longer came from here.
    const src = await Bun.file(
      new URL("../lib/ai-review-threads.ts", import.meta.url),
    ).text();
    const declarations = src.match(/AI_REVIEW_THREADS_REFUSAL\s*=/g) ?? [];
    expect(declarations).toHaveLength(1);
  });
});

/**
 * #1992 finding 1: a 403 degrades only when the run IS a fork. The fork
 * signal arrives as an environment variable (#2203 makes the workflow set
 * it), read exactly, and an absent one keeps today's degrade so a new CLI
 * under an old workflow behaves as it did.
 */
describe("#1992: a 403 on a same-repository run is FAILED", () => {
  const forbidden = () => recorder(() => ({ ok: false, status: 403, message: "Resource not accessible by integration" }));

  test("a 403 on a run that is NOT a fork is FAILED — the token lost write, the contributor did not", async () => {
    const { post } = forbidden();
    const r = await postReviewThreads(reading([finding]), post, undefined, false);
    expect(r.outcome).toBe("FAILED");
    expect(aiReviewThreadsExitCode(r)).not.toBe(0);
    expect(r.detail.join(" ")).toContain("not a fork");
  });

  test("a 403 on a fork still degrades", async () => {
    const { post } = forbidden();
    const r = await postReviewThreads(reading([finding]), post, undefined, true);
    expect(r.outcome).toBe("DEGRADED_NO_WRITE");
    expect(aiReviewThreadsExitCode(r)).toBe(0);
  });

  test("an unknown fork status keeps today's degrade, and says it was not read", async () => {
    const { post } = forbidden();
    const r = await postReviewThreads(reading([finding]), post, undefined, null);
    expect(r.outcome).toBe("DEGRADED_NO_WRITE");
    expect(r.detail.join(" ")).toContain(AI_REVIEW_PR_IS_FORK_VAR);
  });

  // Read exactly, the way `.claude/rules/config-access.md` reads a switch: a
  // loose reading of a variable that turns a refusal on is a refusal that
  // turns itself on by accident.
  test("the fork variable is read exactly: only 'true' and 'false' are readings", () => {
    expect(prIsForkReading("true")).toBe(true);
    expect(prIsForkReading("false")).toBe(false);
    for (const raw of [undefined, "", "TRUE", "False", "1", "0", " true", "yes"]) {
      expect(prIsForkReading(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  test("the variable's name is the one constant #2203's generator will emit", () => {
    expect(AI_REVIEW_PR_IS_FORK_VAR).toBe("RUNGATE_PR_IS_FORK");
  });
});

/**
 * #1992 finding 2: the scope check reads a finding's NORMALISED path, so the
 * request must carry that spelling too. Sending the raw one asks GitHub for a
 * path it cannot resolve, the file-level retry is refused the same way, and
 * the round ends FAILED over a finding that was correctly in the diff.
 *
 * The existing CONTROL above stays: a 422 that survives the demotion for a
 * path genuinely in the diff is still a failure. Only the spelling changes.
 */
describe("#1992: a finding is sent in the spelling the scope check matched", () => {
  for (const raw of ["./lib/github.ts", "lib/./github.ts", "/lib/github.ts", "lib//github.ts", "lib\\github.ts", "src/../lib/github.ts"]) {
    test(`'${raw}' is sent as 'lib/github.ts'`, async () => {
      const { sent, post } = recorder(() => ({ ok: true }));
      const r = await postReviewThreads(withScope([{ ...carried, file: raw }], ["lib/github.ts"]), post);
      expect(r.outcome).toBe("POSTED");
      expect(sent).toEqual([{ path: "lib/github.ts", line: 259 }]);
    });
  }

  test("a ':line' suffix still supplies the line, and is not sent as part of the path", async () => {
    const { sent, post } = recorder(() => ({ ok: true }));
    await postReviewThreads(withScope([{ file: "./lib/github.ts:42", summary: "s" }], ["lib/github.ts"]), post);
    expect(sent).toEqual([{ path: "lib/github.ts", line: 42 }]);
  });
});

/**
 * #1992 finding 4: detail lines carry text the producer does not control —
 * an API error message, a path a finding named. Printed raw, a CR or LF in
 * one starts a new line, and a new line beginning `::` is a workflow command
 * (`escapeAnnotation`'s own docstring records `::stop-commands::` reached
 * that way). Every line this command prints from a result goes through the
 * one escaper.
 */
describe("#1992: no detail line reaches the workflow-command channel unescaped", () => {
  const hostile = "benign\n::stop-commands::deadbeef\r\n::notice::all clear 100%";

  test("threadsDetailLines escapes CR, LF and %", () => {
    const lines = threadsDetailLines(
      { outcome: "FAILED", attempted: 1, posted: 0, demoted: 0, detail: [hostile] },
      "ai-review-threads",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/[\r\n]/);
    expect(lines[0]).toStartWith("ai-review-threads: ");
    expect(lines[0]).toContain("%0A::stop-commands::");
    expect(lines[0]).toContain("100%25");
  });

  test("an API message carrying a newline cannot start its own line in what the command prints", async () => {
    const { post } = recorder(() => ({ ok: false, status: 500, message: hostile }));
    const r = await postReviewThreads(reading([finding]), post);
    for (const line of threadsDetailLines(r, "ai-review-threads")) {
      expect(line).not.toMatch(/[\r\n]/);
    }
  });

  test("the command prints result detail only through threadsDetailLines", async () => {
    const script = await Bun.file(new URL("../scripts/ai-review-threads.ts", import.meta.url)).text();
    expect(script).toContain("threadsDetailLines(result");
    expect(script, "a second, unescaped printer of result.detail").not.toContain("result.detail");
  });

  test("an argument error is escaped before it is interpolated into the warning", () => {
    const r = Bun.spawnSync(["bun", "scripts/ai-review-threads.ts", "a\n::notice::forged", "b"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = new TextDecoder().decode(r.stdout);
    expect(out, "the warning was never printed, so nothing was tested").toContain("::warning title=AI review threads::");
    expect(out.split("\n").some(l => l.startsWith("::notice::forged"))).toBe(false);
  });
});
