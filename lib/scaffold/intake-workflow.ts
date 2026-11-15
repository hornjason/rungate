/**
 * `.github/workflows/intake.yml`, generated — #2233.
 *
 * Jason decided on #1126 (2026-11-15) that each intake source runs on its own
 * trigger, not on scaffold: "scaffold" reads as a one-time setup step, so
 * nobody re-runs it to re-mine, and intake should run when its data appears.
 * For `fix-commits` the data is the history of the default branch, and the
 * trigger is a push to it.
 *
 * ## Full history, or the reading is of the clone
 *
 * `mineFixCommits` reports `SHALLOW_HISTORY` on a shallow clone, and
 * `actions/checkout` clones to depth 1 unless told otherwise. That depth is
 * the only reason the source read UNMEASURED on a runner, so the checkout
 * sets `fetch-depth: 0`.
 *
 * ## Advisory, and never silent
 *
 * `rungate intake` exits 0 on every reading (#2248), so a reading never turns
 * the run red: an unreadable source says nothing about the push that fired
 * it. UNMEASURED is printed as the command prints it and raised as a warning
 * annotation, so it is visible on the run without being mistaken for zero.
 * A non-zero exit is the command refusing its arguments or `bunx` failing,
 * which is the tool broken, and the step goes red on it.
 *
 * ## It calls the published CLI
 *
 * A consumer has `node_modules/rungate`, not `scripts/`, so the step runs
 * `bunx rungate@<version> intake`, at the generating version like every other
 * pin. `intake` first shipped in 0.8.23 (#2250).
 */

/** The file this module generates, under `.github/workflows/`. */
export const INTAKE_WORKFLOW_FILE = "intake.yml";

/** The one job in it. */
export const INTAKE_JOB = "fix-commit-intake";

/**
 * The CLI command the step runs. `lib/cli-commands.ts` must register it, or
 * the workflow calls a command `bin/rungate.ts` refuses (#675's defect).
 */
export const INTAKE_COMMAND = "intake";

/**
 * The step's `run:` body. Exported so `test/intake-workflow.test.ts` executes
 * THIS text against a stub `bunx`, rather than a paraphrase.
 *
 * The output is captured so it can be both printed and inspected. Under
 * `bash -e` a failing command substitution in an assignment stops the step,
 * which is the red a broken tool should produce.
 */
export function buildIntakeScript(version: string): string {
  return `out=$(bunx rungate@${version} ${INTAKE_COMMAND} --source fix-commits)
printf '%s\\n' "$out"
case "$out" in
  *UNMEASURED*)
    echo "::warning::UNMEASURED — the fix-commits intake reading could not be taken on this run; the reason is printed above. This is not zero candidates."
    ;;
esac
`;
}

export interface IntakeWorkflowOptions {
  /** The `runs-on:` value, already JSON-quoted by the caller. */
  runsOn: string;
  /** The pinned `actions/checkout` reference. */
  checkout: string;
  /** The pinned `oven-sh/setup-bun` reference. */
  setupBun: string;
  /** The `with:` body of that step, at ten spaces — the project's single bun declaration (#622). */
  setupBunWith: string;
  /** The step's `env:` block, from `setupBunEnv` (#2039). */
  setupBunEnv: string;
  /** The published harness version the step runs through `bunx`. */
  version: string;
}

/** The whole `intake.yml` body. */
export function buildIntakeWorkflow(opts: IntakeWorkflowOptions): string {
  const indent = (text: string, pad: string) =>
    text
      .trimEnd()
      .split("\n")
      .map(line => (line === "" ? "" : `${pad}${line}`))
      .join("\n");

  return `# Managed by rungate — do not edit. Customize the ci section of .claude/rungate/config.json.
#
# Mines the default branch's fix commits into rule candidates on every push to
# it (#2233). Jason's #1126 decision: each intake source runs on its own
# trigger, never on scaffold. Advisory: a reading never fails the run, and an
# UNMEASURED one is raised as a warning rather than read as zero.
name: Intake — fix commits

on:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  ${INTAKE_JOB}:
    runs-on: ${opts.runsOn}
    steps:
      # Full history: a depth-1 clone is the only reason this source reads
      # UNMEASURED (SHALLOW_HISTORY) on a runner.
      - uses: ${opts.checkout}
        with:
          fetch-depth: 0
      - uses: ${opts.setupBun}
        with:
${opts.setupBunWith}
${opts.setupBunEnv}
      - name: Mine fix commits into rule candidates
        run: |
${indent(buildIntakeScript(opts.version), "          ")}
`;
}
