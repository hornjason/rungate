#!/usr/bin/env bun
/**
 * Does the board's Status column agree with GitHub?
 *
 * The board is the thing people read to know where work stands, and on
 * 2026-11-04 it was wrong in both directions: #1607 showed `Done` while the
 * pull request was open and BLOCKED, and #1751, #1747 and #1740 sat in
 * `Backlog` having never been moved by anything. `board-intake.yml` stops new
 * pull requests arriving in the wrong column; this stops the ones already
 * there from staying wrong.
 *
 * Reports by default. `--write` applies the corrections it names.
 *
 * ## What it will and will not decide
 *
 * It corrects only transitions with ONE right answer, and reports the rest
 * rather than guessing:
 *
 * | Reading | Verdict |
 * |---|---|
 * | content MERGED or CLOSED, Status is not Done | correct it to Done |
 * | content OPEN, Status is Done, and it is a pull request | correct it to In review |
 * | content OPEN, Status is Done, and it is an issue | REPORT, never correct |
 *
 * The third row is the one worth defending. An open issue in `Done` is
 * certainly wrong, and the column it SHOULD be in is not derivable from
 * anything GitHub knows — `Backlog`, `Ready` and `In progress` are all
 * consistent with "open". Writing a guess there would replace a visibly wrong
 * board with a plausibly wrong one, which is worse, because nobody
 * re-examines a plausible board. `UNDECIDABLE` is a reading;
 * `.claude/rules/config-access.md` calls the alternative Silent Default
 * Substitution.
 *
 * ## The import is relative, and that is the convention here
 *
 * An earlier draft imported `rungate/lib/github` to keep a mutant copy of
 * this file loadable from a temp directory. That was wrong twice: `lib/github`
 * is not in `package.json`'s `exports` map, so the specifier does not resolve
 * at all, and no mutation battery copies this file — the rule it was citing
 * (`.claude/rules/checks-must-be-able-to-fail.md`, "no relative imports")
 * governs files that ARE copied. Every other script here imports `../lib/*`.
 *
 * `resolveGitHubToken` rather than `process.env.GITHUB_TOKEN`: the direct read
 * misses a machine authenticated only through `GH_TOKEN`, which the reviewer
 * caught on #1740 in exactly this shape.
 */
import { parseArgs } from "util";
import { resolveGitHubToken } from "../lib/github";

/** The one exit code this script refuses through. Mutated to 0 to prove the refusal is real. */
export const DRIFT_EXIT = 1;

export const PROJECT_ID = "PVT_kwHOAZTQCM4BpMuR";
export const DONE = "Done";
export const IN_REVIEW = "In review";

export type ItemKind = "Issue" | "PullRequest";
export type ItemState = "OPEN" | "CLOSED" | "MERGED";

export interface BoardItem {
  readonly itemId: string;
  readonly number: number;
  readonly kind: ItemKind;
  readonly state: ItemState;
  /** The Status cell, or null when the item has no Status at all. */
  readonly status: string | null;
}

export type Verdict =
  | { readonly kind: "agrees" }
  | { readonly kind: "correct"; readonly to: string; readonly why: string }
  | { readonly kind: "undecidable"; readonly why: string };

/**
 * The single binding. Every decision this script makes is this function, so a
 * mutation of it moves every row and no second decider can hold a case up
 * (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape).
 */
export function verdictFor(item: BoardItem): Verdict {
  const closed = item.state === "MERGED" || item.state === "CLOSED";

  if (closed) {
    return item.status === DONE
      ? { kind: "agrees" }
      : {
          kind: "correct",
          to: DONE,
          why: `${item.state.toLowerCase()} on GitHub but the board says ${item.status ?? "nothing"}`,
        };
  }

  // Open from here down.
  if (item.status !== DONE) return { kind: "agrees" };

  if (item.kind === "PullRequest") {
    return {
      kind: "correct",
      to: IN_REVIEW,
      why: "open on GitHub but the board says Done",
    };
  }

  return {
    kind: "undecidable",
    why:
      "open issue marked Done. Done is wrong, but Backlog, Ready and In progress are all " +
      "consistent with an open issue, so the right column is not derivable — a person has to pick it",
  };
}

export interface SweepReading {
  readonly agrees: number;
  readonly corrections: ReadonlyArray<BoardItem & { readonly to: string; readonly why: string }>;
  readonly undecidable: ReadonlyArray<BoardItem & { readonly why: string }>;
}

export function sweep(items: readonly BoardItem[]): SweepReading {
  const corrections: Array<BoardItem & { to: string; why: string }> = [];
  const undecidable: Array<BoardItem & { why: string }> = [];
  let agrees = 0;

  for (const item of items) {
    const v = verdictFor(item);
    if (v.kind === "agrees") agrees += 1;
    else if (v.kind === "correct") corrections.push({ ...item, to: v.to, why: v.why });
    else undecidable.push({ ...item, why: v.why });
  }

  return { agrees, corrections, undecidable };
}

