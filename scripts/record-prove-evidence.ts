#!/usr/bin/env bun
/**
 * Build, check and write `prove-evidence.json` for `workflows/prove.js` (#2254).
 *
 *   bun scripts/record-prove-evidence.ts --work-dir <dir> --report <file> [--source <name>]
 *
 * `workflows/*.js` cannot import (#69), so prove.js crosses a subprocess
 * boundary to reach the one contract: it writes a report — `issueNumber`,
 * `commitSHA`, `verdict`, `criteriaResults`, `reproduced` and, when the
 * reproducer observed one, `afterEvidence` — and this builds the artifact
 * through `recordProveEvidence`, the function B3 uses (#1559). The before-state
 * is read from the run's own `workflow-state.json`, never from the report.
 *
 * Prints one JSON line: `{ written, verdict, reason? }`. Exit 0 means the
 * artifact was written; `verdict` is what it records, which may be a
 * downgrade of the report's, and `reason` says why. Any refusal exits
 * `EXIT_REFUSED` and writes nothing.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { readBeforeState, recordProveEvidence } from "../gates/gate-executor";

export const EXIT_REFUSED = 2;

const KNOWN_FLAGS = new Set(["--work-dir", "--report", "--source"]);

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
  if (!workDir || !reportPath) refuse("usage: --work-dir <dir> --report <file> [--source <name>]");

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
