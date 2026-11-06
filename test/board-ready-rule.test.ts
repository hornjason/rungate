/**
 * Covers SC-2710, SC-2711, SC-2712, SC-2715, SC-2716, SC-2719 (specs/BOARD-FLOW-SPEC.md).
 *
 * ## The mutation battery, predicted before it was run
 *
 * Both columns matter. A mutation of the shared rule has to redden the
 * WRITER's cases and the HEALTH READING's cases, because the defect this
 * module exists to remove was exactly two files holding two definitions with
 * no single site a mutation could move
 * (`.claude/rules/checks-must-be-able-to-fail.md`, *two deciders*).
 *
 *   mutant                                   this file      lane-health
 *   READY_TOLERANCE_DAYS 0.5 -> 1            3, predicted 3  3, predicted 3
 *   readyCap drops the `days <= 0` refusal   1, predicted 1  0, predicted 0
 *   readyCap drops the floor of 1            1, predicted 1  1, predicted 1
 *   readyTarget drops the Math.min           1, predicted 1  4, predicted 4
 *
 * **Mutant 4 read 3 against a prediction of 4 on the first pass, and the
 * missing row was a forgeable assertion rather than a bad prediction.** The
 * printed-line case matched `"of 8"`, which the LABEL also contains — "a
 * depth of 8" — so the row stayed green while the denominator it was
 * checking had become 34. Tightened to `"6 of 8"`, which only the count can
 * supply, and the mutant then read 4. Predicting the membership rather than
 * the total is what surfaced it.
 *
 * Readings are in the PR body and in `specs/BOARD-FLOW-SPEC.md`.
 *
 * Mutant 2 is the one that reddens only one column, and that is the honest
 * reading rather than a gap: a refusal inside `readyCap` is invisible to a
 * census whose fixtures all carry a readable window. The three that change
 * a NUMBER move both files, which is the property this module exists for.
 *
 * **Every number below is a literal, deliberately.** Asserting the writer
 * against `readyCap(...)` and the health row against `readyCap(...)` would
 * make both sides move together under a mutation and the battery would read
 * zero — `feedback-mutating-a-constant-moves-both-sides`. So the cap of 8 is
 * typed out in both files and the mutant has to break it in both.
 */
import { describe, expect, test } from "bun:test";
import {
  READY_TOLERANCE_DAYS,
  heldReason,
  readyCap,
  readyOrder,
  readyTarget,
  selectReady,
  type Rankable,
} from "../lib/board-ready-rule";

const item = (number: number, phase: number | null): Rankable => ({ number, phase });

/** The live reading of 2026-11-05: 237 issues delivered over 14 days. */
const LIVE = { delivered: 237, days: 14 } as const;

describe("SC-2710: the cap is derived from live throughput, not typed in", () => {
  test("the 2026-11-05 reading of 237 over 14 days gives a depth of 8", () => {
    expect(
      readyCap(LIVE),
      "237/14 is 16.9 a day; half a day of cover is 8. This is the number Jason approved",
    ).toBe(8);
  });

  // The control for the case above. A `readyCap` that ignored its argument
  // and returned 8 would pass that test and fail this one, which is the
  // whole difference between a derived depth and a literal in a function.
  test("a different throughput gives a different depth", () => {
    expect(readyCap({ delivered: 20, days: 10 }), "2/day, half a day is 1").toBe(1);
    expect(readyCap({ delivered: 400, days: 10 }), "40/day, half a day is 20").toBe(20);
    expect(readyCap({ delivered: 1000, days: 14 })).toBe(35);
  });

  test("a repository that delivered nothing still lets the first item through", () => {
    expect(
      readyCap({ delivered: 0, days: 14 }),
      "a floor of 0 would mean Ready can never start, and the lane would be permanently empty",
    ).toBe(1);
  });

  test("the tolerance is half a day", () => {
    expect(READY_TOLERANCE_DAYS).toBe(0.5);
  });
});

describe("SC-2711: a window that cannot produce a rate is UNMEASURED, never zero", () => {
  test("a zero-length or negative window refuses", () => {
    expect(readyCap({ delivered: 237, days: 0 })).toBeNull();
    expect(readyCap({ delivered: 237, days: -1 })).toBeNull();
  });

  test("a non-finite or negative reading refuses", () => {
    expect(readyCap({ delivered: Number.NaN, days: 14 })).toBeNull();
    expect(readyCap({ delivered: 237, days: Number.NaN })).toBeNull();
    expect(readyCap({ delivered: -5, days: 14 })).toBeNull();
  });

  test("an unreadable cap leaves the lane with no denominator", () => {
    expect(readyTarget(34, null)).toBeNull();
  });
});

