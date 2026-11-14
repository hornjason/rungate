/**
 * Covers SC-2738, SC-2744 (SPEC-TO-BOARD-PIPELINE-SPEC.md): merging an ADR whose
 * status changes to accepted places its plan on the board with no command
 * typed by hand, and `rungate scaffold` writes the workflow that does it
 * (#2046, ADR-014 row 3), so a consumer gets it and this repository's copy is
 * the generated one.
 *
 * ADR-013 row 5. Until this shipped, step 4 of the four-step process was a
 * person remembering five commands in order — `plan-spec`, `plan-issues
 * --decompose`, `plan-deps`, `board-mirror`, `board-ready --top-up` — and the
 * first ADR-013 dry run found the order links had never been written.
 *
 * Three layers, each executed rather than described:
 *
 *   1. `newlyAccepted` — the one decider for "did this push accept it".
 *   2. `plan-issues --accepted-since <sha>` against a real git history, so the
 *      read of the ADR at the earlier commit is inside what is measured.
 *   3. The GENERATED workflow, parsed: the trigger, the order of the five
 *      steps, and which credential each step holds — and the committed copy
 *      compared with what the generator writes.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { adrStatus, closedIssueCounts, newlyAccepted } from "../lib/issue-decomposition";
import { REFUSAL_EXIT, main as planIssuesMain } from "../scripts/plan-issues";
import { CLI_COMMANDS } from "../lib/cli-commands";
import { actionRef } from "../lib/workflow-actions";
import {
  ADR_ACCEPTED_COMMANDS,
  ADR_ACCEPTED_JOB,
  ADR_ACCEPTED_WORKFLOW_FILE,
  boardInput,
} from "../lib/scaffold/adr-accepted-workflow";
import { createCiWorkflows } from "../lib/scaffold/steps";
import { workflowCensus } from "../lib/scaffold/workflow-census";

const ROOT = join(import.meta.dir, "..");

const adr = (status: string, table = true) =>
  [
    "---",
    "doc-type: adr",
    `status: ${status}`,
    "---",
    "",
    "# ADR-099 — a decision",
    "",
    ...(table
      ? [
          "| Criterion | Outcome | Files | Milestone | Blocked by |",
          "|---|---|---|---|---|",
          "| CRC-C2 | a row this ADR plans | lib/a.ts | — | — |",
        ]
      : ["No decomposition: this ADR decides and files nothing."]),
    "",
  ].join("\n");

describe("SC-2738: newlyAccepted reads the frontmatter status at both ends", () => {
  test("SC-2738: proposed → accepted is a new acceptance", () => {
    expect(newlyAccepted(adr("proposed"), adr("accepted"))).toBe(true);
  });

  test("SC-2738: a file that did not exist before and lands accepted is a new acceptance", () => {
    expect(newlyAccepted(null, adr("accepted"))).toBe(true);
  });

  test("SC-2738: accepted → accepted is NOT — an edit to an accepted ADR re-files nothing", () => {
    expect(newlyAccepted(adr("accepted"), adr("accepted"))).toBe(false);
  });

  test("SC-2738: accepted → superseded, and proposed → proposed, are not acceptances", () => {
    expect(newlyAccepted(adr("accepted"), adr("superseded"))).toBe(false);
    expect(newlyAccepted(adr("proposed"), adr("proposed"))).toBe(false);
  });

  test("SC-2738: quotes and case are spelling — `\"accepted\"` and `Accepted` are accepted", () => {
    // Security review of #2009: an exact-match read skipped these silently,
    // with a green run and nothing placed.
    expect(newlyAccepted(adr("proposed"), adr('"accepted"'))).toBe(true);
    expect(newlyAccepted(adr("proposed"), adr("Accepted"))).toBe(true);
    expect(newlyAccepted(adr("'accepted'"), adr("accepted"))).toBe(false);
  });

  test("SC-2738: only the FRONTMATTER decides — a body line reading `status: accepted` does not", () => {
    const body = adr("proposed").replace("# ADR-099 — a decision", "# ADR-099\n\nstatus: accepted");
    expect(adrStatus(body)).toBe("proposed");
    expect(newlyAccepted(adr("proposed"), body)).toBe(false);
    // And a file with no frontmatter has no status at all.
    expect(adrStatus("status: accepted\n")).toBeNull();
    // Frontmatter with no status, and the body says accepted: still none.
    expect(adrStatus("---\ndoc-type: adr\n---\n\nstatus: accepted\n")).toBeNull();
  });
});

describe("SC-2738: plan-issues --accepted-since lists what a push accepted", () => {
  function repo() {
    const dir = mkdtempSync(join(tmpdir(), "rg-adr-accepted-"));
    const git = (...args: string[]) => {
      const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
      if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
      return r.stdout.trim();
    };
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    mkdirSync(join(dir, "docs", "adr"), { recursive: true });
    return { dir, git };
  }

  async function since(dir: string, sha: string) {
    const said: string[] = [];
    const errs: string[] = [];
    const real = { log: console.log, error: console.error };
    console.log = (...a: unknown[]) => void said.push(a.join(" "));
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    try {
      const code = await planIssuesMain(["--accepted-since", sha, "--project-root", dir]);
      return { code, out: said.join("\n"), err: errs.join("\n") };
    } finally {
      console.log = real.log;
      console.error = real.error;
    }
  }

  test("SC-2738: exactly the ADR this push accepted is listed — not the one already accepted", async () => {
    const { dir, git } = repo();
    try {
      writeFileSync(join(dir, "docs/adr/ADR-098-old.md"), adr("accepted"));
      writeFileSync(join(dir, "docs/adr/ADR-099-new.md"), adr("proposed"));
      writeFileSync(join(dir, "docs/adr/ADR-100-decides.md"), adr("proposed", false));
      git("add", "-A");
      git("commit", "-q", "-m", "before");
      const before = git("rev-parse", "HEAD");
      writeFileSync(join(dir, "docs/adr/ADR-099-new.md"), adr("accepted"));
      writeFileSync(join(dir, "docs/adr/ADR-100-decides.md"), adr("accepted", false));
      writeFileSync(join(dir, "docs/adr/ADR-101-born.md"), adr("accepted"));
      git("add", "-A");
      git("commit", "-q", "-m", "accept");

      const r = await since(dir, before);
      expect(r.code).toBe(0);
      // ADR-098 was accepted already; ADR-100 was accepted but plans nothing.
      expect(r.out.split("\n").filter(Boolean)).toEqual([
        "docs/adr/ADR-099-new.md",
        "docs/adr/ADR-101-born.md",
      ]);
      expect(r.err).toContain("ADR-100-decides.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SC-2738 CONTROL: a commit the clone does not hold REFUSES — it is not 'nothing was accepted'", async () => {
    // A shallow checkout cannot read the earlier commit. Reading every ADR
    // as absent there would list every accepted ADR in the repository and
    // re-run all of their plans.
    const { dir, git } = repo();
    try {
      writeFileSync(join(dir, "docs/adr/ADR-099-new.md"), adr("accepted"));
      git("add", "-A");
      git("commit", "-q", "-m", "only");
      const r = await since(dir, "0123456789abcdef0123456789abcdef01234567");
      expect(r.code).toBe(REFUSAL_EXIT);
      expect(r.out).toBe("");
      expect(r.err).toMatch(/UNMEASURED/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Scaffold a throwaway consumer with `board` in its config; hand back the generated adr-accepted.yml. */
