/**
 * CRC-N4's suppression gate — the production caller `suppressRepeats` never
 * had (#1586).
 *
 * `lib/ai-review-rounds.ts` has exported `carryKey → suppressRepeats` since
 * #1351 and nothing called either. #1381 shipped the WALKER — the generated
 * `ai-review-carry` step reads the ledger and hands the reviewer the
 * unresolved set — so a repeat became *marked* rather than *dropped*. This is
 * the half that drops it.
 *
 * ## Since AC-1 the prior set is the pull request's review threads
 *
 * The ledger keyed a repeat by `file + cited line text + summary`, which a
 * reformat moves — measured on #1616 as 11 threads for 3 findings. A thread
 * is GitHub's own answer to the same question, so AC-1 moved the gate onto
 * it: `priorKeysFrom` reads the list the carry step fetched and nothing else.
 * The ledger reader that used to sit beside it is GONE — AC-5 stopped writing
 * the snapshot it parsed and `ledgerPriorKeysFrom`, `readSnapshot` and
 * `carryStateOf` were deleted with it. `test/ai-review-suppression.test.ts`
 * (AS-0b) asserts all three stay absent, so this paragraph cannot go stale
 * again in the other direction.
 *
 * ## Why the prior state arrives as a file and not as a fetch
 *
 * Unchanged, and for a sharper reason than before. The generated job runs
 * `ai-review-carry` → the reviewer → `ai-review-threads` (the poster, **which
 * posts this round's threads**) → `ai-review-run` (this gate). So a fetch
 * here would not be safe at all: by the time this gate runs, the poster has
 * already opened this round's threads, and a live fetch would read them as
 * prior, suppress the entire payload and report CLEAN forever.
 *
 * The file is what makes the gate correct, and it does not depend on where in
 * a YAML file somebody put a step. The carry step runs before the reviewer,
 * so the list it writes cannot contain this round's work whatever the later
 * order becomes. `test/ai-review-suppression.test.ts` (AS-4) asserts the
 * ordering that matters — `ai-review-carry` precedes both the poster and this
 * gate — rather than the one this comment used to assert.
 *
 * ## Every refusal suppresses NOTHING
 *
 * There is one direction of error this module is allowed to make. Re-posting
 * an advisory that was already answered is loud, cheap and self-correcting;
 * dropping a finding that is still live is silent and permanent. So a thread
 * list that was never fetched, one that was cut off mid-write, and one that
 * parsed into something that is not a list all produce the same behaviour —
 * report everything — and each produces a DIFFERENT sentence saying so
 * (AC-4), because "nothing was a repeat" and "nothing could be compared" are
 * different facts about this round's report.
 *
 * ## It never sees a blocking finding
 *
 * `findingMustAlwaysBeReported` in `lib/scaffold/ai-review-findings.ts`
 * filters before anything reaches this gate. The exemption is structural, not
 * a rule this module is trusted to follow — see that predicate for the
 * measurement, and for the declared deviation from the spec it rests on.
 */
import { readFileSync } from "fs";
import { isAbsolute, resolve, sep } from "path";

import {
  AI_REVIEW_PRIOR_MEASURED,
  anchorOnlyKey,
  anchorTextOf,
  carryKey,
  normaliseLineText,
  priorFindings,
  readLedger,
  type ReviewFinding,
} from "./ai-review-rounds";
import { threadReadingFromJson } from "./ai-review-threads";
import {
  AI_REVIEW_CARRY_ABSENT,
  AI_REVIEW_CARRY_READ,
  AI_REVIEW_CARRY_STATE_KEY,
  AI_REVIEW_CARRY_UNMEASURED,
  AI_REVIEW_SNAPSHOT_ROUND_KEY,
} from "./scaffold/ai-review-step";
import type { AiReviewSuppressionGate } from "./scaffold/ai-review-findings";

/** What the gate reads, so a test can drive it without a filesystem. */
export interface SuppressionInputs {
  /**
   * The review-thread list the carry step fetched, or `null` when the file
   * was not there. Since AC-1 this is the ONLY thing the gate decides from —
   * see `priorKeysFrom`.
   */
  threads: string | null;
  /** The text at a finding's cited line NOW, or `undefined`. */
  lineTextFor: (finding: ReviewFinding) => string | undefined;
  /**
   * How many lines of `file` carry `normalisedText`, or `undefined` when the
   * file could not be read (#1861).
   *
   * Optional, and absent means the anchor rule never fires. A caller that has
   * not been rewired keeps the behaviour it had before the rule existed,
   * which is the direction this module is allowed to be wrong in.
   */
  anchorOccurrences?: (file: string, normalisedText: string) => number | undefined;
}

