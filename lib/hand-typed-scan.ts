/**
 * hand-typed-scan.ts — what in a repository is typed by hand, and so can
 * disagree with the code unseen (ADR-028, SC-2818, #2891).
 *
 * Given the feature names a consumer's manifest registers, it reports three
 * things:
 *
 * - **Quoted lists** in source files that name registered features: an
 *   array literal of quoted strings naming 2 or more distinct registered
 *   features, with 60% or more of its items registered names. A list in a
 *   registered feature's own definition (an object literal whose `name` is
 *   that feature) is declared in code, not typed by hand, and is not
 *   reported. A file a generator wrote, or a test file, is not read.
 * - **Documents** that nothing generates, or that a generator writes and
 *   nothing checks. A generated document is checked when a test's code, not
 *   a comment, names both the document and its generator, each as a whole
 *   name: `build` is not named by `buildAll`.
 * - **Totals** in documents typed by hand that disagree with the registry:
 *   a number followed by a word for the registry's entries, with a word such
 *   as "all" or "total" near it on its line, and no partial count such as
 *   "3 of" beside it. The word is "features" unless the caller passes its
 *   consumer's own, such as "modules". Historical records (ADRs, council and
 *   research documents), and a line that carries a date, are records of a
 *   past moment and are not read for totals.
 *
 * The thresholds are first values measured on the pilot consumer
 * (ADR-028, decision 4), and the report is a report: nothing here refuses.
 *
 * What it reads is what git's index holds, so build output and dependencies
 * are not read, and a file a link points to is read at its own path, never
 * through the link. A file that cannot be read or parsed is named under
 * `unmeasured`; a scan that cannot be taken at all says why instead of
 * returning an empty report, because an empty report reads as nothing typed
 * by hand (SUCCESS.md claim 4).
 */
import { execFileSync } from "child_process";
import { lstatSync, readFileSync } from "fs";
import { join, posix } from "path";
import { parse } from "acorn";

import { type AstNode, walkNodes } from "./ts-ast";

/** A list of quoted names typed into a source file. `line` 0 means the list could not be located in the source for certain. */
export interface HandList {
  file: string;
  line: number;
  items: number;
  /** How many of its items are registered names. */
  registered: number;
  /** The items that name no registered feature, each once, in order. */
  unregistered: string[];
}

export type DocumentClass = "generated-checked" | "generated-only" | "hand";

export interface HandDocument {
  path: string;
  class: DocumentClass;
}

/** A number a document typed by hand gives for the registry, where the registry holds a different number. */
export interface HandTotal {
  path: string;
  line: number;
  says: number;
  text: string;
}

export type HandTypedScan =
  | { measured: false; why: string }
  | {
      measured: true;
      /** How many distinct names the registry holds. */
      registry: number;
      /** The words a total was read with. */
      nouns: string[];
      lists: HandList[];
      documents: HandDocument[];
      totals: HandTotal[];
      /** Each file that could not be read or parsed, as `path: reason`. */
      unmeasured: string[];
    };

export interface HandTypedOptions {
  /** The words a document uses for the registry's entries, as they follow a number. Default: `features`. */
  nouns?: readonly string[];
}

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
/** Read with acorn as written, so positions are the source's own: no types to strip. */
const PLAIN_JS = /\.(js|mjs|cjs)$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_DIRS = new Set(["test", "tests", "__tests__"]);
/** Not documents of the project as it is: historical and archived records. */
const UNLISTED_DOCS = ["reference/", "docs/archive/"];
/** Records of what was decided or found at the time; a count in them is history, not a claim about now. */
const HISTORICAL_DOCS = ["docs/adr/", "docs/council/", "docs/research/"];
/** How many lines from the top a comment or prose marker may sit. A frontmatter key may sit anywhere in the frontmatter. */
const MARKER_LINES = 15;
/** A generator's file name, as a marker writes it: its stem, before a script's extension. */
const GENERATOR = /(?<![\w.-])([\w-][\w.-]*?)\.(?:[cm]?[jt]sx?|py|sh|rb|go|pl)(?![\w-])/;
/** At least this many distinct registered names, and at least LIST_SHARE of all items registered, make a list count (ADR-028, decision 4). */
const LIST_MIN = 2;
const LIST_SHARE = { num: 3, den: 5 };
/** A total's cue word must sit within this many characters before, or after, the number, on its line. */
const CUE_BEFORE = 90;
const CUE_AFTER = 40;
/** A line carrying a date records that date: a count on it is history, not a claim about now. */
const DATED = /(?<![\p{N}])\d{4}-\d{2}-\d{2}(?![\p{N}])/u;

