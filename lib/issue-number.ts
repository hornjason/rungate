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
export function issueNumber(item: unknown): number | null {
  const n =
    typeof item === "number" ? item : typeof item === "string" && /^#?\d+$/.test(item) ? Number(item.replace(/^#/, "")) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
