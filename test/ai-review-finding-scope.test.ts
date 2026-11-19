import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { AI_REVIEW_REQUIRED_EXIT } from "../lib/scaffold/ai-review-step";
import type { AiReviewUnmeasuredReason } from "../lib/scaffold/ai-review-findings";
import {
  AI_REVIEW_FINDING_FIELDS,
  AI_REVIEW_FINDINGS_KEY,
  AI_REVIEW_SCOPE_LINE,
  AI_REVIEW_SEVERITIES,
  AI_REVIEW_VERDICT_KEY,
  aiReviewExitCode,
  aiReviewRefusal,
  aiReviewScopeLine,
  argumentsBeyondTheContract,
  AI_REVIEW_RESTORED_LINE,
  citedLinePastEnd,
  findingCitedLine,
  lineCountsNotSupplied,
  main,
  readAiReviewChangedFiles,
  readAiReviewLineCounts,
  readAiReviewFindings,
  restoredFromBase,
  restoredFromBaseLine,
  scopeMeasured,
  scopeNotSupplied,
} from "../lib/scaffold/ai-review-findings";
import { AI_REVIEW_LINE_COUNTS_PATH_VAR, AI_REVIEW_UNTRUSTED_PATHS } from "../lib/scaffold/ai-review-step";
import type { AiReviewLineCountReading } from "../lib/scaffold/ai-review-findings";

/**
 * Covers #1204 — a blocking finding may name a file the pull request never
 * touched, and nothing compared the two.
 *
 * ## What the merge with CRC-B7 decided, and why this file changed shape
 *
 * #1204 and CRC-B7 answered the same question over the same input, on two
 * branches. #1204 REFUSED an unlocatable blocking finding —
 * `BLOCKING_FINDING_UNLOCATABLE`, a red required check. CRC-B7 DEMOTES it:
 * the finding is tagged `Pre-existing`, reported, and does not block.
 *
 * **CRC-B7 owns the case.** #1204's own motivating measurement is the
 * argument: nine findings about defects already on `main` were reported
 * against whichever pull request was standing closest, and under the refusal
 * each of those becomes a red required check on a pull request that caused
 * none of them. The refusal makes its own motivating case worse.
 *
 * What #1204 keeps, and what this file is now about, is the INPUT layer and
 * the honesty properties the refusal was carrying:
 *
 * - three scope states as a TYPE — `NOT_SUPPLIED`, `MEASURED`, `UNMEASURED` —
 *   so "nobody handed this run a list" is never read as "every finding was
 *   locatable" (AC-5, AC-6);
 * - a demoted finding is CARRIED and NAMED, never dropped (AC-2, AC-3);
 * - an incomplete finding is graded once, not twice (AC-7);
 * - the adjudicator never computes the diff itself (AC-10);
 * - an argument nothing reads refuses (AC-9b).
 *
 * `BLOCKING_FINDING_UNLOCATABLE` is GONE from the reason union, deliberately.
 * A reason nothing can emit makes every `not.toContain` against it pass
 * vacuously, which is how a deleted check goes on looking guarded — the third
 * shape in `.claude/rules/checks-must-be-able-to-fail.md`. The rows below
 * that used to assert its absence now assert the positive fact instead: the
 * finding blocked, or it did not, and the counts say which.
 *
 * ## The half that is not here
 *
 * The changed-file list is an INPUT, and no generated job supplies it yet:
 * the step would have to write `git diff --name-only <base>...HEAD` from the
 * RESTORED tree, which is #1356. AC-10 is the guard that keeps the gap
 * honest — this module must never compute the diff itself, or it would
 * compute it from a tree the reviewer could have written to.
 */

const MODULE_PATH = join(import.meta.dir, "..", "lib", "scaffold", "ai-review-findings.ts");
const STEP_PATH = join(import.meta.dir, "..", "lib", "scaffold", "ai-review-step");
const source = readFileSync(MODULE_PATH, "utf-8");

let SCRATCH = "";

beforeAll(() => {
  SCRATCH = mkdtempSync(join(tmpdir(), "ai-review-finding-scope-"));
});

afterAll(() => {
  if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
});

let fixtureSeq = 0;

function scratchFile(body: string, ext = "txt"): string {
  const path = join(SCRATCH, `scope-${fixtureSeq++}.${ext}`);
  writeFileSync(path, body);
  return path;
}

/**
 * A contract-complete finding, built FROM the contract (#1166's lesson).
 *
 * Eight fixtures in the sibling suite carried keys the contract never
 * declared and adjudicated BLOCKED anyway. A fixture that spells its own keys
 * cannot notice the reader and the prompt drifting apart.
 */
