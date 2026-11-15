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
import { citationsIn, declarationsIn, memoryDirFor } from "../lib/unaccounted-work";

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
    expect(kind).toEqual({ "tracked-files": "READ", "plan-file": "ABSENT", "agent-memory": "ABSENT" });
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
