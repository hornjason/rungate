/**
 * One way to list the source files a census claims to police.
 *
 * Covers SC-2732, SC-2733 (specs/BOARD-FLOW-SPEC.md).
 *
 * ## Why this is a module and not a `readdirSync`
 *
 * Several census tests spelled the same line:
 *
 * ```ts
 * for (const f of readdirSync(join(ROOT, dir))) if (f.endsWith(".ts")) …
 * ```
 *
 * `readdirSync` does not recurse, and a directory entry fails
 * `endsWith(".ts")`, so every file under `lib/generators/`, `lib/scaffold/`
 * and `lib/validators/` was dropped **without a word**. Eighteen files sat
 * outside populations that reported themselves clean.
 *
 * That is the failure mode in `.claude/rules/checks-must-be-able-to-fail.md`
 * where the instrument is narrower than the thing it detects — and worse
 * here than usual, because these particular censuses exist to assert a
 * property over N sites rather than repair them one at a time. A census
 * with a hole in its population is the defect it was written to prevent,
 * wearing the shape of the prevention.
 *
 * Measured 2026-11-06, before the fix: of fourteen test files calling
 * `readdirSync`, seven already recursed, two scanned directories other than
 * these, and five scanned `lib/` or `scripts/` flat.
 * `test/selection-path-safety.test.ts` is the honest one of the five — its
 * case is named "no file **directly under** scripts/", so it declares the
 * narrow scope rather than claiming the whole tree.
 *
 * ## It returns paths, not names
 *
 * A census that joined a bare filename onto its directory could not express
 * `generators/types.ts`, so the return value is repo-relative and the
 * caller never rebuilds a path. The one exception a caller still needs —
 * "only the top level" — is a parameter rather than a second function,
 * because two listers is how the first hole appeared.
 */

import { readdirSync } from "fs";
import { join } from "path";

export interface SourceCensusOptions {
  /** File extension to keep, with the dot. */
  readonly ext?: string;
  /**
   * Stop at the top level.
   *
   * **For a census that SAYS it is top-level only**, like
   * `test/selection-path-safety.test.ts`, whose case is named for it. Not a
   * convenience: passing this to avoid dealing with a subdirectory
   * reintroduces the hole, and the case name is the only thing that makes
   * it honest.
   */
  readonly topLevelOnly?: boolean;
}

/**
 * Every source file under `dirs`, repo-relative, sorted.
 *
 * Directories that do not exist are skipped rather than thrown on: a census
 * naming a directory the tree has not got should fail on its own empty
 * population, with its own message, not on an ENOENT from here.
 */
export function sourceFiles(
  root: string,
  dirs: readonly string[],
  options: SourceCensusOptions = {},
): string[] {
  const ext = options.ext ?? ".ts";
  const out: string[] = [];
  const walk = (rel: string): void => {
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!options.topLevelOnly) walk(path);
        continue;
      }
      if (e.name.endsWith(ext)) out.push(path);
    }
  };
  for (const dir of dirs) walk(dir);
  return out.sort();
}
