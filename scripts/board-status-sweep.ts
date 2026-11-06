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
 * | content OPEN, Status is Done, and it is a READY pull request | correct it to In review |
 * | content OPEN, Status is Done, and it is a DRAFT pull request | REPORT, never correct |
 * | content OPEN, Status is Done, and it is an issue | REPORT, never correct |
 *
 * The draft row exists because `board-intake.yml` — the other half of the
 * same change — keeps drafts OUT of In review on purpose. A sweep that wrote
 * In review for a draft would be a second decider contradicting the first,
 * and the two would never meet in a single run to disagree visibly.
 *
 * The last row is the one worth defending. An open issue in `Done` is
 * certainly wrong, and the column it SHOULD be in is not derivable from
 * anything GitHub knows — `Backlog`, `Ready` and `In progress` are all
 * consistent with "open". Writing a guess there would replace a visibly wrong
 * board with a plausibly wrong one, which is worse, because nobody
 * re-examines a plausible board. `UNDECIDABLE` is a reading;
 * `.claude/rules/config-access.md` calls the alternative Silent Default
 * Substitution.
 *
 * ## The import is relative, and the mutant sandbox carries `lib/`
 *
 * An earlier draft imported `rungate/lib/github` to keep a mutant copy of
 * this file loadable from a temp directory. That was wrong: `lib/github` is
 * not in `package.json`'s `exports` map, so the specifier does not resolve at
 * all. Every other script here imports `../lib/*` and so does this one.
 *
 * The same paragraph also said "no mutation battery copies this file", which
 * was true when it was written and is no longer. BS-28 copies it, and the
 * rule it was waving away (`.claude/rules/checks-must-be-able-to-fail.md`,
 * "no relative imports") is satisfied the other way: the sandbox carries
 * `lib/` and a link to `node_modules`, and every case asserts the run
 * PRINTED ITS DECISION as well as what it exited with — because a mutant
 * that died on module resolution also exits non-zero and would read as the
 * mutation having been rejected on the merits.
 *
 * `resolveGitHubToken` rather than reading the environment variable
 * directly: the direct read misses a machine authenticated only through
 * `GH_TOKEN`, which the reviewer caught on #1740 in exactly this shape.
 */
import { parseArgs } from "util";
import { resolveGitHubToken } from "../lib/github";
import { laneFor } from "../lib/board-flow";

/**
 * The one exit code this script refuses through.
 *
 * `test/board-status-sweep.test.ts` BS-28 builds a copy with this set to `0`
 * and runs both against the same input: the real one refuses and the mutant
 * does not. That sentence used to be here with nothing behind it — no test
 * imported this constant, ran `main()`, or looked at an exit code — which a
 * reviewer caught, and which is the precise failure the rule above describes.
 */
export const DRIFT_EXIT = 1;

export const PROJECT_ID = "PVT_kwHOAZTQCM4BpMuR";
export const DONE = "Done";
export const IN_REVIEW = "In review";
/**
 * The lane an assigned, open issue belongs in.
 *
 * Spelled here rather than taken from `laneFor` at the call site for the
 * same reason `DONE` and `IN_REVIEW` are: these three are the strings this
 * script WRITES, and a test needs one import to name the expected value.
 * `verdictFor` still routes the decision through `laneFor`, so the rule
 * itself has one owner — this is the name, not the decision.
 */
export const IN_PROGRESS = "In progress";

/**
 * The lanes an assignment may pull an issue OUT of. Closed, not open-ended.
 *
 * Only these two contradict an assignment: `specs/BOARD-FLOW-SPEC.md` gives
 * Ready the entry condition "nobody assigned", and Backlog is the option
 * pool for work nobody has started. In progress is already right, In review
 * means a pull request is out and the issue is still legitimately assigned,
 * and Done and Cancelled are terminal — a bulk writer that could pull from
 * those would drag finished work backwards. BS-49, BS-50.
 */
const ASSIGNMENT_CONTRADICTS: readonly string[] = ["Backlog", "Ready"];

/** Where a released claim lands. The backlog is for unassigned work. */
export const BACKLOG = "Backlog";

/**
 * Days of silence after which a claim is stale — Jason's call, 2026-11-06.
 *
 * **Stale is a conjunction**: this many days with no activity AND no open
 * pull request. Either half alone is wrong, and in opposite directions — an
 * issue somebody picked up this morning has no PR yet, and an issue with a
 * PR in review is legitimately quiet. `verdictFor` requires both.
 *
 * Seven because `lib/behavioral-cache.ts` already uses it for the same kind
 * of question, and because this board delivered 132 items in 14 days: a week
 * of silence is far outside how long work here actually takes. Measured
 * 2026-11-06, the seven strays were 8 to 16 days old, so the threshold is
 * not sitting on top of the population it has to separate.
 */
export const STALE_CLAIM_DAYS = 7;

export type ItemKind = "Issue" | "PullRequest";
export type ItemState = "OPEN" | "CLOSED" | "MERGED";

export interface BoardItem {
  readonly itemId: string;
  readonly number: number;
  readonly kind: ItemKind;
  readonly state: ItemState;
  /** The Status cell, or null when the item has no Status at all. */
  readonly status: string | null;
  /** Always false for an issue. Required, not optional: see `readBoard`. */
  readonly draft: boolean;
  /**
   * The field-value page was full, so Status may exist beyond it. A `null`
   * status then means "not read", which is a different fact from "not set"
   * and must not be allowed to read as agreement.
   */
  readonly statusUnread: boolean;
  /**
   * GitHub's `state_reason`, for a CLOSED issue. `null` for a pull request,
   * for an open issue, and for a closed issue whose reason could not be
   * read — and that last case is why this is never defaulted to
   * `COMPLETED`. See `verdictFor`.
   */
  readonly stateReason: string | null;
  /**
   * Is anybody assigned to this issue?
   *
   * Three states, and the third is the point. `true` and `false` are
   * readings; `null` is **NOT READ** — the query did not carry the field,
   * or carried it as null. Those must not share an observable with "nobody
   * is assigned", because a query that lost the field would otherwise make
   * every stranded issue read as correctly unassigned and the sweep would
   * report a clean board having checked nothing. Silent Default
   * Substitution, `.claude/rules/config-access.md`.
   *
   * Always `null` for a pull request: the query asks for assignees on the
   * Issue fragment only, so the sweep cannot see a fact no lane rule lets
   * it act on. BS-52 asserts the resulting verdict, BS-53 the parse.
   */
  readonly assigned: boolean | null;
  /**
   * Days since anything happened on this issue, or `null` for NOT READ.
   *
   * Derived from the issue's `updatedAt` in `readBoard`, so the clock lives
   * at the edge and `verdictFor` stays a pure function of its argument with
   * no hidden input. A decider that reads the wall clock cannot be tested
   * for a boundary without the test also controlling time.
   *
   * `updatedAt` deliberately does NOT move when a linked pull request is
   * pushed to, which is exactly why staleness needs the second condition
   * below rather than this one alone.
   */
  readonly idleDays: number | null;
  /**
   * How many OPEN pull requests reference this issue, or `null` for NOT READ.
   *
   * Resolved only for the handful of rows that are already stale-claim
   * candidates — see `isStaleClaimCandidate`. Every other row keeps `null`,
   * and that is correct rather than lazy: no verdict outside the release
   * branch asks the question.
   *
   * **`null` can never become a release.** A reading that was not taken is
   * not a reading that came back empty, and the direction that matters here
   * is the one where a fetch that silently failed unassigns somebody's live
   * work. `verdictFor` returns UNDECIDABLE for it.
   */
  readonly openLinkedPRs: number | null;
}

