/**
 * `rungate prompt-audit`: lint what a consumer's agents load, say whose each
 * finding is, and draft rungate's half as upstream reports (#2606, SC-2805).
 *
 * ADR-024 decision 7: the consumer side sorts findings into the consumer's
 * own and rungate's, and drafts a body for rungate's in the shape
 * `.claude/rules/reporting-upstream.md` defines. **It never files one.**
 * Filing publishes the body to a public tracker, which needs the consumer's
 * yes, so nothing in this module or its script runs `gh` or calls GitHub.
 *
 * ## What runs
 *
 * Every rendered-surface lint (`SURFACE_LINTS`, the same list CI runs over its
 * fixture renders), plus two that only make sense on a consumer:
 *
 * - **pressure-density**: MANDATORY, NEVER, CRITICAL, MUST, IMPORTANT and
 *   ZERO EXCEPTIONS, counted per file and per owner. ADR-024 found at most one
 *   per brief in rungate's templates and a consumer surface full of them, so
 *   a rungate-side lint had nothing to fail on.
 * - **dangling-path**: a backticked path whose directory exists and whose
 *   file does not. That is the shape of a rule pointing at a retired file.
 *   A path into a directory the project does not have is an example, not a
 *   reference, and is not read as one.
 *
 * ## Whose a finding is
 *
 * Decided per line, from what the scaffold writes:
 *
 * - `AGENTS.md`: rungate's, except under `## Hard Constraints`.
 * - A rule or command rungate writes: rungate's, except under
 *   `## Project-owned`. It is rungate's if it carries the `generated-sha`
 *   stamp, or if its name is one rungate's generator writes: scaffolds before
 *   the stamp wrote the same files unstamped, and their text is still
 *   rungate's. Any other rule is hand-written.
 * - A brief whose name has a template in rungate's `templates/agent-briefs/`:
 *   rungate's, except under `## Project Constraints`.
 * - Everything else, `CLAUDE.md` included: the consumer's.
 *
 * The section readers are the scaffold's own (`readPreservedSection`), so the
 * audit and the re-scaffold cannot disagree about where a section ends.
 *
 * ## The user-level surface (#2778)
 *
 * Claude Code also loads `~/.claude/CLAUDE.md` and the user's agents, skills
 * and commands into every session. A default run does not read them and says
 * so in `unmeasured`, so a short project list never reads as the whole
 * surface being clean. With `home` given (`--user`), four lints run over them
 * read-only: `template-artifact`, `stale-count`, `pressure-density` and
 * `dangling-path`. `dangling-read-target` is left out: a user file names
 * project paths that exist in some project and not under `~/.claude`. Every
 * such finding is the user's, and only harness-owned findings become
 * upstream drafts, so none of them is ever drafted.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, relative, sep } from "path";

import { BRIEF_CONSTRAINTS_SECTION, HARD_CONSTRAINTS_SECTION, readPreservedSection, type SectionSpec } from "./agents-md-sections";
import { generateScopedRules } from "./generators/agents-md";
import type { ProjectScan } from "./generators/types";
import { readFences } from "./markdown-fence";
import { PROVENANCE_KEY } from "./rule-provenance";
import { PROJECT_OWNED_SECTION } from "./scaffold/marked-section";
import { OWNED_FILES } from "./scaffold/owned-files";
import {
  PACKAGE_ROOT,
  SURFACE_LINTS,
  USER_SURFACE,
  userLoadsEverySession,
  probePath,
  type Probe,
  lintRenderedTree,
  readRenderedSurface,
  readUserSurface,
  staleCounts,
  templateArtifacts,
  type RenderedSurface,
} from "./surface-lint";

/** `user`: a file under `~/.claude`, read only with `--user` (#2778). */
export type Owner = "consumer" | "harness" | "user";

export interface AuditFinding {
  lint: string;
  file: string;
  /** 1-based; null when the lint did not say which line. */
  line: number | null;
  owner: Owner;
  message: string;
}

