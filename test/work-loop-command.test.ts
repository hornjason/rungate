/**
 * Covers SC-2794 (SPEC-TO-BOARD-PIPELINE-SPEC.md), #2486, ADR-023 row 8:
 * `rungate scaffold` installs the work loop as `.claude/commands/work-loop.md`
 * (pick from Ready with `rungate work-status`, claim, work in a worktree off
 * the default branch, test first with the project's own test command, open a
 * pull request with `Fixes #N`, merge pinned with `rungate verify-merge-ref`),
 * naming only commands a consumer has.
 *
 * The loop an agent ran here lived in a user-level prompt and named this
 * repository's own scripts: `bun scripts/work-status.ts`, `census-routing`,
 * `bun scripts/verify-merge-ref.ts`. A consumer has none of those paths, and
 * ADR-023 decided `census-routing` does not ship at all.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { bunxInvocations, CLI_COMMANDS } from "../lib/cli-commands";
import { ADR_TEMPLATE_PATH, BOARD_COMMAND_PATH, DRY_RUN_COMMAND_PATH, processFiles, WORK_LOOP_COMMAND_PATH } from "../lib/scaffold/process-files";
import { runScaffoldWriteSteps, writeProcessFiles } from "../lib/scaffold/write-steps";
import { testCommandDecision } from "../lib/test-command";

const ROOT = join(import.meta.dir, "..");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as { files: string[] };

function scaffoldConsumer(pkg: Record<string, unknown>, edit?: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "rg-work-loop-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "consumer", version: "0.0.0", ...pkg }));
  const first: string[] = [];
  runScaffoldWriteSteps(root, "node" as never, first);
  const second: string[] = [];
  if (edit) {
    edit(root);
    runScaffoldWriteSteps(root, "node" as never, second);
  }
  const p = join(root, WORK_LOOP_COMMAND_PATH);
  return { root, first, second, command: existsSync(p) ? readFileSync(p, "utf-8") : "" };
}

/** The lines an agent is told to run: every inline code span. */
const spans = (text: string) => [...text.matchAll(/`([^`\n]+)`/g)].map(m => m[1]);

describe("SC-2794: rungate scaffold installs the work loop, naming only commands a consumer has", () => {
  test("a consumer's scaffold writes it, and every rungate command it runs is registered and shipped", () => {
    const { root, first, command } = scaffoldConsumer({});
    try {
      expect(command, "no work-loop command was written").not.toBe("");
      expect(first.join("\n")).toContain(`GENERATED: ${WORK_LOOP_COMMAND_PATH}`);
      expect(command, "a provenance marker keeps a consumer's edits").toMatch(/^generated-sha: /m);
      const invoked = bunxInvocations(command, "rungate");
      for (const name of ["work-status", "verify-merge-ref"]) expect(invoked).toContain(name);
      for (const name of invoked) {
        const entry = CLI_COMMANDS[name];
        expect(entry, `bunx rungate ${name} is not a registered command`).toBeDefined();
        const shipped = PKG.files.some(f => f === entry.script || (f.endsWith("/") && entry.script.startsWith(f)));
        expect(shipped, `${entry.script} (bunx rungate ${name}) is not in package.json files[]`).toBe(true);
      }
      expect(command, "a consumer has no bin/ or scripts/ of rungate's").not.toMatch(/\bbun (bin|scripts)\//);
      expect(command, "census-routing does not ship (ADR-023)").not.toContain("census-routing");
      const repoFlags = spans(command).filter(s => /(^|\s)(--repo|-R)(\s|=|$)/.test(s) || s.includes("github.com/"));
      expect(repoFlags, "the loop works on the repository it sits in").toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the steps come in the loop's order: pick, claim, worktree, test first, pull request, pinned merge, check after", () => {
    const { root, command } = scaffoldConsumer({});
    try {
      const marks = [
        "bunx rungate work-status",
        "--add-assignee @me",
        "git worktree add",
        "origin/HEAD",
        testCommandDecision(root).command,
        "Fixes #",
        "bunx rungate verify-merge-ref --pr",
        "--match-head-commit",
        // Review of #2518: --auto only arms, so the check after the merge
        // needs a wait for CI between them, or it runs against an open PR.
        "gh pr checks <PR> --watch --fail-fast",
        "--after-merge",
      ];
      const at = marks.map(m => command.indexOf(m));
      expect(at.filter(i => i < 0).length, `missing: ${marks.filter((_, i) => at[i] < 0).join(", ")}`).toBe(0);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the test step names the project's own test command, never a fixed one", () => {
    const { root, command } = scaffoldConsumer({ scripts: { test: "vitest run --reporter=dot" } });
    try {
      expect(testCommandDecision(root).command).toBe("vitest run --reporter=dot");
      expect(command).toContain("`vitest run --reporter=dot`");
      expect(command).not.toContain("`bun test`");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Review of #2518: a string replacement reads `$$`, `$&` and `$'` as
  // patterns, so a test command holding one was rendered as a different command.
  test("a test command holding $ patterns is written exactly as the project declares it", () => {
    const declared = "server & PID=$$; jest $& $' $1; kill $PID";
    const rendered = processFiles(false, undefined, declared).find(f => f.path === WORK_LOOP_COMMAND_PATH)?.content ?? "";
    expect(rendered).toContain("`" + declared + "`");
  });

  // Review of #2518: the work loop's test command comes from the config, and a
  // malformed config made the process-file step throw before dry-run.md, the
  // ADR template and board.md were written. It refuses the work loop by name.
  test("a config that cannot be read refuses the work loop by name, and the other process files are still written", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-work-loop-bad-config-"));
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "consumer", version: "0.0.0" }));
      mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
      writeFileSync(join(root, ".claude", "rungate", "config.json"), "{ not json");
      const actions: string[] = [];
      expect(() => writeProcessFiles(root, actions)).not.toThrow();
      for (const path of [DRY_RUN_COMMAND_PATH, ADR_TEMPLATE_PATH, BOARD_COMMAND_PATH]) {
        expect(existsSync(join(root, path)), `${path} was not written`).toBe(true);
      }
      expect(existsSync(join(root, WORK_LOOP_COMMAND_PATH))).toBe(false);
      const refusal = actions.find(a => a.startsWith(`REFUSED: ${WORK_LOOP_COMMAND_PATH}`)) ?? "";
      expect(refusal).toContain("the rungate config could not be read");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("this repository's copy is the rendered one", () => {
    const ours = processFiles(true, undefined, testCommandDecision(ROOT).command).find(f => f.path === WORK_LOOP_COMMAND_PATH);
    expect(ours?.content, "processFiles renders no work loop").toBeTruthy();
    const onDisk = readFileSync(join(ROOT, WORK_LOOP_COMMAND_PATH), "utf-8").replace(/^generated-sha: .*\n/m, "");
    expect(onDisk).toBe(ours!.content!);
    expect(onDisk).toContain("bun bin/rungate.ts work-status");
    expect(onDisk).toContain("bun bin/rungate.ts verify-merge-ref --pr");
  });

  test("a hand-edited work loop is preserved and reported", () => {
    const { root, second, command } = scaffoldConsumer({}, r => {
      writeFileSync(join(r, WORK_LOOP_COMMAND_PATH), readFileSync(join(r, WORK_LOOP_COMMAND_PATH), "utf-8") + "\nmine\n");
    });
    try {
      expect(second.join("\n")).toContain(`PRESERVED: ${WORK_LOOP_COMMAND_PATH}`);
      expect(command).toContain("\nmine\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an installation missing the source refuses by name", () => {
    const empty = mkdtempSync(join(tmpdir(), "rg-work-loop-templates-"));
    try {
      expect(processFiles(false, empty, "bun test").find(f => f.path === WORK_LOOP_COMMAND_PATH)).toEqual({
        path: WORK_LOOP_COMMAND_PATH,
        content: null,
        why: "templates/process/work-loop.md is missing from this rungate installation",
      });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
