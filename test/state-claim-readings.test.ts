import { describe, expect, test } from "bun:test";

import {
  citedReadings,
  judgeClaims,
  readStateClaims,
  type LiveReading,
} from "../lib/state-claim-readings";

/**
 * Covers #1889 — the extractor behind `scripts/check-state-claims.ts`.
 *
 * Three review rounds on #1888 each found the same defect in
 * `project-state.json`'s prose and all three were caught by a reader doing
 * arithmetic. This is the binding that stops that being a human job.
 *
 * **What every row below holds fixed, said out loud**: the live readings
 * are a fixture, so no case here depends on the board. The cases that vary
 * the PROSE are the point; the one case that varies the READING NAMES is
 * `UNRESOLVABLE`, and it is written because a renamed reading would
 * otherwise drop out of the comparison and leave the file reading as fully
 * checked.
 */
const LIVE: LiveReading[] = [
  { name: "milestones", measured: 26, target: 26 },
  { name: "criterion-coverage", measured: 26, target: 26 },
  { name: "blocked-by-edges", measured: 5, target: 5 },
  { name: "criteria-field", measured: 5, target: 5 },
  { name: "queue-label", measured: 5, target: 5 },
];
const NAMES = LIVE.map(r => r.name);

describe("citedReadings — what counts as a cited figure", () => {
  test("a ratio written after a reading's name is a claim, in both spellings", () => {
    expect(citedReadings("milestones 26 of 26 MET", NAMES)).toEqual([
      { reading: "milestones", measured: 26, target: 26, sentence: "milestones 26 of 26 MET", dated: false },
    ]);
    expect(citedReadings("milestones 26/26.", NAMES).map(c => [c.measured, c.target])).toEqual([[26, 26]]);
  });

  test("a few words may sit between the name and the figure", () => {
    // Taken from the live file: "restored blocked-by-edges to 6 of 6".
    const c = citedReadings("restored blocked-by-edges to 6 of 6 under the ordinary scope.", NAMES);
    expect(c.map(x => [x.reading, x.measured, x.target])).toEqual([["blocked-by-edges", 6, 6]]);
  });

  test("CONTROL: a clause boundary ends the window, with no second name in sight", () => {
    // The case the OTHER guard cannot see, and it is here because a
    // mutation said so: widening `[^,;.]` to `.` turned zero cases red
    // until this was written, because every list this suite held was
    // already caught by the name-in-window check below. There is no second
    // reading in this sentence, so only the comma keeps `3 of 9` from
    // being read as `blocked-by-edges`'s figure.
    expect(citedReadings("blocked-by-edges MET, but 3 of 9 elsewhere.", NAMES)).toEqual([]);
  });

  test("CONTROL: a list does not pair the first name with the second figure", () => {
    // Caught by the name-in-window guard, NOT by the punctuation stop —
    // which is what the case above exists to keep honest.
    const c = citedReadings("blocked-by-edges 5 of 6, criteria-field 5 of 6", NAMES);
    expect(c.map(x => [x.reading, x.measured, x.target])).toEqual([
      ["blocked-by-edges", 5, 6],
      ["criteria-field", 5, 6],
    ]);
  });

  test("CONTROL: another reading's name inside the window disqualifies the pairing", () => {
    // Punctuation alone is not enough — this list has none. Deleting the
    // `ordered.some(...)` guard turns this red.
    const c = citedReadings("B3 blocked-by-edges MET B4 criteria-field 5 of 5", NAMES);
    expect(c.map(x => x.reading)).toEqual(["criteria-field"]);
  });

  test("CONTROL: a reading's name inside a LONGER word is not that reading", () => {
    // #1915 round 2. Unanchored, these three produced citations of
    // `milestones` out of sentences that never mention it — and that errs
    // toward COMPARING, which is the opposite of the direction this file
    // declares it is allowed to be wrong in. A false DISAGREED reddens a
    // true sentence; a false AGREED masks a real one.
    //
    // **`\b` does not fix this**, which is why the case is written with
    // compounds on both sides. `-` is a non-word character, so
    // `milestones\b` matches inside `milestones-tracking` and
    // `\bmilestones` matches inside `sub-milestones`. Every reading this
    // project has is hyphenated, so the obvious repair would leave all
    // three green while changing nothing.
    for (const s of [
      "milestones-tracking is 5 of 5.",
      "sub-milestones 3 of 4.",
      "milestones_v2 is 1 of 2.",
    ]) {
      expect(citedReadings(s, NAMES), s).toEqual([]);
    }
    // …and a hyphenated name still matches as itself, or the fix is a
    // deletion: `blocked-by-edges` contains the very character the
    // boundary excludes.
    expect(citedReadings("blocked-by-edges 5 of 5.", NAMES).map(c => c.reading)).toEqual([
      "blocked-by-edges",
    ]);
  });

  test("CONTROL: a bare ratio naming no reading is not a claim", () => {
    // This is the whole of "not a fact-checker for English". An extractor
    // that matched every `N of M` would be re-deriving sentences about
    // issues, tests and shards against board readings.
    expect(citedReadings("Stage D is 3 of 6 and two of the five were delivered.", NAMES)).toEqual([]);
  });

  test("CONTROL: a line break ends a sentence, so the window cannot cross it", () => {
    // A priorities[] entry is one long string with hard breaks in it.
    // Dropping `\n+` from SENTENCE lets the window reach across the break
    // and pair a name on one line with a figure on the next.
    expect(citedReadings("blocked-by-edges MET\n5 of 5 elsewhere", NAMES)).toEqual([]);
  });

  test("a date or a SHA in the sentence marks the figure as a record", () => {
    const dated = citedReadings("The 2026-11-03 session recorded milestones 26/26.", NAMES);
    expect(dated[0]?.dated).toBe(true);
    const sha = citedReadings("re-taken at 87d7c832 — milestones 26/26.", NAMES);
    expect(sha[0]?.dated).toBe(true);
    expect(citedReadings("milestones 26/26.", NAMES)[0]?.dated).toBe(false);
  });

  test("CONTROL: a word spelt only from a-f is not a SHA, and must not suppress the figure", () => {
    // A bypass, not a nicety. `[0-9a-f]{7,40}` with no digit required
    // matches ordinary English — and a sentence containing one of these
    // would be marked RECORDED and its figure never compared, which is a
    // silent hole anybody could walk a stale number through.
    //
    // Dropping the `\d` requirement from `STAMPED` turns every row red.
    for (const word of ["defaced", "effaced", "faceted", "decade", "cabbage"]) {
      const c = citedReadings(`the ${word} list — milestones 26/26.`, NAMES);
      expect(c[0]?.dated, `${word} was read as a commit SHA`).toBe(false);
    }
    // …and a real short SHA still is one, or the fix would be a deletion.
    expect(citedReadings("at 87d7c832 — milestones 26/26.", NAMES)[0]?.dated).toBe(true);
  });

  test("CONTROL: a plain decimal of 7+ digits is not a SHA either", () => {
    // The half the first fix missed. Requiring *a* digit does not exclude
    // a NUMBER — every decimal is valid hex — so `run 12345678` marked its
    // sentence RECORDED and the figure beside it was never compared. A
    // GitHub run id, an issue count, a line number: any of them was a way
    // through. Dropping the `(?=[0-9a-f]*[a-f])` lookahead turns these red.
    for (const n of ["12345678", "1234567", "9999999999"]) {
      const c = citedReadings(`criterion-coverage 25 of 26, filed as run ${n}.`, NAMES);
      expect(c[0]?.dated, `the decimal ${n} was read as a commit SHA`).toBe(false);
    }
    // The cost, stated: an all-digit SHA prefix is no longer read as one,
    // so its figure is COMPARED rather than recorded. That is the
    // direction this is allowed to be wrong in — the remedy a refusal
    // names is "date the sentence".
    expect(citedReadings("at 1234567 — milestones 26/26.", NAMES)[0]?.dated).toBe(false);
    expect(citedReadings("on 2026-11-03 at 1234567 — milestones 26/26.", NAMES)[0]?.dated).toBe(true);
  });
});

