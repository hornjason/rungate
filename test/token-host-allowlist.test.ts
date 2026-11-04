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
import { assertTokenMayReach, resolveGitHubToken, tokenRefusalReason } from "../lib/github";
import { tokenFromEnv } from "../scripts/check-state-record-closes";

const ROOT = join(import.meta.dir, "..");

/**
 * Reading the credential out of the environment BY NAME.
 *
 * **Both names, and all four spellings.** The first version matched
 * `GITHUB_TOKEN` only, in dot and bracket form, and review was right that it
 * was narrower than the property the census claims. The two it missed are
 * the two that matter most:
 *
 *   - `process.env.GH_TOKEN` — the name `gh auth login` actually sets, and
 *     the ONLY one set on this machine. A file reading it directly looks
 *     correct here and still bypasses the trim and the dual-name fallback.
 *   - `const { GITHUB_TOKEN } = process.env` — destructuring, which reads
 *     the same property through different syntax, exactly as `CLOSURE-8`'s
 *     `readFileSync` is an import spelled differently.
 *
 * Deliberately still not a match on the bare word: prose naming the variable
 * is how the rule gets explained, and a detector that refuses its own
 * documentation gets relaxed rather than obeyed. The planted samples in the
 * census below assert both directions before the tree is believed.
 */
const TOKEN_NAMES = "(?:GITHUB_TOKEN|GH_TOKEN)";
/**
 * **And through an alias, which is how the one real violation hid.**
 *
 * A security scan found `scripts/check-state-record-closes.ts` reading
 * `env.GITHUB_TOKEN ?? env.GH_TOKEN`, where `env` is a parameter defaulting
 * to `process.env`. Pinning the receiver to the literal `process.env` made
 * the census blind to it, and the commit that widened this to both names
 * claimed the tree was clean on the strength of that blindness.
 *
 * So the receiver is WIDENED rather than dropped. Dropping it entirely was
 * the first attempt and it went red on four files, every one a false
 * positive: `${{ secrets.GITHUB_TOKEN }}` emitted into generated Actions
 * YAML by `lib/scaffold/ai-review-step.ts`, and two prose comments naming
 * `secrets.GITHUB_TOKEN`. That is how a workflow is SUPPOSED to pass the
 * token, and a census that refuses the correct spelling is one the next
 * person deletes.
 *
 * What is forbidden is reading these names off an ENVIRONMENT RECORD:
 * `process.env`, `Bun.env`, `import.meta.env`, or any identifier whose name
 * ends in `env` — which is what the alias in the real violation was.
 *
 * `delete env.GH_TOKEN` is explicitly NOT a violation and the tree has two
 * of them. Removing a variable is the opposite of reading it to use as a
 * credential, and a census that refused the cleanup would be relaxed rather
 * than obeyed. The planted samples below assert every one of these
 * directions, because each was found by being wrong about it first.
 */
// `[\w$]*` and not `[A-Za-z_$][\w$]*`: the bare identifier `env` is the one
// the real violation used, and requiring a character before `env` missed it.
const ENV_RECEIVER = "(?:process\\.env|Bun\\.env|import\\.meta\\.env|\\b[\\w$]*[eE]nv\\b)";
const DIRECT_TOKEN_READ = new RegExp(
  [
    `(?<!delete\\s)${ENV_RECEIVER}\\s*\\??\\.\\s*${TOKEN_NAMES}\\b`,
    `${ENV_RECEIVER}\\s*\\??\\[\\s*["'\`]${TOKEN_NAMES}["'\`]\\s*\\]`,
    `\\{[^}]*\\b${TOKEN_NAMES}\\b[^}]*\\}\\s*=\\s*${ENV_RECEIVER}\\b`,
  ].join("|"),
);

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

