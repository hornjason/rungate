/**
 * What Ready holds, in one place — read by the writer AND by the health
 * reading, so the two cannot disagree.
 *
 * Covers SC-2710, SC-2711, SC-2712 (specs/BOARD-FLOW-SPEC.md).
 *
 * ## Why this file exists at all
 *
 * On 2026-11-05 two files held two different definitions of Ready and
 * neither knew about the other. `isReady` in `lib/board-mirror.ts` required
 * the frontier phase; `target()` in `lib/board-lane-health.ts` compared the
 * lane against every unblocked, unclaimed issue in the repository. Measured
 * over all 35 pickable issues that day, at most **3** could ever satisfy the
 * writer, and the lane held 5 — so the report said `SHORT by 30` and would
 * have said so forever. **The instrument blamed the board.**
 *
 * That is the fourth shape in `.claude/rules/checks-must-be-able-to-fail.md`
 * inverted: not two deciders that agree, but two that disagree, with no
 * single site a mutation could move. Hence one module, two callers, and
 * `test/board-ready-rule.test.ts` asserting that a mutation here reddens
 * both.
 *
 * ## The rule, decided by Jason on 2026-11-05
 *
 * | | Eligibility | Ordering | Size |
 * |---|---|---|---|
 * | before | unblocked + unclaimed + **current phase** | — | unbounded |
 * | now | unblocked + unclaimed | by phase, then issue number | **capped** |
 *
 * Phase moves out of eligibility and into ordering. It was doing crowd
 * control inside an eligibility test, which is why `lib/board-mirror.ts`
 * recorded that removing it made 36 of 46 open issues Ready — "the backlog
 * with a different name". **The cap is the answer to that, not a filter.**
 * Ready is Anderson's replenishment commitment point, and Yeret's line is
 * the one that matters: the number is not the policy, the policy is what
 * happens once it is reached.
 *
 * **This file is the SIZE, and only the size, today.** Eligibility still
 * lives in `isReady` in `lib/board-mirror.ts` with the phase gate attached,
 * and ordering has no caller yet. The cap lands first deliberately:
 * dropping the phase gate while nothing bounds the lane is the 36-of-46
 * reading again, so the bound has to exist before the gate can go. Ordering
 * and selection arrive with the writers that use them — an export with no
 * call site is a decision nothing performs.
 */

/**
 * How much work was delivered, over how long.
 *
 * `days` is the observation window, not a count of working days — a window
 * that excluded weekends would make the rate higher than the queue actually
 * drains, and the cap would stop binding exactly when the swarm is quiet.
 */
export interface Throughput {
  /** Issues closed as delivered inside the window. */
  readonly delivered: number;
  /** The length of the window in days. Must be positive. */
  readonly days: number;
}

/**
 * How long a puller may wait for Ready to be replenished, in days.
 *
 * Half a day. Replenishment here is event-driven rather than a meeting, so
 * the tolerance is not a cadence — it is how much of a stall we accept if
 * every event mechanism is wedged at once. Little's Law turns it into a
 * depth: at the 2026-11-05 reading of 237 issues over 14 days ≈ 17/day, half
 * a day of cover is 8.
 */
export const READY_TOLERANCE_DAYS = 0.5;

/**
 * The queue depth, derived from live throughput.
 *
 * **A literal would go stale in both directions** — too shallow the moment a
 * swarm runs, too deep the moment one stops — and a depth nobody can
 * re-derive is a number nobody will ever change. So it is computed every
 * time from what the repository actually delivered.
 *
 * `null` for a window that cannot produce a rate. A zero-length window is
 * not a throughput of zero; those are opposite facts wearing the same digit,
 * and the caller must be able to tell a quiet fortnight from a failed read
 * (`.claude/rules/config-access.md`, *Silent Default Substitution*).
 *
 * The floor of 1 is not a fudge: a repository that genuinely delivered
 * nothing still has to let the first item through, or Ready can never start.
 */
export function readyCap(t: Throughput): number | null {
  if (!Number.isFinite(t.delivered) || !Number.isFinite(t.days)) return null;
  if (t.days <= 0) return null;
  if (t.delivered < 0) return null;
  return Math.max(1, Math.floor((t.delivered / t.days) * READY_TOLERANCE_DAYS));
}

/**
 * What Ready SHOULD hold: the cap, or the eligible count when there is less
 * work than cap.
 *
 * This is the denominator `lib/board-lane-health.ts` judges the lane
 * against, and it is the same number the writer fills to — which is the
 * point. `null` propagates: an unreadable cap makes the lane unjudged, never
 * healthy.
 */
export function readyTarget(eligible: number, cap: number | null): number | null {
  if (cap === null) return null;
  return Math.min(eligible, cap);
}
