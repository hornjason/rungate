/**
 * #1743 — two issues editing the same file both sit in the pickable set with
 * nothing saying so.
 *
 * ## The measurement
 *
 * Over the 20 open issues carrying no milestone on 2026-11-03: 16 declare at
 * least one file, and there are 10 overlapping pairs — among them a cluster of
 * four, #1407, #1425, #1585 and #1355, all rewriting one file. Hand four
 * agents the unblocked, unassigned set and four of them collide. Rule 2 in
 * `AGENTS.md` already makes every issue name its files; nothing reads them.
 *
 * ## A conflict is not a dependency, and the edge is a borrowed primitive
 *
 * 20 of the 23 milestone-less issues are genuinely unblocked, and inventing an
 * ordering for them would make the board lie about what is pickable — which is
 * exactly why `lib/issue-shape.ts` leaves the *Blocked by* field optional. What
 * these issues have is a file conflict. `blocked by` is the output only because
 * it is the one primitive GitHub gives us for *not these two at once*, and the
 * note this file composes says so in words rather than filing the edge itself.
 *
 * **Nothing here blocks a filing.** The gate appends a note; a human or an
 * agent decides. A warning that refused would turn every second issue about a
 * busy file into an argument with a tool.
 *
 * ## Where the heading comes from
 *
 * `lib/issue-shape.ts`, and nowhere else. Spelling the file-list heading here
 * as well would be *two deciders that agree* from
 * `.claude/rules/checks-must-be-able-to-fail.md`: a mutation of either would
 * leave the other holding every case up, and both would read as covered.
 * `FO-10` in `test/issue-file-overlap.test.ts` asserts the string is absent
 * from this source.
 */

import { ISSUE_SECTIONS, headingFor, headingOccurrencesOf } from "./issue-shape";

/** An issue reduced to the thing this file reasons about. */
export interface IssueFiles {
  readonly id: number;
  readonly files: readonly string[];
}

/** One file, and the open issues contending for it. */
export interface FileContention {
  /** The path they all declare. */
  readonly file: string;
  /** The issue to do FIRST. Lowest number, so a re-run names the same one. */
  readonly lead: number;
  /** The rest, ascending — the ones a `blocked by` edge would point at. */
  readonly blocked: readonly number[];
}

const FILES_SECTION = ISSUE_SECTIONS.find(s => s.id === "files");

if (FILES_SECTION === undefined) {
  // Loud at import rather than an empty reading at call time. A section id the
  // decider no longer knows is a decision somebody made; it must not surface
  // as "no issue declares any file", which is indistinguishable from a quiet
  // board.
  throw new Error("lib/issue-file-overlap.ts: lib/issue-shape.ts declares no `files` section");
}

const FILES_HEADING = headingFor(FILES_SECTION);

/**
 * The paths an issue body declares, in the order it declares them.
 *
 * Reads ONLY the section the decider names, and stops at the next heading: the
 * sections either side are prose about the change, and a census that runs past
 * its own boundary grows a population nobody declared.
 *
 * **The direction this is allowed to be wrong in is toward reading FEWER
 * files.** A path it misses costs a warning nobody gets. A path it invents —
 * a word out of a sentence — costs a collision report against a file that does
 * not exist, which is how a warning channel becomes noise people skip. So a
 * candidate must be a single word that looks like a path.
 */
export function declaredFiles(body: string): string[] {
  const out: string[] = [];
  for (const line of filesSectionLines(body)) {
    for (const path of pathsOnLine(line)) if (!out.includes(path)) out.push(path);
  }
  return out;
}

/** The lines under the file-list heading, outside any fenced block. */
function filesSectionLines(body: string): string[] {
  const at = headingOccurrencesOf(body, FILES_HEADING)[0];
  if (at === undefined) return [];

  const out: string[] = [];
  let fenced = false;
  for (const line of body.slice(at).split("\n").slice(1)) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (/^#{1,6}\s+\S/.test(line)) break; // the next section
    out.push(line);
  }
  return out;
}

