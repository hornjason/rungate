import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { DEFAULT_RATCHET, DEFAULT_STATE, REFUSE_EXIT, main } from "../scripts/check-state-claims";

/**
 * Covers #1889 — the refusal, proved able to fail.
 *
 * Every negative case runs TWICE: against the real script, and against a
 * mutant copy whose single `REFUSE_EXIT = 1` is rewritten to `0`. Real must
 * refuse, mutant must not. The second assertion is the whole point — it is
 * the removal of the non-zero exit, performed and observed, so a case that
 * later passes for an unrelated reason stops being indistinguishable from
 * one genuinely caught.
 *
 * Two properties the mutant depends on are asserted rather than assumed:
 * `REFUSE_EXIT` is assigned exactly once, and the script's ONLY relative
 * import is `../lib/state-claim-readings` — which the copier carries into
 * the scratch tree at the same relative position. An import the copier
 * missed would kill the mutant at module resolution, and a dead mutant
 * reads exactly like a refusal on the merits.
 */
const SOURCE_PATH = join(import.meta.dir, "..", "scripts", "check-state-claims.ts");
const LIB_PATH = join(import.meta.dir, "..", "lib", "state-claim-readings.ts");
const source = readFileSync(SOURCE_PATH, "utf8");

let SCRATCH = "";
let MUTANT = "";

const LIVE = [
  { name: "milestones", measured: 26, target: 26 },
  { name: "blocked-by-edges", measured: 5, target: 5 },
];
const WHY =
  "Undated figures in priorities[] that no longer match the live board, banked so a new one reddens.";
/** The ratchet shape, with the reading set every fixture board carries. */
const RATCHET = (allowed: number, readings = LIVE.map(r => r.name)) => ({ allowed, why: WHY, readings });

beforeAll(() => {
  SCRATCH = mkdtempSync(join(tmpdir(), "check-state-claims-"));
  mkdirSync(join(SCRATCH, "scripts"));
  mkdirSync(join(SCRATCH, "lib"));
  // The dependency, carried at the SAME relative position the import names.
  writeFileSync(join(SCRATCH, "lib", "state-claim-readings.ts"), readFileSync(LIB_PATH, "utf8"));
  MUTANT = join(SCRATCH, "scripts", "mutant-check-state-claims.ts");
  const mutated = source.replace(/REFUSE_EXIT\s*=\s*1\b/, "REFUSE_EXIT = 0");
  if (mutated === source) {
    throw new Error("could not build the mutant: no `REFUSE_EXIT = 1` in scripts/check-state-claims.ts");
  }
  writeFileSync(MUTANT, mutated);
});

afterAll(() => {
  if (SCRATCH !== "") rmSync(SCRATCH, { recursive: true, force: true });
});

/** A file in the scratch tree, named so two cases cannot share one. */
let seq = 0;
function plant(name: string, value: unknown): string {
  const at = join(SCRATCH, `${name}-${seq++}.json`);
  writeFileSync(at, JSON.stringify(value, null, 2));
  return at;
}

function runMutant(argv: readonly string[]): number {
  const r = spawnSync("bun", [MUTANT, ...argv], { encoding: "utf8" });
  if (r.status === null) throw new Error(`the mutant did not exit: ${r.error?.message ?? "no status"}`);
  return r.status;
}

/**
 * The negative contract: the real script refuses, and the mutant does not.
 *
 * Both halves, every time. Asserting only the first would pass for a case
 * that refused before reaching the mechanism it is pointed at.
 */
function bothWays(argv: readonly string[]): { real: number; mutant: number } {
  return { real: main(argv), mutant: runMutant(argv) };
}

