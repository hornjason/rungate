#!/usr/bin/env bun
/**
 * Build the file the Workflow tool launches from `workflows/ship.js`
 * (ADR-017 Decision 1, #2287, SC-2772).
 *
 * The Workflow tool refuses a script over 524,288 bytes, and `ship.js` is
 * past it (#2213), so no consumer can launch it. About half of `ship.js` is
 * comments, which never reach a run. `ship.js` stays the file people edit
 * and tests read; this writes `workflows/ship.run.js` with the comments
 * removed and every other byte kept.
 *
 *     bun scripts/build-workflow-launch.ts           # write workflows/ship.run.js
 *     bun scripts/build-workflow-launch.ts --check   # exit non-zero when it is stale
 *
 * Comments are found by TypeScript's own parser, never by a regex: a `//`
 * inside a string, a template literal or a regex is text, not a comment, and
 * only a parser can tell. The test proves the result keeps every token of the
 * source in order, so nothing but trivia was removed.
 */
import { readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import ts from "typescript";

/** The Workflow tool's script cap — `maxLength` on its `script` input. */
export const WORKFLOW_SCRIPT_CAP = 524_288;

/** Every refusal exits here: one site, so a test can mutate it. */
export const BUILD_REFUSE_EXIT = 1;

const ROOT = resolve(import.meta.dir, "..");
export const SHIP_SOURCE = join(ROOT, "workflows", "ship.js");
export const SHIP_LAUNCH = join(ROOT, "workflows", "ship.run.js");

/** What the generated file says it is, on its first line after `meta`. */
export const GENERATED_NOTICE =
  "// GENERATED from workflows/ship.js by scripts/build-workflow-launch.ts (#2287). Do not edit: edit ship.js and rebuild.";

export interface LaunchBuild {
  text: string;
  bytes: number;
}

function parse(text: string): ts.SourceFile {
  return ts.createSourceFile("ship.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

/** The parse errors TypeScript recorded. A top-level `return` is not one of them. */
export function parseErrors(text: string): string[] {
  const sf = parse(text) as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] };
  return (sf.parseDiagnostics ?? []).map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

/**
 * A node's children, minus the JSDoc nodes TypeScript parses out of `/** *\/`
 * comments in a JS file. Those are comments, not code: counting them as
 * tokens made the token comparison fail on every removed docblock.
 */
function codeChildren(n: ts.Node, sf: ts.SourceFile): ts.Node[] {
  return n.getChildren(sf).filter(k => !(k.kind >= ts.SyntaxKind.FirstJSDocNode && k.kind <= ts.SyntaxKind.LastJSDocNode));
}

/** Every leaf token's text, in order — what a run executes, without the trivia. */
export function tokenTexts(text: string): string[] {
  const sf = parse(text);
  const out: string[] = [];
  const walk = (n: ts.Node) => {
    const kids = codeChildren(n, sf);
    if (kids.length === 0) {
      if (n.kind !== ts.SyntaxKind.EndOfFileToken) out.push(n.getText(sf));
      return;
    }
    kids.forEach(walk);
  };
  walk(sf);
  return out;
}

/**
 * Every comment between tokens. Both kinds of range are read at each token's
 * full start: TypeScript calls a comment on the previous token's line a
 * TRAILING comment of that token and returns it only from
 * `getTrailingCommentRanges`, so leading ranges alone miss `x; // note`.
 */
function commentRanges(text: string): Array<{ pos: number; end: number; multiline: boolean }> {
  const sf = parse(text);
  const seen = new Set<number>();
  const out: Array<{ pos: number; end: number; multiline: boolean }> = [];
  const collect = (pos: number) => {
    for (const r of [...(ts.getTrailingCommentRanges(text, pos) ?? []), ...(ts.getLeadingCommentRanges(text, pos) ?? [])]) {
      if (seen.has(r.pos)) continue;
      seen.add(r.pos);
      out.push({ pos: r.pos, end: r.end, multiline: text.slice(r.pos, r.end).includes("\n") });
    }
  };
  const walk = (n: ts.Node) => {
    const kids = codeChildren(n, sf);
    if (kids.length === 0) collect(n.pos);
    else kids.forEach(walk);
  };
  walk(sf);
  return out.sort((a, b) => a.pos - b.pos);
}

/**
 * The launch text for a workflow source, or a thrown refusal naming why.
 *
 * A comment alone on its line is removed with the line. A comment that ends a
 * line is removed with the spaces before it, and the line ending stays. A
 * block comment with code after it on the same line becomes a newline when it
 * spans lines — a line terminator for automatic semicolon insertion
 * (`return /*\n*\/ x` returns undefined) — and a space when it does not, so
 * `a/* *\/b` never joins into one token. Nothing else is rewritten.
 */
export function buildWorkflowLaunch(source: string, cap: number = WORKFLOW_SCRIPT_CAP): LaunchBuild {
  const before = parseErrors(source);
  if (before.length > 0) throw new Error(`the source does not parse: ${before[0]}`);
  // Only the comment and the whitespace around it on its own line are ever
  // touched — never a file-wide rewrite, which reached inside template
  // literals and changed a prompt's trailing spaces and blank lines (review,
  // #2291). A comment alone on its line takes the line with it; one that ends
  // a line takes the spaces before it. Both spans are trivia, never literal text.
  let out = "";
  let at = 0;
  for (const c of commentRanges(source)) {
    const lineStart = source.lastIndexOf("\n", c.pos - 1) + 1;
    const nl = source.indexOf("\n", c.end);
    const lineEnd = nl === -1 ? source.length : nl;
    const endsLine = /^[ \t]*$/.test(source.slice(c.end, lineEnd));
    const aloneOnLine = endsLine && lineStart >= at && /^[ \t]*$/.test(source.slice(lineStart, c.pos));
    if (aloneOnLine) {
      // The whole line goes. The line before still ends in its own newline,
      // so a line terminator stays between the tokens on either side.
      out += source.slice(at, lineStart);
      at = nl === -1 ? source.length : nl + 1;
    } else if (endsLine) {
      // Code, then the comment, then the line ending: drop the comment and
      // the spaces before it. The line ending stays.
      let cut = c.pos;
      while (cut > at && (source[cut - 1] === " " || source[cut - 1] === "\t")) cut--;
      out += source.slice(at, cut);
      at = c.end;
    } else {
      // A block comment with code after it on the same line: a newline if it
      // spans lines (a line terminator for ASI), else a space (no token join).
      out += source.slice(at, c.pos) + (c.multiline ? "\n" : " ");
      at = c.end;
    }
  }
  out += source.slice(at);

  const meta = /^export const meta = \{/.exec(out);
  if (!meta) throw new Error("the launch text does not begin with `export const meta = {` — the Workflow tool requires it first");
  out = out.replace(/^(export const meta = \{[\s\S]*?\n\};?\n)/, `$1${GENERATED_NOTICE}\n`);
  if (!out.includes(GENERATED_NOTICE)) throw new Error("could not place the generated notice after the `meta` literal");

  const after = parseErrors(out);
  if (after.length > 0) throw new Error(`the launch text does not parse: ${after[0]}`);
  if (!hasTopLevelReturn(out)) throw new Error("the launch text has no top-level `return` — the run would produce nothing");
  // The tool accepts a script of exactly `cap` (review, #2291). Its limit is
  // in characters; counting UTF-8 bytes, which are never fewer, is the
  // conservative reading.
  const bytes = Buffer.byteLength(out, "utf-8");
  if (bytes > cap) throw new Error(`the launch text is ${bytes} bytes, over the Workflow tool's ${cap}-byte cap`);
  return { text: out, bytes };
}

/** Does the file end its run with a `return` at the top level, as every workflow script does? */
export function hasTopLevelReturn(text: string): boolean {
  return parse(text).statements.some(s => s.kind === ts.SyntaxKind.ReturnStatement);
}

/** The `meta` object literal's own text, comments excluded, for comparing source and launch. */
export function metaLiteral(text: string): string | null {
  const sf = parse(text);
  for (const s of sf.statements) {
    if (!ts.isVariableStatement(s)) continue;
    for (const d of s.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === "meta" && d.initializer) return tokenTexts(d.initializer.getText(sf)).join(" ");
    }
  }
  return null;
}

/**
 * The lib modules `workflows/ship.js` copies by hand, and the exported names
 * it copies from each (ADR-017 Decision 2, #2289, SC-2774). Each module
 * imports a node built-in or another lib module, so only these names, and what
 * they reach in the same file, can be bundled into the launch file. That set
 * is the module's core, and `coreClosure` proves it imports nothing.
 */
export const PURE_CORE_MODULES: Readonly<Record<string, readonly string[]>> = {
  "lib/workflow-security.ts": [
    "pathRefusal",
    "validateFilePaths",
    "buildSafeGitAdd",
    "isSafeBranchName",
    "repoSlugRefusal",
    "rootPathRefusal",
    "resolveEvidencePath",
    "validateEvidenceCommand",
    "buildSafeSSHCommand",
    "shellQuote",
  ],
  "lib/worktree-repo.ts": ["repoSlug", "redactRemote", "looksLikeFilesystemPath", "worktreeIdentity"],
  "lib/prior-branch.ts": ["priorWorkRefusal"],
  "lib/dev-liveness.ts": ["containerProbeTarget"],
};

/** What a core reaches: its declarations, any core name the module does not export, and any import it touches. */
export interface CoreClosure {
  declarations: string[];
  missing: string[];
  imports: string[];
}

interface CoreReading {
  closure: CoreClosure;
  /** The top-level nodes the core reaches, in source order, with the names each binds. */
  nodes: { node: ts.Node; names: string[] }[];
  sf: ts.SourceFile;
}

const CORE_FILE = "/core.js";

/**
 * A one-file program over the transpiled module, so TypeScript's checker
 * resolves every name instead of hand-kept maps (#2398, from #2397 round 5).
 * Transpiling first erases type-only imports, which the sandbox never sees.
 * `noResolve` keeps every import an unresolved alias, which is what marks it.
 */
function coreProgram(source: string): { checker: ts.TypeChecker; sf: ts.SourceFile } {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
  }).outputText;
  const options: ts.CompilerOptions = { allowJs: true, noResolve: true, noLib: true, types: [], target: ts.ScriptTarget.ESNext };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name, lang) => (name === CORE_FILE ? ts.createSourceFile(CORE_FILE, js, lang, true, ts.ScriptKind.JS) : undefined);
  host.fileExists = name => name === CORE_FILE;
  host.readFile = name => (name === CORE_FILE ? js : undefined);
  const program = ts.createProgram([CORE_FILE], options, host);
  return { checker: program.getTypeChecker(), sf: program.getSourceFile(CORE_FILE)! };
}

