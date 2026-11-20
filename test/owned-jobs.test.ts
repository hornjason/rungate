/**
 * #2503: `rungate owned-jobs` prints the workflow jobs the scaffold owns, for
 * this project's config, so a consumer's test stops keeping its own list.
 *
 * Our first consumer's test hand-lists the jobs rungate generates, to tell
 * rungate's steps from its own. Every release that adds a generated workflow
 * breaks it until somebody edits the list; 0.8.37's `criterion-label` did.
 * `ci.yml` and `gates.yml` are job-preserving — rungate owns one named job in
 * each and the consumer may add more — so nothing in the files themselves
 * says which jobs are rungate's.
 *
 * The answer has to come from the generators the scaffold runs, never from a
 * second hand-kept list, or it drifts exactly the way the consumer's did. The
 * agreement case (OJ-3) is what holds that: it compares the command's output
 * with what a real scaffold run wrote.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { EXIT_REFUSED, ownedJobs } from "../scripts/owned-jobs";
import { initFixtureRepo, commitFixture } from "./helpers/git-fixture";

const ROOT = join(import.meta.dir, "..");
const FIXTURE = join(import.meta.dir, "fixtures", "golden-project");
const CONSUMER_JOB = "consumer-own-job";

let project = "";
const scratch: string[] = [];

beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), "rg-owned-jobs-"));
  scratch.push(project);
  cpSync(FIXTURE, project, { recursive: true });
  initFixtureRepo(project);
  commitFixture(project, "init fixture");
  const scaffold = spawnSync("bun", [join(ROOT, "scripts", "scaffold-project.ts"), project, "--fix"], { timeout: 60_000, encoding: "utf-8" });
  if (scaffold.status !== 0) throw new Error(`the fixture scaffold failed: ${scaffold.stderr}`);
  // A consumer's own job beside the generated one, which a re-scaffold keeps.
  const ci = join(project, ".github", "workflows", "ci.yml");
  writeFileSync(ci, readFileSync(ci, "utf-8").trimEnd() + `\n  ${CONSUMER_JOB}:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo mine\n`);
}, 90_000);

afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function owned(root: string): Record<string, string[]> {
  const r = ownedJobs(root);
  if (!("owned" in r)) throw new Error(`expected a measured reading, got: ${r.unmeasured}`);
  return r.owned;
}

function jobsIn(path: string): string[] {
  const doc = Bun.YAML.parse(readFileSync(path, "utf-8")) as { jobs?: Record<string, unknown> };
  return Object.keys(doc?.jobs ?? {});
}

describe("#2503: rungate owned-jobs", () => {
  test("OJ-1: names the generated job in ci.yml, gates.yml and criterion-label.yml", () => {
    const o = owned(project);
    expect(o[".github/workflows/ci.yml"]).toContain("test");
    expect(o[".github/workflows/gates.yml"]).toContain("gates");
    expect(o[".github/workflows/criterion-label.yml"]).toEqual(["criterion-label"]);
  });

  test("OJ-2: a consumer's own job in ci.yml is not listed, though the file carries it", () => {
    expect(jobsIn(join(project, ".github", "workflows", "ci.yml")), "the planted job is missing, so the case reads nothing").toContain(CONSUMER_JOB);
    expect(owned(project)[".github/workflows/ci.yml"]).not.toContain(CONSUMER_JOB);
  });

  test("OJ-3: agrees with the workflows a real scaffold wrote: same files, and every owned job is in its file", () => {
    const dir = join(project, ".github", "workflows");
    const stamped = readdirSync(dir)
      .filter(f => f.endsWith(".yml") && readFileSync(join(dir, f), "utf-8").includes("Managed by rungate"))
      .map(f => `.github/workflows/${f}`)
      .sort();
    expect(stamped.length, "the scaffold wrote no stamped workflow, so the agreement holds over nothing").toBeGreaterThan(5);
    const o = owned(project);
    expect(Object.keys(o).sort()).toEqual(stamped);
    for (const [file, jobs] of Object.entries(o)) {
      const inFile = jobsIn(join(project, file));
      expect(jobs.filter(j => !inFile.includes(j)), `${file} lists a job the scaffold did not write`).toEqual([]);
    }
  });

  test("OJ-4: no config, or a config that does not parse, is UNMEASURED — never an empty map", () => {
    const bare = mkdtempSync(join(tmpdir(), "rg-owned-jobs-bare-"));
    scratch.push(bare);
    const none = ownedJobs(bare);
    expect("unmeasured" in none && none.unmeasured).toContain("no rungate config");

    const broken = mkdtempSync(join(tmpdir(), "rg-owned-jobs-broken-"));
    scratch.push(broken);
    mkdirSync(join(broken, ".claude", "rungate"), { recursive: true });
    writeFileSync(join(broken, ".claude", "rungate", "config.json"), "{ not json");
    const bad = ownedJobs(broken);
    expect("unmeasured" in bad && bad.unmeasured).toContain("could not be read");
  });

  test("OJ-5: the CLI prints the same map as JSON, and refuses with exit 2 and nothing on stdout", () => {
    const run = (args: string[]) => spawnSync("bun", [join(ROOT, "bin", "rungate.ts"), "owned-jobs", ...args], { encoding: "utf-8" });
    const ok = run(["--json", "--project-root", project]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual(owned(project));

    const bare = mkdtempSync(join(tmpdir(), "rg-owned-jobs-cli-"));
    scratch.push(bare);
    const refused = run(["--json", "--project-root", bare]);
    expect(refused.status).toBe(EXIT_REFUSED);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("UNMEASURED");
  });
});

describe("#2503: a generator that throws is UNMEASURED, not a crash (review of #2579)", () => {
  test("OJ-6: a config the workflow generator refuses by throwing exits 2 with the reason, and nothing on stdout", () => {
    // `ci.trackerTokenSecret` is interpolated into a generated `${{ }}`
    // expression, so `trackerTokenSecret` throws on an illegal name, and it
    // throws before the per-file loop that turns refusals into actions.
    const bad = mkdtempSync(join(tmpdir(), "rg-owned-jobs-throw-"));
    scratch.push(bad);
    mkdirSync(join(bad, ".claude", "rungate"), { recursive: true });
    writeFileSync(
      join(bad, ".claude", "rungate", "config.json"),
      JSON.stringify({ ci: { suiteReadsTracker: true, trackerTokenSecret: "123-bad" } }),
    );
    const reading = ownedJobs(bad);
    expect("unmeasured" in reading && reading.unmeasured).toContain("trackerTokenSecret");

    const run = spawnSync("bun", [join(ROOT, "bin", "rungate.ts"), "owned-jobs", "--json", "--project-root", bad], { encoding: "utf-8" });
    expect(run.status, run.stderr).toBe(EXIT_REFUSED);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("UNMEASURED");
  });
});

describe("#2503: a config that cannot be copied is UNMEASURED, not a crash (review of #2579)", () => {
  test("OJ-7: an unreadable file in the config directory exits 2 with the reason, and nothing on stdout", () => {
    // resolveConfig reads only the files it knows, so it succeeds; the copy of
    // the whole directory into the scratch tree is what meets the unreadable one.
    const locked = mkdtempSync(join(tmpdir(), "rg-owned-jobs-locked-"));
    scratch.push(locked);
    mkdirSync(join(locked, ".claude", "rungate"), { recursive: true });
    writeFileSync(join(locked, ".claude", "rungate", "config.json"), "{}");
    const unreadable = join(locked, ".claude", "rungate", "extra.json");
    writeFileSync(unreadable, "{}");
    chmodSync(unreadable, 0o000);
    try {
      const reading = ownedJobs(locked);
      expect("unmeasured" in reading && reading.unmeasured).toContain("could not be copied");

      const run = spawnSync("bun", [join(ROOT, "bin", "rungate.ts"), "owned-jobs", "--json", "--project-root", locked], { encoding: "utf-8" });
      expect(run.status, run.stderr).toBe(EXIT_REFUSED);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("UNMEASURED");
    } finally {
      chmodSync(unreadable, 0o644);
    }
  });
});
