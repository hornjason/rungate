/**
 * The verdict a consumer's issue gets — SC-2782, ADR-020 Decision 1.
 *
 * THE one decider. `rungate consumer-triage` reads each open `from-consumer`
 * issue that carries no verdict marker and asks {@link triageVerdict}; the
 * CLI writes what it answered and decides nothing itself. The first verdict
 * that fits wins, in the ADR's order:
 *
 * 1. **DUPLICATE #N** — the FindingArbiter's duplicate test
 *    (`duplicateCollisions`) matches an OLDER open issue. Older only, so two
 *    consumer reports of one problem cannot each be called the other's
 *    duplicate and both end up unplaced. A comment names #N; closing it stays
 *    a person's act.
 * 2. **PLACED** — `issuePlacement`, the SC-2779 decider, names a phase. Never a
 *    second placement rule here.
 * 3. **OVERLAPS #N** — its declared files meet an open issue's declared files
 *    or an open pull request's changed files (`lib/issue-file-overlap.ts`), or
 *    it names a criterion that issue names. It joins #N's milestone. Open work
 *    with no milestone is skipped: there is nothing to join, and joining
 *    "nothing" would leave the issue exactly where Ready never looks. No
 *    blocked-by link is written; a shared file is a conflict, not an order.
 * 4. **ACTIVE** — none of the above. It joins `activeMilestone`'s answer, the
 *    SC-2741 decider Ready itself refills from.
 *
 * Two outcomes are not verdicts and leave no marker, so a later run asks again:
 *
 * - **LEFT** — the issue already has a milestone that the placement decider
 *   did not name. A person put it there, and nothing here moves a milestone a
 *   person set, the rule `issuePlacement` keeps too. `consumer-intake` (SC-2783)
 *   counts a milestone as an answer, so the issue is not lost.
 * - **REFUSED** — the decider could not give a verdict without guessing: the
 *   phase it belongs in has no milestone, or no open issue sits in any phase.
 */
import { activeMilestone } from "./board-ready-rule";
import { criterionAnswer } from "./board-mirror";
import { duplicateCollisions, type Finding } from "./finding-arbiter";
import { declaredFiles, sharedFiles } from "./issue-file-overlap";
import { issuePlacement, type PlacingFamily } from "./issue-repair";

/** The label a consumer's report carries — the one the reporting rule tells consumers to set. */
export const CONSUMER_LABEL = "from-consumer";

export const VERDICT_KINDS = ["DUPLICATE", "PLACED", "OVERLAPS", "ACTIVE"] as const;
export type VerdictKind = (typeof VERDICT_KINDS)[number];

/** An open issue, as little of one as the decider reads. */
export interface TriageIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly milestone: string | null;
}

/** An open pull request: its changed files are what it shares. */
export interface OpenPull extends TriageIssue {
  readonly files: readonly string[];
}

export type Verdict =
  | { kind: "DUPLICATE"; of: number; keys: string[]; why: string }
  | { kind: "PLACED"; milestone: string; why: string }
  | { kind: "OVERLAPS"; of: number; ofKind: "issue" | "pull request"; milestone: string; shared: string[]; why: string }
  | { kind: "ACTIVE"; milestone: string; why: string };

export type Triage = Verdict | { kind: "LEFT"; why: string } | { kind: "REFUSED"; why: string };

export interface TriageContext {
  /** Every open issue, the one being triaged included or not. */
  readonly openIssues: readonly TriageIssue[];
  readonly openPulls: readonly OpenPull[];
  /** Every opted-in family, as `placingFamilies` read them. */
  readonly families: readonly PlacingFamily[];
  /** `board.milestonePrefix`, the engine family Ready draws from first. */
  readonly enginePrefix: string | null;
}

const asFinding = (i: TriageIssue): Finding => ({ id: String(i.number), title: i.title, body: i.body ?? "" });

export function triageVerdict(issue: TriageIssue, ctx: TriageContext): Triage {
  // 1. DUPLICATE — of an older open issue only.
  const older = ctx.openIssues.filter(o => o.number < issue.number).map(asFinding);
  const dup = duplicateCollisions(asFinding(issue), older)[0];
  if (dup !== undefined) {
    return {
      kind: "DUPLICATE",
      of: Number(dup.id),
      keys: dup.keys,
      why: `the FindingArbiter's duplicate test matches #${dup.id} on ${dup.keys.length} shared key(s): ${dup.keys.slice(0, 6).join(", ")}`,
    };
  }

  // 2. PLACED — the SC-2779 decider, never a second one.
  const move = issuePlacement(issue, ctx.families);
  if (move.kind === "move") return { kind: "PLACED", milestone: move.milestone, why: move.why };
  if (move.kind === "stay" && issue.milestone !== null) return { kind: "PLACED", milestone: issue.milestone, why: move.why };
  if (move.kind === "refuse") return { kind: "REFUSED", why: move.why };

  if (issue.milestone !== null) {
    // An unmarked issue already sitting where triage would put it is a run that
    // set the milestone and stopped before the marker (review of #2356): finish
    // it. Any other milestone was set by a person and is never moved.
    const again = unplacedVerdict({ ...issue, milestone: null }, ctx);
    if (again.kind !== "REFUSED" && again.milestone === issue.milestone) {
      return { ...again, why: `${again.why}; it already sits there, so this finishes a run that stopped before the marker` };
    }
    return { kind: "LEFT", why: `already in "${issue.milestone}", which a person set; a milestone a person set is never moved` };
  }
  return unplacedVerdict(issue, ctx);
}

