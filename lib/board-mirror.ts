/**
 * What a board COLUMN may say about an issue, and where that sentence is
 * allowed to come from.
 *
 * ## The field is a mirror. The issue body is the source.
 *
 * A Projects v2 custom field is invisible to `gh`: `gh issue list --json
 * projectItems` returns Status and nothing else, measured on #1592, which had
 * two custom fields set at the time. Agents read the tracker through `gh`, so
 * nothing an agent must ACT on can live in a project field — that is step 3 of
 * `docs/adr/ADR-003-spec-to-tracker-mapping.md` and it has not changed.
 *
 * What a field CAN do is be looked at. Jason asked to open the board and see,
 * per issue, the milestone it sits in and the criteria it serves, without
 * opening anything. The milestone is already a built-in field. The criteria
 * are in the issue body, and a board does not render bodies.
 *
 * So: this module derives the column from the body and never the other way
 * round. `mirrorText` is a pure function of the issue's own text. If the field
 * and the body ever disagree, the body is right and the field is stale, and
 * the repair is to re-run the command — never to edit the column.
 *
 * ## One decider, which already existed
 *
 * "Does this issue name this criterion" is answered by `oneScMentionPattern`
 * against the title and the body, which is exactly what
 * `scripts/criterion-inventory.ts` has always asked. This module calls it
 * rather than spelling the question again: two deciders that agree are
 * behaviourally one, and no test can tell which of them is dead
 * (`.claude/rules/checks-must-be-able-to-fail.md`). A duplicate of this very
 * matcher was built and removed earlier in #1647, so the trap is not
 * hypothetical here.
 */
import { readdirSync, readFileSync } from "fs";
import { join, relative, sep } from "path";
import { idBoundedPattern, oneScMentionPattern } from "./sc-ids";
import { parseCriteria } from "./spec-evidence";

/** One spec, and the criterion ids it states. */
export interface SpecCriteria {
  /** Repo-relative, with `/` separators, so a reading is comparable across machines. */
  readonly path: string;
  readonly ids: readonly string[];
  /**
   * The ids whose box is NOT ticked in this spec, from the same read as
   * `ids` (#2005). A pull request closing an issue that names one of these
   * leaves the criterion with one fewer open issue and no tick.
   */
  readonly unticked: readonly string[];
}

/** What `specCriteriaIn` found, including what it could not resolve. */
export interface SpecSweep {
  readonly reading: "MEASURED" | "UNMEASURED";
  readonly specs: readonly SpecCriteria[];
  /** The union, in (spec path, then spec) order. Deterministic across runs. */
  readonly ids: readonly string[];
  /** An id two specs both state — reported, never silently merged. */
  readonly collisions: readonly { readonly id: string; readonly specs: readonly string[] }[];
  readonly unmeasuredReasons: readonly string[];
}

/**
 * The one spec whose ids are illustrative rather than stated.
 *
 * `specs/SPEC-TEMPLATE.md` is the frame a new spec is copied from, and its
 * criteria read `- [ ] SC-1: [first criterion]`. Those ids are the lowest and
 * most collidable in the whole namespace, so including them credits any issue
 * mentioning `SC-1` to a criterion nobody ever wrote.
 *
 * It is named rather than detected. A heuristic — "skip drafts", "skip
 * `testable: false`" — would also drop `DA-COMPLIANCE-SPEC.md`, which states
 * real criteria, and blanking a real cell is the exact failure SC-2610 is
 * about. `test/board-mirror.test.ts` asserts the file still exists, so this
 * cannot rot into an exclusion pointing at nothing.
 */
export const NOT_A_SPEC = ["specs/SPEC-TEMPLATE.md"] as const;

/**
 * Every criterion id in `<root>/specs`, from every spec, including nested ones.
 *
 * **Why this is not a `--spec` argument.** The column answers "which criteria
 * does this issue serve", and an issue does not know which spec the person at
 * the keyboard happened to name. Filtering the id set to one spec means every
 * issue serving any of the other 25 specs' criteria renders as an EMPTY cell —
 * and a blank cell reads as *not yet filled in*, *the tool could not tell* and
 * *deliberately none* at once. 28 cells on the live board were blank for this
 * reason on 2026-10-29, which is the measurement behind SC-2610.
 *
 * A directory that exists and yields no criteria at all is UNMEASURED rather
 * than an empty set: a tree with no specs and a tree whose specs could not be
 * parsed produce the same empty list, and only one of them is a board in good
 * order (*Silent Default Substitution*, `.claude/rules/config-access.md`).
 */
