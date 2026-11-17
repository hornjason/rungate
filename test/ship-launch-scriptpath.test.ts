/**
 * #2288 / SC-2773 (HARNESS-STANDARD.md): every ship `scriptPath` documented in
 * this repository names the generated launch file.
 *
 * `workflows/ship.js` is over the Workflow tool's script cap, so a launch
 * pointed at it fails before the run starts (ADR-017). #2287 built
 * `workflows/ship.run.js` under the cap; this is the half that makes the
 * instructions say so. The ship skill outside the repository is changed by
 * hand (Jason's call, 2026-11-15) and is not read here.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join, relative } from "path";

import { SHIP_LAUNCH } from "../scripts/build-workflow-launch";
import { SHIP_LAUNCH_SCRIPT, shipWorkflowRule } from "../lib/ship-mode";

const REPO = join(import.meta.dir, "..");

/**
 * Records, not instructions: fixtures under `test/`, and the dated history in
 * `reference/`, `docs/research/` and `docs/council/`. Everything else that
 * tells a reader how to launch ship is scanned.
 */
const HISTORY = /^(test|reference|docs\/research|docs\/council)\//;

/** A `scriptPath` naming a ship file on the same line. */
const SCRIPT_PATH = /scriptPath[^\n]{0,60}?workflows\/ship(\.run)?\.js/g;

function sites(): { file: string; launch: boolean }[] {
  const files = execFileSync("git", ["ls-files"], { cwd: REPO, encoding: "utf-8" })
    .split("\n")
    .filter(f => f !== "" && !HISTORY.test(f) && /\.(md|ts|js|json|ya?ml)$/.test(f));
  const found: { file: string; launch: boolean }[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(REPO, file), "utf-8");
    } catch (error) {
      // A tracked path deleted in the working tree is not a site; any other
      // read failure is, so it is rethrown rather than read as "no sites".
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const m of text.matchAll(SCRIPT_PATH)) found.push({ file, launch: m[1] === ".run" });
  }
  return found;
}

describe("#2288 / SC-2773: ship is launched from the generated file", () => {
  test("the one constant names the file the build writes", () => {
    expect(SHIP_LAUNCH_SCRIPT).toBe(relative(REPO, SHIP_LAUNCH));
    expect(SHIP_LAUNCH_SCRIPT).toBe("workflows/ship.run.js");
  });

  test("no documented scriptPath still names workflows/ship.js", () => {
    const all = sites();
    // The scan has to be seeing the sites at all, or an empty stale list is
    // vacuous — so name them. `lib/ship-mode.ts` is not here: it writes the
    // path through `SHIP_LAUNCH_SCRIPT`, which the case below reads.
    const launchFiles = [...new Set(all.filter(s => s.launch).map(s => s.file))].sort();
    expect(launchFiles, "the scan is not reading the documented launch sites").toEqual(
      [".claude/rules/ship-workflow.md", "CLAUDE.md", "HARNESS.md", "workflows/ship-and-heal.js"].sort(),
    );
    expect(all.filter(s => !s.launch).map(s => s.file)).toEqual([]);
  });

  test("both modes of the generated ship rule name the launch file", () => {
    const harness = shipWorkflowRule({ mode: "harness" });
    const direct = shipWorkflowRule({ mode: "direct", since: "2026-10-19", reason: "x" });
    expect(harness).toContain(`scriptPath: "${SHIP_LAUNCH_SCRIPT}"`);
    expect(direct).toContain(`scriptPath: "${SHIP_LAUNCH_SCRIPT}"`);
  });
});
