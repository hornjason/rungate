/**
 * The dependencies planning declared, as `blocked by` edges — SC-2606.
 *
 * `AGENTS.md` rule 4: *"Ordering is data, not prose. Use GitHub's `blocked
 * by`."* Until ADR-021 this file turned the PHASE order into edges: every
 * issue in phase N blocked by every issue in phase N-1 (`chainAdjacentPhases`,
 * 182 links on Convergence alone). That made phase a gate — 31 of 37 open
 * Convergence issues were held back by nothing anyone wrote — and ADR-021
 * decision 1 (Jason, 2026-11-18) made phase an ORDER instead: Ready sorts by
 * it, and nothing waits on it.
 *
 * ## Where a dependency comes from now
 *
 * ADR-021 decision 6, in Jason's words: *"Wasn't true ordering come from that
 * step. Dependencies"*. A dependency is declared when the work is planned, in
 * an accepted ADR's Decomposition table — a row's `Blocked by` cell (another
 * row's outcome, or `#<n>`) and its `Blocks` cell (`#<n>`). `plan-issues`
 * writes those links when it files the rows; {@link declaredDependencies}
 * re-derives them from every accepted plan so `plan-deps` can add any that
 * went missing, and `board-snapshot`'s `dependency-edges` can read whether
 * the tracker carries them. It never writes phase order.
 *
 * A dependency between two issues that already exist, which no ADR row can
 * express, is written by hand on the tracker. This file never removes it.
 *
 * ## It never removes an edge
 *
 * An edge this file did not derive is reported as {@link DependencyPlan.extra}
 * and left alone. Two live instances on 2026-10-29 are real and neither is
 * derivable here: #1481 blocked by #1591 (the ballot cannot subtract until the
 * jury runs) and #1659 blocked by #1658 (nothing to rescore until the case set
 * exists) — both WITHIN a phase, which is exactly the dependency a phase order
 * cannot express. A tool that reconciled by deletion would silently destroy
 * the only hand-authored ordering in the repository.
 *
 * ## Closed issues are not blockers, and that is why the derivation skips them
 *
 * A closed issue can never block anything — GitHub's
 * `issueDependenciesSummary.blockedBy` counts OPEN blockers, and
 * `lib/board-mirror.ts`'s `isUnblocked` reads that count. An edge to a closed
 * issue is therefore a row on a card that changes no decision, so
 * {@link declaredDependencies} resolves open issues only. `includeClosed`
 * widens what is CONSIDERED, for the reading's own checks; it never makes a
 * closed issue a blocker.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { phaseOf } from "./board-mirror";
import {
  adrStatus,
  cells,
  hasDecompositionTable,
  parseDecompositionPlan,
  plain,
  rowCells,
  type DecompositionRow,
} from "./issue-decomposition";

export interface DepIssue {
  readonly number: number;
  /**
   * The title. A Decomposition row names its own issue by its outcome, which
   * is the title `plan-issues` filed it under, so this is how a declared
   * dependency finds its two ends (SC-2606).
   */
  readonly title: string;
  /** `OPEN` or `CLOSED`, spelled as the GitHub API spells it. */
  readonly state: string;
  /** The milestone title the phase is read from, or null for none. */
  readonly milestone: string | null;
  /** The issue numbers that already block this one, live. */
  readonly blockedBy: readonly number[];
  /**
   * True when the reader could not see all of them — a paged connection that
   * reported another page. A truncated list is not a short list: an unread
   * blocker past the cut reads as {@link DependencyPlan.missing} and is
   * re-added, and a real {@link DependencyPlan.extra} goes unreported.
   */
  readonly blockedByTruncated?: boolean;
}

/** One `blocked by` link: `blocked` waits for `blocker`. */
export interface DepEdge {
  readonly blocked: number;
  readonly blocker: number;
}

export interface DependencyPlan {
  /**
   * UNMEASURED FAILS. An empty edge list from an unread input is not a clean one.
   *
   * There is no one-phase reading any more (#2239's NOTHING_TO_SEQUENCE): it
   * existed because one phase states no PHASE order, and the plan is no
   * longer phase order. A sound read in one phase is MEASURED, and its
   * edges are whatever planning declared among those issues — often none.
   */
  reading: "MEASURED" | "UNMEASURED";
  unmeasuredReasons: string[];
  /** The phase numbers that carry at least one considered issue, ascending. */
  phases: number[];
  /** Declared and not yet present — what `--write` would add. */
  missing: DepEdge[];
  /** Declared and already there — what makes a re-run a no-op. */
  present: DepEdge[];
  /** Present and NOT declared: a hand-written link, or old phase order (#2433). Reported, never removed. */
  extra: DepEdge[];
  /** Considered issues carrying no `Phase N` milestone. */
  unphased: number[];
  /** The lowest phase with an open issue — reported; since ADR-021 it gates nothing. */
  frontier: number | null;
}

