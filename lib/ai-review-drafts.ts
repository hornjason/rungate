/**
 * The union of several AI review drafts — CRC-B11 (#2648, ADR-025 decision 2).
 *
 * One round of the generated review runs the reviewer three times, each a
 * separate action invocation writing its own draft payload. The round's
 * findings are the union of the drafts with duplicates removed: a finding one
 * run raised blocks exactly as it would have alone, and nothing is voted away.
 *
 * ## Two rules, one function each
 *
 * Review rounds 1 to 3 of PR #2656 each found a defect in a rule that lived
 * in a different line of the loop. So each rule is now one exported function,
 * and the tests read each as a table:
 *
 * - `findingIdentity` is the only answer to "are these the same finding":
 *   file, line, and whitespace- and case-normalised summary. The line is in
 *   it because without it two defects worded alike on different lines were
 *   one finding, and the second was dropped (round 3). The cost of the line
 *   is the other direction: two runs anchoring one defect on different lines
 *   are kept apart, which costs a repeated thread and never a dropped one.
 * - `severityStrictness` is the only answer to "which of two copies is
 *   stricter": a blocking severity, then one the table does not declare,
 *   then an advisory one, and the order of `AI_REVIEW_SEVERITIES` within a
 *   tier. Whether a severity blocks is read through `severityBlocks`, so
 *   this adds no second answer to that. Undeclared sits between because the
 *   adjudicator reads it `SEVERITY_UNRECOGNISED`, UNMEASURED: weaker than a
 *   block (round 1), stronger than a pass.
 *
 * ## The union is of occurrences, and nothing within one run is merged
 *
 * A finding is kept as many times as the most any one draft listed it. So a
 * draft's own list is never collapsed — one draft merges to itself unchanged
 * — and a finding two runs both reported is kept once. When a later draft's
 * copy is stricter it takes the earlier copy's place, so a blocking finding
 * is never lost behind an advisory one listed first.
 *
 * ## What a draft that did not parse means
 *
 * Absent and unreadable drafts are NAMED, never skipped silently. A round
 * that heard from fewer runs than it planned may establish a BLOCK, never a
 * pass (PR #2656 round 7):
 *
 * - every draft parsed: the union is the payload, whatever it holds;
 * - some did not, and a parsed draft carries a blocking finding: the union of
 *   the parsed drafts is the payload, because a finding one run raised blocks
 *   however many runs were heard;
 * - some did not, and nothing parsed blocks: NO payload, so the job's
 *   existing no-payload routes read the round UNMEASURED — exactly what one
 *   silent run reads today. Writing the union here would turn two silent
 *   runs into a measured pass, a check passing on review that never ran.
 *
 * No draft parsed is the last case with nothing at all. The counts are
 * always printed, so "1 of 3" is visible either way.
 */

import {
  severityBlocks,
  AI_REVIEW_BLOCK_VERDICT,
  AI_REVIEW_FINDINGS_KEY,
  AI_REVIEW_PASS_VERDICT,
  AI_REVIEW_VERDICT_KEY,
} from "./scaffold/ai-review-findings";
import { AI_REVIEW_FINDING_FIELDS, AI_REVIEW_SEVERITIES, AI_REVIEW_SUMMARY_KEY } from "./scaffold/ai-review-step";

export type DraftStatus = "parsed" | "absent" | "unreadable";

export interface DraftReading {
  path: string;
  status: DraftStatus;
  /** Findings the draft listed, before the union. 0 unless parsed. */
  findings: number;
  /** Why it is unreadable, for the log. Present only then. */
  why?: string;
}

export interface MergedDrafts {
  /** The union payload, or `null` when it is withheld — see `withheld`. */
  payload: Record<string, unknown> | null;
  /** Why no payload was written, for the log. Present exactly when `payload` is `null`. */
  withheld?: string;
  drafts: DraftReading[];
  /** Findings in the union. */
  kept: number;
  /** Findings dropped as an exact duplicate of one already kept. */
  duplicates: number;
}

/**
 * One draft as the merge receives it: its path, and its text or `null` when
 * the file is absent. `readError` is set when the path exists and could not
 * be read — a directory, or no read permission — which is UNREADABLE, not
 * ABSENT: something is there, and the run that wrote it did not write a draft.
 */
export interface DraftInput {
  path: string;
  text: string | null;
  readError?: string;
}

/**
 * Whether two findings are one: file, line and normalised summary, compared
 * as TEXT. The only place this is decided. Not `advisoryKey`: that is a
 * 32-bit hash, so two different findings could collide and the second be
 * dropped with no line naming it (PR #2656 round 5). The SUMMARY is
 * normalised — trimmed, whitespace collapsed, lower-cased — because two runs
 * word one defect with different spacing and case. The FILE is only trimmed:
 * `lib/Parser.ts` and `lib/parser.ts` are two files on a case-sensitive
 * checkout, and folding them merged two findings into one (PR #2662).
 */
