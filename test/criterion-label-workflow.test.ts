/**
 * #2467: `criterion-label.yml` is generated, so a consumer gets the
 * `needs-criterion` label that `board-conformance`'s `criteria-named`
 * reading is compared against. It was caller-owned here and ran
 * `bun scripts/criterion-label.ts`, a path no consumer has. The generated
 * job calls the published CLI, which carries the command since 0.8.36
 * (#2470).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
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
import { stubBunx } from "./helpers/stub-bunx";

const ROOT = join(import.meta.dir, "..");
const OPTS = {
  runsOn: '"ubuntu-latest"',
  checkout: "actions/checkout@abc",
  setupBun: "oven-sh/setup-bun@def",
  setupBunWith: "          bun-version-file: .bun-version",
  setupBunEnv: "",
  version: "9.9.9",
};

type Step = { id?: string; name?: string; run?: string; env?: Record<string, string>; uses?: string; if?: string };
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

/**
 * #2542, serving SC-2625 without completing it. Two halves, one file.
 *
 * The sweep: `criterion-successor --sweep` (#2541) runs on the daily schedule
 * and by hand, so a close whose event the workflow missed still gets its
 * successor within a day.
 *
 * The mirror: a successor filed with the job's own GITHUB_TOKEN starts no
 * workflow, so `phase-order.yml` never wrote #2544's Criteria column or queue
 * label. `specs-placed.yml`, running by coincidence, did. So a run that files
 * a successor runs the same two board-mirror steps itself, the way
 * `specs-placed.yml` and `adr-accepted.yml` already do after their filings.
 */
describe("#2542: the sweep runs daily, and a filed successor reaches the board", () => {
  const steps = () => doc().jobs[CRITERION_LABEL_JOB]!.steps;
  const sweep = () => steps().find(s => (s.run ?? "").includes("criterion-successor --sweep"));
  const queue = () => steps().find(s => (s.run ?? "").includes("board-mirror --queue-label"));
  const criteria = () => steps().find(s => (s.run ?? "").includes('board-mirror --project "$project" --write'));

  test("#2542: the sweep runs the published --sweep mode, on the schedule and by hand only, with the job's own token", () => {
    const step = sweep();
    expect(step, "no step runs criterion-successor --sweep").toBeDefined();
    expect(step!.run).toContain('bunx rungate@9.9.9 criterion-successor --sweep --repo "$GITHUB_REPOSITORY" --write');
    expect(step!.if).toBe("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'");
    expect(step!.env).toEqual({ GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" });
  });

  test("#2542: after a filing, the queue label runs with the job's token and the Criteria column with the board's", () => {
    const q = queue();
    const c = criteria();
    expect(q, "no step writes the queue label").toBeDefined();
    expect(c, "no step writes the Criteria column").toBeDefined();
    expect(q!.run).toContain('bunx rungate@9.9.9 board-mirror --queue-label --repo "$GITHUB_REPOSITORY" --write');
    expect(q!.env).toEqual({ GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" });
    expect(c!.env).toEqual({ GITHUB_TOKEN: "${{ secrets.RUNGATE_PROJECT_TOKEN }}", PROJECT_ID: "${{ vars.RUNGATE_PROJECT_ID }}" });
    // No board configured is a warning naming UNMEASURED, never a red run.
    expect(c!.run).toContain("UNMEASURED — no board is configured");
    for (const cmd of ["board-mirror", "board-id"]) {
      expect(CRITERION_LABEL_COMMANDS as readonly string[], `${cmd} is called but not declared`).toContain(cmd);
      expect(Object.keys(CLI_COMMANDS)).toContain(cmd);
    }
  });

  test("#2542: the mirror steps run only when a successor step reported a filing, and never after a cancel", () => {
    const ids = new Set(steps().map(s => s.id).filter(Boolean));
    for (const step of [queue()!, criteria()!]) {
      const cond = step.if ?? "";
      expect(cond).toContain("!cancelled()");
      const named = [...cond.matchAll(/steps\.([\w-]+)\.outputs\.filed == 'true'/g)].map(m => m[1]!);
      // Both successor steps, by ids that exist: a typo here is a step that never runs.
      expect(named.sort()).toEqual([successor()!.id!, sweep()!.id!].sort());
      for (const id of named) expect(ids.has(id), `${id} is not a step id`).toBe(true);
    }
  });

  // The two successor steps' scripts, run for real against a stubbed bunx: the
  // filed flag is the only thing the mirror steps read, so it is what is asserted.
  for (const which of ["close", "sweep"] as const) {
    test(`#2542: the ${which} step reports a filing, and keeps the command's own exit code`, () => {
      const step = which === "close" ? successor()! : sweep()!;
      const run = (stub: string) => {
        const dir = mkdtempSync(join(tmpdir(), "rg-2542-"));
        const out = join(dir, "output");
        Bun.write(out, "");
        const proc = Bun.spawnSync(["bash", "-c", step.run!], {
          env: { PATH: stubBunx(stub), RUNNER_TEMP: dir, GITHUB_OUTPUT: out, ISSUE: "5", GITHUB_REPOSITORY: "o/n" },
        });
        return { code: proc.exitCode, output: readFileSync(out, "utf-8") };
      };
      expect(run('echo "filed #9: TST-1: a thing (in Fixture Phase 1)"')).toEqual({ code: 0, output: "filed=true\n" });
      expect(run('echo "leave TST-1: named by another open issue"')).toEqual({ code: 0, output: "" });
      // One filed, one failed: the board still needs the mirror, and the run stays red.
      expect(run('echo "filed #9: TST-1: a thing (in Fixture Phase 1)"; exit 1')).toEqual({ code: 1, output: "filed=true\n" });
      expect(run('echo "criterion-successor: UNMEASURED — no spec" >&2; exit 2')).toEqual({ code: 2, output: "" });
    });
  }
});
