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

import { NAMES_NONE, answerableIds, criterionAnswer, specCriteriaIn } from "./board-mirror";
import { idBoundedPattern } from "./sc-ids";
import { declaredClosingIn } from "./local-work";
import { fencedBlocks } from "./markdown-fence";

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
  // The shared reader (#2130). The regex this replaced required the close to
  // repeat the opening run exactly, so a longer close was missed and the
  // block ran on; and an unclosed fence, which GitHub renders as code to the
  // end, read as live.
  for (const b of fencedBlocks(body)) out.push({ ...b, reason: "fenced-block" });
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
/**
 * A closing keyword beside an issue number: `Fixes #12`, `closes: #12`.
 *
 * The one place the keyword list and its adjacency are decided, for a pull
 * request body and a commit message alike (#1979). Two patterns would be two
 * deciders, free to disagree about the same text.
 */
function closingKeywordPattern(): RegExp {
  // `(` as well as `:` may sit between verb and number: GitHub closed #1148
  // from the squash subject "fix(#1148): …" (PR #1208), the conventional-commit
  // form most subjects here take.
  // And an optional `owner/repo` before the `#` (AI review of #2120):
  // `Fixes hornjason/rungate#1717` closes #1717 as surely as the bare form.
  // Group 1 the keyword, 2 the repository if spelled, 3 the number.
  return new RegExp(
    `\\b(${CLOSING_KEYWORDS.join("|")})\\b[ \\t]*[:(]?[ \\t]*([\\w.-]+\\/[\\w.-]+)?#(\\d+)\\b`,
    "gi",
  );
}

