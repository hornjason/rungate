/**
 * The plan is executed, not read.
 *
 * `lib/stage-ladder.ts` says why this exists. The short version: Stage A's
 * definition of done lived in three prose documents that nothing compared,
 * and the agent that built the stage scored it wrong twice — 5 of 6 against
 * a real 3 of 7, and then a FAILURE after it had passed.
 *
 * The fix is that no sentence anywhere says a stage is done. Each item
 * carries a shell command, and the cases below RUN them. A stage is complete
 * when its commands exit 0.
 *
 * ## What was broken to prove these can fail
 *
 * Every rule in `ladderViolations` has a negative case below that plants the
 * violation and asserts the message. Beyond that, each of Stage A's seven
 * verify commands was run against an empty scratch tree on 2026-11-01 and
 * all seven refused — so none of them is a command that passes regardless of
 * the repository, which is the failure mode that makes a green ladder
 * worthless. `A1.verify` was then set to `false` in the live file and this
 * suite went red naming it, green again on restore.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import {
  COMMAND_NOT_FOUND,
  claimedImprovements,
  ladderViolations,
  nextStage,
  openImprovements,
  retrosOwed,
  stageIsComplete,
  stageLadderViolations,
  type Retro,
  type Stage,
} from "../lib/stage-ladder.ts";

const ROOT = join(import.meta.dir, "..");
const doc = JSON.parse(readFileSync(join(ROOT, "project-state.json"), "utf-8")) as {
  goal: { statement: string; verify: string };
  goals: { id: number }[];
  stages: Stage[];
};
const stages = doc.stages;

/**
 * How many done items may have their evidence outside this repository.
 *
 * Exactly one: Stage A's A2, whose evidence is `~/.claude/FLEET-STATE.md`.
 * Asserted rather than described, so a second item cannot become
 * unrunnable-in-CI without somebody editing this line and saying why.
 */
const MACHINE_SCOPED_ALLOWED = 1;

const run = (cmd: string) => spawnSync("sh", ["-c", cmd], { cwd: ROOT, encoding: "utf-8" });

const retro = (over: Partial<Retro> = {}): Retro => ({
  wentWell: ["a thing"],
  wentPoorly: ["another thing"],
  improvements: [{ what: "do better", mechanism: "a test that refuses it", status: "in-place", verify: "true" }],
  ...over,
});

/** A minimal valid stage, for the negative cases to break one field at a time. */
const ok = (over: Partial<Stage> = {}): Stage => ({
  id: "A",
  name: "Write it down",
  goal: "the documents exist and say what they must",
  serves: 1,
  agreed: "2026-10-30 Jason",
  items: [{ id: "A1", what: "a thing", done: true, verify: "true" }],
  retro: retro(),
  ...over,
});

