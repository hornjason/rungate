/**
 * When a blocking issue closes, which of the issues it was blocking should
 * move to Ready — and which should be left exactly where they are.
 *
 * #1744. Moves Claim 7, whose third falsification reads *"a board state
 * reachable only by someone running a command by hand"*. Ready is that today:
 * `board-mirror --ready --write` is the only thing that writes it, and a
 * person has to remember.
 *
 * ## Why an Action at all
 *
 * Researched against docs.github.com on 2026-11-03. GitHub has no built-in
 * workflow keyed on dependencies; `actions/add-to-project` takes only
 * `project-url`, `github-token`, `labeled` and `label-operator` and **cannot
 * set a field**. GitHub's own documented answer for this is a self-written
 * Action driving `updateProjectV2ItemFieldValue`.
 *
 * There is also **no "became unblocked" event**. `issue_dependencies` exists
 * as a webhook but is not a valid Actions `on:` trigger, and
 * `blocked_by_removed` fires when somebody unlinks a dependency, not when the
 * blocker closes. So the trigger is `issues: [closed]` and the fan-out walks
 * that issue's `blocking` list. No cron — a schedule is the thing this exists
 * to remove.
 *
 * GitHub roadmap **#1336 "Granular issue status"** is in public preview and
 * would make this module dead code. That is a reason to keep it small, not a
 * reason to wait.
 *
 * ## What this file deliberately does NOT do
 *
 * **It does not decide readiness.** `isReady` does, and it carries the
 * cap and ordering that stop the Ready lane holding 36 of 46 open
 * issues. A second decider here would agree with it on every input anybody
 * thought to test, so no behavioural case could tell which was live and a
 * mutation of either would leave the other holding the case up. `BR-7`
 * asserts the agreement across a 48-row grid rather than trusting the import.
 *
 * **It does not add anything to the board.** Membership is `board-mirror`'s.
 * An Action that added items would make the board's contents depend on which
 * issues happened to close.
 */
import { isReady } from "./board-mirror";
import { laneFor } from "./board-flow";
import { workVerdict } from "./board-lane-health";
import { inReadyScope, type ActiveMilestone } from "./board-ready-rule";

/** One issue that the closed blocker was blocking. */
export interface Dependent {
  readonly number: number;
  /** `OPEN` or `CLOSED`, as GraphQL spells it. */
  readonly state: string;
  /**
   * The milestone TITLE, or `null` — never a pre-read phase number (#1943).
   * The family is half the order and a number has already discarded it; see
   * `Rankable` in `lib/board-ready-rule.ts`.
   */
  readonly milestone: string | null;
  /**
   * Every label on the issue, verbatim — the ordering's SECOND source
   * (#1853). An empty array means the issue carries none; this script never
   * reads a page that can truncate labels, so there is no third state.
   *
   * It is not filtered to the ranked set here. `placementOf` owns which
   * labels rank, and filtering on the way in would put a second opinion
   * about that in this file.
   */
  readonly labels: readonly string[];
  /**
   * OPEN blockers only — the lifetime count never goes back down.
   *
   * **`null` means the dependency summary could not be read**, which is not
   * the same as zero. `issueDependenciesSummary` is absent on a response the
   * token was not scoped for, and `?? 0` turned that into "nothing is
   * blocking it" — a fail-open that moves a genuinely blocked issue to
   * Ready. Caught in review of #1747.
   */
  readonly blockedByOpen: number | null;
  /**
   * **`null` means the assignee count could not be read**, exactly as above.
   * `?? 0` here says "nobody has claimed it", and that is the direction that
   * MOVES — an issue somebody is already working on lands in Ready. The
   * sibling field was fixed for this and this one was left; caught in review
   * of #1747, round 7.
   */
  readonly assignees: number | null;
  /** Is this issue on the board at all? Membership is `board-mirror`'s. */
  readonly onBoard: boolean;
  /**
   * The board column, or `null` when the item has no Status VALUE.
   *
   * Not the same question as `onBoard`, and the two were one field until
   * review of #1747 round 6. GraphQL returns a
   * `ProjectV2ItemFieldSingleSelectValue` node only for a field that already
   * has a value, so an item added to the project and never given a Status
   * returns no node — producing the same `null` as an issue that is not on
   * the board. One of those means "board-mirror owns this, leave it"; the
   * other means "it is here and I cannot see where".
   */
  readonly boardStatus: string | null;
}

