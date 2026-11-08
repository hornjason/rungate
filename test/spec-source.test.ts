/**
 * `lib/spec-source.ts` — where a board reading's spec came from.
 *
 * Stage D's D3. The property under test is NOT "it reads origin/main"; it is
 * **it never reads the working tree while believing it read origin/main**.
 * Those are different, and only the second one is the defect: a reader that
 * falls back on failure produces a number that is correct-looking, scoped by
 * the caller's branch, and indistinguishable from the shipped reading.
 *
 * Every case drives a FAKE git runner, so no case touches a repository and
 * none of them can pass because this checkout happens to be clean. The runner
 * records what it was asked, and several cases assert on that record rather
 * than on the return value — "it did not fetch" is invisible in the content.
 */
import { describe, expect, test } from "bun:test";
import { join } from "path";
import {
  DEFAULT_SPEC_REF,
  describeSpecSource,
  redactCredentials,
  resolveSpecSource,
  type GitRun,
  type RealPath,
} from "../lib/spec-source";

const ok = (stdout: string): GitRun => ({ ok: true, code: 0, stdout, stderr: "" });
/**
 * A git that answered, and said no. `code` defaults to **1** — the
 * "I looked and it is not there" exit — because that is the only one that
 * means an answer. Rows that need 128 (broken reader) or `null` (never ran)
 * pass it explicitly, and the whole of security review round 1 is that the
 * three used to be one.
 */
const bad = (stderr: string, code: number | null = 1): GitRun => ({ ok: false, code, stdout: "", stderr });

/**
 * What a call is ASKING, rather than which binary it runs.
 *
 * `rev-parse` is two questions — *am I in a work tree* and *what does this
 * ref resolve to* — so keying on `args[0]` answers both with one row and a
 * case breaking the second silently breaks the first. Named here so a row
 * can break one without touching the other, which is what makes the
 * mutation battery's membership mean anything.
 */
const asks = (args: readonly string[]): string =>
  args[0] === "rev-parse" && args[1] === "--show-toplevel"
    ? "in-repo"
    : args[0] === "rev-parse" && args[1] === "--git-dir"
      ? "git-dir"
      : args[0]!;

/**
 * A git whose answers are keyed by what the call asks.
 *
 * Keyed rather than sequenced: a sequence breaks whenever the implementation
 * reorders two calls, which is a refactor rather than a regression, and a
 * broken sequence reads as a refusal on the merits.
 */
const fakeGit = (answers: Record<string, GitRun>, log: string[][] = []) => {
  const run = (args: readonly string[]): GitRun => {
    log.push([...args]);
    return answers[asks(args)] ?? bad(`fake git has no answer for ${asks(args)}`);
  };
  return { run, log };
};

/**
 * A realpath that moves nothing.
 *
 * The paths below are fictional — `/r`, `/tmp/plant` — and the subject of
 * these cases is the git logic, not the filesystem. The canonicalisation
 * has its own cases further down, which pass a realpath that DOES move, so
 * this identity cannot be the thing holding them up.
 */
const same: RealPath = p => p;

const NO_REPO = "fatal: not a git repository (or any of the parent directories): .git";
const TRACKED = "specs/SPEC.md";
const SHA = "1234567890abcdef1234567890abcdef12345678";

const complete = (over: Partial<Record<string, GitRun>> = {}) => ({
  "in-repo": ok("/r\n"),
  "git-dir": ok("/r/.git\n"),
  "ls-files": ok(`${TRACKED}\n`),
  fetch: ok(""),
  "rev-parse": ok(`${SHA}\n`),
  show: ok("# the shipped spec\n"),
  diff: ok(""),
  ...over,
});

