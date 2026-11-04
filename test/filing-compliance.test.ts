import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { listIssueComments } from "../lib/github";

import {
  complianceReading,
  ghIssueComments,
  targetOf,
  type CommentReading,
  type FilingComplianceRow,
} from "../lib/filing-compliance";

/**
 * Does a refused filing become the comment the refusal told it to be?
 *
 * ## The one thing every case here exists to protect
 *
 * **A rate of zero and a denominator of zero are different readings and must
 * never render the same.** The question this module answers has, as of the
 * day it was written, an empty population: the two refusals that route a
 * finding to a comment — `COMMENT_INSTEAD` and `OVER_CAP` — have fired zero
 * times in the production ledger, so the honest output is *nobody has been
 * refused yet*, not *nobody complied*. Every aggregate below is asserted for
 * `rate === null` on an empty denominator rather than `rate === 0`, and
 * `FC-4` is the case that fails if someone "simplifies" the division.
 *
 * ## Why the reading is an UPPER BOUND and says so
 *
 * The ledger does not record who attempted the filing, so a comment landing
 * on the target inside the window cannot be attributed to the agent that was
 * refused — it may be anyone's. Counting it as compliance can only ever
 * overstate. That is worth having (an upper bound of zero is decisive) but
 * it is not a compliance rate, and `compliedUpperBound` is named so that a
 * later reader cannot quote it as one.
 *
 * ## What was broken to prove these can fail
 *
 * Run against this tree, 26 tests. Every count predicted before the battery
 * ran, and **the baseline row was read first** — an instrument that has
 * stopped reporting takes the baseline down with it, and nobody mutates
 * anything to produce that row.
 *
 * **M1..M7 WERE MEASURED AT A SUITE OF ELEVEN, AND THAT MATTERS.** The
 * sentence above said 11 while the file shipped 20, which reads as evidence
 * the battery saw the suite being merged. It did not. Nine tests have been
 * added since the battery ran — `FC-13`, `FC-14`, the five in the
 * Octokit-migration block, and `FC-18`/`FC-19` below — so each mutant's
 * failure count is a LOWER BOUND today, never an over-count: a mutation that
 * killed three cases out of eleven cannot kill fewer now. The baseline row is
 * re-read on every run and `FC-19` fails the suite when this number and the
 * file disagree, which is how the stale one was found.
 *
 * | Row | Predicted | Measured |
 * |---|---|---|
 * | **baseline** — unmutated | 26 pass, 0 fail | **26 pass, 0 fail** |
 * | M1 `rate` divides unconditionally — `NaN` instead of `null` | 3 | **3** |
 * | M2 the denominator becomes `rows.length` | 4 | **4** |
 * | M3 an `UNMEASURED` lookup reads as no-comment | 1 | **1** |
 * | M4 the window is ignored | 2 | **2** |
 * | M5 `targetOf` stops excluding emitted rows | 2 | **2** |
 * | M6 `unobservableByRefusal` never populated | 1 | **1** |
 * | M7 `issueNumber` accepts only numbers — the shipped defect | 1 | **1** |
 *
 * Before believing any row, the input on which mutant and original differ:
 * for M1 and M2 a population with no observable rows, where the original
 * withholds the number and the mutant prints `NaN` or `0`; for M3 a lookup
 * returning `UNMEASURED`; for M4 a comment one millisecond outside the
 * window; for M5 an emitted row carrying a `duplicateOf`; for M6 any
 * unobservable row; for M7 `duplicateOf: ["1214"]`, which the original reads
 * as issue 1214 and the mutant discards.
 *
 * **M1 and M2 are the cheapest wrong fixes, named in advance.** The symptom
 * a reader meets is a `null` where they wanted a percentage, and both
 * repairs are one expression: drop the guard, or divide by the row count to
 * make the guard unreachable. Each produces a confident number over a
 * population that does not support one.
 *
 * **M7 is not a hypothetical.** It is what this module shipped in its first
 * draft, and the real ledger reading it produced was a denominator of 0 over
 * 261 rows — indistinguishable from "no refusal has ever had a target". The
 * nine that did were discarded by the parser. The reading after the fix is
 * 9 observable and an upper bound of 2.
 *
 * None of the seven mutations is left in the tree; all were run and
 * reverted, and `lib/filing-compliance.ts` was confirmed byte-identical to
 * the measured source afterwards by sha256.
 */

