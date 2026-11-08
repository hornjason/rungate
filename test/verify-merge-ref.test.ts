/**
 * #1850 — a merged pull request's ref silently accepts a later push.
 *
 * #1847 was armed for auto-merge against the head read at that moment. A
 * second commit was pushed while CI ran, auto-merge fired on the FIRST
 * commit, and the second push landed on a ref that had already merged.
 * `gh pr view` said `MERGED`, `commits` listed one SHA, and `git ls-remote`
 * showed the branch two commits ahead of what main received. Nothing
 * reported it; #1848 recovered the work by hand.
 *
 * Two halves, because they fail differently:
 *
 * - `mergeRefReading` is pure, so every reading is a CASE rather than a
 *   scenario, and the set can be asserted exhaustively.
 * - the script is spawned for real against a planted `gh` and a real local
 *   remote, because a correct decider wired to nothing is the failure this
 *   repository keeps finding in its own tooling.
 *
 * Every negative case runs twice — the real script and a mutant whose
 * `REFUSE_EXIT` is `0`. The second assertion is the point: the removal of
 * the non-zero exit, performed and observed, so a case that later passes
 * for an unrelated reason is no longer indistinguishable from one genuinely
 * caught (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import {
  REFUSE_EXIT,
  exitFor,
  mergeRefReading,
  remoteRepoReading,
  type Mode,
  type Reading,
} from "../scripts/verify-merge-ref";

const REPO = resolve(import.meta.dir, "..");
const SCRIPT = join(REPO, "scripts", "verify-merge-ref.ts");
const SOURCE = readFileSync(SCRIPT, "utf-8");

const OPEN_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LATER = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MERGE = "cccccccccccccccccccccccccccccccccccccccc";

/**
 * Round 2 of review on #1909, and correct: a `git ls-remote` that FAILED
 * and a `git ls-remote` that found no ref both produced `remoteHead:
 * undefined`, so on a MERGED pull request a network blip reported the
 * confident `MERGED_CLEAN` — "nothing to arm" — about a remote nobody read.
 * That is the #1847 shape reported as safe, in the one branch where this
 * script exists to say otherwise, and the file's own comment two functions
 * up says a reading that could not be taken is never a pass.
 *
 * Measured: against a real bare repository `git ls-remote <r> refs/heads/nope`
 * exits **0** with empty output; against an unreachable one it exits **128**.
 * The distinction was always there and the script discarded it.
 *
 * `remoteRead` is therefore required in spirit — absent means "nobody said
 * the remote was read", which fails closed. Every case below states it.
 */
describe("a remote that could not be read is never a pass (#1909 round 2)", () => {
  const READ_FAILED = { remoteRead: false, remoteHead: undefined };

  // The row that was wrong. It must not be MERGED_CLEAN.
  test("MERGED and the remote could not be read is UNMEASURED, not MERGED_CLEAN", () => {
    const v = mergeRefReading({ prState: "MERGED", prHead: OPEN_HEAD, mergeCommit: MERGE, ...READ_FAILED });
    expect(v.reading).toBe("UNMEASURED");
    expect(v.detail, "the refusal does not say the remote is what went unread").toMatch(/remote|ls-remote/i);
  });

  test("OPEN and the remote could not be read is UNMEASURED", () => {
    expect(mergeRefReading({ prState: "OPEN", prHead: OPEN_HEAD, ...READ_FAILED }).reading).toBe("UNMEASURED");
  });

  // The control that gives the row above something to be distinguished FROM.
  // A branch deleted after a merge is a fact, not a failure to read one, and
  // conflating them in the other direction would make every tidy-up noisy.
  test("MERGED with the ref genuinely absent is still MERGED_CLEAN", () => {
    expect(
      mergeRefReading({ prState: "MERGED", prHead: OPEN_HEAD, mergeCommit: MERGE, remoteRead: true, remoteHead: undefined }).reading,
    ).toBe("MERGED_CLEAN");
  });

  // Fail closed. An input that does not say whether the remote was read has
  // not said it was, and the safe default is the one that refuses.
  test("an input that never mentions remoteRead is UNMEASURED", () => {
    expect(
      mergeRefReading({ prState: "MERGED", prHead: OPEN_HEAD, mergeCommit: MERGE, remoteHead: LATER }).reading,
    ).toBe("UNMEASURED");
  });
});

