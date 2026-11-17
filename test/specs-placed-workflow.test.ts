/**
 * Covers SC-2780 (SPEC-TO-BOARD-PIPELINE-SPEC.md): a push to main that
 * changes `specs/` runs `plan-spec` and then `plan-deps` for each opted-in
 * family, and `board-mirror` once after the families, with no command typed by
 * hand; an opted-in spec whose `board:` block or placement table cannot be
 * read turns the run red by name rather than being skipped.
 *
 * The GENERATED workflow is what is measured: scaffold writes it into a
 * throwaway consumer, and its `run:` scripts are executed with `gh` and
 * `bunx` stubbed on PATH, so the loop, the wait and the refusals are run
 * rather than read.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CLI_COMMANDS } from "../lib/cli-commands";
import { ADR_ACCEPTED_WORKFLOW_FILE } from "../lib/scaffold/adr-accepted-workflow";
import {
  SPECS_PLACED_COMMANDS,
  SPECS_PLACED_GROUP,
  SPECS_PLACED_JOB,
  SPECS_PLACED_WORKFLOW_FILE,
  WAIT_POLLS,
} from "../lib/scaffold/specs-placed-workflow";
import { createCiWorkflows } from "../lib/scaffold/steps";
import { workflowCensus } from "../lib/scaffold/workflow-census";

const ROOT = join(import.meta.dir, "..");

/** Scaffold a throwaway consumer; hand back the generated specs-placed.yml. */
function generated(): string {
  const root = mkdtempSync(join(tmpdir(), "rg-specs-placed-"));
  try {
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "rungate", "config.json"),
      JSON.stringify({ project: "fixture", repo: "fixture/fixture", ci: { bunVersion: "1.3.14" }, test: { command: "bun test" } }),
    );
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0" }));
    createCiWorkflows(root, [], { force: true });
    const path = join(root, ".github", "workflows", SPECS_PLACED_WORKFLOW_FILE);
    return existsSync(path) ? readFileSync(path, "utf-8") : "";
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const YML = generated();
// biome-ignore lint: the parsed workflow is untyped YAML.
const DOC = Bun.YAML.parse(YML) as any;
const STEPS: any[] = DOC?.jobs?.[SPECS_PLACED_JOB]?.steps ?? [];
const runOf = (s: any) => String(s?.run ?? "");
const stepIndex = (pattern: RegExp) => STEPS.findIndex(s => pattern.test(runOf(s)));

/**
 * Run one `run:` script under bash with stub commands on PATH. Each stub is a
 * shell script body; every call is logged to calls.log as "<name> <args>".
 */