describe("the mutant is real", () => {
  test("REFUSE_EXIT is assigned exactly once", () => {
    // An inlined `process.exit(1)` anywhere would bypass the mutation, and
    // every case below would then be asserting against an unmutated script.
    expect(source.match(/REFUSE_EXIT\s*=\s*1\b/g) ?? []).toHaveLength(1);
    expect(source.match(/process\.exit\([1-9]/g), "a refusal bypasses the constant").toBeNull();
  });

  test("the only relative import is the one the copier carries", () => {
    const relative = [...source.matchAll(/from\s+"(\.[^"]+)"/g)].map(m => m[1]);
    expect(relative, "the copier would have to carry these too").toEqual([
      "../lib/state-claim-readings",
    ]);
  });

  test("the mutant RUNS — a dead mutant reads like a refusal on the merits", () => {
    // Observed, not assumed. Module resolution failing would exit non-zero
    // and every `mutant === 0` assertion below would be measuring that
    // instead of the removed refusal.
    const readings = plant("readings", LIVE);
    const state = plant("state", { priorities: ["milestones 26 of 26."] });
    const ratchet = plant("ratchet", RATCHET(0));
    expect(runMutant([`--readings=${readings}`, `--state=${state}`, `--ratchet=${ratchet}`])).toBe(0);
  });
});

describe("the comparison — one input, two outcomes", () => {
  test("a figure that disagrees refuses; the same entry corrected exits zero", () => {
    // The issue's own `How we will know`, written as one pair.
    const readings = plant("readings", LIVE);
    const ratchet = plant("ratchet", RATCHET(0));
    const wrong = plant("state", { priorities: ["blocked-by-edges 6 of 6 MET."] });
    const right = plant("state", { priorities: ["blocked-by-edges 5 of 5 MET."] });

    const bad = bothWays([`--readings=${readings}`, `--state=${wrong}`, `--ratchet=${ratchet}`]);
    expect(bad.real).toBe(REFUSE_EXIT);
    expect(bad.mutant, "the refusal was not what the case observed").toBe(0);

    expect(main([`--readings=${readings}`, `--state=${right}`, `--ratchet=${ratchet}`])).toBe(0);
  });

  test("#1888 round 1 regression: a DATED recording does not refuse", () => {
    // The first historical escape, as it was written. 12/12 against a live
    // 5/5 — and it is a record of 2026-11-03, so it must not redden.
    const readings = plant("readings", LIVE);
    const ratchet = plant("ratchet", RATCHET(0));
    const state = plant("state", {
      priorities: ["The 2026-11-03 session recorded FIVE readings at 87d7c832 — blocked-by-edges 12/12."],
    });
    expect(main([`--readings=${readings}`, `--state=${state}`, `--ratchet=${ratchet}`])).toBe(0);
  });

  test("#1888 round 1 regression: the same figure UNDATED refuses", () => {
    // The other half, and the one that makes the case above mean something.
    // Without it, "dated recordings pass" is satisfied by a check that
    // passes everything.
    const readings = plant("readings", LIVE);
    const ratchet = plant("ratchet", RATCHET(0));
    const state = plant("state", { priorities: ["FIVE readings — blocked-by-edges 12/12."] });
    const r = bothWays([`--readings=${readings}`, `--state=${state}`, `--ratchet=${ratchet}`]);
    expect(r.real).toBe(REFUSE_EXIT);
    expect(r.mutant).toBe(0);
  });
});

describe("the states that are not a pass", () => {
  test("NO CLAIMS refuses, and says so — it is not zero disagreements", () => {
    // The vacuous assertion. A file with nothing to compare has not been
    // checked, and an extractor that matched nothing would otherwise
    // certify it by counting nothing.
    const readings = plant("readings", LIVE);
    const ratchet = plant("ratchet", RATCHET(0));
    const state = plant("state", { priorities: ["a note that cites no reading at all"] });
    const r = bothWays([`--readings=${readings}`, `--state=${state}`, `--ratchet=${ratchet}`]);
    expect(r.real).toBe(REFUSE_EXIT);
    expect(r.mutant).toBe(0);
  });

  test("no --readings is UNMEASURED and refuses, not an empty comparison", () => {
    const state = plant("state", { priorities: ["milestones 26 of 26."] });
    const r = bothWays([`--state=${state}`]);
    expect(r.real).toBe(REFUSE_EXIT);
    expect(r.mutant).toBe(0);
  });

  test("an ABSENT ratchet refuses — absent is UNMEASURED, never zero", () => {
    const readings = plant("readings", LIVE);
    const state = plant("state", { priorities: ["milestones 26 of 26."] });
    const r = bothWays([
      `--readings=${readings}`,
      `--state=${state}`,
      `--ratchet=${join(SCRATCH, "no-such-ratchet.json")}`,
    ]);
    expect(r.real).toBe(REFUSE_EXIT);
    expect(r.mutant).toBe(0);
  });

  test("a ratchet whose 'why' says nothing refuses", () => {
    // A ratchet nobody can interpret becomes a number nobody lowers.
    const readings = plant("readings", LIVE);
    const state = plant("state", { priorities: ["milestones 26 of 26."] });
    const ratchet = plant("ratchet", { allowed: 0, why: "stale", readings: LIVE.map(r => r.name) });
    const r = bothWays([`--readings=${readings}`, `--state=${state}`, `--ratchet=${ratchet}`]);
    expect(r.real).toBe(REFUSE_EXIT);
    expect(r.mutant).toBe(0);
  });

  test("a corrupt readings file refuses, and is not an empty set of readings", () => {
    const at = join(SCRATCH, "corrupt-readings.json");
    writeFileSync(at, "{not json");
    const state = plant("state", { priorities: ["milestones 26 of 26."] });
    const ratchet = plant("ratchet", RATCHET(0));
    const r = bothWays([`--readings=${at}`, `--state=${state}`, `--ratchet=${ratchet}`]);
    expect(r.real).toBe(REFUSE_EXIT);
    expect(r.mutant).toBe(0);
  });

  test("an UNMEASURED reading refuses — it is not a reading of 0 of 0", () => {
    // The vacuous certification this whole check exists against, arriving
    // through its own input. `takeReading` reports `unmeasured` with
    // `measured: 0, target: 0`, so without the `status` check a cited
    // `26 of 26` disagrees for a reason nobody wrote — and a cited
    // `0 of 0` AGREES having been compared with nothing at all.
    const readings = plant("readings", [
      { name: "milestones", measured: 0, target: 0, status: "unmeasured" },
      { name: "blocked-by-edges", measured: 5, target: 5, status: "met" },
    ]);
    const state = plant("state", { priorities: ["milestones 0 of 0."] });
    const r = bothWays([`--readings=${readings}`, `--state=${state}`, `--ratchet=${plant("ratchet", RATCHET(0))}`]);
    expect(r.real, "a figure was compared against a reading nothing measured").toBe(REFUSE_EXIT);
    expect(r.mutant).toBe(0);
  });

  test("a RENAMED reading refuses — the citation would otherwise vanish silently", () => {
    // The guard that replaced a branch which could not fire. `judgeClaims`
    // derives its name list from the live readings, so a figure citing
    // `queue-label` after it is renamed never reaches a verdict: the file
    // reads as fully checked while a figure nobody re-derives sits in it.
    // Comparing the SETS is the only place that is visible.
    const renamed = plant("readings", [
      { name: "milestones", measured: 26, target: 26 },
      { name: "queue-labels", measured: 5, target: 5 },
    ]);
    const state = plant("state", { priorities: ["queue-label 9 of 9."] });
    const r = bothWays([
      `--readings=${renamed}`,
      `--state=${state}`,
      `--ratchet=${plant("ratchet", RATCHET(0, ["milestones", "queue-label"]))}`,
    ]);
    expect(r.real, "a renamed reading passed as if nothing changed").toBe(REFUSE_EXIT);
    expect(r.mutant).toBe(0);
  });

  test("a readings entry with a non-numeric target refuses rather than comparing undefined", () => {
    // Otherwise `26 === undefined` reads as a disagreement: a refusal for
    // the wrong reason, which is worse than none because a reader acts on
    // the reason.
    const readings = plant("readings", [{ name: "milestones", measured: 26, target: "26" }]);
    const state = plant("state", { priorities: ["milestones 26 of 26."] });
    const ratchet = plant("ratchet", RATCHET(0));
    const r = bothWays([`--readings=${readings}`, `--state=${state}`, `--ratchet=${ratchet}`]);
    expect(r.real).toBe(REFUSE_EXIT);
    expect(r.mutant).toBe(0);
  });
});

describe("the ratchet refuses in both directions", () => {
  const readings = () => plant("readings", LIVE);
  const twoWrong = () =>
    plant("state", { priorities: ["blocked-by-edges 6 of 6.", "milestones 25 of 26."] });

  test("ABOVE the banked number refuses — a new stale figure reddens the build", () => {
    const r = bothWays([
      `--readings=${readings()}`,
      `--state=${twoWrong()}`,
      `--ratchet=${plant("ratchet", RATCHET(1))}`,
    ]);
    expect(r.real).toBe(REFUSE_EXIT);
    expect(r.mutant).toBe(0);
  });

  test("BELOW it refuses too — a figure you fixed is banked in the same commit", () => {
    // The half a one-sided ratchet cannot see. Changing `n !==` to `n >`
    // turns exactly this red and leaves every other case green.
    const r = bothWays([
      `--readings=${readings()}`,
      `--state=${twoWrong()}`,
      `--ratchet=${plant("ratchet", RATCHET(3))}`,
    ]);
    expect(r.real).toBe(REFUSE_EXIT);
    expect(r.mutant).toBe(0);
  });

  test("AT the banked number exits zero", () => {
    expect(
      main([
        `--readings=${readings()}`,
        `--state=${twoWrong()}`,
        `--ratchet=${plant("ratchet", RATCHET(2))}`,
      ]),
    ).toBe(0);
  });
});

/**
 * The committed `project-state.json`, against the board as it read when the
 * ratchet was banked.
 *
 * The board is a fixture and the state file is the live one, which is the
 * only arrangement that works here: taking a live board reading would put
 * the network inside the suite, and planting the state file would make the
 * banked number a constant nobody can lower.
 *
 * What that pins is the half this issue is about — **the state file against
 * a stated board**. A figure added to `priorities[]` that disagrees with
 * this board moves the count and reddens these cases, which is why
 * `scripts/census-routing.ts` routes this suite from the state-write row.
 *
 * When the real board moves, the live count and this one diverge. That is
 * not drift to paper over: it is the signal that a figure in the file has
 * gone stale, and the remedy is in the refusal's own words — correct it, or
 * date the sentence so it reads as the record it is.
 */
const BOARD_AT_BANKING = [
  { name: "milestones", measured: 26, target: 26 },
  { name: "criterion-coverage", measured: 26, target: 26 },
  { name: "blocked-by-edges", measured: 5, target: 5 },
  { name: "criteria-field", measured: 5, target: 5 },
  { name: "queue-label", measured: 5, target: 5 },
  { name: "spec-placement", measured: 87, target: 1815 },
  { name: "criteria-named", measured: 41, target: 71 },
];

describe("the live repository", () => {
  const REPO_ROOT = join(import.meta.dir, "..");
  // The LITERAL, not the constant, and `test/census-routing.test.ts`'s C4
  // membership guard requires exactly this spelling: a suite routed from
  // the state-write row has to resolve a trio path against a repo-root
  // constant, because that is what makes the live file an input to it
  // rather than a string it mentions. The agreement below is what keeps
  // the literal and the constant from drifting apart.
  const statePath = join(REPO_ROOT, "project-state.json");
  const ratchetPath = join(REPO_ROOT, DEFAULT_RATCHET);

  test("the literal this suite reads is the path the script defaults to", () => {
    expect(DEFAULT_STATE).toBe("project-state.json");
  });

  test("the committed project-state.json meets its committed ratchet", () => {
    const readings = plant("board-at-banking", BOARD_AT_BANKING);
    expect(
      main([`--readings=${readings}`, `--state=${statePath}`, `--ratchet=${ratchetPath}`]),
      "the live project-state.json no longer matches the banked number — read the refusal: " +
        "either a figure went stale and should be dated, or one was fixed and the ratchet must " +
        "be lowered in the same commit",
    ).toBe(0);
  });

  test("the live file is READ, not merely named — one more stale figure reddens it", () => {
    // The vacuous half, closed. The case above passes for a check that
    // reads nothing and a check that reads everything; this one separates
    // them. It plants the live priorities PLUS one disagreeing sentence and
    // asserts the count moved by exactly one.
    const live = JSON.parse(readFileSync(statePath, "utf8")) as { priorities?: unknown[] };
    const worse = plant("state", {
      priorities: [...(live.priorities ?? []), "blocked-by-edges 99 of 99 MET."],
    });
    const readings = plant("board-at-banking", BOARD_AT_BANKING);
    const banked = JSON.parse(readFileSync(ratchetPath, "utf8")) as { allowed: number; why: string };

    const r = bothWays([`--readings=${readings}`, `--state=${worse}`, `--ratchet=${ratchetPath}`]);
    expect(r.real, "an added stale figure did not redden the check").toBe(REFUSE_EXIT);
    expect(r.mutant).toBe(0);

    // …and it is ONE more, not some other number. A refusal for the wrong
    // count would pass the assertion above while measuring nothing.
    const atOneMore = plant("ratchet", { allowed: banked.allowed + 1, why: WHY, readings: BOARD_AT_BANKING.map(r => r.name) });
    expect(main([`--readings=${readings}`, `--state=${worse}`, `--ratchet=${atOneMore}`])).toBe(0);
  });

  test("the banked number says what it means", () => {
    // A ratchet nobody can interpret becomes a number nobody lowers.
    const banked = JSON.parse(readFileSync(ratchetPath, "utf8")) as {
      allowed: number;
      why: string;
      readings: string[];
    };
    expect(Number.isInteger(banked.allowed)).toBe(true);
    // The rename guard's own input. A ratchet banked against an unstated
    // reading set cannot tell a rename from a count that moved.
    expect(banked.readings.length).toBeGreaterThan(0);
    expect(banked.why.length).toBeGreaterThan(40);
  });
});
