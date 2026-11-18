import { describe, expect, test } from "bun:test";
import { boardWritesOf, handEditVerdict, isPersonWrite, type BoardWrite } from "../lib/hand-edits";

/**
 * #1722: the hand-edit reading SC-2625 is measured by.
 *
 * Jason's decision of 2026-11-17 is that the pipeline writes as its own
 * account, `rungate-bot`, so any board write made by a person can be named
 * as a hand edit. The measure starts once a board write is seen signed by
 * that account. These cases are the failure matrix, written before the
 * reader:
 *
 *  1. no pipeline account configured → UNMEASURED, never a default
 *  2. the account has not written yet → UNMEASURED (the window is not open)
 *  3. a person's write before the window opens → not counted
 *  4. a person's write after it opens → SHORT, named
 *  5. a Bot's write (`github-actions`, the project automation) → not a person
 *  6. the pipeline account's own writes → not a person
 *  7. a write with no actor (a deleted account) → counted, as unattributed
 *  8. logins compare without case, as GitHub's do
 *  9. an account whose login merely starts with the bot's is a person
 * 10. a population that could not be read → UNMEASURED, with its reason
 * 11. the issue's original body is its creation, not an edit
 * 12. a page that was cut, or a write with no time → unreadable, not empty
 */

const BOT = "rungate-bot";

function write(over: Partial<BoardWrite> = {}): BoardWrite {
  return {
    issue: 9001,
    kind: "milestoned",
    detail: "Convergence Phase 1",
    actor: BOT,
    actorType: "User",
    at: "2026-11-18T10:00:00Z",
    ...over,
  };
}

describe("#1722: who counts as a person", () => {
  test("a User other than the pipeline account is a person; Bots and the account are not", () => {
    expect(isPersonWrite(write({ actor: "hornjason" }), BOT)).toBe(true);
    expect(isPersonWrite(write({ actor: "github-actions", actorType: "Bot" }), BOT)).toBe(false);
    expect(isPersonWrite(write({ actor: "github-project-automation", actorType: "Bot" }), BOT)).toBe(false);
    expect(isPersonWrite(write({ actor: BOT }), BOT)).toBe(false);
  });

  test("logins compare without case, and a longer login is somebody else", () => {
    expect(isPersonWrite(write({ actor: "Rungate-Bot" }), BOT)).toBe(false);
    expect(isPersonWrite(write({ actor: "rungate-bot2" }), BOT)).toBe(true);
    expect(isPersonWrite(write({ actor: "rungate-bo" }), BOT)).toBe(true);
  });

  test("a write with no actor is counted: nothing shows the pipeline made it", () => {
    expect(isPersonWrite(write({ actor: null, actorType: null }), BOT)).toBe(true);
  });
});

describe("#1722: the verdict", () => {
  const SINCE = "2026-11-18T10:00:00Z";
  const ID = { account: BOT, since: SINCE };

  test("no pipeline account is UNMEASURED, and says which key to set", () => {
    const v = handEditVerdict([write()], { account: null, since: SINCE }, null);
    expect(v.status).toBe("unmeasured");
    expect(v.status === "unmeasured" && v.why).toContain("board.pipelineAccount");
  });

  test("no start time, or one that is not a time, is UNMEASURED, and says which key to set", () => {
    for (const since of [null, "yesterday"]) {
      const v = handEditVerdict([write()], { account: BOT, since }, null);
      expect(v.status, String(since)).toBe("unmeasured");
      expect(v.status === "unmeasured" && v.why, String(since)).toContain("board.pipelineSince");
    }
  });

  test("a population that was not read is UNMEASURED with its reason", () => {
    const v = handEditVerdict(null, ID, "the token cannot read project-board events");
    expect(v).toEqual({ status: "unmeasured", why: "the token cannot read project-board events" });
  });

  test("until the account writes since the start, the window is not open and nothing is certified", () => {
    const bot = handEditVerdict([write({ actor: "github-actions", actorType: "Bot" })], ID, null);
    expect(bot.status === "unmeasured" && bot.why).toContain("no board write signed by rungate-bot since");
    // A write by the account BEFORE the start does not open it either.
    const early = handEditVerdict([write({ at: "2026-11-17T00:00:00Z" })], ID, null);
    expect(early.status).toBe("unmeasured");
  });

  test("a person's write before the start is history, not a hand edit", () => {
    const v = handEditVerdict([write({ actor: "hornjason", at: "2026-11-17T09:00:00Z" }), write()], ID, null);
    expect(v).toEqual({ status: "met", since: SINCE, read: 2 });
  });

  test("a person's write after the start is named: issue, write, actor and time", () => {
    const v = handEditVerdict(
      [
        write(),
        write({ issue: 9002, kind: "labeled", detail: "engine", actor: "hornjason", at: "2026-11-18T11:00:00Z" }),
        write({ issue: 9003, kind: "labeled", detail: "engine", actor: "github-actions", actorType: "Bot", at: "2026-11-18T12:00:00Z" }),
      ],
      ID,
      null,
    );
    expect(v.status).toBe("short");
    expect(v.status === "short" && v.edits).toEqual(["#9002 labeled engine — by hornjason at 2026-11-18T11:00:00Z"]);
  });

  test("a write at the same instant as the start is inside the window", () => {
    const v = handEditVerdict([write(), write({ actor: "hornjason", at: SINCE })], ID, null);
    expect(v.status).toBe("short");
  });

  /**
   * Round 3 of #2388. The window used to open at the account's earliest
   * write among the issues read now. With the pipeline's first write on an
   * issue that has since left the family, the window opened at a LATER
   * pipeline write. A hand edit in between then read as history.
   */
  test("a hand edit after the start but before the account's first write that was read is still named", () => {
    const v = handEditVerdict(
      [write({ actor: "hornjason", at: "2026-11-18T11:00:00Z" }), write({ at: "2026-11-18T12:00:00Z" })],
      ID,
      null,
    );
    expect(v.status === "short" && v.edits).toEqual([
      "#9001 milestoned Convergence Phase 1 — by hornjason at 2026-11-18T11:00:00Z",
    ]);
  });

  test("an unattributed write after the start is named as such", () => {
    const v = handEditVerdict([write(), write({ actor: null, actorType: null, at: "2026-11-18T11:00:00Z" })], ID, null);
    expect(v.status === "short" && v.edits).toEqual([
      "#9001 milestoned Convergence Phase 1 — by an unattributed actor at 2026-11-18T11:00:00Z",
    ]);
  });
});

