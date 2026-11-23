/**
 * The decision behind `hooks/BashWriteGuard.hook.ts` (#473 on
 * `hornjason/pai-config`, tuned there in #474, reworked in #1120).
 *
 * Extracted from the hook so the population it refuses can be MEASURED
 * rather than argued about: 5,060 real commands from this machine's
 * transcripts were run through it, which is not something you can do with a
 * decision that only exists inside a subprocess. Same shape as
 * `lib/gate-result-protection.ts`, which #1137 extracted for the same reason.
 *
 * ## The thing this module exists to get right
 *
 * One mechanism was failing in BOTH directions at once.
 *
 * It UNDER-blocked, because a read-only prefix allowlist was consulted before
 * anything looked at what the command wrote, so `gh --version; echo x >
 * .gate-salt` exited clean. A prefix says nothing about what follows a `;`.
 *
 * It OVER-blocked, because the remaining checks matched protected names
 * anywhere in the command STRING, so a read-only `git show … | grep -nE
 * "chmod|chflags"` was refused for quoting the words it was searching for.
 * That happened four times in real work — twice to the session coordinating
 * this fix, twice to a peer staging a comparison copy — and a guard that
 * makes reading its own source awkward is a guard people route around.
 *
 * Both directions are the same root cause: a substring test over a whole
 * command line cannot tell CODE from DATA. So nothing here tests the whole
 * string. The command is split into segments at top-level separators, and
 * each check asks a structural question of a segment:
 *
 *   - what does this segment WRITE?          → redirects, tee, cp/mv
 *   - what does this segment MUTATE in place? → sed -i, dd of=, rm, …
 *   - is this segment OPAQUE?                 → an interpreter body, find -exec
 *   - is this segment's COMMAND WORD chmod?   → not "does it contain chmod"
 *
 * Quotes are handled two different ways on purpose, and the distinction is
 * the whole fix:
 *
 *   `stripQuoted`  deletes quoted spans INCLUDING their contents. Used to
 *                  find a VERB, because text inside quotes is an argument,
 *                  never the command the shell runs. This is what stops a
 *                  grep PATTERN from reading as a chmod invocation.
 *   `dequote`      removes quote characters and KEEPS the contents. Used to
 *                  find a TARGET, because `chmod 777 "x.hook.ts"` really does
 *                  name a hook file.
 *
 * Using `stripQuoted` for both would let an attacker quote the path; using
 * `dequote` for both reinstates all four false positives. Each test below
 * names which one it uses and why.
 *
 * ## The names are global; the artifacts are not (#1175)
 *
 * `PROTECTED_FILES` is a list of NAMES, and until #1175 a name matched in any
 * tree. A fixture at `/tmp/rg-abc/workflow-state.json` was refused as readily
 * as a live run's state, which is a true positive against the rule and a false
 * positive against intent — agents on this repo build such fixtures
 * constantly, including fixtures for this module.
 *
 * The scoping is by SCRATCH TREE rather than by project root, and that is a
 * measurement and not a preference. #1175's acceptance asked for "the path
 * relative to the project root". Swept over 5,531 real commands, the gate
 * artifacts named in them resolve like this:
 *
 *     2,620  under the run store (`$RUNGATE_WORK_DIR`, i.e. `~/.rungate`)
 *       521  under a former run store (`~/.pai-work`) or `~/.claude`
 *     1,724  no resolvable path at all — a bare basename, or built by `join`
 *        83  under an OS temp root
 *        65  relative
 *        16  under a repository tree
 *
 * A live `workflow-state.json` is almost never inside the project root: it is
 * in the run store, one level up and sideways. "Protect what is under the
 * root" would therefore have stopped protecting 3,141 of 3,240 absolute
 * references — reopening `pai-config#473` C1, the forge-a-gate-result attack
 * this guard was built for. The root-relative reading is recorded here as
 * MEASURED WRONG rather than merely not chosen.
 *
 * So the question asked is the fail-closed one: can this path be shown to be
 * in a scratch tree? Only then is it a fixture. Every other answer —
 * elsewhere, relative, or not a path at all — keeps the old refusal. An
 * allowlist is normally the wrong shape here and `pai-config#474`'s
 * read-only-prefix list is why: a PREFIX says nothing about what a command
 * writes. A scratch root says something about the DESTINATION, is consulted
 * only after the destination has been extracted, and is not a judgement call
 * — each entry is a value `mktemp -d` returns on a supported platform.
 * Narrowing it over-blocks; it cannot open a hole.
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
 * The trees an OS temporary directory can be in.
 *
 * `/tmp` and `/private/tmp` are both listed because on macOS they are the
 * same directory under two names and a command may spell either; `resolve()`
 * normalises `..` but does not follow links, and the link cannot be followed
 * here because the path being judged usually does not exist yet — it is about
 * to be created. `/var/folders` is where macOS puts a per-user `$TMPDIR`, and
 * `tmpdir()` covers whatever the platform or the environment says, which is
 * what `mkdtemp`, `mkstemp` and `mktemp -d` all build on.
 *
 * Each root is also recorded in its REALPATH form. On macOS `/var` is a
 * symlink to `/private/var`, so `tmpdir()` hands back `/var/folders/…/T`
 * while the resolution below hands back `/private/var/folders/…/T`, and a
 * list holding only the first form answers `false` for every path spelled
 * the way `mkdtemp` hands it to a program.
 *
 * The corpus does NOT show this, and saying so is the point: real commands
 * spell `/tmp` literally, so all 37 fixture commands clear either way. It
 * was found by `isScratchPath, asserted directly` calling `tmpdir()`, which
 * is what a program does and what a person does not. A sweep over what
 * people typed cannot see a defect in what their programs compute.
 *
 * Read at call time rather than frozen at import, because `TMPDIR` is what a
 * test harness moves when it wants its own scratch space, and a guard that
 * cached the old value would refuse the new one.
 *
 * ## `TMPDIR` is the writer's variable, so it is not trusted
 *
 * The first version of this took `process.env.TMPDIR` as given. Measured:
 *
 *     TMPDIR unset                  isScratchPath(…/.rungate/x/…) = false
 *     TMPDIR=$HOME/.rungate                                       = true
 *
 * The agent whose write is being judged sets the variable that decides
 * whether the write is exempt, and pointing it at the run store switches the
 * guard off for the one directory it exists to protect. `tmpdir()` is the
 * same hole wearing a function call — on POSIX it READS `TMPDIR`.
 *
 * So `FIXED` is the whole of the trust, and the environment can only ever
 * SELECT within it: a `TMPDIR` that does not already resolve inside a fixed
 * root is dropped. A platform whose temp directory is somewhere else
 * over-blocks, which is the direction this module is allowed to be wrong in.
 */
const FIXED_SCRATCH_ROOTS = ['/tmp', '/private/tmp', '/var/folders'];

/**
 * Trees that hold LIVE artifacts, wherever on the disk they are.
 *
 * This is SUBTRACTED from the exemption in `isScratchPath`, not merely used
 * to vet the root list. The difference matters: vetting roots is a proxy for
 * the property, and it only holds for roots somebody thought of. Subtracting
 * the trees themselves IS the property — "a live artifact is never exempt" —
 * and it keeps holding when a root is added later by someone who has not
 * read this comment.
 *
 * The two mechanisms are also not interchangeable, and conflating them was
 * measured. Dropping a ROOT because it contains a protected tree removes
 * `/tmp` wholesale the moment `RUNGATE_WORK_DIR` points inside it — which a
 * real corpus command does — and refuses every fixture on the machine.
 * Subtracting the TREE removes only that subtree and leaves the rest of
 * `/tmp` exempt. So the root list is vetted only against trees that are not
 * themselves scratch, and the subtraction below applies unconditionally.
 *
 * ## The hook directories are here because a checkout CAN be the live hook
 *
 * A review argued that `PROTECTED_HOOKS` should lose the scratch exemption
 * entirely, on the grounds that a `.hook.ts` under `/tmp` is as likely to be
 * a real checkout as a fixture — worktrees under `/tmp` are routine here.
 * The counter-argument offered was that a hook source in a checkout is not
 * the live hook, so compromising one does nothing until it is deployed.
 *
 * That counter-argument is FALSE on this machine, and `lib/hook-target-tree.ts`
 * is where it was measured: every registration in `~/.claude/settings.json`
 * is spelled `${PAI_HOOKS_DIR}/…` or `${RUNGATE_HOOKS_DIR}/…`, and
 * `RUNGATE_HOOKS_DIR` resolved to *a checkout that is not this one*, with
 * fourteen hooks executing from it. #999's shell-injection fix never reached
 * the bytes that run. A checkout is the live hook exactly when a variable
 * says it is.
 *
 * So the answer is neither "refuse the exemption for hooks" nor "trust the
 * checkout": resolve where the registrations actually point and subtract
 * THAT, wherever it is — including when it is under `/tmp`. A hook in a
 * worktree nothing registers stays a fixture, which is the case #1175 exists
 * for; a hook in the tree that is actually wired stays protected, which is
 * the case the review was worried about.
 *
 * `process.cwd()` is deliberately NOT here, and the reason is measured. A
 * checkout under `/tmp` is ordinary on this machine — the worktree this was
 * written in is `/private/tmp/rg-1175-wt` — so treating the working
 * directory as protected drops `/private/tmp` from the roots, and because
 * `/tmp` realpaths to it the walk then refuses every `/tmp` path as well.
 * 12 of 145 tests red, measured.
 *
 * ## BOTH spellings, which #1175 got wrong
 *
 * `resolve()` normalises `.` and `..`; it does not follow a symlink. So a
 * tree named `/tmp/e2e` stayed in this list as `/tmp/e2e` while a path
 * through the same inode reads `/private/tmp/e2e/…`, and `inAnyTree`
 * matches neither spelling against the other. Executed against the module
 * as merged, with `RUNGATE_WORK_DIR=/tmp/e2e`:
 *
 *     /tmp/e2e/s/workflow-state.json           blocked
 *     /private/tmp/e2e/s/workflow-state.json   ALLOWED   ← the run store
 *
 * The same for `RUNGATE_HOOKS_DIR`, and `/tmp` is a symlink to
 * `/private/tmp` on every macOS install, so the second spelling is not
 * exotic — it is what `realpath` prints.
 *
 * `scratchRoots()` below already recorded both spellings for the fixed
 * roots, so the asymmetry was inside one file: the roots a write may land
 * in were realpathed and the trees it may not were not. A `catch` here
 * means the tree is not on disk, which is ordinary for a variable pointing
 * at a directory the command is about to create, and the resolved spelling
 * stands on its own.
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
 * Is this path demonstrably inside a scratch tree?
 *
 * Only an ABSOLUTE path can be placed in a tree, so everything else — a bare
 * basename, a relative path, a `join(dir, "workflow-state.json")` whose `dir`
 * lives in a variable — answers `false` and stays refused. That is the whole
 * fail-closed property: this function's job is to say YES, and silence means
 * the old behaviour.
 *
 * `resolve()` first, per #1129: a destination spelled `/tmp/../Users/me/
 * .rungate/x/workflow-state.json` is not in `/tmp`, and comparing the
 * unnormalised string would say it is.
 *
 * The deepest EXISTING ancestor is then realpath'd, which is the half
 * `resolve()` cannot do. Without it, `ln -s ~/.rungate/slug /tmp/esc` followed
 * by a write to `/tmp/esc/workflow-state.json` is a two-command bypass of the
 * thing this guard protects. The stat happens only after a protected NAME has
 * already matched, so the common command pays nothing for it.
 *
 * It does NOT close the case where the link is made by the SAME command —
 * see `chainHolds` (#1367), which is where that is handled, because the answer
 * is a property of the command and not of the path.
 *
 * An UNEXPANDED expansion is refused. `/tmp/$X/workflow-state.json` is not a
 * path, it is a path the shell will build, and `$X` may be `../../Users/me/
 * .rungate/slug`. Five of the six spellings a review raised were already
 * refused by `resolve()` and the `startsWith('/')` precondition — `${X}`, the
 * backtick form, `/tmp/../…`, `$HOME/…` and `~/…` — and this is the sixth.
 * Measured cost of refusing it: 0 of the 37 commands this branch clears, with
 * 209 corpus-wide carrying a `$` in an artifact path, none of them in the
 * population at stake.
 *
 * Both exits below return `false`. They are all but unreachable — the
 * deepest artifact path in the corpus is 6 components against a cap of 64,
 * and the walk only runs out of parents if `realpathSync('/')` throws — but
 * an unreachable fail-OPEN in a fail-closed module is a line that reads as
 * permission, and the next person to make the walk reachable inherits it.
 */

