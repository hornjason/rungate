/**
 * #2966, review of PR #2967: `census-routing` reads a workflow emitter by the
 * shape of its name, so "every emitter is routed" is asserted here, not
 * written down.
 *
 * Each `lib/scaffold/` export named …Workflow, …Step or …Job, singular or
 * plural, is called from a planted suite, and the walk must route that suite.
 * The only exports excused are the scaffold's own steps, which write files
 * into a project and emit no workflow. Each excused name must still be an
 * export, so the list cannot outlive what it excuses.
 *
 * This lives in its own file because it enumerates `lib/scaffold/`: a suite
 * that reads a directory is routed when that directory changes, which is the
 * property #2966 is about. `test/census-routing.test.ts` asserts that it
 * enumerates nothing.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { generatedWorkflowCensusSuites } from "../scripts/census-routing";

const REPO = join(import.meta.dir, "..");

/** Exports that are steps of the scaffold itself: each writes into a project, none emits a workflow. */
const SCAFFOLD_STEPS = [
  "generateAgentBriefsStep",
  "generateCodeMapStep",
  "humanSteps",
  "readHumanSteps",
  "refreshScopedRulesStep",
  "reportExternalAdoptionStep",
  "reportInstructionSurfaceStep",
  "runScaffoldWriteSteps",
];

describe("#2966: every workflow emitter lib/scaffold exports is read as one", () => {
  test("each export named …Workflow, …Step or …Job is routed when a suite calls it, unless it is a step of the scaffold itself", () => {
    const scaffold = join(REPO, "lib", "scaffold");
    const exported = readdirSync(scaffold)
      .filter(f => f.endsWith(".ts"))
      .flatMap(f =>
        [...readFileSync(join(scaffold, f), "utf-8").matchAll(/^export (?:async )?function (\w+(?:Workflow|Step|Job)s?)\b/gm)].map(m => m[1]!),
      );
    expect(exported.length, "lib/scaffold exports almost no such name, so this asserted nothing").toBeGreaterThan(15);
    expect(SCAFFOLD_STEPS.filter(n => !exported.includes(n)), "an excused name is no longer exported").toEqual([]);

    const emitters = exported.filter(n => !SCAFFOLD_STEPS.includes(n));
    const dir = mkdtempSync(join(tmpdir(), "rg-emitter-shapes-"));
    try {
      mkdirSync(join(dir, "test"));
      for (const n of emitters) writeFileSync(join(dir, `test/${n}.test.ts`), `const out = ${n}(x);\n`);
      const routed = generatedWorkflowCensusSuites(dir);
      expect(emitters.filter(n => !routed.includes(`test/${n}.test.ts`)), "these emitters are not read as emitters").toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
