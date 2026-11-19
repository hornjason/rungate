/**
 * Close the issues a pull request merged by automation declares (#2496, ADR-022).
 *
 * Usage:
 *   rungate close-merged-references --since <sha> [--repo owner/name] [--project-root <dir>] [--write]
 *   rungate close-merged-references --fixture <prs.json> [--repo owner/name]     # offline, never writes
 *
 * A merge made with `GITHUB_TOKEN` starts no workflow, and GitHub does not act
 * on its closing keywords: the issues it names stay open until somebody closes
 * them by hand. This reads every pull request merged onto the checked-out
 * branch since `<sha>` and closes each issue in its `closingIssuesReferences`
 * that is still open, in this repository, and was not reopened after the
 * merge, with a comment naming the pull request. `lib/closing-reference-audit.ts`
 * decides; this script only reads and writes.
 *
 * **Nothing is written without `--write`.** A run without it prints what it
 * would close and what it leaves, and why.
 *
 * **A partial reading closes nothing.** Every pull request in the range is
 * read before any issue is touched. One that cannot be read, a range that
 * cannot be resolved, or a commit whose pull request cannot be found is
 * UNMEASURED and the run exits before writing, because closing half of what
 * is owed looks exactly like closing all of it.
 *
 * The repository is `--repo`, then `GITHUB_REPOSITORY`, then the origin
 * remote (`rungate board`'s resolver), and the name compared against each
 * link is the one GitHub returns for it, so a remote spelled in another case
 * cannot make every link read as another repository's.
 */
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { resolve } from "path";

import {
  mergedPullRequestFrom,
  mergedReferencesToClose,
  type MergedPullRequest,
  type MergedReferenceVerdict,
} from "../lib/closing-reference-audit";
import { createGitHubClient, parseOwnerRepo, resolveGitHubToken } from "../lib/github";
import { resolveRepo } from "./status-view";

/** A reading that could not be taken, or a run that was asked for wrongly. Nothing was written. */
export const REFUSAL_EXIT = 2;
/** Every issue was read and planned, and at least one close failed. */
export const WRITE_FAILED_EXIT = 1;

/** Commits asked about in one GraphQL request. */
const COMMITS_PER_QUERY = 40;

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? "");
}

function refuse(why: string): number {
  console.error(`close-merged-references: UNMEASURED — ${why}. Nothing was closed.`);
  return REFUSAL_EXIT;
}

/** Read every entry, or name each one that could not be read. */
function readAll(nodes: unknown[]): { prs: MergedPullRequest[] } | { unread: string[] } {
  const prs: MergedPullRequest[] = [];
  const unread: string[] = [];
  for (const node of nodes) {
    const r = mergedPullRequestFrom(node);
    if (r.kind === "READ") prs.push(r.pr);
    else unread.push(r.why);
  }
  return unread.length > 0 ? { unread } : { prs };
}

/**
 * The plan: one verdict per link, in pull-request order. An issue two pull
 * requests both declare is closed once, by the first.
 */
export function plan(prs: MergedPullRequest[], repo: string): MergedReferenceVerdict[] {
  const out: MergedReferenceVerdict[] = [];
  const planned = new Map<number, number>();
  for (const pr of prs) {
    for (const v of mergedReferencesToClose(pr, repo)) {
      const first = planned.get(v.issue);
      if (v.close && first !== undefined) {
        out.push({ issue: v.issue, pr: v.pr, close: false, why: `#${first} closes it in this run` });
        continue;
      }
      if (v.close) planned.set(v.issue, v.pr);
      out.push(v);
    }
  }
  return out;
}

function printPlan(verdicts: MergedReferenceVerdict[], prCount: number, writing: boolean): void {
  for (const v of verdicts) {
    if (v.close) console.log(`${writing ? "closing" : "would close"} #${v.issue} (declared by #${v.pr})`);
    else console.log(`leave #${v.issue} (declared by #${v.pr}): ${v.why}`);
  }
  const closing = verdicts.filter(v => v.close).length;
  console.log(
    `close-merged-references: ${closing} to close, ${verdicts.length - closing} left, ` +
      `from ${prCount} merged pull request${prCount === 1 ? "" : "s"}.` +
      (writing ? "" : " Nothing was written; --write closes them."),
  );
}

