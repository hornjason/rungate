/**
 * #2345: blocked-by links are written through the REST dependencies API, so a
 * runner whose `gh` predates `issue edit --add-blocked-by` still wires them.
 * Serves no criterion, as the issue says.
 *
 * The trap this guards: the endpoint's `issue_id` is the blocker's DATABASE
 * id. A repository number is accepted too and links a DIFFERENT issue
 * (measured 2026-11-05, recorded in scripts/board-walkthrough.ts).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { addBlockers, removeBlocker } from "../lib/blocked-by-write";

const ROOT = join(import.meta.dir, "..");
const LIST = "repos/o/r/issues/9/dependencies/blocked_by?per_page=100";
const POST = "repos/o/r/issues/9/dependencies/blocked_by";

function fakeGh(replies: Record<string, string>) {
  const calls: string[][] = [];
  const exec = (args: readonly string[]) => {
    calls.push([...args]);
    const key = args.find(a => a.startsWith("repos/")) ?? "";
    const reply = replies[key];
    if (reply === undefined) throw new Error(`unexpected call: ${args.join(" ")}`);
    return reply;
  };
  return { exec, calls };
}

describe("#2345: blocked-by links are written through the REST API, by the blocker's database id", () => {
  test("it reads each blocker's database id, POSTs those ids, never the numbers, and reads the links back once", () => {
    const { exec, calls } = fakeGh({
      "repos/o/r/issues/7": "6229750699\n",
      "repos/o/r/issues/8": "6229750700\n",
      [POST]: "{}",
      [LIST]: "3\n7\n8\n",
    });
    addBlockers("o/r", 9, [7, 8], exec);
    expect(calls).toEqual([
      ["api", "repos/o/r/issues/7", "--jq", ".id"],
      ["api", "repos/o/r/issues/8", "--jq", ".id"],
      ["api", "-X", "POST", POST, "-F", "issue_id=6229750699"],
      ["api", "-X", "POST", POST, "-F", "issue_id=6229750700"],
      ["api", "--paginate", LIST, "--jq", ".[].number"],
    ]);
    expect(calls.flat()).not.toContain("--add-blocked-by");
  });

  test("a blocker shared by many issues has its id read once per run", () => {
    const ids = new Map<string, number>();
    const { exec, calls } = fakeGh({
      "repos/o/r/issues/7": "6229750699\n",
      [POST]: "{}",
      [LIST]: "7\n",
      "repos/o/r/issues/10/dependencies/blocked_by": "{}",
      "repos/o/r/issues/10/dependencies/blocked_by?per_page=100": "7\n",
    });
    addBlockers("o/r", 9, [7], exec, ids);
    addBlockers("o/r", 10, [7], exec, ids);
    expect(calls.filter(c => c[1] === "repos/o/r/issues/7").length).toBe(1);
  });

  test("the id cache is per repository: the same number in another repository is read again (review of #2357)", () => {
    const ids = new Map<string, number>();
    const { exec, calls } = fakeGh({
      "repos/o/r/issues/7": "111\n",
      "repos/o/other/issues/7": "222\n",
      [POST]: "{}",
      [LIST]: "7\n",
      "repos/o/other/issues/9/dependencies/blocked_by": "{}",
      "repos/o/other/issues/9/dependencies/blocked_by?per_page=100": "7\n",
    });
    addBlockers("o/r", 9, [7], exec, ids);
    addBlockers("o/other", 9, [7], exec, ids);
    expect(calls.find(c => c[3] === "repos/o/other/issues/9/dependencies/blocked_by")).toContain("issue_id=222");
  });

  test("a link that does not read back is refused, naming it, never reported as wired", () => {
    const { exec } = fakeGh({
      "repos/o/r/issues/7": "6229750699\n",
      [POST]: "{}",
      [LIST]: "4\n",
    });
    expect(() => addBlockers("o/r", 9, [7], exec)).toThrow(/#7 is not among its blockers on read-back \(#4\)/);
  });

  test("an id that is not a positive integer is refused before anything is written", () => {
    const { exec, calls } = fakeGh({ "repos/o/r/issues/7": "null\n" });
    expect(() => addBlockers("o/r", 9, [7], exec)).toThrow(/database id/);
    expect(calls.length).toBe(1);
  });

  test("a link is removed by the blocker's database id, and read back gone (review of #2357)", () => {
    const { exec, calls } = fakeGh({
      "repos/o/r/issues/7": "6229750699\n",
      "repos/o/r/issues/9/dependencies/blocked_by/6229750699": "{}",
      [LIST]: "3\n",
    });
    removeBlocker("o/r", 9, 7, exec);
    expect(calls[1]).toEqual(["api", "-X", "DELETE", "repos/o/r/issues/9/dependencies/blocked_by/6229750699"]);
    expect(calls[2]).toEqual(["api", "--paginate", LIST, "--jq", ".[].number"]);
  });

  test("a removal that still reads back is refused, never reported as done", () => {
    const { exec } = fakeGh({
      "repos/o/r/issues/7": "6229750699\n",
      "repos/o/r/issues/9/dependencies/blocked_by/6229750699": "{}",
      [LIST]: "3\n7\n",
    });
    expect(() => removeBlocker("o/r", 9, 7, exec)).toThrow(/still among its blockers/);
  });

  test("both writers use it, and nothing shells out to --add-blocked-by or --remove-blocked-by any more", () => {
    for (const file of ["scripts/plan-deps.ts", "scripts/plan-issues.ts"]) {
      const src = readFileSync(join(ROOT, file), "utf-8");
      expect(src, file).toContain("addBlockers(repo, blocked,");
      expect(src, file).not.toContain('"--add-blocked-by"');
      expect(src, file).not.toContain('"--remove-blocked-by"');
    }
    expect(readFileSync(join(ROOT, "scripts/plan-issues.ts"), "utf-8")).toContain("removeBlocker(repo, blocked, blocker,");
  });
});
