#!/usr/bin/env bun
/**
 * Does a pull request's branch still hold exactly what the pull request says?
 *
 * #1850. #1847 was armed for auto-merge against the head read at that
 * moment. While its CI ran, a second commit was pushed to the same branch.
 * Auto-merge fired on the FIRST commit, squashed it and closed the pull
 * request, and the second push landed on a ref that had already merged.
 * `gh pr view` reported `MERGED`, `commits` listed one SHA, and
 * `git ls-remote` showed the branch two commits ahead of what main received.
 * The work was recovered by hand (#1848) only because somebody happened to
 * read the disagreement. Nothing reported it.
 *
 * ## Why `--match-head-commit` does not cover this
 *
 * It refuses a merge whose head moved since the flag's VALUE WAS READ — and
 * the value is read at arm time while auto-merge fires later. A push arriving
 * between arming and firing is exactly the window the flag leaves open, and a
 * push arriving after firing has no merge left to refuse.
 *
 * ## What this does NOT do, said first
 *
 * **A read taken before arming cannot see a push that arrives after it.**
 * Raised in review of #1909 and correct: run before `gh pr merge --auto`,
 * this closes nothing that `--match-head-commit` leaves open, because its
 * read happens at the same moment the flag's does. Nothing short of the
 * forge enforcing the expected head at FIRE time can close that window.
 *
 * What it actually buys is two readings at two moments:
 *
 * - **before arming** — `STALE_HEAD`, the branch already moved while you
 *   were reading it. Narrow, and real.
 * - **after merging** — `PUSHED_AFTER_MERGE`, which is #1847 itself. This
 *   is the one that matters. The commits were never lost because they were
 *   unrecoverable; they were lost because for days nobody asked.
 *
 * So run it twice, and the second run is not optional:
 *
 * ```bash
 * SHA="$(bun scripts/verify-merge-ref.ts --pr 1850)" \
 *   && gh pr merge 1850 --squash --auto --match-head-commit "$SHA"
 * gh pr checks 1850 --watch
 * bun scripts/verify-merge-ref.ts --pr 1850 --after-merge
 * ```
 *
 * **The `--watch` line is load-bearing** — review of #1909 round 4, and
 * correct. `--auto` only ARMS; the merge fires minutes later when CI
 * finishes, so without it the third line runs against a pull request that is
 * still OPEN and re-reads the arming question. It is a bound, not a fence:
 * auto-merge fires seconds after the last check, not at the same instant. If
 * the third line still reads `CLEAR`, the refusal says *the pull request has
 * not merged* in those words, which is the signal to run it again rather
 * than a reading to act on. An arming answer to the post-merge question is
 * never silently accepted.
 *
 * Dropping `--auto` and merging by hand once CI is green removes the
 * arm-to-fire window outright, and is the right call when you are watching.
 * It costs a human waiting on a five-minute pipeline, which is why this
 * project arms instead — a trade, named rather than hidden.
 *
 * ## The two runs ask different questions, so they exit on different answers
 *
 * Raised in review of #1909 round 3, and correct. Arming wants a SHA to pin,
 * so `CLEAR` is its only zero. After the merge the question is *did anything
 * get dropped*, whose one good answer is `MERGED_CLEAN` — and with both
 * collapsed into exit 1, the run this file exists for could not tell "fine"
 * from "#1847 happened" without parsing stderr. `--after-merge` selects the
 * second question; `exitFor` is the one place either is answered.
 *
 * In both modes **stdout is a SHA or it is empty**: the head to pin when
 * arming, the merge commit to hand `verify-merge-content.ts` afterwards. Exit
 * zero never happens without one, so the `&&` above cannot hand
 * `--match-head-commit` an empty string in either mode. Every other reading
 * refuses, and a reading that could not be taken is `UNMEASURED` and refuses
 * with the rest; it is not a pass.
 *
 * Every refusal exits through `REFUSE_EXIT`, declared exactly once, so
 * `test/verify-merge-ref.test.ts` can build a mutant copy with it set to `0`
 * and prove each negative case observed the refusal rather than passing for
 * an unrelated reason. This file has no relative imports, so that mutant
 * cannot die on module resolution and read as a refusal on the merits
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 */

export const REFUSE_EXIT = 1;