/** The first-parent commits in `since..HEAD`, oldest first, or why they could not be listed. */
function commitsSince(root: string, since: string): { oids: string[] } | { why: string } {
  // Resolved to a commit first, behind --end-of-options, so a value that looks
  // like an option is a ref that does not exist rather than a flag to git.
  const base = spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", "--end-of-options", `${since}^{commit}`], { encoding: "utf8" });
  const sha = base.stdout.trim();
  if (base.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) return { why: `--since ${JSON.stringify(since)} is not a commit in ${root}` };
  const list = spawnSync("git", ["-C", root, "rev-list", "--first-parent", "--reverse", `${sha}..HEAD`], { encoding: "utf8" });
  if (list.status !== 0) return { why: `the commits after ${sha.slice(0, 12)} could not be listed: ${(list.stderr || "git exited non-zero").trim().slice(0, 200)}` };
  return { oids: list.stdout.split("\n").map(s => s.trim()).filter(Boolean) };
}

const PR_FIELDS = `number merged mergedAt lastEditedAt mergeCommit { oid } baseRepository { nameWithOwner }
  closingIssuesReferences(first: 50) {
    totalCount
    nodes {
      id number state repository { nameWithOwner }
      timelineItems(itemTypes: [REOPENED_EVENT], last: 1) { nodes { ... on ReopenedEvent { createdAt } } }
    }
  }`;

/** The pull request each commit was merged by, read for every commit before anything is decided. */
export async function mergedPullRequestNodes(
  client: ReturnType<typeof createGitHubClient>,
  owner: string,
  name: string,
  oids: string[],
  repo: string,
): Promise<{ nodes: unknown[] } | { why: string }> {
  const nodes: unknown[] = [];
  for (let i = 0; i < oids.length; i += COMMITS_PER_QUERY) {
    const batch = oids.slice(i, i + COMMITS_PER_QUERY);
    const fields = batch
      .map((oid, k) => `c${k}: object(oid: "${oid}") { ... on Commit { oid associatedPullRequests(first: 5) { totalCount nodes { ${PR_FIELDS} } } } }`)
      .join("\n");
    const data = (await client.graphql(`query($o: String!, $n: String!) { repository(owner: $o, name: $n) { ${fields} } }`, { o: owner, n: name })) as {
      repository?: Record<string, { oid?: string; associatedPullRequests?: { totalCount?: number; nodes?: any[] } } | null>;
    };
    for (let k = 0; k < batch.length; k++) {
      const commit = data.repository?.[`c${k}`];
      const prs = commit?.associatedPullRequests;
      if (!prs || !Array.isArray(prs.nodes)) return { why: `commit ${batch[k].slice(0, 12)}'s pull requests could not be read` };
      // Merged BY this commit, INTO this repository: a pull request that only
      // contains the commit, or whose base is a fork, declared nothing here.
      const mergedHere = prs.nodes.filter(
        p => p?.merged === true && p?.mergeCommit?.oid === batch[k] && p?.baseRepository?.nameWithOwner === repo,
      );
      // A commit pushed straight to the branch has no pull request, and that is
      // a reading: it declared nothing. One whose list was cut short might.
      if (mergedHere.length === 0 && prs.totalCount !== prs.nodes.length) {
        return { why: `commit ${batch[k].slice(0, 12)} has ${prs.totalCount} associated pull requests and ${prs.nodes.length} were read` };
      }
      nodes.push(...mergedHere);
    }
  }
  return { nodes };
}

