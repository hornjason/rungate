#!/usr/bin/env bun
/**
 * The self-inflicted ratio (#1652): over a window of findings ledgers, what
 * share of a later round's findings concern lines written after the pull
 * request's review began.
 *
 * The convergence spec lists this instrument as not started and says the
 * measurement is mechanical; it was done by hand on #1614. It serves the
 * spec's rounds criterion and its fixed-defect criterion together: a round
 * spent on code the previous round caused is a round the first review did
 * not need, and a re-raised fixed defect is one shape of it. #1652's own
 * measurement found no live mechanism defect to build instead, so this is
 * that issue's remaining work.
 *
 * ## What counts as self-inflicted
 *
 * A finding raised in a round after the ledger's EARLIEST recorded round is
 * self-inflicted when its cited line was added between the earliest round's
 * tree and the tree its own round reviewed. Every later round is compared
 * with the earliest, not with the round before it: code written in response
 * to round one is still self-inflicted when round five finds it.
 *
 * "Added" is read tree to tree, with `git diff`, not with `git blame`. This
 * repository rebases pull requests, and a rebase rewrites every commit on the
 * branch, so blame would name a commit the earliest round never saw for
 * every line the branch carries. A tree diff does not care which commits
 * produced the trees.
 *
 * ## Which trees
 *
 * The merge commits each round's reviewer read, when both rounds recorded
 * one and the checkout has both. Otherwise the head commits. The reading
 * counts which. A merge pair also carries what main changed in that file
 * between the two rounds, and a head pair can be off by the lines main
 * changed above the cited one. Both are rare on this repository's short-lived
 * branches, and neither is hidden: the split is printed.
 *
 * A file renamed since the earliest round is absent from that tree, so its
 * lines read as added. That over-counts; it is named here rather than
 * guessed around.
 *
 * ## What is not judged, and what is a lower bound
 *
 * A finding naming no file or no line, or whose trees or line the checkout
 * cannot read, is UNJUDGED: named, and outside the denominator. A missing
 * checkout must never read as a ratio of zero.
 *
 * A ledger that dropped its first rounds, or may have (a bare-array ledger
 * states nothing), has an earliest recorded round that is not round one.
 * Lines written in response to the dropped rounds then read as pre-existing,
 * so those findings make the ratio a LOWER BOUND, and the reading says how
 * many of them there are.
 *
 * Round-one findings have no earlier round, so they are counted and left out.
 *
 * Usage (the window is `scripts/crc-reading.ts --save`'s output):
 *
 *   bun scripts/crc-reading.ts --lo <first PR> --hi <last PR> --save /tmp/window.json
 *   bun lib/self-inflicted-ratio.ts --from /tmp/window.json [--repo-dir <checkout>]
 */
import { readFileSync } from "node:fs";

import {
  AI_REVIEW_LEDGER_ABSENT,
  AI_REVIEW_LEDGER_READ,
  AI_REVIEW_TRUNCATION_STATED,
  readLedger,
} from "./ai-review-rounds";
import type { CrcEntry } from "./crc-reading";
import { AI_REVIEW_FINDING_FIELDS } from "./scaffold/ai-review-step";

/**
 * Whether `line` of `file` in the tree at `at` was added since the tree at
 * `base`. `null` when either tree, the file at `at`, or that line cannot be
 * read.
 */
export type LineAge = (base: string, at: string, file: string, line: number) => "added" | "kept" | null;

