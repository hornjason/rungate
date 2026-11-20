/**
 * #1934 — the review's subject, chosen whole files at a time.
 *
 * The `review` job hands the agent the pull request's diff inside one
 * environment variable, so the diff is capped (`MAX_BYTES` in
 * `.github/workflows/claude-review.yml`). It used to be cut at a byte, and a
 * cut diff made the run UNMEASURED / DIFF_TRUNCATED. On a DA state-record pull
 * request that is permanent: #1932 changed 142 lines in 2 files and its diff
 * was 168 KB, because `project-state.json` keeps each entry on one line.
 *
 * Now the subject is the files whose WHOLE diff fits, in diff order, and the
 * agent is told which were left out. A byte cut remains only when not one file
 * fits whole, and it stays DIFF_TRUNCATED: a review of nothing whole is not a
 * review of something.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chooseSubject, splitDiff } from "../scripts/review-diff-subject";

const SCRATCH: string[] = [];
afterAll(() => {
  for (const d of SCRATCH) rmSync(d, { recursive: true, force: true });
});

/** One file's section of a unified diff, `body` bytes of changed lines. */
function section(path: string, bodyBytes: number, ch = "+"): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    ch + "x".repeat(Math.max(0, bodyBytes - 1)),
    "",
  ].join("\n");
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

describe("#1934: the diff is split into one section per file", () => {
  test("each `diff --git` header starts a section, and the sections rejoin to the diff byte for byte", () => {
    const diff = section("a.ts", 10) + section("dir with space/b.md", 20) + section("c.json", 5);
    const { preamble, files } = splitDiff(diff);
    expect(preamble).toBe("");
    expect(files.map(f => f.path)).toEqual(["a.ts", "dir with space/b.md", "c.json"]);
    expect(preamble + files.map(f => f.text).join("")).toBe(diff);
  });

  test("a line that merely CONTAINS `diff --git` is not a header", () => {
    const tricky = section("a.ts", 10).replace("+xxxxxxxxx", "+ diff --git a/z b/z inside a line");
    expect(splitDiff(tricky).files.map(f => f.path)).toEqual(["a.ts"]);
  });
});

describe("#1934: the subject is whole files, and says what it left out", () => {
  test("under the budget, the subject is the diff unchanged — not even a newline added", () => {
    const diff = section("a.ts", 100) + section("b.ts", 100).replace(/\n$/, "");
    const s = chooseSubject(diff, 10_000);
    expect(s.subject).toBe(diff);
    expect(s).toMatchObject({ filesRead: 2, filesSeen: 2, omitted: [], truncated: false });
  });

  test("#1932's shape: one huge file and one small one — the small one is reviewed whole, the huge one named", () => {
    const huge = section("project-state.json", 150_000);
    const small = section("PROJECT-STATE.md", 2_000);
    const s = chooseSubject(huge + small, 98_304);
    expect(s).toMatchObject({ filesRead: 1, filesSeen: 2, omitted: ["project-state.json"], truncated: false });
    expect(s.subject).toContain(small);
    expect(s.subject).not.toContain("diff --git a/project-state.json");
    // The agent is told, first, what it is NOT looking at.
    expect(s.subject.startsWith("*** ")).toBe(true);
    expect(s.subject.split("\n")[0]).toContain("1 of 2 files");
    expect(s.subject.split("\n")[0]).toContain("project-state.json");
    expect(bytes(s.subject)).toBeLessThanOrEqual(98_304);
  });

  test("a file that does not fit is skipped, and a later one that does is still taken", () => {
    const s = chooseSubject(section("a.ts", 600) + section("big.ts", 5_000) + section("c.ts", 600), 4_000);
    expect(s.filesRead).toBe(2);
    expect(s.omitted).toEqual(["big.ts"]);
    expect(s.subject).toContain("diff --git a/a.ts");
    expect(s.subject).toContain("diff --git a/c.ts");
  });

  test("the subject never exceeds the budget, however long the list of omitted files is", () => {
    const many = Array.from({ length: 400 }, (_, i) => section(`a/really/quite/long/path/number-${i}.ts`, 3_000)).join("");
    const s = chooseSubject(section("tiny.ts", 50) + many, 8_192);
    expect(bytes(s.subject)).toBeLessThanOrEqual(8_192);
    expect(s.filesSeen).toBe(401);
    expect(s.filesRead).toBeGreaterThanOrEqual(1);
    expect(s.omitted.length).toBe(s.filesSeen - s.filesRead);
    expect(s.subject.split("\n")[0]).toMatch(/and \d+ more/);
  });

  test("when no file fits whole, the old byte cut is kept and marked — and it is still a truncation", () => {
    const diff = section("only.json", 20_000);
    const s = chooseSubject(diff, 4_096);
    expect(s).toMatchObject({ filesRead: 0, filesSeen: 1, omitted: ["only.json"], truncated: true });
    expect(s.subject.startsWith(diff.slice(0, 4_096))).toBe(true);
    expect(s.subject).toContain(`*** diff truncated at 4096 of ${bytes(diff)} bytes ***`);
  });

  test("an empty diff has nothing to read and nothing left out", () => {
    expect(chooseSubject("", 4_096)).toMatchObject({ subject: "", filesRead: 0, filesSeen: 0, omitted: [], truncated: false });
  });

  test("bytes, not characters: a multi-byte file is measured in UTF-8", () => {
    // 3,000 three-byte characters are 9,000 bytes: over a 4,096-byte budget
    // even though the string is only ~3,000 characters long.
    const wide = section("wide.md", 1).replace("@@ -1 +1 @@\n+", "@@ -1 +1 @@\n+" + "€".repeat(3_000));
    const s = chooseSubject(wide + section("narrow.md", 100), 4_096);
    expect(s.omitted).toEqual(["wide.md"]);
    expect(s.filesRead).toBe(1);
  });
});

