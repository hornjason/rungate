/**
 * Covers SC-2710, SC-2711, SC-2712, SC-2715, SC-2716, SC-2719, SC-2723 (specs/BOARD-FLOW-SPEC.md).
 *
 * ## The mutation battery, predicted before it was run
 *
 * Both columns matter. A mutation of the shared rule has to redden the
 * WRITER's cases and the HEALTH READING's cases, because the defect this
 * module exists to remove was exactly two files holding two definitions with
 * no single site a mutation could move
 * (`.claude/rules/checks-must-be-able-to-fail.md`, *two deciders*).
 *
 *   mutant                                   this file      lane-health
 *   READY_TOLERANCE_DAYS 0.5 -> 1            3, predicted 3  3, predicted 3
 *   readyCap drops the `days <= 0` refusal   1, predicted 1  0, predicted 0
 *   readyCap drops the floor of 1            1, predicted 1  1, predicted 1
 *   readyTarget drops the Math.min           1, predicted 1  4, predicted 4
 *
 * **Mutant 4 read 3 against a prediction of 4 on the first pass, and the
 * missing row was a forgeable assertion rather than a bad prediction.** The
 * printed-line case matched `"of 8"`, which the LABEL also contains — "a
 * depth of 8" — so the row stayed green while the denominator it was
 * checking had become 34. Tightened to `"6 of 8"`, which only the count can
 * supply, and the mutant then read 4. Predicting the membership rather than
 * the total is what surfaced it.
 *
 * Readings are in the PR body and in `specs/BOARD-FLOW-SPEC.md`.
 *
 * Mutant 2 is the one that reddens only one column, and that is the honest
 * reading rather than a gap: a refusal inside `readyCap` is invisible to a
 * census whose fixtures all carry a readable window. The three that change
 * a NUMBER move both files, which is the property this module exists for.
 *
 * **Every number below is a literal, deliberately.** Asserting the writer
 * against `readyCap(...)` and the health row against `readyCap(...)` would
 * make both sides move together under a mutation and the battery would read
 * zero — `feedback-mutating-a-constant-moves-both-sides`. So the cap of 8 is
 * typed out in both files and the mutant has to break it in both.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { sourceFiles } from "../lib/source-census";
import { structuralCut } from "../lib/source-slice";
import { join } from "path";
import {
  LABEL_RANK,
  NO_WORK_NEXT,
  READY_TOLERANCE_DAYS,
  WORK_NEXT_LABEL,
  familyRank,
  heldReason,
  holdsReadySlot,
  placementCensus,
  placementOf,
  readyCap,
  readyOccupancy,
  readyOrderFor,
  readyTarget,
  selectReady,
  undispatchableRemedy,
  workNextReading,
  type Rankable,
} from "../lib/board-ready-rule";
// #1905's premise lives in another module, so it is imported and asserted
// rather than restated. A docblock claiming `laneFor` always returns
// `In progress` would be the reason nobody checks.
import { laneFor, type LaneEvent } from "../lib/board-flow";
// #1905's BOUND rests on this gate refusing some actors who can assign, so
// the list is imported and asserted rather than paraphrased.
import { WRITING_PERMISSIONS } from "../lib/board-ready-fanout";

/**
 * The milestone families this suite ranks against.
 *
 * **Deliberately not `"Pipeline"` and `"Convergence"`.** This repository
 * configures `board.milestonePrefix: "Pipeline"`, so a rule that spelled the
 * prefix itself would pass every row here if the fixture agreed with it. Two
 * names no tree uses mean the only way these rows go green is by reading the
 * prefix they are handed.
 */
const ENGINE = "Engine";
const PAYLOAD = "Payload";

/** A rankable in the ENGINE family unless another family is named. */
const item = (
  number: number,
  phase: number | null,
  labels: readonly string[] = [],
  family: string = ENGINE,
): Rankable => ({
  number,
  milestone: phase === null ? null : `${family} Phase ${phase}`,
  labels,
});

/** The live reading of 2026-11-05: 237 issues delivered over 14 days. */
const LIVE = { delivered: 237, days: 14 } as const;

/**
 * The old `selectReady(eligible, cap, occupied)` spelling, re-expressed
 * through the one occupancy reading (#1852).
 *
 * Every pre-#1852 case passed a lane whose cards were all dispatchable,
 * because that is all the writer could see. Keeping the shorthand keeps
 * those cases readable AND routes them through `readyOccupancy`, so a
 * mutation of the free-slot arithmetic reddens them too.
 */
const atDepth = (occupied: number, cap: number | null) => readyOccupancy(occupied, occupied, cap);

describe("#1905: the card this event is moving does not hold its slot", () => {
  // The race: `board-ready` counted the just-assigned card, read the lane
  // as full, and promoted nothing; `board-flow` moved that card to In
  // progress one second later and the lane was empty with nothing queued.
  //
  // What every row below holds fixed, said out loud: the card is OPEN, an
  // Issue, and sitting in Ready. The only thing that varies is whether it
  // is the one the event named. That is the bound — review of #1918 found
  // the first version excluding EVERY assigned issue, which is unbounded
  // when `board-flow`'s write fails.

  test("the racing pair: one card, one cap, FULL or ROOM on whether it is the mover", () => {
    const card = { typename: "Issue", state: "OPEN", number: 1668 };
    const occ = (moving?: number) => {
      const held = [card].filter(c => holdsReadySlot(c, moving)).length;
      return readyOccupancy(held, held, 1).verdict;
    };
    expect(occ(undefined), "no mover named").toBe("FULL");
    expect(occ(999), "a DIFFERENT issue is moving").toBe("FULL");
    expect(occ(1668), "this card is the one moving").toBe("ROOM");
  });

  test("CONTROL: exactly ONE card is excluded, never every assigned issue", () => {
    // The hole review found in the first spelling, as an assertion.
    // `laneFor` returning `In progress` is a decision, not a guarantee the
    // write landed: `scripts/board-flow.ts` refuses GitHub's Triage role,
    // and an expired token or a GraphQL error fail the same way. A card
    // whose move failed is OPEN, assigned and in Ready forever — so a
    // predicate keyed on "assigned" excluded it on every later run and the
    // writer promoted on top of it with nothing bounding the pile.
    //
    // Keyed on the event's number, a lane full of stalled cards still
    // reads full, and the one being moved is the one slot that frees.
    const stalled = [1, 2, 3].map(number => ({ typename: "Issue", state: "OPEN", number }));
    expect(stalled.filter(c => holdsReadySlot(c, 2)).length, "more than one card freed").toBe(2);
    expect(stalled.filter(c => holdsReadySlot(c, 99)).length, "a stalled lane must stay full").toBe(3);
  });

  test("CONTROL: an absent mover excludes NOTHING — not knowing is not freeing", () => {
    // The direction this is allowed to be wrong in. Every other mode
    // (`--top-up`, a close fan-out, the report) passes no mover, and none
    // of them may empty the lane as a side effect.
    const card = { typename: "Issue", state: "OPEN", number: 7 };
    expect(holdsReadySlot(card), "absent mover freed a slot").toBe(true);
  });

  test("CONTROL: BOTH sides absent still holds — the case neither guard alone can see", () => {
    // The dangerous input, and the only one the absence guard protects.
    // `undefined !== undefined` is FALSE, so a card whose number was never
    // selected, in a run that named no mover, would free its slot — and
    // that is every card on the board at once.
    //
    // It is one guard rather than two because two turned zero mutations
    // red: each absence check was held up by the other through the
    // comparison, so both read as covered and neither was.
    expect(holdsReadySlot({ typename: "Issue", state: "OPEN" }), "both absent").toBe(true);
    // Either one alone is handled by the comparison itself, and both are
    // asserted because they are the documented direction — not because a
    // mutation of the guard reddens them.
    expect(holdsReadySlot({ typename: "Issue", state: "OPEN" }, 7), "no number").toBe(true);
    expect(holdsReadySlot({ typename: "Issue", state: "OPEN", number: 7 }), "no mover").toBe(true);
  });

  test("CONTROL: a pull request and a draft hold their slots", () => {
    // `board-flow` relanes no pull request on an issue assignment, and a
    // slot is a slot whatever occupies it.
    expect(holdsReadySlot({ typename: "PullRequest", state: "OPEN", number: 7 }, 7)).toBe(true);
    expect(holdsReadySlot({}, 7)).toBe(true);
  });

  test("CONTROL: a CLOSED issue holds its slot — this is not a tidier", () => {
    // It should not be in Ready, and `undispatchableRemedy` is what says
    // so. Freeing its slot would promote on top of a lane nobody cleaned.
    expect(holdsReadySlot({ typename: "Issue", state: "CLOSED", number: 7 }, 7)).toBe(true);
  });

  test("the premise, and its LIMIT: board-flow decides In progress, which is not the write", () => {
    // Asserted rather than described. The decision is unconditional —
    // which is why the event's card is the right one to exclude — and the
    // decision is all it is. The write is gated separately, and the
    // exclusion is bounded to one card precisely because that gate can
    // refuse. Both halves, because the first alone is what justified the
    // unbounded version.
    expect(laneFor({ kind: "issue_assigned" } as LaneEvent).lane).toBe("In progress");
    expect(WRITING_PERMISSIONS, "Triage can assign an issue and cannot write the board").not.toContain(
      "triage",
    );
  });
});

