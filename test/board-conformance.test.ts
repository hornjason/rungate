/**
 * `rungate board-conformance` — the plan's terminal condition, and the
 * proof that it can refuse.
 *
 * Item B5 of the ladder in `project-state.json`. Five of Stage B's six
 * items and the overall goal all run this one command, so a skeleton that
 * exits 0 turns the whole plan green in a single commit. That is the
 * "green on the exit code, witnessing the wrong mechanism" shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`, aimed at the instrument
 * that measures everything else.
 *
 * ## What was broken to prove these can fail
 *
 * Every refusal below runs TWICE on the same planted input: against the
 * real script, and against a mutant copy whose single `REFUSE_EXIT = 1` is
 * rewritten to `0`. Real must refuse, mutant must not. A case that later
 * passes for some unrelated reason is then distinguishable from one that
 * is genuinely catching something — which a one-sided assertion is not.
 *
 * Two properties the mutant depends on are asserted rather than assumed:
 * `REFUSE_EXIT` is assigned exactly once (an inlined `process.exit(1)`
 * elsewhere would survive the mutation and hold a case up), and the script
 * has no relative imports (the mutant runs from a temp directory, and a
 * module-resolution failure exits non-zero and reads as a refusal).
 *
 * And every reading is planted in both directions — a short board AND a
 * complete one — so "it refuses" is never satisfied by a reading that
 * refuses unconditionally.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { spawnSync } from "child_process";
import {
  DEFAULT_PRODUCER,
  OFFENDERS_SHOWN,
  READINGS,
  READING_NAMES,
  REFUSE_EXIT,
  PRODUCE_TIMEOUT_MS,
  conformant,
  formatReading,
  produceBoard,
  readSnapshotText,
  takeReading,
  takeReadings,
  type BoardSnapshot,
  type Flags,
} from "../scripts/board-conformance.ts";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts/board-conformance.ts");
const source = readFileSync(SCRIPT, "utf-8");

let SCRATCH: string;
let MUTANT: string;
/** The mutant's TEXT, so a staged copy can be built from it too. */
let MUTATED: string;

beforeAll(() => {
  SCRATCH = mkdtempSync(join(tmpdir(), "board-conformance-"));
  MUTANT = join(SCRATCH, "mutant-board-conformance.ts");
  MUTATED = source.replace(/REFUSE_EXIT\s*=\s*1\b/, "REFUSE_EXIT = 0");
  if (MUTATED === source) throw new Error("could not build the mutant: no `REFUSE_EXIT = 1` in scripts/board-conformance.ts");
  writeFileSync(MUTANT, MUTATED);
});

/**
 * A copy of the command beside a stand-in producer, in a directory of its
 * own.
 *
 * The producer is reached through `import.meta.dir`, so this is the only
 * way to run the real `--produce` path against a source the case can
 * predict — and, since #1718 made a bare run produce, the only way to run
 * a bare one without reaching the live API from inside the suite.
 *
 * It takes the command's TEXT rather than assuming the real one, so the
 * mutant can be staged against the identical producer. A mutation contrast
 * whose two sides have different producers is not a contrast about the
 * mutation.
 */
const stageAs = (text: string, producer: string): string => {
  const dir = mkdtempSync(join(SCRATCH, "staged-"));
  writeFileSync(join(dir, "board-conformance.ts"), text);
  writeFileSync(join(dir, "board-snapshot.ts"), producer);
  return join(dir, "board-conformance.ts");
};

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const run = (script: string, args: string[], env: Record<string, string> = {}) => {
  // A bound of its own, so a command that WEDGES fails this suite rather
  // than hanging it. A hung run reports no failures at all, which reads
  // like a clean one to anything watching the count.
  const r = spawnSync("bun", [script, ...args], {
    cwd: ROOT,
    encoding: "utf-8",
    env: { ...process.env, ...env },
    timeout: 45_000,
  });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
};

/**
 * Run one input against the real script and the mutant, and assert that
 * the refusal is what the real one is doing.
 *
 * The mutant assertion is the half that matters: without it, a case passes
 * whenever the command exits non-zero for ANY reason — a crash, a bad
 * argument, a module that failed to load — and reads exactly like a
 * refusal on the merits.
 */
const refuses = (args: string[], why: string) => {
  const real = run(SCRIPT, args);
  expect(real.code, `${why}\nexpected a refusal for [${args.join(" ")}], got ${real.code}\n${real.out}${real.err}`).toBe(REFUSE_EXIT);
  const mutant = run(MUTANT, args);
  expect(
    mutant.code,
    `the mutant (REFUSE_EXIT = 0) still exited ${mutant.code} for [${args.join(" ")}] — this case is not ` +
      `witnessing the refusal under test, it is witnessing something else that also exits non-zero.\n${mutant.err}`,
  ).toBe(0);
};

/** A board where every reading is met, which each case then breaks one of. */
const completeBoard = (): BoardSnapshot => ({
  issues: [
    { number: 1, blockedBy: [], rootReady: true, criteriaField: "SC-2618", labels: ["engine"] },
    { number: 2, blockedBy: [1], criteriaField: "SC-2619", labels: ["engine", "bug"] },
  ],
  criteria: [
    { id: "SC-2618", satisfiedByIssue: 1 },
    { id: "SC-2619", satisfiedByIssue: 2 },
    { id: "SC-2620", satisfiedByIssue: null, recordedTrue: true },
  ],
  // Two phases of unequal size, because `milestones` counts CRITERIA and
  // not phases: a fixture with one criterion per phase cannot tell the two
  // denominators apart, and the real board's largest phase holds fourteen.
  phases: [
    { phase: 0, criteria: ["SC-2618", "SC-2619"], milestoneState: "unchanged" },
    { phase: 1, criteria: ["SC-2620"], milestoneState: "unchanged" },
  ],
  // PRESENT and empty — the producer read closed issues and none is named
  // as a blocker. Absent would mean it never looked, which `#1704` makes
  // UNMEASURED; a fixture that omitted it would turn every case in this
  // file into a refusal about the fixture rather than about its subject.
  closedBlockers: [],
  // PRESENT for the same reason as `closedBlockers` above — #1727 moved the
  // queue label out of this file and onto the snapshot, so a fixture that
  // omitted it would make `queue-label` UNMEASURED in every case here and
  // the refusals would be about the fixture rather than their subjects.
  queueLabel: "engine",
  // The three REPOSITORY-WIDE populations — SC-2615, SC-2616, SC-2617.
  // PRESENT for the same reason as the two above.
  specPlacements: [
    { path: "specs/A.md", state: "PLANNED", criteria: 2, placed: 2 },
    { path: "specs/B.md", state: "PLANNED", criteria: 1, placed: 1 },
    // A NO_CRITERIA spec belongs in the COMPLETE board on purpose. It
    // contributes to neither side of `spec-placement`, and a fixture
    // without one could not tell that from a reading that counts it in the
    // denominator — which would make this control short and every case
    // below it a complaint about the fixture.
    { path: "specs/EMPTY.md", state: "NO_CRITERIA", criteria: 0, placed: 0 },
  ],
  // One issue that NAMES, one that DECLARES it serves none. Both are
  // conformant and they are conformant for different reasons, so a reading
  // that credited only one of the two spellings would show up here rather
  // than in whichever case happened to use the other.
  repoIssues: [
    { number: 1, names: ["SC-2618"], servesNone: false },
    { number: 2, names: [], servesNone: true },
  ],
});

/**
 * A CLOSED blocker and a NONEXISTENT one — #1704.
 *
 * `board-snapshot` read open issues only, so `blocked-by-edges` resolved
 * every `blockedBy` number against the open population. A blocker that had
 * been FINISHED was then indistinguishable from a typo: both absent, both
 * counted short. The reading would have flipped MET -> SHORT the first time
 * an engine issue closed — on the event the whole order exists to make
 * happen, and with no change to the board that caused it.
 *
 * The denominator stays open-only: a closed issue is not work. What widens
 * is what an edge may RESOLVE to.
 */
