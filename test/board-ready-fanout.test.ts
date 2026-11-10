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
  incumbentDecisions,
  mergeCandidateSources,
  readBoardCredential,
  truncatedReadings,
  whyNotReady,
  type Dependent,
  type Incumbent,
} from "../lib/board-ready-fanout";
import { laneFor } from "../lib/board-flow";
import { structuralCut } from "../lib/source-slice";

const ROOT = join(import.meta.dir, "..");

const dep = (over: Partial<Dependent> = {}): Dependent => ({
  number: 1,
  state: "OPEN",
  milestone: "Engine Phase 3",
  labels: [],
  blockedByOpen: 0,
  assignees: 0,
  onBoard: true,
  boardStatus: "Backlog",
  ...over,
});

/**
 * #1929: Ready's entry condition applied to the cards already in it.
 *
 * Promotion is one-way with respect to blockers. Measured 2026-11-09 on
 * #1495: promoted into Ready at 00:41:41Z, `blocked_by_added` for the still
 * open #1571 at 02:01:08Z, and nothing re-checked it — `blocked_by_added`
 * reaches the REST timeline and emits no webhook, so no trigger can be added.
 * The route that needs no new event is this one: `whyNotReady` applied to the
 * lane's current occupants on the walk that already counts them.
 */
const inc = (over: Partial<Incumbent> = {}): Incumbent => ({
  number: 1,
  typename: "Issue",
  state: "OPEN",
  boardStatus: "Ready",
  blockedByOpen: 0,
  ...over,
});

describe("#1929: a card already in Ready is held to Ready's entry condition", () => {
  // The pair, and it is a pair on purpose: one input, one field moved. A fix
  // that demoted everything would pass the first of these and fail the second.
  test("BR-61: an open issue in Ready with a live blocker is demoted", () => {
    const [d] = incumbentDecisions([inc({ number: 1495, blockedByOpen: 1 })], "Ready");
    expect(d.demote).toBe(true);
    if (d.demote) expect(d.why).toContain("blocker");
  });

  test("BR-62: the SAME issue with that blocker closed is left alone", () => {
    const [d] = incumbentDecisions([inc({ number: 1495, blockedByOpen: 0 })], "Ready");
    expect(d.demote).toBe(false);
  });

  // The negative control on the LANE. This rule is about Ready's entry
  // condition and nothing else: an issue somebody is actively working on is
  // allowed to have an open blocker, and a rule that reached In progress
  // would yank cards out from under whoever claimed them.
  test("BR-63: a blocked card in another lane is not touched", () => {
    const out = incumbentDecisions(
      [inc({ number: 7, boardStatus: "In progress", blockedByOpen: 2 })],
      "Ready",
    );
    expect(out.filter(d => d.demote)).toEqual([]);
  });

  // UNMEASURED never moves, the same way `fanoutDecisions` refuses it on the
  // way in. `?? 0` here would read a token that cannot see dependencies as
  // "nothing is blocking it" and leave the lane exactly as wrong as it is now.
  test("BR-64: an unreadable blocker count is UNMEASURED and does not move", () => {
    const [d] = incumbentDecisions([inc({ blockedByOpen: null })], "Ready");
    expect(d.demote).toBe(false);
    if (!d.demote) expect(d.why).toContain("UNMEASURED");
  });

  // A pull request parked in Ready holds a slot — `holdsReadySlot` counts it —
  // and has no dependency reading at all. Demoting one would be this rule
  // acting on a `blockedByOpen` nobody computed.
  test("BR-65: a pull request in Ready is never demoted", () => {
    const out = incumbentDecisions(
      [inc({ typename: "PullRequest", state: "OPEN", blockedByOpen: null })],
      "Ready",
    );
    expect(out.filter(d => d.demote)).toEqual([]);
  });

  // The lane a demoted card returns to is `laneFor`'s answer, not a literal
  // spelled here. Two deciders answering "where does something going backwards
  // go" would agree on every input anybody tests and a mutation of either
  // would leave the other holding the case up.
  test("BR-66: the destination lane comes from laneFor, not from a literal", () => {
    const [d] = incumbentDecisions([inc({ blockedByOpen: 1 })], "Ready");
    const backwards = laneFor({ kind: "issue_blocked_in_ready" });
    expect(backwards.lane, "laneFor must have a case for this event kind").not.toBeNull();
    expect(d.demote).toBe(true);
    if (d.demote) expect(d.to).toBe(backwards.lane!);
  });

  // The reason text is `whyNotReady`'s, for the same single-decider reason —
  // and this asserts the WORDS agree, not merely that both are non-empty.
  // ── The WIRING, because the four cases above are a pure function ────────
  //
  // ai-review round 1 was right and this is the finding that mattered:
  // deleting the `incumbentDecisions` call, the gather, or the write loop
  // from `main()` left all 150 tests green, because every case above
  // exercises the decider directly. The board would have regressed to the
  // exact one-way promotion #1929 exists to fix with CI green throughout.
  //
  // Source-census, the same instrument BR-27, BR-33 and BR-40 already use
  // on this file: `main()` needs a live endpoint, and a mock deep enough to
  // reach these call sites would assert against its own fixture.
  const readyScript = (): string => {
    const src = readFileSync(join(ROOT, "scripts/board-ready.ts"), "utf-8");
    // Comments stripped, or every assertion below can be satisfied by the
    // prose that explains it — the vacuous shape in
    // `.claude/rules/checks-must-be-able-to-fail.md`.
    return src
      .split("\n")
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
  };

  // Every region below is cut to a CONSTRUCT, never to a character count.
  // The first spelling of these four used `slice(at, at + 120)` and
  // `slice(push - 200, push)`, and `test/no-fixed-window-slices.test.ts`
  // reddened in CI naming #664: a window sized by eye reads the wrong region
  // the moment the code around it grows, and a guard reading the wrong
  // region is green for free. There is no exemption list.
  test("BR-68: main() calls incumbentDecisions, and acts on what it returns", () => {
    const code = readyScript();
    // One regex over the whole file, so there is no region to size at all.
    // Called and DISCARDED is the same as not called, which is why the
    // filter is part of the pattern rather than a second search.
    expect(
      code,
      "main() must call incumbentDecisions with the gathered incumbents AND filter the " +
        "result to the cards that demote — a call whose result is dropped leaves the " +
        "decider dead and Ready still offering blocked work",
    ).toMatch(
      /const demoting = incumbentDecisions\(readyIncumbents, READY_COLUMN\)\s*\.filter\(\s*d\s*=>\s*d\.demote\s*\)/,
    );
  });

  test("BR-69: the gather is behind `holds`, so the in-flight card is exempt", () => {
    const code = readyScript();
    expect(code, "nothing gathers the lane's incumbents").toContain("readyIncumbents.push(");
    // **Cut the guard's own block and look inside it.** `holdsReadySlot`
    // returns false for exactly the card this run's event is moving out of
    // Ready (#1905); gathering on a bare `status === READY_COLUMN` would
    // demote it to Backlog while `board-flow` writes In progress for it in a
    // racing run. Two writers, one card, last writer wins.
    const guarded = structuralCut(code, "if (holds && n.content?.number !== undefined) {", {
      balanced: "{",
    });
    expect(
      guarded,
      "the incumbent gather must sit inside the `holds` guard, the same predicate the cap " +
        "uses, or the card mid-transition out of Ready is demoted on top of the move in flight",
    ).toContain("readyIncumbents.push(");
  });

  test("BR-70: the demotions are written, and before the promotions", () => {
    const code = readyScript();
    const loop = code.search(/for\s*\(\s*const dec of demoting\s*\)/);
    expect(
      loop,
      "the demotion decisions are computed and never written — the lane stays wrong while " +
        "the job reports success",
    ).toBeGreaterThan(-1);
    const promote = code.search(/for\s*\(\s*const dec of moving\s*\)/);
    expect(promote, "the promotion loop is gone — this census is measuring nothing").toBeGreaterThan(-1);
    // A demotion frees a slot. Writing promotions first computes them
    // against an occupancy this run is about to reduce, which under-promotes
    // — conservative. The reverse would write into a lane about to empty.
    expect(
      loop < promote,
      "demotions must be written before promotions, or a promotion lands against an " +
        "occupancy the same run is about to change",
    ).toBe(true);
    // The write itself, cut to the loop's own body: a loop that logs and
    // mutates nothing satisfies every assertion above.
    expect(
      structuralCut(code, "for (const dec of demoting) {", { balanced: "{" }),
      "the demotion loop must perform the field mutation, not only log it",
    ).toContain("updateProjectV2ItemFieldValue");
  });

  test("BR-71: no-candidates returns before the incumbent walk no longer", () => {
    const code = readyScript();
    expect(code, "the occupancy walk is gone — this census measures nothing").toContain(
      "BOARD_PAGE_QUERY, { p: project, c: null }",
    );
    // `--closed-issue N --write` where #N was blocking nothing used to exit
    // here, skipping the walk that gathers incumbents entirely. The
    // production workflow always passes `--top-up` and never reaches that
    // combination, which is why it would not have been noticed.
    const branch = structuralCut(code, "if (candidates.length === 0) {", { balanced: "{" });
    expect(
      branch,
      "the no-candidates branch must not return before the incumbent walk: nothing to " +
        "PROMOTE is not nothing to do, and a card in Ready that acquired a blocker is " +
        "still being offered as startable",
    ).not.toMatch(/\breturn 0;/);
  });

  test("BR-67: the demotion reason is whyNotReady's, not a second wording", () => {
    const [d] = incumbentDecisions([inc({ blockedByOpen: 3 })], "Ready");
    expect(d.demote).toBe(true);
    if (d.demote) {
      expect(d.why).toContain(
        whyNotReady(dep({ state: "OPEN", blockedByOpen: 3, assignees: 0 })),
      );
    }
  });
});

