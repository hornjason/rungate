/**
 * Every id in the dedupe corpus must be admitted by a sentence that already
 * existed in `lib/finding-arbiter.ts` (#1365, review round 3).
 *
 * ## The finding this was written for
 *
 * Round 3 said: membership is a hand-applied prose rule with no automated
 * check, so a future edit to `CORPUS` passes every test as long as the
 * docblock table is re-pasted from the script's stdout. That was correct, and
 * it is the better half of a finding whose headline half was not — it argued
 * #1187 had no pre-existing pair mention, and `duplicateOverlap`'s header on
 * `origin/main` names #1187 paired with #1175 AND #1176 by number.
 *
 * Arguing that in prose would have settled nothing, because prose is what the
 * finding correctly said was unverifiable. So the rule is executed instead.
 *
 * ## The three properties, and why the third is the one that matters
 *
 * 1. **Total.** Every `CORPUS` id has a `MEMBERSHIP` sentence, and no
 *    `MEMBERSHIP` key is absent from `CORPUS`. A map that silently covers
 *    thirteen of fourteen is the corpus-short-by-one fault again.
 * 2. **Real.** The sentence appears in `lib/finding-arbiter.ts` and names the
 *    id it admits. A citation that does not resolve is not evidence.
 * 3. **Not circular.** The sentence lies OUTSIDE the generated pair table.
 *    Without this, an id could be justified by the table its own membership
 *    produced — which is precisely the defect round 3 alleged, and the only
 *    way to answer the allegation is to make it impossible rather than to
 *    deny it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { CORPUS, MEMBERSHIP } from "../scripts/freeze-dedupe-corpus";
import { TABLE_BEGIN, TABLE_END } from "../scripts/print-dedupe-pair-table";

const ROOT = join(import.meta.dir, "..");
const ARBITER = join(ROOT, "lib", "finding-arbiter.ts");

/**
 * The arbiter as a single line, comment leaders gone and whitespace
 * collapsed, so a citation can be quoted as a sentence rather than as the
 * exact wrapped bytes a reformat would break.
 */
function flatten(source: string): string {
  return source
    .split("\n")
    .map(l => l.replace(/^\s*\*\s?/, "").replace(/^\s*\/\*+\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
}

const raw = readFileSync(ARBITER, "utf8");
const flat = flatten(raw);

/** The generated table, flattened the same way — the region citations may NOT come from. */
function generatedRegion(): string {
  const i = raw.indexOf(TABLE_BEGIN);
  const j = raw.indexOf(TABLE_END, i + TABLE_BEGIN.length);
  expect(i, "lib/finding-arbiter.ts has no generated table block to exclude").toBeGreaterThan(-1);
  return flatten(raw.slice(i, j + TABLE_END.length));
}

describe("every corpus id is admitted by a pre-existing sentence (#1365)", () => {
  test("MEMBERSHIP and CORPUS cover exactly each other", () => {
    const corpus = [...CORPUS].sort();
    const cited = Object.keys(MEMBERSHIP).sort();
    expect(
      cited,
      "Every CORPUS id needs a MEMBERSHIP sentence and every MEMBERSHIP key must be in " +
        "CORPUS. An id with no sentence is one nobody can check; a sentence with no id is " +
        "a justification for a member that was removed.",
    ).toEqual(corpus);
  });

  test("every citation resolves in lib/finding-arbiter.ts", () => {
    const unresolved = Object.entries(MEMBERSHIP)
      .filter(([, quote]) => !flat.includes(flatten(quote)))
      .map(([id, quote]) => `#${id}: ${quote.slice(0, 80)}…`);
    expect(
      unresolved,
      "A MEMBERSHIP sentence must appear in lib/finding-arbiter.ts, with comment leaders " +
        "and whitespace collapsed. If you reworded the docblock, update the citation to " +
        "the new words — do NOT delete the id to make this pass.",
    ).toEqual([]);
  });

  test("every citation names the id it admits", () => {
    const silent = Object.entries(MEMBERSHIP)
      .filter(([id, quote]) => !new RegExp(`\\b${id}\\b`).test(quote))
      .map(([id]) => `#${id}`);
    expect(
      silent,
      "A sentence that does not contain the id is not a citation for it — it is a sentence " +
        "that happens to be nearby.",
    ).toEqual([]);
  });

  test("no citation comes from the table this corpus generates", () => {
    const region = generatedRegion();
    const circular = Object.entries(MEMBERSHIP)
      .filter(([, quote]) => region.includes(flatten(quote)))
      .map(([id]) => `#${id}`);
    expect(
      circular,
      "A corpus member justified by the table its own membership produced is circular. " +
        "Cite a sentence from outside the generated block (#1365, review round 3).",
    ).toEqual([]);
  });

  /**
   * The checks above are only worth their lines if they can fail, and the
   * cheapest way for them to be vacuous is for `flatten` to produce something
   * that matches everything — or nothing. Both directions are pinned here
   * with inputs whose verdicts are known by construction.
   */
  test("the citation check can fail, in both directions", () => {
    const invented = flatten("#9999 and #9998 were measured as a pair at 0.999, which never happened");
    expect(flat.includes(invented)).toBe(false);

    const real = flatten(MEMBERSHIP["1175"] as string);
    expect(real.length).toBeGreaterThan(40);
    expect(flat.includes(real)).toBe(true);

    // And the exclusion is not vacuous either: a line lifted straight out of
    // the generated table must be caught by the circularity check.
    const fromTable = flatten("| containment >= 0.8 (shipped) |");
    expect(generatedRegion().includes(fromTable)).toBe(true);
  });

  /**
   * #1187 is the thinnest admission in the map and the one a reviewer
   * challenged, so its evidence is asserted rather than described. Both
   * facts are read from the tree, not restated from the PR conversation.
   */
  test("#1187's admission is a real pair mention, not the generated table", () => {
    const quote = MEMBERSHIP["1187"] as string;
    expect(flat.includes(flatten(quote))).toBe(true);
    expect(generatedRegion().includes(flatten(quote))).toBe(false);
    // The sentence names #1187 WITH the counterpart the corpus pairs it to.
    expect(quote).toContain("1187");
    expect(quote).toContain("1176");
    // And the escape that would have excluded the pair is documented as
    // partial — "2 false positives of 7" — so surviving pairs are expected.
    expect(flat).toContain("removes 2 false positives of 7");
  });
});
