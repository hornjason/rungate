#!/usr/bin/env bun
/**
 * CRC-N3's rate (#2437): over a window of findings ledgers, how many review
 * findings counted their class by a search that ran.
 *
 * CRC-N3 (specs/CODE-REVIEW-CONVERGENCE-SPEC.md) asks the reviewer to flag the
 * class of a defect, not the line. #1883 made the class size a COUNT — the
 * number of lines of the cited file carrying the literal text the finding
 * names in `populationSearch` — and the adjudicator prints a verdict for it on
 * every round. Nothing turned those verdicts into a rate, so the evidence row
 * rested on one instance (#1614's round 12).
 *
 * ## The verdict is re-run, and by the adjudicator's own decider
 *
 * The ledger records each finding as the reviewer wrote it — `population` and
 * `populationSearch` included — and not the verdict, which was decided against
 * the checkout and printed to a job log that expires. So the verdict is taken
 * again here with `populationVerdict` from `lib/scaffold/ai-review-findings.ts`,
 * the one function that decides it, over the tree the round reviewed: the
 * round's merge commit, else its head commit, and the reading counts which.
 * A search whose tree is in neither place is UNJUDGED — named, and outside the
 * denominator. A missing checkout must never read as a rate of zero.
 *
 * ## UNRECORDED is not undeclared
 *
 * Measured on PRs 2400-2448: 31 findings in 27 ledgers, and not one carried
 * either field. The ledger step (`buildPersistScript` in
 * `lib/scaffold/ai-review-step.ts`) projects each finding onto severity,
 * file, line, summary and failure_scenario, so the class size the reviewer
 * wrote never reaches the ledger. Read as "undeclared", that is a 0% rate the
 * reviewer did not earn. So a finding carrying NEITHER key is UNRECORDED and
 * leaves the denominator; a writer that keeps the fields writes `null` for
 * one the reviewer left out, and `null` is read as absent — undeclared.
 *
 * ## What is UNMEASURED
 *
 * A window in which no ledger could be read. A ledger that cannot be read is
 * named and left out; it does not erase the readable ones, and it is never
 * scored as a pull request whose findings declared nothing.
 *
 * Usage (the window is `scripts/crc-reading.ts --save`'s output):
 *
 *   bun scripts/crc-reading.ts --lo <first PR> --hi <last PR> --save /tmp/window.json
 *   bun lib/finding-population-rate.ts --from /tmp/window.json [--repo-dir <checkout>]
 */
import { readFileSync } from "node:fs";

import { AI_REVIEW_LEDGER_ABSENT, AI_REVIEW_LEDGER_READ, readLedger } from "./ai-review-rounds";
import type { CrcEntry } from "./crc-reading";
import { populationVerdict, searchTerms, type PopulationVerdict } from "./scaffold/ai-review-findings";
import { AI_REVIEW_FINDING_FIELDS } from "./scaffold/ai-review-step";

/** A file's lines at a commit, or `null` when that tree is not available. */
export type LinesAt = (commit: string, file: string) => readonly string[] | null;

/**
 * The adjudicator's five verdicts, plus UNJUDGED (a search with no tree to run
 * over) and UNRECORDED (a finding the ledger kept no class-size field for).
 */
export type PopulationRateKind = PopulationVerdict["kind"] | "unjudged" | "unrecorded";

export interface PopulationRateRow {
  /** UNMEASURED when no ledger in the window could be read. */
  status: "MEASURED" | "UNMEASURED";
  /** Pull requests whose ledger was read. */
  prs: number;
  /** Ledgers present and unreadable, by pull request — named, never scored. */
  unreadable: { number: number; reason: string }[];
  /** Pull requests with no ledger at all. */
  absent: number[];
  /** Rounds in which a review happened (`findings` was an array). */
  rounds: number;
  findings: number;
  counts: Record<PopulationRateKind, number>;
  /** Where each searched finding's file was read from. */
  treeAt: { merge: number; head: number; none: number };
  /** `findings` minus the unjudged and the unrecorded: the denominator. */
  judged: number;
  /** `measured / judged`, or `null` when nothing could be judged. */
  rate: number | null;
}

function emptyCounts(): Record<PopulationRateKind, number> {
  return { measured: 0, contradicted: 0, unbacked: 0, undeclared: 0, unmeasured: 0, unjudged: 0, unrecorded: 0 };
}

