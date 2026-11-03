/**
 * lib/ai-review-threads.ts — posting a review's findings onto the diff.
 *
 * #1612. Measured 2026-10-25 across every merged pull request on the
 * consumer that runs the generated `ai-review` job: zero review threads,
 * ever. The job's only output has been a GitHub Actions annotation, which
 * lives as long as the run log. A repository that switches
 * `required_conversation_resolution` on against that gets a gate whose
 * population is always empty — satisfied by construction.
 *
 * This module owns the half `reviewThreadRequests` does not: what happened
 * when the comments were sent. That matters because **zero comments posted
 * is the same observation in four different situations** — the review found
 * nothing, the review could not run, the token could not write, or this code
 * is broken. One channel, four mechanisms, which is the sixth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`. Collapsing them into a
 * boolean is how a producer stays dead without anybody noticing, which is
 * precisely the history being fixed here.
 *
 * So the outcome is NAMED, and exactly one of the names is a refusal.
 *
 * The HTTP call is injected rather than performed. Every decision below is
 * therefore reachable from a test over a recorded response, including the
 * two that only a live fork or a line outside a hunk would otherwise produce.
 */
import type { ThreadReading } from "./ai-review-rounds";
import { reviewThreadRequests, threadKeyFrom } from "./scaffold/ai-review-findings";
import type { AiReviewFindingsReading, AiReviewThreadRequest } from "./scaffold/ai-review-findings";

/**
 * One review thread as the GraphQL query returns it, before anything is
 * trusted about it. Both fields are `unknown`: a partial response drops
 * fields rather than failing, so the shape is asserted here and nowhere else.
 */
export interface RawReviewThread {
  isResolved: unknown;
  /** The body of the thread's FIRST comment — the one the poster wrote. */
  body: unknown;
}

/**
 * Turn what GitHub returned into the reading `carryForwardFromThreads` takes.
 *
 * @param raw the threads, or `null`/`undefined` when the list could not be
 * read at all — a network failure, a missing token, a GraphQL error.
 * @param reason what to call the unreadable case. Only used when `raw` is
 * absent, and it is a parameter because the caller is the only thing that
 * knows which way the fetch failed.
 *
 * ## An unmarked thread is DROPPED, not keyed to the empty string
 *
 * Only a thread carrying the #1618 marker names a finding. Every thread
 * posted before #1618 and every thread a person opened carries none, and
 * they are real threads that are not evidence about any finding. Collapsing
 * them to `""` would make one resolved human comment answer every unkeyable
 * finding on the pull request at once.
 *
 * ## Only the literal `true` is resolution
 *
 * A partial response drops fields rather than failing, and a finding answered
 * by an omission is the silent direction of error. Anything that is not
 * exactly `true` reads as open.
 */
export function threadReading(
  raw: readonly RawReviewThread[] | null | undefined,
  reason: string,
): ThreadReading {
  if (raw === null || raw === undefined) return { status: "UNMEASURED", reason };
  const threads: { key: string; isResolved: boolean }[] = [];
  for (const t of raw) {
    // A NULL NODE IS A THREAD, NOT A CRASH. A GraphQL connection returns a
    // null node for an entry the token cannot see — a thread on a deleted
    // file, or one hidden by a permission — and `t.body` on it throws a
    // TypeError straight past this function's callers. That is the one
    // failure mode this module is built to not have: an undecidable thread
    // is dropped, which carries its finding, and the whole point is that the
    // reading degrades rather than exploding. Dropping is also right on the
    // merits — a node nobody can read names no finding and answers none.
    if (t === null || typeof t !== "object") continue;
    const key = threadKeyFrom(t.body);
    if (key === null) continue;
    threads.push({ key, isResolved: t.isResolved === true });
  }
  return { status: "MEASURED", threads };
}

/**
 * The three ways the file on the runner can fail to be a thread list.
 *
 * One sentence per FACT, and no two facts share one. "Nobody fetched it",
 * "the fetch was cut off mid-write" and "the fetch returned an error object
 * instead of threads" are three different things to go and look at, and a
 * reader that prints the same sentence for all three has told the next person
 * only that something went wrong. Exported so a case can assert on the
 * sentence rather than on a substring of it — a `toContain` goes green on a
 * message that was narrowed to say less.
 */
export const THREADS_NOT_READ =
  "the pull request's review threads were not read, so whether a finding was already raised is unknown";
export const THREADS_UNPARSEABLE =
  "the review-thread list was written but does not parse, so it was cut off or is not the list it claims to be";
export const THREADS_NOT_A_LIST =
  "the review-thread list parsed and is not a list, which is the shape a GraphQL error response has";

/**
 * The same reading, taken from the bytes a bash step left on the runner.
 *
 * `threadReading` takes parsed nodes because that is the shape a test can
 * drive; this is the production path, and it exists so that the JSON parse —
 * the one step between GitHub's answer and the decision — is somewhere a
 * negative control can reach. Every failure produces a NAMED sentence and an
 * UNMEASURED reading, never an empty list: an empty list is the assertion
 * "this pull request has no threads", which suppresses nothing while claiming
 * to have looked, and is exactly how a repeat-suppressor goes quietly dead.
 *
 * An empty STRING is absence, not a parse failure. A step that wrote no bytes
 * and a step that wrote nothing are the same event seen twice.
 */
