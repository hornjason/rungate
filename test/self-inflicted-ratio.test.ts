import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { AI_REVIEW_LEDGER_COMMENT_MARKER } from "../lib/ai-review-rounds";
import type { CrcEntry } from "../lib/crc-reading";
import {
  gitLineAge,
  renderSelfInflicted,
  selfInflictedRatio,
  type LineAge,
} from "../lib/self-inflicted-ratio";

/**
 * Covers #1652 — the self-inflicted ratio: what share of a later round's
 * findings concern lines written after the pull request's review began. The
 * convergence spec lists it as an instrument not started, serving its rounds
 * criterion and its fixed-defect criterion together, and #1652's measurement
 * found no live mechanism defect to build in its place.
 *
 * A finding is self-inflicted when its cited line was added between the
 * earliest recorded round's tree and the tree its own round reviewed. The
 * tree pair is the merge commits when both are recorded, else the heads. A
 * finding whose trees or line cannot be read is UNJUDGED and leaves the
 * denominator, named: a missing checkout must never read as a ratio of zero.
 */

const SCRATCH: string[] = [];
afterAll(() => {
  for (const d of SCRATCH) rmSync(d, { recursive: true, force: true });
});

/** A ledger comment body as the writer emits it. `truncated` is the stated drop count. */
function ledgerBody(rounds: unknown[], truncated: number = 0): string {
  return [AI_REVIEW_LEDGER_COMMENT_MARKER, "", "```json", JSON.stringify({ rounds, truncated }), "```", ""].join("\n");
}

/** A ledger written before #1405: a bare array, which states no truncation. */
function legacyLedgerBody(rounds: unknown[]): string {
  return [AI_REVIEW_LEDGER_COMMENT_MARKER, "", "```json", JSON.stringify(rounds), "```", ""].join("\n");
}

const round = (n: number, sha: string, merge: string, findings: unknown[] | null) => ({
  at: "2026-11-18T00:00:00Z",
  sha,
  merge,
  round: n,
  findings,
});

const finding = (file: unknown, line: unknown) => ({ severity: "high", file, line, summary: "s", failure_scenario: "f" });

const entry = (number: number, body: string | null): CrcEntry => ({ number, passed: true, truncated: false, body });

const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const M1 = "a".repeat(40);
const M2 = "b".repeat(40);

/** A fake tree reading: line 3 of lib/a.ts was added between H1 and H2, and nothing else. */
const headsOnly: LineAge = (base, at, file, line) => {
  if (base !== H1 || at !== H2 || file !== "lib/a.ts") return null;
  return line === 3 ? "added" : "kept";
};

