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
 * The command is read by `clauses()` from `lib/issue-create-override.ts`,
 * the shell tokenizer the filing guard already uses (#2719 review round 2).
 * Quotes, backslash escapes, line continuations, comments, heredocs and
 * `bash -c` are its job, not a second reader's. A short flag may carry its
 * value attached (`-bTEXT`, `-mTITLE`, `-Rowner/name`), as gh's flag parser
 * allows, and a redirection is not an argument.
 *
 * ## Which issues
 *
 * Those in a `<prefix> Phase N` milestone, where `<prefix>` is the payload
 * spec's `board.prefix`. The payload is the spec the engine spec's `governs:`
 * line names after `Payload:`, read the way `test/board-conformance-job.test.ts`
 * binds the board job's `--prefix`. A tree with no such spec has no payload,
 * and nothing is refused. A payload that is declared and cannot be read, a
 * missing spec or one with no `board.prefix`, refuses every board edit: a
 * broken declaration is not an absent one (#2719 review).
 *
 * A milestone set into the family is refused whatever milestone the issue
 * has now, since moving an issue onto the payload board is itself a board
 * write `hand-edits` counts (#2719 review).
 *
 * An issue whose milestone cannot be read is refused: the edit would need the
 * same access, so the refusal costs nothing an allowed edit would not.
 *
 * The milestone is read through `lib/github.ts`, never a `gh` subprocess
 * (SC-893). The repository is the command's own `-R`/`--repo` or issue URL,
 * then a `GH_REPO=` in the command's own env prefix, then `GH_REPO`, then
 * the session's `origin`: gh's own fallbacks, close
 * enough for a speed bump. A `cd` into another repository before the edit is
 * not followed, which is the kind of gap #144 says not to file.
 */
import { spawnSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import { createGitHubClient, getIssue } from "./github";
import { clauses } from "./issue-create-override";

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
const ISSUE_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\/?$/;

/**
 * The payload spec's `board.prefix`, or null when this tree declares no
 * payload. Throws when a payload is declared and cannot be read: a broken
 * declaration read as an absent one turned the guard off (#2719 review).
 */
export function payloadPrefix(root: string): string | null {
  const dir = join(root, "specs");
  if (!existsSync(dir)) return null;
  for (const file of readdirSync(dir).filter(f => f.endsWith(".md")).sort()) {
    // Read across the frontmatter, so a wrapped `governs:` line still names
    // its payload; a `Payload:` it cannot read is a broken declaration, not
    // an absent one (#2719 review round 3).
    const declaring = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(readFileSync(join(dir, file), "utf-8"))?.[1];
    if (declaring === undefined || !/\bPayload:/.test(declaring)) continue;
    const payload = /\bPayload:\s*(\S+\.md)\b/.exec(declaring)?.[1];
    if (payload === undefined) throw new Error(`specs/${file} declares a payload ("Payload:") and names no spec file this can read`);
    const path = join(dir, payload);
    if (!existsSync(path)) throw new Error(`specs/${file} names Payload: ${payload}, and specs/${payload} does not exist`);
    // Read as YAML, so a quoted prefix is the prefix and not its quotes (#2719
    // review round 2); frontmatter that does not parse is a broken declaration.
    const front = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(readFileSync(path, "utf-8"))?.[1];
    let board: unknown;
    try {
      board = front === undefined ? undefined : (Bun.YAML.parse(front) as { board?: unknown } | null)?.board;
    } catch (e) {
      throw new Error(`specs/${payload}, the payload specs/${file} names, has frontmatter that does not parse (${(e as Error).message})`);
    }
    const prefix = (board as { prefix?: unknown } | null | undefined)?.prefix;
    if (typeof prefix !== "string" || prefix === "") {
      throw new Error(`specs/${payload}, the payload specs/${file} names, has no board.prefix`);
    }
    return prefix;
  }
  return null;
}

interface BoardEdit {
  issues: string[];
  /** `-R` / `--repo`. */
  repo: string | null;
  /** A `GH_REPO=` in the command's own env prefix (#2719 review). */
  envRepo: string | null;
  flags: string[];
  /** The values of `--milestone` / `-m`. */
  milestones: string[];
}

/**
 * Short flags of `gh issue edit` whose value may be attached: `-b` body, `-F`
 * body file, `-t` title, `-m` milestone, `-R` repository. pflag reads `-bTEXT`
 * as `-b TEXT`, as `lib/issue-create-override.ts` reads `gh issue create`'s.
 */
const VALUE_SHORT_FLAGS = new Set(["b", "F", "t", "m", "R"]);
const ATTACHED_SHORT = /^-([A-Za-z])([\s\S]+)$/;
/** A redirection, with its target attached (`>/dev/null`) or not (`2>`). */
const REDIRECT = /^\d*(?:>>?|<)/;
const BARE_REDIRECT = /^\d*(?:>>?|<)$/;

/** Every `gh issue edit` in the command that carries a board-write flag. */
function boardEdits(command: string): BoardEdit[] {
  const edits: BoardEdit[] = [];
  // `2>&1`, `>&file`, `<&3` and `&>` are redirections, not the `&` the
  // tokenizer splits on (#2719 review round 3).
  const text = command.replace(/([<>])&(?=[^\s&;|])/g, "$1").replace(/&>/g, ">");
  for (const w of clauses(text)) {
    const at = w.findIndex((x, i) => x === "edit" && w[i - 1] === "issue" && basename(w[i - 2] ?? "") === "gh");
    if (at < 0) continue;
    const envRepo = w.slice(0, at - 2).map(x => /^GH_REPO=(.+)$/.exec(x)?.[1]).filter(Boolean).pop() ?? null;
    const edit: BoardEdit = { issues: [], repo: null, envRepo, flags: [], milestones: [] };
    for (let i = at + 1; i < w.length; i++) {
      const word = w[i];
      if (REDIRECT.test(word)) {
        if (BARE_REDIRECT.test(word)) i++; // its target is the next word
        continue;
      }
      if (!word.startsWith("-") || word === "-") {
        edit.issues.push(word);
        continue;
      }
      const attached = ATTACHED_SHORT.exec(word);
      const eq = word.indexOf("=");
      let name: string;
      let value: string | null;
      if (attached !== null && VALUE_SHORT_FLAGS.has(attached[1])) {
        // Any text after the letter is the value, `-b---` included; pflag
        // drops a leading `=` (#2719 review round 3).
        name = `-${attached[1]}`;
        value = attached[2].replace(/^=/, "");
      } else if (eq >= 0) {
        name = word.slice(0, eq);
        value = word.slice(eq + 1);
      } else {
        name = word;
        value = VALUELESS_FLAGS.has(name) ? null : (w[++i] ?? null);
      }
      if (name === "-R" || name === "--repo") edit.repo = value;
      if (BOARD_WRITE_FLAGS.includes(name)) edit.flags.push(name);
      if ((name === "--milestone" || name === "-m") && value !== null) edit.milestones.push(value);
    }
    if (edit.flags.length > 0) edits.push(edit);
  }
  return edits;
}

/** `owner/name` from a GitHub remote URL, or null. */
function remoteRepo(url: string): string | null {
  return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1] ?? null;
}

/** The repository an edit naming none acts on: `GH_REPO`, then this session's `origin`. */
function defaultRepo(): string | null {
  if (process.env.GH_REPO) return process.env.GH_REPO;
  const r = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf-8", timeout: 5_000 });
  return r.status === 0 ? remoteRepo(r.stdout) : null;
}

/** The milestone title of an issue, through the GitHub API (SC-893). */
async function apiMilestone(issue: string, repo: string | null): Promise<string> {
  const slug = repo ?? defaultRepo();
  if (slug === null) throw new Error("the command names no repository and this session has no GitHub origin to read");
  const data = await getIssue(createGitHubClient(), slug, Number(issue));
  return (data?.milestone?.title as string | undefined) ?? "";
}

export interface PayloadEditOptions {
  /** The payload's milestone prefix; defaults to this tree's payload spec. `null` means no payload. */
  prefix?: string | null;
  /** The tree whose payload spec decides; defaults to this module's own tree. */
  root?: string;
  /** The milestone title of an issue; defaults to the GitHub API. Throws when it cannot read it. */
  milestoneOf?: (issue: string, repo: string | null) => string | Promise<string>;
}

/** The reason to refuse the command, or null to let it run. */
export async function payloadEditRefusal(command: string, opts: PayloadEditOptions = {}): Promise<string | null> {
  // A cheap pre-check, over the text with its quotes and backslashes taken
  // out: `gh "issue" edit` and `gh iss\\ue edit` are the same command to the
  // shell, and the tokenizer below reads them so (#2719 review round 3).
  const plain = command.replace(/["'\\]/g, "");
  if (!/\bgh\b/.test(plain) || !/\bedit\b/.test(plain)) return null;
  const edits = boardEdits(command);
  if (edits.length === 0) return null;
  const why = "(#2713: a speed bump; scripts/hand-edits.ts reads the outcome)";
  let prefix: string | null;
  try {
    prefix = opts.prefix !== undefined ? opts.prefix : payloadPrefix(opts.root ?? join(import.meta.dir, ".."));
  } catch (e) {
    return `Cannot check this gh issue edit — the payload declaration is broken: ${String((e as Error)?.message ?? e)}. ${why}`;
  }
  if (!prefix) return null;
  const family = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} Phase \\d+`);
  const milestoneOf = opts.milestoneOf ?? apiMilestone;

  for (const edit of edits) {
    if (edit.issues.length === 0) return `Cannot check this gh issue edit — it names no issue. ${why}`;
    for (const raw of edit.issues) {
      const url = ISSUE_URL.exec(raw);
      const issue = url ? url[2] : /^#?\d+$/.test(raw) ? raw.replace(/^#/, "") : null;
      const repo = edit.repo ?? (url ? url[1] : null) ?? edit.envRepo;
      if (issue === null) return `Cannot check this gh issue edit — "${raw}" does not name an issue it can read. ${why}`;
      const into = edit.milestones.find(m => family.test(m));
      if (into !== undefined) {
        return (
          `--milestone "${into}" moves #${issue} onto the payload board. A milestone set is a board write, and any ` +
          `board write by a person or an agent ends SC-2625's hand-edit run (#1722). Comment instead: ` +
          `gh issue comment ${issue} --body-file <file>. ${why}`
        );
      }
      let title: string;
      try {
        title = await milestoneOf(issue, repo);
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
