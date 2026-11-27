/**
 * The review round cap: how many AI review rounds a pull request may take
 * before its author stops repairing it and re-scopes the change.
 */

export const DEFAULT_ROUND_CAP = 3;

/** The cap as configured, or the default when none is set. */
export function readRoundCap(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_ROUND_CAP;
  return Number.parseInt(raw, 10);
}

/** Whether another review round may start after `used` rounds. */
export function mayStartRound(raw: string | undefined, used: number): boolean {
  const read = readRoundCap(raw);
  const cap = Number.isNaN(read) ? DEFAULT_ROUND_CAP : read;
  return used < cap;
}

/** The line the review comment prints under its verdict. */
export function roundsLeftLabel(raw: string | undefined, used: number): string {
  const left = readRoundCap(raw) - used;
  return left === 1 ? "1 round left" : `${left} rounds left`;
}