export interface PromptAudit {
  root: string;
  /** Every lint that ran, by name, so an empty finding list says what was checked. */
  lints: string[];
  findings: AuditFinding[];
  /** The user-level surface that was read, or null when it was not (#2778). */
  user: { root: string; files: number; lints: string[] } | null;
  /** Each part of what agents load that this run did not read, as an UNMEASURED line. */
  unmeasured: string[];
}

/** Where user-level findings say they are, so they never read as project files. */
export const USER_PREFIX = "~/.claude/";

// ── Ownership ──────────────────────────────────────────────────────────────

/** The 1-based line range a section covers, or null when the file has none. */
function sectionLines(text: string, spec: SectionSpec): [number, number] | null {
  const reading = readPreservedSection(text, spec);
  if (reading === null) return null;
  const first = text.slice(0, reading.start).split("\n").length;
  return [first, first + reading.text.split("\n").length - 1];
}

/**
 * Every rule and command file name rungate writes. The rule names come from
 * the generator itself, run over a scan that switches each conditional rule
 * on (one spec, one documentation route), so a rule added to the generator is
 * owned here without a second list to keep. Commands come from `OWNED_FILES`.
 */
export function generatedNames(): { rules: Set<string>; commands: Set<string> } {
  const scan = {
    name: "prompt-audit", type: "", root: "", identity: "", techStack: "", repoUrl: "", testCmd: "bun test",
    keyFiles: [], specs: [{ file: "ANY-SPEC.md", governs: "any", testable: "true" }], testFiles: [], refFiles: [],
    docRouting: [{ need: "any", file: "docs/" }], categories: [], consumers: [], hasCodeMap: true, makeTargets: [],
    sourceDirs: [], promptRouting: {}, harnessConfig: null, agentMeta: {}, dirs: [], deps: 0, devDeps: 0,
    modules: [], routes: [], harnessTemplatesDir: "", promptPrefix: "",
  } as unknown as ProjectScan;
  const rules = new Set(generateScopedRules(scan).map(r => r.filename));
  const commands = new Set(OWNED_FILES.map(f => f.path).filter(p => p.startsWith(".claude/commands/") && !p.includes("*")).map(p => p.slice(p.lastIndexOf("/") + 1)));
  return { rules, commands };
}

let names: ReturnType<typeof generatedNames> | null = null;

function stamped(text: string): boolean {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  return fm !== null && new RegExp(`^${PROVENANCE_KEY}:`, "m").test(fm[1]);
}

/**
 * The owner of every line of one rendered file, index 0 for line 1.
 * `packageRoot` is where the brief templates are read from.
 */
export function lineOwners(file: string, text: string, packageRoot: string = PACKAGE_ROOT): Owner[] {
  const count = text.split("\n").length;
  const all = (o: Owner): Owner[] => new Array(count).fill(o);
  const harnessExcept = (spec: SectionSpec): Owner[] => {
    const owners = all("harness");
    const range = sectionLines(text, spec);
    if (range !== null) for (let l = range[0]; l <= range[1] && l <= count; l++) owners[l - 1] = "consumer";
    return owners;
  };
  if (file === "AGENTS.md") return harnessExcept(HARD_CONSTRAINTS_SECTION);
  if (file.startsWith(".claude/rules/") || file.startsWith(".claude/commands/")) {
    names ??= generatedNames();
    const name = file.slice(file.lastIndexOf("/") + 1);
    const generated = file.startsWith(".claude/rules/") ? names.rules.has(name) && file === `.claude/rules/${name}` : names.commands.has(name) && file === `.claude/commands/${name}`;
    return stamped(text) || generated ? harnessExcept(PROJECT_OWNED_SECTION) : all("consumer");
  }
  if (file.startsWith(".claude/agents/")) {
    const name = file.slice(file.lastIndexOf("/") + 1);
    return existsSync(join(packageRoot, "templates", "agent-briefs", name)) ? harnessExcept(BRIEF_CONSTRAINTS_SECTION) : all("consumer");
  }
  return all("consumer");
}

