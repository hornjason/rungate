#!/usr/bin/env bun
/**
 * Apply an approved repair plan to the tracker (#1647).
 *
 * `--repair <plan.md>` reads a table somebody reviewed — today
 * `docs/adr/ADR-005-backlog-criterion-repair.md` — and does the two things
 * `.github/ISSUE_TEMPLATE/spec-work.yml` says in its own footer that a GitHub
 * issue form cannot do: name the criteria an issue serves in a shape every
 * reader can find, and move an issue out of a milestone it does not belong in.
 *
 * ## It reports by default and writes only when told
 *
 * No `--write`, no mutation.
 *
 * ## A demotion removes that issue's edges, and ONLY that issue's
 *
 * `plan-deps` never removes an edge — the rule protects the two hand-authored
 * within-phase dependencies no derivation can reproduce. But an issue leaving
 * its phase orphans every edge it had: on 2026-10-29 #1395 and #1643 each
 * carried 3 blockers and BLOCKED all six Phase 6 issues, so demoting them
 * without removing those 18 edges would leave Phase 6 waiting forever on work
 * that is no longer in the plan — the order silently wrong in the direction
 * nothing can see.
 *
 * A general prune cannot fix that, because nothing distinguishes a
 * hand-authored edge from an orphaned one by inspection. So the removal is
 * **scoped to the demotion that causes it**: this removes the edges of the
 * issues it is itself demoting, and touches no others. The cause and the
 * cleanup are one action.
 */
import { addBlockers, removeBlocker } from "../lib/blocked-by-write";
import { existsSync, readFileSync, readdirSync } from "fs";
import { spawnSync } from "child_process";
import { isAbsolute, join, relative, sep } from "path";
import { parseArgs } from "util";
import {
  CRITERIA_HEADING,
  alreadyAnnotated,
  annotatedBody,
  issuePlacement,
  multiplyAnnotated,
  parseRepairPlan,
  rowPlacement,
} from "../lib/issue-repair";
import type { IssueMove, PlacingFamily, RepairRow } from "../lib/issue-repair";
import {
  closedIssueCounts,
  hasDecompositionTable,
  adrPlacement,
  parseDecompositionPlan,
  planDecomposition,
} from "../lib/issue-decomposition";
import { readQueueLabel } from "../lib/config-readers";
import { answerableIds, specCriteriaIn, specPathSweep } from "../lib/board-mirror";
import { milestonePlan, placementCoverage, placementReading, placementsById } from "../lib/spec-placement";
import { readLiveIssues, readMilestonePrefix } from "../lib/live-issues";
import type { LiveMilestone, MilestoneAction } from "../lib/spec-placement";
import { LIVE_RUNS, WORKFLOW_FILE, lastSuccessfulRunStart } from "../lib/last-successful-run";
import type { RunsGitHub } from "../lib/last-successful-run";
// Re-exported: the decider moved to the lib in #2522, and its callers import it from here.
export { sinceLastSuccessfulRun } from "../lib/last-successful-run";
export type { RunsGitHub } from "../lib/last-successful-run";

/**
 * THE one non-zero exit. One site, so `test/plan-issues.test.ts` can build a
 * mutant with it set to `0` (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
export const REFUSAL_EXIT = 1;

export interface IssueState {
  number: number;
  body: string;
  milestone: string | null;
  /** Issues that block this one. */
  blockedBy: number[];
  /** Issues this one blocks. */
  blocking: number[];
}

export interface PlanIssuesGitHub {
  readIssue: (repo: string, number: number) => Promise<IssueState>;
  setBody: (repo: string, number: number, body: string) => Promise<void>;
  clearMilestone: (repo: string, number: number) => Promise<void>;
  removeBlockedBy: (repo: string, blocked: number, blocker: number) => Promise<void>;
  /** Every milestone, for `--milestone-prefix` placement (#2042). */
  milestones: (repo: string) => Promise<LiveMilestone[]>;
  setMilestone: (repo: string, number: number, title: string) => Promise<void>;
}

/**
 * `gh`, with `GH_TOKEN` unset and an optional stdin payload.
 *
 * `stdin` exists so a body never touches the filesystem. The first version
 * wrote it to `join("/tmp", "rg-body-<n>-<pid>.md")` and handed `gh` the
 * path, which was wrong twice over and the security review caught both:
 *
 * - **A predictable name in a world-writable directory.** Anyone on the box
 *   can pre-create that path as a symlink and the write follows it. The pid
 *   is not a secret and the issue number is public.
 * - **`Bun.write` returns a promise and nothing awaited it**, while
 *   `Bun.spawnSync` read the file immediately. The content reaching `gh` was
 *   whatever had landed by then. It happened to be complete for all nine
 *   live issues — verified byte lengths afterwards, 2,593 to 5,733 — but
 *   that is luck, and a truncated body would have silently destroyed the
 *   measurements the repair exists to preserve.
 *
 * `--body-file -` reads standard input, so there is no file, no path to
 * race, and nothing to clean up.
 */
function gh(args: readonly string[], stdin?: string): string {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.GH_TOKEN;
  const proc = Bun.spawnSync(["gh", ...args], {
    env,
    ...(stdin === undefined ? {} : { stdin: new TextEncoder().encode(stdin) }),
  });
  if (proc.exitCode !== 0) throw new Error(new TextDecoder().decode(proc.stderr).trim().slice(0, 300));
  return new TextDecoder().decode(proc.stdout);
}

const LIVE_GITHUB: PlanIssuesGitHub = {
  readIssue: async (repo, number) => {
    const j = JSON.parse(
      gh(["issue", "view", String(number), "--repo", repo, "--json", "number,body,milestone"]),
    ) as { number: number; body: string | null; milestone: { title: string } | null };
    const dep = (kind: "blocked_by" | "blocking"): number[] => {
      try {
        // PAGINATED, and `--jq` per row rather than one JSON array, because
        // `--paginate` concatenates each page's response and the result is
        // not parseable as a single document. An unpaginated read here made
        // a demotion clear only the first page of an issue's edges while
        // clearing the milestone regardless, orphaning the rest permanently
        // — the stuck-ordering failure this file's own docblock describes.
        // Found by the AI review of this change.
        return gh([
          "api",
          "--paginate",
          `repos/${repo}/issues/${number}/dependencies/${kind}?per_page=100`,
          "--jq",
          ".[].number",
        ])
          .split("\n")
          .filter(l => l.trim() !== "")
          .map(Number);
      } catch {
        // A read that failed is not an issue with no edges. Rethrow: a silent
        // [] here would make a demotion skip the cleanup it exists to do.
        throw new Error(`could not read ${kind} for #${number}`);
      }
    };
    return {
      number: j.number,
      body: j.body ?? "",
      milestone: j.milestone?.title ?? null,
      blockedBy: dep("blocked_by"),
      blocking: dep("blocking"),
    };
  },
  setBody: async (repo, number, body) => {
    gh(["issue", "edit", String(number), "--repo", repo, "--body-file", "-"], body);
  },
  clearMilestone: async (repo, number) => {
    gh(["issue", "edit", String(number), "--repo", repo, "--remove-milestone"]);
  },
  removeBlockedBy: async (repo, blocked, blocker) => {
    // REST, not `issue edit --remove-blocked-by`, which an older runner's gh lacks (#2345).
    removeBlocker(repo, blocked, blocker, args => gh([...args]), BLOCKER_IDS);
  },
  // PAGINATED, for the reason `LIVE_DECOMPOSE.milestones` gives: a phase
  // milestone on page two would read as absent and refuse the run.
  milestones: async repo => {
    const out = gh([
      "api",
      "--paginate",
      `repos/${repo}/milestones?state=all&per_page=100`,
      "--jq",
      ".[] | [.number, .title, .description] | @json",
    ]);
    return out
      .split("\n")
      .filter(l => l.trim() !== "")
      .map(l => {
        const [number, title, description] = JSON.parse(l) as [number, string, string | null];
        return { number, title, description };
      });
  },
  setMilestone: async (repo, number, title) => {
    gh(["issue", "edit", String(number), "--repo", repo, "--milestone", title]);
  },
};

