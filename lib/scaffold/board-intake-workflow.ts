/**
 * `.github/workflows/board-intake.yml`, generated — #2166, ADR-014 row 4,
 * the second half of SC-2745 (`board-ready.yml` is #2047's).
 *
 * Every new issue and pull request goes on the board, and a pull request
 * offered for review moves to In review. Hand-written and caller-owned until
 * now, with this repository's project URL and node id pasted in. A consumer
 * has neither, so the scaffold writes it and this repository's copy is the
 * generated one.
 *
 * ## It names no board
 *
 * The add step asks `bunx rungate@<version> board-id` (#2173), which reads
 * `board.id` from the checked-out config through the one loader. The add is
 * then `addProjectV2ItemById` on that node id, so a user board and an
 * organisation board need no branch, and no project URL exists anywhere in
 * the file. `actions/add-to-project` is gone: it accepts only a URL.
 *
 * ## The checkout is the default branch, never the pull request
 *
 * The trigger is `pull_request_target`, which runs with secrets in the BASE
 * repository's context. Checking out the head would run a contributor's code
 * holding a token that can write the board. The config is read from
 * `github.event.repository.default_branch`, with `persist-credentials: false`,
 * and `bunx` runs the published package, not anything in the tree.
 *
 * ## An unconfigured tree is UNMEASURED, an annotation and not a red run
 *
 * No `RUNGATE_PROJECT_TOKEN`, or no `board.id` (`board-id` exits 2), ends the
 * add step with a warning and no item id, and the move step's `if:` skips on
 * the empty id (`.claude/rules/config-access.md`). Any other failure stands.
 *
 * ## What the move step keeps
 *
 * Since #2183 the step is one call to `rungate board-intake-move`
 * (`lib/board-intake-move.ts`, #2193); the retry, the read-backs, the
 * truncation and null-node refusals below are that code's, each tested in
 * test/board-intake-move.test.ts. This file keeps the step's shape:
 *
 * - It owns only the opened -> In review edge. `merged -> Done` and
 *   `closed -> Done` stay with GitHub's built-in workflows, so each
 *   transition has exactly one decider. Do not add a merge or close handler.
 * - Drafts are not moved (BI-2): Jason's call, 2026-11-04.
 * - It keys off the item the add step created (BI-1), never a re-query, which
 *   would race the built-in "Item added to project" workflow.
 * - Every call is retried, every write is read back from the item AND from the
 *   project's search index, a full page is never read as absence, and a null
 *   or wrong-type node is refused by naming the id: in the command.
 * - No `${{ }}` inside a `run:` block (BI-4), and no scratch file (BI-12).
 * - The field and option are resolved by NAME at run time, so a renamed
 *   column fails loudly rather than writing a stale id.
 *
 * The incidents behind each of these are in the hand-written file's history
 * (git log -- .github/workflows/board-intake.yml, before #2166).
 */

/** The file this module generates, under `.github/workflows/`. */
export const BOARD_INTAKE_WORKFLOW_FILE = "board-intake.yml";

/** The one job in it. */
export const BOARD_INTAKE_JOB = "add-to-board";

/** The CLI command the add step runs to learn the board (#2173). */
export const BOARD_ID_COMMAND = "board-id";

/**
 * How `rungate board-id` begins its no-board refusal. Exit 2 alone also
 * covers a usage error, so the add step softens only this wording;
 * `test/board-intake.test.ts` holds it to `scripts/board-id.ts`.
 */
export { NO_BOARD_REFUSAL } from "./board-ready-workflow";
import { NO_BOARD_REFUSAL } from "./board-ready-workflow";

