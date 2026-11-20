/**
 * #2490: when a criterion's last open issue closes and the criterion is still
 * unticked, `rungate criterion-successor` files one successor issue naming it,
 * in the criterion's phase milestone. Serves SC-2625 without completing it:
 * every successor so far was filed and milestoned by hand (#2437, #2463), and
 * each hand milestone is an edit SC-2625's reading counts.
 *
 * Which criteria are owed is `declaredWorkUnaccounted`, the reading
 * `declared-work` takes, so the command and the board cannot disagree about
 * what is uncovered. The planner is pure; the command is driven end to end
 * over a real spec in a temporary tree, with GitHub injected.
 *
 * Criterion ids here are `TST-N`: the parsers accept any `PREFIX-N`, and these
 * name no criterion of this repository.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { CLI_COMMANDS } from "../lib/cli-commands";
import { planSuccessors, successorTitle, sweepSuccessors } from "../lib/criterion-successor";
import { REFUSAL_EXIT, main, type SuccessorGitHub } from "../scripts/criterion-successor";

const SPEC = [
  "---",
  "doc-type: spec",
  "testable: true",
  "board:",
  "  scope: active",
  "  prefix: Fixture",
  "---",
  "",
  "# Fixture spec",
  "",
  "## Success Criteria",
  "",
  "- [ ] TST-1: the first thing a consumer can observe is true",
  "- [x] TST-2: the second thing is true",
  "- [ ] TST-3: the third thing is true",
  "",
  "### Phase placement",
  "",
  "| Placement | Criteria |",
  "|---|---|",
  "| **Phase 1** | TST-1, TST-2 |",
  "| **Phase 2** | TST-3 |",
  "",
].join("\n");

const MILESTONES = [
  { number: 11, title: "Fixture Phase 1 — the first" },
  { number: 12, title: "Fixture Phase 2 — the second" },
  { number: 13, title: "Other Phase 1 — another family" },
];

describe("#2490: planSuccessors decides which criteria a closed issue leaves owed by nobody", () => {
  const spec = (path: string) => (path === "specs/FIX.md" ? SPEC : null);

  test("the last open issue for an unticked criterion closes: one successor, naming it, in its phase milestone", () => {
    const plan = planSuccessors({ number: 5, names: ["TST-1"] }, [{ id: "TST-1", source: "specs/FIX.md" }], spec, MILESTONES);
    expect("why" in plan).toBe(false);
    if ("why" in plan) return;
    expect(plan.file).toHaveLength(1);
    const s = plan.file[0]!;
    expect(s.id).toBe("TST-1");
    expect(s.milestone).toEqual({ number: 11, title: "Fixture Phase 1 — the first" });
    expect(s.title).toBe(successorTitle("TST-1", "the first thing a consumer can observe is true"));
    expect(s.body).toContain("## Criteria this serves\n\nTST-1");
    expect(s.body).toContain("#5");
    expect(s.body).toContain("specs/FIX.md");
  });

  test("a criterion declared-work does not read as owed — ticked, or named by another open issue — gets none", () => {
    const plan = planSuccessors({ number: 5, names: ["TST-1", "TST-2"] }, [], spec, MILESTONES);
    expect(plan).toEqual({ file: [], leave: [expect.objectContaining({ id: "TST-1" }), expect.objectContaining({ id: "TST-2" })] });
  });

  test("only what the closed issue named: an owed criterion it did not name is not this run's to file", () => {
    const plan = planSuccessors({ number: 5, names: ["TST-1"] }, [{ id: "TST-1", source: "specs/FIX.md" }, { id: "TST-3", source: "specs/FIX.md" }], spec, MILESTONES);
    expect("file" in plan && plan.file.map(s => s.id)).toEqual(["TST-1"]);
  });

  test("an owed criterion with no milestone for its phase refuses the whole plan, naming it, rather than file it unplaced", () => {
    const plan = planSuccessors({ number: 5, names: ["TST-1", "TST-3"] }, [{ id: "TST-1", source: "specs/FIX.md" }, { id: "TST-3", source: "specs/FIX.md" }], spec, MILESTONES.filter(m => m.number !== 12));
    expect("why" in plan && plan.why).toContain("TST-3");
    expect("why" in plan && plan.why).toContain("phase 2 of the Fixture family");
  });

  // Review of #2534: indexing by id alone kept only the last spec, so the
  // other's owed criterion vanished from the plan without a word.
  test("an owed id two specs both state refuses, naming both, rather than keep one and drop the other", () => {
    const both = (path: string) => (path === "specs/FIX.md" || path === "specs/FIX2.md" ? SPEC : null);
    const plan = planSuccessors({ number: 5, names: ["TST-1"] }, [{ id: "TST-1", source: "specs/FIX.md" }, { id: "TST-1", source: "specs/FIX2.md" }], both, MILESTONES);
    expect("why" in plan && plan.why).toContain("specs/FIX.md and specs/FIX2.md both state it");
  });

  // #2535 (round 4 of #2534's review): two open milestones that both read as
  // the criterion's phase made `.find` pick the first, with no sign the
  // placement was a guess.
  test("two open milestones that read as one phase refuse, naming both, rather than file into the first", () => {
    const twice = [...MILESTONES, { number: 21, title: "Fixture Phase 1 — a stray duplicate" }];
    const plan = planSuccessors({ number: 5, names: ["TST-1"] }, [{ id: "TST-1", source: "specs/FIX.md" }], spec, twice);
    expect("file" in plan, "filed into one of two matching milestones").toBe(false);
    expect("why" in plan && plan.why).toContain("Fixture Phase 1 — the first");
    expect("why" in plan && plan.why).toContain("Fixture Phase 1 — a stray duplicate");
  });

  // The first live successor, #2544, was titled "CRC-N3: **Flag the class of
  // bug**, so …": a title is plain text, and GitHub prints the asterisks.
  test("a title drops the criterion's bold markers, and keeps its words and code spans", () => {
    expect(successorTitle("TST-1", "**Flag the class of bug**, so the author fixes `every` instance")).toBe(
      "TST-1: Flag the class of bug, so the author fixes `every` instance",
    );
    expect(successorTitle("TST-1", "__also__ this")).toBe("TST-1: also this");
    // Review of #2545: markers inside a code span are the code, not emphasis.
    expect(successorTitle("TST-1", "the module's `__init__` validates **input**")).toBe(
      "TST-1: the module's `__init__` validates input",
    );
  });

  test("a spec that cannot be read refuses rather than file a successor with no phase", () => {
    const plan = planSuccessors({ number: 5, names: ["TST-1"] }, [{ id: "TST-1", source: "specs/GONE.md" }], spec, MILESTONES);
    expect("why" in plan && plan.why).toContain("specs/GONE.md");
  });
});

describe("#2490: rungate criterion-successor, end to end over a real spec", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });
  const tree = () => {
    const root = mkdtempSync(join(tmpdir(), "rg-criterion-successor-"));
    made.push(root);
    mkdirSync(join(root, "specs"), { recursive: true });
    writeFileSync(join(root, "specs", "FIX.md"), SPEC);
    return root;
  };
  const gh = (over: Partial<{ closed: { number: number; state: string; title: string; body: string }; open: { number: number; title: string; body: string | null }[] }> = {}) => {
    const created: { title: string; body: string; milestone: number }[] = [];
    const api: SuccessorGitHub = {
      issue: async () => over.closed ?? { number: 5, state: "CLOSED", title: "the first thing", body: "## Criteria this serves\n\nTST-1, TST-2" },
      openIssues: async () => over.open ?? [],
      milestones: async () => MILESTONES,
      closedIssues: async () => [],
      createIssue: async (_repo, i) => {
        created.push(i);
        return 100 + created.length;
      },
    };
    return { api, created };
  };
  const run = async (argv: string[], root: string, api: SuccessorGitHub) => {
    const out: string[] = [];
    const log = console.log;
    const err = console.error;
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    console.error = (...a: unknown[]) => void out.push(a.join(" "));
    try {
      const code = await main(argv, root, api, { GITHUB_TOKEN: "t" });
      return { code, out: out.join("\n") };
    } finally {
      console.log = log;
      console.error = err;
    }
  };

  test("is a registered command that ships", () => {
    expect(CLI_COMMANDS["criterion-successor"]?.script).toBe("scripts/criterion-successor.ts");
  });

  test("with --write it files one successor for the unticked criterion, in its milestone, and none for the ticked one", async () => {
    const { api, created } = gh();
    const r = await run(["--issue", "5", "--repo", "o/n", "--write"], tree(), api);
    expect(r.code, r.out).toBe(0);
    expect(created).toHaveLength(1);
    expect(created[0]!.milestone).toBe(11);
    expect(created[0]!.body).toContain("## Criteria this serves\n\nTST-1");
    expect(r.out).toContain("filed #101");
  });

  test("without --write it files nothing and says what it would file", async () => {
    const { api, created } = gh();
    const r = await run(["--issue", "5", "--repo", "o/n"], tree(), api);
    expect(r.code, r.out).toBe(0);
    expect(created).toEqual([]);
    expect(r.out).toContain("would file");
    expect(r.out).toContain("TST-1");
  });

  test("another open issue still naming the criterion — or the first run's successor — means none is filed", async () => {
    const { api, created } = gh({ open: [{ number: 101, title: "TST-1: the first thing", body: "## Criteria this serves\n\nTST-1" }] });
    const r = await run(["--issue", "5", "--repo", "o/n", "--write"], tree(), api);
    expect(r.code, r.out).toBe(0);
    expect(created).toEqual([]);
  });

  // Review of #2534: a criterion an accepted, unmerged ADR plans is filed by
  // that ADR's merge, so it is not owed here either — the argument
  // board-snapshot passes to readDeclaredWork, passed the same way.
  test("a criterion an unmerged ADR already plans gets no successor, and the default reads that plan", async () => {
    const { api, created } = gh();
    const out: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    try {
      const code = await main(["--issue", "5", "--repo", "o/n", "--write"], tree(), api, { GITHUB_TOKEN: "t" }, () => new Map([["TST-1", "docs/adr/ADR-099.md"]]));
      expect(code, out.join("\n")).toBe(0);
    } finally {
      console.log = log;
    }
    expect(created).toEqual([]);
    const src = readFileSync(join(import.meta.dir, "..", "scripts", "criterion-successor.ts"), "utf-8");
    expect(src).toContain("r => plannedByUnmergedAdr(r, LIVE_GIT(r))");
    expect(src).toContain("readDeclaredWork(projectRoot, coverage.specs.map(placementRow), planned(projectRoot))");
  });

  test("an issue that is still open, a missing or malformed --issue, or no credential is refused before anything is filed", async () => {
    const root = tree();
    const open = gh({ closed: { number: 5, state: "OPEN", title: "x", body: "TST-1" } });
    expect((await run(["--issue", "5", "--repo", "o/n", "--write"], root, open.api)).code).toBe(REFUSAL_EXIT);
    expect(open.created).toEqual([]);
    for (const argv of [["--repo", "o/n"], ["--issue", "five", "--repo", "o/n"], ["--issue", "", "--repo", "o/n"]]) {
      const r = await run(argv, root, gh().api);
      expect(r.code, `${JSON.stringify(argv)}: ${r.out}`).toBe(REFUSAL_EXIT);
    }
    const out: string[] = [];
    const err = console.error;
    console.error = (...a: unknown[]) => void out.push(a.join(" "));
    try {
      expect(await main(["--issue", "5", "--repo", "o/n"], root, gh().api, {})).toBe(REFUSAL_EXIT);
    } finally {
      console.error = err;
    }
    expect(out.join("\n")).toMatch(/credential/);
  });
});

/**
 * #2541: an issue closed while criterion-label.yml missed its `closed` event
 * never got a successor — an Actions outage, a disabled workflow, a close from
 * before #2532. `--sweep` reads every criterion `declared-work` reads as owed,
 * cites the most recent closed issue that named it, and files the same
 * successor the per-issue path would. Raised in #2540's review.
 */
