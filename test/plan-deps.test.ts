/**
 * `lib/spec-deps.ts` — the dependencies planning declared, as `blocked by`
 * edges (#1647, SC-2606, ADR-021).
 *
 * ## Every case asserts MEMBERSHIP, not a count
 *
 * `.claude/rules/checks-must-be-able-to-fail.md`, seventh shape: predict the
 * membership, not just the total. One edge is also what you get from
 * reversing blocked and blocker, or from resolving a title to the wrong one
 * of two issues, and a count cannot see either, so the cases name the pairs.
 *
 * ## And the write cases assert on the CALLS, not the exit code
 *
 * `scripts/plan-spec.ts` shipped a refusal that was computed AFTER its write
 * loop: every milestone was created and the command then exited 1. Nothing
 * reading an exit code can tell that apart from a refusal that stopped
 * something, so the negative cases here record what reached GitHub.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { declaredDependencies, dependencyPlan, groupByBlocked, readDeclaredPlans } from "../lib/spec-deps";
import type { DeclaredPlan, DepEdge, DepIssue } from "../lib/spec-deps";
import type { DecompositionRow } from "../lib/issue-decomposition";
import { familyOf, phaseInFamily } from "../lib/spec-placement";
import { phaseOf } from "../lib/board-mirror";
import { REFUSAL_EXIT, main as planDepsMain } from "../scripts/plan-deps";
import type { PlanDepsGitHub } from "../scripts/plan-deps";

/** One issue, spelled the way the GraphQL read spells it, titled `issue <n>`. */
function iss(
  number: number,
  phase: number | null,
  opts: { state?: string; blockedBy?: number[]; title?: string } = {},
): DepIssue {
  return {
    number,
    title: opts.title ?? `issue ${number}`,
    state: opts.state ?? "OPEN",
    milestone: phase === null ? null : `Convergence Phase ${phase} — whatever it is called`,
    blockedBy: opts.blockedBy ?? [],
  };
}

/** `blocked<-blocker`, so a reversal is visible in the assertion text. */
const keys = (es: readonly { blocked: number; blocker: number }[]): string[] =>
  es.map(e => `${e.blocked}<-${e.blocker}`).sort();

/** One Decomposition row, as the parser returns it. */
const row = (outcome: string, blockedBy: string[] = [], blocks: string[] = []): DecompositionRow => ({
  criterion: "fixture",
  outcome,
  files: ["lib/fixture.ts"],
  milestone: null,
  blockedBy,
  blocks,
  line: 1,
});

const plan1 = (...rows: DecompositionRow[]): DeclaredPlan[] => [{ path: "docs/adr/ADR-900-fixture.md", rows }];

/** `blocked<-blocker` pairs as declared edges, for `dependencyPlan` cases. */
const edges = (...pairs: [number, number][]): DepEdge[] => pairs.map(([blocked, blocker]) => ({ blocked, blocker }));

/**
 * The script seam's plan reader, declaring `blocked<-blocker` pairs: one row
 * per pair, naming its own issue by title (`issue <n>`, as `iss` titles it)
 * and its blocker by `#n`.
 */
function declaring(...pairs: [number, number][]): PlanDepsGitHub["readPlans"] {
  return () => ({ plans: plan1(...pairs.map(([blocked, blocker]) => row(`issue ${blocked}`, [`#${blocker}`]))), unreadable: [] });
}

/**
 * Covers SC-2606 (SPEC-TO-BOARD-PIPELINE-SPEC.md).
 *
 * The criterion used to name `chainAdjacentPhases`, which turned the phase
 * order into links: every issue in a phase blocked by every issue in the
 * phase before. ADR-021 (Jason, 2026-11-18) made phase an order Ready sorts
 * by, and a dependency something planning DECLARES — a `Blocked by` or
 * `Blocks` cell in an accepted ADR's Decomposition table. These cases call
 * `declaredDependencies` directly, so a mutation of it that `dependencyPlan`'s
 * own cases would survive still reddens here.
 */
describe("SC-2606: declaredDependencies is where a dependency comes from", () => {
  test("a row's Blocked by outcome becomes an edge onto the row that names it, in that direction", () => {
    const got = declaredDependencies(
      plan1(row("Alpha does a thing"), row("Beta does a thing", ["Alpha does a thing"])),
      [iss(10, 0, { title: "Alpha does a thing" }), iss(20, 1, { title: "Beta does a thing" })],
    );
    expect(keys(got)).toEqual(["20<-10"]);
    expect(keys(got)).not.toContain("10<-20");
  });

  test("`#n` resolves in both cells, each in its own direction", () => {
    const got = declaredDependencies(plan1(row("Beta does a thing", ["#7"], ["#30"])), [
      iss(7, 0),
      iss(20, 1, { title: "Beta does a thing" }),
      iss(30, 2),
    ]);
    expect(keys(got)).toEqual(["20<-7", "30<-20"]);
  });

  test("phase order is never an edge: two phases with nothing declared yield nothing", () => {
    // The 182 links `chainAdjacentPhases` wrote on Convergence came from
    // exactly this input. Nothing declared is nothing written.
    const issues = [iss(10, 0), iss(11, 0), iss(20, 1), iss(30, 2)];
    expect(declaredDependencies([], issues)).toEqual([]);
    expect(declaredDependencies(plan1(row("issue 20"), row("issue 30")), issues)).toEqual([]);
  });

  test("a CLOSED issue is neither blocked nor a blocker, by title or by number", () => {
    const issues = [iss(7, 0, { state: "CLOSED" }), iss(10, 0, { state: "CLOSED" }), iss(20, 1), iss(21, 1)];
    const got = declaredDependencies(
      plan1(row("issue 20", ["issue 10", "#7"]), row("issue 10", ["#21"]), row("issue 21", [], ["#7"])),
      issues,
    );
    expect(got).toEqual([]);
    // The pair: the same plan with both open writes all four, so the case
    // above is about the state and not a malformed row.
    const open = issues.map(i => ({ ...i, state: "OPEN" }));
    expect(keys(declaredDependencies(
      plan1(row("issue 20", ["issue 10", "#7"]), row("issue 10", ["#21"]), row("issue 21", [], ["#7"])),
      open,
    ))).toEqual(["10<-21", "20<-10", "20<-7", "7<-21"]);
  });

  test("a row whose issue was never filed contributes nothing", () => {
    const got = declaredDependencies(plan1(row("nobody filed this one", ["#10"]), row("issue 20", ["nor this"])), [
      iss(10, 0),
      iss(20, 1),
    ]);
    expect(got).toEqual([]);
  });

  test("a title two open issues share resolves to neither — never the wrong one of two", () => {
    const issues = [iss(10, 0), iss(20, 1, { title: "Twin" }), iss(21, 1, { title: "Twin" })];
    expect(declaredDependencies(plan1(row("Twin", ["#10"])), issues)).toEqual([]);
    expect(declaredDependencies(plan1(row("issue 10", ["Twin"])), issues)).toEqual([]);
    // A `#n` reaches one of the twins exactly: the number is not ambiguous.
    expect(keys(declaredDependencies(plan1(row("issue 10", ["#21"])), issues))).toEqual(["10<-21"]);
  });

  test("plans combine, and one dependency declared twice is one edge", () => {
    const issues = [iss(10, 0), iss(20, 1), iss(30, 2)];
    const got = declaredDependencies(
      [
        { path: "docs/adr/ADR-901-a.md", rows: [row("issue 20", ["#10"])] },
        { path: "docs/adr/ADR-902-b.md", rows: [row("issue 30", ["#20"]), row("issue 10", [], ["#20"])] },
      ],
      issues,
    );
    expect(keys(got)).toEqual(["20<-10", "30<-20"]);
  });

  test("an issue is never its own blocker", () => {
    expect(declaredDependencies(plan1(row("issue 10", ["#10"], ["#10"])), [iss(10, 0)])).toEqual([]);
  });
});

