#!/usr/bin/env bun
/**
 * `rungate board-conformance` — does the board say what the spec says?
 *
 * This is item **B5** of the ladder in `project-state.json`, and it is the
 * plan's terminal condition: the overall goal's verify command is this
 * command with no arguments, and B1, B2, B3, B4 and B6 are each one of its
 * readings. Read the ladder for what any of that means; nothing here
 * restates a done-condition (AGENTS.md rule 10).
 *
 * ## Why the refusal was written before the command
 *
 * Six verify commands and the plan's own goal all run this one program. A
 * skeleton that exits 0 turns every one of them green in a single commit —
 * "green on the exit code, witnessing the wrong mechanism" from
 * `.claude/rules/checks-must-be-able-to-fail.md`, aimed at the instrument
 * that measures the whole plan. So the first thing this file does is
 * refuse, and `test/board-conformance.test.ts` proves it by running a
 * mutant copy — the refusal constant below rewritten to zero — beside the
 * real one on the same input.
 *
 * Three states, never two. A reading is `met`, `short`, or **`unmeasured`**
 * — and unmeasured refuses. A board nobody could read has not passed; it
 * has not been read, and `.claude/rules/config-access.md` names conflating
 * those *Silent Default Substitution*. With no `--snapshot` every reading
 * is unmeasured, which is why this command exits 1 on a clean checkout
 * today and will keep doing so until B1..B4 and B6 wire their sources.
 *
 * ## No relative imports, on purpose
 *
 * The mutant is a copy of this file in a temp directory. A relative import
 * would fail to resolve there, the mutant would exit non-zero, and every
 * case would read as "caught" while witnessing nothing. Keep this file
 * self-contained.
 */
import { spawnSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parseArgs } from "util";

/**
 * The one exit code every refusal routes through, declared exactly once.
 *
 * `test/board-conformance.test.ts` asserts both halves of that sentence —
 * one assignment, and no exit call carrying its own numeric literal —
 * because an inlined one elsewhere would survive the mutation and hold up
 * a case that nothing was really catching. Those two assertions scan this
 * file's text, so do not spell either pattern in a comment.
 */
export const REFUSE_EXIT = 1;

/** A snapshot of the board, as the readings need to see it. */
export interface BoardIssue {
  number: number;
  /** Issue numbers this one is blocked by, as GitHub's own edges. */
  blockedBy: number[];
  /** Set when the issue is deliberately a root — nothing blocks it. */
  rootReady?: boolean;
  /**
   * The board's Criteria column for this issue — a mirror of the body.
   *
   * **Absent means the producer did not read it. `null` means it read it
   * and the column is empty.** Those are different facts and writing both
   * as `null` would have `criteria-field` report `0 of N — N short` for a
   * column nothing queried, which is a number nobody measured.
   *
   * This is the opposite convention from `BoardCriterion.satisfiedByIssue`,
   * where an omitted key must NOT count as covered. Both point the same
   * way: toward refusing to claim. There, absence reading as met would
   * certify nothing; here, absence reading as short would invent a
   * measurement.
   */
  criteriaField?: string | null;
  labels: string[];
}

export interface BoardCriterion {
  id: string;
  /** The open issue that will satisfy it, or null. */
  satisfiedByIssue: number | null;
  /** Already true in the tree and needing no issue. */
  recordedTrue?: boolean;
}

/**
 * One phase of the spec, and whether the board carries its milestone.
 *
 * The phase population is what makes the `milestones` reading able to fail.
 * `scripts/board-snapshot.ts` says why the issue population cannot: an
 * "engine issue" is only identifiable by the milestone it sits in, so
 * *every engine issue sits in a milestone* is true by construction.
 */
export interface BoardPhase {
  phase: number;
  /** The criteria the spec's Phase placement table puts in this phase. */
  criteria: string[];
  /** `unchanged` means the live milestone already IS the derived one. */
  milestoneState: "create" | "rename" | "update" | "unchanged" | null;
}

export interface BoardSnapshot {
  issues: BoardIssue[];
  criteria: BoardCriterion[];
  phases: BoardPhase[];
  /**
   * The project's work-queue label, carried as DATA rather than read here.
   *
   * It arrives on the snapshot for a mechanical reason as well as a design
   * one. `test/board-conformance.test.ts` builds a mutant copy of this file
   * in an `mkdtemp` directory, and a relative import makes that copy fail
   * to load — which reads as a refusal on the merits and leaves every
   * negative case witnessing nothing
   * (`.claude/rules/self-referential-tests.md`). `scripts/board-snapshot.ts`
   * already imports `readQueueLabel`, so the producer resolves it and this
   * file stays import-free.
   *
   * **Absent means the producer never resolved one**, and `queue-label`
   * goes UNMEASURED rather than counting 0 — same convention as
   * {@link closedBlockers}.
   */
  queueLabel?: string | null;
  /**
   * The CLOSED issues that at least one engine issue names as a blocker.
   *
   * **Absent means the producer never read closed issues. `[]` means it
   * read them and there are none.** Same convention as
   * {@link BoardIssue.criteriaField}, and here for the sharper reason:
   * every snapshot written before #1704 was open-only, and reading its
   * silence as "there are none" reproduces the defect against every one
   * of them. `blocked-by-edges` goes UNMEASURED on an absent key rather
   * than narrowing quietly.
   *
   * It is NOT part of any denominator. A closed issue is finished work,
   * so it is not an engine issue; what it widens is only what an edge may
   * RESOLVE to. See {@link resolvableBlocker}.
   */
  closedBlockers?: number[];

  /**
   * EVERY spec in the tree and whether its criteria are placed — SC-2615.
   *
   * The five readings above are engine-scoped: `phases` comes from the one
   * spec named in `board.engineSpec`, so a spec with no `### Phase placement`
   * table contributes no phases, raises no milestone, appears in no lane and
   * is indistinguishable from a spec with no work left. That is the
   * flattering reading of the two. 1 of 26 specs had a table on 2026-10-29.
   *
   * **Absent means the sweep was never taken**, and `spec-placement` goes
   * UNMEASURED — same convention as {@link closedBlockers}, and for the same
   * reason: an absent sweep and a tree of fully-placed specs produce the
   * identical empty list.
   */
  specPlacements?: SpecPlacementRow[];

  /**
   * EVERY open issue in the repository and what it says it serves — SC-2616.
   *
   * Distinct from {@link issues}, which is the engine milestone's issues. 25
   * of 71 open issues named no criterion on 2026-10-30 and the two states —
   * *has not said* and *says it serves none* — rendered identically, so the
   * population that needs work could not be separated from the population
   * that is finished thinking.
   *
   * **Absent means repository-wide issues were never read**, and
   * `criteria-named` goes UNMEASURED.
   */
  repoIssues?: RepoIssueCriteria[];
}

