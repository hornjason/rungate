#!/usr/bin/env bun
/**
 * `rungate owned-jobs` (#2503) — every workflow file the scaffold writes for
 * THIS project's config, and the jobs it owns in each.
 *
 * A consumer's own test needs to tell rungate's jobs from its own. Until now
 * it kept a hand-written list, and every release that added a generated
 * workflow broke that test until someone edited the list by hand (0.8.37's
 * `criterion-label` did). `ci.yml` and `gates.yml` are job-preserving: rungate
 * owns one named job in each and the consumer may add more, so the files
 * themselves cannot say which jobs are rungate's.
 *
 * So this runs the scaffold's own workflow generator, `createCiWorkflows`,
 * into a scratch directory holding a copy of the project's config, and reads
 * the `jobs:` keys of what it wrote. A scratch tree has no consumer jobs in
 * it, so what is there is exactly what rungate owns. No list lives here: a
 * job added to any generator appears in this output with no edit to this
 * file. A config that is absent or does not read is UNMEASURED, never an
 * empty map — an empty map reads as "rungate owns nothing".
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, relative, resolve } from "path";

import { resolveConfig } from "../lib/config-loader";
import { createCiWorkflows } from "../lib/scaffold/steps";

/** The one refusal exit code: UNMEASURED, nothing on stdout. */
export const EXIT_REFUSED = 2;

export type OwnedJobs = Record<string, string[]>;
export type OwnedJobsReading = { owned: OwnedJobs } | { unmeasured: string };

export function ownedJobs(root: string): OwnedJobsReading {
  let resolution: ReturnType<typeof resolveConfig>;
  try {
    resolution = resolveConfig(root);
  } catch (e) {
    return { unmeasured: `the rungate config under ${root} could not be read: ${(e as Error).message}` };
  }
  if (resolution.status === "absent") {
    return { unmeasured: `no rungate config under ${root}, so there is no config to generate this project's workflows from` };
  }

  const scratch = mkdtempSync(join(tmpdir(), "rungate-owned-jobs-"));
  try {
    // The config the generators read, wherever the loader found it, and the
    // package manifest the test-command decision reads.
    const target = join(scratch, relative(root, resolution.path));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(resolution.path, target, { recursive: true });
    if (existsSync(join(root, "package.json"))) copyFileSync(join(root, "package.json"), join(scratch, "package.json"));

    const actions: string[] = [];
    // A generator refuses in two ways: a `REFUSED:` action from the per-file
    // loop, or a throw before it — `ci.trackerTokenSecret` validation is one
    // (review of #2579). Both are UNMEASURED; a throw must not become a crash.
    try {
      createCiWorkflows(scratch, actions);
    } catch (e) {
      return { unmeasured: `the workflow generators refused this config: ${(e as Error).message}` };
    }
    const refused = actions.filter(a => a.startsWith("REFUSED:"));
    if (refused.length > 0) return { unmeasured: `the workflow generators refused: ${refused.join("; ")}` };

    const dir = join(scratch, ".github", "workflows");
    const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".yml")).sort() : [];
    if (files.length === 0) return { unmeasured: "the workflow generators wrote no workflow file" };

    const owned: OwnedJobs = {};
    for (const f of files) {
      const doc = Bun.YAML.parse(readFileSync(join(dir, f), "utf-8")) as { jobs?: unknown } | null;
      const jobs = doc && typeof doc.jobs === "object" && doc.jobs !== null ? Object.keys(doc.jobs) : [];
      if (jobs.length === 0) return { unmeasured: `.github/workflows/${f} was generated with no jobs, so what it owns could not be read` };
      owned[`.github/workflows/${f}`] = jobs;
    }
    return { owned };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const USAGE = "rungate owned-jobs [--json] [--project-root <dir>]";

export function main(argv: readonly string[]): number {
  let json = false;
  let rootArg: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--project-root") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        console.error(`UNMEASURED: --project-root needs a directory after it. Usage: ${USAGE}. Nothing was read.`);
        return EXIT_REFUSED;
      }
      rootArg = next;
      i++;
    } else {
      console.error(`UNMEASURED: unknown argument ${JSON.stringify(a)}. Usage: ${USAGE}. Nothing was read.`);
      return EXIT_REFUSED;
    }
  }
  const reading = ownedJobs(resolve(rootArg ?? process.cwd()));
  if ("unmeasured" in reading) {
    console.error(`UNMEASURED: ${reading.unmeasured}. Nothing was printed.`);
    return EXIT_REFUSED;
  }
  if (json) console.log(JSON.stringify(reading.owned, null, 2));
  else for (const [file, jobs] of Object.entries(reading.owned)) console.log(`${file}: ${jobs.join(", ")}`);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