// ── pressure-density ───────────────────────────────────────────────────────

/** The words ADR-024 counted. Capitals only: "never" in a sentence is not pressure. */
export const PRESSURE_MARKER = /\b(?:MANDATORY|NEVER|CRITICAL|MUST|IMPORTANT|ZERO EXCEPTIONS)\b/g;
/**
 * Both must hold before a file's text is a finding, measured on #2606: every
 * file rungate renders carries at most one marker, which is up to 13 per
 * 1,000 words in a 76-word rule, while a consumer CLAUDE.md read for this
 * carried 13 in about 3,000 words. A floor on the count keeps a short file
 * with one marker clean; the rate keeps a long file from tripping on volume.
 */
export const PRESSURE_FLOOR = 5;
export const PRESSURE_PER_THOUSAND_WORDS = 3;

function pressureFindings(surface: RenderedSurface, owners: Map<string, Owner[]>): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const [file, text] of surface.files) {
    const lines = text.split("\n");
    const { roles } = readFences(lines);
    const own = owners.get(file)!;
    for (const owner of ["harness", "consumer", "user"] as const) {
      let marks = 0, words = 0, first: number | null = null;
      const tally = new Map<string, number>();
      lines.forEach((ln, i) => {
        if (roles[i] !== "prose" || own[i] !== owner) return;
        words += ln.split(/\s+/).filter(Boolean).length;
        for (const m of ln.match(PRESSURE_MARKER) ?? []) {
          marks++;
          first ??= i + 1;
          tally.set(m, (tally.get(m) ?? 0) + 1);
        }
      });
      const rate = words === 0 ? 0 : (marks * 1000) / words;
      if (marks >= PRESSURE_FLOOR && rate >= PRESSURE_PER_THOUSAND_WORDS) {
        const which = [...tally].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} ×${n}`).join(", ");
        out.push({
          lint: "pressure-density", file, line: first, owner,
          message: `line ${first} starts ${marks} pressure markers in ${words} words, ${rate.toFixed(1)} per 1,000 (${which}); at least ${PRESSURE_FLOOR} and ${PRESSURE_PER_THOUSAND_WORDS} per 1,000 is a finding`,
        });
      }
    }
  }
  return out;
}

// ── dangling-path ──────────────────────────────────────────────────────────

/** A backticked token that reads as a path inside the project. */
const BACKTICKED = /`([^`\s]+)`/g;

/** A repository path: a directory segment, then a file with an extension, and nothing that makes it a pattern or a placeholder. */
export function looksLikeRepoPath(token: string): boolean {
  if (/[*?{}<>$|@:\\]/.test(token)) return false;
  if (/^(?:\/|~|\.|-|node_modules\/)/.test(token)) return false;
  return /^[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]{1,6}$/.test(token);
}

/**
 * A `~/`-rooted path in a user-level file, as the part after `~/`, or null
 * when the token is not one (#2778). A user's files name `~/.claude/...`
 * where a project's name a repository path, so the leading dot the project
 * reading skips is allowed here; a `..` segment is not.
 */
export function homeRelativePath(token: string): string | null {
  if (!token.startsWith("~/")) return null;
  const rest = token.slice(2);
  if (/[*?{}<>$|@:\\]/.test(rest) || rest.split("/").includes("..")) return null;
  return /^[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]{1,6}$/.test(rest) ? rest : null;
}

/**
 * Where a token could point, absolute, or null when it is not a path this
 * surface reads. The finding needs one of those places' directory to exist
 * and none of them to hold the file.
 */
type PathPlaces = (file: string, token: string) => string[] | null;

const projectPlaces = (root: string): PathPlaces => (_file, token) => (looksLikeRepoPath(token) ? [join(root, token)] : null);

/**
 * A user file's path is relative to its own directory (a skill naming its
 * `references/`) or to `~/.claude`, and a `~/` path is relative to home.
 */
const userPlaces = (root: string, home: string): PathPlaces => (file, token) => {
  const rest = homeRelativePath(token);
  if (rest !== null) return [join(home, rest)];
  return looksLikeRepoPath(token) ? [join(root, dirname(file), token), join(root, token)] : null;
};

/**
 * A probe over `root` that names each unreadable path in `unread`. The
 * project side reads paths with the same `probePath` as the user side
 * (review round 5 of #2844), so a file in an unsearchable directory is never
 * reported as missing on either side.
 */
function recordingProbe(root: string, unread: string[]): (abs: string) => Probe {
  return abs => {
    const p = probePath(abs);
    if (p.kind === "unreadable") {
      const entry = `${relative(root, abs).split(sep).join("/")} (${p.code})`;
      if (!unread.includes(entry)) unread.push(entry);
    }
    return p;
  };
}

function danglingPathFindings(
  surface: RenderedSurface,
  owners: Map<string, Owner[]>,
  places: PathPlaces = projectPlaces(surface.root),
  probe: (abs: string) => Probe = probePath,
): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const [file, text] of surface.files) {
    const lines = text.split("\n");
    const { roles } = readFences(lines);
    lines.forEach((ln, i) => {
      if (roles[i] !== "prose") return;
      for (const [, token] of ln.matchAll(BACKTICKED)) {
        const at = places(file, token);
        if (at === null) continue;
        // A finding needs one place whose directory is there, and every place
        // without the file. A place that could not be read is neither: the
        // user probe names it as unread, so it is never reported as missing
        // (review round 4 of #2844).
        if (!at.map(p => probe(dirname(p))).some(k => k.kind === "dir")) continue;
        if (at.map(p => probe(p)).some(k => k.kind !== "absent")) continue;
        out.push({
          lint: "dangling-path", file, line: i + 1, owner: owners.get(file)![i],
          message: `line ${i + 1} names \`${token}\`; its directory exists and the file does not`,
        });
      }
    });
  }
  return out;
}

// ── The audit ──────────────────────────────────────────────────────────────

export const PROMPT_AUDIT_LINTS: readonly string[] = [...SURFACE_LINTS.map(l => l.name), "pressure-density", "dangling-path"];

/**
 * The surface lints that also run over the user-level files (#2778), each
 * only where its premise holds there. A user file is no render, so
 * template-artifact keeps its list-numbering and test-marker checks and drops
 * the unexpanded-variable check: Claude Code expands `${CLAUDE_SKILL_DIR}`
 * and its kin in those files itself (review round 3 of #2844).
 */
const USER_SURFACE_LINTS = [
  templateArtifacts({ variables: false }),
  staleCounts({ everySession: userLoadsEverySession }),
];
export const USER_AUDIT_LINTS: readonly string[] = [...USER_SURFACE_LINTS.map(l => l.name), "pressure-density", "dangling-path"];

/** One {@link USER_SURFACE} entry as a reader sees it: `~/.claude/rules/`. */
const userSurfaceName = (e: { path: string; kind: "file" | "dir" }): string => `${USER_PREFIX}${e.path}${e.kind === "dir" ? "/" : ""}`;

/** What a default run says about the user-level files it did not read. */
export const USER_SURFACE_UNREAD =
  `UNMEASURED: the user-level surface (${USER_SURFACE.map(userSurfaceName).join(", ")}) was not read. Claude Code loads ` +
  `${USER_SURFACE.filter(e => e.everySession).map(userSurfaceName).join(" and ")} into every session here, and the rest when they are used. ` +
  "Run with --user to lint it; nothing there is written.";

/** The line a surface lint's message starts with, or null. */
const lineOf = (message: string): number | null => {
  const m = message.match(/^line (\d+)\b/);
  return m ? Number(m[1]) : null;
};

/** How many unread paths an UNMEASURED line names before it counts the rest. */
export const UNREAD_SHOWN = 10;

/** The UNMEASURED line for paths of one surface that could not be read, or null when every one was. */
function unreadLine(surface: "project" | "user-level", unreadable: readonly string[], prefix: string): string | null {
  if (unreadable.length === 0) return null;
  const shown = unreadable.slice(0, UNREAD_SHOWN).map(u => prefix + u).join(", ");
  const rest = unreadable.length > UNREAD_SHOWN ? `, and ${unreadable.length - UNREAD_SHOWN} more` : "";
  return `UNMEASURED: ${unreadable.length} ${surface} path(s) could not be read, so nothing under them is in this report: ${shown}${rest}.`;
}

/** The UNMEASURED line for user-level paths that could not be read, or null when every one was. */
export function userUnreadLine(unreadable: readonly string[]): string | null {
  return unreadLine("user-level", unreadable, USER_PREFIX);
}

/** The user-level findings under `home`, every one the user's, each file named from `~/.claude/`. */
function userFindings(home: string): { root: string; files: number; findings: AuditFinding[]; unreadable: readonly string[] } {
  const surface = readUserSurface(home);
  const owners = new Map<string, Owner[]>();
  for (const [file, text] of surface.files) owners.set(file, new Array(text.split("\n").length).fill("user"));
  const findings: AuditFinding[] = USER_SURFACE_LINTS.flatMap(lint =>
    lint.check(surface).map(f => ({ lint: lint.name, file: f.file, line: lineOf(f.message), owner: "user" as const, message: f.message })),
  );
  findings.push(...pressureFindings(surface, owners), ...danglingPathFindings(surface, owners, userPlaces(surface.root, home), surface.probe));
  return { root: surface.root, files: surface.files.size, findings: findings.map(f => ({ ...f, file: USER_PREFIX + f.file })), unreadable: surface.unreadable };
}

/**
 * Run every lint over the rendered surface under `root` and give each finding
 * an owner. Throws `NotRenderedSurface` for a tree rungate has not scaffolded:
 * nothing was measured, and an empty list would say otherwise.
 *
 * With `home`, the user-level files under `<home>/.claude` are linted too,
 * read-only; without it, `unmeasured` says they were not read (#2778).
 */
export function promptAudit(root: string, packageRoot: string = PACKAGE_ROOT, opts: { home?: string } = {}): PromptAudit {
  const surface = readRenderedSurface(root);
  const owners = new Map<string, Owner[]>();
  for (const [file, text] of surface.files) owners.set(file, lineOwners(file, text, packageRoot));
  const ownerAt = (file: string, line: number | null): Owner => {
    const own = owners.get(file);
    if (own === undefined) return "consumer";
    return line === null ? (own.includes("harness") ? "harness" : "consumer") : own[line - 1] ?? "consumer";
  };
  const findings: AuditFinding[] = lintRenderedTree(root, SURFACE_LINTS).map(f => {
    const line = lineOf(f.message);
    return { lint: f.lint, file: f.file, line, owner: ownerAt(f.file, line), message: f.message };
  });
  const projectUnread: string[] = [];
  findings.push(
    ...pressureFindings(surface, owners),
    ...danglingPathFindings(surface, owners, projectPlaces(surface.root), recordingProbe(surface.root, projectUnread)),
  );
  const projectLine = unreadLine("project", projectUnread, "");
  const unmeasured = projectLine === null ? [] : [projectLine];
  if (opts.home === undefined) return { root: surface.root, lints: [...PROMPT_AUDIT_LINTS], findings, user: null, unmeasured: [...unmeasured, USER_SURFACE_UNREAD] };
  const user = userFindings(opts.home);
  findings.push(...user.findings);
  const userLine = userUnreadLine(user.unreadable);
  return {
    root: surface.root,
    lints: [...PROMPT_AUDIT_LINTS],
    findings,
    user: { root: user.root, files: user.files, lints: [...USER_AUDIT_LINTS] },
    unmeasured: userLine === null ? unmeasured : [...unmeasured, userLine],
  };
}

// ── Upstream drafts ────────────────────────────────────────────────────────

/** The version of rungate that ran the audit, read from its own package.json. */
export function runningVersion(packageRoot: string = PACKAGE_ROOT): string {
  try {
    const v = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8")).version;
    if (typeof v === "string" && v !== "") return `rungate ${v}, read from the package.json of the rungate that ran \`rungate prompt-audit\``;
  } catch (e) {
    return `UNMEASURED: the running rungate's package.json could not be read (${(e as Error).message})`;
  }
  return "UNMEASURED: the running rungate's package.json names no version";
}

/**
 * One draft per lint, holding every harness-owned finding of that lint, in
 * the shape `.claude/rules/reporting-upstream.md` asks for. The claim line is
 * left for the consumer: it names a claim in THEIR SUCCESS.md, which only
 * they can choose.
 */
export function upstreamBodies(audit: PromptAudit, version: string = runningVersion()): Map<string, string> {
  const byLint = new Map<string, AuditFinding[]>();
  for (const f of audit.findings) if (f.owner === "harness") byLint.set(f.lint, [...(byLint.get(f.lint) ?? []), f]);
  const out = new Map<string, string>();
  for (const [lint, fs] of byLint) {
    const files = [...new Set(fs.map(f => f.file))];
    out.set(lint, [
      "Claim <N>: <the claim in this project's SUCCESS.md that this stops from holding; fill this in before filing>",
      "Cannot be a comment: out-of-pr-diff",
      "",
      "## What must become true",
      "",
      `\`rungate prompt-audit\` reports ${fs.length} \`${lint}\` finding${fs.length === 1 ? "" : "s"} in text rungate generates in this project:`,
      "",
      ...fs.map(f => `- \`${f.file}\`: ${f.message}`),
      "",
      `Version: ${version}.`,
      "",
      "## Files this will change",
      "",
      `Unknown from here. rungate generated the text in ${files.map(f => `\`${f}\``).join(", ")}, outside any section this project owns, so the generator that writes it is where to look.`,
      "",
      "## How we will know",
      "",
      `\`bunx rungate prompt-audit\` on this project reports no \`${lint}\` finding owned by rungate.`,
      "",
    ].join("\n"));
  }
  return out;
}

