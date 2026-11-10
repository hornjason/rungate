/**
 * Work that exists on this machine and on no pushed ref.
 *
 * #1944. Every GitHub reading this repository takes — the board, the lane
 * health, the stale sweep, `work-status` — answers "is somebody working on
 * this" from things GitHub can see. A commit sitting in a worktree answers
 * it too, and no query can reach one. The live instance, 2026-11-09:
 * #1931's only work was commit `3bd05a14`, committed in `rg-wt-1931` and
 * never pushed. Every reading reported the issue as claimed and idle. The
 * work existed and nothing could see it.
 *
 * This module is the local half. It feeds `localCommits` to `workVerdict`
 * in `lib/board-lane-health.ts`, which is the one place that decides the
 * question — see #1972. `work-status` is the first caller able to read all
 * three of its evidence fields, which is what makes its `PARKED` verdict
 * reachable at all.
 *
 * ## A reading that could not be taken is `null`, never `false`
 *
 * The whole module is built around one asymmetry. "I looked and there are
 * no local commits" releases somebody's claim. "I could not look" must
 * not. A `git` that is absent, a directory that is not a repository, a
 * command that failed — every one of those produces `unmeasured`, and
 * `localCommitsFor` then returns `null` for every issue rather than
 * `false` for all of them. Silent Default Substitution, in the direction
 * that unassigns live work.
 */

import { execFileSync } from "child_process";

/** One commit reachable from a local branch and from no remote-tracking ref. */
export interface UnpushedCommit {
  readonly sha: string;
  readonly branch: string;
}

export interface LocalWork {
  /** Issue number → commits on a local branch and on no pushed ref. */
  readonly byIssue: ReadonlyMap<number, number>;
  /** The same tally before the branch names were resolved to issues. */
  readonly byBranch: ReadonlyMap<string, number>;
  /**
   * Why the reading could not be taken, or `null` when it was taken.
   *
   * An empty `byIssue` with `unmeasured === null` means "looked, found
   * nothing". An empty `byIssue` with a reason means "did not look". Those
   * are different facts and only the first may release a claim.
   */
  readonly unmeasured: string | null;
}

/**
 * The issue a branch is for, or `null` when the name does not say.
 *
 * Takes the FIRST number in the branch name after any prefix. This repo
 * writes `rg/1944-local-work`, `fix/1087-adjudicated-notice` and
 * `rungate/run-1931`, and it also writes `fix/640-644-run-branch-base`
 * for a branch covering two issues — the first is the one the branch is
 * named for, and attributing such a branch to both would let one commit
 * count as work on an issue nobody has touched.
 *
 * A name with no number returns `null` rather than guessing. `main` and a
 * personal scratch branch are not work on an issue.
 */
export function issueFromBranch(branch: string): number | null {
  const m = branch.match(/(?:^|\/|-)(\d{1,6})(?:-|$)/);
  if (m === null) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Parse `git log --branches --not --remotes --source --format=%H\t%S`.
 *
 * `--source` is what makes this one command rather than one per branch:
 * `%S` prints the ref the commit was reached from, so attribution comes
 * out of the same walk. There are 258 local branches in this checkout and
 * a per-branch `rev-list` was the first cut.
 *
 * A malformed line is skipped rather than throwing. The caller's refusal
 * is for a command that FAILED; a single unparseable row in a successful
 * run is not evidence that the reading is untrustworthy, and throwing here
 * would convert it into one.
 */
export function parseUnpushed(stdout: string): UnpushedCommit[] {
  const out: UnpushedCommit[] = [];
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const sha = line.slice(0, tab).trim();
    const branch = line.slice(tab + 1).trim();
    if (sha === "" || branch === "") continue;
    out.push({ sha, branch });
  }
  return out;
}

/** Tally parsed commits by branch and by issue. Pure. */
export function tallyLocalWork(
  commits: readonly UnpushedCommit[],
  unmeasured: string | null = null,
): LocalWork {
  const byBranch = new Map<string, number>();
  const byIssue = new Map<number, number>();
  for (const c of commits) {
    byBranch.set(c.branch, (byBranch.get(c.branch) ?? 0) + 1);
    const issue = issueFromBranch(c.branch);
    if (issue !== null) byIssue.set(issue, (byIssue.get(issue) ?? 0) + 1);
  }
  return { byBranch, byIssue, unmeasured };
}

/**
 * Does this issue have work on this machine that no pushed ref carries?
 *
 * `null` when the reading was not taken — see the module docblock. This is
 * the function `scripts/work-status.ts` hands to `workVerdict`, and
 * returning `false` from an unmeasured reading is the one defect this
 * whole module exists to make impossible.
 */
