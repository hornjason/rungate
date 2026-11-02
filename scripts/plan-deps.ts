#!/usr/bin/env bun
/**
 * Write a spec's phase order onto the tracker as `blocked by` edges (#1647).
 *
 * Step 5 of `docs/adr/ADR-003-spec-to-tracker-mapping.md`. `plan-spec` turns
 * the spec's *Phase placement* table into milestones; this turns the order of
 * those milestones into edges, so *what can I pick up* is a question GitHub
 * can answer instead of one a person answers by reading phase numbers.
 *
 * ## It reports by default and writes only when told
 *
 * No `--write`, no mutation. The reading is the product: which edges are
 * missing, which are already there, and which exist that this did not derive.
 *
 * ## It never deletes an edge, and the third set is why
 *
 * `EXTRA` is an edge present on the tracker that the phase order does not
 * imply. Two are live and both are real — #1481 blocked by #1591, #1659
 * blocked by #1658 — and both are WITHIN a phase, which is the one ordering a
 * phase sequence cannot express. Reconciling by deletion would destroy the
 * only hand-authored dependencies in the repository, so this prints them and
 * stops. See `lib/spec-deps.ts`.
 *
 * ## Why one call per blocked issue
 *
 * `gh issue edit <N> --add-blocked-by <M>` takes the flag repeatedly. The
 * live convergence set is 194 edges over 37 blocked issues, so grouping is
 * 37 mutations rather than 194. `groupByBlocked` decides the grouping and is
 * tested on its own, because the group IS what reaches GitHub.
 */
import { parseArgs } from "util";
import { createGitHubClient } from "../lib/github";
import { dependencyPlan, groupByBlocked } from "../lib/spec-deps";
import type { DepEdge, DepIssue } from "../lib/spec-deps";
import { ghWithoutGhToken, readLiveIssues } from "../lib/live-issues";

/**
 * THE one non-zero exit. One site, so `test/plan-deps.test.ts` can build a
 * mutant with it set to `0` and prove each refusal is what the case observed
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
export const REFUSAL_EXIT = 1;

export interface PlanDepsGitHub {
  createClient: typeof createGitHubClient;
  /** Every open-or-closed issue with a milestone, and its live blockers. */
  readIssues: (client: unknown, repo: string, includeClosed: boolean) => Promise<DepIssue[]>;
  /** Apply one blocked issue's missing blockers. Resolves on success. */
  addBlockers: (repo: string, blocked: number, blockers: readonly number[]) => Promise<void>;
}

async function liveAddBlockers(
  repo: string,
  blocked: number,
  blockers: readonly number[],
): Promise<void> {
  const args = ["issue", "edit", String(blocked), "--repo", repo];
  for (const b of blockers) args.push("--add-blocked-by", String(b));
  ghWithoutGhToken(args);
}

const LIVE_GITHUB: PlanDepsGitHub = {
  createClient: createGitHubClient,
  readIssues: (_client, repo, includeClosed) => readLiveIssues(repo, includeClosed),
  addBlockers: liveAddBlockers,
};

const USAGE = `rungate plan-deps --repo <owner/name> [--write] [--json] [--include-closed]
                              [--milestone-prefix <name>]

  --repo              owner/name. Defaults to $GITHUB_REPOSITORY.
  --write             apply the missing edges. Without it, nothing is mutated.
  --json              the whole plan, for something other than a person.
  --include-closed    derive edges to closed issues too. Off by default: a
                      closed issue can never block anything, so the edge is a
                      row on a card that changes no decision.
  --milestone-prefix  consider only issues whose milestone TITLE starts with
                      this, e.g. "Pipeline". A phase number is read out of the
                      title and nothing else, so two specs that both numbered
                      their phases put unrelated issues in the same phase and
                      get sequenced against each other. Pass this whenever the
                      repository carries more than one spec's milestones.`;

export async function main(argv: string[], gh: PlanDepsGitHub = LIVE_GITHUB): Promise<number> {
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
      },
      allowPositionals: true,
    });
  } catch (e) {
    console.error(`plan-deps: ${(e as Error).message}\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }

  const { values } = parsed;
  const repo = values.repo ?? process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error(`plan-deps: --repo is required (or set GITHUB_REPOSITORY)\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }

  const client = gh.createClient();
  const read = await gh.readIssues(client, repo, values["include-closed"]);

  // Narrow the POPULATION, not the edges. The derivation is right about the
  // order it is handed; what it is handed has to be one spec's issues. An
  // issue with no milestone is out by the same test — `startsWith` on a
  // missing title is not a match, and it would be `unphased` anyway.
  const prefix = values["milestone-prefix"];
  const issues = prefix === undefined ? read : read.filter(i => (i.milestone ?? "").startsWith(prefix));

  // A prefix that matched nothing is its own reading, and it has to say so
  // here: `degenerateReasons` would report "no issues were read — an empty
  // repository and a failed fetch produce the same empty edge list", which
  // is false when four issues were read and the filter took them. A typo in
  // the prefix is the likeliest way to arrive here, and that sentence sends
  // the reader to the API.
  if (prefix !== undefined && issues.length === 0 && read.length > 0) {
    console.error(
      `plan-deps: UNMEASURED — ${read.length} issue(s) were read and NONE carries a milestone ` +
        `starting "${prefix}". That is a prefix matching nothing, not a repository with no issues.`,
    );
    return REFUSAL_EXIT;
  }

  const plan = dependencyPlan(issues, { includeClosed: values["include-closed"] });

  // The refusal, decided BEFORE anything is written. `plan-spec` shipped this
  // backwards once — it created eight milestones and THEN returned non-zero,
  // and an exit code cannot tell that apart from a refusal that stopped
  // something. One expression, read by every path below.
  const refuseWrite = plan.reading === "UNMEASURED";

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
    console.log(JSON.stringify({ ...plan, results, wrote }, null, 2));
    return refuseWrite || failures.length > 0 ? REFUSAL_EXIT : 0;
  }

  const scope =
    prefix === undefined
      ? ""
      : ` (of ${read.length}, narrowed to milestones starting "${prefix}")`;
  console.log(
    `${repo} — ${issues.length} issue(s) read${scope}, phases ${plan.phases.join(" -> ") || "(none)"}\n`,
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
      `\n  ${plan.extra.length} edge(s) this did not derive, LEFT ALONE — a dependency inside one\n` +
        `  phase is the ordering a phase sequence cannot express, and deleting it would\n` +
        `  destroy the only hand-authored edges in the repository:`,
    );
    for (const e of plan.extra) console.log(`    #${e.blocked} blocked by #${e.blocker}`);
  }

  console.log(`\n  Frontier: ${plan.frontier === null ? "nowhere — no open issue sits in a phase" : `Phase ${plan.frontier}`}`);
  if (plan.unphased.length > 0) {
    console.log(`  ${plan.unphased.length} issue(s) carry no Phase milestone and get no edge.`);
  }

  if (!values.write) {
    console.log(
      plan.missing.length > 0
        ? `\nNothing written. Re-run with --write to add ${plan.missing.length} edge(s) in ${groupByBlocked(plan.missing).length} call(s).`
        : `\nNothing written, and nothing to write — the tracker already carries the phase order.`,
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
