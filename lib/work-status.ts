/**
 * The two decisions `scripts/work-status.ts` makes, as functions, so they can
 * be mutated and watched to fail.
 *
 * Both exist because of the same defect: a status reading that is wrong while
 * looking healthy. Jason, 2026-11-03 — *"we get hallucinated status readings
 * at all times"* — and the first draft of that script proved the point by
 * being wrong about 44 issues.
 */

import type { LaneReading } from "./board-lane-health";
import { heldReason, readyOccupancy } from "./board-ready-rule";

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
  // CLOSED FAILS CLOSED. This was `stateReason === "not_planned" ?
  // ABANDONED : DONE`, which handed DONE to every reason it did not know —
  // including `null`, what GitHub returns for an issue closed before the
  // field existed or by a client that does not set it. That is a tick for a
  // closure nobody confirmed as completion, which is the reading this whole
  // file exists to stop, arriving through its own default. Caught in review
  // of #1740.
  if (f.stateReason === "completed") return "DONE";
  if (f.stateReason === "not_planned" || f.stateReason === "duplicate") return "ABANDONED";
  // `reopened` on a closed issue is a contradiction; `null` is the absence
  // of a reason; anything else is a value added after this was written.
  // Introspected 2026-11-04: `IssueStateReason` is REOPENED, NOT_PLANNED,
  // COMPLETED, DUPLICATE, and REST adds `null` — so the set is closed today
  // and will not stay closed. UNMEASURED is the only honest default.
  return "UNMEASURED";
}

/**
 * The bucket for issues carrying no milestone — A LANE, NOT A GAP.
 *
 * Measured on this repository 2026-11-06: of 82 open issues, **26 carry no
 * milestone at all**. They are maintenance and backlog work, they are real,
 * and a report that groups by milestone and silently omits them loses the
 * single largest group it has. Jason, 2026-11-06: *"not all issues will have
 * milestones right, like there's stuff that's just maintenance stuff in the
 * backlog — how do we track that"*.
 *
 * So it is a named row with its own count, and `--milestone none` focuses on
 * it exactly as a title does. The parenthesis is deliberate: GitHub cannot
 * have a milestone of this name, so the row can never collide with a real
 * one.
 */
export const NO_MILESTONE = "(no milestone)";

/** One milestone's standing, in the numbers that decide what to do next. */
export type MilestoneRow = {
  readonly milestone: string;
  readonly open: number;
  /**
   * Closed `completed`. **NOT every closed issue** — `orderReading` three
   * docblocks up exists entirely to stop that conflation, and the first
   * version of this table reintroduced it one function later: it printed
   * `closed` under a header reading `done`, so a lane that abandoned four of
   * ten closures reported ten completed. Caught in review of #1825.
   */
  readonly done: number;
  /** Closed for any other reason, or none: `not_planned`, `duplicate`, null. */
  readonly dropped: number;
  /** Open AND assigned — somebody says they are on it. */
  readonly claimed: number;
  /** Open with at least one OPEN blocker. A closed blocker does not block. */
  readonly blocked: number;
  /** Open, unclaimed, unblocked — anybody may start it today. */
  readonly pickable: number;
};

/** An issue as this module needs it: the five fields, and nothing else. */
export type RollupIssue = {
  readonly number: number;
  readonly state: string;
  readonly milestone?: { readonly title?: string | null } | null;
  readonly assignees?: readonly unknown[] | null;
  readonly pull_request?: unknown;
  /** REST's `state_reason`. Absent and `null` both mean nobody said. */
  readonly state_reason?: string | null;
  /** From `GET /issues/{n}/dependencies/blocked_by` — never a search qualifier. */
  readonly blockers: readonly { readonly state: string }[];
};

/** The milestone an issue belongs to, with absence spelled as a lane. */
export function milestoneOf(issue: RollupIssue): string {
  const t = issue.milestone?.title;
  return typeof t === "string" && t.trim() !== "" ? t : NO_MILESTONE;
}

/**
 * Every milestone's standing, including the one that is not a milestone.
 *
 * Pull requests are dropped: `/issues` returns them too, and a PR counted as
 * an issue inflates every lane it touches. `isPickable` is reused rather
 * than re-derived — "what may anybody start" has one owner, and a second
 * spelling here would be two deciders over one question with nothing
 * comparing them.
 *
 * Sorted by open count descending, then by name, so the biggest pile of
 * unfinished work is the first thing read. `NO_MILESTONE` sorts with the
 * rest rather than being pinned anywhere: it is a lane.
 */
