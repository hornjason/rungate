/**
 * #2932 (ADR-029 decision 4): one resolver finds the ship skill's folder, and
 * every source reader of a file in it goes through that resolver.
 *
 * Rounds 1 to 3 of ADR-029's review each found a reader of the folder that a
 * hand-kept list had missed, because three of them build the path from parts.
 * So the population is read from the tree: the last describe below strips
 * comments with the transpiler and refuses any other spelling of the folder's
 * path in non-test source, whole or in parts. The two tests that read the
 * folder, `gates/e2e-smoke.test.ts` and `gates/workflow.test.ts`, are in the
 * file list of ADR-029's last row, so tests join this population there.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { SHIP_SKILL_FOLDERS, shipSkillPath } from "../lib/ship-skill-folder";
import { validateAgentBrief } from "../lib/agent-brief-validation";
import { loadBriefPolicies } from "../gates/brief-assembler";

const REPO = join(import.meta.dir, "..");
const scratch: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "rg-2932-skill-"));
  scratch.push(d);
  return d;
}
afterEach(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});
function put(claudeDir: string, folder: string, file: string, text: string): string {
  const dir = join(claudeDir, "skills", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), text);
  return join(dir, file);
}

describe("#2932: the resolver looks in ship-issue first, then ship", () => {
  test("the folder names, new name first", () => {
    expect([...SHIP_SKILL_FOLDERS]).toEqual(["ship-issue", "ship"]);
  });

  test("only the old folder holds the file: the old folder's path", () => {
    const d = tmp();
    const old = put(d, "ship", "x.json", "{}");
    expect(shipSkillPath(d, "x.json")).toBe(old);
  });

  test("only the new folder holds it: the new folder's path", () => {
    const d = tmp();
    const neu = put(d, "ship-issue", "x.json", "{}");
    expect(shipSkillPath(d, "x.json")).toBe(neu);
  });

  test("both hold it: the new folder wins", () => {
    const d = tmp();
    put(d, "ship", "x.json", "{}");
    const neu = put(d, "ship-issue", "x.json", "{}");
    expect(shipSkillPath(d, "x.json")).toBe(neu);
  });

  test("neither holds it: the new folder's path, so a reader reporting absence names where it belongs", () => {
    const d = tmp();
    expect(shipSkillPath(d, "x.json")).toBe(join(d, "skills", "ship-issue", "x.json"));
  });
});

describe("#2932: the brief guard and the gates read brief policies through the resolver", () => {
  const POLICY = (name: string) =>
    JSON.stringify({ policies: { marcus: { requiredPatterns: [{ name, pattern: "zz-never-present-zz" }] } } });
  const brief = {
    tool_name: "Agent",
    tool_input: {
      prompt: ["## Context", "## Task", "## Verify", "## Report back"].join("\n\nContent here.\n\n"),
      subagent_type: "Engineer",
      mode: "bypassPermissions",
    },
  };
  const warned = (base: string) => {
    const work = join(base, "work");
    mkdirSync(work, { recursive: true });
    return validateAgentBrief(brief as never, work, base).outputs.filter(o => o.startsWith("BRIEF CONTENT WARN"));
  };

  test("the brief guard reads policies from ship-issue, from ship when only it has them, and prefers ship-issue", () => {
    const onlyNew = tmp();
    put(onlyNew, "ship-issue", "brief-policies.json", POLICY("from-new"));
    expect(warned(onlyNew).join("\n")).toContain("from-new");

    const onlyOld = tmp();
    put(onlyOld, "ship", "brief-policies.json", POLICY("from-old"));
    expect(warned(onlyOld).join("\n")).toContain("from-old");

    const both = tmp();
    put(both, "ship", "brief-policies.json", POLICY("from-old"));
    put(both, "ship-issue", "brief-policies.json", POLICY("from-new"));
    const both_ = warned(both).join("\n");
    expect(both_).toContain("from-new");
    expect(both_).not.toContain("from-old");
  });

  test("the gates' brief-policy override is read from ship-issue when it is there", () => {
    const home = tmp();
    put(join(home, ".claude"), "ship-issue", "brief-policies.json", JSON.stringify({ policies: { "rg-2932-agent": { requiredPatterns: [] } } }));
    const was = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(Object.keys(loadBriefPolicies().policies)).toContain("rg-2932-agent");
    } finally {
      if (was === undefined) delete process.env.HOME;
      else process.env.HOME = was;
    }
  });
});

describe("#2932: no source reader spells the skill folder's path outside the resolver", () => {
  // The path whole (`skills/ship/`, `skills/ship-issue/`) or in parts
  // (`"skills", "ship"`), in any quote. Comments are stripped first, so a
  // sentence that mentions the path is not a read.
  const SPELLING = /["'`]skills["'`]\s*,\s*["'`]ship(?:-issue)?["'`]|skills\/ship(?:-issue)?(?=[\/"'`])/g;
  type TranspilerOptions = ConstructorParameters<typeof Bun.Transpiler>[0];
  const transpilers = {
    ts: new Bun.Transpiler({ loader: "ts", macro: false } as unknown as TranspilerOptions),
    js: new Bun.Transpiler({ loader: "js", macro: false } as unknown as TranspilerOptions),
  };
  // The code of a file with its comments gone. A workflow script is the body
  // of a function (it returns at top level), so it is parsed inside one. A
  // file that parses neither way throws, naming itself: skipping it would
  // shrink the population without saying so.
  function codeOf(file: string, text: string): string {
    const t = file.endsWith(".ts") ? transpilers.ts : transpilers.js;
    try {
      return t.transformSync(text);
    } catch {
      try {
        return t.transformSync(`async function __body() {\n${text.replace(/^export /gm, "")}\n}`);
      } catch (e) {
        throw new Error(`${file} could not be parsed, so it was not read: ${String(e)}`);
      }
    }
  }
  const OWNER = "lib/ship-skill-folder.ts";

  function spellings(files: string[], read: (f: string) => string): string[] {
    const hits: string[] = [];
    for (const f of files) {
      // Matched over the whole file, so a path split across lines is one hit.
      const code = codeOf(f, read(f));
      for (const m of code.matchAll(SPELLING)) {
        const around = code.slice(Math.max(0, m.index - 60), m.index + m[0].length + 30);
        hits.push(`${f}: ${around.replace(/\s+/g, " ").trim()}`);
      }
    }
    return hits;
  }

  test("every non-test source file under lib, gates, hooks, scripts, bin and workflows reads the folder through the resolver", () => {
    // late-env-ok: git ls-files reads the index of REPO and no variable this
    // file writes. The HOME write is the brief-policy case, which calls an
    // in-process function and restores HOME in a finally.
    const source = execFileSync("git", ["ls-files", "-z", "--", "lib", "gates", "hooks", "scripts", "bin", "workflows"], { cwd: REPO, encoding: "utf-8" })
      .split("\0")
      .filter(f => /\.(ts|js|mjs)$/.test(f) && !/\.test\.(ts|js)$/.test(f));
    // The one file let off is a real file in the population, so renaming it
    // cannot quietly widen the exemption to nothing or to something else.
    expect(source).toContain(OWNER);
    const listed = source.filter(f => f !== OWNER);
    expect(listed.length, "no source files listed, so this case measured nothing").toBeGreaterThan(100);
    expect(spellings(listed, f => readFileSync(join(REPO, f), "utf-8"))).toEqual([]);
  });

  test("the detector sees the path whole, in parts and in either name, and not in a comment", () => {
    const planted: Record<string, string> = {
      "parts.ts": `const p = join(base, "skills", "ship", "x.json");`,
      "single.ts": `const p = join(base, 'skills', 'ship-issue', 'x.json');`,
      "whole.ts": "const p = `${home}/.claude/skills/ship/x.json`;",
      "comment.ts": `// reads ~/.claude/skills/ship/x.json\nexport const a = 1;`,
      "other.ts": `const p = join(base, "skills", "shipping", "x.json");`,
      "lines.ts": `const p = join(\n  base,\n  "skills",\n  "ship",\n  "x.json",\n);`,
      // Shaped like a real workflow: it awaits and returns at top level.
      "workflow.js": `export const meta = { name: "x" };\nconst r = await agent("x");\nconst p = join(base, "skills", "ship", "x.json");\nreturn { r, p };`,
    };
    const hits = spellings(Object.keys(planted), f => planted[f]!);
    expect(hits.map(h => h.split(":")[0]).sort()).toEqual(["lines.ts", "parts.ts", "single.ts", "whole.ts", "workflow.js"]);
  });

  test("a file that cannot be parsed fails the scan by name, rather than being read as clean", () => {
    expect(() => spellings(["broken.ts"], () => "const = = ;")).toThrow(/broken\.ts could not be parsed/);
  });
});