/**
 * Every way this reading can fail to carry an order — the whole class, once.
 *
 * ## Why this is a table and not another `if`
 *
 * The first version refused on `issues.length === 0` and on
 * `phases.length === 1`, and four review rounds each found a different input
 * that walks between them. The last was `phases.length === 0`: issues exist,
 * so the empty-input guard is skipped, and there is no single phase, so the
 * one-phase guard is skipped — and an unphased board reports `0 missing`,
 * which `scripts/plan-deps.ts` prints as *"the tracker already carries the
 * phase order"*. That sentence is false and it is the flattering reading.
 *
 * The reviewer's own process finding named the shape: *a UNMEASURED check
 * written for one specific empty-input shape, not the class of them*, which
 * a line-level patch keeps reintroducing variants of. `AGENTS.md` rule 5
 * says to stop repairing and re-scope at the third round. So the guard is
 * stated once, as a table. Since ADR-021 the plan is what planning declared,
 * not phase order, and the rows that survive are the ones about the INPUT:
 * a reading that could not be taken is never an empty plan.
 *
 * | # | Condition | What it means |
 * |---|---|---|
 * | 1 | nothing read | a failed fetch and an empty repository are the same bytes |
 * | 2 | read, none considered | every issue was filtered out — all closed, without `--include-closed` |
 * | 3 | considered, no phase | nobody carries a `Phase N` milestone: `plan-spec` never ran, or the naming drifted from `phaseOf` |
 * | 5 | a truncated blocker list | an unread edge past the page boundary reads as missing and gets re-added |
 * | 6 | an accepted plan that does not parse names an open issue | a link it declares cannot be checked, so "nothing missing" would be a guess |
 *
 * Rows 1-3 are reads that could not be taken. Rows 5 and 6 are orthogonal —
 * the phases can be fine while the live edge list is short, or a declaration
 * unread — so they are checked alongside. Row 6 takes the paths
 * {@link unreadPlansThatMatter} returns, never every unparseable plan: one
 * that names no open issue provably declares nothing owed. The one-phase row (#2239) is gone with phase order (ADR-021):
 * one phase is a sound read, and the plan is what planning declared.
 */
export function degenerateReasons(r: {
  readonly read: number;
  readonly considered: number;
  readonly phases: readonly number[];
  readonly includeClosed: boolean;
  readonly truncated: readonly number[];
  readonly unreadPlans: readonly string[];
}): string[] {
  const out: string[] = [];
  if (r.read === 0) {
    out.push(
      "no issues were read — an empty repository and a failed fetch produce the same " +
        "empty edge list, and only one of them is a clean reading",
    );
  } else if (r.considered === 0) {
    out.push(
      `${r.read} issue(s) were read and none was considered` +
        (r.includeClosed ? "" : " — every one is closed, and --include-closed was not passed"),
    );
  } else if (r.phases.length === 0) {
    out.push(
      `${r.considered} issue(s) were considered and NONE carries a Phase milestone — ` +
        `either plan-spec has not run here, or the milestone titles no longer match ` +
        `what phaseOf reads. An empty plan from this input means "nothing was read", ` +
        `not "the tracker already carries every declared dependency"`,
    );
  }
  if (r.truncated.length > 0) {
    out.push(
      `the blocker list was truncated for ${r.truncated.length} issue(s) ` +
        `(${r.truncated.map(n => `#${n}`).join(", ")}) — an edge past the page boundary ` +
        `reads as missing and would be re-added`,
    );
  }
  if (r.unreadPlans.length > 0) {
    out.push(
      `${r.unreadPlans.length} accepted plan(s) do not parse and name an open issue (${r.unreadPlans.join(", ")}) — ` +
        `a link they declare cannot be checked. Bring the Decomposition table to the shape ` +
        `plan-issues reads, and re-run`,
    );
  }
  return out;
}

/** One accepted ADR's Decomposition, as {@link declaredDependencies} reads it. */
export interface DeclaredPlan {
  readonly path: string;
  readonly rows: readonly DecompositionRow[];
}

