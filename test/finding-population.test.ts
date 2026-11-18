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
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  AI_REVIEW_FINDING_FIELDS,
  AI_REVIEW_OPTIONAL_FINDING_FIELDS,
} from "../lib/scaffold/ai-review-step";
import {
  AI_REVIEW_BLOCKING_REQUIRED_FIELDS,
  AI_REVIEW_POPULATION_TITLE,
  main,
  populationNotice,
  populationReading,
  populationVerdict,
  renderFinding,
  verifiedPopulation,
} from "../lib/scaffold/ai-review-findings";
import { productionSuppression } from "../lib/ai-review-suppression";

const ROOT = join(import.meta.dir, "..");

/**
 * #1883: a cited file whose lines carry `<mark-k>` exactly k times, k = 1..12,
 * so a finding searching `<mark-k>` has a population of k by search. The
 * delimiters keep `<mark-1>` from matching `<mark-10>`.
 */
const MARKED: readonly string[] = Array.from({ length: 12 }, (_, i) => i + 1).flatMap(k =>
  Array.from({ length: k }, () => `const x = read(); // <mark-${k}>`),
);
const READ = (file: string): readonly string[] | null => (file === "lib/x.ts" ? MARKED : null);
/** A finding that declares k and names the search that returns k. */
const sized = (k: number, over: Record<string, unknown> = {}) =>
  f({ population: k, populationSearch: [`<mark-${k}>`], ...over });

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
    const r = populationReading([sized(3), sized(2)], READ);
    expect(r.declared).toBe(2);
    expect(r.undeclared).toBe(0);
    expect(r.instances).toBe(5);
  });

  // The whole point. A finding that never says how many siblings it has is
  // UNMEASURED about its class, and that is a different fact from "one".
  test("FP-2: an absent population is undeclared, never one", () => {
    const r = populationReading([f(), sized(4)], READ);
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
    expect(populationReading([sized(1)], READ).declared).toBe(1);
    expect(populationReading([sized(12)], READ).instances).toBe(12);
  });

  test("FP-5: an empty payload is zero of each, and says nothing about compliance", () => {
    const r = populationReading([]);
    expect(r).toEqual({ declared: 0, undeclared: 0, instances: 0, contradicted: [], unbacked: 0 });
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
    expect(renderFinding(0, sized(5), null, READ)).toContain("5 instance");
  });

  // #1883: the annotation prints the count the search returned, and says the
  // declared number was refused.
  test("FP-7b: a refused declared count renders the search's count and says what was declared", () => {
    const line = renderFinding(0, f({ population: 1, populationSearch: ["<mark-5>"] }), null, READ);
    expect(line).toContain("5 instances of this shape, counted by search; it declared 1");
    // and a declared count with no search renders no class size at all
    expect(renderFinding(0, f({ population: 5 }), null, READ)).not.toContain("instance");
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
  test("FP-12: population and its search are optional, and nothing else became so", () => {
    expect(AI_REVIEW_OPTIONAL_FINDING_FIELDS).toEqual([
      AI_REVIEW_FINDING_FIELDS.population,
      AI_REVIEW_FINDING_FIELDS.populationSearch,
    ]);
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

/**
 * FP-15..FP-19: the reading reaches a real run.
 *
 * Added on review. The first version of this pull request exported
 * `populationReading`, covered it with FP-1..FP-6, and called it from
 * NOWHERE in production — so the aggregate that was supposed to make the
 * class instruction observable was computed only by its own tests. An
 * instrument with no consumer is the precise shape this change exists to
 * fix, written into the fix (`.claude/rules/checks-must-be-able-to-fail.md`,
 * *a detector narrower than what it detects*, arriving as a detector wired
 * to nothing at all).
 *
 * These cases run `main` over a fixture payload, which is the same entry
 * point CI calls, and assert on the ANNOTATION rather than on the function.
 * Deleting the emission while keeping the export turns FP-15 red; that is
 * the mutation that the earlier cases could not see.
 */
describe("FP-15..FP-19: a real run prints the reading", () => {
  let SCRATCH: string;
  let seq = 0;

  beforeAll(() => {
    SCRATCH = mkdtempSync(join(tmpdir(), "finding-population-"));
  });
  afterAll(() => {
    if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
  });

  const run = (findings: Record<string, unknown>[], verdict = "PASS"): string[] => {
    const path = join(SCRATCH, `findings-${seq++}.json`);
    writeFileSync(path, JSON.stringify({ findings, verdict }));
    const written: string[] = [];
    const log = console.log;
    const err = console.error;
    console.log = (...a: unknown[]) => void written.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => void written.push(a.map(String).join(" "));
    try {
      main([path], null, null, READ);
    } finally {
      console.log = log;
      console.error = err;
    }
    return written.join("\n").split("\n").filter(l => l.length > 0);
  };

  const notice = (lines: string[]): string | undefined =>
    lines.find(l => l.includes(AI_REVIEW_POPULATION_TITLE));

  test("FP-15: a run with findings emits the population annotation", () => {
    const lines = run([f({ population: 9 }), f()]);
    const line = notice(lines);
    expect(line, "no run of main printed the population reading").toBeDefined();
    // It is a notice and not a refusal: this decides nothing.
    expect(line).toContain("::notice");
  });

  // Membership, not just the total — the sixth shape. Every number in the
  // reading is named by value, so a sentence that prints a believable but
  // wrong count cannot pass.
  test("FP-16: the annotation names declared, total and instances by value", () => {
    const line = notice(run([sized(9), sized(2), f()]))!;
    expect(line).toContain("2 of 3");
    expect(line).toContain("11");
  });

  test("FP-17: an undeclared finding is reported UNMEASURED, not as one", () => {
    const line = notice(run([f(), f()]))!;
    expect(line).toContain("0 of 2");
    expect(line).toContain("UNMEASURED");
    // and the sentence never claims instances it did not measure
    expect(line).not.toMatch(/covering \d+ instance/);
  });

  test("FP-18: every finding declaring its class leaves nothing UNMEASURED", () => {
    const line = notice(run([sized(4)]))!;
    expect(line).toContain("1 of 1");
    expect(line).toContain("covering 4 instance");
    expect(line).not.toContain("UNMEASURED");
  });

  // The control. An empty payload is a clean review and gets no notice, so
  // the annotation's presence is evidence about findings and not about runs.
  // #1883, at the entry point CI calls: the refusal and the unbacked count are
  // both in the annotation a run prints, by value.
  test("FP-20: a run names the refused finding, and counts by the search", () => {
    const line = notice(run([f(), f({ population: 1, populationSearch: ["<mark-3>"] })]))!;
    expect(line).toContain("Refused: finding(s) 1");
    expect(line).toContain("covering 3 instance");
  });

  test("FP-21: a run says a count with no search behind it is not believed", () => {
    const line = notice(run([f({ population: 4 })]))!;
    expect(line).toContain("0 of 1");
    expect(line).toContain("1 declared a count with no search behind it");
  });

  test("FP-19: a payload with no findings prints no population annotation", () => {
    expect(notice(run([]))).toBeUndefined();
    expect(populationNotice([])).toBeNull();
  });
});

/**
 * #1883: the count is the output of a search the reviewer named, not an
 * integer it chose.
 *
 * On #1877 the reviewer declared `1, 1, 1, —, —, 1, 2, 2, 3` over eleven
 * rounds, every round naming one file, and the next round found another
 * instance of the same class. So a declared number with no search behind it
 * is not believed, and a declared number the search does not return is
 * refused. The search is literal text, run over the cited file's lines.
 */
describe("#1883: a population is counted by a search that ran", () => {
  const THREE = ["const a = listIssues(1);", "const b = 2;", "const c = listIssues(2);", "return listIssues(3);"];

  test("#1883 AC-1: a declared 1 against a file holding three instances is refused, and the search's 3 stands", () => {
    const v = populationVerdict(1, ["listIssues("], THREE);
    expect(v).toEqual({ kind: "contradicted", declared: 1, count: 3 });
    expect(verifiedPopulation(v)).toBe(3);
  });

  test("#1883 AC-1: the same count, declared truly, is measured", () => {
    expect(populationVerdict(3, ["listIssues("], THREE)).toEqual({ kind: "measured", count: 3 });
  });

  test("#1883 AC-1: a search with no declared number is measured by the search alone", () => {
    expect(populationVerdict(undefined, ["listIssues("], THREE)).toEqual({ kind: "measured", count: 3 });
  });

  test("#1883 AC-1: terms are a union over lines, so one class spelled two ways is one count", () => {
    const lines = ["rest.list(a)", "gql(`first:20`)", "other()", "rest.list(b)"];
    expect(populationVerdict(3, ["rest.list(", "first:20"], lines)).toEqual({ kind: "measured", count: 3 });
  });

  test("#1883 AC-2: a declared number with no search is UNMEASURED, never believed", () => {
    const v = populationVerdict(1, undefined, THREE);
    expect(v).toEqual({ kind: "unbacked", declared: 1 });
    expect(verifiedPopulation(v), "an unbacked count reached the reading").toBeNull();
  });

  test("#1883 AC-2: a search that could not run is UNMEASURED, not zero and not one", () => {
    for (const [why, search, lines] of [
      ["unreadable file", ["listIssues("], null],
      ["matches nothing", ["noSuchThing("], THREE],
      ["not a list", "listIssues(", THREE],
      ["empty list", [], THREE],
      ["term too short", ["ab"], THREE],
      ["term spans lines", ["list\nIssues"], THREE],
      ["too many terms", ["aaa", "bbb", "ccc", "ddd", "eee", "fff"], THREE],
      ["a non-string term", [7], THREE],
    ] as const) {
      const v = populationVerdict(1, search, lines as readonly string[] | null);
      expect(v.kind, `${why}: read as ${JSON.stringify(v)}`).toBe("unmeasured");
      expect(verifiedPopulation(v), `${why}: a number reached the reading`).toBeNull();
    }
  });

  test("#1883 AC-2: neither a count nor a search is undeclared", () => {
    expect(populationVerdict(undefined, undefined, THREE)).toEqual({ kind: "undeclared" });
  });

  // The search's count is an oracle over the file it reads, so the reader is
  // held to the real checkout: a symlink the branch commits, pointing out of
  // it, reads as nothing (security review of #1883).
  test("#1883 AC-3: the cited-file reader refuses a symlink out of the checkout, and reads a file in it", () => {
    const dir = mkdtempSync(join(tmpdir(), "finding-population-bound-"));
    try {
      const checkout = join(dir, "checkout");
      const outside = join(dir, "outside");
      mkdirSync(join(checkout, "lib"), { recursive: true });
      mkdirSync(outside);
      writeFileSync(join(outside, "secret.txt"), "token=abc123\n");
      writeFileSync(join(checkout, "lib", "x.ts"), "listIssues(1)\nlistIssues(2)\n");
      symlinkSync(join(outside, "secret.txt"), join(checkout, "lib", "leak.ts"));
      const { linesOf } = productionSuppression(undefined, checkout);
      expect(linesOf("lib/x.ts"), "a real file in the checkout was not read").toEqual(["listIssues(1)", "listIssues(2)", ""]);
      expect(linesOf("lib/leak.ts"), "a symlink out of the checkout was read").toBeNull();
      expect(linesOf("../outside/secret.txt"), "a relative escape was read").toBeNull();
      expect(populationVerdict(undefined, ["token="], linesOf("lib/leak.ts")).kind).toBe("unmeasured");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("#1883 AC-1 MUTANT: with the comparison removed, the planted 1 is no longer refused", async () => {
    const source = readFileSync(join(ROOT, "lib", "scaffold", "ai-review-findings.ts"), "utf-8");
    const COMPARISON = `  if (declared !== null && declared !== count) return { kind: "contradicted", declared, count };\n`;
    expect(source.split(COMPARISON).length - 1, "the comparison is not exactly one line, so the mutant would miss it").toBe(1);
    const dir = mkdtempSync(join(tmpdir(), "finding-population-mutant-"));
    try {
      // The one sibling import is redirected at the real module, as the
      // other batteries over this file do; anything else relative would not load.
      const mutated = source
        .replace(COMPARISON, () => "")
        .replace(/from "\.\/ai-review-step"/g, `from "${join(ROOT, "lib", "scaffold", "ai-review-step")}"`);
      expect(/from "\.\.?\//.test(mutated), "the mutant kept a relative import, so it would not load").toBe(false);
      const path = join(dir, "ai-review-findings.ts");
      writeFileSync(path, mutated);
      const mutant = (await import(path)) as typeof import("../lib/scaffold/ai-review-findings");
      const v = mutant.populationVerdict(1, ["listIssues("], THREE);
      expect(v.kind, "the mutant still refused the planted 1, so it did not remove the comparison").not.toBe("contradicted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