export type Verdict =
  | { readonly kind: "agrees" }
  | { readonly kind: "correct"; readonly to: string; readonly why: string }
  /**
   * Release the claim: unassign everybody, and move the card to Backlog if
   * it is not already there.
   *
   * A separate kind from `correct` because it is a separate ACT on a
   * separate API — `correct` writes a project field, this writes the issue
   * — and folding them together would let a failure of one be reported as
   * the other. `to` is `null` when the card is already in Backlog and only
   * the assignment needs removing.
   */
  | { readonly kind: "release"; readonly to: string | null; readonly why: string }
  | { readonly kind: "undecidable"; readonly why: string };

/**
 * Whole days between an ISO timestamp and `now`, or `null` for NOT READ.
 *
 * `now` is a parameter so a boundary case is testable without the test
 * owning the clock. Absent, non-string and unparseable all return `null` —
 * never `0`. Zero means "active today", which is the opposite answer to the
 * one a missing timestamp supports, and conflating them would make every
 * row with a malformed date look freshly worked.
 */
export function idleDaysSince(updatedAt: unknown, now: number): number | null {
  if (typeof updatedAt !== "string") return null;
  const then = Date.parse(updatedAt);
  if (Number.isNaN(then)) return null;
  // Clamped at 0 rather than going negative. Clock skew between GitHub and
  // a runner is real and small; a negative age compares `false` against the
  // threshold either way, so this only makes the printed figure believable.
  return Math.max(0, Math.floor((now - then) / 86_400_000));
}

/**
 * Is this row worth asking GitHub about its pull requests?
 *
 * **This is not a second decider.** It answers "do I need to fetch more
 * before I can decide", and `verdictFor` answers "what do I write". They
 * are different questions over different inputs, which is the test
 * `.claude/rules/checks-must-be-able-to-fail.md` sets for the fourth shape:
 * name the input on which the two must disagree. Here there is one by
 * construction — a candidate whose fetch did not happen carries
 * `openLinkedPRs: null`, and this function still says `true` while
 * `verdictFor` says UNDECIDABLE.
 *
 * Deliberately cheap and deliberately WIDER than the release branch: it
 * costs one extra query to ask about a row that turns out not to need it,
 * and it costs an unassignment to skip a row that did.
 */
export function isStaleClaimCandidate(item: BoardItem): boolean {
  return (
    item.kind === "Issue" &&
    item.state === "OPEN" &&
    item.assigned === true &&
    ASSIGNMENT_CONTRADICTS.includes(item.status ?? "") &&
    item.idleDays !== null &&
    item.idleDays >= STALE_CLAIM_DAYS
  );
}

/**
 * The single binding. Every decision this script makes is this function, so a
 * mutation of it moves every row and no second decider can hold a case up
 * (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape).
 */