describe("SC-2710: the cap is derived from live throughput, not typed in", () => {
  test("the 2026-11-05 reading of 237 over 14 days gives a depth of 8", () => {
    expect(
      readyCap(LIVE),
      "237/14 is 16.9 a day; half a day of cover is 8. This is the number Jason approved",
    ).toBe(8);
  });

  // The control for the case above. A `readyCap` that ignored its argument
  // and returned 8 would pass that test and fail this one, which is the
  // whole difference between a derived depth and a literal in a function.
  test("a different throughput gives a different depth", () => {
    expect(readyCap({ delivered: 20, days: 10 }), "2/day, half a day is 1").toBe(1);
    expect(readyCap({ delivered: 400, days: 10 }), "40/day, half a day is 20").toBe(20);
    expect(readyCap({ delivered: 1000, days: 14 })).toBe(35);
  });

  test("a repository that delivered nothing still lets the first item through", () => {
    expect(
      readyCap({ delivered: 0, days: 14 }),
      "a floor of 0 would mean Ready can never start, and the lane would be permanently empty",
    ).toBe(1);
  });

  test("the tolerance is half a day", () => {
    expect(READY_TOLERANCE_DAYS).toBe(0.5);
  });
});

describe("SC-2711: a window that cannot produce a rate is UNMEASURED, never zero", () => {
  test("a zero-length or negative window refuses", () => {
    expect(readyCap({ delivered: 237, days: 0 })).toBeNull();
    expect(readyCap({ delivered: 237, days: -1 })).toBeNull();
  });

  test("a non-finite or negative reading refuses", () => {
    expect(readyCap({ delivered: Number.NaN, days: 14 })).toBeNull();
    expect(readyCap({ delivered: 237, days: Number.NaN })).toBeNull();
    expect(readyCap({ delivered: -5, days: 14 })).toBeNull();
  });

  test("an unreadable cap leaves the lane with no denominator", () => {
    expect(readyTarget(34, null)).toBeNull();
  });
});

describe("SC-2712: the lane is judged against the capped target", () => {
  test("with more eligible work than depth, the target is the depth", () => {
    expect(readyTarget(34, 8)).toBe(8);
  });

  test("with less eligible work than depth, the target is the work", () => {
    expect(
      readyTarget(3, 8),
      "a lane holding every eligible item is healthy however far below its cap it sits",
    ).toBe(3);
  });
});

describe("SC-2715: phase orders the queue, and never empties it", () => {
  test("lower phase first, then older issue first", () => {
    const got = [item(50, 1), item(10, 1), item(99, 0), item(7, 2)].sort(readyOrderFor(ENGINE, NO_WORK_NEXT)).map(i => i.number);
    expect(got).toEqual([99, 10, 50, 7]);
  });

  // The decision of 2026-11-05, as a case. Under the rule this replaces a
  // phase-less issue was not merely last, it was INELIGIBLE — and 22 of the
  // 35 pickable issues that day had no milestone at all.
  test("a phase-less issue sorts LAST, and is still in the queue", () => {
    const got = [item(3, null), item(9, 2), item(4, null), item(1, 0)].sort(readyOrderFor(ENGINE, NO_WORK_NEXT)).map(i => i.number);
    expect(
      got,
      "phase-less items come after every phased one and before nothing — ordering, not a gate",
    ).toEqual([1, 9, 3, 4]);
  });

  test("a queue of only phase-less issues is ordered by age, not discarded", () => {
    expect([item(8, null), item(2, null)].sort(readyOrderFor(ENGINE, NO_WORK_NEXT)).map(i => i.number)).toEqual([2, 8]);
  });
});

describe("SC-2716: the cap binds, and replenishes as slots free", () => {
  const twelve = Array.from({ length: 12 }, (_, i) => item(i + 1, 0));

  test("more eligible work than depth promotes exactly the depth, in order", () => {
    expect(selectReady(twelve, atDepth(0, 4), ENGINE, NO_WORK_NEXT).promote.map(i => i.number)).toEqual([1, 2, 3, 4]);
  });

  test("a full lane promotes nothing", () => {
    const r = selectReady(twelve, atDepth(4, 4), ENGINE, NO_WORK_NEXT);
    expect(r.promote).toEqual([]);
    expect(r.why).toContain("full");
  });

  test("a pull frees a slot and the next event refills exactly that many", () => {
    expect(selectReady(twelve, atDepth(2, 4), ENGINE, NO_WORK_NEXT).promote.map(i => i.number)).toEqual([1, 2]);
    expect(selectReady(twelve, atDepth(3, 4), ENGINE, NO_WORK_NEXT).promote.map(i => i.number)).toEqual([1]);
  });

  test("a lane over its depth promotes nothing rather than a negative count", () => {
    expect(selectReady(twelve, atDepth(11, 4), ENGINE, NO_WORK_NEXT).promote).toEqual([]);
  });

  test("less eligible work than depth promotes all of it", () => {
    expect(selectReady([item(5, 1), item(2, 0), item(9, null)], atDepth(0, 4), ENGINE, NO_WORK_NEXT).promote.map(i => i.number)).toEqual([
      2, 5, 9,
    ]);
  });

  // Promoting everything eligible on an unreadable cap is the 36-of-46
  // reading performed automatically, which is the failure the cap exists
  // to prevent.
  test("an unreadable cap promotes nothing and says UNMEASURED", () => {
    const r = selectReady(twelve, atDepth(0, null), ENGINE, NO_WORK_NEXT);
    expect(r.promote).toEqual([]);
    expect(r.why).toContain("UNMEASURED");
  });

  test("selection does not mutate its input", () => {
    const given = [item(3, 1), item(1, 0)];
    selectReady(given, atDepth(0, 4), ENGINE, NO_WORK_NEXT);
    expect(given.map(i => i.number), "sorting in place reorders the caller's decision record").toEqual([3, 1]);
  });

  // The binding between the two halves, as behaviour: what the health
  // reading demands and what the writer supplies are the same number.
  test("what the writer promotes into an empty lane equals the target the reading judges against", () => {
    for (const eligible of [0, 1, 3, 4, 12, 34]) {
      const items = Array.from({ length: eligible }, (_, i) => item(i + 1, 0));
      expect(
        selectReady(items, atDepth(0, 4), ENGINE, NO_WORK_NEXT).promote.length,
        `with ${eligible} eligible the reading and the writer must not disagree`,
      // Non-null because the cap is a literal 4 here; `readyTarget` only
      // returns null for an unreadable cap, which the case above covers.
      ).toBe(readyTarget(eligible, 4)!);
    }
  });
});

describe("SC-2719: a held issue is told WHY it was held", () => {
  // ai-review on #1793: every eligible issue was told "Ready is at its
  // depth", including on a run where the depth was never read — one line
  // below the run's own UNMEASURED warning.
  test("an unmeasured depth does not claim the lane is full", () => {
    expect(heldReason(atDepth(0, null))).toContain("could not be measured");
    expect(
      heldReason(atDepth(0, null)),
      "a reading that names the wrong cause sends the next person to the wrong place",
    ).not.toContain("at its depth");
  });

  test("a measured depth does say the lane is full", () => {
    expect(heldReason(atDepth(0, 4))).toContain("at its depth");
  });

  // Zero is a real cap, not a missing one, and the two must not collapse.
  test("a depth of zero is a full lane, not an unread one", () => {
    expect(heldReason(atDepth(0, 0))).toContain("at its depth");
  });
});

