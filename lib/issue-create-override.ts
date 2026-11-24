import { homedir } from "os";
import { join, resolve } from "path";

import { forEachChild, parse } from "unbash";
import { interpreterPrograms } from "./bash-write-guard";

/**
 * Whether a `gh issue create` may run during VERIFY, and why not (#365).
 *
 * `hooks/VerifyPhaseLock.hook.ts` asked the question in eight lines:
 *
 *     if (cmd.includes('--label') && cmd.includes('follow-up')) process.exit(0);
 *
 * That is not a test that a label argument equals `follow-up`. It is a test
 * that the string `follow-up` appears SOMEWHERE in the command, so
 *
 *     gh issue create --label bug --title "Fix the follow-up handler"
 *
 * bypasses the lock entirely while applying no override label at all. A
 * detector whose input is the whole command string cannot tell an argument
 * from a word in a title — shape two of
 * `.claude/rules/checks-must-be-able-to-fail.md`, pointed outward: the guard
 * is wider than the thing it guards.
 *
 * The same shape hid a second bypass one line down. `cmd.includes('gh issue
 * comment')` is unreachable for a plain comment, because the create check
 * above it has already exited — but it IS reachable for
 * `gh issue comment … && gh issue create …`, where the comment clause
 * exempts the create clause.
 *
 * ## The second defect is about the tracker, not the hook
 *
 * `follow-up` means "follow-up work from a shipped issue", and it was the
 * only override, so anything filed during VERIFY had to claim an origin it
 * did not have. On 2026-10-13 an external audit of two consumer projects
 * surfaced three consumer-blocking defects here; #362, #363 and #364 all
 * wear `follow-up` and not one of them is follow-up work from a shipped
 * issue. An agent filtering that label to find loose ends from recent ships
 * gets three unrelated results. `external-audit` exists for exactly that
 * origin and is accepted here.
 *
 * ## What this is, and what it is not
 *
 * Stated because two rounds of commit security review walked the parser
 * inward and a third would too. **This is workflow discipline over `gh`
 * invocations reaching PreToolUse on Bash. It is not a sandbox.** It exists
 * to catch a reflex — an agent mid-VERIFY reaching for `gh issue create`
 * when `verifyBlockers[]` is the right place — and a reflex is defeated by
 * saying no to the command shapes someone actually types.
 *
 * So the parser is held to ordinary shapes: operators with or without
 * surrounding whitespace, newlines, subshells, command substitution
 * including backticks, quoted or not (#2722), a path-qualified binary, quoted arguments, trailing
 * `#` comments, backslash line continuations, and `-c` / `-lc` / `eval`
 * wrappers. **Every one of those was a measured bypass of an earlier version
 * of this file**, and each has a row in `test/verify-phase-lock.test.ts`.
 *
 * Out of scope ON PURPOSE, and not a gap to file:
 *
 * - `curl` against the REST API, or the GitHub MCP tools — neither is Bash,
 *   so the hook never sees them.
 * - `ssh host "gh issue create …"` — that runs on another machine against
 *   whatever repo it is configured for, and descending into every remote
 *   command mentioning `gh` buys false refusals, not safety.
 * - Variable indirection — `GH=gh; $GH issue create`. Resolving it means
 *   tracking assignments across clauses, which is the shell interpreter this
 *   file is explicitly not, and nobody reaches for `$GH` by reflex.
 * - A caller who writes a script and runs it.
 * - A `cd` in an earlier clause, which retargets the tracker invisibly.
 *   Resolving it needs directory state across clauses, same reason as above.
 *
 * Each of those takes a decision to get around the lock, and an agent that
 * has made that decision is a problem no matcher fixes. Chasing them trades
 * false refusals — which teach people to work around a guard — for
 * protection against someone already doing so.
 *
 * **Here-strings and here-documents left this list in #1302, and the entry is
 * kept here rather than deleted because the reason it gave was wrong.** It
 * read "a deliberate construction, not a reflex" — an argument about how
 * often a shape is typed, which is not a property of the input and cannot be
 * measured. What settled it was that the body of a heredoc had to be parsed
 * either way: `clauses` was reading the bodies that go into FILES, which is
 * the one case that is certainly not a command, and refusing real work for
 * it. Once `stripHeredocs` removes those, `interpreterPrograms` has to put
 * the executable ones back, and that binding returns herestrings in the same
 * list. So the scope widened as a consequence of fixing a false refusal, and
 * narrowing it again would mean writing a second decider that disagrees with
 * `lib/bash-write-guard.ts`. See `clauses` below.
 */

/** Labels that permit an issue to be filed mid-VERIFY, and what each means. */
export const OVERRIDE_LABELS: Record<string, string> = {
  "follow-up": "follow-up work from a shipped issue",
  "external-audit": "a defect found outside the ship loop",
};

