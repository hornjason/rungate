#!/usr/bin/env bun
/**
 * hand-edits — has anybody edited the payload's board by hand? (#1722, SC-2625)
 *
 *   bun scripts/hand-edits.ts --prefix Convergence --repo hornjason/rungate
 *
 * Reads every board write on the issues in the `<prefix> Phase N` milestones:
 * milestone and label changes, blocked-by and blocking links, title renames,
 * body edits, and project-board adds, removals and status moves. The window
 * opens at the first write signed by the pipeline account
 * (`board.pipelineAccount`). Any write a person made after that is a hand
 * edit, and each is named. Exit 0 only when the window is open and holds no
 * hand edit; UNMEASURED and SHORT both refuse.
 *
 * Not part of `board-conformance`'s default verdict: it reads UNMEASURED until
 * the pipeline account has written, and joining the verdict before then would
 * turn the board check red. Whether it joins later is Jason's call.
 *
 * What it cannot see, because GitHub records no issue event for it: a project
 * field other than Status (the Criteria column), and an edit to a milestone
 * object itself.
 */

import { parseArgs } from "node:util";
import { readPipelineAccount } from "../lib/config-readers";
import { createGitHubClient } from "../lib/github";
import { nextCursor } from "../lib/graphql-cursor";
import { BOARD_WRITE_EVENTS, boardWritesOf, handEditVerdict, windowOpens, type BoardWrite } from "../lib/hand-edits";
import { inMilestoneFamily, readMilestonePrefix } from "../lib/live-issues";

/** Every refusal exits through this, once. */
export const HAND_EDITS_REFUSAL_EXIT = 1;

const COMMAND = "hand-edits";

/** The two reads the reading needs, so a test can hand it a board. */
export interface HandEditsSource {
  graphql(query: string, vars: Record<string, unknown>): Promise<unknown>;
  /** One page of the repository's issue events, newest first, 100 to a page. */
  repoEvents(page: number): Promise<unknown[]>;
}

const MILESTONES_QUERY = `query($owner:String!,$name:String!,$after:String){
  repository(owner:$owner,name:$name){ milestones(first:100, after:$after, states:[OPEN,CLOSED]){
    pageInfo{ hasNextPage endCursor }
    nodes{ title issues(first:100, states:[OPEN,CLOSED]){ pageInfo{ hasNextPage endCursor } nodes{ number } } } } } }`;

const ACTOR = "actor{ __typename login }";

