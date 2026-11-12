#!/usr/bin/env bun
/**
 * criterion-label — #2020.
 *
 * Puts `needs-criterion` on every open issue that names no criterion and
 * does not declare `serves no criterion`, and takes it off the moment an
 * edit makes the issue answer. `criteria-named` (E2) counts the same
 * population with the same predicate, `criterionAnswer` in
 * `lib/board-mirror.ts`, so the label is that reading made visible on each
 * issue rather than a second opinion about it.
 *
 * Run by `.github/workflows/criterion-label.yml`:
 *   - `--issue N --comment` when an issue is opened: label it and say why, once;
 *   - `--issue N` when one is edited or reopened: add or remove, no comment;
 *   - no `--issue` daily and by hand: every open issue, no comments — which
 *     is also the backfill.
 *
 *   bun scripts/criterion-label.ts --repo owner/name [--issue N] [--comment] [--write]
 *
 * Without `--write` it prints the plan and changes nothing.
 */
import { NAMES_NONE, NEEDS_CRITERION_LABEL, answerableIds, criterionAnswer, specCriteriaIn } from "../lib/board-mirror";
import { ghWithoutGhToken, readLiveIssues, type GraphQlExec, type LiveIssue } from "../lib/live-issues";

/** The one exit code every refusal travels through. */
export const REFUSE_EXIT = 1;

/** The label's colour and description, written by `gh label create --force`. */
export const LABEL_COLOR = "D93F0B";
export const LABEL_DESCRIPTION = "Names no criterion and does not say it serves none (#2020)";

/** Posted once, when an issue is opened without an answer. */
export const COMMENT_BODY =
  `This issue names no success criterion, and does not say it serves none, so it carries ` +
  `\`${NEEDS_CRITERION_LABEL}\`.\n\n` +
  `To clear it, edit the body to name the criterion it serves (\`SC-<N>\`, as the spec writes ` +
  `it), or, if it is cleanup, write the words \`${NAMES_NONE}\` exactly as shown, in lower case, ` +
  `and say why. The label comes off by itself on the next edit. A pull request closing an ` +
  `issue that does neither is refused by \`closing-references\` (ADR-013, rule 9).`;

export interface LabelPlan {
  add: number[];
  remove: number[];
  /** A cut label list that does not show the label: nothing is decided. */
  unmeasured: number[];
}

type Labelled = Pick<LiveIssue, "number" | "title" | "body" | "labels" | "labelsTruncated">;

export function labelPlan(issues: readonly Labelled[], ids: readonly string[], label: string): LabelPlan {
  const plan: LabelPlan = { add: [], remove: [], unmeasured: [] };
  for (const i of issues) {
    const has = i.labels.includes(label);
    // A label list cut at the page boundary that does not SHOW the label has
    // not shown its absence either — adding it would be a write decided on a
    // reading that was not taken.
    if (!has && i.labelsTruncated === true) {
      plan.unmeasured.push(i.number);
      continue;
    }
    const { answered } = criterionAnswer(i, ids);
    if (!answered && !has) plan.add.push(i.number);
    else if (answered && has) plan.remove.push(i.number);
  }
  return plan;
}

export interface RunOptions {
  repo: string;
  issue: number | null;
  comment: boolean;
  write: boolean;
}

export interface RunResult {
  plan: LabelPlan | null;
  lines: string[];
  exit: number;
}

/**
 * `ids` is the spec sweep's criterion union, or `null` when the sweep could
 * not be taken. `exec` is `gh`, injected so the writes have a test.
 */
