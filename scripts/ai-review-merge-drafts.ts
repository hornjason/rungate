#!/usr/bin/env bun
/**
 * Merge an AI review round's drafts into its one payload — CRC-B11 (#2648).
 *
 *   rungate ai-review-merge-drafts --out <payload.json> <draft-1.json> [<draft-2.json> ...]
 *
 * **The draft paths are the plan.** Pass every path the round planned a run
 * to write, whether or not that run wrote it: a path left out is a run the
 * round did not plan, so a caller that passes only the files it finds turns a
 * partial round into a full one, and the partial rule cannot see it (PR #2656
 * round 8). The generated workflow passes its fixed paths, never a glob.
 *
 * **The run the round reports** (#2661). With `--outcome`, `--execution` and
 * `--github-output` — all three or none, one `--outcome` and one
 * `--execution` per draft, in the drafts' order — it appends
 * `outcome=` and `execution_file=` for the steps after the review, which
 * read one of each. `roundRepresentative` decides which run; this only
 * checks the values are ones GitHub writes and carry no newline, because a
 * newline in a value is a second output line nobody meant.
 *
 * Every decision is `mergeDrafts`'s in `lib/ai-review-drafts.ts`; this reads
 * the drafts, writes the payload to `--out` when there is one, and prints the
 * counts and, when nothing was written, why. Withholding a payload exits 0,
 * so the job's no-payload routes decide the round. Two things refuse, both
 * through `MERGE_DRAFTS_REFUSED_EXIT`: a call it cannot read (no `--out`, or
 * no draft path), and a payload it could not write — which must not exit 0,
 * because a block that stands would then read as no payload, UNMEASURED.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type DraftInput, mergeDrafts, mergeReport, type RoundRun, roundRepresentative } from "../lib/ai-review-drafts";

/** The one non-zero exit: a call this script cannot read, or a payload it could not write. */
export const MERGE_DRAFTS_REFUSED_EXIT = 2;

/** The outcomes a GitHub step reports. Anything else is not a step's outcome. */
export const STEP_OUTCOMES: readonly string[] = ["success", "failure", "cancelled", "skipped"];

const USAGE =
  "usage: --out <payload.json> [--outcome <o> --execution <path> ... --github-output <path>] <draft.json> [<draft.json> ...] — " +
  "every planned draft path, written or not; a path left out is a run the round did not plan";

interface Call {
  out: string;
  drafts: string[];
  /** Present when the run the round reports was asked for. */
  report?: { runs: RoundRun[]; githubOutput: string };
}

/** The call read — or why it could not be read. */
function readCall(argv: readonly string[]): Call | { refused: string } {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: {
        out: { type: "string" },
        outcome: { type: "string", multiple: true },
        execution: { type: "string", multiple: true },
        "github-output": { type: "string" },
      },
      allowPositionals: true,
    });
    const out = values.out?.trim() ?? "";
    if (out === "" || positionals.length === 0) return { refused: USAGE };
    const outcomes = values.outcome ?? [];
    const executions = values.execution ?? [];
    const githubOutput = values["github-output"]?.trim() ?? "";
    if (outcomes.length === 0 && executions.length === 0 && githubOutput === "") return { out, drafts: positionals };
    if (githubOutput === "" || outcomes.length !== positionals.length || executions.length !== positionals.length) {
      return {
        refused:
          `the run the round reports needs --github-output and one --outcome and one --execution per draft: ` +
          `${positionals.length} draft(s), ${outcomes.length} outcome(s), ${executions.length} execution path(s)`,
      };
    }
    const unknown = outcomes.find(o => !STEP_OUTCOMES.includes(o));
    if (unknown !== undefined) return { refused: `${JSON.stringify(unknown)} is not a step outcome (${STEP_OUTCOMES.join(", ")})` };
    const broken = [...executions, githubOutput].find(v => /[\r\n]/.test(v));
    if (broken !== undefined) return { refused: `a value carries a newline, which would be a second output line: ${JSON.stringify(broken)}` };
    const runs = outcomes.map((outcome, i) => ({ outcome, execution: executions[i] }));
    return { out, drafts: positionals, report: { runs, githubOutput } };
  } catch (e) {
    return { refused: (e as Error).message };
  }
}

/**
 * A draft path read: its text, absent, or why it could not be read. Only
 * ENOENT is absent. `existsSync` is not asked first because it answers false
 * whenever stat fails, so a draft in a directory nobody can search would read
 * "that run wrote no payload" about a file that run did write.
 */
function readDraft(path: string): DraftInput {
  try {
    return { path, text: readFileSync(path, "utf-8") };
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT"
      ? { path, text: null }
      : { path, text: null, readError: (e as Error).message };
  }
}

export function main(argv: readonly string[]): number {
  const call = readCall(argv);
  if ("refused" in call) {
    console.error(`ai-review-merge-drafts: ${call.refused}`);
    return MERGE_DRAFTS_REFUSED_EXIT;
  }
  const { out, drafts, report } = call;
  const merged = mergeDrafts(drafts.map(readDraft));
  for (const line of mergeReport(merged)) console.log(`ai-review-merge-drafts: ${line}`);
  if (merged.payload !== null) {
    try {
      writeFileSync(out, `${JSON.stringify(merged.payload, null, 2)}\n`);
    } catch (e) {
      console.error(`ai-review-merge-drafts: could not write the payload to ${out} — ${(e as Error).message}`);
      return MERGE_DRAFTS_REFUSED_EXIT;
    }
  }
  if (report === undefined) return 0;
  const rep = roundRepresentative(merged, report.runs);
  console.log(
    `ai-review-merge-drafts: the round reports run ${rep.run + 1}: outcome ${rep.outcome}, ` +
      `execution file ${rep.execution === "" ? "(none)" : rep.execution}`,
  );
  try {
    appendFileSync(report.githubOutput, `outcome=${rep.outcome}\nexecution_file=${rep.execution}\n`);
  } catch (e) {
    console.error(`ai-review-merge-drafts: could not append the round's run to ${report.githubOutput} — ${(e as Error).message}`);
    return MERGE_DRAFTS_REFUSED_EXIT;
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
