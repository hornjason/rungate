#!/usr/bin/env bun
/**
 * Write the dependencies planning declared onto the tracker as `blocked by`
 * edges (#1647, SC-2606).
 *
 * Until ADR-021 this wrote the PHASE order: every issue in a phase blocked by
 * every issue in the phase before. That made phase a gate, and ADR-021 made
 * it an order instead — Ready sorts by it. What this writes now is what an
 * accepted ADR's Decomposition table declared: each row's `Blocked by` and
 * `Blocks` cells (`declaredDependencies`, `lib/spec-deps.ts`). `plan-issues`
 * writes those links when it files the rows; this adds any that went missing.
 *
 * ## It reports by default and writes only when told
 *
 * No `--write`, no mutation. The reading is the product: which edges are
 * missing, which are already there, and which exist that this did not derive.
 *
 * ## It never deletes an edge, and the third set is why
 *
 * `EXTRA` is an edge present on the tracker that no accepted plan declares:
 * one written by hand between issues that already existed, or a phase-order
 * link this wrote before ADR-021 (#2433 takes those off). Reconciling by
 * deletion would destroy the hand-authored ones, so this prints them and
 * stops. See `lib/spec-deps.ts`.
 *
 * ## Why the edges are grouped by blocked issue
 *
 * `groupByBlocked` decides the grouping and is tested on its own, because the
 * group IS what reaches GitHub: each group is one `addBlockers` call, which
 * writes its links and reads them back once. Since #2345 the links go through
 * the REST dependencies endpoint, one POST per link, because
 * `issue edit --add-blocked-by` is missing from older runners' `gh`. So the
 * phase-order set it once wrote, 194 edges over 37 blocked issues, was 194
 * writes and 37 read-backs, plus one id read per distinct blocker
 * (`BLOCKER_IDS`).
 */
import { addBlockers, removeBlocker } from "../lib/blocked-by-write";
import { parseArgs } from "util";
import { createGitHubClient } from "../lib/github";
import { declaredDependencies, dependencyPlan, groupByBlocked, readDeclaredPlans, unreadPlansThatMatter } from "../lib/spec-deps";
import type { DeclaredPlan, DepEdge, DepIssue, UnreadablePlan } from "../lib/spec-deps";
import { ghWithoutGhToken, inMilestoneFamily, readLiveIssues, readMilestonePrefix } from "../lib/live-issues";
import { phaseOf } from "../lib/board-mirror";
import { familyOf } from "../lib/spec-placement";

/**
 * THE one non-zero exit. One site, so `test/plan-deps.test.ts` can build a
 * mutant with it set to `0` and prove each refusal is what the case observed
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
export const REFUSAL_EXIT = 1;

/**
 * Refuse on the channel the caller asked for — round 1 of #1705.
 *
 * `--json` is documented as "the whole plan, for something other than a
 * person", and four refusals returned before the `--json` block ever ran: an
 * unparseable argument, a missing `--repo`, and the two prefix refusals. A
 * caller doing `JSON.parse(stdout)` got an empty string and a crash, on
 * exactly the inputs where it most needed to be told what went wrong.
 *
 * The payload carries every key the success payload does, asserted against
 * the success payload rather than a hand-copied list, so a consumer reading
 * `.missing.length` on a refusal gets `0` and not a `TypeError`.
 *
 * `usage` is appended only on the text channel. A usage block is for a
 * person; inside a JSON string it is noise a parser has to step over.
 */
function refuse(json: boolean, reason: string, usage = false): number {
  if (json) {
    console.log(
      JSON.stringify(
        {
          reading: "UNMEASURED",
          unmeasuredReasons: [reason],
          phases: [],
          missing: [],
          present: [],
          extra: [],
          unphased: [],
          frontier: null,
          unreadablePlans: [],
          results: [],
          wrote: "refused",
        },
        null,
        2,
      ),
    );
  } else {
    console.error(`plan-deps: ${reason}${usage ? `\n\n${USAGE}` : ""}`);
  }
  return REFUSAL_EXIT;
}

