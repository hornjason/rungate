#!/usr/bin/env bun
/**
 * create-sc CLI — Generate matchable SC lines from structured input.
 *
 * Usage:
 *   bun scripts/create-sc.ts --pattern file-exists --params '{"file":"AGENTS.md"}'
 *   bun scripts/create-sc.ts --pattern file-exists --params '{"file":"AGENTS.md"}' --spec specs/MY-SPEC.md
 *   bun scripts/create-sc.ts --pattern file-exists --params '{...}' --spec specs/X.md --owner '#725'
 *   bun scripts/create-sc.ts --behavioral "<the owner's sentence>" --spec specs/MY-SPEC.md
 *   bun scripts/create-sc.ts --list
 *
 * `--spec` places the line straight after the spec's last criterion (#2845).
 * `--behavioral` writes the sentence as stated, with `(behavioral)`, through
 * the same allocator and the same bank write as a pattern; it takes no
 * `--pattern`.
 *
 * `--owner` names the entry in `specs/sc-reservations.json` to allocate from.
 * It defaults to this checkout's branch. An owner holding no block allocates
 * above every block in the store, which is the safe direction.
 *
 * Thin CLI consumer — all logic lives in lib/create-sc.ts.
 */
import { readFileSync, existsSync } from "fs";
import {
  allocateScNumber,
  behavioralStatement,
  generateSCText,
  listPatterns,
  formatSCLine,
  placeScLine,
} from "../lib/create-sc";
import { readScRegistry } from "./sync-sc-status";
import { describeReading } from "../lib/sc-id-cross-tree";
import { currentScOwner } from "../lib/sc-reservations";
import { skipLine } from "../lib/derived-spec";
import { maySpecBeWritten, writeSpec } from "../lib/write-spec";
import { join, relative, resolve, sep } from "path";
import { bankAfterAppend, writeDeferralBank, writeSpecWithBank } from "../lib/finding-promotion";

/** Same resolution sync-sc-status uses, so both halves read one tree. */
const ROOT = join(import.meta.dir, "..");

// ── Argument parsing ──────────────────────────────────────────

const args = process.argv.slice(2);

/**
 * The value after `--name`, or undefined when there is none. A next token
 * that is itself a flag is not a value (review round 1 of #2846):
 * `--behavioral --spec X` wrote "--spec" into the spec as a criterion.
 */
function getFlag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length || args[idx + 1].startsWith("--")) return undefined;
  return args[idx + 1];
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

// ── Main ──────────────────────────────────────────────────────

if (hasFlag("list")) {
  console.log(listPatterns());
  process.exit(0);
}

const patternName = getFlag("pattern");
const behavioral = getFlag("behavioral");
if (hasFlag("behavioral") && behavioral === undefined) {
  console.error('ERROR: --behavioral needs the criterion\'s sentence after it, as one argument: --behavioral "X happens"');
  process.exit(1);
}
if (patternName && behavioral !== undefined) {
  console.error("ERROR: give --behavioral or --pattern, not both: a behavioural criterion is written as stated, not from a pattern");
  process.exit(1);
}
if (!patternName && behavioral === undefined) {
  console.error("Usage: bun scripts/create-sc.ts --pattern <name> --params '<json>'");
  console.error('       bun scripts/create-sc.ts --behavioral "<sentence>"');
  console.error("       bun scripts/create-sc.ts --list");
  process.exit(1);
}

// Parse params
const paramsRaw = getFlag("params");
let params: Record<string, string> = {};
if (paramsRaw) {
  try {
    params = JSON.parse(paramsRaw);
  } catch {
    console.error(`ERROR: Invalid JSON in --params: ${paramsRaw}`);
    process.exit(1);
  }
}