export type FanoutDecision =
  | { readonly number: number; readonly move: true }
  | { readonly number: number; readonly move: false; readonly why: string };

/**
 * Why `isReady` said no, for the log.
 *
 * **This explains a verdict; it never produces one.** It is only ever called
 * after `isReady` has already returned false, so a wrong or incomplete reason
 * costs a confusing log line and cannot move an issue. Keeping that ordering
 * is what stops it becoming the second decider described above.
 *
 * ## There is no "did not anticipate it" fallback, and that is deliberate
 *
 * One stood here until the phase gate was removed. With the two phase
 * branches gone the remaining tests enumerate every input `isReady` reads,
 * so the fallback became a line that could not run — the shape
 * `.claude/rules/checks-must-be-able-to-fail.md` names, reading as a live
 * safety net while catching nothing. ai-review round 1 of #1796.
 *
 * **Removing it required fixing a real gap first.** `isUnblocked` refuses
 * anything that is not exactly `0`, and these guards asked `> 0`, so a
 * negative count — which no GraphQL response produces, but nothing here
 * rejected either — made `isReady` false and reached the fallback. The
 * guards now match the contract they explain, which is what makes the
 * enumeration genuinely exhaustive rather than nearly so.
 *
 * Exhaustiveness is asserted over the whole input grid in
 * `test/board-ready-fanout.test.ts`, not claimed here: a condition added to
 * `isReady` and not to this list makes a row return the wrong reason, and
 * that row goes red.
 */
export function whyNotReady(d: Dependent): string {
  if (d.state !== "OPEN") return `the issue is ${d.state}`;
  if (d.blockedByOpen === null) return "UNMEASURED — the dependency summary could not be read";
  if (d.blockedByOpen !== 0) {
    return `${d.blockedByOpen} open blocker${d.blockedByOpen === 1 ? "" : "s"} remain`;
  }
  if (d.assignees === null) return "UNMEASURED — the assignee count could not be read";
  /**
   * #1941: "somebody has claimed it" stood here, and a claim is not work.
   * The question is decided in one place — `workVerdict` in
   * `lib/board-lane-health.ts` — and this is its second caller.
   *
   * **A `Dependent` carries none of the three evidence fields**, so every
   * one is NOT READ and this call can only ever return UNMEASURED. That is
   * not a wasted call and it is not a placeholder: the honest reason this
   * issue is not going to Ready is that somebody has claimed it and nobody
   * asked whether they are working on it. The sentence now says both, and
   * it says it in the decider's words rather than this file's.
   *
   * Giving the fanout real evidence means adding a pull-request reading to
   * `Dependent`, which is built in `scripts/board-ready.ts` — a file
   * outside this issue and currently under review on #1971. Deliberately
   * not done here.
   */
  const work = workVerdict({ openPullRequest: null, pushedBranch: null, localCommits: null });
  return `somebody has claimed it, and ${work.why}`;
}

/**
 * A card already sitting in the Ready column, as the occupancy walk sees it.
 *
 * Deliberately not a `Dependent`. A `Dependent` is an APPLICANT — it carries
 * `phase`, `labels`, `assignees` and `onBoard`, all of which exist to decide
 * whether something may ENTER the lane. An incumbent is already in, already
 * on the board by construction, and the only question asked of it is the one
 * that can become false after promotion.
 */
export interface Incumbent {
  readonly number: number;
  /** `Issue`, `PullRequest`, or whatever else GitHub puts on a board. */
  readonly typename: string;
  readonly state: string | null;
  /** The board column this card is in, or `null` when it has no Status value. */
  readonly boardStatus: string | null;
  /**
   * OPEN blockers, or `null` for UNMEASURED — same contract as
   * `Dependent.blockedByOpen`, and the same reason: a token that cannot read
   * `issueDependenciesSummary` must not read as "nothing is blocking it".
   */
  readonly blockedByOpen: number | null;
  /** The card's milestone title, or `null` — what the focus is judged on (SC-2741). */
  readonly milestone: string | null;
  /** Its labels, so a card carrying the expedite label keeps its slot. */
  readonly labels: readonly string[];
}

/**
 * The focus Ready's incumbents are held to (SC-2741). `expediteLabel` is
 * `board.expediteLabel`, passed in — `lib/config-readers.ts` holds the one
 * binding — and `null` exempts nobody.
 */
