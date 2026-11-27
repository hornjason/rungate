#!/usr/bin/env bun
/**
 * generate-code-map.ts — Scan a codebase and produce CODE-MAP.md
 *
 * Usage: bun ~/Projects/rungate/scripts/generate-code-map.ts /path/to/project
 *
 * Combines fallow analysis + route scanning + directory structure into a
 * machine-generated architecture snapshot. Agents read this to understand
 * the codebase without exploring manually.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync, statSync } from "fs";
import { join, basename, extname, posix, relative } from "path";
import { parse as parseJs } from "acorn";
import { localCalendarDay } from "../lib/local-calendar-day";
import { FRESHNESS_NOTICE, directoryTable } from "../lib/generators/code-map";
import { fileExtensions } from "../lib/file-extensions";
import {
  fallowAvailable,
  fallowUnmeasuredNotice,
  runFallowJson,
  type FallowUnavailable,
} from "../lib/fallow-availability";

const projectPath = process.argv[2];
if (!projectPath || !existsSync(projectPath)) {
  console.error("Usage: generate-code-map.ts /path/to/project");
  process.exit(1);
}

const projectName = basename(projectPath);
const today = localCalendarDay();

// ── Fallow analysis ──────────────────────────────────────────

interface FallowData {
  entryPoints: number;
  unusedFiles: string[];
  unusedExports: Array<{ path: string; export_name: string; line: number }>;
  circularDeps: Array<{ files: string[] }>;
  elapsed: number;
}

/**
 * Three outcomes, not two (#581).
 *
 * This returned `null` for "not installed", "the spawn failed", "the output
 * did not parse" and — through `||` in the summary table below — "it ran and
 * found zero". A CODE-MAP written from any of them was byte-identical, so a
 * reader could not tell a project with no dead code from a project nobody
 * looked at.
 */
type FallowOutcome = { data: FallowData } | { unavailable: FallowUnavailable };

function runFallow(): FallowOutcome {
  // Resolved locally, with no network path. A bare `npx fallow` for a tool
  // that is not a declared dependency is a registry fetch on the SCAFFOLD
  // path — once per consumer, forever, including behind a proxy and in an
  // air-gapped CI. `lib/conformity.ts` fixed this for itself in #510 and
  // this caller never got it.
  //
  // The spawn, the budget and the classification are no longer here: they
  // were a second copy of `lib/conformity.ts`'s, with a second `30_000`
  // literal, and the two disagreed about what to do with a killed run. One
  // binding now, in `lib/fallow-availability.ts` (#935). What stays here is
  // the SHAPING of fallow's JSON into the fields CODE-MAP.md needs, which is
  // this script's own business and nobody else's.
  const root = fallowAvailable(projectPath) ? projectPath : process.cwd();
  const reading = runFallowJson<any>(root, ["dead-code"]);
  if ("unavailable" in reading) return { unavailable: reading.unavailable };
  const d = reading.data;
  return { data: {
    entryPoints: d.entry_points?.total || 0,
    unusedFiles: (d.unused_files || []).map((f: any) => f.path),
    unusedExports: (d.unused_exports || []).map((e: any) => ({
      path: e.path, export_name: e.export_name, line: e.line
    })),
    circularDeps: (d.circular_dependencies || []).map((c: any) => ({
      files: c.files || [c.path]
    })),
    elapsed: d.elapsed_ms || 0,
  } };
}

// ── Route and page scanning (SC-2813, #2889) ─────────────────

/**
 * What creates a router, as the code spells it: `new Hono()`, `express()`,
 * `express.Router()`, `Router()`, `new Router()`, `fastify()`, `new
 * Elysia()`. A route is counted as a router's only when the router was made
 * by one of these in the same file; any other route-shaped call is counted as
 * unattributed, never dropped.
 */
const ROUTER_NEW = new Set(["Hono", "OpenAPIHono", "Router", "Elysia"]);
const ROUTER_CALL = new Set(["express", "Router", "fastify", "Fastify"]);
const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);
/** The calls whose route objects are pages: React Router's data routers and `useRoutes`. */
const PAGE_ROUTERS = new Set(["createBrowserRouter", "createHashRouter", "createMemoryRouter", "createStaticRouter", "useRoutes"]);
const SOURCE_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".fallow", "reference", "test", "tests", "__tests__", ".claude"]);