function blockingFinding(
  severity: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  const f = AI_REVIEW_FINDING_FIELDS;
  const base: Record<string, unknown> = {
    [f.severity]: severity,
    [f.file]: "lib/touched.ts",
    [f.line]: 12,
    [f.summary]: "a credential is logged in plain text",
    [f.failureScenario]: "any run with the key set writes it to the job log",
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base;
}

function payloadOf(verdict: string, findings: Record<string, unknown>[]): string {
  return JSON.stringify({
    [AI_REVIEW_VERDICT_KEY]: verdict,
    [AI_REVIEW_FINDINGS_KEY]: findings,
  });
}

/** A changed-file list on disk, read through the real reader. */
function scopeOver(paths: string[]) {
  return readAiReviewChangedFiles(scratchFile(`${paths.join("\n")}\n`));
}

/** Run `main` with its two streams captured. */
function runMain(
  argv: string[],
  lineCounts: AiReviewLineCountReading = lineCountsNotSupplied(),
): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void err.push(a.map(String).join(" "));
  let code: number;
  try {
    code = main(argv, null, null, null, lineCounts);
  } finally {
    console.log = log;
    console.error = error;
  }
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const BLOCKING_SEVERITY = Object.keys(AI_REVIEW_SEVERITIES).filter(s => AI_REVIEW_SEVERITIES[s])[0];
const ADVISORY_SEVERITIES = Object.keys(AI_REVIEW_SEVERITIES).filter(s => !AI_REVIEW_SEVERITIES[s]);

describe("#1204: a blocking finding is adjudicated only where it can be located", () => {
  const f = AI_REVIEW_FINDING_FIELDS;

  test("#1204 / AC-1 control: a finding naming a CHANGED file adjudicates exactly as after #1198", () => {
    // FIRST, and read before any row below. If a locatable blocking finding
    // stopped blocking, every demotion underneath would be an instrument that
    // demotes everything rather than a measurement of scope.
    const scope = scopeOver(["lib/touched.ts", "test/other.test.ts"]);
    expect(scope.status, "the control's own changed-file list did not read").toBe("MEASURED");

    const r = readAiReviewFindings(payloadOf("BLOCK", [blockingFinding(BLOCKING_SEVERITY)]), scope);

    expect(r.outcome).toBe("BLOCKED");
    expect(r.blocked).toBe(true);
    expect(r.unmeasuredReasons).toEqual([]);
    expect(r.blockingReported).toHaveLength(1);
    expect(r.unlocatableReported, "a located finding was demoted").toEqual([]);
    expect(aiReviewExitCode(r)).toBe(AI_REVIEW_REQUIRED_EXIT);
  });

  test("#1204 / AC-2 witness: a finding naming a file the pull request never touched is demoted, not dropped", () => {
    const scope = scopeOver(["lib/touched.ts"]);
    const r = readAiReviewFindings(
      payloadOf("BLOCK", [blockingFinding(BLOCKING_SEVERITY, { [f.file]: "does/not/exist.ts" })]),
      scope,
    );

    // CRC-B7's answer, and the whole of the difference from AC-1: the run is
    // GREEN. A defect that was already on the base branch is not this pull
    // request's to fix, and `ai-review` reads the merge ref, so without the
    // demotion every one of them lands on whichever pull request is nearest.
    expect(r.outcome).toBe("CLEAN");
    expect(r.blocked).toBe(false);
    expect(aiReviewExitCode(r)).toBe(0);

    // Carried, not dropped. The count PRODUCED and the count ALLOWED TO BLOCK
    // are both observable, and they differ here — which is the property that
    // separates a demotion from a discard.
    expect(r.reported, "the finding was discarded instead of demoted").toHaveLength(1);
    expect(r.blockingReported).toHaveLength(0);
    expect(r.unlocatableReported, "the demoted finding was not recorded as demoted").toHaveLength(
      1,
    );

    const line = aiReviewScopeLine(r);
    expect(line).toContain("MEASURED");
    expect(line.toLowerCase()).toContain("unlocatable");
  });

  test("#1204 / AC-2b: the pair varies the FILE and nothing else", () => {
    // #585's discipline. Two hand-written payloads are two literals and the
    // next edit touches one of them; the out-of-scope half is DERIVED from
    // the in-scope half, and the derivation is asserted, so the pair cannot
    // carry a second difference.
    const located = blockingFinding(BLOCKING_SEVERITY);
    const unlocatable: Record<string, unknown> = { ...located, [f.file]: "does/not/exist.ts" };

    const differing = Object.keys(located).filter(
      k => JSON.stringify(located[k]) !== JSON.stringify(unlocatable[k]),
    );
    expect(differing, "the pair differs in more than the file it names").toEqual([f.file]);
    expect(Object.keys(unlocatable).sort()).toEqual(Object.keys(located).sort());

    const scope = scopeOver(["lib/touched.ts"]);
    expect(readAiReviewFindings(payloadOf("BLOCK", [located]), scope).outcome).toBe("BLOCKED");
    expect(readAiReviewFindings(payloadOf("BLOCK", [unlocatable]), scope).outcome).toBe("CLEAN");
  });

  test("#1204 / AC-3: the cheapest wrong fix — dropping the finding — turns this case red", () => {
    // Named before the repair exists, and it is a LIVE temptation under
    // CRC-B7 in a way it was not under #1204's refusal: the demoted finding
    // does not block, so deleting it from `reported` changes no exit code
    // anywhere. A review that discarded a finding would then be
    // byte-indistinguishable from one that never had it.
    //
    // So the assertion is that the path is NAMED on a channel an operator
    // reads, in BOTH arrangements — with a blocking finding beside it, where
    // it reaches the `::error` refusal, and alone, where the run is green and
    // the `::notice` is the only thing carrying it. The lone case is the one
    // a drop repair makes silent.
    const scope = scopeOver(["lib/touched.ts"]);
    const list = scratchFile("lib/touched.ts\n");
    const demoted = blockingFinding(BLOCKING_SEVERITY, { [f.file]: "does/not/exist.ts" });

    const beside = readAiReviewFindings(
      payloadOf("BLOCK", [blockingFinding(BLOCKING_SEVERITY), demoted]),
      scope,
    );
    expect(beside.reported, "the payload's own findings were edited").toHaveLength(2);
    expect(beside.unlocatableReported).toHaveLength(1);
    expect(
      aiReviewRefusal(beside) ?? "",
      "the refusal does not name the demoted path, so a run that demoted one and a " +
        "run that never had one read the same",
    ).toContain("does/not/exist.ts");
    expect(aiReviewRefusal(beside) ?? "").toContain("Pre-existing");

    // Alone, and through `main`, because the channel is the point: the
    // reading is CLEAN and the only place the finding survives the job is the
    // annotation `main` emits.
    const alone = runMain([scratchFile(payloadOf("BLOCK", [demoted]), "json"), list]);
    expect(alone.code, "a demoted finding reddened a pull request that caused it").toBe(0);
    expect(
      `${alone.out}\n${alone.err}`,
      "the lone demoted finding was not named on any channel, so dropping it would " +
        "produce identical output",
    ).toContain("does/not/exist.ts");
    expect(alone.out, "the demotion was not counted where the verdict is read").toContain(
      AI_REVIEW_SCOPE_LINE,
    );
  });

  test("#1204 / AC-4: a NON-blocking finding is not subject, matching the line #1198 drew", () => {
    // The scope line, deliberately the same one #1198 drew: an advisory
    // finding costs a line in an annotation and nothing else, and demoting
    // one would be a no-op dressed as a decision — it blocks nothing either
    // way, so the only observable effect is a count that lies.
    const scope = scopeOver(["lib/touched.ts"]);
    for (const severity of ADVISORY_SEVERITIES) {
      const r = readAiReviewFindings(
        payloadOf("PASS", [blockingFinding(severity, { [f.file]: "does/not/exist.ts" })]),
        scope,
      );
      expect(r.outcome, `an advisory '${severity}' was held to the scope check`).toBe("CLEAN");
      expect(
        r.unlocatableReported,
        `an advisory '${severity}' was counted as demoted, inflating the count`,
      ).toHaveLength(0);
      expect(aiReviewExitCode(r)).toBe(0);
    }
    expect(ADVISORY_SEVERITIES.length, "the loop ran over nothing").toBeGreaterThan(0);
  });

  test("#1204 / AC-5 control: with no changed-file list the verdict is what it is today", () => {
    // The release-compatibility half. An absent list switches the demotion
    // OFF, and the thing that keeps that from being Silent Default
    // Substitution is that the state is NAMED and printed — never that the
    // verdict moves.
    //
    // Row one is the load-bearing one: the SAME payload that goes CLEAN in
    // AC-2 is BLOCKED here, so this row and that one differ in the scope
    // reading and in nothing else.
    const cases = [
      ["BLOCK", [blockingFinding(BLOCKING_SEVERITY, { [f.file]: "does/not/exist.ts" })], "BLOCKED"],
      ["BLOCK", [blockingFinding(BLOCKING_SEVERITY)], "BLOCKED"],
      ["PASS", [], "CLEAN"],
      ["PASS", [blockingFinding(BLOCKING_SEVERITY)], "CONTRADICTION"],
    ] as const;

    for (const [verdict, findings, expected] of cases) {
      const r = readAiReviewFindings(payloadOf(verdict, [...findings]));
      expect(r.outcome, `an absent changed-file list moved the ${expected} verdict`).toBe(expected);
      expect(r.scope.status).toBe("NOT_SUPPLIED");
      expect(
        r.unlocatableReported,
        "a demotion that did not run reported an empty result — `null` and `[]` are " +
          "'not checked' and 'checked, none found'",
      ).toBeNull();
      expect(aiReviewScopeLine(r)).toContain("not checked");
    }
  });

  test("#1204 / AC-6: a list that could not be taken REFUSES, and differs from one that was empty", () => {
    // The issue's own words: an empty changed-file list makes every blocking
    // finding unlocatable, which under CRC-B7 demotes ALL of them and reports
    // a green check for a review that found something. Both states refuse,
    // with different reasons, and NEITHER demotes anything.
    const absent = readAiReviewChangedFiles(join(SCRATCH, "nowhere", "changed.txt"));
    expect(absent.status).toBe("UNMEASURED");
    expect(absent.reason).toBe("CHANGED_FILES_UNREADABLE");

    const empty = readAiReviewChangedFiles(scratchFile("\n   \n"));
    expect(empty.status).toBe("UNMEASURED");
    expect(empty.reason).toBe("CHANGED_FILES_EMPTY");

    expect(absent.reason, "the two states are not distinguishable").not.toBe(empty.reason);

    for (const scope of [absent, empty]) {
      const reason = scope.reason;
      expect(reason, "a refusing scope reading carried no reason").not.toBeNull();
      const r = readAiReviewFindings(
        payloadOf("BLOCK", [blockingFinding(BLOCKING_SEVERITY)]),
        scope,
      );
      expect(r.outcome).toBe("UNMEASURED");
      expect(r.unmeasuredReasons).toEqual([reason as AiReviewUnmeasuredReason]);
      expect(
        r.unlocatableReported,
        "a diff nobody could take was read as a pull request that touches nothing, " +
          "which demotes every blocking finding and reports green",
      ).toBeNull();
      expect(r.blocked, "a withheld decision was defaulted").toBeNull();
      expect(r.reported, "the payload's findings were lost with the scope reading").toHaveLength(1);
      expect(aiReviewExitCode(r)).toBe(AI_REVIEW_REQUIRED_EXIT);
    }
  });

  test("#1204 / AC-7: an INCOMPLETE blocking finding is not also graded on scope", () => {
    // Two deciders over one input is the fourth shape in
    // `.claude/rules/checks-must-be-able-to-fail.md`. A finding carrying no
    // `file` has already been refused by #1198 with its own reason; demoting
    // it as well would mean a mutation of either check leaves the other
    // holding the case up — and it would turn a refusal into a green run.
    const scope = scopeOver(["lib/touched.ts"]);
    for (const file of [undefined, 12]) {
      const r = readAiReviewFindings(
        payloadOf("BLOCK", [blockingFinding(BLOCKING_SEVERITY, { [f.file]: file })]),
        scope,
      );
      expect(r.outcome, `a '${String(file)}' file was demoted rather than refused`).toBe(
        "UNMEASURED",
      );
      expect(r.unmeasuredReasons).toEqual(["BLOCKING_FINDING_INCOMPLETE"]);
      expect(
        r.unlocatableReported,
        "an undecidable path was ALSO demoted, so two deciders hold one case up",
      ).toHaveLength(0);
    }
  });

  test("#1204 / AC-8: the counts reach the operator — produced, and allowed to block", () => {
    const scope = scopeOver(["lib/touched.ts"]);
    const r = readAiReviewFindings(
      payloadOf("BLOCK", [
        blockingFinding(BLOCKING_SEVERITY),
        blockingFinding(BLOCKING_SEVERITY, { [f.file]: "does/not/exist.ts" }),
      ]),
      scope,
    );

    const line = aiReviewScopeLine(r);
    expect(line.startsWith(AI_REVIEW_SCOPE_LINE), `the scope line is not prefixed: ${line}`).toBe(
      true,
    );
    expect(line).toContain("MEASURED");
    // Two produced, one allowed to block, one demoted. Three numbers that
    // must differ: a line reporting "2 findings, 2 blocking" beside a run
    // that demoted one would be inventing the number nobody can check.
    expect(line).toContain("findings reported: 2");
    expect(line).toContain("allowed to block: 1");
    expect(line).toContain("unlocatable: 1");
    expect(line, "a scope line that fits on one workflow log line").not.toContain("\n");
  });

  test("#1204 / AC-9: main() reads the positional list, prints the scope state, and demotes", () => {
    const payloadPath = scratchFile(
      payloadOf("BLOCK", [
        blockingFinding(BLOCKING_SEVERITY),
        blockingFinding(BLOCKING_SEVERITY, { [f.file]: "does/not/exist.ts" }),
      ]),
      "json",
    );
    const listPath = scratchFile("lib/touched.ts\n");

    const r = runMain([payloadPath, listPath]);

    expect(r.code).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(r.out).toContain("ai-review findings outcome: BLOCKED");
    expect(r.out, "the scope state was not recorded on the run's output").toContain(
      AI_REVIEW_SCOPE_LINE,
    );
    expect(r.out, "the list was not read, so the second positional reached nothing").toContain(
      "MEASURED",
    );
    expect(r.err).toContain("::error");
    expect(r.err).toContain("does/not/exist.ts");
  });

  test("#1204 / AC-9b: an argument nobody parsed is UNMEASURED, not ignored", () => {
    // A silently dropped argument is the same fault as a silently skipped
    // check, and this guard did NOT survive the #1204/CRC-B7 merge on its
    // own: `parseFindingsArgv` carried it and was deleted with the flag CLI.
    // Measured on the merged tree before this was restored,
    // `main([payload, list, "extra"])` returned 0 and printed CLEAN.
    const payloadPath = scratchFile(payloadOf("PASS", []), "json");
    const listPath = scratchFile("lib/touched.ts\n");

    for (const argv of [
      [payloadPath, listPath, "a-third-positional"],
      [payloadPath, listPath, "--project-root", "/somewhere"],
    ]) {
      const r = runMain(argv);
      expect(r.code, `argv ${JSON.stringify(argv)} was accepted`).toBe(AI_REVIEW_REQUIRED_EXIT);
      expect(r.err).toContain("ARGUMENTS_UNREADABLE");
      expect(r.err, "the refusal does not name the argument nobody read").toContain(argv[2]);
    }

    // A flag in the SECOND position is read as a path, which refuses for a
    // different and also-true reason. Asserted so the two refusals are not
    // confused later: this one is a list that could not be read.
    const flagged = runMain([payloadPath, "--unknown-flag"]);
    expect(flagged.code).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(flagged.err).toContain("CHANGED_FILES_UNREADABLE");
    expect(flagged.err).toContain("--unknown-flag");

    // The controls for that repair: BOTH shipped invocations still work.
    expect(runMain([payloadPath]).code, "the one-argument form older consumers run").toBe(0);
    expect(runMain([payloadPath, listPath]).code, "the two-argument form #1356 deploys").toBe(0);
  });

  test("#1204 / AC-9c: the argv contract is spelled once", () => {
    // `argumentsBeyondTheContract` is the single binding AC-12's sibling
    // mutation would zero. A second site deciding the same thing would leave
    // one of them dead with nothing able to tell which.
    expect(argumentsBeyondTheContract([])).toEqual([]);
    expect(argumentsBeyondTheContract(["a"])).toEqual([]);
    expect(argumentsBeyondTheContract(["a", "b"])).toEqual([]);
    expect(argumentsBeyondTheContract(["a", "b", "c", "d"])).toEqual(["c", "d"]);
    // `process.argv.slice(2)` at the module's entry point is a DIFFERENT
    // slice — it strips the runtime and the script path — so the census
    // excludes it by name rather than by counting a substring that matches
    // both. It is also asserted to be present: a lookbehind that matched
    // nothing would make the count come out right for the wrong reason.
    expect(source).toContain("process.argv.slice(2)");
    expect(
      source.match(/(?<!process\.)argv\.slice\(2\)/g) ?? [],
      "the argv contract is spelled more than once, so zeroing one site proves nothing",
    ).toHaveLength(1);
  });

  test("#1204 / AC-10: the adjudicator never takes the diff itself", () => {
    // The input has to be read from the RESTORED tree, before the reviewer
    // could have written to the checkout. This module runs AFTER the review,
    // from the payload's own directory, so a diff computed here would be a
    // diff the subject of the review had an opportunity to edit. The only
    // honest shape is to be handed the list.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map(l => l.replace(/\/\/.*$/, ""))
      .join("\n");
    expect(code, "the comment stripper ate the file").toContain("export function main(");
    for (const spawner of ["spawnSync", "execSync", "execFileSync", "Bun.spawn", "child_process"]) {
      expect(code, `the adjudicator reaches for ${spawner} — it must be HANDED the list`).not.toContain(
        spawner,
      );
    }
  });

  test("#1204 / AC-11: a path spelled ./x and a path spelled x are the same file", () => {
    // Narrow on purpose. A leading `./` is the one divergence a `git diff
    // --name-only` list and an agent-written path reliably produce, and
    // equating anything wider — a basename, a suffix match — would demote the
    // wrong findings. A basename is NOT equated: it is a different claim, and
    // guessing is how a real finding gets demoted out of sight.
    const scope = scopeOver(["lib/touched.ts"]);
    const outcome = (file: string) =>
      readAiReviewFindings(payloadOf("BLOCK", [blockingFinding(BLOCKING_SEVERITY, { [f.file]: file })]), scope)
        .outcome;

    expect(outcome("lib/touched.ts")).toBe("BLOCKED");
    expect(outcome("./lib/touched.ts"), "a `./` prefix demoted a finding in the diff").toBe(
      "BLOCKED",
    );
    expect(outcome("touched.ts"), "a basename matched a path, which demotes by coincidence").toBe(
      "CLEAN",
    );
    expect(
      outcome("/abs/lib/touched.ts"),
      "an absolute path was equated with a repository-relative one",
    ).toBe("CLEAN");

    expect(scopeNotSupplied().status).toBe("NOT_SUPPLIED");
    expect(scopeNotSupplied().files, "a reading with no list carried one").toBeNull();
  });

  test("#1204 / AC-12: the check can fail — the binding, zeroed", async () => {
    // `.claude/rules/checks-must-be-able-to-fail.md`. One exported binding,
    // so the removal is PERFORMED: with the scope comparison unable to report
    // anything, the out-of-scope finding must adjudicate exactly as the
    // in-scope one does, which is the pre-CRC-B7 behaviour and the defect.
    const scope = scopeOver(["lib/touched.ts"]);
    const unlocatable = payloadOf("BLOCK", [
      blockingFinding(BLOCKING_SEVERITY, { [f.file]: "does/not/exist.ts" }),
    ]);
    const located = payloadOf("BLOCK", [blockingFinding(BLOCKING_SEVERITY)]);
    expect(readAiReviewFindings(unlocatable, scope).outcome).toBe("CLEAN");

    // Re-spelt against `findingPathScope`, which CRC-B7 made the ONE site
    // answering "does this finding name code the pull request touched". It
    // used to be an inline `!touched.has(named)` in `readPayload`'s blocking
    // branch; the tag needs the same answer, and two sites computing it
    // would be free to disagree about one finding. Zeroing it here therefore
    // removes the demotion AND the `Pre-existing` tag in one mutation, which
    // is the whole reason there is one binding to zero.
    const needle = 'touched.has(named) ? "IN_DIFF" : "PRE_EXISTING"';
    expect(
      source.split(needle).length - 1,
      "could not build the mutant: the scope decider is not spelled once",
    ).toBe(1);

    const path = join(SCRATCH, "mutant-ai-review-findings.ts");
    writeFileSync(
      path,
      source
        .replace(needle, '"IN_DIFF"')
        .replace(/from "\.\/ai-review-step"/g, `from "${STEP_PATH}"`),
    );
    const mutant = (await import(path)) as typeof import("../lib/scaffold/ai-review-findings");

    const mutantScope = mutant.readAiReviewChangedFiles(scratchFile("lib/touched.ts\n"));
    expect(
      mutantScope.status,
      "the mutant's own changed-file list did not read, so it witnesses nothing",
    ).toBe("MEASURED");
    expect(
      mutant.readAiReviewFindings(unlocatable, mutantScope).outcome,
      "zeroing the scope decider changed nothing, so the case witnesses nothing",
    ).toBe("BLOCKED");
    expect(
      mutant.readAiReviewFindings(located, mutantScope).outcome,
      "the mutant stopped blocking a located finding, so it is broken rather than mutated",
    ).toBe("BLOCKED");
  });
});

/**
 * #1357 — a blocking finding may cite a line that does not exist in the file
 * it names. #1298's instance: BLOCKED by a finding citing
 * `.claude/rules/specs-routing.md:39`. The pull request DID touch that file,
 * so #1204's bound (above) could not catch it.
 *
 * Decidable with no judgement about whether the finding is right: the file's
 * line count at the reviewed tree, taken by the changed-files step BEFORE the
 * reviewer runs (`test/ai-review-changed-files-step.test.ts` CF-10). Whether
 * the line SAYS what the finding claims is not decided here and must not be.
 *
 * The finding is DEMOTED on CRC-B7's terms — carried in `reported`, named in
 * `pastEndReported`, counted on the scope line — never dropped.
 */
describe("#1357: a blocking finding citing a line past the end of its file does not block", () => {
  const f = AI_REVIEW_FINDING_FIELDS;
  const CITED = ".claude/rules/specs-routing.md";
  const cites = (over: Record<string, unknown> = {}) =>
    blockingFinding(BLOCKING_SEVERITY, { [f.file]: CITED, [f.line]: 39, ...over });
  /** Line counts on disk, in the step's `<count><TAB><path>` rows, read by the real reader. */
  const countsOver = (rows: [string, number][]) =>
    readAiReviewLineCounts(scratchFile(rows.map(([p, n]) => `${n}\t${p}\n`).join(""), "tsv"));

  test("#1357 / L-1 control: :39 of a 40-line file adjudicates exactly as it does today", () => {
    const scope = scopeOver([CITED]);
    const counts = countsOver([[CITED, 40]]);
    expect(counts.status, "the control's own line counts did not read").toBe("MEASURED");

    const payload = payloadOf("BLOCK", [cites()]);
    const r = readAiReviewFindings(payload, scope, null, null, counts);
    expect(r.outcome).toBe("BLOCKED");
    expect(r.blockingReported).toHaveLength(1);
    expect(r.pastEndReported, "a line that exists was judged missing").toEqual([]);
    expect(aiReviewExitCode(r)).toBe(AI_REVIEW_REQUIRED_EXIT);
    // And the same verdict as a run with no counts at all: the reading only
    // ever subtracts, so a citation it can locate is untouched.
    expect(readAiReviewFindings(payload, scope).outcome).toBe(r.outcome);
  });

  test("#1357 / L-2 witness: the same finding against a 20-line file is carried, named, and does not block", () => {
    const scope = scopeOver([CITED]);
    const r = readAiReviewFindings(payloadOf("BLOCK", [cites()]), scope, null, null, countsOver([[CITED, 20]]));

    // CLEAN, not CONTRADICTION: the reviewer said BLOCK over a finding it
    // could not know was unlocatable, so the demotion counts toward the
    // verdict agreement the way CRC-B7's does.
    expect(r.outcome).toBe("CLEAN");
    expect(r.blocked).toBe(false);
    expect(aiReviewExitCode(r)).toBe(0);
    expect(r.reported, "the finding was dropped instead of demoted").toHaveLength(1);
    expect(r.blockingReported).toHaveLength(0);
    expect(r.pastEndReported, "the demotion was not recorded by name").toHaveLength(1);
    expect(r.unlocatableReported, "a past-end citation was filed as a file outside the diff").toEqual([]);
    const said = r.detail.join("\n");
    expect(said).toContain("line 39");
    expect(said).toContain("20 line");
    expect(aiReviewScopeLine(r)).toContain("past end of file: 1");
  });

  test("#1357 / L-3: a non-blocking finding is not subject, matching the line #1198 and #1204 drew", () => {
    const scope = scopeOver([CITED]);
    const counts = countsOver([[CITED, 20]]);
    for (const severity of ADVISORY_SEVERITIES) {
      const r = readAiReviewFindings(
        payloadOf("PASS", [blockingFinding(severity, { [f.file]: CITED, [f.line]: 39 })]),
        scope,
        null,
        null,
        counts,
      );
      expect(r.pastEndReported, `an advisory '${severity}' was counted as past the end`).toEqual([]);
      expect(r.outcome).toBe("CLEAN");
    }
    expect(ADVISORY_SEVERITIES.length, "the loop ran over nothing").toBeGreaterThan(0);
  });

  test("#1357 / L-4 control: counts nobody supplied leave the verdict where it is, and say so", () => {
    expect(readAiReviewLineCounts(undefined).status).toBe("NOT_SUPPLIED");
    expect(readAiReviewLineCounts("").status).toBe("NOT_SUPPLIED");
    const r = readAiReviewFindings(payloadOf("BLOCK", [cites()]), scopeOver([CITED]));
    expect(r.outcome).toBe("BLOCKED");
    expect(r.lineCounts.status).toBe("NOT_SUPPLIED");
    expect(
      r.pastEndReported,
      "a check that did not run reported an empty result — null and [] are different facts",
    ).toBeNull();
    expect(aiReviewScopeLine(r)).toContain("past end of file: not checked (line counts NOT_SUPPLIED)");
  });

  test("#1357 / L-5: counts that could not be taken REFUSE, and differ from counts that were taken", () => {
    const absent = readAiReviewLineCounts(join(SCRATCH, "nowhere", "counts.tsv"));
    const garbled = readAiReviewLineCounts(scratchFile(`40\t${CITED}\nforty\tlib/x.ts\n`, "tsv"));
    for (const counts of [absent, garbled]) {
      expect(counts.status).toBe("UNMEASURED");
      expect(counts.reason).toBe("LINE_COUNTS_UNREADABLE");
      const r = readAiReviewFindings(payloadOf("BLOCK", [cites()]), scopeOver([CITED]), null, null, counts);
      expect(r.outcome).toBe("UNMEASURED");
      expect(r.unmeasuredReasons).toEqual(["LINE_COUNTS_UNREADABLE"]);
      expect(r.blocked, "a withheld decision was defaulted").toBeNull();
      expect(r.pastEndReported, "counts nobody could read judged a line anyway").toBeNull();
      expect(r.reported, "the payload's findings were lost with the counts").toHaveLength(1);
      expect(aiReviewExitCode(r)).toBe(AI_REVIEW_REQUIRED_EXIT);
    }
    // TAKEN and empty is a reading: a pull request that only deletes files
    // has no file left to count. It judges nothing, so the finding blocks.
    const empty = readAiReviewLineCounts(scratchFile("", "tsv"));
    expect(empty.status).toBe("MEASURED");
    const r = readAiReviewFindings(payloadOf("BLOCK", [cites()]), scopeOver([CITED]), null, null, empty);
    expect(r.outcome).toBe("BLOCKED");
    expect(r.pastEndReported).toEqual([]);
  });

  test("#1357 / L-6: a file the counts do not name keeps blocking — no count is not a short file", () => {
    // The step writes no row for a path in neither the reviewed tree nor the
    // base. Reading that absence as zero lines would demote every finding
    // about such a path, the wrong direction for this stage.
    const r = readAiReviewFindings(
      payloadOf("BLOCK", [cites()]),
      scopeOver([CITED, "lib/other.ts"]),
      null,
      null,
      countsOver([["lib/other.ts", 1]]),
    );
    expect(r.outcome).toBe("BLOCKED");
    expect(r.pastEndReported).toEqual([]);
  });

  test("#1357 / L-7: a line given only as a `:N` suffix on the file is the line judged, and the one a thread anchors on", () => {
    const suffixed = cites({ [f.file]: `${CITED}:39`, [f.line]: "see the summary" });
    expect(findingCitedLine(suffixed)).toBe(39);
    expect(findingCitedLine(cites())).toBe(39);
    expect(findingCitedLine(cites({ [f.line]: "n/a" })), "a line nobody gave was invented").toBeNull();
    const scope = scopeOver([CITED]);
    expect(readAiReviewFindings(payloadOf("BLOCK", [suffixed]), scope, null, null, countsOver([[CITED, 20]])).outcome).toBe("CLEAN");
    expect(readAiReviewFindings(payloadOf("BLOCK", [suffixed]), scope, null, null, countsOver([[CITED, 40]])).outcome).toBe("BLOCKED");
    // A spelling difference is not a different file: `./x` counts as `x`.
    expect(citedLinePastEnd(cites({ [f.file]: `./${CITED}` }), new Map([[CITED.toLowerCase(), 20]]))).toEqual({ line: 39, count: 20 });
  });

  test("#1357 / L-8: main() takes the counts from its caller and prints how they were read", () => {
    const payloadPath = scratchFile(payloadOf("BLOCK", [cites()]), "json");
    const listPath = scratchFile(`${CITED}\n`);

    const short = runMain([payloadPath, listPath], countsOver([[CITED, 20]]));
    expect(short.code, short.err).toBe(0);
    expect(short.out).toContain("past end of file: 1");

    const unread = runMain([payloadPath, listPath], readAiReviewLineCounts(join(SCRATCH, "nowhere.tsv")));
    expect(unread.code).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(unread.err).toContain("LINE_COUNTS_UNREADABLE");
  });

  test("#1357 / L-9: the wrapper binds the counts from the environment, never as a third positional", () => {
    // AC-9b's refusal of argv[2] keeps its full width: a changed-file path
    // with a space, word-split in two, must not be read as a counts path.
    const wrapper = readFileSync(join(import.meta.dir, "..", "scripts", "ai-review-findings.ts"), "utf-8");
    expect(wrapper).toContain(`readAiReviewLineCounts(process.env[AI_REVIEW_LINE_COUNTS_PATH_VAR])`);
    expect(wrapper).toContain("process.exit(main(process.argv.slice(2), jury, suppress, citedLines, lineCounts));");
    expect(AI_REVIEW_LINE_COUNTS_PATH_VAR.length).toBeGreaterThan(0);
  });

  test("#1357 / L-10: the check can fail — the decider, zeroed", async () => {
    const needle = "line > count ? { line, count } : null";
    expect(source.split(needle).length - 1, "the past-end decider is not spelled once").toBe(1);
    // Its OWN directory: AC-12 imports a mutant from SCRATCH first, Bun caches
    // that directory's listing, and a second file written there afterwards is
    // "Cannot find module" — measured, in this suite.
    const path = join(mkdtempSync(join(SCRATCH, "lc-mutant-")), "mutant-ai-review-findings.ts");
    writeFileSync(
      path,
      source.replace(needle, "null").replace(/from "\.\/ai-review-step"/g, `from "${STEP_PATH}"`),
    );
    const mutant = (await import(path)) as typeof import("../lib/scaffold/ai-review-findings");
    const counts = mutant.readAiReviewLineCounts(scratchFile(`20\t${CITED}\n`, "tsv"));
    expect(counts.status, "the mutant's counts did not read, so it witnesses nothing").toBe("MEASURED");
    const scope = mutant.readAiReviewChangedFiles(scratchFile(`${CITED}\n`));
    expect(
      mutant.readAiReviewFindings(payloadOf("BLOCK", [cites()]), scope, null, null, counts).outcome,
      "zeroing the decider changed nothing, so L-2 witnesses nothing",
    ).toBe("BLOCKED");
  });
});

/**
 * #1887: the review restores `AI_REVIEW_UNTRUSTED_PATHS` from the base branch
 * before the reviewer runs, so a change under any of them is reviewed against
 * the base copy. That restore is correct and stays. What was wrong is the
 * silence: the verdict for a change the reviewer never saw read exactly like
 * one for a change it read in full. On #1882, three of four changed files
 * were never reviewed, and nothing in the output said so.
 *
 * Report only, as the issue scopes it: the overlap is printed, including an
 * explicit zero, and nothing new refuses.
 */
describe("#1887 / CRC-M17: the files restored from base are reported, not hidden", () => {
  test("the overlap is the changed files under a restored path, matched as git spells them", () => {
    const changed = [
      ".claude/rules/self-referential-tests.md",
      "REVIEW.md",
      "lib/scaffold/ai-review-findings.ts",
      // A PREFIX of a restored name is not under it.
      ".claudeX/notes.md",
      ".husky-not/pre-push",
      // git on a Linux runner restores `CLAUDE.md` byte for byte; a lowercase
      // `claude.md` is a different file and was NOT restored.
      "claude.md",
    ];
    expect(restoredFromBase(changed)).toEqual([".claude/rules/self-referential-tests.md", "REVIEW.md"]);
  });

  test("its population IS the restore list: every entry is caught, and the default is that list", () => {
    // One file under (or at) each restored path. If the reporter carried its
    // own copy of the list and it drifted from the restore step's, an entry
    // would go unreported here.
    const onePerEntry = AI_REVIEW_UNTRUSTED_PATHS.map(p => `${p}/inner-file`);
    expect(restoredFromBase(onePerEntry)).toEqual(onePerEntry);
    expect(restoredFromBase(AI_REVIEW_UNTRUSTED_PATHS)).toEqual([...AI_REVIEW_UNTRUSTED_PATHS]);
  });

  test("a non-empty overlap names the files and the count", () => {
    const line = restoredFromBaseLine(scopeMeasured([".claude/settings.json", "CLAUDE.md", "lib/a.ts"]));
    expect(line.startsWith(AI_REVIEW_RESTORED_LINE)).toBe(true);
    expect(line).toContain("2 of 3");
    expect(line).toContain('".claude/settings.json"');
    expect(line).toContain('"CLAUDE.md"');
    expect(line).not.toContain("lib/a.ts");
  });

  test("an empty overlap is an explicit zero, not a missing line", () => {
    const line = restoredFromBaseLine(scopeMeasured(["lib/a.ts", "test/a.test.ts"]));
    expect(line).toBe(`${AI_REVIEW_RESTORED_LINE} 0 of 2 changed files`);
  });

  test("an entry that cannot be classified is named, never counted as not restored", () => {
    // git C-quotes a non-ASCII name; this is how `.claude/réglages.md` arrives.
    const quoted = '".claude/r\\303\\251glages.md"';
    const line = restoredFromBaseLine(scopeMeasured([quoted]));
    expect(line, "an unreadable entry read as a clean zero").not.toBe(
      `${AI_REVIEW_RESTORED_LINE} 0 of 1 changed files`,
    );
    expect(line).toContain("could not be read");
    expect(line).toContain(JSON.stringify(quoted));
    // And beside a real overlap, both facts are reported.
    const mixed = restoredFromBaseLine(scopeMeasured(["CLAUDE.md", quoted, "lib/a.ts"]));
    expect(mixed).toContain("1 of 3");
    expect(mixed).toContain('"CLAUDE.md"');
    expect(mixed).toContain("could not be read");
  });

  test("with no changed-file list the overlap is UNMEASURED, not zero", () => {
    const line = restoredFromBaseLine(scopeNotSupplied());
    expect(line.startsWith(`${AI_REVIEW_RESTORED_LINE} UNMEASURED`)).toBe(true);
    expect(line).not.toContain(" 0 of ");
  });

  test("main() prints it on the run's output, after the scope line", () => {
    const payloadPath = scratchFile(payloadOf("PASS", []), "json");
    const listPath = scratchFile(".claude/settings.json\nlib/touched.ts\n");
    const r = runMain([payloadPath, listPath]);
    const lines = r.out.split("\n");
    const at = lines.findIndex(l => l.startsWith(AI_REVIEW_RESTORED_LINE));
    expect(at, `the restored-from-base line was not printed:\n${r.out}`).toBeGreaterThan(-1);
    expect(lines[at]).toContain("1 of 2");
    expect(lines[at]).toContain('".claude/settings.json"');
    expect(at, "it must come after the scope line").toBeGreaterThan(
      lines.findIndex(l => l.startsWith(AI_REVIEW_SCOPE_LINE)),
    );
  });
});