export function inertClosingReferences(body: string): InertClosingReference[] {
  if (!body) return [];
  const ranges = maskedRanges(body);
  const pattern = closingKeywordPattern();
  const seen = new Set<number>();
  const out: InertClosingReference[] = [];
  for (const m of body.matchAll(pattern)) {
    const hit = ranges.find(r => m.index! >= r.start && m.index! < r.end);
    if (!hit) continue;
    // A spelled-out repository is left out here, as it always was: the body
    // check compares numbers against this repository's linked set, and another
    // repository's #9 is not this one's.
    if (m[2] !== undefined) continue;
    const issue = Number.parseInt(m[3]!, 10);
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

/** An issue this pull request closes, as the workflow's one query returns it. */
export interface ClosedIssue {
  readonly title: string;
  readonly body: string;
}

/**
 * Every id an issue can answer the criterion question with, read from the
 * checkout's `specs/` — or `null` when the sweep could not be taken.
 *
 * `null` is UNMEASURED, never an empty list: read as "no ids", every issue
 * naming a criterion would be refused for naming none (#2061).
 */
export function closingCriteria(root: string): ClosingCriteria | null {
  const sweep = specCriteriaIn(root);
  if (sweep.reading === "UNMEASURED") return null;
  // Only the ids ONE spec states (`sweep.ids`). A collided id is reported,
  // never attributed (AI review of #2115): a tick could not say which spec's
  // box to tick, so it is not demanded here either.
  const unambiguous = new Set(sweep.ids);
  const unticked = [...new Set(sweep.specs.flatMap(s => s.unticked))].filter(id => unambiguous.has(id));
  return { ids: answerableIds(sweep), unticked };
}

/**
 * The criteria a closing check reads from the checkout (#2061, #2005): every
 * id an issue can name, and the ids still unticked in at least one spec that
 * states them. The checkout is the pull request's merge commit, so a tick the
 * pull request makes is already here.
 */
export interface ClosingCriteria {
  readonly ids: readonly string[];
  readonly unticked: readonly string[];
}

/**
 * The words a pull request writes when it closes an issue naming a criterion
 * it does not finish, followed by the id (#2005): `does not complete SC-12`.
 * For a criterion more than one issue carries, so the last of them is the one
 * that has to tick it. Exact, like the criterion declaration: a looser match
 * would let a sentence excuse a criterion by accident.
 */
export const DOES_NOT_COMPLETE = "does not complete";

/** Does this pull request body excuse `id` with the exact words? */
export function excusesCriterion(prBody: string, id: string): boolean {
  return idBoundedPattern(`${DOES_NOT_COMPLETE} `, id).test(prBody);
}

/**
 * Why a pull request fails ADR-013's step 4, or `null` when it does not.
 *
 * Two failures, in the order a fix has to happen: closing no issue in this
 * repository, then closing one that has not answered the criterion question.
 * Every value the message names is carried here, the rule rounds 1 and 3 of
 * #1978 arrived at: a claim the message cannot support is a claim it cannot
 * spell.
 *
 * **The criterion question is `criterionAnswer`'s, not this file's** (#2061).
 * The `needs-criterion` label and the `criteria-named` reading ask it there;
 * a copy here accepted any `SC-<digits>`, so a payload issue naming `CRC-B4`
 * was refused a closing pull request while the board counted it answered.
 */
export type ClosingRequirementFailure =
  | { kind: "NO_ISSUE"; rawReferenceCount: number; repoNameWithOwner: string; rerun: string }
  | { kind: "NO_CRITERION"; issues: number[]; rerun: string }
  | {
      kind: "UNTICKED";
      /** Each closed issue and the unticked, unexcused criteria it names. */
      unticked: { issue: number; ids: string[] }[];
      /** `#77 (SC-12, SC-13)`, one per issue: what the message names. */
      named: string;
      /** The one sync command per criterion that ticks it. */
      ticks: string;
      /** The exact words that excuse each criterion instead. */
      excuses: string;
    };

/**
 * Third, after an issue is closed and has answered the criterion question
 * (#2005): every criterion it names is ticked in this tree, or this pull
 * request says it does not complete it. A merge that removes a criterion's
 * last open issue without a tick turns `criterion-coverage` short on main for
 * every other pull request, and no pull request can repair that from its own
 * tree — #2003 closing #1998 and #2094 closing #1964 both did.
 */
export function closingRequirement(
  changedPaths: readonly string[],
  linkedIssues: ReadonlyMap<number, ClosedIssue>,
  criteria: ClosingCriteria,
  prBody: string,
  rawReferenceCount: number,
  repoNameWithOwner: string,
  rerun: string,
): ClosingRequirementFailure | null {
  if (isSessionRecordOnly(changedPaths)) return null;
  if (linkedIssues.size === 0) {
    return { kind: "NO_ISSUE", rawReferenceCount, repoNameWithOwner, rerun };
  }
  const ordered = [...linkedIssues].sort(([a], [b]) => a - b);
  const issues = ordered
    .filter(([, issue]) => !criterionAnswer(issue, criteria.ids).answered)
    .map(([n]) => n);
  if (issues.length > 0) return { kind: "NO_CRITERION", issues, rerun };

  const unticked = ordered
    .map(([issue, body]) => ({
      issue,
      ids: criterionAnswer(body, criteria.ids).names.filter(
        id => criteria.unticked.includes(id) && !excusesCriterion(prBody, id),
      ),
    }))
    .filter(u => u.ids.length > 0);
  if (unticked.length === 0) return null;
  const ids = [...new Set(unticked.flatMap(u => u.ids))];
  return {
    kind: "UNTICKED",
    unticked,
    named: unticked.map(u => `#${u.issue} (${u.ids.join(", ")})`).join(", "),
    ticks: ids.map(id => `bun scripts/sync-sc-status.ts --only ${id}`).join("; "),
    excuses: ids.map(id => `"${DOES_NOT_COMPLETE} ${id}"`).join(", "),
  };
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
  if (f.kind === "UNTICKED") {
    return (
      `PR #${prNumber} closes issue(s) naming criteria that are not ticked in its own tree: ` +
      `${f.named}. Merging would leave each criterion with one fewer open issue and no tick, ` +
      `and criterion-coverage would read short on main for every other pull request.\n\n` +
      `Tick each in this pull request (${f.ticks}, then its proved-by: line), or, if another ` +
      `open issue still carries it, write the exact words ${f.excuses} in this description. ` +
      `Editing the description re-runs this check by itself.`
    );
  }
  return (
    `PR #${prNumber} closes issue(s) #${f.issues.join(", #")}, whose title and body name ` +
    `neither a criterion any spec states nor "${NAMES_NONE}".\n\n` +
    `Add the criterion it serves to the issue, or the exact words "${NAMES_NONE}" if it ` +
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
/** A closing keyword in a commit message, which GitHub acts on wherever it sits. */
export interface CommitClosingReference {
  readonly sha: string;
  readonly issue: number;
  /** The matched text, so the message can quote what to reword. */
  readonly text: string;
}

/**
 * Every closing keyword in these commit messages, backticks and fences
 * included (#1979).
 *
 * A commit message is not markdown. GitHub reads a keyword in it wherever it
 * sits, so the markup that makes `Fixes #12` inert in a pull request body
 * changes nothing here. That asymmetry closed #1717: PR #1978's squash commit
 * quoted a backticked keyword while describing the defect.
 */
export function commitClosingReferences(
  commits: readonly { readonly sha: string; readonly message: string }[],
  repoNameWithOwner: string,
): CommitClosingReference[] {
  const out: CommitClosingReference[] = [];
  for (const c of commits) {
    for (const m of c.message.matchAll(closingKeywordPattern())) {
      // Bare `#N`, or this repository spelled out. Another repository's issue
      // is not this pull request's to declare.
      if (m[2] !== undefined && m[2].toLowerCase() !== repoNameWithOwner.toLowerCase()) continue;
      out.push({ sha: c.sha, issue: Number.parseInt(m[3]!, 10), text: m[0] });
    }
  }
  return out;
}

/** The refusal for a commit message that would close an issue this pull request does not declare. */
export function commitClosingMessage(refs: readonly CommitClosingReference[], prNumber: number): string {
  const rows = refs.map(r => `  ${r.sha.slice(0, 8)}: "${r.text}" would close #${r.issue}`).join("\n");
  return (
    `PR #${prNumber} carries commit messages with a closing keyword for an issue it does ` +
    `not declare:\n${rows}\n\n` +
    `This repository squashes with the commit messages as the body, and merge and rebase ` +
    `keep them as they are, so the merge closes each of these. Backticks do not stop it ` +
    `in a commit message. Reword the commit so the number is not beside the verb ` +
    `(write "issue #N"), then push. Or, if closing it is intended, add "Fixes #N" to this ` +
    `description so the pull request declares it.`
  );
}

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
