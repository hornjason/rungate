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
import type { NetGrowthBasis } from "./issue-filing-gate";
import { readyOccupancy, undispatchableRemedy } from "./board-ready-rule";
import { ladderViolations, nextStage, retrosOwed, type ItemScope, type Stage } from "./stage-ladder";

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
   * Closed `completed`. **NOT every closed issue** — closed and done are
   * different facts (an issue closed `not_planned` was never done), and the first
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
      // CLOSED FAILS CLOSED: an
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
  /**
   * Cards in Ready this board reading could NOT see as issues — a draft, a
   * pull request. **Required, and there is no default** (ai-review round 1 of
   * #1857).
   *
   * `readyOccupancy`'s `cards` means every physical card in the lane, and the
   * only number this file had was issues-only: `boardStatus()` keeps items
   * whose content is an Issue and buckets the rest into `unseenByLane`, which
   * never reached here. So the gate read the live 2026-11-07 lane — one open
   * issue and one draft at a depth of 2 — as `1 of 2, one free slot, ROOM`,
   * while `scripts/board-ready.ts`, counting every card, read it as full.
   * **The exact disagreement #1852 exists to end survived inside the fix.**
   *
   * A default of `0` would have let a caller stay silent and be wrong, which
   * is how it was wrong in the first place. A caller that genuinely cannot
   * take the count must say so by other means; it may not say zero.
   */
  unseenInReady: number,
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
  // **`ready.count` is issues only; the lane is not.** The sum is the whole
  // of the lane, and it is taken here rather than in the caller so the one
  // thing `readyOccupancy` is handed is the population its contract names.
  const occ = readyOccupancy(ready.count + unseenInReady, openInReady, ready.against);
  const why =
    occ.undispatchable > 0
      ? `${ready.why} — and ${occ.undispatchable} of the ${occ.cards} card(s) in this lane ` +
        `${occ.undispatchable === 1 ? "is" : "are"} not an open issue, so only ` +
        `${occ.dispatchable} can be started` +
        // The REMEDY, which is the half a count cannot carry. NOT
        // `heldReason` — that one answers the promoters' question, and its
        // ROOM arm says "Ready is at its depth", which is false of a lane
        // this gate is refusing for being SHORT. One reading, two renderings.
        `. ${undispatchableRemedy(occ)}`
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

/**
 * One open item of the plan, as the report prints it.
 *
 * `reading` is the field that earns this type. An item with a command and an
 * item with `verify: null` are both "not done", and printing them as one list
 * says nine things are startable when three are: six of the nine open on
 * 2026-11-11 had no command at all, so no run of `/stage-audit` could ever
 * tick them. `.claude/rules/checks-must-be-able-to-fail.md` calls this the
 * sixth shape — two states behind one observable — and the fix is to give
 * them two spellings rather than a count.
 */
export interface LadderRow {
  /** `B4` — the stage letter and the 1-based position. */
  readonly id: string;
  readonly stage: string;
  readonly what: string;
  /** `OPEN` carries a command that can tick it. `UNVERIFIABLE` does not. */
  readonly reading: "OPEN" | "UNVERIFIABLE";
  /** Where the command can run. Absent in the document means `repo`. */
  readonly scope: ItemScope;
}

export type LadderReport =
  | { readonly kind: "UNMEASURED"; readonly why: string }
  | {
      readonly kind: "READ";
      /** The stage id `nextStage` names, or `null` when every stage is complete. */
      readonly next: string | null;
      /** `nextStage`'s precondition, verbatim. `null` when nothing blocks it. */
      readonly blocked: string | null;
      /** Every open item of every stage, in ladder order. */
      readonly open: readonly LadderRow[];
      /** Stage ids complete with no retro — rule 10's gate. */
      readonly retrosOwed: readonly string[];
    };

/**
 * The plan, read rather than transcribed — #1984.
 *
 * `scripts/work-status.ts` took **zero** reads of `project-state.json` before
 * this. Its "THE AGREED ORDER" section printed a hand-typed array whose own
 * docblock called itself a known defect, and the stage ladder AGENTS.md rule
 * 10 names as the only place the plan lives appeared in no report at all. On
 * 2026-11-11 that hid nine open items — B4, D4, E1 through E5, F1, F2 — from
 * every session that read the report to decide what to work on.
 *
 * **Takes the source text, not a path.** The three ways this reading fails —
 * the file is absent, the file is not JSON, the document is not a well-formed
 * ladder — are different facts, and a function handed a parsed object cannot
 * tell the first two apart. Each gets its own `why`, because *Silent Default
 * Substitution* (`.claude/rules/config-access.md`) in this position prints an
 * empty plan, which is byte-identical to a plan with nothing left to do.
 *
 * **Well-formedness is `ladderViolations`, which is already the one decider
 * for it.** A second validator here would be two deciders over one fact: a
 * mutation of either leaves the other holding every case up, and neither
 * reads as dead.
 */