/**
 * The `blocked by` edges planning declared — SC-2606, ADR-021 decision 6.
 *
 * Each row of each accepted plan names its own issue by its outcome, which is
 * the title `plan-issues` filed it under. Its `Blocked by` cells are other
 * rows' outcomes or `#<n>`; its `Blocks` cells are `#<n>`. Only OPEN issues
 * resolve, so a row whose issue has closed, or was never filed, contributes
 * nothing: a closed issue cannot wait, and cannot hold anything back.
 *
 * A title two open issues share resolves to neither. Writing a link onto the
 * wrong one of two is worse than writing none, and `plan-deps` reports the
 * row as unwritten either way. Pure: the caller reads the plans and the
 * tracker.
 */
export function declaredDependencies(
  plans: readonly DeclaredPlan[],
  issues: readonly Pick<DepIssue, "number" | "title" | "state">[],
): DepEdge[] {
  const open = issues.filter(i => i.state === "OPEN");
  const numbers = new Set(open.map(i => i.number));
  const byTitle = new Map<string, number | null>();
  for (const i of open) byTitle.set(i.title, byTitle.has(i.title) ? null : i.number);
  const ref = (cell: string): number | undefined => {
    if (/^#\d+$/.test(cell)) {
      const n = Number(cell.slice(1));
      return numbers.has(n) ? n : undefined;
    }
    return byTitle.get(cell) ?? undefined;
  };
  const out = new Map<string, DepEdge>();
  const add = (blocked: number | undefined, blocker: number | undefined) => {
    if (blocked === undefined || blocker === undefined || blocked === blocker) return;
    out.set(`${blocked}<-${blocker}`, { blocked, blocker });
  };
  for (const p of plans) {
    for (const r of p.rows) {
      const self = byTitle.get(r.outcome) ?? undefined;
      for (const b of r.blockedBy) add(self, ref(b));
      for (const b of r.blocks ?? []) add(ref(b), self);
    }
  }
  return [...out.values()];
}

/** An accepted ADR whose Decomposition table does not parse, kept whole for {@link unreadPlansThatMatter}. */
export interface UnreadablePlan {
  readonly path: string;
  readonly text: string;
}

/**
 * Every accepted ADR's Decomposition under `<root>/docs/adr`, read once.
 *
 * An accepted plan whose table no longer parses (older ADRs used a shape the
 * parser refuses) declares nothing it can read: it is returned in
 * `unreadable`, so the caller says so, never dropped silently — and
 * {@link unreadPlansThatMatter} decides whether it can still owe a link.
 */
export function readDeclaredPlans(root: string): { plans: DeclaredPlan[]; unreadable: UnreadablePlan[] } {
  const dir = join(root, "docs", "adr");
  if (!existsSync(dir)) return { plans: [], unreadable: [] };
  const plans: DeclaredPlan[] = [];
  const unreadable: UnreadablePlan[] = [];
  for (const name of readdirSync(dir).filter(n => /^ADR-\d+.*\.md$/.test(n)).sort()) {
    const path = `docs/adr/${name}`;
    const text = readFileSync(join(dir, name), "utf-8");
    if (adrStatus(text) !== "accepted" || !hasDecompositionTable(text)) continue;
    const plan = parseDecompositionPlan(text);
    if (plan.reading === "MEASURED") plans.push({ path, rows: plan.rows });
    else unreadable.push({ path, text });
  }
  return { plans, unreadable };
}

/**
 * The unparseable plans that could still declare a link the tracker owes —
 * row 6 of {@link degenerateReasons}' table.
 *
 * Every declared edge needs its row's OWN issue open: {@link declaredDependencies}
 * skips a row whose issue has closed, in both of its cells. A row names its
 * issue by its outcome, and `plan-issues` filed that outcome as the title with
 * its backticks removed and `\|` read as `|`. So only a line that, read the
 * same way, contains an open issue's title can owe anything, and only if it
 * is a table line — prose declares nothing.
 *
 * Such a line is read with the parser's own `rowCells`, `plain` and `cells`.
 * When the title IS its outcome cell and every cell after the milestone is
 * empty or `—`, the row declares nothing (live: ADR-011's row for #1885).
 * Anything else — the title in another cell, a row too short to have a
 * `Blocked by` — counts, because a row that cannot be read cannot be cleared.
 * Returning every unparseable plan instead would make one old ADR refuse the
 * reading forever.
 */
export function unreadPlansThatMatter(
  unreadable: readonly UnreadablePlan[],
  issues: readonly Pick<DepIssue, "title" | "state">[],
): string[] {
  const titles = issues.filter(i => i.state === "OPEN" && i.title.trim() !== "").map(i => i.title.trim());
  const owes = (line: string): boolean => {
    const read = line.replaceAll("\\|", "|").replaceAll("`", "");
    const named = titles.filter(t => read.includes(t));
    if (named.length === 0 || !line.includes("|")) return false;
    const c = rowCells(line);
    const declaresNothing = c.length >= 5 && named.every(t => plain(c[1]!) === t) && c.slice(4).every(x => cells(x).length === 0);
    return !declaresNothing;
  };
  return unreadable.filter(u => u.text.split("\n").some(owes)).map(u => u.path);
}

