/**
 * surface-lint.ts — lints that read what a consumer's agents load, as the
 * scaffold RENDERED it (#2600, ADR-024 decision 2, SC-2799).
 *
 * ADR-024 found four template defects that only existed in rendered output: a
 * brief pointing at a table the rendered AGENTS.md does not have, a count right
 * at render time and wrong a commit later, a test-only marker that leaked into
 * the shipped template. Each template was fine read alone, so a lint over
 * `templates/` passes on all of them. The lints here therefore take a
 * {@link RenderedSurface}, and the only way to get one is
 * {@link readRenderedSurface}, which refuses a tree the scaffold has not
 * rendered — `templates/`, or a fixture nobody scaffolded.
 *
 * rungate's own CI renders the scaffold into fixture consumers and runs these
 * over the result (`test/rendered-surface.test.ts`). A consumer's tree is
 * already rendered, so the same reader serves the consumer-side audit
 * (SC-2805) unchanged.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";

import { resolveConfig } from "./config-loader";
import { readFences } from "./markdown-fence";
import { isPathScoped } from "../scripts/check-instruction-surface";

/** The files a consumer's agents load or are pointed at, read whole, when the scaffold rendered them. */
export const SURFACE_FILES = ["CLAUDE.md", "AGENTS.md", ".github/copilot-instructions.md"] as const;

/** The directories whose `*.md` files are the rest of that surface. */
export const SURFACE_DIRS = [".claude/rules", ".claude/agents", ".claude/commands"] as const;

/**
 * What a rendered tree must hold before anything here will lint it. Each is
 * something only a scaffold run leaves; `templates/` and an unscaffolded
 * fixture each lack at least two.
 */
export const RENDERED_MARKERS = ["a rungate config", "AGENTS.md", ".claude/agents/*.md", ".claude/rules/*.md"] as const;

export interface RenderedSurface {
  /** The rendered tree, absolute. */
  readonly root: string;
  /** Every surface file, by path relative to `root` with `/` separators, to its text. */
  readonly files: ReadonlyMap<string, string>;
}

export interface SurfaceFinding {
  /** Path relative to the rendered root, as in {@link RenderedSurface.files}. */
  file: string;
  message: string;
}

export interface SurfaceLint {
  name: string;
  check(surface: RenderedSurface): SurfaceFinding[];
}

/** A finding as {@link lintRenderedTree} reports it: which lint said so. */
export interface NamedSurfaceFinding extends SurfaceFinding {
  lint: string;
}

/** Refused rather than linted: a tree the scaffold has not rendered. */
export class NotRenderedSurface extends Error {
  constructor(root: string, missing: readonly string[]) {
    super(
      `UNMEASURED: ${root} is not a rendered consumer, so nothing here lints it — missing ${missing.join(", ")}. ` +
        "Lints read what the scaffold rendered, never the templates (ADR-024 decision 2): render the scaffold into it first.",
    );
    this.name = "NotRenderedSurface";
  }
}

/**
 * Every `.md` file under `dir`, at any depth (review, PR #2632). Claude Code
 * discovers rules and commands in subdirectories, and the surface measurement
 * walks `.claude/rules` recursively, so a top-level listing skipped a nested
 * rule for every lint while the measurement counted it. Agents are walked
 * the same way, so no lint depends on which directory it is reading.
 */
function mdIn(root: string, dir: string): string[] {
  const at = join(root, dir);
  if (!existsSync(at) || !statSync(at).isDirectory()) return [];
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const e of readdirSync(abs, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      if (e.isDirectory()) walk(join(abs, e.name), `${rel}/${e.name}`);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(`${rel}/${e.name}`);
    }
  };
  walk(at, dir);
  return out;
}

/**
 * The rendered surface under `root`, or a refusal naming what a rendered tree
 * would have and this one does not.
 */
export function readRenderedSurface(root: string): RenderedSurface {
  const abs = resolve(root);
  const missing: string[] = [];
  if (resolveConfig(abs).status === "absent") missing.push(RENDERED_MARKERS[0]);
  if (!existsSync(join(abs, "AGENTS.md"))) missing.push(RENDERED_MARKERS[1]);
  if (mdIn(abs, ".claude/agents").length === 0) missing.push(RENDERED_MARKERS[2]);
  if (mdIn(abs, ".claude/rules").length === 0) missing.push(RENDERED_MARKERS[3]);
  if (missing.length > 0) throw new NotRenderedSurface(abs, missing);

  const files = new Map<string, string>();
  for (const f of SURFACE_FILES) if (existsSync(join(abs, f))) files.set(f, readFileSync(join(abs, f), "utf-8"));
  for (const d of SURFACE_DIRS) for (const f of mdIn(abs, d)) files.set(f, readFileSync(join(abs, f), "utf-8"));
  return { root: abs, files };
}

