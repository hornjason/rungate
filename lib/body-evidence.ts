/**
 * Compare the figures in a pull request body against the suite run they claim
 * to report (#1817).
 *
 * ## What this is for
 *
 * A measurement typed into a pull request body is a SECOND COPY of a number
 * that already exists somewhere authoritative, and nothing in this repository
 * compared the two. So the copy goes stale silently: the source is corrected,
 * the body is not, and a reader has no way to tell which of the two is
 * current. Every recorded instance has that shape — a figure read once off a
 * summary, typed into prose, and never compared again.
 *
 * The write half of the problem was solved long ago and is worth reading
 * before changing anything here, because it already refused the two obvious
 * wrong answers: `scripts/record-suite-measurement.ts` has no `--failures`
 * and no `--sha`, by name, because "a caller-supplied count" and "a
 * caller-supplied commit" are both the comparison quietly answering itself.
 * This module is the read half, and it inherits that rule: it never accepts a
 * count as an argument. It accepts the RUN, parsed from the runner's own
 * output by `lib/suite-run-reading.ts`.
 *
 * ## The rule, and why it is the weakest one that works
 *
 *   The measured figure must appear somewhere among the body's figures
 *   of the same kind.
 *
 * Three stronger rules were considered and each is wrong:
 *
 * - *"The body must carry an evidence block."* That is a different issue. A
 *   body making no numeric claim has nothing to be wrong about, so AC-4
 *   pins silence as clean. A check that also demands evidence would be two
 *   deciders in one function and only one of them would be this one.
 * - *"Every figure in the body must be current."* This refuses the normal
 *   spelling of a fix — `3 fail` before, `0 fail` after — and a guard that
 *   fires on correct bodies is a guard people switch off.
 * - *"The figures must match in order/position."* Position is formatting, and
 *   a detector that a reformat defeats is the second shape in
 *   `.claude/rules/checks-must-be-able-to-fail.md`.
 *
 * Presence is what separates them. `1450 pass` over a run that measured 1283
 * is refused because 1283 appears nowhere; `0 fail` beside `3 fail` over a
 * clean run clears because 0 is there.
 *
 * ## The boundary this does not cover, stated rather than implied
 *
 * It reads `pass` and `fail` counts and nothing else. A coverage percentage, a
 * byte count, a round count, a duration — all are the same defect in the same
 * place and none is detected here. They are not a TODO hidden in a comment:
 * widening the detector widens the false-positive surface onto every number in
 * a body, and the counts are the population every recorded instance came from.
 * A new kind should arrive with its own authoritative source to compare
 * against, the way this one has `readSuiteRun`.
 *
 * It also cannot see a figure that is wrong in a way the run agrees with —
 * two runs of the same suite at different commits both measuring 1283 are
 * indistinguishable here. `lib/suite-measurement.ts` binds a count to the SHA
 * it was measured at; that is the guard for currency, and this is the guard
 * for agreement. Neither subsumes the other.
 */
import type { SuiteRun } from "./suite-run-reading";

/**
 * The one non-zero exit for this check.
 *
 * Exported, and the only place the value is written, so a mutation has a
 * single site to flip and no refusal can bypass it by inlining a literal —
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 */
export const BODY_EVIDENCE_EXIT = 1;

/** Which count a violation is about. */
export type EvidenceKind = "pass" | "fail" | "unmeasured";

export interface EvidenceViolation {
  kind: EvidenceKind;
  /** What the run actually measured, or null when there was no reading. */
  measured: number | null;
  /** Every figure of this kind the body stated, in the order it stated them. */
  stated: number[];
  /** A sentence carrying both numbers, because a reader must be able to act on it. */
  message: string;
}

/**
 * The spellings counted as a claim about a count.
 *
 * Deliberately a closed, short list rather than "a number near the word".
 * `fail\b` does not match `failures`, so the suffixes are written out; adding
 * one is a decision about the false-positive surface, not a typo fix.
 */
const PATTERNS: Record<"pass" | "fail", RegExp> = {
  pass: /(\d[\d,]*)\s+pass(?:es|ed|ing)?\b/gi,
  fail: /(\d[\d,]*)\s+fail(?:s|ed|ing|ure|ures)?\b/gi,
};