/**
 * What the repository's `blocked by` edges should be: the ones planning
 * declared (SC-2606), set against the ones the tracker carries.
 *
 * Pure: it takes the live reading and the declared edges, and returns three
 * disjoint sets. Nothing here calls GitHub, so `test/plan-deps.test.ts` can
 * state a whole repository as a literal and assert on membership rather than
 * on a count — the seventh shape in
 * `.claude/rules/checks-must-be-able-to-fail.md` is a battery whose rows all
 * share the caller's blind spot, and a count cannot distinguish "twelve right
 * edges" from "twelve wrong ones".
 *
 * `declared` is required, never defaulted: an absent declaration read as
 * "none" is an empty plan that reads as a sequenced tracker.
 */
export function dependencyPlan(
  issues: readonly DepIssue[],
  declared: readonly DepEdge[],
  opts: { readonly includeClosed?: boolean; readonly unreadPlans?: readonly string[] } = {},
): DependencyPlan {
  const considered = issues.filter(i => opts.includeClosed || i.state === "OPEN");
  const unphased: number[] = [];
  const byPhase = new Map<number, DepIssue[]>();
  for (const i of considered) {
    // One reading of the title (#2057). `Release (Phase 3)` is not a phase
    // milestone, to every reader. Phases are reported, and order Ready; they
    // decide no edge here (ADR-021).
    const p = phaseOf(i.milestone);
    if (p === null) {
      unphased.push(i.number);
      continue;
    }
    byPhase.set(p, [...(byPhase.get(p) ?? []), i]);
  }

  const phases = [...byPhase.keys()].sort((a, b) => a - b);
  const reasons = degenerateReasons({
    read: issues.length,
    considered: considered.length,
    phases,
    includeClosed: opts.includeClosed === true,
    truncated: issues.filter(i => i.blockedByTruncated === true).map(i => i.number),
    unreadPlans: opts.unreadPlans ?? [],
  });

  // The declared edges whose BLOCKED end is in the population this run
  // considers. `plan-deps` narrows to one milestone family, so a link is
  // written by the run for the family of the issue that waits; its blocker
  // may sit anywhere.
  const key = (e: DepEdge): string => `${e.blocked}<-${e.blocker}`;
  const consideredNumbers = new Set(considered.map(i => i.number));
  const derived = [...new Map(declared.filter(e => consideredNumbers.has(e.blocked)).map(e => [key(e), e])).values()];
  const derivedKeys = new Set(derived.map(key));
  const liveKeys = new Set<string>();
  for (const i of issues) for (const b of i.blockedBy) liveKeys.add(key({ blocked: i.number, blocker: b }));

  const extra: DepEdge[] = [];
  for (const i of issues) {
    for (const b of i.blockedBy) {
      const e = { blocked: i.number, blocker: b };
      if (!derivedKeys.has(key(e))) extra.push(e);
    }
  }

  const open = considered.filter(i => i.state === "OPEN").map(i => phaseOf(i.milestone));
  const openPhases = open.filter((p): p is number => p !== null);

  return {
    reading: reasons.length > 0 ? "UNMEASURED" : "MEASURED",
    unmeasuredReasons: reasons,
    phases,
    missing: derived.filter(e => !liveKeys.has(key(e))),
    present: derived.filter(e => liveKeys.has(key(e))),
    extra,
    unphased,
    frontier: openPhases.length === 0 ? null : Math.min(...openPhases),
  };
}

/**
 * The missing edges grouped by the issue that carries them.
 *
 * `gh issue edit <N> --add-blocked-by <M>` takes the flag repeatedly, so one
 * call per BLOCKED issue applies all of its blockers. Measured on the live
 * convergence set: 37 calls instead of 194. The grouping is here rather than
 * in the script because it is the shape the plan is applied in, and a test
 * that asserts on it is asserting on what actually reaches GitHub.
 */
export function groupByBlocked(edges: readonly DepEdge[]): { blocked: number; blockers: number[] }[] {
  const g = new Map<number, number[]>();
  for (const e of edges) g.set(e.blocked, [...(g.get(e.blocked) ?? []), e.blocker]);
  return [...g]
    .sort((a, b) => a[0] - b[0])
    .map(([blocked, blockers]) => ({ blocked, blockers: [...blockers].sort((a, b) => a - b) }));
}
