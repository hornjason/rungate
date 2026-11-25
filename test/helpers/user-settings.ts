/**
 * The one reader, in `test/`, of the machine's settings files (#2792).
 *
 * `~/.claude/settings.json` holds the machine's tokens in `env`. A test that
 * reads it and fails can print what it read: AC-11 printed the whole file
 * until #2787, and three review rounds found three more ways file text reached
 * the output. Making each assertion careful about what it prints fixed one
 * site per round. This makes it structural: a machine-owned scope is reduced,
 * on read, to what the census suites use — the hook commands and the `env`
 * keys those commands reference — and nothing else ever reaches a test.
 *
 * `test/user-settings-helper.test.ts` refuses any other reader in `test/`.
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import ts from "typescript";
import { readRegistrationScopes, settingsScopePaths, type ScopeReading } from "../../lib/hook-scopes";
import { readEnvScopes, type EnvReading } from "../../lib/hook-target-tree";
import { executedHookPath } from "../../lib/hook-trees";

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

/** `hooks` rebuilt from an allowlist: each event's groups, their `matcher`, and each hook's `type` and reduced `command`. */
function reduceHooks(hooks: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) return out;
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    out[event] = groups
      .filter((g): g is Record<string, unknown> => g !== null && typeof g === "object")
      .map(g => ({
        ...(typeof g.matcher === "string" ? { matcher: g.matcher } : {}),
        hooks: (Array.isArray(g.hooks) ? g.hooks : [])
          .filter((h): h is Record<string, unknown> => h !== null && typeof h === "object" && typeof h.command === "string")
          .map(h => ({ type: typeof h.type === "string" ? h.type : "command", command: reduceCommand(h.command as string) })),
      }));
  }
  return out;
}

/**
 * A settings document rebuilt from an allowlist, never redacted in place:
 * `hooks` with each command reduced to the hook file it executes, and the
 * `env` keys those hook paths reference. Throws, quoting nothing, when the
 * document is not JSON.
 *
 * The limit, stated: a variable a hook path does read is kept, value and all,
 * because resolving the path needs it.
 */
export function redactSettings(src: string): string {
  let doc: { hooks?: unknown; env?: Record<string, unknown> };
  try {
    doc = JSON.parse(src);
  } catch {
    throw new Error("a machine settings file is not JSON, so it was not read; nothing of it is printed here");
  }
  const hooks = reduceHooks(doc.hooks);
  const paths = JSON.stringify(hooks);
  const referenced = new Set([...paths.matchAll(VAR_REF)].map(m => (m[1] ?? m[2])!));
  const env: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc.env ?? {})) if (referenced.has(k)) env[k] = v;
  return JSON.stringify({ hooks, env }, null, 2);
}

/**
 * A `readFile` for `readRegistrationScopes` and `readEnvScopes`, and for any
 * direct read of a settings scope. The committed project scope is returned
 * verbatim, because it is in git. Every other path, machine-owned or the
 * gitignored project-local one, is returned through {@link redactSettings}.
 * An absent file is `null`; any other read error is thrown, never read as
 * absence.
 */
export function settingsReader(repoRoot: string, home: string): (path: string) => string | null {
  const committed = settingsScopePaths(repoRoot, home).find(s => s.scope === "project-settings")!.path;
  return path => {
    let src: string;
    try {
      src = readFileSync(path, "utf-8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    return path === committed ? src : redactSettings(src);
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

/** Where this machine's settings scopes live. Paths only; nothing is read. */
export function liveScopePaths(repoRoot: string): ReturnType<typeof settingsScopePaths> {
  return settingsScopePaths(repoRoot, homedir());
}

/** The user-scope settings file on this machine, for naming in a message. */
export function liveUserSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

/** The user-scope settings file on this machine, redacted, or null when absent. */
export function liveUserSettings(repoRoot: string): string | null {
  return liveSettingsReader(repoRoot)(liveUserSettingsPath());
}

/** A path under the home directory that is not a settings file, such as `~/.pai/hooks`. */
export function homePath(...segments: string[]): string {
  if (segments[0] === ".claude" && /^settings(\.local)?\.json$/.test(segments[1] ?? "")) {
    throw new Error("a settings file under ~/.claude is read through the settings readers above");
  }
  return join(homedir(), ...segments);
}

const SETTINGS_READERS = new Set(["readRegistrationScopes", "readEnvScopes", "settingsScopePaths"]);

/**
 * The lines of a TypeScript source, outside this helper, that read a machine
 * settings scope directly: a call to `readRegistrationScopes`, `readEnvScopes`
 * or `settingsScopePaths` given the home directory, or a `join` from the home
 * directory to `.claude/settings.json` or `.claude/settings.local.json`. "The home directory" is
 * `homedir()`, `os.homedir()`, `process.env.HOME`, or a variable initialised
 * from one of them, so holding it in a `const` first does not hide the read.
 * Parsed with the TypeScript compiler, so a call split across lines is one
 * call. A call over planted directories is not a read of this machine.
 */
export function homeSettingsReads(source: string): number[] {
  const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  const homeVars = new Set<string>();
  const unwrap = (n: ts.Node): ts.Node => {
    let e = n;
    while (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) e = e.expression;
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      return unwrap(e.left);
    }
    return e;
  };
  const isHome = (raw: ts.Node): boolean => {
    const n = unwrap(raw);
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      return (ts.isIdentifier(c) && c.text === "homedir") || (ts.isPropertyAccessExpression(c) && c.name.text === "homedir");
    }
    if (ts.isPropertyAccessExpression(n)) return n.name.text === "HOME" && n.expression.getText(file) === "process.env";
    if (ts.isElementAccessExpression(n)) {
      return n.expression.getText(file) === "process.env" && ts.isStringLiteral(n.argumentExpression) && n.argumentExpression.text === "HOME";
    }
    return ts.isIdentifier(n) && homeVars.has(n.text);
  };
  const collect = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isHome(n.initializer)) homeVars.add(n.name.text);
    ts.forEachChild(n, collect);
  };
  collect(file);
  const lines: number[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const name = n.expression.text;
      const args = n.arguments;
      const readsSettings = SETTINGS_READERS.has(name) && args.some(isHome);
      const literals = args.slice(1).map(x => (ts.isStringLiteral(x) ? x.text : null));
      const joinsClaude =
        name === "join" &&
        args.length >= 2 &&
        isHome(args[0]!) &&
        literals.includes(".claude") &&
        literals.some(x => x === "settings.json" || x === "settings.local.json");
      if (readsSettings || joinsClaude) lines.push(file.getLineAndCharacterOfPosition(n.getStart()).line + 1);
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
  return lines;
}
