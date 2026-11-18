/**
 * The board a generated step writes, or a warning that there is none.
 *
 * A step that writes the project board used to read only the
 * `RUNGATE_PROJECT_ID` variable and exit 1 when it was empty. In a consumer
 * with no board at all, that turned every push to `specs/` red, and every
 * accepted ADR too. On 2026-11-17 the one live consumer held back from 0.8.27
 * because of it.
 *
 * Two different states are kept apart here:
 * - **no board configured.** No variable and no `board.id`. That is a warning
 *   annotation naming the state UNMEASURED, and exit 0, the way
 *   `board-intake.yml` reports it (#2166). There is nothing to write.
 * - **a board, and something wrong with it.** `board-id` refusing for any
 *   other reason, or the write itself refusing. That stays red.
 *
 * The variable still wins when it is set, so a repository that configured it
 * reads exactly what it read before.
 */

import { NO_BOARD_REFUSAL } from "./board-ready-workflow";

/**
 * Shell for one generated step: resolve the board's node id into `$project`,
 * or end the step with a warning when none is configured, then run `command`.
 * `cli` is the pinned `bunx rungate@<version>`. `title` names the annotation.
 */
export function boardProjectRun(cli: string, title: string, command: string): string {
  return [
    `project="$PROJECT_ID"`,
    `if [ -z "$project" ]; then`,
    // The runner's own temp dir, cleaned per job, as board-intake.yml does: no
    // mktemp to leak or to fail under `bash -e` (review of #2355).
    '  err="$RUNNER_TEMP/board-id.stderr"',
    `  code=0`,
    `  project=$(${cli} board-id 2>"$err") || code=$?`,
    `  cat "$err" >&2`,
    // Only board-id's own no-board refusal is a warning. Its other refusals
    // share the exit code, so the wording is what tells them apart.
    // The one spelling of board-id's refusal, the one board-ready and board-intake read too.
    `  if [ "$code" -ne 0 ] && grep -q '^${NO_BOARD_REFUSAL}' "$err"; then`,
    `    echo "::warning title=${title}::UNMEASURED — no board is configured (board.id in the rungate config, or the RUNGATE_PROJECT_ID variable), so there is no board to write. Set board.id and this runs."`,
    `    exit 0`,
    `  fi`,
    `  [ "$code" -eq 0 ] || exit "$code"`,
    `fi`,
    command,
  ].join("\n");
}
