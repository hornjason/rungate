#!/usr/bin/env bun
/**
 * Detect SC drift: SCs referencing nonexistent files or missing keywords.
 *
 * Reports two categories:
 * - DRIFT: SC references a file that doesn't exist
 * - STALE: SC expects a keyword in an existing file, but keyword is missing
 *
 * Usage:
 *   bun scripts/detect-sc-drift.ts           # Run against project root
 *   import { detectDrift } from "./detect-sc-drift"  # Programmatic use
 */

import { existsSync, readFileSync } from "fs";
import { collectSpecFiles } from "../lib/spec-files";
import { SC_ID_SOURCE } from "../lib/sc-ids";
import { join } from "path";

export interface DriftResult {
  drifted: Map<string, DriftDetail[]>;  // SCs referencing nonexistent files
  stale: Map<string, StaleDetail[]>;    // SCs with missing keywords
  checked: number;                       // Total SCs checked
}

export interface DriftDetail {
  scId: string;
  statement: string;
  path: string;  // The file path that doesn't exist
}

export interface StaleDetail {
  scId: string;
  statement: string;
  path: string;     // The file that exists
  keyword: string;  // The keyword that's missing
}

/** The directories a criterion's file path must pass through to be read: the one list (#2897). */
const LISTED_DIRS: ReadonlySet<string> = new Set(["lib", "scripts", "test", "gates", "workflows", "hooks"]);

/** The extensions a read path ends in, with nothing after them: `lib/parser.tsx` is not `lib/parser.ts` (#2897). */
const READ_EXTENSIONS = /\.(?:ts|js|md|json)$/;

/** What one token of criterion prose is, read as a path (#2897). */
export type PathToken =
  | { kind: "listed"; path: string }
  | { kind: "unread-file" | "alias" | "absolute" | "none" };

/**
 * One token of criterion prose, read as a path, by the rules tabled in
 * `test/sc-drift.test.ts` (#2897). Both readers below call it, so they cannot
 * disagree about what a path is.
 *
 * - The path is the token's first run of path characters that reads as one.
 *   Quotes, backticks, emphasis, brackets and punctuation are not path
 *   characters, so they are never part of it; nor is a prefix
 *   (`key:lib/x.ts`). A glob is no file: the run before its first wildcard
 *   (`lib/` in `lib/*.ts`) is a path this reader does not read. What follows the run
 *   (`lib/x.ts:10-20`, `lib/x.ts#L42`, `lib/x.ts's`) does not stop it naming
 *   the file. The extension ends where the run ends, so `lib/parser.tsx` is
 *   not `lib/parser.ts`.
 */
export function classifyPathToken(raw: string): PathToken {
  for (const run of raw.matchAll(/[\w.@~/+-]+/g)) {
    const token = pathRun(run[0].replace(/\.+$/, ""));
    if (token.kind !== "none") return token;
  }
  return { kind: "none" };
}

/**
 * One run of path characters, read as a path.
 *
 * - An alias (`@/`, `~/`), a path through `..`, and an absolute path
 *   outside the project are not paths in this tree. A root-relative
 *   `/lib/x.ts` is `lib/x.ts`, because its first segment is a listed
 *   directory; a URL reads as an absolute path from its `//`.
 * - A path with a directory is read whole, from its start, when a directory
 *   before its file is on the list and it ends in a read extension. A scoped
 *   segment inside it (`node_modules/@scope/…`) is part of it. Any other path
 *   with a directory, extension or not, is a file this reader does not read.
 * - A bare name with a read extension (`SUCCESS.md`) is a file at the root
 *   this reader does not read, as #2884 read it. Any other bare word is not a
 *   path.
 */
