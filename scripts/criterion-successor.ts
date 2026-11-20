/**
 * File a successor for each criterion a closed issue leaves owed by nobody
 * (#2490, serving SC-2625).
 *
 * Usage:
 *   rungate criterion-successor --issue <N> [--repo owner/name] [--project-root <dir>] [--write]
 *   rungate criterion-successor --sweep [--repo owner/name] [--project-root <dir>] [--write]
 *
 * `--sweep` (#2541) asks about every owed criterion instead of one close's:
 * for the closes whose `closed` event the workflow missed. Each owed
 * criterion cites the most recent closed issue that names it, by the same
 * `criterionAnswer` the per-issue path reads. One that no such issue names is
 * left: there is nothing to succeed.
 *
 * The closed issues are read ONCE, through the core API, and matched locally
 * (#2546). A search per criterion tripped GitHub's ~30-a-minute search limit
 * at the scale a consumer's first spec reaches, and refused every run.
 *
 * Only a trusted author's issue is a citation (#2546): OWNER, MEMBER or
 * COLLABORATOR, or a bot account. An issue's author can close it as completed
 * themselves, so on a public repository the closed state alone would let an
 * outsider choose where a successor sends its reader. Bots count because the
 * workflow's own successors are filed by `github-actions[bot]`, and an app
 * installation is an admin's grant.
 *
 * Reads issue <N>, which must be closed, and the criteria it names. For each
 * one that `declared-work` now reads as owed by nobody — unticked in an
 * opted-in spec, placed in a phase, and named by no open issue — it files one
 * successor issue naming the criterion, in the criterion's phase milestone.
 * `lib/criterion-successor.ts` decides; this script only reads and writes.
 *
 * **Nothing is written without `--write`.** A run without it prints what it
 * would file and what it leaves, and why.
 *
 * **A partial reading files nothing.** Specs, open issues and milestones are
 * all read before anything is filed. A spec sweep, a declared-work reading or
 * a placement that cannot be taken is UNMEASURED and the run exits before
 * writing. A second run files nothing: the first run's successor now names
 * the criterion, so it is no longer owed.
 *
 * The repository is `--repo`, then `GITHUB_REPOSITORY`, then the origin
 * remote (`rungate board`'s resolver). The specs are read from
 * `--project-root`, which defaults to the working directory.
 */
import { readFileSync } from "fs";
import { join, resolve } from "path";

import { answerableIds, criterionAnswer, specCriteriaIn, specPathSweep } from "../lib/board-mirror";
import { planSuccessors, sweepSuccessors, type SuccessorMilestone, type SuccessorPlan } from "../lib/criterion-successor";
import { parseOwnerRepo, resolveGitHubToken } from "../lib/github";
import { readLiveIssues } from "../lib/live-issues";
import { placementCoverage } from "../lib/spec-placement";
import { declaredWorkUnaccounted, type BoardSnapshot } from "./board-conformance";
import { LIVE_GIT, placementRow, plannedByUnmergedAdr, readDeclaredWork } from "./board-snapshot";
import { resolveRepo } from "./status-view";

/** The author associations whose closed issue a sweep may cite (#2546). */
export const TRUSTED_ASSOCIATIONS: readonly string[] = ["OWNER", "MEMBER", "COLLABORATOR"];

/** One closed issue, as the sweep reads it. */
export interface ClosedRecord {
  number: number;
  title: string;
  body: string | null;
  closedAt: string;
  /** GitHub's `state_reason`; null for an issue closed before GitHub recorded one. */
  stateReason: string | null;
  authorAssociation: string;
  authorIsBot: boolean;
}

/** A reading that could not be taken, or a run that was asked for wrongly. Nothing was filed. */
export const REFUSAL_EXIT = 2;
/** Everything was read and planned, and at least one successor could not be filed. */
export const WRITE_FAILED_EXIT = 1;

/** What the command reads and writes on GitHub. Injected so a test never shells out. */
export interface SuccessorGitHub {
  issue: (repo: string, n: number) => Promise<{ number: number; state: string; title: string; body: string | null }>;
  openIssues: (repo: string) => Promise<{ number: number; title: string; body: string | null }[]>;
  /** The open milestones. */
  milestones: (repo: string) => Promise<SuccessorMilestone[]>;
  /** Every closed issue in the repository, pull requests excluded: one paginated read (#2546). */
  closedIssues: (repo: string) => Promise<ClosedRecord[]>;
  /** Files the issue and returns its number. */
  createIssue: (repo: string, issue: { title: string; body: string; milestone: number }) => Promise<number>;
}

