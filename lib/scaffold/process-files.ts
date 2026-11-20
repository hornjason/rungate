/**
 * The dry-run command and the ADR template, written by the scaffold — #2048,
 * ADR-014 row 5, SC-2746.
 *
 * Step 2 of the four-step process is "an ADR from `docs/adr/TEMPLATE.md` …
 * `/dry-run` until the owner agrees", and a consumer had neither file: the
 * scaffold created `docs/adr/` empty and installed no `.claude/commands/`.
 * Both are rendered from `templates/process/`, and this repository's copies
 * are the rendered ones.
 *
 * Two differences between a consumer's copy and ours, both in the command:
 *
 * - **The CLI.** `bunx rungate <command>` in a consumer, `bun bin/rungate.ts`
 *   here — the switch `commands-routing.md` already makes.
 * - **What Ready holds now.** This repository reads it with
 *   `scripts/work-status.ts`, which is not a published command; a consumer
 *   reads it with `board-ready --top-up` and no `--write`, which changes
 *   nothing and prints what a top-up would move.
 *
 * #2484, ADR-023 row 5, SC-2791: `/board` is the third. It runs the CLI
 * from the repository it sits in and names no repository, so the one
 * difference between the two renderings is the CLI.
 *
 * #2486, ADR-023 row 8, SC-2794: the work loop is the fourth. Its test step
 * names the project's own test command, the one the generated CI runs
 * (`testCommandDecision`), passed in by the caller so this file reads no
 * config. With none passed, the work loop is refused by name rather than
 * rendered with a guessed command.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export const DRY_RUN_COMMAND_PATH = ".claude/commands/dry-run.md";
export const ADR_TEMPLATE_PATH = "docs/adr/TEMPLATE.md";
export const BOARD_COMMAND_PATH = ".claude/commands/board.md";
export const WORK_LOOP_COMMAND_PATH = ".claude/commands/work-loop.md";

/** Where the two sources ship. `templates/` is in `package.json` `files[]`. */
export const PROCESS_TEMPLATES_DIR = join(import.meta.dir, "..", "..", "templates", "process");

const TOKEN = 'env -u GH_TOKEN GITHUB_TOKEN="$(env -u GH_TOKEN gh auth token)"';

const READY_NOW = {
  harness: `   - what Ready holds now: \`${TOKEN} bun scripts/work-status.ts\` (START HERE section only)`,
  consumer:
    "   - what Ready holds now, and what a top-up would move into it (read-only as written): " +
    '`env -u GH_TOKEN BOARD_PROJECT_TOKEN="$(env -u GH_TOKEN gh auth token)" bunx rungate board-ready ' +
    "--repo <owner/name> --project <board id> --actor \"$(env -u GH_TOKEN gh api user -q .login)\" --top-up`",
};

/** A rendered process file, or why it could not be. */
export type ProcessFile = { path: string; content: string } | { path: string; content: null; why: string };

function source(name: string, dir: string): string | null {
  const p = join(dir, name);
  return existsSync(p) ? readFileSync(p, "utf-8") : null;
}

/** Every process file, rendered for this repository (`harness`) or a consumer. */
export function processFiles(harness: boolean, dir: string = PROCESS_TEMPLATES_DIR, testCommand?: string): ProcessFile[] {
  const missing = (path: string, name: string): ProcessFile => ({
    path,
    content: null,
    why: `templates/process/${name} is missing from this rungate installation`,
  });
  const command = source("dry-run.md", dir);
  const template = source("adr-template.md", dir);
  const board = source("board.md", dir);
  const workLoop = source("work-loop.md", dir);
  const cli = harness ? "bun bin/rungate.ts" : "bunx rungate";
  return [
    command === null
      ? missing(DRY_RUN_COMMAND_PATH, "dry-run.md")
      : {
          path: DRY_RUN_COMMAND_PATH,
          content: command
            .replaceAll("{{CLI}}", cli)
            .replace("{{READY_NOW}}", harness ? READY_NOW.harness : READY_NOW.consumer),
        },
    template === null ? missing(ADR_TEMPLATE_PATH, "adr-template.md") : { path: ADR_TEMPLATE_PATH, content: template },
    board === null
      ? missing(BOARD_COMMAND_PATH, "board.md")
      : { path: BOARD_COMMAND_PATH, content: board.replaceAll("{{CLI}}", cli) },
    workLoop === null
      ? missing(WORK_LOOP_COMMAND_PATH, "work-loop.md")
      : testCommand === undefined || testCommand.trim() === ""
        ? { path: WORK_LOOP_COMMAND_PATH, content: null, why: "no test command was given, so the work loop's test step would name a guess" }
        : { path: WORK_LOOP_COMMAND_PATH, content: workLoop.replaceAll("{{CLI}}", cli).replaceAll("{{TEST_COMMAND}}", testCommand) },
  ];
}