/**
 * The path a list line names, or null when the line is prose.
 *
 * A path is **a single word containing a `/` and ending in an alphabetic
 * extension of two to five characters**, and every backticked span on the line
 * is offered to that rule rather than only the first.
 *
 * ## The separator is there because four rounds of review said so
 *
 * Three of this PR's five review rounds asked one question — *which token is a
 * path* — and each found a token the then-current rule let through:
 *
 * | round | token | what was admitting it |
 * |---|---|---|
 * | 1 | `2.0`, `v2.1`, `i.e` | any dotted word counted |
 * | 2 | `N/A` | a `/` alone counted, with nothing else checked |
 * | 4 | `Node.js`, `GitHub.com` | an extension alone counted |
 *
 * Round 2's `N/A` was the costly one: the files section is REQUIRED and
 * `missingSections` demands content under the heading, so *N/A* is exactly
 * what somebody writes when they have nothing to put there, and every issue
 * that wrote it collided with every other one.
 *
 * Rounds 1 and 2 were repaired by widening and narrowing one predicate, and
 * round 4 arrived on the half the last repair had loosened. `AGENTS.md` rule 5
 * says stop repairing at the third round and re-scope, so: **a path needs both
 * halves — a separator AND an extension — and the class is closed.** There is
 * no third shape left for a fifth token to arrive through. The alternative was
 * a fourth special case, and a predicate accumulating special cases is the
 * `stripHeredocs` shape from #1808, which cost four rounds before it was
 * deleted.
 *
 * ## What this MISSES, said out loud
 *
 * - **Every root file** — `package.json`, `AGENTS.md`, `CLAUDE.md`. The
 *   deliberate cost of the separator, and the one real loss: those files are
 *   contested often. Buying them back needs a mechanism rather than a
 *   heuristic — the repository's own tracked-file list, which this module
 *   cannot see and should not grow a repo handle for at round five. That is a
 *   second issue, not a fourth branch.
 * - An extension-less file — `Makefile`, `lib/issue-shape` — and a dotfile
 *   like `.gitignore`.
 * - A URL is rejected outright on `://`, so a link to a file in another
 *   repository is not read as a file in this one.
 *
 * `FO-52` and `FO-57` assert the misses rather than leaving them in prose,
 * because an earlier version of this comment claimed `Makefile` was read while
 * the code rejected it.
 *
 * Every one of those is the direction `declaredFiles` declares two paragraphs
 * up: this reader may read too few files, never a file that does not exist. A
 * missed path costs a warning nobody gets; an invented one costs a collision
 * report against a file that is not there, which is how the channel becomes
 * noise people skip.
 */
function pathsOnLine(line: string): string[] {
  const bare = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim();
  const quoted = [...bare.matchAll(/`([^`]+)`/g)].map(m => m[1].trim());
  const candidates = quoted.length > 0 ? quoted : [bare];

  return candidates.filter(isPath).map(c => c.replace(/^\.\//, ""));
}

/**
 * One word, containing a `/`, ending in an alphabetic extension.
 *
 * **A repo-relative path, and nothing else.** The separator is the whole of
 * the rule that was missing. See `pathsOnLine` for why it is here rather than
 * a fourth special case.
 */
function isPath(candidate: string): boolean {
  if (candidate === "" || /\s/.test(candidate)) return false;
  if (candidate.includes("://")) return false; // a URL, not a file
  return candidate.includes("/") && /[A-Za-z][^/]*\.[A-Za-z]{2,5}$/.test(candidate);
}

/**
 * The paths both issues declare, in the first one's order.
 *
 * Exact paths. Deliberately no stem matching between a source file and its
 * test: they are edited together constantly and by the SAME issue, so treating
 * them as one file would make nearly every pair collide and the warning would
 * be worth nothing.
 */
export function sharedFiles(a: readonly string[], b: readonly string[]): string[] {
  return a.filter(p => b.includes(p));
}

/**
 * Every file more than one of these issues declares, lowest lead first.
 *
 * **The unit is a FILE, and that is the correction this went through.** The
 * first version clustered ISSUES by transitive union: two issues sharing
 * nothing directly landed in one group when both collided with a third, and
 * the group then carried the union of everyone's contested paths. Reported to
 * a reader it over-claimed — #100 on `lib/a.ts` and a filing on `lib/b.ts`
 * were told they shared work, on the strength of a #200 that declares both.
 *
 * A file is the thing two issues actually contend for, so it is the thing this
 * reading is keyed on. Every id in a row declares that row's path. There is
 * nothing left to over-claim with, and the union-find went with it.
 *
 * `lead` is the LOWEST number, which is the oldest issue and the one the rest
 * queue behind. Stable by construction: a reading whose lead moved between
 * runs would hand out a different set of edges each time and the board would
 * churn.
 */
export function contestedFiles(issues: readonly IssueFiles[]): FileContention[] {
  const by = new Map<string, number[]>();
  for (const issue of issues) {
    for (const path of new Set(issue.files)) {
      by.set(path, [...(by.get(path) ?? []), issue.id]);
    }
  }

  return [...by.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([file, ids]) => {
      const sorted = [...ids].sort((a, b) => a - b);
      return { file, lead: sorted[0], blocked: sorted.slice(1) };
    })
    .sort((a, b) => a.lead - b.lead || a.file.localeCompare(b.file));
}

/**
 * Which of these issues contend for a file — #1976, SC-2761.
 *
 * What `scripts/work-status.ts` prints under START HERE and PROMOTION
 * CANDIDATES, so the page says which of the startable issues can run at once.
 * `contestedFiles` over `declaredFiles`: one reading of a body, one decider
 * of contention, keyed by FILE for the reason that function records. An
 * issue naming no files is in no row, so two silent issues are never grouped
 * on a shared empty set.
 */
export function fileOverlapGroups(
  issues: readonly { readonly number: number; readonly body?: string | null }[],
): FileContention[] {
  return contestedFiles(issues.map(i => ({ id: i.number, files: declaredFiles(i.body ?? "") })));
}

/**
 * The lines the report prints for one list of `listed` issues. Nothing for a
 * list of one, which cannot collide with itself; a clean line when nothing is
 * contested, so "no collisions" is said rather than left as silence.
 */
export function overlapLines(groups: readonly FileContention[], listed: number): string[] {
  if (listed < 2) return [];
  if (groups.length === 0) {
    return ["  No two of these name the same file, so any of them can run at once."];
  }
  return [
    "  Collide on a file (start one per row, not two):",
    ...groups.map(g => `    ${g.file}: #${[g.lead, ...g.blocked].join(", #")}`),
  ];
}