describe("SC-2723: nothing spells a held reason for itself", () => {
  const ROOT = join(import.meta.dir, "..");
  const codeOf = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  /**
   * **Three sites, one defect, and the third was written AFTER the fix
   * existed.** ai-review found the hardcoded "Ready is at its depth" in
   * `scripts/board-ready.ts` on #1794 — an unmeasured depth reported as
   * a full lane. `heldReason` was created, exported and merged. One pull
   * request later I typed the literal fresh into
   * `scripts/board-mirror.ts`, the sibling script, and ai-review found
   * it again.
   *
   * A case per script would have caught only the script that had one.
   * This is the population, so the next site fails the build instead of
   * waiting for a reviewer.
   */
  test("the held-reason string appears only in its own binding", () => {
    const offenders: string[] = [];
    const population = sourceFiles(ROOT, ["lib", "scripts"]);
    // The population is the point, so its reach is asserted beside it: a
    // flat listing silently drops the eighteen files under lib/generators,
    // lib/scaffold and lib/validators. ai-review round 4 of #1795.
    expect(
      population.filter(p => p.split("/").length > 2).length,
      "no nested file is in this population, so the census has gone flat",
    ).toBeGreaterThan(10);
    for (const path of population) {
      if (path === "lib/board-ready-rule.ts") continue;
      if (codeOf(readFileSync(join(ROOT, path), "utf-8")).includes("at its depth")) offenders.push(path);
    }
    expect(
      offenders,
      "spelling the reason inline reports an UNMEASURED depth as a full lane — the exact " +
        "finding ai-review raised on #1794 and again on #1795. Call heldReason(cap) instead",
    ).toEqual([]);
  });

  /**
   * #1965 round 3: every consumer of the ordering, not two of three.
   *
   * I fixed `work-status.ts` and `board-ready.ts` to route the engine prefix
   * through `enginePrefixReading`, which tells *this tree declares no engine
   * family* apart from *I could not find a config*, and left
   * `board-mirror.ts` reading `readBoardInputs(root).milestonePrefix`
   * directly — the one script that WRITES the Ready lane. ai-review caught it
   * as a blocking finding. A `null` prefix there promotes `Convergence Phase
   * 3` ahead of `Pipeline Phase 6` onto the board, in silence.
   *
   * A case per script would have caught only the script that had one. This is
   * the population, so the FOURTH site fails the build rather than waiting
   * for a reviewer — the same answer `heldReason` got above, for the same
   * reason it needed it.
   *
   * `board-snapshot.ts` reads `board.milestonePrefix` too and is NOT in this
   * population: it has its own `--prefix`, it does not call an ordering
   * function, and it already refuses outright when neither is set. The
   * population is *whoever orders*, not *whoever reads the key*.
   *
   * Breaking it: revert any one of the three to `readBoardInputs(...)` and
   * this names that file.
   */
  test("every script that ORDERS resolves the prefix through enginePrefixReading", () => {
    const ORDERERS = ["readyOrderFor", "selectReady", "splitReadyChanges", "placementCensus"];
    const population = sourceFiles(ROOT, ["scripts"]);
    expect(
      population.length,
      "the sweep read no scripts, so an empty offender list would witness nothing",
    ).toBeGreaterThan(10);

    const orderers: string[] = [];
    const offenders: string[] = [];
    for (const path of population) {
      const code = codeOf(readFileSync(join(ROOT, path), "utf-8"));
      if (!ORDERERS.some(fn => code.includes(`${fn}(`))) continue;
      orderers.push(path);
      if (!code.includes("enginePrefixReading(")) offenders.push(path);
    }

    // The population's own reach, asserted rather than assumed: a matcher
    // that found nothing would make the offender list empty for the wrong
    // reason, and all three of these are known to order.
    expect(
      orderers.sort(),
      "the scan did not find the scripts that order Ready — it is measuring nothing",
    ).toEqual(["scripts/board-mirror.ts", "scripts/board-ready.ts", "scripts/work-status.ts"]);

    expect(
      offenders,
      "reading `readBoardInputs(...).milestonePrefix` cannot tell a tree that declares no " +
        "engine family from a config it could not find, and both are `null` — which is the " +
        "pre-#1943 ordering, applied silently. Call enginePrefixReading() and print its " +
        "`unmeasured`",
    ).toEqual([]);
  });

  /**
   * #1965 round 4: `Rankable.milestone` has ONE absent value, and it is `null`.
   *
   * `scripts/board-mirror.ts` produced `n.content.milestone?.title ?? ""`
   * while the five other producers in the tree produce `?? null`, against a
   * contract that says *"the milestone TITLE, or `null`"*. It is harmless
   * today only because `phaseOf` and `phaseInFamily` both normalise with
   * `?? ""` internally — so a later `=== null` anywhere in the ordering would
   * misbehave for exactly one call site, and only for issues with no
   * milestone, which is the population the LABEL tier exists for.
   *
   * Two sentinels for one absence is the defect `enginePrefixReading` was
   * added to this same PR to remove for the engine prefix. This is the same
   * shape one layer down, and the review was right to name it rather than
   * accept "identical results today".
   *
   * A census and not a line, for the reason the ordering-site case above is
   * one: the SIXTH producer is the one nobody will check.
   *
   * Breaking it: change any `?? null` on a `milestone?.title` back to `?? ""`
   * and this names the file and the line.
   */
  test("every milestone-title producer spells absent as null, never an empty string", () => {
    const population = sourceFiles(ROOT, ["lib", "scripts"]);
    const producers: string[] = [];
    const offenders: string[] = [];
    for (const path of population) {
      const lines = codeOf(readFileSync(join(ROOT, path), "utf-8")).split("\n");
      lines.forEach((line, i) => {
        if (!/milestone\?\.title\s*\?\?/.test(line)) return;
        producers.push(`${path}:${i + 1}`);
        if (!/milestone\?\.title\s*\?\?\s*null/.test(line)) offenders.push(`${path}:${i + 1}`);
      });
    }

    // The census's own reach. A regex that matched nothing would leave the
    // offender list empty while witnessing nothing at all.
    expect(
      producers.length,
      "no `milestone?.title ??` producer found — this case is measuring nothing",
    ).toBeGreaterThanOrEqual(5);

    expect(
      offenders,
      "`Rankable.milestone` and `Dependent.milestone` document ONE absent value and it is " +
        "`null`. `\"\"` reads identically today only because `phaseOf` and `phaseInFamily` " +
        "normalise it; a `=== null` added to the ordering later would misbehave here alone",
    ).toEqual([]);
  });

  /**
   * #1965 round 5: an import of `phaseOf` with no call to it.
   *
   * Two files imported `phaseOf` and never called it — both left by this
   * PR's own refactor, which replaced `phase: phaseOf(title)` with
   * `milestone: title` at every construction site and did not sweep the
   * imports behind it. The repo sets no `noUnusedLocals`, so nothing failed.
   *
   * Narrow on purpose. A general unused-import ratchet is a different change
   * over the whole tree, and this is the specific symbol a `phase` → `title`
   * refactor leaves behind: a reader who finds it imported reasonably
   * concludes the file still reads phase numbers, which is the belief #1943
   * exists to remove.
   *
   * Breaking it: re-add the import to either script and this names it.
   */
  test("nothing imports phaseOf without calling it", () => {
    const population = sourceFiles(ROOT, ["lib", "scripts", "gates", "bin"]);
    const importers: string[] = [];
    const offenders: string[] = [];
    for (const path of population) {
      const code = codeOf(readFileSync(join(ROOT, path), "utf-8"));
      if (path === "lib/board-mirror.ts") continue; // its home — it declares it
      if (!/\bphaseOf\b/.test(code)) continue;
      importers.push(path);
      if (!code.includes("phaseOf(")) offenders.push(path);
    }

    expect(
      importers.length,
      "no file outside its home names phaseOf — this case is measuring nothing",
    ).toBeGreaterThanOrEqual(3);

    expect(
      offenders,
      "an import with no call reads as 'this file still works in phase numbers', which " +
        "#1943 made false. Delete it — the repo sets no noUnusedLocals, so nothing else will",
    ).toEqual([]);
  });

  test("the scan can find the string it looks for, and ignores comments", () => {
    expect(codeOf('console.log("at its depth");').includes("at its depth")).toBe(true);
    expect(codeOf("// never say at its depth here\nconst x = 1;").includes("at its depth")).toBe(false);
  });
});