describe("D3: the spec comes from the ref, and the reader says which", () => {
  test("a tracked path is read from origin/main, with the sha it resolved", () => {
    const git = fakeGit(complete());
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same });

    expect(r.kind).toBe("ref");
    if (r.kind !== "ref") return;
    expect(r.ref).toBe(DEFAULT_SPEC_REF);
    expect(r.sha).toBe(SHA);
    expect(r.path).toBe(TRACKED);
    expect(r.content).toBe("# the shipped spec\n");
    expect(r.staleness).toBeNull();
    expect(r.worktreeDiffers).toBe(false);
  });

  test("the fetch happens, and it names the remote and branch the ref does", () => {
    // Asserted on the CALL LOG, not on the content. A reader that skipped the
    // fetch returns byte-identical content from a stale local ref, so the
    // return value cannot tell the two apart — which is the whole of
    // `.claude/rules/checks-must-be-able-to-fail.md`, *green on the exit code*.
    const git = fakeGit(complete());
    resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same });

    expect(git.log, "nothing fetched, so the ref is as old as the last fetch and nobody is told").toContainEqual([
      "fetch",
      "--quiet",
      "origin",
      "main",
    ]);
  });

  test("the content is read at the RESOLVED SHA, never at the ref name", () => {
    // `git show origin/main:path` re-resolves the ref, so a fetch landing
    // between the rev-parse and the show would report one sha and return
    // another's bytes. The window is small and the failure is silent.
    const git = fakeGit(complete());
    resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same });

    const show = git.log.find(a => a[0] === "show");
    expect(show, "nothing read the content at all").toBeDefined();
    expect(show![1]).toBe(`${SHA}:${TRACKED}`);
  });

  test("a working tree that differs is reported, and the ref is still what was read", () => {
    const git = fakeGit(complete({ diff: bad("differs") }));
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same });

    expect(r.kind).toBe("ref");
    if (r.kind !== "ref") return;
    expect(r.worktreeDiffers).toBe(true);
    expect(r.content, "a differing working tree changed WHICH bytes were returned").toBe("# the shipped spec\n");
    expect(describeSpecSource(r)).toContain("DIFFERS");
  });
});

describe("D3: a failure is never a working-tree read", () => {
  test("an unresolvable ref is UNMEASURED, and the reason names the ref", () => {
    const git = fakeGit(complete({ "rev-parse": bad("unknown revision") }));
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same });

    expect(r.kind).toBe("unmeasured");
    if (r.kind !== "unmeasured") return;
    expect(r.why).toContain("origin/main");
    expect(r.why).toContain("unknown revision");
  });

  test("a tracked path the ref has not got is UNMEASURED, not an unplaced spec", () => {
    // The two render identically downstream and mean opposite things: a spec
    // added on this branch has no criteria ON MAIN, so reading the working
    // tree reports a conformant board for a spec nobody can see.
    const git = fakeGit(complete({ show: bad("path does not exist in 'origin/main'") }));
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same });

    expect(r.kind).toBe("unmeasured");
    if (r.kind !== "unmeasured") return;
    expect(r.why).toContain(TRACKED);
  });

  test("NO arm of this function ever returns the working tree's bytes on a failure", () => {
    // The sweep, not one more case. Each row breaks a different git call; the
    // prediction is MEMBERSHIP — every one of them must come back `unmeasured`
    // — rather than a count, because a reader that fell back would return
    // `ref` with disk content and the count of non-`ref` answers would be the
    // same shape as a reader that refused.
    const breaks: { what: string; answers: Partial<Record<string, GitRun>> }[] = [
      { what: "rev-parse refuses", answers: { "rev-parse": bad("no") } },
      { what: "rev-parse returns nothing", answers: { "rev-parse": ok("  \n") } },
      { what: "show refuses", answers: { show: bad("no") } },
    ];

    const got = breaks.map(b => {
      const git = fakeGit(complete(b.answers));
      return { what: b.what, kind: resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same }).kind };
    });

    expect(
      got.filter(g => g.kind !== "unmeasured"),
      "a broken git call produced a reading instead of a refusal — that is the working-tree fallback",
    ).toEqual([]);
  });

  test("a FAILED FETCH is not a refusal — it is a stale ref, said out loud", () => {
    // The opposite error. An offline machine has a usable origin/main from
    // its last fetch, and refusing there makes the command unrunnable for a
    // reason that has nothing to do with the reading.
    const git = fakeGit(complete({ fetch: bad("Could not resolve host: github.com") }));
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same });

    expect(r.kind).toBe("ref");
    if (r.kind !== "ref") return;
    expect(r.staleness).toContain("Could not resolve host");
    expect(describeSpecSource(r)).toContain("Could not resolve host");
  });
});

