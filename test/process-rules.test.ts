/**
 * Covers SC-2747 (SPEC-TO-BOARD-PIPELINE-SPEC.md), #2049, ADR-014 decision 4.
 *
 * `rungate scaffold` installs the four-step process as an owned rules file,
 * generated from the same single source that this repository's own rule 9 is
 * checked against, so the consumer's copy and ours cannot drift.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { generateScopedRules } from "../lib/generators/agents-md";
import {
  ALIGNMENT_PROCESS_RULE_FILE,
  PROCESS_EXEMPTIONS,
  PROCESS_STEPS,
  alignmentProcessRule,
  ruleNineViolations,
} from "../lib/scaffold/process-rules";
import { mockProjectScan } from "../lib/generators/types";

const ROOT = join(import.meta.dir, "..");
const AGENTS = readFileSync(join(ROOT, "AGENTS.md"), "utf-8");

describe("SC-2747: the four-step process reaches a consumer as an owned rules file", () => {
  test("a consumer's scaffold emits it, loaded at launch, carrying every step", () => {
    const rule = generateScopedRules(mockProjectScan({ name: "consumer" })).find(
      r => r.filename === ALIGNMENT_PROCESS_RULE_FILE,
    );
    expect(rule, `the generator emits no ${ALIGNMENT_PROCESS_RULE_FILE}`).toBeDefined();
    expect(rule!.content, "a consumer's copy must load at launch, not on a path").not.toContain("paths:");
    for (const s of PROCESS_STEPS) {
      expect(rule!.content).toContain(`${s.step}. ${s.text}`);
      for (const name of s.names) expect(s.text, `step ${s.step}'s text drops its own phrase`).toContain(name);
    }
    for (const name of PROCESS_EXEMPTIONS.names) expect(PROCESS_EXEMPTIONS.text).toContain(name);
  });

  test("this repository's copy is the generated one, scoped because AGENTS.md carries rule 9 at launch", () => {
    const path = join(ROOT, ".claude", "rules", ALIGNMENT_PROCESS_RULE_FILE);
    expect(existsSync(path), `${ALIGNMENT_PROCESS_RULE_FILE} is not in this repository`).toBe(true);
    const ours = readFileSync(path, "utf-8").replace(/^generated-sha: .*\n/m, "");
    expect(ours).toBe(alignmentProcessRule({ scoped: true }));
  });

  test("this repository's rule 9 agrees with the source", () => {
    expect(ruleNineViolations(AGENTS)).toEqual([]);
  });
});

describe("SC-2747: the agreement check can fail, in both directions", () => {
  test("AGENTS.md losing a step's mechanism is named", () => {
    const lost = AGENTS.replace("`.github/workflows/adr-accepted.yml` places the plan", "a person places the plan");
    expect(lost, "the fixture edit did not apply").not.toBe(AGENTS);
    expect(ruleNineViolations(lost)).toEqual([`rule 9's step (3) does not say "adr-accepted.yml"`]);
  });

  test("a phrase moved to the wrong step is named, not found elsewhere in the rule", () => {
    // `Fixes #N` still appears in rule 9, under step (1) — the wrong step.
    const moved = AGENTS.replace("(4) Each PR says\n   `Fixes #N`;", "(4) Each PR says\n   it;").replace(
      "(1) Agree and file",
      "(1) Fixes #N. Agree and file",
    );
    expect(moved).not.toBe(AGENTS);
    expect(ruleNineViolations(moved)).toContain(`rule 9's step (4) does not say "Fixes #N"`);
  });

  test("an exemption dropped from AGENTS.md is named", () => {
    const dropped = AGENTS.replace("the diff decides, never the branch name", "the branch name decides");
    expect(dropped).not.toBe(AGENTS);
    expect(ruleNineViolations(dropped)).toEqual([
      `rule 9's exemptions do not say "the diff decides, never the branch name"`,
    ]);
  });

  test("no rule 9 at all is a violation, never an empty list", () => {
    expect(ruleNineViolations("# AGENTS.md\n\n1. **one rule**\n")).toEqual([
      "AGENTS.md has no rule 9 (a line starting `9. **`)",
    ]);
  });
});
