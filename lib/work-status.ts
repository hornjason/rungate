/**
 * The two decisions `scripts/work-status.ts` makes, as functions, so they can
 * be mutated and watched to fail.
 *
 * Both exist because of the same defect: a status reading that is wrong while
 * looking healthy. Jason, 2026-11-03 — *"we get hallucinated status readings
 * at all times"* — and the first draft of that script proved the point by
 * being wrong about 44 issues.
 */

/**
 * Is this issue something anybody may pick up right now?
 *
 * **Takes the blockers, never a search qualifier.** One query string,
 * `is:open -is:blocked no:assignee`, measured against this repository on
 * 2026-11-03 across three transports:
 *
 * | transport | returned |
 * |---|---|
 * | `gh issue list --search` | 33 — correct |
 * | GraphQL `search` | 77 — `-is:blocked` dropped |
 * | REST `/search/issues` | 77 — `-is:blocked` dropped |
 *
 * Neither wrong path errors; both return a larger set that reads as fine. The
 * ground truth is `GET /issues/{n}/dependencies/blocked_by` per issue, and
 * that is what the caller must hand to this function.
 *
 * A CLOSED blocker does not block. That is the distinction the qualifier gets
 * right and a naive `blockers.length > 0` gets wrong — an issue whose one
 * dependency has already landed is pickable, and treating it otherwise parks
 * finished chains forever.
 */
export function isPickable(issue: {
  readonly state: string;
  readonly assignees: readonly unknown[];
  readonly blockers: readonly { readonly state: string }[];
}): boolean {
  if (issue.state !== "open") return false;
  if (issue.assignees.length > 0) return false;
  return !issue.blockers.some(b => b.state === "open");
}

/** What a row of the agreed order can honestly say about itself. */
export type OrderReading = "DONE" | "OPEN" | "ABANDONED" | "UNMEASURED" | "RECORDED";

/**
 * What the tracker object actually is. `closed` is deliberately NOT a
 * boolean: **closed and done are different facts**, and collapsing them is
 * the defect a reviewer caught in the first version of this file.
 *
 * - a pull request is done when it **merged**; one closed unmerged is not
 * - an issue closed `not_planned` is closed and was never completed
 */
export type TrackerFacts =
  | { readonly kind: "pr"; readonly state: "open" | "closed"; readonly merged: boolean }
  | {
      readonly kind: "issue";
      readonly state: "open" | "closed";
      readonly stateReason: string | null;
    };

/**
 * An order item with no issue and no pull request is **UNMEASURED**, never
 * done and never open.
 *
 * This is the whole reason the report exists. Items 2 and 7 of the agreed
 * order have no tracker object, so nothing can observe their state — and the
 * failure mode this guards is reporting such an item as DONE because a
 * session remembered it that way. That happened on 2026-11-03: items 1 and 2
 * were reported ticked to Jason while `PROJECT-STATE.md` said all three of
 * 1, 2 and 3 were untouched, and item 1 was an open pull request.
 *
 * **ABANDONED is a fourth reading, not a flavour of DONE.** A pull request
 * closed without merging and an issue closed `not_planned` both end with
 * `state: "closed"` while the work they stood for did not happen. Reporting
 * either as DONE is the same class of wrong-but-healthy reading as the
 * search qualifier above, arriving by a different route.
 *
 * `.claude/rules/config-access.md`: a reading that could not be taken is not
 * one that passed.
 */
export function orderReading(item: {
  readonly tracker: string | null;
  readonly facts?: TrackerFacts;
  /**
   * **Where a human wrote that this is finished** — not whether they did.
   *
   * A `boolean` here would be the 2026-11-03 defect above with an extra
   * field: a session's memory reaching the report through a flag nobody can
   * check. A non-empty string has to say WHERE, so a reader can go and
   * disagree with it. Empty, blank and `null` are all the absence of a
   * citation and read UNMEASURED.
   *
   * Only consulted when there is no tracker object at all. An item with an
   * issue or a pull request is answered by the tracker, and a stale note
   * does not get to contradict a PR that is sitting open.
   */
  readonly recordedDone?: string | null;
}): OrderReading {
  if (item.tracker === null) return item.recordedDone?.trim() ? "RECORDED" : "UNMEASURED";
  if (item.facts === undefined) return "UNMEASURED";
  const f = item.facts;
  if (f.state === "open") return "OPEN";
  if (f.kind === "pr") return f.merged ? "DONE" : "ABANDONED";
  return f.stateReason === "not_planned" ? "ABANDONED" : "DONE";
}
