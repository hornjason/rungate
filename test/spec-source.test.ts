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
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DEFAULT_SPEC_REF,
  describeSpecSource,
  redactCredentials,
  splitRef,
  resolveSpecSource,
  type GitRun,
  type GitRunner,
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
  // `cat-file -e` is the trackedness question, and round 3 moved it here
  // from `ls-files`: the first asks the REF, the second asks the local
  // index, and they disagree for a spec shipped after this checkout was
  // cut. `ls-files` is still answered — it separates "added on this
  // branch" from "git never heard of it" once the ref has already said no.
  "ls-tree": ok("blob\u0000"),
  // The default is a repository that HAS its remote. Round 4 made that the
  // deciding fact when `origin/main` will not resolve: a missing remote can
  // never resolve and is honestly untracked, while a present one that does
  // not resolve is a reading nobody took.
  remote: ok("git@github.com:o/n.git\n"),
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
      "+main:refs/remotes/origin/main",
    ]);
  });

  test("the fetch names an explicit DESTINATION, not just a branch", () => {
    // Round 9. `git fetch origin main` writes `refs/remotes/origin/main`
    // only when the remote's configured `remote.<name>.fetch` refspec
    // happens to match — which `actions/checkout` makes false, because it
    // configures a narrow refspec naming just the PR branch. The real-git
    // case below is the one that can actually catch this; this one pins
    // the string so a refactor cannot quietly drop the destination.
    const git = fakeGit(complete());
    resolveSpecSource({
      root: "/r",
      absPath: `/r/${TRACKED}`,
      ref: "upstream/release/7.x",
      git: git.run,
      realpath: same,
    });

    const fetches = git.log.filter(a => a[0] === "fetch");
    expect(fetches).toEqual([
      ["fetch", "--quiet", "upstream", "+release/7.x:refs/remotes/upstream/release/7.x"],
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

  test("the path read from the ref is DERIVED, so a disagreeing `ls-files` cannot redirect it", () => {
    // `ls-files --full-name` used to supply the repository-relative path as
    // a side effect of answering a question about the local index. Round 3
    // took the question away from it; this asserts the path went too. The
    // fake answers `ls-files` with a DIFFERENT path, and the read must still
    // be taken against the one derived from the work tree.
    const git = fakeGit(complete({ "ls-files": ok("some/other/FILE.md\n") }));
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same });

    expect(r.kind).toBe("ref");
    if (r.kind !== "ref") return;
    expect(r.path).toBe(TRACKED);
    expect(git.log.find(a => a[0] === "show")?.[1]).toBe(`${SHA}:${TRACKED}`);
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
    //
    // Round 3 moved `ls-files` behind the ref, so reaching it at all now
    // needs the ref to have already said no — `cat-file -e` exiting 1.
    const git = fakeGit(complete({ "ls-tree": ok(""), "ls-files": bad("fatal: not a git repository", 128) }));
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same });

    expect(r.kind, "a broken ls-files produced a reading from disk").toBe("unmeasured");
    if (r.kind !== "unmeasured") return;
    expect(r.why).toContain("128");
  });

  test("`ls-files` exiting 1 is still untracked — the fix did not swallow the real answer", () => {
    // The control for the row above. Without it, "128 refuses" is satisfied
    // by a reader that refuses on every non-zero exit, which would make
    // every planted fixture in `test/board-snapshot.test.ts` UNMEASURED.
    const git = fakeGit(complete({ "ls-tree": ok(""), "ls-files": bad("did not match any file(s) known to git", 1) }));
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

  test("a path INSIDE the toplevel still reaches the ref — the check did not swallow everything", () => {
    // The control. Without it, "outside is untracked" is satisfied by a
    // containment test that says no to every path, which would make every
    // real reading untracked and the whole module a no-op.
    const git = fakeGit(complete());
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same });

    expect(r.kind).toBe("ref");
    expect(git.log.filter(a => a[0] === "ls-tree").length).toBe(1);
  });

  test("a prefix that is not a path boundary is OUTSIDE — /rogue is not inside /r", () => {
    // `startsWith("/r")` is true for `/rogue/SPEC.md`. The separator is the
    // whole of the check, and without this row the battery holds every
    // input on the same side of it.
    const git = fakeGit(complete());
    expect(resolveSpecSource({ root: "/r", absPath: "/rogue/SPEC.md", git: git.run, realpath: same }).kind).toBe("untracked");
  });

  test("the path that IS the work tree is UNMEASURED — a spec is a file, and the read is refused", () => {
    // The containment check lets `real === canonTop` through, because the
    // boundary belongs to the inside. Round 3 made the repository-relative
    // path DERIVED rather than read out of `ls-files --full-name`, and
    // `relative(x, x)` is `""` — which would have become `git show <sha>:`,
    // the whole tree listing, printed as a spec. It refuses instead.
    const git = fakeGit(complete({ "in-repo": ok(`/r/${TRACKED}\n`) }));
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same });

    expect(r.kind).toBe("unmeasured");
    if (r.kind !== "unmeasured") return;
    expect(r.why).toContain("A spec is a file");
    expect(git.log.filter(a => a[0] === "show"), "a tree listing was fetched as a spec").toEqual([]);
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