/**
 * Shell operators that end one command and begin another.
 *
 * Emitted as their OWN tokens, which is the whole point. The first version
 * of this file split on whitespace alone, so `foo;gh issue create` and
 * `gh issue comment 1&&gh issue create` produced the tokens `foo;gh` and
 * `1&&gh` — and since those are not the word `gh`, `createsIssue` said no
 * and the lock allowed both. That is the same defect as the substring
 * matcher this file replaced, one layer in: a parser that disagrees with the
 * shell about where a command begins. Found by the commit security review,
 * not by me.
 *
 * A newline is in the list for the same reason. Without it,
 * `gh issue create --label follow-up` and `gh issue create --label bug` on
 * two lines are one clause, and the first line's override covers the second.
 *
 * Backticks are here for the same reason `(` and `)` are: they delimit a
 * command substitution, and without them `` `gh issue create` `` yields the
 * token `` `gh `` rather than `gh`.
 *
 * Longest first: `&&` must be tried before `&`, `||` before `|`.
 */
const OPERATORS = ["&&", "||", ";;", ";", "|", "&", "(", ")", "`", "\n"];

/**
 * Split a command the way a shell would, so an argument can be told from a
 * word inside a quoted string — and an operator from a word glued to one.
 *
 * Not a full shell parser and does not need to be: the only question is
 * where one command ends and the next begins, and which tokens are its
 * arguments. Unterminated quotes yield the rest of the string as one token,
 * which keeps a malformed command from splitting into things that look like
 * flags nobody wrote.
 */
export function tokenize(cmd: string): string[] {
  return scanTokens(cmd).tokens;
}

/**
 * `tokenize`'s scan. A `$(…)` or backtick substitution inside a double-quoted
 * string stays part of its word, as the shell keeps it (#2722).
 */
function scanTokens(cmd: string): { tokens: string[] } {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  const flush = () => {
    if (started) out.push(cur);
    cur = "";
    started = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "\\" && quote !== "'" && i + 1 < cmd.length) {
      // A backslash-newline is a line continuation: it joins, and adds
      // nothing. Treating it as an escaped character put a literal newline
      // inside the token, so `gh issue \⏎ create` produced `\ncreate` and
      // the lock allowed it — and wrapping a long command across lines is
      // something people do on purpose.
      if (cmd[i + 1] === "\n") {
        i++;
        continue;
      }
      cur += cmd[++i];
      started = true;
      continue;
    }
    // `#` starts a comment only at the start of a word, which is the shell's
    // own rule. Without it, `--label bug # --label follow-up` read the
    // commented-out override as a real one.
    if (!quote && !started && c === "#") {
      while (i < cmd.length && cmd[i] !== "\n") i++;
      i--;
      continue;
    }
    if (quote === '"' && c === "$" && cmd[i + 1] === "(") {
      const end = substitutionEnd(cmd, i + 2);
      cur += cmd.slice(i, end + 1);
      i = end;
      continue;
    }
    if (quote === '"' && c === "`") {
      let j = i + 1;
      while (j < cmd.length && cmd[j] !== "`") j += cmd[j] === "\\" ? 2 : 1;
      cur += cmd.slice(i, j + 1);
      i = j;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    const op = OPERATORS.find(o => cmd.startsWith(o, i));
    if (op) {
      flush();
      out.push(op);
      i += op.length - 1;
      continue;
    }
    if (/\s/.test(c)) {
      flush();
      continue;
    }
    cur += c;
    started = true;
  }
  flush();
  return { tokens: out };
}

/**
 * The commands a command line runs, one array of words per command, read with
 * a bash grammar (`unbash`, #2727) and descending into `-c`.
 *
 * The grammar decides where every command begins and ends: inside a quoted
 * substitution, a nested one, a `case` branch, an unquoted heredoc's `$(…)`,
 * a subshell, and with ANSI-C quoting decoded. The hand-written tokenizer this
 * replaced misread each of those (#2719, #2723 review rounds), and each
 * misread let a filing or a board write through. A quoted heredoc expands
 * nothing, and its body yields no command, as the shell runs none.
 *
 * **A command the grammar reports malformed is not read a second way.** The
 * grammar can be wrong about valid bash: `unbash` 6.0.5 reads `case` as a
 * keyword in `echo "$(printf case x)"; gh issue create`, reports the
 * substitution unterminated, and the filing after it becomes part of a word.
 * #2735 read such a command again with the hand-written token reader, and each
 * of its review rounds found the next shape that reader misread. So each guard
 * asks `unreadableFiling()` first, and refuses a malformed command that names
 * `gh` as one it cannot read (#2743). Measured on 139,243 real commands: 97
 * parse with errors.
 *
 * Two places stay outside the grammar, because the shell hands them on as
 * text: a heredoc or herestring given to an interpreter (`interpreterPrograms`,
 * the same reading `lib/bash-write-guard.ts` uses), and an argument that is
 * itself a command (`bash -c '…'`, `eval '…'`, `commandArguments`). Each is
 * parsed in turn, to the same depth of 4.
 *
 * The recursion is why `echo 'gh issue create --label bug'` stays allowed
 * while `bash -c 'gh issue create --label bug'` does not. A quoted string is
 * data to `echo` and a command to a shell, and only the second one files an
 * issue.
 *
 * **There is deliberately no allowlist of shell names here.** The first
 * version had one, and removing it scored **0 red of 38**: a non-shell
 * interpreter's `-c` argument is source code, which quotes the command it
 * runs, so `createsIssue` never sees three adjacent words in it.
 */
