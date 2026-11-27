/**
 * review-negative-control.test.ts — #1169.
 *
 * Two halves, and the second is the one that makes the first worth anything.
 *
 * The subjects must prove their own premise. A planted subject that does not
 * actually behave differently from its baseline is not a defect, and a clean
 * subject that does is not clean — in either case the control measures
 * nothing while reporting a number. So the behavioural difference is RUN here,
 * over a table of commands, rather than asserted in a manifest.
 *
 * And the control must be shown able to fail. A reviewer that returns CLEAN
 * unconditionally is exactly the failure #1169 says we cannot currently see,
 * so it is built — as a payload, which is all a reviewer is to this
 * instrument — and the planted subject is required to go red against it. The
 * second mutant blocks on a file nobody planted anything in, and both
 * subjects are required to go red: one for missing the plant, one for firing
 * on a clean diff.
 *
 * The cheapest wrong fix is named and measured rather than dismissed in
 * prose. It is "assert the payload is non-empty" — it is one line, it reads
 * as a detection check, and `the cheapest wrong fix is green over a payload
 * that found nothing` runs it against a payload that names the wrong file
 * entirely and watches it pass.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  AI_REVIEW_BLOCK_VERDICT,
  AI_REVIEW_FINDINGS_KEY,
  AI_REVIEW_FINDING_FIELDS,
  AI_REVIEW_PASS_VERDICT,
  AI_REVIEW_VERDICT_KEY,
  severityBlocks,
} from "../lib/scaffold/ai-review-findings";

import { AI_REVIEW_UNTRUSTED_PATHS } from "../lib/scaffold/ai-review-step";

import {
  REVIEW_CONTROL_SUBJECTS_DIR,
  UnreadableReviewPathReading,
  changedLines,
  cleanArmOutcome,
  findingOnChangedLine,
  loadReviewControlSubjects,
  readReviewControl,
  reviewPathViolations,
  summariseReviewControl,
  type ReviewControlSubject,
  type ReviewPathReading,
} from "../evals/ai-review-control/control";

import { isFullSuite as baseline } from "../evals/ai-review-control/subjects/suite-lock-redirect/baseline";
import { isFullSuite as planted } from "../evals/ai-review-control/subjects/suite-lock-redirect/planted";
import { isFullSuite as clean } from "../evals/ai-review-control/subjects/suite-lock-redirect/clean";
import { isFullSuite as cleanLoop } from "../evals/ai-review-control/subjects/suite-lock-redirect/clean-loop";

import {
  generatorTarget as wsBaseline,
  type RootReading,
} from "../evals/ai-review-control/subjects/worktree-state-write/baseline";
import { generatorTarget as wsPlanted } from "../evals/ai-review-control/subjects/worktree-state-write/planted";
import { generatorTarget as wsClean } from "../evals/ai-review-control/subjects/worktree-state-write/clean";

import {
  DEFAULT_ROUND_CAP,
  mayStartRound as sgStartBaseline,
  readRoundCap as sgCapBaseline,
  roundsLeftLabel as sgLabelBaseline,
} from "../evals/ai-review-control/subjects/symptom-guard/baseline";
import {
  mayStartRound as sgStartPlanted,
  readRoundCap as sgCapPlanted,
  roundsLeftLabel as sgLabelPlanted,
} from "../evals/ai-review-control/subjects/symptom-guard/planted";
import {
  mayStartRound as sgStartClean,
  readRoundCap as sgCapClean,
  roundsLeftLabel as sgLabelClean,
} from "../evals/ai-review-control/subjects/symptom-guard/clean";

/** A reviewer identifier, since a reading that names none is UNMEASURED. */
const REVIEWER = "tree@test";

const SUBJECTS = loadReviewControlSubjects(REVIEW_CONTROL_SUBJECTS_DIR);

/**
 * Throws rather than returning undefined. A helper that yields `undefined`
 * for a renamed subject turns every case below into a test of `undefined`,
 * and those pass in ways nobody reads.
 */
function subject(id: string): ReviewControlSubject {
  const found = SUBJECTS.find(s => s.id === id);
  if (found === undefined) {
    throw new Error(`no control subject ${id} — loaded: ${SUBJECTS.map(s => s.id).join(", ")}`);
  }
  return found;
}

const PLANTED = subject("suite-lock-redirect/planted");
const CLEAN = subject("suite-lock-redirect/clean");

/** Build a payload in the contract's own spelling, never a second one. */
function payload(findings: Record<string, unknown>[], verdict: string): string {
  return JSON.stringify({ [AI_REVIEW_FINDINGS_KEY]: findings, [AI_REVIEW_VERDICT_KEY]: verdict });
}

/** A finding that lands on the plant, unless a field is overridden. */
function onThePlant(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    severity: "high",
    file: PLANTED.file,
    line: PLANTED.lines?.[1],
    summary: "the redirect pattern no longer matches `&>`",
    failure_scenario: "`bun test &>/tmp/out` is read as a targeted run",
    ...over,
  };
}

/** The reviewer this issue is about: CLEAN on everything, always. */
const MUTANT_ALWAYS_CLEAN = payload([], AI_REVIEW_PASS_VERDICT);

/** The other direction: blocks, but on something nobody planted. */
const MUTANT_WRONG_FILE = payload(
  [onThePlant({ file: "lib/somewhere-else.ts", line: 1 })],
  AI_REVIEW_BLOCK_VERDICT,
);

/**
 * #1533. Blocks on the refactor itself: line 22 of the clean candidate is a
 * line it changed against its baseline, so this is a false positive about
 * the diff and the clean arm must score FIRED.
 */
const MUTANT_ON_THE_REFACTOR = payload(
  [onThePlant({ file: "lib/full-suite-command.ts", line: 22 })],
  AI_REVIEW_BLOCK_VERDICT,
);

/**
 * Commands chosen so the table separates the three candidates.
 *
 * `&>>log.txt` is in deliberately and is NOT expected to separate anything:
 * the planted pattern fails to match it, but the leftover token carries no
 * `/` and no test extension, so the operand scan reaches the same answer by
 * a different route. A fixture row that looks like it should diverge and
 * does not is worth keeping — it is the difference between measuring the
 * defect and measuring the regex.
 */
const COMMANDS = [
  "bun test",
  "bun test test/foo.test.ts",
  "bun test --bail",
  "bun test > /tmp/out",
  "bun test 2>/dev/null",
  "bun test 2>&1",
  "bun test &>/tmp/out",
  "bun test &>>/tmp/run.log",
  "bun test &>>log.txt",
  "bun run build",
];

function disagreements(a: (c: string) => boolean, b: (c: string) => boolean): string[] {
  return COMMANDS.filter(c => a(c) !== b(c));
}