describe("a finished blocker is not a missing one", () => {
  /** Issue 2 blocked by 9, which is closed and off the open population. */
  const withClosedBlocker = (): BoardSnapshot => ({
    ...completeBoard(),
    issues: [
      { number: 1, blockedBy: [], rootReady: true, criteriaField: "SC-2618", labels: ["engine"] },
      { number: 2, blockedBy: [9], criteriaField: "SC-2619", labels: ["engine"] },
    ],
    closedBlockers: [9],
  });

  test("an edge to a CLOSED issue resolves — the reading stays met", () => {
    const at = plant("closed-blocker-met", withClosedBlocker());
    const r = run(SCRIPT, ["--snapshot", at, "--reading", "blocked-by-edges"]);
    expect(r.out, `${r.out}${r.err}`).toContain("MET");
    expect(r.code).toBe(0);
  });

  test("an edge to a number NOBODY has is still short — the two are told apart", () => {
    // The control, and the whole point. Widening by simply trusting every
    // `blockedBy` number would pass the case above and lose the reading.
    const board = withClosedBlocker();
    board.issues[1]!.blockedBy = [404];
    const at = plant("closed-blocker-typo", board);
    const r = run(SCRIPT, ["--snapshot", at, "--reading", "blocked-by-edges"]);
    expect(r.out, "an edge to a number on no list resolved").toContain("SHORT");
    refuses(["--snapshot", at, "--reading", "blocked-by-edges"], "an edge naming nothing at all");
  });

  test("a closed blocker does NOT enter the denominator — it is not work", () => {
    const at = plant("closed-blocker-denominator", withClosedBlocker());
    const r = run(SCRIPT, ["--snapshot", at, "--reading", "blocked-by-edges"]);
    expect(r.out, "the closed issue was counted as an engine issue").toContain("2 of 2");
  });

  test("`closedBlockers` ABSENT on a non-empty board is UNMEASURED, not an empty list", () => {
    // Opposite convention from `satisfiedByIssue`, deliberately, and both
    // resolve toward refusing to claim. An older snapshot that never read
    // closed issues cannot tell a finished blocker from a typo, and
    // treating its silence as "there are none" reproduces #1704 against
    // every file written before this change.
    const board = withClosedBlocker() as unknown as Record<string, unknown>;
    delete board.closedBlockers;
    const at = plant("closed-blockers-unread", board as unknown as BoardSnapshot);
    const r = run(SCRIPT, ["--snapshot", at, "--reading", "blocked-by-edges"]);
    expect(r.out, `${r.out}${r.err}`).toContain("UNMEASURED");
    refuses(["--snapshot", at, "--reading", "blocked-by-edges"], "a board that never read closed issues");
  });

  test("an EMPTY `closedBlockers` is read-and-none, and measures normally", () => {
    // The control for the case above: present-and-empty must not refuse, or
    // the refusal is just "this reading always refuses" and says nothing
    // about whether anybody looked.
    const at = plant("closed-blockers-empty", { ...completeBoard(), closedBlockers: [] });
    const r = run(SCRIPT, ["--snapshot", at, "--reading", "blocked-by-edges"]);
    expect(r.out, `${r.out}${r.err}`).toContain("MET");
    expect(r.code).toBe(0);
  });

  test("the widening touches blocked-by-edges ONLY — criterion-coverage is unmoved", () => {
    // `onBoard` is shared. A criterion pointing at a CLOSED issue is a
    // different claim from an edge pointing at one: "this criterion is
    // covered by open work" is false if the work is finished and the
    // criterion still is not true. Asserting it here stops the cheap fix —
    // widening `onBoard` itself — from passing every case above.
    const board = completeBoard();
    board.closedBlockers = [9];
    board.criteria = [{ id: "SC-2618", satisfiedByIssue: 9 }];
    const at = plant("closed-not-coverage", board);
    const r = run(SCRIPT, ["--snapshot", at, "--reading", "criterion-coverage"]);
    expect(r.out, "a criterion was counted as covered by a CLOSED issue").toContain("SHORT");
  });
});

const plant = (name: string, board: BoardSnapshot): string => {
  const at = join(SCRATCH, `${name}.json`);
  writeFileSync(at, JSON.stringify(board));
  return at;
};

describe("the command's shape", () => {
  test("--list-readings names every reading, and the list is the assertion", () => {
    const r = run(SCRIPT, ["--list-readings"]);
    expect(r.code, `--list-readings refused: ${r.err}`).toBe(0);
    // Asserting the names rather than the exit code: a command that
    // printed nothing and exited 0 would satisfy the exit code alone, and
    // B5's own verify command reads this output.
    for (const name of READING_NAMES) expect(r.out, `--list-readings did not name "${name}"`).toContain(name);
    // Five engine-scoped readings (B1..B4, B6) and three repository-wide
    // ones (E1..E3, added by #1717). The number is asserted as well as the
    // names because `--list-readings` printing a SUBSET would satisfy every
    // `toContain` above — a list can only be checked by its length and its
    // membership together.
    expect(READING_NAMES.length, "the five engine readings plus the two repository-wide ones").toBe(7);
  });

  test("every reading names the ladder item that owns wiring its source", () => {
    // Without this, a reading can exist with nobody on the hook for making
    // it real, which is the "declared and nothing reads it" shape this
    // whole stage exists to close.
    expect(READINGS.map(r => r.item).sort()).toEqual(["B1", "B2", "B3", "B4", "B6", "E1", "E2"]);
  });
});