export function clauses(cmd: string, depth = 0): string[][] {
  const out: string[][] = [];
  for (const text of [cmd, ...interpreterPrograms(cmd).map(p => p.program)]) {
    for (const c of parsedCommands(text).commands) {
      out.push(c);
      if (depth >= 4) continue; // a wrapper chain this deep is not an accident
      for (const inner of commandArguments(c)) out.push(...clauses(inner, depth + 1));
    }
  }
  return out;
}

/** An unbash syntax node, read structurally. */
type SyntaxNode = { type?: string; [key: string]: unknown };

/**
 * One command's words as the shell hands them to the program: its assignments
 * as written, its name, then its arguments with quotes removed and ANSI-C
 * quoting decoded. Redirections are not words, and an expansion stays as
 * written.
 */
function commandWords(node: SyntaxNode): string[] {
  const words: string[] = [];
  for (const p of (node.prefix as SyntaxNode[] | undefined) ?? []) {
    if (p.type === "Assignment") words.push(String(p.text));
  }
  const name = node.name as SyntaxNode | undefined;
  if (name !== undefined) words.push(String(name.value));
  for (const a of (node.suffix as SyntaxNode[] | undefined) ?? []) {
    if (a.type === "Word") words.push(String(a.value));
    else if (a.type === "Assignment") words.push(String(a.text));
  }
  return words;
}

/** Every command `text` runs, in source order, each as its words, and whether the grammar's reading of it is `malformed`. */
function parsedCommands(text: string): { commands: string[][]; malformed: boolean } {
  const commands: string[][] = [];
  const walk = (node: SyntaxNode): void => {
    if (node.type === "Command") {
      const words = commandWords(node);
      if (words.length > 0) commands.push(words);
    }
    forEachChild(node as never, walk as never);
  };
  const script = parse(text) as unknown as SyntaxNode;
  walk(script);
  return { commands, malformed: malformed(script) };
}

/**
 * Whether the grammar's reading of a text cannot be trusted: it reported
 * errors, or a heredoc's delimiter never arrived. Bash only warns about the
 * second, but a filing behind an unclosed delimiter must not become invisible
 * (FG-43, kept from #1302), so it is unreadable too (#2743).
 */
function malformed(script: SyntaxNode): boolean {
  let unclosed = false;
  const walk = (node: SyntaxNode): void => {
    if (node.type === "HereDoc" && node.closing === undefined) unclosed = true;
    forEachChild(node as never, walk as never);
  };
  walk(script);
  return unclosed || ((script.errors as unknown[] | undefined)?.length ?? 0) > 0;
}

/** How every guard's refusal of a command it cannot read begins (#2743). */
export const UNREADABLE_COMMAND = "Cannot read this command";

/** A shell, whose `-c` argument is a command line the shell itself runs. */
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/**
 * Why no guard can read this command, or null when it can (#2743).
 *
 * A command line the shell runs is unreadable when the grammar reports it
 * malformed (`malformed()`) and it names `gh`. That covers the command itself,
 * a heredoc handed to a shell, and a shell's `-c` or `eval` argument, to the
 * depth of 4 `clauses()` uses. A non-shell program (`python3 -c`, a heredoc
 * handed to `node`) is not bash, so its failing to parse as bash says nothing.
 * `gh` is looked for with quotes and backslashes taken out, and any ANSI-C
 * `$'…'` counts, since one can spell it: this decides only which unreadable
 * commands are refused, so it errs toward refusing.
 *
 * Every guard asks this before it reads the command, and so reads a command
 * one way only. #2735 read a malformed command a second time with the
 * hand-written token reader, and each of its review rounds found the next
 * shape that reader misread.
 */