export function milestoneRollup(issues: readonly RollupIssue[]): MilestoneRow[] {
  type Counts = { open: number; done: number; dropped: number; claimed: number; blocked: number; pickable: number };
  const rows = new Map<string, Counts>();
  for (const i of issues) {
    if (i.pull_request) continue;
    const key = milestoneOf(i);
    const r = rows.get(key) ?? { open: 0, done: 0, dropped: 0, claimed: 0, blocked: 0, pickable: 0 };
    if (i.state === "open") {
      r.open += 1;
      if ((i.assignees?.length ?? 0) > 0) r.claimed += 1;
      if (i.blockers.some(b => b.state === "open")) r.blocked += 1;
      if (isPickable({ state: i.state, assignees: i.assignees ?? [], blockers: i.blockers })) {
        r.pickable += 1;
      }
    } else if (i.state_reason === "completed") {
      r.done += 1;
    } else {
      // CLOSED FAILS CLOSED, the same direction `orderReading` takes it: an
      // unknown reason and a `null` one are NOT completions. Over-reporting
      // `done` is the reading that makes a lane look finished.
      r.dropped += 1;
    }
    rows.set(key, r);
  }
  return [...rows]
    .map(([milestone, r]) => ({ milestone, ...r }))
    .sort((a, b) => b.open - a.open || a.milestone.localeCompare(b.milestone));
}

/** What `--milestone` resolved to, including the two ways it can fail. */
export type Focus =
  | { readonly kind: "all" }
  | { readonly kind: "one"; readonly title: string }
  | { readonly kind: "unknown"; readonly asked: string; readonly known: readonly string[] };

/**
 * Resolve `--milestone`, and REFUSE a name that matches nothing.
 *
 * This is the whole reason it is a function. A focus that quietly selects
 * zero issues prints a correct-looking report with an empty body, and a typo
 * is then indistinguishable from a milestone whose work is finished — the
 * *Silent Default Substitution* shape in `.claude/rules/config-access.md`,
 * in a tool whose entire purpose is that the status is not hallucinated.
 *
 * `unknown` carries the names that DO exist, because a refusal that does not
 * say what was available is a refusal nobody can act on.
 *
 * Absent means `all`. That is the change of 2026-11-06: the default used to
 * be one hardcoded title, `"Issue intake"`, which on that day was 1 open
 * issue of 82 — so 81 were invisible in the report the status was read from.
 */
export function resolveFocus(asked: string | undefined, known: readonly string[]): Focus {
  // **Absent is `all`. Present-and-empty is a REFUSAL.** The condition used
  // to read `asked === undefined || asked.trim() === ""`, and `--milestone`
  // typed as the last argument arrives here as the empty string — a mistake
  // that then printed the unpinned report and read as if the pin had been
  // honoured.
  //
  // Nothing more is needed: an empty name matches no milestone and neither
  // keyword, so it falls through to the refusal at the bottom like any other
  // name that does not exist. A branch of its own here WAS written, and a
  // mutant deleting it left the suite 45 pass / 0 fail — a second decider
  // over a question this function already answers
  // (`.claude/rules/checks-must-be-able-to-fail.md`).
  if (asked === undefined) return { kind: "all" };

  // **A REAL milestone wins over the keyword that spells it.** GitHub titles
  // are free text, so a milestone named `all` or `none` is legal, and
  // checking the keywords first made one permanently unreachable — the
  // keyword answered, the real lane was never consulted, and nothing said
  // so. Caught in review of #1825.
  if (known.includes(asked)) return { kind: "one", title: asked };

  // `none` and the rendered label both reach the unmilestoned lane, so a
  // reader can copy the name out of the table and pass it straight back.
  if (asked === "none" || asked === NO_MILESTONE) return { kind: "one", title: NO_MILESTONE };
  if (asked === "all") return { kind: "all" };
  return { kind: "unknown", asked, known: [...known].sort() };
}

/** What a Ready reading means for whether the script may exit 0 — #1842. */
export type ReadyVerdict =
  /** The lane is below its depth, or empty while its depth is positive. */
  | "REFUSE"
  /** The lane's state could not be established. NEVER the same as fine. */
  | "UNMEASURED";

export interface ReadyRefusal {
  readonly verdict: ReadyVerdict;
  readonly count: number;
  readonly against: number | null;
  readonly why: string;
}

