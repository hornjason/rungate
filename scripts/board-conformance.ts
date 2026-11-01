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
import { readFileSync } from "fs";

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
  /** The milestone the issue sits in, or null for none. */
  milestone: string | null;
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

export interface BoardSnapshot {
  issues: BoardIssue[];
  criteria: BoardCriterion[];
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
  /** How many of `target` are conformant, and out of how many. */
  measure: (board: BoardSnapshot) => { measured: number; target: number };
}

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
    what: "every engine issue sits in a milestone",
    measure: b => ({ measured: b.issues.filter(i => (i.milestone ?? "").trim() !== "").length, target: b.issues.length }),
  },
  {
    name: "criterion-coverage",
    item: "B2",
    what: "every engine criterion names an open issue, or is recorded as already true",
    measure: b => ({
      measured: b.criteria.filter(c => c.satisfiedByIssue !== null || c.recordedTrue === true).length,
      target: b.criteria.length,
    }),
  },
  {
    name: "blocked-by-edges",
    item: "B3",
    what: "every engine issue is a declared root or carries a blocked-by edge, so what is next is computed",
    measure: b => ({
      measured: b.issues.filter(i => i.rootReady === true || i.blockedBy.length > 0).length,
      target: b.issues.length,
    }),
  },
  {
    name: "criteria-field",
    item: "B4",
    what: "the board's Criteria column is populated for every engine issue",
    measure: b => ({ measured: b.issues.filter(i => (i.criteriaField ?? "").trim() !== "").length, target: b.issues.length }),
  },
  {
    name: "queue-label",
    item: "B6",
    what: "every engine issue carries the `engine` label, so the queue is the label",
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

function parseSnapshot(path: string): BoardSnapshot | null {
  // A snapshot that is present and unreadable is UNMEASURED, not an empty
  // board — `.claude/rules/config-access.md`. Both end in a refusal here,
  // but only one of them says the file was broken.
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<BoardSnapshot>;
    if (!Array.isArray(raw.issues) || !Array.isArray(raw.criteria)) return null;
    return { issues: raw.issues, criteria: raw.criteria };
  } catch {
    return null;
  }
}

export function main(argv: readonly string[]): number {
  if (argv.includes("--list-readings")) {
    for (const r of READINGS) console.log(`${r.name.padEnd(20)} ${r.what}  [${r.item}]`);
    return 0;
  }

  const snapshotAt = argv.indexOf("--snapshot");
  const snapshotPath = snapshotAt >= 0 ? argv[snapshotAt + 1] : undefined;
  if (snapshotAt >= 0 && (snapshotPath === undefined || snapshotPath.startsWith("--"))) {
    console.error("board-conformance: --snapshot needs a path");
    return REFUSE_EXIT;
  }
  const board = snapshotPath === undefined ? null : parseSnapshot(snapshotPath);
  if (snapshotPath !== undefined && board === null) {
    console.error(`board-conformance: UNMEASURED — ${snapshotPath} is not a readable board snapshot. That is not an empty board.`);
    return REFUSE_EXIT;
  }

  const readingAt = argv.indexOf("--reading");
  if (readingAt >= 0) {
    const name = argv[readingAt + 1];
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
