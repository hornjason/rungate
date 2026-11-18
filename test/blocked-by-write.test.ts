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
import { addBlockedBy } from "../lib/blocked-by-write";

const ROOT = join(import.meta.dir, "..");

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

describe("#2345: a blocked-by link is written through the REST API, by the blocker's database id", () => {
  const LIST = "repos/o/r/issues/9/dependencies/blocked_by?per_page=100";

  test("it reads the blocker's database id, POSTs that id, never the number, and reads the link back", () => {
    const { exec, calls } = fakeGh({
      "repos/o/r/issues/7": "6229750699\n",
      "repos/o/r/issues/9/dependencies/blocked_by": "{}",
      [LIST]: "3\n7\n",
    });
    addBlockedBy("o/r", 9, 7, exec);
    expect(calls[0]).toEqual(["api", "repos/o/r/issues/7", "--jq", ".id"]);
    expect(calls[1]).toEqual(["api", "-X", "POST", "repos/o/r/issues/9/dependencies/blocked_by", "-F", "issue_id=6229750699"]);
    expect(calls[2]).toEqual(["api", "--paginate", LIST, "--jq", ".[].number"]);
    expect(calls.flat()).not.toContain("--add-blocked-by");
  });

  test("a link that reads back as some other issue is refused, never reported as wired", () => {
    const { exec } = fakeGh({
      "repos/o/r/issues/7": "6229750699\n",
      "repos/o/r/issues/9/dependencies/blocked_by": "{}",
      [LIST]: "4\n",
    });
    expect(() => addBlockedBy("o/r", 9, 7, exec)).toThrow(/read back as #4/);
  });

  test("an id that is not a positive integer is refused before anything is written", () => {
    const { exec, calls } = fakeGh({ "repos/o/r/issues/7": "null\n" });
    expect(() => addBlockedBy("o/r", 9, 7, exec)).toThrow(/database id/);
    expect(calls.length).toBe(1);
  });

  test("both writers use it, and neither shells out to --add-blocked-by any more", () => {
    for (const file of ["scripts/plan-deps.ts", "scripts/plan-issues.ts"]) {
      const src = readFileSync(join(ROOT, file), "utf-8");
      expect(src, file).toContain("addBlockedBy(");
      expect(src, file).not.toContain('"--add-blocked-by"');
    }
  });
});