describe("#1722: reading one issue's writes", () => {
  const node = (over: Record<string, unknown> = {}) => ({
    number: 9001,
    createdAt: "2026-11-16T00:00:00Z",
    userContentEdits: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    ...over,
  });

  test("each event type becomes one write with its detail", () => {
    const r = boardWritesOf(
      node({
        timelineItems: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            { __typename: "MilestonedEvent", createdAt: "t1", actor: { __typename: "Bot", login: "github-actions" }, milestoneTitle: "Convergence Phase 1" },
            { __typename: "UnlabeledEvent", createdAt: "t2", actor: { __typename: "User", login: "hornjason" }, label: { name: "engine" } },
            { __typename: "BlockedByAddedEvent", createdAt: "t3", actor: { __typename: "Bot", login: "github-actions" }, blockingIssue: { number: 9000 } },
            { __typename: "BlockingRemovedEvent", createdAt: "t4", actor: { __typename: "User", login: "hornjason" }, blockedIssue: { number: 9005 } },
            { __typename: "RenamedTitleEvent", createdAt: "t5", actor: { __typename: "User", login: "hornjason" }, previousTitle: "a", currentTitle: "b" },
            { __typename: "ProjectV2ItemStatusChangedEvent", createdAt: "t6", actor: { __typename: "User", login: BOT }, status: "Ready" },
          ],
        },
      }),
    );
    expect("writes" in r && r.writes.map(w => `${w.kind} ${w.detail} ${w.actor}`)).toEqual([
      "milestoned Convergence Phase 1 github-actions",
      "unlabeled engine hornjason",
      "blocked-by added #9000 github-actions",
      "blocking removed #9005 hornjason",
      'renamed "a" → "b" hornjason',
      "project status Ready rungate-bot",
    ]);
  });

  test("the original body is the issue's creation; only later revisions are edits", () => {
    const r = boardWritesOf(
      node({
        userContentEdits: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            { editedAt: "2026-11-18T11:00:00Z", editor: { __typename: "User", login: "hornjason" } },
            { editedAt: "2026-11-16T00:00:00Z", editor: { __typename: "User", login: "hornjason" } },
          ],
        },
      }),
    );
    expect("writes" in r && r.writes).toEqual([
      { issue: 9001, kind: "body edited", detail: "", actor: "hornjason", actorType: "User", at: "2026-11-18T11:00:00Z" },
    ]);
  });

  test("a cut edit list, a write with no time, or an event type it does not know is unreadable, never empty", () => {
    const cut = boardWritesOf(node({ userContentEdits: { pageInfo: { hasNextPage: true, endCursor: "x" }, nodes: [] } }));
    expect("why" in cut && cut.why).toContain("#9001");
    const cutTimeline = boardWritesOf(node({ timelineItems: { pageInfo: { hasNextPage: true, endCursor: "x" }, nodes: [] } }));
    expect("why" in cutTimeline && cutTimeline.why).toContain("timeline was not read to the end");
    const untimed = boardWritesOf(
      node({ timelineItems: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: "LabeledEvent", actor: null, label: { name: "x" } }] } }),
    );
    expect("why" in untimed && untimed.why).toContain("no time");
    const unknown = boardWritesOf(
      node({ timelineItems: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: "SomethingNewEvent", createdAt: "t" }] } }),
    );
    expect("why" in unknown && unknown.why).toContain("SomethingNewEvent");
    expect("why" in boardWritesOf(null)).toBe(true);
    const noNumber = boardWritesOf(
      node({
        timelineItems: {
          pageInfo: { hasNextPage: false },
          nodes: [{ __typename: "BlockedByAddedEvent", createdAt: "t", actor: null, blockingIssue: null }],
        },
      }),
    );
    expect("why" in noNumber && noNumber.why).toContain("does not say what it wrote");
  });
});
