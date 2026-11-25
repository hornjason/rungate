/**
 * #2792: tests read the machine's settings files through one helper, and that
 * helper hands them nothing a failure could leak.
 *
 * `~/.claude/settings.json` holds the machine's tokens in `env`. Before #2787,
 * AC-11 printed the whole file on failure; three review rounds then found three
 * more ways file text reached the output. The census suites cannot work from a
 * count — they compare which hook files each scope registers and resolve
 * `${VAR}` paths through `env` — so the helper keeps exactly what they read: the
 * hook commands and the variables those commands reference. Everything else
 * never reaches a test, so no assertion can print it.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";
import { readRegistrationScopes, settingsScopePaths } from "../lib/hook-scopes";
import { readEnvScopes } from "../lib/hook-target-tree";
import { executedHookPath } from "../lib/hook-trees";
import { homeSettingsReads, NO_HOOK_FILE, reduceCommand, redactSettings, settingsReader } from "./helpers/user-settings";

const ROOT = join(import.meta.dir, "..");

const PLANTED = {
  env: {
    GH_TOKEN: "gho_planted2792",
    OTHER_KEY: "sk-planted2792",
    RUNGATE_HOOKS_DIR: "/srv/rungate/hooks",
  },
  apiKeyHelper: "echo sk-planted2792-helper",
  hooks: {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [
          { type: "command", command: "bun ${RUNGATE_HOOKS_DIR}/TopLevelCdGuard.hook.ts" },
          { type: "command", command: "GITHUB_TOKEN=gho_planted2792 bun /srv/x/Other.hook.ts" },
          // Security review: a quoted value with spaces, a flag value, and a command running no hook file.
          { type: "command", command: 'TOKEN="a b sk-planted2792" bun /srv/x/Quoted.hook.ts --token=sk-planted2792' },
          { type: "command", command: 'curl -H "Authorization: Bearer gho_planted2792" https://example.invalid' },
        ],
      },
    ],
  },
};

describe("#2792: the helper keeps what the census reads and nothing else", () => {
  test("redactSettings keeps each hook's executed file and the variables it references, and nothing else", () => {
    const out = redactSettings(JSON.stringify(PLANTED, null, 2));
    expect(out).not.toMatch(/planted2792/);
    const doc = JSON.parse(out);
    expect(doc.env).toEqual({ RUNGATE_HOOKS_DIR: "/srv/rungate/hooks" });
    expect(Object.keys(doc).sort()).toEqual(["env", "hooks"]);
    const commands = doc.hooks.PreToolUse[0].hooks.map((h: { command: string }) => h.command);
    expect(commands).toEqual([
      "bun ${RUNGATE_HOOKS_DIR}/TopLevelCdGuard.hook.ts",
      "bun /srv/x/Other.hook.ts",
      // The census's own whitespace parse reads no hook file in a quoted assignment, so neither does the copy.
      NO_HOOK_FILE,
      NO_HOOK_FILE,
    ]);
    // The census reads the same hook file from each reduced command as from the original.
    for (const h of PLANTED.hooks.PreToolUse[0]!.hooks) {
      expect(executedHookPath(reduceCommand(h.command))).toBe(executedHookPath(h.command));
    }
  });

  test("a machine-owned scope is read redacted, the committed project scope verbatim, an absent one as null", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-2792-repo-"));
    const home = mkdtempSync(join(tmpdir(), "rg-2792-home-"));
    try {
      mkdirSync(join(repo, ".claude"), { recursive: true });
      mkdirSync(join(home, ".claude"), { recursive: true });
      const project = JSON.stringify({ hooks: {}, note: "committed, so not machine state" });
      writeFileSync(join(repo, ".claude", "settings.json"), project);
      writeFileSync(join(repo, ".claude", "settings.local.json"), JSON.stringify(PLANTED));
      writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(PLANTED));
      const read = settingsReader(repo, home);
      expect(read(join(repo, ".claude", "settings.json"))).toBe(project);
      for (const p of [join(repo, ".claude", "settings.local.json"), join(home, ".claude", "settings.json")]) {
        expect(read(p), p).not.toMatch(/planted2792/);
      }
      expect(read(join(home, ".claude", "settings.local.json"))).toBeNull();
      // Every reading the suites take, through the helper's reader, carries no planted text.
      const readings = JSON.stringify([
        readRegistrationScopes(repo, home, read, []),
        readEnvScopes(repo, home, read),
      ]);
      expect(readings).not.toMatch(/planted2792/);
      expect(readings).toContain("TopLevelCdGuard");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a machine-owned file that is not JSON throws without quoting it, and only absence reads as null", () => {
    const home = mkdtempSync(join(tmpdir(), "rg-2792-home-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      const user = join(home, ".claude", "settings.json");
      writeFileSync(user, '{ "env": { "GH_TOKEN": "gho_planted2792" ');
      const read = settingsReader(ROOT, home);
      let message = "";
      try {
        read(user);
      } catch (e) {
        message = String((e as Error).message);
      }
      expect(message).toContain("not JSON");
      expect(message).not.toMatch(/planted2792/);
      // A directory is unreadable, not absent.
      expect(() => read(join(home, ".claude"))).toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("#2792: no test reads a machine settings scope except through the helper", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap(name => {
      const p = join(dir, name);
      if (name === "node_modules" || name === "fixtures") return [];
      return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(name) ? [p] : [];
    });

  test("every call that passes homedir() to a settings reader, or builds join(homedir(), \".claude\"), is the helper's", () => {
    const helper = join(ROOT, "test", "helpers", "user-settings.ts");
    const hits = files(join(ROOT, "test"))
      .filter(f => f !== helper)
      .flatMap(f => homeSettingsReads(readFileSync(f, "utf-8")).map(line => `${relative(ROOT, f)}:${line}`));
    expect(hits, "read these through test/helpers/user-settings.ts").toEqual([]);
  });

  test("the scan refuses each shape it names, on a planted source, by line", () => {
    const planted = [
      'import { homedir } from "os";',
      "readRegistrationScopes(ROOT, homedir(), readIfPresent, []);",
      "readEnvScopes(",
      "  ROOT,",
      "  homedir(),",
      "  readIfPresent,",
      ");",
      'const user = join(homedir(), ".claude", "settings.json");',
      "settingsScopePaths(ROOT, homedir());",
      'const pai = join(homedir(), ".pai", "hooks");',
    ].join("\n");
    expect(homeSettingsReads(planted)).toEqual([2, 3, 8, 9]);
    // A home directory held in a variable, or read from the environment, is still home.
    expect(homeSettingsReads("const h = homedir();\nreadRegistrationScopes(R, h, read, []);")).toEqual([2]);
    expect(homeSettingsReads("const h = process.env.HOME!;\nreadEnvScopes(R, h, read);")).toEqual([2]);
    expect(homeSettingsReads('const h = process.env["HOME"]!;\nsettingsScopePaths(R, h);')).toEqual([2]);
    // A source that never reaches home may drive the readers over planted directories.
    expect(homeSettingsReads('readRegistrationScopes("/repo", "/home", () => null, []);')).toEqual([]);
  });

  test("settingsScopePaths still names the scopes the helper treats as machine state", () => {
    expect(settingsScopePaths("/r", "/h").map(s => s.scope)).toEqual([
      "project-settings",
      "project-local-settings",
      "user-settings",
      "user-local-settings",
    ]);
  });
});
