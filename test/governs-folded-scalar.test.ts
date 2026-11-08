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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { parseFrontmatter } from "../lib/conformity";
import { getUngoverned, isValidGoverns } from "../lib/spec-registry";

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

describe("isValidGoverns is the one decider, and it reads every block indicator", () => {
  // YAML's full set: `>` folded and `|` literal, each bare or with a chomping
  // indicator, each optionally carrying an explicit indentation digit. A
  // predicate narrower than the syntax is a detector narrower than what it
  // detects — a spec author writing `|-` instead of `>-` would walk straight
  // past a guard that only knew the one spelling.
  const INDICATORS = [">", ">-", ">+", "|", "|-", "|+", ">2", ">-2", "|2", "|-2"];
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

describe("the tree itself", () => {
  // The gate above only keeps a folded governs out from here. This row is
  // what says none is in already — and it reads the live `specs/`, so it is
  // the one case that goes red if somebody lands one before the gate does.
  test("no spec in specs/ carries a folded or literal governs", () => {
    expect(getUngoverned(HARNESS).filter(f => f !== "SPEC-TEMPLATE.md")).toEqual([]);
  });
});