const USAGE = `rungate plan-issues (--repair | --decompose) <plan.md> --repo <owner/name> [--write] [--json]

  --repair     an approved repair plan. A table of
               | Issue | Phase | Repair | Criteria | Confidence | Why |
               where Repair is (a) annotate or (b) demote.
  --milestone-prefix <family> --spec <family spec>
               with --repair: also move each (a) row's issue into
               <family> Phase N, the phase its Phase column names. Only rows
               whose criteria the family spec places are moved; a phase with
               no milestone, or a Phase column the spec disagrees with,
               refuses the run before anything is written.
  --decompose  a decomposition plan — step 4 of ADR-003. A table of
               | Criterion | Outcome | Files | Milestone | Blocked by |
               where one row is one issue proving one criterion.
  --repo       owner/name. Defaults to $GITHUB_REPOSITORY.
  --write      apply it. Without this nothing is mutated.
  --json       the whole reading.

rungate plan-issues --place --repo <owner/name> [--write] [--json] [--project-root <dir>]

  Move each open issue into the phase milestone its criteria hold, read from
  every spec that opts in with board: { scope: active, prefix } (SC-2779).
  Criteria in one phase of one family: moved there, from no milestone or from
  another of that family's phases. No milestone and several phases: the
  lowest. Left where it is, and named: criteria from two families, a
  milestone plus several phases, a milestone outside the family, a criterion
  placed outside every phase, or an issue that says it serves no criterion.
  A phase with no milestone, or a spec the run cannot read, refuses the run
  before anything is written; plan-spec makes milestones, this never does.

rungate plan-issues --families [--project-root <dir>]

  Print each opted-in family as <prefix><TAB><spec path>, one per line and
  nothing else on stdout — the list a workflow loops plan-spec and plan-deps
  over. The same reading --place takes, so the two never disagree; it refuses
  on the same unreadable specs. Reads no tracker.

rungate plan-issues --accepted-since <commit> [--project-root <dir>]

  Print each docs/adr/*.md that is accepted now and was not at <commit>, and
  that carries a Decomposition table — one path per line, nothing else on
  stdout. Reads git only; touches no tracker. Used by adr-accepted.yml.

rungate plan-issues --accepted-since-last-run <workflow.yml> [--repo <owner/name>] [--project-root <dir>]

  The same list, from the head of <workflow.yml>'s newest successful run whose
  head commit is on this checkout's history (ADR-022: a run started by
  workflow_run carries no before sha). No successful run, none on this
  history, or runs that cannot be read: UNMEASURED, and nothing is listed.`;

/** What creating issues from a plan needs. Injected so a test never shells out. */
export interface DecomposeGitHub {
  /** Title → number for every OPEN issue. The idempotence key. */
  openTitles: (repo: string) => Promise<Map<string, number>>;
  /** Title → number for every CLOSED issue, so finished work is never re-filed (SC-2738). */
  closedTitles: (repo: string) => Promise<Map<string, number>>;
  /** Milestone titles that exist. `plan-spec` makes them; this never does. */
  milestones: (repo: string) => Promise<Set<string>>;
  create: (
    repo: string,
    /**
     * `label` is the work-queue label from `readQueueLabel`, or `null` when
     * the project configures none. It is part of CREATION rather than a
     * later edit because #1727 is what a later edit looks like: seven
     * issues arrived on 2026-11-02 without it and `queue-label` fell MET
     * 12 of 12 → 5 of 12, repaired by seven `gh issue edit` calls by hand.
     */
    issue: { title: string; body: string; milestone: string | null; label: string | null },
  ) => Promise<number>;
  addBlockedBy: (repo: string, blocked: number, blocker: number) => Promise<void>;
  /**
   * The issues already blocking `issue`. The idempotence key for EDGES, and
   * the counterpart to `openTitles` for issues — without it a re-run has one
   * safe half and one unsafe one. See the edge pass in `decompose`.
   */
  blockedBy: (repo: string, issue: number) => Promise<number[]>;
  /**
   * #2339: the state of each issue a plan names by `#<n>`. A number that is
   * not an issue — never existed, deleted, or a pull request — is absent from
   * the map; any other failed read throws, and the run refuses UNMEASURED.
   */
  issueStates: (repo: string, numbers: readonly number[]) => Promise<Map<number, "open" | "closed">>;
}

function issueTitles(repo: string, state: "open" | "closed"): Map<string, number> {
  const out = gh([
    "api",
    "--paginate",
    `repos/${repo}/issues?state=${state}&per_page=100`,
    "--jq",
    ".[] | select(.pull_request == null) | [.number, .title, .state_reason, .author_association, .user.login, .user.type, .body] | @json",
  ]);
  return issueTitleMap(out, state);
}

/**
 * Title to number, from the lines `issueTitles` reads, one JSON array per
 * issue. A closed issue is kept only where `closedIssueCounts` says the close
 * is finished work, which since #2953 includes an issue the plan itself filed
 * as the workflow bot: login, type and body are read for that.
 */
export function issueTitleMap(out: string, state: "open" | "closed"): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue;
    const [number, title, state_reason, author_association, user_login, user_type, body] = JSON.parse(line) as [
      number,
      string,
      string | null,
      string,
      string,
      string,
      string | null,
    ];
    if (state === "closed" && !closedIssueCounts({ state_reason, author_association, user_login, user_type, body })) continue;
    // The FIRST number seen for a title is kept. Two closed issues sharing a
    // title are both finished work; which one a blocked row points at does
    // not change what it waits for.
    if (!map.has(title)) map.set(title, number);
  }
  return map;
}

