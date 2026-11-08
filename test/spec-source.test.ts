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
import { DEFAULT_SPEC_REF, describeSpecSource, resolveSpecSource, type GitRun } from "../lib/spec-source";

const ok = (stdout: string): GitRun => ({ ok: true, stdout, stderr: "" });
const bad = (stderr: string): GitRun => ({ ok: false, stdout: "", stderr });

/**
 * A git whose answers are keyed by the FIRST argument.
 *
 * Keyed rather than sequenced: a sequence breaks whenever the implementation
 * reorders two calls, which is a refactor rather than a regression, and a
 * broken sequence reads as a refusal on the merits.
 */
const fakeGit = (answers: Record<string, GitRun>, log: string[][] = []) => {
  const run = (args: readonly string[]): GitRun => {
    log.push([...args]);
    return answers[args[0]!] ?? bad(`fake git has no answer for ${args[0]}`);
  };
  return { run, log };
};

const TRACKED = "specs/SPEC.md";
const SHA = "1234567890abcdef1234567890abcdef12345678";

const complete = (over: Partial<Record<string, GitRun>> = {}) => ({
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
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run });

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
    resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run });

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
    resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run });

    const show = git.log.find(a => a[0] === "show");
    expect(show, "nothing read the content at all").toBeDefined();
    expect(show![1]).toBe(`${SHA}:${TRACKED}`);
  });

  test("a working tree that differs is reported, and the ref is still what was read", () => {
    const git = fakeGit(complete({ diff: bad("differs") }));
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run });

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
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run });

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
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run });

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
      return { what: b.what, kind: resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run }).kind };
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
    const r = resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: git.run });

    expect(r.kind).toBe("ref");
    if (r.kind !== "ref") return;
    expect(r.staleness).toContain("Could not resolve host");
    expect(describeSpecSource(r)).toContain("Could not resolve host");
  });
});

describe("D3: untracked is a third answer, not a failure and not a pass", () => {
  test("an untracked path says so by name, and costs no fetch", () => {
    const git = fakeGit(complete({ "ls-files": bad("did not match any file(s) known to git") }));
    const r = resolveSpecSource({ root: "/r", absPath: "/tmp/plant/SPEC.md", git: git.run });

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
    expect(resolveSpecSource({ root: "/r", absPath: "/r/x.md", git: git.run }).kind).toBe("untracked");
  });

  test("describeSpecSource names the arm in every case, so silence never means origin/main", () => {
    const arms = [
      resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: fakeGit(complete()).run }),
      resolveSpecSource({ root: "/r", absPath: "/x", git: fakeGit(complete({ "ls-files": bad("no") })).run }),
      resolveSpecSource({ root: "/r", absPath: `/r/${TRACKED}`, git: fakeGit(complete({ "rev-parse": bad("no") })).run }),
    ];
    expect(arms.map(a => a.kind)).toEqual(["ref", "untracked", "unmeasured"]);
    for (const a of arms) expect(describeSpecSource(a).trim().length, `${a.kind} described as nothing`).toBeGreaterThan(20);
  });
});
