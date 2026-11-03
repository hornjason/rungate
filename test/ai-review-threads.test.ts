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
  AI_REVIEW_THREADS_REFUSAL,
  aiReviewThreadsExitCode,
  postReviewThreads,
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