describe("SC-2606: readDeclaredPlans reads accepted ADRs' Decomposition tables, and says which it could not", () => {
  const adr = (status: string, table: string) =>
    `---\ndoc-type: adr\nstatus: ${status}\ncreated: 2026-11-18\n---\n\n# A decision\n\n## Decomposition\n\n${table}\n`;
  const TABLE =
    "| Criterion | Outcome | Files | Milestone | Blocked by |\n|---|---|---|---|---|\n" +
    "| CRC-C2 | the first piece of planned work | lib/a.ts | Phase 3 | — |\n" +
    "| CRC-C2 | the second piece of planned work | lib/b.ts | Phase 3 | the first piece of planned work |";

  test("accepted with a table is read; proposed, or accepted with no table, is not a plan; an unparseable one is named", () => {
    const root = mkdtempSync(join(tmpdir(), "plan-deps-adrs-"));
    try {
      mkdirSync(join(root, "docs", "adr"), { recursive: true });
      writeFileSync(join(root, "docs", "adr", "ADR-001-read.md"), adr("accepted", TABLE));
      writeFileSync(join(root, "docs", "adr", "ADR-002-proposed.md"), adr("proposed", TABLE));
      writeFileSync(join(root, "docs", "adr", "ADR-003-no-table.md"), adr("accepted", "No plan here."));
      writeFileSync(
        join(root, "docs", "adr", "ADR-004-broken.md"),
        adr("accepted", "| Criterion | Outcome | Files | Milestone | Blocked by |\n|---|---|---|---|---|\n| only | three |"),
      );
      writeFileSync(join(root, "docs", "adr", "TEMPLATE.md"), adr("accepted", TABLE));
      const got = readDeclaredPlans(root);
      expect(got.plans.map(p => p.path)).toEqual(["docs/adr/ADR-001-read.md"]);
      expect(got.plans[0]!.rows.map(r => [r.outcome, r.blockedBy])).toEqual([
        ["the first piece of planned work", []],
        ["the second piece of planned work", ["the first piece of planned work"]],
      ]);
      expect(got.unreadable).toEqual(["docs/adr/ADR-004-broken.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a tree with no docs/adr declares nothing, and that is not a failure", () => {
    const root = mkdtempSync(join(tmpdir(), "plan-deps-no-adrs-"));
    try {
      expect(readDeclaredPlans(root)).toEqual({ plans: [], unreadable: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("lib/spec-deps: dependencyPlan sets what was declared against what the tracker carries", () => {
  test("declared and absent is MISSING; declared and present is PRESENT, so a re-run adds nothing", () => {
    const first = dependencyPlan([iss(10, 0), iss(20, 1)], edges([20, 10]));
    expect(keys(first.missing)).toEqual(["20<-10"]);
    const second = dependencyPlan([iss(10, 0), iss(20, 1, { blockedBy: [10] })], edges([20, 10]));
    expect(second.missing).toEqual([]);
    expect(keys(second.present)).toEqual(["20<-10"]);
    expect(second.extra).toEqual([]);
  });

  test("a link nobody declared is EXTRA and never appears in missing — hand-written, or old phase order", () => {
    // #1481 blocked by #1591 is live, real, and WITHIN a phase. A tool that
    // reconciled by deletion would destroy it.
    const plan = dependencyPlan([iss(10, 0), iss(20, 2), iss(21, 2, { blockedBy: [20] })], edges([20, 10]));
    expect(keys(plan.extra)).toEqual(["21<-20"]);
    expect(keys(plan.missing)).toEqual(["20<-10"]);
  });

  test("an issue with no Phase milestone still gets its declared link, and is reported", () => {
    const plan = dependencyPlan([iss(10, 0), iss(20, 1), iss(99, null)], edges([99, 10]));
    expect(plan.unphased).toEqual([99]);
    expect(keys(plan.missing)).toEqual(["99<-10"]);
  });

  test("a declared edge whose waiting issue is not considered is not this run's to write", () => {
    // `plan-deps` narrows to one family: the issues that WAIT. The blocker may
    // sit anywhere — here #50 is not in the population at all.
    const plan = dependencyPlan([iss(10, 0), iss(20, 1)], edges([20, 50], [60, 10]));
    expect(keys(plan.missing)).toEqual(["20<-50"]);
  });

  test("the same declared edge twice is one write", () => {
    expect(keys(dependencyPlan([iss(10, 0), iss(20, 1)], edges([20, 10], [20, 10])).missing)).toEqual(["20<-10"]);
  });
});

/**
 * #2024 / SC-2617: this repository carries more than one milestone family, and
 * `plan-deps` runs once per family. Until ADR-021 the plan chained phases
 * within a family; now a family's run writes the declared links of the issues
 * that sit in it, whatever family their blockers sit in, and never another
 * family's.
 */
describe("#2024 / SC-2617: a family's run writes its own issues' declared links, and no other family's", () => {
  const fam = (number: number, family: string, phase: number): DepIssue => ({
    number,
    title: `issue ${number}`,
    state: "OPEN",
    milestone: `${family} Phase ${phase} — x`,
    blockedBy: [],
  });

  test("Convergence waits on Pipeline: the Convergence run writes it; Pipeline's own link is not its to write", () => {
    const declared = edges([11, 10], [21, 20], [11, 20]);
    const convergence = [fam(10, "Convergence", 0), fam(11, "Convergence", 1)];
    const plan = dependencyPlan(convergence, declared);
    expect(keys(plan.missing)).toEqual(["11<-10", "11<-20"]);
    expect(keys(plan.missing)).not.toContain("21<-20");
  });

  test("a parenthetical phase is not a phase milestone, to every reader at once (#2057)", () => {
    // With one reader of the title (lib/milestone-title.ts) the split cannot
    // occur: the title is not a phase milestone, and the plan says nothing
    // was read.
    const plan = dependencyPlan(
      [
        { number: 30, title: "issue 30", state: "OPEN", milestone: "Release (Phase 3)", blockedBy: [] },
        { number: 40, title: "issue 40", state: "OPEN", milestone: "Docs (Phase 4)", blockedBy: [] },
      ],
      [],
    );
    expect(plan.reading).toBe("UNMEASURED");
    expect(plan.unmeasuredReasons.join(" ")).toContain("NONE carries a Phase milestone");
    expect(phaseOf("Release (Phase 3)")).toBeNull();
    expect(familyOf("Release (Phase 3)")).toBeNull();
  });

  test("familyOf reads the same grammar as phaseInFamily, so the two cannot disagree", () => {
    // The last title says "Phase" twice: the family ends at the FIRST one.
    expect(familyOf("Pipeline Phase 6 — starts after Phase 5 ships")).toBe("Pipeline");
    for (const title of [
      "Pipeline Phase 6 — the board's state is a reading",
      "Convergence Phase 0",
      "Engine X Phase 12 — y",
      "Pipeline Phase 6 — starts after Phase 5 ships",
    ]) {
      const family = familyOf(title);
      expect(family, title).not.toBeNull();
      expect(phaseInFamily(title, family!), title).toBe(phaseOf(title));
    }
    // The stated exception: the unprefixed family has no `phaseInFamily`
    // reading, because that function takes a prefix and `""` is not one.
    expect(familyOf("Phase 2 — x")).toBe("");
    expect(phaseInFamily("Phase 2 — x", "")).toBeNull();
    expect(familyOf("Convergence Machinery")).toBeNull();
    expect(familyOf(null)).toBeNull();
  });
});

/**
 * The WHOLE class of degenerate readings, as one table.
 *
 * Four review rounds each found a different input that walked between two
 * hand-written guards — the last was `phases.length === 0`, where issues
 * exist and the command printed *"the tracker already carries the phase
 * order"* about a board it could not read. So the cases below enumerate every
 * route to a reading that could not be taken, and the last is the negative
 * control: the only input that must reach none of them.
 */
describe("lib/spec-deps: every reading that could not be taken is UNMEASURED", () => {
  const cases: [string, DepIssue[], { includeClosed?: boolean }, string][] = [
    ["nothing read", [], {}, "failed fetch"],
    [
      "read, but nothing considered — every issue closed",
      [iss(10, 0, { state: "CLOSED" }), iss(20, 1, { state: "CLOSED" })],
      {},
      "none was considered",
    ],
    [
      "considered, but NOT ONE carries a Phase milestone",
      [iss(10, null), iss(20, null), iss(30, null)],
      {},
      "NONE carries a Phase milestone",
    ],
  ];
  for (const [name, issues, opts, reason] of cases) {
    test(`${name} is UNMEASURED, and says which`, () => {
      const plan = dependencyPlan(issues, edges([20, 10]), opts);
      expect(plan.reading).toBe("UNMEASURED");
      expect(plan.unmeasuredReasons.join(" ")).toContain(reason);
    });
  }

  // #2239 gave one phase its own reading, NOTHING_TO_SEQUENCE, because one
  // phase states no PHASE order. The plan is no longer phase order, so one
  // phase is an ordinary sound read and its links are what was declared.
  test("SC-2606: one phase over a sound read is MEASURED, and its declared link is still written", () => {
    const plan = dependencyPlan([iss(10, 0), iss(11, 0)], edges([11, 10]));
    expect(plan.reading).toBe("MEASURED");
    expect(plan.unmeasuredReasons).toEqual([]);
    expect(keys(plan.missing)).toEqual(["11<-10"]);
    expect(plan.phases).toEqual([0]);
  });

  test("THE NEGATIVE CONTROL: a considered, phased, fully read set reads MEASURED", () => {
    // Without this, every case above passes against a function that refuses
    // unconditionally — green rows witnessing nothing.
    const plan = dependencyPlan([iss(10, 0), iss(20, 1)], edges([20, 10]));
    expect(plan.reading).toBe("MEASURED");
    expect(keys(plan.missing)).toEqual(["20<-10"]);
  });

  test("the unphased case is NOT the same as the no-issues case — the reasons differ", () => {
    const empty = dependencyPlan([], []).unmeasuredReasons.join(" ");
    const unphased = dependencyPlan([iss(10, null)], []).unmeasuredReasons.join(" ");
    expect(unphased).not.toBe(empty);
    expect(unphased).toContain("plan-spec has not run");
  });

  test("a TRUNCATED blocker list refuses even when everything else is sound", () => {
    // A live edge list the reader could not see the end of: an edge past the
    // page boundary would read as missing and be written again.
    const plan = dependencyPlan(
      [iss(10, 0), { ...iss(20, 1), blockedBy: [10], blockedByTruncated: true }],
      edges([20, 10]),
    );
    expect(plan.reading).toBe("UNMEASURED");
    expect(plan.unmeasuredReasons.join(" ")).toContain("truncated");
    expect(plan.unmeasuredReasons.join(" ")).toContain("#20");
    // The pair: the identical input with the flag off is MEASURED.
    expect(dependencyPlan([iss(10, 0), iss(20, 1, { blockedBy: [10] })], edges([20, 10])).reading).toBe("MEASURED");
  });
});

describe("lib/spec-deps: the grouping is what reaches GitHub", () => {
  test("edges collapse to one call per BLOCKED issue, blockers sorted", () => {
    const plan = dependencyPlan(
      [iss(10, 0), iss(11, 0), iss(20, 1), iss(21, 1)],
      edges([21, 11], [20, 11], [20, 10], [21, 10]),
    );
    expect(groupByBlocked(plan.missing)).toEqual([
      { blocked: 20, blockers: [10, 11] },
      { blocked: 21, blockers: [10, 11] },
    ]);
  });

  test("the grouping loses no edge — six edges in three calls", () => {
    const plan = dependencyPlan(
      [iss(1, 0), iss(2, 0), iss(7, 1), iss(8, 1), iss(9, 1)],
      edges([7, 1], [7, 2], [8, 1], [8, 2], [9, 1], [9, 2]),
    );
    const groups = groupByBlocked(plan.missing);
    expect(groups).toHaveLength(3);
    expect(groups.flatMap(g => g.blockers.map(b => `${g.blocked}<-${b}`)).sort()).toEqual(keys(plan.missing));
  });
});

/**
 * `scripts/plan-deps.ts --write` — what reaches GitHub, and when it does not.
 */
describe("scripts/plan-deps --write: nothing reaches GitHub on an unmeasured reading", () => {
  function spy(issues: DepIssue[], readPlans: PlanDepsGitHub["readPlans"]) {
    const calls: string[] = [];
    let reads = 0;
    const gh: PlanDepsGitHub = {
      createClient: (() => ({}) as never) as PlanDepsGitHub["createClient"],
      readIssues: async () => {
        reads++;
        return issues;
      },
      readPlans,
      addBlockers: async (_repo, blocked, blockers) => {
        calls.push(`#${blocked} +${[...blockers].join(",")}`);
      },
    };
    return { gh, calls, reads: () => reads };
  }

  test("a sound reading writes the declared links, one call per blocked issue", async () => {
    const s = spy([iss(10, 0), iss(11, 0), iss(20, 1)], declaring([20, 10], [20, 11]));
    const code = await planDepsMain(["--repo", "o/r", "--write", "--milestone-prefix", "Convergence"], s.gh);
    expect(s.calls).toEqual(["#20 +10,11"]);
    expect(code).toBe(0);
  });

  test("an EMPTY read writes nothing and refuses", async () => {
    const s = spy([], declaring([20, 10]));
    const code = await planDepsMain(["--repo", "o/r", "--write", "--milestone-prefix", "Convergence"], s.gh);
    expect(s.calls, "an edge was written despite the refusal").toEqual([]);
    expect(code).toBe(REFUSAL_EXIT);
  });

  async function capture(argv: string[], gh: PlanDepsGitHub) {
    const out: string[] = [];
    const log = console.log;
    const err = console.error;
    console.log = (x: string) => void out.push(String(x));
    console.error = (x: string) => void out.push(String(x));
    let code;
    try {
      code = await planDepsMain(argv, gh);
    } finally {
      console.log = log;
      console.error = err;
    }
    return { code, text: out.join("\n") };
  }

  // The ADR-021 change, at the command: the input that used to write 1 phase-
  // order link (and on Convergence, 182) writes none when nothing is declared.
  // The sentence is asserted both ways, because exit 0 alone is also what an
  // unread plan would return — the sixth shape in checks-must-be-able-to-fail.md.
  for (const write of [true, false]) {
    test(`SC-2606: two phases and nothing declared write nothing — phase order is never a link (${write ? "--write" : "dry run"})`, async () => {
      const s = spy([iss(10, 0), iss(20, 1)], declaring());
      const argv = ["--repo", "o/r", "--milestone-prefix", "Convergence", ...(write ? ["--write"] : [])];
      const got = await capture(argv, s.gh);
      expect(s.calls).toEqual([]);
      expect(got.text).toContain("already carries every declared dependency");
      expect(got.text).not.toContain("UNMEASURED");
      expect(got.code).toBe(0);
    });
  }

  test("SC-2606: one phase with a declared link writes it — one phase is no longer nothing to sequence", async () => {
    const s = spy([iss(10, 0), iss(11, 0)], declaring([11, 10]));
    const got = await capture(["--repo", "o/r", "--write", "--json", "--milestone-prefix", "Convergence"], s.gh);
    const json = JSON.parse(got.text);
    expect(json.reading).toBe("MEASURED");
    expect(json.wrote).toBe("yes");
    expect(s.calls).toEqual(["#11 +10"]);
    expect(got.code).toBe(0);
  });

  test("SC-2606: ADRs that cannot be read refuse UNMEASURED before the tracker is read", async () => {
    const s = spy([iss(10, 0), iss(20, 1)], () => {
      throw new Error("EACCES: docs/adr");
    });
    const got = await capture(["--repo", "o/r", "--write", "--milestone-prefix", "Convergence"], s.gh);
    expect(got.code).toBe(REFUSAL_EXIT);
    expect(got.text).toContain("UNMEASURED");
    expect(got.text).toContain("EACCES");
    expect(s.calls).toEqual([]);
    expect(s.reads(), "the tracker was read for a plan that could not be").toBe(0);
  });

  test("an accepted plan whose table does not parse is named on both channels, and the readable ones still write", async () => {
    const readPlans: PlanDepsGitHub["readPlans"] = () => ({
      plans: declaring([20, 10])(".").plans,
      unreadable: ["docs/adr/ADR-007-old-shape.md"],
    });
    const text = await capture(["--repo", "o/r", "--write", "--milestone-prefix", "Convergence"], spy([iss(10, 0), iss(20, 1)], readPlans).gh);
    expect(text.code).toBe(0);
    expect(text.text).toContain("docs/adr/ADR-007-old-shape.md");
    const s = spy([iss(10, 0), iss(20, 1)], readPlans);
    const json = await capture(["--repo", "o/r", "--write", "--json", "--milestone-prefix", "Convergence"], s.gh);
    expect(JSON.parse(json.text).unreadablePlans).toEqual(["docs/adr/ADR-007-old-shape.md"]);
    expect(s.calls).toEqual(["#20 +10"]);
  });

  test("a FAILED write exits non-zero — the status is derived from what happened", async () => {
    // `applyEdges` catches each failure into a "FAILED" string and returns
    // it. Nothing read that array, so a run where every `gh issue edit` call
    // failed printed its failures among the successes and returned 0. The
    // same defect was fixed in `plan-issues` by this PR and left here.
    const gh: PlanDepsGitHub = {
      createClient: (() => ({}) as never) as PlanDepsGitHub["createClient"],
      readIssues: async () => [iss(10, 0), iss(20, 1)],
      readPlans: declaring([20, 10]),
      addBlockers: async () => {
        throw new Error("gh: HTTP 503");
      },
    };
    const code = await planDepsMain(["--repo", "o/r", "--write", "--milestone-prefix", "Convergence"], gh);
    expect(code, "every write failed and the command reported success").toBe(REFUSAL_EXIT);
  });

  test("--json --write reports `partial` on a failed write, not `yes`", async () => {
    const out: string[] = [];
    const log = console.log;
    console.log = (x: string) => void out.push(x);
    const gh: PlanDepsGitHub = {
      createClient: (() => ({}) as never) as PlanDepsGitHub["createClient"],
      readIssues: async () => [iss(10, 0), iss(20, 1)],
      readPlans: declaring([20, 10]),
      addBlockers: async () => {
        throw new Error("gh: HTTP 503");
      },
    };
    let code;
    try {
      code = await planDepsMain(["--repo", "o/r", "--write", "--json", "--milestone-prefix", "Convergence"], gh);
    } finally {
      console.log = log;
    }
    const json = JSON.parse(out.join("\n"));
    expect(json.wrote, "a run whose every write failed printed a clean status").toBe("partial");
    expect(json.results.join(" ")).toContain("FAILED");
    expect(code).toBe(REFUSAL_EXIT);
  });

  test("--json --write on a sound plan still reports `yes` and applies", async () => {
    // The pair for both cases above: without it they pass against a command
    // that reports "partial" unconditionally.
    const out: string[] = [];
    const log = console.log;
    console.log = (x: string) => void out.push(x);
    const s = spy([iss(10, 0), iss(20, 1)], declaring([20, 10]));
    let code;
    try {
      code = await planDepsMain(["--repo", "o/r", "--write", "--json", "--milestone-prefix", "Convergence"], s.gh);
    } finally {
      console.log = log;
    }
    expect(JSON.parse(out.join("\n")).wrote).toBe("yes");
    expect(s.calls).toEqual(["#20 +10"]);
    expect(code).toBe(0);
  });

  test("a second --write run is a no-op — the command is idempotent", async () => {
    const s = spy([iss(10, 0), iss(20, 1, { blockedBy: [10] })], declaring([20, 10]));
    const code = await planDepsMain(["--repo", "o/r", "--write", "--milestone-prefix", "Convergence"], s.gh);
    expect(s.calls, "an edge that already exists was written again").toEqual([]);
    expect(code).toBe(0);
  });

  test("--write never removes an EXTRA edge", async () => {
    const s = spy([iss(10, 0), iss(20, 1), iss(21, 1, { blockedBy: [20] })], declaring([20, 10], [21, 10]));
    await planDepsMain(["--repo", "o/r", "--write", "--milestone-prefix", "Convergence"], s.gh);
    // Only the declared pairs are added; nothing in the call list removes
    // 21<-20 and `addBlockers` is the only mutation the seam exposes.
    expect(s.calls).toEqual(["#20 +10", "#21 +10"]);
  });

  test("--json --write writes too, and says which of the three states it was in", async () => {
    const out: string[] = [];
    const log = console.log;
    console.log = (x: string) => void out.push(x);
    const s = spy([iss(10, 0), iss(20, 1)], declaring([20, 10]));
    try {
      await planDepsMain(["--repo", "o/r", "--write", "--json", "--milestone-prefix", "Convergence"], s.gh);
    } finally {
      console.log = log;
    }
    expect(s.calls).toEqual(["#20 +10"]);
    expect(JSON.parse(out.join("\n")).wrote).toBe("yes");
  });

  test("--json --write on an unmeasured reading reports `refused`, and writes nothing", async () => {
    const out: string[] = [];
    const log = console.log;
    console.log = (x: string) => void out.push(x);
    const s = spy([], declaring([20, 10]));
    let code;
    try {
      code = await planDepsMain(["--repo", "o/r", "--write", "--json", "--milestone-prefix", "Convergence"], s.gh);
    } finally {
      console.log = log;
    }
    expect(s.calls).toEqual([]);
    expect(code).toBe(REFUSAL_EXIT);
    expect(JSON.parse(out.join("\n")).wrote).toBe("refused");
  });

  test("no --repo and no GITHUB_REPOSITORY refuses before reading anything", async () => {
    const s = spy([iss(10, 0), iss(20, 1)], declaring([20, 10]));
    const saved = process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPOSITORY;
    try {
      // The prefix is supplied even though this case is about the repo.
      // Without it, #1728's new refusal fires too and the exit code is
      // overdetermined — the case would stay green with the repo guard
      // deleted. One missing thing at a time.
      expect(await planDepsMain(["--write", "--milestone-prefix", "Convergence"], s.gh)).toBe(REFUSAL_EXIT);
      expect(s.calls).toEqual([]);
    } finally {
      if (saved !== undefined) process.env.GITHUB_REPOSITORY = saved;
    }
  });
});

/**
 * `--milestone-prefix` (item **B3**).
 *
 * `phaseOf` reads `Phase <n>` out of a milestone title and nothing else, so
 * two specs that both numbered their phases put unrelated issues in the same
 * phase. Measured on hornjason/rungate 2026-11-01: an unfiltered run derived
 * 48 edges across 28 issues, and the engine issues in Pipeline Phase 5 came
 * out blocked by #1162, #1656 and #1657 — three issues from a different
 * spec's Phase 4, which block them in no sense anybody intended.
 *
 * The flag narrows the POPULATION, which is the only thing that can fix
 * this: the edge derivation is right about the order it is given, and what
 * it is given has to be one spec's issues.
 */
describe("scripts/plan-deps --milestone-prefix: one spec's issues, not every Phase N", () => {
  /** An issue in a named milestone family, so two can be mixed in one read. */
  const fam = (number: number, family: string, phase: number): DepIssue => ({
    number,
    title: `issue ${number}`,
    state: "OPEN",
    milestone: `${family} Phase ${phase} — a heading`,
    blockedBy: [],
  });

  // Each family declares one link; the narrowing decides which a run writes.
  function spy(issues: DepIssue[]) {
    const calls: string[] = [];
    const gh: PlanDepsGitHub = {
      createClient: (() => ({}) as never) as PlanDepsGitHub["createClient"],
      readIssues: async () => issues,
      readPlans: declaring([11, 10], [21, 20], [41, 40]),
      addBlockers: async (_repo, blocked, blockers) => {
        calls.push(`#${blocked} +${[...blockers].join(",")}`);
      },
    };
    return { gh, calls };
  }

  const MIXED = [fam(10, "Pipeline", 0), fam(11, "Pipeline", 1), fam(20, "Other", 0), fam(21, "Other", 1)];

  test("OMITTING it refuses — an unscoped run is the defect, not the default (#1728)", async () => {
    // This case previously asserted the opposite: that omitting the flag
    // sequenced both families together, recorded so that "adding the flag
    // cannot silently change the default for every existing caller."
    // #1728 measured what that default costs — a `--write` with no prefix
    // resolved 89 edges across 38 issues spanning `Pipeline Phase 0..9`
    // and `Convergence Phase 0..6`, and `board-conformance --prefix
    // Pipeline` scores only the first, so `blocked-by-edges` fell 12 of 12
    // to 4 of 12 on edges the reading cannot resolve.
    //
    // There is no caller to protect: no workflow, script or CI job invokes
    // `plan-deps`, and `lib/cli-commands.ts`'s usage string never listed
    // the flag. `plan-spec` and `board-snapshot` both REQUIRE `--prefix`
    // for the reason plan-spec states — deriving the family silently calls
    // the live milestones something they are not. This makes the third
    // tool agree, which is the Stage B retro improvement "two tools that
    // write the same board agree about which issues ARE the board".
    for (const argv of [
      ["--repo", "o/r", "--write"],
      ["--repo", "o/r"], // the dry run misleads too — it is what you read before writing
    ]) {
      const s = spy(MIXED);
      expect(await planDepsMain(argv, s.gh), `${argv.join(" ")} was accepted`).toBe(REFUSAL_EXIT);
      expect(s.calls, "an unscoped run wrote edges across both families").toEqual([]);
    }
  });

  test("with it, only that family is read and only its edges are written", async () => {
    const s = spy(MIXED);
    expect(await planDepsMain(["--repo", "o/r", "--write", "--milestone-prefix", "Pipeline"], s.gh)).toBe(0);
    expect(s.calls).toEqual(["#11 +10"]);
  });

  test("every near miss is OUT — no milestone, the prefix mid-title, or a LONGER family name", async () => {
    // The last row is round 2 of #1703: a bare `startsWith` admits any
    // family whose name begins with this one, which is the contamination
    // the flag exists to prevent arriving through the fix for it.
    const s = spy([
      ...MIXED,
      { number: 30, title: "issue 30", state: "OPEN", milestone: null, blockedBy: [] },
      { number: 31, title: "issue 31", state: "OPEN", milestone: "Not Pipeline Phase 1 — mid-title", blockedBy: [] },
      { number: 32, title: "issue 32", state: "OPEN", milestone: "Pipelines Phase 1 — a longer name", blockedBy: [] },
      { number: 33, title: "issue 33", state: "OPEN", milestone: "Pipeline — no phase at all", blockedBy: [] },
    ]);
    expect(await planDepsMain(["--repo", "o/r", "--write", "--milestone-prefix", "Pipeline"], s.gh)).toBe(0);
    expect(s.calls).toEqual(["#11 +10"]);
  });

  test("a prefix that is a PREFIX of the real family name matches nothing", async () => {
    // `--milestone-prefix Pipe` against `Pipeline Phase N` used to admit
    // the whole family and sequence it as if it were the caller's own.
    const s = spy(MIXED);
    expect(await planDepsMain(["--repo", "o/r", "--write", "--milestone-prefix", "Pipe"], s.gh)).toBe(
      REFUSAL_EXIT,
    );
    expect(s.calls, "a truncated prefix sequenced another family's issues").toEqual([]);
  });

  test('an EMPTY prefix refuses — it is not "no filter requested"', async () => {
    // Round 1 of #1703. `"".startsWith("")` is true for every string,
    // including the `""` a null milestone normalises to, so
    // `--milestone-prefix "$X"` with $X unset quietly re-admits every
    // spec's issues and reports success — the exact contamination the
    // flag exists to prevent.
    for (const empty of ["", "   "]) {
      const s = spy(MIXED);
      expect(
        await planDepsMain(["--repo", "o/r", "--write", "--milestone-prefix", empty], s.gh),
        `--milestone-prefix ${JSON.stringify(empty)} was accepted`,
      ).toBe(REFUSAL_EXIT);
      expect(s.calls, "an empty prefix wrote the unfiltered population").toEqual([]);
    }

    // The control, and it had to change shape when #1728 made an omitted
    // flag a refusal too. It used to be "omitting it still writes", which
    // can no longer distinguish anything. A VALID prefix still writing is
    // what rules out a guard that refuses every run — the property the
    // old control was actually buying.
    const valid = spy(MIXED);
    expect(await planDepsMain(["--repo", "o/r", "--write", "--milestone-prefix", "Pipeline"], valid.gh)).toBe(0);
    expect(valid.calls.length).toBeGreaterThan(0);
  });

  test("a prefix matching nothing says THAT, not 'no issues were read'", async () => {
    // The exit code alone cannot carry this: an unknown-flag refusal, an
    // empty repository and a typo'd prefix are all 1, and only one of them
    // is about the prefix. A reader told "an empty repository and a failed
    // fetch produce the same empty edge list" goes and checks the API.
    const s = spy(MIXED);
    const said: string[] = [];
    const err = console.error;
    console.error = (...a: unknown[]) => void said.push(a.join(" "));
    try {
      expect(await planDepsMain(["--repo", "o/r", "--write", "--milestone-prefix", "Nope"], s.gh)).toBe(
        REFUSAL_EXIT,
      );
    } finally {
      console.error = err;
    }
    expect(s.calls, "a prefix that matched nothing still wrote").toEqual([]);
    const text = said.join("\n");
    expect(text).toContain('"Nope"');
    expect(text).toContain("4 issue(s) were read");
    expect(text, "it blamed the read for what the filter did").not.toContain("no issues were read");
  });

  /**
   * Round 1 of #1705. The emptiness guard tested `prefix.trim() === ""` and
   * the filter then used the UNTRIMMED value, so the two disagreed about
   * every input with whitespace on an end: `" Pipeline"` passes the guard,
   * matches nothing, and refuses with a message naming a string that looks
   * like it should obviously match.
   *
   * The pair of cases below is the point. Trimming only the GUARD is the
   * state this is leaving; trimming only the FILTER would accept `"   "` and
   * silently sequence every family. One trimmed reading feeds both.
   */
  test("a prefix with whitespace on an end is TRIMMED, not refused for matching nothing", async () => {
    for (const padded of [" Pipeline", "Pipeline ", "  Pipeline  ", "\tPipeline\n"]) {
      const s = spy(MIXED);
      expect(
        await planDepsMain(["--repo", "o/r", "--write", "--milestone-prefix", padded], s.gh),
        `--milestone-prefix ${JSON.stringify(padded)} was refused`,
      ).toBe(0);
      expect(s.calls, `${JSON.stringify(padded)} did not reach the Pipeline family`).toEqual([
        "#11 +10",
      ]);
    }
  });

  test("trimming touches the ENDS only — a family name with a space inside survives", async () => {
    // The control for the case above. `replaceAll(" ", "")` and a
    // `trim()`-shaped fix are the same on every input there; this input
    // separates them, and a prefix of two words is the ordinary case on a
    // tracker carrying more than one spec.
    const s = spy([
      { number: 40, title: "issue 40", state: "OPEN", milestone: "Spec Two Phase 0 — a", blockedBy: [] },
      { number: 41, title: "issue 41", state: "OPEN", milestone: "Spec Two Phase 1 — b", blockedBy: [] },
    ]);
    expect(await planDepsMain(["--repo", "o/r", "--write", "--milestone-prefix", " Spec Two "], s.gh)).toBe(0);
    expect(s.calls).toEqual(["#41 +40"]);
  });
});

/**
 * `--json` is a CONTRACT, and a refusal has to keep it — round 1 of #1705.
 *
 * `--json` is documented as "the whole plan, for something other than a
 * person". Four refusals returned before the `--json` block, so a caller
 * doing `JSON.parse(stdout)` got an empty string and a crash where it should
 * have got a structured `wrote: "refused"` payload. The UNMEASURED-from-
 * `dependencyPlan` case already honoured both channels; these four did not,
 * which is the population.
 *
 * Each case asserts the payload PARSES and says which refusal it was. An
 * exit code cannot carry that: all four are 1.
 */
describe("scripts/plan-deps --json: every refusal reaches the channel the caller asked for", () => {
  function spy(issues: DepIssue[]) {
    const calls: string[] = [];
    const gh: PlanDepsGitHub = {
      createClient: (() => ({}) as never) as PlanDepsGitHub["createClient"],
      readIssues: async () => issues,
      readPlans: declaring([11, 10]),
      addBlockers: async (_repo, blocked, blockers) => {
        calls.push(`#${blocked} +${[...blockers].join(",")}`);
      },
    };
    return { gh, calls };
  }

  const MIXED: DepIssue[] = [
    { number: 10, title: "issue 10", state: "OPEN", milestone: "Pipeline Phase 0 — a", blockedBy: [] },
    { number: 11, title: "issue 11", state: "OPEN", milestone: "Pipeline Phase 1 — b", blockedBy: [] },
  ];

  /** Runs `main` with both channels captured, so neither can hide. */
  async function run(argv: string[], gh: PlanDepsGitHub) {
    const out: string[] = [];
    const err: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    console.error = (...a: unknown[]) => void err.push(a.join(" "));
    try {
      const code = await planDepsMain(argv, gh);
      return { code, stdout: out.join("\n"), stderr: err.join("\n") };
    } finally {
      console.log = log;
      console.error = error;
    }
  }

  const REFUSALS: { why: string; argv: string[]; names: string }[] = [
    { why: "an unparseable argument", argv: ["--repo", "o/r", "--nonsense"], names: "nonsense" },
    { why: "no --repo", argv: [], names: "--repo" },
    { why: "a blank --milestone-prefix", argv: ["--repo", "o/r", "--milestone-prefix", "   "], names: "blank" },
    {
      why: "a --milestone-prefix matching nothing",
      argv: ["--repo", "o/r", "--milestone-prefix", "Nope"],
      names: "Nope",
    },
  ];

  for (const r of REFUSALS) {
    test(`${r.why} still emits a parseable payload under --json`, async () => {
      const s = spy(MIXED);
      const saved = process.env.GITHUB_REPOSITORY;
      delete process.env.GITHUB_REPOSITORY;
      let got;
      try {
        got = await run([...r.argv, "--json", "--write"], s.gh);
      } finally {
        if (saved !== undefined) process.env.GITHUB_REPOSITORY = saved;
      }
      expect(got.code, "the refusal stopped reporting a failure").toBe(REFUSAL_EXIT);
      expect(s.calls, "a refusal still wrote").toEqual([]);

      let payload: { wrote?: string; reading?: string; unmeasuredReasons?: string[] };
      try {
        payload = JSON.parse(got.stdout);
      } catch {
        throw new Error(
          `--json refusal (${r.why}) put nothing parseable on stdout. stdout was ` +
            `${JSON.stringify(got.stdout)}; stderr was ${JSON.stringify(got.stderr)}`,
        );
      }
      expect(payload.wrote, "the payload did not say the write was refused").toBe("refused");
      expect(payload.reading).toBe("UNMEASURED");
      expect(
        (payload.unmeasuredReasons ?? []).join(" "),
        "the payload refused without saying which refusal it was",
      ).toContain(r.names);
    });
  }

  test("the blank refusal's advice is one the tool accepts — no circle", async () => {
    // Found in review of #1730. The blank-prefix message was written when an
    // omitted flag meant "no filter", and said so: "omit the flag if you
    // meant no filter." This PR makes an omitted flag a refusal, so a caller
    // who followed that sentence was sent straight into the next refusal and
    // round-tripped between two error messages with no way out.
    //
    // Both halves are run rather than asserted about, because the defect is
    // precisely that the advice and the behaviour disagreed and each was
    // individually correct.
    const saved = process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPOSITORY;
    try {
      const blank = await run(["--repo", "o/r", "--milestone-prefix", "   "], spy(MIXED).gh);
      const omitted = await run(["--repo", "o/r"], spy(MIXED).gh);
      expect(blank.code, "the blank refusal stopped refusing").toBe(REFUSAL_EXIT);

      // The premise. If omitting were accepted the advice would be fine and
      // this case would be asserting a style preference.
      expect(
        omitted.code,
        "omitting the flag is accepted, so the blank message's advice works and " +
          "this case is measuring nothing",
      ).toBe(REFUSAL_EXIT);

      // So the blank message may not send the caller there.
      expect(
        blank.stderr.toLowerCase(),
        "the blank refusal still tells the caller to omit a flag the very next " +
          "check refuses — following the advice reaches the absent-prefix " +
          "refusal and the caller is in a loop between two error messages",
      ).not.toContain("omit the flag");

      // And it must name the remedy that does work, or the caller is told
      // what not to do and nothing else. Deleting the advice is the cheapest
      // wrong fix for the assertion above.
      expect(
        blank.stderr,
        "the blank refusal names no working remedy — it says the prefix is blank " +
          "and leaves the caller to guess",
      ).toContain("--milestone-prefix");
      expect(blank.stderr).toMatch(/--milestone-prefix \w/);
    } finally {
      if (saved !== undefined) process.env.GITHUB_REPOSITORY = saved;
    }
  });

  /**
   * Round 2 of #1705. `readLiveIssues` throws rather than returning an empty
   * list — a caller that cannot tell "no issues" from "the call failed"
   * reports the flattering one. Nothing caught it here, so a bad token, a
   * rate limit or an outage left `main()` rejecting: a stack trace on
   * stderr and an EMPTY stdout, which under `--json` is the same crash the
   * four cases above exist to stop, on the input that needs the payload
   * most.
   */
  const THROWS: PlanDepsGitHub = {
    createClient: (() => ({}) as never) as PlanDepsGitHub["createClient"],
    readIssues: async () => {
      throw new Error("gh: HTTP 403 — Bad credentials");
    },
    readPlans: declaring(),
    addBlockers: async () => {},
  };

  // Every case below passes `--milestone-prefix`, and that is not noise: the
  // prefix is resolved BEFORE the network read (review of #1730), so a run
  // that omits it never reaches the read at all. The case that asserts that
  // ordering is at the bottom of this block.
  test("a FAILED issue read refuses on the --json channel, not as a rejection", async () => {
    const got = await run(["--repo", "o/r", "--json", "--write", "--milestone-prefix", "Pipeline"], THROWS);
    expect(got.code).toBe(REFUSAL_EXIT);
    const payload = JSON.parse(got.stdout);
    expect(payload.wrote).toBe("refused");
    expect(payload.reading).toBe("UNMEASURED");
    expect(
      payload.unmeasuredReasons.join(" "),
      "the payload refused without naming what the API said",
    ).toContain("403");
  });

  test("the same failure on the TEXT channel says so too, and is not a stack trace", async () => {
    const got = await run(["--repo", "o/r", "--write", "--milestone-prefix", "Pipeline"], THROWS);
    expect(got.code).toBe(REFUSAL_EXIT);
    expect(got.stdout.trim()).toBe("");
    expect(got.stderr).toContain("403");
    expect(got.stderr, "a failed read was reported as an empty repository").not.toContain(
      "0 issue(s) read",
    );
  });

  test("a client that cannot be built is the same refusal, not a rejection", async () => {
    // `createClient` is the other call on this path that can throw, and a
    // repair of only the one the finding named leaves it. Both go through
    // the same guard.
    const noClient: PlanDepsGitHub = {
      createClient: (() => {
        throw new Error("no GITHUB_TOKEN in the environment");
      }) as PlanDepsGitHub["createClient"],
      readIssues: async () => MIXED,
      readPlans: declaring(),
      addBlockers: async () => {},
    };
    const got = await run(["--repo", "o/r", "--json", "--milestone-prefix", "Pipeline"], noClient);
    expect(got.code).toBe(REFUSAL_EXIT);
    expect(JSON.parse(got.stdout).unmeasuredReasons.join(" ")).toContain("GITHUB_TOKEN");
  });

  test("a MISSING prefix is refused BEFORE the read, so the message is the actionable one", async () => {
    // Review of #1730. With the prefix check below the read, the one mistake
    // #1728 exists to catch reports as "the issues could not be read" on any
    // tree whose `gh` cannot authenticate — the API's problem, not the
    // caller's, and the actionable sentence never arrives.
    //
    // Both assertions are needed and neither implies the other. The message
    // alone would pass if the read ran and threw and something downstream
    // re-refused; `calls === 0` alone would pass if the refusal said the
    // wrong thing. A static argument check must not depend on the network.
    let calls = 0;
    const counted: PlanDepsGitHub = {
      createClient: (() => ({}) as never) as PlanDepsGitHub["createClient"],
      readIssues: async () => {
        calls++;
        throw new Error("gh: HTTP 403 — Bad credentials");
      },
      readPlans: declaring(),
      addBlockers: async () => {},
    };
    const got = await run(["--repo", "o/r", "--json"], counted);
    expect(got.code).toBe(REFUSAL_EXIT);
    const reasons = JSON.parse(got.stdout).unmeasuredReasons.join(" ");
    expect(reasons).toContain("--milestone-prefix is required");
    expect(reasons, "the API's failure was reported instead of the caller's").not.toContain("403");
    expect(calls, "the network was read before a static argument was checked").toBe(0);
  });

  test("the text header NAMES the scope it measured, both counts and the prefix", async () => {
    // Review of #1730, round 3. Two `prefix === undefined` branches were
    // left behind when the flag became required, and deleting both broke
    // no test — so nothing asserted this line at all, which is why a dead
    // branch could sit in it reading as a reachable unscoped path.
    //
    // Three facts, because the filtered count alone cannot show that a
    // filter ran: MIXED carries issues from two families, so `read` and
    // `issues` must differ here. A header that printed one number twice
    // would pass an assertion naming only the total.
    // A LOCAL fixture, not the `MIXED` in this describe — that one is
    // Pipeline-only, so it cannot show a filter narrowing anything.
    const families: DepIssue[] = [
      { number: 10, title: "issue 10", state: "OPEN", milestone: "Pipeline Phase 0 — a", blockedBy: [] },
      { number: 11, title: "issue 11", state: "OPEN", milestone: "Pipeline Phase 1 — b", blockedBy: [] },
      { number: 20, title: "issue 20", state: "OPEN", milestone: "Convergence Phase 0 — c", blockedBy: [] },
    ];
    const scoped = families.filter(i => (i.milestone ?? "").startsWith("Pipeline")).length;
    expect(scoped, "the fixture stopped mixing families, so this case cannot see a filter run")
      .toBeLessThan(families.length);

    const got = await run(["--repo", "o/r", "--milestone-prefix", "Pipeline"], spy(families).gh);
    expect(got.code, got.stderr).toBe(0);
    expect(got.stdout).toContain(`${scoped} issue(s) read`);
    expect(got.stdout).toContain(`of ${families.length}, narrowed to milestones starting "Pipeline"`);
  });

  test("the follow-up `plan-issues --repair` PRINTS is a command this still accepts", async () => {
    // Review of #1730, round 2. Making the flag required made somebody
    // else's advice stale: `plan-issues --write` prints a `plan-deps` line
    // as the exact next step, and that line carried no prefix, so a reader
    // who followed it got a refusal. Advice that cannot run is worse than
    // none — the reader learns it is stale only after acting on it.
    //
    // The printed string is READ OUT OF THE SOURCE and executed here
    // rather than copied into an expectation. A `toContain` would hold
    // just as well against a line that is stale in some NEW way, which is
    // the whole failure mode: this asserts the command runs, not that it
    // looks like it used to.
    const src = await Bun.file(join(import.meta.dir, "..", "scripts", "plan-issues.ts")).text();
    const printed = src.match(/rungate plan-deps ([^`\n\\]*)/);
    expect(printed, "plan-issues no longer prints a plan-deps follow-up — delete this case or follow it").not.toBeNull();

    const argv = printed![1]!
      .trim()
      .split(/\s+/)
      // The two placeholders the printed line carries. `${repo}` is a
      // template hole in the source; `<name>` is deliberate, because a
      // repair cannot know which family the issues that STAYED belong to.
      .map(a => (a === "${repo}" ? "o/r" : a === "<name>" ? "Pipeline" : a));

    const s = spy(MIXED);
    const got = await run(argv, s.gh);
    expect(
      got.code,
      `the follow-up plan-issues prints is refused by plan-deps:\n  rungate plan-deps ${argv.join(" ")}\n${got.stderr}`,
    ).toBe(0);
  });

  test("the control: a read that SUCCEEDS is not reported as a failed one", async () => {
    const got = await run(["--repo", "o/r", "--json", "--milestone-prefix", "Pipeline"], spy(MIXED).gh);
    expect(got.code).toBe(0);
    expect(JSON.parse(got.stdout).reading).toBe("MEASURED");
  });

  test("WITHOUT --json those same four stay on stderr and leave stdout empty", async () => {
    // The control. A fix that emits JSON unconditionally passes every case
    // above and breaks every human caller, and nothing above can see it.
    const saved = process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPOSITORY;
    try {
      for (const r of REFUSALS) {
        const s = spy(MIXED);
        const got = await run([...r.argv, "--write"], s.gh);
        expect(got.code).toBe(REFUSAL_EXIT);
        expect(got.stdout.trim(), `${r.why} printed a payload nobody asked for`).toBe("");
        expect(got.stderr, `${r.why} said nothing on stderr`).toContain(r.names);
      }
    } finally {
      if (saved !== undefined) process.env.GITHUB_REPOSITORY = saved;
    }
  });

  test("a SOUND --json run is unchanged — same keys, and `wrote` is not `refused`", async () => {
    // Without this, a refusal payload that happens to be well-formed proves
    // nothing about the shape a consumer actually switches on.
    const s = spy(MIXED);
    const got = await run(["--repo", "o/r", "--json", "--write", "--milestone-prefix", "Pipeline"], s.gh);
    expect(got.code).toBe(0);
    const payload = JSON.parse(got.stdout);
    expect(payload.wrote).toBe("yes");
    expect(payload.reading).toBe("MEASURED");
    for (const key of ["reading", "unmeasuredReasons", "phases", "missing", "present", "extra", "results", "wrote"]) {
      expect(Object.keys(payload), `the success payload lost \`${key}\``).toContain(key);
    }
  });

  test("the refusal payload carries every key the success payload does", async () => {
    // A consumer reading `.missing.length` on a refusal must get `[]`, not a
    // TypeError. The two shapes are asserted against each other rather than
    // against a hand-copied list, so neither can drift alone.
    const sound = await run(["--repo", "o/r", "--json", "--milestone-prefix", "Pipeline"], spy(MIXED).gh);
    const refused = await run(["--repo", "o/r", "--json", "--milestone-prefix", "Nope"], spy(MIXED).gh);
    const soundKeys = Object.keys(JSON.parse(sound.stdout)).sort();
    const refusedKeys = Object.keys(JSON.parse(refused.stdout)).sort();
    expect(refusedKeys).toEqual(soundKeys);
  });
});

/**
 * The live Convergence set on 2026-11-18, as the regression control for
 * ADR-021: 39 issues over seven phases. Phase order wrote 194 links over 37
 * blocked issues here, so 31 of 37 open issues waited on nothing anyone
 * wrote. Nothing declared among them is zero links, and the two hand-written
 * within-phase links stay as EXTRA.
 */
describe("SC-2606: the live Convergence shape — phase order alone is zero links, not 194", () => {
  const phaseSizes = [2, 6, 8, 4, 3, 10, 6];
  const issues: DepIssue[] = [];
  let next = 1;
  phaseSizes.forEach((size, phase) => {
    for (let k = 0; k < size; k++) issues.push(iss(next++, phase));
  });

  test("nothing declared: no link missing, and the frontier is still reported", () => {
    const plan = dependencyPlan(issues, []);
    expect(plan.reading).toBe("MEASURED");
    expect(plan.missing).toEqual([]);
    expect(plan.phases).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(plan.frontier).toBe(0);
  });

  test("hand-written links are EXTRA and nothing removes them", () => {
    const withHand = issues.map(i => (i.number === 12 ? { ...i, blockedBy: [11] } : i));
    const plan = dependencyPlan(withHand, []);
    expect(keys(plan.extra)).toEqual(["12<-11"]);
    expect(plan.missing).toEqual([]);
  });
});

/**
 * `board: { phaseOrder: false }`: a family whose spec opts out gets no
 * phase-order links. Jason's call of 2026-11-17, a stopgap ahead of #2331:
 * there, phases set priority and only real blocked-by links hold work back.
 */
describe("phaseOrder: false — a family that opts out of phase-order links", () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("fs") as typeof import("fs");
  const { tmpdir } = require("os") as typeof import("os");
  const spec = (board: string) => `---\ndoc-type: spec\nboard: ${board}\n---\n\n# A spec\n\n- [ ] SC-9401: one\n`;
  const tree = (specs: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), "plan-deps-phase-order-"));
    mkdirSync(join(root, "specs"), { recursive: true });
    for (const [name, text] of Object.entries(specs)) writeFileSync(join(root, "specs", name), text);
    return root;
  };
  const spy = () => {
    const calls: string[] = [];
    let read = 0;
    const gh: PlanDepsGitHub = {
      createClient: (() => ({}) as never) as PlanDepsGitHub["createClient"],
      readIssues: async () => {
        read++;
        return [iss(10, 0), iss(20, 1)];
      },
      readPlans: declaring([20, 10]),
      addBlockers: async (_repo, blocked, blockers) => void calls.push(`#${blocked} +${[...blockers].join(",")}`),
    };
    return { gh, calls, reads: () => read };
  };
  async function run(argv: string[], gh: PlanDepsGitHub) {
    const out: string[] = [];
    const [log, err] = [console.log, console.error];
    console.log = (x: string) => void out.push(String(x));
    console.error = (x: string) => void out.push(String(x));
    try {
      return { code: await planDepsMain(argv, gh), text: out.join("\n") };
    } finally {
      [console.log, console.error] = [log, err];
    }
  }

  test("the family's spec says phaseOrder: false — nothing is written, one line says why, exit 0", async () => {
    const root = tree({ "C-SPEC.md": spec("{ scope: active, prefix: Convergence, phaseOrder: false }") });
    try {
      const s = spy();
      const got = await run(["--repo", "o/r", "--write", "--milestone-prefix", "Convergence", "--project-root", root], s.gh);
      expect(got.code, got.text).toBe(0);
      expect(s.calls).toEqual([]);
      expect(got.text).toContain("Convergence: specs/C-SPEC.md declares board.phaseOrder: false, so no phase-order links are written");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the control: the same family with the key absent, or true, writes its declared links as before", async () => {
    for (const board of ["{ scope: active, prefix: Convergence }", "{ scope: active, prefix: Convergence, phaseOrder: true }"]) {
      const root = tree({ "C-SPEC.md": spec(board) });
      try {
        const s = spy();
        const got = await run(["--repo", "o/r", "--write", "--milestone-prefix", "Convergence", "--project-root", root], s.gh);
        expect(got.code, got.text).toBe(0);
        expect(s.calls, board).toEqual(["#20 +10"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("another family's opt-out changes nothing for this one", async () => {
    const root = tree({
      "C-SPEC.md": spec("{ scope: active, prefix: Convergence }"),
      "R-SPEC.md": spec("{ scope: active, prefix: Refresh, phaseOrder: false }"),
    });
    try {
      const s = spy();
      await run(["--repo", "o/r", "--write", "--milestone-prefix", "Convergence", "--project-root", root], s.gh);
      expect(s.calls).toEqual(["#20 +10"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("two specs of one family that disagree refuse, before anything is read or written", async () => {
    const root = tree({
      "A-SPEC.md": spec("{ scope: active, prefix: Convergence, phaseOrder: false }"),
      "B-SPEC.md": spec("{ scope: active, prefix: Convergence, phaseOrder: true }"),
    });
    try {
      const s = spy();
      const got = await run(["--repo", "o/r", "--write", "--milestone-prefix", "Convergence", "--project-root", root], s.gh);
      expect(got.code).toBe(REFUSAL_EXIT);
      expect(got.text).toContain("specs/A-SPEC.md says false and specs/B-SPEC.md says true");
      expect(s.calls).toEqual([]);
      expect(s.reads(), "the tracker was read for a family whose setting cannot be read").toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Review of #2352: three readings the first round let through.
  test("a value that is neither true nor false refuses by name, never reads as on", async () => {
    for (const value of ["flase", "no"]) {
      const root = tree({ "C-SPEC.md": spec(`{ scope: active, prefix: Convergence, phaseOrder: ${value} }`) });
      try {
        const s = spy();
        const got = await run(["--repo", "o/r", "--write", "--milestone-prefix", "Convergence", "--project-root", root], s.gh);
        expect(got.code, value).toBe(REFUSAL_EXIT);
        expect(got.text).toContain("specs/C-SPEC.md");
        expect(got.text).toContain("phaseOrder");
        expect(s.calls).toEqual([]);
        expect(s.reads()).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("a deferred spec carrying the family's prefix does not decide its phase order", async () => {
    const root = tree({
      "C-SPEC.md": spec("{ scope: active, prefix: Convergence }"),
      "OLD-SPEC.md": spec("{ scope: deferred, prefix: Convergence, phaseOrder: false }"),
    });
    try {
      const s = spy();
      const got = await run(["--repo", "o/r", "--write", "--milestone-prefix", "Convergence", "--project-root", root], s.gh);
      expect(got.code, got.text).toBe(0);
      expect(s.calls).toEqual(["#20 +10"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a deferred spec's bad value does not block the active family (review of #2352, round 2)", async () => {
    const root = tree({
      "C-SPEC.md": spec("{ scope: active, prefix: Convergence }"),
      "OLD-SPEC.md": spec("{ scope: deferred, prefix: Convergence, phaseOrder: flase }"),
    });
    try {
      const s = spy();
      const got = await run(["--repo", "o/r", "--write", "--milestone-prefix", "Convergence", "--project-root", root], s.gh);
      expect(got.code, got.text).toBe(0);
      expect(s.calls).toEqual(["#20 +10"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a spec that cannot be read refuses as UNMEASURED, naming it, instead of throwing", async () => {
    const root = tree({
      "C-SPEC.md": spec("{ scope: active, prefix: Convergence }"),
      "BROKEN-SPEC.md": spec("{ scope: active, prefix: Other }"),
    });
    // Listed by the sweep, refused by the read: no permission to open it.
    require("fs").chmodSync(join(root, "specs", "BROKEN-SPEC.md"), 0o000);
    try {
      const s = spy();
      const got = await run(["--repo", "o/r", "--write", "--milestone-prefix", "Convergence", "--project-root", root], s.gh);
      expect(got.code).toBe(REFUSAL_EXIT);
      expect(got.text).toContain("UNMEASURED");
      expect(got.text).toContain("BROKEN-SPEC.md");
      expect(s.reads()).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * #2413 — a finished family is not a misspelled prefix.
 *
 * asaCommandCenter's specs-placed.yml run 44314945951 (rungate 0.8.31): the
 * CI family's milestones CI Phase 1-3 exist and every issue in them is
 * closed. plan-deps reads open issues only, matched none, refused UNMEASURED
 * as "a prefix matching nothing", and the workflow went red on every push to
 * specs/. The milestones are the tie-breaker: a family whose milestones exist
 * has nothing left to order; a prefix no milestone carries is still the typo
 * the refusal was written for; and a milestone list that cannot be read
 * decides nothing.
 */
describe("#2413: a family whose milestones hold no open issue reads nothing to order", () => {
  const OTHER: DepIssue[] = [
    { number: 50, title: "issue 50", state: "OPEN", milestone: "Pipeline Phase 0 — a", blockedBy: [] },
    { number: 51, title: "issue 51", state: "OPEN", milestone: "Pipeline Phase 1 — b", blockedBy: [] },
  ];
  const TITLES = ["CI Phase 1 — lint", "CI Phase 2 — test", "CI Phase 3 — deploy", "Pipeline Phase 0 — a"];

  function spy(readMilestoneTitles?: PlanDepsGitHub["readMilestoneTitles"]) {
    const calls: string[] = [];
    const gh: PlanDepsGitHub = {
      createClient: (() => ({}) as never) as PlanDepsGitHub["createClient"],
      readIssues: async () => OTHER,
      readPlans: declaring(),
      addBlockers: async (_repo, blocked, blockers) => void calls.push(`#${blocked} +${[...blockers].join(",")}`),
      ...(readMilestoneTitles ? { readMilestoneTitles } : {}),
    };
    return { gh, calls };
  }

  async function run(argv: string[], gh: PlanDepsGitHub) {
    const out: string[] = [];
    const err: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    console.error = (...a: unknown[]) => void err.push(a.join(" "));
    try {
      const code = await planDepsMain(argv, gh);
      return { code, stdout: out.join("\n"), stderr: err.join("\n") };
    } finally {
      console.log = log;
      console.error = error;
    }
  }

  test("the family's milestones exist and hold no open issue: exit 0, nothing written, and it says why", async () => {
    const s = spy(async () => TITLES);
    const r = await run(["--repo", "o/r", "--write", "--milestone-prefix", "CI"], s.gh);
    expect(r.code).toBe(0);
    expect(s.calls).toEqual([]);
    expect(r.stdout).toContain("nothing to order");
    expect(r.stdout).toContain('3 milestone(s) start with "CI"');
    expect(r.stderr, "a finished family was reported as UNMEASURED").not.toContain("UNMEASURED");
  });

  test("--json carries the same reading, and it parses", async () => {
    const s = spy(async () => TITLES);
    const r = await run(["--repo", "o/r", "--write", "--json", "--milestone-prefix", "CI"], s.gh);
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout);
    // Its own reading: no issue was considered at all (review of #2414).
    expect(payload.reading).toBe("NOTHING_TO_ORDER");
    expect(payload.wrote).toBe("nothing-to-order");
    expect(payload.milestones).toEqual(["CI Phase 1 — lint", "CI Phase 2 — test", "CI Phase 3 — deploy"]);
    // Every key the other readings carry, so a consumer can read any unconditionally (review of #2414).
    expect(payload).toMatchObject({ unmeasuredReasons: [], phases: [], missing: [], present: [], extra: [], unphased: [], frontier: null, results: [] });
  });

  test("no milestone starts with the prefix: still the typo refusal", async () => {
    const s = spy(async () => TITLES);
    const r = await run(["--repo", "o/r", "--write", "--milestone-prefix", "Nope"], s.gh);
    expect(r.code).toBe(REFUSAL_EXIT);
    expect(s.calls).toEqual([]);
    expect(r.stderr).toContain("That is a prefix matching nothing");
  });

  test("a milestone list that cannot be read refuses, and never reads as nothing to order", async () => {
    const s = spy(async () => {
      throw new Error("HTTP 502");
    });
    const r = await run(["--repo", "o/r", "--write", "--milestone-prefix", "CI"], s.gh);
    expect(r.code).toBe(REFUSAL_EXIT);
    expect(r.stderr).toContain("UNMEASURED");
    expect(r.stderr).toContain("HTTP 502");
    expect(r.stdout).not.toContain("nothing to order");
  });
});
