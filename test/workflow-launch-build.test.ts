/**
 * #2287 / SC-2772: the ship launch file is generated from `workflows/ship.js`,
 * parses, keeps the `meta` literal and the top-level `return`, and is under
 * the Workflow tool's 524,288-byte cap (ADR-017 Decision 1).
 *
 * `ship.js` is 556,509 bytes on the day this landed (#2213), so no consumer
 * could launch it. The launch file drops comments and keeps every other
 * token; the strongest case below proves that by comparing the two token
 * streams, so "only comments were removed" is measured rather than claimed.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import {
  buildWorkflowLaunch,
  coreClosure,
  GENERATED_NOTICE,
  PURE_CORE_MODULES,
  hasTopLevelReturn,
  metaLiteral,
  parseErrors,
  SHIP_LAUNCH,
  SHIP_SOURCE,
  tokenTexts,
  WORKFLOW_SCRIPT_CAP,
} from "../scripts/build-workflow-launch";

const source = readFileSync(SHIP_SOURCE, "utf-8");
const built = buildWorkflowLaunch(source);

describe("#2287 / SC-2772: the generated ship launch file", () => {
  test("is under the Workflow tool's cap, and ship.js itself is not — the reason it exists", () => {
    expect(WORKFLOW_SCRIPT_CAP).toBe(524_288);
    expect(built.bytes).toBeLessThan(WORKFLOW_SCRIPT_CAP);
    expect(Buffer.byteLength(source, "utf-8"), "ship.js fits the cap again; the launch file may no longer be needed").toBeGreaterThan(WORKFLOW_SCRIPT_CAP);
  });

  test("parses, begins with the meta literal, and ends its run with a top-level return", () => {
    expect(parseErrors(built.text)).toEqual([]);
    expect(built.text.startsWith("export const meta = {")).toBe(true);
    expect(metaLiteral(built.text)).toBe(metaLiteral(source));
    expect(metaLiteral(source)).not.toBeNull();
    expect(hasTopLevelReturn(built.text)).toBe(true);
  });

  test("keeps every token of ship.js, in order — only comments and blank lines are gone", () => {
    const want = tokenTexts(source);
    expect(want.length, "no tokens read from ship.js — the comparison would be vacuous").toBeGreaterThan(10_000);
    expect(tokenTexts(built.text)).toEqual(want);
  });

  test("says it is generated, and from what", () => {
    expect(built.text).toContain(GENERATED_NOTICE);
  });

  test("the committed workflows/ship.run.js is the build of the current ship.js — never stale", () => {
    expect(readFileSync(SHIP_LAUNCH, "utf-8") === built.text, "workflows/ship.run.js is stale: run `bun scripts/build-workflow-launch.ts` and commit it").toBe(true);
  });
});

describe("#2287 / SC-2772: what the build must not get wrong", () => {
  const wrap = (body: string) => `export const meta = {\n  name: 'x',\n};\n${body}\nreturn { ok: true };\n`;

  test("a // inside a string, a template literal or a regex is text, not a comment", () => {
    const body = [
      "const url = 'https://example.com/a'; // a real comment",
      "const t = `see // not a comment ${url} /* nor this */`;",
      "const re = /\\/\\/[a-z]+/g;",
    ].join("\n");
    const out = buildWorkflowLaunch(wrap(body)).text;
    expect(out).toContain("'https://example.com/a'");
    expect(out).toContain("`see // not a comment ${url} /* nor this */`");
    expect(out).toContain("/\\/\\/[a-z]+/g");
    expect(out).not.toContain("a real comment");
  });

  test("a block comment spanning lines stays a line terminator, so ASI is unchanged", () => {
    const body = "function f() {\n  return /* spans\n  lines */ 42;\n}";
    const out = buildWorkflowLaunch(wrap(body)).text;
    // `return\n42` returns undefined, exactly as the source does; a space would make it return 42.
    expect(out).toMatch(/return\s*\n\s*42;/);
    expect(tokenTexts(out)).toEqual(tokenTexts(wrap(body)));
  });

  test("a one-line block comment between two tokens becomes a space, never a join", () => {
    const out = buildWorkflowLaunch(wrap("const a = 1, b = 2;\nconst c = a/* x */+b;")).text;
    expect(out).toContain("a +b");
  });

  test("over the cap is a refusal, not a smaller file — and exactly at the cap is accepted (review, #2291)", () => {
    expect(() => buildWorkflowLaunch(source, built.bytes - 1)).toThrow(/over the Workflow tool's/);
    expect(buildWorkflowLaunch(source, built.bytes).bytes).toBe(built.bytes);
  });

  test("text inside a template literal is never rewritten: trailing spaces and blank-line runs survive (review, #2291)", () => {
    const literal = "const s = `line one   \nline two\t\n\n\n\nline three`;";
    const out = buildWorkflowLaunch(wrap(`// a comment above\n${literal}`)).text;
    expect(out).toContain(literal);
    expect(tokenTexts(out)).toEqual(tokenTexts(wrap(literal)));
  });

  test("a comment on its own line is removed with its line; a trailing one takes its leading spaces", () => {
    const out = buildWorkflowLaunch(wrap("const a = 1;\n    // own line\nconst b = 2;   // trailing\nconst c = 3;")).text;
    expect(out).toContain("const a = 1;\nconst b = 2;\nconst c = 3;");
  });

  test("no top-level return is a refusal", () => {
    expect(() => buildWorkflowLaunch("export const meta = {\n  name: 'x',\n};\nconst a = 1;\n")).toThrow(/no top-level `return`/);
  });

  test("a source that does not parse is a refusal — and the parse reading sees the error at all (review, #2291)", () => {
    // `parseErrors` reads `parseDiagnostics`, which is not public TypeScript
    // API. If an upgrade stops filling it, the reading goes empty for broken
    // input and the refusal passes everything; this case is what goes red.
    const broken = wrap("const a = ;");
    expect(parseErrors(broken).length, "parseErrors reads nothing from a broken source — the parse guard is blind").toBeGreaterThan(0);
    expect(() => buildWorkflowLaunch(broken)).toThrow(/the source does not parse/);
  });

  test("a source that does not begin with meta is a refusal", () => {
    expect(() => buildWorkflowLaunch("const a = 1;\nexport const meta = {\n  name: 'x',\n};\nreturn 1;\n")).toThrow(/does not begin with/);
  });
});