export async function run(opts: RunOptions, ids: readonly string[] | null, exec: GraphQlExec): Promise<RunResult> {
  const lines: string[] = [];
  // An empty union matches nothing, so every issue would read as unanswered
  // and be labelled. An unreadable sweep is a refusal, never an empty one.
  if (ids === null) {
    lines.push("UNMEASURED: the spec sweep could not be taken, so no issue's criteria can be read. Nothing was labelled.");
    return { plan: null, lines, exit: REFUSE_EXIT };
  }
  const open = await readLiveIssues(opts.repo, false, exec);
  const population = opts.issue === null ? open : open.filter(i => i.number === opts.issue);
  if (opts.issue !== null && population.length === 0) {
    lines.push(`#${opts.issue} is not open, so there is nothing to label.`);
    return { plan: { add: [], remove: [], unmeasured: [] }, lines, exit: 0 };
  }
  const plan = labelPlan(population, ids, NEEDS_CRITERION_LABEL);
  const carrying = open.filter(i => i.labels.includes(NEEDS_CRITERION_LABEL)).length + plan.add.length - plan.remove.length;
  lines.push(
    `${NEEDS_CRITERION_LABEL}: read ${population.length} open issue(s); ` +
      `add ${plan.add.length}, remove ${plan.remove.length}, unmeasured ${plan.unmeasured.length}` +
      (opts.issue === null ? `; ${carrying} will carry it` : ""),
  );
  if (plan.add.length > 0) lines.push(`  add:    #${plan.add.join(" #")}`);
  if (plan.remove.length > 0) lines.push(`  remove: #${plan.remove.join(" #")}`);
  if (plan.unmeasured.length > 0) {
    lines.push(`  UNMEASURED (label list cut, label not visible): #${plan.unmeasured.join(" #")}`);
  }
  if (!opts.write) {
    lines.push("Dry run: nothing written. Pass --write to apply.");
    return { plan, lines, exit: plan.unmeasured.length > 0 ? REFUSE_EXIT : 0 };
  }
  const failed: string[] = [];
  const write = (args: string[], what: string) => {
    try {
      exec(args);
      return true;
    } catch (e) {
      failed.push(`${what}: ${(e as Error).message}`);
      return false;
    }
  };
  // `gh issue edit --add-label` refuses a label the repository does not
  // define, so a fresh repository would fail every add (review round 1).
  // `--force` makes this idempotent: it creates the label or rewrites its
  // colour and description to these. If it fails, no add is attempted.
  const labelReady =
    plan.add.length === 0 ||
    write(
      ["label", "create", NEEDS_CRITERION_LABEL, "--repo", opts.repo, "--color", LABEL_COLOR, "--description", LABEL_DESCRIPTION, "--force"],
      `label ${NEEDS_CRITERION_LABEL}`,
    );
  for (const n of labelReady ? plan.add : []) {
    const added = write(["issue", "edit", String(n), "--repo", opts.repo, "--add-label", NEEDS_CRITERION_LABEL], `#${n} add`);
    if (added && opts.comment) write(["issue", "comment", String(n), "--repo", opts.repo, "--body", COMMENT_BODY], `#${n} comment`);
  }
  for (const n of plan.remove) {
    write(["issue", "edit", String(n), "--repo", opts.repo, "--remove-label", NEEDS_CRITERION_LABEL], `#${n} remove`);
  }
  for (const f of failed) lines.push(`FAILED ${f}`);
  return { plan, lines, exit: failed.length > 0 || plan.unmeasured.length > 0 ? REFUSE_EXIT : 0 };
}

function argValue(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

if (import.meta.main) {
  const repo = argValue("repo");
  const rawIssue = argValue("issue");
  const issue = rawIssue === null ? null : Number(rawIssue);
  const comment = process.argv.includes("--comment");
  let usage: string | null = null;
  if (repo === null || !/^[\w.-]+\/[\w.-]+$/.test(repo)) usage = "--repo owner/name is required";
  else if (issue !== null && !(Number.isInteger(issue) && issue > 0)) usage = `--issue must be a positive integer, got "${rawIssue}"`;
  else if (comment && issue === null) usage = "--comment needs --issue: the daily run and the backfill never comment";
  if (usage !== null) {
    console.error(`criterion-label: ${usage}`);
    process.exit(REFUSE_EXIT);
  }
  const sweep = specCriteriaIn(process.cwd());
  const result = await run(
    { repo: repo!, issue, comment, write: process.argv.includes("--write") },
    sweep.reading === "UNMEASURED" ? null : answerableIds(sweep),
    ghWithoutGhToken,
  );
  for (const l of result.lines) console.log(l);
  process.exitCode = result.exit;
}