/** `router` is null for a route-shaped call on no router the file creates: listed, and counted apart. */
interface Route { method: string; path: string; file: string; line: number; router: string | null }
interface Page { path: string; file: string; line: number }
/** A value as one markdown table cell: no row break, no column break, no control character. */
const cell = (v: string) => v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\|/g, "\\|");

interface RouteScan { routes: Route[]; pages: Page[]; unattributed: number; files: number; unparsed: string[] }

/** Every source file under `root` a route or page could be declared in: no tests, no build output, no declarations. */
function sourceFiles(root: string, dir = root, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    const full = join(dir, name);
    // lstat, not stat: a link is never followed, so a link to an ancestor
    // cannot loop the walk and a link out of the project is never read.
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    const isDir = st.isDirectory();
    if (isDir) {
      if (!SKIP_DIRS.has(name)) sourceFiles(root, full, out);
    } else if (SOURCE_EXT.has(extname(name)) && !/\.d\.[mc]?ts$|\.(test|spec)\.[^.]+$/.test(name)) {
      out.push(relative(root, full).split("\\").join("/"));
    }
  }
  return out;
}

type Node = { type: string; [k: string]: any };
const isNode = (v: unknown): v is Node => !!v && typeof (v as Node).type === "string";

/** Every node under `n`, depth first. */
function* walk(n: unknown): Generator<Node> {
  if (Array.isArray(n)) {
    for (const c of n) yield* walk(c);
    return;
  }
  if (!isNode(n)) return;
  yield n;
  for (const k of Object.keys(n)) if (k !== "type" && typeof n[k] === "object") yield* walk(n[k]);
}

/** A string the code writes literally: a string literal, or a template with no substitutions. */
function literal(n: Node | undefined): string | null {
  if (!n) return null;
  if (n.type === "Literal" && typeof n.value === "string") return n.value;
  if (n.type === "TemplateLiteral" && n.expressions.length === 0) return n.quasis[0].value.cooked;
  return null;
}

/** Whether an expression creates a router, through a chain such as `new Hono().basePath(...)`. */
function createsRouter(n: Node | undefined): boolean {
  for (let e = n; e; ) {
    if (e.type === "NewExpression" && e.callee.type === "Identifier") return ROUTER_NEW.has(e.callee.name);
    if (e.type === "CallExpression") {
      const c = e.callee;
      if (c.type === "Identifier") return ROUTER_CALL.has(c.name);
      if (c.type === "MemberExpression" && c.object.type === "Identifier" && c.object.name === "express" && c.property.name === "Router") return true;
      e = c.type === "MemberExpression" ? c.object : undefined;
      continue;
    }
    return false;
  }
  return false;
}

/** The identifier a call chain such as `router.get(...).post(...)` starts from. */
function chainRoot(n: Node): string | null {
  let e: Node = n;
  while (e.type === "CallExpression" || e.type === "MemberExpression") e = e.type === "CallExpression" ? e.callee : e.object;
  return e.type === "Identifier" ? e.name : null;
}

const joinPath = (parent: string, child: string) => (child.startsWith("/") ? child : posix.join(parent, child) || "/");

/** The JSX element a compiled call creates, when it is a `<Route>`: its props object. */
function routeElementProps(n: Node): Node | null {
  if (n.type !== "CallExpression") return null;
  const c = n.callee;
  const name = c.type === "Identifier" ? c.name : c.type === "MemberExpression" ? c.property.name : "";
  if (!/^(jsx|jsxs|jsxDEV)(_\w+)?$|^createElement$/.test(name)) return null;
  const [tag, props] = n.arguments;
  return tag?.type === "Identifier" && tag.name === "Route" && props?.type === "ObjectExpression" ? props : null;
}

const prop = (obj: Node, key: string): Node | undefined =>
  obj.properties.find((p: Node) => p.type === "Property" && !p.computed && (p.key.name ?? p.key.value) === key)?.value;