export interface SelfInflictedRow {
  /** UNMEASURED when no ledger in the window could be read. */
  status: "MEASURED" | "UNMEASURED";
  /** Pull requests whose ledger was read. */
  prs: number;
  /** Ledgers present and unreadable, by pull request — named, never scored. */
  unreadable: { number: number; reason: string }[];
  /** Pull requests with no ledger at all. */
  absent: number[];
  /** Findings in each ledger's earliest recorded round: nothing precedes them. */
  firstRoundFindings: number;
  /** Rounds after the earliest in which a review happened (`findings` was an array). */
  laterRounds: number;
  laterFindings: number;
  selfInflicted: number;
  preExisting: number;
  /** `noLine`: the finding names no file or line. `unread`: its trees or line could not be read. */
  unjudged: { noLine: number; unread: number };
  /** Which pair of trees each judged finding was read from. */
  treeAt: { merge: number; head: number };
  /** Judged findings from ledgers whose first rounds were dropped, or may have been. */
  fromCutLedgers: number;
  /** `selfInflicted + preExisting`: the denominator. */
  judged: number;
  /** `selfInflicted / judged`, or `null` when nothing could be judged. */
  ratio: number | null;
}

/** The reading over a window of ledgers. `ageOf` is `null` when no checkout was given. */
export function selfInflictedRatio(entries: readonly CrcEntry[], ageOf: LineAge | null): SelfInflictedRow {
  const f = AI_REVIEW_FINDING_FIELDS;
  const unreadable: { number: number; reason: string }[] = [];
  const absent: number[] = [];
  const unjudged = { noLine: 0, unread: 0 };
  const treeAt = { merge: 0, head: 0 };
  let prs = 0;
  let firstRoundFindings = 0;
  let laterRounds = 0;
  let laterFindings = 0;
  let selfInflicted = 0;
  let preExisting = 0;
  let fromCutLedgers = 0;

  for (const entry of entries) {
    const ledger = readLedger(entry.body);
    if (ledger.status === AI_REVIEW_LEDGER_ABSENT) {
      absent.push(entry.number);
      continue;
    }
    if (ledger.status !== AI_REVIEW_LEDGER_READ) {
      unreadable.push({ number: entry.number, reason: ledger.reason });
      continue;
    }
    prs++;
    const whole = ledger.truncation.status === AI_REVIEW_TRUNCATION_STATED && ledger.truncation.dropped === 0;
    const [first, ...later] = ledger.rounds;
    if (first === undefined) continue;
    if (first.measured) firstRoundFindings += first.findings.length;

    for (const round of later) {
      if (!round.measured) continue;
      laterRounds++;
      for (const item of round.findings) {
        laterFindings++;
        const file = item[f.file];
        const line = item[f.line];
        if (typeof file !== "string" || file === "" || typeof line !== "number" || !Number.isInteger(line) || line < 1) {
          unjudged.noLine++;
          continue;
        }
        let age: "added" | "kept" | null = null;
        if (ageOf !== null) {
          if (first.mergeSha !== "" && round.mergeSha !== "") {
            age = ageOf(first.mergeSha, round.mergeSha, file, line);
            if (age !== null) treeAt.merge++;
          }
          if (age === null && first.sha !== "" && round.sha !== "") {
            age = ageOf(first.sha, round.sha, file, line);
            if (age !== null) treeAt.head++;
          }
        }
        if (age === null) {
          unjudged.unread++;
          continue;
        }
        if (age === "added") selfInflicted++;
        else preExisting++;
        if (!whole) fromCutLedgers++;
      }
    }
  }

  const judged = selfInflicted + preExisting;
  return {
    status: prs === 0 ? "UNMEASURED" : "MEASURED",
    prs,
    unreadable,
    absent,
    firstRoundFindings,
    laterRounds,
    laterFindings,
    selfInflicted,
    preExisting,
    unjudged,
    treeAt,
    fromCutLedgers,
    judged,
    ratio: prs === 0 || judged === 0 ? null : selfInflicted / judged,
  };
}