describe("mergeRefReading: the one decider (#1850)", () => {
  test("OPEN and the remote holds exactly the reported head is CLEAR", () => {
    expect(
      mergeRefReading({ remoteRead: true, prState: "OPEN", prHead: OPEN_HEAD, remoteHead: OPEN_HEAD, branch: "rg/x" }).reading,
    ).toBe("CLEAR");
  });

  test("OPEN and the remote has moved past it is STALE_HEAD, naming both", () => {
    const v = mergeRefReading({ remoteRead: true, prState: "OPEN", prHead: OPEN_HEAD, remoteHead: LATER, branch: "rg/x" });
    expect(v.reading).toBe("STALE_HEAD");
    expect(v.detail, "the refusal does not name the head the API reported").toContain(OPEN_HEAD);
    expect(v.detail, "the refusal does not name what the remote actually holds").toContain(LATER);
  });

  // The #1847 case itself.
  test("MERGED with the branch carrying a later commit is PUSHED_AFTER_MERGE", () => {
    const v = mergeRefReading({
      remoteRead: true, prState: "MERGED", prHead: OPEN_HEAD, remoteHead: LATER, mergeCommit: MERGE, branch: "rg/x",
    });
    expect(v.reading).toBe("PUSHED_AFTER_MERGE");
    expect(v.detail).toContain(LATER);
    expect(v.detail, "the refusal does not say what DID merge").toContain(MERGE);
  });

  test("MERGED with the branch holding nothing beyond it is MERGED_CLEAN", () => {
    expect(
      mergeRefReading({ remoteRead: true, prState: "MERGED", prHead: OPEN_HEAD, remoteHead: OPEN_HEAD, mergeCommit: MERGE }).reading,
    ).toBe("MERGED_CLEAN");
  });

  test("MERGED with the branch deleted is MERGED_CLEAN", () => {
    expect(
      mergeRefReading({ remoteRead: true, prState: "MERGED", prHead: OPEN_HEAD, remoteHead: undefined, mergeCommit: MERGE }).reading,
    ).toBe("MERGED_CLEAN");
  });

  // A reading that could not be taken is never a pass. Three ways it fails.
  const UNREADABLE: [string, Parameters<typeof mergeRefReading>[0]][] = [
    ["the branch has no ref on the remote", { prState: "OPEN", prHead: OPEN_HEAD, remoteHead: undefined }],
    ["the API reported no state", { prHead: OPEN_HEAD, remoteHead: OPEN_HEAD }],
    ["the API reported no head", { prState: "OPEN", remoteHead: OPEN_HEAD }],
  ];
  for (const [why, input] of UNREADABLE) {
    test(`UNMEASURED when ${why}`, () => {
      expect(mergeRefReading(input).reading).toBe("UNMEASURED");
    });
  }

  test("a CLOSED pull request is not quietly treated as open", () => {
    expect(
      mergeRefReading({ remoteRead: true, prState: "CLOSED", prHead: OPEN_HEAD, remoteHead: LATER }).reading,
    ).not.toBe("CLEAR");
  });

  /**
   * The control for the whole describe. A decider that returns `CLEAR` for
   * everything satisfies the first case and nothing else would say so — that
   * is literally the state this file was written against. Exactly one of the
   * inputs above may be CLEAR, and only CLEAR may carry an empty detail.
   */
  test("exactly one input reads CLEAR, and only CLEAR has no detail", () => {
    const inputs: Parameters<typeof mergeRefReading>[0][] = [
      { remoteRead: true, prState: "OPEN", prHead: OPEN_HEAD, remoteHead: OPEN_HEAD },
      { remoteRead: true, prState: "OPEN", prHead: OPEN_HEAD, remoteHead: LATER },
      { remoteRead: true, prState: "MERGED", prHead: OPEN_HEAD, remoteHead: LATER, mergeCommit: MERGE },
      { remoteRead: true, prState: "MERGED", prHead: OPEN_HEAD, remoteHead: OPEN_HEAD, mergeCommit: MERGE },
      { remoteRead: true, prState: "CLOSED", prHead: OPEN_HEAD, remoteHead: LATER },
      { remoteRead: true, prState: "OPEN", prHead: OPEN_HEAD },
      {},
    ];
    const verdicts = inputs.map(i => mergeRefReading(i));
    expect(
      verdicts.filter(v => v.reading === "CLEAR").length,
      `readings: ${verdicts.map(v => v.reading).join(", ")}`,
    ).toBe(1);
    for (const v of verdicts) {
      if (v.reading === "CLEAR") expect(v.detail).toBe("");
      else expect(v.detail.length, `${v.reading} refuses with no explanation`).toBeGreaterThan(0);
    }
  });
});

