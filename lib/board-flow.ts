/**
 * Which lane does a GitHub event mean?
 *
 * Covers SC-2690, SC-2691, SC-2692 (specs/BOARD-FLOW-SPEC.md).
 *
 * ## Why this is a module and not three `if`s in YAML
 *
 * `specs/BOARD-FLOW-SPEC.md` settled every lane's entry and exit as a named
 * GitHub event, on the rule that a condition no event can decide is a
 * condition a person applies by hand. This file is the whole of that
 * mapping, in one place, so there is **one decider per transition**.
 *
 * That is not tidiness. Two guards answering the same question about the
 * same input are behaviourally ONE guard: a mutation of either leaves the
 * other holding the case up, both read as covered, and nobody can see which
 * is dead. The board had exactly that — GitHub's built-in project
 * automations and our workflows both writing Status — and the walk-through
 * caught it as row 4 landing in `In progress` when it expected `In review`.
 *
 * **So two built-ins are switched off**, and the project settings page is
 * the only place that is visible. `.github/workflows/board-flow.yml` names
 * them; this file names them too, because a reader who finds only one of
 * the two statements has no way to know the other exists.
 *
 * ## Every lane here is an ISSUE's card
 *
 * Two of the events below are pull-request events, and they still move the
 * card of the ISSUE the pull request closes — which is what
 * `specs/BOARD-FLOW-SPEC.md`'s lane table says: In review's entry is "a
 * linked PR is not a draft", and the walk-through's row 4 expects issue B
 * in In review after a PR saying `Fixes #B`.
 *
 * The PULL REQUEST's own card is `board-intake.yml`'s, which moves it to In
 * review on `opened`/`ready_for_review`. Same lane name, different item, so
 * this is not a second decider — nothing here ever writes a PR's card and
 * nothing there ever writes an issue's.
 *
 * ## It decides, it does not write
 *
 * No network, no project id, no token. `scripts/board-flow.ts` performs the
 * write. A decider that also writes cannot be exercised without a board,
 * and a transition nobody can test offline is a transition that gets tested
 * in production — which is how six consecutive Ready-lane failures went
 * unnoticed.
 */

/** The board lanes, as `specs/BOARD-FLOW-SPEC.md` names them. */
export type Lane = "Backlog" | "Ready" | "In progress" | "In review" | "Done" | "Cancelled";

/**
 * Every event kind this decider answers for.
 *
 * Exported so a test can enumerate the decider's own domain rather than
 * restating it — a second hand-written list would drift, and the drift
 * would be invisible exactly when a new event was added.
 */
export const LANE_EVENTS = [
  "issue_assigned",
  "issue_closed",
  "issue_reopened",
  "pr_ready",
  "pr_closed_unmerged",
] as const;

export interface LaneEvent {
  readonly kind: (typeof LANE_EVENTS)[number];
  /**
   * GitHub's `state_reason`, for `issue_closed` only.
   *
   * Read as GraphQL spells it — `COMPLETED`, `NOT_PLANNED`, `DUPLICATE`.
   * The caller normalises; this compares exactly, because a loose
   * comparison on the field that separates "delivered" from "abandoned" is
   * the one place a near-match must not pass.
   */
  readonly stateReason?: string | null;
}

export interface LaneDecision {
  /** The lane to write, or `null` to write nothing and say why. */
  readonly lane: Lane | null;
  readonly why: string;
}

/**
 * The closure reasons that mean the work was abandoned rather than done.
 *
 * Both, because `specs/BOARD-FLOW-SPEC.md` defines Cancelled's entry as
 * "closed as `not_planned` or `duplicate`" and `lib/work-status.ts` already
 * maps both to ABANDONED. Counting only the first reads a cancellation as a
 * delivery.
 */
const ABANDONED = new Set(["NOT_PLANNED", "DUPLICATE"]);

/**
 * The lanes a pull-request event may not pull an issue out of.
 *
 * Done and Cancelled are terminal: the work either shipped or was decided
 * against, and in both cases the clock has stopped. `specs/BOARD-FLOW-SPEC.md`
 * puts the whole forecast on that — Done defines throughput, Cancelled
 * protects Little's Law's second assumption — so a card leaving either one
 * by accident is not a cosmetic error.
 */
const TERMINAL: readonly string[] = ["Done", "Cancelled"];

/**
 * May a PULL REQUEST event write this issue's card, given where it sits now?
 *
 * **Authorisation and the target set are answered by different parties**,
 * which is the confused deputy. `.github/workflows/board-flow.yml` gates on
 * the ACTOR: for `opened` and `ready_for_review` that is the pull request's
 * author, so an outside contributor is refused outright. For `closed` it is
 * whoever closed it — ordinarily a maintainer — while the closing references
 * naming which issues to move still come from the contributor's body.
 *
 * So a drive-by pull request saying `Fixes #N` would pull #N out of Done the
 * moment anybody with write access closed it. The refusal below is also
 * right on the merits: work that shipped did not become unshipped because
 * somebody else's branch was abandoned.
 *
 * ISSUE events are deliberately not subject to this. An issue reopening IS
 * the legitimate way out of Done, it is the spec's own rule, and the actor
 * who reopens is the actor the gate authorised.
 *
 * `null` — a card with no Status at all — is allowed through. It is not a
 * terminal lane, and refusing it would make an unset column unreachable.
 */
