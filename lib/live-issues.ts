/**
 * The repository's issues as the board readings need them — one reader.
 *
 * `scripts/plan-deps.ts` has read issues, their phase milestone and their
 * live `blocked by` edges since ADR-003 step 5. `scripts/board-snapshot.ts`
 * (item **B3**) needs exactly the same reading to say whether the order is
 * on the tracker. Copying the query would make two readers of one fact, and
 * `.claude/rules/checks-must-be-able-to-fail.md` names that shape: two
 * deciders that agree are behaviourally one, so no behavioural test can tell
 * them apart and a mutation of either leaves the other holding the case up.
 *
 * So the query, its page size and the subprocess live here, and both
 * consumers call {@link readLiveIssues}.
 *
 * ## Labels come back too, and they are read rather than assumed
 *
 * {@link LiveIssue} carries `labels` because the snapshot has to say
 * something about them: `board-conformance`'s `queue-label` reading counts
 * issues carrying `engine`, and emitting an empty list for every issue would
 * report a number nobody measured. One extra field on a query already being
 * run is the honest option — the alternative is a zero that happens to be
 * right.
 *
 * ## It never writes
 *
 * `plan-deps --write` applies edges. This reads them.
 */
import type { DepIssue } from "./spec-deps";

/**
 * Page size, for the issue list and for each issue's blocker connection.
 *
 * The blocker connection matters more than the issue list: a second page of
 * issues is followed, and a second page of BLOCKERS is reported as
 * {@link LiveIssue.blockedByTruncated} rather than followed, because an edge
 * past the boundary reads as missing and would be re-added.
 */
export const ISSUE_PAGE = 100;

/** One issue, with everything a board reading asks about it. */
export interface LiveIssue extends DepIssue {
  /** Every label name on the issue, as GitHub spells them. */
  readonly labels: readonly string[];
  /**
   * True when the LABEL list was cut — a paged connection reporting another
   * page. Same reasoning as {@link DepIssue.blockedByTruncated}, and here
   * for the same reason: `board-conformance`'s `queue-label` reading asks
   * `labels.includes("engine")`, so a label past the boundary reads as
   * absent and the issue counts short having been looked at wrong.
   *
   * Every paged connection in {@link LIVE_ISSUES_QUERY} now either carries
   * a truncation flag or is followed to the end. Round 1 of #1703 found
   * this on `labels` alone; it is recorded as the property because
   * repairing one member of a population leaves the next one silent.
   */
  readonly labelsTruncated?: boolean;
}

export const LIVE_ISSUES_QUERY = `
query($owner:String!,$name:String!,$states:[IssueState!],$after:String){
  repository(owner:$owner,name:$name){
    issues(first:${ISSUE_PAGE},after:$after,states:$states){
      pageInfo{hasNextPage endCursor}
      nodes{
        number
        state
        milestone{title}
        labels(first:${ISSUE_PAGE}){pageInfo{hasNextPage} nodes{name}}
        blockedBy(first:${ISSUE_PAGE}){pageInfo{hasNextPage} nodes{number}}
      }
    }
  }
}`;

/** One shape of the GraphQL page, so nothing below is inferred as `any`. */
interface IssuePage {
  pageInfo: { hasNextPage: boolean; endCursor: string };
  nodes: {
    number: number;
    state: string;
    milestone: { title: string } | null;
    labels: { pageInfo: { hasNextPage: boolean }; nodes: { name: string }[] } | null;
    blockedBy: { pageInfo: { hasNextPage: boolean }; nodes: { number: number }[] } | null;
  }[];
}

/**
 * `gh`, with `GH_TOKEN` unset.
 *
 * Deleted rather than set to `undefined`: spreading `process.env` and
 * overwriting one key with `undefined` leaves the key PRESENT in the object
 * Bun hands the child, and `gh` prefers `GH_TOKEN` to its own keychain
 * whenever the variable exists at all.
 */
export function ghWithoutGhToken(args: readonly string[]): string {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.GH_TOKEN;
  const proc = Bun.spawnSync(["gh", ...args], { env });
  if (proc.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(proc.stderr).trim().slice(0, 300));
  }
  return new TextDecoder().decode(proc.stdout);
}

/** How a GraphQL call is made. Injected so the mapping below has a test. */
export type GraphQlExec = (args: readonly string[]) => string;

/**
 * Every issue in the repository, paged to the end.
 *
 * Throws on a failed call rather than returning an empty list. A caller that
 * cannot tell "the repository has no issues" from "the call failed" reports
 * the flattering one.
 *
 * `exec` is a parameter because both consumers inject a fake at the
 * `readIssues` seam ABOVE this function, so without it the field mapping and
 * the pagination loop — the only logic this module has — run in no test.
 * Round 1 of #1703.
 */
export async function readLiveIssues(
  repo: string,
  includeClosed: boolean,
  exec: GraphQlExec = ghWithoutGhToken,
): Promise<LiveIssue[]> {
  const [owner, name] = repo.split("/");
  const out: LiveIssue[] = [];
  let after: string | null = null;
  for (;;) {
    const raw = exec([
      "api",
      "graphql",
      "-f",
      `query=${LIVE_ISSUES_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      ...(includeClosed ? [] : ["-f", "states=OPEN"]),
      ...(after === null ? [] : ["-f", `after=${after}`]),
    ]);
    const page = (JSON.parse(raw) as { data: { repository: { issues: IssuePage } } }).data
      .repository.issues;
    for (const n of page.nodes) {
      out.push({
        number: n.number,
        state: n.state,
        milestone: n.milestone?.title ?? null,
        labels: (n.labels?.nodes ?? []).map(l => l.name),
        labelsTruncated: n.labels?.pageInfo.hasNextPage === true,
        blockedBy: (n.blockedBy?.nodes ?? []).map(b => b.number),
        // A second page means this list is CUT, not short. `dependencyPlan`
        // refuses rather than deriving from it: an unread blocker past the
        // boundary reads as missing and gets re-added.
        blockedByTruncated: n.blockedBy?.pageInfo.hasNextPage === true,
      });
    }
    if (!page.pageInfo.hasNextPage) return out;
    after = page.pageInfo.endCursor;
  }
}
