/**
 * Two hook trees, and which one a registration names (#713).
 *
 * A LEAF module with no relative imports, so there is one thing to mutate.
 *
 * ## The state this exists to hold
 *
 * Hooks are wired from two trees — `${PAI_HOOKS_DIR}` (`~/.pai/hooks`, 55
 * files) and `${RUNGATE_HOOKS_DIR}` (`~/Projects/rungate/hooks`, 18). Eight
 * NAMES exist as files in both, and all eight have diverged: the `.pai`
 * copies are the old monolithic versions, rungate's are the refactored thin
 * triggers. Nothing in either tree says which copy wins; the answer lives
 * only in a settings file.
 *
 * That is how `OrphanProcessCleanup` survived (#712) — a `.pai` hook doing a
 * harness job, which nobody re-read because it looked like settled
 * infrastructure.
 *
 * ## What this module does NOT answer, which is most of the question
 *
 * **Whether a declared hook is registered at all is `reconcile`'s question**,
 * in `test/hook-registration-reconciler.test.ts` (#199, #479). That file
 * already splits the inventory by `scope`, enforces the project-scoped half
 * against the committed `.claude/settings.json`, and reports the user-scoped
 * half as UNMEASURED on every run. Answering it a second time here would be
 * two deciders for one question — they would agree on every input anyone has,
 * and a mutation of either would leave the other holding the case up
 * (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape).
 *
 * So nothing below reports a hook as missing. `registrationTree` is handed
 * commands that already exist and answers a question `reconcile` does not
 * ask: **which tree does this command point into.**
 *
 * That blindness is the live gap #713 names. `registeredIn` matches
 * `/([A-Za-z][A-Za-z0-9]*)\.hook\.ts/`, so
 * `bun ${PAI_HOOKS_DIR}/IssueCloseGuard.hook.ts` satisfies it exactly as well
 * as the rungate path does. A hook this repo owns could be re-pointed at the
 * superseded 554-line `.pai` copy and every check in the tree stays green.
 *
 * ## Read EVERY settings scope before concluding anything about one hook
 *
 * #713 reported `AgentBriefGuard` as "dead in both trees — wired nowhere".
 * It is not. It is registered in the PROJECT settings as
 * `bun ${CLAUDE_PROJECT_DIR}/hooks/AgentBriefGuard.hook.ts`, which resolves to
 * the rungate copy; the measurement read `~/.claude/settings.json` alone and
 * took zero hits as absence. That is the #646 trap — a negative result over a
 * store you did not write, with the error pointing toward believing nothing
 * happened — and the control nobody ran is "is this hook wired ANYWHERE?".
 *
 * `settingsCommands` therefore takes a LIST of documents. A caller that reads
 * one scope gets an answer about one scope and has to say so.
 *
 * ## Why the tree is decided by PATH VARIABLE and not by substring
 *
 * `${CLAUDE_PROJECT_DIR}/hooks/X.hook.ts` and `${PAI_HOOKS_DIR}/X.hook.ts`
 * both contain the hook's name, so deciding by name matches a commented-out
 * line, a `description` field and the other tree's registration equally. The
 * roots are the only thing that distinguishes them.
 */

/** The path variables each tree is spelled with, in any settings scope. */
const RUNGATE_ROOTS = ["${RUNGATE_HOOKS_DIR}", "${CLAUDE_PROJECT_DIR}/hooks"];
const PAI_ROOTS = ["${PAI_HOOKS_DIR}", "/.pai/hooks"];

export type HookTree = "rungate" | "pai";

/**
 * Which tree one command points into.
 *
 * `unknown` is a reading, not a default: a command naming neither root is
 * something nobody has classified, and reporting it as rungate would be the
 * silent substitution this repo keeps paying for.
 */
export function registrationTree(command: string): HookTree | "unknown" {
  if (RUNGATE_ROOTS.some(r => command.includes(r))) return "rungate";
  if (PAI_ROOTS.some(r => command.includes(r))) return "pai";
  return "unknown";
}

