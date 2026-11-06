/**
 * #1817: a measurement typed into a PR body is a second copy nothing compares
 * to its source.
 *
 * The write half of this already exists and is well defended —
 * `scripts/record-suite-measurement.ts` refuses a caller-supplied `--failures`
 * and a caller-supplied `--sha` by name, for exactly this reason. What has
 * never existed is the read half: nothing compares the figure a human or an
 * agent typed into the pull request body against the suite output it came
 * from, so a body saying `1450 pass / 0 fail` over a run that measured
 * `1283 pass / 0 fail` is indistinguishable from a correct one.
 *
 * The rule under test is deliberately the weakest one that still catches
 * that: **the measured figure must appear somewhere among the body's figures
 * of the same kind.** It is not "the body must carry evidence" and it is not
 * "every figure must be current" — a body comparing a before and an after
 * legitimately carries two, and `0 fail` beside `3 fail` is the normal
 * spelling of a fix. What it refuses is a body whose figures of a kind do not
 * include the one that was measured, which is the defect every recorded
 * instance has.
 */
import { describe, expect, test } from "bun:test";

import {
  BODY_EVIDENCE_EXIT,
  bodyEvidenceViolations,
  renderEvidenceBlock,
} from "../lib/body-evidence";
import { readSuiteRun } from "../lib/suite-run-reading";

/** A real bun summary, so the parser under test is the production one. */
const OUTPUT_1283 = `
 1283 pass
 0 fail
 3012 expect() calls
Ran 1283 tests across 214 files. [8.42s]
`;

const OUTPUT_WITH_FAILURE = `
(fail) lib/thing > does the thing
 1282 pass
 1 fail
Ran 1283 tests across 214 files. [8.51s]
`;

const run1283 = readSuiteRun(OUTPUT_1283);
const runFailing = readSuiteRun(OUTPUT_WITH_FAILURE);

describe("#1817: the body's figures are compared to the run they claim to report", () => {
  // AC-1: the defect itself — a figure nobody measured.
  test("AC-1: a pass count absent from the run is a violation naming both numbers", () => {
    const v = bodyEvidenceViolations("Tests: 1450 pass / 0 fail on this branch.", run1283);
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe("pass");
    expect(v[0].measured).toBe(1283);
    expect(v[0].stated).toEqual([1450]);
    // The message has to carry the real number, or the reader cannot act on it.
    expect(v[0].message).toContain("1283");
    expect(v[0].message).toContain("1450");
  });

  // AC-2: the measured figure being PRESENT is what clears it, not being alone.
  test("AC-2: a before/after body clears when the measured figure is among them", () => {
    const body = "Was `3 fail` before the fix, `0 fail` after. 1283 pass.";
    expect(bodyEvidenceViolations(body, run1283)).toEqual([]);
  });

  // AC-3: the direction that matters most — claiming green over a red run.
  test("AC-3: a body claiming 0 fail over a failing run is refused", () => {
    const v = bodyEvidenceViolations("All green: 1282 pass / 0 fail.", runFailing);
    expect(v.map(x => x.kind)).toEqual(["fail"]);
    expect(v[0].measured).toBe(1);
    expect(v[0].stated).toEqual([0]);
  });

  // AC-4: silence is not a violation. This check is about a WRONG figure, not
  // a missing one — a body with no counts in it has made no claim to compare.
  test("AC-4: a body stating no counts produces no violation", () => {
    expect(bodyEvidenceViolations("Refactors the parser. No behaviour change.", run1283)).toEqual(
      [],
    );
  });

  // AC-5: an UNMEASURED run must not silently clear a body full of figures.
  // This is the Silent Default Substitution case from .claude/rules/config-access.md:
  // "no result" and "the result agreed" must not be the same observation.
  test("AC-5: an unmeasured run refuses rather than clearing", () => {
    const unmeasured = readSuiteRun("this output contains no summary at all");
    expect(unmeasured.status).toBe("UNMEASURED");
    const v = bodyEvidenceViolations("1283 pass / 0 fail", unmeasured);
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe("unmeasured");
    expect(v[0].message).toContain("UNMEASURED");
  });

  // AC-10: a body stating one kind and not the other is judged on the kind it
  // stated. This is the only case the per-kind `stated.length === 0` guard
  // decides alone — when BOTH kinds are absent the early return answers
  // first, which is why AC-4 cannot pin this guard and this case can.
  test("AC-10: a body stating only a pass count raises no fail violation", () => {
    const v = bodyEvidenceViolations("1282 pass on this branch.", runFailing);
    expect(v.map(x => x.kind)).toEqual([]);
    const wrong = bodyEvidenceViolations("1450 pass on this branch.", runFailing);
    expect(wrong.map(x => x.kind)).toEqual(["pass"]);
  });

  // AC-9: the pair AC-4 and AC-5 do not pin on their own, and this is the
  // case that separates them. A body stating nothing, over a run that
  // measured nothing, must still be clean — there is no claim to refuse.
  //
  // Written because the mutation battery found AC-4 unkillable: the early
  // return and the per-kind `stated.length === 0` check both hold it up, so
  // mutating either leaves the other answering, which is the "two deciders
  // that agree" shape in .claude/rules/checks-must-be-able-to-fail.md. Only
  // the early return can decide THIS case — the per-kind loop never reaches
  // an UNMEASURED run — so it is the one assertion that makes that guard a
  // single decider rather than half of a redundant pair.
  test("AC-9: an unmeasured run under a body claiming nothing is still clean", () => {
    const unmeasured = readSuiteRun("no summary here either");
    expect(unmeasured.status).toBe("UNMEASURED");
    expect(bodyEvidenceViolations("Docs only. No counts stated.", unmeasured)).toEqual([]);
  });

  // AC-6: the composer and the checker agree by construction. A block this
  // module rendered must never be one it then refuses — otherwise the honest
  // path produces a violation, which is how a guard gets switched off.
  test("AC-6: a rendered block always clears the checker that reads it", () => {
    for (const run of [run1283, runFailing]) {
      expect(bodyEvidenceViolations(renderEvidenceBlock(run), run)).toEqual([]);
    }
  });

  // AC-7: the rendered block carries the numbers rather than describing them.
  test("AC-7: the rendered block states the measured counts", () => {
    const block = renderEvidenceBlock(run1283);
    expect(block).toContain("1283 pass");
    expect(block).toContain("0 fail");
  });

  // AC-8: one exported exit code, exactly once in the script, so the mutation
  // battery in this repo's idiom has a single site to flip.
  test("AC-8: the refusal routes through one exported constant", () => {
    expect(BODY_EVIDENCE_EXIT).toBe(1);
  });
});
