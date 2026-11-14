/**
 * Is each board lane holding what it is supposed to hold?
 *
 * Covers SC-2670 (specs/BOARD-FLOW-SPEC.md).
 *
 * ## Why a count alone is not a reading
 *
 * `scripts/work-status.ts` can already say how many items sit in each lane.
 * That number is worthless on its own: Ready holding 6 is excellent if 6 is
 * everything that could be ready, and total failure if 34 things could be.
 * **A lane is healthy or not only against what SHOULD be in it**, so every
 * row here carries its denominator or admits it has none.
 *
 * The three comparisons come from the spec's own outcomes table and are not
 * invented here:
 *
 * | Lane | Against | Because |
 * |---|---|---|
 * | Ready | unblocked and unclaimed issues, **capped** at a depth derived from live throughput | Ready is Anderson's replenishment COMMITMENT POINT, so a Ready far below what it is allowed to hold means the ordering decision has relocated into each puller's private Backlog heuristic, leaving no reviewable record. It is capped because the commitment point is a queue, not a mirror of the backlog: comparing the lane against every eligible issue made a correctly-sized Ready read `SHORT by 30` on 2026-11-05 and would have forever |
 * | In progress | open AND assigned issues | somebody is working it; a lane that does not say so makes active work invisible and makes cycle time ABSENT rather than approximate |
 * | Cancelled | issues closed as `not_planned` | work that left without being done. Off the board entirely is worse than merged into Done: the cancellation rate becomes unobservable and Little's Law's second assumption breaks, so every forecast is unsound rather than merely imprecise |
 *
 * Backlog, In review and Done get no denominator, and say so rather than
 * reading OK. Backlog is a DISPLAY — five of the six lanes are mechanisms
 * and it is the exception — and the other two have no cheap second source to
 * compare against. **An unmeasured lane must not spell the same as a healthy
 * one**, which is the defect this whole area keeps producing. In review does
 * have one cheap reading that is not a denominator: `handPlacedInReview`
 * names the issue cards no open pull request accounts for (SC-2759).
 */

import { READY_TOLERANCE_DAYS, readyCap, readyTarget, type Throughput } from "./board-ready-rule";

/**
 * Is anybody actually working this issue? #1941.
 *
 * ## The assignee is a self-declaration and nothing asks it for evidence
 *
 * Measured 2026-11-09: six issues were assigned to `hornjason` and NONE had
 * an open pull request. Five had no pushed branch at all. The one with real
 * work, #1931, had it as commit `3bd05a14` sitting unpushed in a local
 * worktree — invisible to every GitHub reading there is.
 *
 * So the board was reporting six in progress, one of which was happening,
 * and the one that WAS happening was the one GitHub could see least about.
 *
 * ## Four readings, because `null` is a reading
 *
 * Each field is `true`, `false`, or `null` for **not read**, and the
 * distinction is the whole point — `.claude/rules/config-access.md`, Silent
 * Default Substitution. `PARKED` is the verdict that releases somebody's
 * claim, so it is the one that must not be reachable from an absence: a
 * caller that never looked for local commits and a caller that looked and
 * found none are different facts, and only the second may release.
 *
 * `scripts/board-status-sweep.ts` runs in GitHub Actions, on a machine that
 * has never seen the worktree where #1931's commit lives. It therefore
 * **cannot** reach `PARKED` and must not pretend to. That is not a defect in
 * this function; it is the finding, made legible.
 */
export type WorkVerdict =
  /** A pushed branch or an open pull request. The board can see it. */
  | "WORKING"
  /** Commits on this machine and nowhere else — real work, board-invisible. */
  | "INVISIBLE"
  /** An assignee and nothing else: a claim nobody can falsify. */
  | "PARKED"
  /** At least one reading was not taken, so no verdict is honest. */
  | "UNMEASURED";

/** What a run was able to observe. `null` is *not read*, never *no*. */
export interface WorkEvidence {
  /** An open pull request declaring it closes this issue. */
  readonly openPullRequest: boolean | null;
  /** A branch on `origin` carrying commits for it. */
  readonly pushedBranch: boolean | null;
  /** Commits on this machine that are on no pushed ref. */
  readonly localCommits: boolean | null;
}

/**
 * The ONE decider, read by the lane-health row and by the stale sweep.
 *
 * Two deciders answering this question would be behaviourally one guard and
 * no behavioural test could tell them apart
 * (`.claude/rules/checks-must-be-able-to-fail.md`). There is one, and
 * `test/board-lane-health.test.ts` asserts the callers reach it.
 *
 * **Order matters and is not arbitrary.** Visible work wins over invisible
 * work, because a pushed branch is the stronger claim and the cheaper one to
 * verify. Invisible work wins over every absence, because releasing a claim
 * backed by real commits is the expensive mistake and leaving a dead claim
 * one more day is the cheap one.
 */