/**
 * Every `command` string anywhere under a settings document's `hooks` key.
 *
 * Walks rather than indexing a known shape: the schema nests
 * event → matcher-group → `hooks[]` and has gained a level before. A reader
 * that knew one shape would return nothing for the next one, and nothing is
 * indistinguishable from a tree with no `.pai` registrations in it.
 *
 * A document that does not parse THROWS. A corrupt settings file is not a
 * settings file with no hooks in it (`.claude/rules/config-access.md`).
 */
export function settingsCommands(docs: string[]): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node === null || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    if (typeof rec.command === "string") out.push(rec.command);
    Object.values(rec).forEach(walk);
  };
  for (const doc of docs) {
    const parsed = JSON.parse(doc) as { hooks?: unknown };
    walk(parsed?.hooks ?? {});
  }
  return out;
}

/**
 * The hook file a command actually EXECUTES, as a basename.
 *
 * ## Three matchers, each narrower than the last, and why there was a third
 *
 * 1. `command.includes("X.hook.ts")` — satisfied by `other-X.hook.ts`, by
 *    `X.hook.ts.bak`, by the name in any path fragment.
 * 2. **token membership** — any `.hook.ts`-shaped token anywhere in the
 *    string. Narrower, and the same class: measured on the #976 branch, all
 *    four of these returned `true` for `IssueCloseGuard`:
 *
 *        bun run x.ts # IssueCloseGuard.hook.ts
 *        bun run x.ts ; echo IssueCloseGuard.hook.ts
 *        bun run x.ts && cat IssueCloseGuard.hook.ts
 *        SOME=1 bun run x.ts --note IssueCloseGuard.hook.ts
 *
 *    A hook counted as registered because its name appeared near a command
 *    that never runs it. Tokenising narrowed the hole; it did not remove it,
 *    and the diff implied otherwise.
 * 3. the **executed argument** — what this does now.
 *
 * Recorded as three steps deliberately. Three PRs in one day have replaced a
 * matcher that was wrong about its subject with one carrying the same
 * property a level down, and the way that keeps happening is a diff that
 * reads as though the class were closed.
 *
 * ## What this does
 *
 * Truncate at the first `#`, `;`, `&&`, `||` or `|`; drop leading `VAR=`
 * assignments, an `env` prefix, a known interpreter and a `run`/`exec`
 * subcommand; skip `--flag=value` flags and REFUSE on a bare one; basename
 * the **first positional** and compare it by equality.
 *
 * ## WHAT THIS DOES NOT COVER
 *
 * An argv parse has its own differentials. These are the ones still open,
 * named here rather than left for the next reader to infer from the diff —
 * **a stated limit is an answer; silence reads as coverage.** Each has a
 * case in `test/hook-registration-evidence.test.ts` AC-6h asserting the
 * stated behaviour, so this list cannot drift from the code without a red.
 *
 * | spelling | read as |
 * |---|---|
 * | `sh -c "bun X.hook.ts"` — the command is inside a quoted string | NOT naming it |
 * | a wrapper script that `exec`s the hook | NOT naming it |
 * | a `$VAR`-built path whose variable holds the file name | NOT naming it |
 * | `make x && bun X.hook.ts` — executed in a LATER segment | NOT naming it |
 * | `bun --inspect X.hook.ts` — a bare flag before the script | NOT naming it |
 * | `bun -- X.hook.ts` — the end-of-flags separator | NOT naming it |
 * | a computed specifier — `bun "$(resolve X)"` | NOT naming it |
 *
 * **Every one errs toward reporting a registration that exists as absent**,
 * and that is the direction chosen rather than tolerated. For
 * `hookRegistration` a missed registration becomes `unregistered` or
 * `unmeasured`, which `AC-4`/`AC-4b` turn red — loud, and someone fixes the
 * spelling. The opposite error is a guard reporting clean about its own
 * subject, which is what #910 cost.
 *
 * So do not "fix" a false red by widening this. The two legal repairs are to
 * add the spelling to the parse, or to change the registration to one the
 * parse reads. No registry command in this tree carries a flag at all
 * (measured: 0 of 19), which is why the bare-flag refusal costs nothing
 * today and is the safe default for whatever is added tomorrow.
 *
 * `wrongTreeViolations` below deliberately still SELECTS by substring, and
 * #981 is why: the error directions are opposite there, so a narrow parse
 * could silently stop reporting a hook genuinely wired to the superseded
 * tree. What #981 changed is that a selected string is now CLASSIFIED by this
 * parse, with everything the parse rejects reported as `unparsed` rather than
 * dropped. Its docblock carries the error-direction table — so the cheap
 * generalisation "reuse this parser everywhere" still has a written reason
 * not to, and the thing that was wrong is fixed.
 */