function gh(args: readonly string[]): string {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.GH_TOKEN;
  const proc = Bun.spawnSync(["gh", ...args], { env });
  if (proc.exitCode !== 0) throw new Error(new TextDecoder().decode(proc.stderr).trim().slice(0, 300));
  return new TextDecoder().decode(proc.stdout);
}

export const LIVE_GITHUB: SuccessorGitHub = {
  issue: async (repo, n) => {
    const r = JSON.parse(gh(["api", `repos/${repo}/issues/${n}`, "--jq", "{number, state, title, body}"])) as {
      number: number;
      state: string;
      title: string;
      body: string | null;
    };
    return { ...r, state: String(r.state).toUpperCase() };
  },
  openIssues: async repo => (await readLiveIssues(repo, false)).map(i => ({ number: i.number, title: i.title, body: i.body })),
  milestones: async repo =>
    gh(["api", "--paginate", `repos/${repo}/milestones?state=open&per_page=100`, "--jq", ".[] | {number, title} | @json"])
      .split("\n")
      .filter(l => l.trim() !== "")
      .map(l => JSON.parse(l) as SuccessorMilestone),
  closedIssues: async repo =>
    gh([
      "api",
      "--paginate",
      `repos/${repo}/issues?state=closed&per_page=100`,
      "--jq",
      '.[] | select(.pull_request == null) | {number, title, body, closedAt: .closed_at, stateReason: .state_reason, authorAssociation: .author_association, authorIsBot: (.user.type == "Bot")} | @json',
    ])
      .split("\n")
      .filter(l => l.trim() !== "")
      .map(l => JSON.parse(l) as ClosedRecord),
  createIssue: async (repo, i) =>
    Number(
      gh(["api", "-X", "POST", `repos/${repo}/issues`, "-f", `title=${i.title}`, "-f", `body=${i.body}`, "-F", `milestone=${i.milestone}`, "--jq", ".number"]).trim(),
    ),
};

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? "");
}

function refuse(why: string): number {
  console.error(`criterion-successor: UNMEASURED — ${why}. Nothing was filed.`);
  return REFUSAL_EXIT;
}