describe("D3: untracked is a third answer, not a failure and not a pass", () => {
  test("an untracked path says so by name, and costs no fetch", () => {
    const git = fakeGit(complete({ "ls-files": bad("did not match any file(s) known to git") }));
    const r = resolveSpecSource({ root: "/r", absPath: "/tmp/plant/SPEC.md", git: git.run, realpath: same });

    expect(r.kind).toBe("untracked");
    if (r.kind !== "untracked") return;
    expect(r.why).toContain("/tmp/plant/SPEC.md");
    expect(
      git.log.filter(a => a[0] === "fetch"),
      "an untracked path reached the network, so a fetch failure could masquerade as untracked",
    ).toEqual([]);
  });

  test("ls-files succeeding with empty output is ALSO untracked", () => {
    // `--error-unmatch` is supposed to make this impossible. It is checked
    // anyway because the alternative is a `path` of `""` and a `show` of
    // `<sha>:`, which git answers with the whole tree listing.
    const git = fakeGit(complete({ "ls-files": ok("\n") }));
    expect(resolveSpecSource({ root: "/r", absPath: "/r/x.md", git: git.run, realpath: same }).kind).toBe("untracked");
  });

  test("describeSpecSource names the arm in every case, so silence never means origin/main", () => {
    const arms = [
      resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: fakeGit(complete()).run, realpath: same }),
      resolveSpecSource({ root: "/r", absPath: "/x", git: fakeGit(complete({ "ls-files": bad("no") })).run , realpath: same }),
      resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: fakeGit(complete({ "rev-parse": bad("no") })).run , realpath: same }),
    ];
    expect(arms.map(a => a.kind)).toEqual(["ref", "untracked", "unmeasured"]);
    for (const a of arms) expect(describeSpecSource(a).trim().length, `${a.kind} described as nothing`).toBeGreaterThan(20);
  });
});

// ── Security review of PR #1896, round 1 ───────────────────────────────
//
// Two findings, both real, both instances of a shape this module's own
// docblock claims to refuse. Neither battery above could see them: every
// untracked row asserted on an exit-1 shape, so no count could come back
// wrong about an exit 128, and no row put a credential in any stderr.
describe("round 1: a broken reader is not an untracked file", () => {
  test("`ls-files` exiting 128 is UNMEASURED — a broken object store, not an answer", () => {
    // Exit 1 means git looked and the path is not there. Exit 128 means git
    // could not look. Reading them as one hands the second a working-tree
    // read, which is the defect this module exists to prevent, reached
    // through a side door.
    const git = fakeGit(complete({ "ls-files": bad("fatal: not a git repository", 128) }));
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same });

    expect(r.kind, "a broken ls-files produced a reading from disk").toBe("unmeasured");
    if (r.kind !== "unmeasured") return;
    expect(r.why).toContain("128");
  });

  test("`ls-files` exiting 1 is still untracked — the fix did not swallow the real answer", () => {
    // The control for the row above. Without it, "128 refuses" is satisfied
    // by a reader that refuses on every non-zero exit, which would make
    // every planted fixture in `test/board-snapshot.test.ts` UNMEASURED.
    const git = fakeGit(complete({ "ls-files": bad("did not match any file(s) known to git", 1) }));
    expect(resolveSpecSource({ root: "/r", absPath: "/r/x.md", git: git.run, realpath: same }).kind).toBe("untracked");
  });

  test("a `git` that never ran is UNMEASURED, never untracked", () => {
    // `status: null` from spawnSync — no git on PATH. A reader that cannot
    // run has not discovered anything about a file.
    //
    // **BOTH probes answer `null`**, because a git that is not on PATH
    // cannot answer one of them. With only the first set, this case passed
    // through the round-2 arm instead — `--git-dir` came back ok, so the
    // reading was UNMEASURED for the right reason by the wrong route, and
    // deleting the null guard changed nothing. The mutation battery is the
    // only thing that could have seen that.
    const git = fakeGit(complete({ "in-repo": bad("spawn git ENOENT", null), "git-dir": bad("spawn git ENOENT", null) }));
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same });

    expect(r.kind, "an absent git reported a file as untracked and read disk").toBe("unmeasured");
  });

  test("a directory that is not a work tree IS untracked — disk is the only copy there", () => {
    // And the reason is quoted rather than asserted: exit 128 covers both
    // "no repository" and "broken repository", and a text matcher deciding
    // which is a detector narrower than what it detects.
    const git = fakeGit(complete({ "in-repo": bad(NO_REPO, 128), "git-dir": bad(NO_REPO, 128) }));
    const r = resolveSpecSource({ root: "/tmp/plant", absPath: "/tmp/plant/SPEC.md", git: git.run, realpath: same });

    expect(r.kind).toBe("untracked");
    if (r.kind !== "untracked") return;
    expect(r.why).toContain("128");
    expect(r.why).toContain("not a git repository");
  });

  test("the repository probe runs BEFORE anything reaches the network", () => {
    const git = fakeGit(complete({ "in-repo": bad(NO_REPO, 128), "git-dir": bad(NO_REPO, 128) }));
    resolveSpecSource({ root: "/tmp/plant", absPath: "/tmp/plant/SPEC.md", git: git.run, realpath: same });
    expect(git.log.filter(a => a[0] === "fetch"), "a non-repository reached the network").toEqual([]);
  });
});

