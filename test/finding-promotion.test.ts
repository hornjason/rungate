/**
 * Covers SC-2612 (SPEC-TO-BOARD-PIPELINE-SPEC.md) — #1678.
 *
 * ## What this is for
 *
 * 22 open issues carried no criterion on 2026-10-29 and 20 of them were
 * labelled `follow-up` or `external-audit`. Nothing turned one into a
 * criterion, so the backlog could only grow in that direction:
 * `criterion-inventory` reported them as serving nothing, and serving
 * nothing is not a state anything drains.
 *
 * `promote` is the drain. The property every case below asserts is the one
 * that makes it safe to point at a backlog:
 *
 * **It refuses rather than guesses, and the refusal is named.**
 *
 * ## What is deliberately NOT tested here, because it is not in the module
 *
 * Whether a finding is real work. That judgement is the caller's — see the
 * module docblock — so there is no case asserting `promote` identified a
 * good one. A case like that would be asserting a value the test itself
 * supplied, the third shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  bodyWithDecline,
  decline,
  declineViolations,
  promote,
  promotionStatement,
  promotionViolations,
  specPath,
  withCriterionLinked,
  DECLINE_REFUSALS,
  PROMOTION_REFUSALS,
  STATEMENT_FIELD_NAMES,
  type DeclineInput,
  type DeclineRefusal,
  type PromotionInput,
} from "../lib/finding-promotion";
import { NAMES_NONE, criterionAnswer } from "../lib/board-mirror";
import { ISSUE_SECTIONS, headingFor, headingOccurrencesOf, missingSections } from "../lib/issue-shape";
import { buildScRegistry } from "../lib/sc-ids";

const SOURCE = join(import.meta.dir, "..", "lib", "finding-promotion.ts");

const SPEC_WITH_CRITERIA = `---
doc-type: spec
testable: true
governs: a fixture
---

# A Fixture Spec

## Success Criteria

- [ ] SC-9001: lib/fixture.ts contains [alpha] — the fixture states something
- [x] SC-9002: lib/fixture.ts contains [beta] — and something else
`;

const SPEC_NO_CRITERIA = `---
doc-type: spec
testable: false
governs: a fixture that states none
---

# States None

This spec deliberately declares no criteria.
`;

/** A project root with one spec in it. Caller removes it. */
function scratch(specText: string, name = "FIXTURE-SPEC.md"): string {
  const root = mkdtempSync(join(tmpdir(), "rg-1678-promote-"));
  mkdirSync(join(root, "specs"), { recursive: true });
  writeFileSync(join(root, "specs", name), specText);
  return root;
}

const ISSUE = { number: 4242, title: "A finding that names real work", body: "No criterion here." };

function inputFor(root: string, over: Partial<PromotionInput> = {}): PromotionInput {
  return {
    issue: ISSUE,
    spec: "specs/FIXTURE-SPEC.md",
    outcome: "the thing the finding named becomes checkable",
    symbol: "promote",
    module: "lib/finding-promotion.ts",
    projectRoot: root,
    owner: null,
    ...over,
  };
}

const REGISTRY = buildScRegistry([]);