export function prEventMayWrite(currentLane: string | null): { allowed: boolean; why: string } {
  if (currentLane !== null && TERMINAL.includes(currentLane)) {
    return {
      allowed: false,
      why:
        `the card is in ${currentLane}, which is terminal. A pull request event may not move ` +
        `it out: the closing references that name this issue are authored by the pull ` +
        `request, while the permission check answered for whoever closed it. Reopen the ` +
        `issue if the work is genuinely not finished.`,
    };
  }
  return { allowed: true, why: `${currentLane ?? "(no status)"} is not a terminal lane` };
}

/**
 * Which identities must clear the permission check before this event writes?
 *
 * **Authorise the party that chose the targets, not only the one who fired.**
 * `prEventMayWrite` above removes the worst outcome of the confused deputy
 * and does not close it: a drive-by pull request saying `Fixes #N`, where #N
 * sits in Backlog, Ready, In progress or In review, still moves #N the moment
 * any maintainer closes that pull request. The lane is not terminal, the
 * guard passes it, and the card churns on a reference nobody with write
 * access wrote.
 *
 * So a pull request event authorises two identities: the actor who fired it,
 * and the author of the body the closing references came from. An issue event
 * authorises one, because an issue event carries no contributor-authored
 * target set — the issue IS the target — and demanding a second there would
 * refuse ordinary maintainer work.
 *
 * `null` is UNMEASURED: a pull request event whose author could not be read.
 * Falling back to the actor alone would be the silent default, turning an
 * author nobody could read into an author nobody checked.
 *
 * Duplicates are collapsed, so a maintainer closing their own pull request
 * is one permission call rather than two identical ones.
 */
export function identitiesToAuthorise(
  kind: LaneEvent["kind"],
  actor: string,
  prAuthor: string | null,
): string[] | null {
  if (kind.startsWith("issue_")) return [actor];
  if (prAuthor === null || prAuthor === "") return null;
  return actor === prAuthor ? [actor] : [actor, prAuthor];
}

export function laneFor(e: LaneEvent): LaneDecision {
  switch (e.kind) {
    case "issue_assigned":
      // Assignment, and only because `.claude/rules/parallel-sessions.md`
      // already requires a worker to claim an issue by assigning themselves
      // BEFORE writing code. Industry is consistent that assignment is not
      // a start signal; what differs here is that ours is the first
      // physical act rather than a statement of future ownership. If that
      // rule is ever relaxed, this case has to change with it.
      return { lane: "In progress", why: "assignment is this repository's declared starting act" };

    case "pr_ready":
      // The LINKED ISSUE's card, not the pull request's — see the header.
      // The caller filters drafts out, so reaching here means a pull
      // request that is genuinely waiting on a reviewer. In review has to
      // mean that or it cannot measure the constraint it exists to measure.
      return { lane: "In review", why: "a non-draft pull request is finished work waiting on a reviewer" };

    case "issue_reopened":
    case "pr_closed_unmerged":
      // **One rule for everything that goes backwards.** An item that went
      // backwards has a blocker graph nobody has re-checked, and Ready's
      // entry condition is precisely a claim about that graph — so going
      // straight back to Ready would assert something nobody verified.
      // Backlog is not a penalty: `board-ready.yml` re-tests eligibility
      // and re-promotes on its own.
      return {
        lane: "Backlog",
        why: "work moving backwards has an unverified blocker graph, so eligibility is re-checked",
      };

    case "issue_closed": {
      const reason = e.stateReason;
      if (reason === "COMPLETED") return { lane: "Done", why: "closed as completed" };
      if (typeof reason === "string" && ABANDONED.has(reason)) {
        return { lane: "Cancelled", why: `closed as ${reason.toLowerCase()}` };
      }
      // **A reason this file does not know is not a completed close.**
      // Absent, misspelled, or a value GitHub adds after this was written —
      // all three are unknown, and writing Done for an unknown outcome
      // overstates throughput and contaminates every cycle-time percentile,
      // silently, because a card in Done looks like a card in Done. The
      // refusal names the value so the run is actionable rather than quiet.
      return {
        lane: null,
        why:
          `state_reason ${JSON.stringify(reason)} is not one this decider knows, so the ` +
          `outcome is UNKNOWN rather than completed and nothing is written`,
      };
    }

    default:
      // An event kind nobody added a case for. Refusing names it; falling
      // through to a default lane would move a card on a rule that does not
      // exist.
      return {
        lane: null,
        why: `no rule for event kind ${JSON.stringify((e as LaneEvent).kind)}`,
      };
  }
}
