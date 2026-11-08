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

/** One issue that the closed blocker was blocking. */
export interface Dependent {
  readonly number: number;
  /** `OPEN` or `CLOSED`, as GraphQL spells it. */
  readonly state: string;
  readonly phase: number | null;
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
  return "somebody has claimed it";
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
