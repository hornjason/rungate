/**
 * The stage ladder is executed, not read.
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
 * Every rule in `stageLadderViolations` has a negative case below that
 * plants the violation and asserts the message. Beyond that, each of Stage
 * A's seven verify commands was run against an empty scratch tree on
 * 2026-11-01 and all seven refused — so none of them is a command that
 * passes regardless of the repository, which is the failure mode that makes
 * a green ladder worthless.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { stageLadderViolations, stageIsComplete, nextStage, type Stage } from "../lib/stage-ladder.ts";

const ROOT = join(import.meta.dir, "..");
const stages = (JSON.parse(readFileSync(join(ROOT, "project-state.json"), "utf-8")) as { stages: Stage[] }).stages;

/**
 * How many done items may have their evidence outside this repository.
 *
 * Exactly one: Stage A's A2, whose evidence is `~/.claude/FLEET-STATE.md`.
 * The number is asserted rather than described, so a second item cannot
 * become unrunnable-in-CI without somebody editing this line and saying why.
 */
const MACHINE_SCOPED_ALLOWED = 1;

const run = (cmd: string) => spawnSync("sh", ["-c", cmd], { cwd: ROOT, encoding: "utf-8" });

/** A minimal valid ladder, for the negative cases to break one field at a time. */
const ok = (over: Partial<Stage> = {}): Stage => ({
  id: "A",
  name: "Write it down",
  agreed: "2026-10-30 Jason",
  items: [{ id: "A1", what: "a thing", done: true, verify: "true" }],
  ...over,
});

describe("the live ladder", () => {
  test("is internally consistent", () => {
    expect(stageLadderViolations(stages), "project-state.json `stages` is malformed").toEqual([]);
  });

  test("every DONE item's verify command exits 0 — this is what 'done' means", () => {
    const checked: string[] = [];
    const failed: string[] = [];
    const deferred: string[] = [];

    for (const stage of stages) {
      for (const item of stage.items) {
        if (!item.done) continue;
        if (item.scope === "machine") {
          deferred.push(item.id);
          continue;
        }
        checked.push(item.id);
        const r = run(item.verify!);
        if (r.status !== 0) {
          failed.push(
            `${item.id} exited ${r.status}: ${item.verify}\n` +
              `     ${item.what}\n` +
              `     ${(r.stderr || r.stdout || "(no output)").trim().slice(0, 300)}`,
          );
        }
      }
    }

    // A run that checked nothing is not a run that passed. Without this the
    // whole case is green on an empty `stages`, which is the vacuous shape.
    expect(checked.length, "no repo-scoped done items were executed, so this case witnessed nothing").toBeGreaterThan(0);

    expect(
      deferred.length,
      `${deferred.length} done item(s) have evidence outside this repository (${deferred.join(", ") || "none"}) ` +
        `and were NOT executed. The allowance is ${MACHINE_SCOPED_ALLOWED}. A new one means a stage item ` +
        `CI can never check — decide that deliberately and raise this constant with a reason, or move the ` +
        `evidence into the repository.`,
    ).toBe(MACHINE_SCOPED_ALLOWED);

    expect(
      failed,
      `a stage item is marked done and its own verify command refuses. Either the work regressed or the ` +
        `item was ticked without the command being run. Do not weaken the command to make this pass.`,
    ).toEqual([]);
  });

  test("Stage A is complete and Stage B is the next thing, blocked on Jason", () => {
    const a = stages.find(s => s.id === "A")!;
    expect(stageIsComplete(a), "Stage A is no longer complete").toBe(true);

    const next = nextStage(stages);
    expect(next?.stage.id, "the next incomplete stage is not B").toBe("B");
    expect(
      next?.blocked,
      "Stage B is no longer reported as blocked. It is the one stage Jason has not signed off — if that " +
        "changed, the change belongs in `agreed`, and this assertion should be updated in the same commit.",
    ).toContain("agreed: null");
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
    // ADR-009 inserted a new Stage B and pushed every later letter down.
    // The old ladder could not see it; this is that drift, planted.
    const v = stageLadderViolations([ok(), ok({ id: "C", items: [] })]);
    expect(v.join("\n")).toContain('but it sits at position 1');
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
    // Without this, every case above is satisfied by a function that returns
    // a violation for everything.
    expect(stageLadderViolations([ok()])).toEqual([]);
  });

  test("stages must be an array", () => {
    expect(stageLadderViolations(undefined).join("")).toContain("not an array");
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

  test("nextStage skips complete stages and returns null when everything is done", () => {
    expect(nextStage([ok()])).toBeNull();
  });
});