export function verdictFor(item: BoardItem): Verdict {
  // FIRST, because every branch below reads `item.status` and an unread one
  // is not a value. `null` here means the field-value page was full and
  // Status may lie beyond it, so "no status" and "status not read" would
  // otherwise be the same input with opposite correct answers.
  if (item.statusUnread) {
    return {
      kind: "undecidable",
      why:
        "the item's field-value page was full and Status was not among it, so this row's " +
        "column was NOT READ. That is not the same as having no column, and it is not " +
        "derivable from here — re-run against a query that pages fieldValues",
    };
  }

  const closed = item.state === "MERGED" || item.state === "CLOSED";

  if (closed) {
    // **CLOSED IS NOT ONE OUTCOME, AND THIS BRANCH TREATED IT AS ONE.**
    // It read `state` and never `state_reason`, so every abandonment was a
    // delivery. Measured 2026-11-05: 23 issues closed as `not_planned` or
    // `duplicate`, Cancelled holding 0, and this script the only path that
    // can correct a card whose event has already fired — so a `--write`
    // would have filed all 23 as Done, in one run, silently.
    //
    // The lane is NOT decided here. `laneFor` is the same function
    // `board-flow.yml` applies to the live event, so there is one decider
    // for "which lane does a close mean" and the catch-up cannot drift
    // away from the writer. Two copies of this rule would be two deciders
    // that agree, with no behavioural test able to say which was live
    // (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape).
    if (item.kind === "Issue") {
      const decision = laneFor({ kind: "issue_closed", stateReason: item.stateReason });
      if (decision.lane === null) {
        // Reported, never corrected. A sweep writes in BULK, so the one
        // direction this must not be wrong in is the one where an unknown
        // outcome becomes a delivery.
        return {
          kind: "undecidable",
          why:
            `closed on GitHub, and ${decision.why}. Done would count an unknown outcome as ` +
            `delivered; the board says ${item.status ?? "nothing"} and this run is not ` +
            `able to say what it should be`,
        };
      }
      return item.status === decision.lane
        ? { kind: "agrees" }
        : {
            kind: "correct",
            to: decision.lane,
            why: `${decision.why}, but the board says ${item.status ?? "nothing"}`,
          };
    }

    // A PULL REQUEST, where this stays `Done` and the open question is
    // named rather than decided. MERGED is unambiguous. A pull request
    // CLOSED unmerged is abandoned work reading as delivered — the same
    // shape as the issue defect above — but no lane table in
    // `specs/BOARD-FLOW-SPEC.md` covers a pull request's OWN card, and
    // inventing one here would be this script deciding spec. It is raised
    // as a follow-up instead.
    return item.status === DONE
      ? { kind: "agrees" }
      : {
          kind: "correct",
          to: DONE,
          why: `${item.state.toLowerCase()} on GitHub but the board says ${item.status ?? "nothing"}`,
        };
  }

  // Open from here down.

  // ASSIGNMENT MAKES AN OPEN ISSUE'S LANE DERIVABLE — Jason's call of
  // 2026-11-06: *"if they're assigned, that means someone's working on them…
  // But the backlog is for unassigned work."*
  //
  // This is the branch the UNDECIDABLE refusal further down used to swallow.
  // That refusal's stated reason was "Backlog, Ready and In progress are all
  // consistent with an open issue" — true of an UNASSIGNED issue, and false
  // once somebody is on it, because the lane table in
  // `specs/BOARD-FLOW-SPEC.md` gives In progress the entry condition
  // `issues: [assigned]` and gives Ready the entry condition "nobody
  // assigned". An assigned issue in either lane contradicts the spec.
  //
  // **Why this is here and not only in `board-flow.yml`.** That workflow
  // writes In progress on the `assigned` EVENT and it works — the
  // end-to-end walk-through's row 3 passes. It cannot reach an issue that
  // was assigned before it existed: no event will fire for those again, and
  // GitHub has no trigger that replays one. Measured 2026-11-06 against
  // `PVT_kwHOAZTQCM4BpMuR`: In progress held 1 card against 9 open assigned
  // issues, and two of the strays sat in Ready, holding it at 5 against a
  // cap of 4 so `board-ready.yml` correctly promoted nothing.
  //
  // NOT A SECOND DECIDER. `laneFor` is the same function `board-flow.yml`
  // applies to the live event, so "what does an assignment mean" has one
  // owner and this catch-up cannot drift away from the writer — the fourth
  // shape in `.claude/rules/checks-must-be-able-to-fail.md`.
  if (item.kind === "Issue" && ASSIGNMENT_CONTRADICTS.includes(item.status ?? "")) {
    if (item.assigned === null) {
      return {
        kind: "undecidable",
        why:
          `the board says ${item.status} and this row's assignment was NOT READ — the query ` +
          `did not carry \`assignees\`, which is not the same fact as nobody being assigned. ` +
          `Correcting on it would move cards on an unread field; re-run against a query that ` +
          `requests \`assignees { totalCount }\` on the Issue fragment`,
      };
    }
    if (item.assigned) {
      const decision = laneFor({ kind: "issue_assigned" });
      if (decision.lane === null) {
        return {
          kind: "undecidable",
          why: `assigned on GitHub, and ${decision.why}, so no lane is named for it`,
        };
      }

      // IS THE CLAIM STILL LIVE? Jason's call, 2026-11-06, after the first
      // cut of this branch sent all eight strays to In progress — which
      // would have made the lane read 9 against one real, a different wrong
      // number rather than a right one.
      //
      // Stale is a CONJUNCTION: silent for `STALE_CLAIM_DAYS` *and* no open
      // pull request. Either half alone is wrong in a different direction,
      // so neither is allowed to decide this on its own.
      if (item.idleDays === null) {
        return {
          kind: "undecidable",
          why:
            `assigned on GitHub and the board says ${item.status}, but this row's last ` +
            `activity was NOT READ, so whether the claim is live could not be established. ` +
            `In progress would assert somebody is working on it and a release would assert ` +
            `nobody is; neither is derivable from an unread field`,
        };
      }

      if (item.idleDays >= STALE_CLAIM_DAYS) {
        // The expensive half, and the one that must never be guessed. A
        // candidate whose pull-request reading was never taken is
        // UNDECIDABLE — a fetch that silently failed must not be able to
        // unassign somebody's live work. Silent Default Substitution in the
        // direction that costs the most.
        if (item.openLinkedPRs === null) {
          return {
            kind: "undecidable",
            why:
              `assigned on GitHub, silent for ${item.idleDays} day(s), and the board says ` +
              `${item.status} — but its open pull requests were NOT READ, so the second half ` +
              `of staleness is unmeasured. A claim is only released on silence AND no open ` +
              `pull request; releasing on the first alone would unassign work in review`,
          };
        }
        if (item.openLinkedPRs === 0) {
          return {
            kind: "release",
            // Already in Backlog: release the claim and leave it. In Ready:
            // the card must come back too, because Ready's entry condition
            // is "nobody assigned" and an unassigned card there asserts it
            // was re-checked as pickable, which nobody did. The spec's
            // backwards rule, applied to a claim that was abandoned.
            to: item.status === BACKLOG ? null : BACKLOG,
            why:
              `assigned on GitHub but silent for ${item.idleDays} day(s) with no open pull ` +
              `request, so the claim is stale. Releasing it: the backlog is for unassigned ` +
              `work, and board-ready.yml promotes it on merit once a slot frees`,
          };
        }
        // Silent, but a pull request is open against it. That is work in
        // flight whose activity simply does not touch the issue's own
        // `updatedAt`, which is the entire reason staleness is a
        // conjunction. It belongs in the assigned lane.
        return {
          kind: "correct",
          to: decision.lane,
          why:
            `assigned on GitHub with ${item.openLinkedPRs} open pull request(s) but the board ` +
            `says ${item.status}. The issue itself has been quiet for ${item.idleDays} day(s), ` +
            `which is why silence alone does not release a claim`,
        };
      }

      return {
        kind: "correct",
        to: decision.lane,
        why:
          `assigned on GitHub but the board says ${item.status}, and ${decision.why}. ` +
          // Lane-specific, because the two lanes are wrong for different
          // reasons and a reader acting on this needs the right one:
          // Backlog is the pool of work nobody has started, and Ready's
          // entry condition in `specs/BOARD-FLOW-SPEC.md` is literally
          // "nobody assigned" — an assigned card there also consumes a slot
          // in a lane that is WIP-capped.
          (item.status === "Ready"
            ? "Ready's entry condition is `nobody assigned`, and the lane is capped — an " +
              "assigned card here holds a slot against work that could be promoted"
            : "Backlog is the pool of work nobody has started"),
      };
    }
    // Unassigned in Backlog or Ready is exactly right. Fall through.
  }

  if (item.status !== DONE) return { kind: "agrees" };

  if (item.kind === "PullRequest" && !item.draft) {
    return {
      kind: "correct",
      to: IN_REVIEW,
      why: "open on GitHub but the board says Done",
    };
  }

  // A DRAFT pull request falls through to the same refusal as an open issue,
  // and `board-intake.yml` deliberately excludes drafts for the same reason.
  //
  // Its "Move the pull request to In review" step is guarded by
  // `github.event.pull_request.draft == false`, and the comment above that
  // guard says why: "a draft in `In review` says somebody is waiting on a
  // reader when nobody is". "Drafts stay in Backlog until" `ready_for_review`,
  // which that workflow also subscribes to. So intake and this sweep agree,
  // and a sweep that wrote In review for a draft would be a SECOND DECIDER
  // disagreeing with the first — the fourth shape in
  // `.claude/rules/checks-must-be-able-to-fail.md`, and the two would never
  // meet, because intake fires on an event and this runs by hand.
  //
  // **This comment has been wrong twice and the reason was the same both
  // times.** Round 7 found it citing a mechanism that was not there; the
  // round-8 repair replaced that with two further false claims, including a
  // quotation that existed nowhere but in the comment making it. Both were
  // written against a worktree whose `origin/main` was five merges stale, so
  // the workflow was read accurately and was the wrong workflow. BS-41 now
  // asserts every phrase quoted here against the real file, so a third
  // version cannot be wrong quietly.
  //
  // The refusal also stands on its own facts: a draft is not awaiting a
  // reader, so In review is wrong, and Done is wrong because it is open.
  // Nothing here can name the right column, which is what UNDECIDABLE means.
  const why =
    item.kind === "PullRequest"
      ? "open DRAFT pull request marked Done. Done is wrong because it is open, and In " +
        "review is wrong because a draft is not awaiting a reader — so the right column " +
        "is not derivable: a person has to pick it, or mark the pull request ready for review"
      : "open issue marked Done. Done is wrong, but Backlog, Ready and In progress are all " +
        "consistent with an open issue, so the right column is not derivable — a person has to pick it";

  return { kind: "undecidable", why };
}

