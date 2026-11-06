/**
 * Covers SC-2713, SC-2714, SC-2717, SC-2718 (specs/BOARD-FLOW-SPEC.md).
 *
 * ## The mutation battery, predicted before it was run
 *
 *   mutant                                            reading   predicted
 *   the COMPLETED filter dropped                        1          2
 *   the window test dropped (every closure counts)      3          2
 *   the catch returns {delivered:0} instead of null     2          1
 *   the unresolvable-page guard dropped                 0          1
 *
 * **Three of four predictions were wrong, and the fourth is the finding.**
 * The three misses are all the same error — I predicted a TOTAL instead of
 * naming the rows, so I missed that the window mutant also breaks the
 * override case and the unparseable-date case, and that the `null` mutant
 * breaks its own control as well as its case.
 *
 * Mutant 4 reading **zero** is not a weak test, it is dead code: the guard
 * `if (!page?.nodes) return null` caught nothing the `catch` below did not
 * already convert to the same value, so no behavioural case could ever
 * distinguish them. The guard is gone; the case stays, because the
 * BEHAVIOUR it asserts is still required — it was only the second decider
 * that was redundant.
 *
 * Readings are in the PR body.
 *
 * **The client is injected, so these cases run with no token.** A test that
 * needs a credential is a test that stops being run, and the measurement
 * this file guards is the one that sizes Ready.
 */
import { describe, expect, test } from "bun:test";
import { CLOSED_ISSUES_QUERY, THROUGHPUT_DAYS, measureClosedIssues } from "../lib/board-throughput";

/**
 * Throughput only, for the cases that are about the rate.
 *
 * The cancelled count rides on the same pass and has its own cases below;
 * threading it through every rate assertion would make each one read like
 * it cared about both.
 */
const measureThroughput = async (...a: Parameters<typeof measureClosedIssues>) =>
  (await measureClosedIssues(...a))?.throughput ?? null;

