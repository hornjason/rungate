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
  ITEM_SCOPES,
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

/**
 * How many done items may need a credential CI does not hold. **Zero.**
 *
 * It was one for part of 2026-11-02. B4 reads the board's Criteria column,
 * a ProjectV2 custom field on a USER-level project, and
 * `secrets.GITHUB_TOKEN` is repository-scoped — run `41406458500` has B1
 * and B3 passing in the same shard B4 failed in, on the same token, which
 * is the control that named the variable.
 *
 * Jason added a `read:project` secret the same day and
 * `ci.trackerTokenSecret` now names it, so B4 is executed by CI like any
 * other item and the debt is paid. The scope itself stays in
 * {@link ITEM_SCOPES} — the mechanism is still the right answer the next
 * time evidence sits behind a credential, and deleting it would mean
 * rediscovering it under a red build.
 *
 * An equality, like {@link MACHINE_SCOPED_ALLOWED}, and now at the floor:
 * any rise is a stage item becoming unverifiable in CI and needs somebody
 * to edit this line and say why.
 */
const CREDENTIALED_ALLOWED = 0;

/**
 * How long the whole loop below gets. Some of its verify commands read the
 * live GitHub API and they run one after another, so this is a sum.
 *
 * Measured 2026-11-02: the whole loop, 4.9s. An order of magnitude of
 * headroom — room for a slow API, and not enough for a hung command to
 * hold CI open.
 *
 * **No count of API-backed items is stated here, deliberately.** Two
 * revisions of this comment carried one and both were wrong: the first
 * said "four" when B5 runs `--list-readings` and opens no connection, and
 * it stayed wrong when B4 became `credentialed` and stopped being
 * executed at all. A number in a comment is a second decider that nothing
 * runs. What catches a budget that has gone tight is the `failed`
 * assertion's own message: a killed command is reported as `exited null`,
 * and that message says to raise this constant rather than untick a true
 * item.
 */
const LIVE_VERIFY_BUDGET_MS = 60_000;

/**
 * How many stages are finished. An EQUALITY, so it refuses a fall as well
 * as a rise: completing a stage is a deliberate edit here, and a stage
 * going backwards is a regression rather than a number somebody lowers.
 *
 * Stage A completed 2026-10-31, Stage B 2026-11-02.
 */
