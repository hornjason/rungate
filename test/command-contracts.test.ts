/**
 * Covers #1746 — `/stage-audit` and `/round-rca` exist as commands rather than
 * as a description in a conversation.
 *
 * The thing that makes a command a command and not prose is that part of it
 * RUNS. A `.claude/commands/*.md` file may carry `!`…`` blocks, which the
 * runtime executes and injects before the agent reads a word of the body. So
 * the cases here EXECUTE every block — against a planted `gh`, so the live
 * network is never what decides whether an assertion runs.
 *
 * Every assertion was confirmed able to fail by breaking the thing it guards;
 * what was broken is written beside each one.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const COMMANDS = join(ROOT, ".claude", "commands");

/**
 * The two commands #1746 is about. A third command added later is not
 * silently governed by the structural cases — it has to be named here, which
 * is the point: that population is declared, not discovered.
 *
 * The injection case below deliberately does NOT use this list. It draws its
 * own population from the directory, because a sweep drawn around the members
 * somebody already named is still a patch.
 */
const GOVERNED = ["stage-audit", "round-rca"] as const;

/** The one binding that decides what an executable block is. */
export function executableBlocks(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter(line => line.startsWith("!`") && line.trimEnd().endsWith("`"))
    .map(line => line.slice(2, line.trimEnd().length - 1));
}

const scratch = mkdtempSync(join(tmpdir(), "rg-command-contracts-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function read(name: string): string {
  const path = join(COMMANDS, `${name}.md`);
  if (!existsSync(path)) {
    throw new Error(
      `UNMEASURED: .claude/commands/${name}.md does not exist, so nothing below measured it. ` +
        `#1746 is the issue that creates it.`,
    );
  }
  return readFileSync(path, "utf-8");
}

/**
 * Runs a block the way the runtime does: `$ARGUMENTS` replaced textually,
 * then the whole line handed to a shell, from the repository root.
 *
 * `stubGh` puts a planted `gh` first on PATH. Without it the API-reading
 * blocks answer differently depending on a credential and a network this
 * suite does not control, and the cases that matter would quietly stop
 * running — see the UNMEASURED-is-not-a-pass rule in
 * `.claude/rules/config-access.md`.
 */
function runBlock(block: string, args: string, opts: { stubGh?: string } = {}): { code: number; out: string } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.GH_TOKEN;
  if (opts.stubGh !== undefined) env.PATH = `${opts.stubGh}:${env.PATH ?? ""}`;
  const p = Bun.spawnSync(["bash", "-c", block.replaceAll("$ARGUMENTS", args)], { cwd: ROOT, env });
  return {
    code: p.exitCode ?? -1,
    out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr),
  };
}

/** A `gh` that answers from fixtures, so the comparison logic always runs. */
function plantGh(label: string, runs: { total_count: number; workflow_runs: { head_sha: string }[] }): string {
  const dir = join(scratch, label);
  const meta = { headRefName: "rg/planted", createdAt: "2026-11-01T00:00:00Z", state: "OPEN", url: "u" };
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(join(scratch, `${label}.runs.json`), JSON.stringify(runs));
  writeFileSync(join(scratch, `${label}.meta.json`), JSON.stringify(meta));
  require("fs").mkdirSync(dir, { recursive: true });
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    `#!/bin/sh\ncase "$1" in\n  pr) cat ${JSON.stringify(join(scratch, `${label}.meta.json`))} ;;\n` +
      `  api) cat ${JSON.stringify(join(scratch, `${label}.runs.json`))} ;;\n  *) exit 1 ;;\nesac\n`,
  );
  chmodSync(gh, 0o755);
  return dir;
}

const runsOf = (shas: string[], total = shas.length) => ({
  total_count: total,
  workflow_runs: shas.map(s => ({ head_sha: s, event: "pull_request", conclusion: "success", created_at: "x" })),
});

