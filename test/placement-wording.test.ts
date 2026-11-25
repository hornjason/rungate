/**
 * #2800: text a user reads does not name a placement table as where a phase is
 * decided.
 *
 * Since ADR-026 a criterion's phase is the `placement:` line beneath it, and
 * an older spec's `### Phase placement` table is still read. Each review round
 * of #2790 found another message, help line or guide still naming the table as
 * the place a phase is decided, and nothing failed when new wording did it
 * again. This reads that text and refuses, by file and line, a sentence naming
 * a placement table unless "older" qualifies that mention: "older" stands
 * before it with nothing between but words of the same noun phrase, as in
 * "an older spec's Phase placement table". An "older" anywhere else in the
 * sentence, or one qualifying another subject ("older tools decide the
 * placement table"), does not count (#2812 review, rounds 1 and 2).
 *
 * It reads the phrase "placement table". A sentence that says only "the
 * table" is not caught: when this was written, every string saying "table" in
 * code that reads a placement was checked by hand, and two were reworded
 * (#2812 review).
 *
 * What it reads:
 * - every string and template literal in `lib/` and `scripts/`, parsed with
 *   TypeScript, so a comment is never read, and a `+` chain of them read as
 *   the one sentence a user sees;
 * - the prose of `docs/guides/`, `.claude/rules/`, `README.md`, `templates/`
 *   and `specs/`, with a spec's criterion blocks left out: criterion text is
 *   Jason's to write, so a criterion naming the table is listed for him and
 *   not reworded here.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import ts from "typescript";

import { parseCriteria } from "../lib/spec-evidence";

const ROOT = join(import.meta.dir, "..");

/** A sentence that names a placement table, once backticks and emphasis are gone. */
const NAMES_TABLE = /placement\W{0,4}table/i;
/** The mark that a mention names the table as the older form. */
const OLDER = /^older$/i;
/**
 * The only words that may stand between "older" and the mention it
 * qualifies: the noun phrase "older spec's Phase placement table" and its
 * shorter forms. A closed list, so a verb or another subject between them
 * breaks the qualification (#2812 review, round 2).
 */
const NOUN_PHRASE = /^(?:spec's|specs'|spec|phase|the)$/i;

/** Whether "older" qualifies a mention whose preceding words are `before`. */
function olderQualifies(before: string[]): boolean {
  const at = before.findLastIndex(w => OLDER.test(w));
  return at >= 0 && before.slice(at + 1).every(w => NOUN_PHRASE.test(w));
}

