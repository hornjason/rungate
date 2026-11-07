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

function required(name: string): string {
  const v = getFlag(name);
  if (v === undefined) {
    console.error(`ERROR: --${name} is required`);
    process.exit(PROMOTION_EXIT);
  }
  return v;
}

const issueNumber = Number(required("issue"));
const spec = required("spec");
const outcome = required("outcome");
const symbol = required("symbol");
const module = required("module");
const write = args.includes("--write");

// The issue's own text decides ALREADY_SERVES, so a title typed by hand here
// would let a promotion through that the board can see is a second criterion
// for one piece of work. Read it from the tracker.
const issue: PromotableIssue = await (async () => {
  // DELETE the key, do not blank it. `GH_TOKEN: ""` leaves it present, and
  // what a tool does with a present-but-empty credential is its own choice
  // rather than ours — measured on gh 2.97.0 it falls through to the
  // keychain, so this is not a live failure here, but the intent is
  // `env -u GH_TOKEN` and only deletion spells that in every version.
  const env = { ...process.env };
  delete env.GH_TOKEN;
  const proc = Bun.spawn(
    ["gh", "issue", "view", String(issueNumber), "--json", "number,title,body"],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe", env },
  );
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    console.error(`ERROR: could not read #${issueNumber} from the tracker`);
    console.error(await new Response(proc.stderr).text());
    process.exit(PROMOTION_EXIT);
  }
  return JSON.parse(out) as PromotableIssue;
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

if (!write) {
  console.log(`\n(dry run — nothing written. Add --write to append to ${spec}.)`);
  process.exit(0);
}

// `specPath` from the lib, not a second `join` here. They disagreed on an
// absolute --spec, so the file the guard validated and the file this wrote
// were different files.
const target = specPath({ spec, projectRoot: ROOT });
const content = readFileSync(target, "utf8");

// #1286, the same refusal create-sc makes: appending to a spec a generator
// owns writes a criterion that disappears at the next regeneration, having
// consumed an id nothing then declares. One decider, called from both CLIs.
const early = maySpecBeWritten(content);
if (!early.allowed) {
  console.error(skipLine(target, early.reading));
  process.exit(PROMOTION_EXIT);
}

writeSpec(target, `${content.trimEnd()}\n${result.line}\n`);
console.log(`Appended to ${spec}: ${result.line}`);
console.log(`  owner: ${currentScOwner(ROOT) ?? "(none — allocated above every reserved block)"}`);
console.log(`\nNow make #${issueNumber} name it: add "${result.id}" under its Criteria heading.`);
console.log("Until it does, criterion-inventory still reports the issue as serving nothing.");
