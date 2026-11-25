/**
 * The one reader, in `test/`, of the machine's settings files (#2792).
 *
 * `~/.claude/settings.json` holds the machine's tokens in `env`. A test that
 * reads it and fails can print what it read: AC-11 printed the whole file
 * until #2787, and three review rounds found three more ways file text reached
 * the output. Making each assertion careful about what it prints fixed one
 * site per round. This makes it structural: a machine-owned scope is reduced,
 * on read, to what the census suites use — the hook files the commands execute,
 * and the `env` keys some scope's hook path references — and nothing else ever
 * reaches a test. AC-11, which asks a wider question than the census, gets a
 * count taken over the raw file instead, never the file.
 *
 * `test/user-settings-helper.test.ts` refuses any other reader in `test/`.
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join, posix } from "path";
import ts from "typescript";
import { readRegistrationScopes, settingsScopePaths, type ScopeReading } from "../../lib/hook-scopes";
import { readEnvScopes, type EnvReading } from "../../lib/hook-target-tree";
import { readRegistrationCurrency, type RegistrationCurrency } from "../../lib/hook-tree-currency";
import { executedHookPath, settingsCommands } from "../../lib/hook-trees";

/** A variable a path reads: `${NAME}` or `$NAME`. */
const VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** What a command stands for once reduced, when it executes no hook file. */
export const NO_HOOK_FILE = "<a command that executes no hook file>";

/**
 * A command reduced to the one thing the census reads from it: the hook file
 * it executes, through `executedHookPath`, the census's own parse. Everything
 * else (assignments, flags, arguments, quoting) is dropped, not redacted, so no
 * spelling of a value can survive it.
 */
export function reduceCommand(command: string): string {
  const path = executedHookPath(command);
  return path === null ? NO_HOOK_FILE : `bun ${path}`;
}

/** The one key the reduced `hooks` block carries. No event name, matcher or key of the original survives. */
export const REDUCED_EVENT = "reduced";

/**
 * Every command the census finds under `hooks`, found by the census's own walk
 * (`settingsCommands`, which takes a `command` at any depth), each reduced,
 * in the same order. Nothing the census does not read is kept: no event name,
 * no matcher, no key. So the census reads the same hook files from the copy
 * as from the original, whatever shape the original nests them in.
 */
function reduceHooks(doc: string): Record<string, unknown> {
  const hooks = settingsCommands([doc]).map(command => ({ type: "command", command: reduceCommand(command) }));
  return { [REDUCED_EVENT]: [{ hooks }] };
}

/** Each variable a reduced command's hook path reads. */
function pathVariables(commands: string[]): string[] {
  return commands.flatMap(c => [...c.matchAll(VAR_REF)].map(m => (m[1] ?? m[2])!));
}

const NOT_JSON = "a machine settings file is not JSON, so it was not read; nothing of it is printed here";

/**
 * A settings document rebuilt from an allowlist, never redacted in place:
 * `hooks` with each command reduced to the hook file it executes, and the
 * `env` keys named in `referenced`. Throws, quoting nothing, when the
 * document is not JSON.
 *
 * `referenced` is every variable a hook path reads in ANY scope, not only this
 * document's (#2798 review). The census merges `env` across scopes before it
 * resolves a path, so a variable one file defines and another file's hook
 * reads must keep its value, and a variable two files define must keep both,
 * or a refusal ("defined 2 times") turns into a clean reading.
 *
 * The limit, stated: a variable a hook path does read is kept, value and all,
 * because resolving the path needs it.
 */
export function redactSettings(src: string, referenced: ReadonlySet<string>): string {
  let doc: { env?: unknown };
  try {
    doc = JSON.parse(src);
  } catch {
    throw new Error(NOT_JSON);
  }
  const hooks = reduceHooks(src);
  const env: Record<string, unknown> = {};
  const given = doc?.env;
  if (given !== null && typeof given === "object" && !Array.isArray(given)) {
    for (const [k, v] of Object.entries(given as Record<string, unknown>)) if (referenced.has(k)) env[k] = v;
  }
  return JSON.stringify({ hooks, env }, null, 2);
}

/**
 * Every variable a hook path reads, across every scope document given. A
 * document that is absent, unreadable or not JSON adds nothing here; reading
 * it through {@link settingsReader} is what refuses it.
 */
export function referencedVariables(paths: string[]): Set<string> {
  const out = new Set<string>();
  for (const path of paths) {
    let commands: string[];
    try {
      commands = settingsCommands([readFileSync(path, "utf-8")]).map(reduceCommand);
    } catch {
      continue; // its own read through settingsReader throws or reads null
    }
    for (const v of pathVariables(commands)) out.add(v);
  }
  return out;
}

