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
  BOARD_QUERY,
  DONE,
  IN_REVIEW,
  interpretResponse,
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
  draft = false,
): BoardItem {
  return { itemId: `PVTI_${number}`, number, kind, state, status, draft };
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

  test("BS-5: an open READY pull request marked Done is corrected to In review", () => {
    // #1607, the instance that started this: OPEN and BLOCKED, board said Done.
    // Ready, not draft — BS-13 is the draft half and they must not be merged
    // into one row, because the two have opposite verdicts.
    const v = verdictFor(item(1607, "PullRequest", "OPEN", DONE));
    expect(v.kind).toBe("correct");
    expect(v.kind === "correct" && v.to).toBe(IN_REVIEW);
  });

  test("BS-13: an open DRAFT pull request marked Done is undecidable, never moved to In review", () => {
    // The other half of BS-5, and the one that contradicts this PR's own
    // other half if it is missed. `board-intake.yml` excludes drafts from
    // In review deliberately — "a draft in In review says somebody is
    // waiting on a reader when nobody is" — so a sweep that writes In review
    // for a draft is a SECOND DECIDER disagreeing with the first
    // (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape),
    // and the two never meet because intake fires on an event and the sweep
    // runs by hand.
    //
    // Undecidable rather than Backlog for the same reason BS-7 is: Done is
    // certainly wrong and the right column is not derivable. Backlog, Ready
    // and In progress are all consistent with an open draft.
    const v = verdictFor(item(1700, "PullRequest", "OPEN", DONE, true));
    expect(v.kind).toBe("undecidable");
    expect(v.kind === "undecidable" && v.why).toContain("draft");
  });

  test("BS-14: the board query asks for isDraft, so the verdict is not taken blind", () => {
    // BS-13 can be satisfied by a `verdictFor` that reads a field nothing
    // ever populates: every real item would arrive with `draft` undefined,
    // the draft branch would never run, and BS-13 would stay green against a
    // sweep that still moves drafts
    // (`.claude/rules/checks-must-be-able-to-fail.md`, the third shape —
    // a case that holds vacuously because the input is stripped upstream).
    expect(BOARD_QUERY).toContain("isDraft");
    // And on the PullRequest fragment specifically. `isDraft` does not exist
    // on Issue, so a stray one elsewhere in the document is a GraphQL error
    // at run time rather than a field.
    expect(/\.\.\. on PullRequest \{[^}]*isDraft/.test(BOARD_QUERY)).toBe(true);
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

  test("BS-9: a non-JSON error body reports the HTTP status, not a parse error", () => {
    // 502s, HTML rate-limit pages and proxy errors all arrive as non-JSON.
    // Parsing before checking the status turned the one failure this function
    // exists to make legible into `SyntaxError: Unexpected token <`.
    expect(() => interpretResponse(502, false, "<html><body>Bad Gateway</body></html>")).toThrow(
      /HTTP 502/,
    );
    // And it carries what the server actually said, so the next reader does
    // not have to reproduce the outage to find out.
    expect(() => interpretResponse(502, false, "<html>Bad Gateway</html>")).toThrow(/Bad Gateway/);
  });

  test("BS-10: an empty body is named as empty rather than silently truncated", () => {
    expect(() => interpretResponse(503, false, "")).toThrow(/empty body/);
  });

  test("BS-11: a GraphQL error at HTTP 200 is still an error", () => {
    // The reason the status alone was never sufficient. This must survive the
    // reordering above — it is the property the original comment defended.
    expect(() =>
      interpretResponse(200, true, JSON.stringify({ errors: [{ message: "NOT_FOUND" }] })),
    ).toThrow(/GraphQL.*NOT_FOUND/);
  });

  test("BS-12: a good response returns its data", () => {
    // Anti-vacuity for the three rows above: if interpretResponse threw
    // unconditionally they would all pass.
    expect(interpretResponse(200, true, JSON.stringify({ data: { node: { id: "x" } } }))).toEqual({
      node: { id: "x" },
    });
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
      item(1700, "PullRequest", "OPEN", DONE, true), // undecidable — draft
      item(1740, "PullRequest", "OPEN", "Backlog"), // agrees
    ];
    const r = sweep(items);

    expect(r.agrees).toBe(2);
    expect(r.corrections.map(c => c.number).sort()).toEqual([1607, 1749]);
    expect(r.undecidable.map(u => u.number).sort()).toEqual([1700, 1744]);
    expect(r.agrees + r.corrections.length + r.undecidable.length).toBe(items.length);
  });
});
