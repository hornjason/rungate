/**
 * The dedupe pair table in `lib/finding-arbiter.ts` must equal the output of
 * the script that produces it (#1365).
 *
 * ## Why this test and not a better-worded docblock
 *
 * #1365 is about a table nobody can re-derive. Freezing a corpus and writing
 * a script is half the fix: the other half is that the docblock's copy of the
 * script's output must not be allowed to drift away from it. Without this
 * file, the table becomes a reading someone took once the first time anybody
 * edits the fixture or the constants — which is the original defect, rebuilt
 * one layer up.
 *
 * Measured on this repository the week this was written: of six prose claims
 * in PR #1861, **three of three unbound claims went stale and zero of three
 * bound ones did**. The supported conclusion was "bind the claims you write",
 * and this is that conclusion applied.
 *
 * ## What it does NOT assert
 *
 * That the numbers are *right*. A table can be reproducible and wrong. What
 * it asserts is that the table and the corpus cannot disagree in silence —
 * change a constant, re-freeze the fixture, or edit the docblock by hand, and
 * this goes red naming the diff.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { TABLE_BEGIN, TABLE_END } from "../scripts/print-dedupe-pair-table";

const ROOT = join(import.meta.dir, "..");
const ARBITER = join(ROOT, "lib", "finding-arbiter.ts");
const SCRIPT = join(ROOT, "scripts", "print-dedupe-pair-table.ts");
const FIXTURE = join(ROOT, "test", "fixtures", "finding-dedupe-corpus.json");

/** The text between the markers, or `null` when either marker is absent. */
function between(text: string, begin: string, end: string): string | null {
  const i = text.indexOf(begin);
  if (i < 0) return null;
  const j = text.indexOf(end, i + begin.length);
  if (j < 0) return null;
  return text.slice(i + begin.length, j);
}

/** Strip the ` * ` JSDoc leader a block comment puts on every line. */
function undocblock(text: string): string {
  return text
    .split("\n")
    .map(l => l.replace(/^\s*\* ?/, ""))
    .join("\n");
}

const normalise = (text: string) => text.trim().split("\n").map(l => l.trimEnd()).join("\n");

function run(args: string[]): { out: string; code: number } {
  const p = Bun.spawnSync(["bun", SCRIPT, ...args], { cwd: ROOT });
  return { out: new TextDecoder().decode(p.stdout), code: p.exitCode ?? -1 };
}

describe("the dedupe pair table is a command's output, not a reading (#1365)", () => {
  test("the docblock's table equals the script's stdout", () => {
    const { out, code } = run([]);
    expect(code).toBe(0);

    const fromScript = between(out, TABLE_BEGIN, TABLE_END);
    expect(
      fromScript,
      `scripts/print-dedupe-pair-table.ts printed no ${TABLE_BEGIN} … ${TABLE_END} block. ` +
        `Its stdout was:\n${out.slice(0, 2000)}`,
    ).not.toBeNull();

    const fromDoc = between(readFileSync(ARBITER, "utf8"), TABLE_BEGIN, TABLE_END);
    expect(
      fromDoc,
      `lib/finding-arbiter.ts carries no ${TABLE_BEGIN} … ${TABLE_END} block. The table ` +
        `justifying DUPLICATE_CONTAINMENT_RATIO must be the script's output — paste it back ` +
        `from \`bun scripts/print-dedupe-pair-table.ts\`.`,
    ).not.toBeNull();

    expect(
      normalise(undocblock(fromDoc as string)),
      "The table in lib/finding-arbiter.ts has drifted from the corpus it claims to " +
        "describe. Re-run `bun scripts/print-dedupe-pair-table.ts` and paste its marked " +
        "block back into the docblock. Do NOT hand-edit the table to match — the script " +
        "is the source and the docblock is the copy (#1365).",
    ).toBe(normalise(fromScript as string));
  });

  /**
   * The check must be able to fail, and the two ways it could be vacuous are
   * an empty table on both sides and a table that does not depend on the
   * corpus. Both are closed here.
   */
  test("the table is non-empty and names the shipped cut", () => {
    const fromDoc = undocblock(between(readFileSync(ARBITER, "utf8"), TABLE_BEGIN, TABLE_END) ?? "");
    expect(fromDoc.length).toBeGreaterThan(200);
    expect(fromDoc).toContain("| rule | pairs | which |");
    expect(fromDoc).toContain("containment >= 0.8 (shipped)");
  });

  test("--control moves the table, so the comparison above is not vacuous", () => {
    const base = between(run([]).out, TABLE_BEGIN, TABLE_END) as string;
    const { out, code } = run(["--control"]);
    expect(code).toBe(0);
    const controlled = between(out, TABLE_BEGIN, TABLE_END) as string;

    // A byte-identical clone is contained in its original at 1.000 by
    // construction, so the shipped row MUST gain a pair. If this is equal,
    // the script is not reading the corpus and every row it prints is
    // decoration (`.claude/rules/checks-must-be-able-to-fail.md`).
    expect(
      controlled,
      "--control appended a byte-identical clone of a corpus finding and the table did " +
        "not move. The script is not measuring the fixture.",
    ).not.toBe(base);
    expect(controlled).toContain("-clone");
  });

  test("the fixture records what it is and what it is not", () => {
    const corpus = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
      frozenAt: string;
      note: string;
      findings: Array<{ id: string; title: string; body: string }>;
    };
    // Provenance is in the artefact, not only in the script that wrote it: a
    // reader who opens the fixture must be able to see it is NOT the lost
    // 946-pair corpus without going and finding that out.
    expect(corpus.note).toContain("946-pair");
    expect(corpus.frozenAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(corpus.findings.length).toBeGreaterThan(1);
    for (const f of corpus.findings) {
      expect(f.id, `a corpus entry has no id: ${JSON.stringify(f).slice(0, 120)}`).toMatch(/^\d+$/);
      expect(f.body.length, `#${f.id} was frozen with an empty body`).toBeGreaterThan(0);
    }
  });

  test("the docblock cites the command, so a reader can retake the reading", () => {
    const src = readFileSync(ARBITER, "utf8");
    expect(src).toContain("bun scripts/print-dedupe-pair-table.ts");
    expect(src).toContain("test/fixtures/finding-dedupe-corpus.json");
    // The unrecoverable table must stay marked unrecoverable. Deleting that
    // sentence is the cheapest wrong fix for a docblock that admits a gap.
    expect(src).toContain("not reproducible, and never will be");
  });
});
