#!/usr/bin/env bun
/**
 * Merge an AI review round's drafts into its one payload — CRC-B11 (#2648).
 *
 *   rungate ai-review-merge-drafts --out <payload.json> <draft-1.json> [<draft-2.json> ...]
 *
 * Every decision is `mergeDrafts`'s in `lib/ai-review-drafts.ts`; this reads
 * the drafts, writes the union to `--out` when at least one parsed, and
 * prints the counts. With no draft parsed it writes nothing and exits 0, so
 * the job's no-payload routes decide the round as they did when it was one
 * run. The only refusal is a call it cannot read — no `--out`, or no draft
 * path — and it goes through `MERGE_DRAFTS_USAGE_EXIT`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type DraftInput, mergeDrafts, mergeReport } from "../lib/ai-review-drafts";

/** The one non-zero exit: a call this script cannot read. */
export const MERGE_DRAFTS_USAGE_EXIT = 2;

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
      ? { refused: "usage: --out <payload.json> <draft.json> [<draft.json> ...]" }
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
    return MERGE_DRAFTS_USAGE_EXIT;
  }
  const { out, drafts } = call;
  const merged = mergeDrafts(drafts.map(readDraft));
  for (const line of mergeReport(merged)) console.log(`ai-review-merge-drafts: ${line}`);
  if (merged.payload !== null) writeFileSync(out, `${JSON.stringify(merged.payload, null, 2)}\n`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