const LIVE_DECOMPOSE: DecomposeGitHub = {
  /**
   * Every open issue, PAGINATED.
   *
   * `gh issue list --limit 1000` stops at a thousand and says nothing about
   * it, and this map is the idempotence key: a title past the cutoff reads as
   * "not created yet", so `--write` files a duplicate of an issue that
   * already exists. That is the module's own "a shorter list looks like a
   * clean plan" failure, arriving on the tracker-read side instead of the
   * plan-read side. Found by the AI review of this change.
   *
   * `--paginate` walks every page, and the REST issues endpoint returns pull
   * requests too, so anything carrying `pull_request` is dropped — a PR whose
   * title matched a row would otherwise read as the issue already existing
   * and skip creating it.
   */
  openTitles: async repo => issueTitles(repo, "open"),
  /**
   * The same read, for closed issues, kept only where `closedIssueCounts`
   * says the close is finished work, by a trusted author or by the plan (#2953).
   */
  closedTitles: async repo => issueTitles(repo, "closed"),
  /**
   * Every milestone, PAGINATED, for a worse reason than `openTitles` above.
   *
   * A first page of 100 is not a reading of the milestones that exist; it is
   * a reading of the first hundred. A milestone on page two then reads as
   * ABSENT, and `planDecomposition` refuses the plan telling you to run
   * `plan-spec` so the placement table creates it — so the remedy the
   * message names is "create a milestone that already exists". A refusal is
   * the safe DIRECTION and this one still hands you a duplicate.
   *
   * Found by the AI review of this change, as the sibling of `openTitles`:
   * the first fix left the second site, which is the shape
   * `.claude/rules/checks-must-be-able-to-fail.md` calls out as only
   * catchable by asserting the property across sites.
   */
  milestones: async repo => {
    const out = gh([
      "api",
      "--paginate",
      `repos/${repo}/milestones?state=all&per_page=100`,
      "--jq",
      // `@json` and not a bare `.title`, for the same reason `openTitles`
      // uses it: a title containing a newline would otherwise arrive as two
      // milestones, neither of which exists.
      ".[] | [.title] | @json",
    ]);
    const titles = new Set<string>();
    for (const line of out.split("\n")) {
      if (line.trim() === "") continue;
      titles.add((JSON.parse(line) as [string])[0]);
    }
    return titles;
  },
  create: async (repo, issue) => {
    const args = ["issue", "create", "--repo", repo, "--title", issue.title, "--body-file", "-"];
    if (issue.milestone !== null) args.push("--milestone", issue.milestone);
    if (issue.label !== null) args.push("--label", issue.label);
    const url = gh(args, issue.body).trim();
    const n = Number(url.split("/").pop());
    // A URL whose last segment is not a number means `gh` printed something
    // else — a warning, a prompt — and treating NaN as an issue number would
    // wire every edge to nothing and report success.
    if (!Number.isInteger(n) || n <= 0) throw new Error(`created, but could not read a number from: ${url}`);
    return n;
  },
  issueStates: async (repo, numbers) => {
    const out = new Map<number, "open" | "closed">();
    for (const n of numbers) {
      let raw: string;
      try {
        raw = gh([
          // single resource: one issue by its number, not a list — there is no second page.
          "api",
          `repos/${repo}/issues/${n}`,
          "--jq",
          "[.state, (.pull_request != null)] | @json",
        ]);
      } catch (e) {
        // Absent (404) and deleted (410) both mean "not an issue here"; a
        // rate limit or a network error is not an answer and must throw.
        if (/HTTP 404|HTTP 410|Not Found/i.test((e as Error).message)) continue;
        throw e;
      }
      const [state, isPull] = JSON.parse(raw) as [string, boolean];
      if (isPull) continue;
      out.set(n, state === "closed" ? "closed" : "open");
    }
    return out;
  },
  addBlockedBy: async (repo, blocked, blocker) => {
    // REST, not `issue edit --add-blocked-by`, which an older runner's gh lacks (#2345).
    addBlockers(repo, blocked, [blocker], args => gh([...args]), BLOCKER_IDS);
  },
  blockedBy: async (repo, issue) => {
    const out = gh([
      "api",
      "--paginate",
      `repos/${repo}/issues/${issue}/dependencies/blocked_by?per_page=100`,
      "--jq",
      ".[].number",
    ]);
    return out
      .split("\n")
      .filter(l => l.trim() !== "")
      .map(Number);
  },
};

/**
 * Step 4: create the issues a reviewed plan names, then wire their order.
 *
 * Two passes, and the order is the point: a row may be blocked by another row
 * in the same plan, which has no number until it exists. Creating and wiring
 * in one pass would silently drop every forward reference — AGENTS.md rule 4
 * says ordering is data, and an edge that was never written is not data.
 */
/**
 * THE one place a `decompose()` refusal is reported, in whichever form the
 * caller asked for.
 *
 * `--json` documents itself as "the whole reading", and all three refusal
 * paths printed prose to stderr and nothing to stdout — so a caller parsing
 * stdout got a parse error instead of the `unmeasuredReasons` it came for,
 * and the structured half of the contract was missing exactly when there was
 * something to report. The `--repair` path already branched on `values.json`;
 * these did not. Found by the AI review of #1674.
 *
 * It lives at module scope rather than inside `decompose()` so that
 * "`decompose()` prints no refusal of its own" is a property a scan can state
 * plainly — the review's standing finding about this file is that this class
 * of bug kept being repaired one call site at a time, and a nested helper
 * would put the one legitimate printer inside the population being checked.
 */
export function refusalReporter(
  json: boolean,
): (
  headline: string,
  reasons: readonly string[],
  rejected?: readonly { line: number; why: string; text: string }[],
) => number {
  return (headline, reasons, rejected = []) => {
    if (json) {
      console.log(
        JSON.stringify({ reading: "UNMEASURED", unmeasuredReasons: reasons, rejected }, null, 2),
      );
    } else {
      console.error(`plan-issues: ${headline}`);
      for (const r of reasons) console.error(`  - ${r}`);
      for (const r of rejected) console.error(`  line ${r.line}: ${r.why}\n    ${r.text}`);
    }
    return REFUSAL_EXIT;
  };
}

/**
 * Which ADRs did the change since `since` accept? (SC-2738)
 *
 * A commit this clone cannot read REFUSES. A shallow checkout reading every
 * ADR as absent at the earlier commit would list every accepted ADR in the
 * repository, and the workflow would re-run all of their plans.
 */
/** Where the range starts is decided in `lib/last-successful-run.ts` (SC-2787), shared with close-merged-references (#2522). */
async function acceptedSinceLastRun(root: string, repo: string, workflowFile: string, api: RunsGitHub): Promise<number> {
  const start = await lastSuccessfulRunStart(api, repo, workflowFile, root);
  if ("why" in start) {
    console.error(`plan-issues: UNMEASURED — ${workflowFile}: ${start.why}. Nothing is listed.`);
    return REFUSAL_EXIT;
  }
  console.error(
    `plan-issues: reading what was accepted since run ${start.run} (${start.sha.slice(0, 12)}), the newest successful run of ${workflowFile} on this branch` +
      (start.skipped > 0 ? `; ${start.skipped} newer run(s) had a head not on it` : "") +
      ".",
  );
  return acceptedSince(root, start.sha);
}