/** The reading as lines a person reads. Every number beside what it counts. */
export function renderSelfInflicted(row: SelfInflictedRow): string[] {
  const u = row.unjudged;
  const lines = [
    `self-inflicted ratio: ${row.status}`,
    `  ledgers read: ${row.prs}; earliest-round findings: ${row.firstRoundFindings} (nothing precedes them, so not in the ratio)`,
    `  later rounds with a review: ${row.laterRounds}, their findings: ${row.laterFindings}`,
    `  self-inflicted ${row.selfInflicted}, pre-existing ${row.preExisting}` +
      (u.noLine > 0 ? `; ${u.noLine} name no file or line` : "") +
      (u.unread > 0 ? `; ${u.unread} could not be read at their trees` : ""),
    `  trees compared: merge commits ${row.treeAt.merge}, head commits ${row.treeAt.head}`,
    row.ratio === null
      ? `  ratio: none — ${row.status === "UNMEASURED" ? "no ledger could be read" : "no later-round finding could be judged"}`
      : `  ratio: ${row.selfInflicted} of ${row.judged} judged later-round finding(s) concern lines added after ` +
        `the earliest recorded round (${(row.ratio * 100).toFixed(1)}%)`,
  ];
  if (row.fromCutLedgers > 0) {
    lines.push(
      `  lower bound: ${row.fromCutLedgers} of the ${row.judged} come from ledgers whose first rounds were dropped, ` +
        `or may have been — lines written in response to those rounds read as pre-existing`,
    );
  }
  if (row.unreadable.length > 0) {
    lines.push(`  unreadable ledgers, not scored: ${row.unreadable.map(r => `#${r.number} (${r.reason})`).join("; ")}`);
  }
  if (row.absent.length > 0) lines.push(`  no ledger: ${row.absent.map(n => `#${n}`).join(", ")}`);
  return lines;
}

const SHA = /^[0-9a-f]{7,64}$/;

/** The new-side line numbers a zero-context diff adds. A pure deletion (`+c,0`) adds none. */
function addedLines(diff: string): Set<number> {
  const out = new Set<number>();
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let n = start; n < start + count; n++) out.add(n);
  }
  return out;
}

/** {@link LineAge} over a local checkout, by `git diff -U0` from tree to tree. */
export function gitLineAge(repoDir: string): LineAge {
  const git = (args: string[]) => Bun.spawnSync(["git", "-C", repoDir, ...args]);
  const text = (r: ReturnType<typeof git>) => new TextDecoder().decode(r.stdout);
  return (base, at, file, line) => {
    if (!SHA.test(base) || !SHA.test(at) || !Number.isInteger(line) || line < 1) return null;
    if (git(["cat-file", "-e", `${base}^{commit}`]).exitCode !== 0) return null;
    const now = git(["cat-file", "-p", `${at}:${file}`]);
    if (now.exitCode !== 0) return null;
    const body = text(now);
    const count = body === "" ? 0 : body.split("\n").length - (body.endsWith("\n") ? 1 : 0);
    if (line > count) return null;
    // Absent from the earliest tree: every line of it is new since then.
    if (git(["cat-file", "-e", `${base}:${file}`]).exitCode !== 0) return "added";
    const d = git(["diff", "--no-ext-diff", "--no-color", "--no-renames", "-U0", base, at, "--", file]);
    if (d.exitCode !== 0) return null;
    return addedLines(text(d)).has(line) ? "added" : "kept";
  };
}

export function main(argv: readonly string[]): number {
  let from: string | null = null;
  let repoDir: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") from = argv[++i] ?? "";
    else if (a === "--repo-dir") repoDir = argv[++i] ?? "";
    else {
      process.stderr.write(`self-inflicted-ratio: unknown argument ${a}\n`);
      return 2;
    }
  }
  if (from === null || from === "") {
    process.stderr.write("self-inflicted-ratio: --from <entries.json> is required (scripts/crc-reading.ts --save writes one)\n");
    return 2;
  }
  let entries: CrcEntry[];
  try {
    const parsed: unknown = JSON.parse(readFileSync(from, "utf-8"));
    if (!Array.isArray(parsed)) throw new Error("not a JSON array of entries");
    entries = parsed as CrcEntry[];
  } catch (e) {
    process.stderr.write(`self-inflicted-ratio: could not read ${from}: ${(e as Error).message}\n`);
    return 1;
  }
  const row = selfInflictedRatio(entries, gitLineAge(repoDir ?? process.cwd()));
  for (const line of renderSelfInflicted(row)) console.log(line);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
