/**
 * A ratio `project-state.json` states about the board, and the live reading
 * that re-takes it — #1889.
 *
 * ## The defect, and what it is NOT
 *
 * Three review rounds on PR #1888 each found the same thing in
 * `priorities[]` prose, and all three were caught by a reader doing
 * arithmetic in their head. `scripts/board-conformance.ts` has exactly this
 * relationship with the board — it re-takes every reading and refuses while
 * any is short — and the state file had no equivalent. So a figure in
 * `priorities[]` was a number a report states about the tracker, which
 * nothing compared against the tracker.
 *
 * This is **not** a fact-checker for English. It reads one shape: a ratio
 * written immediately after the name of a reading `board-conformance`
 * already produces. Anything else is UNRECOGNISED and is reported as such —
 * never as agreed, because an extractor that silently matches nothing
 * certifies the file by counting nothing
 * (`.claude/rules/checks-must-be-able-to-fail.md`, the vacuous assertion).
 *
 * ## A dated figure is a RECORD, and the file is mostly records
 *
 * Measured before this was written, not assumed: of 29 `priorities[]`
 * entries on 2026-11-08, six sentences cite a reading by name, and two of
 * the six carry the date the reading was taken. `priorities[]` is an
 * append-only log of sessions, so most of what is in it was true when it
 * was written and is not a claim about today.
 *
 * So a cited figure whose sentence carries a date or a commit SHA is
 * `RECORDED` — reported, counted, and never compared. One whose sentence
 * carries neither asserts the present tense, and is re-derived. That is the
 * distinction round 1 of #1888 got wrong in the other direction: it read a
 * dated 2026-11-03 recording as a statement about today and concluded the
 * numbers had not moved.
 *
 * **The direction this is allowed to be wrong in** is toward RECORDED. A
 * figure wrongly treated as a record costs a comparison nobody took, which
 * is the status quo for every figure in the file. A figure wrongly compared
 * reddens a true sentence, and the fix for that is to date it — which is
 * the thing the file should be doing anyway.
 */

/** One reading as `scripts/board-conformance.ts` produces it. */
export interface LiveReading {
  name: string;
  measured: number;
  target: number;
}

/** A ratio found in prose, and the reading it names. */
export interface CitedReading {
  /** The reading's name, exactly as `board-conformance` spells it. */
  reading: string;
  measured: number;
  target: number;
  /** The sentence it was read out of, so a refusal can quote its evidence. */
  sentence: string;
  /**
   * Does the sentence carry a date or a commit SHA? A cited figure that
   * says when it was taken is a record of a past reading, not a claim about
   * the present, and is not compared.
   */
  dated: boolean;
}

/**
 * Four outcomes, and they are four different facts.
 *
 * `UNRESOLVABLE` exists so that a reading named in prose which
 * `board-conformance` no longer produces is a refusal rather than silence.
 * A renamed reading would otherwise drop out of the comparison entirely and
 * the file would read as fully checked.
 */
export type ClaimVerdict =
  | { kind: "AGREED"; cited: CitedReading }
  | { kind: "DISAGREED"; cited: CitedReading; live: LiveReading }
  | { kind: "RECORDED"; cited: CitedReading }
  | { kind: "UNRESOLVABLE"; cited: CitedReading; why: string };

/** A date, or a commit SHA: either says WHEN the figure was taken. */
const STAMPED = /\b\d{4}-\d{2}-\d{2}\b|\b[0-9a-f]{7,40}\b/;

/**
 * Sentence boundaries, and `\n` counts as one.
 *
 * A `priorities[]` entry is one long string with hard line breaks in it,
 * and two figures either side of a newline are two statements. Splitting on
 * `[.!?]` alone joined them, and the gap window below would then reach
 * across the break.
 */
const SENTENCE = /(?<=[.!?])\s+|\n+/;