export interface SweepReading {
  readonly agrees: number;
  readonly corrections: ReadonlyArray<BoardItem & { readonly to: string; readonly why: string }>;
  /**
   * Claims to release: unassign, and move to `to` when it is not null.
   *
   * Separate from `corrections` because it is a different act on a
   * different API, and a merged count could report a field write as an
   * unassignment.
   */
  readonly releases: ReadonlyArray<
    BoardItem & { readonly to: string | null; readonly why: string }
  >;
  readonly undecidable: ReadonlyArray<BoardItem & { readonly why: string }>;
}

export function sweep(items: readonly BoardItem[]): SweepReading {
  const corrections: Array<BoardItem & { to: string; why: string }> = [];
  const releases: Array<BoardItem & { to: string | null; why: string }> = [];
  const undecidable: Array<BoardItem & { why: string }> = [];
  let agrees = 0;

  for (const item of items) {
    const v = verdictFor(item);
    if (v.kind === "agrees") agrees += 1;
    else if (v.kind === "correct") corrections.push({ ...item, to: v.to, why: v.why });
    // A release is its own bucket, never folded into corrections. It is a
    // different act on a different API — a correction writes a project
    // field, a release writes the issue's assignees — so a count that mixed
    // them could report a successful field write as a successful
    // unassignment. BS-58 asserts the partition is still exact.
    else if (v.kind === "release") releases.push({ ...item, to: v.to, why: v.why });
    else undecidable.push({ ...item, why: v.why });
  }

  return { agrees, corrections, releases, undecidable };
}

export const BOARD_QUERY = `
query($project: ID!, $endCursor: String) {
  node(id: $project) {
    ... on ProjectV2 {
      items(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          fieldValues(first: 50) {
            pageInfo { hasNextPage }
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2FieldCommon { name } }
              }
            }
          }
          content {
            __typename
            # \`assignees\` is asked for on the Issue fragment ONLY. A pull
            # request is assignable too, but no row of the lane table in
            # \`specs/BOARD-FLOW-SPEC.md\` says where a pull request's own
            # card goes when somebody is on it — so the sweep must not be
            # able to see a fact it is not allowed to act on. BS-52.
            #
            # \`totalCount\` rather than a page of nodes: the question is
            # "is anybody on it", the count answers it in one field, and a
            # \`first: N\` page would reintroduce the same truncation
            # hazard \`statusUnread\` exists to handle one level up.
            ... on Issue { number state stateReason updatedAt assignees { totalCount } }
            ... on PullRequest { number state isDraft }
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
        pageInfo { hasNextPage }
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

/**
 * Turn one HTTP response into data or a legible error. Exported because it is
 * the single binding for "what went wrong", and a network call is not needed
 * to test any of its branches.
 *
 * THE ORDER MATTERS AND THE FIRST VERSION HAD IT WRONG. It parsed before
 * checking the status, so a 502 from an outage, an HTML rate-limit page or a
 * proxy error threw `SyntaxError: Unexpected token <` — the one case this
 * function exists to make legible, masked by a parse failure. Reading the body
 * as TEXT first keeps both facts available: the status, and what the server
 * actually said.
 */
export function interpretResponse(status: number, ok: boolean, text: string): unknown {
  const snippet = text.trim().slice(0, 200) || "(empty body)";

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `HTTP ${status}: the response was not JSON, so GitHub did not answer the query — ${snippet}`,
    );
  }

  // PARSING IS NOT THE SAME AS BEING A RESPONSE, and the first version of this
  // guard conflated them. `JSON.parse("null")` succeeds, so the catch above
  // never fires and `body.errors` becomes a property read on null — this
  // function, whose whole job is to turn a bad response into a legible error,
  // died with `Cannot read properties of null`.
  //
  // The quieter half is worse and is why the check is on the TYPE rather than
  // on null alone: `JSON.parse("5")` is 5, `(5).errors` is undefined, nothing
  // throws, and the function returns `body.data` — undefined. A crash is
  // recoverable; an undefined reading is the sweep reporting on a board it
  // never read (`.claude/rules/config-access.md`, Silent Default
  // Substitution).
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `HTTP ${status}: the response parsed as JSON but is not a response object — ${snippet}`,
    );
  }

  const body = parsed as { errors?: unknown; data?: unknown };

  // A GraphQL error arrives with HTTP 200, so the status alone is not a
  // reading.
  //
  // PRESENT IS NOT POPULATED, and the first version of this tested the wrong
  // one: `body.errors !== undefined` fires on `"errors": null` and on
  // `"errors": []`. A response that SUCCEEDED and carried an empty errors key
  // was then reported as a GraphQL failure whose entire message was
  // `GraphQL: null` or `GraphQL: []` — naming no defect and sending the
  // reader after a query problem that does not exist.
  //
  // "A compliant server does not send either on success" is not a defence
  // here. This function exists only to be defensive about responses that are
  // not well formed; that is its premise, not an excuse.
  //
  // A non-array truthy `errors` is an envelope shape this function does not
  // understand, and it refuses rather than returning `data` underneath it —
  // returning data on an unrecognised envelope is Silent Default
  // Substitution (`.claude/rules/config-access.md`).
  const errors = body.errors;
  const failed = Array.isArray(errors) ? errors.length > 0 : errors !== undefined && errors !== null;
  if (failed) throw new Error(`GraphQL: ${JSON.stringify(errors)}`);

  // **The status AND what the server said**, which is what the docblock above
  // promises and what this throw used to drop. A bad or scopeless token comes
  // back 401/403 with a well-formed body — `{"message": "Bad credentials"}` —
  // and no `errors` key, so `failed` above is false and both branches that
  // preserve `snippet` are skipped. The reader was then handed `3 attempts
  // failed, last: HTTP 401` by `withRetry`, for a permanent, non-retryable
  // credential problem whose cause was in a sentence this line threw away.
  // Caught in review of #1754; BS-36.
  if (!ok) throw new Error(`HTTP ${status}: ${snippet}`);
  return body.data;
}

/**
 * **Did the cursor actually move?** Returns `next` so the caller assigns
 * THROUGH the check rather than beside it.
 *
 * `requireConnection` validates one response and structurally cannot answer
 * this: whether a cursor advanced is a property of two consecutive responses.
 * A well-formed, non-empty `endCursor` returned unchanged forever passes every
 * shape check in this file and still spins `readBoard` forever.
 *
 * Repetition rather than a page cap. A cap cannot tell a board that grew from
 * a server that stopped advancing, so it either fires on legitimate growth or
 * sits so high it never fires; repetition is the exact signal and needs no
 * threshold. Found in review of #1754 — the third of the three failures that
 * finding named, and the one BS-43 cannot reach. BS-44.
 */
export function requireCursorAdvanced(previous: string | null, next: string): string {
  if (previous !== null && previous === next) {
    throw new Error(
      `The board returned the same endCursor twice (${JSON.stringify(next)}) while still ` +
        `reporting hasNextPage. The next request would repeat the page that produced it, ` +
        `so this would not terminate. UNMEASURED — the board was read only in part.`,
    );
  }
  return next;
}