describe("the live plan", () => {
  test("is internally consistent — goal, goals and stages together", () => {
    expect(ladderViolations(doc), "project-state.json's plan is malformed").toEqual([]);
  });

  test("every DONE item's verify command exits 0 — this is what 'done' means", () => {
    const checked: string[] = [];
    const failed: string[] = [];
    const deferred: string[] = [];
    const unmeasured: string[] = [];

    for (const stage of stages) {
      for (const item of stage.items) {
        if (!item.done) continue;
        if (item.scope === "machine") {
          deferred.push(item.id);
          continue;
        }
        checked.push(item.id);
        const r = run(item.verify!);
        // 127 is "the tool is not here", which is not evidence the item
        // regressed. Counted apart so it can never read as a pass either.
        if (r.status === COMMAND_NOT_FOUND) {
          unmeasured.push(`${item.id}: ${item.verify}`);
        } else if (r.status !== 0) {
          failed.push(
            `${item.id} exited ${r.status}: ${item.verify}\n` +
              `     ${item.what}\n` +
              `     ${(r.stderr || r.stdout || "(no output)").trim().slice(0, 300)}`,
          );
        }
      }
    }

    // A run that checked nothing is not a run that passed.
    expect(checked.length, "no repo-scoped done items were executed, so this case witnessed nothing").toBeGreaterThan(0);

    expect(
      unmeasured,
      `a verify command's program does not exist on this machine (exit ${COMMAND_NOT_FOUND}). That is not a ` +
        `regression and it is not a pass — the item is UNMEASURED. Install the tool or write the check with ` +
        `something the runner has.`,
    ).toEqual([]);

    expect(
      deferred.length,
      `${deferred.length} done item(s) have evidence outside this repository (${deferred.join(", ") || "none"}) ` +
        `and were NOT executed. The allowance is ${MACHINE_SCOPED_ALLOWED}. A new one means a stage item CI can ` +
        `never check — decide that deliberately and raise this constant with a reason, or move the evidence in.`,
    ).toBe(MACHINE_SCOPED_ALLOWED);

    expect(
      failed,
      `a stage item is marked done and its own verify command refuses. Either the work regressed or the item ` +
        `was ticked without the command being run. Do not weaken the command to make this pass.`,
    ).toEqual([]);
  });

  test("the overall goal carries a command, and that command is not yet met", () => {
    // The honest state: `rungate board-conformance` is B5/D2 in this very
    // ladder, so the goal CANNOT be met yet. This case exists so the day it
    // starts passing is a day somebody notices, rather than a sentence
    // somewhere going stale in the other direction.
    expect(doc.goal.verify.length, "the overall goal has no verify command").toBeGreaterThan(0);
    const r = run(doc.goal.verify);
    expect(
      r.status,
      "the overall goal's command now exits 0. If `board-conformance` is real and passing, the goal is MET — " +
        "say so in project-state.json and update this assertion in the same commit.",
    ).not.toBe(0);
  });

  test("Stage A is complete and carries its retro; Stage B is next and unblocked", () => {
    const a = stages.find(s => s.id === "A")!;
    expect(stageIsComplete(a), "Stage A is no longer complete").toBe(true);
    expect(a.retro, "Stage A has no retro — the stage that taught the most would teach nothing").not.toBeNull();
    expect(a.retro!.improvements.length, "Stage A's retro lists no improvements").toBeGreaterThan(0);

    const next = nextStage(stages);
    expect(next?.stage.id, "the next incomplete stage is not B").toBe("B");
    // Jason agreed B1..B6 on 2026-11-01. Before that this assertion read
    // `toContain("agreed: null")` — the gate did its job for the whole time
    // the stage was a proposal, and this is the commit where that stopped
    // being true.
    expect(
      next?.stage.agreed,
      "Stage B has no `agreed` — it may not be worked until its wording is signed off",
    ).toBeTruthy();
    expect(
      next?.blocked,
      "Stage B is reported blocked. Either a prior stage lost its retro, or something else came up — read " +
        "the message rather than deleting this assertion.",
    ).toBeNull();
  });

  test("every in-place improvement's command exits 0 — a learning only described is not carried forward", () => {
    // The retro's own mechanisms, executed. `mechanism` is a sentence and a
    // sentence can name something that does not exist: the first version of
    // Stage A's retro named six and proved none. This is the case that
    // stops a stage's learnings from being a list of good intentions, and
    // it went red on its first run against an improvement claiming the very
    // mechanism this case is.
    const claimed = claimedImprovements(stages);
    expect(claimed.length, "no improvement claims to be in place, so this case witnessed nothing").toBeGreaterThan(0);

    const broken = claimed
      .map(c => ({ c, r: run(c.verify) }))
      .filter(({ r }) => r.status !== 0)
      .map(({ c, r }) => `${c.stage}: ${c.what}\n     ${c.verify}\n     exit ${r.status}`);

    expect(
      broken,
      "a retro says a mechanism is in place and its own command refuses. The learning from that stage is " +
        "NOT carried forward — either the mechanism regressed, or it was described and never built. " +
        "Fix the mechanism or set the improvement's status to \"open\" and say so.",
    ).toEqual([]);

    // Open ones are declared, not hidden. Printed so a reader of a green
    // run still sees what is outstanding.
    for (const o of openImprovements(stages)) console.log(`  OPEN improvement (stage ${o.stage}): ${o.what}`);
  });

  test("the goal names a SUCCESS.md claim, and that claim is really there", () => {
    // SUCCESS.md stays the charter and keeps the claim; project-state keeps
    // the living plan and REFERENCES it. That is a checked cross-reference
    // rather than a fourth copy, and this is the check.
    const n = (doc.goal as { successClaim?: unknown }).successClaim;
    expect(typeof n, "the goal names no SUCCESS.md claim").toBe("number");
    const success = readFileSync(join(ROOT, "SUCCESS.md"), "utf-8");
    expect(
      new RegExp(`^${n}\\. \\*\\*`, "m").test(success),
      `project-state.json's goal says it serves SUCCESS.md claim ${n}, and SUCCESS.md has no claim ${n}. ` +
        `One of the two moved. SUCCESS.md is the charter; renumbering a claim there means updating the ` +
        `reference here in the same commit.`,
    ).toBe(true);
  });

  test("every stage serves one of the three agreed goals", () => {
    const ids = new Set(doc.goals.map(g => g.id));
    expect(ids.size, "no goals are recorded").toBeGreaterThan(0);
    expect(stages.filter(s => !ids.has(s.serves)).map(s => s.id)).toEqual([]);
  });
});

