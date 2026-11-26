/**
 * The decision behind `hooks/BashWriteGuard.hook.ts`.
 *
 * **An accident guard, not a boundary (ADR-027).** A reader of command text
 * cannot stop an agent running as the files' owner: a program written to a
 * file and then run, a name built from pieces, a quoted flag — each walks
 * past it. What it does is stop the ordinary command that writes a gate
 * artifact or a hook by mistake, and stay out of the way of the reads and
 * fixture work around them. Merges are decided by CI (`ship.mode` direct).
 *
 * Every check is structural and per segment, because a substring test over a
 * whole command line cannot tell CODE from DATA (#1120): it under-blocked
 * `gh --version; echo x > .gate-salt` and over-blocked a `grep` for the word
 * `chmod`. Each segment is asked what it WRITES (redirects, `tee`, `cp`/`mv`),
 * what it MUTATES in place (`sed -i`, `rm`, …), whether it LINKS, whether it
 * runs an interpreter body, and whether its command WORD is `chmod`.
 *
 * Quotes are read two ways on purpose: `stripQuoted` deletes quoted spans
 * with their contents, to find a VERB (text in quotes is never the command
 * the shell runs); `dequote` keeps the contents, to find a TARGET
 * (`chmod 777 "x.hook.ts"` really names a hook).
 *
 * A protected NAME is a protected ARTIFACT only outside a fixed scratch root
 * (#1175), judged by the real directory a shell write lands in
 * (`scratchExempt`). Scoping by project root was measured wrong: a live
 * `workflow-state.json` is in the run store, not the repository.
 */

import { lstatSync, realpathSync, statSync, type Stats } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { isInterpreterWord, isShellWord } from './interpreters';

/** Gate artifacts. A write to any of these must come from the gate runner. */
export const PROTECTED_FILES = ['workflow-state.json', '.gate-salt', '/witnesses/'];

/** Hook sources. Integrity matters because hooks are what enforce everything else. */
export const PROTECTED_HOOKS = ['.hook.ts', '.hook.sh'];

export interface BashWriteDecision {
  blocked: boolean;
  reason?: string;
}

const ALLOW: BashWriteDecision = { blocked: false };

/**
 * The trees an OS temporary directory can be in, each also in its realpath
 * form (`/tmp` is `/private/tmp`, and `tmpdir()` hands back `/var/…` while a
 * resolution hands back `/private/var/…`). Read at call time.
 *
 * `TMPDIR` is the writer's variable, so it is not trusted: pointing it at the
 * run store would exempt the one directory this guard exists for. The fixed
 * list is the whole of the trust, and the environment may only SELECT a root
 * that already resolves inside it.
 */
const FIXED_SCRATCH_ROOTS = ['/tmp', '/private/tmp', '/var/folders'];

/**
 * Trees that hold LIVE artifacts, wherever they are on disk: the run store,
 * `~/.claude`, and the trees hook registrations resolve to (`PAI_HOOKS_DIR`,
 * `RUNGATE_HOOKS_DIR`). They are SUBTRACTED from the exemption, even under
 * `/tmp` — a checkout is the live hook exactly when a variable says it is
 * (`lib/hook-target-tree.ts` measured one). Both spellings of each tree are
 * kept, because `resolve()` does not follow `/tmp` → `/private/tmp`.
 * `process.cwd()` is not here: a worktree under `/tmp` is ordinary, and
 * protecting it refused every fixture.
 */
function protectedTrees(): string[] {
  const home = process.env.HOME || '';
  const spellings: string[] = [];
  for (const p of [
    // The run store — where 2,620 of 3,240 absolute artifact references live.
    process.env.RUNGATE_WORK_DIR || '',
    home ? join(home, '.rungate') : '',
    home ? join(home, '.claude') : '',
    // The trees a hook registration resolves to. Read from the environment
    // because that is what the registrations are spelled with.
    process.env.PAI_HOOKS_DIR || '',
    process.env.RUNGATE_HOOKS_DIR || '',
    home ? join(home, '.pai', 'hooks') : '',
  ].filter(Boolean)) {
    const normalised = resolve(p);
    spellings.push(normalised);
    try {
      const real = realpathSync(normalised);
      if (real !== normalised) spellings.push(real);
    } catch {
      // Not on disk. The resolved spelling above still stands.
    }
  }
  return spellings;
}

/** Is `p` inside, or equal to, any of `trees`? */
function inAnyTree(p: string, trees: string[]): boolean {
  return trees.some(t => p === t || p.startsWith(t + '/'));
}

function scratchRoots(): string[] {
  const out: string[] = [];
  const contains = (root: string, p: string) => p === root || p.startsWith(root + '/');

  const fixed: string[] = [];
  for (const r of FIXED_SCRATCH_ROOTS) {
    const n = resolve(r);
    fixed.push(n);
    try {
      fixed.push(realpathSync(n));
    } catch {
      // A root that is not on this disk is still a name a command can spell.
    }
  }

  // A protected tree that is ITSELF inside a fixed scratch root is not a
  // reason to drop that root. `RUNGATE_WORK_DIR=/tmp/e2e-gate-test` is a real
  // corpus command — a harness deliberately putting the run store in scratch
  // for a test — and without this clause it drops `/tmp` and refuses every
  // fixture on the machine, which is the same self-defeat `process.cwd()`
  // caused. Measured: `isScratchPath('/tmp/p/x')` goes false under that one
  // environment variable.
  const guarded = protectedTrees().filter(t => !fixed.some(f => contains(f, t)));
  const add = (p: string) => {
    if (p === '/' || out.includes(p)) return;
    // The invariant, enforced rather than documented: an exemption root that
    // contains a protected tree is not an exemption root.
    if (guarded.some(t => contains(p, t))) return;
    out.push(p);
  };

  for (const f of fixed) add(f);

  // The environment SELECTS within the fixed set; it cannot extend it.
  for (const r of [tmpdir(), process.env.TMPDIR ?? '']) {
    if (!r || !r.startsWith('/')) continue;
    const n = resolve(r);
    let real = n;
    try {
      real = realpathSync(n);
    } catch {
      /* not on this disk; judge the spelling */
    }
    if (!fixed.some(f => contains(f, n) || contains(f, real))) continue;
    add(n);
    add(real);
  }
  return out;
}

/**
 * Glob and brace metacharacters, tested against the DIRECTORY part only: a
 * glob there names no directory the walk can resolve, so it could expand into
 * a link. A glob in the basename is safe, because the directory above it is
 * what gets resolved, and refusing it cost a real fixture cleanup.
 */
const UNRESOLVED_DIR = /[*?[\]{}]/;

/**
 * Is this path demonstrably inside a scratch tree? Only an ABSOLUTE path can
 * be placed, so anything else answers `false` and stays refused. The path is
 * `resolve()`d (`/tmp/../` is not in `/tmp`), its deepest existing ancestor
 * realpath'd, and both spellings must sit in a scratch root and in no
 * protected tree. An unexpanded `$` or backtick is refused: it is a path the
 * shell has yet to build.
 *
 * A link the SAME command makes is not visible here; `scratchExempt`'s
 * caller withdraws the exemption from any command that makes a link.
 */