/**
 * A `readFile` for `readRegistrationScopes` and `readEnvScopes`, and for any
 * direct read of a settings scope. The committed project scope is returned
 * verbatim, because it is in git. Every other path, machine-owned or the
 * gitignored project-local one, is returned through {@link redactSettings},
 * keeping every variable any of the four scopes' hook paths reads.
 * An absent file is `null`; any other read error is thrown, never read as
 * absence.
 */
export function settingsReader(repoRoot: string, home: string): (path: string) => string | null {
  const scopes = settingsScopePaths(repoRoot, home);
  const committed = scopes.find(s => s.scope === "project-settings")!.path;
  const referenced = referencedVariables(scopes.map(s => s.path));
  return path => {
    let src: string;
    try {
      src = readFileSync(path, "utf-8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    return path === committed ? src : redactSettings(src, referenced);
  };
}

/** This machine's settings scopes, read through {@link settingsReader}. */
export function liveSettingsReader(repoRoot: string): (path: string) => string | null {
  return settingsReader(repoRoot, homedir());
}

/** `readRegistrationScopes` over this machine, every machine-owned scope redacted on read. */
export function liveRegistrationScopes(repoRoot: string, registryCommands: string[]): ScopeReading[] {
  return readRegistrationScopes(repoRoot, homedir(), liveSettingsReader(repoRoot), registryCommands);
}

/** `readEnvScopes` over this machine, every machine-owned scope redacted on read. */
export function liveEnvScopes(repoRoot: string): EnvReading[] {
  return readEnvScopes(repoRoot, homedir(), liveSettingsReader(repoRoot));
}

/** `readRegistrationCurrency` over this machine, every machine-owned scope redacted on read. */
export function liveRegistrationCurrency(
  input: Omit<Parameters<typeof readRegistrationCurrency>[0], "home" | "readFile">,
): RegistrationCurrency {
  return readRegistrationCurrency({ ...input, home: homedir(), readFile: liveSettingsReader(input.repoRoot) });
}

/** Where this machine's settings scopes live. Paths only; nothing is read. */
export function liveScopePaths(repoRoot: string): ReturnType<typeof settingsScopePaths> {
  return settingsScopePaths(repoRoot, homedir());
}

/** The user-scope settings file on this machine, for naming in a message. */
export function liveUserSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

/**
 * How many string values and keys in a settings document contain `needle`.
 * A count, and nothing else: each earlier AC-11 printed something read from
 * the file (the whole file, then a value, then a key), and the file holds the
 * machine's tokens. A number cannot carry one (#2786, #2787 review). Read as
 * JSON, so an escaped quote is part of its value; a document that is not JSON
 * counts 1 when its text contains `needle` anywhere.
 *
 * Taken over the RAW document, because the question it serves is wider than
 * the census's: a registration the census cannot parse, a command nested in a
 * shape nobody expected, or an `env` value naming the hook all count (#2798
 * review). The reduced copy would hide each of them.
 */
export function countMentions(src: string, needle: string): number {
  let doc: unknown;
  try {
    doc = JSON.parse(src);
  } catch {
    return src.includes(needle) ? 1 : 0;
  }
  let n = 0;
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      if (v.includes(needle)) n++;
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k.includes(needle)) n++;
        walk(x);
      }
    }
  };
  walk(doc);
  return n;
}