// ── Security review of PR #1896, round 3 ───────────────────────────────
//
// By count this is a fourth round, and AGENTS.md rule 5 says the third is
// where repairing stops. It did not stop here because the first finding
// below is not a repair of a prior repair: it says the feature does not do
// the thing D3 defines it as doing. Shipping that and filing a follow-up
// would tick an item on a command that reads the working tree.
describe("round 3: trackedness is a question about the REF, not about the local index", () => {
  test("a spec present at the ref and ABSENT locally is read from the ref", () => {
    // THE FINDING. `ls-files --error-unmatch` answers about the local index,
    // so a spec shipped to origin/main after this checkout was cut reads as
    // untracked — and `board-snapshot` then refuses "no such spec" while the
    // copy it was asked for sits in the ref. The module exists to stop a
    // stale tree looking like a missing feature, and this was that exact
    // confusion reached through the trackedness check.
    //
    // No existing fixture could see it: every one keyed `ls-files` to the
    // same branch state as `show`, so the suite varied one axis and the
    // defect sat on the other.
    const git = fakeGit(complete({ "ls-files": bad("did not match any file(s) known to git", 1) }));
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same });

    expect(r.kind, "a spec the ref HAS was reported untracked because this checkout lacks it").toBe("ref");
    if (r.kind !== "ref") return;
    expect(r.content).toContain("the shipped spec");
    expect(r.path).toBe(TRACKED);
  });

  test("not at the ref and tracked here is UNMEASURED — added on this branch, not yet shipped", () => {
    const git = fakeGit(complete({ "ls-tree": ok("") }));
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same });

    expect(r.kind).toBe("unmeasured");
    if (r.kind !== "unmeasured") return;
    expect(r.why).toContain("added on this branch");
  });

  test("not at the ref and not tracked here is untracked — the control for the row above", () => {
    // Without this, "not at the ref refuses" is satisfied by a reader that
    // refuses on every absent path, and every planted fixture becomes
    // UNMEASURED rather than an honest working-tree reading.
    const git = fakeGit(complete({ "ls-tree": ok(""), "ls-files": bad("no such path", 1) }));
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same });

    expect(r.kind).toBe("untracked");
    if (r.kind !== "untracked") return;
    expect(r.why, "the line does not say the REF was asked first").toContain(SHA);
  });

  test("`cat-file` failing for any reason OTHER than absence is UNMEASURED", () => {
    const git = fakeGit(complete({ "ls-tree": bad("fatal: not a tree object", 128) }));
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same });

    expect(r.kind).toBe("unmeasured");
    if (r.kind !== "unmeasured") return;
    expect(r.why).toContain("128");
  });

  test("an in-repo untracked path now COSTS a fetch, and that is the trade this made", () => {
    // Stated as an assertion rather than left in a comment. The old order
    // asked trackedness first and skipped the network for an untracked
    // path; the saved fetch was buying a wrong answer. If somebody reorders
    // these to save it again, this is what says so.
    const git = fakeGit(complete({ "ls-tree": ok(""), "ls-files": bad("no such path", 1) }));
    resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same });
    expect(git.log.filter(a => a[0] === "fetch").length).toBe(1);
  });
});