/**
 * #1853 / Stage H: the label is the ordering's second source.
 *
 * ## The reading that caused it, 2026-11-06
 *
 * Of 38 unblocked and unclaimed issues, **10** carried a milestone and 28 did
 * not. `readyOrder` ranked on phase alone, so those 28 all ranked
 * `POSITIVE_INFINITY` and fell through to the tiebreak — the issue number.
 * **The lane was ordered by age for 74% of what it draws from**, and nothing
 * in the report said so.
 *
 * ## The mutation battery, membership predicted before it was run
 *
 *   mutant                                        predicted red
 *   LABEL_RANK reordered (engine last)            "engine beats", "best of several"
 *   an unknown label ranks 0 instead of UNPLACED  "unknown label", "no label at all"
 *   a label beats a milestone phase               "a milestone always beats"
 *   placementOf takes the WORST label, not best   "best of several"
 *   placementCensus folds UNPLACED into label     "census counts UNPLACED apart"
 *   the rank table copied into a script           "one site"
 *
 * Readings are in the PR body for #1853.
 */
describe("#1853: a label places an issue the milestone could not", () => {
  test("engine beats spec:convergence beats follow-up beats external-audit", () => {
    const got = [
      item(10, null, ["external-audit"]),
      item(20, null, ["follow-up"]),
      item(30, null, ["engine"]),
      item(40, null, ["spec:convergence"]),
    ]
      .sort(readyOrderFor(ENGINE, NO_WORK_NEXT))
      .map(i => i.number);
    expect(
      got,
      "Jason's rank of 2026-11-06 — engine leads because it is the work that reduces the backlog",
    ).toEqual([30, 40, 20, 10]);
  });

  test("a milestone always beats a label, however high the label ranks", () => {
    const got = [item(5, null, ["engine"]), item(900, 6)].sort(readyOrderFor(ENGINE, NO_WORK_NEXT)).map(i => i.number);
    expect(
      got,
      "phase 6 is the LAST phase and engine is the FIRST label, and the phase still wins — " +
        "the milestone is the declared plan and the label is only a category",
    ).toEqual([900, 5]);
  });

  test("an issue with several ranked labels takes the BEST of them", () => {
    const got = [item(1, null, ["follow-up"]), item(2, null, ["follow-up", "engine"])]
      .sort(readyOrderFor(ENGINE, NO_WORK_NEXT))
      .map(i => i.number);
    expect(
      got,
      "#2 is newer and still first: taking the worst label would let ADDING a label demote an " +
        "issue, which makes the rank punish labelling",
    ).toEqual([2, 1]);
    expect(placementOf(item(2, null, ["follow-up", "engine"]), ENGINE, NO_WORK_NEXT).rank).toBe(0);
  });

  test("age still breaks ties INSIDE a tier, and no longer decides the tier", () => {
    const got = [item(99, null, ["engine"]), item(1, null, ["external-audit"]), item(50, null, ["engine"])]
      .sort(readyOrderFor(ENGINE, NO_WORK_NEXT))
      .map(i => i.number);
    expect(
      got,
      "#1 is the oldest and sorts last: before #1853 the number was the whole ordering for " +
        "every milestone-less issue",
    ).toEqual([50, 99, 1]);
  });

  test("an unknown label does not place an issue — it is UNPLACED, never guessed", () => {
    const p = placementOf(item(7, null, ["arbiter-override"]), ENGINE, NO_WORK_NEXT);
    expect(p.tier, "arbiter-override is outside LABEL_RANK and is the live case on this repo").toBe(
      "UNPLACED",
    );
    expect(p.rank).toBe(Number.POSITIVE_INFINITY);
    expect(p.why, "the refusal has to name the labels it could not rank").toContain(
      "arbiter-override",
    );
    expect(LABEL_RANK.has("arbiter-override")).toBe(false);
  });

  test("no label at all is UNPLACED too, and says something different", () => {
    const none = placementOf(item(7, null, []), ENGINE, NO_WORK_NEXT);
    const unknown = placementOf(item(7, null, ["arbiter-override"]), ENGINE, NO_WORK_NEXT);
    expect(none.tier).toBe("UNPLACED");
    expect(
      none.why,
      "nothing-said and nothing-ranked are different facts and must not share a sentence",
    ).not.toBe(unknown.why);
  });

  test("two UNPLACED items order by age and never produce NaN", () => {
    // Infinity - Infinity is NaN, and a NaN comparator silently leaves an
    // array in input order — which would look exactly like a correct
    // age sort for an already-sorted input. So the input is NOT sorted.
    const got = [item(8, null, []), item(2, null, ["arbiter-override"])]
      .sort(readyOrderFor(ENGINE, NO_WORK_NEXT))
      .map(i => i.number);
    expect(got).toEqual([2, 8]);
    expect(readyOrderFor(ENGINE, NO_WORK_NEXT)(item(8, null, []), item(2, null, []))).toBeGreaterThan(0);
  });

  test("the census counts UNPLACED apart from the two placed tiers", () => {
    const got = placementCensus([
      item(1, 0),
      item(2, null, ["engine"]),
      item(3, null, ["follow-up"]),
      item(4, null, ["arbiter-override"]),
      item(5, null, []),
    ], ENGINE, NO_WORK_NEXT);
    expect(
      got,
      "folding UNPLACED into the label count is the defect one level up — an issue nothing " +
        "can rank would read identically to one ranked last",
    ).toEqual({ next: 0, phase: 1, label: 2, unplaced: 2 });
  });

  /**
   * #1943 — a phase number is only meaningful inside its own family.
   *
   * Observed 2026-11-09 in `work-status`, after five claims were released:
   *
   * ```
   * next out of the backlog, in plan order:
   *   #1764  milestone places it in phase 3   (Convergence Phase 3)
   *   #1717  milestone places it in phase 6   (Pipeline Phase 6)
   * ```
   *
   * Both sentences are true and between them they hid the defect: the two
   * numbers are counted in different sequences and `readyOrder` compared
   * them as one. `specs/SPEC-TO-BOARD-PIPELINE-SPEC.md` says the engine
   * ships before the payload and SC-2625 makes the payload shipping
   * untouched the engine's own acceptance test, so the order was inverted
   * against the project's own declared plan.
   */
  test("#1943: a LATER engine phase outranks an EARLIER phase in another family", () => {
    const got = [item(1764, 3, [], PAYLOAD), item(1717, 6, [], ENGINE)]
      .sort(readyOrderFor(ENGINE, NO_WORK_NEXT))
      .map(i => i.number);
    expect(
      got,
      "the payload outranked the engine that ships it — phase 3 beat phase 6 across families",
    ).toEqual([1717, 1764]);
  });

  test("#1943 CONTROL: inside ONE family the phase number still decides", () => {
    // Without this, the row above passes against a rule that ordered by
    // family and stopped — which would delete the phase ordering entirely
    // and look exactly like the family rank working.
    expect(
      [item(10, 6, [], ENGINE), item(99, 3, [], ENGINE)].sort(readyOrderFor(ENGINE, NO_WORK_NEXT)).map(i => i.number),
      "phase still orders within a family, and lower goes first",
    ).toEqual([99, 10]);
    expect(
      [item(10, 6, [], PAYLOAD), item(99, 3, [], PAYLOAD)].sort(readyOrderFor(ENGINE, NO_WORK_NEXT)).map(i => i.number),
      "and within the OTHER family too — the rank orders families, it does not flatten one",
    ).toEqual([99, 10]);
  });

  /**
   * #1943 round 2: a prefix is a FAMILY NAME, not a string prefix.
   *
   * `familyRank` matched with a bare `milestone.startsWith(enginePrefix)`, so
   * a family whose name merely begins with the engine's was ranked as the
   * engine. Measured before the fix, with `enginePrefix = "Pipeline"`:
   *
   *   "PipelineX Phase 2"  familyRank=0   ← another family, ranked as engine
   *   "Pipeline Phase 0"   familyRank=0 with prefix "Pipe"
   *
   * `lib/live-issues.ts` records this exact pair — *"`Pipe` matching
   * `Pipeline Phase 0`, `Fix` matching `Fixture Phase 2`"* — as round 2 of
   * #1703, *"the cross-spec contamination the prefix exists to prevent,
   * arriving through the fix for it"*. The docblock over `familyRank` cited
   * that file while the code underneath it reintroduced the bug.
   *
   * **Fixed by delegating to `inMilestoneFamily`, not by writing a boundary
   * check here.** A third place that decides family membership is the fourth
   * shape in `.claude/rules/checks-must-be-able-to-fail.md`, and it is the
   * failure `lib/live-issues.ts`'s own docblock is about.
   */
  test("#1943: a family whose NAME merely begins with the engine's is not the engine", () => {
    const LOOKALIKE = `${ENGINE}X`;
    expect(
      LOOKALIKE.startsWith(ENGINE),
      "the fixture must actually be a string-prefix match, or this row cannot fire",
    ).toBe(true);

    expect(
      familyRank(`${LOOKALIKE} Phase 2`, ENGINE),
      "a string prefix is not a family — `EngineX Phase 2` was ranked as the engine",
    ).toBe(1);

    // The other direction of the same defect: a SHORT configured prefix
    // swallowing the longer family whose name it begins.
    expect(
      familyRank(`${ENGINE} Phase 0`, ENGINE.slice(0, 3)),
      "a truncated prefix must not claim the family whose name it begins",
    ).toBe(1);

    // End to end, because `familyRank` alone could be right while the order
    // read something else.
    expect(
      [item(10, 2, [], LOOKALIKE), item(99, 6, [], ENGINE)]
        .sort(readyOrderFor(ENGINE, NO_WORK_NEXT))
        .map(i => i.number),
      "the lookalike family borrowed the engine's rank and its lower phase won",
    ).toEqual([99, 10]);
  });

  test("#1943 CONTROL: the real engine family still ranks ahead after the boundary fix", () => {
    // Without this, the row above passes against a `familyRank` that returns
    // 1 for everything — which deletes the family ordering entirely and is
    // the cheapest wrong fix for a boundary bug.
    expect(familyRank(`${ENGINE} Phase 6`, ENGINE), "the engine is still the engine").toBe(0);
    expect(
      familyRank(`${PAYLOAD} Phase 3`, ENGINE),
      "and another family is still another family",
    ).toBe(1);
    expect(
      [item(1764, 3, [], PAYLOAD), item(1717, 6, [], ENGINE)]
        .sort(readyOrderFor(ENGINE, NO_WORK_NEXT))
        .map(i => i.number),
      "the ordering this issue exists for must survive the boundary fix",
    ).toEqual([1717, 1764]);
  });

  /**
   * #1965 round 3, the process finding: four keys, one exhaustive table.
   *
   * The review's point was not a remaining line — it was that three
   * structurally different wrong behaviours turned up one at a time in the
   * same thirty-line comparator, each caught by a case written after a
   * reviewer named it:
   *
   *   1. family membership was a bare `startsWith` (over-matched `EngineX`);
   *   2. an early revision hoisted family ABOVE tier (every labelled issue
   *      became honorary engine and outranked a real `Convergence Phase 3`);
   *   3. the null-prefix control first went green under a mutant that
   *      invented a family split, because it asserted one pair.
   *
   * All three are "a key compared at the wrong level", and no number of
   * narrative cases enumerates that. So the precedence is asserted as a
   * TABLE, once: four keys in order, and for each one a pair that differs in
   * THAT key alone while every key above it is held equal and every key below
   * it is set ADVERSARIALLY — the loser is given the better value on every
   * lower key. A comparator that consults the keys in any other order, or
   * skips one, loses at least one row.
   *
   * That adversarial setting is the part the earlier cases lacked. A pair
   * that differs in one key and agrees on the rest goes green under a
   * comparator that ignores the key entirely, whenever the issue numbers
   * happen to fall the right way — which is how case 3 passed.
   *
   * Breaking it: swapping any two adjacent lines of `readyOrderFor`'s
   * comparison chain reddens the row named for the key that lost its place,
   * and leaves the others green.
   */
  test("#1943: the precedence is tier, then family, then phase, then number — all four", () => {
    // `winner` must sort first. Every key ABOVE the one named is equal;
    // every key BELOW it favours the loser, so a comparator that reached
    // the wrong key would pick the other one.
    const rows: { key: string; winner: Rankable; loser: Rankable; why: string }[] = [
      {
        key: "tier",
        // PHASE tier vs LABEL tier. The loser is in the engine family and
        // carries the best label rank, so family and rank both favour it.
        winner: { number: 900, milestone: `${PAYLOAD} Phase 9`, labels: [] },
        loser: { number: 1, milestone: null, labels: ["engine"] },
        why: "a milestone places an issue and a label does not — tier is read first",
      },
      {
        key: "family",
        // Both PHASE tier. The loser has the lower phase AND the lower
        // number, so everything below family favours it.
        winner: { number: 900, milestone: `${ENGINE} Phase 9`, labels: [] },
        loser: { number: 1, milestone: `${PAYLOAD} Phase 1`, labels: [] },
        why: "inside the PHASE tier the engine family goes first, whatever its phase number",
      },
      {
        key: "phase",
        // Same tier, same family. The loser has the lower number.
        winner: { number: 900, milestone: `${ENGINE} Phase 1`, labels: [] },
        loser: { number: 1, milestone: `${ENGINE} Phase 9`, labels: [] },
        why: "inside one family the lower phase goes first, whatever the issue number",
      },
      {
        key: "number",
        // Everything above is equal, so the number is all that is left.
        winner: { number: 1, milestone: `${ENGINE} Phase 3`, labels: [] },
        loser: { number: 900, milestone: `${ENGINE} Phase 3`, labels: [] },
        why: "with every other key equal the lower issue number goes first",
      },
    ];

    const order = readyOrderFor(ENGINE, NO_WORK_NEXT);
    for (const row of rows) {
      expect([row.winner, row.loser].sort(order).map(i => i.number), `${row.key}: ${row.why}`).toEqual(
        [row.winner.number, row.loser.number],
      );
      // Sorted from the other starting arrangement too — a comparator that
      // returned 0 for a pair leaves input order untouched, which is
      // indistinguishable from deciding correctly when the input already
      // happened to be right.
      expect(
        [row.loser, row.winner].sort(order).map(i => i.number),
        `${row.key}: the comparator is indifferent here — it returned 0 and the input order stood`,
      ).toEqual([row.winner.number, row.loser.number]);
    }

    // The table's own reach. Four keys and four rows, so a row silently
    // deleted during an edit does not shrink the guarantee unnoticed.
    expect(
      rows.map(r => r.key),
      "the precedence has four keys and this table must carry one row per key, in order",
    ).toEqual(["tier", "family", "phase", "number"]);
  });

  test("#1943 CONTROL: with NO prefix configured, phase alone orders across families", () => {
    // The reading a tree that declares no engine family must get, and the
    // one every consumer had before #1943. A `null` prefix inventing a
    // family would be `.claude/rules/config-access.md`'s Silent Default
    // Substitution pointed at an ordering.
    expect(
      [item(1764, 3, [], PAYLOAD), item(1717, 6, [], ENGINE)]
        .sort(readyOrderFor(null, NO_WORK_NEXT))
        .map(i => i.number),
      "an unconfigured tree has one family, so phase 3 goes first",
    ).toEqual([1764, 1717]);
    // **Both family assignments, because one of them passes by accident.**
    // The row above was the whole control at first, and a mutant that made
    // a null prefix favour PAYLOAD left it green: the payload item already
    // had the lower phase, so the invented family agreed with the right
    // answer. `.claude/rules/checks-must-be-able-to-fail.md`, *a case that
    // goes green under the wrong fix*.
    //
    // With one family, SWAPPING which family each item is in cannot change
    // the order. Any invented split moves exactly one of these two.
    expect(
      [item(10, 6, [], ENGINE), item(99, 3, [], PAYLOAD)]
        .sort(readyOrderFor(null, NO_WORK_NEXT))
        .map(i => i.number),
      "a null prefix invented a family that favours the payload",
    ).toEqual([99, 10]);
    expect(
      [item(10, 6, [], PAYLOAD), item(99, 3, [], ENGINE)]
        .sort(readyOrderFor(null, NO_WORK_NEXT))
        .map(i => i.number),
      "a null prefix invented a family that favours the engine",
    ).toEqual([99, 10]);
    // And the prefix that IS configured is the one that wins, not a
    // built-in that happens to match: ranking against PAYLOAD inverts it.
    expect(
      [item(1764, 3, [], PAYLOAD), item(1717, 6, [], ENGINE)]
        .sort(readyOrderFor(PAYLOAD, NO_WORK_NEXT))
        .map(i => i.number),
      "the family rank reads the prefix it was handed, not a name baked into the rule",
    ).toEqual([1764, 1717]);
  });

  test("#1943: a non-engine PHASE still beats a label, and the why says why", () => {
    // The family sits above the tier, so the obvious wrong fix — demoting
    // a non-engine phase below the LABEL tier — has to be excluded. A
    // milestone is still the declared plan; the family only orders phases
    // among themselves.
    expect(
      [item(5, null, ["engine"]), item(900, 6, [], PAYLOAD)]
        .sort(readyOrderFor(ENGINE, NO_WORK_NEXT))
        .map(i => i.number),
      "a milestone still beats a label, even in the other family",
    ).toEqual([900, 5]);
    expect(
      placementOf(item(900, 6, [], PAYLOAD), ENGINE, NO_WORK_NEXT).why,
      "the sentence must say the family, or #1943 is invisible in the report again",
    ).toContain(ENGINE);
    expect(placementOf(item(900, 6, [], ENGINE), ENGINE, NO_WORK_NEXT).why).toContain(`${ENGINE} family`);
  });

  test("THE CONTROL: the label rank is spelled at exactly one site", () => {
    // Two deciders that agree are behaviourally ONE decider, so a mutation
    // of either leaves the other holding every case up and the battery above
    // reads zero. `.claude/rules/checks-must-be-able-to-fail.md`, fourth
    // shape. The rank is data, so the check is on where the data is written.
    const root = join(import.meta.dir, "..");
    const owner = "lib/board-ready-rule.ts";
    const scanned = sourceFiles(root, ["lib", "scripts", "bin", "gates", "hooks"]);
    expect(
      scanned,
      "the sweep read nothing, so an empty offender list would witness nothing",
    ).toContain(owner);
    // **A rank, not a mention.** `lib/issue-create-override.ts` maps every
    // one of these labels to a HELP STRING, which is a legitimate second
    // naming and not a second decider — a first pass flagged it and would
    // have taught the next person that this check cries wolf. So the
    // predicate is the two shapes a copied rank actually takes: a label
    // beside a number, or two labels in one literal, which is a rank
    // expressed as array order.
    const labels = [...LABEL_RANK.keys()];
    const quoted = labels.map(l => `"${l}"`);
    const ranksLabel = (src: string): boolean => {
      const named = quoted.filter(q => src.includes(q));
      if (named.length < 2) return false;
      return src.split("\n").some(line => {
        const here = quoted.filter(q => line.includes(q));
        if (here.length >= 2) return true;
        return here.length === 1 && /"[^"\n]+"[^A-Za-z\n]{0,8}\d/.test(line);
      });
    };
    const offenders = scanned
      .filter(f => f !== owner)
      .filter(f => ranksLabel(readFileSync(join(root, f), "utf-8")));
    // The predicate must be able to say yes. Without this the check is the
    // third shape — an assertion that holds because nothing reaches it.
    expect(
      ranksLabel(readFileSync(join(root, owner), "utf-8")),
      "the predicate does not fire on the real rank table, so an empty offender list means nothing",
    ).toBe(true);
    expect(
      offenders,
      `${owner} is the only place the label rank may be written. These files name two or more ` +
        "ranked labels, which is how a second rank gets built beside the first: " +
        offenders.join(", "),
    ).toEqual([]);
  });
});