const INTERPRETERS = new Set([
  "bun", "bunx", "node", "npx", "npm", "pnpm", "yarn", "deno", "ts-node", "tsx",
]);
const SUBCOMMANDS = new Set(["run", "exec"]);
/** One shell word: its text with quotes and escapes removed, and as written. */
interface ShellWord {
  text: string;
  raw: string;
}

/**
 * A character a word may hold unquoted: the closed set this reader accounts
 * for. Anything outside it, and outside the quoting, escape, separator,
 * comment and parameter rules below, makes the line read as no hook
 * (#2815 review, round 4).
 */
const PLAIN = /[A-Za-z0-9_\-./=:@%+,#]/;

/** The length of a `$NAME` or `${NAME}` at `i`, or 0 for any other use of `$`. */
function parameterLength(s: string, i: number): number {
  const m = /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/.exec(s.slice(i));
  return m === null ? 0 : m[0].length;
}

/**
 * The words of a command line's first command, or null when the line holds
 * anything this reader does not account for (#2802, #2815 review).
 *
 * It accepts, and refuses everything else: rounds 1 to 3 of #2815's review
 * each found one more shell construct a general reader misread, so a path is
 * read only when every character of its line is accounted for. A refusal is
 * the loud direction, a registration read as unregistered; a guess can be
 * the silent one.
 *
 * - Outside quotes, a word holds characters of `PLAIN`, a space or tab ends
 *   it, a backslash escapes the next character, and `'` or `"` opens a quote.
 * - Inside single quotes nothing is special until the closing quote.
 * - Inside double quotes a backslash escapes `"`, `\`, `$` or a backquote,
 *   and is kept before anything else. A backquote is refused.
 * - Quoted or not, `$` is accepted only as `$NAME` or `${NAME}`, kept as
 *   written, which is how generated registrations name their directory.
 *   Command substitution, arithmetic, `$'…'` and every other expansion are
 *   refused.
 * - A backslash before a newline, quoted or not, is a line continuation: both
 *   go, as in the shell.
 * - An unquoted `;`, `|` or `&` ends the first command. A `#` that starts
 *   a word starts a comment, to the end of its line; a `#` inside a word is
 *   part of it.
 * - The rest of the first line is held to the same rules, because the shell
 *   parses a line before it runs any of it: a quote left open there, or a
 *   construct this reader does not account for, means no hook is read. An
 *   unquoted newline ends the scan, since the shell runs a line before it
 *   reads the next.
 */
function shellWords(command: string): ShellWord[] | null {
  const words: ShellWord[] = [];
  let text = "";
  let raw = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  let collecting = true;
  const end = () => {
    if (inWord && collecting) words.push({ text, raw });
    text = "";
    raw = "";
    inWord = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") {
      raw += c;
      if (c === "'") quote = null;
      else text += c;
      continue;
    }
    if (c === "$") {
      // Outside quotes or inside double ones: a plain parameter, or a refusal.
      const n = parameterLength(command, i);
      if (n === 0) return null;
      inWord = true;
      text += command.slice(i, i + n);
      raw += command.slice(i, i + n);
      i += n - 1;
      continue;
    }
    if (quote === '"') {
      raw += c;
      if (c === '"') quote = null;
      else if (c === "`") return null;
      else if (c === "\\" && command[i + 1] === "\n") {
        raw += "\n";
        i++;
      } else if (c === "\\" && i + 1 < command.length && '"\\$`'.includes(command[i + 1]!)) {
        text += command[i + 1]!;
        raw += command[i + 1]!;
        i++;
      } else text += c;
      continue;
    }
    if (c === "\\" && command[i + 1] === "\n") {
      // A line continuation: neither character is part of any word.
      i++;
    } else if (c === "\\") {
      inWord = true;
      raw += c;
      if (i + 1 < command.length) {
        text += command[i + 1]!;
        raw += command[i + 1]!;
        i++;
      }
    } else if (c === "'" || c === '"') {
      inWord = true;
      quote = c;
      raw += c;
    } else if (c === "#" && !inWord) {
      // A comment runs to the end of its line; the newline then ends the command.
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
    } else if (c === "\n") {
      // The shell runs this line before it reads the next, so nothing after
      // it can stop the first command running.
      break;
    } else if (c === ";" || c === "|" || c === "&") {
      end();
      collecting = false;
    } else if (c === " " || c === "\t") {
      end();
    } else if (PLAIN.test(c)) {
      inWord = true;
      text += c;
      raw += c;
    } else {
      return null;
    }
  }
  if (quote !== null) return null;
  end();
  return words;
}

