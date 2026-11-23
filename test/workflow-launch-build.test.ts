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
  BUNDLE_END,
  BUNDLE_START,
  buildWorkflowLaunch,
  bundleDrops,
  bundleLibCores,
  coreClosure,
  GENERATED_NOTICE,
  LAUNCH_BUNDLE,
  launchBundle,
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
const bundle = launchBundle();
const built = buildWorkflowLaunch(source, WORKFLOW_SCRIPT_CAP, bundle);
/** The launch text with the bundled lib region taken out: what came from ship.js alone. */
const outsideBundle = (text: string) => {
  const at = text.indexOf(BUNDLE_START);
  const end = text.indexOf(BUNDLE_END);
  return at === -1 || end === -1 ? text : text.slice(0, at) + text.slice(end + BUNDLE_END.length);
};

describe("#2287 / SC-2772: the generated ship launch file", () => {
  test("is under the Workflow tool's cap, and ship.js cannot run without it — the reason it exists", () => {
    expect(WORKFLOW_SCRIPT_CAP).toBe(524_288);
    expect(built.bytes).toBeLessThan(WORKFLOW_SCRIPT_CAP);
    // It existed first because ship.js was over the cap. Since #2290 wave 3c-B
    // ship.js is under it (moving copies into the bundle shrank it), and the
    // reason is the bundle: ship.js calls lib functions it no longer defines,
    // so on its own it would throw at the first call. Either reason keeps the
    // launch file; neither holding means it may no longer be needed.
    const overCap = Buffer.byteLength(source, "utf-8") > WORKFLOW_SCRIPT_CAP;
    const dependsOnBundle = Object.values(LAUNCH_BUNDLE)
      .flat()
      .filter(name => new RegExp(`\\b${name}\\(`).test(source))
      .filter(name => !new RegExp(`(?:function|const|let)\\s+${name}\\b`).test(source));
    expect(
      overCap || dependsOnBundle.length > 0,
      "ship.js fits the cap and defines every bundled name it calls; the launch file may no longer be needed",
    ).toBe(true);
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
    // The bundled lib region (#2400) is the only addition, and it is checked below.
    expect(tokenTexts(outsideBundle(built.text))).toEqual(want);
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
    expect(() => buildWorkflowLaunch(source, built.bytes - 1, bundle)).toThrow(/over the Workflow tool's/);
    expect(buildWorkflowLaunch(source, built.bytes, bundle).bytes).toBe(built.bytes);
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

/**
 * #2398 / SC-2775 wave 1: the reader resolves names through TypeScript's
 * checker, and the bundler emits each module's core as one block of
 * JavaScript. No copy in ship.js is replaced yet.
 */
describe("#2398: cores are read by the checker and bundled", () => {
  const ROOT = join(import.meta.dir, "..");
  const read = (p: string) => readFileSync(join(ROOT, p), "utf-8");

  test("a core exported only by export * is reported as reaching that module, not as missing", () => {
    const c = coreClosure('export * from "./star";\nexport function own() { return 1; }', ["fromStar"]);
    expect(c.missing).toEqual([]);
    expect(c.imports).toEqual(["fromStar (possibly re-exported by export * from ./star)"]);
  });

  test("review of #2399: a default export that is not a named declaration is refused, and export * as ns names its module", () => {
    expect(coreClosure("export default function() { return 1; }", ["default"]).imports).toEqual([
      "default (not a named top-level declaration, so it cannot be bundled)",
    ]);
    expect(coreClosure('import { x } from "y";\nexport default x + 1;', ["default"]).imports).toEqual([
      "default (not a named top-level declaration, so it cannot be bundled)",
    ]);
    expect(() => bundleLibCores({ "lib/a.ts": ["default"] }, () => "export default class { }")).toThrow("cannot be bundled");
    // `export * as ns` exports ns, and only ns.
    const star = 'export * as ns from "./star";\nexport function own() { return 1; }';
    expect(coreClosure(star, ["ns"]).imports).toEqual(["ns (re-exported from ./star)"]);
    expect(coreClosure(star, ["fromStar"]).missing).toEqual(["fromStar"]);
    // A NAMED default function is a declaration and bundles.
    expect(coreClosure("export default function named() { return 1; }", ["default"]).imports).toEqual([]);
  });

  test("review of #2399: a parameter or local named require is not the module loader", () => {
    const src = [
      "export function viaParam(require: (id: string) => unknown) { return require(\"x\"); }",
      "export function viaLocal() { const require = (id: string) => id; return require(\"y\"); }",
      "export function global() { return require(\"z\"); }",
    ].join("\n");
    expect(coreClosure(src, ["viaParam", "viaLocal"]).imports).toEqual([]);
    expect(coreClosure(src, ["global"]).imports).toEqual(["require() of z (via global)"]);
  });

  test("review of #2399: a core exported from a destructured binding is named as asked, not by pattern order", () => {
    expect(coreClosure("const obj = { a: 1, b: 2 };\nconst { b, a } = obj;\nexport { a };", ["a"]).declarations).toEqual(["a", "obj"]);
  });

  test("review of #2399: a core exported under an alias whose local cannot be placed is refused, not dropped", () => {
    expect(coreClosure("if (true) { function g() { return 1; } }\nexport { g as core };", ["core"]).imports).toEqual([
      "core (not a named top-level declaration, so it cannot be bundled)",
    ]);
  });

  test("review of #2399 round 4: a top-level statement that uses a reached binding is refused, not dropped", () => {
    // An enum compiles to `var Color;` plus an initializer statement; emitting
    // the declaration alone would bundle an undefined Color.
    const enumSrc = "enum Color { Red, Blue }\nexport function pick() { return Color.Red; }";
    expect(coreClosure(enumSrc, ["pick"]).imports).toEqual([
      "Color (used by top-level code that runs at load and that the bundle does not carry)",
    ]);
    expect(() => bundleLibCores({ "lib/a.ts": ["pick"] }, () => enumSrc)).toThrow("Color (used by top-level code that runs at load");
    // A namespace is the same shape.
    expect(coreClosure("namespace N { export const x = 1; }\nexport function f() { return N.x; }", ["f"]).imports).toEqual([
      "N (used by top-level code that runs at load and that the bundle does not carry)",
    ]);
    // So is a plain write after the declaration.
    expect(coreClosure("const T: Record<string, number> = {};\nT.x = 1;\nexport function get() { return T.x; }", ["get"]).imports).toEqual([
      "T (used by top-level code that runs at load and that the bundle does not carry)",
    ]);
    // An unreached declaration's initializer runs at load too (review of #2399, round 6).
    expect(coreClosure("const T: Record<string, number> = {};\nconst _ = (T.x = 1);\nexport function get() { return T.x; }", ["get"]).imports).toEqual([
      "T (used by top-level code that runs at load and that the bundle does not carry)",
    ]);
    expect(coreClosure("const T: Record<string, number> = {};\nclass K { static s = (T.x = 1); }\nexport function get() { return T.x; }", ["get"]).imports).toEqual([
      "T (used by top-level code that runs at load and that the bundle does not carry)",
    ]);
    // A function that top-level code names may run at load, so its body is load-time code (review of #2399, round 8).
    expect(coreClosure("const T: Record<string, number> = {};\nfunction later() { T.x = 1; }\nlater();\nexport function get() { return T.x; }", ["get"]).imports).toEqual([
      "T (used by top-level code that runs at load and that the bundle does not carry)",
    ]);
    expect(coreClosure("const T: Record<string, number> = {};\nfunction a() { b(); }\nfunction b() { T.x = 1; }\n[1].forEach(a);\nexport function get() { return T.x; }", ["get"]).imports).toEqual([
      "T (used by top-level code that runs at load and that the bundle does not carry)",
    ]);
    // A function no core reaches runs nothing at load, so its body is not a use.
    expect(coreClosure("const T: Record<string, number> = {};\nfunction later() { T.x = 1; }\nexport function get() { return T.x; }", ["get"]).imports).toEqual([]);
    // A statement that touches only what no core reaches is left behind, as before.
    expect(coreClosure("const other: number[] = [];\nother.push(1);\nexport function f() { return 1; }", ["f"]).imports).toEqual([]);
    // A local that shadows a reached name inside such a statement is not a use of it.
    expect(coreClosure("const T = 1;\n[2].forEach(T => T);\nexport function f() { return T; }", ["f"]).imports).toEqual([]);
  });

  test("a local that shadows an import is not a use of it — the checker reads scope", () => {
    const src = 'import { existsSync } from "fs";\nexport function f(existsSync: (p: string) => boolean) { return existsSync("x"); }';
    expect(coreClosure(src, ["f"]).imports).toEqual([]);
  });

  test("the four modules bundle into JavaScript that parses, runs with no module loading, and defines every core", () => {
    const bundle = bundleLibCores(PURE_CORE_MODULES, read);
    const cores = Object.values(PURE_CORE_MODULES).flat();
    expect(parseErrors(bundle.text), "the bundle does not parse").toEqual([]);
    for (const name of cores) expect(bundle.defined, `${name} is not defined by the bundle`).toContain(name);
    // Evaluated in a bare function: no import, no require, one scope. A
    // top-level initializer that needed a module would throw here.
    const scope = new Function(`${bundle.text}\nreturn { ${cores.join(", ")} };`)() as Record<string, unknown>;
    for (const name of cores) expect(typeof scope[name], `${name} is not a function in the bundle`).toBe("function");
    // It still leaves room in the launch file.
    expect(Buffer.byteLength(built.text) + Buffer.byteLength(bundle.text)).toBeLessThan(WORKFLOW_SCRIPT_CAP);
  });

  test("a bundled core still behaves like its module: shellQuote quotes, isSafeBranchName refuses a traversal", () => {
    const bundle = bundleLibCores(PURE_CORE_MODULES, read);
    const f = new Function(`${bundle.text}\nreturn { shellQuote, isSafeBranchName };`)() as {
      shellQuote: (w: unknown) => string;
      isSafeBranchName: (n: unknown) => boolean;
    };
    expect(f.shellQuote("a b")).toBe("'a b'");
    expect(f.isSafeBranchName("rg/ok-1")).toBe(true);
    expect(f.isSafeBranchName("../escape")).toBe(false);
  });

  test("a core that reaches an import is refused by the bundler, naming the module and the import", () => {
    const files: Record<string, string> = {
      "lib/a.ts": 'import { existsSync } from "fs";\nexport function a() { return existsSync("x"); }',
    };
    expect(() => bundleLibCores({ "lib/a.ts": ["a"] }, p => files[p]!)).toThrow("lib/a.ts cannot be bundled: its core reaches existsSync (from fs, via a)");
  });

  test("two modules defining one name are refused: the launch file has one scope", () => {
    const files: Record<string, string> = {
      "lib/a.ts": "function helper() { return 1; }\nexport function a() { return helper(); }",
      "lib/b.ts": "function helper() { return 2; }\nexport function b() { return helper(); }",
    };
    expect(() => bundleLibCores({ "lib/a.ts": ["a"], "lib/b.ts": ["b"] }, p => files[p]!)).toThrow(
      "helper is defined by both lib/a.ts and lib/b.ts",
    );
  });
});

describe("#2400: the launch file carries suiteCurrency from lib, and ship.js no longer copies it", () => {
  const ROOT = join(import.meta.dir, "..");
  const read = (p: string) => readFileSync(join(ROOT, p), "utf-8");

  test("the launch bundle is suiteCurrency, then scope-denylist and plan-coverage (#2404)", () => {
    expect(LAUNCH_BUNDLE).toEqual({
      "lib/suite-measurement.ts": ["suiteCurrency"],
      "lib/scope-denylist.ts": [
        "pathsNamedIn", "prohibitions", "deniedFiles", "unresolvedProhibitions", "normalisePath",
        "matchesDenied", "scopeContradiction", "denylistViolations", "withoutDenied",
      ],
      "lib/plan-coverage.ts": ["planCoverage", "planCoverageRefusal"],
      "lib/security-verdict.ts": [
        "rookReviewSha", "reviewIsCurrent", "REVIEW_CURRENT", "RE_REVIEW", "SECURITY_REREVIEW_EXHAUSTED",
        "reReviewDecision", "rookScopeCommand", "REVIEW_SCOPE_FULL", "REVIEW_SCOPE_DIFF", "reReviewScope",
        "reReviewBaseFor", "resolveReReview", "SECURITY_FINDINGS_OUTLIVED_REREVIEW", "securityRefusalName",
        "rookGateVerdict",
      ],
      "lib/prior-branch.ts": ["priorWorkRefusal"],
      "lib/dev-liveness.ts": ["containerProbeTarget", "CONTAINER_HOST"],
      "lib/worktree-repo.ts": [
        "repoSlug", "redactRemote", "looksLikeFilesystemPath", "worktreeIdentity", "worktreeIdentityViolations",
      ],
      // #2684, SC-2775 wave 4-B: ship.js's SECURITY-HELPERS copies of these nine.
      // shellQuote stays in ship.js's SHELL-QUOTE block, which four workflows
      // carry byte-identical and test/workflow-prompt-top-level-cd.test.ts holds.
      "lib/workflow-security.ts": [
        "pathRefusal", "validateFilePaths", "buildSafeGitAdd", "isSafeBranchName", "repoSlugRefusal",
        "rootPathRefusal", "resolveEvidencePath", "validateEvidenceCommand", "buildSafeSSHCommand",
      ],
      // #2688, SC-2775 wave 5: ship.js's REFUSAL-CURRENCY copy.
      "lib/gate-refusal-currency.ts": ["resolvedCheckNames", "retireSupersededRefusals", "failureCheckName"],
    });
  });

  test("the launch file holds exactly the bundle, between its markers, after the generated notice", () => {
    const bundle = bundleLibCores(LAUNCH_BUNDLE, read);
    const at = built.text.indexOf(BUNDLE_START);
    expect(at, "the launch file carries no bundle").toBeGreaterThan(built.text.indexOf(GENERATED_NOTICE));
    const region = built.text.slice(at + BUNDLE_START.length, built.text.indexOf(BUNDLE_END));
    expect(tokenTexts(region)).toEqual(tokenTexts(bundle.text));
    const f = new Function(`${region}\nreturn suiteCurrency;`)() as (m: unknown, h: unknown) => { state: string };
    expect(f("3192a75", "3192a75c4f1e2b8d9a0c5e6f7081a2b3c4d5e6f7").state).toBe("CURRENT");
  });

  test("ship.js defines none of the names the bundle defines — its hand copy cannot come back", () => {
    const bundle = launchBundle();
    for (const name of [
      "suiteCurrency", "planCoverage", "denylistViolations", "rookGateVerdict", "reviewIsCurrent", "priorWorkRefusal", "containerProbeTarget",
      // #2684: the security helpers, and a private rule only they use.
      "pathRefusal", "validateFilePaths", "isSafeBranchName", "buildSafeSSHCommand", "SHELL_METACHARACTERS",
      // #2688: the refusal-currency rule.
      "resolvedCheckNames", "retireSupersededRefusals",
      // #2690: the one rule for which check a failure line belongs to.
      "failureCheckName",
    ]) {
      expect(bundle.defined).toContain(name);
      expect(() => buildWorkflowLaunch(`${source}\nfunction ${name}() { return null; }`, WORKFLOW_SCRIPT_CAP, bundle)).toThrow(
        `${name} is defined by both workflows/ship.js and the lib bundle`,
      );
    }
  });

  test("#2417: a bundle whose code holds a dollar-backtick, dollar-quote or dollar-ampersand is inserted byte for byte", () => {
    // String.replace reads those as patterns in a string replacement (the
    // dollar-backtick is the text before the match). lib/dev-liveness.ts's
    // health-path regex holds one, and the launch text stopped parsing (#2417).
    const text = ["const R = /[;&|$`\"'<>]/;", "const Q = \"$'\";", "const P = \"$&\";"].join("\n");
    const out = buildWorkflowLaunch(source, WORKFLOW_SCRIPT_CAP, { text, defined: ["R", "Q", "P"] }).text;
    const region = out.slice(out.indexOf(BUNDLE_START) + BUNDLE_START.length, out.indexOf(BUNDLE_END)).trim();
    expect(region).toBe(text);
  });

  test("the output check refuses a bundle with a reached declaration removed, naming the name", () => {
    const src = "const SHA = /^[0-9a-f]+$/;\nfunction norm(v) { return SHA.test(v) ? v : null; }\nexport function core(v) { return norm(v); }";
    expect(bundleDrops(src, "const SHA = /^[0-9a-f]+$/;\nfunction norm(v) { return SHA.test(v) ? v : null; }\nfunction core(v) { return norm(v); }")).toEqual([]);
    expect(bundleDrops(src, "const SHA = /^[0-9a-f]+$/;\nfunction core(v) { return norm(v); }")).toEqual(["norm"]);
    // A global the module never declared is not a drop: it is unresolved in both.
    expect(bundleDrops("export function f() { return JSON.stringify(1); }", "function f() { return JSON.stringify(1); }")).toEqual([]);
  });

  test("review of #2399 round 5: a core that uses a name declared inside a top-level block is refused, naming it", () => {
    // A `var` in a block is module-scoped, so the module defines it and the
    // bundle, which carries only top-level declarations, would not.
    expect(coreClosure("if (true) { var g = () => 1; }\nexport function core() { return g(); }", ["core"]).imports).toEqual([
      "g (declared where the bundle cannot reach it, via core)",
    ]);
    // A function declared in a block is block-scoped in a module: the module
    // itself cannot resolve `g`, so the bundle cannot differ from it, and the
    // output check sees the name unresolved in both.
    const blockFn = "if (true) { function g() { return 1; } }\nexport function core() { return g(); }";
    expect(bundleDrops(blockFn, "function core() { return g(); }")).toEqual([]);
    // A local, a parameter, and a property of a reached object are all inside what is emitted.
    expect(coreClosure("const CFG = { a: 1 };\nexport function core(p) { const l = p; return l + CFG.a; }", ["core"]).imports).toEqual([]);
  });
});

describe("#2404: an import is accepted only when the same bundle defines it", () => {
  const files: Record<string, string> = {
    "lib/a.ts": "export function norm(p: string) { return p.trim(); }\nexport function other() { return 1; }",
    "lib/b.ts": 'import { norm } from "./a";\nexport function use(p: string) { return norm(p) + "!"; }',
    "lib/c.ts": 'import { other } from "./a";\nexport function use2() { return other(); }',
    "lib/d.ts": 'import { norm as n } from "./a";\nexport function use3(p: string) { return n(p); }',
    "lib/e.ts": 'import { x } from "./outside";\nexport function use4() { return x(); }',
  };
  const read = (p: string) => files[p]!;

  test("a name imported from a module the bundle carries, and that it bundles, is accepted and runs", () => {
    const b = bundleLibCores({ "lib/a.ts": ["norm"], "lib/b.ts": ["use"] }, read);
    expect(b.defined).toEqual(expect.arrayContaining(["norm", "use"]));
    const use = new Function(`${b.text}\nreturn use;`)() as (p: string) => string;
    expect(use("  x ")).toBe("x!");
  });

  test("a name that module does not bundle is still refused, naming it and the module", () => {
    expect(() => bundleLibCores({ "lib/a.ts": ["norm"], "lib/c.ts": ["use2"] }, read)).toThrow("other (from ./a, via use2)");
  });

  test("an aliased import is refused: the bundle has one scope and no renaming", () => {
    expect(() => bundleLibCores({ "lib/a.ts": ["norm"], "lib/d.ts": ["use3"] }, read)).toThrow("n (from ./a, via use3)");
  });

  test("an import from a module outside the bundle is still refused", () => {
    expect(() => bundleLibCores({ "lib/a.ts": ["norm"], "lib/e.ts": ["use4"] }, read)).toThrow("x (from ./outside, via use4)");
  });
});