export function workVerdict(e: WorkEvidence): { verdict: WorkVerdict; why: string } {
  if (e.openPullRequest === true) {
    return { verdict: "WORKING", why: "an open pull request declares it closes this" };
  }
  if (e.pushedBranch === true) {
    return { verdict: "WORKING", why: "a branch with commits is pushed to origin" };
  }
  if (e.localCommits === true) {
    return {
      verdict: "INVISIBLE",
      why:
        "commits exist on this machine and on no pushed ref — real work the board cannot " +
        "see. Push the branch and open a draft pull request",
    };
  }
  // Every positive reading has been tried. Only now does an absence mean
  // anything, and only if every absence was actually LOOKED FOR.
  const unread = (
    [
      ["an open pull request", e.openPullRequest],
      ["a pushed branch", e.pushedBranch],
      ["local commits", e.localCommits],
    ] as const
  )
    .filter(([, v]) => v === null)
    .map(([name]) => name);
  if (unread.length > 0) {
    // "a, b and c" rather than "a and b and c". The list is read by a human
    // deciding whether to trust a release, so it is written for one.
    const named =
      unread.length <= 1
        ? unread.join("")
        : `${unread.slice(0, -1).join(", ")} and ${unread[unread.length - 1]}`;
    return {
      verdict: "UNMEASURED",
      why:
        `UNMEASURED — ${named} ${unread.length === 1 ? "was" : "were"} not read, ` +
        `so this is PARKED or INVISIBLE and nothing here can tell them apart. A claim is ` +
        `not released on a reading nobody took`,
    };
  }
  return {
    verdict: "PARKED",
    why: "an assignee and nothing else — no pull request, no pushed branch, no local commits",
  };
}

/** Every lane name the board uses, in flow order. */
export const LANES: readonly string[] = [
  "Backlog",
  "Ready",
  "In progress",
  "In review",
  "Done",
  "Cancelled",
];

export type LaneHealth =
  /** Holding what it should, measured against a denominator. */
  | "OK"
  /** Has a writer and a denominator, and is below it. */
  | "SHORT"
  /**
   * Above its denominator.
   *
   * Only reachable since Ready gained a cap, and it appeared on the first
   * live run: the lane held 5 against a derived depth of 4, filled under
   * the uncapped rule. Before the cap, `count > against` could not happen
   * for any lane with a repo-wide denominator, so OK absorbed it.
   *
   * It is a verdict of its own for the reason SHORT and UNWRITTEN are:
   * **the remedy is different.** SHORT means promote more, OVER means stop
   * promoting and let the queue drain. Reporting an over-full commitment
   * point as OK is the lane lying in the other direction, which is exactly
   * what the negative control in the walk-through exists to catch.
   */
  | "OVER"
  /**
   * Empty while its denominator is not.
   *
   * **It does not mean "nothing writes this lane", and it used to say so.**
   * That sentence named a mechanism the census never looked at, and it was
   * false from 2026-11-05: `lib/board-flow.ts` moves an issue to Cancelled
   * on a `not_planned` close, with a recorded run, while this row still
   * reported the lane unwritten. An empty lane has at least two causes —
   * no writer, or a writer whose population the denominator does not
   * share — and only the second was true (SC-2731).
   */
  | "UNWRITTEN"
  /** No denominator exists, so the count is reported and nothing is judged. */
  | "NO_TARGET"
  /** The census could not be taken. Never the same as OK. */
  | "UNMEASURED";