/** One spec in the repository-wide placement sweep — SC-2615. */
export interface SpecPlacementRow {
  /** Repo-relative, as `lib/spec-placement.ts`'s sweep spells it. */
  path: string;
  /**
   * `NO_CRITERIA` is separate from `UNPLANNED` deliberately: a spec that
   * states nothing to place genuinely has no work in it, and a spec that
   * states twelve and places none has twelve. `UNREADABLE` makes the whole
   * reading unmeasured rather than shortening the list, because a shorter
   * list is exactly what a tree with fewer specs produces.
   */
  state: "PLANNED" | "UNPLANNED" | "NO_CRITERIA" | "UNREADABLE";
  /** How many criteria the spec states, and how many its table places. */
  criteria: number;
  placed: number;
}

/** One open issue, and the criteria it names — SC-2616. */
export interface RepoIssueCriteria {
  number: number;
  /** The criterion ids the issue names. Empty is a BLANK cell, not a denial. */
  names: string[];
  /**
   * Set when the issue declares that it serves no criterion.
   *
   * This is the whole point of the criterion: `names: []` with this false is
   * an issue nobody has answered for, and `names: []` with it true is a
   * decision somebody made. Folding them together is what #1717 found
   * already folded.
   */
  servesNone: boolean;
}

export type ReadingStatus = "met" | "short" | "unmeasured";

export interface Reading {
  name: string;
  /** The ladder item that owns wiring this reading to its real source. */
  item: string;
  what: string;
  status: ReadingStatus;
  measured: number;
  target: number;
  why: string;
  /**
   * The rows that are short, by name. Empty when the reading is met, and
   * empty for a reading that has no way to name them.
   *
   * A ratio is not a refusal somebody can act on. SC-2615 and SC-2616 both
   * say so in their own words — *"or the spec is reported UNPLANNED by
   * name"*, *"reported as a refusal naming the issue"* — and `23 of 26`
   * names nothing. Computed only when the reading is short, so a met
   * reading cannot pay for a list nobody reads.
   */
  offenders: string[];
}

interface ReadingSpec {
  name: string;
  item: string;
  what: string;
  /**
   * True when this measure consumes an ISSUE NUMBER pointing at another
   * row of the board — `satisfiedByIssue`, `blockedBy`.
   *
   * Declared rather than inferred, because the test battery needs to know
   * which readings a dangling-reference board is supposed to move. A
   * reading that reads a reference and does NOT validate it stays `met`
   * under that board, which is indistinguishable from a reading that
   * holds no references at all — so "it did not move" cannot be the
   * signal. This flag is the membership the battery predicts.
   *
   * **Adding a reading that resolves an issue number means setting this
   * and validating the reference.** Rounds 1, 2 and 5 of #1697 were the
   * same hole found three times, one reading at a time.
   */
  readsIssueRefs: boolean;
  /**
   * Why this reading cannot be TAKEN against this board, or null.
   *
   * Separate from `measure` because the two answer different questions. A
   * measure says how much of the population conforms; this says whether the
   * population was read at all. Collapsing them means expressing "nobody
   * looked" as a ratio, and every ratio is a claim.
   *
   * Consulted before `measure`, so a reading that cannot be taken never
   * produces a number for anyone to quote.
   */
  unreadable?: (board: BoardSnapshot) => string | null;
  /** How many of `target` are conformant, and out of how many. */
  measure: (board: BoardSnapshot) => { measured: number; target: number };
  /**
   * The non-conformant rows, named. Consulted ONLY when the reading is
   * short, so it never costs a met run and can never change a verdict.
   *
   * A reading with no `offenders` of its own prints a ratio, which is what
   * the five engine readings did and still do. The three repository-wide
   * ones have populations in the dozens, where a ratio is unactionable.
   */
  offenders?: (board: BoardSnapshot) => string[];
}

/** The issue numbers actually on the board, for resolving a reference. */
const onBoard = (b: BoardSnapshot): Set<number> => new Set(b.issues.map(i => i.number));

/**
 * What a `blockedBy` edge is allowed to point at — #1704.
 *
 * Open engine issues, PLUS the closed issues a producer recorded as named
 * by one. Deliberately not {@link onBoard} widened: that set answers "is
 * this an engine issue", and `criterion-coverage` asks it about a
 * criterion's `satisfiedByIssue`. A criterion pointed at a finished issue
 * is NOT covered — the work is done and the criterion still is not true —
 * while an edge pointed at a finished issue has resolved perfectly. Two
 * questions about the same numbers, so two sets, and the test names an
 * input on which they must disagree.
 *
 * Without this, `blocked-by-edges` flipped MET -> SHORT the first time an
 * engine issue closed: a finished blocker and a typo were both simply
 * absent from the open population, and nothing in the board could tell
 * them apart. It would have broken on the event the order exists to
 * produce, with no change to the board that caused it.
 */
const resolvableBlocker = (b: BoardSnapshot): Set<number> =>
  new Set([...b.issues.map(i => i.number), ...(b.closedBlockers ?? [])]);

/**
 * The five readings, and the ladder item that owns each one's source.
 *
 * The measures are deliberately simple ratios: B5 ships the frame and the
 * refusal, and each of B1, B2, B3, B4 and B6 sharpens its own reading when
 * it wires the real source. What B5 fixes is that none of them can report
 * "met" without having counted something.
 */