/** A surface file, or any file that exists inside the rendered root. */
function inRenderedTree(surface: RenderedSurface, file: string): boolean {
  if (surface.files.has(file)) return true;
  const at = resolve(surface.root, file);
  const rel = relative(surface.root, at);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && existsSync(at);
}

/**
 * Run `lints` over the tree at `root`, as rendered.
 *
 * Two refusals, both about WHERE a lint looked. The tree must be rendered
 * ({@link readRenderedSurface}). And every finding must name a file in that
 * tree: a lint that reports on `templates/agent-briefs/marcus.md` read the
 * template, whatever its input was, and its finding is refused rather than
 * reported as if it described the consumer.
 */
export function lintRenderedTree(root: string, lints: readonly SurfaceLint[]): NamedSurfaceFinding[] {
  const surface = readRenderedSurface(root);
  const out: NamedSurfaceFinding[] = [];
  for (const lint of lints) {
    for (const f of lint.check(surface)) {
      if (!inRenderedTree(surface, f.file)) {
        throw new Error(
          `lint ${lint.name} reported on ${f.file}, which is not in the rendered tree at ${surface.root} — it read something other than what was rendered`,
        );
      }
      out.push({ lint: lint.name, ...f });
    }
  }
  return out;
}

// ── SC-2800: what a brief or rule tells its agent to read exists ──────────

/**
 * Where the rungate package itself sits. A rendered brief may send its agent
 * into `node_modules/rungate/…`; a consumer has that once it installs the
 * package, and a fixture render does not, so those targets are looked up here.
 */
export const PACKAGE_ROOT = dirname(import.meta.dir);

/** A place a rendered file tells its agent to read. */
export interface ReadTarget {
  /** The surface file the instruction is in. */
  file: string;
  line: number;
  /** The path it names, as written. */
  target: string;
  /** Set when the instruction names a table in that file, e.g. "the Specs table". */
  table: string | null;
}

/**
 * The words that make a sentence an instruction to read, rather than a
 * mention. "Read `x`", "see `x`", "find it … in `x`", "look it up in `x`".
 */
const READ_VERB = /\b(?:read|see|consult|open|check|look(?:\s+\w+)?\s+(?:up\s+)?in|find\b[^.`\n]{0,60}?\bin|route[sd]?\s+to)\s*$/i;

/** A backticked token that names a file: a path with a slash, or a known extension. */
const PATHISH = /^(?![a-z]+:\/\/)[\w.@-]+(?:\/[\w.@-]+)*(?:\.(?:md|json|ya?ml|ts|js|txt)|\/)$/;

/** "the Specs table in `f`" / "the Specs table in f.md" / "f.md Specs table". */
const TABLE_IN = /\b([A-Z][\w-]*)\s+table\s+in\s+`?([\w./@-]+\.md)`?/g;
const FILE_TABLE = /`?([\w./@-]+\.md)`?\s+([A-Z][\w-]*)\s+table\b/g;

/** Every read instruction in the surface, with the target it names. */
export function readTargets(surface: RenderedSurface): ReadTarget[] {
  const out: ReadTarget[] = [];
  for (const [file, text] of surface.files) {
    const lines = text.split("\n");
    // A fenced block is an example to run or copy, not an instruction to read.
    // Which lines are fenced is `readFences`'s to say (#2130), not this file's.
    const { roles } = readFences(lines);
    lines.forEach((ln, i) => {
      if (roles[i] !== "prose") return;
      const seen = new Set<string>();
      for (const re of [TABLE_IN, FILE_TABLE]) {
        re.lastIndex = 0;
        for (const m of ln.matchAll(re)) {
          const [table, target] = re === TABLE_IN ? [m[1], m[2]] : [m[2], m[1]];
          out.push({ file, line: i + 1, target, table });
          seen.add(target);
        }
      }
      // Backticked, or bare: "Check .claude/rungate/config.json `pages` field"
      // sends the agent to a file as surely as a backticked path does. A bare
      // token must hold a slash, so a word ending in ".md" in prose is not one.
      for (const m of ln.matchAll(/`([^`\s]+)`|(?<![`\w/.])(\.?[\w@-]+(?:\/[\w.@-]+)+\.(?:md|json|ya?ml|ts|js|txt))(?![`\w/])/g)) {
        const target = m[1] ?? m[2];
        if (seen.has(target) || !PATHISH.test(target)) continue;
        if (!READ_VERB.test(ln.slice(0, m.index))) continue;
        seen.add(target);
        out.push({ file, line: i + 1, target, table: null });
      }
    });
  }
  return out;
}

