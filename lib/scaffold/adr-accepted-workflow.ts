/**
 * `.github/workflows/adr-accepted.yml`, generated — #2046, ADR-014 row 3,
 * SC-2744.
 *
 * Merging an ADR whose status changes to accepted places its plan on the board
 * with no command typed by hand (SC-2738, ADR-013 rule 9 step 3). The file was
 * hand-written and caller-owned, and it ran `bun scripts/…` — paths a consumer
 * does not have. Rule 9 is every consumer's process, so the scaffold now
 * writes it, and this repository's copy is the generated one (ADR-014
 * decision 1).
 *
 * ## It calls the published CLI
 *
 * A consumer has `node_modules/rungate`, not `scripts/` (ADR-014 decision 2),
 * so every step runs `bunx rungate@<version> <command>`, at the generating
 * version — the same reading every other `bunx` pin takes.
 *
 * ## The engine's spec and family are read at scaffold time
 *
 * The hand-written file read `board.engineSpec` and `board.milestonePrefix`
 * at run time by importing `./lib/config-readers`, which a consumer does not
 * have either. They are read here instead, through the one loader, and
 * written into the job's `env:`. A config change is a re-scaffold, and the
 * workflow drift check sees a committed file that no longer matches.
 *
 * A value that is unset, or one that would be read as something other than
 * itself — a newline, or an Actions expression — is not written. The
 * acceptance step then refuses UNMEASURED, naming the key and why: a skipped
 * step reads as satisfied, and a missing family is not "nothing to place".
 */
import { boardProjectRun } from "./board-project-step";

/** The file this module generates, under `.github/workflows/`. */
export const ADR_ACCEPTED_WORKFLOW_FILE = "adr-accepted.yml";

/** The one job in it. */
export const ADR_ACCEPTED_JOB = "place-the-plan";

/**
 * The five commands, in the order each needs the one before it, after the
 * acceptance read (`plan-issues --accepted-since`). Each must be registered in
 * `lib/cli-commands.ts`, or the workflow calls a command `bin/rungate.ts`
 * refuses (#675's defect).
 */
export const ADR_ACCEPTED_COMMANDS = ["plan-issues", "plan-spec", "plan-deps", "board-mirror", "board-ready"] as const;

/** One engine input as the generator will write it, or why it will not. */
export type BoardInput = { value: string } | { value: null; why: string };

/**
 * Whether `raw` can be written into the job's `env:` as itself. A newline
 * could forge a second key wherever a step echoes it, and `${{` is evaluated
 * by Actions before the shell sees it — either way the step would read
 * something the config does not say.
 */
export function boardInput(key: string, raw: string | null): BoardInput {
  if (raw === null) return { value: null, why: `board.${key} is not set` };
  if (/[\r\n]/.test(raw)) return { value: null, why: `board.${key} contains a newline` };
  if (raw.includes("${{")) return { value: null, why: `board.${key} contains an Actions expression marker, a dollar sign and two braces` };
  return { value: raw };
}

export interface AdrAcceptedWorkflowOptions {
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
  /** `board.engineSpec`, read through `readBoardInputs`. */
  engineSpec: string | null;
  /** `board.milestonePrefix`, read through `readBoardInputs`. */
  milestonePrefix: string | null;
  /**
   * `board.mergeWorkflow`, read through `readBoardInputs` (ADR-022, SC-2787).
   * Null emits exactly the push-only workflow; a name adds the
   * `workflow_run` trigger and the range read that goes with it.
   */
  mergeWorkflow: string | null;
}

