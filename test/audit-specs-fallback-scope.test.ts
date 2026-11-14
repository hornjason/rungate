/**
 * Covers SC-2020..SC-2025 (SCAFFOLD-DECOMPOSITION-SPEC.md), #589, #2040.
 *
 * `findClosestPattern` in `scripts/audit-specs.ts` used to end in a last
 * resort: match any filename-like token ANYWHERE in a sentence and render the
 * whole criterion as `<that file> exists`. Measured over the corpus
 * `scaffold . --fix` edits, two criteria went through it:
 *
 *   SC-1940  Rejecting a promoted rule writes its hash to
 *            `reference/rejected-constraints.md` and it is never re-promoted
 *              -> reference/rejected-constraints.md exists
 *
 *   SC-1943  Makefile targets, `package.json` scripts and CI workflow files
 *            are scanned for constraints alongside markdown
 *              -> package.json exists
 *
 * #589 fenced it: the last resort could only speak for a criterion making ONE
 * claim, decided by `coordinatedClaims`. That left it rewriting single-claim
 * sentences such as "the generator should emit a tidy CODE-MAP.md for every
 * project" into `CODE-MAP.md exists`, which holds against a file that
 * obviously exists whatever the generator does.
 *
 * ## #2040 removed the last resort, and with it the fence
 *
 * On ADR-014's branch (#2033) it turned SC-2747 — a criterion about what
 * `scaffold` installs — into `AGENTS.md exists`. Jason's call, 2026-11-14:
 * a filename a criterion mentions is never what the criterion is rewritten
 * to. A statement the `file-exists` heuristic binds — one that SAYS a file
 * should exist — is still rewritten, because that rewrite says the same thing.
 *
 * So every case below that asserts a criterion is KEPT sits beside one that
 * asserts a bound statement is still REWRITTEN. "--fix stopped rewriting
 * anything" would satisfy the keeps alone.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import {
  auditSpecs,
  closestPatternFor,
  decideRewrite,
  type RewriteEntry,
} from "../scripts/audit-specs";

const ROOT = join(import.meta.dir, "..");
const AUDIT_SPECS = join(ROOT, "scripts", "audit-specs.ts");
const SCRIPTS_DIR = join(ROOT, "scripts");

/**
 * The two criteria the last resort rewrote, verbatim from the tree.
 *
 * Pinned as strings AND asserted to still be in the spec (SC-2020). A fixture
 * that quietly stops matching the tree it is about is #507's shape: it keeps
 * passing and stops being a witness.
 */
const NAMED_SPEC = join(ROOT, "specs", "RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md");
const SC_1940 =
  "Rejecting a promoted rule writes its hash to `reference/rejected-constraints.md` " +
  "and it is never re-promoted";
const SC_1943 =
  "Makefile targets, `package.json` scripts and CI workflow files are scanned for " +
  "constraints alongside markdown";

/**
 * The single-claim sentence #589 still let through. Its verb is *emit*, and it
 * only mentions the file. Kept now.
 */
const SINGLE_CLAIM = "the generator should emit a tidy CODE-MAP.md for every project";

/**
 * A sentence that SAYS the file should exist, which the `file-exists`
 * heuristic binds. The control: it must still be rewritten.
 */
const BOUND = "the file CODE-MAP.md should exist for every project";
const BOUND_REWRITE = "CODE-MAP.md exists";

/** The three that only mention a file. */
const MENTIONS: ReadonlyArray<readonly [string, string]> = [
  ["SC-1940", SC_1940],
  ["SC-1943", SC_1943],
  ["single-claim", SINGLE_CLAIM],
];

function writeSpec(root: string, name: string, body: string): string {
  mkdirSync(join(root, "specs"), { recursive: true });
  const path = join(root, "specs", name);
  writeFileSync(
    path,
    `---\ndoc-type: spec\nstatus: active\ntestable: true\ncompliance: strict\n` +
      `updated: 2026-11-14\ngoverns: the #2040 fixture\n---\n\n# Fixture\n\n` +
      `## Success Criteria\n\n${body}\n`,
  );
  return path;
}

