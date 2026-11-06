/**
 * What Ready holds, in one place — read by the writer AND by the health
 * reading, so the two cannot disagree.
 *
 * Covers SC-2710, SC-2711, SC-2712, SC-2715, SC-2716, SC-2719 (specs/BOARD-FLOW-SPEC.md).
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
 * **This file is the SIZE and the ORDER. Eligibility is still elsewhere** —
 * `isReady` in `lib/board-mirror.ts`, which carried the phase gate until
 * 2026-11-05. The bound landed first deliberately: dropping the gate while nothing
 * caps the lane is the 36-of-46 reading again, so the bound has to exist
 * before the gate can go.
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

/** Everything ordering reads. Phase `null` means "no phase milestone". */
export interface Rankable {
  readonly phase: number | null;
  readonly number: number;
}

/**
 * ORDERING: which eligible issue should be pulled first.
 *
 * Phase ascending, because the phase placement table is the project's own
 * declared order and is data rather than a judgement made here. **A
 * phase-less issue sorts last, not never** — that is the whole difference
 * between ordering and the eligibility gate it replaces, and on 2026-11-05
 * it was the difference between 3 candidates and 35. Ties break on issue
 * number ascending, which is age: the oldest eligible work goes first, so
 * nothing is starved by a steady arrival of newer items.
 */
export function readyOrder(a: Rankable, b: Rankable): number {
  const pa = a.phase === null ? Number.POSITIVE_INFINITY : a.phase;
  const pb = b.phase === null ? Number.POSITIVE_INFINITY : b.phase;
  if (pa !== pb) return pa - pb;
  return a.number - b.number;
}

/**
 * SELECTION: which eligible issues to promote right now.
 *
 * `occupied` is what Ready already holds, so a full lane promotes nothing
 * and a lane with two free slots promotes the two highest-ranked. This is
 * the replenishment half of the commitment point, and it is what makes the
 * cap something other than a ceiling nobody reaches: a pull frees a slot
 * and the next event refills it.
 *
 * **An unreadable cap promotes nothing, and says so.** The tempting
 * fallback — promote everything eligible and let a human trim it — is the
 * exact failure the cap exists to prevent, performed automatically.
 */
export function selectReady<T extends Rankable>(
  eligible: readonly T[],
  cap: number | null,
  occupied: number,
): { readonly promote: readonly T[]; readonly why: string } {
  if (cap === null) {
    return {
      promote: [],
      why: "UNMEASURED — throughput could not be read, so Ready's depth is unknown and nothing was promoted",
    };
  }
  const slots = Math.max(0, cap - occupied);
  if (slots === 0) {
    return {
      promote: [],
      why: `Ready holds ${occupied} of its cap of ${cap}, so it is full and nothing was promoted`,
    };
  }
  // A copy, not a sort in place: the caller's array is its own decision
  // record and reordering it changes what its log prints.
  const promote = [...eligible].sort(readyOrder).slice(0, slots);
  return {
    promote,
    why:
      `Ready holds ${occupied} of its cap of ${cap}, so ${slots} slot(s) are free; ` +
      `${eligible.length} eligible, promoting ${promote.length} in phase then age order`,
  };
}

/**
 * Why an eligible issue did not move.
 *
 * **Two causes, two sentences.** The writer printed "Ready is at its
 * depth" for every eligible issue it held back, including when the depth
 * was never read — so a run that measured nothing told the reader the lane
 * was full, one line below its own UNMEASURED warning. ai-review found it
 * on #1793 and it is the same defect in miniature as the lane health row
 * that blamed the board: a reading that names the wrong cause sends the
 * next person to the wrong place.
 *
 * It lives here rather than inline in the script so a case can hold it.
 */
export function heldReason(cap: number | null): string {
  return cap === null
    ? "Ready's depth could not be measured, so nothing was promoted"
    : "Ready is at its depth";
}
