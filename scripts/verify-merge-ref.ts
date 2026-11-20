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

/**
 * The label that waives a pull request's AI review (#1571, CRC-F6).
 *
 * A literal rather than an import of `AI_REVIEW_OVERRIDE_LABEL`, because this
 * file stays import-free for its mutant; `test/verify-merge-ref.test.ts`
 * binds the two with an agreement assertion.
 */
export const WAIVED_REVIEW_LABEL = "ai-review-override";

export type Reading =
  /** The branch holds exactly the head the pull request reports. Armable. */
  | "CLEAR"
  /**
   * OPEN and labelled `WAIVED_REVIEW_LABEL`: nothing automated has read it, so
   * it is never armed. A person merges it by hand, pinned via `--by-hand`
   * (#1571, CRC-F6).
   */
  | "WAIVED_REVIEW"
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
  /**
   * The pull request's label names. `main` refuses a reply that carries no
   * label list at all, so absent here only ever means a pure caller that has
   * none to give (#1571).
   */
  labels?: string[];
}

/**
 * Which question is being asked. See the docblock. `by-hand` is arming's
 * question asked by a person who will merge without `--auto`: the one route
 * a waived review may take (#1571, CRC-F6).
 */
export type Mode = "arming" | "after-merge" | "by-hand";

/**
 * The one place a reading becomes an exit code.
 *
 * Kept out of `main` so the modes can be shown to DISAGREE rather than
 * asserted to: a flag every mode answers identically is decorative, and
 * `test/verify-merge-ref.test.ts` walks every reading against each.
 */
export function exitFor(reading: Reading, mode: Mode): number {
  const good: Reading[] =
    mode === "after-merge" ? ["MERGED_CLEAN"] : mode === "by-hand" ? ["CLEAR", "WAIVED_REVIEW"] : ["CLEAR"];
  return good.includes(reading) ? 0 : REFUSE_EXIT;
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

  // #1571 / CRC-F6: a waived review cannot reach main unread. The Actions
  // token cannot turn auto-merge off once it is on (live test, 2026-11-16), so
  // the refusal is here, at arming time. After a merge the question is what
  // landed, not who may land it, so only an OPEN pull request is asked. AFTER
  // the staleness comparison, so `--by-hand` is never handed a head the branch
  // has moved past (review, #2286).
  if ((input.labels ?? []).includes(WAIVED_REVIEW_LABEL)) {
    return {
      reading: "WAIVED_REVIEW",
      detail:
        `the pull request carries '${WAIVED_REVIEW_LABEL}': its AI review was waived, so nothing automated has read it, ` +
        `and auto-merge is never armed on it. A person reads the diff and merges by hand: ` +
        `\`--by-hand\` prints the head to pin with \`gh pr merge --squash --match-head-commit\` (no \`--auto\`).`,
    };
  }

  return { reading: "CLEAR", detail: "" };
}

/**
 * The host a pull request lives on, read off its own `url` (#1911).
 *
 * `gh pr view` answers the head repository as `owner` and `name` and no host
 * at all, so the URL is the expected side's only source for one. Three
 * answers, kept apart:
 *
 * - a host, lowercased and without its port — `github.com`, a GHE instance;
 * - `""`, a URL that parsed and has no host (`file:`). GitHub never returns
 *   one; the end-to-end fixture does, because its forge is the filesystem;
 * - `null`, no URL or one that does not parse. That is a host nobody READ,
 *   and `remoteRepoReading` refuses it rather than treating it as hostless.
 */