/**
 * The criterion ids ONE spec states, de-duplicated.
 *
 * `parseCriteria` matches every `- [ ] ID:` line independently and does not
 * dedupe, so a spec stating an id twice yields it twice. Downstream that is
 * a cell reading `SC-10 SC-10`, or — once the ids are pooled across specs —
 * a criterion that looks ambiguous because it collided with itself.
 *
 * Exported and used by BOTH readers. The sweep was fixed first and the
 * `--spec` path was left parsing for itself, so the two paths of one script
 * disagreed about the very case the fix was written for: two deciders, and
 * no behavioural test of either one can see the other going wrong. Both
 * findings came from the AI review of #1679, one round apart.
 */
export function criterionIdsIn(specText: string): string[] {
  return [...new Set(parseCriteria(specText).map(c => c.id))];
}

/**
 * Directory entries whose real parent cannot be established.
 *
 * Its own function so a case can hand it an entry with no `parentPath` —
 * `readdirSync` cannot be asked to omit the field, so the refusal would
 * otherwise be unreachable from a test and would read exactly like a
 * refusal that works.
 */
export function unlocatableEntries<T extends { name: string; parentPath?: string }>(
  entries: readonly T[],
): T[] {
  return entries.filter(e => typeof e.parentPath !== "string" || e.parentPath === "");
}

/** The shape `specCriteriaIn` needs from a directory entry, and nothing more. */
export interface SpecDirEntry {
  name: string;
  parentPath?: string;
  isFile(): boolean;
}

/**
 * How the sweep lists `specs/`. A parameter, not a hardcoded call, because
 * `readdirSync` on a runtime that HAS `parentPath` can never produce an entry
 * without one — so with the call inlined the refusal below is unreachable from
 * any test, and an unreachable refusal is indistinguishable from a working one
 * (`.claude/rules/checks-must-be-able-to-fail.md`). Testing
 * `unlocatableEntries` alone does not close that: the predicate is not the
 * `SpecSweep` the refusal assembles, and a wrong field or a broken message in
 * that object would go unobserved. Found by the AI review of #1679.
 */
export type SpecDirReader = (dir: string) => readonly SpecDirEntry[];

export const readSpecDir: SpecDirReader = dir =>
  readdirSync(dir, { recursive: true, withFileTypes: true });

/**
 * THE one way out of `specCriteriaIn` without a reading.
 *
 * A refusal must carry nothing read. A populated `ids` beside
 * `reading: "UNMEASURED"` is the partial result the refusal exists to
 * prevent, handed back quietly for any caller that checks the array before
 * it checks the reading.
 *
 * It is a function rather than three careful `return`s because three
 * careful `return`s is what this function had, and the third one leaked.
 * Each of the first two was written, reviewed and fixed on its own; the one
 * nobody was looking at kept its partial `specs` and `ids` — and no
 * behavioural test of either fixed branch could see it, because they are
 * separate branches answering the same question (*two deciders that agree*,
 * at N=3, `.claude/rules/checks-must-be-able-to-fail.md`). So the property
 * is asserted across the SITES: `test/board-mirror.test.ts` requires the
 * `UNMEASURED` literal to appear exactly once in this file. A fourth branch
 * cannot leak, because a fourth branch cannot spell the reading itself.
 */
function unmeasuredSweep(reasons: string[]): SpecSweep {
  return { reading: "UNMEASURED", specs: [], ids: [], collisions: [], unmeasuredReasons: reasons };
}