function acceptedSince(root: string, since: string): number {
  const git = (...args: string[]) => spawnSync("git", ["-C", root, ...args], { encoding: "utf-8" });
  if (git("cat-file", "-e", `${since}^{commit}`).status !== 0) {
    console.error(
      `plan-issues: UNMEASURED — commit ${since} is not in this clone, so what it held could not be read. ` +
        `Nothing is listed. A shallow checkout needs fetch-depth: 0.`,
    );
    return REFUSAL_EXIT;
  }
  const dir = join(root, "docs", "adr");
  const names = existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith(".md")).sort() : [];
  for (const name of names) {
    const path = `docs/adr/${name}`;
    const after = readFileSync(join(root, path), "utf-8");
    const was = git("cat-file", "-e", `${since}:${path}`).status === 0 ? git("show", `${since}:${path}`) : null;
    if (was !== null && was.status !== 0) {
      console.error(`plan-issues: UNMEASURED — could not read ${path} at ${since}: ${was.stderr.trim()}`);
      return REFUSAL_EXIT;
    }
    // Accepted by this push, or accepted already with rows added (#2366):
    // decompose files only the rows that have no issue yet.
    if (adrPlacement(was === null ? null : was.stdout, after).kind === "none") continue;
    if (hasDecompositionTable(after)) console.log(path);
    else console.error(`plan-issues: ${path} was accepted, and carries no Decomposition table — nothing to place.`);
  }
  return 0;
}

async function decompose(
  planPath: string,
  /**
   * How the plan is NAMED in the issues this creates, which is a different
   * need from how it is read. `planPath` is absolute because `readFileSync`
   * requires it; a body that quotes it records one machine's filesystem in
   * the artefact the pipeline exists to make readable by somebody else.
   */
  planLabel: string,
  repo: string,
  write: boolean,
  json: boolean,
  api: DecomposeGitHub,
  /**
   * The work-queue label to stamp on everything created, or `null`. Passed
   * in rather than read here so a test can state both worlds without a
   * config fixture on disk.
   */
  queueLabel: string | null,
  /** Where `specs/` is read from, for the criterion ids a row may name. */
  root: string,
): Promise<number> {
  const refuse = refusalReporter(json);

  const reading = parseDecompositionPlan(readFileSync(planPath, "utf-8"));
  if (reading.reading === "UNMEASURED") {
    return refuse(
      `UNMEASURED — the decomposition plan could not be read:`,
      reading.unmeasuredReasons,
      reading.rejected,
    );
  }

  // The two pre-flight reads were the only `api.*` calls in this function
  // with no try/catch, so a rate limit or a network blip left `decompose()`
  // throwing a stack out of `main()` instead of reporting UNMEASURED the way
  // every other refusal here does. A command that crashes and a command that
  // refuses are different facts, and only one of them says what to do next.
  // Found by the AI review of this change.
  // The ids a row may name. An unreadable sweep refuses: an empty id set is
  // what a repository with no criteria produces, and reading it as one would
  // refuse every row for the wrong reason (or, inverted, accept them all).
  const sweep = specCriteriaIn(root);
  if (sweep.reading === "UNMEASURED") {
    return refuse(
      `UNMEASURED — the criterion ids under ${join(root, "specs")} could not be read, so no row's criterion could be checked:`,
      [...sweep.unmeasuredReasons],
    );
  }
  // An id two specs both state is still STATED; it is ambiguous for the board
  // column, not absent.
  const statedCriteria = new Set(answerableIds(sweep));

  // #2339: only the numbers this plan names, and only when it names any.
  const named = [
    ...new Set(
      reading.rows
        .flatMap(r => [...r.blockedBy, ...(r.blocks ?? [])])
        .filter(b => /^#\d+$/.test(b))
        .map(b => Number(b.slice(1))),
    ),
  ];
  let live;
  try {
    live = {
      openTitles: await api.openTitles(repo),
      closedTitles: await api.closedTitles(repo),
      milestones: await api.milestones(repo),
      statedCriteria,
      namedIssues: named.length > 0 ? await api.issueStates(repo, named) : new Map<number, "open" | "closed">(),
    };
  } catch (e) {
    return refuse(`UNMEASURED — could not read the tracker, so the plan was not applied:`, [
      (e as Error).message,
      `Nothing was created. Re-run when the read succeeds.`,
    ]);
  }
  const planned = planDecomposition(reading.rows, live, planLabel, CRITERIA_HEADING);
  if (planned.reading === "UNMEASURED") {
    return refuse(`UNMEASURED — the plan does not fit the tracker:`, planned.unmeasuredReasons);
  }

  /** Outcome → number, grown as issues are created, so pass two can resolve. */
  const numbers = new Map<string, number>();
  for (const a of planned.actions) if (a.kind !== "create") numbers.set(a.row.outcome, a.number);

  const created: { title: string; number: number }[] = [];
  const failed: string[] = [];
  if (write) {
    for (const a of planned.actions) {
      if (a.kind !== "create") continue;
      try {
        const n = await api.create(repo, {
          title: a.title,
          body: a.body,
          milestone: a.row.milestone,
          label: queueLabel,
        });
        numbers.set(a.row.outcome, n);
        created.push({ title: a.title, number: n });
      } catch (e) {
        failed.push(`${a.title}: ${(e as Error).message}`);
      }
    }
  }

  const edges: string[] = [];
  /**
   * Edges already on the tracker, read once per blocked issue.
   *
   * Without this the re-run story had a safe half and an unsafe one: an
   * issue that already exists is skipped by `openTitles`, but every edge was
   * re-issued unconditionally. Measured against the live API on 2026-10-30 —
   * re-adding an existing edge exits 1 with "Validation failed: Target issue
   * has already been taken", which `gh()` turns into a throw — so a perfectly
   * clean re-run reported every correctly-wired edge as a FAILED edge and the
   * command refused. The tracker was right and the report was wrong, which is
   * the worse direction: it is the reading somebody acts on. Found by the AI
   * review of this change.
   */
  const alreadyWired: string[] = [];
  const existing = new Map<number, Set<number>>();
  if (write) {
    // Either end may be an existing issue (#2339: a Blocks cell puts one on
    // the BLOCKED end), so both ends resolve the same way.
    const end = (x: string): number | undefined => (/^#\d+$/.test(x) ? Number(x.slice(1)) : numbers.get(x));
    for (const e of planned.edges) {
      const blocked = end(e.blocked);
      const blocker = end(e.blocker);
      if (blocked === undefined || blocker === undefined) {
        // One end was never created, because its creation failed above. Say
        // so: a missing edge that nothing reports is an order silently lost.
        failed.push(`edge "${e.blocked}" blocked by "${e.blocker}": one end does not exist`);
        continue;
      }
      try {
        if (!existing.has(blocked)) existing.set(blocked, new Set(await api.blockedBy(repo, blocked)));
        if (existing.get(blocked)!.has(blocker)) {
          // Reported apart from `edges`, never folded into it: "we wired this"
          // and "this was already wired" are different facts, and a re-run
          // that claims to have written what it found is how a plan appears
          // to have been applied twice.
          alreadyWired.push(`#${blocked} already blocked by #${blocker}`);
          continue;
        }
        await api.addBlockedBy(repo, blocked, blocker);
        existing.get(blocked)!.add(blocker);
        edges.push(`#${blocked} blocked by #${blocker}`);
      } catch (err) {
        failed.push(`edge #${blocked} blocked by #${blocker}: ${(err as Error).message}`);
      }
    }
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          reading: "MEASURED",
          plan: planPath,
          wouldCreate: planned.actions.filter(a => a.kind === "create").length,
          alreadyOpen: planned.actions.filter(a => a.kind === "exists").length,
          alreadyClosed: planned.actions.filter(a => a.kind === "closed").length,
          wrote: write,
          created,
          edges,
          alreadyWired,
          failed,
        },
        null,
        2,
      ),
    );
    return failed.length > 0 ? REFUSAL_EXIT : 0;
  }

  for (const a of planned.actions) {
    if (a.kind === "exists") console.log(`  open    #${a.number}  ${a.row.outcome}`);
    else if (a.kind === "closed") console.log(`  closed  #${a.number}  ${a.row.outcome}`);
    else console.log(`  create  ${a.row.criterion.padEnd(8)}  ${a.title}`);
  }
  const shown = (x: string): string => (/^#\d+$/.test(x) ? x : `"${x}"`);
  for (const e of planned.edges) console.log(`  order   ${shown(e.blocked)} blocked by ${shown(e.blocker)}`);
  if (!write) {
    console.log(`\nNothing written. Re-run with --write to apply.`);
    return 0;
  }
  console.log(
    `\nCreated ${created.length}, wired ${edges.length} edge(s), ` +
      `${alreadyWired.length} edge(s) already present.`,
  );
  for (const w of alreadyWired) console.log(`  kept    ${w}`);
  for (const f of failed) console.error(`  FAILED: ${f}`);
  return failed.length > 0 ? REFUSAL_EXIT : 0;
}