describe("one allowlist, declared once, whoever asks it", () => {
  // Two copies of an allowlist are one guard with a dead twin, and no
  // behavioural case can tell which half it exercised
  // (`.claude/rules/checks-must-be-able-to-fail.md`). Asserted as a
  // repository-wide census rather than against the files that exist today,
  // because the defect this guards is somebody adding ANOTHER caller and
  // inlining the hosts beside it.
  //
  // The title used to say "both callers". There is one production caller in
  // this tree — `resolveApiBaseUrl` — and the second, `restAll()` in
  // `scripts/work-status.ts`, lands with #1740. That wording was wrong in
  // three places on this branch and the census is the reason it did not
  // matter: it counts declarations, not callers, so it is correct whatever
  // the caller count turns out to be.
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
    // GH_TOKEN, added in review. It is the name `gh auth login` sets and the
    // only one set on this machine, so a file reading it directly is the
    // instance most likely to be written and least likely to be noticed —
    // it works here and still skips the trim and the fallback.
    expect(DIRECT_TOKEN_READ.test("const t = process.env.GH_TOKEN;")).toBe(true);
    expect(DIRECT_TOKEN_READ.test('const t = process.env["GH_TOKEN"];')).toBe(true);
    // Destructuring: the same property read through different syntax, which
    // is the shape `CLOSURE-8` exists for one directory over.
    expect(DIRECT_TOKEN_READ.test("const { GITHUB_TOKEN } = process.env;")).toBe(true);
    expect(DIRECT_TOKEN_READ.test("const { GH_TOKEN: t } = process.env;")).toBe(true);
    expect(DIRECT_TOKEN_READ.test("const { FOO, GH_TOKEN, BAR } = process.env;")).toBe(true);
    // THE ALIAS, which is the one that actually hid in this tree. A security
    // scan found `env.GITHUB_TOKEN ?? env.GH_TOKEN` in
    // `scripts/check-state-record-closes.ts`, where `env` is a parameter
    // defaulting to `process.env` — and the previous pattern pinned the
    // receiver to the literal `process.env`, so it could not see it. The
    // commit that widened this to both names then claimed the tree was
    // clean, on the strength of that blindness.
    expect(DIRECT_TOKEN_READ.test("token: env.GITHUB_TOKEN ?? env.GH_TOKEN ?? null,")).toBe(true);
    expect(DIRECT_TOKEN_READ.test("const t = opts.env?.GH_TOKEN;")).toBe(true);
    expect(DIRECT_TOKEN_READ.test('const t = procEnv["GITHUB_TOKEN"];')).toBe(true);
    expect(DIRECT_TOKEN_READ.test("const t = Bun.env.GH_TOKEN;")).toBe(true);
    expect(DIRECT_TOKEN_READ.test("const t = import.meta.env.GH_TOKEN;")).toBe(true);
    expect(DIRECT_TOKEN_READ.test("const { GH_TOKEN } = env;")).toBe(true);
    // NOT an Actions expression. `${{ secrets.GITHUB_TOKEN }}` is how a
    // workflow is supposed to pass the token, and the scaffold emits it into
    // generated YAML four times. The first widening flagged all of them.
    expect(DIRECT_TOKEN_READ.test("`    GITHUB_TOKEN: \\${{ secrets.GITHUB_TOKEN }}`,")).toBe(false);
    expect(DIRECT_TOKEN_READ.test(" * USER-level project, and `secrets.GITHUB_TOKEN` is repository-scoped")).toBe(false);
    // And NOT a deletion. The tree holds two — `lib/live-issues.ts` and
    // `scripts/plan-issues.ts` both `delete env.GH_TOKEN` to force a child
    // process onto the other credential. Removing a variable is the opposite
    // of reading it to use as one, and a census that refused the cleanup
    // would be relaxed rather than obeyed.
    expect(DIRECT_TOKEN_READ.test("delete env.GH_TOKEN;")).toBe(false);
    expect(DIRECT_TOKEN_READ.test("  delete env.GITHUB_TOKEN;")).toBe(false);
    // And it must NOT fire on prose that merely names the variable, or this
    // census refuses the comment that explains why it exists — and the
    // cheapest repair for that is to stop writing the explanation.
    expect(DIRECT_TOKEN_READ.test("// export GITHUB_TOKEN before running")).toBe(false);
    expect(DIRECT_TOKEN_READ.test("// GH_TOKEN is what gh auth login sets")).toBe(false);
    // Nor on a name used as DATA rather than as a read — `resolveGitHubToken`
    // itself loops over a names array, and a census that refused the one
    // correct implementation would be deleted rather than obeyed.
    expect(DIRECT_TOKEN_READ.test('const NAMES = ["GITHUB_TOKEN", "GH_TOKEN"];')).toBe(false);

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

  /**
   * The one file that genuinely cannot call the resolver, bound by agreement.
   *
   * `scripts/check-state-record-closes.ts` must have no relative imports —
   * `test/state-record-closes-mutation.test.ts` asserts it, because its
   * mutants are copied to a temp directory and run there, so a
   * `from "../lib/…"` makes every mutant die on module resolution and read
   * as a refusal on the merits. The "one resolver" rule therefore cannot be
   * satisfied there by calling `resolveGitHubToken`, and the security scan
   * that found `env.GITHUB_TOKEN ?? env.GH_TOKEN` there proposed exactly
   * that fix. It is blocked, not declined.
   *
   * So the two implementations are asserted EQUAL on the same inputs rather
   * than each asserted correct — the fourth shape's documented remedy for an
   * import-free file. A change to either is red until the other follows, and
   * the grid includes the two properties the script was missing before this:
   * the `GH_TOKEN` fallback and the trim.
   *
   * `resolveGitHubToken` grew an optional `env` parameter for this. It
   * defaults to `process.env`, so every existing caller is unchanged.
   */
  test("the import-free copy of the resolver agrees with it on every input", () => {
    const VALUES = [undefined, "", "   ", "tok", " tok ", "tok\n"];
    let differed = 0;
    let compared = 0;
    let nonNull = 0;
    for (const GITHUB_TOKEN of VALUES) {
      for (const GH_TOKEN of VALUES) {
        const env: Record<string, string | undefined> = { GITHUB_TOKEN, GH_TOKEN };
        const mine = tokenFromEnv(env);
        const theirs = resolveGitHubToken(env);
        compared++;
        if (mine !== theirs) differed++;
        if (theirs !== undefined) nonNull++;
        expect(
          mine,
          `the two resolvers disagree on GITHUB_TOKEN=${JSON.stringify(GITHUB_TOKEN)} ` +
            `GH_TOKEN=${JSON.stringify(GH_TOKEN)} — scripts/check-state-record-closes.ts ` +
            "cannot import lib/github.ts, so this equality is the only thing holding them together",
        ).toBe(theirs);
      }
    }
    // The grid is the instrument. Both halves non-empty, or it agrees vacuously.
    expect(compared, "the grid collapsed").toBe(36);
    expect(nonNull, "every row resolved to nothing — the grid proves no agreement").toBeGreaterThan(0);
    expect(differed).toBe(0);

    // And the two properties the script did NOT have before, asserted
    // directly rather than inferred from the agreement above.
    expect(tokenFromEnv({ GH_TOKEN: "tok" }), "the GH_TOKEN fallback").toBe("tok");
    expect(tokenFromEnv({ GITHUB_TOKEN: "tok\n" }), "the trim").toBe("tok");
    expect(tokenFromEnv({ GITHUB_TOKEN: "   ", GH_TOKEN: "tok" }), "whitespace is absence").toBe("tok");
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