export interface LaneCensus {
  /** Lane name to the number of items the board shows in it. */
  readonly counts: ReadonlyMap<string, number>;
  /**
   * Open issues that are unblocked and unclaimed **on this board**.
   *
   * Board-scoped like the others. Today the cap hides the difference —
   * `readyTarget` takes the smaller of this and the depth, and this is far
   * the larger — but a board holding fewer pickable issues than the cap
   * would read SHORT against work that does not exist.
   */
  readonly pickable: number;
  /**
   * Open issues with at least one assignee **that are on this board**.
   *
   * Scoped for the same reason `cancelledClosed` is: the numerator counts
   * board items, so a denominator counting repository issues reports a gap
   * no writer could close. Read repo-wide it said `In progress 1 of 10`
   * while the board held far fewer assigned issues than the repository did
   * (SC-2730).
   */
  readonly openAssigned: number;
  /**
   * Issues **on this board** closed as `NOT_PLANNED` or `DUPLICATE`, or
   * `null` when the count could not be taken.
   *
   * ## On this board, because the numerator is
   *
   * It used to be the repository-wide count, and that made the row compare
   * a board lane against a population the board's writer never sees. On
   * 2026-11-05 it read `Cancelled 0 of 23 UNWRITTEN`, and all 23 were
   * issues closed before `lib/board-flow.ts` had a Cancelled branch or
   * never added to the board at all. A denominator that counts things the
   * numerator cannot contain reports a gap that no writer could close
   * (SC-2730).
   *
   * **Both reasons, because the spec's condition is both.**
   * `specs/BOARD-FLOW-SPEC.md` defines Cancelled's entry as "closed as
   * `not_planned` or `duplicate`" and `lib/work-status.ts` already maps both
   * to ABANDONED. Counting only the first turns a lane that is SHORT by
   * however many duplicates exist into one that reads OK — ai-review round 1,
   * finding 1.
   *
   * **`null` rather than `0`**, because they are opposite facts wearing the
   * same digit: zero cancellations makes Cancelled correct, and a read that
   * failed makes it unknown. Collapsing them produces a green lane out of a
   * measurement that never happened — security review of the pushed commit,
   * finding 1.
   */
  readonly cancelledClosed: number | null;
  /**
   * How much the repository delivered, over how long — or `null` when that
   * could not be read.
   *
   * Ready's denominator is **capped**, and the cap is derived from this
   * rather than typed in (`lib/board-ready-rule.ts`). Before 2026-11-05 the
   * row compared the lane against every pickable issue in the repository
   * with no bound at all, which is how it came to report `SHORT by 30`
   * against a writer that could never promote more than 3.
   *
   * It is a required field rather than an optional one so that every caller
   * has to say what it measured. `null` makes the row UNMEASURED; there is
   * no fallback depth, because a built-in default substituted for a failed
   * read is indistinguishable from a real one.
   */
  readonly throughput: Throughput | null;
  /**
   * False when the board could not be paged in full.
   *
   * A partial page and an empty lane produce the same count, and that
   * ambiguity is the whole subject here — so an incomplete census refuses
   * every row rather than reporting the numbers it happens to hold.
   */
  readonly complete: boolean;
}

export interface LaneReading {
  readonly lane: string;
  readonly count: number;
  /** What the lane should hold. `null` when nothing cheap can say. */
  readonly against: number | null;
  readonly health: LaneHealth;
  readonly why: string;
}

/**
 * The denominator for each lane that has one, and why it is that one.
 *
 * ## The denominators are board-scoped, reversing an earlier decision
 *
 * They were repo-wide, deliberately: the security review of the pushed
 * commit (finding 3) argued that scoping them to board items would hide a
 * more important failure — an eligible issue that never reached the board
 * at all — so the mismatch was declared rather than removed.
 *
 * **That traded a readable row for an unreadable one, and the cost showed
 * up on 2026-11-05.** The Cancelled row read `0 of 23 UNWRITTEN — nothing
 * writes it`, which says the writer is broken. The writer was fine; all 23
 * were issues the board had never held. A row whose two numbers describe
 * different populations cannot be read correctly by anyone, and declaring
 * the mismatch in a label does not fix that — the label said "repo-wide"
 * the whole time and the row was still misread, by me, for a day.
 *
 * The earlier concern was right about the failure being important and
 * wrong about where it belongs: **it is a fact about board MEMBERSHIP, not
 * about any lane.** It is now its own reading — `offBoard` — so both
 * survive and neither is inferred from the other. One row, one population.
 *
 * `undefined` means this lane has no denominator; `null` inside one means
 * the denominator exists but could not be read.
 */
function target(lane: string, c: LaneCensus): { against: number | null; label: string } | undefined {
  if (lane === "Ready") {
    // **The cap is half the denominator, and it is why this row stopped
    // lying.** Ready is a commitment point, not a mirror of the backlog, so
    // what it SHOULD hold is the smaller of "everything eligible" and "the
    // depth the queue is allowed". Comparing against the eligible set alone
    // made a correctly-sized lane read SHORT forever.
    const cap = c.throughput === null ? null : readyCap(c.throughput);
    return {
      against: readyTarget(c.pickable, cap),
      label:
        cap === null
          ? "throughput, which Ready's depth is derived from,"
          : `allowed in the queue — ${c.pickable} unblocked and unclaimed on this board, capped at a ` +
            `depth of ${cap} derived from ${READY_TOLERANCE_DAYS} day(s) of live throughput`,
    };
  }
  if (lane === "In progress") {
    return { against: c.openAssigned, label: "on this board are open and assigned" };
  }
  if (lane === "Cancelled") {
    return {
      against: c.cancelledClosed,
      label: "on this board are closed as not_planned or duplicate",
    };
  }
  return undefined;
}

