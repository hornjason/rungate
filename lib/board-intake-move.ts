/**
 * The board-intake move step as code (#2193, part 1 of #2183).
 *
 * `board-intake.yml`'s move step carried this logic as about 260 lines of
 * shell, and its invariants were enforced only by regexes over the rendered
 * YAML, so an edit could drop one with no test exercising what runs. Here
 * each one is a branch a stub client drives (`test/board-intake-move.test.ts`):
 *
 * - **Every call is retried** (three tries, waits of 2 s and 4 s), and the
 *   third failure is API_FAILED, which says the board's state is UNKNOWN.
 *   A thrown error is never read as an answer.
 * - **A null `node(id:)` is an id that did not resolve** (stale, invisible to
 *   this token, or a wrong project), refused by naming the id, never read as
 *   an empty list.
 * - **A full page is not an absence.** Each connection asks `hasNextPage`, and
 *   "not found, and the page was full" is its own UNMEASURED refusal.
 * - **The field and option are resolved by NAME**, so a renamed column is a
 *   refusal rather than a stale id writing the wrong column.
 * - **A write is not a reading.** Each write is read back from the item AND
 *   from the project's search index, which is what the board draws, and only
 *   both agreeing is success. GitHub's built-in "Item added" automation fires
 *   on the same event and can land after this write, so there are three
 *   verified attempts, then a refusal naming which reading disagreed.
 *
 * It owns only the opened -> In review edge; merged and closed stay with
 * GitHub's built-in workflows, so each transition has one decider.
 */

/** A GraphQL call: resolves to the response's `data`, throws on failure, as the client does. */
export type GraphqlCall = (query: string, variables: Record<string, string>) => Promise<unknown>;

export interface MoveDeps {
  graphql: GraphqlCall;
  sleep: (ms: number) => Promise<void>;
  /** Progress lines (one per attempt that did not settle). */
  log: (line: string) => void;
}

export interface MoveInput {
  projectId: string;
  itemId: string;
  column: string;
}

export type MoveRefusal =
  | "NO_ITEM"
  | "COLUMN_UNSEARCHABLE"
  | "API_FAILED"
  | "NULL_NODE"
  | "FIELDS_TRUNCATED"
  | "NOT_RESOLVED"
  | "VALUES_TRUNCATED"
  | "INDEX_TRUNCATED"
  | "INDEX_LAGGING"
  | "OVERWRITTEN"
  | "UNEXPECTED";

export type MoveResult = { ok: true; attempt: number; message: string } | { ok: false; reason: MoveRefusal; message: string };

/** How long to let a concurrent built-in write land before reading back. */
export const SETTLE_MS = 3000;

const FIELDS_QUERY = `query($project: ID!) {
  node(id: $project) {
    ... on ProjectV2 {
      fields(first: 50) {
        pageInfo { hasNextPage }
        nodes { ... on ProjectV2SingleSelectField { id name options { id name } } }
      }
    }
  }
}`;

const WRITE_MUTATION = `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $project, itemId: $item, fieldId: $field,
    value: { singleSelectOptionId: $option }
  }) { projectV2Item { id } }
}`;

const VALUES_QUERY = `query($item: ID!) {
  node(id: $item) {
    ... on ProjectV2Item {
      fieldValues(first: 50) {
        pageInfo { hasNextPage }
        nodes {
          ... on ProjectV2ItemFieldSingleSelectValue {
            name field { ... on ProjectV2FieldCommon { name } }
          }
        }
      }
    }
  }
}`;

const INDEX_QUERY = `query($project: ID!, $q: String!) {
  node(id: $project) {
    ... on ProjectV2 {
      items(first: 100, query: $q) {
        pageInfo { hasNextPage }
        nodes { id }
      }
    }
  }
}`;

interface Page<T> {
  pageInfo?: { hasNextPage?: boolean } | null;
  nodes?: Array<T | null> | null;
}

class Refused extends Error {
  constructor(
    readonly reason: MoveRefusal,
    message: string,
  ) {
    super(message);
  }
}

/** One call, three tries. The third failure refuses; a thrown error is never an answer. */
async function call(deps: MoveDeps, query: string, variables: Record<string, string>): Promise<unknown> {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await deps.graphql(query, variables);
    } catch (e) {
      last = e;
      if (attempt < 3) await deps.sleep(attempt * 2000);
    }
  }
  throw new Refused(
    "API_FAILED",
    `GitHub's GraphQL API failed three times. The item may or may not be on the board and its Status is UNKNOWN — this run measured nothing. Last error: ${(last as Error)?.message ?? String(last)}`,
  );
}

/** The connection under `node`, or a refusal naming the id that did not resolve. */
function requireNode<T>(
  data: unknown,
  key: "fields" | "fieldValues" | "items",
  what: string,
  id: string,
  wrote: boolean,
): Page<T> {
  const node = (data as { node?: Record<string, unknown> | null } | null | undefined)?.node;
  const page = node?.[key] as Page<T> | null | undefined;
  if (!page) {
    throw new Refused(
      "NULL_NODE",
      `${what} is UNMEASURED and ${wrote ? "a write WAS sent before this read, so the board may already hold the new value" : "nothing was written"}: node(id: ${id}) came back null, so that id did not resolve — it is stale, it names an object this token cannot see, or PROJECT_ID is wrong. This is NOT a missing field, NOT an unset column and NOT an empty board.`,
    );
  }
  return page;
}

const truncated = (page: Page<unknown>) => page.pageInfo?.hasNextPage === true;
const present = <T>(page: Page<T>): T[] => (page.nodes ?? []).filter((n): n is T => n !== null && n !== undefined);