export function ladderReport(source: string | null, where: string): LadderReport {
  if (source === null) {
    return { kind: "UNMEASURED", why: `${where} could not be read, so the plan was not consulted` };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(source);
  } catch (e) {
    return {
      kind: "UNMEASURED",
      why: `${where} is not valid JSON (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  const violations = ladderViolations(doc);
  if (violations.length > 0) {
    return {
      kind: "UNMEASURED",
      why: `${where} is not a well-formed plan: ${violations.join("; ")}`,
    };
  }
  // `ladderViolations` returning empty is what establishes the shape. The
  // cast is the assertion it already made, not a second opinion about it.
  const stages = (doc as { stages: Stage[] }).stages;

  const open: LadderRow[] = [];
  for (const stage of stages) {
    for (const item of stage.items) {
      if (item.done) continue;
      open.push({
        id: item.id,
        stage: stage.id,
        what: item.what,
        reading: typeof item.verify === "string" && item.verify.trim() !== "" ? "OPEN" : "UNVERIFIABLE",
        scope: item.scope ?? "repo",
      });
    }
  }

  const next = nextStage(stages);
  return {
    kind: "READ",
    next: next === null ? null : (next.stage?.id ?? null),
    blocked: next === null ? null : next.blocked,
    open,
    retrosOwed: retrosOwed(stages),
  };
}

/**
 * The plan section of the report, as lines — #1984.
 *
 * A printer, not a decider: every fact here is `ladderReport`'s, and the only
 * choice made is how two different facts look different. OPEN and
 * UNVERIFIABLE get their own words on every row, because a reader scanning the
 * list for something to start must not pick an item no command can tick.
 * UNMEASURED prints its reason and no list at all — an empty list under a
 * heading is byte-identical to a plan with nothing left to do.
 */
export function ladderLines(r: LadderReport): string[] {
  // The plan is repository content any pull request can change, so its text
  // reaches a terminal only with control characters removed: an escape code in
  // an item could otherwise redraw the rows above it (security review, #2014).
  const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  if (r.kind === "UNMEASURED") return [`  UNMEASURED — ${clean(r.why)}`];
  const out: string[] = [];
  out.push(`  Next stage: ${r.next ?? "none — every stage is complete"}`);
  if (r.blocked !== null) out.push(`  Blocked: ${clean(r.blocked)}`);
  const runnable = r.open.filter(o => o.reading === "OPEN").length;
  out.push(
    `  Open items (${r.open.length}): ${runnable} can be ticked by a command, ` +
      `${r.open.length - runnable} are UNVERIFIABLE (verify: null)`,
  );
  for (const o of r.open) {
    const text = clean(o.what);
    const what = text.length > 90 ? `${text.slice(0, 89)}…` : text;
    const scope = o.scope === "repo" ? "" : ` (${o.scope})`;
    out.push(`    ${o.reading.padEnd(12)} ${o.id.padEnd(4)} ${what}${scope}`);
  }
  out.push(`  Retros owed: ${r.retrosOwed.length > 0 ? r.retrosOwed.join(", ") : "none"}`);
  return out;
}

/**
 * The FILING CAP line (#2087, SC-2764): the trailing day's opened and closed
 * issue counts and the cap they set, under ADR-016.
 *
 * It formats a decision and decides nothing. The cap and its basis come from
 * `netGrowthCeiling` in lib/issue-filing-gate.ts, the gate's own decider, so
 * the board cannot report a cap the gate does not enforce. The numbers it
 * needs beyond that are passed in rather than imported, which keeps this
 * module free of the gate's runtime dependencies.
 */
export function netGrowthLine(
  decision: { cap: number; basis: NetGrowthBasis | null },
  caps: {
    shipCap: number;
    ceiling: number;
    queueCap: number;
    /**
     * The cap setting the gate could not read, or null. A corrupt `ship`
     * block or a malformed `board.filingsPerRun` falls back to the strict cap,
     * and that fallback must read as UNMEASURED, never as a setting (review of
     * #2089; `.claude/rules/config-access.md`, Silent Default Substitution).
     */
    unreadable: string | null;
    /**
     * Why the COMMITTED config could not be read at all — no `origin/main`
     * resolved, so nothing was read (#1964). Wins over `unreadable`: there is
     * no setting to name, and the repair is a fetch, not a config edit.
     */
    committedUnmeasured?: string | null;
  },
): string {
  const head = `Filing cap: ${decision.cap}`;
  const queue = decision.cap < caps.queueCap ? ` (${caps.queueCap} for an engine-labelled filing)` : "";
  const basis = decision.basis;
  if (basis === null && typeof caps.committedUnmeasured === "string") {
    return (
      `${head}${queue} — UNMEASURED: ${caps.committedUnmeasured}, so the gate fell back to its strict cap ` +
      "and the net-growth ceiling does not apply. The repair is a `git fetch`, not a config edit."
    );
  }
  if (basis === null && caps.unreadable !== null) {
    return (
      `${head}${queue} — ${caps.unreadable} could not be read, so the gate fell back to its strict cap; ` +
      "that cap is UNMEASURED as a setting, and the net-growth ceiling does not apply."
    );
  }
  if (basis === null) {
    return `${head}${queue} — set by ship mode or board.filingsPerRun, so the net-growth ceiling does not apply.`;
  }
  if (basis.reading === "UNMEASURED") {
    return (
      `${head}${queue} — the trailing day's issue counts are UNMEASURED (${basis.why}), ` +
      `so the ceiling of ${caps.ceiling} does not apply.`
    );
  }
  const counts = `the repo opened ${basis.opened} and closed ${basis.closed} issue(s) in the last 24h`;
  if (basis.ceiling) return `${head}${queue} — ${counts}, so the net-growth ceiling applies (ADR-016).`;
  const net = basis.opened - basis.closed;
  return (
    `${head}${queue} — ${counts} (net +${net}), so the cap stays at the ship-mode ${caps.shipCap}; ` +
    `it rises to ${caps.ceiling} once closes catch up (ADR-016).`
  );
}