export const READINGS: readonly ReadingSpec[] = [
  {
    name: "milestones",
    item: "B1",
    what: "every criterion the spec places sits in a phase whose milestone the board already carries",
    readsIssueRefs: false,
    // Counted in CRITERIA, not phases. A phase holding fourteen criteria
    // and one holding one are not the same amount of plan with no home,
    // and a phase count would call the board 90% conformant while the
    // largest phase on it did not exist.
    //
    // `unchanged` and nothing else. `create` is a missing milestone;
    // `rename` and `update` are a milestone whose title or criteria list
    // has drifted from the table, which is a board saying something the
    // spec does not — the exact thing this command asks about.
    measure: b => ({
      measured: b.phases
        .filter(p => p.milestoneState === "unchanged")
        .reduce((n, p) => n + p.criteria.length, 0),
      target: b.phases.reduce((n, p) => n + p.criteria.length, 0),
    }),
  },
  {
    name: "criterion-coverage",
    item: "B2",
    what: "every engine criterion names an open issue, or is recorded as already true",
    readsIssueRefs: true,
    // `typeof === "number"`, not `!== null`. A criterion object that simply
    // OMITS the field is `undefined`, and `undefined !== null` is true — so
    // a B2 generator relying on ordinary object omission rather than an
    // explicit null would have every uncovered criterion counted as covered.
    // That is this command's own failure mode, inverted: a reading reporting
    // met on data it never saw.
    //
    // And the number has to name an issue that is ON the board. A stale
    // reference, a typo or a renumbered issue is a pointer to nothing, and
    // counting it is the same defect one level deeper: coverage asserted
    // against data the reading never looked at.
    measure: b => {
      const present = onBoard(b);
      return {
        measured: b.criteria.filter(
          c => (typeof c.satisfiedByIssue === "number" && present.has(c.satisfiedByIssue)) || c.recordedTrue === true,
        ).length,
        target: b.criteria.length,
      };
    },
  },
  {
    name: "blocked-by-edges",
    item: "B3",
    what: "every engine issue is a declared root or carries a blocked-by edge, so what is next is computed",
    readsIssueRefs: true,
    // EVERY edge has to resolve, and `some` is not that.
    //
    // The reading exists so "what is next" can be computed from the graph:
    // an issue blocked by a number naming nothing is blocked by something
    // that can never close, so it never surfaces as next and the graph is
    // wrong. One real edge beside a stale one is still a wrong graph, which
    // is why this is `every` and not `some` — round 7 caught the two
    // disagreeing, with this comment already asserting `every`.
    //
    // `length > 0` first, because `[].every(...)` is true and an issue with
    // no edges at all would otherwise pass as a computed one. `rootReady`
    // is how an issue says it has no blockers on purpose.
    // An absent `closedBlockers` is NOT an empty one. A snapshot written
    // before #1704 read open issues only, so it cannot tell a finished
    // blocker from a typo — and treating its silence as "there are none"
    // is exactly the reading that broke. The denominator is unchanged by
    // either answer, so this is a statement about whether anybody looked.
    unreadable: b =>
      b.closedBlockers !== undefined || b.issues.length === 0
        ? null
        : `closed issues were never read, so an edge to a FINISHED blocker is indistinguishable ` +
          `from an edge to one that never existed — both absent from the ${b.issues.length} open ` +
          `issue(s) on this board`,
    measure: b => {
      const present = resolvableBlocker(b);
      return {
        measured: b.issues.filter(
          i => i.rootReady === true || (i.blockedBy.length > 0 && i.blockedBy.every(n => present.has(n))),
        ).length,
        target: b.issues.length,
      };
    },
  },
  {
    name: "criteria-field",
    item: "B4",
    what: "the board's Criteria column is populated for every engine issue",
    readsIssueRefs: false,
    // ANY issue missing the key, not all of them. A partial read is not a
    // read: dropping the unread rows from the denominator makes this
    // reading easier to satisfy the less of the board was looked at, and
    // `1 of 1` is the most flattering sentence this command can produce.
    unreadable: b => {
      const unread = b.issues.filter(i => !("criteriaField" in i)).map(i => `#${i.number}`);
      return unread.length === 0
        ? null
        : `the Criteria column was not read for ${unread.length} of ${b.issues.length} issue(s) ` +
            `(${unread.slice(0, 5).join(", ")}${unread.length > 5 ? ", …" : ""}) — that is not an empty column`;
    },
    measure: b => ({ measured: b.issues.filter(i => (i.criteriaField ?? "").trim() !== "").length, target: b.issues.length }),
  },
  {
    name: "queue-label",
    item: "B6",
    what: "every engine issue carries the queue label, so the queue is the label",
    readsIssueRefs: false,
    // The label is CONFIGURED, and this reading no longer knows its name on
    // its own. Before #1727 it spelled `"engine"` and was the only thing
    // that did, so `plan-issues --decompose --write` could create seven
    // issues without it and take this reading MET 12 of 12 → 5 of 12 — a
    // writer failing a reading it never consults. Both now go through
    // `readQueueLabel`, so there is ONE answer to mutate rather than two
    // that agree (`.claude/rules/checks-must-be-able-to-fail.md`).
    unreadable: b =>
      typeof b.queueLabel === "string" && b.queueLabel.trim() !== ""
        ? null
        : "no queue label is in the snapshot — set `board.queueLabel` in .claude/rungate/config.json and " +
          "re-take it. A tree that never named a queue has not got an empty one, so this is UNMEASURED " +
          "rather than 0 of N.",
    measure: b => {
      // Non-null here: `unreadable` above refused every other case, and
      // `takeReading` runs it first.
      const label = b.queueLabel!;
      return { measured: b.issues.filter(i => i.labels.includes(label)).length, target: b.issues.length };
    },
  },
  {
    name: "spec-placement",
    item: "E1",
    what: "every criterion in every testable spec sits in a phase, or its spec is named UNPLANNED",
    readsIssueRefs: false,
    // Counted in CRITERIA, not specs — the same choice B1 makes and for the
    // same reason. A spec stating fourteen unplaced criteria and one stating
    // a single unplaced criterion are not the same amount of plan with no
    // home, and `25 of 26 specs` would call a tree conformant while the
    // largest body of unplanned work in it sat outside every phase.
    //
    // `NO_CRITERIA` specs contribute 0 to both sides. A spec with nothing to
    // place is neither conformant nor short; putting it in the denominator
    // would make the reading unsatisfiable, and putting it in the numerator
    // would let a tree of empty specs read as fully planned.
    unreadable: b => {
      if (b.specPlacements === undefined) {
        return "the specs/ sweep was never taken, so no spec's placement was read — that is a " +
          "producer that did not look, not a tree whose specs are all placed";
      }
      // ONE unreadable spec makes the whole reading unmeasured, not a
      // shorter list — `lib/spec-placement.ts` takes the same position, and
      // a shorter list is exactly what a tree with fewer specs produces.
      const broken = b.specPlacements.filter(s => s.state === "UNREADABLE").map(s => s.path);
      return broken.length === 0
        ? null
        : `${broken.length} spec(s) could not be read (${broken.slice(0, 5).join(", ")}` +
            `${broken.length > 5 ? ", …" : ""}), so the sweep covers an unknown fraction of the tree`;
    },
    measure: b => {
      const specs = b.specPlacements!.filter(s => s.state !== "NO_CRITERIA");
      return {
        measured: specs.reduce((n, s) => n + s.placed, 0),
        target: specs.reduce((n, s) => n + s.criteria, 0),
      };
    },
    offenders: b =>
      b.specPlacements!
        .filter(s => s.state === "UNPLANNED")
        .map(s => `${s.path} — ${s.criteria - s.placed} of ${s.criteria} criteria in no phase`),
  },
  {
    name: "criteria-named",
    item: "E2",
    what: "every open issue names the criteria it serves, or declares that it serves none",
    readsIssueRefs: false,
    // A DECLARED `servesNone` counts; a blank cell does not. Those are the
    // two states SC-2616 exists to separate, and the whole criterion is that
    // they rendered identically — 25 of 71 open issues named nothing on
    // 2026-10-30 and nothing could say which of them had been decided.
    //
    // Reading `names.length > 0 || servesNone` rather than `names.length > 0
    // || names !== undefined` on purpose: an issue whose body says nothing
    // is not an issue that says it serves nothing, and a normaliser cannot
    // invent the difference.
    unreadable: b =>
      b.repoIssues === undefined
        ? "the repository's open issues were never read, so no issue's criteria were seen — " +
          "`issues` above is the engine milestone only, which is a different population"
        : null,
    measure: b => ({
      measured: b.repoIssues!.filter(i => i.names.length > 0 || i.servesNone).length,
      target: b.repoIssues!.length,
    }),
    offenders: b =>
      b.repoIssues!
        .filter(i => i.names.length === 0 && !i.servesNone)
        .map(i => `#${i.number} — names no criterion and does not declare that it serves none`),
  },
  // SC-2617's `dependency-edges` reading is NOT here, and its absence is a
  // decision rather than an omission — see #1717.
  //
  // It was written, measured 129 of 154 on the live tracker, and withdrawn
  // at review round 3 of #1903 because the number was taken over the wrong
  // population. `dependencyPlan` buckets issues by `phaseOf`, which is
  // `/\bPhase (\d+)\b/` — family-blind. `plan-deps`, its only other caller,
  // REFUSES an omitted `--milestone-prefix` and filters before calling it,
  // so the function has always been single-family by contract. This repo
  // carries two live families: `Convergence Phase N` and `Pipeline Phase N`,
  // both with open issues at overlapping numbers, so a repo-wide call
  // chains one spec's phase to another's.
  //
  // SC-2617 asks a repository-wide question of a function with no family
  // concept, which is a design gap and not a repair. #1717 stays open
  // carrying it, with the measurement and the decision in a comment there.
];