describe("#1169: the control subjects prove their own premise", () => {
  test("the planted candidate really does behave differently from its baseline", () => {
    // Predicted before running: exactly 2 rows, both `&>` forms carrying a
    // path. Asserting the list and not just the count — a count agrees with
    // itself for the wrong reasons.
    expect(disagreements(baseline, planted)).toEqual([
      "bun test &>/tmp/out",
      "bun test &>>/tmp/run.log",
    ]);
  });

  test("and it fails in the permissive direction, which is what makes it a defect", () => {
    // The caller is a guard that refuses a full suite, so `false` lets the
    // run through. A planted defect that failed CLOSED would be an annoyance,
    // not a bug, and the failure scenario in the manifest would be false.
    expect(baseline("bun test &>/tmp/out")).toBe(true);
    expect(planted("bun test &>/tmp/out")).toBe(false);
  });

  test("the clean candidate changes no behaviour at all", () => {
    expect(disagreements(baseline, clean)).toEqual([]);
  });

  test("#1225: the second clean candidate changes no behaviour either", () => {
    // `clean-loop` rewrites the control flow rather than renaming — a `while`
    // with an explicit cursor, and an early return in place of the trailing
    // `some`. The lookahead arithmetic that consumes a bare `>`'s target is
    // the part most easily got wrong, and the `bun test > /tmp/out` row is
    // what separates a correct rewrite from a plausible one.
    expect(disagreements(baseline, cleanLoop)).toEqual([]);
  });

  test("#1225: and it really is a different candidate, not a copy of the first", () => {
    // Two clean subjects that are the same text are one clean subject, and a
    // control set of one is a sample. The counted thing is the source, not
    // the behaviour — the behaviour is identical on purpose.
    const first = readFileSync(CLEAN.candidatePath, "utf-8");
    const second = readFileSync(subject("suite-lock-redirect/clean-loop").candidatePath, "utf-8");
    expect(second).not.toBe(first);
  });

  test("the planted candidate is ONE line away from the baseline", () => {
    const a = readFileSync(PLANTED.baselinePath, "utf-8").split("\n");
    const b = readFileSync(PLANTED.candidatePath, "utf-8").split("\n");
    expect(b.length).toBe(a.length);
    expect(a.filter((line, i) => line !== b[i])).toHaveLength(1);
  });

  test("the declared line range actually contains the defect", () => {
    // Without this, an edit above the regex shifts it out of the range and
    // every future reading becomes MISSED for a reason that has nothing to
    // do with the reviewer.
    const lines = readFileSync(PLANTED.candidatePath, "utf-8").split("\n");
    const [from, to] = PLANTED.lines ?? [0, 0];
    expect(lines.slice(from - 1, to).join("\n")).toContain(PLANTED.marker ?? "\u0000");
  });

  test("#1225: the clean half is a set and not a sample", () => {
    // Anthropic's second instrument is "run the reviewer on PRs we know are
    // clean and count how often it reports something that would have led
    // someone to make a harmful change". One clean subject cannot carry a
    // rate: a single QUIET reading and a reviewer that is quiet about
    // everything are the same number.
    expect(SUBJECTS.filter(s => s.kind === "clean").length).toBeGreaterThanOrEqual(2);
  });

  test("the subjects dir yields one planted and one clean subject, at least", () => {
    expect(SUBJECTS.filter(s => s.kind === "planted").length).toBeGreaterThanOrEqual(1);
    expect(SUBJECTS.filter(s => s.kind === "clean").length).toBeGreaterThanOrEqual(1);
  });
});

/**
 * #1507 / CRC-A4 — the convention-break subject proves its own premise.
 *
 * This subject measures something `suite-lock-redirect` cannot: whether the
 * reviewer flags code that is wrong only because this repository says it is.
 * So the premise has two halves rather than one, and both are RUN:
 *
 *   1. the convention is really stated, in the file the reviewer is handed.
 *      A planted "convention break" against a convention nobody wrote down
 *      is an ordinary diff, and the subject would be measuring taste;
 *   2. `clean` differs from `planted` ONLY in that respect. Two candidates
 *      that differ in size, in shape, or in a second defect let a reviewer
 *      separate them without ever reading the convention, and the reading
 *      would be about diff shape instead.
 *
 * ## What was broken to prove it
 *
 * Counts and case lists predicted before the battery ran, baseline row read
 * first. Mutations applied by hand, reverted, and every file confirmed
 * byte-identical by SHA-256 afterwards — never by `git checkout --`. Over
 * this file alone.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 36 pass, 0 fail | **36 pass, 0 fail** | — |
 * | M1 the plant removed — `planted.ts`'s arm reverted to the baseline's | 3 | **3 of 36**, the three named | a linked worktree with a tracked generator: the plant returns `ok`, the mutant declines `not-repo-root` |
 * | M2 the DA-owned sentence deleted from `CLAUDE.md` | 1 | **1 of 36** | the repository's own `CLAUDE.md`: the convention case reads the sentence, the mutant reads a paraphrase that states no prohibition |
 * | M3 `clean.ts` given the plant too — its worktree arm falls through | 1 | **1 of 36** | the same worktree reading: `clean` declines, the mutant returns `ok`, so the pair stops isolating the convention |
 * | M4 a comment line added to `clean.ts` ABOVE the arm | 1 | **1 of 36** | the two candidate files: the heads are equal, the mutant's are one line apart |
 *
 * M1 is the row that matters, because the three cases it reds are three
 * different claims about the plant — that it grants something, that it
 * grants it relative to `clean` as well as to the baseline, and that the
 * declared line range still contains it. M4 is the one that keeps the pair
 * honest: without it `clean` could acquire a second difference and every
 * other case here would stay green.
 */
const WS_PLANTED = subject("worktree-state-write/planted");
const WS_CLEAN = subject("worktree-state-write/clean");

/** The sentence the plant contradicts, as CLAUDE.md spells it. */
const DA_OWNED_RULE =
  "`project-state.json`, `PROJECT-STATE.md` and `SUCCESS.md` are DA-owned: " +
  "an agent running in a worktree must never write them.";

/**
 * Readings chosen so the table separates the three candidates, and so the
 * rows that must NOT separate them are present too.
 *
 * `a linked worktree whose generator is untracked` is the second kind of row:
 * planted and clean reach different outcome STRINGS there and the same
 * permission, so it is in the table to stop the permission claim below being
 * read as "these two files disagree about worktrees in general".
 */
const ROOT_READINGS: { name: string; reading: RootReading }[] = [
  {
    name: "the main checkout",
    reading: { projectRoot: "/r", repoRoot: "/r", linkedWorktree: false, generatorTracked: true },
  },
  {
    name: "the main checkout, generator untracked",
    reading: { projectRoot: "/r", repoRoot: "/r", linkedWorktree: false, generatorTracked: false },
  },
  {
    name: "a directory in no repository",
    reading: { projectRoot: "/tmp/x", repoRoot: null, linkedWorktree: false, generatorTracked: false },
  },
  {
    name: "a subdirectory of the main checkout",
    reading: { projectRoot: "/r/lib", repoRoot: "/r", linkedWorktree: false, generatorTracked: true },
  },
  {
    name: "a linked worktree, generator tracked",
    reading: {
      projectRoot: "/r/.claude/worktrees/agent-a",
      repoRoot: "/r",
      linkedWorktree: true,
      generatorTracked: true,
    },
  },
  {
    name: "a linked worktree whose generator is untracked",
    reading: {
      projectRoot: "/r/.claude/worktrees/agent-b",
      repoRoot: "/r",
      linkedWorktree: true,
      generatorTracked: false,
    },
  },
];

type RootDecider = (r: RootReading) => { ok: boolean };

/** Rows where two candidates disagree about whether the generator may run. */
function permissionGap(a: RootDecider, b: RootDecider): string[] {
  return ROOT_READINGS.filter(r => a(r.reading).ok !== b(r.reading).ok).map(r => r.name);
}

/**
 * The arm is the region the two candidates are allowed to differ in. Located
 * by the lines that open and close it rather than by an offset, so an edit
 * anywhere else in the file moves the region with it instead of silently
 * sliding the claim off its subject.
 */
const ARM_OPENS = "  if (r.repoRoot !== r.projectRoot) {";
const ARM_CLOSES = '  if (!r.generatorTracked) return decline("declined-untracked-generator");';

function outsideTheArm(path: string): { head: string[]; tail: string[] } {
  const lines = readFileSync(path, "utf-8").split("\n");
  const opens = lines.indexOf(ARM_OPENS);
  const closes = lines.indexOf(ARM_CLOSES);
  // Both anchors must be found, and in order. A missing anchor gives `-1`,
  // and `slice(0, -1)` is a perfectly ordinary-looking array — so a candidate
  // that had been rewritten past recognition would compare two prefixes of
  // nothing and agree. That is the vacuous pass this whole file is about.
  expect(opens, `${path} does not open the arm`).toBeGreaterThan(-1);
  expect(closes, `${path} does not close the arm`).toBeGreaterThan(opens);
  return { head: lines.slice(0, opens + 1), tail: lines.slice(closes) };
}