describe("BR-1..BR-6: the fan-out from one closed blocker", () => {
  // The case in the issue, exactly: two dependents, one of which has a second
  // open blocker. The first moves; the second does not.
  test("BR-1: a freed dependent moves, one still blocked does not", () => {
    const out = fanoutDecisions([dep({ number: 10 }), dep({ number: 11, blockedByOpen: 1 })], "Ready");
    expect(out.filter(d => d.move).map(d => d.number)).toEqual([10]);
    const held = out.find(d => d.number === 11)!;
    expect(held.move).toBe(false);
    if (!held.move) expect(held.why).toContain("blocker");
  });

  // Membership is board-mirror's job. An Action that ADDS items would make
  // the board's contents depend on which issues happened to close, which is
  // a different and much larger claim than the one #1744 makes.
  test("BR-2: an issue that is not on the board is left alone, not added", () => {
    const [d] = fanoutDecisions([dep({ onBoard: false, boardStatus: null })], "Ready");
    expect(d.move).toBe(false);
    if (!d.move) expect(d.why).toContain("not on the board");
  });

  // Idempotence. The trigger is `issues: [closed]`, and a close can be
  // delivered more than once; a second delivery must write nothing.
  test("BR-3: an issue already in Ready is not rewritten", () => {
    const [d] = fanoutDecisions([dep({ boardStatus: "Ready" })], "Ready");
    expect(d.move).toBe(false);
    if (!d.move) expect(d.why).toContain("already");
  });

  // **Inverted on 2026-11-05 with the phase gate.** This read "a later
  // phase is unblocked and still not Ready" and asserted false. Phase is
  // ordering now, not eligibility, so the same dependent must move — and
  // the case stays, inverted, because deleting it would let the gate come
  // back without a single test objecting.
  test("BR-4: a later phase is unblocked and therefore Ready", () => {
    const [d] = fanoutDecisions([dep({ milestone: "Engine Phase 7" })], "Ready");
    expect(d.move, "phase orders the lane; it does not gate entry to it").toBe(true);
  });

  test("BR-4b: a dependent in NO phase is Ready too", () => {
    const [d] = fanoutDecisions([dep({ milestone: null })], "Ready");
    expect(d.move, "an unphased issue was refused by the gate and is now merely ranked last").toBe(
      true,
    );
  });

  test("BR-5: an assigned dependent is somebody's, not Ready", () => {
    expect(fanoutDecisions([dep({ assignees: 1 })], "Ready")[0].move).toBe(false);
  });

  // The blocker that closed is itself a dependent of nothing; but a dependent
  // that closed in the same window must not be moved into Ready.
  test("BR-6: a CLOSED dependent is never moved", () => {
    expect(fanoutDecisions([dep({ state: "CLOSED" })], "Ready")[0].move).toBe(false);
  });
});