describe("#1652: the self-inflicted ratio — later-round findings on lines written after review began", () => {
  test("a later round's finding on an added line is self-inflicted, on an old line pre-existing; round one is not in the ratio", () => {
    const body = ledgerBody([
      round(1, H1, "", [finding("lib/a.ts", 1)]),
      round(2, H2, "", [finding("lib/a.ts", 3), finding("lib/a.ts", 1)]),
    ]);
    const row = selfInflictedRatio([entry(1, body)], headsOnly);
    expect(row.status).toBe("MEASURED");
    expect(row.firstRoundFindings).toBe(1);
    expect(row.laterRounds).toBe(1);
    expect(row.laterFindings).toBe(2);
    expect(row.selfInflicted).toBe(1);
    expect(row.preExisting).toBe(1);
    expect(row.judged).toBe(2);
    expect(row.ratio).toBe(0.5);
    expect(row.treeAt).toEqual({ merge: 0, head: 2 });
  });

  test("every later round compares against the EARLIEST recorded round, not the one before it", () => {
    // Round 3 reviewed H2 again. Against round 2 nothing was added; against
    // round 1, line 3 was. Code written in response to round 1 is still
    // self-inflicted at round 3.
    const body = ledgerBody([
      round(1, H1, "", []),
      round(2, H2, "", []),
      round(3, H2, "", [finding("lib/a.ts", 3)]),
    ]);
    const row = selfInflictedRatio([entry(1, body)], headsOnly);
    expect(row.laterRounds).toBe(2);
    expect(row.selfInflicted).toBe(1);
  });

  test("the merge commits are compared when both rounds recorded one; the heads otherwise; and the reading counts which", () => {
    const seen: string[] = [];
    const spy: LineAge = (base, at, file, line) => {
      seen.push(`${base[0]}..${at[0]}`);
      if (base === M1 && at === M2) return "added";
      return headsOnly(base, at, file, line);
    };
    const both = ledgerBody([round(1, H1, M1, []), round(2, H2, M2, [finding("lib/a.ts", 1)])]);
    const row = selfInflictedRatio([entry(1, both)], spy);
    expect(seen).toEqual(["a..b"]);
    expect(row.selfInflicted).toBe(1);
    expect(row.treeAt).toEqual({ merge: 1, head: 0 });

    // The first round predates the merge key: no merge pair, so the heads.
    seen.length = 0;
    const oneMerge = ledgerBody([round(1, H1, "", []), round(2, H2, M2, [finding("lib/a.ts", 1)])]);
    const row2 = selfInflictedRatio([entry(1, oneMerge)], spy);
    expect(seen).toEqual(["1..2"]);
    expect(row2.preExisting).toBe(1);
    expect(row2.treeAt).toEqual({ merge: 0, head: 1 });

    // A merge pair recorded but not in the checkout falls back to the heads.
    seen.length = 0;
    const gone: LineAge = (base, at, file, line) => (base === M1 ? null : headsOnly(base, at, file, line));
    const row3 = selfInflictedRatio([entry(1, both)], (b, a, f, l) => (seen.push(`${b[0]}..${a[0]}`), gone(b, a, f, l)));
    expect(seen).toEqual(["a..b", "1..2"]);
    expect(row3.treeAt).toEqual({ merge: 0, head: 1 });
  });

  test("a finding with no tree, no file or no line is unjudged and leaves the denominator", () => {
    const body = ledgerBody([
      round(1, H1, "", []),
      round(2, H2, "", [
        finding("lib/a.ts", 3), // judged: self-inflicted
        finding("lib/elsewhere.ts", 1), // the tree reading returns null
        finding("", 1), // names no file
        finding("lib/a.ts", null), // names no line
        finding("lib/a.ts", "3"), // a line that is not a number
        finding("lib/a.ts", 0), // a line no file has
      ]),
    ]);
    const row = selfInflictedRatio([entry(1, body)], headsOnly);
    expect(row.laterFindings).toBe(6);
    expect(row.unjudged).toEqual({ noLine: 4, unread: 1 });
    expect(row.judged).toBe(1);
    expect(row.ratio).toBe(1);
  });

  test("no checkout is no reading: every later finding is unjudged and the ratio is none, never zero", () => {
    const body = ledgerBody([round(1, H1, "", []), round(2, H2, "", [finding("lib/a.ts", 1)])]);
    const row = selfInflictedRatio([entry(1, body)], null);
    expect(row.status).toBe("MEASURED");
    expect(row.unjudged.unread).toBe(1);
    expect(row.ratio).toBeNull();
    expect(renderSelfInflicted(row).join("\n")).toContain("ratio: none");
  });

  test("a ledger that dropped its first rounds, or may have, makes its findings a named lower bound", () => {
    const rounds = [round(4, H1, "", []), round(5, H2, "", [finding("lib/a.ts", 1)])];
    const stated = selfInflictedRatio([entry(1, ledgerBody(rounds, 3))], headsOnly);
    expect(stated.judged).toBe(1);
    expect(stated.fromCutLedgers).toBe(1);

    // A bare-array ledger states no drop count. One at the 12-round cap it
    // was written under may have been cut; one below the cap never was.
    const atCap = [round(1, H1, "", []), ...Array.from({ length: 10 }, (_, i) => round(i + 2, H2, "", [])), round(12, H2, "", [finding("lib/a.ts", 1)])];
    const legacy = selfInflictedRatio([entry(1, legacyLedgerBody(atCap))], headsOnly);
    expect(legacy.judged).toBe(1);
    expect(legacy.fromCutLedgers, "a full bare-array ledger may have dropped rounds").toBe(1);
    const shortLegacy = selfInflictedRatio([entry(1, legacyLedgerBody(rounds))], headsOnly);
    expect(shortLegacy.fromCutLedgers).toBe(0);

    const whole = selfInflictedRatio([entry(1, ledgerBody(rounds, 0))], headsOnly);
    expect(whole.fromCutLedgers).toBe(0);
    expect(renderSelfInflicted(stated).join("\n")).toContain("lower bound");
    expect(renderSelfInflicted(whole).join("\n")).not.toContain("lower bound");
  });

  test("an unreadable ledger is named and not scored; no ledger is listed; nothing readable is UNMEASURED", () => {
    const good = ledgerBody([round(1, H1, "", []), round(2, H2, "", [finding("lib/a.ts", 3)])]);
    const broken = [AI_REVIEW_LEDGER_COMMENT_MARKER, "", "```json", "{not json", "```"].join("\n");
    const row = selfInflictedRatio([entry(7, broken), entry(8, good), entry(9, null)], headsOnly);
    expect(row.prs).toBe(1);
    expect(row.unreadable.map(u => u.number)).toEqual([7]);
    expect(row.absent).toEqual([9]);
    expect(row.selfInflicted).toBe(1);

    const none = selfInflictedRatio([entry(7, broken)], headsOnly);
    expect(none.status).toBe("UNMEASURED");
    expect(none.ratio).toBeNull();
  });

  test("a round with findings: null is not a later round with a review", () => {
    const body = ledgerBody([round(1, H1, "", []), round(2, H2, "", null), round(3, H2, "", [finding("lib/a.ts", 3)])]);
    const row = selfInflictedRatio([entry(1, body)], headsOnly);
    expect(row.laterRounds).toBe(1);
    expect(row.laterFindings).toBe(1);
  });
});

