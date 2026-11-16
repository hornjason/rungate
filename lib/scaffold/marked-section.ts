/**
 * The marked section a project writes its own text under, inside a file the
 * scaffold generates (#1553 / SC-2769).
 *
 * Before this, a hand edit anywhere in a generated rule file froze the WHOLE
 * file: `decideRuleWrite` preserved it and withheld every later generator
 * change. On 2026-11-16 five of this repository's fourteen generated rule
 * files were frozen that way. Jason's decision on #1553: hand edits live under
 * a consumer-added `## Project-owned` heading; re-scaffold rewrites everything
 * outside it and carries the section forward verbatim; an edit outside the
 * section refuses the write and names the lines. No template writes the
 * heading, so it costs nothing on launch until a project uses it.
 *
 * Text operations only. Finding the section goes through
 * `readPreservedSection`, the reader agent briefs and AGENTS.md already use
 * (SC-2131 to SC-2139), so there is one definition of where a section ends.
 * What may be WRITTEN stays in `decideRuleWrite` (`lib/rule-provenance.ts`),
 * the one decider for rule files; this module has no opinion about stamps.
 */
import { readPreservedSection, type SectionSpec } from "../agents-md-sections";

/** The heading a project adds. It is the project's from that line to the next `##`. */
export const PROJECT_OWNED_SECTION: SectionSpec = {
  label: "## Project-owned",
  heading: /^##[ \t]+Project-owned\b[^\n]*$/m,
  // Not used here — `carryMarkedSection` always appends — but the type asks.
  anchors: [],
};

/** A file's text ends in exactly one newline: the one shape both sides compare. */
export function normalizeTail(text: string): string {
  return `${text.replace(/\s+$/, "")}\n`;
}

/**
 * The same text with zero to three trailing blank lines (review, PR #2285).
 *
 * A stamp is taken over a body AS WRITTEN, and a generated body may end in
 * more than one newline; taking the section out cannot know how many there
 * were. Trailing blank lines are the one thing that may differ, and they can
 * carry no edit, so the stamp is compared against each — never against any
 * other variation, which would let a real edit through.
 */
export function tailVariants(text: string): string[] {
  const base = text.replace(/\s+$/, "");
  return [`${base}\n`, `${base}\n\n`, `${base}\n\n\n`, `${base}\n\n\n\n`];
}

/**
 * The file with its `## Project-owned` section taken out, and the section.
 * Null when the file has no section, or only the heading (nothing to carry).
 *
 * `outside` is what the harness wrote, if nobody touched it: the section and
 * the blank lines around it are removed so the result compares equal to the
 * text the stamp was taken over, wherever in the file the section sat.
 * `start` is the section's offset in `text`, for a caller mapping lines.
 */
export function splitMarked(text: string): { outside: string; section: string; start: number } | null {
  const reading = readPreservedSection(text, PROJECT_OWNED_SECTION);
  if (reading === null) return null;
  const start = reading.start; // where the heading matched — never re-found by content (#2285)
  const before = text.slice(0, start);
  const after = text.slice(start + reading.text.length).replace(/^\s+/, "");
  const outside = after === "" ? normalizeTail(before) : `${before}${after}`;
  return { outside, section: reading.text, start };
}

/**
 * The generated text with the project's section carried forward verbatim,
 * appended after it. Always at the end: one position, so the next run finds
 * it the same way and the file never reorders itself between runs.
 */
export function carryMarkedSection(generated: string, section: string): string {
  return `${normalizeTail(generated)}\n${section}\n`;
}
