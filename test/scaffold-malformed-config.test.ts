/**
 * #2520: scaffold meets a rungate config it cannot use, and refuses by name.
 *
 * Measured on main before this change: a config that is not JSON threw
 * `SyntaxError: JSON Parse error` out of `testCommandDecision`, and one that
 * fails the schema threw a raw `ZodError`. Both came out as a stack trace with
 * exit code 1, named no file, and reached nothing that could repair them.
 * The repair the scaffold's comments describe sat behind a reader that threw
 * first.
 *
 * `.claude/rules/config-access.md` decides the direction: a corrupt config is
 * never a missing one, and a default is never substituted for it. So the run
 * refuses at the start, names the file and the reason, and writes nothing.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { ScaffoldConfigUnreadable, runScaffoldWriteSteps } from "../lib/scaffold/write-steps";

const ROOT = join(import.meta.dir, "..");
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A fresh tree holding only `.claude/rungate/config.json` with `body`. */
function tree(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-scaffold-bad-config-"));
  made.push(dir);
  mkdirSync(join(dir, ".claude", "rungate"), { recursive: true });
  writeFileSync(join(dir, ".claude", "rungate", "config.json"), body);
  return dir;
}

/** Everything in the tree except the config the case planted. */
function written(dir: string): string[] {
  return readdirSync(dir).filter(name => name !== ".claude");
}

const SHAPES = [
  { name: "not JSON", body: "{ not json", reason: /JSON/ },
  { name: "fails the schema", body: '{"dev": 5, "test": "x"}', reason: /dev/ },
];

describe("#2520: runScaffoldWriteSteps refuses a config it cannot read, before writing anything", () => {
  for (const shape of SHAPES) {
    test(`a config that ${shape.name} refuses by name, with the reason, and leaves the tree as it was`, () => {
      const dir = tree(shape.body);
      let caught: unknown;
      try {
        runScaffoldWriteSteps(dir, "code", []);
      } catch (e) {
        caught = e;
      }
      expect(caught, "the run threw nothing, or threw something other than the refusal").toBeInstanceOf(ScaffoldConfigUnreadable);
      const message = (caught as Error).message;
      expect(message).toStartWith("scaffold: UNMEASURED —");
      expect(message).toContain(join(".claude", "rungate"));
      expect(message).toMatch(shape.reason);
      expect(written(dir), "the refusal came after something was written").toEqual([]);
    });
  }
});

describe("#2520: the CLI prints the refusal, not a stack trace, in both modes", () => {
  const run = (dir: string, fix: boolean) => {
    const proc = Bun.spawnSync(["bun", join(ROOT, "scripts", "scaffold-project.ts"), dir, ...(fix ? ["--fix"] : [])], {
      cwd: ROOT,
    });
    return { code: proc.exitCode, err: new TextDecoder().decode(proc.stderr) };
  };

  for (const fix of [true, false]) {
    test(`${fix ? "--fix" : "audit"}: exits non-zero with one named refusal and no stack frames`, () => {
      const dir = tree("{ not json");
      const r = run(dir, fix);
      expect(r.code, r.err).not.toBe(0);
      expect(r.err).toContain("scaffold: UNMEASURED —");
      expect(r.err, "a stack frame reached the consumer").not.toMatch(/^\s+at .+\.ts:\d+/m);
      expect(written(dir)).toEqual([]);
      expect(existsSync(join(dir, ".gitignore"))).toBe(false);
    }, 60_000);
  }
});
