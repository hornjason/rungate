/**
 * #1741 — one decider for what a valid issue looks like.
 *
 * Covers nothing in `specs/` on purpose: the subject is a repository
 * convention (two issue forms, a gate and a generator agreeing on one list of
 * sections), not a spec criterion, and `.claude/rules/claiming-sc-coverage.md`
 * is explicit that a citation is not a claim.
 *
 * ## What this file is actually for
 *
 * `requiredSections` in `lib/issue-shape.ts` is the ONE decider. Everything
 * below exists to make a second one impossible to add quietly:
 *
 * | consumer | what binds it here |
 * |---|---|
 * | `.github/ISSUE_TEMPLATE/spec-work.yml` | its required field ids EQUAL the decider's, both directions |
 * | `.github/ISSUE_TEMPLATE/everyday-work.yml` | the same, for the second form |
 * | `lib/issue-filing-gate.ts` | a filing whose body is short a required section is refused MALFORMED |
 * | `lib/issue-decomposition.ts` | `decomposedBody` emits exactly the decider's headings |
 *
 * **Every one of those is an EQUALITY, not a containment**, and that is the
 * whole design. `.claude/rules/checks-must-be-able-to-fail.md`'s *two deciders
 * that agree* says a consumer that merely contains what the decider asks for
 * stays green when the decider is short-circuited to `return []` — everything
 * contains the empty set. An equality goes red, which is what makes the
 * mutation battery in the PR able to disagree.
 *
 * ## The battery is run by hand, and why it cannot live here
 *
 * The consumers import `../lib/issue-shape` by relative path, so a mutant copy
 * under `mkdtemp` is imported by nobody and the run witnesses nothing — the
 * *green on the exit code* shape. The battery therefore mutates the real file
 * in the worktree, runs each consumer suite, and reverts; its table is in the
 * pull request. Commit before you mutate.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { decomposedBody } from "../lib/issue-decomposition";
import {
  ISSUE_FORMS,
  ISSUE_SECTIONS,
  formTemplatePath,
  headingFor,
  headingOccurrencesOf,
  missingSections,
  requiredSections,
  sectionsOf,
  type IssueForm,
} from "../lib/issue-shape";

const ROOT = join(import.meta.dir, "..");

/** A body carrying exactly the sections named, each with a line of content. */
function bodyWith(headings: readonly string[]): string {
  return headings.map(h => `${h}\n\nsomething\n`).join("\n");
}

/** Every required heading for `form`, in the decider's order. */
function requiredHeadings(form: IssueForm): string[] {
  return requiredSections(form).map(headingFor);
}

describe("IS-1: the decider", () => {
  test("IS-1: both forms are declared and the set is closed", () => {
    expect([...ISSUE_FORMS]).toEqual(["spec-work", "everyday-work"]);
  });

  test("IS-2: spec-work requires the criterion field and everyday-work does not", () => {
    const spec = requiredSections("spec-work").map(s => s.id);
    const everyday = requiredSections("everyday-work").map(s => s.id);

    expect(spec).toContain("criteria");
    expect(everyday).not.toContain("criteria");

    // The ONE difference. If a later edit drops a second field from the
    // everyday form, this says so by name rather than by a count.
    expect(spec.filter(id => !everyday.includes(id))).toEqual(["criteria"]);
  });

  test("IS-3: both forms require the files list, which is rule 2", () => {
    for (const form of ISSUE_FORMS) {
      expect(requiredSections(form).map(s => s.id)).toContain("files");
    }
  });

  test("IS-4: `blocked by` is required by neither — empty is what puts it in Ready", () => {
    for (const form of ISSUE_FORMS) {
      expect(requiredSections(form).map(s => s.id)).not.toContain("blocked-by");
    }
    expect(ISSUE_SECTIONS.map(s => s.id)).toContain("blocked-by");
  });

  test("IS-5: a section's heading is its label, so one string spells both", () => {
    for (const section of ISSUE_SECTIONS) {
      expect(headingFor(section)).toBe(`## ${section.label}`);
    }
  });
});

