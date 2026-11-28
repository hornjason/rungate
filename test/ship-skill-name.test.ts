/**
 * #2933 (ADR-029, its last row): rungate's own instructions, specs and tests
 * tell an agent to invoke the ship skill as `Skill("ship-issue")`, and every
 * test that reads the skill's folder reads it through `shipSkillPath`.
 *
 * #2949: the scan below also refuses the skill's old name typed as a slash
 * command, which since ADR-029 is Claude Code's built-in, and the old name
 * followed by arguments (review of #2952). This file spells neither in its
 * own text, because the scan reads it too.
 *
 * Covers SC-2819 (HARNESS-STANDARD.md).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { runScaffoldWriteSteps } from "../lib/scaffold/write-steps";
import { shipSkillFolders, shipSkillPath } from "../lib/ship-skill-folder";

const REPO = join(import.meta.dir, "..");
const OLD = "ship";
const NEW = "ship-issue";

/** An instruction to invoke the skill by its old name, in any one quote, with or without arguments. */
const OLD_INVOCATION = /Skill\(\s*\\?(["'`])ship\\?\1\s*[,)]/g;
/**
 * The old name as a slash command (#2949), standing alone as a command is
 * typed. Not a path segment, not an escaped slash or a regex literal, and not
 * the new name. A backslash after the name is a regex escape (`\.`, `\d`),
 * except an escaped quote or a string escape `\n`, `\r`, `\t`, which a string
 * holding the command spells (reviews of #2962). The planted rows below name
 * each case.
 */
const OLD_SLASH = /(?<![\w./~\\-])\/ship(?![\w-]|\.\w|\\[^nrt"'`])/g;
const oldInvocations = (text: string): number =>
  [...text.matchAll(OLD_INVOCATION)].length + [...text.matchAll(OLD_SLASH)].length;

/** Dated records keep the old name: ADR-029 decision 5. */
const DATED = ["docs/adr/", "docs/research/", "reference/"];

/**
 * The one live file allowed the old spelling, and how many times. Its copies
 * are the pre-#2930 generated ship rule, kept as the input whose rewrite that
 * file tests. Exact, so a new copy there and a removed one both fail.
 */
const FIXTURES = new Map<string, number>([
  ["test/ship-mode.test.ts", 5],
  // The one sentence that names Claude Code's built-in slash command on
  // purpose, to say why the skill was renamed (#2949).
  ["specs/HARNESS-STANDARD.md", 1],
]);

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** Every file under `root`, relative, skipping `.git` and `node_modules`. */
function walk(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, rel))) {
    if (name === ".git" || name === "node_modules") continue;
    const p = rel === "" ? name : `${rel}/${name}`;
    if (statSync(join(root, p)).isDirectory()) out.push(...walk(root, p));
    else out.push(p);
  }
  return out;
}

describe("#2933: rungate tells an agent to invoke the ship skill by its new name", () => {
  test("no live file of rungate's invokes the skill by its old name, outside the dated records and one counted fixture", () => {
    // late-env-ok: git ls-files reads the index of REPO, and this file writes no environment variable at all.
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf-8" })
      .split("\0")
      .filter(f => f !== "" && !DATED.some(d => f.startsWith(d)));
    expect(files.length, "the index listed almost nothing, so this case measured nothing").toBeGreaterThan(1000);
    for (const f of FIXTURES.keys()) expect(files, `${f} is gone, so its allowance must go too`).toContain(f);
    const wrong: string[] = [];
    for (const f of files) {
      const p = join(REPO, f);
      // A submodule is a directory in the index; every other entry is read.
      if (statSync(p).isDirectory()) continue;
      const n = oldInvocations(readFileSync(p, "utf-8"));
      const allowed = FIXTURES.get(f) ?? 0;
      if (n !== allowed) wrong.push(`${f}: ${n} (allowed ${allowed})`);
    }
    expect(wrong).toEqual([]);
  });

  test("the scan finds the old name where it is kept and in every quote, and not in the new name", () => {
    expect(oldInvocations(readFileSync(join(REPO, "docs/adr/ADR-029-rename-the-ship-skill.md"), "utf-8")))
      .toBeGreaterThan(0);
    // Review of #2952: a quote escaped inside a string literal, as source spells it.
    for (const s of [`Skill("${OLD}")`, `Skill('${OLD}')`, "Skill(`" + OLD + "`)", `Skill( "${OLD}" )`, `Skill(\\"${OLD}\\")`]) {
      expect(oldInvocations(s), s).toBe(1);
    }
    for (const s of [`Skill("${NEW}")`, `Skill("${OLD}ping")`, `Skill("${OLD}-local")`, `Skill("${OLD}')`]) {
      expect(oldInvocations(s), s).toBe(0);
    }
  });

  test("#2949: the scan finds the old name with arguments and the old slash form, and no path, regex or new name", () => {
    // Review of #2952: arguments after the name.
    for (const s of [`Skill("${OLD}", "42")`, `Skill( '${OLD}' , { issue: 42 })`]) expect(oldInvocations(s), s).toBe(1);
    // The slash form, as the live files spelled it before this change.
    for (const s of [
      `claude --bg --project /tmp/x "/${OLD} 42"`,
      "const args = [\"--bg\", `/" + OLD + " ${job.issue}`];",
      `Run /${OLD} first.`,
      `After /${OLD} to prove the fix works`,
      `| /${OLD} | Yes | After /goal |`,
      `Claude Code ships a built-in \`/${OLD}\`.`,
      // Review of #2962: inside a string with escaped quotes.
      `const s = "\\"/${OLD}\\"";`,
      // Review round 2 of #2962: followed by a string escape.
      `const s = "Run /${OLD}\\nNext";`,
      `const s = "Run /${OLD}\\tfirst";`,
    ]) {
      expect(oldInvocations(s), s).toBe(1);
    }
    for (const s of [
      `/${NEW} 42`,
      `workflows/${OLD}.js`,
      `some/dir/${OLD}/file.md`,
      `prove/${OLD} gates`,
      `/${OLD}ping`,
      `/${OLD}.js`,
      `/\\/${OLD}(?:-issue)?/`,
      `toMatch(/${OLD}\\.js:\\d+/)`,
      `toMatch(/${OLD}\\d+/)`,
    ]) {
      expect(oldInvocations(s), s).toBe(0);
    }
  });

  test("a scaffolded consumer is told Skill(\"ship-issue\"), never the old name, and gets no command of that name", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-2933-consumer-"));
    scratch.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "consumer", version: "0.0.0" }));
    runScaffoldWriteSteps(root, "node" as never, [], { rehearsing: true });
    const files = walk(root);
    expect(files.length, "the scaffold wrote almost nothing, so this case measured nothing").toBeGreaterThan(20);
    const told = files.filter(f => readFileSync(join(root, f), "utf-8").includes(`Skill("${NEW}")`));
    expect(told.length, "no generated file names the skill at all").toBeGreaterThan(0);
    expect(files.filter(f => oldInvocations(readFileSync(join(root, f), "utf-8")) > 0)).toEqual([]);
    const commands = join(root, ".claude", "commands");
    expect(existsSync(commands), "the scaffold wrote no commands, so the next line measures nothing").toBe(true);
    expect(readdirSync(commands)).not.toContain(`${NEW}.md`);
  });
});

