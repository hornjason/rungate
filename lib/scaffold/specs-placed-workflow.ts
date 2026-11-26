/**
 * `.github/workflows/specs-placed.yml`, generated — SC-2780, ADR-018 Decision 1.
 *
 * A push to main that changes `specs/` runs every opted-in family through the
 * engine with no command typed by hand: milestones from each family's
 * placement table, each open issue moved into the phase its criteria hold,
 * the links accepted plans declare (never phase order, ADR-021), the queue
 * label, and the board's Criteria column.
 *
 * ## The families are read at RUN time, from the specs
 *
 * `rungate plan-issues --families` prints the opted-in families, one
 * `<prefix><TAB><spec>` line each. It is the same reading `plan-issues
 * --place` takes, so the loop and the placement never disagree about which
 * specs are on the board, and a newly opted-in spec needs no re-scaffold.
 * A spec whose `board:` block or placement table cannot be read makes that
 * command refuse, so the run goes red by name instead of skipping the spec.
 *
 * ## The order is the one each step needs
 *
 *   plan-spec      per family, so every phase has its milestone
 *   plan-issues    --place, so issues sit in the phase their criteria hold
 *   plan-deps      per family, so the links follow the issues' NEW milestones
 *   board-mirror   --queue-label, because a milestone set by GITHUB_TOKEN
 *                  fires no `milestoned` event, so phase-order.yml never sees it
 *   board-mirror   the Criteria column on the board
 *
 * Placing before `plan-deps` is ADR-019 Decision 2: #1722's links follow its
 * move into Phase 10 in the same run.
 *
 * ## It never writes while an earlier ADR placement is running
 *
 * One merge often changes both `specs/` and an ADR, which fires this and
 * `adr-accepted.yml` together, and both write milestones and links (ADR-018,
 * "Not decided here"). A shared `concurrency:` group would serialise them
 * but cancels whatever is pending behind the running run. A cancelled
 * `adr-accepted` run is an accepted ADR whose plan is never placed, with
 * nothing saying so. So this workflow keeps a group of its own, which only
 * cancels its own pending runs, and each of those re-reads the whole tree.
 * Its first step then waits until no `adr-accepted` run created before it is
 * still unfinished.
 *
 * ## It calls the published CLI
 *
 * Like every generated workflow it runs `bunx rungate@<version>`, so the
 * commands it calls must be in a published release before this file is
 * (`docs/guides/RELEASING.md`, "A command a generated workflow calls ships
 * BEFORE the workflow that calls it"). `--families` and `--place` shipped in
 * 0.8.26.
 *
 * ## A merge made by automation runs it too
 *
 * A merge made with GITHUB_TOKEN starts no push run, so with
 * `board.mergeWorkflow` set this also runs when that workflow completes, as
 * `adr-accepted.yml` does (ADR-022, #2862). It runs the same steps, behind
 * the gate `adr-accepted.yml` uses plus {@link SPECS_CHANGED_CHECK}: a
 * completion skips everything when main has not moved since this workflow
 * last succeeded, or when it moved and no file under specs/ changed, as the
 * push trigger's path filter would. Any other runs the full placement, which
 * is idempotent. The wait for an earlier ADR
 * placement runs on both events, because a bot merge starts both workflows.
 * Unset, the file is exactly the push-only one.
 */

import { ADR_ACCEPTED_WORKFLOW_FILE, boardInput, buildMergedGateScript } from "./adr-accepted-workflow";
import { boardProjectRun } from "./board-project-step";

/** The file this module generates, under `.github/workflows/`. */
export const SPECS_PLACED_WORKFLOW_FILE = "specs-placed.yml";

/** The one job in it. */
export const SPECS_PLACED_JOB = "run-the-engine";

/**
 * Every command the job calls, in run order. Each must be registered in
 * `lib/cli-commands.ts`, or the workflow calls a command `bin/rungate.ts`
 * refuses (#675's defect).
 */
export const SPECS_PLACED_COMMANDS = ["plan-issues", "plan-spec", "plan-deps", "board-mirror"] as const;

/** Its own group: it cancels only its own pending runs, each of which re-reads the tree. */
export const SPECS_PLACED_GROUP = "specs-placed";

/**
 * The gate's second question on a merge-triggered run (#2862). The push
 * trigger filters on `specs/**` and a workflow_run cannot, so after "main
 * moved" it asks whether any file under specs/ changed between this
 * workflow's last success and main, and skips when none did. A skip's head
 * becomes the next base, which is right: nothing in that range touched specs.
 * A list it cannot read, or one at the compare API's 300-file ceiling, is
 * UNMEASURED and runs the full placement.
 *
 * Each file is an `F` line, and a rename adds a `P` line for its old name
 * (#2872 review): a spec moved out of specs/ changed specs/, as the push
 * trigger's path filter reads it. The ceiling counts `F` lines, one per file.
 * Both read the listing from a here-string, never a pipe: `grep -q` stops at
 * its first match, and under `pipefail` the writer it cut off would turn a
 * found spec into "nothing changed" (#2872 review).
 */
