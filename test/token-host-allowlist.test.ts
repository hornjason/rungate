/**
 * May this URL carry our bearer token?
 *
 * The question `lib/github.ts` has asked of `GITHUB_API_URL` since security
 * review flagged that variable twice, now asked in one place.
 *
 * The second caller, `restAll()` in `scripts/work-status.ts`, is NOT in this
 * tree — it lands with #1740, and it follows `Link: rel="next"`, a **response**
 * header, so the host it names is chosen by whoever answered rather than by
 * us. That is what the `base` parameter is for, and until #1740 merges the
 * cases below are the only thing exercising it. Written out because the
 * earlier wording said "both callers" of a tree holding one, and a reader
 * going to check cannot tell a split from a sentence nobody updated.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { assertTokenMayReach, tokenRefusalReason } from "../lib/github";

const ROOT = join(import.meta.dir, "..");

/**
 * Reading the credential out of the environment BY NAME, in the three
 * spellings TypeScript offers. Deliberately not a match on the bare word:
 * prose naming the variable is how the rule gets explained, and a detector
 * that refuses its own documentation gets relaxed rather than obeyed.
 */
const DIRECT_TOKEN_READ = /process\.env\.GITHUB_TOKEN\b|process\.env\[\s*["']GITHUB_TOKEN["']\s*\]/;

describe("tokenRefusalReason", () => {
  test("GitHub and loopback are allowed — CI sets GITHUB_API_URL to the real API", () => {
    for (const ok of [
      "https://api.github.com/repos/hornjason/rungate/issues?page=2",
      "https://github.com",
      "http://127.0.0.1:8080/x",
      "http://localhost:3000",
    ]) {
      expect(tokenRefusalReason(ok)).toBeNull();
    }
  });

  // The exact-hostname property. A prefix match would pass this host.
  test("a suffixed lookalike is refused", () => {
    expect(tokenRefusalReason("https://api.github.com.evil.com/x")).toContain("evil.com");
  });

  // The userinfo property, checked separately because the hostname of
  // `https://127.0.0.1@evil.com` is `evil.com` — but the reverse spelling,
  // `https://evil.com@api.github.com`, has an ALLOWED hostname and still
  // sends credentials nobody wrote. Neither may pass.
  test("userinfo is refused in both directions", () => {
    // Both refuse; only the second needs the userinfo check to do it. The
    // first has hostname `evil.com` and is caught by the host rule, which
    // reports first on purpose — the existing `/loopback/` cases in
    // `test/github-client.test.ts` read that message, and a refusal whose
    // reason names the incidental problem sends the reader to fix the wrong
    // thing. Asserting the REASON here, not just the refusal, is what pins
    // the ordering: swap the two blocks and this case goes red.
    expect(tokenRefusalReason("https://127.0.0.1@evil.com/x")).toContain("loopback");
    expect(tokenRefusalReason("https://evil.com@api.github.com/x")).toContain("userinfo");
  });

  test("a malformed URL is refused, not silently allowed", () => {
    expect(tokenRefusalReason("not a url")).toContain("not a valid URL");
  });

  // An ALLOWED hostname over cleartext still puts the token on the wire, and
  // it passes every other check in this function. Loopback keeps `http:`
  // because a local test server has no certificate and the token never
  // leaves the machine.
  test("cleartext is refused to a real host and allowed to loopback", () => {
    expect(tokenRefusalReason("http://api.github.com/x")).toContain("http://");
    expect(tokenRefusalReason("http://github.com/x")).toContain("http://");
    expect(tokenRefusalReason("http://127.0.0.1:8080/x")).toBeNull();
    expect(tokenRefusalReason("http://localhost:3000")).toBeNull();
  });

  // A scheme that is neither, on an allowed host.
  test("a non-http scheme on an allowed host is refused", () => {
    expect(tokenRefusalReason("ftp://api.github.com/x")).toContain("ftp:");
  });

  // The row above and the row before it, between them, made the gap look
  // covered: one exercises a bad scheme on a real host, the other exercises
  // `http:` on loopback. Neither exercises a bad scheme ON loopback, and the
  // guard's condition is a conjunction — `protocol !== "https:" && !LOOPBACK`
  // — so the loopback host short-circuits the scheme test entirely. The
  // documented contract is "https everywhere, plain http only for loopback";
  // what was implemented is "ANY scheme for loopback".
  //
  // This is the seventh shape in `.claude/rules/checks-must-be-able-to-fail.md`
  // read backwards: the two existing cases vary one axis each and the defect
  // sits on the pair neither visits. Naming what both hold fixed — the host
  // on one, the scheme on the other — is what produced this case.
  /**
   * An entry nothing can reach, and why it needs a SOURCE assertion.
   *
   * `LOOPBACK_HOSTS` carried both `"[::1]"` and `"::1"`. Only the bracketed
   * form can ever match: `url.hostname` is what the set is compared against,
   * and WHATWG always brackets an IPv6 host. Measured here rather than
   * asserted, including the longhand, which normalises to the same thing:
   *
   *   new URL("http://[::1]/x").hostname                → "[::1]"
   *   new URL("http://[0:0:0:0:0:0:0:1]/x").hostname    → "[::1]"
   *   new URL("http://::1/x")                           → throws
   *
   * So the unbracketed entry matched no hostname any URL can produce. It was
   * NOT a behaviour bug — the bracketed form is present, so IPv6 loopback was
   * allowed correctly throughout, and removing the dead entry changes no
   * outcome. That is exactly why this has to be a source assertion: an
   * unreachable entry is by definition invisible to every behavioural case,
   * and a behavioural suite that grew to cover it would be asserting
   * something the URL parser makes impossible.
   *
   * The row is written as a property over the set rather than a ban on one
   * string, so a second unbracketed literal added later is caught too.
   *
   * Breaking it: put `"::1"` back and this goes red naming it.
   */
  test("LOOPBACK_HOSTS holds no unbracketed IPv6 literal — nothing could reach one", () => {
    expect(new URL("http://[::1]/x").hostname).toBe("[::1]");
    expect(new URL("http://[0:0:0:0:0:0:0:1]/x").hostname).toBe("[::1]");
    expect(() => new URL("http://::1/x")).toThrow();

    const src = readFileSync(join(ROOT, "lib", "github.ts"), "utf8");
    // Closing on `]);` and not on the first `]`. A `[^\]]*` body was the
    // first spelling and it stopped INSIDE `"[::1]"` — the one entry this row
    // exists to distinguish — so the match came back undefined and the
    // vacuity guard below is what reported it rather than a silent pass.
    const declared = /const LOOPBACK_HOSTS = new Set\(\[([\s\S]*?)\]\);/.exec(src)?.[1];
    expect(
      declared,
      "LOOPBACK_HOSTS was not found in lib/github.ts — this row would pass vacuously",
    ).toBeTruthy();

    const entries = [...(declared ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(entries, "no entries parsed out of the set").not.toEqual([]);
    expect(entries).toContain("[::1]");
    expect(
      entries.filter((h) => h.includes(":") && !h.startsWith("[")),
      "an unbracketed IPv6 literal in LOOPBACK_HOSTS matches no hostname the URL parser " +
        'can produce — `url.hostname` is always bracketed. Write "[::1]", not "::1".',
    ).toEqual([]);
  });

  test("only http and https reach loopback — any other scheme is refused there too", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      for (const scheme of ["ftp", "ws", "wss", "file", "gopher", "data"]) {
        const url = `${scheme}://${host}/x`;
        const reason = tokenRefusalReason(url);
        expect(reason, `${url} must not carry a token`).not.toBeNull();

        // `file://localhost/x` is the one that refuses for a DIFFERENT
        // reason, and it is measured rather than assumed: WHATWG normalises
        // a `file:` URL's `localhost` host to the empty string, so the host
        // rule catches it first and the message names no scheme. The reason
        // is only required to name the scheme where the host survived
        // parsing as a loopback entry — asserting otherwise would be
        // asserting something false about the URL parser.
        if (new URL(url).hostname !== "") {
          expect(reason, `${url} should be refused ON ITS SCHEME`).toContain(`${scheme}:`);
        }
      }
    }
    // The positive half, in the same case, so a repair that simply refuses
    // everything to loopback cannot go green here. Loopback keeps `http:`
    // deliberately: a local test server has no certificate and the token
    // never leaves the machine.
    expect(tokenRefusalReason("http://127.0.0.1:8080/x")).toBeNull();
    expect(tokenRefusalReason("https://localhost:3000/x")).toBeNull();
  });

  // A relative `Link` header resolves against the page it came from, so the
  // base must be honoured — and must not become a way in.
  test("a relative next link resolves against its base", () => {
    expect(tokenRefusalReason("/repos/x/issues?page=3", "https://api.github.com/repos/x/issues")).toBeNull();
    expect(tokenRefusalReason("//evil.com/x", "https://api.github.com/y")).toContain("evil.com");
  });

  test("assertTokenMayReach names the input that produced the refusal", () => {
    expect(() => assertTokenMayReach("https://evil.com/x", 'Link rel="next"')).toThrow(/Link rel="next"/);
  });

});

describe("one allowlist, and both callers ask it", () => {
  // Two copies of an allowlist are one guard with a dead twin, and no
  // behavioural case can tell which half it exercised
  // (`.claude/rules/checks-must-be-able-to-fail.md`). Asserted as a
  // repository-wide census rather than against the two files that exist
  // today, because the defect this guards is somebody adding a THIRD caller
  // and inlining the hosts beside it.
  test("the host set is declared exactly once in the tree", () => {
    const declarations: string[] = [];
    for (const dir of ["lib", "scripts", "gates", "hooks", "bin"]) {
      const d = join(ROOT, dir);
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d, { recursive: true, encoding: "utf-8" })) {
        if (!f.endsWith(".ts")) continue;
        const p = join(d, f);
        if (!statSync(p).isFile()) continue;
        if (readFileSync(p, "utf-8").includes('"api.github.com",')) declarations.push(`${dir}/${f}`);
      }
    }
    expect(declarations).toEqual(["lib/github.ts"]);
  });

  // The reason it is not loopback-only: GitHub Actions sets
  // `GITHUB_API_URL=https://api.github.com` on every run, and a loopback-only
  // rule refused the genuine API in CI while passing locally.
  test("the allowlist is not loopback-only — that broke CI once", () => {
    expect(tokenRefusalReason("https://api.github.com/x")).toBeNull();
  });

  // The SECOND decider, and the one the reviewer has asked for across two
  // pull requests: a defect class that keeps being fixed one instance at a
  // time never gets a guard that stops the next instance.
  //
  // `resolveGitHubToken()` exists because #139/#140 cost this repo a month of
  // silently broken Octokit calls: `gh auth status` on this machine reports
  // the account authenticated via `GH_TOKEN`, and nothing sets `GITHUB_TOKEN`.
  // `lib/github.ts` carries a fifteen-line docblock about it. A new script
  // then read `process.env.GITHUB_TOKEN` directly and printed
  // "UNMEASURED: no GITHUB_TOKEN" on a machine holding a valid credential —
  // the same bug, in a new file, in the repository that documented it.
  //
  // Asserted as a census rather than against `scripts/work-status.ts`,
  // because the thing to stop is the NEXT file, not that one.
  test("the credential is resolved in exactly one place in the tree", () => {
    // ANTI-VACUITY FIRST, and the first draft of this row needed it. The
    // detector was pointed at the tree and compared against
    // `["lib/github.ts"]` — and `lib/github.ts` does not match it, because
    // `resolveGitHubToken` loops over a NAMES ARRAY and reads
    // `process.env[name]`. So the census was about to be an empty list
    // compared with a list of one, which fails loudly today and would have
    // been deleted into `toEqual([])` by whoever met it next — at which
    // point it compares two empty collections forever
    // (`.claude/rules/checks-must-be-able-to-fail.md`, the third shape).
    //
    // So the detector is proved able to see the shape, on planted samples,
    // before it is believed about the tree.
    expect(DIRECT_TOKEN_READ.test("const t = process.env.GITHUB_TOKEN;")).toBe(true);
    expect(DIRECT_TOKEN_READ.test('const t = process.env["GITHUB_TOKEN"];')).toBe(true);
    expect(DIRECT_TOKEN_READ.test("const t = process.env['GITHUB_TOKEN'];")).toBe(true);
    // And it must NOT fire on prose that merely names the variable, or this
    // census refuses the comment that explains why it exists — and the
    // cheapest repair for that is to stop writing the explanation.
    expect(DIRECT_TOKEN_READ.test("// export GITHUB_TOKEN before running")).toBe(false);

    const readers: string[] = [];
    for (const dir of ["lib", "scripts", "gates", "hooks", "bin"]) {
      const d = join(ROOT, dir);
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d, { recursive: true, encoding: "utf-8" })) {
        if (!f.endsWith(".ts")) continue;
        const p = join(d, f);
        if (!statSync(p).isFile()) continue;
        if (DIRECT_TOKEN_READ.test(readFileSync(p, "utf-8"))) readers.push(`${dir}/${f}`);
      }
    }
    expect(
      readers,
      "nothing may read GITHUB_TOKEN out of the environment by name. Call " +
        "resolveGitHubToken(), which also accepts GH_TOKEN — the name `gh auth login` " +
        "actually sets, and the only one set on Jason's machine. A direct read reports " +
        "'no credential' on a machine that has one, which is #139/#140 and cost this " +
        "repository a month of silently broken Octokit calls.",
    ).toEqual([]);
  });

  // The other half: one resolver, not two. The census above forbids the raw
  // read; without this, satisfying it by writing a second resolver beside the
  // first is free — and two deciders answering one question are behaviourally
  // one, with no behavioural case able to say which is dead
  // (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape).
  test("resolveGitHubToken is declared exactly once in the tree", () => {
    const declarations: string[] = [];
    for (const dir of ["lib", "scripts", "gates", "hooks", "bin"]) {
      const d = join(ROOT, dir);
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d, { recursive: true, encoding: "utf-8" })) {
        if (!f.endsWith(".ts")) continue;
        const p = join(d, f);
        if (!statSync(p).isFile()) continue;
        if (/function resolveGitHubToken\b/.test(readFileSync(p, "utf-8"))) {
          declarations.push(`${dir}/${f}`);
        }
      }
    }
    expect(declarations).toEqual(["lib/github.ts"]);
  });

});
