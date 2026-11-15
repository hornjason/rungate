/**
 * `rungate intake` — #2248.
 *
 * The command runs the registered intake sources and prints each one's
 * reading. It is advisory: an unreadable source prints UNMEASURED with the
 * producer's own reason and exits 0, because #2233 and #2234 run it where a
 * red run would block work that has nothing to do with intake. A bad
 * argument is the only refusal.
 *
 * What these cases hold fixed, and what they vary: the repository and the
 * run store are built per case in a scratch directory, so the readings are
 * of fixtures, never of this machine's `~/.rungate` or this clone's depth.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EXIT_REFUSED, main } from "../scripts/intake";
import { NO_RUN_STORE, SOURCE_UNAVAILABLE } from "../lib/intake-sources";
import { SHALLOW_HISTORY } from "../lib/failure-intake";

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true });
});
const tmp = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `rg-intake-cmd-${tag}-`));
  scratch.push(d);
  return d;
};

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/** A repository with one ordinary commit and one conventional fix commit. */
function repoWithFix(): string {
  const dir = tmp("repo");
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "add a");
  writeFileSync(join(dir, "a.txt"), "two\n");
  git(dir, "commit", "-q", "-am", "fix(#9): a reader of a.txt refuses an empty file");
  return dir;
}

/** Run the command in-process, capturing what it prints. */
function run(argv: string[], workStore: string): { code: number; out: string } {
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (x: unknown) => void lines.push(String(x));
  console.error = (x: unknown) => void lines.push(String(x));
  let code: number;
  try {
    code = main(argv, { workStore });
  } finally {
    console.log = log;
    console.error = err;
  }
  return { code, out: lines.join("\n") };
}

describe("#2248: rungate intake prints each source's reading", () => {
  test("a full clone with a fix commit: fix-commits is MEASURED and counts it", () => {
    const repo = repoWithFix();
    const got = run(["--project-root", repo, "--source", "fix-commits"], tmp("store"));
    expect(got.out).toContain("fix-commits: MEASURED");
    expect(got.out).toContain("1 candidate");
    expect(got.out).not.toContain("UNMEASURED");
    expect(got.code).toBe(0);
  });

  test("a shallow clone: fix-commits is UNMEASURED naming SHALLOW_HISTORY, and exits 0", () => {
    const origin = repoWithFix();
    const parent = tmp("shallow");
    git(parent, "clone", "-q", "--depth", "1", `file://${origin}`, "clone");
    const got = run(["--project-root", join(parent, "clone"), "--source", "fix-commits"], tmp("store"));
    expect(got.out).toContain("fix-commits: UNMEASURED");
    expect(got.out).toContain(SHALLOW_HISTORY);
    // The partial count is never printed as the reading.
    expect(got.out).not.toContain("fix-commits: MEASURED");
    expect(got.code).toBe(0);
  });

  test("no run store: gate-refusals is UNMEASURED naming the source as unavailable", () => {
    const got = run(["--project-root", repoWithFix(), "--source", "gate-refusals"], join(tmp("none"), "absent"));
    expect(got.out).toContain("gate-refusals: UNMEASURED");
    expect(got.out).toContain(SOURCE_UNAVAILABLE);
    expect(got.code).toBe(0);
  });

  test("an empty run store: gate-refusals is UNMEASURED naming NO_RUN_STORE", () => {
    const store = tmp("empty-store");
    mkdirSync(join(store, "some-project"), { recursive: true });
    const got = run(["--project-root", repoWithFix(), "--source", "gate-refusals"], store);
    expect(got.out).toContain("gate-refusals: UNMEASURED");
    expect(got.out).toContain(NO_RUN_STORE);
    expect(got.code).toBe(0);
  });

  test("with no --source, every registered source is read and the aggregate is stated", () => {
    const got = run(["--project-root", repoWithFix()], join(tmp("none"), "absent"));
    expect(got.out).toContain("fix-commits: MEASURED");
    expect(got.out).toContain("gate-refusals: UNMEASURED");
    // One source unreadable makes the whole reading UNMEASURED, never a
    // completed reading by the sources that happened to work.
    expect(got.out).toContain("intake: UNMEASURED");
    expect(got.code).toBe(0);
  });

  test("--json prints the aggregate reading, with candidates only on a measured one", () => {
    const got = run(["--project-root", repoWithFix(), "--source", "fix-commits", "--json"], tmp("store"));
    const json = JSON.parse(got.out);
    expect(json.reading).toBe("MEASURED");
    expect(json.candidates).toHaveLength(1);
    expect(json.bySource["fix-commits"].reading).toBe("MEASURED");
  });
});

describe("#2248: a bad argument is the only refusal", () => {
  test("an unknown source is refused by name, listing the sources that exist", () => {
    const got = run(["--source", "nope"], tmp("store"));
    expect(got.code).toBe(EXIT_REFUSED);
    expect(got.out).toContain('"nope"');
    expect(got.out).toContain("fix-commits");
    expect(got.out).toContain("gate-refusals");
  });

  test("an unknown flag, and a flag missing its value, are refused", () => {
    expect(run(["--nope"], tmp("store")).code).toBe(EXIT_REFUSED);
    expect(run(["--source"], tmp("store")).code).toBe(EXIT_REFUSED);
    expect(run(["--project-root"], tmp("store")).code).toBe(EXIT_REFUSED);
  });

  test("the refusal exit is not the advisory exit", () => {
    // Without this, every refusal case above passes against a command that
    // exits EXIT_REFUSED unconditionally.
    expect(EXIT_REFUSED).not.toBe(0);
  });
});
