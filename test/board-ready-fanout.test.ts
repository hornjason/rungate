/**
 * When a blocker closes, what the issues it was blocking should become.
 *
 * #1744. Ready is reachable today only by someone running `board-mirror
 * --ready --write` by hand, which is Claim 7's third falsification verbatim:
 * *a board state reachable only by someone running a command by hand*.
 *
 * ## The thing this must not do
 *
 * **Decide readiness.** `isReady` in `lib/board-mirror.ts` already does, and
 * it carries the phase-frontier rule that stopped the lane holding 36 of 46
 * open issues. A second decider here would agree with it on every input
 * anybody tests, so no behavioural case could tell which of the two was live,
 * and a mutation of either would leave the other holding the case up
 * (`.claude/rules/checks-must-be-able-to-fail.md`). BR-7 asserts the
 * agreement across a generated grid rather than trusting the import.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { isReady } from "../lib/board-mirror";
import {
  actorMayWrite,
  fanoutDecisions,
  readBoardCredential,
  truncatedReadings,
  type Dependent,
} from "../lib/board-ready-fanout";

const ROOT = join(import.meta.dir, "..");

const dep = (over: Partial<Dependent> = {}): Dependent => ({
  number: 1,
  state: "OPEN",
  phase: 3,
  blockedByOpen: 0,
  assignees: 0,
  boardStatus: "Backlog",
  ...over,
});

describe("BR-1..BR-6: the fan-out from one closed blocker", () => {
  // The case in the issue, exactly: two dependents, one of which has a second
  // open blocker. The first moves; the second does not.
  test("BR-1: a freed dependent moves, one still blocked does not", () => {
    const out = fanoutDecisions([dep({ number: 10 }), dep({ number: 11, blockedByOpen: 1 })], 3, "Ready");
    expect(out.filter(d => d.move).map(d => d.number)).toEqual([10]);
    const held = out.find(d => d.number === 11)!;
    expect(held.move).toBe(false);
    if (!held.move) expect(held.why).toContain("blocker");
  });

  // Membership is board-mirror's job. An Action that ADDS items would make
  // the board's contents depend on which issues happened to close, which is
  // a different and much larger claim than the one #1744 makes.
  test("BR-2: an issue that is not on the board is left alone, not added", () => {
    const [d] = fanoutDecisions([dep({ boardStatus: null })], 3, "Ready");
    expect(d.move).toBe(false);
    if (!d.move) expect(d.why).toContain("not on the board");
  });

  // Idempotence. The trigger is `issues: [closed]`, and a close can be
  // delivered more than once; a second delivery must write nothing.
  test("BR-3: an issue already in Ready is not rewritten", () => {
    const [d] = fanoutDecisions([dep({ boardStatus: "Ready" })], 3, "Ready");
    expect(d.move).toBe(false);
    if (!d.move) expect(d.why).toContain("already");
  });

  // The phase-frontier rule, inherited rather than restated. A dependent in
  // a later phase is unblocked and still not next.
  test("BR-4: a later phase is unblocked and still not Ready", () => {
    const [d] = fanoutDecisions([dep({ phase: 7 })], 3, "Ready");
    expect(d.move).toBe(false);
  });

  test("BR-5: an assigned dependent is somebody's, not Ready", () => {
    expect(fanoutDecisions([dep({ assignees: 1 })], 3, "Ready")[0].move).toBe(false);
  });

  // The blocker that closed is itself a dependent of nothing; but a dependent
  // that closed in the same window must not be moved into Ready.
  test("BR-6: a CLOSED dependent is never moved", () => {
    expect(fanoutDecisions([dep({ state: "CLOSED" })], 3, "Ready")[0].move).toBe(false);
  });
});

describe("BR-17..BR-20: UNMEASURED never moves, and the reads do not truncate", () => {
  // `issueDependenciesSummary` is absent on a response the token was not
  // scoped for. `?? 0` read that as "nothing is blocking it" and moved a
  // genuinely blocked issue to Ready — the fail-open shape, in the one place
  // where it writes to the board.
  test("BR-17: an unreadable blocker count does not move the issue", () => {
    const [d] = fanoutDecisions([dep({ blockedByOpen: null })], 3, "Ready");
    expect(d.move).toBe(false);
    if (!d.move) expect(d.why).toContain("UNMEASURED");
  });

  // The positive control: the same issue with a READ count of zero does
  // move, so BR-17 is not green because nothing ever moves.
  test("BR-18: a measured zero is not the same reading, and does move", () => {
    expect(fanoutDecisions([dep({ blockedByOpen: 0 })], 3, "Ready")[0].move).toBe(true);
  });

  // Every list read in the script pages. This is the third time this shape
  // has been found on this day's work — twice on #1740's reader and once
  // here — so it is asserted as a census over the file's GraphQL list
  // selections rather than against `blocking` alone.
  test("BR-19: every GraphQL list in the script declares its own truncation", () => {
    const src = readFileSync(join(ROOT, "scripts/board-ready.ts"), "utf-8");
    for (const sel of ["blocking(first:100,after:$c)", "items(first:100,after:$c)"]) {
      expect(src, `${sel} missing — a list that can grow must carry a cursor`).toContain(sel);
    }
    expect(src).not.toContain("blocking(first:50)");
    // **The census, widened.** Its first version exempted `projectItems` and
    // `fieldValues` as "per-issue sub-selections with hard upper bounds" —
    // an exemption by reasoning, which is the same mistake that put a
    // comment-shaped carve-out into #1740's token-host case. Review found
    // it, and that was the FOURTH unpaginated read on one day's work.
    //
    // So: every `first:` in the file asks for a full page, and every one is
    // accompanied by a `pageInfo` — either cursored, or checked for
    // truncation and refused. A new selection cannot be added without one.
    //
    // Comment lines are stripped first: this file's own prose says
    // `first: 50` while recounting the finding, and a census that reads its
    // own explanation is measuring the wrong text.
    const code = src
      .split("\n")
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    const firsts = [...code.matchAll(/\bfirst:\s*(\d+)/g)].map(m => Number(m[1]));
    expect(firsts.length).toBeGreaterThanOrEqual(5);
    for (const n of firsts) expect(n, `a first:${n} asks for less than a page`).toBe(100);
    expect([...code.matchAll(/pageInfo\{hasNextPage/g)].length).toBe(firsts.length);
  });

  // The two sub-selections are bounded in practice and are read anyway as
  // readings that can fail. A Status field on page two and no Status field
  // at all are the same `undefined`, and only one of them means "leave it".
  test("BR-23: a truncated projectItems or fieldValues page is reported, not ignored", () => {
    const whole = { number: 1, projectItems: { pageInfo: { hasNextPage: false }, nodes: [] } };
    const itemsCut = { number: 2, projectItems: { pageInfo: { hasNextPage: true }, nodes: [] } };
    const fieldsCut = {
      number: 3,
      projectItems: { pageInfo: { hasNextPage: false }, nodes: [{ fieldValues: { pageInfo: { hasNextPage: true } } }] },
    };
    expect(truncatedReadings([whole, itemsCut, fieldsCut])).toEqual([2, 3]);
    // the positive control: a complete reading reports nothing, so the case
    // above is not green because every input is called truncated
    expect(truncatedReadings([whole])).toEqual([]);
  });

  // `continue-on-error: true` turns a GraphQL error, a bad argument and a
  // board with no Ready option all green. That is the silent pass the
  // credential handling exists to refuse, one level up.
  // `Number(null)` is 0 and `Number.isFinite(0)` is true, so the original
  // guard passed a MISSING `--closed-issue` through and fanned out from
  // issue 0. Run rather than read: the guard sits before any network call,
  // so the refusal is observable without a token.
  test("BR-21: a missing or non-positive --closed-issue is refused", async () => {
    const base = ["--repo", "o/n", "--project", "PVT_x"];
    for (const extra of [[], ["--closed-issue", "0"], ["--closed-issue", "-3"], ["--closed-issue", "x"]]) {
      const p = Bun.spawnSync(["bun", "scripts/board-ready.ts", ...base, ...extra], {
        cwd: ROOT,
        env: { ...process.env, BOARD_PROJECT_TOKEN: "" },
      });
      const err = new TextDecoder().decode(p.stderr);
      expect(p.exitCode, `${extra.join(" ") || "(no flag)"} was not refused`).toBe(2);
      expect(err).toContain("UNMEASURED");
    }
  }, 30_000);

  // The positive control for BR-21: a well-formed invocation gets PAST the
  // argument guard and refuses on the credential instead, so BR-21 is not
  // green because every invocation exits 2 for the same reason.
  test("BR-22: a valid issue number reaches the credential check", async () => {
    const p = Bun.spawnSync(
      ["bun", "scripts/board-ready.ts", "--repo", "o/n", "--project", "PVT_x", "--closed-issue", "7"],
      { cwd: ROOT, env: { ...process.env, BOARD_PROJECT_TOKEN: "" } },
    );
    expect(new TextDecoder().decode(p.stdout)).toContain("BOARD_PROJECT_TOKEN");
    expect(new TextDecoder().decode(p.stderr)).not.toContain("positive integer");
  }, 30_000);

  test("BR-20: the step does not swallow its own failures", () => {
    const yml = readFileSync(join(ROOT, ".github/workflows/board-ready.yml"), "utf-8");
    for (const line of yml.split("\n")) {
      if (/^\s*continue-on-error:/.test(line)) expect(line).toContain("false");
    }
  });
});

describe("BR-7: the verdict is isReady's, and the reason cannot change it", () => {
  // A grid over every axis isReady reads. If the module ever grows its own
  // opinion — a reason string that also decides, a short-circuit that looks
  // like an optimisation — one of these rows disagrees.
  test("BR-7: move equals isReady on every combination, for a board issue", () => {
    const states = ["OPEN", "CLOSED"];
    const phases: (number | null)[] = [null, 3, 7];
    const frontiers: (number | null)[] = [null, 3];
    let compared = 0;
    let unmeasured = 0;
    for (const state of states)
      for (const phase of phases)
        // `null` joined this axis in review: an unreadable blocker count is
        // the one input where `isReady` has no answer to agree with, so the
        // grid asserts a DIFFERENT property for those rows — never moves.
        for (const blockedByOpen of [0, 2, null])
          for (const assignees of [0, 1])
            for (const frontier of frontiers) {
              const d = dep({ state, phase, blockedByOpen, assignees });
              const [got] = fanoutDecisions([d], frontier, "Ready");
              if (blockedByOpen === null) {
                expect(got.move).toBe(false);
                unmeasured++;
              } else {
                expect(got.move).toBe(isReady({ ...d, blockedByOpen }, frontier));
                compared++;
              }
            }
    // The grid is the instrument; one that shrank to nothing would pass
    // vacuously, and both halves have to be non-empty for the split above
    // to mean anything.
    expect(compared).toBe(48);
    expect(unmeasured).toBe(24);
  });

  test("BR-8: and a row of that grid genuinely moves — the grid is not all false", () => {
    expect(fanoutDecisions([dep()], 3, "Ready").filter(d => d.move).length).toBe(1);
  });
});

describe("BR-9..BR-11: an absent credential is UNMEASURED, never a quiet zero", () => {
  // `GITHUB_TOKEN` cannot write ProjectsV2 — researched against docs.github.com
  // on 2026-11-03 — so this needs a PAT or an App. A run with neither has not
  // found nothing to move; it has not looked (`.claude/rules/config-access.md`).
  test("BR-9: no token is UNMEASURED and names the variable", () => {
    const r = readBoardCredential({});
    expect(r.kind).toBe("UNMEASURED");
    if (r.kind === "UNMEASURED") expect(r.why).toContain("BOARD_PROJECT_TOKEN");
  });

  test("BR-10: an empty or whitespace token is absent, not present", () => {
    expect(readBoardCredential({ BOARD_PROJECT_TOKEN: "" }).kind).toBe("UNMEASURED");
    expect(readBoardCredential({ BOARD_PROJECT_TOKEN: "   " }).kind).toBe("UNMEASURED");
  });

  // The positive control, so BR-9 and BR-10 are not green because the reader
  // returns UNMEASURED for everything.
  test("BR-11: a token present reads present, and is not trimmed into something else", () => {
    const r = readBoardCredential({ BOARD_PROJECT_TOKEN: " ghp_x " });
    expect(r.kind).toBe("present");
    if (r.kind === "present") expect(r.token).toBe("ghp_x");
  });
});

describe("BR-12..BR-14: the workflow is wired the way the rules require", () => {
  const yml = readFileSync(join(ROOT, ".github/workflows/board-ready.yml"), "utf-8");

  // There is no "became unblocked" event. `issue_dependencies` is a webhook
  // and not a valid Actions trigger, and `blocked_by_removed` fires when
  // somebody unlinks a dependency rather than when the blocker closes.
  test("BR-12: it triggers on a closed issue, and runs on no schedule", () => {
    expect(yml).toContain("issues:");
    expect(yml).toContain("closed");
    // A cron is the thing #1744 exists to avoid. Jason: no schedules.
    expect(yml).not.toContain("schedule:");
    expect(yml).not.toContain("cron:");
  });

  // `secrets` is not available in `if:` at all, and a step skipped by `if:`
  // reports SKIPPED — which a required check can treat as satisfied. The mode
  // is resolved inside `run:` (`.claude/rules/config-access.md`).
  test("BR-13: the credential is never read in an if: expression", () => {
    for (const line of yml.split("\n")) {
      if (/^\s*if:/.test(line)) expect(line).not.toContain("BOARD_PROJECT_TOKEN");
    }
    expect(yml).toContain("BOARD_PROJECT_TOKEN: ${{ secrets.BOARD_PROJECT_TOKEN }}");
  });

  // Every `uses:` pinned to a commit SHA — asserted here as well as by
  // `test/action-pin-parity.test.ts`, because this file is new.
  test("BR-14: every action is pinned to a 40-character SHA", () => {
    const uses = [...yml.matchAll(/^\s*- uses:\s*(\S+)/gm)].map(m => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });

  // The workflow and the entry point have to agree on a path, and nothing
  // else in the tree relates them — a renamed script leaves a workflow that
  // fails only when an issue closes in production.
  test("BR-15: the workflow invokes scripts/board-ready.ts, which exists", () => {
    expect(yml).toContain("bun scripts/board-ready.ts");
    expect(readFileSync(join(ROOT, "scripts/board-ready.ts"), "utf-8")).toContain("fanoutDecisions");
  });

  // **The gate that was wrong.** The first version read
  // `github.event.issue.author_association` in an `if:`, which describes
  // whoever OPENED the issue and never whoever closed it. The damaging
  // direction is the ordinary one: a maintainer closing an outside
  // contributor's issue was refused, so the feature silently did not work
  // for exactly the issues most likely to be filed from outside.
  test("BR-24: the trust gate names the acting identity, not the issue's author", () => {
    // Comment lines excluded — the file explains the mistake at length, and
    // a check that reads the explanation refuses the record of the fix.
    const live = yml.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
    expect(live, "author_association describes the wrong person").not.toContain("author_association");
    expect(live).toContain("github.actor");
    expect(live).toContain("--actor");
  });

  test("BR-25: only a writing permission may move the board", () => {
    for (const p of ["admin", "write", "maintain"]) expect(actorMayWrite(p), `${p} should write`).toBe(true);
    for (const p of ["read", "none", "triage", ""]) expect(actorMayWrite(p), `${p} must not write`).toBe(false);
  });

  // UNMEASURED, not zero, in the place it decides a write: a permission the
  // run could not read is not a permission it was granted.
  test("BR-26: an unreadable permission refuses", () => {
    expect(actorMayWrite(null)).toBe(false);
  });

  // The gate decides before the first mutation and after the dry-run exit,
  // so a report-only run still reports. Asserted on order, because a check
  // placed after the write is a check that observed the write.
  test("BR-27: the permission check precedes every updateProjectV2ItemFieldValue", () => {
    const src = readFileSync(join(ROOT, "scripts/board-ready.ts"), "utf-8");
    const gate = src.indexOf("actorMayWrite(permission)");
    const write = src.indexOf("updateProjectV2ItemFieldValue");
    expect(gate, "the gate is not called at all").toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(gate);
  });

  // The untrusted-input rule, as a case. `github.event.issue.*` interpolated
  // into a `run:` line is the injection GitHub's own guidance opens with.
  test("BR-16: no github.event value is interpolated into a run: line", () => {
    for (const line of yml.split("\n")) {
      if (/^\s*(run:|\s{4,}\S.*)/.test(line) && line.includes("${{") && line.includes("github.event")) {
        expect(line).toMatch(/^\s*\w[\w-]*:\s*\$\{\{/); // an env: assignment, not a command
      }
    }
  });
});
