/**
 * `.github/workflows/board-ready.yml`, generated — #2047, ADR-014 row 4,
 * half of SC-2745 (`board-intake.yml` is #2166's).
 *
 * It keeps the board's Ready lane full from the events the repository
 * already emits (#1744): a close fans out to what that close freed, and the
 * other `issues:` types top the lane up from every open issue (#1842). It was
 * hand-written and caller-owned while it ran `bun scripts/board-ready.ts`
 * from this checkout. A consumer has no `scripts/` (ADR-014 decision 2), so
 * the scaffold now writes it and this repository's copy is the generated one.
 *
 * ## It names no board
 *
 * The step passes no `--project`. `rungate board-ready` reads `board.id`
 * from the checked-out tree's rungate config since #2165, so the board's
 * identity lives in one place a consumer already edits, and no generated
 * workflow carries a project id or URL (SC-2745). That is why the job still
 * checks the tree out: the config is the input.
 *
 * ## What is kept from the hand-written file, and why each piece is load-bearing
 *
 * Every property below is asserted in `test/board-ready-fanout.test.ts`, so
 * the record of WHY lives here, beside the bytes, and the generated YAML
 * carries one line each.
 *
 * - **No schedule (BR-12).** A cron is the thing #1744 exists to remove.
 * - **The trust gate runs first and needs no checkout.** `issues:` events on
 *   a public repository are triggerable by anyone, and the job holds a
 *   board-writing PAT. The gate authorises the repository OWNER without an
 *   API call (BR-34: dispatch `42074926758` refused the owner because the
 *   PAT could not read the permission endpoint), then asks
 *   `collaborators/{actor}/permission` for anyone else. A permission nobody
 *   could read refuses. `WRITING_PERMISSIONS` in `lib/board-ready-fanout.ts`
 *   is the decider; BR-33 holds this `case` to the same set.
 * - **The secret is `RUNGATE_PROJECT_TOKEN`, the env var
 *   `BOARD_PROJECT_TOKEN` (BR-13).** An absent secret is the empty string
 *   with no error, so a wrong name made the gate authorise nothing and go
 *   green (run `41950972882`).
 * - **One run at a time, never cancelling the running one.** Occupancy is
 *   read once and written later, so two overlapping runs over-fill Ready.
 *   Every mode is a pure function of live state, so a dropped PENDING run
 *   loses nothing.
 * - **No `continue-on-error` (BR-20).** It swallowed every failure into a
 *   green run.
 * - **Every input reaches the script through `env:` (BR-16), and the
 *   argument list is an array with every expansion quoted (BR-54).** A
 *   dispatch `issue: "7 --write"` once word-split into a real write.
 * - **`assigned` names the moving issue (BR-51, #1905); a close runs both
 *   sources (#1917).**
 */

/** The file this module generates, under `.github/workflows/`. */
export const BOARD_READY_WORKFLOW_FILE = "board-ready.yml";

/** The one job in it. */
export const BOARD_READY_JOB = "move-freed-issues-to-ready";

/**
 * The CLI command the step runs. `lib/cli-commands.ts` must register it, or
 * the workflow calls a command `bin/rungate.ts` refuses (#675's defect).
 */
export const BOARD_READY_COMMAND = "board-ready";

/**
 * The trust gate's `run:` body. It needs only `gh`, which the runner has,
 * so an untrusted trigger is refused before any checkout or install.
 */
export function buildBoardReadyGateScript(): string {
  return `if [ -z "$GH_TOKEN" ]; then
  echo "::warning::UNMEASURED — BOARD_PROJECT_TOKEN is not set, so the acting identity could not be authorised and nothing was read. This run is UNMEASURED, not clean."
  echo "trusted=false" >> "$GITHUB_OUTPUT"
  exit 0
fi
# The owner may move its own board, with no API call and no token scope (BR-34).
if [ "$ACTOR" = "$OWNER" ]; then
  echo "trusted=true" >> "$GITHUB_OUTPUT"
  exit 0
fi
# A read that failed is "" and refuses with the rest — a permission we could
# not read is not a permission we were granted.
perm=$(gh api "repos/$GITHUB_REPOSITORY/collaborators/$ACTOR/permission" --jq .permission 2>/dev/null) || perm=""
case "$perm" in
  admin|maintain|write)
    echo "trusted=true" >> "$GITHUB_OUTPUT"
    ;;
  *)
    echo "::warning::refusing to run: $ACTOR has permission \\"\${perm:-UNMEASURED}\\" on $GITHUB_REPOSITORY, and this job holds a board-writing credential."
    echo "trusted=false" >> "$GITHUB_OUTPUT"
    ;;
esac
`;
}

/**
 * The fill step's `run:` body. Exported so a test can read THIS text rather
 * than a paraphrase. No `--project`: the board is `board.id` in the config
 * the checkout brought (#2165).
 */
