/**
 * Whether this rungate install can load its own dependencies — #2479.
 *
 * A version-pinned `bunx rungate@<v>` installs into one shared temporary
 * directory per version, so agents starting it at the same moment can find
 * that directory half-written. The command then dies inside a script on
 * `Cannot find package 'zod'` (or `@octokit/rest`), naming a temp path, and
 * nothing in the message says what happened or what to do. `bin/rungate.ts`
 * asks this module first and says so in words instead.
 *
 * It imports node builtins only, and no other lib file, because it runs
 * inside an install that may be missing any dependency. It never exits: the
 * CLI owns the one refusal, through `INCOMPLETE_INSTALL_EXIT`, so a test can
 * set it to 0 and watch the refusal go.
 */
import { readFileSync } from "fs";
import { join } from "path";

/** The CLI's exit status for an incomplete install. One site, so a mutant can zero it. */
export const INCOMPLETE_INSTALL_EXIT = 1;

/**
 * Every package in `packageRoot`'s `package.json` `dependencies` that does
 * not resolve from `packageRoot`, in declaration order.
 *
 * An unreadable `package.json` throws rather than reading as "nothing
 * missing": a check that cannot read what it checks has not passed.
 */
export function missingDependencies(packageRoot: string): string[] {
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const missing: string[] = [];
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    try {
      Bun.resolveSync(name, packageRoot);
    } catch {
      // Not resolvable is the reading itself, and it is recorded, not dropped:
      // the package goes on the list the CLI refuses with.
      missing.push(name);
    }
  }
  return missing;
}

/** What the CLI prints when `missingDependencies` is not empty. */
export function incompleteInstallMessage(packageRoot: string, missing: string[]): string {
  return [
    `rungate: this install is incomplete — ${packageRoot} cannot load ${missing.join(", ")}.`,
    "The usual cause is two `bunx rungate@<version>` runs installing into the same",
    "temporary directory at once. Re-run the command, or install rungate in the",
    "project and run node_modules/.bin/rungate, which installs nothing at run time.",
  ].join("\n");
}