/**
 * #1853, ai-review round 1: every label reader refuses a truncated list.
 *
 * I added the guard to `scripts/board-ready.ts` and not to
 * `scripts/board-mirror.ts`, which selects labels for the same ordering and
 * promotes with it. Both reviewers found it. That is
 * `feedback-replace-one-name-scan-sweep-for-the-others` exactly — so this is
 * a sweep over the POPULATION rather than a second per-file case, and the
 * next file that selects labels is covered before it is written.
 *
 * A truncated label list is not a short one. The ranked label can be the one
 * on page two, and an issue ranked without it is placed as though nothing
 * ranked it — indistinguishable from an issue nothing ranks.
 */
describe("#1853: a truncated label list is refused, in every file that reads one", () => {
  const root = join(import.meta.dir, "..");
  // **The population is files that RANK with labels, not files that read
  // them.** A first pass swept every `labels(first:` and caught two that are
  // not ordering readers: `lib/live-issues.ts`, which records a
  // `labelsTruncated` flag on a snapshot and is right to report rather than
  // refuse, and `scripts/audit-issue-closures.ts`, which is a closure audit.
  // Widening a new refusal onto them would be this PR's scope leaking into
  // code it has no finding about, and the check would read as crying wolf.
  // Importing the ordering module is what makes truncation a WRONG POSITION
  // rather than a short list.
  const readers = sourceFiles(root, ["lib", "scripts", "bin", "gates", "hooks"]).filter(f => {
    const src = readFileSync(join(root, f), "utf-8");
    return /labels\s*\(\s*first\s*:/.test(src) && /board-ready-rule"/.test(src);
  });

  test("the sweep found the files it polices", () => {
    expect(
      readers,
      "an empty population is not a clean one — these two select labels today",
    ).toEqual(expect.arrayContaining(["scripts/board-ready.ts", "scripts/board-mirror.ts"]));
  });

  test.each(readers)("%s asks for the label connection's pageInfo", file => {
    const src = readFileSync(join(root, file), "utf-8");
    // The selection and its truncation marker, in one expression: a
    // `pageInfo` belonging to some OTHER connection in the same file would
    // satisfy a bare `.toContain("pageInfo")`.
    expect(
      src,
      `${file} selects labels without asking whether the list was cut short, so a ranked ` +
        "label on page two is read as absent and the issue is placed as if nothing ranked it",
    ).toMatch(/labels\s*\(\s*first\s*:[^)]*\)\s*\{[^}]*pageInfo/);
  });

  test.each(readers)("%s refuses rather than ranking a cut-short list", file => {
    const src = readFileSync(join(root, file), "utf-8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    expect(
      code,
      `${file} reads the label pageInfo and does not act on it, which is worse than not ` +
        "asking: the truncation is visible and discarded",
    ).toMatch(/labels\?\.pageInfo\?\.hasNextPage/);
    // The branch itself, bounded by its own braces — #664 forbids a
    // fixed-character window, and rightly: a 600-character slice would
    // start passing the day somebody adds a refusal 601 characters later
    // in an unrelated branch.
    const branch = structuralCut(code, "labels?.pageInfo?.hasNextPage", { balanced: "{" });
    expect(
      branch,
      `${file} must REFUSE inside the truncation branch, not warn and continue`,
    ).toMatch(/return\s+(EXIT_REFUSED|REFUSAL_EXIT)/);
  });
});

