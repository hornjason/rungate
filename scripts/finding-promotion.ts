#!/usr/bin/env bun
/**
 * finding-promotion CLI — turn a review finding into a spec criterion.
 *
 * Usage:
 *   bun scripts/finding-promotion.ts --issue 1678 \
 *     --spec specs/SPEC-TO-BOARD-PIPELINE-SPEC.md \
 *     --symbol promote --module lib/finding-promotion.ts \
 *     --outcome "a review finding that names real work becomes a criterion"
 *
 *   …and add --write to append it. Without --write it prints and exits 0,
 *   having changed nothing.
 *
 * The OTHER outcome — this finding serves no criterion, deliberately:
 *
 *   bun scripts/finding-promotion.ts --issue 1934 \
 *     --declines "a worktree tidy-up; no criterion is made true or false" --write
 *
 * which writes the phrase `scripts/board-snapshot.ts` reads, interpolated
 * from the constant rather than retyped. It refuses when the board can
 * already see a criterion on the issue, so the declaration is an OUTCOME of
 * the router and not a self-declaration — #1940.
 *
 * `--outcome` and `--symbol` are the caller's judgement and this script does
 * not supply them — see the docblock of `lib/finding-promotion.ts` for why
 * there is no `--auto` that sweeps the backlog. `--declines` is the same
 * kind of input for the same reason.
 *
 * Thin CLI consumer — all logic lives in lib/finding-promotion.ts.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  decline,
  promote,
  specPath,
  type PromotableIssue,
} from "../lib/finding-promotion";
import { readScRegistry } from "./sync-sc-status";
import { currentScOwner } from "../lib/sc-reservations";
import { ghWithoutGhToken } from "../lib/live-issues";
import { skipLine } from "../lib/derived-spec";
import { maySpecBeWritten, writeSpec } from "../lib/write-spec";

/** Routed through one constant so a test can prove the refusal is observed. */
export const PROMOTION_EXIT = 1;

const args = process.argv.slice(2);

/**
 * What argv says about one flag — FOUR states, enumerated, never collapsed.
 *
 * The reader used to return `string | undefined` and folded two different
 * facts into that `undefined`: the flag is **absent**, and the flag is the
 * **last token in argv** so `args[idx + 1]` does not exist. `optional()`
 * read both as "the caller did not pass it" and took the default, so
 * `--project-root` with the path typo'd away resolved ROOT to
 * `node_modules/rungate` — #363, reintroduced silently through the guard
 * added to prevent it.
 *
 * Rounds 2 through 4 of this pull request each repaired one FLAG, and every
 * one of them handed the parser the same SHAPE of input ("the value is the
 * next flag"). The defect sat on the axis nobody varied —
 * `.claude/rules/checks-must-be-able-to-fail.md`, the seventh shape. So the
 * states are enumerated here, in the reader, where no caller can drop one:
 * the union is exhaustive, and a `switch` that omits a case does not
 * compile.
 */
type FlagReading =
  | { kind: "absent" }
  | { kind: "novalue" }
  | { kind: "nextflag"; value: string }
  | { kind: "value"; value: string };

function readFlag(name: string): FlagReading {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return { kind: "absent" };
  if (idx + 1 >= args.length) return { kind: "novalue" };
  const value = args[idx + 1]!;
  return value.startsWith("--") ? { kind: "nextflag", value } : { kind: "value", value };
}

/**
 * The refusal every present-but-valueless flag gets, by name. ONE binding,
 * so both ways of passing no value produce the same outcome and differ only
 * in the sentence that says which it was.
 */
function refuseNoValue(name: string, reading: { kind: "novalue" } | { kind: "nextflag"; value: string }): never {
  const detail =
    reading.kind === "nextflag"
      ? `was given '${reading.value}', which is the next flag`
      : "was the last argument and was given no value at all";
  console.error(
    `ERROR: --${name} ${detail}. Its value is missing, and continuing would run ` +
      "against a value nobody passed.",
  );
  process.exit(PROMOTION_EXIT);
}

