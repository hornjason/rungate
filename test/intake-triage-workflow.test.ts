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
  REMOVED_FILTER,
  SWEEP_FILTER,
  CONSUMER_TRIAGE_STEP_ID,
  buildConsumerIntakeWorkflow,
  triageRun,
} from "../lib/scaffold/consumer-intake-workflow";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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
    expect(sweep()!.run).toContain(`now - ${CONSUMER_INTAKE_SWEEP_DAYS * 86400} | todate`);
    // Review of #2380: no GNU-only `date -d`; ci.runner may not be Linux.
    expect(sweep()!.run).not.toMatch(/\bdate\b/);
    expect(sweep()!.env?.TRUSTED).toBe(JSON.stringify(TRUSTED_ASSOCIATIONS));
    expect(sweep()!.run, "an event value spliced into the script").not.toContain("${{");
    // A failed tracker read must fail the step, not vanish into the pipe.
    expect(sweep()!.run).toContain("set -o pipefail");
  });

  test("its filter picks only a recent, open, unlabelled issue by an untrusted author", () => {
    expect(sweep()!.run, "the step does not run the exported filter").toContain(`--jq '${SWEEP_FILTER}'`);
    const filter = SWEEP_FILTER;
    // Relative to now, because the filter reads jq's own clock.
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const recent = ago(1);
    const page = [
      { number: 1, created_at: recent, author_association: "NONE", labels: [] },
      { number: 2, created_at: recent, author_association: "OWNER", labels: [] },
      { number: 3, created_at: recent, author_association: "CONTRIBUTOR", labels: [{ name: CONSUMER_LABEL }] },
      { number: 4, created_at: ago(CONSUMER_INTAKE_SWEEP_DAYS + 5), author_association: "NONE", labels: [] },
      { number: 5, created_at: recent, author_association: "NONE", labels: [], pull_request: {} },
      { number: 6, created_at: recent, author_association: "FIRST_TIME_CONTRIBUTOR", labels: [{ name: "bug" }] },
      // #2390: the pipeline's own plan issue — github-actions[bot], association NONE.
      { number: 7, created_at: recent, author_association: "NONE", labels: [], user: { login: "github-actions[bot]", type: "Bot" } },
      { number: 8, created_at: recent, author_association: "NONE", labels: [], user: { login: "a-reporter", type: "User" } },
    ];
    const r = spawnSync("jq", ["-r", filter!], {
      input: JSON.stringify(page),
      encoding: "utf-8",
      env: { ...process.env, TRUSTED: JSON.stringify(TRUSTED_ASSOCIATIONS) },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual(["1", "6", "8"]);
  });

  // Review of #2380, round 2.
  test("a label a person took off a young issue is not put back, and an unreadable history labels nothing", () => {
    const run = sweep()!.run!;
    expect(run, "the step does not run the exported history filter").toContain(`--jq '${REMOVED_FILTER}'`);
    expect(run.indexOf(REMOVED_FILTER), "the history is read after the label is written").toBeLessThan(run.indexOf("gh issue edit"));
    expect(run).toMatch(/could not read #\$n's history; not labelled this run"; continue; \}/);
    const events = (removed: boolean) => [
      { id: 1, event: "labeled", label: { name: CONSUMER_LABEL } },
      ...(removed ? [{ id: 2, event: "unlabeled", label: { name: CONSUMER_LABEL } }] : []),
      { id: 3, event: "unlabeled", label: { name: "bug" } },
    ];
    const read = (e: unknown) => spawnSync("jq", ["-r", REMOVED_FILTER], { input: JSON.stringify(e), encoding: "utf-8" });
    expect(read(events(true)).stdout.trim()).toBe("2");
    expect(read(events(false)).stdout.trim(), "an unrelated label's removal read as this one's").toBe("");
  });

  test("one issue that cannot be labelled does not stop the rest, and a failed sweep does not stop the triage", () => {
    const run = sweep()!.run!;
    expect(run).toMatch(/--add-label from-consumer \\\n\s+\|\| echo "::warning title=consumer-intake::could not label #\$n/);
    expect((sweep() as Step & { "continue-on-error"?: boolean })["continue-on-error"]).toBe(true);
  });
});

/**
 * #2390: an issue a bot files is not a consumer report. The pipeline files its
 * own plan issues as `github-actions[bot]`, with author association `NONE`,
 * so "not OWNER, MEMBER or COLLABORATOR" alone labelled them `from-consumer`.
 * On 2026-11-18 the daily sweep labelled ADR-017's #2289 and #2290, and the
 * triage gave them ACTIVE and DUPLICATE.
 *
 * The failure matrix: a bot on the `opened` path; a bot in the sweep, beside
 * an outside person who must still be picked; and a person adding the label
 * to a bot's issue by hand, which still triages, because that is a decision.
 */
describe("#2390: an issue a bot filed is never labelled from-consumer", () => {
  test("the opened step's condition excludes a Bot author, alongside the trusted associations", () => {
    const label = steps().find(x => (x.run ?? "").includes("--add-label") && (x.if ?? "").includes("'opened'"))!;
    expect(label.if).toContain("github.event.issue.user.type != 'Bot'");
    // Still the outsider branch: the association test is kept, not replaced.
    expect(label.if).toContain("!contains(fromJSON(");
  });

  test("the sweep drops a Bot author and keeps an outside person filed beside it", () => {
    expect(SWEEP_FILTER).toContain('select(.user.type != "Bot")');
  });

  test("a person labelling a bot's issue by hand still triages it: the label event is not filtered by author", () => {
    const cond = doc().jobs[CONSUMER_INTAKE_JOB]!.if ?? "";
    expect(cond).toContain(`github.event.label.name == '${CONSUMER_LABEL}'`);
    expect(cond).not.toContain("user.type");
  });
});

// ── #2571: the triage's own token starts no workflow, so the job mirrors ──
//
// `consumer-triage --write` milestones an issue with GITHUB_TOKEN, and an event
// that token writes starts no workflow, so `phase-order.yml` never ran
// `board-mirror` for a triaged issue. #2568 declared `serves no criterion` and
// still sat with an empty Criteria cell, reddening B4 and E4 on every pull
// request. The job now runs the mirror itself, only after the triage wrote a
// verdict, as `criterion-label.yml` does after a filing (#2542).
describe("#2571: the board's Criteria column is mirrored after a triage writes", () => {
  type Job = { steps: (Step & { id?: string })[] };
  const steps = () => (Bun.YAML.parse(yml()) as { jobs: Record<string, Job> }).jobs[CONSUMER_INTAKE_JOB]!.steps;

  test("MT-1: the triage step reports whether it wrote, and the mirror runs only then, after it", () => {
    const all = steps();
    const triage = all.findIndex(s => s.id === CONSUMER_TRIAGE_STEP_ID);
    expect(triage, "no step carries the triage id").toBeGreaterThan(-1);
    const mirror = all.findIndex(s => (s.run ?? "").includes("board-mirror --project"));
    expect(mirror, "no step writes the Criteria column").toBeGreaterThan(triage);
    expect(all[mirror]!.if).toContain(`steps.${CONSUMER_TRIAGE_STEP_ID}.outputs.wrote == 'true'`);
    expect(all[mirror]!.if).toContain("!cancelled()");
    expect(all[mirror]!.env?.GITHUB_TOKEN).toBe("${{ secrets.RUNGATE_PROJECT_TOKEN }}");
    expect(all[mirror]!.env?.PROJECT_ID).toBe("${{ vars.RUNGATE_PROJECT_ID }}");
  });

  test("MT-2: the commands the job now calls are registered", () => {
    for (const c of ["board-mirror", "board-id"]) {
      expect(CONSUMER_INTAKE_COMMANDS as readonly string[]).toContain(c);
      expect(Object.keys(CLI_COMMANDS)).toContain(c);
    }
  });

  // The step's own shell, run under bash with a stand-in for the CLI.
  function runTriage(stdout: string, exit: number): { code: number | null; output: string } {
    const dir = mkdtempSync(join(tmpdir(), "rg-triage-run-"));
    const output = join(dir, "out");
    writeFileSync(output, "");
    // A stand-in CLI: prints the header it is given and exits as told,
    // ignoring the subcommand and flags the step passes it.
    const stub = join(dir, "stub.sh");
    writeFileSync(stub, `printf '%s\\n' ${JSON.stringify(stdout)}\nexit ${exit}\n`);
    const cli = `bash ${stub}`;
    const r = spawnSync("bash", ["-c", triageRun(cli)], {
      env: { ...process.env, RUNNER_TEMP: dir, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: "o/r" },
      encoding: "utf-8",
    });
    const text = readFileSync(output, "utf-8");
    rmSync(dir, { recursive: true, force: true });
    return { code: r.status, output: text };
  }

  const HEADER = "consumer-triage — o/r: 5 open from-consumer issue(s), 2 with no verdict";
  const SET = `${HEADER}\n  #12  ACTIVE → "Engine Phase 10" — lowest open phase\n      milestone "Engine Phase 10"\n      verdict comment`;

  test("MT-3: a run that set a milestone says wrote=true; one that set none says nothing", () => {
    expect(runTriage(SET, 0)).toEqual({ code: 0, output: "wrote=true\n" });
    expect(runTriage("consumer-triage — o/r: 5 open from-consumer issue(s), 0 with no verdict", 0)).toEqual({
      code: 0,
      output: "",
    });
  });

  test("MT-3b: pending issues the triage refused or left wrote nothing, so the mirror does not run (review of #2572)", () => {
    const refused = `${HEADER}\n  #12  REFUSED — ambiguous\n  #13  LEFT — not a consumer report`;
    expect(runTriage(refused, 1)).toEqual({ code: 1, output: "" });
  });

  test("MT-4: a triage that failed part-way still reports what it wrote, and the step stays red", () => {
    expect(runTriage(`${SET}\n  #14  ACTIVE → "Engine Phase 10" — x\n      FAILED: 502 — no verdict comment`, 1)).toEqual({
      code: 1,
      output: "wrote=true\n",
    });
  });

  test("MT-5: the line the step reads is the line consumer-triage prints after setting a milestone", () => {
    const script = readFileSync(join(import.meta.dir, "..", "scripts", "consumer-triage.ts"), "utf-8");
    expect(script).toContain("await gh.setMilestone(repo, issue.number, triage.milestone);\n        row.results.push(`milestone \"${triage.milestone}\"`);");
    expect(script).toContain("for (const x of r.results) console.log(`      ${x}`);");
  });
});