export async function closeAll(
  client: ReturnType<typeof createGitHubClient>,
  owner: string,
  name: string,
  verdicts: MergedReferenceVerdict[],
  mergedAt: Map<number, string>,
): Promise<string[]> {
  const failed: string[] = [];
  for (const v of verdicts) {
    if (!v.close) continue;
    try {
      // Comment first: a close that then fails leaves an explained open
      // issue, never an unexplained closed one.
      await client.rest.issues.createComment({
        owner,
        repo: name,
        issue_number: v.issue,
        body:
          `Closed by \`rungate close-merged-references\`: #${v.pr} declared this issue closed and was merged at ` +
          `${mergedAt.get(v.pr)}. A merge made by automation does not run GitHub's closing keywords, so nothing closed it then.`,
      });
      await client.rest.issues.update({ owner, repo: name, issue_number: v.issue, state: "closed", state_reason: "completed" });
      console.log(`closed #${v.issue} (declared by #${v.pr})`);
    } catch (e) {
      failed.push(`#${v.issue}: ${(e as Error).message}`);
    }
  }
  return failed;
}

export async function main(argv: string[], root = process.cwd()): Promise<number> {
  const fixture = flag(argv, "--fixture");
  const since = flag(argv, "--since");
  const write = argv.includes("--write");
  const rootFlag = flag(argv, "--project-root");
  if (rootFlag === "") return refuse("--project-root needs a directory after it");
  const projectRoot = rootFlag === null ? root : resolve(rootFlag);

  if (fixture !== null && write) {
    return refuse("--write cannot be used with --fixture: a fixture is a reading, never a target");
  }
  if (fixture !== null && since !== null) return refuse("--fixture and --since name two different inputs; pass one");

  const named = resolveRepo(argv, process.env, projectRoot);
  let owner: string;
  let name: string;
  try {
    if (named === null) throw new Error("no --repo, no GITHUB_REPOSITORY, and no GitHub origin remote");
    ({ owner, repo: name } = parseOwnerRepo(named));
  } catch (e) {
    return refuse(`no repository to read (${(e as Error).message})`);
  }

  if (fixture !== null) {
    if (fixture === "") return refuse("--fixture needs a file after it");
    let entries: unknown;
    try {
      entries = JSON.parse(readFileSync(fixture, "utf8"));
    } catch (e) {
      return refuse(`${fixture} could not be read as JSON (${(e as Error).message})`);
    }
    if (!Array.isArray(entries)) return refuse(`${fixture} is not a list of pull requests`);
    const r = readAll(entries);
    if ("unread" in r) return refuse(`${r.unread.length} pull request(s) could not be read: ${r.unread.join("; ")}`);
    printPlan(plan(r.prs, `${owner}/${name}`), r.prs.length, false);
    return 0;
  }

  if (since === null || since === "") {
    return refuse("there is no range to read: name it with --since <sha> (the commit the last run reached), or read a --fixture");
  }
  if (!resolveGitHubToken()) return refuse("no GitHub credential; set GITHUB_TOKEN or GH_TOKEN");

  const commits = commitsSince(projectRoot, since);
  if ("why" in commits) return refuse(commits.why);

  try {
    const client = createGitHubClient();
    const canonical = (await client.graphql(`query($o: String!, $n: String!) { repository(owner: $o, name: $n) { nameWithOwner } }`, { o: owner, n: name })) as {
      repository?: { nameWithOwner?: unknown };
    };
    const repo = canonical.repository?.nameWithOwner;
    if (typeof repo !== "string") return refuse(`${owner}/${name} was not found, or the credential cannot read it`);

    const read = await mergedPullRequestNodes(client, owner, name, commits.oids, repo);
    if ("why" in read) return refuse(read.why);
    const r = readAll(read.nodes);
    if ("unread" in r) return refuse(`${r.unread.length} pull request(s) could not be read: ${r.unread.join("; ")}`);

    const verdicts = plan(r.prs, repo);
    printPlan(verdicts, r.prs.length, write);
    if (!write) return 0;
    const failed = await closeAll(client, owner, name, verdicts, new Map(r.prs.map(p => [p.number, p.mergedAt])));
    if (failed.length > 0) {
      console.error(`close-merged-references: ${failed.length} close(s) failed: ${failed.join("; ")}`);
      return WRITE_FAILED_EXIT;
    }
    return 0;
  } catch (e) {
    return refuse(`GitHub could not be read (${(e as Error).message})`);
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
