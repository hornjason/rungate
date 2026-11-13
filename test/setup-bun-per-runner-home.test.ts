/**
 * Every generated `oven-sh/setup-bun` step installs to a per-runner HOME.
 *
 * Why: setup-bun (pinned 0c5077e) writes the binary to
 * `os.homedir()/.bun/bin` and ignores `BUN_INSTALL`. On a self-hosted pool
 * whose runners share one `$HOME`, one job's install rewrites the binary while
 * another job is executing it, and the second job dies with `Text file busy` /
 * exit 126 before running anything (hornjason/asaCommandCenter#1849: 8 job
 * failures, 4 jobs, 6 runners). Consumers cannot fix the jobs rungate owns —
 * a hand edit is reverted on the next scaffold — so the generator has to.
 *
 * The workflows are generated into a scratch tree and PARSED (Bun.YAML), so
 * the assertions read each step's real `env` map rather than grepping text.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { SETUP_BUN_HOME, setupBunEnv } from "../lib/bun-version";
import { createCiWorkflows } from "../lib/scaffold/steps";

interface BunStep { file: string; job: string; index: number; env: Record<string, unknown> | undefined }

/** Scaffold the workflows into a scratch tree and read them back. */
function generated(shards?: number): { name: string; text: string }[] {
  const root = mkdtempSync(join(tmpdir(), "rungate-setup-bun-home-"));
  try {
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    // `ci.vertex` is declared so the ai-review job is emitted with its full
    // step list; an unconfigured fixture would hide that job's setup-bun step.
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "rungate", "config.json"),
      JSON.stringify({
        project: "setup-bun-home-fixture",
        ci: {
          ...(shards ? { shards } : {}),
          vertex: {
            project: "fixture-vertex-project",
            workloadIdentityProvider:
              "projects/111122223333/locations/global/workloadIdentityPools/fixture-pool/providers/fixture-provider",
          },
        },
      }) + "\n",
    );
    createCiWorkflows(root, []);
    const dir = join(root, ".github", "workflows");
    return readdirSync(dir)
      .filter(n => /\.ya?ml$/.test(n))
      .map(n => ({ name: n, text: readFileSync(join(dir, n), "utf-8") }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Every `oven-sh/setup-bun` step in a set of workflow files, with its env. */
function setupBunSteps(files: { name: string; text: string }[]): BunStep[] {
  const out: BunStep[] = [];
  for (const f of files) {
    const doc = Bun.YAML.parse(f.text) as { jobs?: Record<string, { steps?: any[] }> };
    for (const [job, def] of Object.entries(doc?.jobs ?? {})) {
      (def?.steps ?? []).forEach((s, index) => {
        if (typeof s?.uses === "string" && s.uses.startsWith("oven-sh/setup-bun@")) {
          out.push({ file: f.name, job, index, env: s.env });
        }
      });
    }
  }
  return out;
}

/** Steps whose install path is not the per-runner one. */
function sharedHomeSteps(steps: BunStep[]): string[] {
  return steps
    .filter(s => s.env?.HOME !== SETUP_BUN_HOME)
    .map(s => `${s.file}:${s.job}[${s.index}] HOME=${JSON.stringify(s.env?.HOME ?? null)}`);
}

// Unsharded emits the `test` job; sharded emits `test-shard` instead. Both
// fixtures are read, so every emitter of a setup-bun step is reached.
const FILES = [...generated(), ...generated(3).map(f => ({ ...f, name: `sharded/${f.name}` }))];
const STEPS = setupBunSteps(FILES);

describe("corpus floor — runs first, so an empty offender list is not an empty corpus", () => {
  test("every emitter is reached: test, test-shard, gates, ai-review, record-unmeasured", () => {
    const files = new Set(STEPS.map(s => s.file));
    for (const f of ["ci.yml", "gates.yml", "ai-review.yml", "ai-review-unmeasured.yml"]) {
      expect(files.has(f)).toBe(true);
    }
    const jobs = new Set(STEPS.map(s => s.job));
    for (const j of ["test", "test-shard", "gates", "ai-review", "record-unmeasured"]) {
      expect(jobs.has(j)).toBe(true);
    }
  });
});

describe("asaCommandCenter#1849: every generated setup-bun step has a per-runner HOME", () => {
  test("no generated setup-bun step installs into the shared HOME", () => {
    expect(sharedHomeSteps(STEPS)).toEqual([]);
  });

  test("the HOME is derived from runner.tool_cache, which differs per runner and survives between jobs", () => {
    // A constant (`/home/gharunner/bun-home`) or a workspace-derived path is
    // the same on every runner of the pool and fixes nothing.
    expect(SETUP_BUN_HOME).toMatch(/^\$\{\{\s*runner\.tool_cache\s*\}\}\//);
  });

  test("HOME is the only env the step declares — the redirect is scoped to the install", () => {
    const extra = STEPS.filter(s => Object.keys(s.env ?? {}).some(k => k !== "HOME"));
    expect(extra.map(s => `${s.file}:${s.job}`)).toEqual([]);
  });

  test("the emitted block is a step-level env (indented under the step, not the job)", () => {
    const block = setupBunEnv("        ");
    expect(block.split("\n")[0]).toBe("        env:");
    expect(block.trimEnd().endsWith(`HOME: ${SETUP_BUN_HOME}`)).toBe(true);
  });
});

describe("negative controls — the detector reports the defect and passes the fix", () => {
  const wf = (env: string) =>
    `jobs:\n  t:\n    steps:\n      - uses: oven-sh/setup-bun@abc\n        with:\n          bun-version-file: .bun-version\n${env}      - run: bun test\n`;

  test("a step with no env IS reported — the shipped defect", () => {
    expect(sharedHomeSteps(setupBunSteps([{ name: "x.yml", text: wf("") }]))).toEqual([
      'x.yml:t[0] HOME=null',
    ]);
  });

  test("a constant HOME IS reported", () => {
    const text = wf("        env:\n          HOME: /home/gharunner/bun-home\n");
    expect(sharedHomeSteps(setupBunSteps([{ name: "x.yml", text }]))).toHaveLength(1);
  });

  test("the per-runner HOME is NOT reported", () => {
    const text = wf(`        env:\n          HOME: ${SETUP_BUN_HOME}\n`);
    const steps = setupBunSteps([{ name: "x.yml", text }]);
    expect(steps).toHaveLength(1);
    expect(sharedHomeSteps(steps)).toEqual([]);
  });

  test("a non-setup-bun step is not collected", () => {
    const text = "jobs:\n  t:\n    steps:\n      - uses: actions/checkout@abc\n      - run: echo hi\n";
    expect(setupBunSteps([{ name: "x.yml", text }])).toEqual([]);
  });
});