/** Move `itemId` to `column` on `projectId`, verified in both readings, or say why not. */
export async function moveToColumn(input: MoveInput, deps: MoveDeps): Promise<MoveResult> {
  const { projectId, itemId, column } = input;
  try {
    if (!itemId) {
      throw new Refused(
        "NO_ITEM",
        "The add step produced no itemId, so there is nothing to move. The item was NOT added and its Status is UNSET — this is not a board that merely missed a transition.",
      );
    }

    // The index is read with `status:"<column>"`, and a double quote cannot be
    // carried inside that phrase, so a column holding one could never be seen
    // in the index and every write would be misreported as lagging or
    // overwritten. Refused before anything is written (review of PR #2194).
    if (column.includes('"')) {
      throw new Refused(
        "COLUMN_UNSEARCHABLE",
        `The column name ${JSON.stringify(column)} contains a double quote, which the project search query status:"<column>" cannot carry, so whether the card renders could never be read. Nothing was written. Rename the column, or pass one without a double quote.`,
      );
    }

    const fields = requireNode<{ id?: string; name?: string; options?: Array<{ id: string; name: string }> }>(
      await call(deps, FIELDS_QUERY, { project: projectId }),
      "fields",
      "the project's field list",
      projectId,
      false,
    );
    const status = present(fields).find(f => f.name === "Status");
    const fieldId = status?.id ?? "";
    const optionId = status?.options?.find(o => o.name === column)?.id ?? "";
    if (!fieldId && truncated(fields)) {
      throw new Refused(
        "FIELDS_TRUNCATED",
        "The first 50 fields on this project do not include one named 'Status', AND there are more fields beyond that page — so this read is UNMEASURED, not a missing field. Nothing was written. Do not rename anything on the strength of this message; page the fields query instead.",
      );
    }
    if (!fieldId || !optionId) {
      throw new Refused(
        "NOT_RESOLVED",
        `Could not resolve the Status field or its '${column}' option on this project. The whole field list was read, so this is not a truncated page. The item WAS added; only the transition failed. Someone renamed the field or the column — update COLUMN in this workflow to match the board.`,
      );
    }

    let current = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      await call(deps, WRITE_MUTATION, { project: projectId, item: itemId, field: fieldId, option: optionId });
      // Let a concurrent built-in write land, so the read-back sees the settled value.
      await deps.sleep(SETTLE_MS);

      const values = requireNode<{ name?: string; field?: { name?: string } }>(
        await call(deps, VALUES_QUERY, { item: itemId }),
        "fieldValues",
        "the item's field values, read back after the write",
        itemId,
        true,
      );
      current = present(values).find(v => v.field?.name === "Status")?.name ?? "";
      if (!current && truncated(values)) {
        throw new Refused(
          "VALUES_TRUNCATED",
          "Status was not among this item's first 50 field values and there are more beyond that page, so the read-back is UNMEASURED — the write may well have worked. This is NOT a competing writer and NOT an unset column. Page the fieldValues query.",
        );
      }

      // The field value is not what the board draws: the board renders from a
      // search index that can disagree with the item data.
      const index = requireNode<{ id?: string }>(
        await call(deps, INDEX_QUERY, { project: projectId, q: `status:"${column}"` }),
        "items",
        `the search index for the '${column}' column`,
        projectId,
        true,
      );
      const indexed = present(index).some(n => n.id === itemId);
      if (!indexed && truncated(index)) {
        throw new Refused(
          "INDEX_TRUNCATED",
          `More than 100 items match '${column}' in the project's search index and this item was not in the first page, so its membership is UNMEASURED — it may well be indexed and rendering. Do not read this as a missing card. Page the index query.`,
        );
      }

      if (current === column && indexed) {
        return {
          ok: true,
          attempt,
          message: `Moved to '${column}' on attempt ${attempt}, confirmed in BOTH the item's field value and the project's search index — so the card will actually render. This workflow owns only the opened->In review edge; merged->Done and closed->Done remain GitHub's built-in project workflows, so exactly one decider writes each transition.`,
        };
      }
      deps.log(
        current === column
          ? `Attempt ${attempt}: the field value reads '${column}' but the search index does not carry this item yet, so the board would not draw it. Re-writing to prompt a re-index.`
          : `Attempt ${attempt}: wrote '${column}', read back '${current || "(nothing)"}' — a concurrent write won. Retrying.`,
      );
    }

    if (current === column) {
      throw new Refused(
        "INDEX_LAGGING",
        `The Status field reads '${column}' but after three attempts the project's SEARCH INDEX still does not list this item under it, and the board draws from the index. The data is right and the card is invisible — do not 'fix' the Status, it is already correct. Re-writing the same value is what repairs the index entry; if three did not take, the index is lagging and this needs a human to re-check later.`,
      );
    }
    throw new Refused(
      "OVERWRITTEN",
      `Wrote '${column}' three times and the board still reads '${current || "(nothing)"}'. Something else is writing this item's Status and winning: check the project's built-in workflows for a rule that also fires on a pull request being added. The item IS on the board; only its column is wrong.`,
    );
  } catch (e) {
    if (e instanceof Refused) return { ok: false, reason: e.reason, message: e.message };
    // Anything else is a response this module did not expect, or a fault in it:
    // named, never a stack trace and never an answer (review of PR #2194).
    return {
      ok: false,
      reason: "UNEXPECTED",
      message: `An unexpected response or fault stopped the move, so the item's Status is UNKNOWN — a write may or may not have been sent. ${(e as Error)?.message ?? String(e)}`,
    };
  }
}
