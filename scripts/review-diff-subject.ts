#!/usr/bin/env bun
/**
 * The review's subject: the pull request's diff, chosen whole files at a time
 * under a byte budget (#1934).
 *
 * `.github/workflows/claude-review.yml` hands the agent its diff inside the
 * `prompt:` input, and the action marshals every input into one environment
 * variable, so the subject has a hard ceiling (`MAX_BYTES` there, and AC-6 in
 * `test/claude-review-diff-gather.test.ts` for why). The step used to cut the
 * diff at a byte. A cut diff makes the run UNMEASURED / DIFF_TRUNCATED, and on
 * a DA state-record pull request that is permanent: #1932 changed 142 lines in
 * 2 files and its diff was 168 KB, because `project-state.json` keeps each
 * entry on one line. For that whole class the job could only ever be red.
 *
 * ## What the subject is now
 *
 * - The whole diff, unchanged, when it fits.
 * - Otherwise, the files whose WHOLE diff fits, in diff order, skipping any
 *   that do not, under a first line telling the agent how many it is reading
 *   and naming the rest. A file is reviewed whole or not at all: half a
 *   file's hunks reported as a review of that file is the defect the old cut
 *   was refused for.
 * - When not one file fits whole, the old byte cut, marked as before. Nothing
 *   was reviewed whole, so that stays a truncation and stays DIFF_TRUNCATED in
 *   `lib/review-execution-reading.ts`.
 *
 * The counts reach the post-step as step outputs, `files_read` and
 * `files_seen`, and that reading decides what they mean. This file decides
 * only what the agent is shown.
 *
 * ```
 * bun scripts/review-diff-subject.ts --in /tmp/pr.diff --out /tmp/pr.subject \
 *   --max-bytes 98304 --outputs "$GITHUB_OUTPUT"
 * ```
 *
 * Bytes, not characters, throughout: the ceiling is a byte count, and a
 * multi-byte file measured in characters would be under-counted.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

/** One file's section of a unified diff, from its `diff --git` header. */
export interface DiffFile {
  /** The path after `b/` in the header, for naming it. */
  path: string;
  text: string;
}

const HEADER = /^diff --git a\/(.*) b\/(.*)$/;

/** Split a unified diff at each `diff --git` header line. Rejoined, the parts are the diff. */
export function splitDiff(diff: string): { preamble: string; files: DiffFile[] } {
  const lines = diff.split(/(?<=\n)/);
  let preamble = "";
  const files: DiffFile[] = [];
  for (const line of lines) {
    const m = HEADER.exec(line.replace(/\n$/, ""));
    if (m) files.push({ path: m[2]!, text: line });
    else if (files.length === 0) preamble += line;
    else files[files.length - 1]!.text += line;
  }
  return { preamble, files };
}

export interface DiffSubject {
  /** What the agent is handed. */
  subject: string;
  filesSeen: number;
  /** Files whose whole diff is in `subject`. */
  filesRead: number;
  /** The paths left out, in diff order. */
  omitted: string[];
  /** True only for the byte cut: no file fitted whole. */
  truncated: boolean;
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/**
 * Room kept for the first line of a partial subject. The line names the
 * omitted files and is shortened to fit, so the subject never exceeds the
 * budget however many files were left out.
 */
const SCOPE_LINE_BYTES = 1024;

function scopeLine(read: number, seen: number, omitted: string[], maxBytes: number): string {
  const head = `*** reviewing the whole diff of ${read} of ${seen} files; left out because the diff is over the ${maxBytes}-byte budget: `;
  const tail = " ***\n";
  let names = "";
  for (let i = 0; i < omitted.length; i++) {
    const more = omitted.length - i - 1;
    const next = (i === 0 ? "" : ", ") + omitted[i];
    const after = more > 0 ? ` and ${more} more` : "";
    if (bytes(head + names + next + after + tail) > SCOPE_LINE_BYTES) {
      names += ` and ${omitted.length - i} more`;
      break;
    }
    names += next;
  }
  return head + names + tail;
}

/** The subject for a diff under a budget of `maxBytes`. */
export function chooseSubject(diff: string, maxBytes: number): DiffSubject {
  const { preamble, files } = splitDiff(diff);
  const filesSeen = files.length;
  if (bytes(diff) <= maxBytes) {
    return { subject: diff, filesSeen, filesRead: filesSeen, omitted: [], truncated: false };
  }

  const room = maxBytes - SCOPE_LINE_BYTES - bytes(preamble);
  const kept: DiffFile[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const f of files) {
    const n = bytes(f.text);
    if (used + n <= room) {
      kept.push(f);
      used += n;
    } else omitted.push(f.path);
  }

  if (kept.length > 0) {
    const subject = scopeLine(kept.length, filesSeen, omitted, maxBytes) + preamble + kept.map(f => f.text).join("");
    return { subject, filesSeen, filesRead: kept.length, omitted, truncated: false };
  }

  // Not one file fits whole: the byte cut the step always made, marked so the
  // agent knows its subject is incomplete. The marker is counted INSIDE the
  // budget; the shell step appended it after cutting at the full cap, so its
  // subject ran a marker's length over.
  const marker = `\n*** diff truncated at ${maxBytes} of ${bytes(diff)} bytes ***\n`;
  const cut = Buffer.from(diff, "utf8").subarray(0, maxBytes - bytes(marker)).toString("utf8");
  return {
    subject: cut + marker,
    filesSeen,
    filesRead: 0,
    omitted: files.map(f => f.path),
    truncated: true,
  };
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

export function main(argv: readonly string[]): number {
  const inFile = flag(argv, "in");
  const outFile = flag(argv, "out");
  const outputs = flag(argv, "outputs");
  const maxRaw = flag(argv, "max-bytes");
  if (!inFile || !outFile || !outputs || !maxRaw || !/^\d+$/.test(maxRaw) || Number(maxRaw) <= SCOPE_LINE_BYTES) {
    process.stderr.write(
      `review-diff-subject: --in, --out, --outputs and --max-bytes (over ${SCOPE_LINE_BYTES}) are all required\n`,
    );
    return 2;
  }
  let diff: string;
  try {
    diff = readFileSync(inFile, "utf8");
  } catch (e) {
    process.stderr.write(`review-diff-subject: could not read ${inFile}: ${(e as Error).message}\n`);
    return 1;
  }
  const maxBytes = Number(maxRaw);
  const s = chooseSubject(diff, maxBytes);
  writeFileSync(outFile, s.subject);
  appendFileSync(outputs, `truncated=${s.truncated}\nfiles_read=${s.filesRead}\nfiles_seen=${s.filesSeen}\n`);
  // Annotations are read from stdout, not stderr.
  if (s.truncated) {
    console.log(`::warning::diff truncated at ${maxBytes} of ${bytes(diff)} bytes; no file fitted whole`);
  } else if (s.filesRead < s.filesSeen) {
    console.log(
      `::warning title=Review covers part of the diff::reviewing ${s.filesRead} of ${s.filesSeen} files whole; ` +
        `left out: ${s.omitted.join(", ")}`,
    );
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
