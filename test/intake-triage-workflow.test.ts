/**
 * SC-2784 (ADR-020 Decision 2): a generated `consumer-intake.yml` triages a
 * consumer's issue when it is filed or labelled `from-consumer`, and every
 * day, through the published CLI; an outside reporter's issue is given the
 * label first, because GitHub drops the labels such an author sets.
 *
 * Named `intake-triage-…` rather than `consumer-…` so it does not join the
 * `test/consumer-*` population `test/consumer-no-rebuild-delegation.test.ts`
 * scans.
 */
import { describe, expect, test } from "bun:test";
import {
  CONSUMER_INTAKE_COMMANDS,
  CONSUMER_INTAKE_JOB,
  CONSUMER_INTAKE_SWEEP_DAYS,
  CONSUMER_INTAKE_WORKFLOW_FILE,
  buildConsumerIntakeWorkflow,
} from "../lib/scaffold/consumer-intake-workflow";
import { CONSUMER_INTAKE_GRACE_MS } from "../scripts/board-conformance";
import { spawnSync } from "child_process";
import { CONSUMER_LABEL, TRUSTED_ASSOCIATIONS } from "../lib/consumer-triage";
import { CLI_COMMANDS } from "../lib/cli-commands";
import { OWNED_FILES } from "../lib/scaffold/owned-files";

const OPTS = {
  runsOn: '"ubuntu-latest"',
  checkout: "actions/checkout@abc",
  setupBun: "oven-sh/setup-bun@def",
  setupBunWith: "          bun-version-file: .bun-version",
  setupBunEnv: "",
  version: "9.9.9",
};

type Step = { name?: string; if?: string; run?: string; env?: Record<string, string>; uses?: string };
const yml = () => buildConsumerIntakeWorkflow(OPTS);
const doc = () => Bun.YAML.parse(yml()) as {
  on: { issues: { types: string[] }; schedule: { cron: string }[] };
  permissions: Record<string, string>;
  jobs: Record<string, { if?: string; steps: Step[] }>;
};
const steps = () => doc().jobs[CONSUMER_INTAKE_JOB]!.steps;

describe("SC-2784: consumer-intake.yml triages on filing, on the label, and every day", () => {
  test("it fires on an issue opened or labelled, and on a daily schedule", () => {
    const d = doc();
    expect(d.on.issues.types.sort()).toEqual(["labeled", "opened"]);
    expect(d.on.schedule).toHaveLength(1);
    // One run a day: minute and hour fixed, every day of every month.
    expect(d.on.schedule[0]!.cron).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
  });

  test("a label event runs only for from-consumer; opened and the schedule always run", () => {
    const cond = doc().jobs[CONSUMER_INTAKE_JOB]!.if ?? "";
    expect(cond).toContain(`github.event.label.name == '${CONSUMER_LABEL}'`);
    expect(cond).toContain("github.event_name == 'schedule'");
    expect(cond).toContain("github.event.action == 'opened'");
  });

  test("the triage runs consumer-triage --write through the published CLI, with the job's own token", () => {
    const triage = steps().find(s => (s.run ?? "").includes("consumer-triage"))!;
    expect(triage.run).toContain(`bunx rungate@${OPTS.version} consumer-triage --repo "$GITHUB_REPOSITORY" --write`);
    expect(triage.env?.GITHUB_TOKEN).toBe("${{ secrets.GITHUB_TOKEN }}");
    expect(doc().permissions.issues).toBe("write");
  });

  test("an outside reporter's new issue gets from-consumer BEFORE the triage reads the tracker", () => {
    const s = steps();
    const label = s.findIndex(x => (x.run ?? "").includes(`--add-label ${CONSUMER_LABEL}`));
    const triage = s.findIndex(x => (x.run ?? "").includes("consumer-triage"));
    expect(label, "no step gives an outside reporter's issue the label").toBeGreaterThanOrEqual(0);
    expect(label).toBeLessThan(triage);
    const cond = s[label]!.if ?? "";
    expect(cond).toContain("github.event.action == 'opened'");
    // Exactly the associations whose marker counts, so "trusted" means one thing.
    for (const a of TRUSTED_ASSOCIATIONS) expect(cond).toContain(`"${a}"`);
    expect(cond).toContain("github.event.issue.author_association");
    // NOT trusted: the negation is what makes it the outsider branch.
    expect(cond).toContain("!contains(fromJSON(");
  });

  test("the issue number reaches the label step through env, never spliced into the script", () => {
    const label = steps().find(x => (x.run ?? "").includes("--add-label"))!;
    expect(label.run).not.toContain("${{");
    expect(label.env?.NUMBER).toBe("${{ github.event.issue.number }}");
  });

  test("every command it calls is registered, so the published CLI accepts it", () => {
    for (const c of CONSUMER_INTAKE_COMMANDS) expect(Object.keys(CLI_COMMANDS)).toContain(c);
    for (const c of CONSUMER_INTAKE_COMMANDS) expect(yml()).toContain(` ${c} `);
  });

  test("the scaffold owns the file, as a job-preserving managed workflow", () => {
    const row = OWNED_FILES.find(f => f.path === `.github/workflows/${CONSUMER_INTAKE_WORKFLOW_FILE}`);
    expect(row?.strategy).toBe("job-preserving");
  });
});