export const READING_NAMES: readonly string[] = READINGS.map(r => r.name);

/**
 * Take one reading.
 *
 * `board` is null when nothing could be read — no snapshot, or one this
 * command cannot parse. That is UNMEASURED and it refuses.
 *
 * **An empty board is UNMEASURED too.** A reading whose target is 0 is
 * satisfied by counting nothing, which is the vacuous-assertion shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`: `0 of 0` would report
 * `met` and a board with no issues on it would certify the whole plan.
 */
export function takeReading(spec: ReadingSpec, board: BoardSnapshot | null): Reading {
  const base = { name: spec.name, item: spec.item, what: spec.what };
  if (board === null) {
    // **THE REASON NAMES THE CALLER, NOT THE READING.** This said
    // `${spec.item} has not wired this reading's source yet` — a claim that
    // the reading is unimplemented — for every caller that simply had no
    // board to hand it. `main` can no longer reach this arm at all (#1718:
    // every source either produces a board or returns a reason), so the one
    // way here is an API caller passing null, and that is what it now says.
    return { ...base, status: "unmeasured", measured: 0, target: 0, why: "no board snapshot was passed to this reading, so nothing was measured — that is a caller with no board, not a board with nothing on it", offenders: [] };
  }
  const why = spec.unreadable?.(board) ?? null;
  if (why !== null) return { ...base, status: "unmeasured", measured: 0, target: 0, why, offenders: [] };
  const { measured, target } = spec.measure(board);
  if (target === 0) {
    return { ...base, status: "unmeasured", measured, target, why: "the board carries nothing for this reading to count, so 0 of 0 is not a pass", offenders: [] };
  }
  if (measured >= target) return { ...base, status: "met", measured, target, why: `${measured} of ${target}`, offenders: [] };
  // Named only here. A met reading never pays for the list, and an
  // UNMEASURED one must not print rows — it did not read the population it
  // would be naming them out of.
  return {
    ...base,
    status: "short",
    measured,
    target,
    why: `${measured} of ${target} — ${target - measured} short`,
    offenders: spec.offenders?.(board) ?? [],
  };
}

export function takeReadings(board: BoardSnapshot | null): Reading[] {
  return READINGS.map(spec => takeReading(spec, board));
}

/** True when every reading is `met`. Any other status refuses. */
export function conformant(readings: readonly Reading[]): boolean {
  return readings.length > 0 && readings.every(r => r.status === "met");
}

/**
 * How many offending rows a short reading prints before it stops.
 *
 * A cap, not a sample: the line below says how many were withheld, so the
 * reader is never told a truncated list is the whole one.
 */
export const OFFENDERS_SHOWN = 10;

export function formatReading(r: Reading): string {
  const mark = r.status === "met" ? "MET        " : r.status === "short" ? "SHORT      " : "UNMEASURED ";
  const head = `${mark} ${r.name.padEnd(20)} ${r.why}\n             ${r.what}  [${r.item}]`;
  if (r.offenders.length === 0) return head;
  const shown = r.offenders.slice(0, OFFENDERS_SHOWN).map(o => `\n               ${o}`).join("");
  const rest = r.offenders.length > OFFENDERS_SHOWN
    ? `\n               … and ${r.offenders.length - OFFENDERS_SHOWN} more`
    : "";
  return `${head}${shown}${rest}`;
}

/**
 * An absent optional field is NOT an unreadable board.
 *
 * The boundary normalises where the measures already tolerate absence —
 * `milestone`, `criteriaField`, `satisfiedByIssue`, `blockedBy`,
 * `labels` — and refuses only where it cannot. Validating those strictly
 * was worse than not validating them: a generator that builds a criterion
 * without ever touching `satisfiedByIssue` produces JSON with the key
 * dropped, which is an ordinary way to produce JSON, and the whole
 * snapshot became unparseable. Every reading then said UNMEASURED,
 * including the four that had nothing to do with the missing field,
 * instead of `criterion-coverage` alone going short.
 *
 * `number` and `id` are different: they are what a reference RESOLVES
 * against. A row that cannot be identified makes every pointer to it
 * unanswerable, so a board containing one is genuinely unread.
 */
const asText = (v: unknown): string | null => (typeof v === "string" ? v : null);
const asList = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

const normaliseIssue = (v: unknown): BoardIssue | null => {
  if (typeof v !== "object" || v === null) return null;
  const i = v as Partial<BoardIssue>;
  if (typeof i.number !== "number") return null;
  return {
    number: i.number,
    blockedBy: asList<number>(i.blockedBy).filter(n => typeof n === "number"),
    rootReady: i.rootReady === true,
    // Key PRESENCE, not value. `asText(undefined)` is `null`, which would
    // erase the distinction this field exists to carry — an omitted column
    // and a column read as empty would arrive here identical.
    ...("criteriaField" in (v as object) ? { criteriaField: asText(i.criteriaField) } : {}),
    labels: asList<string>(i.labels).filter(l => typeof l === "string"),
  };
};

const normaliseCriterion = (v: unknown): BoardCriterion | null => {
  if (typeof v !== "object" || v === null) return null;
  const c = v as Partial<BoardCriterion>;
  if (typeof c.id !== "string") return null;
  return {
    id: c.id,
    satisfiedByIssue: typeof c.satisfiedByIssue === "number" ? c.satisfiedByIssue : null,
    recordedTrue: c.recordedTrue === true,
  };
};

