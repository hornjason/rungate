/**
 * Where GitHub is, and the one knob that moves it — #1935.
 *
 * `scripts/board-ready.ts` hard-coded `https://api.github.com` at both of its
 * fetch sites, which is what made the script undriveable by a test: nothing
 * executed its `main()` past the argument and credential guards, so every
 * decision it makes was verified by reading its source text.
 *
 * **Loopback only, and a refusal rather than a fallback.** This variable
 * redirects requests that carry a ProjectsV2 PAT. An override naming any
 * other host would send that credential to it, so a value this cannot prove
 * is loopback stops the run before the token is used. Falling back to the
 * live API instead would be the same request with the operator's intent
 * discarded — Silent Default Substitution
 * (`.claude/rules/config-access.md`) in the direction that leaks.
 *
 * It lives here rather than in the script because the script ends in
 * `process.exit(await main())` and cannot be imported: a predicate nothing
 * can call is a predicate nothing can enumerate the population of.
 */
export const API_BASE_ENV = "RUNGATE_GITHUB_API_BASE";

export const LIVE_API_BASE = "https://api.github.com";

/**
 * The hosts an override may name. Closed, and spelled as a list rather than
 * a pattern: `127.0.0.1.evil.test` and `localhost.evil.test` both satisfy
 * every "starts with" and "contains" spelling of this check.
 *
 * **`[::1]` bracketed, and no bare `::1`.** Review round 1 of #1982 caught
 * the unbracketed form sitting here unreachable: WHATWG parsing requires an
 * IPv6 literal to be bracketed, so `new URL("http://::1")` THROWS and
 * `u.hostname` never produces the bare string. An entry nothing can match is
 * a host form a reader believes is handled. `BR-79` asserts both readings so
 * it cannot come back silently.
 */
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];

export type ApiBaseReading =
  | { readonly base: string; readonly why: null }
  | { readonly base: null; readonly why: string };

/** `{ base }`, or `{ why }` naming what was refused. Never a quiet default. */
export function resolveApiBase(raw: string | undefined): ApiBaseReading {
  const v = (raw ?? "").trim();
  if (v === "") return { base: LIVE_API_BASE, why: null };
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return { base: null, why: `${API_BASE_ENV} is set to "${v}", which is not a URL` };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { base: null, why: `${API_BASE_ENV} is set to "${v}", whose scheme is not http or https` };
  }
  if (!LOOPBACK_HOSTS.includes(u.hostname)) {
    return {
      base: null,
      why:
        `${API_BASE_ENV} is set to "${v}", whose host ${u.hostname} is not loopback. This run ` +
        `holds a board-writing credential and will not send it anywhere else. Nothing was read.`,
    };
  }
  // No trailing slash, so every caller composes paths the same way.
  return { base: `${u.origin}${u.pathname.replace(/\/+$/, "")}`, why: null };
}
