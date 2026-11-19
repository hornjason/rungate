/**
 * Covers SC-2787 (SPEC-TO-BOARD-PIPELINE-SPEC.md, ADR-022): when
 * `board.mergeWorkflow` names a consumer's merge workflow, the generated
 * `adr-accepted.yml` also runs when that workflow completes, and places every
 * ADR accepted since the head of its own last successful run. With no such run
 * it refuses UNMEASURED rather than guess a range.
 *
 * A merge made with `GITHUB_TOKEN` starts no workflow, so the `push` trigger
 * never fires for a bot-merged ADR. A `workflow_run` event is created even
 * then. It carries no `before` sha, so the range starts at the head of this
 * workflow's last successful run.
 *
 * Which head GitHub reports for a run that a `workflow_run` started is not
 * something this repository can observe offline, so the range reader does not
 * trust it: a run counts only when its head commit is an ancestor of the
 * checkout. Older runs are tried in turn, and when none qualifies the read
 * refuses. A wider range is safe because every planning command is idempotent;
 * a wrong one is not.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { readBoardInputs } from "../lib/config-readers";
import { ADR_ACCEPTED_JOB, ADR_ACCEPTED_WORKFLOW_FILE } from "../lib/scaffold/adr-accepted-workflow";
import { createCiWorkflows } from "../lib/scaffold/steps";
import { REFUSAL_EXIT, main as planIssuesMain, sinceLastSuccessfulRun } from "../scripts/plan-issues";

const BOARD = { engineSpec: "specs/ENGINE.md", milestonePrefix: "Engine" };

function consumer(board: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "rg-merge-wf-"));
  mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "rungate", "config.json"),
    JSON.stringify({ project: "fixture", repo: "fixture/fixture", ci: { bunVersion: "1.3.14" }, test: { command: "bun test" }, board }),
  );
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0" }));
  return root;
}

function generated(board: Record<string, unknown>): string {
  const root = consumer(board);
  try {
    createCiWorkflows(root, [], { force: true });
    const path = join(root, ".github", "workflows", ADR_ACCEPTED_WORKFLOW_FILE);
    return existsSync(path) ? readFileSync(path, "utf-8") : "";
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const runOf = (s: any) => String(s.run ?? "");

describe("SC-2787: board.mergeWorkflow is read from config", () => {
  test("SC-2787: the name is read as written, and blank or absent is null", () => {
    for (const [value, expected] of [["approve-on-green", "approve-on-green"], ["  merge bot  ", "merge bot"], ["   ", null], [undefined, null], [7, null]] as const) {
      const root = consumer({ ...BOARD, ...(value === undefined ? {} : { mergeWorkflow: value }) });
      try {
        expect(readBoardInputs(root).mergeWorkflow, JSON.stringify(value)).toBe(expected);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

describe("SC-2787: with no merge workflow named, the generated file is what it was", () => {
  test("SC-2787: no workflow_run trigger, no actions permission, no extra step", () => {
    const doc = Bun.YAML.parse(generated(BOARD)) as any;
    expect(Object.keys(doc.on)).toEqual(["push"]);
    expect(doc.permissions).toEqual({ contents: "read", issues: "write" });
    const steps: any[] = doc.jobs[ADR_ACCEPTED_JOB].steps;
    expect(steps.some(s => runOf(s).includes("--accepted-since-last-run"))).toBe(false);
  });
});

describe("SC-2787: with a merge workflow named, adr-accepted also runs when it completes", () => {
  const yml = generated({ ...BOARD, mergeWorkflow: "approve-on-green" });
  const doc = Bun.YAML.parse(yml) as any;
  const steps: any[] = doc.jobs[ADR_ACCEPTED_JOB].steps;
  const accepted = steps.find(s => s.id === "accepted");

  test("SC-2787: the trigger is that workflow's completion, on any branch, beside the push trigger", () => {
    expect(doc.on.push.paths).toEqual(["docs/adr/**"]);
    // No branches filter: a merge workflow runs on pull request events, so its
    // head branch is the pull request's, and a filter on main would match none.
    expect(doc.on.workflow_run).toEqual({ workflows: ["approve-on-green"], types: ["completed"] });
  });

  test("SC-2787: a merge-triggered run reads its range from its own last successful run; a push still reads before", () => {
    expect(runOf(accepted)).toContain(`plan-issues --accepted-since-last-run ${ADR_ACCEPTED_WORKFLOW_FILE} --repo "$GITHUB_REPOSITORY"`);
    expect(runOf(accepted)).toContain('plan-issues --accepted-since "$BEFORE"');
    expect(runOf(accepted)).toMatch(/if \[ "\$EVENT" = "workflow_run" \]; then/);
    expect(accepted.env.EVENT).toBe("${{ github.event_name }}");
    // Listing runs needs actions: read, and nothing else is widened.
    expect(doc.permissions).toEqual({ contents: "read", issues: "write", actions: "read" });
  });

  test("SC-2787: the token reaches the range read only on a merge-triggered run, and the package is fetched before any token", () => {
    expect(accepted.env.GITHUB_TOKEN).toBe("${{ github.event_name == 'workflow_run' && secrets.GITHUB_TOKEN || '' }}");
    const firstBunx = steps.findIndex(s => runOf(s).includes("bunx rungate@"));
    expect(firstBunx).toBeLessThan(steps.indexOf(accepted));
    expect(JSON.stringify(steps[firstBunx].env ?? {})).not.toContain("secrets.");
    expect(JSON.stringify(accepted.env)).not.toContain("RUNGATE_PROJECT_TOKEN");
  });

  test("SC-2787: a name that would be read as something other than itself is not written, and every run says so", () => {
    for (const bad of ["approve\non-green", "x ${{ secrets.A }}"]) {
      const out = generated({ ...BOARD, mergeWorkflow: bad });
      const d = Bun.YAML.parse(out) as any;
      expect(Object.keys(d.on), JSON.stringify(bad)).toEqual(["push"]);
      const step = (d.jobs[ADR_ACCEPTED_JOB].steps as any[]).find(s => s.id === "accepted");
      expect(runOf(step)).toContain("::warning title=Merge workflow trigger UNMEASURED::board.mergeWorkflow");
    }
  });
});

describe("SC-2787: the range starts at the newest successful run whose head is on this branch", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const C = "c".repeat(40);
  const onBranch = (shas: string[]) => (sha: string) => shas.includes(sha);

  test("SC-2787: the newest run on the branch wins; a run whose head is not on it is passed over", () => {
    const r = sinceLastSuccessfulRun([{ id: 3, head_sha: C }, { id: 2, head_sha: B }, { id: 1, head_sha: A }], onBranch([A, B]));
    expect(r).toEqual({ sha: B, run: 2, skipped: 1 });
  });

  test("SC-2787: no successful run, or none on the branch, refuses rather than guess a range", () => {
    const none = sinceLastSuccessfulRun([], onBranch([A]));
    expect("why" in none && none.why).toContain("no successful run");
    const off = sinceLastSuccessfulRun([{ id: 9, head_sha: C }], onBranch([A]));
    expect("why" in off && off.why).toContain("none of the 1 successful run");
  });

  test("SC-2787: runs that could not be read are UNMEASURED, never 'no merge happened'", () => {
    // #2495's required case: the read failing is a reading not taken, and it
    // must not come back as an empty list of accepted ADRs.
    const unread = sinceLastSuccessfulRun(null, onBranch([A]), "the API answered 502");
    expect("why" in unread && unread.why).toContain("the API answered 502");
    const malformed = sinceLastSuccessfulRun([{ id: 1 }], onBranch([A]));
    expect("why" in malformed && malformed.why).toContain("head_sha");
  });

  test("SC-2787: a workflow file that is not a bare file name is refused before anything is read", async () => {
    const errs: string[] = [];
    const real = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    // A reader that fails loudly if asked: the refusal must come from the
    // name check, not from a later read that happens to fail too.
    const asked = { runs: async () => { throw new Error("the API was asked"); } };
    try {
      for (const bad of ["../ci.yml", "a/b.yml", "adr-accepted", ""]) {
        errs.length = 0;
        const code = await planIssuesMain(["--accepted-since-last-run", bad, "--repo", "fixture/fixture"], undefined, undefined, undefined, asked);
        expect(code, bad).toBe(REFUSAL_EXIT);
        expect(errs.join("\n"), bad).toContain("needs a workflow file name");
        expect(errs.join("\n"), bad).not.toContain("the API was asked");
      }
    } finally {
      console.error = real;
    }
  });

  test("SC-2787: combined with --families, --place or --accepted-since it is refused, never silently dropped", async () => {
    // Review of #2509: --families and --place each refuse every flag they do
    // not read, and this one was missing from both lists.
    const asked = { runs: async () => { throw new Error("the API was asked"); } };
    const errs: string[] = [];
    const real = { log: console.log, error: console.error };
    console.log = () => {};
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    try {
      for (const other of [["--families"], ["--place", "--repo", "fixture/fixture"], ["--accepted-since", "HEAD"]]) {
        errs.length = 0;
        const code = await planIssuesMain(["--accepted-since-last-run", ADR_ACCEPTED_WORKFLOW_FILE, ...other], undefined, undefined, undefined, asked);
        expect(code, other.join(" ")).toBe(REFUSAL_EXIT);
        expect(errs.join("\n"), other.join(" ")).toMatch(/pass it alone|pass it with --repo/);
        expect(errs.join("\n"), other.join(" ")).not.toContain("the API was asked");
      }
    } finally {
      console.log = real.log;
      console.error = real.error;
    }
  });

  test("SC-2787: end to end, the range read lists exactly what was accepted after the qualifying run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-merge-wf-git-"));
    const git = (...args: string[]) => {
      const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
      if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
      return r.stdout.trim();
    };
    const adr = (status: string) =>
      ["---", "doc-type: adr", `status: ${status}`, "---", "", "# ADR-1", "", "| Criterion | Outcome | Files | Milestone | Blocked by |", "|---|---|---|---|---|", "| X-1 | a row | lib/a.ts | — | — |", ""].join("\n");
    try {
      git("init", "-q", "-b", "main");
      git("config", "user.email", "t@example.com");
      git("config", "user.name", "t");
      mkdirSync(join(dir, "docs", "adr"), { recursive: true });
      writeFileSync(join(dir, "docs/adr/ADR-001-a.md"), adr("proposed"));
      git("add", "-A");
      git("commit", "-q", "-m", "placed through here");
      const placed = git("rev-parse", "HEAD");
      writeFileSync(join(dir, "docs/adr/ADR-001-a.md"), adr("accepted"));
      git("add", "-A");
      git("commit", "-q", "-m", "bot merge accepts it");

      const said: string[] = [];
      const errs: string[] = [];
      const real = { log: console.log, error: console.error };
      console.log = (...a: unknown[]) => void said.push(a.join(" "));
      console.error = (...a: unknown[]) => void errs.push(a.join(" "));
      let code: number;
      try {
        // A newer successful run whose head is a pull request branch's commit,
        // not on main, is passed over for the one that is.
        code = await planIssuesMain(
          ["--accepted-since-last-run", ADR_ACCEPTED_WORKFLOW_FILE, "--repo", "fixture/fixture", "--project-root", dir],
          undefined,
          undefined,
          undefined,
          { runs: async () => [{ id: 20, head_sha: "d".repeat(40) }, { id: 19, head_sha: placed }] },
        );
      } finally {
        console.log = real.log;
        console.error = real.error;
      }
      expect(code, errs.join("\n")).toBe(0);
      expect(said).toEqual(["docs/adr/ADR-001-a.md"]);
      expect(errs.join("\n")).toContain(`run 19 (${placed.slice(0, 12)})`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