export type Reading =
  /** The branch holds exactly the head the pull request reports. Armable. */
  | "CLEAR"
  /** The remote has moved past the head the API reported. */
  | "STALE_HEAD"
  /** Merged, and the branch carries commits the merge never saw. */
  | "PUSHED_AFTER_MERGE"
  /** Merged, and the branch holds nothing beyond it. Nothing to arm. */
  | "MERGED_CLEAN"
  /** A reading that could not be taken. Never a pass. */
  | "UNMEASURED";

export interface RefInputs {
  /** `state` from the API: OPEN, MERGED, CLOSED — or absent. */
  prState?: string;
  /** `headRefOid` from the API. */
  prHead?: string;
  /**
   * Did `git ls-remote` succeed? Absent means nobody said so, and that
   * fails closed.
   *
   * Raised in review of #1909 round 2. Without this, a command that FAILED
   * and a command that found no ref both arrive as `remoteHead: undefined`,
   * and on a MERGED pull request the second is the benign case — so a
   * network blip reported `MERGED_CLEAN`, "nothing to arm", about a remote
   * nobody read. That is #1847's own shape reported as safe, in the one
   * branch this script exists to speak up in.
   *
   * The distinction was always available: against a real remote
   * `git ls-remote <r> refs/heads/nope` exits 0 with empty output, and
   * against an unreachable one it exits 128.
   */
  remoteRead?: boolean;
  /** What `git ls-remote` reports for the branch, absent when the ref is gone. */
  remoteHead?: string;
  /** `mergeCommit.oid`, present only once the pull request merged. */
  mergeCommit?: string;
  /** The branch name, for the message. */
  branch?: string;
}

/** Which of the two questions is being asked. See the docblock. */
export type Mode = "arming" | "after-merge";

/**
 * The one place a reading becomes an exit code.
 *
 * Kept out of `main` so the two modes can be shown to DISAGREE rather than
 * asserted to: a flag both modes answer identically is decorative, and
 * `test/verify-merge-ref.test.ts` walks every reading against both.
 */
export function exitFor(reading: Reading, mode: Mode): number {
  const good: Reading = mode === "after-merge" ? "MERGED_CLEAN" : "CLEAR";
  return reading === good ? 0 : REFUSE_EXIT;
}

export interface RefVerdict {
  reading: Reading;
  /** Why, naming both SHAs. Empty only on CLEAR. */
  detail: string;
}

/**
 * The one decider. Pure, so every reading is a case rather than a scenario.
 */
export function mergeRefReading(input: RefInputs): RefVerdict {
  const { prState, prHead, remoteHead, mergeCommit } = input;
  const where = input.branch ? `\`${input.branch}\`` : "the branch";

  // UNMEASURED first, and it refuses. Everything below compares two SHAs,
  // and comparing a SHA against nothing reads as agreement — `undefined ===
  // undefined` is the shape that turns "I could not look" into "nothing is
  // wrong". Only a MERGED pull request may have no remote ref, because a
  // deleted branch is a fact rather than a failure to read one.
  if (!prState || !prHead) {
    return {
      reading: "UNMEASURED",
      detail:
        "the API reported no " +
        (!prState ? "state" : "head") +
        " for this pull request, so nothing was compared. That is not the same as a pull request that is fine.",
    };
  }
  // Before any comparison, and before the merged/open split: did the read
  // happen at all? This sits here rather than inside either branch because
  // the branch that most needs it — MERGED — is the one whose benign
  // reading an unread remote is indistinguishable from.
  if (input.remoteRead !== true) {
    return {
      reading: "UNMEASURED",
      detail:
        `\`git ls-remote\` did not succeed for ${where}, so nothing was read from the remote. ` +
        `An unreachable remote is not an empty one: a branch still carrying commits past the merge ` +
        `looks exactly like a branch that was tidied up, and only one of those is fine.`,
    };
  }

  const merged = prState === "MERGED";
  if (!remoteHead && !merged) {
    return {
      reading: "UNMEASURED",
      detail: `\`git ls-remote\` found no ref for ${where}, so the pull request's head ${prHead} was compared against nothing.`,
    };
  }

  if (merged) {
    // The #1847 shape. The commits on the remote are real bytes on no path
    // to main, and they are indistinguishable from merged work until
    // somebody diffs the trees — which is what this is instead of.
    if (remoteHead && remoteHead !== prHead) {
      return {
        reading: "PUSHED_AFTER_MERGE",
        detail:
          `${where} is at ${remoteHead}, the pull request merged ${prHead} as ${mergeCommit ?? "an unrecorded commit"}, ` +
          `and nothing between them reached main. Recover with \`git cherry-pick\` onto current main (#1848 is the worked instance), ` +
          `then confirm with \`bun scripts/verify-merge-content.ts\`.`,
      };
    }
    return {
      reading: "MERGED_CLEAN",
      detail:
        `the pull request merged as ${mergeCommit ?? "an unrecorded commit"} and ${where} holds nothing beyond it. ` +
        `There is nothing to arm — refused rather than cleared so the arming command is never handed a stale SHA.`,
    };
  }

  if (prState !== "OPEN") {
    return {
      reading: "UNMEASURED",
      detail: `the pull request is ${prState}, which is neither OPEN nor MERGED. Nothing here knows what that means, and guessing is how #1847 happened.`,
    };
  }

  if (remoteHead !== prHead) {
    // `--match-head-commit` would catch this one IF the value were read now.
    // It is read at arm time and auto-merge fires later, so the comparison
    // has to happen against the remote rather than against a cached reply.
    return {
      reading: "STALE_HEAD",
      detail:
        `the API reports head ${prHead} but ${where} is at ${remoteHead}. Arming against ${prHead} merges a commit the ` +
        `branch has already moved past. Re-read the head, or push nothing further until this merges.`,
    };
  }

  return { reading: "CLEAR", detail: "" };
}