const ROW: FilingComplianceRow = {
  at: "2026-10-24T12:00:00.000Z",
  title: "a refused finding",
  refusal: "DUPLICATE",
  emitted: false,
  duplicateOf: [1400],
};

const HOUR = 3_600_000;

const measured = (...at: string[]): CommentReading => ({
  reading: "MEASURED",
  comments: at.map(a => ({ at: a })),
});

const lookupOf =
  (byIssue: Record<number, CommentReading>) =>
  async (issue: number): Promise<CommentReading> =>
    byIssue[issue] ?? { reading: "MEASURED", comments: [] };

describe("targetOf", () => {
  test("FC-1: a refused row naming a duplicate names that issue as the target", () => {
    expect(targetOf(ROW)).toEqual({ reading: "NAMED", issues: [1400] });
  });

  test("FC-2: a refused row with no recorded target is UNOBSERVABLE and names the refusal", () => {
    const t = targetOf({ ...ROW, refusal: "NO_CLAIM", duplicateOf: [] });
    expect(t.reading).toBe("UNOBSERVABLE");
    // The reason has to say WHICH refusal could not be followed up, because
    // the fix is per-refusal: `OVER_CAP` needs the target persisted on the
    // row, `NO_CLAIM` needs it too, and `DROPPED_CATEGORY` never had one.
    expect(t.reading === "UNOBSERVABLE" && t.why).toContain("NO_CLAIM");
  });

  test("FC-11: the ledger writes duplicateOf as STRINGS, and those are targets", () => {
    // Not a hypothetical shape. Measured on the production ledger
    // 2026-10-25: all 14 `duplicateOf` elements across 261 rows are decimal
    // STRINGS — `["1214"]`, `["1173"]` — and a reader that accepted only
    // `number` dropped every one of them. The first run of this module did
    // exactly that and reported a denominator of 0 for the whole file, which
    // is the right answer to the wrong question: the population was not
    // empty, the parser was. A leading `#` is accepted for the same reason —
    // cheap, and the alternative is silently reading zero targets again.
    expect(targetOf({ ...ROW, duplicateOf: ["1214"] as never })).toEqual({
      reading: "NAMED",
      issues: [1214],
    });
    expect(targetOf({ ...ROW, duplicateOf: ["#1173"] as never })).toEqual({
      reading: "NAMED",
      issues: [1173],
    });
    // And a value that names no issue is still UNOBSERVABLE rather than NaN.
    expect(targetOf({ ...ROW, duplicateOf: ["not-an-issue"] as never }).reading).toBe(
      "UNOBSERVABLE",
    );
  });

  test("FC-3: a row that WAS emitted is not a refusal and is excluded", () => {
    const t = targetOf({ ...ROW, emitted: true, refusal: null });
    expect(t.reading).toBe("UNOBSERVABLE");
    expect(t.reading === "UNOBSERVABLE" && t.why).toContain("not refused");
  });

  // Raised twice in review before it was fixed, and it is this module's
  // header contradicting its own code: the header says `DUPLICATE` is the
  // ONE refusal whose row persists its target, and `targetOf` read
  // `duplicateOf` on any unemitted row.
  //
  // `issue-filing-gate.ts` computes collisions in the dedupe stage before
  // the later stages run, so a finding can collide and then be refused for
  // another reason entirely — leaving a populated `duplicateOf` on a row
  // whose refusal named a completely different target. Following it asks
  // whether somebody commented on an unrelated issue and counts the answer
  // as compliance. The quiet direction: the denominator grows and the rate
  // is measured against the wrong issues.
  test("FC-13: duplicateOf is only a target when the row's own refusal is DUPLICATE", () => {
    for (const refusal of ["OVER_CAP", "NO_CLAIM", "TOO_MANY_FILES", "DROPPED_CATEGORY"]) {
      const t = targetOf({ ...ROW, refusal, duplicateOf: ["1400"] as never });
      expect(t.reading, `${refusal} followed a DUPLICATE row's target`).toBe("UNOBSERVABLE");
      expect(t.reading === "UNOBSERVABLE" && t.why).toContain(refusal);
    }
  });

  // The positive control for FC-13: the same populated `duplicateOf` on a
  // row that IS a DUPLICATE still reads NAMED, so FC-13 is not green
  // because `targetOf` stopped naming anything at all.
  test("FC-14: the same duplicateOf on a DUPLICATE row is still a target", () => {
    expect(targetOf({ ...ROW, refusal: "DUPLICATE", duplicateOf: ["1400"] as never })).toEqual({
      reading: "NAMED",
      issues: [1400],
    });
  });
});

