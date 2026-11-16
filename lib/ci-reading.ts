/**
 * A merged pull request's CI time, broken into parts (#2271, the computation half of #1046).
 *
 * The harness times agents and suite runs and, before this, nothing about CI.
 * #1046 measured by hand that roughly 14 of every 19.8 merge-minutes were
 * neither a check nor a queue, and nothing in the tree could say what they
 * were. This turns API-shaped data into a reading that can: each check's
 * duration, each run's queue time, the critical path, the re-run count, and
 * the three spans open → first check start → last check end → merge.
 *
 * A value nobody measured is UNMEASURED with the reason, never `0`: a skipped
 * required check reported as 0 ms would read as the fastest check in the suite
 * (.claude/rules/config-access.md, Silent Default Substitution). A run still in
 * progress has no duration, so it makes the whole reading UNMEASURED rather
 * than reporting elapsed-so-far.
 *
 * Pure: no network and no clock. The shapes are the GitHub REST API's pull
 * request, workflow run and job objects, narrowed to the fields read here.
 */

export interface PullRequestShape {
  number: number;
  created_at: string;
  merged_at: string | null;
}

/** One attempt of a workflow run. A re-run is a second entry with the same id. */
export interface WorkflowRunShape {
  id: number;
  name: string;
  run_attempt: number;
  status: string;
  created_at: string;
  run_started_at?: string | null;
}

