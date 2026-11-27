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
/** Directories skipped wherever they sit: dependencies, history, tests and agent files. */
const SKIP_ANY_DEPTH = new Set(["node_modules", ".git", "test", "tests", "__tests__", ".claude"]);
/** Build output and archives, skipped only at the project root: a source folder of the same name below it is read (#2911 review). */
const SKIP_AT_ROOT = new Set(["dist", "build", "out", "coverage", ".next", ".fallow", "reference"]);
/** The path a route or page is listed under when the code does not write it literally. */
const COMPUTED = "(computed)";
const COMPUTED_SEGMENT = "{computed}";

/**
 * `router` is null for a route-shaped call on no router the file creates:
 * listed, and counted apart. `computed` marks a path the code does not write
 * literally, listed as `(computed)`.
 */
interface Route { method: string; path: string; file: string; line: number; router: string | null }
interface Page { path: string; file: string; line: number }
/** A value as one markdown table cell: no row break, no column break, no control character. */
const cell = (v: string) => v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\|/g, "\\|");

interface RouteScan {
  routes: Route[];
  pages: Page[];
  unattributed: number;
  /** Routes on a router, and pages, whose path is not written literally. */
  computed: number;
  files: number;
  unparsed: string[];
  /** Page-router calls whose routes this reader could not see, such as an imported array. */
  pageRoutersUnread: string[];
}

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
    if (st.isDirectory()) {
      if (!SKIP_ANY_DEPTH.has(name) && !(dir === root && SKIP_AT_ROOT.has(name))) sourceFiles(root, full, out);
    } else if (SOURCE_EXT.has(extname(name)) && !/\.d\.[mc]?ts$|\.(test|spec)\.[^.]+$/.test(name)) {
      out.push(relative(root, full).split("\\").join("/"));
    }
  }
  return out;
}

type Node = { type: string; [k: string]: any };
const isNode = (v: unknown): v is Node => !!v && typeof (v as Node).type === "string";
const isFunction = (n: Node) => n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression";

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

/** The expression at the base of a chain such as `new Hono().basePath(...)` that creates a router, or null. */
function routerBase(n: Node | undefined): Node | null {
  for (let e = n; e; ) {
    if (e.type === "NewExpression") return e.callee.type === "Identifier" && ROUTER_NEW.has(e.callee.name) ? e : null;
    if (e.type !== "CallExpression") return null;
    const c = e.callee;
    if (c.type === "Identifier") return ROUTER_CALL.has(c.name) ? e : null;
    if (c.type === "MemberExpression" && c.object.type === "Identifier" && c.object.name === "express" && c.property.name === "Router") return e;
    e = c.type === "MemberExpression" ? c.object : undefined;
  }
  return null;
}

/** How a router made inline is named in the code map: `new Hono()`, `express()`, `express.Router()`. */
function routerLabel(base: Node): string {
  if (base.type === "NewExpression") return `new ${base.callee.name}()`;
  return base.callee.type === "Identifier" ? `${base.callee.name}()` : "express.Router()";
}

/** One binding a scope holds: whether it is a router the file creates, and its initial value. */
type Binding = { router: boolean; init?: Node };
type Scope = Map<string, Binding>;

/** The names a pattern binds: `a`, `{ a, b: c }`, `[a, ...b]`, `a = 1`. */
function patternNames(p: Node | null | undefined, out: string[] = []): string[] {
  if (!p) return out;
  if (p.type === "Identifier") out.push(p.name);
  else if (p.type === "ObjectPattern") for (const q of p.properties) patternNames(q.type === "RestElement" ? q.argument : q.value, out);
  else if (p.type === "ArrayPattern") for (const q of p.elements) patternNames(q, out);
  else if (p.type === "RestElement") patternNames(p.argument, out);
  else if (p.type === "AssignmentPattern") patternNames(p.left, out);
  return out;
}