export function unreadableFiling(cmd: string, depth = 0): string | null {
  const texts = [cmd, ...interpreterPrograms(cmd).filter(p => p.shell).map(p => p.program)];
  for (const text of texts) {
    const read = parsedCommands(text);
    if (read.malformed && (/\bgh\b/.test(text.replace(/["'\\]/g, "")) || text.includes("$'"))) {
      return (
        `${UNREADABLE_COMMAND}: the bash grammar reports it malformed and it names gh, so no guard can tell ` +
        "what it would run (#2743). Give each gh call a simple command of its own. Two known causes: the " +
        'word case as an argument inside $( ), as in "$(printf case x)", and a heredoc whose closing ' +
        "delimiter never arrives."
      );
    }
    if (depth >= 4) continue;
    for (const c of read.commands) {
      if (!c.some(w => SHELLS.has(basename(w)) || basename(w) === "eval")) continue;
      for (const inner of commandArguments(c)) {
        const why = unreadableFiling(inner, depth + 1);
        if (why !== null) return why;
      }
    }
  }
  return null;
}

/**
 * The offset of the `)` closing a `$(` whose text starts at `from`, or the end
 * of `cmd`. Inside it the quoting starts afresh, and a `#` starting a word is a
 * comment to the end of the line, as `tokenize` reads one (#2723 review).
 *
 * It does not read `case`: a pattern's `)` closes the substitution as any `)`
 * does, so a filing in a later branch is text in the outer word, as on main.
 * Rounds 2 to 5 of #2723 read case statements, and each round found the next
 * miss in that reading, so it was taken out (rule 5). How this file reads a
 * command at all is the follow-up issue's.
 */
function substitutionEnd(cmd: string, from: number): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let j = from; j < cmd.length; j++) {
    const c = cmd[j];
    if (c === "\\" && quote !== "'") {
      j++;
      continue;
    }
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "#" && (j === from || /[\s;&|(]/.test(cmd[j - 1]))) {
      while (j < cmd.length && cmd[j] !== "\n") j++;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) return j;
      depth--;
    }
  }
  return cmd.length;
}

/**
 * The directory the first `gh issue create` in this command runs in (#1833).
 *
 * **An issue is a repository object, so nothing about a filing may depend on
 * the session that happened to type it.** The gate used to hand every stage
 * `process.cwd()` — the directory the HOOK was spawned in, which is the
 * session's launch directory and not the command's. Measured 2026-11-06: one
 * `gh issue create` run in `rg-wt-1675` was attributed to `rg-wt-threads2`,
 * named a branch the command never touched, and reported a 735-byte
 * `--body-file` as unreadable because it looked for it in the other checkout.
 *
 * **The directory is IN the command, and that is not a coincidence.** This
 * repository forbids a top-level `cd` (`hooks/TopLevelCdGuard.hook.ts`), so
 * every command that runs somewhere other than the session's directory
 * spells that directory out — `(cd <path> && …)`. There is nowhere else to
 * read it from: the hook payload carries the SESSION's directory, which is
 * the value that was already wrong.
 *
 * **Subshell-aware, because the shell is.** A `cd` inside `( … )` or a
 * command substitution is undone when that scope closes, so
 * `(cd /a && echo) && gh issue create` files from `from` and not from `/a`.
 *
 * **It descends into `-c` and `eval` arguments, exactly where `clauses()`
 * does and for the same reason.** `bash -c "cd /wt/a && gh issue create …"`
 * is a filing — `createsIssue` sees it through that recursion — so a reader
 * of the top-level token stream alone would detect the filing and attribute
 * it to the session, which is the whole of #1833 reached by another route.
 * The inner scope's directory is discarded and only a filing found inside it
 * is kept, because a wrapper's `cd` does not outlive the wrapper.
 *
 * A command the grammar reports malformed, and that names `gh`, is refused by
 * every guard before this runs (`unreadableFiling`, #2743). On one that names
 * no `gh` there is no filing to place.
 *
 * ## Two documented limits, both asserted rather than assumed
 *
 * **One answer per command, taken at the FIRST filing.** A command filing
 * twice from two different directories would need two, and no such command
 * has ever been written here; one binding that is sometimes coarse beats two
 * that can disagree (`.claude/rules/checks-must-be-able-to-fail.md`, the
 * fourth shape).
 *
 * **A `cd` target the shell expands at run time is resolved as written.**
 * A variable, a command substitution, a glob or `~user` needs the shell's
 * state, not the command's text. Written out, it names a directory that does
 * not exist, so the gate cannot read a body, a plan or a committed config
 * there, and it refuses. That is the safe direction. Leaving the directory
 * alone instead, as review round 2 of #2735 had it, read the session's
 * checkout, where a stale `--body-file` is readable and wrong (round 3).
 * `cd -` still leaves the directory alone: it needs `OLDPWD`. A bare `cd` IS
 * resolvable and goes to `homedir()`, and so are `~` and `~/path`.
 */
export function filingDirectory(cmd: string, from: string): string {
  return scanForFiling(cmd, from, 0).found ?? from;
}

/**
 * One scope's worth of the scan: the filing's directory if this text files,
 * and the directory the text ends in. A walk of the grammar `clauses()` reads
 * (#2727), in source order:
 *
 * - a `cd` moves the directory of the scope it runs in;
 * - a subshell, and a command or process substitution, is a scope of its own,
 *   entered with the directory it is read in, and its `cd` does not outlive it;
 * - a command's substitutions run before the command, in its directory;
 * - a wrapper's command argument (`bash -c '…'`) runs in the directory the
 *   wrapper was invoked from, and only a filing found inside it is kept.
 *
 * A heredoc or herestring handed to an interpreter is scanned after the
 * command, in the directory the command ends in, as it was before the grammar.
 * `depth` bounds the recursion at the same 4 `clauses()` uses.
 */
function scanForFiling(
  cmd: string,
  from: string,
  depth: number,
): { found: string | null; dir: string } {
  const top = { dir: from };
  let found: string | null = null;

  const run = (node: SyntaxNode, scope: { dir: string }): void => {
    if (found !== null) return;
    if (node.type === "Subshell" || node.type === "CommandExpansion" || node.type === "ProcessSubstitution") {
      const inner = { dir: scope.dir };
      forEachChild(node as never, ((c: SyntaxNode) => run(c, inner)) as never);
      return;
    }
    if (node.type !== "Command") {
      forEachChild(node as never, ((c: SyntaxNode) => run(c, scope)) as never);
      return;
    }
    forEachChild(node as never, ((c: SyntaxNode) => run(c, scope)) as never);
    if (found !== null) return;
    const words = commandWords(node);
    if (words.length === 0) return;
    if (createsIssue(words)) {
      found = scope.dir;
      return;
    }
    if (depth < 4) {
      for (const inner of commandArguments(words)) {
        const nested = scanForFiling(inner, scope.dir, depth + 1);
        if (nested.found !== null) {
          found = nested.found;
          return;
        }
      }
    }
    if (words[0] === "cd") scope.dir = cdTarget(words.slice(1), scope.dir);
  };

  run(parse(cmd) as unknown as SyntaxNode, top);
  if (depth < 4) {
    for (const p of interpreterPrograms(cmd)) {
      if (found !== null) break;
      const nested = scanForFiling(p.program, top.dir, depth + 1);
      if (nested.found !== null) found = nested.found;
    }
  }
  return { found, dir: top.dir };
}

/** Where a `cd` with these arguments lands, or `dir` when it cannot be read. */
function cdTarget(args: string[], dir: string): string {
  const path = args.filter(a => !a.startsWith("-"));
  if (path.length === 0) return args.includes("-") ? dir : homedir();
  if (path.length > 1) return dir;
  const target = path[0];
  if (target === "~") return homedir();
  if (target.startsWith("~/")) return join(homedir(), target.slice(2));
  return resolve(dir, target);
}

/** Arguments of this clause that are themselves commands. */
function commandArguments(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (COMMAND_FLAG.test(t) || basename(t) === "eval") {
      if (i + 1 < tokens.length) out.push(tokens[i + 1]);
    }
  }
  return out;
}