/**
 * A rewrite into `<file> exists` from a sentence that never said the file
 * should exist — the shape #2040 removes. The `file-exists` heuristic only
 * binds a sentence carrying `exist` or `be present`, so a sentence lacking
 * both that still came back as `<file> exists` was chosen by its filename.
 */
export function rewrittenToAMentionedFile(rewrites: readonly RewriteEntry[]): RewriteEntry[] {
  return rewrites.filter(
    r => !r.kept && /^\S+ exists\b/.test(r.after) && !/\bexist|\bbe\s+present/i.test(r.before),
  );
}

// ── AC-1: the decision ────────────────────────────────────────

describe("SC-2020: a filename a criterion mentions is not what the criterion is about", () => {
  test("no criterion that only mentions a file is offered a pattern, so each is kept", () => {
    // The fixture is still the tree's. Asserted first, because the two
    // strings below are the subject of this file and a reworded spec would
    // leave every case green over a statement nothing declares.
    const spec = readFileSync(NAMED_SPEC, "utf-8");
    expect(spec, "SC-1940 no longer reads as this file assumes").toContain(`- [ ] SC-1940: ${SC_1940}`);
    expect(spec, "SC-1943 no longer reads as this file assumes").toContain(`- [ ] SC-1943: ${SC_1943}`);

    for (const [id, statement] of MENTIONS) {
      const closest = closestPatternFor(statement);
      expect(closest, `${id} was offered ${JSON.stringify(closest)} off a filename it only mentions`)
        .toBeNull();
      const decision = decideRewrite(statement, closest);
      expect(decision.kind, `${id} was rewritten to ${JSON.stringify(decision)}`).toBe("keep");
      expect(decision.kind === "keep" && decision.reason).toMatch(/no registry pattern/);
    }
  });

  test("the control: a sentence that says the file should exist is still rewritten", () => {
    // In the same describe as the keeps, so "switch the rewriter off" cannot
    // satisfy the block.
    const closest = closestPatternFor(BOUND);
    expect(closest?.patternName).toBe("file-exists");
    const decision = decideRewrite(BOUND, closest);
    expect(decision.kind, "the file-exists heuristic stopped rewriting — --fix is off").toBe("rewrite");
    expect(decision.kind === "rewrite" && decision.statement).toBe(BOUND_REWRITE);
  });
});

// ── AC-2: the write, not just the decision ────────────────────

describe("SC-2021: --fix leaves every criterion that only mentions a file byte-identical", () => {
  let dir = "";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fallback-scope-write-")); });
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("all three lines survive and are marked, and the bound one beside them is rewritten", () => {
    const path = writeSpec(
      dir,
      "FALLBACK-SPEC.md",
      [
        `- [ ] SC-9601: ${SC_1940}`,
        `- [ ] SC-9602: ${SC_1943}`,
        `- [ ] SC-9603: ${SINGLE_CLAIM}`,
        `- [ ] SC-9604: ${BOUND}`,
      ].join("\n"),
    );
    const before = readFileSync(path, "utf-8");
    auditSpecs(dir, { fix: true });
    const after = readFileSync(path, "utf-8");
    const lines = after.split("\n");

    for (const [id, statement] of [["SC-9601", SC_1940], ["SC-9602", SC_1943], ["SC-9603", SINGLE_CLAIM]]) {
      expect(after, `${id} was rewritten into a file-existence check`).toContain(`- [ ] ${id}: ${statement}`);
      // MARKED rather than silently skipped — the coverage gap #586 made
      // visible, which this must not undo.
      const at = lines.indexOf(`- [ ] ${id}: ${statement}`);
      expect(lines[at + 1], `${id} carries no REVIEW marker`).toMatch(/^<!-- REVIEW: unmatched \(.+\) -->$/);
    }

    // The positive control, in THIS test: a `--fix` that had become a no-op
    // would satisfy everything above.
    expect(after, "--fix changed nothing at all").not.toBe(before);
    expect(after).toContain(`- [ ] SC-9604: ${BOUND_REWRITE}`);
  });
});

// ── AC-3: the population, over the corpus --fix actually edits ─

