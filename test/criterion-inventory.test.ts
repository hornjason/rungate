/**
 * The inventory's one load-bearing property: a pull request that only REWROTE
 * the spec must not read as work on the criteria it names.
 *
 * `docs/research/increment-1-criterion-inventory.md` is the reading, and the
 * distinction below is why it is worth anything. Six of the most-cited pull
 * requests in this repository are revisions of
 * `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` — #1298, #1340, #1360, #1373, #1637
 * and #1640 — and a spec revision names every id in the document by
 * construction. Count those as progress and every criterion in the file reads
 * as started, which is the one direction that reads as good news.
 *
 * `scripts/criterion-inventory.ts` is the IO around this and is not exercised
 * here: it reads a snapshot of the live tracker off disk.
 */

import { describe, expect, test } from "bun:test";
import { localCalendarDay } from "../lib/local-calendar-day";
import { hasContent } from "../lib/spec-evidence";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  CODE_DIRS,
  cell,
  inventoryToday,
  STATES,
  changedCode,
  classify,
  collectTestFiles,
  falseTicks,
  inventory,
  PROVENANCE,
  renderMarkdown,
  snapshotDigest,
  waiverProblem,
  writeSnapshotDir,
  type Snapshot,
  type Tracked,
} from "../scripts/criterion-inventory";

const SCRIPT = join(import.meta.dir, "..", "scripts", "criterion-inventory.ts");

const TODAY = "2026-10-28";

const SPEC = [
  "---",
  "doc-type: spec",
  "evidence: required",
  "---",
  "",
  "- [x] CRC-Z1: the gate refuses an unsigned payload.",
  "      needs: test",
  "      proved-by: test/nothing.test.ts",
  "      fingerprint: deadbeef",
  "- [ ] CRC-Z2: the gate also refuses an expired one.",
  "      needs: test",
  "",
].join("\n");

function pr(number: number, text: string): Tracked {
  return { number, title: text, body: "", state: "MERGED", mergedAt: "2026-10-28T00:00:00Z" };
}

function snapshot(partial: Partial<Snapshot>): Snapshot {
  return { issues: [], prs: [], prChangedCode: {}, ...partial };
}

/**
 * The repository every planted snapshot below is stamped with.
 *
 * Passed as `--repo` by the cases that plant one, so the command's own
 * repository resolution short-circuits and the cache matches. Without it
 * those cases resolve THIS repository from the ambient tree and meet the
 * repo-mismatch refusal instead of the one they are each pointed at —
 * which would be two guards answering one case.
 */
const PLANTED_REPO = "o/r";

/**
 * Re-record the digest after a case deliberately alters a taken snapshot.
 *
 * A case about `prs.json` being absent, or about a truncated reading, must
 * meet the refusal it is pointed at and not the digest one — otherwise two
 * guards answer it and a mutation of either leaves the other holding it up.
 * It uses the command's own {@link snapshotDigest} rather than hashing the
 * files itself, so there is one answer to what the digest covers.
 */
function restamp(dir: string): void {
  const taken = JSON.parse(readFileSync(join(dir, PROVENANCE), "utf-8")) as Record<string, unknown>;
  writeFileSync(join(dir, PROVENANCE), `${JSON.stringify({ ...taken, digest: snapshotDigest(dir) }, null, 2)}\n`);
}

describe("a spec revision is not work on the criteria it names", () => {
  const namesZ2 = [pr(900, "CRC-Z2 is restated")];

  test("a pull request that touched only prose puts the criterion in DOCUMENT ONLY", () => {
    const rows = inventory(SPEC, snapshot({ prs: namesZ2, prChangedCode: { 900: false } }), [], TODAY);
    expect(rows.find(r => r.id === "CRC-Z2")!.state).toBe("DOCUMENT ONLY");
  });

  test("the SAME pull request having touched code puts it in TOUCHED", () => {
    // The control. One variable differs — the changed-file reading — so the
    // row above measured the classification and not the fixture.
    const rows = inventory(SPEC, snapshot({ prs: namesZ2, prChangedCode: { 900: true } }), [], TODAY);
    expect(rows.find(r => r.id === "CRC-Z2")!.state).toBe("TOUCHED");
  });

  test("an unclassified pull request is DOCUMENT ONLY, never TOUCHED", () => {
    // Absent is not false and not true. TOUCHED is the claim that somebody
    // changed code, and a reading nobody took cannot support it — so the
    // unmeasured case falls to the weaker column and the script reports the
    // numbers it could not classify.
    const rows = inventory(SPEC, snapshot({ prs: namesZ2, prChangedCode: {} }), [], TODAY);
    expect(rows.find(r => r.id === "CRC-Z2")!.state).toBe("DOCUMENT ONLY");
  });
});

describe("what counts as changing code", () => {
  test("every directory in the list is recognised, and prose is not", () => {
    // Asserted per directory rather than on a sample: a list of eleven where
    // one entry is misspelled passes any test that only checks `lib/`.
    const missed = CODE_DIRS.filter(d => !changedCode([`${d}/thing.ts`]));
    expect(missed, "these directories must count as code").toEqual([]);
    expect(changedCode(["specs/A-SPEC.md", "docs/research/x.md", "README.md"])).toBe(false);
  });

  test("a prefix that is not a directory boundary does not count", () => {
    // `libretto/` is not `lib/`. Without the trailing slash it would be.
    expect(changedCode(["libretto/x.ts"])).toBe(false);
    expect(changedCode(["lib/x.ts"])).toBe(true);
  });
});

