/**
 * Something runs `board-conformance` (#1892).
 *
 * Covers SC-2620 (SPEC-TO-BOARD-PIPELINE-SPEC.md).
 *
 * `rungate board-conformance` has taken its own reading and exited non-zero
 * while any reading is short since #1718. Nothing ran it, so a board that
 * drifted stayed drifted until a person typed the command. `.github/workflows/
 * board-conformance.yml` is the thing that runs it, and this file is the
 * reason to believe the workflow does what its comments say.
 *
 * ## It executes the step's own `run:` body
 *
 * Every behavioural case below cuts the `run:` block out of the YAML,
 * dedents it, and executes THAT TEXT under `bash -e` — the invocation
 * Actions uses for a `run:` block on Linux. A case asserting on a paraphrase
 * of the script is the shape `.claude/rules/checks-must-be-able-to-fail.md`
 * opens with, and the `-e` matters on its own: a body that relies on `set -e`
 * being absent behaves differently under the real invocation than under
 * `bash -c`.
 *
 * The command itself is stubbed. `scripts/board-conformance.ts` is covered
 * by `test/board-conformance.test.ts`, including the `REFUSE_EXIT = 0`
 * mutation battery that proves its refusals are refusals; what is unproven
 * until this file is whether the WORKFLOW forwards that refusal or swallows
 * it. So the stub stands in for the command and the cases vary only its exit
 * code and its output.
 *
 * ## What was broken to prove these can fail
 *
 * The last case rewrites the cut body's `exit $status` to `exit 0` and
 * re-runs the short-board input. The real body exits 1 and the mutant exits
 * 0, so the short-board case is witnessing the forwarding of the exit code
 * and not something else that also happens to exit non-zero. That is the
 * same contrast `test/board-conformance.test.ts` draws against
 * `REFUSE_EXIT`, one layer out.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKFLOW = ".github/workflows/board-conformance.yml";

const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf-8");

/**
 * The workflow with its comment lines removed.
 *
 * The cases that refuse a construct — `continue-on-error`, a fallback to the
 * built-in token — have to search what the runner executes, not what the
 * file says about itself. This file's own header explains why both are
 * absent, and a grep over the whole document cannot tell a construct from a
 * sentence naming one. That is the same narrowing `test/ai-review-payload-
 * reading.test.ts` AC-6 makes for the review step's skip prose.
 *
 * A `#` inside the annotation strings would be kept, because only a line
 * whose first non-space character is `#` is dropped.
 */
