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
 * # …and once it has merged, the reading that would have caught #1847:
 * bun scripts/verify-merge-ref.ts --pr 1850   # expect MERGED_CLEAN
 * ```
 *
 * Dropping `--auto` and merging by hand once CI is green removes the
 * arm-to-fire window outright, and is the right call when you are watching.
 * It costs a human waiting on a five-minute pipeline, which is why this
 * project arms instead — a trade, named rather than hidden.
 *
 * **Only `CLEAR` exits zero**, and only `CLEAR` writes a SHA to stdout. Every
 * other reading — including a merged pull request with nothing left to arm —
 * refuses, so the `&&` above can never hand `--match-head-commit` an empty
 * string. A reading that could not be taken is `UNMEASURED` and refuses with
 * the rest; it is not a pass.
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
  /** What `git ls-remote` reports for the branch, absent when the ref is gone. */
  remoteHead?: string;
  /** `mergeCommit.oid`, present only once the pull request merged. */
  mergeCommit?: string;
  /** The branch name, for the message. */
  branch?: string;
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
 * Is the remote this process is about to read the pull request's repository?
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
      .replace(/\.git\/*$/, "")
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
    console.error("usage: verify-merge-ref.ts --pr <N> [--repo owner/name] [--remote <name|path>]");
    return REFUSE_EXIT;
  }
  const repo = arg("repo", argv);
  const remote = arg("remote", argv) ?? "origin";

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
  const remoteHead = ls.ok && ls.out !== "" ? ls.out.split(/\s+/)[0] : undefined;

  const verdict = mergeRefReading({
    prState: pj.state,
    prHead: pj.headRefOid,
    remoteHead,
    mergeCommit: pj.mergeCommit?.oid,
    branch,
  });

  if (verdict.reading === "CLEAR") {
    console.log(pj.headRefOid);
    return 0;
  }
  console.error(`${verdict.reading}: ${verdict.detail}`);
  return REFUSE_EXIT;
}

if (import.meta.main) process.exit(main(Bun.argv.slice(2)));
