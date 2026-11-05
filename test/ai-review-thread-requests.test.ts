/**
 * Turning a findings reading into inline review comments.
 *
 * Measured 2026-10-25 on `hornjason/asaCommandCenter`: across every merged
 * pull request, ai-review has created **zero** review threads. It emits
 * GitHub Actions annotations, which vanish with the run log. A
 * `required_conversation_resolution` gate was switched on against that, so
 * the gate has no producer and is inert.
 *
 * This file covers only the PURE half — which findings become comments, and
 * what each comment says. No network, no token, no workflow.
 *
 * Two facts from the REST contract shape it, and both were read from
 * GitHub's documentation rather than assumed:
 *
 *  - `path` and `commit_id` are required; `line` is "required unless using
 *    subject_type:file". So a finding whose line cannot be read is a
 *    FILE-LEVEL comment, not a dropped one.
 *  - A `line` outside the diff is refused with 422. Being in the changed
 *    set makes a finding locatable to a FILE; it does not prove the line
 *    sits in a hunk. That is why the caller must be able to demote, and why
 *    `line` is nullable here instead of being asserted.
 */
import { describe, expect, test } from "bun:test";
import {
  reviewThreadRequests,
  type AiReviewFindingsReading,
} from "../lib/scaffold/ai-review-findings";

/** A reading carrying just the fields this function reads. */
function reading(
  reported: unknown[] | null,
  unlocatableReported: unknown[] | null = null,
): AiReviewFindingsReading {
  return { reported, unlocatableReported } as unknown as AiReviewFindingsReading;
}

/** The same reading, carrying a scope that WAS taken. */
function scoped(
  reported: unknown[] | null,
  files: string[],
  unlocatableReported: unknown[] | null = null,
): AiReviewFindingsReading {
  return {
    reported,
    unlocatableReported,
    // RAW, the way `readAiReviewChangedFiles` carries it — an array, not a
    // Set, and not normalised. The normalisation is `partitionChangedFiles`'
    // job and the production reading never does it here, so a fixture that
    // pre-normalised would exercise a conversion the real input never takes.
    scope: { status: "MEASURED", files, reason: null, detail: "" },
  } as unknown as AiReviewFindingsReading;
}

/** A scope that was attempted and could not be read. Never a narrower skip. */
function unscoped(
  reported: unknown[] | null,
  unlocatableReported: unknown[] | null = null,
): AiReviewFindingsReading {
  return {
    reported,
    unlocatableReported,
    scope: { status: "UNMEASURED", files: null, reason: "CHANGED_FILES_UNREADABLE" },
  } as unknown as AiReviewFindingsReading;
}

const located = { file: "src/a.ts", line: 12, summary: "off-by-one", failure_scenario: "n=0 underflows" };
const noLine = { file: "src/b.ts", summary: "no line given" };
const floating = { file: "src/c.ts", line: 3, summary: "not in the diff" };

