/**
 * ai-review-turn-budget.test.ts — the reviewer's turn budget (#812).
 *
 * Covers AC-2 and AC-4.
 *
 * `AI_REVIEW_MAX_TURNS` was 25, chosen before any ai-review run had ever
 * executed. Run `39461944884` is the first one that got past the app-token
 * exchange, and it ended `error_max_turns` at `num_turns: 26` with no payload
 * written. Raising a number is a one-character change, so what is worth
 * testing is not the number — it is the two properties that make raising it
 * the honest repair rather than the cheap one.
 *
 * ## AC-1 carries no case here, deliberately
 *
 * AC-1 asks that the new value be justified against the measurement. The
 * justification is the docblock over the constant. A test asserting a
 * docblock contains a run id asserts that prose exists, which is
 * `.claude/rules/checks-must-be-able-to-fail.md`'s third shape wearing a
 * compliance badge — it cannot tell a justification from a sentence quoting
 * one. So it is not written, and this paragraph is the record of the choice
 * rather than an omission somebody later reads as an oversight.
 *
 * ## AC-4 is the one that matters, and it is EXECUTED
 *
 * The cheapest wrong fix for "an exhausted review produces nothing" is not to
 * raise the budget at all — it is to have the prompt write a payload in its
 * first turns and refine it afterwards, so exhaustion leaves a file behind.
 * That converts an honest UNMEASURED into a PASS over a review that never
 * finished (the fifth shape), and it is strictly worse than producing
 * nothing. So the reporting step's behaviour under a FAILED action is run as
 * bash rather than grepped: a run that exhausted its budget must still reach
 * the UNMEASURED annotation, and must still refuse when the consumer has
 * turned the refusal on.
 *
 * The success case stands beside it as a control. Without it, "the failure
 * case prints an UNMEASURED warning" is satisfied by a script that prints one
 * unconditionally, and a script that annotated everything would read exactly
 * like a script that distinguishes.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createCiWorkflows } from "../lib/scaffold/steps";
import {
  AI_REVIEW_JOB,
  AI_REVIEW_MAX_TURNS,
  AI_REVIEW_REQUIRE_VALUE,
  AI_REVIEW_REQUIRE_VAR,
  AI_REVIEW_REQUIRED_EXIT,
  AI_REVIEW_UNMEASURED_TITLE,
  AI_REVIEW_WORKFLOW_FILE,
  aiReviewClaudeArgs,
  buildReviewRunScript,
  reviewDepthConfig,
  vertexCiConfig,
  type VertexCiDecision,
  AI_REVIEW_RUNS,
} from "../lib/scaffold/ai-review-step";
import { stubBunxAbsent } from "./helpers/stub-bunx";

/**
 * A fixture version for the adjudicator's `bunx` pin (#1013), never the
 * real one. `buildReviewRunScript` takes the generating version as an
 * argument; passing `harnessVersion()` here would make every assertion
 * below agree with the generator by construction.
 */
const FIXTURE_VERSION = "0.0.0-fixture";


const SOURCE_PATH = join(import.meta.dir, "..", "lib", "scaffold", "ai-review-step.ts");
const source = readFileSync(SOURCE_PATH, "utf-8");

const FIXTURE_CI = {
  runner: "ubuntu-latest",
  bunVersion: "1.2.0",
  vertex: {
    project: "fixture-vertex-project",
    workloadIdentityProvider:
      "projects/111122223333/locations/global/workloadIdentityPools/fixture-pool/providers/fixture-provider",
  },
};
const VERTEX: VertexCiDecision = vertexCiConfig(FIXTURE_CI);