/** A real repository with two commits: the tree round 1 reviewed, and round 2's. */
function twoRoundRepo() {
  const root = mkdtempSync(join(tmpdir(), "self-inflicted-"));
  SCRATCH.push(root);
  const repo = join(root, "repo");
  mkdirSync(join(repo, "lib"), { recursive: true });
  const env = {
    PATH: process.env.PATH ?? "",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, ...a], { env });
  const commit = () => {
    git("add", "-A");
    git("commit", "-qm", "c");
    return new TextDecoder().decode(git("rev-parse", "HEAD").stdout).trim();
  };
  git("init", "-q");
  writeFileSync(join(repo, "lib/a.ts"), ["one", "two", "three", "four", "five", "six"].join("\n") + "\n");
  writeFileSync(join(repo, "lib/c.ts"), ["alpha", "beta", "gamma"].join("\n") + "\n");
  const first = commit();
  // Round 2's tree: a line inserted after "two", one changed, one deleted
  // from c.ts, and a file that did not exist.
  writeFileSync(join(repo, "lib/a.ts"), ["one", "two", "inserted", "three", "four", "FIVE", "six"].join("\n") + "\n");
  writeFileSync(join(repo, "lib/c.ts"), ["alpha", "gamma"].join("\n") + "\n");
  writeFileSync(join(repo, "lib/b.ts"), "new\n");
  const second = commit();
  return { root, repo, env, first, second };
}

describe("#1652: line age is read from git, tree to tree", () => {
  test("inserted and changed lines are added; moved-down and untouched lines are kept; a new file is added", () => {
    const { repo, first, second } = twoRoundRepo();
    const age = gitLineAge(repo);
    expect(age(first, second, "lib/a.ts", 1)).toBe("kept");
    expect(age(first, second, "lib/a.ts", 3)).toBe("added"); // "inserted"
    expect(age(first, second, "lib/a.ts", 4)).toBe("kept"); // "three", moved down a line
    expect(age(first, second, "lib/a.ts", 6)).toBe("added"); // "FIVE", changed
    expect(age(first, second, "lib/a.ts", 7)).toBe("kept"); // "six"
    expect(age(first, second, "lib/b.ts", 1)).toBe("added");
    // A pure deletion adds no line: "gamma" is line 2 now, and was there.
    expect(age(first, second, "lib/c.ts", 2)).toBe("kept");
  });

  test("a commit, file or line that is not there is no reading", () => {
    const { repo, first, second } = twoRoundRepo();
    const age = gitLineAge(repo);
    expect(age("f".repeat(40), second, "lib/a.ts", 1)).toBeNull();
    expect(age(first, "e".repeat(40), "lib/a.ts", 1)).toBeNull();
    expect(age(first, second, "lib/missing.ts", 1)).toBeNull();
    expect(age(first, second, "lib/a.ts", 8)).toBeNull(); // past the end of a 7-line file
    expect(age(first, second, "lib/a.ts", 0)).toBeNull();
    expect(age("not-a-sha", second, "lib/a.ts", 1)).toBeNull();
  });

  test("the command reads a saved window and a real tree", () => {
    const { root, repo, env, first, second } = twoRoundRepo();
    const entries = join(root, "entries.json");
    const body = ledgerBody([
      round(1, first, "", [finding("lib/a.ts", 2)]),
      round(2, second, "", [finding("lib/a.ts", 3), finding("lib/a.ts", 1), finding("lib/b.ts", 1)]),
    ]);
    writeFileSync(entries, JSON.stringify([entry(9, body)]));
    const cli = join(import.meta.dir, "..", "lib", "self-inflicted-ratio.ts");
    const run = Bun.spawnSync(["bun", cli, "--from", entries, "--repo-dir", repo], { env });
    const out = new TextDecoder().decode(run.stdout);
    expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
    expect(out).toContain("MEASURED");
    expect(out).toContain("self-inflicted 2, pre-existing 1");
    expect(out).toContain("2 of 3");

    const unknown = Bun.spawnSync(["bun", cli, "--from", entries, "--bogus"], { env });
    expect(unknown.exitCode).toBe(2);
    const bad = Bun.spawnSync(["bun", cli, "--from", join(root, "nowhere.json")], { env });
    expect(bad.exitCode, "an unreadable window file was read as an empty one").not.toBe(0);
  });
});