/** A prior set that was established, or the sentence saying it was not. */
export type PriorKeys =
  | { status: "MEASURED"; keys: string[] }
  | { status: "UNMEASURED"; reason: string };

/**
 * THE PRIOR SET, read from the pull request's own review threads (AC-1).
 *
 * ## Why a thread and not the ledger
 *
 * The ledger answers "was this raised before?" with a text heuristic —
 * `file + the text at the cited line + summary` — and a reformat moves the
 * key, so round 4 cannot tell it is re-raising round 1's finding. Measured on
 * #1616: **11 threads for 3 distinct findings**, re-raised across four rounds
 * while the line numbers moved under them. A thread is the authoritative
 * answer to the same question: the comment is on the pull request, or it is
 * not.
 *
 * ## A RESOLVED thread is still a prior key
 *
 * This is the one place this reader and `carryForwardFromThreads` deliberately
 * disagree, and the difference is the question each is asking:
 *
 * | Reader | Question | Resolved thread |
 * |---|---|---|
 * | this gate | has this already been **raised**? | yes — do not post it twice |
 * | carry-forward | is this still **unanswered**? | no — a human answered it |
 *
 * A gate that treated resolution as "not raised" would re-post a thread the
 * moment someone resolved it, which is the duplicate-per-round failure the
 * whole increment exists to prevent, aimed at the people who are doing the
 * work.
 *
 * ## Self-suppression is prevented by WHERE THE LIST IS FETCHED, not by a guard
 *
 * The ledger reader needed a provenance header because the ledger is written
 * *during* the job, before the adjudicator reads it. Threads are no better on
 * that count — `ai-review-threads` posts this round's threads BEFORE
 * `ai-review-run` adjudicates, so a list fetched at adjudication time would
 * contain them.
 *
 * What rules self-suppression out is that the list is not fetched here. It is
 * fetched by `ai-review-carry`, which runs before the reviewer and therefore
 * before anything this round could have posted, and handed to this gate as a
 * file. That property lives in the workflow's step order and is asserted
 * there; see `test/ai-review-suppression.test.ts` (AS-4), which pins
 * `ai-review-carry` ahead of both the poster and the adjudicator.
 *
 * Exported and pure so the battery can drive every refusal without a
 * filesystem, and so there is one place to mutate.
 */
export function priorKeysFrom(threads: string | null): PriorKeys {
  const reading = threadReadingFromJson(threads);
  if (reading.status !== "MEASURED") {
    return { status: "UNMEASURED", reason: reading.reason };
  }
  // Open and resolved alike. The fold that distinguishes them belongs to
  // carry-forward, for the reason tabled above.
  return { status: "MEASURED", keys: reading.threads.map(t => t.key) };
}

/**
 * Does this anchor identify ONE line of the file it names (#1861 round 3)?
 *
 * The screen the round-3 review asked for, and deliberately NOT the one it
 * suggested. A minimum anchor length was the obvious fix and the measurement
 * refuses it: of the five ambiguous anchors in the 60-finding corpus, four
 * normalise to over twenty characters and the worst is forty-five. Length
 * does not predict distinctiveness; counting the occurrences measures it.
 *
 * Every reading that is not exactly `1` answers `false`, including every way
 * of failing to read. A caller with no counter, a file that is not there, a
 * key whose text cannot be recovered and a path with two matching lines all
 * mean the same thing here: this anchor cannot be shown to name one place,
 * so nothing is suppressed on it.
 */
function uniqueAnchor(
  inputs: SuppressionInputs,
  finding: ReviewFinding,
  anchorKey: string,
): boolean {
  const count = inputs.anchorOccurrences;
  if (count === undefined) return false;
  const text = anchorTextOf(anchorKey);
  if (text === null || text === "") return false;
  const file = finding.file;
  if (typeof file !== "string" || file === "") return false;
  return count(file, text) === 1;
}

/**
 * Build the gate the adjudicator is handed, or `null` when nothing is plumbed.
 *
 * `null` rather than a gate that answers "no repeats": a consumer that has
 * not re-scaffolded gets exactly the reading it had before #1586, and "no
 * repeat reader" is a state that cannot be confused with "the reader found
 * nothing".
 */
