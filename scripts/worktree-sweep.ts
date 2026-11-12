#!/usr/bin/env bun
/**
 * Remove the worktrees the census reads ABANDONED, wherever they live (#2022).
 *
 * `cleanupWorktrees` in `lib/worktree-cleanup.ts` reads one directory,
 * `<repo>/.claude/worktrees/`. Session worktrees here are cut as siblings of
 * the main checkout (`~/Projects/rg-wt-*`), so none of them was ever examined
 * and 36 accumulated. And `hooks/StaleTTLCleanup.hook.ts` skipped everything
 * when the session started outside a repository, which is where sessions here
 * usually start.
 *
 * ## What this decides: nothing
 *
 * `scripts/worktree-census.ts` is the reading and `verdictFor` is its one
 * decider — merged pull request at the exact commit held, a clean status that
 * was actually read, no process holding a file, nothing modified inside the
 * declared age, and anything unreadable is UNMEASURED rather than ABANDONED.
 * This file takes that verdict and acts on the ABANDONED rows only. It asks
 * no question of its own, so there is no second decider for a mutation of the
 * first to hide behind; `test/worktree-sweep.test.ts` asserts the verdict is
 * read in exactly one place.
 *
 * ## What it must never do
 *
 * - **No `--force`.** `git worktree remove` without it refuses a tree with
 *   modified or untracked files, so a worktree that turned dirty between the
 *   census and the removal is refused by git itself, not by a check of ours.
 * - **No `prune`.** It drops the registration of every worktree whose
 *   directory is gone, not only ours (`.claude/rules/parallel-sessions.md`).
 * - **No recursive delete.** git removes the directory or nothing does.
 *
 * Usage:
 *   bun scripts/worktree-sweep.ts [--under <dir>] [--older-than 1d]
 *
 * `--under` is the launch directory: the repository it is inside, or, when it
 * is inside none, each primary checkout directly under it that has a linked
 * worktree. stdout carries one line per repository that had something to
 * report; the session-start hook appends it to the stale-cleanup log.
 */

