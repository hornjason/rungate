/**
 * #2800: text a user reads does not name a placement table as where a phase is
 * decided.
 *
 * Since ADR-026 a criterion's phase is the `placement:` line beneath it, and
 * an older spec's `### Phase placement` table is still read. Each review round
 * of #2790 found another message, help line or guide still naming the table as
 * the place a phase is decided, and nothing failed when new wording did it
 * again. This reads that text and refuses, by file and line, a sentence naming
 * a placement table unless the mention is one of four fixed phrases: "older
 * placement table", "older Phase placement table", "older spec's placement
 * table", "older spec's Phase placement table", with only spaces between the
 * words. Rounds 1 to 3 of #2812's review each found a sentence that a looser
 * reading of "older qualifies the table" let through: "older" elsewhere in
 * the sentence, "older" qualifying another subject, then "older" ending an
 * earlier clause ("Older, the placement table decides"). A closed phrase has
 * no reading to loosen.
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
 * - with each interpolated name that is a string constant read as its value:
 *   the file's own top-level `const`, or a named import from a relative
 *   module that exports one. Before #2816 every interpolation read as `X`,
 *   so a message building the heading from `PLACEMENT_HEADING` never showed
 *   the guard the words "Phase placement table";
 * - the prose of `docs/guides/`, `.claude/rules/`, `README.md`, `templates/`
 *   and `specs/`, with a spec's criterion blocks left out: criterion text is
 *   Jason's to write, so a criterion naming the table is listed for him and
 *   not reworded here.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import ts from "typescript";

import { parseCriteria } from "../lib/spec-evidence";

const ROOT = join(import.meta.dir, "..");

/** A sentence that names a placement table, once backticks and emphasis are gone. */
const NAMES_TABLE = /placement\W{0,4}table/i;
/** The four phrases that name the table as the older form, and nothing else does (#2812 review, round 3). */
const OLDER_TABLE = /\bolder (?:spec's )?(?:phase )?placement table/gi;

/** Each sentence of `text` with a placement-table mention that "older" does not qualify. */
export function sentencesNamingTable(text: string): string[] {
  return text
    .replace(/[`*]/g, "")
    .split(/(?<=[.!?])\s+/)
    // A sentence is refused when a mention is left once the older-form phrases are taken out.
    .filter(s => NAMES_TABLE.test(s.replace(/\s+/g, " ").replace(OLDER_TABLE, "")))
    .map(s => s.replace(/\s+/g, " ").trim());
}

interface Passage {
  line: number;
  text: string;
}

/** A string literal's text, through `as const`, `satisfies` and parentheses, or null. */
function stringValue(node: ts.Expression): string | null {
  let n: ts.Expression = node;
  while (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isParenthesizedExpression(n)) n = n.expression;
  return ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : null;
}

/** Each top-level `const NAME = "…"` of a source, by name; only exported ones when asked. */
function topLevelConstants(file: ts.SourceFile, exportedOnly: boolean): Map<string, string> {
  const out = new Map<string, string>();
  for (const st of file.statements) {
    if (!ts.isVariableStatement(st) || !(st.declarationList.flags & ts.NodeFlags.Const)) continue;
    const exported = st.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (exportedOnly && !exported) continue;
    for (const d of st.declarationList.declarations) {
      const value = d.initializer ? stringValue(d.initializer) : null;
      if (ts.isIdentifier(d.name) && value !== null) out.set(d.name.text, value);
    }
  }
  return out;
}

/**
 * The string constants a source can interpolate, by the name it uses there:
 * its own top-level `const NAME = "…"`, each named import from a relative
 * module whose export is one, and `ns.NAME` through a namespace import of one
 * (#2816, #2823 review). A name it cannot resolve, a re-export or a computed
 * value, still reads as `X`.
 */
export function stringConstants(path: string, source: string): Map<string, string> {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const out = topLevelConstants(file, false);
  for (const st of file.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    const named = st.importClause?.namedBindings;
    if (!spec.startsWith(".") || named === undefined) continue;
    const target = resolve(dirname(path), `${spec.replace(/\.(?:ts|js)$/, "")}.ts`);
    if (!existsSync(target)) continue;
    const exported = topLevelConstants(ts.createSourceFile(target, readFileSync(target, "utf-8"), ts.ScriptTarget.Latest, true), true);
    if (ts.isNamespaceImport(named)) {
      for (const [name, value] of exported) out.set(`${named.name.text}.${name}`, value);
      continue;
    }
    for (const el of named.elements) {
      const value = exported.get((el.propertyName ?? el.name).text);
      if (value !== undefined) out.set(el.name.text, value);
    }
  }
  return out;
}

/**
 * The value an interpolated expression holds when it is a known constant:
 * a name, or `ns.NAME` through a namespace import, read through `!`,
 * parentheses, `as` and `satisfies` (#2823 review). Null for any other value.
 */
export function constantValue(node: ts.Node, constants: Map<string, string>): string | null {
  let n: ts.Node = node;
  while (ts.isNonNullExpression(n) || ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) {
    n = n.expression;
  }
  if (ts.isIdentifier(n)) return constants.get(n.text) ?? null;
  if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) return constants.get(`${n.expression.text}.${n.name.text}`) ?? null;
  return null;
}

/**
 * The string and template literals of a TypeScript source, each with its
 * line. Comments are not nodes, so none is read. A `+` chain holding a
 * literal is read as one passage, the sentence a user sees, with `X` where
 * a value goes (#2812 review: a sentence split across two literals was read
 * as two halves, neither naming the table). Parentheses are see-through: a
 * parenthesised literal or sub-chain is part of the sentence, and a template
 * in a chain still has the strings inside its spans read (#2823 review).
 */
export function sourceStrings(path: string, source: string, constants: Map<string, string> = new Map()): Passage[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const out: Passage[] = [];
  const at = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  // A name holding a known string constant reads as its value (#2816); any other value reads as X.
  const value = (node: ts.Node): string | null => constantValue(node, constants);
  const bare = (node: ts.Node): ts.Node => {
    let n = node;
    while (ts.isParenthesizedExpression(n)) n = n.expression;
    return n;
  };
  const literal = (outer: ts.Node): string | null => {
    const node = bare(outer);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    // An interpolation stands for a value, so its place keeps the sentence whole.
    if (ts.isTemplateExpression(node))
      return node.head.text + node.templateSpans.map(s => `${value(s.expression) ?? "X"}${s.literal.text}`).join("");
    return null;
  };
  const plus = (node: ts.Node): node is ts.BinaryExpression =>
    ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;
  const visit = (node: ts.Node): void => {
    // A chain inside parentheses inside another is flattened into the outer one and never visited alone.
    if (plus(node) && !plus(node.parent)) {
      const parts: ts.Node[] = [];
      const flatten = (n: ts.Node): void => {
        const b = bare(n);
        if (plus(b)) {
          flatten(b.left);
          flatten(b.right);
        } else parts.push(n);
      };
      flatten(node);
      if (parts.some(p => literal(p) !== null)) {
        out.push({ line: at(node), text: parts.map(p => literal(p) ?? value(p) ?? "X").join("") });
        for (const p of parts) {
          const b = bare(p);
          if (literal(p) === null) visit(p);
          // A template's own spans can hold strings a user reads.
          else if (ts.isTemplateExpression(b)) for (const span of b.templateSpans) visit(span.expression);
        }
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
    const source = readFileSync(f, "utf-8");
    for (const p of sourceStrings(f, source, stringConstants(f, source))) {
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
      // An "older" that ends an earlier clause (#2812 review, round 3).
      "Older, the placement table decides each criterion's phase.",
      "This is older; the placement table decides.",
      "The older, placement table decides.",
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
      // Parentheses are see-through, and a template in a chain has its spans read (#2823 review).
      "const f = \"UNMEASURED: the spec's placement \" + (\"table could not be read.\");",
      "const g = (\"UNMEASURED: the spec's placement \" + \"table\") + \" could not be read.\";",
      "const h = \"Run: \" + `${ok ? \"the placement table decides\" : \"\"}`;",
    ].join("\n");
    const found = sourceStrings("planted.ts", source).flatMap(p => sentencesNamingTable(p.text).map(s => `${p.line}: ${s}`));
    expect(found).toEqual([
      "3: the placement table decides",
      "4: X's placement table could not be read",
      "6: UNMEASURED: the spec's placement table could not be read.",
      "8: UNMEASURED: the spec's placement table could not be read.",
      "9: UNMEASURED: the spec's placement table could not be read.",
      "10: the placement table decides",
    ]);
  });

  test("#2816: an interpolated string constant is read as its value, whether declared here or imported", () => {
    const at = join(ROOT, "lib", "planted.ts");
    const source = [
      'import { PLACEMENT_HEADING } from "./spec-placement";',
      'import { PLACEMENT_HEADING as H2 } from "./spec-placement.ts";',
      'const OWN = "### Phase placement";',
      "const a = `no \\`${PLACEMENT_HEADING}\\` table lists a criterion`;",
      'const b = "its " + OWN + " table decides";',
      "const c = `the ${H2} table decides`;",
      "const d = `the ${unknown} table decides`;",
      "const e = `an older placement table (${PLACEMENT_HEADING}) is still read`;",
      // Through !, parentheses, as, and a namespace import (#2823 review).
      'import * as sp from "./spec-placement";',
      "const f = `the ${PLACEMENT_HEADING!} table decides`;",
      "const g = `the ${(PLACEMENT_HEADING)} table decides`;",
      "const h = `the ${PLACEMENT_HEADING as string} table decides`;",
      "const i = `the ${sp.PLACEMENT_HEADING} table decides`;",
    ].join("\n");
    const found = sourceStrings(at, source, stringConstants(at, source)).flatMap(p =>
      sentencesNamingTable(p.text).map(s => `${p.line}: ${s}`),
    );
    expect(found).toEqual([
      "4: no ### Phase placement table lists a criterion",
      "5: its ### Phase placement table decides",
      "6: the ### Phase placement table decides",
      "10: the ### Phase placement table decides",
      "11: the ### Phase placement table decides",
      "12: the ### Phase placement table decides",
      "13: the ### Phase placement table decides",
    ]);
    // Without the constants, the same source shows the guard none of them.
    expect(sourceStrings(at, source).flatMap(p => sentencesNamingTable(p.text))).toEqual([]);
  });

  test("#2816: every interpolation of PLACEMENT_HEADING in lib/ and scripts/ resolves, however it is spelled", () => {
    // Read from the syntax, not one spelling of it (#2823 review): each template
    // span or `+` part whose expression mentions the name must resolve.
    const sites: string[] = [];
    const unresolved: string[] = [];
    for (const f of [...filesUnder("lib", ".ts"), ...filesUnder("scripts", ".ts")]) {
      const source = readFileSync(f, "utf-8");
      if (f.endsWith(".test.ts") || !/\bPLACEMENT_HEADING\b/.test(source)) continue;
      const file = ts.createSourceFile(f, source, ts.ScriptTarget.Latest, true);
      const constants = stringConstants(f, source);
      const check = (e: ts.Node) => {
        // A literal, or a nested `+`, is read as text (its own spans are visited); only a value is an interpolation.
        const text = ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isTemplateExpression(e);
        const nested = ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken;
        if (text || nested || !/\bPLACEMENT_HEADING\b/.test(e.getText(file))) return;
        const where = `${relative(ROOT, f)}:${file.getLineAndCharacterOfPosition(e.getStart(file)).line + 1}`;
        sites.push(where);
        if (constantValue(e, constants) === null) unresolved.push(where);
      };
      const visit = (n: ts.Node): void => {
        if (ts.isTemplateSpan(n)) check(n.expression);
        else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
          check(n.left);
          check(n.right);
        }
        ts.forEachChild(n, visit);
      };
      visit(file);
    }
    expect(sites.length, "no interpolation of the heading was found, so this reads nothing").toBeGreaterThanOrEqual(5);
    expect(unresolved).toEqual([]);
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