export function specCriteriaIn(root: string, readDir: SpecDirReader = readSpecDir): SpecSweep {
  const dir = join(root, "specs");
  let files: string[];
  try {
    const entries = readDir(dir).filter(e => e.isFile() && e.name.endsWith(".md"));
    // `parentPath` is the ONLY field that can be trusted to name a nested
    // entry's real parent. There is no fallback: `Dirent.path` under a
    // recursive readdir historically resolved to the top-level directory
    // rather than the entry's parent — that bug is why `parentPath` exists —
    // so on a runtime old enough to lack `parentPath`, `path` carries the
    // wrong value rather than a usable one. `?? dir` and `?? e.path` are the
    // same guess wearing different names, and both FLATTEN a nested spec
    // silently. Both were written here and both were caught by the AI review
    // of #1679, one round apart.
    //
    // So: refuse. A sweep that cannot locate a file it can see is UNMEASURED,
    // not a sweep with fewer specs in it.
    const unlocatable = unlocatableEntries(entries);
    if (unlocatable.length > 0) {
      return unmeasuredSweep([
        `this runtime does not report Dirent.parentPath, so ${unlocatable.length} spec file(s) ` +
          `under ${dir} cannot be located — a nested spec would be read as a top-level one. ` +
          `Nothing was read: ${unlocatable.map(e => e.name).sort().join(", ")}`,
      ]);
    }
    // `as string` rather than a second `typeof e.parentPath === "string"`:
    // the refusal above already decided that question for every entry here,
    // and a second decider answering it again is one no behavioural test can
    // tell apart from the first.
    files = entries
      .map(e => relative(root, join(e.parentPath as string, e.name)).split(sep).join("/"))
      .filter(p => !(NOT_A_SPEC as readonly string[]).includes(p))
      .sort();
  } catch (e) {
    return unmeasuredSweep([`could not read ${dir}: ${(e as Error).message}`]);
  }

  const specs: SpecCriteria[] = [];
  const reasons: string[] = [];
  const seen = new Map<string, string[]>();
  for (const path of files) {
    let ids: string[];
    let unticked: string[];
    try {
      // De-duplicated WITHIN the spec. `parseCriteria` matches every
      // `- [ ] ID:` line independently and does not dedupe, so one spec
      // stating an id twice — a pasted-twice criterion — would push its own
      // path onto `seen` twice and read downstream as a cross-spec
      // collision: the id dropped as ambiguous, and a note saying it is
      // "stated by specs/A.md and specs/A.md". An unambiguous criterion
      // misreported as ambiguous, with a nonsensical reason. Found by the
      // AI review of #1679; zero specs state a duplicate today, so nothing
      // observable changes and the guard is for the case that arrives.
      const text = readFileSync(join(root, path), "utf-8");
      ids = criterionIdsIn(text);
      unticked = [...new Set(parseCriteria(text).filter(c => !c.ticked).map(c => c.id))];
    } catch (e) {
      // One unreadable spec does not make a SHORTER id list — it makes the
      // whole sweep unmeasured, because a shorter list is exactly what a
      // repository with fewer criteria produces.
      reasons.push(`could not read ${path}: ${(e as Error).message}`);
      continue;
    }
    specs.push({ path, ids, unticked });
    for (const id of ids) seen.set(id, [...(seen.get(id) ?? []), path]);
  }

  // An id two specs both state is AMBIGUOUS, and the column has one cell per
  // issue with no room to say which spec was meant. #312 mentions `SC-A1`
  // meaning another repository's criterion; three specs here state `SC-A1`,
  // so writing it attributes the issue to a criterion at random. Dropped from
  // the id set and reported — the issue keeps whatever unambiguous ids it
  // also names, so this narrows a cell rather than blanking it.
  const ids = [...seen.keys()].filter(id => (seen.get(id) as string[]).length === 1);
  const collisions = [...seen.entries()]
    .filter(([, where]) => where.length > 1)
    .map(([id, where]) => ({ id, specs: where }));

  // Two different ways to end up with no usable id, and they need different
  // sentences. The caller refuses on UNMEASURED before it prints the
  // collision notes, so if the empty set came from ambiguity the reason line
  // is the ONLY place that can say so — and "no spec states a criterion" is
  // then actively false. Raised by the AI review of #1679.
  if (reasons.length === 0 && ids.length === 0) {
    reasons.push(
      seen.size === 0
        ? `no spec under ${dir} states a criterion, so no cell could be filled`
        : `every criterion under ${dir} is stated by more than one spec, so none can be ` +
          `attributed to a single one: ${collisions.map(c => `${c.id} (${c.specs.join(", ")})`).join("; ")}`,
    );
  }
  // The third branch, and the one that leaked. A spec `readdirSync` listed
  // and `readFileSync` could not open — a permission bit, a race with a
  // delete — pushed a reason and carried on, so the sweep returned
  // UNMEASURED with the OTHER specs' ids still in it. The caller refuses on
  // the reading before it touches the array, so nothing was wrong today;
  // what was wrong is that the exported contract contradicted itself and the
  // next caller to read `ids` first would get a short list that looks whole.
  // Raised by the AI review of #1679, one round after the two branches above
  // were each fixed on their own.
  if (reasons.length > 0) return unmeasuredSweep(reasons);
  return { reading: "MEASURED", specs, ids, collisions, unmeasuredReasons: [] };
}

