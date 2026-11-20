/**
 * #2566: the docs-routing rule carries no count a normal commit can make
 * wrong, and routes only to directories that exist.
 *
 * `.claude/rules/docs-routing.md` loads in every session. Its rows read like
 * `Specs — … (5 files)`, counted at scaffold time and stale after the next
 * commit that adds a spec: one consumer's table said `specs/ (1 files)` over a
 * directory holding 5, and `docs/adr/ (35 files)` over 45. In this repository
 * every new doc made the committed rule disagree with a re-scaffold, and the
 * fixed-point check (#827) went red until somebody regenerated it. And a
 * category the project never had (`docs/council/`) still got a row.
 *
 * Both writers are covered: `generateAgentsMdContent` in the scaffold, which
 * is what writes the file, and `scanProject` in the scanner, which feeds the
 * same table elsewhere. #91's concern, a row reading "(0 files)" as an
 * instruction not to look, goes with the count.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { generateAgentsMdContent } from "../lib/scaffold/steps";
import { scanProject } from "../lib/scanner";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rg-docs-routing-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "routing-proj" }));
  mkdirSync(join(dir, "specs"), { recursive: true });
  writeFileSync(join(dir, "specs", "ONE.md"), "# One");
  mkdirSync(join(dir, "docs", "research", "deep"), { recursive: true });
  writeFileSync(join(dir, "docs", "research", "deep", "r.md"), "# R");
  mkdirSync(join(dir, "docs", "notes"), { recursive: true });
  writeFileSync(join(dir, "docs", "notes", "n.md"), "# N");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const COUNT = /\(\d+ files?\)/;

describe("#2566: the scaffold's docs-routing rule", () => {
  function rule(): string {
    generateAgentsMdContent(dir, "code", [], "full");
    const path = join(dir, ".claude", "rules", "docs-routing.md");
    expect(existsSync(path), "the scaffold wrote no docs-routing rule").toBe(true);
    return readFileSync(path, "utf-8");
  }
  const routingRows = (text: string) =>
    text.split("## Where to Create Things")[0]!.split("\n").filter(l => l.startsWith("| ") && !l.startsWith("|---"));

  test("DR-1: no row states a file count", () => {
    const rows = routingRows(rule());
    expect(rows.some(r => r.includes("`specs/`")), "the specs row is missing, so the case reads nothing").toBe(true);
    expect(rows.filter(r => COUNT.test(r))).toEqual([]);
  });

  test("DR-2: a category directory the project does not have gets no routing row", () => {
    const rows = routingRows(rule());
    expect(rows.filter(r => r.includes("`docs/council/`") || r.includes("`docs/adr/`"))).toEqual([]);
  });

  test("DR-3: a nested-only category and an uncategorised docs folder are still routed", () => {
    const rows = routingRows(rule());
    expect(rows.some(r => r.includes("`docs/research/`"))).toBe(true);
    expect(rows.some(r => r.includes("`docs/notes/`"))).toBe(true);
  });

  test("DR-3b: an uncategorised docs folder whose markdown is all nested is routed too (review of #2573)", () => {
    mkdirSync(join(dir, "docs", "minutes", "2026"), { recursive: true });
    writeFileSync(join(dir, "docs", "minutes", "2026", "m.md"), "# M");
    expect(routingRows(rule()).some(r => r.includes("`docs/minutes/`"))).toBe(true);
    expect(scanProject(dir).docRouting.map(r => r.file)).toContain("docs/minutes/");
  });

  test("DR-4: adding a file changes nothing the rule says", () => {
    const before = rule();
    writeFileSync(join(dir, "specs", "TWO.md"), "# Two");
    expect(rule()).toBe(before);
  });
});

describe("#2566: the scanner's routing rows", () => {
  test("DR-5: no count, and no row for a category that does not exist", () => {
    const rows = scanProject(dir).docRouting;
    expect(rows.filter(r => COUNT.test(r.need))).toEqual([]);
    expect(rows.map(r => r.file)).not.toContain("docs/council/");
    expect(rows.map(r => r.file)).toContain("specs/");
  });
});
