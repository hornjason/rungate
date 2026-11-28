#!/usr/bin/env bun

import { execSync, spawn } from "child_process";
import { rmSync, existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";

import { readProjectSlug } from "../lib/config-readers.js";
import { SHIP_SKILL_FOLDERS, shipSkillFolders } from "../lib/ship-skill-folder";

export interface ShipJob {
  issue: number;
  worktreePath: string;
  port: number;
  containerName: string;
  status: "pending" | "running" | "done" | "failed";
}

export function createShipWorktree(projectRoot: string, issue: number): string {
  const worktreePath = `/tmp/ship-${issue}`;
  const branchName = `ship-${issue}`;

  cleanupShipWorktree(projectRoot, issue);

  execSync(`git worktree add -b ${branchName} ${worktreePath} main`, {
    cwd: projectRoot,
    stdio: "inherit",
  });

  return worktreePath;
}

export function allocatePort(index: number, basePort: number = 7776): number {
  return basePort + index;
}

export function generateContainerName(slug: string, issue: number): string {
  return `${slug}-test-${issue}`;
}

export function cleanupShipWorktree(projectRoot: string, issue: number): void {
  const worktreePath = `/tmp/ship-${issue}`;
  const branchName = `ship-${issue}`;

  try { rmSync(worktreePath, { recursive: true, force: true }); } catch {}
  try { execSync(`git worktree remove ${worktreePath} --force`, { cwd: projectRoot, stdio: "pipe" }); } catch {}
  try { execSync(`git branch -D ${branchName}`, { cwd: projectRoot, stdio: "pipe" }); } catch {}
}

/**
 * Exported for `test/config-access-adoption.test.ts`: the slug names a
 * worktree directory, so "which layout did this come from" is observable as a
 * path and worth asserting rather than asserting the import.
 */
export function getProjectSlug(projectRoot: string): string {
  // The "project" default stays here, where the collision is visible — two
  // unconfigured repos sharing it would name the same worktree.
  return readProjectSlug(projectRoot) ?? "project";
}

/**
 * What `claude` is launched with for one issue (#2949): the harness skill by
 * its name, which is its folder's new name (ADR-029). The old name is Claude
 * Code's built-in slash command, so a session launched with it ran the
 * built-in and never the harness. The launch and the dry run both read this.
 */
export function shipLaunchArgs(job: ShipJob): string[] {
  return ["--bg", "--project", job.worktreePath, `/${SHIP_SKILL_FOLDERS[0]} ${job.issue}`];
}

/**
 * Why no session may be launched from this machine, or `null` (review of
 * #2962). The launch names the skill by its new folder name, so where only
 * the old folder is installed, the command names no skill; and the old name
 * is Claude Code's built-in. Sessions are detached with their output
 * discarded, so either way nothing would report it. Asked once, before any
 * worktree is made.
 */
export function shipLaunchRefusal(claudeDir: string): string | null {
  const installed = shipSkillFolders(claudeDir);
  if (installed.length > 0 && basename(installed[0]!) === SHIP_SKILL_FOLDERS[0]) {
    // Review round 2 of #2962: a folder is not a skill. An empty one, from a
    // copy that stopped halfway or a stray mkdir, names nothing either.
    if (existsSync(join(installed[0]!, "SKILL.md"))) return null;
    return `${installed[0]} holds no SKILL.md, so /${SHIP_SKILL_FOLDERS[0]} would name no skill. Finish copying the folder (ADR-029 step 1), then run this again`;
  }
  return installed.length === 0
    ? `no ship skill is installed under ${claudeDir}, so /${SHIP_SKILL_FOLDERS[0]} would name no skill`
    : `the ship skill is installed only under its old name (${installed[0]}), so /${SHIP_SKILL_FOLDERS[0]} would ` +
        `name no skill, and the old name is Claude Code's built-in. Copy the folder to its new name ` +
        `(ADR-029 step 1), then run this again`;
}

function launchShipSession(job: ShipJob): void {
  const cmd = "claude";
  const args = shipLaunchArgs(job);

  console.log(`  Launching: ${cmd} ${args.join(" ")}`);

  const child = spawn(cmd, args, {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  job.status = "running";
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("Usage:");
    console.error("  bun scripts/parallel-ship.ts <issue1> <issue2> ...   # ship issues in parallel");
    console.error("  bun scripts/parallel-ship.ts cleanup <issue1> ...    # clean up worktrees");
    console.error("  bun scripts/parallel-ship.ts status                  # show running sessions");
    console.error("  bun scripts/parallel-ship.ts dry-run <issue1> ...    # preview without launching");
    process.exit(1);
  }

  const projectRoot = process.cwd();
  const slug = getProjectSlug(projectRoot);

  if (args[0] === "cleanup") {
    const issues = args.slice(1).map((a) => parseInt(a, 10));
    if (issues.length === 0) {
      console.error("Usage: bun scripts/parallel-ship.ts cleanup <issue1> <issue2> ...");
      process.exit(1);
    }
    for (const issue of issues) {
      console.log(`Cleaning up ship-${issue}...`);
      cleanupShipWorktree(projectRoot, issue);
    }
    console.log("Done.");
    return;
  }

  if (args[0] === "status") {
    try {
      execSync("claude agents", { stdio: "inherit" });
    } catch {
      console.log("No running claude sessions found (or claude CLI not available).");
    }
    return;
  }

  const dryRun = args[0] === "dry-run";
  const issueArgs = dryRun ? args.slice(1) : args;
  const issues = issueArgs.map((arg) => parseInt(arg, 10)).filter((n) => !isNaN(n));

  if (issues.length === 0) {
    console.error("No valid issue numbers provided.");
    process.exit(1);
  }

  // Review of #2962: before any worktree is made, and for a dry run too, since
  // a dry run that shows a launch which would run nothing is a false preview.
  const refusal = shipLaunchRefusal(join(homedir(), ".claude"));
  if (refusal !== null) {
    console.error(`parallel-ship: REFUSED — ${refusal}.`);
    process.exit(1);
  }

  const jobs: ShipJob[] = issues.map((issue, index) => ({
    issue,
    worktreePath: createShipWorktree(projectRoot, issue),
    port: allocatePort(index),
    containerName: generateContainerName(slug, issue),
    status: "pending" as const,
  }));

  console.log(`\n=== Parallel Ship: ${jobs.length} issue(s) ===\n`);

  for (const job of jobs) {
    console.log(`Issue #${job.issue}:`);
    console.log(`  Worktree: ${job.worktreePath}`);
    console.log(`  Port: ${job.port}`);
    console.log(`  Container: ${job.containerName}`);

    if (dryRun) {
      console.log(`  [dry-run] Would launch: claude ${shipLaunchArgs(job).map(a => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);
    } else {
      launchShipSession(job);
    }
    console.log();
  }

  if (!dryRun) {
    console.log("All sessions launched. Monitor with:");
    console.log("  claude agents");
    console.log("\nCleanup when done:");
    console.log(`  bun scripts/parallel-ship.ts cleanup ${issues.join(" ")}`);
  }
}

if (import.meta.main) {
  main();
}
