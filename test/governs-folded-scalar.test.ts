/**
 * #1692 — a YAML folded or literal block scalar in `governs:` is read as the
 * two-character fold indicator, and nothing refuses it.
 *
 * Two readers decide whether a spec's `governs` is usable, with the same
 * criteria written twice: `HYGIENE-1` in `lib/conformity.ts`, and
 * `isValidGoverns` in `lib/spec-registry.ts` (which `lib/doc-hygiene.ts`'s
 * GOVERNS-MISSING delegates to). Handed `governs: >-`, both see the string
 * `">-"`, which is non-empty and contains no `TODO`, so both pass. A third
 * reader — `lib/scanner.ts`, which renders the routing table — drops it for
 * being under six characters and emits `""`, so the row goes blank while
 * every check stays green.
 *
 * Measured 2026-11-08 against this tree: conformity `">-"`, spec-registry
 * `">-"`, scanner `""`. No spec in `specs/` carries a folded `governs`
 * today, so this is a latent defect and these cases are the gate that keeps
 * it latent.
 *
 * The decision this encodes: a folded `governs` is REFUSED, not supported.
 * All 27 specs state it on one line, folding it would need a reader that
 * knows `>` joins with spaces and `|` keeps newlines, and nothing here
 * needs a `governs` long enough to wrap.
 */
import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { parseFrontmatter } from "../lib/conformity";
import { getUngoverned, governsOf, isValidGoverns } from "../lib/spec-registry";
import { stripComments } from "./helpers/strip-comments";

const HARNESS = resolve(import.meta.dir, "..");
const roots: string[] = [];

afterAll(() => {
  for (const r of roots) {
    try { rmSync(r, { recursive: true, force: true }); } catch {}
  }
});

/** A project root holding exactly one spec, with the frontmatter given. */
function plantSpec(name: string, frontmatter: string): string {
  const root = mkdtempSync(join(tmpdir(), "rg-governs-"));
  roots.push(root);
  mkdirSync(join(root, "specs"), { recursive: true });
  writeFileSync(
    join(root, "specs", name),
    `---\ndoc-type: spec\ntestable: false\n${frontmatter}\nupdated: 2026-11-08\n---\n\n# ${name}\n\nBody.\n`,
  );
  return root;
}

/**
 * Run the REAL doc-hygiene suite against a planted root, in a subprocess.
 *
 * The checks register through `describe`/`test` at call time, so they cannot
 * be invoked from inside a case — the pattern is `test/phase-1.test.ts`'s.
 * `ran` is read before any failure count: a suite that failed to load and a
 * suite whose checks all passed both report zero failures.
 */
function runDocHygieneOn(root: string): { ran: number; fail: number; output: string } {
  const file = join(root, "_hygiene.test.ts");
  writeFileSync(
    file,
    `import { runDocHygiene } from "${join(HARNESS, "lib", "conformity")}";\nrunDocHygiene("${root}");\n`,
  );
  // No shell: the root is an argument, never interpolated into a command line.
  const r = Bun.spawnSync(["bun", "test", file], { cwd: HARNESS, stdout: "pipe", stderr: "pipe" });
  const out = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
  const pass = parseInt(out.match(/(\d+) pass/)?.[1] || "0", 10);
  const fail = parseInt(out.match(/(\d+) fail/)?.[1] || "0", 10);
  return { ran: pass + fail, fail, output: out };
}

const FOLDED = "governs: >-\n  THE ENGINE that turns a spec into board state — not\n  the specs it ships.";
const ONE_LINE = "governs: THE ENGINE that turns a spec into board state — not the specs it ships.";

