/**
 * #2273 — `rungate ci-reading --pr N`: a merged pull request's CI breakdown,
 * read from the GitHub API and printed (the command half of #1046).
 *
 * The API is a local stub (loopback is an allowed GITHUB_API_URL host), and
 * the script runs as a child with an async spawn so the stub keeps serving
 * while it waits. `ciReadingFor` itself is covered by test/ci-reading.test.ts;
 * this file covers what the command adds: the API reads, every attempt of a
 * re-run, the full-SHA lookup, both output formats, and that every failure
 * prints UNMEASURED with its reason and exits 0 (the reading is advisory).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "ci-reading.ts");
const SHA = "a".repeat(40);
const at = (hms: string) => `2026-11-16T${hms}.000Z`;

type Route = (url: URL) => { status: number; body: unknown } | undefined;
const seen: string[] = [];

function api(over: Partial<Record<"pr" | "runs" | "jobs1" | "jobs2" | "attempt1", unknown>> & { failPr?: boolean; paged?: boolean; endless?: boolean } = {}): Route {
  return (url) => {
    const p = url.pathname;
    seen.push(`${p}${url.search}`);
    if (p === "/repos/o/r/pulls/42") {
      if (over.failPr) return { status: 500, body: { message: "boom" } };
      return { status: 200, body: over.pr ?? { number: 42, created_at: at("10:00:00"), merged_at: at("10:30:00"), head: { sha: SHA } } };
    }
    if (p === "/repos/o/r/actions/runs") {
      return { status: 200, body: over.runs ?? { total_count: 1, workflow_runs: [{ id: 7, name: "ci", run_attempt: 2, status: "completed", created_at: at("10:11:00"), run_started_at: at("10:11:05") }] } };
    }
    if (p === "/repos/o/r/actions/runs/7/attempts/1") {
      return { status: 200, body: over.attempt1 ?? { id: 7, name: "ci", run_attempt: 1, status: "completed", created_at: at("10:01:00"), run_started_at: at("10:01:00") } };
    }
    if (p === "/repos/o/r/actions/runs/7/attempts/1/jobs") {
      return { status: 200, body: over.jobs1 ?? { total_count: 1, jobs: [{ name: "test", run_id: 7, run_attempt: 1, status: "completed", conclusion: "failure", started_at: at("10:01:10"), completed_at: at("10:03:10") }] } };
    }
    if (p === "/repos/o/r/actions/runs/7/attempts/2/jobs") {
      if (over.endless) {
        // A server that ignores `page`: a full page on every request.
        const jobs = Array.from({ length: 100 }, (_, i) => ({ name: `shard-${i}`, run_id: 7, run_attempt: 2, status: "completed", conclusion: "success", started_at: at("10:11:10"), completed_at: at("10:12:10") }));
        return { status: 200, body: { total_count: 100, jobs } };
      }
      if (over.paged) {
        // 100 on the first page, one more on the second: the 101st is only
        // seen by a reader that asks for page 2.
        const job = (name: string) => ({ name, run_id: 7, run_attempt: 2, status: "completed", conclusion: "success", started_at: at("10:11:10"), completed_at: at("10:12:10") });
        const page = url.searchParams.get("page");
        const jobs = page === "1" ? Array.from({ length: 100 }, (_, i) => job(`shard-${i}`)) : page === "2" ? [job("the-101st")] : [];
        return { status: 200, body: { total_count: 101, jobs } };
      }
      return { status: 200, body: over.jobs2 ??{ total_count: 1, jobs: [{ name: "test", run_id: 7, run_attempt: 2, status: "completed", conclusion: "success", started_at: at("10:11:10"), completed_at: at("10:15:10") }] } };
    }
    return undefined;
  };
}

let route: Route = api();
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const hit = route(new URL(req.url));
    if (!hit) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return new Response(JSON.stringify(hit.body), { status: hit.status, headers: { "content-type": "application/json" } });
  },
});
afterAll(() => server.stop(true));

async function run(args: string[], r: Route = api()) {
  route = r;
  seen.length = 0;
  const p = Bun.spawn(["bun", SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, GITHUB_TOKEN: "stub-token", GH_TOKEN: "stub-token", GITHUB_API_URL: `http://127.0.0.1:${server.port}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  // A hang is a failure, not a wait: kill the child so the case reports it.
  const killer = setTimeout(() => p.kill(), 15_000);
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(killer);
  return { stdout, stderr, code };
}

describe("#2273: a merged pull request's breakdown, read from the API", () => {
  test("prints every section, and reads every attempt of a re-run", async () => {
    const r = await run(["--pr", "42", "--repo", "o/r"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ci-reading #42: MEASURED");
    expect(r.stdout).toContain("ci / test");
    expect(r.stdout).toContain("4m 0s"); // the attempt that counted
    expect(r.stdout).toContain("re-runs: 1");
    expect(r.stdout).toContain("open → first check: 1m 10s");
    expect(r.stdout).toContain("critical path: 4m 0s (ci / test)");
    // the first attempt was fetched, not overwritten by the re-run
    expect(seen).toContain("/repos/o/r/actions/runs/7/attempts/1/jobs?per_page=100&page=1");
  });

  test("runs are looked up by the FULL head sha — a short one silently returns none", async () => {
    await run(["--pr", "42", "--repo", "o/r"]);
    const lookup = seen.find(s => s.startsWith("/repos/o/r/actions/runs?"));
    expect(lookup).toContain(`head_sha=${SHA}`);
  });

  test("a job list longer than one page is read to the end", async () => {
    const r = await run(["--pr", "42", "--repo", "o/r"], api({ paged: true }));
    expect(r.stdout).toContain("ci-reading #42: MEASURED");
    expect(r.stdout).toContain("ci / shard-99");
    expect(r.stdout).toContain("ci / the-101st");
  });

  test("a server that never ends its pages is UNMEASURED naming the cap, not a hang", async () => {
    const r = await run(["--pr", "42", "--repo", "o/r"], api({ endless: true }));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("UNMEASURED");
    expect(r.stdout).toContain("pages");
    expect(r.stdout).not.toContain("#42: MEASURED");
  }, 20_000);

  test("--format markdown prints a table a workflow can append to the job summary", async () => {
    const r = await run(["--pr", "42", "--repo", "o/r", "--format", "markdown"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("| Check | Duration |");
    expect(r.stdout).toContain("| ci / test | 4m 0s |");
  });
});

describe("#2273: what cannot be read prints UNMEASURED with its reason, and exits 0", () => {
  test("an unmerged pull request", async () => {
    const r = await run(["--pr", "42", "--repo", "o/r"], api({ pr: { number: 42, created_at: at("10:00:00"), merged_at: null, head: { sha: SHA } } }));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("UNMEASURED");
    expect(r.stdout).toContain("not merged");
    // and no Actions call is spent on it
    expect(seen.filter(s => s.includes("/actions/"))).toEqual([]);
    expect(seen).toContain("/repos/o/r/pulls/42");
  });

  test("a run still in progress", async () => {
    const r = await run(["--pr", "42", "--repo", "o/r"], api({ runs: { total_count: 1, workflow_runs: [{ id: 7, name: "ci", run_attempt: 1, status: "in_progress", created_at: at("10:01:00"), run_started_at: at("10:01:00") }] } }));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("UNMEASURED");
    expect(r.stdout).toContain("in_progress");
  });

  test("a failed API read is UNMEASURED naming the call, never an empty reading", async () => {
    const r = await run(["--pr", "42", "--repo", "o/r"], api({ failPr: true }));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("UNMEASURED");
    expect(r.stdout).toContain("500");
    expect(r.stdout).not.toContain("#42: MEASURED");
  });
});

describe("#2273: arguments", () => {
  test("a missing --pr or an unknown argument is refused by name, exit 2", async () => {
    const missing = await run(["--repo", "o/r"]);
    expect(missing.code).toBe(2);
    expect(missing.stderr + missing.stdout).toContain("--pr");
    const unknown = await run(["--pr", "42", "--repo", "o/r", "--write"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr + unknown.stdout).toContain("--write");
  });

  test("the command is registered, and published", () => {
    expect(readFileSync(join(ROOT, "lib", "cli-commands.ts"), "utf-8")).toContain('script: "scripts/ci-reading.ts"');
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
    expect(pkg.files).toContain("scripts/ci-reading.ts");
  });
});