/**
 * The four values `milestonePlan` emits. Spelled out rather than accepted
 * as any string, because a typo — or a producer inventing a fifth verdict —
 * would land in the `!== "unchanged"` bucket and read as an honest SHORT
 * instead of the unreadable row it is.
 */
const MILESTONE_STATES = ["create", "rename", "update", "unchanged"] as const;

const hasRepeat = <T>(xs: T[]): boolean => new Set(xs).size !== xs.length;

const normalisePhase = (v: unknown): BoardPhase | null => {
  if (typeof v !== "object" || v === null) return null;
  const p = v as Partial<BoardPhase>;
  if (typeof p.phase !== "number") return null;
  const state = MILESTONE_STATES.find(s => s === p.milestoneState) ?? null;
  if (p.milestoneState !== undefined && p.milestoneState !== null && state === null) return null;
  return {
    phase: p.phase,
    criteria: asList<string>(p.criteria).filter(c => typeof c === "string"),
    milestoneState: state,
  };
};

/**
 * The four states `placementCoverage` emits, spelled out for the same reason
 * {@link MILESTONE_STATES} is: an unknown fifth would fall into the
 * not-PLANNED bucket and read as an honest UNPLANNED instead of the row
 * nobody can interpret that it is.
 */
const PLACEMENT_STATES = ["PLANNED", "UNPLANNED", "NO_CRITERIA", "UNREADABLE"] as const;

const normaliseSpecPlacement = (v: unknown): SpecPlacementRow | null => {
  if (typeof v !== "object" || v === null) return null;
  const s = v as Partial<SpecPlacementRow>;
  if (typeof s.path !== "string") return null;
  const state = PLACEMENT_STATES.find(x => x === s.state);
  if (state === undefined) return null;
  const criteria = typeof s.criteria === "number" ? s.criteria : 0;
  const placed = typeof s.placed === "number" ? s.placed : 0;
  // A row claiming more placed than stated would let one spec carry another
  // spec's shortfall, and the sum is the whole reading.
  if (criteria < 0 || placed < 0 || placed > criteria) return null;
  return { path: s.path, state, criteria, placed };
};

const normaliseRepoIssue = (v: unknown): RepoIssueCriteria | null => {
  if (typeof v !== "object" || v === null) return null;
  const i = v as Partial<RepoIssueCriteria>;
  if (typeof i.number !== "number") return null;
  return {
    number: i.number,
    names: asList<string>(i.names).filter(n => typeof n === "string" && n.trim() !== ""),
    // `=== true`, so a producer that omits the key produces a BLANK cell
    // rather than a declaration. The omission must not be able to say
    // something the issue did not.
    servesNone: i.servesNone === true,
  };
};

/**
 * A board, or the reason there is not one. Never a bare null.
 *
 * Every way of failing to read a snapshot used to return the same `null`
 * and the same sentence, so the command's refusal was identical whether a
 * population was missing, a row was unidentifiable or the file was not
 * JSON. A case asserting on that sentence is asserting on a signal three
 * mechanisms share — `.claude/rules/checks-must-be-able-to-fail.md`'s
 * *green on the exit code, witnessing the wrong mechanism*, found by the
 * mutation battery for exactly this: dropping the required-population
 * check left every case green, because an absent population became an
 * empty one and UNMEASURED refuses too.
 */
export type SnapshotRead = { board: BoardSnapshot; why: null } | { board: null; why: string };

const unread = (why: string): SnapshotRead => ({ board: null, why });

function readSnapshot(path: string): SnapshotRead {
  try {
    return readSnapshotText(readFileSync(path, "utf-8"));
  } catch (e) {
    return unread(`${path} could not be read: ${(e as Error).message}`);
  }
}

/**
 * Every POPULATION is required; every FIELD inside a row is tolerated.
 *
 * The two are different questions and this used to answer only the first.
 * A population the snapshot never mentions is a reading with no input, and
 * an absent array is indistinguishable from an empty one — which this
 * command calls UNMEASURED on purpose. So the three arrays must be
 * present, and a producer adding a fourth population makes every older
 * snapshot unreadable by name rather than quietly dropping a reading.
 *
 * Inside a row the call goes the other way: an absent optional key
 * degrades its own reading. Round 6 of #1697 is why — the strict version
 * refused the whole board over one omitted key and turned four unrelated
 * readings UNMEASURED.
 */