describe("a folded governs scalar is refused, not read as `>-` (#1692)", () => {
  // The control. It runs first because every case below reads as a pass when
  // the fixture never reached the checks at all, and this is the row that
  // says the harness works: real spec, one-line governs, suite green.
  test("the control: a one-line governs passes doc-hygiene", () => {
    const r = runDocHygieneOn(plantSpec("ONELINE-SPEC.md", ONE_LINE));
    expect(r.ran, `no HYGIENE check ran at all:\n${r.output}`).toBeGreaterThan(0);
    expect(r.fail, `a one-line governs must pass:\n${r.output}`).toBe(0);
  });

  test("HYGIENE-1 fails on a folded governs, and names the file", () => {
    const r = runDocHygieneOn(plantSpec("FOLDED-SPEC.md", FOLDED));
    expect(r.ran, `no HYGIENE check ran at all:\n${r.output}`).toBeGreaterThan(0);
    expect(
      r.fail,
      "HYGIENE-1 read the fold indicator `>-` as the governs text — non-empty, " +
        `no TODO — and passed. Output:\n${r.output}`,
    ).toBeGreaterThan(0);
    expect(r.output).toContain("FOLDED-SPEC.md");
  });

  test("the two deciders agree: the registry calls a folded spec ungoverned", () => {
    const root = plantSpec("FOLDED-SPEC.md", FOLDED);
    expect(
      getUngoverned(root),
      "spec-registry accepted `>-` as this spec's governs text, so doc-hygiene's " +
        "GOVERNS-MISSING stays quiet and the inverted index keys on `>-`",
    ).toEqual(["FOLDED-SPEC.md"]);
  });

  test("both readers extract the same string, so one predicate can decide", () => {
    const content = `---\n${FOLDED}\n---\n\n# X\n`;
    expect(parseFrontmatter(content)?.governs).toBe(">-");
  });
});

/**
 * Round 1 of review on #1906 said the "one decider" claim was overstated,
 * and it was right: unifying the PREDICATE left two EXTRACTORS, and they
 * disagree on a different shape — a bare `governs:` with the text on the
 * indented lines below and no `>`/`|` at all.
 *
 * Measured on this tree before the fix: `lib/conformity.ts`'s
 * `parseFrontmatter` flattens the continuation lines and joins them with
 * `"; "`, so HYGIENE-1 saw
 * `"THE ENGINE that turns a spec into board state — not; the specs it
 * ships."` and passed the spec; `lib/spec-registry.ts`'s own parser has no
 * such branch, never set the key, and `getUngoverned` listed the same file
 * as ungoverned. Same spec, two verdicts, in the same run.
 *
 * The answer is one extractor, not a softer sentence. `governsOf` reads the
 * inline text and nothing else, so a value that lives on the lines below —
 * folded, literal or bare — is absent to both readers rather than present
 * and different.
 */
describe("one extractor, so a value on the lines below is absent to both (#1906)", () => {
  const BARE_BLOCK = "governs:\n  THE ENGINE that turns a spec into board state — not\n  the specs it ships.";

  test("HYGIENE-1 fails on a bare block governs, and names the file", () => {
    const r = runDocHygieneOn(plantSpec("BLOCK-SPEC.md", BARE_BLOCK));
    expect(r.ran, `no HYGIENE check ran at all:\n${r.output}`).toBeGreaterThan(0);
    expect(
      r.fail,
      "HYGIENE-1 read the flattened continuation lines as the governs text " +
        `and passed. Output:\n${r.output}`,
    ).toBeGreaterThan(0);
    expect(r.output).toContain("BLOCK-SPEC.md");
  });

  test("the registry calls the same bare-block spec ungoverned", () => {
    expect(getUngoverned(plantSpec("BLOCK-SPEC.md", BARE_BLOCK))).toEqual(["BLOCK-SPEC.md"]);
  });

  // The property, not the two sites. Repairing them one at a time leaves a
  // behavioural suite that catches only the last one to regress.
  for (const [shape, frontmatter] of [
    ["one-line", ONE_LINE],
    ["folded", FOLDED],
    ["bare block", BARE_BLOCK],
    ["literal block", "governs: |\n  THE ENGINE, kept verbatim."],
    ["absent", "created: 2026-11-08"],
  ] as const) {
    test(`the two readers agree on a ${shape} governs`, () => {
      const root = plantSpec("AGREE-SPEC.md", frontmatter);
      const hygienePassed = runDocHygieneOn(root).fail === 0;
      const registrySaysGoverned = !getUngoverned(root).includes("AGREE-SPEC.md");
      expect(
        { hygienePassed, registrySaysGoverned },
        `HYGIENE-1 and spec-registry reached different verdicts on a ${shape} governs`,
      ).toEqual({ hygienePassed: registrySaysGoverned, registrySaysGoverned });
    });
  }

  test("governsOf reads the inline text only", () => {
    const of = (fm: string) => governsOf(`---\ndoc-type: spec\n${fm}\nupdated: 2026-11-08\n---\n\n# X\n`);
    expect(of(ONE_LINE)).toBe("THE ENGINE that turns a spec into board state — not the specs it ships.");
    expect(of(FOLDED)).toBe(">-");
    expect(of(BARE_BLOCK)).toBe("");
    expect(of("created: 2026-11-08")).toBeUndefined();
  });

  // The control. `governsOf` must not find a `governs:` written in the BODY,
  // or a spec that merely discusses the field would read as declaring one.
  test("a governs: line in the body is not frontmatter", () => {
    expect(
      governsOf(`---\ndoc-type: spec\nupdated: 2026-11-08\n---\n\n# X\n\ngoverns: the body is not the block\n`),
    ).toBeUndefined();
  });
});

