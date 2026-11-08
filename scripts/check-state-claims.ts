#!/usr/bin/env bun
/**
 * Re-derive the figures `project-state.json` states about the board — #1889.
 *
 * Claim 2: every number a run reports describes the committed tree. The
 * state file is the report this project reads first, and until now it was
 * the only one whose figures nothing re-derived. Three review rounds on
 * #1888 each caught the same class of defect by hand.
 *
 * ## What it reads, and why the readings come from a file
 *
 * Two inputs, both files, both named on the command line:
 *
 *   --state     the project-state.json to check
 *   --readings  board-conformance's readings, as JSON
 *
 * It does not take its own board reading. `scripts/board-conformance.ts
 * --emit-readings <path>` writes that file, and keeping the two apart is
 * what makes this check runnable offline against planted inputs: one state
 * file and two readings files are two outcomes from one comparison, with
 * no network between them.
 *
 * ## A ratchet, because the file is already wrong and that is the finding
 *
 * Measured on 2026-11-08 against `origin/main`: of 19 cited figures, 10
 * carry the date they were taken and are records, 2 agree with the live
 * reading, and **7 disagree**. Every one of the seven is undated prose in
 * an append-only session log — true when written, stale now, and exactly
 * the shape #1888 round 1 escaped on.
 *
 * So this ships as a known-violations ratchet, like
 * `.claude/config-access-ratchet.json`, and refuses in BOTH directions: over
 * the number fails, and under it fails too. A new stale figure reddens the
 * build while the total is above zero, and lowering the count means editing
 * the ratchet in the same commit that earns it. The number means *undated
 * figures in `priorities[]` that no longer match the board* — the fix for
 * each is to date the sentence, which is what the file should be doing.
 *
 * ## Every refusal goes through REFUSE_EXIT, and there is one of it
 *
 * `test/check-state-claims.test.ts` builds a copy of this file with the
 * constant set to `0` and runs every negative case twice. Real refuses,
 * mutant does not. Two properties that mutant depends on are asserted
 * there rather than assumed: the constant is assigned exactly once, and the
 * only relative import is the one below — which the test's copier carries
 * into the scratch tree alongside the mutant.
 */
import { readFileSync } from "fs";
import { parseArgs } from "util";

import { readStateClaims, type LiveReading } from "../lib/state-claim-readings";

export const REFUSE_EXIT = 1;

/** Absent means UNMEASURED, never zero — see `readRatchet`. */
export const DEFAULT_RATCHET = ".claude/state-claim-ratchet.json";
export const DEFAULT_STATE = "project-state.json";

export interface Ratchet {
  allowed: number;
  why: string;
}

type Read<T> = { ok: true; value: T } | { ok: false; why: string };

function readJson(path: string, what: string): Read<unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { ok: false, why: `${what} ${path} could not be read: ${(e as Error).message}` };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    // A corrupt file is never a missing one, and neither is an empty
    // reading. `.claude/rules/config-access.md`, the same distinction.
    return { ok: false, why: `${what} ${path} is not readable JSON: ${(e as Error).message}` };
  }
}

/**
 * The live readings, validated rather than cast.
 *
 * An entry missing `measured` or `target` would compare `undefined` against
 * a number and read as a disagreement — a refusal for the wrong reason,
 * which is worse than no refusal because a reader acts on the reason.
 */
export function readLiveReadings(value: unknown): Read<LiveReading[]> {
  if (!Array.isArray(value)) return { ok: false, why: "the readings file is not a JSON array" };
  if (value.length === 0) {
    return { ok: false, why: "the readings file is an empty array, which is not a set of readings" };
  }
  const out: LiveReading[] = [];
  for (const [i, r] of value.entries()) {
    if (r === null || typeof r !== "object" || Array.isArray(r)) {
      return { ok: false, why: `reading ${i} is not an object` };
    }
    const o = r as Record<string, unknown>;
    if (typeof o.name !== "string" || o.name === "") {
      return { ok: false, why: `reading ${i} carries no 'name'` };
    }
    if (typeof o.measured !== "number" || typeof o.target !== "number") {
      return {
        ok: false,
        why: `reading ${JSON.stringify(o.name)} carries a non-numeric 'measured' or 'target'`,
      };
    }
    out.push({ name: o.name, measured: o.measured, target: o.target });
  }
  return { ok: true, value: out };
}

/**
 * The ratchet. An absent file is UNMEASURED and refuses — it is NOT zero.
 *
 * Defaulting an absent ratchet to zero would turn "nobody has banked a
 * number here" into "no violations are allowed", which passes on a tree
 * that happens to be clean and refuses on every other one with a reason
 * nobody wrote. `.claude/rules/self-referential-tests.md` says this about
 * the opaque-write ratchet in the same words.
 */
export function readRatchet(value: unknown): Read<Ratchet> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, why: "the ratchet is not a JSON object" };
  }
  const o = value as Record<string, unknown>;
  if (typeof o.allowed !== "number" || !Number.isInteger(o.allowed) || o.allowed < 0) {
    return { ok: false, why: "the ratchet's 'allowed' is not a whole number of violations" };
  }
  if (typeof o.why !== "string" || o.why.trim().length < 40) {
    // A ratchet nobody can interpret becomes a number nobody lowers.
    return {
      ok: false,
      why: "the ratchet's 'why' must say what the number means, in at least 40 characters",
    };
  }
  return { ok: true, value: { allowed: o.allowed, why: o.why } };
}

