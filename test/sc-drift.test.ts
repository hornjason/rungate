import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { containsClauses, containsSubject, detectDrift, extractFilePaths, extractKeywords, keywordsFor } from "../scripts/detect-sc-drift";

const ROOT = join(import.meta.dir, "..");
/** Created in `beforeAll`, not at module scope — see #437. */
let TEMP_DIR = "";
let TEMP_SPECS = "";

beforeAll(() => {
  TEMP_DIR = mkdtempSync(join(ROOT, ".tmp-sc-drift-test-"));
  TEMP_SPECS = join(TEMP_DIR, "specs");
  mkdirSync(TEMP_SPECS, { recursive: true });
});

afterAll(() => {
  if (TEMP_DIR && existsSync(TEMP_DIR)) {
    rmSync(TEMP_DIR, { recursive: true });
  }
});

describe("SC drift detection", () => {
  test("detects drift when SC references nonexistent file", () => {
    // Create a spec with SC referencing a fake file
    const specContent = `---
doc-type: spec
---

# Test Spec

## Success Criteria

- [ ] SC-9410: lib/nonexistent-file.ts exists
- [ ] SC-9411: scripts/also-fake.ts contains [someKeyword]
`;
    writeFileSync(join(TEMP_SPECS, "test-drift.md"), specContent);

    const result = detectDrift(TEMP_SPECS, TEMP_DIR);

    // Should find 2 drifted SCs (both reference nonexistent files)
    expect(result.checked).toBe(2);
    expect(result.drifted.size).toBe(1);
    expect(result.drifted.has("test-drift.md")).toBe(true);

    const driftedSCs = result.drifted.get("test-drift.md")!;
    expect(driftedSCs.length).toBeGreaterThanOrEqual(2);
    expect(driftedSCs.some(d => d.scId === "SC-9410")).toBe(true);
    expect(driftedSCs.some(d => d.scId === "SC-9411")).toBe(true);
  });

  test("passes when SC references existing file", () => {
    // Create actual files
    mkdirSync(join(TEMP_DIR, "lib"), { recursive: true });
    writeFileSync(join(TEMP_DIR, "lib", "real-file.ts"), "export const foo = 42;");

    // Create spec referencing real file
    const specContent = `---
doc-type: spec
---

# Test Spec

## Success Criteria

- [ ] SC-100: lib/real-file.ts exists
`;
    writeFileSync(join(TEMP_SPECS, "test-valid.md"), specContent);

    const result = detectDrift(TEMP_SPECS, TEMP_DIR);

    // Should not find any drift for this SC
    expect(result.checked).toBeGreaterThanOrEqual(1);
    const validDrifted = result.drifted.get("test-valid.md");
    expect(validDrifted).toBeUndefined();
  });

  test("detects stale keyword when file exists but keyword missing", () => {
    // Create file without the expected keyword
    mkdirSync(join(TEMP_DIR, "scripts"), { recursive: true });
    writeFileSync(join(TEMP_DIR, "scripts", "test-script.ts"), "// No special keyword here\nconst x = 1;");

    // Create spec expecting keyword
    const specContent = `---
doc-type: spec
---

# Test Spec

## Success Criteria

- [ ] SC-200: scripts/test-script.ts contains [specialKeyword]
`;
    writeFileSync(join(TEMP_SPECS, "test-stale.md"), specContent);

    const result = detectDrift(TEMP_SPECS, TEMP_DIR);

    // Should find stale SC
    expect(result.stale.size).toBe(1);
    expect(result.stale.has("test-stale.md")).toBe(true);

    const staleSCs = result.stale.get("test-stale.md")!;
    expect(staleSCs.length).toBe(1);
    expect(staleSCs[0].scId).toBe("SC-200");
    expect(staleSCs[0].keyword).toBe("specialKeyword");
  });

  test("passes when file contains expected keyword", () => {
    // Create file with keyword
    mkdirSync(join(TEMP_DIR, "gates"), { recursive: true });
    writeFileSync(join(TEMP_DIR, "gates", "test-gate.ts"), "// Contains expectedKeyword\nconst y = 2;");

    // Create spec expecting keyword
    const specContent = `---
doc-type: spec
---

# Test Spec

## Success Criteria

- [ ] SC-300: gates/test-gate.ts contains [expectedKeyword]
`;
    writeFileSync(join(TEMP_SPECS, "test-keyword-present.md"), specContent);

    const result = detectDrift(TEMP_SPECS, TEMP_DIR);

    // Should not find stale for this SC
    const stale = result.stale.get("test-keyword-present.md");
    expect(stale).toBeUndefined();
  });

  test("handles specs with no file references", () => {
    const specContent = `---
doc-type: spec
---

# Test Spec

## Success Criteria

- [ ] SC-400: Something without file paths
- [ ] SC-401: Another behavioral criterion
`;
    writeFileSync(join(TEMP_SPECS, "test-no-refs.md"), specContent);

    const result = detectDrift(TEMP_SPECS, TEMP_DIR);

    // Should check these SCs but find no drift/stale
    expect(result.checked).toBeGreaterThanOrEqual(2);
    const drift = result.drifted.get("test-no-refs.md");
    const stale = result.stale.get("test-no-refs.md");
    expect(drift).toBeUndefined();
    expect(stale).toBeUndefined();
  });
});

