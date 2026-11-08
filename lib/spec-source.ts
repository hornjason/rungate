/**
 * Where a reading's spec came from — the shipped ref, or the tree you are
 * standing in.
 *
 * Stage D's D3: *"it fetches and reads origin/main, never a working tree — a
 * stale tree and a missing feature look identical"*. `scripts/board-snapshot.ts`
 * read the spec with a bare `readFileSync`, so every reading it produced was
 * scoped by whatever branch the caller happened to be on, and the output said
 * nothing about which. A branch halfway through editing a Phase placement
 * table and a branch four days behind `main` produce different numbers against
 * the SAME live board, and both print as an ordinary reading.
 *
 * ## The three answers, and why `untracked` is not a failure
 *
 * | reading | when | what the caller does |
 * |---|---|---|
 * | `ref` | the path is tracked and `origin/<branch>` has it | measure it — this is the shipped spec |
 * | `untracked` | git does not know the path at all | read it from disk, and SAY so |
 * | `unmeasured` | git knows the path and the ref read failed | refuse; do NOT fall back to disk |
 *
 * A file git has never heard of has no `origin/main` version to read, and that
 * is a fact about the file rather than a failure of the reader — a planted
 * fixture in an `mkdtemp` is the ordinary case. **An untracked path is
 * reported by name**, so a reading taken against one cannot be mistaken for a
 * reading taken against the shipped spec.
 *
 * The third row is the one that matters. `catch { return readFileSync(...) }`
 * is the whole defect wearing a repair: it turns "the fetch failed" into
 * "here is the working tree", silently, in exactly the case where the two
 * disagree most. That is *Silent Default Substitution* from
 * `.claude/rules/config-access.md`, and this module refuses instead.
 *
 * ## Fetch immediately before reading, never once at startup
 *
 * `origin/main` is a local ref and it is as old as the last fetch. The fetch
 * and the `git show` are adjacent here on purpose: anything between them is a
 * window in which the remote moves and the reading cites a ref nobody can
 * reproduce.
 *
 * A fetch that fails is NOT fatal on its own — an offline machine still has a
 * usable `origin/main` from its last fetch, and refusing there would make the
 * command unrunnable on a plane for no reading-level reason. It is reported in
 * `staleness`, so the caller can say the ref may be behind.
 */

import { realpathSync } from "fs";
import { basename, dirname, join, relative, resolve, sep } from "path";

/** What a single git invocation came back with. */
export interface GitRun {
  ok: boolean;
  stdout: string;
  stderr: string;
  /**
   * The process's exit status, or `null` when it never ran.
   *
   * **Carried because `ok: false` spans two opposite facts.** `git ls-files
   * --error-unmatch` exits **1** for "this path is not tracked", which is an
   * answer, and **128** for "this is not a repository / the object store is
   * broken", which is the reader failing. Collapsing them is the
   * working-tree fallback reached through a side door: a `root` pointed at
   * the wrong place reports every path untracked, reads disk, and prints a
   * reading. Found by security review of PR #1896, round 1 — in the module
   * whose docblock says it refuses exactly this.
   *
   * `null` is a spawn that never happened — no `git` on PATH. That is never
   * an answer about a file.
   */
  code: number | null;
}

/**
 * Strip anything credential-shaped out of text bound for a log line.
 *
 * `git fetch` failures quote the remote URL, and a CI checkout's remote is
 * routinely `https://x-access-token:<TOKEN>@github.com/owner/repo`. This
 * module interpolates that stderr into `staleness`, and
 * `scripts/board-conformance.ts` prints it — so a failed fetch on a runner
 * put a live token in the build log. Actions masks secrets it was given;
 * it cannot mask one that reached the URL by another route.
 *
 * Applied at the point of interpolation rather than trusted to the caller:
 * the caller is a log line, and a sanitiser the emitter has to remember is
 * one that gets forgotten. Found by security review of PR #1896, round 1.
 *
 * **EVERY interpolation, not every stderr.** Round 3 found the one arm that
 * quotes a git *stdout* — `--git-dir`'s path — and it was unwrapped because
 * the rule in this docblock said "stderr" and a path looked exempt. A path
 * is `GIT_DIR` when `GIT_DIR` is set, and `GIT_DIR` is a string somebody
 * else chose. The narrower rule is the defect: a sanitiser with a carve-out
 * is one each new arm has to re-decide, so there is no carve-out.
 */