describe("IS-10: reading a body", () => {
  test("IS-10: an empty body is short every required section, named", () => {
    for (const form of ISSUE_FORMS) {
      expect(missingSections("", form)).toEqual(requiredHeadings(form));
    }
  });

  test("IS-11: a complete body is short nothing", () => {
    for (const form of ISSUE_FORMS) {
      expect(missingSections(bodyWith(requiredHeadings(form)), form)).toEqual([]);
    }
  });

  test("IS-12: dropping any ONE required section is reported, and only that one", () => {
    for (const form of ISSUE_FORMS) {
      const all = requiredHeadings(form);
      for (const dropped of all) {
        const body = bodyWith(all.filter(h => h !== dropped));
        expect(missingSections(body, form), `dropped ${dropped} from the ${form} form`).toEqual([
          dropped,
        ]);
      }
    }
  });

  test("IS-13: a heading inside a fenced block is not a section", () => {
    const all = requiredHeadings("spec-work");
    const [hidden, ...rest] = all;
    const body = `${bodyWith(rest)}\n\`\`\`md\n${hidden}\n\nnot a real section\n\`\`\`\n`;

    // The exact failure `lib/issue-repair.ts` was caught on in its own security
    // review: these bodies quote markdown constantly, and an unanchored match
    // reads the quotation as the thing.
    expect(missingSections(body, "spec-work")).toEqual([hidden]);
  });

  test("IS-14: a heading named mid-sentence in prose is not a section", () => {
    const all = requiredHeadings("spec-work");
    const [hidden, ...rest] = all;
    const body = `${bodyWith(rest)}\nRemember to add a ${hidden} section before filing.\n`;

    expect(missingSections(body, "spec-work")).toEqual([hidden]);
  });

  test("IS-15: a deeper heading level still counts — `###` is a section", () => {
    const all = requiredHeadings("everyday-work");
    const body = all.map(h => `${h.replace(/^## /, "### ")}\n\nsomething\n`).join("\n");

    expect(missingSections(body, "everyday-work")).toEqual([]);
  });

  test("IS-16: a section with a heading and no content underneath is MISSING", () => {
    // The whole point of the form is the content. A heading over nothing is
    // the shape of a body somebody pasted the template into and did not fill
    // in, and it is indistinguishable from a filled one to any check that
    // only looks for the string.
    const all = requiredHeadings("everyday-work");
    const [empty, ...rest] = all;
    const body = `${empty}\n\n${bodyWith(rest)}`;

    expect(missingSections(body, "everyday-work")).toEqual([empty]);
  });

  test("IS-17: headingOccurrencesOf is the one heading parser, and it reports all of them", () => {
    const h = "## Criteria this serves";
    const body = `${h}\n\nSC-1\n\n## Other\n\nx\n\n${h}\n\nSC-2\n`;

    expect(headingOccurrencesOf(body, h)).toHaveLength(2);
  });
});

