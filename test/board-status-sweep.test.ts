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
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { readBoardProjectId } from "../lib/config-readers";
import { tmpdir } from "os";
import { join } from "path";
import {
  BACKLOG,
  BOARD_QUERY,
  CLAIM_ACTIVITY_QUERY,
  DONE,
  IN_PROGRESS,
  IN_REVIEW,
  ISSUE_TOKEN_ENV,
  OPEN_PR_CLOSING_REFS_QUERY,
  STALE_CLAIM_DAYS,
  applyClaimSilence,
  applyLinkedPullRequests,
  claimSilence,
  countOpenPRsByIssue,
  idleDaysSince,
  isStaleClaimCandidate,
  needsClaimActivityReading,
  needsOpenPullRequestReading,
  parseClaimActivity,
  applyCorrections,
  clearAssignees,
  requireWrittenItem,
  interpretResponse,
  interpretTransport,
  parseBoardItem,
  requireConnection,
  requireCursorAdvanced,
  requireNode,
  resolveIssueWriteToken,
  sweep,
  withRetry,
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
  // **Defaulted to null, not to COMPLETED.** A default of COMPLETED would
  // make every existing row keep passing while hiding the one case this
  // change is about, which is a fixture choosing the answer.
  stateReason: string | null = null,
  // **Defaulted to `false`, and the default is a claim about the fixture,
  // not a convenience.** `false` means "nobody is assigned", which is what
  // every case written before 2026-11-06 meant by saying nothing. `null`
  // would mean "not read" and would make those cases undecidable for a
  // reason none of them is about. BS-51 writes `null` explicitly and BS-53
  // proves the parser can produce all three.
  assigned: boolean | null = false,
  // **Defaulted to 0 — "active today" — and that is also a claim.** Every
  // case written before the staleness rule meant a live claim when it said
  // nothing, and 0 is the reading that preserves their meaning. `null`
  // would make them all undecidable for a reason none of them is about.
  // BS-55 onward set this explicitly.
  idleDays: number | null = 0,
  // Defaulted to `null` — NOT READ — because that is what `parseBoardItem`
  // really produces for every row. Only a stale-claim candidate ever gets
  // it filled, so a fixture defaulting it to 0 would describe a board state
  // the sweep cannot reach.
  openLinkedPRs: number | null = null,
): BoardItem {
  return {
    itemId: `PVTI_${number}`,
    number,
    kind,
    state,
    status,
    draft,
    statusUnread: false,
    stateReason,
    assigned,
    idleDays,
    openLinkedPRs,
  };
}

