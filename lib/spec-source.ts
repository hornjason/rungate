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

import { resolve, sep } from "path";

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
       * True when the working tree's copy differs from `ref`'s.
       *
       * D4's half of this lives elsewhere; what this flag buys D3 is that the
       * provenance line can say "I read the shipped spec, and yours differs"
       * rather than leaving the reader to wonder which they got.
       */
      worktreeDiffers: boolean;
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

/** `origin/main` -> `origin main`, for the fetch that refreshes it. */
function fetchArgsFor(ref: string): string[] | null {
  const at = ref.indexOf("/");
  if (at <= 0 || at === ref.length - 1) return null;
  return ["fetch", "--quiet", ref.slice(0, at), ref.slice(at + 1)];
}

/**
 * Resolve the spec's content from `ref`, or say precisely why not.
 *
 * `absPath` is where the caller believes the spec is; `root` is the repository
 * it should be read relative to. Both are taken rather than derived, because
 * `board-snapshot` accepts an absolute spec path and deriving a root from it
 * would silently measure a different checkout.
 */
export function resolveSpecSource(opts: {
  root: string;
  absPath: string;
  ref?: string;
  git: GitRunner;
}): SpecSource {
  const ref = opts.ref ?? DEFAULT_SPEC_REF;

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
  if (!inRepo.ok || top === "") {
    return {
      kind: "untracked",
      path: opts.absPath,
      // THE EXIT AND THE REASON, quoted. 128 covers both "no repository
      // here" and a repository whose object store is broken, and no text
      // matcher should be the thing that tells them apart — so the arm
      // states what it saw and lets the reader judge.
      why:
        `${opts.root} is not inside a readable git work tree (exit ${inRepo.code}: ` +
        `${redactCredentials(inRepo.stderr.trim()) || "no reason given"}), so there is no ${ref} to read and the ` +
        `file on disk is the only copy reachable. The reading below was taken against it.`,
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
  const within = resolve(opts.absPath) === resolve(top) || resolve(opts.absPath).startsWith(resolve(top) + sep);
  if (!within) {
    return {
      kind: "untracked",
      path: opts.absPath,
      why:
        `${opts.absPath} is outside the work tree at ${top}, so ${ref} has no version of it. ` +
        `The reading below was taken against the file on disk.`,
    };
  }

  // IS IT TRACKED. Asked before the fetch, so an untracked fixture costs no
  // network at all — and so the untracked arm cannot be reached by a fetch
  // failure, which would make the two indistinguishable.
  //
  // **EXIT 1 AND NOTHING ELSE IS "untracked".** `--error-unmatch` exits 1
  // for a path git does not know and 128 for a broken object store or a
  // path outside the repository; treating both as untracked hands the
  // second one a working-tree read. Security review of round 1 found this,
  // and the battery had no row for it: every untracked case asserted on an
  // exit-1 shape, so no count could come back wrong about a 128.
  const rel = opts.git(["ls-files", "--full-name", "--error-unmatch", "--", opts.absPath]);
  const path = rel.stdout.trim();
  if (!rel.ok && rel.code !== 1) {
    return {
      kind: "unmeasured",
      why:
        `\`git ls-files\` failed in ${opts.root} with exit ${rel.code}: ` +
        `${redactCredentials(rel.stderr.trim()) || "no reason given"}. That is a broken reader, not an untracked ` +
        `file, and the difference is the whole of this module.`,
    };
  }
  if (!rel.ok || path === "") {
    return {
      kind: "untracked",
      path: opts.absPath,
      why:
        `git in ${opts.root} does not track ${opts.absPath}, so ${ref} has no version of it to read. ` +
        `The reading below was taken against the file on disk.`,
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
    return {
      kind: "unmeasured",
      why:
        `${ref} does not resolve in ${opts.root}: ${redactCredentials(resolved.stderr.trim()) || "no reason given"}. ` +
        `Falling back to the working tree would report a reading scoped by whatever branch this is.`,
    };
  }

  const shown = opts.git(["show", `${sha}:${path}`]);
  if (!shown.ok) {
    return {
      kind: "unmeasured",
      why:
        `${path} is tracked but ${ref} (${sha}) has no version of it: ` +
        `${redactCredentials(shown.stderr.trim()) || "no reason given"}. That is a spec added on this branch and not yet ` +
        `shipped, which is a different fact from a spec whose criteria are unplaced — reading the working ` +
        `tree here would print the second while the first is true.`,
    };
  }

  // The working-tree comparison is a `diff` against the index-and-disk copy,
  // not a re-read of the file: `git diff` already knows about CRLF
  // normalisation and filters, and a byte compare here would call a checkout
  // difference a content difference on a tree configured for either.
  const differs = opts.git(["diff", "--quiet", sha, "--", path]);

  return {
    kind: "ref",
    ref,
    sha,
    path,
    content: shown.stdout,
    staleness,
    worktreeDiffers: !differs.ok,
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
    source.worktreeDiffers ? "your working tree's copy DIFFERS from it" : null,
    source.staleness,
  ].filter((s): s is string => s !== null);
  return (
    `spec read from ${source.ref} at ${source.sha.slice(0, 8)} (${source.path})` +
    (notes.length > 0 ? ` — ${notes.join("; ")}` : "")
  );
}