describe("isValidGoverns is the one decider, and it reads every block indicator", () => {
  // YAML's full set: `>` folded and `|` literal, each bare or with a chomping
  // indicator, each optionally carrying an explicit indentation digit. A
  // predicate narrower than the syntax is a detector narrower than what it
  // detects — a spec author writing `|-` instead of `>-` would walk straight
  // past a guard that only knew the one spelling.
  //
  // The header may also carry a trailing YAML comment, which no reader in
  // this tree strips, so the whole string `">- # what it governs"` reaches
  // the predicate. Raised in review of this PR — the first version of the
  // regex anchored on `$` and let every commented header through, which is
  // the same defect one spelling along.
  const INDICATORS = [
    ">", ">-", ">+", "|", "|-", "|+", ">2", ">-2", "|2", "|-2",
    ">- # what it governs", "| # note", ">-2  #  trailing", "> #",
  ];
  for (const ind of INDICATORS) {
    test(`\`governs: ${ind}\` is not a governs value`, () => {
      expect(isValidGoverns(ind)).toBe(false);
    });
  }

  // The control that lets this describe disagree. If the predicate simply
  // refused anything short, or anything containing `>` or `|`, every row
  // above would still be green and real governs text would be rejected.
  const VALID = [
    "lib/scanner.ts",
    "Board flow — what each lane is FOR",
    "> than the previous threshold, the queue drains",
    "the pipe | separates the two halves",
    ">>= is the bind operator, and this spec governs its parser",
    // The control for the comment-stripping above: a `#` in real governs
    // text must survive. A predicate that cut at the first `#` would leave
    // `"the "` here and this row would be the only thing to say so.
    "the # anchor parser, and nothing else",
  ];
  for (const v of VALID) {
    test(`real governs text is kept: ${JSON.stringify(v.slice(0, 40))}`, () => {
      expect(isValidGoverns(v)).toBe(true);
    });
  }

  test("the existing refusals still hold", () => {
    expect(isValidGoverns(undefined)).toBe(false);
    expect(isValidGoverns("")).toBe(false);
    expect(isValidGoverns("   ")).toBe(false);
    expect(isValidGoverns("TODO")).toBe(false);
  });
});