/**
 * Round 1 of review on #1909. `git ls-remote` reads whatever `origin`
 * resolves to in the process's working directory, and nothing tied that to
 * the repository the pull request came from. Run from a tree whose remote
 * points somewhere else and `remoteHead` is populated from the wrong source,
 * so the decider returns a confident `CLEAR` — or a confident
 * `PUSHED_AFTER_MERGE` — about a comparison it never made.
 *
 * Demonstrated before the fix: a fresh repository with
 * `origin = https://github.com/some/other-repo.git` answers
 * `git ls-remote --get-url origin` with that URL, and the script compared
 * against it without a word.
 *
 * Same shape `.claude/rules/parallel-sessions.md` already documents for
 * `check-launch-base.ts` and `report-provenance.ts --expect-branch`, both
 * added because a script measuring the wrong tree produced a confident
 * wrong verdict rather than an UNMEASURED one.
 */
/**
 * Round 3 of review on #1909, and correct: `MERGED_CLEAN` and
 * `PUSHED_AFTER_MERGE` both exited 1, so the post-merge run — the one the
 * rule file calls the one that matters — could not tell "nothing was
 * dropped" from "#1847 just happened" without parsing stderr for a string.
 *
 * The table below is the whole of `exitFor`, and it is written as a table
 * because the thing worth proving is that the two modes DISAGREE. A flag
 * that answers every reading the same way is decorative, and the last case
 * here is the one that would catch that.
 */
describe("the two runs exit on different answers (#1909 round 3)", () => {
  const READINGS: Reading[] = ["CLEAR", "STALE_HEAD", "PUSHED_AFTER_MERGE", "MERGED_CLEAN", "UNMEASURED"];

  const EXPECTED: Record<Mode, Reading> = { arming: "CLEAR", "after-merge": "MERGED_CLEAN" };

  for (const mode of Object.keys(EXPECTED) as Mode[]) {
    for (const reading of READINGS) {
      const zero = reading === EXPECTED[mode];
      test(`${mode}: ${reading} exits ${zero ? 0 : REFUSE_EXIT}`, () => {
        expect(exitFor(reading, mode)).toBe(zero ? 0 : REFUSE_EXIT);
      });
    }
  }

  test("the modes disagree — otherwise the flag decides nothing", () => {
    const disagree = READINGS.filter((r) => exitFor(r, "arming") !== exitFor(r, "after-merge"));
    expect(
      disagree.sort(),
      "`--after-merge` answered every reading exactly as arming does, so the flag is a no-op and " +
        "every case above passes without the mode mattering",
    ).toEqual(["CLEAR", "MERGED_CLEAN"]);
  });

  test("#1847 refuses in BOTH modes — it is never a good answer", () => {
    expect(exitFor("PUSHED_AFTER_MERGE", "arming")).toBe(REFUSE_EXIT);
    expect(exitFor("PUSHED_AFTER_MERGE", "after-merge")).toBe(REFUSE_EXIT);
  });
});