/**
 * `contains [a, b]` is two requirements (#141)
 *
 * `extractKeywords` returned the bracket contents as one string, so a
 * multi-keyword SC was searched for the literal text `"resolveSyncPaths,
 * harnessRoot"` — comma and space included — which no source file contains.
 * Every multi-keyword SC was therefore reported stale regardless of the file,
 * and `sync-sc-status.ts` refuses to flip a stale SC. A criterion the
 * conformity engine had just PASSED could not be marked done, and the printed
 * reason was "keyword missing from file", which is not what was wrong.
 */
describe("#141: keyword extraction", () => {
  test("a comma-separated list is separate keywords, not one literal", () => {
    expect(extractKeywords("x.ts contains [resolveSyncPaths, harnessRoot]")).toEqual([
      "resolveSyncPaths",
      "harnessRoot",
    ]);
  });

  test("a single keyword is unchanged", () => {
    expect(extractKeywords("x.ts contains [onlyOne]")).toEqual(["onlyOne"]);
  });

  test("`not contains` is an absence clause and yields nothing", () => {
    // This detector only answers "a file exists but lacks a term it should
    // have". Read as a positive requirement it inverts the SC: SC-539 says
    // ship.js must NOT contain `git merge ${worktreeBranch}`, and the
    // detector reported it stale for being correct.
    expect(extractKeywords("workflows/ship.js not contains [git merge]")).toEqual([]);
  });

  test("a positive clause alongside a negative one still extracts", () => {
    expect(
      extractKeywords("hooks/x.ts contains [redactSecrets] and not contains [} catch {}]"),
    ).toEqual(["redactSecrets"]);
  });

  test("a statement with no contains clause yields nothing", () => {
    expect(extractKeywords("lib/real-file.ts exists")).toEqual([]);
  });
});

describe("#141: a multi-keyword SC is only stale for the terms it is missing", () => {
  test("every missing term is named, and a present one is not", () => {
    mkdirSync(join(TEMP_DIR, "workflows"), { recursive: true });
    writeFileSync(join(TEMP_DIR, "workflows", "multi.ts"), "export const present = 1;\n");
    writeFileSync(
      join(TEMP_SPECS, "test-multi.md"),
      `# Multi\n\n- [ ] SC-500: workflows/multi.ts contains [present, absentOne, absentTwo]\n`,
    );

    const result = detectDrift(TEMP_SPECS, TEMP_DIR);
    const stale = result.stale.get("test-multi.md")!;

    expect(stale).toBeDefined();
    // Before the fix this read the whole bracket string back; a reader who
    // fixed one term and re-ran would discover the next one by iteration.
    expect(stale[0].keyword).toBe("absentOne, absentTwo");
  });

  test("an SC whose terms are all present is not stale at all", () => {
    writeFileSync(join(TEMP_DIR, "workflows", "allthere.ts"), "alpha beta gamma\n");
    writeFileSync(
      join(TEMP_SPECS, "test-allthere.md"),
      `# All\n\n- [ ] SC-501: workflows/allthere.ts contains [alpha, beta, gamma]\n`,
    );

    const result = detectDrift(TEMP_SPECS, TEMP_DIR);
    // The failure that blocked #141: this was stale because it searched for
    // "alpha, beta, gamma" as one string.
    expect(result.stale.get("test-allthere.md")).toBeUndefined();
  });
});