describe("#2541: planSuccessors over every owed criterion, citing the issue that last named it", () => {
  const spec = (path: string) => (path === "specs/FIX.md" ? SPEC : null);
  const owed = [
    { id: "TST-1", source: "specs/FIX.md" },
    { id: "TST-3", source: "specs/FIX.md" },
  ];

  test("each owed criterion gets one successor, citing its own last issue, in its own phase", () => {
    const plan = sweepSuccessors(owed, new Map([["TST-1", 7], ["TST-3", 6]]), spec, MILESTONES);
    expect("why" in plan, JSON.stringify(plan)).toBe(false);
    if ("why" in plan) return;
    expect(plan.file.map(f => [f.id, f.milestone.number])).toEqual([["TST-1", 11], ["TST-3", 12]]);
    expect(plan.file[0]!.body).toContain("#7");
    expect(plan.file[1]!.body).toContain("#6");
    // The per-issue body says "when #N closed"; a sweep files later, and says so.
    expect(plan.file[0]!.body).toContain("--sweep");
    expect(plan.file[0]!.body).not.toContain("when #7 closed");
  });

  test("an owed criterion no closed issue ever named is left, not filed: there is nothing to succeed", () => {
    const plan = sweepSuccessors(owed, new Map([["TST-1", 7]]), spec, MILESTONES);
    expect("file" in plan && plan.file.map(f => f.id)).toEqual(["TST-1"]);
    expect("leave" in plan && plan.leave).toEqual([expect.objectContaining({ id: "TST-3" })]);
    // Review of #2545: an issue closed as not planned may well name it, so the
    // reason says what was looked for, not that nobody ever named it.
    expect("leave" in plan && plan.leave[0]!.why).toMatch(/closed as completed/);
  });

  test("one refusal refuses the whole sweep, the per-issue path's rule", () => {
    const plan = sweepSuccessors(owed, new Map([["TST-1", 7], ["TST-3", 6]]), spec, MILESTONES.filter(m => m.number !== 12));
    expect("file" in plan, "filed TST-1 while TST-3 had nowhere to go").toBe(false);
    expect("why" in plan && plan.why).toContain("TST-3");
  });
});