/** Where a target named in a rendered file resolves, or null when nowhere. */
function resolveTarget(surface: RenderedSurface, target: string, packageRoot: string): string | null {
  const local = resolve(surface.root, target);
  if (existsSync(local)) return local;
  const pkg = target.match(/^node_modules\/rungate\/(.+)$/);
  if (pkg && existsSync(join(packageRoot, pkg[1]))) return join(packageRoot, pkg[1]);
  return null;
}

/** Whether a markdown file holds a table its heading or header row calls `name`. */
function hasTableNamed(path: string, name: string): boolean {
  const stem = name.toLowerCase().replace(/s$/, "");
  const lines = readFileSync(path, "utf-8").split("\n");
  let heading = "";
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^#{1,6}\s/.test(ln)) heading = ln.toLowerCase();
    const isHeader = /^\s*\|.*\|\s*$/.test(ln) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "");
    if (isHeader && (heading.includes(stem) || ln.toLowerCase().includes(stem))) return true;
  }
  return false;
}

/**
 * SC-2800: every file, and every table in a file, that a rendered brief or
 * rule tells its agent to read exists in the rendered tree — or, for
 * `node_modules/rungate/…`, in the package the consumer installs.
 *
 * #2565 is the case it exists for: the discovery brief sent its agent to "the
 * AGENTS.md Specs table", the rendered AGENTS.md has no such table, and the
 * brief omits CLAUDE.md, so the agent had no second way to find the spec.
 */
export function danglingReadTargets(packageRoot: string = PACKAGE_ROOT): SurfaceLint {
  return {
    name: "dangling-read-target",
    check(surface) {
      const findings: SurfaceFinding[] = [];
      for (const t of readTargets(surface)) {
        const at = resolveTarget(surface, t.target, packageRoot);
        if (at === null) {
          findings.push({ file: t.file, message: `line ${t.line} tells the agent to read ${t.target}, which is not in the rendered tree` });
        } else if (t.table !== null && !hasTableNamed(at, t.table)) {
          findings.push({ file: t.file, message: `line ${t.line} sends the agent to the ${t.table} table in ${t.target}, which has no table by that name` });
        }
      }
      return findings;
    },
  };
}

// ── SC-2801: no template artifact survives into a rendered file ──────────

/** A template variable the brief generator substitutes: `${NAME}`. */
const TEMPLATE_VARIABLE = /\$\{[A-Z_][A-Z0-9_]*\}/g;

/** The test-only marker SC-354 used to append to the shipped template (#2567). */
const TEST_ONLY_MARKER = /CANARY_MARKER_FOR_\w+/g;

/**
 * SC-2801: no rendered file carries an unexpanded `${…}`, the brief
 * templates' test-only marker, or a numbered list that skips.
 *
 * All three reached consumers in #2567, and each was invisible in its
 * template: a bare `${SOURCE_DIRS}` the generator never substituted, a
 * `CANARY_MARKER_FOR_SC354` heading a test wrote into the shipped template
 * and committed, and lists numbered 1, 3 where a template section was cut.
 *
 * A fenced block is an example and is not read, so a shell `${HOME}` in
 * one is not a finding. Inline code is read: "Read `${CONFIG_FILE}`" is
 * the unexpanded variable an agent would be handed. A list may restart at 1
 * or number every item 1; what it may not do is jump. A paragraph ends a
 * list, so the list after it is a new one, whatever it starts at. A fence
 * does not: an example command inside a step is part of that step, so a
 * list numbered 1, 3 around one is still a skip.
 */