describe("IS-20: consumer — the issue forms on disk", () => {
  /** The `id:` of every field the form marks `required: true`. */
  function requiredFieldIds(form: IssueForm): string[] {
    const yml = readFileSync(join(ROOT, formTemplatePath(form)), "utf8");
    const out: string[] = [];
    let current: string | null = null;
    for (const line of yml.split("\n")) {
      const id = /^\s{2,}id:\s*(\S+)\s*$/.exec(line);
      if (id !== null) current = id[1];
      if (/^\s+required:\s*true\s*$/.test(line) && current !== null) out.push(current);
    }
    return out;
  }

  /** The `id:` of every field the form declares, required or not. */
  function fieldIds(form: IssueForm): string[] {
    const yml = readFileSync(join(ROOT, formTemplatePath(form)), "utf8");
    return [...yml.matchAll(/^\s{2,}id:\s*(\S+)\s*$/gm)].map(m => m[1]);
  }

  /** The `label:` of every field, in file order. */
  function fieldLabels(form: IssueForm): string[] {
    const yml = readFileSync(join(ROOT, formTemplatePath(form)), "utf8");
    return [...yml.matchAll(/^\s+label:\s*(.+?)\s*$/gm)].map(m => m[1]);
  }

  for (const form of ISSUE_FORMS) {
    test(`IS-20 (${form}): the form's required fields EQUAL the decider's`, () => {
      // An equality in both directions. Containment would stay green under the
      // mutation, because every list contains the empty one.
      expect(requiredFieldIds(form).sort()).toEqual(
        requiredSections(form)
          .map(s => s.id)
          .sort(),
      );
    });

    test(`IS-21 (${form}): every field the form shows is a section the decider knows`, () => {
      expect(fieldLabels(form).sort()).toEqual(
        ISSUE_SECTIONS.filter(s => s.forms.includes(form))
          .map(s => s.label)
          .sort(),
      );
    });
  }

  test("IS-22: the everyday form has no criteria FIELD, not merely an optional one", () => {
    // Not `required: false`. A consumer reporting upstream cannot know a
    // criterion id, and an optional field they leave blank still asks them a
    // question they have no way to answer.
    //
    // Asserted against the parsed fields rather than the raw text, because
    // the form's own preamble explains in prose WHY the criteria field is
    // absent — a substring check on the whole file reddens on the
    // explanation, which is the detector matching the discussion of the
    // thing instead of the thing.
    expect(fieldIds("everyday-work")).not.toContain("criteria");
    expect(sectionsOf("everyday-work").map(s => s.id)).not.toContain("criteria");
  });
});

describe("IS-30: consumer — the decomposition generator", () => {
  const ROW = {
    criterion: "CRC-B5",
    outcome: "a second round posts no thread for a finding already threaded",
    files: ["lib/ai-review-suppression.ts", "test/ai-review-suppression.test.ts"],
    milestone: null,
    blockedBy: [],
    line: 3,
  };

  test("IS-30: a decomposed body carries EXACTLY the spec-work headings, IN ORDER", () => {
    const body = decomposedBody(ROW, "## Criteria this serves", "docs/plan.md");
    const present = ISSUE_SECTIONS.map(s => ({
      id: s.id,
      at: headingOccurrencesOf(body, headingFor(s))[0],
    }))
      .filter(x => x.at !== undefined)
      .sort((a, b) => a.at - b.at)
      .map(x => x.id);

    // Equality again, and in this direction it is the half that matters: the
    // generator emitted four headings before the decider knew about any of
    // them, so a containment assertion here was satisfied by the status quo.
    //
    // **By POSITION, not as a sorted set.** `lib/issue-shape.ts` says the
    // declaration order is load-bearing for this generator, and when that
    // sentence was written it was false — the generator emitted Files
    // before Criteria while the decider and both forms declare Criteria
    // first. A sorted comparison could not see it, which is how the claim
    // survived into review. A sentence a test cannot contradict is not a
    // property, it is a hope.
    expect(present).toEqual(requiredSections("spec-work").map(s => s.id));
  });

  test("IS-31: a decomposed body is short nothing the gate would refuse it for", () => {
    const body = decomposedBody(ROW, "## Criteria this serves", "docs/plan.md");

    // The agreement the recorded decision turns on: `--decompose` emitted two
    // of the form's five fields, so a gate requiring the other three would
    // have refused every row of every plan. They land together or not at all.
    expect(missingSections(body, "spec-work")).toEqual([]);
  });

  test("IS-32: the proof section names the criterion, so it is derived and not a placeholder", () => {
    const body = decomposedBody(ROW, "## Criteria this serves", "docs/plan.md");
    const at = body.indexOf(headingFor(ISSUE_SECTIONS.find(s => s.id === "proof")!));
    const proof = body.slice(at);

    expect(proof).toContain(ROW.criterion);
  });
});
