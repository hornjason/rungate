/**
 * Covers SC-1904..SC-1907 (HARNESS-STANDARD.md), #488.
 *
 * `createCiWorkflows` emitted `- run: bun test` while `harness` was in
 * scope and three of its siblings read `harness?.ci?.*` four lines above.
 * Every other consumer of `dev.testCmd` honoured it, so a consumer who set
 * the field got agent briefs, an AGENTS.md row and a ship workflow using
 * their command, and a CI workflow using a different one.
 *
 * The issue's SC-2 is the one that shapes this file: the CI step and the
 * AGENTS.md row must resolve through ONE binding, because two sites that
 * agree today are one decider too many and no behavioural test can tell
 * them apart. So every case below drives `testCommandDecision` or the real
 * generators, and SC-1906 asserts that short-circuiting the binding moves
 * BOTH outputs — the property a pair of agreeing literals cannot have.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { DEFAULT_TEST_COMMAND, agentTestCommand, testCommandDecision } from "../lib/test-command";
import { createCiWorkflows, generateAgentsMdContent } from "../lib/scaffold/steps";
import { testCommandsNamedByCiWorkflow } from "../lib/test-command-positions";
import { readFileSync } from "fs";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function project(opts: { testCmd?: string; agentTestCmd?: string; script?: string; pkg?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "test-cmd-488-"));
  roots.push(root);
  if (opts.pkg !== false) {
    const scripts = opts.script === undefined ? {} : { test: opts.script };
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", scripts }));
  }
  if (opts.testCmd !== undefined || opts.agentTestCmd !== undefined) {
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    const dev = { testCmd: opts.testCmd, agentTestCmd: opts.agentTestCmd };
    writeFileSync(
      join(root, ".claude", "rungate", "config.json"),
      JSON.stringify({ project: "demo", dev }),
    );
  }
  return root;
}

/**
 * The test command the generated CI job names, by generating it.
 *
 * Through `testCommandsNamedByCiWorkflow`, which is the production answer to
 * "which run line is the test step, and what command does it name". This was
 * a hand-rolled copy of that walk — the same question answered twice, so a
 * mutation of either left the other holding every case up.
 *
 * Delegating also makes the CI-only instrumentation invisible here, which is
 * the point rather than a side effect: #1173 appends
 * `--reporter=junit --reporter-outfile=…` to a `bun test` command, and the
 * copy compared it raw and reported that CI had overridden the operator's
 * command. The strip is the production one, so if it ever stops stripping,
 * `test/test-command-agreement.test.ts` is what goes red, not this.
 */
function ciTestStep(root: string): string {
  createCiWorkflows(root, [], { force: true });
  const yml = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf-8");
  return testCommandsNamedByCiWorkflow(yml)[0]?.command ?? "";
}