describe("complianceReading", () => {
  test("FC-4: an empty observable population reads null, NOT a rate of zero", async () => {
    const r = await complianceReading({
      rows: [{ ...ROW, refusal: "NO_CLAIM", duplicateOf: [] }],
      lookup: lookupOf({}),
      windowMs: 24 * HOUR,
    });
    expect(r.observable).toBe(0);
    expect(r.unobservable).toBe(1);
    // The assertion this module exists for.
    expect(r.rate).toBeNull();
    expect(r.compliedUpperBound).toBe(0);
  });

  test("FC-5: a lookup that could not read is UNOBSERVABLE, never NOT_OBSERVED", async () => {
    const r = await complianceReading({
      rows: [ROW],
      lookup: async () => ({ reading: "UNMEASURED", why: "the tracker returned 502" }),
      windowMs: 24 * HOUR,
    });
    expect(r.rows[0]?.state).toBe("UNOBSERVABLE");
    expect(r.observable).toBe(0);
    expect(r.rate).toBeNull();
  });

  test("FC-6: a comment inside the window reads COMPLIED", async () => {
    const r = await complianceReading({
      rows: [ROW],
      lookup: lookupOf({ 1400: measured("2026-10-24T13:00:00.000Z") }),
      windowMs: 24 * HOUR,
    });
    expect(r.rows[0]?.state).toBe("COMPLIED");
    expect(r.observable).toBe(1);
    expect(r.compliedUpperBound).toBe(1);
    expect(r.rate).toBe(1);
  });

  test("FC-7: a comment PREDATING the refusal is not compliance with it", async () => {
    const r = await complianceReading({
      rows: [ROW],
      lookup: lookupOf({ 1400: measured("2026-10-24T11:59:59.000Z") }),
      windowMs: 24 * HOUR,
    });
    expect(r.rows[0]?.state).toBe("NOT_OBSERVED");
    expect(r.observable).toBe(1);
    expect(r.rate).toBe(0);
  });

  test("FC-8: a comment after the window closes is not compliance with it", async () => {
    const r = await complianceReading({
      rows: [ROW],
      lookup: lookupOf({ 1400: measured("2026-10-25T12:00:00.001Z") }),
      windowMs: 24 * HOUR,
    });
    expect(r.rows[0]?.state).toBe("NOT_OBSERVED");
    expect(r.rate).toBe(0);
  });

  test("FC-9: the rate's denominator is the OBSERVABLE rows, not every row", async () => {
    const r = await complianceReading({
      rows: [
        ROW,
        { ...ROW, title: "second", duplicateOf: [1401] },
        // Three rows that can never be read, which must not dilute the rate.
        { ...ROW, title: "third", refusal: "NO_CLAIM", duplicateOf: [] },
        { ...ROW, title: "fourth", refusal: "OVER_CAP", duplicateOf: [] },
        { ...ROW, title: "fifth", emitted: true, refusal: null },
      ],
      lookup: lookupOf({
        1400: measured("2026-10-24T13:00:00.000Z"),
        1401: measured(),
      }),
      windowMs: 24 * HOUR,
    });
    expect(r.observable).toBe(2);
    expect(r.unobservable).toBe(3);
    expect(r.compliedUpperBound).toBe(1);
    // 1/2, not 1/5. The cheapest wrong implementation divides by rows.length
    // and reads 0.2 here, which is the number a reader would act on.
    expect(r.rate).toBe(0.5);
  });

  test("FC-10: the reading names the refusals it could not observe at all", async () => {
    const r = await complianceReading({
      rows: [
        { ...ROW, refusal: "OVER_CAP", duplicateOf: [] },
        { ...ROW, refusal: "COMMENT_INSTEAD", duplicateOf: [] },
        { ...ROW, refusal: "COMMENT_INSTEAD", duplicateOf: [] },
      ],
      lookup: lookupOf({}),
      windowMs: 24 * HOUR,
    });
    expect(r.rate).toBeNull();
    expect(r.unobservableByRefusal).toEqual({ OVER_CAP: 1, COMMENT_INSTEAD: 2 });
  });
});