describe("the remote is tied to the pull request's repository (#1909 review)", () => {
  const MINE = "hornjason/rungate";

  const SAME = [
    "https://github.com/hornjason/rungate.git",
    "https://github.com/hornjason/rungate",
    "git@github.com:hornjason/rungate.git",
    "ssh://git@github.com/hornjason/rungate.git",
    "https://x-access-token:TOKEN@github.com/hornjason/rungate.git",
    // The repository was renamed from pai-harness on 2026-10-28 and a
    // long-lived checkout may still carry the old URL. GitHub redirects it,
    // so refusing it would refuse a working remote; case is GitHub's own.
    "https://github.com/HornJason/RunGate.git",
    // A local mirror laid out as owner/name. The comparison is the last two
    // path segments, which is what makes one rule cover https, ssh, scp-style
    // and a path — and what lets this file point `--remote` at a real bare
    // repository instead of stubbing `git ls-remote`, which would be a second
    // decider agreeing with the first.
    "/tmp/x/hornjason/rungate.git",
    // Review of #1909 round 5, and correct. The docstring said the comparison
    // is case-insensitive; the suffix strip was `/\.git\/*$/` with no `i`, and
    // `.toLowerCase()` ran afterwards on the already-sliced segments. So an
    // uppercase suffix survived the strip, became part of the final segment,
    // and `hornjason/rungate.git` never equals `hornjason/rungate` — the right
    // remote refused as somebody else's. Reproduced before fixing.
    "https://github.com/hornjason/RunGate.GIT",
    "git@github.com:HornJason/RunGate.Git",
  ];
  for (const url of SAME) {
    test(`the same repository: ${url}`, () => {
      expect(remoteRepoReading(url, MINE).ok, `refused a remote that IS the PR's repository`).toBe(true);
    });
  }

  const DIFFERENT = [
    ["another repository", "https://github.com/some/other-repo.git"],
    ["another owner, same name", "https://github.com/someoneelse/rungate.git"],
    ["an ordinary working path", "/Users/x/Projects/rg-wt-1850"],
    ["an empty url", ""],
  ];
  for (const [why, url] of DIFFERENT) {
    test(`UNMEASURED on ${why}`, () => {
      const r = remoteRepoReading(url, MINE);
      expect(r.ok, `accepted ${url} as ${MINE}`).toBe(false);
      expect(r.detail, "the refusal does not name what the remote actually is").toContain(url || "(empty)");
      expect(r.detail, "the refusal does not name the repository it expected").toContain(MINE);
    });
  }

  // The control. If the expected repository cannot be read, a comparison
  // against it is not a pass — this is the shape that turns "I could not
  // look" into "nothing is wrong".
  test("an unknown expected repository is UNMEASURED, not a free pass", () => {
    expect(remoteRepoReading("https://github.com/hornjason/rungate.git", "").ok).toBe(false);
  });

  /**
   * KNOWN LIMITATION, asserted rather than described — #1911.
   *
   * Review of #1909 round 6: identity is host AND path, and `tail()` reads
   * one axis, so a mirror or a GHE instance laying out `owner/name` the same
   * way passes as "the same repository". Every row above holds the host
   * fixed, which is the battery shape `.claude/rules/checks-must-be-able-to
   * -fail.md` names last — one axis varied while the defect sits on the
   * other — so the existing table could not have found this.
   *
   * It is a green assertion over defective behaviour and is NOT coverage.
   * Its job is to go RED the day somebody closes #1911, so the docstring's
   * scope sentence cannot quietly stop being true.
   */
  test("KNOWN LIMITATION (#1911): a different host passes — the host is not read", () => {
    const elsewhere = remoteRepoReading("https://mirror.example.com/hornjason/rungate.git", MINE);
    expect(
      elsewhere.ok,
      "a differing host is now refused — #1911 is closed, so delete this case and move the row " +
        "into DIFFERENT, and rewrite the scope paragraph in `remoteRepoReading`'s docstring",
    ).toBe(true);
  });
});

// ── the script, spawned for real ────────────────────────────

let dir = "";
let mutant = "";
let remote = "";
let elsewhere = "";

/**
 * A `gh` on PATH answering `pr view` from a literal JSON payload.
 *
 * The repository fields default to the fixture remotes' owner/name, because
 * every case here is about the HEAD comparison and would otherwise be
 * stopped one step earlier by the repository guard — which is a different
 * reading and would make each of them green for the wrong reason. The case
 * that IS about the guard overrides the remote, not the payload.
 */