describe("the commands #1746 creates are executable, not prose", () => {
  for (const name of GOVERNED) {
    test(`${name} declares what it takes and what it is for`, () => {
      const text = read(name);
      expect(text.startsWith("---\n"), `${name}.md must open with frontmatter`).toBe(true);
      const front = text.slice(4, text.indexOf("\n---", 4));
      // Broken to prove it: deleting either line turns this red.
      expect(front, `${name}.md needs an argument-hint`).toContain("argument-hint:");
      expect(front, `${name}.md needs a description`).toContain("description:");
    });

    test(`${name} carries at least one block the runtime executes`, () => {
      // Broken to prove it: removing the leading `!` makes it an ordinary
      // line the runtime never runs. That is the whole difference between
      // these files and the prose they replace, so it is asserted.
      const blocks = executableBlocks(read(name));
      expect(blocks.length, `${name}.md has no \`!\`…\`\` block, so nothing in it runs`).toBeGreaterThan(0);
    });
  }

  test("no command interpolates its argument as a bare word, and the shell cannot execute it", () => {
    // The population is every command on disk, not the two this issue names.
    // #1746's own two had this defect; so did ship-issue.md, which nobody
    // reported — a sweep drawn around the named members is still a patch.
    const files = readdirSync(COMMANDS).filter(f => f.endsWith(".md"));
    expect(files.length, "no command files found, so this case measured nothing").toBeGreaterThan(0);

    const bare: string[] = [];
    for (const f of files) {
      for (const block of executableBlocks(readFileSync(join(COMMANDS, f), "utf-8"))) {
        if (!block.includes("$ARGUMENTS")) continue;
        // The only accepted shape: assigned to a NAME, inside double quotes,
        // so the shell has finished parsing before any code reads the value.
        for (const at of [...block.matchAll(/\$ARGUMENTS/g)].map(m => m.index ?? 0)) {
          if (!/[A-Z_]+="$/.test(block.slice(0, at))) bare.push(`${f}: …${block.slice(Math.max(0, at - 40), at + 10)}…`);
        }
      }
    }
    expect(
      bare,
      "a command interpolates $ARGUMENTS as a bare word. The runtime substitutes it textually " +
        "BEFORE the shell parses the line, so any validation inside the script runs after the " +
        'shell has already executed it. Use NAME="$ARGUMENTS" and read it from the environment.',
    ).toEqual([]);

    // Asserted by execution, not by the pattern above. Broken to prove it:
    // reverting round-rca to `-- $ARGUMENTS` deletes this canary and this
    // goes red. Measured before the fix: it did.
    const canary = join(scratch, "canary.txt");
    for (const f of files) {
      for (const block of executableBlocks(readFileSync(join(COMMANDS, f), "utf-8"))) {
        if (!block.includes("$ARGUMENTS")) continue;
        writeFileSync(canary, "alive");
        runBlock(block, `1725; rm -f ${canary}`);
        expect(existsSync(canary), `${f} executed a semicolon in its argument as a command`).toBe(true);
      }
    }
  });

  test("stage-audit decides whether this tree can be measured, and refuses this one", () => {
    const blocks = executableBlocks(read("stage-audit"));
    const probe = blocks.find(b => b.includes("--git-common-dir"));
    expect(probe, "no block in stage-audit.md resolves --git-common-dir").toBeDefined();

    // Executed, not matched. The suite runs from a linked worktree or from a
    // branch — either way this is not the primary checkout on main, so the
    // probe must REFUSE and say why.
    //
    // Broken to prove it: a probe that still RUNS both git commands but
    // never compares them — the mutant the substring version of this case
    // could not see — prints "Proceed." here and turns this red.
    const here = runBlock(probe as string, "B");
    expect(here.code, `the probe exited ${here.code}:\n${here.out}`).toBe(0);
    expect(here.out, "the probe must emit a verdict, not raw git output for a reader to compare").toMatch(
      /^(REFUSE:|PRIMARY CHECKOUT ON MAIN)/m,
    );
    expect(
      here.out,
      "this suite does not run from the primary checkout on a clean main, so the probe must refuse it",
    ).toContain("REFUSE:");
    // The reason has to be actionable, not just a refusal.
    expect(here.out).toMatch(/LINKED WORKTREE|not main\.\.\.origin\/main|uncommitted change/);
  });

  test("stage-audit takes a reading for a stage that exists, and refuses one that does not", () => {
    const stageBlock = executableBlocks(read("stage-audit")).find(b => b.includes("project-state.json"));
    expect(stageBlock, "no block in stage-audit.md reads project-state.json").toBeDefined();

    const real = runBlock(stageBlock as string, "B");
    expect(real.code, `the block exited ${real.code}:\n${real.out}`).toBe(0);
    expect(real.out).toContain("stage B");
    expect(real.out, "a stage's items are what the audit re-takes").toContain("verify:");

    // Broken to prove it: deleting the `if(!st)` branch throws a TypeError
    // into the agent's context instead, and both assertions go red.
    const absent = runBlock(stageBlock as string, "ZZ");
    expect(absent.code, "an unknown stage must report, not crash").toBe(0);
    expect(absent.out, "an unknown stage is UNMEASURED and says so").toContain("UNMEASURED");
    expect(absent.out).toContain("A, B, C, D, E, F, G, H");
  });

  test("round-rca compares runs against reviewed commits, on a reading it controls", () => {
    const block = executableBlocks(read("round-rca"))[0] as string;
    expect(block).toBeDefined();

    // No argument. Asserted on the USAGE string, which only the `/^[0-9]+$/`
    // guard emits — not on the bare word UNMEASURED, which both this path
    // and a failing `gh` produce.
    //
    // This is the correction a mutation forced. Replacing that guard with
    // `if(false)` was predicted to redden this case and left it GREEN:
    // without the guard the block ran `gh pr view ""`, gh failed, and the
    // next branch printed its own UNMEASURED. Two mechanisms, one
    // observable, and the assertion was reading the observable — the sixth
    // shape in `.claude/rules/checks-must-be-able-to-fail.md`.
    const none = runBlock(block, "");
    expect(none.code).toBe(0);
    expect(none.out, "a missing argument must be refused by the usage guard, not by gh failing").toContain(
      "Usage: /round-rca <pr-number>",
    );

    // Four runs over four commits: honest count.
    const agree = runBlock(block, "1725", { stubGh: plantGh("agree", runsOf(["a1", "b2", "c3", "d4"])) });
    expect(agree.code, agree.out).toBe(0);
    expect(agree.out).toContain("runs counted:     4");
    expect(agree.out).toContain("distinct commits: 4");
    expect(agree.out).toContain("AGREE");

    // Six runs over four commits — #1725's own shape. Broken to prove it:
    // comparing `list.length` instead of `total_count` makes this print
    // AGREE, and the two assertions below go red.
    const disagree = runBlock(block, "1725", {
      stubGh: plantGh("disagree", runsOf(["a1", "a1", "b2", "b2", "c3", "d4"])),
    });
    expect(disagree.code, disagree.out).toBe(0);
    expect(disagree.out).toContain("DISAGREE by 2");
    expect(disagree.out).toContain("distinct commits: 4");
  });

  test("round-rca refuses a truncated page instead of comparing two populations", () => {
    const block = executableBlocks(read("round-rca"))[0] as string;
    // `total_count` spans the whole result set; the commit count spans only
    // the page fetched. For a pull request with more runs than one page, the
    // comparison would be two different populations and the verdict would be
    // confidently wrong — on exactly the heavily-re-run PR this command is
    // for.
    //
    // Broken to prove it: deleting the length check makes this print
    // "DISAGREE by 98" — a verdict nobody computed — and this goes red.
    const truncated = runBlock(block, "1725", { stubGh: plantGh("trunc", runsOf(["a1", "b2"], 100)) });
    expect(truncated.code, truncated.out).toBe(0);
    expect(truncated.out, "a truncated page must be UNMEASURED, not a verdict").toContain("UNMEASURED");
    expect(truncated.out, "the refusal must name both numbers").toContain("100");
    expect(truncated.out).not.toContain("DISAGREE by");
  });

  test("stage-audit carries no expected reading, so it cannot grade itself", () => {
    const text = read("stage-audit");
    // #1746's acceptance criterion: `/stage-audit B` reproduces the five
    // readings "with no argument naming the expected numbers". A file holding
    // `26/26` would be handing the audit its answer.
    //
    // Broken to prove it: pasting "milestones 26/26" into the body turns this
    // red, naming the match.
    const carried = [...text.matchAll(/\b(\d+)\s*\/\s*(\d+)\b/g)].filter(m => m[1] === m[2]);
    expect(
      carried.map(m => m[0]),
      "stage-audit.md names an expected reading (an n/n figure). The numbers are " +
        "the output of the run; a command told what to expect has measured nothing.",
    ).toEqual([]);
  });

  test("round-rca asks its three questions in the recorded order", () => {
    const text = read("round-rca");
    // The design is in project-state.json and the ORDER is the whole of it:
    // re-scope only if the third is yes. Broken to prove it: swapping the
    // second and third sections turns this red.
    const at = (h: string) => text.indexOf(h);
    const count = at("## 1. Is the round count real?");
    const finding = at("## 2. Is the finding real?");
    const work = at("## 3. Is the work wrong?");
    expect(count, "round-rca is missing the round-count question").toBeGreaterThan(-1);
    expect(finding, "round-rca is missing the finding question").toBeGreaterThan(-1);
    expect(work, "round-rca is missing the is-the-work-wrong question").toBeGreaterThan(-1);
    expect(count).toBeLessThan(finding);
    expect(finding).toBeLessThan(work);
    expect(text, "round-rca must say that #1592 already tracks the counter").toContain("#1592");
  });
});