const COMPLETE_STAGES = 2;

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
    // Timeout is EXPLICIT below, and it has to be. Items here read the live
    // GitHub API and run in sequence, and Bun's 5s default killed this the
    // moment B4 was ticked and added one more: `spawnSync` was cut mid-call
    // and the item was reported as `exited null`, which reads exactly like
    // the work regressing. A ladder item that is slow is not a ladder item
    // that failed, so the budget is stated rather than inherited — see
    // LIVE_VERIFY_BUDGET_MS for which items it covers and the measurement.
    const checked: string[] = [];
    const failed: string[] = [];
    const deferred: string[] = [];
    const credentialed: string[] = [];
    const unmeasured: string[] = [];

    for (const stage of stages) {
      for (const item of stage.items) {
        if (!item.done) continue;
        if (item.scope === "machine") {
          deferred.push(item.id);
          continue;
        }
        // Not run, for the same reason `machine` is not: the runner cannot
        // reach the evidence. Counted on the DECLARATION rather than on a
        // failure, so this case reads identically on a laptop holding a
        // `read:project` PAT and on a CI runner holding none — a tally that
        // differs by environment measures the environment.
        if (item.scope === "credentialed") {
          credentialed.push(item.id);
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
      credentialed.length,
      `${credentialed.length} done item(s) need a credential CI does not hold ` +
        `(${credentialed.join(", ") || "none"}) and were NOT executed. The allowance is ` +
        `${CREDENTIALED_ALLOWED}. If this ROSE, a stage item just became unverifiable in CI — decide that ` +
        `deliberately and raise the constant with a reason. If it FELL because CI gained a read:project ` +
        `token, drop the item's scope back to the default and lower the constant in the same commit; that ` +
        `is the direction this debt is meant to move.`,
    ).toBe(CREDENTIALED_ALLOWED);

    expect(
      failed,
      `a stage item is marked done and its own verify command refuses. Either the work regressed or the item ` +
        `was ticked without the command being run. Do not weaken the command to make this pass. An item ` +
        `reported as "exited null" was KILLED, not refused — raise LIVE_VERIFY_BUDGET_MS rather than ` +
        `unticking the item.`,
    ).toEqual([]);
  }, LIVE_VERIFY_BUDGET_MS);

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

  test("every complete stage carries a retro, and the next one is agreed and unblocked", () => {
    // This case used to name Stage A and Stage B as literals, and it went
    // red the moment Stage B completed — correct work, red suite, in a file
    // the work never opened. That is the stale-copy class Stage B's own
    // retro names twice, reproduced inside the ladder that records it. So
    // the letters are derived now and only the COUNT is written down.
    const complete = stages.filter(stageIsComplete);
    expect(
      complete.length,
      `COMPLETE_STAGES says ${COMPLETE_STAGES} stage(s) are finished and ${complete.length} are. ` +
        "This is an EQUALITY: a stage completing is a deliberate edit here, and a stage going " +
        "backwards is a regression, not a number to lower quietly.",
    ).toBe(COMPLETE_STAGES);

    for (const s of complete) {
      expect(s.retro, `Stage ${s.id} is complete and has no retro — it would teach nothing`).not.toBeNull();
      expect(s.retro!.improvements.length, `Stage ${s.id}'s retro lists no improvements`).toBeGreaterThan(0);
    }

    const next = nextStage(stages);
    // Assert on `next`, NOT on `next?.stage`. `nextStage` returns a BARE
    // `null` once every stage is done and no retro is owed — not
    // `{stage: null}` — so `next?.stage` is `undefined` there, and
    // `expect(undefined).not.toBeNull()` passes. That spelling shipped for
    // one round and the review caught it: the row meant to announce "every
    // stage is complete" was vacuous in exactly that case, and the test
    // only failed two lines later with `Stage undefined has no agreed`.
    // The second line is not redundant — a reading WITH a null stage is a
    // different fact from no reading at all, and only this spelling can
    // tell them apart.
    expect(next, "every stage is complete — say so rather than deleting this assertion").not.toBeNull();
    expect(next!.stage, "nextStage returned a reading whose stage is null").not.toBeNull();
    // Jason agreed A and C..F on 2026-10-30 and B on 2026-11-01. Before
    // that this read `toContain("agreed: null")` for B — the gate did its
    // job for the whole time that stage was a proposal.
    expect(
      next?.stage?.agreed,
      `Stage ${next?.stage?.id} has no \`agreed\` — it may not be worked until its wording is signed off`,
    ).toBeTruthy();
    expect(
      next?.blocked,
      `Stage ${next?.stage?.id} is reported blocked. Either a prior stage lost its retro, or something ` +
        "else came up — read the message rather than deleting this assertion.",
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
    // run still sees what is outstanding — and COUNTED by the case below,
    // because a `console.log` in a passing run is not a reader.
    for (const o of openImprovements(stages)) console.log(`  OPEN improvement (stage ${o.stage}): ${o.what}`);
  });

  /**
   * #1745 — an open improvement that is on nothing but this file.
   *
   * `openImprovements` was printed into a passing run and counted nowhere,
   * so three improvements that nothing can measure were invisible: this
   * suite scores stage ITEMS, an improvement is not an item, and Stage B
   * therefore read complete while two of its improvements were outstanding.
   * That is how *is Stage B done?* got two different answers in one session,
   * and it is SUCCESS.md claim 4 — *could not measure* reading as *nothing
   * wrong*.
   *
   * **The rule being ratcheted toward: an `open` improvement carries an
   * `issue`.** Not a `verify` — `Improvement.verify` is REFUSED on `open`
   * ("an open improvement with a command would be claiming the thing it says
   * is missing"), so demanding one would make `open` unrepresentable and the
   * only way to satisfy both rules would be to delete the record. #1745's
   * acceptance text asked for the verify version; that contradiction is
   * recorded on the issue.
   */
  // Emptied 2026-11-06. All three were filed through ADR-012's plan route:
  // #1816 (A), #1817 (B) and #1818 (B). #1817 is no longer open at all — it
  // shipped in #1819/#1820 and is now `in-place` with a verify command — so
  // the two that remain open both carry an `issue` and neither is unfiled.
  //
  // This list only ever shrinks, and it is now empty. A new entry here is not
  // the way to record a new outstanding improvement: file it (#1745).
  const OPEN_WITHOUT_ISSUE: string[] = [];

  test("every open improvement is on the tracker, or declared here as not yet", () => {
    const unfiled = openImprovements(stages)
      .filter(im => im.issue === undefined)
      .map(im => `${im.stage}: ${im.what}`);

    // An EQUALITY, both directions, which is the whole point of a ratchet.
    // Over it: a fourth improvement became outstanding with no issue and
    // nobody declared it. Under it: one was filed and this constant was not
    // edited in the same commit, so the number drifts downward on its own
    // and stops meaning anything — the shape `.claude/rules/
    // checks-must-be-able-to-fail.md` calls a ratchet nobody can interpret.
    expect(
      unfiled,
      `${OPEN_WITHOUT_ISSUE.length} open improvement(s) are declared as not yet filed and ${unfiled.length} are.\n` +
        "If you filed one, set `issue` on it in project-state.json AND delete its line from " +
        "OPEN_WITHOUT_ISSUE in this file, in the same commit. If a NEW one is outstanding, file it " +
        "(#1745) rather than adding a line here — this list only shrinks.",
    ).toEqual(OPEN_WITHOUT_ISSUE);
  });

  test("CONTROL: an open improvement carrying an issue is NOT in the unfiled set", () => {
    // Without this row the case above is satisfied by a reading that calls
    // every open improvement unfiled, which is also what a broken `issue`
    // field produces. Stage B has two improvements that DO carry issues —
    // #1727 and #1728 — and they are in-place, so the live ladder cannot
    // supply this contrast. It is constructed.
    const filed = openImprovements([
      {
        id: "Z",
        retro: {
          wentWell: [],
          wentPoorly: [],
          improvements: [
            { what: "filed", mechanism: "none yet", status: "open", verify: null, issue: 4242 },
            { what: "unfiled", mechanism: "none yet", status: "open", verify: null },
          ],
        },
      } as never,
    ]);

    expect(filed.filter(im => im.issue === undefined).map(im => im.what)).toEqual(["unfiled"]);
  });

  test("an improvement cannot name its own stage — the computed field wins", () => {
    // Security review of #1812. `{ stage: s.id, ...im }` lets data in
    // project-state.json overwrite the stage computed from the stage the
    // improvement is actually IN — and OPEN_WITHOUT_ISSUE above matches on
    // `${stage}: ${what}`, so a forged `stage` key could tick a ratchet line
    // reserved for a different improvement. The computed field is the
    // identity, so it goes last.
    const out = openImprovements([
      {
        id: "Z",
        retro: {
          wentWell: [],
          wentPoorly: [],
          improvements: [{ what: "x", mechanism: "none yet", status: "open", verify: null, stage: "A" }],
        },
      } as never,
    ]);

    expect(out[0].stage, "data overrode the stage this improvement is in").toBe("Z");
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

  test("an improvement's issue link must be a real issue number, and a valid one is allowed", () => {
    // Review of #1729: Stage B's retro gained `issue` on two improvements and
    // nothing declared or checked the field, so `"1727"`, `0` and a typo all
    // read as a link. An open improvement that is only a note is the shape
    // rule 10 exists to refuse, so the link has to be the kind a tracker can
    // resolve.
    const bad = (issue: unknown) =>
      stageLadderViolations([
        ok({ retro: retro({ improvements: [{ what: "x", mechanism: "y", status: "open", verify: null, issue } as never] }) }),
      ]).join("\n");
    expect(bad("1727")).toContain("expected a positive integer issue number");
    expect(bad(0)).toContain("expected a positive integer issue number");
    expect(bad(17.5)).toContain("expected a positive integer issue number");
    // The control: the field is OPTIONAL and a real number passes, or the
    // check above would be satisfied by a validator that refuses every issue.
    expect(bad(1727)).not.toContain("issue");
    expect(
      stageLadderViolations([
        ok({ retro: retro({ improvements: [{ what: "x", mechanism: "y", status: "open", verify: null }] }) }),
      ]).join("\n"),
    ).not.toContain("issue");
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
    expect(v.join("\n")).toContain('expected "repo", "machine", "credentialed" or absent');
  });

  // The refusal message is GENERATED from `ITEM_SCOPES`, so a scope added to
  // the type and forgotten in a hand-written sentence cannot happen. Without
  // this the case above passes against a message that omits a legal value —
  // and the agent reading it deletes a correct scope.
  test("every legal scope is accepted, and the refusal names all of them", () => {
    for (const scope of ITEM_SCOPES) {
      expect(
        stageLadderViolations([ok({ items: [{ id: "A1", what: "x", done: true, verify: "true", scope }] })]),
        `scope ${JSON.stringify(scope)} is in ITEM_SCOPES and was refused`,
      ).toEqual([]);
    }
    const v = stageLadderViolations([
      ok({ items: [{ id: "A1", what: "x", done: true, verify: "true", scope: "nope" as never }] }),
    ]).join("\n");
    for (const scope of ITEM_SCOPES) expect(v).toContain(`"${scope}"`);
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
    expect(blocked?.stage?.id).toBe("B");
    expect(blocked?.blocked).toContain("is complete and has no retro");
  });

  test("the same pair with the retro written is not blocked — the control", () => {
    const free = nextStage([
      ok(),
      ok({ id: "B", items: [{ id: "B1", what: "x", done: false, verify: null }] }),
    ]);
    expect(free?.stage?.id).toBe("B");
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