/** Write each draft to `outDir` as `upstream-<lint>.md`. Returns the paths written. Files nothing. */
export function writeUpstreamBodies(bodies: Map<string, string>, outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const [lint, body] of bodies) {
    const path = join(outDir, `upstream-${lint}.md`);
    writeFileSync(path, body);
    written.push(path);
  }
  return written;
}

/**
 * The terminal report: rungate's findings first, then the consumer's, then
 * the user's when their files were read, then what was not read.
 */
export function formatAudit(audit: PromptAudit): string {
  const lines = [`prompt-audit: ${audit.findings.length} finding(s) from ${audit.lints.length} lints (${audit.lints.join(", ")}) over ${audit.root}`];
  const heading: Record<Owner, string> = {
    harness: "rungate wrote this text; report it upstream",
    consumer: "this project's own text; fix it here",
    user: audit.user === null ? "" : `your own files under ${audit.user.root}, ${audit.user.files} read by ${audit.user.lints.join(", ")}; fix them there, never upstream`,
  };
  for (const owner of audit.user === null ? (["harness", "consumer"] as const) : (["harness", "consumer", "user"] as const)) {
    const fs = audit.findings.filter(f => f.owner === owner);
    lines.push("", `${owner}-owned (${fs.length}): ${heading[owner]}`);
    for (const f of fs) lines.push(`  [${f.lint}] ${f.file}: ${f.message}`);
  }
  for (const u of audit.unmeasured) lines.push("", u);
  return lines.join("\n");
}
