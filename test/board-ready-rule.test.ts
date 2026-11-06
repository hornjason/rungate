/**
 * Covers SC-2710, SC-2711, SC-2712 (specs/BOARD-FLOW-SPEC.md).
 *
 * ## The mutation battery, predicted before it was run
 *
 * Both columns matter. A mutation of the shared rule has to redden the
 * WRITER's cases and the HEALTH READING's cases, because the defect this
 * module exists to remove was exactly two files holding two definitions with
 * no single site a mutation could move
 * (`.claude/rules/checks-must-be-able-to-fail.md`, *two deciders*).
 *
 *   mutant                                   this file     lane-health
 *   READY_TOLERANCE_DAYS 0.5 -> 1            predicted 3   predicted 3
 *   readyCap drops the `days <= 0` refusal   predicted 1   predicted 0
 *   readyCap drops the floor of 1            predicted 1   predicted 1
 *   readyTarget drops the Math.min           predicted 1   predicted 4
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
import { READY_TOLERANCE_DAYS, readyCap, readyTarget } from "../lib/board-ready-rule";

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