/**
 * Does the remote this process is about to read carry the pull request's
 * `owner/name`? **It does not check the host, and that gap is open.**
 *
 * ## The scope, before the mechanism
 *
 * Review of #1909 round 6, and correct: an internal mirror or a GHE instance
 * laying out `owner/name` the same way passes here as "the same repository".
 * Identity is host AND path; this reads one axis. The reason is not an
 * oversight to be read past — `gh pr view` answers
 * `headRepositoryOwner.login` and `headRepository.name` and no host at all,
 * so a host comparison needs a second source for the expected side, and the
 * local bare repository this file's own fixture points `--remote` at has no
 * host to offer. Closing it is a redesign of both sides, which is #1911, not
 * a seventh guard in front of the same comparison.
 *
 * `test/verify-merge-ref.test.ts` asserts the gap rather than describing it:
 * a differing-host row is in the table as a KNOWN LIMITATION and goes red
 * when somebody closes it, which is the only form of this sentence that
 * cannot quietly stop being true.
 *
 * Raised in review of #1909. `git ls-remote` queries whatever `origin`
 * resolves to in the working directory, and nothing tied that to the
 * repository `gh pr view` answered from. Run from a tree whose remote points
 * somewhere else and the comparison below is made against the wrong source,
 * confidently. That is the same failure shape `.claude/rules/parallel-
 * sessions.md` documents for `check-launch-base.ts` and
 * `report-provenance.ts --expect-branch`, both added because a script
 * measuring the wrong tree produced a wrong verdict rather than an
 * UNMEASURED one.
 *
 * The comparison is the last two path segments, case-insensitively, with any
 * `.git` suffix dropped. One rule covers `https://`, `ssh://`, scp-style
 * `git@host:owner/name`, a credential-bearing URL, and a local mirror laid
 * out as `owner/name` — and an ordinary working path such as
 * `/Users/x/Projects/rg-wt-1850` does not match, which is the case that
 * motivated this. GitHub's own names are case-insensitive and the repository
 * was renamed once, so refusing on case would refuse a working remote.
 */
