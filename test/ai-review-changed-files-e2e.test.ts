/**
 * The changed-files demotion, run end to end through the real adjudicator
 * (#1567).
 *
 * ## Why this file exists, and why it could not have existed before
 *
 * `test/ai-review-changed-files-step.test.ts` built the writing half: the
 * generated job produces the list and hands the path over. It explicitly did
 * NOT claim the demotion fires, and it was right not to — the generated step
 * runs `bunx rungate@<published version>`, and the published adjudicator at
 * the time took **one** positional. A second argument was a no-op there, so
 * an end-to-end case would have gone green having observed nothing.
 *
 * `v0.8.3` inverted that premise. Both halves have been live on every pull
 * request in this repository since, with nothing running the path end to end.
 * A dormant capability that activates on a pin bump has no moment where
 * anybody decides to turn it on, so there is no natural point at which anybody
 * tests it — which is the whole of #1567.
 *
 * ## What is asserted, and what each case is FOR
 *
 * | case | asserts | without it |
 * |---|---|---|
 * | E2E-1 | the same payload blocks without the list and is demoted with it | a capability that is live and inert reads exactly like a working one |
 * | E2E-2 | a finding INSIDE the list is NOT demoted | a filter that demotes everything passes E2E-1 perfectly |
 * | E2E-3 | `argv[2]` refuses | widening the contract is the named hazard in the adjudicator's own docblock |
 *
 * E2E-2 is the negative control and the reason E2E-1 means anything. The two
 * run the **same finding** against two different lists, so the only variable
 * between them is whether the cited file is in the diff —
 * `.claude/rules/checks-must-be-able-to-fail.md`, *a contrast is only a
 * control if one variable differs*.
 *
 * ## What this does NOT establish
 *
 * That a **production** run has demoted anything. This exercises the
 * adjudicator the generated step invokes, with the arguments that step
 * passes; it does not read a live workflow log. The step wiring is the
 * sibling file's claim, and the two together are the path — but neither is an
 * observation of production, and saying otherwise would be the UNMEASURED-as-
 * clean conversion this module exists to prevent.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { AI_REVIEW_REQUIRED_EXIT } from "../lib/scaffold/ai-review-step";
import {
  AI_REVIEW_FINDING_FIELDS,
  AI_REVIEW_BLOCK_VERDICT,
  AI_REVIEW_FINDINGS_KEY,
  AI_REVIEW_SCOPE_LINE,
  AI_REVIEW_SEVERITIES,
  AI_REVIEW_VERDICT_KEY,
  argumentsBeyondTheContract,
  main,
} from "../lib/scaffold/ai-review-findings";

const SCRATCH = mkdtempSync(join(tmpdir(), "ai-review-cf-e2e-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

let seq = 0;
function scratchFile(body: string, ext: string): string {
  const path = join(SCRATCH, `e2e-${seq++}.${ext}`);
  writeFileSync(path, body);
  return path;
}

const f = AI_REVIEW_FINDING_FIELDS;
const BLOCKING = Object.keys(AI_REVIEW_SEVERITIES).filter(s => AI_REVIEW_SEVERITIES[s])[0] as string;

/** The one file every case below cites. */
const CITED = "lib/the-finding-names-this.ts";
/** A file the pull request touched that the finding does NOT name. */
const OTHER = "lib/the-diff-touched-this-instead.ts";

/**
 * A contract-complete blocking finding, built from the contract rather than
 * hand-spelled — #1166's lesson, where eight fixtures carried keys the
 * contract never declared and adjudicated BLOCKED anyway.
 */
function payloadCiting(file: string): string {
  return JSON.stringify({
    [AI_REVIEW_VERDICT_KEY]: AI_REVIEW_BLOCK_VERDICT,
    [AI_REVIEW_FINDINGS_KEY]: [
      {
        [f.severity]: BLOCKING,
        [f.file]: file,
        [f.line]: 12,
        [f.summary]: "a credential is logged in plain text",
        [f.failureScenario]: "any run with the key set writes it to the job log",
      },
    ],
  });
}