export function findingIdentity(finding: Record<string, unknown>): string {
  const text = (v: unknown): string => String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  const f = AI_REVIEW_FINDING_FIELDS;
  return JSON.stringify([String(finding[f.file] ?? "").trim(), finding[f.line] ?? null, text(finding[f.summary])]);
}

/**
 * Lower is stricter: blocking, then undeclared, then advisory; table order
 * within a tier. Every undeclared value is one rank. The only place this is decided.
 */
export function severityStrictness(finding: Record<string, unknown>): number {
  const sev = finding[AI_REVIEW_FINDING_FIELDS.severity];
  const declared = Object.keys(AI_REVIEW_SEVERITIES);
  // `severityBlocks` is the one answer to "is this declared, and does it
  // block", and nothing here asks it again. Since #2657 it reads the table's
  // own keys, so `null` is every undeclared value — inherited names such as
  // `constructor` included, which round 4 found ranked above `critical`.
  const blocks = severityBlocks(sev);
  if (blocks === null) return declared.length;
  return (blocks ? 0 : declared.length + 1) + declared.indexOf(sev as string);
}

function parseDraft(d: DraftInput): { reading: DraftReading; obj: Record<string, unknown> | null } {
  if (d.readError !== undefined) {
    return { reading: { path: d.path, status: "unreadable", findings: 0, why: `could not be read (${d.readError})` }, obj: null };
  }
  if (d.text === null) return { reading: { path: d.path, status: "absent", findings: 0 }, obj: null };
  let obj: unknown;
  try {
    obj = JSON.parse(d.text);
  } catch (e) {
    return { reading: { path: d.path, status: "unreadable", findings: 0, why: `not JSON (${(e as Error).message})` }, obj: null };
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { reading: { path: d.path, status: "unreadable", findings: 0, why: "not a JSON object" }, obj: null };
  }
  const list = (obj as Record<string, unknown>)[AI_REVIEW_FINDINGS_KEY];
  if (!Array.isArray(list)) {
    return { reading: { path: d.path, status: "unreadable", findings: 0, why: `'${AI_REVIEW_FINDINGS_KEY}' is not a list` }, obj: null };
  }
  return { reading: { path: d.path, status: "parsed", findings: list.length }, obj: obj as Record<string, unknown> };
}

/**
 * Merge the drafts into one payload. Order is kept: the first draft's
 * findings first, then each later draft's new ones, so the union of one
 * draft is that draft's list unchanged.
 */
export function mergeDrafts(inputs: readonly DraftInput[]): MergedDrafts {
  const parsed = inputs.map(parseDraft);
  const drafts = parsed.map(p => p.reading);
  const objs = parsed.map(p => p.obj).filter((o): o is Record<string, unknown> => o !== null);
  if (objs.length === 0) {
    return { payload: null, withheld: "no draft parsed", drafts, kept: 0, duplicates: 0 };
  }

  // Identity → the indices in `kept` holding its occurrences, so the union
  // holds as many as the most any one draft listed, and a stricter copy can
  // take an earlier one's place.
  const slots = new Map<string, number[]>();
  const kept: unknown[] = [];
  let duplicates = 0;
  for (const obj of objs) {
    const inThisDraft = new Map<string, number>();
    for (const finding of obj[AI_REVIEW_FINDINGS_KEY] as unknown[]) {
      // A finding that is not an object has no key; it is kept as written so
      // the adjudicator refuses it by name, as it would in a single draft.
      if (finding === null || typeof finding !== "object" || Array.isArray(finding)) {
        kept.push(finding);
        continue;
      }
      const record = finding as Record<string, unknown>;
      const key = findingIdentity(record);
      const nth = inThisDraft.get(key) ?? 0;
      inThisDraft.set(key, nth + 1);
      const held = slots.get(key) ?? [];
      if (nth < held.length) {
        // An earlier draft already holds this occurrence.
        duplicates++;
        const at = held[nth];
        if (severityStrictness(record) < severityStrictness(kept[at] as Record<string, unknown>)) kept[at] = finding;
        continue;
      }
      held.push(kept.length);
      slots.set(key, held);
      kept.push(finding);
    }
  }

  // A partial round establishes a block or nothing.
  const blocks = findingsBlock(kept);
  if (objs.length < inputs.length && !blocks) {
    return {
      payload: null,
      withheld:
        `${objs.length} of ${inputs.length} drafts parsed and none of them blocks, ` +
        "and a pass is never measured from fewer runs than the round planned",
      drafts,
      kept: kept.length,
      duplicates,
    };
  }

  // The strictest verdict word any parsed draft carried. The adjudicator
  // derives the verdict from severities and reads this word only to report a
  // disagreement, so this keeps that report meaningful rather than deciding.
  const words = objs.map(o => o[AI_REVIEW_VERDICT_KEY]);
  const verdict = words.includes(AI_REVIEW_BLOCK_VERDICT)
    ? AI_REVIEW_BLOCK_VERDICT
    : words.includes(AI_REVIEW_PASS_VERDICT)
      ? AI_REVIEW_PASS_VERDICT
      : undefined;

  const payload: Record<string, unknown> = {
    [AI_REVIEW_FINDINGS_KEY]: kept,
    // Opens with the count the union lists, as REVIEW.md asks of every
    // summary, so the summary reading stays OPENS_WITH_COUNT after a merge.
    [AI_REVIEW_SUMMARY_KEY]:
      `${kept.length} finding(s), the union of ${objs.length} of ${inputs.length} review run(s)` +
      (duplicates > 0 ? `, ${duplicates} duplicate(s) removed.` : "."),
  };
  if (verdict !== undefined) payload[AI_REVIEW_VERDICT_KEY] = verdict;
  return { payload, drafts, kept: kept.length, duplicates };
}

