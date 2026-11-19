/**
 * ai-review-control/control.ts — the instrument that tells a reviewer which is
 * working from one that has gone quiet (#1169).
 *
 * ## Why it lives here and not in `lib/`
 *
 * `lib/` ships. `evals/` does not, and this module reads its subjects off
 * disk, so putting it in `lib/` would be a published file reaching a path
 * absent from `package.json`'s `files[]` — the property `CLOSURE-8` exists to
 * refuse. That check looks for `join(import.meta.dir, "..")`, so a root passed
 * in as a parameter would have slipped past it while breaking exactly what it
 * guards: a detector narrower than what it detects, exploited on purpose.
 * Living beside its own subjects costs nothing and raises no such question.
 *
 * ## The gap this closes
 *
 * `.claude/rules/checks-must-be-able-to-fail.md` says a check is worth what
 * it fails on, and says it about gates. The ai-review reviewer is a check,
 * and the rule had never been pointed at it. Three readings from 2026-10-22
 * are what makes that concrete rather than tidy:
 *
 * - `ai-review` passed a real pull request in 14 seconds having written no
 *   findings payload at all (#1180).
 * - Its verdict is non-deterministic at roughly a third of runs (#1178,
 *   #1186) — 6 of the last 20 runs by one count, 5 of 18 concluded runs by
 *   another; overlapping windows, same order of magnitude.
 * - Of seven findings relayed from live reviews, six were real and all six
 *   were latent. The only live defect found that session came from a corpus
 *   sweep, not from a reviewer.
 *
 * A reviewer returning CLEAN on everything satisfies all three observations
 * exactly as well as one that works. Nothing in the repo could tell them
 * apart, so "the reviewer is fine" and "the reviewer is dead" were the same
 * sentence.
 *
 * ## What it measures, and what it refuses to measure
 *
 * Two subjects, one difference. A PLANTED subject carries a known defect at
 * a declared file and line range; a CLEAN subject is a behaviour-preserving
 * change to the same baseline. The reviewer is run against each and the
 * payload it writes is scored HERE, from the declared answer — never from
 * the reviewer's own account of how it did.
 *
 * - A plant the reviewer blocks on, at the declared location → `DETECTED`.
 * - A plant it does not → `MISSED`. Recall, measured.
 * - A clean subject it leaves alone → `QUIET`.
 * - A clean subject it blocks → `FIRED`. Precision, measured.
 *
 * ## Precision, not recall — and this inverts the source post
 *
 * The Anthropic code-review post states its own priority: catching real bugs
 * first, cutting review rounds second. That is right when a human absorbs the
 * noise, because a person waves off a nit in seconds. Nobody waves anything
 * off in this swarm. A false blocking finding costs a remedy commit, a CI
 * round, a review round and an agent's whole context, and on 2026-10-22 two
 * suggested remedies were worse than the state they corrected. So `FIRED`
 * and `MISSED` are failures of equal weight here, both numbers are reported,
 * and nothing in this module optimises for recall.
 *
 * ADVISORY findings on a clean subject are counted and never fatal. They are
 * the cheap tail; the line that costs something is the blocking one, and
 * `AI_REVIEW_SEVERITIES` already declares which severities cross it. Using
 * that table rather than a second opinion about severity is deliberate — two
 * deciders answering the same question are behaviourally one decider, and no
 * behavioural test can tell them apart.
 *
 * ## Why UNMEASURED is not CLEAN, here as everywhere
 *
 * `0`, `{}`, `null` and `SKIP` are indistinguishable from success and
 * UNMEASURED is not (`.claude/rules/config-access.md`). The doctrine applies
 * to the control itself, so a control reading that could not be taken FAILS
 * and never skips: `passed` is a plain `false` under UNMEASURED, not a
 * `null` some caller defaults to green.
 *
 * Two states reach it. A payload this module cannot read, carried through
 * from `readAiReviewFindings` with its own reasons intact rather than
 * re-derived. And a reading that does not name the reviewer it measured —
 * #1169's own acceptance criterion, and a real hazard, because CI adjudicates
 * with `bunx rungate@0.8.0` (`.github/workflows/ai-review.yml:1062`, pinned
 * deliberately per #1013) while the tree runs ahead of it. A reading that
 * cannot say which of those it watched is a number about nothing.
 *
 * ## Why an empty run is not a pass
 *
 * `summariseReviewControl([])` is `passed: false`. Zero failures over zero
 * subjects is the third shape in the failure rule — an assertion that holds
 * vacuously — and it is the shape this instrument would decay into first,
 * quietly, the day a subject stops loading. A run must have measured at
 * least one plant AND at least one clean subject before it is allowed to be
 * green.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

import {
  AI_REVIEW_FINDING_FIELDS,
  readAiReviewFindings,
  renderFinding,
  severityBlocks,
  type AiReviewOutcome,
  type AiReviewUnmeasuredReason,
} from "../../lib/scaffold/ai-review-findings";

/** Where the subjects live, named once, relative to this module. */
export const REVIEW_CONTROL_SUBJECTS_DIR = join(import.meta.dir, "subjects");