export function readSnapshotText(text: string): SnapshotRead {
  let raw: Partial<BoardSnapshot>;
  try {
    raw = JSON.parse(text) as Partial<BoardSnapshot>;
  } catch (e) {
    return unread(`it is not JSON: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) return unread("it is not a JSON object");
  for (const population of ["issues", "criteria", "phases"] as const) {
    if (!Array.isArray(raw[population])) {
      return unread(`it carries no \`${population}\` array — a population nobody wrote down is not an empty one`);
    }
  }

  const issues = raw.issues!.map(normaliseIssue);
  const criteria = raw.criteria!.map(normaliseCriterion);
  const phases = raw.phases!.map(normalisePhase);
  const unidentifiable: [string, (number | null)[]][] = [
    ["issues", issues.map((v, n) => (v === null ? n : null))],
    ["criteria", criteria.map((v, n) => (v === null ? n : null))],
    ["phases", phases.map((v, n) => (v === null ? n : null))],
  ];
  for (const [population, flagged] of unidentifiable) {
    const at = flagged.find(n => n !== null);
    if (at !== undefined) {
      return unread(
        `\`${population}\`[${at}] has no usable identity, or a value this command does not define — ` +
          `a row nothing can resolve against makes every pointer to it unanswerable`,
      );
    }
  }

  // A repeated identity is an unread board, not a longer one. Every
  // reading here is a ratio over a population, so two rows carrying one
  // row's identity inflate the denominator — and `onBoard` dedupes issue
  // numbers into a Set, so the numerator would not rise with it. The
  // board would report short against a target nothing can reach.
  //
  // A LIST a measure counts the length of is a population too, and
  // `phases[].criteria` is one: the `milestones` reading sums it, so one
  // criterion listed in two phases — or twice in one — raises the target
  // while only one of the two can ever be credited. Found in review as
  // the same defect one level down from the row identities, which is
  // where a sweep that stops at the row shape leaves it.
  //
  // `blockedBy` and `labels` are NOT here, and the test asserts that
  // membership rather than this comment doing it: nothing counts their
  // length, so a repeat in either moves no reading, and refusing a board
  // over a duplicate that changes no reading is a refusal nobody can act
  // on.
  const repeats: [string, unknown[]][] = [
    ["issues", issues.map(i => i!.number)],
    ["criteria", criteria.map(c => c!.id)],
    ["phases", phases.map(p => p!.phase)],
    ["phases[].criteria", phases.flatMap(p => p!.criteria)],
  ];
  for (const [population, ids] of repeats) {
    if (hasRepeat(ids)) {
      return unread(`\`${population}\` repeats an identity, so its denominator counts one row twice`);
    }
  }

  // `closedBlockers` is spread in only when the key is PRESENT, because
  // its absence is the signal. Writing `closedBlockers: raw.closedBlockers`
  // unconditionally would put the key on the object with value `undefined`
  // — and `"closedBlockers" in board` would then be true for a snapshot
  // that never carried it. A non-array value is dropped the same way an
  // absent one is: a producer that wrote something else did not write a
  // list of closed blockers.
  const closed = Array.isArray(raw.closedBlockers)
    ? { closedBlockers: raw.closedBlockers.filter((n): n is number => typeof n === "number") }
    : {};

  // TRIMMED here, which is the only place it can be. `readQueueLabel`
  // trims at the config read, but that is the PRODUCER path — this function
  // also accepts a hand-written or externally produced `--snapshot`, and
  // copying `" engine "` through verbatim passed `unreadable` (non-blank
  // after trim) and then had `measure` search issue labels for the literal
  // `" engine "`, which no GitHub label can equal. The reading would have
  // said 0 of N — a confident wrong number where UNMEASURED or the right
  // count belonged. Found in review of #1727.
  //
  // Normalising at the boundary rather than re-trimming inside `measure`
  // keeps ONE answer to *what is the label*: `unreadable` and `measure`
  // then read the same bytes by construction, instead of two guards
  // agreeing to trim and a third one later forgetting.
  //
  // `queueLabel` is carried the same way as `closedBlockers`, for the same
  // reason — #1727.
  // This function rebuilds the board from a NAMED list of fields rather
  // than spreading `raw`, so a key nobody adds here is silently dropped on
  // EVERY path: `--snapshot` as well as `--produce`. The producer wrote
  // the label, the reading never saw it, and `queue-label` reported
  // UNMEASURED against a snapshot that carried exactly what it asked for.
  //
  // Present-only, like `closedBlockers`: absence is the signal the reading
  // reports on, so writing the key unconditionally would make a tree that
  // never configured a queue indistinguishable from one that did.
  const queue = typeof raw.queueLabel === "string" ? { queueLabel: raw.queueLabel.trim() } : {};

  // The three repository-wide populations, carried the same present-only
  // way and for the same reason: absence IS the reading. They are NOT in
  // the required list above, because adding a required population makes
  // every snapshot written before today unreadable BY NAME — which is the
  // documented behaviour and the right one for a population every reading
  // depends on, and the wrong one here, where exactly one reading does.
  //
  // Each is validated into its own shape rather than trusted. A row this
  // command cannot identify is DROPPED from the population rather than
  // refusing the board, which is deliberate and is the opposite of the rule
  // for `issues`: a dropped row shortens a denominator, so the reading gets
  // EASIER — and that is why `specPlacements` carries `UNREADABLE` as a
  // state rather than relying on the row vanishing. A producer emitting
  // malformed rows is caught by its own tests, not by shortening a ratio
  // here where no reader would see it.
  const placements = Array.isArray(raw.specPlacements)
    ? { specPlacements: raw.specPlacements.map(normaliseSpecPlacement).filter((s): s is SpecPlacementRow => s !== null) }
    : {};
  const repoIssues = Array.isArray(raw.repoIssues)
    ? { repoIssues: raw.repoIssues.map(normaliseRepoIssue).filter((i): i is RepoIssueCriteria => i !== null) }
    : {};
  return {
    board: {
      issues: issues as BoardIssue[],
      criteria: criteria as BoardCriterion[],
      phases: phases as BoardPhase[],
      ...closed,
      ...queue,
      ...placements,
      ...repoIssues,
    },
    why: null,
  };
}

/**
 * Run the producer and read what it wrote — SPAWNED, never imported.
 *
 * The producer imports `lib/spec-placement` and `lib/github`. Importing it
 * here would put those on this file's import graph, the mutation battery's
 * copy in a temp directory would die on module resolution, and every
 * negative case would go green having witnessed nothing
 * (`.claude/rules/checks-must-be-able-to-fail.md`). A subprocess has no
 * module graph to carry, so the path is resolved rather than imported.
 *
 * Which also means a mutant cannot use this: its `import.meta.dir` is the
 * temp directory and the spawn fails. The battery uses `--snapshot`, which
 * is why that stays the only source the negative cases touch.
 *
 * ## `notes` exists because the producer's stderr used to be thrown away
 *
 * Every failure arm below quotes `r.stderr`; the SUCCESS arm read `r.stdout`
 * and dropped the rest on the floor. So on the one path anybody runs daily,
 * the producer's provenance — which tree the spec came from (D3), which
 * inputs were resolved from config rather than typed, which readings it
 * could not take — was written, captured, and discarded.
 *
 * It is RETURNED rather than written here so a case can assert on it. A
 * `process.stderr.write` inside this function is invisible to an in-process
 * test, which is how it would have gone uncovered a second time.
 *
 * `producer` is a parameter for the same reason: pointed at a stub, a case
 * can drive the success arm without a network, which no case could do while
 * the path was a constant.
 */
export const DEFAULT_PRODUCER = join(import.meta.dir, "board-snapshot.ts");

