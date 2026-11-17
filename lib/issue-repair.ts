/**
 * Repairing an issue's link back to the spec — step 4 of ADR-003, in reverse.
 *
 * `plan-spec` derives milestones from the spec and `plan-deps` derives the
 * order from the milestones. Both read DOWN from the spec. This reads a
 * repair plan a person wrote and applies it UP: an issue that names no
 * criterion is invisible to `criterion-inventory`, to `plan-spec`'s coverage
 * report and to `board-mirror`'s Criteria column, because all three match the
 * criterion id as literal text in the body.
 *
 * Measured 2026-10-29: 11 of 39 open convergence issues named no criterion.
 * The classification of all eleven is
 * `docs/adr/ADR-005-backlog-criterion-repair.md`, approved by Jason.
 *
 * ## The judgement is in the plan file, never here
 *
 * Which criterion an issue serves is an adjudication. This file parses a
 * table somebody reviewed and refuses anything it cannot read, rather than
 * inferring a link from an issue's title — a tool that guessed would write a
 * criterion id into a body and make `plan-spec` report a phase as covered
 * when nothing is working on it. That is the coverage report lying in the
 * direction that hides a gap.
 *
 * ## DEMOTE removes the milestone, and that is not a close
 *
 * A phase milestone means *this phase of the spec*. An issue in it serving no
 * criterion keeps the milestone open after every criterion is true, so nobody
 * can tell real remaining work from a stray card — and `plan-deps` blocks the
 * whole next phase on it. Closing instead would destroy the measurements in
 * those bodies and move both sides of the opened-against-closed ratio
 * `AGENTS.md` rule 7 asks us to watch.
 */

import { criterionAnswer } from "./board-mirror";
import { headingOccurrencesOf } from "./issue-shape";
import { PHASE_VALUE, phaseInFamily } from "./spec-placement";
import type { MilestoneAction } from "./spec-placement";

/** The section a repaired body carries. One spelling, by fiat. */
export const CRITERIA_HEADING = "## Criteria this serves";

export type RepairKind = "annotate" | "demote";

export interface RepairRow {
  issue: number;
  phase: number;
  kind: RepairKind;
  /** Criterion ids, in table order. Always empty for `demote`. */
  criteria: string[];
  confidence: string;
  /** 1-indexed line of the row, for a message somebody can act on. */
  line: number;
}

export interface RepairReading {
  /** UNMEASURED FAILS. An empty row list from an unfound table is not a clean one. */
  reading: "MEASURED" | "UNMEASURED";
  unmeasuredReasons: string[];
  rows: RepairRow[];
  /** Rows the parser reached and rejected, with why. */
  rejected: { line: number; text: string; why: string }[];
}

/** The header the table must open with, so another table is never read as one. */
const HEADER = /^\|\s*Issue\s*\|\s*Phase\s*\|\s*Repair\s*\|/;

/**
 * Every row of a repair plan's table.
 *
 * A row the parser cannot read is a **rejection with a reason**, never a row
 * skipped. An unreadable row and an absent row produce the same empty result
 * otherwise, and only one of them is a plan somebody can act on
 * (`.claude/rules/config-access.md`, *Silent Default Substitution*).
 */