/** The module an import binding comes from, or null when the declaration is not an import. */
function importedFrom(decl: ts.Declaration | undefined): string | null {
  let n: ts.Node | undefined = decl;
  while (n && !ts.isImportDeclaration(n)) {
    if (!ts.isImportSpecifier(n) && !ts.isImportClause(n) && !ts.isNamespaceImport(n) && !ts.isNamedImports(n)) return null;
    n = n.parent;
  }
  return n && ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : null;
}

/** The node to emit and walk for a top-level declaration, or null when the declaration is not top-level. */
function topLevelNode(decl: ts.Declaration | undefined, sf: ts.SourceFile): ts.Node | null {
  if (!decl) return null;
  // Named only: an anonymous `export default function() {}` is not a
  // statement once its `export default` is dropped (review of #2399).
  if ((ts.isFunctionDeclaration(decl) || ts.isClassDeclaration(decl)) && decl.parent === sf && decl.name) return decl;
  let n: ts.Node = decl;
  while (ts.isBindingElement(n) || ts.isObjectBindingPattern(n) || ts.isArrayBindingPattern(n)) n = n.parent;
  if (ts.isVariableDeclaration(n) && ts.isVariableDeclarationList(n.parent) && ts.isVariableStatement(n.parent.parent) && n.parent.parent.parent === sf) {
    return n;
  }
  return null;
}

