/**
 * The four-step process, as an owned rules file — #2049, ADR-014 decision 4,
 * SC-2747.
 *
 * ADR-013 rule 9 lives in AGENTS.md's Hard Constraints, a project-owned
 * section the generator preserves and never writes, so a consumer never got
 * it. The scaffold now writes `.claude/rules/alignment-process.md` from the
 * single source below, and this repository's own rule 9 is CHECKED against
 * the same source ({@link ruleNineViolations}), so the consumer's copy and
 * ours cannot drift: change a step here and AGENTS.md goes red until it
 * agrees; drop a load-bearing phrase from AGENTS.md and the same check fails.
 *
 * ## The check is on load-bearing phrases, not bytes
 *
 * AGENTS.md's rule 9 says "until Jason agrees" and cites #296; a consumer's
 * file cannot. So each step carries the phrases that MAKE it the step — the
 * template path, the workflow, the closing keyword — and the check asks that
 * each appears under the right step number, in order. A rewording is free; a
 * step that loses its mechanism is not.
 *
 * ## Loaded at launch for a consumer, on demand here
 *
 * A consumer's copy carries no `paths:`, so every agent reads the process.
 * This repository's copy is the same body scoped to `docs/adr/**`: AGENTS.md
 * already carries rule 9 at launch, and loading it twice costs every agent
 * here bytes the instruction-surface budget does not have.
 */

/** The file this module generates, under `.claude/rules/`. */
export const ALIGNMENT_PROCESS_RULE_FILE = "alignment-process.md";

export interface ProcessStep {
  step: 1 | 2 | 3 | 4;
  /** The step as a consumer's rules file states it. */
  text: string;
  /** Phrases that make it this step, each of which must appear in `text` and in AGENTS.md's rule 9 under `(step)`. */
  names: readonly string[];
}

/** The one source. */
export const PROCESS_STEPS: readonly ProcessStep[] = [
  {
    step: 1,
    text: "Agree and file one issue the same turn, naming its files.",
    names: ["file one issue the same turn", "naming its files"],
  },
  {
    step: 2,
    text:
      "Bigger than one issue, or a rule or gate change: an ADR from `docs/adr/TEMPLATE.md`, its criteria in " +
      "the spec, and `/dry-run` until the repository owner agrees; the owner merges it.",
    names: ["docs/adr/TEMPLATE.md", "/dry-run", "merges it"],
  },
  {
    step: 3,
    text: "On merge, `.github/workflows/adr-accepted.yml` places the plan on the tracker.",
    names: ["adr-accepted.yml", "places the plan"],
  },
  {
    step: 4,
    text:
      "Each pull request says `Fixes #N`; `closing-references` refuses one that closes no issue, or whose " +
      "issue names no criterion nor `serves no criterion`.",
    names: ["Fixes #N", "closing-references", "serves no criterion"],
  },
];

/** What the steps do not apply to. */
export const PROCESS_EXEMPTIONS = {
  text:
    "Step 1 skips work that decides the issues — an ADR, a retro, a review, an audit — as its pull request " +
    "closes the issue it was filed under. Step 4 skips a pull request whose files are all " +
    "`project-state.json`, `PROJECT-STATE.md` and `SUCCESS.md`: the diff decides, never the branch name.",
  names: [
    "an ADR, a retro, a review, an audit",
    "project-state.json",
    "PROJECT-STATE.md",
    "SUCCESS.md",
    "the diff decides, never the branch name",
  ],
} as const;

/** The rules file. `scoped` is this repository's copy — see the module comment. */
export function alignmentProcessRule(opts: { scoped: boolean }): string {
  const paths = opts.scoped ? 'paths:\n  - "docs/adr/**"\n' : "";
  const steps = PROCESS_STEPS.map(s => `${s.step}. ${s.text}`).join("\n");
  return `---
description: The four-step process — an agreement is not real until it is an issue
${paths}---

## An agreement is not real until it is an issue

${steps}

**Exempt.** ${PROCESS_EXEMPTIONS.text}

Steps 3 and 4 are enforced: \`adr-accepted.yml\` places an accepted ADR's plan,
and \`closing-references\` is the check that refuses a pull request breaking
step 4. Steps 1 and 2 are yours.
`;
}

const flat = (s: string) => s.replace(/\s+/g, " ");

/**
 * Where AGENTS.md's rule 9 disagrees with {@link PROCESS_STEPS}: each step's
 * marker `(N)` must appear, in order, and each of its phrases must sit between
 * its marker and the next; each exemption phrase must follow `Exempt`. An
 * absent rule 9 is a violation, never an empty list.
 */
export function ruleNineViolations(agentsMd: string): string[] {
  const start = agentsMd.search(/^9\. \*\*/m);
  if (start === -1) return ["AGENTS.md has no rule 9 (a line starting `9. **`)"];
  const rest = agentsMd.slice(start);
  const end = rest.search(/^10\. \*\*/m);
  const rule = flat(end === -1 ? rest : rest.slice(0, end));
  const out: string[] = [];
  const marks = PROCESS_STEPS.map(s => rule.indexOf(`(${s.step})`));
  const exempt = rule.indexOf("Exempt");
  PROCESS_STEPS.forEach((s, i) => {
    if (marks[i] === -1) {
      out.push(`rule 9 has no step marker (${s.step})`);
      return;
    }
    if (i > 0 && marks[i] < marks[i - 1]) out.push(`rule 9's step (${s.step}) comes before step (${s.step - 1})`);
    const next = marks.slice(i + 1).find(m => m > marks[i]) ?? (exempt > marks[i] ? exempt : rule.length);
    const body = rule.slice(marks[i], next);
    for (const name of s.names) {
      if (!body.includes(name)) out.push(`rule 9's step (${s.step}) does not say "${name}"`);
    }
  });
  if (exempt === -1) out.push("rule 9 states no exemptions (no `Exempt`)");
  else {
    const tail = rule.slice(exempt);
    for (const name of PROCESS_EXEMPTIONS.names) {
      if (!tail.includes(name)) out.push(`rule 9's exemptions do not say "${name}"`);
    }
  }
  return out;
}
