import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readPipelineAccount } from "../lib/config-readers";
import { HAND_EDITS_REFUSAL_EXIT, main, type HandEditsSource } from "../scripts/hand-edits";

/**
 * #1722: `scripts/hand-edits.ts` end to end, against a board handed to it.
 *
 * The verdict itself is `test/hand-edits.test.ts`. These cases hold the
 * reader: which issues it reads, that an issue moved out of the payload by
 * hand is still read, that a failed read is UNMEASURED, and that every
 * refusal exits through the one constant.
 */

const ROOT = join(import.meta.dir, "..");
const BOT = "rungate-bot";
const ID = { account: BOT, since: "2026-11-18T10:00:00Z" };
const REPO = "acme/widgets";

const actor = (login: string, type = "User") => ({ __typename: type, login });

interface FakeIssue {
  number: number;
  events: Record<string, unknown>[];
  edits?: Record<string, unknown>[];
}

/** A board: milestones with their issues, each issue's timeline, and the repo's event feed. */
function board(opts: {
  milestones: { title: string; issues: number[] }[];
  issues: FakeIssue[];
  repoEvents?: Record<string, unknown>[];
  /** Several pages of the event feed, page 1 first. */
  pages?: Record<string, unknown>[][];
  fail?: string;
}): { source: (repo: string) => HandEditsSource; asked: number[] } {
  const asked: number[] = [];
  const source = (): HandEditsSource => ({
    graphql: async (q, v) => {
      if (opts.fail) throw new Error(opts.fail);
      if (q.includes("milestones(")) {
        return {
          repository: {
            milestones: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: opts.milestones.map(m => ({
                title: m.title,
                issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: m.issues.map(number => ({ number })) },
              })),
            },
          },
        };
      }
      const n = v.number as number;
      asked.push(n);
      const i = opts.issues.find(x => x.number === n);
      if (!i) return { repository: { issue: null } };
      return {
        repository: {
          issue: {
            number: n,
            createdAt: "2026-11-01T00:00:00Z",
            userContentEdits: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: i.edits ?? [] },
            timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: i.events },
          },
        },
      };
    },
    repoEvents: async page => (opts.pages ? opts.pages[page - 1] ?? [] : page === 1 ? opts.repoEvents ?? [] : []),
  });
  return { source, asked };
}

const botMove = (at: string) => ({ __typename: "ProjectV2ItemStatusChangedEvent", createdAt: at, actor: actor(BOT), status: "Ready" });
const labeled = (at: string, who: ReturnType<typeof actor>, name = "engine") => ({
  __typename: "LabeledEvent",
  createdAt: at,
  actor: who,
  label: { name },
});

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

