#!/usr/bin/env bun
/**
 * Wait for a tagged release to finish, and say whether it shipped (#2201).
 *
 *   bun scripts/release-wait.ts --version X.Y.Z [--repo owner/name]
 *
 * Step 6 of `docs/guides/RELEASING.md`. It used to be shell in the guide, and
 * review of #2198 spent five rounds finding the same kind of defect in it, one
 * line at a time: a wait with no exit, a run that had not registered read as a
 * failure, a broken-off watch read as a spent version. Shell in a guide has no
 * test, so nothing stopped the next edit reintroducing any of them. This file
 * is that step with a test (`test/release-wait.test.ts`).
 *
 * ## The five readings, and which of them spend the version
 *
 * | Reading      | Meaning                                              | Version |
 * |--------------|------------------------------------------------------|---------|
 * | `PUBLISHED`  | the run succeeded and the registry serves X.Y.Z      | shipped |
 * | `SPENT`      | the run's recorded conclusion is a failure           | spent   |
 * | `NO_RUN`     | no `release.yml` run registered for vX.Y.Z in time   | not spent |
 * | `NO_OUTCOME` | a run exists and its conclusion could not be read    | unknown |
 * | `NOT_SERVED` | the run succeeded and the registry does not serve it | unknown |
 *
 * Only `SPENT` tells the operator to cut the next version, and only a
 * recorded conclusion produces it — never an exit code from `gh run watch`,
 * which also fails on a dropped connection. `NO_RUN` and `NO_OUTCOME` are kept
 * apart from `SPENT` because confusing them is the expensive mistake: a
 * version number burned for a release that may have shipped.
 *
 * ## Properties `test/release-wait.test.ts` asserts
 *
 * 1. Every refusal exits through `REFUSE_EXIT`, declared exactly once; the
 *    test runs each negative case against a mutant with it set to 0.
 * 2. No relative imports, so the mutant loads from a temp directory.
 * 3. `gh` and `npm` are real subprocesses, found on PATH, so the test drives
 *    the script through the same calls it makes against GitHub and npm.
 */

import { readFileSync } from "fs";
import { join } from "path";

/** The one exit code every refusal travels through. */
export const REFUSE_EXIT = 1;

export type Reading = "PUBLISHED" | "SPENT" | "NO_RUN" | "NO_OUTCOME" | "NOT_SERVED";

/**
 * Conclusions GitHub records for a run that FINISHED without publishing.
 * `skipped` is one: every job's `if:` was false, the run is over, and nothing
 * shipped (review of #2198, round 6). `action_required` and `neutral` are
 * not: a run waiting on approval, or one whose meaning is unclear, is
 * NO_OUTCOME.
 */
const FAILED_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "startup_failure", "skipped"]);

export interface ReleaseInputs {
  /** The run's id, absent when no run registered in time. */
  runId?: string;
  /** The run's recorded conclusion, absent or empty when it could not be read. */
  conclusion?: string | null;
  /** Did the registry serve the version? Only consulted after a success. */
  served?: boolean;
}

/** The pure half: what the readings taken add up to. */
export function releaseReading(input: ReleaseInputs): { reading: Reading; detail: string } {
  if (!input.runId) {
    return {
      reading: "NO_RUN",
      detail: "no release.yml run registered for the tag in time. Check the tag was pushed. Nothing is spent.",
    };
  }
  const c = (input.conclusion ?? "").trim();
  if (FAILED_CONCLUSIONS.has(c)) {
    return {
      reading: "SPENT",
      detail: `run ${input.runId} concluded '${c}'. The version is spent: read the run's log, fix, and cut the next version.`,
    };
  }
  if (c !== "success") {
    return {
      reading: "NO_OUTCOME",
      detail: `run ${input.runId} has no readable outcome ('${c}'). Nothing is known to be spent; run this again.`,
    };
  }
  if (!input.served) {
    return {
      reading: "NOT_SERVED",
      detail: `run ${input.runId} succeeded but the registry is not serving the version. Stop and look; do not record it as published.`,
    };
  }
  return { reading: "PUBLISHED", detail: "" };
}

// ── the I/O half ────────────────────────────────────────────

function run(cmd: string[], timeoutMs: number): { out: string; ok: boolean } {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  return { out: new TextDecoder().decode(r.stdout).trim(), ok: r.exitCode === 0 };
}

function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** A non-negative integer flag, or the default. A malformed value is null. */
function intArg(name: string, argv: string[], fallback: number): number | null {
  const raw = arg(name, argv);
  if (raw === undefined) return fallback;
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

function sleep(ms: number): void {
  if (ms > 0) Bun.sleepSync(ms);
}

export function main(argv: string[]): number {
  const version = arg("version", argv);
  if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    console.error("usage: release-wait.ts --version X.Y.Z [--repo owner/name] [--workflow release.yml]");
    return REFUSE_EXIT;
  }
  const repo = arg("repo", argv);
  const workflow = arg("workflow", argv) ?? "release.yml";
  const runAttempts = intArg("run-attempts", argv, 12);
  const runIntervalMs = intArg("run-interval-ms", argv, 5_000);
  const registryAttempts = intArg("registry-attempts", argv, 20);
  const registryIntervalMs = intArg("registry-interval-ms", argv, 30_000);
  if ([runAttempts, runIntervalMs, registryAttempts, registryIntervalMs].some(n => n === null)) {
    console.error("release-wait: --run-attempts, --run-interval-ms, --registry-attempts and --registry-interval-ms take a whole number.");
    return REFUSE_EXIT;
  }

  let pkg: string;
  try {
    pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8")).name;
  } catch (e) {
    console.error(`release-wait: could not read the package name from ./package.json (${(e as Error).message}). Run it from the release worktree.`);
    return REFUSE_EXIT;
  }
  if (!pkg) {
    console.error("release-wait: ./package.json has no name, so there is nothing to look up on the registry.");
    return REFUSE_EXIT;
  }

  const r = repo ? ["-R", repo] : [];
  const tag = `v${version}`;

  let runId = "";
  for (let i = 0; i < runAttempts! && !runId; i++) {
    if (i > 0) sleep(runIntervalMs!);
    const list = run(["gh", "run", "list", ...r, "--workflow", workflow, "--branch", tag, "-L", "1",
      "--json", "databaseId", "-q", ".[0].databaseId // empty"], 60_000);
    if (list.ok) runId = list.out;
  }

  let conclusion: string | null = null;
  let served = false;
  if (runId) {
    // The watch's exit code is deliberately ignored: it fails on a dropped
    // connection as well as on a failed run. The conclusion is read after.
    run(["gh", "run", "watch", runId, ...r], 45 * 60_000);
    const view = run(["gh", "run", "view", runId, ...r, "--json", "conclusion", "-q", ".conclusion"], 60_000);
    conclusion = view.ok ? view.out : null;
    if (conclusion === "success") {
      for (let i = 0; i < registryAttempts! && !served; i++) {
        if (i > 0) sleep(registryIntervalMs!);
        const npm = run(["npm", "view", `${pkg}@${version}`, "version"], 60_000);
        served = npm.ok && npm.out === version;
      }
    }
  }

  const verdict = releaseReading({ runId, conclusion, served });
  if (verdict.reading !== "PUBLISHED") {
    console.error(`${verdict.reading}: ${tag}: ${verdict.detail}`);
    return REFUSE_EXIT;
  }
  console.log(`PUBLISHED: ${pkg}@${version} (run ${runId})`);
  return 0;
}

if (import.meta.main) process.exit(main(Bun.argv.slice(2)));