describe("#2933: every test that reads the ship skill's folder reads it through the resolver", () => {
  // The same three patterns #2932's scan of non-test source uses, read out of
  // test/ship-skill-folder.test.ts below, so the two scans cannot drift apart.
  const SPELLING = /(?:["'`]|\/)skills["'`]\s*,\s*["'`]ship(?:-issue)?(?:["'`]|\/)|skills\/ship(?:-issue)?(?=[\/"'`])/g;
  const SKILLS_PART = /(?:["'`]|\/)skills["'`]|skills\//;
  const SHIP_PART = /["'`]ship(?:-issue)?(?:["'`]|\/)|\/ship(?:-issue)?(?=[\/"'`])/;
  const FOLDER_TEST = "test/ship-skill-folder.test.ts";
  type TranspilerOptions = ConstructorParameters<typeof Bun.Transpiler>[0];
  const transpiler = new Bun.Transpiler({ loader: "ts", macro: false } as unknown as TranspilerOptions);

  /** The code of a test file with its comments gone. One that does not parse throws, naming itself. */
  function codeOf(file: string, text: string): string {
    try {
      return transpiler.transformSync(text);
    } catch (e) {
      throw new Error(`${file} could not be parsed, so it was not read: ${String(e)}`);
    }
  }

  function spellings(files: string[]): string[] {
    const hits: string[] = [];
    for (const f of files) {
      const code = codeOf(f, readFileSync(join(REPO, f), "utf-8"));
      const before = hits.length;
      for (const m of code.matchAll(SPELLING)) {
        hits.push(`${f}: ${code.slice(Math.max(0, m.index - 60), m.index + m[0].length + 30).replace(/\s+/g, " ").trim()}`);
      }
      const skills = code.match(SKILLS_PART), ship = code.match(SHIP_PART);
      if (hits.length === before && skills && ship) hits.push(`${f}: names the skills folder (${skills[0]}) and the skill (${ship[0]}) apart`);
    }
    return hits;
  }

  test("the patterns are #2932's, character for character", () => {
    const theirs = readFileSync(join(REPO, FOLDER_TEST), "utf-8");
    for (const literal of [`/${SPELLING.source}/g`, `/${SKILLS_PART.source}/`, `/${SHIP_PART.source}/`]) {
      expect(theirs, literal).toContain(literal);
    }
  });

  test("no test under test/ or gates/ spells the folder's path, whole or in parts", () => {
    // late-env-ok: git ls-files reads the index of REPO, and this file writes no environment variable at all.
    const tests = execFileSync("git", ["ls-files", "-z", "--", "test", "gates"], { cwd: REPO, encoding: "utf-8" })
      .split("\0")
      .filter(f => /\.test\.ts$/.test(f));
    expect(tests.length, "no test files listed, so this case measured nothing").toBeGreaterThan(300);
    // The one file let off plants the path on purpose to test the detector.
    // Asserted to still do so, so the exemption cannot outlive its reason.
    expect(tests).toContain(FOLDER_TEST);
    expect(spellings([FOLDER_TEST]).length, `${FOLDER_TEST} no longer plants the path; drop its exemption`).toBeGreaterThan(0);
    expect(spellings(tests.filter(f => f !== FOLDER_TEST))).toEqual([]);
  });
});

describe("#2933: the .sh sweep reads both of the skill's folders, and can fail", () => {
  /**
   * A `.claude` directory with the named skill folders, each holding the given
   * files. The skills directory is derived through the resolver, so this file
   * never quotes it.
   */
  function claudeWith(folders: Record<string, string[]>): string {
    const claude = join(mkdtempSync(join(tmpdir(), "rg-2933-home-")), ".claude");
    scratch.push(dirname(claude));
    const skills = dirname(dirname(shipSkillPath(claude, "probe")));
    for (const [folder, files] of Object.entries(folders)) {
      mkdirSync(join(skills, folder), { recursive: true });
      for (const f of files) writeFileSync(join(skills, folder, f), "x");
    }
    return claude;
  }

  test("shipSkillFolders names every folder that exists, the new name first", () => {
    const skills = (claude: string) => dirname(dirname(shipSkillPath(claude, "probe")));
    const none = claudeWith({});
    expect(shipSkillFolders(none)).toEqual([]);
    const old = claudeWith({ [OLD]: ["SKILL.md"] });
    expect(shipSkillFolders(old)).toEqual([join(skills(old), OLD)]);
    const both = claudeWith({ [NEW]: ["SKILL.md"], [OLD]: ["SKILL.md"] });
    expect(shipSkillFolders(both)).toEqual([join(skills(both), NEW), join(skills(both), OLD)]);
  });

  test("the e2e sweep goes red for a .sh left in the old folder while the new one exists, and green for a clean pair", () => {
    // Review of #2952: the sweep's assertion sat inside a `catch {}`, and it read
    // one folder. Both are observed here by running the real test against a planted home.
    const run = (claude: string) => {
      const r = spawnSync("bun", ["test", join(REPO, "gates", "e2e-smoke.test.ts"), "-t", "stop-the-bleeding"], {
        cwd: REPO, encoding: "utf-8", timeout: 120_000,
        env: { ...process.env, HOME: dirname(claude) },
      });
      return `${r.stdout ?? ""}${r.stderr ?? ""}`;
    };
    const dirty = run(claudeWith({ [NEW]: ["SKILL.md"], [OLD]: ["gate-runner.sh"] }));
    expect(dirty, dirty.slice(-1500)).toMatch(/\b1 fail\b/);
    expect(dirty).toContain("gate-runner.sh");
    const clean = run(claudeWith({ [NEW]: ["SKILL.md"], [OLD]: ["SKILL.md"] }));
    expect(clean, clean.slice(-1500)).toMatch(/\b1 pass\b/);
    expect(clean).toMatch(/\b0 fail\b/);
  }, 300_000);

  test("with HOME unset, the sweep reads the real home and never a .claude under the working directory", () => {
    // Review of #2952: `process.env.HOME || ""` read `.claude` relative to the
    // working directory when HOME was unset. A .sh planted there must not be
    // read. The run itself may pass or fail on the real home; it must run.
    const cwd = dirname(claudeWith({ [OLD]: ["planted.sh"] }));
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.HOME;
    const r = spawnSync("bun", ["test", join(REPO, "gates", "e2e-smoke.test.ts"), "-t", "stop-the-bleeding"], {
      cwd, env, encoding: "utf-8", timeout: 120_000,
    });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(out, out.slice(-1500)).toMatch(/\b1 (pass|fail)\b/);
    expect(out).not.toContain("planted.sh");
  }, 300_000);
});
