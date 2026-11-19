/**
 * #2479: a half-installed rungate says so, instead of crashing on a module.
 *
 * Reported by our first consumer's session on 2026-11-19 (a dated record, not
 * a deadline): with four agents running `bunx rungate@0.8.35` at once, one
 * `sync-sc-status --dry-run` died on `Cannot find package 'zod'` from inside
 * the bunx temp directory, and another on `@octokit/rest`. A version-pinned
 * bunx installs into one shared directory per version, so a run can find it
 * half-written. The crash names a temp path and says nothing a person can act
 * on.
 *
 * These cases build a real install shape: the published directories copied
 * to `<tmp>/node_modules/rungate`, beside a `node_modules` holding every
 * package this repository has installed except the ones a case leaves out.
 * The CLI is then run from that copy, the way bunx runs it.
 *
 * Exit status alone cannot tell the guard from the crash it replaces, because
 * both exit 1. So every refusal is asserted on the guard's own message, and a
 * mutant copy with `INCOMPLETE_INSTALL_EXIT` set to 0 must print the same
 * message and exit 0. That shows the refusal is the constant's.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  INCOMPLETE_INSTALL_EXIT,
  incompleteInstallMessage,
  missingDependencies,
} from "../lib/install-integrity";

const ROOT = join(import.meta.dir, "..");
const SOURCE = readFileSync(join(ROOT, "lib/install-integrity.ts"), "utf8");
const MARK = "rungate: this install is incomplete";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/**
 * `<tmp>/node_modules/rungate` holding bin/, lib/, scripts/ and package.json,
 * beside a symlink to each of this repository's installed packages except
 * `omit`. When `mutant` is set, the copy's exit constant is 0.
 */
function install(opts: { omit?: string[]; mutant?: boolean } = {}): { pkg: string; project: string } {
  const tmp = mkdtempSync(join(tmpdir(), "install-integrity-"));
  made.push(tmp);
  const nm = join(tmp, "node_modules");
  const pkg = join(nm, "rungate");
  mkdirSync(pkg, { recursive: true });
  for (const d of ["bin", "lib", "scripts"]) cpSync(join(ROOT, d), join(pkg, d), { recursive: true });
  cpSync(join(ROOT, "package.json"), join(pkg, "package.json"));
  const omit = new Set(opts.omit ?? []);
  const repoNm = join(ROOT, "node_modules");
  for (const entry of readdirSync(repoNm)) {
    if (entry === "rungate" || entry === ".bin" || entry === ".cache") continue;
    if (entry.startsWith("@")) {
      for (const sub of readdirSync(join(repoNm, entry))) {
        const name = `${entry}/${sub}`;
        if (omit.has(name)) continue;
        mkdirSync(join(nm, entry), { recursive: true });
        symlinkSync(join(repoNm, entry, sub), join(nm, entry, sub));
      }
    } else if (!omit.has(entry)) {
      symlinkSync(join(repoNm, entry), join(nm, entry));
    }
  }
  if (opts.mutant) {
    const line = "export const INCOMPLETE_INSTALL_EXIT = 1;";
    writeFileSync(join(pkg, "lib/install-integrity.ts"), SOURCE.replace(line, "export const INCOMPLETE_INSTALL_EXIT = 0;"));
  }
  const project = join(tmp, "project");
  mkdirSync(project);
  return { pkg, project };
}

