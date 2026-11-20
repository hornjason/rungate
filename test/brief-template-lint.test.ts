/**
 * #2567: the brief templates every consumer is scaffolded with carry no test
 * residue, number their lists without gaps, and say what a generated list is.
 *
 * Three defects reached every consumer's `.claude/agents/`:
 *
 * - `templates/agent-briefs/marcus.md` ended in `## CANARY_MARKER_FOR_SC354`.
 *   The SC-354 case appended it to the SHIPPED template and restored it in a
 *   `finally`; a run killed between the two, or two overlapping runs, left it
 *   there, and it was committed. That case now edits a temporary copy
 *   (`test/agent-brief-template.test.ts`), and BL-1 is what stops residue
 *   from any source reaching a consumer.
 * - Four Context lists went `1.` then `3.`. A reader cannot tell a gap from a
 *   missing item.
 * - `${SOURCE_DIRS}` rendered as bare bullets appended to the Testing Rules
 *   list, with nothing saying what the directories were.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

import { generateBriefTemplate } from "../lib/create-brief";
import { generateAgentBriefs } from "../lib/generators/agent-briefs";
import { mockProjectScan } from "../lib/generators/types";

const TEMPLATES = join(import.meta.dir, "..", "templates", "agent-briefs");
const templates = readdirSync(TEMPLATES)
  .filter(f => f.endsWith(".md"))
  .map(f => ({ name: f, text: readFileSync(join(TEMPLATES, f), "utf-8") }));

/**
 * Each run of ordered-list lines (blank lines allowed between items) must
 * count 1, 2, 3 … with no gap. Returns one line per run that does not.
 *
 * A `1.` starts a new run (review of #2577): two short lists separated by a
 * blank line are two lists, not one list that skipped from 2 back to 1. Any
 * other number continues the run, so `1. 2. (blank) 4.` is still a gap.
 */
export function skippedNumbering(text: string): string[] {
  const out: string[] = [];
  let run: number[] = [];
  let firstLine = "";
  const close = () => {
    if (run.length > 0 && run.some((n, i) => n !== i + 1)) out.push(`${run.join(", ")} — starting "${firstLine}"`);
    run = [];
  };
  for (const line of text.split("\n")) {
    const m = line.match(/^(\d+)\.\s/);
    if (m) {
      if (Number(m[1]) === 1) close();
      if (run.length === 0) firstLine = line.slice(0, 60);
      run.push(Number(m[1]));
    } else if (line.trim() !== "") close();
  }
  close();
  return out;
}

describe("#2567: the shipped brief templates", () => {
  test("BL-0: the lint reads every template, so the cases below are not passing over nothing", () => {
    expect(templates.map(t => t.name)).toEqual(expect.arrayContaining(["marcus.md", "aditi.md", "rook.md", "serena.md", "discovery.md"]));
  });

  test("BL-1: no template carries a test canary", () => {
    expect(templates.filter(t => /CANARY_MARKER/.test(t.text)).map(t => t.name)).toEqual([]);
  });

  test("BL-2: no template, and no create-brief template, numbers a list with a gap", () => {
    const all = [
      ...templates.flatMap(t => skippedNumbering(t.text).map(s => `${t.name}: ${s}`)),
      ...skippedNumbering(generateBriefTemplate("tester", "a role made for this case")).map(s => `create-brief: ${s}`),
    ];
    expect(all).toEqual([]);
  });

  test("BL-3: the gap detector finds the shape that shipped, and passes a clean list", () => {
    expect(skippedNumbering("1. **A** — x\n3. **B** — y\n").length).toBe(1);
    expect(skippedNumbering("1. a\n\n2. b\n3. c\n")).toEqual([]);
    expect(skippedNumbering("1. a\n2. b\n\nprose\n\n1. c\n2. d\n")).toEqual([]);
    // Two lists separated only by a blank line are two lists (review of #2577) …
    expect(skippedNumbering("1. a\n2. b\n\n1. c\n2. d\n")).toEqual([]);
    // … and a list that continues across a blank line still has to count on.
    expect(skippedNumbering("1. a\n2. b\n\n4. c\n").length).toBe(1);
  });
});

describe("#2567: a generated list is introduced, not bare", () => {
  function marcus(sourceDirs: string[]): string {
    const brief = generateAgentBriefs(mockProjectScan({ sourceDirs, harnessTemplatesDir: TEMPLATES })).marcus;
    expect(brief, "no marcus brief was rendered").toBeTruthy();
    return brief!;
  }

  test("BL-4: the source-directory list sits under a line saying what it is", () => {
    const lines = marcus(["lib", "src"]).split("\n");
    const first = lines.findIndex(l => l === "- `lib/`");
    expect(first, "the directory list did not render").toBeGreaterThan(0);
    let i = first - 1;
    while (i >= 0 && lines[i]!.trim() === "") i--;
    expect(lines[i]!, "the line above the directory list is another bullet, so nothing says what the list is").not.toMatch(/^\s*[-*]\s/);
    expect(lines[i]!.toLowerCase()).toContain("source");
  });

  test("BL-5: with no source directories there is no lead-in over nothing", () => {
    expect(marcus([]).toLowerCase()).not.toContain("source directories");
  });
});