/**
 * SC-893: the lookup reaches GitHub through Octokit, never a `gh` subprocess.
 *
 * `ghIssueComments` spawned `gh api --paginate` until this change, which is
 * the one thing GITHUB-API-MIGRATION-SPEC forbids in `lib/`. The swap must
 * not quietly change what the three readings mean — and the direction that
 * matters is the one this whole module exists to prevent: **a failed request
 * must never degrade into an empty comment list**, because zero comments
 * reads as "nobody complied" and the truth is "we could not see".
 */
describe("FC-12, FC-15..FC-17: the comment lookup, after the Octokit migration", () => {
  const pageClient = (pages: unknown[][]) => {
    const seen: number[] = [];
    return {
      seen,
      client: {
        rest: {
          issues: {
            listComments: async (p: { page?: number }) => {
              seen.push(p.page ?? 1);
              return { data: pages[(p.page ?? 1) - 1] ?? [] };
            },
          },
        },
      } as unknown as Parameters<typeof listIssueComments>[0],
    };
  };

  // FC-15: the pagination the `gh --paginate` flag used to buy us. A busy
  // issue passes 100 comments and a single-page read truncates silently.
  test("FC-15: every page is walked, not just the first", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ created_at: `2026-11-0${1}T00:00:${String(i).padStart(2, "0")}Z` }));
    const { client, seen } = pageClient([full, [{ created_at: "2026-11-02T00:00:00Z" }]]);
    const rows = await listIssueComments(client, "owner/repo", 7);
    expect(rows.length).toBe(101);
    expect(seen).toEqual([1, 2]);
  });

  // FC-16: and it STOPS. A short page is the end; a loop that asks for one
  // more forever is the cheapest wrong spelling of the line above.
  test("FC-16: a short page ends the walk", async () => {
    const { client, seen } = pageClient([[{ created_at: "2026-11-01T00:00:00Z" }]]);
    expect((await listIssueComments(client, "owner/repo", 7)).length).toBe(1);
    expect(seen).toEqual([1]);
  });

  // FC-17: the reading that must not be lost, in BOTH failure positions.
  // Zero comments reads as "nobody complied"; the truth is "we could not
  // see", and the rate those feed is the whole point of the module.
  test("FC-17: a failed request is UNMEASURED, not an empty comment list", async () => {
    const noClient = await ghIssueComments("owner/repo", () => {
      throw new Error("GITHUB_TOKEN environment variable is not set");
    })(7);
    expect(noClient.reading).toBe("UNMEASURED");
    if (noClient.reading === "UNMEASURED") expect(noClient.why).toContain("GITHUB_TOKEN");

    const throwingRequest = await ghIssueComments("owner/repo", () => ({
      rest: {
        issues: {
          listComments: async () => {
            throw new Error("404 Not Found");
          },
        },
      },
    }) as unknown as Parameters<typeof listIssueComments>[0])(7);
    expect(throwingRequest.reading).toBe("UNMEASURED");
    if (throwingRequest.reading === "UNMEASURED") expect(throwingRequest.why).toContain("404");
  });

  // The positive control for FC-17: a working client is MEASURED, so the
  // case above is not green merely because everything returns UNMEASURED.
  test("FC-17b: a client that answers is MEASURED, with the timestamps", async () => {
    const read = await ghIssueComments("owner/repo", () => ({
      rest: { issues: { listComments: async () => ({ data: [{ created_at: "2026-11-03T12:00:00Z" }] }) } },
    }) as unknown as Parameters<typeof listIssueComments>[0])(7);
    expect(read.reading).toBe("MEASURED");
    if (read.reading === "MEASURED") expect(read.comments).toEqual([{ at: "2026-11-03T12:00:00Z" }]);
  });

  // FC-12: no `gh` subprocess survives in the module. Asserted here as well
  // as in the repository-wide census, because this file is where somebody
  // repairing a network problem would reach for one.
  test("FC-12: the module spawns nothing", () => {
    const src = readFileSync(join(import.meta.dir, "..", "lib/filing-compliance.ts"), "utf-8");
    expect(src).not.toContain("spawnSync");
    expect(src).not.toContain("child_process");
  });
});

