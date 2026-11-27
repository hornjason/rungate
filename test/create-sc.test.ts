import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { matchPattern, type ParsedSC } from "../lib/conformity";
import { buildScRegistry } from "../lib/sc-ids";
import { behavioralStatement, formatSCLine, nextSCNumber, placeScLine, takenScNumbers } from "../lib/create-sc";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "create-sc.ts");
const SPECS_DIR = join(ROOT, "specs");

function runCreateSC(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("bun", [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env },
    timeout: 15000,
  });
  return {
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
    exitCode: result.status ?? 1,
  };
}

describe("create-sc CLI", () => {
  // AC-1: accepts --pattern and --params flags, generates SC text
  test("AC-1: generates SC text from --pattern and --params matching file-exists pattern", () => {
    const result = runCreateSC([
      "--pattern", "file-exists",
      "--params", JSON.stringify({ file: "AGENTS.md" }),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("exists");
    expect(result.stdout).toContain("AGENTS.md");
  });

  test("AC-1: generates SC text for content-contains pattern", () => {
    const result = runCreateSC([
      "--pattern", "content-contains",
      "--params", JSON.stringify({ file: "AGENTS.md", items: "Rules, Specs" }),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("AGENTS.md");
    expect(result.stdout).toContain("contains");
  });

  test("AC-1: generates SC text for dir-exists pattern", () => {
    const result = runCreateSC([
      "--pattern", "dir-exists",
      "--params", JSON.stringify({ dir: "specs" }),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("specs");
    expect(result.stdout).toContain("directory exists");
  });

  // AC-2: --list prints all 19 patterns with syntax and examples
  test("AC-2: --list prints all 19+ patterns with syntax and examples", () => {
    const result = runCreateSC(["--list"]);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n");
    // Count pattern entries (lines that contain both a pattern name format and syntax info)
    const patternLines = lines.filter(l => l.includes("syntax") || l.includes("example") || l.includes("Syntax") || l.includes("Example"));
    expect(patternLines.length).toBeGreaterThanOrEqual(19);
    // Verify some known patterns appear
    expect(result.stdout).toContain("file-exists");
    expect(result.stdout).toContain("dir-exists");
    expect(result.stdout).toContain("content-contains");
  });

  // AC-3: AGENTS.md generator Commands table includes create-sc
  test("AC-3: agents-md generator Commands table includes create-sc entry", () => {
    const generatorContent = readFileSync(join(ROOT, "lib", "generators", "agents-md.ts"), "utf-8");
    expect(generatorContent).toContain("create-sc");
  });

  // AC-4: Invalid pattern name produces clear error listing valid patterns
  test("AC-4: invalid pattern name produces error with valid pattern names", () => {
    const result = runCreateSC(["--pattern", "nonexistent-pattern"]);
    expect(result.exitCode).not.toBe(0);
    const output = result.stderr + result.stdout;
    expect(output).toContain("file-exists");
    expect(output).toContain("dir-exists");
    expect(output).toContain("content-contains");
  });

  // AC-5: Missing required params produces clear error
  test("AC-5: missing required params for file-exists produces error", () => {
    const result = runCreateSC(["--pattern", "file-exists"]);
    expect(result.exitCode).not.toBe(0);
    const output = result.stderr + result.stdout;
    expect(output.toLowerCase()).toMatch(/required|missing|param/);
  });

  test("AC-5: missing required params for content-contains produces error", () => {
    const result = runCreateSC(["--pattern", "content-contains"]);
    expect(result.exitCode).not.toBe(0);
    const output = result.stderr + result.stdout;
    expect(output.toLowerCase()).toMatch(/required|missing|param/);
  });

  // AC-6: With --spec flag, appends SC line to spec file with auto-incremented SC number
  describe("AC-6: --spec flag appends SC to spec file", () => {
    const tmpSpecDir = join(ROOT, "test", "fixtures", "create-sc-tmp");
    const tmpSpec = join(tmpSpecDir, "TEST-SPEC.md");

    beforeEach(() => {
      mkdirSync(tmpSpecDir, { recursive: true });
      writeFileSync(tmpSpec, `---
doc-type: spec
status: draft
testable: true
---

# Test Spec

## Success Criteria

- [ ] SC-100: some existing criterion
`);
    });

    afterEach(() => {
      if (existsSync(tmpSpecDir)) {
        rmSync(tmpSpecDir, { recursive: true });
      }
    });

    test("appends SC line with a number free across the whole namespace", () => {
      // This asserted `SC-101` — the number that follows the fixture's own
      // SC-100 — which encoded the per-file allocation that produced ten
      // cross-spec collisions (#392). The CLI now allocates above every id
      // `specs/` declares in any form, so the number is whatever is next
      // globally and pinning it would make this test a release blocker every
      // time an SC lands.
      //
      // What the test is actually for survives intact: an id was allocated,
      // it is not one the file already uses, and it is above it.
      const result = runCreateSC([
        "--pattern", "file-exists",
        "--params", JSON.stringify({ file: "README.md" }),
        "--spec", tmpSpec,
      ]);
      expect(result.exitCode).toBe(0);
      const content = readFileSync(tmpSpec, "utf-8");
      expect(content).toContain("SC-100");
      expect(content).toContain("README.md");
      expect(content).toContain("exists");

      const ids = [...content.matchAll(/- \[ \] SC-(\d+):/g)].map(m => Number(m[1]));
      expect(ids, "no SC line was appended").toHaveLength(2);
      expect(new Set(ids).size, "the existing id was reissued").toBe(2);
      expect(Math.max(...ids)).toBeGreaterThan(100);

      // And it is free in the real namespace, which is the property the
      // hardcoded 101 could not express — 101 is taken by a live spec.
      const taken = buildScRegistry(
        readdirSync(SPECS_DIR, { recursive: true, encoding: "utf-8" })
          .filter(f => f.endsWith(".md"))
          .map(f => ({ file: f, content: readFileSync(join(SPECS_DIR, f), "utf-8") })),
      ).declaredById;
      expect(taken.has(`SC-${Math.max(...ids)}`), "the CLI issued an id a spec already owns").toBe(false);
    },
    // Wider than the 15000ms `runCreateSC` allows the subprocess, deliberately
    // (#1132). This is the only case here that ALLOCATES, and allocation reads
    // every sibling worktree's `specs/` and every distinct `specs/` tree among
    // the branch refs — so its cost is proportional to how much work the
    // developer's machine has in flight, not to anything this case does. On
    // CI, one worktree and a fresh pack: 2864ms. On a machine holding 197
    // worktrees and 1638 refs: 7.2s, and 17.4s before #1132.
    //
    // At the default 5000ms the case budget was SMALLER than the subprocess
    // allowance, so the binding constraint was a bare "timed out after
    // 5000ms" and the 15000ms guard could never be the thing that reported.
    // Inverting them makes the failure mode deterministic: if the CLI
    // regresses past its allowance, `spawnSync` kills it and this fails on
    // `exitCode`, naming the allowance. The case budget is now only a
    // backstop, which is the most a wall-clock number can honestly be.
    30_000);
  });

  // AC-7: Without --spec flag, outputs SC text to stdout
  test("AC-7: without --spec, outputs SC text to stdout", () => {
    const result = runCreateSC([
      "--pattern", "file-exists",
      "--params", JSON.stringify({ file: "AGENTS.md" }),
    ]);
    expect(result.exitCode).toBe(0);
    // Output should contain SC- prefix and the statement
    expect(result.stdout).toContain("SC-");
    expect(result.stdout).toContain("AGENTS.md");
  });

  // AC-8: Generated SC text round-trips through matchPattern()
  describe("AC-8: round-trip through matchPattern()", () => {
    const patternsToTest: Array<{ pattern: string; params: Record<string, string> }> = [
      { pattern: "file-exists", params: { file: "AGENTS.md" } },
      { pattern: "dir-exists", params: { dir: "specs" } },
      { pattern: "content-contains", params: { file: "AGENTS.md", items: "Rules, Specs" } },
      { pattern: "section-exists", params: { file: "AGENTS.md", section: "Rules" } },
      { pattern: "pointer-exists", params: { file: "CLAUDE.md", target: "AGENTS.md" } },
      { pattern: "json-field-equals", params: { file: "package.json", field: "name", value: "rungate" } },
    ];

    for (const { pattern, params } of patternsToTest) {
      test(`${pattern} round-trips through matchPattern`, () => {
        const result = runCreateSC([
          "--pattern", pattern,
          "--params", JSON.stringify(params),
        ]);
        expect(result.exitCode).toBe(0);

        // Extract the SC statement from stdout (after "SC-NNN: ")
        const scLine = result.stdout.trim();
        const scMatch = scLine.match(/SC-(\d+):\s*(.+)/);
        expect(scMatch).not.toBeNull();

        const statement = scMatch![2].trim();
        const sc: ParsedSC = { id: "SC-9461", statement, specFile: "test.md" };
        const assertion = matchPattern(sc);
        expect(assertion).not.toBeNull();
      });
    }
  });
});

// ── create-spec SC validation tests ──────────────────────────

const CREATE_SPEC_SCRIPT = join(ROOT, "scripts", "create-spec.ts");

function runCreateSpec(args: string[], opts?: { input?: string }): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("bun", [CREATE_SPEC_SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env },
    timeout: 15000,
    input: opts?.input,
  });
  return {
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
    exitCode: result.status ?? 1,
  };
}

describe("create-spec SC validation", () => {
  const tmpSpecsDir = join(ROOT, "specs");
  const testSpecName = "CREATE-SPEC-VALIDATION-TEST-SPEC.md";
  const testSpecPath = join(tmpSpecsDir, testSpecName);

  afterEach(() => {
    // Clean up any test spec files
    if (existsSync(testSpecPath)) {
      rmSync(testSpecPath);
    }
  });

  // AC-6: create-spec with matchable SCs succeeds and writes the spec file
  test("create-spec with matchable SCs succeeds and writes spec file", () => {
    // Use --sc flag to pass SC lines that will be validated
    const result = runCreateSpec([
      "Create Spec Validation Test",
      "Testing SC validation",
      "--sc", "AGENTS.md exists",
    ]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(testSpecPath)).toBe(true);
    const content = readFileSync(testSpecPath, "utf-8");
    expect(content).toContain("AGENTS.md exists");
  });

  // AC-7: create-spec with unmatchable SC fails with exit code 1 and outputs pattern suggestions
  test("create-spec with unmatchable SC fails with exit code 1 and pattern suggestions", () => {
    const result = runCreateSpec([
      "Create Spec Validation Test",
      "Testing unmatchable SC",
      "--sc", "this is totally freeform garbage text that matches nothing",
    ]);
    expect(result.exitCode).toBe(1);
    expect(existsSync(testSpecPath)).toBe(false);
    const output = result.stdout + result.stderr;
    // Should suggest closest matching patterns
    expect(output).toMatch(/closest|suggest|pattern/i);
  });

  // AC-8: create-spec with behavioral SC tagged (behavioral) succeeds without matchPattern validation
  test("create-spec with behavioral SC tagged (behavioral) succeeds without validation", () => {
    const result = runCreateSpec([
      "Create Spec Validation Test",
      "Testing behavioral bypass",
      "--sc", "Agent reads AGENTS.md before starting work (behavioral)",
    ]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(testSpecPath)).toBe(true);
    const content = readFileSync(testSpecPath, "utf-8");
    expect(content).toContain("(behavioral)");
  });

  // AC-1: create-spec.ts imports matchPattern and validates SC lines
  test("create-spec.ts uses matchPattern from conformity to validate SCs", () => {
    const content = readFileSync(CREATE_SPEC_SCRIPT, "utf-8");
    expect(content).toContain("matchPattern");
  });

  // AC-2: Freeform SC text shows closest matching patterns
  test("freeform SC text that does not match produces error with closest patterns", () => {
    const result = runCreateSpec([
      "Create Spec Validation Test",
      "Testing error messages",
      "--sc", "something completely unrecognizable by any pattern",
    ]);
    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    // Should show pattern suggestions from matcher-registry.json
    expect(output).toMatch(/closest|suggest|pattern/i);
  });

  // AC-3: Behavioral SCs bypass matchPattern validation
  test("behavioral SCs bypass matchPattern validation and are saved", () => {
    const result = runCreateSpec([
      "Create Spec Validation Test",
      "Testing behavioral",
      "--sc", "Marcus follows TDD workflow (behavioral)",
    ]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(testSpecPath)).toBe(true);
  });

  // AC-4: Validation uses same matchPattern and loadRegistry as conformity engine
  test("create-spec uses matchPattern and loadRegistry from conformity, not duplicate logic", () => {
    const content = readFileSync(CREATE_SPEC_SCRIPT, "utf-8");
    // Should import from conformity or create-sc, not redefine patterns
    expect(content).toMatch(/matchPattern|loadRegistry/);
    // Should not contain raw regex pattern definitions
    expect(content).not.toContain("new RegExp(entry.regex");
  });

  // AC-5: Existing create-spec workflow preserved — title and governs still work
  test("existing create-spec workflow preserved — title and governs arguments still work", () => {
    const result = runCreateSpec([
      "Create Spec Validation Test",
      "Testing workflow preservation",
    ]);
    // Should succeed with exit code 0 when no --sc flags (just template)
    expect(result.exitCode).toBe(0);
    expect(existsSync(testSpecPath)).toBe(true);
    const content = readFileSync(testSpecPath, "utf-8");
    expect(content).toContain("doc-type: spec");
    expect(content).toContain("governs: Testing workflow preservation");
    expect(content).toContain("# Create Spec Validation Test");
  });

  // Mixed: matchable + unmatchable SCs — should fail
  test("mixed matchable and unmatchable SCs — fails on unmatchable", () => {
    const result = runCreateSpec([
      "Create Spec Validation Test",
      "Testing mixed SCs",
      "--sc", "AGENTS.md exists",
      "--sc", "this will not match anything at all",
    ]);
    expect(result.exitCode).toBe(1);
    expect(existsSync(testSpecPath)).toBe(false);
  });

  // Mixed: matchable + behavioral SCs — should succeed
  test("mixed matchable and behavioral SCs — succeeds", () => {
    const result = runCreateSpec([
      "Create Spec Validation Test",
      "Testing mixed success",
      "--sc", "AGENTS.md exists",
      "--sc", "Agent follows coding standards (behavioral)",
    ]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(testSpecPath)).toBe(true);
  });
});

/**
 * #2067: a fixture-range id in a spec's PROSE does not move the allocation.
 *
 * The fixture floor was honoured for ids spelled in source and ignored for
 * ids spelled in the spec itself, so one sentence citing `SC-9999` sent the
 * next criterion to `SC-10000`. ADR-015's promotions needed a reservation
 * every time to step around it. A spec DECLARATION stays authoritative at any
 * number: a fixture-range id the spec actually declares is still taken.
 */
describe("#2067: the spec's own fixture-range mentions are read the way source ones are", () => {
  const PROSE = "Ids at or above the floor, like SC-9999, are fixtures.\n";
  const DECLARED = "- [ ] SC-9999: lib/x.ts contains [x] — declared in the reserved range\n";

  test("a prose mention of SC-9999 does not push the next id to 10000", () => {
    expect(nextSCNumber(PROSE)).toBe(1);
    expect(nextSCNumber(`- [ ] SC-41: lib/x.ts contains [x] — y\n${PROSE}`)).toBe(42);
  });

  test("a fixture-range id the spec DECLARES is still taken", () => {
    expect(nextSCNumber(DECLARED)).toBe(10000);
    expect(nextSCNumber("### SC-9999: a heading declaration\n")).toBe(10000);
  });

  test("an INDENTED declaration is a declaration too — review of #2128", () => {
    // A sub-bullet checkbox declares as surely as a column-0 one. Missing it
    // would hand the id out again, the collision this exists to prevent; for
    // an allocator, counting too much as taken is the safe direction.
    expect(nextSCNumber("- [ ] SC-41: lib/x.ts contains [x] — y\n  - [ ] SC-9500: lib/y.ts contains [y] — nested\n")).toBe(9501);
    expect(takenScNumbers("    - [x] SC-9500: nested and ticked\n").has(9500)).toBe(true);
  });

  test("the free-id set agrees with the maximum about the same text", () => {
    expect(takenScNumbers(PROSE).has(9999)).toBe(false);
    expect(takenScNumbers(DECLARED).has(9999)).toBe(true);
  });
});

/**
 * #2845: ADR-027's two criteria were typed by hand, because `create-sc
 * --spec` appended after the spec's last section rather than its last
 * criterion, and could not write a `(behavioral)` criterion at all. It now
 * places the line after the last criterion's block, and `--behavioral` writes
 * the owner's sentence through the same allocator and the same bank write.
 */
describe("#2845: create-sc places a criterion after the last one, and --behavioral writes one as stated", () => {
  const SPEC = [
    "---",
    "doc-type: spec",
    "testable: true",
    "---",
    "",
    "# Fixture",
    "",
    "## Success Criteria",
    "",
    "- [ ] SC-9100: the first fixture criterion",
    "- [x] SC-9101: the second fixture criterion",
    "  proved-by: test/fixture.test.ts",
    "",
    "## Notes",
    "",
    "Prose after the criteria, and an example nobody should insert into:",
    "",
    "```md",
    "- [ ] SC-9199: an example inside a fence",
    "```",
    "",
  ].join("\n");
  const NEW = "- [ ] SC-9150: the placed line";

  test("the line goes straight after the last criterion's block, above the next section, and nothing else moves", () => {
    const out = placeScLine(SPEC, NEW);
    const lines = out.split("\n");
    expect(lines.indexOf(NEW), "placed somewhere other than after SC-9101's annotation").toBe(lines.indexOf("  proved-by: test/fixture.test.ts") + 1);
    expect(out.indexOf(NEW)).toBeLessThan(out.indexOf("## Notes"));
    expect(out.indexOf(NEW), "placed after a fenced example").toBeLessThan(out.indexOf("SC-9199"));
    expect(out.replace(NEW + "\n", "")).toBe(SPEC);
  });

  // Review round 1 of #2846: an indented fence under the last criterion reads
  // as its continuation up to the blank line inside the fence.
  test("a last criterion whose block opens a fence gets the line after the fence closes", () => {
    const fenced = ["# S", "", "- [ ] SC-9100: foo", "  ```sh", "  echo a", "", "  echo b", "  ```", "", "## Notes", ""].join("\n");
    const lines = placeScLine(fenced, NEW).split("\n");
    expect(lines.indexOf(NEW), "placed inside the example").toBe(lines.lastIndexOf("  ```") + 1);
  });

  // Review round 2 of #2846: three more places the line must not land.
  test("a comment the last criterion's block holds open is stepped past", () => {
    const commented = ["# S", "", "- [ ] SC-9100: foo", "<!-- REVIEW: long note", "continues -->", "", "## Notes", ""].join("\n");
    const lines = placeScLine(commented, NEW).split("\n");
    expect(lines.indexOf(NEW), "placed inside the comment").toBe(lines.indexOf("continues -->") + 1);
  });

  test("a CRLF spec gets the line after its last criterion, and stays CRLF", () => {
    const crlf = SPEC.replace(/\n/g, "\r\n");
    const out = placeScLine(crlf, NEW);
    expect(out.replace(/\r\n/g, ""), "a bare LF was written").not.toContain("\n");
    expect(out.indexOf(NEW)).toBeLessThan(out.indexOf("## Notes"));
    expect(out.replace(/\r\n/g, "\n")).toBe(placeScLine(SPEC, NEW));
  });

  test("a spec with a fence nothing closes is refused, criteria or not, naming the line", () => {
    const open = ["# S", "", "- [ ] SC-9100: foo", "  ```sh", "  echo a", ""].join("\n");
    expect(() => placeScLine(open, NEW)).toThrow(/line 4 that nothing closes/);
    expect(() => placeScLine("# Notes\n\n```md\nexample\n", NEW)).toThrow(/line 3 that nothing closes/);
  });

  // Review round 3 of #2846: placement reads the spec as it renders.
  test("a comment marker in a criterion's code span is code, and placement stays beside the criterion", () => {
    const spec = ["# S", "", "- [ ] SC-9107: the tool writes a `<!--` marker", "  needs: test-x", "", "## Notes", "", "Some text.", "<!-- a note -->", "", "## Later", ""].join("\n");
    const lines = placeScLine(spec, NEW).split("\n");
    expect(lines.indexOf(NEW), "walked to a later comment").toBe(lines.indexOf("  needs: test-x") + 1);
  });

  test("a criterion inside an HTML comment is not the last one, and the line lands after the comment, visible", () => {
    const spec = ["# S", "", "- [ ] SC-9101: a", "<!--", "- [ ] SC-9102: retired", "-->", "", "## Notes", ""].join("\n");
    const lines = placeScLine(spec, NEW).split("\n");
    expect(lines.indexOf(NEW), "placed inside the comment").toBe(lines.indexOf("-->") + 1);
  });

  // Review round 4 of #2846: endings are kept line by line.
  test("a mixed-ending spec changes by exactly the placed line, which takes the ending of the line it follows", () => {
    const mixed = "# S\r\n\n- [ ] SC-9100: a\r\n  needs: x\n\n## Notes\r\n";
    const out = placeScLine(mixed, NEW);
    expect(out).toBe("# S\r\n\n- [ ] SC-9100: a\r\n  needs: x\n" + NEW + "\n\n## Notes\r\n");
    const crlfLast = placeScLine("# S\n\n- [ ] SC-9100: a\r\n\n## Notes\n", NEW);
    expect(crlfLast).toBe("# S\n\n- [ ] SC-9100: a\r\n" + NEW + "\r\n\n## Notes\n");
    expect(placeScLine("# Nothing\r\n", NEW)).toBe("# Nothing\r\n" + NEW + "\r\n");
  });

  test("an HTML comment nothing closes is refused, naming the line", () => {
    expect(() => placeScLine("# S\n\n- [ ] SC-9100: a\n<!-- never closed\n", NEW)).toThrow(/an HTML comment at line 4 that nothing closes/);
  });

  test("a spec that states no criterion gets the line at its end, as before", () => {
    const bare = "---\ndoc-type: spec\n---\n\n# Nothing yet\n\n```md\n- [ ] SC-9198: only an example\n```\n";
    expect(placeScLine(bare, NEW)).toBe(bare.trimEnd() + "\n" + NEW + "\n");
  });

  test("behavioralStatement marks one sentence, and refuses an empty, multi-line or already-marked one", () => {
    expect(behavioralStatement("  X happens  ")).toBe("X happens (behavioral)");
    expect(formatSCLine(9150, behavioralStatement("X happens"))).toBe("- [ ] SC-9150: X happens (behavioral)");
    expect(() => behavioralStatement("   ")).toThrow(/sentence/);
    expect(() => behavioralStatement("X\nhappens")).toThrow(/one line/);
    expect(() => behavioralStatement("X happens (behavioral)")).toThrow(/adds the marker/);
  });

  test("the CLI places after the last criterion, and --behavioral is allocated exactly as a pattern write is", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-2845-create-sc-"));
    try {
      const a = join(dir, "A-SPEC.md");
      const b = join(dir, "B-SPEC.md");
      writeFileSync(a, SPEC);
      writeFileSync(b, SPEC);
      const pattern = runCreateSC(["--pattern", "file-exists", "--params", JSON.stringify({ file: "README.md" }), "--spec", a]);
      expect(pattern.exitCode, pattern.stderr).toBe(0);
      const behavioral = runCreateSC(["--behavioral", "X happens", "--spec", b]);
      expect(behavioral.exitCode, behavioral.stderr).toBe(0);
      const after = (file: string) => {
        const lines = readFileSync(file, "utf-8").split("\n");
        return lines[lines.indexOf("  proved-by: test/fixture.test.ts") + 1];
      };
      const pa = after(a).match(/^- \[ \] SC-(\d+): .*README\.md/);
      const pb = after(b).match(/^- \[ \] SC-(\d+): X happens \(behavioral\)$/);
      expect(pa, `pattern line not placed after the last criterion: ${after(a)}`).not.toBeNull();
      expect(pb, `behavioral line not placed or not as stated: ${after(b)}`).not.toBeNull();
      expect(pb![1], "the behavioural write took a different allocator").toBe(pa![1]);
      expect(readFileSync(b, "utf-8").replace(after(b) + "\n", "")).toBe(SPEC);

      // Review round 1 of #2846: a flag right after --behavioral is not its sentence.
      const before = readFileSync(b, "utf-8");
      const noSentence = runCreateSC(["--behavioral", "--spec", b]);
      expect(noSentence.exitCode).toBe(1);
      expect(noSentence.stderr).toContain("--behavioral needs the criterion's sentence");
      expect(readFileSync(b, "utf-8"), "a flag was written as a criterion").toBe(before);

      // Review round 2 of #2846: an unclosed fence is refused before anything is written.
      const openFence = join(dir, "OPEN-SPEC.md");
      writeFileSync(openFence, SPEC + "```md\nnever closed\n");
      const refused = runCreateSC(["--behavioral", "X happens", "--spec", openFence]);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain("nothing closes");
      expect(readFileSync(openFence, "utf-8")).toBe(SPEC + "```md\nnever closed\n");

      const both = runCreateSC(["--behavioral", "X happens", "--pattern", "file-exists", "--params", "{}", "--spec", b]);
      expect(both.exitCode).toBe(1);
      expect(both.stderr).toContain("--behavioral or --pattern");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

/**
 * Covers SC-2821 (CONFIG-DRIVEN-TESTING-SPEC.md), #2922, ADR-030 item 4.
 *
 * `create-sc` set its root to the package's own directory and was registered
 * without `projectRootFlag`, so run from a consumer it allocated against
 * rungate's packaged specs and reservation store, and moved rungate's bank.
 * The consumer below is ADR-030's reproduction: criteria 10 and 50, a reserved
 * block 200 to 210, and a deferred spec banked in its own tree. The ids are
 * built from constants, so this file never spells an id in rungate's
 * namespace: they are the scratch consumer's.
 */
describe("SC-2821: create-sc allocates, reads the reservation store and moves the deferral bank in the project it runs in", () => {
  const BIN = join(ROOT, "bin", "rungate.ts");
  const BANK = join(ROOT, ".claude", "spec-deferral-ratchet.json");
  const OWNER = "consumer-block";
  const [FIRST, SECOND, FROM, TO, OTHER] = [10, 50, 200, 210, 300];
  const line = (id: number, sentence: string) => `- [ ] SC-${id}: ${sentence} (behavioral)`;
  const scratch: string[] = [];
  afterEach(() => {
    for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const spec = (deferred: boolean) =>
    [
      "---",
      "doc-type: spec",
      "testable: true",
      ...(deferred ? ["board-scope: deferred"] : []),
      "---",
      "",
      "# Consumer",
      "",
      "## Success Criteria",
      "",
      `- [ ] SC-${FIRST}: the consumer's first criterion`,
      `- [ ] SC-${SECOND}: the consumer's second criterion`,
      "",
    ].join("\n");

  /** A consumer tree: one plain spec, one deferred spec in its own bank, and a reserved block. */
  function consumer(): string {
    const root = mkdtempSync(join(tmpdir(), "rg-2922-consumer-"));
    scratch.push(root);
    mkdirSync(join(root, "specs"), { recursive: true });
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, "specs", "PLAIN-SPEC.md"), spec(false));
    writeFileSync(join(root, "specs", "DEFERRED-SPEC.md"), spec(true));
    // A third spec holding the consumer's highest id, so a registry read from
    // the wrong tree shows in the number a no-block allocation gets.
    writeFileSync(join(root, "specs", "OTHER-SPEC.md"), ["# Other", "", "## Success Criteria", "", `- [ ] SC-${OTHER}: the consumer's highest`, ""].join("\n"));
    writeFileSync(
      join(root, "specs", "sc-reservations.json"),
      `${JSON.stringify({ reservations: [{ owner: OWNER, from: FROM, to: TO }] }, null, 2)}\n`,
    );
    writeFileSync(
      join(root, ".claude", "spec-deferral-ratchet.json"),
      `${JSON.stringify({ deferred: [{ path: "specs/DEFERRED-SPEC.md", criteria: 2 }] }, null, 2)}\n`,
    );
    return root;
  }

  /** As a consumer types it: the published entry point, from the consumer's directory. */
  const dispatched = (cwd: string, args: string[]) => {
    const r = spawnSync("bun", [BIN, "create-sc", ...args], { cwd, env: { ...process.env }, encoding: "utf-8", timeout: 60_000 });
    return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };

  test("from a consumer's directory, the id comes out of the consumer's reserved block and lands in its spec", () => {
    const root = consumer();
    const r = dispatched(root, ["--behavioral", "a consumer's new criterion", "--spec", "specs/PLAIN-SPEC.md", "--owner", OWNER]);
    expect(r.status, r.out).toBe(0);
    const after = readFileSync(join(root, "specs", "PLAIN-SPEC.md"), "utf-8");
    expect(after).toContain(line(FROM, "a consumer's new criterion"));
    expect(r.out).toContain(`owner: ${OWNER}`);
    expect(r.out, "the consumer's store was not the one read").not.toContain("reservation store could not be consulted");
  });

  test("an owner with no block gets an id above every block in the consumer's store and every id its specs state", () => {
    const root = consumer();
    const r = dispatched(root, ["--behavioral", "no block of its own", "--spec", "specs/PLAIN-SPEC.md", "--owner", "nobody"]);
    expect(r.status, r.out).toBe(0);
    expect(readFileSync(join(root, "specs", "PLAIN-SPEC.md"), "utf-8")).toContain(line(OTHER + 1, "no block of its own"));
  });

  test("a deferred consumer spec moves the consumer's bank by one, and rungate's own bank is untouched", () => {
    const root = consumer();
    const ours = readFileSync(BANK, "utf-8");
    const r = dispatched(root, ["--behavioral", "a deferred consumer criterion", "--spec", "specs/DEFERRED-SPEC.md", "--owner", OWNER]);
    expect(r.status, r.out).toBe(0);
    const bank = JSON.parse(readFileSync(join(root, ".claude", "spec-deferral-ratchet.json"), "utf-8"));
    expect(bank.deferred).toEqual([{ path: "specs/DEFERRED-SPEC.md", criteria: 3 }]);
    expect(readFileSync(BANK, "utf-8")).toBe(ours);
  });

  test("given --project-root from another directory, a relative --spec is the project's", () => {
    const root = consumer();
    const r = runCreateSC(["--behavioral", "named by its root", "--spec", "specs/PLAIN-SPEC.md", "--owner", OWNER, "--project-root", root]);
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(join(root, "specs", "PLAIN-SPEC.md"), "utf-8")).toContain(line(FROM, "named by its root"));
  });

  test("--project-root with no directory refuses, and writes nothing", () => {
    const root = consumer();
    const before = readFileSync(join(root, "specs", "PLAIN-SPEC.md"), "utf-8");
    const r = spawnSync("bun", [SCRIPT, "--behavioral", "x y z", "--spec", "specs/PLAIN-SPEC.md", "--project-root"], { cwd: root, encoding: "utf-8", timeout: 15_000 });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain("--project-root was given with no directory");
    expect(readFileSync(join(root, "specs", "PLAIN-SPEC.md"), "utf-8")).toBe(before);
  });
});