/** The pages a route tree declares, child paths joined to their parents'. */
function pagesUnder(n: Node | undefined, parent: string, out: string[]): void {
  if (!n) return;
  if (n.type === "ArrayExpression") {
    for (const el of n.elements) pagesUnder(el, parent, out);
    return;
  }
  const props = n.type === "ObjectExpression" ? n : routeElementProps(n);
  if (!props) return;
  const raw = literal(prop(props, "path"));
  const here = raw === null ? parent : joinPath(parent, raw);
  if (raw !== null) out.push(here);
  pagesUnder(prop(props, "children"), here, out);
}

/** The line the `k`-th occurrence of `pattern` starts on in `text`, or 0 when it is not there. */
function lineOf(text: string, pattern: RegExp, k: number): number {
  let i = 0;
  for (const m of text.matchAll(pattern)) if (i++ === k) return text.slice(0, m.index).split("\n").length;
  return 0;
}
const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * The routes registered on every router a file creates, the pages every
 * router declares, and how many route-shaped calls could not be attributed
 * to a router (SC-2813). Files are parsed, not matched: Bun's transpiler
 * strips the types and compiles JSX, and acorn reads what is left. A file
 * that does not parse is named in `unparsed`, so a count never hides it.
 */
function scanRoutesAndPages(root: string): RouteScan {
  const scan: RouteScan = { routes: [], pages: [], unattributed: 0, files: 0, unparsed: [] };
  for (const file of sourceFiles(root)) {
    let text: string;
    let ast: Node;
    try {
      text = readFileSync(join(root, file), "utf-8");
      const ext = extname(file);
      const loader = ext === ".tsx" ? "tsx" : ext === ".jsx" ? "jsx" : /\.[mc]?ts$/.test(ext) ? "ts" : "js";
      // Macros off: Bun's transpiler otherwise RUNS an `import … with { type:
      // "macro" }` while transforming, which would execute the scanned
      // project's code. With them off, such a file is refused and listed as
      // unparsed below.
      const js = new Bun.Transpiler({ loader, macro: false } as unknown as ConstructorParameters<typeof Bun.Transpiler>[0]).transformSync(text);
      ast = parseJs(js, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true, allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }) as unknown as Node;
    } catch {
      scan.unparsed.push(file);
      continue;
    }
    scan.files++;
    const routers = new Set<string>();
    for (const n of walk(ast)) if (n.type === "VariableDeclarator" && n.id.type === "Identifier" && createsRouter(n.init)) routers.add(n.id.name);
    const seen = new Map<string, number>();
    const nth = (key: string) => {
      const k = seen.get(key) ?? 0;
      seen.set(key, k + 1);
      return k;
    };
    for (const n of walk(ast)) {
      if (n.type !== "CallExpression" || n.callee.type !== "MemberExpression" || n.callee.computed) continue;
      const method = n.callee.property.name;
      const path = literal(n.arguments[0]);
      if (!ROUTE_METHODS.has(method) || path === null || !path.startsWith("/")) continue;
      const owner = chainRoot(n.callee.object);
      const router = owner !== null && routers.has(owner) ? owner : null;
      if (router === null) scan.unattributed++;
      const line = lineOf(text, new RegExp(`\\.\\s*${method}\\s*\\(\\s*["'\`]${esc(path)}["'\`]`, "g"), nth(`r ${method} ${path}`));
      scan.routes.push({ method: method.toUpperCase(), path, file, line, router });
    }
    const pages: string[] = [];
    for (const n of walk(ast)) {
      if (n.type === "CallExpression" && n.callee.type === "Identifier" && PAGE_ROUTERS.has(n.callee.name)) pagesUnder(n.arguments[0], "/", pages);
      else if (routeElementProps(n)) {
        // A top-level <Route>: one whose parent is not itself a <Route>,
        // which pagesUnder reaches through `children`.
        if (!isNestedRoute(ast, n)) pagesUnder(n, "/", pages);
      }
    }
    for (const page of pages) {
      const seg = page.split("/").filter(Boolean).pop() ?? "/";
      const line = lineOf(text, new RegExp(`path\\s*[=:]\\s*\\{?\\s*["'\`]/?${esc(seg === "/" ? "" : seg)}["'\`]`, "g"), nth(`p ${seg}`));
      scan.pages.push({ path: page, file, line });
    }
  }
  return scan;
}

