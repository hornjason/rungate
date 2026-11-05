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
import { isReady, isUnblocked } from "../lib/board-mirror";
import {
  actorMayWrite,
  WRITING_PERMISSIONS,
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
  onBoard: true,
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
    const [d] = fanoutDecisions([dep({ onBoard: false, boardStatus: null })], 3, "Ready");
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

  /**
   * Three board states, and `boardStatus: string | null` could only spell two.
   *
   * GraphQL returns a `ProjectV2ItemFieldSingleSelectValue` node only for a
   * field that already HAS a value. An item added to the project whose Status
   * was never set returns no such node, so `statusValue?.name ?? null` gave
   * exactly the `null` that "this issue is not on the board at all" gives —
   * and the reason printed for it was "not on the board", which is false.
   *
   * The cost is not a wrong move; neither state moves. It is that the log
   * sends the reader to `board-mirror` to add an item that is already there,
   * and the real obstacle — no Status value, therefore no field id to write
   * through — is never named. `onBoard` is the axis that separates them.
   */
  test("BR-28: on the board with no Status is not the same reading as absent from it", () => {
    const [absent] = fanoutDecisions([dep({ onBoard: false, boardStatus: null })], 3, "Ready");
    const [unset] = fanoutDecisions([dep({ onBoard: true, boardStatus: null })], 3, "Ready");
    expect(absent.move).toBe(false);
    expect(unset.move).toBe(false);
    if (absent.move || unset.move) throw new Error("unreachable — both are refusals");
    // The whole point of the row: two refusals that do not say the same thing.
    expect(absent.why).not.toBe(unset.why);
    expect(absent.why).toContain("not on the board");
    expect(unset.why).toContain("UNMEASURED");
    expect(
      unset.why,
      "an item on the board with no Status must not be reported as absent from the board",
    ).not.toContain("not on the board");
  });

  /**
   * The same fail-open shape as `blockedByOpen`, on the field beside it.
   *
   * `b.assignees?.totalCount ?? 0` reads an unreadable assignee count as
   * "nobody has claimed it", which is the direction that MOVES — an issue
   * somebody is already working on lands in Ready. `blockedByOpen` was fixed
   * to `null` for exactly this and the sibling field was left; BR-31 is the
   * structural half, so a third field cannot arrive with `?? 0`.
   */
  test("BR-29: an unreadable assignee count does not move the issue", () => {
    const [d] = fanoutDecisions([dep({ assignees: null })], 3, "Ready");
    expect(d.move).toBe(false);
    if (!d.move) expect(d.why).toContain("UNMEASURED");
  });

  // The positive control, so BR-29 is not green because nothing moves.
  test("BR-30: a measured zero assignees is a reading, and does move", () => {
    expect(fanoutDecisions([dep({ assignees: 0 })], 3, "Ready")[0].move).toBe(true);
  });

  /**
   * What BR-29 is actually witnessing, measured rather than assumed.
   *
   * The battery for BR-29 removed `fanoutDecisions`' own `assignees === null`
   * refusal and every row stayed green, which is the fourth shape in
   * `.claude/rules/checks-must-be-able-to-fail.md`: two guards answering one
   * question, so no behavioural case can say which is live. `isUnblocked`
   * compares `assignees === 0`, and `null === 0` is false, so it already
   * refuses — today, by strict equality, in another module.
   *
   * The guard upstream is kept for the reason the sibling one was: it stops a
   * `null` reaching a parameter typed `number`, so the decider is never asked
   * a question it cannot answer. But its redundancy means the live refusal is
   * this equality, and nothing asserted it. `!assignees` and `assignees < 1`
   * are both ordinary simplifications and both read an unread count as
   * "nobody has claimed it" — the direction that MOVES.
   */
  test("BR-32: the readiness equality is strict, so an unread count is not a zero", () => {
    expect(isUnblocked({ blockedBy: 0 }, 0), "the measured-zero control").toBe(true);
    expect(
      isUnblocked({ blockedBy: 0 }, null as unknown as number),
      "an unread assignee count must not satisfy the readiness rule — `!assignees` and " +
        "`assignees < 1` both do, and both move an issue somebody is already working on",
    ).toBe(false);
    expect(
      isUnblocked({ blockedBy: null as unknown as number }, 0),
      "an unread blocker count must not satisfy it either",
    ).toBe(false);
  });

  /**
   * The class, not the instance. Rounds 1-7 of #1747 fixed fail-open numeric
   * defaults one field at a time — `blockedByOpen`, then `Number(null)` as a
   * valid `--closed-issue`, then `assignees` — and nothing stopped the next
   * one. This reads the object literal that builds a `Dependent` and refuses
   * any `?? <number>` in it: an absent reading is `null`, which never moves.
   */
  test("BR-31: no field of a Dependent defaults an unreadable value to a number", () => {
    const src = readFileSync(join(ROOT, "scripts/board-ready.ts"), "utf-8");
    const literal = /const dependents: Dependent\[\] = blocking\.map\(\(b: any\) => \{([\s\S]*?)\n {2}\}\);/
      .exec(src)?.[1];
    // ANTI-VACUITY. A detector that found nothing and a tree with no defaults
    // produce the same empty list, and the second is the one worth believing
    // only once the first is ruled out.
    expect(
      literal,
      "the `blocking.map(...)` that builds Dependent was not found in scripts/board-ready.ts — " +
        "this row would pass vacuously. Fix the pattern, do not delete the row.",
    ).toBeTruthy();
    // A DETECTOR THAT READS A WHOLE BLOCK READS ITS COMMENTS. The first
    // spelling of this row went red on the two comments warning the next
    // person off `?? 0` — a guard that cannot tell a default from a sentence
    // about one gets relaxed rather than obeyed. Comments are stripped before
    // anything is counted, and the field census below runs on the stripped
    // text so the stripping cannot quietly take the code with it.
    const code = (literal ?? "")
      .split("\n")
      .map(l => l.trim())
      .filter(l => l !== "" && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
    const body = code.join("\n");
    for (const field of ["number:", "state:", "phase:", "blockedByOpen:", "assignees:", "onBoard:", "boardStatus:"]) {
      expect(body, `the matched literal does not contain ${field} — it matched the wrong block`).toContain(field);
    }
    const defaults = code.filter(l => /\?\?\s*-?\d/.test(l));
    expect(
      defaults,
      "a field of Dependent substitutes a number for a reading that could not be taken. " +
        "`?? 0` on assignees says 'nobody has claimed it' and MOVES the issue; on a blocker " +
        "count it says 'nothing is blocking it' and moves it too. Use `null` — UNMEASURED never moves " +
        "(`.claude/rules/config-access.md`, Silent Default Substitution).",
    ).toEqual([]);
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
    // **This used to require every `first:` to be exactly 100, and that rule
    // is unsatisfiable.** GitHub multiplies the page sizes down a nesting
    // chain and rejects the query above 500,000 possible nodes, so a
    // three-deep chain of `first:100` could never be sent — run
    // `42083551881` is the record. BR-19 and BR-46 cannot both hold with the
    // equality in place, and the equality is the one that is wrong: it was a
    // PROXY for the property this case is named after, which is the pageInfo
    // pairing on the last line.
    //
    // What the proxy was really guarding is still guarded, in two pieces:
    // the cursored top-level lists are asserted at 100 by name above, and a
    // floor stops a nested page being shrunk to a token value to dodge the
    // node limit instead of restructuring the query. A page below the floor
    // means the query is wrong, not that the page should be smaller.
    const FLOOR = 20;
    const tooSmall = firsts.filter(n => n < FLOOR);
    expect(
      tooSmall,
      `a first: below ${FLOOR} is not a page, it is a guess. If the node-limit ` +
        "product (BR-46) cannot be met with real pages, split the query rather " +
        "than shrinking a selection until it fits.",
    ).toEqual([]);
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
          // `assignees: null` joined the same axis in round 8 for the same
          // reason — `isReady` takes a number, so an unread count is a
          // question it cannot be asked rather than one it answers false.
          for (const assignees of [0, 1, null])
            for (const frontier of frontiers) {
              const d = dep({ state, phase, blockedByOpen, assignees });
              const [got] = fanoutDecisions([d], frontier, "Ready");
              if (blockedByOpen === null || assignees === null) {
                expect(got.move).toBe(false);
                unmeasured++;
              } else {
                expect(got.move).toBe(isReady({ ...d, blockedByOpen, assignees }, frontier));
                compared++;
              }
            }
    // The grid is the instrument; one that shrank to nothing would pass
    // vacuously, and both halves have to be non-empty for the split above
    // to mean anything. 2 states x 3 phases x 3 blocker readings x 3
    // assignee readings x 2 frontiers = 108, of which the 48 fully-measured
    // rows are the ones isReady can be asked about.
    expect(compared).toBe(48);
    expect(unmeasured).toBe(60);
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

  /**
   * BR-34 / BR-35 — the gate authorises the repository owner without needing a
   * credential that can answer the permission endpoint.
   *
   * **Measured, not predicted.** Dispatch `42074926758` on 2026-11-05 is the
   * first time this workflow was ever run past the secret-name repair in
   * #1761, and it refused:
   *
   * > refusing to run: hornjason has permission "UNMEASURED" on
   * > hornjason/rungate, and this job holds a board-writing credential.
   *
   * `GET /repos/{repo}/collaborators/{actor}/permission` returned nothing the
   * gate could read, so `perm` was empty and the `case` fell to its refusing
   * arm. **The refusal is correct** — a permission nobody could read is not a
   * permission anybody was granted — and the control says the endpoint is not
   * the problem: the same call, same actor, same repository, made with an
   * ordinary credential answers `admin` immediately. What differs is the
   * capability of the token this job holds, and that is not knowable from
   * inside the repository.
   *
   * So the owner comparison is added as a FIRST arm rather than a replacement.
   * `github.repository_owner` is set by GitHub, is not forgeable by a
   * contributor, costs no API call and needs no scope — and on a user-owned
   * repository it is the exact question the endpoint was being asked.
   *
   * **This is a pair, not a duplicate decider.** Each arm answers an input the
   * other cannot: the comparison cannot authorise a collaborator who is not
   * the owner, and the endpoint cannot authorise anybody when the credential
   * cannot read it. Were either able to answer every input the other can, they
   * would be the fourth shape in
   * `.claude/rules/checks-must-be-able-to-fail.md` and one of them would be
   * dead with nothing able to say which.
   */
  test("BR-34: the owner is authorised without reading the permission endpoint", () => {
    // A DETECTOR THAT READS A WHOLE FILE READS ITS COMMENTS. The paragraph
    // above this row's own fix will quote `github.repository_owner`, so the
    // position has to be taken on code.
    const code = yml
      .split("\n")
      .filter(l => !/^\s*#/.test(l))
      .join("\n");

    expect(
      code,
      "the gate step must take the repository owner through `env:`, not interpolate it " +
        "into a `run:` line — BR-16 is the sibling of that rule",
    ).toContain("${{ github.repository_owner }}");

    // The comparison itself, in the gate's shell. Spelled against the env
    // names so a rename cannot leave this row matching a stale string.
    const gateAt = code.indexOf("id: gate");
    expect(gateAt, "no step with `id: gate` — this row would pass vacuously").toBeGreaterThan(-1);
    const ownerCheck = /\[\s*"\$ACTOR"\s*=\s*"\$OWNER"\s*\]/.test(code);
    expect(
      ownerCheck,
      'the gate does not compare "$ACTOR" against "$OWNER". Dispatch 42074926758 refused a ' +
        "run the owner triggered, because the only trust path needed a credential that could " +
        "not answer. Add the comparison; do not widen the `case` arm and do not fail open.",
    ).toBe(true);

    // The owner arm must come BEFORE the endpoint read, or the run still pays
    // for the call that cannot answer and still refuses on its empty result.
    const ownerAt = code.search(/\[\s*"\$ACTOR"\s*=\s*"\$OWNER"\s*\]/);
    const apiAt = code.indexOf("collaborators/$ACTOR/permission");
    expect(apiAt, "the permission endpoint read is gone — BR-33 measures nothing now").toBeGreaterThan(-1);
    expect(ownerAt, "the owner comparison runs after the endpoint read").toBeLessThan(apiAt);
  });

  /**
   * The anti-vacuity control for BR-34, and it is the row that matters.
   *
   * BR-34 is three `indexOf` positions over a stripped string, and every one
   * of them reads `-1` as cleanly as it reads a position. A gate step deleted
   * outright, a `run:` block emptied, or a strip that took the code with the
   * comments would each leave BR-34 asserting things about an empty document.
   * This row refuses that reading first, so BR-34 cannot be green because
   * there was nothing to look at.
   */
  test("BR-35: the gate step still has a body to take a position inside", () => {
    const code = yml
      .split("\n")
      .filter(l => !/^\s*#/.test(l))
      .join("\n");
    const gate = /id: gate\n([\s\S]*?)\n      - /.exec(code)?.[1] ?? "";
    expect(
      gate.length,
      "the gate step's body did not parse — BR-34's positions would all be -1 and read as a pass",
    ).toBeGreaterThan(200);
    expect(gate, "the gate no longer reads the credential at all").toContain("GH_TOKEN");
    expect(gate, "the gate no longer writes its verdict").toContain("trusted=");
    // Both verdicts reachable: a gate that can only say yes is not a gate.
    expect(gate).toContain("trusted=true");
    expect(gate).toContain("trusted=false");
  });

  /**
   * The gate is before the expensive steps, and it spells the same set.
   *
   * `issues: [closed]` on a PUBLIC repository is triggerable by anybody with
   * a GitHub account: open an issue, close your own issue. Until this round
   * the script's trust gate was the first refusal, and reaching it cost a
   * checkout, a bun install and a full dependency fetch — so the refusal was
   * correct and the run was already paid for. Repeat at will.
   *
   * The step added here needs only `gh`, which is preinstalled, so the setup
   * steps sit behind it.
   *
   * That makes two places that name writing permissions, which is the fourth
   * shape in `.claude/rules/checks-must-be-able-to-fail.md` — and this step
   * genuinely cannot import the decider, because the import is the checkout
   * it exists to prevent. So the sets are asserted EQUAL rather than each
   * asserted correct: they cannot drift into two guards that disagree, and a
   * permission added to one is red until it is added to the other.
   */
  test("BR-33: the trust gate runs before checkout, and names the same permissions", () => {
    // A DETECTOR THAT READS A WHOLE FILE READS ITS COMMENTS, and the
    // ordering half of this row went red on the comment above the gate
    // explaining what the gate saves — the words "bun install" in a sentence
    // about `bun install`. Comments are stripped before any position is
    // taken; the anti-vacuity assertions below are what keep the stripping
    // from quietly taking the code with it.
    const code = yml
      .split("\n")
      .filter(l => !/^\s*#/.test(l))
      .join("\n");
    // The `case` arm in the gate step, as the shell actually reads it.
    const arm = /\n\s*(admin\|maintain\|write|[a-z|]+)\)\n/.exec(code)?.[1];
    expect(
      arm,
      "no `case` arm listing permissions was found in board-ready.yml — this row would " +
        "pass vacuously. Fix the pattern, do not delete the row.",
    ).toBeTruthy();
    const spelled = (arm ?? "").split("|").filter(Boolean).sort();
    expect(spelled, "the parsed permission list is empty").not.toEqual([]);
    expect(
      spelled,
      "the workflow's trust gate and WRITING_PERMISSIONS must name the same set — two " +
        "guards answering one question are behaviourally one, and nothing can say which is live",
    ).toEqual([...WRITING_PERMISSIONS].sort());

    // Ordering: the gate step is declared before anything that costs a
    // checkout or a dependency fetch, and each of those carries its `if:`.
    const gateAt = code.indexOf("id: gate");
    expect(gateAt, "no step with `id: gate` — this row would pass vacuously").toBeGreaterThan(-1);
    const costly = ["actions/checkout@", "oven-sh/setup-bun@", "bun install"];
    for (const needle of costly) {
      const at = code.indexOf(needle);
      expect(at, `${needle} is not in the workflow — the ordering census is measuring nothing`).toBeGreaterThan(-1);
      expect(at, `${needle} runs before the trust gate`).toBeGreaterThan(gateAt);
    }
    // Declared after is not the same as conditional on. Every step that is
    // not the gate itself must carry the guard, or an unconditional one
    // reintroduces exactly the cost this removes.
    const guards = code.split("\n").filter(l => /if:\s*steps\.gate\.outputs\.trusted == 'true'/.test(l));
    expect(
      guards.length,
      "every step after the gate must be conditional on it: checkout, setup-bun, " +
        "bun install and the fan-out step itself",
    ).toBe(4);
  });

  // `secrets` is not available in `if:` at all, and a step skipped by `if:`
  // reports SKIPPED — which a required check can treat as satisfied. The mode
  // is resolved inside `run:` (`.claude/rules/config-access.md`).
  test("BR-13: the credential is never read in an if: expression", () => {
    for (const line of yml.split("\n")) {
      if (/^\s*if:/.test(line)) expect(line).not.toContain("PROJECT_TOKEN");
    }
    expect(yml).toContain("BOARD_PROJECT_TOKEN: ${{ secrets.RUNGATE_PROJECT_TOKEN }}");

    // EVERY `secrets.` reference, not the one this row used to name. A
    // `secrets.<name>` for a secret that does not exist resolves to the EMPTY
    // STRING with no error and no annotation, so a name nobody minted is
    // byte-identical to a credential nobody set — the gate reports
    // `UNMEASURED` forever and the Ready lane moves nothing, while the run
    // itself reports success. `BOARD_PROJECT_TOKEN` was never a secret on
    // this repository; `RUNGATE_PROJECT_TOKEN` has been since 2026-11-02.
    //
    // The census is both sites because the fix is a rename and a rename is a
    // population: the gate step's `GH_TOKEN` and the fan-out step's
    // `BOARD_PROJECT_TOKEN` each interpolate it, and repairing one leaves the
    // workflow authorising its gate with nothing. The env var name is
    // deliberately NOT renamed — `readBoardCredential` in
    // `lib/board-ready-fanout.ts` reads `BOARD_PROJECT_TOKEN`, and only the
    // secret side was ever wrong.
    expect([...yml.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(m => m[1]!)).toEqual([
      "RUNGATE_PROJECT_TOKEN",
      "RUNGATE_PROJECT_TOKEN",
    ]);
  });

  // Every `uses:` pinned to a commit SHA — asserted here as well as by
  // `test/action-pin-parity.test.ts`, because this file is new.
  test("BR-14: every action is pinned to a 40-character SHA", () => {
    // `- uses:` was the first spelling and it stopped seeing both actions
    // the moment they grew an `if:`, which moves `uses:` off the dash line.
    // A pin census that silently reads nothing is the vacuous shape, and the
    // count assertion below is the only reason it reported rather than
    // passing. The dash is optional now; the count is not.
    const uses = [...yml.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map(m => m[1]);
    expect(uses.length, "no `uses:` found in board-ready.yml — this row would pass vacuously").toBe(2);
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

  // An identity that is NOT the owner, so this row measures the permission
  // and only the permission — the short-circuit must not be what carries it.
  const outsider = { actor: "outsider", owner: "hornjason" } as const;

  test("BR-25: only a writing permission may move the board", () => {
    for (const p of ["admin", "write", "maintain"]) expect(actorMayWrite(p, outsider), `${p} should write`).toBe(true);
    for (const p of ["read", "none", "triage", ""]) expect(actorMayWrite(p, outsider), `${p} must not write`).toBe(false);
  });

  // UNMEASURED, not zero, in the place it decides a write: a permission the
  // run could not read is not a permission it was granted.
  test("BR-26: an unreadable permission refuses", () => {
    expect(actorMayWrite(null, outsider)).toBe(false);
  });

  // ## The fifth fault in this one lane, and the first that failed loudly
  //
  // Run `42080290624` on 2026-11-05T18:01:51Z is the record. PR #1765 had just
  // merged, so the workflow's shell gate short-circuited on the repository
  // owner and the job reached the fan-out for the first time in this lane's
  // existence. Then `scripts/board-ready.ts` ran the SAME permission read
  // through this decider, got `null` from an endpoint `GITHUB_TOKEN` cannot
  // answer, and refused: *hornjason has permission "UNMEASURED" on
  // hornjason/rungate*.
  //
  // One guard, two halves, and #1765 repaired one of them —
  // `.claude/rules/checks-must-be-able-to-fail.md`'s fourth shape arriving
  // from the other direction. The owner short-circuit belongs in the decider
  // both halves consult, not beside it, so `actorMayWrite` now takes the
  // identity it is deciding about. The workflow still restates it in shell
  // because a gate that runs before the checkout cannot import; BR-33 and
  // BR-34 hold the two spellings together.
  test("BR-43: the repository owner is trusted when the permission endpoint cannot be read", () => {
    expect(actorMayWrite(null, { actor: "hornjason", owner: "hornjason" })).toBe(true);
  });

  // The direction that must NOT widen. An unreadable permission for anybody
  // who is not the owner is still UNMEASURED, and UNMEASURED still refuses.
  test("BR-44: a non-owner with an unreadable permission is still refused", () => {
    expect(actorMayWrite(null, { actor: "outsider", owner: "hornjason" })).toBe(false);
    expect(actorMayWrite("read", { actor: "outsider", owner: "hornjason" })).toBe(false);
    expect(actorMayWrite("write", { actor: "outsider", owner: "hornjason" })).toBe(true);
  });

  // Anti-vacuity. An absent actor and an absent owner are the same empty
  // string, and `"" === ""` would hand a write to a run that identified
  // nobody — the silent pass this whole file exists to refuse.
  test("BR-45: an empty identity does not satisfy the owner short-circuit", () => {
    expect(actorMayWrite(null, { actor: "", owner: "" })).toBe(false);
    expect(actorMayWrite(null, { actor: "hornjason", owner: "" })).toBe(false);
    expect(actorMayWrite(null, { actor: "", owner: "hornjason" })).toBe(false);
  });

  // Asserted on ORDER, because a gate placed after the thing it guards is a
  // gate that watched it happen.
  //
  // The first spelling of this case only required the gate to precede the
  // WRITE, and the script satisfied it while still reading the whole board
  // with the PAT first. Security review caught that: dropping the job-level
  // `if:` and checking late means an untrusted close starts a privileged
  // job, which is a wider exposure than the predicate bug being fixed. The
  // permission answer depends on no board data, so it is taken before the
  // first `gql()` and the case says so.
  test("BR-27: the permission check precedes the first privileged read, not just the write", () => {
    const src = readFileSync(join(ROOT, "scripts/board-ready.ts"), "utf-8");
    const code = src.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    const gate = code.indexOf("actorMayWrite(permission,");
    expect(gate, "the gate is not called at all").toBeGreaterThan(-1);
    // every call of the GraphQL helper, and the mutation, come after it
    const reads = [...code.matchAll(/await gql\(/g)].map(m => m.index!);
    expect(reads.length, "no gql call found — the census is measuring nothing").toBeGreaterThanOrEqual(3);
    for (const at of reads) expect(at, "a board read precedes the trust gate").toBeGreaterThan(gate);
    expect(code.indexOf("updateProjectV2ItemFieldValue")).toBeGreaterThan(gate);
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

/**
 * BR-34..BR-36: an item with no Status value is still an item this job can
 * move.
 *
 * The Status field id was read off the item's **own Status value node**:
 * `statusValue?.field?.id`. An item carrying no Status at all therefore
 * produced no entry in `itemOf`, and the write loop logged *"its Status field
 * could not be located — UNMEASURED"* and moved on — for an item whose field
 * id was perfectly resolvable, just not from there.
 *
 * That is the population this whole lane exists for in the worst case: an
 * issue freshly added to the board with no column yet is exactly the one that
 * should land in Ready, and it was the one guaranteed to be skipped. The id
 * belongs to the PROJECT, not to the value, so it is resolved once from
 * `ProjectV2.field(name: "Status")` — introspected 2026-11-04 to confirm the
 * by-name lookup exists and takes no cursor, so BR-19's `first:` census is
 * unaffected.
 */
describe("BR-34..BR-36: the Status field id comes from the project, not from the item's value", () => {
  const src = readFileSync(join(ROOT, "scripts/board-ready.ts"), "utf-8");
  // Comments first: this file's own prose quotes the bad expression, and so
  // does the script's new docblock (`.claude/rules/self-referential-tests.md`).
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  test("BR-34: the detector finds the one population site", () => {
    // Anti-vacuity. Zero means `itemOf` was renamed and BR-35 is asserting
    // against nothing; more than one means a second population path appeared
    // and both need checking.
    expect(
      (code.match(/itemOf\.set\(/g) ?? []).length,
      "expected exactly one `itemOf.set(` in scripts/board-ready.ts — see the comment above.",
    ).toBe(1);
  });

  // ## The sixth fault, and the first the trust gate ever let us see
  //
  // Run `42083551881` on 2026-11-05T18:22:21Z, dispatched against main with
  // BOTH halves of the trust gate repaired. It cleared the gate, reached the
  // first board read, and GitHub refused the query itself:
  //
  //   MAX_NODE_LIMIT_EXCEEDED — "By the time this query traverses to the
  //   fieldValues connection, it is requesting up to 1,000,000 possible
  //   nodes which exceeds the maximum limit of 500,000."
  //
  // `blocking(first:100)` → `projectItems(first:100)` → `fieldValues(first:100)`
  // is 100 × 100 × 100 exactly. GitHub multiplies the `first:` values down a
  // nesting chain before it executes anything, so this query could never have
  // run — not against a big board, not against an empty one. Five previous
  // faults hid it, because none of them got this far.
  //
  // The product is computed over EVERY query in the file rather than the one
  // that failed. A repair to the single known query is the fourth shape in
  // `.claude/rules/checks-must-be-able-to-fail.md`: a wrong page size is a
  // POPULATION, and the next nested read anybody adds re-makes this defect.
  //
  // The arithmetic deliberately OVER-estimates: it multiplies every `first:`
  // in a query, where GitHub multiplies down a nesting chain and takes the
  // worst branch. Sibling connections are therefore counted as if nested.
  // That errs toward refusing a query GitHub would have accepted, which is
  // the direction this file's refusals are allowed to be wrong in.
  test("BR-46: no query can exceed GitHub's node limit before it is sent", () => {
    const MAX_NODES = 500_000;
    // Template literals in the script, which is how every query is spelled.
    const queries = [...code.matchAll(/`query\([\s\S]*?`/g)].map(m => m[0]);
    // Anti-vacuity first: an empty population multiplies to nothing and
    // every assertion below reads clean.
    expect(
      queries.length,
      "no GraphQL query was found in scripts/board-ready.ts — the census is " +
        "measuring nothing, which is not the same as measuring zero violations",
    ).toBeGreaterThanOrEqual(3);
    const over = queries
      .map(q => ({
        product: [...q.matchAll(/first:\s*(\d+)/g)].reduce((n, m) => n * Number(m[1]), 1),
        head: q.slice(0, 60).replace(/\s+/g, " "),
      }))
      .filter(q => q.product > MAX_NODES);
    expect(
      over,
      `GitHub rejects a query whose nested page sizes multiply above ${MAX_NODES} ` +
        "BEFORE executing it, so the query fails identically against an empty board " +
        "and a full one. Run 42083551881 is the record. Lower a `first:` — every " +
        "connection here reports its own truncation through `truncatedReadings`, " +
        "so a smaller page is refused loudly rather than silently cut short.",
    ).toEqual([]);
  });

  test("BR-35: membership is not gated on the item having a Status value", () => {
    // The defect, as source. `statusValue` may still be READ — `boardStatus`
    // needs it — but it must not decide whether the item is writable.
    const gate = /if\s*\([^)]*statusValue[^)]*\)\s*\{\s*\n\s*itemOf\.set\(/;
    expect(
      gate.test(code),
      "`itemOf` must not be populated only when the item already has a Status value. " +
        "An item with no column is the one this lane most needs to move, and reading " +
        "the field id off its own value node makes that item unreachable. Resolve the " +
        "field id from the project once.",
    ).toBe(false);
  });

  // Caught in review of #1744. `issue(number:)` resolves to `null` with no
  // `errors` for a number that is not an Issue — issues and pull requests
  // share one numbering space and this field resolves only Issues — so a PR
  // number typed into `workflow_dispatch`'s free-text `issue` input produced
  // `Cannot read properties of null (reading 'blocking')`, an opaque stack
  // trace where every other unreadable state in this file reports UNMEASURED
  // and refuses through `EXIT_REFUSED`.
  test("BR-37: a number that is not an issue refuses, it does not dereference null", () => {
    expect(
      code,
      "`d.repository.issue` must be checked before `.blocking` is read — " +
        "a PR number or a deleted issue returns a well-formed response with a null issue",
    ).toMatch(/if\s*\(!d\.repository\?\.issue\)/);
    // The refusal must go through the same exit as every other UNMEASURED in
    // this file, not a bare throw — otherwise it is a different failure mode
    // wearing the same words.
    expect(
      code.slice(code.indexOf("if (!d.repository?.issue)")),
      "the refusal must return EXIT_REFUSED, like every other unreadable state here",
    ).toMatch(/if\s*\(!d\.repository\?\.issue\)[\s\S]{0,400}?return EXIT_REFUSED;/);
  });

  test("BR-36: the field id is resolved from the project by name, exactly once", () => {
    // The positive half. Without it, deleting the guard BR-35 forbids goes
    // green while leaving nothing to write with.
    expect(
      code,
      'the Status field must be resolved from the project: `field(name: "Status")`',
    ).toMatch(/field\(name:\s*"Status"\)/);
    // One resolve, not one per moved item — and one site to mutate.
    expect((code.match(/field\(name:\s*"Status"\)/g) ?? []).length).toBe(1);
  });
});

/**
 * BR-38..BR-39: an HTTP-level failure refuses, it does not return `undefined`.
 *
 * `gql()` treated a response as an error only when the parsed body carried a
 * GraphQL `errors` array. GitHub answers an expired PAT, a secondary rate
 * limit and a 5xx with a plain `{"message": "..."}` body and **neither** key,
 * so `j.errors` was falsy, `j.data` was `undefined`, and the function returned
 * it. Every caller then dereferenced a property straight off that —
 * `d.repository?.issue`, `all.node.items`, `(...).node?.field` — and the run
 * died with `TypeError: Cannot read properties of undefined`: an opaque crash
 * in the one file whose whole subject is telling an unreadable state from a
 * read one. Caught in review of #1747.
 *
 * This is the same defect, in the same shape, that round 8 of #1740 fixed in
 * `scripts/work-status.ts`, which is why the population — **both** credentialed
 * fetches in this script — is asserted rather than the one site named.
 * `actorPermission` already checked; `gql` did not.
 */
describe("BR-38..BR-39: every credentialed fetch reads its status before its body", () => {
  const src = readFileSync(join(ROOT, "scripts/board-ready.ts"), "utf-8");
  // A detector that reads a whole file reads its comments, and the docblock
  // above `gql` now quotes the very thing this forbids.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const SITES = [...code.matchAll(/await fetch\(/g)].map(m => m.index!);

  test("BR-38: the detector finds the whole population", () => {
    // Anti-vacuity, and the reason BR-39 is a census rather than a spot check.
    // A third fetch arriving here must be checked too, and a zero means the
    // helpers were renamed and BR-39 is ranging over nothing.
    expect(
      SITES.length,
      "expected exactly two `await fetch(` sites in scripts/board-ready.ts — " +
        "`gql` and `actorPermission`. A new one must carry its own status check.",
    ).toBe(2);
  });

  test("BR-42: a --write run with nothing to move resolves no Status field", () => {
    // The Status field resolution and its two `EXIT_REFUSED` branches ran
    // whenever `--write` was passed, even with `moving.length === 0`. So a
    // correctly-idle run — every dependent already Ready, still blocked, or
    // claimed — against a board whose "Ready" column had been renamed exited
    // 2 instead of 0: a no-op success reported as a failure, red CI for a
    // scenario where nothing needed writing. The `blocking.length === 0` case
    // above already short-circuits; this one did not. Caught in review of
    // #1747.
    //
    // **Same shape as BS-38 on #1754**, found independently in the other
    // script one round earlier: a `--write` path doing setup work it does not
    // need and failing on it. Two files, one class.
    //
    // Source-ORDER, like BS-38 and for the same reason: `main()` needs a live
    // endpoint, and a mock deep enough to reach the resolution would assert
    // against its own fixture.
    const guard = code.search(/if \(moving\.length === 0\)/);
    const resolve = code.search(/field\(name:\s*"Status"\)/);
    // Anti-vacuity, both halves — `-1 < anything` would satisfy the ordering
    // for free if either side were renamed away.
    expect(resolve, "the Status field must still be resolved somewhere").toBeGreaterThan(-1);
    expect(
      guard,
      "a `--write` run must short-circuit when nothing is moving",
    ).toBeGreaterThan(-1);
    expect(
      guard < resolve,
      "the nothing-to-move guard must come BEFORE the Status field is resolved, " +
        "or an idle run exits EXIT_REFUSED over a column it never needed to find",
    ).toBe(true);
  });

  test("BR-40: the detector finds every project-node read", () => {
    // Anti-vacuity for BR-41, and it counts CALL SITES: the definition is an
    // arrow assignment (`const itemsPage = (d: any) =>`), so it does not match
    // and must not be counted — a first version of this row expected 3 and
    // went red against a correct fix. Two reads of the frontier query exist,
    // the first page and every page after it, and both must be guarded; zero
    // means the helper was renamed and BR-41 is ranging over nothing.
    expect(
      (code.match(/itemsPage\(/g) ?? []).length,
      "expected exactly two `itemsPage(` CALL SITES — the first frontier page " +
        "and the pagination loop's next page. The arrow definition is not a call.",
    ).toBe(2);
  });

  test("BR-41: a project id that does not resolve refuses, it does not throw", () => {
    // `node(id:)` returns null for an id GitHub cannot resolve, and the
    // inline fragment resolves to an empty object for an id that exists but
    // is not a ProjectV2. Either is a SUCCESSFUL response — no `errors`, so
    // `gql()` returns normally — and `all.node.items` then threw
    // `TypeError: Cannot read properties of null`. A stale or mistyped
    // RUNGATE_PROJECT_ID crashed with a stack trace where every other
    // unreadable node in this file reports UNMEASURED and returns
    // EXIT_REFUSED. Caught in review of #1747; the same class BR-37 covers
    // on the `issue(number:)` path, at the site it did not reach.
    //
    // POPULATION: both reads of that query, not the one the finding named.
    const bare = [...code.matchAll(/\.node\.[A-Za-z_]/g)].map(m => m[0]);
    expect(
      bare,
      "an unguarded `.node.` dereference turns an unresolvable project id into " +
        "a TypeError instead of this file's own UNMEASURED refusal. Read it " +
        "through `itemsPage()` and refuse when it is null.",
    ).toEqual([]);
    // The positive half: the refusal must go through the same exit as every
    // other unreadable state here, not a bare throw.
    expect(
      code,
      "the unresolvable-project refusal must return EXIT_REFUSED",
    ).toMatch(/itemsPage\([\s\S]{0,700}?return EXIT_REFUSED;/);
  });

  test("BR-39: no response body is parsed before its status is read", () => {
    const unguarded = SITES.filter(at => {
      const after = code.slice(at);
      const parse = after.search(/await r\.json\(\)/);
      if (parse < 0) return false; // nothing parsed, nothing to guard
      const check = after.search(/r\.(ok|status)\b/);
      return check < 0 || check > parse;
    });
    expect(
      unguarded.length,
      "a fetch whose body is parsed before `r.ok`/`r.status` is read turns an " +
        "expired PAT, a 403 rate limit and a 5xx into `data: undefined`, which " +
        "every caller dereferences as a bare TypeError instead of this file's " +
        "own UNMEASURED refusal. Read the status first.",
    ).toBe(0);
  });
});
