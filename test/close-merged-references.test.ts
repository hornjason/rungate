/**
 * #2496 (ADR-022): a pull request merged by automation still closes the issues
 * it declares.
 *
 * A merge made with `GITHUB_TOKEN` starts no workflow and GitHub does not act
 * on its closing keywords, so the issues it names stay open. The command reads
 * each merged pull request's `closingIssuesReferences`, the links GitHub
 * records even when it does not act on them, and closes an issue only when all
 * four hold: GitHub linked it, it is still open, it is in this repository, and
 * nobody reopened it after the merge. A run writes nothing without `--write`.
 *
 * Titled by issue number: the row that wires this into the generated workflow
 * (#2497) is the one that completes the criterion.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { mergedPullRequestFrom, mergedReferencesToClose } from "../lib/closing-reference-audit";
import { CLI_COMMANDS } from "../lib/cli-commands";
import { closeAll, mergedPullRequestNodes, plan, resolveSince } from "../scripts/close-merged-references";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "close-merged-references.ts");
const REPO = "owner/repo";
const MERGED_AT = "2026-11-18T12:00:00Z";

/** One `closingIssuesReferences` node, GraphQL-shaped. */
const ref = (number: number, over: { state?: string; repo?: string; reopenedAt?: string | null } = {}) => ({
  id: `I_${number}`,
  number,
  state: over.state ?? "OPEN",
  repository: { nameWithOwner: over.repo ?? REPO },
  timelineItems: { nodes: over.reopenedAt ? [{ createdAt: over.reopenedAt }] : [] },
});
/** One merged pull request, GraphQL-shaped, as the live read and a fixture both carry it. */
const pr = (number: number, refs: unknown[], over: Record<string, unknown> = {}) => ({
  number,
  mergedAt: MERGED_AT,
  lastEditedAt: null,
  closingIssuesReferences: { totalCount: refs.length, nodes: refs },
  ...over,
});

const read = (node: unknown) => {
  const r = mergedPullRequestFrom(node);
  if (r.kind !== "READ") throw new Error(`expected READ, got ${r.why}`);
  return r.pr;
};

describe("#2496: which declared issues a merged pull request still owes a close", () => {
  test("an open issue in this repository, never reopened, is closed; each other case is left, saying why", () => {
    const verdicts = mergedReferencesToClose(
      read(
        pr(50, [
          ref(1),
          ref(2, { state: "CLOSED" }),
          ref(3, { repo: "elsewhere/repo" }),
          ref(4, { reopenedAt: "2026-11-18T13:00:00Z" }),
          // Reopened BEFORE the merge, then the merge declared it: it is owed.
          ref(5, { reopenedAt: "2026-11-18T11:00:00Z" }),
        ]),
      ),
      REPO,
    );
    expect(verdicts.map(v => [v.issue, v.close])).toEqual([
      [1, true],
      [2, false],
      [3, false],
      [4, false],
      [5, true],
    ]);
    const why = (n: number) => {
      const v = verdicts.find(x => x.issue === n);
      return v && !v.close ? v.why : "";
    };
    expect(why(2)).toContain("already closed");
    expect(why(3)).toContain("elsewhere/repo");
    expect(why(4)).toContain("reopened after the merge");
    for (const v of verdicts) expect(v.pr).toBe(50);
  });

  test("an issue in another repository sharing a number with one here is still left", () => {
    const verdicts = mergedReferencesToClose(read(pr(59, [ref(7), ref(7, { repo: "elsewhere/repo" })])), REPO);
    expect(verdicts.map(v => [v.issue, v.close])).toEqual([[7, true], [7, false]]);
  });

  test("a description edited after the merge leaves its links; one edited before does not", () => {
    // Security review of #2496: the author can edit a merged pull request's
    // description, and GitHub reads the links from it as it is now.
    const after = mergedReferencesToClose(read(pr(65, [ref(1), ref(2)], { lastEditedAt: "2026-11-18T12:05:00Z" })), REPO);
    expect(after.map(v => v.close)).toEqual([false, false]);
    for (const v of after) expect(!v.close && v.why).toContain("edited after the merge");
    const before = mergedReferencesToClose(read(pr(66, [ref(1)], { lastEditedAt: "2026-11-18T11:00:00Z" })), REPO);
    expect(before.map(v => v.close)).toEqual([true]);
    expect(mergedPullRequestFrom(pr(67, [ref(1)], { lastEditedAt: "soon" })).kind).toBe("UNMEASURED");
  });

  test("an issue the body only mentions is never closed: only GitHub's links are read", () => {
    // The body names #9 in prose; GitHub linked only #1. No field of the
    // payload carries the body, so a mention has no path to a close.
    const node = pr(51, [ref(1)], { body: "Fixes #1. Also see #9, which stays open." });
    const verdicts = mergedReferencesToClose(read(node), REPO);
    expect(verdicts.map(v => v.issue)).toEqual([1]);
  });

  test("a payload that cannot be fully read is UNMEASURED, never a shorter list", () => {
    const cases: Array<[string, unknown, string]> = [
      ["more links than were read", pr(52, [ref(1)], { closingIssuesReferences: { totalCount: 2, nodes: [ref(1)] } }), "2"],
      ["no mergedAt", pr(53, [ref(1)], { mergedAt: null }), "mergedAt"],
      ["an unparseable mergedAt", pr(54, [ref(1)], { mergedAt: "yesterday" }), "mergedAt"],
      ["a link with no state", pr(55, [{ ...ref(1), state: undefined }]), "state"],
      ["a link with no repository", pr(56, [{ ...ref(1), repository: null }]), "repository"],
      ["a link whose timeline was not read", pr(57, [{ ...ref(1), timelineItems: undefined }]), "timeline"],
      ["no number", { ...pr(58, [ref(1)]), number: "58" }, "number"],
    ];
    for (const [label, node, names] of cases) {
      const r = mergedPullRequestFrom(node);
      expect(r.kind, label).toBe("UNMEASURED");
      if (r.kind === "UNMEASURED") expect(r.why, label).toContain(names);
    }
  });
});