/**
 * Whether any of these findings blocks. `severityBlocks` is the one answer to
 * whether a finding blocks; a finding that is not an object cannot block, and
 * the adjudicator would refuse it anyway. One binding for the merge's partial
 * rule and the round's outcome (#2678), so the two cannot disagree.
 */
export function findingsBlock(findings: readonly unknown[]): boolean {
  return findings.some(
    f => f !== null && typeof f === "object" && severityBlocks((f as Record<string, unknown>)[AI_REVIEW_FINDING_FIELDS.severity]) === true,
  );
}

/** One review run as the job saw it: its action step's outcome, and its copied execution file ("" when it wrote none). */
export interface RoundRun {
  outcome: string;
  execution: string;
}

/**
 * The run a round reports (#2661). The steps after the review read ONE
 * action outcome and ONE execution file, so with several runs this decides,
 * once, which run supplies them:
 *
 * - a written payload that blocks is reported by the first run whose draft
 *   parsed, as `success`: one run's block stands as it would alone, whatever
 *   another run's step said;
 * - a written payload that blocks nothing is a `success` only when every
 *   run's step succeeded. Otherwise it is reported by the first run whose
 *   step did not, with that run's own outcome and execution file (#2678).
 *   With one run a failed step reads UNMEASURED even when a findings file
 *   exists, and three runs must not loosen that: a pass is never measured
 *   from a run whose step failed, as it is never measured from fewer drafts;
 * - a withheld payload is reported by the first run whose draft did NOT
 *   parse, with that run's own outcome and execution file. So a partial round
 *   is reported by the run that made it partial, and a round where every run
 *   failed is reported by run 1, exactly as the one run is today.
 *
 * Runs are matched to drafts by position; a list of a different length is
 * refused rather than read as far as it goes.
 */
export function roundRepresentative(m: MergedDrafts, runs: readonly RoundRun[]): RoundRun & { run: number } {
  if (runs.length !== m.drafts.length) {
    throw new Error(`${m.drafts.length} drafts and ${runs.length} runs — each draft needs the run that wrote it`);
  }
  const written = m.payload !== null;
  if (written && !findingsBlock(m.payload![AI_REVIEW_FINDINGS_KEY] as unknown[])) {
    const failed = runs.findIndex(r => r.outcome !== "success");
    if (failed !== -1) return { run: failed, ...runs[failed] };
  }
  const at = m.drafts.findIndex(d => (d.status === "parsed") === written);
  // Total: a written payload has a parsed draft, and a withheld one has a
  // draft that did not parse (every draft parsed always writes the union).
  const run = runs[at];
  return { run: at, outcome: written ? "success" : run.outcome, execution: run.execution };
}

/** The log lines the merge step prints: the counts first, then each draft that did not parse. */
export function mergeReport(m: MergedDrafts): string[] {
  const parsedCount = m.drafts.filter(d => d.status === "parsed").length;
  const head =
    `drafts: ${parsedCount} of ${m.drafts.length} parsed; ` +
    (m.payload === null
      ? `no payload written: ${m.withheld}, so the round is decided by the no-payload routes`
      : `${m.kept} finding(s) kept, ${m.duplicates} duplicate(s) removed`);
  const rest = m.drafts
    .filter(d => d.status !== "parsed")
    .map(d => (d.status === "absent" ? `draft ${d.path}: ABSENT — that run wrote no payload` : `draft ${d.path}: UNREADABLE — ${d.why}`));
  return [head, ...rest];
}
