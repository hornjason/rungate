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

/**
 * Everything ordering reads. Phase `null` means "no phase milestone".
 *
 * `labels` is **required, with no default** (#1853). An optional field here
 * would let a caller omit it and receive UNPLACED, which is a reading rather
 * than an absence — the same defect `laneHealthLines` records about its own
 * `offBoard` parameter, where a default invented a value the caller already
 * had. Both callers now have to say what they read.
 */
export interface Rankable {
  readonly phase: number | null;
  readonly number: number;
  readonly labels: readonly string[];
}

/**
 * The order labels rank in when no milestone places an issue — Jason's call,
 * 2026-11-06. **This is the only place it is spelled.**
 *
 * `engine` leads because it is the work that reduces the backlog itself:
 * AGENTS.md rule 7 watches issues opened against issues closed, and above 1
 * the backlog diverges however fast the work goes, so engine work compounds
 * and a follow-up does not.
 *
 * **A label outside this map does not place an issue.** The set is closed
 * deliberately: ranking an unknown label by guessing is the silent default
 * `.claude/rules/config-access.md` names, and `arbiter-override` is the live
 * instance — one eligible issue carries it and nothing else, and the honest
 * answer is UNPLACED rather than a tier somebody invented for it.
 */
export const LABEL_RANK: ReadonlyMap<string, number> = new Map([
  ["engine", 0],
  ["spec:convergence", 1],
  ["follow-up", 2],
  ["external-audit", 3],
]);

/** Which source placed an issue — or that nothing did. */
export type PlacementTier = "PHASE" | "LABEL" | "UNPLACED";

export interface Placement {
  readonly tier: PlacementTier;
  /** Rank inside the tier. `POSITIVE_INFINITY` for UNPLACED. */
  readonly rank: number;
  readonly why: string;
}

/** PHASE before LABEL before UNPLACED. A milestone always beats a label. */
const TIER_ORDER: Readonly<Record<PlacementTier, number>> = { PHASE: 0, LABEL: 1, UNPLACED: 2 };

/**
 * Where an issue sits in the plan — milestone, else label, else nowhere.
 *
 * ## Why a second source exists at all (#1853)
 *
 * Phase comes from `phaseOf`, which reads a number out of a MILESTONE TITLE
 * and nothing else. Measured 2026-11-06: of 38 unblocked, unclaimed issues,
 * **10** carried a milestone and **28** did not, so 74% of what Ready draws
 * from sorted as `POSITIVE_INFINITY` and fell through to the tiebreak. The
 * tiebreak is issue number. **The lane was ordered by age.**
 *
 * The obvious repair is to backfill `### Phase placement` tables so
 * `plan-spec` derives a milestone for everything. It cannot reach this
 * backlog: only **16 of 80** open issues name an `SC-` id at all. The other
 * 64 are review follow-ups, audit findings and engine work that never passed
 * through a spec, and no table placed on any spec can rank them.
 *
 * So the label is the fallback, and it is the signal this repository already
 * produces for work with no spec. A milestone still wins, because the
 * milestone is the declared plan and the label is a category.
 *
 * **An issue with several ranked labels takes the best of them.** A
 * follow-up that is also engine work is engine work; taking the worst would
 * let adding a label demote an issue, which makes the rank punish labelling.
 */
export function placementOf(r: Rankable): Placement {
  if (r.phase !== null) {
    return { tier: "PHASE", rank: r.phase, why: `milestone places it in phase ${r.phase}` };
  }
  let best: { label: string; rank: number } | null = null;
  for (const label of r.labels) {
    const rank = LABEL_RANK.get(label);
    if (rank === undefined) continue;
    if (best === null || rank < best.rank) best = { label, rank };
  }
  if (best !== null) {
    return {
      tier: "LABEL",
      rank: best.rank,
      why: `no milestone, and "${best.label}" ranks ${best.rank} of ${LABEL_RANK.size}`,
    };
  }
  return {
    tier: "UNPLACED",
    rank: Number.POSITIVE_INFINITY,
    why:
      r.labels.length === 0
        ? "no milestone and no label at all — nothing in the repository says where this belongs"
        : `no milestone, and none of its labels (${r.labels.join(", ")}) is ranked — ` +
          "add one to LABEL_RANK deliberately, or give it a milestone",
  };
}

/**
 * ORDERING: which eligible issue should be pulled first.
 *
 * Tier first (phase, then label, then unplaced), rank inside the tier, then
 * issue number. **Age still breaks ties and no longer decides the tier** —
 * before #1853 it decided the tier for 28 of 38 candidates, because every
 * one of them ranked `POSITIVE_INFINITY` and the tiebreak was the whole
 * ordering.
 *
 * Phase ascending, because the phase placement table is the project's own
 * declared order and is data rather than a judgement made here. **A
 * phase-less issue sorts last, not never** — that is the whole difference
 * between ordering and the eligibility gate it replaces, and on 2026-11-05
 * it was the difference between 3 candidates and 35. Issue number ascending
 * is age: the oldest work in a tier goes first, so nothing is starved by a
 * steady arrival of newer items.
 *
 * Two UNPLACED items compare `Infinity !== Infinity`, which is false, so the
 * rank test falls through to the number rather than producing `NaN`.
 */
export function readyOrder(a: Rankable, b: Rankable): number {
  const pa = placementOf(a);
  const pb = placementOf(b);
  if (TIER_ORDER[pa.tier] !== TIER_ORDER[pb.tier]) {
    return TIER_ORDER[pa.tier] - TIER_ORDER[pb.tier];
  }
  if (pa.rank !== pb.rank) return pa.rank - pb.rank;
  return a.number - b.number;
}

/** How many candidates each source placed. The report's one reading. */
export interface PlacementCensus {
  readonly phase: number;
  readonly label: number;
  readonly unplaced: number;
}

/**
 * The census the report prints.
 *
 * It lives here rather than inline in `scripts/work-status.ts` so that a
 * mutation of the placement rule moves the writer's ordering AND the
 * reader's count — which is the property `lib/board-lane-health.ts`'s own
 * header says was missing the last two times this area went wrong.
 *
 * **UNPLACED is counted, not folded into "no milestone".** An issue nothing
 * can rank currently reads identically to one ranked last, and that is the
 * distinction every row in the lane-health report exists to keep.
 */
export function placementCensus(items: readonly Rankable[]): PlacementCensus {
  let phase = 0;
  let label = 0;
  let unplaced = 0;
  for (const i of items) {
    const t = placementOf(i).tier;
    if (t === "PHASE") phase++;
    else if (t === "LABEL") label++;
    else unplaced++;
  }
  return { phase, label, unplaced };
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