describe("#1722: the hand-edit reader", () => {
  test("MET: the window is open and every write since is the pipeline's or a bot's; only family milestones are read", async () => {
    const b = board({
      milestones: [
        { title: "Convergence Phase 1 — first", issues: [9001] },
        { title: "Engine Phase 1 — not this family", issues: [9050] },
      ],
      issues: [{ number: 9001, events: [botMove("2026-11-18T10:00:00Z"), labeled("2026-11-18T11:00:00Z", actor("github-actions", "Bot"))] }],
    });
    const out = await main(["--prefix", "Convergence", "--repo", REPO], { source: b.source, identity: ID });
    expect(out.code, out.lines.join("\n")).toBe(0);
    expect(out.lines[0]).toContain("MET");
    expect(b.asked).toEqual([9001]);
  });

  test("SHORT: a person's label after the window opens is named, and the exit is the refusal constant", async () => {
    const b = board({
      milestones: [{ title: "Convergence Phase 1", issues: [9001] }],
      issues: [{ number: 9001, events: [botMove("2026-11-18T10:00:00Z"), labeled("2026-11-18T12:00:00Z", actor("hornjason"))] }],
    });
    const out = await main(["--prefix", "Convergence", "--repo", REPO], { source: b.source, identity: ID });
    expect(out.code).toBe(HAND_EDITS_REFUSAL_EXIT);
    expect(out.lines).toEqual([
      "hand-edits: SHORT — 1 hand edit(s) since 2026-11-18T10:00:00Z on the Convergence family:",
      "  #9001 labeled engine — by hornjason at 2026-11-18T12:00:00Z",
    ]);
  });

  test("an issue taken out of a family milestone by hand after the window opens is still read, and its edit named", async () => {
    const b = board({
      milestones: [{ title: "Convergence Phase 1", issues: [9001] }],
      issues: [
        { number: 9001, events: [botMove("2026-11-18T10:00:00Z")] },
        {
          number: 9002,
          events: [
            { __typename: "DemilestonedEvent", createdAt: "2026-11-18T13:00:00Z", actor: actor("hornjason"), milestoneTitle: "Convergence Phase 1" },
          ],
        },
      ],
      repoEvents: [
        { event: "demilestoned", created_at: "2026-11-18T13:00:00Z", milestone: { title: "Convergence Phase 1" }, issue: { number: 9002 } },
        { event: "labeled", created_at: "2026-11-18T12:00:00Z", issue: { number: 9003 } },
        { event: "milestoned", created_at: "2026-11-17T00:00:00Z", milestone: { title: "Convergence Phase 1" }, issue: { number: 9004 } },
      ],
    });
    const out = await main(["--prefix", "Convergence", "--repo", REPO], { source: b.source, identity: ID });
    expect(out.code).toBe(HAND_EDITS_REFUSAL_EXIT);
    expect(out.lines[1]).toBe("  #9002 demilestoned Convergence Phase 1 — by hornjason at 2026-11-18T13:00:00Z");
    // 9004 left before the window opened, and 9003 was never in the family.
    expect(b.asked).toEqual([9001, 9002]);
  });

  test("a move on page 2 of the event feed is found: a full page inside the window does not end the read", async () => {
    const filler = Array.from({ length: 100 }, (_, k) => ({
      event: "labeled",
      created_at: `2026-11-18T20:${String(59 - Math.floor(k / 2)).padStart(2, "0")}:00Z`,
      issue: { number: 8000 + k },
    }));
    const b = board({
      milestones: [{ title: "Convergence Phase 1", issues: [9001] }],
      issues: [
        { number: 9001, events: [botMove("2026-11-18T10:00:00Z")] },
        {
          number: 9050,
          events: [
            { __typename: "DemilestonedEvent", createdAt: "2026-11-18T13:00:00Z", actor: actor("hornjason"), milestoneTitle: "Convergence Phase 1" },
          ],
        },
      ],
      pages: [
        filler,
        [
          { event: "demilestoned", created_at: "2026-11-18T13:00:00Z", milestone: { title: "Convergence Phase 1" }, issue: { number: 9050 } },
          { event: "labeled", created_at: "2026-11-17T00:00:00Z", issue: { number: 9051 } },
        ],
      ],
    });
    const out = await main(["--prefix", "Convergence", "--repo", REPO], { source: b.source, identity: ID });
    expect(out.lines[1]).toBe("  #9050 demilestoned Convergence Phase 1 — by hornjason at 2026-11-18T13:00:00Z");
    expect(b.asked).toEqual([9001, 9050]);
  });

  test("round 3: the pipeline's first write was on an issue that has left the family; both hand edits are still named", async () => {
    // Pipeline writes on A (9060) at 10:30. A person moves A out at 11:00
    // and labels B (9061) at 11:30. The pipeline writes on B at 12:00. Only
    // B is in the family now.
    const b = board({
      milestones: [{ title: "Convergence Phase 1", issues: [9061] }],
      issues: [
        {
          number: 9060,
          events: [
            botMove("2026-11-18T10:30:00Z"),
            { __typename: "DemilestonedEvent", createdAt: "2026-11-18T11:00:00Z", actor: actor("hornjason"), milestoneTitle: "Convergence Phase 1" },
          ],
        },
        { number: 9061, events: [labeled("2026-11-18T11:30:00Z", actor("hornjason")), botMove("2026-11-18T12:00:00Z")] },
      ],
      repoEvents: [
        { event: "labeled", created_at: "2026-11-18T11:30:00Z", issue: { number: 9061 } },
        { event: "demilestoned", created_at: "2026-11-18T11:00:00Z", milestone: { title: "Convergence Phase 1" }, issue: { number: 9060 } },
        { event: "labeled", created_at: "2026-11-17T00:00:00Z", issue: { number: 1 } },
      ],
    });
    const out = await main(["--prefix", "Convergence", "--repo", REPO], { source: b.source, identity: ID });
    expect(out.code).toBe(HAND_EDITS_REFUSAL_EXIT);
    expect(out.lines.slice(1)).toEqual([
      "  #9060 demilestoned Convergence Phase 1 — by hornjason at 2026-11-18T11:00:00Z",
      "  #9061 labeled engine — by hornjason at 2026-11-18T11:30:00Z",
    ]);
  });

  test("an event feed that is not newest-first is refused, not read as ending on page 1", async () => {
    const b = board({
      milestones: [{ title: "Convergence Phase 1", issues: [9001] }],
      issues: [{ number: 9001, events: [botMove("2026-11-18T10:00:00Z")] }],
      repoEvents: [
        { event: "labeled", created_at: "2026-11-01T00:00:00Z", issue: { number: 1 } },
        { event: "demilestoned", created_at: "2026-11-18T13:00:00Z", milestone: { title: "Convergence Phase 1" }, issue: { number: 9050 } },
      ],
    });
    const out = await main(["--prefix", "Convergence", "--repo", REPO], { source: b.source, identity: ID });
    expect(out.code).toBe(HAND_EDITS_REFUSAL_EXIT);
    expect(out.lines[0]).toContain("not newest-first");
  });

  test("UNMEASURED, by name, for each read that did not happen", async () => {
    const run = (argv: string[], b: ReturnType<typeof board>, account: string | null = BOT, since: string | null = ID.since) =>
      main(argv, { source: b.source, identity: { account, since } });
    const ok = board({ milestones: [{ title: "Convergence Phase 1", issues: [9001] }], issues: [{ number: 9001, events: [botMove("t")] }] });

    const cases: [string, Promise<{ code: number; lines: string[] }>, string][] = [
      ["no flags", run([], ok), "--prefix and --repo are both required"],
      ["no account", run(["--prefix", "Convergence", "--repo", REPO], ok, null), "board.pipelineAccount"],
      ["no start", run(["--prefix", "Convergence", "--repo", REPO], ok, BOT, null), "board.pipelineSince"],
      [
        "no scope",
        run(["--prefix", "Convergence", "--repo", REPO], board({ milestones: [], issues: [], fail: "INSUFFICIENT_SCOPES read:project" })),
        "INSUFFICIENT_SCOPES read:project",
      ],
      ["no family", run(["--prefix", "Convergence", "--repo", REPO], board({ milestones: [{ title: "Engine Phase 1", issues: [1] }], issues: [] })), "no milestone belongs to the Convergence family"],
      [
        "window shut",
        run(
          ["--prefix", "Convergence", "--repo", REPO],
          board({ milestones: [{ title: "Convergence Phase 1", issues: [9001] }], issues: [{ number: 9001, events: [labeled("t", actor("hornjason"))] }] }),
        ),
        "no board write signed by rungate-bot",
      ],
      [
        "issue unreadable",
        run(["--prefix", "Convergence", "--repo", REPO], board({ milestones: [{ title: "Convergence Phase 1", issues: [9009] }], issues: [] })),
        "#9009 could not be read",
      ],
    ];
    for (const [name, p, says] of cases) {
      const out = await p;
      expect(out.code, name).toBe(HAND_EDITS_REFUSAL_EXIT);
      expect(out.lines[0], name).toContain("UNMEASURED");
      expect(out.lines[0], name).toContain(says);
    }
  });

  test("the refusal exit is one constant, written once, and non-zero", () => {
    const src = readFileSync(join(ROOT, "scripts", "hand-edits.ts"), "utf-8");
    expect(HAND_EDITS_REFUSAL_EXIT).not.toBe(0);
    expect(src.match(/HAND_EDITS_REFUSAL_EXIT = /g)).toHaveLength(1);
    expect(src).not.toMatch(/process\.exit\(\s*1\s*\)/);
  });
});

describe("#1722: the pipeline account comes from config, and absent is null", () => {
  test("set, trimmed; absent or blank is null", () => {
    const dir = (cfg: unknown) => {
      const d = mkdtempSync(join(tmpdir(), "rg-1722-config-"));
      scratch.push(d);
      mkdirSync(join(d, ".claude", "rungate"), { recursive: true });
      writeFileSync(join(d, ".claude", "rungate", "config.json"), JSON.stringify(cfg));
      return d;
    };
    expect(readPipelineAccount(dir({ board: { pipelineAccount: " rungate-bot " } }))).toBe("rungate-bot");
    expect(readPipelineAccount(dir({ board: {} }))).toBeNull();
    expect(readPipelineAccount(dir({ board: { pipelineAccount: "  " } }))).toBeNull();
    expect(readPipelineAccount(ROOT)).toBe("rungate-bot");
  });
});