describe("#2496: the live read and the writes, against a client that records what it was asked", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const C = "c".repeat(40);
  const commit = (oid: string, prs: unknown[], totalCount = prs.length) => ({ oid, associatedPullRequests: { totalCount, nodes: prs } });
  const merged = (number: number, mergeOid: string, refs: unknown[], base = REPO) => ({
    ...pr(number, refs),
    merged: true,
    mergeCommit: { oid: mergeOid },
    baseRepository: { nameWithOwner: base },
  });
  const reading = (repository: Record<string, unknown>) => {
    const queries: string[] = [];
    const client = { graphql: async (q: string) => (queries.push(q), { repository }) } as any;
    return { client, queries };
  };

  test("only the pull request a commit was merged BY, into this repository, is read", async () => {
    const { client } = reading({
      // A stacked branch's pull request contains commit A too, merged elsewhere.
      c0: commit(A, [merged(70, A, [ref(1)]), merged(71, C, [ref(2)]), merged(73, A, [ref(3)], "fork/repo")]),
      // A commit pushed straight to the branch has no pull request: it declared nothing.
      c1: commit(B, []),
    });
    const r = await mergedPullRequestNodes(client, "owner", "repo", [A, B], REPO);
    expect("nodes" in r && r.nodes.map((n: any) => n.number)).toEqual([70]);
  });

  test("a commit whose pull request list was cut short, or not read at all, is UNMEASURED", async () => {
    const short = await mergedPullRequestNodes(reading({ c0: commit(A, [merged(72, C, [])], 9) }).client, "owner", "repo", [A], REPO);
    expect("why" in short && short.why).toContain("9 associated pull requests and 1 were read");
    const missing = await mergedPullRequestNodes(reading({ c0: null }).client, "owner", "repo", [A], REPO);
    expect("why" in missing && missing.why).toContain("could not be read");
  });

  test("each close comments naming the pull request, then closes; a failed close is reported and the rest still run", async () => {
    const calls: string[] = [];
    const client = {
      rest: {
        issues: {
          createComment: async (p: { issue_number: number; body: string }) => {
            calls.push(`comment #${p.issue_number}: ${p.body}`);
            if (p.issue_number === 2) throw new Error("rate limited");
          },
          update: async (p: { issue_number: number; state: string; state_reason: string }) => {
            calls.push(`update #${p.issue_number} ${p.state} ${p.state_reason}`);
          },
        },
      },
    } as any;
    const verdicts = plan([read(pr(80, [ref(1), ref(2), ref(3, { state: "CLOSED" })]))], REPO);
    const failed = await closeAll(client, "owner", "repo", verdicts, new Map([[80, MERGED_AT]]));
    expect(failed).toEqual(["#2: rate limited"]);
    expect(calls.filter(c => c.startsWith("update"))).toEqual(["update #1 closed completed"]);
    expect(calls[0]).toStartWith("comment #1: ");
    expect(calls[0]).toContain("#80");
    // A closed issue is never written to at all.
    expect(calls.some(c => c.includes("#3"))).toBe(false);
  });

  test("an issue two merged pull requests both declare is closed once, by the first", () => {
    const verdicts = plan([read(pr(90, [ref(1)])), read(pr(91, [ref(1)]))], REPO);
    expect(verdicts.map(v => [v.issue, v.pr, v.close])).toEqual([[1, 90, true], [1, 91, false]]);
  });
});

