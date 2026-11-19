#!/usr/bin/env bun
/**
 * `rungate unaccounted-work` — undone work declared in a repository's prose
 * that no open issue covers, by file and line (#2100). The logic is in
 * `lib/unaccounted-work.ts`; this file parses arguments, asks GitHub which
 * cited issues are open, and picks the exit code.
 *
 *   rungate unaccounted-work [--project-root <dir>] [--repo <owner/name>]
 *                            [--since <YYYY-MM-DD>] [--issues-fixture <file.json>]
 *                            [--prs-fixture <file.json>] [--json]
 *
 * `--since` adds pull request bodies as a source (#2489): those merged on or
 * after the date, and every open one.
 *
 * Exit 0: every source read and nothing unaccounted. `EXIT_UNACCOUNTED`:
 * declarations cite no open issue. `EXIT_REFUSED`: a source, a file, or the
 * citations' issue states could not be read, so the report is a floor, not a
 * count.
 *
 * Relative imports are `../lib/` only: `test/unaccounted-work.test.ts`
 * rewrites them to absolute paths to run a mutant from a temp directory.
 */
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";

import { createGitHubClient, parseOwnerRepo } from "../lib/github";
import {
  buildReport,
  citedNumbers,
  discoverSources,
  openIssuesInPage,
  prBodiesSource,
  prsFromSearch,
  renderReport,
  trustedAuthors,
  type PrSearchPage,
  type IssueStates,
  type PrBody,
  type SourceReading,
} from "../lib/unaccounted-work";
import { parseRemoteSlug } from "../lib/verified-push";

/** The one exit for a reading not taken. Assigned once; the test mutates it. */
export const EXIT_REFUSED = 2;
/** Declarations were found that cite no open issue. */
export const EXIT_UNACCOUNTED = 1;

const USAGE =
  "rungate unaccounted-work [--project-root <dir>] [--repo <owner/name>] [--since <YYYY-MM-DD>] [--issues-fixture <file.json>] [--prs-fixture <file.json>] [--json]";

type AuthoredPr = PrBody & { author_association?: string };

/**
 * The one place pull requests become the source, for the fixture and the live
 * read alike. Only a trusted author's body is read (review of #2494: with the
 * filter in the live path alone, no test could see it removed).
 */
function sourceFromPrs(prs: readonly AuthoredPr[]): SourceReading {
  const trusted = trustedAuthors(prs);
  return prBodiesSource({ prs: trusted.map(p => ({ number: p.number, body: p.body })), skipped: prs.length - trusted.length });
}

/** `[{ "number": 12, "body": "…", "author_association": "OWNER" }]`, the shape the live read collects. */
function fixturePrs(path: string): SourceReading {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!Array.isArray(raw)) throw new Error("not an array of { number, body, author_association }");
    const prs: AuthoredPr[] = raw.map(r => {
      const { number, body, author_association } = r as { number?: unknown; body?: unknown; author_association?: unknown };
      if (typeof number !== "number" || (body !== null && typeof body !== "string")) throw new Error("an entry is not { number, body }");
      return { number, body, author_association: typeof author_association === "string" ? author_association : undefined };
    });
    return sourceFromPrs(prs);
  } catch (e) {
    return prBodiesSource({ kind: "UNMEASURED", why: `--prs-fixture ${path} could not be read (${(e as Error).message})` });
  }
}

/** Pull requests merged on or after `since`, and every open one, with their bodies. */
async function fetchPrBodies(repo: string | null, since: string): Promise<SourceReading> {
  if (!repo) {
    return prBodiesSource({ kind: "UNMEASURED", why: "no repository to read pull requests from: pass --repo, or give the tree an origin remote" });
  }
  try {
    const client = createGitHubClient();
    const seen = new Map<number, AuthoredPr>();
    const query = `query($q: String!, $after: String) {
      search(query: $q, type: ISSUE, first: 100, after: $after) {
        issueCount
        pageInfo { hasNextPage endCursor }
        nodes { ... on PullRequest { number body authorAssociation } }
      }
    }`;
    for (const q of [`repo:${repo} is:pr merged:>=${since}`, `repo:${repo} is:pr is:open`]) {
      const pages: PrSearchPage[] = [];
      let after: string | null = null;
      do {
        const data = (await client.graphql(query, { q, after })) as { search: PrSearchPage };
        pages.push(data.search);
        after = data.search.pageInfo.hasNextPage ? data.search.pageInfo.endCursor : null;
      } while (after);
      const read = prsFromSearch(pages);
      if ("why" in read) return prBodiesSource({ kind: "UNMEASURED", why: `${q}: ${read.why}` });
      for (const it of read.prs) seen.set(it.number, it);
    }
    return sourceFromPrs([...seen.values()].sort((a, b) => b.number - a.number));
  } catch (e) {
    return prBodiesSource({ kind: "UNMEASURED", why: `GitHub could not list the pull requests (${(e as Error).message})` });
  }
}