/** Each sentence of `text` with a placement-table mention that "older" does not qualify. */
export function sentencesNamingTable(text: string): string[] {
  return text
    .replace(/[`*]/g, "")
    .split(/(?<=[.!?])\s+/)
    .filter(s =>
      [...s.matchAll(new RegExp(NAMES_TABLE.source, "gi"))].some(
        m => !olderQualifies(s.slice(0, m.index).trim().split(/\s+/).map(w => w.replace(/[^\w']/g, ""))),
      ),
    )
    .map(s => s.replace(/\s+/g, " ").trim());
}

interface Passage {
  line: number;
  text: string;
}

/**
 * The string and template literals of a TypeScript source, each with its
 * line. Comments are not nodes, so none is read. A `+` chain holding a
 * literal is read as one passage, the sentence a user sees, with `X` where
 * a value goes (#2812 review: a sentence split across two literals was read
 * as two halves, neither naming the table).
 */
export function sourceStrings(path: string, source: string): Passage[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const out: Passage[] = [];
  const at = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const literal = (node: ts.Node): string | null => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    // An interpolation stands for a value, so its place keeps the sentence whole.
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(s => `X${s.literal.text}`).join("");
    return null;
  };
  const plus = (node: ts.Node): node is ts.BinaryExpression =>
    ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;
  const visit = (node: ts.Node): void => {
    if (plus(node) && !plus(node.parent)) {
      const parts: ts.Node[] = [];
      const flatten = (n: ts.Node): void => {
        if (plus(n)) {
          flatten(n.left);
          flatten(n.right);
        } else parts.push(n);
      };
      flatten(node);
      if (parts.some(p => literal(p) !== null)) {
        out.push({ line: at(node), text: parts.map(p => literal(p) ?? "X").join("") });
        for (const p of parts) if (literal(p) === null) visit(p);
        return;
      }
    }
    const text = literal(node);
    if (text !== null) out.push({ line: at(node), text });
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/**
 * The prose paragraphs of a markdown document, each with its first line. A
 * heading or a table row is a paragraph of its own. In a spec, each criterion
 * block is left out, line by line.
 */
export function proseParagraphs(text: string, isSpec: boolean): Passage[] {
  const lines = text.split("\n");
  const blocked = new Set<number>();
  if (isSpec) for (const c of parseCriteria(text)) for (let n = c.line; n <= c.end; n++) blocked.add(n);
  const out: Passage[] = [];
  let open: Passage | null = null;
  const close = () => {
    if (open) out.push(open);
    open = null;
  };
  lines.forEach((raw, i) => {
    const l = blocked.has(i + 1) ? "" : raw;
    if (l.trim() === "") return close();
    if (/^#{1,6} /.test(l) || l.startsWith("|")) {
      close();
      out.push({ line: i + 1, text: l });
      return;
    }
    if (open) open.text += ` ${l}`;
    else open = { line: i + 1, text: l };
  });
  close();
  return out;
}

/** The criteria of a spec that name a placement table: Jason's to reword, not this suite's. */
export function criteriaNamingTable(text: string): string[] {
  const lines = text.split("\n");
  return parseCriteria(text).flatMap(c =>
    sentencesNamingTable(lines.slice(c.line - 1, c.end).join(" ")).length > 0 ? [c.id] : [],
  );
}

function filesUnder(rel: string, ext: string): string[] {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [abs];
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    if (name === "node_modules") continue;
    const p = join(abs, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(relative(ROOT, p), ext));
    else if (name.endsWith(ext)) out.push(p);
  }
  return out;
}

/** Every sentence this tree's user-facing text names a placement table in, as `path:line: sentence`. */
export function placementWordingViolations(): string[] {
  const out: string[] = [];
  for (const f of [...filesUnder("lib", ".ts"), ...filesUnder("scripts", ".ts")]) {
    if (f.endsWith(".test.ts")) continue;
    for (const p of sourceStrings(f, readFileSync(f, "utf-8"))) {
      for (const s of sentencesNamingTable(p.text)) out.push(`${relative(ROOT, f)}:${p.line}: ${s}`);
    }
  }
  for (const target of ["docs/guides", ".claude/rules", "README.md", "templates", "specs"]) {
    for (const f of filesUnder(target, ".md")) {
      const rel = relative(ROOT, f);
      for (const p of proseParagraphs(readFileSync(f, "utf-8"), rel.startsWith("specs/"))) {
        for (const s of sentencesNamingTable(p.text)) out.push(`${rel}:${p.line}: ${s}`);
      }
    }
  }
  return out;
}

/**
 * Sentences kept as they are, each for a reason that is not this suite's to
 * overrule. Matched by file and a phrase of the sentence, since a workflow
 * template's text runs on with no full stop, and each must match exactly one
 * refused sentence. The list only shrinks: an entry that matches none fails
 * too, so it is struck here.
 */
const KEPT: { file: string; phrase: string; why: string }[] = [
  {
    file: "lib/spec-placement.ts",
    phrase: "Derived from the spec's Phase placement table by rungate plan-spec.",
    why: "previousMilestoneBody reproduces the description live milestones carry, byte for byte, so plan-spec recognises and rewrites them (#2797)",
  },
  {
    file: "lib/scaffold/adr-accepted-workflow.ts",
    phrase: "name: Milestones from the engine spec's placement table",
    why: "a generated workflow step name; a workflow edit is Jason's, so it is listed in #2800 for him",
  },
  {
    file: "lib/scaffold/specs-placed-workflow.ts",
    phrase: "give it a # placement table; nothing here names a spec.",
    why: "a comment in a generated workflow; a workflow edit is Jason's, so it is listed in #2800 for him",
  },
  {
    file: "lib/scaffold/specs-placed-workflow.ts",
    phrase: "name: Milestones from each family's placement table",
    why: "a generated workflow step name; a workflow edit is Jason's, so it is listed in #2800 for him",
  },
];

/** The file a `path:line: sentence` violation names, and its sentence. */
const parts = (v: string) => {
  const [file, , ...rest] = v.split(":");
  return { file: file!, sentence: rest.join(":").trim() };
};
const keeps = (k: (typeof KEPT)[number], v: string) => {
  const p = parts(v);
  return p.file === k.file && p.sentence.includes(k.phrase);
};

describe("#2800: user-facing text names a placement table only as the older form", () => {
  test("a planted message naming the table is refused by name; one calling it older is not", () => {
    expect(sentencesNamingTable("UNMEASURED: the spec's Phase placement table could not be read.")).toEqual([
      "UNMEASURED: the spec's Phase placement table could not be read.",
    ]);
    expect(sentencesNamingTable("An older spec's Phase placement table is still read.")).toEqual([]);
    // Backticks and emphasis do not hide it, and only the naming sentence is returned.
    expect(sentencesNamingTable("Run it. Its `### Phase placement` **table** decides. Then stop.")).toEqual([
      "Its ### Phase placement table decides.",
    ]);
    // "older" in another sentence does not mark this one.
    expect(sentencesNamingTable("The older form is gone. The placement table decides.")).toEqual(["The placement table decides."]);
    // Nor does an "older" in the same sentence that does not qualify the table (#2812 review).
    for (const s of [
      "The spec's Phase placement table decides each phase, and older specs are read too.",
      "Each older criterion's phase is set by the Phase placement table.",
      "Older tools decide the placement table.",
    ]) {
      expect(sentencesNamingTable(s), s).toEqual([s]);
    }
    for (const s of [
      "It reads placement lines, or an older spec's Phase placement table.",
      "This spec is placed by the older Phase placement table.",
      "By placement lines or an older placement table.",
    ]) {
      expect(sentencesNamingTable(s), s).toEqual([]);
    }
  });

  test("a planted comment naming the table is not read; a string or template literal is", () => {
    const source = [
      "// the spec's placement table decides the phase",
      "/* the placement table decides */",
      "const a = \"the placement table decides\";",
      "const b = `${x}'s placement table could not be read`;",
      "const c = 'an older placement table is still read';",
      // A sentence split across a + chain is read whole (#2812 review).
      "const d = \"UNMEASURED: the spec's placement \" + \"table could not be read.\";",
      "const e = `${x}: the placement ` + y + \" table decides\";",
    ].join("\n");
    const found = sourceStrings("planted.ts", source).flatMap(p => sentencesNamingTable(p.text).map(s => `${p.line}: ${s}`));
    expect(found).toEqual([
      "3: the placement table decides",
      "4: X's placement table could not be read",
      "6: UNMEASURED: the spec's placement table could not be read.",
    ]);
  });

  test("in a spec, a criterion block is not read as prose, and is listed instead", () => {
    const spec = [
      "# Planted",
      "",
      "- [ ] SC-1: the placement table decides",
      "      placement: Phase 1",
      "Prose after it: the placement table decides.",
      "",
    ].join("\n");
    const prose = proseParagraphs(spec, true).flatMap(p => sentencesNamingTable(p.text).map(s => `${p.line}: ${s}`));
    expect(prose).toEqual(["5: Prose after it: the placement table decides."]);
    expect(criteriaNamingTable(spec)).toEqual(["SC-1"]);
    // Outside specs/, the same lines are all prose.
    expect(proseParagraphs(spec, false).flatMap(p => sentencesNamingTable(p.text))).toHaveLength(1);
  });

  test("the tree's user-facing text names a placement table only as the older form, or is kept for a stated reason", () => {
    const found = placementWordingViolations();
    // The reading is not empty because it read nothing: the kept sentences are in it.
    expect(found.length, "read no sentence at all, so the census is blind").toBeGreaterThanOrEqual(KEPT.length);
    const refused = found.filter(v => !KEPT.some(k => keeps(k, v)));
    expect(
      refused,
      "name the spec's placement in either form, or call the table the older form in the same sentence (#2800)",
    ).toEqual([]);
    const matches = KEPT.map(k => `${k.file}: ${k.phrase} — matched ${found.filter(v => keeps(k, v)).length}`);
    expect(matches, "each kept sentence matches exactly one; strike one that matches none").toEqual(
      KEPT.map(k => `${k.file}: ${k.phrase} — matched 1`),
    );
  });
});