/**
 * THE SAME CLASS AGAIN, ONE LEVEL DOWN. `requireNode` answers "did GitHub give
 * me a node at all", and both callers then reached straight into a nested
 * connection on it: `(requireNode(data, …) as any).items` and `… as
 * any).fields`.
 *
 * An id that resolves to something which is NOT a ProjectV2 leaves the `... on
 * ProjectV2` inline fragment unmatched. `node` is then a perfectly good
 * object, the query carries no `errors`, `requireNode` is satisfied — and the
 * connection is `undefined`, so `page.nodes` threw a bare `Cannot read
 * properties of undefined (reading 'nodes')`. An opaque stack trace, out of
 * the one script whose entire subject is telling a reading apart from an
 * absence.
 *
 * Caught in review of #1754, and it is the same defect as BR-40/BR-41 in
 * `scripts/board-ready.ts` — fixed there in this same session, in the sibling
 * script, without sweeping back to this one. Population here is 2 of 2 and
 * both go through this binding. BS-40.
 */
export function requireConnection(data: unknown, key: string, what: string): Record<string, any> {
  const node = requireNode(data, what);
  const page = node[key];
  if (page === null || page === undefined || typeof page !== "object") {
    throw new Error(
      `GitHub answered the ${what} query with a node carrying no "${key}" connection ` +
        `(it was ${page === undefined ? "absent" : JSON.stringify(page)}). The query ` +
        `SUCCEEDED — this is not an error response. ${PROJECT_ID} resolved to something ` +
        `that is not a ProjectV2, so the "... on ProjectV2" fragment matched nothing. ` +
        `Check the id; nothing was read and nothing was written.`,
    );
  }
  if (!Array.isArray((page as { nodes?: unknown }).nodes)) {
    throw new Error(
      `The "${key}" connection on the ${what} carries no nodes array, so there is nothing ` +
        `to read and an empty board and an unreadable one would look the same. UNMEASURED.`,
    );
  }
  // **And the pagination flag, which is the half that loses rows silently.**
  // `nodes` being wrong is loud — nothing to iterate. `pageInfo` being wrong
  // is quiet: `page.pageInfo.hasNextPage` on an absent `pageInfo` throws a
  // bare TypeError, and a non-boolean `hasNextPage` is falsy, which ENDS the
  // pagination loop and reports a short board as a complete one. That is the
  // same false-zero this file's header already records from a `first:100`
  // read against a 118-item board, arriving through the guard instead of
  // around it. Found in review of #1754; BS-42.
  const pageInfo = (page as { pageInfo?: unknown }).pageInfo;
  if (typeof pageInfo !== "object" || pageInfo === null) {
    throw new Error(
      `The "${key}" connection on the ${what} carries no pageInfo object, so this read ` +
        `cannot tell a complete list from the first page of a longer one. UNMEASURED.`,
    );
  }
  if (typeof (pageInfo as { hasNextPage?: unknown }).hasNextPage !== "boolean") {
    throw new Error(
      `The "${key}" connection on the ${what} has a pageInfo whose hasNextPage is ` +
        `${typeof (pageInfo as { hasNextPage?: unknown }).hasNextPage}, not a boolean. A ` +
        `non-boolean is falsy, which would end pagination here and report a SHORT ` +
        `${what} as a complete one. UNMEASURED.`,
    );
  }
  // **And the cursor, which is the half BS-42 missed.** A falsy `hasNextPage`
  // ends pagination early and reports a short list as complete; the mirror
  // image is a `hasNextPage: true` nothing can follow — `endCursor` null,
  // empty or not a string. `readBoard` would assign it, the next request
  // would carry an `after` that is effectively unset, GitHub would return
  // page one again saying `hasNextPage: true`, and `for (;;)` would never
  // exit: an unbounded loop burning API calls in a `--write` run with nobody
  // watching. Worse than the short read it is the twin of.
  //
  // Keyed on whether the cursor was REQUESTED. A GraphQL response carries
  // exactly the selection set, so an absent `endCursor` key means the query
  // never asked — that is `FIELDS_QUERY`, which refuses rather than pages.
  // Present-and-unusable and never-requested are different facts and only
  // the first is a defect. Found in review of #1754; BS-43, which also
  // asserts BOARD_QUERY still requests the cursor, so this cannot be
  // switched off by editing the query.
  const info = pageInfo as { hasNextPage: boolean; endCursor?: unknown };
  if (info.hasNextPage && "endCursor" in info) {
    const cursor = info.endCursor;
    if (typeof cursor !== "string" || cursor.length === 0) {
      throw new Error(
        `The "${key}" connection on the ${what} says hasNextPage is true and gives an ` +
          `endCursor of ${JSON.stringify(cursor ?? null)}, which cannot be followed. The ` +
          `next request would repeat this page and the pagination loop would never ` +
          `terminate. UNMEASURED.`,
      );
    }
  }
  return page as Record<string, any>;
}

/**
 * THE SAME CLASS, AT THE SITE THE REPORT DID NOT NAME, and this one fires on
 * an input GitHub really returns. `node(id: …)` resolves to **null** for an id
 * the token cannot see — not an error, a successful query with a null node —
 * so `data.node.items` was a property read on null exactly as `body.errors`
 * was. A `read:project` token hitting the `--write` path produces it.
 *
 * `null` and "no such field" are the same bytes to a property read, so this
 * says which one it was and what to do about it.
 */
export function requireNode(data: unknown, what: string): Record<string, unknown> {
  if (typeof data !== "object" || data === null) {
    throw new Error(`GitHub returned no data object when asked for the ${what}.`);
  }
  const node = (data as { node?: unknown }).node;
  if (node === null || node === undefined) {
    throw new Error(
      `GitHub answered the ${what} query with node: null for ${PROJECT_ID}. The query ` +
        `SUCCEEDED — this is not a syntax or id error. A project id the token cannot see ` +
        `reads as null, so check the credential carries project scope; read:project is ` +
        `enough to read the board and not enough to write it.`,
    );
  }
  if (typeof node !== "object") {
    throw new Error(`GitHub returned a ${typeof node} where the ${what} should be.`);
  }
  return node as Record<string, unknown>;
}

/**
 * Three attempts with backoff, matching `board-intake.yml`'s `gql()`.
 *
 * THE TWO HALVES OF THIS CHANGE MAKE THE SAME CALL AND ONLY ONE OF THEM
 * RETRIED. The workflow hardened it with the reasoning that "a bare
 * `gh api graphql` that fails on a network blip, a secondary rate limit or a
 * momentary 5xx aborts the step" — every word of which is true of `fetch`
 * here, and worse on the `--write` path, which issues one mutation per
 * correction.
 *
 * `attempts` and `sleep` are injected so the cases can prove the retry
 * without waiting on a real backoff.
 */