/** Run the real `main`, both streams captured. */
function runMain(argv: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void err.push(a.map(String).join(" "));
  let code: number;
  try {
    code = main(argv);
  } finally {
    console.log = log;
    console.error = error;
  }
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const listOf = (paths: string[]) => scratchFile(`${paths.join("\n")}\n`, "txt");

describe("#1567: the changed-files demotion, end to end through the real adjudicator", () => {
  /**
   * E2E-1. The issue's first requirement, word for word: "Run the real
   * adjudicator both ways — with the second positional supplied and with it
   * absent — and show the verdicts differ."
   *
   * Both arms get the SAME payload. The only difference is the argument.
   */
  test("E2E-1: the same finding blocks without the list and is demoted with it", () => {
    const payload = scratchFile(payloadCiting(CITED), "json");

    const without = runMain([payload]);
    const withList = runMain([payload, listOf([OTHER])]);

    // Arm A — no list. This is the state every run was in before v0.8.3.
    expect(
      without.code,
      "a blocking finding with no changed-file list must still block. If this is 0 the " +
        "demotion below proves nothing, because there was no blocking verdict to demote.",
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(without.out).toContain(`${AI_REVIEW_SCOPE_LINE} NOT_SUPPLIED`);

    // Arm B — the list names a file the finding does not cite.
    expect(
      withList.code,
      "the finding names a file outside the diff, so CRC-B7 must demote it to " +
        "Pre-existing and the run must not block.",
    ).toBe(0);
    expect(withList.out).toContain(`${AI_REVIEW_SCOPE_LINE} MEASURED`);
    expect(withList.out).toContain("Pre-existing");

    // The claim the issue actually asks for, stated as one assertion rather
    // than inferred from the two above.
    expect(
      without.code === withList.code,
      "the verdicts did not differ, so the second positional changed nothing and the " +
        "capability is live and inert — which #1567 calls out as the more interesting " +
        "finding, not a passing test.",
    ).toBe(false);
  });

  /**
   * E2E-2. The negative control, and the reason E2E-1 is readable at all: a
   * filter that demoted every finding would pass E2E-1 exactly.
   *
   * Same payload, same finding, same citation. The ONLY variable is whether
   * the list contains the cited file.
   */
  test("E2E-2 control: a finding INSIDE the diff is not demoted and still blocks", () => {
    const payload = scratchFile(payloadCiting(CITED), "json");

    const inDiff = runMain([payload, listOf([CITED, OTHER])]);

    expect(
      inDiff.code,
      "the finding names a file the diff touched, so it must NOT be demoted. A reading " +
        "that demotes this one demotes everything, and E2E-1 cannot tell the two apart.",
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(inDiff.out).toContain(`${AI_REVIEW_SCOPE_LINE} MEASURED`);
  });

  /**
   * E2E-2b. The two arms of the control differ in exactly one input, asserted
   * rather than left to the reader comparing two test bodies.
   */
  test("E2E-2b: the demoting and non-demoting arms differ only in the list", () => {
    const payload = scratchFile(payloadCiting(CITED), "json");

    const demoted = runMain([payload, listOf([OTHER])]);
    const kept = runMain([payload, listOf([CITED, OTHER])]);

    expect(demoted.code).toBe(0);
    expect(kept.code).toBe(AI_REVIEW_REQUIRED_EXIT);
    // Both took a MEASURED scope reading, so the difference is the membership
    // test and not one arm failing to read its list at all.
    expect(demoted.out).toContain(`${AI_REVIEW_SCOPE_LINE} MEASURED`);
    expect(kept.out).toContain(`${AI_REVIEW_SCOPE_LINE} MEASURED`);
  });

  /**
   * E2E-3. The adjudicator's own docblock names widening the contract as the
   * hazard — a changed-file path containing a space that an unquoted
   * expansion word-split into two would arrive as `argv[2]`, and a CLI that
   * accepts an argument it ignores reports success for an invocation that did
   * not happen.
   */
  test("E2E-3: a third positional refuses rather than being ignored", () => {
    const payload = scratchFile(payloadCiting(CITED), "json");
    const list = listOf([OTHER]);

    const extra = runMain([payload, list, "a third argument nothing reads"]);

    expect(
      extra.code,
      "argv[2] must refuse. On the merged tree before this contract existed, " +
        "main([payload, list, 'extra']) returned 0 and printed CLEAN.",
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
    // The reason rides the ANNOTATION, which goes to stderr; the scope line
    // goes to stdout. Asserting the wrong stream here reads as "the refusal
    // did not name itself" when it did — the first draft of this case did
    // exactly that.
    expect(extra.err).toContain("ARGUMENTS_UNREADABLE");
    // The refusal NAMES the argument. "An argument was ignored" is not
    // something an operator can act on when the invocation is a workflow line.
    expect(extra.err).toContain("a third argument nothing reads");
    expect(argumentsBeyondTheContract([payload, list, "x", "y"])).toEqual(["x", "y"]);
  });

  /**
   * The premise inversion itself, asserted from behaviour rather than from a
   * comment. `v0.8.2`'s `main` read `argv[0]` and nothing else; if this tree's
   * `main` ever returns to ignoring the second positional, every case above
   * goes green while witnessing nothing, and this is the one that notices.
   */
  test("E2E-4: the second positional is read, which is what made Phase 2 writable", () => {
    const payload = scratchFile(payloadCiting(CITED), "json");

    const notSupplied = runMain([payload]);
    const supplied = runMain([payload, listOf([OTHER])]);

    expect(notSupplied.out).toContain(`${AI_REVIEW_SCOPE_LINE} NOT_SUPPLIED`);
    expect(supplied.out).toContain(`${AI_REVIEW_SCOPE_LINE} MEASURED`);
    expect(
      notSupplied.out === supplied.out,
      "the two invocations printed identical output, which is what a one-positional " +
        "adjudicator does. That is the v0.8.2 behaviour this file's premise says has " +
        "been superseded.",
    ).toBe(false);
  });

  /**
   * E2E-5. A successful demotion must not read as the reviewer contradicting
   * itself.
   *
   * The reviewer is never given the pull request's file list, so a `BLOCK`
   * over a finding that turns out to be pre-existing is an honest `BLOCK`.
   * Comparing its word against the POST-demotion count would make every
   * successful demotion a CONTRADICTION — the arm firing on the mechanism
   * working, which is the loudest possible way to be wrong.
   *
   * This is not a hypothetical: the first draft of this suite used a `PASS`
   * verdict with a blocking finding, and every arm exited 1 for that reason
   * while the demotion underneath was working perfectly. The exit code alone
   * could not tell the two apart — `.claude/rules/checks-must-be-able-to-fail.md`,
   * *green on the exit code, witnessing the wrong mechanism*, in reverse.
   */
  test("E2E-5: a demoted BLOCK is CLEAN, not a contradiction", () => {
    const payload = scratchFile(payloadCiting(CITED), "json");
    const demoted = runMain([payload, listOf([OTHER])]);

    expect(demoted.out).toContain("outcome: CLEAN");
    expect(
      demoted.out,
      "the verdict agreement is measured BEFORE the demotion. If this says " +
        "CONTRADICTION, the agreement arm has started reading the post-demotion count " +
        "and now fires whenever the demotion succeeds.",
    ).not.toContain("CONTRADICTION");
    expect(demoted.code).toBe(0);
  });
});