export function isScratchPath(path: string): boolean {
  if (!path || !path.startsWith('/')) return false;
  if (/[$`]/.test(path)) return false;
  // A glob in a DIRECTORY component is unresolvable and escapes; one in the
  // basename does not. See `UNRESOLVED_DIR` for the measurement.
  if (UNRESOLVED_DIR.test(dirname(path))) return false;

  const normalised = resolve(path);
  const real = resolveThroughLinks(normalised);
  if (real === null) return false;

  // The subtraction, applied to BOTH the spelling and the resolved path. A
  // live artifact is never exempt, whichever of the two names it.
  const live = protectedTrees();
  if (inAnyTree(normalised, live) || inAnyTree(real, live)) return false;

  const roots = scratchRoots();
  return inAnyTree(normalised, roots) && inAnyTree(real, roots);
}

/**
 * The path with its deepest EXISTING ancestor resolved through symlinks, and
 * the not-yet-created tail re-attached. `null` when nothing in the chain can
 * be resolved — which is the fail-closed answer, not a missing one.
 */
function resolveThroughLinks(normalised: string): string | null {
  let dir = normalised;
  let suffix = '';
  for (let i = 0; i < 64; i++) {
    try {
      const real = realpathSync(dir);
      return suffix ? resolve(real, suffix) : real;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      suffix = suffix ? join(basename(dir), suffix) : basename(dir);
      dir = parent;
    }
  }
  return null;
}

/**
 * A shell write's scratch exemption (ADR-027 decision 4). A write naming a
 * protected artifact is exempt only when it lands under a fixed scratch root,
 * judged by the real directory it writes into:
 *
 * - `isScratchPath`: the deepest existing ancestor, resolved through links,
 *   is in a scratch root and in no protected tree;
 * - no existing component between the scratch root and the target is a link;
 * - the target, if it exists, is not a link (a dangling one included) and has
 *   one name.
 *
 * A directory that does not exist yet is not exempt, even when a `mkdir` in
 * the same command makes it: there is no real directory to judge, and
 * `mkdir -p` succeeds silently on a link a `cp -a`, `mv` or `tar` puts in
 * its place. Three review rounds each found a new spelling of that, so the
 * rule is the whole class: make the directory in a command of its own first.
 * The corpus sweep counted one real command it costs. And a command that
 * makes a link anywhere (`makesLink`) has no exemption at all, applied by
 * the caller: an accident guard does not track which step made what. This
 * replaces #1367's step-order and mention tracking. A link made some other
 * way, such as a program written to a file and then run, is outside an
 * accident guard.
 */
type Exemption = (path: string) => boolean;
const NO_EXEMPTION: Exemption = () => false;

export function scratchExempt(path: string): boolean {
  // The walk reads the resolved path, so a link before a `..` would go unseen (#2866).
  if (!isScratchPath(path) || path.split('/').includes('..')) return false;
  const target = resolve(path);
  const root = scratchRoots().find(r => target === r || target.startsWith(r + '/'));
  if (!root) return false;
  let at = root;
  for (const part of target.slice(root.length).split('/').filter(Boolean)) {
    at = join(at, part);
    let st: Stats;
    try {
      st = lstatSync(at);
    } catch {
      // Not there yet, so nothing below it is either. A new file in a real
      // directory is fine; a missing directory has no real directory to judge.
      return at === target;
    }
    if (st.isSymbolicLink()) return false;
    if (at !== target && !st.isDirectory()) return false;
    if (at === target && !st.isDirectory() && st.nlink > 1) return false;
  }
  return true;
}

/**
 * `ln`, `link`, or `cp` with a link flag where a command STARTS: the text's
 * start, after an operator, `(`, `$(`, `{`, a backtick, a quote, a list
 * bracket, `find -exec` or `do`/`then`, and behind a wrapper with the words it takes
 * (`timeout -s KILL 30 ln`, `eval ln`). An argument is not one: `grep -nw ln`
 * is a read. A wrapped command that only mentions it (`nice grep ln`)
 * over-reads, the direction this module may be wrong in (#2866).
 */
const LINK_AT_COMMAND = new RegExp(
  String.raw`(?:^|[;&|({\x60'"[,]|\$\(|\s-(?:exec|ok)(?:dir)?\s)\s*(?:(?:do|then|else|elif|if|while|until|!)\s+)*` +
    String.raw`(?:(?:sudo|env|nohup|time|command|exec|xargs|nice|timeout|stdbuf|doas|caffeinate|ionice|setsid|busybox|builtin|eval)\s+(?:\S+\s+)*?)?` +
    String.raw`(?:['"]?(?:\S*\/)?(?:ln|link)['"]?(?=[\s,'"\]]|$)|cp\s(?:[^|;&\n)]*\s)?['"]?-(?:[A-Za-z]*[ls]|-sy|-l))`,
);

/**
 * A link call in a program or a nested shell body: `symlink` in every
 * spelling, the hard-link calls, and `LINK_AT_COMMAND`, so `bash -c 'cp -sR
 * …'` counts as well as a top-level `cp -s`. Read over the whole command,
 * quotes included, by `makesLink`; it over-reads a quoted "ln -s", which
 * costs a fixture its exemption, the direction this module may be wrong in.
 */
export const BODY_LINK_CALL = new RegExp(
  String.raw`\bsymlink(?:Sync|_to|at)?\b|\bhardlink_to\b|\blink(?:Sync|at)?\s*\(|\bos\.link\b|\bFile\.link\b|` + LINK_AT_COMMAND.source,
);

/**
 * One of `cp`'s link flags as the shell hands it over (a dequoted word):
 * `-s` or `-l` in a cluster, or any prefix GNU accepts of `--link` or
 * `--symbolic-link`.
 */
function isCpLinkFlag(w: string): boolean {
  if (!w.startsWith('--')) return /^-[A-Za-z]*[ls]/.test(w);
  return w.length > 2 && ('--link'.startsWith(w) || (w.length >= 4 && '--symbolic-link'.startsWith(w)));
}

/**
 * A segment that makes a link: `LINK_AT_COMMAND` read with quoted spans gone
 * (a commit message saying "; ln" is not a command), a quoted `"ln"` as the
 * command word, or `cp` with a link flag as the shell hands it over.
 */
function segmentLinks(seg: string): boolean {
  const word = commandWord(seg);
  const view = /^\s*eval\s/.test(seg) ? dequote(seg) : stripQuoted(seg); // `eval` runs its quoted text
  if (word === 'ln' || word === 'link' || LINK_AT_COMMAND.test(view)) return true;
  return word === 'cp' && scanSegment(seg).words.some(isCpLinkFlag);
}

/** Does the command make a link anywhere: a shell verb, `cp`'s flag, or a program's call? */
function makesLink(cmd: string): boolean {
  return BODY_LINK_CALL.test(cmd) || segments(cmd).some(segmentLinks);
}

/**
 * Path-like words in `text` that contain `needle`.
 *
 * A word here ends at whitespace or at a character that cannot be inside a
 * shell or source-literal path — a quote, a comma, a bracket, a semicolon.
 * That is deliberately crude and deliberately in the refusing direction: when
 * a path is assembled rather than written out, the word this returns is the
 * fragment that WAS written, which is relative, which `isScratchPath` refuses
 * to exempt.
 *
 * Case-folded for the same reason `names()` is (#1184): the default macOS
 * filesystem resolves `WORKFLOW-STATE.JSON` and `workflow-state.json` to one
 * inode, so a case-sensitive search here would find no path word for the
 * uppercase spelling, and a name with no path words is not exempted — it
 * would refuse rather than leak. Folding keeps the two readings agreeing
 * instead of agreeing by accident.
 */
function pathWordsContaining(text: string, needle: string): string[] {
  const out: string[] = [];
  // Searched in the text itself, without case. Indexing a lowercased copy
  // shifted every offset after a character whose lower case is longer —
  // `İ` becomes two code units — so the word lost its leading `/` and an
  // absolute path read as relative (review of #2863, round 1). `u` folds
  // case the Unicode way, as `names`' `toLowerCase` does: without it the
  // Kelvin sign in `.hooK.ts` is a protected name to `names` and no path
  // word here, so the name is dropped (security review of the same push).
  const pin = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  let m: RegExpExecArray | null;
  while ((m = pin.exec(text)) !== null) {
    let s = m.index;
    while (s > 0 && !/[\s'"`,;(){}[\]]/.test(text[s - 1])) s--;
    let e = m.index + m[0].length;
    while (e < text.length && !/[\s'"`,;(){}[\]]/.test(text[e])) e++;
    out.push(text.slice(s, e)); // the ORIGINAL case: this is a path to resolve
    pin.lastIndex = e;
  }
  return out;
}

/**
 * Split a command at top-level `;`, `&&`, `||`, `|` and newline, leaving
 * separators inside quotes alone.
 *
 * Deliberately NOT a shell parser. It does not expand anything, does not
 * track `$(…)` nesting and does not care about redirection grammar. It
 * answers one question — where might a new command begin — and the failure
 * mode of getting that slightly wrong is MORE segments, each of which is
 * then inspected. Over-splitting costs precision in the allow direction and
 * never opens a hole, which is the direction a guard should err in.
 */
export function segments(cmd: string): string[] {
  return splitSegments(cmd).map(p => p.text);
}

/**
 * `segments`, with the separator that ENDS each one (#1367): `;`, `\n`,
 * `|`, `||`, `&`, `&&`, or `redir` for the `&` of `2>&1` / `&>`, which
 * this splitter has always cut at and which is not a background job. One
 * splitter, so the order the chain property reads cannot disagree with the
 * segments every arm reads. An empty segment is dropped and its separator
 * folded into the one before it, strongest first: a `&` hides order, a `|`
 * joins a pipeline.
 */
function splitSegments(cmd: string): Array<{ text: string; sep: string }> {
  // Heredoc bodies go FIRST, before anything looks for a separator. A
  // heredoc is not a quote, so a `|` or `;` inside an issue body, a commit
  // message or a PR description used to tear the document into fragments
  // and each fragment was then read as a command — which is how a sentence
  // about `workflow-state.json` came to be refused as a write to it.
  cmd = stripHeredocs(cmd);
  const raw: Array<{ text: string; sep: string }> = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      cur += c;
      // #1203: inside SINGLE quotes nothing is escaped, not even a backslash,
      // so the first `'` always closes. Treating `\'` as an escape there kept
      // the span open past its real end, and everything after it — the
      // separator AND the write verb — was swallowed into one segment where
      // `commandWord` could never reach the verb. Inside DOUBLE quotes `\"`
      // IS an escape, which is why the two cases are told apart rather than
      // handled by one rule.
      //
      // #1249: inside DOUBLE quotes, consume the escape PAIR rather than
      // looking one character back. `\\` is an escaped BACKSLASH — a
      // complete pair — and the `"` after it closes the span. A lookbehind
      // cannot tell that `"` from the escaped one in `\"`, so `"x\\"` was
      // read as still open and the rest of the command, separator and write
      // verb together, became one segment whose command word is `echo`. The
      // outside-quote branch below already consumes the pair, for this same
      // reason; this is that rule applied inside the span.
      if (quote === '"' && c === '\\' && i + 1 < cmd.length) {
        cur += cmd[++i];
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    // #1203: a backslash-newline is a LINE CONTINUATION. The shell joins the
    // two lines into one command before it looks for anything else, so
    // splitting on that newline put the verb in one segment and its target in
    // the next, and `cp x \<nl> /r/workflow-state.json` reached the `cp` arm
    // with a single operand. Same class as #1176 and #1184 — a check reading a
    // transformed view whose transformation relocated the token — except this
    // one relocates it across a SEGMENT boundary rather than into a quote.
    //
    // Joining with NOTHING, not with a space, because that is what the shell
    // does: `ch\<nl>mod 777 x.hook.ts` runs chmod, so `commandWord` has to
    // resolve `chmod` too. Inserting a space would read the verb as `ch`.
    //
    // Only outside a quote. Inside single quotes the backslash is literal and
    // the newline is data, which is the negative control this must not break.
    if (c === '\\') {
      if (cmd[i + 1] === '\n') {
        i++;
        continue;
      }
      // An ESCAPED backslash. Consume the pair, so `\\` at end of line leaves
      // no dangling `\` to swallow the newline that genuinely separates.
      cur += c;
      if (i + 1 < cmd.length) cur += cmd[++i];
      continue;
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      let sep: string = c;
      if (c === '&' && (cmd[i - 1] === '>' || cmd[i - 1] === '<' || cmd[i + 1] === '>')) sep = 'redir';
      if (cmd[i + 1] === c) {
        i++; // `&&`, `||` are one separator, not two
        sep = c + c;
      }
      raw.push({ text: cur, sep });
      cur = '';
      continue;
    }
    cur += c;
  }
  raw.push({ text: cur, sep: '' });
  const out: Array<{ text: string; sep: string }> = [];
  for (const p of raw) {
    const text = p.text.trim();
    if (text) {
      out.push({ text, sep: p.sep });
      continue;
    }
    const prev = out[out.length - 1];
    if (!prev) continue;
    if (p.sep === '&' || prev.sep === '&') prev.sep = '&';
    else if (p.sep === '|' || prev.sep === '|') prev.sep = '|';
  }
  return out;
}

/**
 * Delete heredoc bodies, then quoted spans and their contents. Use when
 * looking for a VERB.
 *
 * A heredoc body is the single largest source of over-blocking measured on
 * this machine's history: an issue body, a commit message or a PR
 * description written with `cat > f <<'EOF'` routinely QUOTES a protected
 * filename, a `>` redirect or the word `chflags`, because the thing being
 * written about is this guard. 1,860 real commands were newly refused before
 * this stripping existed and the large majority were that shape.
 */
export function stripQuoted(s: string): string {
  return stripHeredocs(s).replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, ' ');
}

/**
 * Delete heredoc bodies only, keeping ordinary quoting intact: a heredoc body
 * is the document being written, never a word of the command writing it.
 *
 * `blankComments` is for the write guard (#1176): a `#` line's apostrophe
 * opened a quote that swallowed a later redirect. The filing parser
 * (`lib/issue-create-override.ts`) passes `false`, because it needs a body's
 * `##` headings kept; the caller knows which reader it is (#1741).
 */

export function stripHeredocs(s: string, blankComments = true): string {
  const lines = s.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // A whole-line `#` comment is prose, and its APOSTROPHE is not a quote.
    // #1176: `# First, check if there's a test workflow-state.json` opened a
    // quote that stayed open across the newline and swallowed the redirect on
    // a later line, so a real write to a protected file read as quoted text.
    // Two commands in a 5,513-command corpus did exactly this, both of them
    // genuine writes. Dropped here rather than in each caller because every
    // write-guard arm reaches this function first.
    //
    // **#1741: unconditional again, and the caller chooses.** Three
    // revisions tried to decide per line whether the `#` was inside a
    // quote, so that one output could serve the write guard and the filing
    // parser at once. The docblock above says what each of the three cost.
    // The reader that wants the comment kept now says so.
    const looksComment = /^\s*#/.test(line);
    out.push(looksComment && blankComments ? '' : line); // #1176: the OPERATOR's line is kept.
    i++;
    // A `#` line cannot open a heredoc. Read from the RAW line and not from
    // what was pushed, so the exemption does not move when `blankComments`
    // does — a `#` line that reaches `heredocDelimiter` deletes everything
    // up to the terminator, and that is the bypass the second revision of
    // this change shipped.
    if (looksComment) continue;
    const delim = heredocDelimiter(line);
    if (!delim) continue;
    // #1355: the rest of a CONTINUED opener line is command, not body. The
    // body starts after the logical line, which is where the shell starts it.
    // A `#` line among them is a comment once the shell joins it, and gets
    // the same #1176 blanking as any other (review round 2 of PR #2077).
    for (const end = logicalEnd(lines, i - 1); i <= end; i++) {
      out.push(/^\s*#/.test(lines[i]) && blankComments ? '' : lines[i]);
    }
    // #1184: buffer the body rather than consuming to end-of-input. A
    // heredoc whose terminator never arrives is not a heredoc this module can
    // trust, and dropping the rest of the command is a BYPASS — `cat <<EOF`
    // followed by a write on the next line used to read as a bare `cat`. The
    // regex this scanner replaced required the terminator to match, so it
    // failed closed; the first version of the scanner failed open. Keeping
    // the bytes is the direction a guard is allowed to be wrong in.
    const body: string[] = [];
    let j = i;
    while (j < lines.length && lines[j].trim() !== delim) {
      body.push(lines[j]);
      j++;
    }
    if (j < lines.length) {
      i = j + 1; // terminated: the body and the terminator are the document
    } else {
      out.push(...body); // never terminated: emit unchanged
      i = j;
    }
  }
  return out.join('\n');
}

/**
 * Which character positions on this line are OUTSIDE every quoted span.
 *
 * A `$(` opens a COMMAND SUBSTITUTION, and the shell parses its contents as a
 * fresh command with fresh quoting — so text inside `"$( … )"` is unquoted
 * even though it sits between double quotes. That one rule is the whole
 * difference between the two cases in #1196's H6, and it is why this is a
 * small stack rather than a boolean. Single quotes do not substitute, so a
 * `$(` inside them is literal and opens nothing.
 *
 * Deliberately per-line, matching its only caller: a quote opened on an
 * earlier line reads as unquoted here. That is the behaviour this function
 * replaced — which was not quote-aware at all — so no case gets worse, and
 * the direction it is wrong in deletes text rather than admitting it.
 */
function unquotedPositions(line: string): boolean[] {
  const open = new Array<boolean>(line.length).fill(false);
  const stack: string[] = ['']; // quote state per substitution depth
  let i = 0;
  while (i < line.length) {
    const q = stack[stack.length - 1];
    const c = line[i];
    if (q === "'") {
      if (c === "'") stack[stack.length - 1] = '';
      i++;
    } else if (q === '"') {
      if (c === '\\') i += 2;
      else if (c === '$' && line[i + 1] === '(') (stack.push(''), (i += 2));
      else if (c === '"') (stack[stack.length - 1] = ''), i++;
      else i++;
    } else if (c === '\\') {
      i += 2;
    } else if (c === '$' && line[i + 1] === '(') {
      open[i] = open[i + 1] = true;
      stack.push('');
      i += 2;
    } else if (c === ')' && stack.length > 1) {
      stack.pop();
      i++;
    } else if (c === '"' || c === "'") {
      stack[stack.length - 1] = c;
      i++;
    } else {
      open[i] = true;
      i++;
    }
  }
  return open;
}

/**
 * The delimiter word of a `<<WORD` on this line, if any — at a position the
 * shell would read as an operator rather than as text.
 *
 * #1176 left this NOT quote-aware on purpose, because the obvious hardening
 * ("must be top-level") REDDENS the recorded `pai-config#474` false positive,
 * whose heredoc is legitimately nested inside `"$(cat <<'EOF' … )"`. That
 * reasoning was right about the fix it tried and wrong about the conclusion:
 * the distinction is not depth, it is whether a command substitution has
 * reset the quoting. #1196 pays for the small stack that tells them apart.
 *
 * What it buys: `bun -e 'x = "<<EOF"'` opened a heredoc, so every following
 * line up to a bare `EOF` was deleted as a document — a quoted STRING chose
 * what the guard could see. H5 was this same body-drop reached through the
 * wrong character position (`<<<`); this is the wrong quoting position.
 */
function heredocDelimiter(line: string): string | null {
  return heredocOperator(line)?.delim ?? null;
}

/** `heredocDelimiter`, and where on the line its operator sits (#1355). */
function heredocOperator(line: string): { delim: string; at: number } | null {
  // #1184: `(?<!<)` and `(?!<)` exclude a `<<<` HERESTRING, which has no
  // terminator at all. Matching one invented a delimiter from the quoted text
  // after it and then ran straight into the unterminated case above.
  const re = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
  const open = unquotedPositions(line);
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (open[m.index]) return { delim: m[2], at: m.index };
  }
  return null;
}

/**
 * Does this physical line continue onto the next (#1355)?
 *
 * An unquoted backslash immediately before the newline is a line
 * continuation: the shell deletes the pair and reads on, so a heredoc's
 * opener line ends further down than its newline, and its BODY starts after
 * the logical line rather than after the physical one. `cat <<'EOF' \⏎| bash`
 * pipes the body into a shell; reading the `| bash` line as the first line of
 * the body deleted it from every view.
 *
 * An even run of backslashes is escaped backslashes, and a backslash inside
 * a quote or a comment is data.
 */
function continues(line: string): boolean {
  const run = /\\+$/.exec(line);
  if (!run || run[0].length % 2 === 0) return false;
  const text = line.slice(0, -1) + ' ';
  const open = unquotedPositions(text);
  if (!open[text.length - 1]) return false;
  for (let k = 0; k < text.length; k++) {
    if (open[k] && opensComment(text, k)) return false;
  }
  return true;
}

/**
 * Does an unquoted `text[k]` open a comment? A `#` does when it begins a
 * word — after whitespace OR an operator, so `;#` is a comment too.
 *
 * One predicate for `continues` and `nest` (review of PR #2077): with two
 * copies, the narrower one read the backslash in `bash <<'EOF' ;# note \`
 * as a continuation and swallowed the body's first line as opener text.
 */
function opensComment(text: string, k: number): boolean {
  return text[k] === '#' && (k === 0 || /[\s;&|()]/.test(text[k - 1]));
}

/** The last physical line of the logical line that starts at line `i`. */
function logicalEnd(lines: string[], i: number): number {
  let end = i;
  while (end + 1 < lines.length && continues(lines[end])) end++;
  return end;
}

/** One level of shell nesting open at a position, and where it opened. */
interface Frame {
  close: string;
  open: number;
  /** A command substitution or process substitution: its OUTPUT is an argument. */
  subst: boolean;
}

const QUOTE_CLOSERS = new Set(["'", '"']);

/**
 * Advance a nesting reading over `text[i]`; returns the next index (#1355).
 *
 * Quotes, `$( )` / `<( )` / `>( )` and backticks, subshells and brace groups.
 * The minimum the reach question needs — where does the group this heredoc
 * sits in END — and deliberately nothing else: keywords such as `if`/`fi`
 * are not groups here, so a heredoc inside one reaches no further than it
 * did before. Its failure mode is a group that never closes, which reaches
 * nothing, so a misreading costs a missed reach and never a new refusal.
 */
function nest(text: string, i: number, stack: Frame[]): number {
  const c = text[i];
  const top = stack[stack.length - 1];
  if (top?.close === "'") {
    if (c === "'") stack.pop();
    return i + 1;
  }
  if (c === '\\') return i + 2;
  if (top?.close === '"' || top?.close === '`') {
    if (c === top.close) stack.pop();
    else if (c === '$' && text[i + 1] === '(') {
      stack.push({ close: ')', open: i + 1, subst: true });
      return i + 2;
    } else if (c === '`') stack.push({ close: '`', open: i, subst: true });
    return i + 1;
  }
  const wordStart = i === 0 || /[\s;&|()]/.test(text[i - 1]);
  if (opensComment(text, i)) {
    const nl = text.indexOf('\n', i);
    return nl === -1 ? text.length : nl;
  }
  if (c === "'" || c === '"' || c === '`') stack.push({ close: c, open: i, subst: c === '`' });
  else if (c === '(') stack.push({ close: ')', open: i, subst: /[$<>]/.test(text[i - 1] ?? '') });
  else if (c === ')' && top?.close === ')') stack.pop();
  else if (c === '{' && wordStart && /\s/.test(text[i + 1] ?? '')) stack.push({ close: '}', open: i, subst: false });
  else if (c === '}' && wordStart && top?.close === '}') stack.pop();
  return i + 1;
}

/**
 * One element of a pipeline: its raw text, for the command word, and `flat`,
 * the part at the pipeline's own depth with quotes, nested groups, escapes
 * and comments blanked, for its redirections.
 */
interface Element {
  raw: string;
  flat: string;
}

/** Is this the separator that ends a pipeline element at `text[i]`? */
function endsElement(text: string, i: number): boolean {
  const c = text[i];
  const redirect = text[i - 1] === '>' || text[i + 1] === '>';
  return c === '\n' || c === ';' || c === '|' || (c === '&' && !redirect);
}

/**
 * The elements of the pipeline starting at `i`, at the depth `frames`
 * describe — `) > f | sed … | bash`. It ends at `;`, `&&`, `||`, `&`, a
 * newline, or the close of an outer group. Reads a COPY of the nesting, so
 * the caller's cursor is not moved.
 */
function pipeline(text: string, i: number, frames: Frame[]): Element[] {
  const stack = frames.slice();
  const base = stack.length;
  const out: Element[] = [];
  let from = i;
  let flat = '';
  while (i < text.length && stack.length >= base) {
    if (stack.length === base && endsElement(text, i)) {
      if (text[i] !== '|' || text[i + 1] === '|') break;
      out.push({ raw: text.slice(from, i), flat });
      from = text[i + 1] === '&' ? i + 2 : i + 1;
      flat = '';
      i = from;
      continue;
    }
    const depth = stack.length;
    const next = nest(text, i, stack);
    if (depth === base && stack.length === base) {
      const inert = text[i] === '\\' || opensComment(text, i);
      flat += inert ? ' '.repeat(next - i) : text.slice(i, next);
    } else if (depth === base && stack.length > base && text[i] === '(' && /[<>]/.test(text[i - 1] ?? '')) {
      flat = flat.slice(0, -1) + ' '; // `>(…)` is a process substitution, not a redirect
    }
    i = next;
  }
  out.push({ raw: text.slice(from, i), flat });
  return out;
}

/**
 * Does this element send its standard output somewhere other than the pipe?
 * `>`, `>>`, `>|`, `1>`, `&>` and `>&N` do. `2>` and `2>&1` move another
 * descriptor and leave stdout where it was.
 */
function redirectsStdout(flat: string): boolean {
  for (let j = 0; j < flat.length; j++) {
    if (flat[j] !== '>' || flat[j - 1] === '>' || flat[j - 1] === '<') continue;
    const fd = /\d*$/.exec(flat.slice(0, j))![0];
    if (fd === '' || fd === '1') return true;
  }
  return false;
}

/**
 * Where a pipeline sends what enters its first element: the interpreter it
 * reaches, `null` when a stdout redirection severs it first, or `undefined`
 * when it flows on into the enclosing group's output.
 *
 * `own` is the heredoc's OWN pipeline, whose interpreters are
 * `heredocInterpreter`'s question; here it can only be severed (review
 * round 2 of PR #2077: `(cat <<'EOF' > x.md … ) | bash` hands `bash`
 * nothing, because the body went to the file).
 */
function flow(elements: Element[], own: boolean): string | null | undefined {
  for (let k = 0; k < elements.length; k++) {
    if (k > 0 && !own) {
      const word = commandWord(elements[k].raw);
      if (isInterpreterWord(word)) return word;
    }
    if (redirectsStdout(elements[k].flat)) return null;
  }
  return undefined;
}

/** Where the heredoc's own command begins: after the last separator at its depth. */
function elementStart(text: string, at: number, frames: Frame[]): number {
  const stack = frames.slice();
  const base = stack.length;
  let i = base > 0 ? frames[base - 1].open + 1 : 0;
  let start = i;
  while (i < at) {
    if (stack.length === base && endsElement(text, i)) {
      start = ++i;
      continue;
    }
    i = nest(text, i, stack);
  }
  return start;
}

/**
 * The command word of the command a substitution opened at `open` belongs to:
 * the text back to the enclosing command frame, or to the start of the
 * logical line, whichever is nearer.
 */
function enclosingWord(text: string, open: number, outer: Frame | undefined): string {
  let start = text.lastIndexOf('\n', open - 1) + 1;
  while (start > 0) {
    const prev = text.lastIndexOf('\n', start - 2) + 1;
    if (!continues(text.slice(prev, start - 1))) break;
    start = prev;
  }
  if (outer && outer.open + 1 > start) start = outer.open + 1;
  const segs = segments(text.slice(start, open));
  return commandWord(segs[segs.length - 1] ?? '');
}

/** A word that runs its argument as shell text, without being an interpreter. */
const EVALUATORS = new Set(['eval']);

/**
 * Words that run a FILE as shell text in the current shell (#2079). Handed a
 * process substitution `<(…)`, the file IS the substitution's output, so a
 * heredoc inside it is a program. Handed `$(…)`, the output is only a file
 * NAME, so these are not evaluators there.
 */
const SOURCERS = new Set(['source', '.']);

/**
 * Where a heredoc's ENCLOSING groups send its body (#1355, SC-2750).
 *
 * `text` is the whole command with every terminated heredoc body removed, so
 * what follows the operator is what the shell resumes reading after the
 * terminator, and `at` is the operator's offset in it. The opener line alone
 * cannot answer this: in
 *
 *     (cat <<'EOF'        { cat <<'EOF'        eval "$(cat <<'EOF'
 *     …                   …                    …
 *     EOF                 EOF                  EOF
 *     ) | bash            } | bash             )"
 *
 * the interpreter is on a line after the body. Each group open at the
 * operator is walked outward in turn: a subshell or brace group reaches an
 * interpreter when its close is piped into one, and a substitution when the
 * command it is an argument of is an interpreter or `eval`. A stdout
 * redirection on the way — on the heredoc's own command or on a group —
 * severs the body from everything outside it, and the walk stops there.
 *
 * Only the ENCLOSING groups, never the heredoc's own command line, which
 * `heredocInterpreter` already decides — so no spelling is decided twice by
 * two rules that could drift apart without either going red.
 */
function heredocReach(text: string, at: number): string | null {
  const stack: Frame[] = [];
  let i = 0;
  while (i < at) i = nest(text, i, stack);
  // The operator was read as unquoted by `heredocOperator`. A reading that
  // places it inside a quote disagrees with that one, and a reading that
  // disagrees is not one to widen anything on.
  if (stack.length > 0 && QUOTE_CLOSERS.has(stack[stack.length - 1].close)) return null;
  const frames = stack.slice();
  const ownElements = pipeline(text, elementStart(text, at, frames), frames);
  // #2079: the heredoc belongs to the INNERMOST command that owns the `<<`,
  // not to whatever the line starts with. `X=$(bash <<'EOF'` feeds `bash`,
  // and so does `T=$(echo x 2>&1) bash <<'EOF'`, whose `&` the line-start
  // reading splits on. `heredocInterpreter` reads from the line start and
  // decides first, so this is reached only when it found nothing, and no
  // spelling is decided twice. Before the sever check, because an
  // interpreter runs its stdin wherever its own stdout goes.
  const owner = commandWord(ownElements[0]?.raw ?? '');
  if (isInterpreterWord(owner)) return owner;
  const own = flow(ownElements, true);
  if (own !== undefined) return own;
  for (let level = frames.length; level > 0; level--) {
    while (i < text.length && stack.length >= level) i = nest(text, i, stack);
    if (stack.length >= level) return null; // never closed, so nothing follows it
    const frame = frames[level - 1];
    if (QUOTE_CLOSERS.has(frame.close)) continue;
    if (frame.subst) {
      const outer = frames.slice(0, level - 1).reverse().find(f => !QUOTE_CLOSERS.has(f.close));
      const word = enclosingWord(text, frame.open, outer);
      if (isInterpreterWord(word) || EVALUATORS.has(word)) return word;
      if (SOURCERS.has(word) && text[frame.open - 1] === '<') return word;
    } else {
      const word = flow(pipeline(text, i, stack), false);
      if (word !== undefined) return word;
    }
  }
  return null;
}

/**
 * Does the heredoc opened on this line hand its body to an interpreter?
 *
 * Two ways it can. The segment carrying the operator IS an interpreter
 * (`bash <<'EOF'`), or the operator's segment is piped into one
 * (`cat <<'EOF' | bash`). Everything else — `cat > doc.md <<'EOF'`,
 * `gh issue comment --body-file - <<'EOF'` — is a DOCUMENT, and stripping
 * those bodies is what stopped 1,860 real commands from being refused for
 * quoting the words this guard looks for. That distinction is the whole
 * reason this is a predicate rather than "stop stripping heredocs".
 *
 * #1355: `line` is the LOGICAL opener line, continuations joined. What lies
 * beyond it — a group closing after the body, a substitution handed to
 * `eval` — is `heredocReach`'s question, not this one's.
 */
function heredocInterpreter(line: string): string | null {
  const segs = segments(line);
  const ownerIdx = segs.findIndex(s => heredocDelimiter(s) !== null);
  if (ownerIdx === -1) return null;
  const owner = commandWord(segs[ownerIdx]);
  if (isInterpreterWord(owner)) return owner;
  const opAt = line.search(/(?<!<)<<(?!<)/);
  if (opAt === -1 || !line.slice(opAt).includes('|')) return null;
  return segs.slice(ownerIdx + 1).map(commandWord).find(isInterpreterWord) ?? null;
}

/**
 * The program text this command hands to an interpreter on stdin (#1240).
 *
 * A heredoc body fed to an interpreter, and a herestring operand of one.
 * Deliberately NOT the `-c`/`-e` form: arm 3a already reads that, and
 * returning it here would decide it twice.
 *
 * An UNTERMINATED heredoc is not returned. `stripHeredocs` already emits
 * those lines unchanged — the #1184 fail-closed direction — so every arm
 * can already see them, and returning them again would double-count a body
 * that is not hidden in the first place.
 *
 * #1355: a heredoc is decided once the WHOLE command has been read, because
 * the group it sits in can close — and be piped into a shell — lines after
 * its body ends. `skeleton` is the command as the shell parses it around the
 * bodies; `heredocReach` reads it.
 */
export function interpreterPrograms(cmd: string): Array<{ shell: boolean; program: string; quoted?: string }> {
  type Pending = { opener: string; at: number; body: string };
  const found: Array<{ shell: boolean; program: string; quoted?: string } | Pending> = [];
  const lines = cmd.split('\n');
  const skeleton: string[] = [];
  let offset = 0; // where the next skeleton line starts in `skeleton.join('\n')`
  const keep = (l: string): void => {
    skeleton.push(l);
    offset += l.length + 1;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*#/.test(line)) {
      keep(line);
      i++;
      continue; // a comment cannot open either form
    }

    // A HERESTRING has no body and no terminator, which is why
    // `heredocDelimiter` excludes it (#1184). It is still a program, and it
    // is invisible for the other half of the mechanism: the `>` inside it
    // sits in a quoted span that the VERB view removes.
    const hs = /(?<!<)<<<(?!<)([\s\S]*)$/.exec(line);
    if (hs) {
      const owner = segments(line).find(s => /(?<!<)<<<(?!<)/.test(s));
      const word = owner ? commandWord(owner) : '';
      if (isInterpreterWord(word)) {
        // `quoted` keeps the word as written: `dequote` strips every quote,
        // and with them the `'w'` an `open` mode is read by (review of #2863).
        found.push({ shell: isShellWord(word), program: dequote(hs[1]).trim(), quoted: hs[1].trim() });
      }
    }

    const op = heredocOperator(line);
    if (!op) {
      keep(line);
      i++;
      continue;
    }
    const at = offset + op.at;
    const end = logicalEnd(lines, i);
    for (let k = i; k <= end; k++) keep(lines[k]);
    const body: string[] = [];
    let j = end + 1;
    while (j < lines.length && lines[j].trim() !== op.delim) body.push(lines[j++]);
    if (j === lines.length) break; // unterminated: already visible, see the docblock
    found.push({ opener: lines.slice(i, end + 1).join('\n'), at, body: body.join('\n') });
    i = j + 1;
  }

  const text = skeleton.join('\n');
  const out: Array<{ shell: boolean; program: string }> = [];
  for (const f of found) {
    if (!('opener' in f)) {
      out.push(f);
      continue;
    }
    const word = heredocInterpreter(f.opener) ?? heredocReach(text, f.at);
    if (word) out.push({ shell: isShellWord(word) || EVALUATORS.has(word) || SOURCERS.has(word), program: f.body });
  }
  return out.filter(p => p.program !== '');
}

/** Remove quote characters, keep the contents. Use when looking for a TARGET. */
export function dequote(s: string): string {
  return s.replace(/['"]/g, '');
}

/** Wrappers and reserved words that come before the real command word (#2866: `timeout`, `do`, `then`). */
const WRAPPERS = /^(?:sudo|env|nohup|time|command|xargs|nice|timeout|stdbuf|doas|caffeinate|exec|ionice|setsid|busybox|builtin|do|then|else|elif|if|while|until|!)$/;

/**
 * A variable assignment prefix, by the POSIX shape: an identifier, an
 * optional array subscript, then `=`. Read on the raw token — see
 * `commandWord`, where recognising it only after the path strip was a bypass.
 */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?=/;

/**
 * Where a verb in `verb` stands among a segment's words (#2867): the command
 * word, or behind wrappers, past their flags and the word a flag takes
 * (`timeout -s KILL 30 cp`, `sudo -u x cp`). -1 when the command is anything
 * else, so `grep -c cp a b` is a read. `\cp` and `(cp` are `cp`.
 */
function verbAt(words: string[], verb: RegExp): number {
  let wrapped = false;
  for (let i = 0; i < words.length; i++) {
    const lead = words[i].replace(/^[({\\]+/, ''); // a flag keeps its slash: `env -C/dir cp` (#2870)
    const w = lead.startsWith('-') ? lead : lead.replace(/^.*\//, '');
    if (!w || ASSIGNMENT.test(words[i]) || /^\d+(?:\.\d+)?[smhd]?$/.test(w)) continue;
    if (verb.test(w)) return i;
    if (WRAPPERS.test(w) || w === 'eval') wrapped = true; // `eval cp`; commandWord keeps `eval` for interpreterPrograms
    else if (!wrapped || !(w.startsWith('-') || words[i - 1].startsWith('-'))) return -1;
  }
  return -1;
}

/**
 * The command word of a segment — the first token that is not a wrapper, an
 * assignment or an option. Read off `stripQuoted`, because a quoted token is
 * an argument.
 */
export function commandWord(segment: string): string {
  // #1184/#1196: the DEQUOTED tokens of `scanSegment`, so `"chmod" 777 x` is
  // chmod and `A="1 grep" cp …` is cp; a pattern is never in first position.
  for (const raw of scanSegment(segment).words) {
    // A token with whitespace is a quoted argument (`--body "… chflags …"`),
    // not a verb (pai-config#474). An assignment is read on the RAW token,
    // before the path strip takes its `=` (`FOO=/x/grep chmod …`, #1196).
    if (/\s/.test(raw)) continue;
    if (ASSIGNMENT.test(raw)) continue;
    const lead = raw.replace(/^[({\\]+/, ''); // `(cmd …`, `{ cmd …`, `\cmd` — alias bypass
    // `/usr/bin/python3` -> `python3`; a flag keeps its slash (`sudo -D/tmp chmod`, #2870)
    const tok = lead.startsWith('-') ? lead : lead.replace(/^.*\//, '');
    if (!tok || tok.includes('=') || tok.startsWith('-')) continue;
    if (WRAPPERS.test(tok) || /^\d+(?:\.\d+)?[smhd]?$/.test(tok)) continue; // `timeout 30 cp`
    return tok;
  }
  return '';
}

/**
 * Paths a segment writes through shell redirection or a copying verb.
 *
 * Redirections are read off the heredoc-stripped text, because a `>` inside
 * a heredoc body is prose about a redirect, not one. The TARGET itself is
 * then dequoted, because `> "x/.gate-salt"` writes the same file as `>
 * x/.gate-salt`.
 */

/**
 * The index just past a quoted span whose OPENING quote is at `i`. A single
 * quote takes no escapes; inside double quotes `\` escapes the next
 * character, so `\"` does not close the span (#1239). An unterminated span
 * runs to the end, which bash refuses to run anyway.
 *
 * Both boundaries are reported (#1471): `contentEnd` is where the contents
 * stop and `end` where the next word starts. One value for both could not
 * tell a span closed at the last character from one never closed.
 */
interface QuotedSpan {
  /** The index just past the closing quote, or `s.length` if there is none. */
  end: number;
  /** Where the span's CONTENTS stop — `end - 1` when terminated, else `end`. */
  contentEnd: number;
}

function endOfQuoted(s: string, i: number): QuotedSpan {
  const q = s[i];
  for (let j = i + 1; j < s.length; j++) {
    // Every span except the single-quoted one takes escapes — that is the
    // asymmetry stated above, and spelling it as "not `'`" rather than as a
    // list is what let the BACKTICK span join without a second scanner.
    if (q !== "'" && s[j] === '\\') {
      j++; // the escaped character, whatever it is, is not a delimiter
      continue;
    }
    if (s[j] === q) return { end: j + 1, contentEnd: j };
  }
  return { end: s.length, contentEnd: s.length };
}

/**
 * Read one word starting at `i`, honouring quotes. Returns the word's
 * CONTENTS — quote characters removed, contents kept — and the index after
 * it, so `dir/"workflow-state.json"` reads as one word and not as two halves
 * either side of a span that was deleted.
 */
/**
 * The index just past the `)` that closes the `$(` at `i`, or the end of the
 * string. A parenthesis inside a string literal is data, not grammar
 * (`echo $(echo "x)") > …` hid its redirect), and quoted spans end where
 * `endOfQuoted` says, escapes included (#1205, #1361).
 */
function endOfSubstitution(s: string, i: number): number {
  let depth = 0;
  let j = i;
  for (; j < s.length; j++) {
    const q = s[j];
    // #1239: outside a quoted span a backslash escapes the next character,
    // so `\"` does not OPEN a span and `\)` does not close the substitution.
    if (q === '\\') {
      j++; // the loop's j++ steps past the escaped character
      continue;
    }
    if (q === "'" || q === '"') {
      // `endOfQuoted` returns the index AFTER the closing quote; the loop's
      // j++ would then step over the character following it, so back up one.
      j = endOfQuoted(s, j).end - 1;
      continue;
    }
    if (s[j] === '(') depth++;
    else if (s[j] === ')' && --depth === 0) {
      j++;
      break;
    }
  }
  return j;
}

/**
 * ANSI-C quoting: the value of a `$'…'` word, settled at parse time, so
 * decoding it makes a word more readable rather than guessing at one. An
 * unknown escape keeps its backslash, as bash does. Octal and `\x` escapes
 * are BYTES, decoded as UTF-8 once at the end: per-escape code points gave
 * `$'caf\303\251'` a spelling the shell never produces, and a directory
 * the module could not find was exempted. `\u`/`\U` stay code points.
 */
const ANSI_C_SHORT: Record<string, string> = {
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
};

function decodeAnsiC(body: string): string {
  const bytes: number[] = [];
  // Plain text accumulates and is encoded in runs rather than per character,
  // so a surrogate PAIR is encoded as the one code point it spells instead
  // of as two lone halves.
  let pending = '';
  const flush = () => {
    if (!pending) return;
    for (const b of new TextEncoder().encode(pending)) bytes.push(b);
    pending = '';
  };
  for (let k = 0; k < body.length; k++) {
    if (body[k] !== '\\' || k + 1 >= body.length) {
      pending += body[k];
      continue;
    }
    const n = body[k + 1];
    const short = ANSI_C_SHORT[n];
    if (short !== undefined) {
      pending += short;
      k++;
      continue;
    }
    if (n >= '0' && n <= '7') {
      const oct = /^[0-7]{1,3}/.exec(body.slice(k + 1))?.[0] ?? '';
      flush();
      bytes.push(parseInt(oct, 8) & 0xff); // a BYTE
      k += oct.length;
      continue;
    }
    if (n === 'x' || n === 'u' || n === 'U') {
      const width = n === 'x' ? 2 : n === 'u' ? 4 : 8;
      const hex = new RegExp(`^[0-9a-fA-F]{1,${width}}`).exec(body.slice(k + 2))?.[0] ?? '';
      if (hex) {
        const value = parseInt(hex, 16);
        if (n === 'x') {
          flush();
          bytes.push(value & 0xff); // a BYTE
        } else {
          pending += String.fromCodePoint(value); // a CODE POINT
        }
        k += 1 + hex.length;
        continue;
      }
    }
    pending += body[k]; // an escape bash does not recognise keeps its backslash
  }
  flush();
  return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
}

function readWord(s: string, i: number): [string, number] {
  let w = '';
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n') break;
    if (c === '>' || c === '<') break; // an operator ends a word
    // #1239: a backslash escapes the next character, so `\"` is a literal
    // quote and does not open a span. Without this, `echo \" > <protected>`
    // opened a span that never closed and the scanner swallowed the `>` —
    // the shortest bypass in the family, needing no `$( )` at all. The text
    // is kept verbatim because this module expands nothing; what matters is
    // that the escaped character cannot act as a delimiter.
    if (c === '\\' && i + 1 < s.length) {
      w += c + s[i + 1];
      i += 2;
      continue;
    }
    // ANSI-C quoting, the FOURTH transform. `$'-s'` is the word `-s`, and
    // reading the `$` as an ordinary character left the token `$-s`. It is
    // a QUOTING rule and this is the module's quote reader, so every reader
    // of a word gets it — `commandWord` for a hidden verb (`$'chmod'`), and
    // since #1367 the chain property for a hidden path (`rmdir $'\x65sc'`).
    // It was added for #1411's link-flag reader, which #1367 deleted.
    //
    // A `\'` inside the body is an escaped quote, so the closing quote is
    // found by walking rather than by `indexOf`.
    //
    // ORDER AGAINST THE CLAUSE ABOVE DOES NOT MATTER and the merge that put
    // them together should say so: one tests `\` and the other `$`, so no
    // input reaches both. What does matter is that BOTH precede the quote
    // clause below, or an escaped or ANSI-C quote opens a span and the
    // scanner swallows the redirect — which is #1239's bypass arriving by a
    // second route (#1361 merge).
    if (c === '$' && s[i + 1] === "'") {
      let k = i + 2;
      for (; k < s.length && s[k] !== "'"; k++) if (s[k] === '\\') k++;
      w += decodeAnsiC(s.slice(i + 2, Math.min(k, s.length)));
      i = k + 1; // unterminated leaves i past the end, which ends the word
      continue;
    }
    // #1239: `echo "x\"" > <protected>` needs no substitution at all — the
    // shortest bypass in the family, and the issue that filed the `$( )`
    // spellings did not name it. `endOfQuoted` honours the backslash.
    if (c === "'" || c === '"') {
      const span = endOfQuoted(s, i);
      // The span's CONTENTS, outer quotes removed. The escape is kept rather
      // than resolved: this module expands nothing, and keeping the text
      // verbatim is what lets `isScratchPath` go on reading an unexpanded
      // path as unprovable (#1175). What had to be right here is the word
      // BOUNDARY, so the operator after it is still seen.
      //
      // #1471: this read `end === s.length ? s.length : end - 1`, which is
      // the ambiguity `endOfQuoted` now resolves for it. `contentEnd` is the
      // answer, not a ternary this site re-derives.
      w += s.slice(i + 1, span.contentEnd);
      i = span.end;
      continue;
    }
    // #1205: a command substitution is part of the word it sits in, however
    // much whitespace is inside it. Ending the word at the first space split
    // `> /tmp/`id -un`/workflow-state.json` into the target `/tmp/`id` — which
    // names no protected artifact, so arm 1 never fired at all and a write to
    // a live run-store path was allowed. The space-free spelling was caught,
    // which is why this survived: the bug is the SPACE, not the substitution.
    //
    // The text is kept verbatim rather than expanded. This module does not
    // expand anything, and keeping the `$`/backtick is what lets #1175's
    // `isScratchPath` go on reading an unexpanded path as unprovable.
    if (c === '`') {
      // #1361's AI review found this one, and it is right: this was the last
      // `indexOf` partner-finder in the module. `indexOf` cannot tell `` ` ``
      // from ``\` ``, so an escaped backtick inside the substitution was read
      // as the closer, the word ended in the wrong place, and the `>` that
      // followed was never seen. No operator, no target, ALLOW — the exact
      // shape #1239 fixed for `"`, `'` and `$(...)`, surviving in the one
      // branch those fixes did not touch.
      //
      // Verified both halves before fixing, because a guard missing a command
      // bash refuses to run is not a bypass. All three spellings return no
      // targets at all AND are performed by bash:
      //
      //     echo `echo a\`b`    > <run-store>/workflow-state.json
      //     echo `echo \``      > <run-store>/workflow-state.json
      //     echo `echo \`\`x`   > <run-store>/workflow-state.json
      //
      // `endOfQuoted` already walks escapes; a backtick span escapes exactly
      // as a double-quoted one does, so this is a third caller of the one
      // scanner rather than a fourth hand-rolled one. It returns `s.length`
      // for an unterminated span, which is the same fail-closed direction
      // this branch already took.
      // Keeps the backticks, so it reads `end` and never `contentEnd` — the
      // whole span verbatim is the point here (#1175).
      const span = endOfQuoted(s, i);
      w += s.slice(i, span.end);
      i = span.end;
      continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      // #1361 merge: main extracted this walk into `endOfSubstitution` so
      // `nestedCommands` could reuse it — one reader, which is the right
      // call and is kept. #1239's backslash handling, which this branch had
      // added to the inline copy, is ported INTO that function rather than
      // left behind here. Taking main's line unchanged would have silently
      // reinstated the bypass.
      const j = endOfSubstitution(s, i);
      w += s.slice(i, j); // unterminated falls out here with j === s.length
      i = j;
      continue;
    }
    w += c;
    i++;
  }
  return [w, i];
}

/**
 * Is this redirect operand a PATH being written, or plumbing?
 *
 * `2>&1` and `>&2` name a descriptor, not a file. Keeping that distinction is
 * what lets `2>` count as a write at all (#1176): without it, dropping `2`
 * from the old lookbehind would have turned every `2>&1` in the corpus into
 * a write to a file called `&1`.
 */
function isWriteOperand(op: string): boolean {
  if (!op) return false;
  if (/^&?\d+$/.test(op) || op === '-') return false;
  return op !== '/dev/null' && op !== '/dev/stderr' && op !== '/dev/stdout';
}

/**
 * Paths a segment writes through shell redirection or a copying verb.
 *
 * #1176 replaced three substring matches with one left-to-right scan. The
 * substring version read redirects off `stripQuoted`, which deletes quoted
 * spans AND their contents, then tried to recover a wholly-quoted target in a
 * second pass — so a target quoted in the MIDDLE of the word (`> dir/"x"`)
 * was seen by neither pass. Scanning finds the operator at a position and
 * then reads the operand as a word, which is the same rule the shell uses.
 */
/**
 * One left-to-right pass over a segment, returning its WORDS and its
 * redirect TARGETS.
 *
 * #1196 made this the single tokeniser. `commandWord` previously did its own
 * `dequote(...).split(/\s+/)`, which is not tokenisation: it let a quoted
 * multi-word assignment VALUE break into separate tokens, so
 * `A="1 grep" cp …` dropped only `A=1` on the `includes('=')` skip and
 * resolved the verb to `grep`. Here a quoted span stays INSIDE its word, so
 * the same input yields the single token `A=1 grep`, which is skipped whole.
 */
function scanSegment(segment: string): { words: string[]; targets: string[] } {
  const targets: string[] = [];
  const words: string[] = [];
  const s = stripHeredocs(segment);
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n') {
      i++;
      continue;
    }
    if (c === '>') {
      i++;
      if (s[i] === '>') i++;
      while (s[i] === ' ' || s[i] === '\t') i++;
      // `>&1` — the `&` belongs to the operand, so readWord keeps it and
      // isWriteOperand rejects it.
      const [operand, next] = readWord(s, i);
      i = next;
      if (isWriteOperand(operand)) targets.push(operand);
      continue;
    }
    if (c === '<') {
      // An input redirect reads; skip it and its operand so the operand is
      // never mistaken for a command word.
      i++;
      if (s[i] === '<') i++;
      while (s[i] === ' ' || s[i] === '\t') i++;
      i = readWord(s, i)[1];
      continue;
    }
    const [w, next] = readWord(s, i);
    i = next === i ? i + 1 : next;
    // #1196 R3: an IO NUMBER is not a word. POSIX: an unquoted digit string
    // immediately preceding `<` or `>` names a file descriptor, so the `2`
    // in `2>/dev/null` belongs to the redirect. Emitting it as a word put it
    // in LAST position among a `cp`'s arguments, which is where this module
    // looks for the destination — so `cp /tmp/x.json /r/<protected>
    // 2>/dev/null` read its destination as `2` and the real one was demoted
    // to a source. Measured on the corpus: four genuine writes to a gate
    // artifact or a hook, allowed by #1188, and found only because a
    // classifier written for a different question made the same mistake.
    if (w && /^\d+$/.test(w) && (s[i] === '>' || s[i] === '<')) continue;
    if (w) words.push(w);
  }
  return { words, targets };
}

/**
 * Paths a segment writes through shell redirection or a copying verb.
 */
export function writeTargets(segment: string, whole: string = segment): string[] {
  const { words, targets } = scanSegment(segment);

  // `tee` takes MANY files. Reading only the first operand let
  // `tee /tmp/a <protected>` through (#1176).
  const teeAt = words.findIndex(w => w.replace(/^.*\//, '') === 'tee');
  if (teeAt !== -1) {
    for (const w of words.slice(teeAt + 1)) if (!w.startsWith('-')) targets.push(w);
  }

  // `cp`/`mv` take the LAST non-option argument as the destination. Reading
  // the second token instead — which this did until #1120 — mis-parses every
  // invocation carrying a flag: `cp -p src /x/workflow-state.json` read the
  // destination as `src` and never examined the real one. `verbAt` finds the
  // verb behind any wrapper and its flags (#2867).
  const at = verbAt(words, /^(?:cp|mv|install|rsync)$/);
  if (at !== -1) {
    const args: string[] = [];
    let dir: string | null = null; // `-t DIR`, `-tDIR`, `--target=DIR` (any prefix); rsync's `-t` is times
    const rsync = words[at].endsWith('rsync');
    for (let i = at + 1; i < words.length; i++) {
      const [name, ...value] = words[i].split('=');
      const long = name.length >= 3 && '--target-directory'.startsWith(name);
      // only a run of value-less flags may sit before the `t`: `-Sext` is `-S ext` (#2870)
      const short = name.startsWith('--') ? null : /^-[abdfHilLnPpRrsuvxcCDTZ]*t(.*)$/.exec(words[i]);
      if (!rsync && (long || short)) dir = (long ? value.join('=') : short![1]) || words[++i] || null;
      // a value-taking option's separate value is no operand: `--suffix .bak` (#2870)
      else if (!rsync && /^(?:-[abdfHilLnPpRrsuvxcCDTZ]*[Smog]|--(?:suffix|mode|owner|group|strip-program))$/.test(words[i])) i++;
      else if (!words[i].startsWith('-')) args.push(words[i]);
    }
    // DIR itself too: `xargs cp -t DIR` takes its sources from stdin (#2870)
    if (dir !== null) for (const src of ['', ...args]) targets.push(`${dir.replace(/\/+$/, '')}/${src.replace(/^.*\//, '')}`);
    else if (args.length >= 2) {
      const dest = args[args.length - 1];
      targets.push(dest);
      // When the destination is a DIRECTORY the real sink is
      // `dest/basename(src)`, for every source (#1184).
      if (isDirDestination(dest, args, whole)) {
        for (const src of args.slice(0, -1)) {
          targets.push(`${dest.replace(/\/+$/, '')}/${src.replace(/^.*\//, '')}`);
        }
      }
    }
  }
  return targets;
}

/**
 * Does this destination name a DIRECTORY? Four oracles, three of them
 * syntactic, in the order they settle the question cheaply.
 *
 * #1184 asked only the fourth, `statSync`, and that is #1196's R2: a
 * PreToolUse hook decides before ANY of the command has run, so in
 * `mkdir -p d && cp <protected> d` the directory never exists at decision
 * time. Measured both ways on the same command — directory absent ALLOW,
 * directory present BLOCK. A guard whose answer depends on a directory the
 * same command is about to create is not a guard.
 *
 * The reviewer's simpler repair was to delete the test and push
 * `dest/basename(src)` unconditionally. Measured on 5,543 corpus commands
 * naming a protected artifact, that refuses 19 real commands and catches no
 * real write that the oracles below miss — every one of the 19 is a
 * protected file copied OUT to a plain destination, and 11 of those are the
 * `cp hooks/X.hook.ts /tmp/x.bak` backup that
 * `.claude/rules/checks-must-be-able-to-fail.md` requires before a mutation
 * battery. A guard that refuses the repository's own mandated practice gets
 * switched off. So the test stays and gains the readings it was missing.
 */
// #1175 moved `statSync` to the import block at the top, which `isScratchPath`
// also reads from. Two `from 'fs'` statements in one module is legal and is
// still one import of one module; one of them is what a reader greps for.
function isDirDestination(dest: string, args: string[], whole: string): boolean {
  if (dest.endsWith('/')) return true; // `cp x d/` — the shell requires a dir
  if (args.length > 2) return true; // `cp a b c d` — d MUST be a directory
  if (createdAsDirectory(dest, whole)) return true; // `mkdir -p d && cp x d`
  try {
    return statSync(dest).isDirectory();
  } catch {
    return false; // unreadable reads as a plain file; that is the last-arg case
  }
}

/** Does some earlier segment of this same command `mkdir` the destination? */
function createdAsDirectory(dest: string, whole: string): boolean {
  const want = dest.replace(/\/+$/, '');
  for (const seg of segments(whole)) {
    if (commandWord(seg) !== 'mkdir') continue;
    for (const a of scanSegment(seg).words.slice(1)) {
      if (!a.startsWith('-') && a.replace(/\/+$/, '') === want) return true;
    }
  }
  return false;
}

// `statSync` used to be declared here, beside its only reader. #1175 gave it
// a second reader in `isScratchPath` at the top of the module, so the import
// moved to the import block rather than being written twice.

/**
 * Non-option arguments of a segment, dequoted. This is what an in-place verb
 * actually operates on — as opposed to its script, which is an argument too
 * but names files only as text.
 */
export function argumentsOf(segment: string): string[] {
  const out: string[] = [];
  // Tokens that survive heredoc and quote stripping are bare words; quoted
  // tokens are recovered individually so a quoted PATH still counts while a
  // quoted sed SCRIPT does not reach the protected-name test as a path.
  for (const t of stripQuoted(segment).trim().split(/\s+/)) {
    if (t && !t.startsWith('-')) out.push(t);
  }
  // Heredoc bodies are stripped FIRST: a quoted path inside the document
  // being written is not an argument to the command writing it.
  for (const m of stripHeredocs(segment).matchAll(/(['"])([^'"\s]*[/.][^'"\s]*)\1/g)) out.push(m[2]);
  return out;
}

/**
 * Does a protected name sit NEAR a declared write verb in an interpreter
 * body? Proximity, not parsing (ADR-027 decision 3).
 *
 * The window opens 80 characters before the start of the path the name ends
 * and closes 80 after the path's end, so a long directory or a long tail
 * does not move the verb out of reach (#2858; `$TMPDIR` alone is long
 * enough). Path starts come from one forward pass and every match in one
 * path is one window, so the cost is linear. The name is matched without
 * case, the Unicode way, as `names` matches it (#1184).
 *
 * **Conceded** (review of #2863, round 3): a separator inside the directory
 * — a `(`, `,` or `=` more than 80 characters after the verb — ends the
 * guessed path start early, and a space in a long file name ends the tail.
 * Spanning the whole string literal closed both and newly refused 3 real
 * spec and plan edits, so CONCESSION rows pin the spellings instead. So
 * does a verb separated from the path by other text (a long source).
 */
function writesNear(body: string, protectedName: string): boolean {
  const WINDOW = 80;
  let scanned = 0;
  let lastStop = -1;
  let pathStart = -1;
  let lastEnd = -1;
  const windowWrites = (): boolean => {
    if (pathStart < 0) return false;
    let pathEnd = lastEnd;
    // Whitespace ends the tail, though not the start: a tail is a file name,
    // and without it the "path" ran on through prose to the next quote
    // (2 real commands editing a spec newly refused, measured).
    while (pathEnd < body.length && !PATH_STOPS.has(body[pathEnd]) && !/\s/.test(body[pathEnd])) pathEnd++;
    return WRITE_INTENT.test(body.slice(Math.max(0, pathStart - WINDOW), pathEnd + WINDOW));
  };
  for (const m of body.matchAll(new RegExp(protectedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'))) {
    const at = m.index ?? 0;
    for (; scanned < at; scanned++) if (PATH_STOPS.has(body[scanned])) lastStop = scanned;
    if (lastStop + 1 !== pathStart) {
      if (windowWrites()) return true;
      pathStart = lastStop + 1;
    }
    lastEnd = at + m[0].length;
  }
  return windowWrites();
}

/**
 * What ends a path word in an interpreter body. Not a space or a tab: a path
 * can hold one (`Application Support`), and a stop inside it opened the
 * window past the verb (review of #2863, round 2). Every argument separator
 * that is not whitespace still stops it, so the window opens no earlier than
 * the literal or the call the path sits in.
 */
const PATH_STOPS = new Set(['\n', '\r', "'", '"', '`', '(', ',', '=', '[', '{', ';', '+']);

/**
 * Verbs that modify a named file in place, with no redirect for
 * `writeTargets` to see. `sed -i` is the ordinary way to edit a file from a
 * shell, so its absence was a plain hole rather than an exotic one.
 */
const IN_PLACE = [
  /\bsed\b[^\n]*\s-i\b/,
  /\bperl\b[^\n]*\s-[a-z]*i\b/,
  /\bdd\b[^\n]*\bof=/,
  /\btruncate\b/,
  /\brm\b/,
  /\bgit\s+(?:checkout|restore)\b/,
  // #1146: extended attributes are file metadata, and `com.apple.provenance`
  // is what was blocking writes to the hooks on this machine — so removing it
  // is a mutation of hook integrity by any reading.
  //
  // The mutating forms are read off `xattr --help`, not guessed:
  //
  //   xattr [-lrsvx] file …             list      READ
  //   xattr -p [-lrsvx] attr file …     print     READ
  //   xattr -w [-rsx] attr value file   set       MUTATES
  //   xattr -d [-rsv] attr file …       delete    MUTATES
  //   xattr -c [-rsv] file …            clear ALL MUTATES
  //
  // So the letters are `c`, `d`, `w` — and they may sit ANYWHERE in a flag
  // cluster, which is why this does not read a single letter. The first
  // revision of this PR shipped `-[dws]`, wrong in both directions against
  // that table: it missed `-c`, which deletes every attribute on the file,
  // and it refused `-s`, which only says "act on the symbolic link itself".
  // Seven of fifteen spellings were decided wrongly.
  //
  // A bare invocation carries no leading dash, so the READ that this arm
  // must not refuse — two real corpus commands run `xattr <hook>` to inspect
  // the attribute list — is excluded by construction rather than by a list.
  /\bxattr\b[^\n]*\s-[A-Za-z]*[cdw][A-Za-z]*\b/,
];

// #1240: the list moved to `lib/interpreters.ts`, which `lib/bash-file-read.ts`
// now reads too. Two modules were answering "is this an interpreter" with two
// different lists, and the narrower one was why a `python3` heredoc read as a
// document.

/**
 * Interpreters whose `-c` argument is SHELL — which this module can read.
 *
 * #1176: these were being handed to `WRITE_INTENT`, which enumerates Node and
 * Python idioms, so `bash -c 'echo x > <protected>'` matched nothing and was
 * allowed. Arm 1 could not see it either, because the body is quoted. The
 * body is shell, the module parses shell, so it recurses instead of guessing.
 *
 * #1240: also in `lib/interpreters.ts` as `isShellWord`.
 */

/** The `-c` body of a shell invocation, dequoted. */
/** What `eval` runs: the words after it, joined as the shell joins them before re-reading. */
const evalBody = (seg: string) => { const w = scanSegment(seg).words; return w.slice(w.findIndex(x => commandWord(x) === 'eval') + 1).join(' '); };

function shellBody(segment: string): string {
  // The same flag grammar as `programBody`: a grouped capital (`bash -Ec`)
  // and a body attached to its flag (`bash -c'…'`) are both a `-c` body
  // (security review of #2863's round 3).
  const m = /\s-[A-Za-z]*c\s*([\s\S]+)$/.exec(segment);
  return m ? dequote(m[1]).trim() : '';
}

/**
 * A quoted `open` mode that writes (#2699 review): up to three of r w a x b
 * t +, at most one of r w a x and one of b t, with w, a, x or + among them.
 * So 'w', 'wb', 'a+', 'r+' and 'w+b' write; 'r', 'rb' and 'rt' do not, nor a
 * word like 'raw' or 'bat'. The mode used to be `[wax]\+?`, so
 * `open(p, 'wb')` was not a write, on main too. `WRITE_INTENT` reads it
 * from here. It captures nothing, so it composes into a pattern any number
 * of times.
 */
const MODE_BODY = String.raw`(?=[rwaxbt+]{1,3}['"])(?![^'"]*[rwax][^'"]*[rwax])(?![^'"]*[bt][^'"]*[bt])(?=[^'"]*[wax+])[rwaxbt+]{1,3}`;
const WRITE_MODE_SOURCE = `(?:'${MODE_BODY}'|"${MODE_BODY}")`;

/**
 * Declared write intent inside an interpreter body.
 *
 * Refusing every interpreter that names a protected artifact was measured
 * (1,760 of 5,060 real commands newly refused, all reads), so the arm fires
 * on a declared write VERB instead. An interpreter can always evade it — build
 * the name, call through a variable, put the program in a file. It raises
 * the cost of an accidental write and of the obvious deliberate one.
 *
 * A program that writes through an imported project function is outside
 * what a command-line guard can decide (#1214): the harness's own GOAL step
 * and the repair it prints (`writeWorkflowState` via `bun -e`) are that same
 * call on that same path, and `test/bash-write-guard.test.ts` pins them
 * allowed. Telling them apart is a question of provenance, not text.
 *
 * Shell idioms (`>`, `tee`, `rm`) are not in the list (#1176): inside a body
 * that is not shell they match the host language (`x=>x.id` read as `>`).
 */
const WRITE_INTENT = new RegExp(
  // #2701: the callback forms beside the `Sync` ones, `shutil`'s other
  // copies, any `.rename(`/`.unlink(`/`.rm(`/`.truncate(`, and `os.open`
  // with a write flag.
  String.raw`\b(?:writeFileSync|appendFileSync|createWriteStream|copyFileSync|renameSync|unlinkSync|rmSync|truncateSync|writeFile|appendFile|copyFile|cpSync|write_text|write_bytes|json\.dump|os\.remove|os\.rename|os\.replace|os\.unlink|shutil\.(?:copy2?|copyfile|copytree|move|rmtree))\b|\.(?:rename|unlink|rm|truncate|cp)\s*\(|\bos\.open\s*\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\bO_(?:WRONLY|RDWR|CREAT|TRUNC|APPEND)\b|(?<!stdout)(?<!stderr)\.write\s*\(|\bopen(?:Sync)?\s*\([^)]*` +
    WRITE_MODE_SOURCE +
    // #2699 review: the mode after nested calls in the path, two levels deep.
    // Deeper nesting is outside the window: the reader that followed it went
    // with the rest of program-body reading in #2858 (ADR-027 decision 3).
    String.raw`|\bopen(?:Sync)?\s*\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*` +
    WRITE_MODE_SOURCE,
);



/** `find` actions that run or delete rather than print. */
const FIND_MUTATING = /\s-(?:delete|exec|execdir|ok|okdir)\b/;

/**
 * Does this text name a protected artifact? Pass a DEQUOTED segment.
 *
 * #1184: folded to lower case. Measured on this machine, `WORKFLOW-STATE.JSON`
 * and `workflow-state.json` resolve to the SAME INODE — the default macOS
 * filesystem is case-insensitive — so a case-sensitive match let the
 * uppercase spelling of every protected artifact through. On a case-sensitive
 * filesystem the two are different files, so folding costs only a refusal of
 * a file that cannot coexist with the real one where it matters.
 */
function names(text: string, list: string[]): string | null {
  const hay = text.toLowerCase();
  for (const p of list) if (hay.includes(p.toLowerCase())) return p;
  return null;
}

/**
 * Protected artifacts this text names somewhere OTHER than a scratch tree
 * (#1175).
 *
 * A name is exempted only when EVERY path word carrying it is scratch. One
 * mention of the live artifact alongside ten fixtures still refuses, which is
 * the direction a guard should err in and also the common real shape: a
 * command that copies a fixture over a run's state names both.
 */
function namesOutsideScratch(text: string, list: string[], exempt: Exemption): string[] {
  const out: string[] = [];
  for (const p of list) {
    const words = pathWordsContaining(text, p);
    if (words.length === 0) continue;
    if (words.every(exempt)) continue;
    out.push(p);
  }
  return out;
}

/**
 * The `-c`/`-e` program of an interpreter segment, with only its OUTER
 * quoting removed (#1277).
 *
 * `shellBody` next door `dequote`s, which is right for a shell body about to
 * be re-parsed as shell and wrong for every other language: it deletes the
 * only thing that marks where one string literal ends and the next
 * expression begins, and the write-intent window reads an `open(…, 'w')`
 * mode by its quotes. An unmatched outer quote leaves the text as it stands.
 */
export function programBody(segment: string): string {
  // `\s*`, not `\s+`: `python3 -c'open(…)'` hands python the body with no
  // space after the flag, and an empty view here hid its quoted `open` mode
  // (review of #2863, round 2).
  // `[A-Za-z]`: `python3 -Ic …` groups `-I` with `-c` (review of #2863, round 3).
  const m = /\s-[A-Za-z]*[ce]\s*([\s\S]+)$/.exec(segment);
  if (!m) return '';
  const raw = m[1].trim();
  const q = raw[0];
  if ((q === "'" || q === '"') && raw.length > 1 && raw[raw.length - 1] === q) {
    return raw.slice(1, -1);
  }
  return raw;
}

const ALL_PROTECTED = [...PROTECTED_FILES, ...PROTECTED_HOOKS];

/**
 * Decide a Bash tool call.
 *
 * Returns `{ blocked: false }` for anything this module cannot show is a
 * write to a protected artifact. That default is deliberate and is the
 * reason the checks above are structural: a guard tuned so wide that people
 * work around it protects nothing, and four real refusals of read-only work
 * is already a pattern.
 *
 * A shell write's scratch exemption is `scratchExempt`, the target's real
 * directory, and a command that makes a link anywhere has none (ADR-027
 * decision 4). A shell body this command runs is decided as a command of its
 * own and inherits that (`linkInCommand`). An interpreter body that is not
 * shell gets no exemption at all (#2858).
 */
export function decideBashWrite(cmd: string, depth = 0, linkInCommand = false): BashWriteDecision {
  if (!cmd) return ALLOW;
  // A shell body can contain a shell body. Bounded so a crafted nest costs a
  // fixed amount of work rather than the session.
  if (depth > 3) return ALLOW;
  const links = linkInCommand || makesLink(cmd);
  const exempt: Exemption = links ? NO_EXEMPTION : scratchExempt;

  // #1240: a program handed to an interpreter on stdin, which every arm
  // below would otherwise see as one word (`bash`). A shell program is
  // decided as a command of its own; any other gets arm 3's question.
  for (const { shell, program, quoted } of interpreterPrograms(cmd)) {
    if (shell) {
      const inner = decideBashWrite(program, depth + 1, links);
      if (inner.blocked) return inner;
      continue;
    }
    // #2858 (ADR-027): a declared write verb near a protected name refuses
    // it, wherever the name points and however it is spelled, relative too.
    const pf = ALL_PROTECTED.find(
      p => names(program, [p]) !== null && (writesNear(program, p) || (quoted !== undefined && writesNear(quoted, p))),
    );
    if (pf) {
      return {
        blocked: true,
        reason:
          `Bash command runs an interpreter or a mutating \`find\` naming "${pf}". ` +
          `What it writes cannot be read off the command line, so it is refused.`,
      };
    }
  }

  // A command substitution runs a command of its own, in double quotes too:
  // `echo "$(cp a b)"` (#2870). Single-quoted text runs nothing, so it is
  // blanked to find them, and each body is read from the unblanked text.
  const text = stripHeredocs(cmd);
  const view = text.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, q => (q[0] === "'" ? ' '.repeat(q.length) : q)); // stripQuoted's spans
  for (const m of view.matchAll(/\$\(([^()]*)\)|(?<!\\)`([^`]*)`/g)) {
    const open = m.index + (m[1] !== undefined ? 2 : 1);
    const inner = decideBashWrite(text.slice(open, m.index + m[0].length - 1), depth + 1, links);
    if (inner.blocked) return inner;
  }

  const segs = segments(cmd);
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const bare = dequote(seg); // TARGET view: contents kept
    const code = stripQuoted(seg); // VERB view: quoted spans gone
    const word = commandWord(seg);

    // 0. A link is refused by name when any argument names a protected
    //    artifact, wherever it points, dangling and hard links included
    //    (ADR-027 decision 4). No exemption: a link is how a scratch name
    //    reaches a live file.
    if (segmentLinks(seg)) {
      const pf = names(scanSegment(seg).words.join(' '), ALL_PROTECTED);
      if (pf) {
        return { blocked: true, reason: `Bash command makes a link naming "${pf}". A link to or from a protected artifact is refused.` };
      }
    }

    // 1. Shell redirection and copying verbs. Never exempted by anything:
    //    this is the arm the old allowlist sat above, which is #1120.
    // The whole command is passed so `cp x d` can read `d` as a directory
    // an EARLIER `mkdir` made (#1196 R2). Everything else is per-segment.
    for (const target of writeTargets(seg, cmd)) {
      // #1175: the target IS a path, so the tree question is asked directly
      // here rather than through `namesOutsideScratch`.
      if (exempt(target)) continue;
      // A scratch target that is not exempt is a fixture with a missing
      // directory, a link on its path, or a link made in the command (#2859).
      const hint = isScratchPath(target)
        ? ' For a fixture: make its directory in a command of its own first, and make no link in the same command.'
        : '';
      const pf = names(target, PROTECTED_FILES);
      if (pf) {
        return {
          blocked: true,
          reason: `Bash write to protected file "${pf}" blocked. Use gate-runner.ts for gate results.${hint}`,
        };
      }
      if (names(target, PROTECTED_HOOKS)) {
        return { blocked: true, reason: `Bash write to hook file blocked. Hook integrity is protected.${hint}` };
      }
    }

    // 2. In-place mutation. The verb is read off `code`, and the target must
    //    be an ARGUMENT — not any text in the segment. `sed -i '' "s/|
    //    X.hook.ts |/…/" NOTES.md` edits a markdown file and merely mentions
    //    a hook in its script; matching the whole segment refused it.
    //    #1184: the resolved command word is prepended, so a QUOTED in-place
    //    verb is still seen. Prepending rather than testing the dequoted
    //    segment keeps the measured false positive out: `sed -i '' "s/|
    //    X.hook.ts |/…/" NOTES.md` must not match `rm` because some quoted
    //    text contains it, and `grep "rm -rf …"` must stay a grep.
    const verbView = `${word} ${code}`;
    if (IN_PLACE.some(p => p.test(verbView))) {
      const pf = namesOutsideScratch(argumentsOf(seg).join(' '), ALL_PROTECTED, exempt)[0];
      if (pf) {
        return {
          blocked: true,
          reason: `Bash command modifies "${pf}" in place. Use gate-runner.ts for gate results.`,
        };
      }
    }

    // 3. Interpreter bodies and mutating `find`. These write with no shell
    //    redirect, so arm 1 sees nothing at all. See WRITE_INTENT for why
    //    this asks for a declared write verb rather than refusing every
    //    interpreter that names a protected artifact, and for what that
    //    concession costs.
    const isInterpreter = isInterpreterWord(word) && /\s-[A-Za-z]*[ce]\b/.test(code);
    const isMutatingFind = word === 'find' && FIND_MUTATING.test(code);

    // 3a. A shell `-c` body is shell, so it is read as shell, not scanned for
    //     Node and Python idioms (#1176). So is what `eval` runs: its words,
    //     quoted or not, joined into one command line (#2870 round 5).
    const sh = isInterpreter && isShellWord(word) ? shellBody(seg) : word === 'eval' ? evalBody(seg) : '';
    const inner = sh ? decideBashWrite(sh, depth + 1, links) : ALLOW;
    if (inner.blocked) return inner;

    if (isInterpreter || isMutatingFind) {
      // #1214 asked for a third reading here — an imported project symbol
      // called with a protected path — and it was built, measured and
      // REJECTED. See `WRITE_INTENT` for the numbers and for the one fact
      // that decided it.
      //
      // #2858 (ADR-027 decisions 2 and 3): an interpreter body gets no
      // scratch exemption. Reading a program for where it writes was deleted
      // with `bodyTargets` and `callWrites`: no real command used the
      // exemption, and every review of it found a way through. So a declared
      // write verb near a protected name refuses the body wherever the name
      // points, and a verb the window cannot see allows it — an accident
      // guard's trade, stated in ADR-027.
      //
      // A mutating `find` keeps the plain `exempt`: its destinations are
      // SHELL WORDS on the command line, so `namesOutsideScratch` asks the
      // target question of them directly. A shell `-c` body does not: arm 3a
      // has already judged its shell writes with the exemption, and what is
      // left for this arm is a write VERB near a name, which in a shell body
      // can only be an interpreter body inside it. Exempting that let
      // `bash -c "mkdir -p /tmp/q && python3 -c \"open('/tmp/q/…','w')\""`
      // through, while the same body unwrapped was refused (local review).
      //
      // The window reads two views of one text. `bare` has had every quote
      // stripped by `dequote`, so a name split across adjacent literals is
      // whole there (#1407 security review); the body keeps its quotes, so
      // an `open(…, 'w')` mode is still a quoted literal there, which is what
      // `WRITE_INTENT` matches.
      const body = programBody(seg);
      const candidates = namesOutsideScratch(bare, ALL_PROTECTED, isMutatingFind ? exempt : NO_EXEMPTION);
      const pf = isMutatingFind ? (candidates[0] ?? null) : (candidates.find(p => writesNear(bare, p) || writesNear(body, p)) ?? null);
      if (pf) {
        return {
          blocked: true,
          reason:
            `Bash command runs an interpreter or a mutating \`find\` naming "${pf}". ` +
            `What it writes cannot be read off the command line, so it is refused.`,
        };
      }
    }

    // 4. Permission changes on a protected artifact. The COMMAND WORD must be
    //    the verb, not a `chmod` somewhere in the string, and the target is
    //    read off `bare`, so quoting it does not hide it. Every protected
    //    artifact counts (#1146): mode bits are how a file stops being writable.
    const permTarget =
      word === 'chmod' || word === 'chflags'
        ? (namesOutsideScratch(bare, ALL_PROTECTED, exempt)[0] ?? null)
        : null;
    if (permTarget) {
      return {
        blocked: true,
        reason: `Permission change on protected artifact "${permTarget}" blocked. Integrity is protected.`,
      };
    }

    // 5. The gate salt in the Keychain. The command word must BE `security`
    //    (an issue comment quoting the command is not an invocation), and the
    //    key is matched across the whole command, so a variable cannot hide it.
    if (word === 'security' && dequote(cmd).toLowerCase().includes('pai-gate-salt')) {
      return { blocked: true, reason: 'Access to gate salt Keychain entry blocked.' };
    }
  }

  return ALLOW;
}
