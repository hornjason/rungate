/**
 * #2565: every table a rendered agent brief tells its agent to read exists in
 * the file the brief names, in the tree the scaffold renders.
 *
 * The discovery brief sent its agent to "the AGENTS.md routing table" and "the
 * AGENTS.md Specs table". The AGENTS.md the generator writes has neither: the
 * routing table is `.claude/rules/docs-routing.md`, the specs table is
 * `.claude/rules/specs-routing.md`. The discovery agent runs with
 * `omitClaudeMd`, so it had no second way to the table. It went looking,
 * found nothing, and sized the issue without the governing spec.
 *
 * The check is the issue's own statement, made over every brief rather than
 * the one line that was reported: a reference of the form `<file> <name>
 * table` or `<name> table in <file>` must land on a table in that file whose
 * header row or heading carries the name. And a `.claude/rules/` file a brief
 * names must be rendered, or the line must say what its absence means: the
 * specs rule is only written when the project has specs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { generateBriefTemplate } from "../lib/create-brief";
import { generateAgentBriefs } from "../lib/generators/agent-briefs";
import { generateAgentsMd, generateScopedRules } from "../lib/generators/agents-md";
import { scanProject } from "../lib/scanner";

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function project(withSpec: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "rg-brief-tables-"));
  scratch.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "brief-tables" }));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n");
  if (withSpec) {
    mkdirSync(join(root, "specs"), { recursive: true });
    writeFileSync(
      join(root, "specs", "ONE.md"),
      "---\ndoc-type: spec\ngoverns: the one area this fixture has\ntestable: true\n---\n\n# One\n",
    );
  }
  return root;
}

/** What the scaffold renders, keyed by project-relative path, and the briefs. */
function rendered(root: string): { tree: Map<string, string>; briefs: Record<string, string> } {
  const scan = scanProject(root);
  const tree = new Map<string, string>();
  tree.set("AGENTS.md", generateAgentsMd(scan));
  for (const rule of generateScopedRules(scan)) tree.set(`.claude/rules/${rule.filename}`, rule.content);
  return { tree, briefs: generateAgentBriefs(scan) };
}

interface TableRef {
  file: string;
  name: string;
  line: string;
}

/** `AGENTS.md Specs table` and `the Specs table in \`.claude/rules/specs-routing.md\``. */
function tableReferences(text: string): TableRef[] {
  const refs: TableRef[] = [];
  for (const line of text.split("\n")) {
    for (const m of line.matchAll(/`?([\w./-]+\.md)`?\s+([A-Za-z-]+)\s+table\b/g)) refs.push({ file: m[1]!, name: m[2]!, line });
    for (const m of line.matchAll(/\b([A-Za-z-]+)\s+table\s+in\s+`?([\w./-]+\.md)`?/g)) refs.push({ file: m[2]!, name: m[1]!, line });
  }
  return refs;
}

/** Each table's header row with the heading above it, lower-cased. */
function tablesIn(content: string): string[] {
  const out: string[] = [];
  let heading = "";
  let inTable = false;
  for (const line of content.split("\n")) {
    if (/^#{1,6}\s/.test(line)) heading = line;
    const isRow = line.trimStart().startsWith("|");
    if (isRow && !inTable) out.push(`${heading} ${line}`.toLowerCase());
    inTable = isRow;
  }
  return out;
}

function missingTables(tree: Map<string, string>, text: string): string[] {
  return tableReferences(text).flatMap(ref => {
    const content = tree.get(ref.file);
    if (content === undefined) return [`${ref.file} is not in the rendered tree: ${ref.line.trim()}`];
    const stem = ref.name.toLowerCase().replace(/s$/, "");
    return tablesIn(content).some(t => t.includes(stem))
      ? []
      : [`${ref.file} has no ${ref.name} table: ${ref.line.trim()}`];
  });
}

/** A `.claude/rules/*.md` path named on a line that does not say what its absence means. */
function unqualifiedRuleReads(tree: Map<string, string>, text: string): string[] {
  return text.split("\n").flatMap(line =>
    [...line.matchAll(/\.claude\/rules\/[\w-]+\.md/g)]
      .map(m => m[0])
      .filter(path => !tree.has(path) && !/\babsent\b|\bif it exists\b|\bwhen present\b/i.test(line))
      .map(path => `${path} is not rendered and the line does not say so: ${line.trim()}`),
  );
}

describe("#2565: a brief names only tables its agent can find", () => {
  test("BT-1: every table every rendered brief names exists in the file it names", () => {
    const { tree, briefs } = rendered(project(true));
    expect(Object.keys(briefs), "the generator rendered no discovery brief, so the case reads nothing").toContain("discovery");
    const all = Object.entries(briefs).flatMap(([role, text]) => missingTables(tree, text).map(m => `${role}: ${m}`));
    expect(all).toEqual([]);
  });

  test("BT-2: the discovery brief names the governing-spec table, so BT-1 has something to check", () => {
    const { briefs } = rendered(project(true));
    const refs = tableReferences(briefs.discovery!);
    expect(refs.length, "the discovery brief names no table at all").toBeGreaterThan(0);
    expect(refs.map(r => r.file)).toContain(".claude/rules/specs-routing.md");
  });

  test("BT-3: a project with no specs gets no specs rule, and the brief says what that means", () => {
    const { tree, briefs } = rendered(project(false));
    expect(tree.has(".claude/rules/specs-routing.md"), "the premise: no specs, no specs rule").toBe(false);
    const all = Object.entries(briefs).flatMap(([role, text]) => unqualifiedRuleReads(tree, text).map(m => `${role}: ${m}`));
    expect(all).toEqual([]);
  });

  test("BT-4: a brief created with create-brief names no missing table either", () => {
    const { tree } = rendered(project(true));
    expect(missingTables(tree, generateBriefTemplate("tester", "a role made for this case"))).toEqual([]);
  });

  test("BT-5: the check finds the reported defect when it is put back", () => {
    // A detector that matches nothing passes BT-1 vacuously.
    const { tree } = rendered(project(true));
    expect(missingTables(tree, "- Guess at file structure — use AGENTS.md routing table").length).toBe(1);
    expect(missingTables(tree, "3. **Governing spec** — look up in AGENTS.md Specs table based on issue area").length).toBe(1);
    expect(missingTables(tree, "find it in the Specs table in `.claude/rules/specs-routing.md`")).toEqual([]);
  });
});

describe("#2565: this repository's committed discovery brief", () => {
  test("BT-6: the committed brief names no AGENTS.md table", () => {
    const path = join(import.meta.dir, "..", ".claude", "agents", "discovery.md");
    expect(existsSync(path)).toBe(true);
    expect(tableReferences(readFileSync(path, "utf-8")).filter(r => r.file === "AGENTS.md")).toEqual([]);
  });
});