/** Whether a compiled <Route> call sits in another <Route>'s `children`. */
function isNestedRoute(ast: Node, target: Node): boolean {
  for (const n of walk(ast)) {
    const props = routeElementProps(n);
    if (!props || n === target) continue;
    for (const c of walk(prop(props, "children"))) if (c === target) return true;
  }
  return false;
}

// ── Directory structure ──────────────────────────────────────

interface DirSummary { name: string; types: string[] }

function scanDirectories(): DirSummary[] {
  const dirs: DirSummary[] = [];
  const skip = new Set(["node_modules", ".git", "reference", "dist", "build", ".next", ".fallow"]);

  for (const entry of readdirSync(projectPath)) {
    if (entry.startsWith(".") && entry !== ".claude") continue;
    if (skip.has(entry)) continue;
    const full = join(projectPath, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
      // One binding for what a "type" is, shared with `lib/scanner.ts` and
      // `generateCodeMapInline` (#1200). The copy that used to be here
      // reported directory names — this script produced the shipped
      // `| evals/ | marcus-tdd-order, … |` row.
      dirs.push({ name: entry, types: fileExtensions(full) });
    } catch {}
  }
  // Unsorted. Row order is `directoryTable`'s single decision (#1163) —
  // this used to sort by `fileCount`, which is how the census survived one
  // indirection past being printed.
  return dirs;
}

// ── Component scanning (React) ───────────────────────────────

function scanComponents(): string[] {
  const componentDirs = [
    join(projectPath, "dashboard/src/components"),
    join(projectPath, "src/components"),
  ];
  const components: string[] = [];
  for (const dir of componentDirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".tsx") || f.endsWith(".jsx")) {
        components.push(f.replace(/\.(tsx|jsx)$/, ""));
      }
    }
  }
  return components.sort();
}

// ── Consumer-module mapping (for Marcus) ─────────────────────

interface ConsumerMapping { consumer: string; imports: string[] }

function scanConsumerModules(): ConsumerMapping[] {
  const srcDir = join(projectPath, "src");
  if (!existsSync(srcDir)) return [];
  const mappings: ConsumerMapping[] = [];

  for (const file of readdirSync(srcDir).filter(f => f.endsWith(".ts"))) {
    const content = readFileSync(join(srcDir, file), "utf-8");
    const imports: string[] = [];
    const importPattern = /from\s+["']\.\/([^"']+)["']/g;
    let m;
    while ((m = importPattern.exec(content)) !== null) {
      imports.push(m[1]);
    }
    if (imports.length > 0) {
      mappings.push({ consumer: file, imports: imports.slice(0, 8) });
    }
  }
  return mappings.sort((a, b) => b.imports.length - a.imports.length).slice(0, 15);
}

// ── Page-component mapping (for Quinn) ───────────────────────