/** {@link countMentions} over the file at `path`, or null when it is absent. Any other read error is thrown. */
export function settingsMentions(path: string, needle: string): number | null {
  let src: string;
  try {
    src = readFileSync(path, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  return countMentions(src, needle);
}

/** {@link settingsMentions} over this machine's user-scope settings file. */
export function liveUserSettingsMentions(needle: string): number | null {
  return settingsMentions(liveUserSettingsPath(), needle);
}

/**
 * A path under the home directory that is not a settings file, such as
 * `~/.pai/hooks`. The segments are joined and normalised before they are
 * judged, so `".claude/settings.json"`, `".claude/", "settings.json"` and
 * `".claude", "x", "..", "settings.json"` are all refused (#2798 review).
 */
export function homePath(...segments: string[]): string {
  if (segments.length === 0) throw new Error("homePath names a path under the home directory, never the directory itself");
  if (SETTINGS_PATH.test(normalisedTail(segments.join("/")))) {
    throw new Error("a settings file under ~/.claude is read through the settings readers above");
  }
  return join(homedir(), ...segments);
}

/** A path relative to home, normalised: no `.`, `..` or doubled `/`, and no leading `/`. */
function normalisedTail(text: string): string {
  return posix.normalize(`/${text}`).replace(/^\/+/, "");
}

/** A settings scope under home, as a normalised tail. */
const SETTINGS_PATH = /^\.claude\/settings(\.local)?\.json$/;

/** A settings file's name, as the tail of a path a source builds. */
const SETTINGS_FILE = /(^|\/)settings(\.local)?\.json$/;

/** A path's text past home, and whether any part of it could not be read. */
interface Tail {
  text: string;
  unknown: boolean;
}

/** Calls that build a path rather than read one. */
const PATH_BUILDERS = new Set(["join", "resolve"]);

/**
 * The lines of a TypeScript source, outside this helper, that can reach a
 * machine settings scope without it. Parsed with the TypeScript compiler, so a
 * call split across lines is one call, and `path.join` is `join`.
 *
 * Two readings, kept apart because they need different evidence (#2798 review,
 * which found the earlier call-name list missed `path.join`, a one-literal
 * path, `resolve`, and a reader taking home in an options object):
 *
 * - **Home handed to a call.** Any call given the home directory itself, as an
 *   argument or as a property of an object-literal argument, except a path
 *   builder and an assertion matcher. A function that takes home is one that
 *   reads under it; which ones read settings is not a list this can keep
 *   current, so it refuses them all and the helper offers live wrappers.
 * - **A home path that is, or may be, a settings file.** A `join` or
 *   `resolve`, `homePath`, a template literal, or a `+` concatenation, rooted
 *   at home or at a variable built from home. Its text is resolved through
 *   string literals and `const` bindings to them, and normalised. It is
 *   refused when it ends in `settings.json` or `settings.local.json`, and when
 *   it passes through `.claude` with any part the resolver cannot read: a
 *   name held in a parameter could be the settings file (#2798 review, round
 *   2, which found a name held in a variable read as nothing).
 *
 * "Home" is `homedir()`, `os.homedir()`, `process.env.HOME`, `homePath(...)`,
 * or a variable initialised from one of them. A call over planted directories
 * reaches neither reading.
 */
export function homeSettingsReads(source: string): number[] {
  const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  /** Variables holding the home directory itself. */
  const homeVars = new Set<string>();
  /** Variables holding a path under it, and that path's text past home as far as it could be read. */
  const rootedVars = new Map<string, Tail>();
  /** Variables bound to a string this can read. */
  const textVars = new Map<string, string>();
  const unwrap = (n: ts.Node): ts.Node => {
    let e = n;
    while (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) e = e.expression;
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      return unwrap(e.left);
    }
    return e;
  };
  const calleeName = (c: ts.CallExpression): string | null => {
    const e = c.expression;
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e)) return e.name.text;
    return null;
  };
  const literal = (n: ts.Node): string | null => (ts.isStringLiteralLike(n) ? n.text : null);
  const isEnv = (n: ts.Node): boolean => ["process.env", "Bun.env"].includes(n.getText(file));
  /** Names `homedir` is imported under: `import { homedir as h } from "os"`. */
  const homedirNames = new Set(["homedir"]);
  for (const st of file.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause?.namedBindings || !ts.isNamedImports(st.importClause.namedBindings)) continue;
    for (const el of st.importClause.namedBindings.elements) if ((el.propertyName ?? el.name).text === "homedir") homedirNames.add(el.name.text);
  }
  /** The home directory itself. */
  const isHome = (raw: ts.Node): boolean => {
    const n = unwrap(raw);
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name !== null && homedirNames.has(name)) return true;
      // join(homedir()) is still home.
      return name !== null && PATH_BUILDERS.has(name) && n.arguments.length > 0 && n.arguments.every(isHome);
    }
    // `process.env.HOME`, `Bun.env.HOME`, and `os.userInfo().homedir`.
    if (ts.isPropertyAccessExpression(n)) return (n.name.text === "HOME" && isEnv(n.expression)) || n.name.text === "homedir";
    if (ts.isElementAccessExpression(n)) return isEnv(n.expression) && literal(n.argumentExpression) === "HOME";
    return ts.isIdentifier(n) && homeVars.has(n.text);
  };
  /** A string this can read: a literal, a template with no holes, a `+` of readable parts, or a variable bound to one. */
  const textOf = (raw: ts.Node): string | null => {
    const n = unwrap(raw);
    if (ts.isStringLiteralLike(n)) return n.text;
    if (ts.isIdentifier(n)) return textVars.get(n.text) ?? null;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = textOf(n.left);
      const r = textOf(n.right);
      return l === null || r === null ? null : l + r;
    }
    return null;
  };
  /** Text appended to a tail; an unreadable part marks it unknown. */
  const extend = (t: Tail, part: string | null, sep: string): Tail =>
    part === null ? { text: t.text, unknown: true } : { text: t.text + sep + part, unknown: t.unknown };
  /** A path rooted at home, as its text past home, or null when it is not rooted there. */
  const rootedTail = (raw: ts.Node): Tail | null => {
    const n = unwrap(raw);
    if (isHome(n)) return { text: "", unknown: false };
    if (ts.isIdentifier(n)) return rootedVars.get(n.text) ?? null;
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      const args = [...n.arguments];
      if (name === "homePath") return args.reduce<Tail>((t, a) => extend(t, textOf(a), "/"), { text: "", unknown: false });
      if (name === null || !PATH_BUILDERS.has(name) || args.length === 0) return null;
      const base = rootedTail(args[0]!);
      return base === null ? null : args.slice(1).reduce<Tail>((t, a) => extend(t, textOf(a), "/"), base);
    }
    if (ts.isTemplateExpression(n)) {
      if (n.head.text !== "" || n.templateSpans.length === 0) return null;
      const base = rootedTail(n.templateSpans[0]!.expression);
      if (base === null) return null;
      return n.templateSpans.reduce<Tail>(
        (t, sp, i) => extend(i === 0 ? t : extend(t, textOf(sp.expression), ""), sp.literal.text, ""),
        base,
      );
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const base = rootedTail(n.left);
      return base === null ? null : extend(base, textOf(n.right), "");
    }
    return null;
  };
  /** Whether a rooted path is, or may be, a settings scope. */
  const maySettings = (t: Tail): boolean => {
    const tail = normalisedTail(t.text);
    return SETTINGS_FILE.test(tail) || (t.unknown && /(^|\/)\.claude(\/|$)/.test(tail));
  };
  // To a fixed point, so a variable built from a variable built from home is
  // rooted too. Bindings only ever gain information, so it ends: a name
  // declared twice with two readings becomes unreadable once and stays so,
  // rather than alternating between them (a scan of test/ never ended before
  // this).
  const conflicted = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    const collect = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const name = n.name.text;
        if (!homeVars.has(name) && isHome(n.initializer)) { homeVars.add(name); grew = true; }
        const text = textOf(n.initializer);
        const hadText = textVars.get(name);
        if (text !== null && hadText === undefined && !conflicted.has(`t:${name}`)) { textVars.set(name, text); grew = true; }
        else if (hadText !== undefined && text !== hadText) { textVars.delete(name); conflicted.add(`t:${name}`); grew = true; }
        const tail = rootedTail(n.initializer);
        const had = rootedVars.get(name);
        if (tail !== null && had === undefined) { rootedVars.set(name, tail); grew = true; }
        else if (tail !== null && had !== undefined && !conflicted.has(`r:${name}`) && (had.text !== tail.text || had.unknown !== tail.unknown)) {
          // Two readings of one name: keep the one that reaches furthest, and mark it unknown.
          rootedVars.set(name, { text: had.text.length >= tail.text.length ? had.text : tail.text, unknown: true });
          conflicted.add(`r:${name}`);
          grew = true;
        }
      }
      // `const { HOME } = process.env`, under any local name.
      if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer && isEnv(unwrap(n.initializer))) {
        for (const el of n.name.elements) {
          const key = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : null;
          if (key === "HOME" && ts.isIdentifier(el.name) && !homeVars.has(el.name.text)) {
            homeVars.add(el.name.text);
            grew = true;
          }
        }
      }
      ts.forEachChild(n, collect);
    };
    collect(file);
  }
  /** Whether a call is an assertion matcher on an `expect(...)` chain. */
  const isMatcher = (c: ts.CallExpression): boolean => {
    let e: ts.Node = c.expression;
    while (ts.isPropertyAccessExpression(e) || ts.isCallExpression(e)) {
      if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "expect") return true;
      e = ts.isPropertyAccessExpression(e) ? e.expression : e.expression;
    }
    return false;
  };
  const lines = new Set<number>();
  const flag = (n: ts.Node) => lines.add(file.getLineAndCharacterOfPosition(n.getStart()).line + 1);
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      const args = [...n.arguments];
      if (name !== null && (PATH_BUILDERS.has(name) || name === "homePath")) {
        const tail = rootedTail(n);
        if (tail !== null && maySettings(tail)) flag(n);
      } else if (!isMatcher(n)) {
        const handsHome = args.some(
          a =>
            isHome(a) ||
            (ts.isObjectLiteralExpression(a) &&
              a.properties.some(
                p =>
                  (ts.isPropertyAssignment(p) && isHome(p.initializer)) ||
                  (ts.isShorthandPropertyAssignment(p) && homeVars.has(p.name.text)),
              )),
        );
        if (handsHome) flag(n);
      }
    }
    if (ts.isTemplateExpression(n) || (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
      const tail = rootedTail(n);
      if (tail !== null && maySettings(tail)) flag(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
  return [...lines].sort((a, b) => a - b);
}
