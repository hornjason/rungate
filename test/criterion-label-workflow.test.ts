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

type Step = { name?: string; run?: string; env?: Record<string, string>; uses?: string; if?: string };
const yml = () => buildCriterionLabelWorkflow(OPTS);
const doc = () =>
  Bun.YAML.parse(yml()) as {
    on: { issues: { types: string[] }; schedule: { cron: string }[]; workflow_dispatch: unknown };
    permissions: Record<string, string>;
    jobs: Record<string, { steps: Step[] }>;
  };
const label = () => doc().jobs[CRITERION_LABEL_JOB]!.steps.find(s => (s.run ?? "").includes("criterion-label "))!;
const successor = () => doc().jobs[CRITERION_LABEL_JOB]!.steps.find(s => (s.run ?? "").includes("criterion-successor"));

describe("#2467: criterion-label.yml is generated and calls the published CLI", () => {
  test("#2467: it fires on filing, on edits and reopening, daily, and by hand — and on closing for #2532", () => {
    const on = doc().on;
    expect(on.issues.types).toEqual(["opened", "edited", "reopened", "closed"]);
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

/**
 * #2532, serving SC-2625 without completing it: when an issue closes, the
 * generated job runs `rungate criterion-successor` on it, so a criterion whose
 * last open issue closed unticked gets a successor filed and milestoned with
 * no person touching a label, milestone or body. The command shipped in 0.8.40
 * (#2490, #2536): a generated workflow may only call a published command.
 */
describe("#2532: on a closed issue, the job files a successor for each criterion it left owed", () => {
  test("#2532: the successor step runs the published command on the closed issue, with --write", () => {
    const step = successor();
    expect(step, "no step runs criterion-successor").toBeDefined();
    expect(step!.run).toContain('bunx rungate@9.9.9 criterion-successor --issue "$ISSUE" --repo "$GITHUB_REPOSITORY" --write');
    expect(CRITERION_LABEL_COMMANDS as readonly string[]).toContain("criterion-successor");
    expect(Object.keys(CLI_COMMANDS)).toContain("criterion-successor");
  });

  test("#2532: it runs only when an issue closes, and the label step never runs then", () => {
    expect(successor()!.if).toBe("github.event_name == 'issues' && github.event.action == 'closed'");
    expect(label().if, "the label step runs on a close too").toBe("github.event.action != 'closed'");
  });

  test("#2532: it holds the job's own token, and the issue number reaches it through env, never the script text", () => {
    expect(successor()!.env).toEqual({ GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}", ISSUE: "${{ github.event.issue.number }}" });
    expect(successor()!.run).not.toMatch(/\$\{\{/);
    expect(doc().permissions).toEqual({ contents: "read", issues: "write" });
  });
});
