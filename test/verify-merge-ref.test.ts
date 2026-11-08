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
import { REFUSE_EXIT, mergeRefReading, type Reading } from "../scripts/verify-merge-ref";

const REPO = resolve(import.meta.dir, "..");
const SCRIPT = join(REPO, "scripts", "verify-merge-ref.ts");
const SOURCE = readFileSync(SCRIPT, "utf-8");

const OPEN_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LATER = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MERGE = "cccccccccccccccccccccccccccccccccccccccc";

describe("mergeRefReading: the one decider (#1850)", () => {
  test("OPEN and the remote holds exactly the reported head is CLEAR", () => {
    expect(
      mergeRefReading({ prState: "OPEN", prHead: OPEN_HEAD, remoteHead: OPEN_HEAD, branch: "rg/x" }).reading,
    ).toBe("CLEAR");
  });

  test("OPEN and the remote has moved past it is STALE_HEAD, naming both", () => {
    const v = mergeRefReading({ prState: "OPEN", prHead: OPEN_HEAD, remoteHead: LATER, branch: "rg/x" });
    expect(v.reading).toBe("STALE_HEAD");
    expect(v.detail, "the refusal does not name the head the API reported").toContain(OPEN_HEAD);
    expect(v.detail, "the refusal does not name what the remote actually holds").toContain(LATER);
  });

  // The #1847 case itself.
  test("MERGED with the branch carrying a later commit is PUSHED_AFTER_MERGE", () => {
    const v = mergeRefReading({
      prState: "MERGED", prHead: OPEN_HEAD, remoteHead: LATER, mergeCommit: MERGE, branch: "rg/x",
    });
    expect(v.reading).toBe("PUSHED_AFTER_MERGE");
    expect(v.detail).toContain(LATER);
    expect(v.detail, "the refusal does not say what DID merge").toContain(MERGE);
  });

  test("MERGED with the branch holding nothing beyond it is MERGED_CLEAN", () => {
    expect(
      mergeRefReading({ prState: "MERGED", prHead: OPEN_HEAD, remoteHead: OPEN_HEAD, mergeCommit: MERGE }).reading,
    ).toBe("MERGED_CLEAN");
  });

  test("MERGED with the branch deleted is MERGED_CLEAN", () => {
    expect(
      mergeRefReading({ prState: "MERGED", prHead: OPEN_HEAD, remoteHead: undefined, mergeCommit: MERGE }).reading,
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
      mergeRefReading({ prState: "CLOSED", prHead: OPEN_HEAD, remoteHead: LATER }).reading,
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
      { prState: "OPEN", prHead: OPEN_HEAD, remoteHead: OPEN_HEAD },
      { prState: "OPEN", prHead: OPEN_HEAD, remoteHead: LATER },
      { prState: "MERGED", prHead: OPEN_HEAD, remoteHead: LATER, mergeCommit: MERGE },
      { prState: "MERGED", prHead: OPEN_HEAD, remoteHead: OPEN_HEAD, mergeCommit: MERGE },
      { prState: "CLOSED", prHead: OPEN_HEAD, remoteHead: LATER },
      { prState: "OPEN", prHead: OPEN_HEAD },
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

// ── the script, spawned for real ────────────────────────────

let dir = "";
let mutant = "";
let remote = "";

/** A `gh` on PATH answering `pr view` from a literal JSON payload. */
function plantGh(at: string, payload: unknown): string {
  const bin = join(at, "bin");
  mkdirSync(bin, { recursive: true });
  const file = join(bin, "gh");
  writeFileSync(file, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(payload)}\nJSON\n`);
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
  remote = join(dir, "remote.git");
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });
  const git = (cwd: string, ...a: string[]) =>
    Bun.spawnSync(["git", "-C", cwd, ...a], { stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "init", "--bare", "-q", remote], { stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "init", "-q", "-b", "main", work], { stdout: "pipe", stderr: "pipe" });
  git(work, "config", "user.email", "t@example.com");
  git(work, "config", "user.name", "t");
  writeFileSync(join(work, "a.txt"), "one\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "one");
  git(work, "checkout", "-qb", "rg/planted");
  writeFileSync(join(work, "a.txt"), "two\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "two");
  git(work, "push", "-q", remote, "rg/planted");

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
      mergeRefReading({ prState: "OPEN", prHead: OPEN_HEAD, remoteHead: OPEN_HEAD }).reading,
      mergeRefReading({ prState: "OPEN", prHead: OPEN_HEAD, remoteHead: LATER }).reading,
      mergeRefReading({ prState: "MERGED", prHead: OPEN_HEAD, remoteHead: LATER, mergeCommit: MERGE }).reading,
      mergeRefReading({ prState: "MERGED", prHead: OPEN_HEAD, remoteHead: OPEN_HEAD, mergeCommit: MERGE }).reading,
      mergeRefReading({}).reading,
    ]);
    expect(declared.length, "the reading union was not found in the source").toBeGreaterThan(0);
    expect([...new Set(declared)].filter(d => !produced.has(d as Reading))).toEqual([]);
  });
});
