#!/usr/bin/env bun
/**
 * `rungate board-intake-move --project <id> --item <id> --column <name>` —
 * move a board item to a column and verify it in both the item's field value
 * and the project's search index (#2193, part 1 of #2183). The logic, and
 * why each refusal exists, is in `lib/board-intake-move.ts`.
 *
 * Prints a `::notice` on success and a `::error` naming the cause on every
 * refusal, so a workflow step that runs it shows the reason as an annotation.
 * An empty `--item` is accepted here and refused by the library as NO_ITEM,
 * which says which half of the intake failed.
 *
 * Relative imports are `../lib/` only, so a test can run a copy of it from a
 * temp directory.
 */
import { createGitHubClient } from "../lib/github";
import { moveToColumn } from "../lib/board-intake-move";

/** The one non-zero exit. Assigned once. */
export const EXIT_REFUSED = 1;

const USAGE = "rungate board-intake-move --project <node-id> --item <item-id> --column <name>";

export async function main(argv: readonly string[]): Promise<number> {
  const values: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const key = a.replace(/^--/, "");
    if (!["--project", "--item", "--column"].includes(a)) {
      console.error(`::error title=Board intake::unknown argument ${JSON.stringify(a)}. Usage: ${USAGE}. Nothing was read.`);
      return EXIT_REFUSED;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      console.error(`::error title=Board intake::${a} needs a value after it. Usage: ${USAGE}. Nothing was read.`);
      return EXIT_REFUSED;
    }
    values[key] = next;
    i++;
  }
  for (const required of ["project", "column"]) {
    if (!values[required]) {
      console.error(`::error title=Board intake::--${required} is required. Usage: ${USAGE}. Nothing was read.`);
      return EXIT_REFUSED;
    }
  }
  const client = createGitHubClient();
  const result = await moveToColumn(
    { projectId: values.project!, itemId: values.item ?? "", column: values.column! },
    {
      graphql: (query, variables) => client.graphql(query, variables),
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      log: line => console.log(line),
    },
  );
  if (result.ok) {
    console.log(`::notice title=Board intake::${result.message}`);
    return 0;
  }
  console.error(`::error title=Board intake::${result.message}`);
  return EXIT_REFUSED;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