/** The program a token names, ignoring any path it was reached by. */
const basename = (t: string) => t.split("/").pop()!;

/**
 * `gh api` flags that do NOT consume the following token.
 *
 * **Read off `gh api --help` on 2026-11-06, not guessed.** Rounds 1 and 2
 * of #1805 each repaired one spelling of this parser that had been reasoned
 * about rather than enumerated, and the enumeration immediately produced
 * two things neither round had: `--allow-escape-sequences` was missing from
 * this set, and `-f` is `--raw-field` while `-F` is `--field` — the
 * opposite of what the round-1 comment said.
 *
 * Everything else beginning with `-` is assumed to take a value, which is
 * the same conservative convention `BOOLEAN_FLAGS` follows above: guessing
 * that a flag takes a value makes the scan skip a token it should have
 * read, and the failure is a filing the gate does not recognise — visible.
 * Guessing the other way desyncs the scan and makes a flag's VALUE read as
 * the endpoint, which is a filing recognised against the wrong URL.
 */
export const API_BOOLEAN_FLAGS = new Set([
  "--allow-escape-sequences",
  "--paginate",
  "-i",
  "--include",
  "--silent",
  "--slurp",
  "--verbose",
]);

/**
 * Flags of `gh api` whose value is a `key=value` field.
 *
 * `-F`/`--field` is typed and `-f`/`--raw-field` is a string; the
 * distinction does not matter to a gate reading titles. Both also accept
 * `key=@path` and `key=@-` to take the value from a file or stdin — a
 * DECLARED limit here: the key is seen, so the clause is still recognised
 * as a filing, but the value resolves to the literal `@path` rather than
 * the file's contents, so the dedupe compares a path. That is the safe
 * direction — adjudicated, not missed — and it is written down rather than
 * left for a sixth round to find.
 */
const API_FIELD_FLAGS = new Set(["--field", "-F", "--raw-field", "-f"]);

/** A `gh api` clause, read in one walk. */
export interface ApiCall {
  /** The first positional token — the endpoint — or `null`. */
  readonly endpoint: string | null;
  /** `-X`/`--method`, upper-cased, or `null` when it was not given. */
  readonly method: string | null;
  /** Every `key=value` field, last on the LINE wins, as `gh` reads them. */
  readonly fields: Map<string, string>;
  /** Was a body supplied with `--input`? */
  readonly hasInput: boolean;
}

/**
 * ONE walk over a `gh api` clause's tokens.
 *
 * ai-review round 1 of #1805 raised four findings and all four were this
 * function not existing. The first cut read the endpoint with its own loop
 * and the method and fields with `flagValues`, which consults
 * `BOOLEAN_FLAGS` — the set belonging to `gh issue create`. So
 * `gh api --silent -f title=… repos/o/r/issues`, which files an issue,
 * desynced: `--silent` was assumed to take a value, the scan skipped the
 * `-f`, and the clause resolved to no fields and no method. Two scanners
 * with two grammars over one command, and only one of them had been told
 * which command it was reading.
 *
 * Reading the fields in one pass is also what makes *last wins* true. The
 * first cut collected every `-f` and then every `-F`, so
 * `-F title=A -f title=B` landed on `A` — the opposite of what `gh` sends.
 *
 * ## Two deliberate readings
 *
 * **`--` does not end the walk.** pflag treats it as end-of-options, so a
 * real `gh` may well reject what follows; this skips it and keeps reading,
 * which can only make a clause MORE likely to be seen as a filing. That is
 * the safe direction for a gate, and `--` becoming the endpoint was a
 * filing that walked straight through.
 *
 * **An unknown flag takes a value**, the same convention `BOOLEAN_FLAGS`
 * follows: guessing that way costs a skipped token and an unrecognised
 * filing, which is visible. Guessing the other way desyncs the scan and
 * reads a flag's value as the endpoint — a filing recognised against the
 * wrong URL, which is worse and quieter.
 */