describe("the ladder is ordered, and a stronger reading wins", () => {
  test("a ticked criterion is DONE even when a pull request also names it", () => {
    const rows = inventory(
      SPEC,
      snapshot({ prs: [pr(901, "CRC-Z1 again")], prChangedCode: { 901: true } }),
      [],
      TODAY,
    );
    expect(rows.find(r => r.id === "CRC-Z1")!.state).toBe("DONE");
  });

  test("a test naming an unticked criterion beats any pull request reading", () => {
    const rows = inventory(SPEC, snapshot({ prs: namesNothing(), prChangedCode: {} }), [
      { file: "z2.test.ts", content: "// covers CRC-Z2" },
    ], TODAY);
    expect(rows.find(r => r.id === "CRC-Z2")!.state).toBe("BOUND");
  });

  test("nothing naming it at all is NOT STARTED", () => {
    const rows = inventory(SPEC, snapshot({}), [], TODAY);
    expect(rows.find(r => r.id === "CRC-Z2")!.state).toBe("NOT STARTED");
  });

  test("every state the classifier can return is one this file has exercised", () => {
    // WAIVED is the only state not reachable above, and it is reachable here —
    // so the ladder has no rung nothing has ever been seen on.
    const waived = SPEC.replace(
      "      proved-by: test/nothing.test.ts\n      fingerprint: deadbeef\n",
      "      waived-reason: nobody has run it on the live path\n" +
        "      waived-by: rayford (agent; not countersigned by jason)\n" +
        "      waived-until: 2026-12-31\n",
    );
    const rows = inventory(waived, snapshot({}), [], TODAY);
    expect(rows.find(r => r.id === "CRC-Z1")!.state).toBe("WAIVED");
    expect(new Set(STATES).size).toBe(6);
  });
});

function namesNothing(): Tracked[] {
  return [pr(902, "unrelated")];
}

describe("the match is on a word boundary", () => {
  test("a longer id is not a hit", () => {
    const rows = inventory(
      SPEC,
      snapshot({ prs: [pr(903, "CRC-Z22 is broken")], prChangedCode: { 903: true } }),
      [],
      TODAY,
    );
    expect(rows.find(r => r.id === "CRC-Z2")!.state).toBe("NOT STARTED");
  });
});

describe("a waiver settles a criterion only when it actually stands", () => {
  // All three raised by the required reviewer on #1642. Each is a state
  // `lib/spec-evidence.ts` already calls a violation, and each would have
  // reported here as the most flattering reading available: SETTLED.
  const WAIVER = { reason: "nobody has run it on the live path", by: "rayford", until: "2026-12-31" };

  test("a standing waiver on a ticked criterion settles it", () => {
    // The baseline. Without it every case below could be failing for a reason
    // the case did not introduce.
    expect(waiverProblem({ ticked: true }, WAIVER, TODAY)).toBeNull();
  });

  test("a waiver on an UNTICKED criterion settles nothing", () => {
    // `parseCriteria` records a waiver whenever any `waived-*` field appears,
    // ticked or not, on purpose — "a half-written waiver on an unticked
    // criterion is still a waiver nobody can act on".
    expect(waiverProblem({ ticked: false }, WAIVER, TODAY)).toMatch(/unticked/);
  });

  test("an EXPIRED waiver settles nothing, at the day boundary", () => {
    // The boundary itself is the case worth pinning: expiring TODAY still
    // stands, expiring yesterday does not.
    expect(waiverProblem({ ticked: true }, { ...WAIVER, until: TODAY }, TODAY)).toBeNull();
    expect(waiverProblem({ ticked: true }, { ...WAIVER, until: "2026-10-27" }, TODAY)).toMatch(
      /expired on 2026-10-27/,
    );
  });

  test("an incomplete waiver, and one dated to a day that does not exist", () => {
    expect(waiverProblem({ ticked: true }, { ...WAIVER, by: "  " }, TODAY)).toMatch(/missing: by/);
    expect(waiverProblem({ ticked: true }, { ...WAIVER, until: "2026-02-30" }, TODAY)).toMatch(
      /not a real day/,
    );
  });

  test("a criterion whose waiver does not stand is NOT reported as WAIVED", () => {
    const expired = SPEC.replace(
      "      proved-by: test/nothing.test.ts\n      fingerprint: deadbeef\n",
      "      waived-reason: nobody has run it on the live path\n" +
        "      waived-by: rayford\n" +
        "      waived-until: 2026-01-01\n",
    );
    const [row] = inventory(expired, snapshot({}), [], TODAY);
    expect(row.state).not.toBe("WAIVED");
    // And it must not fall into DONE either — a tick with an expired excuse
    // behind it is the false tick this whole line of work exists to catch.
    expect(row.state).not.toBe("DONE");
    expect(row.waiverProblem).toMatch(/expired/);
  });
});