/**
 * Corpus rows as the thing this file reasons about.
 *
 * Takes the structural shape rather than importing `Finding`, so the direction
 * of the dependency stays one way: `lib/issue-filing-gate.ts` reads this file,
 * and this file knows nothing about the gate.
 *
 * **A row whose id is not a number is dropped, not coerced.** The corpus also
 * carries in-command siblings keyed by position and the `new` marker for an
 * unfiled finding, and `Number("new")` is `NaN` — an id that would print as
 * `#NaN` in a warning and point at nothing.
 */
export function asIssueFiles(rows: readonly { id: string; body: string }[]): IssueFiles[] {
  const out: IssueFiles[] = [];
  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    const files = declaredFiles(row.body);
    if (files.length > 0) out.push({ id, files });
  }
  return out;
}

/**
 * The open issues this body shares a file with, and WHICH files, ascending.
 *
 * **DIRECT overlap, and the word is load-bearing.** The first version ran the
 * body through a transitive clustering with the rest and reported the group it
 * landed in, on the argument that everything in a contested set costs the same
 * to pick up. The review of this PR showed that argument is false, with a case
 * I had written no test for:
 *
 *     #100 declares lib/a.ts
 *     #200 declares lib/a.ts AND lib/b.ts
 *     the filing declares lib/b.ts
 *
 * One group, transitively — and the note then told the filer they shared
 * `lib/a.ts` with #100, which neither of them is true of, and offered
 * `--add-blocked-by 100` on that basis. A warning that names a file the reader
 * never wrote is the fastest way to teach them to skip the channel. `FO-45`
 * and `FG-229` are that case.
 *
 * Transitivity is still right for the question `contestedFiles` answers —
 * *what does the pickable set look like* — because there every id in a row
 * declares that row's path. It is wrong for *what does THIS body collide
 * with*, and those are two questions.
 */
export function collisionsWith(body: string, corpus: readonly IssueFiles[]): IssueFiles[] {
  const mine = declaredFiles(body);
  if (mine.length === 0) return [];

  return corpus
    .map(issue => ({ id: issue.id, files: sharedFiles(mine, issue.files) }))
    .filter(hit => hit.files.length > 0)
    .sort((a, b) => a.id - b.id);
}

/**
 * The note an agent reads when the body they are filing collides, or null.
 *
 * Null rather than an empty string: `lib/issue-filing-gate.ts` joins its
 * notes, so an empty one is blank space in a refusal nobody can account for,
 * and a channel that always has something in it is a channel people skip.
 *
 * **Every path printed here is one the filing itself declared**, and it is
 * attributed to an issue that declared it too — `collisionsWith` carries the
 * intersection rather than either side's whole list, so there is nothing for
 * this function to over-claim with.
 *
 * It names the remedy. A warning that does not say what to type is a warning
 * nobody can act on — `.claude/rules/config-access.md` makes that point about
 * UNMEASURED and it is true of every channel this gate writes to.
 *
 * The closing line is `contestedFiles` over the OPEN corpus alone, with this
 * body nowhere in it: a file two or more issues already contend for is a queue
 * the filer is joining, not a pair they are forming, and the oldest is the one
 * the rest go behind. `FO-46` pins the count at three where four issues would
 * be the tempting number.
 */
export function overlapNote(body: string, corpus: readonly IssueFiles[]): string | null {
  const collisions = collisionsWith(body, corpus);
  if (collisions.length === 0) return null;

  const flags = collisions.map(c => `--add-blocked-by ${c.id}`).join(" ");
  const mine = new Set(collisions.flatMap(c => c.files));
  const queues = contestedFiles(corpus)
    .filter(c => mine.has(c.file))
    .map(
      c =>
        `\`${c.file}\` already has ${c.blocked.length + 1} open issues on it — ` +
        `#${c.lead} is the oldest.`,
    );

  return [
    `**${plural(collisions.length)} already open ${collisions.length === 1 ? "names" : "name"} ` +
      "a file this one names:**",
    "",
    ...collisions.map(c => `- #${c.id} — ${c.files.map(f => `\`${f}\``).join(", ")}`),
    ...(queues.length > 0 ? ["", ...queues] : []),
    "",
    "Two sessions editing one file, with nothing on the tracker saying so, is",
    "the conflict this is warning about — it is NOT a dependency, and the board",
    "should not grow an ordering nobody meant. Order them only if you do:",
    "",
    `    gh issue edit <this issue> ${flags}`,
  ].join("\n");
}

function plural(n: number): string {
  return n === 1 ? "An issue" : `${n} issues`;
}
