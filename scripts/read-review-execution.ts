#!/usr/bin/env bun
/**
 * Read what the Claude review run actually did, and refuse on UNMEASURED.
 *
 * Used by `.github/workflows/claude-review.yml`'s post-step (#732 AC-1/AC-2).
 * Every decision is `reviewExecutionReading`'s; this file reads argv, reads a
 * file, prints, and exits. There is exactly ONE `process.exit` with a non-zero
 * argument in it and that argument is `REVIEW_UNMEASURED_EXIT`, declared once
 * in `lib/review-execution-reading.ts` — so a mutant with the constant set to
 * `0` cannot be bypassed by a second inlined refusal.
 *
 * ```
 * bun scripts/read-review-execution.ts \
 *   --execution-file "$RUNNER_TEMP/claude-execution-output.json" \
 *   --reviews-before 2 --reviews-after 3 \
 *   --files-read 2 --files-seen 2
 * ```
 *
 * The two file counts are the gather step's outputs (#1934): files whose
 * whole diff reached the agent, of the files in the pull request. Either
 * absent or non-numeric is `DIFF_SCOPE_UNAVAILABLE`, never "whole".
 *
 * Two counts, differenced here, because a TOTAL makes the second run of any
 * reviewed PR unfalsifiable: #746's first dispatch left one review on it, and
 * a total would have read `1` for every run after that including one that
 * posted nothing.
 *
 * Either count absent, non-numeric, or the string `unknown` means the caller
 * could not count: that is `REVIEW_COUNT_UNAVAILABLE`, not zero. An absent
 * count and a count of zero are different states and only one of them is a
 * finding about the review.
 */

import { existsSync, readFileSync } from "node:fs";
import {
  REVIEW_UNMEASURED_EXIT,
  reviewCoverage,
  reviewExecutionReading,
  reviewReadingReport,
} from "../lib/review-execution-reading";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const executionFile = flag("execution-file");
const executionFileRaw =
  executionFile && existsSync(executionFile) ? readFileSync(executionFile, "utf8") : null;

const count = (name: string): number | null => {
  const raw = flag(name);
  return raw === undefined || !/^\d+$/.test(raw) ? null : Number(raw);
};
const before = count("reviews-before");
const after = count("reviews-after");
const reviewsPosted = before === null || after === null ? null : Math.max(0, after - before);

const filesRead = count("files-read");
const filesSeen = count("files-seen");

const reading = reviewExecutionReading({
  executionFileRaw,
  reviewsPosted,
  diffScope: filesRead === null || filesSeen === null ? null : { filesRead, filesSeen },
});

const report = reviewReadingReport(reading);
console.log(report);

// A review of part of the diff is a reading, and the part is on the run page,
// not only in this log (#1934).
const scope = reading.diffScope;
if (reading.reading === "MEASURED" && scope !== null && scope.filesRead < scope.filesSeen) {
  console.log(
    `::warning title=Claude review covered part of the diff::coverage ${reviewCoverage(reading)} whole; ` +
      "the rest were over the diff budget",
  );
}

if (reading.reading === "UNMEASURED") {
  // A GitHub annotation, so the state is visible on the run page and not only
  // in a log nobody opens. `::error::` collapses newlines, hence the join.
  console.log(`::error title=Claude review UNMEASURED::${report.split("\n").join(" | ")}`);
  process.exit(REVIEW_UNMEASURED_EXIT);
}