export function aiReviewSuppressionGate(inputs: SuppressionInputs): AiReviewSuppressionGate {
  return (candidates: readonly unknown[]) => {
    const prior = priorKeysFrom(inputs.threads);
    if (prior.status === "UNMEASURED") {
      return { repeat: candidates.map(() => null), unmeasured: prior.reason };
    }
    // `suppressRepeats` is not called here, and that is deliberate: it
    // returns partitioned LISTS, and the adjudicator's contract is
    // positional. Re-deriving the position from a list would be a second
    // identity derivation over findings already in order — the fault
    // `AiReviewJuryGate`'s docblock names. `carryKey` is the shared rule and
    // the within-round half is the growing `seen` set, exactly as
    // `suppressRepeats` spells it.
    // The keys an EARLIER round posted, kept apart from the growing set
    // below so the two sentences can say which of them matched (#1861 round
    // 3). They used to be one set, and the message said "an earlier round"
    // for a duplicate that came from this round's own payload.
    const priorSet = new Set<string>(prior.keys);
    const seen = new Set<string>(prior.keys);
    // #1168. The same prior set read with the wording dropped. Built from the
    // SAME strings rather than from the threads a second time: two derivations
    // of one identity are two deciders that agree, and a mutation of either
    // leaves the other holding every case up.
    const anchors = new Set<string>();
    for (const k of prior.keys) {
      const a = anchorOnlyKey(k);
      if (a !== null) anchors.add(a);
    }
    const repeat = candidates.map(c => {
      const key = carryKey(c, inputs.lineTextFor(c as ReviewFinding));
      // Unkeyable CARRIES. It cannot be shown to be a repeat, and the
      // direction this is allowed to be wrong in is toward reporting.
      if (key === null) return null;
      const f = c as ReviewFinding;
      const where = String(f.file ?? "(no file)");
      const what = String(f.summary ?? "(no summary)");
      if (seen.has(key)) {
        // WHICH set matched is the difference between two true sentences and
        // one false one. `priorSet` is fixed at the prior round's keys;
        // anything else in `seen` was added by a sibling a few lines below.
        return priorSet.has(key)
          ? `${where}: ${what} — already ` +
            `raised on an earlier round of this pull request, so it is not raised again`
          : `${where}: ${what} — listed more than once in this round's own ` +
            `report, word for word, so it is reported once`;
      }
      const anchor = anchorOnlyKey(key);
      // The wording differs and the anchor does not. Measured at #1168: of
      // eight such collisions across 25 merged pull requests, eight were the
      // same defect restated and none was a new finding at an old line. This
      // is a JUDGEMENT rather than an identity, so it says so — the sentence
      // is what lets a reader appeal it.
      //
      // And it fires only on an anchor that identifies ONE line of the file.
      // `}` and `return null;` key the same anchor wherever they recur, so a
      // new finding at a second occurrence would be suppressed as a
      // restatement of a defect somewhere else entirely. Measured at #1861:
      // 5 of 60 anchors in the corpus — 8.3% — recur in their own file. An
      // unreadable file counts as NOT unique, because "I could not look" and
      // "it appears once" must not be the same reading.
      if (anchor !== null && anchors.has(anchor) && uniqueAnchor(inputs, f, anchor)) {
        return (
          `${where}: ${what} — an earlier round of this pull request already ` +
          `raised a finding at the same line of text in this file, in different words, ` +
          `so this is read as the same finding restated and is not raised again`
        );
      }
      seen.add(key);
      // `anchors` is NOT grown here, and the asymmetry with `seen` above is
      // deliberate (#1861 round 1).
      //
      // `seen` growing is the established within-round rule and is safe on an
      // EXACT key: two candidates with the same file, anchor AND wording are
      // the same finding listed twice. The anchor key drops the wording, so
      // growing it would suppress a second, differently-worded finding at the
      // same line because a SIBLING in this very round cited it — and the
      // sentence above, which says "an earlier round", would be false.
      //
      // It is also unmeasured: #1168's reading characterises cross-round
      // collisions only, 8 of 8 restatements. It says nothing about two
      // findings a reviewer raises at one line while looking at it once,
      // which is the more plausible place for two genuine defects to share an
      // anchor. Suppressing on evidence that was never taken is the thing
      // this whole increment is a correction for.
      return null;
    });
    return { repeat, unmeasured: null };
  };
}

/**
 * THE ONE PLACE A PRODUCTION `SuppressionInputs` IS ASSEMBLED (#1861 round 4).
 *
 * Two commands form this gate — `scripts/ai-review-findings.ts`, which decides
 * the exit code, and `scripts/ai-review-threads.ts`, which posts the threads.
 * `ai-review-threads.ts`' own comment states the invariant: the gate is *"the
 * same function the adjudicator builds, over the same file, which is what
 * makes 'already raised' one decision rather than two that agree until they
 * do not"*. They ran BEFORE this existed as two hand-written object literals,
 * and the round-4 review found the predicted consequence: `anchorOccurrences`
 * was added to one of them, so the whole anchor rule was dead in the poster —
 * the half that produces #1168's actual symptom, 11 threads for 3 findings.
 *
 * Returning the reader alongside the gate is the other half. The poster needs
 * `lineTextFor` again for the key it writes INTO each thread, and it used to
 * build a second `checkoutLineText` with a second cache. One reader, one
 * cache, one normalisation — and nothing left for a future field to be wired
 * into unevenly.
 *
 * `gate` is `null` when no thread list is plumbed, which is each command's
 * pre-existing behaviour and is NOT the same as a gate that finds no repeats.
 * `test/ai-review-suppression.test.ts` (AS-15) asserts neither command
 * assembles its own.
 */
