/**
 * Covers #1746 — `/stage-audit` and `/round-rca` exist as commands rather than
 * as a description in a conversation.
 *
 * The thing that makes a command a command and not prose is that part of it
 * RUNS. A `.claude/commands/*.md` file may carry `!`…`` blocks, which the
 * runtime executes and injects before the agent reads a word of the body. So
 * the central case here EXECUTES every block in both files and asserts it
 * produced a reading — not that the file mentions one.
 *
 * Every assertion below was confirmed able to fail by breaking the thing it
 * guards; what was broken is written beside each one.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const COMMANDS = join(ROOT, ".claude", "commands");

/**
 * The two commands #1746 is about. A third command added later is not
 * silently governed by this file — it has to be named here, which is the
 * point: the population is declared, not discovered, so nobody can grow the
 * directory and believe these properties came with it.
 */
const GOVERNED = ["stage-audit", "round-rca"] as const;

/** The one binding that decides what an executable block is. */
export function executableBlocks(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter(line => line.startsWith("!`") && line.trimEnd().endsWith("`"))
    .map(line => line.slice(2, line.trimEnd().length - 1));
}

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
 * Runs a block the way the runtime does: through the shell, with $ARGUMENTS
 * substituted, from the repository root.
 */
function runBlock(block: string, args: string): { code: number; out: string } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.GH_TOKEN;
  const p = Bun.spawnSync(["bash", "-c", block.replaceAll("$ARGUMENTS", args)], {
    cwd: ROOT,
    env,
  });
  return {
    code: p.exitCode ?? -1,
    out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr),
  };
}