describe("#2496: close-merged-references reads merged pull requests and writes only with --write", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });
  const fixture = (content: unknown): string => {
    const d = mkdtempSync(join(tmpdir(), "close-merged-refs-"));
    made.push(d);
    const f = join(d, "prs.json");
    writeFileSync(f, typeof content === "string" ? content : JSON.stringify(content));
    return f;
  };
  const run = (args: string[]) => {
    const env: Record<string, string | undefined> = { ...process.env };
    // No credential: a fixture run must never need one, and a run that reached
    // the network would refuse on it rather than pass.
    delete env.GITHUB_TOKEN;
    delete env.GH_TOKEN;
    const r = spawnSync("bun", [SCRIPT, ...args], { encoding: "utf8", env, timeout: 30_000 });
    return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };

  test("a fixture run prints what it would close and what it leaves, and writes nothing", () => {
    const f = fixture([pr(60, [ref(1), ref(2, { state: "CLOSED" })]), pr(61, [ref(3, { reopenedAt: "2026-11-19T00:00:00Z" })])]);
    const r = run(["--fixture", f, "--repo", REPO]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("would close #1 (declared by #60)");
    expect(r.out).toMatch(/leave #2 \(declared by #60\): .*already closed/);
    expect(r.out).toMatch(/leave #3 \(declared by #61\): .*reopened after the merge/);
    expect(r.out).toContain("1 to close, 2 left");
    expect(r.out).not.toContain("closed #1");
  });

  test("--write against a fixture is refused: a fixture is a reading, never a target", () => {
    const r = run(["--fixture", fixture([pr(62, [ref(1)])]), "--repo", REPO, "--write"]);
    expect(r.code, r.out).toBe(2);
    expect(r.out).toContain("--write");
    expect(r.out).not.toContain("would close");
  });

  test("an unreadable fixture, or one pull request in it that cannot be read, closes nothing", () => {
    const broken = run(["--fixture", fixture("{ not json"), "--repo", REPO]);
    expect(broken.code, broken.out).toBe(2);
    expect(broken.out).toContain("UNMEASURED");
    // One good pull request beside one unreadable one: nothing is planned,
    // because a partial reading would close half of what is owed and look done.
    const mixed = run(["--fixture", fixture([pr(63, [ref(1)]), pr(64, [ref(2)], { mergedAt: null })]), "--repo", REPO]);
    expect(mixed.code, mixed.out).toBe(2);
    expect(mixed.out).toContain("UNMEASURED");
    expect(mixed.out).toContain("#64");
    expect(mixed.out).not.toContain("would close");
  });

  test("with neither --since nor --fixture there is no range to read, and it says so", () => {
    const r = run(["--repo", REPO]);
    expect(r.code, r.out).toBe(2);
    expect(r.out).toContain("--since");
  });

  test("a live run with no credential is refused before anything is read", () => {
    const r = run(["--since", "HEAD~1", "--repo", REPO]);
    expect(r.code, r.out).toBe(2);
    expect(r.out).toContain("UNMEASURED");
    expect(r.out).toMatch(/credential|GITHUB_TOKEN/);
  });

  test("it is a rungate command, and the script it runs ships", () => {
    expect(CLI_COMMANDS["close-merged-references"]?.script).toBe("scripts/close-merged-references.ts");
    const files = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { files: string[] }).files;
    expect(files).toContain("scripts/close-merged-references.ts");
  });
});

