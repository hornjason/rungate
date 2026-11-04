/**
 * BS-1..BS-8 — `scripts/board-status-sweep.ts`.
 *
 * The sweep that makes the board's Status column agree with GitHub. Every
 * decision it makes is `verdictFor`, so these cases run against that one
 * binding rather than against the network.
 *
 * BS-7 is the row that matters most and is the easiest to lose: an open ISSUE
 * marked Done must be reported and never written. Done is certainly wrong for
 * it, and no column is derivable — so the tempting "fix" is to put it in
 * Backlog, which replaces a visibly wrong board with a plausibly wrong one.
 * That is the fifth shape in `.claude/rules/checks-must-be-able-to-fail.md`:
 * a case that goes green under the wrong repair.
 */
import { describe, expect, test } from "bun:test";
import {
  DONE,
  IN_REVIEW,
  sweep,
  verdictFor,
  type BoardItem,
  type ItemKind,
  type ItemState,
} from "../scripts/board-status-sweep";

function item(
  number: number,
  kind: ItemKind,
  state: ItemState,
  status: string | null,
): BoardItem {
  return { itemId: `PVTI_${number}`, number, kind, state, status };
}

describe("board status sweep", () => {
  test("BS-1: a merged pull request not marked Done is corrected to Done", () => {
    const v = verdictFor(item(1749, "PullRequest", "MERGED", "In review"));
    expect(v.kind).toBe("correct");
    expect(v.kind === "correct" && v.to).toBe(DONE);
  });

  test("BS-2: a closed issue not marked Done is corrected to Done", () => {
    const v = verdictFor(item(1727, "Issue", "CLOSED", "In progress"));
    expect(v.kind).toBe("correct");
    expect(v.kind === "correct" && v.to).toBe(DONE);
  });

  test("BS-3: an item with NO status at all is still corrected when closed", () => {
    // `null` and "some wrong column" are different readings of the board and
    // must not be conflated — an item that was never given a Status is the
    // commonest way a closed item escapes a sweep that only looks for
    // disagreement between two present values.
    const v = verdictFor(item(1646, "PullRequest", "MERGED", null));
    expect(v.kind).toBe("correct");
    expect(v.kind === "correct" && v.to).toBe(DONE);
  });

  test("BS-4: a merged pull request already marked Done is left alone", () => {
    expect(verdictFor(item(1645, "PullRequest", "MERGED", DONE)).kind).toBe("agrees");
  });

  test("BS-5: an open pull request marked Done is corrected to In review", () => {
    // #1607, the instance that started this: OPEN and BLOCKED, board said Done.
    const v = verdictFor(item(1607, "PullRequest", "OPEN", DONE));
    expect(v.kind).toBe("correct");
    expect(v.kind === "correct" && v.to).toBe(IN_REVIEW);
  });

  test("BS-6: an open item in any non-Done column is left alone", () => {
    // The sweep is not a second opinion on where open work sits. Backlog,
    // Ready and In progress are all legitimate for an open item, and moving
    // them would make this a competing decider against board-intake.yml.
    for (const status of ["Backlog", "Ready", "In progress", IN_REVIEW, null]) {
      expect(verdictFor(item(1740, "PullRequest", "OPEN", status)).kind).toBe("agrees");
      expect(verdictFor(item(1741, "Issue", "OPEN", status)).kind).toBe("agrees");
    }
  });

  test("BS-7: an open ISSUE marked Done is undecidable, never corrected", () => {
    const v = verdictFor(item(1744, "Issue", "OPEN", DONE));
    expect(v.kind).toBe("undecidable");
    // The reason has to name why a guess is refused, or the next reader
    // deletes the branch as an oversight and writes Backlog.
    expect(v.kind === "undecidable" && v.why).toContain("not derivable");
  });

  test("BS-8: the reading partitions the population exactly once", () => {
    // Anti-vacuity. Every item lands in exactly one bucket and the totals add
    // up, so a verdict that silently returns nothing cannot read as a clean
    // board.
    const items = [
      item(1749, "PullRequest", "MERGED", "In review"), // correct -> Done
      item(1645, "PullRequest", "MERGED", DONE), // agrees
      item(1607, "PullRequest", "OPEN", DONE), // correct -> In review
      item(1744, "Issue", "OPEN", DONE), // undecidable
      item(1740, "PullRequest", "OPEN", "Backlog"), // agrees
    ];
    const r = sweep(items);

    expect(r.agrees).toBe(2);
    expect(r.corrections.map(c => c.number).sort()).toEqual([1607, 1749]);
    expect(r.undecidable.map(u => u.number)).toEqual([1744]);
    expect(r.agrees + r.corrections.length + r.undecidable.length).toBe(items.length);
  });
});
