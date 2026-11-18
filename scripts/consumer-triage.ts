#!/usr/bin/env bun
/**
 * `rungate consumer-triage` — SC-2782, ADR-020 Decision 1.
 *
 * Reads every open issue labelled `from-consumer` that carries no verdict
 * marker, asks `triageVerdict` (`lib/consumer-triage.ts`, the one decider) for
 * each, and prints the answer. With `--write` it applies it:
 *
 *   1. the milestone, when the verdict names one the issue is not already in;
 *   2. `board.queueLabel`, for every verdict but DUPLICATE;
 *   3. the marker comment, LAST.
 *
 * The comment is last on purpose. The marker is what says "triaged", so it is
 * written only once the moves it records have landed: a move that fails leaves
 * no marker, and the next run (the daily sweep, SC-2784) asks again.
 *
 * Any tracker read that fails is UNMEASURED and nothing is written. A
 * partial reading is worse than none here: an open issue missing from the
 * corpus is a duplicate or an overlap the decider cannot see.
 */
import { parseArgs } from "util";
import {
  CONSUMER_LABEL,
  trustedBodies,
  triageVerdict,
  verdictComment,
  verdictIn,
  type IssueComment,
  type OpenPull,
  type Triage,
  type TriageIssue,
} from "../lib/consumer-triage";
import { enginePrefixReading, readQueueLabel } from "../lib/config-readers";
import type { PlacingFamily } from "../lib/issue-repair";
import { ghWithoutGhToken, readLiveIssues } from "../lib/live-issues";
import type { LiveMilestone } from "../lib/spec-placement";
import { LIVE_PLACE, placingFamilies } from "./plan-issues";

/** Every refusal exits through this. */
export const REFUSAL_EXIT = 1;

/** More open pull requests than this and the list is cut, so the overlap reading is UNMEASURED. */
export const PULL_LIMIT = 300;

const USAGE = "rungate consumer-triage --repo <owner/name> [--write] [--json] [--project-root <dir>]";

type OpenIssue = TriageIssue & { readonly labels: readonly string[]; readonly labelsTruncated?: boolean };

/** What the triage needs from the tracker. Injected so a test never shells out. */
export interface TriageGitHub {
  milestones: (repo: string) => Promise<LiveMilestone[]>;
  openIssues: (repo: string) => Promise<OpenIssue[]>;
  openPulls: (repo: string) => Promise<OpenPull[]>;
  /** Every comment on one issue, with its author, paged to the end. */
  comments: (repo: string, number: number) => Promise<IssueComment[]>;
  comment: (repo: string, number: number, body: string) => Promise<void>;
  setMilestone: (repo: string, number: number, title: string) => Promise<void>;
  addLabel: (repo: string, number: number, label: string) => Promise<void>;
  /** The opted-in families — `placingFamilies`, the reader `plan-issues --place` uses. */
  families: (root: string, live: readonly LiveMilestone[]) => { families: PlacingFamily[]; refusals: string[] };
}

const LIVE: TriageGitHub = {
  milestones: LIVE_PLACE.milestones,
  openIssues: async repo => (await readLiveIssues(repo, false)).filter(i => i.state === "OPEN"),
  openPulls: async repo => {
    const rows = JSON.parse(
      ghWithoutGhToken(["pr", "list", "--repo", repo, "--state", "open", "--limit", String(PULL_LIMIT), "--json", "number,title,body,milestone,files"]),
    ) as { number: number; title: string; body: string | null; milestone: { title: string } | null; files: { path: string }[] | null }[];
    if (rows.length >= PULL_LIMIT) throw new Error(`${rows.length} open pull requests reached the read limit of ${PULL_LIMIT}, so the list is cut`);
    return rows.map(r => ({ number: r.number, title: r.title, body: r.body, milestone: r.milestone?.title ?? null, files: (r.files ?? []).map(f => f.path) }));
  },
  comments: async (repo, number) =>
    // One JSON string per line: `--paginate` concatenates pages, so a single
    // JSON document would not parse, and a raw body with a newline would read
    // as two comments.
    ghWithoutGhToken(["api", "--paginate", `repos/${repo}/issues/${number}/comments?per_page=100`, "--jq", ".[] | [.body, .user.login, .author_association] | @json"])
      .split("\n")
      .filter(l => l.trim() !== "")
      .map(l => {
        const [body, author, association] = JSON.parse(l) as [string, string, string];
        return { body, author, association };
      }),
  comment: async (repo, number, body) => void ghWithoutGhToken(["issue", "comment", String(number), "--repo", repo, "--body", body]),
  setMilestone: async (repo, number, title) => void ghWithoutGhToken(["issue", "edit", String(number), "--repo", repo, "--milestone", title]),
  addLabel: async (repo, number, label) => void ghWithoutGhToken(["issue", "edit", String(number), "--repo", repo, "--add-label", label]),
  families: (root, live) => placingFamilies(root, live),
};

interface Row {
  number: number;
  triage: Triage | { kind: "TRIAGED"; why: string };
  results: string[];
}

