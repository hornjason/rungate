/**
 * Who owns a `.claude/rules/*.md` file after a human has edited it (#370).
 *
 * `bun bin/rungate.ts scaffold . --fix` on a clean checkout of this repo
 * rewrote eight rule files unconditionally — `writeFileSync` in a loop, no
 * existence check, no comparison — and reported `GENERATED:` for each. On
 * 2026-10-13 that truncated `.claude/rules/checks-must-be-able-to-fail.md`
 * from 262 lines to 65, discarding every worked example and every mutation
 * table in the file the rest of the repo cites more than any other. The run
 * exited 0. `git status` said `M`, not `D`, so the loss did not even look
 * like a deletion.
 *
 * It also reverted `key-files.md`'s `#296` annotation — "DA-owned, never
 * written from an agent worktree" — which exists because run
 * `wf_0b15a933-b2b` lost four worktrees and 2,565 lines of validated work
 * when an agent wrote a DA-owned file.
 *
 * ## Why neither obvious answer works
 *
 * This is the other half of the question #208 asks from the opposite side:
 *
 * - **Never overwrite** (`safeWrite`, the plain `scaffold .` mode) writes
 *   nothing, so a generator fix never reaches a tree that already has the
 *   file. #363's AGENTS.md fix could not be adopted at all without `--fix`.
 * - **Always overwrite** (`--fix`) is the defect above.
 *
 * Neither can be right, because `key-files.md` is genuinely generated — its
 * table comes from a scan — *and* genuinely hand-annotated.
 *
 * ## The mechanism
 *
 * The generator stamps the sha of the body it wrote into the file's own
 * frontmatter. On the next run the file answers the only question that
 * matters — *has anyone touched this since the harness wrote it?* — without
 * a manifest that can desync from the tree it describes.
 *
 *   | existing file                              | action     |
 *   |--------------------------------------------|------------|
 *   | absent                                     | `create`   |
 *   | body identical to what would be generated  | `update`   |
 *   | carries a marker matching its own body     | `update`   |
 *   | anything else                              | `preserve` |
 *
 * The second row is what makes adoption possible without a migration: a file
 * the harness wrote before provenance existed is byte-identical to the
 * generator's output, so the first run recognises it and stamps it. Nothing
 * has to be hand-listed as owned.
 *
 * The last row is deliberately the fallback rather than an enumerated case.
 * An unrecognised file is preserved and REPORTED, never resolved — the
 * direction this is allowed to be wrong in is toward keeping a file the
 * harness could have regenerated, which costs a line in a report. The other
 * direction costs 197 lines of a rule nobody noticed was gone.
 */
import { createHash } from "crypto";
import { carryMarkedSection, normalizeTail, splitMarked, tailVariants } from "./scaffold/marked-section";

export type RuleAction = "create" | "update" | "preserve";

export interface RuleDecision {
  action: RuleAction;
  /** Why, in the words the scaffold report prints. */
  reason: string;
  /** What to write. Absent exactly when `action` is `preserve`. */
  content?: string;
}

/** The frontmatter key carrying the sha of the body the harness last wrote. */
export const PROVENANCE_KEY = "generated-sha";

/**
 * The one command that takes the generator's version of a preserved rule
 * file, once the file is deleted (#2835). Named in the scaffold's PRESERVED
 * line and in prompt-audit's note on a file written before the stamp, so the
 * two tools give a consumer the same way out.
 */
export const ACCEPT_GENERATED_RULE = "rungate scaffold . --fix";

/**
 * How a preserved file reaches the generator's version (review of #2852).
 * Deleting a file discards everything in it, so the advice says so either way.
 * A file with no stamp may predate it, or may be the project's own; what
 * nobody can tell from here is whether it holds a `## Project-owned` section,
 * so the warning names one (round 3). A stamped file was edited after rungate
 * wrote it, so the advice also offers the way that keeps the edit. One
 * sentence for every PRESERVED line and for `prompt-audit`'s pre-stamp note,
 * so no surface tells a consumer to delete what another warns about.
 */