function pathRun(text: string): PathToken {
  if (/^[@~]/.test(text)) return { kind: "alias" };
  let path = text.replace(/^\.\//, "");
  if (path.split("/").includes("..")) return { kind: "absolute" };
  if (path.startsWith("/")) {
    const tail = path.slice(1);
    if (!LISTED_DIRS.has(tail.split("/")[0])) return { kind: "absolute" };
    path = tail;
  }
  if (!path.includes("/")) return READ_EXTENSIONS.test(path) ? { kind: "unread-file" } : { kind: "none" };
  const dirs = path.split("/").slice(0, -1);
  if (READ_EXTENSIONS.test(path) && dirs.some(d => LISTED_DIRS.has(d))) return { kind: "listed", path };
  return { kind: "unread-file" };
}

/**
 * The file paths a criterion names, for existence checking: every token the
 * classifier reads as a listed path. Tokens split on whitespace and on the
 * punctuation that can sit between two paths (#2897).
 */
export function extractFilePaths(statement: string): string[] {
  const paths: string[] = [];
  for (const raw of statement.split(/[\s,;()[\]=]+/)) {
    const token = classifyPathToken(raw);
    if (token.kind === "listed") paths.push(token.path);
  }
  return paths;
}

/**
 * The keywords a `contains [a, b, c]` clause requires.
 *
 * It used to return the bracket contents as ONE string, so a multi-keyword SC
 * was checked for the literal text `"resolveSyncPaths, harnessRoot"` — comma
 * and space included — which no source file ever contains. Every such SC was
 * therefore reported stale no matter what the file held, and
 * `scripts/sync-sc-status.ts` refuses to flip a stale SC. A criterion the
 * conformity engine had just PASSED could not be marked done, and the reason
 * printed was "keyword missing from file", which is not what was wrong.
 *
 * A comma inside a keyword would split wrongly, so only split where the parts
 * look like separate terms: the registry's own syntax is comma-separated and
 * no matcher keyword in this repo contains one.
 */
export function extractKeywords(statement: string): string[] {
  // `not contains [...]` is an absence clause, and this detector only answers
  // "a file exists but lacks a term it should have". Reading it as a positive
  // requirement inverted the SC: SC-539 says ship.js must NOT contain
  // `git merge ${worktreeBranch}`, and the detector reported it stale FOR
  // being correct.
  const match = statement.match(/(?<!not )contains \[([^\]]+)\]/);
  if (!match) return [];
  return match[1]
    .split(",")
    .map(k => k.trim())
    .filter(Boolean);
}

/**
 * The file a `<path> contains [...]` clause names — the one its keywords must
 * be in (#2287). Null when the clause names no file directly before it.
 *
 * Every path in a statement is checked for EXISTENCE (drift), but only this
 * one carries the keywords. Checking them in every path made a criterion
 * whose prose mentions a second file read stale while the conformity matcher
 * passed it: SC-2772 names `workflows/ship.js` as what its subject is built
 * from, and `buildWorkflowLaunch` is not in ship.js.
 */
export function containsSubject(statement: string): string | null {
  return containsClauses(statement).find(c => c.path !== null)?.path ?? null;
}

/**
 * Every positive `contains [...]` clause in a statement, each with the file
 * named directly before it, or `null` when none is (review, #2291). SC-543
 * reads `lib/workflow-security.ts contains [...] and workflows/ship.js
 * contains [isSafeBranchName(shipBranch)]`: binding only the first clause
 * left ship.js checked for nothing.
 */
export function containsClauses(statement: string): Array<{ path: string | null; keywords: string[] }> {
  const out: Array<{ path: string | null; keywords: string[] }> = [];
  for (const m of statement.matchAll(/(?<!not )contains \[([^\]]+)\]/g)) {
    const head = statement.slice(0, m.index);
    // The token directly before the clause names its file (#2897's table).
    // A listed path binds it, punctuated or not; a word names no file, so the
    // keywords apply to every path, as before. Any other file is this
    // reader's to skip, and its keywords are checked nowhere rather than lent
    // to other files (#2287, #2907 review).
    const last = /\S+$/.exec(head.trimEnd())?.[0] ?? "";
    const token = classifyPathToken(last);
    const keywords = m[1].split(",").map(k => k.trim()).filter(Boolean);
    if (token.kind === "listed") out.push({ path: token.path, keywords });
    else if (token.kind === "none") out.push({ path: null, keywords });
  }
  return out;
}

/**
 * The keywords `path` must contain: those of every clause that names it, plus
 * those of any clause that names no file (checked everywhere, as before —
 * that only ever refuses more).
 */
export function keywordsFor(statement: string, path: string): string[] {
  const clauses = containsClauses(statement);
  return [...new Set(clauses.filter(c => c.path === path || c.path === null).flatMap(c => c.keywords))];
}

/**
 * Detect drift and staleness in SCs across all spec files.
 *
 * @param specsDir - Path to specs directory
 * @param projectRoot - Path to project root for resolving file paths
 * @returns DriftResult with drifted and stale SCs, grouped by spec file
 */
