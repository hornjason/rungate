/**
 * #1944: work that exists on this machine and on no pushed ref.
 *
 * The property under test throughout is the asymmetry in
 * `lib/local-work.ts`: a reading that was not taken must produce `null`,
 * never `false`. `false` releases somebody's claim. The live instance the
 * issue was filed on — #1931's commit `3bd05a14`, committed in a worktree
 * and never pushed — is the positive case; the negative cases are all the
 * ways the reading can fail to happen.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  issueFromBranch,
  issuesWithPushedBranch,
  issuesWithUncommittedWork,
  localCommitsFor,
  parseUnpushed,
  readLocalWork,
  readPushedBranches,
  readWorktreeStates,
  tallyLocalWork,
  UNPUSHED_ARGS,
  type WorktreeState,
} from "../lib/local-work";

describe("#1944: the branch a commit is on names the issue it is work for", () => {
  test("the shapes this repository actually writes", () => {
    expect(issueFromBranch("rg/1944-local-work")).toBe(1944);
    expect(issueFromBranch("fix/1087-adjudicated-notice")).toBe(1087);
    expect(issueFromBranch("rungate/run-1931")).toBe(1931);
    expect(issueFromBranch("rg/1931")).toBe(1931);
  });

  test("a branch covering two issues is attributed to the first, not both", () => {
    // `fix/640-644-run-branch-base` is live in this checkout. Attributing
    // it to both would let one commit count as work on an issue nobody has
    // touched — a WORKING verdict manufactured out of a naming convention.
    expect(issueFromBranch("fix/640-644-run-branch-base")).toBe(640);
  });

  test("a name with no number is null, not a guess", () => {
    for (const b of ["main", "scratch", "jason/experiments", "release"]) {
      expect(issueFromBranch(b), `${b} should not resolve to an issue`).toBeNull();
    }
  });
});

describe("#1944: an unread reading is null, and null is never false", () => {
  test("no local commits, MEASURED, releases — and the same tally UNMEASURED does not", () => {
    const measured = tallyLocalWork([], null);
    const unmeasured = tallyLocalWork([], "UNMEASURED — the walk did not run");

    // Identical `byIssue` (both empty). The ONLY difference is whether
    // anybody looked, and that difference must reach the caller.
    expect(measured.byIssue.size).toBe(0);
    expect(unmeasured.byIssue.size).toBe(0);

    expect(localCommitsFor(measured, 1931)).toBe(false);
    expect(
      localCommitsFor(unmeasured, 1931),
      "an unmeasured walk reported FALSE — that is the reading that releases somebody's " +
        "claim, taken from a command nobody ran",
    ).toBeNull();
  });

  test("a found commit is true, and stays true per issue", () => {
    const w = tallyLocalWork([
      { sha: "3bd05a14", branch: "rungate/run-1931" },
      { sha: "aaaa1111", branch: "rg/1944-local-work" },
      { sha: "bbbb2222", branch: "rg/1944-local-work" },
    ]);
    expect(localCommitsFor(w, 1931)).toBe(true);
    expect(localCommitsFor(w, 1944)).toBe(true);
    expect(w.byIssue.get(1944)).toBe(2);
    // An issue nobody has a branch for is measured-and-empty, not unknown.
    expect(localCommitsFor(w, 9999)).toBe(false);
  });

  test("UNMEASURED wins over a non-empty tally", () => {
    // The direction that matters: a PARTIAL reading must not be reported as
    // a complete one just because it found something. A walk that failed
    // halfway is not evidence about the issues it never reached.
    const w = tallyLocalWork([{ sha: "a", branch: "rg/1931-x" }], "UNMEASURED — git died");
    expect(localCommitsFor(w, 1931)).toBeNull();
    expect(localCommitsFor(w, 1944)).toBeNull();
  });
});

describe("#1944: parsing the one-command walk", () => {
  test("the command asks git to attribute each commit to a branch", () => {
    // `--source` is the whole reason this is one command and not 258. A
    // change that drops it still runs, still parses, and silently
    // attributes every commit to nothing.
    expect(UNPUSHED_ARGS).toContain("--source");
    expect(UNPUSHED_ARGS).toContain("--format=%H%x09%S");
    expect(UNPUSHED_ARGS).toContain("--not");
    expect(UNPUSHED_ARGS).toContain("--remotes");
  });

  test("real output parses, and malformed rows are skipped rather than throwing", () => {
    const rows = parseUnpushed(
      [
        "571ce11d6ef32f6fc0119274a6ecb2a4bd9ddeeb\trg/1469-push-trigger",
        "", // blank line, as git emits at the end
        "no-tab-here",
        "\tbranch-with-no-sha",
        // Whitespace-only fields, which the leading `tab <= 0` test cannot
        // catch — the tab is there and in a real position. The battery
        // found this: removing the emptiness guard reddened nothing until
        // these two rows existed, because every other malformed row was
        // already being stopped one line earlier.
        "   \tbranch-with-blank-sha",
        "ccccdddd\t   ",
        "d0e0e6ff1def2c0ee549d3771bb9168c7e1204cd\trg/1120-bashwriteguard",
      ].join("\n"),
    );
    expect(rows.map(r => r.branch)).toEqual(["rg/1469-push-trigger", "rg/1120-bashwriteguard"]);
  });

  test("an empty walk parses to nothing — and that is MEASURED", () => {
    // The case a fail-open would hide: git succeeded and found nothing.
    const w = tallyLocalWork(parseUnpushed(""));
    expect(w.unmeasured).toBeNull();
    expect(localCommitsFor(w, 1931)).toBe(false);
  });
});

describe("#1944: the other two evidence fields", () => {
  test("a pushed branch names its issue, and origin/HEAD is not an issue", () => {
    const s = issuesWithPushedBranch([
      "origin/rg/1944-local-work",
      "origin/HEAD",
      "origin/main",
      "origin/fix/1087-adjudicated-notice",
    ]);
    expect([...s].sort((a, b) => a - b)).toEqual([1087, 1944]);
  });

  test("a worktree whose status could not be read is unread, NOT clean", () => {
    const states: WorktreeState[] = [
      { path: "/w/1931", branch: "rungate/run-1931", dirty: true },
      { path: "/w/1944", branch: "rg/1944-local-work", dirty: false },
      { path: "/w/gone", branch: "rg/1700-x", dirty: null },
    ];
    const { dirty, unread } = issuesWithUncommittedWork(states);
    expect([...dirty.keys()]).toEqual([1931]);
    expect(
      unread,
      "a worktree that would not report a status must be named, not silently counted clean",
    ).toEqual(["/w/gone"]);
    // The unreadable one must NOT appear as having no uncommitted work.
    expect(dirty.has(1700)).toBe(false);
  });

  test("a detached worktree has no branch, so it is attributed to no issue", () => {
    const { dirty, unread } = issuesWithUncommittedWork([
      { path: "/w/detached", branch: null, dirty: true },
    ]);
    expect(dirty.size).toBe(0);
    expect(unread).toEqual([]);
  });
});

describe("#1944: the readers refuse rather than report an empty reading", () => {
  test("a directory that is not a repository is UNMEASURED, and says where", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-1944-notarepo-"));
    try {
      writeFileSync(join(dir, "a.txt"), "not a repo");
      const w = readLocalWork(dir);
      expect(
        w.unmeasured,
        "a non-repository produced a MEASURED empty reading, which releases every claim",
      ).not.toBeNull();
      expect(w.unmeasured).toContain(dir);
      expect(localCommitsFor(w, 1931)).toBeNull();

      // The sibling readers take the same direction on the same input.
      expect(readPushedBranches(dir)).toBeNull();
      const states = readWorktreeStates(dir);
      expect(states, "the worktree list must refuse outside a repository").toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The mutation battery found this gap rather than my reading the code.
   * Changing `dirty = null` to `dirty = false` in `readWorktreeStates`'s
   * per-worktree catch reddened NOTHING: every case above plants a
   * `dirty: null` and hands it to the pure tally, so the branch that
   * PRODUCES one was covered by inspection only. A `catch` that turns "I
   * could not look" into "it is clean" is the fail-open shape in
   * `.claude/rules/checks-must-be-able-to-fail.md`, and it was one `sed`
   * away from shipping unobserved.
   *
   * So this builds the real thing: a repository, a linked worktree, and
   * then the worktree's directory deleted out from under its
   * registration — which is exactly how the live instance on this machine
   * arose, not a hypothetical.
   */
  test("a worktree whose directory is gone comes back UNREAD from the runner itself", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-1944-wt-"));
    const repo = join(root, "repo");
    const linked = join(root, "linked");
    const git = (args: string[], cwd: string) =>
      execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
    try {
      mkdirSync(repo);
      execFileSync("git", ["init", "-q", "-b", "main", repo], { encoding: "utf-8" });
      git(["config", "user.email", "t@example.invalid"], repo);
      git(["config", "user.name", "t"], repo);
      writeFileSync(join(repo, "a.txt"), "one");
      git(["add", "-A"], repo);
      git(["commit", "-q", "-m", "one"], repo);
      git(["worktree", "add", "-q", "-b", "rg/4242-gone", linked], repo);

      // Measured first: both worktrees report, nothing is unread. Without
      // this the assertion below cannot tell a working instrument from a
      // broken one.
      const before = readWorktreeStates(repo);
      expect(before, "the fixture repository would not list its worktrees").not.toBeNull();
      expect(before!.length).toBe(2);
      expect(
        before!.filter(s => s.dirty === null),
        "nothing should be unread before the directory is removed",
      ).toEqual([]);

      // Now the event: the directory goes, the registration stays.
      rmSync(linked, { recursive: true, force: true });

      const after = readWorktreeStates(repo);
      expect(after).not.toBeNull();
      const unreadable = after!.filter(s => s.dirty === null);
      expect(
        unreadable.length,
        "a worktree whose directory is gone reported a dirty/clean reading. Nobody looked — " +
          "it cannot be clean, and reporting it clean is what releases a claim on work that " +
          "may still exist elsewhere",
      ).toBe(1);

      // And it must travel as unread all the way through the tally.
      const { dirty, unread } = issuesWithUncommittedWork(after!);
      expect(unread.length).toBe(1);
      expect(dirty.has(4242)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("against this repository the walk is MEASURED, so the refusal above is not the only path", () => {
    // Without this, every case in the block above passes for a tree where
    // the reader is simply broken — the vacuous shape. This asserts the
    // instrument works on a real checkout.
    const w = readLocalWork(join(import.meta.dir, ".."));
    expect(
      w.unmeasured,
      "the walk could not run against this checkout, so the refusal cases prove nothing",
    ).toBeNull();
    expect(readPushedBranches(join(import.meta.dir, ".."))).not.toBeNull();
    expect(readWorktreeStates(join(import.meta.dir, ".."))).not.toBeNull();
  });
});
