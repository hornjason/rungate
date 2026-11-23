/**
 * Whether a Bash command's `gh issue edit` writes a payload issue's board
 * fields, and the refusal if it does (#2713).
 *
 * The payload's board is the plan the pipeline places, and SC-2625 is that no
 * person or agent edits it by hand. `scripts/hand-edits.ts` reads every write
 * on the payload family since `board.pipelineSince` and names each one a
 * person made; the second run (#1722) ended on an agent's body edit where a
 * comment would have done. This refuses that edit before it runs.
 *
 * ## A speed bump, not an authorization boundary
 *
 * The same terms as `IssueCloseGuard`'s close check (#144): deciding from a
 * command's text what it will write means re-implementing shell and gh's
 * flag parser, and `gh api -X PATCH …` names none of what this looks for.
 * The control is `scripts/hand-edits.ts`, which reads the outcome. A bypass
 * found here is not a defect to file.
 *
 * ## Which writes
 *
 * The flags whose write `hand-edits` counts: body, title, milestone, labels,
 * blocked-by and blocking links, and project adds and removals. An assignee
 * is not a board write there, so claiming an issue stays allowed.
 *
 * ## Which issues
 *
 * Those in a `<prefix> Phase N` milestone, where `<prefix>` is the payload
 * spec's `board.prefix`. The payload is the spec the engine spec's `governs:`
 * line names after `Payload:`, read the way `test/board-conformance-job.test.ts`
 * binds the board job's `--prefix`. A tree with no such spec has no payload,
 * and nothing is refused.
 *
 * An issue whose milestone cannot be read is refused: the edit would need the
 * same access, so the refusal costs nothing an allowed edit would not.
 */
import { spawnSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, join } from "path";

/** The `gh issue edit` flags whose write `scripts/hand-edits.ts` counts as a hand edit. */
export const BOARD_WRITE_FLAGS: readonly string[] = [
  "--body", "-b", "--body-file", "-F", "--title", "-t",
  "--milestone", "-m", "--remove-milestone",
  "--add-label", "--remove-label",
  "--add-blocked-by", "--remove-blocked-by", "--add-blocking", "--remove-blocking",
  "--add-project", "--remove-project",
];

/** The `gh issue edit` flags that take no value, so the next word is not theirs. */
const VALUELESS_FLAGS = new Set(["--remove-milestone", "--remove-parent", "--remove-type", "--help", "-h"]);
const EDIT_INVOCATION = /\bgh\s+issue\s+edit\b/;
const ISSUE_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\/?$/;

/** The payload spec's `board.prefix`, or null when this tree declares no payload. */
export function payloadPrefix(root: string): string | null {
  const dir = join(root, "specs");
  if (!existsSync(dir)) return null;
  for (const file of readdirSync(dir).filter(f => f.endsWith(".md")).sort()) {
    const payload = readFileSync(join(dir, file), "utf-8").match(/^governs:.*Payload: (\S+\.md)/m)?.[1];
    if (payload === undefined) continue;
    const path = join(dir, payload);
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8").match(/^board:\n(?:\s+.*\n)*?\s+prefix: (\S+)/m)?.[1] ?? null;
  }
  return null;
}

/** A segment's words, honouring single and double quotes. Enough for a speed bump. */
function words(segment: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let quoted = false;
  for (const c of segment) {
    if (quote !== null) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      quoted = true;
    } else if (/\s/.test(c)) {
      if (cur !== "" || quoted) out.push(cur);
      cur = "";
      quoted = false;
    } else {
      cur += c;
    }
  }
  if (cur !== "" || quoted) out.push(cur);
  return out;
}

interface BoardEdit {
  issues: string[];
  repo: string | null;
  flags: string[];
}

/** Every `gh issue edit` in the command that carries a board-write flag. */
function boardEdits(command: string): BoardEdit[] {
  const edits: BoardEdit[] = [];
  for (const segment of command.split(/[;|&\n]+/)) {
    if (!EDIT_INVOCATION.test(segment)) continue;
    const w = words(segment);
    const at = w.findIndex((x, i) => x === "edit" && w[i - 1] === "issue" && basename(w[i - 2] ?? "") === "gh");
    if (at < 0) continue;
    const edit: BoardEdit = { issues: [], repo: null, flags: [] };
    for (let i = at + 1; i < w.length; i++) {
      const word = w[i];
      if (!word.startsWith("-")) {
        edit.issues.push(word);
        continue;
      }
      const eq = word.indexOf("=");
      const name = eq < 0 ? word : word.slice(0, eq);
      const value = eq >= 0 ? word.slice(eq + 1) : VALUELESS_FLAGS.has(name) ? null : (w[++i] ?? null);
      if (name === "-R" || name === "--repo") edit.repo = value;
      if (BOARD_WRITE_FLAGS.includes(name)) edit.flags.push(name);
    }
    if (edit.flags.length > 0) edits.push(edit);
  }
  return edits;
}

/** The milestone title of an issue, through gh, so the repository resolves as the edit's would. */
function ghMilestone(issue: string, repo: string | null): string {
  const r = spawnSync("gh", ["issue", "view", issue, "--json", "milestone", "-q", '.milestone.title // ""', ...(repo ? ["-R", repo] : [])], {
    encoding: "utf-8",
    timeout: 20_000,
  });
  if (r.status !== 0) throw new Error((r.stderr || r.error?.message || `gh exited ${r.status}`).trim().slice(0, 200));
  return r.stdout.trim();
}

export interface PayloadEditOptions {
  /** The payload's milestone prefix; defaults to this tree's payload spec. `null` means no payload. */
  prefix?: string | null;
  /** The milestone title of an issue; defaults to asking gh. Throws when it cannot read it. */
  milestoneOf?: (issue: string, repo: string | null) => string;
}

/** The reason to refuse the command, or null to let it run. */
export function payloadEditRefusal(command: string, opts: PayloadEditOptions = {}): string | null {
  if (!EDIT_INVOCATION.test(command)) return null;
  const edits = boardEdits(command);
  if (edits.length === 0) return null;
  const prefix = opts.prefix !== undefined ? opts.prefix : payloadPrefix(join(import.meta.dir, ".."));
  if (!prefix) return null;
  const family = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} Phase \\d+`);
  const milestoneOf = opts.milestoneOf ?? ghMilestone;
  const why = "(#2713: a speed bump; scripts/hand-edits.ts reads the outcome)";

  for (const edit of edits) {
    if (edit.issues.length === 0) return `Cannot check this gh issue edit — it names no issue. ${why}`;
    for (const raw of edit.issues) {
      const url = ISSUE_URL.exec(raw);
      const issue = url ? url[2] : /^#?\d+$/.test(raw) ? raw.replace(/^#/, "") : null;
      const repo = edit.repo ?? (url ? url[1] : null);
      if (issue === null) return `Cannot check this gh issue edit — "${raw}" does not name an issue it can read. ${why}`;
      let title: string;
      try {
        title = milestoneOf(issue, repo);
      } catch (e) {
        return `Cannot check this edit of #${issue} — its milestone could not be read (${String((e as Error)?.message ?? e)}). ${why}`;
      }
      if (family.test(title)) {
        return (
          `#${issue} is in "${title}", a payload issue. ${edit.flags.join(", ")} is a board write, and any board ` +
          `write by a person or an agent ends SC-2625's hand-edit run (#1722). Comment instead: ` +
          `gh issue comment ${issue} --body-file <file>. ${why}`
        );
      }
    }
  }
  return null;
}