/** The whole `adr-accepted.yml` body. */
export function buildAdrAcceptedWorkflow(opts: AdrAcceptedWorkflowOptions): string {
  const spec = boardInput("engineSpec", opts.engineSpec);
  const prefix = boardInput("milestonePrefix", opts.milestonePrefix);
  const missing = [spec, prefix].flatMap(i => (i.value === null ? [i.why] : []));
  const cli = `bunx rungate@${opts.version}`;
  // ADR-022: a merge made by automation starts no push run. A name that would
  // be read as something other than itself is not written as a trigger, and
  // every run says so instead of quietly placing nothing after a bot merge.
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
  # ADR-022 (SC-2787): a merge the named workflow makes with GITHUB_TOKEN
  # starts no push run, and a workflow_run event is created even then. No
  # branches filter: that workflow runs on pull request events.
  workflow_run:
    workflows: [${JSON.stringify(mergeName)}]
    types: [completed]`;
  const mergePermission = mergeName === null ? "" : `
  # The range read lists this workflow's own successful runs (ADR-022).
  actions: read
  # The merged pull requests, and the issues each declares closed (SC-2788).
  pull-requests: read`;
  const fetchStep =
    mergeName === null
      ? ""
      : `
      # The range read below holds GITHUB_TOKEN on a merge-triggered run, so
      # the package is fetched here first, by a step that holds no token.
      - name: Fetch rungate before any step holds a token
        run: ${cli} --version`;
  const acceptedEnv =
    mergeName === null
      ? `
          BEFORE: \${{ github.event.before }}`
      : `
          BEFORE: \${{ github.event.before }}
          EVENT: \${{ github.event_name }}
          # Only a merge-triggered run reads the API; a push run holds no token.
          GITHUB_TOKEN: \${{ github.event_name == 'workflow_run' && secrets.GITHUB_TOKEN || '' }}`;
  const acceptedRead =
    mergeName === null
      ? `${cli} plan-issues --accepted-since "$BEFORE" > accepted.txt`
      : `# A workflow_run carries no before sha: the range starts at the head of
          # this workflow's newest successful run that is on this branch, and
          # with no such run the read refuses rather than guess one.
          if [ "$EVENT" = "workflow_run" ]; then
            ${cli} plan-issues --accepted-since-last-run ${ADR_ACCEPTED_WORKFLOW_FILE} --repo "$GITHUB_REPOSITORY" > accepted.txt
          else
            ${cli} plan-issues --accepted-since "$BEFORE" > accepted.txt
          fi`;
  // ADR-022 (SC-2788, #2497): a merge made with GITHUB_TOKEN runs none of
  // GitHub's closing keywords, so the issues it declared stay open. A
  // merge-triggered run closes each one still open, over every pull request
  // merged since this workflow's last successful run. `!cancelled()` and no
  // acceptance gate: it depends on no planning step, and a bot merge of a
  // change that is not an ADR declares issues too. A push run is a person's
  // merge, and GitHub closes its issues itself.
  const closeStep =
    mergeName === null
      ? ""
      : `

      - name: Close the issues a merge made by automation declared
        if: \${{ !cancelled() && github.event_name == 'workflow_run' }}
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: ${cli} close-merged-references --since-last-run ${ADR_ACCEPTED_WORKFLOW_FILE} --repo "$GITHUB_REPOSITORY" --write`;
  const indent = (script: string) => script.split("\n").map(l => (l === "" ? "" : `          ${l}`)).join("\n");
  // JSON is a YAML double-quoted scalar, so a quote or backslash in a value
  // stays inside it.
  const envValue = (i: BoardInput) => JSON.stringify(i.value ?? "");
  const refusal =
    missing.length === 0
      ? ""
      : `
          echo "::error::UNMEASURED — ${missing.join("; ")}, so this push's plan has no milestones to land in. Nothing was written. Set board.engineSpec and board.milestonePrefix in the rungate config and re-run rungate scaffold."
          exit 1`;

  return `# Managed by rungate — do not edit. Set board.engineSpec and board.milestonePrefix
# in .claude/rungate/config.json and re-run \`rungate scaffold\`.
#
# SC-2738 (ADR-013 row 5): merging an ADR whose status changes to accepted
# places its plan on the board, with no command typed by hand. Generated since
# #2046 (ADR-014 row 3), so a consumer gets step 3 of the four-step process and
# this repository's copy is the generated one.
#
# The five commands, in the order each needs the one before it:
#
#   plan-spec      the engine spec's milestones, so every row's milestone exists
#   plan-issues    the ADR's Decomposition rows become issues, with blocked-by
#   plan-deps      any declared link plan-issues did not write; never phase order
#   board-mirror   the Criteria column on the board
#   board-ready    a Ready top-up, because issues created with GITHUB_TOKEN
#                  fire no \`issues: opened\` run of board-ready.yml
#
# Every one is idempotent, so a re-run writes only what is missing. An edit to
# an ADR that was ALREADY accepted lists nothing and every later step is skipped.
#
# CREDENTIALS, SPLIT BY STEP. The issue, milestone and edge writes use the
# job's own GITHUB_TOKEN, passed as GITHUB_TOKEN because plan-issues drops
# GH_TOKEN. RUNGATE_PROJECT_TOKEN reaches only the two board steps, in their
# own env (#1761). The first \`bunx\` runs in the acceptance step, which holds
# no token, so the package is fetched before any step that holds the PAT.
name: ADR accepted — place its plan on the board

on:
  push:
    branches: [main]
    paths: ["docs/adr/**"]${mergeTrigger}

permissions:
  contents: read
  # Issues, milestones and blocked-by edges. Nothing else this job writes is
  # reachable with GITHUB_TOKEN.
  issues: write${mergePermission}

# Two merges in quick succession must not race each other's issue creation:
# the second run reads the tracker the first one wrote.
concurrency:
  group: adr-accepted
  cancel-in-progress: false

jobs:
  ${ADR_ACCEPTED_JOB}:
    runs-on: ${opts.runsOn}
    env:
      SPEC: ${envValue(spec)}
      PREFIX: ${envValue(prefix)}
    steps:
      # fetch-depth 0: the acceptance read compares each ADR with the commit
      # before this push, and refuses when that commit is not in the clone.
      - uses: ${opts.checkout}
        with:
          fetch-depth: 0
      - uses: ${opts.setupBun}
        with:
${opts.setupBunWith}
${opts.setupBunEnv}${fetchStep}
      - id: accepted
        name: Which ADRs did this push accept?
        env:${acceptedEnv}
        run: |${mergeWarning}
          ${acceptedRead}
          echo "Accepted by this push:"
          cat accepted.txt
          if [ ! -s accepted.txt ]; then
            echo "any=false" >> "$GITHUB_OUTPUT"
            exit 0
          fi${refusal}
          echo "any=true" >> "$GITHUB_OUTPUT"

      - name: Milestones from the engine spec's placement table
        if: steps.accepted.outputs.any == 'true'
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: ${cli} plan-spec "$SPEC" --repo "$GITHUB_REPOSITORY" --prefix "$PREFIX" --write

      # One ADR at a time; \`bash -e\` stops at the first refusal, so a plan the
      # filing tool refuses is a red run naming the ADR.
      - name: Issues and blocked-by edges from each accepted ADR
        if: steps.accepted.outputs.any == 'true'
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          while IFS= read -r adr; do
            echo "== $adr"
            ${cli} plan-issues --decompose "$adr" --repo "$GITHUB_REPOSITORY" --write
          done < accepted.txt

      - name: Phase-order links between milestones
        if: steps.accepted.outputs.any == 'true'
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: ${cli} plan-deps --repo "$GITHUB_REPOSITORY" --milestone-prefix "$PREFIX" --write

      # The board steps. THE SECRET IS \`RUNGATE_PROJECT_TOKEN\`: board-mirror
      # reads it as GITHUB_TOKEN, board-ready as BOARD_PROJECT_TOKEN. An absent
      # secret is the empty string with no error, so each command's own
      # UNMEASURED refusal is what reports it.
      #
      # \`!cancelled()\` (#2239): an \`if:\` with no status function means
      # \`success() && …\`, so a refusal in any step above skipped both of these
      # for every issue the merge had just created. Each reads the whole board
      # and writes only what is missing, so it never depends on an earlier step
      # succeeding. The run is still red when one of those failed.
      - name: Criteria column on the board
        if: \${{ !cancelled() && steps.accepted.outputs.any == 'true' }}
        env:
          GITHUB_TOKEN: \${{ secrets.RUNGATE_PROJECT_TOKEN }}
          PROJECT_ID: \${{ vars.RUNGATE_PROJECT_ID }}
        run: |
${indent(boardProjectRun(cli, "Criteria column", `${cli} board-mirror --project "$project" --write`))}

      - name: Top up Ready from the new issues
        if: \${{ !cancelled() && steps.accepted.outputs.any == 'true' }}
        env:
          BOARD_PROJECT_TOKEN: \${{ secrets.RUNGATE_PROJECT_TOKEN }}
          PROJECT_ID: \${{ vars.RUNGATE_PROJECT_ID }}
          ACTOR: \${{ github.actor }}
        run: |
${indent(boardProjectRun(cli, "Ready top-up", `${cli} board-ready --repo "$GITHUB_REPOSITORY" --project "$project" --actor "$ACTOR" --top-up --write`))}${closeStep}
`;
}
