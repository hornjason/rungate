/**
 * The population the active milestone is read over: every OPEN issue in the
 * repository (#2037).
 *
 * `activeMilestone` in `lib/board-ready-rule.ts` decides the focus; this
 * module only reads what it decides over. `scripts/board-ready.ts` already
 * read the whole repository (its labels pass), `scripts/work-status.ts` did
 * too, and `scripts/board-mirror.ts` read the open cards on the project
 * board instead — so an earlier-phase issue that never reached the board (a
 * failed intake run) moved the hand-run writer's focus and nobody else's.
 *
 * ## A partial read is UNMEASURED, never a short list
 *
 * A shorter list is exactly what a repository with fewer open issues
 * produces, and fewer open issues in a low phase moves the focus FORWARD. So
 * any page that cannot be read — no repository, no issues connection, a
 * `pageInfo` that cannot say whether more exist, a thrown request — returns
 * `null`, and the caller does not compute a focus from it.
 */
import { nextCursor } from "./graphql-cursor";

export const OPEN_MILESTONES_QUERY = `query($o:String!,$n:String!,$c:String){repository(owner:$o,name:$n){issues(first:100,after:$c,states:[OPEN]){pageInfo{hasNextPage endCursor} nodes{milestone{title}}}}}`;

export type GraphQlFn = (query: string, vars: Record<string, unknown>) => Promise<any>;

export async function readOpenIssueMilestones(
  gql: GraphQlFn,
  owner: string,
  name: string,
): Promise<{ milestone: string | null }[] | null> {
  const out: { milestone: string | null }[] = [];
  let c: string | null = null;
  try {
    do {
      const d = await gql(OPEN_MILESTONES_QUERY, { o: owner, n: name, c });
      // No `if (!page) return null` guard: a missing repository or
      // connection throws on the next line and the `catch` returns the same
      // `null`. Two guards for one answer is a guard no test can see die
      // (`.claude/rules/checks-must-be-able-to-fail.md`).
      const page = d?.repository?.issues;
      for (const i of page.nodes) out.push({ milestone: i?.milestone?.title ?? null });
      const step = nextCursor(page.pageInfo);
      if (step.kind === "unreadable") return null;
      c = step.kind === "more" ? step.cursor : null;
    } while (c);
  } catch {
    return null;
  }
  return out;
}