describe("#488: one binding decides the test command", () => {
  test("SC-1904: the generated CI job runs the consumer's dev.testCmd", () => {
    const root = project({ testCmd: "bun test --coverage" });
    expect(testCommandDecision(root).command).toBe("bun test --coverage");
    expect(ciTestStep(root), "CI still runs its own command over the operator's")
      .toBe("bun test --coverage");
  });

  test("SC-1905: a consumer declaring neither still gets bun test", () => {
    // SC-3 of the issue: the default is unchanged for every existing
    // consumer. Without this row the fix is free to redefine the default
    // while satisfying everything above.
    const bare = project({ pkg: false });
    expect(testCommandDecision(bare).command).toBe(DEFAULT_TEST_COMMAND);
    expect(ciTestStep(bare)).toBe("bun test");

    // …and a package.json with no `test` script is the same answer by a
    // different route, which is the rung most likely to be dropped.
    const noScript = project({});
    expect(testCommandDecision(noScript).source).toBe("default");
    expect(ciTestStep(noScript)).toBe("bun test");

    // The middle rung, verbatim and NOT `bun run test`: that spelling
    // fires pre/post hooks, which on this repo means CI running
    // sync-sc-status and writing to the tree.
    const scripted = project({ script: "vitest run" });
    expect(testCommandDecision(scripted)).toMatchObject({
      command: "vitest run",
      source: "package-script",
    });
    expect(ciTestStep(scripted)).toBe("vitest run");

    // And config beats the script, or the ladder is in the wrong order.
    const both = project({ testCmd: "bun test --bail", script: "vitest run" });
    expect(testCommandDecision(both).command).toBe("bun test --bail");
  });

  test("SC-1906: the CI step and the AGENTS.md row move together", () => {
    // SC-2 of the issue, and the only shape that can witness it. Two sites
    // holding the same literal pass every assertion above; what a shared
    // binding has that a coincidence does not is that ONE value changes
    // both outputs.
    const root = project({ testCmd: "bun test --coverage --bail" });
    const agentsMd = generateAgentsMdContent(root, "code", []);
    expect(agentsMd, "AGENTS.md does not document the operator's test command")
      .toContain("bun test --coverage --bail");
    expect(ciTestStep(root)).toBe("bun test --coverage --bail");

    // The INSTRUMENT: the string has to be one neither site would produce
    // on its own, or both could be printing a hardcoded default that
    // happens to match.
    expect("bun test --coverage --bail").not.toBe(DEFAULT_TEST_COMMAND);
    // …and the second value, because a single value cannot distinguish
    // "reads the binding" from "echoes whatever the fixture wrote last".
    const other = project({ testCmd: "make check" });
    expect(generateAgentsMdContent(other, "code", [])).toContain("make check");
    expect(ciTestStep(other)).toBe("make check");
  });

  test("SC-1907: a malformed package.json loses the scan, not the command", () => {
    // The scaffold must not die on a file it only consulted for a default.
    const root = mkdtempSync(join(tmpdir(), "test-cmd-488-bad-"));
    roots.push(root);
    writeFileSync(join(root, "package.json"), "{ not json");
    expect(testCommandDecision(root)).toMatchObject({
      command: DEFAULT_TEST_COMMAND,
      source: "default",
    });
  });
});

/**
 * #2707: what an agent runs before it commits is the consumer's to choose.
 * The Rules line said "Run full test suite" whatever the project decided,
 * and one consumer whose agents run only the tests their change touches
 * (four agents each running the full suite on one laptop had timed out) had
 * a generated AGENTS.md contradicting its own CLAUDE.md, with no key to fix
 * it. The CI job is the other half: it keeps running the full suite.
 */
describe("#2707: the Rules line follows dev.agentTestCmd, and CI keeps the full suite", () => {
  const FULL_RULE = (cmd: string) =>
    `- Run full test suite (\`${cmd}\`) and show real output — no summaries, no skipped files\n`;
  const TARGETED_RULE = (agent: string, ci: string) =>
    `- Before you commit, run the tests your change touches (\`${agent}\`) and show real output — no summaries. ` +
    `CI's \`test\` job runs the full suite (\`${ci}\`) on every pull request\n`;

  test("set: agents are told the targeted command, and CI still runs the full suite", () => {
    const root = project({ testCmd: "bun test --bail", agentTestCmd: "bash scripts/check-unit-suite.sh" });
    expect(agentTestCommand(root)).toBe("bash scripts/check-unit-suite.sh");
    const md = generateAgentsMdContent(root, "code", []);
    expect(md).toContain(TARGETED_RULE("bash scripts/check-unit-suite.sh", "bun test --bail"));
    expect(md, "the full-suite rule is still there beside the targeted one").not.toContain("Run full test suite");
    expect(ciTestStep(root), "CI runs the agents' command instead of the full suite").toBe("bun test --bail");
    expect(md, "the Commands table stopped naming the full suite").toContain("| Test | `bun test --bail` |");
  });

  test("unset: the Rules line is today's, word for word", () => {
    const root = project({ testCmd: "bun test --bail" });
    expect(agentTestCommand(root)).toBeNull();
    const md = generateAgentsMdContent(root, "code", []);
    expect(md).toContain(FULL_RULE("bun test --bail"));
    expect(md).not.toContain("Before you commit, run the tests your change touches");
  });

  test("an empty or blank value is unset, not a rule naming nothing", () => {
    for (const blank of ["", "   "]) {
      const root = project({ testCmd: "bun test", agentTestCmd: blank });
      expect(agentTestCommand(root), JSON.stringify(blank)).toBeNull();
      expect(generateAgentsMdContent(root, "code", [])).toContain(FULL_RULE("bun test"));
    }
  });
});