export interface PlanDepsGitHub {
  createClient: typeof createGitHubClient;
  /** Every open-or-closed issue with a milestone, and its live blockers. */
  readIssues: (client: unknown, repo: string, includeClosed: boolean) => Promise<DepIssue[]>;
  /** Apply one blocked issue's missing blockers. Resolves on success. */
  addBlockers: (repo: string, blocked: number, blockers: readonly number[]) => Promise<void>;
  /**
   * Every milestone title, open and closed (#2413). Read only when no open
   * issue matched the prefix, to tell a finished family from a misspelled
   * prefix. Absent, the run keeps the prefix refusal; a throw is UNMEASURED.
   */
  readMilestoneTitles?: (repo: string) => Promise<string[]>;
  /**
   * Every accepted ADR's Decomposition under the project root (SC-2606). A
   * local read, not a GitHub one, kept on this seam so no test reads the
   * repository it runs in. A throw is UNMEASURED, refused before the network.
   */
  readPlans: (root: string) => { plans: DeclaredPlan[]; unreadable: UnreadablePlan[] };
  /**
   * Take one `blocked by` link off (#2433). Read only by
   * `--remove-phase-order --write`; absent, that run refuses.
   */
  removeBlocker?: (repo: string, blocked: number, blocker: number) => Promise<void>;
}

/**
 * The phase-order links this command wrote before ADR-021 (#2433): within one
 * milestone family, every open issue of a phase blocked by every open issue
 * of the phase before it, among the phases that exist. Re-derived only so
 * `--remove-phase-order` can take them OFF; nothing writes these any more.
 */
export function phaseOrderLinks(issues: readonly DepIssue[]): DepEdge[] {
  const byFamily = new Map<string, Map<number, number[]>>();
  for (const i of issues) {
    const p = phaseOf(i.milestone);
    const f = familyOf(i.milestone);
    if (i.state !== "OPEN" || p === null || f === null) continue;
    const fam = byFamily.get(f) ?? new Map<number, number[]>();
    fam.set(p, [...(fam.get(p) ?? []), i.number]);
    byFamily.set(f, fam);
  }
  const out: DepEdge[] = [];
  for (const fam of byFamily.values()) {
    const phases = [...fam.keys()].sort((a, b) => a - b);
    for (let k = 1; k < phases.length; k++) {
      for (const blocked of fam.get(phases[k])!) {
        for (const blocker of fam.get(phases[k - 1])!) out.push({ blocked, blocker });
      }
    }
  }
  return out;
}

/**
 * What `--remove-phase-order` takes off (#2433, ADR-021 decision 2): the phase
 * order {@link phaseOrderLinks} derives plus the pairs `--also-remove` names,
 * kept only where the link is ON the tracker and no accepted plan declares it.
 * A link written by hand inside a phase is not phase order, so it stays. A
 * named pair that is not on the tracker, or that a plan declares, refuses —
 * a typo would otherwise remove nothing and read as done.
 */
export function phaseOrderRemoval(
  issues: readonly DepIssue[],
  declared: readonly DepEdge[],
  also: readonly DepEdge[],
): { remove: DepEdge[]; refusals: string[] } {
  const key = (e: DepEdge): string => `${e.blocked}<-${e.blocker}`;
  const present = new Set(issues.flatMap(i => i.blockedBy.map(b => key({ blocked: i.number, blocker: b }))));
  const declaredKeys = new Set(declared.map(key));
  const refusals: string[] = [];
  for (const e of also) {
    if (!present.has(key(e))) {
      refusals.push(`#${e.blocked} is not blocked by #${e.blocker} among the issues this run read, so --also-remove names nothing to take off`);
    } else if (declaredKeys.has(key(e))) {
      refusals.push(`#${e.blocked} blocked by #${e.blocker} is declared by an accepted plan; this never removes a declared dependency`);
    }
  }
  const out = new Map<string, DepEdge>();
  for (const e of [...phaseOrderLinks(issues), ...also]) {
    if (present.has(key(e)) && !declaredKeys.has(key(e))) out.set(key(e), e);
  }
  return {
    remove: [...out.values()].sort((a, b) => a.blocked - b.blocked || a.blocker - b.blocker),
    refusals,
  };
}