describe("round 1: a credential never reaches a log line", () => {
  // ASSEMBLED, never written as a literal. A real `ghp_…` in the tree is
  // refused by this repository's secret scanner, and rightly so — a scanner
  // that learns to ignore test fixtures is a scanner that misses the first
  // real one. `PREFIX` is also what the redactor matches on, so spelling it
  // in halves keeps the fixture and the pattern honestly independent.
  const PREFIX = `gh${"p"}_`;
  const FAKE_TOKEN = `${PREFIX}${"A".repeat(36)}`;
  const TOKEN_URL = `https://x-access-token:${FAKE_TOKEN}@github.com/o/n`;

  test("a failed fetch quoting a tokenised remote is redacted in `staleness`", () => {
    // This is not hypothetical: `actions/checkout` configures exactly this
    // remote by default, and `git fetch` quotes the URL when it fails. The
    // text was interpolated into `staleness` and printed by
    // `scripts/board-conformance.ts`, so a fetch failure on a runner put a
    // live token in the build log.
    const git = fakeGit(complete({ fetch: bad(`fatal: unable to access '${TOKEN_URL}/': 403`) }));
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same });

    expect(r.kind).toBe("ref");
    if (r.kind !== "ref") return;
    expect(r.staleness, "the token survived into staleness").not.toContain(PREFIX);
    expect(r.staleness, "the userinfo survived into staleness").not.toContain("x-access-token:");
    expect(describeSpecSource(r), "the token survived into the printed line").not.toContain(PREFIX);
    // And it still SAYS something — a redactor that returned "" would pass
    // every assertion above while deleting the reason.
    expect(r.staleness).toContain("403");
  });

  test("EVERY git output this module interpolates is redacted — stdout too, not only stderr", () => {
    // Membership, predicted: every call whose output reaches a string.
    // A per-arm fix guarantees the next arm leaks, which is the N-site shape
    // in `.claude/rules/checks-must-be-able-to-fail.md`.
    //
    // **The last row is the one round 3 found, and it is why this row list
    // used to be wrong rather than short.** Every row above it varies the
    // same axis — a failing call's STDERR — so no count this battery
    // produced could come back wrong about an arm that quotes stdout. The
    // `--git-dir` arm does, and `GIT_DIR` is a string somebody else chose.
    // Named shape: *a battery that varies one axis while the defect sits on
    // the other*.
    const leak = `fatal: unable to access '${TOKEN_URL}/'`;
    const arms: { call: string; answers: Record<string, GitRun> }[] = [
      { call: "in-repo", answers: { "in-repo": bad(leak, 128) } },
      { call: "ls-files", answers: { "ls-files": bad(leak, 128) } },
      { call: "fetch", answers: { fetch: bad(leak) } },
      { call: "rev-parse", answers: { "rev-parse": bad(leak) } },
      { call: "show", answers: { show: bad(leak) } },
      {
        call: "git-dir (stdout)",
        answers: { "in-repo": bad("fatal: this operation must be run in a work tree", 128), "git-dir": ok(`${TOKEN_URL}/.git\n`) },
      },
    ];

    const leaked = arms
      .map(a => ({
        call: a.call,
        text: describeSpecSource(resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: fakeGit(complete(a.answers)).run, realpath: same })),
      }))
      .filter(x => x.text.includes(PREFIX) || x.text.includes("x-access-token:"))
      .map(x => x.call);

    expect(leaked, "a credential reached the printed line from these calls").toEqual([]);
  });

  test("redactCredentials keeps the message and drops only the secret", () => {
    const got = redactCredentials(`unable to access '${TOKEN_URL}/': 403 Forbidden`);
    expect(got).toContain("403 Forbidden");
    expect(got).toContain("github.com/o/n");
    expect(got).not.toContain(PREFIX);
    expect(got).toContain("***");
  });

  test("redactCredentials leaves ordinary text byte-identical", () => {
    // The control. A redactor that mangled every message would satisfy every
    // "does not contain" assertion above and destroy the diagnostics.
    const plain = "fatal: path 'specs/SPEC.md' does not exist in 'origin/main'";
    expect(redactCredentials(plain)).toBe(plain);
  });
});

