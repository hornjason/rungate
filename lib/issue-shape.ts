/**
 * #1741 — what a valid issue looks like, decided in one place.
 *
 * ## Why this file exists at all
 *
 * Before it there was no decider and two half-answers.
 * `.github/ISSUE_TEMPLATE/spec-work.yml` asked for five fields and
 * `rungate plan-issues --decompose` emitted two of them, so a gate requiring
 * the other three would have refused every row of every plan. That is why the
 * recorded agreement (2026-11-03, `project-state.json`, the priority opening
 * *PATH B HAS NO INTAKE*) says the form, the gate and the generator must land
 * together: built apart, each grows its own notion of valid, and
 * `.claude/rules/checks-must-be-able-to-fail.md`'s *two deciders that agree*
 * says no behavioural test can then tell which one is live.
 *
 * ## The one decider is `requiredSections`
 *
 * Everything else in this file reads it, and every consumer reads one of
 * those. `test/issue-shape.test.ts` binds all four consumers with an
 * **equality** rather than a containment, which is the only form that goes
 * red when this function is short-circuited to `return []` — every list
 * contains the empty one, so a containment assertion certifies a decider that
 * has stopped deciding.
 *
 * ## The second form, and what it is for
 *
 * `spec-work` requires *Criteria this serves*. A consumer agent reporting a
 * problem upstream, and ordinary housekeeping, cannot know a criterion id —
 * so until `everyday-work` existed there was no correct way to file anything
 * that was not spec work, and the measured consequence was agents reaching
 * for the `external-audit` label, which the same decision had ruled out.
 *
 * The two forms differ in exactly one field and `test/issue-shape.test.ts`
 * asserts that by name. A second difference arriving later is a decision, not
 * a tidy-up.
 */

import { readFences } from "./markdown-fence";

/** The forms. The set is closed; adding one is an edit here and a file on disk. */
export const ISSUE_FORMS = ["spec-work", "everyday-work"] as const;

export type IssueForm = (typeof ISSUE_FORMS)[number];

export interface IssueSection {
  /** The `id:` of the field in the issue form, and the key everything joins on. */
  readonly id: string;
  /**
   * The field's `label:` in the form AND its heading in a rendered body.
   *
   * ONE string for both deliberately. Two would let the form ask for
   * *Criteria this serves* while the parser looked for *Criteria*, which is
   * the same class of defect this file exists to remove, one layer down.
   */
  readonly label: string;
  /** The forms that SHOW this field. */
  readonly forms: readonly IssueForm[];
  /** The forms that REQUIRE it. Always a subset of `forms`. */
  readonly required: readonly IssueForm[];
}

const BOTH = ISSUE_FORMS;

/**
 * Every section, in the order a form shows them.
 *
 * The order is load-bearing for `formTemplatePath`'s files and for
 * `decomposedBody`: a reader scanning a body top to bottom meets them in this
 * order, and a generator that emits them in another makes two issues that say
 * the same thing look different.
 */
export const ISSUE_SECTIONS: readonly IssueSection[] = [
  {
    id: "outcome",
    label: "What must become true",
    forms: BOTH,
    required: BOTH,
  },
  {
    id: "criteria",
    label: "Criteria this serves",
    forms: ["spec-work"],
    required: ["spec-work"],
  },
  {
    id: "files",
    label: "Files this will change",
    forms: BOTH,
    required: BOTH,
  },
  {
    id: "blocked-by",
    label: "Blocked by",
    forms: BOTH,
    // Required by neither, and that is the design: empty is what puts an
    // issue in the pickable set, so demanding the field would make every
    // filer invent an ordering and the board would then lie about it.
    required: [],
  },
  {
    id: "proof",
    label: "How we will know",
    forms: BOTH,
    required: BOTH,
  },
];

/**
 * **THE DECIDER.** What a body must carry to be a valid issue of this form.
 *
 * Short-circuit this to `return []` and all four consumers go red. If one
 * stays green it is a second decider and the work is not done —
 * `test/issue-shape.test.ts`'s header carries the battery's terms.
 */
export function requiredSections(form: IssueForm): readonly IssueSection[] {
  return ISSUE_SECTIONS.filter(s => s.required.includes(form));
}

/** Every section a form shows, required or not. */
export function sectionsOf(form: IssueForm): readonly IssueSection[] {
  return ISSUE_SECTIONS.filter(s => s.forms.includes(form));
}

/** The markdown heading that opens a section in a body. */
export function headingFor(section: IssueSection): string {
  return `## ${section.label}`;
}

/** Where the form lives, relative to the repository root. */
export function formTemplatePath(form: IssueForm): string {
  return `.github/ISSUE_TEMPLATE/${form}.yml`;
}

/**
 * Every offset at which `heading` OPENS A LINE, outside any fenced block.
 *
 * Generalised out of `lib/issue-repair.ts`, which held the only correct
 * version and held it for one hard-coded string. Its docblock records why the
 * obvious `body.indexOf` is wrong, and the answer is worth keeping in one
 * place: these bodies quote markdown and shell constantly, so an unanchored
 * match reads *"add a `## Criteria this serves` section"* in prose, and a
 * fence-blind one reads a template pasted into a code block. That was caught
 * by a security review rather than by a test, and the repair it would have
 * made was to REPLACE everything from the quotation to the next heading —
 * which in those bodies is the measurements the repair exists to preserve.
 *
 * Any heading level opens a section. A body that writes `### Files this will
 * change` has named the section; refusing it would be a decider narrower than
 * what it detects, with nothing gained.
 */
export function headingOccurrencesOf(body: string, heading: string): number[] {
  const text = heading.replace(/^#+\s*/, "");
  const opens = new RegExp(`^#{1,6}\\s+${escapeRegExp(text)}\\s*$`);
  const out: number[] = [];
  const lines = body.split("\n");
  // `~~~` fences too, and a fence closes only on its own marker (#2130).
  const { roles } = readFences(lines);
  let at = 0;
  for (let i = 0; i < lines.length; i++) {
    if (roles[i] === "prose" && opens.test(lines[i]!.trimEnd())) out.push(at);
    at += lines[i]!.length + 1;
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The headings a body is short, for `form`. Empty means well-formed.
 *
 * **A heading over nothing does not count.** A body somebody pasted the
 * template into and did not fill in carries every heading and answers no
 * question, and to a check that only looks for the string it is
 * indistinguishable from a complete one — *assertions that hold vacuously*,
 * in `.claude/rules/checks-must-be-able-to-fail.md`. So a section is present
 * when there is non-blank text between its heading and the next one.
 *
 * Returns headings rather than ids, because the only reader that matters is
 * an agent reading a refusal, and the heading is what they have to type.
 */
export function missingSections(body: string, form: IssueForm): string[] {
  return requiredSections(form)
    .filter(s => !hasContent(body, headingFor(s)))
    .map(headingFor);
}

/** True when `heading` opens a section with non-blank text under it. */
function hasContent(body: string, heading: string): boolean {
  for (const at of headingOccurrencesOf(body, heading)) {
    const rest = body.slice(at).split("\n").slice(1);
    for (const line of rest) {
      if (/^#{1,6}\s+\S/.test(line)) break; // the next section, with nothing between
      if (line.trim() !== "") return true;
    }
  }
  return false;
}
