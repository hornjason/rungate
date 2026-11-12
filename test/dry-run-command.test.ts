/**
 * Covers SC-2740 (SPEC-TO-BOARD-PIPELINE-SPEC.md): one command shows a
 * proposal as a dry run — the real planning tools without `--write`, what
 * reaches Ready, the gaps found — and writes its visual next to the document.
 *
 * Asserted on the command file in the repository, not on a skill in one
 * person's home directory: ADR-013 step 2 tells every session to run
 * `/dry-run`, so the command has to travel with the repo (#2001).
 *
 * Broken to prove it: deleting any one phrase below from
 * `.claude/commands/dry-run.md` turns its case red, and adding `--write` to
 * any command line in it turns the no-write case red.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const PATH = join(import.meta.dir, "..", ".claude", "commands", "dry-run.md");
const text = existsSync(PATH) ? readFileSync(PATH, "utf-8") : "";

describe("SC-2740: /dry-run is a project command that shows a proposal as a real dry run", () => {
  test("SC-2740: the command file exists and takes the document as its argument", () => {
    expect(text.length, ".claude/commands/dry-run.md does not exist").toBeGreaterThan(0);
    expect(text).toMatch(/^argument-hint: .+$/m);
    expect(text).toMatch(/^description: .{20,}$/m);
    expect(text).toContain("$ARGUMENTS");
  });

  const MUST: [string, string][] = [
    ["it runs the real issue planner", "plan-issues --decompose"],
    ["it runs the real milestone planner", "plan-spec"],
    ["it runs the real order-link planner", "plan-deps"],
    ["it reads what Ready holds today", "scripts/work-status.ts"],
    ["it shows what reaches Ready", "What reaches Ready"],
    ["it shows the gaps found", "Gaps found"],
    ["it says what needs Jason", "Needs you"],
    ["it writes the visual next to the document", "-flow.html"],
    ["it opens the visual on Linux as well as macOS", "xdg-open"],
    ["it reads the document from disk every run", "from disk every run"],
  ];
  for (const [what, phrase] of MUST) {
    test(`SC-2740: ${what}`, () => {
      expect(text, `dry-run.md must contain: ${phrase}`).toContain(phrase);
    });
  }

  test("SC-2740: it forbids --write and no command line in it passes --write", () => {
    expect(text).toContain("Never pass `--write`");
    const commandLines = text.split("\n").filter(l => /\bbun (bin|scripts)\//.test(l));
    expect(commandLines.length, "no command lines found, so the no-write check measured nothing").toBeGreaterThan(0);
    expect(commandLines.filter(l => l.includes("--write"))).toEqual([]);
    // Each one reaches GitHub, so each must drop GH_TOKEN as written, not by inference.
    // …and passes GITHUB_TOKEN, which every one of them requires or reports UNMEASURED.
    expect(commandLines.filter(l => !l.includes('`env -u GH_TOKEN GITHUB_TOKEN="$(env -u GH_TOKEN gh auth token)" bun '))).toEqual([]);
  });

  test("SC-2740: it carries no executable block, so invoking it runs nothing before it is read", () => {
    // Mid-line too: the runtime executes an inline !`…` as well as one opening a line.
    expect(text.split("\n").filter(l => l.includes("!`"))).toEqual([]);
    expect(text, "the command must tell the agent to quote the path").toContain("Quote the path in every command");
  });
});