/**
 * The executed hook file as a PATH — the first positional, un-basenamed.
 *
 * The one parse. `executedHookFile` is its basename projection and
 * `hookRegistrationPath` is its per-hook projection, so there is a single
 * binding to mutate and no second spelling of the argv walk.
 *
 * The path is what `wrongTreeViolations` classifies, and the basename is what
 * every registration reading compares. Both come from here; they cannot
 * disagree about which token ran. Its words come from {@link shellWords}.
 */
export function executedHookPath(command: string): string | null {
  const words = shellWords(command);
  if (words === null) return null;
  // A leading assignment is a word written `NAME=` before any quote: a quoted
  // `"A=1"` is a command word to the shell, not an assignment.
  const assignment = (w: ShellWord | undefined) => w !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.raw);
  let i = 0;
  while (assignment(words[i])) i++;
  if (words[i]?.raw === "env") {
    i++;
    while (assignment(words[i])) i++;
  }
  if (i < words.length && INTERPRETERS.has(words[i]!.text.split("/").pop() ?? "")) i++;
  if (i < words.length && SUBCOMMANDS.has(words[i]!.text)) i++;
  // The flag run is where an argv parse silently becomes wrong, and it is the
  // differential a review found in the first version of this parse:
  // `bun --preload Foo.hook.ts run real.ts` PRELOADS Foo and EXECUTES
  // real.ts, so a loop that skips flags and then takes the next token reports
  // a file that never ran as the registration.
  //
  // A `--flag=value` carries its value in its own word, so skipping it
  // cannot swallow the script. A BARE flag may or may not consume the next
  // word, and the only way to know is a list of value-taking flags — which
  // goes stale the next time bun adds one, and a stale allowlist defaulting
  // to "this was safe to skip" is the fail-open direction. So a bare flag is
  // REFUSED: `null`, no registration read, loud.
  while (i < words.length && words[i]!.text.startsWith("-")) {
    if (!words[i]!.text.includes("=")) return null;
    i++;
  }
  if (i >= words.length) return null;

  const arg = words[i]!.text;
  // A word holding whitespace names a file with spaces in its path, which no
  // registration here uses, or a whole command quoted as one word, which the
  // shell looks up as a program and cannot run (#2815 review, round 3). Either
  // way it is no hook this parse reads: loud, not a registration.
  if (/\s/.test(arg)) return null;
  const base = arg.slice(arg.lastIndexOf("/") + 1);
  return /^[A-Za-z0-9_-]+\.hook\.ts$/.test(base) ? arg : null;
}

/** The executed hook file as a BASENAME. A projection of `executedHookPath`. */
export function executedHookFile(command: string): string | null {
  const path = executedHookPath(command);
  return path === null ? null : path.slice(path.lastIndexOf("/") + 1);
}