export function acceptGeneratedAdvice(existing: string | null): string {
  if (existing === null || declaredSha(existing) === null)
    return `to accept it, delete the file, which discards everything in it, a \`## Project-owned\` section included, and re-run \`${ACCEPT_GENERATED_RULE}\``;
  return (
    `to keep the edit, move it under \`## Project-owned\`; to take the generator's version instead, ` +
    `delete the file, which discards the edit, and re-run \`${ACCEPT_GENERATED_RULE}\``
  );
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

/**
 * Everything after the frontmatter block.
 *
 * The sha covers the body alone, and that is load-bearing twice over: the
 * stamp lives in the frontmatter, so hashing the whole file would change the
 * thing being hashed, and `updated:`-style keys move on their own without
 * anybody editing the rule.
 */
export function ruleBody(text: string): string {
  // Leading blank lines go too. Without that the sha depends on whether the
  // block was followed by one newline or two — which differs between a file
  // that had frontmatter already and one the stamp just gave some, so the
  // very first stamped file would read as hand-edited on the next run.
  return text.replace(FRONTMATTER, "").replace(/^\n+/, "");
}

export function bodySha(text: string): string {
  return createHash("sha256").update(ruleBody(text)).digest("hex").slice(0, 16);
}

/** The sha the file claims the harness wrote, or null if it claims nothing. */
export function declaredSha(text: string): string | null {
  const fm = FRONTMATTER.exec(text);
  if (!fm) return null;
  const line = new RegExp(`^${PROVENANCE_KEY}:\\s*([0-9a-f]{16})\\s*$`, "m").exec(fm[1]);
  return line ? line[1] : null;
}

/**
 * Put the generated content's own body-sha into its frontmatter.
 *
 * Replaces an existing stamp rather than appending a second one — two
 * `generated-sha` lines would make `declaredSha` read whichever came first
 * and silently stop matching.
 */
export function stampProvenance(generated: string): string {
  const sha = bodySha(generated);
  const fm = FRONTMATTER.exec(generated);
  if (!fm) return `---\n${PROVENANCE_KEY}: ${sha}\n---\n\n${generated}`;
  const keys = fm[1]
    .split("\n")
    .filter(l => !new RegExp(`^${PROVENANCE_KEY}:`).test(l));
  const block = `---\n${[...keys, `${PROVENANCE_KEY}: ${sha}`].join("\n")}\n---\n`;
  return generated.replace(FRONTMATTER, block);
}

/**
 * Does the harness's stamp still cover this file — is everything it stamped
 * untouched since? The one reading of that question (#370, #1553):
 *
 * - `{ section: null }`: no `## Project-owned` section, and the body is what
 *   was stamped;
 * - `{ section }`: the text OUTSIDE the section is what was stamped, and the
 *   section (with its offset) is the project's;
 * - `null`: no stamp, or something the stamp covers was edited.
 *
 * `decideRuleWrite` decides writes from it and `textOwner`
 * (`lib/scaffold/steps.ts`) decides whose a line is, so the two cannot
 * disagree about the same file (review, PR #2285).
 */
export function stampCovers(text: string): { section: { start: number; text: string } | null } | null {
  const stamp = declaredSha(text);
  if (stamp === null) return null;
  const marked = splitMarked(text);
  if (marked === null) return stamp === bodySha(text) ? { section: null } : null;
  return tailVariants(marked.outside).some(v => bodySha(v) === stamp) ? { section: { start: marked.start, text: marked.section } } : null;
}

/**
 * The single place that decides whether a generated rule file may be written.
 *
 * One exported predicate on purpose. A second site deciding the same thing
 * would survive any mutation of this one, and the guard would go green for a
 * reason that has nothing to do with it working —
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 */
export function decideRuleWrite(existing: string | null, generated: string): RuleDecision {
  const content = stampProvenance(generated);
  if (existing === null) return { action: "create", reason: "no such file", content };

  // #1553 / SC-2769: a file carrying a `## Project-owned` section. The stamp
  // covers the text OUTSIDE the section, so a project's edits under it never
  // read as a hand edit of the file; an edit anywhere else still refuses, and
  // the refusal names the lines rather than freezing the file silently.
  const covered = stampCovers(existing);
  const marked = splitMarked(existing);
  if (marked !== null) {
    const stamp = declaredSha(existing);
    if (covered?.section) {
      return {
        action: "update",
        reason: "harness-written outside ## Project-owned and untouched since; the section is carried forward verbatim",
        content: carryMarkedSection(stampProvenance(normalizeTail(generated)), marked.section),
      };
    }
    const written = new Set(normalizeTail(generated).split("\n").map(l => l.trim()).filter(l => l !== ""));
    const edited = ruleBody(marked.outside).split("\n").map(l => l.trim()).filter(l => l !== "" && !written.has(l));
    const named =
      edited.length === 0
        ? "the text outside it no longer matches the harness's stamp"
        : `lines outside it the generator does not write: ${edited.slice(0, 3).map(l => JSON.stringify(l)).join(", ")}${edited.length > 3 ? ` and ${edited.length - 3} more` : ""}`;
    return {
      action: "preserve",
      reason:
        `${stamp === null ? "hand-authored, with a ## Project-owned section and no harness stamp" : "edited outside ## Project-owned"} — ${named}. ` +
        "Move the edit under ## Project-owned, or delete the file and re-run",
    };
  }

  if (bodySha(existing) === bodySha(generated)) {
    // Unchanged from what the generator would write. Writing is a no-op on
    // the body and stamps the marker, which is how a pre-provenance tree
    // adopts the mechanism without anyone listing files by hand.
    return { action: "update", reason: "identical to generator output", content };
  }

  if (covered !== null) {
    return { action: "update", reason: "harness-written and untouched since", content };
  }

  return {
    action: "preserve",
    reason:
      declaredSha(existing) === null
        ? "hand-authored — no harness provenance marker"
        : "hand-edited since the harness wrote it",
  };
}
