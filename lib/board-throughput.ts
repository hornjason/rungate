/**
 * How much this repository actually delivered, and over how long.
 *
 * Covers SC-2713, SC-2714 (specs/BOARD-FLOW-SPEC.md).
 *
 * Ready's depth is derived from this (`lib/board-ready-rule.ts`), so the
 * window and what counts as delivery are decisions, not details — and they
 * live in one place because three callers need the same answer. Two callers
 * reading two windows would reproduce the defect the ready rule was written
 * to remove: a writer and a reading disagreeing about the same lane with no
 * single site a mutation could move.
 *
 * **No token, no network of its own.** The caller injects `gql`, which is
 * what makes this testable without a credential — and a credential is the
 * thing that turns a measurement into a thing nobody re-runs.
 */

import type { Throughput } from "./board-ready-rule";

/**
 * The window throughput is measured over.
 *
 * Two weeks: long enough that one quiet day does not halve Ready's depth,
 * short enough that a swarm starting is visible inside a day or two.
 *
 * **It is the live decision, and the readings say why.** Measured
 * 2026-11-05 on this repository: 9 delivered in 7 days, 132 in 14, 646 in
 * 30 — a factor of ten between the shortest and longest window, because 30
 * days contains a swarm and the last 7 do not. The resulting depths are 1,
 * 4 and 10. Anyone changing this number is changing Ready's size, and that
 * is the honest place for the argument to happen.
 *
 * Raw days rather than working days, deliberately: a window that skipped
 * weekends would raise the rate above the speed the queue actually drains.
 */
export const THROUGHPUT_DAYS = 14;

/** What `measureThroughput` needs from a GraphQL client. */
export type GqlFn = (query: string, variables: Record<string, unknown>) => Promise<any>;

export const CLOSED_ISSUES_QUERY = `query($o:String!,$n:String!,$c:String){repository(owner:$o,name:$n){
    issues(states:CLOSED,first:100,after:$c){pageInfo{hasNextPage endCursor} nodes{stateReason closedAt}}}}`;

/**
 * Issues delivered inside the window, and the window.
 *
 * `null` when the pass could not complete. **Not zero** — a failed read and
 * a quiet fortnight are opposite facts wearing the same digit, and
 * collapsing them produces a Ready depth of 1 out of a measurement that
 * never happened (`.claude/rules/config-access.md`).
 *
 * **Delivered, not merely closed.** A cancellation leaves the system
 * without adding capacity, so counting it would deepen the queue exactly
 * when the repository is abandoning work. On 2026-11-05 that was 4 of 136
 * closures over the window — small, and in the wrong direction.
 *
 * This pages every closed issue rather than running one search, for the
 * reason recorded in `scripts/work-status.ts` beside the cancelled count:
 * **a search qualifier the index does not understand returns the same zero
 * as a true zero**, measured with a control (`reason:bogusvalue` → 0).
 */
export async function measureThroughput(
  gql: GqlFn,
  owner: string,
  name: string,
  now: number = Date.now(),
  days: number = THROUGHPUT_DAYS,
): Promise<Throughput | null> {
  const since = now - days * 86_400_000;
  let delivered = 0;
  let c: string | null = null;
  try {
    do {
      const d = await gql(CLOSED_ISSUES_QUERY, { o: owner, n: name, c });
      const page = d?.repository?.issues;
      // A response that resolved to no page is not an empty repository.
      // `gql` returns normally for a successful query against a node it
      // could not resolve, so this is the only place the difference shows.
      if (!page?.nodes) return null;
      for (const i of page.nodes) {
        if (i?.stateReason !== "COMPLETED") continue;
        const at = Date.parse(i.closedAt ?? "");
        if (Number.isFinite(at) && at >= since) delivered++;
      }
      c = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
    } while (c);
  } catch {
    // Deliberately swallowed and converted to the UNMEASURED value, which
    // every caller already refuses on. Letting it throw would take down a
    // board write for a count that only sizes a queue.
    return null;
  }
  return { delivered, days };
}
