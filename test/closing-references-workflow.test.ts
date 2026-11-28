/**
 * Covers SC-2743 (SPEC-TO-BOARD-PIPELINE-SPEC.md), #2045.
 *
 * ADR-014 row 2: `rungate scaffold` emits `.github/workflows/closing-references.yml`
 * as an owned, regenerated workflow, and this repository's copy is the
 * generated one. Until now the file was hand-written and NOT-OWNED by design,
 * on the reasoning that the check was this repository's policy; ADR-013 rule 9
 * step 4 made it the consumer's policy too.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { CLI_COMMANDS } from "../lib/cli-commands";
import { actionRef } from "../lib/workflow-actions";
import {
  CLOSING_REFERENCES_COMMAND,
  CLOSING_REFERENCES_JOB,
  CLOSING_REFERENCES_WORKFLOW_FILE,
  buildClosingReferencesScript,
} from "../lib/scaffold/closing-references-workflow";
import { createCiWorkflows } from "../lib/scaffold/steps";
import { workflowCensus } from "../lib/scaffold/workflow-census";

const ROOT = join(import.meta.dir, "..");

/** Scaffold a throwaway consumer and hand back the generated closing-references.yml. */
function generated(): string {
  const root = mkdtempSync(join(tmpdir(), "rg-closing-refs-"));
  try {
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "rungate", "config.json"),
      JSON.stringify({ project: "fixture", repo: "fixture/fixture", ci: { bunVersion: "1.3.14" }, test: { command: "bun test" } }),
    );
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0" }));
    createCiWorkflows(root, [], { force: true });
    const path = join(root, ".github", "workflows", CLOSING_REFERENCES_WORKFLOW_FILE);
    return existsSync(path) ? readFileSync(path, "utf-8") : "";
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("SC-2743: scaffold emits closing-references.yml as an owned workflow", () => {
  const yml = generated();
  const doc = (yml ? Bun.YAML.parse(yml) : {}) as any;

  test("a consumer's scaffold writes it, stamped as the harness's", () => {
    expect(yml, `scaffold wrote no ${CLOSING_REFERENCES_WORKFLOW_FILE}`).not.toBe("");
    expect(yml).toContain("generated-sha:");
    expect(Object.keys(doc.jobs ?? {})).toEqual([CLOSING_REFERENCES_JOB]);
  });

  test("it runs on pull request edits and in a merge queue, with read-only permissions", () => {
    expect(doc.on.pull_request.types).toEqual(["opened", "synchronize", "reopened", "edited"]);
    expect("merge_group" in doc.on, "a required check with no merge_group trigger hangs a queue").toBe(true);
    expect(doc.permissions).toEqual({ contents: "read", "pull-requests": "read", issues: "read" });
  });

  test("it calls the published CLI, never a script path a consumer does not have", () => {
    const runs = (doc.jobs[CLOSING_REFERENCES_JOB].steps as any[]).map(s => String(s.run ?? "")).join("\n");
    expect(runs).toMatch(new RegExp(`bunx rungate@\\S+ ${CLOSING_REFERENCES_COMMAND} --repo "\\$GITHUB_REPOSITORY"`));
    expect(runs, "a consumer has node_modules/rungate, not scripts/").not.toContain("bun scripts/");
    expect(CLOSING_REFERENCES_COMMAND in CLI_COMMANDS, "the workflow calls a command the CLI does not register").toBe(true);
  });

  test("every action is the reference lib/workflow-actions.ts declares for it", () => {
    // That table decides tag or SHA per action, with a reason (#377); a
    // generator spelling its own reference would be a second decider.
    const uses = (doc.jobs[CLOSING_REFERENCES_JOB].steps as any[]).map(s => s.uses).filter(Boolean) as string[];
    expect(uses.map(u => u.split("@")[0])).toEqual(["actions/checkout", "oven-sh/setup-bun"]);
    // The YAML parser drops the trailing `# vN` comment actionRef appends.
    expect(uses.filter(u => u !== actionRef(u.split("@")[0]!).split(" #")[0])).toEqual([]);
  });

  // #2921 (SC-2820): the audit reads which ADRs a pull request changes from
  // this list, so it needs the total beside the nodes (a list cut at 100 could
  // hide the ADR) and each file's change type (a deleted ADR is not read).
  test("#2921: the query sends the changed files' total and change types, and the step forwards the total", () => {
    const step = (doc.jobs[CLOSING_REFERENCES_JOB].steps as any[]).find(s => s.env?.QUERY);
    expect(String(step?.env?.QUERY)).toContain("files(first: 100) { totalCount nodes { path changeType } }");
    expect(String(step?.run)).toContain("filesTotal: .files.totalCount");
  });

  test("this repository's copy is the generated one, untouched", () => {
    const row = workflowCensus(ROOT).files.find(f => f.name === CLOSING_REFERENCES_WORKFLOW_FILE);
    expect(row?.status, row?.detail).toBe("generated-and-unchanged");
  });
});

/**
 * The step's `run:` body, executed as Actions runs it (`bash -e`), with a fake
 * `gh` that records its arguments and prints a payload, and a fake `bunx` that
 * records its arguments and reads stdin.
 */
describe("#2045: the step reads one pull request, in a pull request run or a queue run", () => {
  const run = (env: Record<string, string>, ghFails = false) => {
    const dir = mkdtempSync(join(tmpdir(), "rg-closing-refs-step-"));
    try {
      const log = join(dir, "calls");
      writeFileSync(
        join(dir, "gh"),
        `#!/bin/sh\nprintf 'gh|%s\\n' "$*" >> "${log}"\n${ghFails ? 'echo "gh: HTTP 502" >&2\nexit 1\n' : 'echo \'{"number":1}\'\n'}`,
        { mode: 0o755 },
      );
      writeFileSync(join(dir, "bunx"), `#!/bin/sh\nprintf 'bunx|%s|stdin=%s\\n' "$*" "$(cat)" >> "${log}"\n`, { mode: 0o755 });
      const r = spawnSync("bash", ["-e", "-c", buildClosingReferencesScript("9.9.9")], {
        env: { PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: "o/r", QUERY: "q", ...env },
        encoding: "utf-8",
      });
      const calls = existsSync(log) ? readFileSync(log, "utf-8").split("\n").filter(Boolean) : [];
      return { status: r.status, out: `${r.stdout}${r.stderr}`, calls };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("a pull request run reads that pull request and hands the payload to the CLI", () => {
    const r = run({ PR: "42", QUEUE_REF: "" });
    expect(r.status, r.out).toBe(0);
    expect(r.calls[0]).toContain("number=42");
    expect(r.calls[1]).toBe(`bunx|rungate@9.9.9 ${CLOSING_REFERENCES_COMMAND} --repo o/r|stdin={"number":1}`);
  });

  test("a merge-queue run reads the pull request its queue ref names", () => {
    const r = run({ PR: "", QUEUE_REF: "refs/heads/gh-readonly-queue/main/pr-123-0123456789abcdef0123456789abcdef01234567" });
    expect(r.status, r.out).toBe(0);
    expect(r.calls[0]).toContain("number=123");
  });

  test("with no pull request to read, the step refuses UNMEASURED and reads nothing", () => {
    const r = run({ PR: "", QUEUE_REF: "refs/heads/main" });
    expect(r.calls, "a run with no pull request read one anyway").toEqual([]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("UNMEASURED");
  });

  test("a failed query stops the step red, never a clean payload for the CLI", () => {
    const r = run({ PR: "42", QUEUE_REF: "" }, true);
    expect(r.status, "a failed gh api must fail the step under bash -e").not.toBe(0);
  });
});