/** `--also-remove 1764:1591,1764:1186` — blocked:blocker pairs, or null when one does not read. */
function alsoRemovePairs(raw: string | undefined): DepEdge[] | null {
  if (raw === undefined) return [];
  const out: DepEdge[] = [];
  for (const part of raw.split(",").map(x => x.trim()).filter(x => x !== "")) {
    const m = /^#?(\d+):#?(\d+)$/.exec(part);
    if (m === null) return null;
    out.push({ blocked: Number(m[1]), blocker: Number(m[2]) });
  }
  return out;
}

/** Each blocker's database id, read once per run however many issues it blocks. */
const BLOCKER_IDS = new Map<string, number>();

async function liveAddBlockers(
  repo: string,
  blocked: number,
  blockers: readonly number[],
): Promise<void> {
  // Through the REST dependencies API, one link at a time: `issue edit
  // --add-blocked-by` does not exist in an older runner's gh (#2345).
  addBlockers(repo, blocked, blockers, ghWithoutGhToken, BLOCKER_IDS);
}

const LIVE_GITHUB: PlanDepsGitHub = {
  createClient: createGitHubClient,
  readIssues: (_client, repo, includeClosed) => readLiveIssues(repo, includeClosed),
  addBlockers: liveAddBlockers,
  removeBlocker: async (repo, blocked, blocker) => removeBlocker(repo, blocked, blocker, ghWithoutGhToken, BLOCKER_IDS),
  readPlans: readDeclaredPlans,
  readMilestoneTitles: async repo =>
    ghWithoutGhToken(["api", "--paginate", `repos/${repo}/milestones?state=all&per_page=100`, "--jq", ".[].title"])
      .split("\n")
      .filter(t => t.length > 0),
};

const USAGE = `rungate plan-deps --repo <owner/name> --milestone-prefix <name>
                              [--write] [--json] [--include-closed]

  --repo              owner/name. Defaults to $GITHUB_REPOSITORY.
  --write             apply the missing edges. Without it, nothing is mutated.
  --json              the whole plan, for something other than a person.
  --include-closed    consider closed issues too. A closed issue still gets no
                      edge and is no blocker: it can never block anything, so
                      the edge would be a row on a card that changes no decision.
  --project-root      where docs/adr/ is read from. Defaults to the cwd.
  --remove-phase-order
                      take OFF the phase-order links this command wrote before
                      ADR-021, instead of adding declared links (#2433). Lists
                      them; --write removes them. Never removes a link an
                      accepted plan declares, nor one inside a phase.
  --also-remove       with --remove-phase-order: blocked:blocker pairs to take
                      off too, e.g. 1764:1591,1162:1764. Each must be on the
                      tracker and declared by no plan, or the run refuses.
  --milestone-prefix  REQUIRED. Consider only issues whose milestone TITLE
                      starts with this, e.g. "Pipeline": a run writes the
                      declared links of the issues in one family. Required
                      rather than optional since #1728: omitting it resolved 89
                      edges across 38 issues spanning two families and took
                      \`board-conformance\`'s blocked-by reading from 12 of 12
                      to 4 of 12. \`plan-spec\` and \`board-snapshot\` require
                      their --prefix for the same reason.`;

