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
 * phase-frontier rule that stopped the Ready lane holding 36 of 46 open
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
   * OPEN blockers only — the lifetime count never goes back down.
   *
   * **`null` means the dependency summary could not be read**, which is not
   * the same as zero. `issueDependenciesSummary` is absent on a response the
   * token was not scoped for, and `?? 0` turned that into "nothing is
   * blocking it" — a fail-open that moves a genuinely blocked issue to
   * Ready. Caught in review of #1747.
   */
  readonly blockedByOpen: number | null;
  readonly assignees: number;
  /** The board column, or `null` when the issue is not on the board at all. */
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
 */
function whyNotReady(d: Dependent, frontier: number | null): string {
  if (d.state !== "OPEN") return `the issue is ${d.state}`;
  if (d.blockedByOpen === null) return "UNMEASURED — the dependency summary could not be read";
  if (d.blockedByOpen > 0) {
    return `${d.blockedByOpen} open blocker${d.blockedByOpen === 1 ? "" : "s"} remain`;
  }
  if (d.assignees > 0) return "somebody has claimed it";
  if (frontier === null) return "no phase has open work, so nothing is next";
  if (d.phase === null) return "no phase milestone — it serves no criterion (ADR-003)";
  if (d.phase !== frontier) return `phase ${d.phase} is behind the frontier at phase ${frontier}`;
  return "isReady said no and this reason list did not anticipate it";
}

/**
 * One decision per dependent. Writes nothing; the caller performs the moves.
 */
export function fanoutDecisions(
  dependents: readonly Dependent[],
  frontier: number | null,
  readyColumn: string,
): FanoutDecision[] {
  return dependents.map((d): FanoutDecision => {
    if (d.boardStatus === null) {
      return { number: d.number, move: false, why: "not on the board — board-mirror owns membership" };
    }
    if (d.boardStatus === readyColumn) {
      return { number: d.number, move: false, why: `already ${readyColumn}` };
    }
    // An unreadable blocker count is UNMEASURED, and UNMEASURED never moves.
    // It cannot be handed to `isReady`, whose parameter is a number and whose
    // honest answer here does not exist — the question is unanswerable, not
    // answered false. Refusing before the decider is what keeps `isReady` the
    // only thing that says yes.
    if (d.blockedByOpen === null) {
      return { number: d.number, move: false, why: whyNotReady(d, frontier) };
    }
    const measured = { ...d, blockedByOpen: d.blockedByOpen };
    if (!isReady(measured, frontier)) {
      return { number: d.number, move: false, why: whyNotReady(d, frontier) };
    }
    return { number: d.number, move: true };
  });
}

/** The credential, or the reason there is no reading to report. */
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
 */
export const WRITING_PERMISSIONS: readonly string[] = ["admin", "write", "maintain"];

export function actorMayWrite(permission: string | null): boolean {
  if (permission === null) return false;
  return WRITING_PERMISSIONS.includes(permission);
}

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