describe("reviewThreadRequests", () => {
  test("a locatable finding becomes one comment carrying path, line and reason", () => {
    const out = reviewThreadRequests(reading([located]));
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe("src/a.ts");
    expect(out[0]!.line).toBe(12);
    expect(out[0]!.body).toContain("off-by-one");
    // The failure scenario is the half a reader acts on; a summary alone is
    // a label. If it is in the payload it has to reach the thread.
    expect(out[0]!.body).toContain("n=0 underflows");
  });

  test("an unlocatable finding is excluded", () => {
    const out = reviewThreadRequests(reading([located, floating], [floating]));
    expect(out.map((r) => r.path)).toEqual(["src/a.ts"]);
  });

  test("CONTROL: that exclusion is the filter working, not an empty input", () => {
    // The same finding, with nothing marked unlocatable, MUST come through.
    // Without this the previous case passes just as well over a function
    // that returns a constant, or over a payload the reader never parsed.
    const out = reviewThreadRequests(reading([located, floating], []));
    expect(out.map((r) => r.path)).toEqual(["src/a.ts", "src/c.ts"]);
  });

  /* ──────────── the skip the unlocatable list cannot reach ────────────
   *
   * `unlocatableReported` is populated by `readPayload`'s DEMOTION branch,
   * and that branch only runs for a finding that BLOCKS. So a non-blocking
   * finding naming a file the pull request does not touch is never demoted,
   * never listed, and was posted — where GitHub answers
   *
   *   422 pull_request_review_thread.path "could not be resolved"
   *
   * at the line AND again at file level, because the demotion this module
   * documents answers "the line moved" and has no answer for "the file
   * left". That lands in `failed`, which is the one refusing outcome, so a
   * required check goes red over a finding that is merely out of scope.
   * Observed on #1740 head `1d95e1da457cf5fc91298bd017a94087b8244d46`, run
   * `41950364518`: two carried findings on `lib/github.ts`, a path absent
   * from that pull request's eight changed files, `0 of 2 posted`, exit 1,
   * and the branch unmergeable by anyone including an admin.
   *
   * `findingPathScope` is the decider, reused rather than restated — it is
   * already the one `readPayload` demotes on, so the skip cannot disagree
   * with the demotion about a single finding.
   */

  test("a finding whose file left the diff is not requested, even when it does not block", () => {
    // `unlocatableReported` is null — the adjudicator never classified this
    // one, because it does not block. The scope reading is the only thing
    // that can answer, and it is the input the subtraction cannot see.
    const out = reviewThreadRequests(scoped([located, floating], ["src/a.ts"], null));
    expect(out.map((r) => r.path)).toEqual(["src/a.ts"]);
  });

  test("CONTROL: the same finding IS requested when its path is in the diff", () => {
    // Without this the case above passes over a function that dropped
    // `floating` for any reason at all, including not reading it.
    const out = reviewThreadRequests(scoped([located, floating], ["src/a.ts", "src/c.ts"], null));
    expect(out.map((r) => r.path)).toEqual(["src/a.ts", "src/c.ts"]);
  });

  test("CONTROL: an UNMEASURED scope changes nothing — every finding is still requested", () => {
    // The direction this is allowed to be wrong in. A scope that could not
    // be read is not a pull request that touched nothing, so it must not
    // become a blanket excuse for posting less: a reading nobody took
    // cannot retire a finding.
    const out = reviewThreadRequests(unscoped([located, floating], null));
    expect(out.map((r) => r.path)).toEqual(["src/a.ts", "src/c.ts"]);
  });

  test("the two skips are not one decider — each has an input the other cannot answer", () => {
    // They would be the fourth shape in checks-must-be-able-to-fail.md if
    // either were reachable only through the other. Each row below is
    // killed by exactly one of them, which is what makes both live.
    //
    //   scope MEASURED + unlocatable null  → only the scope check skips
    //   scope absent   + unlocatable set   → only the subtraction skips
    expect(reviewThreadRequests(scoped([floating], ["src/a.ts"], null))).toEqual([]);
    expect(reviewThreadRequests(reading([floating], [floating]))).toEqual([]);
  });

  test("a finding with no readable line is a file-level comment, not a dropped one", () => {
    const out = reviewThreadRequests(reading([noLine]));
    expect(out).toHaveLength(1);
    expect(out[0]!.line).toBeNull();
  });

  test("no findings produces no comments", () => {
    expect(reviewThreadRequests(reading([]))).toEqual([]);
    expect(reviewThreadRequests(reading(null))).toEqual([]);
  });

  test("the emitted path keeps the case the finding wrote", () => {
    // `normaliseRepoPath` lowercases, by design, because it exists to COMPARE
    // two spellings of one path. The REST API does not compare — it matches
    // the diff byte-for-byte and answers 422. So it is the predicate here and
    // never the value, and this is the case that tells those two apart.
    const out = reviewThreadRequests(reading([{ file: "src/Thing.ts", line: 4, summary: "x" }]));
    expect(out[0]!.path).toBe("src/Thing.ts");
  });

  test("a trailing :line in the path does not reach the API as part of the path", () => {
    const out = reviewThreadRequests(reading([{ file: "src/a.ts:88", summary: "x" }]));
    expect(out[0]!.path).toBe("src/a.ts");
    expect(out[0]!.line).toBe(88);
  });

  test("a finding naming no file is not guessed at", () => {
    const out = reviewThreadRequests(reading([{ summary: "something, somewhere" }]));
    expect(out).toEqual([]);
  });
});