describe("round 3: `git diff --quiet` has three outcomes, and `!ok` printed two of them as DIFFERS", () => {
  test("exit 0 is same, exit 1 is differs", () => {
    const sameTree = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: fakeGit(complete({ diff: ok("") })).run, realpath: same });
    const changed = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: fakeGit(complete({ diff: bad("", 1) })).run, realpath: same });

    expect(sameTree.kind === "ref" && sameTree.worktreeDiffers).toBe(false);
    expect(changed.kind === "ref" && changed.worktreeDiffers).toBe(true);
    expect(describeSpecSource(changed)).toContain("DIFFERS");
  });

  test("any other exit is NULL, and the printed line says UNMEASURED rather than DIFFERS", () => {
    // `!differs.ok` reported a failed comparison as a confirmed difference —
    // a measured fact nobody measured. The reading is still `ref`, because
    // the CONTENT was read successfully; only the comparison was not.
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: fakeGit(complete({ diff: bad("fatal: unable to read index", 128) })).run, realpath: same });

    expect(r.kind).toBe("ref");
    if (r.kind !== "ref") return;
    expect(r.worktreeDiffers).toBeNull();
    const line = describeSpecSource(r);
    expect(line, "a comparison that never happened printed as a difference").not.toContain("copy DIFFERS");
    expect(line).toContain("UNMEASURED");
    expect(line).toContain("128");
  });
});

// Round 3 widened the unresolvable-ref arm with the LOCAL INDEX, after a
// real-repository fixture showed that refusing outright turned every
// checkout with no `origin/main` into a refusal. The widening was wrong and
// round 4 replaced it — the cases live in the round-4 block below, where
// the deciding fact is whether the REMOTE exists. Kept as a note rather
// than deleted: the fixture that forced the widening is still right that an
// outright refusal is too narrow, and the next person to narrow it will hit
// the same fixture.