describe("SC-2712: the lane is judged against the capped target", () => {
  test("with more eligible work than depth, the target is the depth", () => {
    expect(readyTarget(34, 8)).toBe(8);
  });

  test("with less eligible work than depth, the target is the work", () => {
    expect(
      readyTarget(3, 8),
      "a lane holding every eligible item is healthy however far below its cap it sits",
    ).toBe(3);
  });
});

describe("SC-2715: phase orders the queue, and never empties it", () => {
  test("lower phase first, then older issue first", () => {
    const got = [item(50, 1), item(10, 1), item(99, 0), item(7, 2)].sort(readyOrder).map(i => i.number);
    expect(got).toEqual([99, 10, 50, 7]);
  });

  // The decision of 2026-11-05, as a case. Under the rule this replaces a
  // phase-less issue was not merely last, it was INELIGIBLE — and 22 of the
  // 35 pickable issues that day had no milestone at all.
  test("a phase-less issue sorts LAST, and is still in the queue", () => {
    const got = [item(3, null), item(9, 2), item(4, null), item(1, 0)].sort(readyOrder).map(i => i.number);
    expect(
      got,
      "phase-less items come after every phased one and before nothing — ordering, not a gate",
    ).toEqual([1, 9, 3, 4]);
  });

  test("a queue of only phase-less issues is ordered by age, not discarded", () => {
    expect([item(8, null), item(2, null)].sort(readyOrder).map(i => i.number)).toEqual([2, 8]);
  });
});

describe("SC-2716: the cap binds, and replenishes as slots free", () => {
  const twelve = Array.from({ length: 12 }, (_, i) => item(i + 1, 0));

  test("more eligible work than depth promotes exactly the depth, in order", () => {
    expect(selectReady(twelve, 4, 0).promote.map(i => i.number)).toEqual([1, 2, 3, 4]);
  });

  test("a full lane promotes nothing", () => {
    const r = selectReady(twelve, 4, 4);
    expect(r.promote).toEqual([]);
    expect(r.why).toContain("full");
  });

  test("a pull frees a slot and the next event refills exactly that many", () => {
    expect(selectReady(twelve, 4, 2).promote.map(i => i.number)).toEqual([1, 2]);
    expect(selectReady(twelve, 4, 3).promote.map(i => i.number)).toEqual([1]);
  });

  test("a lane over its depth promotes nothing rather than a negative count", () => {
    expect(selectReady(twelve, 4, 11).promote).toEqual([]);
  });

  test("less eligible work than depth promotes all of it", () => {
    expect(selectReady([item(5, 1), item(2, 0), item(9, null)], 4, 0).promote.map(i => i.number)).toEqual([
      2, 5, 9,
    ]);
  });

  // Promoting everything eligible on an unreadable cap is the 36-of-46
  // reading performed automatically, which is the failure the cap exists
  // to prevent.
  test("an unreadable cap promotes nothing and says UNMEASURED", () => {
    const r = selectReady(twelve, null, 0);
    expect(r.promote).toEqual([]);
    expect(r.why).toContain("UNMEASURED");
  });

  test("selection does not mutate its input", () => {
    const given = [item(3, 1), item(1, 0)];
    selectReady(given, 4, 0);
    expect(given.map(i => i.number), "sorting in place reorders the caller's decision record").toEqual([3, 1]);
  });

  // The binding between the two halves, as behaviour: what the health
  // reading demands and what the writer supplies are the same number.
  test("what the writer promotes into an empty lane equals the target the reading judges against", () => {
    for (const eligible of [0, 1, 3, 4, 12, 34]) {
      const items = Array.from({ length: eligible }, (_, i) => item(i + 1, 0));
      expect(
        selectReady(items, 4, 0).promote.length,
        `with ${eligible} eligible the reading and the writer must not disagree`,
      // Non-null because the cap is a literal 4 here; `readyTarget` only
      // returns null for an unreadable cap, which the case above covers.
      ).toBe(readyTarget(eligible, 4)!);
    }
  });
});

describe("SC-2719: a held issue is told WHY it was held", () => {
  // ai-review on #1793: every eligible issue was told "Ready is at its
  // depth", including on a run where the depth was never read — one line
  // below the run's own UNMEASURED warning.
  test("an unmeasured depth does not claim the lane is full", () => {
    expect(heldReason(null)).toContain("could not be measured");
    expect(
      heldReason(null),
      "a reading that names the wrong cause sends the next person to the wrong place",
    ).not.toContain("at its depth");
  });

  test("a measured depth does say the lane is full", () => {
    expect(heldReason(4)).toContain("at its depth");
  });

  // Zero is a real cap, not a missing one, and the two must not collapse.
  test("a depth of zero is a full lane, not an unread one", () => {
    expect(heldReason(0)).toContain("at its depth");
  });
});
