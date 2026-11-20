/**
 * Covers SC-2790 (SPEC-TO-BOARD-PIPELINE-SPEC.md), #2481, ADR-023 row 4:
 * `rungate scaffold` emits `.github/workflows/board-flow.yml` as an owned
 * workflow that calls the published CLI and reads the board from `board.id`,
 * so a consumer's card moves to In progress when its issue is assigned, to In
 * review when a pull request for it opens, and to Done or Cancelled when it
 * closes. This repository's copy is the generated one.
 *
 * It was caller-owned here and ran `bun scripts/board-flow.ts --project
 * "$RUNGATE_PROJECT_ID"`: a script path no consumer has, and a board id in a
 * repository variable rather than the config. `rungate board-flow` shipped in
 * 0.8.38 (#2507) and reads `board.id` itself, so the generated job names
 * neither.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { CLI_COMMANDS } from "../lib/cli-commands";
import {
  BOARD_FLOW_COMMAND,
  BOARD_FLOW_JOB,
  BOARD_FLOW_WORKFLOW_FILE,
  buildBoardFlowScript,
  buildBoardFlowWorkflow,
} from "../lib/scaffold/board-flow-workflow";
import { buildBoardReadyGateScript, NO_BOARD_REFUSAL } from "../lib/scaffold/board-ready-workflow";
import { OWNED_FILES } from "../lib/scaffold/owned-files";
import { workflowCensus } from "../lib/scaffold/workflow-census";

const ROOT = join(import.meta.dir, "..");
const OPTS = {
  runsOn: '"ubuntu-latest"',
  checkout: "actions/checkout@abc",
  setupBun: "oven-sh/setup-bun@def",
  setupBunWith: "          bun-version-file: .bun-version",
  setupBunEnv: "",
  version: "9.9.9",
};

type Step = { id?: string; name?: string; run?: string; env?: Record<string, string>; uses?: string; with?: Record<string, string>; if?: string };
const yml = () => buildBoardFlowWorkflow(OPTS);
const doc = () =>
  Bun.YAML.parse(yml()) as {
    on: { issues: { types: string[] }; pull_request_target: { types: string[] } };
    permissions: Record<string, string>;
    jobs: Record<string, { steps: Step[] }>;
  };
const steps = () => doc().jobs[BOARD_FLOW_JOB]!.steps;

describe("SC-2790: board-flow.yml is generated, calls the published CLI, and reads the board from board.id", () => {
  test("SC-2790: it hears every event that moves a card: assigned, opened or ready, and closed", () => {
    const on = doc().on;
    expect(on.issues.types).toEqual(["assigned", "closed", "reopened"]);
    expect(on.pull_request_target.types).toEqual(["opened", "ready_for_review", "closed"]);
  });

  test("SC-2790: it runs the published command and names no board, no script path and no project variable", () => {
    const text = yml();
    expect(text).toContain(`bunx rungate@9.9.9 ${BOARD_FLOW_COMMAND} `);
    expect(Object.keys(CLI_COMMANDS)).toContain(BOARD_FLOW_COMMAND);
    expect(text).not.toContain("scripts/board-flow.ts");
    expect(text).not.toContain("RUNGATE_PROJECT_ID");
    expect(text, "the board is board.id in the checked-out config").not.toMatch(/--project\b/);
    expect(text, "no dependency install: bunx fetches the published package").not.toMatch(/bun install/);
  });

  test("SC-2790: the trust gate is board-ready's own, and it runs before the checkout", () => {
    const all = steps();
    const gate = all.findIndex(s => s.id === "gate");
    const checkout = all.findIndex(s => (s.uses ?? "").startsWith("actions/checkout@"));
    expect(gate, "no gate step").toBeGreaterThan(-1);
    expect(checkout, "no checkout: the config is the input").toBeGreaterThan(gate);
    expect(all[gate]!.run!.trim()).toBe(buildBoardReadyGateScript().trim());
    // The base, never the pull request's head: no contributor code runs beside the token.
    expect(all[checkout]!.with?.ref, "the checkout must take the default ref").toBeUndefined();
  });

  test("SC-2790: every input reaches the script through env, never spliced into it", () => {
    const write = steps().find(s => (s.run ?? "").includes(`bunx rungate@`))!;
    expect(write.run).not.toMatch(/\$\{\{/);
    expect(write.env?.ISSUE).toMatch(/github\.event\.issue\.number/);
    expect(write.env?.PR_AUTHOR).toMatch(/github\.event\.pull_request\.user\.login/);
    expect(write.env?.BOARD_PROJECT_TOKEN).toMatch(/secrets\.RUNGATE_PROJECT_TOKEN/);
  });

  test("SC-2790: the scaffold owns the file, as a job-preserving managed workflow", () => {
    const row = OWNED_FILES.find(f => f.path === `.github/workflows/${BOARD_FLOW_WORKFLOW_FILE}`);
    expect(row?.strategy, "board-flow.yml is not in OWNED_FILES").toBe("job-preserving");
  });

  test("SC-2790: this repository's copy is the generated one, untouched", () => {
    const row = workflowCensus(ROOT).files.find(f => f.name === BOARD_FLOW_WORKFLOW_FILE);
    expect(row?.status, row?.detail).toBe("generated-and-unchanged");
  });
});

/**
 * The write step, run in bash against a `bunx` that answers as the command
 * would. Only `rungate board-flow`'s own no-board refusal becomes an
 * annotation; every other exit stands, as in `board-ready.yml`.
 */
describe("#2481: a tree with no board.id is UNMEASURED, not a red run, and every other exit stands", () => {
  const run = (answer: { code: number; stderr: string }) => {
    const bin = mkdtempSync(join(tmpdir(), "board-flow-bunx-"));
    const temp = mkdtempSync(join(tmpdir(), "board-flow-runner-"));
    try {
      writeFileSync(join(bin, "bunx"), `#!/bin/sh\necho "$@" >&2\necho ${JSON.stringify(answer.stderr)} >&2\nexit ${answer.code}\n`);
      chmodSync(join(bin, "bunx"), 0o755);
      const r = spawnSync("/bin/bash", ["-euo", "pipefail", "-c", buildBoardFlowScript("9.9.9")], {
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          RUNNER_TEMP: temp,
          GITHUB_REPOSITORY: "o/n",
          KIND: "issue_assigned",
          ISSUE: "42",
          PR: "",
          STATE_REASON: "",
          ACTOR: "someone",
          PR_AUTHOR: "",
        },
        encoding: "utf-8",
      });
      return { code: r.status, out: r.stdout + r.stderr };
    } finally {
      rmSync(bin, { recursive: true, force: true });
      rmSync(temp, { recursive: true, force: true });
    }
  };

  test("#2481: the no-board refusal is a warning and exit 0", () => {
    const r = run({ code: 2, stderr: `${NO_BOARD_REFUSAL} — pass --project <id>, or set board.id in the rungate config under /w. Nothing was read.` });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("::warning::UNMEASURED");
    expect(r.out, "the argv still names the event").toContain("board-flow --repo o/n --actor someone --event issue_assigned --issue 42 --write");
  });

  test("#2481: any other refusal stands", () => {
    expect(run({ code: 2, stderr: "UNMEASURED: --repo <owner/name> and --event <kind> are both required" }).code).toBe(2);
    expect(run({ code: 1, stderr: "boom" }).code).toBe(1);
  });

  test("#2481: a write that worked exits 0", () => {
    expect(run({ code: 0, stderr: "" }).code).toBe(0);
  });
});