/** Every figure of one kind stated in the body, in document order. */
export function statedCounts(body: string, kind: "pass" | "fail"): number[] {
  const re = new RegExp(PATTERNS[kind].source, PATTERNS[kind].flags);
  const out: number[] = [];
  for (const m of body.matchAll(re)) {
    const n = Number(m[1].replaceAll(",", ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * The disagreements between a body's figures and the run it reports.
 *
 * THE one decider. Everything else in this module renders or wraps it, so
 * there is a single binding to mutate and no second place that can hold a
 * case up after the first regresses.
 */
export function bodyEvidenceViolations(body: string, run: SuiteRun): EvidenceViolation[] {
  const pass = statedCounts(body, "pass");
  const fail = statedCounts(body, "fail");

  // No claim, nothing to disagree with. This is the one case where silence is
  // genuinely clean rather than merely unmeasured: the body asserts nothing.
  if (pass.length === 0 && fail.length === 0) return [];

  // A body full of figures over a run that produced no reading must NOT clear.
  // "The result agreed" and "there was no result" are different facts, and
  // only one of them is reportable — .claude/rules/config-access.md.
  if (run.status === "UNMEASURED") {
    return [
      {
        kind: "unmeasured",
        measured: null,
        stated: [...pass, ...fail],
        message:
          `the body states ${pass.length + fail.length} count(s) but the run is ` +
          `UNMEASURED (${run.reason}), so there is nothing to compare them against. ` +
          `A body cannot be cleared by a reading that was never taken.`,
      },
    ];
  }

  const out: EvidenceViolation[] = [];
  for (const [kind, stated, measured] of [
    ["pass", pass, run.pass],
    ["fail", fail, run.fail],
  ] as const) {
    if (stated.length === 0) continue;
    if (stated.includes(measured)) continue;
    out.push({
      kind,
      measured,
      stated,
      message:
        `the body states ${stated.join(", ")} ${kind}, and the run measured ` +
        `${measured} ${kind}. The measured figure appears nowhere in the body, so ` +
        `every ${kind} count in it is a second copy of a number nothing agrees with. ` +
        `Quote the run, or re-run and quote that.`,
    });
  }
  return out;
}

/**
 * The evidence block to paste, composed from the run rather than typed.
 *
 * A block this renders must always clear `bodyEvidenceViolations` against the
 * same run — asserted, not assumed, because an honest path that produces a
 * violation is how a guard gets disabled.
 */
export function renderEvidenceBlock(run: SuiteRun): string {
  if (run.status === "UNMEASURED") {
    // The reason is NOT interpolated, and that is the whole of #1819's second
    // finding. `readSuiteRun` builds an unmeasured reason that quotes the
    // runner's last output, so the reason is attacker-shaped free text — and
    // an input as ordinary as `some harness note: 0 failing checks so far`
    // produces an UNMEASURED run whose reason contains `0 failing`. Embedding
    // it here put a figure-shaped phrase inside a block destined for a pull
    // request body, and `bodyEvidenceViolations` then refused the block its
    // own renderer had just written.
    //
    // Measured before the fix: violations 1, kind `unmeasured`. The composer
    // and the checker disagreed about a block neither a human nor an agent
    // had touched, which is the precise way an honest path teaches people to
    // ignore a guard.
    //
    // The reason is not lost — `scripts/body-evidence.ts` prints it on
    // stderr, where it is a diagnostic rather than a claim. A block that goes
    // into a body may only contain text this module controls.
    return (
      "**Suite: UNMEASURED** — the run reported no result, so no count is quoted here. " +
      "This is a run that measured nothing, not a run that found nothing wrong. " +
      "The runner's reason is on stderr; it is kept out of this block because a " +
      "free-text reason can contain a figure-shaped phrase, and a block carrying one " +
      "is a block this module's own checker would refuse."
    );
  }
  const parts = [`${run.pass} pass`, `${run.fail} fail`];
  if (run.tests !== null) parts.push(`${run.tests} tests`);
  if (run.files !== null) parts.push(`${run.files} files`);
  const named =
    run.failingTests.length > 0
      ? `\n\nFailing:\n${run.failingTests.map(t => `- \`${t}\``).join("\n")}`
      : "";
  return `**Suite:** ${parts.join(" · ")}${named}`;
}
