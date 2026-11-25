/**
 * The one reader, in `test/`, of the machine's settings files (#2792).
 *
 * `~/.claude/settings.json` holds the machine's tokens in `env`, and a hook
 * command can carry one inline. A test that reads the file and fails can
 * print what it read: AC-11 printed the whole file until #2787.
 *
 * **One parse, verdicts out.** Every function here runs the census's own
 * readers (`readRegistrationScopes`, `readEnvScopes`, `wrongTreeViolations`,
 * `registeredTreeCensus`, `registrationCurrency`) on the raw documents, inside
 * this module, and returns their verdicts with every command and every
 * detail built from one replaced. Hook names, scopes, trees, spellings,
 * counts and resolved directories cross the boundary; a command and an `env`
 * value never do, so no assertion can print one.
 *
 * A first design (#2798, not merged) gave tests a reduced COPY of each file
 * instead. Each of its four review rounds found a census reader the copy
 * starved, because the copy was a second model of the census. Here there is
 * nothing to keep in step: the census reads what it always read.
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join, posix } from "path";
import {
  hookRegistration,
  registrationCensus,
  readRegistrationScopes,
  settingsScopePaths,
  unplacedHooks,
  type HookRegistration,
  type RegistrationScope,
  type ScopeReading,
} from "../../lib/hook-scopes";
import { readEnvScopes, registeredTreeCensus, type TargetReading, type TargetTreeCensus } from "../../lib/hook-target-tree";
import { registrationCurrency, type GitRunner, type RegistrationCurrency } from "../../lib/hook-tree-currency";
import { settingsCommands, wrongTreeViolations, type TreeViolation } from "../../lib/hook-trees";

/** What stands where a command was, in every verdict this module returns. */
export const COMMAND_WITHHELD = "<command withheld: machine settings text>";