/** What the board is told about one issue. */
export interface MirrorRow {
  readonly number: number;
  /** Criterion ids the issue's own text names, in spec order. */
  readonly criteria: readonly string[];
  /** Exactly what goes in the text field. */
  readonly text: string;
}

/**
 * The text used when an issue names no criterion at all — SC-2609.
 *
 * **This was `""` until #1716, and the reason it changed is worth keeping.**
 * The original case read *"A cell reading 'none' sorts and filters as a
 * value. Empty is absence."* Both halves are true and the conclusion is
 * backwards: sorting and filtering as a value is the point, and *absence* is
 * precisely the state a reader cannot act on. A blank cell says **not yet
 * filled in**, **the tool could not tell** and **deliberately none** with the
 * same zero bytes, so the one reading that means the board is in good order
 * is indistinguishable from the two that mean it is not. 28 cells on the live
 * board were blank on 2026-10-29 and nothing could say which kind they were.
 *
 * So the value is spelled, and a cell this module has never written stays
 * `""`. That difference is the whole of SC-2609: `NAMES_NONE !== ""` is what
 * lets a reader tell a judgement from a gap.
 *
 * It must not be mistakable for a criterion id — no `SC-`, no `CRC-`, nothing
 * a reader scanning the column would try to look up.
 */
export const NAMES_NONE = "serves no criterion";

/**
 * Every id, never a summary.
 *
 * The first version of this capped the cell at six ids and appended
 * `+N more`, on the stated grounds that a board cell is narrow and that the
 * widest issue in this repository names six, so the overflow branch would be
 * reached by nothing. **The first run falsified both halves in one line:**
 * #1437 names nine, and the cell it produced was
 * `CRC-E1 CRC-E2 CRC-E3 CRC-E4 CRC-E5 CRC-E6 +3 more`.
 *
 * Which is the worse of the two failures. The column exists so Jason can see
 * which criteria an issue serves without opening it; a cell that silently
 * drops three of them answers the question wrongly rather than partially, and
 * it does so on exactly the issue with the most to say. A visually clipped
 * cell is still the whole value — the table widens, the tooltip shows it, and
 * the JSON carries it. So there is no cap, and the bound that was never
 * measured is gone rather than raised.
 */
/**
 * The spec paths, in the shape `placementCoverage` takes its enumerator in.
 *
 * Lives here because {@link specCriteriaIn} does: *which files are specs* is
 * one question with one answer, and a caller writing its own ten-line adapter
 * is a second site that a mutation of the first would leave standing
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape). It was a
 * private function in `scripts/plan-spec.ts` until `scripts/board-snapshot.ts`
 * needed the same sweep for SC-2615; both call this now rather than two
 * copies agreeing.
 *
 * An UNMEASURED sweep propagates — an empty path list from a sweep that
 * failed is indistinguishable from a tree with no specs, and only one of
 * those is a reading.
 */
export function specPathSweep(
  root: string,
  readDir: SpecDirReader = readSpecDir,
): { reading: "MEASURED" | "UNMEASURED"; unmeasuredReasons: string[]; paths: string[] } {
  const sweep = specCriteriaIn(root, readDir);
  return {
    reading: sweep.reading,
    unmeasuredReasons: [...sweep.unmeasuredReasons],
    paths: sweep.specs.map(s => s.path),
  };
}