export function remoteRepoReading(url: string, expected: string): { ok: boolean; detail: string } {
  const tail = (s: string) =>
    s
      // `i`, because the sentence above promises case-insensitivity and
      // `.toLowerCase()` runs AFTER the slice — so without it an uppercase
      // `.GIT` survives into the final segment and the right remote is
      // refused as somebody else's (review of #1909 round 5).
      .replace(/\.git\/*$/i, "")
      .split(/[/:]/)
      .filter(Boolean)
      .slice(-2)
      .join("/")
      .toLowerCase();
  const got = url ? tail(url) : "";
  const want = expected ? tail(expected) : "";
  if (!want) {
    return {
      ok: false,
      detail: `the API did not say which repository this pull request belongs to, so the remote \`${url || "(empty)"}\` was compared against nothing.`,
    };
  }
  if (!got || got !== want || got.split("/").length !== 2) {
    return {
      ok: false,
      detail:
        `the remote resolves to \`${url || "(empty)"}\`, which is not \`${expected}\` — the repository the pull request is in. ` +
        `Nothing was compared. Pass \`--remote\` naming the right one, or run from a checkout of \`${expected}\`.`,
    };
  }
  return { ok: true, detail: "" };
}

// ── the I/O half ────────────────────────────────────────────

function run(cmd: string[]): { out: string; ok: boolean } {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { out: new TextDecoder().decode(r.stdout).trim(), ok: r.exitCode === 0 };
}

function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export function main(argv: string[]): number {
  const pr = arg("pr", argv);
  if (!pr) {
    console.error("usage: verify-merge-ref.ts --pr <N> [--after-merge] [--repo owner/name] [--remote <name|path>]");
    return REFUSE_EXIT;
  }
  const repo = arg("repo", argv);
  const remote = arg("remote", argv) ?? "origin";
  const mode: Mode = argv.includes("--after-merge") ? "after-merge" : "arming";

  const view = run([
    "gh", "pr", "view", pr,
    ...(repo ? ["--repo", repo] : []),
    "--json", "state,headRefName,headRefOid,mergeCommit,headRepository,headRepositoryOwner",
  ]);
  if (!view.ok || view.out === "") {
    console.error(`UNMEASURED: \`gh pr view ${pr}\` produced nothing. The pull request was not read, which is not the same as a pull request that is fine.`);
    return REFUSE_EXIT;
  }

  let pj: {
    state?: string;
    headRefName?: string;
    headRefOid?: string;
    mergeCommit?: { oid?: string };
    headRepository?: { name?: string };
    headRepositoryOwner?: { login?: string };
  };
  try {
    pj = JSON.parse(view.out);
  } catch {
    console.error(`UNMEASURED: \`gh pr view ${pr}\` returned something that is not JSON.`);
    return REFUSE_EXIT;
  }

  // Before reading the remote, establish it IS the pull request's remote.
  // Otherwise every comparison below is made confidently against the wrong
  // source — review of #1909.
  const owner = pj.headRepositoryOwner?.login;
  const name = pj.headRepository?.name;
  const expected = owner && name ? `${owner}/${name}` : "";
  const url = run(["git", "ls-remote", "--get-url", remote]);
  const sameRepo = remoteRepoReading(url.ok ? url.out : "", expected);
  if (!sameRepo.ok) {
    console.error(`UNMEASURED: ${sameRepo.detail}`);
    return REFUSE_EXIT;
  }

  const branch = pj.headRefName;
  // An absent branch name makes the ls-remote below match EVERY ref, and a
  // wrong SHA compared confidently is worse than no comparison at all.
  const ls = branch ? run(["git", "ls-remote", remote, `refs/heads/${branch}`]) : { out: "", ok: false };
  // `ok` and `out` carry different facts and both travel. Exit 0 with no
  // output is a ref that is not there; a non-zero exit is a remote that was
  // not read. Collapsing them into one `undefined` is what round 2 of
  // #1909's review found.
  const remoteHead = ls.ok && ls.out !== "" ? ls.out.split(/\s+/)[0] : undefined;

  const verdict = mergeRefReading({
    prState: pj.state,
    prHead: pj.headRefOid,
    remoteRead: ls.ok,
    remoteHead,
    mergeCommit: pj.mergeCommit?.oid,
    branch,
  });

  if (exitFor(verdict.reading, mode) !== 0) {
    // `CLEAR` carries no detail — it is the good answer to the OTHER
    // question — so a bare `CLEAR:` is all a post-merge run would print.
    const why =
      verdict.detail ||
      `the pull request has not merged: \`${branch ?? "the branch"}\` is armable, which is not what ` +
        `\`--after-merge\` asks. Merge it first, or drop the flag.`;
    console.error(`${verdict.reading}: ${why}`);
    return REFUSE_EXIT;
  }
  // Exit zero never happens without a SHA on stdout. Arming prints the head
  // to pin; after a merge it prints the commit to hand `verify-merge-content
  // .ts --merged`. A MERGED pull request the API gave no merge commit for is
  // the one way this can be empty, and an empty success is the shape the
  // whole file refuses.
  const sha = mode === "after-merge" ? pj.mergeCommit?.oid : pj.headRefOid;
  if (!sha) {
    console.error(
      `UNMEASURED: the pull request reads ${verdict.reading}, but the API recorded no ` +
        `${mode === "after-merge" ? "merge commit" : "head"} to print. Exiting zero with nothing on stdout ` +
        `is how a caller reads "fine" off a reading nobody took.`,
    );
    return REFUSE_EXIT;
  }
  console.log(sha);
  return 0;
}

if (import.meta.main) process.exit(main(Bun.argv.slice(2)));