describe("the refusals, each proved against the mutant", () => {
  test("an unknown reading refuses — a typo must never read as a pass", () => {
    refuses(["--reading", "criterion-covrage"], "a misspelt reading");
    expect(run(SCRIPT, ["--reading", "criterion-covrage"]).err).toContain("unknown reading");
  });

  test("--reading with no name refuses", () => {
    refuses(["--reading"], "a reading flag with nothing after it");
  });

  /**
   * #1718 moved this case, and the move is the point.
   *
   * "No snapshot" used to mean "no board", and the command printed five
   * UNMEASURED rows about readings nobody had asked it to take. It now
   * means "produce one", so the input that cannot be measured is a project
   * whose producer refuses — no `board.engineSpec`, no reachable API — and
   * that is what has to stay UNMEASURED rather than becoming a pass.
   *
   * Both sides are staged copies sharing ONE refusing producer, so the
   * mutation contrast is about the exit constant and not about which of
   * the two found a different way to fail. A bare `run(SCRIPT, [])` would
   * reach the live API from inside the suite, which is a different test
   * and a worse one.
   */
  test("a producer that cannot resolve its inputs is UNMEASURED, not a pass", () => {
    const REFUSING = `process.stderr.write("board-snapshot: --prefix is required, and no \\\`board.milestonePrefix\\\` is set\\n"); process.exit(1);`;
    const real = stageAs(source, REFUSING);
    const mutant = stageAs(MUTATED, REFUSING);
    for (const args of [[], ["--reading", "milestones"]]) {
      const r = run(real, args);
      expect(r.code, `[${args.join(" ")}] did not refuse an unresolvable producer:\n${r.out}${r.err}`).toBe(
        REFUSE_EXIT,
      );
      expect(r.err, "the producer's own reason was dropped").toContain("board.milestonePrefix");
      expect(r.err).toContain("UNMEASURED");
      // The mutation, observed: the SAME input against a copy whose only
      // difference is `REFUSE_EXIT = 0`.
      expect(
        run(mutant, args).code,
        `[${args.join(" ")}] the real script stopped refusing through REFUSE_EXIT`,
      ).not.toBe(REFUSE_EXIT);
    }
  });

  test("a snapshot that is present and unreadable refuses, and says so", () => {
    const broken = join(SCRATCH, "broken.json");
    writeFileSync(broken, "{ not json");
    refuses(["--snapshot", broken], "a corrupt snapshot");
    // A corrupt board is never an empty board —
    // `.claude/rules/config-access.md`. Both refuse; only one says why.
    //
    // And the WHY is asserted, not just the refusal. Four different things
    // make a snapshot unreadable and they used to print one sentence, so a
    // case watching that sentence was watching a signal four mechanisms
    // share. The battery found it: dropping the required-population check
    // left this suite entirely green.
    expect(run(SCRIPT, ["--snapshot", broken]).err).toContain("it is not JSON");
  });

  test("an EMPTY board refuses — 0 of 0 is not a pass", () => {
    // The vacuous-assertion shape, and the one a skeleton falls into
    // first: with no issues and no criteria every ratio is satisfied by
    // counting nothing, and the command would certify the plan complete
    // against a board that does not exist.
    const empty = plant("empty", { issues: [], criteria: [], phases: [] });
    refuses(["--snapshot", empty], "a board with nothing on it");
    expect(run(SCRIPT, ["--snapshot", empty]).out).toContain("UNMEASURED");
  });

  test("a POPULATION the snapshot never mentions refuses the board, by name", () => {
    // An absent array and an empty one are indistinguishable once parsed,
    // and this command calls an empty population UNMEASURED on purpose. A
    // producer that dropped a population would therefore look exactly like
    // one reporting honestly that it has nothing — so the arrays are
    // required, and a snapshot written before a population existed is
    // refused rather than silently read with one reading missing.
    //
    // Field-level absence inside a row is the opposite call, and round 6 is
    // why: see the omitted-satisfiedByIssue case above.
    for (const population of ["issues", "criteria", "phases"]) {
      const board = completeBoard() as unknown as Record<string, unknown>;
      delete board[population];
      const at = plant(`no-${population}`, board as unknown as BoardSnapshot);
      refuses(["--snapshot", at], `a snapshot with no ${population} array`);
      // Named, because the refusal alone is satisfied by the UNMEASURED
      // one an empty population produces — which is what made the first
      // version of this case green with the check removed.
      expect(
        run(SCRIPT, ["--snapshot", at]).err,
        `an absent \`${population}\` array was read as an empty population rather than an unread one`,
      ).toContain(`carries no \`${population}\` array`);
    }
  });

  test("a repeated identity refuses — two rows of one row inflate a denominator nothing can reach", () => {
    // Every reading is a ratio over a population. `onBoard` dedupes issue
    // numbers into a Set, so a duplicated row raises the target without
    // ever raising what can be counted, and the board reports short
    // forever against a number that is wrong rather than unmet.
    const dupes: { population: string; field: string; apply: (b: BoardSnapshot) => void }[] = [
      { population: "issues", field: "number", apply: b => void (b.issues[1]!.number = b.issues[0]!.number) },
      { population: "criteria", field: "id", apply: b => void (b.criteria[1]!.id = b.criteria[0]!.id) },
      { population: "phases", field: "phase", apply: b => void (b.phases[1]!.phase = b.phases[0]!.phase) },
    ];
    for (const d of dupes) {
      const board = completeBoard();
      d.apply(board);
      const at = plant(`dupe-${d.population}-${d.field}`, board);
      refuses(["--snapshot", at], `a board with a repeated ${d.population}.${d.field}`);
      expect(
        run(SCRIPT, ["--snapshot", at]).err,
        `a repeated ${d.population}.${d.field} was read as a longer board`,
      ).toContain(`\`${d.population}\` repeats an identity`);
    }
  });

  test("a milestoneState the producer does not emit refuses, rather than counting as not-unchanged", () => {
    // `unchanged` is the only conformant value, so a fifth verdict — a
    // typo, a producer inventing one — lands in the `!== "unchanged"`
    // bucket and reads as an honest SHORT. That is a board nobody read
    // reported as a board that is behind, which are different facts.
    const board = completeBoard() as unknown as { phases: Record<string, unknown>[] };
    board.phases[1]!.milestoneState = "unchangd";
    const at = plant("bad-milestone-state", board as unknown as BoardSnapshot);
    refuses(["--snapshot", at], "a phase carrying an unknown milestoneState");
    expect(run(SCRIPT, ["--snapshot", at]).err).toContain("`phases`[1] has no usable identity");
  });

  test("a criterion that OMITS satisfiedByIssue refuses — undefined is not a covered criterion", () => {
    // Review of #1697. `undefined !== null` is true, so a generator relying
    // on ordinary object omission rather than an explicit null would have
    // had every uncovered criterion counted as covered — this command's own
    // failure mode inverted, a reading reporting met on data it never saw.
    const board = completeBoard() as unknown as { criteria: Record<string, unknown>[] };
    delete board.criteria[0]!.satisfiedByIssue;
    const at = plant("omitted-field", board as unknown as BoardSnapshot);
    refuses(["--snapshot", at, "--reading", "criterion-coverage"], "a criterion with no satisfiedByIssue key");

    // And it refuses through THIS reading, not through the parser.
    //
    // Round 6 caught the first version of this: the boundary rejected the
    // whole snapshot over the absent key, so the refusal above was the
    // shape check and every other reading went UNMEASURED too — two
    // mechanisms behind one exit code, and the wrong one winning. The
    // boundary now normalises an absent optional field, so the output has
    // to show criterion-coverage SHORT with the rest untouched.
    const whole = run(SCRIPT, ["--snapshot", at]);
    expect(whole.out, "the absent key made the whole board unreadable rather than one reading short").not.toContain(
      "UNMEASURED",
    );
    expect(whole.out).toContain("SHORT       criterion-coverage");
    expect(whole.out.match(/^MET /gm)?.length, "an absent satisfiedByIssue moved a reading it has nothing to do with").toBe(READING_NAMES.length - 1);

    const spec = READINGS.find(r => r.name === "criterion-coverage")!;
    const reading = takeReading(spec, board as unknown as BoardSnapshot);
    expect(reading.status, "an omitted satisfiedByIssue counted as a covered criterion").toBe("short");
    expect(reading.measured).toBe(2);
  });

  test("a criterion pointing at an issue that is not on the board refuses — a pointer to nothing is not coverage", () => {
    // Review of #1697, round 2. `typeof === "number"` distinguishes null
    // from omitted and still says nothing about whether the issue exists:
    // a stale reference, a typo or a renumbered issue counted as covered.
    // The same defect one level deeper than round 1's.
    const board = completeBoard();
    board.criteria[1]!.satisfiedByIssue = 9999;
    const at = plant("dangling-ref", board);
    refuses(["--snapshot", at, "--reading", "criterion-coverage"], "a criterion naming an absent issue");

    const spec = READINGS.find(r => r.name === "criterion-coverage")!;
    const reading = takeReading(spec, board);
    expect(reading.status, "a criterion naming issue 9999 counted as covered").toBe("short");
    expect(reading.measured).toBe(2);
  });

  test("an absent field never throws, and only an absent IDENTITY field refuses the whole board", () => {
    // Rounds 1 and 6. `i.blockedBy.length` and `i.labels.includes(...)`
    // assume a present array, so a hand-written fixture or a half-wired
    // source omitting one used to die on a TypeError — a stack trace where
    // the contract says UNMEASURED. Then the first repair went too far the
    // other way and rejected the whole snapshot over any absent key, which
    // turned four unrelated readings UNMEASURED and hid which field was
    // missing.
    //
    // The line now: an optional field degrades ITS OWN reading, and only
    // `number` — what a blocked-by edge resolves against — makes the board
    // unread. Both directions are asserted, so neither repair can come
    // back.
    //
    // `to` differs by field, and that is the point rather than an
    // inconsistency. Omitting `blockedBy` or `labels` is a row the producer
    // read and found empty, which is a measurement — SHORT. Omitting
    // `criteriaField` is a column nothing queried, which is not — see the
    // B4 describe below. What every row shares is the property this case is
    // really about: EXACTLY ONE reading moves, and the other four stay met.
    const degrades: {
      row: "issues" | "phases";
      at: number;
      field: string;
      reading: string;
      to: "SHORT      " | "UNMEASURED ";
    }[] = [
      { row: "issues", at: 1, field: "blockedBy", reading: "blocked-by-edges", to: "SHORT      " },
      { row: "issues", at: 1, field: "labels", reading: "queue-label", to: "SHORT      " },
      { row: "issues", at: 1, field: "criteriaField", reading: "criteria-field", to: "UNMEASURED " },
      { row: "phases", at: 1, field: "milestoneState", reading: "milestones", to: "SHORT      " },
    ];
    for (const { row, at: index, field, reading, to } of degrades) {
      const board = completeBoard() as unknown as Record<string, Record<string, unknown>[]>;
      delete board[row]![index]![field];
      const at = plant(`missing-${field}`, board as unknown as BoardSnapshot);
      const r = run(SCRIPT, ["--snapshot", at]);
      expect(r.err, `omitting ${field} threw`).not.toContain("TypeError");
      expect(r.out, `omitting ${field} did not move ${reading}`).toContain(`${to} ${reading}`);
      expect(
        (r.out.match(/^(SHORT|UNMEASURED) /gm) ?? []).length,
        `omitting ${field} moved a reading other than ${reading}`,
      ).toBe(1);
      refuses(["--snapshot", at], `a board short on ${reading}`);
    }

    // And every identity field, not just the issue's. All three rows carry
    // one, all three are what a ratio's denominator is counted over, and
    // repairing them one at a time is what rounds 1, 2 and 5 of #1697 were.
    const identities: { row: "issues" | "criteria" | "phases"; field: string }[] = [
      { row: "issues", field: "number" },
      { row: "criteria", field: "id" },
      { row: "phases", field: "phase" },
    ];
    for (const { row, field } of identities) {
      const board = completeBoard() as unknown as Record<string, Record<string, unknown>[]>;
      delete board[row]![0]![field];
      const at = plant(`missing-${row}-${field}`, board as unknown as BoardSnapshot);
      refuses(["--snapshot", at], `a ${row} row with no ${field}`);
      expect(
        run(SCRIPT, ["--snapshot", at]).err,
        `an unidentifiable ${row} row did not refuse the board`,
      ).toContain(`\`${row}\`[0] has no usable identity`);
    }
  });

  test("a complete board passes — the control, without which every case above is vacuous", () => {
    const at = plant("complete", completeBoard());
    const r = run(SCRIPT, ["--snapshot", at]);
    expect(r.code, `a board meeting every reading was refused:\n${r.out}${r.err}`).toBe(0);
    expect(r.out).toContain("every reading is met");
    expect(r.out).not.toContain("UNMEASURED");
  });
});