describe("#1507 / CRC-A4: the convention-break subject proves its own premise", () => {
  test("the convention the plant breaks is really stated in CLAUDE.md", () => {
    // Read from the repository root, not from the manifest. A subject that
    // quoted its own convention would be asserting a string against a copy of
    // itself, and the plant would stay a "convention break" on the day the
    // convention was deleted.
    const claudeMd = readFileSync(join(import.meta.dir, "..", "CLAUDE.md"), "utf-8");
    expect(claudeMd.replace(/\s+/g, " ")).toContain(DA_OWNED_RULE);
  });

  test("CLAUDE.md is restored from the pull request base before the reviewer reads it", () => {
    // Without this the subject measures nothing durable: a branch could
    // legalise its own plant by editing the convention it is scored against,
    // and a reviewer reading the head's CLAUDE.md would be right to stay
    // quiet.
    //
    // This is a PREMISE reference and not the witness, which is the
    // distinction `ai-review-security-repairs.test.ts` draws at the same
    // constant: membership restates the change, and that file runs the
    // generated restore step and reads the resulting tree. What belongs
    // here is the one fact this subject's reading depends on — drop the
    // name from the set and this subject stops measuring a convention and
    // starts measuring whatever the branch last wrote.
    expect([...AI_REVIEW_UNTRUSTED_PATHS]).toContain("CLAUDE.md");
  });

  test("the planted candidate lets a worktree write what CLAUDE.md forbids", () => {
    // Predicted before running: exactly one row, and it is the row the
    // convention is about. Asserting the list and not the count — a count
    // agrees with itself for the wrong reasons.
    expect(permissionGap(wsBaseline, wsPlanted)).toEqual(["a linked worktree, generator tracked"]);

    // And in the permissive direction, which is what makes it the defect
    // rather than a stricter guard. A plant that REFUSED something the
    // baseline allowed would be an annoyance and the manifest's failure
    // scenario would be false.
    const worktree = ROOT_READINGS.find(r => r.name === "a linked worktree, generator tracked")!;
    expect(wsBaseline(worktree.reading).ok).toBe(false);
    expect(wsPlanted(worktree.reading).ok).toBe(true);
  });

  test("the clean candidate grants nothing the baseline did not", () => {
    expect(permissionGap(wsBaseline, wsClean)).toEqual([]);
    expect(permissionGap(wsClean, wsPlanted)).toEqual(["a linked worktree, generator tracked"]);
  });

  test("the clean candidate is not a no-op, so it is a diff and not a copy", () => {
    // A clean subject byte-identical to its baseline stages an empty diff,
    // and a reviewer is QUIET on an empty diff for a reason that has nothing
    // to do with precision. `clean` renames the worktree refusal; the
    // permission is untouched, which is the previous case.
    const worktree = ROOT_READINGS.find(r => r.name === "a linked worktree, generator tracked")!;
    const before = wsBaseline(worktree.reading) as { outcome: string };
    const after = wsClean(worktree.reading) as { outcome: string };
    expect(after.outcome).not.toBe(before.outcome);
    expect(readFileSync(WS_CLEAN.candidatePath, "utf-8"))
      .not.toBe(readFileSync(WS_CLEAN.baselinePath, "utf-8"));
  });

  test("planted and clean differ ONLY inside the arm the convention is about", () => {
    // The premise of the whole subject. If they differed anywhere else, a
    // reviewer could separate them on something that is not the convention
    // and the reading would be about that instead.
    const p = outsideTheArm(WS_PLANTED.candidatePath);
    const c = outsideTheArm(WS_CLEAN.candidatePath);
    const b = outsideTheArm(WS_PLANTED.baselinePath);

    expect(c.head).toEqual(p.head);
    expect(c.tail).toEqual(p.tail);
    // Against the baseline too: a shared edit outside the arm would be a
    // second thing in both diffs, which is a second thing a reviewer can
    // fire on and neither subject declares.
    expect(b.head).toEqual(p.head);
    expect(b.tail).toEqual(p.tail);

    // And the head really is most of the file, so the two assertions above
    // are not comparing two two-line prefixes.
    expect(p.head.length).toBeGreaterThan(30);
  });

  test("the declared line range actually contains the plant", () => {
    // Same reason as suite-lock-redirect's: an edit above the arm shifts it
    // out of the declared range and every future reading becomes MISSED for
    // a reason that has nothing to do with the reviewer.
    const lines = readFileSync(WS_PLANTED.candidatePath, "utf-8").split("\n");
    const [from, to] = WS_PLANTED.lines ?? [0, 0];
    expect(lines.slice(from - 1, to).join("\n")).toContain(WS_PLANTED.marker ?? "\u0000");
    // The operative line — the one the whole subject is — must be in range,
    // not merely the comment above it.
    expect(lines.slice(from - 1, to).join("\n")).toContain('if (!r.linkedWorktree) return decline(');
  });

  test("the subject set now carries more than one planted subject", () => {
    // One plant is a sample. Two plants of different KINDS — a behavioural
    // defect and a convention break — are the smallest set that can say
    // which kind a reviewer is blind to. #2928 adds a third kind: a diff that
    // treats a symptom and leaves its cause.
    expect(SUBJECTS.filter(s => s.kind === "planted").map(s => s.id)).toEqual([
      "suite-lock-redirect/planted",
      "symptom-guard/planted",
      "worktree-state-write/planted",
    ]);
  });
});

describe("#1169: the control reads a working reviewer as working", () => {
  test("a finding on the plant is DETECTED, and a quiet clean subject is QUIET", () => {
    const hit = readReviewControl(PLANTED, payload([onThePlant()], AI_REVIEW_BLOCK_VERDICT), REVIEWER);
    const quiet = readReviewControl(CLEAN, MUTANT_ALWAYS_CLEAN, REVIEWER);

    expect(hit.outcome).toBe("DETECTED");
    expect(quiet.outcome).toBe("QUIET");

    const run = summariseReviewControl([hit, quiet]);
    expect(run.passed).toBe(true);
    expect(run.recall).toBe(1);
    expect(run.precision).toBe(1);
  });

  test("a finding anywhere in the declared range counts, not only on the nose", () => {
    const [from] = PLANTED.lines ?? [0, 0];
    const r = readReviewControl(PLANTED, payload([onThePlant({ line: from })], AI_REVIEW_BLOCK_VERDICT), REVIEWER);
    expect(r.outcome).toBe("DETECTED");
  });

  test("advisory findings on a clean subject are counted and are not a failure", () => {
    const r = readReviewControl(
      CLEAN,
      payload([onThePlant({ severity: "low", file: CLEAN.file })], AI_REVIEW_PASS_VERDICT),
      REVIEWER,
    );
    expect(r.outcome).toBe("QUIET");
    expect(r.advisoryCount).toBe(1);
    expect(r.passed).toBe(true);
  });
});