/** An OPTIONAL flag: absent is fine, present-with-no-value is not. */
function optional(name: string): string | undefined {
  const reading = readFlag(name);
  switch (reading.kind) {
    case "absent":
      return undefined;
    case "value":
      return reading.value;
    default:
      refuseNoValue(name, reading);
  }
}

/**
 * A required flag's value, refused by NAME in all three ways it can be
 * unusable: absent, last-with-no-value, and "its value is the next flag".
 */
function required(name: string): string {
  const reading = readFlag(name);
  switch (reading.kind) {
    case "absent":
      console.error(`ERROR: --${name} is required`);
      process.exit(PROMOTION_EXIT);
    case "value":
      return reading.value;
    default:
      refuseNoValue(name, reading);
  }
}

/**
 * The tree this run reads and writes — the CALLER's, never this script's.
 *
 * It was `join(import.meta.dir, "..")`, which is correct for `bun
 * scripts/finding-promotion.ts` in this repository and wrong for every
 * consumer: under `bunx rungate finding-promotion` that is
 * `node_modules/rungate`, so `--spec specs/MY-SPEC.md` resolved inside the
 * installed package. The consumer's spec sits right there and the command
 * refuses SPEC_ABSENT; worse, a spec whose basename collides with one of
 * rungate's own would have been APPENDED TO inside `node_modules`, printing
 * "Appended to …" for a criterion the next install deletes. That is #363
 * exactly, which `lib/cli-commands.ts` spends its first eighty lines
 * warning about — reintroduced by registering a script that had never
 * needed the flag because nothing could reach it.
 *
 * `bin/rungate.ts` appends `--project-root <cwd>` whenever the registry
 * entry sets `projectRootFlag` and the caller did not pass one, so the
 * default below is only reached by a direct `bun scripts/…` invocation.
 */
const ROOT = optional("project-root") ?? join(import.meta.dir, "..");

/** A required flag that must be a positive integer, refused by name. */
function requiredPositiveInt(name: string): number {
  const raw = required(name);
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    // Without this, `Number("abc")` is NaN, `String(NaN)` is "NaN", and the
    // failure arrives as `gh`'s own error about issue #NaN — a downstream
    // message about a tracker lookup, for what is a typo in an argument.
    console.error(`ERROR: --${name} must be a positive integer, got '${raw}'`);
    process.exit(PROMOTION_EXIT);
  }
  return n;
}

const issueNumber = requiredPositiveInt("issue");

/**
 * Which outcome of the router this run is.
 *
 * Presence, not value — `--declines --write` must refuse by NAME rather than
 * decline with the reason `"--write"`, which is what reading the value to
 * decide the mode would do. `required` is what names it, and it is the same
 * one binding every other flag goes through.
 */
const declining = args.includes("--declines");
const declineWhy = declining ? required("declines") : "";

// The two modes are exclusive, and silence here was a real hazard: `--spec`,
// `--outcome`, `--symbol` and `--module` are read ONLY when `declining` is
// false, so a command line carrying both took the decline path and ignored
// four flags the caller passed. A half-edited copy-paste produces exactly
// that, and the result is indistinguishable from a deliberate decline.
if (declining) {
  const promoteOnly = ["spec", "outcome", "symbol", "module"].filter(f => args.includes(`--${f}`));
  if (promoteOnly.length > 0) {
    console.error(
      `ERROR: --declines cannot be combined with ${promoteOnly.map(f => `--${f}`).join(", ")}. ` +
        "Promoting a finding into a criterion and declaring that it serves none are opposite " +
        "outcomes; this command line asks for both and the promote flags would be ignored.",
    );
    process.exit(PROMOTION_EXIT);
  }
}

const spec = declining ? "" : required("spec");
const outcome = declining ? "" : required("outcome");
const symbol = declining ? "" : required("symbol");
const module = declining ? "" : required("module");
const write = args.includes("--write");

