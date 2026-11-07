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
 * ## THE WHOLE PROPERTY LIST, WRITTEN DOWN ONCE (review round 4)
 *
 * Round 4's standing objection was not to any one gap but to the method:
 * three rounds spent discovering properties one at a time, each patched after
 * a reviewer named it. Fair. So the full set a "declared, not derived" corpus
 * must satisfy is enumerated here and checked in one pass, including the two
 * holes round 4 predicted rather than waiting for a round that finds them.
 *
 * | # | property | why it is not optional |
 * |---|---|---|
 * | 1 | **Total** — every id cited, every citation used | a map covering thirteen of fourteen is corpus-short-by-one again |
 * | 2 | **Real** — the sentence resolves in `lib/finding-arbiter.ts` | a citation that does not resolve is not evidence |
 * | 3 | **Named** — the sentence contains the id it admits | otherwise it is a sentence that happens to be nearby |
 * | 4 | **Not circular** — the sentence lies outside EVERY generated region | an id justified by the table its own membership produced proves nothing |
 * | 5 | **One generated region** — exactly one marker pair exists | property 4 is dodgeable by adding a second generated block it does not know about |
 * | 6 | **Falsifiable** — the checks above redden under planted violations | all five are `toEqual([])`, the shape that passes loudest when it sees nothing |
 *
 * Property 5 is round 4's own hypothetical — *"a CORPUS id whose sentence
 * sits in a third docblock region the circularity check doesn't exclude"* —
 * closed by deriving the excluded regions from the markers and refusing any
 * count but one, rather than by hardcoding the single region that exists
 * today.
 *
 * ## What is NOT checked, stated rather than left to be found
 *
 * **Semantic drift.** Round 4's other hypothetical was a sentence that still
 * resolves but has been edited to mean something different. Nothing here can
 * catch that: byte-equality cannot read meaning, and a hash would only
 * restate property 2 in a form that reddens on a typo fix. It is a real
 * limit of a citation check and it is written down instead of papered over.
 *
 * **Whether the frozen bodies match what the October measurements saw.** Out
 * of reach from inside this change — the tracker has moved — and already
 * recorded as a limit in the arbiter docblock itself.
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

/**
 * EVERY generated region, flattened — the text citations may NOT come from.
 *
 * Derived from the markers rather than from the one block that exists today
 * (property 5). A second generated block added later is excluded
 * automatically, and `countMarkers` refuses the case where somebody adds one
 * without a closing marker.
 */
function generatedRegions(): string[] {
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const i = raw.indexOf(TABLE_BEGIN, at);
    if (i < 0) break;
    const j = raw.indexOf(TABLE_END, i + TABLE_BEGIN.length);
    if (j < 0) break;
    out.push(flatten(raw.slice(i, j + TABLE_END.length)));
    at = j + TABLE_END.length;
  }
  return out;
}

const occurrences = (needle: string) => raw.split(needle).length - 1;
const inAnyGeneratedRegion = (quote: string) =>
  generatedRegions().some(r => r.includes(flatten(quote)));

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

  test("no citation comes from any region this corpus generates", () => {
    const circular = Object.entries(MEMBERSHIP)
      .filter(([, quote]) => inAnyGeneratedRegion(quote))
      .map(([id]) => `#${id}`);
    expect(
      circular,
      "A corpus member justified by the table its own membership produced is circular. " +
        "Cite a sentence from outside every generated block (#1365, review round 3).",
    ).toEqual([]);
  });

  /**
   * Property 5. The check above excludes regions it can SEE, so the way
   * around it is a generated block it cannot — a second marker pair, or a
   * block opened and never closed. Both are refused here rather than left
   * for the round that finds them (#1365, review round 4).
   */
  test("there is exactly one generated region, and it is well formed", () => {
    const begins = occurrences(TABLE_BEGIN);
    const ends = occurrences(TABLE_END);
    expect(
      [begins, ends],
      `lib/finding-arbiter.ts must carry exactly one ${TABLE_BEGIN} … ${TABLE_END} pair. ` +
        "A second generated block, or an unclosed one, is a region the circularity check " +
        "cannot exclude — which is the only way a citation could still be self-justifying.",
    ).toEqual([1, 1]);
    expect(generatedRegions().length).toBe(1);
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
    expect(inAnyGeneratedRegion("| containment >= 0.8 (shipped) |")).toBe(true);
  });

  /**
   * #1187 is the thinnest admission in the map and the one a reviewer
   * challenged, so its evidence is asserted rather than described. Both
   * facts are read from the tree, not restated from the PR conversation.
   */
  test("#1187's admission is a real pair mention, not the generated table", () => {
    const quote = MEMBERSHIP["1187"] as string;
    expect(flat.includes(flatten(quote))).toBe(true);
    expect(inAnyGeneratedRegion(quote)).toBe(false);
    // The sentence names #1187 WITH the counterpart the corpus pairs it to.
    expect(quote).toContain("1187");
    expect(quote).toContain("1176");
    // And the escape that would have excluded the pair is documented as
    // partial — "2 false positives of 7" — so surviving pairs are expected.
    expect(flat).toContain("removes 2 false positives of 7");
  });
});