const NOW = Date.parse("2026-11-05T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

/** A fake client that serves fixed pages and records what it was asked. */
function fake(pages: { nodes: unknown[]; next?: string | null; pageInfo?: unknown }[]) {
  const asked: Record<string, unknown>[] = [];
  const gql = async (_q: string, v: Record<string, unknown>) => {
    asked.push(v);
    const page = pages[asked.length - 1]!;
    return {
      repository: {
        issues: {
          nodes: page.nodes,
          // `"pageInfo" in page` rather than `page.pageInfo ?? …`, so a
          // case can plant an ABSENT pageInfo and a case can plant an
          // explicitly undefined one. `??` would spell those the same, and
          // the absent one is the shape the finding was about.
          pageInfo: "pageInfo" in page ? page.pageInfo : { hasNextPage: page.next != null, endCursor: page.next ?? null },
        },
      },
    };
  };
  return { gql, asked };
}

describe("SC-2713: throughput counts delivery, inside a window", () => {
  test("a closure inside the window counts and one outside it does not", async () => {
    const { gql } = fake([
      {
        nodes: [
          { stateReason: "COMPLETED", closedAt: daysAgo(1) },
          { stateReason: "COMPLETED", closedAt: daysAgo(13) },
          { stateReason: "COMPLETED", closedAt: daysAgo(15) },
          { stateReason: "COMPLETED", closedAt: daysAgo(400) },
        ],
      },
    ]);
    expect(await measureThroughput(gql, "o", "n", NOW)).toEqual({ delivered: 2, days: 14 });
  });

  // A cancellation leaves the system without adding capacity, so counting
  // it would deepen Ready exactly when the repository is abandoning work.
  test("a cancellation inside the window is not delivery", async () => {
    const { gql } = fake([
      {
        nodes: [
          { stateReason: "COMPLETED", closedAt: daysAgo(1) },
          { stateReason: "NOT_PLANNED", closedAt: daysAgo(1) },
          { stateReason: "DUPLICATE", closedAt: daysAgo(2) },
          { stateReason: null, closedAt: daysAgo(2) },
        ],
      },
    ]);
    expect(await measureThroughput(gql, "o", "n", NOW)).toEqual({ delivered: 1, days: 14 });
  });

  test("every page is read, not just the first", async () => {
    const { gql, asked } = fake([
      { nodes: [{ stateReason: "COMPLETED", closedAt: daysAgo(1) }], next: "c1" },
      { nodes: [{ stateReason: "COMPLETED", closedAt: daysAgo(2) }], next: "c2" },
      { nodes: [{ stateReason: "COMPLETED", closedAt: daysAgo(3) }] },
    ]);
    expect((await measureThroughput(gql, "o", "n", NOW))?.delivered).toBe(3);
    expect(asked.map(a => a.c), "a reader that stops at page one undercounts and shrinks Ready").toEqual([
      null,
      "c1",
      "c2",
    ]);
  });

  test("an unparseable or missing closedAt is not counted", async () => {
    const { gql } = fake([
      {
        nodes: [
          { stateReason: "COMPLETED", closedAt: "not a date" },
          { stateReason: "COMPLETED" },
          { stateReason: "COMPLETED", closedAt: daysAgo(1) },
        ],
      },
    ]);
    expect((await measureThroughput(gql, "o", "n", NOW))?.delivered).toBe(1);
  });

  test("a repository that delivered nothing reads zero, which is a measurement", async () => {
    const { gql } = fake([{ nodes: [] }]);
    expect(
      await measureThroughput(gql, "o", "n", NOW),
      "zero delivered is a real reading and must not spell the same as a failed one",
    ).toEqual({ delivered: 0, days: 14 });
  });

  test("the window is the one constant, and callers may override it", async () => {
    expect(THROUGHPUT_DAYS).toBe(14);
    const { gql } = fake([
      {
        nodes: [
          { stateReason: "COMPLETED", closedAt: daysAgo(1) },
          { stateReason: "COMPLETED", closedAt: daysAgo(10) },
        ],
      },
    ]);
    expect(await measureThroughput(gql, "o", "n", NOW, 7)).toEqual({ delivered: 1, days: 7 });
  });

  // The query is the instrument. A page that stopped asking for
  // `stateReason` would read every closure as undelivered and Ready would
  // collapse to a depth of 1 with nothing red.
  test("the query asks for both fields the count depends on", () => {
    expect(CLOSED_ISSUES_QUERY).toContain("stateReason");
    expect(CLOSED_ISSUES_QUERY).toContain("closedAt");
    expect(CLOSED_ISSUES_QUERY, "a reader with no cursor silently reads page one forever").toContain(
      "endCursor",
    );
  });
});

describe("SC-2714: a pass that did not complete is UNMEASURED, never zero", () => {
  test("a throwing client reads null, not an empty repository", async () => {
    const boom = async () => {
      throw new Error("502");
    };
    expect(
      await measureThroughput(boom, "o", "n", NOW),
      "returning zero here gives Ready a depth of 1 out of a read that never happened",
    ).toBeNull();
  });

  test("a response that resolved to no page reads null", async () => {
    const empty = async () => ({ repository: null });
    expect(await measureThroughput(empty, "o", "n", NOW)).toBeNull();
  });

  // The control for the two cases above: a failure and a quiet fortnight
  // must not produce the same value, and the only way to know is to assert
  // that the success case does NOT return null.
  test("a readable but quiet repository is distinguishable from a failure", async () => {
    const { gql } = fake([{ nodes: [] }]);
    const quiet = await measureThroughput(gql, "o", "n", NOW);
    const failed = await measureThroughput(async () => {
      throw new Error("x");
    }, "o", "n", NOW);
    expect(quiet).not.toBeNull();
    expect(failed).toBeNull();
  });
});

describe("SC-2717: a page whose pageInfo cannot be read is UNMEASURED, not the last page", () => {
  // ai-review on #1793. `page.pageInfo?.hasNextPage` ended the loop for a
  // malformed page and returned a CONFIDENT partial count — silent
  // truncation reported as a measurement, and inconsistent with the line
  // above where a missing `nodes` throws into the catch.
  test("a page carrying nodes but no pageInfo refuses", async () => {
    const { gql } = fake([
      { nodes: [{ stateReason: "COMPLETED", closedAt: daysAgo(1) }], pageInfo: undefined },
    ]);
    expect(
      await measureThroughput(gql, "o", "n", NOW),
      "ending the loop here returns 1 delivered from a page that may have had a thousand more",
    ).toBeNull();
  });

  test("a pageInfo whose hasNextPage is not a boolean refuses", async () => {
    const { gql } = fake([{ nodes: [], pageInfo: { hasNextPage: "yes", endCursor: "c1" } }]);
    expect(await measureThroughput(gql, "o", "n", NOW)).toBeNull();
  });

  // The cursor half. `hasNextPage: true` with no usable cursor would loop
  // forever or re-request page one; refusing is the only honest answer.
  test("a page that says there is more and gives no cursor refuses", async () => {
    const { gql } = fake([{ nodes: [], pageInfo: { hasNextPage: true, endCursor: null } }]);
    expect(await measureThroughput(gql, "o", "n", NOW)).toBeNull();
  });

  // The control: a well-formed terminal page must still be a reading, or
  // the three cases above are just "everything refuses".
  test("a well-formed last page is a reading, not a refusal", async () => {
    const { gql } = fake([{ nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }]);
    expect(await measureThroughput(gql, "o", "n", NOW)).toEqual({ delivered: 0, days: 14 });
  });
});

describe("SC-2718: one pass answers both readings", () => {
  test("cancellations and delivery come from the same pass", async () => {
    const { gql, asked } = fake([
      {
        nodes: [
          { stateReason: "COMPLETED", closedAt: daysAgo(1) },
          { stateReason: "NOT_PLANNED", closedAt: daysAgo(1) },
          { stateReason: "DUPLICATE", closedAt: daysAgo(900) },
        ],
      },
    ]);
    expect(await measureClosedIssues(gql, "o", "n", NOW)).toEqual({
      throughput: { delivered: 1, days: 14 },
      cancelled: 2,
    });
    expect(asked.length, "two passes over every closed issue is the cost ai-review flagged").toBe(1);
  });

  // Both reasons, because the spec's condition is both. Counting only
  // `not_planned` turns a Cancelled lane short by every duplicate into one
  // that reads OK.
  test("a duplicate closure is a cancellation", async () => {
    const { gql } = fake([{ nodes: [{ stateReason: "DUPLICATE", closedAt: daysAgo(1) }] }]);
    expect((await measureClosedIssues(gql, "o", "n", NOW))?.cancelled).toBe(1);
  });

  // The window applies to delivery and NOT to cancellations: one is a
  // rate, the other is the Cancelled lane's denominator over all time.
  test("cancellations are counted over all time, delivery only inside the window", async () => {
    const { gql } = fake([
      {
        nodes: [
          { stateReason: "NOT_PLANNED", closedAt: daysAgo(900) },
          { stateReason: "COMPLETED", closedAt: daysAgo(900) },
        ],
      },
    ]);
    expect(await measureClosedIssues(gql, "o", "n", NOW)).toEqual({
      throughput: { delivered: 0, days: 14 },
      cancelled: 1,
    });
  });

  test("a failed pass gives neither reading, rather than one of them", async () => {
    const boom = async () => {
      throw new Error("502");
    };
    expect(
      await measureClosedIssues(boom, "o", "n", NOW),
      "two separate nulls invite a caller to believe one of them",
    ).toBeNull();
  });
});