/** A settings file read raw, inside this module only. Absent is `null`; any other error is thrown. */
function rawRead(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function readings(repoRoot: string, home: string, registry: string[]): ScopeReading[] {
  return readRegistrationScopes(repoRoot, home, rawRead, registry);
}

/** Which scopes could be read, and why not, with no command in it. */
export interface ScopeReadability {
  scope: RegistrationScope;
  readable: boolean;
  /** Why a scope could not be read: a path and an ownership, never file text. */
  unreadable?: string;
}

const readability = (r: ScopeReading): ScopeReadability => ({
  scope: r.scope,
  readable: r.commands !== null,
  ...(r.unreadable !== undefined ? { unreadable: r.unreadable } : {}),
});

/** Each scope, and whether it could be read. */
export function scopeReadability(repoRoot: string, home: string, registry: string[]): ScopeReadability[] {
  return readings(repoRoot, home, registry).map(readability);
}

/** `hookRegistration` over the raw scopes: a verdict naming scopes, never a command. */
export function hookRegistrationAt(repoRoot: string, home: string, registry: string[], hook: string): HookRegistration {
  return hookRegistration(hook, readings(repoRoot, home, registry));
}

/**
 * How many commands in one scope contain `needle`, or null when the scope
 * could not be read. A count, so a test can hold a registration to exactly
 * one without ever holding the commands.
 */
export function commandsNamingAt(
  repoRoot: string,
  home: string,
  registry: string[],
  scope: RegistrationScope,
  needle: string,
): number | null {
  const r = readings(repoRoot, home, registry).find(x => x.scope === scope);
  if (r === undefined) throw new Error(`${scope} is not a scope the census reads`);
  return r.commands === null ? null : r.commands.filter(c => c.includes(needle)).length;
}

/** `registrationCensus` over the raw scopes: one verdict per hook, naming scopes, never a command. */
export function registrationCensusAt(repoRoot: string, home: string, registry: string[], hooks: string[]): HookRegistration[] {
  return registrationCensus(hooks, readings(repoRoot, home, registry));
}

/**
 * `unplacedHooks` over the repo-owned scopes only, as hook names. The scopes
 * are the ones `settingsScopePaths` marks `repo`, and the registry.
 */
export function unplacedHooksAt(
  repoRoot: string,
  home: string,
  registry: string[],
  hooks: string[],
  declaredUnregistered: string[],
): { repoScopes: ScopeReadability[]; unplaced: string[] } {
  const owned = new Set<RegistrationScope>([
    ...settingsScopePaths(repoRoot, home).filter(s => s.ownership === "repo").map(s => s.scope),
    "repo-registry",
  ]);
  const repoReadings = readings(repoRoot, home, registry).filter(r => owned.has(r.scope));
  return {
    repoScopes: repoReadings.map(readability),
    unplaced: unplacedHooks({ hooks, repoReadings, declaredUnregistered }),
  };
}

/** A tree violation with its command withheld and a detail that names none. */
function safeViolation(v: TreeViolation): TreeViolation {
  const detail =
    v.tree === "unparsed"
      ? "a registration names this hook without executing it, so its tree cannot be read"
      : `a registration executes this hook from the ${v.tree} tree`;
  return { hook: v.hook, tree: v.tree, command: COMMAND_WITHHELD, detail };
}

/**
 * `wrongTreeViolations` over every settings scope that exists, read raw, with
 * which scopes were read and how many commands they hold.
 */
export function wrongTreeAt(
  repoRoot: string,
  home: string,
  owned: string[],
): { read: RegistrationScope[]; missing: RegistrationScope[]; commands: number; violations: TreeViolation[] } {
  const read: RegistrationScope[] = [];
  const missing: RegistrationScope[] = [];
  const docs: string[] = [];
  for (const { scope, path } of settingsScopePaths(repoRoot, home)) {
    const doc = rawRead(path);
    if (doc === null) {
      missing.push(scope);
      continue;
    }
    docs.push(doc);
    read.push(scope);
  }
  const commands = settingsCommands(docs);
  return { read, missing, commands: commands.length, violations: wrongTreeViolations(owned, commands).map(safeViolation) };
}

/** A target reading with its command withheld and a detail that names none. */
function safeTarget(r: TargetReading): TargetReading {
  const where = r.resolved === null ? "did not resolve" : `resolves to ${r.resolved}`;
  return { ...r, command: COMMAND_WITHHELD, detail: `${r.hook} [${r.scope}] through ${r.spelling} ${where}` };
}

/**
 * `registeredTreeCensus` over the raw scopes, every reading's command
 * withheld. An unmeasured reason the census took from an unresolved
 * reading's detail, which quotes the command, is replaced by that reading's
 * safe detail.
 */
export function treeCensusAt(repoRoot: string, home: string, registry: string[], owned: string[]): TargetTreeCensus {
  const census = registeredTreeCensus(owned, readings(repoRoot, home, registry), readEnvScopes(repoRoot, home, rawRead), repoRoot);
  const replaced = new Map(census.unresolved.map(r => [r.detail, safeTarget(r).detail]));
  return {
    ...census,
    unmeasuredReasons: census.unmeasuredReasons.map(reason => replaced.get(reason) ?? reason),
    inRepo: census.inRepo.map(safeTarget),
    foreign: census.foreign.map(safeTarget),
    unresolved: census.unresolved.map(safeTarget),
  };
}

/** `registrationCurrency` over {@link treeCensusAt}, so it sees no command either. */
export function registrationCurrencyAt(input: {
  repoRoot: string;
  home: string;
  base: string;
  ownedHooks: string[];
  registryCommands: string[];
  git: GitRunner;
}): RegistrationCurrency {
  return registrationCurrency(
    treeCensusAt(input.repoRoot, input.home, input.registryCommands, input.ownedHooks),
    input.base,
    input.git,
  );
}

/**
 * How many string values and keys in a settings document contain `needle`.
 * A count, and nothing else: each earlier AC-11 printed something read from
 * the file (the whole file, then a value, then a key). Read as JSON, so an
 * escaped quote is part of its value; a document that is not JSON counts 1
 * when its text contains `needle` anywhere.
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

/** {@link countMentions} over the file at `path`, or null when it is absent. */
export function settingsMentions(path: string, needle: string): number | null {
  const src = rawRead(path);
  return src === null ? null : countMentions(src, needle);
}

// ── This machine ─────────────────────────────────────────────────────────

export const liveScopeReadability = (repoRoot: string, registry: string[]) => scopeReadability(repoRoot, homedir(), registry);
export const liveHookRegistration = (repoRoot: string, registry: string[], hook: string) =>
  hookRegistrationAt(repoRoot, homedir(), registry, hook);
export const liveCommandsNaming = (repoRoot: string, registry: string[], scope: RegistrationScope, needle: string) =>
  commandsNamingAt(repoRoot, homedir(), registry, scope, needle);
export const liveRegistrationCensus = (repoRoot: string, registry: string[], hooks: string[]) =>
  registrationCensusAt(repoRoot, homedir(), registry, hooks);
export const liveUnplacedHooks = (repoRoot: string, registry: string[], hooks: string[], declaredUnregistered: string[]) =>
  unplacedHooksAt(repoRoot, homedir(), registry, hooks, declaredUnregistered);
export const liveWrongTree = (repoRoot: string, owned: string[]) => wrongTreeAt(repoRoot, homedir(), owned);
export const liveTreeCensus = (repoRoot: string, registry: string[], owned: string[]) =>
  treeCensusAt(repoRoot, homedir(), registry, owned);
export const liveRegistrationCurrency = (input: Omit<Parameters<typeof registrationCurrencyAt>[0], "home">) =>
  registrationCurrencyAt({ ...input, home: homedir() });
/** Where this machine's settings scopes live. Paths only; nothing is read. */
export const liveScopePaths = (repoRoot: string) => settingsScopePaths(repoRoot, homedir());
/** This machine's user settings file, for naming in a message. */
export const liveUserSettingsPath = () => join(homedir(), ".claude", "settings.json");
/** {@link settingsMentions} over this machine's user settings file. */
export const liveUserSettingsMentions = (needle: string) => settingsMentions(liveUserSettingsPath(), needle);

/** A settings scope under home, as a normalised tail. */
const SETTINGS_PATH = /^\.claude\/settings(\.local)?\.json$/;

/**
 * A path under the home directory that is not a settings file, such as
 * `~/.pai/hooks`. The segments are joined and normalised before they are
 * judged, so no split or spelling of a settings path gets through.
 */
export function homePath(...segments: string[]): string {
  if (segments.length === 0) throw new Error("homePath names a path under the home directory, never the directory itself");
  if (SETTINGS_PATH.test(posix.normalize(`/${segments.join("/")}`).replace(/^\/+/, ""))) {
    throw new Error("a settings file under ~/.claude is read through the functions above");
  }
  return join(homedir(), ...segments);
}
