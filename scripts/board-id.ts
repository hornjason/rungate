#!/usr/bin/env bun
/**
 * `rungate board-id [--project-root <dir>]` — the board's node id, from
 * `board.id` in the project's rungate config (#2173).
 *
 * For a workflow that does its work in shell rather than through a rungate
 * command: `board-intake.yml` (#2166) runs `gh api graphql` and needs the
 * board's id, and a generated workflow must name none (SC-2745). Reading the
 * config with `jq` in YAML would build a config path outside
 * `lib/config-loader.ts` and see only one of the two layouts
 * (`.claude/rules/config-access.md`), so the read goes through
 * `readBoardProjectId`, the reader `board-ready`, `work-status` and
 * `status-view` already use.
 *
 * Prints the id and nothing else, so `PROJECT_ID=$(bunx rungate@X board-id)`
 * is the whole of a caller's parsing. A config with no `board.id`, or no
 * config, is UNMEASURED on stderr and `EXIT_REFUSED` — never an empty line
 * and exit 0, which a caller would carry into every query as a blank id.
 * A malformed config throws, as the loader does: a corrupt config is not a
 * missing board.
 *
 * Relative imports are `../lib/` only: `test/board-id.test.ts` rewrites
 * them to absolute paths to run a mutant from a temp directory.
 */
import { resolve } from "path";
import { readBoardProjectId } from "../lib/config-readers";

/** The one non-zero exit for a reading not taken. Assigned once; the test mutates it. */
export const EXIT_REFUSED = 2;

export function main(argv: readonly string[]): number {
  let rootArg: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project-root") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        console.error("UNMEASURED: --project-root needs a directory after it. Nothing was read.");
        return EXIT_REFUSED;
      }
      rootArg = next;
      i++;
    } else {
      console.error(`UNMEASURED: unknown argument ${JSON.stringify(a)}. Usage: rungate board-id [--project-root <dir>]. Nothing was read.`);
      return EXIT_REFUSED;
    }
  }
  const root = resolve(rootArg ?? process.cwd());
  const id = readBoardProjectId(root);
  if (id === null) {
    console.error(`UNMEASURED: no board — set board.id in the rungate config under ${root}. Nothing was printed.`);
    return EXIT_REFUSED;
  }
  console.log(id);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