describe("#2541: rungate criterion-successor --sweep, end to end over a real spec", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });
  const tree = () => {
    const root = mkdtempSync(join(tmpdir(), "rg-criterion-sweep-"));
    made.push(root);
    mkdirSync(join(root, "specs"), { recursive: true });
    writeFileSync(join(root, "specs", "FIX.md"), SPEC);
    return root;
  };
  type Closed = {
    number: number;
    title: string;
    body: string | null;
    closedAt: string;
    stateReason: string | null;
    authorAssociation: string;
    authorIsBot: boolean;
  };
  const OWNER = { authorAssociation: "OWNER", authorIsBot: false };
  const serves = (ids: string) => `## Criteria this serves\n\n${ids}`;
  const CLOSED: Closed[] = [
    { number: 5, title: "older", body: serves("TST-1"), closedAt: "2026-11-01T00:00:00Z", stateReason: "completed", ...OWNER },
    { number: 7, title: "newer", body: serves("TST-1"), closedAt: "2026-11-10T00:00:00Z", stateReason: "completed", ...OWNER },
    // Newer still, and closed as not planned: a maintainer's "not planned" is
    // not the work it names.
    { number: 8, title: "declined", body: serves("TST-1"), closedAt: "2026-11-12T00:00:00Z", stateReason: "not_planned", ...OWNER },
    // Newest of all, about a criterion that is ticked: never a citation for TST-1.
    { number: 9, title: "about the second thing", body: serves("TST-2"), closedAt: "2026-11-15T00:00:00Z", stateReason: "completed", ...OWNER },
    // #2546: an outsider files an issue naming TST-1 and closes it as completed
    // themselves. Newer than #7, and not a citation.
    { number: 10, title: "drive-by", body: serves("TST-1"), closedAt: "2026-11-18T00:00:00Z", stateReason: "completed", authorAssociation: "NONE", authorIsBot: false },
    // A successor filed by the workflow's own bot reads as NONE too, and IS a
    // citation: excluding bots would break the chain the sweep continues.
    // Closed before GitHub recorded a reason: null is not a decline.
    { number: 6, title: "third", body: serves("TST-3"), closedAt: "2026-11-05T00:00:00Z", stateReason: null, authorAssociation: "NONE", authorIsBot: true },
    { number: 11, title: "drive-by, third", body: serves("TST-3"), closedAt: "2026-11-19T00:00:00Z", stateReason: "completed", authorAssociation: "CONTRIBUTOR", authorIsBot: false },
  ];
  const gh = (over: { open?: { number: number; title: string; body: string | null }[]; closed?: () => Promise<Closed[]> } = {}) => {
    const created: { title: string; body: string; milestone: number }[] = [];
    let reads = 0;
    const api: SuccessorGitHub = {
      issue: async () => {
        throw new Error("a sweep reads no single issue");
      },
      openIssues: async () => over.open ?? [],
      milestones: async () => MILESTONES,
      closedIssues: async () => {
        reads++;
        return over.closed ? over.closed() : CLOSED;
      },
      createIssue: async (_repo, i) => {
        created.push(i);
        return 200 + created.length;
      },
    };
    return { api, created, reads: () => reads };
  };
  const run = async (argv: string[], root: string, api: SuccessorGitHub) => {
    const out: string[] = [];
    const log = console.log;
    const err = console.error;
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    console.error = (...a: unknown[]) => void out.push(a.join(" "));
    try {
      const code = await main(argv, root, api, { GITHUB_TOKEN: "t" }, () => new Map());
      return { code, out: out.join("\n") };
    } finally {
      console.log = log;
      console.error = err;
    }
  };

  test("with --write it files one successor per owed criterion, citing the newest trusted issue closed as completed that names it", async () => {
    const { api, created, reads } = gh();
    const r = await run(["--sweep", "--repo", "o/n", "--write"], tree(), api);
    expect(r.code, r.out).toBe(0);
    expect(created.map(c => c.milestone)).toEqual([11, 12]);
    expect(created[0]!.body).toContain("## Criteria this serves\n\nTST-1");
    expect(created[0]!.body, "cited #9, which names TST-2").not.toContain("#9");
    expect(created[0]!.body, "cited #8, which was closed as not planned").not.toContain("#8");
    expect(created[0]!.body).toContain("#7");
    expect(created[1]!.body).toContain("#6");
    // One read of the closed issues, however many criteria are owed (#2546).
    expect(reads()).toBe(1);
  });

  test("#2546: an issue its outsider author closed as completed is never the citation; a bot's successor is", async () => {
    const { api, created } = gh();
    const r = await run(["--sweep", "--repo", "o/n", "--write"], tree(), api);
    expect(r.code, r.out).toBe(0);
    expect(created[0]!.body, "cited #10, an outsider's self-closed issue").not.toContain("#10");
    expect(created[1]!.body, "cited #11, a contributor's self-closed issue").not.toContain("#11");
    expect(created[1]!.body, "skipped #6, the bot-filed successor").toContain("#6");
  });

  test("a criterion an open issue still names is not owed, and not filed", async () => {
    const { api, created } = gh({ open: [{ number: 40, title: "x", body: serves("TST-3") }] });
    const r = await run(["--sweep", "--repo", "o/n", "--write"], tree(), api);
    expect(r.code, r.out).toBe(0);
    expect(created.map(c => c.milestone)).toEqual([11]);
  });

  test("a second run, with the first run's successors open, files nothing and reads no closed issue", async () => {
    const { api, created, reads } = gh({
      open: [
        { number: 201, title: "TST-1: a", body: serves("TST-1") },
        { number: 202, title: "TST-3: b", body: serves("TST-3") },
      ],
    });
    const r = await run(["--sweep", "--repo", "o/n", "--write"], tree(), api);
    expect(r.code, r.out).toBe(0);
    expect(created).toEqual([]);
    expect(reads(), "nothing owed, so nothing to read").toBe(0);
  });

  test("without --write it files nothing and says what it would file", async () => {
    const { api, created } = gh();
    const r = await run(["--sweep", "--repo", "o/n"], tree(), api);
    expect(r.code, r.out).toBe(0);
    expect(created).toEqual([]);
    expect(r.out).toContain("would file");
  });

  test("a closed-issue read that fails files nothing, and names why", async () => {
    const { api, created } = gh({
      closed: async () => {
        throw new Error("API rate limit exceeded");
      },
    });
    const r = await run(["--sweep", "--repo", "o/n", "--write"], tree(), api);
    expect(r.code, r.out).toBe(REFUSAL_EXIT);
    expect(created).toEqual([]);
    expect(r.out).toContain("API rate limit exceeded");
  });

  // #2546: forty owed criteria, more than the search API's ~30 a minute. One
  // read serves them all, so the sweep completes.
  test("#2546: a sweep over more owed criteria than the search limit allows completes, from one read", async () => {
    const MANY = 40;
    const ids = Array.from({ length: MANY }, (_, i) => `TST-${i + 1}`);
    const spec = [
      ...SPEC.split("## Success Criteria")[0]!.split("\n"),
      "## Success Criteria",
      "",
      ...ids.map(id => `- [ ] ${id}: thing ${id} is true`),
      "",
      "### Phase placement",
      "",
      "| Placement | Criteria |",
      "|---|---|",
      `| **Phase 1** | ${ids.join(", ")} |`,
      "",
    ].join("\n");
    const root = tree();
    writeFileSync(join(root, "specs", "FIX.md"), spec);
    const { api, created, reads } = gh({
      closed: async () => [{ number: 50, title: "the lot", body: serves(ids.join(", ")), closedAt: "2026-11-01T00:00:00Z", stateReason: "completed", ...OWNER }],
    });
    const r = await run(["--sweep", "--repo", "o/n", "--write"], root, api);
    expect(r.code, r.out).toBe(0);
    expect(created).toHaveLength(MANY);
    expect(reads()).toBe(1);
  });

  test("--sweep with --issue is refused: one run asks one question", async () => {
    const { api, created } = gh();
    const r = await run(["--sweep", "--issue", "5", "--repo", "o/n", "--write"], tree(), api);
    expect(r.code, r.out).toBe(REFUSAL_EXIT);
    expect(created).toEqual([]);
  });
});