const scratch: string[] = [];
afterAll(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

// ── AC-2: one declaring position ─────────────────────────────────────────

describe("AC-2: the turn budget is declared once and interpolated", () => {
  test("the module holds exactly one declaration of the constant", () => {
    const decl = /^export const AI_REVIEW_MAX_TURNS = /gm;
    expect(
      source.match(decl)?.length ?? 0,
      "AI_REVIEW_MAX_TURNS is declared more than once, so a mutation of " +
        "either copy leaves the other answering for it",
    ).toBe(1);
  });

  test("no literal turn count is written beside the interpolation", () => {
    // `--max-turns 25` typed into the args string would satisfy every
    // assertion below while the constant became decorative. The only
    // occurrence this module is allowed is the interpolated one.
    const literal = [...source.matchAll(/--max-turns\s+(\S+)/g)].map(m => m[1]!);
    expect(
      literal.length,
      "the module names --max-turns somewhere unexpected:\n" + literal.join("\n"),
    ).toBeGreaterThan(0);
    // #1655: the args interpolate the configured depth's budget, which is
    // derived from the constant (the next test moves it with a mutant).
    for (const value of literal) {
      expect(value, "a turn count is written out instead of interpolated").toBe(
        "${depth.maxTurns}",
      );
    }
  });

  test("the rendered args move with the constant, so they are not a second copy", async () => {
    // `toContain(String(AI_REVIEW_MAX_TURNS))` is satisfied by a number typed
    // into the template a second time. The input on which the mutant and the
    // original differ, named rather than assumed: the constant's own value.
    const SENTINEL = 7;
    expect(SENTINEL, "the sentinel equals the real value, so the case is vacuous").not.toBe(
      AI_REVIEW_MAX_TURNS,
    );

    const needle = `export const AI_REVIEW_MAX_TURNS = ${AI_REVIEW_MAX_TURNS};`;
    const count = source.split(needle).length - 1;
    if (count !== 1) {
      throw new Error(
        `could not build the mutant: \`${needle}\` appears ${count} times in ` +
          `lib/scaffold/ai-review-step.ts`,
      );
    }
    const dir = scratchDir("ai-review-turns-mutant-");
    const path = join(dir, "ai-review-step.ts");
    writeFileSync(path, source.replace(needle, `export const AI_REVIEW_MAX_TURNS = ${SENTINEL};`));
    const mutant = (await import(path)) as {
      aiReviewClaudeArgs: (v: VertexCiDecision) => string;
    };

    expect(aiReviewClaudeArgs(VERTEX)).toContain(`--max-turns ${AI_REVIEW_MAX_TURNS}`);
    expect(mutant.aiReviewClaudeArgs(VERTEX)).toContain(`--max-turns ${SENTINEL}`);
    expect(
      mutant.aiReviewClaudeArgs(VERTEX),
      "the rendered args still carry the real value, so they are a second copy",
    ).not.toContain(`--max-turns ${AI_REVIEW_MAX_TURNS}`);
  });
});

// ── AC-3: the generated file follows the source ──────────────────────────

describe("AC-3: the generated workflow carries the declared budget", () => {
  test("a scaffolded ai-review.yml names the constant's value exactly once", () => {
    const project = scratchDir("ai-review-turns-project-");
    mkdirSync(join(project, ".claude", "rungate"), { recursive: true });
    writeFileSync(
      join(project, ".claude", "rungate", "config.json"),
      JSON.stringify({ project: "ai-review-turn-fixture", ci: FIXTURE_CI }, null, 2) + "\n",
    );
    createCiWorkflows(project, []);

    const text = readFileSync(
      join(project, ".github", "workflows", AI_REVIEW_WORKFLOW_FILE),
      "utf-8",
    );
    // Through the parser, not a grep: a block scalar that mangled the args
    // line would still contain the substring.
    const doc = Bun.YAML.parse(text) as any;
    expect(Object.keys(doc.jobs ?? {}), "the ai-review job is gone").toContain(AI_REVIEW_JOB);
    const args = (doc.jobs[AI_REVIEW_JOB].steps as any[])
      .map(s => String(s?.with?.claude_args ?? ""))
      .filter(a => a.includes("--max-turns"));
    // One per run (#2667), and every one is the constant's.
    expect(args.length, "the steps handing the action a turn budget are not one per run").toBe(AI_REVIEW_RUNS);
    for (const a of args) expect(a).toContain(`--max-turns ${AI_REVIEW_MAX_TURNS}`);
  });
});

/**
 * AC-5: the COMMITTED reviewer workflow runs on the declared budget (#1966,
 * #2626).
 *
 * AC-2 and AC-3 make the budget one declaration reaching one generated
 * workflow, generated into a scratch directory. They are silent about any
 * workflow file this repository actually runs. This case reads the committed
 * `.github/workflows/ai-review.yml`.
 *
 * It was written against the trial reviewer, `claude-review.yml`, which was
 * hand-written and caller-owned and therefore never received #812's raise. It
 * sat on 25 for as long as this file had existed, and in exactly the same way:
 * all turns spent, nothing written. #2626 moved the read to the reviewer that
 * can block a merge so the trial could be deleted.
 *
 * Run 42868398515 on PR #1965, 2026-11-10:
 *
 *   UNMEASURED — tool calls: 25 (Grep×17, Read×7, ToolSearch×1);
 *   reviews added by this run: 0
 *     NO_REVIEW_POSTED: this run added no review to the pull request (AC-1)
 *
 * 25 of 25, none of them a write. The three MCP tools that job grants —
 * create pending, add comment, submit — were never reached, so a required
 * check failed on a review that had not happened. `project-state.json`
 * records the same shape once before, which makes it a mechanism rather
 * than a draw.
 *
 * **Asserted as equality with the constant, never with a literal.** A number
 * typed in here would be a second place that decides the budget, which is the
 * thing that just cost two rounds: #812 raised one site and nothing carried
 * it to the other, and nothing could see the two had drifted.
 *
 * Breaking it: set `--max-turns 25` in the committed workflow and this goes
 * red naming both numbers, while AC-2 and AC-3 stay green — they read a
 * freshly generated file and cannot see this one.
 */
describe("AC-5: the committed reviewer workflow runs on the declared budget (#1966)", () => {
  test("the committed ai-review.yml's --max-turns is AI_REVIEW_MAX_TURNS, not a literal of its own", () => {
    const text = readFileSync(
      join(import.meta.dir, "..", ".github", "workflows", AI_REVIEW_WORKFLOW_FILE),
      "utf-8",
    );
    const budgets = text
      .split("\n")
      .map(l => l.trim())
      .filter(l => !l.startsWith("#"))
      .flatMap(l => [...l.matchAll(/--max-turns\s+(\d+)/g)].map(m => Number(m[1])));

    expect(
      budgets.length,
      `the committed ${AI_REVIEW_WORKFLOW_FILE} does not carry one --max-turns per run outside a comment — ` +
        "with none this case would pass vacuously, and a reviewer with no turn budget is a job with no bound",
    ).toBe(AI_REVIEW_RUNS);

    // Every run's budget, not only the first (#2667).
    expect(
      new Set(budgets).size,
      `the runs in the committed ${AI_REVIEW_WORKFLOW_FILE} disagree on their budget: ${budgets.join(", ")}`,
    ).toBe(1);
    expect(
      budgets[0],
      `the committed ${AI_REVIEW_WORKFLOW_FILE} runs on ${budgets[0]} turns and AI_REVIEW_MAX_TURNS says ` +
        `${AI_REVIEW_MAX_TURNS}. One number, in AI_REVIEW_MAX_TURNS — #812 raised it once ` +
        "and a hand-written workflow did not follow, which cost #1965 two UNMEASURED rounds.",
    ).toBe(AI_REVIEW_MAX_TURNS);

    // The control. Without it the equality above is satisfied by two sites
    // that both still hold the pre-#812 default, and this case would have
    // passed on the very tree that produced the failure.
    expect(
      AI_REVIEW_MAX_TURNS,
      "the budget this asserts equality with is the one 25 was raised FROM — the case " +
        "could not have come back wrong",
    ).toBeGreaterThan(25);
  });
});

// ── AC-4: exhaustion stays UNMEASURED and writes nothing ─────────────────

/** Run the generated reporting step as bash and read what it did. */
function runReportStep(
  env: Record<string, string>,
  payload?: string,
): { code: number; out: string; err: string } {
  const dir = scratchDir("ai-review-report-");
  const path = join(dir, "report.sh");
  writeFileSync(path, buildReviewRunScript(FIXTURE_VERSION));
  // Since #816 a successful action with no payload is the SKIP state, not a
  // completed review. The control below is about a review that finished, so
  // it has to plant one.
  const planted: Record<string, string> = {};
  if (payload !== undefined) {
    const findings = join(dir, "findings.json");
    writeFileSync(findings, payload);
    planted.AI_REVIEW_FINDINGS_PATH = findings;
  }
  const r = Bun.spawnSync(["bash", "-e", path], {
    cwd: dir,
    env: { PATH: stubBunxAbsent(), ...planted, ...env },
  });
  return {
    code: r.exitCode,
    out: new TextDecoder().decode(r.stdout),
    err: new TextDecoder().decode(r.stderr),
  };
}

describe("AC-4: a review that exhausted its budget is UNMEASURED, not a pass", () => {
  // `error_max_turns` makes the action step exit 1, so GitHub records its
  // outcome as `failure`. That is the input, and it is the one the real run
  // produced.
  const EXHAUSTED = { AI_REVIEW_MODE: "vertex", AI_REVIEW_ACTION_OUTCOME: "failure" };

  test("it annotates UNMEASURED and says no payload was written", () => {
    const r = runReportStep(EXHAUSTED);
    expect(r.out, `stderr was:\n${r.err}`).toContain(`::warning title=${AI_REVIEW_UNMEASURED_TITLE}`);
    expect(r.out).toContain("no findings payload was written");
    expect(r.out).toContain("UNMEASURED, not a passing review");
    // #1180 inverted this line. It read `toBe(0)` with the note "the step
    // itself failed, which is a different state" — true of the STEP and not
    // of the CHECK, which was green over a review that burned its whole turn
    // budget and wrote nothing. A credential resolved and the reviewer ran,
    // so this is an attempted measurement that did not produce one.
    expect(r.code, "an exhausted review still passes the required check").toBe(
      AI_REVIEW_REQUIRED_EXIT,
    );
  });

  test("a consumer that required the review gets a refusal, not a warning alone", () => {
    const r = runReportStep({ ...EXHAUSTED, [AI_REVIEW_REQUIRE_VAR]: AI_REVIEW_REQUIRE_VALUE });
    expect(r.err).toContain(`::error title=${AI_REVIEW_UNMEASURED_TITLE}`);
    expect(r.code, "the refusal did not fail the step").not.toBe(0);
  });

  test("the control: a COMPLETED review reaches a different reading", () => {
    // Without this, the two cases above are satisfied by a script that
    // annotates every run identically, and nothing could tell a step that
    // distinguishes the states from one that does not.
    const r = runReportStep(
      { AI_REVIEW_MODE: "vertex", AI_REVIEW_ACTION_OUTCOME: "success" },
      '{"findings": [], "verdict": "PASS"}',
    );
    // Both streams: a completed review whose payload nothing adjudicated
    // refuses on stderr since #1013's review, while the exhausted reading
    // this is the control for still warns on stdout.
    const text = `${r.out}${r.err}`;
    expect(text).toContain("wrote a findings payload");
    expect(
      text,
      "a completed review reports the same sentence as an exhausted one",
    ).not.toContain("no findings payload was written");
  });

  test("the two readings are different strings, so the pair measures the outcome", () => {
    // #585's pair discipline: exactly one input varies between these two
    // runs — `AI_REVIEW_ACTION_OUTCOME` — so a difference in what they print
    // is a measurement of that reading and of nothing else.
    const failed = runReportStep(EXHAUSTED).out;
    const okRun = runReportStep(
      { AI_REVIEW_MODE: "vertex", AI_REVIEW_ACTION_OUTCOME: "success" },
      '{"findings": [], "verdict": "PASS"}',
    );
    const ok = `${okRun.out}${okRun.err}`;
    expect(failed.length, "the exhausted run printed nothing at all").toBeGreaterThan(0);
    expect(ok.length, "the completed run printed nothing at all").toBeGreaterThan(0);
    expect(failed).not.toBe(ok);
  });
});

/**
 * #1655: review depth is a per-repo setting, `ci.reviewDepth`, and each value
 * changes what the reviewer is handed. Quick halves the turn budget and Deep
 * doubles it; Standard is `AI_REVIEW_MAX_TURNS`, so a repository that sets it,
 * or sets nothing, keeps the workflow it has. An absent key reviews at
 * Standard and the generated workflow says so; any other value is refused,
 * since a corrupt setting is never a missing one (.claude/rules/config-access.md).
 */
describe("CRC-B9: review depth is configurable per repo as Quick, Standard or Deep (#1655)", () => {
  const generate = (ci: Record<string, unknown>): string => {
    const project = scratchDir("ai-review-depth-project-");
    mkdirSync(join(project, ".claude", "rungate"), { recursive: true });
    writeFileSync(
      join(project, ".claude", "rungate", "config.json"),
      JSON.stringify({ project: "ai-review-depth-fixture", ci }, null, 2) + "\n",
    );
    createCiWorkflows(project, []);
    return readFileSync(join(project, ".github", "workflows", AI_REVIEW_WORKFLOW_FILE), "utf-8");
  };
  const turnsIn = (text: string): number[] =>
    ((Bun.YAML.parse(text) as any).jobs[AI_REVIEW_JOB].steps as any[])
      .map(st => /--max-turns (\d+)/.exec(String(st?.with?.claude_args ?? ""))?.[1])
      .filter((t): t is string => t !== undefined)
      .map(Number);

  test("the reading: three depths, each with its budget, and an absent key at Standard with a reason", () => {
    expect(reviewDepthConfig({ reviewDepth: "quick" })).toMatchObject({ depth: "quick", maxTurns: AI_REVIEW_MAX_TURNS / 2 });
    expect(reviewDepthConfig({ reviewDepth: "standard" })).toMatchObject({ depth: "standard", maxTurns: AI_REVIEW_MAX_TURNS });
    expect(reviewDepthConfig({ reviewDepth: "deep" })).toMatchObject({ depth: "deep", maxTurns: AI_REVIEW_MAX_TURNS * 2 });
    const absent = reviewDepthConfig({ runner: "ubuntu-latest" });
    expect(absent).toMatchObject({ depth: "standard", maxTurns: AI_REVIEW_MAX_TURNS, declared: false });
    expect(absent.reason).toContain("ci.reviewDepth");
    expect(reviewDepthConfig(undefined).declared).toBe(false);
  });

  test.each([["Quick"], ["DEEP"], ["fast"], [""], [1], [true], [null], [["deep"]]])(
    "a ci.reviewDepth of %p is refused, not read as Standard",
    value => {
      expect(() => reviewDepthConfig({ reviewDepth: value })).toThrow(/ci\.reviewDepth/);
    },
  );

  // #2725 review: a ci section that is not an object is corrupt, not one that
  // declares nothing, for this reader and for ci.vertex's beside it.
  test.each([["deep"], [["deep"]], [5], [true]])("a ci section of %p is refused, not read as declaring nothing", ci => {
    expect(() => reviewDepthConfig(ci)).toThrow(/\bci\b.*object/);
    expect(() => vertexCiConfig(ci)).toThrow(/\bci\b.*object/);
  });

  test("the three depths produce three different reviewer invocations, one per run", () => {
    const quick = turnsIn(generate({ ...FIXTURE_CI, reviewDepth: "quick" }));
    const standard = turnsIn(generate({ ...FIXTURE_CI, reviewDepth: "standard" }));
    const deep = turnsIn(generate({ ...FIXTURE_CI, reviewDepth: "deep" }));
    expect(quick).toEqual(Array(AI_REVIEW_RUNS).fill(AI_REVIEW_MAX_TURNS / 2));
    expect(standard).toEqual(Array(AI_REVIEW_RUNS).fill(AI_REVIEW_MAX_TURNS));
    expect(deep).toEqual(Array(AI_REVIEW_RUNS).fill(AI_REVIEW_MAX_TURNS * 2));
  });

  test("an absent key reviews at Standard and the workflow records why; a declared Standard is the same workflow without the note", () => {
    const absent = generate(FIXTURE_CI);
    const declared = generate({ ...FIXTURE_CI, reviewDepth: "standard" });
    expect(turnsIn(absent)).toEqual(turnsIn(declared));
    expect(absent).toContain(reviewDepthConfig(FIXTURE_CI).reason);
    expect(declared).not.toContain("ci.reviewDepth");
  });

  test("the turn-limit diagnosis names the configured budget, not the Standard one", () => {
    expect(buildReviewRunScript(FIXTURE_VERSION, AI_REVIEW_MAX_TURNS * 2)).toContain(`this job sets to ${AI_REVIEW_MAX_TURNS * 2};`);
    expect(buildReviewRunScript(FIXTURE_VERSION)).toContain(`this job sets to ${AI_REVIEW_MAX_TURNS};`);
    expect(generate({ ...FIXTURE_CI, reviewDepth: "deep" })).toContain(`sets to ${AI_REVIEW_MAX_TURNS * 2};`);
  });
});
