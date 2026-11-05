/**
 * Is each board lane holding what it is supposed to hold?
 *
 * Covers SC-2670 (specs/BOARD-FLOW-SPEC.md).
 *
 * ## Why a count alone is not a reading
 *
 * `scripts/work-status.ts` can already say how many items sit in each lane.
 * That number is worthless on its own: Ready holding 6 is excellent if 6 is
 * everything that could be ready, and total failure if 34 things could be.
 * **A lane is healthy or not only against what SHOULD be in it**, so every
 * row here carries its denominator or admits it has none.
 *
 * The three comparisons come from the spec's own outcomes table and are not
 * invented here:
 *
 * | Lane | Against | Because |
 * |---|---|---|
 * | Ready | unblocked and unclaimed issues | Ready is Anderson's replenishment COMMITMENT POINT, so a Ready far below what is eligible means the ordering decision has relocated into each puller's private Backlog heuristic, leaving no reviewable record |
 * | In progress | open AND assigned issues | somebody is working it; a lane that does not say so makes active work invisible and makes cycle time ABSENT rather than approximate |
 * | Cancelled | issues closed as `not_planned` | work that left without being done. Off the board entirely is worse than merged into Done: the cancellation rate becomes unobservable and Little's Law's second assumption breaks, so every forecast is unsound rather than merely imprecise |
 *
 * Backlog, In review and Done get no denominator, and say so rather than
 * reading OK. Backlog is a DISPLAY — five of the six lanes are mechanisms
 * and it is the exception — and the other two have no cheap second source to
 * compare against. **An unmeasured lane must not spell the same as a healthy
 * one**, which is the defect this whole area keeps producing.
 */

/** Every lane name the board uses, in flow order. */
export const LANES: readonly string[] = [
  "Backlog",
  "Ready",
  "In progress",
  "In review",
  "Done",
  "Cancelled",
];

export type LaneHealth =
  /** Holding what it should, measured against a denominator. */
  | "OK"
  /** Has a writer and a denominator, and is below it. */
  | "SHORT"
  /** Empty while its denominator is not. Nothing writes this lane. */
  | "UNWRITTEN"
  /** No denominator exists, so the count is reported and nothing is judged. */
  | "NO_TARGET"
  /** The census could not be taken. Never the same as OK. */
  | "UNMEASURED";

export interface LaneCensus {
  /** Lane name to the number of items the board shows in it. */
  readonly counts: ReadonlyMap<string, number>;
  /** Open issues that are unblocked and unclaimed. */
  readonly pickable: number;
  /** Open issues with at least one assignee. */
  readonly openAssigned: number;
  /** Issues closed with `state_reason: not_planned`. */
  readonly notPlannedClosed: number;
  /**
   * False when the board could not be paged in full.
   *
   * A partial page and an empty lane produce the same count, and that
   * ambiguity is the whole subject here — so an incomplete census refuses
   * every row rather than reporting the numbers it happens to hold.
   */
  readonly complete: boolean;
}

export interface LaneReading {
  readonly lane: string;
  readonly count: number;
  /** What the lane should hold. `null` when nothing cheap can say. */
  readonly against: number | null;
  readonly health: LaneHealth;
  readonly why: string;
}

/** The denominator for each lane that has one, and why it is that one. */
function target(lane: string, c: LaneCensus): { against: number; label: string } | null {
  if (lane === "Ready") return { against: c.pickable, label: "unblocked and unclaimed" };
  if (lane === "In progress") return { against: c.openAssigned, label: "open and assigned" };
  if (lane === "Cancelled") return { against: c.notPlannedClosed, label: "closed as not_planned" };
  return null;
}

/**
 * One reading per lane, in flow order.
 *
 * A lane the board never mentioned reads `0`, which is correct: the board
 * showing no items in a lane and the board having no such lane are the same
 * fact from the outside, and both mean nothing is in it.
 */
export function laneHealth(c: LaneCensus): LaneReading[] {
  return LANES.map(lane => {
    const count = c.counts.get(lane) ?? 0;
    if (!c.complete) {
      return {
        lane,
        count,
        against: null,
        health: "UNMEASURED" as const,
        why: "the board could not be paged in full, so this count is a floor and not a reading",
      };
    }
    const t = target(lane, c);
    if (t === null) {
      return {
        lane,
        count,
        against: null,
        health: "NO_TARGET" as const,
        why: "no second source says what should be here, so the count is reported and nothing is judged",
      };
    }
    if (count === 0 && t.against > 0) {
      return {
        lane,
        count,
        against: t.against,
        health: "UNWRITTEN" as const,
        why: `${t.against} ${t.label}, and this lane is empty — nothing writes it`,
      };
    }
    if (count < t.against) {
      return {
        lane,
        count,
        against: t.against,
        health: "SHORT" as const,
        why: `${t.against} ${t.label}, so ${t.against - count} are missing from this lane`,
      };
    }
    return {
      lane,
      count,
      against: t.against,
      health: "OK" as const,
      why: `${t.against} ${t.label}, and the lane holds ${count}`,
    };
  });
}

/**
 * The lines the report prints.
 *
 * Separated from the caller so the report itself can be asserted. A lane
 * missing from the printed output is the failure this exists to catch, and
 * it is invisible when the formatting lives inside the I/O.
 */
export function laneHealthLines(readings: readonly LaneReading[]): string[] {
  return readings.map(r => {
    const against = r.against === null ? "" : ` of ${r.against}`;
    return `  ${r.lane.padEnd(12)} ${String(r.count).padStart(4)}${against.padEnd(8)} ${r.health.padEnd(11)} ${r.why}`;
  });
}