export function threadReadingFromJson(text: string | null | undefined): ThreadReading {
  if (text === null || text === undefined || text === "") {
    return { status: "UNMEASURED", reason: THREADS_NOT_READ };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "UNMEASURED", reason: THREADS_UNPARSEABLE };
  }
  if (!Array.isArray(parsed)) return { status: "UNMEASURED", reason: THREADS_NOT_A_LIST };
  // The per-node decisions stay in ONE place. A second loop here would be a
  // second decider over "is this thread usable", and a mutation of either
  // would leave the other holding every case up.
  return threadReading(parsed as readonly RawReviewThread[], THREADS_NOT_READ);
}

/**
 * The single non-zero exit. Declared once, so a mutant can set it to `0` and
 * a case can observe the refusal disappearing — `.claude/rules/checks-must-be-able-to-fail.md`,
 * *For a script whose job is to exit non-zero*. A `process.exit(1)` or a
 * second literal anywhere in this module would bypass that mutation and the
 * case would go green over a refusal it never witnessed.
 */
export const AI_REVIEW_THREADS_REFUSAL = 1;

/**
 * What a posting round was, in the words that distinguish the four ways it
 * can produce no comments.
 *
 * | Outcome | Comments | Refusal | What it means |
 * |---|---|---|---|
 * | `POSTED` | ≥ 1 | no | the producer works |
 * | `NOTHING_TO_POST` | 0 | no | the review located nothing to anchor |
 * | `UNMEASURED` | 0 | no | there was no reading to post FROM |
 * | `DEGRADED_NO_WRITE` | 0 | no | the token cannot write; see below |
 * | `BLOCKED_BY_PENDING_REVIEW` | 0 | no | the pull request is locked; see below |
 * | `FAILED` | any | **yes** | the producer is broken |
 *
 * `UNMEASURED` is not a quieter `NOTHING_TO_POST`. A review that did not run
 * has not found zero findings, and a tree that cannot tell those apart is the
 * *Silent Default Substitution* anti-pattern in `.claude/rules/config-access.md`.
 */
export type AiReviewThreadOutcome =
  | "POSTED"
  | "NOTHING_TO_POST"
  | "UNMEASURED"
  | "DEGRADED_NO_WRITE"
  | "BLOCKED_BY_PENDING_REVIEW"
  | "FAILED";

/** What the API said. `status` is `null` for a failure that never got one. */
export type AiReviewThreadResponse =
  | { ok: true }
  | { ok: false; status: number | null; message: string };

/** Sends one comment. The only thing in this module that touches a network. */
export type AiReviewThreadPoster = (
  request: AiReviewThreadRequest,
) => Promise<AiReviewThreadResponse>;

export interface AiReviewThreadsResult {
  outcome: AiReviewThreadOutcome;
  /** Comments this round meant to create. */
  attempted: number;
  /** Comments the API accepted. */
  posted: number;
  /** Of those, how many only succeeded after dropping to file level. */
  demoted: number;
  /** One sentence per thing worth reading, in the order it happened. */
  detail: string[];
}

/** HTTP 422 — the documented answer to a `line` outside a diff hunk. */
const UNPROCESSABLE = 422;
/** HTTP 403 — the documented answer to a token without `pull-requests: write`. */
const FORBIDDEN = 403;

/**
 * The OTHER 422, and the reason the status code alone cannot be the branch.
 *
 * GitHub allows one pending review per identity per pull request. When a
 * previous round left one open, every `createReviewComment` on that pull
 * request answers 422 with this condition — and the identity is the job's own
 * `github-actions[bot]`, so there is no UI anybody can clear it from.
 *
 * Matched on the condition rather than on the serialised body: the message is
 * a JSON document the API is free to reformat, and a detector that a
 * whitespace change defeats is the second shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 */
const PENDING_REVIEW_CONDITION = /pending review/i;

/**
 * One binding, so a mutation of it is observable. Both halves are required:
 * the status narrows it to a validation refusal, the condition says WHICH —
 * and the wrong direction here is the expensive one, because a false positive
 * turns a genuinely broken producer into a green check.
 */
function isPendingReviewRefusal(answer: AiReviewThreadResponse): boolean {
  return (
    !answer.ok && answer.status === UNPROCESSABLE && PENDING_REVIEW_CONDITION.test(answer.message)
  );
}

