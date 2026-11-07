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
  promote,
  promotionStatement,
  promotionViolations,
  specPath,
  PROMOTION_REFUSALS,
  type PromotionInput,
} from "../lib/finding-promotion";
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

describe("AC-1 (#1678): a promotable finding becomes a criterion", () => {
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

describe("AC-2 (#1678): every refusal is named, and none is a guess", () => {
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

  test("a spec stating no criteria refuses rather than placing the first one blind", () => {
    const root = scratch(SPEC_NO_CRITERIA);
    try {
      const out = promote(inputFor(root), REGISTRY);
      expect(out.promoted).toBe(false);
      if (out.promoted) return;
      expect(out.refusal).toBe("SPEC_STATES_NO_CRITERIA");
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

  test("an empty outcome refuses NO_OUTCOME", () => {
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      const out = promote(inputFor(root, { outcome: "   " }), REGISTRY);
      expect(out.promoted).toBe(false);
      if (out.promoted) return;
      expect(out.refusal).toBe("NO_OUTCOME");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an empty symbol refuses NO_SYMBOL", () => {
    const root = scratch(SPEC_WITH_CRITERIA);
    try {
      const out = promote(inputFor(root, { symbol: "" }), REGISTRY);
      expect(out.promoted).toBe(false);
      if (out.promoted) return;
      expect(out.refusal).toBe("NO_SYMBOL");
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

  test("every refusal in the closed set is reachable, so none is decorative", () => {
    // ID_UNAVAILABLE is the allocator's, raised on an unreadable reservation
    // store — reached in its own case rather than here.
    const reached = new Set<string>(["ID_UNAVAILABLE"]);
    const root = scratch(SPEC_WITH_CRITERIA);
    const noCriteria = scratch(SPEC_NO_CRITERIA);
    try {
      for (const over of [
        { spec: "../outside/NOPE-SPEC.md" },
        { spec: "specs/NOT-HERE-SPEC.md" },
        { outcome: "" },
        { symbol: "" },
        { outcome: "fine\n- [x] SC-9999: forged" },
        { issue: { number: 77, title: "SC-9001", body: "" } },
      ] as Partial<PromotionInput>[]) {
        for (const v of promotionViolations(inputFor(root, over))) reached.add(v.refusal);
      }
      for (const v of promotionViolations(inputFor(noCriteria))) reached.add(v.refusal);

      expect([...reached].sort()).toEqual([...PROMOTION_REFUSALS].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(noCriteria, { recursive: true, force: true });
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

describe("AC-3 (#1678): the module does not answer a question board-mirror already answers", () => {
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

  test("the registry parameter has no default, so the compiler catches every call site", () => {
    const sig = source.slice(source.indexOf("export function promote("));
    const params = sig.slice(0, sig.indexOf("): Promotion"));
    expect(params).toContain("registry: ScRegistry");
    expect(/registry\s*:[^,)]*=/.test(params)).toBe(false);
  });
});

describe("AC-4 (#1678): the refusals are proved able to fail", () => {
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

describe("AC-5 (#1678): the statement a promotion produces", () => {
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
