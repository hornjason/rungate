/**
 * #1849 — a stage item verify command may not name a test that exists
 * nowhere.
 *
 * Its own file, not a block inside test/stage-ladder.test.ts, for one
 * mechanical reason: the retro improvement that claims this mechanism
 * carries a verify command, the ladder RUNS every such command, and a
 * command of the form `bun test <this file> -t …` spawns the suite it
 * is running inside. Living in the ladder suite, that was the ladder
 * spawning itself twice per run; both spawns were killed at the case
 * timeout and reported `exit null`, which reads as a mechanism that
 * regressed.
 *
 * The subject is lib/stage-ladder.ts all the same.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";
import { spawnSync } from "child_process";
import {
  titlePathsIn,
  titleReading,
  titlesIn,
  verifyTitleViolations,
  type Stage,
} from "../lib/stage-ladder.ts";

const ROOT = join(import.meta.dir, "..");
const doc = JSON.parse(readFileSync(join(ROOT, "project-state.json"), "utf-8")) as {
  goal: { statement: string; verify: string };
  stages: Stage[];
};
const stages = doc.stages;

/**
 * #1849 — a verify command may not name a test that does not exist.
 *
 * ## What was broken to prove these can fail
 *
 * The live plan is mutated in-process: one item's `-t` pattern is replaced
 * with a fabricated one and the decider is re-run against the SAME tree.
 * Exactly one violation appears and it names that item. Reverting restores
 * zero. That is AC-4, performed, not described.
 *
 * The premise this whole check rests on — what `bun test -t` matches
 * against — is not taken from the docs. `the matcher's own semantics`
 * below spawns bun against a planted two-level fixture and asserts all
 * five readings. Had that been assumed, the parser would have been built
 * for the reporter's `outer > inner` spelling, which bun does NOT match,
 * and every path pattern in the tree would have been refused.
 */
