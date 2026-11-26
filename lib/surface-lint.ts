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

import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";

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
  /**
   * Every path that is there and could not be read, each with the code that
   * stopped it, e.g. `.claude/rules (EACCES)`. Named relative to `root`, or
   * as the reader's surface names a path outside it. A lint's own reads land
   * here too, so read it after the lints have run (#2849).
   */
  readonly unreadable: readonly string[];
  /** {@link probePath}, recording any unreadable answer in `unreadable` under its name. */
  readonly probe: (abs: string) => Probe;
  /** The text at `abs` when it is a file that reads; otherwise `undefined`, with the reason in `unreadable` unless nothing is there. */
  readonly readText: (abs: string) => string | undefined;
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
 * The rendered surface under `root`, or a refusal naming what a rendered tree
 * would have and this one does not.
 *
 * Every path goes through {@link probePath} (#2849), as the user side has
 * since #2844. A link is followed, so a rule linked in from elsewhere is
 * linted under its own name. A path that is there and cannot be read is named
 * in `unreadable` and the rest is still read. `AGENTS.md` and the two
 * directory markers count as missing only when nothing that could be them is
 * there: an unsearchable `.claude/rules`, or a rule in it that will not open,
 * is unread, not a tree the scaffold never rendered, and so is an entry in it
 * that cannot be followed, since it may be a linked directory of rules. A
 * regular file at a directory's name, or a directory holding no `.md` and
 * nothing unreadable, is still missing.
 * Directories are walked at any depth (review, PR #2632), skipping what no
 * session loads, as on the user side. The config marker is
 * `resolveConfig`'s to decide (#2849 local review: #2875).
 */
export function readRenderedSurface(root: string): RenderedSurface {
  const abs = resolve(root);
  const config = resolveConfig(abs).status;
  const reader = surfaceReader(at => {
    const rel = relative(abs, at);
    return !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : at;
  });
  const agentsMd = probePath(join(abs, "AGENTS.md")).kind;
  for (const f of SURFACE_FILES) reader.read(join(abs, f));
  // Per directory: whether a surface file is there, read or not.
  const present = new Map<string, boolean>();
  for (const d of SURFACE_DIRS) {
    const at = join(abs, d);
    const p = reader.probe(at);
    present.set(d, p.kind === "unreadable" || (p.kind === "dir" && reader.walk(at, neverLoaded) > 0));
    // There, and not a directory: named, and still no marker (#2876 review).
    if (p.kind === "file" || p.kind === "other") reader.note(at, "ENOTDIR");
  }

  const missing: string[] = [];
  if (config === "absent") missing.push(RENDERED_MARKERS[0]);
  if (agentsMd === "absent") missing.push(RENDERED_MARKERS[1]);
  if (!present.get(".claude/agents")) missing.push(RENDERED_MARKERS[2]);
  if (!present.get(".claude/rules")) missing.push(RENDERED_MARKERS[3]);
  if (missing.length > 0) throw new NotRenderedSurface(abs, missing);
  return { root: abs, files: reader.files, unreadable: reader.unreadable, probe: reader.probe, readText: reader.readText };
}

// ── #2778: the user-level surface ─────────────────────────────────────────

/**
 * What Claude Code loads from `~/.claude`, relative to it, in one table
 * (review round 4 of #2844). The reader and the default run's disclosure are
 * both built from this table, so neither can name a surface the other misses.
 * Claude Code's memory docs list `~/.claude/CLAUDE.md` and `~/.claude/rules/`
 * as user scope. They load into every session; agents, skills and commands
 * load when used.
 */
export const USER_SURFACE: ReadonlyArray<{ path: string; kind: "file" | "dir"; everySession: boolean }> = [
  { path: "CLAUDE.md", kind: "file", everySession: true },
  { path: "rules", kind: "dir", everySession: true },
  { path: "agents", kind: "dir", everySession: false },
  { path: "skills", kind: "dir", everySession: false },
  { path: "commands", kind: "dir", everySession: false },
];

/**
 * Whether a user-level file, named from `~/.claude`, loads into every
 * session: an every-session entry of {@link USER_SURFACE}, except a rule that
 * declares `paths:`, which loads beside matching files the way a project rule
 * does (`isPathScoped`, the same reading).
 */
export function userLoadsEverySession(file: string, text: string): boolean {
  return USER_SURFACE.some(e => {
    if (!e.everySession) return false;
    if (e.kind === "file") return file === e.path;
    return file.startsWith(`${e.path}/`) && !(e.path === "rules" && isPathScoped(text));
  });
}

/**
 * The user-level surface as read. Its `unreadable` paths are named from
 * `~/.claude` (or `~/`), e.g. `skills/a (ELOOP)`.
 */
export type UserSurface = RenderedSurface;

/**
 * Directory entries no session loads: a linked checkout's `node_modules`,
 * and dot-directories such as `.git`. Measured on one machine on
 * 2026-11-25 (review round 1 of #2844): 132 of 928 `.md` files under
 * `~/.claude`'s agents, skills and commands sat in one linked skill's
 * `node_modules`, and each would have been reported as the user's own.
 */
function neverLoaded(name: string): boolean {
  return name === "node_modules" || name.startsWith(".");
}

/** The error code an fs call failed with, or its message when it has none. */
function codeOf(e: unknown): string {
  return (e as NodeJS.ErrnoException).code ?? (e as Error).message;
}

/** What is at a path, following links, or why it could not be read. */
export type Probe = { kind: "dir" | "file" | "other" } | { kind: "absent" } | { kind: "unreadable"; code: string };

/**
 * The one reading of a user-level path (review round 4 of #2844). Earlier
 * rounds fixed one errno per round across three separate readers. Every
 * user-side touch now goes through this function, so "missing" and "could
 * not be read" are told apart in one place:
 *
 * - **absent**: nothing at the name. ENOENT or ENOTDIR from `stat`, `lstat`
 *   finds nothing either, and the nearest ancestor that exists is a directory
 *   or a regular file, not a link that leads nowhere (review round 6 of
 *   #2844). Nothing can be under a regular file, so a path through one is
 *   absent. Under a dangling link, the path is unreadable, not missing.
 * - **unreadable**: something is there and cannot be followed or read. A
 *   dangling or looping link, EACCES, or any other error.
 *
 * The project side reads through it too (#2849): `readRenderedSurface`,
 * `inRenderedTree` and `resolveTarget` decide presence here and nowhere
 * else, so neither side reads an unreadable path as a missing one.
 */
export function probePath(abs: string): Probe {
  try {
    const st = statSync(abs);
    return { kind: st.isDirectory() ? "dir" : st.isFile() ? "file" : "other" };
  } catch (e) {
    const code = codeOf(e);
    if (code !== "ENOENT" && code !== "ENOTDIR") return { kind: "unreadable", code };
    try {
      lstatSync(abs);
    } catch (e2) {
      const code2 = codeOf(e2);
      if (code2 !== "ENOENT" && code2 !== "ENOTDIR") return { kind: "unreadable", code: code2 };
      const blocked = blockingAncestor(abs);
      return blocked === null ? { kind: "absent" } : { kind: "unreadable", code: blocked };
    }
    return { kind: "unreadable", code };
  }
}

/**
 * Why the nearest ancestor of `abs` that exists stops a read, or null when
 * it does not: a link to nowhere (ENOENT), or a directory the walk up could
 * not look into (its error code).
 */
function blockingAncestor(abs: string): string | null {
  for (let d = dirname(abs); d !== dirname(d); d = dirname(d)) {
    let isLink: boolean;
    try {
      isLink = lstatSync(d).isSymbolicLink();
    } catch (e) {
      const code = codeOf(e);
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      return code;
    }
    if (!isLink) return null;
    try {
      statSync(d);
      return null;
    } catch (e) {
      return codeOf(e);
    }
  }
  return null;
}

/**
 * The user-level surface under `<home>/.claude`, keyed relative to that
 * directory, read and never written. rungate rendered none of it, so it is
 * not refused for lacking a scaffold's markers: a home with no `.claude` is
 * an empty surface, and the caller reports how many files it read and which
 * paths it could not.
 *
 * Directories are walked following links, because Claude Code loads a
 * linked skill through its link. Two links to one directory are two skills,
 * each read under its own name. Only a link back to a directory the walk is
 * already inside is a cycle, and it is named rather than followed.
 */
export function readUserSurface(home: string): UserSurface {
  const homeAbs = resolve(home);
  const root = join(homeAbs, ".claude");
  const reader = surfaceReader(abs => {
    const inRoot = relative(root, abs);
    if (!inRoot.startsWith("..") && !isAbsolute(inRoot)) return inRoot.split(sep).join("/");
    const inHome = relative(homeAbs, abs);
    return !inHome.startsWith("..") && !isAbsolute(inHome) ? `~/${inHome.split(sep).join("/")}` : abs;
  });
  for (const entry of USER_SURFACE) {
    const at = join(root, entry.path);
    // A file entry goes through `read`, which names a directory or a FIFO at
    // its name; a directory entry that is something else is named too, as on
    // the project side (#2876 review). Absent is silent on both.
    if (entry.kind === "file") {
      reader.read(at);
      continue;
    }
    const p = reader.probe(at);
    if (p.kind === "dir") reader.walk(at, neverLoaded);
    else if (p.kind === "file" || p.kind === "other") reader.note(at, "ENOTDIR");
  }
  return { root, files: reader.files, unreadable: reader.unreadable, probe: reader.probe, readText: reader.readText };
}

/**
 * How many directory entries one reader visits before it stops walking (#2849
 * security review). Following links lets a tree of links that each point at
 * the next directory expand exponentially; the cycle guard stops only a link
 * back to a directory the walk is inside. One machine's whole user surface was
 * 928 `.md` files (round 1 of #2844), so this leaves room for any real
 * surface. Past it the walk stops, and says so in `unreadable`.
 */
export const WALK_ENTRY_CAP = 20_000;

/**
 * The one reader both surfaces are read through (#2849): every presence
 * check is {@link probePath}, every unreadable path is named once by
 * `nameOf`, and a read is attempted only on a file. The user side and the
 * project side differ only in how a path is named and which directory
 * entries a walk skips.
 */
function surfaceReader(nameOf: (abs: string) => string) {
  const files = new Map<string, string>();
  const unreadable: string[] = [];
  const note = (abs: string, why: string): void => {
    const entry = `${nameOf(abs)} (${why})`;
    if (!unreadable.includes(entry)) unreadable.push(entry);
  };
  const probe = (abs: string): Probe => {
    const p = probePath(abs);
    if (p.kind === "unreadable") note(abs, p.code);
    return p;
  };
  const attempt = <T>(abs: string, run: () => T): T | undefined => {
    try {
      return run();
    } catch (e) {
      note(abs, codeOf(e));
      return undefined;
    }
  };
  const readText = (abs: string): string | undefined => {
    const p = probe(abs);
    if (p.kind === "file") return attempt(abs, () => readFileSync(abs, "utf-8"));
    if (p.kind === "dir") note(abs, "EISDIR");
    else if (p.kind === "other") note(abs, "not a regular file");
    return undefined;
  };
  /** Read `abs` into `files` under its name; whether it was read. */
  const read = (abs: string): boolean => {
    const text = readText(abs);
    if (text !== undefined) files.set(nameOf(abs), text);
    return text !== undefined;
  };
  let entries = 0;
  let capped = false;
  /**
   * Every `.md` under `abs`, at any depth, following links: Claude Code loads
   * a linked skill or rule through its link, so two links to one directory
   * are two entries, each read under its own name. Only a link back to a
   * directory the walk is already inside is a cycle, named and not followed.
   *
   * Returns how many surface entries it met, read or not: each `.md` that is
   * there, each directory it could not list, and each entry it could not
   * follow at all, whatever its name, since that may be a linked directory of
   * them (#2876 review). A regular file or FIFO with another name is neither.
   */
  const walk = (abs: string, skip: (name: string) => boolean, inside: ReadonlySet<string> = new Set()): number => {
    // Past the cap a directory is named, not skipped, and counts as one that
    // may hold surface files, so a later marker is not read as missing (#2876
    // review).
    if (capped) {
      note(abs, "not walked: the entry cap was reached");
      return 1;
    }
    const real = attempt(abs, () => realpathSync(abs));
    if (real === undefined) return 1;
    if (inside.has(real)) {
      note(abs, "links back to a directory it is inside");
      return 0;
    }
    const names = attempt(abs, () => readdirSync(abs));
    if (names === undefined) return 1;
    const here = new Set(inside).add(real);
    let met = 0;
    for (const name of names.sort((x, y) => x.localeCompare(y))) {
      if (skip(name)) continue;
      if (capped) break;
      if (++entries > WALK_ENTRY_CAP) {
        capped = true;
        note(abs, `the walk stopped after ${WALK_ENTRY_CAP} entries`);
        return met + 1;
      }
      const at = join(abs, name);
      const p = probe(at);
      if (p.kind === "dir") met += walk(at, skip, here);
      else if (p.kind === "unreadable") met += 1;
      else if (name.endsWith(".md") && p.kind !== "absent") {
        read(at);
        met += 1;
      }
    }
    return met;
  };
  return { files, unreadable, note, probe, readText, read, walk };
}

/** A surface file, or any path inside the rendered root that something is at, read or not. */
function inRenderedTree(surface: RenderedSurface, file: string): boolean {
  if (surface.files.has(file)) return true;
  const at = resolve(surface.root, file);
  const rel = relative(surface.root, at);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && probePath(at).kind !== "absent";
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
export function lintRenderedTree(root: string | RenderedSurface, lints: readonly SurfaceLint[]): NamedSurfaceFinding[] {
  // A surface already read is linted as is, so what its lints could not read
  // lands in that surface's `unreadable` for its caller to report (#2849).
  // Given only a path, nobody else holds that list, so an unread path is
  // refused here rather than dropped: a clean result must mean read and clean.
  const surface = typeof root === "string" ? readRenderedSurface(root) : root;
  const findings = lintSurface(surface, lints);
  if (typeof root === "string" && surface.unreadable.length > 0) throw new UnreadSurface(surface.root, surface.unreadable);
  return findings;
}

/** Refused rather than reported clean: a rendered tree with paths the lints could not read (#2849). */
export class UnreadSurface extends Error {
  constructor(root: string, unreadable: readonly string[]) {
    super(`UNMEASURED: ${unreadable.length} path(s) under ${root} could not be read, so a clean lint would claim what was not checked: ${unreadable.join(", ")}`);
    this.name = "UnreadSurface";
  }
}

/** Run `lints` over `surface`, refusing a finding that names a file outside it. */
function lintSurface(surface: RenderedSurface, lints: readonly SurfaceLint[]): NamedSurfaceFinding[] {
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

/**
 * Where a target named in a rendered file resolves: the path, `null` when
 * nothing is there, or `"unread"` when something is there and could not be
 * read (#2849). The surface's probe names that path, so it is never reported
 * as missing.
 */
function resolveTarget(surface: RenderedSurface, target: string, packageRoot: string): string | null | "unread" {
  const local = resolve(surface.root, target);
  // An unreadable local copy is named even when the package answers below: an
  // agent in this tree opens the local one (#2876 review).
  const here = surface.probe(local).kind;
  if (here !== "absent" && here !== "unreadable") return local;
  // A `node_modules/rungate/…` target the installed package answers is still
  // checked there (#2849 local review).
  const pkg = target.match(/^node_modules\/rungate\/(.+)$/);
  if (pkg !== null) {
    const there = join(packageRoot, pkg[1]);
    const kind = surface.probe(there).kind;
    if (kind !== "absent" && kind !== "unreadable") return there;
    if (kind === "unreadable") return "unread";
  }
  return here === "unreadable" ? "unread" : null;
}

/** Whether a markdown text holds a table its heading or header row calls `name`. */
function hasTableNamed(text: string, name: string): boolean {
  const stem = name.toLowerCase().replace(/s$/, "");
  const lines = text.split("\n");
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
        if (at === "unread") continue;
        if (at === null) {
          findings.push({ file: t.file, message: `line ${t.line} tells the agent to read ${t.target}, which is not in the rendered tree` });
          continue;
        }
        if (t.table === null) continue;
        // Only a file is read; a directory or a file that will not open is
        // named in the surface's `unreadable`, not reported as tableless.
        const text = surface.readText(at);
        if (text !== undefined && !hasTableNamed(text, t.table)) {
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
export function templateArtifacts(opts: { variables?: boolean } = {}): SurfaceLint {
  // `variables: false` (#2844, review round 3): the user-level surface is no
  // render, and Claude Code expands its own `${CLAUDE_PROJECT_DIR}` and
  // `${CLAUDE_SKILL_DIR}` there, so an unexpanded variable is not a defect.
  const variables = opts.variables ?? true;
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
          for (const v of variables ? (ln.match(TEMPLATE_VARIABLE) ?? []) : []) {
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
export function staleCounts(opts: { everySession?: (file: string, text: string) => boolean } = {}): SurfaceLint {
  // `everySession` (#2844): which files of THIS surface load into every
  // session. The user-level surface names them from `~/.claude`, where a rule
  // is named under `rules/`, not under the project rule directory.
  const loaded = opts.everySession ?? alwaysLoaded;
  return {
    name: "stale-count",
    check(surface) {
      const findings: SurfaceFinding[] = [];
      for (const [file, text] of surface.files) {
        if (!loaded(file, text)) continue;
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
