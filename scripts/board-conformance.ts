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
import { readFileSync } from "fs";
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
  /** The board's Criteria column for this issue — a mirror of the body. */
  criteriaField: string | null;
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
  /** How many of `target` are conformant, and out of how many. */
  measure: (board: BoardSnapshot) => { measured: number; target: number };
}

/** The issue numbers actually on the board, for resolving a reference. */
const onBoard = (b: BoardSnapshot): Set<number> => new Set(b.issues.map(i => i.number));

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
    measure: b => {
      const present = onBoard(b);
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
    measure: b => ({ measured: b.issues.filter(i => (i.criteriaField ?? "").trim() !== "").length, target: b.issues.length }),
  },
  {
    name: "queue-label",
    item: "B6",
    what: "every engine issue carries the `engine` label, so the queue is the label",
    readsIssueRefs: false,
    measure: b => ({ measured: b.issues.filter(i => i.labels.includes("engine")).length, target: b.issues.length }),
  },
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
    return { ...base, status: "unmeasured", measured: 0, target: 0, why: `no board snapshot — ${spec.item} has not wired this reading's source yet` };
  }
  const { measured, target } = spec.measure(board);
  if (target === 0) {
    return { ...base, status: "unmeasured", measured, target, why: "the board carries nothing for this reading to count, so 0 of 0 is not a pass" };
  }
  if (measured >= target) return { ...base, status: "met", measured, target, why: `${measured} of ${target}` };
  return { ...base, status: "short", measured, target, why: `${measured} of ${target} — ${target - measured} short` };
}

export function takeReadings(board: BoardSnapshot | null): Reading[] {
  return READINGS.map(spec => takeReading(spec, board));
}

/** True when every reading is `met`. Any other status refuses. */
export function conformant(readings: readonly Reading[]): boolean {
  return readings.length > 0 && readings.every(r => r.status === "met");
}

export function formatReading(r: Reading): string {
  const mark = r.status === "met" ? "MET        " : r.status === "short" ? "SHORT      " : "UNMEASURED ";
  return `${mark} ${r.name.padEnd(20)} ${r.why}\n             ${r.what}  [${r.item}]`;
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
    criteriaField: asText(i.criteriaField),
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

  return {
    board: {
      issues: issues as BoardIssue[],
      criteria: criteria as BoardCriterion[],
      phases: phases as BoardPhase[],
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
 */
function produceBoard(flags: Flags): { board: BoardSnapshot | null; error: string | null } {
  const { spec, prefix, repo } = flags;
  if (spec === undefined || prefix === undefined) {
    return { board: null, error: "--produce needs --spec <path> and --prefix <name>" };
  }
  const args = [join(import.meta.dir, "board-snapshot.ts"), spec, "--prefix", prefix];
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
    return {
      board: null,
      error:
        `board-snapshot was killed by ${r.signal ?? "the timeout"} after ${PRODUCE_TIMEOUT_MS}ms. A producer ` +
        `that hangs is UNMEASURED, not a board — an unattended loop cannot observe a wedge.`,
    };
  }
  // Then a spawn that never started — no `bun` on PATH. It sets `error`
  // and leaves status null with both streams empty, so reading only
  // those reports "exit none: no output" for the one failure whose cause
  // is already in hand.
  if (r.error) {
    return { board: null, error: `board-snapshot could not be started: ${r.error.message}` };
  }
  if (r.status !== 0) {
    return {
      board: null,
      error: `board-snapshot refused (exit ${r.status ?? "none"}): ${(r.stderr || r.stdout || "no output").trim()}`,
    };
  }
  const read = readSnapshotText(r.stdout);
  return read.board === null
    ? { board: null, error: `board-snapshot exited 0 and what it emitted is unreadable — ${read.why}` }
    : { board: read.board, error: null };
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

interface Flags {
  listReadings: boolean;
  produce: boolean;
  snapshot?: string;
  snapshotGiven: boolean;
  reading?: string;
  readingGiven: boolean;
  spec?: string;
  prefix?: string;
  repo?: string;
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
    prefix: str(values.prefix),
    repo: str(values.repo),
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

  if (flags.listReadings) {
    for (const r of READINGS) console.log(`${r.name.padEnd(20)} ${r.what}  [${r.item}]`);
    return 0;
  }

  const snapshotPath = flags.snapshot;
  if (flags.snapshotGiven && snapshotPath === undefined) {
    console.error("board-conformance: --snapshot needs a path");
    return REFUSE_EXIT;
  }

  let board: BoardSnapshot | null = null;
  let sourceFailed: string | null = null;
  if (flags.produce) {
    if (flags.snapshotGiven) {
      console.error("board-conformance: --produce and --snapshot are two sources. Pass one.");
      return REFUSE_EXIT;
    }
    const produced = produceBoard(flags);
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

  if (flags.readingGiven) {
    const name = flags.reading;
    const spec = READINGS.find(r => r.name === name);
    if (!spec) {
      // A typo must never read as a pass. This is the first case the
      // mutant has to fail to catch, because it is the one an agent in a
      // loop will hit by writing a reading that does not exist yet.
      console.error(
        `board-conformance: unknown reading "${name ?? ""}". Known readings: ${READING_NAMES.join(", ")}.\n` +
          `Run \`rungate board-conformance --list-readings\` for what each one measures.`,
      );
      return REFUSE_EXIT;
    }
    const reading = takeReading(spec, board);
    console.log(formatReading(reading));
    return reading.status === "met" ? 0 : REFUSE_EXIT;
  }

  const readings = takeReadings(board);
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
