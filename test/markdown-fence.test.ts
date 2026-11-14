/**
 * #2130: one CommonMark fence reader for every lib/ site that asks "is this
 * line inside a fenced code block".
 *
 * Seven readers answered it four ways. A `~~~` line closed a ``` block, a
 * ```` block closed on its first ``` content line, and a longer close was
 * missed, so a `# heading` or a `Fixes #N` inside an example read as real.
 * Seven readers of one grammar is "two deciders that agree" at N=7
 * (`.claude/rules/checks-must-be-able-to-fail.md`): a behavioural suite only
 * catches the last one to regress. So the census below asserts the property
 * across lib/, and each site has one case through its own entry point.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { inertClosingReferences } from "../lib/closing-reference-audit";
import { plannedTitles } from "../lib/filing-plan";
import { decline } from "../lib/finding-promotion";
import { declaredFiles } from "../lib/issue-file-overlap";
import { headingOccurrencesOf } from "../lib/issue-shape";
import { closesFence, fencedBlocks, fenceOpening, readFences } from "../lib/markdown-fence";
import { sourceFiles } from "../lib/source-census";
import { parseSuccessDoc } from "../lib/success-doc";

const ROOT = join(import.meta.dir, "..");
const lines = (...l: string[]) => l;

describe("#2130: the shared reader follows CommonMark", () => {
  test("``` holding ~~~: the ~~~ line is content, not a close", () => {
    const r = readFences(lines("```", "~~~", "# inside", "```", "# outside"));
    expect(r.roles).toEqual(["fence", "code", "code", "fence", "prose"]);
    expect(r.unclosedAt).toBeNull();
  });

  test("~~~ holding ```: the ``` line is content, not a close", () => {
    const r = readFences(lines("~~~", "```", "# inside", "~~~", "# outside"));
    expect(r.roles).toEqual(["fence", "code", "code", "fence", "prose"]);
  });

  test("```` holding ```: a shorter run does not close", () => {
    const r = readFences(lines("````", "```", "# inside", "````", "# outside"));
    expect(r.roles).toEqual(["fence", "code", "code", "fence", "prose"]);
  });

  test("a longer close closes", () => {
    const r = readFences(lines("```", "# inside", "`````", "# outside"));
    expect(r.roles).toEqual(["fence", "code", "fence", "prose"]);
  });

  test("a close with text after it does not close", () => {
    const r = readFences(lines("```md", "```js", "# inside", "```", "# outside"));
    expect(r.roles).toEqual(["fence", "code", "code", "fence", "prose"]);
  });

  test("an unclosed fence is reported as unclosed, at the line it opened", () => {
    const r = readFences(lines("# before", "```", "# inside", "# still inside"));
    expect(r.unclosedAt, "an unclosed fence must be distinguishable from a closed one").toBe(1);
    expect(r.roles).toEqual(["prose", "fence", "code", "code"]);
  });

  test("an indented fence opens, because a line reader cannot see the list item around it", () => {
    const r = readFences(lines("- item", "    ```", "    # inside", "    ```", "# outside"));
    expect(r.roles).toEqual(["prose", "fence", "code", "fence", "prose"]);
  });

  test("the one-line primitives agree with the reader", () => {
    const open = fenceOpening("  ````ts title");
    expect(open).toEqual({ char: "`", length: 4, info: "ts title", indent: 2 });
    expect(fenceOpening("``not a fence")).toBeNull();
    expect(fenceOpening("prose")).toBeNull();
    expect(closesFence("````", open!)).toBe(true);
    expect(closesFence("``````  ", open!)).toBe(true);
    expect(closesFence("```", open!)).toBe(false);
    expect(closesFence("~~~~", open!)).toBe(false);
    expect(closesFence("```` x", open!)).toBe(false);
  });

  test("fencedBlocks gives each block's character range, an unclosed one running to the end", () => {
    const text = "a\n```\nb\n```\nc\n~~~\nd";
    const blocks = fencedBlocks(text);
    expect(blocks.map(b => text.slice(b.start, b.end))).toEqual(["```\nb\n```", "~~~\nd"]);
  });
});

/**
 * A regex LITERAL whose body tests for a fence marker. That is how every one
 * of the nine readers spelled it. Two shapes are deliberately not matched:
 *
 * - a string literal, which is how the ai-review ledger readers find a
 *   ```` ```json ```` block the tool writes itself, and how
 *   `lib/scaffold/ai-review-step.ts` emits fences into generated scripts;
 * - `lib/prose-self-distance.ts`'s `BLOCK_START`, a string that only says
 *   where a block starts.
 *
 * Both are asserted below, so the detector's reach is a test and not this
 * comment.
 */
const FENCE_REGEX_LITERAL =
  /(?:^|[=(,:!&|?{};]|\breturn)\s*\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])*?(?:```|~~~|`\{3|~\{3)/;

/**
 * Sites still tracking fences themselves. **This list only shrinks.** #2135
 * moves all three and empties it. `lib/derived-spec.ts` is here, not in
 * #2130, because `test/derived-spec-guard.test.ts` requires it to stay
 * import-free for its mutation battery.
 */
const REMAINING = ["lib/cli-commands.ts", "lib/derived-spec.ts", "lib/issue-extraction.ts"];
const OWNER = "lib/markdown-fence.ts";

const codeLines = (src: string) => src.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));