import { execFileSync, spawn } from "child_process";
import { closeSync, existsSync, lstatSync, openSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { gitIsolatedArgs, gitIsolatedEnv } from "../lib/git-isolation";
import {
  census,
  couldNotRead,
  parseDuration,
  parseWorktreeList,
  readLsof,
  readPullRequests,
  readWorktreeList,
  type CensusResult,
  type Measured,
  type PullRequest,
} from "./worktree-census";

/** The one place this script runs `git`, isolated the way the census is. */
function sweepGit(args: readonly string[]): string {
  return execFileSync("git", gitIsolatedArgs(args), {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: gitIsolatedEnv(),
  }).trim();
}

/** The paths the census read ABANDONED. The verdict is read here and nowhere else. */
export function sweepTargets(result: CensusResult): string[] {
  return result.rows.filter(row => row.verdict === "ABANDONED").map(row => row.path);
}

export interface RemoveOutcome {
  removed: string[];
  refused: Array<{ path: string; why: string }>;
}

/** `git worktree remove` for each path, never forced, so git's own refusal stands. */
export function removeWorktrees(repo: string, paths: readonly string[]): RemoveOutcome {
  const out: RemoveOutcome = { removed: [], refused: [] };
  for (const path of paths) {
    try {
      sweepGit(["-C", repo, "worktree", "remove", path]);
      out.removed.push(path);
    } catch (e) {
      const why = String((e as { stderr?: string }).stderr || (e as Error).message || "")
        .split("\n").filter(Boolean)[0] ?? "git refused";
      out.refused.push({ path, why });
    }
  }
  return out;
}

export interface SweepOptions {
  olderThanMs: number;
  nowMs: number;
  maxEntries: number;
  pulls: Measured<PullRequest[]>;
  lsof: Measured<string>;
}

export function sweepRepo(repo: string, opts: SweepOptions): { census: CensusResult; outcome: RemoveOutcome } {
  const records = parseWorktreeList(readWorktreeList(repo));
  const result = census(records, { repo, ...opts });
  return { census: result, outcome: removeWorktrees(repo, sweepTargets(result)) };
}

/** The main checkout of the repository `dir` is inside, or null when it is inside none. */
function mainCheckoutOf(dir: string): string | null {
  try {
    const common = sweepGit(["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return common ? dirname(common) : null;
  } catch {
    return null;
  }
}

function hasLinkedWorktree(repo: string): boolean {
  try {
    return parseWorktreeList(readWorktreeList(repo)).length > 1;
  } catch {
    return false;
  }
}

/**
 * Which repositories a launch directory sweeps.
 *
 * Inside a repository: its main checkout, reached from a linked worktree too.
 * Outside any: each child whose `.git` is a DIRECTORY — a primary checkout,
 * not a linked worktree, whose `.git` is a file — and that has a linked
 * worktree, so a repository with nothing to sweep costs no `gh` call.
 */
export function reposToSweep(launchDir: string): string[] {
  const inside = mainCheckoutOf(launchDir);
  if (inside) return [inside];
  let children: string[];
  try {
    children = readdirSync(launchDir);
  } catch {
    return [];
  }
  const repos: string[] = [];
  for (const name of children.sort()) {
    const dir = join(launchDir, name);
    const dotGit = join(dir, ".git");
    try {
      if (!existsSync(dotGit) || !lstatSync(dotGit).isDirectory()) continue;
    } catch {
      continue;
    }
    if (hasLinkedWorktree(dir)) repos.push(dir);
  }
  return repos;
}

/** `owner/name` from a GitHub remote URL, or null for anything else. */
export function originSlug(url: string): string | null {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

function pullsFor(repo: string): Measured<PullRequest[]> {
  let url = "";
  try {
    url = sweepGit(["-C", repo, "remote", "get-url", "origin"]);
  } catch {
    return couldNotRead<PullRequest[]>("no origin remote, so no pull request can be asked about");
  }
  const slug = originSlug(url);
  if (!slug) return couldNotRead<PullRequest[]>(`origin ${url} is not a GitHub remote`);
  return readPullRequests(slug);
}

/**
 * Start a sweep in the background and return at once.
 *
 * Detached so SessionStart never waits on `gh` and `lsof`; its output is
 * appended to `logPath`, the stale-cleanup log the hook already writes.
 *
 * The launch directory is read HERE, not passed by the hook:
 * `test/unit/worktree-cleanup-merge.test.ts` holds the hook to one
 * `process.cwd()`, the one that seeds `repoRootFrom` (#68).
 */
export function spawnSweep(logPath: string, launchDir: string = process.cwd()): void {
  const fd = openSync(logPath, "a");
  try {
    spawn(process.execPath, [import.meta.path, "--under", launchDir], {
      cwd: launchDir,
      detached: true,
      stdio: ["ignore", fd, fd],
    }).unref();
  } finally {
    closeSync(fd);
  }
}

export function main(argv: string[]): number {
  let under = process.cwd();
  let olderThanMs = parseDuration("1d");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--under" && argv[i + 1]) under = argv[++i];
    else if (argv[i] === "--older-than" && argv[i + 1]) olderThanMs = parseDuration(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  const lsof = readLsof();
  const stamp = new Date().toISOString();
  let removed = 0;
  for (const repo of reposToSweep(under)) {
    try {
      const { census: c, outcome } = sweepRepo(repo, {
        olderThanMs, nowMs: Date.now(), maxEntries: 20000, pulls: pullsFor(repo), lsof,
      });
      removed += outcome.removed.length;
      const unmeasured = c.counts.unmeasured;
      if (outcome.removed.length || outcome.refused.length || unmeasured) {
        process.stdout.write(
          `${stamp} WORKTREE sweep [${repo}]: removed ${outcome.removed.length}` +
            (outcome.removed.length ? ` (${outcome.removed.join(", ")})` : "") +
            `, refused ${outcome.refused.length}` +
            outcome.refused.map(r => ` [${r.path}: ${r.why}]`).join("") +
            `, ${unmeasured} UNMEASURED of ${c.counts.total}\n`,
        );
      }
    } catch (e) {
      process.stdout.write(`${stamp} WORKTREE sweep [${repo}] error: ${String((e as Error).message).split("\n")[0]}\n`);
    }
  }
  return removed;
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`worktree-sweep: ${(e as Error).message}\n`);
    process.exitCode = 2;
  }
}
