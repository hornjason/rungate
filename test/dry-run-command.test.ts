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

// #2016: on 2026-11-12 the primary checkout was 3 commits behind origin/main
// and the dry run measured that tree with nothing saying so.
describe("#2016: /dry-run refuses a checkout behind origin/main and names the commit it measured", () => {
  const FETCH = 'git -C "<checkout>" fetch origin main';
  const BEHIND = 'git -C "<checkout>" rev-list --count HEAD..origin/main';
  const PLANNER = "plan-issues --decompose";

  test("#2016: it fetches origin/main and counts the commits HEAD is behind", () => {
    expect(text, `dry-run.md must contain: ${FETCH}`).toContain(FETCH);
    expect(text, `dry-run.md must contain: ${BEHIND}`).toContain(BEHIND);
  });

  const lines = text.split("\n");
  const lineOf = (s: string) => lines.findIndex(l => l.includes(s));

  test("#2016: fetch, then count, then any planner, in that order", () => {
    const [fetch, behind, planner] = [FETCH, BEHIND, PLANNER].map(s => text.indexOf(s));
    expect(fetch, "no fetch found, so its order measured nothing").toBeGreaterThan(-1);
    // A count taken before the fetch reads whatever origin/main was cached.
    expect(fetch).toBeLessThan(behind);
    expect(behind).toBeLessThan(planner);
  });

  test("#2016: a failed fetch stops the run, so a stale ref is never counted", () => {
    expect(lines[lineOf(FETCH)]).toContain("If the fetch fails, stop");
  });

  test("#2016: a checkout behind origin/main is refused with the count, never measured", () => {
    expect(text).toMatch(/behind origin\/main[^\n]*stop/i);
    expect(text).toContain("how many commits behind");
    expect(text).toContain("and run nothing else");
  });

  test("#2016: the measured commit is printed only after both checks pass", () => {
    expect(text).toContain('git -C "<checkout>" rev-parse --short HEAD');
    const measured = lineOf("Measured commit");
    expect(measured, "no Measured commit line").toBeGreaterThan(-1);
    // Its own bullet, gated, and after both stop clauses: printed unconditionally
    // it would hand a reader a SHA for a tree the run just refused.
    expect(lines[measured]).toMatch(/^\s*- Only when both pass, print `Measured commit: `/);
    expect(measured).toBeGreaterThan(lineOf("and run nothing else"));
    expect(measured).toBeGreaterThan(lineOf("If the fetch fails, stop"));
  });
});