/** `{ "12": "OPEN", "13": "CLOSED" }`; a number absent from it is not open. */
function fixtureStates(path: string): IssueStates {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    return { kind: "READ", open: new Set(Object.entries(raw).filter(([, s]) => s === "OPEN").map(([n]) => Number(n))) };
  } catch (e) {
    return { kind: "UNMEASURED", why: `--issues-fixture ${path} could not be read (${(e as Error).message})` };
  }
}

/** The repository citations are checked against: `--repo`, else the origin remote's. */
function repoFor(root: string, flag: string | undefined): string | null {
  if (flag) return flag;
  const r = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf-8", timeout: 5000 });
  return r.status === 0 ? parseRemoteSlug(r.stdout) : null;
}

/** Which of `numbers` are open issues. A PR, a missing number or a closed issue is not. */
async function liveStates(repo: string, numbers: readonly number[]): Promise<IssueStates> {
  try {
    const { owner, repo: name } = parseOwnerRepo(repo);
    const client = createGitHubClient();
    const open = new Set<number>();
    for (let i = 0; i < numbers.length; i += 50) {
      const chunk = numbers.slice(i, i + 50);
      const fields = chunk.map(n => `n${n}: issueOrPullRequest(number: ${n}) { __typename ... on Issue { state } }`).join("\n");
      const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
      let data: any;
      try {
        data = await client.graphql(query, { owner, name });
      } catch (e) {
        // A number that names nothing fails the whole query but still returns
        // the rest. Without that partial data, nothing was read.
        data = (e as { data?: unknown }).data;
        if (!data) throw e;
      }
      for (const n of openIssuesInPage(data, chunk)) open.add(n);
    }
    return { kind: "READ", open };
  } catch (e) {
    return { kind: "UNMEASURED", why: `GitHub could not say which cited issues are open (${(e as Error).message})` };
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  let rootArg: string | undefined;
  let repoArg: string | undefined;
  let fixture: string | undefined;
  let prsFixture: string | undefined;
  let since: string | undefined;
  let asJson = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") asJson = true;
    else if (a === "--project-root" || a === "--repo" || a === "--issues-fixture" || a === "--prs-fixture" || a === "--since") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        console.error(`UNMEASURED: ${a} needs a value after it. Usage: ${USAGE}. Nothing was read.`);
        return EXIT_REFUSED;
      }
      if (a === "--project-root") rootArg = next;
      else if (a === "--repo") repoArg = next;
      else if (a === "--prs-fixture") prsFixture = next;
      else if (a === "--since") {
        // A calendar date, checked as one, so a typo is refused rather than
        // handed to GitHub's search and read back as "no pull requests".
        // Round-tripped, because Date.parse rolls 2026-02-30 over to March 2
        // rather than refusing it (review of #2494).
        const at = new Date(`${next}T00:00:00Z`);
        // UTC-INTENTIONAL: --since is a calendar date read as UTC midnight, and the round-trip compares it in that same zone.
        if (!/^\d{4}-\d{2}-\d{2}$/.test(next) || Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== next) {
          console.error(`UNMEASURED: --since needs a date as YYYY-MM-DD, not ${JSON.stringify(next)}. Nothing was read.`);
          return EXIT_REFUSED;
        }
        since = next;
      } else fixture = next;
      i++;
    } else {
      console.error(`UNMEASURED: unknown argument ${JSON.stringify(a)}. Usage: ${USAGE}. Nothing was read.`);
      return EXIT_REFUSED;
    }
  }
  // Review of #2494: the fixture replaces the live read, so naming both is a
  // contradiction, refused like every other bad input rather than settled silently.
  if (prsFixture && since) {
    console.error(`UNMEASURED: --prs-fixture and --since both name where pull requests come from; pass one. Usage: ${USAGE}. Nothing was read.`);
    return EXIT_REFUSED;
  }
  const root = resolve(rootArg ?? process.cwd());
  const sources = discoverSources(root, homedir());
  // #2489: pull request bodies, only when asked for — a plain run stays local.
  sources.push(
    prsFixture
      ? fixturePrs(prsFixture)
      : since
        ? await fetchPrBodies(repoFor(root, repoArg), since)
        : prBodiesSource({ kind: "ABSENT", why: "pull request bodies are read only with --since <YYYY-MM-DD>" }),
  );
  const cited = citedNumbers(sources);
  let states: IssueStates;
  if (fixture) states = fixtureStates(fixture);
  else if (cited.length === 0) states = { kind: "READ", open: new Set() };
  else {
    const repo = repoFor(root, repoArg);
    states = repo
      ? await liveStates(repo, cited)
      : { kind: "UNMEASURED", why: "no repository to check citations against: pass --repo, or give the tree an origin remote" };
  }
  const report = buildReport(root, sources, cited, states);
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else console.log(renderReport(report).join("\n"));
  if (report.unmeasured.length > 0) return EXIT_REFUSED;
  return report.unaccounted.length > 0 ? EXIT_UNACCOUNTED : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
