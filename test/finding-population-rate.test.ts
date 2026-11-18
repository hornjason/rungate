import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { AI_REVIEW_LEDGER_COMMENT_MARKER } from "../lib/ai-review-rounds";
import type { CrcEntry } from "../lib/crc-reading";
import {
  populationRate,
  renderPopulationRate,
  type LinesAt,
} from "../lib/finding-population-rate";

/**
 * Covers #2437 — CRC-N3 (CODE-REVIEW-CONVERGENCE-SPEC.md) has an instance and
 * no denominator. Since #1883 a finding's `population` is counted by the
 * literal search it names; this reading turns those verdicts, over the
 * findings ledger, into a rate.
 *
 * The verdict is the adjudicator's own `populationVerdict`, re-run here over
 * the tree the round reviewed — the ledger records the finding as written and
 * not the verdict, so there is nothing else to count. Where that tree is not
 * available the finding is UNJUDGED and leaves the denominator, named: a
 * missing checkout must never read as a rate of zero.
 */

const SCRATCH: string[] = [];
afterAll(() => {
  for (const d of SCRATCH) rmSync(d, { recursive: true, force: true });
});

const MERGE = "a".repeat(40);
const HEAD = "b".repeat(40);
const FILE = "lib/a.ts";
const LINES = ["const needle = 1;", "needle(2);", "unrelated", "return needle;"];

/** A ledger comment body, as the writer emits it: one line of JSON. */
function ledgerBody(rounds: unknown[]): string {
  return [AI_REVIEW_LEDGER_COMMENT_MARKER, "", "```json", JSON.stringify({ rounds, truncated: 0 }), "```", ""].join("\n");
}

const round = (n: number, findings: unknown[] | null) => ({
  at: "2026-11-18T00:00:00Z",
  sha: HEAD,
  merge: MERGE,
  round: n,
  findings,
});

const finding = (over: Record<string, unknown>) => ({
  severity: "high",
  file: FILE,
  line: 1,
  summary: "s",
  failure_scenario: "f",
  ...over,
});

const entry = (number: number, body: string | null): CrcEntry => ({ number, passed: true, truncated: false, body });

/** One finding of each verdict, against a file with three `needle` lines. */
const FIVE = [
  finding({ population: 3, populationSearch: ["needle"] }), // measured, 3
  finding({ population: 5, populationSearch: ["needle"] }), // contradicted: declared 5, search 3
  finding({ population: 2 }), // unbacked
  finding({}), // undeclared
  finding({ populationSearch: ["zz-nothing-matches"] }), // unmeasured: matches no line
];

const atMerge: LinesAt = (commit, file) => (commit === MERGE && file === FILE ? LINES : null);