/**
 * Post every comment a reading calls for, and say which of the four
 * no-comment states this was if none appeared.
 *
 * Three behaviours are worth stating because each has a cheaper wrong answer:
 *
 * **An UNMEASURED reading posts nothing and attempts nothing.** Not because
 * posting would fail, but because there is no reading to post from, and a
 * round that posted a guess would put the reviewer's absence on the diff as
 * though it were a finding.
 *
 * **A 422 demotes before it fails.** `line` is documented as "Required
 * unless using subject_type:file", and a line outside a hunk is refused with
 * 422. Being in the changed-file set locates a finding to a FILE and never
 * to a hunk, so this response is EXPECTED on a correct request and the
 * retry is part of the contract rather than error recovery. Only a 422 that
 * survives the demotion is a defect.
 *
 * **A 403 degrades and does not refuse — but only when it is the whole
 * story.** For a `pull_request` from a forked repository GitHub downgrades
 * write permissions to read regardless of what the workflow declares, unless
 * an admin enabled *Send write tokens to workflows from pull requests*. So on
 * a fork this producer cannot run, the adjudicator's annotation is still
 * produced, and failing here would red every fork pull request for something
 * the contributor cannot fix. What that must NOT do is become a blanket
 * excuse: a round that saw a 403 AND some other failure is `FAILED`, because
 * a broken producer hiding behind a fork is the fail-open this whole module
 * exists to prevent.
 */
export async function postReviewThreads(
  reading: AiReviewFindingsReading,
  post: AiReviewThreadPoster,
  keyFor?: (finding: Record<string, unknown>) => string | null,
): Promise<AiReviewThreadsResult> {
  const detail: string[] = [];

  if (reading.outcome === "UNMEASURED") {
    detail.push(
      "the review produced no usable reading, so there was nothing to post — this is not a review that found nothing",
    );
    return { outcome: "UNMEASURED", attempted: 0, posted: 0, demoted: 0, detail };
  }

  const requests = reviewThreadRequests(reading, keyFor);
  if (requests.length === 0) {
    detail.push("the reading located no finding that could be anchored to a path in this diff");
    return { outcome: "NOTHING_TO_POST", attempted: 0, posted: 0, demoted: 0, detail };
  }

  let posted = 0;
  let demoted = 0;
  let forbidden = 0;
  let pending = 0;
  let failed = 0;

  for (const request of requests) {
    const where = request.line === null ? request.path : `${request.path}:${request.line}`;
    let answer = await post(request);

    // Before the demotion, because the demotion cannot clear this one and a
    // second request would buy a second identical 422. The lock is on the
    // review, not on the anchor.
    if (isPendingReviewRefusal(answer)) {
      pending += 1;
      detail.push(
        `${where}: 422 — this pull request already holds a pending review by this identity, so no ` +
          `comment can be added to it. That is a state of the pull request, not a finding this ` +
          `producer got wrong; dropping to file level answers the same way.`,
      );
      continue;
    }

    // The demotion, and only from a line. A file-level request that is
    // refused has nothing left to drop.
    if (!answer.ok && answer.status === UNPROCESSABLE && request.line !== null) {
      detail.push(`${where}: line refused (422), retrying as a file-level comment`);
      answer = await post({ ...request, line: null });
      if (answer.ok) demoted += 1;
    }

    if (answer.ok) {
      posted += 1;
      continue;
    }
    if (answer.status === FORBIDDEN) {
      forbidden += 1;
      detail.push(
        `${where}: 403 — this token cannot write pull-request comments. A pull_request run from a ` +
          `fork is handed a read-only token whatever the workflow declares.`,
      );
      continue;
    }
    failed += 1;
    detail.push(`${where}: ${answer.status ?? "no status"} — ${answer.message}`);
  }

  // Order matters. A real failure outranks the fork excuse and the pending
  // -review lock, and all three outrank a partial success — a round that
  // posted three of four comments has lost a finding and must say so.
  if (failed > 0) {
    return { outcome: "FAILED", attempted: requests.length, posted, demoted, detail };
  }
  if (forbidden > 0) {
    return { outcome: "DEGRADED_NO_WRITE", attempted: requests.length, posted, demoted, detail };
  }
  if (pending > 0) {
    return {
      outcome: "BLOCKED_BY_PENDING_REVIEW",
      attempted: requests.length,
      posted,
      demoted,
      detail,
    };
  }
  detail.push(
    `posted ${posted} review ${posted === 1 ? "comment" : "comments"}` +
      (demoted === 0 ? "" : `, ${demoted} at file level after a line was refused`),
  );
  return { outcome: "POSTED", attempted: requests.length, posted, demoted, detail };
}

/**
 * How an annotation may open, given what actually reached the diff.
 *
 * Both non-refusing degradations — the fork token and the pending-review
 * lock — are selected on a COUNT of refusals and never on `posted === 0`, so
 * either can be reached with comments already posted. Both used to open by
 * saying none were, one line below an accurate `posted N` summary. The claim
 * is about the round, so it is derived from the round rather than written
 * into each branch.
 */
export function threadsLandedPhrase(result: AiReviewThreadsResult): string {
  return result.posted === 0
    ? "No review threads were created"
    : `Only ${result.posted} of ${result.attempted} review threads were created`;
}

/** The exit code a round's outcome earns. Only `FAILED` refuses. */
export function aiReviewThreadsExitCode(result: AiReviewThreadsResult): number {
  return result.outcome === "FAILED" ? AI_REVIEW_THREADS_REFUSAL : 0;
}