describe("SC-2022: no criterion across specs/ is rewritten to a file it only mentions", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fallback-scope-pop-"));
    // A COPY, because the measurement is `--fix` executed rather than
    // described, and `--fix` writes. The repo's own specs/ is never touched.
    cpSync(join(ROOT, "specs"), join(dir, "specs"), { recursive: true });
  });
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("the measured population is 0, and the two criteria that once were are kept", () => {
    const result = auditSpecs(dir, { fix: true });
    const rewrites = result.rewrites ?? [];

    // Coverage controls FIRST. An empty population is also what a run that
    // read nothing produces.
    expect(result.specs.length, "the audit processed no spec files").toBeGreaterThan(10);
    expect(result.totalUnmatched, "the audit classified no unmatched criteria").toBeGreaterThan(10);
    expect(rewrites.length, "the fix run reached no criterion at all").toBeGreaterThan(10);

    // The two the last resort rewrote are still REACHED and declined — so
    // the zero below is about criteria the run looked at.
    const kept = new Map(rewrites.filter(r => r.kept).map(r => [r.scId, r.kept!]));
    for (const id of ["SC-1940", "SC-1943"]) {
      expect(kept.get(id), `${id} is no longer reached, so the count below measures less`).toBeTruthy();
    }

    expect(
      rewrittenToAMentionedFile(rewrites).map(r => `${r.specFile} ${r.scId}: ${r.before} -> ${r.after}`),
      "a criterion was replaced by a check that a file it only mentions exists",
    ).toEqual([]);
  });

  test("the measurement can see such a rewrite when there is one", () => {
    // The classifier's own positive control: an entry of the removed shape is
    // counted, and the bound shape beside it is not.
    const shaped = [
      { scId: "SC-1", specFile: "X.md", before: SINGLE_CLAIM, after: "CODE-MAP.md exists", patternUsed: "file-exists", ambiguous: true },
      { scId: "SC-2", specFile: "X.md", before: BOUND, after: BOUND_REWRITE, patternUsed: "file-exists", ambiguous: false },
    ] as RewriteEntry[];
    expect(rewrittenToAMentionedFile(shaped).map(r => r.scId)).toEqual(["SC-1"]);
  });
});

// ── The distinction itself ────────────────────────────────────

describe("SC-2023: the distinction answers both ways", () => {
  test("what says a file should exist is bound, and what only mentions one is not", () => {
    expect(closestPatternFor(BOUND)?.patternName).toBe("file-exists");
    expect(closestPatternFor("AGENTS.md must exist and the scan must be current")?.patternName)
      .toBe("file-exists");
    for (const [id, statement] of MENTIONS) {
      expect(closestPatternFor(statement), `${id} was bound off a filename it only mentions`).toBeNull();
    }
  });
});

// ── AC-4: the mutant ──────────────────────────────────────────

/**
 * The one line the mutant rewrites: `findClosestPattern`'s end, where nothing
 * the statement SAYS matched. Declared here so a rename aborts loudly rather
 * than leaving a mutant byte-identical to the real source.
 */
const BINDING = "  return null; // #2040: a filename the statement only mentions is never a pattern";

/** The last resort #2040 removed, restored verbatim in behaviour. */
const RESTORED =
  "  { const t = statement.match(/\\b(\\S+\\.\\w{1,5})\\b/); " +
  "return t ? { patternName: \"file-exists\", rewrite: `${t[1]} exists`, ambiguous: true } : null; } " +
  "// MUTANT: the #2040 removal reverted";

export function buildMutantSource(src: string, signature = BINDING): string {
  const occurrences = src.split(signature).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `could not build the mutant: the binding signature appears ${occurrences} times, ` +
        `expected exactly 1. Either it was renamed, or a second copy decides the same ` +
        `question and restoring one would leave the other refusing.`,
    );
  }
  const restored = src.replace(signature, RESTORED);
  // The mutant runs from a temp directory, so every relative specifier has to
  // become absolute. One left behind kills it on module resolution, and a
  // mutant that cannot load is not a mutant.
  const relocated = restored.replace(
    /from "(\.\.?\/[A-Za-z0-9._\-/]+)"/g,
    (_m, spec: string) => `from "${resolve(SCRIPTS_DIR, spec)}"`,
  );
  const leftover = relocated.match(/from "\.\.?\//g) || [];
  if (leftover.length > 0) {
    throw new Error(
      `could not build the mutant: ${leftover.length} relative import(s) were not rewritten`,
    );
  }
  return relocated;
}

