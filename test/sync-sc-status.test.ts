/**
 * Tests for sync-sc-status.ts conformity integration
 *
 * Validates that sync-sc-status uses matchPattern() from lib/conformity.ts
 * to check SCs that have no hand-written test, and flips their checkboxes
 * when the conformity assertion passes.
 */
import { describe, test, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import {
  findUncheckedSCs,
  findTestFilesForSCs,
  checkConformitySCs,
  flipCheckboxes,
  generateReport,
  scopedKey,
  findDuplicateSCIds,
  selectOnly,
  onlyRefusesShortFlip,
  parseOnlyArg,
  type UncheckedSC,
} from "../scripts/sync-sc-status";

import { scScanTestTimeout } from "./helpers/sc-scan-budget";

// Reaches the scan through `generateReport` (#1271), but every call here
// plants a fixture tree, so its worst case is 2ms. This line is the cost of
// the membership criterion being "reaches an entry point" rather than
// "reaches it against the real tree" — the wide direction is deliberate,
// and a budget this file never uses is the harmless half of it.
setDefaultTimeout(scScanTestTimeout());

const FIXTURE_ROOT = join(import.meta.dir, "fixtures", "sync-sc-fixture");
const FIXTURE_SPECS = join(FIXTURE_ROOT, "specs");
const FIXTURE_TEST = join(FIXTURE_ROOT, "test");

function setupFixture() {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  mkdirSync(FIXTURE_SPECS, { recursive: true });
  mkdirSync(FIXTURE_TEST, { recursive: true });
  // Create a file that conformity matchers can check
  writeFileSync(join(FIXTURE_ROOT, "AGENTS.md"), "# Project\n## Rules\n## Specs\n## Tests\n## Workflow\n## Project Identity\n## Key Files\n");
  writeFileSync(join(FIXTURE_ROOT, "README.md"), "# Readme\n");
}

function teardownFixture() {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
}

describe("sync-sc-status: conformity integration", () => {
  beforeEach(setupFixture);
  afterEach(teardownFixture);

  test("AC-1: sync-sc-status imports matchPattern from lib/conformity", () => {
    const scriptContent = readFileSync(
      join(import.meta.dir, "..", "scripts", "sync-sc-status.ts"),
      "utf-8"
    );
    expect(scriptContent).toContain("matchPattern");
    expect(scriptContent).toMatch(/from\s+["']\.\.\/lib\/conformity/);
  });

  test("AC-2: checkConformitySCs runs matchPattern and returns passing/failing sets", () => {
    // Create a spec with an SC that checks file existence (will pass because AGENTS.md exists)
    writeFileSync(
      join(FIXTURE_SPECS, "TEST-SPEC.md"),
      `---
doc-type: spec
testable: true
---
# Test Spec
- [ ] SC-9441: AGENTS.md exists
- [ ] SC-9442: README.md exists
- [ ] SC-9443: NONEXISTENT.md exists
`
    );

    const unchecked: UncheckedSC[] = [
      { id: "SC-9441", statement: "AGENTS.md exists", specFile: "TEST-SPEC.md" },
      { id: "SC-9442", statement: "README.md exists", specFile: "TEST-SPEC.md" },
      { id: "SC-9443", statement: "NONEXISTENT.md exists", specFile: "TEST-SPEC.md" },
    ];

    const result = checkConformitySCs(unchecked, FIXTURE_ROOT);

    // SC-9441 and SC-9442 should pass (files exist), SC-9443 should fail — scoped by spec file
    expect(result.passing.has(scopedKey("TEST-SPEC.md", "SC-9441"))).toBe(true);
    expect(result.passing.has(scopedKey("TEST-SPEC.md", "SC-9442"))).toBe(true);
    expect(result.passing.has(scopedKey("TEST-SPEC.md", "SC-9443"))).toBe(false);
    expect(result.failing.has(scopedKey("TEST-SPEC.md", "SC-9443"))).toBe(true);
  });

  test("AC-3: flipCheckboxes flips conformity-passing SCs", () => {
    writeFileSync(
      join(FIXTURE_SPECS, "TEST-SPEC.md"),
      `---
doc-type: spec
testable: true
---
# Test Spec
- [ ] SC-9441: AGENTS.md exists
- [x] SC-9440: Already checked
`
    );

    const flipped = flipCheckboxes("TEST-SPEC.md", ["SC-9441"], FIXTURE_SPECS);
    expect(flipped).toBe(1);

    const content = readFileSync(join(FIXTURE_SPECS, "TEST-SPEC.md"), "utf-8");
    expect(content).toContain("- [x] SC-9441:");
    expect(content).toContain("- [x] SC-9440:");
  });

  test("AC-4: --report flag produces per-spec coverage output", () => {
    const specCoverage = new Map<string, {
      testedPassing: string[];
      testedFailing: string[];
      conformityPassing: string[];
      conformityFailing: string[];
      unmatchable: string[];
    }>();

    specCoverage.set("TEST-SPEC.md", {
      testedPassing: ["SC-100"],
      testedFailing: ["SC-101"],
      conformityPassing: ["SC-102"],
      conformityFailing: ["SC-103"],
      unmatchable: ["SC-104"],
    });

    const report = generateReport(specCoverage);
    expect(report).toContain("TEST-SPEC.md");
    expect(report).toContain("tested-passing");
    expect(report).toContain("tested-failing");
    expect(report).toContain("unmatchable");
  });

  test("AC-5: conformity checking flips >= 5 SCs that pass on disk", () => {
    // Create a spec with multiple SCs that should pass conformity checks
    const specsDir = join(FIXTURE_ROOT, "specs");
    mkdirSync(specsDir, { recursive: true });

    // Create files that the SCs reference
    writeFileSync(join(FIXTURE_ROOT, "CLAUDE.md"), "@AGENTS.md\n");
    mkdirSync(join(FIXTURE_ROOT, "docs"), { recursive: true });
    mkdirSync(join(FIXTURE_ROOT, "test"), { recursive: true });
    writeFileSync(join(FIXTURE_ROOT, "test", "conformity.test.ts"), "// canary\n");
    writeFileSync(join(FIXTURE_ROOT, "package.json"), '{"name":"test","type":"module","scripts":{"test":"bun test"}}\n');

    // Write a spec with many SCs that should pass
    writeFileSync(
      join(specsDir, "MULTI-SPEC.md"),
      `---
doc-type: spec
testable: true
---
# Multi Spec
- [ ] SC-800: AGENTS.md exists
- [ ] SC-801: README.md exists
- [ ] SC-802: CLAUDE.md exists
- [ ] SC-803: package.json exists
- [ ] SC-804: specs/ directory exists
- [ ] SC-805: docs/ directory exists
- [ ] SC-806: test/ directory exists
`
    );

    const unchecked: UncheckedSC[] = [
      { id: "SC-800", statement: "AGENTS.md exists", specFile: "MULTI-SPEC.md" },
      { id: "SC-801", statement: "README.md exists", specFile: "MULTI-SPEC.md" },
      { id: "SC-802", statement: "CLAUDE.md exists", specFile: "MULTI-SPEC.md" },
      { id: "SC-803", statement: "package.json exists", specFile: "MULTI-SPEC.md" },
      { id: "SC-804", statement: "specs/ directory exists", specFile: "MULTI-SPEC.md" },
      { id: "SC-805", statement: "docs/ directory exists", specFile: "MULTI-SPEC.md" },
      { id: "SC-806", statement: "test/ directory exists", specFile: "MULTI-SPEC.md" },
    ];

    const result = checkConformitySCs(unchecked, FIXTURE_ROOT);
    expect(result.passing.size).toBeGreaterThanOrEqual(5);
  });

  test("AC-A1: only actually passing assertions get flipped; failures stay unchecked", () => {
    writeFileSync(
      join(FIXTURE_SPECS, "STRICT-SPEC.md"),
      `---
doc-type: spec
testable: true
---
# Strict Spec
- [ ] SC-9450: AGENTS.md exists
- [ ] SC-9451: DOES-NOT-EXIST.md exists
- [ ] SC-9452: ALSO-MISSING.md exists
`
    );

    const unchecked: UncheckedSC[] = [
      { id: "SC-9450", statement: "AGENTS.md exists", specFile: "STRICT-SPEC.md" },
      { id: "SC-9451", statement: "DOES-NOT-EXIST.md exists", specFile: "STRICT-SPEC.md" },
      { id: "SC-9452", statement: "ALSO-MISSING.md exists", specFile: "STRICT-SPEC.md" },
    ];

    const result = checkConformitySCs(unchecked, FIXTURE_ROOT);

    // Only SC-9450 passes (AGENTS.md exists) — scoped keys
    expect(result.passing.has(scopedKey("STRICT-SPEC.md", "SC-9450"))).toBe(true);
    expect(result.passing.has(scopedKey("STRICT-SPEC.md", "SC-9451"))).toBe(false);
    expect(result.passing.has(scopedKey("STRICT-SPEC.md", "SC-9452"))).toBe(false);
    expect(result.failing.has(scopedKey("STRICT-SPEC.md", "SC-9451"))).toBe(true);
    expect(result.failing.has(scopedKey("STRICT-SPEC.md", "SC-9452"))).toBe(true);
  });

  test("checkConformitySCs returns unmatchable SCs separately", () => {
    const unchecked: UncheckedSC[] = [
      { id: "SC-9461", statement: "some behavioral thing that no pattern matches", specFile: "TEST-SPEC.md" },
    ];

    const result = checkConformitySCs(unchecked, FIXTURE_ROOT);
    expect(result.unmatchable.has(scopedKey("TEST-SPEC.md", "SC-9461"))).toBe(true);
    expect(result.passing.has(scopedKey("TEST-SPEC.md", "SC-9461"))).toBe(false);
    expect(result.failing.has(scopedKey("TEST-SPEC.md", "SC-9461"))).toBe(false);
  });

  test("cross-spec isolation: same SC ID in two specs doesn't bleed", () => {
    mkdirSync(join(FIXTURE_ROOT, "lib"), { recursive: true });
    writeFileSync(join(FIXTURE_ROOT, "lib", "real-module.ts"), "export function doThing() {}\n");

    const unchecked: UncheckedSC[] = [
      { id: "SC-500", statement: "AGENTS.md exists", specFile: "SPEC-A.md" },
      { id: "SC-500", statement: "lib/nonexistent-file.ts exists", specFile: "SPEC-B.md" },
    ];

    const result = checkConformitySCs(unchecked, FIXTURE_ROOT);

    // SC-500 passes in SPEC-A (AGENTS.md exists) but fails in SPEC-B (file doesn't exist)
    expect(result.passing.has(scopedKey("SPEC-A.md", "SC-500"))).toBe(true);
    expect(result.passing.has(scopedKey("SPEC-B.md", "SC-500"))).toBe(false);
    expect(result.failing.has(scopedKey("SPEC-B.md", "SC-500"))).toBe(true);
  });

  test("findDuplicateSCIds detects duplicates across specs", () => {
    const scs: UncheckedSC[] = [
      { id: "SC-100", statement: "a", specFile: "SPEC-A.md" },
      { id: "SC-100", statement: "b", specFile: "SPEC-B.md" },
      { id: "SC-200", statement: "c", specFile: "SPEC-A.md" },
    ];

    const dupes = findDuplicateSCIds(scs);
    expect(dupes.size).toBe(1);
    expect(dupes.get("SC-100")).toEqual(["SPEC-A.md", "SPEC-B.md"]);
    expect(dupes.has("SC-200")).toBe(false);
  });

  test("scopedKey format is specFile::id", () => {
    expect(scopedKey("MY-SPEC.md", "SC-123")).toBe("MY-SPEC.md::SC-123");
  });
});

/**
 * #2054: `--only <id>` ticks the named criteria and nothing else. Without it
 * the tool flips every criterion a test claims, across every spec — 40 on
 * 2026-11-13 — so one criterion could not be ticked without forty.
 */
describe("#2054: --only narrows the flip to the named criteria", () => {
  const bySpec = new Map([
    ["SPEC-A.md", ["SC-1", "SC-2"]],
    ["SPEC-B.md", ["SC-3"]],
  ]);

  test("null keeps every passing criterion, as before", () => {
    const r = selectOnly(bySpec, null);
    expect(r.missing).toEqual([]);
    expect([...r.selected]).toEqual([...bySpec]);
  });

  test("named ids keep only themselves, and a spec left empty is dropped", () => {
    const r = selectOnly(bySpec, ["SC-2"]);
    expect(r.missing).toEqual([]);
    expect([...r.selected]).toEqual([["SPEC-A.md", ["SC-2"]]]);
  });

  test("an id that is not passing is MISSING, never silently skipped", () => {
    // A typo, or a criterion no test proves, must refuse: flipping zero and
    // exiting clean reads exactly like a successful tick.
    const r = selectOnly(bySpec, ["SC-2", "SC-9"]);
    expect(r.missing).toEqual(["SC-9"]);
  });

  test("with nothing passing at all, a named id is still MISSING", () => {
    // Review of #2058: an early "No SCs to flip" exit used to run before the
    // --only check, so a typo on a quiet tree exited 0.
    expect(selectOnly(new Map(), ["SC-9"]).missing).toEqual(["SC-9"]);
  });

  test("an id passing in two specs is AMBIGUOUS, never flipped in both", () => {
    // Review of #2058: the rest of the script scopes ids by spec (#330); a
    // bare --only id must not reach every spec that declares it.
    const twice = new Map([["SPEC-A.md", ["SC-1"]], ["SPEC-B.md", ["SC-1", "SC-3"]]]);
    const r = selectOnly(twice, ["SC-1"]);
    expect(r.ambiguous).toEqual([{ id: "SC-1", specs: ["SPEC-A.md", "SPEC-B.md"] }]);
  });

  test("--only refuses when a selected criterion was not flipped; a full run does not", () => {
    // Review of #2058: a declined write returned 0 and the run exited clean.
    expect(onlyRefusesShortFlip(["SC-1"], 1, 0)).toBe(true);
    expect(onlyRefusesShortFlip(["SC-1"], 1, 1)).toBe(false);
    expect(onlyRefusesShortFlip(null, 5, 0)).toBe(false);
  });

  test("--only is read in every spelling, and a missing value is a mistake, never 'all'", () => {
    // Review of #2058: `--only=SC-1` was not recognised, so onlyIds was null
    // and the run flipped every claimed criterion — failing open.
    expect(parseOnlyArg(["--only", "SC-1"])).toEqual(["SC-1"]);
    expect(parseOnlyArg(["--only=SC-1,SC-2"])).toEqual(["SC-1", "SC-2"]);
    expect(parseOnlyArg(["--dry-run", "--only", "SC-1"])).toEqual(["SC-1"]);
    expect(parseOnlyArg(["--only"])).toEqual([]);
    expect(parseOnlyArg(["--only", "--dry-run"])).toEqual([]);
    expect(parseOnlyArg(["--dry-run"])).toBeNull();
  });

  test("an id listed twice in ONE spec is not ambiguous", () => {
    // Review of #2058: a duplicated checkbox line inside one spec counted as
    // two specs and refused a legitimate flip.
    const r = selectOnly(new Map([["SPEC-A.md", ["SC-1", "SC-1"]]]), ["SC-1"]);
    expect(r.ambiguous).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  test("the script decides --only before it can exit on an empty flip list", () => {
    const src = readFileSync(join(import.meta.dir, "..", "scripts", "sync-sc-status.ts"), "utf-8");
    const decided = src.indexOf("selectOnly(bySpec, onlyIds)");
    const emptyExit = src.indexOf('console.log("No SCs to flip")');
    expect(decided).toBeGreaterThan(-1);
    expect(emptyExit).toBeGreaterThan(decided);
  });
});
