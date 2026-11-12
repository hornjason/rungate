/**
 * Covers SC-2739 (SPEC-TO-BOARD-PIPELINE-SPEC.md): an ADR written from the
 * repository's ADR template carries a Decomposition table that
 * `plan-issues --decompose` reads with no refusal.
 *
 * ADR-013 row 6. Until this shipped, the four-step process told an author to
 * "copy this ADR's Decomposition table", so the shape the filing tool reads
 * lived in one accepted ADR and nowhere a new author would look.
 *
 * "Written from the template" is executed here, not described: the template's
 * placeholder cells are filled the way an author fills them, and the result
 * goes through `parseDecompositionPlan` — the parser `plan-issues --decompose`
 * calls — so a template whose table the tool cannot read is red here, not on
 * the first ADR somebody writes from it.
 *
 * The negative control is the template UNFILLED: it must be refused, or a
 * template run through the tool by mistake would file an issue titled with a
 * placeholder.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { plannedTitles } from "../lib/filing-plan";
import { MAX_FILES, parseDecompositionPlan } from "../lib/issue-decomposition";

const TEMPLATE_PATH = join(import.meta.dir, "..", "docs", "adr", "TEMPLATE.md");
const template = readFileSync(TEMPLATE_PATH, "utf-8");

/** The placeholders an author replaces in a Decomposition row, and what this case writes. */
const FILLED: Readonly<Record<string, string>> = {
  "{criterion}": "SC-2739",
  "{outcome}": "The template's table is read by the filing tool",
  "{files}": "docs/adr/TEMPLATE.md, test/adr-template.test.ts",
  "{milestone}": "Pipeline Phase 6 — the board's state is a reading",
  "{blocked-by}": "—",
};

/** The template's Decomposition row — the one line holding the placeholders. */
function placeholderRow(doc: string): string {
  const rows = doc.split("\n").filter(l => l.startsWith("|") && l.includes("{criterion}"));
  expect(rows.length, "the template must carry exactly ONE placeholder row").toBe(1);
  return rows[0]!;
}

function fill(row: string, values: Readonly<Record<string, string>>): string {
  let out = row;
  for (const [k, v] of Object.entries(values)) out = out.split(k).join(v);
  return out;
}

describe("SC-2739: an ADR written from the template decomposes with no refusal", () => {
  test("SC-2739: the template filled the way an author fills it reads MEASURED", () => {
    const row = placeholderRow(template);
    const adr = template.replace(row, fill(row, FILLED));
    const r = parseDecompositionPlan(adr);
    expect(r.unmeasuredReasons, "a filled template must be read with no refusal").toEqual([]);
    expect(r.rejected).toEqual([]);
    expect(r.reading).toBe("MEASURED");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      criterion: "SC-2739",
      outcome: FILLED["{outcome}"],
      files: ["docs/adr/TEMPLATE.md", "test/adr-template.test.ts"],
      milestone: FILLED["{milestone}"],
      blockedBy: [],
    });
  });

  test("SC-2739: a second row blocked by the first resolves — the Blocked by column works", () => {
    const row = placeholderRow(template);
    const second = fill(row, {
      ...FILLED,
      "{criterion}": "SC-2739",
      "{outcome}": "A second row waits for the first one",
      "{blocked-by}": FILLED["{outcome}"]!,
    });
    const adr = template.replace(row, `${fill(row, FILLED)}\n${second}`);
    const r = parseDecompositionPlan(adr);
    expect(r.unmeasuredReasons).toEqual([]);
    expect(r.rows.map(x => x.blockedBy)).toEqual([[], [FILLED["{outcome}"]]]);
  });

  test("SC-2739 CONTROL: the template UNFILLED is refused, never filed", () => {
    const r = parseDecompositionPlan(template);
    expect(r.reading, "a placeholder row must not decompose into an issue").toBe("UNMEASURED");
    expect(r.rows).toEqual([]);
    expect(r.rejected.map(x => x.why).join(" ")).toContain("no criterion id");
  });

  test("SC-2739: every placeholder in the row is one this case fills — no column goes unchecked", () => {
    const tokens = [...placeholderRow(template).matchAll(/\{[a-z-]+\}/g)].map(m => m[0]).sort();
    expect(tokens, "a column added to the template must be filled here, or this case stops covering it").toEqual(
      Object.keys(FILLED).sort(),
    );
  });

  test("SC-2739: the real template authorises no filing — its placeholder is not a planned title", () => {
    // ai-review round 2 of #2008: the filing gate reads every live table under
    // docs/adr/ as an approved plan, so this is asserted against the REAL file
    // and not a hand-typed copy of it.
    expect(plannedTitles(template), "the template's placeholder row must exempt nothing from the cap").toEqual([]);
    // The control: the same file filled in does authorise its outcome.
    const row = placeholderRow(template);
    expect(plannedTitles(template.replace(row, fill(row, FILLED))).map(t => t.title)).toEqual([
      FILLED["{outcome}"],
    ]);
  });

  test("SC-2739: the template states the rules the parser refuses on", () => {
    // An author reads the template, not the parser. Each limit the parser
    // enforces is stated where the author writes the row.
    expect(template).toContain(`${MAX_FILES} files`);
    expect(template).toContain("12 characters");
    expect(template).toMatch(/no comma/i);
    expect(template).toContain("status: proposed");
    expect(template).toContain("doc-type: adr");
    // No date is pre-filled: a stamped date survives into every copy unnoticed.
    expect(template, "the template must not carry a real date").not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