describe("round 1: outside the work tree is a PATH fact, decided before git", () => {
  test("a spec outside the toplevel is untracked, and `ls-files` is never asked", () => {
    // `ls-files --error-unmatch` exits 128 for a path outside the work tree
    // AND for a broken object store. Deciding containment here is what lets
    // 128 mean exactly one thing when it does arrive — the alternative is
    // matching `is outside repository` in stderr, which a locale or a git
    // release can narrow without anybody noticing.
    const git = fakeGit(complete());
    const r = resolveSpecSource({ root: "/r", absPath: "/tmp/plant/SPEC.md", git: git.run, realpath: same });

    expect(r.kind).toBe("untracked");
    if (r.kind !== "untracked") return;
    expect(r.why).toContain("outside the work tree");
    expect(
      git.log.filter(a => a[0] === "ls-files"),
      "a path outside the tree was handed to ls-files, where its 128 is indistinguishable from a broken store",
    ).toEqual([]);
  });

  test("a path INSIDE the toplevel still reaches ls-files — the check did not swallow everything", () => {
    // The control. Without it, "outside is untracked" is satisfied by a
    // containment test that says no to every path, which would make every
    // real reading untracked and the whole module a no-op.
    const git = fakeGit(complete());
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same });

    expect(r.kind).toBe("ref");
    expect(git.log.filter(a => a[0] === "ls-files").length).toBe(1);
  });

  test("a prefix that is not a path boundary is OUTSIDE — /rogue is not inside /r", () => {
    // `startsWith("/r")` is true for `/rogue/SPEC.md`. The separator is the
    // whole of the check, and without this row the battery holds every
    // input on the same side of it.
    const git = fakeGit(complete());
    expect(resolveSpecSource({ root: "/r", absPath: "/rogue/SPEC.md", git: git.run, realpath: same }).kind).toBe("untracked");
  });

  test("the toplevel ITSELF is inside it, so a repository-root spec is not excluded", () => {
    const git = fakeGit(complete({ "in-repo": ok(`/r/${TRACKED}\n`) }));
    expect(resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same }).kind).toBe("ref");
  });

});

// ── Security review of PR #1896, round 2 ───────────────────────────────
//
// Two more, and both are the SAME shape as round 1 one level up: an
// outcome that is really two outcomes, resolved toward reading the working
// tree. Round 1 fixed it for `ls-files`; these fix it for the repository
// probe and for the containment test.
describe("round 2: the repository probe has three answers too", () => {
  test("`--show-toplevel` exiting 0 with NOTHING is UNMEASURED — an answer nobody can read", () => {
    // It used to return untracked, and a case in this file asserted that
    // wrong answer. git succeeded and said something this reader cannot
    // interpret; that is not "there is no repository".
    const git = fakeGit(complete({ "in-repo": ok("  \n") }));
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same });

    expect(r.kind, "an uninterpretable answer was read as a directory without a repository").toBe("unmeasured");
    if (r.kind !== "unmeasured") return;
    expect(r.why).toContain("printed nothing");
  });

  test("a repository whose WORK TREE cannot be located is UNMEASURED, not untracked", () => {
    // A bare repository, or a `.git` the process cannot read.
    // `--show-toplevel` fails and `--git-dir` succeeds, and that pair is
    // the whole signal: there IS a repository, so disk is not the only copy
    // and reading it would be the fallback this module refuses.
    const git = fakeGit(
      complete({ "in-repo": bad("fatal: this operation must be run in a work tree", 128), "git-dir": ok("/r/.git\n") }),
    );
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same });

    expect(r.kind).toBe("unmeasured");
    if (r.kind !== "unmeasured") return;
    expect(r.why).toContain("IS a git repository");
  });

  test("BOTH probes failing is untracked — the ordinary planted fixture, and it must still work", () => {
    // The control for the row above. Without it, "a failed toplevel is
    // unmeasured" is satisfied by refusing every non-repository, which
    // turns all 64 cases in test/board-snapshot.test.ts UNMEASURED. The
    // exit codes are the ones a real git prints: measured in a plain temp
    // directory, both are 128.
    const git = fakeGit(complete({ "in-repo": bad(NO_REPO, 128), "git-dir": bad(NO_REPO, 128) }));
    const r = resolveSpecSource({ root: "/t", absPath: "/t/SPEC.md", git: git.run, realpath: same });

    expect(r.kind).toBe("untracked");
    if (r.kind !== "untracked") return;
    expect(r.why, "the line does not say that BOTH probes were asked").toContain("--git-dir");
  });

  test("the second probe is asked ONLY when the first failed", () => {
    const git = fakeGit(complete());
    resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same });
    expect(
      git.log.filter(a => a[1] === "--git-dir"),
      "a healthy repository paid for a probe whose answer it cannot use",
    ).toEqual([]);
  });
});