export async function main(argv: string[], gh: PlanDepsGitHub = LIVE_GITHUB): Promise<number> {
  // Read off the RAW argv, because the refusal below happens when there is no
  // parse to read `values.json` from. `--json` is declared boolean, and
  // `parseArgs` rejects `--json=x` for a boolean option, so an exact match is
  // the whole set of spellings that reach the parsed value.
  const jsonRequested = argv.includes("--json");

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        repo: { type: "string" },
        write: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        "include-closed": { type: "boolean", default: false },
        "milestone-prefix": { type: "string" },
        "project-root": { type: "string" },
        "remove-phase-order": { type: "boolean", default: false },
        "also-remove": { type: "string" },
      },
      allowPositionals: true,
    });
  } catch (e) {
    return refuse(jsonRequested, (e as Error).message, true);
  }

  const { values } = parsed;
  // #2433's mode, checked statically like every other argument: no tracker
  // read for a run whose arguments cannot be acted on.
  const also = alsoRemovePairs(values["also-remove"]);
  if (values["also-remove"] !== undefined && !values["remove-phase-order"]) {
    return refuse(values.json, `--also-remove only means something with --remove-phase-order`, true);
  }
  if (also === null) {
    return refuse(values.json, `--also-remove takes blocked:blocker pairs, comma-separated, e.g. 1764:1591 — got "${values["also-remove"]}"`, true);
  }
  if (values["remove-phase-order"] && values.json) {
    return refuse(true, `--remove-phase-order prints for a person and has no --json form`);
  }
  const repo = values.repo ?? process.env.GITHUB_REPOSITORY;
  if (!repo) {
    return refuse(values.json, `--repo is required (or set GITHUB_REPOSITORY)`, true);
  }

  // THE PREFIX IS RESOLVED BEFORE THE NETWORK READ, and that ordering is
  // the point rather than an optimisation. Review of #1730: with the check
  // below the read, `plan-deps --repo o/r` against an unauthenticated `gh`
  // reports "the issues could not be read" — so the one mistake #1728
  // exists to catch is reported as an API problem, and the actionable
  // message never arrives. A static argument check has no business
  // depending on the network being up.
  //
  // Narrow the POPULATION, not the edges. The derivation is right about the
  // order it is handed; what it is handed has to be one spec's issues. An
  // issue with no milestone is out by the same test — `startsWith` on a
  // missing title is not a match, and it would be `unphased` anyway.
  //
  // ONE reading, trimmed once, feeding both the refusal and the filter. The
  // first version tested `raw.trim() === ""` and filtered with `raw`, so
  // `" Pipeline"` passed the guard and matched nothing (round 1 of #1705).
  const prefixRead = readMilestonePrefix(values["milestone-prefix"]);

  // A BLANK prefix is not "no filter requested". `"".startsWith(" Phase ")`
  // is false, but `inMilestoneFamily(m, "")` tests `" Phase "`, which every
  // derived title contains — so `--milestone-prefix "$X"` with `$X` unset
  // quietly re-admits every spec's issues and reports success, the exact
  // contamination the flag exists to prevent. `plan-spec` and
  // `board-snapshot` refuse a blank `--prefix` through the same reading.
  //
  // The remedy this names must be one the NEXT check accepts. It used to
  // read "omit the flag if you meant no filter", which was true until the
  // absent case below became a refusal too — after which following it
  // landed the caller in that refusal and the two messages sent them back
  // and forth with no accepted argv between them. Caught in review of
  // #1730; `test/plan-deps.test.ts` runs both refusals in one case so the
  // advice cannot drift from the behaviour again.
  if (prefixRead.kind === "blank") {
    return refuse(
      values.json,
      `--milestone-prefix was given as ${JSON.stringify(prefixRead.raw)}, which is blank. A blank ` +
        `prefix narrows nothing — it matches every \`Phase N\` title in the repository, which is ` +
        `the contamination the flag exists to prevent. Name the milestone family instead, e.g. ` +
        `--milestone-prefix Pipeline. There is no "no filter" option: an omitted flag is refused ` +
        `for the same reason.`,
      true,
    );
  }

  // ABSENT is refused too, and for a sharper reason than blank. This
  // repository carries TWO families with Phase milestones — `Pipeline
  // Phase 0..9` and `Convergence Phase 0..6` — so an unscoped read
  // sequences one spec's issues against another's, and `board-conformance`
  // scores a single family. Measured 2026-11-02 (#1728): a `--write` with
  // no prefix resolved 89 edges across 38 issues and took
  // `blocked-by-edges` from 12 of 12 to 4 of 12, on edges the reading
  // cannot resolve. `plan-spec` and `board-snapshot` already require their
  // `--prefix` for the same reason; this is the third tool agreeing.
  //
  // The dry run is refused as well as the write. It is what a reader
  // consults BEFORE writing, so an unscoped count is the misleading half.
  if (prefixRead.kind === "absent") {
    return refuse(
      values.json,
      `--milestone-prefix is required. This repository has more than one milestone family carrying ` +
        `\`Phase N\` titles, so an unscoped run sequences one spec's issues against another's and ` +
        `writes edges \`board-conformance --prefix <name>\` cannot resolve. Name the family, e.g. ` +
        `--milestone-prefix Pipeline.`,
      true,
    );
  }

  const prefix = prefixRead.prefix;

  // `board: { phaseOrder: false }` (#2352) let a family opt out of the
  // phase-order links. Since ADR-021 there are none to opt out of, so the
  // setting is not read here: a family that set it still gets the links its
  // accepted plans declare (review of #2439, round 2).
  const root = values["project-root"] ?? process.cwd();

  // What planning declared (SC-2606), read before the network like the
  // settings above, so a tree whose ADRs cannot be read is refused without a
  // tracker call. An accepted plan whose table no longer parses is reported;
  // it refuses the reading only when it names an open issue
  // (`unreadPlansThatMatter`), since otherwise it provably owes no link and
  // refusing would stop every run on a repository with one old ADR.
  let plans: { plans: DeclaredPlan[]; unreadable: UnreadablePlan[] };
  try {
    plans = gh.readPlans(root);
  } catch (e) {
    return refuse(values.json, `UNMEASURED — the accepted ADRs under ${root}/docs/adr could not be read: ${(e as Error).message}`);
  }

  // Only now does anything touch the network. `createClient` is inside the
  // same `try` as the read: repairing only the call a finding named would
  // leave the other one on the same path throwing the same way.
  //
  // Distinguishing "the repository has no issues" from "the call failed"
  // matters because reporting the flattering one is how an empty edge list
  // reads as a clean plan. Uncaught, that throw left `main()` rejecting — a
  // stack on stderr and an EMPTY stdout, which under `--json` is the crash
  // every refusal here is routed through `refuse()` to stop, arriving on
  // the input that needs the payload most. Round 2 of #1705.
  let read;
  try {
    const client = gh.createClient();
    read = await gh.readIssues(client, repo, values["include-closed"]);
  } catch (e) {
    return refuse(
      values.json,
      `UNMEASURED — the issues could not be read: ${(e as Error).message}. That is a failed ` +
        `call, not a repository with no issues.`,
    );
  }

  const issues = read.filter(i => inMilestoneFamily(i.milestone, prefix));

  // A prefix that matched nothing is its own reading, and it has to say so
  // here: `degenerateReasons` would report "no issues were read — an empty
  // repository and a failed fetch produce the same empty edge list", which
  // is false when four issues were read and the filter took them. A typo in
  // the prefix is the likeliest way to arrive here, and that sentence sends
  // the reader to the API.
  if (issues.length === 0 && read.length > 0 && gh.readMilestoneTitles) {
    // #2413: no OPEN issue matched, but the family may exist and be finished
    // (every issue closed) or not yet decomposed. Its milestones decide: a
    // family with milestones has nothing left to order, which is exit 0, not
    // the typo refusal below that turned a consumer's main red on every push
    // to specs/. A list that cannot be read decides nothing.
    let titles: string[];
    try {
      titles = await gh.readMilestoneTitles(repo);
    } catch (e) {
      return refuse(
        values.json,
        `UNMEASURED — ${read.length} issue(s) were read and NONE carries a milestone starting ` +
          `"${prefix}", and the milestone list could not be read: ${(e as Error).message}. A finished ` +
          `family and a misspelled prefix cannot be told apart without it.`,
      );
    }
    const family = titles.filter(t => inMilestoneFamily(t, prefix));
    if (family.length > 0) {
      if (values.json) {
        // Its own reading, not a DependencyPlan: here no issue was considered
        // at all (review of #2414).
        const wrote = values.write ? "nothing-to-order" : "not-requested";
        // Every key the other readings carry, empty, as PHASE_ORDER_OFF does (review of #2414).
        console.log(
          JSON.stringify(
            { reading: "NOTHING_TO_ORDER", unmeasuredReasons: [], phases: [], missing: [], present: [], extra: [], unphased: [], frontier: null, unreadablePlans: plans.unreadable.map(u => u.path), results: [], wrote, prefix, milestones: family },
            null,
            2,
          ),
        );
        return 0;
      }
      console.log(
        `${repo} — 0 issue(s) read (of ${read.length}, narrowed to milestones starting "${prefix}")\n\n` +
          `Nothing written: nothing to order: ${family.length} milestone(s) start with "${prefix}" and none ` +
          `holds an open issue. A finished family, or one not yet decomposed, states no order.`,
      );
      return 0;
    }
  }
  if (issues.length === 0 && read.length > 0) {
    return refuse(
      values.json,
      `UNMEASURED — ${read.length} issue(s) were read and NONE carries a milestone ` +
        `starting "${prefix}". That is a prefix matching nothing, not a repository with no issues.`,
    );
  }

  // Resolved against EVERY issue read, not the family: a row's blocker may sit
  // in another milestone. The family narrows which issues WAIT.
  const declaredEdges = declaredDependencies(plans.plans, read);
  const plan = dependencyPlan(issues, declaredEdges, {
    includeClosed: values["include-closed"],
    unreadPlans: unreadPlansThatMatter(plans.unreadable, read),
  });

  // The refusal, decided BEFORE anything is written. `plan-spec` shipped this
  // backwards once — it created eight milestones and THEN returned non-zero,
  // and an exit code cannot tell that apart from a refusal that stopped
  // something. One expression, read by every path below.
  const refuseWrite = plan.reading === "UNMEASURED";

  if (values["remove-phase-order"]) {
    if (refuseWrite) {
      console.error(`plan-deps: UNMEASURED — the dependency plan could not be read, so nothing is removed:`);
      for (const r of plan.unmeasuredReasons) console.error(`  - ${r}`);
      return REFUSAL_EXIT;
    }
    const removal = phaseOrderRemoval(issues, declaredEdges, also);
    if (removal.refusals.length > 0) {
      console.error(`plan-deps: --also-remove refused, and nothing is removed:`);
      for (const r of removal.refusals) console.error(`  - ${r}`);
      return REFUSAL_EXIT;
    }
    console.log(
      `${repo} — ${removal.remove.length} phase-order link(s) to take off, in milestones starting "${prefix}" ` +
        `(no accepted plan declares any of them):`,
    );
    for (const e of removal.remove) console.log(`  #${e.blocked} blocked by #${e.blocker}`);
    if (!values.write) {
      console.log(`\nNothing removed. Re-run with --write to take off ${removal.remove.length} link(s).`);
      return 0;
    }
    if (gh.removeBlocker === undefined) return refuse(false, `this run cannot remove links: no removeBlocker was supplied`);
    const failed: string[] = [];
    for (const e of removal.remove) {
      try {
        await gh.removeBlocker(repo, e.blocked, e.blocker);
      } catch (err) {
        failed.push(`#${e.blocked} blocked by #${e.blocker} FAILED: ${(err as Error).message}`);
      }
    }
    for (const f of failed) console.error(`  ${f}`);
    console.log(`\nREMOVED ${removal.remove.length - failed.length} of ${removal.remove.length}.`);
    return failed.length > 0 ? REFUSAL_EXIT : 0;
  }

  if (values.json) {
    // Apply FIRST, then report: `wrote` and the exit code must both be
    // computed from `results`, never before it exists. `applyEdges` turns a
    // per-group failure into a string, so a status decided ahead of it would
    // read "yes" on a run where every `gh issue edit` call failed.
    const results = values.write && !refuseWrite ? await applyEdges(gh, repo, plan.missing) : [];
    const failures = results.filter(r => r.includes("FAILED"));
    const wrote = !values.write
      ? "not-requested"
      : refuseWrite
        ? "refused"
        : failures.length > 0
          ? "partial"
          : "yes";
    console.log(JSON.stringify({ ...plan, unreadablePlans: plans.unreadable.map(u => u.path), results, wrote }, null, 2));
    return refuseWrite || failures.length > 0 ? REFUSAL_EXIT : 0;
  }

  // No unscoped branch. There is no longer a run with no prefix, so a
  // `prefix === undefined ? "" : …` here would be a line that reads as if
  // one were still possible — and a later edit would take the empty-scope
  // string for a reachable path a test exercises. Review of #1730 found
  // both this and the guard above.
  console.log(
    `${repo} — ${issues.length} issue(s) read (of ${read.length}, narrowed to milestones ` +
      `starting "${prefix}"), phases ${plan.phases.join(" -> ") || "(none)"}\n`,
  );

  if (plan.reading === "UNMEASURED") {
    console.error(`plan-deps: UNMEASURED — the dependency plan could not be read:`);
    for (const r of plan.unmeasuredReasons) console.error(`  - ${r}`);
    return REFUSAL_EXIT;
  }

  console.log(`EDGES`);
  console.log(`  ${plan.present.length} already there`);
  console.log(`  ${plan.missing.length} missing`);
  for (const g of groupByBlocked(plan.missing)) {
    console.log(`    #${g.blocked}  +${g.blockers.length}: ${g.blockers.map(b => `#${b}`).join(" ")}`);
  }
  if (plan.extra.length > 0) {
    console.log(
      `\n  ${plan.extra.length} edge(s) no accepted plan declares, LEFT ALONE — written by hand,\n` +
        `  or phase order from before ADR-021. This never removes a link:`,
    );
    for (const e of plan.extra) console.log(`    #${e.blocked} blocked by #${e.blocker}`);
  }

  console.log(`\n  Frontier: ${plan.frontier === null ? "nowhere — no open issue sits in a phase" : `Phase ${plan.frontier}`}`);
  if (plan.unphased.length > 0) {
    console.log(`  ${plan.unphased.length} issue(s) carry no Phase milestone.`);
  }
  console.log(`  Declared by ${plans.plans.length} accepted plan(s).`);
  if (plans.unreadable.length > 0) {
    console.log(
      `  ${plans.unreadable.length} accepted plan(s) whose Decomposition table does not parse, so they ` +
        `declare nothing here: ${plans.unreadable.map(u => u.path).join(", ")}`,
    );
  }

  // Said on a --write run too: with nothing declared and missing, the run
  // wrote nothing because nothing was owed, and a bare WRITING header with no
  // line under it reads like a write that silently failed.
  if (plan.missing.length === 0) {
    console.log(`\nNothing written, and nothing to write — the tracker already carries every declared dependency.`);
    return 0;
  }
  if (!values.write) {
    console.log(
      `\nNothing written. Re-run with --write to add ${plan.missing.length} edge(s) in ${groupByBlocked(plan.missing).length} call(s).`,
    );
    return 0;
  }

  console.log(`\nWRITING`);
  const applied = await applyEdges(gh, repo, plan.missing);
  for (const line of applied) console.log(`  ${line}`);
  const failures = applied.filter(r => r.includes("FAILED"));
  if (failures.length > 0) {
    console.error(
      `\nplan-deps: ${failures.length} of ${applied.length} write(s) FAILED. The exit code ` +
        `says so; printing the failure among the successes did not.`,
    );
    return REFUSAL_EXIT;
  }
  return 0;
}

/**
 * Add every missing blocker, grouped — the ONE write site.
 *
 * Both output paths call it, so `--json --write` cannot silently do nothing
 * the way `plan-spec`'s did when its write lived below the `--json` return.
 */
async function applyEdges(
  gh: PlanDepsGitHub,
  repo: string,
  missing: readonly DepEdge[],
): Promise<string[]> {
  const done: string[] = [];
  for (const g of groupByBlocked(missing)) {
    try {
      await gh.addBlockers(repo, g.blocked, g.blockers);
      done.push(`#${g.blocked}  +${g.blockers.length}`);
    } catch (e) {
      done.push(`#${g.blocked}  FAILED (+${g.blockers.length} attempted): ${(e as Error).message}`);
    }
  }
  return done;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