/**
 * #2379: the daily run labels an outside reporter's recent issue whose
 * `opened` run never happened. Only `opened` added the label, and the triage
 * reads only labelled issues, so a missed event meant never triaged.
 */
describe("#2379: the daily run labels an outside reporter's recent issue the opened run missed", () => {
  const isSweep = (x: Step) => (x.if ?? "").includes("github.event_name == 'schedule'") && (x.run ?? "").includes("--add-label");
  const sweep = () => steps().find(isSweep);

  test("a schedule-only step labels before the triage reads the tracker", () => {
    const s = steps();
    const at = s.findIndex(isSweep);
    expect(at, "no schedule step labels a missed issue").toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(s.findIndex(x => (x.run ?? "").includes("consumer-triage")));
    expect(sweep()!.if).toBe("${{ github.event_name == 'schedule' }}");
  });

  test("its window is the board's grace period, and its trusted set is the triage's", () => {
    expect(CONSUMER_INTAKE_SWEEP_DAYS * 24 * 60 * 60 * 1000).toBe(CONSUMER_INTAKE_GRACE_MS);
    expect(sweep()!.run).toContain(`${CONSUMER_INTAKE_SWEEP_DAYS} days ago`);
    expect(sweep()!.env?.TRUSTED).toBe(JSON.stringify(TRUSTED_ASSOCIATIONS));
    expect(sweep()!.run, "an event value spliced into the script").not.toContain("${{");
    // A failed tracker read must fail the step, not vanish into the pipe.
    expect(sweep()!.run).toContain("set -o pipefail");
  });

  test("its filter picks only a recent, open, unlabelled issue by an untrusted author", () => {
    const filter = /--jq '([^']+)'/.exec(sweep()!.run!)?.[1];
    expect(filter, "the step has no --jq filter to run").toBeDefined();
    const page = [
      { number: 1, created_at: "2026-11-17T10:00:00Z", author_association: "NONE", labels: [] },
      { number: 2, created_at: "2026-11-17T10:00:00Z", author_association: "OWNER", labels: [] },
      { number: 3, created_at: "2026-11-17T10:00:00Z", author_association: "CONTRIBUTOR", labels: [{ name: CONSUMER_LABEL }] },
      { number: 4, created_at: "2026-11-10T10:00:00Z", author_association: "NONE", labels: [] },
      { number: 5, created_at: "2026-11-17T10:00:00Z", author_association: "NONE", labels: [], pull_request: {} },
      { number: 6, created_at: "2026-11-17T10:00:00Z", author_association: "FIRST_TIME_CONTRIBUTOR", labels: [{ name: "bug" }] },
    ];
    const r = spawnSync("jq", ["-r", filter!], {
      input: JSON.stringify(page),
      encoding: "utf-8",
      env: { ...process.env, SINCE: "2026-11-16T00:00:00Z", TRUSTED: JSON.stringify(TRUSTED_ASSOCIATIONS) },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual(["1", "6"]);
  });
});