export interface ReadyScope {
  readonly active: ActiveMilestone;
  readonly expediteLabel: string | null;
}

export type IncumbentDecision =
  | { readonly number: number; readonly demote: true; readonly to: string; readonly why: string }
  | { readonly number: number; readonly demote: false; readonly why: string };

/**
 * Ready's entry condition, applied to the lane's current occupants (#1929).
 *
 * **Promotion is one-way with respect to blockers and this is the half that
 * closes it.** A card is promoted when `isReady` says yes; nothing re-asks
 * afterwards, because the event that would prompt it — `blocked_by_added` —
 * exists on the REST timeline and emits no webhook. Measured on #1495:
 * promoted 00:41:41Z, blocked 02:01:08Z, zero workflow runs started at the
 * second timestamp against four unfiltered `issues` subscribers.
 *
 * Three things it deliberately does not do:
 *
 *   - **It does not decide readiness.** The reason text is `whyNotReady`'s
 *     and the destination lane is `laneFor`'s. Two deciders for either
 *     question would agree on every input anybody tests and a mutation of
 *     one would leave the other holding the case up.
 *   - **It touches only the Ready column.** An issue in In progress is
 *     allowed an open blocker — somebody has claimed it, and yanking their
 *     card back would be this rule acting outside the condition it enforces.
 *   - **UNMEASURED never moves**, and a non-issue never moves, because a
 *     pull request parked in Ready holds a slot and has no dependency
 *     reading at all.
 *
 * The honest limit, stated rather than discovered: this corrects on the next
 * qualifying event, not at the moment of blocking. Between the edge being
 * added and the next close/assign/unassign/open/reopen anywhere on the
 * repository, the lane is still wrong. That window is unavoidable while
 * GitHub emits no event for a dependency change.
 */
export function incumbentDecisions(
  incumbents: readonly Incumbent[],
  readyColumn: string,
  /**
   * REQUIRED, with no default: a caller that could omit it would keep every
   * card outside the focus, which is the defect SC-2741 closes.
   */
  scope: ReadyScope,
): IncumbentDecision[] {
  const backwards = laneFor({ kind: "issue_blocked_in_ready" });
  return incumbents.map((c): IncumbentDecision => {
    if (c.boardStatus !== readyColumn) {
      return { number: c.number, demote: false, why: `not in ${readyColumn}` };
    }
    if (c.typename !== "Issue") {
      return { number: c.number, demote: false, why: `a ${c.typename} has no blocker graph` };
    }
    if (c.state !== "OPEN") {
      return { number: c.number, demote: false, why: `the issue is ${c.state}` };
    }
    if (c.blockedByOpen === null) {
      return {
        number: c.number,
        demote: false,
        why: "UNMEASURED — the dependency summary could not be read",
      };
    }
    if (c.blockedByOpen === 0) {
      // **Unblocked, so the focus decides** (SC-2741). A blocked card is
      // demoted for its blocker below, once, with that reason; this branch is
      // for the card that meets every entry condition except being in the
      // active milestone — a card dragged in by hand, or one promoted under
      // the label-and-phase ordering this replaced. Without it, it holds its
      // slot forever, because no other rule ever re-asks.
      const expedited = scope.expediteLabel !== null && c.labels.includes(scope.expediteLabel);
      if (inReadyScope(c, scope.active, expedited)) {
        return { number: c.number, demote: false, why: "still unblocked and inside the active milestone" };
      }
      if (backwards.lane === null) {
        return {
          number: c.number,
          demote: false,
          why: `UNMEASURED — laneFor gave no destination: ${backwards.why}`,
        };
      }
      return {
        number: c.number,
        demote: true,
        to: backwards.lane,
        why:
          `${c.milestone === null ? "it has no milestone" : `it sits in ${c.milestone}`}, outside the ` +
          `active milestone — ${scope.active.why}`,
      };
    }
    // The lane itself is UNMEASURED if the one rule for moving backwards has
    // no answer. Writing a literal here would be the second decider.
    if (backwards.lane === null) {
      return {
        number: c.number,
        demote: false,
        why: `UNMEASURED — laneFor gave no destination: ${backwards.why}`,
      };
    }
    return {
      number: c.number,
      demote: true,
      to: backwards.lane,
      why:
        `${whyNotReady({
          number: c.number,
          state: c.state,
          milestone: null,
          labels: [],
          blockedByOpen: c.blockedByOpen,
          assignees: 0,
          onBoard: true,
          boardStatus: c.boardStatus,
        })}, so it no longer meets ${readyColumn}'s entry condition`,
    };
  });
}