describe("judgeClaims — four outcomes, four different facts", () => {
  test("an undated figure matching the live reading AGREES", () => {
    expect(judgeClaims("milestones 26 of 26.", LIVE).map(v => v.kind)).toEqual(["AGREED"]);
  });

  test("an undated figure that does not match DISAGREES, and names both sides", () => {
    const [v] = judgeClaims("blocked-by-edges 6 of 6.", LIVE);
    expect(v?.kind).toBe("DISAGREED");
    if (v?.kind !== "DISAGREED") throw new Error("unreachable");
    expect([v.cited.measured, v.cited.target]).toEqual([6, 6]);
    expect([v.live.measured, v.live.target]).toEqual([5, 5]);
  });

  test("a DATED figure is RECORDED and never compared, even when it disagrees", () => {
    // #1888 round 1, in the other direction: a 2026-11-03 recording read as
    // a statement about today. Removing the `cited.dated` branch turns this
    // red, and it is the only case that can see that branch.
    const [v] = judgeClaims("The 2026-11-03 session recorded blocked-by-edges 12/12.", LIVE);
    expect(v?.kind).toBe("RECORDED");
  });

  test("a citation of a renamed reading VANISHES — which is why the guard is elsewhere", () => {
    // Asserted as the limitation it is, not papered over. `judgeClaims`
    // derives its name list from the live readings, so a figure citing a
    // name they no longer carry never reaches a verdict at all. An
    // `UNRESOLVABLE` branch was written for this and could not fire; a
    // branch that cannot fire is not protection, it is the reason nobody
    // checks.
    //
    // The rename IS caught, by comparing the reading SETS in
    // `scripts/check-state-claims.ts` against the set the ratchet was
    // banked with. This case pins why that guard has to live there.
    const shrunk = LIVE.filter(r => r.name !== "queue-label");
    expect(judgeClaims("queue-label 5 of 5.", shrunk)).toEqual([]);
    // The same prose against the full set is one claim, so the vanishing
    // above is the rename and not a defect in the extractor.
    expect(judgeClaims("queue-label 5 of 5.", LIVE)).toHaveLength(1);
  });
});

