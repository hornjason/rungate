#!/bin/bash
# DIAGNOSTIC for #2596, never merged: turn on the API taps for the suite, and
# print each shard's record when the suite finishes.
set -euo pipefail
bun scripts/ci-api-census.ts --install-gh-tap "$RUNNER_TEMP/gh-tap"
echo "$RUNNER_TEMP/gh-tap" >> "$GITHUB_PATH"
echo "API-TAP-START" > "$RUNNER_TEMP/api-tap.log"
# A global afterAll, registered from a preload, runs once when bun test ends.
# Only the top-level runner prints: its parent is the step's shell, while a
# bun test a test spawns has bun as its parent and would print the record twice.
cat > "$RUNNER_TEMP/tap-print.ts" <<'TS'
import { readFileSync } from "fs";
let top = false;
try { top = !readFileSync(`/proc/${process.ppid}/comm`, "utf-8").trim().startsWith("bun"); } catch { top = false; }
if (top && process.env.RUNGATE_API_TAP) {
  try {
    const { afterAll } = await import("bun:test");
    afterAll(() => {
      const rec = readFileSync(process.env.RUNGATE_API_TAP!, "utf-8");
      console.log(`API-TAP-PRINT ${rec.split("\n").filter(Boolean).length} lines follow`);
      for (const l of rec.split("\n")) if (l) console.log(l);
    });
  } catch { /* not a test runner: nothing to print */ }
}
TS
echo "RUNGATE_API_TAP=$RUNNER_TEMP/api-tap.log" >> "$GITHUB_ENV"
echo "BUN_OPTIONS=--preload=$GITHUB_WORKSPACE/scripts/api-call-tap.ts --preload=$RUNNER_TEMP/tap-print.ts" >> "$GITHUB_ENV"
echo "API taps on: record at $RUNNER_TEMP/api-tap.log"