/** A subject either carries a known defect or is known not to. */
export type ReviewControlKind = "planted" | "clean";

/**
 * The five states a control reading can be in. Exactly one is reached.
 *
 * `QUIET` and `DETECTED` are the only two that pass. `UNMEASURED` is a
 * distinct outcome from `QUIET` on purpose: "the reviewer found nothing" and
 * "nobody can say what the reviewer found" are different facts, and the whole
 * issue is that today they print the same.
 */
export type ReviewControlOutcome = "DETECTED" | "MISSED" | "QUIET" | "FIRED" | "UNMEASURED";

/** Why a control reading is UNMEASURED. Each is a different fix. */
export type ReviewControlUnmeasuredReason =
  | "REVIEWER_UNIDENTIFIED"
  | "PAYLOAD_UNMEASURED";

export interface ReviewControlSubject {
  /** `<subject-dir>/<case>`, e.g. `suite-lock-redirect/planted`. */
  id: string;
  kind: ReviewControlKind;
  /**
   * The repo-relative path the candidate is staged to. A finding's `file`
   * must equal this exactly — a reviewer that cannot name the file it is
   * reading has not located anything.
   */
  file: string;
  /** Inclusive, 1-based, in the candidate as staged. `null` when clean. */
  lines: readonly [number, number] | null;
  /** Text the declared range must contain, so the range cannot rot silently. */
  marker: string | null;
  /** Absolute path of the candidate — the post-change file under review. */
  candidatePath: string;
  /** Absolute path of the baseline — the committed pre-change file. */
  baselinePath: string;
  /**
   * #1533. 1-based lines of the candidate that differ from the baseline —
   * what the diff a reviewer is handed actually changed. A clean arm scores
   * FIRED only on these. `null` on a planted arm, which scores on its
   * declared range and never reads this (review of #2450).
   */
  changedLines: readonly number[] | null;
  /**
   * #1533. How many lines the candidate has, so a cited line outside
   * 1..this is unattributable rather than "unchanged". `null` on a planted
   * arm, with `changedLines`.
   */
  candidateLineCount: number | null;
  /** The defect, or why this subject is clean. */
  note: string;
}

export interface ReviewControlReading {
  subject: string;
  kind: ReviewControlKind;
  outcome: ReviewControlOutcome;
  /** Red or green, never null. UNMEASURED is red. */
  passed: boolean;
  /** The reviewer this reading is about. `null` only when UNMEASURED. */
  reviewer: string | null;
  /** Blocking findings in the payload, or `null` when it could not be read. */
  blockingCount: number | null;
  /** Non-blocking findings — noise, reported, never fatal. */
  advisoryCount: number | null;
  /** Blocking findings that landed on this subject's declared plant. */
  plantHits: number;
  /**
   * #1533. Clean arm only: blocking findings on no line the candidate
   * changed — named in `detail`, never scored. `null` on a planted arm and
   * on an UNMEASURED reading, where the question was not asked.
   */
  preExistingBlocking: number | null;
  /** The payload's own outcome, carried rather than restated. */
  payloadOutcome: AiReviewOutcome | null;
  unmeasuredReasons: ReviewControlUnmeasuredReason[];
  /** The payload reader's reasons, intact. Empty unless PAYLOAD_UNMEASURED. */
  payloadReasons: AiReviewUnmeasuredReason[];
  /** Sentences from the producing code — never re-derived by a caller. */
  detail: string[];
}