export const SPECS_CHANGED_CHECK: readonly string[] = [
  `if [ "$go" = true ] && [ -n "$last" ] && [ -n "$main" ]; then`,
  `  if files=$(gh api --paginate "repos/$GITHUB_REPOSITORY/compare/$last...$main?per_page=100" --jq '.files[] | "F \\(.filename)", ((.previous_filename // empty) | "P \\(.)")'); then`,
  `    if [ "$(grep -c '^F ' <<< "$files")" -ge 300 ]; then`,
  `      echo "::notice::300 or more files changed since $last, so whether specs/ changed is UNMEASURED; running the full placement."`,
  `    elif ! grep -q '^[FP] specs/' <<< "$files"; then`,
  `      echo "Nothing under specs/ changed between $last and $main."; go=false`,
  `    fi`,
  `  else`,
  `    echo "::notice::The files changed since $last could not be read, so whether specs/ changed is UNMEASURED; running the full placement."`,
  `  fi`,
  `fi`,
];

/** How long the first step waits for an earlier ADR placement, in 20-second polls. */
export const WAIT_POLLS = 90;

export interface SpecsPlacedWorkflowOptions {
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
  /** The published harness version every step runs through `bunx`. */
  version: string;
  /** `board.mergeWorkflow`, read through `readBoardInputs` (#2862); null emits the push-only file. */
  mergeWorkflow: string | null;
}

/**
 * The wait step's script. The GitHub API lists the ADR workflow's runs; any
 * not yet `completed` that was created before this run, OR that runs on this
 * run's own commit, is waited for. The commit is what catches the merge that
 * starts both workflows in the same second (#2464): a strict `created_at <`
 * let that pair through, and `plan-issues --place` ran before the ADR's
 * issues existed. A later run from ANOTHER push is still not waited for, and
 * adr-accepted.yml has no wait of its own, so the two cannot wait on each
 * other.
 * Every page is read: the list is newest-first, so an earlier run still going
 * falls off page one once 100 newer runs exist. A list it cannot read fails
 * the step, through `pipefail`, rather than reading as "none unfinished".
 */
export function buildWaitScript(): string {
  return `set -euo pipefail
mine=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" --jq .created_at)
for poll in $(seq 1 ${WAIT_POLLS}); do
  earlier=$(gh api --paginate "repos/$GITHUB_REPOSITORY/actions/workflows/${ADR_ACCEPTED_WORKFLOW_FILE}/runs?per_page=100" --jq ".workflow_runs[] | select(.status != \\"completed\\" and (.created_at < \\"$mine\\" or .head_sha == \\"$GITHUB_SHA\\")) | .id" | paste -sd ' ' -)
  if [ -z "$earlier" ]; then
    echo "No earlier ${ADR_ACCEPTED_WORKFLOW_FILE} run is unfinished; going ahead."
    exit 0
  fi
  echo "Waiting for ${ADR_ACCEPTED_WORKFLOW_FILE} run(s) $earlier to finish (poll $poll of ${WAIT_POLLS})."
  sleep 20
done
echo "::error::${ADR_ACCEPTED_WORKFLOW_FILE} run(s) $earlier are still unfinished after $((${WAIT_POLLS} * 20 / 60)) minutes, so this run wrote nothing rather than write the board beside them. Re-run it once they finish."
exit 1`;
}

/**
 * A loop over the families file, one command per family. It reads the file on
 * descriptor 3, so a command inside the loop that reads standard input cannot
 * swallow the families after it. One family's refusal does not stop the next;
 * the step exits red at the end, naming every family that refused.
 */
export function buildFamilyLoop(version: string, command: (cli: string) => string, what: string): string {
  const cli = `bunx rungate@${version}`;
  return `set -uo pipefail
refused=""
while IFS=$'\\t' read -r prefix spec <&3; do
  [ -n "$prefix" ] || continue
  echo "== $prefix ($spec)"
  if ! ${command(cli)}; then
    refused="$refused [$prefix]"
  fi
done 3< families.tsv
if [ -n "$refused" ]; then
  echo "::error::${what} refused for$refused. Every other family was still run."
  exit 1
fi`;
}

