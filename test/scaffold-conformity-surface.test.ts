/**
 * Covers SC-2798 (RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md).
 *
 * #2599, ADR-024 decision 4: over budget is a refusal from the first release,
 * not a warning — #1069 measured a 95% warning firing on every run while the
 * headroom fell to 37 bytes. The conformity test rungate generates into every
 * consumer now measures that consumer's instruction surface and FAILS when its
 * peak is over the budget the consumer is held to (its own, from its rungate
 * config, or the default). A surface the measurement cannot read is refused
 * too, as UNMEASURED: a scaffolded consumer always has rules, so a tree with
 * none, or a rule that cannot be read, is broken, never a surface of zero.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { extractTestFailureCount } from "../gates/gate-executor";
import { instructionSurfaceViolations } from "../lib/conformity";
import { generateConformityTest } from "../lib/scaffold/steps";

const ROOT = join(import.meta.dir, "..");
const CONFORMITY = join(ROOT, "lib", "conformity.ts");

let scratch = "";
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "rg-2599-surface-"));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

let seq = 0;
const fill = (n: number) => "x".repeat(n);

/** A consumer tree: CLAUDE.md, AGENTS.md and one rule of `ruleBytes`, plus an optional config. */
function consumer(ruleBytes: number, config?: Record<string, unknown>): string {
  const root = join(scratch, `c-${seq++}`);
  mkdirSync(join(root, ".claude", "rules"), { recursive: true });
  writeFileSync(join(root, "CLAUDE.md"), fill(100));
  writeFileSync(join(root, "AGENTS.md"), fill(300));
  writeFileSync(join(root, ".claude", "rules", "big.md"), fill(ruleBytes));
  writeFileSync(join(root, "a.ts"), "export {};\n");
  if (config) {
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    writeFileSync(join(root, ".claude", "rungate", "config.json"), JSON.stringify(config) + "\n");
  }
  return root;
}

/**
 * Spawn the REAL `runInstructionSurfaceValidation` over a planted root.
 * `ran` exists because a spawned file that failed to load reports zero
 * failures, which is indistinguishable from the check passing.
 */
function runSurface1(projectRoot: string): { failures: number; ran: number; findings: Array<Record<string, string>> } {
  const file = join(scratch, `s-${seq++}.test.ts`);
  writeFileSync(
    file,
    `import { test } from "bun:test";\n` +
      `import { runInstructionSurfaceValidation, getFindings, clearFindings } from ${JSON.stringify(CONFORMITY)};\n` +
      `clearFindings();\n` +
      `runInstructionSurfaceValidation(${JSON.stringify(projectRoot)});\n` +
      `test("zz-report-findings", () => {\n` +
      `  console.log("FINDINGS:" + JSON.stringify(getFindings().filter(f => f.ruleId === "SURFACE-1")));\n` +
      `});\n`,
  );
  const r = Bun.spawnSync(["bun", "test", file], { cwd: ROOT, env: { ...process.env, RUNGATE_API_TAP: "" } });
  const out = `${r.stdout.toString()}${r.stderr.toString()}`;
  const marker = out.match(/FINDINGS:(\[.*\])/);
  const pass = Number(out.match(/(\d+) pass/)?.[1] ?? 0);
  return { failures: extractTestFailureCount(out), ran: pass + extractTestFailureCount(out), findings: marker ? JSON.parse(marker[1]) : [] };
}

describe("SC-2798: the generated conformity test refuses an over-budget consumer surface, and an unreadable one as UNMEASURED", () => {
  test("a surface within its budget passes, and one over it is refused naming the peak and the ceiling", () => {
    expect(instructionSurfaceViolations(consumer(2_000))).toEqual({ unmeasured: null, violations: [] });

    // 100 + 300 + 64,000: over the default budget's ceiling of 63,770.
    const over = instructionSurfaceViolations(consumer(64_000));
    expect(over.unmeasured).toBeNull();
    expect(over.violations).toHaveLength(1);
    expect(over.violations[0]).toContain("64,400");
    expect(over.violations[0]).toContain("63,770");
  });

  test("the budget is the consumer's own when its config sets one", () => {
    // 2,400 against a configured 2,500: the ceiling is 2,500 - 230 = 2,270.
    const own = instructionSurfaceViolations(consumer(2_000, { project: "c", instructionSurface: { budgetBytes: 2_500 } }));
    expect(own.violations).toHaveLength(1);
    expect(own.violations[0]).toContain("2,270");
    // A configured budget the 35% rule refuses is a violation of its own.
    const raised = instructionSurfaceViolations(consumer(2_000, { project: "c", instructionSurface: { budgetBytes: 50_000 } }));
    expect(raised.violations.some(v => v.includes("50,000") && v.includes("more than 35% above"))).toBe(true);
  });

  test("a tree the measurement cannot read is UNMEASURED, never a surface of zero", () => {
    const root = join(scratch, `bare-${seq++}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "hi");
    const v = instructionSurfaceViolations(root);
    expect(v.violations).toEqual([]);
    expect(v.unmeasured).toContain("UNMEASURED");
    expect(v.unmeasured).toContain("no .md files under");
  });

  test("the real check, spawned: green within budget, red over it, red and UNMEASURED when unreadable", () => {
    const within = runSurface1(consumer(2_000));
    expect(within.ran, "the spawned suite never loaded").toBeGreaterThan(1);
    expect(within.failures).toBe(0);
    expect(within.findings).toEqual([]);

    const over = runSurface1(consumer(64_000));
    expect(over.failures).toBe(1);
    expect(over.findings.map(f => f.severity)).toEqual(["FAIL"]);

    const bare = join(scratch, `bare-${seq++}`);
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, "CLAUDE.md"), "hi");
    const unreadable = runSurface1(bare);
    expect(unreadable.failures).toBe(1);
    expect(unreadable.findings).toHaveLength(1);
    expect(unreadable.findings[0].severity).toBe("FAIL");
    expect(unreadable.findings[0].message).toContain("UNMEASURED");
  });

  test("the generated conformity test runs it, and rungate's own copy is that generation", () => {
    const generated = generateConformityTest(ROOT);
    expect(generated).toContain("runInstructionSurfaceValidation(ROOT);");
    expect(generated).toMatch(/import \{[^}]*\brunInstructionSurfaceValidation\b[^}]*\} from/);
    expect(readFileSync(join(ROOT, "test", "scaffold-conformity.test.ts"), "utf-8")).toBe(generated);
  });
});