/** What one row would do, resolved against the issue's live state. */
interface Action {
  row: RepairRow;
  kind: "annotate" | "demote" | "unchanged" | "refused" | "place" | "skip";
  body?: string;
  /** For a placement: the milestone title the issue moves into (#2042). */
  milestone?: string;
  /** For a demotion: every edge the demotion orphans. */
  edges: { blocked: number; blocker: number }[];
  note: string;
}

/**
 * Why a spec's placement table cannot place anything — #2072, and SC-2779.
 *
 * THE one decider, read by `--milestone-prefix` and `--place` alike, so the
 * two cannot disagree about whether a table is usable (review of #2315). The
 * three readings `plan-spec` and `board-snapshot` already refuse: a doubled id
 * goes to whichever row comes last, an unknown one reads as two families at
 * once, and an unrecognised value is neither a phase nor a known non-phase.
 * `unplaced` is left out on purpose: a criterion in no row has no phase, and
 * each caller already skips, refuses or leaves an issue naming one.
 */
export function unsoundPlacement(placement: ReturnType<typeof placementReading>): string[] {
  return [
    ...placement.doubled.map(d => `${d.id} is placed twice: ${d.placements.join(" and ")}`),
    ...placement.unknown.map(id => `${id} is placed but stated nowhere in the spec`),
    ...placement.unrecognised.map(p => `"${p}" is neither a phase nor a known non-phase placement`),
  ];
}

/** What `--place` needs from the tracker. Injected so a test never shells out. */
export interface PlaceGitHub {
  /** Every milestone, open or closed — the same paginated read `--repair` uses. */
  milestones: (repo: string) => Promise<LiveMilestone[]>;
  /** Every OPEN issue, through the one reader the board readings use. */
  openIssues: (repo: string) => Promise<{ number: number; title: string; body: string | null; milestone: string | null }[]>;
  setMilestone: (repo: string, number: number, title: string) => Promise<void>;
}

/** Each blocker's database id, read once per run however many issues it blocks (#2345). */
const BLOCKER_IDS = new Map<string, number>();

export const LIVE_PLACE: PlaceGitHub = {
  milestones: LIVE_GITHUB.milestones,
  openIssues: async repo => (await readLiveIssues(repo, false)).filter(i => i.state === "OPEN"),
  setMilestone: LIVE_GITHUB.setMilestone,
};

/**
 * Every opted-in family, with the milestone each placed phase has — SC-2779.
 *
 * The families are the specs whose frontmatter says
 * `board: { scope: active, prefix }` (SC-2776); there is no list in config.
 * Anything that would make the list partial refuses the whole run, by name: a
 * sweep that could not be read, a `board:` block the engine could not read
 * (that spec may be a family), a family's placement table that is missing or
 * unsound, or two specs claiming one prefix. A partial list is worse than
 * none, because the two-family rule is exactly the one that needs every
 * family in view.
 */
export function placingFamilies(
  root: string,
  live: readonly LiveMilestone[],
): { families: PlacingFamily[]; paths: string[]; specs: string[]; refusals: string[] } {
  const read = (base: string, path: string) => readFileSync(join(base, path), "utf-8");
  const sweep = placementCoverage(root, specPathSweep, read);
  if (sweep.reading === "UNMEASURED") return { families: [], paths: [], specs: [], refusals: sweep.unmeasuredReasons };
  const refusals: string[] = [];
  const families: PlacingFamily[] = [];
  const paths: string[] = [];
  const specs: string[] = [];
  const byPrefix = new Map<string, string>();
  for (const spec of sweep.specs) {
    if (spec.board.problems.length > 0) {
      refusals.push(`${spec.path}: its board: declaration cannot be read — ${spec.board.problems.join("; ")}`);
      continue;
    }
    const prefix = spec.board.settings.prefix;
    if (spec.board.scope !== "active" || prefix === undefined) continue;
    const other = byPrefix.get(prefix);
    if (other !== undefined) {
      refusals.push(`${spec.path} and ${other} both declare prefix ${prefix}, so its milestones belong to neither`);
      continue;
    }
    byPrefix.set(prefix, spec.path);
    const text = read(root, spec.path);
    const placement = placementReading(text);
    const unsound = [...placement.unmeasuredReasons, ...unsoundPlacement(placement)];
    if (unsound.length > 0) {
      refusals.push(`${spec.path} (${prefix}): its placement cannot place an issue — ${unsound.join("; ")}`);
      continue;
    }
    const milestones = new Map<number, string>();
    for (const a of milestonePlan(text, [...live], prefix).actions) if (a.existing) milestones.set(a.phase, a.existing.title);
    families.push({ prefix, stated: placement.criteria, placements: placementsById(text), milestones });
    paths.push(`${prefix}: ${spec.path}`);
    specs.push(spec.path);
  }
  return refusals.length > 0 ? { families: [], paths: [], specs: [], refusals } : { families, paths, specs, refusals: [] };
}