export function apiCall(tokens: string[]): ApiCall | null {
  const rest = afterGhSubcommand(tokens, "api");
  if (rest === null) return null;
  let endpoint: string | null = null;
  let method: string | null = null;
  let hasInput = false;
  const fields = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === "--") continue;
    if (!t.startsWith("-") || t === "-") {
      // Normalised HERE and nowhere else. Five consumers read this field;
      // normalising at each of them is five chances to forget, and round 3
      // of #1805 is what forgetting once costs.
      if (endpoint === null) endpoint = barePath(t);
      continue;
    }
    // **The attached short form is resolved BEFORE the `=` split, and the
    // order is the whole of it.** `-ftitle=x` is one token whose value is
    // itself a `key=value` pair, so splitting on the first `=` reads the
    // flag as `-ftitle` and drops the field — and a field flag's value is
    // ALWAYS a pair, so the one attached form that matters was the only
    // one that could not work. ai-review round 2 of #1805; the round
    // before it shipped this as a comment with no case behind it.
    let name = t;
    let value: string | null = null;
    const attached = t.startsWith("--") ? null : /^-([A-Za-z])(.+)$/.exec(t);
    if (attached !== null) {
      name = `-${attached[1]}`;
      value = attached[2];
    } else {
      const eq = t.indexOf("=");
      if (eq !== -1) {
        name = t.slice(0, eq);
        value = t.slice(eq + 1);
      }
    }
    if (value === null && !API_BOOLEAN_FLAGS.has(name) && i + 1 < rest.length) {
      value = rest[++i];
    }
    if (name === "--input") hasInput = true;
    else if (name === "-X" || name === "--method") {
      if (value !== null) method = value.toUpperCase();
    } else if (API_FIELD_FLAGS.has(name) && value !== null) {
      const at = value.indexOf("=");
      if (at > 0) fields.set(value.slice(0, at), value.slice(at + 1));
    }
  }
  return { endpoint, method, fields, hasInput };
}

/** The REST issues COLLECTION — `repos/<owner>/<repo>/issues`, nothing deeper. */
const ISSUES_COLLECTION = /^\/?repos\/([^/?]+)\/([^/?]+)\/issues\/?(?:\?.*)?$/;

/**
 * An endpoint as a bare path, whichever way it was written.
 *
 * `gh api` takes a fully-qualified URL as well as a path — it is how a
 * Link-header pagination URL is replayed and how a GitHub Enterprise host
 * is addressed — and posts it exactly the same way. ai-review round 3 of
 * #1805: `https://api.github.com/repos/o/r/issues` matched neither the
 * collection regex nor `graphql`, so a filing spelled that way walked
 * around a gate that had just been widened twice.
 *
 * The `/api/v3` and `/api` prefixes are GHES's REST and GraphQL mounts.
 * Stripping them makes the two hosts one shape, which is the point: a
 * second regex per host is a second decider.
 */
function barePath(endpoint: string): string {
  const withoutHost = endpoint.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "");
  return withoutHost.replace(/^\/api(?:\/v3)?\//, "/").replace(/^\//, "");
}

/**
 * The `owner/repo` a `gh api` filing targets, or `null`.
 *
 * The REST path carries it; a GraphQL `createIssue` carries a
 * `repositoryId`, which is an opaque node id and not a slug, so that one is
 * honestly `null` rather than guessed at. `null` means the dedupe runs
 * against the session's default repo, which is the existing behaviour for
 * a `gh issue create` with no `--repo`.
 */
export function apiFilingRepo(tokens: string[]): string | null {
  const call = apiCall(tokens);
  const m = call === null ? null : ISSUES_COLLECTION.exec(call.endpoint ?? "");
  return m === null ? null : `${m[1]}/${m[2]}`;
}

/**
 * The fields of a REST issues-collection filing, or `null`.
 *
 * `null` for every clause that is not one — including `graphql`, which has
 * its own reader — so a caller gets a map only when the map means what it
 * thinks it means.
 */
export function apiRestFields(tokens: string[]): Map<string, string> | null {
  const call = apiCall(tokens);
  if (call === null || !ISSUES_COLLECTION.test(call.endpoint ?? "")) return null;
  return call.fields;
}

/**
 * The GraphQL `query` variables this clause passes, or `null`.
 *
 * `gh api graphql -f query='mutation($title: String!){…}' -f title="…"` is
 * the form `gh`'s own documentation recommends, because it avoids escaping
 * quotes by hand. ai-review round 1 of #1805: the first cut read literals
 * out of the document only, so the idiomatic spelling resolved to an empty
 * title and an empty body — counted as a filing and compared against
 * nothing, which is the one outcome worse than not counting it.
 */