export interface ReviewControlSummary {
  readings: ReviewControlReading[];
  /** Planted subjects whose reading was taken at all. */
  plantedMeasured: number;
  /** Clean subjects whose reading was taken at all. */
  cleanMeasured: number;
  detected: number;
  missed: number;
  quiet: number;
  fired: number;
  unmeasured: number;
  /** Payloads whose verdict word disagreed with their own findings (#1178). */
  contradictions: number;
  /** Non-blocking findings across every measured subject. */
  advisory: number;
  /**
   * Blocking findings that landed on a declared plant, over every blocking
   * finding scored — a clean-arm finding on no line the candidate changed is
   * pre-existing and in neither half (#1533). `null` when none was scored — an
   * undefined ratio is withheld, because a reviewer that says nothing is not
   * perfectly precise.
   */
  precision: number | null;
  /** Plants detected over plants measured. `null` when none was measured. */
  recall: number | null;
  passed: boolean;
  detail: string[];
}

function unmeasuredReading(
  subject: ReviewControlSubject,
  reviewer: string | null,
  reasons: ReviewControlUnmeasuredReason[],
  payloadReasons: AiReviewUnmeasuredReason[],
  detail: string[],
): ReviewControlReading {
  return {
    subject: subject.id,
    kind: subject.kind,
    outcome: "UNMEASURED",
    passed: false,
    reviewer,
    blockingCount: null,
    advisoryCount: null,
    plantHits: 0,
    preExistingBlocking: null,
    payloadOutcome: null,
    unmeasuredReasons: reasons,
    payloadReasons,
    detail,
  };
}

/** #1533. The largest baseline × candidate line product `changedLines` will tabulate. */
export const CHANGED_LINES_MAX_CELLS = 4_000_000;

/**
 * #1533. The 1-based lines of `candidate` outside a longest common
 * subsequence with `baseline`: the lines it changed or added. Line-level
 * LCS, so a moved block reads as changed — the direction that keeps a
 * finding scored rather than excused.
 */