export function detectDrift(specsDir: string, projectRoot: string): DriftResult {
  const drifted = new Map<string, DriftDetail[]>();
  const stale = new Map<string, StaleDetail[]>();
  let checked = 0;

  if (!existsSync(specsDir)) {
    return { drifted, stale, checked };
  }

  // Every spec, including the ones in subdirectories (#158, missed by #225).
  //
  // This was `readdirSync(specsDir).filter(f => f.endsWith(".md"))` — a tenth
  // flat collector that #225's sweep did not reach. The consequence is worse
  // than a missed file, because of what sits on the other side of it:
  // `scripts/sync-sc-status.ts` scans recursively (`new Bun.Glob("**/*.md")`,
  // :54) and then calls `detectDrift` (:366) as its gate. So the flipper could
  // see all 254 SCs under `specs/bootstrap-data-flow/` while the drift
  // detector it trusts could see none of them: a subdirectory SC could never
  // be reported stale, and therefore auto-flipped to [x] with no drift gate at
  // all. The two halves disagreed about what a spec is, and the half with the
  // narrower view was the one holding the brakes.
  const specFiles = collectSpecFiles(specsDir);

  for (const specFile of specFiles) {
    const specPath = join(specsDir, specFile);
    const content = readFileSync(specPath, "utf-8");

    // Find all SC lines (both checked and unchecked).
    //
    // Built from `SC_ID_SOURCE` (#1298). This is the gate
    // `scripts/sync-sc-status.ts` runs before it flips a box, so a criterion
    // this pattern cannot see is not merely unreported — it is auto-ticked
    // with no drift gate at all. That is the same failure the docblock above
    // records for subdirectory specs, arriving a second time by prefix, and
    // `SC-\d+` could see neither an anti-criterion nor a `CRC-` id.
    const scPattern = new RegExp(`^- \\[[ x]\\] (${SC_ID_SOURCE}):\\s*(.+)$`, "gm");
    let match;

    while ((match = scPattern.exec(content)) !== null) {
      const scId = match[1];
      const statement = match[2].trim();
      checked++;

      // Check for file path references. Each path is checked for the keywords
      // of the clauses that name it (`keywordsFor`); a path only mentioned in
      // prose is checked for existence alone.
      const paths = extractFilePaths(statement);
      for (const path of paths) {
        const fullPath = join(projectRoot, path);
        if (!existsSync(fullPath)) {
          if (!drifted.has(specFile)) {
            drifted.set(specFile, []);
          }
          drifted.get(specFile)!.push({ scId, statement, path });
        } else {
          // File exists — check each required keyword separately.
          const keywords = keywordsFor(statement, path);
          if (keywords.length) {
            const fileContent = readFileSync(fullPath, "utf-8");
            const missing = keywords.filter(k => !fileContent.includes(k));
            if (missing.length) {
              if (!stale.has(specFile)) {
                stale.set(specFile, []);
              }
              // Report every missing term, not just the first: a reader who
              // fixes one and re-runs should not discover the next one by
              // iteration.
              stale.get(specFile)!.push({ scId, statement, path, keyword: missing.join(", ") });
            }
          }
        }
      }
    }
  }

  return { drifted, stale, checked };
}

// --- Main (only runs when executed directly) ---
const isDirectExecution = import.meta.main;

if (isDirectExecution) {
  const ROOT = join(import.meta.dir, "..");
  const SPECS_DIR = join(ROOT, "specs");

  const result = detectDrift(SPECS_DIR, ROOT);

  console.log(`\n=== SC Drift Detection ===`);
  console.log(`Checked ${result.checked} SCs across specs\n`);

  let totalDrifted = 0;
  let totalStale = 0;

  if (result.drifted.size > 0) {
    console.log("DRIFTED (file doesn't exist):");
    for (const [specFile, details] of result.drifted) {
      for (const detail of details) {
        console.log(`  ${detail.scId} in ${specFile}: references ${detail.path} but file does not exist`);
        totalDrifted++;
      }
    }
    console.log();
  }

  if (result.stale.size > 0) {
    console.log("STALE (keyword missing):");
    for (const [specFile, details] of result.stale) {
      for (const detail of details) {
        console.log(`  ${detail.scId} in ${specFile}: expects ${detail.path} to contain [${detail.keyword}] but it doesn't`);
        totalStale++;
      }
    }
    console.log();
  }

  if (totalDrifted === 0 && totalStale === 0) {
    console.log("✓ No drift or staleness detected\n");
  } else {
    console.log(`Summary: ${totalDrifted} drifted, ${totalStale} stale\n`);
    process.exit(1);  // Non-zero exit for CI integration
  }
}