/**
 * FC-18 and FC-19 assert two claims this file makes ABOUT ITSELF, because both
 * were wrong when a reviewer read them and neither was checkable.
 *
 * Over thirteen rounds the recurring defect here has not been the logic — it
 * has been a sentence about the code that the code falsifies: a mutation table
 * stating a baseline the suite had outgrown, and ids reused for unrelated
 * tests while the commit messages cited them as stable names. Fixing each by
 * hand leaves the next edit free to break it again, so the claims are asserted
 * instead of restated.
 */
/**
 * FC-20..FC-23 — four review findings that are one class, plus the coupling.
 *
 * THE CLASS: a non-success that renders identically to a success. It is the
 * exact thing this module's header forbids ("Every failure is `UNMEASURED`
 * carrying its own sentence"), and it had three live instances while that
 * sentence was written down.
 */
describe("FC-20..FC-23: a non-success must not render as a success", () => {
  test("FC-20: a non-array data page is UNMEASURED, not an empty page", async () => {
    // `Array.isArray(response?.data) ? response.data : []` turned any
    // unexpected payload into a legitimately-empty page. The loop then sees
    // `rows.length < perPage`, returns what it has, and `ghIssueComments`
    // reports MEASURED with zero comments — "nobody commented" when the truth
    // is "we could not tell". FC-17 only ever exercised the two THROWING
    // paths, so nothing covered a call that resolves with the wrong shape.
    const bad = await ghIssueComments("owner/repo", () => ({
      rest: { issues: { listComments: async () => ({ data: { message: "Not Found" } }) } },
    }) as unknown as Parameters<typeof listIssueComments>[0])(7);
    expect(bad.reading).toBe("UNMEASURED");
    if (bad.reading === "UNMEASURED") expect(bad.why).toMatch(/array|shape/i);
  });

  test("FC-21: a refused row with no refusal label is its own bucket, not NOT_REFUSED", async () => {
    // `row.emitted ? NOT_REFUSED : (row.refusal ?? NOT_REFUSED)` put a row
    // that WAS refused but carries `refusal: null` — which the type allows and
    // targetOf's own message anticipates — into the same bucket as a row that
    // was emitted and needed no follow-up. The field exists to attribute the
    // gap, and that conflation is the one attribution it must never make.
    const reading = await complianceReading({
      rows: [{ ...ROW, refusal: null, emitted: false, duplicateOf: [] }],
      lookup: lookupOf({}),
      windowMs: 24 * HOUR,
    });
    const buckets = Object.keys(reading.unobservableByRefusal);
    expect(buckets).not.toContain("NOT_REFUSED");
    expect(buckets.length, `expected one bucket, got ${JSON.stringify(reading.unobservableByRefusal)}`).toBe(1);
  });

  test("FC-25: the bucket key and the UNOBSERVABLE message use the SAME word", async () => {
    // The population half of FC-21, and I missed it: `countUnobservable` was
    // moved to REFUSED_UNLABELLED and `targetOf`'s own message was left on
    // `?? NOT_REFUSED`, so the same row was attributed one way in the count
    // and the other way in the sentence a human reads. Two sites, one
    // vocabulary, and nothing made them agree
    // (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape).
    const row = { ...ROW, refusal: null, emitted: false, duplicateOf: [] };
    const reading = await complianceReading({ rows: [row], lookup: lookupOf({}), windowMs: 24 * HOUR });

    const bucket = Object.keys(reading.unobservableByRefusal)[0]!;
    const first = reading.rows[0];
    // Narrowed rather than cast: if this row ever stops being UNOBSERVABLE
    // the case has lost its subject and should say so, not read "" and pass.
    expect(first?.state).toBe("UNOBSERVABLE");
    const why = first?.state === "UNOBSERVABLE" ? first.why : "";
    expect(
      why.includes(bucket),
      `the count buckets this row as '${bucket}' and the message says '${why}'. ` +
        `A reader cannot reconcile a tally and a sentence that name the same row differently.`,
    ).toBe(true);
  });

  test("FC-22: an emitted row still buckets as NOT_REFUSED", async () => {
    // The positive control for FC-21. Without it, FC-21 passes against a
    // change that simply deletes the NOT_REFUSED bucket entirely, which would
    // lose the distinction in the other direction
    // (`.claude/rules/checks-must-be-able-to-fail.md`, the fifth shape).
    const reading = await complianceReading({
      rows: [{ ...ROW, refusal: null, emitted: true, duplicateOf: [] }],
      lookup: lookupOf({}),
      windowMs: 24 * HOUR,
    });
    expect(Object.keys(reading.unobservableByRefusal)).toEqual(["NOT_REFUSED"]);
  });

  test(
    "FC-24: a server that never short-pages is UNMEASURED, not an infinite loop",
    async () => {
      // `for (let page = 1; ; page++)` terminated only on a short page. A
      // server-side paging bug, a `page` param silently ignored, or a mock
      // that always returns 100 rows makes this await forever and hold the
      // calling process open — and the sibling `listOpenIssues` above takes
      // the opposite tradeoff deliberately, reading one page and reporting
      // `truncated`.
      //
      // THE MOCK HAS ITS OWN FUSE, and that is not belt-and-braces — it is
      // the only reason this case is runnable. The first draft relied on
      // bun's per-test timeout and the suite HUNG instead of going red: a
      // tight await loop is not interrupted by it. A hung suite is not a
      // red row, it is no reading at all.
      //
      // So the mock refuses after FUSE pages. Before the cap existed, the
      // fuse fired and `why` carried the mock's message — red. With the cap,
      // the loop stops on its own well under the fuse, which `calls` asserts:
      // without that the row would pass on a run that only ever hit the fuse.
      const FUSE = 500;
      const full = Array.from({ length: 100 }, () => ({ created_at: "2026-11-01T00:00:00Z" }));
      let calls = 0;
      const read = await ghIssueComments("owner/repo", () => ({
        rest: {
          issues: {
            listComments: async () => {
              calls += 1;
              if (calls > FUSE) throw new Error(`test fuse: ${FUSE} pages requested`);
              return { data: full };
            },
          },
        },
      }) as unknown as Parameters<typeof listIssueComments>[0])(7);

      expect(read.reading).toBe("UNMEASURED");
      if (read.reading === "UNMEASURED") expect(read.why).toMatch(/page/i);
      // The loop stopped itself, not the fuse.
      expect(calls, `the loop ran to the test's own fuse (${calls} pages)`).toBeLessThan(FUSE);
    },
    30_000,
  );

  test("FC-23: the DUPLICATE literal agrees with the filing gate's own vocabulary", () => {
    // `targetOf` gates on the string "DUPLICATE" and nothing tied that to
    // `issue-filing-gate.ts`, which is where the word is minted. A rename
    // there makes every duplicate row read UNOBSERVABLE — no test fails, no
    // type error, just a quietly wrong population the next time somebody
    // reads the production ledger. Asserted as an agreement rather than
    // imported, because the gate is not this module's dependency.
    const gate = readFileSync(join(import.meta.dir, "..", "lib/issue-filing-gate.ts"), "utf-8");
    const self = readFileSync(join(import.meta.dir, "..", "lib/filing-compliance.ts"), "utf-8");

    // TYPED, not bare. The text agreement below catches a rename in the
    // gate; the type annotation catches it at COMPILE time, which is the
    // stronger guard and the one a future editor cannot route around by
    // updating this test. Asserted here so the annotation cannot be dropped
    // back to a bare literal without a red row.
    expect(
      /const DUPLICATE: ArbiterRefusal = "DUPLICATE"/.test(self),
      "DUPLICATE must be typed as ArbiterRefusal so a rename in lib/finding-arbiter.ts " +
        "is a compile error rather than every duplicate row silently reading UNOBSERVABLE.",
    ).toBe(true);
    expect(/import type \{[^}]*ArbiterRefusal/.test(self)).toBe(true);
    expect(
      gate.includes('"DUPLICATE"'),
      "lib/issue-filing-gate.ts no longer spells the refusal \"DUPLICATE\". " +
        "lib/filing-compliance.ts gates targetOf on that exact string, so a rename there " +
        "makes every duplicate row read UNOBSERVABLE silently. Rename BOTH, or give the " +
        "gate an exported constant and import it.",
    ).toBe(true);
  });
});