export function changedLines(baseline: string, candidate: string): number[] {
  const a = baseline.split("\n");
  const b = candidate.split("\n");
  const n = a.length;
  const m = b.length;
  // The table is n × m cells. Subjects are compacted copies of a few hundred
  // lines; a pair past this bound is not one, and refusing it by name beats
  // allocating it in silence on every load (review of #2450).
  if (n * m > CHANGED_LINES_MAX_CELLS) {
    throw new Error(
      `changedLines: ${n} × ${m} lines is past the ${CHANGED_LINES_MAX_CELLS}-cell bound; ` +
        `a control subject is a compacted copy, not a whole module`,
    );
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const kept = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      kept.add(j);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  const out: number[] = [];
  for (let k = 0; k < m; k++) if (!kept.has(k)) out.push(k + 1);
  return out;
}

/**
 * #1533's one decider: does this finding land on a line the candidate
 * changed? The direction it is allowed to be wrong in is toward FIRED, which
 * a reader then argues with. **The whole case set**, over the three inputs
 * the answer reads, enumerated once and held row for row by the
 * `#1533: the decider's case set` test. The rows partition the inputs: each
 * finding matches exactly one, in the order the code tests them.
 *
 * | file      | `line`                              | changed lines computed | answer |
 * |-----------|-------------------------------------|------------------------|--------|
 * | another   | anything                            | either | false — not about the diff |
 * | subject's | not a number                        | either | true — unattributable |
 * | subject's | a non-integer number                | either | true — unattributable |
 * | subject's | an integer                          | no     | true — a planted arm is never excused |
 * | subject's | an integer < 1 or past the last line| yes    | true — unattributable |
 * | subject's | in range, a line it did not change  | yes    | false — pre-existing |
 * | subject's | in range, a line it changed         | yes    | true |
 */
export function findingOnChangedLine(
  subject: ReviewControlSubject,
  finding: Record<string, unknown>,
): boolean {
  const f = AI_REVIEW_FINDING_FIELDS;
  if (finding[f.file] !== subject.file) return false;
  const line = finding[f.line];
  if (typeof line !== "number" || !Number.isInteger(line)) return true;
  // A subject whose changed lines were not computed — a planted arm — cannot
  // excuse a finding as pre-existing; it is read toward FIRED.
  if (subject.changedLines === null || subject.candidateLineCount === null) return true;
  // A line that is not in the candidate — 0, negative, past its end — is as
  // unusable as no line at all, so it is unattributable, not unchanged
  // (review of #2450).
  if (line < 1 || line > subject.candidateLineCount) return true;
  return subject.changedLines.includes(line);
}

/** A clean arm's outcome over its blocking findings: FIRED only on a changed line. */
export function cleanArmOutcome(
  subject: ReviewControlSubject,
  blocking: readonly Record<string, unknown>[],
): "QUIET" | "FIRED" {
  return blocking.some(f => findingOnChangedLine(subject, f)) ? "FIRED" : "QUIET";
}

/** True when a finding names this subject's planted file and lands in range. */
export function findingHitsPlant(
  subject: ReviewControlSubject,
  finding: Record<string, unknown>,
): boolean {
  if (subject.lines === null) return false;
  const f = AI_REVIEW_FINDING_FIELDS;
  if (finding[f.file] !== subject.file) return false;
  const line = finding[f.line];
  if (typeof line !== "number" || !Number.isFinite(line)) return false;
  return line >= subject.lines[0] && line <= subject.lines[1];
}

/**
 * Score one reviewer payload against one control subject.
 *
 * `payloadRaw` is `null` for "the reviewer wrote nothing", which is exactly
 * what #1180 observed and is a reading rather than an error — the payload
 * reader already says so and this one does not repeat the judgement.
 */
export function readReviewControl(
  subject: ReviewControlSubject,
  payloadRaw: string | null,
  reviewer: string,
): ReviewControlReading {
  // FIRST, and before the payload is touched. #1169's acceptance asks that a
  // reading name the version it measured, and the reason is not bookkeeping:
  // the adjudicator in CI is a pinned published package and the tree runs
  // ahead of it, so a number with no version attached cannot be attributed to
  // either and is evidence about nothing.
  const named = typeof reviewer === "string" ? reviewer.trim() : "";
  if (named === "") {
    return unmeasuredReading(
      subject,
      null,
      ["REVIEWER_UNIDENTIFIED"],
      [],
      [
        "the reading does not name the reviewer it measured, so it cannot be " +
          "attributed to the pinned package or to the tree",
      ],
    );
  }

  const payload = readAiReviewFindings(payloadRaw);
  if (payload.outcome === "UNMEASURED") {
    return unmeasuredReading(
      subject,
      named,
      ["PAYLOAD_UNMEASURED"],
      payload.unmeasuredReasons,
      payload.detail,
    );
  }

  // A CONTRADICTION is scored rather than refused. Its findings list IS
  // readable — the shape #1178 recorded is BLOCK over a payload whose
  // findings are all advisory — and discarding it would blind the control on
  // roughly the third of runs where it happens, which is the band the
  // instrument most needs to see. It is counted separately in the summary.
  const reported = payload.reported ?? [];
  const blocking: Record<string, unknown>[] = [];
  let advisoryCount = 0;

  for (const item of reported) {
    const finding = item as Record<string, unknown>;
    if (severityBlocks(finding[AI_REVIEW_FINDING_FIELDS.severity])) blocking.push(finding);
    else advisoryCount++;
  }

  const hits = blocking.filter(f => findingHitsPlant(subject, f));
  const detail: string[] = [];

  if (subject.kind === "planted") {
    // Near misses are named rather than swallowed. "Found the file, cited the
    // wrong line" and "saw it and called it advisory" are both MISSED, and
    // they are different fixes, so the sentence has to survive the verdict.
    const f = AI_REVIEW_FINDING_FIELDS;
    for (const [i, finding] of reported.entries()) {
      const item = finding as Record<string, unknown>;
      if (item[f.file] !== subject.file) continue;
      if (findingHitsPlant(subject, item) && severityBlocks(item[f.severity])) continue;
      detail.push(
        `near miss: ${renderFinding(i, item)} — the plant is at ` +
          `${subject.file}:${subject.lines?.[0]}-${subject.lines?.[1]} and must block`,
      );
    }
    const outcome: ReviewControlOutcome = hits.length > 0 ? "DETECTED" : "MISSED";
    if (outcome === "MISSED") {
      detail.push(
        `MISSED: no blocking finding at ${subject.file}:` +
          `${subject.lines?.[0]}-${subject.lines?.[1]}. ${subject.note}`,
      );
    }
    return {
      subject: subject.id,
      kind: subject.kind,
      outcome,
      passed: outcome === "DETECTED",
      reviewer: named,
      blockingCount: blocking.length,
      advisoryCount,
      plantHits: hits.length,
      preExistingBlocking: null,
      payloadOutcome: payload.outcome,
      unmeasuredReasons: [],
      payloadReasons: [],
      detail,
    };
  }

  // #1533: scoped to the lines the candidate changed. A blocking finding
  // elsewhere is a defect the diff did not introduce — #1524's `high` at
  // line 19 was byte-identical in the baseline — so it is NAMED and counted
  // as pre-existing, never scored. Whole-file scoring left the arm one
  // reachable outcome, because a compacted copy always carries true defects.
  const outcome: ReviewControlOutcome = cleanArmOutcome(subject, blocking);
  let preExistingBlocking = 0;
  for (const [i, finding] of blocking.entries()) {
    if (findingOnChangedLine(subject, finding)) {
      detail.push(`FIRED on a clean subject: ${renderFinding(i, finding)}`);
    } else {
      preExistingBlocking++;
      // Two reasons a finding is not about the diff, and the sentence names
      // which (review of #2450): a line the candidate left alone in its own
      // file, or a file the candidate does not change at all.
      const where =
        finding[AI_REVIEW_FINDING_FIELDS.file] === subject.file
          ? `not on a line the candidate changed (${subject.file}: ${subject.changedLines?.join(", ") || "none"})`
          : `it names ${JSON.stringify(finding[AI_REVIEW_FINDING_FIELDS.file])}, a file the candidate ` +
            `does not change (the candidate is ${subject.file})`;
      detail.push(`pre-existing, not scored: ${renderFinding(i, finding)} — ${where}`);
    }
  }
  if (outcome === "FIRED") detail.push(subject.note);
  return {
    subject: subject.id,
    kind: subject.kind,
    outcome,
    passed: outcome === "QUIET",
    reviewer: named,
    blockingCount: blocking.length,
    advisoryCount,
    plantHits: 0,
    preExistingBlocking,
    payloadOutcome: payload.outcome,
    unmeasuredReasons: [],
    payloadReasons: [],
    detail,
  };
}

/**
 * Roll readings up into the run's verdict.
 *
 * The anti-vacuity clause is the point of the function. Counting failures and
 * finding none is green over a run that measured nothing at all, which is the
 * exact defect the instrument exists to detect, one level up. So a run is
 * green only if it MEASURED at least one plant and at least one clean subject
 * — an instrument that reports on its own coverage before its own result.
 */
export function summariseReviewControl(readings: ReviewControlReading[]): ReviewControlSummary {
  const count = (o: ReviewControlOutcome) => readings.filter(r => r.outcome === o).length;

  const measured = readings.filter(r => r.outcome !== "UNMEASURED");
  const plantedMeasured = measured.filter(r => r.kind === "planted").length;
  const cleanMeasured = measured.filter(r => r.kind === "clean").length;
  const detected = count("DETECTED");
  const missed = count("MISSED");
  const quiet = count("QUIET");
  const fired = count("FIRED");
  const unmeasured = count("UNMEASURED");

  // #1533, review of #2450: a pre-existing finding is not scored, so it is in
  // neither half of precision. Left in the denominator with no hit to match,
  // it read as a precision failure the reading had just said was not one.
  const blockingTotal = measured.reduce((n, r) => n + (r.blockingCount ?? 0) - (r.preExistingBlocking ?? 0), 0);
  const plantHits = measured.reduce((n, r) => n + r.plantHits, 0);
  const advisory = measured.reduce((n, r) => n + (r.advisoryCount ?? 0), 0);
  const contradictions = measured.filter(r => r.payloadOutcome === "CONTRADICTION").length;

  const detail: string[] = [];
  for (const r of readings) detail.push(...r.detail);

  const covered = plantedMeasured > 0 && cleanMeasured > 0;
  if (!covered) {
    detail.push(
      `the run measured ${plantedMeasured} planted and ${cleanMeasured} clean subject(s). ` +
        "A control needs both halves before a green reading means anything, so this " +
        "run is UNMEASURED rather than clean.",
    );
  }

  return {
    readings,
    plantedMeasured,
    cleanMeasured,
    detected,
    missed,
    quiet,
    fired,
    unmeasured,
    contradictions,
    advisory,
    precision: blockingTotal === 0 ? null : plantHits / blockingTotal,
    recall: plantedMeasured === 0 ? null : detected / plantedMeasured,
    passed: covered && unmeasured === 0 && missed === 0 && fired === 0,
    detail,
  };
}

/**
 * What the caller resolved about the repository a subject would be staged
 * into. Taken by the caller, like `RootReading` next door, so the decision
 * below is pure and a case can plant a repository that does not exist.
 */
export interface ReviewPathReading {
  /** Of the paths asked about, the ones that resolve in the tree. */
  resolvesInTree: readonly string[];
  /** reviewPath → the spec files naming it. Absent and `[]` mean the same. */
  namedBySpecs: Readonly<Record<string, readonly string[]>>;
  /**
   * The glob patterns `REVIEW.md`'s *Do not flag* list names, read from that
   * document rather than restated here — a second copy of the list would be a
   * second decider, and the two would agree right up until the document moved.
   */
  notFlagged: readonly string[];
}

/** Raised when the reading cannot support a judgement. */
export class UnreadableReviewPathReading extends Error {}

/** `**` crosses a separator, `*` does not. Everything else is a literal. */
function globMatches(pattern: string, path: string): boolean {
  const source = pattern
    .split("**")
    .map(part => part.split("*").map(lit => lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${source}$`).test(path);
}

/**
 * Every reason a `reviewPath` cannot carry a reading (#1513).
 *
 * A subject is a compacted, self-contained copy, so it is by construction a
 * WORSE file than any live module whose path it borrows. #1509 measured both
 * halves of what that costs, and they are different failures:
 *
 * - `lib/project-state-root.ts` — the reviewer wrote a true `critical` in all
 *   four draws saying the module no longer exports what its callers import.
 *   True of the baseline, the planted candidate and the clean candidate
 *   alike, so the clean arm could only ever score `FIRED` and the precision
 *   half of the instrument had one reachable outcome.
 * - `lib/test-suite-lock.ts` — five conformity criteria assert that file's
 *   contents, the compacted copy carries none of them, and the pre-push gate
 *   correctly refuses the measurement branch. N = 0, permanently.
 *
 * So a `reviewPath` must name a path that exists in NEITHER the tree nor the
 * specs, and must still sit where the reviewer looks. The third rule is the
 * other side of that: a path `REVIEW.md` excludes is a path where every
 * finding is a declared false positive, so a reading taken there measures
 * exclusion-obedience rather than the reviewer.
 *
 * An empty `notFlagged` is a REFUSAL, not agreement. Zero patterns match
 * nothing, so a reading that failed to find the list would certify every
 * subject — the shape `.claude/rules/checks-must-be-able-to-fail.md` calls an
 * assertion that holds vacuously.
 */
export function reviewPathViolations(
  subjects: readonly ReviewControlSubject[],
  reading: ReviewPathReading,
): string[] {
  if (reading.notFlagged.length === 0) {
    throw new UnreadableReviewPathReading(
      "the reading carries no REVIEW.md exclusion patterns. Zero patterns match nothing, so " +
        "every reviewPath would pass the exclusion rule without being read — UNMEASURED, not clean.",
    );
  }

  const violations: string[] = [];
  const seen = new Map<string, string>();

  for (const subject of subjects) {
    const path = subject.file;

    const first = seen.get(path);
    if (first === undefined) seen.set(path, subject.id);
    else if (first.split("/")[0] !== subject.id.split("/")[0]) {
      violations.push(
        `${subject.id} and ${first} both stage at ${path}. Two subjects at one path cannot be ` +
          "measured by one branch pair — give each subject its own reviewPath.",
      );
    }

    if (reading.resolvesInTree.includes(path)) {
      violations.push(
        `${subject.id}: ${path} is a live module. A compacted subject staged over it is a ` +
          "degraded version of a file the tree depends on, so the reviewer has a true finding " +
          "available in EVERY draw and the clean arm can only score FIRED (#1513, instance 1). " +
          "Name a path that exists in neither the tree nor the specs.",
      );
    }

    const specs = reading.namedBySpecs[path] ?? [];
    if (specs.length > 0) {
      violations.push(
        `${subject.id}: ${path} is named by ${specs.length} spec file(s) (${specs.join(", ")}). ` +
          "A spec that names a path may assert its CONTENTS — five criteria do for " +
          "lib/test-suite-lock.ts — and the compacted copy carries none of it, so the conformity " +
          "gate refuses the measurement branch and the subject stays at N = 0 (#1513, instance 2). " +
          "This refuses a prose mention too: that is the direction that costs a rename rather " +
          "than a reading. Name a path no spec mentions.",
      );
    }

    for (const pattern of reading.notFlagged) {
      if (!globMatches(pattern, path)) continue;
      violations.push(
        `${subject.id}: ${path} is under ${pattern}, which REVIEW.md's "Do not flag" list names. ` +
          "Every finding there is a declared false positive, so the reading would measure whether " +
          "the reviewer obeyed the exclusion. Stage somewhere the reviewer is asked to look.",
      );
    }
  }

  return violations;
}