describe("#1169: the control can fail — the mutant reviewers", () => {
  test("a reviewer that returns CLEAN unconditionally makes the planted subject RED", () => {
    // THE proof. This is the reviewer #1169 says is indistinguishable from a
    // working one today. Predicted before running: 1 red reading of 2.
    const missed = readReviewControl(PLANTED, MUTANT_ALWAYS_CLEAN, REVIEWER);
    const quiet = readReviewControl(CLEAN, MUTANT_ALWAYS_CLEAN, REVIEWER);

    expect(missed.outcome).toBe("MISSED");
    expect(missed.passed).toBe(false);
    expect(quiet.outcome).toBe("QUIET");

    const run = summariseReviewControl([missed, quiet]);
    expect(run.readings.filter(r => !r.passed)).toHaveLength(1);
    expect(run.passed).toBe(false);
    expect(run.recall).toBe(0);
    // Not 1. A reviewer that wrote no blocking finding has undefined
    // precision, and a withheld ratio must not read as a perfect one.
    expect(run.precision).toBeNull();
  });

  test("a reviewer that blocks on an unplanted file is MISSED on the plant, and pre-existing on the clean arm", () => {
    // #1533 changed the clean half of this row. A block on a file the clean
    // candidate does not change is not about the diff, so it is named as
    // pre-existing and does not score FIRED — the attribution CRC-B7 gives
    // the deployed adjudicator. The run is still red, on the planted arm.
    const missed = readReviewControl(PLANTED, MUTANT_WRONG_FILE, REVIEWER);
    const clean = readReviewControl(CLEAN, MUTANT_WRONG_FILE, REVIEWER);

    expect(missed.outcome).toBe("MISSED");
    expect(clean.outcome).toBe("QUIET");
    expect(clean.preExistingBlocking).toBe(1);
    // Named as another file, not as an unchanged line of the subject's own.
    expect(clean.detail.join("\n")).toContain("a file the candidate does not change");
    expect(clean.detail.join("\n")).not.toContain("not on a line the candidate changed");

    const run = summariseReviewControl([missed, clean]);
    expect(run.passed).toBe(false);
  });

  test("#1533: a reviewer that blocks on the refactor itself makes the clean subject RED", () => {
    // The clean arm's own failure, kept reachable: a block on a line the
    // candidate changed is a false positive about the diff.
    const fired = readReviewControl(CLEAN, MUTANT_ON_THE_REFACTOR, REVIEWER);
    expect(fired.outcome).toBe("FIRED");
    expect(fired.passed).toBe(false);
    expect(fired.preExistingBlocking).toBe(0);
    const run = summariseReviewControl([readReviewControl(PLANTED, payload([onThePlant()], AI_REVIEW_BLOCK_VERDICT), REVIEWER), fired]);
    // One true positive on the plant, one false positive on the refactor.
    expect(run.precision).toBe(0.5);
  });

  test("the cheapest wrong fix is green over a payload that found nothing", () => {
    // Named and measured, not dismissed. "The reviewer wrote some findings"
    // is one line, reads as a detection check, and cannot tell a reviewer
    // that located the defect from one that blocked an unrelated file.
    const cheapest = (raw: string) =>
      (JSON.parse(raw)[AI_REVIEW_FINDINGS_KEY] as unknown[]).length > 0;

    expect(cheapest(MUTANT_WRONG_FILE)).toBe(true);
    expect(readReviewControl(PLANTED, MUTANT_WRONG_FILE, REVIEWER).outcome).toBe("MISSED");
  });

  test("the right file at the wrong line is MISSED, and the near miss is named", () => {
    const [from] = PLANTED.lines ?? [0, 0];
    const r = readReviewControl(
      PLANTED,
      payload([onThePlant({ line: from + 40 })], AI_REVIEW_BLOCK_VERDICT),
      REVIEWER,
    );
    expect(r.outcome).toBe("MISSED");
    expect(r.detail.join("\n")).toContain("near miss");
  });

  test("the right line called advisory is MISSED — it stopped nothing", () => {
    const r = readReviewControl(
      PLANTED,
      payload([onThePlant({ severity: "low" })], AI_REVIEW_PASS_VERDICT),
      REVIEWER,
    );
    expect(r.outcome).toBe("MISSED");
    expect(r.detail.join("\n")).toContain("must block");
  });
});

/**
 * #1533 — the clean arm is scored on the lines the candidate changed.
 *
 * #1524's two readings of `suite-lock-redirect/clean` came back FIRED on
 * `high` at line 19, a line byte-identical in `baseline.ts`: a TRUE defect in
 * the compacted copy, on no line the refactor touched. A compacted copy always
 * carries such defects, so whole-file scoring left the arm one reachable
 * outcome. Scoped to changed lines, a finding elsewhere is named pre-existing
 * and does not score. Rejected: a clean candidate with nothing true to say
 * about it, which would stop being a compacted copy of anything.
 */