/**
 * Glob and brace metacharacters, tested against the DIRECTORY part only.
 *
 * `echo '{}' > /tmp/sym*​/workflow-state.json`, with `/tmp/syma` a symlink
 * into the run store: `/tmp/sym*` does not exist, the walk climbs past it to
 * `/tmp`, and the path is exempted — then the shell expands the glob and the
 * write goes through the link. Same escape as the symlink case with no `ln`
 * in the command for a reader of the command to see.
 *
 * Only the directory part is tested, and that is measured rather than
 * cautious. A glob in the BASENAME is already safe, because the directory
 * above it is the thing `resolveThroughLinks` resolves — built and executed:
 * with `SRC/syma` linked out of scratch, `SRC/syma/*.json` answers false and
 * `SRC/sym*​/x` answered true. So the basename case needs no refusal, and
 * refusing it anyway costs a real command: `rm -f /tmp/713-battery/
 * pai-wrongfix/*.hook.ts` is 1 of the 37 this branch clears, and a blanket
 * metacharacter class takes it back. Restricting the test to the directory
 * part closes the escape at a measured cost of 0.
 *
 * The exact class a review proposed, `[$`*?[]{}~]` tested against the whole
 * path, was swept over the same 5,573-command corpus: it takes back 1 of the
 * 37, that `rm -f`. It does not ship on caution either way — it ships on the
 * reading, and the reading is 1 against 0.
 */