export function mirrorText(criteria: readonly string[]): string {
  if (criteria.length === 0) return NAMES_NONE;
  return criteria.join(" ");
}

/**
 * An issue STATING a criterion of its own, rather than naming one it serves.
 *
 * `- [ ] SC-1 — A test fails when a hook name exists in both trees` is #713
 * writing its own acceptance criteria in the shape a spec uses. It is not a
 * reference to `specs/bootstrap-data-flow/success-criteria.md`'s `SC-1`, and
 * the two are indistinguishable to a bare mention test. Measured 2026-10-30:
 * reading every spec made #713's cell read `SC-1 SC-2 SC-3 SC-4 SC-5 SC-6`,
 * six criteria it has nothing to do with.
 *
 * A wrong cell is worse than the blank one SC-2609 is about. A blank says
 * "nothing known"; a populated cell is read as a fact.
 *
 * The checkbox is the whole signal, and it is the right one: ADR-003 step 3
 * says an issue names what it serves under a CRITERIA heading as plain text.
 * Nothing in this repository's issue template writes a served criterion as a
 * task checkbox.
 */
export function declaresOwnCriterion(text: string, id: string): boolean {
  return idBoundedPattern("^[ \\t]*[-*][ \\t]*\\[[ xX]\\][ \\t]*", id, "m").test(text);
}

/**
 * Which of `criterionIds` this issue's text names.
 *
 * Order follows `criterionIds`, so the column reads in spec order rather than
 * in whatever order the issue's prose happened to mention them. Two issues
 * serving the same pair then render identically, which is what makes the
 * column scannable down a group.
 */
export function criteriaNamedBy(
  issue: { readonly title: string; readonly body?: string | null },
  criterionIds: readonly string[],
): string[] {
  const text = `${issue.title}\n${issue.body ?? ""}`;
  return criterionIds.filter(
    id => oneScMentionPattern(id).test(text) && !declaresOwnCriterion(text, id),
  );
}

/**
 * The label an open issue carries while it has not answered the criterion
 * question (#2020). Applied and removed by `scripts/criterion-label.ts`,
 * by {@link criterionAnswer} and nothing else.
 */
export const NEEDS_CRITERION_LABEL = "needs-criterion";

/**
 * What an issue says it serves: the criteria it names, whether it declares
 * it serves none, and whether either is true — #2020.
 *
 * **The one decider for "has this issue answered the criterion question".**
 * `criteria-named` (E2, `scripts/board-snapshot.ts`) counts it and the
 * `needs-criterion` label is applied and removed by it, so the label and the
 * reading cannot disagree. Two copies would be two deciders, and a mutation
 * of either would leave the other holding the case up.
 *
 * The declaration is the literal {@link NAMES_NONE}, case and all — the one
 * way this repository spells it (SC-2609). Matching anything looser would
 * let an issue opt out by accident, and *has not said* versus *says none*
 * is the whole of SC-2616.
 */
/**
 * Every id an issue can answer the criterion question with: the sweep's
 * union PLUS the ids two specs both state (#2020, review round 1). A
 * collision is reported, never merged, for the column — but an issue naming
 * one still serves a criterion, which is why `finding-promotion` already read
 * it this way. One function, so the label, `criteria-named` and the decline
 * refusal all read the same population.
 */
export function answerableIds(sweep: SpecSweep): string[] {
  return [...sweep.ids, ...sweep.collisions.map(c => c.id)];
}

export function criterionAnswer(
  issue: { readonly title: string; readonly body?: string | null },
  criterionIds: readonly string[],
): { names: string[]; servesNone: boolean; answered: boolean } {
  const names = criteriaNamedBy(issue, criterionIds);
  const servesNone = `${issue.title}\n${issue.body ?? ""}`.includes(NAMES_NONE);
  return { names, servesNone, answered: names.length > 0 || servesNone };
}

