/**
 * Increment 1 of `specs/BOARD-FLOW-SPEC.md`: drive ONE throwaway issue through
 * every lane on REAL events and record what each lane did.
 *
 * ## Why this is an instrument and not a fix
 *
 * The outcome row it moves has no baseline, because nothing in this repository
 * can observe a lane transition. Eight `test/board-*.test.ts` files assert
 * functions against fixtures and **zero** drive a real event. That is how six
 * consecutive faults in the Ready lane were each reported as fixed by somebody
 * reading a diff: #1744, the wrong secret name, #1761, #1765, #1766 and the
 * node-limit refusal in #1768. Four of them exited zero.
 *
 * So this file decides nothing about readiness and repairs nothing. It
 * observes, and it refuses to call an unobserved lane working.
 *
 * ## The two verdicts that are not pass or fail
 *
 * Two lanes have no writer today, and the walk-through ships RED on those rows
 * deliberately — a failing row naming the lane that did not move is worth more
 * than the absence of a test. That needs a verdict that is not "fail", or the
 * suite is red forever and stops being read.
 *
 * It also needs the opposite, and this is the half that is easy to forget:
 * when a row marked `expectedRed` starts PASSING, that is the single most
 * informative reading this instrument can produce — a lane began working and
 * nobody has to be told. `UNEXPECTED_PASS` exists so that event cannot be
 * silently absorbed into a green run. Without it, the day In progress starts
 * working looks exactly like every day before it.
 *
 * ## The bounded wait is not a retry
 *
 * A lane that has not moved inside its wait is a FAILURE. Retrying until it
 * moves converts "the writer is broken" into "the writer is slow", which is
 * the sixth shape in `.claude/rules/checks-must-be-able-to-fail.md`: green on
 * a signal that two different mechanisms produce.
 */

/** The lanes this board has, plus the reading for an item on no board. */
export type Lane =
  | "Backlog"
  | "Ready"
  | "In progress"
  | "In review"
  | "Done"
  | "Cancelled"
  | "(absent)";

export interface Step {
  /** Row number in the spec's Increment 1 table. */
  readonly n: number;
  /** The real event performed, in the words the spec uses. */
  readonly action: string;
  /** The lane the item must be in afterwards. */
  readonly expect: Lane;
  /** What should have performed the move. `null` means nothing exists yet. */
  readonly writer: string | null;
}

/**
 * The six rows of Increment 1, plus the negative control.
 *
 * **The negative control is not optional.** Without row 7 the whole
 * walk-through passes against a board that moves everything to Ready
 * unconditionally — which is a board that lies in the other direction, and
 * an instrument that cannot tell the two apart is measuring nothing.
 */
export const WALKTHROUGH_STEPS: readonly Step[] = [
  { n: 1, action: "create issue A, and issue B blocked by A", expect: "Backlog", writer: "GitHub native" },
  { n: 2, action: "close A", expect: "Ready", writer: "board-ready.yml" },
  { n: 3, action: "B is started", expect: "In progress", writer: null },
  { n: 4, action: "open a PR saying Fixes #B", expect: "In review", writer: "GitHub native" },
  { n: 5, action: "merge the PR", expect: "Done", writer: "GitHub native" },
  { n: 6, action: "close issue C as not_planned", expect: "Cancelled", writer: null },
  { n: 7, action: "NEGATIVE CONTROL — D is blocked by an OPEN issue", expect: "Backlog", writer: "GitHub native" },
];

export type Verdict = "PASS" | "FAIL" | "EXPECTED_RED" | "UNEXPECTED_PASS";

/**
 * What one row's reading means.
 *
 * `writer === null` is the whole of "expected red" — it is derived from the
 * step rather than carried as a second field, so a row cannot claim to be
 * expected-red while naming a writer that is supposed to exist. One fact, one
 * place: the alternative is two fields that can disagree, and the disagreement
 * reads as a tolerated failure.
 */
export function stepVerdict(step: Step, observed: Lane): Verdict {
  const matched = observed === step.expect;
  const hasWriter = step.writer !== null;
  if (matched) return hasWriter ? "PASS" : "UNEXPECTED_PASS";
  return hasWriter ? "FAIL" : "EXPECTED_RED";
}

export interface Reading {
  readonly step: Step;
  readonly observed: Lane;
  readonly verdict: Verdict;
  /** True when the bounded wait expired without the lane reaching `expect`. */
  readonly waitExpired: boolean;
}

/**
 * The run's exit verdict.
 *
 * Only a `FAIL` fails the run. `EXPECTED_RED` is the declared state of a lane
 * with no writer, and failing on it would make the walk-through unmergeable
 * for exactly as long as the gaps it documents remain open — so it would be
 * deleted rather than fixed.
 *
 * An empty reading list REFUSES. Zero rows produce zero failures, and a
 * walk-through that drove nothing must never be the same reading as a
 * walk-through where every lane worked.
 *
 * ## `abortedAt` was added because the refusal above was unreachable
 *
 * The first real dispatch (run `42092949455`) died on `404 POST /issues`
 * and printed a Bun stack trace. The UNMEASURED branch directly above is
 * tested and correct, and nothing in the program could reach it: the throw
 * escaped the driver's `try` and the process ended before any verdict was
 * computed. A case that proves a function refuses proves nothing about
 * whether the program asks it to.
 *
 * An abort is a THIRD state, not a flavour of the first two. Four rows
 * observed and then a throw is a partial measurement, and the verdict says
 * both halves — which act died, and how many rows survived it — because
 * otherwise the next reader has to re-run the whole thing to find out.
 */
export function runVerdict(
  readings: readonly Reading[],
  abortedAt?: string,
): {
  readonly ok: boolean;
  readonly why: string;
} {
  if (abortedAt !== undefined) {
    return {
      ok: false,
      why:
        `UNMEASURED — the run died performing "${abortedAt}". ${readings.length} row(s) ` +
        `were observed before it, and every lane after it is unmeasured rather than working`,
    };
  }
  if (readings.length === 0) {
    return { ok: false, why: "UNMEASURED — no step produced a reading, so nothing was observed" };
  }
  const failed = readings.filter(r => r.verdict === "FAIL");
  if (failed.length > 0) {
    const lanes = failed.map(r => `row ${r.step.n} (${r.step.expect}, writer ${r.step.writer})`);
    return { ok: false, why: `a lane with a writer did not move: ${lanes.join("; ")}` };
  }
  return { ok: true, why: `${readings.length} rows observed, no lane with a writer failed to move` };
}

/**
 * The lines a run prints. Separated from the driver so the report itself can
 * be asserted: a report that omits a row is the failure mode this whole
 * increment exists to catch, and it is invisible if the formatting lives
 * inside the I/O.
 */
export function reportLines(readings: readonly Reading[]): string[] {
  return readings.map(r => {
    const wait = r.waitExpired ? " [bounded wait expired — a failure, not a retry]" : "";
    const writer = r.step.writer ?? "NOTHING WRITES THIS LANE YET";
    return `row ${r.step.n}  ${r.verdict.padEnd(15)} expected ${r.step.expect}, observed ${r.observed} — ${writer}${wait}`;
  });
}