function plantGh(at: string, payload: Record<string, unknown>): string {
  const bin = join(at, "bin");
  mkdirSync(bin, { recursive: true });
  const file = join(bin, "gh");
  const full = {
    headRepositoryOwner: { login: "hornjason" },
    headRepository: { name: "rungate" },
    ...payload,
  };
  writeFileSync(file, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(full)}\nJSON\n`);
  chmodSync(file, 0o755);
  return bin;
}

function runScript(path: string, ghBin: string, args: string[]) {
  const r = Bun.spawnSync(["bun", path, ...args], {
    cwd: REPO,
    env: { ...process.env, PATH: `${ghBin}:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: r.exitCode,
    out: new TextDecoder().decode(r.stdout).trim(),
    err: new TextDecoder().decode(r.stderr).trim(),
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rg-mergeref-"));

  // A real bare repository to be the remote, so `git ls-remote` is the real
  // command reading a real ref rather than a stub agreeing with the script.
  // Laid out as owner/name, because the script now refuses a remote that is
  // not the pull request's repository and the comparison is the last two
  // path segments. `elsewhere` is the same repository under a path that
  // says it is somebody else's.
  remote = join(dir, "hornjason", "rungate.git");
  elsewhere = join(dir, "someoneelse", "other-repo.git");
  const work = join(dir, "work");
  mkdirSync(join(dir, "hornjason"), { recursive: true });
  mkdirSync(join(dir, "someoneelse"), { recursive: true });
  mkdirSync(work, { recursive: true });
  const git = (cwd: string, ...a: string[]) =>
    Bun.spawnSync(["git", "-C", cwd, ...a], { stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "init", "--bare", "-q", remote], { stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "init", "--bare", "-q", elsewhere], { stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "init", "-q", "-b", "main", work], { stdout: "pipe", stderr: "pipe" });
  // Spelled out rather than routed through `git()` above. #84's scanner reads
  // the argv literally and cannot see that the helper inserts `-C`, so a
  // helper call here is indistinguishable from a write to the real checkout's
  // identity — which is the thing that check exists to refuse.
  Bun.spawnSync(["git", "-C", work, "config", "user.email", "t@example.com"], { stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "-C", work, "config", "user.name", "t"], { stdout: "pipe", stderr: "pipe" });
  writeFileSync(join(work, "a.txt"), "one\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "one");
  git(work, "checkout", "-qb", "rg/planted");
  writeFileSync(join(work, "a.txt"), "two\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "two");
  git(work, "push", "-q", remote, "rg/planted");
  git(work, "push", "-q", elsewhere, "rg/planted");

  // The mutant. Guarded, because a mutant that fails to build or fails to
  // load reports zero failures and reads exactly like a case that passed.
  const decl = "export const REFUSE_EXIT = 1;";
  const hits = SOURCE.split(decl).length - 1;
  if (hits !== 1) throw new Error(`could not build the mutant: the exit constant appears ${hits} times, not once`);
  const literal = [...SOURCE.matchAll(/process\.exit\(\s*[1-9]/g)];
  if (literal.length > 0) {
    throw new Error(`could not build the mutant: ${literal.length} refusal(s) exit with a literal code`);
  }
  const relative = [...SOURCE.matchAll(/from\s+["']\.{1,2}\//g)];
  if (relative.length > 0) {
    throw new Error(
      `could not build the mutant: ${relative.length} relative import(s) — it would die on module ` +
        `resolution from a temp directory, which reads as a refusal on the merits`,
    );
  }
  mutant = join(dir, "mutant", "verify-merge-ref.ts");
  mkdirSync(dirname(mutant), { recursive: true });
  writeFileSync(mutant, SOURCE.replace(decl, "export const REFUSE_EXIT = 0;"));
});

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("the script refuses, and the refusal is what each case observed", () => {
  /** Both halves of a negative case: the real script and the mutant. */
  function bothHalves(ghBin: string, args: string[]) {
    const real = runScript(SCRIPT, ghBin, args);
    const mut = runScript(mutant, ghBin, args);
    expect(real.code, `the real script did not refuse:\n${real.err}`).toBe(REFUSE_EXIT);
    expect(
      mut.code,
      "the mutant refused too, so the case did not observe the exit constant — it passed for some other reason",
    ).toBe(0);
    return real;
  }

  function plantedHead(): string {
    const r = Bun.spawnSync(["git", "ls-remote", remote, "refs/heads/rg/planted"], { stdout: "pipe", stderr: "pipe" });
    return new TextDecoder().decode(r.stdout).trim().split(/\s+/)[0];
  }

  // The control, first. Every case below reads as a refusal when the script
  // cannot run at all, and this is the row that says the wiring works: real
  // remote, matching head, SHA on stdout, exit zero.
  test("CLEAR: the head matches the remote, and the SHA is printed", () => {
    const head = plantedHead();
    expect(head, "the fixture remote has no rg/planted ref").toMatch(/^[0-9a-f]{40}$/);
    const gh = plantGh(join(dir, "clear"), {
      state: "OPEN", headRefName: "rg/planted", headRefOid: head, mergeCommit: null,
    });
    const r = runScript(SCRIPT, gh, ["--pr", "1", "--remote", remote]);
    expect(r.code, `a matching head did not clear:\n${r.err}`).toBe(0);
    expect(r.out, "the cleared SHA is not on stdout, so the && idiom has nothing to pin").toBe(head);
  });

  test("STALE_HEAD: the API's head lags the remote", () => {
    const gh = plantGh(join(dir, "stale"), {
      state: "OPEN", headRefName: "rg/planted", headRefOid: OPEN_HEAD, mergeCommit: null,
    });
    const r = bothHalves(gh, ["--pr", "1", "--remote", remote]);
    expect(r.err).toContain("STALE_HEAD");
    expect(r.err, "the refusal does not name the head the API reported").toContain(OPEN_HEAD);
    expect(r.err, "the refusal does not name what the remote holds").toContain(plantedHead());
  });

  // #1847, end to end.
  test("PUSHED_AFTER_MERGE: merged, and the branch has moved since", () => {
    const gh = plantGh(join(dir, "after"), {
      state: "MERGED", headRefName: "rg/planted", headRefOid: OPEN_HEAD, mergeCommit: { oid: MERGE },
    });
    const r = bothHalves(gh, ["--pr", "1", "--remote", remote]);
    expect(r.err).toContain("PUSHED_AFTER_MERGE");
    expect(r.err).toContain(plantedHead());
    expect(r.err, "the refusal does not say what DID merge").toContain(MERGE);
  });

  test("MERGED_CLEAN refuses too — there is nothing to arm", () => {
    const head = plantedHead();
    const gh = plantGh(join(dir, "clean"), {
      state: "MERGED", headRefName: "rg/planted", headRefOid: head, mergeCommit: { oid: MERGE },
    });
    const r = bothHalves(gh, ["--pr", "1", "--remote", remote]);
    expect(r.err).toContain("MERGED_CLEAN");
    expect(r.out, "a merged pull request handed a SHA to the arming command").toBe("");
  });

  // The post-merge run, end to end. `--after-merge` is only worth adding if
  // the two modes behave differently against the SAME planted state, so the
  // first two cases plant one fixture each and run it in both modes.
  test("--after-merge: MERGED_CLEAN exits 0 and prints the merge commit", () => {
    const head = plantedHead();
    const gh = plantGh(join(dir, "aftermerge-clean"), {
      state: "MERGED", headRefName: "rg/planted", headRefOid: head, mergeCommit: { oid: MERGE },
    });
    const r = runScript(SCRIPT, gh, ["--pr", "1", "--remote", remote, "--after-merge"]);
    expect(r.code, `the post-merge run refused a clean merge:\n${r.err}`).toBe(0);
    expect(r.out, "exit zero with nothing on stdout — the shape this file refuses").toBe(MERGE);
    // Same fixture, no flag: still a refusal. Without this the case above
    // would pass just as well against a script that always exits 0.
    const armed = runScript(SCRIPT, gh, ["--pr", "1", "--remote", remote]);
    expect(armed.code, "arming cleared a merged pull request").toBe(REFUSE_EXIT);
  });

  test("--after-merge: PUSHED_AFTER_MERGE still refuses — that is #1847", () => {
    const gh = plantGh(join(dir, "aftermerge-pushed"), {
      state: "MERGED", headRefName: "rg/planted", headRefOid: OPEN_HEAD, mergeCommit: { oid: MERGE },
    });
    const r = bothHalves(gh, ["--pr", "1", "--remote", remote, "--after-merge"]);
    expect(r.err).toContain("PUSHED_AFTER_MERGE");
    expect(r.out, "a dropped-work reading printed a SHA, which reads as success").toBe("");
  });

  test("--after-merge: an OPEN pull request refuses — nothing merged", () => {
    const head = plantedHead();
    const gh = plantGh(join(dir, "aftermerge-open"), {
      state: "OPEN", headRefName: "rg/planted", headRefOid: head, mergeCommit: null,
    });
    const r = bothHalves(gh, ["--pr", "1", "--remote", remote, "--after-merge"]);
    // Not `toContain("CLEAR")`: measured against a decider mutated to ignore
    // the mode, that assertion stayed green on a DIFFERENT refusal whose
    // message happens to quote the reading back. Assert the sentence only
    // this situation can produce.
    expect(r.err, "the refusal does not say the pull request has not merged").toContain("has not merged");
  });

  test("--after-merge: MERGED_CLEAN with no recorded merge commit refuses", () => {
    const head = plantedHead();
    const gh = plantGh(join(dir, "aftermerge-nocommit"), {
      state: "MERGED", headRefName: "rg/planted", headRefOid: head, mergeCommit: null,
    });
    const r = bothHalves(gh, ["--pr", "1", "--remote", remote, "--after-merge"]);
    expect(r.err).toContain("UNMEASURED");
    expect(r.out, "exit zero with an empty stdout is how a caller reads a reading nobody took").toBe("");
  });

  /**
   * Review of #1909 round 7, and correct: `run()` passed no `timeout`, so a
   * stalled host-key prompt or a `gh` waiting on an auth flow produced no
   * reading at all — not even `UNMEASURED` — and wedged the merge pipeline
   * this script gates with no diagnostic.
   *
   * The fixture is a `gh` that sleeps far longer than the suite would
   * tolerate, with the timeout lowered by env var. Without the `timeout`
   * option this case does not fail, it HANGS, so the elapsed-time assertion
   * is the one that distinguishes "killed and reported" from "answered
   * quickly for some other reason".
   */
  test("UNMEASURED: a subprocess that never answers is killed and reported", () => {
    const bin = join(dir, "hangs", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), "#!/bin/sh\nsleep 120\n");
    chmodSync(join(bin, "gh"), 0o755);

    const began = Date.now();
    const real = Bun.spawnSync(["bun", SCRIPT, "--pr", "1", "--remote", remote], {
      cwd: REPO,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNGATE_REMOTE_TIMEOUT_MS: "1500" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const elapsed = Date.now() - began;
    const err = new TextDecoder().decode(real.stderr);

    expect(real.exitCode, `a hung subprocess did not refuse:\n${err}`).toBe(REFUSE_EXIT);
    // 20s sits between a real run (~2s here, slower in CI) and the 120s
    // sleep. Measured against the source with the `timeout` option removed,
    // this read 120,211ms — the hang, not a slow machine.
    expect(elapsed, "the script waited out the hang rather than killing it").toBeLessThan(20_000);
    expect(err, "the refusal does not say the subprocess was killed").toContain("was killed after");
    expect(err, "the refusal does not name the env var that raises the bound").toContain(
      "RUNGATE_REMOTE_TIMEOUT_MS",
    );

    // The mutant half, run only now that the real script is known to return:
    // with REFUSE_EXIT at 0 this must exit 0, or the case observed something
    // other than the refusal.
    const mut = Bun.spawnSync(["bun", mutant, "--pr", "1", "--remote", remote], {
      cwd: REPO,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNGATE_REMOTE_TIMEOUT_MS: "1500" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(mut.exitCode, "the mutant refused too — the case did not observe the exit constant").toBe(0);
    // Explicit, and well above both spawns: bun's default per-test bound is
    // 5s and the real run lands near it on a loaded CI box, so the default
    // would make this case report a hang that is only a slow machine.
  }, 90_000);

  test("UNMEASURED: the branch has no ref on the remote", () => {
    const gh = plantGh(join(dir, "noref"), {
      state: "OPEN", headRefName: "rg/never-pushed", headRefOid: OPEN_HEAD, mergeCommit: null,
    });
    const r = bothHalves(gh, ["--pr", "1", "--remote", remote]);
    expect(r.err).toContain("UNMEASURED");
  });

  test("UNMEASURED: gh returned something that is not JSON", () => {
    const bin = join(dir, "junk", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), "#!/bin/sh\necho 'not json'\n");
    chmodSync(join(bin, "gh"), 0o755);
    const r = bothHalves(bin, ["--pr", "1", "--remote", remote]);
    expect(r.err).toContain("UNMEASURED");
  });

  // The wiring half of the review finding. A correct predicate the script
  // never consults is the defect this repository keeps finding in its own
  // tooling, and nothing above would notice: every other case here uses a
  // `--remote` that happens to be the right one.
  test("UNMEASURED: the remote is not the pull request's repository", () => {
    const head = plantedHead();
    const gh = plantGh(join(dir, "wrongremote"), {
      state: "OPEN",
      headRefName: "rg/planted",
      headRefOid: head,
      mergeCommit: null,
      headRepositoryOwner: { login: "hornjason" },
      headRepository: { name: "rungate" },
    });
    // `elsewhere` holds the SAME branch at the SAME commit, so every other
    // reading in this file would clear against it. Only the repository the
    // path names is different, which is the one variable under test.
    const r = bothHalves(gh, ["--pr", "1", "--remote", elsewhere]);
    expect(r.err).toContain("UNMEASURED");
    expect(r.err, "the refusal does not name the repository the API reported").toContain("hornjason/rungate");
  });

  // The wiring half of round 2's finding. `remoteRead: ls.ok` is one word
  // in `main()` and nothing above would notice it going away: every other
  // case here hands the script a remote it can reach. This one names a path
  // whose last two segments ARE the repository — so the guard above clears
  // it — and which does not exist, so the branch read exits 128.
  test("UNMEASURED: the remote resolves but cannot be read", () => {
    const gone = join(dir, "gone", "hornjason", "rungate.git");
    const gh = plantGh(join(dir, "unreachable"), {
      state: "MERGED", headRefName: "rg/planted", headRefOid: OPEN_HEAD, mergeCommit: { oid: MERGE },
    });
    const r = bothHalves(gh, ["--pr", "1", "--remote", gone]);
    expect(r.err, "an unreadable remote on a MERGED pull request still read as MERGED_CLEAN").toContain("UNMEASURED");
    expect(r.err).not.toContain("MERGED_CLEAN");
  });

  test("no --pr is a refusal, not a default", () => {
    const gh = plantGh(join(dir, "noargs"), { state: "OPEN" });
    bothHalves(gh, ["--remote", remote]);
  });
});

describe("the properties the mutant depends on are asserted, not assumed", () => {
  test("REFUSE_EXIT is declared exactly once", () => {
    expect(SOURCE.split("export const REFUSE_EXIT = 1;").length - 1).toBe(1);
  });

  test("no refusal bypasses the constant with a literal exit code", () => {
    expect([...SOURCE.matchAll(/process\.exit\(\s*[1-9]/g)].map(m => m[0])).toEqual([]);
  });

  test("the script has no relative imports", () => {
    expect([...SOURCE.matchAll(/from\s+["']\.{1,2}\/[^"']*/g)].map(m => m[0])).toEqual([]);
  });

  // Every reading the type declares is reachable from some input. A member
  // nothing can produce is a branch nothing tests, and the union is the only
  // place it would be visible.
  test("every declared reading is produced by some input", () => {
    const declared = [...SOURCE.matchAll(/^\s*\|?\s*"(CLEAR|STALE_HEAD|PUSHED_AFTER_MERGE|MERGED_CLEAN|UNMEASURED)"/gm)]
      .map(m => m[1]);
    const produced = new Set<Reading>([
      mergeRefReading({ remoteRead: true, prState: "OPEN", prHead: OPEN_HEAD, remoteHead: OPEN_HEAD }).reading,
      mergeRefReading({ remoteRead: true, prState: "OPEN", prHead: OPEN_HEAD, remoteHead: LATER }).reading,
      mergeRefReading({ remoteRead: true, prState: "MERGED", prHead: OPEN_HEAD, remoteHead: LATER, mergeCommit: MERGE }).reading,
      mergeRefReading({ remoteRead: true, prState: "MERGED", prHead: OPEN_HEAD, remoteHead: OPEN_HEAD, mergeCommit: MERGE }).reading,
      mergeRefReading({}).reading,
    ]);
    expect(declared.length, "the reading union was not found in the source").toBeGreaterThan(0);
    expect([...new Set(declared)].filter(d => !produced.has(d as Reading))).toEqual([]);
  });
});
