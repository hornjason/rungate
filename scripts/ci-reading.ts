#!/usr/bin/env bun
/**
 * `rungate ci-reading --pr <N> [--repo owner/name] [--format text|markdown]`
 * — a merged pull request's CI breakdown (#2273, the command half of #1046).
 *
 * Reads the pull request, every workflow run for its head commit (every
 * attempt of a re-run, not only the last), and each attempt's jobs, then
 * prints `ciReadingFor`'s reading: per-check duration, queue time, the
 * critical path, re-runs and the three spans. `--format markdown` prints the
 * same reading as a table a workflow appends to `$GITHUB_STEP_SUMMARY`.
 *
 * **Advisory: every reading exits 0, including UNMEASURED.** A workflow that
 * writes the summary must never be turned red by it. A reading that could not
 * be taken — not merged, a run in progress, no runs, no token, a failed API
 * call — prints UNMEASURED with the reason, never an empty table that reads as
 * "no CI". Only a malformed command line exits non-zero (`EXIT_USAGE`).
 *
 * Runs are looked up by the FULL head sha. The API accepts a short one and
 * silently returns no runs, which #1046 recorded; a head that is not 40 hex
 * characters is UNMEASURED rather than queried.
 */
import { createGitHubClient, parseOwnerRepo } from "../lib/github";
import { ciReadingFor, type CiReading, type JobShape, type Reading, type WorkflowRunShape } from "../lib/ci-reading";

/** The one non-zero exit: the command line, not the reading. */
export const EXIT_USAGE = 2;

const USAGE = "Usage: rungate ci-reading --pr <N> [--repo owner/name] [--format text|markdown]";
const PER_PAGE = 100;
/**
 * The page walk's bound (review, PR #2277). A server that ignores `page` and
 * answers a full page every time would otherwise loop forever, and a hang is
 * not a reading. 50 pages is 5,000 rows: far past any real run's jobs.
 */
export const MAX_PAGES = 50;

type Request = (route: string, params: Record<string, unknown>) => Promise<{ data: any }>;

export interface Args { pr: number; repo: string; format: "text" | "markdown" }

export function parseArgs(argv: readonly string[], env: Record<string, string | undefined>): Args | string {
  let pr: number | undefined;
  let repo = env.GITHUB_REPOSITORY;
  let format: Args["format"] = "text";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    const value = () => (next === undefined || next.startsWith("--") ? undefined : (i++, next));
    if (a === "--pr") {
      const v = value();
      if (v === undefined || !/^[1-9][0-9]*$/.test(v)) return `--pr needs a pull request number after it. ${USAGE}`;
      pr = Number(v);
    } else if (a === "--repo") {
      const v = value();
      if (v === undefined) return `--repo needs owner/name after it. ${USAGE}`;
      repo = v;
    } else if (a === "--format") {
      const v = value();
      if (v !== "text" && v !== "markdown") return `--format is text or markdown. ${USAGE}`;
      format = v;
    } else {
      return `unknown argument ${JSON.stringify(a)}. ${USAGE}`;
    }
  }
  if (pr === undefined) return `--pr is required. ${USAGE}`;
  if (!repo) return `--repo is required (or set GITHUB_REPOSITORY). ${USAGE}`;
  // A malformed slug is a malformed command line, not a reading that could not
  // be taken (#2279): checked here through the one parser, so it exits 2.
  try {
    parseOwnerRepo(repo);
  } catch (err) {
    return `--repo: ${(err as Error).message}. ${USAGE}`;
  }
  return { pr, repo, format };
}

/** A failed read, carrying the call that failed so the reason can name it. */
class ReadFailed extends Error {}

async function get(request: Request, route: string, params: Record<string, unknown>): Promise<any> {
  try {
    return (await request(`GET ${route}`, params)).data;
  } catch (err) {
    const e = err as { status?: number; message?: string };
    const path = route.replace(/\{(\w+)\}/g, (_, k) => String(params[k]));
    throw new ReadFailed(`GET ${path} failed: ${e.status ?? "no HTTP status"} ${e.message ?? String(err)}`.trim());
  }
}

async function getAll(request: Request, route: string, params: Record<string, unknown>, key: string): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await get(request, route, { ...params, per_page: PER_PAGE, page });
    const rows = data?.[key];
    if (!Array.isArray(rows)) throw new ReadFailed(`GET ${route} page ${page}: the reply has no ${key} array`);
    out.push(...rows);
    if (rows.length < PER_PAGE) return out;
  }
  throw new ReadFailed(`GET ${route} was still returning full pages after ${MAX_PAGES} pages; stopped rather than read forever`);
}

