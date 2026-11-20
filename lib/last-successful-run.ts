/**
 * Where a merge-triggered run's range starts (ADR-022 decision 3): the head
 * of the newest successful run of a workflow whose head commit is on this
 * branch.
 *
 * One module, because two commands answer this question for the run a merge
 * workflow starts: `plan-issues --accepted-since-last-run` (SC-2787, #2495)
 * and `close-merged-references --since-last-run` (#2522). Two copies would be
 * two deciders that agree until one is edited (#2522 moved it here from
 * `scripts/plan-issues.ts`).
 *
 * A run `workflow_run` started records the default branch and its tip at the
 * time, not the triggering pull request's head: measured on 2026-11-19 over
 * this repository's `ai-review-unmeasured.yml` runs, every one read
 * `headBranch: main` with `headSha` a merge commit on main (review of #2509).
 * The head is still not trusted on that say-so: a run counts only when
 * `isAncestor` says its head is in this checkout's history, and older runs are
 * tried in turn, so a change in what GitHub records refuses rather than
 * guesses. An older start is safe, because every step reading the range is
 * idempotent. A missing run, a run off this branch, or runs that could not be
 * read each refuse, by name, rather than guess a range or read "no runs" as
 * "nothing happened".
 */
import { spawnSync } from "child_process";

/** What reading a workflow's successful runs needs. Injected so a test never shells out. */
export interface RunsGitHub {
  runs: (repo: string, workflowFile: string) => Promise<unknown[]>;
}

/** A workflow file name, as `--accepted-since-last-run` and `--since-last-run` take it. */
export const WORKFLOW_FILE = /^[A-Za-z0-9._-]+\.ya?ml$/;

export function sinceLastSuccessfulRun(
  runs: readonly unknown[] | null,
  isAncestor: (sha: string) => boolean,
  unreadWhy?: string,
): { sha: string; run: number; skipped: number } | { why: string } {
  if (runs === null) return { why: `the successful runs could not be read (${unreadWhy ?? "no reason given"}), so there is no range to read` };
  if (runs.length === 0) {
    return {
      why:
        "there is no successful run of this workflow to start the range from, so it refuses rather than guess one. " +
        "A person merging any change under docs/adr/ starts a push run, and its success gives the next merge-triggered run a start",
    };
  }
  let skipped = 0;
  for (const r of runs) {
    const run = r as { id?: unknown; head_sha?: unknown } | null;
    if (typeof run?.head_sha !== "string" || !Number.isInteger(run.id)) {
      return { why: `a successful run carries no id or head_sha (${JSON.stringify(r)?.slice(0, 80)})` };
    }
    if (isAncestor(run.head_sha)) return { sha: run.head_sha, run: run.id as number, skipped };
    skipped++;
  }
  return { why: `none of the ${runs.length} successful runs read has its head on this branch's history, so there is no range to read` };
}

/** Whether `sha` is a full commit id on the history of `root`'s checked-out HEAD. */
export function isAncestorIn(root: string): (sha: string) => boolean {
  return sha =>
    /^[0-9a-f]{40}$/.test(sha) && spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", sha, "HEAD"], { encoding: "utf-8" }).status === 0;
}

/**
 * Read the runs, then decide. The one entry point both commands call, so the
 * "could not be read" reason reaches the decider the same way in each.
 */
export async function lastSuccessfulRunStart(
  api: RunsGitHub,
  repo: string,
  workflowFile: string,
  root: string,
): Promise<{ sha: string; run: number; skipped: number } | { why: string }> {
  let runs: unknown[] | null = null;
  let unreadWhy: string | undefined;
  try {
    runs = await api.runs(repo, workflowFile);
  } catch (e) {
    unreadWhy = (e as Error).message;
  }
  return sinceLastSuccessfulRun(runs, isAncestorIn(root), unreadWhy);
}

function gh(args: readonly string[]): string {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.GH_TOKEN;
  const proc = Bun.spawnSync(["gh", ...args], { env });
  if (proc.exitCode !== 0) throw new Error(new TextDecoder().decode(proc.stderr).trim().slice(0, 300));
  return new TextDecoder().decode(proc.stdout);
}

export const LIVE_RUNS: RunsGitHub = {
  // Every page, newest first: an on-branch run past the first page is still
  // a range, and reading one page would refuse it as "none on this branch".
  // One JSON object per line, because --paginate concatenates the pages.
  runs: async (repo, workflowFile) =>
    gh([
      "api",
      "--paginate",
      `repos/${repo}/actions/workflows/${workflowFile}/runs?status=success&per_page=100`,
      "--jq",
      ".workflow_runs[] | {id, head_sha} | @json",
    ])
      .split("\n")
      .filter(line => line.trim() !== "")
      .map(line => JSON.parse(line) as unknown),
};
