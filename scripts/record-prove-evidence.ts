#!/usr/bin/env bun
/**
 * Build, check and write `prove-evidence.json` for `workflows/prove.js` (#2254).
 *
 *   bun scripts/record-prove-evidence.ts --work-dir <dir> --report <file> \
 *     --issue <n> --commit <sha> [--source <name>] [--after-observer reproducer|quinn]
 *
 * `workflows/*.js` cannot import (#69), so prove.js crosses a subprocess
 * boundary to reach the one contract: it writes a report — `issueNumber`,
 * `commitSHA`, `verdict`, `criteriaResults`, `reproduced` and, when the
 * reproducer observed one, `afterEvidence` — and this builds the artifact
 * through `recordProveEvidence`, the function B3 uses (#1559). The before-state
 * is read from the run's own `workflow-state.json`, never from the report.
 *
 * `--issue` and `--commit` are what prove.js holds in-process. The report is
 * transcribed by an agent, so a report naming a different issue or commit is
 * refused rather than trusted for anything else (review round 3, PR #2256).
 * `--after-observer` is the same kind of fact: who observed the after-state,
 * which decides whether a screenshot is evidence (#2262). Absent means the
 * reproducer, the observer that can report the least.
 *
 * Prints one JSON line: `{ written, verdict, reason? }`. Exit 0 means the
 * artifact was written; `verdict` is what it records, which may be a
 * downgrade of the report's, and `reason` says why. Any refusal exits
 * `EXIT_REFUSED` and writes nothing.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { AFTER_OBSERVERS, isAfterObserver, readBeforeState, recordProveEvidence } from "../gates/gate-executor";

export const EXIT_REFUSED = 2;

const KNOWN_FLAGS = new Set(["--work-dir", "--report", "--issue", "--commit", "--source", "--after-observer"]);

type Outcome = { written: true; verdict: string; reason?: string } | { written: false; reason: string };

function finish(out: Outcome): never {
  console.log(JSON.stringify(out));
  process.exit(out.written ? 0 : EXIT_REFUSED);
}

function refuse(reason: string): never {
  return finish({ written: false, reason });
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (!KNOWN_FLAGS.has(flag)) refuse(`unknown argument ${JSON.stringify(flag)}; known: ${[...KNOWN_FLAGS].join(", ")}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) refuse(`${flag} needs a value`);
    args[flag] = value;
    i++;
  }
  return args;
}

function readJson(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    return refuse(`could not read the ${what} at ${path}: ${(e as Error).message}`);
  }
}

function main(): never {
  const args = parseArgs(process.argv.slice(2));
  const workDir = args["--work-dir"];
  const reportPath = args["--report"];
  const issueArg = args["--issue"];
  const commitArg = args["--commit"];
  if (!workDir || !reportPath || !issueArg || !commitArg) {
    refuse("usage: --work-dir <dir> --report <file> --issue <n> --commit <sha> [--source <name>] [--after-observer reproducer|quinn]");
  }
  const afterObserver = args["--after-observer"] ?? "reproducer";
  if (!isAfterObserver(afterObserver)) {
    refuse(`--after-observer ${JSON.stringify(afterObserver)} is not one of ${Object.keys(AFTER_OBSERVERS).join("|")}`);
  }

  const report = readJson(reportPath, "report");
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    refuse(`the report at ${reportPath} is not a JSON object`);
  }
  const r = report as Record<string, unknown>;
  if (typeof r.issueNumber !== "number" || !Number.isInteger(r.issueNumber)) {
    refuse(`the report's issueNumber ${JSON.stringify(r.issueNumber)} is not an integer`);
  }
  if (typeof r.commitSHA !== "string" || r.commitSHA.trim() === "") {
    refuse(`the report's commitSHA ${JSON.stringify(r.commitSHA)} is empty`);
  }
  if (String(r.issueNumber) !== issueArg) {
    refuse(`the report's issueNumber ${JSON.stringify(r.issueNumber)} is not the run's --issue ${issueArg}`);
  }
  if (r.commitSHA !== commitArg) {
    refuse(`the report's commitSHA ${JSON.stringify(r.commitSHA)} is not the run's --commit ${commitArg}`);
  }

  // A corrupt state is never a missing one: absent reads UNMEASURED,
  // unreadable refuses (.claude/rules/config-access.md says the same of config).
  const statePath = join(workDir, "workflow-state.json");
  const state = existsSync(statePath) ? readJson(statePath, "workflow-state.json") : {};
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    refuse(`workflow-state.json at ${statePath} is not a JSON object`);
  }

  const record = recordProveEvidence(r, {
    issueNumber: r.issueNumber as number,
    workDir,
    beforeReading: readBeforeState(state as Record<string, unknown>),
    readCommit: () => r.commitSHA as string,
    source: args["--source"] ?? "prove-workflow",
    afterObserver,
  });
  if (!record.written) refuse(record.reason);
  const downgrade = record.artifact.verdictDowngrade;
  return finish(
    downgrade
      ? { written: true, verdict: record.artifact.verdict, reason: downgrade.reason }
      : { written: true, verdict: record.artifact.verdict },
  );
}

if (import.meta.main) main();