describe("the test scan reaches every directory under test/", () => {
  // The first draft used a flat `readdirSync`, so the 70 files under
  // `test/unit/`, `test/helpers/` and `test/types/` were invisible and the
  // criteria they bind read as unbound. Raised by the required reviewer on
  // #1642.
  test("it finds a nested test file, and skips fixtures", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-inventory-scan-"));
    try {
      mkdirSync(join(dir, "unit"), { recursive: true });
      mkdirSync(join(dir, "fixtures", "deep"), { recursive: true });
      writeFileSync(join(dir, "top.test.ts"), "// covers CRC-Z2");
      writeFileSync(join(dir, "unit", "nested.test.ts"), "// covers CRC-Z2");
      writeFileSync(join(dir, "fixtures", "deep", "planted.test.ts"), "// covers CRC-Z2");
      writeFileSync(join(dir, "unit", "helper.ts"), "// covers CRC-Z2");

      const found = collectTestFiles(dir).map(f => f.file).sort();
      expect(found).toEqual(["top.test.ts", "unit/nested.test.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a nested test is enough to make a criterion BOUND", () => {
    // The property the flat read broke, asserted end to end rather than only
    // on the walker.
    const [, z2] = inventory(SPEC, snapshot({}), [
      { file: "unit/nested.test.ts", content: "// covers CRC-Z2" },
    ], TODAY);
    expect(z2.state).toBe("BOUND");
  });
});

describe("classify is the single decider", () => {
  test("it reads the fields it is given, with no access to the spec", () => {
    const base = {
      id: "CRC-Z9",
      ticked: false,
      waived: false,
      needs: "test",
      provedBy: null,
      text: "x",
      openIssues: [],
      closedIssues: [],
      mergedPrs: [],
      tests: [],
      waiverProblem: null,
    };
    expect(classify(base, {})).toBe("NOT STARTED");
    expect(classify({ ...base, openIssues: [1] }, {})).toBe("DOCUMENT ONLY");
    expect(classify({ ...base, mergedPrs: [7] }, { 7: true })).toBe("TOUCHED");
    expect(classify({ ...base, tests: ["a.test.ts"] }, {})).toBe("BOUND");
    expect(classify({ ...base, ticked: true, provedBy: "test/x.test.ts" }, {})).toBe("DONE");
    // A tick with no proof behind it is NOT done. It falls through on its
    // other evidence and the script names it as a false tick. Measured on
    // the 2026-10-28 snapshot: 10 ticked, 0 of this shape — the two that
    // look like it, CRC-B7 and CRC-M11, carry standing waivers and reach
    // WAIVED. So this case is a latent hole, not a live one, and an earlier
    // draft of this comment claiming "the two we found today" was wrong.
    expect(classify({ ...base, ticked: true }, {})).toBe("NOT STARTED");
    expect(classify({ ...base, ticked: true, waived: true }, {})).toBe("WAIVED");
  });
});

describe("the committed document names a false tick, not only the console", () => {
  // The console branch reported FALSE TICKS and `renderMarkdown()` had no
  // equivalent, so the document anybody actually reads filed a ticked
  // criterion with nothing behind it under whatever other evidence it had —
  // indistinguishable, in the tables, from an honest row. Raised by the
  // required reviewer on #1642.
  const TICKED_NO_PROOF = [
    "---",
    "doc-type: spec",
    "---",
    "",
    "- [x] CRC-Z3: the tick nobody earned.",
    "      needs: test",
    "",
  ].join("\n");

  const render = (spec: string): string => {
    const rows = inventory(spec, snapshot({}), [], TODAY);
    return renderMarkdown(rows, snapshot({}), [], TODAY);
  };

  test("a ticked criterion with no proof is named in the markdown", () => {
    const md = render(TICKED_NO_PROOF);
    expect(md).toContain("## Ticked, with nothing holding the tick up");
    expect(md).toContain("**CRC-Z3**");
    expect(md).toContain("no proof recorded");
  });

  test("a ticked criterion that DOES name its proof is not", () => {
    // The control. One variable differs — the `proved-by:` line — so the row
    // above measured the false-tick section and not the fact that the
    // heading is printed unconditionally.
    const md = render(TICKED_NO_PROOF.replace("      needs: test", "      needs: test\n      proved-by: test/x.test.ts"));
    expect(md).toContain("## Ticked, with nothing holding the tick up");
    expect(md).toContain("None. Every ticked criterion carries");
    expect(md).not.toContain("no proof recorded");
  });

  test("the document and the console read the same decider", () => {
    // Not two filters that agree: a second copy would survive any mutation of
    // the first and both surfaces would read as covered.
    const rows = inventory(TICKED_NO_PROOF, snapshot({}), [], TODAY);
    expect(falseTicks(rows).map(r => r.id)).toEqual(["CRC-Z3"]);
    expect(falseTicks(inventory(SPEC, snapshot({}), [], TODAY))).toEqual([]);
  });
});

describe("an absent pr-files.jsonl is the first pass, not a failed fetch", () => {
  // The header's own recipe was circular: the file is populated FROM the
  // UNCLASSIFIED numbers this script reports, and the script refused to run
  // until the file existed. Raised by the required reviewer on #1642. Run as
  // a subprocess because the refusal lives in `readSnapshot`, which the
  // recipe reaches only through the command line.
  const run = (dir: string, spec: string) =>
    Bun.spawnSync(["bun", SCRIPT, "--snapshot", dir, "--spec", spec, "--json", "--repo", PLANTED_REPO]);

  // Planted through `writeSnapshotDir`, the command's OWN writer, because
  // SC-2619 refuses a directory it did not write. Spelling `taken.json`
  // here instead would be a second answer to *what a taken snapshot looks
  // like*, free to drift from the fetcher's.
  const plant = (opts: { prs: boolean }): { dir: string; spec: string } => {
    const dir = mkdtempSync(join(tmpdir(), "rg-inventory-snap-"));
    writeSnapshotDir(
      dir,
      {
        issues: [{ number: 1, title: "CRC-Z2 is wrong", body: "", state: "OPEN" }],
        prs: [{ number: 900, title: "CRC-Z2", body: "", state: "MERGED", mergedAt: "2026-10-28T00:00:00Z" }],
        files: {},
      },
      { takenAt: "2026-10-28T00:00:00Z", repo: PLANTED_REPO },
    );
    // Removed AFTER the write, so the provenance record stays and the
    // refusal under test is the one about `prs.json` rather than the one
    // about an unprovenanced directory — and re-stamped, so it is not the
    // digest refusal either. One case, one refusal.
    if (!opts.prs) {
      rmSync(join(dir, "prs.json"));
      restamp(dir);
    }
    const spec = join(dir, "spec.md");
    writeFileSync(spec, SPEC);
    return { dir, spec };
  };

  test("it runs, and reports the merged PR it could not classify", () => {
    const { dir, spec } = plant({ prs: true });
    try {
      const got = run(dir, spec);
      expect(got.exitCode).toBe(0);
      expect(JSON.parse(got.stdout.toString()).unclassified).toEqual([900]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an absent prs.json still refuses", () => {
    // The control, and the reason the relaxation is not a silent default: for
    // the two readings taken in one shot, absent means the fetch failed.
    const { dir, spec } = plant({ prs: false });
    try {
      const got = run(dir, spec);
      expect(got.exitCode).not.toBe(0);
      expect(got.stderr.toString()).toContain("prs.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the expiry comparison is anchored in UTC, like the gate that enforces it", () => {
  // `scripts/audit-spec-evidence.ts` anchors `today` to UTC explicitly and
  // its comment calls itself "the one place the anchoring is decided". This
  // script became a SECOND reader of the same `waived-until` field and
  // anchored it to the runner's zone, so a waiver could be live here and
  // expired there — the #1639 defect reintroduced one file over. Raised by
  // the required reviewer on #1642.

  test("the same instant yields the same day whatever the runner's zone", () => {
    // The real instrument: 02:00Z on the 29th is still the 28th in Los
    // Angeles. A local anchor returns two different days for one instant.
    const instant = new Date("2026-10-29T02:00:00Z");
    expect(inventoryToday(instant)).toBe("2026-10-29");
    // And the control that makes the line above mean something — a LOCAL
    // reading of the same instant genuinely disagrees, so the assertion is
    // not true by construction.
    expect(localCalendarDay(instant, "America/Los_Angeles")).toBe("2026-10-28");
    expect(localCalendarDay(instant, "Pacific/Kiritimati")).toBe("2026-10-29");
  });

  test("a waiver expiring on the UTC day is read as expired in no zone and live in none", () => {
    // The behaviour the drift produced: one waiver, two verdicts.
    const row = { ticked: true };
    const waiver = { reason: "r", by: "b", until: "2026-10-28" };
    const instant = new Date("2026-10-29T02:00:00Z");
    expect(waiverProblem(row, waiver, inventoryToday(instant))).toContain("expired");
    // Under the local anchor this script used to have, the same call said
    // the waiver still stands. That is the disagreement, written down.
    expect(waiverProblem(row, waiver, localCalendarDay(instant, "America/Los_Angeles"))).toBeNull();
  });

  test("two zones 25 hours apart give the script one answer", () => {
    // Spawned, not reasoned about — the same shape SC-2576 uses on the gate.
    const spec = join(mkdtempSync(join(tmpdir(), "rg-inv-tz-")), "s.md");
    writeFileSync(spec, SPEC);
    const dir = mkdtempSync(join(tmpdir(), "rg-inv-tzsnap-"));
    writeSnapshotDir(
      dir,
      {
        issues: [{ number: 1, title: "x", body: "", state: "OPEN" }],
        prs: [{ number: 9, title: "x", body: "", state: "MERGED", mergedAt: "2026-10-28T00:00:00Z" }],
        files: {},
      },
      { takenAt: "2026-10-28T00:00:00Z", repo: PLANTED_REPO },
    );
    try {
      const day = (TZ: string) =>
        JSON.parse(
          Bun.spawnSync(["bun", SCRIPT, "--snapshot", dir, "--spec", spec, "--json", "--repo", PLANTED_REPO], {
            env: { ...process.env, TZ },
          }).stdout.toString(),
        ).taken;
      const east = day("Pacific/Kiritimati");
      const west = day("Pacific/Midway");
      expect(east).toBe(west);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the headline counts ticks, not the buckets ticks land in", () => {
  // `count("DONE") + count("WAIVED")` is not the ticked count: a tick with
  // nothing behind it falls through into another bucket, so the headline
  // called it unstarted work and undercounted the ticks. Third instance of
  // this file's own defect class. Raised by the required reviewer on #1642.
  const FALSE_TICK = [
    "---", "doc-type: spec", "---", "",
    "- [x] CRC-Q1: the tick nobody earned.",
    "      needs: test",
    "- [x] CRC-Q2: this one is real.",
    "      needs: test",
    "      proved-by: test/x.test.ts",
    "",
  ].join("\n");

  test("a false tick is counted as ticked, and named rather than absorbed", () => {
    const rows = inventory(FALSE_TICK, snapshot({}), [], TODAY);
    const md = renderMarkdown(rows, snapshot({}), [], TODAY);
    expect(md).toContain("2 of 2 are ticked");
    expect(md).toContain("**1 have neither**");
    // The bucket arithmetic the headline used to do would have said "1 of 2".
    expect(md).not.toContain("1 of 2 are ticked");
  });

  test("with no false ticks the headline still agrees with the buckets", () => {
    // The control: the fix must not move the honest case.
    const rows = inventory(SPEC, snapshot({}), [], TODAY);
    expect(renderMarkdown(rows, snapshot({}), [], TODAY)).toContain("1 of 2 are ticked");
  });
});

describe("a lone dash is blank, here and in the gate that blocks the build", () => {
  // Fourth instance of this file's defect class, and the one that falsifies
  // my round-5 claim to have closed it: `classify` and `waiverProblem` each
  // decided "is this cell filled in" with `.trim() !== ""`, while
  // `evidenceViolations` — the gate that actually blocks — uses
  // `hasContent`, which treats a lone `-` as blank. So the inventory called
  // a criterion DONE that the gate flags EVIDENCE_BLANK. Both now read
  // `hasContent`. Raised by the required reviewer on #1642.
  const base = {
    id: "CRC-Q9", ticked: true, waived: false, needs: "test", provedBy: null,
    text: "x", openIssues: [], closedIssues: [], mergedPrs: [], tests: [], waiverProblem: null,
  };

  test("`proved-by: -` is not proof", () => {
    expect(classify({ ...base, provedBy: "-" }, {})).not.toBe("DONE");
    expect(classify({ ...base, provedBy: " - " }, {})).not.toBe("DONE");
    // The control: real content still reaches DONE, so the predicate was
    // tightened rather than broken.
    expect(classify({ ...base, provedBy: "test/x.test.ts" }, {})).toBe("DONE");
  });

  test("a waiver field holding a lone dash is incomplete", () => {
    const dash = { reason: "-", by: "rayford", until: "2026-12-31" };
    expect(waiverProblem({ ticked: true }, dash, TODAY)).toContain("reason");
    // Control.
    expect(waiverProblem({ ticked: true }, { ...dash, reason: "because" }, TODAY)).toBeNull();
  });

  test("this file and the blocking gate share one blank decider", () => {
    // Named, so a future third spelling is a visible edit rather than a
    // silent divergence.
    expect(hasContent("-")).toBe(false);
    expect(hasContent("")).toBe(false);
    expect(hasContent(null)).toBe(false);
    expect(hasContent("x")).toBe(true);
  });
});

describe("every free-text cell is escaped, not only the criterion text", () => {
  // `gist()` escaped `|` and `proved-by:`/`needs:` — both free-form
  // annotations a human types — did not. One pipe in a `proved-by:` like
  // `371 pass, 0 fail | re-run 2026-10-28` misaligns every column to its
  // right in the committed document. Raised by the required reviewer
  // on #1642.
  const PIPED = [
    "---", "doc-type: spec", "---", "",
    "- [x] CRC-P1: a pipe | in the criterion text.",
    "      needs: test | measurement",
    "      proved-by: 371 pass, 0 fail | re-run 2026-10-28",
    "",
  ].join("\n");

  test("no rendered row carries an unescaped pipe beyond its own delimiters", () => {
    const rows = inventory(PIPED, snapshot({}), [], TODAY);
    const row = renderMarkdown(rows, snapshot({}), [], TODAY)
      .split("\n")
      .find(l => l.startsWith("| **CRC-P1**"))!;
    // Six cells means six delimiters plus the leading one. An unescaped
    // pipe anywhere in the free text pushes this over.
    expect(row.replace(/\\\|/g, "").split("|")).toHaveLength(8);
    expect(row).toContain("371 pass, 0 fail \\| re-run");
    expect(row).toContain("test \\| measurement");
  });

  test("the escaper is one function, and it handles the empty case", () => {
    expect(cell("a | b")).toBe("a \\| b");
    expect(cell(null)).toBe("");
    expect(cell(" a\n  b ")).toBe("a b");
  });
});

describe("a wrong-shaped snapshot is a failed fetch, not a measurement", () => {
  // The emptiness guard exists so a failed fetch cannot read as an empty
  // tracker — which would report every criterion NOT STARTED, the one
  // direction that reads as good news. Two shapes walked around it:
  // truncated JSON threw an unhandled SyntaxError, and a JSON OBJECT has
  // `length === undefined`, so `undefined === 0` is false and the guard was
  // SILENTLY SKIPPED. Raised by the required reviewer on #1642.
  const ISSUES = JSON.stringify([{ number: 1, title: "x", body: "", state: "OPEN" }]);
  const PRS = JSON.stringify([{ number: 9, title: "x", body: "", state: "MERGED", mergedAt: "2026-10-28T00:00:00Z" }]);

  const run = (issues: string, prs: string) => {
    const dir = mkdtempSync(join(tmpdir(), "rg-inv-shape-"));
    const spec = join(dir, "s.md");
    writeFileSync(spec, SPEC);
    // Taken first, then corrupted: the directory's provenance is real and
    // the shape is what is wrong with it, which is the case being made. A
    // directory with neither would refuse for the other reason and prove
    // nothing about the shape guards.
    writeSnapshotDir(dir, { issues: [], prs: [], files: {} }, { takenAt: "2026-10-28T00:00:00Z", repo: PLANTED_REPO });
    writeFileSync(join(dir, "issues.json"), issues);
    writeFileSync(join(dir, "prs.json"), prs);
    restamp(dir);
    try {
      return Bun.spawnSync(["bun", SCRIPT, "--snapshot", dir, "--spec", spec, "--json", "--repo", PLANTED_REPO]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("truncated JSON refuses by name, not with a SyntaxError", () => {
    const got = run('[{"number":1,', PRS);
    expect(got.exitCode).not.toBe(0);
    expect(got.stderr.toString()).toContain("issues.json is not readable JSON");
  });

  test("a JSON object refuses, naming the shape", () => {
    // The one that slipped the guard rather than throwing — a `gh` error
    // payload redirected into the file.
    const got = run(ISSUES, '{"message":"Not Found","status":"404"}');
    expect(got.exitCode).not.toBe(0);
    expect(got.stderr.toString()).toContain("prs.json parsed to object, not an array");
  });

  test("a valid snapshot is unaffected", () => {
    // The control: the guard was tightened, not turned into a refusal of
    // everything.
    expect(run(ISSUES, PRS).exitCode).toBe(0);
  });
});

/**
 * SC-2619, and item **D1** of the ladder in `project-state.json`.
 *
 * The input directory was assembled by hand, with two `gh` commands copied
 * out of this script's own header and a third appended per pull request. So
 * the number it printed on 2026-10-30 was reproducible by nobody else: there
 * is no way to tell, from the directory or from the output, which tracker it
 * was taken from, when, or whether a line was edited afterwards.
 *
 * Two halves, and both have to hold or the criterion is half-built:
 *
 * - the command takes its own reading when nobody hands it one, and
 * - a directory it did not write is a **refusal naming it**, rather than a
 *   measurement it silently believes.
 *
 * ## Predicted membership, written before the cases ran
 *
 * All four below were predicted RED against the script as it stood, and all
 * four were: the first because a hand-built directory exited 0, and the
 * other three because no `--snapshot` printed usage and refused. The cost
 * was predicted too — the six existing subprocess cases above plant a
 * directory by hand, so every one of them was predicted to flip to the new
 * refusal, and every one did until their planting went through
 * {@link writeSnapshotDir}. They use the command's own writer rather than
 * spelling `taken.json` themselves, so there is one binding for what a
 * taken snapshot looks like and a test cannot drift from the fetcher.
 */
describe("the command takes its own snapshot, and refuses one assembled by hand", () => {
  /**
   * A `gh` that answers from canned files and records what it was asked.
   *
   * A raw string is emitted verbatim, so a case can hand the command a
   * truncated or wrong-shaped payload — the shapes a real `gh` produces on
   * a rate-limited page or an error it does not surface as a non-zero exit.
   */
  const stubGh = (answers: { issues: unknown; prs: unknown }): string => {
    const dir = mkdtempSync(join(tmpdir(), "rg-inv-gh-"));
    const body = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
    writeFileSync(join(dir, "issues.json"), body(answers.issues));
    writeFileSync(join(dir, "prs.json"), body(answers.prs));
    writeFileSync(
      join(dir, "gh"),
      [
        "#!/bin/sh",
        'echo "$@" >> "$RG_STUB/calls.log"',
        'case "$1 $2" in',
        '  "repo view") printf \'{"nameWithOwner":"%s"}\\n\' "${RG_STUB_REPO:-o/r}" ;;',
        '  "issue list") cat "$RG_STUB/issues.json" ;;',
        '  "pr list") cat "$RG_STUB/prs.json" ;;',
        '  "pr view") if [ -n "$RG_STUB_PRVIEW" ]; then echo "$RG_STUB_PRVIEW";',
        '             else printf \'{"number":%s,"files":[{"path":"lib/x.ts"}]}\\n\' "$3"; fi ;;',
        "  *) echo \"stub gh: unexpected $*\" >&2; exit 64 ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    return dir;
  };

  const calls = (stub: string): string[] =>
    existsSync(join(stub, "calls.log"))
      ? readFileSync(join(stub, "calls.log"), "utf-8").split("\n").filter(l => l !== "")
      : [];

  const ISSUES = [{ number: 1, title: "CRC-Z2 is wrong", body: "", state: "OPEN" }];
  const PRS = [{ number: 900, title: "CRC-Z2", body: "", state: "MERGED", mergedAt: "2026-10-28T00:00:00Z" }];

  const run = (args: string[], stub: string | null, asRepo?: string, prView?: string) =>
    Bun.spawnSync(["bun", SCRIPT, ...args], {
      env: {
        ...process.env,
        ...(stub === null ? {} : { RG_STUB: stub, PATH: `${stub}:${process.env.PATH ?? ""}` }),
        ...(asRepo === undefined ? {} : { RG_STUB_REPO: asRepo }),
        ...(prView === undefined ? {} : { RG_STUB_PRVIEW: prView }),
      },
    });

  /** The three expensive readings, as the call log spells them. */
  const READINGS = ["issue list", "pr list", "pr view"];

  /**
   * A project root of its own, not this repository's.
   *
   * `--project-root` matters here beyond tidiness: with the default root the
   * scan reaches THIS file, which spells `CRC-Z2` in the lines above, so the
   * criterion reads BOUND and the pull-request reading it is supposed to
   * demonstrate is outranked by the ladder. A fixture that describes the
   * tree it happens to be running in cannot show what it says it shows.
   */
  const withRoot = (): { dir: string; args: string[] } => {
    const dir = mkdtempSync(join(tmpdir(), "rg-inv-own-"));
    mkdirSync(join(dir, "test"));
    writeFileSync(join(dir, "test", "placeholder.test.ts"), "// names no criterion\n");
    const spec = join(dir, "s.md");
    writeFileSync(spec, SPEC);
    return { dir, args: ["--project-root", dir, "--spec", spec, "--json"] };
  };

  test("a snapshot directory this command did not take is refused, naming it", () => {
    // The defect, stated as a case: two hand-written files and the command
    // believed them. Nothing in the directory says where they came from.
    const { dir, args } = withRoot();
    const snap = join(dir, "snap");
    mkdirSync(snap);
    writeFileSync(join(snap, "issues.json"), JSON.stringify(ISSUES));
    writeFileSync(join(snap, "prs.json"), JSON.stringify(PRS));
    try {
      const got = run(["--snapshot", snap, ...args], null);
      expect(got.exitCode).not.toBe(0);
      expect(got.stderr.toString()).toContain(snap);
      expect(got.stderr.toString()).toContain(PROVENANCE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with no --snapshot the command takes its own reading", () => {
    const stub = stubGh({ issues: ISSUES, prs: PRS });
    const { dir, args } = withRoot();
    try {
      const got = run(args, stub);
      expect(got.stderr.toString()).not.toContain("usage:");
      expect(got.exitCode).toBe(0);
      expect(calls(stub).some(c => c.startsWith("issue list"))).toBe(true);
      expect(calls(stub).some(c => c.startsWith("pr list"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(stub, { recursive: true, force: true });
    }
  });

  test("what it fetched reaches the report, so the fetch is not a no-op that exits 0", () => {
    // Green on the exit code witnesses nothing. #900 is MERGED and names
    // CRC-Z2, so a reading that really happened puts it on that criterion's
    // row — and having fetched its changed files, in CODE_DIRS, as TOUCHED.
    const stub = stubGh({ issues: ISSUES, prs: PRS });
    const { dir, args } = withRoot();
    try {
      const got = run(args, stub);
      expect(got.exitCode).toBe(0);
      const out = JSON.parse(got.stdout.toString());
      const z2 = out.rows.find((r: { id: string }) => r.id === "CRC-Z2");
      expect(z2.mergedPrs).toEqual([900]);
      expect(out.unclassified).toEqual([]);
      expect(z2.state).toBe("TOUCHED");
      expect(calls(stub).some(c => c.startsWith("pr view 900"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(stub, { recursive: true, force: true });
    }
  });

  test("a directory the command wrote is read back, and the second run retakes no reading", () => {
    // The cache half, and the control that `--snapshot` still means
    // something: run one writes the directory, run two reads it and takes
    // none of the three readings again.
    //
    // Not "makes no call at all" any more. Round 2 of review showed the
    // repository comparison declined to answer whenever `--repo` was
    // omitted, which is the ordinary case, so the repository is now
    // RESOLVED on both paths — one cheap identity call on a cache hit. The
    // saving the cache exists for is the sixty-odd readings, and that is
    // what this asserts.
    const stub = stubGh({ issues: ISSUES, prs: PRS });
    const { dir, args } = withRoot();
    const snap = join(dir, "snap");
    try {
      expect(run(["--snapshot", snap, ...args], stub).exitCode).toBe(0);
      expect(existsSync(join(snap, PROVENANCE))).toBe(true);
      const before = calls(stub).length;
      const second = run(["--snapshot", snap, ...args], stub);
      expect(second.exitCode).toBe(0);
      const added = calls(stub).slice(before);
      expect(added.filter(c => READINGS.some(r => c.startsWith(r)))).toEqual([]);
      expect(added.every(c => c.startsWith("repo view"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(stub, { recursive: true, force: true });
    }
  });

  // Three findings from round 1 of review, and the shape they share: the
  // record was written from the first commit and nothing read it back. A
  // provenance nobody consults settles exactly as much as no provenance.

  test("a cache edited after it was taken is refused, not believed", () => {
    // The header claimed `taken.json` answered "whether a line had been
    // edited after the fetch". It did not — the record is untouched by an
    // edit to the readings beside it. Made true rather than narrowed.
    const stub = stubGh({ issues: ISSUES, prs: PRS });
    const { dir, args } = withRoot();
    const snap = join(dir, "snap");
    try {
      expect(run(["--snapshot", snap, ...args], stub).exitCode).toBe(0);
      const edited = JSON.parse(readFileSync(join(snap, "issues.json"), "utf-8")) as { state: string }[];
      edited[0]!.state = "CLOSED";
      writeFileSync(join(snap, "issues.json"), JSON.stringify(edited));
      const got = run(["--snapshot", snap, ...args], stub);
      expect(got.exitCode).not.toBe(0);
      expect(got.stderr.toString()).toContain("have changed since");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(stub, { recursive: true, force: true });
    }
  });

  test("a cache taken for another repository is refused, naming both", () => {
    const stub = stubGh({ issues: ISSUES, prs: PRS });
    const { dir, args } = withRoot();
    const snap = join(dir, "snap");
    try {
      expect(run(["--snapshot", snap, "--repo", "o/one", ...args], stub).exitCode).toBe(0);
      const got = run(["--snapshot", snap, "--repo", "o/two", ...args], stub);
      expect(got.exitCode).not.toBe(0);
      expect(got.stderr.toString()).toContain("o/one");
      expect(got.stderr.toString()).toContain("o/two");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(stub, { recursive: true, force: true });
    }
  });

  test("and it is refused when NEITHER run passed --repo, which is the ordinary case", () => {
    // The first draft compared only when both sides were concrete, so a
    // fetch with the flag omitted stamped `null` and the guard had nothing
    // to compare. Two trees for different repositories sharing one cache
    // directory, neither passing `--repo`, is the everyday shape on this
    // machine — and it was precisely the input the guard could not see.
    // Raised in round 2 of review; the repository is now RESOLVED rather
    // than copied from the flag, so there is no input it declines to
    // answer about.
    const stub = stubGh({ issues: ISSUES, prs: PRS });
    const { dir, args } = withRoot();
    const snap = join(dir, "snap");
    try {
      expect(run(["--snapshot", snap, ...args], stub, "o/one").exitCode).toBe(0);
      expect(JSON.parse(readFileSync(join(snap, PROVENANCE), "utf-8")).repo).toBe("o/one");
      const got = run(["--snapshot", snap, ...args], stub, "o/two");
      expect(got.exitCode).not.toBe(0);
      expect(got.stderr.toString()).toContain("o/one");
      expect(got.stderr.toString()).toContain("o/two");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(stub, { recursive: true, force: true });
    }
  });

  // The live path had NONE of the guards the cache path has carried since
  // #1642, and the asymmetry is the finding: a `gh issue list` that exits 0
  // and returns `[]` — a wrong repository, a rate-limited page, an error gh
  // does not surface — would have reported every criterion NOT STARTED,
  // which is the one direction that reads as good news. Raised in round 3
  // of review. The decisions are now one pair of functions both paths call,
  // so there is nothing for two guards to drift apart about.
  describe.each([
    {
      what: "an empty pull-request list",
      answers: { issues: ISSUES, prs: [] },
      says: "An empty reading is a failed fetch",
    },
    {
      what: "an empty issue list",
      answers: { issues: [], prs: PRS },
      says: "An empty reading is a failed fetch",
    },
    {
      what: "a JSON error object",
      answers: { issues: ISSUES, prs: '{"message":"API rate limit exceeded"}' },
      says: "parsed to object, not an array",
    },
    {
      what: "a truncated page",
      answers: { issues: '[{"number":1,', prs: PRS },
      says: "exited 0 and what it emitted is not readable JSON",
    },
  ])("the live reading refuses $what, like the cache path does", ({ answers, says }) => {
    test("exit non-zero, and the message names what it saw", () => {
      const stub = stubGh(answers);
      const { dir, args } = withRoot();
      try {
        const got = run(args, stub);
        expect(got.exitCode).not.toBe(0);
        expect(got.stderr.toString()).toContain(says);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(stub, { recursive: true, force: true });
      }
    });
  });

  test("a gh call that FAILS is not reported as unreadable output", () => {
    // Round 5. One `try` around the call and the parse reported every
    // failure as "did not emit readable JSON", so an auth failure or a rate
    // limit — gh exiting non-zero with no output at all — sent the reader
    // looking for truncated output. The real stderr was in the
    // parentheses; the framing named the wrong kind of failure.
    //
    // The PAIR is the case. The truncated-page row above asserts the other
    // message against the same command, so a refusal that collapsed them
    // again could not satisfy both.
    const stub = mkdtempSync(join(tmpdir(), "rg-inv-ghfail-"));
    const { dir, args } = withRoot();
    try {
      // `repo view` succeeds, so the run gets past the identity read and
      // the failure lands on the list call this case is about. A gh that
      // fails at the first call is refused by `resolveRepo` with its own
      // message and never reaches the reading at all.
      writeFileSync(
        join(stub, "gh"),
        [
          "#!/bin/sh",
          'if [ "$1 $2" = "repo view" ]; then echo \'{"nameWithOwner":"o/r"}\'; exit 0; fi',
          'echo "gh: HTTP 401 Bad credentials" >&2',
          "exit 1",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const got = Bun.spawnSync(["bun", SCRIPT, ...args], {
        env: { ...process.env, PATH: `${stub}:${process.env.PATH ?? ""}` },
      });
      expect(got.exitCode).not.toBe(0);
      expect(got.stderr.toString()).toContain("failed and produced no reading");
      expect(got.stderr.toString()).toContain("401");
      expect(got.stderr.toString()).not.toContain("not readable JSON");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(stub, { recursive: true, force: true });
    }
  });

  // Round 4, and it is the sweep I said I had done and had not: the SAME
  // direction-that-reads-as-good-news, in the third fetch, one function
  // below the two I had just fixed. `raw.files ?? []` read a missing key as
  // "this pull request touched nothing", so an error payload with a zero
  // exit silently downgraded a criterion from TOUCHED.
  test("a pull-request view that reports no files array is refused, not read as touching nothing", () => {
    const stub = stubGh({ issues: ISSUES, prs: PRS });
    const { dir, args } = withRoot();
    try {
      const got = run(args, stub, undefined, '{"message":"API rate limit exceeded"}');
      expect(got.exitCode).not.toBe(0);
      expect(got.stderr.toString()).toContain("gh pr view 900");
      expect(got.stderr.toString()).toContain("is not one that changed nothing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(stub, { recursive: true, force: true });
    }
  });

  test("and an EMPTY files array is a reading, not a refusal", () => {
    // The control, and the reason the guard is on the key rather than on
    // the count: GitHub really does report a pull request with no changed
    // files, and refusing that would turn a true reading into UNMEASURED.
    const stub = stubGh({ issues: ISSUES, prs: PRS });
    const { dir, args } = withRoot();
    try {
      const got = run(args, stub, undefined, '{"number":900,"files":[]}');
      expect(got.exitCode).toBe(0);
      const z2 = JSON.parse(got.stdout.toString()).rows.find((r: { id: string }) => r.id === "CRC-Z2");
      expect(z2.state).toBe("DOCUMENT ONLY");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(stub, { recursive: true, force: true });
    }
  });

  test("a cache written before the repository was recorded is refused, not waved through", () => {
    // "I cannot tell which repository this is about" is not the same fact
    // as "it is the right one", and only one of them is reportable.
    const stub = stubGh({ issues: ISSUES, prs: PRS });
    const { dir, args } = withRoot();
    const snap = join(dir, "snap");
    try {
      expect(run(["--snapshot", snap, ...args], stub).exitCode).toBe(0);
      const taken = JSON.parse(readFileSync(join(snap, PROVENANCE), "utf-8")) as Record<string, unknown>;
      delete taken.repo;
      writeFileSync(join(snap, PROVENANCE), `${JSON.stringify(taken, null, 2)}\n`);
      const got = run(["--snapshot", snap, ...args], stub);
      expect(got.exitCode).not.toBe(0);
      expect(got.stderr.toString()).toContain("does not say which repository");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(stub, { recursive: true, force: true });
    }
  });

  test("a cache missing a reading refuses in words, not with a stack trace", () => {
    // `readSnapshot` writes careful UNMEASURED sentences and the call site
    // did not catch them, so the one failure whose message was already in
    // hand printed a stack trace instead.
    const stub = stubGh({ issues: ISSUES, prs: PRS });
    const { dir, args } = withRoot();
    const snap = join(dir, "snap");
    try {
      expect(run(["--snapshot", snap, ...args], stub).exitCode).toBe(0);
      rmSync(join(snap, "prs.json"));
      restamp(snap);
      const got = run(["--snapshot", snap, ...args], stub);
      expect(got.exitCode).not.toBe(0);
      expect(got.stderr.toString()).toContain("prs.json is absent");
      // ONE line, and that is the discriminator. Both states exit non-zero
      // and both print the sentence, so asserting either proves nothing:
      // measured against a mutant that rethrows, the uncaught path adds a
      // source listing and five `at …` frames. A first draft of this case
      // asserted the absence of `at <anonymous>`, which the real trace does
      // not contain — it passed under the mutation and witnessed nothing.
      expect(got.stderr.toString().trim().split("\n")).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(stub, { recursive: true, force: true });
    }
  });

  test("the fetch runs in the tree --project-root names, not the process's own", () => {
    // `gh` infers the repository from its working directory when no --repo
    // is given, and --project-root is an independent value — so a caller
    // pointing the spec at one tree while standing in another read a second
    // repository's tracker with nothing saying so. The stub records its own
    // cwd, which is the only thing that can tell the two apart.
    const stub = stubGh({ issues: ISSUES, prs: PRS });
    writeFileSync(
      join(stub, "gh"),
      ["#!/bin/sh", 'pwd >> "$RG_STUB/cwd.log"', 'echo "[]"', ""].join("\n"),
      { mode: 0o755 },
    );
    const { dir, args } = withRoot();
    try {
      // Spawned from THIS repository's directory, pointed at the temp root.
      Bun.spawnSync(["bun", SCRIPT, ...args], {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, RG_STUB: stub, PATH: `${stub}:${process.env.PATH ?? ""}` },
      });
      const seen = readFileSync(join(stub, "cwd.log"), "utf-8").split("\n").filter(l => l !== "");
      expect(seen.length).toBeGreaterThan(0);
      // `realpathSync`, because macOS resolves /var to /private/var and the
      // child reports the resolved form — a raw compare would fail for a
      // reason that has nothing to do with the property.
      expect([...new Set(seen)]).toEqual([realpathSync(dir)]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(stub, { recursive: true, force: true });
    }
  });
});