describe("#2287: the keywords are looked for in the file the contains clause names, and no other", () => {
  // SC-2772 reads "scripts/build-workflow-launch.ts contains [buildWorkflowLaunch]
  // — … generated from `workflows/ship.js` …". The detector checked the keyword
  // in EVERY path the sentence mentions, found it missing from ship.js, and
  // refused the tick as stale while the conformity matcher had passed it.
  test("a second path mentioned in the prose does not make the criterion stale", () => {
    mkdirSync(join(TEMP_DIR, "scripts"), { recursive: true });
    mkdirSync(join(TEMP_DIR, "workflows"), { recursive: true });
    writeFileSync(join(TEMP_DIR, "scripts", "subject.ts"), "export function theKeyword() {}\n");
    writeFileSync(join(TEMP_DIR, "workflows", "other.js"), "nothing relevant\n");
    writeFileSync(
      join(TEMP_SPECS, "test-subject.md"),
      "# Subject\n\n- [ ] SC-502: scripts/subject.ts contains [theKeyword] — built from `workflows/other.js`, which must exist\n",
    );
    const result = detectDrift(TEMP_SPECS, TEMP_DIR);
    expect(result.stale.get("test-subject.md")).toBeUndefined();
    expect(result.drifted.get("test-subject.md")).toBeUndefined(); // other.js exists, so no drift either
  });

  test("each of several contains clauses is checked against its own file (review, #2291)", () => {
    // SC-543's shape: `lib/a.ts contains [x] and workflows/b.js contains [y(z)]`.
    // Binding only the FIRST clause left the second file checked for nothing.
    writeFileSync(join(TEMP_DIR, "scripts", "first.ts"), "export const alpha = 1;\n");
    writeFileSync(join(TEMP_DIR, "workflows", "second.js"), "nothing here\n");
    writeFileSync(
      join(TEMP_SPECS, "test-two-clauses.md"),
      "# Two\n\n- [ ] SC-504: scripts/first.ts contains [alpha] and workflows/second.js contains [beta(gamma)]\n",
    );
    const stale = detectDrift(TEMP_SPECS, TEMP_DIR).stale.get("test-two-clauses.md")!;
    expect(stale.map(s => [s.path, s.keyword])).toEqual([["workflows/second.js", "beta(gamma)"]]);
  });

  test("CONTROL: the named file lacking the keyword is still stale, and only it is reported", () => {
    writeFileSync(join(TEMP_DIR, "scripts", "subject-empty.ts"), "export const nothing = 0;\n");
    writeFileSync(
      join(TEMP_SPECS, "test-subject-empty.md"),
      "# Subject\n\n- [ ] SC-503: scripts/subject-empty.ts contains [theKeyword] — built from `workflows/other.js`\n",
    );
    const stale = detectDrift(TEMP_SPECS, TEMP_DIR).stale.get("test-subject-empty.md")!;
    expect(stale.map(s => s.path)).toEqual(["scripts/subject-empty.ts"]);
  });
});

