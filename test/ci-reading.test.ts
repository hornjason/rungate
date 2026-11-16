/**
 * #2271 — a merged pull request's CI time, broken into parts (the computation half of #1046).
 *
 * This works toward the criterion #1046 serves without completing it: the
 * reading exists and refuses honestly, and attaching it to every merged pull
 * request is still #1046's to do, so nothing here claims that criterion.
 *
 * No network: every input is shaped like the GitHub API's pull request,
 * workflow run and job objects. The cases that matter are the refusals — a
 * skipped check, a check with no completed_at, an in-progress run, a run whose
 * queue time is a measured 0 — and the decomposition, because the cheapest
 * wrong fix (#1046 names it) is to report merged − created and call it
 * pipeline latency. That number attributes nothing, so every span is asserted
 * on its own.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { ciReadingFor, type CiReading, type JobShape, type WorkflowRunShape } from "../lib/ci-reading";

const at = (hms: string) => `2026-11-16T${hms}.000Z`;
const PR = { number: 42, created_at: at("10:00:00"), merged_at: at("10:30:00") };
const run = (over: Partial<WorkflowRunShape> = {}): WorkflowRunShape => ({
  id: 7, name: "ci", run_attempt: 1, status: "completed", created_at: at("10:01:00"), run_started_at: at("10:01:00"), ...over,
});
const job = (name: string, start: string | null, end: string | null, over: Partial<JobShape> = {}): JobShape => ({
  name, run_id: 7, run_attempt: 1, status: "completed", conclusion: "success",
  started_at: start === null ? null : at(start), completed_at: end === null ? null : at(end), ...over,
});

// test and ai-review run in parallel; gates runs after ai-review finishes.
const JOBS: JobShape[] = [
  job("test", "10:01:10", "10:05:10"),
  job("ai-review", "10:01:20", "10:09:20"),
  job("gates", "10:09:30", "10:10:30"),
  job("label-check", null, null, { conclusion: "skipped" }),
];

function measured(r: CiReading) {
  if (r.status !== "MEASURED") throw new Error(`expected a MEASURED reading, got: ${r.reason}`);
  return r;
}
const check = (r: ReturnType<typeof measured>, name: string) => r.checks.find(c => c.name === name)!;

describe("#2271: the reading of a merged pull request", () => {
  const r = measured(ciReadingFor({ pr: PR, runs: [run()], jobs: JOBS }));

  test("each check's duration, by name", () => {
    expect(check(r, "test").duration).toEqual({ status: "MEASURED", ms: 240_000 });
    expect(check(r, "ai-review").duration).toEqual({ status: "MEASURED", ms: 480_000 });
    expect(check(r, "gates").duration).toEqual({ status: "MEASURED", ms: 60_000 });
  });

  test("a check that did not run is UNMEASURED with the reason — never 0, never the fastest check", () => {
    const skipped = check(r, "label-check").duration;
    expect(skipped.status).toBe("UNMEASURED");
    expect(skipped.status === "UNMEASURED" && skipped.reason).toContain("skipped");
  });

  test("the three spans are each attributed, and together they are the whole open → merge time", () => {
    expect(r.spans.openToFirstCheck).toEqual({ status: "MEASURED", ms: 70_000 });
    expect(r.spans.firstToLastCheck).toEqual({ status: "MEASURED", ms: 560_000 });
    expect(r.spans.lastCheckToMerge).toEqual({ status: "MEASURED", ms: 1_170_000 });
    const sum = [r.spans.openToFirstCheck, r.spans.firstToLastCheck, r.spans.lastCheckToMerge]
      .reduce((n, s) => n + (s.status === "MEASURED" ? s.ms : NaN), 0);
    expect(sum).toBe(Date.parse(PR.merged_at) - Date.parse(PR.created_at));
  });

  test("the critical path is the longest chain — not the sum of parallel checks, not the longest single check", () => {
    expect(r.criticalPath.checks).toEqual(["ai-review", "gates"]);
    expect(r.criticalPath.duration).toEqual({ status: "MEASURED", ms: 540_000 });
  });

  test("a run that started the moment it was created waited a measured 0", () => {
    expect(r.queue).toEqual([{ runId: 7, name: "ci", attempt: 1, wait: { status: "MEASURED", ms: 0 } }]);
  });

  test("no re-runs reads 0 re-runs", () => {
    expect(r.reruns).toBe(0);
  });
});

describe("#2271: refusals", () => {
  test("a run with no start time has an UNMEASURED queue time, distinct from 0", () => {
    const r = measured(ciReadingFor({ pr: PR, runs: [run({ run_started_at: null })], jobs: JOBS }));
    expect(r.queue[0]!.wait.status).toBe("UNMEASURED");
  });

  test("a check with no completed_at is UNMEASURED, and leaves the spans and the critical path", () => {
    const r = measured(ciReadingFor({
      pr: PR, runs: [run()],
      jobs: [...JOBS, job("slow", "10:02:00", null, { conclusion: "cancelled" })],
    }));
    const slow = check(r, "slow").duration;
    expect(slow.status === "UNMEASURED" && slow.reason).toContain("completed_at");
    expect(r.criticalPath.checks).not.toContain("slow");
    expect(r.spans.firstToLastCheck).toEqual({ status: "MEASURED", ms: 560_000 });
  });

  test("an in-progress run makes the whole reading UNMEASURED: elapsed-so-far is not a duration", () => {
    const r = ciReadingFor({ pr: PR, runs: [run({ status: "in_progress" })], jobs: JOBS });
    expect(r.status).toBe("UNMEASURED");
    expect(r.status === "UNMEASURED" && r.reason).toContain("in_progress");
  });

  test("an unmerged pull request has no reading", () => {
    const r = ciReadingFor({ pr: { ...PR, merged_at: null }, runs: [run()], jobs: JOBS });
    expect(r.status === "UNMEASURED" && r.reason).toContain("not merged");
  });

  test("no runs at all is UNMEASURED, never an empty reading", () => {
    const r = ciReadingFor({ pr: PR, runs: [], jobs: [] });
    expect(r.status === "UNMEASURED" && r.reason).toContain("no workflow run");
  });

  test("checks that all did not run leave the spans and the critical path UNMEASURED", () => {
    const r = measured(ciReadingFor({ pr: PR, runs: [run()], jobs: [job("label-check", null, null, { conclusion: "skipped" })] }));
    expect(r.spans.openToFirstCheck.status).toBe("UNMEASURED");
    expect(r.criticalPath.duration.status).toBe("UNMEASURED");
  });
});

describe("#2271: a re-run never overwrites the first attempt", () => {
  const r = measured(ciReadingFor({
    pr: PR,
    runs: [run(), run({ run_attempt: 2, created_at: at("10:11:00"), run_started_at: at("10:11:05") })],
    jobs: [
      job("test", "10:01:10", "10:03:10", { conclusion: "failure" }),
      job("test", "10:11:10", "10:15:10", { run_attempt: 2 }),
    ],
  }));

  test("both attempts are kept, and the check's duration is the attempt that counted", () => {
    const t = check(r, "test");
    expect(t.attempts.map(a => [a.attempt, a.conclusion, a.duration])).toEqual([
      [1, "failure", { status: "MEASURED", ms: 120_000 }],
      [2, "success", { status: "MEASURED", ms: 240_000 }],
    ]);
    expect(t.duration).toEqual({ status: "MEASURED", ms: 240_000 });
  });

  test("the failed first attempt is CI time the pull request spent: the spans start at it", () => {
    expect(r.spans.openToFirstCheck).toEqual({ status: "MEASURED", ms: 70_000 });
    expect(r.spans.firstToLastCheck).toEqual({ status: "MEASURED", ms: 840_000 });
  });

  test("the re-run is counted, and each attempt's queue time is its own", () => {
    expect(r.reruns).toBe(1);
    expect(r.queue.map(q => [q.attempt, q.wait])).toEqual([
      [1, { status: "MEASURED", ms: 0 }],
      [2, { status: "MEASURED", ms: 5_000 }],
    ]);
  });
});

describe("#2271: the critical path is computed in one place", () => {
  test("one definition, and the reading calls it", () => {
    const source = readFileSync(join(import.meta.dir, "..", "lib", "ci-reading.ts"), "utf-8");
    expect(source.match(/function criticalPath\(/g)?.length ?? 0).toBe(1);
    const body = source.slice(source.indexOf("export function ciReadingFor("));
    expect(body).toContain("criticalPath(");
  });
});
