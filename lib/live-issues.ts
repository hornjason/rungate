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

/**
 * Does this milestone belong to the spec family named by `prefix`?
 *
 * ONE binding, called by `plan-deps` and `board-snapshot`. They ask the same
 * question about the same input, and two guards that do that are
 * behaviourally one — a mutation of either leaves the other holding the case
 * up, and both read as covered while one is dead.
 *
 * The anchor is `<prefix> Phase `, not a bare `startsWith(prefix)`.
 * `lib/spec-placement.ts` builds every derived title as
 * `${prefix} ${heading}` where the heading is `Phase N` or `Phase N — text`,
 * so that string is the family's actual shape. A bare prefix test admits any
 * family whose name merely BEGINS with this one — `Pipe` matching
 * `Pipeline Phase 0`, `Fix` matching `Fixture Phase 2` — which is the
 * cross-spec contamination the prefix exists to prevent, arriving through
 * the fix for it. Round 2 of #1703.
 */
export function inMilestoneFamily(milestone: string | null | undefined, prefix: string): boolean {
  return (milestone ?? "").startsWith(`${prefix} Phase `);
}

/**
 * One issue, as the dependency order needs it.
 *
 * `DepIssue` exactly, for now. The alias names the seam a later reading
 * widens, and keeps both consumers importing one type rather than one
 * importing the other's.
 */
export type LiveIssue = DepIssue;

export const LIVE_ISSUES_QUERY = `
query($owner:String!,$name:String!,$states:[IssueState!],$after:String){
  repository(owner:$owner,name:$name){
    issues(first:${ISSUE_PAGE},after:$after,states:$states){
      pageInfo{hasNextPage endCursor}
      nodes{
        number
        state
        milestone{title}
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
