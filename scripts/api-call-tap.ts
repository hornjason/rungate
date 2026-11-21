/**
 * A Bun preload that records every `fetch` this process makes (#2596).
 *
 *   BUN_OPTIONS="--preload=$PWD/scripts/api-call-tap.ts" RUNGATE_API_TAP=<record> bun …
 *
 * Spell it with `=`, which `tapBunOptions` in `scripts/ci-api-census.ts`
 * does. Bun 1.3.14 reads `BUN_OPTIONS="--preload <path>"` (a space) as a
 * flag followed by a script name, so `bun test` answers `Script not found
 * "test"` — measured, and `test/ci-api-census.test.ts` runs `bun test`
 * under the preload so a respelling goes red.
 *
 * Octokit and every hand-rolled GitHub reader in this repository send through
 * `fetch`, so one wrapper sees them all, in every `bun` process the run starts
 * — `BUN_OPTIONS` is inherited by child processes, which is how a suite's
 * subprocesses are counted too. `gh` is a Go binary and is counted by the
 * `gh` tap `scripts/ci-api-census.ts --install-gh-tap` writes instead.
 *
 * One line per request, `API-TAP fetch <METHOD> <origin><path> from=<file>`,
 * appended to the record. `from` is the calling file, read off the stack: the
 * test file when a test is on the stack, otherwise the first frame outside
 * `node_modules` and this file, relative to the working directory — `-` when
 * neither is there. It is what turns "the suite made 200 calls" into "these
 * three files made most of them". The query string is not written: a record is printed into CI
 * logs, and a query is where a token would travel if anything ever sent one
 * that way. `scripts/ci-api-census.ts` counts the record.
 *
 * `gh` has no stack to read, so this also wraps `Bun.spawn` and
 * `Bun.spawnSync` — `node:child_process` goes through the latter — and hands
 * every child `RUNGATE_API_TAP_FROM`, the caller as read here. The `gh` tap
 * writes it on its own lines, so a gh request is attributed like a fetch.
 *
 * With `RUNGATE_API_TAP` unset this does nothing at all, so the preload can be
 * left in place without changing what a run does. A request whose line cannot
 * be written still goes out — the record must never break the call it
 * describes — and the loss is printed as `API-TAP-LOST`, which the census
 * counts, so a short record says it is short.
 */

import { appendFileSync } from "fs";
import { relative } from "path";

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

/**
 * The file that asked. A test file on the stack first; then the running test
 * file (`main` — `Bun.main` names the file `bun test` is executing, which
 * is what an Octokit call is left with once its own frames are dropped); then
 * the first frame outside node_modules and this tap; then `main` whatever it
 * is; then `-`.
 */
export function callerOf(stack: string, cwd: string, main?: string): string {
  const files = [...stack.matchAll(/\(?((?:\/|[A-Za-z]:\\)[^():\s]+):\d+:\d+\)?/g)]
    .map(m => m[1])
    .filter(f => !f.includes("/node_modules/") && !f.endsWith("api-call-tap.ts"));
  const pick = files.find(f => TEST_FILE.test(f)) ?? (main && TEST_FILE.test(main) ? main : undefined) ?? files[0] ?? main;
  return pick ? (relative(cwd, pick) || pick).replace(/\s/g, "_") : "-";
}

export const FROM_VAR = "RUNGATE_API_TAP_FROM";

type Env = Record<string, string | undefined>;

/**
 * A child's environment with the caller in it.
 *
 * - An environment the spawn was GIVEN that already names a caller is left
 *   exactly as it is — including `""`, which is how a test opts its child out.
 * - Otherwise the base is that environment, or with none given the STARTUP
 *   environment: Bun hands a child given no `env` the environment the process
 *   started with, not later `process.env` writes, and #1096's tests hold it
 *   to that. Passing today's `process.env` instead changed what children saw.
 * - A caller inherited in the base is kept, so the outermost one names the
 *   call — the test file, when a test spawned the script that spawned gh.
 */
export function withCaller(given: Env | undefined, from: string, startup: Env): Env {
  if (given && given[FROM_VAR] !== undefined) return given;
  const base = given ?? startup;
  return base[FROM_VAR] ? base : { ...base, [FROM_VAR]: from };
}

const record = process.env.RUNGATE_API_TAP;
/** What Bun gives a child spawned with no `env`: the environment at startup, which is when a preload runs. */
const startup: Env = { ...process.env };
/** A caller this process was handed by the one that spawned it. Empty means none. */
const inherited = startup[FROM_VAR] || undefined;

if (record) {
  const real = globalThis.fetch;
  const tapped = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const isRequest = typeof input === "object" && input !== null && "url" in input && !(input instanceof URL);
    const raw = isRequest ? (input as Request).url : String(input);
    const method = (init?.method ?? (isRequest ? (input as Request).method : "GET")).toUpperCase();
    let where = raw;
    try {
      const u = new URL(raw);
      // `origin` is the string "null" for file: and other non-network schemes,
      // so those are written scheme-first and the census files them as local.
      where = u.protocol === "http:" || u.protocol === "https:" ? `${u.origin}${u.pathname}` : `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      // Recorded, not lost: the line below is written with this degraded URL,
      // and the census counts it once, as a line that did not parse. An
      // API-TAP-LOST here as well counted one call twice (#2614 review).
      where = `unparseable:${raw.split("?")[0]}`;
    }
    try {
      const from = inherited ?? callerOf(new Error().stack ?? "", process.cwd(), Bun.main);
      appendFileSync(record, `API-TAP fetch ${method} ${where} from=${from}\n`);
    } catch (e) {
      console.error(`API-TAP-LOST fetch ${method} ${where}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return real(input, init);
  };
  globalThis.fetch = Object.assign(tapped, real) as typeof fetch;

  // Both call forms: (cmd[], options?) and ({ cmd, env, … }).
  const here = () => callerOf(new Error().stack ?? "", process.cwd(), Bun.main);
  const realSpawnSync = Bun.spawnSync;
  const realSpawn = Bun.spawn;
  const tag = (args: unknown[]): unknown[] => {
    const [first, second] = args;
    if (Array.isArray(first)) {
      const opts = (second ?? {}) as { env?: Record<string, string | undefined> };
      return [first, { ...opts, env: withCaller(opts.env, here(), startup) }, ...args.slice(2)];
    }
    if (first && typeof first === "object") {
      const opts = first as { env?: Record<string, string | undefined> };
      return [{ ...opts, env: withCaller(opts.env, here(), startup) }, ...args.slice(1)];
    }
    return args;
  };
  (Bun as unknown as { spawnSync: unknown }).spawnSync = (...args: unknown[]) =>
    (realSpawnSync as unknown as (...a: unknown[]) => unknown).apply(Bun, tag(args));
  (Bun as unknown as { spawn: unknown }).spawn = (...args: unknown[]) =>
    (realSpawn as unknown as (...a: unknown[]) => unknown).apply(Bun, tag(args));
}