const ISSUE_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$name){ issue(number:$number){
    number createdAt
    userContentEdits(first:100){ pageInfo{ hasNextPage endCursor } nodes{ editedAt editor{ __typename login } } }
    timelineItems(first:100, after:$after, itemTypes:[${Object.values(BOARD_WRITE_EVENTS)
      .map(e => e.item)
      .join(",")}]){
      pageInfo{ hasNextPage endCursor }
      nodes{ __typename
        ... on MilestonedEvent{ createdAt ${ACTOR} milestoneTitle }
        ... on DemilestonedEvent{ createdAt ${ACTOR} milestoneTitle }
        ... on LabeledEvent{ createdAt ${ACTOR} label{ name } }
        ... on UnlabeledEvent{ createdAt ${ACTOR} label{ name } }
        ... on BlockedByAddedEvent{ createdAt ${ACTOR} blockingIssue{ number } }
        ... on BlockedByRemovedEvent{ createdAt ${ACTOR} blockingIssue{ number } }
        ... on BlockingAddedEvent{ createdAt ${ACTOR} blockedIssue{ number } }
        ... on BlockingRemovedEvent{ createdAt ${ACTOR} blockedIssue{ number } }
        ... on RenamedTitleEvent{ createdAt ${ACTOR} previousTitle currentTitle }
        ... on AddedToProjectV2Event{ createdAt ${ACTOR} }
        ... on RemovedFromProjectV2Event{ createdAt ${ACTOR} }
        ... on ProjectV2ItemStatusChangedEvent{ createdAt ${ACTOR} status }
      } } } } }`;

type Node = Record<string, unknown>;

/** The family's milestone titles and the issues in them, or why not. */
async function readFamily(
  src: HandEditsSource,
  owner: string,
  name: string,
  prefix: string,
): Promise<{ titles: Set<string>; issues: Set<number> } | { why: string }> {
  const titles = new Set<string>();
  const issues = new Set<number>();
  for (let after: string | null = null; ; ) {
    const page = (await src.graphql(MILESTONES_QUERY, { owner, name, after })) as {
      repository?: { milestones?: { nodes?: Node[]; pageInfo?: unknown } };
    };
    const conn = page.repository?.milestones;
    if (!Array.isArray(conn?.nodes)) return { why: "the response carried no milestone list" };
    for (const m of conn.nodes) {
      const title = typeof m.title === "string" ? m.title : null;
      if (title === null || !inMilestoneFamily(title, prefix)) continue;
      titles.add(title);
      const list = m.issues as { nodes?: Node[]; pageInfo?: unknown } | undefined;
      if (!Array.isArray(list?.nodes)) return { why: `milestone "${title}" carried no issue list` };
      // A family milestone holding more than one page is refused, not cut:
      // the issues past the page would be read as absent.
      if (nextCursor(list.pageInfo).kind !== "done") {
        return { why: `milestone "${title}" holds more issues than one page, so its list was not read to the end` };
      }
      for (const i of list.nodes) if (typeof i.number === "number") issues.add(i.number);
    }
    const next = nextCursor(conn.pageInfo);
    if (next.kind === "done") break;
    if (next.kind === "unreadable") return { why: next.why };
    after = next.cursor;
  }
  if (titles.size === 0) return { why: `no milestone belongs to the ${prefix} family` };
  return { titles, issues };
}

/** One issue's writes, every timeline page read. */
async function readIssueWrites(
  src: HandEditsSource,
  owner: string,
  name: string,
  number: number,
): Promise<{ writes: BoardWrite[] } | { why: string }> {
  let first: Node | null = null;
  const items: unknown[] = [];
  for (let after: string | null = null; ; ) {
    const page = (await src.graphql(ISSUE_QUERY, { owner, name, number, after })) as {
      repository?: { issue?: Node | null };
    };
    const issue = page.repository?.issue;
    if (!issue) return { why: `#${number} could not be read` };
    first ??= issue;
    const conn = issue.timelineItems as { nodes?: unknown[]; pageInfo?: unknown } | undefined;
    if (!Array.isArray(conn?.nodes)) return { why: `#${number} carried no timeline` };
    items.push(...conn.nodes);
    const next = nextCursor(conn.pageInfo);
    if (next.kind === "done") break;
    if (next.kind === "unreadable") return { why: `#${number}'s timeline: ${next.why}` };
    after = next.cursor;
  }
  return boardWritesOf({ ...first, timelineItems: { pageInfo: { hasNextPage: false }, nodes: items } });
}

/**
 * Issues moved into or out of a family milestone since `since` that are not
 * in it now. Without this, an issue taken out of the payload by hand would
 * leave the population, and the edit with it.
 */
async function movedSince(
  src: HandEditsSource,
  titles: Set<string>,
  current: Set<number>,
  since: string,
): Promise<{ issues: Set<number> } | { why: string }> {
  const moved = new Set<number>();
  let last: string | null = null;
  for (let page = 1; ; page++) {
    const events = await src.repoEvents(page);
    if (!Array.isArray(events)) return { why: "the repository's issue events could not be read" };
    let older = false;
    for (const e of events as Node[]) {
      const at = typeof e.created_at === "string" ? e.created_at : null;
      if (at === null) return { why: "a repository issue event carried no time" };
      // The early stop below is only sound newest-first. MEASURED on
      // 2026-11-18: GET /repos/{owner}/{repo}/issues/events returns newest
      // first. Checked on every event rather than trusted, so a feed in any
      // other order refuses instead of ending the read on page 1.
      if (last !== null && at > last) {
        return { why: `the repository's issue events are not newest-first (${at} follows ${last}), so where the window starts cannot be found` };
      }
      last = at;
      if (at < since) {
        older = true;
        continue;
      }
      if (e.event !== "milestoned" && e.event !== "demilestoned") continue;
      const title = (e.milestone as Node | null | undefined)?.title;
      const n = (e.issue as Node | null | undefined)?.number;
      if (typeof title === "string" && titles.has(title) && typeof n === "number" && !current.has(n)) moved.add(n);
    }
    // Newest first, so the first event older than the window ends the read;
    // a short page is the end of the history.
    if (older || events.length < 100) break;
  }
  return { issues: moved };
}

