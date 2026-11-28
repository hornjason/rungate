/**
 * #2966, reviews of PR #2967: `census-routing` reads a workflow emitter by the
 * shape of its name, and five by name, so "every emitter is routed" is
 * asserted here, not written down.
 *
 * Each `lib/scaffold/` export whose name contains Workflow, Step or Job, in
 * function or const form, is called from a planted suite, and the walk must
 * route that suite. Only exports that emit no workflow are excused, by name,
 * each with its reason. Each excused name must still be an export, so the
 * list cannot outlive what it excuses.
 *
 * The walk cannot see this suite: it names no emitter, because it plants its
 * callers in a scratch tree. So `WORKFLOW_SUITES_THE_WALK_CANNOT_SEE` carries
 * it, and the last case asserts that a `lib/scaffold/` change routes it.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { censusTestsFor, generatedWorkflowCensusSuites } from "../scripts/census-routing";

const REPO = join(import.meta.dir, "..");
const SELF = "test/census-emitter-shapes.test.ts";

/** Exports whose name contains Workflow, Step or Job and that emit no workflow YAML. */
const EMITS_NO_WORKFLOW: Record<string, string> = {
  // Steps of the scaffold itself: each writes files into a project.
  generateAgentBriefsStep: "a scaffold step",
  generateCodeMapStep: "a scaffold step",
  humanSteps: "a scaffold step list",
  readHumanSteps: "a scaffold step list",
  refreshScopedRulesStep: "a scaffold step",
  reportExternalAdoptionStep: "a scaffold step",
  reportInstructionSurfaceStep: "a scaffold step",
  runScaffoldWriteSteps: "the scaffold's step runner",
  isStepIncluded: "a scaffold step filter",
  // Text about a workflow merge, not a workflow.
  mergeWorkflowWarning: "a warning's text",
  mergeWorkflowIgnoredWarning: "a warning's text",
  // A step's id, not its YAML.
  aiReviewRunDriftStepId: "a step id",
};

function exportedNames(): string[] {
  const scaffold = join(REPO, "lib", "scaffold");
  return readdirSync(scaffold)
    .filter(f => f.endsWith(".ts"))
    .flatMap(f =>
      [...readFileSync(join(scaffold, f), "utf-8").matchAll(/^export (?:async )?(?:function|const) (\w*(?:Workflow|Step|Job)\w*)\b/gm)].map(m => m[1]!),
    );
}

describe("#2966: every workflow emitter lib/scaffold exports is read as one", () => {
  test("each export whose name contains Workflow, Step or Job is routed when a suite calls it, unless it emits no workflow", () => {
    const exported = exportedNames();
    expect(exported.length, "lib/scaffold exports almost no such name, so this asserted nothing").toBeGreaterThan(25);
    expect(Object.keys(EMITS_NO_WORKFLOW).filter(n => !exported.includes(n)), "an excused name is no longer exported").toEqual([]);

    const emitters = exported.filter(n => !(n in EMITS_NO_WORKFLOW));
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

  test("this suite is routed for a change under lib/scaffold, the only change that can turn it red", () => {
    for (const path of ["lib/scaffold/steps.ts", "lib/scaffold/a-new-emitter.ts"]) {
      expect(censusTestsFor([{ path, status: "M", added: [], removed: [] } as never]).tests, path).toContain(SELF);
    }
  });
});