function scanPageComponents(): Array<{ page: string; components: string[] }> {
  const pagesDir = join(projectPath, "dashboard/src/pages");
  if (!existsSync(pagesDir)) return [];
  const pages: Array<{ page: string; components: string[] }> = [];

  for (const file of readdirSync(pagesDir).filter(f => f.endsWith(".tsx"))) {
    const content = readFileSync(join(pagesDir, file), "utf-8");
    const components: string[] = [];
    const importPattern = /from\s+["'].*?\/components\/([^"']+)["']/g;
    let m;
    while ((m = importPattern.exec(content)) !== null) {
      components.push(m[1].replace(/["']$/, ""));
    }
    if (components.length > 0) {
      pages.push({ page: file.replace(/\.tsx$/, ""), components });
    }
  }
  return pages;
}

// ── Package info ─────────────────────────────────────────────

function readPackageInfo(): { name: string; deps: number; devDeps: number; scripts: string[] } {
  const pkgPath = join(projectPath, "package.json");
  if (!existsSync(pkgPath)) return { name: projectName, deps: 0, devDeps: 0, scripts: [] };
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  return {
    name: pkg.name || projectName,
    deps: Object.keys(pkg.dependencies || {}).length,
    devDeps: Object.keys(pkg.devDependencies || {}).length,
    scripts: Object.keys(pkg.scripts || {}),
  };
}

// ── Generate ─────────────────────────────────────────────────

console.log(`Scanning ${projectName}...`);

const fallowOutcome = runFallow();
const fallow = "data" in fallowOutcome ? fallowOutcome.data : null;
const fallowMissing = "unavailable" in fallowOutcome ? fallowOutcome.unavailable : null;
const routeScan = scanRoutesAndPages(projectPath);
const routes = routeScan.routes;
const routerRoutes = routes.filter(r => r.router !== null).length;
const dirs = scanDirectories();
const components = scanComponents();
const pkg = readPackageInfo();
const consumerMappings = scanConsumerModules();
const pageMappings = scanPageComponents();

console.log(
  `  Fallow: ${fallow ? `${fallow.entryPoints} entry points, ${fallow.elapsed}ms` : `UNMEASURED — ${fallowMissing?.reason}`}`,
);
console.log(`  Routes: ${routerRoutes} on routers, ${routeScan.unattributed} not attributed to one; pages: ${routeScan.pages.length}`);
console.log(`  Directories: ${dirs.length}`);
console.log(`  Components: ${components.length}`);
console.log(`  Module mappings: ${consumerMappings.length}`);
console.log(`  Page mappings: ${pageMappings.length}`);

// ── Build CODE-MAP.md ────────────────────────────────────────

let headSha = "unknown";
try {
  const result = Bun.spawnSync(["git", "-C", projectPath, "rev-parse", "HEAD"]);
  headSha = result.stdout.toString().trim().substring(0, 8);
} catch {}

const sections: string[] = [];

sections.push(`---
doc-type: code-map
status: generated
updated: ${today}
scanned-at-sha: ${headSha}
generator: rungate/scripts/generate-code-map.ts
---

# Code Map — ${pkg.name}

Auto-generated architecture snapshot. Re-run \`bun generate-code-map.ts .\` to refresh.
Regenerate when src/ has commits since scanned-at-sha.

${FRESHNESS_NOTICE}`);

// Summary
sections.push(`## Summary

| Metric | Count |
|--------|-------|
| Source directories | ${dirs.length} |
| Dependencies | ${pkg.deps} |
| Dev dependencies | ${pkg.devDeps} |
| API routes | ${routerRoutes} |
| Route calls not attributed to a router | ${routeScan.unattributed} |
| Pages | ${routeScan.pages.length} |
| React components | ${components.length} |
| Entry points (fallow) | ${fallow ? fallow.entryPoints : "UNMEASURED"} |
| Unused files | ${fallow ? fallow.unusedFiles.length : "UNMEASURED"} |
| Unused exports | ${fallow ? fallow.unusedExports.length : "UNMEASURED"} |
| Circular dependencies | ${fallow ? fallow.circularDeps.length : "UNMEASURED"} |
| Module import mappings | ${consumerMappings.length} |
| Page-component mappings | ${pageMappings.length} |`);

// Directory structure. No `Files` column, and the order is `directoryTable`'s
// rather than the scanner's — see `FRESHNESS_NOTICE` and #1163.
sections.push(`## Directory Structure

${directoryTable(dirs)}`);

// Routes: every route on every router a file creates, and how many
// route-shaped calls could not be attributed to one (SC-2813).
if (routes.length > 0 || routeScan.unattributed > 0 || routeScan.unparsed.length > 0) {
  const byMethod: Record<string, Route[]> = {};
  for (const r of routes) {
    (byMethod[r.method] ||= []).push(r);
  }
  let routeTable = "## API Routes\n\n";
  routeTable += `${routerRoutes} route(s) on the routers ${routeScan.files} parsed file(s) create. ${routeScan.unattributed} route-shaped call(s) could not be attributed to a router a file creates; they are listed with — as their router.\n\n`;
  if (routeScan.unparsed.length) routeTable += `UNMEASURED: ${routeScan.unparsed.length} file(s) could not be parsed, so their routes and pages are not counted: ${routeScan.unparsed.map(cell).join(", ")}\n\n`;
  for (const [method, methodRoutes] of Object.entries(byMethod).sort()) {
    routeTable += `### ${method} (${methodRoutes.length})\n\n`;
    routeTable += "| Path | Router | File | Line |\n|------|--------|------|------|\n";
    for (const r of methodRoutes.sort((a, b) => a.path.localeCompare(b.path) || a.file.localeCompare(b.file))) {
      routeTable += `| ${cell(r.path)} | ${cell(r.router ?? "—")} | ${cell(r.file)} | ${r.line} |\n`;
    }
    routeTable += "\n";
  }
  sections.push(routeTable.trim());
}

// Pages: every page a router declares, child paths joined to their parents'.
if (routeScan.pages.length > 0) {
  let pageTable = `## Pages (${routeScan.pages.length})\n\n| Path | File | Line |\n|------|------|------|\n`;
  for (const p of [...routeScan.pages].sort((a, b) => a.path.localeCompare(b.path) || a.file.localeCompare(b.file))) {
    pageTable += `| ${cell(p.path)} | ${cell(p.file)} | ${p.line} |\n`;
  }
  sections.push(pageTable.trim());
}

// Components
if (components.length > 0) {
  sections.push(`## React Components (${components.length})

${components.map(c => `- ${c}`).join("\n")}`);
}

// Module import mappings (for Marcus — shows dependency chains)
if (consumerMappings.length > 0) {
  let modSection = `## Module Dependencies (top ${consumerMappings.length})\n\n`;
  modSection += "Which modules depend on which — for cascade impact analysis.\n\n";
  modSection += "| Module | Imports From |\n|--------|-------------|\n";
  for (const cm of consumerMappings) {
    modSection += `| ${cm.consumer} | ${cm.imports.join(", ")} |\n`;
  }
  sections.push(modSection.trim());
}

// Page-component mappings (for Quinn — shows which components are on each page)
if (pageMappings.length > 0) {
  let pageSection = `## Page → Component Map (for UI testing)\n\n`;
  pageSection += "Which components render on each page — for targeted UI verification.\n\n";
  for (const pm of pageMappings) {
    pageSection += `### ${pm.page}\n\n`;
    pageSection += pm.components.map(c => `- ${c}`).join("\n") + "\n\n";
  }
  sections.push(pageSection.trim());
}

// Health (fallow findings)
if (fallow) {
  let health = "## Code Health (fallow)\n\n";

  if (fallow.circularDeps.length > 0) {
    health += `### Circular Dependencies (${fallow.circularDeps.length})\n\n`;
    for (const cd of fallow.circularDeps.slice(0, 10)) {
      health += `- ${cd.files.join(" → ")}\n`;
    }
    if (fallow.circularDeps.length > 10) health += `- ... and ${fallow.circularDeps.length - 10} more\n`;
    health += "\n";
  }

  if (fallow.unusedFiles.length > 0) {
    health += `### Unused Files (${fallow.unusedFiles.length})\n\n`;
    for (const f of fallow.unusedFiles.slice(0, 15)) {
      health += `- ${f}\n`;
    }
    if (fallow.unusedFiles.length > 15) health += `- ... and ${fallow.unusedFiles.length - 15} more\n`;
    health += "\n";
  }

  sections.push(health.trim());
} else if (fallowMissing) {
  // Named, not omitted. A missing section and a section reporting nothing
  // wrong are the same absence to a reader, and the reader of a CODE-MAP is
  // an agent deciding whether this project has dead code.
  sections.push(fallowUnmeasuredNotice(fallowMissing));
}

// Scripts
if (pkg.scripts.length > 0) {
  sections.push(`## Package Scripts

${pkg.scripts.map(s => `- \`${s}\``).join("\n")}`);
}

const codeMap = sections.join("\n\n") + "\n";
const outPath = join(projectPath, "CODE-MAP.md");
writeFileSync(outPath, codeMap);
console.log(`\nWritten: ${outPath} (${codeMap.split("\n").length} lines)`);
