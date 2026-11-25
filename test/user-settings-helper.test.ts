/**
 * #2792: tests read the machine's settings files through one helper, and that
 * helper hands them nothing a failure could leak.
 *
 * `~/.claude/settings.json` holds the machine's tokens in `env`. Before #2787,
 * AC-11 printed the whole file on failure; three review rounds then found three
 * more ways file text reached the output. The census suites cannot work from a
 * count — they compare which hook files each scope registers and resolve
 * `${VAR}` paths through `env` merged across scopes — so the helper keeps
 * exactly what they read: the hook files the commands execute, and every
 * variable some scope's hook path references. Everything else never reaches a
 * test, so no assertion can print it.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";
import { readRegistrationScopes, settingsScopePaths } from "../lib/hook-scopes";
import { mergeEnv, readEnvScopes, resolvePath } from "../lib/hook-target-tree";
import { executedHookPath, settingsCommands } from "../lib/hook-trees";
import {
  homePath,
  homeSettingsReads,
  NO_HOOK_FILE,
  REDUCED_EVENT,
  reduceCommand,
  redactSettings,
  settingsReader,
} from "./helpers/user-settings";

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
    // No event name or matcher survives; only the reduced commands, in order.
    expect(Object.keys(doc.hooks)).toEqual([REDUCED_EVENT]);
    const commands = doc.hooks[REDUCED_EVENT][0].hooks.map((h: { command: string }) => h.command);
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

  test("the census finds the same hook files in the copy as in the original, whatever shape nests them", () => {
    // #2798 review: a command on the group itself, outside its hooks list, is
    // one the census's walk takes. So is one a level deeper than today's schema.
    const shapes = [
      PLANTED,
      { hooks: { PreToolUse: [{ matcher: "Bash", command: "bun /x/TopLevelCdGuard.hook.ts" }] } },
      { hooks: { Stop: [{ hooks: [{ nested: { command: "bun ${H}/Deep.hook.ts" } }] }] } },
      { hooks: { "gho_planted2792": [{ hooks: [{ type: "command", command: "bun /x/KeyNamed.hook.ts" }] }] } },
    ];
    for (const shape of shapes) {
      const src = JSON.stringify(shape);
      const out = redactSettings(src);
      expect(out).not.toMatch(/planted2792/);
      expect(settingsCommands([out]).map(executedHookPath)).toEqual(settingsCommands([src]).map(executedHookPath));
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

  test("#2798 round 3: an env value is kept when it is an absolute path, whoever reads it, and dropped otherwise", () => {
    const env = {
      UNREAD_DIR: "/srv/nobody/reads/this",
      READ_DIR: "/srv/rungate/hooks",
      TILDE: "~/hooks",
      RELATIVE: "hooks",
      SPACED: "/srv/My Hooks",
      SHELL: "/bin/sh -c 'echo $GH_TOKEN'",
      TOKEN: "gho_planted2792",
      JSONKEY: '{"private_key":"planted2792"}',
      NUMBER: 3,
    };
    const doc = JSON.parse(redactSettings(JSON.stringify({ env, hooks: {} })));
    expect(doc.env).toEqual({ UNREAD_DIR: "/srv/nobody/reads/this", READ_DIR: "/srv/rungate/hooks" });
  });

  test("every hook path resolves the same through the copies as through the originals, across scopes", () => {
    // #2798 review: the census merges `env` across every scope before it
    // resolves a path, so a variable one file defines and another file's hook
    // reads must keep its value, and one two files define must keep both. A
    // generated battery, because the defect sits in which scope holds what:
    // each case spreads definitions and references across all four scopes.
    let seed = 2798;
    const rand = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const VARS = ["A", "B", "C"];
    const kinds = new Map<string, number>();
    let crossScope = 0;
    let registryReads = 0;
    for (let i = 0; i < 200; i++) {
      const repo = mkdtempSync(join(tmpdir(), "rg-2798-repo-"));
      const home = mkdtempSync(join(tmpdir(), "rg-2798-home-"));
      try {
        mkdirSync(join(repo, ".claude"), { recursive: true });
        mkdirSync(join(home, ".claude"), { recursive: true });
        const definedIn = new Map<string, Set<number>>();
        const readIn = new Map<string, Set<number>>();
        settingsScopePaths(repo, home).forEach(({ path }, scope) => {
          if (rand() < 0.15) return; // absent
          // The committed scope is in git and read verbatim, so only the others carry a token.
          const env: Record<string, string> = scope === 0 ? {} : { GH_TOKEN: "gho_planted2798" };
          for (const v of VARS) {
            if (rand() < 0.35) {
              env[v] = pick(["/v1", "/v2"]);
              (definedIn.get(v) ?? definedIn.set(v, new Set()).get(v)!).add(scope);
            }
          }
          const commands = Array.from({ length: Math.floor(rand() * 3) }, (_, k) => {
            const v = pick([...VARS, "literal"]);
            if (v !== "literal") (readIn.get(v) ?? readIn.set(v, new Set()).get(v)!).add(scope);
            return v === "literal" ? `bun /lit/H${k}.hook.ts` : `bun ${"$"}{${v}}/hooks/H${k}.hook.ts`;
          });
          const nested = rand() < 0.5;
          const hooks = nested
            ? { PreToolUse: [{ matcher: "Bash", hooks: commands.map(command => ({ type: "command", command })) }] }
            : { PreToolUse: commands.map(command => ({ matcher: "Bash", command })) };
          writeFileSync(path, JSON.stringify({ env, hooks }));
        });
        for (const [v, readers] of readIn) {
          const defs = definedIn.get(v) ?? new Set<number>();
          if ([...defs].some(d => ![...readers].includes(d))) crossScope++;
        }
        // #2798 round 3: the repo registry is an input too, and its commands
        // read variables no settings file's hook may read.
        const registry = Array.from({ length: Math.floor(rand() * 3) }, (_, k) => {
          const v = pick([...VARS, "literal"]);
          if (v !== "literal") (readIn.get(v) ?? readIn.set(v, new Set()).get(v)!).add(4);
          return v === "literal" ? `bun /lit/R${k}.hook.ts` : `bun ${"$"}{${v}}/hooks/R${k}.hook.ts`;
        });
        if (registry.some(c => c.includes("$"))) registryReads++;
        const raw = (p: string): string | null => (existsSync(p) ? readFileSync(p, "utf-8") : null);
        const copy = settingsReader(repo, home);
        const original = readRegistrationScopes(repo, home, raw, registry);
        const reduced = readRegistrationScopes(repo, home, copy, registry);
        expect(JSON.stringify([reduced, readEnvScopes(repo, home, copy)])).not.toMatch(/planted2798/);
        const files = (rs: typeof original) => rs.map(r => r.commands?.map(executedHookPath) ?? null);
        expect(files(reduced), `case ${i}: a scope's hook files differ`).toEqual(files(original));
        const envOriginal = mergeEnv(readEnvScopes(repo, home, raw));
        const envReduced = mergeEnv(readEnvScopes(repo, home, copy));
        for (const p of files(original).flat()) {
          if (p === null || p === undefined) continue;
          const want = resolvePath(p, envOriginal, null);
          const kind = want.kind === "resolved" ? "resolved" : /defined \d+ times/.test(want.reason) ? "twice" : "undefined";
          kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
          expect(resolvePath(p, envReduced, null), `case ${i}: ${p} resolves differently through the copies`).toEqual(want);
        }
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    }
    // The battery reached every outcome the defect could change, and the axis it sits on.
    expect(kinds.get("resolved") ?? 0).toBeGreaterThan(10);
    expect(kinds.get("twice") ?? 0).toBeGreaterThan(10);
    expect(kinds.get("undefined") ?? 0).toBeGreaterThan(10);
    expect(registryReads).toBeGreaterThan(50);
    expect(crossScope).toBeGreaterThan(50);
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
      // Fixtures are scanned too: bun runs any .ts test file under them (#2798 review).
      if (name === "node_modules") return [];
      return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(name) ? [p] : [];
    });

  test("no file under test/ but the helper hands home to a call, or builds a home path to a settings file", () => {
    const helper = join(ROOT, "test", "helpers", "user-settings.ts");
    const scanned = files(join(ROOT, "test")).filter(f => f !== helper);
    // The walk reaches the fixtures, where bun also runs test files.
    expect(scanned.some(f => relative(ROOT, f).startsWith(join("test", "fixtures")))).toBe(true);
    const hits = scanned.flatMap(f => homeSettingsReads(readFileSync(f, "utf-8")).map(line => `${relative(ROOT, f)}:${line}`));
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
    // #2798 review: each shape the earlier call-name list missed, by line.
    const missed: [string, number[]][] = [
      ['import path from "path";\nconst u = path.join(homedir(), ".claude", "settings.json");', [2]],
      ['readFileSync(join(homedir(), ".claude/settings.json"));', [1]],
      ['resolve(homedir(), ".claude", "settings.local.json");', [1]],
      ["mod.readRegistrationScopes(ROOT, homedir(), read, []);", [1]],
      ["readRegistrationCurrency({ repoRoot: R, home: homedir(), readFile: r });", [1]],
      ["const home = os.homedir();\nf({ home });", [2]],
      ['const p = `${homedir()}/.claude/settings.json`;', [1]],
      ['const p = homedir() + "/.claude/" + "settings.json";', [1]],
      ['const d = join(homedir(), ".claude");\nreadFileSync(join(d, "settings.json"));', [2]],
      ["readEnvScopes(R, join(homedir()), read);", [1]],
      ['import { homedir as h } from "os";\nreadEnvScopes(R, h(), read);', [2]],
      ["const { HOME: H } = process.env;\nsettingsScopePaths(R, H!);", [2]],
      ["readEnvScopes(R, Bun.env.HOME!, read);", [1]],
      ['const c = homePath(".claude");\nreadFileSync(join(c, "settings.json"));', [2]],
    ];
    for (const [src, lines] of missed) expect(homeSettingsReads(src), src).toEqual(lines);
    // #2798 review, round 2: a settings name held in a variable or a parameter,
    // a single-string or slash-split `homePath`, and a path through `..`.
    const named: [string, number[]][] = [
      ['const f = "settings.json";\nreadFileSync(join(homedir(), ".claude", f));', [2]],
      ['function r(f: string) { return readFileSync(join(homedir(), ".claude", f)); }', [1]],
      ['const f = "/.claude/settings.json";\nconst p = homedir() + f;', [2]],
      ['const g = (x: string) => homedir() + "/.claude/" + x;', [1]],
      ["const g = (x: string) => `${homedir()}/.claude/${x}`;", [1]],
      // #2798 round 3: an unreadable part anywhere under home, not only under ~/.claude.
      ['const readUser = (rel: string) => readFileSync(join(homedir(), rel), "utf-8");', [1]],
      ['const g = (x: string) => join(homedir(), ".pai", x);', [1]],
      ['join(homedir(), ".claude", "x", "..", "settings.json");', [1]],
      ['const d = join(homedir(), ".claude");\nconst f = "settings.local.json";\nreadFileSync(join(d, f));', [3]],
      // One name declared twice reads as unknown, and the scan still ends.
      ['function a() { const f = "x.json"; }\nfunction b() { const f = "settings.json"; return join(homedir(), ".claude", f); }', [2]],
      ['function a() { const d = join(homedir(), ".pai"); }\nfunction b(f: string) { const d = join(homedir(), ".claude"); return join(d, f); }', [2]],
      // A path normalised to a settings file, however it is spelled.
      ['join(homedir(), ".claude", "settings.json", ".");', [1]],
    ];
    for (const [src, lines] of named) expect(homeSettingsReads(src), src).toEqual(lines);
    // An unreadable name outside ~/.claude, and ~/.claude itself, are not settings files.
    // `homePath` is not flagged: it refuses every spelling of a settings path at run time (below).
    expect(homeSettingsReads('readFileSync(homePath(".claude/settings.json"));')).toEqual([]);
    // A message that starts with a home path is not a path.
    expect(homeSettingsReads('const d = join(homedir(), ".rungate");\nconst m = `${d} holds ${n} runs` + "and more";')).toEqual([]);
    expect(homeSettingsReads('const d = join(homedir(), ".claude");')).toEqual([]);
    // An assertion comparing to home, a home path that is not a settings file,
    // and a command string naming one are not reads.
    expect(homeSettingsReads("expect(x).toBe(homedir());\nexpect(y).not.toEqual(process.env.HOME);")).toEqual([]);
    expect(homeSettingsReads('const PAI = homePath(".pai", "hooks");\nreaddirSync(PAI);\njoin(homedir(), ".pai", "hooks");')).toEqual([]);
    expect(homeSettingsReads('const c = `echo x > ${process.env.HOME}/.claude/hooks/X.hook.ts`;')).toEqual([]);
    // A home directory held in a variable, or read from the environment, is still home.
    expect(homeSettingsReads("const h = homedir();\nreadRegistrationScopes(R, h, read, []);")).toEqual([2]);
    expect(homeSettingsReads("const h = process.env.HOME!;\nreadEnvScopes(R, h, read);")).toEqual([2]);
    expect(homeSettingsReads('const h = process.env["HOME"]!;\nsettingsScopePaths(R, h);')).toEqual([2]);
    // A source that never reaches home may drive the readers over planted directories.
    expect(homeSettingsReads('readRegistrationScopes("/repo", "/home", () => null, []);')).toEqual([]);
  });

  test("homePath names a path under home, never home itself or a settings file", () => {
    expect(() => homePath()).toThrow();
    // However the path is split or spelled (#2798 review, round 2).
    const settings = [
      [".claude", "settings.json"],
      [".claude", "settings.local.json"],
      [".claude/settings.json"],
      [".claude/", "settings.json"],
      [".claude", "x", "..", "settings.local.json"],
      ["./.claude//settings.json"],
    ];
    for (const segments of settings) expect(() => homePath(...segments), segments.join(" | ")).toThrow();
    expect(homePath(".pai", "hooks").endsWith(join(".pai", "hooks"))).toBe(true);
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