describe("each reading, planted short and planted complete", () => {
  /**
   * One case per reading, breaking exactly that reading in a board that is
   * otherwise complete. The control above is what makes these mean
   * something: the same board, one field different.
   */
  const breaks: { reading: string; what: string; break: (b: BoardSnapshot) => void }[] = [
    { reading: "milestones", what: "a phase whose milestone the board does not carry", break: b => void (b.phases[1]!.milestoneState = "create") },
    { reading: "criterion-coverage", what: "a criterion naming no issue and not recorded true", break: b => void (b.criteria[2]!.recordedTrue = false) },
    { reading: "blocked-by-edges", what: "an issue that is neither a declared root nor blocked", break: b => void (b.issues[1]!.blockedBy = []) },
    { reading: "criteria-field", what: "an issue whose Criteria column is blank", break: b => void (b.issues[0]!.criteriaField = "  ") },
    { reading: "queue-label", what: "an issue missing the engine label", break: b => void (b.issues[1]!.labels = ["bug"]) },
    // The three repository-wide readings, broken in their own populations —
    // never in `issues`, `criteria` or `phases`. A break that reached into
    // the engine populations would redden an engine reading too, and the
    // whole-board assertion below cannot tell which reading refused.
    {
      reading: "spec-placement",
      what: "a spec whose criteria sit in no phase",
      break: b => {
        b.specPlacements![0]!.state = "UNPLANNED";
        b.specPlacements![0]!.placed = 0;
      },
    },
    {
      reading: "criteria-named",
      what: "an issue that names no criterion and does not declare that it serves none",
      break: b => void (b.repoIssues![1]!.servesNone = false),
    },
  ];

  test("the break list covers every reading, so none is silently untested", () => {
    expect(breaks.map(b => b.reading).sort()).toEqual([...READING_NAMES].sort());
  });

  for (const b of breaks) {
    test(`${b.reading}: refuses on ${b.what}, and is met without it`, () => {
      const broken = completeBoard();
      b.break(broken);
      const shortAt = plant(`short-${b.reading}`, broken);

      refuses(["--snapshot", shortAt, "--reading", b.reading], `${b.reading} with ${b.what}`);
      expect(run(SCRIPT, ["--snapshot", shortAt, "--reading", b.reading]).out).toContain("SHORT");

      // The whole-board run must refuse too: one short reading is enough.
      refuses(["--snapshot", shortAt], `the whole board with ${b.what}`);

      // And the same reading on the unbroken board must pass, or the case
      // above is satisfied by a reading that refuses no matter what.
      const okAt = plant(`ok-${b.reading}`, completeBoard());
      const ok = run(SCRIPT, ["--snapshot", okAt, "--reading", b.reading]);
      expect(ok.code, `${b.reading} refused a board it should accept:\n${ok.out}${ok.err}`).toBe(0);
      expect(ok.out).toContain("MET");
    });
  }

  test("EVERY reading that resolves an issue number refuses a dangling one — the sweep, not one more case", () => {
    // Rounds 1, 2 and 5 of #1697 found the same hole three times, one
    // reading at a time: a pointer counted without being resolved. The
    // reviewer's point was that a per-reading repair guarantees a sixth
    // round, and that is right. So this is a battery over all five.
    //
    // It predicts MEMBERSHIP rather than a total, because "it did not
    // move" is ambiguous: a reading that reads a reference and fails to
    // validate it stays `met` under this board, exactly like a reading
    // that holds no references at all. `readsIssueRefs` is the
    // declaration that tells those two apart, and the first assertion
    // pins it so a new reading cannot quietly join the wrong group.
    expect(
      READINGS.filter(r => r.readsIssueRefs).map(r => r.name).sort(),
      "a reading's readsIssueRefs declaration moved. If a new reading resolves an issue number it must set " +
        "the flag AND validate the reference against the board — see the rounds this battery replaced.",
    ).toEqual(["blocked-by-edges", "criterion-coverage"]);

    // Every row carries a reference, and every reference names nothing.
    //
    // Written this way after the first version went green WITHOUT the fix.
    // It had mapped over the existing edges, so the one issue whose
    // `blockedBy` was already empty went short on the empty array rather
    // than on the dangling pointer — the reading moved, for a reason that
    // had nothing to do with what the case is about. Every row now holds a
    // reference, so the OLD predicates (`length > 0`, `typeof number`)
    // count all of them and report `met`, and only resolving the pointer
    // makes this go short.
    const dangling = completeBoard();
    for (const c of dangling.criteria) {
      c.satisfiedByIssue = 9999;
      delete c.recordedTrue; // or "already true" satisfies it without the pointer
    }
    for (const i of dangling.issues) {
      i.blockedBy = [9999];
      delete i.rootReady; // or a declared root satisfies it without the edge
    }
    // A row whose references are PARTLY stale, which the all-9999 board
    // above cannot produce. Round 7 found the gap it left: the battery
    // varied which reading it looked at and held the input shape fixed at
    // "every reference dangling", so a measure satisfied by one surviving
    // edge passed all of it. Named as the thing every other row holds
    // constant, which is the only way that shape gets found.
    const mixed = completeBoard();
    for (const i of mixed.issues) {
      i.blockedBy = [...i.blockedBy, 9999];
      delete i.rootReady;
    }
    mixed.issues[0]!.blockedBy = [mixed.issues[1]!.number, 9999];
    const mixedEdges = takeReading(READINGS.find(r => r.name === "blocked-by-edges")!, mixed);
    expect(
      mixedEdges.status,
      "an issue blocked by one real edge and one stale one reported met. A graph with an edge naming " +
        "nothing never surfaces that issue as next, so one surviving edge is not a computed graph.",
    ).toBe("short");

    const complete = completeBoard();
    for (const spec of READINGS) {
      const under = takeReading(spec, dangling);
      const control = takeReading(spec, complete);
      if (spec.readsIssueRefs) {
        expect(
          under.status,
          `${spec.name} declares it resolves issue numbers and still reports ${under.status} when every ` +
            `reference on the board names nothing. A pointer to nothing is not coverage.`,
        ).toBe("short");
      }
      // The control is what stops the loop above being satisfied by a
      // reading that refuses whatever it is handed.
      if (!spec.readsIssueRefs) {
        expect(control.status, `${spec.name} refused a complete board`).toBe("met");
      }
    }
  });

  test("ONE short reading refuses the whole board even while every other one is met", () => {
    const broken = completeBoard();
    broken.issues[1]!.labels = ["bug"];
    const readings = takeReadings(broken);
    // Membership, not a count: the point is that exactly ONE reading moved
    // and it is `queue-label`. A count would stay right if a second
    // reading went short for an unrelated reason in the same board.
    expect(readings.filter(r => r.status === "met").map(r => r.name).sort()).toEqual(
      [
        "blocked-by-edges",
        "criteria-field",
        "criteria-named",
        "criterion-coverage",
        "milestones",
        "spec-placement",
      ],
    );
    expect(conformant(readings), "six of seven met read as conformant").toBe(false);
  });
});

describe("the milestones reading (B1)", () => {
  /**
   * The reading B1 replaced was *every engine issue sits in a milestone*,
   * and it could not fail. "Engine issue" is not written down anywhere —
   * zero issues carried the `engine` label on 2026-11-01 — so the only way
   * to enumerate the population is to ask which issues sit in a Pipeline
   * Phase milestone, and that population is 100% in a milestone by
   * construction. The cases below are about the population that can fail.
   */
  const milestones = () => READINGS.find(r => r.name === "milestones")!;

  test("it counts CRITERIA, not phases — a big phase with no milestone is not one phase short", () => {
    const board = completeBoard();
    board.phases[0]!.milestoneState = "create"; // the two-criterion phase
    const r = takeReading(milestones(), board);
    expect(r.target, "the denominator is phases, so a phase holding fourteen criteria counts as one").toBe(3);
    expect(r.measured, "the numerator is phases too — the two criteria with no home were not counted").toBe(1);
  });

  test("DRIFT is short, not met — rename and update are a board saying what the spec does not", () => {
    // `create` is the obvious one and the cheapest fix would have tested
    // only that. `rename` is a milestone whose title no longer matches the
    // spec's phase heading and `update` is one whose criteria list has
    // drifted; both are a live milestone that exists, which is exactly the
    // shape a `!== "create"` predicate would wave through.
    for (const state of ["create", "rename", "update"] as const) {
      const board = completeBoard();
      board.phases[1]!.milestoneState = state;
      expect(takeReading(milestones(), board).status, `milestoneState "${state}" was counted as conformant`).toBe(
        "short",
      );
    }
    const ok = completeBoard();
    expect(takeReading(milestones(), ok).status, "`unchanged` everywhere was not met — the control").toBe("met");
  });

  test("a board with no phases is unmeasured, not met", () => {
    const board = completeBoard();
    board.phases = [];
    expect(takeReading(milestones(), board).status).toBe("unmeasured");
  });
});