export function prHostReading(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Is the remote this process is about to read the pull request's repository,
 * on BOTH axes: the same `owner/name`, on the same host?
 *
 * ## The host axis (#1911)
 *
 * Review of #1909 round 6, and correct: identity is host AND path, and this
 * used to read only the path, so an internal mirror or a GHE instance laying
 * out `owner/name` the same way passed as "the same repository". `gh pr view`
 * answers `owner` and `name` and no host, so the expected host is read off
 * the pull request's own `url` (`prHostReading`); the remote's is parsed
 * from the URL git will contact (`remoteHostOf`). A host nobody read is
 * UNMEASURED, never a match.
 *
 * A local path has the empty host. It matches only a pull request whose URL
 * has no host either, which GitHub never returns — so in production a local
 * mirror is always refused, and the one place the two empties meet is
 * `test/verify-merge-ref.test.ts`'s fixture, whose forge is the filesystem.
 * That keeps the end-to-end cases on a real `git ls-remote` against a real
 * repository instead of a stub agreeing with this function.
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
export function remoteRepoReading(
  url: string,
  expected: string,
  expectedHost?: string | null,
): { ok: boolean; detail: string } {
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
  const hostRefusal = remoteHostMismatch(url, expected, expectedHost);
  return hostRefusal === null ? { ok: true, detail: "" } : { ok: false, detail: hostRefusal };
}

/**
 * The host axis (#1911): the refusal when the remote is not on the pull
 * request's host, or `null` when it is. Same `owner/name` on another host is
 * another repository — a mirror, a GHE instance, a local copy.
 *
 * Three refusals, each with its own wording. An unread or unparseable host
 * would ALSO fail the final comparison, so the wording is the only thing that
 * tells the branches apart, and the tests assert it.
 */
export function remoteHostMismatch(url: string, expected: string, expectedHost: string | null | undefined): string | null {
  if (expectedHost === null || expectedHost === undefined) {
    return (
      `the API gave no URL for this pull request, so the host it lives on was not read and the remote ` +
      `\`${url}\` was compared on its path alone. A host nobody read is not a host that matched.`
    );
  }
  const gotHost = remoteHostOf(url);
  if (gotHost === null) {
    return `the remote \`${url}\` has a host that does not parse, so it could not be compared with \`${hostLabel(expectedHost)}\`.`;
  }
  if (gotHost !== expectedHost) {
    return (
      `the remote \`${url}\` is on ${hostLabel(gotHost)}, but the pull request is on ${hostLabel(expectedHost)}. ` +
      `Same \`${expected}\` on another host is another repository. Nothing was compared. ` +
      `Pass \`--remote\` naming \`${expected}\` on ${hostLabel(expectedHost)}.`
    );
  }
  return null;
}

/** How a host is named in a refusal; the empty host is said, not left blank. */
function hostLabel(host: string): string {
  return host === "" ? "(no host — a local path)" : host;
}

/**
 * The host a remote URL names, in the three spellings git accepts (#1911):
 * `scheme://[user[:pass]@]host[:port]/path`, scp-style `[user@]host:path`
 * (a colon before the first slash), and a path, whose host is `""`. A
 * `file:` URL is a path. `null` is a URL that claims a host and does not
 * parse — refused by the caller, never read as hostless.
 *
 * The URL is the one `git ls-remote --get-url` printed, so `insteadOf`
 * rewrites are already applied: this reads the host git will actually
 * contact. An SSH host alias from `~/.ssh/config` is NOT resolved, so a
 * remote spelled with one reads as that alias and is refused; the refusal
 * says how to pass the canonical URL instead. That is the direction this is
 * allowed to be wrong in.
 */
function remoteHostOf(url: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      return u.protocol === "file:" ? "" : u.hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  // A drive letter (`C:/…`, `C:\…`) is a path, as git itself treats it —
  // otherwise the scp rule below reads `C` as a host (review of #2200).
  if (/^[a-z]:[\\/]/i.test(url)) return "";
  const scp = url.match(/^(?:[^@/:]+@)?([^/:]+):/);
  if (scp) return scp[1].toLowerCase();
  return "";
}

// ── the I/O half ────────────────────────────────────────────

/**
 * How long any one subprocess here may take before it is killed.
 *
 * Review of #1909 round 7, and correct. Every other failure in this file
 * becomes a `Reading`; a hang became nothing at all — not even `UNMEASURED` —
 * and this script gates an automated merge, so a stalled SSH host-key prompt
 * or a `gh` waiting on an auth flow wedged the pipeline with no diagnostic.
 *
 * 30s rather than the 10s `lib/filing-plan.ts` uses for local git: two of the
 * three calls here cross the network to the forge. Env-overridable the way
 * `scripts/board-conformance.ts` does it, so a slow link raises it without an
 * edit.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** The largest bound measured to behave. See `timeoutReading` for the table. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

export type TimeoutReading = { ok: true; ms: number } | { ok: false; detail: string };

/**
 * The bound, read rather than coerced — #1912, review of #1909 round 8.
 *
 * `Number(raw) || DEFAULT_TIMEOUT_MS` was the first spelling and it is this
 * repository's own named anti-pattern, *Silent Default Substitution*
 * (`.claude/rules/config-access.md`), in the one file whose whole argument is
 * that an unread value is never a quiet pass:
 *
 * - `"0"` coerces to `0`, which is **falsy**, so `||` handed back 30,000 —
 *   the operator asked to minimise the bound and silently got the maximum.
 * - `"soon"` coerces to `NaN`, also falsy, also 30,000.
 * - `"-1"` is truthy, so `-1` reached `Bun.spawnSync`'s `timeout` unexamined,
 *   while every other line here reasons about a positive bound.
 *
 * **Absent is the only case that silently takes the default.** Everything
 * else that cannot be used as a positive bound is refused by name, because
 * absent and wrong are different facts and `||` collapsed them. Refused
 * rather than clamped: clamping is the same substitution one step quieter,
 * and an operator who set `0` and got 30s learns nothing from one who set
 * `0` and got 1,000.
 *
 * A digits-only test rather than `Number`, which also accepts `" 12 "`,
 * `"0x10"`, `"1e3"` and `"Infinity"` — none of them a thing anybody meant to
 * type into a millisecond bound.
 *
 * ## The upper bound is a measurement, not a preference
 *
 * Raised in review of #1913, and the finding is right while the mechanism
 * offered for it is not. The claim was that anything above `setTimeout`'s
 * int32 ceiling wraps and fires immediately. Measured against
 * `Bun.spawnSync(["sleep","2"], { timeout: t })` on bun 1.3.14, what
 * actually happens is stranger and less predictable:
 *
 * | `timeout` | the `sleep 2` |
 * |---|---|
 * | `2**31 - 1` | ran its full 2s |
 * | `2**31`, `2**31 + 2` | **killed in ~2ms** |
 * | `2**31 + 1000`, `2.2e9`, `3e9`, `2**32 - 1` | ran its full 2s |
 * | `2**32`, `2**33`, `2**34`, `2**40` | **killed in ~2ms** |
 * | `Number.MAX_SAFE_INTEGER` | ran its full 2s |
 *
 * So it is not a wrap. It is a narrow window just above each power of two
 * from `2**31` up, reproducible across repeated runs, and there is no rule
 * an operator could apply to know which of their values is safe.
 *
 * `MAX_TIMEOUT_MS` is therefore `2**31 - 1`: the largest value measured to
 * behave. **It is deliberately conservative** — `3e9` works and is refused —
 * because the bound's job is to exclude what the platform mishandles, and a
 * cap drawn at the last reliable reading is defensible where one drawn
 * through the middle of an unexplained pattern is not. 24.8 days is already
 * far past anything this script has a use for; nobody loses a real case.
 */
export function timeoutReading(raw: string | undefined): TimeoutReading {
  if (raw === undefined) return { ok: true, ms: DEFAULT_TIMEOUT_MS };
  const trimmed = raw.trim();
  const refuse = (why: string): TimeoutReading => ({
    ok: false,
    detail:
      `RUNGATE_REMOTE_TIMEOUT_MS is \`${raw}\`, which ${why}. It must be a whole number of ` +
      `milliseconds from 1 to ${MAX_TIMEOUT_MS}, or unset to take the ${DEFAULT_TIMEOUT_MS}ms default. Refused rather ` +
      `than defaulted: a value you set and a value you did not are different facts.`,
  });
  if (trimmed === "") return refuse("is empty — set, and unusable");
  if (!/^[0-9]+$/.test(trimmed)) return refuse("is not a whole number of milliseconds");
  const ms = Number(trimmed);
  if (ms <= 0) return refuse("is not above zero");
  if (ms > MAX_TIMEOUT_MS) {
    return refuse(
      `is above ${MAX_TIMEOUT_MS}, the largest bound measured to behave — above it bun kills the ` +
        `subprocess in milliseconds for some values and honours it for others, with no rule saying which`,
    );
  }
  return { ok: true, ms };
}

function run(cmd: string[], timeoutMs: number): { out: string; ok: boolean; timedOut: boolean } {
  const r = Bun.spawnSync(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  // A killed process reports a signal and no exit code. That is a different
  // fact from a command that ran and failed, and the caller says so — "it
  // did not succeed" sends somebody looking for the wrong thing.
  const timedOut = r.exitCode === null || r.signalCode === "SIGKILL";
  return { out: new TextDecoder().decode(r.stdout).trim(), ok: r.exitCode === 0, timedOut };
}

/** The sentence a killed subprocess gets, so a hang is never a silent gap. */
function timeoutNote(what: string, ms: number): string {
  return (
    ` \`${what}\` was killed after ${ms}ms rather than answering — a stalled host-key ` +
    `prompt, an unreachable remote, or an auth flow waiting on a human. Raise ` +
    `RUNGATE_REMOTE_TIMEOUT_MS if the link is simply slow.`
  );
}

function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export function main(argv: string[]): number {
  const pr = arg("pr", argv);
  if (!pr) {
    console.error("usage: rungate verify-merge-ref --pr <N> [--after-merge | --by-hand] [--repo owner/name] [--remote <name|path>]");
    return REFUSE_EXIT;
  }
  if (argv.includes("--after-merge") && argv.includes("--by-hand")) {
    console.error("UNMEASURED: --after-merge and --by-hand ask different questions; pass one.");
    return REFUSE_EXIT;
  }
  // SC-2792 (ADR-023): `--repo`, then `GITHUB_REPOSITORY`, then the origin
  // remote, never a constant. The third is `gh`'s own inference from the
  // working directory, so with neither of the first two no `--repo` is
  // passed. An empty GITHUB_REPOSITORY names nothing, as in `rungate board`.
  const envRepo = process.env.GITHUB_REPOSITORY;
  const repo = arg("repo", argv) ?? (envRepo !== undefined && envRepo !== "" ? envRepo : undefined);
  const remote = arg("remote", argv) ?? "origin";

  // Before any subprocess, because the bound governs all three of them and a
  // value that cannot be used is not a value to run with — #1912.
  const bound = timeoutReading(process.env.RUNGATE_REMOTE_TIMEOUT_MS);
  if (!bound.ok) {
    console.error(`UNMEASURED: ${bound.detail}`);
    return REFUSE_EXIT;
  }
  const timeoutMs = bound.ms;
  const mode: Mode = argv.includes("--after-merge") ? "after-merge" : argv.includes("--by-hand") ? "by-hand" : "arming";

  const view = run([
    "gh", "pr", "view", pr,
    ...(repo ? ["--repo", repo] : []),
    "--json", "state,headRefName,headRefOid,mergeCommit,headRepository,headRepositoryOwner,url,labels",
  ], timeoutMs);
  if (!view.ok || view.out === "") {
    console.error(
      `UNMEASURED: \`gh pr view ${pr}\` produced nothing. The pull request was not read, which is not the same as a pull request that is fine.` +
        (view.timedOut ? timeoutNote(`gh pr view ${pr}`, timeoutMs) : ""),
    );
    return REFUSE_EXIT;
  }

  let pj: {
    state?: string;
    headRefName?: string;
    headRefOid?: string;
    mergeCommit?: { oid?: string };
    headRepository?: { name?: string };
    headRepositoryOwner?: { login?: string };
    url?: string | null;
    labels?: Array<{ name?: string }>;
  };
  try {
    pj = JSON.parse(view.out);
  } catch {
    console.error(`UNMEASURED: \`gh pr view ${pr}\` returned something that is not JSON.`);
    return REFUSE_EXIT;
  }
  // `gh` answers `[]` for a pull request with no labels. No list at all is a
  // reply nobody read for the one fact that decides whether a waived review
  // gets armed, so it refuses rather than reading as "not waived" (#1571).
  if (!Array.isArray(pj.labels)) {
    console.error(`UNMEASURED: \`gh pr view ${pr}\` returned no labels list, so whether its review was waived was not read.`);
    return REFUSE_EXIT;
  }
  const labels = pj.labels.map((l) => l?.name ?? "");

  // Before reading the remote, establish it IS the pull request's remote.
  // Otherwise every comparison below is made confidently against the wrong
  // source — review of #1909.
  const owner = pj.headRepositoryOwner?.login;
  const name = pj.headRepository?.name;
  const expected = owner && name ? `${owner}/${name}` : "";
  const url = run(["git", "ls-remote", "--get-url", remote], timeoutMs);
  const sameRepo = remoteRepoReading(url.ok ? url.out : "", expected, prHostReading(pj.url));
  if (!sameRepo.ok) {
    console.error(`UNMEASURED: ${sameRepo.detail}` + (url.timedOut ? timeoutNote("git ls-remote --get-url", timeoutMs) : ""));
    return REFUSE_EXIT;
  }

  const branch = pj.headRefName;
  // An absent branch name makes the ls-remote below match EVERY ref, and a
  // wrong SHA compared confidently is worse than no comparison at all.
  const ls = branch
    ? run(["git", "ls-remote", remote, `refs/heads/${branch}`], timeoutMs)
    : { out: "", ok: false, timedOut: false };
  // A kill is not an empty answer. The decider is told `remoteRead: false`
  // either way — it compares SHAs and has no use for the distinction — but
  // the operator reading stderr does, so it is said here rather than
  // threaded through `RefInputs` as a seventh field.
  if (ls.timedOut) console.error(`UNMEASURED:${timeoutNote(`git ls-remote ${remote}`, timeoutMs)}`);
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
    labels,
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