/** The reading over a window of ledgers. `linesAt` is `null` when no checkout was given. */
export function populationRate(entries: readonly CrcEntry[], linesAt: LinesAt | null): PopulationRateRow {
  const f = AI_REVIEW_FINDING_FIELDS;
  const counts = emptyCounts();
  const treeAt = { merge: 0, head: 0, none: 0 };
  const unreadable: { number: number; reason: string }[] = [];
  const absent: number[] = [];
  let prs = 0;
  let rounds = 0;
  let findings = 0;

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
    for (const round of ledger.rounds) {
      if (!round.measured) continue;
      rounds++;
      for (const item of round.findings) {
        findings++;
        if (!(f.population in item) && !(f.populationSearch in item)) {
          counts.unrecorded++;
          continue;
        }
        const file = item[f.file];
        // `null` is the writer's spelling of "the reviewer gave none".
        const search = item[f.populationSearch] === null ? undefined : item[f.populationSearch];
        let lines: readonly string[] | null = null;
        // Read a tree only for a search that can run: an absent or unusable
        // search is decided without one, and reading for it would count a
        // tree lookup nobody needed.
        const runnable = search !== undefined && searchTerms(search) !== null;
        if (runnable && typeof file === "string" && file !== "" && linesAt !== null) {
          lines = round.mergeSha !== "" ? linesAt(round.mergeSha, file) : null;
          if (lines !== null) treeAt.merge++;
          else {
            lines = round.sha !== "" ? linesAt(round.sha, file) : null;
            if (lines !== null) treeAt.head++;
          }
        }
        if (runnable && lines === null) {
          treeAt.none++;
          counts.unjudged++;
          continue;
        }
        counts[populationVerdict(item[f.population], search, lines).kind]++;
      }
    }
  }

  const judged = findings - counts.unjudged - counts.unrecorded;
  return {
    status: prs === 0 ? "UNMEASURED" : "MEASURED",
    prs,
    unreadable,
    absent,
    rounds,
    findings,
    counts,
    treeAt,
    judged,
    rate: prs === 0 || judged === 0 ? null : counts.measured / judged,
  };
}

/** The reading as lines a person reads. Every number beside what it counts. */
export function renderPopulationRate(row: PopulationRateRow): string[] {
  const c = row.counts;
  const lines = [
    `CRC-N3 population rate: ${row.status}`,
    `  ledgers read: ${row.prs}, rounds with a review: ${row.rounds}, findings: ${row.findings}`,
    `  measured ${c.measured}, contradicted ${c.contradicted}, unbacked ${c.unbacked}, ` +
      `undeclared ${c.undeclared}, unmeasured ${c.unmeasured}` +
      (c.unjudged > 0 ? `; ${c.unjudged} could not be judged — no tree to search` : "") +
      (c.unrecorded > 0 ? `; ${c.unrecorded} not recorded — the ledger kept no class size for them` : ""),
    `  searched files read at: merge commit ${row.treeAt.merge}, head commit ${row.treeAt.head}, nowhere ${row.treeAt.none}`,
    row.rate === null
      ? `  rate: none — ${
          row.status === "UNMEASURED"
            ? "no ledger could be read"
            : row.findings > 0 && c.unrecorded === row.findings
              ? "the ledger records no class size for any finding in this window"
              : "no finding could be judged"
        }`
      : `  rate: ${c.measured} of ${row.judged} judged finding(s) counted their class by a search that ran ` +
        `(${(row.rate * 100).toFixed(1)}%)`,
  ];
  if (row.unreadable.length > 0) {
    lines.push(
      `  unreadable ledgers, not scored: ${row.unreadable.map(u => `#${u.number} (${u.reason})`).join("; ")}`,
    );
  }
  if (row.absent.length > 0) lines.push(`  no ledger: ${row.absent.map(n => `#${n}`).join(", ")}`);
  return lines;
}

/** `git cat-file` over a local checkout. A commit or path it cannot resolve is `null`. */
function gitLinesAt(repoDir: string): LinesAt {
  return (commit, file) => {
    if (!/^[0-9a-f]{7,64}$/.test(commit)) return null;
    const r = Bun.spawnSync(["git", "-C", repoDir, "cat-file", "-p", `${commit}:${file}`]);
    if (r.exitCode !== 0) return null;
    return new TextDecoder().decode(r.stdout).split("\n");
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
      process.stderr.write(`finding-population-rate: unknown argument ${a}\n`);
      return 2;
    }
  }
  if (from === null || from === "") {
    process.stderr.write("finding-population-rate: --from <entries.json> is required (scripts/crc-reading.ts --save writes one)\n");
    return 2;
  }
  let entries: CrcEntry[];
  try {
    const parsed: unknown = JSON.parse(readFileSync(from, "utf-8"));
    if (!Array.isArray(parsed)) throw new Error("not a JSON array of entries");
    entries = parsed as CrcEntry[];
  } catch (e) {
    process.stderr.write(`finding-population-rate: could not read ${from}: ${(e as Error).message}\n`);
    return 1;
  }
  const row = populationRate(entries, gitLinesAt(repoDir ?? process.cwd()));
  for (const line of renderPopulationRate(row)) console.log(line);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