describe("#2130: no other lib/ file tracks a fence itself", () => {
  test("the detector matches every spelling the nine readers used", () => {
    const READERS = [
      "    if (/^\\s*```/.test(line)) fenced = !fenced;",
      "    if (/^\\s*(```|~~~)/.test(line)) {",
      "  return text.replace(/^(```|~~~)[\\s\\S]*?^\\1[^\\n]*$/gm, \"\");",
      "  const fenced = /^[ \\t]*(`{3,}|~{3,})[^\\n]*\\n[\\s\\S]*?^[ \\t]*\\1[ \\t]*$/gm;",
      "  const opener = /^[ \\t]*(`{3,}|~{3,})(.*)$/;",
      "    const fence = /^\\s*(`{3,}|~{3,})(.*)$/.exec(raw);",
      "  if (/^[ \\t]*```/m.test(input.why)) {",
      "      const close = line.match(/^\\s{0,3}(`{3,}|~{3,})\\s*$/);",
      "  const fenced = markdown.match(/```[\\s\\S]*?```/g) ?? [];",
    ];
    for (const l of READERS) expect(FENCE_REGEX_LITERAL.test(l), l).toBe(true);
  });

  test("and none of the shapes that are not fence tracking", () => {
    const NOT = [
      '  const fence = body.indexOf("```json", marker);',
      '  const close = body.indexOf("\\n```", start);',
      '  const fence = "```";',
      'const BLOCK_START = "[-*+][ \\\\t]|#{1,6}[ \\\\t]|[0-9]+[.)][ \\\\t]|[>|]|```|~~~";',
      "  const ratio = total / count; // ```",
    ];
    for (const l of NOT) expect(FENCE_REGEX_LITERAL.test(l), l).toBe(false);
  });

  test("the files that track a fence are the shared reader and the listed remainder, exactly", () => {
    const population = sourceFiles(ROOT, ["lib"]);
    expect(population.length, "the lib/ census came back empty, so this holds vacuously").toBeGreaterThan(100);
    expect(population, "the shared reader itself must be in the population").toContain(OWNER);
    const tracking = population.filter(f =>
      codeLines(readFileSync(join(ROOT, f), "utf-8")).some(l => FENCE_REGEX_LITERAL.test(l)),
    );
    expect(tracking, "the shared reader must match its own detector, or the detector is blind").toContain(OWNER);
    expect(
      tracking.filter(f => f !== OWNER),
      "a lib/ file decides fences itself. Use readFences, fenceOpening or closesFence from " +
        "lib/markdown-fence.ts. If a listed file no longer does, delete it from REMAINING — " +
        "the list only shrinks",
    ).toEqual(REMAINING);
  });
});

describe("#2130: each site, through its own entry point", () => {
  test("issue-shape: a heading inside a ~~~ block is not a heading", () => {
    const body = "intro\n\n~~~\n## Files this will change\n~~~\n";
    expect(headingOccurrencesOf(body, "Files this will change")).toEqual([]);
  });

  test("success-doc: a claim inside ``` holding ~~~ is not a claim", () => {
    const doc = [
      "```markdown",
      "~~~",
      "### Claim 9 — a fenced example of the format",
      "~~~",
      "```",
      "### Claim 1 — the real one",
    ].join("\n");
    expect(parseSuccessDoc(doc).claims.map(c => c.number)).toEqual([1]);
  });

  test("issue-file-overlap: a path inside a ~~~ block is not declared", () => {
    const body = "## Files this will change\n\n~~~\n- `lib/fenced-example.ts`\n~~~\n- `lib/real-one.ts`\n";
    expect(declaredFiles(body)).toEqual(["lib/real-one.ts"]);
  });

  test("closing-reference-audit: a longer close ends the block, so a reference inside it is inert", () => {
    const body = "```\nFixes #11\n````\nFixes #12\n";
    const inert = inertClosingReferences(body);
    expect(inert.map(r => [r.issue, r.reason])).toEqual([[11, "fenced-block"]]);
  });

  test("filing-plan: a table inside ```` holding ``` authorises nothing", () => {
    const plan = ["````", "```", "| Criterion | Outcome |", "|---|---|", "| X-1 | an example |", "````"].join("\n");
    expect(plannedTitles(plan)).toEqual([]);
  });

  test("finding-promotion: a ~~~ line in --why is refused like a ``` one", () => {
    // Every heading reader now sees ~~~ as a fence, so an odd ~~~ in --why
    // would hide every later heading in the issue body from all of them.
    const root = mkdtempSync(join(tmpdir(), "rg-2130-why-"));
    try {
      mkdirSync(join(root, "specs"), { recursive: true });
      writeFileSync(join(root, "specs", "X.md"), "# X\n");
      const issue = { number: 4242, title: "t", body: "No criterion here." };
      const out = decline({ issue, why: "fine\n~~~\nsome text", projectRoot: root });
      expect(out.declined).toBe(false);
      if (out.declined) return;
      expect(out.refusal).toBe("MALFORMED_WHY");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
