/**
 * Covers SC-2670 (specs/BOARD-FLOW-SPEC.md).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  LANES,
  handPlacedInReview,
  handPlacedInReviewLine,
  laneHealth,
  laneHealthLines,
  workVerdict,
  type InReviewCensus,
  type LaneCensus,
  type WorkEvidence,
} from "../lib/board-lane-health";
import { structuralCut } from "../lib/source-slice";

const census = (over: Partial<LaneCensus> = {}): LaneCensus => ({
  counts: new Map([
    ["Backlog", 80],
    ["Ready", 6],
    ["In progress", 1],
    ["In review", 1],
    ["Done", 47],
    ["Cancelled", 0],
  ]),
  pickable: 34,
  openAssigned: 9,
  cancelledClosed: 23,
  // A FIXTURE, not a measurement. It was labelled "the live reading of
  // 2026-11-05: 237 issues delivered over 14 days, so a cap of 8" — and
  // that reading does not reproduce. Paging every closed issue with a
  // `closedAt` gives 9 over 7 days, 132 over 14 and 646 over 30, so the
  // live depth is 4. The number below is kept because the cases are
  // written against it, and relabelled because a comment claiming a
  // provenance it does not have is worse than no comment.
  throughput: { delivered: 237, days: 14 },
  complete: true,
  ...over,
});
const by = (c: LaneCensus, lane: string) => laneHealth(c).find(r => r.lane === lane)!;

describe("a lane count is only a reading against what should be in it", () => {
  // The measurement that motivated the whole spec, as a case. Ready holding
  // 6 is excellent if 6 is everything eligible and total failure if 34 are,
  // and the bare count cannot tell those apart.
  test("SC-2670: Ready below what it is allowed to hold is SHORT, and names the gap", () => {
    const r = by(census(), "Ready");
    expect(r.health).toBe("SHORT");
    expect(
      r.against,
      "34 are eligible but the depth is 8, so 8 is what the lane should hold. Judging it " +
        "against all 34 is what made this row report `SHORT by 30` against a writer that " +
        "could never promote more than 3 (SC-2712)",
    ).toBe(8);
    expect(r.why).toContain("2");
  });

  test("SC-2670: Ready holding everything eligible is OK", () => {
    const r = by(census({ pickable: 6 }), "Ready");
    expect(
      r.health,
      "the same count of 6 must read OK here and SHORT above, or the denominator is decorative",
    ).toBe("OK");
  });

  // SC-2712, the decision of 2026-11-05: Ready is a commitment point, so a
  // full lane is correct however much eligible work is queued behind it.
  // Before the cap this case read SHORT and no amount of promotion fixed it.
  test("SC-2712: a lane at its depth is OK even with far more eligible work", () => {
    const r = by(census({ counts: new Map([["Ready", 8]]), pickable: 34 }), "Ready");
    expect(r.health).toBe("OK");
    expect(r.against).toBe(8);
    expect(r.why, "the reading has to say what the depth came from").toContain("throughput");
  });

  // The control for the case above: the depth is derived, so a repository
  // delivering a tenth as much gets a tenth of the queue and the SAME lane
  // count reads differently. A hardcoded 8 would pass both of the cases
  // above and fail this one.
  test("SC-2712: a slower repository gets a shallower queue", () => {
    const slow = census({ counts: new Map([["Ready", 8]]), throughput: { delivered: 20, days: 14 } });
    expect(by(slow, "Ready").against, "20/14 is 1.4 a day; half a day is 0, floored up to 1").toBe(1);
  });

  // Found on the FIRST live run of the capped reading, not in review: the
  // board held 5 in Ready against a derived depth of 4 — filled under the
  // uncapped rule — and the row read OK. Before the cap, `count > against`
  // could not happen for a lane with a repo-wide denominator, so OK
  // absorbed it silently. SHORT and OVER have opposite remedies.
  test("SC-2712: a lane above its depth is OVER, not OK", () => {
    const r = by(census({ counts: new Map([["Ready", 5]]), throughput: { delivered: 132, days: 14 } }), "Ready");
    expect(r.against, "132/14 is 9.4 a day; half a day is 4").toBe(4);
    expect(r.health, "an over-full commitment point reported as OK is the lane lying the other way").toBe("OVER");
    expect(r.why).toContain("1 too many");
  });

  // The converse, so OVER is not simply what a non-empty lane always says.
  test("SC-2712: a lane exactly at its depth is OK, not OVER", () => {
    const r = by(census({ counts: new Map([["Ready", 4]]), throughput: { delivered: 132, days: 14 } }), "Ready");
    expect(r.health).toBe("OK");
  });

  // `.claude/rules/config-access.md`: a built-in default substituted for a
  // failed read is indistinguishable from a real one, so there is no
  // fallback depth.
  test("SC-2711: an unread throughput leaves Ready UNMEASURED, not healthy", () => {
    const r = by(census({ throughput: null }), "Ready");
    expect(r.health).toBe("UNMEASURED");
    expect(r.against).toBeNull();
    expect(r.why).toContain("throughput");
  });

  // UNWRITTEN and SHORT are separated because the remedies differ: SHORT
  // means the writer is not keeping up, UNWRITTEN means the lane is empty
  // while things that belong in it exist. **Not "there is no writer"** —
  // see SC-2731 below for why that sentence had to go.
  // Both of these lanes are genuinely in the second state today.
  test("SC-2670: an empty lane with a non-empty denominator is UNWRITTEN, not SHORT", () => {
    expect(by(census(), "Cancelled").health).toBe("UNWRITTEN");
    expect(by(census({ counts: new Map([["In progress", 0]]) }), "In progress").health).toBe("UNWRITTEN");
    // and the contrast, so UNWRITTEN is not simply what empty always says
    expect(
      by(census({ cancelledClosed: 0 }), "Cancelled").health,
      "an empty lane whose denominator is also empty is correct, not broken",
    ).toBe("OK");
  });

  // Anti-vacuity, and the failure mode this whole area keeps producing.
  test("SC-2670: an incomplete census refuses every lane and never reads OK", () => {
    const rs = laneHealth(census({ complete: false }));
    expect(rs.every(r => r.health === "UNMEASURED")).toBe(true);
    expect(
      rs.some(r => r.health === "OK"),
      "a board that could not be paged in full must not report a healthy lane",
    ).toBe(false);
  });

  // A lane with no denominator must not borrow OK from the lanes that have
  // one — that is the silent default this repo names as its own worst bug.
  test("SC-2670: a lane with no second source says NO_TARGET, not OK", () => {
    for (const lane of ["Backlog", "In review", "Done"]) {
      const r = by(census(), lane);
      expect(r.health, `${lane} has no denominator and must not claim to be healthy`).toBe("NO_TARGET");
      expect(r.against).toBeNull();
    }
  });

  // ## Security review of the pushed commit, finding 4 — a silent data drop
  //
  // `laneHealth` mapped over LANES and read the census by key, so a lane the
  // board has and this file does not know about contributes items to no row
  // at all. The report would stay confident and complete-looking while some
  // of the board was simply absent from it — and adding a lane on the board
  // is a two-click operation nobody would think to mirror here.
  test("SC-2670: a lane this report does not know about is surfaced, not dropped", () => {
    const counts = new Map([["Backlog", 80], ["Triage", 7]]);
    const rs = laneHealth(census({ counts }));
    const stray = rs.find(r => r.lane === "Triage");
    expect(
      stray,
      "7 items sat in a lane this file has never heard of and produced no row. A report " +
        "that silently omits part of the board is worse than one that refuses.",
    ).toBeDefined();
    expect(stray!.count).toBe(7);
    expect(stray!.health).toBe("UNMEASURED");
  });

  // ## Finding 1 — a failed search must not read as zero cancellations
  //
  // `notPlanned.total_count ?? 0` turned a failed or throttled search into
  // "nothing was ever cancelled", which makes Cancelled read OK — a green
  // lane produced by a measurement that did not happen.
  // The row said `Cancelled 0 of 23 UNWRITTEN — nothing writes it` on
  // 2026-11-05, while lib/board-flow.ts:210 had been moving issues to
  // Cancelled on a not_planned close since that same day, with a recorded
  // run. A census over two numbers cannot see whether a writer exists, so
  // it may not report that one does not.
  test("SC-2731: UNWRITTEN does not claim a writer is missing", () => {
    const why = by(census(), "Cancelled").why;
    expect(by(census(), "Cancelled").health).toBe("UNWRITTEN");
    expect(
      why,
      "the census reads two counts and cannot observe a writer, so it must not name one",
    ).not.toContain("nothing writes it");
    expect(why, "it still has to say what it counted").toContain("this lane is empty");
  });

  // The denominator and the numerator must describe the same population.
  // The label is the only place a reader can check that, so it is asserted
  // rather than left to the field name.
  test("SC-2730: Cancelled is measured against this board, not the repository", () => {
    const why = by(census(), "Cancelled").why;
    expect(
      why,
      "a board lane compared against a repo-wide count reports a gap no writer could close",
    ).toContain("on this board");
    expect(why).not.toContain("repo-wide");
  });

  test("SC-2670: an unmeasured cancellation count refuses Cancelled, never passes it", () => {
    const r = by(census({ cancelledClosed: null }), "Cancelled");
    expect(
      r.health,
      "a search that returned nothing is not a repository with no cancelled work",
    ).toBe("UNMEASURED");
    expect(r.health).not.toBe("OK");
    // and the contrast — a real zero IS a reading, and reads OK
    expect(by(census({ cancelledClosed: 0 }), "Cancelled").health).toBe("OK");
  });

  // ## Finding 3, and its reversal
  //
  // This asserted the opposite: that a repo-wide denominator must DECLARE
  // the mismatch in its label. It was satisfied by the word "repo-wide",
  // and the row was still misread — `Cancelled 0 of 23 UNWRITTEN — nothing
  // writes it` reads as a broken writer no matter what the label says. A
  // declared mismatch is still a mismatch; the populations now agree
  // instead, and the membership signal the old denominators carried has
  // its own line (SC-2730).
  test("SC-2730: no lane declares a denominator from a wider population", () => {
    for (const lane of LANES) {
      const r = by(census(), lane);
      if (r.against === null) continue;
      expect(
        r.why,
        `${lane} compares a board count against a population the board does not hold, so its ` +
          `gap names work no lane writer could move`,
      ).not.toMatch(/repo-wide|whole repository/i);
    }
  });

  test("SC-2730: the membership signal survives as its own reading", () => {
    expect(laneHealthLines([], 4).at(-1)).toContain("NOT on the board");
    expect(laneHealthLines([], 0).at(-1)).toContain("every open issue is on the board");
    expect(
      laneHealthLines([], null).at(-1),
      "unread and none-missing must not spell the same",
    ).toContain("UNMEASURED");
  });

  // ## Round 1, finding 2 (ai-review) and findings 1+2 of the pushed-commit
  // security review — two independent reviewers, the same silent drop
  //
  // `scripts/work-status.ts` records a board item with no Status value under
  // the literal key `"(no status)"`. It matches no name in LANES, and the
  // unknown-lane sweep added above excluded any key beginning `"("`, so those
  // items landed in NO row at all — the exact omission that sweep exists to
  // stop, reintroduced one line below it by the filter meant to tidy it.
  //
  // The filter is gone rather than narrowed. A prefix-based exclusion also
  // means a lane somebody genuinely names `"(parked)"` on the board is
  // suppressed by impersonating a sentinel, so nothing is excluded by
  // spelling any more.
  test("SC-2670: board items with no Status value are surfaced, not dropped", () => {
    const counts = new Map([["Backlog", 80], ["(no status)", 5]]);
    const rs = laneHealth(census({ counts }));
    const row = rs.find(r => r.lane === "(no status)");
    expect(
      row,
      "5 board items carry no Status value and appeared in no row. A report that " +
        "silently omits part of the board is worse than one that refuses.",
    ).toBeDefined();
    expect(row!.count).toBe(5);
    expect(row!.health).toBe("UNMEASURED");
  });

  // ## Round 1, finding 1 (ai-review) — half the spec's own condition
  //
  // specs/BOARD-FLOW-SPEC.md defines Cancelled's entry condition as "closed
  // as `not_planned` or `duplicate`", and lib/work-status.ts already maps
  // BOTH to ABANDONED. The denominator counted only `not_planned`, so a
  // Cancelled lane holding every not_planned issue and no duplicate-closed
  // one reads OK while being short by the duplicates.
  test("SC-2670: the Cancelled denominator names both closure reasons the spec gives", () => {
    const r = by(census(), "Cancelled");
    expect(
      r.why,
      "the spec's condition is `not_planned` OR `duplicate`; a denominator counting " +
        "half of it turns a SHORT lane into an OK one",
    ).toContain("duplicate");
  });

  // ## The `reason:` search qualifier cannot measure `duplicate`
  //
  // Measured 2026-11-05 WITH A CONTROL, which is the whole point:
  // `reason:"not planned"` → 23, `reason:completed` → 716, `reason:duplicate`
  // → 0 — and `reason:bogusvalue` → 0 as well. An unrecognised value and a
  // true zero are the same bytes, so that one search can never see a
  // duplicate closure and adding a second search would have read 0 forever.
  // The count is paged off `stateReason` instead.
  // The decider moved to `lib/board-throughput.ts` when the two passes over
  // the closed issues were combined into one (ai-review on #1793), so this
  // asserts at the file that now holds it AND that the report routes
  // through that file. Pointing only at the report would have gone green
  // on a report that stopped counting duplicates entirely.
  // **Pointed at the site that computes the denominator, which moved.**
  // This asserted `lib/board-throughput.ts` contains "DUPLICATE", and that
  // stayed true after the Cancelled denominator moved to `boardStatus()` —
  // true because the now-unused repo-wide `cancelled` field still spells
  // it. Deleting `|| ... === "DUPLICATE"` from the live site would have
  // reintroduced the exact bug this guards (a lane short by every
  // duplicate, reading OK) with the whole suite green. A guard left
  // pointing at the old site is the third instance of this shape on this
  // branch. ai-review round 2 of #1802.
  test("SC-2670: the board's abandoned count reads BOTH reasons, at the site that counts", () => {
    const src = readFileSync(join(import.meta.dir, "..", "scripts/work-status.ts"), "utf-8");
    const counter = src.slice(src.indexOf("async function boardStatus"), src.indexOf("abandonedOnBoard }"));
    expect(counter, "boardStatus() is where the Cancelled denominator is computed").not.toBe("");
    // **The closing quote is load-bearing.** `toContain("NOT_PLANNED")`
    // is satisfied by `"NOT_PLANNEDX"`, so a corrupted spelling — which
    // matches no issue and silently zeroes that half of the count — read
    // 0 in the battery. Matching the whole comparison catches a deletion
    // AND a typo; the first version caught only the deletion.
    for (const reason of ["NOT_PLANNED", "DUPLICATE"]) {
      expect(
        counter,
        `the lane's entry condition is both reasons, and dropping or misspelling ${reason} ` +
          `makes a lane short by every one of them read OK`,
      ).toContain(`=== "${reason}"`);
    }
    // The search qualifier this replaced could not tell a duplicate from a
    // value the index does not understand: `reason:duplicate` and
    // `reason:bogusvalue` both returned 0, measured with that control.
    expect(counter, "a qualifier cannot distinguish an unknown reason from a true zero").toContain(
      "stateReason",
    );
  });

  // ## Round 2 security review — the spelling test came back as wording
  //
  // Removing the exclusion left a `startsWith("(")` choosing which sentence
  // an unknown key gets. No row is suppressed by it any more, so this is
  // misleading text rather than a data drop — but the commit that removed
  // the exclusion claimed nothing was classified by spelling, and one line
  // below it something was. A board lane genuinely named `"(parked)"` would
  // be told its items "are in no lane", which is false.
  //
  // One honest sentence for every unknown key. Carrying the distinction
  // properly means typed census fields rather than a leading parenthesis,
  // and that is a change to `boardStatus()`, not to this decider.
  //
  // Asserted on CODE, not on commentary: the comments above and in the
  // source both contain the forbidden string, and an unstripped search
  // reddens against the correct fix.
  test("SC-2670: nothing in the decider branches on a lane name's spelling", () => {
    const src = readFileSync(join(import.meta.dir, "..", "lib/board-lane-health.ts"), "utf-8");
    const code = src
      .split("\n")
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(
      code,
      "a lane's spelling decided which explanation it got, so a board lane named " +
        '"(parked)" would be told its items are in no lane',
    ).not.toContain('startsWith("("');
  });

  test("SC-2670: every lane the board uses appears in the report, in flow order", () => {
    const rs = laneHealth(census());
    expect(rs.map(r => r.lane)).toEqual([...LANES]);
    const lines = laneHealthLines(rs, 0);
    // Lanes, then the membership line, which belongs to no lane.
    expect(lines.length).toBe(LANES.length + 1);
    for (const lane of LANES) {
      expect(lines.some(l => l.includes(lane)), `${lane} is missing from the printed report`).toBe(true);
    }
  });

  // The report must carry the reason, not just the verdict. "Ready SHORT"
  // sends the reader to look it up; "6 of 8, 34 eligible behind it, depth
  // derived from throughput" is the finding itself.
  //
  // SC-2712: the line carries BOTH numbers. The depth alone hides how much
  // work is queued; the eligible count alone is what used to be printed and
  // is what made the row read `SHORT by 30` forever.
  test("SC-2670: the printed line carries the denominator and the reason", () => {
    const line = laneHealthLines([by(census(), "Ready")], 0)[0]!;
    // `"of 8"` is NOT enough and the mutation battery proved it: the label
    // itself says "a depth of 8", so dropping the `Math.min` in
    // `readyTarget` left this row green against a denominator of 34. The
    // count has to be in the match, or the assertion is forgeable by the
    // text it is reading.
    expect(line, "the lane is judged against its depth, not against everything eligible").toContain("6 of 8");
    expect(line, "and the eligible count is still shown, or the depth looks arbitrary").toContain("34 unblocked and unclaimed");
    expect(line, "a derived number has to say what it was derived from").toContain("live throughput");
  });

  // The script must actually print it. A decider nothing calls is the shape
  // that let `runVerdict`'s UNMEASURED branch sit unreachable through a
  // whole pull request.
  test("SC-2670: the work-status report calls the decider", () => {
    const src = readFileSync(join(import.meta.dir, "..", "scripts/work-status.ts"), "utf-8");
    expect(src, "lane health is not wired into the report that Jason actually reads").toContain(
      "laneHealthLines",
    );
  });

  // ## The section must say WHICH items it counted
  //
  // Caught by running it: this printed `Done 28` while the board's own UI
  // shows 47 in Done. Both are right. `boardStatus()` keeps only items whose
  // content is an Issue, so every pull request on the board is dropped —
  // and a reader comparing the two numbers concludes one of them is broken.
  //
  // A status report whose population is implicit produces exactly the thing
  // this report exists to stop: a confident number that disagrees with the
  // source and explains neither. The header has to name the population.
  test("SC-2670: the section declares that it counts issues only", () => {
    const src = readFileSync(join(import.meta.dir, "..", "scripts/work-status.ts"), "utf-8");
    const header = src.split("\n").find(l => l.includes("BOARD LANE HEALTH")) ?? "";
    expect(header, "the lane-health header is missing entirely").not.toBe("");
    expect(
      header.toLowerCase(),
      "this prints Done=28 while the board UI shows 47, because pull requests are dropped. " +
        "A reader who is not told that concludes one of the two is wrong.",
    ).toContain("issue");
  });
});

/**
 * #1941 — is anybody actually working this, from the artifacts?
 *
 * The board asks whether an issue has an assignee. Measured 2026-11-09: six
 * were assigned and none had an open pull request; five had no pushed branch
 * at all; the one with real work had it unpushed in a local worktree.
 */
