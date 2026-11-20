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
import { planSuccessors, successorTitle } from "../lib/criterion-successor";
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
