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
  namesAreComplete,
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

  test("AC-1: a file that declares no test at all is refused, not excused", () => {
    // Round 4 of review. A file this can read in full, which simply
    // declares nothing, used to short-circuit to UNMEASURED on the count
    // of literals alone — before asking whether the names were knowable.
    // That is the C4 case exactly: a `-t` aimed at the wrong file. When
    // the wrong file happens to hold no tests, the refusal this mechanism
    // exists to produce became a reading that refuses nothing.
    const emptied = `import { ${D}, ${T} } from "bun:test";\n// every case here was deleted\n`;
    expect(namesAreComplete(emptied).complete, "the fixture is not the clean case it claims to be").toBe(true);
    const r = verifyTitleViolations(
      [{ where: "X1", verify: 'bun test a.test.ts -t "inner case"' }],
      corpus({ "a.test.ts": emptied }),
    );
    expect(r.violations.length, "a readable file declaring nothing did not refuse").toBe(1);
    expect(r.unmeasured, "a readable file was reported as unreadable").toEqual([]);
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

    test("the substitution walker decides regex-vs-division the same way the outer scanner does", () => {
      // Round 5, found independently by two reviewers. `endOfSubstitution`
      // held a SECOND copy of the regex-vs-division rule and it was the
      // copy that had not received round 3's two fixes — no `++`/`--`
      // merging and no trial-parse for `!`. Two deciders answering one
      // question is one decider plus a dead one, and no behavioural case
      // over the outer scanner could tell which was which.
      //
      // MEASURED before the fix: both rows below lost `inner` entirely and
      // reported `complete: false`, while the control kept all three. A
      // file that silently stops being checked is the false UNMEASURED.
      const BT = "`";
      const DL = "$";
      const withSub = (expr: string) =>
        `${D}("outer", () => {\n` +
        `  const s = ${BT}x${DL}{${expr}}y${BT};\n` +
        `  ${T}("inner", () => { void s; });\n` +
        `});\n`;

      expect(paths(withSub("i + 1")), "the control could not read a plain substitution").toEqual([
        "outer",
        "outer inner",
      ]);
      expect(
        paths(withSub("i++ / 2")),
        "postfix `++` then division inside `${…}` was read as a regex open",
      ).toEqual(["outer", "outer inner"]);
      expect(
        paths(withSub("a.b! / c")),
        "a non-null assertion then division inside `${…}` was read as a regex open",
      ).toEqual(["outer", "outer inner"]);
    });

    test("a declaration inside a STRING is not a declared name", () => {
      // Round 9, and the largest defect in this change. `forTitles` keeps
      // string content, because that is where a title lives — so a
      // fixture string holding declaration-shaped text was read as a
      // declaration and its title entered the file's name set. A `-t`
      // naming that string then reads MATCHED against a test that exists
      // nowhere, which is the C4 failure (#1849) one level deeper and the
      // one direction this mechanism may not be wrong in.
      //
      // Not latent, and the measurement is a DELTA rather than a claim
      // about the tree: against a copy of the module with the guard
      // short-circuited to `false`, `titlesIn` returns 163 names across
      // 45 files that it no longer returns — `"p1"`, `"${KEPT}"`,
      // `"zz-report"`, planted fixture titles — and 0 names that it did
      // not return before. The corpus case does NOT bound this; its four
      // counts are about completeness, not about spurious names. Saying
      // otherwise here would be the round-8 mistake again.
      //
      // The scanner already knows where every string is — it walks them
      // to mask `forDepth`. It just never said so. It does now, and a
      // declaration whose HEAD sits inside one is not a declaration.
      const Q = '"';
      const src =
        `${D}("outer", () => {\n` +
        `  const fixture = '${D}(${Q}phantom${Q}, () => {});';\n` +
        `  ${T}("inner", () => { void fixture; });\n` +
        `});\n`;
      expect(titlesIn(src), "a title inside a string fixture entered the name set").toEqual(["outer", "inner"]);
      expect(paths(src)).toEqual(["outer", "outer inner"]);
      expect(
        namesAreComplete(src).complete,
        "excluding string content made an ordinary file unreadable",
      ).toBe(true);
    });

    test("a title the title scan could not READ is UNMEASURED, not a dropped name", () => {
      // Round 8. The head agreement of round 7 made the two patterns
      // start the same way; it did not make them agree about the TITLE.
      // A template literal spanning two lines is legal JS, `TITLE_CALL`'s
      // content group has no `s` flag so it matches nothing, and the
      // unresolved scan — which reads only the character after the paren
      // — sees a backtick and calls the file readable.
      //
      // MEASURED before the fix: titles ["outer"], complete=true. A name
      // missing from a set reported WHOLE, which is the false refusal.
      //
      // The fix is not another spelling. The two now agree BEHAVIOURALLY:
      // a declaration whose first argument is a quote that the title
      // pattern did not match at that position is unresolved. That holds
      // for every future title shape without naming one.
      const BT = "`";
      const src =
        `${D}("outer", () => {\n` + `  ${T}(${BT}inner\n` + `name${BT}, () => {});\n` + `});\n`;
      const read = namesAreComplete(src);
      expect(
        read.complete,
        "a title this cannot read was reported as a name set known in full — that is a false refusal waiting",
      ).toBe(false);
      expect(titlesIn(src), "the readable title was lost along with the unreadable one").toContain("outer");
    });

    test("every spelling of a declaration HEAD is seen by the title scan", () => {
      // Rounds 6 and 7 each found one character on which the title scan
      // and the unresolved scan disagreed — the modifier chain, then the
      // space before the paren. Round 7's finding was round 6's with one
      // name replaced, which is the population I failed to sweep
      // (`.claude/rules/self-referential-tests.md`). So this is the
      // population, not the two instances: every head spelling, each
      // asserted to yield the SAME title set.
      //
      // The gap is damaging in one direction only. A head the title scan
      // cannot see contributes no name, while the unresolved scan — which
      // reads a quote as the first argument — calls the file readable. A
      // missing name in a set reported as WHOLE is a false refusal, and
      // everywhere else an unreadable declaration degrades to UNMEASURED.
      const heads = [
        `${T}(`,
        `${T} (`,
        `${T}.skip(`,
        `${T}.skip (`,
        `${T}.only.skip(`,
        `${T}.only.skip (`,
        `${T}\n  (`,
      ];
      for (const head of heads) {
        const src = `${D}("outer", () => {\n  ${head}"inner", () => {});\n});\n`;
        expect(paths(src), `the title scan could not see a declaration spelled ${JSON.stringify(head)}`).toEqual([
          "outer",
          "outer inner",
        ]);
        expect(
          namesAreComplete(src).complete,
          `${JSON.stringify(head)} dropped a title and still reported the name set whole`,
        ).toBe(true);
      }
    });

    test("a declaration's chained modifiers do not hide its title", () => {
      // Round 6. `TITLE_CALL` allowed ONE chained modifier and
      // `UNRESOLVED_CALL` allowed any number, so a two-modifier call with
      // a literal title fell between them: invisible to the title scan,
      // and not flagged unresolved either, because the unresolved scan saw
      // a quote as the first argument and called it readable.
      //
      // MEASURED before the fix: `test.only.skip("inner", …)` inside a
      // describe gave titles ["outer"] with complete=true — a name
      // missing from a set reported as whole, which turns a verify
      // command naming a test that DOES exist into a refusal. That is
      // the false-red direction this module exists to avoid.
      const one = `${D}("outer", () => {\n  ${T}.skip("inner", () => {});\n});\n`;
      const two = `${D}("outer", () => {\n  ${T}.only.skip("inner", () => {});\n});\n`;

      expect(paths(one), "the control lost a single-modifier declaration").toEqual(["outer", "outer inner"]);
      expect(paths(two), "a two-modifier declaration's title was dropped").toEqual(["outer", "outer inner"]);
      expect(
        namesAreComplete(two).complete,
        "a file with a dropped title still reported its names as whole",
      ).toBe(true);
    });

    test("a non-null assertion before a division is not a regex, even with a second slash on the line", () => {
      // Round 8, and the finding was against this module's own PROSE: the
      // docstring said `a.b! / c / d` "has no instance in this tree" and
      // `test/crc-reading.test.ts` has had one all along. I asserted an
      // absence without sweeping for it, and the whole "where this stops"
      // argument rested on it.
      //
      // The repair is the missing half of the `!` decision rather than a
      // token kind: the token BEFORE the `!` decides. A word that is not
      // a keyword, a `)`, a `]` or a digit ends an expression, so the `!`
      // is a non-null assertion and the `/` divides. Round 3's deleted
      // lookback asked the same question by LAST CHARACTER, which is why
      // `return` passed for an expression; asking it of the whole token
      // is the version that works.
      // Two consequences, both MEASURED on the old code. The live line
      // itself is harmless — the span it swallows holds no brace and no
      // declaration — so the fixtures are the two shapes where the same
      // misread does reach something, and the control is the same line
      // with the `!` removed.
      const around = (line: string) =>
        `${D}("outer", () => {\n${line}\n  ${T}("inner", () => {});\n});\n`;

      // Confidently wrong: a real declaration inside the swallowed span
      // vanishes and the file still reports its names as complete.
      const eaten = around(`  const u = z.a! / z.b; ${T}("swallowed", () => {}); const v = p / q;`);
      expect(titlesIn(eaten), "a declaration inside the swallowed span is still missing").toContain("swallowed");

      // Falsely UNMEASURED: the swallowed span takes a `{` with it, the
      // braces stop balancing, and a readable file stops being checked.
      const unbalanced = around("  if (z.a! / z.b > 1) { const u = x / y; }");
      expect(paths(unbalanced), "a readable file was still knocked into UNMEASURED").toEqual([
        "outer",
        "outer inner",
      ]);

      // The control: the same two lines with no `!` always read cleanly,
      // so neither row above can be green for an unrelated reason.
      expect(paths(around("  const u = z.a / z.b; const v = p / q;"))).toEqual(["outer", "outer inner"]);
      expect(paths(around("  if (z.a / z.b > 1) { const u = x / y; }"))).toEqual(["outer", "outer inner"]);

      // And the live line from test/crc-reading.test.ts, which the
      // docstring said did not exist.
      const live = around("  expect(z.oneRound! / z.passed).toBeCloseTo(1 / 3, 5);");
      expect(paths(live), "the live shape from test/crc-reading.test.ts was misread").toEqual([
        "outer",
        "outer inner",
      ]);

      // The other arm, which must not regress: `!` as negation still
      // opens a regex.
      const negated = `${D}("outer", () => {\n  const bad = !/\\bcwd\\s*:/.${T}(line);\n  ${T}("inner", () => { void bad; });\n});\n`;
      expect(paths(negated), "negation before a regex stopped being read as a regex").toEqual([
        "outer",
        "outer inner",
      ]);
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

    test("a nested template inside a substitution is read, not given up on", () => {
      // `${xs.map(p => \`-${p}\`)}` is ordinary here. The first attempt at
      // this was deleted for taking the unparseable corpus from 4 files to
      // 11; it knew about strings and comments and NOT about regexes, one
      // level down, which is the same blind spot the outer scanner had just
      // been fixed for. With the regex branch it reads cleanly.
      const src =
        `const body = (xs) => \`\${xs.map(p => \`- \${p}\`).join("\\n")}\`;\n` +
        `${D}("outer", () => {\n  ${T}("inner", () => {});\n});\n`;
      expect(titleReading(src).why, "a nested template still defeats the scanner").toBeNull();
      expect(titlePathsIn(src)).toEqual(["outer", "outer inner"]);

      // And the live instance that found it.
      const live = readFileSync(join(ROOT, "test/issue-file-overlap.test.ts"), "utf-8");
      expect(titleReading(live).why, "test/issue-file-overlap.test.ts still cannot be read").toBeNull();
    });

    test("a file the scan gives up on still yields the literals it DID read", () => {
      // The re-scope: an imperfect parse degrades rather than dropping the
      // file — but only as far as the scan actually got. The tail case
      // below is the other half of this pair.
      const broken = `${D}("before the break", () => {});\nconst s = "unterminated\n`;
      expect(titleReading(broken).why).toBe("UNPARSEABLE");
      expect(titlesIn(broken), "the prefix the scan completed was discarded too").toEqual(["before the break"]);
      expect(
        verifyTitleViolations([{ where: "X", verify: 'bun test b.test.ts -t "before the break"' }], corpus({ "b.test.ts": broken }))
          .matched,
        "a title the scan DID read was not matched",
      ).toBe(1);
    });

    test("a title in the UNSCANNED tail of a broken file is not a declared name", () => {
      // Review round 2, verbatim. `titlesIn` read the whole masked buffer
      // while ignoring `ok`, so when the scan bailed at the unterminated
      // string the trailing COMMENT was never blanked and "phantom title"
      // came back as a declared name — the literal fast path then reported
      // MATCHED for a test that exists nowhere. The mitigation for a
      // confidently-wrong answer was itself confidently wrong.
      const evil =
        `${D}("real one", () => {\n` +
        `  const s = "unterminated\n` +
        `});\n` +
        `// ${D}("phantom", () => { ${T}("phantom title", () => {}); });\n`;

      expect(titleReading(evil).why, "this fixture no longer breaks the scanner").toBe("UNPARSEABLE");
      expect(titlesIn(evil), "a name from the unmasked tail was returned as declared").toEqual(["real one"]);

      const r = verifyTitleViolations(
        [{ where: "X1", verify: 'bun test evil.test.ts -t "phantom title"' }],
        corpus({ "evil.test.ts": evil }),
      );
      expect(r.matched, "a phantom name inside a comment was reported MATCHED").toBe(0);
      expect(r.violations, "an unreadable file produced a refusal instead of UNMEASURED").toEqual([]);
      expect(r.unmeasured.length).toBe(1);
    });

    test("a test declared by .each is UNMEASURED, not a false refusal", () => {
      // The other round-2 finding. `test.each(CASES)("%s", fn)` has an
      // identifier where the title goes, so TITLE_CALL never saw it and a
      // verify naming one of its generated titles would have been refused
      // as NO_SUCH_TITLE — a red row for a test that exists.
      const each = `${D}("outer", () => {\n  ${T}.each(CASES)("%s is handled", () => {});\n});\n`;
      expect(namesAreComplete(each).complete).toBe(false);
      expect(namesAreComplete(each).why).toContain(".each");

      const r = verifyTitleViolations(
        [{ where: "X1", verify: 'bun test each.test.ts -t "widget is handled"' }],
        corpus({ "each.test.ts": each }),
      );
      expect(r.violations, "a test declared by .each was refused as nonexistent").toEqual([]);
      expect(r.unmeasured.length).toBe(1);
    });

    test("the SHAPE is enumerated, not the one spelling review named", () => {
      // `.each` was the instance. The population is any declaration whose
      // first argument is not a string literal.
      for (const body of [
        `${T}.each(CASES)("%s", () => {});`,
        `${T}.skipIf(cond)("a conditional case", () => {});`,
        `${T}(NAME_FROM_A_VARIABLE, () => {});`,
        `${D}.each(ROWS)("%s", () => {});`,
      ]) {
        expect(namesAreComplete(body).complete, `this spelling reads as fully known: ${body}`).toBe(false);
      }
      // And the ordinary form is still complete, or the four above are
      // passing because nothing is ever complete.
      expect(namesAreComplete(`${T}("an ordinary case", () => {});`).complete).toBe(true);
    });

    test("a regex after `return !` is a regex, not a division", () => {
      // Round 3. The old lookback asked whether the token before `!` ends
      // an expression BY ITS LAST CHARACTER, so `return` ended in "n" and
      // counted as one. The regex was read as division, the scan ran into
      // the pattern, and the pattern's real closing `/` was taken as a new
      // regex that never closed — one ordinary file became unreadable.
      // Live at test/unit/git-identity-isolation.test.ts:91.
      const src = `${D}("outer", () => {\n  const ok = () => { return !/\\bcwd\\s*:/.${T}(line) && x; };\n  ${T}("inner", () => {});\n});\n`;
      expect(titleReading(src).why, "an ordinary file reads as unparseable").toBeNull();
      expect(titlePathsIn(src)).toEqual(["outer", "outer inner"]);

      // And the control that keeps `!` honest: a non-null assertion
      // before a division must NOT be read as a regex.
      const nonNull = `${D}("outer", () => {\n  const r = a.b! / c;\n  ${T}("inner", () => {});\n});\n`;
      expect(titlePathsIn(nonNull), "a non-null assertion was read as a regex open").toEqual(["outer", "outer inner"]);
    });

    test("postfix ++ before a division does not swallow the declarations after it", () => {
      // Round 3, and the harmful version — the finding's own fixture was
      // benign, so this one puts a REAL declaration inside the span a
      // mis-read regex masks. Measured before the fix: ["outer",
      // "outer after"], a clean reading, and `swallowed` gone. A test
      // vanishing from the name set with no UNMEASURED signal is a false
      // refusal waiting to happen.
      const src =
        `${D}("outer", () => {\n  let i=0,n=2;\n` +
        `  const r = i++ / n;  ${T}("swallowed", () => {});  const z = 1/2;\n` +
        `  ${T}("after", () => {});\n});\n`;
      expect(titlePathsIn(src)).toEqual(["outer", "outer swallowed", "outer after"]);

      // The contrast that names the one variable: binary `+` must still
      // open a regex, or this case passes because nothing ever does.
      const binary = `${D}("outer", () => {\n  const m = 1 + /x/.${T}(s);\n  ${T}("inner", () => {});\n});\n`;
      expect(titlePathsIn(binary)).toEqual(["outer", "outer inner"]);
    });

    test("the whole corpus scans, and every cause of UNMEASURED is counted apart", () => {
      // A guard whose honest answer is UNMEASURED can pass by refusing to
      // read anything, so the corpus is split by CAUSE rather than
      // totalled. Totalling hid a 1%-of-corpus scanner bug inside a 17%
      // number, and review round 2 found a cause the previous split could
      // not see at all: a `.each` file also has ordinary titles, so it was
      // neither silent nor unparseable and fell through both bounds.
      // RECURSIVE. The first version read only the top level of test/,
      // which left 67 files — test/unit, test/types, test/helpers —
      // outside a bound asserted as `toEqual([])`. Round 3's one
      // confirmed unreadable file lived in exactly that gap, so the
      // instrument said zero while naming a scope that excluded the
      // instance. `fixtures/` is excluded deliberately: planted broken
      // sources are its job.
      const walk = (dir: string): string[] =>
        readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(e =>
          e.isDirectory()
            ? e.name === "fixtures"
              ? []
              : walk(join(dir, e.name))
            : e.name.endsWith(".test.ts")
              ? [join(dir, e.name)]
              : [],
        );
      const files = walk("test");
      expect(files.length, "no test files were found, so this case witnessed nothing").toBeGreaterThan(50);
      expect(
        files.some(f => f.startsWith("test/unit/")),
        "the sweep does not reach test/unit/, where round 3's one real instance was",
      ).toBe(true);

      const by = { complete: 0, unresolved: 0, interpolated: 0, unparseable: [] as string[] };
      for (const f of files) {
        const src = readFileSync(join(ROOT, f), "utf-8");
        const { complete, why } = namesAreComplete(src);
        if (complete) by.complete++;
        else if (why!.includes("scanner could not")) by.unparseable.push(f);
        else if (why!.includes(".each")) by.unresolved++;
        else by.interpolated++;
      }
      console.log(
        `  corpus (#1849): ${files.length} files — ${by.complete} fully known, ${by.unresolved} with a ` +
          `non-literal declaration, ${by.interpolated} interpolated, ${by.unparseable.length} unparseable`,
      );

      // The scanner has no excuse left. Each of these is a token kind it
      // does not know, and the four it had were all found this way.
      expect(
        by.unparseable,
        "a test file defeats the scanner. Add the token to the block above and teach scanSource — do not " +
          "raise this bound.",
      ).toEqual([]);

      // And it must still be reading most of the corpus, or it is passing
      // by calling everything unknowable.
      expect(
        by.complete / files.length,
        `only ${by.complete} of ${files.length} test files have a fully known name set`,
      ).toBeGreaterThan(0.6);
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
