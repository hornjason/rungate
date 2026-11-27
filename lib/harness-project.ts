/**
 * "Is this directory inside a rungate-harnessed project?" — one decider.
 *
 * Lifted out of BashToolGuard (retired with COMP-7 by #2939), where it was a
 * private function, because #992 needs the same question answered by a
 * second hook. TopLevelCdGuard and BunTestPathGuard are its callers now.
 * A second inline copy would be two deciders for one question, which is this
 * repository's most frequently repeated defect and is named as the thing to
 * avoid in #992's own comments.
 *
 * ## Why hooks need this at all
 *
 * A hook registered at USER level fires for every Claude Code session on the
 * machine, including projects that have nothing to do with rungate. Scoping
 * cannot live in the registration: project-level hooks do not reach worktree
 * subagents, so user-level registration is required and the scope check has
 * to be in the hook.
 *
 * ## Both markers, deliberately
 *
 * Config is migrating from the monolithic `.claude/rungate.json` to the
 * directory form `.claude/rungate/` (`CONFIG-DIRECTORY-STRUCTURE-SPEC.md`),
 * and `lib/config-loader.ts` reads the directory and falls back to the file.
 * Checking only one marker would silently go quiet for every project on the
 * other layout — a hook that stops firing and a project that is not
 * harnessed look identical from outside.
 *
 * This deliberately does NOT call `loadRungateConfig`: that throws on a
 * malformed config, and a hook on every Bash call must not turn a bad config
 * into a crash. The question here is "is there a harness here", not "is it
 * valid".
 *
 * Issue: #992.
 */

import { existsSync } from "fs";
import { dirname, join } from "path";

/** True when `startDir` sits at or below a rungate-harnessed project. */
export function isHarnessProject(startDir: string): boolean {
  let dir = startDir;
  while (true) {
    const claude = join(dir, ".claude");
    if (existsSync(join(claude, "rungate.json")) || existsSync(join(claude, "rungate"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}
