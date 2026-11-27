/**
 * Covers SC-2818 (SCAFFOLD-DECOMPOSITION-SPEC.md): rungate reports what is
 * typed by hand — quoted lists that name registered features, documents
 * nothing generates or checks, and hand-typed totals that disagree with the
 * registry (ADR-028, #2891).
 *
 * Each rule is a row in a table, and every row is a real file in a planted
 * git repository that the real scan reads. A row states what the scan must
 * report for that one file, so a rule that drifts names the row it broke.
 * The thresholds are ADR-028's, measured on the pilot consumer: a list counts
 * when 2 or more of its items, and 60% or more of them, are registered names.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { renderHandTyped, scanHandTyped, type HandTypedScan } from "../lib/hand-typed-scan";

const scratch = mkdtempSync(join(tmpdir(), "rungate-2891-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Six registered names; "café" is written in NFC. */
const REGISTRY = ["cases", "campaigns", "intel", "pipeline", "saleshub", "caf\u00e9"];

/** A git repository holding `files`, every one added to the index. */
function plant(files: Record<string, string>, after?: (root: string) => void): string {
  const root = mkdtempSync(join(scratch, "repo-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  for (const args of [["init", "-q"], ["add", "-A"]]) {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  }
  after?.(root);
  return root;
}

function measured(scan: HandTypedScan) {
  if (!scan.measured) throw new Error(`the scan was not measured: ${scan.why}`);
  return scan;
}

type ListRow = [file: string, text: string, want: Array<{ line: number; items: number; registered: number; unregistered: string[] }>];

const hit = (line: number, items: number, registered: number, unregistered: string[] = []) => ({ line, items, registered, unregistered });

const LIST_RULES: ListRow[] = [
  ["src/qualifies.ts", "export const TABS = ['cases', 'campaigns', 'intel'];\n", [hit(1, 3, 3)]],
  ["src/one-registered.ts", "export const A = ['cases', 'x', 'y'];\n", []],
  ["src/half.ts", "export const A = ['cases', 'campaigns', 'x', 'y'];\n", []],
  ["src/sixty.ts", "export const A = ['cases', 'campaigns', 'intel', 'x', 'y'];\n", [hit(1, 5, 3, ["x", "y"])]],
  ["src/fifty-five.ts", "export const A = ['cases', 'campaigns', 'intel', 'pipeline', 'saleshub', 'a', 'b', 'c', 'd'];\n", []],
  // A list in a registered feature's own definition is declared in code, not typed by hand.
  ["src/declared.ts", "export const m = defineModule({ name: 'cases', dependsOn: ['campaigns', 'intel'] });\n", []],
  ["src/other-name.ts", "export const c = { name: 'reports', uses: ['cases', 'campaigns'] };\n", [hit(1, 2, 2)]],
  ["src/computed-name.ts", "export const m = { name: k, uses: ['cases', 'campaigns'] };\n", [hit(1, 2, 2)]],
  ["src/nested.ts", "export const m = { name: 'cases', meta: { tags: ['campaigns', 'intel'] } };\n", [hit(1, 2, 2)]],
  // Only a list of quoted strings is a quoted list.
  ["src/mixed.ts", "export const A = [x, 'cases', 'campaigns'];\n", []],
  ["src/spread.ts", "export const A = [...x, 'cases', 'campaigns'];\n", []],
  ["src/holes.ts", "export const A = ['cases', , 'campaigns'];\n", []],
  ["src/template.ts", "export const A = [`cases`, `campaigns`];\n", [hit(1, 2, 2)]],
  ["src/template-expr.ts", "export const A = [`${x}`, 'cases', 'campaigns'];\n", []],
  ["src/nested-arrays.ts", "export const A = [['cases', 'campaigns'], ['intel', 'pipeline']];\n", [hit(1, 2, 2), hit(1, 2, 2)]],
  ["src/dup-stray.ts", "export const A = ['cases', 'campaigns', 'intel', 'x', 'x'];\n", [hit(1, 5, 3, ["x"])]],
  // A list naming one feature twice names one feature.
  ["src/dup-items.ts", "export const A = ['cases', 'cases', 'x'];\n", []],
  ["src/dup-registered.ts", "export const A = ['cases', 'cases', 'campaigns'];\n", [hit(1, 3, 3)]],
  // Code only: a comment and a type are not lists.
  ["src/comment.ts", "// ['cases', 'campaigns']\nexport const n = 1;\n", []],
  ["src/tuple.ts", "export type T = ['cases', 'campaigns'];\n", []],
  ["src/typed.ts", "export const A: string[] = ['cases', 'campaigns'];\n", [hit(1, 2, 2)]],
  ["src/dead.ts", "export const n = 1;\nif (false) { const A = ['cases', 'campaigns']; }\n", [hit(2, 2, 2)]],
  // Lines: the occurrence in the source, or 0 when the source holds the list where code does not.
  ["src/twice.ts", "export const A = ['cases', 'campaigns'];\nexport const n = 1;\nexport const B = ['cases', 'campaigns'];\n", [hit(1, 2, 2), hit(3, 2, 2)]],
  ["src/commented-copy.ts", "// was ['cases', 'campaigns']\nexport const A = ['cases', 'campaigns'];\n", [hit(0, 2, 2)]],
  ["src/multiline.ts", "export const n = 1;\nexport const A = [\n  'cases', // the first\n  /* then */ 'campaigns',\n];\n", [hit(2, 2, 2)]],
  ["src/escaped.ts", "export const A = ['cases', 'camp\\x61igns'];\n", [hit(1, 2, 2)]],
  ["src/tuple-and-escaped.ts", "type T = ['cases', 'campaigns'];\nexport const A = ['cases', 'camp\\x61igns'];\n", [hit(0, 2, 2)]],
  ["src/crlf-bom.ts", "\uFEFF// head\r\nexport const n = 1;\r\nexport const A = ['cases', 'campaigns'];\r\n", [hit(3, 2, 2)]],
  // Names compare as the same text however their accents are encoded.
  ["src/unicode.ts", "export const A = ['cafe\u0301', 'cases'];\n", [hit(1, 2, 2)]],
  // Every source extension, each through the reader that keeps its lines.
  ["src/view.tsx", "export const V = () => <Tabs names={['cases', 'campaigns']} />;\n", [hit(1, 2, 2)]],
  ["src/view2.jsx", "export const V = () => <Tabs names={['cases', 'campaigns']} />;\n", [hit(1, 2, 2)]],
  ["src/plain.mjs", "export const n = 1;\nexport default ['cases', 'campaigns'];\n", [hit(2, 2, 2)]],
  // Plain JavaScript is read as written, so its line is exact even when a comment holds a copy.
  ["src/commented.mjs", "// ['cases', 'campaigns']\nexport default ['cases', 'campaigns'];\n", [hit(2, 2, 2)]],
  ["src/old.cjs", "module.exports = {\n  tabs: ['cases', 'campaigns'],\n};\n", [hit(2, 2, 2)]],
  ["src/plain.js", "export const n = 1;\nexport const A = ['cases', 'campaigns'];\n", [hit(2, 2, 2)]],
  // JSX in a .js file, and sloppy CommonJS, are still read.
  ["src/app.js", "export const V = () => <Tabs names={['cases', 'campaigns']} />;\n", [hit(1, 2, 2)]],
  ["src/legacy.cjs", "var mode = 010;\nmodule.exports = ['cases', 'campaigns'];\n", [hit(2, 2, 2)]],
  ["src/legacy-copy.cjs", "// ['cases', 'campaigns']\nvar mode = 010;\nmodule.exports = ['cases', 'campaigns'];\n", [hit(3, 2, 2)]],
  ["src/module.mts", "export const A = ['cases', 'campaigns'] as const;\n", [hit(1, 2, 2)]],
  ["src/common.cts", "export const A = ['cases', 'campaigns'];\n", [hit(1, 2, 2)]],
  // What is not read: data, tests, and a file a generator wrote.
  ["src/data.json", '{"tabs": ["cases", "campaigns"]}\n', []],
  ["src/tabs.test.ts", "export const A = ['cases', 'campaigns'];\n", []],
  ["test/helpers/fixture.ts", "export const A = ['cases', 'campaigns'];\n", []],
  ["src/generated.ts", "// @generated by scripts/gen.ts\nexport const A = ['cases', 'campaigns'];\n", []],
  ["src/generated-said.ts", "// Generated by scripts/gen.ts. Do not edit.\nexport const A = ['cases', 'campaigns'];\n", []],
  ["src/regenerated.ts", "// This list is regenerated by hand when a module is added.\nexport const A = ['cases', 'campaigns'];\n", [hit(2, 2, 2)]],
  ["src/do-not-edit.ts", "/**\n * Do not edit these without updating the docs.\n */\nexport const A = ['cases', 'campaigns'];\n", [hit(4, 2, 2)]],
];

describe("SC-2818: rungate reports what is typed by hand", () => {
  describe("quoted lists that name registered features", () => {
    const root = plant(Object.fromEntries(LIST_RULES.map(([f, t]) => [f, t])), root => {
      writeFileSync(join(root, "src/untracked.ts"), "export const A = ['cases', 'campaigns'];\n");
    });
    const scan = measured(scanHandTyped(root, REGISTRY));

    test("every file reads without a refusal", () => {
      expect(scan.unmeasured).toEqual([]);
    });

    for (const [file, , want] of LIST_RULES) {
      test(`${file}`, () => {
        const got = scan.lists.filter(l => l.file === file).map(({ file: _, ...rest }) => rest);
        expect(got).toEqual(want);
      });
    }

    test("a file not in git's index is not read", () => {
      expect(scan.lists.filter(l => l.file === "src/untracked.ts")).toEqual([]);
    });

    test("the threshold is 2 or more registered items and at least 60% of them, over generated lists", () => {
      // A generated population with an oracle, so the boundary is exercised at
      // every size rather than at the rows someone thought to write.
      const files: Record<string, string> = {};
      const expected: Record<string, boolean> = {};
      for (let items = 1; items <= 12; items++) {
        for (let registered = 0; registered <= items; registered++) {
          const names = [
            ...Array.from({ length: registered }, (_, i) => REGISTRY[i % 5]),
            ...Array.from({ length: items - registered }, (_, i) => `other-${i}`),
          ];
          const file = `src/gen-${items}-${registered}.ts`;
          files[file] = `export const A = [${names.map(n => `'${n}'`).join(", ")}];\n`;
          expected[file] = registered >= 2 && registered / items >= 0.6;
        }
      }
      const genScan = measured(scanHandTyped(plant(files), REGISTRY));
      const got = Object.fromEntries(Object.keys(files).map(f => [f, genScan.lists.some(l => l.file === f)]));
      expect(got).toEqual(expected);
    });
  });

  describe("what could not be read is named, and the rest is still read", () => {
    const marker = join(scratch, "macro-ran");
    const macro = join(scratch, "mac.ts");
    writeFileSync(macro, `import { writeFileSync } from "fs";\nexport function m() { writeFileSync(${JSON.stringify(marker)}, "ran"); return 1; }\n`);
    const root = plant(
      {
        "src/good.ts": "export const A = ['cases', 'campaigns'];\n",
        "src/broken.ts": "export const = ;\n",
        "src/macro.ts": `import { m } from ${JSON.stringify(macro)} with { type: "macro" };\nexport const A = m();\n`,
        "src/locked.ts": "export const A = ['cases', 'campaigns'];\n",
        "src/target.ts": "export const n = 1;\n",
      },
      root => {
        symlinkSync(join(root, "src/good.ts"), join(root, "src/link.ts"));
        spawnSync("git", ["add", "-A"], { cwd: root });
        chmodSync(join(root, "src/locked.ts"), 0o000);
      },
    );
    const scan = measured(scanHandTyped(root, REGISTRY));
    const named = (file: string) => scan.unmeasured.filter(u => u.startsWith(`${file}:`));

    test("a file that does not parse is named", () => {
      expect(named("src/broken.ts")).toHaveLength(1);
    });

    test("a macro import is refused, never run", () => {
      expect(named("src/macro.ts")).toHaveLength(1);
      expect(existsSync(marker)).toBe(false);
    });

    test.skipIf(process.getuid?.() === 0)("a file that cannot be read is named", () => {
      expect(named("src/locked.ts")).toHaveLength(1);
    });

    test("a link is not followed, and the readable list is still reported", () => {
      expect(scan.lists.map(l => l.file).filter(f => f !== "src/locked.ts")).toEqual(["src/good.ts"]);
      expect(named("src/link.ts")).toEqual([]);
    });
  });

  type DocRow = [file: string, text: string, want: "generated-checked" | "generated-only" | "hand" | "not listed"];

  const DOC_RULES: DocRow[] = [
    ["docs/plain.md", "# Plain\n", "hand"],
    ["docs/alpha.md", "---\ngenerated-by: bun scripts/gen-alpha.ts\n---\n# A\n", "generated-checked"],
    ["docs/generator-key.md", "---\ngenerator: scripts/gen-key.ts\n---\n", "generated-checked"],
    ["docs/beta.md", "---\ngenerated-by: scripts/gen-beta.ts\n---\n", "generated-only"],
    ["docs/html.md", "<!-- auto-generated by a script -->\n# H\n", "generated-only"],
    ["docs/donotedit.md", "<!-- DO NOT EDIT -->\n# D\n", "generated-only"],
    ["docs/prose.md", "# P\n\nGenerated by `bun scripts/gen-prose.ts`. Do not edit by hand.\n", "generated-checked"],
    ["docs/comment-key.md", "<!-- generated-by: bun scripts/gen-comment.ts · sha: 1 -->\n# C\n", "generated-checked"],
    ["docs/sha.md", "---\ngenerated-sha: abc123\n---\n", "generated-only"],
    ["docs/status.md", "---\nstatus: generated\n---\n", "generated-only"],
    ["docs/late.md", `${"text\n".repeat(15)}<!-- auto-generated -->\n`, "hand"],
    ["docs/bullet.md", "# B\n\n* Do not edit the config by hand\n", "hand"],
    ["docs/bom.md", "\uFEFF---\r\ngenerated-by: scripts/gen-bom.ts\r\n---\r\n", "generated-only"],
    ["docs/bom-prose.md", "\uFEFFGenerated by `bun scripts/gen-bom-prose.ts`. Do not edit by hand.\n", "generated-only"],
    // A test that names the document but not its generator does not check it.
    ["docs/named-only.md", "---\ngenerated-by: scripts/gen-named.ts\n---\n", "generated-only"],
    // Whole names only: `build` is not named by `buildAll`.
    ["docs/out.md", "---\ngenerated-by: scripts/build.ts\n---\n", "generated-only"],
    // A name in a trailing comment, or inside a block comment, is not a check.
    ["docs/trail.md", "---\ngenerated-by: scripts/gen-trail.ts\n---\n", "generated-only"],
    ["docs/block.md", "---\ngenerated-by: scripts/gen-block.ts\n---\n", "generated-only"],
    ["docs/dupe.md", "---\ngenerated-by: scripts/gen-dupe.ts\n---\n", "generated-checked"],
    ["docs/js-only.md", "---\ngenerator: scripts/gen-js.ts\n---\n", "generated-only"],
    // A generator in any scripting language can be named.
    ["docs/gen-mts.md", "---\ngenerated-by: bun scripts/gen-x.mts\n---\n", "generated-checked"],
    ["docs/python.md", "<!-- generated-by: python3 tools/gen_py.py -->\n", "generated-checked"],
    // A key is a marker only in the frontmatter, which may run past the first lines.
    ["docs/guide.md", "# Guide\n\n```yaml\ngenerated-by: scripts/gen.ts\n```\n", "hand"],
    ["docs/long-front.md", `---\n${"k: v\n".repeat(16)}generated-by: scripts/gen-long.ts\n---\n`, "generated-only"],
    ["reference/old.md", "# Old\n", "not listed"],
    ["docs/archive/old.md", "# Old\n", "not listed"],
  ];

  describe("documents nothing generates or checks", () => {
    const root = plant({
      ...Object.fromEntries(DOC_RULES.map(([f, t]) => [f, t])),
      // A test checks a generated document when its code, not a comment, names
      // both the document and its generator.
      "test/docs.test.ts": [
        'import { render } from "../scripts/gen-alpha";',
        'const checked = ["alpha.md", "generator-key.md", "gen-key", "prose.md", "gen-prose", "comment-key.md", "gen-comment", "named-only.md"];',
        "// beta.md is written by gen-beta, named only in this comment",
        'import { buildAll } from "./x";',
        'const f = "out.md";',
        "const x = 1; // trail.md is written by gen-trail",
        "/*",
        "  block.md, gen-block",
        "*/",
        'const more = ["gen-mts.md", "gen-x", "python.md", "gen_py"];',
      ].join("\n"),
      // Plain JavaScript is read as written, and its comments are not code either.
      "test/plain.test.js": "// js-only.md is written by gen-js\nexport const n = 1;\n",
    // Bun runs a test acorn would refuse (an import named twice); it is still read.
    "test/dupe-import.test.ts": 'import { a, a } from "./x";\nconst d = ["dupe.md", "gen-dupe"];\n',
    });
    const scan = measured(scanHandTyped(root, REGISTRY));

    for (const [file, , want] of DOC_RULES) {
      test(`${file}`, () => {
        const doc = scan.documents.find(d => d.path === file);
        expect(doc?.class ?? "not listed").toBe(want);
      });
    }
  });

  type TotalRow = [text: string, want: number[]];

  const TOTAL_RULES: TotalRow[] = [
    ["All 9 features are registered.\n", [9]],
    ["All 6 features are registered.\n", []],
    ["We shipped 9 features in May.\n", []],
    ["All 3 of 9 features are live.\n", []],
    ["In total, of 9 features, two are live.\n", []],
    [`All of them: ${"x".repeat(100)} 9 features.\n`, []],
    ["All of them:\n9 features here.\n", []],
    ["9 features in total.\n", [9]],
    ["Overall 9 features.\n", []],
    ["All v2 features.\n", []],
    ["All 1,200 features.\n", []],
    ["All **9** features.\n", [9]],
    ["All 9 registered features.\n", [9]],
    ["All 9 features, and every 7 features.\n", [9, 7]],
    ["All 9 features, as of 2026-11-19.\n", []],
    ["intro\r\nEvery one of the 9 features\r\n", [9]],
  ];

  describe("hand-typed totals that disagree with the registry", () => {
    const files: Record<string, string> = {};
    TOTAL_RULES.forEach(([text], i) => (files[`docs/t${i}.md`] = text));
    files["docs/adr/history.md"] = "All 9 features.\n";
    files["docs/council/history.md"] = "All 9 features.\n";
    files["docs/research/history.md"] = "All 9 features.\n";
    files["docs/generated.md"] = "<!-- auto-generated -->\nAll 9 features.\n";
    files["docs/nouns.md"] = "The registry has 31 modules; in total 21 feature modules. All 9 features.\n";
    const root = plant(files);
    const scan = measured(scanHandTyped(root, REGISTRY));
    const says = (path: string) => scan.totals.filter(t => t.path === path).map(t => t.says);

    TOTAL_RULES.forEach(([text, want], i) => {
      test(JSON.stringify(text.slice(0, 60)), () => {
        expect(says(`docs/t${i}.md`)).toEqual(want);
      });
    });

    test("the line is the line the total is on", () => {
      expect(scan.totals.find(t => t.path === `docs/t${TOTAL_RULES.length - 1}.md`)?.line).toBe(2);
    });

    test("a historical record and a generated document are not read for totals", () => {
      for (const path of ["docs/adr/history.md", "docs/council/history.md", "docs/research/history.md", "docs/generated.md"]) expect(says(path)).toEqual([]);
    });

    test("the words for the registry's entries are the caller's", () => {
      expect(says("docs/nouns.md")).toEqual([9]);
      const modules = measured(scanHandTyped(root, REGISTRY, { nouns: ["modules", "feature modules"] }));
      expect(modules.totals.filter(t => t.path === "docs/nouns.md").map(t => t.says)).toEqual([31, 21]);
    });
  });

  describe("a scan that could not be taken says so", () => {
    test("outside a git repository", () => {
      const dir = mkdtempSync(join(scratch, "not-git-"));
      writeFileSync(join(dir, "a.ts"), "export const A = ['cases', 'campaigns'];\n");
      const scan = scanHandTyped(dir, REGISTRY);
      expect(scan.measured).toBe(false);
      expect(renderHandTyped(scan)).toStartWith("UNMEASURED:");
    });

    test("with no registered names to compare against", () => {
      const scan = scanHandTyped(plant({ "a.ts": "export const A = ['cases', 'campaigns'];\n" }), []);
      expect(scan.measured).toBe(false);
    });
  });

  describe("the report", () => {
    test("names every list, every document nothing checks, every total and every unread file", () => {
      const root = plant({
        "src/a.ts": "export const A = ['cases', 'campaigns', 'old-name'];\n",
        "src/broken.ts": "export const = ;\n",
        "docs/hand.md": "All 9 features.\n",
        "docs/gen.md": "<!-- auto-generated -->\n",
      });
      const text = renderHandTyped(scanHandTyped(root, REGISTRY));
      for (const piece of [
        "registry of 6",
        "a number of: features",
        "src/a.ts:1",
        "old-name",
        "docs/hand.md:1",
        "says 9",
        "docs/gen.md",
        "src/broken.ts",
      ])
        expect(text).toContain(piece);
    });
  });
});