describe("every field the snapshot declares is read by something", () => {
  /**
   * The defect this whole stage exists to close is *declared and nothing
   * reads it* — a field, a column or a document that looks like state and
   * is inert. B1 found one here: `BoardIssue.milestone` existed only to
   * feed the circular reading above, and after that reading moved to the
   * phase population nothing would have read it.
   *
   * So rather than deleting that one field, the property is asserted for
   * the whole population: every field of every snapshot row has to change
   * what this command reports. The field list is scanned out of the
   * interfaces, so adding a field to one and not perturbing it here fails
   * the first case rather than going unnoticed.
   */
  const fieldsOf = (iface: string): string[] => {
    const block = source.match(new RegExp(String.raw`export interface ${iface} \{([\s\S]*?)\n\}`));
    if (!block) throw new Error(`no interface ${iface} in scripts/board-conformance.ts`);
    return [...block[1]!.matchAll(/^ {2}(\w+)\??:/gm)].map(m => m[1]!);
  };

  type Perturbation = { field: string; effect: "reading" | "unreadable"; apply: (b: BoardSnapshot) => void };
  const perturbations: Perturbation[] = [
    // Identity fields: repeated, not removed. A repeat is the case a
    // removal cannot make — the row still parses and the denominator is
    // the thing that moves.
    { field: "BoardIssue.number", effect: "unreadable", apply: b => void (b.issues[1]!.number = b.issues[0]!.number) },
    { field: "BoardCriterion.id", effect: "unreadable", apply: b => void (b.criteria[1]!.id = b.criteria[0]!.id) },
    { field: "BoardPhase.phase", effect: "unreadable", apply: b => void (b.phases[1]!.phase = b.phases[0]!.phase) },

    { field: "BoardIssue.blockedBy", effect: "reading", apply: b => void (b.issues[1]!.blockedBy = []) },
    { field: "BoardIssue.rootReady", effect: "reading", apply: b => void (b.issues[0]!.rootReady = false) },
    { field: "BoardIssue.criteriaField", effect: "reading", apply: b => void (b.issues[0]!.criteriaField = "  ") },
    { field: "BoardIssue.labels", effect: "reading", apply: b => void (b.issues[1]!.labels = ["bug"]) },
    { field: "BoardCriterion.satisfiedByIssue", effect: "reading", apply: b => void (b.criteria[0]!.satisfiedByIssue = null) },
    { field: "BoardCriterion.recordedTrue", effect: "reading", apply: b => void (b.criteria[2]!.recordedTrue = false) },
    { field: "BoardPhase.criteria", effect: "reading", apply: b => void (b.phases[1]!.criteria = [...b.phases[1]!.criteria, "SC-9999"]) },
    { field: "BoardPhase.milestoneState", effect: "reading", apply: b => void (b.phases[1]!.milestoneState = "create") },
  ];

  test("the perturbation list is exactly the declared fields — a new field cannot slip in inert", () => {
    const declared = ["BoardIssue", "BoardCriterion", "BoardPhase"].flatMap(i =>
      fieldsOf(i).map(f => `${i}.${f}`),
    );
    expect(
      perturbations.map(p => p.field).sort(),
      "a snapshot field has no perturbation below, so nothing here proves any reading looks at it. Add a row " +
        "that moves a reading — or delete the field, which is what B1 did to BoardIssue.milestone.",
    ).toEqual(declared.sort());
  });

  /**
   * The census above enumerates the ROW interfaces and stops there, and
   * that is the gap #1727 shipped through: `queueLabel` was declared on
   * `BoardSnapshot`, written by the producer, and silently dropped.
   *
   * `readSnapshotText` rebuilds the board from a NAMED list of fields
   * rather than spreading `raw`, so a field nobody adds to that list does
   * not survive the parse — on `--snapshot` and `--produce` alike. The
   * reading then reports UNMEASURED against a snapshot carrying exactly
   * what it asked for, which reads as the producer's fault.
   *
   * Stated over the whole population rather than repaired one field at a
   * time: a top-level field that cannot survive a round trip is inert, and
   * the next one added will be inert in the same way.
   */
  test("a padded queueLabel is normalised at the parse, not trusted into the measure", () => {
    // Review of #1727. `unreadable` tested `trim() !== ""` and `measure`
    // then filtered on the RAW value, so `" engine "` cleared the gate and
    // searched issue labels for a string no GitHub label can equal: the
    // reading said 0 of N, a confident wrong number, where the right count
    // belonged. Two guards over one value that disagreed about its shape.
    const padded = { ...completeBoard(), queueLabel: "  engine  " } as unknown as BoardSnapshot;
    const read = readSnapshotText(JSON.stringify(padded));
    expect(read.board?.queueLabel, "the padding reached the snapshot").toBe("engine");

    // The reading itself, because the field being trimmed is not the claim
    // — the claim is that the COUNT is right.
    //
    // Both assertions below are needed and the SECOND is the stronger one,
    // measured rather than assumed: mutating `measure` to re-pad the label
    // leaves the comparison GREEN, because it breaks the padded board and
    // the clean one identically. Only the control sees it, by insisting the
    // clean board counts something. A comparison between two boards cannot
    // catch a defect that moves both.
    const q = takeReadings(read.board!).find(r => r.name === "queue-label")!;
    const clean = takeReadings(completeBoard()).find(r => r.name === "queue-label")!;
    expect(
      `${q.status}:${q.measured}/${q.target}`,
      "a padded label measured differently from an unpadded one",
    ).toBe(`${clean.status}:${clean.measured}/${clean.target}`);
    expect(clean.measured, "the clean board matched NO label, so the comparison above is vacuous")
      .toBeGreaterThan(0);
  });

  test("every top-level snapshot field SURVIVES the parse — a named rebuild drops what nobody lists", () => {
    const complete = completeBoard() as unknown as Record<string, unknown>;
    const declared = fieldsOf("BoardSnapshot");

    // The fixture is the premise. A field the complete board omits cannot
    // be observed surviving or being dropped, so an incomplete fixture
    // would make this case vacuous about exactly the field it is for.
    expect(
      declared.filter(f => !(f in complete)),
      "completeBoard() omits a declared snapshot field, so this case cannot observe whether the parse keeps it",
    ).toEqual([]);

    const read = readSnapshotText(JSON.stringify(complete));
    expect(read.board, `a complete board did not parse: ${read.why}`).not.toBeNull();
    expect(
      declared.filter(f => !(f in (read.board as unknown as Record<string, unknown>))),
      "a field the snapshot declares did not survive readSnapshotText. It rebuilds from a named list — add the " +
        "field there, present-only if its ABSENCE is a signal the way closedBlockers and queueLabel are.",
    ).toEqual([]);
  });

  for (const p of perturbations) {
    test(`${p.field} changes what the command reports`, () => {
      const board = completeBoard();
      p.apply(board);
      if (p.effect === "unreadable") {
        expect(
          readSnapshotText(JSON.stringify(board)).board,
          `a repeated ${p.field} parsed as a valid board, so the identity it carries decides nothing`,
        ).toBeNull();
        return;
      }
      const before = takeReadings(completeBoard()).map(r => `${r.name}:${r.status}:${r.measured}/${r.target}`);
      const after = takeReadings(board).map(r => `${r.name}:${r.status}:${r.measured}/${r.target}`);
      expect(
        after,
        `perturbing ${p.field} changed no reading's status, numerator or denominator. The field is declared ` +
          `and nothing reads it — the exact shape Stage B exists to close.`,
      ).not.toEqual(before);
    });
  }
});

describe("a repeat inside a LIST, not just a repeated row", () => {
  /**
   * Round 2 of this PR, and the same defect one level down from the row
   * identities: `milestones` sums `phases[].criteria`, so one criterion
   * listed in two phases raises the target while only one of the two can
   * ever be credited. The row-level sweep did not reach it because it
   * asked which ROWS carry an identity, not which LISTS a measure counts.
   *
   * So the rule is stated over the whole population of list-valued
   * fields, with the membership predicted rather than described: a list
   * whose repeat moves a reading must be refused, and a list whose repeat
   * moves nothing must not be — refusing a board over a duplicate that
   * changes no reading is a refusal nobody can act on.
   */
  const lists: { field: string; apply: (b: BoardSnapshot) => void }[] = [
    { field: "phases[].criteria (within one phase)", apply: b => void (b.phases[0]!.criteria = [...b.phases[0]!.criteria, b.phases[0]!.criteria[0]!]) },
    { field: "phases[].criteria (across two phases)", apply: b => void (b.phases[1]!.criteria = [...b.phases[1]!.criteria, b.phases[0]!.criteria[0]!]) },
    { field: "issues[].blockedBy", apply: b => void (b.issues[1]!.blockedBy = [...b.issues[1]!.blockedBy, b.issues[1]!.blockedBy[0]!]) },
    { field: "issues[].labels", apply: b => void (b.issues[1]!.labels = [...b.issues[1]!.labels, b.issues[1]!.labels[0]!]) },
  ];

  const triple = (b: BoardSnapshot) => takeReadings(b).map(r => `${r.name}:${r.status}:${r.measured}/${r.target}`);

  for (const l of lists) {
    test(`a repeat in ${l.field} is refused exactly when it moves a reading`, () => {
      const board = completeBoard();
      l.apply(board);
      const moves = JSON.stringify(triple(board)) !== JSON.stringify(triple(completeBoard()));
      const read = readSnapshotText(JSON.stringify(board));
      expect(
        read.board === null,
        moves
          ? `a repeat in ${l.field} changes a reading's numbers and the board was still read — the denominator ` +
            `counts one entry twice and nothing can ever reach it`
          : `a repeat in ${l.field} changes no reading and the board was refused — a refusal nobody can act on`,
      ).toBe(moves);
      if (moves) expect(read.why).toContain("repeats an identity");
    });
  }

  test("at least one list is in each group, so neither arm above is vacuous", () => {
    const moved = lists.filter(l => {
      const b = completeBoard();
      l.apply(b);
      return JSON.stringify(triple(b)) !== JSON.stringify(triple(completeBoard()));
    });
    expect(moved.length, "no list's repeat moves a reading, so the refusing arm witnessed nothing").toBeGreaterThan(0);
    expect(
      moved.length,
      "every list's repeat moves a reading, so the tolerated arm witnessed nothing",
    ).toBeLessThan(lists.length);
  });
});