const BOARD_QUERY = `
query($project: ID!, $endCursor: String) {
  node(id: $project) {
    ... on ProjectV2 {
      items(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          fieldValues(first: 20) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2FieldCommon { name } }
              }
            }
          }
          content {
            __typename
            ... on Issue { number state }
            ... on PullRequest { number state }
          }
        }
      }
    }
  }
}`;

const FIELDS_QUERY = `
query($project: ID!) {
  node(id: $project) {
    ... on ProjectV2 {
      fields(first: 50) {
        nodes { ... on ProjectV2SingleSelectField { id name options { id name } } }
      }
    }
  }
}`;

const SET_STATUS = `
mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $project, itemId: $item, fieldId: $field,
    value: { singleSelectOptionId: $option }
  }) { projectV2Item { id } }
}`;

async function graphql(token: string, query: string, variables: Record<string, unknown>): Promise<any> {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { errors?: unknown; data?: unknown };
  // A GraphQL error arrives with HTTP 200, so the status alone is not a reading.
  if (body.errors !== undefined) throw new Error(`GraphQL: ${JSON.stringify(body.errors)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return body.data;
}

/** Every item, paginated. A bare first:100 against a 121-item board returns a FALSE ZERO. */
async function readBoard(token: string): Promise<BoardItem[]> {
  const items: BoardItem[] = [];
  let endCursor: string | null = null;

  for (;;) {
    const data = await graphql(token, BOARD_QUERY, { project: PROJECT_ID, endCursor });
    const page = data.node.items;

    for (const node of page.nodes) {
      const content = node.content;
      if (content === null || content === undefined) continue;
      if (content.__typename !== "Issue" && content.__typename !== "PullRequest") continue;

      const status = (node.fieldValues?.nodes ?? [])
        .filter((f: any) => f?.field?.name === "Status")
        .map((f: any) => f.name)[0] ?? null;

      items.push({
        itemId: node.id,
        number: content.number,
        kind: content.__typename,
        state: content.state,
        status,
      });
    }

    if (!page.pageInfo.hasNextPage) break;
    endCursor = page.pageInfo.endCursor;
  }

  return items;
}

async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: { write: { type: "boolean", default: false } },
    allowPositionals: false,
  });

  const token = resolveGitHubToken();
  if (token === undefined) {
    console.error(
      "UNMEASURED: no GitHub credential. Nothing was read, so this is not a board that agrees — " +
        "it is a board nobody looked at. Set GITHUB_TOKEN or GH_TOKEN and re-run.",
    );
    return DRIFT_EXIT;
  }

  const items = await readBoard(token);
  const reading = sweep(items);

  console.log(`Board status sweep — ${items.length} item(s) read from ${PROJECT_ID}\n`);
  console.log(`  agrees with GitHub : ${reading.agrees}`);
  console.log(`  disagrees          : ${reading.corrections.length}`);
  console.log(`  undecidable        : ${reading.undecidable.length}\n`);

  for (const c of reading.corrections) {
    console.log(`  #${c.number} ${c.kind} ${c.status ?? "(no status)"} -> ${c.to}  (${c.why})`);
  }
  for (const u of reading.undecidable) {
    console.log(`  #${u.number} ${u.kind} UNDECIDABLE  (${u.why})`);
  }

  if (!values.write) {
    if (reading.corrections.length > 0 || reading.undecidable.length > 0) {
      console.log("\nReport only. Re-run with --write to apply the corrections above.");
      console.log("Undecidable rows are never written, with or without --write.");
      return DRIFT_EXIT;
    }
    console.log("\nThe board agrees with GitHub.");
    return 0;
  }

  const fields = await graphql(token, FIELDS_QUERY, { project: PROJECT_ID });
  const statusField = fields.node.fields.nodes.find((f: any) => f?.name === "Status");
  if (statusField === undefined) throw new Error("no Status field on this project");

  const optionId = (name: string): string => {
    const found = statusField.options.find((o: any) => o.name === name);
    if (found === undefined) throw new Error(`no '${name}' option on the Status field`);
    return found.id;
  };

  for (const c of reading.corrections) {
    await graphql(token, SET_STATUS, {
      project: PROJECT_ID,
      item: c.itemId,
      field: statusField.id,
      option: optionId(c.to),
    });
    console.log(`  wrote #${c.number} -> ${c.to}`);
  }

  console.log(`\nWrote ${reading.corrections.length} correction(s).`);
  if (reading.undecidable.length > 0) {
    console.log(`${reading.undecidable.length} row(s) still need a person to choose a column.`);
    return DRIFT_EXIT;
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