/** The whole reading: writes on every issue the payload holds or held. */
export async function readPayloadWrites(
  src: HandEditsSource,
  repo: string,
  prefix: string,
  pipelineAccount: string,
): Promise<{ writes: BoardWrite[]; issues: number } | { why: string }> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) return { why: `--repo ${JSON.stringify(repo)} is not owner/name` };
  const family = await readFamily(src, owner, name, prefix);
  if ("why" in family) return family;
  const writes: BoardWrite[] = [];
  const read = async (numbers: Iterable<number>): Promise<string | null> => {
    for (const n of numbers) {
      const r = await readIssueWrites(src, owner, name, n);
      if ("why" in r) return r.why;
      writes.push(...r.writes);
    }
    return null;
  };
  const failed = await read([...family.issues].sort((a, b) => a - b));
  if (failed !== null) return { why: failed };
  const opened = windowOpens(writes, pipelineAccount);
  let total = family.issues.size;
  if (opened !== undefined) {
    const moved = await movedSince(src, family.titles, family.issues, opened);
    if ("why" in moved) return moved;
    const again = await read([...moved.issues].sort((a, b) => a - b));
    if (again !== null) return { why: again };
    total += moved.issues.size;
  }
  return { writes, issues: total };
}

function liveSource(repo: string): HandEditsSource {
  const [owner, name] = repo.split("/");
  const client = createGitHubClient() as unknown as {
    graphql: (q: string, v: Record<string, unknown>) => Promise<unknown>;
    request: (route: string, params: Record<string, unknown>) => Promise<{ data: unknown[] }>;
  };
  return {
    graphql: (q, v) => client.graphql(q, v),
    repoEvents: async page => {
      const r = await client.request("GET /repos/{owner}/{repo}/issues/events", {
        owner,
        repo: name,
        per_page: 100,
        page,
      });
      return r.data;
    },
  };
}

export async function main(
  argv: readonly string[],
  deps: { source: (repo: string) => HandEditsSource; pipelineAccount: string | null },
): Promise<{ code: number; lines: string[] }> {
  const { values } = parseArgs({
    args: [...argv],
    options: { prefix: { type: "string" }, repo: { type: "string" } },
    strict: true,
  });
  const given = readMilestonePrefix(values.prefix);
  const prefix = given.kind === "given" ? given.prefix : "";
  const repo = values.repo?.trim() ?? "";
  if (prefix === "" || repo === "") {
    return {
      code: HAND_EDITS_REFUSAL_EXIT,
      lines: [`${COMMAND}: UNMEASURED — --prefix and --repo are both required, e.g. --prefix Convergence --repo owner/name`],
    };
  }
  let read: { writes: BoardWrite[]; issues: number } | { why: string } | null = null;
  if (deps.pipelineAccount !== null) {
    try {
      read = await readPayloadWrites(deps.source(repo), repo, prefix, deps.pipelineAccount);
    } catch (e) {
      // A token without `read:project` is refused here by GitHub. That is
      // UNMEASURED: a status move by hand would be invisible to this read.
      read = { why: `the board could not be read: ${(e as Error).message}` };
    }
  }
  const writes = read !== null && "writes" in read ? read.writes : null;
  const verdict = handEditVerdict(writes, deps.pipelineAccount, read !== null && "why" in read ? read.why : null);
  const issues = read !== null && "issues" in read ? read.issues : 0;
  if (verdict.status === "unmeasured") {
    return { code: HAND_EDITS_REFUSAL_EXIT, lines: [`${COMMAND}: UNMEASURED — ${verdict.why}`] };
  }
  if (verdict.status === "met") {
    return {
      code: 0,
      lines: [
        `${COMMAND}: MET — no board write by a person since ${verdict.since} ` +
          `(${verdict.read} writes read on ${issues} issues in the ${prefix} family)`,
      ],
    };
  }
  return {
    code: HAND_EDITS_REFUSAL_EXIT,
    lines: [
      `${COMMAND}: SHORT — ${verdict.edits.length} hand edit(s) since ${verdict.since} on the ${prefix} family:`,
      ...verdict.edits.map(e => `  ${e}`),
    ],
  };
}

if (import.meta.main) {
  const out = await main(process.argv.slice(2), { source: liveSource, pipelineAccount: readPipelineAccount(process.cwd()) });
  for (const l of out.lines) console.log(l);
  process.exit(out.code);
}