function run(pkg: string, project: string, args: string[]) {
  const r = spawnSync(process.execPath, [join(pkg, "bin/rungate.ts"), ...args], {
    cwd: project,
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { code: r.status, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}

describe("#2479: the install is checked before a command runs", () => {
  test("the exit constant appears once, and the module imports only node builtins", () => {
    expect(SOURCE.split("export const INCOMPLETE_INSTALL_EXIT = 1;").length - 1).toBe(1);
    expect(SOURCE.split("process.exit(").length - 1, "the lib must not exit; bin/rungate.ts does").toBe(0);
    const bin = readFileSync(join(ROOT, "bin/rungate.ts"), "utf8");
    expect(bin.split("process.exit(INCOMPLETE_INSTALL_EXIT)").length - 1, "the CLI's one refusal site").toBe(1);
    // It runs inside an install that may be missing any dependency, so it
    // must not need one itself, and it must not reach into another lib file.
    const specifiers = [...SOURCE.matchAll(/^import .* from "([^"]+)";$/gm)].map(m => m[1]);
    expect(specifiers.length, "no import read, so the check is over nothing").toBeGreaterThan(0);
    expect(specifiers.filter(s => !["fs", "path", "node:fs", "node:path"].includes(s))).toEqual([]);
  });

  test("this repository's own install is complete", () => {
    expect(missingDependencies(ROOT)).toEqual([]);
  });

  test("a dependency that does not resolve is named; the rest are not", () => {
    const { pkg } = install({ omit: ["zod"] });
    expect(missingDependencies(pkg)).toEqual(["zod"]);
  });

  // Review of #2491, round 4: a manifest that parses but declares no
  // dependencies is as torn as one that does not parse.
  test("a package.json that parses but declares no dependencies is named as unreadable, not read as complete", () => {
    for (const body of ["{}", '{"name":"rungate","dependencies":null}', '{"name":"rungate","dependencies":{}}', '{"dependencies":[]}']) {
      const { pkg } = install();
      writeFileSync(join(pkg, "package.json"), body);
      expect(missingDependencies(pkg), body).toEqual(["package.json (unreadable: it declares no dependencies)"]);
    }
  });

  // Review of #2491, round 4: the command's own script is part of the
  // install, and a half-written one is the same race.
  test("a run whose command script is missing refuses with the message, naming the script and the packaging cause", () => {
    const { pkg, project } = install();
    rmSync(join(pkg, "scripts/sync-sc-status.ts"));
    const r = run(pkg, project, ["sync-sc-status", "--dry-run"]);
    expect(r.stderr, `no guard message; stderr was:\n${r.stderr}`).toContain(MARK);
    expect(r.stderr).toContain("scripts/sync-sc-status.ts");
    expect(r.stderr).toContain('"files" field');
    expect(r.code).toBe(INCOMPLETE_INSTALL_EXIT);
  });

  // Review of #2491, round 3: the check walks the tree, so a dependency's
  // own missing dependency is named by the path that needed it.
  test("a missing package two hops down is named by the path that needed it", () => {
    const { pkg } = install({ omit: ["@octokit/core"] });
    expect(missingDependencies(pkg)).toContain("@octokit/rest > @octokit/core");
  });

  test("a run from an install missing a transitive dependency refuses with the message", () => {
    const { pkg, project } = install({ omit: ["@octokit/core"] });
    const r = run(pkg, project, ["sync-sc-status", "--dry-run"]);
    expect(r.stderr, `no guard message; stderr was:\n${r.stderr}`).toContain(MARK);
    expect(r.stderr).toContain("@octokit/rest > @octokit/core");
    expect(r.code).toBe(INCOMPLETE_INSTALL_EXIT);
  });

  // Review of #2491: the race that half-writes a dependency can half-write
  // rungate's own manifest, and the check must refuse by name, not throw.
  test("a truncated package.json is named as missing, not thrown", () => {
    const { pkg } = install();
    writeFileSync(join(pkg, "package.json"), '{ "name": "rungate", "dependencies": { "zod"');
    const missing = missingDependencies(pkg);
    expect(missing.length).toBe(1);
    expect(missing[0]).toStartWith("package.json (unreadable: ");
  });

  test("a run from an install whose package.json is truncated refuses with the message, not a stack trace", () => {
    const { pkg, project } = install();
    writeFileSync(join(pkg, "package.json"), '{ "name": "rungate", "dependencies": { "zod"');
    const r = run(pkg, project, ["sync-sc-status", "--dry-run"]);
    expect(r.stderr, `no guard message; stderr was:\n${r.stderr}`).toContain(MARK);
    expect(r.stderr).toContain("package.json (unreadable: ");
    expect(r.stderr, "an uncaught throw reached the user").not.toMatch(/^\s+at /m);
    expect(r.code).toBe(INCOMPLETE_INSTALL_EXIT);
  });

  test("the message names the install, every missing package, the cause and the way out", () => {
    const msg = incompleteInstallMessage("/x/node_modules/rungate", ["zod", "@octokit/rest"]);
    expect(msg).toContain(MARK);
    expect(msg).toContain("/x/node_modules/rungate");
    expect(msg).toContain("zod, @octokit/rest");
    expect(msg).toContain("bunx");
    expect(msg).toContain("node_modules/.bin/rungate");
  });

  test("a run from an install missing zod refuses with the message, not a module crash", () => {
    const { pkg, project } = install({ omit: ["zod"] });
    const r = run(pkg, project, ["sync-sc-status", "--dry-run"]);
    expect(r.stderr, `no guard message; stderr was:\n${r.stderr}`).toContain(MARK);
    expect(r.stderr).toContain("zod");
    expect(r.stderr, "the command ran anyway and crashed").not.toContain("Cannot find package");
    expect(r.code).toBe(INCOMPLETE_INSTALL_EXIT);
  });

  test("the same with @octokit/rest missing, the consumer's other report", () => {
    const { pkg, project } = install({ omit: ["@octokit/rest"] });
    const r = run(pkg, project, ["sync-sc-status", "--dry-run"]);
    expect(r.stderr).toContain(MARK);
    expect(r.stderr).toContain("@octokit/rest");
    expect(r.code).toBe(INCOMPLETE_INSTALL_EXIT);
  });

  test("mutant: with the constant at 0 the same install prints the message and exits 0", () => {
    const { pkg, project } = install({ omit: ["zod"], mutant: true });
    const r = run(pkg, project, ["sync-sc-status", "--dry-run"]);
    expect(r.stderr, "the mutant did not reach the guard").toContain(MARK);
    expect(r.code).toBe(0);
  });

  test("control: a complete install runs the command and prints no guard message", () => {
    const { pkg, project } = install();
    const r = run(pkg, project, ["sync-sc-status", "--dry-run"]);
    expect(r.stderr).not.toContain(MARK);
    expect(r.stderr).not.toContain("Cannot find package");
  });

  test("control: --version and --help need no dependency and are not checked", () => {
    const { pkg, project } = install({ omit: ["zod"] });
    const v = run(pkg, project, ["--version"]);
    expect(v.code).toBe(0);
    expect(v.stderr).not.toContain(MARK);
    const h = run(pkg, project, ["--help"]);
    expect(h.code).toBe(0);
    expect(h.stderr).not.toContain(MARK);
  });
});