describe("#1941: WORKING, INVISIBLE or PARKED from the evidence, not the assignee", () => {
  const ev = (over: Partial<WorkEvidence> = {}): WorkEvidence => ({
    openPullRequest: false,
    pushedBranch: false,
    localCommits: false,
    ...over,
  });

  test("a pushed branch or an open pull request is WORKING", () => {
    expect(workVerdict(ev({ openPullRequest: true })).verdict).toBe("WORKING");
    expect(workVerdict(ev({ pushedBranch: true })).verdict).toBe("WORKING");
    // The premise this pair needs: the SAME evidence without either is not
    // WORKING, so the rows above are about the fields and not about the
    // function answering WORKING to everything.
    expect(workVerdict(ev()).verdict).not.toBe("WORKING");
  });

  test("local commits and nothing pushed is INVISIBLE, and says what to do", () => {
    const r = workVerdict(ev({ localCommits: true }));
    expect(r.verdict).toBe("INVISIBLE");
    expect(r.why, "a verdict nobody can act on is a status line").toContain("Push the branch");
  });

  test("an assignee and nothing else is PARKED — but only when all three were READ", () => {
    // The safety property, and the reason `null` exists. PARKED is the
    // verdict that releases somebody's claim, so it must not be reachable
    // from an absence: a caller that never looked for local commits and one
    // that looked and found none are different facts.
    expect(workVerdict(ev()).verdict).toBe("PARKED");
    for (const field of ["openPullRequest", "pushedBranch", "localCommits"] as const) {
      const r = workVerdict(ev({ [field]: null }));
      expect(r.verdict, `an unread ${field} still released the claim`).toBe("UNMEASURED");
      expect(r.why, "the refusal does not say which reading was missing").toContain(
        field === "openPullRequest"
          ? "an open pull request"
          : field === "pushedBranch"
            ? "a pushed branch"
            : "local commits",
      );
    }
  });

  test("an unread field does NOT suppress a positive reading that was taken", () => {
    // The other direction, and the one a defensive `null` check written
    // first would get wrong: evidence of real work is evidence however much
    // else went unread, and refusing to say WORKING because the local view
    // was missing would make every CI run UNMEASURED.
    expect(workVerdict({ openPullRequest: true, pushedBranch: null, localCommits: null }).verdict).toBe(
      "WORKING",
    );
    expect(workVerdict({ openPullRequest: null, pushedBranch: true, localCommits: null }).verdict).toBe(
      "WORKING",
    );
    expect(workVerdict({ openPullRequest: null, pushedBranch: null, localCommits: true }).verdict).toBe(
      "INVISIBLE",
    );
  });

  test("a GitHub-only caller can never reach PARKED, and the reason is named", () => {
    // `scripts/board-status-sweep.ts` runs in GitHub Actions, on a machine
    // that has never seen the worktree #1931's commit lives in. This is the
    // finding made legible rather than a limitation to work around: the
    // sweep's honest verdict is "PARKED or INVISIBLE, and I cannot tell".
    const fromActions = workVerdict({ openPullRequest: false, pushedBranch: false, localCommits: null });
    expect(fromActions.verdict).toBe("UNMEASURED");
    expect(fromActions.why).toContain("PARKED or INVISIBLE");
    // And the control: the same runner WITH a local view reaches a verdict,
    // so the row above is about the missing reading and not about the
    // function refusing everything it is handed.
    expect(
      workVerdict({ openPullRequest: false, pushedBranch: false, localCommits: false }).verdict,
    ).toBe("PARKED");
  });

  test("every verdict is reachable, and no two inputs collapse onto one word", () => {
    // The population guard. A fifth verdict added without a branch, or a
    // branch deleted, shows up here rather than in a reviewer's reading.
    const seen = new Set(
      [
        ev({ openPullRequest: true }),
        ev({ localCommits: true }),
        ev(),
        ev({ localCommits: null }),
      ].map(e => workVerdict(e).verdict),
    );
    const declared = structuralCut(
      readFileSync(join(import.meta.dir, "..", "lib/board-lane-health.ts"), "utf-8"),
      "export type WorkVerdict",
      { endAnchor: ";" },
    )
      .match(/"([A-Z]+)"/g)!
      .map(s => s.replaceAll('"', ""));
    const produced: string[] = [...seen];
    expect(
      produced.sort(),
      "a declared verdict no input produces is a branch nothing exercises",
    ).toEqual([...declared].sort());
  });

  /**
   * #1941's binding requirement: ONE decider, read by both callers, so a
   * mutation of it reddens every caller rather than one of them.
   *
   * This is the population half. A behavioural case can only catch the
   * LAST site to regress — the fourth shape in
   * `.claude/rules/checks-must-be-able-to-fail.md` — so the property is
   * asserted over the files instead of per-file.
   *
   * **The reach is asserted as an equality, in both directions.** A caller
   * that stops importing the decider is red, and a file that starts asking
   * this question without being listed here is also red: the second
   * direction is the one that catches a third site quietly re-deriving
   * "is somebody working on this" instead of calling the one function.
   */
  test("both callers reach the one decider, and nobody re-derives it", () => {
    const ROOT = join(import.meta.dir, "..");
    const CALLERS = [
      "lib/board-ready-fanout.ts",
      "scripts/board-status-sweep.ts",
      // #1944. The first caller that can read all three evidence fields,
      // because it is the only one that runs where the local git is
      // reachable. Until it existed, PARKED was declared and unreachable.
      "scripts/work-status.ts",
    ];

    // Read from disk rather than listed, so a new file is in the population
    // the moment it exists. A hand-kept list here would make the second
    // direction below unable to find the thing it is looking for.
    const SOURCE_FILES = ["lib", "scripts"].flatMap(d =>
      readdirSync(join(ROOT, d))
        .filter(f => f.endsWith(".ts"))
        .map(f => `${d}/${f}`),
    );
    expect(
      SOURCE_FILES.length,
      "the source census came back empty, so every assertion below holds vacuously",
    ).toBeGreaterThan(50);

    const notCalling = CALLERS.filter(
      f => !readFileSync(join(ROOT, f), "utf-8").includes("workVerdict("),
    );
    expect(
      notCalling,
      "a declared caller of the work decider does not call it — #1941's whole point is that " +
        "one mutation of workVerdict reddens every caller, and a caller that stopped reading " +
        "it is a second decider nothing can see",
    ).toEqual([]);

    // The other direction. Everything under lib/ and scripts/ that imports
    // the module must be a listed caller or the module itself.
    const owner = "lib/board-lane-health.ts";
    const importers = [...SOURCE_FILES]
      .filter(f => f !== owner)
      .filter(f => /from "\.{1,2}\/(?:lib\/)?board-lane-health"/.test(readFileSync(join(ROOT, f), "utf-8")))
      .filter(f => readFileSync(join(ROOT, f), "utf-8").includes("workVerdict"));
    expect(
      importers.filter(f => !CALLERS.includes(f)).sort(),
      "a file reads the work decider and is not listed in CALLERS. Add it — the list is what " +
        "makes the mutation claim measurable, and a caller nobody listed is a caller nobody " +
        "checked",
    ).toEqual([]);
    expect(
      importers.sort(),
      "a listed caller no longer imports the decider at all, so the equality above held " +
        "vacuously over a shrinking population",
    ).toEqual([...CALLERS].sort());
  });
});

