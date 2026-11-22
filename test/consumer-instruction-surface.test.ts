/**
 * Covers SC-2796 (RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md).
 *
 * #2597, ADR-024 decision 1: rungate measured its own instruction surface and
 * nothing measured the one it hands a consumer. One consumer's rendered tree
 * read 2,003,937 bytes at peak — 3,131% of the budget — and no scaffold run,
 * generated test or workflow said so. A scaffold or re-scaffold run now
 * measures the consumer's launch and peak surface with the same
 * `measureConcurrentLoad` (which takes the launch surface from
 * `measureSurface`) and reports it with its largest contributors.
 *
 * Reported only, here. Refusing an over-budget surface is SC-2798.
 *
 * Covers SC-2797 (RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md) as well.
 *
 * #2598, ADR-024 decision 3: the budget that reading is held to is the
 * consumer's own when its rungate config sets one, and `SURFACE_BUDGET_BYTES`
 * when it does not, and the report says which. A budget the consumer could
 * set freely would constrain nothing, so a configured budget may sit at most
 * 35% above the measured peak — the rule rungate holds its own budget to —
 * and one past that is REFUSED, which fails the scaffold run. That holds below
 * the default as well as above it (review, PR #2622).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { configuredSurfaceBudget } from "../lib/config-loader";
import { reportInstructionSurfaceStep } from "../lib/scaffold/steps";
import { ScaffoldConfigUnreadable, assertScaffoldConfigReadable, runScaffoldWriteSteps } from "../lib/scaffold/write-steps";
import { SURFACE_BUDGET_BYTES, SurfaceUnmeasured, measureConcurrentLoad } from "../scripts/check-instruction-surface";

const ROOT = join(import.meta.dir, "..");
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "rg-2597-surface-"));
  made.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const fill = (n: number) => "x".repeat(n);

/** Launch 2,450 bytes over four files; peak 2,950 on src/a.ts, where the scoped rule joins. */
const consumer = () =>
  tree({
    "CLAUDE.md": fill(100),
    "AGENTS.md": fill(300),
    ".claude/rules/big.md": fill(2000),
    ".claude/rules/small.md": fill(50),
    ".claude/rules/scoped.md": `---\npaths:\n  - "src/**"\n---\n${fill(500)}`,
    "src/a.ts": "export {};\n",
  });


