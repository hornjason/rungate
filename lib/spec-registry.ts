/**
 * Spec Registry — governs-field discovery for spec files.
 *
 * SC-505: exports [getGoverningSpecs, getGovernedFiles, getUngoverned]
 * SC-506: contains [governs, frontmatter, specs/, invertedIndex]
 *
 * Three consumers already parse governs-field independently (scanner.ts,
 * conformity.ts, spec-validators.ts). This module centralizes the contract
 * so doc-hygiene, scaffold, and gate enforcement share one source of truth.
 *
 * Issue: #24
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

export interface SpecEntry {
  /** Filename relative to specs/ (e.g. "GATE-CONTRACTS-SPEC.md" or "sub/SUB-SPEC.md") */
  file: string;
  /** Parsed governs field from frontmatter */
  governs: string;
  /** Full path to the spec file */
  path: string;
}

/**
 * Parse frontmatter from a markdown file's content.
 * Returns key-value pairs from YAML-style frontmatter block.
 */
function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

/**
 * A YAML block-scalar header, which is what a line-based frontmatter reader
 * captures when the value is folded onto the lines below it.
 *
 * `>` folds, `|` keeps newlines, either may carry a chomping indicator
 * (`-`/`+`) and an explicit indentation digit, in either order, and either
 * may be followed by a comment. The class is deliberately a touch wider than
 * YAML — `>--` is not legal YAML and is not governs text either, and a
 * detector narrower than the syntax it detects is the defect in #1692, not
 * the fix for it.
 *
 * The comment is matched here rather than stripped beforehand, so a `#` in
 * real governs text — "the # anchor parser" — is never cut: nothing is
 * removed unless what precedes it is already a block header.
 */
const BLOCK_SCALAR_HEADER = /^[>|][0-9+-]{0,2}(\s+#.*)?$/;

/**
 * Check if a governs field value is valid (non-empty, not TODO, not a
 * folded block whose text this reader never saw).
 *
 * #1692: `governs: >-` with the prose on the indented lines below parses to
 * the two characters `">-"` in every line-based reader in this tree. That is
 * non-empty and contains no `TODO`, so it used to pass here and in
 * `HYGIENE-1` while `lib/scanner.ts` dropped it for being under six
 * characters and rendered a blank routing row. A folded `governs` is
 * REFUSED rather than supported: all specs state it on one line, and
 * supporting it means a reader that knows how `>` and `|` join their lines,
 * which nothing here needs.
 *
 * `lib/conformity.ts`'s HYGIENE-1 calls this. It is the one decider — two
 * copies of the same criteria is what let the disagreement sit unnoticed.
 */
export function isValidGoverns(governs: string | undefined): governs is string {
  if (!governs) return false;
  const trimmed = governs.trim();
  if (BLOCK_SCALAR_HEADER.test(trimmed)) return false;
  return trimmed.length > 0 && !trimmed.includes('TODO');
}

/**
 * Scan a single directory for spec files and extract governs frontmatter.
 */
function scanSpecDir(dir: string, prefix: string = ''): { governed: SpecEntry[]; ungoverned: string[] } {
  const governed: SpecEntry[] = [];
  const ungoverned: string[] = [];

  if (!existsSync(dir)) return { governed, ungoverned };

  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Recurse into subdirectories
      const subResult = scanSpecDir(join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
      governed.push(...subResult.governed);
      ungoverned.push(...subResult.ungoverned);
      continue;
    }

    if (!entry.name.endsWith('.md')) continue;
    if (entry.name === 'SPEC-TEMPLATE.md') continue;
    if (entry.name === 'INDEX.md') continue;

    const filePath = join(dir, entry.name);
    const content = readFileSync(filePath, 'utf-8');
    const fm = parseFrontmatter(content);
    const relFile = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (fm && isValidGoverns(fm.governs)) {
      governed.push({
        file: relFile,
        governs: fm.governs,
        path: filePath,
      });
    } else {
      ungoverned.push(relFile);
    }
  }

  return { governed, ungoverned };
}

/**
 * Get all specs that have a valid governs field in their frontmatter.
 *
 * Scans specs/ directory (and subdirectories) under the given root.
 * Returns an array of SpecEntry objects with file, governs, and path.
 */
export function getGoverningSpecs(root: string): SpecEntry[] {
  const specsDir = join(root, 'specs');
  return scanSpecDir(specsDir).governed;
}

/**
 * Build an invertedIndex mapping governs text to spec file names.
 *
 * Used by doc-hygiene to look up which spec governs a given area.
 * Each governs value maps to an array of spec filenames that claim it.
 */
export function getGovernedFiles(root: string): Record<string, string[]> {
  const specs = getGoverningSpecs(root);
  const invertedIndex: Record<string, string[]> = {};

  for (const spec of specs) {
    if (!invertedIndex[spec.governs]) {
      invertedIndex[spec.governs] = [];
    }
    invertedIndex[spec.governs].push(spec.file);
  }

  return invertedIndex;
}

/**
 * Get spec files that lack a valid governs field.
 *
 * Returns filenames (relative to specs/) that have no governs
 * or have TODO as their governs value.
 */
export function getUngoverned(root: string): string[] {
  const specsDir = join(root, 'specs');
  return scanSpecDir(specsDir).ungoverned;
}