const PARSE_OPTIONS = {
  ecmaVersion: "latest",
  sourceType: "module",
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowHashBang: true,
} as const;

const nfc = (s: string) => s.normalize("NFC");

/** A test file, or a file in a test folder. One decider: what is not scanned for lists is what is read as tests. */
export function isTestPath(rel: string): boolean {
  return TEST_FILE.test(rel) || rel.split("/").slice(0, -1).some(d => TEST_DIRS.has(d));
}

/**
 * Whether a generator's marker sits near the top of a file, and the
 * generator's name when the marker gives one. A document marks itself with a
 * `generated-by:`, `generator:` or `generated-sha:` key or `status:
 * generated` in its frontmatter, an HTML comment saying so, or a "Generated
 * by `…`. Do not edit by hand." line. A key outside the frontmatter, in a
 * code fence or in prose, is an example of one, not a marker. A source file
 * marks itself with a comment holding `@generated`, or saying both that it
 * was generated and not to edit it: a source comment that says only one of
 * them is as often prose about something else ("regenerated by hand", "do
 * not edit them directly"), which was every such hit in two real trees. `*`
 * is a list bullet in a document, never a comment.
 */
export function generatedMarker(text: string, kind: "doc" | "source"): { generated: boolean; generator: string | null } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const close = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  const frontmatter = close > 0 ? lines.slice(1, close) : [];
  const comment = kind === "doc" ? /^\s*<!--/ : /^\s*(\/\/|\/\*|\*)/;
  const made = /(?<![\p{L}])(auto-generated|generated[- ]by)(?![\p{L}])/iu;
  const dontEdit = /do not edit/i;
  const said = (line: string) =>
    kind === "doc" ? made.test(line) || dontEdit.test(line) || /@generated/.test(line) : /@generated/.test(line) || (made.test(line) && dontEdit.test(line));
  let generated = false;
  let generator: string | null = null;
  const name = (text: string | undefined) => (generator ??= text?.match(GENERATOR)?.[1] ?? null);
  for (const line of frontmatter) {
    const key = line.match(/^(generated-by|generator|generated-sha):\s*(.*)$/);
    if (key || /^status:\s*generated\b/.test(line)) generated = true;
    if (key && key[1] !== "generated-sha") name(key[2]);
  }
  for (const line of lines.slice(0, MARKER_LINES)) {
    const prose = line.match(/^Generated by `([^`]+)`.*Do not edit by hand/);
    if (prose || (comment.test(line) && said(line))) generated = true;
    // A generator is also named by the prose line, or by a key written inside a comment.
    name(prose?.[1] ?? (comment.test(line) ? line.match(/(?:generated-by|generator):\s*(.*)$/)?.[1] : undefined));
  }
  return { generated, generator };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");

/** Whether `code` names `token` as a whole name: not as part of a longer one. */
const namesWhole = (code: string, token: string) => new RegExp(String.raw`(?<![\w.-])${escape(token)}(?![\w-])`).test(code);

/** The class of a document: generated and checked by a test, generated with nothing checking it, or typed by hand. */
function documentClass(rel: string, text: string, testCode: readonly string[]): DocumentClass {
  const { generated, generator } = generatedMarker(text, "doc");
  if (!generated) return "hand";
  if (generator === null) return "generated-only";
  const base = posix.basename(rel);
  return testCode.some(code => namesWhole(code, base) && namesWhole(code, generator)) ? "generated-checked" : "generated-only";
}

const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;

/** What sits between two items of a list in source: whitespace and comments. */
const GAP = String.raw`(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*`;

/** A quoted string as source writes it, in any of the three quotes, escapes included. */
const STR = [String.raw`'(?:[^'\\\n]|\\[\s\S])*'`, String.raw`"(?:[^"\\\n]|\\[\s\S])*"`, "`(?:[^`\\\\$]|\\\\[\\s\\S]|\\$(?!\\{))*`"].join("|");