/** `--place`: the run SC-2780 calls, after `plan-spec` and before `plan-deps`. */
async function place(gh4: PlaceGitHub, root: string, repo: string, write: boolean, json: boolean): Promise<number> {
  // Both tracker reads refuse the way `decompose` does (review of #2315): a
  // rate limit or a network blip is an unreadable tracker, reported as such.
  const unreadable = (e: unknown): number => {
    console.error(`plan-issues --place: UNMEASURED — could not read the tracker, so nothing was placed:`);
    console.error(`  - ${(e as Error).message}`);
    return REFUSAL_EXIT;
  };
  let live: LiveMilestone[];
  try {
    live = await gh4.milestones(repo);
  } catch (e) {
    return unreadable(e);
  }
  const read = placingFamilies(root, live);
  if (read.refusals.length > 0) {
    console.error(`plan-issues --place: UNMEASURED — the opted-in families could not be read, so nothing was placed:`);
    for (const r of read.refusals) console.error(`  - ${r}`);
    return REFUSAL_EXIT;
  }
  let issues: Awaited<ReturnType<PlaceGitHub["openIssues"]>>;
  try {
    issues = (await gh4.openIssues(repo)).sort((a, b) => a.number - b.number);
  } catch (e) {
    return unreadable(e);
  }
  const moves: { issue: number; move: IssueMove }[] = issues.map(i => ({ issue: i.number, move: issuePlacement(i, read.families) }));
  const refused = moves.filter(m => m.move.kind === "refuse");
  const count = (k: IssueMove["kind"]) => moves.filter(m => m.move.kind === k).length;
  const results: string[] = [];
  if (write && refused.length === 0) {
    for (const m of moves) {
      if (m.move.kind !== "move") continue;
      try {
        await gh4.setMilestone(repo, m.issue, m.move.milestone);
        results.push(`placed    #${m.issue}  in "${m.move.milestone}"`);
      } catch (e) {
        results.push(`FAILED    #${m.issue}: ${(e as Error).message}`);
      }
    }
  }
  const failed = results.filter(r => r.startsWith("FAILED"));
  const blocked = refused.length > 0;
  if (json) {
    const wrote = !write ? "not-requested" : blocked ? "refused" : failed.length > 0 ? "partial" : "yes";
    console.log(JSON.stringify({ families: read.paths, moves, results, wrote }, null, 2));
    return blocked || failed.length > 0 ? REFUSAL_EXIT : 0;
  }
  console.log(`plan-issues --place — ${read.families.length} opted-in famil${read.families.length === 1 ? "y" : "ies"}, ${issues.length} open issue(s)`);
  for (const p of read.paths) console.log(`  ${p}`);
  if (read.families.length === 0) console.log(`  No spec opts in with board: { scope: active, prefix }, so no issue has a phase.`);
  const mark = { move: "MOVE    ", stay: "", left: "LEFT    ", none: "", refuse: "REFUSED " } as const;
  console.log(`\nACTIONS`);
  for (const m of moves) if (mark[m.move.kind] !== "") console.log(`  ${mark[m.move.kind]}  #${m.issue}  ${"why" in m.move ? m.move.why : ""}`);
  console.log(
    `\n  ${count("move")} to move, ${count("stay")} already placed, ${count("left")} left where they are, ` +
      `${count("none")} name no opted-in criterion, ${count("refuse")} refused`,
  );
  if (blocked) {
    console.error(`\nplan-issues --place: ${refused.length} issue(s) belong in a phase with no milestone, so nothing was written.`);
    return REFUSAL_EXIT;
  }
  if (!write) {
    console.log(`\nNothing written. Re-run with --write to apply.`);
    return 0;
  }
  console.log(`\nWRITING`);
  for (const r of results) console.log(`  ${r}`);
  if (failed.length > 0) {
    console.error(`\nplan-issues --place: ${failed.length} move(s) FAILED.`);
    return REFUSAL_EXIT;
  }
  return 0;
}

