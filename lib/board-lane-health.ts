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
  /**
   * Issues closed with `state_reason: not_planned`, or `null` when the
   * count could not be taken.
   *
   * **`null` rather than `0`**, because they are opposite facts wearing the
   * same digit: zero cancellations makes Cancelled correct, and a search
   * that failed makes it unknown. Collapsing them produces a green lane out
   * of a measurement that never happened — security review of the pushed
   * commit, finding 1.
   */
  readonly notPlannedClosed: number | null;
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

/**
 * The denominator for each lane that has one, and why it is that one.
 *
 * **Every label says the denominator is repo-wide.** The numerator counts
 * items on the BOARD and all three denominators count the whole repository,
 * so an eligible issue the board has never held inflates the gap. Security
 * review of the pushed commit, finding 3. Scoping the denominators to board
 * items would hide the more important failure — an eligible issue that
 * never reached the board at all — so the populations stay as they are and
 * the reading declares the mismatch instead of pretending to be exact.
 *
 * `undefined` means this lane has no denominator; `null` inside one means
 * the denominator exists but could not be read.
 */
function target(lane: string, c: LaneCensus): { against: number | null; label: string } | undefined {
  if (lane === "Ready") return { against: c.pickable, label: "unblocked and unclaimed, repo-wide" };
  if (lane === "In progress") return { against: c.openAssigned, label: "open and assigned, repo-wide" };
  if (lane === "Cancelled") return { against: c.notPlannedClosed, label: "closed as not_planned, repo-wide" };
  return undefined;
}

/**
 * One reading per lane, in flow order.
 *
 * A lane the board never mentioned reads `0`, which is correct: the board
 * showing no items in a lane and the board having no such lane are the same
 * fact from the outside, and both mean nothing is in it.
 */
export function laneHealth(c: LaneCensus): LaneReading[] {
  // **A lane the board has and this file does not know about gets its own
  // row.** Mapping over LANES alone meant such a lane contributed items to
  // no row at all, so the report stayed confident and complete-looking
  // while part of the board was simply absent from it. Adding a lane on the
  // board is two clicks and nobody would think to mirror it here. Security
  // review of the pushed commit, finding 4.
  const unknown = [...c.counts.keys()]
    .filter(k => !LANES.includes(k) && !k.startsWith("("))
    .sort();
  const known = LANES.map(lane => {
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
    if (t === undefined) {
      return {
        lane,
        count,
        against: null,
        health: "NO_TARGET" as const,
        why: "no second source says what should be here, so the count is reported and nothing is judged",
      };
    }
    // The denominator exists but could not be read. A failed search is not
    // a repository with nothing in it.
    if (t.against === null) {
      return {
        lane,
        count,
        against: null,
        health: "UNMEASURED" as const,
        why: `the ${t.label} count could not be read, so this lane has no denominator to judge against`,
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
        why: `${t.against} ${t.label}, so up to ${t.against - count} are missing from this lane`,
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
  return [
    ...known,
    ...unknown.map(lane => ({
      lane,
      count: c.counts.get(lane) ?? 0,
      against: null,
      health: "UNMEASURED" as const,
      why: `this report does not know the lane "${lane}", so its items are unaccounted for above`,
    })),
  ];
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
