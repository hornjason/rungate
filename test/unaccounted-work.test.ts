/**
 * #2100: `rungate unaccounted-work` reports undone work declared in a
 * repository's prose that no open issue covers, by file and line. It finds its
 * sources in the repository itself, and a source it cannot read is UNMEASURED
 * and named, never counted as zero.
 *
 * ## What was broken to prove these can fail
 *
 * - Every refusal runs twice on the same input, once against the real script
 *   and once against a mutant whose single `EXIT_REFUSED = 2` is rewritten to
 *   `0`. The real one must refuse and the mutant must not.
 * - Dropping a source from discovery reddens the case that expects that
 *   source's row: tracked files, the plan file, and agent memory each have one.
 * - Crediting any `#N` without checking that it is open reddens the
 *   closed-issue row (`src/a.ts:3`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

import { CLI_COMMANDS } from "../lib/cli-commands";
import { arrayElementLines, citationsIn, clip, declarationsIn, memoryDirFor, openIssuesInPage, prBodiesSource, prsFromSearch, trustedAuthors } from "../lib/unaccounted-work";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "unaccounted-work.ts");
const source = readFileSync(SCRIPT, "utf-8");

let SCRATCH: string;
let MUTANT: string;
let HOME_EMPTY: string;
let FIXTURE: string;

beforeAll(() => {
  SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), "unaccounted-work-")));
  MUTANT = join(SCRATCH, "mutant-unaccounted-work.ts");
  const mutated = source.replace(/EXIT_REFUSED\s*=\s*2\b/, "EXIT_REFUSED = 0").replaceAll('"../lib/', `"${ROOT}/lib/`);
  if (!/EXIT_REFUSED = 0/.test(mutated)) throw new Error("could not build the mutant: no `EXIT_REFUSED = 2` in the script");
  writeFileSync(MUTANT, mutated);
  HOME_EMPTY = mkdtempSync(join(SCRATCH, "home-"));
  FIXTURE = join(SCRATCH, "issues.json");
  writeFileSync(FIXTURE, JSON.stringify({ "10": "OPEN", "11": "CLOSED" }));
});

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** A git repository holding `files`, staged so `git ls-files` lists them. */
function repo(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(SCRATCH, "repo-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["add", "-A"], { cwd: root });
  return root;
}

function run(script: string, args: readonly string[], home = HOME_EMPTY) {
  const r = spawnSync("bun", [script, ...args], { cwd: ROOT, encoding: "utf-8", timeout: 60_000, env: { ...process.env, HOME: home } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

type Row = { source: string; path: string; line: number; text: string; cites: number[] };
const json = (out: string) => JSON.parse(out) as {
  sources: { source: string; kind: string; why?: string }[];
  issueStates: { kind: string; why?: string };
  unaccounted: Row[];
  unmeasured: string[];
};
const where = (rows: Row[]) => rows.map(r => `${r.path}:${r.line}`).sort();

/** The consumer shape: no project-state.json, no agent memory. */
const CONSUMER = {
  "src/a.ts": "// TODO: wire the retry\n// TODO(#10): covered by an open issue\n// FIXME see #11, which is closed\n",
  "docs/plan.md": "# Plan\n\nWe need to measure the queue.\n",
  "assets/blob.bin": Buffer.from([0x54, 0x4f, 0x44, 0x4f, 0x00, 0x01]),
};

describe("#2100: undone work in tracked prose that cites no open issue is reported by file and line", () => {
  test("the consumer shape: the uncited TODO, the closed-issue FIXME and the doc line, and nothing else", () => {
    const root = repo(CONSUMER);
    const r = run(SCRIPT, ["--project-root", root, "--issues-fixture", FIXTURE, "--json"]);
    const report = json(r.out);
    expect(where(report.unaccounted)).toEqual(["docs/plan.md:3", "src/a.ts:1", "src/a.ts:3"]);
    expect(report.unaccounted.find(w => w.path === "src/a.ts" && w.line === 3)?.cites).toEqual([11]);
    expect(r.code, "unaccounted work found is exit 1, not a refusal and not clean").toBe(1);
  });

  test("a repository with no plan file or agent memory reports those sources as absent, not as zero", () => {
    const root = repo(CONSUMER);
    const report = json(run(SCRIPT, ["--project-root", root, "--issues-fixture", FIXTURE, "--json"]).out);
    const kind = Object.fromEntries(report.sources.map(s => [s.source, s.kind]));
    // #2489: pull request bodies are read only when asked for, so a plain run reports them absent.
    expect(kind).toEqual({ "tracked-files": "READ", "plan-file": "ABSENT", "agent-memory": "ABSENT", "pr-bodies": "ABSENT" });
    expect(report.unmeasured).toEqual([]);
  });

  test("the text report names each row by path and line, and each source by how it was read", () => {
    const root = repo(CONSUMER);
    const r = run(SCRIPT, ["--project-root", root, "--issues-fixture", FIXTURE]);
    expect(r.out).toContain("src/a.ts:1");
    expect(r.out).toContain("docs/plan.md:3");
    expect(r.out).not.toContain("src/a.ts:2");
    expect(r.out).toMatch(/plan-file: ABSENT/);
  });

  test("a plan file's priorities are a source: a priority citing no open issue is reported at its line", () => {
    const state = JSON.stringify({ priorities: ["Ship the reader (#10).", "Measure the queue before the writer."] }, null, 2);
    const root = repo({ "project-state.json": `${state}\n` });
    const report = json(run(SCRIPT, ["--project-root", root, "--issues-fixture", FIXTURE, "--json"]).out);
    expect(where(report.unaccounted)).toEqual(["project-state.json:4"]);
    expect(report.sources.find(s => s.source === "plan-file")?.kind).toBe("READ");
  });

  test("agent memory is a source when it exists for this root", () => {
    const root = repo({ "README.md": "nothing to do\n" });
    const home = mkdtempSync(join(SCRATCH, "home-mem-"));
    const dir = memoryDirFor(root, home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "fact.md"), "---\nname: x\n---\nThe queue reader is not yet built.\n");
    const report = json(run(SCRIPT, ["--project-root", root, "--issues-fixture", FIXTURE, "--json"], home).out);
    expect(where(report.unaccounted)).toEqual([`${join(dir, "fact.md")}:4`]);
    expect(report.sources.find(s => s.source === "agent-memory")?.kind).toBe("READ");
  });
});

describe("#2100: a source that cannot be read is UNMEASURED by name, and the command exits non-zero", () => {
  test("the refusal has one site, and the mutant can load", () => {
    expect(source.match(/EXIT_REFUSED\s*=/g)?.length, "EXIT_REFUSED must be assigned exactly once").toBe(1);
    expect(source, "an inlined exit would survive the mutation").not.toMatch(/process\.exit\(\s*[1-9]/);
    const relative = [...source.matchAll(/from\s+"(\.[^"]*)"/g)].map(m => m[1]!);
    expect(relative.length, "the scan found no imports, so it checked nothing").toBeGreaterThan(0);
    expect(relative.filter(p => !p.startsWith("../lib/")), "only ../lib/ imports can be rewritten for the mutant").toEqual([]);
  });

  test("a tree whose file list cannot be read: real refuses naming tracked-files, mutant does not", () => {
    const notARepo = mkdtempSync(join(SCRATCH, "not-a-repo-"));
    const real = run(SCRIPT, ["--project-root", notARepo, "--issues-fixture", FIXTURE]);
    expect(real.code).toBe(2);
    expect(`${real.out}${real.err}`).toMatch(/UNMEASURED: tracked-files — /);
    const mutant = run(MUTANT, ["--project-root", notARepo, "--issues-fixture", FIXTURE]);
    expect(mutant.code, "the mutant must not refuse, or the refusal was not what this observed").toBe(0);
    expect(`${mutant.out}${mutant.err}`).toMatch(/UNMEASURED: tracked-files — /);
  });

  test("citations that cannot be checked are reported, never credited, and the run refuses", () => {
    const root = repo({ "src/b.ts": "// TODO(#10): would be covered if #10 could be read\n" });
    const real = run(SCRIPT, ["--project-root", root, "--json"]);
    const report = json(real.out);
    expect(report.issueStates.kind).toBe("UNMEASURED");
    expect(where(report.unaccounted), "an unchecked citation was credited").toEqual(["src/b.ts:1"]);
    expect(real.code).toBe(2);
    const mutant = run(MUTANT, ["--project-root", root, "--json"]);
    expect(mutant.code, "the mutant must not refuse, or the refusal was not what this observed").toBe(0);
    expect(where(json(mutant.out).unaccounted), "the mutant reads the same rows").toEqual(["src/b.ts:1"]);
  });

  test("an unreadable plan file is UNMEASURED, not absent", () => {
    const root = repo({ "project-state.json": "{ not json\n" });
    const real = run(SCRIPT, ["--project-root", root, "--issues-fixture", FIXTURE, "--json"]);
    expect(json(real.out).sources.find(s => s.source === "plan-file")?.kind).toBe("UNMEASURED");
    expect(real.code).toBe(2);
  });

  test("an unknown argument is refused, and nothing is read", () => {
    const r = run(SCRIPT, ["--nope"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/UNMEASURED: unknown argument/);
  });
});

describe("#2100: what counts as a declaration and a citation", () => {
  test("each marker is found on its own line, case as the issue names it", () => {
    const rows = declarationsIn("a\nTODO x\nFIXME y\nwe need to z\nWe Need To w\nnot yet built\ntodo lower\n", "f", "tracked-files");
    expect(rows.map(r => r.line)).toEqual([2, 3, 4, 5, 6]);
  });

  test("a citation is #N standing alone, not an anchor or an entity", () => {
    expect(citationsIn("see #12 and (#13), not page#14 or &#15;")).toEqual([12, 13]);
  });

  test("the command is in the CLI registry", () => {
    expect(CLI_COMMANDS["unaccounted-work"]?.script).toBe("scripts/unaccounted-work.ts");
  });
});

// Review of PR #2188: a text search placed an object-valued priority, and any
// whose search slice cut an escape, at line 0, which looks like a location.
describe("#2100: every plan-file priority is placed at its real line, or the source is UNMEASURED", () => {
  const doc = [
    "{",
    '  "other": { "priorities": ["a decoy at depth 2"] },',
    '  "priorities": [',
    '    "Say \\"hi (one escaped quote, so a walk that ignores escapes loses its place), C:\\\\path, then #10",',
    "    {",
    '      "what": "an object-valued priority"',
    "    },",
    '    "last"',
    "  ]",
    "}",
  ].join("\n");

  test("a JSON-aware walk finds each element's line: escapes, objects and a decoy key do not move it", () => {
    expect(JSON.parse(doc).priorities).toHaveLength(3);
    expect(arrayElementLines(doc, "priorities")).toEqual([4, 5, 8]);
  });

  test("compact JSON puts every element on line 1, an empty array has none, and a missing array is null", () => {
    expect(arrayElementLines('{"priorities":["a",{"b":1},"c"]}', "priorities")).toEqual([1, 1, 1]);
    expect(arrayElementLines('{"priorities": []}', "priorities")).toEqual([]);
    expect(arrayElementLines('{"other": {"priorities": ["x"]}}', "priorities")).toBeNull();
  });

  test("the command reports an object-valued and an escaped priority at their lines, never line 0", () => {
    const root = repo({ "project-state.json": `${doc}\n` });
    const report = json(run(SCRIPT, ["--project-root", root, "--issues-fixture", FIXTURE, "--json"]).out);
    expect(where(report.unaccounted), "the #10 priority is covered; the other two are not").toEqual([
      "project-state.json:5",
      "project-state.json:8",
    ]);
    expect(report.unaccounted.every(d => d.line > 0)).toBe(true);
  });
});

// Review round 2 of PR #2188.
describe("#2100: a refusal is never swallowed, and the memory slug is Claude Code's, not this module's", () => {
  test("an unreadable --issues-fixture refuses even when nothing in the tree cites an issue", () => {
    const root = repo({ "README.md": "nothing cites anything here\n" });
    const real = run(SCRIPT, ["--project-root", root, "--issues-fixture", join(SCRATCH, "no-such-fixture.json"), "--json"]);
    expect(json(real.out).unmeasured.join("\n")).toMatch(/^issue-states — --issues-fixture .* could not be read/);
    expect(real.code).toBe(2);
    expect(run(MUTANT, ["--project-root", root, "--issues-fixture", join(SCRATCH, "no-such-fixture.json")]).code).toBe(0);
  });

  test("memoryDirFor matches project directories Claude Code actually created on 2026-11-14", () => {
    // Literal pairs read off ~/.claude/projects on that date (a dot, an
    // underscore and a leading underscore each become '-'), so a change to
    // the slug rule cannot move the expected path along with it.
    expect(memoryDirFor("/Users/jhorn/.claude", "/h")).toBe("/h/.claude/projects/-Users-jhorn--claude/memory");
    expect(memoryDirFor("/Users/jhorn/Projects/_ape-dataverse-ro", "/h")).toBe(
      "/h/.claude/projects/-Users-jhorn-Projects--ape-dataverse-ro/memory",
    );
    expect(memoryDirFor("/Users/jhorn/Projects/A10_Lightwell_Embedded", "/h")).toBe(
      "/h/.claude/projects/-Users-jhorn-Projects-A10-Lightwell-Embedded/memory",
    );
  });
});

// Review round 3 of PR #2188: a long digit run after # is not an issue number.
test("#2100: a #-prefixed digit run longer than nine digits is not a citation, so it cannot break the issue query", () => {
  expect(citationsIn("see #123456789 and #12345678901234567 and #42")).toEqual([123456789, 42]);
  expect(citationsIn("#999999999"), "nine digits is the largest citation").toEqual([999999999]);
  expect(citationsIn("#1000000000"), "ten digits is not a citation").toEqual([]);
});

// Review round 4 of PR #2188: a priorities key holding a non-array is present and unreadable.
test("#2100: a plan file whose priorities is not an array is UNMEASURED, and one with no priorities key is ABSENT", () => {
  const corrupt = repo({ "project-state.json": JSON.stringify({ priorities: { "ship the reader": true } }) });
  const r = run(SCRIPT, ["--project-root", corrupt, "--issues-fixture", FIXTURE, "--json"]);
  expect(json(r.out).sources.find(s => s.source === "plan-file")?.kind).toBe("UNMEASURED");
  expect(r.code).toBe(2);
  const none = repo({ "project-state.json": JSON.stringify({ updated: "x" }) });
  expect(json(run(SCRIPT, ["--project-root", none, "--issues-fixture", FIXTURE, "--json"]).out).sources.find(s => s.source === "plan-file")?.kind).toBe("ABSENT");
});

// Review round 5 of PR #2188: a page with no repository is not "none open".
test("#2100: a GraphQL page with no repository is a refusal, and only an OPEN Issue counts as open", () => {
  expect(() => openIssuesInPage({ repository: null }, [1])).toThrow(/carried no repository/);
  expect(() => openIssuesInPage(undefined, [1])).toThrow(/carried no repository/);
  const page = {
    repository: {
      n1: { __typename: "Issue", state: "OPEN" },
      n2: { __typename: "PullRequest", state: "OPEN" },
      n3: null,
      n4: { __typename: "Issue", state: "CLOSED" },
    },
  };
  expect(openIssuesInPage(page, [1, 2, 3, 4, 5])).toEqual([1]);
});

describe("#2489: pull request bodies are a source, read when asked for", () => {
  // Our first consumer records gaps in PR bodies when a filing cap stops it
  // filing them, and nothing listed them (2026-11-19, a dated record).
  const PRS = [
    { number: 2310, author_association: "OWNER", body: "Fixes #2299\n\nFollow-up: the calendar page needs the same label, not filed.\nNot done here: the export, see #10." },
    { number: 2298, author_association: "MEMBER", body: null },
    { number: 2293, author_association: "COLLABORATOR", body: "TODO: drop the shim once 0.8.36 is pinned" },
    // Review of #2494: a stranger's body is never read, through the same path the live read uses.
    { number: 2291, author_association: "NONE", body: "TODO: a stranger's line" },
    { number: 2290, body: "TODO: no association at all" },
  ];
  let prsFixture: string;
  beforeAll(() => {
    prsFixture = join(SCRATCH, "prs.json");
    writeFileSync(prsFixture, JSON.stringify(PRS));
  });

  test("a line declaring undone work in a PR body, citing no open issue, is reported by PR number and line", () => {
    const root = repo({ "README.md": "# fine\n" });
    const r = run(SCRIPT, ["--project-root", root, "--issues-fixture", FIXTURE, "--prs-fixture", prsFixture, "--json"]);
    const report = json(r.out);
    expect(where(report.unaccounted.filter(u => u.source === "pr-bodies"))).toEqual(["PR #2293:1", "PR #2310:3"]);
    expect(report.sources.find(s => s.source === "pr-bodies")?.kind).toBe("READ");
    // Review of #2494: the two strangers' PRs are counted as skipped, not vanished.
    const row = report.sources.find(s => s.source === "pr-bodies") as { files?: number; skipped?: number };
    expect(row.files).toBe(5);
    expect(row.skipped).toBe(2);
    expect(run(SCRIPT, ["--project-root", root, "--issues-fixture", FIXTURE, "--prs-fixture", prsFixture]).out).toContain("2 skipped (author not an owner, member or collaborator)");
    expect(r.code).toBe(1);
  });

  test("a PR-body line citing an open issue is accounted for, and a body that is null holds nothing", () => {
    const reading = prBodiesSource({ prs: PRS });
    expect(reading.kind).toBe("READ");
    if (reading.kind !== "READ") return;
    expect(reading.files).toBe(PRS.length);
    const lines = reading.declarations.map(d => `${d.path}:${d.line}`);
    expect(lines).toContain("PR #2310:4");
    expect(reading.declarations.find(d => d.path === "PR #2310" && d.line === 4)?.cites).toEqual([10]);
    expect(lines.filter(l => l.startsWith("PR #2298"))).toEqual([]);
  });

  test("without --since or --prs-fixture the source is ABSENT and says how to read it", () => {
    const root = repo({ "README.md": "# fine\n" });
    const report = json(run(SCRIPT, ["--project-root", root, "--issues-fixture", FIXTURE, "--json"]).out);
    const row = report.sources.find(s => s.source === "pr-bodies");
    expect(row?.kind).toBe("ABSENT");
    expect(row?.why).toContain("--since");
  });

  test("an unreadable --prs-fixture is UNMEASURED and refuses; the mutant does not", () => {
    const root = repo({ "README.md": "# fine\n" });
    const args = ["--project-root", root, "--issues-fixture", FIXTURE, "--prs-fixture", join(SCRATCH, "no-such-prs.json"), "--json"];
    const real = run(SCRIPT, args);
    expect(json(real.out).unmeasured.join("\n")).toMatch(/^pr-bodies — --prs-fixture .* could not be read/m);
    expect(real.code).toBe(2);
    expect(run(MUTANT, args).code).toBe(0);
  });

  // Security review of #2489: a PR body is written by whoever opened the PR.
  test("an escape sequence in a PR body never reaches the report", () => {
    const reading = prBodiesSource({ prs: [{ number: 7, body: "TODO \x1b]8;;https://x\x07click\x1b[31m red\r" }] });
    expect(reading.kind).toBe("READ");
    if (reading.kind !== "READ") return;
    const text = reading.declarations[0].text;
    expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(text).toContain("TODO");
    expect(clip("a\tb")).toBe("a\tb");
    // Review of #2494: text that reorders or hides itself is the same class.
    for (const ch of ["\u202e", "\u2066", "\u2069", "\u200b", "\u200d", "\ufeff", "\u{E0041}", "\u{E007F}", "\u{E0100}", "\u2028", "\u2029"]) {
      expect(clip(`TODO ${ch}x`), JSON.stringify(ch)).toBe("TODO \uFFFDx");
    }
    // An emoji at the cut is kept whole or dropped whole, never halved.
    const cut = clip("a".repeat(156) + "\u{1F600}" + "b".repeat(10));
    expect(cut.endsWith("\u{1F600}...")).toBe(true);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  test("a PR body counts only from an owner, member or collaborator, merged or open", () => {
    const items = [
      { number: 1, author_association: "OWNER" },
      { number: 2, author_association: "MEMBER" },
      { number: 3, author_association: "COLLABORATOR" },
      { number: 4, author_association: "CONTRIBUTOR" },
      { number: 5, author_association: "NONE" },
      { number: 6, author_association: "FIRST_TIME_CONTRIBUTOR" },
      { number: 7 },
    ];
    expect(trustedAuthors(items).map(i => i.number)).toEqual([1, 2, 3]);
  });

  // Review of #2494: GitHub's search stops at 1,000 results, and a partial
  // list must not read as a whole one.
  test("a search that found more pull requests than its pages held is not a READ", () => {
    const page = (n: number, issueCount: number) => ({
      issueCount,
      nodes: Array.from({ length: n }, (_, i) => ({ number: i + 1, body: "b", authorAssociation: "OWNER" })),
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    expect(prsFromSearch([page(3, 3)])).toEqual({
      prs: [1, 2, 3].map(n => ({ number: n, body: "b", author_association: "OWNER" })),
    });
    const cut = prsFromSearch([page(1000, 1400)]);
    expect("why" in cut && cut.why).toBe("the search found 1400 pull requests and only 1000 could be read");
    expect(prsFromSearch([])).toEqual({ prs: [] });
  });

  test("a --since that is not a date is refused before anything is read", () => {
    const root = repo({ "README.md": "# fine\n" });
    const r = run(SCRIPT, ["--project-root", root, "--since", "last week"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--since");
    // Review of #2494: the fixture and --since together are a contradiction.
    const both = run(SCRIPT, ["--project-root", root, "--prs-fixture", join(SCRATCH, "prs.json"), "--since", "2026-11-01"]);
    expect(both.code).toBe(2);
    expect(both.err).toContain("pass one");
    // Review of #2494: a malformed --repo is refused before anything is sent,
    // never read back as zero pull requests.
    const badRepo = run(SCRIPT, ["--project-root", root, "--issues-fixture", FIXTURE, "--since", "2026-11-01", "--repo", "not a repo", "--json"]);
    expect(badRepo.code).toBe(2);
    expect(json(badRepo.out).unmeasured.join("\n")).toMatch(/^pr-bodies — GitHub could not list the pull requests/m);
    // Review of #2494: a day past the end of its month is a typo, not a later date.
    for (const bad of ["2026-02-30", "2026-04-31", "2025-02-29"]) {
      const b = run(SCRIPT, ["--project-root", root, "--since", bad]);
      expect(b.code, bad).toBe(2);
    }
  });
});