/**
 * The PATH `command` executes, when what it executes is `<hook>.hook.ts`.
 *
 * The one comparison. `commandNamesHook` is its boolean projection, so a
 * reading cannot say "this command names the hook" and hand back a path
 * belonging to something else.
 */
export function hookRegistrationPath(command: string, hook: string): string | null {
  const path = executedHookPath(command);
  if (path === null) return null;
  return path.slice(path.lastIndexOf("/") + 1) === `${hook}.hook.ts` ? path : null;
}

/**
 * Does `command` EXECUTE `<hook>.hook.ts`?
 *
 * The single predicate every registration reading goes through, so there is
 * one binding to mutate and one place a narrowing or a widening lands.
 */
export function commandNamesHook(command: string, hook: string): boolean {
  return hookRegistrationPath(command, hook) !== null;
}

export interface TreeViolation {
  hook: string;
  /**
   * `unparsed` is NOT a tree. It is the reading for a string that mentions the
   * hook and is not a command executing it — see `wrongTreeViolations`.
   */
  tree: HookTree | "unknown" | "unparsed";
  command: string;
  detail: string;
}

/**
 * Registrations of a hook this repo OWNS that do not name the rungate tree.
 *
 * Reports nothing for a hook with no registration — that is `reconcile`'s
 * finding, and duplicating it here would make this the second decider for a
 * question that already has one. The input this binding alone can see is a
 * registration that EXISTS and points at the superseded copy.
 *
 * ## Why SELECTION is still a substring, and the fix was NOT `executedHookFile`
 *
 * #981 is the issue, and it exists because the cheap generalisation —
 * *"#976 replaced the substring with the argv parse in `hook-scopes.ts`, do
 * the same here"* — makes this site WORSE. The error directions are opposite:
 *
 * | | over-broad | narrow parse |
 * |---|---|---|
 * | `hookRegistration` (#976) | a hook that is NOT registered reads as registered — a guard reporting clean about its own subject, #910's defect | a real registration reads as absent → `unregistered` → **loud** |
 * | here | a violation that is not real → an investigation → **loud** | a hook genuinely wired to the superseded tree **silently stops being reported**, which is #713 entire |
 *
 * So selection keeps the substring and nothing is ever dropped for failing to
 * parse. What changed is that a selected string is now CLASSIFIED by the argv
 * parse, in three readings instead of two:
 *
 * | reading | what it means |
 * |---|---|
 * | `pai` | the command EXECUTES this hook, from the superseded tree |
 * | `unknown` | it EXECUTES this hook, from a path naming neither root |
 * | `unparsed` | it mentions the hook and is not a command executing it |
 *
 * Before, a `# TestSuiteRelease.hook.ts` in a comment was reported as
 * *"registered by a command naming neither tree's path variable"* — a
 * sentence about a string that is not a registration at all. It is still
 * reported, because dropping it is the direction that goes silent; it is now
 * reported as the thing it is.
 *
 * ## The tree is read off the EXECUTED PATH, not the whole command
 *
 * `registrationTree(command)` would read
 * `bun ${PAI_HOOKS_DIR}/X.hook.ts # see ${RUNGATE_HOOKS_DIR}` as **rungate**
 * and drop it — a genuine `.pai` registration, silenced by a word in a
 * comment. That is the same over-broad-substring class the issue is about,
 * one level down, so it is closed here rather than left for the next reader:
 * the classifier is handed `hookRegistrationPath`'s path and sees only the
 * token that runs.
 *
 * ## WHAT THIS DOES NOT COVER
 *
 * Every escape below is an UNDER-report, and each has a case in
 * `test/hook-tree-divergence.test.ts` asserting the stated behaviour, so this
 * list cannot drift from the code without a red.
 *
 * | spelling | read as |
 * |---|---|
 * | `bun "$HOOK_FILE"` — the file NAME is in a variable, so the string never contains `X.hook.ts` | not selected at all, so not reported |
 * | a wrapper script that `exec`s the hook without naming it | not selected at all, so not reported |
 * | `sh -c "bun ${PAI_HOOKS_DIR}/X.hook.ts"` | selected, reported `unparsed` — the quoting is not unwrapped, so the tree is not read |
 * | `make x && bun ${PAI_HOOKS_DIR}/X.hook.ts` — executed in a LATER segment | selected, reported `unparsed` |
 *
 * The first two are the ones nothing here can reach: a string that does not
 * contain the hook's file name cannot be selected by any reading of these
 * commands, and recovering it needs a shell rather than a parser. They are
 * the boundary, stated, because a stated limit is an answer and silence reads
 * as coverage.
 */