describe("SC-2024: a mutant with the fallback restored rewrites all three", () => {
  let dir = "";
  let mutant: {
    closestPatternFor: typeof closestPatternFor;
    decideRewrite: typeof decideRewrite;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "fallback-scope-mutant-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "config"), { recursive: true });
    // `loadRegistry` resolves `../config/matcher-registry.json` from the
    // module's own location, so the mutant needs one beside it. Without this
    // it throws on first use, and a throw is not a measurement.
    cpSync(
      join(ROOT, "config", "matcher-registry.json"),
      join(dir, "config", "matcher-registry.json"),
    );
    const path = join(dir, "scripts", "audit-specs.ts");
    writeFileSync(path, buildMutantSource(readFileSync(AUDIT_SPECS, "utf-8")));
    mutant = (await import(path)) as typeof mutant;
  });

  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("the mutant rewrites what the real source keeps", () => {
    // The mutant is proved FUNCTIONAL first: the bound control is rewritten by
    // both. A mutant that failed to load its registry declines everything,
    // which reads exactly like the mutation having been rejected.
    const control = mutant.decideRewrite(BOUND, mutant.closestPatternFor(BOUND));
    expect(control.kind, "the mutant rewrites nothing, so it is broken rather than mutated").toBe("rewrite");
    expect(control.kind === "rewrite" && control.statement).toBe(BOUND_REWRITE);

    // The named input on which mutant and original differ, run rather than
    // assumed. SC-1940 and SC-1943 coordinate a second claim, which #589's
    // fence used to catch; with the fence gone too, the restored last resort
    // rewrites them, so the removal of BOTH is what keeps them.
    for (const [id, statement, rewrite] of [
      ["SC-1940", SC_1940, "reference/rejected-constraints.md exists"],
      ["SC-1943", SC_1943, "package.json exists"],
      ["single-claim", SINGLE_CLAIM, "CODE-MAP.md exists"],
    ] as const) {
      const mutated = mutant.decideRewrite(statement, mutant.closestPatternFor(statement));
      expect(mutated.kind, `the mutant kept ${id}, so the mutation was never applied`).toBe("rewrite");
      expect(mutated.kind === "rewrite" && mutated.statement).toBe(rewrite);
      expect(decideRewrite(statement, closestPatternFor(statement)).kind, `the real source rewrote ${id}`)
        .toBe("keep");
    }
  });

  test("the mutant builder aborts when the binding moves", () => {
    // The harness's own failure mode: a mutation whose target was renamed
    // silently no-ops and every case above goes green over an unmutated copy.
    expect(() => buildMutantSource(readFileSync(AUDIT_SPECS, "utf-8"), "  return notAThing;"))
      .toThrow(/the binding signature appears 0 times/);
  });
});

// ── AC-5: the spec records it ─────────────────────────────────

describe("SC-2025: the spec records the population counts and the property", () => {
  test("the #589 section names both rewritten criteria, the counts, and #2040's removal", () => {
    const spec = readFileSync(join(ROOT, "specs", "SCAFFOLD-DECOMPOSITION-SPEC.md"), "utf-8");
    const at = spec.indexOf("## #589");
    expect(at, "the spec carries no #589 section").toBeGreaterThan(-1);
    const section = spec.slice(at);
    // Search the SLICE, not the document (#297): the ids and phrases below
    // appear elsewhere in a 1,200-line spec.
    expect(section.length, "the #589 section is empty").toBeGreaterThan(400);

    expect(section, "the spec does not name the criteria the fallback rewrote")
      .toContain("rejected-constraints.md");
    expect(section).toContain("package.json");
    expect(section, "the spec does not record the before and after population")
      .toMatch(/fallback rewrote (?:two|2)\b/i);
    expect(section, "the spec does not record that #2040 removed the fallback").toContain("#2040");
    expect(section, "the spec does not state the property that replaced the fence")
      .toMatch(/only mentions/i);
  });
});