/** A list of quoted strings as source writes it, wherever it sits: code, a comment, a type or a string. */
const WRITTEN_LIST = new RegExp(String.raw`\[${GAP}(?:(?:${STR})${GAP},${GAP})*(?:${STR})${GAP}(?:,${GAP})?\]`, "g");

/** The items of an array literal when every element is a quoted string, else null. */
function quotedItems(node: AstNode): string[] | null {
  const elements = node.elements as Array<AstNode | null>;
  if (elements.length === 0) return null;
  const items: string[] = [];
  for (const e of elements) {
    if (e?.type === "Literal" && typeof e.value === "string") items.push(e.value);
    else if (e?.type === "TemplateLiteral" && (e.expressions as unknown[]).length === 0) {
      const cooked = ((e.quasis as AstNode[])[0].value as { cooked: string | null }).cooked;
      if (cooked === null) return null;
      items.push(cooked);
    } else return null;
  }
  return items;
}

/**
 * Every list of quoted strings written in the source, keyed by its items'
 * values, with where each starts. Values, not spellings: `'camp\x61igns'` is
 * `campaigns`. `null` when a written list could not be read back, so that no
 * line is taken from a count that may be short.
 */
function writtenLists(source: string): Map<string, number[]> | null {
  const at = new Map<string, number[]>();
  for (const m of source.matchAll(WRITTEN_LIST)) {
    let items: string[] | null = null;
    try {
      const statement = (parse(m[0], { ecmaVersion: "latest" }) as unknown as { body: AstNode[] }).body[0];
      if ((statement.expression as AstNode | undefined)?.type === "ArrayExpression") items = quotedItems(statement.expression as AstNode);
    } catch {
      return null;
    }
    if (items === null) return null;
    const key = JSON.stringify(items);
    at.set(key, [...(at.get(key) ?? []), m.index ?? 0]);
  }
  return at;
}

/** A property's key when it is written as a plain name or a string. */
function keyName(prop: AstNode): string | null {
  if (prop.type !== "Property" || prop.computed) return null;
  const key = prop.key as AstNode;
  if (key.type === "Identifier") return String(key.name);
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return null;
}

/** The arrays that are direct property values of a registered feature's own definition. */
function declaredInCode(tree: AstNode, registry: ReadonlySet<string>): Set<AstNode> {
  const declared = new Set<AstNode>();
  for (const node of walkNodes(tree)) {
    if (node.type !== "ObjectExpression") continue;
    const props = node.properties as AstNode[];
    const owner = props.find(p => keyName(p) === "name");
    const value = owner?.value as AstNode | undefined;
    if (value?.type !== "Literal" || typeof value.value !== "string" || !registry.has(nfc(value.value))) continue;
    for (const p of props) if (p.type === "Property" && (p.value as AstNode).type === "ArrayExpression") declared.add(p.value as AstNode);
  }
  return declared;
}

/**
 * A source file's code with no comment in it, macros refused and dead code
 * kept. Plain JavaScript is read as written, as a module and then as a
 * script (sloppy CommonJS), with its comments blanked to spaces so its
 * positions stay the source's own, and its tree comes with it; when neither
 * reading parses it, as with JSX in a `.js` file, it is transpiled like the
 * rest, and `tree` is null.
 */
function codeOf(rel: string, source: string): { tree: AstNode | null; js: string; exact: boolean } {
  if (PLAIN_JS.test(rel)) {
    for (const sourceType of ["module", "script"] as const) {
      const comments: Array<[number, number]> = [];
      let tree: AstNode;
      try {
        tree = parse(source, { ...PARSE_OPTIONS, sourceType, onComment: (_b: boolean, _t: string, start: number, end: number) => comments.push([start, end]) }) as unknown as AstNode;
      } catch {
        continue;
      }
      let js = source;
      for (const [start, end] of comments) js = js.slice(0, start) + js.slice(start, end).replace(/[^\n]/g, " ") + js.slice(end);
      return { tree, js, exact: true };
    }
  }
  const loader = rel.endsWith(".tsx") ? "tsx" : PLAIN_JS.test(rel) || rel.endsWith(".jsx") ? "jsx" : "ts";
  // `macro: false` refuses a macro import instead of running it while transforming; Bun's types
  // admit only a macro map there. Dead code is kept: a list in it is still typed by hand.
  const options = { loader, macro: false, deadCodeElimination: false } as unknown as ConstructorParameters<typeof Bun.Transpiler>[0];
  return { tree: null, js: new Bun.Transpiler(options).transformSync(source), exact: false };
}