// ── Security review of PR #1896, round 4 ───────────────────────────────
//
// Round 3 shipped `atRef.code !== 1` over `git cat-file -e`, and the suite
// stayed green because the fake answered `1` — a code real git does not
// return for an absent path. Every case above runs against a fake, and a
// fake that encodes semantics git does not have is a suite measuring
// nothing. These cases run the REAL binary once and pin what it does, so
// the next person changing an exit code in `complete()` has something that
// disagrees with them.
describe("round 4: the fake's exit codes are pinned to what real git does", () => {
  const realGit = (cwd: string): GitRunner => args => {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
    return { ok: r.status === 0, code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };

  const plant = (): { dir: string; sha: string } => {
    const dir = mkdtempSync(join(tmpdir(), "spec-source-premise-"));
    const g = realGit(dir);
    expect(g(["init", "-q"]).ok).toBe(true);
    mkdirSync(join(dir, "specs"), { recursive: true });
    writeFileSync(join(dir, "specs", "SPEC.md"), "# shipped\n");
    expect(g(["add", "-A"]).ok).toBe(true);
    expect(g(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x"]).ok).toBe(true);
    const sha = g(["rev-parse", "HEAD"]).stdout.trim();
    return { dir, sha };
  };

  test("`cat-file -e` exits 128 for an ABSENT path, so `code !== 1` can never mean untracked", () => {
    const { dir, sha } = plant();
    try {
      const g = realGit(dir);
      expect(g(["cat-file", "-e", `${sha}:specs/SPEC.md`]).code, "a present path").toBe(0);
      // THE PIN. Round 3 assumed 1 here and the fake agreed with it.
      expect(g(["cat-file", "-e", `${sha}:nope.md`]).code, "an absent path").toBe(128);
      expect(g(["cat-file", "-e", `${sha}:specs`]).code, "a DIRECTORY also exits 0").toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("`ls-tree --format` exits 0 either way and names the type — which is why it replaced it", () => {
    const { dir, sha } = plant();
    try {
      const g = realGit(dir);
      const f = (p: string) => g(["ls-tree", "-z", "--format=%(objecttype)", sha, "--", p]);
      expect(f("specs/SPEC.md").code).toBe(0);
      expect(f("specs/SPEC.md").stdout.replace(/\0/g, "").trim()).toBe("blob");
      expect(f("specs").stdout.replace(/\0/g, "").trim(), "a directory must be distinguishable").toBe("tree");
      expect(f("nope.md").code, "absence is exit 0, not an error code").toBe(0);
      expect(f("nope.md").stdout.replace(/\0/g, "").trim(), "absence is empty output").toBe("");
      expect(f("nope.md").ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("end to end against a real repository: a committed spec is read from the ref", () => {
    // The whole module, no fake anywhere. `origin/main` is planted as a
    // local ref so nothing touches the network.
    const { dir, sha } = plant();
    try {
      const g = realGit(dir);
      expect(g(["update-ref", "refs/remotes/origin/main", sha]).ok).toBe(true);
      const r = resolveSpecSource({ root: dir, absPath: join(dir, "specs", "SPEC.md"), git: g });

      expect(r.kind, describeSpecSource(r)).toBe("ref");
      if (r.kind !== "ref") return;
      expect(r.content).toContain("shipped");
      expect(r.path).toBe("specs/SPEC.md");
      expect(r.worktreeDiffers, "a clean tree reported as differing").toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("round 9: the fetch CREATES the tracking ref under a narrow refspec", () => {
    // **The case the fixture could not contain.** Every end-to-end case
    // above plants `refs/remotes/origin/main` by hand with `update-ref`,
    // so the fetch inside `resolveSpecSource` has nothing left to do and
    // the suite never asks whether it would have worked. Here the ref does
    // NOT exist beforehand and there is a real bare upstream, so the only
    // thing that can create it is the fetch under test.
    //
    // The narrow `remote.origin.fetch` is the `actions/checkout` shape: it
    // names a PR branch, so a `git fetch origin main` with no destination
    // matches nothing, exits 0, writes only `FETCH_HEAD`, and leaves the
    // next `rev-parse origin/main` to fail on a remote the spec is
    // genuinely fetchable from.
    const up = mkdtempSync(join(tmpdir(), "spec-source-upstream-"));
    const { dir, sha } = plant();
    try {
      const g = realGit(dir);
      expect(realGit(up)(["init", "-q", "--bare", "."]).ok).toBe(true);
      expect(g(["remote", "add", "origin", up]).ok).toBe(true);
      expect(g(["push", "-q", "origin", "HEAD:refs/heads/main"]).ok).toBe(true);
      expect(
        g(["config", "remote.origin.fetch", "+refs/heads/some-pr:refs/remotes/origin/some-pr"]).ok,
      ).toBe(true);

      // `git push` updates the remote-tracking ref for what it pushed, so
      // the setup above plants the very thing under test. Deleting it is
      // the point of the case, and the assertion below is what caught the
      // first draft doing exactly what this case accuses the fixture of.
      expect(g(["update-ref", "-d", "refs/remotes/origin/main"]).ok).toBe(true);

      // The premise, asserted rather than assumed: the ref is absent, so a
      // green result below cannot come from a ref somebody else planted.
      expect(g(["rev-parse", "origin/main"]).ok, "the tracking ref already existed").toBe(false);

      const r = resolveSpecSource({ root: dir, absPath: join(dir, "specs", "SPEC.md"), git: g });

      expect(r.kind, describeSpecSource(r)).toBe("ref");
      if (r.kind !== "ref") return;
      expect(r.sha).toBe(sha);
      expect(r.content).toContain("shipped");
      expect(g(["rev-parse", "origin/main"]).stdout.trim(), "the fetch did not write the ref").toBe(sha);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(up, { recursive: true, force: true });
    }
  });

  test("end to end: a DIRECTORY is UNMEASURED, not a spec whose text is a listing", () => {
    const { dir, sha } = plant();
    try {
      const g = realGit(dir);
      expect(g(["update-ref", "refs/remotes/origin/main", sha]).ok).toBe(true);
      const r = resolveSpecSource({ root: dir, absPath: join(dir, "specs"), git: g });

      expect(r.kind).toBe("unmeasured");
      if (r.kind !== "unmeasured") return;
      expect(r.why).toContain("tree");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("round 4: an unresolvable ref fails CLOSED, and only a missing remote widens it", () => {
  test("no origin/main while the remote EXISTS is UNMEASURED, whatever the local index says", () => {
    // Round 3 read the local index here and returned untracked. That is
    // the hole this module had just closed, one arm along: a stale
    // checkout missing a newly-shipped spec is untracked locally too.
    const git = fakeGit(complete({
      "rev-parse": bad("fatal: ambiguous argument 'origin/main'", 128),
      "ls-files": bad("no such path", 1),
      remote: ok("git@github.com:o/n.git\n"),
    }));
    expect(resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same }).kind).toBe("unmeasured");
  });

  test("no such remote at all IS untracked — nothing will ever resolve there", () => {
    const git = fakeGit(complete({
      "rev-parse": bad("fatal: ambiguous argument 'origin/main'", 128),
      remote: bad("error: No such remote 'origin'", 2),
    }));
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same });

    expect(r.kind).toBe("untracked");
    if (r.kind !== "untracked") return;
    expect(r.why).toContain("no remote named");
  });

  test("a remote probe that never RAN is UNMEASURED — absence of an answer is not an answer", () => {
    const git = fakeGit(complete({
      "rev-parse": bad("fatal: ambiguous argument 'origin/main'", 128),
      remote: bad("spawn git ENOENT", null),
    }));
    expect(resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same }).kind).toBe("unmeasured");
  });
});

describe("round 4: the remote probe asks about the REMOTE, not about a flag", () => {
  test("the probe names the remote the ref names", () => {
    // The fake keys its answers on the SUBCOMMAND and never looked at the
    // operand, so `git remote get-url --quiet` — the remote read back out
    // of the fetch argv at the wrong index — was answered as if it had
    // asked about `origin`. Every unresolvable ref then fell through to a
    // working-tree read, which is the fail-open this arm exists to
    // prevent, and the whole suite stayed green. The argv is asserted
    // here because no answer-keyed fake can assert it for us.
    const git = fakeGit(complete({ "rev-parse": bad("fatal: ambiguous argument", 128) }));
    resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same });

    const probe = git.log.find(a => a[0] === "remote");
    expect(probe, "the remote was never probed at all").toBeDefined();
    expect(probe).toEqual(["remote", "get-url", "origin"]);
  });

  test("splitRef is the one place a ref becomes a remote and a branch", () => {
    expect(splitRef("origin/main")).toEqual({ remote: "origin", branch: "main" });
    expect(splitRef("upstream/release/7.x")).toEqual({ remote: "upstream", branch: "release/7.x" });
    expect(splitRef("main"), "a bare branch names no remote").toBeNull();
    expect(splitRef("/main")).toBeNull();
    expect(splitRef("origin/")).toBeNull();
  });

  test("a ref naming no remote is UNMEASURED when it will not resolve — nothing to probe", () => {
    const git = fakeGit(complete({ "rev-parse": bad("fatal: ambiguous argument", 128) }));
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, ref: "main", git: git.run, realpath: same });
    expect(r.kind).toBe("unmeasured");
  });
});

// ── Security review of PR #1896, round 5 ───────────────────────────────
//
// A git pathspec is resolved against the PROCESS's cwd, and `LIVE_GIT`
// runs `-C root`. When `root` is a subdirectory of the work tree top — the
// case the containment logic above exists to support — a root-relative
// pathspec matches nothing from there, and neither of the two calls that
// use one says so by failing. They both exit 0.
describe("round 5: a pathspec is resolved against cwd, and cwd is `root`", () => {
  const realGit = (cwd: string): GitRunner => args => {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
    return { ok: r.status === 0, code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };

  test("`ls-tree` without --full-tree reports a PRESENT blob as absent, with exit 0", () => {
    // The pin. Exit 0 and empty output is the same pair this module reads
    // as "the ref has not got it", so without the flag a nested `root`
    // falls straight through to a working-tree read.
    const dir = mkdtempSync(join(tmpdir(), "spec-source-cwd-"));
    try {
      const g = realGit(dir);
      expect(g(["init", "-q"]).ok).toBe(true);
      mkdirSync(join(dir, "nested"), { recursive: true });
      writeFileSync(join(dir, "SPEC.md"), "# shipped\n");
      writeFileSync(join(dir, "nested", "keep.txt"), "x\n");
      expect(g(["add", "-A"]).ok).toBe(true);
      expect(g(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x"]).ok).toBe(true);
      const sha = g(["rev-parse", "HEAD"]).stdout.trim();

      const fromNested = realGit(join(dir, "nested"));
      const without = fromNested(["ls-tree", "-z", "--format=%(objecttype)", sha, "--", "SPEC.md"]);
      expect(without.code, "it does not fail — that is the whole problem").toBe(0);
      expect(without.stdout.replace(/\0/g, "").trim(), "a present blob read as absent").toBe("");

      const withFlag = fromNested(["ls-tree", "-z", "--full-tree", "--format=%(objecttype)", sha, "--", "SPEC.md"]);
      expect(withFlag.stdout.replace(/\0/g, "").trim()).toBe("blob");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("end to end: a `root` BELOW the work tree top still reads the spec from the ref", () => {
    // The behavioural case for both fixes at once. `root` is the nested
    // directory; the spec sits at the top. Before round 5 this read the
    // working tree.
    const dir = mkdtempSync(join(tmpdir(), "spec-source-nested-"));
    try {
      const g = realGit(dir);
      expect(g(["init", "-q"]).ok).toBe(true);
      mkdirSync(join(dir, "nested"), { recursive: true });
      writeFileSync(join(dir, "SPEC.md"), "# shipped\n");
      writeFileSync(join(dir, "nested", "keep.txt"), "x\n");
      expect(g(["add", "-A"]).ok).toBe(true);
      expect(g(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x"]).ok).toBe(true);
      expect(g(["update-ref", "refs/remotes/origin/main", "HEAD"]).ok).toBe(true);

      const r = resolveSpecSource({
        root: join(dir, "nested"),
        absPath: join(dir, "SPEC.md"),
        git: realGit(join(dir, "nested")),
      });

      expect(r.kind, describeSpecSource(r)).toBe("ref");
      if (r.kind !== "ref") return;
      expect(r.content).toContain("shipped");
      expect(r.worktreeDiffers, "the comparison ran against nothing and said `same`").toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("end to end from a nested root: an EDITED working tree is still seen as differing", () => {
    // The control for the row above. `worktreeDiffers: false` there is
    // only meaningful if this one comes back true — a pathspec matching
    // nothing exits 0 and reports `false` for every input, which would
    // satisfy the previous case while measuring nothing.
    const dir = mkdtempSync(join(tmpdir(), "spec-source-nested-diff-"));
    try {
      const g = realGit(dir);
      expect(g(["init", "-q"]).ok).toBe(true);
      mkdirSync(join(dir, "nested"), { recursive: true });
      writeFileSync(join(dir, "SPEC.md"), "# shipped\n");
      expect(g(["add", "-A"]).ok).toBe(true);
      expect(g(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x"]).ok).toBe(true);
      expect(g(["update-ref", "refs/remotes/origin/main", "HEAD"]).ok).toBe(true);
      writeFileSync(join(dir, "SPEC.md"), "# shipped, then edited locally\n");

      const r = resolveSpecSource({
        root: join(dir, "nested"),
        absPath: join(dir, "SPEC.md"),
        git: realGit(join(dir, "nested")),
      });

      expect(r.kind, describeSpecSource(r)).toBe("ref");
      if (r.kind !== "ref") return;
      expect(r.content, "the REF's bytes, not the edited ones").toBe("# shipped\n");
      expect(r.worktreeDiffers, "an edited tree reported as matching").toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Security review of PR #1896, round 6 ───────────────────────────────
describe("round 6: only the exit code git uses for a missing remote means a missing remote", () => {
  test("a malformed config is UNMEASURED, not `there is no remote`", () => {
    // Round 5 accepted every non-null non-zero here, so git failing to
    // read `.git/config` was indistinguishable from a remote that is not
    // configured — and the second one permits a working-tree read.
    const git = fakeGit(complete({
      "rev-parse": bad("fatal: ambiguous argument", 128),
      remote: bad("fatal: bad config line 3 in file .git/config", 128),
    }));
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same });

    expect(r.kind).toBe("unmeasured");
    if (r.kind !== "unmeasured") return;
    expect(r.why).toContain("128");
  });

  test("exit 2 is still the missing remote — the control", () => {
    const git = fakeGit(complete({
      "rev-parse": bad("fatal: ambiguous argument", 128),
      remote: bad("error: No such remote 'origin'", 2),
    }));
    expect(resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run, realpath: same }).kind).toBe("untracked");
  });

  test("real git: `remote get-url` exits 2 for a missing remote and 0 for a present one", () => {
    // The pin. Round 4's fake asserted a code nobody had measured, which
    // is the same mistake `cat-file -e` cost a whole round.
    const dir = mkdtempSync(join(tmpdir(), "spec-source-remote-"));
    try {
      const g = (args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
      expect(g(["init", "-q"]).status).toBe(0);
      expect(g(["remote", "get-url", "nosuch"]).status, "a missing remote").toBe(2);
      expect(g(["remote", "add", "origin", "git@github.com:o/n.git"]).status).toBe(0);
      expect(g(["remote", "get-url", "origin"]).status, "a present remote").toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("round 6: a pathspec is a glob, and `<rev>:<path>` is not", () => {
  // **A CHARACTERISATION CASE, NOT A PROOF — and labelled, because the
  // difference matters.** Round 6 reported that `ls-tree -- 'a[b].md'`
  // reads `[b]` as a character class while `git show <sha>:a[b].md` is
  // literal, so the two disagree and the disagreement resolves toward a
  // working-tree read. It does not reproduce: measured, git tries an
  // EXACT match before it globs, and `ls-tree -- 'SPEC[draft].md'`
  // returns `blob SPEC[draft].md` with and without the `:(literal)`
  // prefix. Two battery rows were written to redden this case by removing
  // the prefix and BOTH reddened nothing.
  //
  // The prefix stays — it costs nothing and closes the class — but it is
  // hardening rather than a fix, and this case pins today's behaviour
  // rather than catching a defect. Saying so is the point:
  // `.claude/rules/checks-must-be-able-to-fail.md` is about not letting a
  // case that cannot fail pass for one that can.
  test("end to end: a spec whose NAME holds pathspec metacharacters is read from the ref", () => {
    const dir = mkdtempSync(join(tmpdir(), "spec-source-glob-"));
    const name = "SPEC[draft].md";
    try {
      const g: GitRunner = args => {
        const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
        return { ok: r.status === 0, code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      };
      expect(g(["init", "-q"]).ok).toBe(true);
      writeFileSync(join(dir, name), "# shipped\n");
      expect(g(["add", "-A"]).ok).toBe(true);
      expect(g(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x"]).ok).toBe(true);
      expect(g(["update-ref", "refs/remotes/origin/main", "HEAD"]).ok).toBe(true);

      const r = resolveSpecSource({ root: dir, absPath: join(dir, name), git: g });

      expect(r.kind, describeSpecSource(r)).toBe("ref");
      if (r.kind !== "ref") return;
      expect(r.content).toContain("shipped");
      expect(r.worktreeDiffers, "the diff pathspec globbed and matched nothing").toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
