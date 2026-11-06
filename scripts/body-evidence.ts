#!/usr/bin/env bun
/**
 * body-evidence — compose a pull request's evidence from the run, or refuse a
 * body whose figures disagree with it (#1817).
 *
 * Usage:
 *   bun scripts/body-evidence.ts --emit  --output run.txt
 *   bun scripts/body-evidence.ts --check body.md --output run.txt
 *
 * `--output` is the SUITE OUTPUT, captured as the suite ran. It is never a
 * count: `scripts/record-suite-measurement.ts` removed `--failures` for the
 * reason this script inherits — the defect arrives through the one value a
 * caller still gets to choose. The parser is `lib/suite-run-reading.ts`, the
 * same one the gates use, so this cannot disagree with them about what a run
 * said.
 *
 * Capture the output first, in a separate command, then pass the file:
 *
 *   bun test 2>&1 | tee /tmp/run.txt
 *   bun scripts/body-evidence.ts --check pr-body.md --output /tmp/run.txt
 *
 * A heredoc composed in the same command as the check is invisible to it, the
 * same way it is invisible to the filing gate.
 *
 * ## Both halves, one binding
 *
 * `--emit` and `--check` are the composer and the checker, and they are the
 * same module on purpose. A composer in one file and a checker in another are
 * two deciders over one question, and a block the composer wrote that the
 * checker then refuses is how a guard gets switched off on its first honest
 * use. `lib/body-evidence.ts` holds the decision; this file only reads
 * arguments and chooses an exit code.
 */
import { readFileSync } from "fs";

import {
  BODY_EVIDENCE_EXIT,
  bodyEvidenceViolations,
  renderEvidenceBlock,
} from "../lib/body-evidence";
import { readSuiteRun } from "../lib/suite-run-reading";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i === -1 || i + 1 >= args.length ? undefined : args[i + 1];
}

const outputPath = flag("output");
const checkPath = flag("check");
const emit = args.includes("--emit");

if (!outputPath || (!emit && !checkPath)) {
  console.error(
    "usage: body-evidence --output <suite-output-file> (--emit | --check <body-file>)\n" +
      "  --output is the runner's OUTPUT, not a count. Capture it with `bun test 2>&1 | tee`.",
  );
  process.exit(BODY_EVIDENCE_EXIT);
}

let output: string;
try {
  output = readFileSync(outputPath, "utf8");
} catch (e) {
  // A file that cannot be read is UNMEASURED, and UNMEASURED refuses. It is
  // not an empty run — .claude/rules/config-access.md, Silent Default
  // Substitution: `0`, `{}` and "could not read" must not share an outcome.
  console.error(`UNMEASURED: cannot read --output ${outputPath}: ${(e as Error).message}`);
  process.exit(BODY_EVIDENCE_EXIT);
}

const run = readSuiteRun(output);

// The reason goes to stderr, never into the block. `renderEvidenceBlock`
// deliberately does not interpolate it: the reason quotes the runner's last
// output, so it can contain a figure-shaped phrase, and a block carrying one
// is a block the checker refuses (#1819). stdout stays pasteable; stderr
// carries the diagnostic.
if (run.status === "UNMEASURED") console.error(`UNMEASURED: ${run.reason}`);

if (emit) {
  console.log(renderEvidenceBlock(run));
  // Emitting over an unmeasured run is not a refusal — the block says
  // UNMEASURED in words, which is the honest thing to paste.
  process.exit(0);
}

let body: string;
try {
  body = readFileSync(checkPath as string, "utf8");
} catch (e) {
  // Symmetric with the --output read above, and #1819's first finding was
  // that it was not: an unreadable --check path threw an uncaught ENOENT and
  // printed a stack trace, in a script whose entire point is that a reading
  // which could not be taken is reported rather than crashed through.
  console.error(`UNMEASURED: cannot read --check ${checkPath}: ${(e as Error).message}`);
  process.exit(BODY_EVIDENCE_EXIT);
}
const violations = bodyEvidenceViolations(body, run);

if (violations.length === 0) {
  console.log(`body-evidence: OK — every count in ${checkPath} appears in the run.`);
  process.exit(0);
}

for (const v of violations) console.error(`body-evidence [${v.kind}]: ${v.message}`);
console.error(`\nThe block this run would produce:\n${renderEvidenceBlock(run)}`);
process.exit(BODY_EVIDENCE_EXIT);
