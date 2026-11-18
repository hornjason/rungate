/**
 * A finding's class size, counted by a search instead of declared (#1883,
 * CRC-N3).
 *
 * The reviewer used to write `population` as a number it chose. On #1877 it
 * wrote `1, 1, 1, —, —, 1, 2, 2, 3` across eleven rounds, every round naming
 * one file, and the next round kept finding another instance of the same
 * class. A self-reported count of absences carries no information when the
 * model emits the same value whatever the truth.
 *
 * So the count changes provenance. The reviewer names the literal text it
 * searched the cited file for (`populationSearch`), and the count is the
 * number of lines of that file carrying any of it — run here, not asserted
 * there. A declared `population` with no search behind it is UNMEASURED, not
 * believed. A declared number the search does not return is refused, and the
 * search's count stands.
 *
 * **Literal text, never a pattern or a command.** The payload is written by a
 * model reading the branch under review, so anything here that executes is
 * an injection route into CI, and a regular expression is a denial-of-service
 * route (catastrophic backtracking). A substring test over each line does
 * neither.
 *
 * **No relative imports, deliberately.** `test/finding-population.test.ts`
 * copies this file into a scratch directory with the comparison removed and
 * imports the copy; an import here would make that mutant fail to load,
 * which reads as a refusal and witnesses nothing
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 */

/** At most this many search terms on one finding. A class is not a word list. */
export const POPULATION_SEARCH_MAX_TERMS = 5;
/** A term shorter than this matches nearly every line and counts nothing real. */
export const POPULATION_SEARCH_TERM_MIN = 3;
/** A term longer than this is a paste, not a search. */
export const POPULATION_SEARCH_TERM_MAX = 200;

export type PopulationVerdict =
  /** Neither a count nor a search: the finding said nothing about its class. */
  | { kind: "undeclared" }
  /** A count with no search behind it. UNMEASURED: it is not believed. */
  | { kind: "unbacked"; declared: number }
  /** A search that could not run, or that ran and matched nothing. */
  | { kind: "unmeasured"; why: string }
  /** The search ran; the count is its output, and any declared number agreed. */
  | { kind: "measured"; count: number }
  /** The search ran and returned a different number than the one declared. */
  | { kind: "contradicted"; declared: number; count: number };

/**
 * One declared population as a count, or `null`.
 *
 * `"3"`, `0`, `-1`, `1.5` and `true` are things a model emits and none is a
 * population. A string is refused rather than parsed: the field has one
 * producer and a contract, and a second accepted spelling is how a contract
 * stops meaning anything.
 */
export function declaredPopulation(value: unknown): number | null {
  if (typeof value !== "number") return null;
  return Number.isInteger(value) && value >= 1 ? value : null;
}

/** The search terms a finding names, or `null` when they are not a usable search. */
export function searchTerms(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > POPULATION_SEARCH_MAX_TERMS) return null;
  const terms: string[] = [];
  for (const t of value) {
    if (typeof t !== "string" || /[\r\n]/.test(t)) return null;
    if (t.length < POPULATION_SEARCH_TERM_MIN || t.length > POPULATION_SEARCH_TERM_MAX) return null;
    terms.push(t);
  }
  return terms;
}

/** How many lines carry at least one of the terms, compared literally. */
export function matchingLines(lines: readonly string[], terms: readonly string[]): number {
  let n = 0;
  for (const line of lines) if (terms.some(t => line.includes(t))) n++;
  return n;
}

/**
 * The one decision: what a finding's population is, given the cited file's
 * lines (`null` when the file could not be read).
 */
export function populationVerdict(
  declaredRaw: unknown,
  searchRaw: unknown,
  lines: readonly string[] | null,
): PopulationVerdict {
  const declared = declaredPopulation(declaredRaw);
  if (searchRaw === undefined) {
    return declared === null ? { kind: "undeclared" } : { kind: "unbacked", declared };
  }
  const terms = searchTerms(searchRaw);
  if (terms === null) {
    return {
      kind: "unmeasured",
      why:
        `its search is not 1 to ${POPULATION_SEARCH_MAX_TERMS} literal strings of ` +
        `${POPULATION_SEARCH_TERM_MIN} to ${POPULATION_SEARCH_TERM_MAX} characters on one line`,
    };
  }
  if (lines === null) return { kind: "unmeasured", why: "the cited file could not be read in the checkout" };
  const count = matchingLines(lines, terms);
  if (count === 0) return { kind: "unmeasured", why: "its search matches no line of the cited file, so it does not describe the cited site" };
  if (declared !== null && declared !== count) return { kind: "contradicted", declared, count };
  return { kind: "measured", count };
}

/** The count a verdict stands behind, or `null` when it measured nothing. */
export function verifiedPopulation(v: PopulationVerdict): number | null {
  return v.kind === "measured" || v.kind === "contradicted" ? v.count : null;
}