describe("--produce: the spawned source", () => {
  /**
   * The producer is reached by PATH, not by import, so a copy of the
   * command in a directory holding a stand-in `board-snapshot.ts` is the
   * real `--produce` path with a source it can predict.
   *
   * Round 1 of this PR: `produceBoard` had no coverage at all, so dropping
   * the `--repo` forward or inverting the exit-code test would have
   * shipped with every case above green. The stand-in exists to make those
   * two mutations visible, which is why it ECHOES its argv rather than
   * just printing a snapshot.
   */
  const stage = (producer: string): { command: string; argvAt: string } => {
    const command = stageAs(source, producer);
    return { command, argvAt: join(dirname(command), "argv.json") };
  };

  /**
   * Records the argv it was handed, then prints a board meeting every
   * reading.
   *
   * It writes argv to a FILE rather than to stderr: `produceBoard`
   * captures the child's stderr and keeps it only on a refusal, so an
   * echo there is invisible on the path this case is about.
   */
  const ECHOING_PRODUCER = `
import { writeFileSync } from "fs";
import { join } from "path";
writeFileSync(join(import.meta.dir, "argv.json"), JSON.stringify(process.argv.slice(2)));
process.stdout.write(${JSON.stringify(JSON.stringify(completeBoard()))});
`;

  test("it forwards --spec, --prefix and --repo to the producer", () => {
    const { command, argvAt } = stage(ECHOING_PRODUCER);
    const r = run(command, ["--produce", "--spec", "specs/X.md", "--prefix", "Pipeline", "--repo", "o/n"]);
    expect(r.code, `--produce refused a board every reading meets:\n${r.out}${r.err}`).toBe(0);
    expect(
      JSON.parse(readFileSync(argvAt, "utf-8")) as string[],
      "an argument the caller gave was not forwarded, so the producer read a different board than it was asked for",
    ).toEqual(["specs/X.md", "--prefix", "Pipeline", "--repo", "o/n"]);
    expect(r.out).toContain("every reading is met");
  });

  test("--repo is optional, and omitting it forwards nothing in its place", () => {
    const { command, argvAt } = stage(ECHOING_PRODUCER);
    const r = run(command, ["--produce", "--spec", "specs/X.md", "--prefix", "Pipeline"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(argvAt, "utf-8"))).toEqual(["specs/X.md", "--prefix", "Pipeline"]);
  });

  test("a producer that refuses makes the command UNMEASURED, and its reason is carried through", () => {
    const { command } = stage(`process.stderr.write("UNMEASURED — the API said 502\\n"); process.exit(3);`);
    const r = run(command, ["--produce", "--spec", "specs/X.md", "--prefix", "Pipeline"]);
    expect(r.code, "a producer that refused was read as a board").not.toBe(0);
    expect(r.err).toContain("board-snapshot refused (exit 3)");
    expect(r.err, "the producer's own reason was dropped, so the refusal says nothing actionable").toContain(
      "the API said 502",
    );
  });

  test("a producer that exits 0 with unreadable output is UNMEASURED, not an empty board", () => {
    const { command } = stage(`process.stdout.write("not a snapshot");`);
    const r = run(command, ["--produce", "--spec", "specs/X.md", "--prefix", "Pipeline"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("exited 0 and what it emitted is unreadable");
    expect(r.err, "the parse failure's own reason was not carried").toContain("it is not JSON");
  });

  test("--produce and --snapshot together refuse — two sources is a question, not a default", () => {
    const { command } = stage(ECHOING_PRODUCER);
    const planted = plant("two-sources", completeBoard());
    const r = run(command, ["--produce", "--spec", "specs/X.md", "--prefix", "Pipeline", "--snapshot", planted]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("two sources");
  });

  test("--produce with an EMPTY value on ANY forwarded flag refuses, and never spawns", () => {
    // The empty rows are round 1 of #1703, swept here because this command
    // is the third member of that population: an empty `--prefix ""` used
    // to reach the producer, which refuses it — so the reader reported the
    // CHILD's refusal for an argument it was handed itself, and the reader
    // of that message goes looking at the spec file.
    //
    // **The two MISSING rows left this list in #1718 and are the test
    // below.** Blank and absent used to be one case; they carry opposite
    // instructions. A typed empty is a mistake to name. An omitted flag
    // says nothing at all, and reaching past it to `board.engineSpec` /
    // `board.milestonePrefix` is how the bare command takes its own
    // reading.
    // **EVERY FORWARDED FLAG, derived from the list rather than written
    // out.** Round 1 of #1890: the first version of this case named
    // `--spec` and `--prefix` and left out `--repo`, which is the third
    // input the same change added — and `--repo ""` fell through to this
    // checkout's own origin, taking a live reading against a repository
    // the caller never named. A list that enumerates the flags is short by
    // one visibly; three hand-written rows are not.
    const FORWARDED = ["--spec", "--prefix", "--repo"] as const;
    const COMPLETE: Record<string, string> = {
      "--spec": "specs/X.md",
      "--prefix": "Pipeline",
      "--repo": "o/n",
    };
    const cases: string[][] = [];
    for (const flag of FORWARDED) {
      for (const empty of ["", "   "]) {
        // Every OTHER flag at a good value, so the refusal can only be
        // about the blank one.
        const argv = ["--produce"];
        for (const f of FORWARDED) argv.push(f, f === flag ? empty : COMPLETE[f]);
        cases.push(argv);
      }
    }
    for (const argv of cases) {
      // A producer that would CRASH if reached, so the refusal is proved
      // to have happened before the spawn rather than after it.
      const { command } = stage(`throw new Error("the producer was spawned without the arguments it needs");`);
      const r = run(command, argv);
      expect(r.code, `[${argv.join(" ")}] did not refuse`).not.toBe(0);
      expect(r.err).toContain("was given with no usable value");
      expect(r.err, `[${argv.join(" ")}] spawned the producer anyway`).not.toContain("the producer was spawned");
    }
  });

  /**
   * Covers SC-2618, SC-2619 (SPEC-TO-BOARD-PIPELINE-SPEC.md) — #1718.
   *
   * `rungate board-conformance` with no source at all used to fall through
   * with a null board and print five UNMEASURED rows saying `B1 has not
   * wired this reading's source yet`. It exited 1, so the terminal
   * condition was right; the DIAGNOSIS was invented, and a reader acts on
   * the reason rather than the exit code.
   */
  test("with NO source flag at all it produces, rather than reporting five readings it never took", () => {
    const { command, argvAt } = stage(ECHOING_PRODUCER);
    const r = run(command, []);
    expect(r.code, `a bare run refused a board every reading meets:\n${r.out}${r.err}`).toBe(0);
    expect(r.out).toContain("every reading is met");
    // The producer was reached with NOTHING forwarded, which is what lets
    // it resolve the spec, the prefix and the repository from the project.
    expect(JSON.parse(readFileSync(argvAt, "utf-8")), "the bare run forwarded arguments nobody gave").toEqual([]);
    // And the sentence that used to be printed instead is gone.
    expect(r.out, "it still claims a reading's source is unwired").not.toContain("has not wired this reading");
  });

  test("an omitted --spec or --prefix under --produce forwards nothing in its place, and still spawns", () => {
    for (const [argv, forwarded] of [
      [["--produce", "--prefix", "Pipeline"], ["--prefix", "Pipeline"]],
      [["--produce", "--spec", "specs/X.md"], ["specs/X.md"]],
      [["--produce"], []],
    ] as [string[], string[]][]) {
      const { command, argvAt } = stage(ECHOING_PRODUCER);
      const r = run(command, argv);
      expect(r.code, `[${argv.join(" ")}] refused instead of letting the producer resolve the rest`).toBe(0);
      expect(
        JSON.parse(readFileSync(argvAt, "utf-8")),
        `[${argv.join(" ")}] forwarded something the caller never gave`,
      ).toEqual(forwarded);
    }
  });

  test("--snapshot alone is still read as a snapshot, and is not quietly produced over", () => {
    // The guard that makes the bare case produce is `!flags.snapshotGiven`.
    // If it were written as `!flags.produce` the snapshot path would never
    // run again, and every `--snapshot` case in this file would pass
    // anyway — they assert on readings, and the staged producer emits a
    // board meeting all of them. So the discriminator is the producer
    // CRASHING: reached at all, this case is red.
    const { command } = stage(`throw new Error("the producer was spawned over an explicit --snapshot");`);
    const planted = plant("snapshot-wins", completeBoard());
    const r = run(command, ["--snapshot", planted]);
    expect(r.code, `--snapshot alone refused:\n${r.out}${r.err}`).toBe(0);
    expect(r.err, "--snapshot was overridden by an implicit produce").not.toContain("the producer was spawned");
    expect(r.out).toContain("every reading is met");
  });

  test("a producer that hangs is killed and reported, not waited on", () => {
    // Every other failure mode here becomes a crisp refusal; a wedge was
    // the one that did not, and an unattended loop cannot observe a wedge
    // — it just stops. The producer below never exits.
    const { command } = stage(`await new Promise(() => {});`);
    const started = Date.now();
    const r = run(command, ["--produce", "--spec", "specs/X.md", "--prefix", "P"], {
      RUNGATE_PRODUCE_TIMEOUT_MS: "2000",
    });
    const elapsed = Date.now() - started;
    expect(r.code, "a hanging producer was read as a board").not.toBe(0);
    expect(r.err).toContain("was killed by");
    expect(
      elapsed,
      `the run took ${elapsed}ms against a 2000ms bound — the timeout is not what ended it`,
    ).toBeLessThan(30_000);

    // And the default is what ships. An env var set in CI, or a typo
    // falling back to 0, would disable the bound in spawnSync entirely.
    expect(PRODUCE_TIMEOUT_MS, "the default timeout is not a positive number of milliseconds").toBe(60_000);
  });

  // ── Security review of PR #1896, round 12 ────────────────────────────
  const HUNG_MARKER = "board-snapshot: resolved from origin/main at deadbeef";

  test("round 12: a producer that hangs still reports HOW FAR IT GOT", () => {
    // The kill arm was the one path reaching neither `error` nor `notes`,
    // so everything the child had already written was discarded on
    // exactly the failure where WHERE it stuck is the whole question.
    //
    // Driven through a real subprocess, not `produceBoard` in-process:
    // `PRODUCE_TIMEOUT_MS` is read once at module load, so an env edit
    // after import cannot reach it and the case would wait the full
    // default minute while proving nothing.
    const { command } = stage(
      `process.stderr.write(${JSON.stringify(HUNG_MARKER + "\n")});\n` +
        `await new Promise(() => {});`,
    );
    const r = run(command, ["--produce", "--spec", "specs/X.md", "--prefix", "P"], {
      RUNGATE_PRODUCE_TIMEOUT_MS: "2000",
    });

    expect(r.code, "a hanging producer was read as a board").not.toBe(0);
    expect(r.err, "the arm no longer reports a kill").toContain("was killed by");
    expect(
      r.err,
      "the child's provenance is still discarded on a hang — the case this round was about",
    ).toContain(HUNG_MARKER);
  });

  test("round 12: a producer that hangs SILENTLY says so, and invents nothing", () => {
    // The control. Without it the arm could append a constant string and
    // the case above would pass having read nothing the child emitted.
    const { command } = stage(`await new Promise(() => {});`);
    const r = run(command, ["--produce", "--spec", "specs/X.md", "--prefix", "P"], {
      RUNGATE_PRODUCE_TIMEOUT_MS: "2000",
    });

    expect(r.err).toContain("was killed by");
    expect(r.err).toContain("wrote nothing before it was killed");
    expect(r.err, "a line no child ever wrote").not.toContain(HUNG_MARKER);
  });

  test("--name=value and --name value forward identically — one parser, not two", () => {
    // The producer parses its own flags with `parseArgs`, which accepts
    // both spellings; this command used to read its own with
    // `argv.indexOf`, which accepts one. So `--spec=x` worked on the
    // producer and was silently refused on the path that forwards to it.
    // Two deciders for one input, disagreeing about exactly the spelling
    // that matters.
    const spaced = stage(ECHOING_PRODUCER);
    expect(run(spaced.command, ["--produce", "--spec", "specs/X.md", "--prefix", "Pipeline", "--repo", "o/n"]).code).toBe(0);
    const joined = stage(ECHOING_PRODUCER);
    expect(run(joined.command, ["--produce", "--spec=specs/X.md", "--prefix=Pipeline", "--repo=o/n"]).code).toBe(0);
    expect(
      JSON.parse(readFileSync(joined.argvAt, "utf-8")),
      "`--name=value` forwarded something different from `--name value`",
    ).toEqual(JSON.parse(readFileSync(spaced.argvAt, "utf-8")));
  });

  test("a producer that cannot be started says so, rather than reporting no output", () => {
    // `r.error` with a null status, empty stdout and empty stderr — the
    // one failure whose cause is already in hand, and the one a message
    // built from stdout/stderr alone describes as "no output".
    const { command } = stage(ECHOING_PRODUCER);
    // The OUTER spawn goes through this process's own binary, so only the
    // inner `spawnSync("bun", ...)` is the one that cannot resolve. Using
    // the name for both would fail at the outer call and the case would
    // pass having never reached the branch.
    const r = spawnSync(process.execPath, [command, "--produce", "--spec", "specs/X.md", "--prefix", "P"], {
      cwd: ROOT,
      encoding: "utf-8",
      env: { ...process.env, PATH: join(SCRATCH, "nothing-here") },
    });
    expect(r.status, `the outer spawn itself failed: ${r.error?.message ?? "no error"}`).not.toBe(0);
    expect(r.stderr, "a spawn that never started was reported as a producer that ran and said nothing").toContain(
      "could not be started",
    );
  });
});

/**
 * B3 fills `issues`, and the moment it does, every reading that counts over
 * issues starts reporting a number. `criteria-field` is the one whose source
 * B3 does NOT wire: the Criteria column is a Projects v2 custom field and
 * nothing in the snapshot's query can see it.
 *
 * An unread field and an empty field spell the same thing in JSON if the
 * producer writes `null` for both, so `criteria-field` would have read
 * `0 of 5 — 5 short` the day B3 landed: a number nobody measured, which is
 * the Silent Default Substitution shape in `.claude/rules/config-access.md`
 * wearing a denominator.
 *
 * The distinction is positional: **the key absent means not read**, and an
 * explicit `null` means read and empty. Note this is the OPPOSITE reading
 * from `satisfiedByIssue`, where absence must not count as covered — and
 * deliberately so. There, absence that reads as met certifies nothing; here,
 * absence that reads as short invents a measurement. Both resolve toward
 * refusing to claim.
 */
describe("a field the producer did not read is not a field that is empty (B4)", () => {
  const withIssues = (issues: BoardSnapshot["issues"]): BoardSnapshot => ({ ...completeBoard(), issues });

  const criteriaField = (board: BoardSnapshot) =>
    takeReadings(board).find(r => r.name === "criteria-field")!;

  test("every issue omits it: UNMEASURED, not 0 of N", () => {
    const r = criteriaField(
      withIssues([
        { number: 1, blockedBy: [], rootReady: true, labels: ["engine"] },
        { number: 2, blockedBy: [1], labels: ["engine"] },
      ]),
    );
    expect(r.status, `an unread column was reported as ${r.why}`).toBe("unmeasured");
    expect(r.why).toContain("2");
  });

  test("SOME issues omit it: still UNMEASURED — a partial read is not a read", () => {
    // The dangerous direction. Shrinking the denominator to the rows that
    // happen to carry the field makes the reading easier to satisfy the
    // less of the population was read, and `1 of 1` is the most flattering
    // thing this command can say.
    const r = criteriaField(
      withIssues([
        { number: 1, blockedBy: [], rootReady: true, criteriaField: "SC-2618", labels: ["engine"] },
        { number: 2, blockedBy: [1], labels: ["engine"] },
      ]),
    );
    expect(r.status, `a half-read column was reported as ${r.why}`).toBe("unmeasured");
  });

  test("read and empty is SHORT, because that is a measurement", () => {
    const r = criteriaField(
      withIssues([
        { number: 1, blockedBy: [], rootReady: true, criteriaField: "SC-2618", labels: ["engine"] },
        { number: 2, blockedBy: [1], criteriaField: null, labels: ["engine"] },
      ]),
    );
    expect(r.status).toBe("short");
    expect(r.why).toContain("1 of 2");
  });

  test('a read-but-blank string is SHORT too, not met', () => {
    const r = criteriaField(
      withIssues([
        { number: 1, blockedBy: [], rootReady: true, criteriaField: "   ", labels: ["engine"] },
        { number: 2, blockedBy: [1], criteriaField: "SC-2619", labels: ["engine"] },
      ]),
    );
    expect(r.status).toBe("short");
  });

  test("the unread guard does not swallow the reading — a complete board is still MET", () => {
    // Without this, returning "unmeasured" unconditionally would pass every
    // case above while making the reading incapable of ever going met.
    expect(criteriaField(completeBoard()).status).toBe("met");
  });

  test("it is scoped to criteria-field — the other issue readings still count every row", () => {
    // An `unreadable` guard that fired for every reading would turn the
    // whole command UNMEASURED the moment one column went unread, which is
    // the same defect pointed the other way.
    const half = withIssues([
      { number: 1, blockedBy: [], rootReady: true, criteriaField: "SC-2618", labels: ["engine"] },
      { number: 2, blockedBy: [1], labels: ["engine"] },
    ]);
    const queue = takeReadings(half).find(r => r.name === "queue-label")!;
    expect(queue.status, "queue-label stopped counting because a DIFFERENT column was unread").toBe("met");
    expect(queue.why).toContain("2 of 2");
  });
});

describe("the properties the mutant depends on", () => {
  test("REFUSE_EXIT is assigned exactly once", () => {
    const decls = source.match(/REFUSE_EXIT\s*=/g) || [];
    expect(
      decls.length,
      "more than one assignment to REFUSE_EXIT — the mutant would neutralise only one of them, and the " +
        "refusals routed through the others would go on refusing while the case recorded them as caught",
    ).toBe(1);
  });

  test("no refusal bypasses REFUSE_EXIT with its own numeric literal", () => {
    // `return REFUSE_EXIT` is the only way out of `main`, so the one
    // `process.exit` is the wrapper at the bottom. An exit — or a return
    // out of `main` — carrying a bare number is a refusal the mutation
    // cannot reach, and the case it serves would go green witnessing
    // nothing.
    const inlined = [
      ...(source.match(/process\.exit\(\s*-?\d/g) || []),
      ...(source.match(/return\s+-?[1-9]\d*\s*;/g) || []),
    ];
    expect(
      inlined,
      "a refusal carries its own number instead of routing through REFUSE_EXIT, so the mutant cannot " +
        "neutralise it and every case it serves goes green having witnessed nothing",
    ).toEqual([]);
    // And the one exit that does exist is the wrapper, not a refusal.
    expect((source.match(/process\.exit\(/g) || []).length).toBe(1);
  });

  test("the script has no relative imports, or the mutant dies on module resolution", () => {
    // A mutant that fails to load exits non-zero, which is byte-identical
    // to a refusal on the channel every case above watches.
    const relative = (source.match(/from\s+["']\.[^"']*["']/g) || []);
    expect(relative, "a relative import would break the mutant copy in its temp directory").toEqual([]);
  });

  test("the mutant really does stop refusing — the mutation is observed, not assumed", () => {
    // Guards the mutation itself: if the regex ever stops matching, every
    // `refuses()` call above would compare two identical scripts and the
    // second assertion would fail loudly rather than quietly pass.
    expect(readFileSync(MUTANT, "utf-8")).toContain("REFUSE_EXIT = 0");
    // **A BARE RUN IS NO LONGER A REFUSAL** (#1718) — it produces its own
    // board. So the input that still refuses is one whose producer
    // refuses, staged identically on both sides. `run(SCRIPT, [])` here
    // would reach the live API from inside the suite and report a pass.
    const REFUSING = `process.exit(1);`;
    expect(run(stageAs(MUTATED, REFUSING), []).code, "the mutant still refused an unmeasured board").toBe(0);
    expect(run(stageAs(source, REFUSING), []).code, "the real script stopped refusing an unmeasured board").toBe(
      REFUSE_EXIT,
    );
  });
});

describe("takeReading's three states", () => {
  test("a null board is unmeasured, never met", () => {
    for (const spec of READINGS) expect(takeReading(spec, null).status).toBe("unmeasured");
  });

  test("unmeasured is not conformant", () => {
    expect(conformant(takeReadings(null))).toBe(false);
  });

  test("an empty list of readings is not conformant either", () => {
    // `[].every(...)` is true, which would make a command that took no
    // readings at all report success.
    expect(conformant([])).toBe(false);
  });
});

// ── D3: the producer's provenance reaches the caller ────────────────────
//
// `produceBoard` quoted the child's stderr on every FAILURE arm and dropped
// it on the success arm, so on the one path anybody runs daily the
// producer's provenance — which tree the spec came from, which inputs came
// from config rather than the command line, which readings it could not
// take — was captured and discarded.
//
// These cases drive the success arm through a STUB producer rather than the
// real one. That is the whole reason `producer` is a parameter: while the
// path was a constant, no case could reach the success arm without a
// network and a credential, which is why this went uncovered.
describe("D3: what the producer said on the success path", () => {
  const stub = (body: string): string => {
    const at = join(mkdtempSync(join(SCRATCH, "producer-")), "stub.ts");
    writeFileSync(at, body);
    return at;
  };

  const flags = (): Flags => ({
    listReadings: false,
    produce: true,
    snapshotGiven: false,
    readingGiven: false,
    // #1889. Not given: these cases are about the PRODUCER, and emitting
    // the readings happens after it has already answered.
    emitReadingsGiven: false,
    spec: "specs/X.md",
    specGiven: true,
    prefix: "Pipeline",
    prefixGiven: true,
    repo: "o/n",
    repoGiven: true,
  });

  const MARKER = "spec read from origin/main at deadbeef (specs/X.md)";

  test("a producer that exits 0 has its stderr RETURNED, not swallowed", () => {
    const at = stub(
      `console.error(${JSON.stringify(MARKER)});\n` +
        `console.log(${JSON.stringify(JSON.stringify(completeBoard()))});\n`,
    );
    const r = produceBoard(flags(), at);

    expect(r.error, `the stub producer refused: ${r.error}`).toBeNull();
    expect(r.board, "the stub's board did not parse, so this case witnessed nothing").not.toBeNull();
    expect(r.notes, "the producer's provenance was captured and dropped — D3's line never reaches a reader").toContain(
      MARKER,
    );
  });

  test("a producer that says nothing yields EMPTY notes, not a fabricated line", () => {
    // The control. Without it, `notes` could be a constant string and the
    // case above would pass having measured nothing the child emitted.
    const at = stub(`console.log(${JSON.stringify(JSON.stringify(completeBoard()))});\n`);
    const r = produceBoard(flags(), at);

    expect(r.error).toBeNull();
    expect(r.notes).toBe("");
  });

  test("a REFUSING producer leaves notes empty — the reason is in `error`, and once is enough", () => {
    // Not a cosmetic choice. The refusal message already quotes stderr, so
    // carrying it in `notes` as well prints the producer's one reason twice
    // with nothing saying they are the same reading.
    const at = stub(`console.error("it refused, loudly");\nprocess.exit(3);\n`);
    const r = produceBoard(flags(), at);

    expect(r.error, "a non-zero producer produced no error").not.toBeNull();
    expect(r.error).toContain("it refused, loudly");
    expect(r.notes, "the same bytes are now on screen twice").toBe("");
  });

  test("DEFAULT_PRODUCER is the real board-snapshot, so the stub never becomes the shipped default", () => {
    // A parameter with a default is a second place the path can be wrong.
    // This is the only case that names the production value.
    expect(DEFAULT_PRODUCER.endsWith("scripts/board-snapshot.ts"), DEFAULT_PRODUCER).toBe(true);
    expect(readFileSync(DEFAULT_PRODUCER, "utf-8")).toContain("board-snapshot");
  });
});

/**
 * The offender LINES, which until review round 4 of #1903 nothing read.
 *
 * The battery above asserts a reading's status and its `why`. It never
 * asserted what an offender line SAYS, nor the cap, nor the remainder
 * arithmetic — so `offenders` could have returned `[]` from every reading,
 * or dropped the counts SC-2615 asks for by name, and the suite would have
 * stayed green. That is this repository's own *declared and nothing reads
 * it* shape (`.claude/rules/checks-must-be-able-to-fail.md`) applied to the
 * code that was shipped alongside the rule. Raised by the AI review and it
 * was right.
 *
 * Each case below names a mutation that it catches, because a case whose
 * break nobody wrote down is a case nobody can trust.
 */
describe("the offender lines are read, not just counted", () => {
  const readingNamed = (board: BoardSnapshot, name: string) =>
    takeReadings(board).find(r => r.name === name)!;

  test("spec-placement names the UNPLANNED spec AND its shortfall, not just the path", () => {
    // Catches: swapping the map body for `.map(s => s.path)`. SC-2615 says
    // "reported UNPLANNED **by name**", and the counts are what make the
    // line actionable rather than a second ratio.
    const board = completeBoard();
    board.specPlacements = [
      { path: "specs/A.md", state: "PLANNED", criteria: 4, placed: 4 },
      { path: "specs/B.md", state: "UNPLANNED", criteria: 7, placed: 2 },
    ];
    const r = readingNamed(board, "spec-placement");

    expect(r.status).toBe("short");
    expect(r.offenders).toEqual(["specs/B.md — 5 of 7 criteria in no phase"]);
    expect(r.offenders[0], "the PLANNED spec was named as an offender").not.toContain("specs/A.md");
  });

  test("criteria-named names the ISSUE, and a declared `servesNone` is not an offender", () => {
    // Catches: dropping `&& !i.servesNone` from the filter, which is the
    // whole distinction SC-2616 exists for — the issue that decided would
    // be reported beside the issues nobody has answered for.
    const board = completeBoard();
    board.repoIssues = [
      { number: 11, names: ["SC-2618"], servesNone: false },
      { number: 12, names: [], servesNone: true },
      { number: 13, names: [], servesNone: false },
    ];
    const r = readingNamed(board, "criteria-named");

    expect(r.offenders).toEqual([
      "#13 — names no criterion and does not declare that it serves none",
    ]);
  });

  test("a MET reading names nobody, and an UNMEASURED one names nobody either", () => {
    // Catches: computing offenders unconditionally. An UNMEASURED reading
    // naming rows is the worse half — it did not read the population it
    // would be naming them out of, so every name would be invented.
    const met = completeBoard();
    met.repoIssues = [{ number: 11, names: ["SC-2618"], servesNone: false }];
    expect(readingNamed(met, "criteria-named").status).toBe("met");
    expect(readingNamed(met, "criteria-named").offenders).toEqual([]);

    const unread = completeBoard();
    delete unread.repoIssues;
    expect(readingNamed(unread, "criteria-named").status).toBe("unmeasured");
    expect(readingNamed(unread, "criteria-named").offenders).toEqual([]);
  });

  test("formatReading prints every offender when there are exactly OFFENDERS_SHOWN", () => {
    // The boundary on the safe side. Catches an off-by-one that truncates
    // at the cap and appends "… and 0 more".
    const offenders = Array.from({ length: OFFENDERS_SHOWN }, (_, i) => `#${i} — short`);
    const out = formatReading({
      name: "criteria-named", item: "E2", what: "w", status: "short",
      measured: 0, target: OFFENDERS_SHOWN, why: `0 of ${OFFENDERS_SHOWN}`, offenders,
    });

    for (const o of offenders) expect(out).toContain(o);
    expect(out, "a complete list was announced as truncated").not.toContain("more");
  });

  test("one past the cap prints ten and says how many were withheld", () => {
    // Catches: breaking the remainder arithmetic in either direction, and
    // catches a cap that samples silently. The count is asserted as a
    // number in the text, not as "the line exists".
    const offenders = Array.from({ length: OFFENDERS_SHOWN + 7 }, (_, i) => `#${i} — short`);
    const out = formatReading({
      name: "criteria-named", item: "E2", what: "w", status: "short",
      measured: 0, target: offenders.length, why: `0 of ${offenders.length}`, offenders,
    });

    const printed = offenders.filter(o => out.includes(o));
    expect(printed.length, "the cap printed the wrong number of rows").toBe(OFFENDERS_SHOWN);
    expect(out).toContain(`… and 7 more`);
    // Every printed row is from the FRONT of the list, so the cap is a
    // prefix and not an arbitrary sample a reader cannot reproduce.
    expect(printed).toEqual(offenders.slice(0, OFFENDERS_SHOWN));
  });

  test("the withheld count and the list length agree, over the whole boundary", () => {
    // The property, rather than three hand-picked lengths: whatever is
    // printed plus whatever is announced as withheld must equal what the
    // reading actually found. A cap and a counter that disagree is a
    // reader told a truncated list is the whole one.
    for (const n of [0, 1, OFFENDERS_SHOWN - 1, OFFENDERS_SHOWN, OFFENDERS_SHOWN + 1, 97]) {
      const offenders = Array.from({ length: n }, (_, i) => `#${i} — short`);
      const out = formatReading({
        name: "criteria-named", item: "E2", what: "w", status: "short",
        measured: 0, target: n, why: `0 of ${n}`, offenders,
      });
      const printed = offenders.filter(o => out.includes(o)).length;
      const withheld = Number(/… and (\d+) more/.exec(out)?.[1] ?? 0);
      expect(printed + withheld, `n=${n}: ${printed} printed + ${withheld} withheld`).toBe(n);
    }
  });
});
