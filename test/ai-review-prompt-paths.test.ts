/**
 * The reviewer cannot read an environment variable.
 *
 * `buildReviewPrompt()` told the reviewer, five times, to obtain a path from
 * "the `X` environment variable". The reviewer is launched with
 * `--allowedTools Read,Grep,Glob,Write` and none of those four returns the
 * value of an environment variable, so the instruction is unfollowable and
 * what the agent does instead is guess.
 *
 * Measured on the first transcript the #1391 recorder ever captured — run
 * 41544545181 attempt 2, PR #1730. The review itself was healthy: 37 turns of
 * a budget of 80, `is_error:false`, no permission denial, and a well-formed
 * 1,934-character payload handed to the single `Write` call. It went to
 *
 *     /home/runner/work/_temp/ai-review-findings-41544545181-2.json
 *
 * while the workflow read
 *
 *     /home/runner/work/_temp/ai-review-findings-41544545181-2.d/ai-review-findings.json
 *
 * One path segment apart, and the round was recorded UNMEASURED.
 *
 * ## Why four of the five never showed a symptom
 *
 * The asymmetry is the whole mechanism and it is why this is a population
 * test rather than a test about the findings path.
 *
 * - The four INPUT paths are files that already exist, so `Glob` finds them
 *   and the reviewer never needs the variable. They work **by accident**.
 * - The OUTPUT path does not exist yet. There is nothing to glob, so the
 *   name has to be invented, and a guess is right only sometimes — which is
 *   exactly the ~38% UNMEASURED rate seen on 2026-11-02.
 *
 * Repairing only the one that showed a symptom would leave four live
 * instances of the same defect, each one glob-dependent and silent.
 *
 * ## What was broken to prove this can fail
 *
 * `promptNamesEnvVars()` is the one binding. Re-adding any single variable
 * name to the prompt turns the population case red and the message names
 * which one; the control below plants a mention and asserts the detector
 * sees it, so a case that passes because the detector stopped matching is
 * distinguishable from one that passes because the prompt is clean.
 */

import { describe, expect, test } from "bun:test";
import * as step from "../lib/scaffold/ai-review-step";

/**
 * Every `*_PATH_VAR` the module exports, discovered rather than listed, so a
 * sixth path variable added later is in this population without anybody
 * remembering to add it here.
 */
function pathVarNames(mod: Record<string, unknown>): string[] {
  return Object.entries(mod)
    .filter(([k, v]) => /_PATH_VAR$/.test(k) && typeof v === "string")
    .map(([, v]) => v as string)
    .sort();
}

/**
 * The single binding this file mutates: which path-variable NAMES appear in
 * a prompt. A name in the prompt is only ever an instruction to read the
 * environment, because the name is useless to the agent for anything else.
 */
export function promptNamesEnvVars(prompt: string, names: string[]): string[] {
  return names.filter(n => prompt.includes(n));
}

describe("the reviewer's prompt names no value its toolset cannot obtain", () => {
  const prompt = step.buildReviewPrompt();
  const names = pathVarNames(step as unknown as Record<string, unknown>);

  test("the premise: the granted toolset has no tool that reads an environment variable", () => {
    const granted = step.AI_REVIEW_ALLOWED_TOOLS.split(",").map(s => s.trim());
    expect(granted.length, "the allow-list is empty — this file is measuring nothing").toBeGreaterThan(0);

    // If any of these is ever granted the reviewer CAN read its environment,
    // and the rule this file enforces may be relaxed deliberately rather than
    // by a prompt edit nobody connected to the toolset.
    const canReadEnv = ["Bash", "BashOutput", "Task", "SlashCommand"];
    expect(
      granted.filter(g => canReadEnv.includes(g)),
      `the reviewer now holds a tool that can read its environment, so the premise of ` +
        `this file has changed — revisit it deliberately rather than deleting cases`,
    ).toEqual([]);
  });

  test("the population is non-empty, so the case below cannot pass vacuously", () => {
    expect(
      names.length,
      "no `*_PATH_VAR` export was discovered — the detector is looking at nothing",
    ).toBeGreaterThanOrEqual(5);
  });

  test("CONTROL: the detector sees a planted mention", () => {
    // Without this, a prompt that is clean and a detector that stopped
    // matching produce the same empty list.
    const planted = `read the file named in the ${names[0]} environment variable`;
    expect(promptNamesEnvVars(planted, names)).toEqual([names[0]]);
  });

  test("no path variable is named in the prompt — the whole population, not the one that broke", () => {
    expect(
      promptNamesEnvVars(prompt, names),
      `the prompt tells the reviewer to read these from its environment, and ` +
        `\`${step.AI_REVIEW_ALLOWED_TOOLS}\` cannot read an environment variable. ` +
        `The reviewer will guess the value. Put the resolved path in the prompt instead.`,
    ).toEqual([]);
  });

  test("the prompt still tells the reviewer where to write — it did not just go silent", () => {
    // The cheapest wrong fix for the case above is deleting the sentence. That
    // leaves the reviewer with no destination at all, which is the same
    // UNMEASURED outcome by a shorter route.
    expect(
      prompt,
      "the prompt no longer names the findings file at all — deleting the " +
        "instruction is not the fix, carrying the resolved path is",
    ).toContain(step.AI_REVIEW_FINDINGS_BASENAME);
  });
});