/**
 * One reading per lane, in flow order.
 *
 * A lane the board never mentioned reads `0`, which is correct: the board
 * showing no items in a lane and the board having no such lane are the same
 * fact from the outside, and both mean nothing is in it.
 */
export function laneHealth(c: LaneCensus): LaneReading[] {
  // **Every key the census holds gets a row, and nothing is excluded by
  // spelling.** Mapping over LANES alone meant a lane the board has and this
  // file does not know about contributed items to no row at all, so the
  // report stayed confident and complete-looking while part of the board was
  // simply absent from it. Adding a lane on the board is two clicks and
  // nobody would think to mirror it here. Security review of the pushed
  // commit, finding 4.
  //
  // The first fix for that swept unknown keys up but skipped any beginning
  // `"("`, which put the caller's own `"(no status)"` marker straight back
  // into the hole it had just closed — the SAME omission, one line below the
  // sweep written to stop it. Found independently by ai-review round 1 and
  // by the security review of the pushed commit. A prefix exclusion is also
  // forgeable: a lane somebody genuinely names `"(parked)"` on the board
  // would be suppressed by impersonating a marker. So there is no exclusion
  // left — a key that is not a known lane is reported, whatever it says.
  const unknown = [...c.counts.keys()].filter(k => !LANES.includes(k)).sort();
  const known = LANES.map(lane => {
    const count = c.counts.get(lane) ?? 0;
    if (!c.complete) {
      return {
        lane,
        count,
        against: null,
        health: "UNMEASURED" as const,
        why: "the board could not be paged in full, so this count is a floor and not a reading",
      };
    }
    const t = target(lane, c);
    if (t === undefined) {
      return {
        lane,
        count,
        against: null,
        health: "NO_TARGET" as const,
        why: "no second source says what should be here, so the count is reported and nothing is judged",
      };
    }
    // The denominator exists but could not be read. A failed search is not
    // a repository with nothing in it.
    if (t.against === null) {
      return {
        lane,
        count,
        against: null,
        health: "UNMEASURED" as const,
        why: `the ${t.label} count could not be read, so this lane has no denominator to judge against`,
      };
    }
    if (count === 0 && t.against > 0) {
      return {
        lane,
        count,
        against: t.against,
        health: "UNWRITTEN" as const,
        // States what was counted, not why. A census over two numbers
        // cannot see whether a writer exists, and the previous wording
        // asserted it did not.
        why:
          `${t.against} ${t.label}, and this lane is empty — either nothing moves them ` +
          `or whatever does has not run`,
      };
    }
    if (count < t.against) {
      return {
        lane,
        count,
        against: t.against,
        health: "SHORT" as const,
        why: `${t.against} ${t.label}, so up to ${t.against - count} are missing from this lane`,
      };
    }
    if (count > t.against) {
      return {
        lane,
        count,
        against: t.against,
        health: "OVER" as const,
        why: `${t.against} ${t.label}, and the lane holds ${count} — ${count - t.against} too many`,
      };
    }
    return {
      lane,
      count,
      against: t.against,
      health: "OK" as const,
      why: `${t.against} ${t.label}, and the lane holds ${count}`,
    };
  });
  return [
    ...known,
    ...unknown.map(lane => ({
      lane,
      count: c.counts.get(lane) ?? 0,
      against: null,
      health: "UNMEASURED" as const,
      // **One sentence for every unknown key, whatever it is spelled.** A
      // first pass branched this on `startsWith("(")` to word the caller's
      // own `"(no status)"` marker differently. No row was suppressed by
      // it, so it was misleading text rather than a drop — but a board lane
      // genuinely named `"(parked)"` would have been told its items are in
      // no lane, which is false, and the commit that removed the exclusion
      // claimed nothing was classified by spelling. Carrying that
      // distinction honestly means typed census fields, which is a change
      // to the caller and not to this decider. Round 2 security review.
      why: `this report does not know the lane "${lane}", so its items are unaccounted for above`,
    })),
  ];
}

/**
 * What `handPlacedInReview` reads. #1921, SC-2759.
 */
export interface InReviewCensus {
  /** Open issues whose card's Status is In review. */
  readonly inReview: readonly number[];
  /**
   * Issues on this repository that an OPEN pull request declares it closes,
   * through `closingIssuesReferences` — declares, not mentions. Drafts count:
   * a ready pull request converted back to draft leaves its issue in In
   * review with no event to move it, so that card was not placed by hand.
   */
  readonly declaredClosing: ReadonlySet<number>;
  /** Open pull requests whose closing list did not fit one page. */
  readonly closingTruncated: readonly number[];
  /** False when the board could not be paged in full. */
  readonly complete: boolean;
}