/** The whole `specs-placed.yml` body. */
export function buildSpecsPlacedWorkflow(opts: SpecsPlacedWorkflowOptions): string {
  const cli = `bunx rungate@${opts.version}`;
  const indent = (script: string) => script.split("\n").map(l => (l === "" ? "" : `          ${l}`)).join("\n");
  const milestones = buildFamilyLoop(
    opts.version,
    c => `${c} plan-spec "$spec" --repo "$GITHUB_REPOSITORY" --prefix "$prefix" --write`,
    "plan-spec",
  );
  const links = buildFamilyLoop(
    opts.version,
    c => `${c} plan-deps --repo "$GITHUB_REPOSITORY" --milestone-prefix "$prefix" --write`,
    "plan-deps",
  );
  // #2862: a name that would be read as something other than itself is not
  // written as a trigger, and every run says so (adr-accepted.yml's rule).
  const merge = opts.mergeWorkflow === null ? null : boardInput("mergeWorkflow", opts.mergeWorkflow);
  const mergeName = merge?.value ?? null;
  const mergeWarning =
    merge !== null && merge.value === null
      ? `
          echo "::warning title=Merge workflow trigger UNMEASURED::${merge.why}, so this workflow does not run when the merge workflow completes, and a merge made by automation places nothing. Fix it and re-run rungate scaffold."`
      : "";
  const mergeTrigger =
    mergeName === null
      ? ""
      : `
  # #2862 (ADR-022): a merge the named workflow makes with GITHUB_TOKEN starts
  # no push run, and a workflow_run event is created even then. Its gate step
  # skips a completion when nothing under specs/ changed since the last success.
  workflow_run:
    workflows: [${JSON.stringify(mergeName)}]
    types: [completed]`;
  const stepIf = mergeName === null ? "" : `
        if: \${{ steps.merged.outputs.go != 'false' }}`;
  const gateStep =
    mergeName === null
      ? ""
      : `
      - id: merged
        name: Did the merge workflow merge anything?
        if: \${{ github.event_name == 'workflow_run' }}
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
${indent(buildMergedGateScript(SPECS_PLACED_WORKFLOW_FILE, SPECS_CHANGED_CHECK))}
`;

  return `# Managed by rungate — do not edit. Opt a spec in with
# board: { scope: active, prefix: <Name> } in its frontmatter and give it a
# placement table; nothing here names a spec.
#
# SC-2780 (ADR-018 Decision 1): a push to main that changes specs/ runs every
# opted-in family through the engine, with no command typed by hand.
#
#   plan-issues --families   which specs are on the board, read at run time
#   plan-spec                each family's milestones
#   plan-issues --place      each open issue into the phase its criteria hold
#   plan-deps                each family's declared links, after the moves
#   board-mirror             the queue label, then the Criteria column
#
# Every command is idempotent, so a re-run writes only what is missing.
#
# CREDENTIALS, SPLIT BY STEP. Issue, milestone, label and link writes use the
# job's own GITHUB_TOKEN. RUNGATE_PROJECT_TOKEN reaches only the board step.
name: Specs changed — run every opted-in family through the engine

on:
  push:
    branches: [main]
    paths: ["specs/**"]${mergeTrigger}

permissions:
  contents: read
  # Milestones, issues, labels and blocked-by links.
  issues: write
  # The wait step lists adr-accepted.yml's runs.
  actions: read

# Its own group, never adr-accepted's: a shared group cancels the run pending
# behind the running one, and a cancelled adr-accepted run is a plan that is
# never placed. The wait step below keeps the two from writing at once.
concurrency:
  group: ${SPECS_PLACED_GROUP}
  cancel-in-progress: false

jobs:
  ${SPECS_PLACED_JOB}:
    runs-on: ${opts.runsOn}
    steps:${gateStep}
      - name: Wait for an earlier ADR placement to finish${stepIf}
        env:
          GH_TOKEN: \${{ github.token }}
        run: |${mergeWarning}
${indent(buildWaitScript())}

      - uses: ${opts.checkout}${stepIf}
      - uses: ${opts.setupBun}${stepIf}
        with:
${opts.setupBunWith}
${opts.setupBunEnv}
      # No token: the package is fetched before any step that holds one.
      - id: families${stepIf}
        name: Which specs are on the board?
        run: |
          ${cli} plan-issues --families > families.tsv
          echo "Opted-in families:"
          cat families.tsv
          if [ -s families.tsv ]; then echo "any=true" >> "$GITHUB_OUTPUT"; else echo "any=false" >> "$GITHUB_OUTPUT"; fi

      - name: Milestones from each family's placement table
        if: steps.families.outputs.any == 'true'
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
${indent(milestones)}

      - name: Each open issue into the phase its criteria hold
        if: steps.families.outputs.any == 'true'
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: ${cli} plan-issues --place --repo "$GITHUB_REPOSITORY" --write

      # \`!cancelled()\`: each of these reads the whole tracker and writes only
      # what is missing, so it never depends on an earlier step succeeding
      # (#2239). The run is still red when one of those failed.
      - name: Phase-order links for each family
        if: \${{ !cancelled() && steps.families.outputs.any == 'true' }}
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
${indent(links)}

      - name: Queue label on every opted-in family's phase issue
        if: \${{ !cancelled() && steps.families.outputs.any == 'true' }}
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: ${cli} board-mirror --queue-label --repo "$GITHUB_REPOSITORY" --write

      - name: Criteria column on the board
        if: \${{ !cancelled() && steps.families.outputs.any == 'true' }}
        env:
          GITHUB_TOKEN: \${{ secrets.RUNGATE_PROJECT_TOKEN }}
          PROJECT_ID: \${{ vars.RUNGATE_PROJECT_ID }}
        run: |
${indent(boardProjectRun(cli, "Criteria column", `${cli} board-mirror --project "$project" --write`))}
`;
}