export async function withRetry<T>(
  call: () => Promise<T>,
  attempts = 3,
  sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms)),
): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await call();
    } catch (err) {
      last = err;
      if (attempt < attempts) await sleep(attempt * 2000);
    }
  }
  throw last instanceof Error
    ? new Error(`${attempts} attempts failed, last: ${last.message}`)
    : new Error(`${attempts} attempts failed: ${String(last)}`);
}

async function graphql(token: string, query: string, variables: Record<string, unknown>): Promise<any> {
  return withRetry(async () => rawGraphql(token, query, variables));
}

/**
 * **A hang is not an error, so `withRetry` never sees it.**
 *
 * `withRetry` exists to survive a transient failure, and every failure it
 * can survive is one that REJECTS — a network blip, a 5xx, a rate limit. A
 * connection that is accepted and then never answered, or a TLS handshake
 * that stalls, rejects nothing: `fetch` waits, `withRetry` is never given a
 * chance to retry, and `main()` blocks forever. On the `--write` path this
 * runs in CI with nobody watching, so the outcome the retry logic was built
 * to prevent — a run that silently never finishes or reports — was still
 * reachable, just through a trigger it does not cover. Caught in review of
 * #1754.
 *
 * One timeout per ATTEMPT, not per run: `withRetry` makes three, so a
 * genuinely slow-but-alive endpoint still gets three chances rather than one
 * shared budget.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Remove every assignee from one issue.
 *
 * REST, not GraphQL, and that is the cheap choice rather than a stylistic
 * one: `removeAssigneesFromAssignable` needs the issue's node id AND the
 * assignees' node ids, neither of which the board query carries, so it
 * would cost two more reads per release. `PATCH` with an empty array sets
 * the assignee list to empty in one call and needs only the number.
 *
 * **It verifies the result rather than trusting the status code.** A 200
 * whose body still lists assignees is the same shape BS-39 caught on the
 * field write: the mutation "succeeded" and the thing it was asked to
 * change did not change. Throwing here lets `applyCorrections` record it as
 * a failed release, which is what a reader needs to see.
 */
export async function clearAssignees(
  token: string,
  repo: string,
  issue: number,
): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${issue}`, {
    method: "PATCH",
    headers: {
      authorization: `bearer ${token}`,
      "content-type": "application/json",
      accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ assignees: [] }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = interpretResponse(res.status, res.ok, await res.text());
  const left = (body as any)?.assignees;
  if (!Array.isArray(left)) {
    throw new Error(
      `#${issue}: the unassign response carried no 'assignees' array, so whether the claim ` +
        `was released is UNMEASURED. Nothing may be reported as released on this reading.`,
    );
  }
  if (left.length > 0) {
    throw new Error(
      `#${issue}: PATCH returned ${res.status} and the issue still has ${left.length} ` +
        `assignee(s). The call succeeded and the claim was not released — this is the ` +
        `shape a credential without issue-write produces, so check the token's scope.`,
    );
  }
}

async function rawGraphql(token: string, query: string, variables: Record<string, unknown>): Promise<any> {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return interpretResponse(res.status, res.ok, await res.text());
}

/**
 * One GraphQL item node, as a `BoardItem` — or `null` for a node this sweep
 * has no opinion about (a draft issue, a deleted item, a redacted one).
 *
 * **Exported because it is the parsing half of the `statusUnread` fix and
 * nothing could see it.** Caught in review of #1754: every case in
 * `test/board-status-sweep.test.ts` built a `BoardItem` by hand and set
 * `statusUnread` as a literal, so a typo in the `field?.name === "Status"`
 * filter, a wrong nesting level, or an inverted `hasNextPage` would produce
 * wrong values and pass all 26 rows — the third shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`, an assertion holding
 * against a value the test itself just set. `readBoard` remains a network
 * loop with nothing decided inside it.
 */
export function parseBoardItem(node: any, now: number = Date.now()): BoardItem | null {
  const content = node?.content;
  if (content === null || content === undefined) return null;
  if (content.__typename !== "Issue" && content.__typename !== "PullRequest") return null;

  const status =
    (node.fieldValues?.nodes ?? [])
      .filter((f: any) => f?.field?.name === "Status")
      .map((f: any) => f.name)[0] ?? null;

  // A FALSE ZERO ONE LEVEL DOWN. The board query pages `items`, and the
  // per-item `fieldValues` connection was NOT paged: an item carrying
  // more field values than the page holds loses Status off the end, and
  // a missing Status reads as `null` — which `verdictFor` treats as "any
  // non-Done column", i.e. agreement. A genuinely wrong Done column
  // would be left uncorrected by `--write` and counted as agreeing.
  // Exactly the shape this file already fixed for `items(first:100)`.
  //
  // `&& status === null` is load-bearing in the other direction too: a
  // truncated page that DID carry Status was read, and calling it unread
  // would refuse every large item for no reason.
  const statusUnread = node.fieldValues?.pageInfo?.hasNextPage === true && status === null;

  return {
    itemId: node.id,
    number: content.number,
    kind: content.__typename,
    state: content.state,
    status,
    // `isDraft` is absent on the Issue fragment, and an undefined here
    // would make `!item.draft` true for every item — the draft branch
    // would never run and BS-13 would be green against a sweep that
    // still moves drafts. Coerce, so the field is a boolean or nothing
    // reaches the verdict.
    draft: content.isDraft === true,
    stateReason: typeof content.stateReason === "string" ? content.stateReason : null,
    // `typeof === "number"` and not a truthiness check or a `?? 0`. An
    // absent `assignees`, a null one, and a null `totalCount` are all
    // things GraphQL really returns — a partial error nulls a nested field
    // and delivers the rest of the row intact — and every one of them means
    // NOT READ. `?? 0` would spell all three as "nobody assigned", which is
    // the exact substitution the `assigned` docblock refuses. BS-53.
    assigned:
      typeof content.assignees?.totalCount === "number"
        ? content.assignees.totalCount > 0
        : null,
    // `now` is injected rather than read here, so a boundary case is
    // testable without the test controlling the clock — and so this stays
    // a pure function of its two arguments. An unparseable or absent
    // timestamp is `null`, NOT zero days: "no activity recorded" and
    // "active today" are opposite answers to the staleness question.
    idleDays: idleDaysSince(content.updatedAt, now),
    // Never resolved here. `readBoard` fills it for stale-claim candidates
    // only, because it costs a query per row and no other verdict asks.
    openLinkedPRs: null,
    statusUnread,
  };
}

/** Every item, paginated. A bare first:100 against a 121-item board returns a FALSE ZERO. */
async function readBoard(token: string): Promise<BoardItem[]> {
  const items: BoardItem[] = [];
  let endCursor: string | null = null;

  for (;;) {
    const data = await graphql(token, BOARD_QUERY, { project: PROJECT_ID, endCursor });
    const page = requireConnection(data, "items", "project board");

    for (const node of page.nodes) {
      const item = parseBoardItem(node);
      if (item !== null) items.push(item);
    }

    if (!page.pageInfo.hasNextPage) break;
    // Through the invariant, not beside it — `requireConnection` has already
    // proved this cursor is a usable string, and only this line can see
    // whether it is a DIFFERENT one from last time. BS-44.
    endCursor = requireCursorAdvanced(endCursor, page.pageInfo.endCursor);
  }

  return items;
}

