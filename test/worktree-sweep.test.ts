/**
 * #2022: session worktrees are cut as siblings of the main checkout
 * (`~/Projects/rg-wt-*`), and `cleanupWorktrees` only ever read
 * `<repo>/.claude/worktrees/`, so none of them was examined. 36 accumulated
 * before they were removed by hand on 2026-11-12 (dated: the day of the count).
 *
 * Covers `scripts/worktree-sweep.ts`.
 *
 * What is proved here, each with a fixture that is executed rather than
 * described:
 *
 *   - Only the census's ABANDONED verdict is ever acted on. The sweep decides
 *     nothing of its own — `verdictFor` in `scripts/worktree-census.ts` stays
 *     the one decider — and a sweep that acted on every row would remove the
 *     worktree with an open pull request in the end-to-end case below.
 *   - Removal is `git worktree remove` with no `--force`, so git itself
 *     refuses a tree that turned dirty after the census read it. The dirty
 *     case is planted for real and the directory must survive.
 *   - Repositories are found from the launch directory whether or not it is
 *     inside one, because sessions here usually start in `~/Projects`, which
 *     is not, and the hook used to skip everything in that case.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { couldNotRead, took, type CensusResult, type PullRequest } from "../scripts/worktree-census";
import {
  originSlug,
  removeWorktrees,
  reposToSweep,
  sweepRepo,
  sweepTargets,
} from "../scripts/worktree-sweep";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "worktree-sweep.ts");
const HOOK = join(ROOT, "hooks", "StaleTTLCleanup.hook.ts");
const scratch: string[] = [];

afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();

const commit = (cwd: string, msg: string) =>
  git(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", msg);

/** Comments stripped, so the bans below read what the code does, not what it explains. */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** A primary checkout with two sibling worktrees, all inside one scratch dir. */
function repoWithSiblings(tag: string) {
  const box = realpathSync(mkdtempSync(join(tmpdir(), `rg-2022-${tag}-`)));
  scratch.push(box);
  const repo = join(box, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  git(repo, "add", "-A");
  commit(repo, "base");
  const done = join(box, "wt-done");
  const live = join(box, "wt-live");
  git(repo, "worktree", "add", "-q", "-b", "feature/done", done);
  git(repo, "worktree", "add", "-q", "-b", "feature/live", live);
  return { box, repo, done, live, head: git(done, "rev-parse", "HEAD") };
}

const listed = (repo: string) =>
  git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter(l => l.startsWith("worktree "))
    .map(l => l.slice("worktree ".length));

function resultWith(rows: Array<{ path: string; verdict: "ABANDONED" | "IN_USE" | "UNMEASURED" }>): CensusResult {
  return {
    repo: "/r",
    takenAt: "t",
    olderThanMs: 0,
    warnings: [],
    counts: { total: rows.length, abandoned: 0, inUse: 0, unmeasured: 0, unmeasuredButSettled: 0 },
    unmeasuredByReading: {},
    rows: rows.map(r => ({
      path: r.path,
      branch: null,
      head: null,
      verdict: r.verdict,
      readings: {
        merge: couldNotRead("n/a"),
        clean: couldNotRead("n/a"),
        holders: couldNotRead("n/a"),
        age: couldNotRead("n/a"),
      },
      unmeasured: [],
      evidence: [],
    })),
  };
}

describe("#2022: the sweep acts on the census's ABANDONED verdict and nothing else", () => {
  test("#2022: only ABANDONED rows are targets", () => {
    const targets = sweepTargets(resultWith([
      { path: "/w/a", verdict: "ABANDONED" },
      { path: "/w/b", verdict: "IN_USE" },
      { path: "/w/c", verdict: "UNMEASURED" },
      { path: "/w/d", verdict: "ABANDONED" },
    ]));
    expect(targets).toEqual(["/w/a", "/w/d"]);
  });

  test("#2022: negative control — a census of all ABANDONED rows targets all of them", () => {
    // Without this, a sweepTargets that returned [] would pass every case
    // above and remove nothing for its whole life, the way #68 did.
    expect(sweepTargets(resultWith([
      { path: "/w/a", verdict: "ABANDONED" },
      { path: "/w/b", verdict: "ABANDONED" },
    ]))).toEqual(["/w/a", "/w/b"]);
  });

  test("#2022: the verdict is read in one place, so the sweep cannot become a second decider", () => {
    const code = codeOnly(readFileSync(SCRIPT, "utf-8"));
    expect(code.match(/"ABANDONED"/g) ?? []).toHaveLength(1);
    expect(code).not.toContain("verdictFor(");
  });
});

describe("#2022: removal leaves git's own refusal in place", () => {
  test("#2022: a clean worktree is removed from disk and from the registration", () => {
    const { repo, done } = repoWithSiblings("clean");
    const out = removeWorktrees(repo, [done]);
    expect(out.removed).toEqual([done]);
    expect(out.refused).toEqual([]);
    expect(existsSync(done)).toBe(false);
    expect(listed(repo)).not.toContain(done);
  });

  test("#2022: a worktree that turned dirty after the reading is refused and survives", () => {
    const { repo, done } = repoWithSiblings("dirty");
    writeFileSync(join(done, "new-work.ts"), "export const unsaved = true;\n");
    const out = removeWorktrees(repo, [done]);
    expect(out.removed).toEqual([]);
    expect(out.refused.map(r => r.path)).toEqual([done]);
    expect(existsSync(join(done, "new-work.ts"))).toBe(true);
    expect(listed(repo)).toContain(done);
  });

  test("#2022: no --force, no prune, no recursive delete anywhere in the sweep", () => {
    const code = codeOnly(readFileSync(SCRIPT, "utf-8"));
    for (const banned of ['"--force"', '"-f"', '"prune"', "rmSync", "rmdirSync", "unlinkSync"]) {
      expect(code, `the sweep must not contain ${banned}`).not.toContain(banned);
    }
  });
});

describe("#2022: end to end — census, then removal, on a real repository", () => {
  test("#2022: the merged, clean, stale worktree goes; the one with an open PR stays", () => {
    const { repo, done, live, head } = repoWithSiblings("e2e");
    const pulls: PullRequest[] = [
      { number: 1, headRefName: "feature/done", headRefOid: head, state: "MERGED" },
      { number: 2, headRefName: "feature/live", headRefOid: head, state: "OPEN" },
    ];
    const r = sweepRepo(repo, {
      olderThanMs: 24 * 3600_000,
      nowMs: Date.now() + 48 * 3600_000,
      maxEntries: 20000,
      pulls: took(pulls),
      lsof: took(""),
    });
    expect(r.outcome.removed).toEqual([done]);
    expect(existsSync(done)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(repo)).toBe(true);
  });

  test("#2022: with the pull requests unread, every row is UNMEASURED and nothing is removed", () => {
    const { repo, done, live } = repoWithSiblings("nogh");
    const r = sweepRepo(repo, {
      olderThanMs: 24 * 3600_000,
      nowMs: Date.now() + 48 * 3600_000,
      maxEntries: 20000,
      pulls: couldNotRead<PullRequest[]>("gh unavailable"),
      lsof: took(""),
    });
    expect(r.outcome.removed).toEqual([]);
    expect(existsSync(done)).toBe(true);
    expect(existsSync(live)).toBe(true);
  });
});

describe("#2022: which repositories a launch directory sweeps", () => {
  test("#2022: inside a repository, it is that repository's main checkout", () => {
    const { repo, done } = repoWithSiblings("inside");
    expect(reposToSweep(done)).toEqual([repo]);
    expect(reposToSweep(repo)).toEqual([repo]);
  });

  test("#2022: outside any repository, it is each primary checkout under it that has a linked worktree", () => {
    const { box, repo } = repoWithSiblings("outside");
    const lone = join(box, "lone");
    mkdirSync(lone);
    git(lone, "init", "-q", "-b", "main");
    writeFileSync(join(lone, "b.ts"), "export const b = 1;\n");
    git(lone, "add", "-A");
    commit(lone, "base");
    // `lone` has no linked worktree, so there is nothing to sweep and no
    // reason to spend a `gh` call on it; the sibling worktrees are not
    // primary checkouts and are reached through `repo`.
    expect(reposToSweep(box)).toEqual([repo]);
  });
});

describe("#2022: the pull requests are read for the repository being swept", () => {
  test("#2022: owner/name comes from either GitHub remote form", () => {
    expect(originSlug("git@github.com:hornjason/rungate.git")).toBe("hornjason/rungate");
    expect(originSlug("https://github.com/hornjason/rungate.git")).toBe("hornjason/rungate");
    expect(originSlug("https://github.com/hornjason/rungate")).toBe("hornjason/rungate");
  });

  test("#2022: a remote that is not GitHub gives no slug, so the merge reading is UNMEASURED", () => {
    expect(originSlug("https://gitlab.com/a/b.git")).toBeNull();
    expect(originSlug("")).toBeNull();
  });
});

describe("#2022: the session-start hook starts the sweep", () => {
  test("#2022: StaleTTLCleanup spawns the sweep detached, outside the in-repo gate", () => {
    const hook = codeOnly(readFileSync(HOOK, "utf-8"));
    expect(hook).toContain("../scripts/worktree-sweep.ts");
    expect(hook).toContain("spawnSweep(");
    // Not behind `if (PROJECT_ROOT)`: a session launched in ~/Projects has no
    // project root, and that was the second reason nothing was ever swept.
    const at = hook.indexOf("spawnSweep(");
    const gate = hook.lastIndexOf("if (PROJECT_ROOT)", at);
    const gateEnd = gate === -1 ? -1 : hook.indexOf("} catch", gate);
    expect(gate === -1 || gateEnd < at, "spawnSweep must not sit inside the PROJECT_ROOT gate").toBe(true);
  });
});
