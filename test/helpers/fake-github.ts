/**
 * A loopback GitHub, so `scripts/board-ready.ts` can be RUN rather than read.
 *
 * #1935: nothing executed that script's `main()` past its argument and
 * credential guards. Ten source-census assertions read its text, and not one
 * of them can see an edit that passes the wrong collection into a correct
 * function. This is the endpoint that makes the script drivable — it answers
 * every query `main()` sends and **records every mutation**, so a case can
 * assert which item id was written to which option id.
 *
 * It dispatches on the query TEXT rather than on a parsed AST, which is
 * deliberate and is the one thing to know before extending it: a query this
 * file does not recognise is answered with an `errors` array naming it, never
 * with an empty success. An unrecognised query answered `{}` would make the
 * script refuse for an instrument reason and the case would read as a board
 * that legitimately had nothing to move — the sixth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`, two mechanisms behind one
 * observable.
 */

/** One card on the planted board. */
export interface FakeItem {
  readonly itemId: string;
  readonly number: number;
  readonly typename?: "Issue" | "PullRequest";
  readonly state?: "OPEN" | "CLOSED";
  /** The Status cell, or `null` for a card with no column. */
  readonly status: string | null;
  readonly blockedBy?: number;
  readonly assignees?: number;
  readonly milestone?: string | null;
  readonly labels?: readonly string[];
}

export interface FakePlan {
  readonly projectId: string;
  /** Every card on the board, Ready incumbents included. */
  readonly items: readonly FakeItem[];
  /** Open issues the repository holds — the top-up candidate pool. */
  readonly openIssues: readonly number[];
  readonly statusFieldId: string;
  /** Status option name to option id. A name absent here does not exist. */
  readonly options: Readonly<Record<string, string>>;
  /** The acting identity's permission, as the REST endpoint reports it. */
  readonly permission?: string;
  /** How many issues closed as COMPLETED inside the throughput window. */
  readonly delivered?: number;
}

/** One `updateProjectV2ItemFieldValue` the script actually sent. */
export interface RecordedWrite {
  readonly itemId: string;
  readonly optionId: string;
  readonly fieldId: string;
  readonly projectId: string;
}

export interface FakeGitHub {
  readonly url: string;
  /** Every mutation, in the order the script sent them. */
  readonly writes: RecordedWrite[];
  /** Queries this fixture did not recognise — a case must assert it is empty. */
  readonly unknownQueries: string[];
  stop(): Promise<void>;
}

function issueNode(plan: FakePlan, number: number): Record<string, unknown> {
  const item = plan.items.find(i => i.number === number);
  return {
    number,
    state: item?.state ?? "OPEN",
    milestone: item?.milestone == null ? null : { title: item.milestone },
    assignees: { totalCount: item?.assignees ?? 0 },
    issueDependenciesSummary: { blockedBy: item?.blockedBy ?? 0 },
    projectItems: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes:
        item === undefined
          ? []
          : [
              {
                id: item.itemId,
                project: { id: plan.projectId },
                fieldValues: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes:
                    item.status === null
                      ? []
                      : [
                          {
                            name: item.status,
                            optionId: plan.options[item.status] ?? null,
                            field: { id: plan.statusFieldId, name: "Status" },
                          },
                        ],
                },
              },
            ],
    },
  };
}

function boardNode(plan: FakePlan, item: FakeItem): Record<string, unknown> {
  return {
    id: item.itemId,
    fieldValues: {
      pageInfo: { hasNextPage: false },
      nodes:
        item.status === null
          ? []
          : [{ name: item.status, field: { name: "Status" } }],
    },
    content: {
      __typename: item.typename ?? "Issue",
      number: item.number,
      state: item.state ?? "OPEN",
      milestone: item.milestone == null ? null : { title: item.milestone },
      issueDependenciesSummary: { blockedBy: item.blockedBy ?? 0 },
    },
  };
}

/**
 * Bind a fixture GitHub on an ephemeral loopback port.
 *
 * `port: 0` rather than a fixed number, because two suites on one machine
 * binding the same port is a flake that reads as a product defect.
 */
export function startFakeGitHub(plan: FakePlan): FakeGitHub {
  const writes: RecordedWrite[] = [];
  const unknownQueries: string[] = [];

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);

      // The trust gate's REST read, taken before any GraphQL.
      if (url.pathname.endsWith("/permission")) {
        return Response.json({ permission: plan.permission ?? "admin" });
      }

      if (url.pathname !== "/graphql") {
        return new Response("not found", { status: 404 });
      }

      const body = (await req.json()) as { query: string; variables: Record<string, any> };
      const q = body.query;
      const v = body.variables ?? {};

      // **The order is load-bearing, and here is the pair that makes it so.**
      // `BLOCKING_QUERY` and `TOP_UP_QUERY` BOTH contain
      // `projectItems(first:20)` — deliberately, because the script depends
      // on the two sources returning the same node shape — so the `blocking`
      // branch has to be tested first or a fan-out is answered with the
      // top-up's payload. Nothing else here collides: the mutation text
      // contains no `node`, and `items(first:100` appears only in the board
      // page query. Round 2 of #1982's review caught this comment claiming
      // the mutation was the collision, which it is not.
      if (q.includes("updateProjectV2ItemFieldValue")) {
        writes.push({ itemId: v.i, optionId: v.o, fieldId: v.f, projectId: v.p });
        return Response.json({
          data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: v.i } } },
        });
      }

      if (q.includes(`field(name: "Status")`)) {
        return Response.json({
          data: {
            node: {
              field: {
                id: plan.statusFieldId,
                options: Object.entries(plan.options).map(([name, id]) => ({ id, name })),
              },
            },
          },
        });
      }

      if (q.includes("states:CLOSED")) {
        const delivered = plan.delivered ?? 20;
        return Response.json({
          data: {
            repository: {
              issues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: Array.from({ length: delivered }, () => ({
                  stateReason: "COMPLETED",
                  closedAt: new Date().toISOString(),
                })),
              },
            },
          },
        });
      }

      if (q.includes("labels(first:20)")) {
        return Response.json({
          data: {
            repository: {
              issues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: plan.openIssues.map(n => ({
                  number: n,
                  milestone: (() => {
                    const m = plan.items.find(i => i.number === n)?.milestone;
                    return m == null ? null : { title: m };
                  })(),
                  labels: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: (plan.items.find(i => i.number === n)?.labels ?? []).map(name => ({
                      name,
                    })),
                  },
                })),
              },
            },
          },
        });
      }

      // The two candidate sources. `blocking` is the fan-out's; `issues` with
      // `projectItems` is the top-up's. Both return the same node shape, which
      // is the property the script depends on.
      if (q.includes("blocking(first:100")) {
        return Response.json({
          data: {
            repository: {
              issue: {
                blocking: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
              },
            },
          },
        });
      }

      if (q.includes("projectItems(first:20)")) {
        return Response.json({
          data: {
            repository: {
              issues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: plan.openIssues.map(n => issueNode(plan, n)),
              },
            },
          },
        });
      }

      if (q.includes("items(first:100")) {
        return Response.json({
          data: {
            node: {
              items: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: plan.items.map(i => boardNode(plan, i)),
              },
            },
          },
        });
      }

      // NOT an empty success. See the header: an unrecognised query answered
      // `{}` makes the script refuse for an instrument reason, and the case
      // cannot tell that from a board with nothing to move.
      unknownQueries.push(q);
      return Response.json({
        data: null,
        errors: [{ message: `the fixture does not recognise this query: ${q.slice(0, 120)}` }],
      });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    writes,
    unknownQueries,
    async stop() {
      await server.stop(true);
    },
  };
}
