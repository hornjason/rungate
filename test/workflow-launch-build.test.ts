/**
 * #2287 / SC-2772: the ship launch file is generated from `workflows/ship.js`,
 * parses, keeps the `meta` literal and the top-level `return`, and is under
 * the Workflow tool's 524,288-byte cap (ADR-017 Decision 1).
 *
 * `ship.js` is 556,509 bytes on the day this landed (#2213), so no consumer
 * could launch it. The launch file drops comments and keeps every other
 * token; the strongest case below proves that by comparing the two token
 * streams, so "only comments were removed" is measured rather than claimed.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";

import {
  buildWorkflowLaunch,
  GENERATED_NOTICE,
  hasTopLevelReturn,
  metaLiteral,
  parseErrors,
  SHIP_LAUNCH,
  SHIP_SOURCE,
  tokenTexts,
  WORKFLOW_SCRIPT_CAP,
} from "../scripts/build-workflow-launch";

const source = readFileSync(SHIP_SOURCE, "utf-8");
const built = buildWorkflowLaunch(source);

describe("#2287 / SC-2772: the generated ship launch file", () => {
  test("is under the Workflow tool's cap, and ship.js itself is not — the reason it exists", () => {
    expect(WORKFLOW_SCRIPT_CAP).toBe(524_288);
    expect(built.bytes).toBeLessThan(WORKFLOW_SCRIPT_CAP);
    expect(Buffer.byteLength(source, "utf-8"), "ship.js fits the cap again; the launch file may no longer be needed").toBeGreaterThan(WORKFLOW_SCRIPT_CAP);
  });

  test("parses, begins with the meta literal, and ends its run with a top-level return", () => {
    expect(parseErrors(built.text)).toEqual([]);
    expect(built.text.startsWith("export const meta = {")).toBe(true);
    expect(metaLiteral(built.text)).toBe(metaLiteral(source));
    expect(metaLiteral(source)).not.toBeNull();
    expect(hasTopLevelReturn(built.text)).toBe(true);
  });

  test("keeps every token of ship.js, in order — only comments and blank lines are gone", () => {
    const want = tokenTexts(source);
    expect(want.length, "no tokens read from ship.js — the comparison would be vacuous").toBeGreaterThan(10_000);
    expect(tokenTexts(built.text)).toEqual(want);
  });

  test("says it is generated, and from what", () => {
    expect(built.text).toContain(GENERATED_NOTICE);
  });

  test("the committed workflows/ship.run.js is the build of the current ship.js — never stale", () => {
    expect(readFileSync(SHIP_LAUNCH, "utf-8") === built.text, "workflows/ship.run.js is stale: run `bun scripts/build-workflow-launch.ts` and commit it").toBe(true);
  });
});

describe("#2287 / SC-2772: what the build must not get wrong", () => {
  const wrap = (body: string) => `export const meta = {\n  name: 'x',\n};\n${body}\nreturn { ok: true };\n`;

  test("a // inside a string, a template literal or a regex is text, not a comment", () => {
    const body = [
      "const url = 'https://example.com/a'; // a real comment",
      "const t = `see // not a comment ${url} /* nor this */`;",
      "const re = /\\/\\/[a-z]+/g;",
    ].join("\n");
    const out = buildWorkflowLaunch(wrap(body)).text;
    expect(out).toContain("'https://example.com/a'");
    expect(out).toContain("`see // not a comment ${url} /* nor this */`");
    expect(out).toContain("/\\/\\/[a-z]+/g");
    expect(out).not.toContain("a real comment");
  });

  test("a block comment spanning lines stays a line terminator, so ASI is unchanged", () => {
    const body = "function f() {\n  return /* spans\n  lines */ 42;\n}";
    const out = buildWorkflowLaunch(wrap(body)).text;
    // `return\n42` returns undefined, exactly as the source does; a space would make it return 42.
    expect(out).toMatch(/return\s*\n\s*42;/);
    expect(tokenTexts(out)).toEqual(tokenTexts(wrap(body)));
  });

  test("a one-line block comment between two tokens becomes a space, never a join", () => {
    const out = buildWorkflowLaunch(wrap("const a = 1, b = 2;\nconst c = a/* x */+b;")).text;
    expect(out).toContain("a +b");
  });

  test("over the cap is a refusal, not a smaller file — and exactly at the cap is accepted (review, #2291)", () => {
    expect(() => buildWorkflowLaunch(source, built.bytes - 1)).toThrow(/over the Workflow tool's/);
    expect(buildWorkflowLaunch(source, built.bytes).bytes).toBe(built.bytes);
  });

  test("text inside a template literal is never rewritten: trailing spaces and blank-line runs survive (review, #2291)", () => {
    const literal = "const s = `line one   \nline two\t\n\n\n\nline three`;";
    const out = buildWorkflowLaunch(wrap(`// a comment above\n${literal}`)).text;
    expect(out).toContain(literal);
    expect(tokenTexts(out)).toEqual(tokenTexts(wrap(literal)));
  });

  test("a comment on its own line is removed with its line; a trailing one takes its leading spaces", () => {
    const out = buildWorkflowLaunch(wrap("const a = 1;\n    // own line\nconst b = 2;   // trailing\nconst c = 3;")).text;
    expect(out).toContain("const a = 1;\nconst b = 2;\nconst c = 3;");
  });

  test("no top-level return is a refusal", () => {
    expect(() => buildWorkflowLaunch("export const meta = {\n  name: 'x',\n};\nconst a = 1;\n")).toThrow(/no top-level `return`/);
  });

  test("a source that does not begin with meta is a refusal", () => {
    expect(() => buildWorkflowLaunch("const a = 1;\nexport const meta = {\n  name: 'x',\n};\nreturn 1;\n")).toThrow(/does not begin with/);
  });
});