/** Read everything `ciReadingFor` needs. Throws `ReadFailed` naming the call. */
export async function readCi(request: Request, repoSlug: string, prNumber: number): Promise<CiReading> {
  const { owner, repo } = parseOwnerRepo(repoSlug);
  const pr = await get(request, "/repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: prNumber });
  const sha = pr?.head?.sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
    return { status: "UNMEASURED", pr: prNumber, reason: `the head sha ${JSON.stringify(sha)} is not a full sha, and a short one silently matches no runs` };
  }
  const shape = { number: prNumber, created_at: pr.created_at, merged_at: pr.merged_at ?? null };
  if (!shape.merged_at) return ciReadingFor({ pr: shape, runs: [], jobs: [] });

  const latest = await getAll(request, "/repos/{owner}/{repo}/actions/runs", { owner, repo, head_sha: sha }, "workflow_runs");
  const runs: WorkflowRunShape[] = [];
  for (const r of latest) {
    // The list carries only the latest attempt; earlier ones are read by number.
    for (let attempt = 1; attempt < r.run_attempt; attempt++) {
      runs.push(await get(request, "/repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}", { owner, repo, run_id: r.id, attempt_number: attempt }));
    }
    runs.push(r);
  }
  const jobs: JobShape[] = [];
  if (!runs.some(r => r.status !== "completed")) {
    for (const r of runs) {
      jobs.push(...await getAll(request, "/repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs", { owner, repo, run_id: r.id, attempt_number: r.run_attempt }, "jobs"));
    }
  }
  return ciReadingFor({ pr: shape, runs, jobs });
}

export function duration(r: Reading): string {
  if (r.status === "UNMEASURED") return `UNMEASURED (${r.reason})`;
  const s = Math.round(r.ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m ${s % 60}s` : `${m}m ${s % 60}s`;
}

export function renderText(reading: CiReading): string {
  if (reading.status === "UNMEASURED") return `ci-reading #${reading.pr}: UNMEASURED — ${reading.reason}`;
  const lines = [`ci-reading #${reading.pr}: MEASURED`, "checks:"];
  for (const c of reading.checks) {
    const tries = c.attempts.length > 1
      ? `   (attempts: ${c.attempts.map(a => `${a.attempt} ${a.conclusion ?? "no conclusion"} ${duration(a.duration)}`).join(", ")})`
      : "";
    lines.push(`  ${c.workflow} / ${c.name}: ${duration(c.duration)}${tries}`);
  }
  lines.push("queue:");
  for (const q of reading.queue) lines.push(`  ${q.name} (run ${q.runId} attempt ${q.attempt}): ${duration(q.wait)}`);
  lines.push(`re-runs: ${reading.reruns}`);
  lines.push(`open → first check: ${duration(reading.spans.openToFirstCheck)}`);
  lines.push(`first → last check: ${duration(reading.spans.firstToLastCheck)}`);
  lines.push(`last check → merge: ${duration(reading.spans.lastCheckToMerge)}`);
  lines.push(`critical path: ${duration(reading.criticalPath.duration)} (${reading.criticalPath.checks.join(" → ") || "none"})`);
  return lines.join("\n");
}

// A table cell is one line: a newline in a job name (review round 2, PR #2277)
// would end the row and spill the rest of the table out as free text.
const cell = (s: string) => s.replace(/\s*[\r\n]+\s*/g, " ").replace(/\|/g, "\\|");

export function renderMarkdown(reading: CiReading): string {
  if (reading.status === "UNMEASURED") return `### CI reading — #${reading.pr}\n\nUNMEASURED — ${cell(reading.reason)}`;
  const lines = [`### CI reading — #${reading.pr}`, "", "| Check | Duration | Attempts |", "|---|---|---|"];
  for (const c of reading.checks) lines.push(`| ${cell(`${c.workflow} / ${c.name}`)} | ${cell(duration(c.duration))} | ${c.attempts.length} |`);
  lines.push("", "| Span | Duration |", "|---|---|");
  lines.push(`| Open → first check | ${cell(duration(reading.spans.openToFirstCheck))} |`);
  lines.push(`| First → last check | ${cell(duration(reading.spans.firstToLastCheck))} |`);
  lines.push(`| Last check → merge | ${cell(duration(reading.spans.lastCheckToMerge))} |`);
  lines.push(`| Critical path (${cell(reading.criticalPath.checks.join(" → ") || "none")}) | ${cell(duration(reading.criticalPath.duration))} |`);
  lines.push("", `Re-runs: ${reading.reruns}. Queue: ${reading.queue.map(q => `${cell(q.name)} attempt ${q.attempt} ${cell(duration(q.wait))}`).join("; ") || "none"}.`);
  return lines.join("\n");
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, process.env);
  if (typeof args === "string") {
    console.error(`ci-reading: ${args}`);
    return EXIT_USAGE;
  }
  let reading: CiReading;
  try {
    const client = createGitHubClient() as unknown as { request: Request };
    reading = await readCi(client.request.bind(client), args.repo, args.pr);
  } catch (err) {
    reading = { status: "UNMEASURED", pr: args.pr, reason: err instanceof Error ? err.message : String(err) };
  }
  console.log(args.format === "markdown" ? renderMarkdown(reading) : renderText(reading));
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