describe("#1533: the clean arm scores FIRED only on a line the candidate changed", () => {
  const READINGS = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "evals", "ai-review-control", "baselines", "review-control-readings.json"), "utf-8"),
  );
  const banked = (Object.values(READINGS.thirdReadings.cases) as any[]).find(c => c.subject === "suite-lock-redirect/clean");

  test("the changed lines are the ones the banked diff recorded", () => {
    expect(banked, "the banked third readings no longer carry the clean case").toBeDefined();
    expect(CLEAN.changedLines).toEqual(banked.changedLinesInTheDiff);
    expect(changedLines("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual([2, 4]);
    expect(changedLines("same\n", "same\n")).toEqual([]);
    // Computed for a clean arm only; a planted arm scores on its range.
    expect(PLANTED.changedLines).toBeNull();
    const huge = "x\n".repeat(2100);
    expect(() => changedLines(huge, huge), "a pair past the bound was tabulated").toThrow("bound");
  });

  test("#1524's two FIRED draws re-score QUIET: their blocking finding is on no changed line", () => {
    expect(banked.draws).toHaveLength(2);
    for (const draw of banked.draws) {
      expect(draw.scoreOutcome, "the banked draw is not the FIRED reading this re-scores").toBe("FIRED");
      // `onAChangedLine` was banked by #1532 on 2026-10-24, before
      // `changedLines` existed, so this compares the decider with an
      // independent record rather than with its own output (review of #2450).
      for (const f of draw.findings) {
        expect(findingOnChangedLine(CLEAN, f), `the banked onAChangedLine for line ${f.line} disagrees`).toBe(f.onAChangedLine);
      }
      const blocking = draw.findings.filter((f: Record<string, unknown>) => severityBlocks(f.severity));
      expect(blocking.length, "the draw carries no blocking finding, so it re-scores nothing").toBeGreaterThan(0);
      expect(cleanArmOutcome(CLEAN, blocking), "a finding on an unchanged line still scored FIRED").toBe("QUIET");
    }
  });

  test("every banked reading, re-scored under the rule, gives the totals the README states", () => {
    // Derived, not typed: the README's sentence is checked against this count.
    const totals: Record<string, number> = { DETECTED: 0, QUIET: 0, FIRED: 0, UNMEASURED: 0 };
    for (const k of ["cases", "secondReadings", "thirdReadings"]) {
      const block = READINGS[k];
      const cases = (Array.isArray(block) ? block : (block.cases ?? block)) as Record<string, any>;
      for (const c of Object.values(cases)) {
        if (!c || typeof c.subject !== "string") continue;
        const s = subject(c.subject);
        for (const draw of c.draws) {
          const scored = String(draw.scoreOutcome);
          const blocking = ((draw.findings ?? []) as Record<string, unknown>[]).filter(f => severityBlocks(f.severity));
          const re = s.kind === "clean" && (scored === "FIRED" || scored === "QUIET") ? cleanArmOutcome(s, blocking) : scored;
          totals[re] = (totals[re] ?? 0) + 1;
        }
      }
    }
    expect(totals).toEqual({ DETECTED: 4, QUIET: 4, FIRED: 0, UNMEASURED: 7 });
    const readme = readFileSync(join(import.meta.dir, "..", "evals", "ai-review-control", "README.md"), "utf-8");
    expect(readme.replace(/\s+/g, " ")).toContain(
      `\`DETECTED\` ×${totals.DETECTED}, \`QUIET\` ×${totals.QUIET}, \`FIRED\` ×${totals.FIRED}, \`UNMEASURED\` ×${totals.UNMEASURED}`,
    );
  });

  test("a blocking finding on an unchanged line is QUIET and named pre-existing", () => {
    const r = readReviewControl(CLEAN, payload([onThePlant({ file: CLEAN.file, line: 19 })], AI_REVIEW_BLOCK_VERDICT), REVIEWER);
    expect(r.outcome).toBe("QUIET");
    expect(r.preExistingBlocking).toBe(1);
    expect(r.detail.join("\n")).toContain("not on a line the candidate changed");
  });

  // Review of #2450, round 5: the reading excused the finding and the run's
  // precision still counted it, with no plant hit to match. Both halves of
  // the pair: a pre-existing finding is in neither half of the ratio, and a
  // FIRED one stays in it — so excluding every clean-arm finding, the
  // cheapest repair, is red on the second assertion.
  test("a pre-existing finding is in neither half of the run's precision; a FIRED one stays in it", () => {
    const detected = readReviewControl(PLANTED, payload([onThePlant()], AI_REVIEW_BLOCK_VERDICT), REVIEWER);
    const preExisting = readReviewControl(CLEAN, payload([onThePlant({ file: CLEAN.file, line: 19 })], AI_REVIEW_BLOCK_VERDICT), REVIEWER);
    expect([detected.outcome, preExisting.outcome]).toEqual(["DETECTED", "QUIET"]);
    const run = summariseReviewControl([detected, preExisting]);
    expect(run.passed).toBe(true);
    expect(run.precision, "a finding the reading declared not scored dragged the run's precision down").toBe(1);
    const fired = readReviewControl(CLEAN, MUTANT_ON_THE_REFACTOR, REVIEWER);
    expect(fired.outcome).toBe("FIRED");
    expect(summariseReviewControl([detected, fired]).precision).toBe(0.5);
    // Only pre-existing findings written anywhere but the plant: nothing was
    // scored against a hit, and the ratio is still the planted arm's alone.
    expect(summariseReviewControl([preExisting]).precision, "no scored finding, so no ratio").toBeNull();
  });

  test("a blocking finding on the subject file that names no line is FIRED — unattributable is not pre-existing", () => {
    const r = readReviewControl(CLEAN, payload([onThePlant({ file: CLEAN.file, line: "n/a" })], AI_REVIEW_BLOCK_VERDICT), REVIEWER);
    expect(r.outcome).toBe("FIRED");
    // Review of #2450: a line that is not in the candidate is as unusable.
    const last = CLEAN.candidateLineCount!;
    for (const line of [0, -3, last + 1]) {
      const out = readReviewControl(CLEAN, payload([onThePlant({ file: CLEAN.file, line })], AI_REVIEW_BLOCK_VERDICT), REVIEWER);
      expect(out.outcome, `line ${line} of a ${last}-line candidate was excused as pre-existing`).toBe("FIRED");
    }
    // And the last real line is a real line: unchanged there is still QUIET.
    expect(CLEAN.changedLines).not.toContain(last);
    const atLast = readReviewControl(CLEAN, payload([onThePlant({ file: CLEAN.file, line: last })], AI_REVIEW_BLOCK_VERDICT), REVIEWER);
    expect(atLast.outcome).toBe("QUIET");
  });

  test("#1533: the decider's case set, every row of its docblock table", () => {
    // Review of #2450, round 4: the cases were added one round at a time.
    // They are listed once here, row for row with `findingOnChangedLine`'s
    // docblock, so a missing row is a red case rather than a next round.
    const last = CLEAN.candidateLineCount!;
    const changed = CLEAN.changedLines![0]!;
    const unchanged = 19;
    expect(CLEAN.changedLines).not.toContain(unchanged);
    const rows: [string, Record<string, unknown>, ReviewControlSubject, boolean][] = [
      ["another file", { file: "lib/elsewhere.ts", line: changed }, CLEAN, false],
      ["subject file, line not a number", { file: CLEAN.file, line: "n/a" }, CLEAN, true],
      ["subject file, non-integer line", { file: CLEAN.file, line: changed + 0.5 }, CLEAN, true],
      ["subject file, line 0", { file: CLEAN.file, line: 0 }, CLEAN, true],
      ["subject file, line past the end", { file: CLEAN.file, line: last + 1 }, CLEAN, true],
      ["subject file, unchanged line", { file: CLEAN.file, line: unchanged }, CLEAN, false],
      ["subject file, changed line", { file: CLEAN.file, line: changed }, CLEAN, true],
      ["planted arm, any line", { file: PLANTED.file, line: 1 }, PLANTED, true],
      // Review of #2450, round 6: the first row's "either" — another file on
      // a subject with no computed lines is still not about the diff.
      ["planted arm, another file", { file: "lib/elsewhere.ts", line: 1 }, PLANTED, false],
    ];
    for (const [label, finding, s, want] of rows) {
      expect(findingOnChangedLine(s, finding), label).toBe(want);
    }
    // And the docblock lists exactly as many rows as this table holds.
    const source = readFileSync(join(import.meta.dir, "..", "evals", "ai-review-control", "control.ts"), "utf-8");
    const block = source.slice(source.indexOf("#1533's one decider"), source.indexOf("export function findingOnChangedLine"));
    // Seven rows; the test holds eight inputs because the first row's
    // "either" is held on both kinds of subject.
    expect(block.split("\n").filter(l => /^\s*\* \| (another|subject's) /.test(l))).toHaveLength(7);
  });

  test("the scope can fail: with the decider answering every line, line 19 FIRES again", async () => {
    const source = readFileSync(join(import.meta.dir, "..", "evals", "ai-review-control", "control.ts"), "utf-8");
    const needle = "return subject.changedLines.includes(line);";
    expect(source.split(needle).length - 1, "the changed-line decider is not spelled once").toBe(1);
    const dir = mkdtempSync(join(tmpdir(), "control-1533-mutant-"));
    try {
      const lib = join(import.meta.dir, "..", "lib");
      const path = join(dir, "control.ts");
      writeFileSync(
        path,
        source.replace(needle, "return true;").replace(/from "\.\.\/\.\.\/lib\//g, `from "${lib}/`),
      );
      const mutant = (await import(path)) as typeof import("../evals/ai-review-control/control");
      const subjects = mutant.loadReviewControlSubjects(REVIEW_CONTROL_SUBJECTS_DIR);
      const mClean = subjects.find(s => s.id === CLEAN.id)!;
      const at19 = payload([onThePlant({ file: CLEAN.file, line: 19 })], AI_REVIEW_BLOCK_VERDICT);
      expect(mutant.readReviewControl(mClean, at19, REVIEWER).outcome, "the mutant changed nothing").toBe("FIRED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#1169: UNMEASURED is a distinct outcome from CLEAN, and it fails", () => {
  test("a reviewer that wrote no payload at all is UNMEASURED, not QUIET", () => {
    // The #1180 shape: ai-review passed a real PR in 14 seconds having
    // written nothing. Against a CLEAN subject, where "found nothing" would
    // otherwise be the right answer — which is exactly why it has to differ.
    const r = readReviewControl(CLEAN, null, REVIEWER);
    expect(r.outcome).toBe("UNMEASURED");
    expect(r.passed).toBe(false);
    expect(r.payloadReasons).toContain("FINDINGS_FILE_ABSENT");
  });

  test("an unreadable payload carries the reader's own reasons, not a re-derived one", () => {
    const r = readReviewControl(PLANTED, "{not json", REVIEWER);
    expect(r.outcome).toBe("UNMEASURED");
    expect(r.payloadReasons).toEqual(["FINDINGS_UNPARSEABLE"]);
  });

  test("a payload with no findings key is UNMEASURED, not an empty review", () => {
    const r = readReviewControl(CLEAN, JSON.stringify({ [AI_REVIEW_VERDICT_KEY]: "PASS" }), REVIEWER);
    expect(r.outcome).toBe("UNMEASURED");
    expect(r.payloadReasons).toContain("FINDINGS_KEY_ABSENT");
  });

  test("a reading that cannot name its reviewer is UNMEASURED, perfect payload or not", () => {
    // The acceptance criterion made able to fail. CI adjudicates with a
    // pinned published package while the tree runs ahead of it, so an
    // unattributed number is a number about nothing.
    const r = readReviewControl(PLANTED, payload([onThePlant()], AI_REVIEW_BLOCK_VERDICT), "  ");
    expect(r.outcome).toBe("UNMEASURED");
    expect(r.unmeasuredReasons).toEqual(["REVIEWER_UNIDENTIFIED"]);
    expect(r.reviewer).toBeNull();
  });

  test("an UNMEASURED reading fails the run rather than being skipped over", () => {
    const run = summariseReviewControl([
      readReviewControl(PLANTED, payload([onThePlant()], AI_REVIEW_BLOCK_VERDICT), REVIEWER),
      readReviewControl(CLEAN, null, REVIEWER),
    ]);
    expect(run.unmeasured).toBe(1);
    expect(run.passed).toBe(false);
    // And it is not counted as coverage: the clean half was never measured.
    expect(run.cleanMeasured).toBe(0);
  });
});

describe("#1169: a run that measured nothing is not a pass", () => {
  test("an empty run is red", () => {
    const run = summariseReviewControl([]);
    expect(run.passed).toBe(false);
    expect(run.detail.join("\n")).toContain("0 planted and 0 clean");
  });

  test("a run with no clean subject is red even when every plant was found", () => {
    // The half the source post says most teams skip. Dropping it leaves a
    // recall eval that a reviewer blocking everything scores perfectly on.
    const run = summariseReviewControl([
      readReviewControl(PLANTED, payload([onThePlant()], AI_REVIEW_BLOCK_VERDICT), REVIEWER),
    ]);
    expect(run.detected).toBe(1);
    expect(run.missed).toBe(0);
    expect(run.fired).toBe(0);
    expect(run.passed).toBe(false);
  });

  test("a run with no planted subject is red even when nothing fired", () => {
    const run = summariseReviewControl([readReviewControl(CLEAN, MUTANT_ALWAYS_CLEAN, REVIEWER)]);
    expect(run.quiet).toBe(1);
    expect(run.passed).toBe(false);
    expect(run.recall).toBeNull();
  });
});

describe("#1169: a contradictory payload is scored, not discarded", () => {
  test("BLOCK over findings that do not block is counted and still readable", () => {
    // #1178's shape, at roughly a third of runs. Refusing to score it would
    // blind the instrument over exactly the band it most needs to watch, so
    // the findings are read and the contradiction is reported beside them.
    const r = readReviewControl(
      CLEAN,
      payload([onThePlant({ severity: "low", file: CLEAN.file })], AI_REVIEW_BLOCK_VERDICT),
      REVIEWER,
    );
    expect(r.payloadOutcome).toBe("CONTRADICTION");
    expect(r.outcome).toBe("QUIET");

    const run = summariseReviewControl([
      r,
      readReviewControl(PLANTED, payload([onThePlant()], AI_REVIEW_BLOCK_VERDICT), REVIEWER),
    ]);
    expect(run.contradictions).toBe(1);
  });
});

describe("#1225: the harmful-change count, and why it is UNMEASURED here", () => {
  test("the findings contract carries no applicable remedy, so no remedy can be run", () => {
    // Anthropic's clean-PR instrument counts findings "that would have led
    // someone to make a harmful change". Deriving that mechanically needs a
    // remedy you can APPLY: write the suggestion over the clean candidate,
    // re-run the command table, and count the rows that flip. The reading is
    // then the diff's, not a judgement about tone.
    //
    // `AI_REVIEW_FINDING_FIELDS` has no such field. A finding carries a
    // severity, a file, a line, a summary and a failure scenario — all prose
    // except the location. So the harmful-change count is UNMEASURED here,
    // and `FIRED` (a blocking finding on code proved behaviour-identical to
    // its baseline) is the strongest thing the payload can support. Saying
    // the number is unmeasured is the honest version; printing a zero would
    // be a sweep whose detector is blind, reported as a clean result.
    //
    // This is a tripwire, not a decoration. The day the contract grows a
    // remedy field this goes red, and the fix is to build the counter rather
    // than to widen the list.
    //
    // It is deliberately wider than the thing it detects: it fires on ANY new
    // member, so somebody has to judge each one. `population` (#1651) was
    // judged on 2026-11-03 and is NOT a remedy. It says how many instances of
    // a finding's shape exist; there is nothing in it to write over the clean
    // candidate and re-run, so it moves the harmful-change count from
    // UNMEASURED to UNMEASURED. The judgement is recorded here rather than in
    // a widened predicate, because a predicate that decides "is this a remedy"
    // is a second guess at the same question and would pass this one silently.
    //
    // `populationSearch` (#1883) was judged on 2026-11-18 and is NOT a remedy
    // either: it is the literal text the reviewer searched the cited file for,
    // so the population can be counted rather than declared. It changes nothing
    // in the candidate, so there is still nothing to run.
    expect(Object.keys(AI_REVIEW_FINDING_FIELDS).sort()).toEqual([
      "failureScenario",
      "file",
      "line",
      "population",
      "populationSearch",
      "severity",
      "summary",
    ]);
  });

  test("and FIRED is measured over more than one clean subject, so it can be a rate", () => {
    const quiet = readReviewControl(CLEAN, payload([], AI_REVIEW_PASS_VERDICT), REVIEWER);
    // #1533: on the subject's own file and a line clean-loop changed. This
    // fixture used to name `lib/test-suite-lock.ts`, the path from before
    // #1513 moved the subject, which scoped scoring reads as another file.
    const loop = subject("suite-lock-redirect/clean-loop");
    expect(loop.changedLines?.length ?? 0, "clean-loop changed nothing, so it is not a refactor").toBeGreaterThan(0);
    const fired = readReviewControl(
      loop,
      payload([onThePlant({ file: loop.file, line: loop.changedLines![0] })], AI_REVIEW_BLOCK_VERDICT),
      REVIEWER,
    );
    const run = summariseReviewControl([
      quiet,
      fired,
      readReviewControl(PLANTED, payload([onThePlant()], AI_REVIEW_BLOCK_VERDICT), REVIEWER),
    ]);

    expect(run.cleanMeasured).toBe(2);
    expect(run.fired).toBe(1);
    expect(run.quiet).toBe(1);
    expect(run.passed).toBe(false);
  });
});

/**
 * #1513: a reviewPath has to be stageable, and both live ones were not.
 *
 * #1509 took the first readings and hit two blockers with one root: a subject
 * is a compacted, self-contained copy, so it is by construction a worse file
 * than the live module whose path it borrowed. The cost came back in two
 * different shapes and the control could see neither.
 *
 * The readings below are taken from THIS repository and handed to one
 * exported predicate. Keeping the reading outside the predicate is what makes
 * the planted cases possible: a repository where `lib/project-state-root.ts`
 * is live and one where nothing is differ only in the argument.
 */
const REPO_ROOT = join(import.meta.dir, "..");

/** Every `.md` under `specs/`, repo-relative. */
function specDocuments(dir: string, prefix = "specs"): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...specDocuments(join(dir, entry.name), `${prefix}/${entry.name}`));
    } else if (entry.name.endsWith(".md")) {
      found.push(`${prefix}/${entry.name}`);
    }
  }
  return found.sort();
}

/**
 * The patterns `REVIEW.md`'s *Do not flag* list names, cut by heading rather
 * than by a character count — the region a claim is about ends where the
 * section ends (`.claude/rules/self-referential-tests.md`).
 *
 * A backticked token with no `/` is a whole file (`CODE-MAP.md`) and cannot be
 * a directory a subject sits under, so it is not a pattern. `lib/scaffold/*.ts`
 * is excluded in REVIEW.md only for the LENGTH of its comment blocks rather
 * than wholesale; treating it as a full exclusion errs toward refusing a
 * reviewPath, which is the direction that costs an unticked box rather than a
 * bad reading.
 */
function doNotFlagPatterns(reviewDoc: string): string[] {
  const section = reviewDoc.split(/^## /m).find(part => part.startsWith("Do not flag"));
  if (section === undefined) return [];
  return [...section.matchAll(/`([^`]+)`/g)].map(m => m[1]).filter(p => p.includes("/"));
}

/** The reading this repository produces for a set of candidate paths. */
function repositoryReading(paths: readonly string[]): ReviewPathReading {
  const namedBySpecs: Record<string, string[]> = {};
  for (const path of paths) namedBySpecs[path] = [];
  for (const spec of specDocuments(join(REPO_ROOT, "specs"))) {
    const text = readFileSync(join(REPO_ROOT, spec), "utf-8");
    for (const path of paths) if (text.includes(path)) namedBySpecs[path].push(spec);
  }
  return {
    resolvesInTree: paths.filter(path => existsSync(join(REPO_ROOT, path))),
    namedBySpecs,
    notFlagged: doNotFlagPatterns(readFileSync(join(REPO_ROOT, "REVIEW.md"), "utf-8")),
  };
}

const SUBJECT_PATHS = [...new Set(SUBJECTS.map(s => s.file))];

describe("#1513: a reviewPath must be stageable, and the check must say why not", () => {
  test("AC-1: the exclusion list really was read, so a clean result is not a failed read", () => {
    // The control for every exclusion case below. Zero patterns match
    // nothing, so a parse that silently found none would certify every
    // reviewPath — and it would look exactly like a tree with nothing to
    // exclude.
    const patterns = doNotFlagPatterns(readFileSync(join(REPO_ROOT, "REVIEW.md"), "utf-8"));
    expect(patterns).toContain("evals/**/subjects/**");
    expect(patterns.length).toBeGreaterThan(1);
  });

  test("AC-1: an empty exclusion list is a refusal, not agreement", () => {
    expect(() =>
      reviewPathViolations(SUBJECTS, { resolvesInTree: [], namedBySpecs: {}, notFlagged: [] }),
    ).toThrow(UnreadableReviewPathReading);
  });

  test("AC-2: every subject in the tree stages at a path this repository can carry", () => {
    expect(reviewPathViolations(SUBJECTS, repositoryReading(SUBJECT_PATHS))).toEqual([]);
  });

  test("AC-2: and that is not vacuous — three distinct paths were read, all under lib/", () => {
    expect(SUBJECT_PATHS.length).toBe(3);
    expect(SUBJECT_PATHS.filter(path => path.startsWith("lib/"))).toEqual(SUBJECT_PATHS);
  });

  test("#1513 instance 1: a live module's path is refused, naming the confound", () => {
    // `lib/project-state-root.ts`, where all four of #1509's draws carried a
    // true `critical` about the compacted stub breaking its callers.
    const live = "lib/project-state-root.ts";
    expect(existsSync(join(REPO_ROOT, live))).toBe(true);

    const violations = reviewPathViolations([{ ...SUBJECTS[0], file: live }], {
      ...repositoryReading([live]),
      namedBySpecs: {},
    });
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("is a live module");
    expect(violations[0]).toContain("FIRED");
  });

  test("#1513 instance 2: a path the specs assert the contents of is refused", () => {
    // `lib/test-suite-lock.ts` — SC-648, SC-649, SC-759, SC-760, SC-625.
    // Measured on this tree: 5 of 1410 conformity cases red with the subject
    // staged there, 0 of 1410 with it absent.
    const asserted = "lib/test-suite-lock.ts";
    const reading = repositoryReading([asserted]);
    expect(reading.namedBySpecs[asserted].length).toBeGreaterThan(0);

    const violations = reviewPathViolations([{ ...SUBJECTS[0], file: asserted }], {
      ...reading,
      resolvesInTree: [],
    });
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("spec file(s)");
    expect(violations[0]).toContain("N = 0");
  });

  test("the subjects' own directory is refused — a reading there measures the exclusion", () => {
    // Named in #1513 as a thing NOT to do: leaving the subject where it
    // lives, or widening REVIEW.md's list to cover a new path, both turn
    // recall into a measurement of exclusion-obedience.
    const inside = "evals/ai-review-control/subjects/worktree-state-write/planted.ts";
    const violations = reviewPathViolations([{ ...SUBJECTS[0], file: inside }], {
      ...repositoryReading([inside]),
      resolvesInTree: [],
      namedBySpecs: {},
    });
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("evals/**/subjects/**");
  });

  test("two subject directories sharing one reviewPath is refused", () => {
    const shared = "lib/unoccupied.ts";
    const violations = reviewPathViolations(
      [
        { ...SUBJECTS[0], id: "alpha/planted", file: shared },
        { ...SUBJECTS[1], id: "beta/clean", file: shared },
      ],
      { ...repositoryReading([shared]), resolvesInTree: [] },
    );
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("both stage at");
  });

  test("…while several cases of ONE subject at one path is the normal shape", () => {
    const shared = "lib/unoccupied.ts";
    const violations = reviewPathViolations(
      [
        { ...SUBJECTS[0], id: "alpha/planted", file: shared },
        { ...SUBJECTS[1], id: "alpha/clean", file: shared },
        { ...SUBJECTS[1], id: "alpha/clean-loop", file: shared },
      ],
      { ...repositoryReading([shared]), resolvesInTree: [] },
    );
    expect(violations).toEqual([]);
  });
});

// #2928: the subject behind the root-cause instruction in REVIEW.md. A diff
// that treats a symptom is a different shape from a one-file defect: both
// candidates make the reported symptom stop, and only where the fix sits
// tells them apart. Every premise below is run over a table, as the other
// subjects' are, and each has a mutation row in the PR that adds it.
const SG_PLANTED = subject("symptom-guard/planted");
const SG_CLEAN = subject("symptom-guard/clean");
const SG_CAPS: (string | undefined)[] = [undefined, "3", "5", "0", "", "three", "  "];
const SG_UNREADABLE: (string | undefined)[] = ["", "three", "  "];
const SG_USED = [0, 1, 2, 3, 4];
const SG_ROWS = SG_CAPS.flatMap(raw => SG_USED.map(used => ({ raw, used })));

describe("#2928: the symptom-guard subject proves its own premise", () => {
  test("the planted candidate stops the reported symptom, and only on an unreadable cap", () => {
    const differs = SG_ROWS.filter(r => sgStartPlanted(r.raw, r.used) !== sgStartBaseline(r.raw, r.used));
    expect(differs.length).toBeGreaterThan(0);
    expect([...new Set(differs.map(r => r.raw))].sort()).toEqual([...SG_UNREADABLE].sort());
  });

  test("both candidates agree at the caller the report is about", () => {
    for (const r of SG_ROWS) expect(sgStartClean(r.raw, r.used), JSON.stringify(r)).toBe(sgStartPlanted(r.raw, r.used));
  });

  test("the planted candidate leaves the producer wrong, and the second caller still reaches it", () => {
    for (const raw of SG_CAPS) expect(Object.is(sgCapPlanted(raw), sgCapBaseline(raw)), String(raw)).toBe(true);
    for (const r of SG_ROWS) expect(sgLabelPlanted(r.raw, r.used)).toBe(sgLabelBaseline(r.raw, r.used));
    for (const raw of SG_UNREADABLE) expect(sgLabelPlanted(raw, 0)).toContain("NaN");
  });

  test("the clean candidate fixes the producer, so neither caller sees NaN", () => {
    for (const raw of SG_UNREADABLE) expect(sgCapClean(raw)).toBe(DEFAULT_ROUND_CAP);
    for (const r of SG_ROWS) expect(sgLabelClean(r.raw, r.used), JSON.stringify(r)).not.toContain("NaN");
    for (const raw of SG_CAPS.filter(c => !SG_UNREADABLE.includes(c))) expect(sgCapClean(raw)).toBe(sgCapBaseline(raw));
  });

  test("the two candidates change as many lines, the planted one in the caller and the clean one in the producer", () => {
    const base = readFileSync(SG_PLANTED.baselinePath, "utf-8");
    const plantedText = readFileSync(SG_PLANTED.candidatePath, "utf-8");
    const cleanText = readFileSync(SG_CLEAN.candidatePath, "utf-8");
    const p = changedLines(base, plantedText);
    const c = changedLines(base, cleanText);
    expect(p.length).toBeGreaterThan(0);
    expect(c.length).toBe(p.length);
    const inFunction = (text: string, name: string, line: number) => {
      const lines = text.split("\n");
      const start = lines.findIndex(l => l.includes(`function ${name}(`));
      const end = lines.findIndex((l, i) => i > start && l === "}");
      return start >= 0 && line > start + 1 && line <= end + 1;
    };
    for (const line of p) expect(inFunction(plantedText, "mayStartRound", line), `planted line ${line}`).toBe(true);
    for (const line of c) expect(inFunction(cleanText, "readRoundCap", line), `clean line ${line}`).toBe(true);
  });

  test("the declared range holds the producer and the guard, and its marker", () => {
    const lines = readFileSync(SG_PLANTED.candidatePath, "utf-8").split("\n");
    const [a, b] = SG_PLANTED.lines!;
    const range = lines.slice(a - 1, b).join("\n");
    expect(range).toContain(SG_PLANTED.marker!);
    expect(range).toContain(`function ${SG_PLANTED.cause}(`);
    for (const line of changedLines(readFileSync(SG_PLANTED.baselinePath, "utf-8"), lines.join("\n"))) {
      expect(line >= a && line <= b, `changed line ${line}`).toBe(true);
    }
  });

  test("nothing in a candidate says which one it is", () => {
    for (const s of [SG_PLANTED, SG_CLEAN]) {
      expect(readFileSync(s.candidatePath, "utf-8")).not.toMatch(/plant|defect|symptom|\bbug\b/i);
    }
  });
});

describe("#2928: a planted case that declares a cause is DETECTED only when a finding names it", () => {
  const GUARD_LINE = 17;
  const PRODUCER_LINE = 11;
  const sgFinding = (summary: string, over: Record<string, unknown> = {}) => ({
    severity: "high",
    file: SG_PLANTED.file,
    line: GUARD_LINE,
    summary,
    failure_scenario: 'a cap of "three" lets rounds start again, and the comment still prints "NaN rounds left"',
    ...over,
  });
  const read = (findings: Record<string, unknown>[]) =>
    readReviewControl(SG_PLANTED, payload(findings, AI_REVIEW_BLOCK_VERDICT), REVIEWER);

  test("the subject declares its cause and the other caller the cause still reaches", () => {
    expect(SG_PLANTED.cause).toBe("readRoundCap");
    expect(SG_PLANTED.reachedBy).toBe("roundsLeftLabel");
    expect(SG_CLEAN.cause).toBeNull();
    expect(SG_CLEAN.reachedBy).toBeNull();
  });

  test("a blocking finding on the guard that names the producer is DETECTED", () => {
    const r = read([sgFinding("the guard masks NaN from readRoundCap, which roundsLeftLabel still reads")]);
    expect(r.outcome).toBe("DETECTED");
    expect(r.plantHits).toBe(1);
  });

  test("the same finding without the producer's name is MISSED, and the reading says the cause was not named", () => {
    const r = read([sgFinding("this guard hides an unreadable cap instead of fixing it", { failure_scenario: "rounds start again" })]);
    expect(r.outcome).toBe("MISSED");
    expect(r.plantHits).toBe(0);
    expect(r.detail.join("\n")).toContain("readRoundCap");
    expect(r.detail.join("\n")).toContain("names no cause");
  });

  test("the name counts in the failure scenario as well as in the summary", () => {
    const r = read([sgFinding("the guard hides an unreadable cap", { failure_scenario: "readRoundCap still returns NaN to roundsLeftLabel" })]);
    expect(r.outcome).toBe("DETECTED");
  });

  test("a finding on the producer's own line that names it is DETECTED", () => {
    expect(read([sgFinding("readRoundCap returns NaN for text it cannot parse, and roundsLeftLabel still prints it", { line: PRODUCER_LINE })]).outcome).toBe("DETECTED");
  });

  test("a longer identifier that only contains the name does not count", () => {
    for (const name of ["readRoundCaps", "readRoundCapValue", "_readRoundCap"]) {
      expect(read([sgFinding(`the guard masks NaN from ${name}, which roundsLeftLabel still reads`)]).outcome, name).toBe("MISSED");
    }
  });

  // Review round 1 of #2929: a finding can name the producer only to clear it.
  // REVIEW.md asks for the producer AND whether another caller still reaches
  // it, so both names are required; a finding that clears the producer rarely
  // names the second caller. The residual case, both named and the producer
  // still cleared, scores DETECTED, and the reading quotes the finding.
  test("a finding that names the producer only to clear it is MISSED, and the reading names what it left out", () => {
    const r = read([sgFinding("the guard in mayStartRound masks NaN; readRoundCap itself is correct and needs no change", { failure_scenario: "rounds start again" })]);
    expect(r.outcome).toBe("MISSED");
    expect(r.detail.join("\n")).toContain("names no cause");
    expect(r.detail.join("\n")).toContain("roundsLeftLabel");
  });

  test("naming the other caller without the producer is MISSED too", () => {
    expect(read([sgFinding("roundsLeftLabel still prints NaN after this change", { failure_scenario: "the comment reads NaN rounds left" })]).outcome).toBe("MISSED");
  });

  test("the two names may sit in different fields", () => {
    expect(read([sgFinding("the guard leaves readRoundCap returning NaN", { failure_scenario: "roundsLeftLabel prints NaN rounds left" })]).outcome).toBe("DETECTED");
  });

  // Review round 1 of #2929: a finding on the plant that names no cause is a
  // miss for recall, but it is still a finding about the plant, so it is not a
  // false positive in the run's precision.
  test("an on-plant finding that names no cause is MISSED for recall and still counts toward precision", () => {
    const r = read([sgFinding("this guard hides an unreadable cap instead of fixing it", { failure_scenario: "rounds start again" })]);
    expect(r.outcome).toBe("MISSED");
    expect(r.plantHits).toBe(0);
    expect(r.onPlant).toBe(1);
    const quiet = readReviewControl(SG_CLEAN, payload([], AI_REVIEW_PASS_VERDICT), REVIEWER);
    const run = summariseReviewControl([r, quiet]);
    expect(run.recall).toBe(0);
    expect(run.precision).toBe(1);
  });

  test("a case that declares no cause scores as before", () => {
    expect(PLANTED.cause).toBeNull();
    expect(PLANTED.reachedBy).toBeNull();
    expect(readReviewControl(PLANTED, payload([onThePlant()], AI_REVIEW_BLOCK_VERDICT), REVIEWER).outcome).toBe("DETECTED");
  });

  test("the loader refuses a cause on a clean case, and a cause that is not a name", () => {
    const manifest = (c: Record<string, unknown>) => {
      const dir = mkdtempSync(join(tmpdir(), "rg-2928-cause-"));
      const sub = join(dir, "s");
      require("fs").mkdirSync(sub);
      writeFileSync(join(sub, "baseline.ts"), "export const a = 1;\n");
      writeFileSync(join(sub, "candidate.ts"), "export const a = 2;\n");
      writeFileSync(join(sub, "subject.json"), JSON.stringify({ reviewPath: "lib/x.ts", baseline: "baseline.ts", cases: [{ id: "s/c", candidate: "candidate.ts", ...c }] }));
      return dir;
    };
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ kind: "clean", cause: "a" }, /clean case s\/c declares a cause/],
      [{ kind: "planted", lines: [1, 1], cause: 7 }, /cause/],
      [{ kind: "planted", lines: [1, 1], cause: "" }, /cause/],
      [{ kind: "planted", lines: [1, 1], cause: "two words" }, /cause/],
      [{ kind: "planted", lines: [1, 1], reachedBy: "b" }, /reachedBy without a cause/],
      [{ kind: "planted", lines: [1, 1], cause: "a", reachedBy: "two words" }, /reachedBy/],
      [{ kind: "clean", reachedBy: "b" }, /clean case s\/c declares a reachedBy/],
    ];
    for (const [c, why] of cases) {
      const dir = manifest(c);
      try {
        expect(() => loadReviewControlSubjects(dir), JSON.stringify(c)).toThrow(why);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const ok = manifest({ kind: "planted", lines: [1, 1], cause: "a" });
    try {
      expect(loadReviewControlSubjects(ok)[0]!.cause).toBe("a");
    } finally {
      rmSync(ok, { recursive: true, force: true });
    }
  });
});