export function redactCredentials(text: string): string {
  return text
    // `scheme://user:secret@host` — the userinfo is the whole payload.
    .replace(/:\/\/[^/@\s]+@/g, "://***@")
    // GitHub's own token shapes, in case one is quoted outside a URL.
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "***")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}/g, "***");
}

/** `git -C <root> <args>` — injected so a test never reaches a real repository. */
export type GitRunner = (args: readonly string[]) => GitRun;

export type SpecSource =
  | {
      kind: "ref";
      /** `origin/main`, as given. */
      ref: string;
      /** The commit `ref` resolved to, read in the same breath as the content. */
      sha: string;
      /** The path as git spells it — repository-relative, forward slashes. */
      path: string;
      content: string;
      /**
       * Why the ref may be behind the remote, or null when the fetch succeeded.
       *
       * Never a refusal. A stale `origin/main` is still `origin/main`, and the
       * caller's provenance line is the right place to say it might be old.
       */
      staleness: string | null;
      /**
       * True when the working tree's copy differs from `ref`'s, **and `null`
       * when the comparison itself failed.**
       *
       * D4's half of this lives elsewhere; what this flag buys D3 is that the
       * provenance line can say "I read the shipped spec, and yours differs"
       * rather than leaving the reader to wonder which they got.
       *
       * The third state is not decoration. `git diff --quiet` exits 0 for
       * same and 1 for differs, and anything else is the comparison not
       * happening — which `!ok` printed as a confident "DIFFERS". A reader
       * cannot act on a difference nobody measured.
       */
      worktreeDiffers: boolean | null;
      /** Why the comparison failed, when `worktreeDiffers` is `null`. */
      worktreeCompareFailed: string | null;
    }
  | { kind: "untracked"; path: string; why: string }
  | { kind: "unmeasured"; why: string };

/**
 * The ref a reading should be taken against, unless a caller names another.
 *
 * `origin/main` rather than `main`: a local `main` is a working tree too, and
 * it is behind the remote for exactly as long as nobody pulls.
 */
export const DEFAULT_SPEC_REF = "origin/main";

/**
 * `origin/main` -> `{ remote: "origin", branch: "main" }`, or null when the
 * ref does not name both.
 *
 * **One decider.** Round 4 read the remote back out of the fetch argv as
 * `fetchArgs[1]`, which is `--quiet`, and asked `git remote get-url
 * --quiet` — so every unresolvable ref fell through to a working-tree read,
 * which is the fail-open that arm exists to prevent. The fake could not see
 * it: it keys answers on the subcommand and never looked at the operand.
 */
export function splitRef(ref: string): { remote: string; branch: string } | null {
  const at = ref.indexOf("/");
  if (at <= 0 || at === ref.length - 1) return null;
  return { remote: ref.slice(0, at), branch: ref.slice(at + 1) };
}

/** `origin/main` -> `origin main`, for the fetch that refreshes it. */
function fetchArgsFor(ref: string): string[] | null {
  const parts = splitRef(ref);
  return parts === null ? null : ["fetch", "--quiet", parts.remote, parts.branch];
}

/**
 * Resolve the spec's content from `ref`, or say precisely why not.
 *
 * `absPath` is where the caller believes the spec is; `root` is the repository
 * it should be read relative to. Both are taken rather than derived, because
 * `board-snapshot` accepts an absolute spec path and deriving a root from it
 * would silently measure a different checkout.
 */
/**
 * Canonicalise a directory, or `null` when it cannot be resolved.
 *
 * Injected for the same reason {@link GitRunner} is: a case that touches the
 * real filesystem measures whatever this machine happens to look like. The
 * live one returns `null` on ENOENT rather than throwing, because an
 * unresolvable path is a reading this module must refuse, not a crash.
 */
export type RealPath = (p: string) => string | null;

export const LIVE_REALPATH: RealPath = p => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

