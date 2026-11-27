/**
 * Generator unit test: code-map
 * AC-4: Tests generators with mock ProjectScan data
 */
import { test, expect, describe, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { FRESHNESS_NOTICE, generateCodeMap } from "../lib/generators/code-map";
import { mockProjectScan, type ProjectScan } from "../lib/generators/types";

describe("generateCodeMap with mock ProjectScan", () => {
  test("returns string with code-map frontmatter", () => {
    const scan = mockProjectScan({
      name: "map-project",
      dirs: [{ name: "src", types: ["ts"] }],
      deps: 5,
      devDeps: 3,
    });
    const result = generateCodeMap(scan);
    expect(typeof result).toBe("string");
    expect(result).toContain("doc-type: code-map");
    expect(result).toContain("status: generated");
  });

  test("includes project name in title", () => {
    const scan = mockProjectScan({ name: "named-project" });
    const result = generateCodeMap(scan);
    expect(result).toContain("# Code Map — named-project");
  });

  test("includes directory structure table", () => {
    const scan = mockProjectScan({
      name: "dir-test",
      dirs: [
        { name: "src", types: ["ts", "tsx"] },
        { name: "lib", types: ["ts"] },
      ],
    });
    const result = generateCodeMap(scan);
    expect(result).toContain("## Directory Structure");
    expect(result).toContain("| lib/ | ts |");
    expect(result).toContain("| src/ | ts, tsx |");
  });

  test("includes dependency counts", () => {
    const scan = mockProjectScan({
      name: "deps-test",
      deps: 15,
      devDeps: 9,
    });
    const result = generateCodeMap(scan);
    expect(result).toContain("| Dependencies | 15 |");
    expect(result).toContain("| Dev dependencies | 9 |");
  });

  test("includes API routes when present", () => {
    const scan = mockProjectScan({
      name: "api-test",
      routes: [
        { method: "POST", path: "/api/users", file: "src/routes.ts" },
      ],
    });
    const result = generateCodeMap(scan);
    expect(result).toContain("## API Routes");
    expect(result).toContain("| POST | /api/users | src/routes.ts |");
  });

  test("omits API routes section when empty", () => {
    const scan = mockProjectScan({
      name: "no-routes",
      routes: [],
    });
    const result = generateCodeMap(scan);
    expect(result).not.toContain("## API Routes");
  });

  test("includes source modules when present", () => {
    const scan = mockProjectScan({
      name: "modules-test",
      modules: [
        { file: "src/helpers.ts", exports: ["parseDate", "formatCurrency"] },
      ],
    });
    const result = generateCodeMap(scan);
    expect(result).toContain("## Source Modules");
    expect(result).toContain("| src/helpers.ts | parseDate, formatCurrency |");
  });

  test("omits modules section when empty", () => {
    const scan = mockProjectScan({
      name: "no-modules",
      modules: [],
    });
    const result = generateCodeMap(scan);
    expect(result).not.toContain("## Source Modules");
  });

  test("includes summary table with counts", () => {
    const scan = mockProjectScan({
      name: "summary-test",
      dirs: [
        { name: "a", types: ["ts"] },
        { name: "b", types: ["js"] },
        { name: "c", types: ["md"] },
      ],
      deps: 10,
      devDeps: 5,
    });
    const result = generateCodeMap(scan);
    expect(result).toContain("| Source directories | 3 |");
    expect(result).toContain("| Dependencies | 10 |");
  });
});

// ── #1163: the census is gone, and cannot come back quietly ──────────────

/**
 * The per-directory file census, removed — and held removed.
 *
 * The question these cases ask is not "does the string `fileCount` appear".
 * It is whether the RENDERED table can carry a per-directory number again,
 * because that is the thing that was wrong: MEASURED over the 50 commit
 * transitions ending at `b7281397`, 22 of them moved a count and 0 moved the
 * directory list. A reader cannot tell a count that is right from one that
 * is two merges old, so the file stopped carrying one.
 *
 * **What was broken to prove these fail** (`.claude/rules/checks-must-be-able-to-fail.md`):
 * the renderer's row template was put back to
 * `| ${d.name}/ | ${(d as any).types.length} | ${d.types.join(", ")} |` —
 * the cheapest way to reintroduce a per-directory number now that
 * `fileCount` is off the type. `the table has exactly two columns` went
 * **red**, naming the three-cell row. Restoring the two-column template
 * turned it green again.
 *
 * The ORDER case is the second half, and it is here because the old sort was
 * `b.fileCount - a.fileCount`: an order derived from the census is still the
 * census, one indirection away. Reversing the input must not reverse the
 * output.
 */
describe("#1163: CODE-MAP carries no per-directory census", () => {
  const dirs = [
    { name: "zeta", types: ["ts"] },
    { name: "alpha", types: ["md"] },
    { name: "mid", types: ["json"] },
  ];

  /** The body rows of the `## Directory Structure` table, header excluded. */
  function directoryRows(md: string): string[] {
    const section = md.split("## Directory Structure")[1];
    if (section === undefined) return [];
    return section
      .split("\n## ")[0]
      .split("\n")
      .filter(l => l.startsWith("| ") && !l.startsWith("| Directory") && !l.startsWith("|---"));
  }

  test("the table has exactly two columns, so no count column can return", () => {
    const md = generateCodeMap(mockProjectScan({ name: "census", dirs }));
    const rows = directoryRows(md);
    // The instrument first: a reader that found no rows would satisfy every
    // assertion below by having nothing to check.
    expect(rows, "the Directory Structure table was not found, so this reading is a refusal").toHaveLength(
      dirs.length,
    );
    expect(md, "the header gained a column").toContain("| Directory | Types |");
    const widths = [...new Set(rows.map(r => r.split("|").length))];
    expect(
      widths,
      `a directory row carries more than two cells — the per-directory census is back, and 22 of ` +
        `50 consecutive commits moved one (#1163):\n${rows.join("\n")}`,
    ).toEqual([4]); // "", name, types, "" — two cells between three pipes plus the trailing empty
  });

  test("the rows are ordered by name, not by anything that was counted", () => {
    const forward = generateCodeMap(mockProjectScan({ name: "census", dirs }));
    const reversed = generateCodeMap(mockProjectScan({ name: "census", dirs: [...dirs].reverse() }));
    expect(
      directoryRows(forward).map(r => r.split("|")[1].trim()),
      "the rows are not in name order",
    ).toEqual(["alpha/", "mid/", "zeta/"]);
    // ONE input difference, and it is the input order. If the renderer ever
    // sorts by a property of the entry again, these two diverge.
    expect(reversed, "reversing the input reversed the output — the order is not derived from the name").toBe(
      forward,
    );
  });

  test("the file states what it guarantees and what it does not", () => {
    const md = generateCodeMap(mockProjectScan({ name: "census", dirs }));
    expect(md, "a map that does not say how fresh it is invites the next reader to trust a stale row").toContain(
      FRESHNESS_NOTICE,
    );
    // Not a decorative sentence: it has to name the thing that cannot be
    // fixed, or it is reassurance rather than a disclaimer.
    expect(FRESHNESS_NOTICE).toContain("scanned-at-sha");
    expect(FRESHNESS_NOTICE).toContain("#1163");
  });
});

/**
 * The re-run instruction is for whoever reads the file, not for whoever ran
 * the generator.
 *
 * Caught in review of #1740, twice in one round. `scripts/generate-code-map.ts`
 * interpolated its own `process.argv[2]` into the header, so a regeneration
 * run as `bun bin/rungate.ts generate-code-map /Users/jhorn/Projects/rg-wt-flows`
 * committed that absolute path into a tracked document. The instruction is then
 * wrong for every other checkout, and it publishes one contributor's directory
 * layout in a file nobody hand-writes.
 */
describe("#1740: the code-map re-run instruction is portable", () => {
  const script = readFileSync(join(import.meta.dir, "..", "scripts", "generate-code-map.ts"), "utf-8");

  // Comments first. This file's own prose quotes the bad spelling, and a
  // detector that reads a whole file reads its comments
  // (`.claude/rules/self-referential-tests.md`).
  const code = script
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

  const reRunLines = code.split("\n").filter(l => l.includes("Re-run \\`bun generate-code-map.ts"));

  test("the detector finds the line it is about to judge", () => {
    // Anti-vacuity. Zero matches means the generator stopped spelling the
    // instruction this way and the row below is passing against nothing —
    // fix the pattern, do not delete the row. More than one means a second
    // emitter appeared and both need the same treatment.
    expect(
      reRunLines.length,
      "expected exactly one `Re-run `bun generate-code-map.ts …`` line in " +
        "scripts/generate-code-map.ts. See the comment above this row.",
    ).toBe(1);
  });

  test("the instruction interpolates nothing — a path from argv is one machine's", () => {
    expect(
      reRunLines[0],
      "the re-run instruction must be a literal. `${projectPath}` is this run's " +
        "argv, so it bakes the generating machine's directory into a committed " +
        "document and the instruction is wrong everywhere else. Emit `.`.",
    ).not.toContain("${");
  });

  test("the committed CODE-MAP.md carries no absolute path", () => {
    // The artefact, not the generator. A fixed generator and a stale
    // committed file are different facts, and the reviewer read the second.
    const md = readFileSync(join(import.meta.dir, "..", "CODE-MAP.md"), "utf-8");
    const leaks = md.split("\n").filter(l => /(^|[\s`'"(])\/(Users|home|root)\//.test(l));
    expect(
      leaks,
      "CODE-MAP.md is generated and committed. An absolute path in it came " +
        "from whoever last ran the generator. Regenerate after fixing the " +
        "generator rather than hand-editing the line.",
    ).toEqual([]);
  });
});

/**
 * Covers SC-2813 (SCAFFOLD-DECOMPOSITION-SPEC.md): the code map lists every
 * route registered on any router a file creates, and every page in the
 * router, and says how many routes it could not attribute to a router
 * (#2889, ADR-028). It used to match only `app.<method>("…")` in `src/`, so
 * it listed 62 of a consumer's 375 routes.
 *
 * Run as a consumer runs it: the real generator over a planted project, with
 * the rendered CODE-MAP.md read back.
 */
describe("SC-2813: every router's routes, every page, and what could not be attributed", () => {
  const scratch = mkdtempSync(join(tmpdir(), "rungate-2889-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const GENERATOR = join(import.meta.dir, "..", "scripts", "generate-code-map.ts");
  const plant = (root: string, files: Record<string, string>) => {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), body);
    }
  };
  const codeMap = (files: Record<string, string>) => {
    const root = mkdtempSync(join(scratch, "proj-"));
    plant(root, files);
    const proc = Bun.spawnSync(["bun", GENERATOR, root], { cwd: join(import.meta.dir, "..") });
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    return readFileSync(join(root, "CODE-MAP.md"), "utf-8");
  };
  const rows = (md: string, heading: RegExp) => {
    const at = md.split("\n").findIndex(l => heading.test(l));
    if (at < 0) return [];
    const out: string[] = [];
    for (const l of md.split("\n").slice(at + 1)) {
      if (l.startsWith("#")) break;
      if (l.startsWith("| ") && !l.startsWith("| Path") && !l.startsWith("|--")) out.push(l);
    }
    return out;
  };

  const PROJECT = {
    "src/cases.ts": [
      'import { Hono } from "hono";',
      "type Env = { Bindings: { db: string } };",
      "const router = new Hono<Env>();",
      'router.get("/cases", c => c.json({}));',
      "router.post(",
      "  `/cases/:id`,",
      '  c => c.text("ok"),',
      ");",
      'router.put("/cases/:id", c => c.text("a")).delete("/cases/:id", c => c.text("b"));',
      "export default router;",
    ].join("\n"),
    "server/app.js": [
      'const express = require("express");',
      "const app = express();",
      "const admin = express.Router();",
      'app.get("/health", (_q, r) => r.send("ok"));',
      'admin.patch("/admin/users", (_q, r) => r.send("ok"));',
      'app.use("/api", admin);',
    ].join("\n"),
    "src/other.ts": [
      "declare const registry: { get(p: string, h: () => void): void };",
      "declare const c: { get(k: string): unknown };",
      'registry.get("/not-a-router", () => {});',
      'export const user = c.get("userId");',
      '// A one-argument call is a lookup, not a route: Map.get, or express app.get("env").',
      'export const hit = new Map<string, number>().get("/a-map-key");',
    ].join("\n"),
    "dashboard/src/App.tsx": [
      'import { Routes, Route } from "react-router-dom";',
      "export const App = () => (",
      "  <Routes>",
      '    <Route path="/" element={<Home />}>',
      '      <Route path="cases" element={<Cases />} />',
      "    </Route>",
      '    <Route path="/settings" element={<Settings />} />',
      "  </Routes>",
      ");",
    ].join("\n"),
    "dashboard/src/router.tsx": [
      'import { createBrowserRouter } from "react-router-dom";',
      "export const router = createBrowserRouter([",
      '  { path: "/admin", element: <Admin />, children: [{ path: "users", element: <Users /> }] },',
      "]);",
    ].join("\n"),
    // One file per exclusion, so each rule has a case only it decides.
    "test/helpers/fake-api.ts": 'import { Hono } from "hono";\nconst fake = new Hono();\nfake.get("/only-in-a-test-folder", c => c.text(""));\n',
    "src/cases.test.ts": 'import { Hono } from "hono";\nconst t = new Hono();\nt.get("/only-in-a-test-file", c => c.text(""));\n',
    "src/broken.ts": "export const x = ;\n",
  };

  test("each router's routes, with the router, file and line", () => {
    const md = codeMap(PROJECT);
    expect(rows(md, /^### GET /)).toEqual([
      "| /cases | router | src/cases.ts | 4 |",
      "| /health | app | server/app.js | 4 |",
      "| /not-a-router | — | src/other.ts | 3 |",
    ]);
    expect(rows(md, /^### POST /)).toEqual(["| /cases/:id | router | src/cases.ts | 5 |"]);
    expect(rows(md, /^### PUT /)).toEqual(["| /cases/:id | router | src/cases.ts | 9 |"]);
    expect(rows(md, /^### DELETE /)).toEqual(["| /cases/:id | router | src/cases.ts | 9 |"]);
    expect(rows(md, /^### PATCH /)).toEqual(["| /admin/users | admin | server/app.js | 5 |"]);
    expect(md, "a route in a test folder is not the project's").not.toContain("/only-in-a-test-folder");
    expect(md, "a route in a test file is not the project's").not.toContain("/only-in-a-test-file");
  });

  test("a route-shaped call on no router a file creates is counted, and a file that does not parse is named", () => {
    const md = codeMap(PROJECT);
    expect(md).toContain("1 route-shaped call(s) could not be attributed to a router a file creates; they are listed with — as their router.");
    expect(md).toContain("| API routes | 6 |");
    expect(md).toContain("| Route calls not attributed to a router | 1 |");
    expect(md).toContain("UNMEASURED: 1 file(s) could not be parsed, so their routes and pages are not counted: src/broken.ts");
  });

  test("every page in the router, nested paths joined to their parents'", () => {
    const md = codeMap(PROJECT);
    expect(rows(md, /^## Pages/)).toEqual([
      "| / | dashboard/src/App.tsx | 4 |",
      "| /admin | dashboard/src/router.tsx | 3 |",
      "| /admin/users | dashboard/src/router.tsx | 3 |",
      "| /cases | dashboard/src/App.tsx | 5 |",
      "| /settings | dashboard/src/App.tsx | 7 |",
    ]);
    expect(md).toContain("| Pages | 5 |");
  });

  test("CRLF line endings, a byte-order mark and a path in any script read the same", () => {
    const body = ['import { Hono } from "hono";', "const api = new Hono();", "", 'api.get("/café", c => c.text("ok"));'].join("\r\n");
    const md = codeMap({ "src/api.ts": `\uFEFF${body}` });
    expect(rows(md, /^### GET /)).toEqual(["| /café | api | src/api.ts | 4 |"]);
  });

  test("a macro import is refused, never run, and its file is named as unparsed (security review)", () => {
    const root = mkdtempSync(join(scratch, "macro-"));
    const marker = join(root, "MACRO_RAN");
    plant(root, {
      "lib/boom.ts": `import { writeFileSync } from "fs";\nexport function boom() { writeFileSync(${JSON.stringify(marker)}, "ran"); return "x"; }\n`,
      "src/routes.ts": `import { boom } from ${JSON.stringify(join(root, "lib", "boom.ts"))} with { type: "macro" };\nimport { Hono } from "hono";\nconst router = new Hono();\nrouter.get("/m", c => c.text(boom()));\n`,
    });
    const proc = Bun.spawnSync(["bun", GENERATOR, root], { cwd: join(import.meta.dir, "..") });
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    expect(existsSync(marker), "the scanned project's macro ran").toBe(false);
    expect(readFileSync(join(root, "CODE-MAP.md"), "utf-8")).toContain("could not be parsed, so their routes and pages are not counted: src/routes.ts");
  });

  test("a link is never followed: no loop through an ancestor, no file outside the project (security review)", () => {
    const outside = mkdtempSync(join(scratch, "outside-"));
    plant(outside, { "x.ts": 'import { Hono } from "hono";\nconst o = new Hono();\no.get("/outside", c => c.text(""));\n' });
    const root = mkdtempSync(join(scratch, "links-"));
    plant(root, { "src/api.ts": 'import { Hono } from "hono";\nconst api = new Hono();\napi.get("/inside", c => c.text(""));\n' });
    symlinkSync(root, join(root, "src", "loop"));
    symlinkSync(outside, join(root, "src", "elsewhere"));
    const proc = Bun.spawnSync(["bun", GENERATOR, root], { cwd: join(import.meta.dir, "..") });
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    const md = readFileSync(join(root, "CODE-MAP.md"), "utf-8");
    expect(rows(md, /^### GET /)).toEqual(["| /inside | api | src/api.ts | 3 |"]);
  });

  test("a path with a column or row break stays one cell (security review)", () => {
    const md = codeMap({ "src/api.ts": 'import { Hono } from "hono";\nconst api = new Hono();\napi.get("/a|b\\nc", c => c.text(""));\n' });
    expect(rows(md, /^### GET /)).toEqual(["| /a\\|b c | api | src/api.ts | 0 |"]);
  });

  test("#2911 review: inline routers, scopes, computed paths, settings reads and source folders named like build output", () => {
    const md = codeMap({
      "src/inline.ts": 'import { Hono } from "hono";\nexport const app = new Hono().get("/health", c => c.text("ok"));\n',
      "src/scoped.ts": [
        'import { Hono } from "hono";',
        "const app = new Hono();",
        'app.get("/a", c => c.text(""));',
        "export function register(app: Hono) {",
        '  app.get("/b", c => c.text(""));',
        "}",
      ].join("\n"),
      "server/settings.js": [
        'const express = require("express");',
        "const app = express();",
        'const PATH = "/x";',
        'app.get("view engine");',
        "app.get(PATH, (_q, r) => r.send(''));",
        "app.get('*', (_q, r) => r.send(''));",
      ].join("\n"),
      "src/features/build/routes.ts": 'import { Hono } from "hono";\nconst b = new Hono();\nb.get("/api/build/status", c => c.text(""));\n',
      "build/out.js": 'const { Hono } = require("hono");\nconst o = new Hono();\no.get("/build-output", () => {});\n',
      "src/commented.ts": 'import { Hono } from "hono";\nconst api = new Hono();\n// api.get("/c") is registered below\napi.get("/c", c => c.text(""));\n',
    });
    expect(rows(md, /^### GET /)).toEqual([
      "| (computed) | app | server/settings.js | 5 |",
      "| * | app | server/settings.js | 6 |",
      "| /a | app | src/scoped.ts | 3 |",
      "| /api/build/status | b | src/features/build/routes.ts | 3 |",
      "| /b | — | src/scoped.ts | 5 |",
      "| /c | api | src/commented.ts | 0 |",
      "| /health | new Hono() | src/inline.ts | 2 |",
    ]);
    expect(md).not.toContain("/build-output");
    expect(md).toContain("1 route-shaped call(s) could not be attributed");
    expect(md).toContain("1 route or page path(s) are not written literally");
  });

  test("#2911 review: page trees by name, classic-runtime children, computed parents, and what could not be seen", () => {
    const md = codeMap({
      "web/routes.tsx": [
        'import { createBrowserRouter, Route } from "react-router-dom";',
        'import { imported } from "./elsewhere";',
        'const adminRoutes = [{ path: "users", element: <U /> }];',
        'const routes = [{ path: "/admin", element: <A />, children: adminRoutes }];',
        "export const router = createBrowserRouter(routes);",
        "export const other = createBrowserRouter(imported);",
        "declare const ADMIN: string;",
        'export const tree = <Route path={ADMIN}><Route path="audit" element={<Au />} /></Route>;',
      ].join("\n"),
      "web/classic.js": [
        'const React = require("react");',
        'module.exports = React.createElement(Route, { path: "/shop" }, React.createElement(Route, { path: "cart" }));',
      ].join("\n"),
    });
    expect(rows(md, /^## Pages/).map(r => r.split(" | ").slice(0, 2).join(" | "))).toEqual([
      "| /{computed} | web/routes.tsx",
      "| /{computed}/audit | web/routes.tsx",
      "| /admin | web/routes.tsx",
      "| /admin/users | web/routes.tsx",
      "| /shop | web/classic.js",
      "| /shop/cart | web/classic.js",
    ]);
    expect(md).toContain("UNMEASURED: 1 part(s) of a page tree could not be seen, so their pages are not listed: web/routes.tsx: imported under /");
  });

  test("CONTROL: a project with no routers and no pages renders neither section", () => {
    const md = codeMap({ "src/util.ts": "export const add = (a: number, b: number) => a + b;\n" });
    expect(md).not.toContain("## API Routes");
    expect(md).not.toContain("## Pages");
    expect(md).toContain("| API routes | 0 |");
  });
});