describe("FC-18..FC-19: this file's claims about itself", () => {
  const SELF = readFileSync(join(import.meta.dir, "filing-compliance.test.ts"), "utf-8");

  test("FC-18: every FC id names exactly one test", () => {
    // FC-9, FC-10 and FC-11 each named two unrelated tests when this was
    // written — the rate-denominator case and a pagination case both answered
    // to "FC-9". The commit messages cite these ids ("FC-11 is the positive
    // control"), so a duplicate makes a citation ambiguous rather than wrong,
    // which is the kind of error nobody notices.
    const ids = [...SELF.matchAll(/test\("(FC-[0-9]+b?)\s*:/g)].map(m => m[1]!);
    const seen = new Map<string, number>();
    for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
    const duplicated = [...seen].filter(([, n]) => n > 1).map(([id, n]) => `${id} x${n}`);

    expect(duplicated, `FC ids used more than once: ${duplicated.join(", ")}`).toEqual([]);
    // Anti-vacuity: a regex that stops matching makes the row above green
    // over an empty list, which is the third shape in
    // `.claude/rules/checks-must-be-able-to-fail.md`.
    expect(ids.length).toBeGreaterThanOrEqual(15);
  });

  test("FC-19: the docblock's baseline count is this suite's real test count", () => {
    // The mutation table's baseline row said "11 pass, 0 fail" against a file
    // that ships 20 tests. A reader takes that row as evidence the battery was
    // run on the shipped suite; it was run on a suite seven tests smaller.
    const actual = [...SELF.matchAll(/^\s*test\(/gm)].length;
    const claimed = /\*\s*Run against this tree, ([0-9]+) tests\./.exec(SELF)?.[1];

    expect(claimed, "the docblock no longer states a baseline count at all").toBeDefined();
    expect(
      Number(claimed),
      `the docblock claims ${claimed} tests and the file has ${actual}. Re-run the ` +
        `baseline and update BOTH the sentence and the table's baseline row — a stale ` +
        `count reads as evidence the battery saw the shipped suite.`,
    ).toBe(actual);

    // And the table's own baseline row must agree with the sentence, or the
    // two halves of the same claim can drift apart again.
    expect(SELF).toContain(`| **baseline** — unmutated | ${actual} pass, 0 fail |`);
  });
});