describe("#2437: CRC-N3's rate — how many findings count their class by a search that ran", () => {
  test("a planted ledger with one finding of each verdict gives exactly those counts and the rate", () => {
    const row = populationRate([entry(1, ledgerBody([round(1, FIVE)]))], atMerge);
    expect(row.status).toBe("MEASURED");
    expect(row.findings).toBe(5);
    expect(row.counts).toEqual({ measured: 1, contradicted: 1, unbacked: 1, undeclared: 1, unmeasured: 1, unjudged: 0 });
    expect(row.treeAt).toEqual({ merge: 3, head: 0, none: 0 });
    expect(row.judged).toBe(5);
    expect(row.rate).toBeCloseTo(1 / 5, 10);
  });

  test("the head commit stands in when the merge tree is gone, and the reading says which tree it read", () => {
    const atHead: LinesAt = (commit, file) => (commit === HEAD && file === FILE ? LINES : null);
    const row = populationRate([entry(1, ledgerBody([round(1, FIVE)]))], atHead);
    expect(row.counts.measured).toBe(1);
    expect(row.treeAt).toEqual({ merge: 0, head: 3, none: 0 });
    expect(renderPopulationRate(row).join("\n")).toContain("head commit");
  });

  test("with no tree at all a searched finding is UNJUDGED and leaves the denominator — never a measured zero", () => {
    // A sixth finding whose search is unusable (a two-character term): that is
    // not a tree problem, so it is decided without one and stays unmeasured.
    const six = [...FIVE, finding({ populationSearch: ["ab"] })];
    const row = populationRate([entry(1, ledgerBody([round(1, six)]))], null);
    // The three searches that would have run are unjudged.
    expect(row.counts.unjudged).toBe(3);
    expect(row.counts.unmeasured).toBe(1);
    expect(row.counts.measured).toBe(0);
    expect(row.counts.contradicted).toBe(0);
    expect(row.judged, "an unjudged finding was counted in the denominator").toBe(3);
    expect(row.treeAt.none).toBe(3);
    expect(renderPopulationRate(row).join("\n")).toContain("3 could not be judged");
  });

  test("a ledger it cannot read is named and UNMEASURED, never a rate of zero", () => {
    const broken = `${AI_REVIEW_LEDGER_COMMENT_MARKER}\n\n\`\`\`json\n{"rounds":[`;
    const only = populationRate([entry(7, broken)], atMerge);
    expect(only.status).toBe("UNMEASURED");
    expect(only.rate).toBeNull();
    expect(only.unreadable.map(u => u.number)).toEqual([7]);

    const mixed = populationRate([entry(7, broken), entry(8, ledgerBody([round(1, FIVE)]))], atMerge);
    expect(mixed.status, "one unreadable ledger erased the readable one").toBe("MEASURED");
    expect(mixed.unreadable.map(u => u.number)).toEqual([7]);
    expect(mixed.findings).toBe(5);
    expect(renderPopulationRate(mixed).join("\n")).toContain("#7");
  });

  test("no ledger anywhere is UNMEASURED, and a round with no review in it counts no findings", () => {
    const none = populationRate([entry(3, null)], atMerge);
    expect(none.status).toBe("UNMEASURED");
    expect(none.absent).toEqual([3]);

    const row = populationRate([entry(4, ledgerBody([round(1, null), round(2, FIVE)]))], atMerge);
    expect(row.rounds, "an unmeasured round was counted").toBe(1);
    expect(row.findings).toBe(5);
  });

  test("a window with ledgers and no findings has no rate, rather than a rate of zero", () => {
    const row = populationRate([entry(5, ledgerBody([round(1, [])]))], atMerge);
    expect(row.status).toBe("MEASURED");
    expect(row.findings).toBe(0);
    expect(row.rate).toBeNull();
  });

  test("the verdict is the adjudicator's, not a second decider", () => {
    const source = readFileSync(join(import.meta.dir, "..", "lib", "finding-population-rate.ts"), "utf-8");
    expect(source).toContain("populationVerdict(");
    expect(source, "the module counts matching lines itself, a second decider").not.toContain(".includes(t)");
  });

  test("the command reads a saved window and a real tree", () => {
    const root = mkdtempSync(join(tmpdir(), "population-rate-cli-"));
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
    git("init", "-q");
    writeFileSync(join(repo, FILE), LINES.join("\n") + "\n");
    git("add", "-A");
    git("commit", "-qm", "c");
    const sha = new TextDecoder().decode(git("rev-parse", "HEAD").stdout).trim();

    const entries = join(root, "entries.json");
    const r = { ...round(1, FIVE), merge: sha, sha };
    writeFileSync(entries, JSON.stringify([entry(9, ledgerBody([r]))]));
    const cli = join(import.meta.dir, "..", "lib", "finding-population-rate.ts");
    const run = Bun.spawnSync(["bun", cli, "--from", entries, "--repo-dir", repo], { env });
    const out = new TextDecoder().decode(run.stdout);
    expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
    expect(out).toContain("MEASURED");
    expect(out).toContain("measured 1");
    expect(out).toContain("contradicted 1");

    const bad = Bun.spawnSync(["bun", cli, "--from", join(root, "nowhere.json")], { env });
    expect(bad.exitCode, "an unreadable window file was read as an empty one").not.toBe(0);
  });
});