export function templateArtifacts(): SurfaceLint {
  return {
    name: "template-artifact",
    check(surface) {
      const findings: SurfaceFinding[] = [];
      for (const [file, text] of surface.files) {
        // The last number seen at each indent, so a nested list is checked
        // against itself and the list around it resumes where it left off.
        const lastAt = new Map<number, number>();
        const lines = text.split("\n");
        const { roles } = readFences(lines);
        lines.forEach((ln, i) => {
          const at = `line ${i + 1}`;
          for (const m of ln.match(TEST_ONLY_MARKER) ?? []) findings.push({ file, message: `${at} carries the test-only marker ${m}` });
          if (roles[i] !== "prose") return;
          for (const v of ln.match(TEMPLATE_VARIABLE) ?? []) {
            findings.push({ file, message: `${at} carries ${v}, a template variable the render never filled` });
          }
          const item = ln.match(/^(\s*)(\d+)\.\s/);
          if (item) {
            const n = Number(item[2]);
            const indent = item[1].length;
            const before = lastAt.get(indent);
            if (before !== undefined && n !== before + 1 && n !== 1) {
              findings.push({ file, message: `${at} numbers a list item ${n} straight after ${before}` });
            }
            lastAt.set(indent, n);
            // Back at this depth, any deeper list has ended.
            for (const d of [...lastAt.keys()]) if (d > indent) lastAt.delete(d);
          } else if (ln.trim() !== "" && !/^\s/.test(ln)) {
            // An unindented line that is not a list item ends the list.
            lastAt.clear();
          }
        });
      }
      return findings;
    },
  };
}

// ── SC-2802: no always-loaded rule bakes in a count of files ──────────────

/**
 * A count of something a commit adds one of: "(3 files)", "12 specs", "4 ADRs",
 * "1,218 files". The number stands alone (#2635): not after a letter, digit,
 * `-` or `#`, so "CONFIG-2, workflow" and "#1506, ADR-015" are ids, not
 * counts; and it is plain digits or grouped in thousands, never ending on a
 * comma.
 */
const FILE_COUNT = /(?<![\w#-])(?:\d{1,3}(?:,\d{3})+|\d+)\s+(?:markdown\s+|source\s+|test\s+)?(?:files?|specs?|docs?|documents?|rules?|tests?|ADRs?|briefs?|agents?|commands?|workflows?|director(?:y|ies))\b/g;

/** The rendered files every session loads: CLAUDE.md, AGENTS.md, and each rule that declares no `paths:`. */
function alwaysLoaded(file: string, text: string): boolean {
  if (file === "CLAUDE.md" || file === "AGENTS.md") return true;
  return file.startsWith(".claude/rules/") && !isPathScoped(text);
}

/**
 * SC-2802: no always-loaded rendered rule states a count of files that adding
 * one file would change.
 *
 * #2566: docs-routing loads in every session and baked `(N files)` in at
 * scaffold time, so it was right on the day it was written and wrong after the
 * next commit that added a doc. One consumer's table read `specs/ (1 files)`.
 *
 * Only the always-loaded surface: a path-scoped rule loads beside a matching
 * file and a brief loads when its agent runs, and `isPathScoped` — the same
 * reading the surface measurement uses — decides which rules are which.
 * Fenced examples are not read.
 */
export function staleCounts(): SurfaceLint {
  return {
    name: "stale-count",
    check(surface) {
      const findings: SurfaceFinding[] = [];
      for (const [file, text] of surface.files) {
        if (!alwaysLoaded(file, text)) continue;
        const lines = text.split("\n");
        const { roles } = readFences(lines);
        lines.forEach((ln, i) => {
          if (roles[i] !== "prose") return;
          for (const m of ln.matchAll(FILE_COUNT)) {
            findings.push({ file, message: `line ${i + 1} states "${m[0]}", a count the next commit can make wrong, in a rule every session loads` });
          }
        });
      }
      return findings;
    },
  };
}

/**
 * Every rendered-surface lint, in one list. CI runs the list over its fixture
 * renders (`test/rendered-surface.test.ts`), and the consumer-side audit
 * (SC-2805) runs it over a consumer's tree. A lint added here is a lint both
 * run.
 */
export const SURFACE_LINTS: readonly SurfaceLint[] = [danglingReadTargets(), templateArtifacts(), staleCounts()];