describe("the ladder refuses the things that went wrong in Stage A", () => {
  test("a done item with no verify command is refused", () => {
    const v = stageLadderViolations([ok({ items: [{ id: "A1", what: "a thing", done: true, verify: null }] })]);
    expect(v.join("\n")).toContain("is done with no verify command");
  });

  test("a done item whose own text denies it is refused — the A4 shape", () => {
    // Verbatim from the live file on 2026-11-01, where A4 shipped `[x]`
    // carrying this clause and nothing objected.
    const v = stageLadderViolations([
      ok({ items: [{ id: "A1", what: "criteria for the no-hand rule — 0 of them ticked, and 'done when each has a failing test' is not met", done: true, verify: "true" }] }),
    ]);
    expect(v.join("\n")).toContain("One of the two is wrong");
  });

  test("a done item in a stage nobody agreed is refused — AGENTS.md rule 9", () => {
    const v = stageLadderViolations([ok({ agreed: null })]);
    expect(v.join("\n")).toContain("nobody has signed off");
  });

  test("a stage whose letter does not match its position is refused — the re-lettering trap", () => {
    const v = stageLadderViolations([ok(), ok({ id: "C", items: [] })]);
    expect(v.join("\n")).toContain("but it sits at position 1");
  });

  test("a stage with a label but no goal is refused", () => {
    const v = stageLadderViolations([ok({ goal: "" })]);
    expect(v.join("\n")).toContain("is a label, not a goal");
  });

  test("a stage serving a goal that does not exist is refused", () => {
    const v = ladderViolations({
      goal: { statement: "x", verify: "true" },
      goals: [{ id: 1, goal: "g", doneWhen: "d" }],
      stages: [ok({ serves: 9 })],
    });
    expect(v.join("\n")).toContain("which is not the id of any goal");
  });

  test("an improvement naming no mechanism is refused — a resolution is not a fix", () => {
    const v = stageLadderViolations([
      ok({ retro: retro({ improvements: [{ what: "stop at round three", mechanism: "  ", status: "open", verify: null }] }) }),
    ]);
    expect(v.join("\n")).toContain("name what ENFORCES this improvement");
  });

  test("an improvement claiming to be in place with no command is refused — the prose trap", () => {
    // Jason's question on 2026-11-01: does the retro carry commands? It did
    // not. A named mechanism read as enforcement and proved nothing.
    const v = stageLadderViolations([
      ok({ retro: retro({ improvements: [{ what: "x", mechanism: "a test somewhere", status: "in-place", verify: null }] }) }),
    ]);
    expect(v.join("\n")).toContain("A named mechanism is");
  });

  test("an open improvement carrying a command is refused — it cannot prove what it says is missing", () => {
    const v = stageLadderViolations([
      ok({ retro: retro({ improvements: [{ what: "x", mechanism: "none yet", status: "open", verify: "true" }] }) }),
    ]);
    expect(v.join("\n")).toContain("cannot prove itself");
  });

  test("an improvement with no status is refused", () => {
    const v = stageLadderViolations([
      ok({ retro: retro({ improvements: [{ what: "x", mechanism: "y" } as never] }) }),
    ]);
    expect(v.join("\n")).toContain('expected "in-place" or "open"');
  });

  test("the overall goal with no verify command is refused", () => {
    const v = ladderViolations({ goal: { statement: "x", verify: "" }, goals: [], stages: [] });
    expect(v.join("\n")).toContain("the overall goal needs a command");
  });

  test("an item whose number is not its position is refused, so a count can be checked", () => {
    const v = stageLadderViolations([ok({ items: [{ id: "A3", what: "x", done: false, verify: null }] })]);
    expect(v.join("\n")).toContain("item numbers are their position");
  });

  test("an item carrying another stage's letter is refused", () => {
    const v = stageLadderViolations([ok({ items: [{ id: "B1", what: "x", done: false, verify: null }] })]);
    expect(v.join("\n")).toContain("an item's letter must be its stage's");
  });

  test("a bad scope is refused, so a typo cannot silently exempt an item from execution", () => {
    const v = stageLadderViolations([
      ok({ items: [{ id: "A1", what: "x", done: true, verify: "true", scope: "local" as never }] }),
    ]);
    expect(v.join("\n")).toContain('expected "repo", "machine" or absent');
  });

  test("a clean ladder produces no violations — the control", () => {
    // Without this, every case above is satisfied by a function that
    // returns a violation for everything.
    expect(stageLadderViolations([ok()])).toEqual([]);
  });

  test("stages must be an array", () => {
    expect(stageLadderViolations(undefined).join("")).toContain("not an array");
  });
});