describe("BR-17..BR-20: UNMEASURED never moves, and the reads do not truncate", () => {
  // `issueDependenciesSummary` is absent on a response the token was not
  // scoped for. `?? 0` read that as "nothing is blocking it" and moved a
  // genuinely blocked issue to Ready — the fail-open shape, in the one place
  // where it writes to the board.
  test("BR-17: an unreadable blocker count does not move the issue", () => {
    const [d] = fanoutDecisions([dep({ blockedByOpen: null })], "Ready");
    expect(d.move).toBe(false);
    if (!d.move) expect(d.why).toContain("UNMEASURED");
  });

  // The positive control: the same issue with a READ count of zero does
  // move, so BR-17 is not green because nothing ever moves.
  test("BR-18: a measured zero is not the same reading, and does move", () => {
    expect(fanoutDecisions([dep({ blockedByOpen: 0 })], "Ready")[0].move).toBe(true);
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
    const [absent] = fanoutDecisions([dep({ onBoard: false, boardStatus: null })], "Ready");
    const [unset] = fanoutDecisions([dep({ onBoard: true, boardStatus: null })], "Ready");
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
    const [d] = fanoutDecisions([dep({ assignees: null })], "Ready");
    expect(d.move).toBe(false);
    if (!d.move) expect(d.why).toContain("UNMEASURED");
  });

  // The positive control, so BR-29 is not green because nothing moves.
  test("BR-30: a measured zero assignees is a reading, and does move", () => {
    expect(fanoutDecisions([dep({ assignees: 0 })], "Ready")[0].move).toBe(true);
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
    // `blocking.map` until #1842, which gave the script a second candidate
    // source — every open issue, for the ones no close can reach. Both walks
    // push into ONE array and this is still the only mapping, which is the
    // property BR-48 asserts by count. The name moved; the single site did not.
    const literal = /const dependents: Dependent\[\] = candidates\.map\(\(b: any\) => \{([\s\S]*?)\n {2}\}\);/
      .exec(src)?.[1];
    // ANTI-VACUITY. A detector that found nothing and a tree with no defaults
    // produce the same empty list, and the second is the one worth believing
    // only once the first is ruled out.
    expect(
      literal,
      "the `candidates.map(...)` that builds Dependent was not found in scripts/board-ready.ts — " +
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
    for (const field of ["number:", "state:", "milestone:", "blockedByOpen:", "assignees:", "onBoard:", "boardStatus:"]) {
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
  test("#1905: the mover reaches the occupancy decider, and only `assigned` names one", () => {
    // **The wiring, because the predicate's battery cannot see it.**
    // `holdsReadySlot` has seven behavioural cases and a mutation of every
    // arm reddens one. None of them reddens if this script stops selecting
    // `number`, stops passing the mover, or if the workflow stops supplying
    // it — all three mutations were run against the first version and all
    // three returned zero red. The predicate would then exclude nothing,
    // and the race #1905 records would be back with the suite green.
    const src = readFileSync(join(ROOT, "scripts/board-ready.ts"), "utf-8");
    // **Comments stripped first, and a mutation is why.** The first version
    // of this case passed with the selection DELETED, because the script
    // carries a comment naming it — the assertion was reading its own
    // explanation. BR-19 records that trap one screen below; this walked
    // into it anyway.
    const code = src
      .split("\n")
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");

    // **Scoped to BOARD_PAGE_QUERY, because the file holds three queries
    // and the other two already select `number`.** Asserting over the whole
    // file was wider than what it detects: deleting the selection from the
    // occupancy query left the case green on the other two. The mutation
    // found that; reading the file did not.
    const query = /const BOARD_PAGE_QUERY = `([\s\S]*?)`;/.exec(code)?.[1];
    expect(query, "BOARD_PAGE_QUERY is not where this test expects it").toBeDefined();
    expect(
      query,
      "the OCCUPANCY query stopped selecting `number`, so no card can be recognised as the " +
        "one being moved and the assigned-card race returns silently",
    ).toContain("Issue{number");

    // ANTI-VACUITY: a regex that found nothing and a call site that was
    // deleted are the same green.
    const call = /holdsReadySlot\(([\s\S]*?)\n {8}\);/.exec(code)?.[1];
    expect(call, "no holdsReadySlot call in board-ready.ts — the decider is not wired in").toBeDefined();
    expect(call, "the card's number is not passed").toContain("number: n.content?.number");
    expect(call, "the mover is not passed, so nothing is ever excluded").toContain("movingIssue");

    // **And the workflow supplies it on `assigned` ONLY.** The bound lives
    // half here: `board-flow` relanes nothing out of Ready on `unassigned`,
    // `opened` or `reopened`, so naming a mover there would free a slot
    // with no move behind it and promote past the cap.
    const yml = readFileSync(join(ROOT, ".github/workflows/board-ready.yml"), "utf-8")
      .split("\n")
      .filter(l => !/^\s*#/.test(l))
      .join("\n");
    const assignedArm = /\n\s*assigned\)\n([\s\S]*?);;/.exec(yml)?.[1];
    expect(assignedArm, "no `assigned)` arm in board-ready.yml").toBeDefined();
    expect(assignedArm, "the assigned arm stopped naming the moving issue").toContain(
      '--moving-issue "$ISSUE"',
    );
    // Quoted, so a free-text dispatch value stays ONE array element — the
    // injection this file's own `args` comment records.
    expect(assignedArm, "unquoted $ISSUE word-splits into flags").not.toMatch(
      /--moving-issue \$ISSUE/,
    );
    const otherArm = /\n\s*top-up \| unassigned \| opened \| reopened\)\n([\s\S]*?);;/.exec(yml)?.[1];
    expect(otherArm, "no combined arm for the non-relaning modes").toBeDefined();
    expect(otherArm, "a mode board-flow does not relane must not name a mover").not.toContain(
      "--moving-issue",
    );
  });

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
  //
  // **It is a consistency check and it cannot catch `isReady` being wrong.**
  // Both sides of the comparison call `isReady`, so a mutation of `isReady`
  // moves the expectation with the reading and every row stays green —
  // measured 2026-11-05, two mutants (assignees ignored, blockers ignored)
  // reddened four cases between them and not one row here. The same shape
  // as a `toBe(CONSTANT)` whose mutant edits the constant. A mutant that
  // adds a refusal to THIS module reddens it immediately, which is the
  // property it is for. Do not read a green grid as evidence about
  // `isReady`; `test/board-mirror.test.ts` owns that.
  test("BR-7: move equals isReady on every combination, for a board issue", () => {
    const states = ["OPEN", "CLOSED"];
    // **The phase axis stays, and its job reversed.** It used to prove the
    // module inherited the gate; it now proves the module did not KEEP one
    // after `isReady` dropped it. A grid that lost this axis when the gate
    // went would be green for a fanout that still refused phase 7.
    const phases: (number | null)[] = [null, 3, 7];
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
          for (const assignees of [0, 1, null]) {
            const d = dep({
              state,
              milestone: phase === null ? null : `Engine Phase ${phase}`,
              blockedByOpen,
              assignees,
            });
            const [got] = fanoutDecisions([d], "Ready");
            if (blockedByOpen === null || assignees === null) {
              expect(got.move).toBe(false);
              unmeasured++;
            } else {
              expect(got.move).toBe(isReady({ ...d, blockedByOpen, assignees }));
              compared++;
            }
          }
    // The grid is the instrument; one that shrank to nothing would pass
    // vacuously, and both halves have to be non-empty for the split above
    // to mean anything. 2 states x 3 phases x 3 blocker readings x 3
    // assignee readings = 54, of which the 24 fully-measured rows are the
    // ones isReady can be asked about. It was 108 and 48 with a frontier
    // axis that no longer exists; asserting the new totals is what makes
    // the shrink deliberate rather than a quiet loss of coverage.
    expect(compared).toBe(24);
    expect(unmeasured).toBe(30);
  });

  // **The exhaustiveness the removed fallback used to stand in for.**
  // `whyNotReady` ends on "somebody has claimed it" with no catch-all, so
  // if `isReady` ever grows a condition this list does not know about, some
  // input will be refused for a reason that is not its cause. Deriving the
  // expected reason from the input independently — rather than from the
  // function — is what makes this able to fail. ai-review round 1 of #1796.
  test("BR-7b: every refusal names its actual cause, over the whole grid", () => {
    let checked = 0;
    for (const state of ["OPEN", "CLOSED"])
      for (const phase of [null, 3, 7])
        for (const blockedByOpen of [0, 2, null])
          for (const assignees of [0, 1, null]) {
            const d = dep({
              state,
              milestone: phase === null ? null : `Engine Phase ${phase}`,
              blockedByOpen,
              assignees,
            });
            const ready =
              blockedByOpen !== null && assignees !== null && isReady({ ...d, blockedByOpen, assignees });
            if (ready) continue;
            // Derived from the input, in the order the function must use.
            const expected =
              state !== "OPEN"
                ? `the issue is ${state}`
                : blockedByOpen === null
                  ? "UNMEASURED — the dependency summary could not be read"
                  : blockedByOpen !== 0
                    ? `${blockedByOpen} open blocker${blockedByOpen === 1 ? "" : "s"} remain`
                    : assignees === null
                      ? "UNMEASURED — the assignee count could not be read"
                      : "somebody has claimed it";
            expect(
              whyNotReady(d),
              `the reason for ${JSON.stringify({ state, phase, blockedByOpen, assignees })} ` +
                `does not name what actually refused it`,
            ).toBe(expected);
            // **The half that catches a NEW condition in `isReady`.** The
            // assertion above cannot: `expected` is derived from the same
            // input and ends on the same "claimed" string, so a row that
            // became un-ready for an unknown reason agrees with itself and
            // stays green. This says the refusal has a cause in the list at
            // all — if `isReady` starts refusing something none of these
            // branches describes, the row lands here with every cause
            // absent. Found by predicting the mutant before running it.
            expect(
              state !== "OPEN" || blockedByOpen !== 0 || assignees !== 0,
              `isReady refused ${JSON.stringify({ state, blockedByOpen, assignees })} and not one ` +
                `of whyNotReady's branches explains why — it has grown a condition this list ` +
                `does not know about, so every log line for it is now wrong`,
            ).toBe(true);
            checked++;
          }
    // Non-vacuous: the grid has 54 rows and the ready ones are skipped.
    expect(checked, "a grid that refused nothing would pass this vacuously").toBe(51);
  });

  // The gap that had to close before the fallback could go. `isUnblocked`
  // refuses anything that is not exactly 0, and these guards asked `> 0`,
  // so a negative count made isReady false and reached the fallback.
  test("BR-7c: a negative blocker count is refused and named, not left to a fallback", () => {
    expect(isReady({ state: "OPEN", blockedByOpen: -1, assignees: 0 })).toBe(false);
    expect(whyNotReady(dep({ blockedByOpen: -1 }))).toContain("-1 open blocker");
  });

  test("BR-8: and a row of that grid genuinely moves — the grid is not all false", () => {
    expect(fanoutDecisions([dep()], "Ready").filter(d => d.move).length).toBe(1);
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
    //
    // COMMENTS STRIPPED, like BR-24 four rows down and for the same reason:
    // #1842 added a comment to the workflow naming both forbidden keys while
    // explaining that neither is present, and this row went red on the record
    // of its own rule. A guard that refuses the sentence describing it gets
    // relaxed rather than obeyed. The keys cannot hide in a comment anyway —
    // Actions does not read one.
    const live = yml.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
    expect(live).not.toContain("schedule:");
    expect(live).not.toContain("cron:");
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
    // Anchored on the guard's own MESSAGE rather than on the shape of its
    // condition. The condition gained a second term in #1929 — a demotion is
    // a move, so a run whose only work is a demotion must NOT short-circuit —
    // and `/if \(moving\.length === 0\)/` stopped matching a guard that was
    // still there and still correct. A detector narrower than what it detects
    // reads as a missing guard, which is the louder half of that failure and
    // not the dangerous one; the dangerous one is the next rewording.
    const guard = code.search(/Nothing to move\. No issue changed\./);
    const resolve = code.search(/field\(name:\s*"Status"\)/);
    // Anti-vacuity, both halves — `-1 < anything` would satisfy the ordering
    // for free if either side were renamed away.
    expect(resolve, "the Status field must still be resolved somewhere").toBeGreaterThan(-1);
    expect(
      guard,
      "a `--write` run must short-circuit when nothing is moving",
    ).toBeGreaterThan(-1);
    // **And the short-circuit must count BOTH kinds of move** (#1929). With
    // only `moving.length === 0` a run that promotes nothing and demotes one
    // card returns before the Status field is resolved, so the demotion is
    // decided, logged, and never written — the lane stays wrong while the
    // job reports success, which is the exact defect this issue is about.
    const condition = code.slice(Math.max(0, guard - 400), guard);
    expect(
      condition,
      "the nothing-to-move guard must consider demotions as well as promotions, " +
        "or a demotion-only run exits before it can write anything",
    ).toMatch(/demoting\.length === 0/);
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

/**
 * BR-47..BR-52 — an issue that was **never blocked** can still reach Ready.
 *
 * #1842, G1. Everything above this line is the fan-out from a close, and the
 * fan-out answers exactly one question: what did THIS close free. An issue
 * with no dependencies appears in no `blocking` list, so no close can ever
 * mention it — and this file's own header said *"there is no 'became
 * unblocked' event"* while stopping one sentence short of the consequence.
 * For a repository whose next piece of work was never blocked there was no
 * event at all that could put it in Ready. The lane drained, and a person
 * refilled it with `board-mirror --ready --write`: Claim 7's third
 * falsification, *"a board state reachable only by someone running a command
 * by hand"*, surviving inside the mechanism written to remove it.
 *
 * ## What is NOT the gap, and the control that says so
 *
 * The decider. `isReady` has never asked whether an issue was once blocked —
 * only whether it is blocked NOW — so a never-blocked issue and a just-freed
 * one are the same input to it. BR-47 asserts that rather than assuming it,
 * because if the decider HAD been the gap then a candidate-source change
 * would move nothing and every structural row below would still be green.
 */
describe("BR-47..BR-52: an issue that was never blocked reaches Ready", () => {
  const src = readFileSync(join(ROOT, "scripts/board-ready.ts"), "utf-8");
  // A detector that reads a whole file reads its comments, and both the
  // script and the workflow now explain this change at length.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const yml = readFileSync(join(ROOT, ".github/workflows/board-ready.yml"), "utf-8");
  const ymlLive = yml.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");

  // THE CONTROL. Two inputs identical in every field the decider reads, and
  // the only difference is one the decider cannot see: whether anything ever
  // blocked them. Same verdict, so the gap is upstream of here.
  test("BR-47: the decider cannot tell a never blocked issue from a freed one", () => {
    const freed = dep({ number: 10, blockedByOpen: 0 });
    const neverBlocked = dep({ number: 11, blockedByOpen: 0 });
    const out = fanoutDecisions([freed, neverBlocked], "Ready");
    expect(out.map(d => d.move)).toEqual([true, true]);
    // The negative half, so the row above is not green because everything
    // moves: the same issue with a live blocker does not.
    const [held] = fanoutDecisions([dep({ number: 11, blockedByOpen: 1 })], "Ready");
    expect(held.move).toBe(false);
  });

  // THE GAP, as source. A second candidate source is only safe because it is
  // a SOURCE — both walks push into one array and converge on one mapping and
  // one decider, so a mutation of either reddens both modes. Two deciders
  // would agree on every input anybody tested and no behavioural case could
  // say which was live (`.claude/rules/checks-must-be-able-to-fail.md`).
  test("BR-48: the never blocked candidates come from a second source, not a second decider", () => {
    expect(
      code,
      "no repository-wide open-issue query was found — a close cannot reach an " +
        "issue nobody blocked, so without this the lane still needs a person",
    ).toContain("issues(first:100,after:$c,states:[OPEN])");
    for (const [sym, n] of [["candidates.map(", 1], ["fanoutDecisions(", 1], ["selectReady(", 1]] as const) {
      expect(
        (code.match(new RegExp(sym.replace(/[().]/g, "\\$&"), "g")) ?? []).length,
        `expected exactly ${n} \`${sym}\` in scripts/board-ready.ts — the two candidate ` +
          "sources must converge on one mapping and one decider, or a mutation of " +
          "either leaves the other mode holding the case up",
      ).toBe(n);
    }
  });

  // RUN, do not read. The argument guard sits before any network call, so
  // every refusal below is observable without a credential.
  test("BR-49: every source combination but NONE is accepted", () => {
    const run = (extra: string[]) =>
      Bun.spawnSync(["bun", "scripts/board-ready.ts", "--repo", "o/n", "--project", "PVT_x", ...extra], {
        cwd: ROOT,
        env: { ...process.env, BOARD_PROJECT_TOKEN: "" },
      });
    // The positive half: each accepted spelling gets PAST the source guard and
    // refuses on the credential instead — the same place BR-22 lands a valid
    // `--closed-issue`. Without this the refusal below is green for a reason
    // that has nothing to do with the flags.
    //
    // **BOTH is one of them now** (#1917). It used to be refused, on the true
    // observation that `--top-up` already contains every candidate a fan-out
    // can produce — and that refusal is what left a close unable to refill the
    // lane from the general pool. The two sets are merged rather than
    // concatenated (BR-55), so nothing is counted twice and neither source
    // loses silently.
    for (const extra of [["--top-up"], ["--closed-issue", "7"], ["--top-up", "--closed-issue", "7"]]) {
      const ok = run(extra);
      expect(new TextDecoder().decode(ok.stdout), `${extra.join(" ")} did not reach the credential`)
        .toContain("BOARD_PROJECT_TOKEN");
      expect(new TextDecoder().decode(ok.stderr)).not.toContain("at least one");
    }
    // NEITHER is still refused. An invocation with no source has nothing to
    // look at and must not quietly become either one.
    const p = run([]);
    expect(p.exitCode, "(no source) was not refused").toBe(2);
    expect(new TextDecoder().decode(p.stderr)).toContain("at least one");
  }, 30_000);

  // The trigger. A source nothing fires is a command somebody runs by hand
  // wearing a flag, which is the state this issue exists to leave.
  test("BR-50: an event that is not a close reaches the never blocked path", () => {
    const types = /types:\s*\[([^\]]*)\]/.exec(ymlLive)?.[1]?.split(",").map(s => s.trim().replace(/['"]/g, ""));
    expect(types, "no `types: [...]` found in board-ready.yml — this row would pass vacuously").toBeTruthy();
    expect(types).toContain("closed");
    expect(
      (types ?? []).filter(t => t !== "closed"),
      "every trigger is `closed`, so an issue nobody blocked still has no event " +
        "that can reach it and G1 is not done",
    ).not.toEqual([]);
    expect(ymlLive, "no trigger maps to --top-up").toContain("--top-up");
    // Jason: no schedules. Re-asserted here and not only in BR-12, because
    // the cheapest wrong fix for "nothing fires for an unblocked issue" is a
    // cron, and this is the row that would have to be deleted to add one.
    expect(ymlLive).not.toContain("schedule:");
    expect(ymlLive).not.toContain("cron:");
  });

  // SWEEP FOR THE SHAPE. A trigger type with no `case` arm exits 1 at
  // runtime, which is a red run nobody sees until that event fires in
  // production. Declared types and handled modes are compared as sets.
  test("BR-51: every declared trigger type has a mode arm", () => {
    const types = (/types:\s*\[([^\]]*)\]/.exec(ymlLive)?.[1] ?? "")
      .split(",").map(s => s.trim().replace(/['"]/g, "")).filter(s => s !== "");
    expect(types.length, "no trigger types parsed — this row would pass vacuously").toBeGreaterThan(1);
    // Every arm of the `case`, including the alternations `a|b|c)`.
    //
    // SPACES ROUND THE PIPES ARE OPTIONAL. The first spelling was
    // `[a-z|-]+`, and reformatting the arm to `a | b | c)` — which is what
    // `shfmt` does and what #1846 round 2 wrote by hand — made it match
    // nothing, so the row went red on a change that altered no behaviour.
    // A detector a reformat defeats is the second shape in
    // `.claude/rules/checks-must-be-able-to-fail.md`, and the direction it
    // failed in was loud rather than silent only by luck.
    const arms = new Set(
      [...ymlLive.matchAll(/^\s{10,}([a-z][a-z-]*(?:\s*\|\s*[a-z][a-z-]*)*)\)$/gm)]
        .flatMap(m => m[1].split("|").map(s => s.trim())),
    );
    expect(arms.size, "no `case` arms parsed — this row would pass vacuously").toBeGreaterThan(1);
    expect(
      types.filter(t => !arms.has(t)),
      "a trigger type with no arm in the mode `case` refuses at runtime — a red " +
        "run that first appears when that event fires in production. Add the arm " +
        "in the same edit as the trigger.",
    ).toEqual([]);
  });

  // ai-review round 1 of #1846, and it was right. Occupancy is read ONCE per
  // run and the write happens later, so two overlapping runs each compute
  // `slots = cap - occupied` from the same snapshot and each promote that
  // many — Ready ends up over its cap with no warning, which is the property
  // BR-52 below is there to protect. The race existed under `closed` alone
  // and needed two closes in the same few seconds; the four added types
  // cluster during any triage session, so the widening is what obliges the
  // group. Asserted rather than left to the reviewer who widens it next.
  test("BR-53: two events cannot race past the cap for a never blocked issue", () => {
    expect(
      ymlLive,
      "the workflow has no `concurrency:` group, so two issue events seconds " +
        "apart each read the same occupancy and each promote `cap - occupied` " +
        "items. The cap is what makes top-up safe on an ordinary event; without " +
        "serialisation it is advisory.",
    ).toMatch(/^concurrency:/m);
    expect(ymlLive).toMatch(/group:\s*board-ready/);
    // `cancel-in-progress: true` would cancel the RUNNING job, which can be
    // mid-write — the one thing here that is not a pure function of live
    // state. A superseded PENDING run costs nothing and is not what this
    // forbids.
    expect(
      ymlLive,
      "cancel-in-progress must be false: the running job can be part-way " +
        "through its writes, and every run re-reads live state anyway, so " +
        "cancelling the one in flight is the only option that loses anything.",
    ).toMatch(/cancel-in-progress:\s*false/);
  });

  /**
   * BR-54 — no input can become a FLAG on the way to the script.
   *
   * ai-review round 2 of #1846. The step built `SOURCE="--closed-issue $ISSUE"`
   * and expanded it unquoted at the call site, under a comment of mine saying
   * both composed variables came from a closed set. True of `MODE` and
   * `WRITE`; false of the only one that mattered. `ISSUE` is the
   * `workflow_dispatch` free-text input — `type: string`, no validation — so a
   * dispatch with `issue: "7 --write"` and the write box UNCHECKED word-split
   * into `--closed-issue`, `7`, `--write`, and a run the operator asked to
   * report performed real board mutations.
   *
   * **The script cannot defend against this.** By the time it reads `argv` the
   * tokens are separate and `arg("closed-issue")` sees a valid `7`. The
   * workflow is the only place the property exists, so this is the only place
   * it can be asserted.
   *
   * CENSUSED OVER THE WHOLE `run:` BLOCK, not over the line that was wrong.
   * A repair to the one spelling is the fourth shape in
   * `.claude/rules/checks-must-be-able-to-fail.md`: the next composed
   * variable somebody adds re-makes this exactly.
   */
  test("BR-54: nothing a never blocked top-up run reads can word-split into a flag", () => {
    // The LAST `run:` block in the file — the step that invokes the script.
    const at = ymlLive.lastIndexOf("run: |");
    expect(at, "no `run: |` block found — this row would pass vacuously").toBeGreaterThan(-1);
    const block = ymlLive.slice(at);
    expect(block, "the censused block is not the one that invokes the script").toContain(
      "bun scripts/board-ready.ts",
    );
    // Strip every correctly-quoted expansion, then anything left that still
    // looks like one is unquoted. `"${args[@]}"` and `"$ISSUE"` go; a bare
    // `$SOURCE` or `$WRITE` on an argument line stays.
    //
    // **`\"` FIRST, and it is not a detail.** The warning lines here spell
    // an embedded quote as `\"$MODE\"`, and a naive `"[^"]*"` closes its
    // span on the backslash-quote — which left `$MODE` sitting OUTSIDE the
    // stripped text and reported two correctly-quoted expansions as bare.
    // Caught by this row going red against the fix it was written for, which
    // is the only reason it was not relaxed instead.
    const stripped = block
      .split("\n")
      .filter(l => !/^\s*#/.test(l))
      .join("\n")
      .replace(/\\"/g, "Q")
      .replace(/"[^"\n]*"/g, '""');
    const bare = [...stripped.matchAll(/\$\{?[A-Za-z_][A-Za-z0-9_]*/g)].map(m => m[0]);
    expect(
      bare,
      "an unquoted expansion in the invocation block. `ISSUE` is free text from " +
        "`workflow_dispatch` with no validation, so a value of `7 --write` " +
        "word-splits into its own argv token and flips the script into write " +
        "mode for an operator who asked for a report. Build the arguments in an " +
        "array and expand it as `\"${args[@]}\"`.",
    ).toEqual([]);
    // The positive half, so the row above cannot go green by matching nothing:
    // the number is validated as digits BEFORE it reaches the array.
    expect(
      block,
      "the issue number must be refused unless it is digits — quoting alone " +
        "makes `7 --write` one argument the script then rejects, which is a " +
        "worse error message for the same bug",
    ).toMatch(/\*\[!0-9\]\*/);
    expect(block, "the arguments must be expanded as a quoted array").toContain('"${args[@]}"');
  });

  // The bound, named where the source is. Top-up's eligible set is the
  // 36-of-46 population `lib/board-ready-rule.ts` was written about; without
  // the cap this mode is "move the backlog to Ready" on every issue event.
  test("BR-52: what a never blocked issue is promoted against is the cap, not the whole backlog", () => {
    const at = code.search(/const selection = selectReady\(/);
    expect(at, "`selectReady` must still bound what top-up promotes").toBeGreaterThan(-1);
    expect(
      code.slice(0, at),
      "the cap must be computed from live throughput before the selection, or " +
        "top-up promotes every eligible open issue",
    ).toMatch(/readyCap\(throughput\)/);
    // And the occupancy it is measured against is the whole board's, read
    // before this point — not the candidate list's.
    expect(code.slice(0, at)).toMatch(/occupied\+\+/);
  });
});

/**
 * BR-55..BR-58 — a close that freed nothing still refills Ready.
 *
 * `closed` is the one event that reliably FREES a slot in this lane, and it
 * was the one event that could not refill it from the general pool: the
 * workflow ran `--closed-issue` there and `--top-up` on the other four types,
 * and the script refused both together. So when the closed issue was blocking
 * nothing, the lane dropped by one and stayed there.
 *
 * Measured 2026-11-08. #1889 closed at 22:02:10Z; run `42528160275` reported
 * `#1889 was blocking nothing. No issue changed.` — correct for what it was
 * asked. The lane then read `Ready 1 of 2 SHORT` with 33 unblocked and
 * unclaimed candidates, and a hand-run `mode=top-up -f write=true` moved
 * `#1157 -> Ready` within seconds (run `42530702081`).
 *
 * THE CONTROL IS BR-58, and it is why the fix is not "always top up and drop
 * the fan-out": a close that WAS blocking something must still name every
 * issue it freed, which is the only thing the fan-out contributes that the
 * top-up cannot.
 */
describe("BR-55..BR-58: a close that freed nothing still refills Ready", () => {
  const src = readFileSync(join(ROOT, "scripts/board-ready.ts"), "utf-8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const yml = readFileSync(join(ROOT, ".github/workflows/board-ready.yml"), "utf-8");
  const ymlLive = yml.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
  /**
   * The `closed)` arm alone, comments already gone.
   *
   * It counts `case`/`esac` rather than matching to the first `;;`, because
   * this arm CONTAINS a nested `case "$ISSUE" in` that validates the number
   * and the first `;;` in the text belongs to that one. The first spelling
   * here matched to it, so both rows below went red against a correct
   * workflow — the second shape in `.claude/rules/checks-must-be-able-to-fail.md`,
   * loud by luck. Indentation is not read at all, so `shfmt` cannot move it.
   */
  const armsOf = (): Map<string, string> => {
    // SCOPED TO `case "$MODE"`. The file holds a second `case` — the trust
    // gate's `case "$perm" in admin|maintain|write)` — whose arms match the
    // same label pattern, so an unscoped parse reported `admin`, `maintain`
    // and `write` as mode arms passing no candidate source. True of them, and
    // nothing to do with this lane.
    const all = ymlLive.split("\n");
    const start = all.findIndex(l => /^\s*case\s+"\$MODE"\s+in\s*$/.test(l));
    const lines: string[] = [];
    for (let d = 0, i = start < 0 ? all.length : start + 1; i < all.length; i++) {
      const l = all[i] ?? "";
      if (/^\s*case\s/.test(l)) d++;
      else if (/^\s*esac\s*$/.test(l)) {
        if (d === 0) break;
        d--;
      }
      lines.push(l);
    }
    const arms = new Map<string, string>();
    for (let i = 0; i < lines.length; i++) {
      // BR-51's own arm-label pattern, alternations and optional spaces round
      // the pipes included, so a `shfmt` reformat cannot empty this map.
      const m = /^\s{10,}([a-z][a-z-]*(?:\s*\|\s*[a-z][a-z-]*)*)\)$/.exec(lines[i] ?? "");
      if (m === null) continue;
      const body: string[] = [];
      let depth = 0;
      for (const l of lines.slice(i + 1)) {
        if (/^\s*case\s/.test(l)) depth++;
        else if (/^\s*esac\s*$/.test(l)) depth--;
        else if (/^\s*;;\s*$/.test(l) && depth === 0) break;
        body.push(l);
      }
      for (const nm of (m[1] ?? "").split("|").map(s => s.trim())) arms.set(nm, body.join("\n"));
    }
    return arms;
  };
  const closedArm = armsOf().get("closed") ?? "";

  // THE DEFECT, behaviourally. A close that freed nothing contributes no
  // candidate, and the run must still have the general pool to draw from.
  test("BR-55: a close that freed nothing still leaves the general pool to promote from", () => {
    const pool = [{ number: 10 }, { number: 11 }, { number: 12 }];
    const freedNothing = mergeCandidateSources([], pool);
    expect(
      freedNothing.candidates.map(c => c.number),
      "a close that was blocking nothing must still consider every open issue — " +
        "this is the whole of #1917, and without it the lane stays one short",
    ).toEqual([10, 11, 12]);
    expect(freedNothing.freed.size, "nothing was freed, so nothing may be named as freed").toBe(0);
    // THE NEGATIVE HALF. Without the top-up source the same close produces
    // nothing, which is exactly the behaviour measured on #1889 — so the row
    // above is not green because the merge returns its input whatever happens.
    expect(mergeCandidateSources([], []).candidates).toEqual([]);
  });

  // MERGED, NOT CONCATENATED. The two sets overlap by construction —
  // `states:[OPEN]` contains every OPEN issue a `blocking` list can produce —
  // and handing the decider the same issue twice lets one close count against
  // the cap twice.
  test("BR-56: an issue reached by both sources is one candidate, not two", () => {
    const both = mergeCandidateSources([{ number: 10 }], [{ number: 10 }, { number: 11 }]);
    expect(
      both.candidates.map(c => c.number),
      "an issue in both the blocking list and the open-issue list must appear ONCE — " +
        "twice lets a single close consume two slots of the cap",
    ).toEqual([10, 11]);
    // Close-freed first, so the log names what this event freed before the
    // pool it was topped up from.
    expect(mergeCandidateSources([{ number: 11 }], [{ number: 10 }]).candidates.map(c => c.number))
      .toEqual([11, 10]);
    // ANTI-VACUITY: distinct numbers are both kept, so the row above is not
    // green because the merge drops the second list.
    expect(mergeCandidateSources([{ number: 10 }], [{ number: 11 }]).candidates.map(c => c.number))
      .toEqual([10, 11]);
    // A node with no number is unreadable rather than duplicate, and two of
    // them must not collapse into one.
    expect(mergeCandidateSources([], [{}, {}] as { number?: unknown }[]).candidates.length).toBe(2);
  });

  // THE WIRING. A merge nothing calls with two populated lists is a function
  // with no caller, and the workflow is where the close learns to top up.
  test("BR-57: the close event passes BOTH sources, quoted", () => {
    expect(closedArm, "no `closed)` arm was parsed — this row would pass vacuously").not.toBe("");
    expect(
      closedArm,
      "the `closed` arm must pass --top-up as well as --closed-issue, or a close " +
        "that unblocked nothing leaves Ready one short until a person runs a command",
    ).toContain("--top-up");
    // BR-54's property, at the site #1917 adds. `$ISSUE` is the
    // `workflow_dispatch` free-text input; unquoted it word-splits into flags.
    expect(closedArm, "--closed-issue must take a QUOTED $ISSUE").toContain('--closed-issue "$ISSUE"');
    expect(closedArm).not.toMatch(/--closed-issue\s+\$ISSUE/);
    // And the script accepts the pair rather than refusing it.
    expect(
      code,
      "the source guard must refuse only when NEITHER source is given",
    ).toMatch(/if \(!topUp && rawClosed === null\)/);
    expect(code, "both walks must feed the one merge").toContain("mergeCandidateSources(closeNodes, openNodes)");
  });

  // THE CONTROL. The fan-out contributes no candidate the top-up lacks, so
  // "always top up and drop the fan-out" passes every row above. What it
  // loses is the reporting: a close must still name every issue it freed,
  // moved or not, where a top-up names only the movers.
  test("BR-58: a close that WAS blocking something still names every issue it freed", () => {
    const freedTwo = mergeCandidateSources([{ number: 10 }, { number: 11 }], [{ number: 12 }]);
    expect(
      [...freedTwo.freed].sort((a, b) => a - b),
      "the issues this close freed must be identified, or the log cannot name them",
    ).toEqual([10, 11]);
    expect(freedTwo.freed.has(12), "an issue the close did not free is not freed").toBe(false);
    // The log keys on that set, and on nothing else. `freed` is empty on a
    // pure top-up and holds every candidate on a pure fan-out, so this one
    // expression is what both modes always did.
    expect(
      code,
      "the log must name a non-moving candidate when this close freed it — " +
        "dropping the fan-out would silently stop reporting what a close unblocked",
    ).toMatch(/if \(!freed\.has\(dec\.number\) && !dec\.move\) continue;/);
    // And the workflow must still ask for it.
    expect(
      closedArm,
      "the `closed` arm must still pass --closed-issue — replacing it with --top-up " +
        "alone promotes the same issues and stops saying what the close freed",
    ).toContain("--closed-issue");
  });

  // ai-review round 1 of #1919, and it was right. `BLOCKING_QUERY` has no
  // `states:` filter where `TOP_UP_QUERY` asks for `[OPEN]`, so once the two
  // sources merge, a close whose `blocking` list holds an already-closed
  // dependent puts a CLOSED issue in `candidates`. Counting the merged array
  // in a line that calls every member an open issue reports a number no query
  // returned — and it only became wrong when both sources could run at once,
  // which is this change.
  //
  // Source-ORDER, like BR-42 and BR-52 and for the same reason: `main()`
  // needs a live endpoint, and a mock deep enough to reach this line would
  // assert against its own fixture.
  test("BR-60: each source's summary counts that source, not the merged set", () => {
    const line = /Top-up: \$\{([^}]*)\}\.?\s*open issue\(s\) considered/.exec(code);
    expect(line, "no top-up summary line found — this row would pass vacuously").not.toBeNull();
    expect(
      line?.[1],
      "the top-up summary must count the nodes the OPEN-issue query returned. " +
        "`candidates` is the merged set and can hold CLOSED dependents from the " +
        "blocking list, which no `states:[OPEN]` query ever returned.",
    ).toBe("openNodes.length");
    // The other half of the same line, so the fix is not one-sided: the close
    // reports what it was BLOCKING, which is true whatever state those are in.
    expect(
      code,
      "the close summary must not claim to have freed issues that were already closed",
    ).toMatch(/#\$\{closed\} closed, blocking \$\{freed\.size\} issue\(s\)/);
  });

  // SWEEP FOR THE SHAPE, and this row exists because the battery for the four
  // above found it: deleting `--top-up` from the `assigned)` arm left every
  // case green, and that arm would then pass no candidate source at all. The
  // script refuses such a run with `pass at least one of` — a red run that
  // first appears when that event fires in production, which is exactly what
  // BR-51 says about an arm that does not exist. BR-51 asks whether the arm is
  // there; this asks whether it does anything.
  //
  // It is the shape #1917 makes reachable: BOTH sources are legal now, so the
  // guard that used to refuse a second flag no longer refuses anything except
  // NONE, and NONE is per-arm rather than per-file.
  test("BR-59: every mode arm passes at least one candidate source", () => {
    const arms = armsOf();
    expect(
      arms.size,
      "no mode arms parsed — this row would pass vacuously",
    ).toBeGreaterThan(3);
    const sourceless = [...arms]
      .filter(([, body]) => !/--top-up|--closed-issue/.test(body))
      .map(([n]) => n);
    expect(
      sourceless,
      "a mode arm that passes neither --top-up nor --closed-issue refuses at runtime " +
        "with `pass at least one of`, so the lane silently stops refilling for that " +
        "event. BOTH sources are legal; NEITHER is not.",
    ).toEqual([]);
  });
});
