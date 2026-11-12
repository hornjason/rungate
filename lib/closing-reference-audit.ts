/**
 * A closing keyword GitHub will never act on (#1362).
 *
 * `.claude/rules/ship-workflow.md` says to put `Fixes #<N>` in the PR body and
 * let the merge close the issue. What it cannot say, because nothing in the
 * tree measured it until now, is that **a closing keyword inside a code span
 * is inert**. GitHub parses the body as markdown and does not link a reference
 * it finds inside backticks or a fenced block, so the PR merges, the author
 * sees the sentence they wrote, and the issue stays open.
 *
 * Measured on `hornjason/pai-harness` at 2026-10-23T15:31Z: of **50** open
 * issues, **27** carry at least one merged pull request cross-reference, from
 * **65** distinct merged pull requests. Running this detector over all 65
 * produced **one** report — PR #1208, naming #1148 and #1157. Its second line
 * is the keyword and the number wrapped in backticks, the pull request says in
 * prose that the work is done and verified, and `closingIssuesReferences` is
 * empty. #1148 was rescued by the squash commit subject `fix(#1148): …`;
 * #1157 was not in the title and is still open.
 *
 * ## Why this reports the INERT ones and not the live ones
 *
 * A function that decided which references DO close an issue would be a second
 * decider competing with GitHub's own parser, and the two would agree on
 * almost every input — `.claude/rules/checks-must-be-able-to-fail.md`'s fourth
 * shape, where no behavioural test can tell a dead guard from a live one.
 *
 * This reports only what a caller can check against the API's own answer: the
 * caller already knows `closingIssuesReferences`, and an empty one beside a
 * keyword the author clearly meant is a disagreement worth refusing on. The
 * question asked here is "did you write something that looks like it closes an
 * issue and does not", which GitHub does not answer anywhere.
 *
 * ## Why the keyword must be ADJACENT to the number
 *
 * This repository writes negations constantly — `.claude/rules/` tells agents
 * never to put a closing keyword next to an issue number they are not closing,
 * and they comply by writing the denial in prose instead.
 *
 * The negative control, over the same 65 merged pull requests: loosening
 * "adjacent" to "within 40 characters" produced **21** candidates, of which
 * the same two were true and **19** were false. Three kinds of false, and only
 * the first is a negation:
 *
 * - a denial — `Closes nothing — #523 stays open`, `Fixes nothing on its own —
 *   leaving #713 open`, `Neither issue is closed by this PR`;
 * - prose about a DIFFERENT issue — `| #1281 | … | fixed, merged as #1288 |`;
 * - a window artefact, where the 40 characters end mid-number and the
 *   candidate names an issue nobody wrote.
 *
 * So adjacency is not a convenience, it is the whole precision of the check,
 * and widening it is the cheapest wrong fix available here: on the only corpus
 * that exists, the loosened rule is wrong nineteen times out of twenty-one.
 */

import { declaredClosingIn } from "./local-work";

/**
 * The issues a pull request closes **in this repository**, from `gh`'s shape.
 *
 * ai-review round 2 of #1978. `closingIssuesReferences` resolves GitHub's
 * closing keywords and those match across repositories: a body writing
 * `Fixes other-org/other-repo#9` produces a node numbered 9 that has nothing
 * to do with this tracker. Counting it made a cross-repo reference satisfy
 * the branch's own-issue requirement, so a pull request on `rg/1950-foo`
 * closing somebody else's #9 printed "closing references OK" — the exact
 * PR-#1903 shape this change exists to catch, let through by the check
 * itself.
 *
 * Identical to the defect `declaredClosingIn` was added for in round 5 of
 * #1974, one consumer over, which is why that function is called here rather
 * than re-implemented: "which of these nodes belong to us" has one decider.
 *
 * This only adapts the SHAPE. `gh pr view --json closingIssuesReferences`
 * returns `repository: { name, owner: { login } }` where the GraphQL field
 * `declaredClosingIn` was written against returns `nameWithOwner`. A node
 * missing either half composes to a string that matches no repository, which
 * is the safe direction: it can cause a reference to be ignored and a
 * refusal raised, never a refusal suppressed.
 */
export function linkedIssuesInThisRepo(
  nodes: readonly unknown[],
  repoNameWithOwner: string,
): Set<number> {
  const shaped = nodes
    .filter((n): n is Record<string, any> => n !== null && typeof n === "object")
    .filter(n => typeof n.number === "number")
    .map(n => ({
      number: n.number as number,
      repository: { nameWithOwner: `${n.repository?.owner?.login}/${n.repository?.name}` },
    }));
  return new Set(declaredClosingIn(shaped, repoNameWithOwner));
}

