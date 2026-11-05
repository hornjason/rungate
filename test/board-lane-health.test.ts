/**
 * Covers SC-2670 (specs/BOARD-FLOW-SPEC.md).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { LANES, laneHealth, laneHealthLines, type LaneCensus } from "../lib/board-lane-health";

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
  notPlannedClosed: 23,
  complete: true,
  ...over,
});
const by = (c: LaneCensus, lane: string) => laneHealth(c).find(r => r.lane === lane)!;

describe("a lane count is only a reading against what should be in it", () => {
  // The measurement that motivated the whole spec, as a case. Ready holding
  // 6 is excellent if 6 is everything eligible and total failure if 34 are,
  // and the bare count cannot tell those apart.
  test("SC-2670: Ready below the pickable set is SHORT, and names the gap", () => {
    const r = by(census(), "Ready");
    expect(r.health).toBe("SHORT");
    expect(r.against, "a lane judged against nothing is a number, not a reading").toBe(34);
    expect(r.why).toContain("28");
  });

  test("SC-2670: Ready holding everything eligible is OK", () => {
    const r = by(census({ pickable: 6 }), "Ready");
    expect(
      r.health,
      "the same count of 6 must read OK here and SHORT above, or the denominator is decorative",
    ).toBe("OK");
  });

  // UNWRITTEN and SHORT are separated because the remedies differ: SHORT
  // means the writer is not keeping up, UNWRITTEN means there is no writer.
  // Both of these lanes are genuinely in the second state today.
  test("SC-2670: an empty lane with a non-empty denominator is UNWRITTEN, not SHORT", () => {
    expect(by(census(), "Cancelled").health).toBe("UNWRITTEN");
    expect(by(census({ counts: new Map([["In progress", 0]]) }), "In progress").health).toBe("UNWRITTEN");
    // and the contrast, so UNWRITTEN is not simply what empty always says
    expect(
      by(census({ notPlannedClosed: 0 }), "Cancelled").health,
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
  test("SC-2670: an unmeasured cancellation count refuses Cancelled, never passes it", () => {
    const r = by(census({ notPlannedClosed: null }), "Cancelled");
    expect(
      r.health,
      "a search that returned nothing is not a repository with no cancelled work",
    ).toBe("UNMEASURED");
    expect(r.health).not.toBe("OK");
    // and the contrast — a real zero IS a reading, and reads OK
    expect(by(census({ notPlannedClosed: 0 }), "Cancelled").health).toBe("OK");
  });

  // ## Finding 3 — the denominator must count the same population
  //
  // `pickable` is repo-wide while the lane counts are board-only, so an
  // unblocked unclaimed issue that is not on the board inflates the gap.
  // "29 are missing from Ready" would overstate by however many eligible
  // issues the board has never held.
  test("SC-2670: a denominator from a wider population than the lane says so", () => {
    const line = laneHealthLines([by(census(), "Ready")])[0]!;
    expect(
      line + by(census(), "Ready").why,
      "the lane counts board items and `pickable` counts the whole repository. A gap " +
        "computed across two populations must declare it rather than read as exact.",
    ).toMatch(/repo-wide|whole repository|not on the board/i);
  });

  test("SC-2670: every lane the board uses appears in the report, in flow order", () => {
    const rs = laneHealth(census());
    expect(rs.map(r => r.lane)).toEqual([...LANES]);
    const lines = laneHealthLines(rs);
    expect(lines.length).toBe(LANES.length);
    for (const lane of LANES) {
      expect(lines.some(l => l.includes(lane)), `${lane} is missing from the printed report`).toBe(true);
    }
  });

  // The report must carry the reason, not just the verdict. "Ready SHORT"
  // sends the reader to look it up; "28 missing of 34 unblocked and
  // unclaimed" is the finding itself.
  test("SC-2670: the printed line carries the denominator and the reason", () => {
    const line = laneHealthLines([by(census(), "Ready")])[0]!;
    expect(line).toContain("of 34");
    expect(line).toContain("unblocked and unclaimed");
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