/** A job of one run attempt — the unit a required check reports. */
export interface JobShape {
  name: string;
  run_id: number;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export type Reading = { status: "MEASURED"; ms: number } | { status: "UNMEASURED"; reason: string };

export interface CheckReading {
  name: string;
  /** The attempt that counted: the last one. */
  duration: Reading;
  /** Every attempt, in order. A re-run never overwrites the first. */
  attempts: Array<{ attempt: number; conclusion: string | null; duration: Reading }>;
}

export type CiReading =
  | {
      status: "MEASURED";
      pr: number;
      checks: CheckReading[];
      queue: Array<{ runId: number; name: string; attempt: number; wait: Reading }>;
      criticalPath: { checks: string[]; duration: Reading };
      reruns: number;
      spans: { openToFirstCheck: Reading; firstToLastCheck: Reading; lastCheckToMerge: Reading };
    }
  | { status: "UNMEASURED"; pr: number; reason: string };

const unmeasured = (reason: string): Reading => ({ status: "UNMEASURED", reason });

function between(from: string | null | undefined, to: string | null | undefined, what: string): Reading {
  if (!from) return unmeasured(`${what}: no start time`);
  if (!to) return unmeasured(`${what}: no end time`);
  const ms = Date.parse(to) - Date.parse(from);
  if (Number.isNaN(ms)) return unmeasured(`${what}: a time that does not parse`);
  if (ms < 0) return unmeasured(`${what}: ends before it starts`);
  return { status: "MEASURED", ms };
}

function jobDuration(job: JobShape): Reading {
  if (job.conclusion === "skipped") return unmeasured("did not run (skipped)");
  if (!job.started_at) return unmeasured("no started_at — it never started");
  if (!job.completed_at) return unmeasured(`no completed_at — it ended ${job.conclusion ?? "without a conclusion"}`);
  return between(job.started_at, job.completed_at, job.name);
}

type Timed = { name: string; start: number; end: number };

/**
 * The longest chain of checks that ran one after another (#2271). A check
 * follows another when it started at or after that one ended; checks that
 * overlap ran in parallel, and parallel time is not added. The one place this
 * is decided, so a mutation of it reddens every reader.
 */
function criticalPath(checks: Timed[]): { checks: string[]; duration: Reading } {
  if (checks.length === 0) return { checks: [], duration: unmeasured("no check ran to completion") };
  const sorted = [...checks].sort((a, b) => a.start - b.start || a.end - b.end);
  const best: number[] = [];
  const prev: number[] = [];
  sorted.forEach((c, i) => {
    best[i] = c.end - c.start;
    prev[i] = -1;
    for (let j = 0; j < i; j++) {
      if (sorted[j]!.end <= c.start && best[j]! + (c.end - c.start) > best[i]!) {
        best[i] = best[j]! + (c.end - c.start);
        prev[i] = j;
      }
    }
  });
  let tip = 0;
  best.forEach((b, i) => { if (b > best[tip]!) tip = i; });
  const chain: string[] = [];
  for (let i = tip; i !== -1; i = prev[i]!) chain.unshift(sorted[i]!.name);
  return { checks: chain, duration: { status: "MEASURED", ms: best[tip]! } };
}

export function ciReadingFor(input: { pr: PullRequestShape; runs: WorkflowRunShape[]; jobs: JobShape[] }): CiReading {
  const { pr, runs, jobs } = input;
  if (!pr.merged_at) return { status: "UNMEASURED", pr: pr.number, reason: "the pull request is not merged" };
  if (runs.length === 0) return { status: "UNMEASURED", pr: pr.number, reason: "no workflow run for its commits" };
  const open = runs.find(r => r.status !== "completed");
  if (open) {
    return { status: "UNMEASURED", pr: pr.number, reason: `run ${open.id} attempt ${open.run_attempt} is ${open.status}` };
  }

  const queue = [...runs]
    .sort((a, b) => a.id - b.id || a.run_attempt - b.run_attempt)
    .map(r => ({ runId: r.id, name: r.name, attempt: r.run_attempt, wait: between(r.created_at, r.run_started_at, `run ${r.id} attempt ${r.run_attempt} queue`) }));

  const byName = new Map<string, JobShape[]>();
  for (const j of jobs) byName.set(j.name, [...(byName.get(j.name) ?? []), j]);
  const checks: CheckReading[] = [...byName.entries()].map(([name, attempts]) => {
    const ordered = [...attempts].sort((a, b) => a.run_attempt - b.run_attempt);
    const read = ordered.map(j => ({ attempt: j.run_attempt, conclusion: j.conclusion, duration: jobDuration(j) }));
    return { name, duration: read[read.length - 1]!.duration, attempts: read };
  });

  const maxAttempt = new Map<number, number>();
  for (const r of runs) maxAttempt.set(r.id, Math.max(maxAttempt.get(r.id) ?? 0, r.run_attempt));
  const reruns = [...maxAttempt.values()].reduce((n, a) => n + (a - 1), 0);

  // Every attempt that ran counts toward the spans: a failed first attempt is
  // CI time the pull request spent. Only the attempt that counted is a link
  // in the critical path.
  const ran = jobs.filter(j => jobDuration(j).status === "MEASURED");
  const counted: Timed[] = [];
  for (const [name, attempts] of byName) {
    const last = [...attempts].sort((a, b) => a.run_attempt - b.run_attempt).pop()!;
    if (jobDuration(last).status === "MEASURED") {
      counted.push({ name, start: Date.parse(last.started_at!), end: Date.parse(last.completed_at!) });
    }
  }

  let spans: { openToFirstCheck: Reading; firstToLastCheck: Reading; lastCheckToMerge: Reading };
  if (ran.length === 0) {
    const none = unmeasured("no check ran to completion");
    spans = { openToFirstCheck: none, firstToLastCheck: none, lastCheckToMerge: none };
  } else {
    const first = new Date(Math.min(...ran.map(j => Date.parse(j.started_at!)))).toISOString();
    const last = new Date(Math.max(...ran.map(j => Date.parse(j.completed_at!)))).toISOString();
    spans = {
      openToFirstCheck: between(pr.created_at, first, "open to first check"),
      firstToLastCheck: between(first, last, "first check to last check"),
      lastCheckToMerge: between(last, pr.merged_at, "last check to merge"),
    };
  }

  return { status: "MEASURED", pr: pr.number, checks, queue, criticalPath: criticalPath(counted), reruns, spans };
}