describe("round 2: containment is canonicalised, because a lexical compare has a differential", () => {
  // On darwin `/tmp` IS `/private/tmp`. A lexical compare calls a path
  // genuinely inside the work tree "outside", and the error falls toward
  // reading the working tree — the direction that matters.
  const symlinked: RealPath = p => (p === "/tmp" || p.startsWith("/tmp/") ? `/private${p}` : p);

  test("a spec reached through a symlinked path is INSIDE, and is read from the ref", () => {
    const git = fakeGit(complete({ "in-repo": ok("/tmp/r\n"), "ls-files": ok(`${TRACKED}\n`) }));
    const r = resolveSpecSource({ root: "/tmp/r", absPath: `/private/tmp/r/${TRACKED}`, git: git.run, realpath: symlinked });

    expect(r.kind, "a symlinked but genuinely-inside path was read from disk").toBe("ref");
  });

  test("the lexical compare WOULD have called it outside — the differential is real, not theoretical", () => {
    // The control that makes the case above mean something. Same inputs,
    // an identity realpath: the paths disagree textually and the reading
    // falls to disk. If this ever goes green, the case above is passing
    // for a reason other than canonicalisation.
    const git = fakeGit(complete({ "in-repo": ok("/tmp/r\n") }));
    const r = resolveSpecSource({ root: "/tmp/r", absPath: `/private/tmp/r/${TRACKED}`, git: git.run, realpath: same });

    expect(r.kind).toBe("untracked");
  });

  test("a path that is genuinely outside stays outside after canonicalisation", () => {
    const git = fakeGit(complete({ "in-repo": ok("/tmp/r\n") }));
    const r = resolveSpecSource({ root: "/tmp/r", absPath: "/private/tmp/elsewhere/SPEC.md", git: git.run, realpath: symlinked });

    expect(r.kind).toBe("untracked");
  });

  test("an unresolvable directory is UNMEASURED — never guessed in either direction", () => {
    // Guessing outside reads the working tree; guessing inside reads a ref
    // for a file somewhere else. Both are readings nobody took.
    const git = fakeGit(complete());
    const r = resolveSpecSource({
      root: "/r",
      absPath: `/r/${TRACKED}`,
      git: git.run,
      realpath: p => (p === "/r" ? "/r" : null),
    });

    expect(r.kind).toBe("unmeasured");
    if (r.kind !== "unmeasured") return;
    expect(r.why).toContain("could not be resolved to a real path");
  });

  test("the spec file itself need not EXIST — only the directory holding it is resolved", () => {
    // `realpathSync` on a file that is not there throws, and a spec being
    // added in this very commit is the ordinary case. The basename is
    // re-attached after the directory is canonicalised.
    const seen: string[] = [];
    const git = fakeGit(complete());
    const r = resolveSpecSource({
      root: "/r",
      absPath: `/r/${TRACKED}`,
      git: git.run,
      realpath: p => {
        seen.push(p);
        return p;
      },
    });

    expect(r.kind).toBe("ref");
    expect(seen, "realpath was handed the FILE, which throws for one that does not exist yet").not.toContain(
      `/r/${TRACKED}`,
    );
  });
});
