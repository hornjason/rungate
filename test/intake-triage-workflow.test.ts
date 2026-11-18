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
  CONSUMER_INTAKE_WORKFLOW_FILE,
  buildConsumerIntakeWorkflow,
} from "../lib/scaffold/consumer-intake-workflow";
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
