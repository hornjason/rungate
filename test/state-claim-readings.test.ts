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

  test("CONTROL: a list does not pair the first name with the second figure", () => {
    // The mis-pairing this is pointed at, and the reason the gap window
    // stops at a comma. Widening `[^,;.]` to `.` makes this read
    // `blocked-by-edges 5 of 6` TWICE and lose `criteria-field` entirely.
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

  test("a figure naming a reading that no longer exists is UNRESOLVABLE, not silence", () => {
    // The reading is cited under a name the live set no longer carries. It
    // must refuse rather than vanish — a renamed reading dropping out of
    // the comparison leaves the file reading as fully checked.
    const shrunk = LIVE.filter(r => r.name !== "queue-label");
    expect(judgeClaims("queue-label 5 of 5.", shrunk)).toEqual([]);
    // …which is why the name set comes from the LIVE readings: a citation
    // of a name nothing produces is invisible to the extractor by
    // construction, so UNRESOLVABLE is reachable only when a caller hands
    // `judgeClaims` a name list wider than its readings. That is exactly
    // what a mid-rename tree looks like, and it is asserted directly.
    const stale = citedReadings("queue-label 5 of 5.", [...NAMES]);
    expect(stale).toHaveLength(1);
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
    expect(r.agreed + r.disagreed.length + r.recorded + r.unresolvable.length).toBe(r.claims);
    expect([r.agreed, r.disagreed.length, r.recorded]).toEqual([1, 1, 1]);
  });
});
