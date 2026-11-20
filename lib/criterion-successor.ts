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
 *
 * `sweepSuccessors` (#2541) asks the same question of every owed criterion
 * rather than one close's, for the closes whose event the workflow missed. It
 * cites the most recent closed issue that named each one, and groups by that
 * issue so each group is a `planSuccessors` call: one planner, so the two
 * modes cannot disagree about what a successor is or where it goes.
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

/**
 * A title a person can scan: the id, then the criterion's own words, cut at a
 * word. A title is plain text, so the spec's bold markers go (#2544 printed
 * them); code spans stay, because a backticked name reads as a name either way.
 */
export function successorTitle(id: string, text: string): string {
  const MAX = 100;
  // Odd pieces of the split are code spans (a run of backticks, its body, the
  // same run again) and pass through untouched: `__init__` is a name, not
  // emphasis (review of #2545). Only the prose between them loses its markers.
  const flat = text
    .split(/(`+[^`]*?`+)/)
    .map((piece, i) =>
      i % 2 === 1 ? piece : piece.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_m, a: string | undefined, b: string | undefined) => a ?? b ?? ""),
    )
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= MAX) return `${id}: ${flat}`;
  const cut = flat.slice(0, MAX);
  const at = cut.lastIndexOf(" ");
  return `${id}: ${(at > 40 ? cut.slice(0, at) : cut).replace(/[,;:]$/, "")}…`;
}

/** Which run filed the successor: on the close's own event, or a later sweep (#2541). */
export type SuccessorMode = "close" | "sweep";

export function successorBody(id: string, source: string, text: string, closed: number, mode: SuccessorMode = "close"): string {
  const how =
    mode === "sweep"
      ? `Filed by \`rungate criterion-successor --sweep\`. #${closed} was the last issue to name ${id}, and it is closed.`
      : `Filed by \`rungate criterion-successor\` when #${closed} closed.`;
  return [
    `${how} ${id} is still unticked in \`${source}\`, and no open issue names it any more, so \`declared-work\` would read it as owed by nobody. This issue succeeds #${closed} as ${id}'s open issue.`,
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
  mode: SuccessorMode = "close",
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
      body: successorBody(id, o.source, criterion.text, closed.number, mode),
      milestone: { number: milestone.number, title: milestone.title },
    });
  }
  if (refusals.length > 0) return { why: refusals.join("; ") };
  return { file, leave };
}

/**
 * Every owed criterion's successor, for a run with no single close to ask
 * about (#2541). `lastNamer` maps an owed id to the most recent issue that
 * named it and was closed as completed, read by the caller. An owed id with
 * no entry has nothing to succeed, and declared-work already reports it as a
 * gap, so it is left rather than filed. One refusal refuses
 * the whole sweep, the per-issue path's rule.
 */
export function sweepSuccessors(
  owed: readonly OwedCriterion[],
  lastNamer: ReadonlyMap<string, number>,
  specText: (path: string) => string | null,
  milestones: readonly SuccessorMilestone[],
): SuccessorPlan {
  const byIssue = new Map<number, string[]>();
  const leave: { id: string; why: string }[] = [];
  for (const id of [...new Set(owed.map(o => o.id))]) {
    const n = lastNamer.get(id);
    if (n === undefined) {
      leave.push({
        id,
        why: "no issue closed as completed names it (one closed as not planned or a duplicate may), so there is nothing to succeed; declared-work reports it as a gap",
      });
      continue;
    }
    byIssue.set(n, [...(byIssue.get(n) ?? []), id]);
  }
  const file: Successor[] = [];
  const refusals: string[] = [];
  for (const [number, names] of byIssue) {
    const plan = planSuccessors({ number, names }, owed, specText, milestones, "sweep");
    if ("why" in plan) {
      refusals.push(plan.why);
      continue;
    }
    file.push(...plan.file);
    leave.push(...plan.leave);
  }
  if (refusals.length > 0) return { why: refusals.join("; ") };
  // Spec order, not the order the closed issues happened to group them in.
  const order = new Map(owed.map((o, i) => [o.id, i] as const));
  file.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return { file, leave };
}