describe("the retro is a gate, not a habit", () => {
  test("a complete stage with no retro blocks the next stage", () => {
    const blocked = nextStage([
      ok({ retro: null }),
      ok({ id: "B", items: [{ id: "B1", what: "x", done: false, verify: null }] }),
    ]);
    expect(blocked?.stage.id).toBe("B");
    expect(blocked?.blocked).toContain("is complete and has no retro");
  });

  test("the same pair with the retro written is not blocked — the control", () => {
    const free = nextStage([
      ok(),
      ok({ id: "B", items: [{ id: "B1", what: "x", done: false, verify: null }] }),
    ]);
    expect(free?.stage.id).toBe("B");
    expect(free?.blocked).toBeNull();
  });

  test("a retro that is not an object is refused", () => {
    expect(stageLadderViolations([ok({ retro: "we did fine" as never })]).join("")).toContain("expected an object or null");
  });
});

describe("completion is derived, never asserted", () => {
  test("a stage with an open item is not complete", () => {
    const s = ok({ items: [{ id: "A1", what: "x", done: true, verify: "true" }, { id: "A2", what: "y", done: false, verify: null }] });
    expect(stageIsComplete(s)).toBe(false);
  });

  test("a stage with no items is not complete — an empty stage is not a finished one", () => {
    expect(stageIsComplete(ok({ items: [] }))).toBe(false);
  });

  test("nextStage returns null when everything is done AND every retro is written", () => {
    expect(nextStage([ok()])).toBeNull();
  });

  test("the LAST stage completing with no retro is reported, not read as finished", () => {
    // Found by review on #1696. The retro gate ran only when a later,
    // incomplete stage existed to carry the message, so the final stage —
    // the one no future stage can ever remind anybody about — could
    // complete with retro: null and the plan read as done.
    const end = nextStage([ok(), ok({ id: "B", retro: null })]);
    expect(end, "a complete ladder owing a retro reported nothing to do").not.toBeNull();
    expect(end!.stage, "there is no stage left to work, so `stage` must be null").toBeNull();
    expect(end!.blocked).toContain("is complete and has no retro");
    expect(end!.blocked).toContain("B");
  });

  test("retrosOwed names every complete stage missing one, and nothing else", () => {
    expect(retrosOwed([ok(), ok({ id: "B", retro: null }), ok({ id: "C", items: [{ id: "C1", what: "x", done: false, verify: null }], retro: null })]))
      .toEqual(["B"]);
  });
});
