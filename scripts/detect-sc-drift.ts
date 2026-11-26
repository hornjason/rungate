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

/** The extensions a file path in a criterion ends in. */
const FILE_EXT_SOURCE = String.raw`\.(?:ts|js|md|json)`;

/**
 * A file path in a criterion, read only from its start (#2883). A listed
 * directory that follows a word character, `.`, `-` or a `/` inside
 * another path is a segment of that path, not the start of this one, so a
 * consumer's `src/lib/x.ts` is never read as `lib/x.ts` and reported
 * missing. A root-relative `./lib/x.ts` or `/lib/x.ts` names the same file
 * as `lib/x.ts` and is read as it (review round 1); `../lib/x.ts` is not.
 * Both readers below build on this one source, so they cannot disagree
 * about where a path starts.
 */
const PATH_SOURCE = String.raw`(?<![\w./-])(?:\.?\/)?((?:lib|scripts|test|gates|workflows|hooks)\/[^\s,\]]+${FILE_EXT_SOURCE})`;

/** A file named directly before a clause, whether or not {@link PATH_SOURCE} reads it. */
const NAMED_FILE_BEFORE = new RegExp(String.raw`\S+${FILE_EXT_SOURCE}\s+$`);

/**
 * Extract file paths from SC statement text.
 * Matches patterns like: lib/foo.ts, scripts/bar.ts, test/baz.test.ts, etc.
 */
function extractFilePaths(statement: string): string[] {
  const paths: string[] = [];
  const pathPattern = new RegExp(PATH_SOURCE, "g");
  let match;
  while ((match = pathPattern.exec(statement)) !== null) {
    paths.push(match[1]);
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
    const before = head.match(new RegExp(String.raw`${PATH_SOURCE}\s+$`));
    // A clause on a file this reader does not read (`src/lib/x.ts`) is that
    // file's, not every path's: binding it to null would check its keywords
    // in each other file the criterion names, the #2287 class (review round
    // 1). Its keywords are checked nowhere, as its existence is not.
    if (!before && NAMED_FILE_BEFORE.test(head)) continue;
    out.push({ path: before ? before[1] : null, keywords: m[1].split(",").map(k => k.trim()).filter(Boolean) });
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