/**
 * #1852: how full Ready is, decided once.
 *
 * ## The reading that caused it, measured on main 2026-11-07
 *
 * Ready held issue #1650 and one DRAFT card at a depth of 2.
 *
 * | reader | counted | said |
 * |---|---|---|
 * | `scripts/board-ready.ts` | every card | `2 of 2, full` — refused 37 eligible issues |
 * | `scripts/work-status.ts` | open issues | `1 of 2 SHORT` — exited non-zero |
 *
 * Neither was wrong about the question it asked. **The lane was physically
 * full and functionally empty, and no single integer could say so** — the
 * writer would never refill it and the reader would never stop refusing, and
 * no event exists that clears it.
 *
 * ## The battery, membership predicted before it was run
 *
 *   mutant                                       predicted red
 *   free = cap - dispatchable, not cards         "a draft holds a slot"
 *   WEDGED folded into FULL                      "WEDGED is its own verdict", "heldReason", "the gate refuses"
 *   dispatchable > cards clamped, not thrown     "counted over different populations"
 *   an unreadable depth yields free = cap        "an unreadable depth frees nothing"
 *   a second cap - occupied in a script          "THE CONTROL: one free-slot site"
 */
describe("#1852: Ready has ONE occupancy reading", () => {
  test("a draft holds a slot: free space counts CARDS, not startable work", () => {
    const occ = readyOccupancy(2, 1, 2);
    expect(occ.free, "the draft occupies a slot a puller can see, so nothing may be promoted").toBe(0);
    expect(occ.undispatchable).toBe(1);
  });

  test("WEDGED is its own verdict — full by cards, empty by work", () => {
    const occ = readyOccupancy(2, 0, 2);
    expect(occ.verdict).toBe("WEDGED");
    expect(
      occ.why,
      "FULL sends the reader to the depth, which is not the thing to change here",
    ).toContain("Clear the lane");
  });

  test("full with SOME startable work is FULL, not WEDGED", () => {
    // The control the row above needs: without it, "returns WEDGED" is
    // satisfied by a reading that calls every full lane wedged.
    expect(readyOccupancy(2, 1, 2).verdict).toBe("FULL");
    expect(readyOccupancy(1, 1, 2).verdict).toBe("ROOM");
  });

  test("an unreadable depth frees nothing and is never a lane state", () => {
    const occ = readyOccupancy(5, 5, null);
    expect(occ.verdict).toBe("UNMEASURED");
    expect(occ.free, "a depth nobody read must not promote; that is the 36-of-46 reading").toBe(0);
    expect(selectReady([item(1, 0)], occ, ENGINE, NO_WORK_NEXT).promote).toEqual([]);
  });

  test("dispatchable above cards is REFUSED, not clamped", () => {
    // A clamp makes the wrong call site look right. The two numbers coming
    // from different populations is the entire defect #1852 closed, so it
    // throws rather than producing a plausible reading.
    expect(() => readyOccupancy(1, 2, 2)).toThrow(/counted over different populations/);
    expect(() => readyOccupancy(-1, 0, 2)).toThrow(/non-negative integers/);
    expect(() => readyOccupancy(1.5, 1, 2)).toThrow(/non-negative integers/);
  });

  test("heldReason sends a WEDGED lane to the cards, not to the depth", () => {
    const wedged = heldReason(readyOccupancy(2, 0, 2));
    expect(wedged).toContain("WEDGED");
    expect(
      wedged,
      "clearing the lane is the fix; telling the reader to raise the depth is the wrong place",
    ).toContain("clearing the lane");
    expect(heldReason(readyOccupancy(2, 2, 2)), "a FULL lane is still just at its depth").toBe(
      "Ready is at its depth",
    );
  });

  test("THE CONTROL: one site computes free slots", () => {
    // Two deciders that agree are behaviourally one, and this module's own
    // header records that happening here before, between `isReady` and
    // `target()`. `selectReady` used to spell `max(0, cap - occupied)`
    // itself, which made it the second site.
    const root = join(import.meta.dir, "..");
    const owner = "lib/board-ready-rule.ts";
    const scanned = sourceFiles(root, ["lib", "scripts", "bin", "gates", "hooks"]);
    expect(scanned, "an empty sweep is not a clean one").toContain(owner);
    const offenders = scanned.filter(f => {
      if (f === owner) return false;
      const code = readFileSync(join(root, f), "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
      return /Math\.max\(\s*0\s*,\s*cap\s*-/.test(code) || /\bcap\s*-\s*(occupied|cards)\b/.test(code);
    });
    expect(
      offenders,
      "these files compute free Ready slots themselves, so a mutation of readyOccupancy " +
        "would leave them holding the case up: " + offenders.join(", "),
    ).toEqual([]);
  });
});

/**
 * #1857 round 1: two renderings of one reading, and they must stay different.
 *
 * `heldReason` answers the PROMOTERS' question — why this eligible issue did
 * not move — and both call it while iterating items they held back. In a
 * `ROOM` reading those items are held because promoting into the free slots
 * reaches the depth, so "Ready is at its depth" is true of them.
 *
 * `scripts/work-status.ts` promotes nothing. It was reusing `heldReason` to
 * explain undispatchable cards, which printed "Ready is at its depth" over a
 * lane holding 2 of a depth of 5 — false, and the wrong instruction, because
 * that lane is fixed by promoting.
 *
 * The collapse is the mutation to watch: a later edit that points one of them
 * at the other, or gives `undispatchableRemedy` a ROOM arm copied from
 * `heldReason`, restores the bug with both functions still present. The ROOM
 * row below is the one that catches it.
 */
describe("#1857: the gate's remedy is not the promoter's", () => {
  const occAt = (cards: number, dispatchable: number, cap: number | null) =>
    readyOccupancy(cards, dispatchable, cap);

  test("ROOM: the gate is sent to promote and the promoter is not", () => {
    const room = occAt(2, 1, 5);
    expect(room.verdict).toBe("ROOM");
    expect(
      undispatchableRemedy(room),
      "two of a depth of five is not at its depth, and saying so sends the reader to the " +
        "one fix that cannot work",
    ).not.toContain("at its depth");
    expect(undispatchableRemedy(room)).toContain("PROMOTING");
    // The other half of the contrast, asserted so a mutant that "fixes"
    // heldReason instead goes red here: the promoter's sentence is CORRECT
    // as it stands and must not be changed to match.
    expect(
      heldReason(room),
      "an item a promoter held back in a ROOM reading is held because the promotion ahead " +
        "of it reaches the depth — this sentence is right for that question",
    ).toContain("at its depth");
    expect(undispatchableRemedy(room)).not.toBe(heldReason(room));
  });

  test("WEDGED: both say clear the lane, because both readers must", () => {
    const wedged = occAt(2, 0, 2);
    expect(wedged.verdict).toBe("WEDGED");
    expect(undispatchableRemedy(wedged)).toContain("clearing the lane is the fix");
    expect(heldReason(wedged)).toContain("clearing the lane is the fix");
  });

  test("FULL and UNMEASURED each get their own sentence", () => {
    const full = occAt(2, 1, 2);
    expect(full.verdict).toBe("FULL");
    expect(undispatchableRemedy(full)).toContain("at its depth of 2");
    expect(undispatchableRemedy(full)).not.toContain("WEDGED");

    const unmeasured = occAt(2, 1, null);
    expect(unmeasured.verdict).toBe("UNMEASURED");
    expect(
      undispatchableRemedy(unmeasured),
      "an unread depth is not a full lane — that is the #1794 defect in miniature",
    ).not.toContain("at its depth");
    expect(undispatchableRemedy(unmeasured)).toContain("could not be read");
  });

  test("every verdict gets a distinct remedy, so none falls through to another's", () => {
    const readings = [occAt(2, 1, 5), occAt(2, 1, 2), occAt(2, 0, 2), occAt(2, 1, null)];
    const verdicts: string[] = readings.map(r => r.verdict);
    // The population is the producer's own, so a fifth verdict cannot be
    // added without this going red.
    const src = readFileSync(join(import.meta.dir, "..", "lib/board-ready-rule.ts"), "utf-8");
    const declared = structuralCut(src, "export type OccupancyVerdict", { endAnchor: ";" })
      .match(/"([A-Z]+)"/g)!
      .map(s => s.replaceAll('"', ""));
    expect([...verdicts].sort()).toEqual([...declared].sort());
    expect(new Set(readings.map(undispatchableRemedy)).size).toBe(readings.length);
  });

  test("the gate calls the gate's renderer, and nothing calls both", () => {
    const code = readFileSync(join(import.meta.dir, "..", "lib/work-status.ts"), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    expect(code).toContain("undispatchableRemedy(occ)");
    expect(
      code,
      "this file promotes nothing, so the promoters' sentence is never the right one here",
    ).not.toContain("heldReason(");
  });
});

/**
 * #1962 — a bounded, auditable way to make one issue go next.
 *
 * Covers the label, the bound, and the direction the bound fails in. The
 * label is deliberately NOT in `LABEL_RANK`: top of that map still loses to
 * every milestone, and reaching the top past work that outranks you is the
 * whole request.
 */
describe("#1962: work-this-next is a bounded promotion, not a flag", () => {
  const next = (number: number, phase: number | null, extra: readonly string[] = []): Rankable =>
    item(number, phase, [WORK_NEXT_LABEL, ...extra]);

  test("an honoured card goes first, past a milestone that outranks it", () => {
    // The premise, measured first: WITHOUT the promotion the phase-0 engine
    // card wins, which is what #1853 and #1943 built. If this row were the
    // only one, a rule that promoted nothing and a rule that promoted
    // everything would be told apart by neither.
    const cards = [item(10, 0), next(99, 6)];
    expect(
      [...cards].sort(readyOrderFor(ENGINE, NO_WORK_NEXT)).map(i => i.number),
      "the premise: unpromoted, the lower phase leads",
    ).toEqual([10, 99]);

    const r = workNextReading(cards, 8);
    expect(r.status).toBe("HONOURED");
    expect([...cards].sort(readyOrderFor(ENGINE, r.honoured)).map(i => i.number)).toEqual([99, 10]);
  });

  test("the promotion changes ONLY the promoted card's position", () => {
    // The control the issue asks for by name. Everything below the promoted
    // card must hold its relative order, or the lever is moving things
    // nobody labelled.
    const cards = [item(1, 0), item(2, 1), next(3, 9), item(4, null, ["engine"]), item(5, null)];
    const r = workNextReading(cards, 8);
    expect([...cards].sort(readyOrderFor(ENGINE, r.honoured)).map(i => i.number)).toEqual([
      3, 1, 2, 4, 5,
    ]);
    expect(
      [...cards].sort(readyOrderFor(ENGINE, NO_WORK_NEXT)).map(i => i.number),
      "the same five, unpromoted — only #3 moves between the two readings",
    ).toEqual([1, 2, 3, 4, 5]);
  });

  test("over the bound NOTHING is promoted, and the refusal names every one", () => {
    const cards = [next(11, null), next(12, null), next(13, null), item(1, 0)];
    const r = workNextReading(cards, 2);
    expect(r.status).toBe("OVER_BOUND");
    expect(r.honoured.size, "a truncated promotion is a promotion nobody chose").toBe(0);
    for (const n of [11, 12, 13]) expect(r.why, `the refusal does not name #${n}`).toContain(`#${n}`);
    expect(r.why).toContain("2");
    expect(
      [...cards].sort(readyOrderFor(ENGINE, r.honoured)).map(i => i.number),
      "a refused promotion must leave the ordinary order exactly as it was",
    ).toEqual([...cards].sort(readyOrderFor(ENGINE, NO_WORK_NEXT)).map(i => i.number));
  });

  test("exactly AT the bound is honoured — the boundary, from both sides", () => {
    const at = [next(11, null), next(12, null)];
    expect(workNextReading(at, 2).status, "a count equal to the depth is inside it").toBe("HONOURED");
    expect(workNextReading([...at, next(13, null)], 2).status).toBe("OVER_BOUND");
  });

  test("an unreadable depth promotes nothing, and says so as UNMEASURED", () => {
    // `.claude/rules/config-access.md`: a depth that could not be read is not
    // a depth of zero and not a depth of infinity. Distinct from OVER_BOUND,
    // because one is somebody over-labelling and the other is a broken read.
    const r = workNextReading([next(11, null)], null);
    expect(r.status).toBe("UNMEASURED");
    expect(r.honoured.size).toBe(0);
    expect(r.why).toContain("#11");
    expect(r.why, "an unreadable depth was reported as an over-labelled one").not.toContain("REFUSED");
  });

  test("no label at all is NONE, and it is not the same word as the other three", () => {
    const r = workNextReading([item(1, 0), item(2, null, ["engine"])], 8);
    expect(r.status).toBe("NONE");
    expect(r.carrying).toEqual([]);
    const statuses = [
      r.status,
      workNextReading([next(1, null)], 8).status,
      workNextReading([next(1, null), next(2, null)], 1).status,
      workNextReading([next(1, null)], null).status,
    ];
    expect(new Set(statuses).size, "two of the four readings report the same word").toBe(4);
  });

  test("every reading names every carrier, so the lever is auditable in all four", () => {
    // `carrying` is the audit trail: whatever the verdict, the report can say
    // who asked. A reading that only populated it when it acted would make a
    // refusal invisible to anybody reading the census.
    const cards = [next(11, null), next(12, null)];
    for (const cap of [8, 1, null]) {
      expect(workNextReading(cards, cap).carrying, `cap ${String(cap)} dropped a carrier`).toEqual([
        11, 12,
      ]);
    }
  });

  test("the label is NOT in LABEL_RANK — adding it there would not reach the top", () => {
    // The design, as an assertion rather than a comment. Ranked 0 in the
    // LABEL tier it still loses to every milestone, which is the thing it
    // exists to beat — so a later edit that "tidies" it into the map is a
    // silent regression of the whole feature.
    expect(
      LABEL_RANK.has(WORK_NEXT_LABEL),
      `${WORK_NEXT_LABEL} belongs to its own tier above PHASE, not to LABEL_RANK — ` +
        "a LABEL-tier placement loses to every milestone",
    ).toBe(false);
    const asLabel = placementOf(item(9, null, [WORK_NEXT_LABEL]), ENGINE, NO_WORK_NEXT);
    expect(asLabel.tier, "the bare label placed an issue without a reading honouring it").toBe(
      "UNPLACED",
    );
  });

  test("the census counts promotions apart from the tier they came from", () => {
    const cards = [next(11, 6), item(1, 0), item(2, null, ["engine"]), item(3, null)];
    const r = workNextReading(cards, 8);
    expect(placementCensus(cards, ENGINE, r.honoured)).toEqual({
      next: 1,
      phase: 1,
      label: 1,
      unplaced: 1,
    });
    expect(
      placementCensus(cards, ENGINE, NO_WORK_NEXT),
      "unpromoted, the same card must count in the tier it actually belongs to",
    ).toEqual({ next: 0, phase: 2, label: 1, unplaced: 1 });
  });

  test("the bound is Ready's depth, read from throughput and not typed here", () => {
    // The bound must be the SAME number the lane is judged against, or the
    // lever has a second depth nobody declared. Derived from the live
    // reading, so a change to READY_TOLERANCE_DAYS moves both.
    const cap = readyCap(LIVE);
    expect(cap).not.toBeNull();
    const cards = Array.from({ length: cap! }, (_, i) => next(i + 1, null));
    expect(workNextReading(cards, cap).status).toBe("HONOURED");
    expect(workNextReading([...cards, next(999, null)], cap).status).toBe("OVER_BOUND");
  });

  test("two honoured cards order by age, and the why says where each would have sat", () => {
    const cards = [next(50, 6), next(10, 0)];
    const r = workNextReading(cards, 8);
    expect([...cards].sort(readyOrderFor(ENGINE, r.honoured)).map(i => i.number)).toEqual([10, 50]);
    const why = placementOf(cards[0], ENGINE, r.honoured).why;
    expect(why, "the promotion does not name the label that caused it").toContain(WORK_NEXT_LABEL);
    expect(why, "the promotion hides where the card would otherwise have sat").toContain("phase 6");
  });
});

describe("#1962: the promotion reaches the writer, not only the report", () => {
  const ROOT = join(import.meta.dir, "..");
  const codeOf = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("selectReady promotes the honoured card past a higher-ranked one", () => {
    // The lever's point. `selectReady` is what WRITES the Ready lane, so a
    // promotion that only moved `work-status`'s list would be a report that
    // disagrees with the board — the exact defect #1795 closed in the other
    // direction.
    const eligible = [item(10, 0), item(99, 6, [WORK_NEXT_LABEL])];
    const occ = readyOccupancy(0, 0, 1);
    expect(occ.free, "the fixture left no slot, so neither arm below writes anything").toBe(1);

    expect(
      selectReady(eligible, occ, ENGINE, NO_WORK_NEXT).promote.map(i => i.number),
      "the premise: unpromoted, the one slot goes to the lower phase",
    ).toEqual([10]);
    expect(
      selectReady(eligible, occ, ENGINE, workNextReading(eligible, 8).honoured).promote.map(
        i => i.number,
      ),
      "the writer ignored an honoured promotion",
    ).toEqual([99]);
  });

  /**
   * The population guard, the same shape #1943's prefix guard uses.
   *
   * Three scripts order Ready. A fourth that ordered without taking a
   * promotion reading would compile, run, and silently turn the lever off
   * for whichever surface it owns — and a behavioural suite catches only the
   * last site to regress (`.claude/rules/checks-must-be-able-to-fail.md`,
   * *two deciders that agree*, at N sites).
   *
   * Breaking it: pass `NO_WORK_NEXT` at any one of the three call sites and
   * this names that file.
   */
  test("every script that ORDERS takes a work-next reading, and none opts out", () => {
    const ORDERERS = ["readyOrderFor", "selectReady", "splitReadyChanges", "placementCensus"];
    const population = sourceFiles(ROOT, ["scripts"]);
    expect(population.length, "the sweep read no scripts").toBeGreaterThan(10);

    const orderers: string[] = [];
    const offenders: string[] = [];
    for (const path of population) {
      const code = codeOf(readFileSync(join(ROOT, path), "utf-8"));
      if (!ORDERERS.some(fn => code.includes(`${fn}(`))) continue;
      orderers.push(path);
      if (!code.includes("workNextReading(")) offenders.push(`${path}: takes no reading`);
      // `NO_WORK_NEXT` is the honest value for a caller that CANNOT read a
      // depth. None of these three is that caller — every one of them has
      // the cap in scope — so here it is an opt-out, not an absence.
      if (code.includes("NO_WORK_NEXT")) offenders.push(`${path}: opts out with NO_WORK_NEXT`);
    }

    expect(
      orderers.sort(),
      "the scan did not find the scripts that order Ready — it is measuring nothing",
    ).toEqual(["scripts/board-mirror.ts", "scripts/board-ready.ts", "scripts/work-status.ts"]);
    expect(
      offenders,
      `a script that orders Ready without a workNextReading leaves "${WORK_NEXT_LABEL}" ` +
        "inert on whichever surface it owns, with nothing saying so",
    ).toEqual([]);
  });
});