export function parseRepairPlan(content: string): RepairReading {
  const lines = content.split("\n");
  const start = lines.findIndex(l => HEADER.test(l));
  const reasons: string[] = [];
  if (start === -1) {
    return {
      reading: "UNMEASURED",
      unmeasuredReasons: [
        "no `| Issue | Phase | Repair |` table — a plan with no table reads exactly " +
          "like a plan with nothing left to do",
      ],
      rows: [],
      rejected: [],
    };
  }

  const rows: RepairRow[] = [];
  const rejected: { line: number; text: string; why: string }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("|")) break;
    if (/^\|[\s|:-]+\|$/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map(c => c.trim());
    const at = i + 1;
    if (cells.length < 5) {
      rejected.push({ line: at, text: line.slice(0, 70), why: `only ${cells.length} cells, need 5` });
      continue;
    }
    const issue = Number((cells[0].match(/#(\d+)/) ?? [])[1]);
    const phase = Number(cells[1]);
    const kindCell = cells[2].replaceAll("*", "").trim();
    const kind: RepairKind | null =
      kindCell === "(a)" ? "annotate" : kindCell === "(b)" ? "demote" : null;
    const criteria = [...cells[3].matchAll(/\b[A-Z]+(?:-[A-Z]?\d+)+\b/g)].map(m => m[0]);

    if (!Number.isInteger(issue)) {
      rejected.push({ line: at, text: line.slice(0, 70), why: "first cell holds no #<number>" });
      continue;
    }
    if (!Number.isInteger(phase)) {
      rejected.push({ line: at, text: line.slice(0, 70), why: `phase "${cells[1]}" is not a number` });
      continue;
    }
    if (kind === null) {
      rejected.push({ line: at, text: line.slice(0, 70), why: `repair "${kindCell}" is neither (a) nor (b)` });
      continue;
    }
    // The two halves must agree. An `(a)` naming nothing would annotate a body
    // with an empty list, and a `(b)` naming criteria is a row whose author
    // changed their mind in one cell and not the other.
    if (kind === "annotate" && criteria.length === 0) {
      rejected.push({ line: at, text: line.slice(0, 70), why: "(a) names no criterion" });
      continue;
    }
    if (kind === "demote" && criteria.length > 0) {
      rejected.push({
        line: at,
        text: line.slice(0, 70),
        why: `(b) names ${criteria.join(", ")} — demote and a criterion disagree`,
      });
      continue;
    }
    rows.push({ issue, phase, kind, criteria, confidence: cells[4], line: at });
  }

  if (rows.length === 0 && rejected.length === 0) {
    reasons.push("the table has a header and no rows");
  }
  const seen = new Map<number, number>();
  for (const r of rows) {
    const first = seen.get(r.issue);
    if (first !== undefined) {
      reasons.push(`#${r.issue} appears twice, at lines ${first} and ${r.line}`);
    }
    seen.set(r.issue, r.line);
  }
  if (rejected.length > 0) {
    reasons.push(
      `${rejected.length} row(s) could not be read — a plan that is partly unreadable is ` +
        `not a plan that is partly done`,
    );
  }

  return {
    reading: reasons.length > 0 ? "UNMEASURED" : "MEASURED",
    unmeasuredReasons: reasons,
    rows,
    rejected,
  };
}

/**
 * The body an `annotate` row should produce, and whether it differs.
 *
 * Appends `## Criteria this serves` when absent and REPLACES its contents
 * when present, so a re-run with an edited plan converges rather than
 * stacking a second section. The rest of the body is untouched — those
 * bodies carry the measurements that make the issues worth keeping.
 */
export function annotatedBody(body: string, criteria: readonly string[]): string {
  const ids = criteria.join(", ");
  const section = `${CRITERIA_HEADING}\n\n${ids}\n`;
  const found = headingOccurrences(body);
  if (found.length === 0) return `${body.replace(/\s*$/, "")}\n\n${section}`;
  const at = found[0];
  // Up to the next `## ` heading, or the end.
  const rest = body.slice(at + CRITERIA_HEADING.length);
  const nextAt = rest.search(/^## /m);
  return nextAt === -1
    ? `${body.slice(0, at)}${section}`
    : `${body.slice(0, at)}${section}\n${rest.slice(nextAt)}`;
}

/**
 * Where `## Criteria this serves` opens a line, OUTSIDE any fenced block.
 *
 * The first version located it with `body.indexOf`, while the terminator
 * below used an anchored `/^## /m`. Two different ideas of what a heading is,
 * in one function: an unanchored match hits the string mid-sentence and
 * inside a ``` fence, and these bodies quote shell and TypeScript constantly.
 * A body saying *"add a `## Criteria this serves` section"* in prose would
 * have had everything from that phrase to its next heading REPLACED — and
 * what these issues carry between headings is the measurements the repair
 * exists to preserve. Caught by the security review of this PR.
 *
 * Returns every occurrence, because more than one is a body
 * {@link multiplyAnnotated} refuses rather than a first match to edit.
 *
 * **#1741: the body of this is now `lib/issue-shape.ts`.** Everything above
 * is why the obvious version is wrong, and that reasoning was correct and
 * hard-won — but it lived here, bound to one hard-coded heading, while the
 * filing gate and the issue forms were growing a need for the same reading
 * of a different heading. Two heading parsers answering the same question
 * about the same input is *two deciders that agree*
 * (`.claude/rules/checks-must-be-able-to-fail.md`): no behavioural test can
 * tell them apart and a mutation of either leaves the other holding the case
 * up. One parser, parameterised by the heading.
 */
export function headingOccurrences(body: string): number[] {
  return headingOccurrencesOf(body, CRITERIA_HEADING);
}

/**
 * True when a body carries the section more than once.
 *
 * Editing the first of two is a guess about which one the author meant, and
 * the other keeps whatever stale ids it holds — so `criterion-inventory`
 * goes on reading a criterion this repair was meant to move away from.
 * Refuse and let a person look.
 */
export function multiplyAnnotated(body: string): boolean {
  return headingOccurrences(body).length > 1;
}

/** True when the body already names every criterion the row asks for. */
export function alreadyAnnotated(body: string, criteria: readonly string[]): boolean {
  return annotatedBody(body, criteria) === body;
}

/** Where a repair row's issue belongs in one milestone family (#2042). */
export type RowPlacement =
  | { kind: "place"; milestone: string; phase: number }
  | { kind: "skip"; why: string }
  | { kind: "refuse"; why: string };

/**
 * Which `<prefix> Phase N` milestone a row's issue belongs in, read from the
 * family spec's placement table through `milestonePlan`, the one decider of
 * which criteria a phase holds.
 *
 * Opt-in per family (Jason, 2026-11-13). A repair table can mix families,
 * as ADR-015's does, so a row the family's spec does not place is skipped,
 * never moved on its Phase column alone. Disagreement is a refusal: the
 * row's Phase column against the spec, criteria split across phases, or a
 * row naming criteria both inside and outside the family, or one of the
 * family's criteria that its spec places in no phase (`Blocked`, `Done` and
 * the other `NON_PHASE_PLACEMENTS`) beside one it does. So is a phase
 * whose milestone does not exist; `plan-spec` makes milestones, and this
 * never does.
 */
export function rowPlacement(
  row: RepairRow,
  plan: readonly MilestoneAction[],
  prefix: string,
  /** Every criterion the family spec states, placed in a phase or not. */
  stated: ReadonlySet<string>,
): RowPlacement {
  const actionFor = new Map<string, MilestoneAction>();
  for (const a of plan) for (const id of a.criteria) actionFor.set(id, a);
  const placed = row.criteria.filter(id => actionFor.has(id));
  const unphased = row.criteria.filter(id => stated.has(id) && !actionFor.has(id));
  const outside = row.criteria.filter(id => !stated.has(id));
  if (placed.length === 0 && unphased.length === 0) {
    return { kind: "skip", why: `names nothing ${prefix}'s spec states — not placed in a ${prefix} phase` };
  }
  if (outside.length > 0) {
    return {
      kind: "refuse",
      why:
        `names ${[...placed, ...unphased].join(", ")} from ${prefix}'s spec and ${outside.join(", ")} ` +
        "from outside it — one row cannot sit in two families",
    };
  }
  if (placed.length === 0) {
    return { kind: "skip", why: `${prefix}'s spec places ${unphased.join(", ")} in no phase, so there is no milestone to move into` };
  }
  if (unphased.length > 0) {
    return {
      kind: "refuse",
      why: `${placed.join(", ")} sit in a phase and ${unphased.join(", ")} has no phase in ${prefix}'s spec`,
    };
  }
  const actions = [...new Set(placed.map(id => actionFor.get(id)!))];
  if (actions.length > 1) {
    return {
      kind: "refuse",
      why: `its criteria sit in ${actions.map(a => `Phase ${a.phase}`).join(" and ")} of ${prefix}'s spec`,
    };
  }
  const target = actions[0]!;
  if (target.phase !== row.phase) {
    return {
      kind: "refuse",
      why: `the plan says Phase ${row.phase} and ${prefix}'s spec places ${placed.join(", ")} in Phase ${target.phase}`,
    };
  }
  if (!target.existing) {
    return {
      kind: "refuse",
      why: `"${target.title}" has no milestone — run plan-spec for ${prefix}'s spec first; this never creates one`,
    };
  }
  return { kind: "place", milestone: target.existing.title, phase: target.phase };
}

/** One opted-in family, as the placing run reads it — SC-2779. */
export interface PlacingFamily {
  /** The `board: { prefix }` its spec declares. */
  prefix: string;
  /** Every criterion the family's spec states, placed in a phase or not. */
  stated: readonly string[];
  /** Each placed criterion's value in the spec's table (`placementsById`). */
  placements: ReadonlyMap<string, string>;
  /** The live milestone for each phase the table places. A phase with none is absent. */
  milestones: ReadonlyMap<number, string>;
}

/**
 * What the placing run does with one open issue — SC-2779.
 *
 * - `move`: into `milestone`, the family's milestone for the phase.
 * - `stay`: it already sits there.
 * - `left`: the rule leaves it where it is, and the run says why by name.
 * - `none`: it names no criterion an opted-in spec states; nothing to say.
 * - `refuse`: the phase it belongs in has no milestone. The run writes nothing,
 *   because `plan-spec` makes milestones and this never does.
 */
export type IssueMove =
  | { kind: "move"; milestone: string; why: string }
  | { kind: "stay"; why: string }
  | { kind: "left"; why: string }
  | { kind: "none" }
  | { kind: "refuse"; why: string };

/**
 * Which milestone an open issue belongs in, read from the opted-in specs —
 * SC-2779, ADR-018 Decision 4 as ADR-019 Decision 3 narrowed it.
 *
 * THE one decider. `plan-issues --place` asks it about every open issue, and
 * nothing else moves an issue between phases.
 *
 * - Criteria in ONE phase of ONE family: the issue moves to that phase's
 *   milestone, whether it has no milestone or a different one of that family.
 * - No milestone, criteria in several phases of one family: the lowest, since
 *   the issue cannot finish before its earliest phase does.
 * - A milestone, criteria in several phases: never moved.
 * - Criteria from two families: left where it is and named, because phase
 *   numbers do not compare across specs.
 * - A milestone that is not one of the family's phases: never moved.
 *
 * Two readings this adds, both in the direction of not moving anything:
 *
 * - **"Serves no criterion" is believed.** The same {@link criterionAnswer}
 *   the `needs-criterion` label reads. An issue saying it serves none names
 *   criteria only in passing: on 2026-11-17 #2307 cited SC-2734 and SC-2776
 *   that way, and reading them as served would have moved it into the
 *   finished Engine Phase 6, where the phase order then holds every later
 *   phase behind it.
 * - **A criterion placed outside every phase stops the move.** `Done`,
 *   `Blocked` and the other non-phase values, or no placement at all, mean
 *   the issue does not sit wholly in a phase, so no phase is named for it.
 *
 * Only criteria an opted-in spec states are read. An id from a spec that is
 * not on the board has no phase, so it cannot place the issue or contradict
 * a placement (the reading ADR-019 measured its 39 issues with).
 */
export function issuePlacement(
  issue: { readonly title: string; readonly body?: string | null; readonly milestone: string | null },
  families: readonly PlacingFamily[],
): IssueMove {
  const answers = families
    .map(f => ({ f, answer: criterionAnswer(issue, f.stated) }))
    .filter(a => a.answer.names.length > 0);
  if (answers.length === 0) return { kind: "none" };
  if (answers.some(a => a.answer.servesNone)) {
    return {
      kind: "left",
      why: `says it serves no criterion, so the ids it mentions (${answers.flatMap(a => a.answer.names).join(", ")}) do not place it`,
    };
  }
  if (answers.length > 1) {
    return {
      kind: "left",
      why:
        `names ${answers.map(a => `${a.f.prefix}'s ${a.answer.names.join(", ")}`).join(" and ")} — ` +
        "phase numbers do not compare across specs",
    };
  }
  const { f, answer } = answers[0]!;
  const unphased = answer.names.filter(id => !PHASE_VALUE.test(f.placements.get(id) ?? ""));
  if (unphased.length > 0) {
    return {
      kind: "left",
      why:
        `${unphased.map(id => `${id} is ${f.placements.has(id) ? `placed ${f.placements.get(id)}` : "placed nowhere"}`).join(", ")} ` +
        `in ${f.prefix}'s table, so the issue does not sit wholly in a phase`,
    };
  }
  const current = issue.milestone === null ? null : phaseInFamily(issue.milestone, f.prefix);
  if (issue.milestone !== null && current === null) {
    return { kind: "left", why: `is in "${issue.milestone}", which is not a ${f.prefix} phase — that is never moved` };
  }
  const phases = [...new Set(answer.names.map(id => Number(f.placements.get(id)!.match(PHASE_VALUE)![1])))].sort((a, b) => a - b);
  if (phases.length > 1 && issue.milestone !== null) {
    return {
      kind: "left",
      why: `names criteria in ${phases.map(p => `Phase ${p}`).join(" and ")} and already has a milestone — that is never moved`,
    };
  }
  const target = phases[0]!;
  if (current === target) return { kind: "stay", why: `already in "${issue.milestone}"` };
  const milestone = f.milestones.get(target);
  if (milestone === undefined) {
    return {
      kind: "refuse",
      why: `belongs in ${f.prefix} Phase ${target}, which has no milestone — run plan-spec first; this never creates one`,
    };
  }
  return {
    kind: "move",
    milestone,
    why:
      `${issue.milestone === null ? "no milestone" : `"${issue.milestone}"`} → "${milestone}" ` +
      `(${answer.names.join(", ")}${phases.length > 1 ? `; the lowest of ${phases.map(p => `Phase ${p}`).join(", ")}` : ""})`,
  };
}