export function wrongTreeViolations(owned: string[], commands: string[]): TreeViolation[] {
  const out: TreeViolation[] = [];
  for (const hook of owned) {
    // SELECTION stays over-broad on purpose — see the table above.
    for (const command of commands.filter(c => c.includes(`${hook}.hook.ts`))) {
      const path = hookRegistrationPath(command, hook);
      if (path === null) {
        const executes = executedHookFile(command);
        out.push({
          hook,
          tree: "unparsed",
          command,
          detail:
            `${hook} is named by this string, which is not a command that executes it ` +
            `(${executes ? `the first command executes ${executes}` : "no executed hook file could be read from it"}), ` +
            `so no tree can be read from it and it is not evidence of any registration: ${command}`,
        });
        continue;
      }
      const tree = registrationTree(path);
      if (tree === "rungate") continue;
      out.push({
        hook,
        tree,
        command,
        detail:
          tree === "pai"
            ? `${hook} is owned by this repo and registered from the .pai tree, which holds the ` +
              `superseded copy: ${command}`
            : `${hook} is registered by a command naming neither tree's path variable, so which ` +
              `copy runs cannot be read from it: ${command}`,
      });
    }
  }
  return out;
}

export interface HookTreeCensus {
  reading: "MEASURED" | "UNMEASURED";
  unmeasuredReasons: string[];
  /** Hook names present as files in BOTH trees. */
  duplicates: string[];
  pai: string[];
  rungate: string[];
}

const HOOK_FILE = /\.hook\.ts$/;

/**
 * Both trees, listed, with the duplicate names named.
 *
 * `listDir` is injected so a case can drive an unreadable directory without
 * touching the filesystem, and so this module stays a leaf with no `fs`
 * import.
 *
 * **A directory that cannot be read is UNMEASURED and NOT an empty list.**
 * Zero duplicates found between two directories nobody opened is the reading
 * SC-1 exists to refuse, and it is what CI sees: `~/.pai` is machine state
 * and does not exist on a runner.
 */
export function hookTreeCensus(
  paiDir: string,
  rungateDir: string,
  listDir: (dir: string) => string[] | null,
): HookTreeCensus {
  const reasons: string[] = [];
  const read = (dir: string, label: string): string[] => {
    const entries = listDir(dir);
    if (entries === null) {
      reasons.push(
        `the ${label} hook tree at ${dir} could not be read, so a duplicate between the two ` +
          `trees cannot be ruled out. This is not "no duplicates".`,
      );
      return [];
    }
    return entries.filter(n => HOOK_FILE.test(n)).map(n => n.replace(HOOK_FILE, "")).sort();
  };

  const pai = read(paiDir, "PAI");
  const rungate = read(rungateDir, "rungate");

  // ONE decider for "an unreadable tree contributes no duplicates": `read`
  // returns an empty list beside its reason, so the intersection below is
  // empty by construction. A `reasons.length === 0 ? … : []` guard here as
  // well would be a second decider for the same question — mutating it was
  // row M8 of the battery and measured **0 red**, because there is no input
  // on which the two versions differ. Per
  // `.claude/rules/checks-must-be-able-to-fail.md` that is a collapsed pair,
  // not a gap in the cases, so it was collapsed rather than banked.
  const duplicates = pai.filter(n => rungate.includes(n));

  return {
    reading: reasons.length === 0 ? "MEASURED" : "UNMEASURED",
    unmeasuredReasons: reasons,
    duplicates,
    pai,
    rungate,
  };
}
