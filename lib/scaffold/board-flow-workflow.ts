/**
 * `.github/workflows/board-flow.yml`, generated — #2481, ADR-023 row 4,
 * SC-2790.
 *
 * It moves an issue's card to the lane an event means: In progress when the
 * issue is assigned, In review when a pull request for it opens or leaves
 * draft, Done or Cancelled when it closes (`specs/BOARD-FLOW-SPEC.md`). It
 * was hand-written and caller-owned while it ran `bun scripts/board-flow.ts
 * --project "$RUNGATE_PROJECT_ID"` from this checkout. A consumer has no
 * `scripts/` and no such variable, so the scaffold now writes it, and this
 * repository's copy is the generated one.
 *
 * ## It names no board
 *
 * `rungate board-flow` reads `board.id` from the checked-out config when no
 * `--project` is passed (#2507, shipped in 0.8.38), as `rungate board-ready`
 * does. The job checks the tree out for that config, and nothing else: the
 * command comes from the registry through `bunx`, so there is no dependency
 * install in a job that holds a board-writing token.
 *
 * ## What is kept from the hand-written file
 *
 * - **The triggers.** `issues: assigned, closed, reopened` and
 *   `pull_request_target: opened, ready_for_review, closed`. The pull request
 *   events move the card of the ISSUE the pull request closes; the pull
 *   request's own card is `board-intake.yml`'s.
 * - **`pull_request_target`, and a checkout of the base.** The job needs a
 *   secret, which `pull_request` cannot see. That is safe because no
 *   contributor code runs: the checkout takes the default ref, never the
 *   head, and every value reaches `run:` through `env:`.
 * - **The event kind is decided once,** to the empty string for a draft pull
 *   request opened and for a merge (the issue's own `issues: closed` writes
 *   Done; a second writer would race it).
 * - **The trust gate runs before the checkout and is board-ready's own**
 *   (`buildBoardReadyGateScript`): one gate text for every job holding the
 *   board token, so the two cannot drift into two deciders.
 * - **A tree with no `board.id` is an annotation, not a red run.** Only
 *   `rungate board-flow`'s own no-board refusal is turned into one; every
 *   other exit stands, as in `board-ready.yml`.
 * - **No `continue-on-error`, no schedule.**
 */
import { buildBoardReadyGateScript, NO_BOARD_REFUSAL } from "./board-ready-workflow";

/** The file this module generates, under `.github/workflows/`. */
export const BOARD_FLOW_WORKFLOW_FILE = "board-flow.yml";

/** The one job in it. */
export const BOARD_FLOW_JOB = "write-the-lane";

/** The CLI command the step runs; `lib/cli-commands.ts` registers it. */
export const BOARD_FLOW_COMMAND = "board-flow";

/** The kind step's `run:` body: the event, in the decider's own vocabulary. */
export function buildBoardFlowKindScript(): string {
  return `set -euo pipefail
kind=""
if [ "$EVENT" = "issues" ]; then
  case "$ACTION" in
    assigned) kind="issue_assigned" ;;
    closed)   kind="issue_closed" ;;
    reopened) kind="issue_reopened" ;;
  esac
else
  case "$ACTION" in
    opened|ready_for_review)
      # A draft in In review says somebody waits on a reader when nobody does.
      if [ "$DRAFT" != "true" ]; then kind="pr_ready"; fi
      ;;
    closed)
      # A merge closes its issue, and that issue's own close writes Done.
      if [ "$MERGED" != "true" ]; then kind="pr_closed_unmerged"; fi
      ;;
  esac
fi
if [ -z "$kind" ]; then
  echo "::notice::\${EVENT}/\${ACTION} means no lane transition here. Nothing to do."
fi
echo "kind=\${kind}" >> "$GITHUB_OUTPUT"
`;
}

/**
 * The write step's `run:` body. Exported so a test runs THIS text in bash.
 * No \`--project\`: the board is \`board.id\` in the config the checkout brought.
 */