export function resolveSpecSource(opts: {
  root: string;
  absPath: string;
  ref?: string;
  git: GitRunner;
  realpath?: RealPath;
}): SpecSource {
  const ref = opts.ref ?? DEFAULT_SPEC_REF;
  const realpath = opts.realpath ?? LIVE_REALPATH;

  // IS THERE A REPOSITORY AT ALL, FIRST — and is `git` even runnable.
  //
  // Three outcomes, and they are NOT one: a spawn that never happened is
  // the reader broken (UNMEASURED); a directory that is not a repository
  // genuinely has no `origin/main`, so disk is the only copy there is and
  // saying so is the honest reading; and a repository proceeds.
  // `--show-toplevel`, which answers BOTH questions in one call: whether
  // there is a work tree, and where it ends. The second half matters as
  // much as the first — see the containment check below.
  const inRepo = opts.git(["rev-parse", "--show-toplevel"]);
  if (inRepo.code === null) {
    return {
      kind: "unmeasured",
      why:
        `\`git\` could not be run in ${opts.root}: ${redactCredentials(inRepo.stderr.trim()) || "it never started"}. ` +
        `A reader that cannot run has not found an untracked file — reading the working tree here would print a ` +
        `reading scoped by whatever branch this is.`,
    };
  }
  const top = inRepo.stdout.trim();
  // **AN `ok` ANSWER OF NOTHING IS UNMEASURED, NEVER UNTRACKED.** git
  // succeeded and said something this function cannot interpret, and
  // "I do not understand the answer" is not "there is no repository".
  // Round 2 of #1896's security review; this arm used to return untracked
  // and a case in the battery asserted that wrong answer.
  if (inRepo.ok && top === "") {
    return {
      kind: "unmeasured",
      why:
        `\`git rev-parse --show-toplevel\` exited 0 in ${opts.root} and printed nothing. That is an answer this ` +
        `reader cannot interpret, not a directory without a repository — and the difference decides whether the ` +
        `working tree gets read.`,
    };
  }
  if (!inRepo.ok) {
    // **A SECOND PROBE, BECAUSE 128 SPANS TWO FACTS.** `--show-toplevel`
    // exits 128 for "no repository anywhere above here" and for "there is
    // a repository and its work tree is unusable" — a bare repo, an
    // unreadable `.git`. The first is an ordinary planted fixture and disk
    // is genuinely the only copy; the second is a reader that failed, and
    // falling back there is the defect this module exists to prevent.
    //
    // Not two deciders over one question: `--git-dir` answers *is there a
    // repository*, `--show-toplevel` answers *does it have a work tree I
    // can see*. Measured — in a plain temp directory both exit 128, which
    // is what makes "both failed" the signal for no repository at all.
    const gitDir = opts.git(["rev-parse", "--git-dir"]);
    if (gitDir.ok) {
      return {
        kind: "unmeasured",
        why:
          `${opts.root} IS a git repository (\`--git-dir\` resolved to ` +
          `${redactCredentials(gitDir.stdout.trim()) || "an unnamed path"}) ` +
          `and \`--show-toplevel\` still failed with exit ${inRepo.code}: ` +
          `${redactCredentials(inRepo.stderr.trim()) || "no reason given"}. A work tree that cannot be located is a ` +
          `reader that failed, not a file that is untracked.`,
      };
    }
    return {
      kind: "untracked",
      path: opts.absPath,
      // THE EXIT AND BOTH REASONS, quoted. No text matcher decides which
      // kind of 128 this was — the two probes do, and the line says what
      // each of them said so a reader can judge for themselves.
      why:
        `${opts.root} is not inside a git work tree and is not a repository (\`--show-toplevel\` exit ` +
        `${inRepo.code}: ${redactCredentials(inRepo.stderr.trim()) || "no reason given"}; \`--git-dir\` exit ` +
        `${gitDir.code}), so there is no ${ref} to read and the file on disk is the only copy that exists. ` +
        `The reading below was taken against it.`,
    };
  }

  // **A PATH OUTSIDE THE REPOSITORY IS UNTRACKED, AND IT IS DECIDED HERE
  // RATHER THAN BY GIT'S EXIT CODE.** `ls-files --error-unmatch` exits 128
  // for a path outside the work tree AND for a broken object store, so the
  // arm below cannot separate them — asking the question before git does
  // is what lets 128 mean exactly one thing when it arrives. The
  // alternative is matching on `is outside repository` in stderr, which is
  // a detector a locale or a git release can silently narrow.
  //
  // This is also the ordinary case rather than an edge: every fixture in
  // `test/board-snapshot.test.ts` plants a spec in an `mkdtemp` while the
  // project root is this checkout.
  // **CANONICALISED BOTH SIDES, because a lexical compare has a parser
  // differential against the filesystem.** On darwin `/tmp` IS
  // `/private/tmp` and the volume is case-insensitive, so a path genuinely
  // inside the work tree can read as outside — and the error falls toward
  // reading the working tree, which is the direction that matters. Round 2
  // of #1896's security review.
  //
  // `realpath` is resolved on the DIRECTORY and the basename re-attached,
  // so a spec that does not exist yet still canonicalises; a directory that
  // cannot be resolved at all is UNMEASURED rather than untracked, for the
  // same reason every other failure here is.
  const canonTop = realpath(resolve(top));
  const canonAbs = realpath(resolve(dirname(opts.absPath)));
  if (canonTop === null || canonAbs === null) {
    return {
      kind: "unmeasured",
      why:
        `the work tree at ${top} or the directory holding ${opts.absPath} could not be resolved to a real path, ` +
        `so whether the spec is inside the repository is unknown. Guessing it is outside would read the working ` +
        `tree; guessing it is inside would read a ref for a file somewhere else.`,
    };
  }
  const real = join(canonAbs, basename(opts.absPath));
  const within = real === canonTop || real.startsWith(canonTop + sep);
  if (!within) {
    return {
      kind: "untracked",
      path: opts.absPath,
      why:
        `${opts.absPath} is outside the work tree at ${top}, so ${ref} has no version of it. ` +
        `The reading below was taken against the file on disk.`,
    };
  }

  // **THE REPOSITORY-RELATIVE PATH IS DERIVED, NOT ASKED OF `ls-files`.**
  // Both operands are already canonical and containment is already decided,
  // so `relative` is the whole computation and it needs no subprocess. What
  // it replaces is `ls-files --full-name`, which returned this string as a
  // side effect of answering a question about the LOCAL index — see below.
  const path = relative(canonTop, real).split(sep).join("/");
  if (path === "" || path.startsWith("..")) {
    return {
      kind: "unmeasured",
      why:
        `${opts.absPath} resolved to ${real}, which is the work tree at ${canonTop} itself rather than a file ` +
        `inside it. A spec is a file; there is no reading to take here.`,
    };
  }

  const fetchArgs = fetchArgsFor(ref);
  let staleness: string | null = null;
  if (fetchArgs === null) {
    staleness = `${ref} does not name a remote and a branch, so nothing was fetched and it is as old as the last one`;
  } else {
    const fetched = opts.git(fetchArgs);
    if (!fetched.ok) {
      staleness =
        `\`git ${fetchArgs.join(" ")}\` failed, so ${ref} is as old as the last successful fetch: ` +
        `${redactCredentials(fetched.stderr.trim()) || "no reason given"}`;
    }
  }

  // THE SHA AND THE CONTENT, adjacent. Resolved after the fetch so the two
  // describe the same ref, and reported together so a reading can be
  // re-taken by somebody who was not here.
  const resolved = opts.git(["rev-parse", ref]);
  const sha = resolved.stdout.trim();
  if (!resolved.ok || sha === "") {
    // **AN UNRESOLVABLE REF FAILS CLOSED, AND THE ONE WIDENING IS A
    // MISSING REMOTE.** Round 3 widened it with the LOCAL INDEX instead —
    // untracked here plus an unresolvable ref read disk — and that is the
    // hole this module had just closed, re-opened one arm along: a stale
    // checkout missing a newly-shipped spec is untracked locally, and a
    // transient resolution failure then hands it a working-tree read. The
    // local index cannot be the evidence that permits a disk read; it is
    // the thing being doubted.
    //
    // A remote that does not exist is different in kind. `origin/main`
    // cannot ever resolve there and no fetch will change it, so there is
    // no shipped version to be wrong about. `git remote get-url` is the
    // probe, and only its exit 0 counts as an answer — anything else is a
    // reading nobody took.
    const remote = splitRef(ref)?.remote ?? null;
    if (remote !== null) {
      // **EXIT 2 AND NOTHING ELSE.** Measured: `git remote get-url` exits
      // 2 for a remote that is not configured and 0 for one that is. Any
      // other code is git failing to answer — a malformed `.git/config` is
      // 128 — and round 5 accepted every non-null non-zero here, so a
      // broken config read as "no remote" and fell through to a
      // working-tree read. Round 6.
      const url = opts.git(["remote", "get-url", remote]);
      if (!url.ok && url.code !== 2 && url.code !== 0) {
        return {
          kind: "unmeasured",
          why:
            `\`git remote get-url ${remote}\` failed in ${opts.root} with exit ${url.code}: ` +
            `${redactCredentials(url.stderr.trim()) || "no reason given"}. That is git unable to say whether the ` +
            `remote exists, which is not the same as it not existing.`,
        };
      }
      if (!url.ok) {
        return {
          kind: "untracked",
          path: opts.absPath,
          why:
            `${opts.root} has no remote named \`${remote}\`, so ${ref} can never resolve and there is no shipped ` +
            `version of ${opts.absPath} to read. The reading below was taken against the file on disk.`,
        };
      }
    }
    return {
      kind: "unmeasured",
      why:
        `${ref} does not resolve in ${opts.root}: ${redactCredentials(resolved.stderr.trim()) || "no reason given"}. ` +
        `Falling back to the working tree would report a reading scoped by whatever branch this is.`,
    };
  }

  // **DOES THE REF HAVE IT — ASKED OF THE REF.**
  //
  // This used to be `git ls-files --error-unmatch`, and that is a question
  // about the LOCAL index. The two answers diverge in exactly the direction
  // this module exists to prevent: a spec added on `origin/main` after this
  // checkout was cut is absent locally and present at the ref, so the local
  // question said "untracked" and the caller read disk — or, in
  // `board-snapshot`, refused with "no such spec" while the shipped copy
  // sat in the ref it was asked to read. Found by review of #1896 round 3,
  // and no case could see it: every fixture keyed `ls-files` to the same
  // branch state as `show`, so the suite varied one axis and the defect
  // sat on the other.
  //
  // The cost is that an untracked path inside the work tree now costs a
  // fetch, because trackedness is no longer known before the ref is
  // resolved. That is the right trade: the saved fetch was buying a wrong
  // answer.
  // **`ls-tree`, NOT `cat-file -e` — because `cat-file -e` has no exit code
  // for "the ref has not got it".** Measured against real git at
  // b40a62a0: an absent path exits **128**, and so does a bad object name,
  // and so does a corrupt store. Round 3 of this review shipped
  // `atRef.code !== 1` over it, which sent every absent path to UNMEASURED
  // and left the untracked arm unreachable — and the suite stayed green
  // because the fake answered `1`, a code real git never returns here. A
  // fixture that encodes semantics git does not have is a suite measuring
  // nothing; `test/spec-source.test.ts` now pins these codes against the
  // real binary so the fake cannot drift from it again.
  //
  // `ls-tree` separates the three answers without an exit code doing the
  // work: it exits 0 whether or not the path is there, prints the object's
  // TYPE when it is, and prints nothing when it is not. Anything non-zero
  // is the reader failing. `%(objecttype)` also answers the second half —
  // a directory is a `tree`, and `git show <sha>:<dir>` is a listing, not
  // a spec.
  //
  // **`--full-tree`, because a pathspec is resolved against the PROCESS's
  // cwd and that is `root`, not the work tree top.** When `root` is a
  // subdirectory of the toplevel — which the containment logic above
  // exists to support — a root-relative `path` matches nothing from
  // there, and `ls-tree` says so by exiting **0 with empty output**: the
  // same bytes as "the ref has not got it". Measured from `lib/` against
  // `README.md`: empty without the flag, `blob` with it. Round 5 of this
  // review, in the arm round 4 had just added.
  const atRef = opts.git(["ls-tree", "-z", "--full-tree", "--format=%(objecttype)", sha, "--", `:(literal)${path}`]);
  if (!atRef.ok) {
    return {
      kind: "unmeasured",
      why:
        `\`git ls-tree\` failed in ${opts.root} with exit ${atRef.code}: ` +
        `${redactCredentials(atRef.stderr.trim()) || "no reason given"}. That is a broken reader, not a spec the ` +
        `ref has not got, and the difference is the whole of this module.`,
    };
  }
  const objectType = atRef.stdout.replace(/\0/g, "").trim();
  if (objectType !== "" && objectType !== "blob") {
    return {
      kind: "unmeasured",
      why:
        `${path} is a \`${objectType}\` in ${ref} (${sha}), not a file. A spec is a file; \`git show\` would hand ` +
        `back a directory listing and this would print it as the spec's text.`,
    };
  }
  if (objectType === "") {
    // NOT AT THE REF — and now the LOCAL index is the right thing to ask,
    // because the two cases it separates are both about this checkout: a
    // spec added on this branch and not yet shipped, versus a file git has
    // never heard of. Only the second may be read from disk.
    const rel = opts.git(["ls-files", "--error-unmatch", "--", opts.absPath]);
    if (!rel.ok && rel.code !== 1) {
      return {
        kind: "unmeasured",
        why:
          `\`git ls-files\` failed in ${opts.root} with exit ${rel.code}: ` +
          `${redactCredentials(rel.stderr.trim()) || "no reason given"}. That is a broken reader, not an untracked ` +
          `file, and the difference is the whole of this module.`,
      };
    }
    if (rel.ok) {
      return {
        kind: "unmeasured",
        why:
          `${path} is tracked here but ${ref} (${sha}) has no version of it. That is a spec added on this branch ` +
          `and not yet shipped, which is a different fact from a spec whose criteria are unplaced — reading the ` +
          `working tree here would print the second while the first is true.`,
      };
    }
    return {
      kind: "untracked",
      path: opts.absPath,
      why:
        `neither ${ref} (${sha}) nor git in ${opts.root} has any version of ${opts.absPath}, so the file on disk ` +
        `is the only copy that exists. The reading below was taken against it.`,
    };
  }

  const shown = opts.git(["show", `${sha}:${path}`]);
  if (!shown.ok) {
    return {
      kind: "unmeasured",
      why:
        `${ref} (${sha}) has ${path} and \`git show\` could not produce it: ` +
        `${redactCredentials(shown.stderr.trim()) || "no reason given"}. Two calls disagreeing about one object is a ` +
        `broken reader, and reading the working tree here would print a reading scoped by whatever branch this is.`,
    };
  }

  // The working-tree comparison is a `diff` against the index-and-disk copy,
  // not a re-read of the file: `git diff` already knows about CRLF
  // normalisation and filters, and a byte compare here would call a checkout
  // difference a content difference on a tree configured for either.
  //
  // **AND IT IS READ AS THREE OUTCOMES, not as `!ok`.** `--quiet` exits 0
  // for same and 1 for differs; anything else is the comparison failing,
  // and `!ok` printed that as "your working tree's copy DIFFERS from it" —
  // a measured fact nobody measured. Review of #1896 round 3. This is the
  // last of the four sites where one boolean stood over a tri-state; the
  // type change that stops a fifth site arriving is filed separately.
  //
  // **`:(top,literal)` — the same blob the `show` above read, addressed
  // the same way.** This is the one call that cannot use `<rev>:<path>`
  // syntax, so it is the one whose pathspec the process's cwd can move,
  // and a pathspec matching nothing does not error: `--quiet` exits 0, so
  // the failure would be "your copy matches" about a comparison that
  // never ran. `:(top)` is `git diff`'s `--full-tree`.
  //
  // Round 7 reported the previous spelling — an absolute `absPath` — as
  // that failure. **It does not reproduce:** measured from a nested cwd,
  // the absolute pathspec, the `/private` realpath of it, and
  // `:(top,literal)` all return exit 1 against an edited tree. This change
  // ships as hardening, not as a fix, and carries no battery row claiming
  // it binds. What it does buy is one path expression across all three
  // calls instead of two.
  const differs = opts.git(["diff", "--quiet", sha, "--", `:(top,literal)${path}`]);
  const worktreeDiffers =
    differs.code === 0 ? false : differs.code === 1 ? true : null;

  return {
    kind: "ref",
    ref,
    sha,
    path,
    content: shown.stdout,
    staleness,
    worktreeDiffers,
    worktreeCompareFailed:
      worktreeDiffers === null
        ? `\`git diff --quiet\` exited ${differs.code}: ${redactCredentials(differs.stderr.trim()) || "no reason given"}`
        : null,
  };
}

/**
 * One line naming where the content came from, for stderr.
 *
 * Always emitted, never only on the interesting arm. A provenance line that
 * appears when something is odd and vanishes when it is not teaches the reader
 * that silence means `origin/main`, and silence is also what a build printing
 * nothing looks like.
 */
export function describeSpecSource(source: SpecSource): string {
  if (source.kind === "untracked") return `spec read from the working tree — ${source.why}`;
  if (source.kind === "unmeasured") return `spec UNMEASURED — ${source.why}`;
  const notes = [
    source.worktreeDiffers === true ? "your working tree's copy DIFFERS from it" : null,
    source.worktreeDiffers === null
      ? `whether your working tree's copy differs is UNMEASURED — ${source.worktreeCompareFailed}`
      : null,
    source.staleness,
  ].filter((s): s is string => s !== null);
  return (
    `spec read from ${source.ref} at ${source.sha.slice(0, 8)} (${source.path})` +
    (notes.length > 0 ? ` — ${notes.join("; ")}` : "")
  );
}
