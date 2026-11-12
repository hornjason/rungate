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
  const RESOLVE = "git rev-parse --path-format=absolute --git-common-dir";

  test("#2016: it fetches origin/main and counts the commits HEAD is behind", () => {
    expect(text, `dry-run.md must contain: ${FETCH}`).toContain(FETCH);
    expect(text, `dry-run.md must contain: ${BEHIND}`).toContain(BEHIND);
  });

  /**
   * The whole markdown bullet or numbered step that contains \`needle\`, with
   * its line breaks collapsed (#2019). The earlier cases counted a fixed
   * number of physical lines forward from a line, so re-wrapping the prose
   * turned them red without changing what it said. A bullet ends where the
   * next one starts, at a blank line, or at a heading.
   */
  const bulletOf = (doc: string, needle: string): string => {
    const starts = (l: string) => /^\s*(-|\d+\.)\s/.test(l);
    const bullets: string[] = [];
    let current: string | null = null;
    for (const line of doc.split("\n")) {
      if (starts(line)) {
        if (current !== null) bullets.push(current);
        current = line;
      } else if (line.trim() === "" || line.startsWith("#")) {
        if (current !== null) bullets.push(current);
        current = null;
      } else if (current !== null) {
        current += " " + line;
      }
    }
    if (current !== null) bullets.push(current);
    // Matched on the joined text, so a needle the wrap split across two lines
    // is still found.
    return bullets.map(b => b.replace(/\s+/g, " ").trim()).find(b => b.includes(needle)) ?? "";
  };

  /** Every #2016 ordering and gating property, as failures, so it can run on any wrapping of the file. */
  const stepZeroFailures = (doc: string): string[] => {
    const failures: string[] = [];
    const fetch = bulletOf(doc, FETCH);
    const count = bulletOf(doc, BEHIND);
    const measured = bulletOf(doc, "Measured commit");
    if (!fetch.includes("If the fetch fails, stop and run nothing else")) failures.push("the fetch bullet does not stop on a failed fetch");
    if (!count.includes("and run nothing else")) failures.push("the count bullet does not refuse a checkout that is behind");
    if (!count.includes("If it errors or prints anything but a number, stop")) failures.push("the count bullet does not refuse an unread count");
    if (!/^- Only when both pass, print `Measured commit: `/.test(measured)) failures.push("the measured commit is not its own gated bullet");
    // After both stop clauses: printed unconditionally it would hand a reader
    // a SHA for a tree the run just refused.
    const flat = doc.replace(/\s+/g, " ");
    if (!(flat.indexOf(measured) > flat.indexOf(count) && flat.indexOf(count) > flat.indexOf(fetch))) {
      failures.push("fetch, count and measured commit are not in that order");
    }
    // Step 0 before any planner: a count taken after the dry runs measured
    // nothing in time (review of #2028 restored this from the #2016 cases).
    // #2019: <checkout> is resolved first, by a command judged on its own.
    // Here rather than in its own case so the re-wrap case covers it too
    // (review round 3 of #2028).
    const resolve = bulletOf(doc, RESOLVE);
    if (resolve === "") failures.push("<checkout> is never resolved");
    else {
      if (flat.indexOf(resolve) > flat.indexOf(fetch)) failures.push("<checkout> is resolved after it is first used");
      if (!/errors or prints nothing, stop/i.test(resolve)) failures.push("a failed resolution does not stop the run");
      // Inside `dirname "$(...)"` a failing git call is swallowed: `dirname ""`
      // prints "." and exits 0 (review round 1 of #2028).
      if (resolve.includes("$(git rev-parse") || resolve.includes("dirname")) failures.push("the resolution is wrapped, so its failure is swallowed");
      // A bare repo's or a submodule's common dir does not end in /.git (round 2).
      if (!/does not end in `\/\.git`, stop/.test(resolve)) failures.push("a common dir not ending in /.git is not refused");
    }
    const planner = flat.indexOf(PLANNER);
    if (planner === -1 || flat.indexOf(count) > planner) failures.push("the freshness check does not come before the planner");
    return failures;
  };

  /** The same file with every paragraph and bullet re-wrapped at \`width\` columns. */
  const rewrap = (doc: string, width: number): string =>
    doc.split("\n\n").map(block => {
      const out: string[] = [];
      let line = "";
      for (const word of block.split(/\s+/).filter(Boolean)) {
        if (/^(-|\d+\.)$/.test(word) && line.trim() !== "") {
          out.push(line);
          line = "";
        }
        if (line.length + word.length + 1 > width && line.trim() !== "" && !/^(-|\d+\.)$/.test(line.trim())) {
          out.push(line);
          line = "  ";
        }
        line = line === "" || line === "  " ? line + word : `${line} ${word}`;
      }
      if (line.trim() !== "") out.push(line);
      return out.join("\n");
    }).join("\n\n");

  test("#2016: a failed fetch, a behind checkout and an unread count each stop the run; the commit prints last", () => {
    expect(stepZeroFailures(text)).toEqual([]);
  });

  test("#2019: the same properties hold when the prose is re-wrapped, so a reflow cannot redden them", () => {
    const narrow = rewrap(text, 52);
    expect(narrow, "the re-wrap changed nothing, so it proved nothing").not.toBe(text);
    expect(stepZeroFailures(narrow)).toEqual([]);
    expect(stepZeroFailures(rewrap(text, 140))).toEqual([]);
  });

  test("#2016: a checkout behind origin/main is refused with the count, never measured", () => {
    expect(text).toMatch(/behind origin\/main[^\n]*stop/i);
    expect(text).toContain("how many commits behind");
    expect(text).toContain('git -C "<checkout>" rev-parse --short HEAD');
  });

  test("#2019: <checkout> is bound to a resolved path before any command uses it", () => {
    // Review of #2017: an agent in a worktree could substitute its own path.
    // The properties live in stepZeroFailures; this case names them.
    expect(bulletOf(text, RESOLVE), `dry-run.md must resolve <checkout> with: ${RESOLVE}`).not.toBe("");
    expect(stepZeroFailures(text).filter(f => /resol|common dir|<checkout>/.test(f))).toEqual([]);
  });
});