export async function main(
  argv: string[],
  gh2: PlanIssuesGitHub = LIVE_GITHUB,
  gh3: DecomposeGitHub = LIVE_DECOMPOSE,
  gh4: PlaceGitHub = LIVE_PLACE,
  gh5: RunsGitHub = LIVE_RUNS,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        repair: { type: "string" },
        decompose: { type: "string" },
        repo: { type: "string" },
        write: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        "project-root": { type: "string" },
        "accepted-since": { type: "string" },
        "accepted-since-last-run": { type: "string" },
        "milestone-prefix": { type: "string" },
        spec: { type: "string" },
        place: { type: "boolean", default: false },
        families: { type: "boolean", default: false },
      },
      allowPositionals: true,
    });
  } catch (e) {
    console.error(`plan-issues: ${(e as Error).message}\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }
  const { values } = parsed;
  if (values.families) {
    // A listing, not a plan: alone, so nothing it prints is mistaken for a write.
    if (values.place || values.repair || values.decompose || values["accepted-since"] !== undefined || values["accepted-since-last-run"] !== undefined || values["milestone-prefix"] !== undefined || values.spec !== undefined || values.write || values.json) {
      console.error(`plan-issues: --families lists the opted-in families and applies nothing — pass it alone, with --project-root at most\n\n${USAGE}`);
      return REFUSAL_EXIT;
    }
    // No milestones: which specs are families does not depend on the tracker.
    const read = placingFamilies(values["project-root"] ?? process.cwd(), []);
    if (read.refusals.length > 0) {
      console.error(`plan-issues --families: UNMEASURED — the opted-in families could not be read:`);
      for (const r of read.refusals) console.error(`  - ${r}`);
      return REFUSAL_EXIT;
    }
    for (const [i, fam] of read.families.entries()) console.log(`${fam.prefix}\t${read.specs[i]}`);
    return 0;
  }
  if (values.place) {
    // A third plan, read from the specs rather than from a file: one at a time.
    if (values.repair || values.decompose || values["accepted-since"] !== undefined || values["accepted-since-last-run"] !== undefined || values["milestone-prefix"] !== undefined || values.spec !== undefined) {
      console.error(`plan-issues: --place reads every opted-in spec itself — pass it with --repo, --write, --json and --project-root only\n\n${USAGE}`);
      return REFUSAL_EXIT;
    }
    const placeRepo = values.repo ?? process.env.GITHUB_REPOSITORY;
    if (!placeRepo) {
      console.error(`plan-issues: --repo is required (or set GITHUB_REPOSITORY)\n\n${USAGE}`);
      return REFUSAL_EXIT;
    }
    return await place(gh4, values["project-root"] ?? process.cwd(), placeRepo, values.write, values.json);
  }
  const lastRun = values["accepted-since-last-run"];
  if (lastRun !== undefined) {
    if (values.repair || values.decompose || values["accepted-since"] !== undefined) {
      console.error(`plan-issues: --accepted-since-last-run lists plans; it applies none — pass it alone\n\n${USAGE}`);
      return REFUSAL_EXIT;
    }
    // A bare file name: it is interpolated into an API path.
    if (!WORKFLOW_FILE.test(lastRun)) {
      console.error(`plan-issues: --accepted-since-last-run needs a workflow file name such as adr-accepted.yml, not ${JSON.stringify(lastRun)}`);
      return REFUSAL_EXIT;
    }
    const runsRepo = values.repo ?? process.env.GITHUB_REPOSITORY;
    if (!runsRepo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(runsRepo)) {
      console.error(`plan-issues: --accepted-since-last-run needs --repo owner/name (or GITHUB_REPOSITORY)\n\n${USAGE}`);
      return REFUSAL_EXIT;
    }
    return acceptedSinceLastRun(values["project-root"] ?? process.cwd(), runsRepo, lastRun, gh5);
  }
  if (values["accepted-since"] !== undefined) {
    if (values.repair || values.decompose) {
      console.error(`plan-issues: --accepted-since lists plans; it applies none — pass it alone\n\n${USAGE}`);
      return REFUSAL_EXIT;
    }
    return acceptedSince(values["project-root"] ?? process.cwd(), values["accepted-since"]);
  }
  // Both would mean two plans in one run, and the second would be applied
  // against a tracker the first had already moved. One or the other.
  if (values.repair && values.decompose) {
    console.error(`plan-issues: --repair and --decompose are two different plans — pass one\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }
  const given = values.repair ?? values.decompose;
  if (!given) {
    console.error(`plan-issues: --repair <plan.md> or --decompose <plan.md> is required\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }
  if ((values["milestone-prefix"] !== undefined || values.spec !== undefined) && !values.repair) {
    console.error(`plan-issues: --milestone-prefix and --spec place a repair plan's rows — pass them with --repair\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }
  const repo = values.repo ?? process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error(`plan-issues: --repo is required (or set GITHUB_REPOSITORY)\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }
  const root = values["project-root"] ?? process.cwd();
  const planPath = isAbsolute(given) ? given : join(root, given);
  if (!existsSync(planPath)) {
    console.error(`plan-issues: no such plan: ${planPath}`);
    return REFUSAL_EXIT;
  }
  if (values.decompose) {
    // A plan OUTSIDE the project keeps its absolute path rather than being
    // spelled `../../tmp/…`: it genuinely is not a path in this repository,
    // and saying so is the honest reading. Only a plan inside the tree gets
    // the repo-relative name, because only that one is reproducible.
    // `relative()` signals "outside root" only when the result is exactly
    // `..` or begins with `..` AND a separator. A bare `startsWith("..")`
    // also catches `..config/plan.md`, which is a legal filename INSIDE the
    // root — and the consequence is the absolute path going into the issue
    // body, which is the leak this change exists to close. Found by the AI
    // review of this change.
    const within = relative(root, planPath);
    const escapes = within === ".." || within.startsWith(`..${sep}`);
    const planLabel = within === "" || escapes ? planPath : within;
    return await decompose(planPath, planLabel, repo, values.write, values.json, gh3, readQueueLabel(root), root);
  }

  // #2042: placement is opt-in per family and needs that family's spec — the
  // family names the milestones, the spec says which criteria each phase
  // holds. Settled before any issue is read.
  // The one reading of what a prefix argument said (`lib/live-issues.ts`),
  // so blank and absent are decided where plan-deps decides them.
  const prefixRead = readMilestonePrefix(values["milestone-prefix"]);
  const prefix = prefixRead.kind === "given" ? prefixRead.prefix : undefined;
  let familyPlan: MilestoneAction[] | null = null;
  let familyStated: Set<string> = new Set();
  if (prefixRead.kind !== "absent" || values.spec !== undefined) {
    if (prefix === undefined || values.spec === undefined) {
      console.error(
        `plan-issues: --milestone-prefix <family> and --spec <family spec> go together — the family ` +
          `names the milestones and the spec says which criteria each phase holds\n\n${USAGE}`,
      );
      return REFUSAL_EXIT;
    }
    const specPath = isAbsolute(values.spec) ? values.spec : join(root, values.spec);
    if (!existsSync(specPath)) {
      console.error(`plan-issues: no such spec: ${specPath}`);
      return REFUSAL_EXIT;
    }
    const specText = readFileSync(specPath, "utf-8");
    const placement = placementReading(specText);
    if (placement.reading === "UNMEASURED") {
      console.error(`plan-issues: UNMEASURED — ${values.spec} cannot place a row:`);
      for (const r of placement.unmeasuredReasons) console.error(`  - ${r}`);
      return REFUSAL_EXIT;
    }
    // #2072: the one decider `--place` reads too.
    const unsound = unsoundPlacement(placement);
    if (unsound.length > 0) {
      console.error(`plan-issues: ${values.spec}'s placement is unsound, so no row can be placed from it:`);
      for (const u of unsound) console.error(`  - ${u}`);
      return REFUSAL_EXIT;
    }
    familyStated = new Set(placement.criteria);
    familyPlan = milestonePlan(specText, await gh2.milestones(repo), prefix).actions;
  }

  const reading = parseRepairPlan(readFileSync(planPath, "utf-8"));

  // The refusal, decided BEFORE anything is written and read by every path.
  const refuseWrite = reading.reading === "UNMEASURED";

  if (refuseWrite && !values.json) {
    console.error(`plan-issues: UNMEASURED — the repair plan could not be read:`);
    for (const r of reading.unmeasuredReasons) console.error(`  - ${r}`);
    for (const r of reading.rejected) console.error(`  line ${r.line}: ${r.why}\n    ${r.text}`);
    return REFUSAL_EXIT;
  }

  const actions: Action[] = [];
  // A placement refusal stops the WHOLE run before any write, unlike a body
  // refusal, which stops only its row (#2042: "refused before anything is
  // written").
  const placementRefusals: Action[] = [];
  for (const row of reading.rows) {
    const live = await gh2.readIssue(repo, row.issue);
    if (row.kind === "annotate") {
      // Two sections means editing the first is a guess, and the second keeps
      // whatever stale ids it holds. Refuse the row by name.
      const bodyRefused = multiplyAnnotated(live.body);
      if (bodyRefused) {
        actions.push({
          row,
          kind: "refused",
          edges: [],
          note: `body carries "${CRITERIA_HEADING}" more than once — resolve it by hand`,
        });
      } else if (alreadyAnnotated(live.body, row.criteria)) {
        actions.push({ row, kind: "unchanged", edges: [], note: `already names ${row.criteria.join(", ")}` });
      } else {
        actions.push({
          row,
          kind: "annotate",
          body: annotatedBody(live.body, row.criteria),
          edges: [],
          note: `+ ${row.criteria.join(", ")}`,
        });
      }
      if (familyPlan !== null && bodyRefused) {
        // Review of #2069: moving the milestone while the criteria section
        // stays ambiguous leaves the tracker half-applied.
        actions.push({ row, kind: "skip", edges: [], note: "not placed: its body was refused above" });
      } else if (familyPlan !== null) {
        const p = rowPlacement(row, familyPlan, prefix!, familyStated);
        if (p.kind === "refuse") {
          const refused: Action = { row, kind: "refused", edges: [], note: `cannot place: ${p.why}` };
          actions.push(refused);
          placementRefusals.push(refused);
        } else if (p.kind === "skip") {
          actions.push({ row, kind: "skip", edges: [], note: p.why });
        } else if (live.milestone === p.milestone) {
          actions.push({ row, kind: "unchanged", edges: [], note: `already in "${p.milestone}"` });
        } else {
          actions.push({
            row,
            kind: "place",
            milestone: p.milestone,
            edges: [],
            note: `${live.milestone === null ? "no milestone" : `"${live.milestone}"`} → "${p.milestone}"`,
          });
        }
      }
      continue;
    }
    if (live.milestone === null) {
      actions.push({ row, kind: "unchanged", edges: [], note: "already carries no milestone" });
      continue;
    }
    actions.push({
      row,
      kind: "demote",
      edges: [
        ...live.blockedBy.map(b => ({ blocked: live.number, blocker: b })),
        ...live.blocking.map(b => ({ blocked: b, blocker: live.number })),
      ],
      note: `drop "${live.milestone}"`,
    });
  }

  if (values.json) {
    // Apply FIRST, then report what happened. The first version printed
    // `"wrote": "yes"` and only then called apply(), whose per-action catch
    // swallowed every failure into a string nothing read — so a run that
    // failed on all eleven rows emitted "yes" and exited 0. Fail-open status
    // reporting, caught by the security review of this PR.
    const blocked = refuseWrite || placementRefusals.length > 0;
    const results = values.write && !blocked ? await apply(gh2, repo, actions) : [];
    const failures = results.filter(r => r.startsWith("FAILED"));
    const refusedRows = actions.filter(a => a.kind === "refused");
    const wrote = !values.write
      ? "not-requested"
      : blocked
        ? "refused"
        : failures.length > 0 || refusedRows.length > 0
          ? "partial"
          : "yes";
    const placement = familyPlan === null ? "not-requested" : prefix;
    console.log(JSON.stringify({ ...reading, actions, results, wrote, placement }, null, 2));
    return blocked || failures.length > 0 || refusedRows.length > 0 ? REFUSAL_EXIT : 0;
  }

  const edges = actions.reduce((n, a) => n + a.edges.length, 0);
  console.log(`${values.repair} — ${reading.rows.length} row(s)\n`);
  console.log(`ACTIONS`);
  for (const a of actions) {
    const mark = {
      annotate: "ANNOTATE",
      demote: "DEMOTE  ",
      unchanged: "ok      ",
      refused: "REFUSED ",
      place: "PLACE   ",
      skip: "skip    ",
    }[a.kind];
    console.log(`  ${mark}  #${a.row.issue}  ${a.note}`);
    if (a.edges.length > 0) {
      console.log(`            and remove ${a.edges.length} edge(s) the demotion orphans:`);
      for (const e of a.edges) console.log(`              #${e.blocked} blocked by #${e.blocker}`);
    }
  }
  console.log(
    `\n  ${actions.filter(a => a.kind === "annotate").length} annotate, ` +
      `${actions.filter(a => a.kind === "demote").length} demote, ` +
      `${actions.filter(a => a.kind === "place").length} place, ` +
      `${actions.filter(a => a.kind === "unchanged").length} already correct, ${edges} edge(s) to remove`,
  );
  if (familyPlan === null && reading.rows.some(r => r.kind === "annotate")) {
    console.log(
      `\n  The Phase column was not applied — no milestone is moved without ` +
        `--milestone-prefix <family> --spec <family spec>.`,
    );
  }
  if (placementRefusals.length > 0) {
    console.error(
      `\nplan-issues: ${placementRefusals.length} row(s) cannot be placed, so nothing was written. ` +
        `Fix the plan or the spec and re-run.`,
    );
    return REFUSAL_EXIT;
  }

  if (!values.write) {
    console.log(`\nNothing written. Re-run with --write to apply.`);
    return 0;
  }
  console.log(`\nWRITING`);
  const applied = await apply(gh2, repo, actions);
  for (const line of applied) console.log(`  ${line}`);
  const failed = applied.filter(r => r.startsWith("FAILED"));
  const refusedRows = actions.filter(a => a.kind === "refused");
  console.log(
    `\n  Then re-run both, in this order — a demotion changes the phase sizes and\n` +
      `  the board column is a mirror of the body, not a second source:\n` +
      `    rungate plan-deps --repo ${repo} --milestone-prefix <name> --write\n` +
      // `--milestone-prefix` is REQUIRED since #1728, so the command this
      // used to print now refuses — a follow-up that cannot run is worse
      // than none, because the reader learns the advice is stale only
      // after acting on it.
      //
      // A PLACEHOLDER, not a filled-in value, and the same shape as
      // `<id>` below. A repair knows the milestones it DEMOTED; the
      // family `plan-deps` must sequence is the one holding the issues
      // that stayed, and this command never reads them. Guessing from
      // the demoted rows would be right whenever the repair touched one
      // family and silently wrong exactly when it did not — which is the
      // case the flag exists for.
      //
      // NO `--spec`. Narrowing the sweep while WRITING blanks the Criteria
      // cell of every issue serving any other spec — SC-2610 — so a printed
      // command carrying it hands the reader the defect as advice.
      `    rungate board-mirror --project <id> --ready --write`,
  );
  if (failed.length > 0 || refusedRows.length > 0) {
    console.error(
      `\nplan-issues: ${failed.length} action(s) FAILED and ${refusedRows.length} row(s) were refused.`,
    );
    return REFUSAL_EXIT;
  }
  return 0;
}

/**
 * The ONE write site, called by both output paths.
 *
 * The edge removal runs BEFORE the milestone is cleared. If it ran after and
 * then failed, the issue would already be out of its phase and nothing — not
 * this command on a re-run, not `plan-deps` — would still know which edges
 * the demotion had orphaned.
 */
async function apply(gh2: PlanIssuesGitHub, repo: string, actions: readonly Action[]): Promise<string[]> {
  const done: string[] = [];
  for (const a of actions) {
    try {
      if (a.kind === "annotate") {
        await gh2.setBody(repo, a.row.issue, a.body!);
        done.push(`annotated #${a.row.issue}  ${a.row.criteria.join(", ")}`);
      } else if (a.kind === "demote") {
        for (const e of a.edges) await gh2.removeBlockedBy(repo, e.blocked, e.blocker);
        await gh2.clearMilestone(repo, a.row.issue);
        done.push(`demoted   #${a.row.issue}  and removed ${a.edges.length} edge(s)`);
      } else if (a.kind === "place") {
        await gh2.setMilestone(repo, a.row.issue, a.milestone!);
        done.push(`placed    #${a.row.issue}  in "${a.milestone}"`);
      }
    } catch (e) {
      done.push(`FAILED    #${a.row.issue}: ${(e as Error).message}`);
    }
  }
  return done;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