function code(yml: string): string {
  return yml
    .split("\n")
    .filter(l => !/^\s*#/.test(l))
    .join("\n");
}

/** The workflow's `on:` block — from `on:` to the next top-level key. */
function triggerBlock(yml: string): string {
  const at = yml.indexOf("\non:");
  if (at < 0) return "";
  const rest = yml.slice(at + 1);
  const end = rest.search(/\n(?=[A-Za-z])/);
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * The step's `run:` body, dedented, exactly as the runner would see it.
 *
 * It reads to the END of the document and BINDS that: the last non-empty
 * line must be the exit. A cut with its own end anchor would silently drop a
 * line somebody appended, and a fixture that describes the runner instead of
 * reading it measures the test author's intention rather than the file.
 */
function runBody(): string {
  const yml = read(WORKFLOW);
  const at = yml.indexOf("          set -uo pipefail");
  expect(at, `the ${WORKFLOW} step's run: block moved or opens differently`).toBeGreaterThan(-1);
  const dedented = yml
    .slice(at)
    .split("\n")
    .map(l => l.replace(/^ {10}/, ""))
    .join("\n");
  const lines = dedented.split("\n").filter(l => l.trim() !== "");
  expect(
    lines[lines.length - 1],
    "the last non-empty line of the cut is not the exit, so the cut has run past the end of " +
      "this step and would feed YAML to bash — or the step no longer ends by forwarding the " +
      "command's exit code. Either way these cases are measuring the wrong text.",
  ).toBe("exit $status");
  return dedented;
}

/** What the command printed on 2026-11-07, the state #1892 was filed in. */
const SHORT_LINE = "board-conformance: 1 of 5 readings SHORT — criterion-coverage: 23 of 26 (target 26)";

/** What hand-edits printed on 2026-11-22 before its second run opened (#2639). */
const HAND_LINE = "hand-edits: SHORT — 1 hand edit(s) since 2026-11-19T12:11:50Z on the Convergence family:";

/** The command's own argv, echoed by the stub so a case can read it back. */
const ARGV_MARKER = "STUB-ARGV";

interface Run {
  code: number | null;
  out: string;
  err: string;
}

/**
 * Execute a `run:` body with `bun` stubbed to a chosen exit code.
 *
 * `bash -e <file>`, because that is the invocation Actions uses — not
 * `bash -c`, and not with `-u`/`-o pipefail` supplied from outside, which
 * would hide a body that forgot to set them itself.
 */
function exec(body: string, opts: { commandExit: number; handEditsExit?: number; token?: string }): Run {
  const dir = mkdtempSync(join(tmpdir(), "rg-board-conf-job-"));
  try {
    const stub = join(dir, "bun");
    // `handEditsExit` defaults to `commandExit`, so a case written before
    // SC-2625 sees both readings agree and keeps its meaning.
    const hand = opts.handEditsExit ?? opts.commandExit;
    writeFileSync(
      stub,
      `#!/bin/sh\necho "${ARGV_MARKER} $*"\n` +
        `case "$*" in *hand-edits*) [ ${hand} -eq 0 ] || echo "${HAND_LINE}"; exit ${hand};; esac\n` +
        `echo "${SHORT_LINE}"\nexit ${opts.commandExit}\n`,
    );
    chmodSync(stub, 0o755);

    const script = join(dir, "step.sh");
    writeFileSync(script, body);

    const env: NodeJS.ProcessEnv = { PATH: `${dir}:${process.env.PATH ?? ""}` };
    if (opts.token !== undefined) env.GITHUB_TOKEN = opts.token;

    const r = spawnSync("/bin/bash", ["-e", script], { env, encoding: "utf-8" });
    return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#1892: the board reading is taken by a job, not by a person", () => {
  // The control. Every case below reads the cut, so the cut is proved first:
  // an empty string contains nothing, which is indistinguishable from a body
  // that contains nothing wrong.
  test("the cut really is the step's shell, and it really runs the command", () => {
    const body = runBody();
    expect(body.length).toBeGreaterThan(200);
    expect(body, "the cut does not invoke the conformance command").toContain(
      "bun scripts/board-conformance.ts",
    );
  });

  test("a short board makes the job red, and names itself in an annotation", () => {
    const r = exec(runBody(), { commandExit: 1, token: "pat" });
    expect(r.code, `a short board left the job green\n${r.out}${r.err}`).toBe(1);
    expect(r.out, "nothing in the log says the board is short").toContain(
      "::error title=Board conformance",
    );
    // The command's own words survive. A job that reports only its own
    // sentence tells a reader a reading failed and not WHICH one.
    expect(r.out).toContain(SHORT_LINE);
  });

  test("a conformant board is green and emits no error annotation", () => {
    const r = exec(runBody(), { commandExit: 0, token: "pat" });
    expect(r.code, `a conformant board failed the job\n${r.out}${r.err}`).toBe(0);
    expect(r.out).not.toContain("::error");
  });

  test("an absent credential is UNMEASURED by name, naming the SECRET", () => {
    const r = exec(runBody(), { commandExit: 1, token: "" });
    expect(r.out, "an empty credential produced no UNMEASURED annotation").toContain(
      "::warning title=Board conformance UNMEASURED",
    );
    // The secret, not the environment variable. `GITHUB_TOKEN is not set` is
    // what the command says, and a maintainer reading it goes looking for the
    // wrong thing: the built-in token is always set and still cannot answer.
    expect(r.out).toContain("RUNGATE_PROJECT_TOKEN");
  });

  // The emptiness check above must not be a second decider. Two guards
  // answering the same question are behaviourally one guard, and a mutation
  // of either leaves the other holding the case up
  // (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape).
  // `scripts/board-conformance.ts` is the decider — it already refuses an
  // absent credential by name through `REFUSE_EXIT` — so the step annotates
  // and then runs the command anyway.
  test("the credential warning does not SKIP the command", () => {
    const r = exec(runBody(), { commandExit: 1, token: "" });
    expect(
      r.out,
      "the step short-circuited on an empty credential, so it is a second decider over a " +
        "question scripts/board-conformance.ts already answers",
    ).toContain(ARGV_MARKER);
    expect(r.code).toBe(1);
  });

  test("a credential that resolved produces no UNMEASURED warning", () => {
    const r = exec(runBody(), { commandExit: 0, token: "pat" });
    expect(r.out).not.toContain("UNMEASURED");
  });

  test("the command is invoked with no arguments — every reading, not one", () => {
    const r = exec(runBody(), { commandExit: 0, token: "pat" });
    const argv = r.out.split("\n").find(l => l.startsWith(ARGV_MARKER) && l.includes("board-conformance"));
    expect(argv, `the stub was never reached\n${r.out}${r.err}`).toBeDefined();
    expect(argv).toBe(`${ARGV_MARKER} scripts/board-conformance.ts`);
  });

  // The mutation. Without it the short-board case is green-on-a-status-code
  // and cannot tell the forwarding apart from any other reason bash exits 1.
  test("the mutant — `exit $status` set to `exit 0` — ships where the real body refuses", () => {
    const body = runBody();
    const mutant = body.replace(/^exit \$status$/m, "exit 0");
    expect(mutant, "the mutation did not apply, so this case witnesses nothing").not.toBe(body);
    const r = exec(mutant, { commandExit: 1, token: "pat" });
    expect(
      r.code,
      "the mutant still refused, so the short-board case above is not witnessing the exit " +
        "code being forwarded — something else in the body also exits non-zero",
    ).toBe(0);
  });
});

describe("#1892: it reports, and it gates nothing", () => {
  test("no schedule — the reading is taken when main changes", () => {
    expect(
      triggerBlock(code(read(WORKFLOW))),
      "a cron came back. The board changes when main changes; see board-flow.yml and #1744.",
    ).not.toContain("schedule:");
  });

  test("it reports on main, and on a hand-run dispatch", () => {
    const block = triggerBlock(code(read(WORKFLOW)));
    expect(block.length).toBeGreaterThan(10);
    expect(block).toContain("push:");
    expect(block).toContain("branches: [main]");
    expect(block).toContain("workflow_dispatch:");
  });

  test("no pull_request trigger, so nothing can make it a required check", () => {
    expect(
      triggerBlock(code(read(WORKFLOW))),
      "a pull_request trigger makes this requirable, and a merge that legitimately closes the " +
        "last issue for a criterion would then redden main for correct work — #1892 settled " +
        "this as report-only. Giving it back a pull_request trigger also puts it inside " +
        "test/merge-group-trigger.test.ts's requirable population, which would fail.",
    ).not.toContain("pull_request");
  });

  // The control for the three cases below, which all read `code()`. A
  // stripper that removed everything would make each of them pass over an
  // empty string — the vacuous shape in
  // `.claude/rules/checks-must-be-able-to-fail.md`.
  test("the comment stripper keeps the executable half and drops the prose", () => {
    const stripped = code(read(WORKFLOW));
    expect(stripped).toContain("bun scripts/board-conformance.ts");
    expect(stripped).toContain("runs-on:");
    expect(stripped, "the stripper kept a comment line").not.toContain("# Not managed by rungate");
  });

  test("the credential is bound in env:, never consulted in an if:", () => {
    const yml = code(read(WORKFLOW));
    expect(yml).toContain("GITHUB_TOKEN: ${{ secrets.RUNGATE_PROJECT_TOKEN }}");
    // `secrets` is not available in `if:` at all, and a step skipped by `if:`
    // reports SKIPPED — which reads as satisfied. `.claude/rules/config-access.md`.
    //
    // Stated as a COUNT, not as a loop over the conditions that exist. This
    // workflow has no `if:` at all, so a loop would hold vacuously and would
    // go on holding vacuously after somebody added one — the count is the
    // assertion that can fail.
    const conditions = yml.split("\n").filter(l => /^\s*if:/.test(l));
    expect(
      conditions,
      "a step condition appeared in this workflow. If it reads a credential or a presence " +
        "variable, a skipped step reports SKIPPED, which reads as satisfied — see " +
        ".claude/rules/config-access.md. Resolve it inside run: instead, or say here why " +
        "this condition is safe.",
    ).toEqual([]);
  });

  test("nothing swallows the command's verdict", () => {
    const yml = code(read(WORKFLOW));
    for (const forbidden of ["continue-on-error", "|| true"]) {
      expect(
        yml,
        `${forbidden} converts a short board into a green check, which is the defect this ` +
          `workflow exists to end`,
      ).not.toContain(forbidden);
    }
  });

  test("the built-in token is not a fallback anywhere in the file", () => {
    expect(
      code(read(WORKFLOW)),
      "secrets.GITHUB_TOKEN is repository-scoped and structurally cannot see a USER-level " +
        "ProjectV2 board (lib/stage-ladder.ts, the `credentialed` scope). A fallback to it " +
        "would report an empty board where the honest answer is UNMEASURED.",
    ).not.toContain("secrets.GITHUB_TOKEN");
  });
});

/**
 * SC-2625 (#1722): the same job takes the hand-edit reading.
 *
 * Not one of board-conformance's readings, because the stage ladder runs that
 * command inside the required `test` check and a hand edit would then block
 * every merge (Jason's choice, 2026-11-22). So the step runs
 * `scripts/hand-edits.ts` after the board reading, and either one short makes
 * the job red. `test/hand-edits.test.ts` and `test/hand-edits-script.test.ts`
 * cover the reading; these cover whether the job forwards it.
 *
 * What was broken to prove it: the last case deletes the line that hands the
 * hand-edit status to the job, and a hand edit alone then ships green.
 */
describe("SC-2625: a hand edit on the payload's board turns the board job red", () => {
  const handArgv = (out: string) => out.split("\n").find(l => l.startsWith(ARGV_MARKER) && l.includes("hand-edits"));

  test("the step reads the payload family, on this repository", () => {
    const r = exec(runBody(), { commandExit: 0, token: "pat" });
    expect(handArgv(r.out), `the hand-edit reading was never taken\n${r.out}${r.err}`).toBe(
      `${ARGV_MARKER} scripts/hand-edits.ts --prefix Convergence --repo hornjason/rungate`,
    );
  });

  // The prefix is spelled in the workflow because a run: body cannot read a
  // spec's frontmatter. This binds the spelling to the payload's own
  // declaration, so renaming the payload's milestones cannot leave the job
  // reading an empty family.
  test("the prefix the step passes is the payload spec's board.prefix", () => {
    const engine = read("specs/SPEC-TO-BOARD-PIPELINE-SPEC.md");
    const payload = engine.match(/^governs:.*Payload: (\S+\.md)/m)?.[1];
    expect(payload, "the engine spec no longer names its payload in governs:").toBeDefined();
    const prefix = read(`specs/${payload}`).match(/^board:\n(?:\s+.*\n)*?\s+prefix: (\S+)/m)?.[1];
    expect(prefix, `specs/${payload} declares no board.prefix`).toBeDefined();
    expect(runBody()).toContain(`bun scripts/hand-edits.ts --prefix ${prefix} `);
  });

  test("a hand edit alone makes the job red, and names itself", () => {
    const r = exec(runBody(), { commandExit: 0, handEditsExit: 1, token: "pat" });
    expect(r.code, `a hand edit left the job green\n${r.out}${r.err}`).toBe(1);
    expect(r.out).toContain("::error title=Hand edits");
    expect(r.out, "the board reading was met, so it must not be blamed").not.toContain("::error title=Board conformance");
    expect(r.out, "the reading's own words, which name the edit, did not survive").toContain(HAND_LINE);
  });

  test("a short board with no hand edit is still red", () => {
    const r = exec(runBody(), { commandExit: 1, handEditsExit: 0, token: "pat" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("::error title=Board conformance");
    expect(r.out).not.toContain("::error title=Hand edits");
  });

  test("a short board does not stop the hand-edit reading being taken", () => {
    const r = exec(runBody(), { commandExit: 1, handEditsExit: 1, token: "pat" });
    expect(handArgv(r.out), "a short board skipped the hand-edit reading").toBeDefined();
    expect(r.code).toBe(1);
  });

  test("the mutant — the hand-edit status never reaches the job — ships a hand edit green", () => {
    const body = runBody();
    const mutant = body.replace(/^\s*\[ "\$status" -ne 0 \] \|\| status=\$edits$/m, "");
    expect(mutant, "the mutation did not apply, so this case witnesses nothing").not.toBe(body);
    expect(exec(body, { commandExit: 0, handEditsExit: 1, token: "pat" }).code).toBe(1);
    expect(
      exec(mutant, { commandExit: 0, handEditsExit: 1, token: "pat" }).code,
      "the mutant still refused, so the hand-edit case is not witnessing the status being forwarded",
    ).toBe(0);
  });
});