/** Fill `scope` with what `body` declares, not looking into the functions inside it, which have scopes of their own. */
function declareIn(body: unknown, scope: Scope): void {
  if (Array.isArray(body)) return body.forEach(b => declareIn(b, scope));
  if (!isNode(body)) return;
  if (body.type === "VariableDeclarator") {
    const simple = body.id.type === "Identifier";
    for (const name of patternNames(body.id)) scope.set(name, { router: simple && routerBase(body.init) !== null, init: simple ? body.init : undefined });
    return declareIn(body.init, scope);
  }
  if (body.type === "ImportDeclaration") {
    for (const sp of body.specifiers) scope.set(sp.local.name, { router: false });
    return;
  }
  if (isFunction(body)) {
    if (body.type === "FunctionDeclaration" && body.id) scope.set(body.id.name, { router: false });
    return;
  }
  if (body.type === "ClassDeclaration" && body.id) scope.set(body.id.name, { router: false });
  for (const k of Object.keys(body)) if (k !== "type" && typeof body[k] === "object") declareIn(body[k], scope);
}

/**
 * Visit every node with the scopes in force at it, so a name resolves to
 * the declaration that is really in scope there: a parameter named `app`
 * is not the module's `app` router (#2911 review).
 */
function visitScoped(n: unknown, scopes: Scope[], on: (n: Node, resolve: (name: string) => Binding | undefined) => void): void {
  if (Array.isArray(n)) return n.forEach(c => visitScoped(c, scopes, on));
  if (!isNode(n)) return;
  let inner = scopes;
  if (isFunction(n)) {
    const s: Scope = new Map();
    if (n.type === "FunctionExpression" && n.id) s.set(n.id.name, { router: false });
    for (const p of n.params) for (const name of patternNames(p)) s.set(name, { router: false });
    declareIn(n.body, s);
    inner = [...scopes, s];
  }
  on(n, name => {
    for (let i = inner.length - 1; i >= 0; i--) if (inner[i].has(name)) return inner[i].get(name);
    return undefined;
  });
  for (const k of Object.keys(n)) if (k !== "type" && typeof n[k] === "object") visitScoped(n[k], inner, on);
}

/** The router a call chain such as `router.get(...).post(...)` or `new Hono().get(...)` is made on, by name or by label, or null. */
function routerOf(n: Node, resolve: (name: string) => Binding | undefined): string | null {
  const base = routerBase(n);
  if (base) return routerLabel(base);
  let e: Node = n;
  while (e.type === "CallExpression" || e.type === "MemberExpression") e = e.type === "CallExpression" ? e.callee : e.object;
  return e.type === "Identifier" && resolve(e.name)?.router ? e.name : null;
}

const joinPath = (parent: string, child: string) => (child.startsWith("/") ? child : posix.join(parent, child) || "/");

/** The name a compiled JSX call is made through: `jsx`, `jsxs`, `jsxDEV` (with Bun's suffix) or `createElement`, or "". */
function jsxCallee(n: Node): string {
  const c = n.callee;
  const name = c.type === "Identifier" ? c.name : c.type === "MemberExpression" ? c.property.name : "";
  return /^(jsx|jsxs|jsxDEV)(_\w+)?$|^createElement$/.test(name) ? name : "";
}
const isJsxCall = (n: Node) => jsxCallee(n) !== "";

/**
 * The children a compiled element passes as arguments. Only the classic
 * runtime does, `createElement(Route, props, ...children)`; the automatic
 * runtime's extra arguments are its key, static flag, source and `this`.
 */
const childArguments = (n: Node): Node[] => (jsxCallee(n) === "createElement" ? n.arguments.slice(2) : []);

/** The JSX element a compiled call creates, when it is a `<Route>`: its props object. */
function routeElementProps(n: Node): Node | null {
  if (n.type !== "CallExpression" || !isJsxCall(n)) return null;
  const [tag, props] = n.arguments;
  return tag?.type === "Identifier" && tag.name === "Route" && props?.type === "ObjectExpression" ? props : null;
}

