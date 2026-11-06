/**
 * Covers SC-2732, SC-2733 (specs/BOARD-FLOW-SPEC.md).
 *
 * ## The mutation battery, predicted before it was run
 *
 *   mutant                                    predicted           read
 *   the directory descent removed             planted-file, depth   2
 *   topLevelOnly ignored (always recurse)     the declared-narrow   1
 *   the extension filter dropped              the extension case    1
 *
 * The first row is the one that matters: it is the live defect, restored.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { sourceFiles } from "../lib/source-census";

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

  test("each converted census imports the shared lister", async () => {
    const { readFileSync } = await import("fs");
    for (const path of CONVERTED) {
      expect(readFileSync(join(ROOT, path), "utf-8"), `${path} stopped using the shared lister`).toContain(
        "source-census",
      );
    }
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
