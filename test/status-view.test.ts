/**
 * #2097: the pinned "where we are" view — scripts/status-view.ts.
 *
 * Serves no criterion (the issue says so); these cases hold the properties
 * the issue's "How we will know" names: every section from a live reading,
 * UNMEASURED never rendered as empty, nothing in the renderer naming a
 * family, and the pinned issue never counting as covering a criterion.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NAMES_NONE, criteriaNamedBy } from "../lib/board-mirror";
import { ladderReport } from "../lib/work-status";
import {
  LIST_LIMIT,
  STATUS_MARKER,
  type StatusView,
  gather,
  otherFamilyLines,
  phaseBlurb,
  phaseLines,
  planLines,
  plain,
  publish,
  renderMarkdown,
  renderText,
  trustedAuthor,
  viewTitle,
} from "../scripts/status-view";

const ROOT = join(import.meta.dir, "..");

const read = <T>(value: T) => ({ kind: "READ" as const, value });
const gone = (why: string) => ({ kind: "UNMEASURED" as const, why });

function view(over: Partial<StatusView> = {}): StatusView {
  return {
    repo: "o/r",
    generatedAt: "2026-11-13T00:00:00Z",
    commit: "0123456789abcdef",
    family: "Engine",
    goal: read("A spec becomes a board."),
    stages: read([
      { id: "A", name: "Write it down", meaning: "the goal exists", state: "done", open: [], total: 2 },
      { id: "B", name: "Build", meaning: "the board exists", state: "next", open: ["B2"], total: 3 },
      { id: "C", name: "Ship", meaning: "it ships", state: "later", open: ["C1", "C2"], total: 2 },
    ]),
    phases: read([
      { number: 1, title: "Engine Phase 1 — a", meaning: "First.", open: 0, closed: 4, url: "u1", state: "done" },
      { number: 2, title: "Engine Phase 2 — b", meaning: null, open: 3, closed: 1, url: "u2", state: "current" },
    ]),
    otherFamilies: read([{ family: "Payload", phases: 2, open: 5, closed: 1 }]),
    inProgress: read([{ number: 7, title: "doing it", url: "i7", note: "someone" }]),
    ready: read([{ number: 8, title: "next up", url: "i8" }]),
    decisions: read([]),
    unphased: read([]),
    health: read([
      { name: "milestones", status: "met", measured: 3, target: 3 },
      { name: "criterion-coverage", status: "short", measured: 2, target: 3 },
    ]),
    links: [{ label: "Milestones", url: "https://github.com/o/r/milestones" }],
    ...over,
  };
}

describe("#2097: the plan section reads project-state.json through ladderReport", () => {
  test("the live plan: every stage's state agrees with its items and with ladderReport's next stage", () => {
    const text = readFileSync(join(ROOT, "project-state.json"), "utf-8");
    const doc = JSON.parse(text);
    const lines = planLines(text, "project-state.json");
    expect(lines.goal).toEqual(read(doc.goal.statement.trim()));
    if (lines.stages.kind !== "READ") throw new Error(lines.stages.why);
    expect(lines.stages.value.map(s => s.id)).toEqual(doc.stages.map((s: any) => s.id));
    const report = ladderReport(text, "project-state.json");
    if (report.kind !== "READ") throw new Error("the live plan is not well formed");
    for (const [i, s] of lines.stages.value.entries()) {
      const open = doc.stages[i].items.filter((it: any) => !it.done).map((it: any) => it.id);
      expect(s.open).toEqual(open);
      expect(s.state).toBe(open.length === 0 ? "done" : s.id === report.next ? "next" : "later");
    }
  });

  test("an unreadable or malformed plan is UNMEASURED in both sections, with the reason", () => {
    for (const [source, why] of [
      [null, "could not be read"],
      ["{ not json", "not valid JSON"],
    ] as const) {
      const lines = planLines(source, "project-state.json");
      expect(lines.goal.kind).toBe("UNMEASURED");
      expect(lines.stages.kind).toBe("UNMEASURED");
      expect(lines.stages.kind === "UNMEASURED" && lines.stages.why).toContain(why);
    }
  });
});

describe("#2097: phases come from the focus family's milestones and the spec's own words", () => {
  const SPEC = [
    "## Phases",
    "### Phase 6 — the board's state is a reading",
    "",
    "Phases 0-5 are about the machinery. This one is about its output.",
    "A third sentence that would push past a tight limit.",
    "",
    "Second paragraph, never read.",
    "### Phase 7 — nothing is hand-run",
    "### Phase 8 — empty",
    "",
  ].join("\n");

  test("phaseBlurb takes whole sentences of the first paragraph, within the limit", () => {
    expect(phaseBlurb(SPEC, 6)).toBe(
      "Phases 0-5 are about the machinery. This one is about its output. A third sentence that would push past a tight limit.",
    );
    expect(phaseBlurb(SPEC, 6, 70)).toBe("Phases 0-5 are about the machinery. This one is about its output.");
    expect(phaseBlurb(SPEC, 6, 5), "at least one sentence, however tight").toBe("Phases 0-5 are about the machinery.");
    expect(phaseBlurb(SPEC, 7), "a heading straight into another heading has no blurb").toBeNull();
    expect(phaseBlurb(SPEC, 9)).toBeNull();
  });

  test("a full stop inside a word is not a sentence end", () => {
    // Live on 2026-11-13, Phase 2 rendered as "md rule 4." — the splitter
    // dropped everything up to the dot in "AGENTS.md".
    const spec = "### Phase 2 — order\n\nPer AGENTS.md rule 4, order is data. More after.\n";
    expect(phaseBlurb(spec, 2, 40)).toBe("Per AGENTS.md rule 4, order is data.");
  });

  test("phaseLines keeps only the focus family, in phase order, and marks done / current / later", () => {
    const ms = [
      { title: "Engine Phase 7 — later", open: 2, closed: 0, url: "u7" },
      { title: "Payload Phase 1 — other", open: 1, closed: 0, url: "p1" },
      { title: "Engine Phase 6 — now", open: 3, closed: 5, url: "u6" },
      { title: "Engine Phase 5 — done", open: 0, closed: 2, url: "u5" },
      { title: "Engine Phase 4 — empty", open: 0, closed: 0, url: "u4" },
      { title: "Phase 1 — unprefixed", open: 1, closed: 0, url: "x" },
      { title: "Not a phase", open: 1, closed: 0, url: "y" },
    ];
    const lines = phaseLines(ms, "Engine", SPEC);
    expect(lines.map(l => [l.number, l.state])).toEqual([
      [4, "empty"],
      [5, "done"],
      [6, "current"],
      [7, "later"],
    ]);
    expect(lines[2].meaning).toContain("about its output");
    // An empty milestone is not a finished one: no tick, and no "0 of 0 done".
    const md = renderMarkdown(view({ phases: read(lines) }));
    expect(md).toContain("– [Engine Phase 4 — empty](u4) — no issues");
    expect(md).not.toContain("0 of 0");
    expect(otherFamilyLines(ms, "Engine")).toEqual([{ family: "Payload", phases: 1, open: 1, closed: 0 }]);
  });
});

describe("#2097: what the pinned issue says", () => {
  test("the body starts with the marker, says it serves no criterion, and every section is there", () => {
    const md = renderMarkdown(view());
    expect(md.startsWith(STATUS_MARKER)).toBe(true);
    expect(md).toContain(NAMES_NONE);
    for (const h of ["The goal", "The finish line", "Phases (Engine)", "Other work", "In progress", "Ready next", "Needs a decision", "Unphased", "Health", "Links"]) {
      expect(md).toContain(`### ${h}`);
    }
    expect(md).toContain("✓ **A** Write it down");
    expect(md).toContain("● **B** Build: the board exists — 1 of 3 left: B2");
    expect(md).toContain("[Engine Phase 2 — b](u2) — 1 of 4 done");
    expect(md).toContain("board checks: 1 of 2 met");
    expect(md).toContain("SHORT criterion-coverage: 2 of 3");
  });

  test("an UNMEASURED section says so with its reason, and never prints the empty-list sentence", () => {
    const md = renderMarkdown(view({ inProgress: gone("gh exited 1: bad credentials"), ready: gone("no board") }));
    expect(md).toContain("UNMEASURED — gh exited 1: bad credentials");
    expect(md).toContain("UNMEASURED — no board");
    expect(md).not.toContain("nothing is assigned or in a pull request");
    expect(md).not.toContain("nothing is in Ready");
    // CONTROL: read and empty is the sentence, not UNMEASURED.
    expect(renderMarkdown(view({ ready: read([]) }))).toContain("nothing is in Ready");
  });

  test("the family is whatever config says — nothing in the renderer names one", () => {
    expect(renderMarkdown(view({ family: "Convergence" }))).toContain("### Phases (Convergence)");
    expect(viewTitle("Convergence")).toBe("Where we are: Convergence");
    expect(viewTitle(null)).toBe("Where we are");
    const src = readFileSync(join(ROOT, "scripts", "status-view.ts"), "utf-8");
    for (const name of ["Pipeline", "Convergence", "SPEC-TO-BOARD", "hornjason"]) {
      expect(src.includes(name), `the renderer names ${name}`).toBe(false);
    }
  });

  test("a long list stops at the limit and says how many more", () => {
    const many = Array.from({ length: LIST_LIMIT + 3 }, (_, i) => ({ number: i + 1, title: `t${i}`, url: `u${i}` }));
    const md = renderMarkdown(view({ unphased: read(many) }));
    expect(md).toContain("… and 3 more");
    expect(md).not.toContain(`#${LIST_LIMIT + 1}]`);
  });

  test("titles cannot mention, link, inject markup — or make the pinned issue name a criterion", () => {
    const hostile = "@someone [click](http://x) <img src=x> SC-2752 and CRC-E5";
    expect(plain(hostile)).not.toMatch(/@someone/);
    expect(plain(hostile)).not.toContain("[click](");
    expect(plain(hostile)).not.toContain("<img");
    const md = renderMarkdown(
      view({
        inProgress: read([{ number: 1, title: hostile, url: "u" }]),
        phases: read([{ number: 6, title: "Engine Phase 6 — x", meaning: "Serves SC-2752.", open: 1, closed: 0, url: "u", state: "current" }]),
      }),
    );
    // The real reader `criteria-named` and criterion-coverage use, over the real body.
    expect(criteriaNamedBy({ title: viewTitle("Engine"), body: md }, ["SC-2752", "CRC-E5"])).toEqual([]);
    // CONTROL: the same reader does see the raw title.
    expect(criteriaNamedBy({ title: "x", body: hostile }, ["SC-2752", "CRC-E5"])).toEqual(["SC-2752", "CRC-E5"]);
  });

  test("the terminal text carries the same sections with no markup", () => {
    const text = renderText(view());
    expect(text).toContain("The finish line");
    expect(text).toContain("● B Build: the board exists — 1 of 3 left: B2");
    expect(text).not.toContain("**");
    expect(text).not.toContain("](");
    expect(text).not.toContain(STATUS_MARKER);
  });
});

describe("#2097: gather — a tree where nothing can be read renders every section UNMEASURED", () => {
  test("no plan, no config, and a GitHub that refuses: UNMEASURED everywhere, never an empty list", () => {
    const dir = mkdtempSync(join(tmpdir(), "status-view-gather-"));
    try {
      const refuse = () => ({ ok: false as const, why: "gh exited 1: HTTP 401" });
      const v = gather(dir, "o/r", refuse, new Date("2026-11-13T00:00:00Z"), () => gone("not run in this case"));
      for (const k of ["goal", "stages", "phases", "otherFamilies", "inProgress", "ready", "decisions", "unphased", "health"] as const) {
        expect(v[k].kind, `${k} read as if it had been measured`).toBe("UNMEASURED");
      }
      const md = renderMarkdown(v);
      expect(md).not.toContain("nothing is");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#2097: publish writes only the marked pinned issue", () => {
  type Call = string[];
  const fake = (
    pinned: unknown,
    fail: Partial<Record<string, string>> = {},
    open: { number: number; body: string }[] = [],
  ) => {
    const calls: Call[] = [];
    const gh = (args: string[]) => {
      calls.push(args);
      const key = args[0] === "api" ? (args[1] === "graphql" ? "graphql" : "open issues") : `${args[0]} ${args[1]}`;
      if (fail[key]) return { ok: false as const, why: fail[key]! };
      if (key === "graphql") return { ok: true as const, out: JSON.stringify(pinned) };
      if (key === "open issues") return { ok: true as const, out: open.map(o => JSON.stringify(o)).join("\n") };
      if (key === "issue create") return { ok: true as const, out: "https://github.com/o/r/issues/42\n" };
      return { ok: true as const, out: "" };
    };
    return { gh, calls };
  };
  const pinnedWith = (...issues: { number: number; body: string }[]) => ({
    data: { repository: { pinnedIssues: { nodes: issues.map(issue => ({ issue })) } } },
  });
  const body = `${STATUS_MARKER}\nhello\n`;

  test("the pinned issue carrying the marker is edited, and no other", () => {
    const { gh, calls } = fake(pinnedWith({ number: 5, body: "someone else's pin" }, { number: 9, body: `${STATUS_MARKER}\nold` }));
    expect(publish(body, "o/r", "Where we are: Engine", gh)).toEqual({ ok: true, message: "updated #9" });
    expect(calls.filter(c => c[0] === "issue").map(c => c.slice(0, 3))).toEqual([["issue", "edit", "9"]]);
  });

  test("no marked pin: create, then pin; a pin the token cannot make still writes, and says so", () => {
    const made = fake(pinnedWith());
    expect(publish(body, "o/r", "t", made.gh)).toEqual({ ok: true, message: "created and pinned #42" });
    const noPin = fake(pinnedWith(), { "issue pin": "gh issue exited 1: forbidden" });
    const r = publish(body, "o/r", "t", noPin.gh);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("could not be pinned");
  });

  test("a body without the marker, or pins that cannot be read, refuses before any write", () => {
    const a = fake(pinnedWith());
    expect(publish("no marker", "o/r", "t", a.gh).ok).toBe(false);
    expect(a.calls).toEqual([]);
    const b = fake(null, { graphql: "gh api exited 1: HTTP 502" });
    const r = publish(body, "o/r", "t", b.gh);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("UNMEASURED");
    expect(b.calls.some(c => c[0] === "issue")).toBe(false);
  });
});

describe("#2097 review round 2", () => {
  const body = `${STATUS_MARKER}\nhello\n`;
  const pinnedNone = { data: { repository: { pinnedIssues: { nodes: [] } } } };
  const fakeGh = (open: { number: number; body: string; login: string; association: string }[], pinFails = false) => {
    const calls: string[][] = [];
    const gh = (args: string[]) => {
      calls.push(args);
      if (args[0] === "api" && args[1] === "graphql") return { ok: true as const, out: JSON.stringify(pinnedNone) };
      if (args[0] === "api") return { ok: true as const, out: open.map(o => JSON.stringify(o)).join("\n") };
      if (args[0] === "issue" && args[1] === "pin" && pinFails) return { ok: false as const, why: "gh issue exited 1: pin limit" };
      if (args[0] === "issue" && args[1] === "create") return { ok: true as const, out: "https://github.com/o/r/issues/42\n" };
      return { ok: true as const, out: "" };
    };
    return { gh, calls };
  };

  test("an unpinned status issue is found by its marker and reused, never a second one created", () => {
    // Review: a pin that failed once made every later run create another issue.
    const { gh, calls } = fakeGh(
      [
        { number: 3, body: "someone else's", login: "x", association: "NONE" },
        { number: 77, body: `${STATUS_MARKER}\nold`, login: "github-actions[bot]", association: "NONE" },
      ],
      true,
    );
    const r = publish(body, "o/r", "t", gh);
    expect(r.ok).toBe(true);
    expect(calls.filter(c => c[0] === "issue").map(c => c.slice(0, 3))).toEqual([
      ["issue", "edit", "77"],
      ["issue", "pin", "77"],
    ]);
    expect(calls.some(c => c[1] === "create")).toBe(false);
    // The warning is an annotation GitHub reads: on its own line.
    expect(r.message.split("\n").some(l => l.startsWith("::warning"))).toBe(true);
  });

  test("a marker issue a stranger opened is never reused or pinned; a new one is created instead", () => {
    // Security review of #2103: the marker is text anyone can type.
    const { gh, calls } = fakeGh([{ number: 66, body: `${STATUS_MARKER}\nbait`, login: "stranger", association: "NONE" }]);
    expect(publish(body, "o/r", "t", gh).message).toContain("#42");
    expect(calls.some(c => c[0] === "issue" && c[2] === "66")).toBe(false);
    expect(calls.filter(c => c[0] === "issue").map(c => c.slice(0, 2))).toEqual([
      ["issue", "create"],
      ["issue", "pin"],
    ]);
    // A maintainer's issue is trusted; so is the workflow's own bot.
    expect(trustedAuthor("hornjason", "OWNER")).toBe(true);
    expect(trustedAuthor("github-actions[bot]", "NONE")).toBe(true);
    expect(trustedAuthor("stranger", "CONTRIBUTOR")).toBe(false);
  });

  test("Other work, read and empty, still shows its heading and says so", () => {
    const md = renderMarkdown(view({ otherFamilies: read([]) }));
    expect(md).toContain("### Other work");
    expect(md).toContain("no other milestone family");
  });

  test("the board's link is the address the API returns, and UNMEASURED when it cannot be read", () => {
    const org = renderMarkdown(view({ links: [{ label: "The board", url: "https://github.com/orgs/acme/projects/4" }] }));
    expect(org).toContain("[The board](https://github.com/orgs/acme/projects/4)");
    const unread = renderMarkdown(view({ links: [{ label: "The board", url: null, why: "this token cannot see the project" }] }));
    expect(unread).toContain("The board — UNMEASURED: this token cannot see the project");
    const src = readFileSync(join(ROOT, "scripts", "status-view.ts"), "utf-8");
    expect(src, "the board's address is built from config, which cannot tell a user from an organisation").not.toContain(
      "github.com/users/",
    );
  });
});