function asLineRange(value: unknown): readonly [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [a, b] = value;
  if (typeof a !== "number" || typeof b !== "number") return null;
  return [a, b] as const;
}

/**
 * Load every declared subject under a directory.
 *
 * Throws rather than returning a short list on a malformed manifest. A loader
 * that drops the subject it could not parse hands `summariseReviewControl` a
 * run that is simply smaller, and smaller runs go green — which is how a
 * control stops controlling without anyone being told.
 */
export function loadReviewControlSubjects(dir: string): ReviewControlSubject[] {
  const subjects: ReviewControlSubject[] = [];

  for (const entry of readdirSync(dir).sort()) {
    const subjectDir = join(dir, entry);
    if (!statSync(subjectDir).isDirectory()) continue;

    const manifestPath = join(subjectDir, "subject.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
    const reviewPath = manifest.reviewPath;
    const baseline = manifest.baseline;
    const cases = manifest.cases;

    if (typeof reviewPath !== "string" || typeof baseline !== "string" || !Array.isArray(cases)) {
      throw new Error(`${manifestPath}: needs a string reviewPath, a string baseline and a cases list`);
    }

    for (const raw of cases) {
      const c = raw as Record<string, unknown>;
      const kind = c.kind;
      if (typeof c.id !== "string" || typeof c.candidate !== "string") {
        throw new Error(`${manifestPath}: every case needs a string id and candidate`);
      }
      if (kind !== "planted" && kind !== "clean") {
        throw new Error(`${manifestPath}: case ${c.id} has kind ${JSON.stringify(kind)}`);
      }
      const lines = kind === "planted" ? asLineRange(c.lines) : null;
      if (kind === "planted" && lines === null) {
        throw new Error(`${manifestPath}: planted case ${c.id} needs a two-number lines range`);
      }
      const candidatePath = join(subjectDir, c.candidate);
      const baselinePath = join(subjectDir, baseline);
      const candidateText = kind === "clean" ? readFileSync(candidatePath, "utf-8") : null;
      subjects.push({
        id: c.id,
        kind,
        file: reviewPath,
        lines,
        marker: typeof c.marker === "string" ? c.marker : null,
        candidatePath,
        baselinePath,
        changedLines:
          candidateText === null ? null : changedLines(readFileSync(baselinePath, "utf-8"), candidateText),
        // Lines as an editor numbers them: a trailing newline ends the last
        // line rather than starting another.
        candidateLineCount: candidateText === null ? null : candidateText.replace(/\n$/, "").split("\n").length,
        note: String(c.defect ?? c.why ?? ""),
      });
    }
  }

  return subjects;
}