describe("SC-2796: a scaffold run reports the consumer's instruction surface", () => {
  test("launch and peak are the numbers measureConcurrentLoad takes, and the budget is named", () => {
    const root = consumer();
    const actions: string[] = [];
    reportInstructionSurfaceStep(root, actions);
    const reading = measureConcurrentLoad(root);
    const line = actions.find(a => a.startsWith("SURFACE:"));
    expect(line, `no SURFACE line among: ${actions.join(" | ")}`).toBeDefined();
    expect(line).toContain(`launch ${reading.launch.totalBytes.toLocaleString()} bytes`);
    expect(line).toContain(`peak ${reading.peakBytes.toLocaleString()} bytes on src/a.ts`);
    expect(line).toContain(`budget ${SURFACE_BUDGET_BYTES.toLocaleString()} (default), 5% used`);
    // Four files load at launch: the path-scoped rule loads on demand and is
    // not counted among them.
    expect(line).toContain("over 4 files");
    expect(reading.launch.entries.filter(e => e.excluded === null)).toHaveLength(4);
    // The planted tree's own arithmetic, so the agreement above is not two
    // readings of the same wrong number.
    expect(reading.launch.totalBytes).toBe(2450);
    expect(reading.peakBytes).toBe(2950);
  });

  test("the largest contributors are named, largest first, path-scoped rules not billed at launch", () => {
    const root = consumer();
    const actions: string[] = [];
    reportInstructionSurfaceStep(root, actions);
    const largest = actions.find(a => a.startsWith("SURFACE: largest at launch"));
    expect(largest, actions.join(" | ")).toBeDefined();
    const order = [".claude/rules/big.md", "AGENTS.md", "CLAUDE.md"].map(f => largest!.indexOf(f));
    expect(order.every(i => i >= 0), largest).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(largest).not.toContain("scoped.md");
    const peakRules = actions.find(a => a.startsWith("SURFACE: on src/a.ts"));
    expect(peakRules, "the scoped rule that makes the peak is not named").toContain(".claude/rules/scoped.md");
  });

  test("a tree with no rules is UNMEASURED, never a surface of zero", () => {
    const root = tree({ "CLAUDE.md": "hi", "AGENTS.md": "hi" });
    const actions: string[] = [];
    reportInstructionSurfaceStep(root, actions);
    expect(actions.some(a => a.startsWith("SURFACE:")), actions.join(" | ")).toBe(false);
    const line = actions.find(a => a.startsWith("UNMEASURED: instruction surface"));
    expect(line, actions.join(" | ")).toContain("no .md files under");
  });

  test("a rule symlinked to nothing is UNMEASURED, and does not abort the run", () => {
    // A scaffold run on this tree finished before the step existed (review,
    // PR #2619): the measurement's read of the dangling rule throws ENOENT.
    const root = consumer();
    symlinkSync(join(root, "nowhere.md"), join(root, ".claude", "rules", "dangling.md"));
    const actions: string[] = [];
    reportInstructionSurfaceStep(root, actions);
    expect(actions.some(a => a.startsWith("SURFACE:")), actions.join(" | ")).toBe(false);
    const line = actions.find(a => a.startsWith("UNMEASURED: instruction surface"));
    expect(line, actions.join(" | ")).toContain("dangling.md");
    expect(line).toContain("ENOENT");
  });

  test("only an unreadable tree is UNMEASURED: any other failure in the measurement propagates", () => {
    const root = consumer();
    const unreadable: string[] = [];
    reportInstructionSurfaceStep(root, unreadable, () => {
      throw new SurfaceUnmeasured("planted: nothing to measure");
    });
    expect(unreadable).toEqual(["UNMEASURED: instruction surface — planted: nothing to measure"]);
    // A defect in the measurement is not a tree it could not read, so it is
    // not reported as one (review, PR #2619).
    const broken: string[] = [];
    expect(() =>
      reportInstructionSurfaceStep(root, broken, () => {
        throw new TypeError("planted: a defect in the measurement");
      }),
    ).toThrow("planted: a defect in the measurement");
    expect(broken).toEqual([]);
  });

  test("a real scaffold run reports it, after the rules it wrote", () => {
    const root = tree({ "package.json": JSON.stringify({ name: "consumer", version: "0.0.0" }) });
    const actions: string[] = [];
    runScaffoldWriteSteps(root, "node" as never, actions);
    const at = actions.findIndex(a => a.startsWith("SURFACE:"));
    expect(at, `the scaffold run reported no surface: ${actions.filter(a => /SURFACE|UNMEASURED/.test(a)).join(" | ")}`).toBeGreaterThanOrEqual(0);
    // It describes the tree this run left, so it comes after every write.
    const lastWrite = actions.reduce((i, a, n) => (/^(CREATED|UPDATED|REPLACED|GENERATED|REGENERATED|REFRESHED)/.test(a) ? n : i), -1);
    expect(at, "the surface was measured before the run finished writing what loads").toBeGreaterThan(lastWrite);
  });

  test("the measuring script ships, because published lib code now imports it", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as { files: string[] };
    expect(pkg.files).toContain("scripts/check-instruction-surface.ts");
  });
});

/** Write a rungate config in either layout the loader reads. */
function withConfig(root: string, layout: "directory" | "monolith", config: Record<string, unknown>): string {
  const rel = layout === "directory" ? [".claude", "rungate", "config.json"] : [".claude", "rungate.json"];
  mkdirSync(join(root, ...rel.slice(0, -1)), { recursive: true });
  writeFileSync(join(root, ...rel), JSON.stringify(config, null, 2) + "\n");
  return root;
}

/** A consumer whose peak is exactly 60,000 bytes: 100 + 300 + 59,600, nothing path-scoped. */
const big = () =>
  tree({ "CLAUDE.md": fill(100), "AGENTS.md": fill(300), ".claude/rules/big.md": fill(59_600), "src/a.ts": "export {};\n" });

const surfaceLine = (actions: string[]) => actions.find(a => a.startsWith("SURFACE: launch")) ?? `(no SURFACE line: ${actions.join(" | ")})`;
const refusal = (actions: string[]) => actions.find(a => a.startsWith("REFUSED: instruction surface budget"));