const prop = (obj: Node, key: string): Node | undefined =>
  obj.properties.find((p: Node) => p.type === "Property" && !p.computed && (p.key.name ?? p.key.value) === key)?.value;

/** What a page-tree walk collects: each page, and each part of a tree it could not see. */
interface PageWalk {
  pages: Array<{ path: string; raw: string | null }>;
  unread: string[];
  resolve: (name: string) => Binding | undefined;
  file: string;
}

/**
 * The pages a route tree declares, child paths joined to their parents'. A
 * path the code does not write literally is the segment `{computed}`, so
 * its children keep their place under it. A tree named by a variable is read
 * from that variable's value in the file; one this reader cannot see, such
 * as an imported array or a function's result, is recorded, never dropped
 * (#2911 review).
 */
function pagesUnder(n: Node | undefined | null, parent: string, w: PageWalk): void {
  if (!n) return;
  if (n.type === "Identifier") {
    const init = w.resolve(n.name)?.init;
    if (init) pagesUnder(init, parent, w);
    else w.unread.push(`${w.file}: ${n.name} under ${parent}`);
    return;
  }
  if (n.type === "ArrayExpression") {
    for (const el of n.elements) pagesUnder(el?.type === "SpreadElement" ? el.argument : el, parent, w);
    return;
  }
  const props = n.type === "ObjectExpression" ? n : routeElementProps(n);
  if (!props) {
    // A JSX child that is not a <Route> (a fragment, text) holds no pages;
    // anything else that yields routes is a tree this reader cannot see.
    if (!(n.type === "CallExpression" && isJsxCall(n)) && n.type !== "Literal") w.unread.push(`${w.file}: an expression under ${parent}`);
    return;
  }
  const pathNode = prop(props, "path");
  const raw = literal(pathNode);
  let here = parent;
  if (pathNode !== undefined) {
    here = joinPath(parent, raw ?? COMPUTED_SEGMENT);
    w.pages.push({ path: here, raw });
  }
  pagesUnder(prop(props, "children"), here, w);
  // The classic runtime passes children as arguments: createElement(Route, props, ...children).
  if (n.type === "CallExpression") for (const child of childArguments(n)) pagesUnder(child, here, w);
}

/**
 * The line the `k`-th occurrence of `pattern` starts on in `text`, or 0 when
 * it cannot be located for certain: when the source holds more occurrences
 * than the compiled code, some are in comments and the `k`-th may be one of
 * them, so no line is guessed (#2911 review).
 */
