/**
 * Covers SC-2608, SC-2779 (SPEC-TO-BOARD-PIPELINE-SPEC.md).
 *
 * `lib/issue-repair.ts` and `scripts/plan-issues.ts --repair` (#1647).
 *
 * ## The write cases assert on the CALLS
 *
 * `plan-spec` shipped a refusal computed after its write loop: the mutations
 * went out and the exit code then said the run had been refused. Nothing
 * reading an exit code can tell that apart from a refusal that stopped
 * something, so every negative case below records what reached GitHub.
 *
 * ## And the demotion cases assert on the ORDER of those calls
 *
 * A demotion removes the issue's edges and then clears its milestone. If the
 * clear ran first and the removal then failed, the issue would already be out
 * of its phase and nothing could still work out which edges to remove — not a
 * re-run of this command, not `plan-deps`, which never removes an edge at all.
 * A test asserting only the SET of calls is green against that ordering bug.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CRITERIA_HEADING,
  alreadyAnnotated,
  annotatedBody,
  headingOccurrences,
  issuePlacement,
  multiplyAnnotated,
  parseRepairPlan,
} from "../lib/issue-repair";
import type { PlacingFamily } from "../lib/issue-repair";
import { REFUSAL_EXIT, issueTitleMap, main as planIssuesMain } from "../scripts/plan-issues";
import { PLAN_BOT_LOGIN, PLANNED_ISSUE_FOOTER } from "../lib/issue-decomposition";
import { WORKFLOW_BOT_LOGIN } from "../lib/github";
import type { IssueState, PlaceGitHub, PlanIssuesGitHub } from "../scripts/plan-issues";

/** A plan document: a header, then the rows given. */
function plan(rows: string[]): string {
  return [
    "# A repair plan",
    "",
    "| Issue | Phase | Repair | Criteria | Confidence | Why |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    "## After",
  ].join("\n");
}

const ANNOTATE = "| #10 | 1 | (a) | `CRC-N2` | HIGH | because |";
const DEMOTE = "| #20 | 5 | **(b)** | — | HIGH | machinery |";

/**
 * #2042: the family `Fam`, its spec, and the milestones the tracker carries.
 * `ZZ-<N>` ids are a namespace no spec uses. Phase 7 is placed in the spec
 * and has no milestone, which is the refusal case.
 */
const FAMILY_SPEC = [
  "# Fam",
  "",
  "### Phase 5 — earlier",
  "### Phase 6 — the one",
  "### Phase 7 — unbuilt",
  "",
  "- [ ] ZZ-1: lib/a.ts contains [a] — first",
  "- [ ] ZZ-2: lib/b.ts contains [b] — second",
  "- [ ] ZZ-3: lib/c.ts contains [c] — third",
  "- [ ] ZZ-4: lib/d.ts contains [d] — fourth, blocked",
  "",
  "### Phase placement",
  "",
  "| Placement | Criteria | What |",
  "|---|---|---|",
  "| **Phase 5** | ZZ-2 | earlier |",
  "| **Phase 6** | ZZ-1 | the one |",
  "| **Phase 7** | ZZ-3 | unbuilt |",
  "| **Blocked — needs a second person** | ZZ-4 | no phase |",
  "",
  "## After",
].join("\n");
const LIVE_MILESTONES = [
  { number: 1, title: "Fam Phase 5 — earlier", description: null },
  { number: 2, title: "Fam Phase 6 — the one", description: null },
  { number: 3, title: "Other Phase 6 — elsewhere", description: null },
];

describe("lib/issue-repair: the plan parses, and only the plan's table", () => {
  test("an (a) row is annotate with its ids, a (b) row is demote with none", () => {
    const r = parseRepairPlan(plan([ANNOTATE, DEMOTE]));
    expect(r.reading).toBe("MEASURED");
    expect(r.rows.map(x => `${x.issue}:${x.kind}:${x.criteria.join("+")}`)).toEqual([
      "10:annotate:CRC-N2",
      "20:demote:",
    ]);
  });

  test("several ids in one cell all parse, in document order", () => {
    const r = parseRepairPlan(plan(["| #11 | 2 | (a) | `CRC-B3`, `CRC-B4` | MEDIUM | x |"]));
    expect(r.rows[0].criteria).toEqual(["CRC-B3", "CRC-B4"]);
  });

  test("a table that is not THIS table is not read", () => {
    const other = "| Name | Thing |\n|---|---|\n| #10 | whatever |";
    expect(parseRepairPlan(other).reading).toBe("UNMEASURED");
    // The pair: the same document with the real header IS read.
    expect(parseRepairPlan(plan([ANNOTATE])).reading).toBe("MEASURED");
  });

  test("prose after the table ends it — a later pipe row is not a repair", () => {
    const withTrailer = plan([ANNOTATE]) + "\n| #99 | 9 | (a) | `CRC-Z9` | HIGH | elsewhere |";
    expect(parseRepairPlan(withTrailer).rows.map(r => r.issue)).toEqual([10]);
  });
});

