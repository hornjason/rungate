/**
 * BI-1..BI-5 — `.github/workflows/board-intake.yml`.
 *
 * The workflow that puts every issue and pull request on the board, and moves
 * a pull request to In review when it opens. Covers the gap #1750 left open:
 * the board had an intake and no transitions, so four of five open pull
 * requests sat in Backlog while #1607 showed Done with the pull request still
 * open and blocked.
 *
 * Read as TEXT rather than parsed, which is this repository's idiom for
 * workflow files and is deliberate: the thing being asserted is what a reader
 * and a reviewer see, and a YAML round-trip would normalise away exactly the
 * spellings that make `pull_request_target` unsafe.
 *
 * COMMENTS ARE STRIPPED BEFORE ANY SAFETY ROW RUNS, and the first draft did
 * not do that. BI-3 asserts no checkout, and it failed against a workflow with
 * no checkout in it, because the header *discusses* `actions/checkout@v4` in
 * a sentence about another file. A detector that cannot tell a step from
 * prose reports the file's documentation as its behaviour
 * (`.claude/rules/checks-must-be-able-to-fail.md`, the second shape). `code`
 * below is the view every safety row reads, and BI-5 asserts that view is
 * non-empty so stripping can never turn a check into a vacuous pass.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW = join(import.meta.dir, "..", ".github", "workflows", "board-intake.yml");
const source = readFileSync(WORKFLOW, "utf8");
const lines = source.split("\n");

/** The file with whole-line comments removed — the only view the safety rows read. */
const code = lines.filter(l => !/^\s*#/.test(l));

/** Every `run:` block's body, as text. Block scalars only; the file uses no inline `run:`. */
function runBlocks(): string[] {
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)run:\s*[|>]/.exec(lines[i]!);
    if (open === null) continue;
    const outer = open[1]!.length;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.trim() !== "" && line.length - line.trimStart().length <= outer) break;
      body.push(line);
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

const usesLines = code.filter(l => /^\s*-?\s*uses:/.test(l)).map(l => l.trim());
const ifLines = code.filter(l => /^\s*if:/.test(l)).map(l => l.trim());

describe("board-intake workflow", () => {
  test("BI-5: the extractors found the file's real shape", () => {
    // Read before any row below. These are the evidence that the scanners are
    // looking at something. If a reformat breaks them this fails, instead of
    // letting the rest pass over empty collections.
    expect(code.length).toBeGreaterThan(10);
    expect(usesLines.length).toBeGreaterThanOrEqual(1);
    expect(runBlocks().length).toBeGreaterThanOrEqual(1);
    // The stripper must remove commentary without eating the workflow.
    expect(code.length).toBeLessThan(lines.length);
  });

  test("BI-1: a pull request is moved to In review, keyed to the item the add step created", () => {
    // `actions/add-to-project` has no field input, so the transition is a
    // second step. It must address the item the first step just created
    // rather than re-querying the board: a re-query races GitHub's built-in
    // "Item added to project" workflow, which is what puts the item in
    // Backlog in the first place.
    const body = code.join("\n");
    expect(body.includes("updateProjectV2ItemFieldValue")).toBe(true);
    expect(body.includes("steps.add.outputs.itemId")).toBe(true);
    expect(/id:\s*add\b/.test(body)).toBe(true);
  });

  test("BI-2: a draft pull request is not moved", () => {
    // Jason's call, 2026-11-04: drafts stay in Backlog until marked ready.
    // `opened` fires for a draft too, so without this the column would read
    // In review for work nobody has offered for review.
    const guard = ifLines.find(l => l.includes("draft"));
    expect(guard, `no 'if:' mentions draft; if: lines were ${JSON.stringify(ifLines)}`).toBeDefined();
    expect(guard!.includes("false")).toBe(true);
  });

  test("BI-3: no step checks out the pull request", () => {
    // `pull_request_target` runs with secrets in the BASE repository's
    // context. Checking out the head would execute a contributor's code with
    // a token that can write the board.
    const checkouts = usesLines.filter(l => l.includes("actions/checkout"));
    expect(checkouts).toEqual([]);
  });

  test("BI-4: no run block interpolates a value", () => {
    // The other half of the same property, and the easy one to reintroduce.
    // A `${{ ... }}` inside `run:` is substituted into the shell BEFORE it
    // executes, so a pull request title containing shell syntax is code.
    // Every value reaches this workflow through `env:`, where it is data.
    // Comments are NOT stripped here, deliberately: Actions interpolates a
    // `${{ }}` inside a shell comment too.
    const offenders = runBlocks().filter(b => b.includes("${{"));
    expect(offenders).toEqual([]);
  });
});