/**
 * Whether the Ready lane's reading lets this run exit 0 — #1842.
 *
 * The ONE decider. The script restates its answer and spells no condition of
 * its own: a second condition there would be two deciders over one input, and
 * a mutation of either would leave the other holding every case up
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 *
 * ## UNWRITTEN refuses, and the first version of this missed it
 *
 * `laneHealth` returns `UNWRITTEN`, not `SHORT`, when `count === 0` and the
 * denominator is positive — so **the SHORT branch is unreachable at zero**
 * and a gate keyed on SHORT alone exits 0 on a completely empty Ready lane,
 * which is the single case it exists for. Worse, the first control written
 * for this asserted that pass as correct, which is the "case that goes green
 * under the wrong fix" shape: it would have certified the bypass.
 *
 * Caught by the automated security review of the pushed commit, not by the
 * battery — the battery varied the health value and never asked which value
 * the producer emits at the boundary.
 *
 * ## UNMEASURED is its own answer, not silence
 *
 * A census that could not be taken is not a lane that is fine, and returning
 * `null` for it would make those two states the same bytes — the exact
 * confusion this whole report exists to remove. It gets its own verdict and
 * its own exit code at the call site.
 *
 * `NO_TARGET` is different and is NOT a refusal: it means no denominator
 * exists, so there is nothing the lane could be short OF. `OK` and `OVER` are
 * the lane working and the lane over-full; neither leaves a session with
 * nothing to start.
 *
 * ## The switch is exhaustive on purpose
 *
 * `LaneHealth` is the producer's own type and the `never` arm makes adding a
 * member a COMPILE error here rather than a silent pass. A `!==` test, or a
 * `Set` of strings, would let a seventh health value default to "fine" — and
 * that is precisely how UNWRITTEN slipped through the first time.
 */
export function readyRefusal(
  readings: readonly LaneReading[],
  /**
   * Open issues in the Ready column — the SAME number the report prints as
   * startable.
   *
   * The lane's own count is every board item in the column, closed ones
   * included, so a Ready holding three closed cards read `3 of 3 OK` while
   * the startable list showed nothing. The gate passed with no work to
   * start, which is the state it exists to catch. The count and the list
   * must come from one number or the report can disagree with itself inside
   * one page.
   */
  openInReady: number,
): ReadyRefusal | null {
  const ready = readings.find(r => r.lane === "Ready");
  // A board with no Ready row cannot be judged, and must not read as fine.
  if (ready === undefined) {
    return {
      verdict: "UNMEASURED",
      count: 0,
      against: null,
      why: "the board reading contains no Ready lane at all",
    };
  }
  // **The subtraction is `readyOccupancy`'s, not this file's** (#1852). It
  // used to be spelled here as `ready.count - openInReady`, which made this
  // the SECOND place that decided how full Ready is — and the two then
  // disagreed in production: on 2026-11-07 the writer read `2 of 2, full`
  // over every card while this read `1 of 2, SHORT` over open issues, and
  // no single site a mutation could move said which was right.
  //
  // Named rather than silently subtracted, as before: the lane disagreeing
  // with itself is a board defect somebody has to clear, and a gate that
  // quietly corrects for it hides the thing to fix.
  const occ = readyOccupancy(ready.count, openInReady, ready.against);
  const why =
    occ.undispatchable > 0
      ? `${ready.why} — and ${occ.undispatchable} of the ${occ.cards} card(s) in this lane ` +
        `${occ.undispatchable === 1 ? "is" : "are"} not an open issue, so only ` +
        `${occ.dispatchable} can be started` +
        // The REMEDY, which is the half a count cannot carry: a lane holding
        // cards nobody can start is not short of promotions. `heldReason`
        // branches on the verdict, so there is no second branch here.
        `. ${heldReason(occ)}`
      : ready.why;
  const seen = { count: openInReady, against: ready.against, why };
  // Judged on the OPEN count, so a lane filled with closed cards cannot
  // clear the gate on a number nobody can act on.
  if (ready.against !== null && openInReady < ready.against && ready.health !== "UNMEASURED") {
    return { verdict: "REFUSE", ...seen };
  }
  switch (ready.health) {
    case "SHORT":
    case "UNWRITTEN":
      return { verdict: "REFUSE", ...seen };
    case "UNMEASURED":
      return { verdict: "UNMEASURED", ...seen };
    case "OK":
    case "OVER":
    case "NO_TARGET":
      return null;
    default: {
      const unhandled: never = ready.health;
      throw new Error(
        `readyRefusal: unclassified lane health ${JSON.stringify(unhandled)}. ` +
          "Every LaneHealth must be sorted into refuse, unmeasured or fine — " +
          "defaulting a new one to fine is how UNWRITTEN bypassed this gate.",
      );
    }
  }
}
