import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { loadRungateConfig } from "../lib/config-loader";
import {
  liveCommandsExecuting,
  liveHookRegistration,
  liveScopeReadability,
  liveUserSettingsPath,
} from "./helpers/user-settings";
import { settingsCommands } from "../lib/hook-trees";

// SPEC-REF: HOOK-ARCHITECTURE-SPEC.md § Design Decisions

/**
 * Issue #67-A — the concurrency guard was registered at the wrong scope.
 *
 * TestSuiteGuard and TestSuiteRelease were registered only in rungate's PROJECT
 * `.claude/settings.json`. Project settings load from the directory a session
 * was started in, so the guard was inert for every session rooted anywhere else
 * — including sessions actively working on rungate through an added working
 * directory. The cap that exists to be machine-wide was in fact per-project.
 *
 * Measured, not assumed: with both slots freshly held, `pnpm test` (a spelling
 * the parser guards) reached the shell and failed with `command not found`
 * instead of being blocked.
 *
 * The guard therefore belongs in the USER settings file, next to the other
 * rungate hooks that are already registered there. It must not ALSO stay in the
 * project file: the two scopes are not de-duplicated, so a rungate-rooted
 * session would run the hook twice and burn two slots on one suite.
 *
 * ## This file held the contradiction #910 missed, and nothing compared them
 *
 * "`TestSuiteRelease.hook.ts` is registered in user settings" has been
 * asserted here, and green, since #67-A. #898's census reported the same hook
 * registered nowhere, two hook files were given unregistered declarations on
 * the strength of that, and #910 attributed a month of TTL waits to it. Two
 * positions in one repository, opposite claims about one hook, and no reader
 * holding both.
 *
 * Two things changed here as a result, and neither is a new claim:
 *
 * - The local settings walker is gone. `settingsCommands` in
 *   `lib/hook-trees.ts` is the one extractor, so a third copy cannot drift
 *   from the other two.
 * - The user-scope cases no longer `skipIf`. A silently-skipped check is the
 *   same failure mode as the census that silently read one scope — it is the
 *   fifth shape in `.claude/rules/checks-must-be-able-to-fail.md` wearing a
 *   green tick. They now assert the UNMEASURED reading the complete census
 *   returns, so CI witnesses the refusal instead of passing over the subject.
 */

const repoRoot = join(__dirname, "..");
const projectSettingsPath = join(repoRoot, ".claude", "settings.json");
const userSettingsPath = liveUserSettingsPath();

const SLOT_HOOKS = ["TestSuiteGuard.hook.ts", "TestSuiteRelease.hook.ts"];

/** The registry's commands, the census's fifth scope. */
function registry(): string[] {
  return (loadRungateConfig(repoRoot) as { hooks: { command?: string }[] }).hooks.map(h => h.command ?? "");
}

describe("#67-A: slot hooks are registered machine-wide, not per-project", () => {
  const projectCommands = settingsCommands([readFileSync(projectSettingsPath, "utf-8")]);

  for (const hook of SLOT_HOOKS) {
    test(`${hook} is NOT registered in project settings`, () => {
      // Project scope is the bug. Re-adding it here would both narrow the cap
      // back to rungate-rooted sessions and double-fire for those that remain.
      expect(projectCommands.some((c) => c.includes(hook))).toBe(false);
    });

    test(`${hook} exists at the path the user settings reference`, () => {
      expect(existsSync(join(repoRoot, "hooks", hook))).toBe(true);
    });
  }
});

describe("#67-A / #910: the user-scope registration, reported rather than skipped", () => {
  // Called INSIDE each case, never at describe level. `readRegistrationScopes`
  // refuses an incomplete reading by throwing, and a throw during describe
  // evaluation kills the block: the cases never register, so the run reports
  // four fewer tests rather than four failures. Measured as battery row M9 —
  // the count was right and every name in it was wrong, which is the failure
  // mode `.claude/rules/checks-must-be-able-to-fail.md` calls an instrument
  // that stopped reporting.
  for (const hook of SLOT_HOOKS) {
    const name = hook.replace(/\.hook\.ts$/, "");

    test(`${name} is not UNREGISTERED under a reading of every scope`, () => {
      // This is the assertion #898's census contradicted and #910 shipped
      // without. It holds on a runner too: with `~/.claude/settings.json`
      // absent the verdict is `unmeasured`, which is reported and is not
      // `unregistered`. The previous `skipIf` made the same run report a
      // green tick for a case that never executed. Read through the settings
      // helper, which returns the verdict and never a command (#2792).
      const r = liveHookRegistration(repoRoot, registry(), name);
      expect(r.verdict, `${name}: ${r.detail}`).not.toBe("unregistered");
    });

    test(`${name}: the user scope is read, or named as unread`, () => {
      const user = liveScopeReadability(repoRoot, registry()).find(r => r.scope === "user-settings")!;
      if (!user.readable) {
        expect(
          user.unreadable,
          "the user scope is unreadable and gave no reason, so nobody can tell whether it was " +
            "tried",
        ).toBeTruthy();
        expect(liveHookRegistration(repoRoot, registry(), name).unreadable).toContain("user-settings");
        return;
      }
      // Two registrations means two slots taken for one suite, so this stays
      // an exact count rather than a floor. A count, never the commands: the
      // file holds the machine's tokens (#2792).
      const count = liveCommandsExecuting(repoRoot, registry(), "user-settings", name);
      expect(count, `${hook} is registered ${count} times in ${userSettingsPath}`).toBe(1);
      expect(liveHookRegistration(repoRoot, registry(), name).registeredIn).toContain("user-settings");
    });
  }
});