/** The `priorities[]` prose, which is what carries the figures. */
export function statePriorities(value: unknown): Read<string[]> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, why: "the state file is not a JSON object" };
  }
  const p = (value as Record<string, unknown>).priorities;
  if (p === undefined) return { ok: false, why: "the state file carries no 'priorities'" };
  if (!Array.isArray(p)) return { ok: false, why: "'priorities' is not an array" };
  return { ok: true, value: p.map(e => (typeof e === "string" ? e : JSON.stringify(e))) };
}

export function main(argv: readonly string[]): number {
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        state: { type: "string" },
        readings: { type: "string" },
        ratchet: { type: "string" },
      },
      strict: true,
    }) as { values: Record<string, unknown> });
  } catch (e) {
    console.error(`check-state-claims: ${(e as Error).message}`);
    return REFUSE_EXIT;
  }

  const readingsPath = typeof values.readings === "string" ? values.readings : "";
  if (readingsPath === "") {
    console.error(
      "check-state-claims: UNMEASURED — --readings <path> is required. Produce it with " +
        "`bun scripts/board-conformance.ts --emit-readings <path>`. A run with no live readings " +
        "has not checked the state file; it has not read it.",
    );
    return REFUSE_EXIT;
  }
  const statePath = typeof values.state === "string" && values.state !== "" ? values.state : DEFAULT_STATE;
  const ratchetPath =
    typeof values.ratchet === "string" && values.ratchet !== "" ? values.ratchet : DEFAULT_RATCHET;

  const rawReadings = readJson(readingsPath, "the readings file");
  if (!rawReadings.ok) return refuse(rawReadings.why);
  const live = readLiveReadings(rawReadings.value);
  if (!live.ok) return refuse(`${readingsPath}: ${live.why}`);

  const rawState = readJson(statePath, "the state file");
  if (!rawState.ok) return refuse(rawState.why);
  const priorities = statePriorities(rawState.value);
  if (!priorities.ok) return refuse(`${statePath}: ${priorities.why}`);

  const rawRatchet = readJson(ratchetPath, "the ratchet");
  if (!rawRatchet.ok) return refuse(`${rawRatchet.why}. An absent ratchet is UNMEASURED, not zero`);
  const ratchet = readRatchet(rawRatchet.value);
  if (!ratchet.ok) return refuse(`${ratchetPath}: ${ratchet.why}`);

  const reading = readStateClaims(priorities.value, live.value);

  console.log(
    `check-state-claims: ${reading.claims} cited figure(s) — ${reading.agreed} agreed, ` +
      `${reading.recorded} dated and not compared, ${reading.disagreed.length} disagreed, ` +
      `${reading.unresolvable.length} unresolvable.`,
  );

  // NO CLAIMS IS ITS OWN OUTCOME. Zero disagreements over zero figures and
  // zero disagreements over nineteen are the same number and completely
  // different states, and an extractor that silently matched nothing would
  // certify the file by counting nothing.
  if (reading.claims === 0) {
    return refuse(
      `UNMEASURED — no figure in ${statePath}'s \`priorities[]\` names a reading, so nothing was ` +
        `compared. That is not a clean file. Known readings: ${live.value.map(r => r.name).join(", ")}`,
    );
  }

  for (const v of reading.unresolvable) {
    if (v.kind !== "UNRESOLVABLE") continue;
    console.error(`UNRESOLVABLE: ${v.why}\n  ${v.cited.sentence}`);
  }
  for (const v of reading.disagreed) {
    if (v.kind !== "DISAGREED") continue;
    console.error(
      `DISAGREED: \`${v.cited.reading}\` is cited as ${v.cited.measured} of ${v.cited.target} and ` +
        `reads ${v.live.measured} of ${v.live.target} now. Either correct the figure, or date the ` +
        `sentence so it reads as the record it is.\n  ${v.cited.sentence}`,
    );
  }

  if (reading.unresolvable.length > 0) {
    return refuse(
      `${reading.unresolvable.length} cited figure(s) name a reading that no longer exists. A ` +
        `renamed reading drops out of the comparison silently, so the file would read as fully checked`,
    );
  }

  const n = reading.disagreed.length;
  if (n !== ratchet.value.allowed) {
    const direction = n > ratchet.value.allowed ? "above" : "below";
    return refuse(
      `${n} figure(s) disagree with the live board, and ${ratchetPath} allows ` +
        `${ratchet.value.allowed}. That is ${direction} the banked number, and this ratchet refuses ` +
        `both directions: a new stale figure must redden the build while the total is above zero, ` +
        `and a figure you fixed must be banked in the same commit. Set 'allowed' to ${n}.\n` +
        `  what the number means: ${ratchet.value.why}`,
    );
  }

  console.log(
    `check-state-claims: ${n} disagreement(s), matching the banked number in ${ratchetPath}.`,
  );
  return 0;
}

function refuse(why: string): number {
  console.error(`check-state-claims: ${why}.`);
  return REFUSE_EXIT;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
