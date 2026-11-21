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
 * With `RUNGATE_API_TAP` unset this does nothing at all, so the preload can be
 * left in place without changing what a run does. A request whose line cannot
 * be written still goes out — the record must never break the call it
 * describes — and the loss is printed as `API-TAP-LOST`, which the census
 * counts, so a short record says it is short.
 */

import { appendFileSync } from "fs";
import { relative } from "path";

/** The file that asked: a test file if one is on the stack, else the first frame outside node_modules and this tap. */
export function callerOf(stack: string, cwd: string): string {
  const files = [...stack.matchAll(/\(?((?:\/|[A-Za-z]:\\)[^():\s]+):\d+:\d+\)?/g)]
    .map(m => m[1])
    .filter(f => !f.includes("/node_modules/") && !f.endsWith("api-call-tap.ts"));
  const pick = files.find(f => /\.test\.[cm]?[jt]sx?$/.test(f)) ?? files[0];
  return pick ? relative(cwd, pick) || pick : "-";
}

const record = process.env.RUNGATE_API_TAP;

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
    } catch (e) {
      where = `unparseable:${raw.split("?")[0]}`;
      console.error(`API-TAP-LOST fetch ${method}: the URL did not parse (${e instanceof Error ? e.message : String(e)})`);
    }
    try {
      const from = callerOf(new Error().stack ?? "", process.cwd()).replace(/\s/g, "_");
      appendFileSync(record, `API-TAP fetch ${method} ${where} from=${from}\n`);
    } catch (e) {
      console.error(`API-TAP-LOST fetch ${method} ${where}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return real(input, init);
  };
  globalThis.fetch = Object.assign(tapped, real) as typeof fetch;
}
