/**
 * #2792: tests read the machine's settings files through one helper, and what
 * crosses its boundary is the census's verdicts, never a command, an error's
 * message, or a value except as part of the path a registration resolves to.
 *
 * Each case plants a home whose settings carry tokens in every place a token
 * can sit, runs a helper function over it, and asserts two things: no planted
 * text is in the result, and the result is the census's own verdict on the raw
 * documents with only the command and its detail replaced. The second is what
 * the earlier reduced-copy design (#2798, not merged) could not keep: a copy
 * is a second model of the census, and its review found a reader it starved
 * in each of four rounds.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readRegistrationScopes, registrationCensus, settingsScopePaths } from "../lib/hook-scopes";
import { readEnvScopes, registeredTreeCensus } from "../lib/hook-target-tree";
import { settingsCommands, wrongTreeViolations } from "../lib/hook-trees";
import {
  COMMAND_WITHHELD,
  commandsExecutingAt,
  countMentions,
  homePath,
  homePathAt,
  hookRegistrationAt,
  registrationCensusAt,
  registrationCurrencyAt,
  scopeReadability,
  settingsMentions,
  treeCensusAt,
  unplacedHooksAt,
  wrongTreeAt,
} from "./helpers/user-settings";

const PLANTED = /planted2792/;
let root: string;
let repo: string;
let home: string;
let hookDir: string;

const OWNED = ["Alpha", "Beta", "Gamma", "Delta", "Eps", "Zeta", "Reg"];
const REGISTRY = ["bun ${X_DIR}/Reg.hook.ts"];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "rg-2792-verdicts-"));
  repo = join(root, "repo");
  home = join(root, "home");
  hookDir = join(root, "hooks-elsewhere");
  for (const d of [join(repo, ".claude"), join(repo, "hooks"), join(home, ".claude"), hookDir]) mkdirSync(d, { recursive: true });
  writeFileSync(
    join(repo, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "bun ${CLAUDE_PROJECT_DIR}/hooks/Alpha.hook.ts" }] }] } }),
  );
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      env: { GH_TOKEN: "gho_planted2792", X_DIR: hookDir, OTHER: "sk-planted2792" },
      apiKeyHelper: "echo sk-planted2792-helper",
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "bun ${X_DIR}/Alpha.hook.ts" },
              { type: "command", command: "GITHUB_TOKEN=gho_planted2792 bun /srv/x/Beta.hook.ts" },
              // A hook named and not executed: the census reads it as unparsed (#2798 round 4).
              { type: "command", command: 'sh -c "bun ${X_DIR}/Gamma.hook.ts --token=gho_planted2792"' },
              { type: "command", command: 'TOKEN="a b gho_planted2792" bun /srv/x/Delta.hook.ts' },
              // Unresolved, and its command carries a token the census quotes in its reason.
              { type: "command", command: "GITHUB_TOKEN=gho_planted2792 bun ${UNDEFINED_DIR}/Zeta.hook.ts" },
            ],
          },
          // A command on the group itself.
          { matcher: "Bash", command: "bun /srv/x/Eps.hook.ts --key=sk-planted2792" },
        ],
      },
    }),
  );
});

// Every machine scope present, so the census is complete and reaches its unresolved readings.
beforeAll(() => writeFileSync(join(home, ".claude", "settings.local.json"), JSON.stringify({ env: { LOCAL_TOKEN: "gho_planted2792" } })));

afterAll(() => rmSync(root, { recursive: true, force: true }));

const raw = (p: string): string | null => {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return null;
  }
};

describe("#2792: every verdict is the census's own, with no command or value in it", () => {
  test("the planted home really does carry tokens where the census reads", () => {
    // Without this, every no-planted-text assertion below could hold because
    // nothing was planted.
    const commands = settingsCommands([raw(join(home, ".claude", "settings.json"))!]);
    expect(commands.filter(c => PLANTED.test(c)).length).toBeGreaterThanOrEqual(4);
  });

  test("wrongTreeAt: the same violations, a named-not-executed hook included, commands withheld", () => {
    const got = wrongTreeAt(repo, home, OWNED);
    expect(JSON.stringify(got)).not.toMatch(PLANTED);
    const docs = settingsScopePaths(repo, home).map(s => raw(s.path)).filter((d): d is string => d !== null);
    const want = wrongTreeViolations(OWNED, settingsCommands(docs));
    // The census's own details quote the command, token and all, so withholding them is doing work.
    expect(JSON.stringify(want)).toMatch(PLANTED);
    expect(got.violations.map(v => [v.hook, v.tree])).toEqual(want.map(v => [v.hook, v.tree]));
    expect(got.violations.map(v => [v.hook, v.tree])).toContainEqual(["Gamma", "unparsed"]);
    expect(got.violations.every(v => v.command === COMMAND_WITHHELD)).toBe(true);
    expect(got.read).toEqual(["project-settings", "user-settings", "user-local-settings"]);
    expect(got.missing).toEqual(["project-local-settings"]);
    expect(got.commands).toBe(settingsCommands(docs).length);
  });

  test("treeCensusAt: the same targets and spellings, every command and detail withheld", () => {
    const got = treeCensusAt(repo, home, REGISTRY, OWNED);
    expect(JSON.stringify(got)).not.toMatch(PLANTED);
    const want = registeredTreeCensus(OWNED, readRegistrationScopes(repo, home, raw, REGISTRY), readEnvScopes(repo, home, raw), repo);
    // The census keeps each command on its readings; the copy here does not.
    expect(JSON.stringify(want)).toMatch(PLANTED);
    expect([...got.inRepo, ...got.foreign, ...got.unresolved].every(r => r.command === COMMAND_WITHHELD)).toBe(true);
    const shape = (rs: typeof want.foreign) => rs.map(r => [r.hook, r.scope, r.spelling, r.target, r.resolved]);
    expect(shape(got.inRepo)).toEqual(shape(want.inRepo));
    expect(shape(got.foreign)).toEqual(shape(want.foreign));
    expect(shape(got.unresolved)).toEqual(shape(want.unresolved));
    expect([got.reading, got.examined, got.unmeasuredReasons.length]).toEqual([want.reading, want.examined, want.unmeasuredReasons.length]);
    expect(got.unresolved.map(r => r.hook)).toContain("Zeta");
  });

  test("registrationCensusAt and hookRegistrationAt: the census's verdicts exactly", () => {
    const want = registrationCensus(OWNED, readRegistrationScopes(repo, home, raw, REGISTRY));
    const got = registrationCensusAt(repo, home, REGISTRY, OWNED);
    expect(got).toEqual(want);
    expect(JSON.stringify(got)).not.toMatch(PLANTED);
    expect(hookRegistrationAt(repo, home, REGISTRY, "Beta")).toEqual(want.find(r => r.hook === "Beta")!);
  });

  test("scopeReadability, commandsExecutingAt and unplacedHooksAt: scopes, counts and names only", () => {
    const readable = scopeReadability(repo, home, REGISTRY);
    expect(JSON.stringify(readable)).not.toMatch(PLANTED);
    expect(readable.every(r => r.readable)).toBe(true);
    // A home with no settings: its scopes are named unreadable, with a reason and no text.
    const nowhere = join(root, "no-home");
    const absent = scopeReadability(repo, nowhere, REGISTRY).filter(r => !r.readable);
    expect(absent.map(r => r.scope)).toEqual(["user-settings", "user-local-settings"]);
    expect(absent.every(r => (r.unreadable ?? "").includes("not on this machine"))).toBe(true);
    expect(commandsExecutingAt(repo, home, REGISTRY, "user-settings", "Beta")).toBe(1);
    expect(commandsExecutingAt(repo, nowhere, REGISTRY, "user-settings", "Beta")).toBeNull();
    const placed = unplacedHooksAt(repo, home, REGISTRY, OWNED, ["Delta"]);
    expect(JSON.stringify(placed)).not.toMatch(PLANTED);
    // Only the repo-owned scopes place a hook: Alpha in the committed file, Reg in the registry.
    expect(placed.unplaced.sort()).toEqual(["Beta", "Eps", "Gamma", "Zeta"]);
  });

  test("registrationCurrencyAt: computed over the withheld census, so no reason quotes a token", () => {
    const currency = registrationCurrencyAt({
      repoRoot: repo,
      home,
      base: "origin/main",
      ownedHooks: OWNED,
      registryCommands: REGISTRY,
      git: () => ({ ok: false, stdout: "", stderr: "no git in this planted tree", status: 128 }) as never,
    });
    expect(JSON.stringify(currency)).not.toMatch(PLANTED);
    expect(currency.examined).toBeGreaterThan(0);
  });
});

// #2810 review, round 1.
describe("#2810: no error message leaves the helper, and the count is the census's predicate", () => {
  // A user settings file that is not JSON, with a token where the parse fails.
  const bad = () => {
    const h = join(root, "bad-home");
    mkdirSync(join(h, ".claude"), { recursive: true });
    writeFileSync(join(h, ".claude", "settings.json"), '{"env": {"GH_TOKEN": gho_planted2792}, "hooks": {}}');
    return h;
  };

  test("a malformed settings document throws inside the census naming the token, and out of the helper without it", () => {
    const h = bad();
    // The census's own parse quotes the token, so the withholding is doing work.
    expect(() => readRegistrationScopes(repo, h, raw, REGISTRY)).toThrow(PLANTED);
    const calls: [string, () => unknown][] = [
      ["scopeReadability", () => scopeReadability(repo, h, REGISTRY)],
      ["hookRegistrationAt", () => hookRegistrationAt(repo, h, REGISTRY, "Alpha")],
      ["commandsExecutingAt", () => commandsExecutingAt(repo, h, REGISTRY, "user-settings", "Alpha")],
      ["registrationCensusAt", () => registrationCensusAt(repo, h, REGISTRY, OWNED)],
      ["unplacedHooksAt", () => unplacedHooksAt(repo, h, REGISTRY, OWNED, [])],
      ["wrongTreeAt", () => wrongTreeAt(repo, h, OWNED)],
      ["treeCensusAt", () => treeCensusAt(repo, h, REGISTRY, OWNED)],
      [
        "registrationCurrencyAt",
        () =>
          registrationCurrencyAt({
            repoRoot: repo,
            home: h,
            base: "origin/main",
            ownedHooks: OWNED,
            registryCommands: REGISTRY,
            git: () => ({ ok: false, stdout: "", stderr: "no git", status: 128 }) as never,
          }),
      ],
      ["settingsMentions", () => settingsMentions(join(h, ".claude", "settings.json"), "x")],
    ];
    let threw = 0;
    for (const [name, call] of calls) {
      try {
        expect(JSON.stringify(call() ?? null), name).not.toMatch(PLANTED);
      } catch (e) {
        threw += 1;
        const message = e instanceof Error ? e.message : String(e);
        expect(message, name).not.toMatch(PLANTED);
        expect(message, name).toContain("withheld");
      }
    }
    // Every census reading parses the file, so each of them threw; only the count reads it as text.
    expect(threw).toBe(calls.length - 1);
  });

  test("commandsExecutingAt counts what executes the hook, as the registration verdict does, not what contains its name", () => {
    const h = join(root, "count-home");
    mkdirSync(join(h, ".claude"), { recursive: true });
    writeFileSync(
      join(h, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                { type: "command", command: "bun /x/MyBeta.hook.ts" },
                { type: "command", command: "bun /x/Beta.hook.ts" },
              ],
            },
          ],
        },
      }),
    );
    expect(commandsExecutingAt(repo, h, REGISTRY, "user-settings", "Beta")).toBe(1);
    expect(hookRegistrationAt(repo, h, REGISTRY, "Beta").registeredIn).toContain("user-settings");
  });
});

describe("#2786: AC-11's count", () => {
  test("countMentions counts values and keys naming the needle, and a non-JSON file by its text", () => {
    expect(countMentions(JSON.stringify({ env: { A: "bun X.hook.ts" }, hooks: { "X.hook.ts": [] } }), "X.hook.ts")).toBe(2);
    expect(countMentions('{ "env": { "A": "X.hook.ts"', "X.hook.ts")).toBe(1);
    expect(countMentions(JSON.stringify({ env: { A: "nothing" } }), "X.hook.ts")).toBe(0);
  });

  test("settingsMentions is null for an absent file, and throws for one it cannot read", () => {
    expect(settingsMentions(join(root, "nope.json"), "x")).toBeNull();
    expect(() => settingsMentions(root, "x")).toThrow();
  });
});

describe("#2792: homePath names a path under home, never home itself or a settings file", () => {
  test("every spelling of a settings path is refused", () => {
    expect(() => homePath()).toThrow();
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

  // #2810 review: judged on the path, not on its spelling.
  test("#2810: a case variant, a trailing slash, a path out of home and back, and a symlink are refused", () => {
    const h = join(root, "link-home");
    mkdirSync(join(h, ".claude"), { recursive: true });
    mkdirSync(join(h, ".pai"), { recursive: true });
    writeFileSync(join(h, ".claude", "settings.json"), "{}");
    symlinkSync(join(h, ".claude"), join(h, ".pai", "to-claude"));
    symlinkSync(join(h, ".claude", "settings.json"), join(h, ".pai", "s.json"));
    const refused = [
      [".Claude", "settings.json"],
      [".CLAUDE", "Settings.JSON"],
      // Absent, so no symlink or volume lookup folds it: the comparison itself must.
      [".Claude", "Settings.Local.JSON"],
      [".claude/settings.json/"],
      ["..", "link-home", ".claude", "settings.json"],
      [".pai", "to-claude", "settings.json"],
      [".pai", "s.json"],
    ];
    for (const segments of refused) expect(() => homePathAt(h, ...segments), segments.join(" | ")).toThrow();
    expect(() => homePathAt(h, "..", "elsewhere")).toThrow("outside");
    expect(homePathAt(h, ".pai", "hooks")).toBe(join(h, ".pai", "hooks"));
  });
});