/**
 * #1921 / SC-2759: an issue card in In review that no open pull request
 * declares it closes is reported as hand-placed.
 *
 * In review's entry condition is a ready pull request declaring it closes
 * the issue (`specs/BOARD-FLOW-SPEC.md`), and `laneFor`'s `pr_ready` arm
 * resolves its target through exactly that declaration. With none, nothing
 * in this repository writes the card there and no event moves it out. #1717
 * sat in In review for a week with no link ever recorded on its timeline,
 * and the only visible symptom was In progress reading SHORT.
 *
 * Not a denominator — the In review row keeps NO_TARGET. This names cards.
 */
describe("#1921 / SC-2759: handPlacedInReview", () => {
  const read = (over: Partial<InReviewCensus> = {}): InReviewCensus => ({
    inReview: [1717, 2079],
    declaredClosing: new Set([2079, 2131]),
    closingTruncated: [],
    complete: true,
    ...over,
  });

  test("an In-review issue no open pull request declares is reported, by number", () => {
    const r = handPlacedInReview(read());
    expect(r, "#1717 has no open pull request declaring it, #2079 has one").toEqual({
      kind: "read",
      issues: [1717],
    });
    const line = handPlacedInReviewLine(r);
    expect(line).toContain("#1717");
    expect(line, "an issue with a declaring pull request is not hand-placed").not.toContain("#2079");
    expect(line).toContain("hand-placed");
  });

  test("the control: every In-review issue declared by an open pull request reads none", () => {
    // One variable differs from the case above: #1717 is gone. A decider
    // that reports every In-review card reddens here.
    const r = handPlacedInReview(read({ inReview: [2079] }));
    expect(r).toEqual({ kind: "read", issues: [] });
    expect(handPlacedInReviewLine(r)).toContain(
      "every issue card in In review has an open pull request declaring it closes the issue",
    );
  });

  test("the numbers are distinct and in order", () => {
    const r = handPlacedInReview(read({ inReview: [2140, 1717, 2140], declaredClosing: new Set() }));
    expect(r).toEqual({ kind: "read", issues: [1717, 2140] });
  });

  test("a closing list cut at one page is UNMEASURED, never a list and never none", () => {
    // #1717 would be named here if the cut were ignored, and it may be the
    // very issue the missing page declares.
    const r = handPlacedInReview(read({ closingTruncated: [2150] }));
    expect(r.kind, "a partial closing list reads an issue it covers as having none").toBe("unmeasured");
    const line = handPlacedInReviewLine(r);
    expect(line).toContain("UNMEASURED");
    expect(line, "the reader needs to know which pull request was cut").toContain("#2150");
    expect(line).not.toContain("#1717");
  });

  test("an incomplete board is UNMEASURED, never none", () => {
    const r = handPlacedInReview(read({ inReview: [2079], complete: false }));
    expect(r.kind, "a board read in part may be missing the very card in question").toBe("unmeasured");
    expect(handPlacedInReviewLine(r)).toContain("UNMEASURED");
  });

  test("unread, none and some never print the same line", () => {
    const lines = [
      handPlacedInReviewLine(handPlacedInReview(read())),
      handPlacedInReviewLine(handPlacedInReview(read({ inReview: [2079] }))),
      handPlacedInReviewLine(handPlacedInReview(read({ complete: false }))),
    ];
    expect(new Set(lines).size).toBe(3);
  });

  test("the work-status report prints it from the closing list it already reads", () => {
    // Fed by `declaredClosing` and `closingTruncated`, which the OPEN PULL
    // REQUESTS section collects from `closingIssuesReferences` — no new
    // query, and no sub-selection on the board walk (BR-46).
    const src = readFileSync(join(import.meta.dir, "..", "scripts/work-status.ts"), "utf-8");
    const call = src.slice(src.indexOf("handPlacedInReview({"));
    expect(src.indexOf("handPlacedInReview({"), "the report never asks the question").toBeGreaterThan(-1);
    expect(call.slice(0, call.indexOf("})"))).toContain("declaredClosing");
    expect(call.slice(0, call.indexOf("})"))).toContain("closingTruncated");
    expect(src, "the reading is decided and never printed").toContain("handPlacedInReviewLine(");
  });
});
