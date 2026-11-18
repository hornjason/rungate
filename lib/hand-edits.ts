/**
 * The hand-edit reading SC-2625 is measured by (#1722).
 *
 * SC-2625 says the engine is finished when the payload spec reaches the board
 * through the pipeline "with no agent editing any issue, milestone, edge or
 * field by hand", and that a run with a hand edit fails and names the edit.
 * Nothing could tell a tool's write from a person's while the pipeline wrote
 * as the same account people use. Jason's decision of 2026-11-17 gave the
 * pipeline its own account, `rungate-bot`, and said the measure starts once
 * a board write is seen signed by it.
 *
 * So the reading has three parts, all here and all pure:
 *  - who counts as a person: {@link isPersonWrite};
 *  - when the window opens, and what in it is a hand edit: {@link handEditVerdict};
 *  - how one issue's GraphQL timeline becomes writes: {@link boardWritesOf}.
 *
 * The network half is `scripts/hand-edits.ts`.
 */

/** One write to the board, as GitHub recorded it on an issue. */
export interface BoardWrite {
  issue: number;
  /** What was written: `milestoned`, `labeled`, `blocked-by added`, `body edited`, ... */
  kind: string;
  /** What it was written to: a milestone title, a label, `#N`, a status. */
  detail: string;
  /** The login GitHub signed it with, or `null` when it names no actor. */
  actor: string | null;
  /** GitHub's actor type: `User`, `Bot`, ... — `null` with no actor. */
  actorType: string | null;
  /** ISO time GitHub recorded. */
  at: string;
}

export type HandEditVerdict =
  | { status: "unmeasured"; why: string }
  | { status: "met"; since: string; read: number }
  | { status: "short"; since: string; read: number; edits: string[] };

function sameLogin(a: string, b: string): boolean {
  // GitHub logins are case-insensitive: `Rungate-Bot` signs as the same
  // account as `rungate-bot`.
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * True when a person made this write.
 *
 * A Bot actor (`github-actions`, the project automation) is a workflow, not a
 * person. The pipeline account is a User on GitHub, so it is named rather
 * than inferred. A write with no actor is counted as a person's: nothing
 * shows the pipeline made it, and this reading is allowed to be wrong only
 * toward refusing.
 */
export function isPersonWrite(w: BoardWrite, pipelineAccount: string): boolean {
  if (w.actor === null) return true;
  if (w.actorType === "Bot") return false;
  return !sameLogin(w.actor, pipelineAccount);
}

/**
 * When the window opens: the pipeline account's earliest write, or
 * `undefined` when it has not written. One decider, so the reader that bounds
 * its event scan and the verdict cannot disagree about the start.
 */
export function windowOpens(writes: readonly BoardWrite[], pipelineAccount: string): string | undefined {
  return writes
    .filter(w => w.actor !== null && sameLogin(w.actor, pipelineAccount))
    .map(w => w.at)
    .sort()[0];
}

/**
 * The verdict over every write read for the payload's issues.
 *
 * The window opens at the pipeline account's earliest write, so a person's
 * write from before the pipeline had its own identity is history, not a hand
 * edit. Until the account has written, nothing can be certified.
 */
export function handEditVerdict(
  writes: readonly BoardWrite[] | null,
  pipelineAccount: string | null,
  unreadable: string | null,
): HandEditVerdict {
  if (pipelineAccount === null) {
    return {
      status: "unmeasured",
      why:
        "no pipeline account is configured (`board.pipelineAccount` in the rungate config), so a person's " +
        "write and the pipeline's cannot be told apart",
    };
  }
  if (writes === null) return { status: "unmeasured", why: unreadable ?? "the board writes were not read" };
  const opened = windowOpens(writes, pipelineAccount);
  if (opened === undefined) {
    return {
      status: "unmeasured",
      why:
        `no board write signed by ${pipelineAccount} was found on these issues, so the window has not ` +
        `opened and nothing can be certified yet`,
    };
  }
  const edits = writes
    .filter(w => w.at >= opened && isPersonWrite(w, pipelineAccount))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.issue - b.issue))
    .map(w => {
      const what = w.detail === "" ? w.kind : `${w.kind} ${w.detail}`;
      const who = w.actor === null ? "an unattributed actor" : w.actor;
      return `#${w.issue} ${what} — by ${who} at ${w.at}`;
    });
  return edits.length === 0
    ? { status: "met", since: opened, read: writes.length }
    : { status: "short", since: opened, read: writes.length, edits };
}

type Node = Record<string, unknown>;

function actorOf(n: Node): { actor: string | null; actorType: string | null } {
  const a = n.actor as { __typename?: unknown; login?: unknown } | null | undefined;
  if (!a || typeof a.login !== "string") return { actor: null, actorType: null };
  return { actor: a.login, actorType: typeof a.__typename === "string" ? a.__typename : null };
}

