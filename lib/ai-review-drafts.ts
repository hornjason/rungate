/**
 * The union of several AI review drafts — CRC-B11 (#2648, ADR-025 decision 2).
 *
 * One round of the generated review runs the reviewer three times, each a
 * separate action invocation writing its own draft payload. The round's
 * findings are the union of the drafts with duplicates removed: a finding one
 * run raised blocks exactly as it would have alone, and nothing is voted away.
 *
 * ## The identity is `advisoryKey`, not a second one
 *
 * A duplicate is a finding whose `advisoryKey` — file plus whitespace- and
 * case-normalised summary — equals one already kept. That is the identity the
 * adjudicator already counts advisories by, so this adds no second decider
 * about what "the same finding" means. It collapses a finding two runs worded
 * identically; it keeps two wordings of one defect apart, which costs a
 * repeated thread and never a dropped finding. The other choice — keying on
 * the anchor line — would merge two different defects on one line, which
 * drops a finding, and dropping is what this must never do.
 *
 * ## A duplicate keeps the strictest severity any run gave it
 *
 * `advisoryKey` carries no severity, so one run's `low` and another's `high`
 * on the same finding share a key. Keeping whichever came first would drop a
 * blocking finding whenever an advisory run was listed before it — a merged
 * round passing a pull request one of its runs blocked. So the kept entry is
 * replaced, in place, by a stricter duplicate: strictness is the order of
 * `AI_REVIEW_SEVERITIES`, and a severity that table does not declare ranks
 * above all of them, because the adjudicator refuses it by name and the
 * direction this is allowed to be wrong in is toward blocking.
 *
 * ## What a draft that did not parse means
 *
 * Absent and unreadable drafts are NAMED, never skipped silently, and the
 * union is taken over the drafts that parsed. A round with at least one
 * parsed draft has a payload; a round with none has no payload at all, so
 * the job's existing no-payload routes decide it exactly as they did when a
 * round was one run. The counts are always printed, so "2 of 3" is visible.
 */

import {
  advisoryKey,
  AI_REVIEW_BLOCK_VERDICT,
  AI_REVIEW_FINDINGS_KEY,
  AI_REVIEW_PASS_VERDICT,
  AI_REVIEW_VERDICT_KEY,
} from "./scaffold/ai-review-findings";
import { AI_REVIEW_SEVERITIES, AI_REVIEW_SUMMARY_KEY } from "./scaffold/ai-review-step";

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
  /** The union payload, or `null` when no draft parsed. */
  payload: Record<string, unknown> | null;
  drafts: DraftReading[];
  /** Findings in the union. */
  kept: number;
  /** Findings dropped as an exact duplicate of one already kept. */
  duplicates: number;
}

/** One draft as the merge receives it: its path, and its text or `null` when the file is absent. */
export interface DraftInput {
  path: string;
  text: string | null;
}

/**
 * Lower is stricter: the index in `AI_REVIEW_SEVERITIES`, whose order is
 * strictest first, and -1 for a severity it does not declare.
 */
function strictness(finding: Record<string, unknown>): number {
  const sev = finding.severity;
  return typeof sev === "string" ? Object.keys(AI_REVIEW_SEVERITIES).indexOf(sev) : -1;
}

function parseDraft(d: DraftInput): { reading: DraftReading; obj: Record<string, unknown> | null } {
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
  if (objs.length === 0) return { payload: null, drafts, kept: 0, duplicates: 0 };

  // Key → index in `kept`, so a stricter duplicate can take its place.
  const seen = new Map<string, number>();
  const kept: unknown[] = [];
  let duplicates = 0;
  for (const obj of objs) {
    for (const finding of obj[AI_REVIEW_FINDINGS_KEY] as unknown[]) {
      // A finding that is not an object has no key; it is kept as written so
      // the adjudicator refuses it by name, as it would in a single draft.
      if (finding === null || typeof finding !== "object" || Array.isArray(finding)) {
        kept.push(finding);
        continue;
      }
      const record = finding as Record<string, unknown>;
      const key = advisoryKey(record);
      const at = seen.get(key);
      if (at !== undefined) {
        duplicates++;
        if (strictness(record) < strictness(kept[at] as Record<string, unknown>)) kept[at] = finding;
        continue;
      }
      seen.set(key, kept.length);
      kept.push(finding);
    }
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

/** The log lines the merge step prints: the counts first, then each draft that did not parse. */
export function mergeReport(m: MergedDrafts): string[] {
  const parsedCount = m.drafts.filter(d => d.status === "parsed").length;
  const head =
    `drafts: ${parsedCount} of ${m.drafts.length} parsed; ` +
    (m.payload === null
      ? "no payload written, so the round is decided by the no-payload routes"
      : `${m.kept} finding(s) kept, ${m.duplicates} duplicate(s) removed`);
  const rest = m.drafts
    .filter(d => d.status !== "parsed")
    .map(d => (d.status === "absent" ? `draft ${d.path}: ABSENT — that run wrote no payload` : `draft ${d.path}: UNREADABLE — ${d.why}`));
  return [head, ...rest];
}