describe("lib/issue-repair: a row it cannot read is a REJECTION, not a skip", () => {
  const cases: [string, string, string][] = [
    ["an unknown repair kind", "| #10 | 1 | (z) | `CRC-N2` | HIGH | x |", "neither (a) nor (b)"],
    ["an (a) naming no criterion", "| #10 | 1 | (a) | — | HIGH | x |", "(a) names no criterion"],
    ["a (b) naming a criterion", "| #10 | 1 | (b) | `CRC-N2` | HIGH | x |", "disagree"],
    ["no issue number", "| none | 1 | (a) | `CRC-N2` | HIGH | x |", "no #<number>"],
    ["a non-numeric phase", "| #10 | one | (a) | `CRC-N2` | HIGH | x |", "is not a number"],
  ];
  for (const [name, row, why] of cases) {
    test(`${name} is rejected by name, and the whole plan is UNMEASURED`, () => {
      const r = parseRepairPlan(plan([row]));
      expect(r.reading).toBe("UNMEASURED");
      expect(r.rejected.map(x => x.why).join(" ")).toContain(why);
      expect(r.rows).toEqual([]);
    });
  }

  test("ONE bad row refuses the whole plan, including the good rows beside it", () => {
    // A partly-unreadable plan is not a partly-done plan. Without this, a
    // typo in row 7 quietly applies rows 1-6 and nobody is told.
    const r = parseRepairPlan(plan([ANNOTATE, "| #11 | 2 | (z) | `CRC-B3` | HIGH | x |"]));
    expect(r.reading).toBe("UNMEASURED");
    expect(r.rows.map(x => x.issue)).toEqual([10]);
    expect(r.unmeasuredReasons.join(" ")).toContain("partly unreadable");
  });

  test("the same issue twice is UNMEASURED, naming both lines", () => {
    const r = parseRepairPlan(plan([ANNOTATE, ANNOTATE]));
    expect(r.reading).toBe("UNMEASURED");
    expect(r.unmeasuredReasons.join(" ")).toContain("#10 appears twice");
  });
});