/**
 * How much may sit between a reading's name and its ratio.
 *
 * Wide enough for `blocked-by-edges to 6 of 6` and `milestones 26 of 26`,
 * and stopped at `,` `;` and `.` so that `blocked-by-edges 5 of 6,
 * criteria-field 5 of 6` cannot pair the first name with the second ratio.
 * Any other reading's name appearing inside the window disqualifies the
 * pairing too — the punctuation alone is not enough, and a list written
 * without commas would otherwise collapse onto its first name.
 */
const GAP_MAX = 24;

function escapeForPattern(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every ratio in `prose` that names one of `names`.
 *
 * The names are passed in rather than declared here, and that is the point:
 * `board-conformance` owns what a reading is called, and a second list here
 * would be a second decider for a question already answered — two deciders
 * that agree, which no behavioural test can tell apart.
 */
export function citedReadings(prose: string, names: readonly string[]): CitedReading[] {
  const out: CitedReading[] = [];
  // Longest first, so `criterion-coverage` is never matched as `criteri…`
  // by a shorter sibling that happens to be a prefix of it.
  const ordered = [...names].sort((a, b) => b.length - a.length);
  for (const sentence of prose.split(SENTENCE)) {
    const dated = STAMPED.test(sentence);
    for (const name of ordered) {
      const re = new RegExp(
        `${escapeForPattern(name)}([^,;.]{0,${GAP_MAX}}?)\\b(\\d+)\\s*(?:of|/)\\s*(\\d+)\\b`,
        "gi",
      );
      for (const m of sentence.matchAll(re)) {
        const gap = m[1] ?? "";
        // A different reading's name inside the window means this ratio
        // belongs to that one, not to this one.
        if (ordered.some(other => other !== name && gap.toLowerCase().includes(other.toLowerCase()))) {
          continue;
        }
        out.push({
          reading: name,
          measured: Number(m[2]),
          target: Number(m[3]),
          sentence: sentence.trim(),
          dated,
        });
      }
    }
  }
  return out;
}

/**
 * Compare each cited figure against the live reading of the same name.
 *
 * `live` is the whole set, so an unresolvable citation can say what the
 * known names are rather than only that this one is not among them.
 */
export function judgeClaims(
  prose: string,
  live: readonly LiveReading[],
): ClaimVerdict[] {
  const byName = new Map(live.map(r => [r.name, r]));
  return citedReadings(prose, [...byName.keys()]).map((cited): ClaimVerdict => {
    const now = byName.get(cited.reading);
    if (now === undefined) {
      return {
        kind: "UNRESOLVABLE",
        cited,
        why:
          `no live reading is called ${JSON.stringify(cited.reading)}. Known readings: ` +
          `${[...byName.keys()].join(", ")}`,
      };
    }
    if (cited.dated) return { kind: "RECORDED", cited };
    if (cited.measured === now.measured && cited.target === now.target) {
      return { kind: "AGREED", cited };
    }
    return { kind: "DISAGREED", cited, live: now };
  });
}

/**
 * A reading of a whole state file: how many of each verdict, and which.
 *
 * `claims === 0` is its own fact and the caller must be able to say so.
 * "no readable claims in this file" and "every claim agreed" are the same
 * zero disagreements and completely different states, and conflating them
 * is how a check certifies a file it never looked inside.
 */
export interface StateClaimReading {
  verdicts: ClaimVerdict[];
  claims: number;
  agreed: number;
  disagreed: ClaimVerdict[];
  recorded: number;
  unresolvable: ClaimVerdict[];
}

export function readStateClaims(
  entries: readonly string[],
  live: readonly LiveReading[],
): StateClaimReading {
  const verdicts = entries.flatMap(e => judgeClaims(e, live));
  return {
    verdicts,
    claims: verdicts.length,
    agreed: verdicts.filter(v => v.kind === "AGREED").length,
    disagreed: verdicts.filter(v => v.kind === "DISAGREED"),
    recorded: verdicts.filter(v => v.kind === "RECORDED").length,
    unresolvable: verdicts.filter(v => v.kind === "UNRESOLVABLE"),
  };
}