const UNRESOLVED_DIR = /[*?[\]{}]/;
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
 * Can this destination be shown to be what it looks like when the write
 * RUNS, and not only when the decision is taken? (#1367)
 *
 * `isScratchPath` resolves the destination's existing ancestors at DECISION
 * time. A command that plants a link before it writes invalidates that
 * resolution between the decision and the execution, and the whole thing
 * fits in one command:
 *
 *     ln -s ~/.rungate/victim /tmp/esc && echo '{}' > /tmp/esc/workflow-state.json
 *
 * At decision time `/tmp/esc` does not exist, the walk reaches `/tmp`, and
 * the write is exempted. Then the shell creates the link and the write lands
 * in the run store. Both halves were executed in the #1175 review: no second
 * actor is required.
 *
 * ## The verb list this replaces, and why it was deleted
 *
 * Until #1367 the answer was a list of ways to make a link: a raw-text regex
 * (`ln`, `symlinkSync`, `os.symlink`, `symlink(`), an `ln` command-word test,
 * and a `cp`/`install` flag reader (#1411). A list of ways to make a link is
 * wrong the moment somebody uses one that is not on it, and seven were not:
 * `pathlib`'s `symlink_to`, `ruby`'s `File.symlink` without parentheses, and
 * `cp -a`, `cp -r`, `mv`, `rsync -a` or `tar -x` carrying a link planted by
 * an earlier command (#1425). All seven are witness rows in the tests.
 *
 * ## The property: the chain is REAL
 *
 * Every directory between the scratch root and the destination must exist
 * NOW, or be made by a `mkdir` in this same command. A directory that exists
 * cannot become a link without being removed first, and a directory `mkdir`
 * makes is a directory — so a link the command makes cannot be in the chain,
 * whatever verb makes it.
 *
 * A directory that neither exists nor is made is refused. The write into it
 * would fail unless something in the command makes it, and the things that
 * make it without `mkdir` are the ones this exists to catch.
 *
 * ## Why that alone was not enough to delete the list
 *
 * Built and run with only the paragraph above, three bypasses the list
 * caught were re-opened — each with the plain `ln -s` or `cp -l` the list
 * names. Every one is a test row that was red under that paragraph alone:
 *
 *   1. `ln -s V d && mkdir -p d && echo > d/…` — `mkdir -p` succeeds silently
 *      on a link to a directory, so the forgiveness clause forgave the link.
 *   2. `rmdir d && ln -s V d && echo > d/…` with `d` real — the chain is real
 *      when the decision is taken and is not when the write runs.
 *   3. `cp -l V/f d/f && echo > d/f` — a link at the destination FILE, which
 *      a property about directories says nothing about.
 *
 * So the property has three parts, and none of them reads a verb:
 *
 *   PART 1  every directory of the chain is real now, or `mkdir` makes it;
 *   PART 2  nothing that runs before the write, or alongside it, NAMES a
 *           directory of the chain or the destination itself — a `mkdir`'s
 *           own arguments excepted. Removing a directory, re-linking it, or
 *           planting a link where `mkdir -p` will accept it all need the
 *           path spelled, and this asks whether it was — not by what;
 *   PART 3  an existing destination has one name and is not a link, and no
 *           existing directory of the chain is a symbolic link, so a link
 *           planted by an EARLIER command cannot be re-aimed unseen.
 *
 * ## What "names" means, and the direction it errs in
 *
 * A word names a path when, after quotes, ANSI-C, `~`, `$HOME` and the
 * command's own earlier assignments are applied, it resolves to that path
 * under either spelling and either case; when it is relative and its last
 * component is the path's basename (`cd /tmp && ln -s V esc` spells only
 * `esc`); or when an expansion or glob it still carries could produce that
 * basename under that prefix. Interpreter bodies contribute their string
 * literals; text handed to another shell — quoted words, `$( )`, backticks,
 * `bash -c` bodies, heredoc programs — contributes its words. A body this
 * module cannot read names everything. Each approximation errs toward
 * NAMING, which costs an exemption and never opens one.
 *
 * "Before" is by position when the steps are sequential. A background `&`,
 * a `coproc`, a subshell, a brace group or a substitution hides the order,
 * and then every other step counts. A word naming the scratch ROOT counts as
 * naming the chain, because a link put INTO the root takes its source's
 * basename. `~` and `$HOME` read the command's own `HOME` first; any other
 * tilde form could be anything.
 *
 * A plain `D=/tmp/x` sets a shell variable and touches nothing: its uses are
 * substituted and read where they occur, which is what lets `mkdir -p $D`
 * forgive. An EXPORTED value — `export D=…`, a `D=… cmd` prefix, `set -a`,
 * or a name the environment already exports — reaches a process's
 * environment, where a link can be made from it with the path never spelled
 * again, so it names the path where it is set.
 *
 * ## A program that computes the path: `BODY_LINK_CALL`
 *
 * A program that computes a directory's name at run time — decoded,
 * assembled, read from a file — and re-links a directory that ALREADY
 * exists names nothing a reader of the command can see. With the list gone
 * that was a regression for the list's own spellings, so an interpreter body
 * that calls a link function names everything (Jason's option (b), PR #2282).
 * A body that only makes directories — the `mkdirSync` fixtures #1175 exists
 * to allow — calls none and is unaffected. Outside interpreter bodies the
 * shell's own words are read, and an expansion already names what it could
 * produce.
 */

/** Decides, for one destination path, whether the scratch exemption holds. */
type Exemption = (path: string) => boolean;
const NO_EXEMPTION: Exemption = () => false;

/** A word that may name a path, and where in the command it sits. */
interface Mention {
  /** The word, with the command's earlier assignments substituted. */
  text: string;
  /** Its top-level step; -1 when its position is unknown. */
  at: number;
  /** `seg:i`, `sub:i` (handed to another shell), `body:i`, `prog:k`, `outer`. */
  src: string;
}

/** Which top-level steps run before, or alongside, which. */
interface StepOrder {
  /** False when a background `&`, a `coproc`, or a bracket hides the order. */
  ordered: boolean;
  /** Pipeline membership per step: equal numbers run concurrently. */
  group: number[];
}

/** What the whole command does that the chain question depends on. */
interface ChainContext {
  /** Directories some `mkdir` in the command makes, by `chainKey`. */
  made: Set<string>;
  mentions: Mention[];
  order: StepOrder;
}

/** What an enclosing command hands down to a body it runs. */
interface Outer {
  made: Set<string>;
  mentions: Mention[];
}

/**
 * One spelling per directory, so `/tmp/x`, `/private/tmp/x` and `/TMP/X`
 * compare equal: resolved through the links that exist, then folded the way
 * `names()` folds, because the default macOS volume makes them one inode.
 * On a case-sensitive volume the fold over-matches, which only ever refuses.
 */
function chainKey(p: string): string {
  const normalised = resolve(p);
  return (resolveThroughLinks(normalised) ?? normalised).normalize('NFC').toLowerCase();
}

/** A token's bare name: `/bin/mkdir` and `\mkdir` are both `mkdir`. */
function verbName(token: string): string {
  const bare = token.replace(/^[\\(]+/, '');
  return bare.slice(bare.lastIndexOf('/') + 1);
}

/**
 * `$NAME`, `${NAME}` and a leading `~`, from what the command assigned
 * EARLIER — its own `HOME` before the environment's, for `~` as well as
 * `$HOME` (#1367 review). Anything else is left as written, so it stays
 * unresolved and forgives nothing.
 *
 * A tilde other than `~` or `~/…` — `~+`, `~-`, `~user` — expands to a
 * directory this module cannot see, so it becomes `$?`, which reads as
 * "could be anything" everywhere downstream and cannot be assigned to.
 */
const ANYTHING = '$?';

function substitute(word: string, vars: Map<string, string | null>): string {
  const home = vars.has('HOME') ? vars.get('HOME') : process.env.HOME || null;
  let w = word;
  const tilde = /^~([^/]*)/.exec(w);
  if (tilde) w = (tilde[1] === '' && typeof home === 'string' && home ? home : ANYTHING) + w.slice(tilde[0].length);
  return w.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => {
    const name = a ?? b;
    const v = vars.has(name) ? vars.get(name) : name === 'HOME' ? home : undefined;
    return typeof v === 'string' && v ? v : m;
  });
}

/** Record `NAME=value`; an unresolvable value is recorded as unresolvable. */
function assign(word: string, vars: Map<string, string | null>): void {
  const eq = word.indexOf('=');
  const value = substitute(word.slice(eq + 1), vars);
  vars.set(word.slice(0, eq), /[$`]/.test(value) ? null : value);
}

/** Text a resolved path cannot contain: an expansion, a glob, a brace. */
const UNRESOLVED = /[$`*?[\]{}]/;

/** Add `path`, and with `parents` every ancestor of it, to `made`. */
function addMade(path: string, parents: boolean, made: Set<string>): void {
  if (!path.startsWith('/') || UNRESOLVED.test(path)) return; // unplaceable: forgives nothing
  let d = resolve(path);
  made.add(chainKey(d));
  if (!parents) return;
  for (let up = dirname(d); up !== d; d = up, up = dirname(up)) made.add(chainKey(up));
}

/**
 * The directories a shell `mkdir` segment makes. `-p` makes the ancestors
 * too; without it a missing parent fails the `mkdir`, so only the argument
 * itself is made. `-m` takes a value, which is not a directory.
 */
function mkdirMakes(words: string[], vars: Map<string, string | null>, made: Set<string>): void {
  const at = words.findIndex(w => verbName(w) === 'mkdir');
  if (at === -1) return;
  let parents = false;
  let value = false;
  let options = true;
  const paths: string[] = [];
  for (const w of words.slice(at + 1)) {
    if (value) {
      value = false;
      continue;
    }
    if (options && w === '--') {
      options = false;
      continue;
    }
    if (options && w.startsWith('--')) {
      if (w === '--parents') parents = true;
      if (w === '--mode') value = true;
      continue;
    }
    if (options && /^-[A-Za-z]/.test(w)) {
      const letters = /^-([A-Za-z]*)/.exec(w)?.[1] ?? '';
      if (letters.includes('p')) parents = true;
      // `-m 755` and `-pm 755` take the NEXT word; `-m755` carries it.
      if (letters.endsWith('m') && letters.length === w.length - 1) value = true;
      continue;
    }
    paths.push(w);
  }
  for (const p of paths) addMade(substitute(p, vars), parents, made);
}

/**
 * The directories an interpreter body makes with a `mkdir` call whose first
 * argument is a literal: `mkdirSync`, `fs.promises.mkdir`, `os.mkdir`,
 * `os.makedirs`, and `Path("…").mkdir(…)`. `recursive` / `parents=True` /
 * `makedirs` make the ancestors too. A call whose path is computed forgives
 * nothing — the fail-closed direction.
 */
const BODY_MKDIR = new Set(['mkdirSync', 'mkdir', 'makedirs']);
const PATH_CTORS = new Set(['Path', 'PurePath', 'PosixPath']);

function bodyMakes(body: string, lits: Array<{ value: string; start: number; end: number }>, made: Set<string>): Set<number> {
  const consumed = new Set<number>();
  for (const { value, start, end } of lits) {
    const open = previousNonSpace(body, start - 1);
    if (body[open] !== '(') continue;
    const callee = calleeBefore(body, open);
    const last = callee.slice(callee.lastIndexOf('.') + 1);
    const rest = body.slice(end + 1);
    if (BODY_MKDIR.has(last)) {
      const args = rest.split(')')[0];
      addMade(value, last === 'makedirs' || /\brecursive\s*:\s*true\b|\bparents\s*=\s*True\b/.test(args), made);
      consumed.add(start);
      continue;
    }
    const chained = /^\s*\)\s*\.mkdir\s*\(([^)]*)\)/.exec(rest);
    if (PATH_CTORS.has(last) && chained) {
      addMade(value, /\bparents\s*=\s*True\b/.test(chained[1]), made);
      consumed.add(start);
    }
  }
  return consumed;
}

/** The index of the last non-whitespace character at or before `i`. */
function previousNonSpace(text: string, i: number): number {
  while (i >= 0 && WHITESPACE.has(text[i])) i--;
  return i;
}

/** A body this module cannot read names every path (see `mentionNames`). */
const NAMES_EVERYTHING = '$UNREADABLE';

interface Sink {
  made: Set<string>;
  mentions: Mention[];
  /** Plain assignments, whose values count only if the name is exported. */
  plain: Array<{ name: string; mention: Mention }>;
  allexport: boolean;
}

const subSrc = (src: string): string => (src.startsWith('seg:') ? `sub:${src.slice(4)}` : src);
const bodySrc = (src: string): string => (src.startsWith('seg:') ? `body:${src.slice(4)}` : src);

/**
 * Read `text` as shell: what its `mkdir`s make (when `makes`), and every
 * word that may name a path. `tag` places each of its segments in the
 * top-level command. Text handed to another shell is read with `makes`
 * off — a quoted string that LOOKS like a `mkdir` makes nothing.
 */
function collectShell(text: string, depth: number, tag: (i: number) => { at: number; src: string }, sink: Sink, makes: boolean): void {
  if (depth > 3) {
    sink.mentions.push({ text: NAMES_EVERYTHING, at: -1, src: 'deep' });
    return;
  }
  const vars = new Map<string, string | null>();
  segments(text).forEach((seg, i) => {
    const { at, src } = tag(i);
    const { words, targets } = scanSegment(seg);
    const word = commandWord(seg);
    const add = (w: string) => sink.mentions.push({ text: substitute(w, vars), at, src });
    const nested = () => {
      for (const n of nestedCommands(seg)) collectShell(n, depth + 1, () => ({ at, src: subSrc(src) }), sink, false);
    };
    if (!word && words.length > 0 && words.every(w => ASSIGNMENT.test(w))) {
      for (const w of words) {
        const value = substitute(w.slice(w.indexOf('=') + 1), vars);
        sink.plain.push({ name: w.slice(0, w.indexOf('=')), mention: { text: value, at, src } });
        assign(w, vars);
      }
      nested(); // `x="$(…)"` runs the substitution, whatever it assigns
      return;
    }
    if (word === 'set' && words.some(w => /^-[A-Za-z]*a/.test(w) || w === 'allexport')) sink.allexport = true;
    if (word === 'mkdir') {
      if (makes) mkdirMakes(words, vars, sink.made);
      nested(); // a `mkdir`'s own arguments are not mentions; a substitution in one is
      return;
    }
    if (isInterpreterWord(word) && /\s-[a-z]*[ce]\b/.test(stripQuoted(seg))) {
      const shell = isShellWord(word);
      const body = shell ? shellBody(seg) : programBody(seg);
      for (const w of words) if (w !== body && dequote(w) !== body) add(w);
      if (shell) collectShell(body, depth + 1, () => ({ at, src }), sink, makes);
      else collectBody(body, at, bodySrc(src), sink, makes);
      return;
    }
    for (const w of [...words, ...targets]) add(w);
    nested();
  });
}

/**
 * A call that makes a link, in any interpreter body: `symlink` in every
 * spelling (`os.symlink`, `fs.symlinkSync`, `fs.promises.symlink(`,
 * `symlink_to`, ruby's `File.symlink a, b`, perl's `symlink $a, $b`), the
 * hard-link calls (`os.link`, `linkSync`, `hardlink_to`, `link(`), and `ln`
 * handed to a subprocess.
 *
 * Jason's option (b) on PR #2282, 2026-11-16. A program can compute a path at
 * run time — decoded, assembled, read from a file — and link it, and then no
 * word in the command spells the path. A body that calls one of these
 * therefore NAMES EVERYTHING, like a body this module cannot read. That is
 * the one place a verb list survives #1367: it closes the regression the
 * deleted list's own spellings would otherwise have, and only ever refuses.
 * A body that only makes directories calls none of these.
 */
export const BODY_LINK_CALL = /\bsymlink(?:Sync|_to|at)?\b|\bhardlink_to\b|\blink(?:Sync|at)?\s*\(|\bos\.link\b|\bFile\.link\b|\bln\b/;

/** An interpreter body: its `mkdir` calls make, its other literals are mentions. */
function collectBody(body: string, at: number, src: string, sink: Sink, makes: boolean): void {
  const lits = readLiterals(body);
  if (!lits || BODY_LINK_CALL.test(body)) sink.mentions.push({ text: NAMES_EVERYTHING, at, src });
  if (!lits) return;
  const consumed = bodyMakes(body, lits, makes ? sink.made : new Set());
  for (const l of lits) if (!consumed.has(l.start)) sink.mentions.push({ text: l.value, at, src });
}

/** Read everything in `cmd` the chain question depends on, once. */
function chainContext(cmd: string, outer?: Outer): ChainContext {
  const sink: Sink = { made: new Set(outer?.made ?? []), mentions: [...(outer?.mentions ?? [])], plain: [], allexport: false };
  collectShell(cmd, 0, i => ({ at: i, src: `seg:${i}` }), sink, true);
  interpreterPrograms(cmd).forEach(({ shell, program }, k) => {
    if (shell) collectShell(program, 1, () => ({ at: -1, src: `prog:${k}` }), sink, true);
    else collectBody(program, -1, `prog:${k}`, sink, true);
  });
  // An exported value reaches a process's environment, so it names the path
  // where it is set. `export D` and `D=… cmd` both spell the name as a word.
  // A name the environment ALREADY exports stays exported when the command
  // reassigns it (#1367 review): `HOME=…` reaches every child process.
  const exported = (name: string): boolean =>
    sink.allexport ||
    process.env[name] !== undefined ||
    sink.mentions.some(m => m.text === name || m.text.startsWith(`${name}=`));
  for (const { name, mention } of sink.plain) if (exported(name)) sink.mentions.push(mention);
  return { made: sink.made, mentions: sink.mentions, order: stepOrder(cmd) };
}

/**
 * Which steps of `cmd` run before, or alongside, which — read off its
 * separators. Position is order only for plain sequential steps: a
 * background `&`, a `coproc`, a subshell, a brace group, a command or
 * process substitution can each run a step out of its written place, so any
 * of them makes every other step count (#1367 review).
 */
function stepOrder(cmd: string): StepOrder {
  const parts = splitSegments(cmd);
  const background = parts.some(p => p.sep === '&' || commandWord(p.text) === 'coproc');
  const bracketed = /[()]|(?:^|[\s;&|])\{(?=\s|$)/m.test(stripQuoted(cmd));
  const group: number[] = [];
  let g = 0;
  parts.forEach((p, i) => {
    group[i] = g;
    if (p.sep !== '|' && p.sep !== 'redir') g++;
  });
  return { ordered: !background && !bracketed, group };
}

/** Can the step at `from` run before, or alongside, the write at `at`? */
function runsBefore(from: number, at: number, order: StepOrder): boolean {
  if (from < 0 || at < 0 || !order.ordered) return true;
  return from < at || order.group[from] === order.group[at];
}

/** The directories strictly between `root` and the destination. */
function chainBelow(root: string, normalised: string): string[] {
  const out: string[] = [];
  for (let d = dirname(normalised); d.startsWith(root + '/'); d = dirname(d)) out.push(d);
  return out;
}

/** The deepest scratch root this (normalised) path is inside. */
function scratchRootOf(normalised: string): string | null {
  const roots = scratchRoots().filter(r => inAnyTree(normalised, [r]));
  return roots.sort((a, b) => b.length - a.length)[0] ?? null;
}

const fold = (s: string): string => s.normalize('NFC').toLowerCase();

/** `lstat`, or `null` when nothing is there. */
function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch {
    return null; // not there now — part 1 decides whether that is allowed
  }
}

/** Mentions that come from the write's OWN step and do not count against it. */
interface Own {
  src: string;
  /** When set, only these texts from `src` are the write's own; the rest count. */
  only?: Set<string>;
}

/**
 * The three parts, for one destination. See the docblock above `Exemption`.
 */
function chainHolds(path: string, ctx: ChainContext, own: Own, at: number): boolean {
  const normalised = resolve(path);
  const root = scratchRootOf(normalised);
  if (!root) return false;
  const dirs = chainBelow(root, normalised);
  // PART 1, with part 3's directory half: real now and not a link, or made.
  for (const dir of dirs) {
    const st = lstatOrNull(dir);
    if (st === null) {
      if (!ctx.made.has(chainKey(dir))) return false;
      continue;
    }
    if (!st.isDirectory()) return false; // a symbolic link, or a file
  }
  // PART 3: an existing destination has one name and is not a link.
  const dest = lstatOrNull(normalised);
  if (dest && (dest.isSymbolicLink() || (!dest.isDirectory() && dest.nlink > 1))) return false;
  // PART 2: nothing before the write names the chain or the destination.
  // The ROOT is named too (#1367 review): `ln -s V /tmp/` and `ln -s V -t
  // /tmp` call the link after V's basename, so a step that puts anything
  // INTO the root plants a name only its source spells. A chain directory's
  // other parents are chain directories, and are already named.
  const named = [root, ...dirs, normalised].map(p => ({ key: chainKey(p), base: fold(basename(p)) }));
  for (const m of ctx.mentions) {
    // The word being judged is never a mention of itself — a copy's SOURCE
    // literal is judged too, by every path word that carries the name.
    if (m.src === own.src && (!own.only || own.only.has(m.text) || m.text === path)) continue;
    if (!runsBefore(m.at, at, ctx.order)) continue;
    if (mentionNames(m.text, named)) return false;
  }
  return true;
}

/** A word as a path, and — for `--opt=value` or `NAME=value` — its value. */
function mentionCandidates(text: string): string[] {
  const w = text.replace(/^[(!{]+/, '').replace(/[);,]+$/, '');
  if (!w) return [];
  const eq = w.indexOf('=');
  return eq > 0 && eq < w.length - 1 ? [w, w.slice(eq + 1)] : [w];
}

/** Text not settled until the command runs: an expansion, a substitution, a glob, a brace. */
const OPEN_TEXT = /[$`*?[{]/;
const OPEN_PIECE = /(\$\{[^}]*\}?|\$[A-Za-z_0-9?#@*!$-]*|\*|\?|\[[^\]]*\]|\{[^}]*\})/;

/** A component carrying open text, as the set of names it could produce. */
function openPattern(component: string): RegExp {
  const src = component
    .split(OPEN_PIECE)
    .map((p, i) => (i % 2 === 1 ? (p === '?' ? '.' : '.*') : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${src}$`, 'i');
}

/** Does this word name any of these paths? See "What names means" above. */
function mentionNames(text: string, named: Array<{ key: string; base: string }>): boolean {
  for (const w of mentionCandidates(text)) {
    const trimmed = w.replace(/\/+$/, '') || w;
    const last = trimmed.slice(trimmed.lastIndexOf('/') + 1);
    const open = w.search(OPEN_TEXT);
    if (open === -1) {
      if (w.startsWith('/')) {
        const key = chainKey(w);
        if (named.some(n => n.key === key)) return true;
        continue;
      }
      if (last === '.' || last === '..') return true; // relative to a directory nobody can see
      if (named.some(n => n.base === fold(last))) return true;
      continue;
    }
    // A substitution can produce anything, slashes included; a variable or
    // glob produces one component's worth, so the last one is matched.
    const prefix = w.slice(0, open);
    const prefixKey = prefix.startsWith('/') ? chainKey(prefix) : null;
    const pattern = /\$\(|`/.test(w) ? null : openPattern(last);
    for (const n of named) {
      if (prefixKey !== null && n.key !== prefixKey && !n.key.startsWith(prefixKey)) continue;
      if (pattern && !pattern.test(n.base)) continue;
      return true;
    }
  }
  return false;
}

/** The exemption for writes judged at step `at`, excluding the write's own words. */
function judgeFor(getCtx: () => ChainContext, own: Own, at: number): Exemption {
  return path => isScratchPath(path) && chainHolds(path, getCtx(), own, at);
}

/**
 * What a body run by step `at` inherits: every `mkdir`, and every mention
 * from a step that runs before or alongside it, placed BEFORE everything
 * inside — except the body's own words, which it reads with positions.
 */
function outerFor(ctx: ChainContext, src: string, at: number): Outer {
  return {
    made: ctx.made,
    mentions: ctx.mentions
      .filter(m => m.src !== src && runsBefore(m.at, at, ctx.order))
      .map(m => ({ ...m, at: -1, src: 'outer' })),
  };
}

/**
 * Text a segment will hand to ANOTHER shell: the contents of its quoted
 * words and of its command substitutions (#1429).
 *
 * #1429 built this for the verb list #1367 deleted; it now feeds part 2 of
 * the chain property, which needs the words of `eval '…'`, `$( … )` and
 * backticks for the same reason the list needed their verbs — a reading built
 * on segments does not see inside them. Every quoted span is read, data or
 * not, which over-collects: that is the direction part 2 is allowed to err.
 *
 * `interpreterPrograms` was the obvious place and is the wrong one: it
 * reaches a heredoc body and returns NOTHING for `sh -c "…"`, `$( … )` or
 * `eval '…'` — measured, all four empty, against a heredoc control that
 * returns the body. Widening it would change what every other arm reads.
 */
function nestedCommands(view: string): string[] {
  const out: string[] = [];
  // A substitution inside a quoted span is read by the walk below. Left in
  // the span, `segments` cuts it at its own `;` and the fragment `$(date`
  // reads as a word that could be anything (#1367), so it is blanked here.
  for (const m of view.matchAll(/'([^']*)'|"([^"]*)"/g)) out.push(blankSubstitutions(m[1] ?? m[2] ?? ''));
  // Backticks are the OTHER substitution syntax and were missing entirely
  // from #1429's first reading. They do not nest in bash, so a flat match is
  // the whole grammar here.
  for (const m of view.matchAll(/`([^`]*)`/g)) out.push(m[1]);
  // `$(…)` DOES nest, so it gets the module's one substitution walk rather
  // than a second spelling of it. Every `$(` position is examined — the
  // index is not advanced past a substitution that was just read — so an
  // inner body is collected as well as the outer one it sits in.
  for (let i = 0; i < view.length; i++) {
    if (view[i] !== '$' || view[i + 1] !== '(') continue;
    const end = endOfSubstitution(view, i);
    const body = view.slice(i + 2, end);
    out.push(body.endsWith(')') ? body.slice(0, -1) : body); // unterminated keeps all of it
  }
  return out.filter(s => /\s/.test(s));
}

/** `text` with every `$( … )` and backtick span replaced by `$?` (#1367). */
function blankSubstitutions(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '$' && text[i + 1] === '(') {
      out += ANYTHING;
      i = endOfSubstitution(text, i) - 1;
    } else if (text[i] === '`') {
      out += ANYTHING;
      const close = text.indexOf('`', i + 1);
      i = close === -1 ? text.length : close;
    } else out += text[i];
  }
  return out;
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
  const hay = text.toLowerCase();
  const pin = needle.toLowerCase();
  let i = 0;
  while ((i = hay.indexOf(pin, i)) !== -1) {
    let s = i;
    while (s > 0 && !/[\s'"`,;(){}[\]]/.test(hay[s - 1])) s--;
    let e = i + pin.length;
    while (e < hay.length && !/[\s'"`,;(){}[\]]/.test(hay[e])) e++;
    out.push(text.slice(s, e)); // the ORIGINAL case: this is a path to resolve
    i = e;
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
 * Delete heredoc bodies only, keeping ordinary quoting intact. Separate from
 * `stripQuoted` because a quoted PATH is a real argument while a heredoc
 * body never is — it is the document being written, not a word of the
 * command writing it.
 *
 * ## `blankComments`, and the three review rounds behind it (#1741)
 *
 * This function has two readers with OPPOSITE needs, and for a while it
 * tried to serve both with one output.
 *
 * The write guard needs `#`-leading lines blanked. #1176: `# First, check if
 * there's a test workflow-state.json` opened a quote that stayed open across
 * the newline and swallowed the redirect on a later line, so a real write to
 * a protected file read as quoted text. Two commands in a 5,513-command
 * corpus did exactly that, both genuine writes.
 *
 * The filing parser needs them KEPT. `lib/issue-create-override.ts` builds
 * its view from here, so a multi-line `gh issue create --body "…"` arrived
 * with every `##` markdown heading deleted — the dedupe and the symptom scan
 * were reading bodies with holes and nothing reported the loss.
 *
 * **The first three attempts all tried to make ONE output correct for both,
 * by deciding per line whether the `#` was inside a quote. Each was a
 * hand-rolled shell-comment predicate and each had a narrower view than the
 * shell:** a `#` line inside a quote could open a heredoc and delete the
 * lines after it; an inline comment's apostrophe set a carried state that
 * suppressed the next line's blanking; and `echo hi;#…` was a comment the
 * predicate did not recognise. Three rounds, three edges, same shape — so
 * the fourth change is not a fourth predicate. `AGENTS.md` rule 5.
 *
 * **The parameter is the method change.** Blanking is a WRITE-GUARD safety
 * measure; it was never something the filing parser wanted, and no quote
 * tracking is needed to tell the two apart because the CALLER already knows
 * which one it is. #1176 is untouched — the default is the old behaviour and
 * every write-guard path takes it. `heredocView` passes `false` and lets
 * `tokenize`, which implements the shell's comment rule for its own
 * purposes, decide what a comment is on the side of the fence that cares.
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
export function interpreterPrograms(cmd: string): Array<{ shell: boolean; program: string }> {
  type Pending = { opener: string; at: number; body: string };
  const found: Array<{ shell: boolean; program: string } | Pending> = [];
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
        found.push({ shell: isShellWord(word), program: dequote(hs[1]).trim() });
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

/** Wrappers that delegate to the real command word rather than being one. */
const WRAPPERS = /^(?:sudo|env|nohup|time|command|xargs)$/;

/**
 * A variable assignment prefix, by the POSIX shape: an identifier, an
 * optional array subscript, then `=`. Read on the raw token — see
 * `commandWord`, where recognising it only after the path strip was a bypass.
 */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?=/;

/**
 * The command word of a segment — the first token that is not a wrapper, an
 * assignment or an option. Read off `stripQuoted`, because a quoted token is
 * an argument.
 */
export function commandWord(segment: string): string {
  // #1184: read the DEQUOTED token stream, not the quote-stripped one. This
  // is the mirror of #1176's F2 — there the TARGET was read off a view the
  // writer controls, here the VERB was: `stripQuoted` deleted `"chmod"`
  // outright, so `"chmod" 777 x.hook.ts` resolved its command word to `777`
  // and the shell ran chmod anyway. Quoting a verb changes nothing about
  // what executes, so it must change nothing about what the guard reads.
  //
  // The grep-PATTERN false positive this function was protecting against is
  // unaffected: `grep -nE "chmod" f` still resolves to `grep`, because the
  // real verb comes FIRST and a pattern is never in first position.
  //
  // #1196: the TOKENS come from `scanSegment`, the same quote-aware pass the
  // redirect scan uses. The #1184 spelling was `dequote(...).split(/\s+/)`,
  // which removes the quote characters and THEN splits on whitespace — so a
  // quoted value's internal spaces become token boundaries. `A="1 grep" cp
  // <protected> /tmp/x` split to `A=1`, `grep`, `cp`, …: the `=` skip
  // consumed only `A=1` and the verb resolved to `grep`, which is on the
  // read-only side, so the `cp` was allowed. A quoted span must stay inside
  // its word; `readWord` already does that, and now there is one tokeniser
  // rather than two spellings of the idea.
  for (const raw of scanSegment(segment).words) {
    // A token carrying WHITESPACE is not a verb. It is what the quote-aware
    // tokeniser above is for — `A="1 grep"` is one word — and the same
    // property makes `--body "## Goal … chflags uchg …"` one word too. The
    // first spelling of this fix returned that whole document as the command
    // word, and `decideBashWrite` tests `IN_PLACE` against `${word} ${code}`:
    // a `gh issue create` whose body described chflags on a hook was refused,
    // which is the recorded `pai-config#474` family. The shell cannot run a
    // verb named `chmod 777` either, so nothing executable is lost.
    if (/\s/.test(raw)) continue;
    // An assignment prefix is recognised on the RAW token, before the path
    // strip. #1196: the strip runs `^.*\/` and takes the `=` away with the
    // directory part, so `FOO=/x/grep` arrived at the `includes('=')` test
    // spelled `grep` and was returned as the command word — a fake verb in
    // front of the real one. `FOO=/x/grep chmod 777 <hook>` was ALLOW on
    // main and ALLOW behind the first #1196 fix; `chmod 777 <hook>` BLOCKs.
    // Four arms were reachable this way. Same defect this issue names, a
    // different assignment shape: the prefix hides the verb either way.
    //
    // Matched by the POSIX shape rather than by `includes('=')` so a real
    // path is not mistaken for one — `/opt/a=b/bin/tool` does not start
    // with an identifier, and the test below still catches the rest.
    if (ASSIGNMENT.test(raw)) continue;
    const tok = raw
      .replace(/^[({\\]+/, '') // `(cmd …`, `{ cmd …`, `\cmd` — alias bypass
      .replace(/^.*\//, ''); // `/usr/bin/python3` -> `python3`
    if (!tok || tok.includes('=') || tok.startsWith('-')) continue;
    if (WRAPPERS.test(tok)) continue;
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
 * The index just past a quoted span whose OPENING quote is at `i`.
 *
 * #1239: both scanners below used to find the partner with `indexOf`, and
 * `indexOf` cannot tell `"` from `\"`. Inside a double-quoted span the
 * escaped quote was read as the closing one, every subsequent quote was
 * paired off by one, and the scanner ran off the end of the line — taking
 * the `>` operator with it. No operator, no target, ALLOW. Seven spellings
 * that bash runs and that overwrite the file reached a real write that way,
 * across both call sites; `test/bash-write-guard.test.ts` holds the table.
 *
 * The asymmetry is bash's and is the whole of the fix: a single-quoted span
 * takes NO escapes, so `'a\'` is a complete span whose contents are `a\`,
 * while in a double-quoted span `\` escapes whatever follows it.
 *
 * Unterminated spans run to `s.length` — the pre-existing, fail-closed
 * direction. Those spellings are syntax errors that bash refuses to run, so
 * nothing executable depends on the choice.
 *
 * ## #1471: `end` alone could not say which of those two happened
 *
 * This used to return a bare number, and for a span that closes at the very
 * LAST character of the string that number is `s.length` — the same value
 * an unterminated span returns. The one caller that strips the quotes
 * resolved the ambiguity with `end === s.length ? s.length : end - 1`, which
 * cannot be right: it takes the unterminated branch for a correctly closed
 * final word and keeps the closing quote inside the word.
 *
 * Measured on `5d0bf00e` before this fix, and **one trailing space is the
 * entire difference** — `segments()` trims it, so the spaced form is simply
 * the same command without a final-word quote:
 *
 *     cp /tmp/evil.hook.ts /repo/hooks/     → targets 2, BLOCKED
 *     cp /tmp/evil.hook.ts "/repo/hooks/"   → targets 1, ALLOWED
 *
 * The consequence is sharper than a cosmetic trailing quote. `/repo/hooks/"`
 * does not end with `/`, so `isDirDestination` reads a DIRECTORY as a plain
 * file, the `dest/basename(src)` expansion never happens, and the target
 * that would have named `.hook.ts` is never produced. That is #1184's H4
 * arriving through a new door.
 *
 * It is #1239's defect one level down: there, `indexOf` could not tell `"`
 * from `\"`; here, `s.length` could not tell *closed at the end* from
 * *never closed*. One value carrying two meanings — and
 * `.claude/rules/checks-must-be-able-to-fail.md` names the shape: *a status
 * code is almost never specific to one mechanism*.
 *
 * So the span reports BOTH boundaries and no caller recomputes either.
 * `contentEnd` is where the span's contents stop; `end` is where the next
 * word starts. For a terminated span they differ by the closing quote, and
 * for an unterminated one they are equal. The three callers read the field
 * they need and none of them owns a ternary — which is the point, because
 * a `terminated` flag computed at each call site would be three deciders
 * over one question, and that is how this family keeps coming back.
 *
 * One function, three callers, so a mutation of it moves all of them.
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
 * The index just past the `)` that closes the `$(` at `i`, or the end of
 * the string if it never closes.
 *
 * A parenthesis inside a STRING LITERAL is data, not grammar. Counting it
 * dropped the depth to zero early, ended the word in the middle of the
 * substitution, and left a `"` whose partner had already been consumed — so
 * `readWord`'s quote branch then took `close === -1` and swallowed the rest
 * of the line INCLUDING the `>` operator. No operator, no target, allow:
 *
 *     echo $(echo "x)") > <protected>     ran, and wrote
 *
 * That is #1205's own sentence a second time — the bug is what the scanner
 * cannot see, not the substitution — so it was fixed the same way rather
 * than by special-casing the literal that exposed it.
 *
 * Extracted from `readWord` so `nestedCommands` can reuse the walk. The
 * alternative was a second flat `/\$\(([^()]*)\)/`, which is two deciders
 * answering one question about substitution structure — the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md` — and the flat one is the
 * weaker: it cannot match a substitution containing parentheses at all, so
 * `$(cp -s $(echo V) /tmp/esc)` matched only the INNER one and the outer
 * body was never read. One reader.
 *
 * ## The escape handling is #1239's and it is load-bearing here (#1361)
 *
 * This function was extracted on `main` from a copy of the walk that
 * predated #1239, so it opened spans on `\"` and found their ends with
 * `indexOf`. Merging the two branches by taking the extraction unchanged
 * would have reinstated the bypass it had already fixed on the other side:
 * `echo \" > <protected>` opens a span that never closes, the scanner
 * swallows the `>`, no operator means no target, and the write is allowed.
 * One reader is still right — the reader just has to be the fixed one.
 *
 * So: a backslash OUTSIDE a span escapes the next character, and the end of
 * a span is `endOfQuoted`, which honours `\"` inside double quotes and
 * correctly does not inside single ones, because bash processes no escapes
 * there.
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
 * ANSI-C quoting: the value of a `$'…'` word.
 *
 * Unlike `$(…)` and `` `…` ``, this is settled at parse time — no command
 * runs and nothing is looked up — so decoding it makes a word MORE readable
 * rather than guessing at one. `$'-\163'` is the string `-s` on every run.
 *
 * An escape this does not recognise keeps its backslash, which is what bash
 * does with one.
 *
 * ## Octal and `\x` are BYTES, so the decode assembles bytes
 *
 * Measured: `printf '%s' $'\303\251' | od -An -tx1` gives `c3 a9`, and so
 * do `$'\xc3\xa9'` and a literal `é` — all three are the UTF-8 encoding of
 * one character. A per-escape `String.fromCharCode` gives U+00C3 followed
 * by U+00A9, a different string of four bytes, so above 0x7F that spelling
 * hands the module a token the shell never produced. Same defect as the
 * transforms this function exists to close, pointing the other way.
 *
 * It is a live one, not a cosmetic differential. With a symlink named
 * `café` under a scratch root pointing into the run store, the write
 * through it is REFUSED when spelled literally and when spelled
 * `$'café'`, and was ALLOWED when spelled `$'caf\303\251'` or
 * `$'caf\xc3\xa9'` — the module looked for a directory nobody had made,
 * found nothing to resolve, and exempted it as ordinary scratch. That is
 * #1175's escape with a name the decoder disagreed about.
 *
 * So escapes are decoded into BYTES and the byte string is decoded as
 * UTF-8 once, at the end. Refusing to decode above 0x80 was the first
 * repair and it does NOT close this: an undecoded `caf\303\251` is just
 * another directory that does not exist, which is exempt. The conservative
 * answer and the wrong answer are the same answer here.
 *
 * `\u` and `\U` stay code points, because that is what bash defines them
 * as — it emits their UTF-8 encoding, which is what they mean once the
 * command text has itself been decoded from UTF-8.
 *
 * What remains: a byte sequence that is not valid UTF-8, such as a lone
 * `$'\303'`, becomes U+FFFD here and names a file this module cannot
 * spell. Closing that needs byte-level paths throughout, which is a
 * different change; the residue is one unmatched character in a position
 * that is then unprovable rather than wrongly exempt.
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
  // destination as `src` and never examined the real one.
  const word = commandWord(segment);
  if (word === 'cp' || word === 'mv' || word === 'install' || word === 'rsync') {
    const args = words.slice(1).filter(a => !a.startsWith('-'));
    if (args.length >= 2) {
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
 * body? Proximity, not parsing — the arm needs to tell
 * `open('…/.gate-salt','w')` from a program that writes a `.md` and happens
 * to mention a hook in its data. Associating a call with its argument
 * properly means parsing the language, which this module will not do.
 */
function writesNear(body: string, protectedName: string): boolean {
  const WINDOW = 80;
  for (const m of body.matchAll(new RegExp(protectedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))) {
    const at = m.index ?? 0;
    const from = Math.max(0, at - WINDOW);
    const slice = body.slice(from, at + protectedName.length + WINDOW);
    if (WRITE_INTENT.test(slice)) return true;
  }
  return false;
}

/**
 * Whether any call holding `protectedName` as an argument, at any depth, is
 * a write (#1407). `writesNear`'s window misses a verb separated from the
 * name by a long argument: in `shutil.copy(SRC, DST)` the verb comes before
 * SRC, so a SRC longer than the window put DST's name out of its reach, and a
 * copy onto the artifact spelled in full was allowed; a realpath'd macOS
 * $TMPDIR is long enough. A name that is no call's argument (text in a string
 * assigned to a variable, a docblock being edited) is left to the window.
 *
 * `program` must be the program text with its quotes: the reading masks
 * strings and comments, and `dequote`'s view, which strips every quote,
 * would read a `#` inside a string as a comment.
 */
function callWrites(program: string, protectedName: string): boolean {
  for (const m of program.matchAll(new RegExp(protectedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))) {
    const at = m.index ?? 0;
    if (enclosingCalls(program, at).some(call => WRITE_INTENT.test(call))) return true;
    // #2699 review: `dst = '<…>/workflow-state.json'` and then
    // `shutil.copy(src, dst)` lines later. One level of binding is followed:
    // the identifier the name's literal is assigned to counts as the name
    // wherever a write call takes it. Deeper data flow is the evasion
    // `WRITE_INTENT`'s docblock concedes.
    const bound = boundIdentifier(program, at, at + protectedName.length);
    if (bound !== null) {
      for (const use of program.matchAll(new RegExp(`\\b${bound}\\b`, 'g'))) {
        const u = use.index ?? 0;
        if (u === at) continue;
        if (enclosingCalls(program, u).some(call => WRITE_INTENT.test(call))) return true;
      }
    }
  }
  return false;
}

/**
 * The identifier a literal holding offset `at` is assigned to (`x = '…'`),
 * or null. The literal is the code-level one holding `at`, found through
 * `codeMask`, and it must END at the name: the variable then holds the path,
 * not text that mentions it. An assignment spelled inside another string (a
 * docblock being edited) is therefore not read as a binding.
 */
function boundIdentifier(program: string, at: number, end: number): string | null {
  const { mask } = codeMask(program);
  if (mask[at] !== 1) return null;
  let quoteAt = at;
  while (quoteAt > 0 && mask[quoteAt - 1] === 1) quoteAt--;
  const q = program[quoteAt];
  if (program[end] !== q || mask[end + 1] === 1) return null;
  const m = /(?:^|[\s;(,])([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*[A-Za-z_][\w.]*\s*)?=\s*[rbfuRBFU]{0,2}$/.exec(program.slice(Math.max(0, quoteAt - 80), quoteAt));
  return m ? m[1] : null;
}

/** Whether the `#` at `i` begins a JavaScript private name rather than a comment. */
function opensPrivateName(body: string, i: number): boolean {
  if (!/[A-Za-z_$]/.test(body[i + 1] ?? '')) return false;
  const before = body.slice(Math.max(0, i - 40), i).replace(/\s+$/, '');
  return /[{;(,]$/.test(before) || /\b(?:static|get|set|async|in)$/.test(before);
}

/** Per offset: 0 code, 1 inside a quote, 2 inside a `#` comment; and whether every quote closed. */
function codeMask(body: string): { mask: Uint8Array; balanced: boolean } {
  const mask = new Uint8Array(body.length);
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote !== null) {
      mask[i] = 1;
      if (ch === '\\' && i + 1 < body.length) mask[++i] = 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      mask[i] = 1;
    } else if (ch === '#' && (i === 0 || /\s/.test(body[i - 1])) && !opensPrivateName(body, i)) {
      // A comment runs to the end of the line. An apostrophe in one ("don't")
      // would otherwise open a quote that swallows the brackets after it. Only
      // a `#` that starts a word, so `this.#x` and `$#` stay code, and not
      // one that opens a JavaScript private name after `{`, `;`, `(`, `,`
      // or a class keyword (`{ #x = 1 }`, `static #x`). Python's `#comment`
      // with no space is still a comment (#2699 review, security review).
      while (i < body.length && body[i] !== '\n') mask[i++] = 2;
    }
  }
  return { mask, balanced: quote === null };
}

/**
 * The text of every call whose argument list holds offset `at`, innermost
 * first: callee, argument list, and any method chain after it (`.f(…).g(…)`).
 * Read over code only, with quotes and `#` comments masked, so a call over
 * several lines, a `;` in a path string, or an apostrophe in a comment does
 * not split or hide it. A callee may be computed (`fs['copyFileSync'](…)`,
 * `(shutil.copy)(…)`). A body whose quotes never close cannot be read, so
 * none is returned and the window alone decides, as it did before #1407.
 * Reading such a body whole was tried and measured: it refused eight real
 * commands, all edits of docs and config, and none a write of an artifact.
 */
function enclosingCalls(body: string, at: number): string[] {
  const { mask, balanced } = codeMask(body);
  if (!balanced) return [];
  const open: { at: number; ch: string }[] = [];
  for (let i = 0; i < at; i++) {
    if (mask[i] !== 0) continue;
    const ch = body[i];
    if (ch === '(' || ch === '[' || ch === '{') open.push({ at: i, ch });
    else if ((ch === ')' || ch === ']' || ch === '}') && open.length > 0) open.pop();
  }
  const calls: string[] = [];
  for (let k = open.length - 1; k >= 0; k--) {
    if (open[k].ch !== '(') continue;
    const paren = open[k].at;
    const start = calleeStart(body, mask, paren);
    if (start === paren) continue;
    calls.push(body.slice(start, chainEnd(body, mask, closingParen(body, mask, paren))));
  }
  return calls;
}

/** Where the callee before the `(` at `paren` starts: identifiers, dots, and bracketed groups. */
function calleeStart(body: string, mask: Uint8Array, paren: number): number {
  let j = paren - 1;
  while (j >= 0 && /\s/.test(body[j])) j--;
  let start = j + 1;
  while (j >= 0) {
    const ch = body[j];
    if (mask[j] === 0 && (ch === ']' || ch === ')')) {
      const opener = ch === ']' ? '[' : '(';
      let depth = 0;
      while (j >= 0) {
        if (mask[j] === 0 && body[j] === ch) depth++;
        else if (mask[j] === 0 && body[j] === opener && --depth === 0) break;
        j--;
      }
      if (j < 0) return start;
      start = j;
      j--;
    } else if (/[\w.$]/.test(ch)) {
      start = j;
      j--;
    } else break;
  }
  return start;
}

/** The offset just past the `)` matching the `(` at `paren`, over code only, or the body's end. */
function closingParen(body: string, mask: Uint8Array, paren: number): number {
  let depth = 0;
  for (let i = paren; i < body.length; i++) {
    if (mask[i] !== 0) continue;
    const ch = body[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if ((ch === ')' || ch === ']' || ch === '}') && --depth === 0) return i + 1;
  }
  return body.length;
}

/** Past any method chain starting at `from`: `.name`, optionally called, repeated. */
function chainEnd(body: string, mask: Uint8Array, from: number): number {
  let i = from;
  for (;;) {
    let j = i;
    while (j < body.length && (/\s/.test(body[j]) || body[j] === '\\' || mask[j] === 2)) j++;
    if (body[j] !== '.') return i;
    j++;
    while (j < body.length && /[\w$]/.test(body[j])) j++;
    if (body[j] === '(') j = closingParen(body, mask, j);
    if (j === i) return i;
    i = j;
  }
}

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
  /\bln\b/,
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
function shellBody(segment: string): string {
  const m = /\s-[a-z]*c\s+([\s\S]+)$/.exec(segment);
  return m ? dequote(m[1]).trim() : '';
}

/**
 * Declared write intent inside an interpreter body.
 *
 * The honest version of this arm would refuse any interpreter naming a
 * protected artifact, since a program is opaque. That was implemented and
 * MEASURED: it newly refused 1,760 of 5,060 real commands — 35% — and
 * triage found them to be reads. `bun -e '…readFileSync(…workflow-state
 * .json…)…'` and `python3 -I -c 'json.load(open(…))'` are how every agent
 * on this machine inspects gate state, and a guard that refuses the normal
 * way of looking at a thing is a guard that gets switched off.
 *
 * So the arm fires on a declared write VERB instead. The limit that buys is
 * real and is stated rather than hidden: an interpreter can always evade
 * this — build the name from pieces, `eval` it, call through a variable, or
 * put the program in a file instead of `-c`. This arm raises the cost of an
 * accidental write and of the obvious deliberate one. It is not a boundary,
 * and `.claude/rules/checks-must-be-able-to-fail.md` would call it a
 * detector narrower than what it detects. It is the widest setting the
 * measured false-positive rate allows.
 *
 * ## #1214: an imported project function is outside what this arm can decide
 *
 * The concession above says an interpreter can evade this arm by calling
 * through a variable or putting the program in a file. #1214 filed a case
 * needing neither — a plain call to a project function the enumeration has
 * never heard of:
 *
 *     bun -e "
 *     import {initWorkflow, writeACs} from '<harness>/gates/orchestrator.ts';
 *     const sf = '<run store>/workflow-state.json';
 *     initWorkflow(sf, {…});
 *     writeACs(sf, JSON.parse(process.argv[1]));"
 *
 * `initWorkflow` and `writeACs` both write `sf`, `sf` is a live run-store
 * artifact, and nothing in the list above matches. ALLOW.
 *
 * The issue's framing 1 — derive the suspicious-call set from the body's OWN
 * `import` statement, so the module enumerates nothing and stays
 * project-agnostic — was implemented and swept over 130,247 real commands
 * from this machine's 31,793 transcripts:
 *
 *     newly BLOCKED  616          newly ALLOWED  0
 *       600  call a writing orchestrator symbol  (writeWorkflowState 301,
 *            initWorkflow+writeACs 285, the rest in ones and twos)
 *        10  call a reading one (readWorkflow, loadWorkflow, …)
 *         6  probe this module or take a hook census
 *     0 of the 616 are scratch fixtures; every one names the live run store.
 *
 * 97% precision by that reading, and it is still **not shippable** — for a
 * reason no count could show. The 600 are not evasions. They are this
 * harness's own prescribed mechanism:
 *
 *   - `workflows/ship.js` EMITS the filed command, at the GOAL phase, under
 *     an instruction reading "Run this EXACTLY as written". The payload
 *     spelling `JSON.parse(process.argv[1])` is generated by
 *     `acPayloadReadExpression()` in `lib/evidence-command-transport.ts`, so
 *     the fingerprint belongs to the harness and to nothing else.
 *   - `gates/SCHEMA-GUIDE.md` prescribes `writeWorkflowState` via `bun -e`
 *     in place of the Write tool or `cat >`.
 *   - `lib/gate-result-protection.ts` and `lib/gate-enforcement.ts` PRINT
 *     that command to the agent as the sanctioned repair.
 *
 * So the predicate would refuse the GOAL phase of every run, and the guard
 * would be refusing the exact command its sibling modules hand out as the
 * remedy. The filed case and the sanctioned repair are the same operation,
 * differing only in which orchestrator symbol is called — and separating
 * them means enumerating one consumer's API, which is what #1214 forbids and
 * is wrong in every other tree besides.
 *
 * **The result is therefore framing 2, and it belongs here rather than in an
 * open issue: a program that imports project code is outside what a
 * command-line guard can decide.** Nothing read off the command line
 * distinguishes a sanctioned write from an unsanctioned one when both are
 * the same call to the same function on the same path. That is a question
 * about the command's PROVENANCE, not its text, so closing it needs the
 * harness to mark the commands it issued — a different mechanism from
 * parsing, and not one this module can reach.
 *
 * `test/bash-write-guard.test.ts` pins the conclusion rather than leaving it
 * as prose: the sanctioned commands must stay ALLOWED, so the next person to
 * reach for the obvious fix gets a red suite naming what it costs.
 */
const WRITE_INTENT =
  /\b(?:writeFileSync|appendFileSync|createWriteStream|copyFileSync|renameSync|unlinkSync|rmSync|truncateSync|write_text|json\.dump|os\.remove|os\.rename|os\.replace|os\.unlink|shutil\.(?:copy|move|rmtree))\b|(?<!stdout)(?<!stderr)\.write\s*\(|\bopen\s*\([^)]*['"][wax]\+?['"]|\bopen\s*\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*['"][wax]\+?['"]/;

/**
 * #1176 measured the suggested widening of WRITE_INTENT to shell idioms —
 * `>`, `>>`, `tee`, `rm`, `mv`, `cp`, `dd of=`, `truncate` — so that a
 * NON-shell interpreter shelling out would also fire. It is not implemented.
 *
 * Measured: 100 newly blocked against 4 without it, on 5,513 real commands.
 * Sampling the extra 96 found them to be reads, and the mechanism is
 * specific: `>{1,2}\s*\S` matches `=>`, so every arrow function in a
 * `bun -e` body became a declared write. `x=>x.id==="AC-4"` is not a write.
 *
 * The same lesson as the interpreter widening this module already records:
 * matching SHELL idioms inside a body that is not shell matches the host
 * language instead. A shell body is handled properly by recursion (see
 * SHELLS); a Python or Node body that shells out would need its
 * `os.system`/`subprocess`/`execSync` argument extracted and recursed, which
 * is a real fix and a different issue from this one.
 */

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
 * Protected names in a program body, counting only ABSOLUTE spellings
 * outside a scratch tree (#1240).
 *
 * The stricter reading exists because of what it costs otherwise, measured
 * rather than reasoned: scanning an interpreter body for a protected NAME
 * newly refused **23** real commands, and every one of them was an agent
 * building hook FIXTURES in a `/tmp` tree with an assembled path —
 * `open(os.path.join(dst, n), "w")`, where the only word carrying
 * `.hook.ts` is the relative suffix itself. A relative fragment cannot be
 * shown to be scratch, so the fail-closed reading in `isScratchPath`
 * correctly refuses to exempt it, and the result is that the fixture work
 * #1175 exists to unblock gets refused by the arm added beside it.
 *
 * So this arm asks for an absolute path. The spelling it is there to catch
 * — `open("<run store>/workflow-state.json", "w")` inside a heredoc — is
 * absolute, and the 23 are not. The arm it mirrors (arm 3, the `-c` form)
 * keeps its looser reading: that behaviour is pre-existing and measured,
 * and tightening it is not this change's business.
 */
function absoluteNamesOutsideScratch(text: string, exempt: Exemption): string[] {
  const out: string[] = [];
  for (const p of ALL_PROTECTED) {
    const words = pathWordsContaining(text, p).filter(w => w.startsWith('/'));
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
 * expression begins. `bodyTargets` is the whole point of this function, and
 * it cannot answer its question on a view with no quotes in it.
 *
 * An unmatched outer quote leaves the text as it stands. `bodyTargets` then
 * reports the body `unreadable` rather than guessing, which is the
 * fail-closed direction.
 */
export function programBody(segment: string): string {
  const m = /\s-[a-z]*[ce]\s+([\s\S]+)$/.exec(segment);
  if (!m) return '';
  const raw = m[1].trim();
  const q = raw[0];
  if ((q === "'" || q === '"') && raw.length > 1 && raw[raw.length - 1] === q) {
    return raw.slice(1, -1);
  }
  return raw;
}

/**
 * A literal that STANDS ALONE as an argument is one nothing transforms, so
 * the path it spells is the path the program hands to the filesystem.
 *
 * Both sets are closed-world and that is the point. They enumerate what may
 * legally DELIMIT an argument, not what may operate on one — so a language
 * whose concatenation operator nobody here thought of reads as "not
 * delimited", which refuses. The other spelling, a denylist of operators
 * (`+`, `%`, `.replace`, an f-string, …), is a detector narrower than what
 * it detects — `.claude/rules/checks-must-be-able-to-fail.md` — and it is
 * what #1276's stopgap was a second attempt at.
 *
 * ## `=` and `:` ARE openers, and the rebinding question moved (#1371)

 * A round of #1371 dropped them, on the finding that `p = "/tmp/x"` records
 * a target nothing then follows through its reassignment:
 *
 *     p = '/tmp/fix/workflow-state.json'
 *     p = p.replace('/tmp/fix', os.environ['RUNGATE_WORK_DIR'])
 *     open(p, 'w').write('{}')
 *
 * Dropping them worked and was the wrong place to answer it. `inWritePosition`
 * answers the same question generally — a binding at statement level is an
 * argument of no call, so it is not a write position — and it also catches the
 * dict KEY, the ternary branch, and the inner call's default that the `:` drop
 * reached only by accident or not at all. Measured: with `inWritePosition` in
 * place, restoring `=` and `:` moves nothing — 0 newly blocked and 0 newly
 * allowed over 132,196 real commands, and the same exemption population.
 *
 * So they are restored, because two deciders answering one question are
 * behaviourally one, no behavioural test can tell them apart, and the next
 * reader deletes whichever looks redundant — the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`. The measurement above is
 * exactly the evidence that they WERE two deciders.
 *
 * What this set still answers alone is ADJACENCY: `x + "/tmp/…"` has an
 * operator against the literal, and no question about write position can see
 * that.
 *
 * A closing bracket is neither an opener nor a closer. It ENDS the group the
 * literal sits in and leaves the outer expression still running, so the walk
 * steps past it and keeps asking — which is how `Path("/tmp/x")
 * .relative_to(…)` is told from `shutil.copy(src, "/tmp/x")`. The first
 * version of this stopped at the `)` and reported the pathlib spelling as a
 * target; its own CONTROL row caught it, and that row is in the tests.
 */
const ARG_OPENS = new Set(['(', ',', '[', '{', '=', ':', ';']);
const ARG_CLOSES = new Set([')', ',', ']', '}', ';', ':']);
const GROUP_CLOSES = new Set([')', ']', '}']);

export interface BodyTargets {
  /** Carrying literals that stand alone — the paths the program can write. */
  targets: string[];
  /** Carrying literals an expression consumes. The destination is NOT these. */
  fragments: string[];
  /**
   * Literals resolving inside a protected tree, whatever they spell and
   * whether or not anything transforms them (#1371).
   *
   * `targets` and `fragments` are both filtered by `ALL_PROTECTED`, so
   * `targets.every(isScratchPath)` quantifies over a set the caller chose the
   * membership of. This one is not filtered by a name list at all, which is
   * the point: the property it reports does not depend on `ALL_PROTECTED`
   * being complete, and completeness is what failed.
   */
  protectedLiterals: string[];
  /**
   * Path-shaped literals the reader could NOT place — an expansion it cannot
   * perform, a backtick, or a relative path whose meaning depends on a
   * working directory. Kept on their own list rather than folded into
   * `protectedLiterals`, so that afterwards the reason a body was refused is
   * still readable: "it names a live tree" and "I could not tell" are
   * different facts and only one of them is a finding about the command.
   */
  unplaceable: string[];
  /** The body does not read as a sequence of complete literals. */
  unreadable: boolean;
}

/**
 * Where a literal sits, as THREE readings and not two (#1371, second round).
 *
 * The first version of this returned a boolean behind
 * `if (!value.startsWith('/')) return false`, and the review was right that
 * the word *absolute* in the remedy I was given is where the hole came
 * from. `~/.rungate/run`, `$HOME/.rungate/run` and `${HOME}/.claude` all
 * took that early exit, and the caller read `false` as **not a protected
 * target** rather than as **I could not place this** — a silent skip, one
 * layer inside the remedy for silent skips.
 *
 * The asymmetry that settles it: a false `unplaceable` costs a refused
 * exemption, which somebody notices and fixes. A false `elsewhere` costs a
 * bypass, which nobody notices.
 *
 * Expansion handles the spellings we thought of; `unplaceable` handles the
 * ones we did not, and it is the half that matters. Both are kept because
 * expansion is what stops the fail-closed half from refusing every ordinary
 * `~/`-spelled read.
 */
type Placement = 'protected' | 'unplaceable' | 'elsewhere';

/** A leading `~`, `$HOME` or `${HOME}`, which the runtime or shell expands. */
const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;

/**
 * Path-shaped and NOT placeable: an expansion we cannot perform, a backtick,
 * or a relative path whose meaning depends on a working directory this
 * module cannot see. `isScratchPath` already gives a relative path exactly
 * this reading — "only an ABSOLUTE path can be placed in a tree" — so this
 * is that rule applied on the other side of the same question.
 */
const UNPLACEABLE = /[$`~]/;

function expandHome(value: string): string {
  const home = process.env.HOME || '';
  if (!home) return value;
  return value.replace(HOME_PREFIX, home);
}

/**
 * One site per reading, so a mutation battery can remove the live-tree
 * reading without removing the fail-closed one and report which rows each
 * is actually holding up. Inlining either verdict at a second site would
 * let a refusal bypass the mutation and the rows would go green having
 * witnessed nothing — `.claude/rules/checks-must-be-able-to-fail.md`.
 */
const IN_LIVE_TREE: Placement = 'protected';
const CANNOT_PLACE: Placement = 'unplaceable';

/**
 * ## The case comparison is the VOLUME's to make, and it makes it (#1371)
 *
 * The review asked for both sides of the live-tree comparison to be
 * case-folded, as `names()` already is, because `/Users/JHORN/…` and
 * `/Users/jhorn/…` are one file and two strings on this volume. It was
 * built, and then the mutation battery refused to witness it: removing the
 * fold left the SHOUTED row refused anyway, because `resolveThroughLinks`
 * climbs to the deepest EXISTING ancestor and `realpathSync` returns the
 * canonical case — `/USERS` comes back `/Users`. So the fold decided
 * nothing that the resolution had not already decided.
 *
 * It is not shipped, and the reason is not thrift. Two deciders answering
 * one question are behaviourally one, no test can tell them apart, and the
 * next reader deletes whichever looks redundant. And on a case-SENSITIVE
 * volume the fold is the wrong answer rather than a spare one: there
 * `/Users/JHORN/x` really is a different file, which the fold would report
 * as live. `names()` folds for a different situation — it matches a
 * basename inside a command string where nothing resolves anything.
 *
 * CI proved both halves of that, and corrected the heading this note used
 * to carry. It said the differential "does not exist here", measured on
 * macOS — and the SHOUTED row went red on the Linux runner, where
 * `/HOME/RUNNER/.rungate/run` is a path that does not exist and is not the
 * artifact. The guard was right on both volumes; the claim was macOS's,
 * read as universal. The row now probes the volume and asserts the verdict
 * tracks it in BOTH directions, so a blind `.toLowerCase()` fold reddens it
 * on Linux and dropping the resolution reddens it on macOS.
 *
 * #1211 / #1358 is the same QUESTION about `WorkflowStateGuard` and may
 * well have a different answer, because that matcher has no resolution step
 * to fall back on. Worth reading this note before fixing it there.
 */
function placeLiteral(value: string, live: string[]): Placement {
  const expanded = expandHome(value);
  // UNPLACEABLE is asked FIRST, and the order is the fix for a hole the
  // other way round left open (#1411 review): `"$RG"` carries no slash, so
  // a slash test in front of this one answered `elsewhere` — "I placed it,
  // and it is not protected" — for a value nothing had placed. Witnessed:
  // `shutil.copy("/tmp/fix/workflow-state.json", os.path.expandvars("$RG"))`
  // was ALLOWED before this swap and is refused after it. The slash-bearing
  // spelling of the same command was already refused, which is what made
  // the gap invisible.
  if (UNPLACEABLE.test(expanded)) return CANNOT_PLACE;
  // Not path-shaped at all: a mode string, a JSON blob, a module name. The
  // exemption would never apply again if these ended it.
  if (!expanded.includes('/')) return 'elsewhere';
  // A RELATIVE path-shaped literal stays `elsewhere`, and that is measured
  // rather than comfortable. Treating one as unplaceable costs 7 real
  // commands and halves the exemption population (13 segments to 6),
  // because `'hornjason/pai-config'` and `'./lib/x.ts'` are slash-bearing
  // and are not paths — and it does not even close the class it was
  // widened for, since `'.'` and `'x'` carry no slash at all. The honest
  // closure for a relative destination is `inWritePosition`, which asks
  // only about literals the write actually consumes.
  if (!expanded.startsWith('/')) return 'elsewhere';
  const normalised = resolve(expanded);
  if (inAnyTree(normalised, live)) return IN_LIVE_TREE;
  const real = resolveThroughLinks(normalised);
  // Nothing in the chain resolved, so this is a path we could not place —
  // not a path we placed outside the live trees. The distinction is the
  // whole of #1371's third round, and `isScratchPath` already notes that an
  // unreachable fail-OPEN in a fail-closed module reads as permission.
  if (real === null) return CANNOT_PLACE;
  // Both spellings, for the reason `protectedTrees` gives at length:
  // `resolve` normalises `..` and does not follow a link, so a pre-existing
  // symlink out of scratch is invisible to the first reading.
  if (inAnyTree(real, live)) return IN_LIVE_TREE;
  return 'elsewhere';
}

/**
 * Which path literals in an interpreter body can be shown to be the write
 * TARGET, and which are merely fragments of an expression that computes one
 * (#1277).
 *
 * ## The mistake this replaces
 *
 * Every escape in this family is the same one wearing a different costume:
 * the exemption read a path LITERAL off the command line and treated it as
 * the destination. #1276 shipped a labelled stopgap — "is every absolute
 * literal in the body scratch" — which closed the one spelling that had been
 * measured and left the class open, because a computed destination need not
 * leave a non-scratch literal behind. Four spellings that it exempts and
 * this refuses are asserted in `test/bash-write-guard.test.ts`; the one that
 * matters least is also the one that reads worst:
 *
 *     bun -e 'writeFileSync("/tmp/x/workflow-state.json"
 *               .replace("/tmp/x", process.env.RUNGATE_WORK_DIR), "{}")'
 *
 * Every absolute literal in it is scratch. The write lands in the run store.
 *
 * ## What is asked instead
 *
 * A literal is a target only when nothing between it and the filesystem
 * transforms it — then, and only then, `isScratchPath` resolving it answers
 * the real question. A carrying literal that does NOT stand alone is not
 * evidence against the write, it is the ABSENCE of evidence for it, so it
 * ends the exemption rather than being ignored. That is the same fail-closed
 * reading `isScratchPath` already applies to a relative path.
 *
 * The three things this still does not do are stated rather than hidden.
 * It cannot see an assembled NAME (`'workflow' + '-state.json'`) — no
 * literal carries the artifact, so arm 3 never receives a candidate, which
 * is a limit of the candidate search and has its own asserted row. It does
 * not read a program in a FILE. And `eval` defeats it, as it defeats any
 * reading of a program that does not run it.
 */
export function bodyTargets(body: string): BodyTargets {
  const targets: string[] = [];
  const fragments: string[] = [];
  const protectedLiterals: string[] = [];
  const unplaceable: string[] = [];
  const lits = readLiterals(body);
  // An unterminated literal means every boundary after it is a guess.
  if (!lits) return { targets: [], fragments: [], protectedLiterals: [], unplaceable: [], unreadable: true };
  /** Every literal span, so the backward walk can step over one. */
  const spans: [number, number][] = lits.map(l => [l.start, l.end]);
  // Read once per body rather than once per literal: each call realpaths up
  // to six trees, and a body has as many literals as it likes.
  const live = protectedTrees();
  for (const { value, start: i, end: j } of lits) {
    const where = placeLiteral(value, live);
    if (where === 'protected') protectedLiterals.push(value);
    if (where === 'unplaceable') unplaceable.push(value);
    if (ALL_PROTECTED.some(p => value.toLowerCase().includes(p.toLowerCase()))) {
      const pos = standsAlone(body, i, j) ? inWritePosition(body, i, spans) : UNPROVEN;
      if (pos === 'destination') targets.push(value);
      // `argument` is deliberately in neither list — see `inWritePosition`.
      else if (pos === 'unproven') fragments.push(value);
    }
  }
  return { targets, fragments, protectedLiterals, unplaceable, unreadable: false };
}

/**
 * The string literals of an interpreter body, with the index of each opening
 * and closing quote — or `null` when one is never closed (#1367 split this
 * out of `bodyTargets` so the chain reader uses the same one reader).
 */
function readLiterals(body: string): Array<{ value: string; start: number; end: number }> | null {
  const out: Array<{ value: string; start: number; end: number }> = [];
  let i = 0;
  while (i < body.length) {
    const q = body[i];
    if (q !== "'" && q !== '"') {
      i++;
      continue;
    }
    let j = i + 1;
    let value = '';
    let closed = false;
    while (j < body.length) {
      const c = body[j];
      // Only a DOUBLE-quoted literal escapes. Inside single quotes a
      // backslash is literal in both shell and Python, and treating it as an
      // escape keeps the span open past its real end — #1203's defect, one
      // layer down.
      if (q === '"' && c === '\\' && j + 1 < body.length) {
        value += body[j + 1];
        j += 2;
        continue;
      }
      if (c === q) {
        closed = true;
        break;
      }
      value += c;
      j++;
    }
    if (!closed) return null;
    out.push({ value, start: i, end: j });
    i = j + 1;
  }
  return out;
}

/**
 * Whitespace, including a newline. See `standsAlone` for why the newline is
 * in here rather than carrying a rule of its own.
 */
const WHITESPACE = new Set([' ', '\t', '\n', '\r']);

/**
 * The callees a literal may be a direct argument of and still be the write
 * TARGET (#1371, second round).
 *
 * This is a WHITELIST OF POSITIONS, which is why it is allowed to exist at
 * all. The thing refused twice on this PR is a denylist of TRANSFORMS —
 * `.replace(`, `+`, `%`, an f-string — because a transform nobody listed
 * reads as "no transform" and the exemption holds; `Path("/tmp/x")
 * .relative_to(…)` is the standing proof and it is a CONTROL row. A
 * whitelist fails the other way: a callee nobody listed is not a recognised
 * write position, so the literal is a fragment and the exemption ends.
 *
 * The names are not a new list. They are the names already in
 * `WRITE_INTENT`, which is what makes a command a candidate for arm 3 in
 * the first place — so a verb missing here is a verb that never brought a
 * command to this question.
 *
 * `remove`, `rename`, `replace`, `unlink` and `write` are qualified rather
 * than matched bare: `str.replace` and `stdout.write` are not writes to a
 * file, and a bare match would read a transform as a write position, which
 * is the denylist's failure wearing a whitelist's clothes.
 */
const WRITE_CALLEES = new Set([
  'writeFileSync',
  'appendFileSync',
  'createWriteStream',
  'copyFileSync',
  'renameSync',
  'unlinkSync',
  'rmSync',
  'truncateSync',
  'write_text',
  'open',
  'dump',
  'copy',
  'copyfile',
  'copytree',
  'move',
  'rmtree',
]);
const QUALIFIED_WRITE_CALLEES = new Set([
  'os.remove',
  'os.rename',
  'os.replace',
  'os.unlink',
  'os.rmdir',
  'shutil.copy',
  'shutil.copyfile',
  'shutil.copytree',
  'shutil.move',
  'shutil.rmtree',
  'json.dump',
]);

/**
 * WHICH argument of a recognised write call is the destination (#1411).
 *
 * Recognising the callee is not enough, because most of these take a SOURCE
 * as well: `shutil.copy("/tmp/fix/workflow-state.json", dest)` put a scratch
 * literal in `targets` while the destination was a name nothing tracks, and
 * `targets.every(isScratchPath)` then exempted a copy whose destination was
 * unknown. Witnessed allowed before this map and refused after it.
 *
 * `-1` means NO argument of that callee is ever a destination path:
 * `json.dump(obj, fp)` writes to a file object, and `p.write_text(data)`
 * writes to its RECEIVER. A literal argument of either is data, and reading
 * it as a target is the same defect pointed the other way.
 *
 * The default is 0 rather than "unknown", because every remaining name in
 * `WRITE_CALLEES` takes its path first and a name that reaches here has
 * already passed the whitelist.
 */
const DEST_INDEX = new Map<string, number>([
  ['copy', 1],
  ['copyfile', 1],
  ['copytree', 1],
  ['copyFileSync', 1],
  ['move', 1],
  ['rename', 1],
  ['renameSync', 1],
  ['replace', 1],
  ['dump', -1],
  ['write_text', -1],
]);

function destIndexOf(name: string): number {
  const last = name.slice(name.lastIndexOf('.') + 1);
  const at = DEST_INDEX.get(last);
  return at === undefined ? 0 : at;
}

function isWriteCallee(name: string): boolean {
  if (!name) return false;
  if (QUALIFIED_WRITE_CALLEES.has(name)) return true;
  const last = name.slice(name.lastIndexOf('.') + 1);
  return WRITE_CALLEES.has(last);
}

/**
 * Is the literal beginning at `start` a DIRECT argument of a recognised
 * write call?
 *
 * The walk goes backwards to the opener of the group the literal sits in,
 * stepping over balanced groups and over literal spans already read — a
 * `(` inside a string is not a bracket. Three endings, and only the first
 * is a yes:
 *
 *   a `(` at depth 0      the literal is an argument of that call; read the
 *                         callee in front of it and ask the whitelist
 *   a `[` or `{` at 0     the literal is an element of a list or an entry
 *                         in a dict, not an argument of anything
 *   the start of the body the literal is at statement level: a binding, a
 *                         bare expression, a dict key with no enclosing call
 *
 * This is what makes the exemption a claim about the WRITE rather than
 * about a path that appears somewhere near one, and it is what the two
 * earlier rounds were each reaching for with a cheaper instrument.
 *
 * ## Three answers, because two of them conflated placed with unreadable
 *
 * `argument` is a literal that IS a direct argument of a recognised write
 * call and is NOT at the destination index — `shutil.copy`'s source, or
 * `json.dump`'s object. A boolean had to call that `unproven`, which is a
 * fragment, which ends the exemption: with the index map added and two
 * answers available, `shutil.copy('/tmp/a/x', '/tmp/b/x')` went from
 * allowed to refused, and that command is the exact shape #1175 exists to
 * unblock. It is three CONTROL rows across three describes and all three
 * went red together, which is what a control is for.
 *
 * So: `destination` counts as a target, `unproven` ends the exemption, and
 * `argument` does neither — the literal is placed, and placed somewhere
 * that is not the write. A command whose ONLY literal is an `argument`
 * still reaches `targets.length === 0` and is refused.
 */
type Position = 'destination' | 'argument' | 'unproven';
const IS_DESTINATION: Position = 'destination';
const UNPROVEN: Position = 'unproven';

function inWritePosition(body: string, start: number, spans: [number, number][]): Position {
  let i = start - 1;
  let depth = 0;
  /** Depth-0 commas between the opener and the literal: its argument index. */
  let index = 0;
  while (i >= 0) {
    const span = spans.find(([s, e]) => i >= s && i <= e);
    if (span) {
      i = span[0] - 1;
      continue;
    }
    const c = body[i];
    if (c === ')' || c === ']' || c === '}') {
      depth++;
    } else if (c === '(') {
      if (depth === 0) {
        const callee = calleeBefore(body, i);
        if (!isWriteCallee(callee)) return UNPROVEN;
        return index === destIndexOf(callee) ? IS_DESTINATION : 'argument';
      }
      depth--;
    } else if (c === '[' || c === '{') {
      if (depth === 0) return UNPROVEN;
      depth--;
    } else if (c === ',') {
      if (depth === 0) index++;
    } else if (c === '?') {
      // A ternary BRANCH is not a destination, it is one of two candidates,
      // and the guard has no way to say which runs. `:` is an `ARG_OPEN`, so
      // the false branch read as a complete argument and the walk continued
      // past `?` to the write call's own paren — witnessed:
      // `writeFileSync(x ? d : "/tmp/fix/workflow-state.json", "{}")` was
      // ALLOWED, while the same command with the literal in the TRUE branch
      // was already refused, because `?` is not an `ARG_OPEN` and the
      // literal fell out as a fragment. That asymmetry is the whole finding:
      // one spelling of one expression was fail-closed by accident and the
      // other was not.
      if (depth === 0) return UNPROVEN;
    }
    i--;
  }
  return UNPROVEN;
}

/** The dotted name immediately in front of an opening parenthesis. */
function calleeBefore(body: string, openIndex: number): string {
  let i = openIndex - 1;
  while (i >= 0 && WHITESPACE.has(body[i])) i--;
  let end = i + 1;
  while (i >= 0 && /[A-Za-z0-9_$.]/.test(body[i])) i--;
  return body.slice(i + 1, end);
}

/**
 * Is the literal spanning `[start, end]` a complete argument on both sides,
 * and is every expression ENCLOSING it also complete?
 *
 * ## A newline is whitespace, not a delimiter (#1371)
 *
 * It used to be one: a newline at the literal's own depth ENDED the
 * expression, on the reading that a newline ends a statement. The AI review
 * on #1371 found what that costs, and it is the whole of #1277 — the
 * headline escape, with one newline inserted:
 *
 *     writeFileSync("/tmp/x/workflow-state.json"
 *       .replace("/tmp/x", process.env.RUNGATE_WORK_DIR), "{}")
 *
 * The literal is followed by a newline, so it read as a complete argument;
 * the `.replace` on the next line was never looked at. Both JavaScript and
 * Python continue an expression across a newline, so "a newline ends a
 * statement" is true only of a statement nothing encloses — which this walk
 * cannot tell apart from a line break inside one. A detector a reformat
 * defeats is the second shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`, and it defeated the exact
 * witness the PR was written for.
 *
 * So the walk looks THROUGH whitespace in both directions to the real
 * delimiter, which is the same question it was always asking. It keeps the
 * ordinary multi-line fixture, because looking back through a newline from
 * a literal that starts a line lands on the `(` or `,` that really opened
 * it.
 *
 * ## The LEADING half has no witness, and that is said rather than implied
 *
 * The trailing half is the escape above, executed. The leading half —
 * `x +\n  "…"`, where a literal opening a line read as unconsumed — is
 * symmetry, and no harmful instance of it exists that I could write: for it
 * to matter the literal must be scratch AND carry a protected artifact AND
 * be the right operand of a concatenation, and a scratch absolute path is
 * not a suffix of anything. It is kept because the two halves ask one
 * question and an asymmetric rule invites the next reader to restore the
 * half that looks arbitrary. Measured cost over 131,942 real commands:
 * 0 newly blocked, 0 newly allowed, and the exemption population does not
 * move. `bodyTargets` reporting it as a fragment is asserted in the tests;
 * no verdict claim is made for it, because none was earned.
 */
function standsAlone(body: string, start: number, end: number): boolean {
  let a = start - 1;
  while (a >= 0 && WHITESPACE.has(body[a])) a--;
  if (a >= 0 && !ARG_OPENS.has(body[a])) return false;

  let b = end + 1;
  for (;;) {
    while (b < body.length && WHITESPACE.has(body[b])) b++;
    if (b >= body.length) return true;
    const c = body[b];
    if (GROUP_CLOSES.has(c)) {
      b++;
      continue;
    }
    return ARG_CLOSES.has(c);
  }
}

/**
 * Can every write this body could make to a protected artifact be shown to
 * land in a scratch tree?
 *
 * Five ways to answer no, and all five are the absence of evidence rather
 * than evidence of harm: the body cannot be read, a carrying literal is
 * consumed by an expression, the body names a live tree, the body names a
 * path the reader cannot PLACE, or no literal carries the artifact at all.
 * The exemption's job is to say YES.
 *
 * With five refusals stacked, the failure that costs us is no longer a
 * bypass — it is an exemption that silently never applies again, and every
 * refusal row stays green through exactly that. So the CONTROL rows are the
 * load-bearing half of the suite, and the corpus reading that matters most
 * is `exempt > 0`, not `newly blocked == 0`.
 *
 * ## Why the live-tree reading is a separate question (#1371)
 *
 * The last line is `every` over `targets`, and `targets` only ever receives
 * literals that matched `ALL_PROTECTED`. So the quantifier ranges over a set
 * the command's author chooses the membership of, and the two readings come
 * apart on a body that writes a protected artifact into scratch AND touches
 * a live tree under a name no list has:
 *
 *     shutil.copy('/tmp/fix/workflow-state.json', '$HOME/.rungate/run')
 *
 * Every member of `targets` is scratch, so `every` says yes; the copy lands
 * in the run store. `main` refused this, this module allowed it until
 * #1371, and 50,189 real commands could not see it — an honest caller does
 * not write it, which is exactly who it is worth something to.
 *
 * `protectedLiterals` is the reading that does not go through a name list,
 * so it cannot be walked around by choosing a basename. The alternative on
 * the table was a second whole-body gate ANDed with this one, and it was
 * refused: two deciders answering one question are behaviourally one, no
 * test can tell them apart, and the next reader deletes the live half —
 * `.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape.
 */
function bodyTargetsAreScratch(body: string, exempt: Exemption): boolean {
  const { targets, fragments, protectedLiterals, unplaceable, unreadable } = bodyTargets(body);
  if (unreadable || fragments.length > 0) return false;
  if (protectedLiterals.length > 0 || unplaceable.length > 0) return false;
  if (targets.length === 0) return false;
  return targets.every(exempt);
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
 * The scratch exemption is decided per DESTINATION against the WHOLE command
 * (#1367): the chain context is read once, lazily — most commands name no
 * protected artifact and never ask — and each step gets a judge that knows
 * its position and which words are its own. A body this command runs is
 * decided as a command of its own, inheriting what the enclosing command
 * made and named before it (`outer`).
 */
export function decideBashWrite(cmd: string, depth = 0, outer?: () => Outer): BashWriteDecision {
  if (!cmd) return ALLOW;
  // A shell body can contain a shell body. Bounded so a crafted nest costs a
  // fixed amount of work rather than the session.
  if (depth > 3) return ALLOW;
  let ctx: ChainContext | null = null;
  const getCtx = (): ChainContext => (ctx ??= chainContext(cmd, outer?.()));

  // #1240: a program handed to an interpreter on stdin. `stripHeredocs`
  // deletes the body before every arm below, and arm 3a only reads a body
  // back when the segment also carries `-c`/`-e` — which `bash <<'EOF'` does
  // not. The result was that the guard decided on the single word `bash`
  // while the program underneath wrote whatever it liked. Each program is
  // re-entered as a command in its own right, and recomputes its own
  // exemption: an `ln` in the body is the body's business.
  // A SHELL body is read as shell; anything else gets the treatment arm 3
  // gives a `-c` body it cannot parse — a declared write verb near the name
  // of a protected artifact. Reading a Python body as shell finds nothing,
  // which is how `python3 <<'PY'` stayed allowed after the shell spellings
  // were closed.
  for (const [k, { shell, program }] of interpreterPrograms(cmd).entries()) {
    if (shell) {
      const inner = decideBashWrite(program, depth + 1, () => outerFor(getCtx(), `prog:${k}`, -1));
      if (inner.blocked) return inner;
      continue;
    }
    const exempt = judgeFor(getCtx, { src: `prog:${k}`, only: new Set(bodyTargets(program).targets) }, -1);
    // #1277: the same target question as arm 3 below. A stdin program is
    // the arm 3 body reached by another route, and it had NO body gate at
    // all — so the `.replace` spelling #1276 closed for `-e` was still open
    // here, in a heredoc, for as long as the stopgap existed.
    const pf = absoluteNamesOutsideScratch(program, bodyTargetsAreScratch(program, exempt) ? exempt : NO_EXEMPTION).find(p =>
      writesNear(program, p) || callWrites(program, p),
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

  const segs = segments(cmd);
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    // The write's own words are the step's shell words: they are what the
    // writing verb is handed, not something that runs before it.
    const exempt = judgeFor(getCtx, { src: `seg:${i}` }, i);
    const bare = dequote(seg); // TARGET view: contents kept
    const code = stripQuoted(seg); // VERB view: quoted spans gone
    const word = commandWord(seg);

    // 1. Shell redirection and copying verbs. Never exempted by anything:
    //    this is the arm the old allowlist sat above, which is #1120.
    // The whole command is passed so the directory test can see a `mkdir`
    // in an EARLIER segment (#1196 R2). Everything else is per-segment.
    for (const target of writeTargets(seg, cmd)) {
      // #1175: the target IS a path, so the tree question is asked directly
      // here rather than through `namesOutsideScratch`.
      if (exempt(target)) continue;
      const pf = names(target, PROTECTED_FILES);
      if (pf) {
        return {
          blocked: true,
          reason: `Bash write to protected file "${pf}" blocked. Use gate-runner.ts for gate results.`,
        };
      }
      if (names(target, PROTECTED_HOOKS)) {
        return { blocked: true, reason: 'Bash write to hook file blocked. Hook integrity is protected.' };
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
    const isInterpreter = isInterpreterWord(word) && /\s-[a-z]*[ce]\b/.test(code);
    const isMutatingFind = word === 'find' && FIND_MUTATING.test(code);

    // 3a. A shell `-c` body is shell. Read it as shell rather than scanning
    //     it for Node and Python idioms it will never contain (#1176).
    if (isInterpreter && isShellWord(word)) {
      const body = shellBody(seg);
      if (body) {
        const inner = decideBashWrite(body, depth + 1, () => outerFor(getCtx(), `seg:${i}`, i));
        if (inner.blocked) return inner;
      }
    }

    if (isInterpreter || isMutatingFind) {
      // #1214 asked for a third reading here — an imported project symbol
      // called with a protected path — and it was built, measured and
      // REJECTED. See `WRITE_INTENT` for the numbers and for the one fact
      // that decided it.
      //
      // #1361 merge: this branch read the exemption with `bodyIsAllScratch`
      // (#1269). `main` has since replaced that with the TARGET question
      // below (#1277), which its own comment says closes the class #1269's
      // predicate only sampled. Main's is kept and `bodyIsAllScratch` is
      // deleted rather than left defined-and-uncalled — a superseded
      // predicate still in the file is the next reader's second decider.
      // #1277: the exemption asks whether the body's write TARGET can be
      // shown to be scratch — see `bodyTargets`. It replaces #1276's
      // all-absolute-literals stopgap, which this closes the class of.
      //
      // Two cases keep the plain `exempt`, because their destinations are
      // SHELL WORDS and not source literals, so `namesOutsideScratch`
      // already asks the target question of them directly: a mutating
      // `find`, whose operands are on the command line, and a shell `-c`
      // body, which arm 3a re-enters as shell. Handing either to a reader of
      // string literals would refuse them for having none.
      // An interpreter's own words are NOT excused the way a verb's are: the
      // program can do anything with its arguments and environment before it
      // writes. Only the body's write targets are the write's own.
      const body = programBody(seg);
      const bodyJudge = judgeFor(getCtx, { src: `body:${i}`, only: new Set(bodyTargets(body).targets) }, i);
      const bodyExempt =
        isMutatingFind || isShellWord(word)
          ? exempt
          : bodyTargetsAreScratch(body, bodyJudge)
            ? bodyJudge
            : NO_EXEMPTION;
      const candidates = namesOutsideScratch(bare, ALL_PROTECTED, bodyExempt);
      // #1407: `callWrites` reads the body, which keeps its quotes; `bare`
      // has had every quote stripped by `dequote`. A name the body does not
      // spell as written (split across adjacent literals, say) is whole only
      // in `bare`, so it is read there instead (security review).
      const pf = isMutatingFind
        ? (candidates[0] ?? null)
        : (candidates.find(p => writesNear(bare, p) || callWrites(body !== '' && body.includes(p) ? body : bare, p)) ?? null);
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
    //    the verb — not merely a `chmod` somewhere in the string, which is
    //    what refused four read-only commands. The target is read off `bare`,
    //    so quoting the path does not hide it.
    //
    //    #1146: the TARGET list widened from PROTECTED_HOOKS to every
    //    protected artifact; the VERB test is untouched, and that asymmetry is
    //    the point. There was no reason for a `chmod` on `.gate-salt` to be
    //    allowed while a `chmod` on a `.hook.ts` was refused — mode bits are
    //    how a file stops being writable, so a permission change on the gate
    //    salt is a step toward writing it. Measured on the 5,059 allowed
    //    commands naming a protected artifact, the widening newly blocks
    //    exactly one, and that one is real:
    //      `chmod 600 …/worktrees/agent-abbce…/hooks/lib/.gate-salt`
    //
    //    #1175 composes with that widening rather than replacing it: the
    //    target list stays `ALL_PROTECTED` and the lookup moves to
    //    `namesOutsideScratch`, so a `chmod` on a FIXTURE in a scratch tree
    //    is not a permission change on a protected artifact. The widened
    //    list and the tree scoping are independent and both are kept — a
    //    textual merge that took either side alone would have silently
    //    dropped one of them.
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

    // 5. The gate salt in the Keychain. Exempted by nothing — unlike `chmod`,
    //    which turns up innocently in docs and greps, `security` INVOKED on
    //    the gate-salt entry has no benign form. It has a benign MENTION
    //    though, and two real commands hit it: issue comments quoting the
    //    very command they proposed to guard.
    //
    //    #1176: this used to read `stripQuoted(cmd)` over the whole command,
    //    which deleted the quoted key name outright — so the real invocation,
    //    `security find-generic-password -s 'pai-gate-salt'`, could not fire
    //    it. The prose case is now separated by POSITION instead: the command
    //    word must BE `security`, which an issue comment's `gh` never is.
    //    #1184: the key is matched across the WHOLE command, not just this
    //    segment, so `KEY=pai-gate-salt; security … -s "$KEY"` cannot hide it
    //    behind a variable. Measured cost: 0 commands in an unfiltered corpus
    //    of 125,644. The command word must still BE `security`, which is what
    //    keeps the `gh issue comment` prose case allowed.
    //
    //    The other half of that suggestion — firing on any keychain
    //    SUBCOMMAND whether or not the key is named — is refused. In the same
    //    corpus only TWO commands have `security` as their command word, and
    //    widening to subcommands newly blocks exactly one: `security
    //    find-generic-password -h`, a help invocation. One false positive,
    //    zero true positives, no evidence of the risk it was meant to cover.
    if (word === 'security' && dequote(cmd).toLowerCase().includes('pai-gate-salt')) {
      return { blocked: true, reason: 'Access to gate salt Keychain entry blocked.' };
    }
  }

  return ALLOW;
}