describe("lib/issue-repair: the body edit is append-or-replace, never stack", () => {
  test("an absent section is appended and the original body survives intact", () => {
    const out = annotatedBody("## The measurement\n\nThree runs disagreed.", ["CRC-B3"]);
    expect(out).toContain("Three runs disagreed.");
    expect(out).toContain(`${CRITERIA_HEADING}\n\nCRC-B3`);
  });

  test("a present section is REPLACED, so a corrected plan converges", () => {
    const once = annotatedBody("Body.", ["CRC-B3"]);
    const twice = annotatedBody(once, ["CRC-B4"]);
    expect(twice).toContain("CRC-B4");
    expect(twice).not.toContain("CRC-B3");
    expect([...twice.matchAll(/## Criteria this serves/g)]).toHaveLength(1);
  });

  test("a section followed by another heading keeps that heading", () => {
    const body = `Intro.\n\n${CRITERIA_HEADING}\n\nCRC-B3\n\n## How we will know\n\nA test.`;
    const out = annotatedBody(body, ["CRC-B4"]);
    expect(out).toContain("## How we will know");
    expect(out).toContain("A test.");
    expect(out).not.toContain("CRC-B3");
  });

  test("applying the same row twice is a no-op, which is what makes --write re-runnable", () => {
    const once = annotatedBody("Body.", ["CRC-B3", "CRC-B4"]);
    expect(alreadyAnnotated(once, ["CRC-B3", "CRC-B4"])).toBe(true);
    expect(annotatedBody(once, ["CRC-B3", "CRC-B4"])).toBe(once);
    expect(alreadyAnnotated(once, ["CRC-B6"])).toBe(false);
  });
});

/**
 * The four findings from this PR's security review, each with the case that
 * would have caught it. All four were real; none was dismissed.
 */
describe("lib/issue-repair: the heading locator is anchored and fence-aware", () => {
  test("the phrase inside a ``` fence is NOT the section — the body survives", () => {
    // These bodies quote shell and TypeScript constantly. An unanchored
    // `indexOf` would treat this as the section and replace everything from
    // it to the next heading, destroying the measurement below it.
    const body = [
      "## The measurement",
      "",
      "```md",
      CRITERIA_HEADING,
      "```",
      "",
      "Three runs disagreed: CLEAN, BLOCKED, CLEAN.",
    ].join("\n");
    const out = annotatedBody(body, ["CRC-B3"]);
    expect(out).toContain("Three runs disagreed: CLEAN, BLOCKED, CLEAN.");
    expect(out).toContain("```md");
    // Appended at the end, not spliced over the fence.
    expect(out.trimEnd().endsWith("CRC-B3")).toBe(true);
    expect(headingOccurrences(body)).toEqual([]);
  });

  test("the phrase mid-sentence is not the section either", () => {
    const body = `Someone should add a ${CRITERIA_HEADING} section here.\n\nAnd keep this.`;
    const out = annotatedBody(body, ["CRC-B3"]);
    expect(out).toContain("And keep this.");
    expect(headingOccurrences(body)).toEqual([]);
  });

  test("a real heading at the start of a line IS found", () => {
    // The pair: without it the two cases above pass against a locator that
    // never matches anything at all.
    const body = `Intro.\n\n${CRITERIA_HEADING}\n\nCRC-B3\n`;
    expect(headingOccurrences(body)).toHaveLength(1);
    expect(multiplyAnnotated(body)).toBe(false);
  });

  test("two sections are refused, not silently half-edited", () => {
    const body = `${CRITERIA_HEADING}\n\nCRC-B3\n\n## Mid\n\n${CRITERIA_HEADING}\n\nCRC-B6\n`;
    expect(headingOccurrences(body)).toHaveLength(2);
    expect(multiplyAnnotated(body)).toBe(true);
  });
});

describe("scripts/plan-issues --repair: what reaches GitHub", () => {
  function spy(state: Record<number, Partial<IssueState>>) {
    const calls: string[] = [];
    const gh: PlanIssuesGitHub = {
      readIssue: async (_r, number) => ({
        number,
        body: "Body.",
        milestone: `Convergence Phase 5 — x`,
        blockedBy: [],
        blocking: [],
        ...state[number],
      }),
      setBody: async (_r, n, b) => void calls.push(`body#${n}:${b.includes("CRC") ? "withIds" : "noIds"}`),
      clearMilestone: async (_r, n) => void calls.push(`milestone#${n}`),
      removeBlockedBy: async (_r, blocked, blocker) => void calls.push(`edge-${blocked}<-${blocker}`),
      milestones: async () => LIVE_MILESTONES,
      setMilestone: async (_r, n, title) => void calls.push(`place#${n}:${title}`),
    };
    return { gh, calls };
  }

  async function run(rows: string[], gh: PlanIssuesGitHub, extra: string[] = []) {
    const dir = mkdtempSync(join(tmpdir(), "rg-plan-issues-"));
    try {
      writeFileSync(join(dir, "PLAN.md"), plan(rows));
      return await planIssuesMain(
        ["--repair", "PLAN.md", "--repo", "o/r", "--project-root", dir, ...extra],
        gh,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("an (a) row writes the body and touches nothing else", async () => {
    const s = spy({});
    expect(await run([ANNOTATE], s.gh, ["--write"])).toBe(0);
    expect(s.calls).toEqual(["body#10:withIds"]);
  });

  test("a (b) row removes every orphaned edge AND clears the milestone", async () => {
    const s = spy({ 20: { blockedBy: [7, 8], blocking: [30, 31] } });
    await run([DEMOTE], s.gh, ["--write"]);
    expect(s.calls).toEqual([
      "edge-20<-7",
      "edge-20<-8",
      "edge-30<-20",
      "edge-31<-20",
      "milestone#20",
    ]);
  });

  test("the edges come out BEFORE the milestone — order, not just membership", async () => {
    // If the clear ran first and a removal then failed, the issue would be
    // out of its phase with nothing able to work out what to remove.
    const s = spy({ 20: { blocking: [30] } });
    await run([DEMOTE], s.gh, ["--write"]);
    expect(s.calls.indexOf("edge-30<-20")).toBeLessThan(s.calls.indexOf("milestone#20"));
  });

  test("an issue BLOCKING others has those edges removed from the OTHER issue", async () => {
    // The live shape: #1395 blocks six Phase 6 issues, and the edge lives on
    // each of those six, not on #1395. Removing it from #1395 is a no-op that
    // leaves Phase 6 blocked forever.
    const s = spy({ 20: { blocking: [30, 31] } });
    await run([DEMOTE], s.gh, ["--write"]);
    expect(s.calls).toContain("edge-30<-20");
    expect(s.calls).not.toContain("edge-20<-30");
  });

  test("a body that already names the ids is unchanged — re-running writes nothing", async () => {
    const s = spy({ 10: { body: annotatedBody("Body.", ["CRC-N2"]) } });
    expect(await run([ANNOTATE], s.gh, ["--write"])).toBe(0);
    expect(s.calls).toEqual([]);
  });

  test("an issue already out of a milestone is unchanged — no edge is removed twice", async () => {
    const s = spy({ 20: { milestone: null, blocking: [30] } });
    await run([DEMOTE], s.gh, ["--write"]);
    expect(s.calls).toEqual([]);
  });

  test("without --write NOTHING is called, on a plan that would do both", async () => {
    const s = spy({ 20: { blocking: [30] } });
    expect(await run([ANNOTATE, DEMOTE], s.gh)).toBe(0);
    expect(s.calls).toEqual([]);
  });

  test("ONE unreadable row writes nothing at all, including the good row's body", async () => {
    const s = spy({});
    const code = await run([ANNOTATE, "| #11 | 2 | (z) | `CRC-B3` | HIGH | x |"], s.gh, ["--write"]);
    expect(s.calls, "a good row was applied from a plan that could not be fully read").toEqual([]);
    expect(code).toBe(REFUSAL_EXIT);
  });

  test("a missing plan file refuses before reading any issue", async () => {
    const s = spy({});
    expect(await planIssuesMain(["--repair", "/nope/PLAN.md", "--repo", "o/r", "--write"], s.gh)).toBe(
      REFUSAL_EXIT,
    );
    expect(s.calls).toEqual([]);
  });

  test("a FAILED action exits non-zero — status is derived from what happened", async () => {
    // The first version printed the status BEFORE calling apply(), whose
    // per-action catch swallowed every error into a string nothing read. A
    // run that failed on every row reported "yes" and exited 0.
    const calls: string[] = [];
    const gh: PlanIssuesGitHub = {
      readIssue: async (_r, number) => ({ number, body: "Body.", milestone: "Convergence Phase 5 — x", blockedBy: [], blocking: [] }),
      setBody: async () => { throw new Error("gh refused"); },
      clearMilestone: async (_r, n) => void calls.push(`milestone#${n}`),
      removeBlockedBy: async () => {},
      milestones: async () => [],
      setMilestone: async () => {},
    };
    const dir = mkdtempSync(join(tmpdir(), "rg-fail-"));
    try {
      writeFileSync(join(dir, "PLAN.md"), plan([ANNOTATE]));
      const code = await planIssuesMain(["--repair","PLAN.md","--repo","o/r","--project-root",dir,"--write"], gh);
      expect(code, "a run whose only action FAILED reported success").toBe(REFUSAL_EXIT);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("--json reports `partial` when an action FAILED — not `yes`", async () => {
    // The exit code and the printed status are two separate expressions. A
    // mutant that fixes `wrote` at "yes" while leaving the return correct was
    // green against every other case here: the refusal cases never reach
    // apply(), so they exercise the `refused` branch and not this one.
    const out: string[] = [];
    const log = console.log;
    console.log = (x: string) => void out.push(x);
    const gh: PlanIssuesGitHub = {
      readIssue: async (_r, number) => ({ number, body: "Body.", milestone: null, blockedBy: [], blocking: [] }),
      setBody: async () => { throw new Error("gh refused"); },
      clearMilestone: async () => {},
      removeBlockedBy: async () => {},
      milestones: async () => [],
      setMilestone: async () => {},
    };
    const dir = mkdtempSync(join(tmpdir(), "rg-partial-"));
    let code;
    try {
      writeFileSync(join(dir, "PLAN.md"), plan([ANNOTATE]));
      code = await planIssuesMain(
        ["--repair", "PLAN.md", "--repo", "o/r", "--project-root", dir, "--write", "--json"],
        gh,
      );
    } finally {
      console.log = log;
      rmSync(dir, { recursive: true, force: true });
    }
    const json = JSON.parse(out.join("\n"));
    expect(json.wrote, "a run whose only action FAILED printed a clean status").toBe("partial");
    expect(json.results.join(" ")).toContain("FAILED");
    expect(code).toBe(REFUSAL_EXIT);
  });

  test("a body with TWO sections is refused, and exits non-zero", async () => {
    const twice = `${CRITERIA_HEADING}\n\nCRC-B3\n\n## Mid\n\n${CRITERIA_HEADING}\n\nCRC-B6\n`;
    const s = spy({ 10: { body: twice } });
    const code = await run([ANNOTATE], s.gh, ["--write"]);
    expect(s.calls, "a body with two sections was edited anyway").toEqual([]);
    expect(code).toBe(REFUSAL_EXIT);
  });

  test("the body reaches setBody whole — no file, no truncation", async () => {
    // The first version wrote it to a predictable /tmp path with an
    // unawaited Bun.write and handed gh the path. What gh read was whatever
    // had landed. This asserts the full text crosses the seam.
    const bodies: string[] = [];
    const gh: PlanIssuesGitHub = {
      readIssue: async (_r, number) => ({ number, body: "A".repeat(5000), milestone: null, blockedBy: [], blocking: [] }),
      setBody: async (_r, _n, b) => void bodies.push(b),
      clearMilestone: async () => {},
      removeBlockedBy: async () => {},
      milestones: async () => [],
      setMilestone: async () => {},
    };
    const dir = mkdtempSync(join(tmpdir(), "rg-whole-"));
    try {
      writeFileSync(join(dir, "PLAN.md"), plan([ANNOTATE]));
      await planIssuesMain(["--repair","PLAN.md","--repo","o/r","--project-root",dir,"--write"], gh);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    expect(bodies).toHaveLength(1);
    expect(bodies[0].length).toBeGreaterThan(5000);
    expect(bodies[0]).toContain("A".repeat(5000));
    expect(bodies[0]).toContain("CRC-N2");
  });

  test("--json --write reports `yes`, and `refused` on an unreadable plan", async () => {
    const out: string[] = [];
    const log = console.log;
    console.log = (x: string) => void out.push(x);
    const good = spy({});
    const bad = spy({});
    let badCode;
    try {
      await run([ANNOTATE], good.gh, ["--write", "--json"]);
      const first = out.length;
      badCode = await run(["| #10 | 1 | (z) | `CRC-N2` | HIGH | x |"], bad.gh, ["--write", "--json"]);
      expect(JSON.parse(out.slice(0, first).join("\n")).wrote).toBe("yes");
      expect(JSON.parse(out.slice(first).join("\n")).wrote).toBe("refused");
    } finally {
      console.log = log;
    }
    expect(good.calls).toEqual(["body#10:withIds"]);
    expect(bad.calls).toEqual([]);
    expect(badCode).toBe(REFUSAL_EXIT);
  });
});

/**
 * #2042: `--repair --milestone-prefix <family> --spec <family spec>` places
 * each row's issue in the phase milestone the family's spec puts its
 * criterion in. Opt-in per family (Jason, 2026-11-13): a table mixing
 * families, like ADR-015's, moves only the named family's rows.
 */
describe("#2042: --repair places a milestone from the Phase column, per family", () => {
  function spy(state: Record<number, Partial<IssueState>> = {}) {
    const calls: string[] = [];
    const gh: PlanIssuesGitHub = {
      readIssue: async (_r, number) => ({ number, body: "Body.", milestone: null, blockedBy: [], blocking: [], ...state[number] }),
      setBody: async (_r, n) => void calls.push(`body#${n}`),
      clearMilestone: async (_r, n) => void calls.push(`clear#${n}`),
      removeBlockedBy: async () => {},
      milestones: async () => LIVE_MILESTONES,
      setMilestone: async (_r, n, title) => void calls.push(`place#${n}:${title}`),
    };
    return { gh, calls };
  }

  async function run(rows: string[], gh: PlanIssuesGitHub, extra: string[], spec = FAMILY_SPEC) {
    const dir = mkdtempSync(join(tmpdir(), "rg-plan-issues-2042-"));
    const out: string[] = [];
    const log = console.log;
    const err = console.error;
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    console.error = (...a: unknown[]) => void out.push(a.join(" "));
    try {
      mkdirSync(join(dir, "specs"));
      writeFileSync(join(dir, "specs", "FAM-SPEC.md"), spec);
      writeFileSync(join(dir, "PLAN.md"), plan(rows));
      const code = await planIssuesMain(["--repair", "PLAN.md", "--repo", "o/r", "--project-root", dir, ...extra], gh);
      return { code, out: out.join("\n") };
    } finally {
      console.log = log;
      console.error = err;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const FAMILY = ["--milestone-prefix", "Fam", "--spec", "specs/FAM-SPEC.md"];
  const IN_FAMILY = "| #10 | 6 | (a) | `ZZ-1` | HIGH | placed in Phase 6 |";
  const OTHER_FAMILY = "| #11 | 6 | (a) | `CRC-N2` | HIGH | another family's criterion |";

  test("a row whose criterion the family spec places in Phase 6 moves into that milestone", async () => {
    const s = spy();
    const r = await run([IN_FAMILY], s.gh, [...FAMILY, "--write"]);
    expect(r.code, r.out).toBe(0);
    expect(s.calls).toEqual(["body#10", "place#10:Fam Phase 6 — the one"]);
  });

  test("another family's row in the same table is left alone, and says why", async () => {
    // The family filter. Placing every row from its Phase column alone would
    // move #11 into `Fam Phase 6` too, which is ADR-015's #1355 case.
    const s = spy();
    const r = await run([IN_FAMILY, OTHER_FAMILY], s.gh, [...FAMILY, "--write"]);
    expect(r.code, r.out).toBe(0);
    expect(s.calls.filter(c => c.startsWith("place#"))).toEqual(["place#10:Fam Phase 6 — the one"]);
    expect(r.out).toContain("#11");
    expect(r.out).toMatch(/#11 .*not placed in a Fam phase/);
  });

  test("a phase with no milestone refuses the run before anything is written", async () => {
    const s = spy();
    const r = await run([IN_FAMILY, "| #12 | 7 | (a) | `ZZ-3` | HIGH | Phase 7 has no milestone |"], s.gh, [...FAMILY, "--write"]);
    expect(r.code).toBe(REFUSAL_EXIT);
    expect(s.calls, "a write went out from a run that refused").toEqual([]);
    expect(r.out).toContain("Fam Phase 7");
  });

  test("a Phase column that disagrees with the spec refuses the run before anything is written", async () => {
    const s = spy();
    const r = await run(["| #13 | 5 | (a) | `ZZ-1` | HIGH | the plan says 5, the spec says 6 |"], s.gh, [...FAMILY, "--write"]);
    expect(r.code).toBe(REFUSAL_EXIT);
    expect(s.calls).toEqual([]);
    expect(r.out).toContain("Phase 6");
  });

  test("a row mixing families, or splitting phases, is refused rather than half-placed", async () => {
    for (const [row, says] of [
      ["| #14 | 6 | (a) | `ZZ-1`, `CRC-N2` | HIGH | two families |", "from outside it"],
      ["| #15 | 6 | (a) | `ZZ-1`, `ZZ-2` | HIGH | two phases |", "Phase 6 and Phase 5"],
    ] as const) {
      const s = spy();
      const r = await run([row], s.gh, [...FAMILY, "--write"]);
      expect(r.code, row).toBe(REFUSAL_EXIT);
      expect(s.calls, row).toEqual([]);
      expect(r.out, row).toContain(says);
    }
  });

  test("a row whose body edit is refused is not placed either", async () => {
    // Review of #2069: the milestone moved while the criteria section stayed
    // ambiguous, so the tracker was half-applied.
    const twice = "x\n\n## Criteria this serves\n\nZZ-1\n\n## Criteria this serves\n";
    const s = spy({ 10: { body: twice } });
    const r = await run([IN_FAMILY], s.gh, [...FAMILY, "--write"]);
    expect(r.code).toBe(REFUSAL_EXIT);
    expect(s.calls.filter(c => c.startsWith("place#")), r.out).toEqual([]);
  });

  test("a criterion in the family spec with no phase is named as that, never as another family", async () => {
    // Review of #2069: `Blocked`, `Done` and the other non-phase placements
    // never reach a milestone action, so they read as "outside the family".
    const mixed = await run(["| #16 | 6 | (a) | `ZZ-1`, `ZZ-4` | HIGH | one phased, one blocked |"], spy().gh, [...FAMILY, "--write"]);
    expect(mixed.code).toBe(REFUSAL_EXIT);
    expect(mixed.out).toContain("ZZ-4");
    expect(mixed.out).toContain("no phase");
    expect(mixed.out).not.toContain("from outside it");
    const s = spy();
    const alone = await run(["| #17 | 6 | (a) | `ZZ-4` | HIGH | blocked only |"], s.gh, [...FAMILY, "--write"]);
    expect(alone.code, alone.out).toBe(0);
    expect(s.calls.filter(c => c.startsWith("place#"))).toEqual([]);
    expect(alone.out).toMatch(/#17 .*no phase/);
  });

  test("#2072: an unsound family placement table refuses the run before anything is read or written", async () => {
    // plan-spec and board-snapshot refuse all three; a doubled id otherwise
    // resolves to whichever phase row comes last.
    const row = "| #18 | 7 | (a) | `ZZ-1` | HIGH | which phase? |";
    for (const [name, spec, says] of [
      ["doubled", FAMILY_SPEC.replace("| **Phase 7** | ZZ-3 |", "| **Phase 7** | ZZ-3, ZZ-1 |"), "ZZ-1 is placed twice"],
      ["unknown", FAMILY_SPEC.replace("| **Phase 7** | ZZ-3 |", "| **Phase 7** | ZZ-3, ZZ-9 |"), "ZZ-9"],
      ["unrecognised", FAMILY_SPEC.replace("| **Blocked — needs a second person** |", "| **Someday** |"), "Someday"],
    ] as const) {
      const s = spy();
      let reads = 0;
      const counted: PlanIssuesGitHub = { ...s.gh, readIssue: async (r, n) => (reads++, s.gh.readIssue(r, n)) };
      const r = await run([row], counted, [...FAMILY, "--write"], spec);
      expect(r.code, name).toBe(REFUSAL_EXIT);
      expect(s.calls, name).toEqual([]);
      expect(reads, `${name}: an issue was read after the spec was known unsound`).toBe(0);
      expect(r.out, name).toContain(says);
    }
  });

  test("an issue already in its milestone is left as it is", async () => {
    const s = spy({ 10: { milestone: "Fam Phase 6 — the one", body: annotatedBody("Body.", ["ZZ-1"]) } });
    const r = await run([IN_FAMILY], s.gh, [...FAMILY, "--write"]);
    expect(r.code, r.out).toBe(0);
    expect(s.calls).toEqual([]);
  });

  test("without --milestone-prefix nothing moves, and the run says the Phase column was not applied", async () => {
    const s = spy();
    const r = await run([IN_FAMILY], s.gh, ["--write"]);
    expect(r.code, r.out).toBe(0);
    expect(s.calls).toEqual(["body#10"]);
    expect(r.out).toContain("Phase column was not applied");
  });

  test("--milestone-prefix without --spec is refused by name, and nothing is read or written", async () => {
    const s = spy();
    const r = await run([IN_FAMILY], s.gh, ["--milestone-prefix", "Fam", "--write"]);
    expect(r.code).toBe(REFUSAL_EXIT);
    expect(s.calls).toEqual([]);
    expect(r.out).toContain("--spec");
  });

  test("without --write the placement is reported and nothing is called", async () => {
    const s = spy();
    const r = await run([IN_FAMILY], s.gh, FAMILY);
    expect(r.code, r.out).toBe(0);
    expect(s.calls).toEqual([]);
    expect(r.out).toContain("Fam Phase 6 — the one");
  });
});

/**
 * SC-2779: an open issue moves into the phase milestone its criteria hold,
 * read from every opted-in spec (ADR-018 Decision 4, narrowed by ADR-019
 * Decision 3). `issuePlacement` in lib/issue-repair.ts is the one decider;
 * `plan-issues --place` is the run that applies it.
 */
describe("SC-2779: an issue moves into the phase milestone its criteria hold", () => {
  const FAM: PlacingFamily = {
    prefix: "Fam",
    stated: ["ZZ-1", "ZZ-2", "ZZ-3", "ZZ-4"],
    placements: new Map([
      ["ZZ-2", "Phase 5"],
      ["ZZ-1", "Phase 6"],
      ["ZZ-3", "Phase 7"],
      ["ZZ-4", "Blocked — needs a second person"],
    ]),
    milestones: new Map([
      [5, "Fam Phase 5 — earlier"],
      [6, "Fam Phase 6 — the one"],
    ]),
  };
  const OTHER: PlacingFamily = {
    prefix: "Other",
    stated: ["YY-1"],
    placements: new Map([["YY-1", "Phase 6"]]),
    milestones: new Map([[6, "Other Phase 6 — elsewhere"]]),
  };
  const at = (body: string, milestone: string | null = null) => issuePlacement({ title: "t", body, milestone }, [FAM, OTHER]);

  test("no milestone, criteria in one phase: moved into that phase's milestone", () => {
    expect(at("Serves ZZ-1.")).toEqual(expect.objectContaining({ kind: "move", milestone: "Fam Phase 6 — the one" }));
  });

  test("a different milestone of the same family: moved, the narrowing ADR-019 Decision 3 made", () => {
    expect(at("Serves ZZ-2.", "Fam Phase 6 — the one")).toEqual(
      expect.objectContaining({ kind: "move", milestone: "Fam Phase 5 — earlier" }),
    );
  });

  test("already in the phase its criteria hold: stays", () => {
    expect(at("Serves ZZ-1.", "Fam Phase 6 — the one").kind).toBe("stay");
  });

  test("no milestone, criteria in two phases of one family: the LOWEST", () => {
    expect(at("Serves ZZ-1 and ZZ-2.")).toEqual(expect.objectContaining({ kind: "move", milestone: "Fam Phase 5 — earlier" }));
  });

  test("a milestone, criteria in two phases: never moved, and said why", () => {
    const m = at("Serves ZZ-1 and ZZ-2.", "Fam Phase 6 — the one");
    expect(m.kind).toBe("left");
    expect("why" in m && m.why).toContain("Phase 5 and Phase 6");
  });

  test("criteria from two families: left where it is, with or without a milestone", () => {
    for (const milestone of [null, "Fam Phase 6 — the one"]) {
      const m = at("Serves ZZ-1 and YY-1.", milestone);
      expect(m.kind, String(milestone)).toBe("left");
      expect("why" in m && m.why, String(milestone)).toContain("do not compare across specs");
    }
  });

  test("a milestone that is not one of the family's phases: never moved", () => {
    for (const milestone of ["Other Phase 6 — elsewhere", "Machinery"]) {
      const m = at("Serves ZZ-1.", milestone);
      expect(m.kind, milestone).toBe("left");
      expect("why" in m && m.why, milestone).toContain(`"${milestone}"`);
    }
  });

  test("an issue that says it serves no criterion is not placed by the ids it mentions", () => {
    // #2307 on 2026-11-17: cited two engine criteria in passing, said it serves
    // none, and would otherwise have gone into a finished phase.
    const m = at("Unlike ZZ-1, this serves no criterion.");
    expect(m.kind).toBe("left");
    expect("why" in m && m.why).toContain("serves no criterion");
  });

  test("a criterion placed outside every phase stops the move, named", () => {
    for (const body of ["Serves ZZ-1 and ZZ-4.", "Serves ZZ-4."]) {
      const m = at(body);
      expect(m.kind, body).toBe("left");
      expect("why" in m && m.why, body).toContain("ZZ-4 is placed Blocked");
    }
  });

  test("an id no opted-in spec states neither places nor blocks the move", () => {
    expect(at("Serves ZZ-1, and see QQ-9.")).toEqual(expect.objectContaining({ kind: "move", milestone: "Fam Phase 6 — the one" }));
    expect(at("Only QQ-9.").kind).toBe("none");
  });

  test("the phase it belongs in has no milestone: a refusal, never a created milestone", () => {
    const m = at("Serves ZZ-3.");
    expect(m.kind).toBe("refuse");
    expect("why" in m && m.why).toContain("Fam Phase 7");
  });
});

describe("SC-2779: plan-issues --place reads every opted-in spec and writes only the moves", () => {
  const front = (board: string) => `---\ndoc-type: spec\n${board}---\n\n`;
  const OTHER_SPEC = [
    "# Other",
    "",
    "### Phase 6 — elsewhere",
    "",
    "- [ ] YY-1: lib/y.ts contains [y] — other",
    "",
    "### Phase placement",
    "",
    "| Placement | Criteria | What |",
    "|---|---|---|",
    "| **Phase 6** | YY-1 | elsewhere |",
    "",
  ].join("\n");
  /** A spec that names a prefix but is held back: not a family, so its ids place nothing. */
  const PARKED_SPEC = OTHER_SPEC.replaceAll("YY-1", "XX-1").replace("# Other", "# Parked");
  const TREE: Record<string, string> = {
    "specs/FAM.md": front("board:\n  scope: active\n  prefix: Fam\n") + FAMILY_SPEC,
    "specs/OTHER.md": front("board:\n  scope: active\n  prefix: Other\n") + OTHER_SPEC,
    "specs/PARKED.md": front("board:\n  scope: deferred\n  prefix: Parked\n") + PARKED_SPEC,
  };
  const ISSUES = [
    { number: 30, title: "moves", body: "Serves ZZ-1.", milestone: null },
    { number: 31, title: "moves within its family", body: "Serves ZZ-2.", milestone: "Fam Phase 6 — the one" },
    { number: 32, title: "two families", body: "ZZ-1 and YY-1.", milestone: null },
    { number: 33, title: "held-back spec only", body: "Serves XX-1.", milestone: null },
    { number: 34, title: "in place", body: "Serves YY-1.", milestone: "Other Phase 6 — elsewhere" },
  ];

  async function run(
    extra: string[],
    opts: { tree?: Record<string, string>; issues?: typeof ISSUES; failing?: "milestones" | "openIssues" } = {},
  ) {
    const dir = mkdtempSync(join(tmpdir(), "rg-plan-issues-2779-"));
    const out: string[] = [];
    const calls: string[] = [];
    let issueReads = 0;
    const gh: PlaceGitHub = {
      milestones: async () => {
        if (opts.failing === "milestones") throw new Error("HTTP 502 from the milestones read");
        return LIVE_MILESTONES;
      },
      openIssues: async () => {
        issueReads++;
        if (opts.failing === "openIssues") throw new Error("HTTP 502 from the issues read");
        return opts.issues ?? ISSUES;
      },
      setMilestone: async (_r, n, title) => void calls.push(`place#${n}:${title}`),
    };
    const log = console.log;
    const err = console.error;
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    console.error = (...a: unknown[]) => void out.push(a.join(" "));
    try {
      mkdirSync(join(dir, "specs"));
      for (const [path, text] of Object.entries(opts.tree ?? TREE)) writeFileSync(join(dir, path), text);
      const code = await planIssuesMain(["--place", "--repo", "o/r", "--project-root", dir, ...extra], undefined, undefined, gh);
      return { code, out: out.join("\n"), calls, issueReads };
    } finally {
      console.log = log;
      console.error = err;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** `--families`, with stdout kept apart: it is the only thing the run reads. */
  async function runFamilies(tree: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "rg-plan-issues-2779-fam-"));
    const stdout: string[] = [];
    const err: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...a: unknown[]) => void stdout.push(a.join(" "));
    console.error = (...a: unknown[]) => void err.push(a.join(" "));
    try {
      mkdirSync(join(dir, "specs"));
      for (const [path, text] of Object.entries(tree)) writeFileSync(join(dir, path), text);
      const code = await planIssuesMain(["--families", "--project-root", dir]);
      return { code, stdout, out: [...stdout, ...err].join("\n") };
    } finally {
      console.log = log;
      console.error = error;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("--write moves exactly the issues the rule moves, and nothing else", async () => {
    const r = await run(["--write"]);
    expect(r.code, r.out).toBe(0);
    expect(r.calls).toStrictEqual(["place#30:Fam Phase 6 — the one", "place#31:Fam Phase 5 — earlier"]);
    expect(r.out).toMatch(/LEFT +#32 .*do not compare across specs/);
  });

  test("a held-back spec is not a family, even naming a prefix", async () => {
    // #33 names only XX-1, which PARKED states. Were PARKED a family, #33
    // would belong in Parked Phase 6, which has no milestone, and the run
    // would refuse.
    const r = await run([]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain("#33");
    expect(r.out).not.toContain("Parked");
  });

  test("without --write the moves are printed and nothing is called", async () => {
    const r = await run([]);
    expect(r.code, r.out).toBe(0);
    expect(r.calls).toStrictEqual([]);
    expect(r.out).toMatch(/MOVE +#30 .*Fam Phase 6 — the one/);
    expect(r.out).toContain("Nothing written");
  });

  test("an issue whose phase has no milestone refuses the run before anything is written", async () => {
    const r = await run(["--write"], { issues: [...ISSUES, { number: 35, title: "unbuilt", body: "Serves ZZ-3.", milestone: null }] });
    expect(r.code).toBe(REFUSAL_EXIT);
    expect(r.calls, "a write went out from a run that refused").toStrictEqual([]);
    expect(r.out).toContain("Fam Phase 7");
    // Review of #2315: the tally accounts for every open issue the header counts.
    expect(r.out).toContain("6 open issue(s)");
    expect(r.out).toMatch(/2 to move, 1 already placed, 1 left where they are, 1 name no opted-in criterion, 1 refused/);
  });

  test("a family whose table or board: block cannot be read refuses before any issue is read", async () => {
    for (const [name, tree, says] of [
      ["unsound table", { ...TREE, "specs/FAM.md": TREE["specs/FAM.md"]!.replace("| **Phase 7** | ZZ-3 |", "| **Phase 7** | ZZ-3, ZZ-1 |") }, "ZZ-1 is placed twice"],
      ["no table", { ...TREE, "specs/OTHER.md": TREE["specs/OTHER.md"]!.replace("### Phase placement", "### Elsewhere") }, "specs/OTHER.md"],
      ["unreadable board block", { ...TREE, "specs/ODD.md": front("board:\n  scope: someday\n") + OTHER_SPEC.replaceAll("YY-1", "WW-1") }, "specs/ODD.md"],
      ["one prefix twice", { ...TREE, "specs/TWIN.md": front("board:\n  scope: active\n  prefix: Fam\n") + OTHER_SPEC.replaceAll("YY-1", "VV-1") }, "both declare prefix Fam"],
    ] as const) {
      const r = await run(["--write"], { tree });
      expect(r.code, `${name}\n${r.out}`).toBe(REFUSAL_EXIT);
      expect(r.calls, name).toStrictEqual([]);
      expect(r.issueReads, `${name}: issues were read after the families were known unreadable`).toBe(0);
      expect(r.out, name).toContain(says);
    }
  });

  test("a tracker read that fails is UNMEASURED, by name, and nothing is written", async () => {
    // Review of #2315: a rate limit or network blip threw a stack out of main().
    for (const failing of ["milestones", "openIssues"] as const) {
      const r = await run(["--write"], { failing });
      expect(r.code, failing).toBe(REFUSAL_EXIT);
      expect(r.calls, failing).toStrictEqual([]);
      expect(r.out, failing).toContain("UNMEASURED — could not read the tracker");
      expect(r.out, failing).toContain("HTTP 502");
    }
  });

  test("one decider says whether a placement table is sound, for --place and --milestone-prefix alike", () => {
    // Review of #2315: two inline copies would drift, and each flag's own
    // tests would stay green. The refusal text is spelled once, and both
    // flags reach it through the one function.
    const src = readFileSync(join(import.meta.dir, "..", "scripts", "plan-issues.ts"), "utf-8");
    expect(src.split("is placed twice").length - 1).toBe(1);
    expect(src.split("unsoundPlacement(").length - 1, "the definition and its two callers").toBe(3);
  });

  test("--families prints each opted-in family and its spec, for the run to loop over", async () => {
    // The same reading --place takes; a held-back spec is not listed.
    const listed = await runFamilies(TREE);
    expect(listed.code, listed.out).toBe(0);
    expect(listed.stdout).toStrictEqual(["Fam\tspecs/FAM.md", "Other\tspecs/OTHER.md"]);
  });

  test("--families with any other flag is refused, printing no family", async () => {
    // Review of #2315: --json was accepted and ignored, so a script asking for
    // JSON got tab-separated lines with nothing saying so.
    for (const extra of [["--json"], ["--write"], ["--place"]]) {
      const dir = mkdtempSync(join(tmpdir(), "rg-plan-issues-2779-famflags-"));
      const out: string[] = [];
      const log = console.log;
      const error = console.error;
      console.log = (...a: unknown[]) => void out.push(`OUT ${a.join(" ")}`);
      console.error = (...a: unknown[]) => void out.push(a.join(" "));
      try {
        mkdirSync(join(dir, "specs"));
        for (const [path, text] of Object.entries(TREE)) writeFileSync(join(dir, path), text);
        const code = await planIssuesMain(["--families", "--project-root", dir, ...extra]);
        expect(code, extra.join(" ")).toBe(REFUSAL_EXIT);
        expect(out.filter(l => l.startsWith("OUT ")), extra.join(" ")).toStrictEqual([]);
        expect(out.join("\n"), extra.join(" ")).toContain("pass it alone");
      } finally {
        console.log = log;
        console.error = error;
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("--families refuses, printing no family, when a spec cannot be read", async () => {
    const listed = await runFamilies({ ...TREE, "specs/ODD.md": front("board:\n  scope: someday\n") + OTHER_SPEC.replaceAll("YY-1", "WW-1") });
    expect(listed.code).toBe(REFUSAL_EXIT);
    expect(listed.stdout).toStrictEqual([]);
    expect(listed.out).toContain("specs/ODD.md");
  });

  test("--place with another plan's flags is refused by name", async () => {
    for (const extra of [["--repair", "PLAN.md"], ["--milestone-prefix", "Fam"], ["--spec", "specs/FAM.md"]]) {
      const r = await run(extra);
      expect(r.code, extra.join(" ")).toBe(REFUSAL_EXIT);
      expect(r.issueReads, extra.join(" ")).toBe(0);
      expect(r.out, extra.join(" ")).toContain("--place reads every opted-in spec itself");
    }
  });
});

/**
 * #2953: the closed-titles read keeps a closed issue the plan filed. Before,
 * it kept only a trusted author's, so ADR-029's #2930 to #2932 (closed,
 * completed, filed by the workflow bot) planned as `create` on any re-run.
 */
describe("#2953: the closed-titles read keeps a closed issue the plan filed", () => {
  const footer = `${PLANNED_ISSUE_FOOTER}docs/adr/ADR-029.md\` from a reviewed plan.`;
  // One line per issue, as the read's jq prints it.
  const line = (...f: unknown[]) => JSON.stringify(f);
  const out = [
    line(2930, "row one", "completed", "NONE", "github-actions[bot]", "Bot", `body\n\n---\n\n${footer}`),
    line(2931, "row two", "completed", "NONE", "github-actions[bot]", "Bot", `x\n${footer}`),
    line(2932, "row three", "completed", "NONE", "github-actions[bot]", "Bot", `x\n${footer}`),
    line(9001, "a stranger's copy", "completed", "NONE", "someone", "User", `x\n${footer}`),
    line(9002, "row four", "not_planned", "NONE", "github-actions[bot]", "Bot", `x\n${footer}`),
    line(9003, "the owner's", "completed", "OWNER", "hornjason", "User", null),
  ].join("\n");

  test("closed: the plan's finished issues and a trusted author's are kept; a stranger's and an unfinished one are not", () => {
    expect([...issueTitleMap(out, "closed").entries()]).toEqual([
      ["row one", 2930],
      ["row two", 2931],
      ["row three", 2932],
      ["the owner's", 9003],
    ]);
  });

  test("the plan's bot login is the one lib/github.ts names, so #2901's rule and this one cannot drift apart", () => {
    expect(PLAN_BOT_LOGIN).toBe(WORKFLOW_BOT_LOGIN);
  });

  test("open: every issue is kept, whoever wrote it, as before", () => {
    expect(issueTitleMap(out, "open").size).toBe(6);
  });

  test("the live read asks GitHub for the author's login and type and the body, in the order the parser reads them", () => {
    const src = readFileSync(join(import.meta.dir, "..", "scripts", "plan-issues.ts"), "utf-8");
    expect(src).toContain("[.number, .title, .state_reason, .author_association, .user.login, .user.type, .body]");
  });
});
