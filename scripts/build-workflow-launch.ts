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
 * A line comment is removed and its line ending kept. A block comment becomes
 * a newline when it spans lines — it is a line terminator for automatic
 * semicolon insertion (`return /*\n*\/ x` returns undefined) — and a space when
 * it does not, so `a/* *\/b` never joins into one token.
 */
export function buildWorkflowLaunch(source: string, cap: number = WORKFLOW_SCRIPT_CAP): LaunchBuild {
  const before = parseErrors(source);
  if (before.length > 0) throw new Error(`the source does not parse: ${before[0]}`);
  let out = "";
  let at = 0;
  for (const c of commentRanges(source)) {
    out += source.slice(at, c.pos);
    const isBlock = source.startsWith("/*", c.pos);
    out += isBlock ? (c.multiline ? "\n" : " ") : "";
    at = c.end;
  }
  out += source.slice(at);
  // Lines left holding only whitespace collapse; a run of blank lines becomes one.
  out = out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");

  const meta = /^export const meta = \{/.exec(out);
  if (!meta) throw new Error("the launch text does not begin with `export const meta = {` — the Workflow tool requires it first");
  out = out.replace(/^(export const meta = \{[\s\S]*?\n\};?\n)/, `$1${GENERATED_NOTICE}\n`);
  if (!out.includes(GENERATED_NOTICE)) throw new Error("could not place the generated notice after the `meta` literal");

  const after = parseErrors(out);
  if (after.length > 0) throw new Error(`the launch text does not parse: ${after[0]}`);
  if (!hasTopLevelReturn(out)) throw new Error("the launch text has no top-level `return` — the run would produce nothing");
  const bytes = Buffer.byteLength(out, "utf-8");
  if (bytes >= cap) throw new Error(`the launch text is ${bytes} bytes, over the Workflow tool's ${cap}-byte cap`);
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