describe("the commands #1746 creates are executable, not prose", () => {
  for (const name of GOVERNED) {
    test(`${name} declares what it takes and what it is for`, () => {
      const text = read(name);
      expect(text.startsWith("---\n"), `${name}.md must open with frontmatter`).toBe(true);
      const front = text.slice(4, text.indexOf("\n---", 4));
      // Broken to prove it: deleting either line turns this red. Without
      // argument-hint the runtime cannot prompt for the argument, and a
      // command whose argument nobody can guess is prose with a filename.
      expect(front, `${name}.md needs an argument-hint`).toContain("argument-hint:");
      expect(front, `${name}.md needs a description`).toContain("description:");
    });

    test(`${name} carries at least one block the runtime executes`, () => {
      const blocks = executableBlocks(read(name));
      // Broken to prove it: removing the leading `!` from the block makes it
      // an ordinary fenced line the runtime never runs, and this goes red.
      // That is the exact difference between this command and the prose it
      // replaces, so it is asserted rather than described.
      expect(blocks.length, `${name}.md has no \`!\`…\`\` block, so nothing in it runs`).toBeGreaterThan(0);
    });
  }

  test("stage-audit takes a reading for a stage that exists, and refuses one that does not", () => {
    const blocks = executableBlocks(read("stage-audit"));
    const stageBlock = blocks.find(b => b.includes("project-state.json"));
    expect(stageBlock, "no block in stage-audit.md reads project-state.json").toBeDefined();

    // A real stage. The command must report the stage's own items; it is
    // reading the plan, not reciting one.
    const real = runBlock(stageBlock as string, "B");
    expect(real.code, `the block exited ${real.code}:\n${real.out}`).toBe(0);
    expect(real.out).toContain("stage B");
    expect(real.out, "a stage's items are what the audit re-takes").toContain("verify:");

    // A stage that does not exist. Broken to prove it: deleting the `if(!st)`
    // branch makes this throw a TypeError into the agent's context instead,
    // and both assertions below go red.
    const absent = runBlock(stageBlock as string, "ZZ");
    expect(absent.code, "an unknown stage must report, not crash").toBe(0);
    expect(absent.out, "an unknown stage is UNMEASURED and says so").toContain("UNMEASURED");
    // The refusal names what it DOES have, or the reader cannot act on it.
    expect(absent.out).toContain("A, B, C, D, E, F, G, H");
  });

  test("round-rca reads runs against reviewed commits, and never crashes without them", () => {
    const blocks = executableBlocks(read("round-rca"));
    expect(blocks.length).toBeGreaterThan(0);
    const block = blocks[0] as string;

    // No argument. Asserted on the USAGE string, which only the `/^[0-9]+$/`
    // guard can emit — not on the bare word UNMEASURED, which both paths
    // produce.
    //
    // This is the correction the battery forced, and it is worth the
    // paragraph. Replacing that guard with `if(false)` was predicted to
    // redden this case and left it GREEN: without the guard the block runs
    // `gh pr view ""`, gh fails, and the next branch prints "UNMEASURED: gh
    // could not read pull request #". Two mechanisms, one observable, and
    // the assertion was reading the observable — the sixth shape in
    // .claude/rules/checks-must-be-able-to-fail.md. Only the prediction
    // mismatch showed it.
    const none = runBlock(block, "");
    expect(none.code).toBe(0);
    expect(
      none.out,
      "a missing argument must be refused by the usage guard, not by gh failing on an empty number",
    ).toContain("Usage: /round-rca <pr-number>");

    // A real pull request. Where `gh` cannot reach the API — CI without a
    // token, or offline — the block must SAY so rather than exit non-zero or
    // report a zero. An absent credential is UNMEASURED, never a reading.
    const live = runBlock(block, "1725");
    expect(live.code, `the block exited ${live.code}:\n${live.out}`).toBe(0);
    // Whatever else is true, a real number must never reach the usage guard.
    expect(live.out, "a valid pull request number was refused as malformed").not.toContain(
      "Usage: /round-rca <pr-number>",
    );
    const measured = !live.out.includes("UNMEASURED");
    if (measured) {
      // Both halves of the comparison must be present, or the reader cannot
      // tell an inflated count from an honest one — which is the whole
      // question the command exists to answer.
      expect(live.out).toContain("runs counted:");
      expect(live.out).toContain("distinct commits:");
      expect(live.out).toMatch(/AGREE|DISAGREE/);
    } else {
      expect(live.out, "an unreachable API must name itself, not report zero").toContain("UNMEASURED");
    }
  });

  test("stage-audit carries no expected reading, so it cannot grade itself", () => {
    const text = read("stage-audit");
    // #1746's acceptance criterion: `/stage-audit B` reproduces the five
    // readings "with no argument naming the expected numbers". A file holding
    // `26/26` would be handing the audit its answer — the vacuous-assertion
    // shape in .claude/rules/checks-must-be-able-to-fail.md, one layer up.
    //
    // Broken to prove it: pasting the recorded Stage B line
    // "milestones 26/26, criterion-coverage 26/26" into the body turns this
    // red, naming the match.
    const carried = [...text.matchAll(/\b(\d+)\s*\/\s*(\d+)\b/g)].filter(m => m[1] === m[2]);
    expect(
      carried.map(m => m[0]),
      "stage-audit.md names an expected reading (an n/n figure). The numbers are " +
        "the output of the run; a command told what to expect has measured nothing.",
    ).toEqual([]);
  });

  test("stage-audit refuses a tree that is not the primary checkout on main", () => {
    const text = read("stage-audit");
    // The 2026-11-03 instance: the first attempt at this audit was taken off
    // `rg/release-089` and had to be retaken. These are the two readings that
    // tell a primary checkout on main from anything else, and a command that
    // omits either will take a confident reading of the wrong tree.
    //
    // Broken to prove it: deleting the `--git-common-dir` probe from the
    // block makes the worktree case indistinguishable from the main one.
    const blocks = executableBlocks(text).join("\n");
    expect(blocks, "no block reads --git-common-dir, so a linked worktree reads as the primary checkout").toContain(
      "--git-common-dir",
    );
    expect(blocks, "no block reads the branch line").toContain("--porcelain --branch");
    expect(text, "the body must say what to do when the probe disagrees").toContain("UNMEASURED");
  });

  test("round-rca asks its three questions in the recorded order", () => {
    const text = read("round-rca");
    // The design is in project-state.json and the ORDER is the whole of it:
    // re-scope only if the third is yes. A file carrying the three questions
    // in any other order is a different procedure wearing the same name.
    //
    // Broken to prove it: swapping the "Is the finding real?" and "Is the
    // work wrong?" sections turns this red.
    const at = (h: string) => text.indexOf(h);
    const count = at("## 1. Is the round count real?");
    const finding = at("## 2. Is the finding real?");
    const work = at("## 3. Is the work wrong?");
    expect(count, "round-rca is missing the round-count question").toBeGreaterThan(-1);
    expect(finding, "round-rca is missing the finding question").toBeGreaterThan(-1);
    expect(work, "round-rca is missing the is-the-work-wrong question").toBeGreaterThan(-1);
    expect(count).toBeLessThan(finding);
    expect(finding).toBeLessThan(work);
    // The one thing a reader of this command must not do.
    expect(text, "round-rca must say that #1592 already tracks the counter").toContain("#1592");
  });
});