/**
 * The open pull requests referencing one issue.
 *
 * `CROSS_REFERENCED_EVENT` is the same relation `scripts/work-status.ts`
 * reads, deliberately: "what counts as a linked pull request" already has
 * an owner in this repository and a second spelling here would be two
 * answers to one question with nothing comparing them.
 *
 * `last: 100` rather than a paging loop. The question is "is there at least
 * one OPEN pull request", and an issue with more than a hundred cross
 * references whose only open one fell off the end is not a case this has to
 * be right about — a row that busy is not a stale claim. The truncation
 * direction is also the safe one: the worst it can do is leave a claim
 * standing.
 */
export const LINKED_PRS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      timelineItems(last: 100, itemTypes: [CROSS_REFERENCED_EVENT]) {
        nodes {
          ... on CrossReferencedEvent {
            source { ... on PullRequest { number state } }
          }
        }
      }
    }
  }
}`;

/**
 * Fill `openLinkedPRs` for the stale-claim candidates, and ONLY for those.
 *
 * One query per candidate, which is why the candidate test exists at all:
 * on 2026-11-06 that was 7 queries against a 176-item board rather than
 * 176. Everything else keeps `null`, and no verdict outside the release
 * branch asks the question.
 *
 * **A failed fetch leaves `null` rather than assuming zero**, so the row
 * comes out UNDECIDABLE and the claim stands. The whole point of the field
 * is that an unread pull-request list must not be able to unassign
 * somebody.
 */
export async function resolveLinkedPullRequests(
  token: string,
  repo: string,
  items: readonly BoardItem[],
): Promise<BoardItem[]> {
  const [owner, name] = repo.split("/");
  const out: BoardItem[] = [];
  for (const item of items) {
    if (!isStaleClaimCandidate(item)) {
      out.push(item);
      continue;
    }
    let openLinkedPRs: number | null = null;
    try {
      const data: any = await graphql(token, LINKED_PRS_QUERY, {
        owner,
        name,
        number: item.number,
      });
      const nodes = data?.repository?.issue?.timelineItems?.nodes;
      if (Array.isArray(nodes)) {
        const open = new Set<number>();
        for (const n of nodes) {
          const pr = n?.source;
          if (pr && typeof pr.number === "number" && pr.state === "OPEN") open.add(pr.number);
        }
        openLinkedPRs = open.size;
      }
    } catch (e) {
      // Named, not swallowed. A silent catch here is the fail-open shape
      // in `.claude/rules/checks-must-be-able-to-fail.md`; leaving `null`
      // keeps the row undecidable, and the line below is what tells a
      // reader why a claim they expected to be released still stands.
      console.log(
        `::warning::#${item.number}: could not read linked pull requests (${String(e)}), so ` +
          `its claim is UNDECIDABLE rather than stale. Nothing was unassigned.`,
      );
    }
    out.push({ ...item, openLinkedPRs });
  }
  return out;
}

async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      write: { type: "boolean", default: false },
      // Only a RELEASE needs this — it writes the issue, not the board.
      repo: { type: "string" },
    },
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

  const repoForReads = (values.repo as string | undefined) ?? process.env.GITHUB_REPOSITORY ?? "";
  const board = await readBoard(token);
  // Stale-claim candidates only, and ONLY when a repository is resolvable.
  // With no repo the pull-request half cannot be read, every candidate
  // keeps `openLinkedPRs: null`, and `verdictFor` reports it UNDECIDABLE —
  // which is the correct reading for "I could not check", not a silent
  // decision to leave claims alone.
  const items =
    repoForReads === ""
      ? board
      : await resolveLinkedPullRequests(token, repoForReads, board);
  const reading = sweep(items);

  console.log(`Board status sweep — ${items.length} item(s) read from ${PROJECT_ID}\n`);
  console.log(`  agrees with GitHub : ${reading.agrees}`);
  console.log(`  disagrees          : ${reading.corrections.length}`);
  console.log(`  stale claims       : ${reading.releases.length}`);
  console.log(`  undecidable        : ${reading.undecidable.length}\n`);

  for (const c of reading.corrections) {
    console.log(`  #${c.number} ${c.kind} ${c.status ?? "(no status)"} -> ${c.to}  (${c.why})`);
  }
  for (const r of reading.releases) {
    const move = r.to === null ? "stays in Backlog" : `-> ${r.to}`;
    console.log(`  #${r.number} ${r.kind} RELEASE unassign, ${move}  (${r.why})`);
  }
  for (const u of reading.undecidable) {
    console.log(`  #${u.number} ${u.kind} UNDECIDABLE  (${u.why})`);
  }

  if (!values.write) {
    // **The instruction has to match what the run found.** One message
    // served both branches, so a run with only undecidable rows said
    // "re-run with --write to apply the corrections above" when there were
    // no corrections above and `--write` would change nothing — it is
    // explicitly refused for these rows. An instruction that cannot work is
    // worse than none: the reader runs it, sees no change, and learns to
    // distrust the tool rather than to go and pick the column. Caught in
    // review of #1754.
    if (reading.corrections.length > 0 || reading.releases.length > 0) {
      console.log("\nReport only. Re-run with --write to apply the changes above.");
      if (reading.undecidable.length > 0) {
        console.log("Undecidable rows are never written, with or without --write.");
      }
      return DRIFT_EXIT;
    }
    if (reading.undecidable.length > 0) {
      console.log(
        "\nReport only, and nothing here is writable: every row above is UNDECIDABLE. " +
          "`--write` would change none of them. A person has to pick the column.",
      );
      return DRIFT_EXIT;
    }
    console.log("\nThe board agrees with GitHub.");
    return 0;
  }

  // **Nothing to write, so nothing to resolve.** `--write` fell through to the
  // field lookup whatever the reading said, which exposed a no-op run to two
  // failure modes that have nothing to do with the work it was asked to do:
  // the "Status field was not on the first page" refusal, and "no Status field
  // on this project". A report-only run against the same board never touches
  // this path and cannot fail that way, so `--write` on a clean board was
  // strictly more fragile than not passing it. Undecidable rows are never
  // written either, so they do not make a run writable. Caught in review of
  // #1754; BS-38.
  if (reading.corrections.length === 0 && reading.releases.length === 0) {
    console.log(
      reading.undecidable.length > 0
        ? "\nNothing to write: every row above is UNDECIDABLE and those are never written, " +
            "with or without --write. A person has to pick the column."
        : "\nThe board agrees with GitHub. Nothing to write.",
    );
    return reading.undecidable.length > 0 ? DRIFT_EXIT : 0;
  }

  // A release writes the ISSUE, which needs the repository; the board does
  // not. Resolved once, here, and refused LOUDLY rather than skipped — a
  // run that quietly performed the field writes and silently dropped the
  // releases would report a partially-corrected board as a corrected one.
  const repo = (values.repo as string | undefined) ?? process.env.GITHUB_REPOSITORY ?? "";
  if (reading.releases.length > 0 && repo === "") {
    console.error(
      `UNMEASURED: ${reading.releases.length} stale claim(s) need unassigning, which writes the ` +
        `ISSUE and therefore needs a repository. Pass --repo <owner/name> or set ` +
        `GITHUB_REPOSITORY. Nothing was written, including the field corrections — a run that ` +
        `did half of this and reported success is the outcome this script exists to prevent.`,
    );
    return DRIFT_EXIT;
  }

  const fields = await graphql(token, FIELDS_QUERY, { project: PROJECT_ID });
  const fieldPage = requireConnection(fields, "fields", "project fields");
  const statusField = fieldPage.nodes.find((f: any) => f?.name === "Status");
  if (statusField === undefined) {
    // **Absent and not-fetched are different facts**, and `find` returns the
    // same `undefined` for both. `fields(first: 50)` carried no `pageInfo` at
    // all, so a board grown past fifty custom fields would put Status on page
    // two and this line would report it as missing — sending whoever hit it
    // to look for a field that is already there. Caught in review of #1754;
    // BS-37. Every other list in this file pages or declares its truncation.
    if (fieldPage.pageInfo?.hasNextPage === true) {
      throw new Error(
        "UNMEASURED: the Status field was not on the first page of this project's fields, " +
          "and the rest were not fetched. This is not 'no Status field' — it is a board with " +
          "more than 50 custom fields, which this query does not yet page through.",
      );
    }
    throw new Error("no Status field on this project");
  }

  const optionId = (name: string): string => {
    const found = statusField.options.find((o: any) => o.name === name);
    if (found === undefined) throw new Error(`no '${name}' option on the Status field`);
    return found.id;
  };

  const applied = await applyCorrections(reading.corrections, async c => {
    requireWrittenItem(
      await graphql(token, SET_STATUS, {
        project: PROJECT_ID,
        item: c.itemId,
        field: statusField.id,
        option: optionId(c.to),
      }),
      c.number,
      c.itemId,
    );
  });

  for (const w of applied.wrote) console.log(`  wrote #${w.number} -> ${w.to}`);
  for (const f of applied.failed) console.log(`  FAILED #${f.number} -> ${f.to}: ${f.error}`);

  // RELEASES, through the same recorder, so a failed unassign is reported
  // the way a failed field write is. The assignment goes first: if the move
  // to Backlog succeeded and the unassign then failed, the card would sit
  // unassigned-looking in Backlog while the claim still stood — a board
  // that reads correct and is not. Releasing first means a half-failure
  // leaves the card where it was, which is visibly wrong and therefore
  // safe.
  const released = await applyCorrections(
    reading.releases.map(r => ({ ...r, to: r.to ?? "(unassigned, already in Backlog)" })),
    async r => {
      await clearAssignees(token, repo, r.number);
      const back = reading.releases.find(x => x.number === r.number)?.to ?? null;
      if (back !== null) {
        requireWrittenItem(
          await graphql(token, SET_STATUS, {
            project: PROJECT_ID,
            item: r.itemId,
            field: statusField.id,
            option: optionId(back),
          }),
          r.number,
          r.itemId,
        );
      }
    },
  );
  for (const w of released.wrote) console.log(`  released #${w.number} — ${w.to}`);
  for (const f of released.failed) console.log(`  FAILED release #${f.number}: ${f.error}`);

  console.log(
    `\nWrote ${applied.wrote.length} correction(s) and released ${released.wrote.length} claim(s).`,
  );
  if (released.failed.length > 0) {
    console.log(
      `${released.failed.length} release(s) FAILED. The most likely cause is a credential that ` +
        `can write the board but not the issues — a board PAT needs issue-write to unassign.`,
    );
    return DRIFT_EXIT;
  }
  if (applied.failed.length > 0) {
    console.log(
      `${applied.failed.length} correction(s) FAILED and the board is partially corrected. ` +
        `The rows above name exactly which; re-run to retry only those.`,
    );
    return DRIFT_EXIT;
  }
  if (reading.undecidable.length > 0) {
    console.log(`${reading.undecidable.length} row(s) still need a person to choose a column.`);
    return DRIFT_EXIT;
  }
  return 0;
}

