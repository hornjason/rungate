/**
 * Covers SC-2791 (SPEC-TO-BOARD-PIPELINE-SPEC.md), #2484, ADR-023 row 5:
 * `rungate scaffold` installs `.claude/commands/board.md`, a `/board` command
 * that runs the published CLI against the repository it sits in and names no
 * other repository.
 *
 * Before this, the only `/board` was a user-level skill an agent wrote under
 * `~/.claude/skills/`, and it read one hard-coded repository from one
 * hard-coded checkout. A consumer had no `/board` at all.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { bunxInvocations, CLI_COMMANDS } from "../lib/cli-commands";
import { BOARD_COMMAND_PATH, processFiles } from "../lib/scaffold/process-files";
import { runScaffoldWriteSteps } from "../lib/scaffold/write-steps";

const ROOT = join(import.meta.dir, "..");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
  files: string[];
  repository: { url: string };
};
/** This package's own `owner/name`, read from the manifest rather than spelled here. */
const OWN_SLUG = PKG.repository.url.replace(/^.*github\.com\//, "").replace(/\.git$/, "");

function scaffoldConsumer(edit?: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "rg-board-command-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "consumer", version: "0.0.0" }));
  const first: string[] = [];
  runScaffoldWriteSteps(root, "node" as never, first);
  const second: string[] = [];
  if (edit) {
    edit(root);
    runScaffoldWriteSteps(root, "node" as never, second);
  }
  const p = join(root, BOARD_COMMAND_PATH);
  return { root, first, second, command: existsSync(p) ? readFileSync(p, "utf-8") : "" };
}

/** The lines an agent is told to run: every inline code span. */
const commandSpans = (text: string) => [...text.matchAll(/`([^`\n]+)`/g)].map(m => m[1]);

/**
 * Why a rendered `/board` reaches past the repository it sits in, or `[]`.
 * One decider, applied to both renderings below.
 */
function namesAnotherRepository(text: string): string[] {
  const why: string[] = [];
  for (const span of commandSpans(text)) {
    if (/(^|\s)(--repo|-R)(\s|=|$)/.test(span)) why.push(`passes a repository flag: ${span}`);
    if (/github\.com\//.test(span)) why.push(`names a GitHub URL: ${span}`);
    if (/(^|\s)cd\s/.test(span) || /~\//.test(span)) why.push(`moves to another directory: ${span}`);
    if (/<owner\/name>/.test(span)) why.push(`asks for a repository to be filled in: ${span}`);
  }
  if (OWN_SLUG.length === 0 || !OWN_SLUG.includes("/")) why.push(`could not read this package's own slug from package.json`);
  else if (text.includes(OWN_SLUG)) why.push(`names this package's own repository, ${OWN_SLUG}`);
  return why;
}

describe("SC-2791: rungate scaffold installs /board, which reads the repository it sits in", () => {
  test("a consumer's scaffold writes it, and every rungate command it runs is registered and shipped", () => {
    const { root, first, command } = scaffoldConsumer();
    try {
      expect(command, "no /board command was written").not.toBe("");
      expect(first.join("\n")).toContain(`GENERATED: ${BOARD_COMMAND_PATH}`);
      expect(command, "a provenance marker keeps a consumer's edits").toMatch(/^generated-sha: /m);
      const invoked = bunxInvocations(command, "rungate");
      // The three readings it is built from. Fewer and the checks below are over nothing.
      for (const name of ["work-status", "board-conformance", "board"]) expect(invoked).toContain(name);
      for (const name of invoked) {
        const entry = CLI_COMMANDS[name];
        expect(entry, `bunx rungate ${name} is not a registered command`).toBeDefined();
        const shipped = PKG.files.some(f => f === entry.script || (f.endsWith("/") && entry.script.startsWith(f)));
        expect(shipped, `${entry.script} (bunx rungate ${name}) is not in package.json files[]`).toBe(true);
      }
      expect(command, "a consumer has no bin/ or scripts/ of rungate's").not.toMatch(/\bbun (bin|scripts)\//);
      const runs = commandSpans(command).filter(s => /^(env |gh |git |bunx )/.test(s));
      expect(runs.length, "no runnable line was found, so the no-write check measured nothing").toBeGreaterThan(4);
      expect(runs.filter(s => s.includes("--write")), "/board is read-only").toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("it names no repository: no --repo, no -R, no URL, no other checkout, not this package's own", () => {
    const { root, command } = scaffoldConsumer();
    try {
      expect(namesAnotherRepository(command)).toEqual([]);
      // The decider is not vacuous: the shape the user-level skill had is refused.
      const old = command.replace(
        "bunx rungate work-status",
        `bunx rungate work-status --repo ${OWN_SLUG}`,
      );
      expect(old).not.toBe(command);
      expect(namesAnotherRepository(old).length).toBeGreaterThan(0);
      expect(namesAnotherRepository("`(cd ~/Projects/x && gh pr list)`").length).toBeGreaterThan(0);
      expect(namesAnotherRepository("`gh issue list -R someone/else`").length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("this repository's copy is the rendered one, and it too names no repository", () => {
    const ours = processFiles(true).find(f => f.path === BOARD_COMMAND_PATH);
    expect(ours?.content, "processFiles renders no /board").toBeTruthy();
    const onDisk = readFileSync(join(ROOT, BOARD_COMMAND_PATH), "utf-8").replace(/^generated-sha: .*\n/m, "");
    expect(onDisk).toBe(ours!.content!);
    expect(onDisk).toContain("bun bin/rungate.ts work-status");
    expect(namesAnotherRepository(onDisk)).toEqual([]);
  });

  test("a hand-edited /board is preserved and reported", () => {
    const { root, second, command } = scaffoldConsumer(r => {
      writeFileSync(join(r, BOARD_COMMAND_PATH), readFileSync(join(r, BOARD_COMMAND_PATH), "utf-8") + "\nmine\n");
    });
    try {
      expect(second.join("\n")).toContain(`PRESERVED: ${BOARD_COMMAND_PATH}`);
      expect(command).toContain("\nmine\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an installation missing the source refuses by name", () => {
    const empty = mkdtempSync(join(tmpdir(), "rg-board-templates-"));
    try {
      const board = processFiles(false, empty).find(f => f.path === BOARD_COMMAND_PATH);
      expect(board).toEqual({
        path: BOARD_COMMAND_PATH,
        content: null,
        why: "templates/process/board.md is missing from this rungate installation",
      });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