describe("the one extractor is asserted, not just described", () => {
  // Raised in review of #1906, three seconds after it merged: switching
  // `scanSpecDir` to `governsOf` left the module's own `parseFrontmatter`
  // sitting there unused and unexported. A near-duplicate parser nobody
  // calls is the cheapest thing in the world for a later edit to wire back
  // in as a second source of truth — which is the exact class of bug this
  // work closed. A docblock saying "one extractor" is the reason nobody
  // checks that it still is, so this is the check.
  const SOURCE = readFileSync(join(HARNESS, "lib", "spec-registry.ts"), "utf-8");

  /**
   * Every distinct identifier containing "frontmatter" in a module's CODE.
   *
   * Raised in review of #1907: the first version matched `function NAME`
   * declarations only, so `const parseFrontmatter = (c) => …` — the arrow
   * style this tree uses over a hundred times — and an `import { … }` of
   * someone else's parser both sailed past a guard whose own comment warned
   * about exactly that reintroduction. Measured: the old scan returned `[]`
   * for a planted arrow declaration and a planted import.
   *
   * So this does not reason about declaring position at all. It takes every
   * mention in comment-stripped source, which is strictly wider than any
   * list of syntactic forms and cannot be defeated by a form nobody thought
   * of. A string literal would be a false positive, and that is the
   * direction to be wrong in: it costs one line in the expectation below.
   */
  function frontmatterIdentifiers(source: string): string[] {
    // Case-insensitive: the first draft of this scan spelled it `[Ff]` and
    // so could not see the module's own `FRONTMATTER` constant, which is a
    // detector narrower than what it detects one more time.
    const found = stripComments(source).match(/\w*frontmatter\w*/gi) ?? [];
    return [...new Set(found)].sort();
  }

  test("lib/spec-registry.ts names one frontmatter thing, and it is the block regex", () => {
    expect(
      frontmatterIdentifiers(SOURCE),
      "a second frontmatter parser — declared, assigned or IMPORTED — is back " +
        "in the module whose whole point is that there is one. Call " +
        "`governsOf`, or say in the diff why this one has to exist. This is " +
        "an equality, so a binding that legitimately goes away must come out " +
        "of the expectation in the same commit.",
    ).toEqual(["FRONTMATTER"]);
  });

  // The controls. The case above is an equality over a one-element set, so
  // it would read green against a scanner that finds nothing it should —
  // which is precisely how its first version passed. These plant each form
  // somebody would actually reintroduce the parser in.
  const REINTRODUCTIONS: [string, string][] = [
    ["a function declaration", "function parseFrontmatter(c: string) { return null; }"],
    ["an exported arrow", "export const parseFrontmatter = (c: string) => ({});"],
    ["a function expression", "const parseFrontmatter = function (c) { return {}; };"],
    ["an import of another one", 'import { parseFrontmatter } from "./conformity";'],
    ["a renamed import", 'import { parseFrontmatter as pf } from "./conformity";'],
    ["a class method's owner", "class FrontmatterReader { read(c: string) { return c; } }"],
  ];
  for (const [shape, code] of REINTRODUCTIONS) {
    test(`the scan catches ${shape}`, () => {
      expect(frontmatterIdentifiers(code).length, `missed: ${code}`).toBeGreaterThan(0);
    });
  }

  test("prose about frontmatter is not a binding", () => {
    expect(frontmatterIdentifiers("// parseFrontmatter used to live here\nconst x = 1;")).toEqual([]);
    expect(frontmatterIdentifiers("/** The frontmatter block. */\nconst x = 1;")).toEqual([]);
  });

  // And the control that says the scan is reading the real file, not an
  // empty string: this module's two exported deciders are both present.
  test("the scan is reading the module", () => {
    expect(SOURCE).toContain("export function governsOf");
    expect(SOURCE).toContain("export function isValidGoverns");
  });
});

describe("the tree itself", () => {
  // The gate above only keeps a folded governs out from here. This row is
  // what says none is in already — and it reads the live `specs/`, so it is
  // the one case that goes red if somebody lands one before the gate does.
  test("no spec in specs/ carries a folded or literal governs", () => {
    expect(getUngoverned(HARNESS).filter(f => f !== "SPEC-TEMPLATE.md")).toEqual([]);
  });
});
