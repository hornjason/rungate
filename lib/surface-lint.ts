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
import { isAbsolute, join, relative, resolve } from "path";

import { resolveConfig } from "./config-loader";

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

function mdIn(root: string, dir: string): string[] {
  const at = join(root, dir);
  if (!existsSync(at) || !statSync(at).isDirectory()) return [];
  return readdirSync(at)
    .filter(f => f.endsWith(".md"))
    .sort()
    .map(f => `${dir}/${f}`);
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