/** A source file parsed: node positions index `js`. */
function parseSource(rel: string, source: string): { tree: AstNode; js: string; exact: boolean } {
  const code = codeOf(rel, source);
  return { ...code, tree: code.tree ?? (parse(code.js, PARSE_OPTIONS) as unknown as AstNode) };
}

/**
 * The quoted lists in one source file that name registered features. A
 * transpiled file's positions are not the source's, so each list's line is
 * found by ordinal: the k-th list with these values in the code is the k-th
 * written in the source, and when the two counts differ (a comment, a type
 * or a string holds a copy) the line is 0 rather than a guess.
 */
function listsIn(rel: string, source: string, registry: ReadonlySet<string>): HandList[] {
  const { tree, js, exact } = parseSource(rel, source);
  const declared = declaredInCode(tree, registry);
  const arrays: Array<{ node: AstNode; key: string; items: string[] }> = [];
  const inCode = new Map<string, number>();
  for (const node of walkNodes(tree)) {
    if (node.type !== "ArrayExpression") continue;
    const items = quotedItems(node);
    if (!items) continue;
    const key = JSON.stringify(items);
    arrays.push({ node, key, items });
    inCode.set(key, (inCode.get(key) ?? 0) + 1);
  }
  const written = exact ? null : writtenLists(source);

  const found: HandList[] = [];
  const seen = new Map<string, number>();
  for (const { node, key, items } of arrays) {
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    if (declared.has(node)) continue;
    const named = items.filter(i => registry.has(nfc(i)));
    const registered = named.length;
    if (new Set(named.map(nfc)).size < LIST_MIN || registered * LIST_SHARE.den < items.length * LIST_SHARE.num) continue;
    let line = 0;
    if (exact) line = lineAt(js, node.start);
    else {
      const inSource = written?.get(key) ?? [];
      if (written !== null && inSource.length === inCode.get(key)) line = lineAt(source, inSource[ordinal]);
    }
    const unregistered = [...new Set(items.filter(i => !registry.has(nfc(i))))];
    found.push({ file: rel, line, items: items.length, registered, unregistered });
  }
  return found;
}

/** The totals on each line of a document typed by hand that disagree with the registry. */
function totalsIn(rel: string, text: string, registry: number, nouns: readonly string[]): HandTotal[] {
  const noun = nouns.map(n => escape(n).replace(/\s+/g, String.raw`\s+`)).join("|");
  // The number may be bold or italic, and "registered" may sit before the word.
  const total = new RegExp(String.raw`(?<![\p{L}\p{N}_.,*])(?:\*\*|__|\*|_)?(\d+)(?:\*\*|__|\*|_)?\s+(?:registered\s+)?(?:${noun})(?![\p{L}\p{N}_])`, "giu");
  const cue = /(?<![-\p{L}\p{N}_])(all|registry|registered|total|auto-discovered|every)(?![\p{L}\p{N}_])/iu;
  const partial = new RegExp(String.raw`(?<![\p{L}\p{N}_])of \d+ (?:${noun})|\d+ of(?![\p{L}\p{N}_])`, "iu");
  const out: HandTotal[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (DATED.test(line)) return;
    for (const m of line.matchAll(total)) {
      const says = Number(m[1]);
      if (says === registry) continue;
      const near = line.slice(Math.max(0, (m.index ?? 0) - CUE_BEFORE), (m.index ?? 0) + CUE_AFTER);
      if (!cue.test(near) || partial.test(near)) continue;
      out.push({ path: rel, line: i + 1, says, text: line.trim().slice(0, 180) });
    }
  });
  return out;
}

const reason = (e: unknown) => String((e as NodeJS.ErrnoException).code ?? (e as Error).message ?? e).split("\n")[0];

