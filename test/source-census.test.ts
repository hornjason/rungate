/**
 * Covers SC-2732, SC-2733 (specs/BOARD-FLOW-SPEC.md).
 *
 * ## The mutation battery, predicted before it was run
 *
 *   mutant                                    predicted           read
 *   the directory descent removed             planted-file, depth   2
 *   topLevelOnly ignored (always recurse)     the declared-narrow   1
 *   the extension filter dropped              the extension case    1
 *   the ENOENT narrowing widened to `catch`   the non-ENOENT case   ?
 *
 * The first row is the one that matters: it is the live defect, restored.
 * The last row is ai-review round 1 of #1803 — the same silent-shrink
 * defect, in the module written to remove it.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ABSENT_DIRECTORY, sourceFiles } from "../lib/source-census";

describe("SC-2732: the population includes files in subdirectories", () => {
  let root: string;
  const setup = (): string => {
    root = mkdtempSync(join(tmpdir(), "rg-census-"));
    mkdirSync(join(root, "lib", "nested", "deeper"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "lib", "top.ts"), "");
    writeFileSync(join(root, "lib", "nested", "mid.ts"), "");
    writeFileSync(join(root, "lib", "nested", "deeper", "deep.ts"), "");
    writeFileSync(join(root, "lib", "notes.md"), "");
    writeFileSync(join(root, "scripts", "one.ts"), "");
    return root;
  };
  const teardown = () => rmSync(root, { recursive: true, force: true });

  // **The assertion that separates the fix from the bug.** A flat
  // `readdirSync` returns `top.ts` and nothing under `nested/`, and the
  // directory entry fails `endsWith(".ts")` so it is dropped in silence.
  // This is the eighteen files under lib/generators, lib/scaffold and
  // lib/validators, in miniature.
  test("a planted file in a subdirectory is found, at any depth", () => {
    const r = setup();
    try {
      const got = sourceFiles(r, ["lib", "scripts"]);
      expect(got).toEqual([
        "lib/nested/deeper/deep.ts",
        "lib/nested/mid.ts",
        "lib/top.ts",
        "scripts/one.ts",
      ]);
    } finally {
      teardown();
    }
  });

  test("a non-source file is not in the population", () => {
    const r = setup();
    try {
      expect(sourceFiles(r, ["lib"]).some(p => p.endsWith(".md"))).toBe(false);
      expect(sourceFiles(r, ["lib"], { ext: ".md" })).toEqual(["lib/notes.md"]);
    } finally {
      teardown();
    }
  });

  // For a census whose case NAME declares the narrow scope. Asserted so
  // the flag means what it says rather than being an unused option.
  test("topLevelOnly stops at the top level, and says so by returning less", () => {
    const r = setup();
    try {
      expect(sourceFiles(r, ["lib"], { topLevelOnly: true })).toEqual(["lib/top.ts"]);
      expect(
        sourceFiles(r, ["lib"]).length,
        "if these agree the flag is doing nothing and one of the two callers is wrong",
      ).toBeGreaterThan(sourceFiles(r, ["lib"], { topLevelOnly: true }).length);
    } finally {
      teardown();
    }
  });

  // A census naming a directory the tree has not got should fail on its
  // own empty population with its own message, not on an ENOENT from here.
  test("a directory that does not exist is skipped, not thrown on", () => {
    const r = setup();
    try {
      expect(sourceFiles(r, ["lib", "nope"])).toEqual([
        "lib/nested/deeper/deep.ts",
        "lib/nested/mid.ts",
        "lib/top.ts",
      ]);
    } finally {
      teardown();
    }
  });

  // **The other direction, and the control for the case above.** ai-review
  // round 1 of #1803: the catch was bare, so EACCES, EMFILE and a `dirs`
  // entry that is a file all read as "this directory is empty" and shrank
  // the population in silence — the fail-open shape in
  // `.claude/rules/checks-must-be-able-to-fail.md`, inside the module
  // written to remove a silent-shrink defect.
  //
  // ENOTDIR is used because it is plantable without mocking: `readdirSync`
  // on a regular file raises it. The error's `code` is asserted so a throw
  // for some unrelated reason cannot stand in for the refusal.
  test("a read error that is not ENOENT propagates, rather than reading as empty", () => {
    const r = setup();
    try {
      let code: string | undefined;
      expect(() => {
        try {
          sourceFiles(r, ["lib/top.ts"]);
        } catch (e) {
          code = (e as NodeJS.ErrnoException).code;
          throw e;
        }
      }, "a non-ENOENT read error was absorbed, so a short population reads as a clean one").toThrow();
      expect(code, "it threw, but not from the read this case is about").toBe("ENOTDIR");
      expect(ABSENT_DIRECTORY, "widening this absorbs every read error again").toBe("ENOENT");
    } finally {
      teardown();
    }
  });
});

describe("SC-2733: every census over lib/ and scripts/ reads one lister", () => {
  const ROOT = join(import.meta.dir, "..");

  // The four that scanned flat, found by enumerating rather than assuming:
  // two were named in the finding, `test/live-issues.test.ts` was not, and
  // `test/selection-path-safety.test.ts` declares its narrowness in its own
  // case name. A fifth candidate, `test/ticked-sc-cover.test.ts`, already
  // recursed via `{ recursive: true }` — a spelling the first version of
  // this enumeration did not look for, which is why it reported the wrong
  // number before this list was checked file by file.
  const CONVERTED = [
    "test/board-ready-rule.test.ts",
    "test/graphql-cursor.test.ts",
    "test/live-issues.test.ts",
    "test/selection-path-safety.test.ts",
  ];

  test("each converted census imports the shared lister", () => {
    for (const path of CONVERTED) {
      expect(readFileSync(join(ROOT, path), "utf-8"), `${path} stopped using the shared lister`).toContain(
        "source-census",
      );
    }
  });

  // **No caller rebuilds a path the lister already returned.**
  //
  // ai-review round 2 of #1803. `test/selection-path-safety.test.ts` kept
  // the `` `scripts/${name}` `` it needed when the value came from a bare
  // `readdirSync`, and emitted `scripts/scripts/foo.ts` into its own
  // failure message — the one diagnostic a future offender would read.
  // The outcome never moved, because the list it corrupts is asserted
  // empty, so no behavioural case over that file could have seen it.
  //
  // Swept rather than assumed: five call sites across four files, one
  // affected. The surviving match set is empty, and a re-prefix at any
  // caller puts it back.
  test("no caller of the shared lister re-prefixes a returned path", () => {
    const callers = readdirSync(join(ROOT, "test"))
      .filter(f => f.endsWith(".test.ts"))
      .filter(f => readFileSync(join(ROOT, "test", f), "utf-8").includes("lib/source-census"));
    expect(callers.length, "nothing imports the lister, so this scan is vacuous").toBeGreaterThan(3);
    const offenders: string[] = [];
    for (const f of callers) {
      const src = readFileSync(join(ROOT, "test", f), "utf-8");
      for (const line of src.split("\n")) {
        const t = line.trim();
        // Comment lines are skipped, and this very case is why: the
        // paragraph above quotes the offending expression, so a scan over
        // raw text reports the explanation as the defect. A real offender
        // written inside a comment is therefore missed — declared, not
        // discovered later.
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
        // Composed without a template literal on purpose: this file is in
        // its own population, and the first spelling reported its own
        // offender label. Exempting the scanner would have been the wrong
        // fix — a scan that cannot see itself is one nobody can trust.
        if (/`[^`]*\/\$\{/.test(t)) offenders.push(join("test", f) + ": " + t);
      }
    }
    expect(
      offenders,
      "sourceFiles returns a repo-relative path, so prefixing it with a directory emits " +
        "scripts/scripts/foo.ts. Push the value as it came.",
    ).toEqual([]);
  });

  // Anti-vacuity: the list above is worthless if it names files that are
  // not censuses, and the import assertion alone cannot tell.
  test("the shared lister actually reaches this repository's nested sources", () => {
    const got = sourceFiles(ROOT, ["lib", "scripts"]);
    expect(got.length, "an empty population is not a clean one").toBeGreaterThan(50);
    expect(
      got.filter(p => p.split("/").length > 2).length,
      "no nested file was listed, so the walk is flat and every census over it has a hole",
    ).toBeGreaterThan(10);
  });
});
