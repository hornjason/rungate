/**
 * RepoRails readings cached by file content and CLI version — #2595.
 *
 * Every CI run used to spend one RepoRails check per instruction file (33 on
 * this tree) against a limit of 100 an hour with a key and 5 without, whether
 * or not any file had changed. A reading depends on the file's content and on
 * the CLI that produced it, so those two are the key, and a run that changed
 * no instruction file asks RepoRails nothing.
 *
 * A reading also depends on the server's model, which changes without a CLI
 * release, so an entry expires after {@link REPORAILS_CACHE_TTL_MS} and is
 * checked again.
 *
 * Pure apart from the file it is pointed at, and it imports nothing from the
 * caller: which findings are well formed is the caller's one validator
 * (`isRepoRailsFinding` in lib/compliance.ts), passed in, so this module cannot
 * grow a second opinion about it.
 */
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

/**
 * Where the cache lives, relative to the project root. The ONE spelling: the
 * compliance runner's default and this repository's `ci.persistPaths` both
 * name it, and `test/reporails-cache.test.ts` asserts the config agrees, so a
 * rename cannot leave CI persisting a file nothing reads (#2608 review).
 */
export const REPORAILS_CACHE_REL = ".rungate/reporails-cache.json";

/** Bumped when the stored shape changes; any other value reads as unreadable. */
export const REPORAILS_CACHE_SCHEMA = 1;

/** How long a reading stands before it is checked again: seven days. */
export const REPORAILS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CachedReading {
  quality: number | null;
  findings: unknown[];
  /** When it was read, ISO-8601. */
  at: string;
}

export interface ReporailsCache {
  entries: Record<string, CachedReading>;
  /**
   * Why the file could not be used, or null. A cache that cannot be read is
   * EMPTY, so every file is checked again; it is never "no findings", and the
   * reason is reported so the cost is visible.
   */
  unreadable: string | null;
}

export function reporailsCacheKey(content: string, cliVersion: string): string {
  return createHash("sha256").update(cliVersion).update("\0").update(content).digest("hex");
}

function isEntry(x: unknown, isFinding: (f: unknown) => boolean): x is CachedReading {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Record<string, unknown>;
  const qualityOk = e.quality === null || (typeof e.quality === "number" && Number.isFinite(e.quality));
  return qualityOk && Array.isArray(e.findings) && e.findings.every(isFinding) &&
    typeof e.at === "string" && Number.isFinite(Date.parse(e.at));
}

/**
 * Read the cache. An absent file is an empty cache with nothing to say. A
 * file that does not parse, or carries another schema, is an empty cache WITH
 * a reason. A malformed entry is dropped as a miss, and its neighbours stand.
 */
export function loadReporailsCache(path: string, isFinding: (f: unknown) => boolean): ReporailsCache {
  if (!existsSync(path)) return { entries: {}, unreadable: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    return { entries: {}, unreadable: `${path} does not parse (${(e as Error).message.split("\n")[0]})` };
  }
  const j = parsed as { schema?: unknown; entries?: unknown };
  if (j?.schema !== REPORAILS_CACHE_SCHEMA) {
    return { entries: {}, unreadable: `${path} carries schema ${JSON.stringify(j?.schema)}, not ${REPORAILS_CACHE_SCHEMA}` };
  }
  if (typeof j.entries !== "object" || j.entries === null || Array.isArray(j.entries)) {
    return { entries: {}, unreadable: `${path} has no entries object` };
  }
  const entries: Record<string, CachedReading> = {};
  for (const [k, v] of Object.entries(j.entries as Record<string, unknown>)) {
    if (isEntry(v, isFinding)) entries[k] = v;
  }
  return { entries, unreadable: null };
}

/** The entry for `key` if it was read within the expiry, or null. */
export function freshReading(cache: ReporailsCache, key: string, now: number): CachedReading | null {
  const e = cache.entries[key];
  if (!e) return null;
  const at = Date.parse(e.at);
  return Number.isFinite(at) && now - at <= REPORAILS_CACHE_TTL_MS ? e : null;
}

/** Write the entries that are still fresh; expired ones are dropped here. */
export function saveReporailsCache(path: string, entries: Record<string, CachedReading>, now: number): void {
  const kept: Record<string, CachedReading> = {};
  for (const [k, v] of Object.entries(entries)) {
    const at = Date.parse(v.at);
    if (Number.isFinite(at) && now - at <= REPORAILS_CACHE_TTL_MS) kept[k] = v;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ schema: REPORAILS_CACHE_SCHEMA, entries: kept })}\n`);
}