export interface Applied {
  readonly wrote: ReadonlyArray<{ number: number; to: string }>;
  readonly failed: ReadonlyArray<{ number: number; to: string; error: string }>;
}

/**
 * The id the mutation says it wrote, or a throw naming what came back.
 *
 * **A write was validated nowhere.** `SET_STATUS` returns
 * `projectV2Item { id }` and the result was discarded, so `applyCorrections`
 * treated anything that did not throw as written and logged
 * `wrote #N -> Status`. That is the exact shape this file guards against on
 * every READ — `requireNode` exists because `node(id:)` resolves to `null`
 * with no `errors` — applied to the one operation that changes the board.
 *
 * `updateProjectV2ItemFieldValue` can return `{ projectV2Item: null }` in a
 * 200 with no `errors`: the item concurrently removed from the project, or a
 * credential that may write some fields and not this one. The mutation then
 * "succeeded", the correction was reported as applied, and the board went on
 * disagreeing with GitHub — which is the single outcome this tool exists to
 * detect and report honestly. Caught in review of #1754; BS-39.
 *
 * It THROWS rather than returning a verdict so the existing `applyCorrections`
 * try/catch routes it into `failed`, where it is named and keeps the exit
 * non-zero. One binding, so a mutation of it has one site.
 */
export function requireWrittenItem(data: unknown, issue: number, expected: string): string {
  const payload = (data as any)?.updateProjectV2ItemFieldValue;
  const id = payload?.projectV2Item?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(
      `the Status write for #${issue} returned no item id, so nothing confirms it was applied — ` +
        `the response carried ${JSON.stringify(payload ?? null)}. Treating it as NOT written.`,
    );
  }
  if (id !== expected) {
    throw new Error(
      `the Status write for #${issue} targeted item ${expected} and GitHub answered about ` +
        `${id}. A well-formed id for a DIFFERENT item confirms nothing about this correction, ` +
        `so #${issue} may still disagree with the board. Treating it as NOT written.`,
    );
  }
  return id;
}

/**
 * Apply every correction, and finish the batch even when one fails.
 *
 * THE LOOP USED TO THROW OUT OF `main()`. A transient failure on correction 3
 * of 5 crashed the process mid-batch, leaving the board partially corrected
 * with no record of which writes landed — only whatever `console.log` had
 * already printed. The run then reported nothing, which for a tool whose
 * whole job is to make the board legible is the worst available outcome.
 *
 * Each failure is NAMED and the exit stays non-zero, so a partial batch is a
 * reading rather than a crash.
 */
export async function applyCorrections<T extends { number: number; to: string }>(
  corrections: readonly T[],
  write: (c: T) => Promise<void>,
): Promise<Applied> {
  const wrote: Array<{ number: number; to: string }> = [];
  const failed: Array<{ number: number; to: string; error: string }> = [];

  for (const c of corrections) {
    try {
      await write(c);
      wrote.push({ number: c.number, to: c.to });
    } catch (err) {
      failed.push({
        number: c.number,
        to: c.to,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { wrote, failed };
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
