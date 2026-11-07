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
 * `--outcome` and `--symbol` are the caller's judgement and this script does
 * not supply them — see the docblock of `lib/finding-promotion.ts` for why
 * there is no `--auto` that sweeps the backlog.
 *
 * Thin CLI consumer — all logic lives in lib/finding-promotion.ts.
 */
import { readFileSync } from "fs";
import { join } from "path";

import { promote, specPath, type PromotableIssue } from "../lib/finding-promotion";
import { readScRegistry } from "./sync-sc-status";
import { currentScOwner } from "../lib/sc-reservations";
import { ghWithoutGhToken } from "../lib/live-issues";
import { skipLine } from "../lib/derived-spec";
import { maySpecBeWritten, writeSpec } from "../lib/write-spec";

/** Same resolution create-sc uses, so both halves read one tree. */
const ROOT = join(import.meta.dir, "..");

/** Routed through one constant so a test can prove the refusal is observed. */
export const PROMOTION_EXIT = 1;

const args = process.argv.slice(2);

function getFlag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

/**
 * A required flag's value, refused by NAME when it is missing or is the next
 * flag.
 *
 * The second half is the one that bit: `getFlag` returns `args[idx + 1]`
 * unconditionally, so `--issue --spec x` hands back the string `"--spec"`
 * and the run continues on a value nobody passed. Every flag has this, not
 * just the one review named — the first four rounds of this pull request
 * were all "the named instance repaired, its siblings left", and `--issue`
 * was the fifth because the previous sweep covered the LIBRARY's fields and
 * stopped at the CLI's.
 */
function required(name: string): string {
  const v = getFlag(name);
  if (v === undefined) {
    console.error(`ERROR: --${name} is required`);
    process.exit(PROMOTION_EXIT);
  }
  if (v.startsWith("--")) {
    console.error(
      `ERROR: --${name} was given '${v}', which is the next flag. Its value is missing, ` +
        "and continuing would run against a value nobody passed.",
    );
    process.exit(PROMOTION_EXIT);
  }
  return v;
}

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
const spec = required("spec");
const outcome = required("outcome");
const symbol = required("symbol");
const module = required("module");
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
