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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  issueFromBranch,
  issuesWithPushedBranch,
  issuesWithUncommittedWork,
  localCommitsFor,
  openPullRequestReading,
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

  /**
   * ai-review round 1 of #1974. The first cut took any digits preceded by
   * `-` or `/`, so `username-patch-1` — what GitHub's web editor names a
   * branch — resolved to issue #1.
   *
   * Checking the live refs made it a count rather than a hypothesis:
   * `rg/adr-011-plan` resolved to **#11** and a dozen `rg/b2-*` branches
   * were one naming convention away from the same thing. A commit on an
   * ADR branch reporting an unrelated issue as WORKING hides neglect on
   * that issue, which is the direction this module exists to protect.
   */
  test("a digit that is not an issue number is refused, by position", () => {
    const notIssues = [
      "jason-patch-1", // GitHub's web editor
      "patch-2",
      "jason/patch-1",
      "rg/adr-011-plan", // live in this checkout
      "rg/adr011-measure", // live in this checkout
      "rg/b2-criterion-coverage", // live in this checkout
      "rg/a7-resolve-adrs", // live in this checkout
      "worktree-agent-a82622b50baca5118",
    ];
    const wrong = notIssues
      .map(b => [b, issueFromBranch(b)] as const)
      .filter(([, n]) => n !== null);
    expect(
      wrong,
      "a branch that does not name an issue was attributed to one. Crediting an issue with " +
        "somebody else's commits reports it WORKING and hides real neglect — worse than " +
        "leaving a commit unattributed",
    ).toEqual([]);
  });

  test("the positional rule still accepts every shape this repo writes", () => {
    // The negative control for the case above: a rule that refuses
    // everything would pass it. These must still resolve.
    expect(
      ["rg/1944-local-work", "fix/1087-x", "rungate/run-1931", "rg/1931", "1944-local-work"].map(
        issueFromBranch,
      ),
    ).toEqual([1944, 1087, 1931, 1931, 1944]);
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

  /**
   * ai-review round 1 of #1974. This field is read from GitHub rather than
   * from the disk, and it was the one shipped breaking the module's own
   * rule: the caller passed `declared.has(n)` even when a pull request's
   * closing-issue page had been truncated, so an issue beyond the cut fed
   * `workVerdict` a `false` nobody had measured and could come back PARKED
   * with a live pull request open on it.
   */
  test("a truncated closing-issue page makes ABSENCE null, but keeps presence true", () => {
    const declared = new Set([1931]);

    // Nothing truncated: absence is a real reading.
    expect(openPullRequestReading(declared, [], 1931)).toBe(true);
    expect(openPullRequestReading(declared, [], 1944)).toBe(false);

    // One page cut off. The issue we SAW is still seen — truncation cannot
    // un-declare it — and the one we did not see is now unmeasured.
    expect(
      openPullRequestReading(declared, [1972], 1931),
      "a declaration already read must survive a truncated page, or the reading gets " +
        "strictly worse when more data arrives",
    ).toBe(true);
    expect(
      openPullRequestReading(declared, [1972], 1944),
      "an issue absent from a TRUNCATED page reported false. It may be on the page nobody " +
        "fetched, and false here is what sends a live claim to PARKED",
    ).toBeNull();
  });

  /**
   * ai-review round 2 of #1974. The positional rule closed
   * `username-patch-1` and `adr-011-plan`, and it still reads ANY leading
   * digit run: `release/2026-11-10-snapshot` is 2026 and `2-factor-auth`
   * is 2. The reviewer's point is that this repository's issue numbers are
   * in the thousands and climbing, so a date stamp will eventually land on
   * a live issue.
   *
   * It is not hypothetical today either: `rg/2620-tick` exists in this
   * checkout and the highest issue in the repository is #1973.
   *
   * The fix is not a better regex. "Is this a real issue" is a fact about
   * the tracker, which the caller holds and this module cannot read.
   */
  test("a branch naming an issue that does not exist is unattributed, not credited", () => {
    const commits = [
      { sha: "a", branch: "rg/1944-local-work" },
      { sha: "b", branch: "rg/2620-tick" }, // live here; #2620 does not exist
      { sha: "c", branch: "release/2026-11-10-snapshot" },
      { sha: "d", branch: "2-factor-auth" },
    ];
    const known = new Set([1944, 1973]);
    const w = tallyLocalWork(commits, null, known);

    expect(localCommitsFor(w, 1944)).toBe(true);
    for (const ghost of [2620, 2026, 2]) {
      expect(
        localCommitsFor(w, ghost),
        `#${ghost} was credited with work from a branch that merely starts with that number`,
      ).toBe(false);
    }
    expect(
      [...w.unattributed.keys()].sort(),
      "a branch with real unpushed commits and no matching issue must be NAMED, not dropped — " +
        "it is work nothing will attribute and somebody should see it",
    ).toEqual(["2-factor-auth", "release/2026-11-10-snapshot", "rg/2620-tick"]);
  });

  /**
   * ai-review round 3 of #1974, and the finding is my failure to sweep.
   * Round 2 put the `knownIssues` guard on `tallyLocalWork` and I fixed
   * the one site the reviewer named. Two siblings kept crediting a number
   * read from a name: `origin/2-factor-auth` made issue #2 read WORKING,
   * and a dirty worktree on such a branch did the same.
   *
   * Repairing them one at a time is what produced the second round. So
   * this asserts the PROPERTY over the population: every function in
   * `lib/local-work.ts` that calls `issueFromBranch` must take a
   * `knownIssues` parameter. A fourth attribution site added later is red
   * until it does, rather than waiting for a reviewer to notice.
   */
  test("every attribution site takes the issue list — all of them, not the named one", () => {
    const src = readFileSync(join(import.meta.dir, "..", "lib/local-work.ts"), "utf-8");
    // Each exported function, sliced from its own declaration to the next.
    // Name-then-slice rather than one signature regex: a regex over
    // parameter lists has to model multi-line signatures and return types,
    // and the first cut of this guard failed on exactly that — reporting
    // zero attribution sites, which reads as "all clear".
    const names = [...src.matchAll(/^export function (\w+)/gm)].map(m => m[1]!);
    expect(names.length, "no exported functions were found, so this holds vacuously").toBeGreaterThanOrEqual(
      6,
    );
    const sliceOf = (name: string) => {
      const at = src.indexOf(`export function ${name}(`);
      const next = src.indexOf("\nexport ", at + 1);
      return src.slice(at, next === -1 ? src.length : next);
    };
    const attributing = names
      .filter(n => n !== "issueFromBranch")
      .filter(n => sliceOf(n).includes("issueFromBranch("));
    expect(
      [...attributing].sort(),
      "the set of functions that resolve a branch name to an issue changed. Every one of " +
        "them must be checked below, so add it here deliberately",
    ).toEqual(["issuesWithPushedBranch", "issuesWithUncommittedWork", "tallyLocalWork"]);

    const unguarded = attributing.filter(n => !sliceOf(n).includes("knownIssues"));
    expect(
      unguarded,
      "a function resolves a branch name to an issue without taking the tracker's issue " +
        "list. A name is not a fact: origin/2-factor-auth reads as issue #2 and reports it " +
        "WORKING, which hides real neglect on it",
    ).toEqual([]);
  });

  test("the siblings refuse a ghost issue the same way the tally does", () => {
    const known = new Set([1944]);
    expect([...issuesWithPushedBranch(["origin/rg/1944-x", "origin/2-factor-auth"], known)]).toEqual([
      1944,
    ]);
    const { dirty } = issuesWithUncommittedWork(
      [
        { path: "/w/a", branch: "rg/1944-x", dirty: true },
        { path: "/w/b", branch: "2-factor-auth", dirty: true },
      ],
      known,
    );
    expect([...dirty.keys()]).toEqual([1944]);

    // Negative control: with no list both still attribute by name, so the
    // assertions above are about the list and not about a blanket refusal.
    expect([...issuesWithPushedBranch(["origin/2-factor-auth"], null)]).toEqual([2]);
  });

  test("with no issue list the caller gets name-only attribution, and knows it", () => {
    // The negative control for the case above. Without it, a change that
    // unattributed EVERYTHING would pass — the set is the thing under
    // test, not the rejection.
    const commits = [{ sha: "a", branch: "rg/2620-tick" }];
    const w = tallyLocalWork(commits, null, null);
    expect(localCommitsFor(w, 2620)).toBe(true);
    expect(w.unattributed.size).toBe(0);
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

  /**
   * The battery found this one too: dropping the `knownIssues` argument
   * where `readLocalWork` hands it to the tally scored **0 fail**. Every
   * case above calls `tallyLocalWork` directly, so the RUNNER's wiring —
   * the one line that carries the issue list from the caller to the
   * decision — was covered by inspection only. The same shape as the
   * worktree `catch` two cases up, found the same way.
   */
  test("the runner carries the issue list through to the attribution", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-1944-known-"));
    const repo = join(root, "repo");
    const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" });
    try {
      mkdirSync(repo);
      execFileSync("git", ["init", "-q", "-b", "main", repo], { encoding: "utf-8" });
      git(["config", "user.email", "t@example.invalid"]);
      git(["config", "user.name", "t"]);
      writeFileSync(join(repo, "a.txt"), "one");
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "one"]);
      // Two branches, one commit each. No remote exists, so every commit
      // is unpushed by construction — which is the state the walk looks for.
      for (const [branch, file] of [
        ["rg/4242-real", "b.txt"],
        ["rg/999999-ghost", "c.txt"],
      ]) {
        git(["checkout", "-q", "-b", branch!, "main"]);
        writeFileSync(join(repo, file!), branch!);
        git(["add", "-A"]);
        git(["commit", "-q", "-m", branch!]);
      }

      const w = readLocalWork(repo, new Set([4242]));
      expect(w.unmeasured, "the fixture walk did not run").toBeNull();
      expect(localCommitsFor(w, 4242)).toBe(true);
      expect(
        localCommitsFor(w, 999999),
        "the runner credited an issue that the caller's list does not contain, so the list " +
          "it was handed never reached the decision",
      ).toBe(false);
      expect([...w.unattributed.keys()]).toEqual(["rg/999999-ghost"]);
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
