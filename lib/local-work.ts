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
   * Branches whose leading number is not an issue that exists.
   *
   * ai-review round 2 of #1974. `issueFromBranch` is a reading of a NAME,
   * and a name is not a fact about the tracker: `release/2026-11-10-x`
   * reads as 2026 and `2-factor-auth` as 2. This checkout already carries
   * `rg/2620-tick`, and the highest issue in the repository is #1973.
   *
   * Reported rather than silently dropped. A commit on one of these is
   * real local work that nothing will now attribute, and that is a thing
   * somebody should see rather than a tidy empty result.
   *
   * Empty when the caller passed no issue list — see `tallyLocalWork`.
   */
  readonly unattributed: ReadonlyMap<string, number>;
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
 *
 * ## The number must OPEN the final segment, or follow `run-`
 *
 * The first cut took any digits preceded by `-` or `/`, and ai-review
 * round 1 of #1974 found the shape that breaks: GitHub's web editor makes
 * `username-patch-1`, which would have been attributed to issue #1.
 *
 * Checking the live refs turned that from a hypothetical into a count.
 * This repository already carries `rg/adr-011-plan`, `rg/adr011-measure`
 * and a dozen `rg/b2-*` branches — `adr-011-plan` would have been read as
 * **issue #11**. A commit on somebody's ADR branch would have reported an
 * unrelated issue as WORKING, which hides genuine neglect: exactly the
 * direction this module is supposed to protect.
 *
 * So the rule is positional rather than a blocklist. Either the number
 * opens the last `/`-separated segment (`rg/1944-x`, `fix/640-644-x`,
 * `rg/1931`), or the segment is `run-<n>` (`rungate/run-1931`). Nothing
 * else counts, and a shape nobody anticipated costs an unattributed
 * commit rather than a wrong attribution — the direction a wrong answer
 * is cheapest in.
 */
