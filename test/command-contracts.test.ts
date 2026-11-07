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
function runBlock(
  block: string,
  args: string,
  opts: { stubGh?: string; cwd?: string } = {},
): { code: number; out: string } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.GH_TOKEN;
  if (opts.stubGh !== undefined) env.PATH = `${opts.stubGh}:${env.PATH ?? ""}`;
  const p = Bun.spawnSync(["bash", "-c", block.replaceAll("$ARGUMENTS", args)], { cwd: opts.cwd ?? ROOT, env });
  return {
    code: p.exitCode ?? -1,
    out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr),
  };
}

/** A `gh` that answers from fixtures, so the comparison logic always runs. */
function plantGh(
  label: string,
  runs: { total_count: number; workflow_runs: { head_sha: string }[] },
  opts: { failPrView?: boolean } = {},
): string {
  const dir = join(scratch, label);
  const meta = { number: 1725, headRefName: "rg/planted", createdAt: "2026-11-01T00:00:00Z", state: "OPEN", url: "u" };
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(join(scratch, `${label}.runs.json`), JSON.stringify(runs));
  writeFileSync(join(scratch, `${label}.meta.json`), JSON.stringify(meta));
  require("fs").mkdirSync(dir, { recursive: true });
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    `#!/bin/sh\ncase "$1" in\n` +
      `  pr) ${opts.failPrView === true ? "exit 1" : `cat ${JSON.stringify(join(scratch, `${label}.meta.json`))}`} ;;\n` +
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

  /**
   * The one binding that decides whether a command file is safe to run. The
   * population is every command on disk, not the two this issue names —
   * `ship-issue.md` had the same defect and nobody reported it, and a sweep
   * drawn around the members somebody named is still a patch.
   */
  function blocksTakingArguments(dir: string): string[] {
    const hits: string[] = [];
    for (const f of readdirSync(dir).filter(x => x.endsWith(".md"))) {
      for (const block of executableBlocks(readFileSync(join(dir, f), "utf-8"))) {
        if (block.includes("$ARGUMENTS")) hits.push(`${f}: ${block.slice(0, 60)}…`);
      }
    }
    return hits;
  }

  test("no executable block takes an argument, and the check that says so can fail", () => {
    expect(
      readdirSync(COMMANDS).filter(f => f.endsWith(".md")).length,
      "no command files found, so this case measured nothing",
    ).toBeGreaterThan(0);

    // Why the rule is absolute rather than "quote it": the runtime
    // substitutes $ARGUMENTS TEXTUALLY before the shell parses the line, so
    // nothing written inside the line can contain it. Both weaker rules were
    // tried on this branch and both were broken by measurement —
    //   bare:    `1725; rm -f <f>`          deleted the file
    //   quoted:  `1882" ; rm -f <f> ; #`    deleted the file, closing RG_PR="…" early
    // In the second the interpreter was never reached, so no guard inside the
    // script could have run. The only safe amount of argument in a block is
    // none.
    expect(
      blocksTakingArguments(COMMANDS),
      "an executable block interpolates $ARGUMENTS. The runtime substitutes it textually " +
        "before the shell parses the line, so an argument containing a quote escapes any " +
        "quoting and runs as commands. Make the block take a reading that needs no argument " +
        "and leave the argument in the prose, where it is never a command.",
    ).toEqual([]);

    // The control. Without it this case is an empty-collection comparison —
    // it would read identically if `blocksTakingArguments` returned [] for a
    // directory full of violations. Planted violation in, violation out.
    const planted = join(scratch, "planted-commands");
    require("fs").mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, "bad.md"), "---\nargument-hint: <n>\n---\n\n!`echo $ARGUMENTS`\n");
    expect(
      blocksTakingArguments(planted),
      "the check returned nothing for a directory whose only command interpolates $ARGUMENTS, " +
        "so its empty answer above proves nothing",
    ).toHaveLength(1);
  });

  test("stage-audit decides whether this tree can be measured, and refuses this one", () => {
    const blocks = executableBlocks(read("stage-audit"));
    const probe = blocks.find(b => b.includes("--git-common-dir"));
    expect(probe, "no block in stage-audit.md resolves --git-common-dir").toBeDefined();

    // Executed, not matched. Run here first, for the one property that holds
    // whatever tree this suite happens to be in: the probe emits a VERDICT,
    // never raw git output for a reader to compare.
    //
    // Broken to prove it: a probe that still RUNS both git commands but
    // never compares them — the mutant the substring version of this case
    // could not see — prints neither verdict and turns this red.
    const here = runBlock(probe as string, "B");
    expect(here.code, `the probe exited ${here.code}:\n${here.out}`).toBe(0);
    expect(here.out, "the probe must emit a verdict, not raw git output for a reader to compare").toMatch(
      /^(REFUSE:|PRIMARY CHECKOUT ON MAIN)/m,
    );

    // The refusal itself is measured against a tree THIS CASE BUILT, not
    // against whichever tree the suite is running in. An earlier revision
    // asserted `REFUSE:` on the ambient checkout, which is green only
    // because nobody has yet run the suite from the primary checkout on a
    // clean main — the one place it is legitimate to run the audit. There
    // the probe correctly prints "Proceed." and the case would have failed
    // for being right.
    // Every git call spells `"-C", <dir>` in its own argv literal. Composing
    // it from a shared prefix is the same behaviour and a different source
    // text, and `test/unit/git-identity-isolation.test.ts` reads the source
    // text — an earlier revision of this case built the argv in a loop and
    // reddened that suite in CI while passing here.
    const planted = join(scratch, "planted-tree");
    require("fs").mkdirSync(planted, { recursive: true });
    for (const argv of [
      ["git", "-C", planted, "init", "-q", "-b", "not-main"],
      ["git", "-C", planted, "config", "user.email", "t@example.invalid"],
      ["git", "-C", planted, "config", "user.name", "t"],
      ["git", "-C", planted, "commit", "-q", "--allow-empty", "-m", "seed"],
    ]) {
      const p = Bun.spawnSync(argv);
      expect(p.exitCode, `git ${argv[3]} failed building the planted tree`).toBe(0);
    }

    // A repository on a branch that is not `main...origin/main`, with no
    // linked worktree and nothing uncommitted — so exactly ONE of the
    // probe's three reasons can fire, and the case names which.
    const refused = runBlock(probe as string, "B", { cwd: planted });
    expect(refused.code, refused.out).toBe(0);
    expect(refused.out, `the planted tree is not the primary checkout on main:\n${refused.out}`).toContain("REFUSE:");
    expect(refused.out, "the reason must name the branch, which is the only thing wrong with this tree").toContain(
      "not main...origin/main",
    );
    expect(refused.out, "no worktree was linked and nothing was left uncommitted").not.toContain("LINKED WORKTREE");
  });

  test("stage-audit refuses a main that has diverged from origin/main", () => {
    // `git status --porcelain --branch` prints `## main...origin/main [ahead 1]`
    // when local main holds commits origin does not. An unanchored prefix
    // match reads that as the clean case, so the audit would re-take every
    // stage reading against a tree origin has never seen and report it as
    // the state of main. Round 4 of this PR's review found it.
    //
    // Broken to prove it: restoring the unanchored `/^main\.\.\.origin\/main/`
    // test makes this print "Proceed." and turns this red.
    const probe = executableBlocks(read("stage-audit")).find(b => b.includes("--git-common-dir")) as string;

    const bare = join(scratch, "ahead-origin.git");
    const ahead = join(scratch, "ahead-clone");
    require("fs").mkdirSync(bare, { recursive: true });
    for (const argv of [
      ["git", "-C", bare, "init", "-q", "--bare", "-b", "main"],
      ["git", "clone", "-q", bare, ahead],
      ["git", "-C", ahead, "config", "user.email", "t@example.invalid"],
      ["git", "-C", ahead, "config", "user.name", "t"],
      ["git", "-C", ahead, "checkout", "-q", "-B", "main"],
      ["git", "-C", ahead, "commit", "-q", "--allow-empty", "-m", "first"],
      ["git", "-C", ahead, "push", "-q", "-u", "origin", "main"],
      ["git", "-C", ahead, "commit", "-q", "--allow-empty", "-m", "unpushed"],
    ]) {
      const p = Bun.spawnSync(argv);
      expect(p.exitCode, `${argv.join(" ")} failed:\n${new TextDecoder().decode(p.stderr)}`).toBe(0);
    }

    // The control on the fixture itself: if git did not actually report a
    // divergence, this case would be asserting against the ordinary clean
    // line and would pass for the wrong reason.
    const status = Bun.spawnSync(["git", "-C", ahead, "status", "--porcelain", "--branch"]);
    const branchLine = new TextDecoder().decode(status.stdout).split("\n")[0] ?? "";
    expect(branchLine, `the fixture did not produce a diverged branch line: ${branchLine}`).toContain("[ahead 1]");

    const out = runBlock(probe, "", { cwd: ahead });
    expect(out.code, out.out).toBe(0);
    expect(out.out, `a main ahead of origin/main must be refused:\n${out.out}`).toContain("REFUSE:");
    expect(out.out, "the reason must name the divergence, not just say the branch is wrong").toContain("ahead 1");
    expect(out.out).not.toContain("PRIMARY CHECKOUT ON MAIN");
  });

  test("stage-audit says UNMEASURED when the plan is absent, and says so differently when it is corrupt", () => {
    // An absent plan and a corrupt plan are different facts and only one of
    // them is somebody's mistake. Before this, both threw a JSON or ENOENT
    // stack trace into the agent's context, which reads as a crash rather
    // than as a reading that could not be taken.
    //
    // Broken to prove it: deleting either guard makes the block throw, the
    // exit code goes non-zero, and the matching case here turns red.
    const stageBlock = executableBlocks(read("stage-audit")).find(b => b.includes("project-state.json")) as string;

    const empty = join(scratch, "no-plan");
    require("fs").mkdirSync(empty, { recursive: true });
    const absent = runBlock(stageBlock, "", { cwd: empty });
    expect(absent.code, `an absent plan must report, not crash:\n${absent.out}`).toBe(0);
    expect(absent.out).toContain("UNMEASURED");
    expect(absent.out, "the refusal must say the file is not there, so the reader knows to move").toContain(
      "not present",
    );

    const bad = join(scratch, "corrupt-plan");
    require("fs").mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "project-state.json"), '{"stages": [');
    const corrupt = runBlock(stageBlock, "", { cwd: bad });
    expect(corrupt.code, `a corrupt plan must report, not crash:\n${corrupt.out}`).toBe(0);
    expect(corrupt.out).toContain("UNMEASURED");
    // The control: a corrupt plan must not be reported as an absent one.
    expect(
      corrupt.out,
      `a present-but-unparseable plan was reported as absent, so the two states are indistinguishable:\n${corrupt.out}`,
    ).not.toContain("not present");
    expect(corrupt.out).toContain("could not be parsed");
  });

  test("stage-audit indexes every stage and says how many DONE items can be audited", () => {
    const stageBlock = executableBlocks(read("stage-audit")).find(b => b.includes("project-state.json"));
    expect(stageBlock, "no block in stage-audit.md reads project-state.json").toBeDefined();

    const out = runBlock(stageBlock as string, "").out;
    // Every stage, not the one the operator asked for — the block takes no
    // argument, so it cannot be asked. The agent picks from this index.
    const state = JSON.parse(readFileSync(join(ROOT, "project-state.json"), "utf-8")) as {
      stages: { id: string; items?: { done?: boolean; verify?: string | null }[] }[];
    };
    expect(state.stages.length, "project-state.json declares no stages, so this measured nothing").toBeGreaterThan(0);
    for (const st of state.stages) {
      expect(out, `stage ${st.id} is missing from the index`).toContain(st.id);
    }

    // The count it prints is the audit's own precondition: a DONE item with
    // no verify cannot be re-taken, so done-count and verify-count must be
    // separate numbers.
    //
    // Measured against a PLANTED state, not the live one. Every stage in the
    // live file has a verify on every DONE item, so there the two counts are
    // equal for every row — a mutation collapsing one into the other moves
    // nothing, and asserting against live data would be green by
    // construction. That mutation was run and did stay green; this fixture
    // is the repair.
    const planted = join(scratch, "planted-state");
    require("fs").mkdirSync(planted, { recursive: true });
    writeFileSync(
      join(planted, "project-state.json"),
      JSON.stringify({
        stages: [
          {
            id: "Q",
            name: "planted",
            items: [
              { id: "Q1", done: true, verify: "true" },
              { id: "Q2", done: true, verify: null }, // DONE and unverifiable
              { id: "Q3", done: false, verify: null },
            ],
          },
        ],
      }),
    );
    const p = runBlock(stageBlock as string, "", { cwd: planted });
    const row = p.out.split("\n").find(l => l.trimStart().startsWith("Q "));
    expect(row, `no row for the planted stage:\n${p.out}`).toBeDefined();
    // Two of three done, but only ONE of them auditable. A block that
    // reports "2" for both has lost the distinction the audit depends on.
    expect(row, "the done count must be 2 of 3").toContain("2/3");
    expect(
      (row ?? "").replace("2/3", "").includes("1"),
      `the verify count must be 1, not 2 — a DONE item with a null verify cannot be re-taken. Row: ${row}`,
    ).toBe(true);
  });

  test("round-rca compares runs against reviewed commits, on a reading it controls", () => {
    const block = executableBlocks(read("round-rca"))[0] as string;
    expect(block).toBeDefined();

    // No pull request for this branch. The block resolves one from the
    // branch rather than from an argument, so this is the refusal path, and
    // it must name the branch as the cause — "gh failed" is not something a
    // reader can act on.
    //
    // Broken to prove it: deleting the `if(meta===null)` branch makes
    // `JSON.parse(null)` throw a stack trace into the agent's context and
    // the exit-code assertion goes red.
    const noPr = runBlock(block, "", { stubGh: plantGh("nopr", runsOf([]), { failPrView: true }) });
    expect(noPr.code, `a branch with no pull request must report, not crash:\n${noPr.out}`).toBe(0);
    expect(noPr.out).toContain("UNMEASURED");
    expect(noPr.out, "the refusal must say the branch is why, so the reader knows to move").toContain("branch");

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

  test("round-rca reports UNMEASURED when gh exits 0 without printing JSON", () => {
    // `gh` exiting 0 is not `gh` printing JSON. A one-time CLI notice, an
    // auth banner or a schema change all arrive on stdout with a zero exit,
    // and an unguarded JSON.parse turns each into a stack trace in the
    // agent's context — which reads as a crash, not as a reading that could
    // not be taken.
    //
    // Round 7 of this PR's review found it, and found it as a CLASS: the
    // sibling block in stage-audit.md had been given exactly this guard two
    // rounds earlier and the fix was not carried across. So this case
    // covers BOTH parse sites, not the one that was reported.
    //
    // Broken to prove it: removing either try/catch makes its own arm exit
    // non-zero and turns this red.
    const block = executableBlocks(read("round-rca"))[0] as string;

    const plantJunk = (label: string, prOut: string, apiOut: string): string => {
      const dir = join(scratch, label);
      require("fs").mkdirSync(dir, { recursive: true });
      const gh = join(dir, "gh");
      writeFileSync(
        gh,
        `#!/bin/sh\ncase "$1" in\n  pr) printf '%s' ${JSON.stringify(prOut)} ;;\n` +
          `  api) printf '%s' ${JSON.stringify(apiOut)} ;;\n  *) exit 1 ;;\nesac\n`,
      );
      chmodSync(gh, 0o755);
      return dir;
    };

    const goodMeta = JSON.stringify({
      number: 1725,
      headRefName: "rg/planted",
      createdAt: "2026-11-01T00:00:00Z",
      state: "OPEN",
      url: "u",
    });
    const notice = "! A new release of gh is available\n";

    // Arm one: the pull-request read is not JSON.
    const badMeta = runBlock(block, "1725", { stubGh: plantJunk("junk-meta", notice, "{}") });
    expect(badMeta.code, `a non-JSON pr read must report, not crash:\n${badMeta.out}`).toBe(0);
    expect(badMeta.out).toContain("UNMEASURED");
    expect(badMeta.out, "the refusal must say gh printed something that was not JSON").toContain("did not print JSON");

    // Arm two: the pull request reads fine and the RUNS read is not JSON.
    // Without this arm the case would pass with the second guard deleted,
    // because the first one short-circuits before the second is reached.
    const badRuns = runBlock(block, "1725", { stubGh: plantJunk("junk-runs", goodMeta, notice) });
    expect(badRuns.code, `a non-JSON runs read must report, not crash:\n${badRuns.out}`).toBe(0);
    expect(badRuns.out).toContain("UNMEASURED");
    expect(badRuns.out, "the second refusal must name the runs read, not the pull request").toContain("workflow runs");
  });

  test("round-rca answers about the branch's pull request, and says so when that is not the one asked for", () => {
    // The argument never reaches the block — it is prose in the prompt — so
    // standing on a branch whose pull request is NOT the one named gives a
    // correct answer to a question nobody asked. The prose used to claim the
    // block would say UNMEASURED here; it does not, and cannot. The only
    // thing that catches the mismatch is the reader, so the block has to
    // hand them the number and tell them it came from the branch.
    //
    // Round 5 of this PR's review found the false claim. Broken to prove it:
    // deleting the provenance line turns this red.
    const block = executableBlocks(read("round-rca"))[0] as string;

    // The planted `gh` answers for pull request 1725. The operator asked
    // about 9999 — a different one, on a branch they are not standing on.
    const out = runBlock(block, "9999", { stubGh: plantGh("mismatch", runsOf(["a1", "b2"])) });
    expect(out.code, out.out).toBe(0);
    expect(out.out, "the block must report the branch's pull request, which is 1725").toContain("pull request #1725");
    expect(out.out, "it must never silently adopt the number from the prose").not.toContain("#9999");
    expect(
      out.out,
      "the reader is the only thing that can catch the mismatch, so the block must say where the number came from",
    ).toContain("resolved from the branch you are standing on");
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
