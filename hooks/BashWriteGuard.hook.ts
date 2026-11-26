#!/usr/bin/env bun
/**
 * BashWriteGuard.hook.ts — PreToolUse on Bash
 *
 * Governing SCs: SC-370 (traceability), SC-371 (thin trigger, under 150 lines)
 *
 * TRIGGER: PreToolUse (matcher: Bash)
 *
 * Blocks Bash writes to the gate artifacts — `workflow-state.json`,
 * `.gate-salt`, `witnesses/` — and to hook sources, links naming either,
 * `chmod`/`chflags` on them, and `security` access to the gate-salt
 * Keychain entry.
 *
 * It is an accident guard, not a boundary (ADR-027). A reader of command
 * text cannot stop an agent that owns the files: a program written to a
 * file and then run walks past it. It stops the ordinary command that
 * writes a protected artifact by mistake, and stays out of the way of reads
 * and fixture work. CI decides merges; the controls that would stop a
 * determined agent (a sandbox write-deny, a key the agent cannot read) are
 * for a later decision.
 *
 * A protected name under a fixed scratch root is a fixture when a shell
 * write lands there by its real directory, and a command that makes a link
 * has no exemption. An interpreter body is refused when it names a
 * protected artifact beside a declared write verb, wherever it points.
 *
 * THE DECISION LIVES IN `lib/bash-write-guard.ts` (#1120), so it can be
 * swept over the real commands in this machine's transcripts.
 *
 * PORTABILITY (#713): every protected artifact is a rungate gate artifact,
 * both imports are rungate-owned and in `package.json` `files[]`. No
 * PAI-owned path is read.
 *
 * Issues: hornjason/pai-config#473, tuned there in
 * hornjason/pai-config#474 — a DIFFERENT repository from this one, whose
 * own #473/#474 are `lib/scaffold/steps.ts` bugs. Reworked in #1120.
 */

import { parseHookInput } from './lib/parseStdin';
import { decideBashWrite } from '../lib/bash-write-guard';

async function main() {
  const input = await parseHookInput();
  if (!input) process.exit(0);

  const cmd: string = input.tool_input?.command || '';
  if (!cmd) process.exit(0);

  let decision;
  try {
    decision = decideBashWrite(cmd);
  } catch (e) {
    // A guard that crashes must not thereby allow the thing it guards
    // (#1137). Scoped to a command that already names a protected artifact,
    // so a bug here refuses a narrow class rather than bricking the session.
    const touches = ['workflow-state.json', '.gate-salt', '/witnesses/', '.hook.ts', '.hook.sh'];
    if (!touches.some(t => cmd.includes(t))) process.exit(0);
    decision = {
      blocked: true,
      reason: `Refused: BashWriteGuard could not evaluate this command (${String(e)}).`,
    };
  }

  if (decision.blocked) {
    console.log(JSON.stringify({ decision: 'block', reason: decision.reason }));
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
