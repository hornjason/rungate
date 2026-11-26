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
  refusalFrom,
  THREAD_BODY_BUDGET,
  prIsForkReading,
  threadReading,
  threadsDetailLines,
  threadsLandedPhrase,
  type AiReviewThreadPoster,
  UNREASONED_MARKER,
  unreasonedReport,
  unreasonedResolutions,
} from "../lib/ai-review-threads";
import type { AiReviewFindingsReading, AiReviewThreadRequest } from "../lib/scaffold/ai-review-findings";
import { readAiReviewFindings, threadBody } from "../lib/scaffold/ai-review-findings";
import { mergeDrafts } from "../lib/ai-review-drafts";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  AI_REVIEW_CHECKOUT_ROOT_VAR,
  AI_REVIEW_FORK_VAR,
  AI_REVIEW_THREADS_STEP_ID,
  aiReviewUnknownCommandLine,
  buildThreadsScript,
} from "../lib/scaffold/ai-review-step";

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

  // #2338: a finding GitHub will not put on the diff at all still reaches the
  // pull request, as a PR-level comment that says why it is not on the diff.
  const refused = () => ({ ok: false, status: 422, message: "Validation Failed: pull_request_review_thread.path" }) as const;
  function pullCommenter(answer: () => Awaited<ReturnType<AiReviewThreadPoster>> = () => ({ ok: true }), existing: string[] = []) {
    const bodies: string[] = [];
    return { bodies, comment: { existing, post: async (body: string) => (bodies.push(body), answer()) } };
  }

  test("#2338: refused at line and at file level, the finding is posted as a pull-request comment saying why", async () => {
    const { post } = recorder(refused);
    const { bodies, comment } = pullCommenter();
    const r = await postReviewThreads(reading([finding]), post, undefined, undefined, comment);
    expect(r.outcome).toBe("POSTED");
    expect(r.pullComments).toBe(1);
    expect(aiReviewThreadsExitCode(r)).toBe(0);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("off-by-one");
    expect(bodies[0]).toContain("is not in this pull request's diff");
    expect(r.detail.join("\n")).toContain("not in this pull request's diff");
  });

  test("#2338: a pull-request comment that is refused too is still FAILED, naming both refusals", async () => {
    const { post } = recorder(refused);
    const { comment } = pullCommenter(() => ({ ok: false, status: 500, message: "boom" }));
    const r = await postReviewThreads(reading([finding]), post, undefined, undefined, comment);
    expect(r.outcome).toBe("FAILED");
    expect(r.detail.join("\n")).toContain("boom");
  });

  test("#2338: a finding already posted as a pull-request comment is not posted again", async () => {
    const { post } = recorder(refused);
    const keyFor = () => "src/a.ts\u0000n:12\u0000off-by-one";
    const first = pullCommenter();
    await postReviewThreads(reading([finding]), post, keyFor, undefined, first.comment);
    const again = pullCommenter(() => ({ ok: true }), first.bodies);
    const r = await postReviewThreads(reading([finding]), post, keyFor, undefined, again.comment);
    expect(again.bodies).toEqual([]);
    expect(r.outcome).toBe("POSTED");
    expect(r.detail.join("\n")).toContain("already");
  });

  test("#2338 review: a 422 that is not about the path (a stale commit) stays FAILED, never goes to the conversation", async () => {
    const { post } = recorder(() => ({ ok: false, status: 422, message: "Validation Failed: pull_request_review_thread.commit_id is not part of the pull request" }));
    const { bodies, comment } = pullCommenter();
    const r = await postReviewThreads(reading([finding]), post, undefined, undefined, comment);
    expect(r.outcome).toBe("FAILED");
    expect(bodies).toEqual([]);
  });

  test("#2358 review: a 422 that only mentions the word path, not the path field, stays FAILED", async () => {
    const { post } = recorder(() => ({ ok: false, status: 422, message: "Validation Failed: body is too long (maximum is 65536 characters) for the comment at this path" }));
    const { bodies, comment } = pullCommenter();
    const r = await postReviewThreads(reading([finding]), post, undefined, undefined, comment);
    expect(r.outcome).toBe("FAILED");
    expect(bodies).toEqual([]);
  });

  test("#2358 review: GitHub's errors-array shape naming the path field goes on the conversation", async () => {
    const { post } = recorder(() => ({ ok: false, status: 422, message: 'Validation Failed: {"resource":"PullRequestReviewComment","code":"invalid","field":"path"}' }));
    const { bodies, comment } = pullCommenter();
    const r = await postReviewThreads(reading([finding]), post, undefined, undefined, comment);
    expect(r.outcome).toBe("POSTED");
    expect(bodies).toHaveLength(1);
  });

  test("#2358 review: a same-round repeat says it was posted earlier this round, not in an earlier round", async () => {
    const { post } = recorder(refused);
    const { comment } = pullCommenter();
    const keyFor = () => "src/a.ts\u0000n:12\u0000off-by-one";
    // Two lines, one key: at one line the two would share a thread (#2838)
    // and never reach the conversation twice.
    const r = await postReviewThreads(reading([finding, { ...finding, line: 13 }]), post, keyFor, undefined, comment);
    const text = r.detail.join("\n");
    expect(text).toContain("earlier in this round");
    expect(text).not.toContain("from an earlier round");
  });

  test("#2338 review: a finding with no line says it was refused at the file, not at the line", async () => {
    const { post } = recorder(refused);
    const { bodies, comment } = pullCommenter();
    await postReviewThreads(reading([{ ...finding, line: undefined }]), post, undefined, undefined, comment);
    expect(bodies[0]).toContain("GitHub refused it at the file.");
    expect(bodies[0]).not.toContain("at the line");
  });

  test("#2338 review: two findings with one key in one round go on the conversation once", async () => {
    const { post } = recorder(refused);
    const { bodies, comment } = pullCommenter();
    const keyFor = () => "src/a.ts\u0000n:12\u0000off-by-one";
    const r = await postReviewThreads(reading([finding, { ...finding }]), post, keyFor, undefined, comment);
    expect(bodies).toHaveLength(1);
    expect(r.outcome).toBe("POSTED");
  });

  test("#2358 review: a fork's read-only token refusing the conversation comment degrades, it does not fail", async () => {
    const { post } = recorder(refused);
    const { comment } = pullCommenter(() => ({ ok: false, status: 403, message: "Resource not accessible by integration" }));
    const r = await postReviewThreads(reading([finding]), post, undefined, true, comment);
    expect(r.outcome).toBe("DEGRADED_NO_WRITE");
    expect(aiReviewThreadsExitCode(r)).toBe(0);
  });

  test("#2358 review: the same 403 on a run that is NOT a fork is still FAILED", async () => {
    const { post } = recorder(refused);
    const { comment } = pullCommenter(() => ({ ok: false, status: 403, message: "Resource not accessible by integration" }));
    const r = await postReviewThreads(reading([finding]), post, undefined, false, comment);
    expect(r.outcome).toBe("FAILED");
  });

  // #2363: classify from GitHub's structured `errors[]`, the message text only
  // when the body carries none.
  test("#2363: errors[].field 'path' goes to the conversation whatever the message says", async () => {
    const { post } = recorder(() => ({ ok: false, status: 422, message: "Validation Failed", errors: [{ field: "path", code: "invalid" }] }));
    const { bodies, comment } = pullCommenter();
    const r = await postReviewThreads(reading([finding]), post, undefined, undefined, comment);
    expect(r.outcome).toBe("POSTED");
    expect(bodies).toHaveLength(1);
  });

  test("#2363: a message naming the path field with errors[].field 'commit_id' stays FAILED", async () => {
    const { post } = recorder(() => ({
      ok: false,
      status: 422,
      message: "Validation Failed: pull_request_review_thread.path",
      errors: [{ field: "commit_id", code: "invalid" }],
    }));
    const { bodies, comment } = pullCommenter();
    const r = await postReviewThreads(reading([finding]), post, undefined, undefined, comment);
    expect(r.outcome).toBe("FAILED");
    expect(bodies).toEqual([]);
  });

  test("#2370 review: with no field named, the off-diff text inside errors[] counts, as it does for pending review", async () => {
    const { post } = recorder(() => ({
      ok: false,
      status: 422,
      message: "Validation Failed",
      errors: [{ message: 'pull_request_review_thread.path "could not be resolved"' }],
    }));
    const { bodies, comment } = pullCommenter();
    const r = await postReviewThreads(reading([finding]), post, undefined, undefined, comment);
    expect(r.outcome).toBe("POSTED");
    expect(bodies).toHaveLength(1);
  });

  test("#2363: refusalFrom keeps Octokit's errors[], objects and strings alike", () => {
    const e = Object.assign(new Error("Validation Failed"), {
      status: 422,
      response: { data: { errors: [{ field: "path", code: "invalid", resource: "PullRequestReviewComment" }, "User can only have one pending review per pull request"] } },
    });
    expect(refusalFrom(e)).toEqual({
      ok: false,
      status: 422,
      message: "Validation Failed",
      errors: [{ field: "path", code: "invalid" }, { message: "User can only have one pending review per pull request" }],
    });
    expect(refusalFrom(new Error("socket hang up"))).toEqual({ ok: false, status: null, message: "socket hang up" });
  });

  test("#2363: a pending-review refusal carried only in errors[] is still the pending-review state", async () => {
    const { post } = recorder(() => ({
      ok: false,
      status: 422,
      message: "Unprocessable Entity",
      errors: [{ message: "User can only have one pending review per pull request" }],
    }));
    const r = await postReviewThreads(reading([finding]), post);
    expect(r.outcome).toBe("BLOCKED_BY_PENDING_REVIEW");
  });

  test("#2338: with no pull-request commenter the old behaviour holds: FAILED", async () => {
    const { post } = recorder(refused);
    const r = await postReviewThreads(reading([finding]), post);
    expect(r.outcome).toBe("FAILED");
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

  // Case is kept: the API matches byte for byte, and the comparison form is
  // lowercase. When the finding matched a changed file, that file's own
  // spelling is what goes out.
  test("the diff's own spelling is sent when a finding matched it in another case", async () => {
    const { sent, post } = recorder(() => ({ ok: true }));
    await postReviewThreads(withScope([{ file: "./lib/GitHub.ts", line: 3, summary: "s" }], ["lib/github.ts"]), post);
    expect(sent).toEqual([{ path: "lib/github.ts", line: 3 }]);
  });

  test("with no changed-file list, the finding's own case survives the cleanup", async () => {
    const { sent, post } = recorder(() => ({ ok: true }));
    await postReviewThreads(reading([{ file: "./src/Thing.ts", line: 4, summary: "s" }]), post);
    expect(sent).toEqual([{ path: "src/Thing.ts", line: 4 }]);
  });

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
      { outcome: "FAILED", attempted: 1, posted: 0, demoted: 0, pullComments: 0, together: 0, detail: [hostile] },
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

/**
 * #2664: the poster holds a token that can write, and `bunx` resolves
 * bunfig.toml, .npmrc and package.json by walking up from where it runs. So
 * it must not run in the checkout, which the branch under review wrote. The
 * AI review on #2668 found it still did. Driven, not grepped: the planted
 * `bunx` reports where it ran, what that directory held, and which checkout
 * it was told to read.
 */
describe("#2664: the generated threads step runs bunx from a fresh empty directory", () => {
  test("when the fresh directory cannot be made, bunx does not run, and the step fails", () => {
    // #2668 round 2: `cd ""` succeeds in bash, so a failed mktemp must stop
    // the chain itself rather than through the cd.
    const dir = mkdtempSync(join(tmpdir(), "rg-threads-nomktemp-"));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "bunx"), `#!/bin/sh\necho "bunx-ran cwd=$(pwd -P)"\nexit 0\n`);
      chmodSync(join(bin, "bunx"), 0o755);
      const workspace = join(dir, "workspace");
      mkdirSync(workspace);
      const findings = join(dir, "findings.json");
      writeFileSync(findings, "{}");
      const script = join(dir, "threads.sh");
      writeFileSync(script, buildThreadsScript("0.8.21"));
      const r = Bun.spawnSync(["bash", "-e", script], {
        cwd: workspace,
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          GITHUB_WORKSPACE: workspace,
          RUNNER_TEMP: join(dir, "no-such-runner-temp"),
          AI_REVIEW_THREADS_PR: "7",
          AI_REVIEW_FINDINGS_PATH: findings,
          AI_REVIEW_THREADS_REPO: "o/r",
          AI_REVIEW_THREADS_SHA: "abc",
          AI_REVIEW_THREADS_TOKEN: "t",
          AI_REVIEW_CHANGED_FILES_PATH: join(dir, "changed.txt"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = new TextDecoder().decode(r.stdout);
      expect(out, "bunx ran in the checkout although no fresh directory was made").not.toContain("bunx-ran");
      expect(r.exitCode, "the step posted nothing and still passed").not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("not the checkout, nothing in it, and the checkout named for the cited lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-threads-cwd-"));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(
        join(bin, "bunx"),
        `#!/bin/sh\necho "cwd=$(pwd -P)"\necho "seen-files=[$(ls -A)]"\necho "root=$${AI_REVIEW_CHECKOUT_ROOT_VAR}"\nexit 0\n`,
      );
      chmodSync(join(bin, "bunx"), 0o755);
      // The checkout carries what a branch could commit: a bunfig.toml naming
      // its own registry. Run from here, bunx would read it.
      const workspace = join(dir, "workspace");
      mkdirSync(workspace);
      writeFileSync(join(workspace, "bunfig.toml"), '[install]\nregistry = "https://registry.invalid/"\n');
      const runnerTemp = join(dir, "runner-temp");
      mkdirSync(runnerTemp);
      const findings = join(runnerTemp, "findings.json");
      writeFileSync(findings, "{}");
      const script = join(dir, "threads.sh");
      writeFileSync(script, buildThreadsScript("0.8.21"));
      const r = Bun.spawnSync(["bash", "-e", script], {
        cwd: workspace,
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          GITHUB_WORKSPACE: workspace,
          RUNNER_TEMP: runnerTemp,
          AI_REVIEW_THREADS_PR: "7",
          AI_REVIEW_FINDINGS_PATH: findings,
          AI_REVIEW_THREADS_REPO: "o/r",
          AI_REVIEW_THREADS_SHA: "abc",
          AI_REVIEW_THREADS_TOKEN: "t",
          AI_REVIEW_CHANGED_FILES_PATH: join(runnerTemp, "changed.txt"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = new TextDecoder().decode(r.stdout);
      const cwd = /^cwd=(.*)$/m.exec(out)?.[1];
      expect(cwd, `the planted bunx never ran:\n${out}`).toBeDefined();
      expect(cwd!, "the poster ran bunx in the checkout, where the branch's bunfig.toml decides the registry").not.toBe(
        realpathSync(workspace),
      );
      expect(cwd!, `the poster ran from ${cwd}, which is not a directory made for it`).toMatch(/\/rungate-bunx\.[A-Za-z0-9]+$/);
      expect(out, "the directory bunx ran from held files").toContain("seen-files=[]");
      expect(out, "the poster was not told where the checkout is, so it reads no cited line").toContain(`root=${workspace}`);
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * #2203, the generator halves of #1992. The threads step runs the PUBLISHED
 * CLI, so these change the workflow shell, and each waited on 0.8.21 (#2206)
 * publishing the CLI half.
 */
describe("#2203: the generated threads step", () => {
  /**
   * Runs the generated script under bash against a fake `bunx` that prints
   * what the case wants and exits with its code — the real shell, the real
   * branch, no stub of the decision.
   */
  function runThreads(out: string, code: number): { code: number | null; stdout: string } {
    const dir = mkdtempSync(join(tmpdir(), "rg-threads-skew-"));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(dir, "out.txt"), out);
      writeFileSync(join(bin, "bunx"), `#!/bin/sh\ncat "${join(dir, "out.txt")}"\nexit ${code}\n`);
      chmodSync(join(bin, "bunx"), 0o755);
      const findings = join(dir, "findings.json");
      writeFileSync(findings, "{}");
      const script = join(dir, "threads.sh");
      writeFileSync(script, buildThreadsScript("0.8.21"));
      const r = Bun.spawnSync(["bash", "-e", script], {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          AI_REVIEW_THREADS_PR: "7",
          AI_REVIEW_FINDINGS_PATH: findings,
          AI_REVIEW_THREADS_REPO: "o/r",
          AI_REVIEW_THREADS_SHA: "abc",
          AI_REVIEW_THREADS_TOKEN: "t",
          AI_REVIEW_CHANGED_FILES_PATH: join(dir, "changed.txt"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      return { code: r.exitCode, stdout: new TextDecoder().decode(r.stdout) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Built by the generator's own function, which the case below holds to the
  // line bin/rungate.ts prints (#2675 round 4).
  const SKEW_LINE = aiReviewUnknownCommandLine("ai-review-threads");

  test("the line the step matches is the line bin/rungate.ts prints for an unknown command", () => {
    // Without this, rewording either side leaves every case here green while
    // the annotation naming the cause stops being printed.
    const name = "no-such-command-2666";
    const r = Bun.spawnSync(["bun", "bin/rungate.ts", name], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    // Whole lines, anywhere in the output: the same reading the step's
    // `grep -qxF` takes. The CLI prints a version banner first.
    const lines = new TextDecoder().decode(r.stderr).split("\n");
    expect(r.exitCode, "an unknown command did not refuse").not.toBe(0);
    expect(lines, `bin/rungate.ts no longer prints the line the step matches:\n${lines.join("\n")}`).toContain(
      aiReviewUnknownCommandLine(name),
    );
  });
  // The warning this step printed until #2666, kept so the cases below can
  // assert it is gone rather than merely reworded.
  const SKEW_WARNING = "does not carry the ai-review-threads command yet";
  const MISSING_COMMAND = "::error title=AI review threads::";

  // #2666. This line used to read as version skew: a workflow ahead of the
  // published package, UNMEASURED, exit 0. That cannot be true any more: only
  // a version that has the command generates this step, and it pins itself.
  // So the pinned package lacks the command, either because the pin was edited
  // by hand or because that version's registry lost it. A warning on a green
  // job, with no threads posted, hid both.
  test("an unknown-command line is a command the pinned package lacks: the step fails, naming it", () => {
    const r = runThreads(`rungate-version: 0.8.20 (resolved at runtime, not the pin)\n${SKEW_LINE}\n\nUsage: …\n`, 1);
    expect(r.stdout, "the old reading survives: a missing command read as a release still to come").not.toContain(SKEW_WARNING);
    const annotation = r.stdout.split("\n").find(l => l.startsWith(MISSING_COMMAND));
    expect(annotation, `no error annotation was printed:\n${r.stdout}`).toBeDefined();
    expect(annotation!, "the annotation does not name the missing command").toContain("ai-review-threads");
    expect(annotation!, "the annotation does not name the version that lacks it").toContain("rungate@0.8.21");
    // #2675 round 2: a script missing from files[] prints the incomplete-install
    // message, never this line, so blaming files[] here names the wrong cause.
    expect(annotation!, "the annotation blames files[], which prints a different line").not.toContain("files[]");
    expect(r.code, "the step went green over a package that cannot post threads").not.toBe(0);
  });

  // The forgery the substring grep allowed: the phrase inside a line the
  // command printed. Exit 1 is a refusal from a CLI that HAS the command,
  // and it must stay one.
  test("the phrase mid-line in the command's own output is a refusal, not skew", () => {
    const r = runThreads(`ai-review-threads: a finding quoting ${SKEW_LINE} in its text\n`, 1);
    expect(r.stdout).not.toContain(SKEW_WARNING);
    expect(r.stdout, "a finding's text named a missing command it is not").not.toContain(MISSING_COMMAND);
    expect(r.code).toBe(1);
  });

  test("the bare phrase without the 'rungate: ' prefix is a refusal, not skew", () => {
    const r = runThreads('unknown command "ai-review-threads"\n', 1);
    expect(r.stdout).not.toContain(SKEW_WARNING);
    // #2675 round 4: and not the missing-command annotation either, so a match
    // that dropped the `rungate: ` prefix goes red here.
    expect(r.stdout, "the bare phrase was read as a missing command").not.toContain(MISSING_COMMAND);
    expect(r.code).toBe(1);
  });

  test("CONTROL: a clean run exits 0 with no skew warning", () => {
    const r = runThreads("ai-review-threads: POSTED — attempted 1, posted 1, demoted 0\n", 0);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain(SKEW_WARNING);
  });

  // Finding 1's generator half. The CLI reads the variable exactly (#2204);
  // this is what makes it set.
  test("the threads step sets the fork variable from the event", () => {
    const yml = readFileSync(new URL("../.github/workflows/ai-review.yml", import.meta.url), "utf-8");
    const at = yml.indexOf(`id: ${AI_REVIEW_THREADS_STEP_ID}`);
    expect(at, "the threads step is not in the committed workflow").toBeGreaterThan(-1);
    const step = yml.slice(at, yml.indexOf("run: |", at));
    expect(step).toContain(
      `${AI_REVIEW_FORK_VAR}: \${{ github.event.pull_request.head.repo.full_name != github.repository }}`,
    );
  });

  // The generator keeps its own constant rather than importing the CLI
  // module, which would pull a deep import tree into an import-light file.
  // So the two spellings are bound here instead.
  test("the generator's fork variable is the one the CLI reads", () => {
    expect(AI_REVIEW_FORK_VAR).toBe(AI_REVIEW_PR_IS_FORK_VAR);
  });
});

/**
 * #2306 — CRC-C3's clearing half, executed. A false positive clears by
 * closing the thread WITH A SHORT REASON; a thread the AI review opened and
 * somebody resolved with no reply reads the same as one nobody read, so each
 * review round reports those on the pull request's conversation, once per
 * thread. `reference/clearing-a-false-positive.md` is the procedure.
 */
describe("CRC-C3: a review thread resolved with no stated reason is reported on its pull request", () => {
  const bot = "github-actions";
  const opened = (key: string) => ({ author: { login: bot }, body: threadBody({}, key), url: `https://x/pr/1#${key}` });
  const thread = (id: string, isResolved: unknown, comments: unknown, path: unknown = "lib/a.ts") => ({
    id,
    isResolved,
    path,
    comments: { nodes: comments, pageInfo: { hasNextPage: false } },
  });

  test("a resolved finding thread with no reply is unreasoned; one with a reply is not", () => {
    const r = unreasonedResolutions(
      [
        thread("T1", true, [opened("k1")]),
        thread("T2", true, [opened("k2"), { author: { login: "jason" }, body: "Not reachable: parse() refuses it at line 40." }]),
      ],
      "unread",
    );
    expect(r.status).toBe("MEASURED");
    if (r.status !== "MEASURED") return;
    expect(r.unreasoned.map(u => u.id)).toEqual(["T1"]);
    expect(r.unreasoned[0]).toMatchObject({ path: "lib/a.ts", url: "https://x/pr/1#k1" });
  });

  test("a reply from the bot itself, or an empty reply, is not a reason", () => {
    const r = unreasonedResolutions(
      [
        thread("T1", true, [opened("k1"), { author: { login: bot }, body: "carried forward" }]),
        thread("T2", true, [opened("k2"), { author: { login: "jason" }, body: "   " }]),
      ],
      "unread",
    );
    expect(r.status === "MEASURED" && r.unreasoned.map(u => u.id)).toEqual(["T1", "T2"]);
  });

  test("an open thread, a person's thread, and an unreadable node are never reported", () => {
    const r = unreasonedResolutions(
      [
        thread("T1", false, [opened("k1")]),
        thread("T2", "true", [opened("k2")]),
        thread("T3", true, [{ author: { login: "jason" }, body: "a person's own comment" }]),
        null,
        thread("T5", true, "not a list"),
      ],
      "unread",
    );
    expect(r.status === "MEASURED" && r.unreasoned).toEqual([]);
  });

  test("review of #2378: a thread with more comments than one page is not reported, since its reply may be past the page", () => {
    const long = { ...thread("T1", true, [opened("k1")]), comments: { nodes: [opened("k1")], pageInfo: { hasNextPage: true } } };
    const short = { ...thread("T2", true, [opened("k2")]), comments: { nodes: [opened("k2")], pageInfo: { hasNextPage: false } } };
    const silent = { ...thread("T3", true, [opened("k3")]), comments: { nodes: [opened("k3")] } };
    const r = unreasonedResolutions([long, short, silent], "unread");
    expect(r.status === "MEASURED" && r.unreasoned.map(u => u.id)).toEqual(["T2"]);
  });

  test("threads that could not be read are UNMEASURED, not 'none resolved without a reason'", () => {
    expect(unreasonedResolutions(null, "the threads query failed")).toEqual({
      status: "UNMEASURED",
      reason: "the threads query failed",
    });
  });

  test("the report names each thread once, with its marker, and is not posted twice", () => {
    const list = [
      { id: "T1", path: "lib/a.ts", url: "https://x/1" },
      { id: "T2", path: null, url: null },
    ];
    const body = unreasonedReport(list, []);
    expect(body).not.toBeNull();
    expect(body!).toContain("resolved with no stated reason");
    expect(body!).toContain("reference/clearing-a-false-positive.md");
    expect(body!).toContain("`lib/a.ts`");
    expect(body!).toContain(`<!-- ${UNREASONED_MARKER} T1 -->`);
    expect(body!).toContain(`<!-- ${UNREASONED_MARKER} T2 -->`);
    // A later round reports only the thread no earlier report named.
    const again = unreasonedReport([...list, { id: "T3", path: "lib/b.ts", url: null }], [body!]);
    expect(again).not.toBeNull();
    expect(again!).toContain(`<!-- ${UNREASONED_MARKER} T3 -->`);
    expect(again!).not.toContain(`<!-- ${UNREASONED_MARKER} T1 -->`);
    expect(unreasonedReport(list, [body!]), "the same threads were reported twice").toBeNull();
  });
});

/**
 * #2838: one round put one defect on a consumer's pull request as three
 * threads at `board-flow.yml:75`, because three runs worded it three ways and
 * `findingIdentity` keeps paraphrases apart — on purpose, since two real
 * defects can share a line and a finding one run raised is never voted away
 * (CRC-B11). The union stays as it is. What changes is the posting: findings
 * that share a file and line go up as ONE thread carrying each of them.
 */
describe("#2838: findings that share a file and line post as one thread", () => {
  const FILE = ".github/workflows/board-flow.yml";
  const at = (file: string, line: number, summary: string) => ({
    severity: "high",
    file,
    line,
    summary,
    failure_scenario: `given ${summary.toLowerCase()}, the job fails`,
  });
  /** The consumer's round: one defect, three runs, three wordings. */
  const reworded = [
    at(FILE, 75, "The gate names the wrong secret"),
    at(FILE, 75, "This step reads a secret the gate never sets"),
    at(FILE, 75, "Wrong secret name: the token read here is not the one configured"),
  ];
  const keyOf = (f: Record<string, unknown>) => `${f.file}\u0000${f.line}\u0000${f.summary}`;

  /** The round end to end: one draft per run, merged, adjudicated, posted. */
  async function round(findings: Record<string, unknown>[]) {
    const merged = mergeDrafts(
      findings.map((f, i) => ({
        path: `draft-${i}.json`,
        text: JSON.stringify({ verdict: "BLOCK", findings: [f], review_summary: "1 finding(s)" }),
      })),
    );
    const reading = readAiReviewFindings(JSON.stringify(merged.payload));
    const sent: AiReviewThreadRequest[] = [];
    const result = await postReviewThreads(reading, async req => (sent.push(req), { ok: true }), keyOf);
    return { merged, reading, sent, result };
  }

  /** What posting must not move: the union, its count, and the blocking outcome. */
  function expectUnion(r: Awaited<ReturnType<typeof round>>, findings: Record<string, unknown>[]) {
    expect(r.merged.kept).toBe(findings.length);
    expect(r.merged.duplicates).toBe(0);
    expect(r.merged.payload!.findings).toEqual(findings);
    expect(r.reading.outcome).toBe("BLOCKED");
    expect(r.reading.reported).toHaveLength(findings.length);
  }

  test("three runs wording one defect at one line three ways post one thread holding all three", async () => {
    const r = await round(reworded);
    expectUnion(r, reworded);
    expect(r.sent.map(s => [s.path, s.line])).toEqual([[FILE, 75]]);
    for (const f of reworded) {
      expect(r.sent[0]!.body).toContain(f.summary);
      expect(r.sent[0]!.body).toContain(f.failure_scenario);
    }
    // the person resolving it is told that one resolution answers all three (#2874 review)
    expect(r.sent[0]!.body.endsWith(
      "_The findings above share this line. Resolving the thread answers all of them, so reply to each, or leave it open until each is fixed or answered._",
    )).toBe(true);
    expect(r.sent[0]!.body.split("\n")[0]).toBe(`**high** — ${reworded[0]!.summary}`);
    expect(r.result).toMatchObject({ outcome: "POSTED", attempted: 1, posted: 1, together: 3 });
    expect(r.result.detail).toContain(`${FILE}:75: 3 findings share this file and line, so they are posted as one thread`);
    expect(r.result.detail.at(-1)).toBe("posted 1 review comment, 3 findings posted together as 1 thread because they share a file and line");
  });

  test("CONTROL: the same three wordings on three different lines post three threads", async () => {
    const spread = reworded.map((f, i) => ({ ...f, line: 75 + i }));
    const r = await round(spread);
    expectUnion(r, spread);
    expect(r.sent.map(s => s.line)).toEqual([75, 76, 77]);
    expect(r.result).toMatchObject({ outcome: "POSTED", attempted: 3, posted: 3, together: 0 });
    expect(r.result.detail.at(-1)).toBe("posted 3 review comments");
  });

  test("CONTROL: two files at the same line number post two threads", async () => {
    const two = [reworded[0]!, { ...reworded[1]!, file: ".github/workflows/board-ready.yml" }];
    const r = await round(two);
    expectUnion(r, two);
    expect(r.sent.map(s => s.path)).toEqual([FILE, ".github/workflows/board-ready.yml"]);
    expect(r.result).toMatchObject({ outcome: "POSTED", attempted: 2, posted: 2, together: 0 });
  });

  test("every finding's key rides on the one thread, so resolving it answers all three", async () => {
    const r = await round(reworded);
    expect(threadReading([{ isResolved: true, body: r.sent[0]!.body }], "unread")).toEqual({
      status: "MEASURED",
      threads: reworded.map(f => ({ key: keyOf(f), isResolved: true })),
    });
  });

  test("CONTROL: a thread holding one finding still reads as its one key", async () => {
    const r = await round([reworded[0]!]);
    expect(threadReading([{ isResolved: false, body: r.sent[0]!.body }], "unread")).toEqual({
      status: "MEASURED",
      threads: [{ key: keyOf(reworded[0]!), isResolved: false }],
    });
  });

  test("two copies of one finding at one line post one thread that says it once", async () => {
    const sent: AiReviewThreadRequest[] = [];
    const r = await postReviewThreads(reading([finding, { ...finding }]), async req => (sent.push(req), { ok: true }));
    expect(sent.map(s => s.body)).toEqual([threadBody(finding)]);
    expect(r.together).toBe(2);
  });

  test("two findings in one file with no line stay two threads: a file is not a line", async () => {
    const { sent, post } = recorder(() => ({ ok: true }));
    const r = await postReviewThreads(reading([{ file: FILE, summary: "One" }, { file: FILE, summary: "Two" }]), post);
    expect(sent).toEqual([
      { path: FILE, line: null },
      { path: FILE, line: null },
    ]);
    expect(r.together).toBe(0);
  });

  test("off the diff, the shared thread goes on the conversation once, and is not posted again next round", async () => {
    const offDiff = async () => ({ ok: false, status: 422, message: "Validation Failed: pull_request_review_thread.path" }) as const;
    const bodies: string[] = [];
    const comment = {
      existing: [] as string[],
      post: async (body: string) => {
        bodies.push(body);
        return { ok: true as const };
      },
    };
    const r = await postReviewThreads(reading(reworded), offDiff, keyOf, undefined, comment);
    expect(r).toMatchObject({ outcome: "POSTED", pullComments: 1 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("so these 3 findings could not go on it");
    for (const f of reworded) expect(bodies[0]).toContain(f.summary);
    const later: string[] = [];
    const again = await postReviewThreads(reading(reworded), offDiff, keyOf, undefined, {
      existing: bodies,
      post: async body => (later.push(body), { ok: true }),
    });
    expect(later).toEqual([]);
    expect(again.detail.join("\n")).toContain("already on its conversation from an earlier round");
    // CONTROL: a fourth finding joining that line is new, so the thread goes up again
    const fourth = at(FILE, 75, "The secret is misnamed");
    const joined: string[] = [];
    await postReviewThreads(reading([...reworded, fourth]), offDiff, keyOf, undefined, {
      existing: bodies,
      post: async body => (joined.push(body), { ok: true }),
    });
    expect(joined).toHaveLength(1);
    expect(joined[0]).toContain("so this finding could not go on it");
    expect(joined[0]).toContain(fourth.summary);
    // only the new one: the three already there are not posted twice
    for (const f of reworded) expect(joined[0]).not.toContain(f.summary);
  });

  test("a shared thread that would pass GitHub's comment size limit is split at the same line, never cut", async () => {
    const long = reworded.map(f => ({ ...f, failure_scenario: `${f.failure_scenario} ${"x".repeat(25_000)}` }));
    const sent: AiReviewThreadRequest[] = [];
    const r = await postReviewThreads(reading(long), async req => (sent.push(req), { ok: true }));
    expect(sent.map(s => [s.path, s.line])).toEqual([
      [FILE, 75],
      [FILE, 75],
    ]);
    for (const s of sent) expect(s.body.length).toBeLessThanOrEqual(THREAD_BODY_BUDGET);
    for (const f of long) expect(sent.filter(s => s.body.includes(f.failure_scenario))).toHaveLength(1);
    expect(r).toMatchObject({ outcome: "POSTED", attempted: 2, posted: 2, together: 3 });
    expect(r.detail).toContain(
      `${FILE}:75: 3 findings share this file and line, so they are posted as 2 threads, each under GitHub's comment size limit`,
    );
  });
});