/**
 * #2522: the range for the run a merge workflow starts. A `workflow_run` event
 * carries no `before` sha, so the command reads it the way
 * `plan-issues --accepted-since-last-run` does: the head of the workflow's
 * newest successful run whose head is on this branch, through the one function
 * both commands import (ADR-022 decision 3).
 */
describe("#2522: --since-last-run reads the range from the workflow's last successful run", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  // Three commits on the branch, and one that is on no branch here.
  const history = () => {
    const d = mkdtempSync(join(tmpdir(), "close-since-last-run-"));
    made.push(d);
    git(d, "init", "-q", "-b", "main");
    git(d, "config", "user.email", "t@example.com");
    git(d, "config", "user.name", "t");
    const shas: string[] = [];
    for (const n of ["a", "b", "c"]) {
      writeFileSync(join(d, n), n);
      git(d, "add", n);
      git(d, "commit", "-q", "-m", n);
      shas.push(git(d, "rev-parse", "HEAD"));
    }
    return { root: d, shas, offBranch: "f".repeat(40) };
  };
  const runsOf = (list: unknown[] | Error) => ({
    runs: async () => {
      if (list instanceof Error) throw list;
      return list;
    },
  });

  test("the newest successful run whose head is on this branch starts the range", async () => {
    const h = history();
    const r = await resolveSince({ sinceLastRun: "adr-accepted.yml", root: h.root, repo: REPO, runs: runsOf([{ id: 9, head_sha: h.offBranch }, { id: 8, head_sha: h.shas[1] }]) });
    expect(r).toEqual({ sha: h.shas[1]!, said: expect.stringContaining("run 8") });
    expect("said" in r && r.said).toContain("1 newer run(s) had a head not on it");
  });

  test("no successful run, or runs that could not be read, refuse by name rather than guess a range", async () => {
    const h = history();
    const none = await resolveSince({ sinceLastRun: "adr-accepted.yml", root: h.root, repo: REPO, runs: runsOf([]) });
    expect("why" in none && none.why).toContain("no successful run");
    const unread = await resolveSince({ sinceLastRun: "adr-accepted.yml", root: h.root, repo: REPO, runs: runsOf(new Error("HTTP 502")) });
    expect("why" in unread && unread.why).toContain("HTTP 502");
  });

  test("--since passes straight through, as before", async () => {
    const h = history();
    expect(await resolveSince({ since: h.shas[0]!, root: h.root, repo: REPO, runs: runsOf(new Error("never read")) })).toEqual({ sha: h.shas[0]! });
  });

  test("--since-last-run beside --since or --fixture, or naming no workflow file, is refused before anything is read", () => {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.GITHUB_TOKEN;
    delete env.GH_TOKEN;
    const run = (args: string[]) => {
      const r = spawnSync("bun", [SCRIPT, ...args], { encoding: "utf8", env, timeout: 30_000 });
      return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    };
    const both = run(["--since-last-run", "adr-accepted.yml", "--since", "HEAD~1", "--repo", REPO]);
    expect(both.code, both.out).toBe(2);
    expect(both.out).toContain("--since-last-run");
    const fixture = run(["--since-last-run", "adr-accepted.yml", "--fixture", "x.json", "--repo", REPO]);
    expect(fixture.code, fixture.out).toBe(2);
    const bad = run(["--since-last-run", "not a workflow", "--repo", REPO]);
    expect(bad.code, bad.out).toBe(2);
    expect(bad.out).toContain("workflow file");
    // No credential: refused before the runs are read, never read as "no runs".
    const cred = run(["--since-last-run", "adr-accepted.yml", "--repo", REPO]);
    expect(cred.code, cred.out).toBe(2);
    expect(cred.out).toMatch(/credential|GITHUB_TOKEN/);
  });

  test("one decider: both commands import sinceLastSuccessfulRun from one module and neither defines its own", () => {
    const src = (p: string) => readFileSync(join(ROOT, p), "utf8");
    expect(src("lib/last-successful-run.ts")).toContain("export function sinceLastSuccessfulRun(");
    for (const p of ["scripts/plan-issues.ts", "scripts/close-merged-references.ts"]) {
      expect(src(p), `${p} defines its own copy`).not.toContain("function sinceLastSuccessfulRun(");
      expect(src(p), `${p} does not import the shared one`).toMatch(/from "\.\.\/lib\/last-successful-run"/);
    }
  });
});