export async function main(
  argv: string[],
  root = process.cwd(),
  api: SuccessorGitHub = LIVE_GITHUB,
  env: Record<string, string | undefined> = process.env,
  // The criteria an ADR this tree accepts already plans (#2323): owed, but
  // filed by that ADR's merge. The same argument board-snapshot passes, so the
  // two readings of "owed" cannot disagree (review of #2534).
  planned: (root: string) => ReadonlyMap<string, string> = r => plannedByUnmergedAdr(r, LIVE_GIT(r)),
): Promise<number> {
  const issueArg = flag(argv, "--issue");
  const sweep = argv.includes("--sweep");
  const write = argv.includes("--write");
  const rootFlag = flag(argv, "--project-root");
  if (sweep && issueArg !== null) return refuse("--sweep reads every owed criterion and takes no --issue");
  if (!sweep && (issueArg === null || !/^[1-9]\d*$/.test(issueArg))) {
    return refuse(`--issue needs the number of the closed issue, not ${JSON.stringify(issueArg ?? "nothing")}, or pass --sweep`);
  }
  if (rootFlag === "") return refuse("--project-root needs a directory after it");
  const projectRoot = rootFlag === null ? root : resolve(rootFlag);

  const named = resolveRepo(argv, env, projectRoot);
  let repo: string;
  try {
    if (named === null) throw new Error("no --repo, no GITHUB_REPOSITORY, and no GitHub origin remote");
    const { owner, repo: name } = parseOwnerRepo(named);
    repo = `${owner}/${name}`;
  } catch (e) {
    return refuse(`no repository to read (${(e as Error).message})`);
  }
  if (!resolveGitHubToken(env)) return refuse("no GitHub credential; set GITHUB_TOKEN or GH_TOKEN");

  // The specs first: a tree whose criteria cannot be read has nothing to ask GitHub about.
  const criteria = specCriteriaIn(projectRoot);
  if (criteria.reading === "UNMEASURED") return refuse(`the specs' criteria could not be read (${criteria.unmeasuredReasons.join("; ")})`);
  const ids = answerableIds(criteria);
  const coverage = placementCoverage(projectRoot, specPathSweep, (base, path) => readFileSync(join(base, path), "utf-8"));
  if (coverage.specs.length === 0 && coverage.reading === "UNMEASURED") {
    return refuse(`the specs' placement could not be read (${coverage.unmeasuredReasons.join("; ")})`);
  }
  const declared = readDeclaredWork(projectRoot, coverage.specs.map(placementRow), planned(projectRoot));
  if (declared.declaredWork === undefined) return refuse("the declared work could not be read: an in-scope spec or project-state.json is unreadable");

  const specText = (path: string): string | null => {
    try {
      return readFileSync(join(projectRoot, path), "utf-8");
    } catch {
      return null;
    }
  };
  const owedNow = async () => {
    const open = await api.openIssues(repo);
    const repoIssues = open.map(i => {
      const { names: n, servesNone } = criterionAnswer({ title: i.title, body: i.body }, ids);
      return { number: i.number, names: n, servesNone };
    });
    return declaredWorkUnaccounted({ declaredWork: declared.declaredWork, repoIssues } as BoardSnapshot)
      .filter(w => w.kind === "criterion")
      .map(w => ({ id: w.id, source: w.source }));
  };

  try {
    let plan: SuccessorPlan;
    if (sweep) {
      const owed = await owedNow();
      // The closed issues are read in full before anything is planned, in one
      // read, and not at all when nothing is owed (#2546). A read that fails
      // files nothing.
      const lastNamer = new Map<string, number>();
      const citable =
        owed.length === 0
          ? []
          : (await api.closedIssues(repo))
              // A trusted author only: see the header.
              .filter(i => i.authorIsBot || TRUSTED_ASSOCIATIONS.includes(i.authorAssociation))
              // Done work only. A maintainer's "not planned" or "duplicate" is
              // not the work a successor should send the next reader to.
              .filter(i => i.stateReason === "completed" || i.stateReason === null)
              .map(i => ({ number: i.number, closedAt: i.closedAt, names: criterionAnswer({ title: i.title, body: i.body }, ids).names }))
              .sort((a, b) => b.closedAt.localeCompare(a.closedAt));
      for (const id of [...new Set(owed.map(o => o.id))]) {
        const newest = citable.find(i => i.names.includes(id));
        if (newest !== undefined) lastNamer.set(id, newest.number);
      }
      plan = sweepSuccessors(owed, lastNamer, specText, await api.milestones(repo));
    } else {
      const closed = await api.issue(repo, Number(issueArg));
      if (closed.state !== "CLOSED") return refuse(`#${closed.number} is ${closed.state.toLowerCase()}, not closed`);
      const names = criterionAnswer({ title: closed.title, body: closed.body }, ids).names;
      if (names.length === 0) {
        console.log(`criterion-successor: #${closed.number} names no criterion, so it left none owed. Nothing to file.`);
        return 0;
      }
      const owed = await owedNow();
      plan = planSuccessors({ number: closed.number, names }, owed, specText, await api.milestones(repo));
    }
    if ("why" in plan) return refuse(plan.why);

    for (const l of plan.leave) console.log(`leave ${l.id}: ${l.why}`);
    if (!write) {
      for (const s of plan.file) console.log(`would file: ${s.title} (in ${s.milestone.title})`);
      console.log(`criterion-successor: ${plan.file.length} to file, ${plan.leave.length} left. Nothing was written; --write files them.`);
      return 0;
    }
    const failed: string[] = [];
    for (const s of plan.file) {
      try {
        const n = await api.createIssue(repo, { title: s.title, body: s.body, milestone: s.milestone.number });
        console.log(`filed #${n}: ${s.title} (in ${s.milestone.title})`);
      } catch (e) {
        failed.push(`${s.id}: ${(e as Error).message}`);
      }
    }
    if (failed.length > 0) {
      console.error(`criterion-successor: ${failed.length} successor(s) could not be filed: ${failed.join("; ")}`);
      return WRITE_FAILED_EXIT;
    }
    return 0;
  } catch (e) {
    return refuse(`GitHub could not be read (${(e as Error).message})`);
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
