/**
 * #2057: the one reader of a milestone title's family and phase.
 *
 * `Pipeline Phase 6 — the board's state is a reading` is family `Pipeline`,
 * phase 6. A bare `Phase 2 — x` is family `""`. Anything else is not a phase
 * milestone, and is `null`, never a guess.
 *
 * Four regexes used to read this grammar: `phaseOf` (lib/board-mirror.ts),
 * `phaseInFamily` and `familyOf` (lib/spec-placement.ts), and one in
 * `scripts/status-view.ts`. They disagreed at least four times, each patched
 * one title shape at a time: a double space (round 2 of #1705), a
 * parenthetical `Release (Phase 3)`, a mid-title prefix, and a title saying
 * "Phase" twice (review of #2055). They now all read through this file, and
 * `test/milestone-title.test.ts` holds the census that keeps the phase token
 * spelled here alone.
 */

/**
 * `Phase <number>`, captured: the token every phase grammar in this
 * repository is built from — a milestone title here, a placement-table cell
 * and a spec heading in `lib/spec-placement.ts`. Spelled once, so the
 * grammars cannot disagree about what a phase number is.
 */
export const PHASE_TOKEN = String.raw`Phase (\d+)`;

/**
 * The family is everything before the FIRST ` Phase N`, lazily, so a title
 * that says "Phase" again later (`… starts after Phase 5 ships`) keeps the
 * family it opened with. The family must end in a space before `Phase`: a
 * word ending in `Phase` (`TestPhase 3`) and a parenthetical (`Release
 * (Phase 3)`) are not phase milestones.
 */
const MILESTONE_TITLE = new RegExp(String.raw`^(?:(.+?) )?${PHASE_TOKEN}\b`);

export interface MilestoneTitle {
  /** `Pipeline`, or `""` for a bare `Phase N` title. */
  readonly family: string;
  readonly phase: number;
}

export function readMilestoneTitle(title: string | null | undefined): MilestoneTitle | null {
  const m = MILESTONE_TITLE.exec(title ?? "");
  return m ? { family: m[1] ?? "", phase: Number(m[2]) } : null;
}