function boundNames(node: ts.Node): string[] {
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) return [node.name.text];
  const out: string[] = [];
  const bind = (b: ts.BindingName): void => {
    if (ts.isIdentifier(b)) out.push(b.text);
    else for (const e of b.elements) if (!ts.isOmittedExpression(e)) bind(e.name);
  };
  if (ts.isVariableDeclaration(node)) bind(node.name);
  return out;
}

function readCore(source: string, core: readonly string[]): CoreReading {
  const { checker, sf } = coreProgram(source);
  const moduleSymbol = checker.getSymbolAtLocation(sf);
  const exports = new Map((moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []).map(s => [s.name, s]));
  const stars = sf.statements
    .filter((s): s is ts.ExportDeclaration => ts.isExportDeclaration(s) && !s.exportClause && !!s.moduleSpecifier)
    .map(s => (s.moduleSpecifier as ts.StringLiteral).text);
  const missing: string[] = [];
  const touched: string[] = [];
  const note = (line: string) => {
    if (!touched.includes(line)) touched.push(line);
  };
  const reached = new Map<ts.Node, string>();
  const queue: { node: ts.Node; name: string }[] = [];
  const enqueue = (node: ts.Node, name: string) => {
    if (!reached.has(node)) {
      reached.set(node, name);
      queue.push({ node, name });
    }
  };
  for (const n of core) {
    const e = exports.get(n);
    if (!e) {
      // `export *` from a module this one does not hold may be where it is.
      if (stars.length > 0) note(`${n} (possibly re-exported by export * from ${stars.join(", ")})`);
      else missing.push(n);
      continue;
    }
    const decl = e.declarations?.[0];
    // `export * as ns from "m"`: the name is the other module's namespace.
    if (decl && ts.isNamespaceExport(decl)) {
      const from = decl.parent.moduleSpecifier;
      note(`${n} (re-exported from ${from && ts.isStringLiteral(from) ? from.text : "another module"})`);
      continue;
    }
    if (decl && ts.isExportSpecifier(decl)) {
      const from = decl.parent.parent.moduleSpecifier;
      if (from && ts.isStringLiteral(from)) {
        note(`${n} (re-exported from ${from.text})`);
        continue;
      }
      const local = checker.getExportSpecifierLocalTargetSymbol(decl)?.declarations?.[0];
      const imp = importedFrom(local);
      if (imp !== null) note(`${n} (from ${imp}, re-exported)`);
      else {
        // Named by its own declaration, not the alias it is exported under.
        const node = topLevelNode(local, sf);
        if (node) enqueue(node, boundNames(node)[0] ?? n);
      }
      continue;
    }
    const node = topLevelNode(decl, sf);
    // An export the bundler cannot emit as a named declaration, such as
    // `export default <expression>` or an anonymous default, is refused.
    // Dropping it from the closure would hide what it reaches (review of #2399).
    if (node) enqueue(node, n);
    else note(`${n} (not a named top-level declaration, so it cannot be bundled)`);
  }
  while (queue.length > 0) {
    const { node, name } = queue.shift()!;
    const visit = (n: ts.Node): void => {
      // A dynamic `import()` or a `require()` loads a module as surely as an
      // import statement, and the sandbox has neither (review of #2397).
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        // A `require` declared in this file, as a parameter, a local or a
        // top-level declaration, is a function the module wrote, not the
        // loader. The global one has no declaration here (review of #2399).
        const declaredAt = ts.isIdentifier(callee) ? checker.getSymbolAtLocation(callee)?.declarations?.[0] : undefined;
        const declared = declaredAt !== undefined && declaredAt.getSourceFile() === sf;
        const loader =
          callee.kind === ts.SyntaxKind.ImportKeyword
            ? "import()"
            : ts.isIdentifier(callee) && callee.text === "require" && !declared
              ? "require()"
              : null;
        if (loader !== null) {
          const arg = n.arguments[0];
          note(`${loader} of ${arg && ts.isStringLiteralLike(arg) ? arg.text : "a computed module"} (via ${name})`);
        }
      }
      if (ts.isIdentifier(n)) {
        const sym = ts.isShorthandPropertyAssignment(n.parent)
          ? checker.getShorthandAssignmentValueSymbol(n.parent)
          : checker.getSymbolAtLocation(n);
        const decl = sym?.declarations?.[0];
        const imp = importedFrom(decl);
        if (imp !== null) note(`${n.text} (from ${imp}, via ${name})`);
        else {
          const top = topLevelNode(decl, sf);
          if (top) enqueue(top, sym!.name);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
  }
  const nodes = [...reached.keys()]
    .sort((a, b) => a.getStart(sf) - b.getStart(sf))
    .map(node => ({ node, names: boundNames(node) }));
  return { closure: { declarations: [...reached.values()], missing, imports: touched }, nodes, sf };
}

/**
 * The closure of `core` in a module's source: every top-level declaration the
 * named exports reach, and every import, re-export, dynamic `import()` or
 * `require()` any of them touches. Names are resolved by TypeScript's checker,
 * so a local that shadows a top-level name, a property name and an object key
 * are each read as what they are.
 */
export function coreClosure(source: string, core: readonly string[]): CoreClosure {
  return readCore(source, core).closure;
}

/** What `bundleLibCores` emits: JavaScript defining every reached declaration, and the names it defines. */
export interface CoreBundle {
  text: string;
  defined: string[];
}

/**
 * The JavaScript for every module's core and what it reaches (#2398, SC-2775
 * wave 1), each declaration emitted once, in its module's source order, with
 * its `export` dropped. A core that reaches an import, or a name two modules
 * both define, is refused rather than emitted: the launch file runs in a
 * sandbox with no module loading and one scope.
 */
export function bundleLibCores(
  modules: Readonly<Record<string, readonly string[]>>,
  read: (path: string) => string,
): CoreBundle {
  const parts: string[] = [];
  const owner = new Map<string, string>();
  for (const [path, core] of Object.entries(modules)) {
    const { closure, nodes, sf } = readCore(read(path), core);
    if (closure.missing.length > 0 || closure.imports.length > 0) {
      throw new Error(
        `${path} cannot be bundled: ` +
          [
            closure.missing.length > 0 ? `it does not export ${closure.missing.join(", ")}` : "",
            closure.imports.length > 0 ? `its core reaches ${closure.imports.join("; ")}` : "",
          ]
            .filter(Boolean)
            .join(", and "),
      );
    }
    for (const { node, names } of nodes) {
      for (const name of names) {
        const prior = owner.get(name);
        if (prior !== undefined && prior !== path) {
          throw new Error(`${name} is defined by both ${prior} and ${path}; the launch file has one scope, so one of them must be renamed`);
        }
        owner.set(name, path);
      }
      if (ts.isVariableDeclaration(node)) {
        const flags = node.parent.flags;
        const keyword = flags & ts.NodeFlags.Const ? "const" : flags & ts.NodeFlags.Let ? "let" : "var";
        parts.push(`${keyword} ${node.getText(sf)};`);
      } else {
        parts.push(node.getText(sf).replace(/^export\s+(default\s+)?/, ""));
      }
    }
  }
  return { text: parts.join("\n"), defined: [...owner.keys()] };
}

function main(argv: string[]): number {
  let built: LaunchBuild;
  try {
    built = buildWorkflowLaunch(readFileSync(SHIP_SOURCE, "utf-8"));
  } catch (e) {
    console.error(`build-workflow-launch: ${(e as Error).message}`);
    return BUILD_REFUSE_EXIT;
  }
  if (argv.includes("--check")) {
    let committed = "";
    try {
      committed = readFileSync(SHIP_LAUNCH, "utf-8");
    } catch {
      console.error("build-workflow-launch: workflows/ship.run.js is missing. Run `bun scripts/build-workflow-launch.ts`.");
      return BUILD_REFUSE_EXIT;
    }
    if (committed !== built.text) {
      console.error("build-workflow-launch: workflows/ship.run.js is stale against workflows/ship.js. Run `bun scripts/build-workflow-launch.ts` and commit it.");
      return BUILD_REFUSE_EXIT;
    }
    console.log(`workflows/ship.run.js is current: ${built.bytes} bytes, ${WORKFLOW_SCRIPT_CAP - built.bytes} under the cap.`);
    return 0;
  }
  writeFileSync(SHIP_LAUNCH, built.text);
  console.log(`wrote workflows/ship.run.js: ${built.bytes} bytes, ${WORKFLOW_SCRIPT_CAP - built.bytes} under the cap.`);
  return 0;
}

if (import.meta.main) process.exit(main(Bun.argv.slice(2)));
