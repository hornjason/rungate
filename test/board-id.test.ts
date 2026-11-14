/**
 * #2173: `rungate board-id` prints the board's node id from the project's
 * config, so a generated workflow that works in shell (`board-intake.yml`,
 * #2166) can learn the board without naming it.
 *
 * ## What was broken to prove these can fail
 *
 * Every refusal runs twice on the same input: against the real script, and
 * against a mutant whose single `EXIT_REFUSED = 2` is rewritten to `0`. Real
 * must refuse, mutant must not. The mutant lives in a temp directory, so its
 * `../lib/` imports are rewritten to this repository's absolute `lib/` path;
 * the test asserts there are no OTHER relative imports, or the mutant would
 * die on module resolution and read as a refusal.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { CLI_COMMANDS } from "../lib/cli-commands";
import { readBoardProjectId } from "../lib/config-readers";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "board-id.ts");
const source = readFileSync(SCRIPT, "utf-8");

let SCRATCH: string;
let MUTANT: string;

beforeAll(() => {
  SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), "board-id-")));
  MUTANT = join(SCRATCH, "mutant-board-id.ts");
  const mutated = source.replace(/EXIT_REFUSED\s*=\s*2\b/, "EXIT_REFUSED = 0").replaceAll('"../lib/', `"${ROOT}/lib/`);
  if (!/EXIT_REFUSED = 0/.test(mutated)) throw new Error("could not build the mutant: no `EXIT_REFUSED = 2` in scripts/board-id.ts");
  writeFileSync(MUTANT, mutated);
});

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** A project root holding this repository's config, with `board.id` set to `id`, or removed. */
function treeWithBoard(id: string | null): string {
  const root = mkdtempSync(join(SCRATCH, "tree-"));
  const config = JSON.parse(readFileSync(join(ROOT, ".claude", "rungate", "config.json"), "utf-8"));
  if (id === null) delete config.board.id;
  else config.board.id = id;
  mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
  writeFileSync(join(root, ".claude", "rungate", "config.json"), JSON.stringify(config, null, 2));
  return root;
}

function run(script: string, args: readonly string[], cwd = ROOT) {
  const r = spawnSync("bun", [script, ...args], { cwd, encoding: "utf-8", timeout: 30_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("#2173: rungate board-id", () => {
  test("the refusal has one site, and the mutant can load", () => {
    expect(source.match(/EXIT_REFUSED\s*=/g)?.length, "EXIT_REFUSED must be assigned exactly once").toBe(1);
    expect(source, "an inlined non-zero exit would survive the mutation").not.toMatch(/process\.exit\(\s*[1-9]/);
    const relative = [...source.matchAll(/from\s+"(\.[^"]*)"/g)].map(m => m[1]!);
    expect(relative.filter(p => !p.startsWith("../lib/")), "only ../lib/ imports can be rewritten for the mutant").toEqual([]);
  });

  test("prints board.id from --project-root, on one line and nothing else", () => {
    const root = treeWithBoard("PVT_fixture_board");
    const r = run(SCRIPT, ["--project-root", root]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("PVT_fixture_board\n");
  });

  test("defaults to the working directory, and reads this repository's own board", () => {
    const r = run(SCRIPT, []);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(readBoardProjectId(ROOT)!);
    expect(r.out.trim()).toMatch(/^PVT_/);
  });

  test("no board.id is UNMEASURED and exit 2, never an empty line and 0", () => {
    const root = treeWithBoard(null);
    const real = run(SCRIPT, ["--project-root", root]);
    expect(real.code).toBe(2);
    expect(real.out).toBe("");
    expect(real.err).toMatch(/UNMEASURED: .*board\.id/);
    const mutant = run(MUTANT, ["--project-root", root]);
    expect(mutant.code, "the mutant must not refuse, or the refusal was not what this observed").toBe(0);
    expect(mutant.err).toMatch(/UNMEASURED: .*board\.id/);
  });

  test("no config at all is UNMEASURED too", () => {
    const empty = mkdtempSync(join(SCRATCH, "empty-"));
    const real = run(SCRIPT, ["--project-root", empty]);
    expect(real.code).toBe(2);
    expect(real.out).toBe("");
    expect(real.err).toMatch(/UNMEASURED: .*board\.id/);
    expect(run(MUTANT, ["--project-root", empty]).code).toBe(0);
  });

  test("a malformed config is not a missing one: it throws", () => {
    const root = mkdtempSync(join(SCRATCH, "bad-"));
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    writeFileSync(join(root, ".claude", "rungate", "config.json"), "{ not json");
    const r = run(SCRIPT, ["--project-root", root]);
    expect(r.code).not.toBe(0);
    expect(r.out).toBe("");
    expect(r.err, "a corrupt config must not read as an absent board").not.toMatch(/UNMEASURED: .*board\.id/);
  });

  test("an unknown argument, or --project-root with nothing after it, refuses", () => {
    for (const args of [["--nope"], ["--project-root"]]) {
      const real = run(SCRIPT, args);
      expect(real.code, `${args.join(" ")} was accepted`).toBe(2);
      expect(real.out).toBe("");
      expect(run(MUTANT, args).code).toBe(0);
    }
  });

  test("it is a registered command, shipped in files[]", () => {
    expect(CLI_COMMANDS["board-id"]?.script).toBe("scripts/board-id.ts");
    const files: string[] = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")).files;
    expect(files).toContain("scripts/board-id.ts");
  });
});
