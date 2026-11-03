/**
 * A finding says how big its defect class is, or says it could not tell.
 *
 * #1651 — CRC-N3. *"A finding payload carries the sibling sites it found, or
 * states that it swept and found none."* The issue's own acceptance line, and
 * until this file there was nowhere on a finding to carry it.
 *
 * ## The measurement that motivated it
 *
 * 2026-11-03, PRs #1740, #1747 and #1607 open together: **five pagination
 * findings, every one `medium`, over seven review rounds.** `REVIEW.md`
 * already told the reviewer to name the class and `REVIEW.md` also capped
 * non-blocking findings at three per pull request — so a class of five could
 * not be reported in one round by a *compliant* reviewer. The drip survived
 * perfect judgement, because it was arithmetic.
 *
 * On #1740 the reviewer did name a class — *"three of the script's four
 * GitHub list reads"* — and scoped it to the REST reads it had matched;
 * `timelineItems(first:20)` and `fieldValues(first:20)`, the same property in
 * the same file in GraphQL, arrived as separate findings two and four rounds
 * later. Naming a class narrower than the property is the near-miss this
 * file's `instances` count makes visible.
 *
 * ## Why an absent population is not one
 *
 * A finding with no `population` has not told us it is the only instance; it
 * has told us nothing. Defaulting it to 1 is Silent Default Substitution
 * (`.claude/rules/config-access.md`) at the exact point the reading exists to
 * serve, so `undeclared` is counted and named apart from `declared` and
 * nothing adds the two together.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  AI_REVIEW_FINDING_FIELDS,
  AI_REVIEW_OPTIONAL_FINDING_FIELDS,
} from "../lib/scaffold/ai-review-step";
import {
  AI_REVIEW_BLOCKING_REQUIRED_FIELDS,
  populationReading,
  renderFinding,
} from "../lib/scaffold/ai-review-findings";

const ROOT = join(import.meta.dir, "..");

const f = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  severity: "medium",
  file: "lib/x.ts",
  line: 1,
  summary: "a list read takes one page",
  failure_scenario: "101 rows exist; the tail is dropped",
  ...over,
});

describe("FP-1..FP-6: the reading", () => {
  test("FP-1: a declared population is counted, and its instances summed", () => {
    const r = populationReading([f({ population: 3 }), f({ population: 2 })]);
    expect(r.declared).toBe(2);
    expect(r.undeclared).toBe(0);
    expect(r.instances).toBe(5);
  });

  // The whole point. A finding that never says how many siblings it has is
  // UNMEASURED about its class, and that is a different fact from "one".
  test("FP-2: an absent population is undeclared, never one", () => {
    const r = populationReading([f(), f({ population: 4 })]);
    expect(r.undeclared).toBe(1);
    expect(r.declared).toBe(1);
    // 4, not 5 — the undeclared finding contributes nothing it did not state
    expect(r.instances).toBe(4);
  });

  // `"3"`, `0`, `-1`, `1.5`, `null` and a bare object are all things a model
  // emits. None of them is a population, and reading any of them as one puts
  // a number nobody measured into the count.
  test("FP-3: an unreadable population is undeclared, not coerced", () => {
    for (const bad of [null, 0, -1, 1.5, "3", "many", {}, [], true]) {
      const r = populationReading([f({ population: bad })]);
      expect(r.declared, `population ${JSON.stringify(bad)} was read as a count`).toBe(0);
      expect(r.undeclared).toBe(1);
      expect(r.instances).toBe(0);
    }
  });

  // The positive control for FP-3: the reader does accept the shape the
  // contract asks for, so FP-3 is not green because nothing is ever declared.
  test("FP-4: an integer of one or more is accepted", () => {
    expect(populationReading([f({ population: 1 })]).declared).toBe(1);
    expect(populationReading([f({ population: 97 })]).instances).toBe(97);
  });

  test("FP-5: an empty payload is zero of each, and says nothing about compliance", () => {
    const r = populationReading([]);
    expect(r).toEqual({ declared: 0, undeclared: 0, instances: 0 });
  });

  // A non-object in the array is the shape `renderFinding`'s own docblock
  // says reaches an exported function handed `unknown[]`. It must not throw.
  test("FP-6: a malformed entry is undeclared rather than a crash", () => {
    const r = populationReading(["not a finding", null, 7]);
    expect(r.undeclared).toBe(3);
    expect(r.declared).toBe(0);
  });
});

describe("FP-7..FP-8: the population reaches the annotation", () => {
  // A reading nobody can see from the run is a reading that does not exist.
  test("FP-7: a rendered finding names its class size", () => {
    expect(renderFinding(0, f({ population: 5 }))).toContain("5 instance");
  });

  test("FP-8: a finding with no population renders without inventing one", () => {
    const line = renderFinding(0, f());
    expect(line).not.toContain("instance");
    expect(line).toContain("a list read takes one page");
  });
});

describe("FP-9..FP-11: the contract and the conventions agree", () => {
  // One binding for the field name. A second spelling anywhere is two
  // deciders over one payload key, and a mutation of either leaves the other
  // holding the case up (`.claude/rules/checks-must-be-able-to-fail.md`).
  test("FP-9: the field contract declares population", () => {
    expect(AI_REVIEW_FINDING_FIELDS.population).toBe("population");
  });

  const review = readFileSync(join(ROOT, "REVIEW.md"), "utf-8");

  // The cap is what defeated the class instruction. It has to count the
  // thing the instruction produces — classes — or a compliant reviewer still
  // reports three of five.
  // **This case could not fail when first written**, and the mutation found
  // it: the pattern was `/at most \*\*three\*\* non-blocking .{0,80}classes/is`,
  // and with `s` the `.` crossed into the next clause, which also says
  // "classes". Restoring the old wording left it green. That is a detector
  // wider than the thing it detects — the second shape in
  // `.claude/rules/checks-must-be-able-to-fail.md` — written into the test
  // for the defect it describes, which is why the battery is not optional.
  //
  // It reads the cap SENTENCE alone now, and asserts the counted noun.
  test("FP-10: the cap counts classes, not instances", () => {
    const cap = review.split("\n").find(l => /At most \*\*three\*\*/.test(l)) ?? "";
    expect(cap, "REVIEW.md states no cap at all").not.toBe("");
    expect(cap, `the cap counts the wrong unit: ${cap}`).toContain("classes");
    expect(cap, "the cap must not count findings").not.toMatch(/non-blocking findings/);
    expect(
      review,
      "REVIEW.md must say that a class naming N instances costs one slot",
    ).toMatch(/one slot|a single slot/i);
  });

  // Adding `population` to the contract made it REQUIRED on every blocking
  // finding, because `AI_REVIEW_BLOCKING_REQUIRED_FIELDS` derives the
  // required set from the contract (#1166) — 14 cases went red at once, and
  // that red is the derivation working. The fix subtracts a list declared
  // beside the contract rather than re-listing exclusions in the deriving
  // module, so these three cases hold the arrangement together.
  test("FP-12: population is optional, and nothing else became so", () => {
    expect(AI_REVIEW_OPTIONAL_FINDING_FIELDS).toEqual([AI_REVIEW_FINDING_FIELDS.population]);
    expect(AI_REVIEW_BLOCKING_REQUIRED_FIELDS).not.toContain(
      AI_REVIEW_FINDING_FIELDS.population,
    );
  });

  // Every optional name must be a member of the contract. A typo here would
  // subtract nothing and silently re-require the field.
  test("FP-13: every optional name is a declared contract member", () => {
    const declared = Object.values(AI_REVIEW_FINDING_FIELDS) as string[];
    for (const name of AI_REVIEW_OPTIONAL_FINDING_FIELDS) {
      expect(declared, `"${name}" is optional but is not in the contract`).toContain(name);
    }
  });

  // The required set is still everything else. Asserted as the DERIVED
  // identity rather than as the number 4, so a member added later is
  // required by default and only an explicit entry above can excuse it.
  test("FP-14: the required set is the contract minus severity minus the optional", () => {
    const expected = Object.entries(AI_REVIEW_FINDING_FIELDS)
      .filter(([k]) => k !== "severity")
      .map(([, v]) => v)
      .filter(v => !AI_REVIEW_OPTIONAL_FINDING_FIELDS.includes(v));
    expect([...AI_REVIEW_BLOCKING_REQUIRED_FIELDS]).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  });

  test("FP-11: REVIEW.md tells the reviewer to declare the population", () => {
    expect(review).toContain("population");
    // and names the swept-and-found-none case, which is #1651's acceptance
    // line and the half a reviewer silently skips
    expect(review).toMatch(/swept|found none|only instance/i);
  });
});
