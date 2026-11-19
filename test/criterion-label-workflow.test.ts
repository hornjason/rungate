/**
 * #2467: `criterion-label.yml` is generated, so a consumer gets the
 * `needs-criterion` label that `board-conformance`'s `criteria-named`
 * reading is compared against. It was caller-owned here and ran
 * `bun scripts/criterion-label.ts`, a path no consumer has. The generated
 * job calls the published CLI, which carries the command since 0.8.36
 * (#2470).
 */
import { describe, expect, test } from "bun:test";
import { join } from "path";
import { CLI_COMMANDS } from "../lib/cli-commands";
import {
  CRITERION_LABEL_COMMANDS,
  CRITERION_LABEL_JOB,
  CRITERION_LABEL_WORKFLOW_FILE,
  buildCriterionLabelWorkflow,
} from "../lib/scaffold/criterion-label-workflow";
import { OWNED_FILES } from "../lib/scaffold/owned-files";
import { workflowCensus } from "../lib/scaffold/workflow-census";

const ROOT = join(import.meta.dir, "..");
const OPTS = {
  runsOn: '"ubuntu-latest"',
  checkout: "actions/checkout@abc",
  setupBun: "oven-sh/setup-bun@def",
  setupBunWith: "          bun-version-file: .bun-version",
  setupBunEnv: "",
  version: "9.9.9",
};

type Step = { name?: string; run?: string; env?: Record<string, string>; uses?: string };
const yml = () => buildCriterionLabelWorkflow(OPTS);
const doc = () =>
  Bun.YAML.parse(yml()) as {
    on: { issues: { types: string[] }; schedule: { cron: string }[]; workflow_dispatch: unknown };
    permissions: Record<string, string>;
    jobs: Record<string, { steps: Step[] }>;
  };
const label = () => doc().jobs[CRITERION_LABEL_JOB]!.steps.find(s => (s.run ?? "").includes("criterion-label"))!;

describe("#2467: criterion-label.yml is generated and calls the published CLI", () => {
  test("#2467: it fires on filing, on edits and reopening, daily, and by hand", () => {
    const on = doc().on;
    expect(on.issues.types).toEqual(["opened", "edited", "reopened"]);
    expect(on.schedule.length).toBe(1);
    expect("workflow_dispatch" in on).toBe(true);
  });

  test("#2467: it runs the published command, never a script path a consumer does not have", () => {
    const run = label().run ?? "";
    expect(run).toContain("bunx rungate@9.9.9 criterion-label");
    expect(yml()).not.toContain("scripts/criterion-label.ts");
    for (const c of CRITERION_LABEL_COMMANDS) expect(Object.keys(CLI_COMMANDS), `${c} is not a registered command`).toContain(c);
  });

  test("#2467: it comments only on an issue just opened, and never splices issue text into the script", () => {
    const run = label().run ?? "";
    const commentLines = run.split("\n").filter(l => l.includes("--comment"));
    expect(commentLines.length).toBe(1);
    expect(commentLines[0]).toMatch(/\$ACTION" = "opened"/);
    // The title and body are written by whoever opened the issue.
    expect(yml()).not.toMatch(/\$\{\{\s*github\.event\.issue\.(title|body)/);
    expect(label().env?.ISSUE).toMatch(/github\.event\.issue\.number/);
  });

  test("#2467: the scaffold owns the file, as a job-preserving managed workflow", () => {
    const row = OWNED_FILES.find(f => f.path === `.github/workflows/${CRITERION_LABEL_WORKFLOW_FILE}`);
    expect(row?.strategy, "criterion-label.yml is not in OWNED_FILES").toBe("job-preserving");
  });

  test("#2467: this repository's copy is the generated one, untouched", () => {
    const row = workflowCensus(ROOT).files.find(f => f.name === CRITERION_LABEL_WORKFLOW_FILE);
    expect(row?.status, row?.detail).toBe("generated-and-unchanged");
  });
});
