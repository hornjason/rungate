/**
 * Covers SC-2644 (specs/BOARD-FLOW-SPEC.md).
 *
 * The spec's lane-purpose table is the thing the rest of that document is
 * derived from, and its last column is the only reason any lane is testable:
 * a lane with no stated cost of being wrong cannot be given a target, so it
 * acquires one by somebody's judgement later. Jason asked for exactly that
 * column on 2026-11-05 — *"what is it that we want from each swim lane?"* —
 * and a table that loses it silently reverts the spec to the lane names we
 * already had.
 *
 * This asserts over the POPULATION of lanes rather than spot-checking one.
 * A per-lane assertion would go green the moment somebody added a seventh
 * lane with an empty cost cell, which is the shape
 * `.claude/rules/checks-must-be-able-to-fail.md` calls a detector narrower
 * than what it detects.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const SPEC = join(ROOT, "specs/BOARD-FLOW-SPEC.md");

/** Every lane the purpose table names, with the cells that make it testable. */
function laneRows(markdown: string): { lane: string; cells: string[] }[] {
  const lines = markdown.split("\n");
  const header = lines.findIndex(l => l.includes("The question only it answers"));
  if (header === -1) return [];
  const rows: { lane: string; cells: string[] }[] = [];
  // header, then the `|---|` separator, then the body until the first
  // non-table line.
  for (let i = header + 2; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trimStart().startsWith("|")) break;
    const cells = line.split("|").slice(1, -1).map(c => c.trim());
    const lane = (cells[0] ?? "").replace(/\*/g, "").trim();
    if (lane !== "") rows.push({ lane, cells });
  }
  return rows;
}

describe("BOARD-FLOW-SPEC: every lane says what it is for and what it costs", () => {
  const raw = readFileSync(SPEC, "utf-8");
  const rows = laneRows(raw);
  // Emphasis stripped before any prose search. `is *not* assignment` and
  // `is not assignment` are the same claim, and a needle that only matches
  // one of them is a detector narrower than what it detects — it would go
  // green on a reformat that changed nothing.
  const md = raw.replace(/\*/g, "");

  // Anti-vacuity, and it comes first. An empty population satisfies every
  // `for` loop below it, so a reformat that broke the parser would read as
  // six compliant lanes — green on an exit code, witnessing nothing.
  test("SC-2644: the purpose table is found and names every lane", () => {
    expect(
      rows.map(r => r.lane).sort(),
      "the lane-purpose table did not parse — a reformat of specs/BOARD-FLOW-SPEC.md " +
        "silently empties every assertion below this one",
    ).toEqual(["Backlog", "Cancelled", "Done", "In progress", "In review", "Ready"]);
  });

  test("SC-2644: every lane states the cost of being wrong", () => {
    const silent = rows.filter(r => (r.cells.at(-1) ?? "").length < 20).map(r => r.lane);
    expect(
      silent,
      "a lane whose last column is empty or a stub cannot be given a target, so " +
        "nothing can later show it is wrong. Say what it costs, or drop the lane.",
    ).toEqual([]);
  });

  test("SC-2644: every lane states who writes the transition", () => {
    const unowned = rows.filter(r => (r.cells[4] ?? "").length < 4).map(r => r.lane);
    expect(
      unowned,
      "a lane with no named writer is the defect this spec was written about — " +
        "four repairs to the Ready lane were each reported as the fix by somebody " +
        "who had not run it. `does not exist today` is a legitimate answer; blank is not.",
    ).toEqual([]);
  });

  // The two lanes the research overturned our design for. Named explicitly,
  // because a general "every lane has a writer" check passes just as well
  // when these two quietly acquire the wrong one again.
  test("SC-2644: the spec records that assignment does not start work", () => {
    expect(
      md,
      "industry is consistent that no mainstream tool moves a card to In progress " +
        "on assignment — Jira and Linear both trigger on the worker's first physical act. " +
        "Removing this sentence reinstates #1758's original design.",
    ).toContain("not assignment");
  });

  test("SC-2644: the spec records that an unlimited mechanical Ready is a second Backlog", () => {
    expect(md).toContain("second Backlog");
  });
});
