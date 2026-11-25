/**
 * The issue number one entry of a session's issue list, or one state-file
 * key, names, or null (#2817): a positive safe integer, or a string of digits
 * with one optional leading `#` that reads as one. Past
 * `Number.MAX_SAFE_INTEGER` a number prints rounded or in exponent form, so it
 * is refused rather than rendered as `#1e+21` (#2821 review).
 *
 * The one decider. The session shape check, the renderer and
 * `scripts/check-state-record-closes.ts` all import it. This file imports
 * nothing, so that script's mutation battery can copy it beside the mutant
 * (#2821 review, round 4: before, the script spelled the rule again inline).
 */
/** One refused entry of an issue list: not an issue number (`first` null), or a number named at `first` already. */
export interface IssueListViolation {
  index: number;
  item: unknown;
  first: number | null;
}

/**
 * The numbers an issue list names, in order, and every entry it refuses: one
 * that is not an issue number, and one naming a number already named. The one
 * list reader (#2825): the session shape check, the closures check's declared
 * list and its state-file keys all call it, so one list gets one answer.
 */
export function issueList(items: readonly unknown[]): { numbers: number[]; violations: IssueListViolation[] } {
  const numbers: number[] = [];
  const violations: IssueListViolation[] = [];
  const seen = new Map<number, number>();
  items.forEach((item, index) => {
    const n = issueNumber(item);
    if (n === null) violations.push({ index, item, first: null });
    else if (seen.has(n)) violations.push({ index, item, first: seen.get(n)! });
    else {
      seen.set(n, index);
      numbers.push(n);
    }
  });
  return { numbers, violations };
}

export function issueNumber(item: unknown): number | null {
  const n =
    typeof item === "number" ? item : typeof item === "string" && /^#?\d+$/.test(item) ? Number(item.replace(/^#/, "")) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
