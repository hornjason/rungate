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
import { join } from "path";
import { spawnSync } from "child_process";
import {
  READINGS,
  READING_NAMES,
  REFUSE_EXIT,
  conformant,
  readSnapshotText,
  takeReading,
  takeReadings,
  type BoardSnapshot,
} from "../scripts/board-conformance.ts";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts/board-conformance.ts");
const source = readFileSync(SCRIPT, "utf-8");

let SCRATCH: string;
let MUTANT: string;

beforeAll(() => {
  SCRATCH = mkdtempSync(join(tmpdir(), "board-conformance-"));
  MUTANT = join(SCRATCH, "mutant-board-conformance.ts");
  const mutated = source.replace(/REFUSE_EXIT\s*=\s*1\b/, "REFUSE_EXIT = 0");
  if (mutated === source) throw new Error("could not build the mutant: no `REFUSE_EXIT = 1` in scripts/board-conformance.ts");
  writeFileSync(MUTANT, mutated);
});

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const run = (script: string, args: string[]) => {
  const r = spawnSync("bun", [script, ...args], { cwd: ROOT, encoding: "utf-8" });
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
});

const plant = (name: string, board: BoardSnapshot): string => {
  const at = join(SCRATCH, `${name}.json`);
  writeFileSync(at, JSON.stringify(board));
  return at;
};

describe("the command's shape", () => {
  test("--list-readings names all five readings, and the list is the assertion", () => {
    const r = run(SCRIPT, ["--list-readings"]);
    expect(r.code, `--list-readings refused: ${r.err}`).toBe(0);
    // Asserting the names rather than the exit code: a command that
    // printed nothing and exited 0 would satisfy the exit code alone, and
    // B5's own verify command reads this output.
    for (const name of READING_NAMES) expect(r.out, `--list-readings did not name "${name}"`).toContain(name);
    expect(READING_NAMES.length, "the ladder's B5 verify names five readings").toBe(5);
  });

  test("every reading names the ladder item that owns wiring its source", () => {
    // Without this, a reading can exist with nobody on the hook for making
    // it real, which is the "declared and nothing reads it" shape this
    // whole stage exists to close.
    expect(READINGS.map(r => r.item).sort()).toEqual(["B1", "B2", "B3", "B4", "B6"]);
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

  test("no snapshot refuses, as UNMEASURED rather than as a pass", () => {
    refuses([], "no board to read");
    refuses(["--reading", "milestones"], "no board to read, one reading");
    expect(run(SCRIPT, []).out).toContain("UNMEASURED");
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
    expect(whole.out.match(/^MET /gm)?.length, "an absent satisfiedByIssue moved a reading it has nothing to do with").toBe(4);

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
    const degrades: { row: "issues" | "phases"; at: number; field: string; reading: string }[] = [
      { row: "issues", at: 1, field: "blockedBy", reading: "blocked-by-edges" },
      { row: "issues", at: 1, field: "labels", reading: "queue-label" },
      { row: "issues", at: 1, field: "criteriaField", reading: "criteria-field" },
      { row: "phases", at: 1, field: "milestoneState", reading: "milestones" },
    ];
    for (const { row, at: index, field, reading } of degrades) {
      const board = completeBoard() as unknown as Record<string, Record<string, unknown>[]>;
      delete board[row]![index]![field];
      const at = plant(`missing-${field}`, board as unknown as BoardSnapshot);
      const r = run(SCRIPT, ["--snapshot", at]);
      expect(r.err, `omitting ${field} threw`).not.toContain("TypeError");
      expect(r.out, `omitting ${field} made the whole board unreadable`).not.toContain("UNMEASURED");
      expect(r.out, `omitting ${field} did not move ${reading}`).toContain(`SHORT       ${reading}`);
      expect(
        r.out.match(/^SHORT /gm)?.length,
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

  test("ONE short reading refuses the whole board even while the other four are met", () => {
    const broken = completeBoard();
    broken.issues[1]!.labels = ["bug"];
    const readings = takeReadings(broken);
    expect(readings.filter(r => r.status === "met").map(r => r.name).sort()).toEqual(
      ["blocked-by-edges", "criteria-field", "criterion-coverage", "milestones"],
    );
    expect(conformant(readings), "four of five met read as conformant").toBe(false);
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
    const dir = mkdtempSync(join(SCRATCH, "produce-"));
    writeFileSync(join(dir, "board-conformance.ts"), source);
    writeFileSync(join(dir, "board-snapshot.ts"), producer);
    return { command: join(dir, "board-conformance.ts"), argvAt: join(dir, "argv.json") };
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

  test("--produce with no --spec or no --prefix refuses, and never spawns", () => {
    for (const argv of [
      ["--produce", "--prefix", "Pipeline"],
      ["--produce", "--spec", "specs/X.md"],
    ]) {
      // A producer that would CRASH if reached, so the refusal is proved
      // to have happened before the spawn rather than after it.
      const { command } = stage(`throw new Error("the producer was spawned without the arguments it needs");`);
      const r = run(command, argv);
      expect(r.code, `[${argv.join(" ")}] did not refuse`).not.toBe(0);
      expect(r.err).toContain("--produce needs --spec <path> and --prefix <name>");
      expect(r.err, `[${argv.join(" ")}] spawned the producer anyway`).not.toContain("the producer was spawned");
    }
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
    expect(run(MUTANT, []).code, "the mutant still refused an unmeasured board").toBe(0);
    expect(run(SCRIPT, []).code, "the real script stopped refusing an unmeasured board").toBe(REFUSE_EXIT);
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