describe("#2883: a path is read whole, from its start, never from a segment nested inside it", () => {
  /** A scratch project holding `src/lib/present.ts` and one spec with `criteria`, read by detectDrift. */
  const driftOf = (criteria: string[]) => {
    const root = mkdtempSync(join(tmpdir(), "rungate-2883-"));
    try {
      mkdirSync(join(root, "specs"));
      mkdirSync(join(root, "src", "lib"), { recursive: true });
      writeFileSync(join(root, "src", "lib", "present.ts"), "export const present = 1;\n");
      writeFileSync(join(root, "specs", "nested.md"), ["---", "doc-type: spec", "---", "", "## Success Criteria", "", ...criteria, ""].join("\n"));
      const result = detectDrift(join(root, "specs"), root);
      return {
        drifted: (result.drifted.get("nested.md") ?? []).map(d => `${d.scId} ${d.path}`).sort(),
        stale: (result.stale.get("nested.md") ?? []).map(s => `${s.scId} ${s.path} ${s.keyword}`).sort(),
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  test("a nested path is checked as written: present passes, missing drifts under its own name, never as lib/missing.ts", () => {
    const { drifted } = driftOf([
      "- [ ] SC-9540: src/lib/present.ts exists",
      "- [ ] SC-9541: src/lib/missing.ts exists",
      "- [ ] SC-9542: lib/missing.ts exists",
      "- [ ] SC-9543: node_modules/pkg/scripts/run.js exists",
      "- [ ] SC-9544: the file `lib/also-missing.ts` exists",
      "- [ ] SC-9545: ./lib/rooted-missing.ts exists",
      "- [ ] SC-9546: /scripts/rooted-gone.ts exists",
      "- [ ] SC-9547: @/lib/aliased.ts exists",
      "- [ ] SC-9548: ~/lib/home.ts exists",
    ]);
    // Root-relative paths read as the same file (round 1). An alias or home
    // prefix cannot be resolved here, so that path is not read (round 2).
    expect(drifted).toEqual([
      "SC-9541 src/lib/missing.ts",
      "SC-9542 lib/missing.ts",
      "SC-9543 node_modules/pkg/scripts/run.js",
      "SC-9544 lib/also-missing.ts",
      "SC-9545 lib/rooted-missing.ts",
      "SC-9546 scripts/rooted-gone.ts",
    ]);
  });

  test("a nested path's contains clause is checked in that file, so a missing keyword is stale there", () => {
    const { drifted, stale } = driftOf([
      "- [ ] SC-9549: src/lib/present.ts contains [present]",
      "- [ ] SC-9550: src/lib/present.ts contains [absentWord]",
    ]);
    expect(drifted).toEqual([]);
    expect(stale).toEqual(["SC-9550 src/lib/present.ts absentWord"]);
  });

  test("containsSubject names the whole path a clause sits on, quoted or not, and no alias path", () => {
    expect(containsSubject("src/lib/x.ts contains [someKeyword]")).toBe("src/lib/x.ts");
    expect(containsSubject("lib/x.ts contains [someKeyword]")).toBe("lib/x.ts");
    expect(containsSubject("`lib/x.ts` contains [someKeyword]")).toBe("lib/x.ts");
    expect(containsSubject("the reader in (lib/x.ts contains [someKeyword]")).toBe("lib/x.ts");
    expect(containsSubject("./lib/x.ts contains [someKeyword]")).toBe("lib/x.ts");
    expect(containsSubject("pkg-lib/x.ts contains [someKeyword]")).toBeNull();
    expect(containsSubject("@/lib/x.ts contains [someKeyword]")).toBeNull();
  });

  test("a clause lends its keywords to no other file: quoted, nested, or on a file this reader does not read", () => {
    // Bound to "no file", a clause's keywords were required of every other
    // path the criterion names: the #2287 class (rounds 1 and 2).
    expect(keywordsFor("`lib/a.ts` contains [foo] and `lib/b.ts` contains [bar]", "lib/a.ts")).toEqual(["foo"]);
    expect(keywordsFor("`src/lib/x.ts` contains [foo] and scripts/bar.ts contains [baz]", "scripts/bar.ts")).toEqual(["baz"]);
    expect(keywordsFor("SUCCESS.md contains [foo] and lib/a.ts exists", "lib/a.ts")).toEqual([]);
    // Punctuated, the unread file still keeps its clause to itself (#2907 review).
    expect(keywordsFor("hooks/pre-commit.sh, contains [set -e] and lib/a.ts contains [foo]", "lib/a.ts")).toEqual(["foo"]);
    // A punctuated listed path keeps its clause too, and so does a path with no read extension (round 2).
    expect(keywordsFor("lib/a.ts, contains [foo] and lib/b.ts exists", "lib/b.ts")).toEqual([]);
    expect(keywordsFor("scripts/build contains [x] and lib/a.ts contains [y]", "lib/a.ts")).toEqual(["y"]);
    // CONTROL: a clause that names no file is still checked in every path, as before.
    expect(keywordsFor("lib/a.ts is wired so that it contains [wired]", "lib/a.ts")).toEqual(["wired"]);
  });

  test("both readers share one token classifier and one directory list, so they cannot disagree about what a path is (#2897)", () => {
    const source = readFileSync(join(ROOT, "scripts", "detect-sc-drift.ts"), "utf-8");
    expect(source.split(`"workflows"`).length - 1).toBe(1);
    // The definition and one call from each reader.
    expect(source.split("classifyPathToken(").length - 1).toBe(3);
  });
});

/**
 * #2897: the token rules, written once as a table and run through both
 * readers. Each row is a token as it appears in a criterion; `reads` is what
 * existence checking reads from it, and `subject` is what a `contains [...]`
 * clause directly after it binds to: a path, `null` (no file named, so the
 * keywords apply to every path), or `"dropped"` (a file this reader does not
 * read, so the clause is checked nowhere). `main` is what main read for the
 * same token, measured on 2d7ac192f, so a reader can see which rows changed.
 */
type Subject = string | null | "dropped";
const PATH_TOKEN_RULES: Array<{ token: string; reads: string[]; subject: Subject; main: { reads: string[]; subject: Subject }; rule: string }> = [
  { token: "lib/x.ts", reads: ["lib/x.ts"], subject: "lib/x.ts", main: { reads: ["lib/x.ts"], subject: "lib/x.ts" }, rule: "a path through a listed directory" },
  { token: "src/lib/x.ts", reads: ["src/lib/x.ts"], subject: "src/lib/x.ts", main: { reads: ["src/lib/x.ts"], subject: "src/lib/x.ts" }, rule: "read whole, from the token's start" },
  { token: "a/lib/b/c.md", reads: ["a/lib/b/c.md"], subject: "a/lib/b/c.md", main: { reads: ["a/lib/b/c.md"], subject: "a/lib/b/c.md" }, rule: "a listed directory anywhere before the file" },
  { token: "lib/x.test.ts", reads: ["lib/x.test.ts"], subject: "lib/x.test.ts", main: { reads: ["lib/x.test.ts"], subject: "lib/x.test.ts" }, rule: "dots inside the file name" },
  { token: "./lib/x.ts", reads: ["lib/x.ts"], subject: "lib/x.ts", main: { reads: ["lib/x.ts"], subject: "lib/x.ts" }, rule: "prefix ./ is the same file" },
  { token: "/lib/x.ts", reads: ["lib/x.ts"], subject: "lib/x.ts", main: { reads: ["lib/x.ts"], subject: "lib/x.ts" }, rule: "a root-relative path whose first segment is listed" },
  { token: "/scripts/rooted-gone.ts", reads: ["scripts/rooted-gone.ts"], subject: "scripts/rooted-gone.ts", main: { reads: ["scripts/rooted-gone.ts"], subject: "scripts/rooted-gone.ts" }, rule: "root-relative, second listed directory" },
  { token: "/home/u/proj/lib/y.ts", reads: [], subject: "dropped", main: { reads: ["home/u/proj/lib/y.ts"], subject: "home/u/proj/lib/y.ts" }, rule: "an absolute path outside the project is not read under it" },
  { token: "@/lib/x.ts", reads: [], subject: "dropped", main: { reads: [], subject: "dropped" }, rule: "an alias this reader cannot resolve" },
  { token: "~/lib/x.ts", reads: [], subject: "dropped", main: { reads: [], subject: "dropped" }, rule: "a home path this reader cannot resolve" },
  { token: "node_modules/@scope/pkg/scripts/run.js", reads: ["node_modules/@scope/pkg/scripts/run.js"], subject: "node_modules/@scope/pkg/scripts/run.js", main: { reads: [], subject: "dropped" }, rule: "a scoped segment inside a path is part of it" },
  { token: "`lib/a.ts`", reads: ["lib/a.ts"], subject: "lib/a.ts", main: { reads: ["lib/a.ts"], subject: "lib/a.ts" }, rule: "backticks around the path" },
  { token: "\"lib/q.ts\"", reads: ["lib/q.ts"], subject: "lib/q.ts", main: { reads: ["lib/q.ts"], subject: "lib/q.ts" }, rule: "double quotes around the path" },
  { token: "(lib/x.ts", reads: ["lib/x.ts"], subject: "lib/x.ts", main: { reads: ["lib/x.ts"], subject: "lib/x.ts" }, rule: "an opening parenthesis" },
  { token: "lib/x.ts:42", reads: ["lib/x.ts"], subject: "lib/x.ts", main: { reads: ["lib/x.ts"], subject: null }, rule: "a line reference names the file" },
  { token: "lib/x.ts,", reads: ["lib/x.ts"], subject: "lib/x.ts", main: { reads: ["lib/x.ts"], subject: null }, rule: "a separator after the path still names it, so its clause is lent to no other file (#2907 review)" },
  { token: "lib/x.ts.", reads: ["lib/x.ts"], subject: "lib/x.ts", main: { reads: ["lib/x.ts"], subject: null }, rule: "a sentence end after the path, likewise" },
  { token: "lib/x.ts's", reads: ["lib/x.ts"], subject: "lib/x.ts", main: { reads: ["lib/x.ts"], subject: null }, rule: "a possessive names the file (SC-1487's prose)" },
  { token: ".github/workflows/release.yml", reads: [], subject: "dropped", main: { reads: [], subject: null }, rule: "a workflow file is not read, so its clause is checked nowhere rather than everywhere (SC-831's shape)" },
  { token: "lib/x.ts)", reads: ["lib/x.ts"], subject: "lib/x.ts", main: { reads: ["lib/x.ts"], subject: null }, rule: "a closing parenthesis, likewise" },
  { token: "[lib/x.ts]", reads: ["lib/x.ts"], subject: "lib/x.ts", main: { reads: ["lib/x.ts"], subject: null }, rule: "brackets, likewise" },
  { token: "lib/parser.tsx", reads: [], subject: "dropped", main: { reads: ["lib/parser.ts"], subject: null }, rule: "the extension ends at the token's end" },
  { token: "hooks/pre-commit.sh", reads: [], subject: "dropped", main: { reads: [], subject: null }, rule: "an extension this reader does not read" },
  { token: "SUCCESS.md", reads: [], subject: "dropped", main: { reads: [], subject: "dropped" }, rule: "a file in no listed directory" },
  { token: "config/x.json", reads: [], subject: "dropped", main: { reads: [], subject: "dropped" }, rule: "a directory not on the list" },
  { token: "pkg-lib/x.ts", reads: [], subject: "dropped", main: { reads: [], subject: "dropped" }, rule: "a directory whose name only ends in a listed one" },
  { token: "lib/*.ts", reads: [], subject: "dropped", main: { reads: ["lib/*.ts"], subject: "lib/*.ts" }, rule: "a glob is a pattern, not a file" },
  { token: "https://example.com/lib/x.ts", reads: [], subject: "dropped", main: { reads: [], subject: null }, rule: "a URL is not a path in this tree" },
  { token: "wired", reads: [], subject: null, main: { reads: [], subject: null }, rule: "a plain word names no file" },
  // #2907 review: what may follow or precede a path inside its token.
  { token: "lib/x.ts:10-20", reads: ["lib/x.ts"], subject: "lib/x.ts", main: { reads: ["lib/x.ts"], subject: null }, rule: "a line range names the file" },
  { token: "lib/x.ts:L42", reads: ["lib/x.ts"], subject: "lib/x.ts", main: { reads: ["lib/x.ts"], subject: null }, rule: "an L-prefixed line names the file" },
  { token: "lib/x.ts#L42", reads: ["lib/x.ts"], subject: "lib/x.ts", main: { reads: ["lib/x.ts"], subject: null }, rule: "a line anchor names the file" },
  { token: "lib/a.md#some-heading", reads: ["lib/a.md"], subject: "lib/a.md", main: { reads: ["lib/a.md"], subject: null }, rule: "a heading anchor names the file" },
  { token: "lib/x.ts?", reads: ["lib/x.ts"], subject: "lib/x.ts", main: { reads: ["lib/x.ts"], subject: null }, rule: "a question mark, likewise" },
  { token: "lib/x.ts—the", reads: ["lib/x.ts"], subject: "lib/x.ts", main: { reads: ["lib/x.ts"], subject: null }, rule: "text joined by a dash does not stop the path naming its file" },
  { token: "<lib/x.ts>", reads: ["lib/x.ts"], subject: "lib/x.ts", main: { reads: ["lib/x.ts"], subject: null }, rule: "angle brackets are not part of the path" },
  { token: "**lib/x.ts**", reads: ["lib/x.ts"], subject: "lib/x.ts", main: { reads: ["lib/x.ts"], subject: null }, rule: "emphasis is not part of the path" },
  { token: "key:lib/x.ts", reads: ["lib/x.ts"], subject: "lib/x.ts", main: { reads: ["lib/x.ts"], subject: "lib/x.ts" }, rule: "a prefix before the path is not part of it" },
  { token: "hooks/pre-commit.sh,", reads: [], subject: "dropped", main: { reads: [], subject: null }, rule: "an unread file is skipped, punctuated or not" },
  { token: "SUCCESS.md's", reads: [], subject: "dropped", main: { reads: [], subject: null }, rule: "an unread file is skipped, possessive or not" },
  { token: "src/*/lib/x.ts", reads: [], subject: "dropped", main: { reads: ["lib/x.ts"], subject: "lib/x.ts" }, rule: "a glob anywhere in the token is a pattern" },
  // #2907 review round 2.
  { token: "../lib/x.ts", reads: [], subject: "dropped", main: { reads: ["../lib/x.ts"], subject: "../lib/x.ts" }, rule: "a path through .. leaves the tree, so it is not read under it" },
  { token: "scripts/build", reads: [], subject: "dropped", main: { reads: [], subject: null }, rule: "a path with a directory and no read extension is a file this reader does not read" },
  { token: "Node.js", reads: [], subject: "dropped", main: { reads: [], subject: "dropped" }, rule: "a bare name with a read extension is a root file, as #2884 read it: SUCCESS.md and Node.js look alike" },
  { token: "notes.yml", reads: [], subject: null, main: { reads: [], subject: null }, rule: "a bare name with any other extension is a word" },
];

describe("#2897: one table of token rules, run through both readers", () => {
  for (const row of PATH_TOKEN_RULES) {
    test(`${row.token} — ${row.rule}`, () => {
      expect(extractFilePaths(`see ${row.token} here`), "what existence checking reads").toEqual(row.reads);
      const clauses = containsClauses(`${row.token} contains [kw]`);
      const subject: Subject = clauses.length === 0 ? "dropped" : clauses[0].path;
      expect(subject, "what a contains clause after it binds to").toBe(row.subject);
    });
  }

  test("the table names main's reading for every row, and says which rows changed", () => {
    const changed = PATH_TOKEN_RULES.filter(r => JSON.stringify(r.main) !== JSON.stringify({ reads: r.reads, subject: r.subject })).map(r => r.token);
    expect(changed).toEqual(["/home/u/proj/lib/y.ts", "node_modules/@scope/pkg/scripts/run.js", "lib/x.ts:42", "lib/x.ts,", "lib/x.ts.", "lib/x.ts's", ".github/workflows/release.yml", "lib/x.ts)", "[lib/x.ts]", "lib/parser.tsx", "hooks/pre-commit.sh", "lib/*.ts", "https://example.com/lib/x.ts", "lib/x.ts:10-20", "lib/x.ts:L42", "lib/x.ts#L42", "lib/a.md#some-heading", "lib/x.ts?", "lib/x.ts—the", "<lib/x.ts>", "**lib/x.ts**", "hooks/pre-commit.sh,", "SUCCESS.md's", "src/*/lib/x.ts", "../lib/x.ts", "scripts/build"]);
  });
});
