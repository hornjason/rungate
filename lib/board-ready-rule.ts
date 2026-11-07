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
 * How full Ready is — the ONE answer, read by the writer and by the report.
 *
 * ## Why this exists (#1852)
 *
 * Two files answered "how full is Ready" and answered differently.
 * `scripts/board-ready.ts` counted **every card**, arguing correctly that a
 * pull request parked in the lane occupies a slot a puller can see.
 * `scripts/work-status.ts` counted **open issues only**, arguing equally
 * correctly that a lane of closed cards has nothing to start. Neither was
 * wrong about the question it asked; they were asking different questions
 * and the plan treated the answers as one number.
 *
 * Measured on main 2026-11-07, with a draft card and issue #1650 in the
 * lane at a cap of 2: the writer reported `2 of 2, so it is full and nothing
 * was promoted` and refused 37 eligible issues, while the report reported
 * `1 of 2 SHORT` and exited non-zero. **The lane was physically full and
 * functionally empty, and no single integer could say so.**
 *
 * That is `.claude/rules/checks-must-be-able-to-fail.md`'s fourth shape
 * inverted — not two deciders that agree, but two that disagree with no
 * single site a mutation could move — and this module's own header records
 * it happening here before, on 2026-11-05, between `isReady` and `target()`.
 *
 * ## Both numbers, because the state needs both
 *
 * `cards` bounds promotion: a slot held by anything is not free, so the
 * writer cannot exceed the depth by however many non-issues the lane holds.
 * `dispatchable` is what a session can actually start. `WEDGED` is the state
 * that needed naming: full by cards, empty by work, and reachable by one
 * undispatchable card at a cap of 2.
 */
export type OccupancyVerdict = "ROOM" | "FULL" | "WEDGED" | "UNMEASURED";

export interface ReadyOccupancy {
  /** Every card in the lane — an issue, a pull request, a draft. */
  readonly cards: number;
  /** Cards a session can start: open issues. Never above `cards`. */
  readonly dispatchable: number;
  /** `cards - dispatchable`. Named, because it is the thing to clear. */
  readonly undispatchable: number;
  readonly cap: number | null;
  /** Slots a promoter may fill. Always 0 when the cap is unreadable. */
  readonly free: number;
  readonly verdict: OccupancyVerdict;
  readonly why: string;
}

/**
 * The one reading. `dispatchable` above `cards` is a caller bug, not a lane
 * state — it means the two were counted over different populations, which is
 * the defect this function exists to end — so it is refused rather than
 * clamped. A clamp would make the wrong call site look right.
 */
export function readyOccupancy(
  cards: number,
  dispatchable: number,
  /**
   * How deep the lane is allowed to be. The WRITER passes `readyCap`; the
   * REPORT passes `readyTarget`, which is the smaller of the cap and the
   * eligible count. Both are "the depth", and the sentences below say depth
   * for that reason — calling a target a cap in the report's own output is
   * the drift this module exists to stop.
   */
  cap: number | null,
): ReadyOccupancy {
  if (!Number.isInteger(cards) || !Number.isInteger(dispatchable) || cards < 0 || dispatchable < 0) {
    throw new Error(
      `readyOccupancy: cards and dispatchable must be non-negative integers, got ` +
        `${cards} and ${dispatchable}. A count that could not be taken is not a count of zero.`,
    );
  }
  if (dispatchable > cards) {
    throw new Error(
      `readyOccupancy: dispatchable (${dispatchable}) exceeds cards (${cards}), so the two were ` +
        "counted over different populations — which is exactly the defect #1852 closed. " +
        "Both must be read from one pass over one lane.",
    );
  }
  const undispatchable = cards - dispatchable;
  if (cap === null) {
    return {
      cards,
      dispatchable,
      undispatchable,
      cap: null,
      free: 0,
      verdict: "UNMEASURED",
      why:
        "UNMEASURED — throughput could not be read, so Ready's depth is unknown and nothing was promoted",
    };
  }
  const free = Math.max(0, cap - cards);
  if (free > 0) {
    return {
      cards,
      dispatchable,
      undispatchable,
      cap,
      free,
      verdict: "ROOM",
      why: `Ready holds ${cards} of its depth of ${cap}, so ${free} slot(s) are free`,
    };
  }
  // Full by cards. WEDGED is the half that had no name: the lane is at its
  // depth and nothing in it can be started, so the writer will not refill it
  // and the reader will keep refusing. It unsticks only by hand.
  if (dispatchable === 0) {
    return {
      cards,
      dispatchable,
      undispatchable,
      cap,
      free: 0,
      verdict: "WEDGED",
      why:
        `Ready holds ${cards} of its depth of ${cap} and NONE of them can be started — ` +
        `${undispatchable} card(s) in the lane ${undispatchable === 1 ? "is" : "are"} not an open ` +
        "issue. Nothing can dispatch a draft or a pull request, and nothing ages one out, so this " +
        "lane is full and empty at the same time and no event will refill it. Clear the lane.",
    };
  }
  return {
    cards,
    dispatchable,
    undispatchable,
    cap,
    free: 0,
    verdict: "FULL",
    why:
      `Ready holds ${cards} of its depth of ${cap}, so it is full and nothing was promoted` +
      (undispatchable > 0
        ? ` — and ${undispatchable} of them cannot be started, so only ${dispatchable} is real work`
        : ""),
  };
}