export function graphqlVariables(tokens: string[]): Map<string, string> | null {
  const call = apiCall(tokens);
  if (call === null || call.endpoint !== "graphql") return null;
  return call.fields;
}

/** The tokens after `gh <sub>`, or `null` when this clause is not that. */
function afterGhSubcommand(tokens: string[], sub: string): string[] | null {
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (basename(tokens[i]) === "gh" && tokens[i + 1] === sub) return tokens.slice(i + 2);
  }
  return null;
}

/** A `mutation { … createIssue( … ) … }` in a GraphQL document. */
const CREATE_ISSUE_MUTATION = /\bmutation\b[\s\S]*\bcreateIssue\s*\(/;

/**
 * The GraphQL document this clause sends, or `null`.
 *
 * `gh api graphql` takes it as the `query` field whichever field flag
 * spells it.
 */
export function graphqlDocument(tokens: string[]): string | null {
  return graphqlVariables(tokens)?.get("query") ?? null;
}

/**
 * Does this clause create an issue?
 *
 * Three spellings, one decider (#1759). Measured on 2026-11-02, the first
 * two of these returned nothing: `gh api repos/<o>/<r>/issues` and a
 * `createIssue` GraphQL mutation both file an issue and neither is spelled
 * `gh issue create`, so two of three filings walked around the gate that
 * exists to count them.
 *
 * Compared on the basename, because `/usr/bin/gh issue create` and
 * `./gh issue create` are the same command and the first version of this
 * function allowed both.
 *
 * ## Reading is not filing, and that is the hard half
 *
 * `repos/<o>/<r>/issues` is the LIST endpoint as well as the create
 * endpoint; the method is what separates them, and `gh api` chooses POST
 * implicitly when any field is supplied. So a create is *fields present or
 * POST asked for*, and an explicit `GET`/`HEAD` is a read whatever else is
 * on the line.
 *
 * The regex stops at the collection — `issues/1759/comments` is deeper and
 * is not a filing. That boundary is load-bearing rather than tidy: this
 * gate's own refusals tell an agent to post a comment instead, so a parser
 * that read any `gh api` touching `issues` would refuse the remedy it
 * prescribes.
 */
export function createsIssue(tokens: string[]): boolean {
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (basename(tokens[i]) === "gh" && tokens[i + 1] === "issue" && tokens[i + 2] === "create") {
      return true;
    }
  }
  const call = apiCall(tokens);
  if (call === null) return false;
  const { endpoint, method, fields, hasInput } = call;
  if (method === "GET" || method === "HEAD") return false;
  if (endpoint === "graphql") {
    // `--input` puts the document in a file, or on stdin, and this does
    // not read it. A document nobody read is UNMEASURED, not absent, and
    // UNMEASURED adjudicates — the same reading the REST arm below already
    // takes of the same flag. ai-review round 3 of #1805 found the two
    // arms disagreeing about one flag, which is the only fact that makes
    // either of them wrong.
    return hasInput || CREATE_ISSUE_MUTATION.test(fields.get("query") ?? "");
  }
  if (!ISSUES_COLLECTION.test(endpoint ?? "")) return false;
  return fields.size > 0 || hasInput || method === "POST";
}

/**
 * Flags whose next argument is a command string rather than data.
 *
 * `-c`, but also `-lc` and `-ic`: short flags combine, and only the last
 * letter takes the argument, so `sh -lc "…"` is a login shell running a
 * command. Both of those were allowed until the second security review.
 */
const COMMAND_FLAG = /^-[A-Za-z]*c$/;

/**
 * Flags of `gh issue create` that do NOT consume the following token.
 *
 * Everything else that looks like a flag is assumed to take a value, which
 * is the conservative direction here — see `labelValues`.
 */
const BOOLEAN_FLAGS = new Set(["-w", "--web", "-h", "--help", "--recover-only"]);

/**
 * The values passed to `--label` / `-l`, in both the spaced and `=` forms.
 *
 * `gh` accepts a comma-separated list in one flag, so `--label a,b` is two
 * labels and not one named `a,b`.
 *
 * **A token that is another flag's value is data, not a flag.** Scanning for
 * `--label=` anywhere in the clause reintroduced #365 exactly — the defect
 * this whole file exists to fix — through the back door:
 *
 *     gh issue create --label bug --title "--label=follow-up"
 *
 * `gh` gives that title to the issue and applies only `bug`; the old scan
 * read the title as an override and allowed it. Found by the third round of
 * commit security review, and it is the same bypass as the original with one
 * more layer of quoting. The unquoted form is the same command — the shell
 * strips the quotes either way, so the quoting is not what makes it work.
 *
 * So the walk tracks arity the way `gh`'s own flag parser does: a flag
 * consumes the next token unless it is known to be boolean. An unknown flag
 * is assumed to take a value, which can only ever cause a `--label` to be
 * MISSED — and a missed label is a refusal, the direction this guard is
 * allowed to be wrong in.
 */
