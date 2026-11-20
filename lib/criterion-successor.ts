/**
 * Which criteria a closed issue leaves owed by nobody, and the successor issue
 * each one gets — #2490, serving SC-2625.
 *
 * When a criterion's last open issue closes and the criterion is still
 * unticked, `declared-work` reads it as naming no open issue. Until #2490
 * every successor was filed and milestoned by hand (#2437, #2463), and each
 * hand milestone is an edit SC-2625's reading counts. This decides what to
 * file; `scripts/criterion-successor.ts` reads and writes.
 *
 * Owed means what `declaredWorkUnaccounted` in `scripts/board-conformance.ts`
 * returns: an unticked criterion of an opted-in spec, placed in a phase, that
 * no open issue names. The caller passes that list in, so the board and this
 * command cannot disagree about what is uncovered. This file narrows it to
 * what the closed issue named, because only those were left uncovered by this
 * close; an owed criterion nobody named is a gap the board already reports,
 * and not this run's to file.
 *
 * A successor is placed in its criterion's phase milestone: the spec's own
 * `board.prefix` and its Phase placement row, matched against the live
 * milestones by `phaseInFamily`, the anchored parse every reader of a family
 * uses. An owed criterion whose spec cannot be read, whose placement is not a
 * phase, or whose phase has no milestone refuses the WHOLE plan, by name.
 * Filing it unplaced would trade one hand edit for another, and filing the
 * others alone would read like a complete run.
 */
import { parseCriteria } from "./spec-evidence";
import { boardDeclaration, PHASE_VALUE, phaseInFamily, placementsById } from "./spec-placement";

export interface ClosedIssue {
  number: number;
  /** The criteria it names, by `criterionAnswer` — the one decider of what an issue names. */
  names: readonly string[];
}

/** An owed criterion, as `declaredWorkUnaccounted` reports it. */
export interface OwedCriterion {
  id: string;
  /** The spec's repo-relative path. */
  source: string;
}

export interface SuccessorMilestone {
  number: number;
  title: string;
}

export interface Successor {
  id: string;
  source: string;
  title: string;
  body: string;
  milestone: SuccessorMilestone;
}

export type SuccessorPlan = { file: Successor[]; leave: { id: string; why: string }[] } | { why: string };

/** A title a person can scan: the id, then the criterion's own words, cut at a word. */
export function successorTitle(id: string, text: string): string {
  const MAX = 100;
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX) return `${id}: ${flat}`;
  const cut = flat.slice(0, MAX);
  const at = cut.lastIndexOf(" ");
  return `${id}: ${(at > 40 ? cut.slice(0, at) : cut).replace(/[,;:]$/, "")}…`;
}

export function successorBody(id: string, source: string, text: string, closed: number): string {
  return [
    `Filed by \`rungate criterion-successor\` when #${closed} closed. ${id} is still unticked in \`${source}\`, and no open issue names it any more, so \`declared-work\` would read it as owed by nobody. This issue succeeds #${closed} as ${id}'s open issue.`,
    "",
    "## What must become true",
    "",
    `> ${text.replace(/\s+/g, " ").trim()}`,
    "",
    "## Files this will change",
    "",
    `Not named yet. Read #${closed} and what merged for it, then name the files before starting (AGENTS.md rule 2), and split this issue if it is more than one change.`,
    "",
    "## How we will know",
    "",
    `A test names ${id} in a declaring position, and \`sync-sc-status\` ticks it from that claim.`,
    "",
    "## Criteria this serves",
    "",
    id,
    "",
  ].join("\n");
}

export function planSuccessors(
  closed: ClosedIssue,
  owed: readonly OwedCriterion[],
  specText: (path: string) => string | null,
  milestones: readonly SuccessorMilestone[],
): SuccessorPlan {
  // Every spec that owes an id, never only the last: an id two specs both
  // state is a collision the spec sweep reports and never merges, and which
  // phase its successor belongs in cannot be decided (review of #2534).
  const owedById = new Map<string, OwedCriterion[]>();
  for (const o of owed) owedById.set(o.id, [...(owedById.get(o.id) ?? []), o]);
  const file: Successor[] = [];
  const leave: { id: string; why: string }[] = [];
  const refusals: string[] = [];
  for (const id of closed.names) {
    const owners = owedById.get(id) ?? [];
    if (owners.length > 1) {
      refusals.push(`${id}: ${owners.map(o => o.source).join(" and ")} both state it, so which phase its successor belongs in cannot be decided`);
      continue;
    }
    const o = owners[0];
    if (o === undefined) {
      leave.push({ id, why: "declared-work does not read it as owed: it is ticked, another open issue names it, or no opted-in spec places it in a phase" });
      continue;
    }
    const content = specText(o.source);
    if (content === null) {
      refusals.push(`${id}: ${o.source} could not be read`);
      continue;
    }
    const criterion = parseCriteria(content).find(c => c.id === id);
    const placement = placementsById(content).get(id);
    const phase = placement?.match(PHASE_VALUE)?.[1];
    const prefix = boardDeclaration(content).settings.prefix;
    if (criterion === undefined || phase === undefined || prefix === undefined) {
      refusals.push(
        `${id}: ${o.source} ${criterion === undefined ? "does not state it" : phase === undefined ? `places it at ${JSON.stringify(placement ?? "nowhere")}, not a phase` : "declares no board.prefix"}`,
      );
      continue;
    }
    // Every match, never the first (#2535): two open milestones that read as
    // one phase make the placement a guess, the shape a doubled placement or
    // a doubled owner already refuses on.
    const matches = milestones.filter(m => phaseInFamily(m.title, prefix) === Number(phase));
    if (matches.length > 1) {
      refusals.push(`${id}: ${matches.length} open milestones read as phase ${phase} of the ${prefix} family (${matches.map(m => JSON.stringify(m.title)).join(", ")}), so which one it belongs in cannot be decided`);
      continue;
    }
    const milestone = matches[0];
    if (milestone === undefined) {
      refusals.push(`${id}: no open milestone is phase ${phase} of the ${prefix} family, so it has nowhere to be placed (rungate plan-spec makes the family's milestones)`);
      continue;
    }
    file.push({
      id,
      source: o.source,
      title: successorTitle(id, criterion.text),
      body: successorBody(id, o.source, criterion.text, closed.number),
      milestone: { number: milestone.number, title: milestone.title },
    });
  }
  if (refusals.length > 0) return { why: refusals.join("; ") };
  return { file, leave };
}
