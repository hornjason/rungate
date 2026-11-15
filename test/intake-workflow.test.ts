/**
 * `.github/workflows/intake.yml`, generated — #2233.
 *
 * Jason decided on #1126 (2026-11-15) that each intake source runs on its own
 * trigger and none on scaffold. `fix-commits` needs unshallowed history, and
 * the only reason it reads UNMEASURED on a runner is that `actions/checkout`
 * clones to depth 1 by default. So: a push to main, `fetch-depth: 0`, and the
 * published `rungate intake --source fix-commits` (#2248, released in 0.8.23).
 *
 * Advisory: a reading never fails the run. UNMEASURED is printed and raised
 * as a warning annotation, never a silent zero. A bad invocation — the
 * command refusing its arguments, or `bunx` failing — is red, because that is
 * the tool broken rather than a reading taken.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { CLI_COMMANDS } from "../lib/cli-commands";
import { actionRef } from "../lib/workflow-actions";
import {
  INTAKE_COMMAND,
  INTAKE_JOB,
  INTAKE_WORKFLOW_FILE,
  buildIntakeScript,
} from "../lib/scaffold/intake-workflow";
import { createCiWorkflows } from "../lib/scaffold/steps";
import { workflowCensus } from "../lib/scaffold/workflow-census";

const ROOT = join(import.meta.dir, "..");

/** Scaffold a throwaway consumer and hand back the generated intake.yml. */
function generated(): string {
  const root = mkdtempSync(join(tmpdir(), "rg-intake-wf-"));
  try {
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "rungate", "config.json"),
      JSON.stringify({ project: "fixture", repo: "fixture/fixture", ci: { bunVersion: "1.3.14" }, test: { command: "bun test" } }),
    );
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0" }));
    createCiWorkflows(root, [], { force: true });
    const path = join(root, ".github", "workflows", INTAKE_WORKFLOW_FILE);
    return existsSync(path) ? readFileSync(path, "utf-8") : "";
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("#2233: scaffold emits intake.yml as an owned workflow", () => {
  const yml = generated();
  const doc = (yml ? Bun.YAML.parse(yml) : {}) as any;
  const steps = (): any[] => doc.jobs?.[INTAKE_JOB]?.steps ?? [];

  test("a consumer's scaffold writes it, stamped as the harness's", () => {
    expect(yml, `scaffold wrote no ${INTAKE_WORKFLOW_FILE}`).not.toBe("");
    expect(yml).toContain("generated-sha:");
    expect(Object.keys(doc.jobs ?? {})).toEqual([INTAKE_JOB]);
  });

  test("it runs on a push to main and on nothing else, with read-only permissions", () => {
    expect(Object.keys(doc.on)).toEqual(["push"]);
    expect(doc.on.push.branches).toEqual(["main"]);
    expect(doc.permissions).toEqual({ contents: "read" });
  });

  test("it checks out FULL history — the depth is the only reason fix-commits reads UNMEASURED on a runner", () => {
    const checkout = steps().find(s => String(s.uses ?? "").startsWith("actions/checkout@"));
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
  });

  test("it calls the published CLI for the fix-commits source, never a script path", () => {
    const runs = steps().map(s => String(s.run ?? "")).join("\n");
    expect(runs).toMatch(new RegExp(`bunx rungate@\\S+ ${INTAKE_COMMAND} --source fix-commits`));
    expect(runs, "a consumer has node_modules/rungate, not scripts/").not.toContain("bun scripts/");
    expect(INTAKE_COMMAND in CLI_COMMANDS, "the workflow calls a command the CLI does not register").toBe(true);
  });

  test("every action is the reference lib/workflow-actions.ts declares for it", () => {
    const uses = steps().map(s => s.uses).filter(Boolean) as string[];
    expect(uses.map(u => u.split("@")[0])).toEqual(["actions/checkout", "oven-sh/setup-bun"]);
    expect(uses.filter(u => u !== actionRef(u.split("@")[0]!).split(" #")[0])).toEqual([]);
  });

  test("this repository's copy is the generated one, untouched", () => {
    const row = workflowCensus(ROOT).files.find(f => f.name === INTAKE_WORKFLOW_FILE);
    expect(row?.status, row?.detail).toBe("generated-and-unchanged");
  });
});

/**
 * The step's `run:` body, executed as Actions runs it (`bash -e`), with a fake
 * `bunx` that records its arguments and prints a reading.
 */
describe("#2233: a reading never fails the run, and UNMEASURED is never silent", () => {
  function runWith(bunxBody: string): { status: number | null; out: string; calls: string } {
    const dir = mkdtempSync(join(tmpdir(), "rg-intake-step-"));
    try {
      const log = join(dir, "calls.log");
      writeFileSync(join(dir, "bunx"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n${bunxBody}\n`, { mode: 0o755 });
      const r = spawnSync("bash", ["-e", "-c", buildIntakeScript("9.9.9")], {
        env: { PATH: `${dir}:${process.env.PATH}` },
        encoding: "utf-8",
      });
      return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: existsSync(log) ? readFileSync(log, "utf-8") : "" };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("an UNMEASURED reading exits 0, prints the reading, and raises a warning naming UNMEASURED", () => {
    const r = runWith(`echo 'fix-commits: UNMEASURED — SHALLOW_HISTORY'; echo 'intake: UNMEASURED — 1 reason(s) above'; exit 0`);
    expect(r.calls.trim()).toBe(`rungate@9.9.9 ${INTAKE_COMMAND} --source fix-commits`);
    expect(r.out).toContain("fix-commits: UNMEASURED — SHALLOW_HISTORY");
    expect(r.out).toMatch(/::warning::UNMEASURED/);
    expect(r.status).toBe(0);
  });

  test("a MEASURED reading exits 0 with no warning — the control", () => {
    // Without this, the case above passes against a step that warns on every run.
    const r = runWith(`echo 'fix-commits: MEASURED — 3 candidate(s) from 40 unit(s) of history read'; echo 'intake: MEASURED — 3 candidate(s) across 1 source(s)'; exit 0`);
    expect(r.out).toContain("fix-commits: MEASURED");
    expect(r.out).not.toContain("::warning::");
    expect(r.status).toBe(0);
  });

  test("the command refusing its arguments is red — the tool is broken, not a reading taken", () => {
    const r = runWith(`echo 'intake: no source is named "fix-commits".' >&2; exit 2`);
    expect(r.status).not.toBe(0);
  });
});