function generated(board: Record<string, unknown> = { engineSpec: "specs/ENGINE.md", milestonePrefix: "Engine" }): string {
  const root = mkdtempSync(join(tmpdir(), "rg-adr-accepted-"));
  try {
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "rungate", "config.json"),
      JSON.stringify({ project: "fixture", repo: "fixture/fixture", ci: { bunVersion: "1.3.14" }, test: { command: "bun test" }, board }),
    );
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0" }));
    createCiWorkflows(root, [], { force: true });
    const path = join(root, ".github", "workflows", ADR_ACCEPTED_WORKFLOW_FILE);
    return existsSync(path) ? readFileSync(path, "utf-8") : "";
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("SC-2744: scaffold emits adr-accepted.yml as an owned workflow", () => {
  const yml = generated();

  test("a consumer's scaffold writes it, stamped as the harness's", () => {
    expect(yml, `scaffold wrote no ${ADR_ACCEPTED_WORKFLOW_FILE}`).not.toBe("");
    expect(yml).toContain("generated-sha:");
    expect(Object.keys((Bun.YAML.parse(yml) as any).jobs)).toEqual([ADR_ACCEPTED_JOB]);
  });

  test("it calls the published CLI, never a script path or a lib/ import a consumer does not have", () => {
    expect(yml, "a consumer has node_modules/rungate, not scripts/").not.toContain("bun scripts/");
    expect(yml, "a consumer has no ./lib to import at run time").not.toContain("./lib/");
    for (const cmd of ADR_ACCEPTED_COMMANDS) {
      expect(yml).toMatch(new RegExp(`bunx rungate@\\S+ ${cmd} `));
      expect(cmd in CLI_COMMANDS, `the workflow calls ${cmd}, which the CLI does not register`).toBe(true);
    }
  });

  test("every action is the reference lib/workflow-actions.ts declares for it", () => {
    const steps = (Bun.YAML.parse(yml) as any).jobs[ADR_ACCEPTED_JOB].steps as any[];
    const uses = steps.map(s => s.uses).filter(Boolean) as string[];
    expect(uses.map(u => u.split("@")[0])).toEqual(["actions/checkout", "oven-sh/setup-bun"]);
    // The YAML parser drops the trailing `# vN` comment actionRef appends.
    expect(uses.filter(u => u !== actionRef(u.split("@")[0]!).split(" #")[0])).toEqual([]);
  });

  test("this repository's copy is the generated one, untouched", () => {
    const row = workflowCensus(ROOT).files.find(f => f.name === ADR_ACCEPTED_WORKFLOW_FILE);
    expect(row?.status, row?.detail).toBe("generated-and-unchanged");
  });
});