/**
 * The verbs GitHub acts on, in one declaring position.
 *
 * Taken from GitHub's documented list rather than invented. Every form is
 * spelled out instead of stemmed: `close|closes|closed` and not `close[sd]?`
 * with a comment, because a reader checking this against the documentation
 * compares a list to a list.
 */
export const CLOSING_KEYWORDS: readonly string[] = [
  "close",
  "closes",
  "closed",
  "fix",
  "fixes",
  "fixed",
  "resolve",
  "resolves",
  "resolved",
];

/** One closing keyword that is present in the prose and inert in the markup. */
export interface InertClosingReference {
  /** The issue number the author wrote. */
  issue: number;
  /** The keyword as they spelled it, case preserved, for the message. */
  keyword: string;
  /** Which markup swallowed it. */
  reason: "code-span" | "fenced-block";
  /** The matched text, so a message can quote what to change. */
  text: string;
}

/**
 * Byte ranges the GitHub markdown parser will not scan for references.
 *
 * Fenced blocks are taken first and their ranges removed from the input the
 * span scanner sees, because a fence contains backticks by definition and a
 * span scanner run over the raw body would pair the fence delimiters with each
 * other and report nonsense.
 */
function maskedRanges(body: string): { start: number; end: number; reason: InertClosingReference["reason"] }[] {
  const out: { start: number; end: number; reason: InertClosingReference["reason"] }[] = [];
  const fenced = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm;
  for (const m of body.matchAll(fenced)) {
    out.push({ start: m.index!, end: m.index! + m[0].length, reason: "fenced-block" });
  }
  const inFence = (i: number) => out.some(r => i >= r.start && i < r.end);
  // Single-line code spans. `[^`\n]+` keeps a span from spilling across a line,
  // which is what an unmatched backtick in ordinary prose would otherwise do —
  // and an unmatched backtick is common in a body that quotes shell.
  for (const m of body.matchAll(/(`+)([^`\n]+?)\1/g)) {
    if (inFence(m.index!)) continue;
    out.push({ start: m.index!, end: m.index! + m[0].length, reason: "code-span" });
  }
  return out;
}

/**
 * Closing keywords in `body` that name an issue and will not fire.
 *
 * Deduplicated by issue number: a body that names the same issue twice inside
 * backticks is one mistake, not two, and a message listing it twice reads as
 * two problems to fix.
 */
export function inertClosingReferences(body: string): InertClosingReference[] {
  if (!body) return [];
  const ranges = maskedRanges(body);
  const pattern = new RegExp(`\\b(${CLOSING_KEYWORDS.join("|")})\\b[ \\t]*:?[ \\t]*#(\\d+)\\b`, "gi");
  const seen = new Set<number>();
  const out: InertClosingReference[] = [];
  for (const m of body.matchAll(pattern)) {
    const hit = ranges.find(r => m.index! >= r.start && m.index! < r.end);
    if (!hit) continue;
    const issue = Number.parseInt(m[2]!, 10);
    if (seen.has(issue)) continue;
    seen.add(issue);
    out.push({ issue, keyword: m[1]!, reason: hit.reason, text: m[0] });
  }
  return out;
}

/**
 * The files whose pull requests owe no closing reference (ADR-013, SC-2737).
 *
 * The session record, and nothing else: a state update closes no issue and is
 * expected not to. Paths are repository-relative and exact — the root copies,
 * never a file of the same name somewhere else in the tree.
 */
export const SESSION_RECORD_FILES: readonly string[] = [
  "project-state.json",
  "PROJECT-STATE.md",
  "SUCCESS.md",
];

/** The words an issue writes when it is cleanup that serves no spec criterion. */
export const NO_CRITERION_DECLARATION = "serves no criterion";

/**
 * Is every changed file a session-record file?
 *
 * **Decided from the diff, never from the branch name.** #1950 decided whether
 * a reference was owed from the branch, and the AI review of #1989 refused
 * that: a branch that does not open with an issue number skipped the check
 * whatever it changed. A file-set rule has no such door — touching one other
 * file makes the pull request owe a reference.
 *
 * An empty list is `false`. A pull request with no readable files has not
 * shown it is a session record, and the caller refuses an absent list as
 * UNMEASURED before this is reached.
 */