/**
 * SELECTION: which eligible issues to promote right now.
 *
 * It takes a `ReadyOccupancy` rather than a cap and a count, so the free-slot
 * arithmetic exists exactly once (#1852). It used to compute
 * `max(0, cap - occupied)` itself, which made it the second site that decided
 * how full the lane was.
 *
 * This is the replenishment half of the commitment point, and it is what
 * makes the cap something other than a ceiling nobody reaches: a pull frees a
 * slot and the next event refills it.
 *
 * **An unreadable cap promotes nothing, and says so.** The tempting
 * fallback — promote everything eligible and let a human trim it — is the
 * exact failure the cap exists to prevent, performed automatically.
 */
export function selectReady<T extends Rankable>(
  eligible: readonly T[],
  occ: ReadyOccupancy,
): { readonly promote: readonly T[]; readonly why: string } {
  if (occ.free === 0) {
    // One branch for every reason there is no room — UNMEASURED, FULL and
    // WEDGED each carry their own sentence on the reading itself, so this
    // does not restate them and cannot disagree with them.
    return { promote: [], why: occ.why };
  }
  // A copy, not a sort in place: the caller's array is its own decision
  // record and reordering it changes what its log prints.
  const promote = [...eligible].sort(readyOrder).slice(0, occ.free);
  return {
    promote,
    why:
      `${occ.why}; ${eligible.length} eligible, promoting ${promote.length} ` +
      "in phase then age order",
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
 *
 * **Three causes now, not two** (#1852). "Ready is at its depth" is true of a
 * WEDGED lane and sends the reader to the depth — which is not the thing to
 * change. A lane held at its cap by cards nobody can start needs clearing,
 * and the held issues are the evidence that something wants the slot.
 */
export function heldReason(occ: ReadyOccupancy): string {
  switch (occ.verdict) {
    case "UNMEASURED":
      return "Ready's depth could not be measured, so nothing was promoted";
    case "WEDGED":
      return (
        `Ready is at its depth of ${occ.cap} and WEDGED — every card in it is undispatchable, ` +
        "so clearing the lane is the fix, not lowering the depth"
      );
    case "FULL":
    case "ROOM":
      return "Ready is at its depth";
    default: {
      const unhandled: never = occ.verdict;
      throw new Error(
        `heldReason: unclassified occupancy verdict ${JSON.stringify(unhandled)}. ` +
          "Every verdict must name its own cause — defaulting a new one to 'at its depth' is " +
          "how WEDGED read as a lane that only needed a bigger cap.",
      );
    }
  }
}

/**
 * What to do about cards in Ready nobody can start — the REPORT's question.
 *
 * ## Not the same question as `heldReason`, which is why it is not the same
 * sentence
 *
 * ai-review round 1 of #1857. `heldReason` answers *why did this eligible
 * issue not move*, and both callers ask it while iterating items they held
 * back. In a `ROOM` reading those items are held because promoting into the
 * free slots reaches the depth, so "Ready is at its depth" is true of them.
 *
 * `scripts/work-status.ts` promotes nothing. It is describing a lane, and it
 * says this whenever the lane holds a card that is not an open issue —
 * including when the lane is SHORT. Routing that through `heldReason` printed
 * "Ready is at its depth" over a lane holding 2 of a depth of 5. That is
 * false, and it is the wrong instruction besides: a short lane is fixed by
 * promoting, not by clearing.
 *
 * ## Two renderings, one decider
 *
 * Both switch on a verdict neither computes. `readyOccupancy` remains the only
 * thing that decides how full Ready is, so a mutation of the reading moves
 * both sentences together and neither can drift from the other's arithmetic —
 * which is the property #1852 bought and the thing a second *decider* would
 * have given back.
 */
export function undispatchableRemedy(occ: ReadyOccupancy): string {
  switch (occ.verdict) {
    case "UNMEASURED":
      return (
        "Ready's depth could not be read, so whether those card(s) are costing a slot " +
        "is unknown too"
      );
    case "WEDGED":
      return (
        `Ready is at its depth of ${occ.cap} and WEDGED — NOTHING in the lane can be started, ` +
        "so clearing the lane is the fix. Promotion cannot help: there is no slot to promote into"
      );
    case "FULL":
      return (
        `Ready is at its depth of ${occ.cap}, so each of them holds a slot a startable issue ` +
        "could be in — clear them and the next promotion fills the lane"
      );
    case "ROOM":
      return (
        `Ready is NOT full — it holds ${occ.cards} of its depth of ${occ.cap}, so ${occ.free} ` +
        "slot(s) are free and PROMOTING is what fixes this lane. Clearing the undispatchable " +
        "card(s) is worth doing and is not what is holding it short"
      );
    default: {
      const unhandled: never = occ.verdict;
      throw new Error(
        `undispatchableRemedy: unclassified occupancy verdict ${JSON.stringify(unhandled)}. ` +
          "Every verdict must name its own remedy — defaulting a new one to 'clear the lane' " +
          "sends a SHORT lane's reader to the one fix that cannot work.",
      );
    }
  }
}