describe("#1934: the command writes the subject and the step outputs", () => {
  const cli = join(import.meta.dir, "..", "scripts", "review-diff-subject.ts");

  function run(diff: string, maxBytes: number) {
    const dir = mkdtempSync(join(tmpdir(), "r1934-subject-"));
    SCRATCH.push(dir);
    const inFile = join(dir, "pr.diff");
    const outFile = join(dir, "pr.subject");
    const outputs = join(dir, "github_output");
    writeFileSync(inFile, diff);
    writeFileSync(outputs, "prior=kept\n");
    const p = Bun.spawnSync(["bun", cli, "--in", inFile, "--out", outFile, "--max-bytes", String(maxBytes), "--outputs", outputs]);
    return {
      code: p.exitCode,
      stdout: new TextDecoder().decode(p.stdout),
      stderr: new TextDecoder().decode(p.stderr),
      subject: () => readFileSync(outFile, "utf8"),
      outputs: () => readFileSync(outputs, "utf8"),
    };
  }

  test("a partial subject: outputs appended, prior outputs kept, and a warning naming the scope", () => {
    const r = run(section("project-state.json", 20_000) + section("PROJECT-STATE.md", 500), 8_192);
    expect(r.code, r.stderr).toBe(0);
    expect(r.outputs()).toBe("prior=kept\ntruncated=false\nfiles_read=1\nfiles_seen=2\n");
    expect(r.stdout).toContain("::warning title=Review covers part of the diff::");
    expect(r.stdout).toContain("1 of 2 files");
    expect(r.subject()).toContain("diff --git a/PROJECT-STATE.md");
  });

  test("a byte cut warns the way the step always has", () => {
    const r = run(section("only.json", 20_000), 4_096);
    expect(r.code, r.stderr).toBe(0);
    expect(r.outputs()).toContain("truncated=true\nfiles_read=0\nfiles_seen=1\n");
    expect(r.stdout).toContain("::warning::diff truncated at 4096 of");
  });

  test("a whole diff writes no warning", () => {
    const r = run(section("a.ts", 100), 4_096);
    expect(r.code, r.stderr).toBe(0);
    expect(r.outputs()).toContain("truncated=false\nfiles_read=1\nfiles_seen=1\n");
    expect(r.stdout).not.toContain("::warning");
  });

  test("a missing argument or an unreadable input refuses rather than writing an empty subject", () => {
    const missing = Bun.spawnSync(["bun", cli, "--in", "/nonexistent/pr.diff"]);
    expect(missing.exitCode).not.toBe(0);
    const dir = mkdtempSync(join(tmpdir(), "r1934-bad-"));
    SCRATCH.push(dir);
    const bad = Bun.spawnSync(["bun", cli, "--in", join(dir, "nope.diff"), "--out", join(dir, "o"), "--max-bytes", "4096", "--outputs", join(dir, "g")]);
    expect(bad.exitCode).not.toBe(0);
    const zero = Bun.spawnSync(["bun", cli, "--in", join(dir, "nope.diff"), "--out", join(dir, "o"), "--max-bytes", "0", "--outputs", join(dir, "g")]);
    expect(zero.exitCode).not.toBe(0);
  });
});