function execute(script: string, stubs: Record<string, string>, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rg-specs-placed-run-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    for (const [name, body] of Object.entries(stubs)) {
      const path = join(bin, name);
      writeFileSync(path, `#!/usr/bin/env bash\necho "${name} $*" >> "${join(dir, "calls.log")}"\n${body}\n`);
      chmodSync(path, 0o755);
    }
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    const r = spawnSync("bash", ["-e", "-c", script], {
      cwd: dir,
      encoding: "utf-8",
      env: { PATH: `${bin}:/usr/bin:/bin`, GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "77", GITHUB_OUTPUT: join(dir, "out.txt"), HOME: dir },
    });
    const log = existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf-8").trim().split("\n") : [];
    return { code: r.status, out: `${r.stdout}${r.stderr}`, calls: log, dir };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("SC-2780: scaffold writes specs-placed.yml, and it runs on a push that changes specs", () => {
  test("SC-2780: a consumer's scaffold writes it, stamped as the harness's, with one job", () => {
    expect(YML, `scaffold wrote no ${SPECS_PLACED_WORKFLOW_FILE}`).not.toBe("");
    expect(YML).toContain("generated-sha:");
    expect(Object.keys(DOC.jobs)).toEqual([SPECS_PLACED_JOB]);
  });

  test("SC-2780: it fires on a push to main that touches specs/, and on nothing else", () => {
    // Bun.YAML reads the bare `on:` key as the string "on".
    expect(DOC.on).toEqual({ push: { branches: ["main"], paths: ["specs/**"] } });
  });

  test("SC-2780: it calls the published CLI, and every command it calls is registered", () => {
    expect(YML, "a consumer has node_modules/rungate, not scripts/").not.toContain("bun scripts/");
    expect(YML, "a consumer has no ./lib to import at run time").not.toContain("./lib/");
    for (const cmd of SPECS_PLACED_COMMANDS) {
      expect(YML).toMatch(new RegExp(`bunx rungate@\\S+ ${cmd} `));
      expect(cmd in CLI_COMMANDS, `the workflow calls ${cmd}, which the CLI does not register`).toBe(true);
    }
  });

  test("SC-2780: families, then plan-spec, then placement, then plan-deps, then board-mirror once", () => {
    const order = [
      stepIndex(/plan-issues --families/),
      stepIndex(/ plan-spec /),
      stepIndex(/plan-issues --place/),
      stepIndex(/ plan-deps /),
      stepIndex(/board-mirror --queue-label/),
      stepIndex(/board-mirror --project/),
    ];
    expect(order.every(i => i >= 0), `a step is missing: ${order}`).toBe(true);
    expect([...order].sort((a, b) => a - b), "the steps are out of order").toEqual(order);
    // ADR-019 Decision 2: issues are placed BEFORE the links are derived.
    expect(stepIndex(/plan-issues --place/)).toBeLessThan(stepIndex(/ plan-deps /));
    expect(STEPS.filter(s => /board-mirror --project/.test(runOf(s))).length, "board-mirror's board write runs once").toBe(1);
  });

  test("SC-2780: a later step never depends on an earlier one succeeding, except placement on milestones", () => {
    const ifOf = (pattern: RegExp) => String(STEPS[stepIndex(pattern)]?.if ?? "");
    for (const p of [/ plan-deps /, /board-mirror --queue-label/, /board-mirror --project/]) expect(ifOf(p), String(p)).toContain("!cancelled()");
    // Placement needs the milestones plan-spec makes, so it keeps the implicit success().
    expect(ifOf(/plan-issues --place/)).not.toContain("!cancelled()");
  });

  test("SC-2780: the board token reaches only the board step", () => {
    const holders = STEPS.filter(s => JSON.stringify(s.env ?? {}).includes("RUNGATE_PROJECT_TOKEN"));
    expect(holders.map(runOf).every(r => r.includes("board-mirror --project"))).toBe(true);
    expect(holders.length).toBe(1);
  });

  test("this repository's copy is the generated one, untouched", () => {
    const row = workflowCensus(ROOT).files.find(f => f.name === SPECS_PLACED_WORKFLOW_FILE);
    expect(row?.status, row?.detail).toBe("generated-and-unchanged");
  });
});

describe("SC-2780: an opted-in spec that cannot be read turns the run red by name", () => {
  const families = runOf(STEPS[stepIndex(/plan-issues --families/)]);

  test("SC-2780: a --families refusal fails the step and writes no family list", () => {
    const r = execute(families, { bunx: 'echo "plan-issues --families: UNMEASURED — specs/ODD.md: its board: declaration cannot be read" >&2; exit 1' });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("specs/ODD.md");
    expect(families, "a refusal swallowed by || true would read as no family").not.toContain("|| true");
  });

  test("SC-2780: one family's refusal does not stop the next, and the step exits red naming it", () => {
    const loop = runOf(STEPS[stepIndex(/ plan-spec /)]);
    // The stub READS stdin: a loop that fed the families on stdin would lose
    // every family after the first to it.
    const r = execute(loop, { bunx: 'cat > /dev/null; case "$*" in *"--prefix Broken"*) exit 1;; esac; exit 0' }, {
      "families.tsv": "Broken\tspecs/BROKEN.md\nEngine\tspecs/ENGINE.md\n",
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("[Broken]");
    expect(r.out).not.toContain("[Engine]");
    expect(r.calls.filter(c => c.includes("plan-spec")).length, r.calls.join("\n")).toBe(2);
    expect(r.calls.some(c => c.includes('plan-spec specs/ENGINE.md --repo o/r --prefix Engine --write'))).toBe(true);
  });

  test("SC-2780: plan-deps runs per family, with the family's own prefix", () => {
    const loop = runOf(STEPS[stepIndex(/ plan-deps /)]);
    const r = execute(loop, { bunx: "cat > /dev/null; exit 0" }, { "families.tsv": "Convergence\tspecs/C.md\nEngine\tspecs/E.md\n" });
    expect(r.code, r.out).toBe(0);
    expect(r.calls.map(c => c.replace(/^bunx rungate@\S+ /, ""))).toStrictEqual([
      "plan-deps --repo o/r --milestone-prefix Convergence --write",
      "plan-deps --repo o/r --milestone-prefix Engine --write",
    ]);
  });
});

describe("SC-2780: it never writes while an earlier ADR placement is running", () => {
  const wait = runOf(STEPS[0]);
  /** A `gh` stub: the run's own created_at, then the runs list from a file that the test rewrites. */
  const gh = (lists: string[]) =>
    [
      'case "$*" in',
      '  *"actions/runs/77"*) echo "2026-11-17T12:00:00Z";;',
      "  *) n=$(cat polls 2>/dev/null || echo 0); n=$((n+1)); echo $n > polls;",
      ...lists.map((l, i) => `     [ $n -eq ${i + 1} ] && { echo "${l}"; exit 0; };`),
      `     echo "${lists[lists.length - 1]}";;`,
      "esac",
    ].join("\n");

  test("the wait is the first step, before the checkout and before any bunx", () => {
    expect(STEPS[0]?.name).toContain("Wait");
    expect(wait).toContain(`actions/workflows/${ADR_ACCEPTED_WORKFLOW_FILE}/runs`);
    expect(STEPS.findIndex(s => String(s.uses ?? "").startsWith("actions/checkout"))).toBeGreaterThan(0);
  });

  test("no earlier unfinished ADR run: it goes ahead at once", () => {
    const r = execute(wait, { gh: gh([""]), sleep: "exit 0" });
    expect(r.code, r.out).toBe(0);
    expect(r.calls.filter(c => c.startsWith("sleep"))).toStrictEqual([]);
  });

  test("an earlier ADR run still going: it waits, then goes ahead when it finishes", () => {
    const r = execute(wait, { gh: gh(["4242", "4242", ""]), sleep: "exit 0" });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Waiting for adr-accepted.yml run(s) 4242");
    expect(r.calls.filter(c => c.startsWith("sleep")).length).toBe(2);
  });

  test("an ADR run that never finishes: red after the last poll, writing nothing", () => {
    const r = execute(wait, { gh: gh(["4242"]), sleep: "exit 0" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("still unfinished");
    expect(r.calls.filter(c => c.startsWith("sleep")).length).toBe(WAIT_POLLS);
  });

  test("the query waits only on runs created BEFORE this one, so the two workflows cannot wait on each other", () => {
    // The stub runs the step's own --jq expression through jq over a runs
    // list, so the filter is executed, not read. A later unfinished run and an
    // earlier finished one must not hold it; an earlier unfinished one must.
    const runs = (list: { id: number; status: string; created_at: string }[]) => JSON.stringify({ workflow_runs: list });
    const jqGh = [
      'expr=""; for a in "$@"; do [ "$prev" = "--jq" ] && expr="$a"; prev="$a"; done',
      'case "$*" in',
      '  *"actions/runs/77"*) echo "2026-11-17T12:00:00Z";;',
      '  *) jq -r "$expr" < runs.json;;',
      "esac",
    ].join("\n");
    expect(spawnSync("jq", ["--version"]).status, "jq must be on PATH: without it this case measures nothing").toBe(0);
    const later = execute(wait, { gh: jqGh, sleep: "exit 0" }, {
      "runs.json": runs([
        { id: 1, status: "in_progress", created_at: "2026-11-17T12:05:00Z" },
        { id: 2, status: "completed", created_at: "2026-11-17T11:00:00Z" },
      ]),
    });
    expect(later.code, later.out).toBe(0);
    expect(later.calls.filter(c => c.startsWith("sleep"))).toStrictEqual([]);
    const earlier = execute(wait, { gh: jqGh, sleep: "exit 0" }, {
      "runs.json": runs([{ id: 9, status: "queued", created_at: "2026-11-17T11:59:00Z" }]),
    });
    expect(earlier.code).not.toBe(0);
    expect(earlier.out).toContain("run(s) 9");
  });

  test("an earlier unfinished run past the first page of runs still holds it", () => {
    // The list endpoint is newest-first, 100 a page. The stub serves page 2
    // only when the step asks for every page, so a single-page query never
    // sees run 9 and goes ahead beside it (review thread on #2322).
    const page = (list: { id: number; status: string; created_at: string }[]) => JSON.stringify({ workflow_runs: list });
    const newer = Array.from({ length: 100 }, (_, i) => ({
      id: 1000 + i,
      status: "completed",
      created_at: `2026-11-17T11:${String(59 - (i % 60)).padStart(2, "0")}:30Z`,
    }));
    const pagedGh = [
      'expr=""; pag=0; for a in "$@"; do [ "$prev" = "--jq" ] && expr="$a"; [ "$a" = "--paginate" ] && pag=1; prev="$a"; done',
      'case "$*" in',
      '  *"actions/runs/77"*) echo "2026-11-17T12:00:00Z";;',
      '  *) jq -r "$expr" < page1.json; if [ $pag -eq 1 ]; then jq -r "$expr" < page2.json; fi;;',
      "esac",
    ].join("\n");
    const files = {
      "page1.json": page(newer),
      "page2.json": page([{ id: 9, status: "queued", created_at: "2026-11-17T10:00:00Z" }]),
    };
    const r = execute(wait, { gh: pagedGh, sleep: "exit 0" }, files);
    expect(r.code, r.out).not.toBe(0);
    expect(r.out).toContain("Waiting for adr-accepted.yml run(s) 9 to finish");
    expect(r.out).not.toContain("going ahead");
  });

  test("a runs list it cannot read is red, never a go-ahead", () => {
    const failing = ['case "$*" in', '  *"actions/runs/77"*) echo "2026-11-17T12:00:00Z";;', "  *) exit 1;;", "esac"].join("\n");
    const r = execute(wait, { gh: failing, sleep: "exit 0" });
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain("going ahead");
  });

  test("its own concurrency group, never adr-accepted's, and permission to list runs", () => {
    expect(DOC.concurrency).toEqual({ group: SPECS_PLACED_GROUP, "cancel-in-progress": false });
    expect(SPECS_PLACED_GROUP).not.toBe("adr-accepted");
    expect(DOC.permissions).toEqual({ contents: "read", issues: "write", actions: "read" });
  });
});

describe("a repository with no board: the Criteria step warns and passes instead of failing every specs push", () => {
  const step = STEPS.find(s => s.name === "Criteria column on the board");
  const run = runOf(step);
  const noBoard = 'case "$*" in *board-id*) echo "UNMEASURED: no board — set board.id in the rungate config under /x. Nothing was printed." >&2; exit 2;; esac; exit 0';

  test("no variable and no board.id: a warning naming UNMEASURED, exit 0, and nothing written", () => {
    expect(run, "the Criteria step is missing").not.toBe("");
    const r = execute(run, { bunx: noBoard });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("::warning title=Criteria column::UNMEASURED — no board is configured");
    expect(r.calls.map(c => c.replace(/^bunx rungate@\S+ /, ""))).toStrictEqual(["board-id"]);
  });

  test("no variable, board.id set: the board-id answer is the board written", () => {
    const r = execute(run, { bunx: 'case "$*" in *board-id*) echo PVT_from_config;; esac; exit 0' });
    expect(r.code, r.out).toBe(0);
    expect(r.calls.map(c => c.replace(/^bunx rungate@\S+ /, ""))).toStrictEqual(["board-id", "board-mirror --project PVT_from_config --write"]);
  });

  test("the variable set: it wins, and board-id is never asked", () => {
    const r = execute(`PROJECT_ID=PVT_from_var\n${run}`, { bunx: noBoard });
    expect(r.code, r.out).toBe(0);
    expect(r.calls.map(c => c.replace(/^bunx rungate@\S+ /, ""))).toStrictEqual(["board-mirror --project PVT_from_var --write"]);
  });

  test("board-id refusing for any other reason stays red: only the no-board wording is a warning", () => {
    const r = execute(run, { bunx: 'case "$*" in *board-id*) echo "UNMEASURED: unknown argument \\"--x\\"." >&2; exit 2;; esac; exit 0' });
    expect(r.code).toBe(2);
    expect(r.out).not.toContain("::warning");
    expect(r.calls.map(c => c.replace(/^bunx rungate@\S+ /, ""))).toStrictEqual(["board-id"]);
  });
});