export function buildBoardFlowScript(version: string): string {
  return `err="$RUNNER_TEMP/board-flow.stderr"
code=0
# One array, never empty, every expansion quoted, so no input becomes a flag.
args=(--repo "$GITHUB_REPOSITORY" --actor "$ACTOR" --event "$KIND")
case "$KIND" in
  pr_*) args+=(--pr "$PR" --pr-author "$PR_AUTHOR") ;;
  *)    args+=(--issue "$ISSUE") ;;
esac
# Omitted when the payload has none: absent and empty both refuse, and only
# absent is honest about what the payload carried.
if [ -n "$STATE_REASON" ]; then
  args+=(--state-reason "$STATE_REASON")
fi
args+=(--write)
bunx rungate@${version} ${BOARD_FLOW_COMMAND} "\${args[@]}" 2>"$err" || code=$?
cat "$err" >&2
# A tree with no board.id is UNMEASURED, an annotation and not a red run.
# Only that refusal is: every other exit stands.
if [ "$code" -eq 2 ] && grep -q '^${NO_BOARD_REFUSAL}' "$err"; then
  echo "::warning::UNMEASURED — no board.id in the rungate config, so there is no board to move a card on. Set board.id and this runs."
  exit 0
fi
exit "$code"
`;
}

export interface BoardFlowWorkflowOptions {
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

/** The whole `board-flow.yml` body. */
export function buildBoardFlowWorkflow(opts: BoardFlowWorkflowOptions): string {
  const indent = (text: string, pad: string) =>
    text
      .trimEnd()
      .split("\n")
      .map(line => (line === "" ? "" : `${pad}${line}`))
      .join("\n");

  return `# Managed by rungate — do not edit. The board is board.id in .claude/rungate/config.json.
#
# Moves an issue's card to the lane each event means (specs/BOARD-FLOW-SPEC.md):
# In progress on assigned, In review when a pull request for it opens or leaves
# draft, Done or Cancelled when it closes. No schedule. It names no project id:
# \`rungate ${BOARD_FLOW_COMMAND}\` reads board.id from the checked-out config.
#
# Turn OFF the project's built-in "Item closed" and "Pull request linked to
# issue" automations (\`rungate board-init\` does): each writes a lane this file
# owns, and two writers race for one column. Ready is board-ready.yml's; a pull
# request's own card is board-intake.yml's.
#
# Needs the RUNGATE_PROJECT_TOKEN secret: a token that can write the project
# board, which GITHUB_TOKEN cannot.
name: Board — one decider writes every lane

on:
  issues:
    types: [assigned, closed, reopened]
  # Not \`pull_request\`: this job needs a secret. Safe because no contributor
  # code runs: the checkout is the base, and every value arrives through env.
  pull_request_target:
    types: [opened, ready_for_review, closed]

permissions:
  contents: read

jobs:
  ${BOARD_FLOW_JOB}:
    runs-on: ${opts.runsOn}
    steps:
      - id: kind
        name: Which event is this?
        env:
          EVENT: \${{ github.event_name }}
          ACTION: \${{ github.event.action }}
          DRAFT: \${{ github.event.pull_request.draft }}
          MERGED: \${{ github.event.pull_request.merged }}
        run: |
${indent(buildBoardFlowKindScript(), "          ")}
      # Before any checkout: an untrusted trigger is refused with only gh.
      - id: gate
        if: steps.kind.outputs.kind != ''
        name: May the acting identity move the board?
        env:
          GH_TOKEN: \${{ secrets.RUNGATE_PROJECT_TOKEN }}
          ACTOR: \${{ github.actor }}
          OWNER: \${{ github.repository_owner }}
        run: |
${indent(buildBoardReadyGateScript(), "          ")}
      # The base, never the head. The checkout is the config the command reads.
      - if: steps.gate.outputs.trusted == 'true'
        uses: ${opts.checkout}
      - if: steps.gate.outputs.trusted == 'true'
        uses: ${opts.setupBun}
        with:
${opts.setupBunWith}
${opts.setupBunEnv}
      - name: Write the lane this event means
        if: steps.gate.outputs.trusted == 'true'
        env:
          BOARD_PROJECT_TOKEN: \${{ secrets.RUNGATE_PROJECT_TOKEN }}
          KIND: \${{ steps.kind.outputs.kind }}
          ISSUE: \${{ github.event.issue.number }}
          PR: \${{ github.event.pull_request.number }}
          STATE_REASON: \${{ github.event.issue.state_reason }}
          ACTOR: \${{ github.actor }}
          # The author of the body the closing references come from; the script
          # authorises this identity too (SC-2692).
          PR_AUTHOR: \${{ github.event.pull_request.user.login }}
        run: |
${indent(buildBoardFlowScript(opts.version), "          ")}
`;
}