export function localCommitsFor(work: LocalWork, issue: number): boolean | null {
  if (work.unmeasured !== null) return null;
  return (work.byIssue.get(issue) ?? 0) > 0;
}

/**
 * Issues with a branch pushed to `origin`.
 *
 * The second of `workVerdict`'s three fields, and the cheap one: a single
 * `for-each-ref` over `refs/remotes/origin` (755 refs in this checkout,
 * one command). A pushed branch is work somebody can see even with no
 * pull request open, so it is WORKING rather than INVISIBLE.
 */
export function issuesWithPushedBranch(refs: readonly string[]): Set<number> {
  const out = new Set<number>();
  for (const ref of refs) {
    // `origin/rg/1944-x` → strip the remote, then read the issue.
    const branch = ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
    if (branch === "HEAD") continue;
    const issue = issueFromBranch(branch);
    if (issue !== null) out.add(issue);
  }
  return out;
}

/**
 * Worktrees holding changes nobody has committed.
 *
 * The title of #1944 says "unmerged **and uncommitted**", and this is the
 * second half. An uncommitted change is even less visible than an unpushed
 * commit: it is not in any ref, so a `git log` walk cannot reach it and
 * losing the directory loses the work. `.claude/rules/parallel-sessions.md`
 * records two sessions that lost in-flight work this way on 2026-10-16.
 *
 * Takes the per-worktree readings rather than running them, so the
 * attribution is testable without a filesystem. A worktree whose status
 * could not be read is carried as `dirty: null` and must not be reported
 * as clean.
 */
export interface WorktreeState {
  readonly path: string;
  readonly branch: string | null;
  /** `null` is NOT READ, exactly as everywhere else in this module. */
  readonly dirty: boolean | null;
}

export function issuesWithUncommittedWork(states: readonly WorktreeState[]): {
  readonly dirty: Map<number, string>;
  readonly unread: string[];
} {
  const dirty = new Map<number, string>();
  const unread: string[] = [];
  for (const s of states) {
    if (s.dirty === null) {
      unread.push(s.path);
      continue;
    }
    if (!s.dirty || s.branch === null) continue;
    const issue = issueFromBranch(s.branch);
    if (issue !== null && !dirty.has(issue)) dirty.set(issue, s.path);
  }
  return { dirty, unread };
}

/** Exposed so a test can drive the parse without spawning git. */
export const UNPUSHED_ARGS: readonly string[] = [
  "log",
  "--branches",
  "--not",
  "--remotes",
  "--source",
  "--format=%H%x09%S",
];

/**
 * Run the reading against a checkout.
 *
 * Every failure path lands in `unmeasured` with the reason, and none of
 * them produces an empty-but-measured result. `execFileSync` throws on a
 * non-zero exit, on a missing binary, and on a directory that is not a
 * repository, and all three mean the same thing here: nobody looked.
 */
export function readLocalWork(repoRoot: string): LocalWork {
  let stdout: string;
  try {
    stdout = execFileSync("git", ["-C", repoRoot, ...UNPUSHED_ARGS], {
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    const why = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return tallyLocalWork(
      [],
      `UNMEASURED — the local commit walk did not run in ${repoRoot}: ${why}. ` +
        `No issue can be reported as having no local work on the strength of this`,
    );
  }
  return tallyLocalWork(parseUnpushed(stdout));
}

/** One `for-each-ref`. Returns `null` when it could not be run. */
export function readPushedBranches(repoRoot: string): Set<number> | null {
  try {
    const out = execFileSync(
      "git",
      ["-C", repoRoot, "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"],
      { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
    );
    return issuesWithPushedBranch(out.split("\n").filter(l => l.trim() !== ""));
  } catch {
    return null;
  }
}

/**
 * `git worktree list --porcelain`, then one `status --porcelain` each.
 *
 * 28 worktrees in this checkout, so this is 29 local commands rather than
 * the 258 a per-branch walk would cost. A status that throws is carried as
 * `dirty: null` — the worktree directory may have been deleted out from
 * under its registration, and "I could not look" is not "it is clean".
 */
export function readWorktreeStates(repoRoot: string): WorktreeState[] | null {
  let listing: string;
  try {
    listing = execFileSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], {
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  const states: WorktreeState[] = [];
  let path: string | null = null;
  let branch: string | null = null;
  const flush = () => {
    if (path === null) return;
    let dirty: boolean | null;
    try {
      const st = execFileSync("git", ["-C", path, "status", "--porcelain"], {
        encoding: "utf-8",
        maxBuffer: 32 * 1024 * 1024,
      });
      dirty = st.trim() !== "";
    } catch {
      dirty = null;
    }
    states.push({ path, branch, dirty });
    path = null;
    branch = null;
  };
  for (const line of listing.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      path = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  flush();
  return states;
}
