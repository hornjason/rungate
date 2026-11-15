/**
 * #2193 (part 1 of #2183): the board-intake move step as code, driven against
 * a stub GraphQL client so each refusal is observed running.
 *
 * Each case asserts the refusal's REASON, not only that the move failed, so a
 * case cannot go green on a different refusal that happens to fire first
 * (`.claude/rules/checks-must-be-able-to-fail.md`, the sixth shape).
 *
 * ## What was broken to prove these can fail
 *
 * Each refusal was removed in turn from `lib/board-intake-move.ts`; the counts
 * are in the pull request that closes #2193.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

import { CLI_COMMANDS } from "../lib/cli-commands";
import { moveToColumn, type GraphqlCall, type MoveResult } from "../lib/board-intake-move";

const ROOT = join(import.meta.dir, "..");
const PROJECT = "PVT_project";
const ITEM = "PVTI_item";
const COLUMN = "In review";

type Reply = unknown | Error;

/** Which of the four calls a query is, by the field it asks for. */
function kind(query: string): "fields" | "write" | "values" | "index" {
  if (query.includes("updateProjectV2ItemFieldValue")) return "write";
  if (query.includes("fieldValues(")) return "values";
  if (query.includes("items(")) return "index";
  if (query.includes("fields(")) return "fields";
  throw new Error(`the stub does not know this query: ${query.slice(0, 80)}`);
}

/**
 * A client answering each kind of call from its own queue; the last reply in a
 * queue repeats. An Error reply is thrown, as the real client throws.
 */