/**
 * One decision per dependent. Writes nothing; the caller performs the moves.
 */
export function fanoutDecisions(
  dependents: readonly Dependent[],
  readyColumn: string,
): FanoutDecision[] {
  return dependents.map((d): FanoutDecision => {
    if (!d.onBoard) {
      return { number: d.number, move: false, why: "not on the board — board-mirror owns membership" };
    }
    // On the board, and no Status value. Distinct from the line above on
    // purpose: the caller resolves the Status FIELD ID from the item's own
    // value node, so an item that has never had a Status has nothing to
    // write through. Saying "not on the board" sent the reader to
    // board-mirror to add an item that was already there.
    if (d.boardStatus === null) {
      return {
        number: d.number,
        move: false,
        why:
          "UNMEASURED — it is on the board with no Status value, so there is no Status field id " +
          "to write through. This is NOT absent from the board.",
      };
    }
    if (d.boardStatus === readyColumn) {
      return { number: d.number, move: false, why: `already ${readyColumn}` };
    }
    // An unreadable blocker count is UNMEASURED, and UNMEASURED never moves.
    // It cannot be handed to `isReady`, whose parameter is a number and whose
    // honest answer here does not exist — the question is unanswerable, not
    // answered false. Refusing before the decider is what keeps `isReady` the
    // only thing that says yes.
    if (d.blockedByOpen === null || d.assignees === null) {
      return { number: d.number, move: false, why: whyNotReady(d) };
    }
    const measured = { ...d, blockedByOpen: d.blockedByOpen, assignees: d.assignees };
    if (!isReady(measured)) {
      return { number: d.number, move: false, why: whyNotReady(d) };
    }
    return { number: d.number, move: true };
  });
}

/** What the two candidate walks produced, as one set the decider reads once. */
export interface MergedCandidates<T> {
  /** Every candidate, deduplicated by number, close-freed ones first. */
  readonly candidates: readonly T[];
  /** The numbers THIS close freed — the set the log names in full. */
  readonly freed: ReadonlySet<number>;
}

/**
 * The two candidate sources, merged into the one array the decider reads.
 *
 * ## Why both may run at once (#1917)
 *
 * A close is the one event that reliably FREES a slot in Ready, and it used to
 * be the one event that could not refill the lane from the general pool:
 * `.github/workflows/board-ready.yml` ran `--closed-issue` on `closed` and
 * `--top-up` on everything else, so a close that unblocked nothing left the
 * lane one short until a person ran a command by hand. Measured 2026-11-08 —
 * #1889 closed, run `42528160275` reported "was blocking nothing", 33
 * candidates were eligible against a depth of 2 with one slot free, and a
 * hand-run top-up moved #1157 within seconds.
 *
 * ## The two sets are not disjoint, and the fan-out adds no candidate
 *
 * The top-up query asks for `states:[OPEN]` over the whole repository, so it
 * already contains every OPEN issue a `blocking` list can produce. What the
 * fan-out contributes is `freed`: the issues THIS close unblocked, which the
 * caller names in full — movers and non-movers alike — where a top-up names
 * only the movers. Concatenating instead of merging would hand the decider the
 * same issue twice and let one close count against the cap twice.
 *
 * **It lives here rather than inline in the script so a case can hold it.** A
 * `main()` that needs a live GraphQL endpoint cannot be asked this question.
 *
 * A node with no numeric `number` is carried through unchanged rather than
 * dropped: it is unreadable rather than duplicate, and `truncatedReadings` and
 * the caller's mapping are where that is judged.
 */
export function mergeCandidateSources<T extends { readonly number?: unknown }>(
  fromClose: readonly T[],
  fromTopUp: readonly T[],
): MergedCandidates<T> {
  const freed = new Set<number>();
  for (const n of fromClose) {
    if (typeof n?.number === "number") freed.add(n.number);
  }
  const candidates: T[] = [];
  const seen = new Set<number>();
  // Close-freed first, so the log names what this event freed before the pool
  // it was topped up from. Ordering does not decide promotion — `selectReady`
  // sorts by `readyOrder` — so this is a reading order, not a priority.
  for (const n of [...fromClose, ...fromTopUp]) {
    if (typeof n?.number === "number") {
      if (seen.has(n.number)) continue;
      seen.add(n.number);
    }
    candidates.push(n);
  }
  return { candidates, freed };
}