export function isSessionRecordOnly(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every(p => SESSION_RECORD_FILES.includes(p));
}

/** Does an issue body name a criterion, or say it serves none? */
export function namesCriterion(body: string): boolean {
  return /\bSC-\d+\b/.test(body) || body.toLowerCase().includes(NO_CRITERION_DECLARATION);
}

/**
 * Why a pull request fails ADR-013's step 4, or `null` when it does not.
 *
 * Two failures, in the order a fix has to happen: closing no issue in this
 * repository, then closing one whose body names neither a criterion nor
 * `serves no criterion`. Every value the message names is carried here, the
 * rule rounds 1 and 3 of #1978 arrived at: a claim the message cannot support
 * is a claim it cannot spell.
 */
export type ClosingRequirementFailure =
  | { kind: "NO_ISSUE"; rawReferenceCount: number; repoNameWithOwner: string; rerun: string }
  | { kind: "NO_CRITERION"; issues: number[]; rerun: string };

export function closingRequirement(
  changedPaths: readonly string[],
  linkedIssueBodies: ReadonlyMap<number, string>,
  rawReferenceCount: number,
  repoNameWithOwner: string,
  rerun: string,
): ClosingRequirementFailure | null {
  if (isSessionRecordOnly(changedPaths)) return null;
  if (linkedIssueBodies.size === 0) {
    return { kind: "NO_ISSUE", rawReferenceCount, repoNameWithOwner, rerun };
  }
  const issues = [...linkedIssueBodies]
    .filter(([, body]) => !namesCriterion(body))
    .map(([n]) => n)
    .sort((a, b) => a - b);
  return issues.length > 0 ? { kind: "NO_CRITERION", issues, rerun } : null;
}

/** The refusal text for the above. Names what was read, and the remedy. */
export function closingRequirementMessage(f: ClosingRequirementFailure, prNumber: number): string {
  if (f.kind === "NO_ISSUE") {
    return (
      `PR #${prNumber} closes no issue in ${f.repoNameWithOwner}` +
      (f.rawReferenceCount === 0
        ? ` — closingIssuesReferences is empty.\n\n`
        : `: none of the ${f.rawReferenceCount} closing reference(s) GitHub recorded belongs to it.\n\n`) +
      `Every pull request closes an issue (ADR-013, step 4). Add "Fixes #<N>" to the BODY, ` +
      `not inside backticks, naming the issue this work was filed under. Only a pull request ` +
      `whose changed files are all session-record files owes none. Editing the body re-runs ` +
      `this check by itself.`
    );
  }
  return (
    `PR #${prNumber} closes issue(s) #${f.issues.join(", #")}, whose body names ` +
    `neither a criterion (SC-<N>) nor "${NO_CRITERION_DECLARATION}".\n\n` +
    `Add the criterion it serves to the issue, or the words "${NO_CRITERION_DECLARATION}" if it ` +
    `is cleanup. Editing an issue fires no pull-request event, so re-run this check after: ` +
    `${f.rerun}`
  );
}

/**
 * The refusal text.
 *
 * It names the issue, the markup and the remedy, because
 * `.claude/rules/self-referential-tests.md` is explicit that a check without a
 * remedy is an obstacle. The remedy here is one character of punctuation, so
 * the message says exactly which.
 */
export function inertClosingMessage(refs: InertClosingReference[], prNumber: number): string {
  const rows = refs
    .map(r => `  ${r.text}  — inside a ${r.reason}, so GitHub never linked it (issue #${r.issue})`)
    .join("\n");
  return (
    `PR #${prNumber} has no closingIssuesReferences, and its body names ` +
    `${refs.length === 1 ? "an issue" : "issues"} with a closing keyword that the markdown ` +
    `parser cannot see:\n${rows}\n\n` +
    `GitHub does not read a reference inside backticks or a fenced block, so this ` +
    `pull request records no link to them and the merge will not close them. ` +
    `Something else still might — PR #1208 carried two inert references and its squash ` +
    `commit subject, "fix(#1148): …", closed that one anyway, while #1157 was not in ` +
    `the title and stayed open after the body said in prose it was done. Do not rely ` +
    `on that: it is a conventional-commit prefix that happens to be a closing keyword. ` +
    `Remove the backticks from that line, then re-read the field rather than the body: ` +
    `gh pr view ${prNumber} --json closingIssuesReferences. If the reference is ` +
    `deliberately inert because you are quoting a keyword rather than using one, move ` +
    `the quote so the number is not adjacent to the verb.`
  );
}
