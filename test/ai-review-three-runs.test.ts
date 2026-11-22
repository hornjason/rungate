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
 *   another run is described as run 1;
 * - every run can write the shared findings directory, so one run could plant
 *   another run's draft or transcript, overwrite an earlier run's draft, or
 *   leave the round's payload behind for a round that should have none. Each
 *   run's draft and transcript are moved out of that directory with their
 *   digest recorded as a step output the next run cannot change, and the
 *   merge reads a file whose digest moved as not written — so tampering can
 *   withhold a round or leave a block, never produce a pass.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredBunVersion, setupBunEnv, setupBunWith } from "../lib/bun-version";
import { CLAUDE_CODE_ACTION } from "../lib/claude-code-action";
import { GOOGLE_AUTH_ACTION } from "../lib/google-auth-action";
import {
  AI_REVIEW_ACTION_STEP_IDS,
  AI_REVIEW_DRIFT_STEP_ID,
  AI_REVIEW_BASELINE_STEP_ID,
  AI_REVIEW_KEPT_DIR_SUFFIX,
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
  AI_REVIEW_FINDINGS_PATH_VAR,
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

  test("after each run, a step keeps that run's draft and execution file, reading the run's own output", () => {
    AI_REVIEW_KEEP_EXECUTION_STEP_IDS.forEach((id, i) => {
      const s = step(id);
      expect(s.env?.AI_REVIEW_EXECUTION_FILE).toBe(`\${{ steps.${AI_REVIEW_ACTION_STEP_IDS[i]}.outputs.execution_file }}`);
      expect(s.env?.AI_REVIEW_FINDINGS_PATH).toBe(canonicalExpr);
      expect(String(s.run), `${id} keeps a different run`).toContain(aiReviewDraftBasename(i + 1));
    });
  });

  test("the merge is handed every run's outcome, in order, and the round's payload path", () => {
    const s = step(AI_REVIEW_MERGE_STEP_ID);
    expect(s.env?.AI_REVIEW_FINDINGS_PATH).toBe(canonicalExpr);
    AI_REVIEW_ACTION_STEP_IDS.forEach((id, i) => {
      expect(s.env?.[`AI_REVIEW_RUN_${i + 1}_OUTCOME`]).toBe(`\${{ steps.${id}.outcome }}`);
      const keep = AI_REVIEW_KEEP_EXECUTION_STEP_IDS[i];
      expect(s.env?.[`AI_REVIEW_RUN_${i + 1}_DRAFT_SHA`]).toBe(`\${{ steps.${keep}.outputs.draft_sha }}`);
      expect(s.env?.[`AI_REVIEW_RUN_${i + 1}_EXECUTION_SHA`]).toBe(`\${{ steps.${keep}.outputs.execution_sha }}`);
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

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** A findings directory as the prepare step leaves it, and the GITHUB_OUTPUT file a step appends to. */
const findingsDir = () => {
  const root = scratch("rg-three-runs-");
  const dir = join(root, "ai-review-1");
  mkdirSync(dir);
  const out = join(root, "github-output");
  writeFileSync(out, "");
  return { dir, kept: `${dir}${AI_REVIEW_KEPT_DIR_SUFFIX}`, payload: join(dir, "ai-review-findings.json"), out, root };
};
const outputs = (file: string) =>
  Object.fromEntries(readFileSync(file, "utf-8").trimEnd().split("\n").filter(Boolean).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

describe("#2648: keeping a run's draft and execution file out of the next run's reach", () => {
  const runKeep = (k: number, f: ReturnType<typeof findingsDir>, src: string) =>
    spawnSync("bash", ["-c", buildKeepExecutionScript(k)], {
      env: { PATH: process.env.PATH ?? "", AI_REVIEW_FINDINGS_PATH: f.payload, AI_REVIEW_EXECUTION_FILE: src, GITHUB_OUTPUT: f.out },
      encoding: "utf-8",
    });

  test("the run's draft and execution file are moved out, and their digests are the step's outputs", () => {
    const f = findingsDir();
    writeFileSync(join(f.dir, aiReviewDraftBasename(1)), '{"findings":[]}');
    const src = join(f.root, "claude-execution-output.json");
    writeFileSync(src, '{"run":1}');
    const r = runKeep(1, f, src);
    expect(r.status).toBe(0);
    expect(readFileSync(join(f.kept, aiReviewDraftBasename(1)), "utf-8")).toBe('{"findings":[]}');
    expect(readFileSync(join(f.kept, aiReviewExecutionCopyBasename(1)), "utf-8")).toBe('{"run":1}');
    expect(existsSync(join(f.dir, aiReviewDraftBasename(1))), "left where the next run can write it").toBe(false);
    expect(existsSync(src), "left at the fixed path for the next run to be read as").toBe(false);
    expect(outputs(f.out)).toEqual({ draft_sha: sha('{"findings":[]}'), execution_sha: sha('{"run":1}') });
  });

  test("what a run wrote for another run, or for the round, does not survive into the next run", () => {
    const f = findingsDir();
    writeFileSync(join(f.dir, aiReviewDraftBasename(2)), '{"findings":[],"verdict":"PASS"}');
    writeFileSync(join(f.dir, aiReviewDraftBasename(3)), '{"findings":[],"verdict":"PASS"}');
    writeFileSync(f.payload, '{"findings":[],"verdict":"PASS"}');
    runKeep(1, f, "");
    for (const k of [2, 3]) expect(existsSync(join(f.dir, aiReviewDraftBasename(k))), `a planted draft ${k}`).toBe(false);
    expect(existsSync(f.payload), "a planted round payload").toBe(false);
  });

  test("a run that wrote nothing keeps nothing, says so, and outputs empty digests — even over an old kept file", () => {
    const f = findingsDir();
    mkdirSync(f.kept);
    writeFileSync(join(f.kept, aiReviewDraftBasename(2)), "planted");
    writeFileSync(join(f.kept, aiReviewExecutionCopyBasename(2)), "planted");
    for (const src of ["", "/nonexistent/claude-execution-output.json"]) {
      writeFileSync(f.out, "");
      const r = runKeep(2, f, src);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("wrote no draft");
      expect(r.stdout).toContain("wrote no execution file");
      expect(existsSync(join(f.kept, aiReviewDraftBasename(2)))).toBe(false);
      expect(existsSync(join(f.kept, aiReviewExecutionCopyBasename(2)))).toBe(false);
      expect(outputs(f.out)).toEqual({ draft_sha: "", execution_sha: "" });
    }
  });

  test("run 2 that writes nothing is not read as run 1, whose transcript sat at the same fixed path", () => {
    const f = findingsDir();
    const fixed = join(f.root, "claude-execution-output.json");
    writeFileSync(fixed, '{"run":1}');
    runKeep(1, f, fixed);
    writeFileSync(f.out, "");
    runKeep(2, f, fixed);
    expect(existsSync(join(f.kept, aiReviewExecutionCopyBasename(2)))).toBe(false);
    expect(outputs(f.out).execution_sha).toBe("");
  });

  test("a copy it cannot make is a warning, leaves no partial copy, and still clears the fixed path", () => {
    const f = findingsDir();
    writeFileSync(join(f.root, "ai-review-1.kept"), "a file where the kept directory should be");
    const src = join(f.root, "claude-execution-output.json");
    writeFileSync(src, '{"run":3}');
    const r = runKeep(3, f, src);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("::warning");
    expect(existsSync(src)).toBe(false);
    expect(outputs(f.out)).toEqual({ draft_sha: "", execution_sha: "" });
  });
});

describe("#2648: the merge step", () => {
  /** Kept drafts and transcripts as the keep steps left them, and the digests they output. */
  const kept = (runs: Record<number, { draft?: string; execution?: string }>) => {
    const f = findingsDir();
    mkdirSync(f.kept);
    const env: Record<string, string> = {};
    for (const [k, r] of Object.entries(runs)) {
      if (r.draft !== undefined) {
        writeFileSync(join(f.kept, aiReviewDraftBasename(Number(k))), r.draft);
        env[`AI_REVIEW_RUN_${k}_DRAFT_SHA`] = sha(r.draft);
      }
      if (r.execution !== undefined) {
        writeFileSync(join(f.kept, aiReviewExecutionCopyBasename(Number(k))), r.execution);
        env[`AI_REVIEW_RUN_${k}_EXECUTION_SHA`] = sha(r.execution);
      }
    }
    return { ...f, env };
  };
  const runMerge = (path: string, f: ReturnType<typeof kept>, extra: Record<string, string> = {}) =>
    spawnSync("bash", ["-c", buildMergeDraftsScript(VERSION)], {
      env: { PATH: path, AI_REVIEW_FINDINGS_PATH: f.payload, GITHUB_OUTPUT: f.out, ...f.env, ...extra },
      encoding: "utf-8",
      cwd: REPO_ROOT,
    });
  // A bunx that records where it ran and what it was asked, then exits.
  const recorder = (log: string, exit = 0) => stubBunx(`pwd > "${log}.pwd"; printf '%s\\n' "$@" > "${log}"; exit ${exit}`);
  const argvOf = (log: string) => readFileSync(log, "utf-8").trimEnd().split("\n");
  const flag = (argv: string[], name: string) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
  const OUTCOMES = { AI_REVIEW_RUN_1_OUTCOME: "success", AI_REVIEW_RUN_2_OUTCOME: "failure", AI_REVIEW_RUN_3_OUTCOME: "success" };

  test("it runs the pinned command outside the checkout, with every run's outcome, kept transcript and kept draft, in order", () => {
    const f = kept({ 1: { draft: "d1", execution: "e1" }, 3: { draft: "d3", execution: "e3" } });
    const log = join(f.root, "argv");
    const r = runMerge(recorder(log), f, OUTCOMES);
    expect(r.status).toBe(0);
    const argv = argvOf(log);
    expect(argv.slice(0, 2)).toEqual([`rungate@${VERSION}`, "ai-review-merge-drafts"]);
    expect(flag(argv, "--out")).toEqual([f.payload]);
    expect(flag(argv, "--github-output")).toEqual([f.out]);
    expect(flag(argv, "--outcome")).toEqual(["success", "failure", "success"]);
    expect(flag(argv, "--execution")).toEqual([join(f.kept, aiReviewExecutionCopyBasename(1)), "", join(f.kept, aiReviewExecutionCopyBasename(3))]);
    expect(argv.slice(-3)).toEqual([1, 2, 3].map(k => join(f.kept, aiReviewDraftBasename(k))));
    expect(readFileSync(`${log}.pwd`, "utf-8").trim(), "ran inside the checkout").not.toBe(REPO_ROOT);
  });

  // #2664: every run can write the findings directory, and `bunx` resolves
  // bunfig.toml, .npmrc and package.json from its working directory upward.
  // So the merger runs from a directory made for it, holding nothing.
  test("#2664: it runs from a fresh empty directory, so a bunfig.toml a run planted is not read", () => {
    const f = kept({ 1: { draft: "d1" } });
    writeFileSync(join(f.dir, "bunfig.toml"), '[install]\nregistry = "https://registry.invalid/"\n');
    const log = join(f.root, "cwd");
    runMerge(stubBunx(`pwd > "${log}"; ls -A >> "${log}"; exit 0`), f, OUTCOMES);
    const [cwd, ...listed] = readFileSync(log, "utf-8").trimEnd().split("\n");
    expect([f.dir, f.kept, REPO_ROOT].map(d => realpathSync(d))).not.toContain(realpathSync(cwd));
    expect(listed, "the merger's directory is not empty").toEqual([]);
  });

  test("a round payload left before the merge is gone before the merge runs, so a withheld round has none", () => {
    const f = kept({ 1: { draft: "d1" } });
    writeFileSync(f.payload, '{"findings":[],"verdict":"PASS"}');
    const log = join(f.root, "argv");
    const r = runMerge(stubBunx(`test -e "${f.payload}" && echo PRESENT > "${log}" || echo ABSENT > "${log}"; exit 0`), f, OUTCOMES);
    expect(r.status).toBe(0);
    expect(readFileSync(log, "utf-8").trim()).toBe("ABSENT");
  });

  test("a kept draft or transcript whose digest moved after its run is passed as not written, and named", () => {
    const f = kept({ 1: { draft: "d1", execution: "e1" }, 2: { draft: "d2", execution: "e2" } });
    writeFileSync(join(f.kept, aiReviewDraftBasename(1)), '{"findings":[],"verdict":"PASS"}');
    writeFileSync(join(f.kept, aiReviewExecutionCopyBasename(2)), "forged");
    // Run 3 output no digest, but a draft appeared for it afterwards.
    writeFileSync(join(f.kept, aiReviewDraftBasename(3)), '{"findings":[],"verdict":"PASS"}');
    const log = join(f.root, "argv");
    const r = runMerge(recorder(log), f, OUTCOMES);
    const argv = argvOf(log);
    const drafts = argv.slice(-3);
    expect(existsSync(drafts[0]), "run 1's changed draft is read").toBe(false);
    expect(drafts[1]).toBe(join(f.kept, aiReviewDraftBasename(2)));
    expect(existsSync(drafts[2]), "a draft run 3 never wrote is read").toBe(false);
    expect(flag(argv, "--execution")).toEqual([join(f.kept, aiReviewExecutionCopyBasename(1)), "", ""]);
    expect(r.stdout.match(/::error title=AI review drafts::run \d+'s (draft|execution file) changed/g)?.length).toBe(3);
  });

  test("a run with no outcome is passed as a failure, never as a success", () => {
    const f = kept({});
    const log = join(f.root, "argv");
    runMerge(recorder(log), f, { AI_REVIEW_RUN_1_OUTCOME: "success" });
    expect(flag(argvOf(log), "--outcome")).toEqual(["success", "failure", "failure"]);
  });

  test("a merge that succeeded adds nothing of its own to the step's outputs", () => {
    const f = kept({ 1: { draft: "d1" } });
    const r = runMerge(recorder(join(f.root, "argv")), f, OUTCOMES);
    expect(r.status).toBe(0);
    expect(readFileSync(f.out, "utf-8")).toBe("");
  });

  for (const [name, path] of [
    ["refused", (f: ReturnType<typeof kept>) => recorder(join(f.root, "argv"), 2)],
    ["could not run at all", () => stubBunxAbsent()],
  ] as const) {
    test(`a merge that ${name} leaves no payload, reports run 1 as failed, and names the round UNMEASURED`, () => {
      const f = kept({ 1: { draft: "d1", execution: "e1" } });
      const r = runMerge(path(f), f, OUTCOMES);
      expect(r.status).toBe(0);
      expect(existsSync(f.payload)).toBe(false);
      expect(readFileSync(f.out, "utf-8")).toBe(`outcome=failure\nexecution_file=${join(f.kept, aiReviewExecutionCopyBasename(1))}\n`);
      expect(r.stdout).toMatch(/::error title=AI review drafts::UNMEASURED/);
    });
  }
});
