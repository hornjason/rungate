/**
 * The figures in the ADR-001..006 resolutions, re-derived rather than trusted.
 *
 * Three hand-typed, grep-derived numbers went stale in those documents and
 * each was caught by a separate review round re-running the author's own
 * command by hand: ADR-003 said 25 criteria where the spec has 26; ADR-005
 * said "four files under `lib/`, `scripts/`, `test/` and `gates/`" where
 * three files in two directories cite it; ADR-004 listed #1425 in a scope
 * the document itself excludes.
 *
 * One number at a time is not a fix, because the next sibling edit
 * reintroduces the shape. These cases bind the figures that this repository
 * can measure for itself, so the document and the tree cannot drift apart
 * without something going red.
 *
 * **What is deliberately NOT here.** ADR-004's issue table and ADR-006's
 * six-row table are readings of the GitHub tracker, not of this tree. A
 * test cannot take them without a network call, and a test that silently
 * skips when offline would be the "assertions that hold vacuously" shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`. Those two carry a
 * documented re-run command beside the table instead, and the last case
 * below asserts the command is there — so the untestable half is at least
 * reproducible by hand rather than unfalsifiable.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const ROOT = join(import.meta.dir, "..");
const adr = (name: string) => readFileSync(join(ROOT, "docs/adr", name), "utf-8");

/** Collapse the wrapping so a prose claim can be matched as one sentence. */
const flat = (s: string) => s.replace(/\s+/g, " ");

describe("the ADR resolutions state figures this tree can still prove", () => {
  test("ADR-003's criteria count is the count the pipeline spec actually states", () => {
    const claim = /pipeline spec states (\d+)/.exec(flat(adr("ADR-003-spec-to-tracker-mapping.md")));
    expect(
      claim,
      "ADR-003's Status no longer states a criteria count in the form this case reads. " +
        "Do not delete this assertion to make it pass — the count going unstated is how " +
        "the claim stopped being checkable in the first place.",
    ).not.toBeNull();

    const spec = readFileSync(join(ROOT, "specs/SPEC-TO-BOARD-PIPELINE-SPEC.md"), "utf-8");
    const actual = spec.split("\n").filter(l => /^- \[[ x]\]/.test(l)).length;
    expect(actual, "the spec states no criteria at all, so the comparison is vacuous").toBeGreaterThan(0);

    expect(
      Number(claim![1]),
      `ADR-003 says the pipeline spec states ${claim![1]} criteria; it states ${actual}. ` +
        "Re-derive with: grep -c '^- \\[[ x]\\]' specs/SPEC-TO-BOARD-PIPELINE-SPEC.md",
    ).toBe(actual);
  });

  test("ADR-005 names exactly the files that cite it", () => {
    // Only the claim, not the paragraph retracting the old one. That
    // retraction names `test/organize-project.test.ts` in order to explain
    // that it is NOT a citation, so a reader of the whole section finds four
    // paths where the claim makes three — and a regex over the section would
    // re-import the exact miscount this case exists to prevent.
    const section = adr("ADR-005-backlog-criterion-repair.md").split("## The problem")[0];
    const status = flat(section.split("An earlier draft")[0]);
    const named = [...status.matchAll(/`((?:lib|scripts|gates)\/[\w./-]+\.ts)`/g)].map(m => m[1]);
    expect(
      named.length,
      "ADR-005's Status names no citing files. Its acceptance rests on being read by " +
        "code, so the evidence has to name what reads it.",
    ).toBeGreaterThan(0);

    // Production directories only, and that scope is the claim rather than a
    // convenience: ADR-005's acceptance rests on being read by CODE. `test/`
    // is excluded because the one match there is not a citation —
    // `test/organize-project.test.ts` writes a FIXTURE named
    // `ADR-005-caching.md`, an unrelated document sharing the number — and
    // counting it is exactly how "four files" happened.
    //
    // Matching the bare id, not the full path, because the three cite it
    // both ways: `lib/filing-plan.ts` writes `ADR-005`, the other two write
    // the filename. A path-only match reads 2 and would have made this case
    // disagree with a document that was right.
    const grep = spawnSync(
      "/usr/bin/grep",
      ["-rl", "ADR-005", "lib", "scripts", "gates"],
      { cwd: ROOT, encoding: "utf-8" },
    );
    const citing = grep.stdout.split("\n").filter(Boolean).sort();
    expect(citing.length, "nothing cites ADR-005 by path, so this case proves nothing").toBeGreaterThan(0);

    expect(
      named.slice().sort(),
      "ADR-005's Status and the tree disagree about which files cite it. Re-derive with: " +
        "grep -rl 'ADR-005' lib scripts gates — and READ each match before counting it, " +
        "because a file naming the id is not necessarily a file citing the decision.",
    ).toEqual(citing);
  });

  test("every resolved ADR's status section agrees with its own frontmatter", () => {
    const files = readdirSync(join(ROOT, "docs/adr")).filter(f => /^ADR-00[1-6]-/.test(f)).sort();
    expect(files.length, "the six resolved ADRs were not found").toBe(6);

    const disagreeing = files.filter(f => {
      const body = adr(f);
      const front = /^status:\s*(\S+)/m.exec(body)?.[1];
      const prose = flat(body.split("## Status")[1] ?? "").slice(0, 200).toLowerCase();
      if (!front) return true;
      // `superseded` and `accepted` are the only two outcomes these six took;
      // a third would be unhandled rather than quietly passing.
      if (front === "superseded") return !prose.includes("superseded");
      if (front === "accepted") return !prose.includes("accepted");
      return true;
    });

    expect(
      disagreeing,
      "an ADR's frontmatter `status:` and its `## Status` prose disagree. These are the " +
        "two statements of the fact that replaced the duplicated bold line; they must not " +
        "drift the way that line did.",
    ).toEqual([]);
  });

  test("the two tracker-derived tables carry the command that re-takes them", () => {
    // ADR-004 and ADR-006 assert readings of the GitHub tracker. Nothing here
    // can check those without a network call, so the standard they are held
    // to is reproducibility: a reader must be able to re-run the measurement
    // without reconstructing it. A table with no command is a number nobody
    // can refute, which is the state all three stale figures were in.
    const missing = ["ADR-004-increment-1-issue-plan.md", "ADR-006-machinery-issue-classification.md"]
      .filter(f => !/gh issue view|gh issue list|gh search/.test(adr(f)));

    expect(
      missing,
      "an ADR asserts a reading of the tracker with no command to re-take it. Add the " +
        "`gh` invocation beside the table — these are the claims no test can verify, so " +
        "the command is the only thing standing between them and an unfalsifiable number.",
    ).toEqual([]);
  });
});