describe("readStateClaims — the file-level reading", () => {
  test("no readable claims is its own fact, not zero disagreements", () => {
    // The vacuous-assertion shape. These two readings have the same
    // `disagreed.length` and describe completely different states; a
    // caller that only looked at that number would certify a file it never
    // read inside.
    const empty = readStateClaims(["nothing here cites a reading"], LIVE);
    const clean = readStateClaims(["milestones 26 of 26."], LIVE);
    expect(empty.disagreed).toEqual(clean.disagreed);
    expect(empty.claims).toBe(0);
    expect(clean.claims).toBe(1);
  });

  test("a non-string priorities entry is read, not skipped", () => {
    // `priorities[]` has carried objects. Dropping them would make the
    // check quieter the more structured the file became.
    const r = readStateClaims([JSON.stringify({ note: "blocked-by-edges 6 of 6" })], LIVE);
    expect(r.disagreed).toHaveLength(1);
  });

  test("the counts partition the verdicts — nothing is counted twice or lost", () => {
    const r = readStateClaims(
      [
        "milestones 26 of 26.",
        "blocked-by-edges 6 of 6.",
        "On 2026-11-03, queue-label 12/12.",
        "no figures at all here",
      ],
      LIVE,
    );
    expect(r.claims).toBe(3);
    expect(r.agreed + r.disagreed.length + r.recorded).toBe(r.claims);
    expect([r.agreed, r.disagreed.length, r.recorded]).toEqual([1, 1, 1]);
  });
});