/** Steps 3 and 4, for an issue no phase places: OVERLAPS, else ACTIVE. */
function unplacedVerdict(issue: TriageIssue, ctx: TriageContext): Extract<Triage, { kind: "OVERLAPS" | "ACTIVE" | "REFUSED" }> {
  // 3. OVERLAPS — shared declared/changed files, or a shared named criterion.
  const stated = [...new Set(ctx.families.flatMap(f => f.stated))];
  const mineFiles = declaredFiles(issue.body ?? "");
  const mineCriteria = criterionAnswer(issue, stated).names;
  const others: { item: TriageIssue; kind: "issue" | "pull request"; files: readonly string[] }[] = [
    ...ctx.openIssues.filter(o => o.number !== issue.number).map(o => ({ item: o, kind: "issue" as const, files: declaredFiles(o.body ?? "") })),
    ...ctx.openPulls.map(p => ({ item: p as TriageIssue, kind: "pull request" as const, files: p.files })),
  ].sort((a, b) => a.item.number - b.item.number);
  for (const o of others) {
    if (o.item.milestone === null) continue;
    const files = mineFiles.length === 0 ? [] : sharedFiles(mineFiles, o.files);
    const theirCriteria = new Set(criterionAnswer(o.item, stated).names);
    const criteria = mineCriteria.filter(id => theirCriteria.has(id));
    if (files.length === 0 && criteria.length === 0) continue;
    return {
      kind: "OVERLAPS",
      of: o.item.number,
      ofKind: o.kind,
      milestone: o.item.milestone,
      shared: [...files, ...criteria],
      why: `shares ${[...files, ...criteria].join(", ")} with open ${o.kind} #${o.item.number}, so it joins "${o.item.milestone}"`,
    };
  }

  // 4. ACTIVE — the focus Ready refills from.
  const active = activeMilestone(ctx.openIssues, ctx.enginePrefix);
  if (active.title === null) return { kind: "REFUSED", why: `nowhere to place it: ${active.why}` };
  return { kind: "ACTIVE", milestone: active.title, why: active.why };
}

/** The marker's fixed opening. `consumer-intake` (SC-2783) reads it through {@link verdictIn}. */
const MARKER_OPEN = "<!-- rungate:consumer-triage:v1";
const MARKER = new RegExp(`${MARKER_OPEN} (${VERDICT_KINDS.join("|")}) -->`);

export function verdictMarker(kind: VerdictKind): string {
  return `${MARKER_OPEN} ${kind} -->`;
}

/** One issue comment, with who wrote it. */
export interface IssueComment {
  readonly body: string;
  readonly author: string;
  /** GitHub's `author_association`: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, … */
  readonly association: string;
}

/** The associations whose marker counts. A reporter cannot mark their own issue triaged. */
export const TRUSTED_ASSOCIATIONS: readonly string[] = ["OWNER", "MEMBER", "COLLABORATOR"];

/** The account a generated workflow's `GITHUB_TOKEN` posts as (SC-2784). */
export const WORKFLOW_BOT = "github-actions[bot]";

/**
 * The comment bodies whose marker counts: written by someone with push access,
 * or by the workflow that runs the triage. Anyone can comment on a public
 * issue, so a marker from anyone else would let a reporter skip triage, and
 * `consumer-intake` (SC-2783) would then read the issue as answered.
 */
export function trustedBodies(comments: readonly IssueComment[]): string[] {
  return comments.filter(c => TRUSTED_ASSOCIATIONS.includes(c.association) || c.author === WORKFLOW_BOT).map(c => c.body);
}

/** The verdict a set of comments records, or null when none carries a marker. Pass {@link trustedBodies}. */
export function verdictIn(comments: readonly string[]): VerdictKind | null {
  for (const c of comments) {
    const m = MARKER.exec(c);
    if (m) return m[1] as VerdictKind;
  }
  return null;
}

/** The comment that records a verdict: the marker on the first line, then the reason. */
export function verdictComment(v: Verdict): string {
  const head =
    v.kind === "DUPLICATE"
      ? `**Triage: DUPLICATE of #${v.of}.** Closing it is a person's call; nothing here closes it.`
      : v.kind === "OVERLAPS"
        ? `**Triage: OVERLAPS #${v.of}**, so it joins "${v.milestone}".`
        : `**Triage: ${v.kind}** in "${v.milestone}".`;
  return `${verdictMarker(v.kind)}\n${head}\n\nWhy: ${v.why}.\n\nWritten by \`rungate consumer-triage\` (ADR-020).`;
}