export function mirrorRows(
  issues: readonly { readonly number: number; readonly title: string; readonly body?: string | null }[],
  criterionIds: readonly string[],
): MirrorRow[] {
  return issues.map(i => {
    const criteria = criteriaNamedBy(i, criterionIds);
    return { number: i.number, criteria, text: mirrorText(criteria) };
  });
}

/**
 * An item is READY when nothing open is blocking it.
 *
 * **This cannot be a saved view filter, and the reason is measured.**
 * GitHub's `no:blocked-by` and `has:blocked-by` match on whether a dependency
 * LINK exists, not on whether the blocker is still open. Taken 2026-10-28
 * against `LucasDesenvGit/financas-local`, the only public repository with
 * dependency edges I could find to use as a positive control: its issues #78,
 * #92, #191 and #210 are open with `issueDependenciesSummary { blockedBy: 0,
 * totalBlockedBy: 1 }` — one dependency, already closed — and all four match
 * `has:blocked-by` while none matches `no:blocked-by`.
 *
 * So a Ready lane defined as `is:open no:blocked-by` would drop an issue the
 * moment anything was ever linked to it and never give it back, including
 * after the blocker shipped. The open count has to be read and the lane
 * written. `blockedBy` is the OPEN count and `totalBlockedBy` the lifetime
 * one; they are separate fields and only the first one answers this.
 *
 * `issueDependenciesSummary` is GraphQL-only — `gh issue view --json` exposes
 * `blockedBy` and `blocking` but not the summary.
 */
export function isUnblocked(summary: { readonly blockedBy: number }, assignees: number): boolean {
  return summary.blockedBy === 0 && assignees === 0;
}

/** The phase number in a milestone title, or null for a milestone that is not a phase. */
export function phaseOf(milestoneTitle: string | null | undefined): number | null {
  const m = /\bPhase (\d+)\b/.exec(milestoneTitle ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * The lowest phase number that still has open work, or null if none does.
 *
 * This is the whole ordering, and it is derived rather than declared: the
 * spec's *Phase placement* table decides which phase a criterion is in,
 * `rungate plan-spec` turns the phases into milestones, and a milestone is
 * single-valued so an issue sits in exactly one. Nothing here is a number
 * anybody types.
 */
export function openFrontier(
  items: readonly { readonly state: string; readonly phase: number | null }[],
): number | null {
  const open = items.filter(i => i.state === "OPEN" && i.phase !== null).map(i => i.phase as number);
  return open.length === 0 ? null : Math.min(...open);
}

/**
 * READY means *pick this up next*: open, nothing blocking it, nobody on it.
 *
 * ## The phase gate used to be here, and the cap replaced it
 *
 * The first run of this made 36 of 46 open issues Ready, because the
 * repository has almost no dependency edges and an issue with no blockers
 * is trivially unblocked. A lane holding 36 items is the backlog with a
 * different name, and it answers *what can I pick up* with "anything",
 * which is the same as not answering.
 *
 * The fix at the time was to require the earliest phase with open work.
 * That made the lane small by making it **narrow**, and the two are not
 * the same thing: an unblocked, unclaimed issue in a later phase could not
 * enter Ready even when the lane sat under its depth and the earlier phase
 * had nothing available. The lane refused to answer the question it exists
 * for, and called that an ordering.
 *
 * Size is now `readyCap` in `lib/board-ready-rule.ts`, derived from
 * measured throughput, and phase is `readyOrder` in the same file. The
 * lane is small because it is capped and phase-ordered — so the gate was
 * doing a job two other mechanisms already do, and taking it off is
 * Jason's call of 2026-11-05 on #1758.
 *
 * **An issue with no phase milestone is now eligible.** This docblock used
 * to say "never Ready", on the grounds that a reviewer finding serving no
 * criterion would make the lane lie. It sorts last instead — `readyOrder`
 * ranks a null phase behind every numbered one — which keeps the ordering
 * claim true without refusing work that is genuinely pickable.
 */
export function isReady(item: {
  readonly state: string;
  readonly blockedByOpen: number;
  readonly assignees: number;
}): boolean {
  if (item.state !== "OPEN") return false;
  return isUnblocked({ blockedBy: item.blockedByOpen }, item.assignees);
}