// Validate and generate
try {
  // The only thing --behavioral changes: everything below, the allocation and
  // the bank write included, is one path for both (#2845).
  const statement = behavioral !== undefined ? behavioralStatement(behavioral) : generateSCText(patternName!, params);
  const specPath = getFlag("spec");

  if (specPath) {
    // Append to spec file
    if (!existsSync(specPath)) {
      console.error(`ERROR: Spec file not found: ${specPath}`);
      process.exit(1);
    }
    const content = readFileSync(specPath, "utf-8");
    // The whole namespace, not just this file: SC ids are global, and
    // allocating from one spec's content is what produced ten collisions
    // (#392). A spec outside specs/ still gets the local answer.
    //
    // BOTH halves of it (#399). The registry is specs only, and test fixtures
    // spell SC ids in the same namespace without appearing in any registry,
    // so an allocation that consults only the registry can mint a criterion
    // out of a number a fixture already depends on.
    //
    // And a THIRD half, which is the one the first two could not see (#503):
    // the registry is `specs/` in whichever working tree this command runs
    // in. Two sessions in two worktrees both read "highest + 1" correctly and
    // both got the same number.
    //
    // All three widths compose inside `allocateScNumber`, so this CLI cannot
    // assemble two of them and believe it asked.
    //
    // And a FOURTH, which none of the first three can be (#725): every one of
    // them reads ids that are already written down somewhere, and the four
    // collisions of 2026-10-19 were ids that had been decided on and not yet
    // typed. `specs/sc-reservations.json` is where a session declares a block
    // before consuming it; the owner is this checkout's branch, so a session
    // that reserved one is handed an id out of it and a session that did not
    // is handed one above every block in the store.
    //
    // `--owner` overrides the branch for the case the store is keyed by issue
    // rather than by branch. An owner matching no block is not an error: it
    // is the no-block path, which is the safe one.
    const owner = getFlag("owner") ?? currentScOwner(ROOT);
    const { number: scNumber, namespace } = allocateScNumber(ROOT, content, readScRegistry(), { owner });
    const scLine = formatSCLine(scNumber, statement);

    // #1286: appending to a spec a generator owns writes a criterion that
    // disappears at the next regeneration, having consumed an SC id that
    // nothing then declares. Refuse loudly rather than allocate into a file
    // that cannot keep it.
    const early = maySpecBeWritten(content);
    if (!early.allowed) {
      console.error(skipLine(specPath, early.reading));
      process.exit(1);
    }

    // Straight after the spec's last criterion, or at the end when it has none (#2845).
    const newContent = placeScLine(content, scLine);
    // A deferred spec's criteria count is banked, and SC-2734 refuses a bank
    // that disagrees with it. Decided BEFORE the spec is written, so a refusal
    // writes neither file. The path is a literal so the spec-write sweep
    // (#1584) can see this write targets the bank and not a spec.
    const bankPath = join(ROOT, ".claude/spec-deferral-ratchet.json");
    const specKey = relative(ROOT, resolve(specPath)).split(sep).join("/");
    const bankRead = existsSync(bankPath) ? readFileSync(bankPath, "utf-8") : null;
    const banked = bankAfterAppend(bankRead, specKey, content, newContent);
    if (!banked.ok) {
      console.error(`ERROR: ${banked.refusal}: ${banked.why}`);
      process.exit(1);
    }
    // Both through `writeSpec`, as finding-promotion does: the one write path
    // the spec-write sweep (#1552) allows for a path matching /spec/i. Both
    // or neither: a failed bank write puts the spec back.
    // #2300: the bank through its one write path, refusing if another session
    // moved it since `bankRead`. Each spec write carries the bytes it expects
    // to replace, which `writeSpecWithBank` supplies, so neither the write nor
    // its put-back can erase another session's change.
    const wrote = writeSpecWithBank(
      (p, c, e) => (p === bankPath ? writeDeferralBank(ROOT, c, bankRead) : writeSpec(p, c, { expected: e })),
      { path: specPath, before: content, after: newContent },
      { path: bankPath, text: banked.text },
    );
    if (!wrote.ok) {
      console.error(
        wrote.restored
          ? `ERROR: ${wrote.why}. Nothing was changed: ${specPath} is as it was.`
          : `ERROR: ${wrote.why}, and ${specPath} could not be put back: it states SC-${scNumber} and the bank does not. ` +
              `Remove that line, or move ${specKey}'s count in .claude/spec-deferral-ratchet.json by one.`,
      );
      process.exit(1);
    }
    console.log(`Appended to ${specPath}: ${scLine}`);
    if (banked.text !== null) console.log(`  deferral bank: ${specKey} moved with it (.claude/spec-deferral-ratchet.json)`);
    // What the number is a floor over, stated rather than implied. A clone on
    // another machine is outside anything this process can reach, and an
    // allocator that printed only the number would be claiming a guarantee it
    // cannot give (`.claude/rules/config-access.md`).
    console.log(`  namespace: ${describeReading(namespace)}`);
    console.log(`  owner: ${owner ?? "(none — allocated above every reserved block)"}`);
    for (const gap of namespace.unmeasured) console.log(`  UNMEASURED: ${gap}`);
  } else {
    // Output to stdout for piping
    const scLine = formatSCLine(0, statement);
    console.log(scLine);
  }
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`ERROR: ${message}`);
  process.exit(1);
}
