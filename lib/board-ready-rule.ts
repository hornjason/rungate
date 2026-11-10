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

import { phaseOf } from "./board-mirror";
import { inMilestoneFamily } from "./live-issues";

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
 * Everything ordering reads. `milestone` is the milestone TITLE, or `null`.
 *
 * **The title and not a phase number** (#1943). A number has already thrown
 * away the family, and the family is half the order: this repository runs two
 * milestone families at once — `Pipeline Phase N`, the engine, and
 * `Convergence Phase N`, the payload the engine ships — and comparing their
 * numbers as one sequence puts the payload ahead of the engine whenever its
 * number is lower. Observed 2026-11-09 in `work-status`: `#1764 Convergence
 * Phase 3` ranked above `#1717 Pipeline Phase 6`, which inverts what
 * `specs/SPEC-TO-BOARD-PIPELINE-SPEC.md` states and what SC-2625 makes the
 * engine's own acceptance test.
 *
 * Carrying both the title and a pre-read number would be two views of one
 * fact, and a caller could hand over a pair that disagree. The title is the
 * one a caller already has; `phaseOf` is still the single thing that reads a
 * number out of it, imported rather than re-spelled.
 *
 * `labels` is **required, with no default** (#1853). An optional field here
 * would let a caller omit it and receive UNPLACED, which is a reading rather
 * than an absence — the same defect `laneHealthLines` records about its own
 * `offBoard` parameter, where a default invented a value the caller already
 * had. Both callers now have to say what they read.
 */
export interface Rankable {
  readonly milestone: string | null;
  readonly number: number;
  readonly labels: readonly string[];
}

/**
 * Which milestone family an issue's phase belongs to — 0 for the engine, 1
 * for everything else.
 *
 * `enginePrefix` is `board.milestonePrefix` from the project's own config —
 * `"Pipeline"` here — and it is **passed in, never read in this module**.
 * `lib/live-issues.ts` already records what happens when two places compile
 * their own `^<prefix> Phase (\d+)` : two deciders, and no behavioural case
 * can tell them apart.
 *
 * **Membership is `inMilestoneFamily`, delegated rather than re-decided.**
 * Round 2 of this PR's review: the first version matched with a bare
 * `milestone.startsWith(enginePrefix)`, which ranks any family whose NAME
 * merely begins with the engine's as the engine — `EngineX Phase 2` under
 * prefix `Engine`, and `Engine Phase 0` under a truncated `Eng`. That is the
 * same pair `lib/live-issues.ts` records as round 2 of #1703, *"the
 * cross-spec contamination the prefix exists to prevent, arriving through
 * the fix for it"* — and this file's docblock cited that one while the code
 * under it reintroduced the bug. Writing a boundary check here instead of
 * calling the existing one would be a THIRD decider of the same question,
 * which is what that file's whole docblock is about.
 *
 * **A `null` prefix ranks every family 0, and that is a reading rather than a
 * default.** A tree that declares no engine milestone family has ONE family,
 * so there is nothing to rank and the order falls back to phase alone —
 * exactly what every consumer did before #1943. It is not
 * `.claude/rules/config-access.md`'s Silent Default Substitution, which is
 * about inventing a value: nothing is invented here, and `placementOf`'s
 * `why` says which of the two readings it took so the distinction reaches
 * the report.
 */
export function familyRank(milestone: string | null, enginePrefix: string | null): number {
  if (enginePrefix === null) return 0;
  return inMilestoneFamily(milestone, enginePrefix) ? 0 : 1;
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

/**
 * The label that makes one issue go next — Jason's call, 2026-11-09 (#1962).
 *
 * **Not a flag.** A flag is exercised once at promotion time and leaves
 * nothing behind, so nobody can later ask why a card jumped the queue. A
 * label is data on the card, visible in the issue's own timeline, and
 * AGENTS.md rule 4 says ordering is data.
 *
 * **It is NOT a member of `LABEL_RANK`, and that is the design.** Top of
 * `LABEL_RANK` would rank it 0 inside the LABEL tier, which still loses to
 * every milestone — and the whole point is to reach the top of the queue
 * past work that outranks it. So it is its own tier, above PHASE.
 */
export const WORK_NEXT_LABEL = "work-this-next";

/** Which source placed an issue — or that nothing did. */
export type PlacementTier = "NEXT" | "PHASE" | "LABEL" | "UNPLACED";

/** What the `work-this-next` label did, and why. */
export type WorkNextStatus = "NONE" | "HONOURED" | "OVER_BOUND" | "UNMEASURED";

export interface WorkNextReading {
  readonly status: WorkNextStatus;
  /** Every issue carrying the label, ascending. Populated in all four states. */
  readonly carrying: readonly number[];
  /** Whose promotion is actually applied. EMPTY unless `HONOURED`. */
  readonly honoured: ReadonlySet<number>;
  /** Ready's depth, the bound. `null` when it could not be read. */
  readonly cap: number | null;
  readonly why: string;
}

/**
 * Whether the `work-this-next` label is honoured, and over how many issues.
 *
 * ## The bound is the whole of the design
 *
 * If every issue carries the label, the label ranks nothing. So the count
 * carrying it is bounded by **Ready's own depth** — `readyCap`, derived from
 * live throughput — rather than by a number somebody typed. A lever with no
 * bound is a lever that has stopped being one, and a typed bound goes stale
 * in both directions the way `READY_TOLERANCE_DAYS` already records.
 *
 * ## It fails toward NOT promoting
 *
 * Over the bound, **nothing is promoted and the issues are named**. Not "the
 * first `cap` of them" — a silent truncation is a promotion nobody chose, and
 * picking which `cap` to honour is exactly the hand-placement this board
 * exists to replace. A card that did not jump the queue costs a cycle; a
 * silent override nobody can audit costs the property the board is for.
 *
 * An unreadable cap is `UNMEASURED` and promotes nothing either, for the same
 * reason — `.claude/rules/config-access.md`, Silent Default Substitution. A
 * depth that could not be read is not a depth of zero and not a depth of
 * infinity, and only one of the three is honest.
 */
export function workNextReading(items: readonly Rankable[], cap: number | null): WorkNextReading {
  const carrying = items
    .filter(i => i.labels.includes(WORK_NEXT_LABEL))
    .map(i => i.number)
    .sort((a, b) => a - b);
  const named = carrying.map(n => `#${n}`).join(", ");
  if (cap === null) {
    return {
      status: "UNMEASURED",
      carrying,
      honoured: new Set(),
      cap,
      why:
        `UNMEASURED — Ready's depth could not be read, so the bound on "${WORK_NEXT_LABEL}" ` +
        `is unknown and NOTHING was promoted` +
        (carrying.length > 0 ? `, including ${named}` : ""),
    };
  }
  if (carrying.length === 0) {
    return {
      status: "NONE",
      carrying,
      honoured: new Set(),
      cap,
      why: `no issue carries "${WORK_NEXT_LABEL}", so the ordinary order stands`,
    };
  }
  if (carrying.length > cap) {
    return {
      status: "OVER_BOUND",
      carrying,
      honoured: new Set(),
      cap,
      why:
        `REFUSED — ${carrying.length} issues carry "${WORK_NEXT_LABEL}" and Ready's depth is ` +
        `${cap}, so the label ranks nothing. NONE of them was promoted: ${named}. ` +
        `Remove the label from ${carrying.length - cap} of them.`,
    };
  }
  return {
    status: "HONOURED",
    carrying,
    honoured: new Set(carrying),
    cap,
    why:
      `${carrying.length} of a bound of ${cap} carry "${WORK_NEXT_LABEL}" and go first: ${named}`,
  };
}

/** Nothing is promoted. The reading a caller that has not taken one must pass. */
export const NO_WORK_NEXT: ReadonlySet<number> = new Set<number>();

export interface Placement {
  readonly tier: PlacementTier;
  /**
   * Which milestone family placed it — `familyRank`, so 0 is the engine
   * (#1943). Compared BEFORE the tier, because a phase number is only
   * meaningful inside its own family.
   *
   * Always 0 outside the PHASE tier: a label and an absence belong to no
   * milestone family, and giving them one would make the family a second
   * ordering over the label tier that nothing declared.
   */
  readonly family: number;
  /** Rank inside the tier. `POSITIVE_INFINITY` for UNPLACED. */
  readonly rank: number;
  readonly why: string;
}

/**
 * NEXT before PHASE before LABEL before UNPLACED.
 *
 * A milestone always beats a label — and `work-this-next` beats the
 * milestone, because an honoured promotion is a person saying *this one, now*
 * about a bounded, auditable number of cards (#1962). Everything below it is
 * unchanged, so an empty promotion set leaves the order exactly as #1853 and
 * #1943 left it.
 */
const TIER_ORDER: Readonly<Record<PlacementTier, number>> = {
  NEXT: 0,
  PHASE: 1,
  LABEL: 2,
  UNPLACED: 3,
};

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
 *
 * ## The promoted set is REQUIRED, with no default (#1962)
 *
 * The same reason `labels` is, one field up: an optional parameter lets a
 * caller omit it and receive an answer it never asked for. Here the honest
 * empty value is `NO_WORK_NEXT`, which promotes nothing — so a caller that
 * has not taken the reading has to say so in its own source, where a census
 * test can see it, rather than inheriting the safe answer by accident.
 */
export function placementOf(
  r: Rankable,
  enginePrefix: string | null,
  honoured: ReadonlySet<number>,
): Placement {
  const phase = phaseOf(r.milestone);
  if (honoured.has(r.number)) {
    // **The promotion reports where the card WOULD have sat**, so the lever
    // is auditable from the report alone: "work-this-next promotes it above
    // every tier — the Engine family places it in phase 6" says both that it
    // jumped and what it jumped. A sentence naming only the label would make
    // the promotion unreviewable after the fact, which is the property that
    // ruled out a flag in the first place.
    //
    // Family and rank are 0 for every promoted card, so promoted cards order
    // among themselves by issue number — the oldest ask goes first. Carrying
    // the underlying family and rank up would compare a phase number against
    // a label rank inside one tier, which is two scales in one expression.
    const base = unpromotedPlacement(r, enginePrefix, phase);
    return {
      tier: "NEXT",
      family: 0,
      rank: 0,
      why: `"${WORK_NEXT_LABEL}" promotes it above every tier — ${base.why}`,
    };
  }
  return unpromotedPlacement(r, enginePrefix, phase);
}

/** Where a card sits with no promotion applied. `placementOf`'s other half. */
function unpromotedPlacement(
  r: Rankable,
  enginePrefix: string | null,
  phase: number | null,
): Placement {
  if (phase !== null) {
    const family = familyRank(r.milestone, enginePrefix);
    return {
      tier: "PHASE",
      family,
      rank: phase,
      // The family is in the sentence because it is in the order. #1943 was
      // found by reading `work-status` output that said *"milestone places
      // it in phase 3"* above one that said *"phase 6"* — both true, and
      // between them they hid the fact that the two numbers were counted in
      // different sequences.
      why:
        enginePrefix === null
          ? `milestone places it in phase ${phase} (no engine family is configured, ` +
            "so phase alone orders this)"
          : family === 0
            ? `the ${enginePrefix} family places it in phase ${phase}`
            : `phase ${phase}, but NOT in the ${enginePrefix} family — the engine ships first, ` +
              "so every engine phase outranks this",
    };
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
      family: 0,
      rank: best.rank,
      why: `no milestone, and "${best.label}" ranks ${best.rank} of ${LABEL_RANK.size}`,
    };
  }
  return {
    tier: "UNPLACED",
    family: 0,
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
export function readyOrderFor(
  enginePrefix: string | null,
  honoured: ReadonlySet<number>,
): (a: Rankable, b: Rankable) => number {
  return (a, b) => {
    const pa = placementOf(a, enginePrefix, honoured);
    const pb = placementOf(b, enginePrefix, honoured);
    // Tier first, unchanged: a milestone is the declared plan and a label is
    // a category, so a milestone still always beats a label.
    if (TIER_ORDER[pa.tier] !== TIER_ORDER[pb.tier]) {
      return TIER_ORDER[pa.tier] - TIER_ORDER[pb.tier];
    }
    // **Then family, INSIDE the tier, and before rank** (#1943). A phase
    // number is only meaningful inside its own family, so comparing
    // `Convergence Phase 3` against `Pipeline Phase 6` on the number alone
    // puts the payload ahead of the engine that ships it.
    //
    // **Above the tier was the first spelling and it was wrong.** `family`
    // is 0 outside the PHASE tier, so hoisting it made every LABEL-tier
    // issue honorary engine: an `external-audit` issue with no milestone
    // outranked `Convergence Phase 3`, which is not engine work beating the
    // payload, it is a category beating a declared plan. The case that
    // caught it is `#1943: a non-engine PHASE still beats a label`, written
    // before the code and red on the first run.
    if (pa.family !== pb.family) return pa.family - pb.family;
    if (pa.rank !== pb.rank) return pa.rank - pb.rank;
    return a.number - b.number;
  };
}

/** How many candidates each source placed. The report's one reading. */
export interface PlacementCensus {
  /** Promoted by `work-this-next` and honoured (#1962). */
  readonly next: number;
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
export function placementCensus(
  items: readonly Rankable[],
  enginePrefix: string | null,
  honoured: ReadonlySet<number>,
): PlacementCensus {
  let next = 0;
  let phase = 0;
  let label = 0;
  let unplaced = 0;
  for (const i of items) {
    const t = placementOf(i, enginePrefix, honoured).tier;
    if (t === "NEXT") next++;
    else if (t === "PHASE") phase++;
    else if (t === "LABEL") label++;
    else unplaced++;
  }
  return { next, phase, label, unplaced };
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

/**
 * One card in the Ready lane, as much of it as the occupancy decision needs.
 *
 * Deliberately not the GraphQL node. The caller reads the board; this module
 * decides. A test that had to build a `ProjectV2Item` to ask a yes/no question
 * would be testing the query.
 */
export interface ReadyCard {
  /** `content.__typename` — `"Issue"`, `"PullRequest"`, or absent for a draft. */
  readonly typename?: string;
  /** `content.state` — `"OPEN"` or `"CLOSED"` for an issue. */
  readonly state?: string;
  /**
   * `content.number`. Absent when the query did not select it, which holds
   * the slot — see {@link holdsReadySlot}.
   */
  readonly number?: number;
}

/**
 * Does this card hold a Ready slot? — #1905.
 *
 * ## The race
 *
 * `board-ready.yml` and `board-flow.yml` both fire on `issues: assigned`.
 * `board-ready` counted the just-assigned card as occupying Ready, concluded
 * the lane was full, and promoted nothing; `board-flow` moved that same card
 * to *In progress* one second later. Measured 2026-11-08: `board-ready` at
 * 13:06:55Z read *"Ready holds 1 of its depth of 1"*, `board-flow` moved
 * #1668 out at 13:06:56Z, and the lane was then empty with nothing queued.
 *
 * ## `movingIssue` is ONE issue number, and that bound is the whole design
 *
 * The caller passes the number of the issue **this event is about** — the
 * card `board-flow` is moving out of Ready in the run racing this one. That
 * single card does not hold its slot. Nothing else is excluded.
 *
 * **The first version of this excluded every assigned open issue**, on the
 * argument that `laneFor` maps `issue_assigned` to `In progress`
 * unconditionally, so such a card is always leaving. Review found the hole
 * and it is a real one: `laneFor` is a pure decision function, not a
 * guarantee the write it feeds ever lands. `scripts/board-flow.ts` gates the
 * write behind `actorMayWrite`, which refuses GitHub's **Triage** role —
 * sufficient to assign an issue, absent from `WRITING_PERMISSIONS` — and the
 * write also fails on an expired token or a GraphQL error, both recorded
 * happening here. A card whose move failed is OPEN, assigned, and still in
 * Ready **forever**; the old predicate excluded it on every later run, so
 * the writer promoted on top of it with nothing bounding the pile. That is
 * the over-the-cap outcome this file says must never happen, and it also
 * re-opened #1852's split: `lib/board-lane-health.ts` kept counting that
 * card, so the writer and the health report disagreed permanently.
 *
 * Keying on the event's own issue number bounds all of it:
 *
 * - **At most one card** is ever excluded, in the one run that races.
 * - **It is self-correcting.** A later run is about a different issue, so a
 *   card whose move failed is counted normally again and the lane reads
 *   over-depth, which `board-lane-health` reports.
 * - **No permanent disagreement.** The health report takes its own reading
 *   with no event, so it excludes nothing; the difference exists only
 *   during the racing run.
 *
 * **The residual, stated rather than hidden:** if `board-flow`'s write
 * fails, the lane ends that run one card over its depth. At the instant
 * this predicate is asked, a successful move and a failed one are
 * indistinguishable — the card is in Ready either way — so one is the floor,
 * not a choice. Bounded and visible beats dry and silent.
 *
 * ## Why not the three options #1905 listed
 *
 * - **Chain `board-ready` on `board-flow`'s completion.** It drops
 *   triggers. `board-ready` fires on five issue events and `board-flow` on
 *   three; a `workflow_run` chain loses `unassigned` and `opened`, both
 *   `--top-up` sources, and its payload carries neither the originating
 *   issue nor the action, so the mode could not be resolved.
 * - **Fold the top-up into `board-flow`.** Works, and couples the move to
 *   the refill for a defect one predicate wide.
 * - **Re-read before concluding FULL.** #1905 rejected it and was right:
 *   it narrows the window instead of closing it.
 *
 * ## The direction this is allowed to be wrong in
 *
 * Toward **holding** the slot, so every uncertain reading holds:
 *
 * - `movingIssue` **absent** excludes nothing. A caller that does not know
 *   which card is moving must not thereby empty the lane.
 * - A card whose **`number`** the query did not select holds it. Absent is
 *   UNMEASURED, never "matches".
 * - A **non-issue** holds it. A pull request parked in Ready takes a slot
 *   exactly as an issue does, and `board-flow` moves no PR on an issue
 *   assignment.
 * - A **closed** issue holds it, because nothing here is a tidier.
 */
export function holdsReadySlot(card: ReadyCard, movingIssue?: number): boolean {
  if (card.typename !== "Issue") return true;
  if (card.state !== "OPEN") return true;
  // **ONE guard for both absences, and the mutation battery is why.** They
  // were two lines — `movingIssue === undefined` and `card.number ===
  // undefined` — and mutating EITHER turned zero cases red, because each
  // was held up by the other through the `!==` below. Two guards answering
  // one question are behaviourally one guard, and no behavioural test can
  // tell them apart.
  //
  // They are not redundant, which is the trap: `undefined !== undefined` is
  // FALSE, so with both removed a card whose number was never selected, in
  // a run that named no mover, frees its slot — and that is every card on
  // the board. One site, and a case that is red when it goes.
  if (movingIssue === undefined || card.number === undefined) return true;
  return card.number !== movingIssue;
}

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
  enginePrefix: string | null,
  honoured: ReadonlySet<number>,
): { readonly promote: readonly T[]; readonly why: string } {
  if (occ.free === 0) {
    // One branch for every reason there is no room — UNMEASURED, FULL and
    // WEDGED each carry their own sentence on the reading itself, so this
    // does not restate them and cannot disagree with them.
    return { promote: [], why: occ.why };
  }
  // A copy, not a sort in place: the caller's array is its own decision
  // record and reordering it changes what its log prints.
  const promote = [...eligible].sort(readyOrderFor(enginePrefix, honoured)).slice(0, occ.free);
  return {
    promote,
    why:
      `${occ.why}; ${eligible.length} eligible, promoting ${promote.length} ` +
      (enginePrefix === null
        ? "in phase then age order"
        : `in ${enginePrefix}-first, then phase, then age order`),
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
