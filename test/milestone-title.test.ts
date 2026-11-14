/**
 * #2057: one reader for a milestone title's family and phase.
 *
 * Four regexes read one grammar — `phaseOf` (lib/board-mirror.ts),
 * `phaseInFamily` and `familyOf` (lib/spec-placement.ts), and a fourth in
 * `scripts/status-view.ts` — and they disagreed at least four times: a double
 * space (round 2 of #1705), a parenthetical `Release (Phase 3)`, a mid-title
 * prefix, and a title saying "Phase" twice (review of #2055). Each was patched
 * one title shape at a time. An agreement test can only cover the shapes
 * somebody thought of, so the census below is the binding: the phase token is
 * spelled in one file.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { phaseOf } from "../lib/board-mirror";
import { inMilestoneFamily } from "../lib/live-issues";
import { readMilestoneTitle } from "../lib/milestone-title";
import { sourceFiles } from "../lib/source-census";
import { familyOf, phaseInFamily } from "../lib/spec-placement";

/** Every shape the four rounds found, and the ordinary ones. */
const SHAPES: readonly (string | null)[] = [
  "Pipeline Phase 6 — the board's state is a reading",
  "Convergence Phase 0",
  "Engine X Phase 12 — y",
  "Pipeline Phase 6 — starts after Phase 5 ships",
  "Phase 2 — x",
  "Pipeline  Phase 6 — a double space",
  "Release (Phase 3)",
  "Notes: Phase 4 — a prefix ending in punctuation",
  "TestPhase 3 — a word ending in Phase",
  "Convergence Machinery",
  "",
  null,
];

describe("#2057: readMilestoneTitle", () => {
  test("reads family and phase from the ordinary shapes", () => {
    expect(readMilestoneTitle("Pipeline Phase 6 — the board's state is a reading")).toEqual({
      family: "Pipeline",
      phase: 6,
    });
    expect(readMilestoneTitle("Engine X Phase 12 — y")).toEqual({ family: "Engine X", phase: 12 });
    expect(readMilestoneTitle("Phase 2 — x")).toEqual({ family: "", phase: 2 });
  });

  test("the family ends at the FIRST Phase, and a non-phase title is null", () => {
    expect(readMilestoneTitle("Pipeline Phase 6 — starts after Phase 5 ships")).toEqual({
      family: "Pipeline",
      phase: 6,
    });
    expect(readMilestoneTitle("Convergence Machinery")).toBeNull();
    expect(readMilestoneTitle("TestPhase 3 — a word ending in Phase")).toBeNull();
    expect(readMilestoneTitle("")).toBeNull();
    expect(readMilestoneTitle(null)).toBeNull();
  });

  test("any run of whitespace separates family from phase, and the family is trimmed", () => {
    // AI review of #2121: a double space left the family "Pipeline " with a
    // trailing space, so phaseOf read phase 6 while inMilestoneFamily said the
    // title belonged to no family, and plan-deps dropped the issue silently.
    expect(readMilestoneTitle("Pipeline  Phase 6")).toEqual({ family: "Pipeline", phase: 6 });
    expect(readMilestoneTitle("Pipeline\tPhase 6")).toEqual({ family: "Pipeline", phase: 6 });
    expect(phaseInFamily("Pipeline  Phase 6", "Pipeline")).toBe(6);
    expect(inMilestoneFamily("Pipeline  Phase 6", "Pipeline")).toBe(true);
    // Leading whitespace is no family, not a family of spaces.
    expect(readMilestoneTitle("  Phase 2 — x")).toEqual({ family: "", phase: 2 });
    expect(readMilestoneTitle("  Pipeline Phase 6")).toEqual({ family: "Pipeline", phase: 6 });
  });
});

describe("#2057: every former reader answers from the one reading", () => {
  test("phaseOf, familyOf, phaseInFamily and inMilestoneFamily agree on every shape", () => {
    for (const title of SHAPES) {
      const r = readMilestoneTitle(title);
      expect(phaseOf(title), `phaseOf(${JSON.stringify(title)})`).toBe(r?.phase ?? null);
      expect(familyOf(title), `familyOf(${JSON.stringify(title)})`).toBe(r?.family ?? null);
      if (r !== null && r.family !== "") {
        expect(phaseInFamily(title, r.family), `phaseInFamily(${JSON.stringify(title)})`).toBe(r.phase);
        expect(inMilestoneFamily(title, r.family)).toBe(true);
      }
    }
    // The unprefixed family has no prefix reading: an empty prefix is refused
    // upstream (lib/live-issues.ts), and it must not match every bare title.
    expect(phaseInFamily("Phase 2 — x", "")).toBeNull();
  });
});

describe("#2057: the phase token is spelled in one file", () => {
  const ROOT = join(import.meta.dir, "..");
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  test("the regex source `Phase (\\d+)` appears in exactly one file under lib/ and scripts/", () => {
    const found = sourceFiles(ROOT, ["lib", "scripts"]).filter(path =>
      code(readFileSync(join(ROOT, path), "utf-8")).includes(String.raw`Phase (\d+)`),
    );
    expect(found, "a second spelling of the phase token is a second decider of what a phase is").toEqual([
      "lib/milestone-title.ts",
    ]);
  });

  test("no file compiles a `<prefix> Phase` anchor: a family is compared, not interpolated", () => {
    const anchors = sourceFiles(ROOT, ["lib", "scripts"]).filter(path =>
      /\$\{(?:escapeRe\()?prefix\)?\}\s*Phase /.test(code(readFileSync(join(ROOT, path), "utf-8"))),
    );
    expect(anchors).toEqual([]);
  });
});
