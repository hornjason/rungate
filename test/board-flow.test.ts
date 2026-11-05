/**
 * Covers SC-2690, SC-2691, SC-2692 (specs/BOARD-FLOW-SPEC.md).
 *
 * The decider only. It takes a GitHub event and returns the lane that event
 * means, and that is deliberately all it does — the GraphQL that performs
 * the write lives in `scripts/board-flow.ts` and is not a decision.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { LANE_EVENTS, laneFor, type LaneEvent } from "../lib/board-flow";

const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf-8");

describe("one decider owns every lane transition", () => {
  // ## SC-2690 — the mapping, stated as cases rather than as a table
  //
  // Each row is a transition BOARD-FLOW-SPEC.md's lane table declares, and
  // the spec is the reason each is what it is. They are listed out rather
  // than looped over a fixture, because a loop over the decider's own
  // mapping would assert that the code equals itself.
  test("SC-2690: assignment starts work", () => {
    expect(laneFor({ kind: "issue_assigned" }).lane).toBe("In progress");
  });

  test("SC-2690: a non-draft pull request means review, a draft does not reach the decider", () => {
    expect(laneFor({ kind: "pr_ready" }).lane).toBe("In review");
  });

  test("SC-2690: a completed close is Done and an abandoned one is Cancelled", () => {
    expect(laneFor({ kind: "issue_closed", stateReason: "COMPLETED" }).lane).toBe("Done");
    expect(laneFor({ kind: "issue_closed", stateReason: "NOT_PLANNED" }).lane).toBe("Cancelled");
    expect(
      laneFor({ kind: "issue_closed", stateReason: "DUPLICATE" }).lane,
      "the spec's Cancelled condition is `not_planned` OR `duplicate`, and lib/work-status.ts " +
        "already maps both to ABANDONED. Half the condition reads a cancellation as delivery.",
    ).toBe("Cancelled");
  });

  // ## SC-2691 — the reason this is a decider and not three `if`s in YAML
  //
  // *Silent Default Substitution*, in the place it does the most damage. A
  // close whose `state_reason` is absent, misspelled, or a value GitHub adds
  // after this was written is NOT a completed close. Defaulting it to Done
  // overstates throughput and contaminates every cycle-time percentile —
  // which the spec names as the cost of Done being wrong — and it does so
  // silently, because a card in Done looks exactly like a card in Done.
  //
  // `null` here is a refusal: the caller writes nothing and says so.
  test("SC-2691: an unreadable close reason refuses rather than defaulting to Done", () => {
    for (const reason of [null, undefined, "", "ARCHIVED", "not_planned "]) {
      const r = laneFor({ kind: "issue_closed", stateReason: reason as string | null });
      expect(
        r.lane,
        `state_reason ${JSON.stringify(reason)} is not a reason this decider knows. Writing ` +
          `Done for it counts an unknown outcome as delivered, which is the one direction ` +
          `this must never be wrong in.`,
      ).toBeNull();
      expect(r.why).toContain("state_reason");
    }
  });

  test("SC-2691: a refusal still explains itself, so the run is not silent", () => {
    const r = laneFor({ kind: "issue_closed", stateReason: "ARCHIVED" });
    expect(r.lane).toBeNull();
    expect(
      r.why.length,
      "a refusal with no reason is indistinguishable from a transition nobody configured",
    ).toBeGreaterThan(20);
  });

  // ## SC-2692 — one rule, and the test that it IS one rule
  //
  // Jason, 2026-11-05: an item that went backwards has an unknown blocker
  // graph, and Ready's entry condition is a claim about that graph. Both
  // backwards events therefore land in Backlog, where the Ready writer
  // re-checks eligibility and re-promotes on its own.
  test("SC-2692: both backwards events return to Backlog, and to the same lane", () => {
    const reopened = laneFor({ kind: "issue_reopened" });
    const abandoned = laneFor({ kind: "pr_closed_unmerged" });
    expect(reopened.lane).toBe("Backlog");
    expect(
      abandoned.lane,
      "a PR closed unmerged and a reopened issue are the same situation — work whose " +
        "blocker graph nobody has re-checked. Two rules here is two places to get it wrong.",
    ).toBe(reopened.lane);
  });

  // ## Anti-vacuity: the mapping has to be able to disagree with itself
  //
  // Every assertion above would also hold if `laneFor` returned a constant
  // for everything except the refusals. This is the row that cannot.
  test("SC-2690: the decider distinguishes its events rather than returning one lane", () => {
    const lanes = new Set(
      LANE_EVENTS.map(kind => laneFor({ kind, stateReason: "COMPLETED" } as LaneEvent).lane),
    );
    expect(
      lanes.size,
      "a decider that answers the same lane for every event passes every case above that " +
        "happens to expect that lane. Name the number of distinct answers.",
    ).toBeGreaterThan(3);
  });

  test("SC-2690: an event the decider does not know refuses, rather than falling through", () => {
    const r = laneFor({ kind: "wat" as LaneEvent["kind"] });
    expect(r.lane).toBeNull();
    expect(r.why).toContain("wat");
  });

  // ## The workflow must actually route every event the decider handles
  //
  // A decider nothing calls is the shape that let `runVerdict`'s UNMEASURED
  // branch sit unreachable through a whole pull request. Worse here: a
  // trigger missing from the YAML means that lane silently never moves,
  // which is the exact defect this spec was opened about.
  test("SC-2690: the workflow subscribes to every event the decider decides", () => {
    const yml = read(".github/workflows/board-flow.yml");
    for (const t of ["assigned", "closed", "reopened", "ready_for_review"]) {
      expect(
        yml,
        `the decider answers for "${t}" and the workflow never hears about it, so that lane ` +
          `never moves and nothing reports a failure — a silent lane is this spec's subject.`,
      ).toContain(t);
    }
  });

  // GitHub's built-ins and this workflow must not both write a lane. Two
  // writers for one transition is "two deciders that agree": a mutation of
  // either leaves the other holding the case up, and no behavioural test
  // can tell which one is dead.
  test("SC-2690: the workflow records which built-ins had to be switched off", () => {
    const yml = read(".github/workflows/board-flow.yml");
    expect(
      yml,
      "this workflow only owns closed->Done once GitHub's `Item closed` built-in is off. " +
        "If that is not written down next to the code, the next person turns it back on " +
        "and two writers race for the same column.",
    ).toContain("Item closed");
  });
});
