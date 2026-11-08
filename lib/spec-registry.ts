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
 * #1692 and #1906 finished that for the two that DECIDE: `governsOf` is the
 * one extractor and `isValidGoverns` the one predicate, and `HYGIENE-1` in
 * `lib/conformity.ts` calls both. This module holds no frontmatter parser of
 * its own, and `test/governs-folded-scalar.test.ts` asserts that rather than
 * leaving it to this sentence. `scanner.ts` and `spec-validators.ts` still
 * extract their own; they render text and compose a warning, and neither
 * decides whether a spec is governed.
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

/** The frontmatter block: everything between the opening and closing `---`. */
const FRONTMATTER = /^---\n([\s\S]*?)\n---/;

/** A `governs:` line at column 0, and whatever follows it on that line. */
const GOVERNS_LINE = /^governs:[ \t]*(.*)$/m;

/**
 * The inline text of a document's `governs:` field — the one extractor.
 *
 * Returns `undefined` when the document declares no `governs` at all, and
 * the empty string when it declares one whose value is not on that line.
 * Those are different facts and both callers need to tell them apart.
 *
 * Deliberately reads the inline text ONLY. Raised in review of #1906: the
 * two callers used to extract `governs` with two different frontmatter
 * parsers, and on a bare `governs:` with the text indented below,
 * `lib/conformity.ts`'s flattened the continuation lines and joined them
 * with `"; "` while `lib/spec-registry.ts`'s never set the key — so
 * HYGIENE-1 called the spec governed and `getUngoverned` called the same
 * spec ungoverned, in the same run. Unifying the predicate had not fixed
 * that, because the disagreement was upstream of the predicate.
 *
 * A value on the lines below is therefore absent to both readers rather
 * than present and different. That is the same decision #1692 made about
 * the folded form, applied to the shape that has no indicator: `governs`
 * is one line, and anything else is refused rather than guessed at.
 */
export function governsOf(content: string): string | undefined {
  const fm = FRONTMATTER.exec(content);
  if (!fm) return undefined;
  const line = GOVERNS_LINE.exec(fm[1]);
  return line ? line[1].trim() : undefined;
}

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
 * `lib/conformity.ts`'s HYGIENE-1 calls this, over a value `governsOf`
 * extracted. One extractor and one predicate — two copies of either is what
 * let the disagreement sit unnoticed.
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
    const governs = governsOf(content); // #1906 — the one extractor
    const relFile = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (isValidGoverns(governs)) {
      governed.push({
        file: relFile,
        governs,
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