export function buildBoardReadyScript(version: string): string {
  return `# An array, and every expansion quoted, so no input can become a flag (BR-54).
args=(--repo "$GITHUB_REPOSITORY" --actor "$ACTOR")
case "$MODE" in
  closed)
    case "$ISSUE" in
      '' | *[!0-9]*)
        echo "::warning::UNMEASURED — mode 'closed' needs a plain issue NUMBER and got \\"$ISSUE\\". Nothing was read."
        exit 1
        ;;
    esac
    # Both sources: a close frees a slot even when it blocked nothing (#1917).
    args+=(--closed-issue "$ISSUE" --top-up)
    ;;
  assigned)
    # board-flow moves this card out of Ready on the same event (#1905).
    args+=(--top-up --moving-issue "$ISSUE")
    ;;
  top-up | unassigned | opened | reopened | milestoned | demilestoned | labeled | unlabeled)
    args+=(--top-up)
    ;;
  # SC-2741 (#2434): a milestone added, removed, or given a new due date
  # re-ranks the whole lane. Prefixed by the step, so a milestone's own
  # \`closed\` can never reach the issue-close branch above.
  milestone-created | milestone-edited | milestone-deleted)
    args+=(--top-up)
    ;;
  *)
    echo "::warning::UNMEASURED — unrecognised mode \\"$MODE\\", so no candidate source was chosen. Nothing was read."
    exit 1
    ;;
esac
if [ -n "$WRITE" ]; then
  args+=(--write)
fi
echo "mode=$MODE, args=\${args[*]}"
# A tree with no board.id is UNMEASURED, an annotation and not a red run
# (.claude/rules/config-access.md). Only that refusal is: every other exit stands.
err="$RUNNER_TEMP/board-ready.stderr"
code=0
bunx rungate@${version} ${BOARD_READY_COMMAND} "\${args[@]}" 2>"$err" || code=$?
cat "$err" >&2
if [ "$code" -eq 2 ] && grep -q '^${NO_BOARD_REFUSAL}' "$err"; then
  echo "::warning::UNMEASURED — no board.id in the rungate config, so there is no board to read. Set board.id and this runs."
  exit 0
fi
exit "$code"
`;
}

/**
 * How `rungate board-ready` begins its one refusal for a tree with no board
 * (#2165). The fill step turns exactly that refusal into an annotation, so a
 * consumer who sets the token before `board.id` gets a warning on each issue
 * event and not a red run. `test/board-ready-fanout.test.ts` holds this to
 * the script's own text, so the two cannot drift apart.
 */
export const NO_BOARD_REFUSAL = "UNMEASURED: no board";

export interface BoardReadyWorkflowOptions {
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

/**
 * The whole `board-ready.yml` body.
 *
 * `milestone:` is the LAST trigger (SC-2741, #2434). A re-scaffold does not
 * regenerate an existing `on:` block; it appends the triggers the tree lacks.
 * Emitting the new one last means a fresh tree and an updated one get the
 * same bytes (review of #2453; the fanout suite compares the two blocks).
 */
export function buildBoardReadyWorkflow(opts: BoardReadyWorkflowOptions): string {
  const indent = (text: string, pad: string) =>
    text
      .trimEnd()
      .split("\n")
      .map(line => (line === "" ? "" : `${pad}${line}`))
      .join("\n");

  return `# Managed by rungate — do not edit. The board is board.id in .claude/rungate/config.json.
#
# Keeps the board's Ready lane full from the events the repository already
# emits (#1744). A close fans out to what it freed; the other issue events top
# the lane up from every open issue (#1842). No schedule: every trigger is an
# event a person caused. Generated since #2047, and it names no project id —
# \`rungate ${BOARD_READY_COMMAND}\` reads board.id from the checked-out config.
#
# Needs the RUNGATE_PROJECT_TOKEN secret: a token that can write the project
# board, which GITHUB_TOKEN cannot.
name: Board — keep Ready full from the events the repo already emits

on:
  issues:
    types: [closed, assigned, unassigned, opened, reopened, milestoned, demilestoned, labeled, unlabeled]
  workflow_dispatch:
    inputs:
      mode:
        description: "closed = fan out from \`issue\`; top-up = consider every open issue"
        type: choice
        default: closed
        options: [closed, "top-up"]
      issue:
        description: "Issue number to fan out from (mode: closed only)"
        required: false
        type: string
      write:
        description: "Perform the moves (default: report only)"
        type: boolean
        default: false
  # SC-2741: focus is a milestone's due date, so changing one refills Ready.
  milestone:
    types: [created, edited, deleted]

permissions:
  contents: read

# One run at a time: occupancy is read once and written later, so overlapping
# runs over-fill Ready. Never cancel the running one — it can be mid-write.
concurrency:
  group: board-ready
  cancel-in-progress: false

jobs:
  ${BOARD_READY_JOB}:
    runs-on: ${opts.runsOn}
    steps:
      # Before any checkout: an untrusted trigger is refused with only gh.
      - id: gate
        name: May the acting identity move the board?
        env:
          GH_TOKEN: \${{ secrets.RUNGATE_PROJECT_TOKEN }}
          ACTOR: \${{ github.actor }}
          OWNER: \${{ github.repository_owner }}
        run: |
${indent(buildBoardReadyGateScript(), "          ")}
      # The checkout is the config the command reads the board from.
      - if: steps.gate.outputs.trusted == 'true'
        uses: ${opts.checkout}
      - if: steps.gate.outputs.trusted == 'true'
        uses: ${opts.setupBun}
        with:
${opts.setupBunWith}
${opts.setupBunEnv}
      - name: Fill Ready from whatever this event changed
        if: steps.gate.outputs.trusted == 'true'
        env:
          BOARD_PROJECT_TOKEN: \${{ secrets.RUNGATE_PROJECT_TOKEN }}
          ISSUE: \${{ github.event.issue.number || inputs.issue }}
          WRITE: \${{ (github.event_name == 'issues' || github.event_name == 'milestone' || inputs.write) && '--write' || '' }}
          MODE: \${{ github.event_name == 'milestone' && format('milestone-{0}', github.event.action) || github.event.action || inputs.mode }}
          ACTOR: \${{ github.actor }}
        run: |
${indent(buildBoardReadyScript(opts.version), "          ")}
`;
}