describe("board status sweep", () => {
  test("BS-1: a merged pull request not marked Done is corrected to Done", () => {
    const v = verdictFor(item(1749, "PullRequest", "MERGED", "In review"));
    expect(v.kind).toBe("correct");
    expect(v.kind === "correct" && v.to).toBe(DONE);
  });

  test("BS-2: a closed issue not marked Done is corrected to Done", () => {
    const v = verdictFor(item(1727, "Issue", "CLOSED", "In progress", false, "COMPLETED"));
    expect(v.kind).toBe("correct");
    expect(v.kind === "correct" && v.to).toBe(DONE);
  });

  // ## Closed is not one outcome, and this script treated it as one
  //
  // Measured 2026-11-05: 23 issues are closed as `not_planned` or
  // `duplicate`, the board's Cancelled lane holds 0, and THIS SCRIPT is the
  // only path that can correct a card whose event has already fired. Its
  // closed branch read `state` and never `state_reason`, so a `--write` run
  // would have filed all 23 abandonments as deliveries.
  //
  // That is not cosmetic. `specs/BOARD-FLOW-SPEC.md` puts the forecast on
  // the distinction: Done defines throughput and Cancelled protects Little's
  // Law's second assumption. Folding 23 abandonments into throughput inflates
  // it and contaminates every cycle-time percentile.
  //
  // The decision is NOT re-derived here. It is `laneFor` in
  // `lib/board-flow.ts`, the same function `board-flow.yml` uses on the live
  // event, so there is one decider for "which lane does a close mean" and
  // the sweep cannot drift away from the writer.
  test("BS-45: an issue closed as not_planned is corrected to Cancelled, not Done", () => {
    const v = verdictFor(item(1700, "Issue", "CLOSED", "In progress", false, "NOT_PLANNED"));
    expect(v.kind).toBe("correct");
    expect(
      v.kind === "correct" && v.to,
      "the only path that can fix an already-closed card would otherwise file every " +
        "abandonment as a delivery — 23 of them, measured on this board.",
    ).toBe("Cancelled");
  });

  test("BS-46: and duplicate is the other half of that condition", () => {
    const v = verdictFor(item(1701, "Issue", "CLOSED", null, false, "DUPLICATE"));
    expect(
      v.kind === "correct" && v.to,
      "BOARD-FLOW-SPEC.md defines Cancelled as `not_planned` OR `duplicate`. Half the " +
        "condition reads a cancellation as a delivery, which is the defect with one fewer " +
        "instance.",
    ).toBe("Cancelled");
  });

  test("BS-47: an issue already in Cancelled agrees, rather than being dragged to Done", () => {
    const v = verdictFor(item(1702, "Issue", "CLOSED", "Cancelled", false, "NOT_PLANNED"));
    expect(
      v.kind,
      "a sweep that corrects a correct card is a sweep that fights the writer every run.",
    ).toBe("agrees");
  });

  test("BS-48: a close reason this script cannot read is REPORTED, never corrected to Done", () => {
    for (const reason of [null, "", "ARCHIVED"]) {
      const v = verdictFor(item(1703, "Issue", "CLOSED", "In progress", false, reason));
      expect(
        v.kind,
        `state_reason ${JSON.stringify(reason)} is not one the decider knows. Correcting it ` +
          `to Done counts an unknown outcome as delivered, which is the one direction this ` +
          `must never be wrong in — and a sweep writes in bulk.`,
      ).toBe("undecidable");
    }
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

  test("BS-6: an open UNASSIGNED item in a column that claims nothing is left alone", () => {
    // The sweep is not a second opinion on where open work sits. Moving a
    // card out of a lane that is legitimate for it would make this a
    // competing decider against board-intake.yml.
    //
    // **`assigned` defaults to `false` in the helper, and that is this case's
    // whole subject rather than an incidental.** Jason's call of 2026-11-06
    // made an ASSIGNED open issue decidable — BS-47 below — so without the
    // word UNASSIGNED in this title the two cases contradict each other and
    // whichever ran second would look like the bug.
    //
    // **NARROWED BY #1977, AND THE TITLE CHANGED WITH IT.** This case used to
    // run In progress and In review through the issue arm too, and that was
    // the defect written down as a property: those two lanes ASSERT somebody
    // is working, so an unassigned card in them is not a legitimate placement
    // the sweep should decline to judge — it is a claim with nothing behind
    // it. Five such cards sat on the live board while this case was green.
    // BS-75..BS-80 hold that population now. What remains here is the half
    // that is still true, which is why the lanes are listed rather than the
    // loop simply being deleted.
    for (const status of ["Backlog", "Ready", null]) {
      expect(verdictFor(item(1741, "Issue", "OPEN", status)).kind).toBe("agrees");
    }
    // A pull request's OWN card is untouched in every lane: no lane table in
    // BOARD-FLOW-SPEC.md covers one, and #1977's branch is issues only.
    for (const status of ["Backlog", "Ready", "In progress", IN_REVIEW, null]) {
      expect(verdictFor(item(1740, "PullRequest", "OPEN", status)).kind).toBe("agrees");
    }
  });

  test("BS-7: an open ISSUE marked Done is undecidable, never corrected", () => {
    const v = verdictFor(item(1744, "Issue", "OPEN", DONE));
    expect(v.kind).toBe("undecidable");
    // The reason has to name why a guess is refused, or the next reader
    // deletes the branch as an oversight and writes Backlog.
    expect(v.kind === "undecidable" && v.why).toContain("not derivable");
  });

  // ── BS-47..BS-51: assignment makes an open issue's lane derivable ────────
  //
  // Jason, 2026-11-06: *"if they're assigned, that means someone's working on
  // them, right? Because they're assigned to somebody… But the backlog is for
  // unassigned work."*
  //
  // That decision is what these cases rest on, and it is the reason the
  // docblock's old defence of UNDECIDABLE no longer covers every open issue.
  // The defence was *"Backlog, Ready and In progress are all consistent with
  // an open issue"* — true of an UNASSIGNED one, and false the moment
  // somebody is on it, because `specs/BOARD-FLOW-SPEC.md` gives In progress
  // the entry condition `issues: [assigned]` and gives Ready the entry
  // condition "nobody assigned".
  //
  // **Why the sweep and not the workflow.** `board-flow.yml` already writes
  // In progress on the `assigned` EVENT and it works — run `42150403168` row
  // 3 PASS. It cannot help the nine issues assigned before it existed,
  // because no event will ever fire for them again and GitHub has no "replay
  // a past event" trigger. Measured 2026-11-06: In progress held 1 against 9
  // open and assigned.

  test("BS-47: an open ASSIGNED issue in Backlog is corrected to In progress", () => {
    const v = verdictFor(item(1455, "Issue", "OPEN", "Backlog", false, null, true));
    expect(v.kind).toBe("correct");
    expect(v.kind === "correct" && v.to).toBe(IN_PROGRESS);
  });

  test("BS-48: an open ASSIGNED issue in Ready is corrected to In progress", () => {
    // Ready's entry condition is "nobody assigned", so an assigned issue
    // sitting there is not merely mis-filed — it is consuming a slot in the
    // WIP-capped lane. On 2026-11-06 Ready read 5 of its cap of 4 with two
    // such issues in it, and `board-ready.yml` correctly refused to promote
    // anything into a full lane. The over-cap reading and the stranded
    // assignments are the same defect seen from two ends.
    const v = verdictFor(item(1600, "Issue", "OPEN", "Ready", false, null, true));
    expect(v.kind).toBe("correct");
    expect(v.kind === "correct" && v.to).toBe(IN_PROGRESS);
  });

  test("BS-49: an assigned open issue already past Backlog/Ready is left alone", () => {
    // In progress is where it belongs; In review means a pull request is out
    // and the issue is still legitimately assigned. Writing In progress over
    // In review would drag finished work backwards, and this sweep runs in
    // bulk — so the lane set it may pull FROM is closed, not open-ended.
    for (const status of ["In progress", IN_REVIEW]) {
      expect(verdictFor(item(1601, "Issue", "OPEN", status, false, null, true)).kind).toBe(
        "agrees",
      );
    }
  });

  test("BS-50: an open assigned issue marked Done stays UNDECIDABLE", () => {
    // BS-7's refusal is NOT relaxed by the assignment rule, and this case
    // exists so nobody relaxes it by analogy. An open issue in Done is a
    // different corruption from an open issue in Backlog: something wrote a
    // terminal lane for work that has not ended, and In progress is a
    // plausible-looking cover for it. Replacing a visibly wrong board with a
    // plausibly wrong one is the fifth shape in
    // `.claude/rules/checks-must-be-able-to-fail.md`.
    const v = verdictFor(item(1744, "Issue", "OPEN", DONE, false, null, true));
    expect(v.kind).toBe("undecidable");
  });

  test("BS-51: an assignment that was NOT READ is undecidable, never corrected", () => {
    // `null` is "the query did not carry assignees", which is a different
    // fact from "nobody is assigned" and must not share its observable.
    // Silent Default Substitution — `.claude/rules/config-access.md`. A
    // query that loses the field would otherwise make every stranded issue
    // read as correctly unassigned, and the sweep would report a clean board
    // having checked nothing.
    const v = verdictFor(item(1455, "Issue", "OPEN", "Backlog", false, null, null));
    expect(v.kind).toBe("undecidable");
    expect(v.kind === "undecidable" && v.why).toContain("NOT READ");
  });

  test("BS-52: a PULL REQUEST's own card is never moved by the assignment rule", () => {
    // The lane table in `specs/BOARD-FLOW-SPEC.md` governs ISSUES. A pull
    // request is assignable too, and no row of that table says where its own
    // card goes — the existing CLOSED branch already declines to invent one.
    // Deciding it here would be this script writing spec.
    for (const status of ["Backlog", "Ready"]) {
      expect(verdictFor(item(1740, "PullRequest", "OPEN", status, false, null, true)).kind).toBe(
        "agrees",
      );
    }
  });

  // ── BS-55..BS-60: a stale claim is released, not promoted ────────────────
  //
  // Jason, 2026-11-06, on seeing that the first cut of this branch sent all
  // eight strays to In progress: that makes the lane read 9 when one is
  // real, which is a different wrong number rather than a right one. His
  // two decisions, asked as two questions:
  //
  //   1. A stale claim is UNASSIGNED and STAYS IN BACKLOG. Not Ready.
  //   2. Stale means no activity for `STALE_CLAIM_DAYS` AND no open pull
  //      request. Both.
  //
  // The conjunction is the part to defend. Each half alone is wrong in a
  // DIFFERENT direction — an issue somebody picked up this morning has no
  // pull request yet, and an issue whose pull request is in review is
  // legitimately quiet because a push to a branch does not touch the
  // issue's `updatedAt`. BS-56 and BS-57 are those two halves, and neither
  // can pass if the other condition is the one being read.

  test("BS-55: a stale claim with no open PR is RELEASED, and stays in Backlog", () => {
    const v = verdictFor(item(312, "Issue", "OPEN", "Backlog", false, null, true, 16, 0));
    expect(v.kind).toBe("release");
    // `null` and not "Backlog": the card is already there, so the only act
    // is removing the assignment. A redundant field write is a second
    // mutation that can fail on its own and report the release as failed.
    expect(v.kind === "release" && v.to).toBeNull();
  });

  test("BS-56: a stale claim in READY is released AND sent back to Backlog", () => {
    // Ready's entry condition is "nobody assigned", so leaving an
    // unassigned-but-stale card there would assert somebody re-checked it
    // as pickable. Nobody did. That is the spec's backwards rule applied to
    // an abandoned claim.
    const v = verdictFor(item(1600, "Issue", "OPEN", "Ready", false, null, true, 8, 0));
    expect(v.kind).toBe("release");
    expect(v.kind === "release" && v.to).toBe(BACKLOG);
  });

  test("BS-57: silence alone does NOT release — an open PR keeps the claim", () => {
    // The half that would be lost first if somebody "simplified" the
    // conjunction. A push to a pull request branch does not move the
    // issue's `updatedAt`, so an issue in review looks exactly as quiet as
    // an abandoned one on that field alone.
    const v = verdictFor(item(1168, "Issue", "OPEN", "Backlog", false, null, true, 90, 1));
    expect(v.kind).toBe("correct");
    expect(v.kind === "correct" && v.to).toBe(IN_PROGRESS);
  });

  /**
   * #1941. The sweep does not decide "is somebody working on this" itself —
   * it reads `workVerdict` in `lib/board-lane-health.ts`, the same function
   * `lib/board-ready-fanout.ts` reads. These two cases are what makes that
   * claim measurable from here: without them the sweep imports the decider
   * and no mutation of it can redden this file, which is an import rather
   * than a dependency.
   *
   * The release CONDITION is deliberately not routed through the verdict —
   * see the comment at the call site. What is routed through it is what the
   * row says about itself.
   */
  test("#1941: a release says its work reading was UNMEASURED, and why", () => {
    const v = verdictFor(item(312, "Issue", "OPEN", "Backlog", false, null, true, 16, 0));
    expect(v.kind).toBe("release");
    const why = v.kind === "release" ? v.why : "";
    // A job in GitHub Actions cannot see an unpushed branch or a commit on
    // somebody's laptop. It released on silence and no open PR, which is
    // the call Jason made, and it now admits what it could not look at.
    expect(
      why,
      "the release does not name its work reading, so nothing here observes the decider",
    ).toContain("Work reading: UNMEASURED");
    expect(why).toContain("a pushed branch and local commits were not read");
    // And it must NOT claim PARKED. PARKED is the verdict that would assert
    // nobody is working on it, and this caller cannot reach that reading.
    expect(why, "a caller that cannot read two of three fields must not assert PARKED").not.toContain(
      "an assignee and nothing else",
    );
  });

  test("#1941: a claim with an open PR reads WORKING, from the same decider", () => {
    const v = verdictFor(item(1168, "Issue", "OPEN", "Backlog", false, null, true, 90, 1));
    expect(v.kind).toBe("correct");
    expect(
      v.kind === "correct" ? v.why : "",
      "the kept claim does not carry the decider's WORKING sentence",
    ).toContain("an open pull request declares it closes this");
  });

  test("BS-58: no open PR alone does NOT release — a fresh claim is kept", () => {
    // The other half. Somebody who claimed an issue this morning has no
    // pull request yet, and releasing them would make the claim registry
    // useless exactly when it is doing its job.
    const v = verdictFor(
      item(1455, "Issue", "OPEN", "Backlog", false, null, true, STALE_CLAIM_DAYS - 1, 0),
    );
    expect(v.kind).toBe("correct");
    expect(v.kind === "correct" && v.to).toBe(IN_PROGRESS);
    // And the boundary is inclusive, asserted rather than assumed — an
    // off-by-one here is a day of somebody's claim.
    const atThreshold = verdictFor(
      item(1455, "Issue", "OPEN", "Backlog", false, null, true, STALE_CLAIM_DAYS, 0),
    );
    expect(atThreshold.kind).toBe("release");
  });

  test("BS-59: an UNREAD pull-request list never releases a claim", () => {
    // The dangerous direction, and the only one that costs somebody else
    // something. A fetch that failed leaves `openLinkedPRs` null, and a
    // `?? 0` anywhere in that path would turn every failed fetch into an
    // unassignment. Silent Default Substitution where it does most harm.
    const v = verdictFor(item(312, "Issue", "OPEN", "Backlog", false, null, true, 30, null));
    expect(v.kind).toBe("undecidable");
    expect(v.kind === "undecidable" && v.why).toContain("NOT READ");
  });

  test("BS-60: unread ACTIVITY is undecidable too, in either direction", () => {
    // `idleDays` null means the timestamp was absent or unparseable. In
    // progress would assert somebody is working and a release would assert
    // nobody is; neither is derivable, so the row is reported and left.
    const v = verdictFor(item(312, "Issue", "OPEN", "Backlog", false, null, true, null, 0));
    expect(v.kind).toBe("undecidable");
  });

  test("BS-61: the candidate test is wider than the release, and that is deliberate", () => {
    // `isStaleClaimCandidate` decides whether to SPEND A QUERY;
    // `verdictFor` decides what to WRITE. Naming the input they must
    // disagree on is what separates two questions from two deciders —
    // `.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape.
    // Here it is the unfetched candidate: a candidate by one, undecidable
    // by the other, and if they ever agree on this row the fetch failure
    // becomes an unassignment.
    const unfetched = item(312, "Issue", "OPEN", "Backlog", false, null, true, 30, null);
    expect(isStaleClaimCandidate(unfetched)).toBe(true);
    expect(verdictFor(unfetched).kind).toBe("undecidable");
    // And it never spends a query on a row no release could apply to.
    expect(isStaleClaimCandidate(item(1, "Issue", "OPEN", "In progress", false, null, true, 30))).toBe(false);
    expect(isStaleClaimCandidate(item(2, "PullRequest", "OPEN", "Backlog", false, null, true, 30))).toBe(false);
    expect(isStaleClaimCandidate(item(3, "Issue", "OPEN", "Backlog", false, null, false, 30))).toBe(false);
    expect(isStaleClaimCandidate(item(4, "Issue", "OPEN", "Backlog", false, null, null, 30))).toBe(false);
  });

  test("BS-62: idleDaysSince separates unread from active-today", () => {
    const now = Date.parse("2026-11-06T12:00:00Z");
    expect(idleDaysSince("2026-10-21T12:00:00Z", now)).toBe(16);
    expect(idleDaysSince("2026-11-06T11:00:00Z", now)).toBe(0);
    // NOT zero. A row whose timestamp could not be read is not a row that
    // was touched today, and `verdictFor` must be able to tell them apart.
    expect(idleDaysSince(undefined, now)).toBeNull();
    expect(idleDaysSince(null, now)).toBeNull();
    expect(idleDaysSince("not a date", now)).toBeNull();
    // Clock skew clamps rather than going negative.
    expect(idleDaysSince("2026-11-07T12:00:00Z", now)).toBe(0);
  });

  test("BS-63: the reading partitions releases apart from corrections", () => {
    // A release writes the ISSUE's assignees; a correction writes a PROJECT
    // field. Different APIs, so a merged bucket could report a successful
    // field write as a successful unassignment. The partition must stay
    // exact and every item must land in exactly one bucket.
    const items = [
      item(1, "Issue", "OPEN", "Backlog", false, null, true, 0), //      correct
      item(2, "Issue", "OPEN", "Backlog", false, null, true, 30, 0), //  release
      item(3, "Issue", "OPEN", "Backlog", false, null, true, 30, null), // undecidable
      item(4, "Issue", "OPEN", "Backlog", false, null, false), //        agrees
    ];
    const r = sweep(items);
    expect(r.corrections.map(c => c.number)).toEqual([1]);
    expect(r.releases.map(c => c.number)).toEqual([2]);
    expect(r.undecidable.map(c => c.number)).toEqual([3]);
    expect(r.agrees).toBe(1);
    expect(r.agrees + r.corrections.length + r.releases.length + r.undecidable.length).toBe(
      items.length,
    );
  });

  // ── BS-64..BS-67: a MENTION is not a claim ──────────────────────────────
  //
  // The defect these exist for shipped and was caught by its own output.
  // The first cut read `CROSS_REFERENCED_EVENT` — any mention of the issue
  // number — and against the live board on 2026-11-06 it reported that all
  // 7 stale claims had "1 open pull request". Every one was PR #1823, this
  // change's own, whose body lists the seven numbers as evidence. The
  // release branch was live, correct, and unreachable.
  //
  // Nothing above could have caught it: BS-55..BS-63 all set
  // `openLinkedPRs` as a literal, so every one is green against any
  // relation at all, including one that always answers 1. The relation is
  // chosen by the QUERY, so the query is where it has to be asserted.

  test("BS-64: the pull-request read asks what CLOSES an issue, not what mentions it", () => {
    // `closingIssuesReferences` is GitHub's own parse of a closing keyword,
    // the link `.claude/rules/ship-workflow.md` step 6 requires and the
    // field `lib/closing-reference-audit.ts` already treats as the
    // authority. One answer, one owner.
    expect(OPEN_PR_CLOSING_REFS_QUERY).toContain("closingIssuesReferences");
    // The wide relation, named so it cannot come back by a refactor that
    // looks like a tidy-up.
    expect(OPEN_PR_CLOSING_REFS_QUERY).not.toContain("CROSS_REFERENCED_EVENT");
    expect(OPEN_PR_CLOSING_REFS_QUERY).not.toContain("timelineItems");
    // OPEN only — a merged or closed pull request is not live work, and
    // every stray on the board would have one.
    expect(OPEN_PR_CLOSING_REFS_QUERY).toContain("states: OPEN");
    // Both connections page, and both are read for truncation.
    expect(OPEN_PR_CLOSING_REFS_QUERY.match(/hasNextPage/g)?.length).toBe(2);
  });

  test("BS-65: counting is per-issue and de-duplicates a pull request seen twice", () => {
    const counts = countOpenPRsByIssue([
      { number: 900, closingIssuesReferences: { nodes: [{ number: 312 }, { number: 523 }] } },
      { number: 901, closingIssuesReferences: { nodes: [{ number: 312 }] } },
      // The same pull request arriving twice across a page boundary is one
      // pull request. A running total would say 312 has three.
      { number: 900, closingIssuesReferences: { nodes: [{ number: 312 }] } },
      // Closes nothing: the ordinary case, not an error.
      { number: 902, closingIssuesReferences: { nodes: [] } },
      // Shapes GraphQL really returns when a nested field is nulled.
      { number: 903 },
      { number: 903, closingIssuesReferences: { nodes: null } },
      { closingIssuesReferences: { nodes: [{ number: 312 }] } },
    ]);
    expect(counts.get(312)).toBe(2);
    expect(counts.get(523)).toBe(1);
    expect(counts.has(902)).toBe(false);
  });

  test("BS-66: only candidates are filled, and an absent key is zero for them alone", () => {
    const candidate = item(312, "Issue", "OPEN", "Backlog", false, null, true, 30, null);
    const withPR = item(523, "Issue", "OPEN", "Ready", false, null, true, 30, null);
    // Not a candidate: fresh. It must stay `null`, because `null` is what
    // every verdict outside the release branch expects to see.
    const fresh = item(713, "Issue", "OPEN", "Backlog", false, null, true, 0, null);
    const out = applyLinkedPullRequests(
      [candidate, withPR, fresh],
      new Map([[523, 1]]),
    );
    // Absent from a COMPLETE read of every open pull request is an answer,
    // and this is the only place in the file where a missing key is zero.
    expect(out[0].openLinkedPRs).toBe(0);
    expect(out[1].openLinkedPRs).toBe(1);
    expect(out[2].openLinkedPRs).toBeNull();
    // And the verdicts that follow from it, so the mapping is not just a
    // field assignment nobody reads.
    expect(verdictFor(out[0]).kind).toBe("release");
    expect(verdictFor(out[1]).kind).toBe("correct");
  });

  test("BS-67: the seven live rows of 2026-11-06, under both relations", () => {
    // The regression, stated as the input that walked around the first
    // cut. Each of the seven was assigned, silent 8-16 days, and mentioned
    // by exactly one open pull request — #1823 — which declares it closes
    // #1758 and nothing else. Under the mention relation every row scored
    // 1 and nothing was released; under the closing relation every row
    // scores 0 and every one is a release.
    const strays = [312, 523, 713, 1168, 1455].map(n =>
      item(n, "Issue", "OPEN", "Backlog", false, null, true, 15, null),
    );
    const counts = countOpenPRsByIssue([
      { number: 1823, closingIssuesReferences: { nodes: [{ number: 1758 }] } },
    ]);
    const out = applyLinkedPullRequests(strays, counts);
    expect(out.map(i => verdictFor(i).kind)).toEqual(Array(5).fill("release"));
    // The control: had #1823 actually declared it closes #312, that one row
    // is live work and must NOT be released. Without this the case above is
    // green against a function that returns an empty map for anything.
    const declared = countOpenPRsByIssue([
      { number: 1823, closingIssuesReferences: { nodes: [{ number: 312 }] } },
    ]);
    const guarded = applyLinkedPullRequests(strays, declared);
    expect(guarded.map(i => verdictFor(i).kind)).toEqual([
      "correct",
      "release",
      "release",
      "release",
      "release",
    ]);
  });

  // ── BS-68, BS-69: the sweep's own write is an input to the sweep ────────
  //
  // `board-sweep.yml` triggers on `issues: [assigned, unassigned, ...]` and
  // a RELEASE PATCHes the issue's assignees. WHETHER THAT STARTS ANOTHER RUN
  // HAS NOW CHANGED TWICE: a PAT-authored write did fire the event (round 3
  // of #1823's review found the comment claiming otherwise), and the issue
  // write is now signed by the job's GITHUB_TOKEN, which GitHub does not
  // trigger workflows from.
  //
  // So "does it retrigger" is the wrong thing to bind — it is a fact about
  // which credential happens to sign a write, and it has been restated
  // wrongly in a YAML comment twice. TERMINATION is the property that
  // survived both changes, it is a property of the DECIDER, and it is what
  // is asserted here.

  test("BS-68: a released claim is a fixpoint, whenever the next run happens", () => {
    const stale = item(312, "Issue", "OPEN", "Ready", false, null, true, 30, 0);
    expect(verdictFor(stale).kind).toBe("release");

    // The state the release leaves behind: unassigned, and in Backlog.
    const afterRelease = { ...stale, assigned: false, status: BACKLOG };
    expect(
      verdictFor(afterRelease).kind,
      "the next run must find nothing to do — a second write on the same " +
        "row means the sweep does not converge, whether the run that makes " +
        "it was triggered by this release or by an unrelated event",
    ).toBe("agrees");
    // Through the reading as well as the verdict, because `main()` decides
    // whether to write from the buckets, not from one verdict.
    const r = sweep([afterRelease]);
    expect(r.releases).toEqual([]);
    expect(r.corrections).toEqual([]);
    expect(r.agrees).toBe(1);
  });

  test("BS-69: the half-failed release is a state the sweep still repairs", () => {
    // WHY THE WRITE ORDER IS MOVE-THEN-UNASSIGN. Either write can fail on
    // its own, and the two half-states are not equally recoverable.
    //
    // Unassign-first leaves this, and it is permanent: unassigned in Ready
    // is Ready's own entry condition, so no later run looks at it again.
    const unassignedInReady = item(312, "Issue", "OPEN", "Ready", false, null, false, 30, 0);
    expect(
      verdictFor(unassignedInReady).kind,
      "if this ever stops being `agrees`, the ordering argument below has " +
        "changed and this test is the place to re-decide it",
    ).toBe("agrees");

    // Move-first leaves this, and the sweep owns it: assigned in Backlog is
    // precisely the row it exists to find, so the next run finishes the
    // release. (It used to be the run this release itself triggered. The
    // issue write is now signed by GITHUB_TOKEN, which triggers nothing, so
    // the repair waits for the next real event instead — later, same
    // outcome. See BS-70.)
    const assignedInBacklog = item(312, "Issue", "OPEN", BACKLOG, false, null, true, 30, 0);
    expect(verdictFor(assignedInBacklog).kind).toBe("release");

    // And the source must actually write in that order. A comment arguing
    // for it is the docblock-saying-it-was-checked failure.
    //
    // Matched on the CALL, not on the argument it is passed: the first
    // spelling here was `clearAssignees(token`, and this assertion went red
    // the moment the issue write took its own credential — correctly, but
    // for a reason that has nothing to do with ordering.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    const releaseBody = code.slice(code.indexOf("reading.releases.map"));
    const move = releaseBody.indexOf("option: optionId(back)");
    const unassign = releaseBody.indexOf("clearAssignees(");
    expect(move, "the release pass must still move the card").toBeGreaterThan(-1);
    expect(unassign, "the release pass must still clear the assignees").toBeGreaterThan(-1);
    expect(
      move < unassign,
      "the card must move BEFORE the claim is released — unassign-first " +
        "leaves an unassigned card in Ready, which `verdictFor` reads as " +
        "`agrees` and no later run repairs",
    ).toBe(true);
  });

  // ── BS-70, BS-71: two credentials, two permissions ──────────────────────
  //
  // The board write needs ProjectsV2, which GITHUB_TOKEN cannot do at any
  // permission level. The issue write needs `issues: write`, which the board
  // PAT does not have. One token cannot sign both, and run 42248314060 is
  // the measurement: 177 items read, 6 stale claims found, 6 of 6 refused
  // with HTTP 403 "Must have admin rights to Repository".

  test("BS-70: the issue credential is separate, and the fallback is not silent", () => {
    const BOARD = "board-pat";

    // Configured: the issue token signs the issue write.
    expect(resolveIssueWriteToken({ [ISSUE_TOKEN_ENV]: "issue-tok" }, BOARD)).toEqual({
      token: "issue-tok",
      source: "issue-token",
    });

    // THREE SPELLINGS OF ABSENT, and all three must fall back rather than
    // sign a request with nothing. `secrets.X` for a secret that does not
    // exist is the EMPTY STRING with no error — that is how the Ready lane
    // spent a day authorising itself with nothing (#1761).
    for (const absent of [{}, { [ISSUE_TOKEN_ENV]: "" }, { [ISSUE_TOKEN_ENV]: "   " }]) {
      expect(resolveIssueWriteToken(absent, BOARD)).toEqual({
        token: BOARD,
        source: "board-token",
      });
    }

    // Trimmed, like `resolveGitHubToken`: a token read from a file carries a
    // newline, and it 401s in the Authorization header with nothing pointing
    // at the whitespace.
    expect(resolveIssueWriteToken({ [ISSUE_TOKEN_ENV]: " t\n" }, BOARD).token).toBe("t");

    // THE SOURCE IS THE POINT. A plain `??` would return the right token and
    // leave the run unable to say which one it used, and a fallback nobody
    // can see is identical to a correct configuration until the 403 lands.
    // So the two cases must be distinguishable, not merely both non-empty.
    expect(
      resolveIssueWriteToken({ [ISSUE_TOKEN_ENV]: BOARD }, BOARD).source,
      "even when the two credentials are the same string, the source must " +
        "say which one was configured",
    ).toBe("issue-token");
  });

  test("BS-71: the workflow grants issues:write and passes the Actions token", () => {
    // BS-70 proves the script reads a second credential. It cannot prove
    // anything SETS it — a resolver whose variable nobody populates falls
    // back on every run and the 403 is unchanged. This is the other half.
    const wf = readFileSync(
      join(import.meta.dir, "..", ".github", "workflows", "board-sweep.yml"),
      "utf8",
    );
    expect(wf, "the env var the resolver reads must be the one the job sets").toContain(
      `${ISSUE_TOKEN_ENV}: \${{ secrets.GITHUB_TOKEN }}`,
    );
    expect(
      wf,
      "GITHUB_TOKEN can only unassign if the job asks for the permission — " +
        "without this line the fallback is invisible and the write still 403s",
    ).toMatch(/^ {2}issues: write$/m);
    // The board write keeps the PAT. GITHUB_TOKEN cannot write ProjectsV2 at
    // any permission level, so a tidy-up that unified the two credentials
    // would trade one 403 for another.
    expect(wf).toContain("GITHUB_TOKEN: ${{ secrets.RUNGATE_PROJECT_TOKEN }}");
  });

  test("BS-72: the issue write is signed by the issue credential, not the board one", () => {
    // FOUND BY THE BATTERY, NOT BY DESIGN. With BS-70 and BS-71 both green,
    // reverting the one call site to `clearAssignees(token, ...)` — the
    // exact line that produced run 42248314060's six 403s — left 73 pass /
    // 0 fail. BS-70 proves the resolver works and BS-71 proves the workflow
    // supplies the variable; neither can see whether the WRITE uses what
    // they resolved. The defect reintroduces itself through a gap between
    // two green checks, which is the fourth shape in
    // `.claude/rules/checks-must-be-able-to-fail.md`.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

    // Exactly one resolution, so there is one thing to mutate and no second
    // site that could quietly disagree about which credential is current.
    expect(
      (code.match(/resolveIssueWriteToken\(/g) ?? []).length,
      "expected the definition plus exactly one call — main()'s",
    ).toBe(2);

    // Every call to the issue write takes the resolved credential. Asserted
    // over ALL call sites rather than the first, so a second release path
    // cannot be added signing with the board token.
    const calls = code.match(/clearAssignees\([^,)]*/g) ?? [];
    expect(calls.length, "the release pass must still clear assignees").toBeGreaterThan(0);
    expect(
      calls.filter(c => !c.includes("issueWrite.token") && !c.includes("token: string")),
      "a board credential cannot write issues — run 42248314060 refused 6 of " +
        "6 with HTTP 403. Pass resolveIssueWriteToken(...).token",
    ).toEqual([]);
  });

  // ── BS-73, BS-74: a REST body is not a GraphQL envelope ──────────────────
  //
  // Found live, watching run 42254789078 drain the board after #1824 gave the
  // unassign a credential that can write issues. All six releases threw *"the
  // unassign response carried no 'assignees' array"* against six responses
  // that carried one.
  //
  // `clearAssignees` is REST and passed its response through
  // `interpretResponse`, which ends `return body.data`. A REST body has no
  // `data` key, so the verified reading was `undefined` and
  // `Array.isArray(undefined)` is false. The sixth shape in
  // `.claude/rules/checks-must-be-able-to-fail.md`: BS-39's verify-the-result
  // guard fired correctly, on an input its own transport layer had emptied.
  //
  // It was invisible for as long as the call could not get past HTTP 403.
  // Two refusals, two causes, one message.

  test("BS-73: clearAssignees reads the assignees GitHub actually returned", async () => {
    const saved = globalThis.fetch;
    const seen: { url: string; method: string }[] = [];
    // The body GitHub really sends back for `PATCH /repos/{repo}/issues/{n}`:
    // the issue, at the top level, with no `data` wrapper anywhere in it.
    globalThis.fetch = (async (url: any, init: any) => {
      seen.push({ url: String(url), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ number: 1600, state: "open", assignees: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      // Resolves. Before the split this threw, because the reading it
      // verified was `undefined` rather than the `[]` above.
      await clearAssignees("tok", "o/r", 1600);
      expect(seen).toEqual([{ url: "https://api.github.com/repos/o/r/issues/1600", method: "PATCH" }]);

      // And the guard BS-39 put here is still live — it must refuse a 200
      // whose body still lists an assignee. If this half stopped failing, the
      // fix above would have been "stop checking", which is the wrong repair
      // for a check that reported UNMEASURED.
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ number: 1600, assignees: [{ login: "someone" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;
      await expect(clearAssignees("tok", "o/r", 1600)).rejects.toThrow(/still has 1 assignee/);
    } finally {
      globalThis.fetch = saved;
    }
  });

  test("BS-74: the GraphQL envelope reader has exactly one call site", () => {
    // BS-73 proves this one REST path is fixed. It cannot see the NEXT REST
    // call somebody adds — `.claude/rules/checks-must-be-able-to-fail.md`,
    // "replace one name, sweep for the others". So the property is asserted
    // over the whole file: `interpretResponse` is GraphQL-only, and the body
    // of a REST response is read through `interpretTransport`.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

    expect(
      (code.match(/interpretResponse\(/g) ?? []).length,
      "expected the definition plus exactly one call — rawGraphql's. A REST " +
        "response read through the envelope loses its whole body to `return " +
        "body.data`: run 42254789078 refused 6 of 6 releases that way. Use " +
        "interpretTransport for REST.",
    ).toBe(2);

    // The one call site is the GraphQL one, named rather than assumed: a
    // count of two is also what a REST caller plus a deleted GraphQL caller
    // would produce.
    const graphqlFn = code.slice(code.indexOf("function rawGraphql("));
    expect(graphqlFn.slice(0, graphqlFn.indexOf("\n}\n"))).toContain("interpretResponse(");
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

  test("BS-20: a literal null body is a legible refusal, not a TypeError", () => {
    // `JSON.parse("null")` succeeds, so the parse guard does not fire, and
    // `body.errors` is then a property read on null. The function written to
    // turn a bad response into a legible error dies with
    // `Cannot read properties of null` — which does not name the status, the
    // body, or this function's purpose.
    expect(() => interpretResponse(200, true, "null")).toThrow(/not a response object/);
    expect(() => interpretResponse(200, true, "null")).toThrow(/HTTP 200/);
  });

  test("BS-21: a bare JSON primitive is refused, not silently returned as undefined", () => {
    // The quieter half of the same class and the reason this is two rows.
    // `JSON.parse("5")` is 5; `(5).errors` is undefined, so NOTHING throws —
    // the function returns `body.data`, which is undefined, and the caller
    // walks into it. A crash is recoverable; a silent undefined is the sweep
    // reporting on a board it never read.
    expect(() => interpretResponse(200, true, "5")).toThrow(/not a response object/);
    expect(() => interpretResponse(200, true, '"a string"')).toThrow(/not a response object/);
    expect(() => interpretResponse(200, true, "[1,2]")).toThrow(/not a response object/);
  });

  test("BS-22: a null node says the token cannot SEE the project, not that the id is wrong", () => {
    // The third site of BS-20's class and the one the report did not name,
    // reached by an input GitHub really returns: `node(id: …)` resolves to
    // null for a project the credential cannot see. The query SUCCEEDS, so
    // there is no GraphQL error and no bad status — and `data.node.items` was
    // a property read on null, exactly as `body.errors` was.
    //
    // The message has to separate the two readings a null node collapses: a
    // wrong id and an invisible project are the same bytes.
    expect(() => requireNode({ node: null }, "project board")).toThrow(/SUCCEEDED/);
    expect(() => requireNode({ node: null }, "project board")).toThrow(/scope/);
    expect(() => requireNode({}, "project board")).toThrow(/node: null/);
    expect(() => requireNode(null, "project board")).toThrow(/no data object/);
  });

  test("BS-23: a real node is returned unchanged", () => {
    // Anti-vacuity for BS-22: all four cases above pass against a function
    // that throws unconditionally, which would take the whole sweep down.
    expect(requireNode({ node: { items: { nodes: [] } } }, "project board")).toEqual({
      items: { nodes: [] },
    });
  });

  test("BS-24: a status that was NOT READ is undecidable, never agreement", () => {
    // The false zero one level down. `items` is paged; the per-item
    // `fieldValues` connection was not, so an item carrying more field values
    // than the page holds loses Status off the end — and a missing Status
    // read as `null`, which every branch below treats as "some non-Done
    // column", i.e. agreement. A genuinely wrong Done column would be
    // counted as agreeing and left uncorrected by --write.
    //
    // "No column" and "column not read" are the same `null` with opposite
    // correct answers, which is why this is a separate field and not a
    // sentinel string.
    const v = verdictFor({ ...item(1700, "PullRequest", "OPEN", null), statusUnread: true });
    expect(v.kind).toBe("undecidable");
    expect(v.kind === "undecidable" && v.why).toContain("NOT READ");

    // It outranks every other branch, including the closed-item correction —
    // a MERGED row whose column was never read must not be written to Done
    // on the strength of a column nobody saw.
    const closed = verdictFor({
      ...item(1701, "PullRequest", "MERGED", null),
      statusUnread: true,
    });
    expect(closed.kind).toBe("undecidable");
  });

  test("BS-25: a transient failure is retried, and a permanent one still refuses", async () => {
    // The two halves of this change make the same call and only the workflow
    // half retried. Same reasoning applies to `fetch`, and harder on the
    // --write path, which issues one mutation per correction.
    let calls = 0;
    const flaky = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("socket hang up");
        return "ok";
      },
      3,
      async () => {},
    );
    expect(flaky).toBe("ok");
    expect(calls).toBe(3);

    // Anti-vacuity: a withRetry that swallowed everything would satisfy the
    // row above. Three real failures must still throw, carrying the last one.
    let tries = 0;
    await expect(
      withRetry(
        async () => {
          tries += 1;
          throw new Error("401 Bad credentials");
        },
        3,
        async () => {},
      ),
    ).rejects.toThrow(/Bad credentials/);
    expect(tries).toBe(3);
  });

  test("BS-26: one failed correction does not abandon the batch", async () => {
    // The loop threw out of main(), so a transient failure on correction 3 of
    // 5 left the board partially corrected with no record of which writes
    // landed. A tool whose job is to make the board legible must not end by
    // being illegible about itself.
    const corrections = [
      { number: 1, to: DONE },
      { number: 2, to: DONE },
      { number: 3, to: DONE },
    ];
    const applied = await applyCorrections(corrections, async c => {
      if (c.number === 2) throw new Error("502 Bad Gateway");
    });

    expect(applied.wrote.map(w => w.number)).toEqual([1, 3]);
    expect(applied.failed.map(f => f.number)).toEqual([2]);
    // The failure has to carry WHY, or the row names a number and nothing else.
    expect(applied.failed[0]?.error).toContain("502");
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

  // BS-27. `errors` PRESENT is not `errors` POPULATED, and the guard tested
  // the wrong one of those. `body.errors !== undefined` fires on
  // `"errors": null` and on `"errors": []`, so a response that succeeded and
  // carried an empty errors key was reported as a GraphQL failure — with
  // `GraphQL: null` or `GraphQL: []` as the whole message, which names no
  // defect and sends the reader looking for a query problem that is not
  // there.
  //
  // A spec-compliant server does not send either on success. This function
  // exists ENTIRELY to be defensive about servers that do not behave, which
  // is why "the spec forbids it" is not a defence here — it is the premise.
  test("BS-27: an absent, null or empty errors key is not a GraphQL error", () => {
    const ok = JSON.stringify({ data: { node: { id: "x" } } });
    expect(interpretResponse(200, true, ok)).toEqual({ node: { id: "x" } });

    for (const spelling of ["null", "[]"]) {
      const body = `{"errors":${spelling},"data":{"node":{"id":"x"}}}`;
      expect(
        () => interpretResponse(200, true, body),
        `"errors": ${spelling} is an empty errors key on a successful response, not a failure`,
      ).not.toThrow();
      expect(interpretResponse(200, true, body)).toEqual({ node: { id: "x" } });
    }

    // The positive half, in the same case: a POPULATED errors array must
    // still throw, and the message must carry the error so it is actionable.
    // Without this the cheapest repair — deleting the check — goes green.
    expect(() =>
      interpretResponse(200, true, '{"errors":[{"message":"Bad credentials"}]}'),
    ).toThrow(/Bad credentials/);

    // And a non-array truthy `errors` is a shape this function does not
    // understand. Refusing is right: silently returning data on an
    // unrecognised envelope is Silent Default Substitution.
    expect(() => interpretResponse(200, true, '{"errors":{"message":"odd"}}')).toThrow(/odd/);
  });

  // ── BS-29..BS-33: the parsing half, against real-shaped payloads ────────
  //
  // Caught in review of #1754, and it was right: every case above builds a
  // `BoardItem` by hand and sets `statusUnread` as a literal. The function
  // that DERIVES it from a GraphQL node had no case at all, so a typo in the
  // `Status` filter, a wrong nesting level or an inverted `hasNextPage`
  // would produce wrong values and leave all 26 rows green — the third shape
  // in `.claude/rules/checks-must-be-able-to-fail.md`, an assertion holding
  // against a value the test itself just set.
  //
  // These five feed `parseBoardItem` the shape the server actually sends.
  const node = (over: Record<string, unknown> = {}, fieldValues?: unknown) => ({
    id: "PVTI_x",
    content: { __typename: "PullRequest", number: 7, state: "OPEN", isDraft: false, ...over },
    fieldValues: fieldValues ?? { pageInfo: { hasNextPage: false }, nodes: [] },
  });
  const values = (names: Record<string, string>, hasNextPage = false) => ({
    pageInfo: { hasNextPage },
    nodes: Object.entries(names).map(([field, name]) => ({ name, field: { name: field } })),
  });

  test("BS-53: parseBoardItem reads assignment from the node, and absence is null", () => {
    // The fixture helper at the top of this file sets `assigned` as a
    // literal, so every case from BS-47 down is green against a parser that
    // never populates it — the third shape, an assertion holding against a
    // value the test itself set. This is the half only a node can catch.
    expect(parseBoardItem(node({ assignees: { totalCount: 1 } }))?.assigned).toBe(true);
    expect(parseBoardItem(node({ assignees: { totalCount: 3 } }))?.assigned).toBe(true);
    expect(parseBoardItem(node({ assignees: { totalCount: 0 } }))?.assigned).toBe(false);
    // The field absent entirely — a query that lost it, or a fragment that
    // never asked for it. NOT false: see BS-51.
    expect(parseBoardItem(node({}))?.assigned).toBeNull();
    // Present but not a number is also unread, not zero. A GraphQL error
    // can null a nested field while the rest of the row arrives intact.
    expect(parseBoardItem(node({ assignees: null }))?.assigned).toBeNull();
    expect(parseBoardItem(node({ assignees: { totalCount: null } }))?.assigned).toBeNull();
  });

  test("BS-54: BOARD_QUERY asks for assignees, or BS-53's parser has no input", () => {
    // BS-53 proves the parser reads the field. It cannot prove the QUERY
    // sends it, and a parser with nothing to parse returns null for every
    // row — which BS-51 then reports as undecidable, for every issue on the
    // board, forever, with no error anywhere. The two halves are a pair.
    expect(BOARD_QUERY).toContain("assignees");
    expect(BOARD_QUERY).toContain("totalCount");
  });

  test("BS-29: Status is read from the nested field name, not from position", () => {
    // Two decoys either side, so a parser that takes `nodes[0].name` or the
    // last node passes nothing. The filter has to look at `field.name`.
    const item = parseBoardItem(
      node({}, values({ Priority: "P1", Status: "Done", Size: "M" })),
    );
    expect(item?.status).toBe(DONE);
    expect(item?.statusUnread).toBe(false);
    expect(item).toMatchObject({ itemId: "PVTI_x", number: 7, kind: "PullRequest", state: "OPEN" });
  });

  test("BS-30: Status absent off the end of a FULL page is statusUnread, derived", () => {
    // The finding's exact ask: prove `statusUnread` comes out true from a
    // real-shaped payload, not from a hand-set fixture field. This is the
    // false zero one level down — Status is not in the page, and the page
    // says there is more.
    const item = parseBoardItem(node({}, values({ Priority: "P1" }, true)));
    expect(item?.status).toBeNull();
    expect(item?.statusUnread).toBe(true);
    // And the verdict that follows from it, so the two halves meet in one
    // case rather than each being correct against its own fixture.
    expect(verdictFor(item!).kind).toBe("undecidable");
  });

  test("BS-31: Status absent off a COMPLETE page is not read, it is not set", () => {
    // The distinction the whole fix exists for. Same `status: null`, opposite
    // meaning, and nothing but `hasNextPage` tells them apart — so a parser
    // that ignored `pageInfo` would pass BS-30 and fail here, and one that
    // always trusted it would pass here and fail BS-30.
    const item = parseBoardItem(node({}, values({ Priority: "P1" }, false)));
    expect(item?.status).toBeNull();
    expect(item?.statusUnread).toBe(false);
  });

  test("BS-32: a truncated page that DID carry Status was read", () => {
    // `&& status === null` in the other direction. Dropping it refuses every
    // item with more fields than a page, for no reason, and BS-30 and BS-31
    // both stay green while it does.
    const item = parseBoardItem(node({}, values({ Status: IN_REVIEW }, true)));
    expect(item?.status).toBe(IN_REVIEW);
    expect(item?.statusUnread).toBe(false);
  });

  // ── BS-34..BS-35: two review findings about what a run tells its reader ──
  const SRC = readFileSync(join(import.meta.dir, "..", "scripts", "board-status-sweep.ts"), "utf-8");

  test("BS-34: every network call carries a timeout, so a hang reaches withRetry", () => {
    // `withRetry` survives failures that REJECT. A connection accepted and
    // never answered rejects nothing, so it never retries and `main()`
    // blocks forever — in CI, on the `--write` path, with nobody watching.
    // Caught in review of #1754.
    //
    // A census over the population rather than the one site: a second fetch
    // added later without a signal is the same defect at a new address.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    const fetches = [...code.matchAll(/\bfetch\(/g)];
    // Anti-vacuity. Zero means the request path was rewritten and the row
    // below is asserting over nothing.
    expect(fetches.length, "expected at least one fetch( in the sweep").toBeGreaterThanOrEqual(1);
    expect(
      (code.match(/signal:\s*AbortSignal\.timeout\(/g) ?? []).length,
      "every fetch( in this file must carry `signal: AbortSignal.timeout(...)` — " +
        "a stalled connection never rejects, so withRetry never gets to retry it",
    ).toBe(fetches.length);
    // And the budget is per attempt, so three attempts get three chances.
    expect(code).toMatch(/REQUEST_TIMEOUT_MS\s*=\s*[\d_]+/);
  });

  // ── BS-36..BS-37: two more, from the round that reviewed BS-34/BS-35 ────

  test("BS-36: an HTTP failure reports what the server said, not just the code", () => {
    // GitHub answers a bad or scopeless token with 401/403 and a well-formed
    // JSON body — `{"message": "Bad credentials", ...}` — carrying no `errors`
    // key at all. So `failed` is false, the two branches that preserve
    // `snippet` are both skipped, and execution reached `throw new Error(
    // \`HTTP ${status}\`)`, discarding the one sentence that says WHY.
    //
    // Through `withRetry` the reader finally saw "3 attempts failed, last:
    // HTTP 401" for a permanent, non-retryable credential problem — and this
    // function's own docblock promises it "keeps both facts available: the
    // status, and what the server actually said". Caught in review of #1754.
    //
    // Behavioural, not source-text: `interpretResponse` is exported, so the
    // message a reader actually gets is the thing asserted.
    const body = JSON.stringify({ message: "Bad credentials", documentation_url: "https://docs" });
    let message = "";
    try {
      interpretResponse(401, false, body);
      throw new Error("interpretResponse did not refuse a 401");
    } catch (e) {
      message = (e as Error).message;
    }
    // Anti-vacuity: the row must be observing the !ok branch, not the
    // not-JSON or not-an-object branch, both of which already carry text.
    expect(message, "expected the status in the message").toContain("401");
    expect(
      message,
      "a 401/403 body parses as JSON and carries no `errors`, so it reaches the " +
        "`!ok` throw — which must carry the server's own text. Without it the " +
        "reader gets a bare HTTP code for a permanent credential failure.",
    ).toContain("Bad credentials");
  });

  test("BS-37: the field list is paginated, or says it could not be read", () => {
    // `fields(first: 50)` with no `pageInfo`, in a file that loops `items`
    // with a cursor and explicitly flags `statusUnread` when `fieldValues`
    // truncates. A board that grows past fifty custom fields puts Status on
    // page two, and `.find(f => f?.name === "Status")` returns undefined —
    // throwing "no Status field on this project" about a field that exists
    // and was simply not fetched. Not silent-wrong, but the message sends the
    // reader to the board to look for something that is already there.
    // Caught in review of #1754. `.claude/rules/…` — page every list.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    const q = code.slice(code.indexOf("const FIELDS_QUERY"), code.indexOf("const SET_STATUS"));
    // Anti-vacuity: the query must still be here and must still be the one
    // that asks for fields.
    expect(q, "FIELDS_QUERY must still request fields").toMatch(/fields\(first:/);
    expect(
      q,
      "FIELDS_QUERY must ask for `pageInfo { hasNextPage }` like every other " +
        "list in this file, so a Status field on page two is UNMEASURED " +
        "rather than reported as absent.",
    ).toMatch(/pageInfo\s*\{[^}]*hasNextPage/);
    // And the absence must be told apart from the truncation when it is
    // reported, or the pageInfo is fetched and ignored.
    expect(
      code,
      "the 'no Status field' refusal must distinguish a field that is absent " +
        "from one that was never fetched — otherwise reading pageInfo changes nothing",
    ).toMatch(/hasNextPage[\s\S]{0,600}?no Status field|no Status field[\s\S]{0,600}?hasNextPage/);
  });

  test("BS-39: a write nothing confirms is a FAILURE, not a success", () => {
    // `SET_STATUS` returns `projectV2Item { id }` and the result was thrown
    // away, so `applyCorrections` logged `wrote #N` for anything that did not
    // throw. `updateProjectV2ItemFieldValue` can answer 200 with no `errors`
    // and `{ projectV2Item: null }` — item concurrently removed, or a
    // credential that writes some fields and not this one — and the board
    // then went on disagreeing with GitHub while the tool said it had fixed
    // it. Caught in review of #1754.
    //
    // Behavioural, through the exported binding, because the whole point is
    // which BUCKET a null payload lands in.
    expect(
      requireWrittenItem(
        { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_x" } } },
        7,
        "PVTI_x",
      ),
    ).toBe("PVTI_x");
    // The three shapes a 200-with-no-errors can carry.
    for (const [label, payload] of [
      ["a null item", { updateProjectV2ItemFieldValue: { projectV2Item: null } }],
      ["a null mutation payload", { updateProjectV2ItemFieldValue: null }],
      ["no key at all", {}],
    ] as const) {
      expect(() => requireWrittenItem(payload, 7, "PVTI_x"), `${label} must refuse`).toThrow(/#7/);
    }
    // An empty-string id is "present" to a truthiness check and confirms
    // nothing, which is the `?? 0` mistake in another costume.
    expect(() =>
      requireWrittenItem(
        { updateProjectV2ItemFieldValue: { projectV2Item: { id: "" } } },
        7,
        "PVTI_x",
      ),
    ).toThrow();

    // And the write path must actually call it — a validator nothing invokes
    // is the comment-saying-it-was-checked failure.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

    // **EVERY field write is confirmed — bound as an equality, not a
    // count.** This used to pin the call sites at exactly one, which was
    // right while there was one write path and became a number to bump the
    // moment a second arrived (the release path, #1758). A number somebody
    // raises to go green stops being a guard; the property it was standing
    // in for is this: there are exactly as many confirmations as there are
    // SET_STATUS mutations, so a new write path cannot skip one.
    const mutations = (code.match(/graphql\(token, SET_STATUS/g) ?? []).length;
    const confirmations = (code.match(/requireWrittenItem\(\s*await graphql\(token, SET_STATUS/g) ?? [])
      .length;
    expect(mutations, "SET_STATUS must still be issued somewhere").toBeGreaterThan(0);
    expect(
      confirmations,
      `${mutations} SET_STATUS mutation(s) but ${confirmations} confirmed — every write path ` +
        `must wrap its result in requireWrittenItem, or that path reports a write nothing ` +
        `checked. GitHub returns { projectV2Item: null } in a 200 with no errors.`,
    ).toBe(mutations);
  });

  // BS-41. THIS FILE MAKES FACTUAL CLAIMS ABOUT A FILE IT DOES NOT CONTAIN,
  // AND TWICE NOW THEY HAVE BEEN FALSE.
  //
  // Round 7 found the draft refusal citing a mechanism in `board-intake.yml`
  // that was not there. The round-8 repair rewrote that one sentence and put
  // TWO new false claims in its place — including a quotation ("WHAT IT
  // DELIBERATELY DOES NOT DO: set a field") that exists nowhere in
  // `board-intake.yml` and only ever existed in the comment quoting it. Both
  // repairs were written against a worktree whose `origin/main` was five
  // merges stale, so the file being described was read correctly and was the
  // wrong file.
  //
  // Rewriting the sentence a third time fixes one sentence. This asserts the
  // property instead: every string this file puts in quotation marks and
  // attributes to `board-intake.yml` must be findable in `board-intake.yml`.
  // A claim about a sibling file is now checked by CI on the merge ref, where
  // the sibling is current by construction, rather than by whoever last
  // remembered to go and look.
  test("BS-41: every phrase this file quotes from board-intake.yml is in board-intake.yml", () => {
    const workflow = readFileSync(join(ROOT, ".github/workflows/board-intake.yml"), "utf-8");

    // Anti-vacuity, both directions. The workflow must have actually been
    // read — an empty or missing file would make every `includes` below fail
    // rather than pass, but a TRUNCATED one would quietly shrink what the
    // claims are checked against. And the matcher must be able to say no.
    expect(workflow.length, "board-intake.yml was not read").toBeGreaterThan(5000);
    expect(
      workflow.includes("WHAT IT DELIBERATELY DOES NOT DO: set a field"),
      "control: the phrase the round-8 comment attributed to board-intake.yml " +
        "must NOT be in it — if this ever passes, the control has stopped " +
        "being able to disagree and every row below is vacuous",
    ).toBe(false);

    // The phrases `scripts/board-status-sweep.ts` attributes to the workflow.
    // Adding a quoted claim to that file means adding it here.
    const QUOTED = [
      "a draft in `In review` says somebody is waiting",
      "Drafts stay in Backlog until",
    ];
    expect(QUOTED.length, "the claim list must not be empty").toBeGreaterThan(0);

    const src = SRC.replace(/\r/g, "");
    for (const phrase of QUOTED) {
      // Each phrase must be BOTH claimed by the script and true of the
      // workflow. Checking only the second half would let a claim be deleted
      // from the script and still pass.
      // Compared verbatim on BOTH sides, backticks included. Normalising the
      // punctuation away would let the script quote something the workflow
      // does not actually say and still pass — the comparison has to be over
      // the bytes the reader would go and look for.
      expect(src.includes(phrase), `the script must actually claim: ${phrase}`).toBe(true);
      expect(
        workflow.includes(phrase),
        `scripts/board-status-sweep.ts attributes "${phrase}" to board-intake.yml, ` +
          `and board-intake.yml does not contain it. Re-read the workflow — on ` +
          `the CURRENT main, not a stale worktree ref — before describing it.`,
      ).toBe(true);
    }
  });

  // BS-42. `requireConnection` validated `nodes` and said nothing about
  // `pageInfo`, and `readBoard` then dereferenced `page.pageInfo.hasNextPage`
  // and `page.pageInfo.endCursor` bare — no `?.`, no shape check — in the one
  // list in this file with no pageInfo-shape row comparable to BS-37's for
  // FIELDS_QUERY. Schema-non-null in a well-formed response, which is exactly
  // the premise this file refuses to rest on everywhere else: if it is ever
  // hit, `readBoard` dies with a bare TypeError instead of the legible
  // refusal this script works hard to produce.
  //
  // Guarded in the single binding rather than at the two dereferences, so the
  // `fields` page gets it too and there is one site to mutate. Found in
  // review of #1754.
  test("BS-42: a connection must carry a usable pageInfo, not just nodes", () => {
    const ok = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    expect(requireConnection({ node: { items: ok } }, "items", "project board")).toEqual(ok);

    // Anti-vacuity: a well-formed page with `hasNextPage: true` must also
    // pass, so the row is not accidentally asserting "false only".
    const more = { nodes: [], pageInfo: { hasNextPage: true, endCursor: "c1" } };
    expect(requireConnection({ node: { items: more } }, "items", "project board")).toEqual(more);

    for (const [label, page] of [
      ["pageInfo absent entirely", { nodes: [] }],
      ["pageInfo null", { nodes: [], pageInfo: null }],
      ["pageInfo a scalar", { nodes: [], pageInfo: "yes" }],
      ["hasNextPage missing", { nodes: [], pageInfo: { endCursor: "c1" } }],
      ["hasNextPage a string, not a boolean", { nodes: [], pageInfo: { hasNextPage: "true" } }],
    ] as const) {
      expect(
        () => requireConnection({ node: { items: page } }, "items", "project board"),
        `${label} must refuse — a pagination flag that is not a boolean ends the ` +
          `loop early and reports a SHORT board as a complete one`,
      ).toThrow(/pageInfo/);
    }
  });

  // BS-43. THE SYMMETRIC HALF OF BS-42, WHICH I MISSED BY FIXING THE
  // MEMBER THE FINDING NAMED.
  //
  // BS-42 made a non-boolean `hasNextPage` refuse, because a falsy one ENDS
  // pagination early and reports a short board as complete. The mirror image
  // is a `hasNextPage: true` that cannot be followed: `endCursor` null, empty
  // or non-string. `readBoard` assigns it, the next request carries an `after`
  // that is effectively unset, GitHub returns page one again with
  // `hasNextPage: true`, and `for (;;)` never exits — an unbounded loop
  // burning API calls in a `--write` run with nobody watching. Worse than the
  // short read it is the twin of.
  //
  // Keyed on whether the connection ASKED for a cursor. A GraphQL response
  // carries exactly the selection set, so `endCursor` absent from `pageInfo`
  // means the query never requested it — which is `FIELDS_QUERY`, a
  // connection that refuses rather than pages. Present-and-unusable and
  // never-requested are different facts and only the first is a defect.
  // Found in review of #1754.
  test("BS-43: a hasNextPage that cannot be followed must refuse, not spin", () => {
    const conn = (pageInfo: unknown) => ({ node: { items: { nodes: [], pageInfo } } });

    // Anti-vacuity, three passing controls. Without these the row is
    // satisfied by a guard that refuses every connection in the file.
    expect(
      requireConnection(conn({ hasNextPage: true, endCursor: "c1" }), "items", "project board"),
      "a followable next page must pass",
    ).toBeDefined();
    expect(
      requireConnection(conn({ hasNextPage: false, endCursor: null }), "items", "project board"),
      "a null cursor at the END of a list is normal and must pass",
    ).toBeDefined();
    expect(
      requireConnection(conn({ hasNextPage: true }), "items", "project board"),
      "no endCursor KEY means the query never asked for one — that is " +
        "FIELDS_QUERY, which refuses rather than pages, and must not be " +
        "caught by a rule about following cursors",
    ).toBeDefined();

    for (const [label, cursor] of [
      ["endCursor null", null],
      ["endCursor empty string", ""],
      ["endCursor a number", 7],
    ] as const) {
      expect(
        () => requireConnection(conn({ hasNextPage: true, endCursor: cursor }), "items", "project board"),
        `${label} with hasNextPage true must refuse — the next request would ` +
          `re-fetch page one and the loop would never terminate`,
      ).toThrow(/endCursor/);
    }

    // THE GUARD MUST BE LIVE FOR THE ONE CALLER THAT PAGINATES. Because the
    // rule keys on the cursor being requested, dropping `endCursor` from
    // BOARD_QUERY would silently switch it off and leave the loop unguarded
    // with every row above still green.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    expect(
      code,
      "BOARD_QUERY's items connection must request endCursor, or BS-43's " +
        "refusal never applies to the only loop that can spin",
    ).toMatch(/items\(first: 100, after: \$endCursor\)\s*\{\s*pageInfo\s*\{\s*hasNextPage endCursor \}/);
  });

  // BS-44. The finding behind BS-43 named THREE ways a next page can fail to
  // be followable — `endCursor` null, undefined, "or a value that doesn't
  // actually advance the cursor". BS-43 closes the first two. This is the
  // third, and it is the one `requireConnection` structurally cannot see:
  // whether a cursor advanced is a property of two consecutive responses, and
  // that function is handed one. A well-formed, non-empty cursor returned
  // unchanged forever is an unbounded loop that passes every shape check.
  //
  // A page cap would also stop it and would be the wrong instrument — it
  // cannot tell a board that grew from a server that stopped advancing, so it
  // either fires on legitimate growth or is set so high it never fires at
  // all. Repetition is the exact signal and needs no threshold.
  test("BS-44: a cursor that does not advance is refused, not followed forever", () => {
    expect(requireCursorAdvanced(null, "c1"), "the first page must pass").toBe("c1");
    expect(requireCursorAdvanced("c1", "c2"), "an advancing cursor must pass").toBe("c2");

    expect(
      () => requireCursorAdvanced("c1", "c1"),
      "the same cursor twice is a server that stopped advancing — the next " +
        "request would repeat the page that produced it",
    ).toThrow(/same endCursor/);

    // The loops must actually use it. A progress invariant nothing calls is
    // the docblock-saying-it-was-checked failure.
    //
    // BOUND TO THE INVARIANT, NOT TO A COUNT. This asserted "the definition
    // plus exactly one call site" until a second legitimate paging loop
    // arrived — `resolveLinkedPullRequests` — and then the only thing it
    // measured was whether somebody had remembered to bump a 2 to a 3. A
    // number a correct change makes you edit teaches the next agent to edit
    // it, which is how BS-39 lost its meaning too. The property is: EVERY
    // cursor advance goes through the invariant, and the invariant is called
    // exactly as many times as there are advances.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    const advances = code.match(/^[ \t]*endCursor = .*$/gm) ?? [];
    expect(
      advances.length,
      "no paging loop advances a cursor at all — either this file stopped " +
        "paginating, or the advance is spelled in a way this cannot see, and " +
        "both make every assertion below vacuous",
    ).toBeGreaterThan(0);
    expect(
      advances.filter(line => !/= requireCursorAdvanced\(/.test(line)),
      "every paging loop must assign its next cursor THROUGH the invariant, " +
        "not beside it — a loop that advances its own cursor is the unbounded " +
        "one this check exists to refuse",
    ).toEqual([]);
    expect(
      (code.match(/requireCursorAdvanced\(/g) ?? []).length,
      "expected the definition plus one call per cursor advance — a call site " +
        "that is not an advance means something is checking progress it does " +
        "not then follow",
    ).toBe(advances.length + 1);
  });

  // BS-45. THE SAME CLASS AS BS-41, INSIDE ONE FILE. BS-41 catches a comment
  // quoting a SIBLING file and being wrong about it. This catches a docblock
  // attached to the wrong function in THIS file, which is the same defect —
  // a claim and the thing it is attributed to having drifted apart — and it
  // arrived the same way both times: BS-39 and BS-44 each added an export
  // immediately ABOVE an existing function, leaving that function's docblock
  // stranded over the newcomer. `requireCursorAdvanced` wore `requireNode`'s
  // and `requireConnection`'s; `requireWrittenItem` wore `applyCorrections`'.
  //
  // The syntax is the tell and needs no language model: a `*/` followed by a
  // `/**` means two docblocks are stacked, and at most one of them can be
  // describing whatever comes next. Found in review of #1754.
  test("BS-45: no docblock is stranded above a function it does not describe", () => {
    const stacked = SRC.match(/\*\/\s*\n\s*\/\*\*/g) ?? [];
    expect(
      stacked.length,
      "two docblocks in a row means the upper one describes nothing that " +
        "follows it — move it to the function it is about, or fold them " +
        "together. This is BS-41's defect with the sibling file set to self.",
    ).toBe(0);

    // Anti-vacuity: the detector must actually fire on the shape, or a zero
    // above is a reading about a regex that matches nothing.
    const planted = "/**\n * one\n */\n/**\n * two\n */\nexport function f() {}";
    expect(
      (planted.match(/\*\/\s*\n\s*\/\*\*/g) ?? []).length,
      "the detector must find a planted stack, or its zero means nothing",
    ).toBe(1);
  });

  // BS-46. BS-39 CHECKED PRESENCE WHERE THE QUESTION IS IDENTITY — the same
  // shape as BS-27 (`errors` present vs populated) and BS-42 (`hasNextPage`
  // present vs boolean), now on the one path that CHANGES the board.
  //
  // `requireWrittenItem` proved that the mutation echoed back *an* item id. It
  // never asked whether that id was the item the correction targeted, and it
  // structurally could not: `c.itemId` goes into the SET_STATUS variables at
  // the call site and was never passed in. Every read helper in this file —
  // `requireNode`, `requireConnection`, `requireCursorAdvanced` — validates
  // that the response is about the thing that was asked for. The write helper
  // was the one that stopped at well-formedness.
  //
  // The damage is the exact outcome this tool exists to detect: a stale or
  // misrouted response echoes a different id, the write is reported as
  // applied, `wrote #N -> Status` is printed, and the item that needed
  // correcting goes on disagreeing with GitHub. Found in review of #1754.
  test("BS-46: the write is confirmed for the item targeted, not merely for an item", () => {
    expect(
      requireWrittenItem(
        { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_a" } } },
        7,
        "PVTI_a",
      ),
      "the id that was targeted must pass",
    ).toBe("PVTI_a");

    expect(
      () =>
        requireWrittenItem(
          { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_b" } } },
          7,
          "PVTI_a",
        ),
      "a well-formed id for a DIFFERENT item confirms nothing about this " +
        "correction and must refuse — presence is not identity",
    ).toThrow(/PVTI_a/);

    // The call site must hand it the id it targeted, or the comparison above
    // is a property of the test rather than of the write path.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    expect(
      code,
      "requireWrittenItem must receive the same c.itemId that SET_STATUS was " +
        "given, or it cannot tell which item GitHub answered about",
    ).toMatch(/c\.number,\s*c\.itemId,/);
  });

  // BS-40. `requireNode` guards the TOP-LEVEL node being null — the case
  // GitHub returns for an id the token cannot see — and both call sites then
  // reached straight into a nested connection it does not check:
  // `(requireNode(data, …) as any).items` and `… as any).fields`. An id that
  // resolves to something which is not a ProjectV2 leaves the `... on
  // ProjectV2` fragment unmatched, so `node` is a perfectly good object and
  // the connection is `undefined` — and `page.nodes` threw a bare
  // `Cannot read properties of undefined (reading 'nodes')` from the one
  // script whose entire subject is telling a reading from an absence.
  //
  // Found in review of #1754 — and it is the SAME class as BR-40/BR-41, fixed
  // in `scripts/board-ready.ts` in this same session without sweeping the
  // sibling. Population here is 2 of 2; both go through one binding.
  test("BS-40: a nested connection is guarded like the node that carries it", () => {
    expect(
      requireConnection(
        { node: { items: { nodes: [], pageInfo: { hasNextPage: false } } } },
        "items",
        "project board",
      ),
    ).toEqual({ nodes: [], pageInfo: { hasNextPage: false } });

    // Anti-vacuity: each refusal must be observed for its OWN shape, and the
    // top-level cases must still refuse through requireNode underneath.
    for (const [label, payload] of [
      ["the fragment did not match, so the key is absent", { node: {} }],
      ["the key is present and null", { node: { items: null } }],
      ["the key is a scalar, not a connection", { node: { items: 7 } }],
      ["the connection carries no nodes array", { node: { items: { pageInfo: {} } } }],
    ] as const) {
      expect(
        () => requireConnection(payload, "items", "project board"),
        `${label} must refuse`,
      ).toThrow(/items/);
    }
    expect(() => requireConnection({ node: null }, "items", "project board")).toThrow(/SUCCEEDED/);

    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    expect(
      (code.match(/requireConnection\(/g) ?? []).length,
      "expected the definition plus exactly two call sites — the board items " +
        "page and the project fields page, which are the only two nested " +
        "connections this script reaches into",
    ).toBe(3);

    // The defect, as source: a requireNode result cast and indexed directly.
    expect(
      [...code.matchAll(/requireNode\([^)]*\)\s*as any\)\s*\./g)].map(m => m[0]),
      "a `(requireNode(…) as any).<key>` reach-through is the unguarded " +
        "connection this row exists to stop — route it through " +
        "requireConnection so the absence is named instead of thrown past.",
    ).toEqual([]);
  });

  test("BS-38: a --write run with nothing to write resolves no fields", () => {
    // `--write` fell through to FIELDS_QUERY whatever the reading said, so a
    // no-op run was exposed to two failures that have nothing to do with the
    // work: the page-two Status refusal and "no Status field on this
    // project". The equivalent report-only run cannot fail either way, which
    // made passing --write on a clean board strictly more fragile than not
    // passing it. Caught in review of #1754.
    //
    // **This is a source-ORDER assertion, not a behavioural one, and the
    // review that raised it said so first** — exercising `main()` needs a
    // live GraphQL endpoint, and a mock deep enough to reach line 544 would
    // be asserting against its own fixture. The property that is checkable
    // from here is the one that matters: the guard exists and precedes the
    // fetch. BS-37 covers what happens when the fetch does run.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    // **The writable set grew, so the guard did too.** A release is a write
    // — it unassigns an issue and may move a card — so a run holding only
    // releases must NOT short-circuit. Both halves are named here rather
    // than loosened to a wildcard, because a guard that short-circuits on
    // corrections alone would silently skip every stale claim.
    const guard = code.search(
      /if \(reading\.corrections\.length === 0 && reading\.releases\.length === 0\)/,
    );
    const fetchFields = code.search(/graphql\(token, FIELDS_QUERY/);
    // Anti-vacuity, both halves. A renamed query or a deleted guard gives -1,
    // and -1 < anything would otherwise satisfy the ordering vacuously.
    expect(fetchFields, "FIELDS_QUERY must still be fetched somewhere").toBeGreaterThan(-1);
    expect(
      guard,
      "a `--write` run must short-circuit when there is nothing writable — that is " +
        "`reading.corrections.length === 0 && reading.releases.length === 0`, naming both",
    ).toBeGreaterThan(-1);
    expect(
      guard < fetchFields,
      "the empty-corrections guard must come BEFORE the Status field is resolved, " +
        "or a run with nothing to write can still abort on a field lookup it never needed",
    ).toBe(true);
  });

  test("BS-35: the re-run instruction is not printed when nothing is writable", () => {
    // One message served both branches, so a run finding only undecidable
    // rows said "re-run with --write to apply the corrections above" when
    // there were none above and --write is explicitly refused for those
    // rows. An instruction that cannot work teaches the reader to distrust
    // the tool rather than to go and pick the column.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    // The instruction must be guarded on the WRITABLE rows alone. Releases
    // joined corrections in that set when the stale-claim rule landed —
    // both are things `--write` performs — and the anti-vacuity check below
    // is what keeps `undecidable` out of it, which is the actual defect.
    expect(
      code,
      "the --write instruction must be reachable only when there is something writable: " +
        "corrections or releases, never undecidable rows",
    ).toMatch(
      /if\s*\(reading\.corrections\.length > 0 \|\| reading\.releases\.length > 0\)\s*\{\s*\n\s*console\.log\([^)]*--write/,
    );
    // And the undecidable-only case must say so rather than borrow it.
    expect(
      code,
      "a run with only undecidable rows needs its own message saying nothing is writable",
    ).toMatch(/every row above is UNDECIDABLE/);
    // Anti-vacuity: the old single-condition guard must be gone, not merely
    // joined by a second one.
    expect(
      /reading\.corrections\.length > 0 \|\| reading\.undecidable\.length > 0/.test(code),
      "the merged condition is the defect — the two cases print different instructions",
    ).toBe(false);
  });

  test("BS-33: isDraft is coerced, and a node this sweep cannot judge is null", () => {
    // `isDraft` is absent on the Issue fragment. An `undefined` reaching
    // `BoardItem.draft` makes `!item.draft` true for every item, so the draft
    // branch never runs — BS-13 is green against a sweep that moves drafts.
    expect(parseBoardItem(node({ __typename: "Issue", isDraft: undefined }))?.draft).toBe(false);
    expect(parseBoardItem(node({ isDraft: true }))?.draft).toBe(true);

    // And the three nodes that are not items of this sweep.
    expect(parseBoardItem({ id: "a", content: null })).toBeNull();
    expect(parseBoardItem({ id: "a" })).toBeNull();
    expect(parseBoardItem({ id: "a", content: { __typename: "DraftIssue" } })).toBeNull();
  });

  // ── BS-75..BS-81: an open UNASSIGNED card in a lane that asserts work ────
  //
  // #1977. The sweep reported `agrees 328, disagrees 0` on a board holding
  // five cards that were wrong, and all five were the same shape: an open
  // issue, nobody assigned, sitting in `In progress` or `In review`. The
  // assignment branch above only fires for `ASSIGNMENT_CONTRADICTS`
  // (Backlog, Ready), so an unassigned issue in a working lane fell past it
  // to `if (item.status !== DONE) return { kind: "agrees" }` — a verdict of
  // AGREEMENT reached by never asking the question.
  //
  // `specs/BOARD-FLOW-SPEC.md` gives In progress the entry condition
  // `issues: [assigned]` and In review "a linked PR is not a draft". With
  // nobody assigned and no open pull request, neither condition holds and
  // the spec's backwards rule names the lane: Backlog.
  //
  // Scope, stated so the negative control below is readable: this is about
  // the UNASSIGNED half. An ASSIGNED card in In review with no open pull
  // request is a different reading and is deliberately left agreeing here.

  test("BS-75: an open unassigned issue in In progress is corrected to Backlog", () => {
    const v = verdictFor(item(1764, "Issue", "OPEN", IN_PROGRESS, false, null, false, 12, 0));
    expect(
      v.kind,
      "In progress asserts somebody is working on it. Nobody is assigned and no pull " +
        "request is open, so the lane claims work that no reading supports — and the " +
        "sweep called that agreement on five cards at once.",
    ).toBe("correct");
    expect(v.kind === "correct" && v.to).toBe(BACKLOG);
  });

  test("BS-76: and an open unassigned issue in In review is too", () => {
    const v = verdictFor(item(1717, "Issue", "OPEN", IN_REVIEW, false, null, false, 20, 0));
    expect(
      v.kind === "correct" && v.to,
      "In review's entry condition is a linked pull request that is not a draft. Zero " +
        "open pull requests and nobody assigned leaves the card asserting a reader is " +
        "waiting on something that does not exist.",
    ).toBe(BACKLOG);
  });

  test("BS-77: assignment NOT READ in those lanes is undecidable, never agreement", () => {
    // The whole defect, in its quiet form. `null` is the field the query did
    // not carry; letting it reach the fall-through would make a query that
    // lost `assignees` report a clean board having checked nothing —
    // Silent Default Substitution, `.claude/rules/config-access.md`.
    for (const lane of [IN_PROGRESS, IN_REVIEW]) {
      const v = verdictFor(item(1900, "Issue", "OPEN", lane, false, null, null, 12, 0));
      expect(v.kind, `${lane} with assignment unread`).toBe("undecidable");
      expect(v.kind === "undecidable" && v.why).toContain("NOT READ");
    }
  });

  test("BS-78: an unread pull-request count is undecidable, in both lanes", () => {
    // The other unread half, and it must not resolve either way: Backlog
    // would drag a card away from live work whose only evidence is the
    // reading that failed.
    for (const lane of [IN_PROGRESS, IN_REVIEW]) {
      const v = verdictFor(item(1901, "Issue", "OPEN", lane, false, null, false, 12, null));
      expect(v.kind, `${lane} with the pull-request count unread`).toBe("undecidable");
      expect(v.kind === "undecidable" && v.why).toContain("NOT READ");
    }
  });

  test("BS-79: unassigned WITH an open pull request is reported, not moved", () => {
    // Work exists, so Backlog is wrong. Whether that pull request is a draft
    // decides In progress against In review and this sweep cannot read it —
    // and `board-intake.yml` already decides it on the event. Guessing here
    // would be a second decider disagreeing with the first.
    const v = verdictFor(item(1902, "Issue", "OPEN", IN_PROGRESS, false, null, false, 12, 2));
    expect(v.kind).toBe("undecidable");
    expect(v.kind === "undecidable" && v.why).toContain("2 open pull request");
  });

  test("BS-80: the negative control — unassigned in Backlog or Ready still agrees", () => {
    // THE ROW THAT KEEPS THIS CHANGE HONEST. "Nobody is assigned" is the
    // CORRECT state for both of these lanes, so a fix that reads assignment
    // alone would move every card on the board. One variable differs between
    // this case and BS-75: the lane.
    for (const lane of [BACKLOG, "Ready"]) {
      expect(
        verdictFor(item(1903, "Issue", "OPEN", lane, false, null, false, 12, 0)).kind,
        `${lane}'s entry condition is nobody assigned — this is the state, not a defect`,
      ).toBe("agrees");
    }
    // And an ASSIGNED card in a working lane is what those lanes are for.
    expect(verdictFor(item(1904, "Issue", "OPEN", IN_PROGRESS, false, null, true, 0, 0)).kind).toBe(
      "agrees",
    );
    expect(verdictFor(item(1905, "Issue", "OPEN", IN_REVIEW, false, null, true, 0, 0)).kind).toBe(
      "agrees",
    );
    // A pull request's OWN card in a working lane is not this rule's
    // population: no lane table covers it, and `assigned` is always null.
    expect(verdictFor(item(1906, "PullRequest", "OPEN", IN_PROGRESS, false, null, null, 0, 0)).kind).toBe(
      "agrees",
    );
  });

  test("BS-81: the sweep spends a pull-request query on these rows", () => {
    // WITHOUT THIS THE FIX IS DEAD IN PRODUCTION. `openLinkedPRs` is
    // resolved only for rows the candidate predicate names; every other row
    // keeps `null`, so all five stale cards would come back UNDECIDABLE and
    // the sweep would still correct nothing. BS-75..BS-79 run against a
    // hand-built item and cannot see that.
    expect(
      needsOpenPullRequestReading(item(1764, "Issue", "OPEN", IN_PROGRESS, false, null, false, 12)),
      "an unassigned card in a working lane needs the reading BS-75 decides on",
    ).toBe(true);
    expect(
      needsOpenPullRequestReading(item(1717, "Issue", "OPEN", IN_REVIEW, false, null, false, 20)),
    ).toBe(true);
    // Unread assignment is a candidate too: the row is undecidable either
    // way, and refusing to spend the query would hide which half was missing.
    expect(
      needsOpenPullRequestReading(item(1900, "Issue", "OPEN", IN_PROGRESS, false, null, null, 12)),
    ).toBe(true);
    // It still never spends one on a row no verdict asks the question about.
    expect(
      needsOpenPullRequestReading(item(1903, "Issue", "OPEN", BACKLOG, false, null, false, 12)),
      "Backlog unassigned is correct — no verdict below reads a pull-request count for it",
    ).toBe(false);
    expect(
      needsOpenPullRequestReading(item(1906, "PullRequest", "OPEN", IN_PROGRESS, false, null, null, 12)),
    ).toBe(false);
    // The stale-claim half is unchanged and still routed through the union.
    expect(
      needsOpenPullRequestReading(item(312, "Issue", "OPEN", BACKLOG, false, null, true, 30)),
    ).toBe(true);
  });
});

// ── BS-28: the refusal, performed and observed ───────────────────────────
//
// THIS BATTERY EXISTS BECAUSE ITS ABSENCE WAS BEING CLAIMED AS PRESENT.
// `DRIFT_EXIT`'s docblock read "Mutated to 0 to prove the refusal is real",
// and nothing in this file imported `DRIFT_EXIT`, ran `main()`, or observed
// an exit code. A comment saying a property is tested is the reason nobody
// tests it (`.claude/rules/checks-must-be-able-to-fail.md`) — so the claim
// is made true here rather than softened in the comment.
//
// The shape is `test/rook-review-scope.test.ts`'s, with one difference that
// matters: that script has no relative imports, so its mutant is a lone file
// in a temp directory. This one imports `../lib/github`, so the sandbox
// carries `lib/` and a link to `node_modules`. A mutant that died on module
// resolution would also exit non-zero and read as the mutation having been
// rejected on the merits — which is why every case below asserts the run
// PRINTED ITS DECISION as well as what it exited with.
const ROOT = join(import.meta.dir, "..");
const SWEEP = "scripts/board-status-sweep.ts";
const source = readFileSync(join(ROOT, SWEEP), "utf-8");

let SANDBOX = "";
let REAL = "";
let MUTANT = "";

beforeAll(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "board-sweep-mutant-"));
  cpSync(join(ROOT, "lib"), join(SANDBOX, "lib"), { recursive: true });
  cpSync(join(ROOT, "scripts"), join(SANDBOX, "scripts"), { recursive: true });
  cpSync(join(ROOT, "package.json"), join(SANDBOX, "package.json"));
  // The board's id is read from config before the credential (#1719), so a
  // sandbox without it would refuse on the board and never reach the
  // credential check these cases are about.
  cpSync(join(ROOT, ".claude", "rungate"), join(SANDBOX, ".claude", "rungate"), { recursive: true });
  symlinkSync(join(ROOT, "node_modules"), join(SANDBOX, "node_modules"));

  REAL = join(SANDBOX, SWEEP);
  MUTANT = join(SANDBOX, "scripts", "board-status-sweep.mutant.ts");

  const mutated = source.replace(/DRIFT_EXIT\s*=\s*1\b/, "DRIFT_EXIT = 0");
  expect(
    mutated,
    "could not build the mutant: no `DRIFT_EXIT = 1` in " + SWEEP,
  ).not.toBe(source);
  writeFileSync(MUTANT, mutated);
});

afterAll(() => {
  if (SANDBOX) rmSync(SANDBOX, { recursive: true, force: true });
});

/** Run a copy with NO credential in the environment, whatever this machine has. */
function runWithoutCredential(script: string): { code: number; out: string } {
  const env = { ...process.env };
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  const r = spawnSync("bun", [script], { encoding: "utf-8", env, cwd: SANDBOX });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("BS-28: DRIFT_EXIT is the refusal, and the mutant proves it", () => {
  test("the real script refuses an absent credential, and says so", () => {
    const r = runWithoutCredential(REAL);
    // The DECISION first. A non-zero exit on its own is also what a crash,
    // a missing module and a syntax error produce.
    expect(r.out, `the script printed no UNMEASURED reading:\n${r.out}`).toContain("UNMEASURED");
    // And the CREDENTIAL's decision, not the board's: both print UNMEASURED.
    expect(r.out, `the refusal was not about the credential:\n${r.out}`).toContain("no GitHub credential");
    expect(r.code, `expected a refusal, got ${r.code}:\n${r.out}`).toBe(1);
  });

  test("the mutant reaches the same decision and does NOT refuse", () => {
    const r = runWithoutCredential(MUTANT);
    // Same reading printed — so this run demonstrably reached the mechanism
    // rather than dying before it.
    expect(r.out, `the mutant printed no UNMEASURED reading:\n${r.out}`).toContain("UNMEASURED");
    // And the refusal is gone, which is the whole point: the non-zero exit
    // was removed, performed, and observed.
    expect(
      r.code,
      `the mutant (DRIFT_EXIT = 0) still exited ${r.code} — the refusal under ` +
        `test is not what the case above observed.\n${r.out}`,
    ).toBe(0);
  });

  test("DRIFT_EXIT is assigned exactly once, so the mutation cannot be bypassed", () => {
    const assignments = source.match(/DRIFT_EXIT\s*=/g) ?? [];
    expect(
      assignments.length,
      "more than one assignment to DRIFT_EXIT — the mutant would neutralise only one",
    ).toBe(1);
  });

  test("no refusal inlines its own exit code", () => {
    // A `process.exit(1)` or `return 1` elsewhere would survive the mutation
    // and leave a refusal this battery cannot see.
    //
    // The first spelling of this captured `([^)]*)` and so stopped at the
    // first inner paren of `main(process.argv.slice(2))`, reporting the
    // entrypoint as an offender. Counting the call sites and asserting the
    // one spelling is both narrower and correct — a detector that cannot
    // parse the code it guards reports the code's shape as a defect.
    const exits = [...source.matchAll(/process\.exit\(/g)];
    expect(exits.length, "exactly one process.exit, and it returns main()'s value").toBe(1);
    expect(source).toContain("process.exit(await main(");
    expect(
      /process\.exit\(\s*\d/.test(source),
      "a numeric literal passed to process.exit bypasses DRIFT_EXIT entirely",
    ).toBe(false);
    const literals = [...source.matchAll(/^\s*return\s+([1-9]\d*)\s*;/gm)].map(m => m[0].trim());
    expect(literals, "a literal non-zero return bypasses DRIFT_EXIT").toEqual([]);
  });
});

/**
 * Covers SC-2621 (SPEC-TO-BOARD-PIPELINE-SPEC.md), #1719.
 *
 * The board's identifiers come from project config, so a session told nothing
 * can address the board, and an unconfigured board is UNMEASURED rather than
 * a read of this repository's board under another project's name. On main at
 * c6218cbe two scripts still spelled the node id: this one and
 * `scripts/work-status.ts`.
 */
describe("#1719 / SC-2621: the board's identifiers are read from project config", () => {
  test("readBoardProjectId reads board.id; no config, no board block, or a blank id is null", () => {
    const dir = mkdtempSync(join(tmpdir(), "board-id-reader-"));
    const write = (config: unknown) => {
      mkdirSync(join(dir, ".claude", "rungate"), { recursive: true });
      writeFileSync(join(dir, ".claude", "rungate", "config.json"), JSON.stringify(config));
    };
    try {
      expect(readBoardProjectId(dir)).toBeNull();
      write({ project: "x" });
      expect(readBoardProjectId(dir)).toBeNull();
      write({ project: "x", board: { id: "   " } });
      expect(readBoardProjectId(dir), "a blank id names no board").toBeNull();
      write({ project: "x", board: { id: "PVT_fixtureBoardId" } });
      expect(readBoardProjectId(dir)).toBe("PVT_fixtureBoardId");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("run where no board is configured, the sweep refuses UNMEASURED and names board.id", () => {
    // A credential IS present, so the only refusal that can name `board.id`
    // is the board's. Before #1719 this run read the hardcoded board instead.
    const empty = mkdtempSync(join(tmpdir(), "board-sweep-unconfigured-"));
    try {
      const env: Record<string, string | undefined> = { ...process.env, GITHUB_TOKEN: "not-a-real-token" };
      delete env.GH_TOKEN;
      const run = (script: string) => {
        const r = spawnSync("bun", [script], { encoding: "utf-8", env, cwd: empty, timeout: 30_000 });
        return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
      };
      const real = run(REAL);
      expect(real.out, `the refusal did not name the missing key:\n${real.out}`).toContain("board.id");
      expect(real.out).toContain("UNMEASURED");
      expect(real.code, real.out).toBe(1);
      // Through DRIFT_EXIT, like every other refusal: the mutant prints the
      // same decision and exits 0.
      const mutant = run(MUTANT);
      expect(mutant.out).toContain("board.id");
      expect(mutant.code, mutant.out).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("no board identifier is spelled in lib/, scripts/, bin/, hooks/ or gates/ code", () => {
    // Comment lines are records (dated measurements name the board) and are
    // not reads. A code line holding a ProjectV2 id is a board this tool
    // reads whatever the config says.
    const ID = /PVT(?:SSF|F|V|I)?_[A-Za-z0-9_-]{8,}/;
    const spelled: string[] = [];
    let scanned = 0;
    for (const dir of ["lib", "scripts", "bin", "hooks", "gates"]) {
      for (const rel of readdirSync(join(ROOT, dir), { recursive: true }) as string[]) {
        if (!rel.endsWith(".ts")) continue;
        scanned++;
        readFileSync(join(ROOT, dir, rel), "utf-8").split("\n").forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          if (ID.test(line)) spelled.push(`${dir}/${rel}:${i + 1}`);
        });
      }
    }
    expect(scanned, "the sweep read no source, so an empty list proves nothing").toBeGreaterThan(100);
    expect(spelled, "read the id with readBoardProjectId (lib/config-readers.ts) instead").toEqual([]);
  });
});

// ── #1942 / SC-2760: silence is read from the work, never from the issue ───
//
// Measured 2026-11-09: the sweep ran six times, all success, and left six
// claimed-but-unworked issues alone, every one reading 0 to 2 days idle —
// because they had been COMMENTED on. `updatedAt` moves on a comment, so
// discussing an issue was indistinguishable from working it, and a session
// that claimed an issue and then wrote about it held the claim for ever.
//
// The clock is now the latest of three moments, each a piece of work or the
// claim itself: the newest `assigned` event, the tip commit of every branch
// `issueFromBranch` attributes to the issue, and the opening and newest
// commit of every pull request declaring it closes the issue.
describe("#1942 / SC-2760: a claim's silence is read from its work", () => {
  const now = Date.parse("2026-11-13T12:00:00Z");
  const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString();

  /** The response `CLAIM_ACTIVITY_QUERY` returns, built from its parts. */
  const activityResponse = (
    o: {
      assignedAt?: string | null;
      branches?: { name: string; at: string }[];
      prs?: { created: string; lastCommit?: string }[];
      refsTruncated?: boolean;
      prsTruncated?: boolean;
    } = {},
  ) => ({
    repository: {
      issue: {
        timelineItems: { nodes: o.assignedAt === null ? [] : [{ createdAt: o.assignedAt ?? daysAgo(10) }] },
        closedByPullRequestsReferences: {
          pageInfo: { hasNextPage: o.prsTruncated === true },
          nodes: (o.prs ?? []).map(p => ({
            createdAt: p.created,
            commits: { nodes: p.lastCommit ? [{ commit: { committedDate: p.lastCommit } }] : [] },
          })),
        },
      },
      refs: {
        pageInfo: { hasNextPage: o.refsTruncated === true },
        nodes: (o.branches ?? []).map(b => ({ name: b.name, target: { committedDate: b.at } })),
      },
    },
  });

  /** An assigned open issue in Backlog, updated TODAY — a comment, not work. */
  const commentedToday = {
    id: "PVTI_1942",
    content: {
      __typename: "Issue",
      number: 1942,
      state: "OPEN",
      stateReason: null,
      updatedAt: daysAgo(0),
      assignees: { totalCount: 1 },
    },
    fieldValues: { pageInfo: { hasNextPage: false }, nodes: [{ name: "Backlog", field: { name: "Status" } }] },
  };

  test("SC-2760: an issue commented on today but unworked for 10 days is released", () => {
    // The regression end to end: parse the live node shape, read the work,
    // decide. Against the `updatedAt` clock this row reads 0 days idle and
    // is promoted to In progress instead.
    const parsed = parseBoardItem(commentedToday, now)!;
    expect(parsed.idleDays, "the issue's own last-updated time is still being read as activity").toBeNull();
    expect(needsClaimActivityReading(parsed)).toBe(true);

    const activity = parseClaimActivity(activityResponse({ assignedAt: daysAgo(10) }), 1942);
    const [withSilence] = applyClaimSilence([parsed], new Map([[1942, activity]]), now);
    expect(withSilence!.idleDays).toBe(10);

    const [read] = applyLinkedPullRequests([withSilence!], new Map());
    const v = verdictFor(read!);
    expect(v.kind, `expected a release, got ${JSON.stringify(v)}`).toBe("release");
  });

  test("claimSilence: the latest of the claim and every work moment, in whole days", () => {
    expect(claimSilence({ claimedAt: daysAgo(20), workAt: [] }, now)).toBe(20);
    expect(claimSilence({ claimedAt: daysAgo(20), workAt: [daysAgo(9), daysAgo(2)] }, now)).toBe(2);
    // Work older than the claim does not age it: a re-claim restarts the clock.
    expect(claimSilence({ claimedAt: daysAgo(3), workAt: [daysAgo(30)] }, now)).toBe(3);
  });

  test("claimSilence: an unread claim or an unreadable work date is NOT READ, never zero", () => {
    // Zero is "worked today" — the answer that keeps a claim — and a dropped
    // date is a shorter list that reads as older silence, the answer that
    // releases one. Both are substitutions; null is the only honest value.
    expect(claimSilence({ claimedAt: null, workAt: [daysAgo(1)] }, now)).toBeNull();
    expect(claimSilence({ claimedAt: daysAgo(20), workAt: ["not a date"] }, now)).toBeNull();
    expect(claimSilence(null, now)).toBeNull();
  });

  test("parseClaimActivity: a branch counts only when issueFromBranch names this issue", () => {
    const a = parseClaimActivity(
      activityResponse({
        assignedAt: daysAgo(20),
        branches: [
          { name: "rg/1942", at: daysAgo(4) },
          { name: "rg/19420", at: daysAgo(1) }, //      another issue
          { name: "rg/adr-1942-plan", at: daysAgo(1) }, // not an issue branch
        ],
      }),
      1942,
    );
    expect(a).not.toBeNull();
    expect(a!.claimedAt).toBe(daysAgo(20));
    expect(a!.workAt).toEqual([daysAgo(4)]);
  });

  test("parseClaimActivity: a declaring pull request counts by its opening and its newest commit", () => {
    const a = parseClaimActivity(
      activityResponse({ prs: [{ created: daysAgo(8), lastCommit: daysAgo(5) }, { created: daysAgo(6) }] }),
      1942,
    );
    expect([...a!.workAt].sort()).toEqual([daysAgo(8), daysAgo(6), daysAgo(5)].sort());
  });

  test("parseClaimActivity: a truncated page or a missing issue is NOT READ", () => {
    // A cut page is a shorter list, and a shorter list of work reads as
    // longer silence — the direction that unassigns somebody.
    expect(parseClaimActivity(activityResponse({ refsTruncated: true }), 1942)).toBeNull();
    expect(parseClaimActivity(activityResponse({ prsTruncated: true }), 1942)).toBeNull();
    expect(parseClaimActivity({ repository: { issue: null, refs: { pageInfo: { hasNextPage: false }, nodes: [] } } }, 1942)).toBeNull();
    expect(parseClaimActivity(undefined, 1942)).toBeNull();
    // No assigned event at all: the claim time is unread, not "never".
    expect(parseClaimActivity(activityResponse({ assignedAt: null }), 1942)!.claimedAt).toBeNull();
  });

  test("applyClaimSilence: only the rows that need it, and an absent reading stays NOT READ", () => {
    const backlog = item(1, "Issue", "OPEN", "Backlog", false, null, true, null);
    const inProgress = item(2, "Issue", "OPEN", "In progress", false, null, true, null);
    const unassigned = item(3, "Issue", "OPEN", "Backlog", false, null, false, null);
    const unread = item(4, "Issue", "OPEN", "Ready", false, null, true, null);
    const out = applyClaimSilence(
      [backlog, inProgress, unassigned, unread],
      new Map([
        [1, { claimedAt: daysAgo(9), workAt: [] }],
        [2, { claimedAt: daysAgo(9), workAt: [] }],
        [3, { claimedAt: daysAgo(9), workAt: [] }],
      ]),
      now,
    );
    expect(out.map(i => i.idleDays)).toEqual([9, null, null, null]);
  });

  test("the board query no longer asks for the issue's last-updated time", () => {
    // A field nobody reads invites the next reader to use it as a clock.
    expect(BOARD_QUERY).not.toMatch(/\bupdatedAt\b/);
    expect(CLAIM_ACTIVITY_QUERY).toContain("ASSIGNED_EVENT");
    expect(CLAIM_ACTIVITY_QUERY).toContain("closedByPullRequestsReferences");
    expect(CLAIM_ACTIVITY_QUERY).toContain("refs(");
  });
});

test("#1942: main reads each claim's silence before the pull-request read that depends on it", () => {
  // `isStaleClaimCandidate` picks the rows the pull-request read serves, and
  // it asks `idleDays`. Read in the other order — or not at all — every
  // claim stays `null`, every assigned row is UNDECIDABLE, and nothing is
  // ever released: green tests over a sweep that does nothing.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  expect(code).toMatch(
    /resolveLinkedPullRequests\(\s*token,\s*repoForReads,\s*await resolveClaimSilence\(token, repoForReads, board\),?\s*\)/,
  );
});