describe("SC-2738: the generated workflow runs the five steps in order", () => {
  const doc = Bun.YAML.parse(generated()) as any;
  const job = doc.jobs[ADR_ACCEPTED_JOB];
  const steps: any[] = job.steps;
  const runOf = (s: any) => String(s.run ?? "");

  test("SC-2738: it fires on a push to main that touches docs/adr, and on nothing else", () => {
    expect(Object.keys(doc.on)).toEqual(["push"]);
    expect(doc.on.push.branches).toEqual(["main"]);
    expect(doc.on.push.paths).toEqual(["docs/adr/**"]);
  });

  test("SC-2738: the earlier commit is fetched, or the acceptance read refuses on every run", () => {
    const checkout = steps.find(s => String(s.uses ?? "").startsWith("actions/checkout@"));
    expect(checkout.with["fetch-depth"]).toBe(0);
  });

  test("SC-2738: the five board commands run in plan order, each after the acceptance read", () => {
    const order = [
      "plan-issues --accepted-since",
      "plan-spec ",
      "plan-issues --decompose",
      "plan-deps ",
      "board-mirror ",
      "board-ready ",
    ];
    const at = order.map(cmd => steps.findIndex(s => runOf(s).includes(cmd)));
    expect(at.every(i => i >= 0), `every command is present: ${JSON.stringify(at)}`).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // Every step after the read is gated on it, so an edit to an accepted ADR
    // runs nothing.
    for (const i of at.slice(1)) expect(steps[i].if).toBe("steps.accepted.outputs.any == 'true'");
    expect(runOf(steps[at[5]])).toContain("--top-up");
    expect(runOf(steps[at[5]])).toContain("--write");
  });

  test("SC-2738: the engine spec and family come from config, into the job's env", () => {
    expect(job.env).toEqual({ SPEC: "specs/ENGINE.md", PREFIX: "Engine" });
    const planSpec = steps.find(s => runOf(s).includes("plan-spec "));
    expect(runOf(planSpec)).toContain('"$SPEC"');
    expect(runOf(planSpec)).toContain('--prefix "$PREFIX"');
  });

  test("SC-2738: the board token reaches only the two board steps, through env", () => {
    // `RUNGATE_PROJECT_TOKEN` is never widened (ADR-013 row 5's note): the
    // issue, milestone and edge writes use the job's own GITHUB_TOKEN.
    const holders = steps
      .filter(s => JSON.stringify(s.env ?? {}).includes("secrets.RUNGATE_PROJECT_TOKEN"))
      .map(runOf);
    expect(holders).toHaveLength(2);
    expect(holders[0]).toContain("board-mirror ");
    expect(holders[1]).toContain("board-ready ");
    for (const s of steps) expect(runOf(s), "no secret is interpolated into a script line").not.toMatch(/\$\{\{\s*secrets\./);
    // plan-issues drops GH_TOKEN, so the issue writes get it as GITHUB_TOKEN.
    const decompose = steps.find(s => runOf(s).includes("plan-issues --decompose"));
    expect(decompose.env.GITHUB_TOKEN).toBe("${{ secrets.GITHUB_TOKEN }}");
    expect(doc.permissions).toEqual({ contents: "read", issues: "write" });
  });

  test("SC-2738: the package is fetched by a step that holds no token, before any step that holds the PAT", () => {
    const firstBunx = steps.findIndex(s => runOf(s).includes("bunx rungate@"));
    expect(steps[firstBunx].id).toBe("accepted");
    expect(JSON.stringify(steps[firstBunx].env ?? {})).not.toContain("secrets.");
  });
});

describe("SC-2738: a closed issue stands for a row only when it is finished work by a trusted author", () => {
  // Security review of #2009: anyone can open an issue on a public repository
  // titled with a row's outcome and close it themselves.
  test("SC-2738: completed, by an owner, member or collaborator → counts", () => {
    for (const a of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      expect(closedIssueCounts({ state_reason: "completed", author_association: a })).toBe(true);
    }
  });

  test("SC-2738: completed by a stranger does NOT count — the row is filed", () => {
    for (const a of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER"]) {
      expect(closedIssueCounts({ state_reason: "completed", author_association: a })).toBe(false);
    }
  });

  test("SC-2738: closed as not planned or duplicate does NOT count, even by the owner", () => {
    for (const r of ["not_planned", "duplicate", null]) {
      expect(closedIssueCounts({ state_reason: r, author_association: "OWNER" })).toBe(false);
    }
  });
});

describe("SC-2738: an engine input that would read as something else is never written", () => {
  // The hand-written file read these at run time and guarded GITHUB_OUTPUT
  // against a newline (security review of #2009). The generator reads them at
  // scaffold time, so the guard moved with the read: an unwritable value is
  // not written, and the acceptance step refuses naming it.
  const acceptance = (board: Record<string, unknown>) => {
    const doc = Bun.YAML.parse(generated(board)) as any;
    const job = doc.jobs[ADR_ACCEPTED_JOB];
    return { env: job.env, run: String(job.steps.find((s: any) => s.id === "accepted").run) };
  };

  /** Run the acceptance step's script under bash -e, with a stub `bunx` that lists one accepted ADR. */
  const execute = (run: string, env: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "rg-adr-accepted-step-"));
    try {
      writeFileSync(join(dir, "bunx"), "#!/bin/sh\necho docs/adr/ADR-099.md\n", { mode: 0o755 });
      const out = join(dir, "output");
      writeFileSync(out, "");
      const r = spawnSync("bash", ["-e", "-c", run], {
        cwd: dir,
        env: { PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: out, BEFORE: "abc", ...env },
        encoding: "utf-8",
      });
      return { status: r.status, stdout: r.stdout, output: readFileSync(out, "utf-8") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("SC-2738: a newline or an Actions expression is refused by name, and the step refuses UNMEASURED", () => {
    expect(boardInput("engineSpec", "specs/A.md\nany=false")).toEqual({ value: null, why: "board.engineSpec contains a newline" });
    expect(boardInput("milestonePrefix", "${{ secrets.X }}").value).toBeNull();
    const { env, run } = acceptance({ engineSpec: "specs/A.md\nany=false", milestonePrefix: "Engine" });
    expect(env.SPEC, "the forged value reached the job's env").toBe("");
    const r = execute(run, { SPEC: env.SPEC, PREFIX: env.PREFIX });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("UNMEASURED — board.engineSpec contains a newline");
    expect(r.output, "the refusal wrote a GITHUB_OUTPUT key").not.toContain("any=");
  });

  test("SC-2738: an unset family refuses UNMEASURED naming the key", () => {
    const { run, env } = acceptance({ engineSpec: "specs/A.md" });
    const r = execute(run, { SPEC: env.SPEC, PREFIX: env.PREFIX });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("UNMEASURED — board.milestonePrefix is not set");
  });

  test("SC-2738 CONTROL: plain values pass, and the step says what it accepted", () => {
    const { run, env } = acceptance({ engineSpec: "specs/A.md", milestonePrefix: "Engine" });
    expect(run, "a configured project carries no refusal").not.toContain("UNMEASURED");
    const r = execute(run, { SPEC: env.SPEC, PREFIX: env.PREFIX });
    expect(r.status).toBe(0);
    expect(r.output).toBe("any=true\n");
  });
});