/** A GraphQL connection, as far as truncation is concerned. */
interface MaybeTruncated {
  readonly pageInfo?: { readonly hasNextPage?: boolean } | null;
  readonly nodes?: readonly unknown[] | null;
}

/**
 * Which dependents had their board membership read only in part.
 *
 * `projectItems` and `fieldValues` are sub-selections inside a paginated
 * list, so cursoring them costs a round trip per node and both are bounded
 * in practice. **"Bounded in practice" is the reasoning that has been wrong
 * four times on this day's work**, so it is not trusted: each is asked for
 * with a `pageInfo`, and a truncated page is UNMEASURED.
 *
 * It matters because a Status field on page two and no Status field at all
 * produce the same `undefined`, and one of those means "leave it alone"
 * while the other means "I could not look".
 */
export function truncatedReadings(
  dependents: readonly { readonly number: number; readonly projectItems?: MaybeTruncated | null }[],
): number[] {
  return dependents
    .filter(d => {
      const items = d.projectItems;
      if (items?.pageInfo?.hasNextPage === true) return true;
      return (items?.nodes ?? []).some(
        (n: any) => n?.fieldValues?.pageInfo?.hasNextPage === true,
      );
    })
    .map(d => d.number);
}

/**
 * May the identity that triggered this run cause a board write?
 *
 * The first version of this gate was an Actions `if:` reading
 * `github.event.issue.author_association`, and review was right that it
 * checks the wrong person: that field describes whoever OPENED the issue,
 * never whoever closed it. The two differ in both directions and the
 * ordinary direction is the damaging one — a maintainer closing an outside
 * contributor's issue would have been refused, so the feature would have
 * quietly not worked for exactly the issues most likely to come from
 * outside.
 *
 * `repos/{repo}/collaborators/{actor}/permission` answers about the ACTOR.
 * Its `permission` field is one of `admin`, `write`, `read`, `none`, and an
 * unreadable response is `null` — which is UNMEASURED and refuses, because
 * a permission we could not read is not a permission we were granted.
 *
 * ## And the endpoint cannot answer about the owner
 *
 * `GITHUB_TOKEN` cannot read `collaborators/{actor}/permission` — it needs
 * admin access — so on a run triggered by the repository owner the read comes
 * back unreadable and `null` refuses the person who owns the board. Run
 * `42080290624` is the record: the first execution of this lane that got as
 * far as the decider, refusing `hornjason` on `hornjason/rungate`.
 *
 * The owner is trusted by identity rather than by a permission read, because
 * the identity is a fact the run already holds and the permission is one it
 * cannot obtain. An EMPTY actor never satisfies it: absent-and-absent are the
 * same empty string, and `"" === ""` would hand a write to a run that
 * identified nobody (BR-45).
 */
export const WRITING_PERMISSIONS: readonly string[] = ["admin", "write", "maintain"];

export function actorMayWrite(
  permission: string | null,
  identity: { readonly actor: string; readonly owner: string },
): boolean {
  if (identity.actor !== "" && identity.actor === identity.owner) return true;
  if (permission === null) return false;
  return WRITING_PERMISSIONS.includes(permission);
}

/** The credential, or the reason there is no reading to report. */
export type CredentialReading =
  | { readonly kind: "present"; readonly token: string }
  | { readonly kind: "UNMEASURED"; readonly why: string };

/**
 * `GITHUB_TOKEN` cannot write ProjectsV2, so this needs a PAT or a GitHub
 * App. A run without one has not found nothing to move — it has not looked,
 * and those are different states (`.claude/rules/config-access.md`).
 *
 * Whitespace is absence. A secret that was declared and left empty produces
 * `""`, and treating that as a token turns the refusal into a 401 three calls
 * later, where it reads as GitHub's problem.
 */
export function readBoardCredential(env: Record<string, string | undefined>): CredentialReading {
  const raw = (env.BOARD_PROJECT_TOKEN ?? "").trim();
  if (raw === "") {
    return {
      kind: "UNMEASURED",
      why:
        "BOARD_PROJECT_TOKEN is not set. GITHUB_TOKEN cannot write ProjectsV2, " +
        "so this run could not read or move anything — it is UNMEASURED, not clean.",
    };
  }
  return { kind: "present", token: raw };
}