export interface FlagQuery {
  /** The long form, with its dashes: `--label`. */
  long: string;
  /** The short form, with its dash: `-l`. Omit when there is none to read. */
  short?: string;
  /** `gh` reads `--label a,b` as two labels. A title is one value. */
  commaSeparated?: boolean;
}

/** `--label` / `-l`, the one query this file's own decision needs. */
export const LABEL_FLAG: FlagQuery = { long: "--label", short: "-l", commaSeparated: true };

/**
 * Short flags of `gh issue create` whose value may be ATTACHED: `-lfollow-up`.
 *
 * `-a` assignee, `-b` body, `-F` body-file, `-l` label, `-m` milestone,
 * `-p` project, `-t` title, `-T` template, `-R` repo. `-w` and `-h` are
 * boolean and live in `BOOLEAN_FLAGS`.
 *
 * **One table, consulted by every query, because where a token ends is a
 * property of the COMMAND and not of the question being asked.** The first
 * cut of this made it a per-query letter, so a walk looking for `--title`
 * recognised `-tFoo` as attached while a walk looking for `--label` read the
 * same token as an unknown flag and blindly consumed the one after it. Two
 * readings of one command line, disagreeing about token boundaries — found
 * by the AI review on #1282, which is right that the consequence is a
 * silently dropped argument: `gh issue create -tFoo --body "…"` lost the
 * body, so the finding arrived with no symptom and escaped the dedupe.
 *
 * It is a real change to `labelValues`, and in the direction of accuracy.
 * `gh issue create -aalice --label follow-up` applies the override label and
 * was REFUSED before this, because `-aalice` ate the `--label`. That was the
 * accepted error direction — a missed label is a refusal — but it was still
 * a wrong answer about a command somebody can type, and nothing about the
 * widening lets a label be read where none was written: the token after an
 * attached short is now parsed on its own merits rather than swallowed, and
 * it still has to BE a `--label` argument to count. An unknown short flag is
 * absent from this table and keeps the old conservative default.
 */
const VALUE_SHORT_FLAGS = new Set(["a", "b", "F", "l", "m", "p", "t", "T", "R"]);

/** `-lfollow-up` — a short flag with its value glued on. */
const ATTACHED_SHORT = /^-([A-Za-z])[^-=]/;

/**
 * The values passed to one flag of a `gh issue create` clause.
 *
 * One arity walk, parameterised, so a second reader of the same clause — see
 * `lib/issue-filing-gate.ts`, which needs `--title` and `--body` — agrees with
 * this one about where a flag's value is. Two walks would disagree the first
 * time either learned a flag the other did not have.
 */
export function flagValues(tokens: string[], q: FlagQuery): string[] {
  const out: string[] = [];
  const add = (v: string) => {
    for (const part of q.commaSeparated === true ? v.split(",") : [v]) {
      const t = q.commaSeparated === true ? part.trim() : part;
      if (t) out.push(t);
    }
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith("-") || t === "-" || t === "--") continue;

    const eq = t.indexOf("=");
    if (eq !== -1) {
      const name = t.slice(0, eq);
      if (name === q.long || name === q.short) add(t.slice(eq + 1));
      continue; // `--flag=value` carries its own value; it consumes nothing
    }
    if (t === q.long || t === q.short) {
      if (i + 1 < tokens.length) add(tokens[++i]);
      continue;
    }
    // `-lfollow-up` — pflag lets a short flag carry its value attached. Its
    // value is IN the token, so it consumes nothing whether or not it is the
    // flag this query is collecting. That second half is the fix: a query
    // that skipped it here would also skip the `continue` and eat the next
    // token, which is the desync `VALUE_SHORT_FLAGS` exists to prevent.
    const attached = ATTACHED_SHORT.exec(t);
    if (attached !== null && VALUE_SHORT_FLAGS.has(attached[1])) {
      if (q.short === `-${attached[1]}`) add(t.slice(2));
      continue;
    }
    if (!BOOLEAN_FLAGS.has(t)) i++; // this flag eats the next token
  }
  return out;
}

export function labelValues(tokens: string[]): string[] {
  return flagValues(tokens, LABEL_FLAG);
}

/**
 * The single place that decides. `null` means allow.
 *
 * One exported function so there is one binding to mutate. Asked per clause
 * rather than per command: a command that comments on an issue AND creates
 * one is a create, and the old substring form let the first half excuse the
 * second.
 */
export function verifyPhaseRefusal(cmd: string): string | null {
  const unreadable = unreadableFiling(cmd);
  if (unreadable !== null) return `[VerifyPhaseLock] ${unreadable}`;
  const offending = clauses(cmd).filter(createsIssue);
  if (offending.length === 0) return null;

  const names = Object.keys(OVERRIDE_LABELS);
  const allowed = offending.every(c => labelValues(c).some(l => names.includes(l)));
  if (allowed) return null;

  return (
    "[VerifyPhaseLock] During VERIFY phase, use verifyBlockers[] in " +
    "workflow-state.json instead of creating new issues. To override, apply a " +
    "label that states where the issue came from: " +
    names.map(n => `--label ${n} (${OVERRIDE_LABELS[n]})`).join(", ") +
    ". The label must be a real --label argument; a matching word in the title " +
    "is not an override."
  );
}