export function issueFromBranch(branch: string): number | null {
  const segment = branch.slice(branch.lastIndexOf("/") + 1);
  const m = segment.match(/^(?:run-)?(\d{1,6})(?:-|$)/);
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

/**
 * Tally parsed commits by branch and by issue. Pure.
 *
 * `knownIssues` is the tracker's own answer to "is this a real issue", and
 * when it is supplied a branch whose number is not in it lands in
 * `unattributed` instead of `byIssue`. `issueFromBranch` can only read a
 * NAME; whether that name corresponds to anything is a fact the caller
 * holds and this module does not. ai-review round 2 of #1974, after
 * `rg/2620-tick` was found live against a tracker whose highest issue is
 * #1973.
 *
 * `null` keeps the name-only behaviour, for a caller with no issue list.
 * That is looser and it is the caller's declaration that it has nothing
 * better — not a default this module picks.
 */
export function tallyLocalWork(
  commits: readonly UnpushedCommit[],
  unmeasured: string | null = null,
  knownIssues: ReadonlySet<number> | null = null,
): LocalWork {
  const byBranch = new Map<string, number>();
  const byIssue = new Map<number, number>();
  const unattributed = new Map<string, number>();
  for (const c of commits) {
    byBranch.set(c.branch, (byBranch.get(c.branch) ?? 0) + 1);
    const issue = issueFromBranch(c.branch);
    if (issue === null) continue;
    if (knownIssues !== null && !knownIssues.has(issue)) {
      unattributed.set(c.branch, (unattributed.get(c.branch) ?? 0) + 1);
      continue;
    }
    byIssue.set(issue, (byIssue.get(issue) ?? 0) + 1);
  }
  return { byBranch, byIssue, unattributed, unmeasured };
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
export function issuesWithPushedBranch(
  refs: readonly string[],
  knownIssues: ReadonlySet<number> | null = null,
): Set<number> {
  const out = new Set<number>();
  for (const ref of refs) {
    // `origin/rg/1944-x` → strip the remote, then read the issue.
    const branch = ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
    if (branch === "HEAD") continue;
    const issue = issueFromBranch(branch);
    if (issue === null) continue;
    // ai-review round 3 of #1974. Round 2 put this guard on
    // `tallyLocalWork` and I did not sweep for the siblings — this
    // function and `issuesWithUncommittedWork` kept crediting a number
    // read from a name. `origin/2-factor-auth` made issue #2 read
    // WORKING, which is the direction that hides neglect.
    if (knownIssues !== null && !knownIssues.has(issue)) continue;
    out.add(issue);
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

export function issuesWithUncommittedWork(
  states: readonly WorktreeState[],
  knownIssues: ReadonlySet<number> | null = null,
): {
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
    if (issue === null) continue;
    // The third attribution site, and the second one round 2 missed.
    if (knownIssues !== null && !knownIssues.has(issue)) continue;
    if (!dirty.has(issue)) dirty.set(issue, s.path);
  }
  return { dirty, unread };
}

/**
 * Does an open pull request DECLARE it closes this issue?
 *
 * The third evidence field, and the only one read from GitHub rather than
 * from the local disk — so it is the one that was shipped breaking this
 * module's own rule. ai-review round 1 of #1974: the caller passed
 * `declared.has(n)`, a plain boolean, even when a pull request's
 * `closingIssuesReferences` page had been truncated.
 *
 * The asymmetry is the whole function:
 *
 * - **`true` survives truncation.** A pull request that did declare it
 *   closes this is a fact no cut-off page takes back.
 * - **Absence does not.** An issue beyond the cut never reached the set,
 *   and `false` would feed `workVerdict` a reading nobody took — the
 *   issue could come back PARKED with a live pull request open on it.
 *
 * It lives here rather than inline in the script so there is one place to
 * mutate and a behavioural case can observe it. A ternary in a top-level
 * script that performs network calls on import is reachable only by
 * reading the source.
 */
/**
 * The issues a pull request declares it closes **in one repository**.
 *
 * ai-review round 5 of #1974. `closingIssuesReferences` resolves GitHub's
 * closing keywords, and those match across repositories: `Fixes
 * other-org/other-repo#1944` produces a node numbered 1944 that has
 * nothing to do with this tracker. Taking `.number` alone made a pull
 * request here mark the local #1944 WORKING on the strength of somebody
 * else's issue.
 *
 * Checked against the live tracker before fixing: of the open pull
 * requests today exactly one declares a closing reference and it is
 * same-repo, so this is a real mechanism that is not currently firing —
 * worth saying, because "found a bug" and "found a bug that is happening"
 * are different claims.
 *
 * Same shape as the `knownIssues` guard above, one level out: a number is
 * not an identity until something says which tracker it belongs to.
 */
export function declaredClosingIn(
  nodes: readonly { readonly number: number; readonly repository?: { readonly nameWithOwner?: string } }[],
  repoNameWithOwner: string,
): number[] {
  return nodes
    .filter(n => n.repository?.nameWithOwner === repoNameWithOwner)
    .map(n => n.number);
}

export function openPullRequestReading(
  declared: ReadonlySet<number>,
  truncatedPRs: readonly number[],
  issue: number,
): boolean | null {
  if (declared.has(issue)) return true;
  return truncatedPRs.length > 0 ? null : false;
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
export function readLocalWork(
  repoRoot: string,
  knownIssues: ReadonlySet<number> | null = null,
): LocalWork {
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
  return tallyLocalWork(parseUnpushed(stdout), null, knownIssues);
}

/** One `for-each-ref`. Returns `null` when it could not be run. */
export function readPushedBranches(
  repoRoot: string,
  knownIssues: ReadonlySet<number> | null = null,
): Set<number> | null {
  try {
    const out = execFileSync(
      "git",
      ["-C", repoRoot, "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"],
      { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
    );
    return issuesWithPushedBranch(
      out.split("\n").filter(l => l.trim() !== ""),
      knownIssues,
    );
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
