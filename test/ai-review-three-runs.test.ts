/**
 * CRC-B11: each AI review round is three separate reviewer invocations, and
 * the round's findings are their union with duplicates removed (#2648,
 * ADR-025 decision 2).
 *
 * The union itself — nothing voted away, a duplicate kept at its strictest
 * severity, a partial round establishing a block and never a pass — is
 * `mergeDrafts` and is held by `test/ai-review-drafts-merge.test.ts`. This
 * file holds the WIRING in the generated job, and every case in it is a
 * failure written down before the first push:
 *
 * - a run writing the round's payload directly instead of its own draft;
 * - a later run reading an earlier run's execution file as its own, because
 *   the action writes that file to one fixed path;
 * - the merge running inside the checkout, where the branch's own package
 *   files would resolve the command;
 * - a merge that could not run leaving the job with no outcome at all;
 * - a downstream step still reading run 1's outcome, so a round reported by
 *   another run is described as run 1.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredBunVersion, setupBunEnv, setupBunWith } from "../lib/bun-version";
import { CLAUDE_CODE_ACTION } from "../lib/claude-code-action";
import { GOOGLE_AUTH_ACTION } from "../lib/google-auth-action";
import {
  AI_REVIEW_ACTION_STEP_IDS,
  AI_REVIEW_DRIFT_STEP_ID,
  AI_REVIEW_BASELINE_STEP_ID,
  AI_REVIEW_JOB,
  AI_REVIEW_KEEP_EXECUTION_STEP_IDS,
  AI_REVIEW_MERGE_STEP_ID,
  AI_REVIEW_PREPARE_STEP_ID,
  AI_REVIEW_RUNS,
  aiReviewDraftBasename,
  aiReviewExecutionCopyBasename,
  buildKeepExecutionScript,
  buildMergeDraftsScript,
  buildReviewRunStep,
  type VertexCiDecision,
} from "../lib/scaffold/ai-review-step";
import { actionRef } from "../lib/workflow-actions";
import { stubBunx, stubBunxAbsent } from "./helpers/stub-bunx";

const SCRATCH: string[] = [];
const scratch = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  SCRATCH.push(d);
  return d;
};
afterAll(() => {
  for (const d of SCRATCH) rmSync(d, { recursive: true, force: true });
});

const REPO_ROOT = join(import.meta.dir, "..");
const VERSION = "0.0.0-fixture";
const VERTEX = {
  config: {
    project: "fixture-project",
    region: "global",
    workloadIdentityProvider: "projects/1/locations/global/workloadIdentityPools/p/providers/g",
  },
  reason: "fixture",
} as VertexCiDecision;
const JOB = buildReviewRunStep(
  VERTEX,
  {
    checkout: actionRef("actions/checkout"),
    auth: actionRef(GOOGLE_AUTH_ACTION),
    review: actionRef(CLAUDE_CODE_ACTION),
    setupBun: actionRef("oven-sh/setup-bun"),
    setupBunWith: setupBunWith(declaredBunVersion(REPO_ROOT), "    "),
    setupBunEnv: setupBunEnv("  "),
    uploadArtifact: actionRef("actions/upload-artifact"),
  },
  VERSION,
);
const STEPS: Record<string, any>[] = (() => {
  const doc = Bun.YAML.parse(
    `name: fixture\non:\n  pull_request:\njobs:\n  ${AI_REVIEW_JOB}:\n    runs-on: ubuntu-latest\n    steps:\n${JOB}`,
  ) as Record<string, any>;
  const steps = doc?.jobs?.[AI_REVIEW_JOB]?.steps;
  if (!Array.isArray(steps) || steps.length === 0) throw new Error("could not read the generated job's steps");
  return steps;
})();
const step = (id: string): Record<string, any> => {
  const found = STEPS.filter(s => s?.id === id);
  if (found.length !== 1) throw new Error(`${found.length} step(s) with id ${id}`);
  return found[0];
};
const dirExpr = `\${{ steps.${AI_REVIEW_PREPARE_STEP_ID}.outputs.dir }}`;
const canonicalExpr = `\${{ steps.${AI_REVIEW_PREPARE_STEP_ID}.outputs.path }}`;

describe("CRC-B11: three reviewer invocations, then one merge, in the generated job", () => {
  test("the round is three runs, each followed by keeping its execution file, then the merge, then the drift check", () => {
    expect(AI_REVIEW_RUNS).toBe(3);
    const ids = STEPS.map(s => String(s?.id ?? ""));
    const want = [
      ...AI_REVIEW_ACTION_STEP_IDS.flatMap((a, i) => [a, AI_REVIEW_KEEP_EXECUTION_STEP_IDS[i]]),
      AI_REVIEW_MERGE_STEP_ID,
      AI_REVIEW_DRIFT_STEP_ID,
    ];
    const start = ids.indexOf(AI_REVIEW_ACTION_STEP_IDS[0]);
    expect(ids[start - 1], "the runs start right after the baseline").toBe(AI_REVIEW_BASELINE_STEP_ID);
    expect(ids.slice(start, start + want.length)).toEqual(want);
    expect(new Set(AI_REVIEW_ACTION_STEP_IDS).size).toBe(AI_REVIEW_RUNS);
  });

  test("each run writes its own draft, and no run is told the round's payload path", () => {
    const prompts: string[] = [];
    AI_REVIEW_ACTION_STEP_IDS.forEach((id, i) => {
      const s = step(id);
      const draft = `${dirExpr}/${aiReviewDraftBasename(i + 1)}`;
      expect(s["continue-on-error"], `${id}: a failed run must not end the round`).toBe(true);
      expect(s.env?.AI_REVIEW_FINDINGS_PATH, id).toBe(draft);
      const prompt = String(s.with?.prompt ?? "");
      expect(prompt, `${id}: the prompt names its draft`).toContain(draft);
      expect(prompt, `${id}: the prompt names the round's payload path`).not.toContain(canonicalExpr);
      prompts.push(prompt.split(draft).join("<DRAFT>"));
    });
    const drafts = new Set(AI_REVIEW_ACTION_STEP_IDS.map((_, i) => aiReviewDraftBasename(i + 1)));
    expect(drafts.size, "two runs share a draft").toBe(AI_REVIEW_RUNS);
    expect(new Set(prompts).size, "the runs are reviewed with different prompts").toBe(1);
  });

  test("the runs are the same reviewer: one action, one model and tool set, one credential", () => {
    const shape = (s: Record<string, any>) =>
      JSON.stringify({ uses: s.uses, with: { ...s.with, prompt: undefined }, env: { ...s.env, AI_REVIEW_FINDINGS_PATH: undefined } });
    const shapes = new Set(AI_REVIEW_ACTION_STEP_IDS.map(id => shape(step(id))));
    expect(shapes.size).toBe(1);
  });

  test("each run's execution file is kept under its own name before the next run overwrites it", () => {
    AI_REVIEW_KEEP_EXECUTION_STEP_IDS.forEach((id, i) => {
      const s = step(id);
      expect(s.env?.AI_REVIEW_EXECUTION_FILE).toBe(`\${{ steps.${AI_REVIEW_ACTION_STEP_IDS[i]}.outputs.execution_file }}`);
      expect(s.env?.AI_REVIEW_EXECUTION_COPY_PATH).toBe(`${dirExpr}/${aiReviewExecutionCopyBasename(i + 1)}`);
    });
  });

  test("the merge is handed every run's outcome, in order, and the round's payload path", () => {
    const s = step(AI_REVIEW_MERGE_STEP_ID);
    expect(s.env?.AI_REVIEW_FINDINGS_PATH).toBe(canonicalExpr);
    AI_REVIEW_ACTION_STEP_IDS.forEach((id, i) => {
      expect(s.env?.[`AI_REVIEW_RUN_${i + 1}_OUTCOME`]).toBe(`\${{ steps.${id}.outcome }}`);
    });
  });

  test("after the merge, nothing reads a run's outcome or execution file — only the merge's", () => {
    const merge = `steps.${AI_REVIEW_MERGE_STEP_ID}.outputs`;
    const owners = new Set([AI_REVIEW_MERGE_STEP_ID, ...AI_REVIEW_KEEP_EXECUTION_STEP_IDS]);
    const readers = STEPS.filter(s => !owners.has(String(s?.id)));
    for (const s of readers) {
      const env = JSON.stringify(s.env ?? {});
      for (const run of AI_REVIEW_ACTION_STEP_IDS) {
        expect(env, `${s.id} reads ${run}'s outcome`).not.toContain(`steps.${run}.outcome`);
        expect(env, `${s.id} reads ${run}'s execution file`).not.toContain(`steps.${run}.outputs.execution_file`);
      }
    }
    const readsMerge = readers.filter(s => JSON.stringify(s.env ?? {}).includes(`${merge}.execution_file`));
    expect(readsMerge.length, "no step reads the round's execution file").toBeGreaterThan(0);
    expect(JSON.stringify(step("ai-review-run").env), "the report reads the round's outcome").toContain(`${merge}.outcome`);
  });

  test("no step this adds carries an if:, so none can report skipped", () => {
    for (const id of [...AI_REVIEW_ACTION_STEP_IDS, ...AI_REVIEW_KEEP_EXECUTION_STEP_IDS, AI_REVIEW_MERGE_STEP_ID]) {
      expect(step(id).if, id).toBeUndefined();
    }
  });
});

describe("#2648: keeping a run's execution file", () => {
  const runKeep = (env: Record<string, string>) =>
    spawnSync("bash", ["-c", buildKeepExecutionScript()], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf-8" });

  test("a written file is copied under the run's name and the fixed path is cleared", () => {
    const d = scratch("rg-keep-");
    const src = join(d, "claude-execution-output.json");
    writeFileSync(src, '{"run":1}');
    const r = runKeep({ AI_REVIEW_EXECUTION_FILE: src, AI_REVIEW_EXECUTION_COPY_PATH: join(d, "execution-1.json") });
    expect(r.status).toBe(0);
    expect(readFileSync(join(d, "execution-1.json"), "utf-8")).toBe('{"run":1}');
    expect(existsSync(src), "left at the fixed path for the next run to be read as").toBe(false);
  });

  test("a run that wrote none leaves no copy, and says so", () => {
    for (const src of ["", "/nonexistent/claude-execution-output.json"]) {
      const d = scratch("rg-keep-");
      const r = runKeep({ AI_REVIEW_EXECUTION_FILE: src, AI_REVIEW_EXECUTION_COPY_PATH: join(d, "execution-2.json") });
      expect(r.status).toBe(0);
      expect(existsSync(join(d, "execution-2.json"))).toBe(false);
      expect(r.stdout).toContain("wrote no execution file");
    }
  });

  test("run 2 that writes nothing is not read as run 1, whose file sat at the same fixed path", () => {
    const d = scratch("rg-keep-");
    const fixed = join(d, "claude-execution-output.json");
    writeFileSync(fixed, '{"run":1}');
    runKeep({ AI_REVIEW_EXECUTION_FILE: fixed, AI_REVIEW_EXECUTION_COPY_PATH: join(d, "execution-1.json") });
    // Run 2 crashed before writing, but reports the same fixed path.
    const r = runKeep({ AI_REVIEW_EXECUTION_FILE: fixed, AI_REVIEW_EXECUTION_COPY_PATH: join(d, "execution-2.json") });
    expect(r.status).toBe(0);
    expect(existsSync(join(d, "execution-2.json"))).toBe(false);
  });

  test("a copy it cannot make is a warning, leaves no partial copy, and still clears the fixed path", () => {
    const d = scratch("rg-keep-");
    const src = join(d, "claude-execution-output.json");
    writeFileSync(src, '{"run":3}');
    const dest = join(d, "missing-dir", "execution-3.json");
    const r = runKeep({ AI_REVIEW_EXECUTION_FILE: src, AI_REVIEW_EXECUTION_COPY_PATH: dest });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("::warning");
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(src)).toBe(false);
  });
});

describe("#2648: the merge step", () => {
  /** A findings dir as the prepare step leaves it, plus the copies the keep steps made. */
  const fixture = (copies: number[]) => {
    const dir = scratch("rg-merge-step-");
    for (const k of copies) writeFileSync(join(dir, aiReviewExecutionCopyBasename(k)), "{}");
    const out = join(dir, "github-output");
    writeFileSync(out, "");
    return { dir, payload: join(dir, "ai-review-findings.json"), out };
  };
  const runMerge = (path: string, f: ReturnType<typeof fixture>, outcomes: Record<string, string>) =>
    spawnSync("bash", ["-c", buildMergeDraftsScript(VERSION)], {
      env: { PATH: path, AI_REVIEW_FINDINGS_PATH: f.payload, GITHUB_OUTPUT: f.out, ...outcomes },
      encoding: "utf-8",
      cwd: REPO_ROOT,
    });
  // A bunx that records where it ran and what it was asked, then exits with $STUB_EXIT.
  const recorder = (log: string, exit = 0) =>
    stubBunx(`pwd > "${log}.pwd"; printf '%s\\n' "$@" > "${log}"; exit ${exit}`);

  test("it runs the pinned command from the findings dir with every run's outcome, kept file and draft, in order", () => {
    const f = fixture([1, 3]);
    const log = join(f.dir, "argv");
    const r = runMerge(recorder(log), f, { AI_REVIEW_RUN_1_OUTCOME: "success", AI_REVIEW_RUN_2_OUTCOME: "failure", AI_REVIEW_RUN_3_OUTCOME: "success" });
    expect(r.status).toBe(0);
    const argv = readFileSync(log, "utf-8").trimEnd().split("\n");
    const at = (flag: string) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));
    expect(argv.slice(0, 2)).toEqual([`rungate@${VERSION}`, "ai-review-merge-drafts"]);
    expect(at("--out")).toEqual([f.payload]);
    expect(at("--github-output")).toEqual([f.out]);
    expect(at("--outcome")).toEqual(["success", "failure", "success"]);
    expect(at("--execution")).toEqual([join(f.dir, aiReviewExecutionCopyBasename(1)), "", join(f.dir, aiReviewExecutionCopyBasename(3))]);
    expect(argv.slice(-3)).toEqual([1, 2, 3].map(k => join(f.dir, aiReviewDraftBasename(k))));
    expect(readFileSync(`${log}.pwd`, "utf-8").trim(), "ran inside the checkout").not.toBe(REPO_ROOT);
  });

  test("a run with no outcome is passed as a failure, never as a success", () => {
    const f = fixture([]);
    const log = join(f.dir, "argv");
    runMerge(recorder(log), f, { AI_REVIEW_RUN_1_OUTCOME: "success" });
    const argv = readFileSync(log, "utf-8").trimEnd().split("\n");
    expect(argv.flatMap((a, i) => (a === "--outcome" ? [argv[i + 1]] : []))).toEqual(["success", "failure", "failure"]);
  });

  test("a merge that succeeded adds nothing of its own to the step's outputs", () => {
    const f = fixture([1]);
    const r = runMerge(recorder(join(f.dir, "argv")), f, { AI_REVIEW_RUN_1_OUTCOME: "success" });
    expect(r.status).toBe(0);
    expect(readFileSync(f.out, "utf-8")).toBe("");
  });

  for (const [name, path] of [
    ["refused", (f: ReturnType<typeof fixture>) => recorder(join(f.dir, "argv"), 2)],
    ["could not run at all", () => stubBunxAbsent()],
  ] as const) {
    test(`a merge that ${name} leaves no payload, reports run 1 as failed, and names the round UNMEASURED`, () => {
      const f = fixture([1]);
      writeFileSync(f.payload, '{"findings":[]}');
      const r = runMerge(path(f), f, { AI_REVIEW_RUN_1_OUTCOME: "success" });
      expect(r.status).toBe(0);
      expect(existsSync(f.payload), "a payload the merge did not finish is left for the adjudicator").toBe(false);
      expect(readFileSync(f.out, "utf-8")).toBe(`outcome=failure\nexecution_file=${join(f.dir, aiReviewExecutionCopyBasename(1))}\n`);
      expect(r.stdout).toMatch(/::error title=AI review drafts::UNMEASURED/);
    });
  }
});