// The issue's own text decides ALREADY_SERVES, so a title typed by hand here
// would let a promotion through that the board can see is a second criterion
// for one piece of work. Read it from the tracker.
// `ghWithoutGhToken`, not a second spawn here. It DELETES the key rather
// than blanking it — `{ ...process.env, GH_TOKEN: "" }` leaves it present,
// which is the gotcha that helper exists to hold, and a second copy of this
// decision is a second place for it to be got wrong.
const issue: PromotableIssue = (() => {
  try {
    return JSON.parse(
      ghWithoutGhToken(["issue", "view", String(issueNumber), "--json", "number,title,body"]),
    ) as PromotableIssue;
  } catch (e) {
    console.error(`ERROR: could not read #${issueNumber} from the tracker`);
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(PROMOTION_EXIT);
  }
})();

if (declining) {
  const declined = decline({ issue, why: declineWhy, projectRoot: ROOT });
  if (!declined.declined) {
    console.error(`REFUSED ${declined.refusal}: ${declined.why}`);
    process.exit(PROMOTION_EXIT);
  }
  console.log(declined.body);

  if (!write) {
    console.log(`\n(dry run — nothing written. Add --write to apply it to #${issueNumber}.)`);
    process.exit(0);
  }

  // RE-READ before writing. The body above came from a snapshot taken
  // before the refusal checks ran, and `gh issue edit --body-file`
  // overwrites the WHOLE body — so a comment-free edit by anybody else in
  // that window is silently destroyed. The promote path already does this:
  // `writeSpec` re-reads the target and runs its own guard against those
  // bytes rather than the ones the caller validated.
  //
  // Re-validating too, not just re-reading: the fresh body is what the
  // decline is being written into, so ALREADY_DECLINED and the heading
  // readings have to be taken against it. A re-read that skipped them
  // would answer a different question from the one that was asked.
  let fresh: PromotableIssue;
  try {
    fresh = JSON.parse(
      ghWithoutGhToken(["issue", "view", String(issueNumber), "--json", "number,title,body"]),
    ) as PromotableIssue;
  } catch (e) {
    console.error(`REFUSED: #${issueNumber} could not be re-read before the write`);
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(PROMOTION_EXIT);
  }

  const recheck = decline({ issue: fresh, why: declineWhy, projectRoot: ROOT });
  if (!recheck.declined) {
    console.error(
      `REFUSED ${recheck.refusal}: #${issueNumber} changed between the check and the write. ` +
        recheck.why,
    );
    process.exit(PROMOTION_EXIT);
  }

  // Through a file, because the body is markdown with newlines and headings
  // in it and an argv round-trip through a shell is where that gets eaten.
  //
  // The two failure modes are reported apart. One `catch` over both said
  // "could not be updated on the tracker" for a local disk error too, which
  // sends the reader to GitHub for a problem on their own filesystem.
  // Bound out here: narrowing from the `recheck.declined` guard above does
  // not reach inside the closure below, and the alternative — re-asserting
  // the discriminant in there — is a second place for the two to disagree.
  const declinedBody = recheck.body;

  const scratch = mkdtempSync(join(tmpdir(), "rg-1940-decline-"));
  const bodyFile = join(scratch, "body.md");

  /**
   * The guarded region RETURNS its failure. It never exits.
   *
   * `process.exit()` does not unwind the stack, so a `finally` wrapped
   * around a block that exits from inside it never runs — both error paths
   * here left the mkdtemp directory, and the rendered issue body inside it,
   * on disk. Found on #1956.
   *
   * The fix is the shape, not the two call sites: with no exit anywhere in
   * the region there is no second place for one to reappear, and
   * `test/finding-promotion.test.ts` asserts the region stays exit-free
   * rather than asserting these two lines in particular.
   */
  function writeAndEdit(): string[] | null {
    try {
      writeFileSync(bodyFile, declinedBody);
    } catch (e) {
      return [
        `REFUSED: could not write the new body to ${bodyFile} — this is a LOCAL`,
        `failure, not a tracker one. #${issueNumber} was not touched.`,
        e instanceof Error ? e.message : String(e),
      ];
    }
    try {
      ghWithoutGhToken(["issue", "edit", String(issueNumber), "--body-file", bodyFile]);
    } catch (e) {
      return [
        `REFUSED: #${issueNumber} could not be updated on the tracker`,
        e instanceof Error ? e.message : String(e),
      ];
    }
    return null;
  }

  let failure: string[] | null;
  try {
    failure = writeAndEdit();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (failure) {
    for (const line of failure) console.error(line);
    process.exit(PROMOTION_EXIT);
  }

  console.log(`#${issueNumber} now declares it serves no criterion.`);
  console.log("board-snapshot reads it as a deliberate decline rather than a blank cell.");
  process.exit(0);
}

const result = promote(
  { issue, spec, outcome, symbol, module, projectRoot: ROOT, owner: currentScOwner(ROOT) },
  readScRegistry(),
);

if (!result.promoted) {
  console.error(`REFUSED ${result.refusal}: ${result.why}`);
  process.exit(PROMOTION_EXIT);
}

console.log(result.line);
for (const gap of result.unmeasured) console.log(`  UNMEASURED: ${gap}`);

// `specPath` from the lib, not a second `join` here. They disagreed on an
// absolute --spec, so the file the guard validated and the file this wrote
// were different files.
const target = specPath({ spec, projectRoot: ROOT });

// Guarded, like BOTH reads of this same file in lib/finding-promotion.ts.
// The first version left this one bare — the third of three reads, the two
// named in review repaired and the sibling left, which is the same two-of-
// three the statement fields were.
let content: string;
try {
  content = readFileSync(target, "utf8");
} catch (e) {
  console.error(`REFUSED SPEC_UNREADABLE: ${spec} could not be read: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(PROMOTION_EXIT);
}

// #1286, the same refusal create-sc makes: appending to a spec a generator
// owns writes a criterion that disappears at the next regeneration, having
// consumed an id nothing then declares. One decider, called from both CLIs.
//
// BEFORE the dry-run exit, not after. A preview that reports success for a
// run that would immediately refuse is not a preview — it is a second
// answer to "will this work", given by a path that never asked the question.
const early = maySpecBeWritten(content);
if (!early.allowed) {
  console.error(skipLine(target, early.reading));
  process.exit(PROMOTION_EXIT);
}

if (!write) {
  console.log(`\n(dry run — nothing written. Add --write to append to ${spec}.)`);
  process.exit(0);
}

// KEEP the result. `writeSpec` re-reads the target and runs its own
// `mayWrite` against those bytes, so it can refuse after the early
// `maySpecBeWritten(content)` above passed — the file changed between the
// two reads, which is the concurrent-session window
// `.claude/rules/parallel-sessions.md` is about. Discarding it prints
// "Appended to …" for a write that did not happen, and a false success is
// the one report this repository exists to stop producing.
//
// 18 of the 22 `writeSpec` callers in this tree discard it, `create-sc.ts`
// among them. That population is out of this pull request's scope and is
// filed separately rather than fixed here.
const wrote = writeSpec(target, `${content.trimEnd()}\n${result.line}\n`);
if (!wrote.written) {
  console.error(`REFUSED: ${wrote.refusal ?? `${spec} was not written, and gave no reason`}`);
  process.exit(PROMOTION_EXIT);
}
console.log(`Appended to ${spec}: ${result.line}`);
console.log(`  owner: ${currentScOwner(ROOT) ?? "(none — allocated above every reserved block)"}`);
console.log(`\nNow make #${issueNumber} name it: add "${result.id}" under its Criteria heading.`);
console.log("Until it does, criterion-inventory still reports the issue as serving nothing.");
