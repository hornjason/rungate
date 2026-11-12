/**
 * #1986: `.claude/rungate/hooks.json` described `TopLevelCdGuard` as NOT LIVE
 * while `~/.claude/settings.json` registered it and it was refusing commands.
 * The registry is the one place the repository says which hooks run, and
 * nothing compared its claim with the registration.
 *
 * Covers `liveClaimLines` in `lib/hook-scopes.ts` and its report from
 * `hooks/HookCurrency.hook.ts`.
 *
 * What is proved, with fixtures that drive the real decider:
 *
 *   - a registry entry that claims NOT LIVE for a hook a settings scope
 *     registers produces a named disagreement;
 *   - the same entry with the registration removed produces nothing;
 *   - with the machine scopes unreadable — the state of every CI runner —
 *     the result is UNMEASURED, never a verdict either way;
 *   - the registry naming the hook does not count as a registration, because
 *     every hook in the registry names itself there and a session does not
 *     load hooks from it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { REGISTRATION_SCOPES, liveClaimLines, type ScopeReading } from "../lib/hook-scopes";

const ROOT = join(import.meta.dir, "..");
const CMD = "bun /h/hooks/PlantedGuard.hook.ts";
const NOT_LIVE = { name: "PlantedGuard", description: "Refuses things. This hook is NOT LIVE." };

/** Every scope readable; `commands` per scope, the registry naming the hook as it always does. */
function readings(commands: Partial<Record<string, string[] | null>>): ScopeReading[] {
  return REGISTRATION_SCOPES.map(scope => {
    const c = scope in commands ? commands[scope] : scope === "repo-registry" ? [CMD] : [];
    return c === null
      ? { scope, commands: null, unreadable: "not on this machine" }
      : { scope, commands: c ?? [] };
  });
}

describe("#1986: a registry entry's NOT LIVE claim is checked against the registration", () => {
  test("#1986: claims NOT LIVE, user settings registers it — a named disagreement", () => {
    const lines = liveClaimLines([NOT_LIVE], readings({ "user-settings": [CMD] }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("PlantedGuard");
    expect(lines[0]).toContain("user-settings");
    expect(lines[0]).toMatch(/DISAGREES/);
  });

  test("#1986: the same entry with the registration removed — nothing to report", () => {
    expect(liveClaimLines([NOT_LIVE], readings({}))).toEqual([]);
  });

  test("#1986: the registry naming the hook is not a registration a session loads", () => {
    // Every registry entry carries its own command, so counting the registry
    // would make every NOT LIVE claim disagree with itself.
    expect(liveClaimLines([NOT_LIVE], readings({ "repo-registry": [CMD] }))).toEqual([]);
  });

  test("#1986: machine scopes unreadable — UNMEASURED, not silence and not a verdict", () => {
    const lines = liveClaimLines(
      [NOT_LIVE],
      readings({ "user-settings": null, "user-local-settings": null }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/UNMEASURED/);
    expect(lines[0]).not.toMatch(/DISAGREES/);
  });

  test("#1986: an entry that claims nothing about liveness is never reported", () => {
    const plain = { name: "PlantedGuard", description: "Refuses things." };
    expect(liveClaimLines([plain], readings({ "user-settings": [CMD] }))).toEqual([]);
  });
});

describe("#1986: the live tree", () => {
  test("#1986: TopLevelCdGuard's entry no longer says it is NOT LIVE", () => {
    const registry = JSON.parse(readFileSync(join(ROOT, ".claude", "rungate", "hooks.json"), "utf-8"));
    const hooks: Array<{ name: string; description?: string }> = Array.isArray(registry)
      ? registry
      : registry.hooks;
    const entry = hooks.find(h => h.name === "TopLevelCdGuard");
    expect(entry, "TopLevelCdGuard is missing from the registry").toBeDefined();
    expect(entry!.description ?? "").not.toMatch(/not live/i);
  });

  test("#1986: the session-start hook reports the comparison", () => {
    const hook = readFileSync(join(ROOT, "hooks", "HookCurrency.hook.ts"), "utf-8");
    expect(hook).toContain("liveClaimLines(");
  });
});
