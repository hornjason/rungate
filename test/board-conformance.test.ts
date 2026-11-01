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
    { number: 1, milestone: "Phase 1", blockedBy: [], rootReady: true, criteriaField: "SC-2618", labels: ["engine"] },
    { number: 2, milestone: "Phase 2", blockedBy: [1], criteriaField: "SC-2619", labels: ["engine", "bug"] },
  ],
  criteria: [
    { id: "SC-2618", satisfiedByIssue: 1 },
    { id: "SC-2619", satisfiedByIssue: 2 },
    { id: "SC-2620", satisfiedByIssue: null, recordedTrue: true },
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
    expect(run(SCRIPT, ["--snapshot", broken]).err).toContain("not an empty board");
  });

  test("an EMPTY board refuses — 0 of 0 is not a pass", () => {
    // The vacuous-assertion shape, and the one a skeleton falls into
    // first: with no issues and no criteria every ratio is satisfied by
    // counting nothing, and the command would certify the plan complete
    // against a board that does not exist.
    const empty = plant("empty", { issues: [], criteria: [] });
    refuses(["--snapshot", empty], "a board with nothing on it");
    expect(run(SCRIPT, ["--snapshot", empty]).out).toContain("UNMEASURED");
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
    const degrades: Record<string, string> = {
      blockedBy: "blocked-by-edges",
      labels: "queue-label",
      criteriaField: "criteria-field",
      milestone: "milestones",
    };
    for (const [field, reading] of Object.entries(degrades)) {
      const board = completeBoard() as unknown as { issues: Record<string, unknown>[] };
      delete board.issues[1]![field];
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

    const noNumber = completeBoard() as unknown as { issues: Record<string, unknown>[] };
    delete noNumber.issues[1]!.number;
    const at = plant("missing-number", noNumber as unknown as BoardSnapshot);
    refuses(["--snapshot", at], "an issue with no number");
    expect(run(SCRIPT, ["--snapshot", at]).err, "an unidentifiable row did not refuse the board").toContain(
      "not an empty board",
    );
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
    { reading: "milestones", what: "an issue with no milestone", break: b => void (b.issues[1]!.milestone = null) },
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