function lineOf(text: string, compiled: string, pattern: RegExp, k: number): number {
  const inText = [...text.matchAll(pattern)];
  if (inText.length !== [...compiled.matchAll(pattern)].length || k >= inText.length) return 0;
  return text.slice(0, inText[k].index).split("\n").length;
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
  const scan: RouteScan = { routes: [], pages: [], unattributed: 0, computed: 0, files: 0, unparsed: [], pageRoutersUnread: [] };
  for (const file of sourceFiles(root)) {
    let text: string;
    let js: string;
    let ast: Node;
    try {
      text = readFileSync(join(root, file), "utf-8");
      const ext = extname(file);
      const loader = ext === ".tsx" ? "tsx" : ext === ".jsx" ? "jsx" : /\.[mc]?ts$/.test(ext) ? "ts" : "js";
      // Macros off: Bun's transpiler otherwise RUNS an `import … with { type:
      // "macro" }` while transforming, which would execute the scanned
      // project's code. With them off, such a file is refused and listed as
      // unparsed below.
      js = new Bun.Transpiler({ loader, macro: false } as unknown as ConstructorParameters<typeof Bun.Transpiler>[0]).transformSync(text);
      ast = parseJs(js, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true, allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }) as unknown as Node;
    } catch {
      scan.unparsed.push(file);
      continue;
    }
    scan.files++;
    const top: Scope = new Map();
    declareIn(ast.body, top);
    const seen = new Map<string, number>();
    const nth = (key: string) => {
      const k = seen.get(key) ?? 0;
      seen.set(key, k + 1);
      return k;
    };
    const pages: Array<{ path: string; raw: string | null }> = [];
    visitScoped(ast, [top], (n, resolve) => {
      if (n.type !== "CallExpression") return;
      const c = n.callee;
      const walkFrom = (tree: Node | undefined) => pagesUnder(tree, "/", { pages, unread: scan.pageRoutersUnread, resolve, file });
      if (c.type === "Identifier" && PAGE_ROUTERS.has(c.name)) {
        if (n.arguments[0]) walkFrom(n.arguments[0]);
        else scan.pageRoutersUnread.push(`${file}: ${c.name}() with no routes`);
        return;
      }
      if (routeElementProps(n)) {
        // A top-level <Route>: one whose parent is not itself a <Route>,
        // which pagesUnder reaches through `children` or child arguments.
        if (!isNestedRoute(ast, n)) walkFrom(n);
        return;
      }
      // A route is a method call with a path and at least one handler: an
      // express `app.get("view engine")` with one argument reads a setting.
      if (c.type !== "MemberExpression" || c.computed || !ROUTE_METHODS.has(c.property.name) || n.arguments.length < 2) return;
      const method = c.property.name;
      const lit = literal(n.arguments[0]);
      const router = routerOf(c.object, resolve);
      if (router === null && (lit === null || !lit.startsWith("/"))) return;
      if (router === null) scan.unattributed++;
      if (lit === null) scan.computed++;
      const path = lit ?? COMPUTED;
      // A computed path is located as the call whose first argument is not a string.
      const pattern = new RegExp(`\\.\\s*${method}\\s*\\(\\s*${lit === null ? "(?![\"'\\`])" : `["'\`]${esc(lit)}["'\`]`}`, "g");
      scan.routes.push({ method: method.toUpperCase(), path, file, line: lineOf(text, js, pattern, nth(`r ${method} ${path}`)), router });
    });
    for (const page of pages) {
      if (page.raw === null) {
        scan.computed++;
        scan.pages.push({ path: page.path, file, line: 0 });
        continue;
      }
      const seg = page.raw.replace(/^\//, "");
      const line = lineOf(text, js, new RegExp(`path\\s*[=:]\\s*\\{?\\s*["'\`]/?${esc(seg)}["'\`]`, "g"), nth(`p ${seg}`));
      scan.pages.push({ path: page.path, file, line });
    }
  }
  return scan;
}

/** Whether a compiled <Route> call sits in another <Route>'s children, as a prop or as a classic-runtime argument. */
function isNestedRoute(ast: Node, target: Node): boolean {
  for (const n of walk(ast)) {
    const props = routeElementProps(n);
    if (!props || n === target) continue;
    for (const c of walk([prop(props, "children"), ...childArguments(n)])) if (c === target) return true;
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
if (routes.length > 0 || routeScan.unparsed.length > 0 || routeScan.pageRoutersUnread.length > 0) {
  const byMethod: Record<string, Route[]> = {};
  for (const r of routes) {
    (byMethod[r.method] ||= []).push(r);
  }
  let routeTable = "## API Routes\n\n";
  routeTable += `${routerRoutes} route(s) on the routers ${routeScan.files} parsed file(s) create. ${routeScan.unattributed} route-shaped call(s) could not be attributed to a router a file creates; they are listed with — as their router. ${routeScan.computed} route or page path(s) are not written literally and are listed as ${COMPUTED} or ${COMPUTED_SEGMENT}. A line of 0 means the line could not be located for certain.\n\n`;
  if (routeScan.pageRoutersUnread.length) routeTable += `UNMEASURED: ${routeScan.pageRoutersUnread.length} part(s) of a page tree could not be seen, so their pages are not listed: ${routeScan.pageRoutersUnread.map(cell).join(", ")}\n\n`;
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
