#!/usr/bin/env bun
/**
 * `rungate prompt-audit` (#2606, SC-2805): lint what this project's agents
 * load, say whose each finding is, and draft rungate's half as upstream
 * reports. It files nothing: every draft is a file for the user to read first
 * (`.claude/rules/reporting-upstream.md`).
 *
 * Usage: rungate prompt-audit [--project-root <dir>] [--out <dir>]
 *
 * Exit 0 with a report, findings or not; it is an audit, not a gate. Exit
 * `PROMPT_AUDIT_UNMEASURED_EXIT` when the tree is not one rungate rendered,
 * because nothing was measured and an empty report would say otherwise.
 */
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { formatAudit, promptAudit, upstreamBodies, writeUpstreamBodies } from "../lib/prompt-audit";
import { NotRenderedSurface } from "../lib/surface-lint";

export const PROMPT_AUDIT_UNMEASURED_EXIT = 2;

function arg(name: string, argv: string[]): string | null {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1] ?? null;
  const eq = argv.find(a => a.startsWith(`${name}=`));
  return eq === undefined ? null : eq.slice(name.length + 1);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const root = resolve(arg("--project-root", argv) ?? process.cwd());
  let audit;
  try {
    audit = promptAudit(root);
  } catch (e) {
    if (!(e instanceof NotRenderedSurface)) throw e;
    console.error(`prompt-audit: ${e.message}`);
    process.exit(PROMPT_AUDIT_UNMEASURED_EXIT);
  }
  console.log(formatAudit(audit));
  const bodies = upstreamBodies(audit);
  if (bodies.size === 0) {
    console.log("\nNo harness-owned finding, so no upstream draft was written.");
  } else {
    const out = resolve(arg("--out", argv) ?? mkdtempSync(join(tmpdir(), "rungate-prompt-audit-")));
    const written = writeUpstreamBodies(bodies, out);
    console.log(`\nUpstream drafts, one per lint, NOT filed:`);
    for (const p of written) console.log(`  ${p}`);
    console.log(
      "Fill in the Claim line, show each draft to your user, and file it only once they say yes. " +
        "How, and with which label: .claude/rules/reporting-upstream.md.",
    );
  }
}
