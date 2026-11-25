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
import ts from "typescript";
import { REGISTRATION_SCOPES, readRegistrationScopes, registrationCensus, settingsScopePaths } from "../lib/hook-scopes";
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
  scopePathsAt,
  scopeReadability,
  settingsMentions,
  treeCensusAt,
  unplacedHooksAt,
  wrongTreeAt,
} from "./helpers/user-settings";

const PLANTED = /planted2792/;
/**
 * Whether planted text is in a value, as a boolean: an assertion on it prints
 * true or false when it fails, never the value it found (#2819 review, round 2).
 */
const crossed = (value: unknown): boolean => PLANTED.test(typeof value === "string" ? value : JSON.stringify(value ?? null));
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
              // Unresolved: no scope defines its directory. The census keeps the command, token and
              // all, on the reading; its detail and reason quote only the path, ${UNDEFINED_DIR}/Zeta.hook.ts.
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
    expect(crossed(got), "planted text in wrongTreeAt's result").toBe(false);
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
    expect(crossed(got), "planted text in treeCensusAt's result").toBe(false);
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
    expect(crossed(got), "planted text in registrationCensusAt's result").toBe(false);
    expect(got).toEqual(want);
    expect(hookRegistrationAt(repo, home, REGISTRY, "Beta")).toEqual(want.find(r => r.hook === "Beta")!);
  });

  test("scopeReadability, commandsExecutingAt and unplacedHooksAt: scopes, counts and names only", () => {
    const readable = scopeReadability(repo, home, REGISTRY);
    expect(crossed(readable), "planted text in scopeReadability's result").toBe(false);
    expect(readable.every(r => r.readable)).toBe(true);
    // A home with no settings: its scopes are named unreadable, with a reason and no text.
    const nowhere = join(root, "no-home");
    const absent = scopeReadability(repo, nowhere, REGISTRY).filter(r => !r.readable);
    expect(absent.map(r => r.scope)).toEqual(["user-settings", "user-local-settings"]);
    expect(absent.every(r => (r.unreadable ?? "").includes("not on this machine"))).toBe(true);
    expect(commandsExecutingAt(repo, home, REGISTRY, "user-settings", "Beta")).toBe(1);
    expect(commandsExecutingAt(repo, nowhere, REGISTRY, "user-settings", "Beta")).toBeNull();
    const placed = unplacedHooksAt(repo, home, REGISTRY, OWNED, ["Delta"]);
    expect(crossed(placed), "planted text in unplacedHooksAt's result").toBe(false);
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
    expect(crossed(currency), "planted text in registrationCurrencyAt's result").toBe(false);
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
      // The call alone is tried, so a failed assertion is never read as the helper's own error.
      let result: unknown = null;
      let message: string | null = null;
      try {
        result = call();
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      if (message === null) {
        expect(crossed(result), `planted text in ${name}'s result`).toBe(false);
        continue;
      }
      threw += 1;
      expect(crossed(message), `planted text in ${name}'s error`).toBe(false);
      expect(message.includes("withheld"), `${name}'s error says the text was withheld`).toBe(true);
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

// #2813: what crosses the boundary is listed, field by field, and checked.
describe("#2813: every field of every verdict is on the helper's allow-list", () => {
  /** Every string a planted settings document holds, as values and keys, whole and in space-separated pieces. */
  const plantedPieces = (): string[] => {
    const out: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") out.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); walk(x); }
    };
    for (const { path } of settingsScopePaths(repo, home)) {
      const doc = raw(path);
      if (doc !== null) walk(JSON.parse(doc));
    }
    // Each string whole, and each space-separated piece of it, so a reason
    // that quotes part of a command is caught too. An absolute path is the
    // stated exception: a resolved path, or the directory a registration
    // reaches its hook through, crosses by design. The JSON vocabulary of the
    // files is no value.
    return [...new Set(out.flatMap(t => [t, ...t.split(/\s+/)]))];
  };
  /** What free text may not hold: each planted piece past the floor below. */
  const plantedText = (): string[] =>
    plantedPieces().filter(t => t.length >= 6 && !t.startsWith("/") && !["PreToolUse", "command", "matcher"].includes(t));
  /**
   * Short text in the planted documents that is no secret: the settings
   * format's keys, the matcher, the names the fixture gives its env entries,
   * and the words of its commands. A substring check on any of them would
   * fire on every census reading. A planted piece the floor skips must be one
   * of these, carry the PLANTED marker (every result is checked for it at any
   * length, above), or be a path to a planted hook.
   */
  const NOT_SECRET = new Set<string>([
    "hooks", "PreToolUse", "matcher", "type", "command", "env", // the format
    "Bash", // the matcher
    "X_DIR", "OTHER", // env names; their values carry the marker or are the hook directory
    "bun", "echo", "sh", "-c", '"bun', "b", // command words, and a piece of the quoted "a b gho_…" value
  ]);
  const unaccountedPieces = (pieces: string[]): string[] =>
    pieces.filter(
      t =>
        !plantedText().includes(t) &&
        !PLANTED.test(t) &&
        !NOT_SECRET.has(t) &&
        !(t.startsWith("/") && (t.endsWith(".hook.ts") || t === hookDir)),
    );
  const SCOPES = new Set<string>(REGISTRATION_SCOPES);
  const noPlanted = (v: string) => plantedText().every(t => !v.includes(t));
  // The stated exception: where a registration resolves to is what the census
  // and the currency reading are about, so it crosses as an absolute path.
  // A resolved path or directory is under a directory the fixture planted: an absolute path
  // anywhere else, such as one built from an unmarked token in an env value, is refused
  // (#2819 review, round 2).
  const absolutePath = (v: string) => [repo, home, hookDir, "/srv/x"].some(r => v === r || v.startsWith(`${r}/`));

  /**
   * Each field a result may carry, and what its value may be. A field not
   * listed fails, so a census field that starts crossing has to be named here
   * first. Free text (a detail, a reason) may hold no planted string; a
   * resolved path or directory is the one stated exception.
   */
  const FIELDS: Record<string, (v: unknown) => boolean> = {
    hook: v => typeof v === "string" && OWNED.includes(v),
    scope: v => typeof v === "string" && SCOPES.has(v),
    registeredIn: v => typeof v === "string" && SCOPES.has(v),
    read: v => typeof v === "string" && SCOPES.has(v),
    missing: v => typeof v === "string" && SCOPES.has(v),
    unplaced: v => typeof v === "string" && OWNED.includes(v),
    repoScopes: () => true,
    readable: v => typeof v === "boolean",
    unreadable: v => typeof v === "string" && (SCOPES.has(v) || noPlanted(v)),
    verdict: v => v === "registered" || v === "unregistered" || v === "unmeasured",
    tree: v => v === "rungate" || v === "pai" || v === "unknown" || v === "unparsed",
    target: v => v === "in-repo" || v === "foreign" || v === "unresolved",
    spelling: v => typeof v === "string" && /^(?:literal|[A-Za-z_][A-Za-z0-9_]*)$/.test(v),
    command: v => v === COMMAND_WITHHELD,
    resolved: v => v === null || (typeof v === "string" && absolutePath(v)),
    dir: v => typeof v === "string" && absolutePath(v),
    path: v => typeof v === "string" && absolutePath(v),
    ownership: v => v === "repo" || v === "machine",
    reading: v => v === "MEASURED" || v === "UNMEASURED",
    state: v => v === "current" || v === "behind" || v === "unmeasured",
    base: v => v === "origin/main",
    baseSha: v => v === null || (typeof v === "string" && /^[0-9a-f]+$/.test(v)),
    headSha: v => v === null || (typeof v === "string" && /^[0-9a-f]+$/.test(v)),
    detail: v => typeof v === "string" && noPlanted(v),
    unmeasuredReasons: v => typeof v === "string" && noPlanted(v),
    commands: v => typeof v === "number",
    examined: v => typeof v === "number",
    unresolved: v => typeof v === "number" || (typeof v === "object" && v !== null),
    registrations: v => typeof v === "number",
    behind: v => v === null || typeof v === "number",
    violations: () => true,
    inRepo: () => true,
    foreign: () => true,
    directories: () => true,
  };

  /** Every field outside the allow-list, or holding a value it does not allow, as `path: value`. */
  const offList = (value: unknown, at = "result"): string[] => {
    if (Array.isArray(value)) return value.flatMap((v, i) => offList(v, `${at}[${i}]`));
    if (value === null || typeof value !== "object") return [];
    return Object.entries(value).flatMap(([k, v]) => {
      const check = FIELDS[k];
      if (check === undefined) return [`${at}.${k}: not on the allow-list`];
      const leaves = Array.isArray(v) ? v : [v];
      const bad = leaves.filter(x => (x === null || typeof x !== "object") && !check(x));
      // A refused string is withheld by length: it may be the planted text the check exists to keep in.
      const shown = (x: unknown) => (typeof x === "string" ? `a string of ${x.length} characters, withheld` : JSON.stringify(x));
      return [...bad.map(x => `${at}.${k}: ${shown(x)}`), ...offList(v, `${at}.${k}`)];
    });
  };

  test("the planted documents hold the text the check looks for", () => {
    // Without this, every noPlanted check below holds because nothing was planted.
    expect(plantedText().filter(t => PLANTED.test(t)).length).toBeGreaterThanOrEqual(5);
  });

  test("every planted piece the free-text check skips is marked, a word of the format, or a hook path (#2819 review)", () => {
    // The floor exists because a substring check on "bun" or "Bash" fires on
    // the census's own words. A short or path-shaped secret is caught by the
    // marker instead, so a planted value without it goes red here rather
    // than slipping past both checks.
    expect(unaccountedPieces(plantedPieces())).toEqual([]);
    expect(unaccountedPieces(["gho_x", "a1b2c", "/abc123secret"])).toEqual(["gho_x", "a1b2c", "/abc123secret"]);
    // A path-shaped value carrying the marker is accounted for: the whole-result checks see it.
    expect(unaccountedPieces(["/gho_planted2792"])).toEqual([]);
  });

  test("each function's result carries only listed fields, each holding a value its field allows", () => {
    const results: [string, unknown][] = [
      ["scopeReadability", scopeReadability(repo, home, REGISTRY)],
      ["scopePathsAt", scopePathsAt(repo, home)],
      ["hookRegistrationAt", hookRegistrationAt(repo, home, REGISTRY, "Alpha")],
      ["registrationCensusAt", registrationCensusAt(repo, home, REGISTRY, OWNED)],
      ["unplacedHooksAt", unplacedHooksAt(repo, home, REGISTRY, OWNED, ["Delta"])],
      ["wrongTreeAt", wrongTreeAt(repo, home, OWNED)],
      ["treeCensusAt", treeCensusAt(repo, home, REGISTRY, OWNED)],
      [
        "registrationCurrencyAt",
        registrationCurrencyAt({
          repoRoot: repo,
          home,
          base: "origin/main",
          ownedHooks: OWNED,
          registryCommands: REGISTRY,
          git: () => ({ ok: false, stdout: "", stderr: "no git in this planted tree", status: 128 }) as never,
        }),
      ],
    ];
    for (const [name, result] of results) expect(offList(result), name).toEqual([]);
  });

  test("the check refuses a field it does not list, and a listed field holding planted text", () => {
    expect(offList({ hook: "Alpha", raw: "anything" })).toEqual(["result.raw: not on the allow-list"]);
    expect(offList({ detail: "bun /srv/x/Beta.hook.ts" })).toEqual([]);
    const leaked = plantedText().find(t => PLANTED.test(t))!;
    const report = offList([{ detail: `it ran ${leaked}` }]);
    expect(report).toEqual([`result[0].detail: a string of ${`it ran ${leaked}`.length} characters, withheld`]);
    expect(crossed(report)).toBe(false);
    // A path outside every planted directory is refused, such as one built from a token in an env value.
    expect(offList({ resolved: "/home/u/gho_AbC123xyz/Alpha.hook.ts" })).toEqual(["result.resolved: a string of 35 characters, withheld"]);
    expect(offList({ resolved: join(hookDir, "Alpha.hook.ts") })).toEqual([]);
  });

  test("no result in the helper is built by spreading another object", () => {
    // A spread copies whatever fields the census adds later, past every check
    // above until somebody lists them. Built field by field, a new census field
    // reaches no result until the helper names it.
    const path = join(import.meta.dir, "helpers", "user-settings.ts");
    const file = ts.createSourceFile(path, readFileSync(path, "utf-8"), ts.ScriptTarget.Latest, true);
    const spreads: number[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isSpreadAssignment(node)) spreads.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(spreads, "object spreads in test/helpers/user-settings.ts, by line").toEqual([]);
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
  // Symlinks are #2806's (#2810 review, round 4).
  test("#2810: a case variant, a trailing slash, and a path out of home and back are refused", () => {
    const h = join(root, "link-home");
    mkdirSync(join(h, ".claude"), { recursive: true });
    mkdirSync(join(h, ".pai"), { recursive: true });
    writeFileSync(join(h, ".claude", "settings.json"), "{}");
    const refused = [
      [".Claude", "settings.json"],
      [".CLAUDE", "Settings.JSON"],
      // Absent, so no symlink or volume lookup folds it: the comparison itself must.
      [".Claude", "Settings.Local.JSON"],
      [".claude/settings.json/"],
      ["..", "link-home", ".claude", "settings.json"],
    ];
    for (const segments of refused) expect(() => homePathAt(h, ...segments), segments.join(" | ")).toThrow();
    expect(() => homePathAt(h, "..", "elsewhere")).toThrow("outside");
    expect(homePathAt(h, ".pai", "hooks")).toBe(join(h, ".pai", "hooks"));
    // A home whose .pai is itself a link, as a dotfiles checkout makes it, still names its hooks.
    mkdirSync(join(h, "dotfiles", "pai"), { recursive: true });
    symlinkSync(join(h, "dotfiles", "pai"), join(h, ".pai-linked"));
    expect(homePathAt(h, ".pai-linked", "hooks")).toBe(join(h, ".pai-linked", "hooks"));
  });
});
