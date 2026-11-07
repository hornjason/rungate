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
  READY_TOLERANCE_DAYS,
  heldReason,
  placementCensus,
  placementOf,
  readyCap,
  readyOccupancy,
  readyOrder,
  readyTarget,
  selectReady,
  undispatchableRemedy,
  type Rankable,
} from "../lib/board-ready-rule";

const item = (number: number, phase: number | null, labels: readonly string[] = []): Rankable => ({
  number,
  phase,
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
    const got = [item(50, 1), item(10, 1), item(99, 0), item(7, 2)].sort(readyOrder).map(i => i.number);
    expect(got).toEqual([99, 10, 50, 7]);
  });

  // The decision of 2026-11-05, as a case. Under the rule this replaces a
  // phase-less issue was not merely last, it was INELIGIBLE — and 22 of the
  // 35 pickable issues that day had no milestone at all.
  test("a phase-less issue sorts LAST, and is still in the queue", () => {
    const got = [item(3, null), item(9, 2), item(4, null), item(1, 0)].sort(readyOrder).map(i => i.number);
    expect(
      got,
      "phase-less items come after every phased one and before nothing — ordering, not a gate",
    ).toEqual([1, 9, 3, 4]);
  });

  test("a queue of only phase-less issues is ordered by age, not discarded", () => {
    expect([item(8, null), item(2, null)].sort(readyOrder).map(i => i.number)).toEqual([2, 8]);
  });
});

describe("SC-2716: the cap binds, and replenishes as slots free", () => {
  const twelve = Array.from({ length: 12 }, (_, i) => item(i + 1, 0));

  test("more eligible work than depth promotes exactly the depth, in order", () => {
    expect(selectReady(twelve, atDepth(0, 4)).promote.map(i => i.number)).toEqual([1, 2, 3, 4]);
  });

  test("a full lane promotes nothing", () => {
    const r = selectReady(twelve, atDepth(4, 4));
    expect(r.promote).toEqual([]);
    expect(r.why).toContain("full");
  });

  test("a pull frees a slot and the next event refills exactly that many", () => {
    expect(selectReady(twelve, atDepth(2, 4)).promote.map(i => i.number)).toEqual([1, 2]);
    expect(selectReady(twelve, atDepth(3, 4)).promote.map(i => i.number)).toEqual([1]);
  });

  test("a lane over its depth promotes nothing rather than a negative count", () => {
    expect(selectReady(twelve, atDepth(11, 4)).promote).toEqual([]);
  });

  test("less eligible work than depth promotes all of it", () => {
    expect(selectReady([item(5, 1), item(2, 0), item(9, null)], atDepth(0, 4)).promote.map(i => i.number)).toEqual([
      2, 5, 9,
    ]);
  });

  // Promoting everything eligible on an unreadable cap is the 36-of-46
  // reading performed automatically, which is the failure the cap exists
  // to prevent.
  test("an unreadable cap promotes nothing and says UNMEASURED", () => {
    const r = selectReady(twelve, atDepth(0, null));
    expect(r.promote).toEqual([]);
    expect(r.why).toContain("UNMEASURED");
  });

  test("selection does not mutate its input", () => {
    const given = [item(3, 1), item(1, 0)];
    selectReady(given, atDepth(0, 4));
    expect(given.map(i => i.number), "sorting in place reorders the caller's decision record").toEqual([3, 1]);
  });

  // The binding between the two halves, as behaviour: what the health
  // reading demands and what the writer supplies are the same number.
  test("what the writer promotes into an empty lane equals the target the reading judges against", () => {
    for (const eligible of [0, 1, 3, 4, 12, 34]) {
      const items = Array.from({ length: eligible }, (_, i) => item(i + 1, 0));
      expect(
        selectReady(items, atDepth(0, 4)).promote.length,
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
      .sort(readyOrder)
      .map(i => i.number);
    expect(
      got,
      "Jason's rank of 2026-11-06 — engine leads because it is the work that reduces the backlog",
    ).toEqual([30, 40, 20, 10]);
  });

  test("a milestone always beats a label, however high the label ranks", () => {
    const got = [item(5, null, ["engine"]), item(900, 6)].sort(readyOrder).map(i => i.number);
    expect(
      got,
      "phase 6 is the LAST phase and engine is the FIRST label, and the phase still wins — " +
        "the milestone is the declared plan and the label is only a category",
    ).toEqual([900, 5]);
  });

  test("an issue with several ranked labels takes the BEST of them", () => {
    const got = [item(1, null, ["follow-up"]), item(2, null, ["follow-up", "engine"])]
      .sort(readyOrder)
      .map(i => i.number);
    expect(
      got,
      "#2 is newer and still first: taking the worst label would let ADDING a label demote an " +
        "issue, which makes the rank punish labelling",
    ).toEqual([2, 1]);
    expect(placementOf(item(2, null, ["follow-up", "engine"])).rank).toBe(0);
  });

  test("age still breaks ties INSIDE a tier, and no longer decides the tier", () => {
    const got = [item(99, null, ["engine"]), item(1, null, ["external-audit"]), item(50, null, ["engine"])]
      .sort(readyOrder)
      .map(i => i.number);
    expect(
      got,
      "#1 is the oldest and sorts last: before #1853 the number was the whole ordering for " +
        "every milestone-less issue",
    ).toEqual([50, 99, 1]);
  });

  test("an unknown label does not place an issue — it is UNPLACED, never guessed", () => {
    const p = placementOf(item(7, null, ["arbiter-override"]));
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
    const none = placementOf(item(7, null, []));
    const unknown = placementOf(item(7, null, ["arbiter-override"]));
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
      .sort(readyOrder)
      .map(i => i.number);
    expect(got).toEqual([2, 8]);
    expect(readyOrder(item(8, null, []), item(2, null, []))).toBeGreaterThan(0);
  });

  test("the census counts UNPLACED apart from the two placed tiers", () => {
    const got = placementCensus([
      item(1, 0),
      item(2, null, ["engine"]),
      item(3, null, ["follow-up"]),
      item(4, null, ["arbiter-override"]),
      item(5, null, []),
    ]);
    expect(
      got,
      "folding UNPLACED into the label count is the defect one level up — an issue nothing " +
        "can rank would read identically to one ranked last",
    ).toEqual({ phase: 1, label: 2, unplaced: 2 });
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
    expect(selectReady([item(1, 0)], occ).promote).toEqual([]);
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