/**
 * #2289 / SC-2774: the lib modules ship.js copies by hand each export a core
 * that imports nothing, so the generator can bundle it (SC-2775) in place of
 * the copy.
 *
 * A core is a set of exported names. Its closure is those names and every
 * top-level declaration they reach in the same module. The closure may not
 * reach an import, because the Workflow sandbox has no module loading (#69).
 */
describe("#2289 / SC-2774: each copied module exports a core that imports nothing", () => {
  const ROOT = join(import.meta.dir, "..");

  test("the four modules ADR-017 names are the ones listed", () => {
    expect(Object.keys(PURE_CORE_MODULES).sort()).toEqual([
      "lib/dev-liveness.ts",
      "lib/prior-branch.ts",
      "lib/workflow-security.ts",
      "lib/worktree-repo.ts",
    ]);
  });

  for (const [module, core] of Object.entries(PURE_CORE_MODULES)) {
    test(`${module}: every core name is exported, and its closure reaches no import`, () => {
      const c = coreClosure(readFileSync(join(ROOT, module), "utf-8"), core);
      expect(c.missing, `${module} does not export these core names`).toEqual([]);
      expect(c.imports, `${module}'s core reaches an import, so it cannot be bundled into the launch file`).toEqual([]);
      // Not vacuous: the closure holds at least the core itself.
      expect(c.declarations.length).toBeGreaterThanOrEqual(core.length);
    });
  }

  test("a core that gains an import is caught, naming the import and the module it comes from", () => {
    const src = [
      'import { existsSync } from "fs";',
      'import type { Thing } from "./types";',
      "const RULE = /x/;",
      "function helper(s: string): boolean { return existsSync(s); }",
      "export function pure(s: string): boolean { return RULE.test(s); }",
      "export function impure(s: string): boolean { return helper(s) && pure(s); }",
      "export function typed(t: Thing): string { return String(t); }",
    ].join("\n");
    expect(coreClosure(src, ["pure"]).imports).toEqual([]);
    expect(coreClosure(src, ["impure"]).imports).toEqual(["existsSync (from fs, via helper)"]);
    // A type-only import is erased before the sandbox sees the code.
    expect(coreClosure(src, ["typed"]).imports).toEqual([]);
    expect(coreClosure(src, ["absent"]).missing).toEqual(["absent"]);
    // Review of #2397: a dynamic import() or a require() is a module load too.
    const dynamic = [
      'export async function lazy() { return (await import("node:fs")).existsSync("x"); }',
      'export function old() { return require("child_process"); }',
      "export function computed(m: string) { return import(m); }",
    ].join("\n");
    expect(coreClosure(dynamic, ["lazy"]).imports).toEqual(["import() of node:fs (via lazy)"]);
    expect(coreClosure(dynamic, ["old"]).imports).toEqual(["require() of child_process (via old)"]);
    expect(coreClosure(dynamic, ["computed"]).imports).toEqual(["import() of a computed module (via computed)"]);
    // Review of #2397, round 2: a core exported by an export list, under an
    // alias, or re-exported from another module.
    const listed = [
      'import { h } from "./other";',
      "function f(s: string) { return s.length; }",
      "function k(s: string) { return s.trim(); }",
      "export { f, k as kk, h };",
      'export { g } from "./other";',
    ].join("\n");
    expect(coreClosure(listed, ["f", "kk"])).toEqual({ declarations: ["f", "k"], missing: [], imports: [] });
    expect(coreClosure(listed, ["g"]).imports).toEqual(["g (re-exported from ./other)"]);
    expect(coreClosure(listed, ["h"]).imports).toEqual(["h (from ./other, re-exported)"]);
    // Review of #2397, round 3: a destructured top-level binding.
    const destructured = [
      'import * as fs from "fs";',
      "const { existsSync } = fs;",
      "const [first, , third] = [1, 2, 3];",
      "export function reaches() { return existsSync(\"x\"); }",
      "export function local() { return first + third; }",
    ].join("\n");
    expect(coreClosure(destructured, ["reaches"]).imports).toEqual(["fs (from fs, via existsSync)"]);
    expect(coreClosure(destructured, ["local"]).imports).toEqual([]);
    // A property name that happens to match an import is not a use of it.
    expect(coreClosure('import { x } from "y";\nexport function f(o: { x: number }) { return o.x; }', ["f"]).imports).toEqual([]);
  });
});