describe("#1849: a verify command names a test that exists", () => {
  /** A corpus a case can plant, so nothing here depends on the live tree. */
  const corpus = (files: Record<string, string>) => (f: string) => files[f] ?? null;

  /**
   * The fixtures are assembled from parts, never written as literals.
   *
   * `titlePathsIn` reads a file's TEXT, so a fixture spelled
   * `describe("outer group", …)` inside this file becomes one of THIS
   * file's title paths — and two live verify commands point at this file.
   * The literal version turned both of their readings from MATCHED into
   * UNMEASURED and planted two phantom names a future `-t` could match.
   * Caught by the last case in this block, which is here for that reason.
   */
  const D = "describe";
  const T = "test";
  const TWO_LEVEL =
    `import { ${D}, ${T} } from "bun:test";\n` +
    `${D}("outer group", () => {\n` +
    `  ${T}("inner case", () => {});\n` +
    `});\n`;

  test("the one case that must MATCH, so the refusals below are not vacuous", () => {
    const r = verifyTitleViolations(
      [{ where: "X1", verify: 'bun test a.test.ts -t "inner case"' }],
      corpus({ "a.test.ts": TWO_LEVEL }),
    );
    expect(r.violations).toEqual([]);
    expect(r.matched, "nothing matched, so every refusal below could be the parser failing open").toBe(1);
  });

  test("AC-1: a title no test declares is refused, statically", () => {
    const r = verifyTitleViolations(
      [{ where: "X1", verify: 'bun test a.test.ts -t "a case nobody wrote"' }],
      corpus({ "a.test.ts": TWO_LEVEL }),
    );
    expect(r.violations.length).toBe(1);
    expect(r.matched).toBe(0);
  });

  test("AC-2: the refusal names the item, the file and the unmatched title", () => {
    const [only] = verifyTitleViolations(
      [{ where: "C4", verify: 'bun test test/github-client.test.ts -t "SC-2613"' }],
      corpus({ "test/github-client.test.ts": TWO_LEVEL }),
    ).violations;
    expect(only).toContain("C4");
    expect(only).toContain("test/github-client.test.ts");
    expect(only).toContain("SC-2613");
  });

  test("AC-1: a file that does not exist is refused, not skipped", () => {
    const r = verifyTitleViolations([{ where: "X1", verify: 'bun test gone.test.ts -t "x"' }], corpus({}));
    expect(r.violations.length).toBe(1);
    expect(r.violations[0]).toContain("gone.test.ts");
  });

  test("AC-3: a command of another shape is counted, never silently passed", () => {
    const r = verifyTitleViolations(
      [{ where: "C5", verify: "grep -q 'STALE_CITATION' lib/finding-arbiter.ts" }],
      corpus({}),
    );
    expect(r.violations, "a shape this cannot read was treated as a defect").toEqual([]);
    expect(r.matched, "a shape this cannot read was treated as a pass").toBe(0);
    expect(r.outOfShape, "the unreadable shape vanished instead of being reported").toBe(1);
  });

  test("AC-3: an interpolated title makes the file UNMEASURED, and UNMEASURED does not refuse", () => {
    const interpolated = `${D}("g", () => { for (const c of cs) ${T}(\`\${c.name} works\`, () => {}); });`;
    const r = verifyTitleViolations(
      [{ where: "X1", verify: 'bun test a.test.ts -t "anything at all"' }],
      corpus({ "a.test.ts": interpolated }),
    );
    expect(r.violations, "a file whose names cannot be read produced a refusal — that is a false red").toEqual([]);
    expect(r.unmeasured.length).toBe(1);
    expect(r.unmeasured[0]).toContain("interpolation");
  });

  test("AC-1: every fragment of a CHAINED command is read, not just the first", () => {
    // C6 chains three. A check reading only the first is the population
    // defect this repository keeps paying for (#1818), so the case puts the
    // only bad fragment LAST.
    const r = verifyTitleViolations(
      [{ where: "C6", verify: 'bun test a.test.ts -t "inner case" && bun test a.test.ts -t "nobody wrote this"' }],
      corpus({ "a.test.ts": TWO_LEVEL }),
    );
    expect(r.matched).toBe(1);
    expect(r.violations.length).toBe(1);
    expect(r.violations[0]).toContain("nobody wrote this");
  });

  test("a describe's title reaches the paths of the tests it encloses", () => {
    // The first draft popped the enclosing describe at its own first child,
    // so all 41 paths in THIS file came out as bare test titles and a
    // pattern spanning the boundary would have been refused.
    const paths = titlePathsIn(TWO_LEVEL);
    expect(paths).not.toBeNull();
    expect(paths).toContain("outer group inner case");
  });

  test("the matcher's own semantics, read from bun and not from the docs", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-ladder-t-"));
    try {
      writeFileSync(join(dir, "x.test.ts"), TWO_LEVEL);
      const selects = (pattern: string) => {
        const r = spawnSync("bun", ["test", "x.test.ts", "-t", pattern], { cwd: dir, encoding: "utf-8" });
        return /^ 1 pass$/m.test(`${r.stdout}${r.stderr}`);
      };
      // The row that must be TRUE, or the four below are vacuous.
      expect(selects("inner case"), "bun selected nothing at all — this fixture never ran").toBe(true);
      expect(selects("outer group")).toBe(true);
      expect(selects("outer group inner case"), "the path is NOT space-joined — the parser's premise is wrong").toBe(true);
      expect(selects("outer group > inner case"), "bun matches the reporter's `>` spelling after all").toBe(false);
      expect(selects("group.*inner"), "-t is not a regular expression — titlePathsIn compares the wrong way").toBe(true);

      // And the parser agrees with the binary on every one of them.
      const paths = titlePathsIn(TWO_LEVEL)!;
      for (const p of ["inner case", "outer group", "outer group inner case", "group.*inner"]) {
        expect(paths.some(x => new RegExp(p).test(x)), `the parser disagrees with bun about ${JSON.stringify(p)}`).toBe(true);
      }
      expect(paths.some(x => new RegExp("outer group > inner case").test(x))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  /**
   * The token kinds the scanner must survive, one case each.
   *
   * Review of #1877 found that neither of the two original scanners knew
   * what a regex literal was, and traced the consequence exactly: the `"`
   * inside `/["x]/` opened a string that never closed, the enclosing `}`
   * was never seen, and a SIBLING test was recorded as nested inside a
   * describe whose body had ended. Not a refusal — a confident wrong
   * answer, which is the direction that lets a fabricated title read as
   * MATCHED.
   *
   * The population is enumerated here rather than repaired one member at
   * a time, because the finding named one member (#1818).
   */
  describe("the scanner's token kinds, one case each", () => {
    const paths = (src: string) => titlePathsIn(src);

    test("a regex holding a QUOTE does not swallow the closing brace — review's own trace", () => {
      // Verbatim from the finding. The idiom is live at
      // test/branch-cleanup-slug.test.ts.
      const src =
        `${D}("outer", () => {\n  const isQuote = /["x]/.${T}(ch);\n});\n` + `${T}("sibling", () => {});\n`;
      expect(paths(src), "the scanner gave up where it should have read on").not.toBeNull();
      expect(paths(src), "a sibling was adopted by a describe whose block had closed").toEqual([
        "outer",
        "sibling",
      ]);
    });

    test("a regex holding a BRACE does not move the depth", () => {
      const src = `${D}("outer", () => {\n  const open = /[{]/;\n  ${T}("inner", () => {});\n});\n`;
      expect(paths(src)).toEqual(["outer", "outer inner"]);
    });

    test("division is not read as a regex", () => {
      const src = `${D}("outer", () => {\n  const half = total / 2;\n  ${T}("inner", () => {});\n});\n`;
      expect(paths(src)).toEqual(["outer", "outer inner"]);
    });

    test("a brace inside a TITLE does not open a block", () => {
      const src = `${D}("a {curly} name", () => {\n  ${T}("inner", () => {});\n});\n${T}("after", () => {});\n`;
      expect(paths(src)).toEqual(["a {curly} name", "a {curly} name inner", "after"]);
    });

    test("an unterminated string is UNMEASURED, not a guess", () => {
      expect(paths(`${D}("outer", () => {\n  const broken = "no closing quote\n});\n`)).toBeNull();
    });

    test("an unterminated block comment is UNMEASURED", () => {
      expect(paths(`${D}("outer", () => {});\n/* never closed\n`)).toBeNull();
    });

    test("braces that do not balance are UNMEASURED — the guard that needs no foresight", () => {
      // This is the one that does not depend on having thought of the
      // token. Anything that knocks the scan off the rails ends unbalanced.
      expect(paths(`${D}("outer", () => {\n  ${T}("inner", () => {});\n`), "an unclosed block was read confidently")
        .toBeNull();
      expect(paths(`}\n${D}("outer", () => {});\n`), "a negative depth was read confidently").toBeNull();
    });

    test("a file the scanner cannot nest still yields its title literals", () => {
      // The re-scope. A nested template defeats the nesting parse, and the
      // check must degrade to "does any title literal match" rather than
      // dropping the file. `test/issue-file-overlap.test.ts` is the live
      // instance; it is named so this case fails loudly if it is ever
      // cleaned up and stops being an example.
      const src = readFileSync(join(ROOT, "test/issue-file-overlap.test.ts"), "utf-8");
      expect(titleReading(src).paths, "this file now nests cleanly — pick another unparseable example").toBeNull();
      expect(titlesIn(src).length, "a file the scanner cannot nest yielded no literals either").toBeGreaterThan(5);
      expect(
        verifyTitleViolations([{ where: "X", verify: 'bun test test/issue-file-overlap.test.ts -t "FO-1"' }], f =>
          f === "test/issue-file-overlap.test.ts" ? src : null,
        ).matched,
        "a real title in an unparseable file was not matched",
      ).toBe(1);
    });

    test("the whole repository's test corpus scans, and the two unmeasured causes are counted apart", () => {
      // A guard whose honest answer is UNMEASURED can pass by refusing
      // everything, so the share it can read is bounded here. The two
      // causes are counted SEPARATELY and only one of them is mine:
      // UNPARSEABLE is a scanner I have not finished, INTERPOLATED is a
      // table-driven suite whose names genuinely are not in the file.
      // Totalling them hid a 1%-of-corpus scanner bug inside a 17% number.
      const files = readdirSync(join(ROOT, "test"))
        .filter(f => f.endsWith(".test.ts"))
        .map(f => join("test", f));
      const readings = files.map(f => ({ f, r: titleReading(readFileSync(join(ROOT, f), "utf-8")) }));
      const unparseable = readings.filter(x => x.r.why === "UNPARSEABLE").map(x => x.f);
      const interpolated = readings.filter(x => x.r.why === "INTERPOLATED").length;

      expect(files.length, "no test files were found, so this case witnessed nothing").toBeGreaterThan(50);
      console.log(
        `  corpus (#1849): ${files.length} files — ${files.length - unparseable.length - interpolated} nested, ` +
          `${interpolated} interpolated, ${unparseable.length} unparseable`,
      );

      // The nesting parse is allowed to fail. What is NOT allowed is a
      // file contributing nothing at all, because that silently removes
      // it from the check. Every file must yield title literals.
      // A handful of suites build EVERY title at runtime — the conformity
      // and spec-drift generators have no literal in them at all. That is
      // honest, and `verifyTitleFragments` reports it as UNMEASURED rather
      // than passing. It is bounded because each one is a file any verify
      // command can name and none can be checked.
      const silent = files.filter(f => titlesIn(readFileSync(join(ROOT, f), "utf-8")).length === 0);
      expect(
        silent.length / files.length,
        `${silent.length} of ${files.length} test files state no title literal at all, so a verify command ` +
          `naming one is UNMEASURED however it is written: ${silent.join(", ")}`,
      ).toBeLessThan(0.02);

      // And the nesting parse is bounded, so a regression that quietly
      // stops nesting everything cannot pass as "degraded gracefully".
      expect(
        unparseable.length / files.length,
        `${unparseable.length} of ${files.length} files cannot be nested: ${unparseable.slice(0, 8).join(", ")}`,
      ).toBeLessThan(0.05);
    });
  });

  test("this suite's own fixtures do not become this file's title paths", () => {
    // Two live verify commands point at THIS file. A fixture written as a
    // literal lands in its own path set: it marked the file UNMEASURED
    // and added "outer group" and "outer group inner case" as names a
    // future `-t` could match here by accident.
    //
    // The path below is derived, not typed. When these cases lived in
    // test/stage-ladder.test.ts this case named that file by hand; the
    // block then moved here, the fixtures moved with it, and the hand-
    // typed path kept the case green against a file that no longer had
    // anything to find. A case that cannot follow its own subject is a
    // case that passes for free.
    const self = relative(ROOT, import.meta.path);
    const mine = titlePathsIn(readFileSync(join(ROOT, self), "utf-8"));
    expect(mine, `${self} reads as UNMEASURED, so every verify command naming it is unchecked`).not.toBeNull();
    expect(mine!.length, "this file states no title paths, so the loop below checks nothing").toBeGreaterThan(5);
    for (const phantom of ["outer group", "inner case", "${c.name} works"]) {
      expect(mine!.some(p => p.includes(phantom)), `the fixture name ${JSON.stringify(phantom)} is a title path of ${self}`)
        .toBe(false);
    }
  });

  test("AC-4: the live plan is clean, and a fabricated title reddens exactly its own item", () => {
    const read = (f: string) => {
      try {
        return readFileSync(join(ROOT, f), "utf-8");
      } catch {
        return null;
      }
    };
    // Every `where` is UNIQUE. A stage's improvements all shared the label
    // `B.retro` in the first draft, so the mutation looked its victim up by
    // `where` and got a DIFFERENT improvement with the same label — the
    // case then reported that the check could not fail, twice, while the
    // check was fine. A label is not a key.
    const commands = () => {
      const out: { where: string; verify: string | null }[] = [];
      for (const s of stages) {
        for (const i of s.items) out.push({ where: `${s.id}.${i.id}`, verify: i.verify });
        (s.retro?.improvements ?? []).forEach((im, n) =>
          out.push({ where: `${s.id}.retro[${n}]`, verify: im.verify }),
        );
      }
      out.push({ where: "goal", verify: doc.goal.verify });
      return out;
    };

    const base = verifyTitleViolations(commands(), read);
    expect(
      base.violations,
      "a verify command in the live plan names a test that does not exist. Either the test was renamed or " +
        "deleted, or the command names the wrong FILE — the runtime pass-count guard cannot see the second, " +
        "which is how C4 pointed at test/github-client.test.ts for eight days.",
    ).toEqual([]);
    expect(base.matched, "no fragment of the live plan is of this shape, so this case witnessed nothing")
      .toBeGreaterThan(0);
    for (const u of base.unmeasured) console.log(`  UNMEASURED (#1849): ${u}`);

    // THE MUTATION. One item's pattern is replaced with a name nothing
    // declares; the tree is untouched.
    //
    // The victim must be a fragment that currently MATCHES. The first
    // draft took the first command of the right SHAPE, which picked one
    // whose file was UNMEASURED — mutating it changed nothing and the
    // case reported that the check could not fail. It was right about the
    // fragment and wrong about the check, which is the shape a control has
    // to be chosen to avoid.
    const mutated = commands();
    const at = mutated.findIndex(
      c => c.verify !== null && verifyTitleViolations([c], read).matched === 1 && !/&&/.test(c.verify),
    );
    expect(at, "no single-fragment matching command exists to mutate").toBeGreaterThanOrEqual(0);
    const victim = mutated[at]!;
    const where = victim.where;
    victim.verify = victim.verify!.replace(/-t\s+(["']).*?\1/, '-t "a title nothing in this repository declares"');

    const after = verifyTitleViolations(mutated, read);
    expect(after.violations.length, "the fabricated title was not caught — this check cannot fail").toBe(1);
    expect(after.violations[0]).toContain(where);
    expect(after.matched, "the mutation changed more than the one fragment it was meant to").toBe(base.matched - 1);
  });
});