export function productionSuppression(
  threadsPath: string | undefined,
  root: string,
): {
  gate: AiReviewSuppressionGate | null;
  lineTextFor: (finding: ReviewFinding) => string | undefined;
} {
  const reader = checkoutLineReader(root);
  const gate =
    threadsPath === undefined || threadsPath === ""
      ? null
      : aiReviewSuppressionGate({
          threads: readOrNull(threadsPath),
          lineTextFor: reader.lineTextFor,
          anchorOccurrences: reader.occurrencesOf,
        });
  return { gate, lineTextFor: reader.lineTextFor };
}

/**
 * THE KEY-SYMMETRY HALF. The text at a finding's cited line, read out of the
 * checkout.
 *
 * `carryKey` anchors on the TEXT of the cited line and falls back to the line
 * NUMBER when no text is supplied — so a caller that supplies nothing is not
 * computing a weaker version of the same key, it is computing keys in a
 * DIFFERENT NAMESPACE from the ledger's. The ledger records `recordedText`
 * and keys `t:<text>`; a text-less caller keys `n:<line>`; the two never
 * collide, so the dedupe silently suppresses nothing and every round looks
 * like a round with no repeats. Measured before this landed: `kept: 1,
 * suppressed: 0` on a planted exact repeat.
 *
 * A line that cannot be read yields `undefined` and the finding falls back to
 * the number anchor — asymmetric again, for that one finding, and therefore
 * reported rather than dropped.
 *
 * `root` bounds it. A payload is written by the reviewer and names its own
 * paths, so `../../etc/passwd` is an input this must handle; `resolve`
 * normalises the `..` away, which is why the containment test is on the
 * RESOLVED path and not on the spelling.
 */
export function checkoutLineText(root: string): (finding: ReviewFinding) => string | undefined {
  return checkoutLineReader(root).lineTextFor;
}

/**
 * Both readings of the checkout, over ONE file cache.
 *
 * `lineTextFor` is the key-symmetry half documented above. `occurrencesOf`
 * is the distinctiveness half #1861 added: how many lines of a file carry a
 * given normalised text. They share a cache because they read the same files
 * on the same run, and they share `normaliseLineText` with `carryKey`
 * because a counter normalising differently from the key would count
 * occurrences of a string the key never built.
 *
 * `undefined` from `occurrencesOf` is "I could not look" — an unreadable
 * file, an absolute path, an escape out of the checkout — and the caller
 * reads it as not-unique. Zero is a different fact (the file was read and
 * the text is not in it) and is also not one, so both refuse.
 */
export function checkoutLineReader(root: string): {
  lineTextFor: (finding: ReviewFinding) => string | undefined;
  occurrencesOf: (file: string, normalisedText: string) => number | undefined;
} {
  const base = resolve(root);
  const cache = new Map<string, string[] | null>();
  const linesOf = (file: string): string[] | null => {
    if (typeof file !== "string" || file === "") return null;
    if (isAbsolute(file)) return null;
    const path = resolve(base, file);
    if (path !== base && !path.startsWith(base + sep)) return null;
    if (!cache.has(path)) {
      try {
        cache.set(path, readFileSync(path, "utf-8").split("\n"));
      } catch {
        cache.set(path, null);
      }
    }
    return cache.get(path) ?? null;
  };
  return {
    lineTextFor: (finding: ReviewFinding) => {
      const file = finding.file;
      const line = finding.line;
      if (typeof file !== "string") return undefined;
      if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return undefined;
      const lines = linesOf(file);
      if (lines === null) return undefined;
      const text = lines[line - 1];
      return typeof text === "string" && text.trim() !== "" ? text : undefined;
    },
    occurrencesOf: (file: string, normalisedText: string) => {
      const lines = linesOf(file);
      if (lines === null) return undefined;
      let n = 0;
      for (const l of lines) if (normaliseLineText(l) === normalisedText) n++;
      return n;
    },
  };
}

/**
 * Read a path, or `null`. Absent and unreadable collapse HERE and only here,
 * because the caller's three-state reading comes from the carry file's
 * contents rather than from its presence — and every `null` reaching
 * `priorKeysFrom` produces an UNMEASURED sentence rather than an empty set.
 */
export function readOrNull(path: string | undefined): string | null {
  if (path === undefined || path === "") return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}