describe("SC-2612 / AC-1 (#1678): a promotable finding becomes a criterion", () => {
  test("the one case that must SUCCEED, so the refusals below are not vacuous", () => {
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      const out = promote(inputFor(root), REGISTRY);
      expect(out.promoted).toBe(true);
      if (!out.promoted) return;
      expect(out.issue).toBe(4242);
      expect(out.spec).toBe("specs/FIXTURE-SPEC.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the line is in the form sync-sc-status matches, not prose", () => {
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      const out = promote(inputFor(root), REGISTRY);
      expect(out.promoted).toBe(true);
      if (!out.promoted) return;
      // `contains [symbol]` is the whole matchable part. A criterion written
      // any other way is one nothing can ever tick.
      expect(out.line).toContain("contains [promote]");
      expect(out.line).toStartWith("- [ ] SC-");
      expect(out.line).toContain("the thing the finding named becomes checkable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the id clears the ids the spec already states", () => {
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      const out = promote(inputFor(root), REGISTRY);
      expect(out.promoted).toBe(true);
      if (!out.promoted) return;
      const n = Number(out.id.replace("SC-", ""));
      // SC-9002 is the highest in the fixture. An allocator handing back
      // 9001 or 9002 would collide with a criterion sitting in the same file.
      expect(n).toBeGreaterThan(9002);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("SC-2612 / AC-2 (#1678): every refusal is named, and none is a guess", () => {
  test("a spec that is not in the tree refuses SPEC_ABSENT", () => {
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      const out = promote(inputFor(root, { spec: "specs/NOT-HERE-SPEC.md" }), REGISTRY);
      expect(out.promoted).toBe(false);
      if (out.promoted) return;
      expect(out.refusal).toBe("SPEC_ABSENT");
      expect(out.why).toContain("NOT-HERE-SPEC.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a tree whose sweep could not be taken refuses SWEEP_UNMEASURED, not 'no criteria'", () => {
    // This case used to assert SPEC_STATES_NO_CRITERIA and PASSED — for the
    // wrong reason. `specCriteriaIn` answers UNMEASURED with `specs: []`, so
    // the lookup below it found nothing and the "no criteria" branch fired
    // on a tree nobody had successfully read. Two different facts, one
    // message. Found by the AI review of 4d48c7a3; probed directly before
    // changing anything, and the probe is what this case now holds:
    //   reading UNMEASURED, specs 0, ids 0,
    //   reasons ["no spec under …/specs states a criterion, so no cell could be filled"]
    const root = scratch(SPEC_NO_CRITERIA);
    try {
      const out = promote(inputFor(root), REGISTRY);
      expect(out.promoted).toBe(false);
      if (out.promoted) return;
      expect(out.refusal).toBe("SWEEP_UNMEASURED");
      expect(out.why).toContain("states a criterion");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a MEASURED sweep where the target contributes nothing refuses SPEC_STATES_NO_CRITERIA", () => {
    // The state the case above was mistaken for, and the only one that can
    // distinguish the two: another spec DOES state criteria, so the sweep is
    // MEASURED, and the target still has none of its own.
    const root = scratch(SPEC_NO_CRITERIA, "EMPTY-SPEC.md");
    try {
      writeFileSync(join(root, "specs", "FULL-SPEC.md"), SPEC_WITH_CRITERIA);
      const out = promote(inputFor(root, { spec: "specs/EMPTY-SPEC.md" }), REGISTRY);
      expect(out.promoted).toBe(false);
      if (out.promoted) return;
      expect(out.refusal).toBe("SPEC_STATES_NO_CRITERIA");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a spec that exists and cannot be read refuses SPEC_UNREADABLE, not an uncaught throw", () => {
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      // A directory where the file was: `existsSync` is true and
      // `readFileSync` throws EISDIR. The guard in `promotionViolations`
      // cannot see this, which is the point — "exists" and "readable" are
      // different readings, and a docblock promising fail-closed has to mean
      // it for the second one too.
      rmSync(join(root, "specs", "FIXTURE-SPEC.md"));
      mkdirSync(join(root, "specs", "FIXTURE-SPEC.md"));
      writeFileSync(join(root, "specs", "OTHER-SPEC.md"), SPEC_WITH_CRITERIA);
      const out = promote(inputFor(root), REGISTRY);
      expect(out.promoted).toBe(false);
      if (out.promoted) return;
      expect(out.refusal).toBe("SPEC_UNREADABLE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an issue that already serves a criterion refuses ALREADY_SERVES", () => {
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      const serving = { number: 77, title: "Work on SC-9001", body: "This serves SC-9001." };
      const out = promote(inputFor(root, { issue: serving }), REGISTRY);
      expect(out.promoted).toBe(false);
      if (out.promoted) return;
      expect(out.refusal).toBe("ALREADY_SERVES");
      expect(out.why).toContain("SC-9001");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * ## Swept, not enumerated
   *
   * Three `if` blocks and three test cases is how `module` ended up
   * unguarded while `outcome` and `symbol` both had a refusal: the two
   * named in review were repaired and the sibling was left, and no
   * behavioural case could tell, because each case only knows about the
   * field it was written for.
   *
   * So the population is the subject. `STATEMENT_FIELD_NAMES` is what
   * `promotionStatement` interpolates, the cases are derived from it, and a
   * fourth field added without a guard is red here.
   */
  test("EVERY field the statement interpolates refuses when empty — swept, not listed", () => {
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      // Guard the guard: a sweep over an empty or shrunken list passes
      // vacuously, which is the third shape in checks-must-be-able-to-fail.
      expect(STATEMENT_FIELD_NAMES.length).toBe(3);
      expect([...STATEMENT_FIELD_NAMES].sort()).toEqual(["module", "outcome", "symbol"]);

      for (const field of STATEMENT_FIELD_NAMES) {
        const out = promote(inputFor(root, { [field]: "   " }), REGISTRY);
        expect(out.promoted, `an empty ${field} must refuse`).toBe(false);
        if (out.promoted) continue;
        // Named for the field, not a generic "bad input" — a caller has to
        // know WHICH one to supply.
        expect(out.refusal, `the refusal for an empty ${field}`).toBe(
          `NO_${field.toUpperCase()}` as typeof out.refusal,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("every field named in the statement's text is one the sweep covers", () => {
    // The other direction. A field interpolated into the statement but
    // absent from the list is exactly the `module` defect, and without this
    // the sweep above stays green while a new hole opens beside it.
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      const s = promotionStatement(
        inputFor(root, { outcome: "OUTCOME_X", symbol: "SYMBOL_X", module: "MODULE_X" }),
      );
      // Every placeholder appears, so the statement interpolates exactly
      // these three and nothing the sweep cannot see.
      for (const marker of ["OUTCOME_X", "SYMBOL_X", "MODULE_X"]) expect(s).toContain(marker);
      expect(s.replace("OUTCOME_X", "").replace("SYMBOL_X", "").replace("MODULE_X", "")).toBe(
        " contains [] — ",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a newline in the caller's text refuses MALFORMED_STATEMENT", () => {
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      // The payload that makes this a defect rather than a tidiness rule: a
      // SECOND line, already ticked, in the file that is this repository's
      // record of what has been proved.
      const forged = "a real-looking outcome\n- [x] SC-9999: a criterion nobody wrote";
      const out = promote(inputFor(root, { outcome: forged }), REGISTRY);
      expect(out.promoted).toBe(false);
      if (out.promoted) return;
      expect(out.refusal).toBe("MALFORMED_STATEMENT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a carriage return is refused too, not just a newline", () => {
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      const out = promote(inputFor(root, { symbol: "promote\r- [x] SC-9999: forged" }), REGISTRY);
      expect(out.promoted).toBe(false);
      if (out.promoted) return;
      expect(out.refusal).toBe("MALFORMED_STATEMENT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a spec resolving outside specs/ refuses SPEC_OUTSIDE_TREE", () => {
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      const out = promote(inputFor(root, { spec: "../outside/FIXTURE-SPEC.md" }), REGISTRY);
      expect(out.promoted).toBe(false);
      if (out.promoted) return;
      // Named for what it is. Reporting it as SPEC_ABSENT would send the
      // caller looking for a file they would then create in the wrong place.
      expect(out.refusal).toBe("SPEC_OUTSIDE_TREE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the lib validates the path the CLI writes, for an absolute --spec too", () => {
    const root = scratch(SPEC_WITH_CRITERIA);
    const elsewhere = scratch(SPEC_WITH_CRITERIA);
    try {
      // `specPath` is exported and `scripts/finding-promotion.ts` calls it, so
      // there is no second resolution that could disagree. The regression it
      // closes: the lib honoured an absolute path while the CLI did
      // `join(ROOT, spec)`, so the file checked and the file written differed.
      const absolute = join(elsewhere, "specs", "FIXTURE-SPEC.md");
      expect(specPath({ spec: absolute, projectRoot: root })).toBe(absolute);
      const out = promote(inputFor(root, { spec: absolute }), REGISTRY);
      expect(out.promoted).toBe(false);
      if (out.promoted) return;
      expect(out.refusal).toBe("SPEC_OUTSIDE_TREE");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("an issue serving a criterion in ANOTHER spec still refuses ALREADY_SERVES", () => {
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      // The narrow version of this check read only the TARGET spec's ids, so
      // an issue serving spec A promoted into spec B unopposed — producing
      // exactly the two-criteria outcome the refusal says it prevents.
      writeFileSync(
        join(root, "specs", "OTHER-SPEC.md"),
        SPEC_WITH_CRITERIA.replace("SC-9001", "SC-9501").replace("SC-9002", "SC-9502"),
      );
      const serving = { number: 78, title: "Work on SC-9501", body: "Serves SC-9501." };
      const out = promote(inputFor(root, { issue: serving }), REGISTRY);
      expect(out.promoted).toBe(false);
      if (out.promoted) return;
      expect(out.refusal).toBe("ALREADY_SERVES");
      expect(out.why).toContain("SC-9501");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an issue naming a COLLIDED criterion still refuses ALREADY_SERVES", () => {
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      // Two specs state SC-9001, so `specCriteriaIn` drops it from `ids` and
      // reports it under `collisions` — correct for the board, which has to
      // pick one spec to attribute to. Wrong for this question: an issue
      // naming SC-9001 serves a criterion whichever spec it meant, and
      // reading only `ids` let exactly those issues through.
      writeFileSync(join(root, "specs", "TWIN-SPEC.md"), SPEC_WITH_CRITERIA);
      // A third, unambiguous spec keeps the sweep MEASURED — with only the
      // two twins, every id collides and the sweep is UNMEASURED, so this
      // case would pass on SWEEP_UNMEASURED and witness nothing.
      writeFileSync(
        join(root, "specs", "SOLO-SPEC.md"),
        SPEC_WITH_CRITERIA.replace("SC-9001", "SC-9801").replace("SC-9002", "SC-9802"),
      );
      const serving = { number: 79, title: "Work on SC-9001", body: "Serves SC-9001." };
      const out = promote(inputFor(root, { spec: "specs/SOLO-SPEC.md", issue: serving }), REGISTRY);
      expect(out.promoted).toBe(false);
      if (out.promoted) return;
      expect(out.refusal).toBe("ALREADY_SERVES");
      expect(out.why).toContain("SC-9001");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("every refusal in the closed set is reachable, so none is decorative", () => {
    // Two are raised by `promote` rather than `promotionViolations` — the
    // allocator's refusal and the unreadable read — and each has its own
    // case above. Named here so this assertion stays an equality over the
    // whole closed set rather than quietly shrinking to the easy members.
    const reached = new Set<string>(["ID_UNAVAILABLE"]);
    const root = scratch(SPEC_WITH_CRITERIA);
    const noCriteria = scratch(SPEC_NO_CRITERIA);
    const measuredEmpty = scratch(SPEC_NO_CRITERIA, "EMPTY-SPEC.md");
    writeFileSync(join(measuredEmpty, "specs", "FULL-SPEC.md"), SPEC_WITH_CRITERIA);
    try {
      for (const over of [
        { spec: "../outside/NOPE-SPEC.md" },
        { spec: "specs/NOT-HERE-SPEC.md" },
        { outcome: "" },
        { symbol: "" },
        { module: "" },
        { outcome: "fine\n- [x] SC-9999: forged" },
        { issue: { number: 77, title: "SC-9001", body: "" } },
        { issue: { number: 77, title: "t", body: "## Criteria this serves\n\n## Criteria this serves\n" } },
      ] as Partial<PromotionInput>[]) {
        for (const v of promotionViolations(inputFor(root, over))) reached.add(v.refusal);
      }
      // A directory where the spec should be: exists, unreadable.
      const unreadable = scratch(SPEC_WITH_CRITERIA);
      rmSync(join(unreadable, "specs", "FIXTURE-SPEC.md"));
      mkdirSync(join(unreadable, "specs", "FIXTURE-SPEC.md"));
      for (const v of promotionViolations(inputFor(unreadable))) reached.add(v.refusal);
      rmSync(unreadable, { recursive: true, force: true });
      // #2060: the module already contains the symbol.
      const defined = scratch(SPEC_WITH_CRITERIA);
      mkdirSync(join(defined, "lib"), { recursive: true });
      writeFileSync(join(defined, "lib", "finding-promotion.ts"), "export function promote() {}\n");
      for (const v of promotionViolations(inputFor(defined))) reached.add(v.refusal);
      rmSync(defined, { recursive: true, force: true });
      for (const v of promotionViolations(inputFor(noCriteria))) reached.add(v.refusal);
      for (const v of promotionViolations(inputFor(measuredEmpty, { spec: "specs/EMPTY-SPEC.md" }))) {
        reached.add(v.refusal);
      }

      expect([...reached].sort()).toEqual([...PROMOTION_REFUSALS].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(noCriteria, { recursive: true, force: true });
      rmSync(measuredEmpty, { recursive: true, force: true });
    }
  });

  test("an unreadable reservation store refuses ID_UNAVAILABLE rather than inventing an id", () => {
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      mkdirSync(join(root, "specs"), { recursive: true });
      // Present and unparseable. `lib/sc-reservations.ts` calls that a
      // refusal, not an empty store, and handing out a floor computed
      // without it is how two branches take the same id.
      writeFileSync(join(root, "specs", "sc-reservations.json"), "{ not json");
      const out = promote(inputFor(root), REGISTRY);
      expect(out.promoted).toBe(false);
      if (out.promoted) return;
      expect(out.refusal).toBe("ID_UNAVAILABLE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("SC-2612 / AC-3 (#1678): the module does not answer a question board-mirror already answers", () => {
  const source = readFileSync(SOURCE, "utf8");

  test("'does this issue serve a criterion' is imported, never reimplemented", () => {
    // Two deciders over one question are behaviourally ONE decider with a
    // dead half nobody can identify — the fourth shape in
    // `.claude/rules/checks-must-be-able-to-fail.md`, and the defect this
    // repository hits most often.
    expect(source).toContain("criteriaNamedBy");
    expect(source).toContain('from "./board-mirror"');
    // The spellings a reimplementation would need. Their absence is the claim.
    expect(source).not.toContain("declaresOwnCriterion(");
    expect(source).not.toMatch(/SC-\\\\d|\[Ss\]C-\[0-9\]/);
  });

  test("every read of the target spec is guarded, across BOTH files", () => {
    // Three reads: two in the lib, one in the CLI. The first version guarded
    // the two a reviewer named and left the third, which is the same
    // two-of-three as the statement fields. So the assertion is over the
    // POPULATION — a fourth read added bare is red here, in whichever file
    // it lands.
    const cli = readFileSync(join(import.meta.dir, "..", "scripts", "finding-promotion.ts"), "utf8");
    const sites: { where: string; text: string }[] = [
      { where: "lib/finding-promotion.ts", text: source },
      { where: "scripts/finding-promotion.ts", text: cli },
    ];

    let reads = 0;
    for (const { where, text } of sites) {
      for (const m of text.matchAll(/readFileSync\(/g)) {
        reads += 1;
        // The 240 characters before the call. A guarded read has `try {`
        // inside that window; a bare one does not.
        const before = text.slice(Math.max(0, m.index - 240), m.index);
        expect(before, `the readFileSync at ${where}:${m.index} is not inside a try`).toContain(
          "try {",
        );
      }
    }
    // Vacuity guard: if a refactor removes every read, the loop above
    // asserts nothing and passes. Four since #2060: the three reads of the
    // target spec, and the read of the module SYMBOL_EXISTS checks.
    expect(reads).toBe(4);
  });

  test("the registry parameter has no default, so the compiler catches every call site", () => {
    const sig = source.slice(source.indexOf("export function promote("));
    const params = sig.slice(0, sig.indexOf("): Promotion"));
    expect(params).toContain("registry: ScRegistry");
    expect(/registry\s*:[^,)]*=/.test(params)).toBe(false);
  });
});

describe("SC-2612 / AC-4 (#1678): the refusals are proved able to fail", () => {
  /**
   * ## One binding, mutated
   *
   * `promote` adds no condition of its own — every refusal comes from
   * `promotionViolations`. So the mutant short-circuits that one function to
   * `return []` and the SAME inputs that refuse against the real module must
   * promote against the mutant.
   *
   * Without this half, a refusing case that passes because the fixture was
   * malformed, or because an import threw, is indistinguishable from one
   * that observed the guard.
   *
   * One `mkdtemp` directory per copy: Bun caches a directory's listing on
   * first read, so a second module written into a directory already imported
   * from is not found, and a mutant that fails to load reads as a refusal.
   */
  const BINDING = "export function promotionViolations(input: PromotionInput): PromotionViolation[] {";

  async function mutantModule(parent: string) {
    const source = readFileSync(SOURCE, "utf8");
    expect(source).toContain(BINDING);
    // Relative imports resolve from the real lib/, so the copy sits beside it
    // rather than in /tmp — a mutant that dies on module resolution reads as
    // a refusal on the merits.
    let text = source.replace(BINDING, `${BINDING}\n  return [];`);
    expect(text).not.toBe(source);

    // The copy sits ONE directory below `lib/`, so every `./sibling` in it
    // would resolve inside the scratch dir and die on resolution — which
    // reads as a refusal and makes this battery green while witnessing
    // nothing. Re-point them, and assert the rewrite actually fired so a
    // later import style cannot silently reintroduce the failure.
    const before = text;
    text = text.replace(/from "\.\//g, 'from "../');
    expect(text).not.toBe(before);
    expect(text).not.toMatch(/from "\.\/[^."]/);
    const path = join(parent, "finding-promotion-mutant.ts");
    writeFileSync(path, text);
    return (await import(path)) as typeof import("../lib/finding-promotion");
  }

  test("every refusing input promotes against a mutant with the binding emptied", async () => {
    const libDir = join(import.meta.dir, "..", "lib");
    const mutantDir = mkdtempSync(join(libDir, "tmp-1678-mutant-"));
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      const refusing: Partial<PromotionInput>[] = [
        { outcome: "" },
        { symbol: "" },
        { issue: { number: 77, title: "SC-9001", body: "" } },
        // The forgery. Included because MALFORMED_STATEMENT is the guard with
        // the worst failure mode — a ticked criterion nobody wrote, appended
        // to the file this repository treats as its record of proof — so it
        // is the one that most needs to be observed rather than assumed.
        { outcome: "fine\n- [x] SC-9999: a criterion nobody wrote" },
      ];

      // The real module FIRST. A mutant read before its baseline is a reading
      // with nothing to compare against.
      for (const over of refusing) {
        expect(promote(inputFor(root, over), REGISTRY).promoted).toBe(false);
      }

      const mutant = await mutantModule(mutantDir);
      let promotedByMutant = 0;
      for (const over of refusing) {
        if (mutant.promote(inputFor(root, over), REGISTRY).promoted) promotedByMutant += 1;
      }

      // Predicted 4 of 4: emptying the binding removes the only thing that
      // can refuse these, and none of them is blocked by anything else.
      // Membership, not just the total — the forged one promoting is the
      // specific observation that makes MALFORMED_STATEMENT a real guard.
      expect(promotedByMutant).toBe(4);
      const forgedThroughMutant = mutant.promote(
        inputFor(root, { outcome: "fine\n- [x] SC-9999: a criterion nobody wrote" }),
        REGISTRY,
      );
      expect(forgedThroughMutant.promoted).toBe(true);
      if (!forgedThroughMutant.promoted) return;
      expect(forgedThroughMutant.line).toContain("- [x] SC-9999");
    } finally {
      rmSync(mutantDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("SC-2612 / AC-6 (#1678): the CLI refuses a bad flag by NAME, for every flag", () => {
  /**
   * ## The population the earlier sweep missed
   *
   * AC-3 sweeps `STATEMENT_FIELD_NAMES` — the fields the LIBRARY interpolates.
   * `--issue` is not one of them, so it had no named refusal while
   * `outcome`, `symbol` and `module` all did, and review found it in round
   * five as the fifth instance of one class: the named instance repaired,
   * its siblings left.
   *
   * So the subject here is the CLI's whole required-flag set, derived from
   * the script's own `required(...)` calls rather than typed out, and a
   * sixth flag added without a refusal is red.
   */
  const CLI = join(import.meta.dir, "..", "scripts", "finding-promotion.ts");

  /** Every flag the script marks required, read from the script. */
  const requiredFlags = [
    ...new Set(
      [...readFileSync(CLI, "utf8").matchAll(/required(?:PositiveInt)?\("([a-z-]+)"\)/g)].map(
        m => m[1]!,
      ),
    ),
  ];

  function run(argv: string[]): { code: number; err: string } {
    const p = Bun.spawnSync(["bun", CLI, ...argv], { cwd: join(import.meta.dir, "..") });
    return { code: p.exitCode ?? -1, err: new TextDecoder().decode(p.stderr) };
  }

  test("the flag set was read, not assumed", () => {
    // A regex that matched nothing would make every case below vacuous.
    expect([...requiredFlags].sort()).toEqual([
      "declines",
      "issue",
      "module",
      "outcome",
      "spec",
      "symbol",
    ]);
  });

  /**
   * A complete, well-formed command line PER MODE. One flag is corrupted per
   * case, and every other flag in that mode is valid, so the refusal can
   * only be about the one under test.
   *
   * Two tables rather than one since #1940, because the script has two
   * outcomes and `--declines` switches between them. Merging them would be
   * worse than untidy: a single table carrying `--declines` would put every
   * promote case on the DECLINE path, where `--spec`, `--outcome`,
   * `--symbol` and `--module` are not read at all — four of six cases
   * passing a sweep that never reached the flag they name.
   */
  const MODES: Record<string, Record<string, string>> = {
    promote: {
      issue: "1678",
      spec: "specs/SPEC-TO-BOARD-PIPELINE-SPEC.md",
      symbol: "promote",
      module: "lib/finding-promotion.ts",
      outcome: "an outcome",
    },
    decline: {
      issue: "1678",
      declines: "a reason nobody has to take on trust",
    },
  };

  /** Every flag must be swept by the mode that actually reads it. */
  test("the two mode tables between them cover every required flag", () => {
    const covered = new Set(Object.values(MODES).flatMap(m => Object.keys(m)));
    expect([...requiredFlags].filter(f => !covered.has(f))).toEqual([]);
  });

  test("EVERY required flag refuses by name when its value is the next flag", () => {
    let swept = 0;
    for (const [mode, valid] of Object.entries(MODES)) {
      for (const flag of Object.keys(valid)) {
        // The first version of this corrupted one flag and omitted the rest,
        // and `--issue is required` answered every case — four of five
        // passing for a reason that had nothing to do with the flag.
        const argv = Object.entries(valid).flatMap(([k, v]) => [
          `--${k}`,
          k === flag ? "--write" : v,
        ]);
        const { code, err } = run(argv);
        expect(code, `[${mode}] --${flag} with a flag as its value must refuse`).toBe(1);
        expect(err, `[${mode}] the refusal for --${flag} must name it`).toContain(`--${flag}`);
        expect(err, `[${mode}] the refusal for --${flag} must say what went wrong`).toContain(
          "is the next flag",
        );
        swept += 1;
      }
    }
    // A loop over an empty table reports success having run nothing.
    expect(swept).toBe(7);
  });

  /**
   * The axis the previous three rounds never varied.
   *
   * Each of them handed the parser the SAME shape — "the value is the next
   * flag" — and differed only in WHICH flag carried it, so the battery
   * could not come back wrong about a shape nobody wrote. The other way to
   * pass no value is to put the flag LAST, where `args[idx + 1]` does not
   * exist at all; the reader returned `undefined` for that and `optional()`
   * read it as absent.
   */
  test("EVERY flag refuses by name when it is the LAST argument with no value", () => {
    let swept = 0;
    for (const [mode, valid] of Object.entries(MODES)) {
      // `--project-root` is optional and belongs to neither table, but it is
      // the flag whose silent default this case exists for, so it is swept
      // in the mode that writes a spec.
      const subjects =
        mode === "promote" ? [...Object.keys(valid), "project-root"] : Object.keys(valid);
      for (const flag of subjects) {
        // Every other flag in THIS mode valid and complete, then the subject
        // appended with nothing after it — so the refusal is about this one.
        const rest = Object.entries(valid)
          .filter(([k]) => k !== flag)
          .flatMap(([k, v]) => [`--${k}`, v]);
        const { code, err } = run([...rest, `--${flag}`]);
        expect(code, `[${mode}] --${flag} as the last argument must refuse`).toBe(1);
        expect(err, `[${mode}] the refusal for --${flag} must name it`).toContain(`--${flag}`);
        expect(err, `[${mode}] the refusal for --${flag} must say no value was given`).toContain(
          "given no value at all",
        );
        swept += 1;
      }
    }
    // A loop over an empty table reports success having run nothing.
    expect(swept).toBe(8);
  });

  test("a trailing --project-root does NOT silently fall back to the package directory", () => {
    // #363's exact shape: the flag whose whole purpose is to keep writes out
    // of node_modules/rungate, typo'd so its path is gone. Before the reader
    // enumerated `novalue`, this exited on some LATER refusal — or worse,
    // proceeded — having resolved ROOT to the installed package.
    const argv = Object.entries(MODES.promote!).flatMap(([k, v]) => [`--${k}`, v]);
    const { code, err } = run([...argv, "--project-root"]);
    expect(code).toBe(1);
    expect(err, "the refusal must be about --project-root, not a downstream symptom").toContain(
      "--project-root",
    );
  });

  test("a non-numeric --issue refuses up front, not as a gh error about issue #NaN", () => {
    const { code, err } = run([
      "--issue", "abc",
      "--spec", "specs/SPEC-TO-BOARD-PIPELINE-SPEC.md",
      "--symbol", "promote",
      "--module", "lib/finding-promotion.ts",
      "--outcome", "an outcome",
    ]);
    expect(code).toBe(1);
    expect(err).toContain("--issue must be a positive integer");
    // The shape this replaces. A tracker error for an argument typo sends
    // the reader to GitHub to debug their own command line.
    expect(err).not.toContain("#NaN");
  });
});

describe("SC-2612 / AC-5 (#1678): the statement a promotion produces", () => {
  test("names the module and the symbol, so a mutation can move it", () => {
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      const s = promotionStatement(inputFor(root));
      expect(s).toBe(
        "lib/finding-promotion.ts contains [promote] — the thing the finding named becomes checkable",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * #1940: the OTHER outcome of the router — declining.
 *
 * ## What was missing
 *
 * `NAMES_NONE = "serves no criterion"` is defined in `lib/board-mirror.ts`
 * and read by `scripts/board-snapshot.ts`, which reports an issue carrying
 * the literal in its title or body as a deliberate decline rather than a
 * blank. SC-2609 made the phrase sayable precisely so that *not yet filled
 * in* and *deliberately none* stop being the same zero bytes.
 *
 * Nothing emitted it. Grepped across `lib`, `scripts`, `bin` and `hooks` on
 * 2026-11-09: the definition, one read, one detector, and no producer.
 *
 * The one creation path was WORSE than absent, and that is the correction
 * this block records: `.github/ISSUE_TEMPLATE/spec-work.yml` tells a human
 * author to type the phrase. So the only way the board could learn that work
 * deliberately serves no criterion was a **self-declaration** — the exact
 * shape `lib/criterion-issue-census.ts` refused to make a column, and that
 * `promote`'s own docblock refuses to make a flag, because a judgement
 * settable by whoever is looking rebuilds the tick-is-proof defect one level
 * up inside the instrument built to measure it.
 *
 * `decline` makes the declaration an OUTCOME. It is refused when the board
 * can already see a criterion, refused when the sweep could not be taken,
 * and the phrase it writes is interpolated from the constant the detector
 * reads rather than retyped in a second language.
 */
describe("#1940: declining is an outcome of the router, not a self-declaration", () => {
  const WHY = "a worktree tidy-up: no criterion in this tree is made true or false by it";

  function declineIn(root: string, over: Partial<DeclineInput> = {}): DeclineInput {
    return { issue: ISSUE, why: WHY, projectRoot: root, ...over };
  }

  test("the one case that must SUCCEED, so the refusals below are not vacuous", () => {
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      const out = decline(declineIn(root));
      expect(out.declined, out.declined ? "" : `refused ${out.refusal}: ${out.why}`).toBe(true);
      if (!out.declined) return;
      expect(out.issue).toBe(4242);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the section it writes is read as a decline by board-snapshot's OWN expression", () => {
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      const out = decline(declineIn(root));
      expect(out.declined).toBe(true);
      if (!out.declined) return;

      // This is the expression at `scripts/board-snapshot.ts`'s `servesNone`,
      // not a paraphrase of it. A producer and a detector that agree because
      // two implementations were kept in step is the fourth shape in
      // `.claude/rules/checks-must-be-able-to-fail.md`; this asserts they
      // agree on the SAME bytes the live reader looks at.
      const body = `${ISSUE.title}\n${out.section}`;
      expect(body.includes(NAMES_NONE)).toBe(true);

      // Anchored on the LITERAL as well. `toContain(NAMES_NONE)` alone moves
      // with the constant, so renaming the constant to "x" would keep this
      // green while the live board stopped reading anything.
      expect(out.section).toContain("serves no criterion");

      // And it is under the heading a parsed body carries it in, derived from
      // the one place that decides what a section is called.
      const criteria = ISSUE_SECTIONS.find(s => s.id === "criteria")!;
      expect(out.section).toStartWith(headingFor(criteria));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the caller's reason is carried, because a decline nobody justified is a tick", () => {
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      const out = decline(declineIn(root));
      expect(out.declined).toBe(true);
      if (!out.declined) return;
      expect(out.section).toContain(WHY);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * Every refusal, each against an input that reaches it and nothing else.
   * Derived from `DECLINE_REFUSALS` so a refusal added without a case here
   * is red rather than unguarded — the same property AC-4 asserts over
   * `PROMOTION_REFUSALS`.
   */
  const REFUSING: Record<DeclineRefusal, Partial<DeclineInput>> = {
    NO_WHY: { why: "   " },
    MALFORMED_WHY: { why: "fine\n## Files this will change\n- forged.ts" },
    WHY_NAMES_CRITERION: { why: "it is covered by SC-9001 already" },
    ALREADY_SERVES: { issue: { number: 77, title: "SC-9001", body: "" } },
    ALREADY_DECLINED: {
      issue: { number: 78, title: "Tidy", body: "## Criteria this serves\n\nserves no criterion — said once already" },
    },
    AMBIGUOUS_HEADING: {
      issue: {
        number: 79,
        title: "Tidy",
        body: "## Criteria this serves\n\n## Criteria this serves\n",
      },
    },
    CRITERIA_SECTION_OCCUPIED: {
      issue: {
        number: 80,
        title: "Tidy",
        body: "## Criteria this serves\n\nTBD, somebody should work this out\n",
      },
    },
    SWEEP_UNMEASURED: {},
  };

  test("every named refusal is reached by some input", () => {
    const root = scratch(SPEC_WITH_CRITERIA);
    const unmeasurable = mkdtempSync(join(tmpdir(), "rg-1940-no-specs-"));
    try {
      const reached = new Set<DeclineRefusal>();
      for (const [name, over] of Object.entries(REFUSING) as [DeclineRefusal, Partial<DeclineInput>][]) {
        // SWEEP_UNMEASURED needs a tree with no readable specs/ at all; every
        // other case needs the sweep to WORK, or it refuses for that reason
        // instead and the case certifies nothing.
        const at = name === "SWEEP_UNMEASURED" ? unmeasurable : root;
        for (const v of declineViolations(declineIn(at, over))) reached.add(v.refusal);
      }
      expect([...DECLINE_REFUSALS].filter(r => !reached.has(r))).toEqual([]);
    } finally {
      rmSync(unmeasurable, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an issue the board can already see a criterion on cannot decline", () => {
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      const out = decline(declineIn(root, { issue: { number: 77, title: "SC-9001", body: "" } }));
      expect(out.declined).toBe(false);
      if (out.declined) return;
      expect(out.refusal).toBe("ALREADY_SERVES");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * The mutation half. `decline` adds no condition of its own — every refusal
   * comes from `declineViolations` — so emptying that one binding must turn
   * every refusing input above into a declining one.
   *
   * Without it, a case that refuses because the fixture was malformed is
   * indistinguishable from one that observed the guard.
   */
  test("every refusing input declines against a mutant with the binding emptied", async () => {
    const libDir = join(import.meta.dir, "..", "lib");
    const mutantDir = mkdtempSync(join(libDir, "tmp-1940-mutant-"));
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      const BINDING = "export function declineViolations(input: DeclineInput): DeclineViolation[] {";
      const source = readFileSync(SOURCE, "utf8");
      expect(source).toContain(BINDING);
      // Exactly once, so no refusal bypasses the mutation.
      expect(source.split(BINDING).length - 1).toBe(1);

      let text = source.replace(BINDING, `${BINDING}\n  return [];`);
      expect(text).not.toBe(source);
      const before = text;
      text = text.replace(/from "\.\//g, 'from "../');
      expect(text).not.toBe(before);
      expect(text).not.toMatch(/from "\.\/[^."]/);
      const path = join(mutantDir, "finding-promotion-decline-mutant.ts");
      writeFileSync(path, text);

      // Baseline FIRST. A mutant row read before its baseline is a reading
      // with nothing to compare against.
      const refusing = Object.entries(REFUSING).filter(([n]) => n !== "SWEEP_UNMEASURED") as [
        DeclineRefusal,
        Partial<DeclineInput>,
      ][];
      for (const [, over] of refusing) {
        expect(decline(declineIn(root, over)).declined).toBe(false);
      }

      const mutant = (await import(path)) as typeof import("../lib/finding-promotion");
      let declinedByMutant = 0;
      for (const [, over] of refusing) {
        if (mutant.decline(declineIn(root, over)).declined) declinedByMutant += 1;
      }
      // Predicted 7 of 7 — the whole set minus SWEEP_UNMEASURED, which is
      // excluded because it needs a different tree, not because the guard
      // would survive.
      expect(declinedByMutant).toBe(7);

      // Membership, not just the total: the forgery is the one whose failure
      // mode is worst, so it is the one that must be observed promoting.
      const forged = mutant.decline(declineIn(root, REFUSING.MALFORMED_WHY));
      expect(forged.declined).toBe(true);
      if (!forged.declined) return;
      expect(forged.section).toContain("## Files this will change");
    } finally {
      rmSync(mutantDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * #1940, second half: the body the CLI writes back to the tracker.
 *
 * Printing the section and telling an author to paste it would move the
 * typing without removing it, and the spelling is the thing that drifts —
 * `test/board-snapshot.test.ts` already had to add a case for a form that
 * said `none — machinery` while the reader matched the constant. So the
 * decline is APPLIED, and this block is about the two shapes of body it has
 * to apply into.
 */
describe("#1940: bodyWithDecline puts the declaration where the readers look", () => {
  const WHY = "maintenance on the worktree census, no criterion moves";

  test("a body with no criteria heading gains the whole section", () => {
    const out = bodyWithDecline("## What must become true\n\nTidy the census.\n", WHY);
    expect(out).toContain("## Criteria this serves");
    expect(out).toContain(`${NAMES_NONE} — ${WHY}`);
    // The author's own text is still there. An apply that replaced the body
    // would pass every assertion above and lose the issue.
    expect(out).toContain("Tidy the census.");
  });

  test("a body with an EMPTY criteria heading gains the line, not a second heading", () => {
    const body = "## What must become true\n\nTidy.\n\n## Criteria this serves\n\n## Files this will change\n\n- a.ts\n";
    const out = bodyWithDecline(body, WHY);
    expect(headingOccurrencesOf(out, "## Criteria this serves").length).toBe(1);
    expect(out).toContain(`${NAMES_NONE} — ${WHY}`);
    // And it landed under ITS OWN heading, not at the end of the body, which
    // is where a naive append would put it — under Files this will change.
    expect(missingSections(out, "spec-work")).not.toContain("## Criteria this serves");
    expect(out).toContain("- a.ts");
  });

  test("the applied body is read as a decline by board-snapshot's own expression", () => {
    const out = bodyWithDecline("## What must become true\n\nTidy.\n", WHY);
    expect(`A title\n${out}`.includes(NAMES_NONE)).toBe(true);
    // Anchored on the literal too, so renaming the constant cannot keep this
    // green while the live board stops reading anything.
    expect(out).toContain("serves no criterion");
  });

  test("a fenced heading is not mistaken for the section — the fence-blind bug", () => {
    // `headingOccurrencesOf` exists because a body quoting the template in a
    // code block looks exactly like one that has the section. If this apply
    // were fence-blind it would insert the declaration inside the fence,
    // where no reader of the rendered issue would ever see it.
    const body = "## What must become true\n\nRun:\n\n```\n## Criteria this serves\n```\n";
    const out = bodyWithDecline(body, WHY);
    expect(headingOccurrencesOf(out, "## Criteria this serves").length).toBe(1);
    const real = headingOccurrencesOf(out, "## Criteria this serves")[0]!;
    expect(out.slice(real)).toContain(NAMES_NONE);
  });
});

/**
 * #1956 review round 1. Four distinct defects, all in the decline path.
 */
describe("#1956 round 1: the decline path's four review findings", () => {
  const WHY = "maintenance, no criterion moves";

  function declineIn(root: string, over: Partial<DeclineInput> = {}): DeclineInput {
    return { issue: ISSUE, why: WHY, projectRoot: root, ...over };
  }

  /**
   * An unterminated fence in `--why` flips fence state for EVERYTHING below
   * it. `headingOccurrencesOf`, `hasContent` and `missingSections` all track
   * fences by toggling on `/^\s*```/`, so an odd number of such lines makes
   * every later heading in the body invisible to all three — the body parses
   * as having no sections at all.
   *
   * MALFORMED_WHY guarded the heading forgery and not this one: a detector
   * narrower than what it detects.
   */
  test("MALFORMED_WHY refuses a fence in --why, not only a heading", () => {
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      const out = decline(declineIn(root, { why: "fine\n```\nsome text" }));
      expect(out.declined).toBe(false);
      if (out.declined) return;
      expect(out.refusal).toBe("MALFORMED_WHY");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the fence guard is not vacuous — an ordinary reason still declines", () => {
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      expect(decline(declineIn(root)).declined).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * `section` was documented and printed as the preview of what gets
   * written, and for a body that already carries an empty criteria heading
   * `bodyWithDecline` writes only the LINE. So the preview showed a second
   * heading that never appears, which is a false report about a write.
   */
  test("the result carries the body that will ACTUALLY be written", () => {
    const root = scratch(SPEC_WITH_CRITERIA);
    const existing = "## What must become true\n\nTidy.\n\n## Criteria this serves\n";
    try {
      const out = decline(declineIn(root, { issue: { ...ISSUE, body: existing } }));
      expect(out.declined).toBe(true);
      if (!out.declined) return;
      expect(out.body).toBe(bodyWithDecline(existing, WHY));
      // The preview and the write agree: one heading, not two.
      expect(headingOccurrencesOf(out.body, "## Criteria this serves").length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a body with no heading gains one, and the result still matches the write", () => {
    const root = scratch(SPEC_WITH_CRITERIA);
    const existing = "## What must become true\n\nTidy.\n";
    try {
      const out = decline(declineIn(root, { issue: { ...ISSUE, body: existing } }));
      expect(out.declined).toBe(true);
      if (!out.declined) return;
      expect(out.body).toBe(bodyWithDecline(existing, WHY));
      expect(headingOccurrencesOf(out.body, "## Criteria this serves").length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * #1956 round 1, the CLI's two findings. Spawned, because the defects are in
 * argument handling and error attribution and neither is reachable from the
 * library.
 */
describe("#1956 round 1: the decline CLI refuses a contradictory command line", () => {
  const CLI2 = join(import.meta.dir, "..", "scripts", "finding-promotion.ts");

  function run(argv: string[]): { code: number; err: string } {
    const p = Bun.spawnSync(["bun", CLI2, ...argv], { cwd: join(import.meta.dir, "..") });
    return { code: p.exitCode ?? -1, err: new TextDecoder().decode(p.stderr) };
  }

  /**
   * `--spec`, `--outcome`, `--symbol` and `--module` are read only when
   * `declining` is false, so a command line carrying both took the decline
   * path and silently ignored four flags the caller supplied. A half-edited
   * copy-paste is the likely source, and it is indistinguishable from a
   * deliberate decline.
   */
  test("--declines with any promote flag refuses, naming both", () => {
    const { code, err } = run([
      "--issue", "1678",
      "--declines", "a reason",
      "--spec", "specs/SPEC-TO-BOARD-PIPELINE-SPEC.md",
    ]);
    expect(code).toBe(1);
    expect(err).toContain("--declines");
    expect(err).toContain("--spec");
  });

  test("the refusal is not blanket — --declines alone reaches the tracker read", () => {
    // Without this, a CLI that refused every --declines invocation would
    // pass the case above. This one must get PAST argument handling; it then
    // fails on the tracker or the board, which is a different message.
    const { err } = run(["--issue", "999999999", "--declines", "a reason"]);
    expect(err).not.toContain("cannot be combined");
  });
});

describe("#1956 round 2: the scratch directory is always removed", () => {
  const SRC = readFileSync(
    join(import.meta.dir, "..", "scripts", "finding-promotion.ts"),
    "utf8",
  );

  /**
   * `process.exit()` does not unwind the stack, so a `finally` around a
   * block that exits from inside it never runs. Both decline write paths
   * exited in there, leaking the mkdtemp directory AND the rendered issue
   * body in it.
   *
   * Asserted as a property of the REGION rather than of the two call sites
   * review named. Repairing named instances is what rounds 2 through 4 of
   * #1955 did, and each round found a sibling of the same shape still
   * present — `.claude/rules/checks-must-be-able-to-fail.md`, the fourth
   * shape at N sites.
   */
  test("no process.exit sits between the mkdtemp and the finally that removes it", () => {
    const open = SRC.indexOf("mkdtempSync(");
    const close = SRC.indexOf("rmSync(scratch", open);
    expect(open, "the decline path must still create a scratch directory").toBeGreaterThan(-1);
    expect(close, "the scratch directory must still be removed in a finally").toBeGreaterThan(open);

    // Comments stripped first. The docblock explaining this very rule says
    // `process.exit()` in prose, and a scanner that counts the explanation
    // as a violation is a detector wider than what it detects.
    const region = SRC.slice(open, close)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");

    // Proves the cut is the region meant, not an empty or runaway slice —
    // an empty string contains no process.exit and would pass vacuously.
    expect(region).toContain("writeFileSync(bodyFile");
    expect(region).toContain("issue\", \"edit\"");

    const exits = [...region.matchAll(/process\.exit\(/g)].length;
    expect(
      exits,
      "an exit inside the guarded region skips the finally and leaks the scratch directory — " +
        "return the failure out of the region and exit after the cleanup has run",
    ).toBe(0);
  });

  test("the failure still reaches the caller — the refusal was moved, not deleted", () => {
    // Without this, deleting both error paths outright satisfies the case
    // above: a region with no failure handling at all contains no exit.
    // Both messages must still be BUILT inside the region...
    const open = SRC.indexOf("mkdtempSync(");
    const region = SRC.slice(open, SRC.indexOf("rmSync(scratch", open));
    expect(region).toContain("could not be updated on the tracker");
    expect(region).toContain("this is a LOCAL");

    // ...and the non-zero exit must happen AFTER the cleanup, conditional
    // on what the region returned.
    const after = SRC.slice(SRC.indexOf("rmSync(scratch"));
    expect(after).toContain("if (failure)");
    expect(after.indexOf("process.exit(PROMOTION_EXIT)")).toBeGreaterThan(
      after.indexOf("if (failure)"),
    );
  });
});

/**
 * #2060 / SC-2612: a promotion needs no hand step to be correct.
 *
 * Two of the hand steps ADR-015 needed: a symbol the module already
 * contained (`heredocInterpreter`) made a presence-matched criterion pass
 * falsely, and every promoted issue had to be edited by hand to name its
 * new criterion.
 */
describe("#2060 / SC-2612: an existing symbol is refused, and the issue is linked", () => {
  function withModule(text: string): string {
    const root = scratch(SPEC_WITH_CRITERIA);
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(join(root, "lib", "finding-promotion.ts"), text);
    return root;
  }

  test("a symbol the module already contains is refused before anything is allocated", () => {
    const root = withModule("export function promote() {}\n");
    try {
      const out = promote(inputFor(root), REGISTRY);
      expect(out.promoted).toBe(false);
      if (out.promoted) return;
      expect(out.refusal).toBe("SYMBOL_EXISTS");
      expect(out.why).toContain("lib/finding-promotion.ts");
      expect(out.why).toContain("promote");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the refusal reads the module the way the matcher does: any substring, comments included", () => {
    // Review of #2065. `content-contains` (lib/conformity.ts) is
    // `toContain(item)`, so `promoted` satisfies `contains [promote]`, and so
    // does a comment. A narrower check here is a false pass the matcher sees.
    for (const text of ["export const promoted = 1;\n", "// TODO: promote this later\n"]) {
      const root = withModule(text);
      try {
        const out = promote(inputFor(root), REGISTRY);
        expect(out.promoted, text).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    const absent = withModule("export const other = 1;\n");
    try {
      expect(promote(inputFor(absent), REGISTRY).promoted).toBe(true);
    } finally {
      rmSync(absent, { recursive: true, force: true });
    }
  });

  test("a retry finds its own line already written and allocates nothing new", () => {
    // Review of #2065: a failed issue link exits after the spec write, and a
    // retry used to append a second copy of the same criterion.
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      const first = promote(inputFor(root), REGISTRY);
      expect(first.promoted).toBe(true);
      if (!first.promoted) return;
      const path = join(root, "specs", "FIXTURE-SPEC.md");
      writeFileSync(path, `${readFileSync(path, "utf8").trimEnd()}\n${first.line}\n`);
      const retry = promote(inputFor(root), REGISTRY);
      expect(retry.promoted).toBe(true);
      if (!retry.promoted) return;
      expect(retry.alreadyWritten).toBe(true);
      expect(retry.id).toBe(first.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a retry still links after the work has landed and the module now holds the symbol", () => {
    // Review of #2065, round 2: SYMBOL_EXISTS ran before the already-written
    // scan, so once the fix merged a retry of the failed link was refused and
    // the issue could never be linked by the tool.
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      const first = promote(inputFor(root), REGISTRY);
      expect(first.promoted).toBe(true);
      if (!first.promoted) return;
      const path = join(root, "specs", "FIXTURE-SPEC.md");
      writeFileSync(path, `${readFileSync(path, "utf8").trimEnd()}\n${first.line}\n`);
      mkdirSync(join(root, "lib"), { recursive: true });
      writeFileSync(join(root, "lib", "finding-promotion.ts"), "export function promote() {}\n");
      const retry = promote(inputFor(root), REGISTRY);
      expect(retry.promoted).toBe(true);
      if (!retry.promoted) return;
      expect(retry.alreadyWritten).toBe(true);
      expect(retry.id).toBe(first.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an issue with two Criteria headings is refused before the spec is written", () => {
    // Review of #2065, round 2: the decline path refuses this shape; the
    // promote path wrote the spec and then linked into the first heading.
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      const body = "x\n\n## Criteria this serves\n\n## Criteria this serves\n";
      const out = promote(inputFor(root, { issue: { number: 77, title: "t", body } }), REGISTRY);
      expect(out.promoted).toBe(false);
      if (out.promoted) return;
      expect(out.refusal).toBe("AMBIGUOUS_HEADING");
      expect(out.why).toContain("2 times");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the link refuses a body that gained a second Criteria heading since the check", () => {
    const twice = "x\n\n## Criteria this serves\n\nSC-1\n\n## Criteria this serves\n";
    const out = withCriterionLinked(twice, "SC-2762");
    expect(out.linked).toBe(false);
    if (out.linked) return;
    expect(out.why).toContain("2 times");
  });

  test("the link adds the id under the Criteria heading, and the board reads it as answered", () => {
    const bareLink = withCriterionLinked("Some finding.", "SC-2762");
    expect(bareLink.linked).toBe(true);
    if (!bareLink.linked) return;
    const bare = bareLink.body;
    expect(bare).toContain("## Criteria this serves");
    expect(criterionAnswer({ title: "t", body: bare }, ["SC-2762"]).names).toEqual(["SC-2762"]);

    const existing = "Body.\n\n## Criteria this serves\n\nSC-2741\n\n## Files this will change\n- a.ts\n";
    const link = withCriterionLinked(existing, "SC-2762");
    expect(link.linked).toBe(true);
    if (!link.linked) return;
    const linked = link.body;
    expect(linked.match(/## Criteria this serves/g)?.length).toBe(1);
    expect(criterionAnswer({ title: "t", body: linked }, ["SC-2741", "SC-2762"]).names.sort()).toEqual(["SC-2741", "SC-2762"]);
    // The id lands inside the Criteria section, before the next heading.
    expect(linked.indexOf("SC-2762")).toBeLessThan(linked.indexOf("## Files this will change"));
    // Linking twice changes nothing.
    expect(withCriterionLinked(linked, "SC-2762")).toEqual({ linked: true, body: linked });
  });

  test("the CLI links the issue after the spec is written, through the one function", () => {
    const cli = readFileSync(join(import.meta.dir, "..", "scripts", "finding-promotion.ts"), "utf8");
    const wrote = cli.indexOf("const wrote = writeSpec(");
    const linked = cli.indexOf("withCriterionLinked(");
    expect(wrote).toBeGreaterThan(-1);
    expect(linked).toBeGreaterThan(wrote);
    // The function is CALLED, and its failure exits — a definition nobody
    // calls would satisfy the line above.
    expect(cli.indexOf("const linkFailure = linkIssue();")).toBeGreaterThan(wrote);
    expect(cli).toMatch(/if \(linkFailure\) \{[\s\S]*?process\.exit\(PROMOTION_EXIT\)/);
    expect(cli).not.toContain("Now make #");
  });
});