export type HandPlacedReading =
  | { readonly kind: "read"; readonly issues: readonly number[] }
  | { readonly kind: "unmeasured"; readonly why: string };

/**
 * Issue cards in In review that no open pull request declares it closes.
 * #1921, SC-2759.
 *
 * In review's entry condition in `specs/BOARD-FLOW-SPEC.md` is a ready pull
 * request, and `lib/board-flow.ts` resolves `pr_ready`'s target through the
 * pull request's closing references. Measured on #1921: no writer in this
 * repository puts an issue card in In review without one, and with none, no
 * event will ever move it out — the lane's exits resolve through the same
 * declaration. So the card was placed by hand, or its pull request stopped
 * declaring it after it entered; either way only a person can move it.
 *
 * **A second source for a lane the header above gives none**, without being
 * a denominator: the In review row stays NO_TARGET and this names cards.
 * #1717 sat there a week with no link ever on its timeline, and the only
 * visible symptom was In progress reading SHORT — blaming the wrong lane.
 *
 * UNMEASURED, never an empty list, when either input is partial: a board
 * read in part may be missing the card, and a cut closing list reads the
 * issue it would have declared as having none.
 */
export function handPlacedInReview(c: InReviewCensus): HandPlacedReading {
  if (!c.complete) {
    return {
      kind: "unmeasured",
      why: "the board could not be paged in full, so a card in In review may be missing from it",
    };
  }
  if (c.closingTruncated.length > 0) {
    const cut = [...c.closingTruncated].sort((a, b) => a - b).map(n => `#${n}`).join(", ");
    return {
      kind: "unmeasured",
      why: `the closing list of ${cut} did not fit one page, so an issue it declares would read as having no pull request`,
    };
  }
  const issues = [...new Set(c.inReview)].filter(n => !c.declaredClosing.has(n)).sort((a, b) => a - b);
  return { kind: "read", issues };
}

/** The line the report prints for `handPlacedInReview`, one per state. */
export function handPlacedInReviewLine(r: HandPlacedReading): string {
  if (r.kind === "unmeasured") return `  (hand-placed In review cards UNMEASURED — ${r.why})`;
  if (r.issues.length === 0) {
    return `  every issue card in In review has an open pull request declaring it closes the issue`;
  }
  return (
    `  ${r.issues.length} issue card(s) in In review are hand-placed — no open pull request declares it ` +
    `closes them, nothing in this repository writes In review without one, and no event will move them ` +
    `out: ${r.issues.map(n => `#${n}`).join(", ")}`
  );
}

/**
 * The lines the report prints.
 *
 * Separated from the caller so the report itself can be asserted. A lane
 * missing from the printed output is the failure this exists to catch, and
 * it is invisible when the formatting lives inside the I/O.
 */
/**
 * `offBoard` is **a required parameter and not a census field**, because it
 * was briefly both.
 *
 * It was declared on `LaneCensus`, documented at length, and never read —
 * the printed line came from this parameter, and the two agreed only
 * because one caller passed the same variable to each. A caller using the
 * one-argument form, which the optional default allowed, would have
 * printed `UNMEASURED` with the correct value sitting on the census it had
 * just built. A field with no reader and a default that invents a reading,
 * in the change written to remove exactly that. ai-review round 2 of
 * #1802.
 *
 * Required, so there is no form of this call that can omit the reading;
 * `null` has to be passed deliberately and still means UNMEASURED.
 */
export function laneHealthLines(
  readings: readonly LaneReading[],
  offBoard: number | null,
): string[] {
  const lines = readings.map(r => {
    const against = r.against === null ? "" : ` of ${r.against}`;
    return `  ${r.lane.padEnd(12)} ${String(r.count).padStart(4)}${against.padEnd(8)} ${r.health.padEnd(11)} ${r.why}`;
  });
  // **Printed whatever it reads, including zero.** Omitting the line when
  // nothing is off the board makes "none are missing" and "nobody looked"
  // the same output, which is the distinction every other row here exists
  // to keep (SC-2730). `null` is the third state and says so.
  lines.push(
    offBoard === null
      ? `  (board membership UNMEASURED — whether any open issue is missing from the board was not read)`
      : offBoard === 0
        ? `  every open issue is on the board`
        : `  ${offBoard} open issue(s) are NOT on the board at all — no lane writer can move them, ` +
          `and no row above counts them`,
  );
  return lines;
}
