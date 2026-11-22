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
 * Every decision is `mergeDrafts`'s in `lib/ai-review-drafts.ts`; this reads
 * the drafts, writes the payload to `--out` when there is one, and prints the
 * counts and, when nothing was written, why. Withholding a payload exits 0,
 * so the job's no-payload routes decide the round. Two things refuse, both
 * through `MERGE_DRAFTS_REFUSED_EXIT`: a call it cannot read (no `--out`, or
 * no draft path), and a payload it could not write — which must not exit 0,
 * because a block that stands would then read as no payload, UNMEASURED.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type DraftInput, mergeDrafts, mergeReport } from "../lib/ai-review-drafts";

/** The one non-zero exit: a call this script cannot read, or a payload it could not write. */
export const MERGE_DRAFTS_REFUSED_EXIT = 2;

/** The call read: where to write the union, and the drafts — or why it could not be read. */
function readCall(argv: readonly string[]): { out: string; drafts: string[] } | { refused: string } {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: { out: { type: "string" } },
      allowPositionals: true,
    });
    const out = values.out?.trim() ?? "";
    return out === "" || positionals.length === 0
      ? {
          refused:
            "usage: --out <payload.json> <draft.json> [<draft.json> ...] — every planned draft path, written or not; " +
            "a path left out is a run the round did not plan",
        }
      : { out, drafts: positionals };
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
  const { out, drafts } = call;
  const merged = mergeDrafts(drafts.map(readDraft));
  for (const line of mergeReport(merged)) console.log(`ai-review-merge-drafts: ${line}`);
  if (merged.payload === null) return 0;
  try {
    writeFileSync(out, `${JSON.stringify(merged.payload, null, 2)}\n`);
  } catch (e) {
    console.error(`ai-review-merge-drafts: could not write the payload to ${out} — ${(e as Error).message}`);
    return MERGE_DRAFTS_REFUSED_EXIT;
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