function stub(replies: Partial<Record<ReturnType<typeof kind>, Reply[]>>) {
  const calls: Array<{ kind: string; variables: Record<string, string> }> = [];
  const seen: Record<string, number> = {};
  const graphql: GraphqlCall = async (query, variables) => {
    const k = kind(query);
    calls.push({ kind: k, variables });
    const queue = replies[k] ?? [];
    const n = seen[k] ?? 0;
    seen[k] = n + 1;
    const reply = queue[Math.min(n, queue.length - 1)];
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { graphql, calls };
}

const fieldsPage = (over: { hasNextPage?: boolean; status?: unknown } = {}) => ({
  node: {
    fields: {
      pageInfo: { hasNextPage: over.hasNextPage ?? false },
      nodes: [
        { id: "F_title", name: "Title" },
        over.status === undefined
          ? { id: "F_status", name: "Status", options: [{ id: "O_backlog", name: "Backlog" }, { id: "O_review", name: COLUMN }] }
          : over.status,
      ],
    },
  },
});
const valuesPage = (status: string | null, hasNextPage = false) => ({
  node: {
    fieldValues: {
      pageInfo: { hasNextPage },
      nodes: status === null ? [{}] : [{ name: status, field: { name: "Status" } }],
    },
  },
});
const indexPage = (ids: string[], hasNextPage = false) => ({
  node: { items: { pageInfo: { hasNextPage }, nodes: ids.map(id => ({ id })) } },
});
const WROTE = { updateProjectV2ItemFieldValue: { projectV2Item: { id: ITEM } } };

async function move(replies: Parameters<typeof stub>[0], itemId = ITEM) {
  const s = stub(replies);
  const lines: string[] = [];
  const slept: number[] = [];
  const result: MoveResult = await moveToColumn(
    { projectId: PROJECT, itemId, column: COLUMN },
    { graphql: s.graphql, sleep: async ms => void slept.push(ms), log: line => void lines.push(line) },
  );
  return { result, calls: s.calls, lines, slept };
}

const reason = (r: MoveResult) => (r.ok ? "OK" : r.reason);

describe("#2193: the move succeeds only when the item AND the search index agree", () => {
  test("both readings agree on the first attempt: OK, after one write", async () => {
    const r = await move({ fields: [fieldsPage()], write: [WROTE], values: [valuesPage(COLUMN)], index: [indexPage([ITEM])] });
    expect(reason(r.result)).toBe("OK");
    expect(r.result.ok && r.result.attempt).toBe(1);
    expect(r.calls.filter(c => c.kind === "write")).toHaveLength(1);
    // The field and option were resolved by NAME and written.
    expect(r.calls.find(c => c.kind === "write")?.variables).toMatchObject({ field: "F_status", option: "O_review", item: ITEM, project: PROJECT });
  });

  test("a concurrent writer wins once, then the write sticks: OK on attempt 2", async () => {
    const r = await move({
      fields: [fieldsPage()],
      write: [WROTE],
      values: [valuesPage("Backlog"), valuesPage(COLUMN)],
      index: [indexPage([]), indexPage([ITEM])],
    });
    expect(reason(r.result)).toBe("OK");
    expect(r.result.ok && r.result.attempt).toBe(2);
    expect(r.lines.join("\n")).toContain("read back 'Backlog'");
  });

  test("the field value says the column but the index never carries the item: INDEX_LAGGING, not OK", async () => {
    const r = await move({ fields: [fieldsPage()], write: [WROTE], values: [valuesPage(COLUMN)], index: [indexPage(["PVTI_other"])] });
    expect(reason(r.result)).toBe("INDEX_LAGGING");
    expect(r.calls.filter(c => c.kind === "write"), "it re-wrote to prompt a re-index").toHaveLength(3);
  });

  test("a read-back that disagrees three times: OVERWRITTEN", async () => {
    const r = await move({ fields: [fieldsPage()], write: [WROTE], values: [valuesPage("Backlog")], index: [indexPage([])] });
    expect(reason(r.result)).toBe("OVERWRITTEN");
    expect(r.result.ok ? "" : r.result.message).toContain("still reads 'Backlog'");
  });
});

describe("#2193: every refusal names its own cause", () => {
  test("no item id: NO_ITEM, and nothing is called", async () => {
    const r = await move({}, "");
    expect(reason(r.result)).toBe("NO_ITEM");
    expect(r.calls).toEqual([]);
  });

  test("a null node on the field list: NULL_NODE naming the project id", async () => {
    const r = await move({ fields: [{ node: null }] });
    expect(reason(r.result)).toBe("NULL_NODE");
    expect(r.result.ok ? "" : r.result.message).toContain(`node(id: ${PROJECT})`);
  });

  test("a null node on the read-back: NULL_NODE naming the item id", async () => {
    const r = await move({ fields: [fieldsPage()], write: [WROTE], values: [{ node: null }] });
    expect(reason(r.result)).toBe("NULL_NODE");
    expect(r.result.ok ? "" : r.result.message).toContain(`node(id: ${ITEM})`);
  });

  test("a null node on the index: NULL_NODE naming the project id", async () => {
    const r = await move({ fields: [fieldsPage()], write: [WROTE], values: [valuesPage(COLUMN)], index: [{ node: null }] });
    expect(reason(r.result)).toBe("NULL_NODE");
    expect(r.result.ok ? "" : r.result.message).toContain("search index");
  });

  test("no Status field on a page that has more: FIELDS_TRUNCATED, not 'renamed'", async () => {
    const r = await move({ fields: [fieldsPage({ hasNextPage: true, status: { id: "F_other", name: "Priority" } })] });
    expect(reason(r.result)).toBe("FIELDS_TRUNCATED");
  });

  test("no Status field on a complete page: NOT_RESOLVED", async () => {
    const r = await move({ fields: [fieldsPage({ status: { id: "F_other", name: "Priority" } })] });
    expect(reason(r.result)).toBe("NOT_RESOLVED");
  });

  test("a Status field without the column's option: NOT_RESOLVED, and nothing is written", async () => {
    const r = await move({ fields: [fieldsPage({ status: { id: "F_status", name: "Status", options: [{ id: "O_b", name: "Backlog" }] } })] });
    expect(reason(r.result)).toBe("NOT_RESOLVED");
    expect(r.calls.some(c => c.kind === "write")).toBe(false);
  });

  test("Status missing from a read-back page that has more: VALUES_TRUNCATED, not a competing writer", async () => {
    const r = await move({ fields: [fieldsPage()], write: [WROTE], values: [valuesPage(null, true)] });
    expect(reason(r.result)).toBe("VALUES_TRUNCATED");
  });

  test("the item missing from an index page that has more: INDEX_TRUNCATED, not a missing card", async () => {
    const r = await move({ fields: [fieldsPage()], write: [WROTE], values: [valuesPage(COLUMN)], index: [indexPage(["PVTI_other"], true)] });
    expect(reason(r.result)).toBe("INDEX_TRUNCATED");
  });

  test("the API failing three times on one call: API_FAILED, after two waits and three tries", async () => {
    const boom = new Error("HTTP 502");
    const r = await move({ fields: [boom] });
    expect(reason(r.result)).toBe("API_FAILED");
    expect(r.calls.filter(c => c.kind === "fields")).toHaveLength(3);
    expect(r.result.ok ? "" : r.result.message).toContain("HTTP 502");
  });

  test("one transient failure is retried, not refused", async () => {
    const r = await move({ fields: [new Error("HTTP 502"), fieldsPage()], write: [WROTE], values: [valuesPage(COLUMN)], index: [indexPage([ITEM])] });
    expect(reason(r.result)).toBe("OK");
  });
});

describe("#2193: rungate board-intake-move", () => {
  const SCRIPT = join(ROOT, "scripts", "board-intake-move.ts");
  const source = readFileSync(SCRIPT, "utf-8");

  test("it is in the CLI registry", () => {
    expect(CLI_COMMANDS["board-intake-move"]?.script).toBe("scripts/board-intake-move.ts");
  });

  test("the refusal has one site, and an inlined exit cannot bypass it", () => {
    expect(source.match(/EXIT_REFUSED\s*=/g)?.length).toBe(1);
    expect(source).not.toMatch(/process\.exit\(\s*[1-9]/);
  });

  test("a missing --project or --column is refused before any call, naming the flag", () => {
    const r = spawnSync("bun", [SCRIPT, "--item", ITEM, "--column", COLUMN], { encoding: "utf-8", timeout: 30_000, env: { ...process.env, GH_TOKEN: "" , GITHUB_TOKEN: "" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--project");
  });
});

// Review of PR #2194.
describe("#2193: inputs the index query and the client cannot take are refused by name", () => {
  test("a column holding a double quote: COLUMN_UNSEARCHABLE, before any call", async () => {
    const s = stub({ fields: [fieldsPage()] });
    const r = await moveToColumn(
      { projectId: PROJECT, itemId: ITEM, column: 'Won\'t Fix"' },
      { graphql: s.graphql, sleep: async () => {}, log: () => {} },
    );
    expect(reason(r)).toBe("COLUMN_UNSEARCHABLE");
    expect(s.calls).toEqual([]);
  });

  test("no credential: an ::error naming the client, exit 1, never a stack trace", () => {
    const SCRIPT = join(ROOT, "scripts", "board-intake-move.ts");
    const env = { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "" };
    const r = spawnSync("bun", [SCRIPT, "--project", PROJECT, "--item", ITEM, "--column", COLUMN], { encoding: "utf-8", timeout: 30_000, env });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("::error title=Board intake::no GitHub client");
    expect(r.stderr).not.toMatch(/^\s+at /m);
  });
});

// Review round 2 of PR #2194.
describe("#2193: a refusal states the true write state, and an unexpected fault is named", () => {
  test("NULL_NODE before the write says nothing was written; after the write, that one WAS sent", async () => {
    const before = await move({ fields: [{ node: null }] });
    expect(before.result.ok ? "" : before.result.message).toContain("nothing was written");
    const after = await move({ fields: [fieldsPage()], write: [WROTE], values: [{ node: null }] });
    const msg = after.result.ok ? "" : after.result.message;
    expect(msg).toContain("a write WAS sent before this read");
    expect(msg, "the read-back refusal claimed no write happened").not.toContain("nothing was written");
  });

  test("a malformed response is UNEXPECTED, naming the fault, never a thrown error", async () => {
    const r = await move({ fields: [{ node: { fields: { pageInfo: { hasNextPage: false }, nodes: "not a list" } } }] });
    expect(reason(r.result)).toBe("UNEXPECTED");
    expect(r.result.ok ? "" : r.result.message).toContain("Status is UNKNOWN");
  });
});

// Review round 3 of PR #2194: say which reading was complete.
test("#2193: a missing option on a found Status names Status's options as the complete reading, not the field list", async () => {
  const status = { id: "F_status", name: "Status", options: [{ id: "O_b", name: "Backlog" }] };
  const r = await move({ fields: [fieldsPage({ hasNextPage: true, status })] });
  expect(reason(r.result)).toBe("NOT_RESOLVED");
  const msg = r.result.ok ? "" : r.result.message;
  expect(msg).toContain("its options are returned in full");
  expect(msg, "it claimed the whole field list was read on a truncated page").not.toContain("whole field list was read");
});

// Review round 4 of PR #2194: every clause of the null-node refusal fits the id it was given.
test("#2193: a null node blames the input that id came from — ITEM_ID on the read-back, PROJECT_ID on the project reads", async () => {
  const item = await move({ fields: [fieldsPage()], write: [WROTE], values: [{ node: null }] });
  const itemMsg = item.result.ok ? "" : item.result.message;
  expect(itemMsg).toContain("the item did not resolve");
  expect(itemMsg).toContain("ITEM_ID is wrong");
  expect(itemMsg, "the read-back refusal blamed the project").not.toContain("PROJECT_ID");
  for (const replies of [{ fields: [{ node: null }] }, { fields: [fieldsPage()], write: [WROTE], values: [valuesPage(COLUMN)], index: [{ node: null }] }]) {
    const r = await move(replies);
    const msg = r.result.ok ? "" : r.result.message;
    expect(msg).toContain("the project did not resolve");
    expect(msg).toContain("PROJECT_ID is wrong");
    expect(msg).not.toContain("ITEM_ID");
  }
});

// Review round 5 of PR #2194: a backslash is the other character that matters inside a quoted phrase.
test("#2193: a column holding a backslash is COLUMN_UNSEARCHABLE too, before any call", async () => {
  for (const column of ["Won't Fix\\", "a\\b"]) {
    const s = stub({ fields: [fieldsPage()] });
    const r = await moveToColumn({ projectId: PROJECT, itemId: ITEM, column }, { graphql: s.graphql, sleep: async () => {}, log: () => {} });
    expect(reason(r), column).toBe("COLUMN_UNSEARCHABLE");
    expect(s.calls).toEqual([]);
  }
});