/** The add step's `run:` body. Exported so a test executes THIS text. */
export function buildBoardIntakeAddScript(version: string): string {
  return `set -euo pipefail
if [ -z "\${GH_TOKEN}" ]; then
  echo "::warning title=Board intake::UNMEASURED — RUNGATE_PROJECT_TOKEN is not set, so nothing was added to the board."
  exit 0
fi
# The board is board.id in the default branch's config. Only the no-board
# refusal (exit 2 AND its own wording) is an annotation; a usage error is red.
code=0
project=$(bunx rungate@${version} ${BOARD_ID_COMMAND} 2>"\${RUNNER_TEMP}/board-id.stderr") || code=$?
cat "\${RUNNER_TEMP}/board-id.stderr" >&2
if [ "\${code}" -eq 2 ] && grep -q '^${NO_BOARD_REFUSAL}' "\${RUNNER_TEMP}/board-id.stderr"; then
  echo "::warning title=Board intake::UNMEASURED — no board.id in the rungate config, so nothing was added. Set board.id and this runs."
  exit 0
fi
if [ "\${code}" -ne 0 ]; then
  exit "\${code}"
fi
# Done only on a real id: an exit-0 reply carrying null is retried too (#2185).
item=""
tried=0
: > "\${RUNNER_TEMP}/add.stderr"
for attempt in 1 2 3; do
  tried=\${attempt}
  item=$(gh api graphql -f project="\${project}" -f content="\${CONTENT_ID}" -f query='
    mutation($project: ID!, $content: ID!) {
      addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } }
    }' --jq '.data.addProjectV2ItemById.item.id' 2>"\${RUNNER_TEMP}/add.stderr") || item=""
  if [ -n "\${item}" ] && [ "\${item}" != "null" ]; then
    break
  fi
  item=""
  sleep $(( attempt * 2 ))
done
if [ -z "\${item}" ]; then
  echo "::error title=Board intake::addProjectV2ItemById gave no item after \${tried} attempt(s), so the item is NOT on the board. Last error: $(cat "\${RUNNER_TEMP}/add.stderr")" >&2
  exit 1
fi
echo "itemId=\${item}" >> "\${GITHUB_OUTPUT}"
echo "projectId=\${project}" >> "\${GITHUB_OUTPUT}"
`;
}

/** The CLI command the move step runs (#2193, #2183). */
export const BOARD_INTAKE_MOVE_COMMAND = "board-intake-move";

/**
 * The move step's `run:` body: one call to the tested command. Its 260 lines
 * of shell are now `lib/board-intake-move.ts`, and each refusal is observed
 * failing against a stub client in `test/board-intake-move.test.ts`. Values
 * arrive through `env:`, never interpolated into this block (BI-4).
 * Exported so a test reads THIS text.
 */
export function buildBoardIntakeMoveScript(version: string): string {
  return `set -euo pipefail
bunx rungate@${version} ${BOARD_INTAKE_MOVE_COMMAND} --project "\${PROJECT_ID}" --item "\${ITEM_ID}" --column "\${COLUMN}"
`;
}

export interface BoardIntakeWorkflowOptions {
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
  /** The published harness version the add step runs through `bunx`. */
  version: string;
}

/** The whole `board-intake.yml` body. */
export function buildBoardIntakeWorkflow(opts: BoardIntakeWorkflowOptions): string {
  const indent = (text: string, pad: string) =>
    text
      .trimEnd()
      .split("\n")
      .map(line => (line === "" ? "" : `${pad}${line}`))
      .join("\n");

  return `# Managed by rungate — do not edit. The board is board.id in .claude/rungate/config.json.
#
# Every new issue and pull request goes on the board, and a pull request
# offered for review moves to In review. Generated since #2166, and it names
# no project id or URL: \`rungate ${BOARD_ID_COMMAND}\` reads board.id from the
# default branch's config, and the add uses that node id.
#
# Needs the RUNGATE_PROJECT_TOKEN secret: a token that can write the project
# board, which GITHUB_TOKEN cannot. Without it, or without board.id, the run
# is an UNMEASURED annotation, not a red run.
name: Board intake

on:
  issues:
    types: [opened, reopened]
  pull_request_target:
    types: [opened, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  ${BOARD_INTAKE_JOB}:
    runs-on: ${opts.runsOn}
    steps:
      # The default branch, never the pull request: pull_request_target holds a
      # board-writing token, and the config is the only input read from the tree.
      - uses: ${opts.checkout}
        with:
          ref: \${{ github.event.repository.default_branch }}
          persist-credentials: false
      - uses: ${opts.setupBun}
        with:
${opts.setupBunWith}
${opts.setupBunEnv}
      - id: add
        name: Add the issue or pull request to the board
        env:
          GH_TOKEN: \${{ secrets.RUNGATE_PROJECT_TOKEN }}
          CONTENT_ID: \${{ github.event.issue.node_id || github.event.pull_request.node_id }}
        run: |
${indent(buildBoardIntakeAddScript(opts.version), "          ")}
      # Only the opened -> In review edge; merged and closed stay with GitHub's
      # built-in workflows, so each transition has one decider. Not a draft:
      # a draft in \`In review\` says somebody is waiting on a reader when nobody is.
      # Drafts stay in Backlog until \`ready_for_review\`, which this subscribes to.
      - name: Move the pull request to In review
        if: github.event_name == 'pull_request_target' && github.event.pull_request.draft == false && steps.add.outputs.itemId != ''
        env:
          GH_TOKEN: \${{ secrets.RUNGATE_PROJECT_TOKEN }}
          PROJECT_ID: \${{ steps.add.outputs.projectId }}
          ITEM_ID: \${{ steps.add.outputs.itemId }}
          COLUMN: In review
        run: |
${indent(buildBoardIntakeMoveScript(opts.version), "          ")}
`;
}