function numberOf(v: unknown): string {
  const n = (v as { number?: unknown } | null | undefined)?.number;
  return typeof n === "number" ? `#${n}` : "#?";
}

/**
 * Every timeline event type the reader asks for, and how each is described.
 * `scripts/hand-edits.ts` builds its `itemTypes` list from these keys, so a
 * type the query asks for and this table cannot describe is impossible.
 */
export const BOARD_WRITE_EVENTS: Readonly<Record<string, { item: string; describe: (n: Node) => [string, string] }>> = {
  MilestonedEvent: { item: "MILESTONED_EVENT", describe: n => ["milestoned", String(n.milestoneTitle ?? "")] },
  DemilestonedEvent: { item: "DEMILESTONED_EVENT", describe: n => ["demilestoned", String(n.milestoneTitle ?? "")] },
  LabeledEvent: { item: "LABELED_EVENT", describe: n => ["labeled", String((n.label as Node | null)?.name ?? "")] },
  UnlabeledEvent: { item: "UNLABELED_EVENT", describe: n => ["unlabeled", String((n.label as Node | null)?.name ?? "")] },
  BlockedByAddedEvent: { item: "BLOCKED_BY_ADDED_EVENT", describe: n => ["blocked-by added", numberOf(n.blockingIssue)] },
  BlockedByRemovedEvent: { item: "BLOCKED_BY_REMOVED_EVENT", describe: n => ["blocked-by removed", numberOf(n.blockingIssue)] },
  BlockingAddedEvent: { item: "BLOCKING_ADDED_EVENT", describe: n => ["blocking added", numberOf(n.blockedIssue)] },
  BlockingRemovedEvent: { item: "BLOCKING_REMOVED_EVENT", describe: n => ["blocking removed", numberOf(n.blockedIssue)] },
  RenamedTitleEvent: {
    item: "RENAMED_TITLE_EVENT",
    describe: n => ["renamed", `${JSON.stringify(n.previousTitle ?? "")} → ${JSON.stringify(n.currentTitle ?? "")}`],
  },
  AddedToProjectV2Event: { item: "ADDED_TO_PROJECT_V2_EVENT", describe: () => ["added to project", ""] },
  RemovedFromProjectV2Event: { item: "REMOVED_FROM_PROJECT_V2_EVENT", describe: () => ["removed from project", ""] },
  ProjectV2ItemStatusChangedEvent: {
    item: "PROJECT_V2_ITEM_STATUS_CHANGED_EVENT",
    describe: n => ["project status", String(n.status ?? "")],
  },
};

/**
 * One issue's writes, from a GraphQL issue node carrying `number`,
 * `createdAt`, `userContentEdits` and `timelineItems`.
 *
 * Refuses rather than returning a short list: a cut page, an event with no
 * time, or an event type this table does not describe would each make the
 * reading cleaner than the issue is.
 */
export function boardWritesOf(raw: unknown): { writes: BoardWrite[] } | { why: string } {
  const n = raw as Node | null | undefined;
  if (!n || typeof n.number !== "number") return { why: "an issue node carried no number" };
  const issue = n.number;
  const createdAt = n.createdAt;
  const edits = n.userContentEdits as { pageInfo?: { hasNextPage?: unknown }; nodes?: unknown } | null | undefined;
  const items = n.timelineItems as { pageInfo?: { hasNextPage?: unknown }; nodes?: unknown } | null | undefined;
  if (typeof createdAt !== "string") return { why: `#${issue} carried no creation time` };
  if (!edits || !Array.isArray(edits.nodes) || edits.pageInfo?.hasNextPage !== false) {
    return { why: `#${issue}'s body edits were not read to the end` };
  }
  if (!items || !Array.isArray(items.nodes) || items.pageInfo?.hasNextPage !== false) {
    return { why: `#${issue}'s timeline was not read to the end` };
  }
  const writes: BoardWrite[] = [];
  for (const e of items.nodes as Node[]) {
    const type = typeof e?.__typename === "string" ? e.__typename : "an untyped event";
    const known = BOARD_WRITE_EVENTS[type];
    if (!known) return { why: `#${issue}'s timeline holds ${type}, which this reading does not describe` };
    if (typeof e.createdAt !== "string") return { why: `#${issue}'s ${type} has no time` };
    const [kind, detail] = known.describe(e);
    writes.push({ issue, kind, detail, ...actorOf(e), at: e.createdAt });
  }
  for (const e of edits.nodes as Node[]) {
    if (typeof e?.editedAt !== "string") return { why: `#${issue} has a body edit with no time` };
    // MEASURED on 2026-11-18 (#2318): the oldest revision is the body the
    // issue was created with, at exactly its creation time. That is the
    // issue's filing, not an edit to it.
    if (e.editedAt === createdAt) continue;
    const editor = actorOf({ actor: e.editor });
    writes.push({ issue, kind: "body edited", detail: "", ...editor, at: e.editedAt });
  }
  return { writes };
}
