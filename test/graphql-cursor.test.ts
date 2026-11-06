/**
 * Covers SC-2720, SC-2721 (specs/BOARD-FLOW-SPEC.md).
 *
 * ## The mutation battery, predicted before it was run
 *
 *   mutant                                       reading   predicted
 *   the hasNextPage type check dropped             2          2
 *   the endCursor non-empty check dropped          2          1
 *   the non-object guard dropped                   2          1
 *   `done` returned where `unreadable` belongs     5          3
 *
 * **Every miss is the same arithmetic error and it is worth naming.**
 * "every unreadable reading says why" loops over all four malformed
 * inputs, so it reddens for EVERY guard — each per-guard prediction is
 * one low by construction. The first row matched only by accident: I
 * counted two cases and the real two are the variant case plus that loop.
 *
 * Readings are in the PR body.
 *
 * **The census at the bottom is the half that matters.** Three variants of
 * one silent truncation were found on `lib/board-throughput.ts` one at a
 * time across two pull requests, while four sibling pagers held all three
 * — and ai-review had to point that out. A behavioural case per site would
 * have caught only the last one to regress
 * (`.claude/rules/checks-must-be-able-to-fail.md`). So the property is
 * asserted over the population instead.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { nextCursor } from "../lib/graphql-cursor";
import { sourceFiles } from "../lib/source-census";

describe("SC-2720: a page that cannot say is UNREADABLE, never done", () => {
  test("a well-formed last page is done", () => {
    expect(nextCursor({ hasNextPage: false, endCursor: null })).toEqual({ kind: "done" });
  });

  test("a well-formed page with more is a cursor", () => {
    expect(nextCursor({ hasNextPage: true, endCursor: "Y3Vyc29y" })).toEqual({
      kind: "more",
      cursor: "Y3Vyc29y",
    });
  });

  // The three variants, each found separately on one file. Together here
  // so the next one is found by the population and not by a reviewer.
  test("variant 1: an absent pageInfo is unreadable", () => {
    expect(nextCursor(undefined).kind).toBe("unreadable");
    expect(nextCursor(null).kind).toBe("unreadable");
  });

  test("variant 2: a pageInfo object with no hasNextPage is unreadable", () => {
    expect(nextCursor({}).kind).toBe("unreadable");
    expect(nextCursor({ endCursor: "abc" }).kind).toBe("unreadable");
    expect(nextCursor({ hasNextPage: "false" }).kind, "a string is not a boolean").toBe("unreadable");
  });

  test("variant 3: an EMPTY endCursor is unreadable, not done", () => {
    expect(
      nextCursor({ hasNextPage: true, endCursor: "" }),
      '`""` passes a typeof check and is falsy, so a loop guard admits it and then ends',
    ).toEqual({
      kind: "unreadable",
      why: "the page says more exist and gave no usable endCursor, so the rest cannot be fetched",
    });
  });

  test("a missing endCursor on a page that claims more is unreadable", () => {
    expect(nextCursor({ hasNextPage: true }).kind).toBe("unreadable");
    expect(nextCursor({ hasNextPage: true, endCursor: null }).kind).toBe("unreadable");
  });

  // An absent endCursor is irrelevant when there is nothing more to fetch,
  // and refusing it would make every terminal page UNMEASURED. The control
  // for the four cases above: they must not simply refuse everything.
  test("a last page needs no cursor", () => {
    expect(nextCursor({ hasNextPage: false }).kind).toBe("done");
    expect(nextCursor({ hasNextPage: false, endCursor: "" }).kind).toBe("done");
  });

  test("every unreadable reading says why", () => {
    for (const bad of [undefined, {}, { hasNextPage: 1 }, { hasNextPage: true, endCursor: "" }]) {
      const r = nextCursor(bad);
      expect(r.kind).toBe("unreadable");
      expect(
        r.kind === "unreadable" ? r.why.length : 0,
        "a refusal with no reason is a dead end for whoever reads the log",
      ).toBeGreaterThan(20);
    }
  });
});

describe("SC-2721: no pager advances a cursor on its own", () => {
  const ROOT = join(import.meta.dir, "..");
  /**
   * Where GraphQL pagers live. REST pagination follows `Link` headers and
   * is a different mechanism with a different failure, so it is not in
   * this population — `restAll` in `scripts/work-status.ts` is correct and
   * must not be swept in by a wider pattern.
   */
  const DIRS = ["lib", "scripts"];

  /** Source with `//` and `/* *\/` comments removed, so prose cannot match. */
  const codeOf = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  /**
   * **A PROPERTY ACCESS, not the query text.** The first version of this
   * matched `/hasNextPage[\s\S]{0,120}?endCursor/` and reported six
   * offenders — every one of them the GraphQL literal
   * `pageInfo{hasNextPage endCursor}`, which decides nothing. A query
   * string is not a decider, and a census that counts one is the
   * assert-on-commentary defect wearing a third face. The leading dots
   * are what make this read code.
   */
  const ADVANCE = /\.hasNextPage[\s\S]{0,120}?\.endCursor/;

  /**
   * The sites that still decide for themselves, with nothing new allowed.
   *
   * **An equality, not a maximum**: a file leaving the list fails the
   * suite as loudly as one joining it, so clearing a site means deleting
   * its entry in the same commit and the number can only go down
   * deliberately. None is in the files this pull request touches — those
   * five are swept — and widening further at round 2 is what
   * `AGENTS.md` rule 5 exists to stop. They are tracked as a follow-up.
   */
  const SELF_PAGING = ["lib/live-issues.ts", "scripts/board-mirror.ts", "scripts/board-status-sweep.ts"];

  test("no NEW file advances a cursor from hasNextPage itself", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(ROOT, DIRS)) {
      if (path === "lib/graphql-cursor.ts") continue;
      if (ADVANCE.test(codeOf(readFileSync(join(ROOT, path), "utf-8")))) offenders.push(path);
    }
    expect(
      offenders.sort(),
      "a file here decides 'is there another page' itself. Three variants of ONE silent " +
        "truncation were found one at a time on lib/board-throughput.ts across two pull " +
        "requests while its siblings held all three — route it through nextCursor() in " +
        "lib/graphql-cursor.ts, and delete its entry from SELF_PAGING in the same commit",
    ).toEqual([...SELF_PAGING].sort());
  });

  // Anti-vacuity: the scan above is worthless if it reads no files, and a
  // wrong directory name or a changed layout would make it green forever.
  test("the scan read the files it claims to police, SUBDIRECTORIES INCLUDED", () => {
    const seen = sourceFiles(ROOT, DIRS);
    expect(seen.length, "an empty population is not a clean one").toBeGreaterThan(50);
    // **A floor only a recursive walk can clear.** The old one was `> 50`
    // against a flat listing, which the flat listing passed — so the
    // eighteen files under lib/generators, lib/scaffold and lib/validators
    // could go unscanned forever with this test green. The count, not a
    // comment, is what makes the walk going flat again a red suite.
    expect(
      seen.filter(p => p.split("/").length > 2).length,
      "no nested file was listed, so the walk has gone flat again",
    ).toBeGreaterThan(10);
  });

  test("the scan can find the shape it looks for, and ignores the query text", () => {
    expect(
      ADVANCE.test(codeOf("const c = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;")),
      "the scan cannot see the expression it exists to find",
    ).toBe(true);
    // The control that the first version of this census failed. Six
    // "offenders" were all this literal.
    expect(
      ADVANCE.test(codeOf("const Q = `items(first:100){pageInfo{hasNextPage endCursor} nodes{id}}`;")),
      "a GraphQL query literal decides nothing and must not be counted as a pager",
    ).toBe(false);
  });

  test("the pagers that were swept actually call the decider", () => {
    for (const path of ["lib/board-throughput.ts", "scripts/board-ready.ts", "scripts/work-status.ts"]) {
      expect(readFileSync(join(ROOT, path), "utf-8"), `${path} stopped using the shared decider`).toContain(
        "nextCursor(",
      );
    }
  });
});