/** Scan the repository at `root` against the feature names its manifest registers. */
export function scanHandTyped(root: string, registered: readonly string[], opts: HandTypedOptions = {}): HandTypedScan {
  const registry = new Set(registered.map(nfc));
  if (registry.size === 0) return { measured: false, why: "the registry names no feature, so no list or total can be compared with it" };
  let tracked: string[];
  try {
    tracked = execFileSync("git", ["ls-files", "-z", "--cached"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 })
      .split("\0")
      .filter(Boolean);
  } catch (e) {
    return { measured: false, why: `git could not list the files at ${root}: ${reason(e)}` };
  }

  const unmeasured: string[] = [];
  /** The file's text, or null when it is not a regular file at its own path or cannot be read (named). */
  const read = (rel: string): string | null => {
    try {
      if (!lstatSync(join(root, rel)).isFile()) return null;
      return readFileSync(join(root, rel), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") unmeasured.push(`${rel}: could not be read (${reason(e)})`);
      return null;
    }
  };

  const lists: HandList[] = [];
  const testCode: string[] = [];
  for (const rel of tracked.filter(f => SOURCE.test(f))) {
    const text = read(rel);
    if (text === null) continue;
    if (isTestPath(rel)) {
      // Comments come out, so a name written in one is not read as a check. A
      // test needs no tree here: Bun runs code that acorn would refuse.
      try {
        testCode.push(codeOf(rel, text).js);
      } catch (e) {
        unmeasured.push(`${rel}: did not transpile, so it is not read as a test (${reason(e)})`);
      }
      continue;
    }
    if (generatedMarker(text, "source").generated) continue;
    try {
      lists.push(...listsIn(rel, text, registry));
    } catch (e) {
      unmeasured.push(`${rel}: did not parse (${reason(e)})`);
    }
  }

  const documents: HandDocument[] = [];
  const totals: HandTotal[] = [];
  const nouns = opts.nouns?.length ? [...opts.nouns] : ["features"];
  for (const rel of tracked.filter(f => f.endsWith(".md") && !UNLISTED_DOCS.some(d => f.startsWith(d)))) {
    const text = read(rel);
    if (text === null) continue;
    const cls = documentClass(rel, text, testCode);
    documents.push({ path: rel, class: cls });
    if (cls === "hand" && !HISTORICAL_DOCS.some(d => rel.startsWith(d))) totals.push(...totalsIn(rel, text, registry.size, nouns));
  }

  return { measured: true, registry: registry.size, nouns, lists, documents, totals, unmeasured };
}

/** The scan as text a person or an agent reads. */
export function renderHandTyped(scan: HandTypedScan): string {
  if (!scan.measured) return `UNMEASURED: ${scan.why}`;
  const out: string[] = [`Typed by hand, against a registry of ${scan.registry}; a total is read as a number of: ${scan.nouns.join(", ")}`, ""];
  const files = new Set(scan.lists.map(l => l.file)).size;
  out.push(`Quoted lists naming registered features: ${scan.lists.length} in ${files} file(s) (line 0: not located for certain)`);
  for (const l of scan.lists) {
    const stray = l.unregistered.length ? `; names no feature: ${l.unregistered.join(", ")}` : "";
    out.push(`  ${l.file}:${l.line}  ${l.registered} of ${l.items} registered${stray}`);
  }
  const of = (c: DocumentClass) => scan.documents.filter(d => d.class === c);
  out.push("", `Documents: ${scan.documents.length} — ${of("generated-checked").length} generated and checked, ${of("generated-only").length} generated with nothing checking them, ${of("hand").length} typed by hand`);
  for (const d of of("generated-only")) out.push(`  generated, nothing checks it: ${d.path}`);
  for (const d of of("hand")) out.push(`  typed by hand: ${d.path}`);
  out.push("", `Totals that disagree with the registry: ${scan.totals.length}`);
  for (const t of scan.totals) out.push(`  ${t.path}:${t.line} says ${t.says}: ${t.text}`);
  if (scan.unmeasured.length) {
    out.push("", `Could not be read: ${scan.unmeasured.length}`);
    for (const u of scan.unmeasured) out.push(`  ${u}`);
  }
  return out.join("\n");
}
