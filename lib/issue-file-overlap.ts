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

/** A set of issues that cannot all be picked up at once. */
export interface FileCluster {
  /** The issue to do FIRST. Lowest number, so a re-run names the same one. */
  readonly lead: number;
  /** The rest, ascending — the ones a `blocked by` edge would point at. */
  readonly blocked: readonly number[];
  /** The paths more than one member of the cluster declares. */
  readonly files: readonly string[];
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
    const path = pathOnLine(line);
    if (path !== null && !out.includes(path)) out.push(path);
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

/** The path a list line names, or null when the line is prose. */
function pathOnLine(line: string): string | null {
  const bare = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim();
  const quoted = /`([^`]+)`/.exec(bare);
  const candidate = quoted !== null ? quoted[1].trim() : bare;

  if (candidate === "" || /\s/.test(candidate)) return null;
  // A `/` or an extension. Not both: `Makefile` has no extension and
  // `rungate.json` sits at the root, and both are files an issue may name.
  if (!candidate.includes("/") && !/\.[A-Za-z0-9]+$/.test(candidate)) return null;

  return candidate.replace(/^\.\//, "");
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
 * The issues that cannot all be picked up at once, lowest lead first.
 *
 * Grouping is TRANSITIVE. Two issues sharing nothing directly still belong to
 * one cluster when both collide with a third — handing them out as independent
 * pairs would put that third issue in two clusters at once and the lead becomes
 * whichever pair somebody read first.
 *
 * An issue declaring no files joins nothing. An absent reading is not an
 * overlap with everybody, and an edge nobody can act on is an edge somebody has
 * to clear.
 */
export function fileClusters(issues: readonly IssueFiles[]): FileCluster[] {
  const present = issues.filter(i => i.files.length > 0);
  const parent = new Map<number, number>(present.map(i => [i.id, i.id]));

  const find = (id: number): number => {
    let at = id;
    while (parent.get(at) !== at) at = parent.get(at)!;
    return at;
  };
  const union = (a: number, b: number) => {
    const [x, y] = [find(a), find(b)];
    if (x !== y) parent.set(Math.max(x, y), Math.min(x, y));
  };

  for (let i = 0; i < present.length; i++) {
    for (let j = i + 1; j < present.length; j++) {
      if (sharedFiles(present[i].files, present[j].files).length > 0) {
        union(present[i].id, present[j].id);
      }
    }
  }

  const groups = new Map<number, IssueFiles[]>();
  for (const issue of present) {
    const root = find(issue.id);
    groups.set(root, [...(groups.get(root) ?? []), issue]);
  }

  return [...groups.values()]
    .filter(members => members.length > 1)
    .map(members => {
      const ids = members.map(m => m.id).sort((a, b) => a - b);
      return {
        lead: ids[0],
        blocked: ids.slice(1),
        files: contestedFiles(members),
      };
    })
    .sort((a, b) => a.lead - b.lead);
}

/** The paths more than one member declares — the reason the cluster exists. */
function contestedFiles(members: readonly IssueFiles[]): string[] {
  const seen = new Map<string, number>();
  for (const m of members) {
    for (const p of new Set(m.files)) seen.set(p, (seen.get(p) ?? 0) + 1);
  }
  return [...seen.entries()]
    .filter(([, n]) => n > 1)
    .map(([p]) => p)
    .sort();
}

/**
 * The note an agent reads when the issue they are filing collides, or null.
 *
 * Null rather than an empty string: a channel that always has something in it
 * is a channel people stop reading, and `lib/issue-filing-gate.ts` joins its
 * notes, so an empty one would show up as blank space nobody can account for.
 *
 * It names the remedy. A warning that does not say what to type is a warning
 * nobody can act on — `.claude/rules/config-access.md` makes that point about
 * UNMEASURED and it is true of every channel the gate writes to.
 */
export function overlapNote(collisions: readonly IssueFiles[], issue: number): string | null {
  if (collisions.length === 0) return null;

  const lines = collisions.map(c => `- #${c.id} — ${c.files.map(f => `\`${f}\``).join(", ")}`);
  const flags = collisions.map(c => `--add-blocked-by ${c.id}`).join(" ");
  const subject = Number.isFinite(issue) ? `#${issue}` : "this issue";

  return [
    `**Open issues already name the same file(s).** Picking ${subject} up alongside`,
    "one of these means two sessions editing one file with nothing saying so.",
    "",
    ...lines,
    "",
    "This is a conflict, not a dependency — order them only if you mean to:",
    "",
    `    gh issue edit ${issue} ${flags}`,
  ].join("\n");
}
