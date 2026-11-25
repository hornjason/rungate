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
 * - with each interpolated value read as every text the TypeScript type
 *   checker says it can hold, over one program of `lib/` and `scripts/`.
 *   Before #2816 every interpolation read as `X`, so a message building the
 *   heading from `PLACEMENT_HEADING` never showed the guard the words "Phase
 *   placement table"; #2823's hand-written resolver then missed one more
 *   expression shape each review round, so #2824 hands the question to the
 *   compiler;
 * - and failing closed where it cannot read a value: a string it cannot read,
 *   standing where NAMES_TABLE would read "placement" or "table", is refused
 *   rather than read as `X` (#2823 review, round 4; #2824);
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
  /**
   * A value this guard could not read stands where NAMES_TABLE would read
   * "placement" or "table", so the sentence may name the placement table
   * through a value nobody can see. Refused, not read as `X` and passed: the
   * guard fails closed (#2823 review, round 4). The window is NAMES_TABLE's
   * own, so the two cannot disagree: round 5 found `${H}: table` and
   * `${H} tables` outside the narrower window it replaced (#2824).
   */
  opaqueTable?: true;
}

/** Marks an unread value while a passage is built; shown as `X`. */
const UNRESOLVED = "\u0000";
/** NAMES_TABLE with an unread value in place of either word: where a value could complete the phrase. */
const OPAQUE = ["placement", "table"].map(word => new RegExp(NAMES_TABLE.source.replace(word, UNRESOLVED), NAMES_TABLE.flags));
/** A passage built with UNRESOLVED marks, as the text a reader sees and whether it fails closed. */
function passage(line: number, raw: string): Passage {
  const opaque = OPAQUE.some(r => r.test(raw.replace(/[`*]/g, "")));
  return opaque ? { line, text: raw.replaceAll(UNRESOLVED, "X"), opaqueTable: true } : { line, text: raw.replaceAll(UNRESOLVED, "X") };
}

/**
 * An expression past every wrapper that leaves its value as it is: parentheses,
 * `as`, `satisfies` and `!`. Asked before the type checker, since
 * `PLACEMENT_HEADING as string` is typed `string` and still holds the heading.
 */
function unwrapped(node: ts.Node): ts.Node {
  let n = node;
  while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isNonNullExpression(n)) {
    n = n.expression;
  }
  return n;
}

/** What the guard knows about an interpolated value: the texts it can hold, and whether it is a string at all. */
export interface Reader {
  /** Every text the value can hold, or null when that cannot be told. The caller passes it past its wrappers ({@link unwrapped}). */
  readings(node: ts.Expression): string[] | null;
  /** Whether the value is typed as a string, so a `+` chain of such values is a sentence. */
  isString(node: ts.Expression): boolean;
}

/** A reader that knows no value: every interpolation is unread. */
export const LITERALS_ONLY: Reader = { readings: () => null, isString: () => false };

/** The most texts one value or one sentence is read as; past it, the value is unread (fail closed). */
const MAX_READINGS = 16;

/**
 * The reader the TypeScript type checker gives (#2824). A string, number or
 * boolean literal type reads as its text, and a union of them as each member.
 * A number, bigint, boolean, null or undefined that is not one literal reads
 * as `X`: no such value spells a word. Anything else, a wide `string`, `any`,
 * a template literal type, is unread. The checker follows every import,
 * alias, export list and re-export the compiler does, so no expression shape
 * is modelled here: #2823's rounds 1 to 4 each found one more shape a
 * hand-written resolver missed.
 */
export function checkerReader(checker: ts.TypeChecker): Reader {
  const texts = (t: ts.Type): string[] | null => {
    if (t.isStringLiteral()) return [t.value];
    if (t.isNumberLiteral()) return [String(t.value)];
    if (t.isUnion()) {
      const each = t.types.map(texts);
      if (each.some(r => r === null)) return null;
      const all = [...new Set(each.flat() as string[])];
      return all.length <= MAX_READINGS ? all : null;
    }
    const wordless = ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined;
    return t.flags & wordless ? ["X"] : null;
  };
  const stringy = (t: ts.Type): boolean =>
    t.isUnion() ? t.types.some(stringy) : (t.flags & ts.TypeFlags.StringLike) !== 0;
  return {
    readings: node => texts(checker.getTypeAtLocation(node)),
    isString: node => stringy(checker.getTypeAtLocation(node)),
  };
}

let parsedOptions: ts.CompilerOptions | null = null;
/** The repository's own compiler options, read from its tsconfig.json. */
function compilerOptions(): ts.CompilerOptions {
  if (parsedOptions === null) {
    const config = ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile);
    if (config.error) throw new Error(`tsconfig.json could not be read: ${ts.flattenDiagnosticMessageText(config.error.messageText, "\n")}`);
    parsedOptions = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT).options;
  }
  return parsedOptions;
}

/** One program over `roots`, with each `planted` source read in place of the disk (#2824). */
export function programOf(roots: string[], planted: Map<string, string> = new Map()): ts.Program {
  const options = compilerOptions();
  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = f => planted.get(resolve(f)) ?? readFile(f);
  host.fileExists = f => planted.has(resolve(f)) || fileExists(f);
  host.getSourceFile = (f, language, onError, create) => {
    const text = planted.get(resolve(f));
    return text === undefined ? getSourceFile(f, language, onError, create) : ts.createSourceFile(f, text, language, true);
  };
  return ts.createProgram(roots, options, host);
}

/** Every pair of a reading of `a` followed by one of `b`, or one unread mark past MAX_READINGS. */
function cross(a: string[], b: string[]): string[] {
  if (a.length * b.length > MAX_READINGS) return a.map(x => x + UNRESOLVED);
  return a.flatMap(x => b.map(y => x + y));
}

const isPlus = (node: ts.Node): node is ts.BinaryExpression =>
  ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;
const isLiteralText = (node: ts.Node): boolean => {
  const n = unwrapped(node);
  return ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n);
};

/**
 * The string and template literals of a TypeScript source, each with its
 * line, and each read once for every text its values can hold. Comments are
 * not nodes, so none is read. A `+` chain is read as one passage, the
 * sentence a user sees, when it holds a literal or the checker types it a
 * string: a chain of constants alone is a sentence too (#2823 review, round
 * 6). Parentheses are see-through, and a template in a chain still has the
 * strings inside its spans read (#2823 review).
 */
export function sourceStrings(file: ts.SourceFile, reader: Reader = LITERALS_ONLY): Passage[] {
  const out: Passage[] = [];
  const at = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const textsOf = (outer: ts.Node): string[] => {
    const node = unwrapped(outer);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    if (ts.isTemplateExpression(node)) {
      return node.templateSpans.reduce((acc, s) => cross(cross(acc, textsOf(s.expression)), [s.literal.text]), [node.head.text]);
    }
    if (isPlus(node)) return cross(textsOf(node.left), textsOf(node.right));
    return reader.readings(node as ts.Expression) ?? [UNRESOLVED];
  };
  const push = (node: ts.Node) => {
    for (const text of new Set(textsOf(node))) out.push(passage(at(node), text));
  };
  const visit = (node: ts.Node): void => {
    // A chain inside parentheses inside another is flattened into the outer one and never visited alone.
    if (isPlus(node) && !isPlus(node.parent)) {
      const parts: ts.Node[] = [];
      const flatten = (n: ts.Node): void => {
        const b = unwrapped(n);
        if (isPlus(b)) {
          flatten(b.left);
          flatten(b.right);
        } else parts.push(n);
      };
      flatten(node);
      if (parts.some(isLiteralText) || reader.isString(node)) {
        push(node);
        for (const p of parts) {
          const b = unwrapped(p);
          if (!isLiteralText(p)) visit(p);
          // A template's own spans can hold strings a user reads.
          else if (ts.isTemplateExpression(b)) for (const span of b.templateSpans) visit(span.expression);
        }
        return;
      }
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) push(node);
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

let treeProgramCache: { program: ts.Program; sources: string[] } | null = null;
/** One type-checked program over every non-test source in `lib/` and `scripts/` (#2824). */
function treeProgram(): { program: ts.Program; sources: string[] } {
  if (treeProgramCache === null) {
    const sources = [...filesUnder("lib", ".ts"), ...filesUnder("scripts", ".ts")].filter(f => !f.endsWith(".test.ts"));
    treeProgramCache = { program: programOf(sources), sources };
  }
  return treeProgramCache;
}

/** Every sentence this tree's user-facing text names a placement table in, as `path:line: sentence`. */
export function placementWordingViolations(): string[] {
  const out = new Set<string>();
  const { program, sources } = treeProgram();
  const reader = checkerReader(program.getTypeChecker());
  for (const f of sources) {
    const file = program.getSourceFile(f);
    if (file === undefined) throw new Error(`${relative(ROOT, f)} is not in the program, so its strings were not read`);
    for (const p of sourceStrings(file, reader)) {
      for (const s of sentencesNamingTable(p.text)) out.add(`${relative(ROOT, f)}:${p.line}: ${s}`);
      if (p.opaqueTable) out.add(`${relative(ROOT, f)}:${p.line}: a value this guard cannot read names a table — ${p.text.replace(/\s+/g, " ").trim()}`);
    }
  }
  for (const target of ["docs/guides", ".claude/rules", "README.md", "templates", "specs"]) {
    for (const f of filesUnder(target, ".md")) {
      const rel = relative(ROOT, f);
      for (const p of proseParagraphs(readFileSync(f, "utf-8"), rel.startsWith("specs/"))) {
        for (const s of sentencesNamingTable(p.text)) out.add(`${rel}:${p.line}: ${s}`);
      }
    }
  }
  return [...out];
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
    phrase: "names a table — placement: X",
    why: "renders a criterion's own placement line, `placement: <phase>`; the value is the phase, so it can never be the word table (#2824)",
  },
  {
    file: "lib/spec-placement.ts",
    phrase: "would go with the table, which holds nothing but its placements",
    why: "the value is the heading's own trailing text, quoted after it; the sentence says what conversion would do with that text, never where a phase is decided (#2824)",
  },
  {
    file: "scripts/plan-spec.ts",
    phrase: "names a table — in no placement: X",
    why: "the value is the list of criterion ids no placement names (#2824)",
  },
  {
    file: "lib/surface-lint.ts",
    phrase: "sends the agent to the X table in X, which has no table by that name",
    why: "the table is whatever a rule file cites, read from the finding; the message reports a dangling reference and never says a phase is decided there (#2823 review, round 4)",
  },
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
    const found = sourceStrings(ts.createSourceFile("planted.ts", source, ts.ScriptTarget.Latest, true)).flatMap(p => sentencesNamingTable(p.text).map(s => `${p.line}: ${s}`));
    expect(found).toEqual([
      "3: the placement table decides",
      "4: X's placement table could not be read",
      "6: UNMEASURED: the spec's placement table could not be read.",
      "8: UNMEASURED: the spec's placement table could not be read.",
      "9: UNMEASURED: the spec's placement table could not be read.",
      "10: the placement table decides",
    ]);
  });

  test("#2816, #2824: an interpolated value is read as every text the type checker says it holds", () => {
    const at = join(ROOT, "lib", "planted.ts");
    const again = join(ROOT, "lib", "planted-again.ts");
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
      // An interpolated literal is its text (#2823 review, round 3).
      "const j = `the ${\"placement\"} table decides`;",
      "const k = \"UNMEASURED: the spec's placement \" + (\"table could not be read.\" as string);",
      "const l = \"UNMEASURED: the spec's placement \" + (\"table could not be read.\" satisfies string);",
      // Shapes the hand-written resolver missed, each read through the checker (#2823 rounds 4 to 6, #2824).
      "const H = PLACEMENT_HEADING;",
      "const m = `the ${H} table decides`;",
      'import { AGAIN, LISTED } from "./planted-again";',
      "const n = `the ${AGAIN} table decides`;",
      "const o = `the ${LISTED} table decides`;",
      'const PRE = "the placement "; const POST = "table decides.";',
      "const p = PRE + POST;",
      "declare const ok: boolean;",
      'const q = "the placement " + (ok ? "table decides" : "");',
      "const r = `${H}: table decides`;",
      "const s = `the ${H} tables decide`;",
    ].join("\n");
    const planted = new Map([
      [at, source],
      [again, 'export { PLACEMENT_HEADING as AGAIN } from "./spec-placement";\nconst LOCAL = "### Phase placement";\nexport { LOCAL as LISTED };\n'],
    ]);
    const program = programOf([at], planted);
    const file = program.getSourceFile(at)!;
    const named = (reader: Reader) =>
      sourceStrings(file, reader).flatMap(p => sentencesNamingTable(p.text).map(s => `${p.line}: ${s}`));
    expect(named(checkerReader(program.getTypeChecker()))).toEqual([
      "4: no ### Phase placement table lists a criterion",
      "5: its ### Phase placement table decides",
      "6: the ### Phase placement table decides",
      "10: the ### Phase placement table decides",
      "11: the ### Phase placement table decides",
      "12: the ### Phase placement table decides",
      "13: the ### Phase placement table decides",
      "14: the placement table decides",
      "15: UNMEASURED: the spec's placement table could not be read.",
      "16: UNMEASURED: the spec's placement table could not be read.",
      "18: the ### Phase placement table decides",
      "20: the ### Phase placement table decides",
      "21: the ### Phase placement table decides",
      "23: the placement table decides.",
      "25: the placement table decides",
      "26: ### Phase placement: table decides",
      "27: the ### Phase placement tables decide",
    ]);
    // Without the checker, the same source shows the guard only the sentences built from literals.
    expect(named(LITERALS_ONLY)).toEqual([
      "14: the placement table decides",
      "15: UNMEASURED: the spec's placement table could not be read.",
      "16: UNMEASURED: the spec's placement table could not be read.",
    ]);
  }, 30_000);

  test("#2816, #2824: every interpolation of PLACEMENT_HEADING in lib/ and scripts/ reads as the heading", () => {
    // Selected by the symbol the checker resolves it to, through any alias or
    // export, never by its spelling (#2823 review, #2824).
    const { program, sources } = treeProgram();
    const checker = program.getTypeChecker();
    const reader = checkerReader(checker);
    const home = program.getSourceFile(join(ROOT, "lib", "spec-placement.ts"))!;
    const declared = home.statements
      .filter(ts.isVariableStatement)
      .flatMap(st => st.declarationList.declarations)
      .find(d => ts.isIdentifier(d.name) && d.name.text === "PLACEMENT_HEADING")!;
    const heading = reader.readings(declared.initializer!)!;
    expect(heading).toEqual(["### Phase placement"]);
    const isHeading = (e: ts.Node): boolean => {
      const n = unwrapped(e);
      const at = ts.isPropertyAccessExpression(n) ? n.name : n;
      let sym = checker.getSymbolAtLocation(at);
      if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
      return sym?.declarations?.includes(declared) ?? false;
    };
    const sites: string[] = [];
    const unread: string[] = [];
    for (const f of sources) {
      const file = program.getSourceFile(f)!;
      const check = (e: ts.Expression) => {
        if (!isHeading(e)) return;
        const where = `${relative(ROOT, f)}:${file.getLineAndCharacterOfPosition(e.getStart(file)).line + 1}`;
        sites.push(where);
        if (JSON.stringify(reader.readings(unwrapped(e) as ts.Expression)) !== JSON.stringify(heading)) unread.push(where);
      };
      const visit = (n: ts.Node): void => {
        if (ts.isTemplateSpan(n)) check(n.expression);
        else if (isPlus(n)) {
          check(n.left);
          check(n.right);
        }
        ts.forEachChild(n, visit);
      };
      visit(file);
    }
    expect(sites.length, "no interpolation of the heading was found, so this reads nothing").toBeGreaterThanOrEqual(5);
    // An imported use is among them, so the import alias was followed to the declaration.
    expect(sites.some(s => s.startsWith("scripts/")), sites.join(", ")).toBe(true);
    expect(unread).toEqual([]);
  }, 30_000);

  test("#2823, #2824: a value the guard cannot read, where the phrase would name the table, fails closed", () => {
    const at = join(ROOT, "lib", "planted.ts");
    const source = [
      "declare function other(): string;",
      "declare const name: string;",
      "declare const n: number;",
      "const a = `the ${name} table decides`;",
      'const b = "the " + name + " table decides";',
      // Punctuation, a backquote and a plural, inside NAMES_TABLE's own window (#2823 round 5).
      "const c = `the \\`${other()}\\`: table decides`;",
      "const d = `the ${name} tables decide`;",
      // The value standing for the table after the word placement.
      "const e = `the placement: ${name} decides`;",
      // A number spells no word, so it is read as X and never fails closed.
      "const f = `line ${n}: table rows are read`;",
      // An unread value a word away from either word, or in another sentence, passes.
      "const g = `the ${name} is the table`;",
      "const h = `line ${name}: the phase is read`;",
      "const i = `${name} decided. The table is read.`;",
      // Emphasis around the value does not widen the window: it is stripped, as sentencesNamingTable strips it.
      "const j = `the **\\`${name}\\`**: table decides`;",
    ].join("\n");
    const program = programOf([at], new Map([[at, source]]));
    const passages = sourceStrings(program.getSourceFile(at)!, checkerReader(program.getTypeChecker()));
    expect(passages.filter(p => p.opaqueTable).map(p => p.line)).toEqual([4, 5, 6, 7, 8, 13]);
    expect(passages.find(p => p.line === 4)!.text).toBe("the X table decides");
    expect(passages.find(p => p.line === 9)!.text).toBe("line X: table rows are read");
  }, 30_000);

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