describe("SC-2797: the consumer's budget comes from its rungate config, defaults to SURFACE_BUDGET_BYTES, and may not sit more than 35% above what it measures", () => {
  test("no config, or a config naming no budget: the default, and the report says it is the default", () => {
    for (const root of [consumer(), withConfig(consumer(), "directory", { project: "c" })]) {
      expect(configuredSurfaceBudget(root)).toBeNull();
      const actions: string[] = [];
      reportInstructionSurfaceStep(root, actions);
      expect(surfaceLine(actions)).toContain("budget 64,000 (default), 5% used");
      expect(refusal(actions)).toBeUndefined();
    }
  });

  test("a budget the config sets is the one the reading is held to, in either layout", () => {
    for (const layout of ["directory", "monolith"] as const) {
      const root = withConfig(consumer(), layout, { project: "c", instructionSurface: { budgetBytes: 3000 } });
      expect(configuredSurfaceBudget(root), layout).toBe(3000);
      const actions: string[] = [];
      reportInstructionSurfaceStep(root, actions);
      // 2,950 of 3,000.
      expect(surfaceLine(actions), layout).toContain("budget 3,000 (rungate config), 98% used");
      expect(refusal(actions), layout).toBeUndefined();
    }
  });

  test("a set budget more than 35% above the peak is refused even below the default", () => {
    // 50,000 against a 2,950-byte peak is 1,595% above it, though below 64,000.
    const root = withConfig(consumer(), "directory", { project: "c", instructionSurface: { budgetBytes: 50_000 } });
    const actions: string[] = [];
    reportInstructionSurfaceStep(root, actions);
    const why = refusal(actions);
    expect(why, actions.join(" | ")).toBeDefined();
    // 2,950 × 1.35 is 3,982.5, so 3,983 is the most allowed.
    for (const figure of ["50,000", "2,950", "3,983"]) expect(why).toContain(figure);
    expect(surfaceLine(actions)).toContain("budget 64,000 (default)");
  });

  test("raising it is allowed to 35% above the measured peak, and refused one byte past that", () => {
    const allowed = withConfig(big(), "directory", { project: "c", instructionSurface: { budgetBytes: 81_000 } });
    expect(measureConcurrentLoad(allowed).peakBytes).toBe(60_000);
    const ok: string[] = [];
    reportInstructionSurfaceStep(allowed, ok);
    expect(surfaceLine(ok)).toContain("budget 81,000 (rungate config)");
    expect(refusal(ok), ok.join(" | ")).toBeUndefined();

    const raised = withConfig(big(), "directory", { project: "c", instructionSurface: { budgetBytes: 81_001 } });
    const refused: string[] = [];
    reportInstructionSurfaceStep(raised, refused);
    const why = refusal(refused);
    expect(why, refused.join(" | ")).toBeDefined();
    for (const figure of ["81,001", "60,000", "81,000"]) expect(why).toContain(figure);
    // The reading is still reported, against the default it falls back to.
    expect(surfaceLine(refused)).toContain("budget 64,000 (default)");
  });

  test("a budget that is not a positive whole number of bytes is a config the scaffold cannot read, never the default", () => {
    for (const bad of ["64000", 0, -1, 1.5, null]) {
      const root = withConfig(consumer(), "directory", { project: "c", instructionSurface: { budgetBytes: bad } });
      expect(() => configuredSurfaceBudget(root), String(bad)).toThrow();
      expect(() => assertScaffoldConfigReadable(root), String(bad)).toThrow(ScaffoldConfigUnreadable);
    }
  });

  test("a real scaffold run refuses a raised budget, so the run fails and says why", () => {
    const root = tree({ "package.json": JSON.stringify({ name: "consumer", version: "0.0.0" }) });
    withConfig(root, "directory", { project: "consumer", instructionSurface: { budgetBytes: 10_000_000 } });
    const actions: string[] = [];
    runScaffoldWriteSteps(root, "node" as never, actions);
    const why = refusal(actions);
    expect(why, actions.filter(a => /SURFACE|REFUSED|UNMEASURED/.test(a)).join(" | ")).toBeDefined();
    expect(why).toContain("10,000,000");
  });
});