export async function main(argv: string[], gh: TriageGitHub = LIVE): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        repo: { type: "string" },
        write: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        "project-root": { type: "string" },
      },
    }));
  } catch (e) {
    console.error(`consumer-triage: ${(e as Error).message}\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }
  const repo = values.repo ?? process.env.GITHUB_REPOSITORY ?? "";
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    console.error(`consumer-triage: --repo <owner/name> is required (or GITHUB_REPOSITORY)\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }
  const root = values["project-root"] ?? process.cwd();
  const write = values.write === true;

  const engine = enginePrefixReading(root);
  if (engine.unmeasured !== null) console.error(`consumer-triage: ${engine.unmeasured}`);
  const queueLabel = readQueueLabel(root);

  // Every read before any write, and any one failing refuses the whole run.
  let issues: OpenIssue[];
  let pulls: OpenPull[];
  let families: PlacingFamily[];
  const pending: OpenIssue[] = [];
  const rows: Row[] = [];
  try {
    const live = await gh.milestones(repo);
    const read = gh.families(root, live);
    if (read.refusals.length > 0) {
      console.error(`consumer-triage: UNMEASURED — the opted-in families could not be read, so nothing was triaged:`);
      for (const r of read.refusals) console.error(`  - ${r}`);
      return REFUSAL_EXIT;
    }
    families = read.families;
    issues = (await gh.openIssues(repo)).sort((a, b) => a.number - b.number);
    pulls = await gh.openPulls(repo);
    const cut = issues.filter(i => i.labelsTruncated === true && !i.labels.includes(CONSUMER_LABEL));
    if (cut.length > 0) {
      throw new Error(`${cut.map(i => `#${i.number}`).join(", ")} carry more labels than one page holds, so whether they are from a consumer is unread`);
    }
    for (const i of issues.filter(i => i.labels.includes(CONSUMER_LABEL))) {
      const already = verdictIn(trustedBodies(await gh.comments(repo, i.number)));
      if (already !== null) rows.push({ number: i.number, triage: { kind: "TRIAGED", why: `already carries a ${already} verdict` }, results: [] });
      else pending.push(i);
    }
  } catch (e) {
    console.error(`consumer-triage: UNMEASURED — could not read the tracker, so nothing was triaged:`);
    console.error(`  - ${(e as Error).message}`);
    return REFUSAL_EXIT;
  }

  const ctx = { openIssues: issues, openPulls: pulls, families, enginePrefix: engine.prefix };
  for (const issue of pending) {
    const triage = triageVerdict(issue, ctx);
    const row: Row = { number: issue.number, triage, results: [] };
    rows.push(row);
    if (!write || triage.kind === "LEFT" || triage.kind === "REFUSED") continue;
    try {
      if (triage.kind !== "DUPLICATE" && triage.milestone !== issue.milestone) {
        await gh.setMilestone(repo, issue.number, triage.milestone);
        row.results.push(`milestone "${triage.milestone}"`);
      }
      if (triage.kind !== "DUPLICATE" && queueLabel !== null && !issue.labels.includes(queueLabel)) {
        await gh.addLabel(repo, issue.number, queueLabel);
        row.results.push(`label ${queueLabel}`);
      }
      await gh.comment(repo, issue.number, verdictComment(triage));
      row.results.push("verdict comment");
    } catch (e) {
      row.results.push(`FAILED: ${(e as Error).message} — no verdict comment, so the next run tries again`);
    }
  }
  rows.sort((a, b) => a.number - b.number);

  const refused = rows.filter(r => r.triage.kind === "REFUSED");
  const failed = rows.filter(r => r.results.some(x => x.startsWith("FAILED")));
  const exit = refused.length > 0 || failed.length > 0 ? REFUSAL_EXIT : 0;

  if (values.json === true) {
    console.log(JSON.stringify({ repo, write, queueLabel, rows }, null, 2));
    return exit;
  }
  console.log(`consumer-triage — ${repo}: ${rows.length} open ${CONSUMER_LABEL} issue(s), ${pending.length} with no verdict`);
  if (queueLabel === null) console.log(`  board.queueLabel is not configured, so no queue label is given (UNMEASURED, not an empty queue)`);
  for (const r of rows) {
    const t = r.triage;
    const what = t.kind === "DUPLICATE" ? `DUPLICATE of #${t.of}` : t.kind === "OVERLAPS" ? `OVERLAPS #${t.of} → "${t.milestone}"` : "milestone" in t ? `${t.kind} → "${t.milestone}"` : t.kind;
    console.log(`  #${r.number}  ${what} — ${t.why}`);
    for (const x of r.results) console.log(`      ${x}`);
  }
  if (!write && pending.length > 0) console.log(`\nNothing written. Re-run with --write to apply.`);
  if (refused.length > 0) console.error(`\nconsumer-triage: ${refused.length} issue(s) could not be given a verdict without guessing.`);
  if (failed.length > 0) console.error(`\nconsumer-triage: ${failed.length} issue(s) FAILED to write.`);
  return exit;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