export function produceBoard(
  flags: Flags,
  producer: string = DEFAULT_PRODUCER,
): { board: BoardSnapshot | null; error: string | null; notes: string } {
  const { spec, prefix, repo, specGiven, prefixGiven, repoGiven } = flags;
  // **GIVEN-AND-BLANK REFUSES. ABSENT FORWARDS NOTHING.** These used to be
  // one case and #1718 split them, because they carry opposite
  // instructions. `--prefix ""` is somebody typing a value, and reaching
  // past it to a configured default would override a person with a file.
  // Omitting the flag entirely carries no instruction at all, so the
  // producer resolves it from `board.engineSpec` / `board.milestonePrefix`
  // and refuses by name when the config has not got it — which is how
  // `rungate board-conformance` with no arguments became a command that
  // takes its own reading instead of five UNMEASURED rows blaming itself.
  //
  // The blank arm stays for the reason it was written: an empty value
  // reaching the producer makes the reader report the CHILD's refusal for
  // an argument this command was handed. Same population as plan-deps'
  // --milestone-prefix and board-snapshot's own --prefix.
  //
  // **WRITTEN AS A SWEEP OVER EVERY FORWARDED INPUT, not a case per
  // flag.** Review of #1890 found `--repo` left out of a two-row version
  // of this list: `"" ?? env` keeps the empty string and `resolveRepoSlug`
  // reads it as "not given", so a blank reached the producer and resolved
  // this checkout's own origin. A list that enumerates the inputs cannot
  // be short by one the way three hand-written conditions can — adding a
  // fourth forwarded flag without a row here is a visible omission.
  const blank = ([
    ["--spec", specGiven, spec],
    ["--prefix", prefixGiven, prefix],
    ["--repo", repoGiven, repo],
  ] as [string, boolean, string | undefined][])
    .filter(([, given, value]) => given && (value === undefined || value.trim() === ""))
    .map(([flag]) => flag);
  if (blank.length > 0) {
    return {
      board: null,
      notes: "",
      error:
        `${blank.join(" and ")} was given with no usable value. Pass a value, or omit the flag ` +
        `entirely and the spec and prefix are read from \`board.engineSpec\` and ` +
        `\`board.milestonePrefix\` in this project's rungate config.`,
    };
  }
  const args = [producer];
  if (spec !== undefined) args.push(spec);
  if (prefix !== undefined) args.push("--prefix", prefix);
  if (repo !== undefined) args.push("--repo", repo);
  // A TIMEOUT, because a hang is the one failure mode every other branch
  // here turns into a crisp refusal and this one did not. `listMilestones`
  // has no timeout of its own, and B5 exists so a loop can run
  // unattended — a wedge is worse than a refusal, because nothing
  // observes it.
  const r = spawnSync("bun", args, { encoding: "utf-8", timeout: PRODUCE_TIMEOUT_MS });
  // The timeout BEFORE the generic error. An expired `timeout` sets
  // `error` as well as `signal`, so checking `error` first puts a hang
  // into the "could not be started" branch, which says the opposite of
  // what happened.
  //
  // `signal`, and not `error.code === "ETIMEDOUT"`. Measured on this
  // runtime: a killed child reports `status: null, signal: "SIGTERM",
  // error.code: "ETIMEDOUT"` — BOTH — so an `||` across the two has a
  // half no input here can reach, and a clause nothing can exercise is
  // not a guard.
  if (r.signal !== null && r.signal !== undefined) {
    // AND WHAT THE CHILD ALREADY SAID. This was the one arm reaching
    // neither `error` nor `notes`, so the producer's provenance — the
    // `board-snapshot: resolved from…` lines, and how far it got before
    // it stuck — was discarded on exactly the failure where knowing WHERE
    // it stuck is the whole question. Every other arm below quotes it.
    // The producer redacts its own credentials before writing, so this
    // relays an already-redacted reading. Review of #1896 round 12.
    const said = (r.stderr ?? "").trim();
    return {
      board: null,
      notes: "",
      error:
        `board-snapshot was killed by ${r.signal ?? "the timeout"} after ${PRODUCE_TIMEOUT_MS}ms. A producer ` +
        `that hangs is UNMEASURED, not a board — an unattended loop cannot observe a wedge.` +
        (said === "" ? " It wrote nothing before it was killed." : ` It got as far as: ${said}`),
    };
  }
  // Then a spawn that never started — no `bun` on PATH. It sets `error`
  // and leaves status null with both streams empty, so reading only
  // those reports "exit none: no output" for the one failure whose cause
  // is already in hand.
  if (r.error) {
    return { board: null, notes: "", error: `board-snapshot could not be started: ${r.error.message}` };
  }
  if (r.status !== 0) {
    // `notes` stays EMPTY on this arm, not a second copy of the same bytes:
    // the refusal message already quotes `r.stderr`, and printing both puts
    // the producer's reason on screen twice with nothing saying they are one
    // reading.
    return {
      board: null,
      notes: "",
      error: `board-snapshot refused (exit ${r.status ?? "none"}): ${(r.stderr || r.stdout || "no output").trim()}`,
    };
  }
  // PAST THE EXIT CODE, so `notes` carries what the producer said on the
  // path where nothing else quotes it. This is the daily path, and it is the
  // one that used to be silent.
  const notes = (r.stderr ?? "").trim();
  const read = readSnapshotText(r.stdout);
  return read.board === null
    ? { board: null, notes, error: `board-snapshot exited 0 and what it emitted is unreadable — ${read.why}` }
    : { board: read.board, notes, error: null };
}

/**
 * How long the producer gets. A reading is a few API calls; a minute is
 * a hang.
 *
 * Overridable by env ONLY so the hang can be proved — a timeout nothing
 * can reach inside a test run is a timeout nobody has watched fire, and
 * that is the shape this whole file is about. A non-numeric or absent
 * value falls back to the default rather than to zero, because `0`
 * disables the timeout entirely in `spawnSync` and a mis-set variable
 * would quietly remove the bound.
 */
export const PRODUCE_TIMEOUT_MS = Number(process.env.RUNGATE_PRODUCE_TIMEOUT_MS) || 60_000;

export interface Flags {
  listReadings: boolean;
  produce: boolean;
  snapshot?: string;
  snapshotGiven: boolean;
  reading?: string;
  readingGiven: boolean;
  spec?: string;
  /** The flag APPEARED, whatever its value — `--spec ""` is given. */
  specGiven: boolean;
  prefix?: string;
  prefixGiven: boolean;
  repo?: string;
  repoGiven: boolean;
  /**
   * Where to write the readings as JSON, for a consumer that must not
   * parse this command's prose — #1889.
   *
   * `scripts/check-state-claims.ts` re-derives the figures
   * `project-state.json` states about the board, and it needs `measured`
   * and `target` as numbers. Reading them back out of `formatReading`'s
   * output would be a detector narrower than what it detects: a change to
   * the padding or the wording there would silently stop the state check
   * from seeing anything, and an extractor that matches nothing certifies
   * by counting nothing.
   */
  emitReadings?: string;
  emitReadingsGiven: boolean;
}

/**
 * ONE parser for the whole command, and the same one the producer uses.
 *
 * This read its flags with `argv.indexOf(name)` and the producer reads
 * its own with `parseArgs`, so `--spec=x` worked when `board-snapshot`
 * was called directly and was silently refused when `board-conformance
 * --produce` forwarded it. Two parsers for one input, free to disagree
 * about exactly the spelling that matters —
 * `.claude/rules/checks-must-be-able-to-fail.md`, *two deciders*. Found
 * in review. `parseArgs` is from `node:util`, so this costs no relative
 * import and the mutant still loads.
 *
 * `strict: false` because this command's flag set is not the producer's
 * and an unknown flag is not what refuses here.
 */
function readFlags(argv: readonly string[]): Flags {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "list-readings": { type: "boolean" },
      produce: { type: "boolean" },
      snapshot: { type: "string" },
      reading: { type: "string" },
      spec: { type: "string" },
      prefix: { type: "string" },
      repo: { type: "string" },
      "emit-readings": { type: "string" },
    },
    strict: false,
    allowPositionals: true,
  });
  // A flag whose value is another flag, or absent, parses as `true` or as
  // the next flag's name. Neither is a value, and both have to stay
  // distinguishable from "not given at all".
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && !v.startsWith("--") ? v : undefined;
  return {
    listReadings: values["list-readings"] === true,
    produce: values.produce === true,
    snapshot: str(values.snapshot),
    snapshotGiven: values.snapshot !== undefined,
    reading: str(values.reading),
    readingGiven: values.reading !== undefined,
    spec: str(values.spec),
    specGiven: values.spec !== undefined,
    prefix: str(values.prefix),
    prefixGiven: values.prefix !== undefined,
    repo: str(values.repo),
    repoGiven: values.repo !== undefined,
    emitReadings: str(values["emit-readings"]),
    emitReadingsGiven: values["emit-readings"] !== undefined,
  };
}

