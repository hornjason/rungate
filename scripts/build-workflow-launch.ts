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

/**
 * The closure of `core` in a module's source: every top-level declaration the
 * named exports reach, and every value import, dynamic `import()` or
 * `require()` any of them touches.
 *
 * The source is transpiled first, so a type-only import, which the sandbox
 * never sees, is not counted. An identifier that is a property name or an
 * object key is not a use of the binding it shares a name with. A local that
 * shadows a top-level name is counted as a use, which can only over-report:
 * this check is allowed to be wrong toward refusing.
 */
export function coreClosure(source: string, core: readonly string[]): CoreClosure {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
  }).outputText;
  const sf = ts.createSourceFile("core.js", js, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const imports = new Map<string, string>();
  const decls = new Map<string, ts.Node>();
  const exported = new Set<string>();
  // `export { local as name }` and `export { name } from "m"` (review of #2397).
  const aliases = new Map<string, string>();
  const reexports = new Map<string, string>();
  const isExported = (n: ts.Node) =>
    (ts.canHaveModifiers(n) ? ts.getModifiers(n) : undefined)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const from = st.moduleSpecifier.text;
      const clause = st.importClause;
      if (clause?.name) imports.set(clause.name.text, from);
      const nb = clause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) imports.set(nb.name.text, from);
      if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) imports.set(e.name.text, from);
    } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) {
      decls.set(st.name.text, st);
      if (isExported(st)) exported.add(st.name.text);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        // Every name a declarator binds, destructured ones included: each maps
        // to the whole declarator, so reaching it walks the initializer too
        // (review of #2397, round 3).
        const names: string[] = [];
        const bind = (n: ts.BindingName): void => {
          if (ts.isIdentifier(n)) names.push(n.text);
          else for (const e of n.elements) if (!ts.isOmittedExpression(e)) bind(e.name);
        };
        bind(d.name);
        for (const name of names) {
          decls.set(name, d);
          if (isExported(st)) exported.add(name);
        }
      }
    } else if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      const from = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
      for (const e of st.exportClause.elements) {
        const name = e.name.text;
        if (from !== null) reexports.set(name, from);
        else aliases.set(name, e.propertyName?.text ?? name);
      }
    }
  }
  const missing = core.filter(n => !exported.has(n) && !aliases.has(n) && !reexports.has(n));
  const reached = new Set<string>();
  const touched: string[] = [];
  const queue: string[] = [];
  for (const n of core) {
    // A core exported from another module is not in this one, whatever it is called here.
    if (reexports.has(n)) {
      touched.push(`${n} (re-exported from ${reexports.get(n)})`);
      continue;
    }
    const local = aliases.get(n) ?? n;
    if (imports.has(local)) touched.push(`${n} (from ${imports.get(local)}, re-exported)`);
    else if (decls.has(local)) queue.push(local);
  }
  const isNameOnly = (id: ts.Identifier) => {
    const p = id.parent;
    return (
      (ts.isPropertyAccessExpression(p) && p.name === id) ||
      (ts.isPropertyAssignment(p) && p.name === id) ||
      (ts.isMethodDeclaration(p) && p.name === id) ||
      (ts.isPropertyDeclaration(p) && p.name === id)
    );
  };
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (reached.has(name)) continue;
    reached.add(name);
    const visit = (n: ts.Node): void => {
      // A dynamic `import()` or a `require()` loads a module as surely as an
      // import statement, and the sandbox has neither (review of #2397).
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        const loader =
          callee.kind === ts.SyntaxKind.ImportKeyword
            ? "import()"
            : ts.isIdentifier(callee) && callee.text === "require" && !decls.has("require")
              ? "require()"
              : null;
        if (loader !== null) {
          const arg = n.arguments[0];
          const what = arg && ts.isStringLiteralLike(arg) ? arg.text : "a computed module";
          const line = `${loader} of ${what} (via ${name})`;
          if (!touched.includes(line)) touched.push(line);
        }
      }
      if (ts.isIdentifier(n) && !isNameOnly(n)) {
        const t = n.text;
        if (imports.has(t)) {
          const line = `${t} (from ${imports.get(t)}, via ${name})`;
          if (!touched.includes(line)) touched.push(line);
        } else if (decls.has(t) && !reached.has(t)) {
          queue.push(t);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(decls.get(name)!);
  }
  return { declarations: [...reached], missing, imports: touched };
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