export function main(argv: readonly string[]): number {
  let flags: Flags;
  try {
    flags = readFlags(argv);
  } catch (e) {
    console.error(`board-conformance: ${(e as Error).message}`);
    return REFUSE_EXIT;
  }

  // #1889, and ABOVE every early return rather than beside the write.
  //
  // `--reading` and `--list-readings` both answer and return before the
  // readings are taken as a set, so either combined with --emit-readings
  // wrote nothing — and `--list-readings` exits ZERO, so a caller running
  // `board-conformance … && check-state-claims …` proceeds onto whatever
  // that path held from an earlier run. A stale artefact consumed as live
  // is the exact defect `scripts/check-state-claims.ts` exists to catch,
  // so this command must not be the thing that creates one.
  //
  // The rule this encodes: every exit from `main` that was given
  // --emit-readings either writes the file or refuses. There is no third
  // outcome, because a caller cannot tell the third from success.
  if (flags.emitReadingsGiven && (flags.readingGiven || flags.listReadings)) {
    console.error(
      "board-conformance: --emit-readings writes the whole set; --reading takes one and " +
        "--list-readings takes none. Pass one. Combined, the file is not written, and a consumer " +
        "cannot tell that from a file written by an earlier run.",
    );
    return REFUSE_EXIT;
  }
  if (flags.emitReadingsGiven && flags.emitReadings === undefined) {
    console.error("board-conformance: --emit-readings needs a path");
    return REFUSE_EXIT;
  }

  if (flags.listReadings) {
    for (const r of READINGS) console.log(`${r.name.padEnd(20)} ${r.what}  [${r.item}]`);
    return 0;
  }

  const snapshotPath = flags.snapshot;
  if (flags.snapshotGiven && snapshotPath === undefined) {
    console.error("board-conformance: --snapshot needs a path");
    return REFUSE_EXIT;
  }

  // **THE READING NAME IS VALIDATED BEFORE ANY SOURCE IS RESOLVED.** It
  // used to be checked after, which cost nothing while a source was always
  // a file somebody passed. Once a bare run produces its own board (#1718)
  // that ordering makes a typo spend a live board fetch — several API
  // calls, tens of seconds — before saying the word is misspelt. Nothing
  // about an unknown reading depends on the board, so nothing about it
  // should wait for one.
  const named = flags.readingGiven ? READINGS.find(r => r.name === flags.reading) : undefined;
  if (flags.readingGiven && named === undefined) {
    // A typo must never read as a pass. This is the first case the mutant
    // has to fail to catch, because it is the one an agent in a loop will
    // hit by writing a reading that does not exist yet.
    console.error(
      `board-conformance: unknown reading "${flags.reading ?? ""}". Known readings: ${READING_NAMES.join(", ")}.\n` +
        `Run \`rungate board-conformance --list-readings\` for what each one measures.`,
    );
    return REFUSE_EXIT;
  }

  let board: BoardSnapshot | null = null;
  let sourceFailed: string | null = null;
  if (flags.produce && flags.snapshotGiven) {
    console.error("board-conformance: --produce and --snapshot are two sources. Pass one.");
    return REFUSE_EXIT;
  }
  // **NO SOURCE IS NOT A SOURCE, AND IT USED TO BE TREATED AS ONE.** With
  // neither flag this fell through with `board === null` and printed five
  // UNMEASURED rows whose stated reason was `B1 has not wired this
  // reading's source yet` — a sentence about an unfinished tool, emitted by
  // a finished one, because nobody had passed a spec. It exited 1, so the
  // terminal condition was right and the diagnosis was a fabrication, which
  // is the worse half: a reader acts on the reason, not the exit code.
  //
  // Taking its own reading is the fix, not a better sentence (#1718,
  // SC-2618/SC-2619). The producer resolves the spec, the prefix and the
  // repository from the project itself and refuses naming the config key it
  // could not find, so every outcome here is now a reading or a refusal
  // that says what is missing.
  if (flags.produce || !flags.snapshotGiven) {
    const produced = produceBoard(flags);
    // WHAT THE PRODUCER SAID, on stderr, before any verdict. It names which
    // tree the spec came from (D3) and which inputs were resolved from
    // config rather than typed — both captured and discarded until
    // 2026-11-08, on the success path and only on the success path.
    if (produced.notes !== "") console.error(produced.notes);
    if (produced.error !== null) sourceFailed = produced.error;
    else board = produced.board;
  } else if (snapshotPath !== undefined) {
    const read = readSnapshot(snapshotPath);
    board = read.board;
    if (read.board === null) sourceFailed = `${snapshotPath} is not a readable board snapshot: ${read.why}.`;
  }
  if (sourceFailed !== null) {
    console.error(`board-conformance: UNMEASURED — ${sourceFailed} That is not an empty board.`);
    return REFUSE_EXIT;
  }

  if (named !== undefined) {
    const reading = takeReading(named, board);
    console.log(formatReading(reading));
    return reading.status === "met" ? 0 : REFUSE_EXIT;
  }

  const readings = takeReadings(board);
  // WRITTEN BEFORE THE VERDICT, and on every path that got this far. A
  // short reading is still a reading, and a consumer that only receives
  // the file when the board is fully conformant would be unmeasured for
  // exactly as long as anything is outstanding — which is now (#1889).
  // `flags.emitReadings` is known present: the flag-combination guard at
  // the top of `main` refused a bare `--emit-readings` before any source
  // was resolved, so nothing reaches here with the flag given and no path.
  if (flags.emitReadingsGiven && flags.emitReadings !== undefined) {
    try {
      writeFileSync(flags.emitReadings, `${JSON.stringify(readings, null, 2)}\n`);
    } catch (e) {
      console.error(`board-conformance: could not write ${flags.emitReadings}: ${(e as Error).message}`);
      return REFUSE_EXIT;
    }
  }
  for (const r of readings) console.log(formatReading(r));
  const outstanding = readings.filter(r => r.status !== "met");
  if (outstanding.length > 0) {
    console.error(
      `\nboard-conformance: ${outstanding.length} of ${readings.length} reading(s) are not met — ` +
        `${outstanding.map(r => `${r.name} (${r.status})`).join(", ")}.`,
    );
    return REFUSE_EXIT;
  }
  console.log("\nboard-conformance: every reading is met.");
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
