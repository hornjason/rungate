import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { tmpdir } from "os";
import {
  createShipWorktree,
  allocatePort,
  generateContainerName,
  cleanupShipWorktree,
  shipLaunchArgs,
} from "../scripts/parallel-ship";
import { SHIP_SKILL_FOLDERS } from "../lib/ship-skill-folder";
import { initFixtureRepo, commitFixture } from "./helpers/git-fixture";

describe("parallel-ship", () => {
  let testRepo: string;

  beforeEach(() => {
    // Create a temporary git repository for testing
    testRepo = mkdtempSync(join(tmpdir(), "parallel-ship-test-"));
    // Identity comes from initFixtureRepo; the explicit config lines that were
    // here overrode it immediately (#84).
    initFixtureRepo(testRepo);
    execSync("git commit --allow-empty -m 'Initial commit'", { cwd: testRepo });
  });

  afterEach(() => {
    // Clean up any worktrees created during tests
    try {
      const worktrees = execSync("git worktree list --porcelain", { cwd: testRepo }).toString();
      const worktreePaths = worktrees
        .split("\n")
        .filter((line) => line.startsWith("worktree /tmp/ship-"))
        .map((line) => line.replace("worktree ", ""));

      for (const path of worktreePaths) {
        try {
          rmSync(path, { recursive: true, force: true });
        } catch (error) {
          // Path may not exist
        }
      }
    } catch (error) {
      // Repository may not exist
    }

    // Clean up test repository
    if (testRepo) {
      rmSync(testRepo, { recursive: true, force: true });
    }
  });

  describe("createShipWorktree", () => {
    test("creates a worktree at /tmp/ship-{issue}", () => {
      const issue = 512;
      const worktreePath = createShipWorktree(testRepo, issue);

      expect(worktreePath).toBe(`/tmp/ship-${issue}`);

      // Verify worktree was created
      const worktrees = execSync("git worktree list", { cwd: testRepo }).toString();
      expect(worktrees).toContain(`/tmp/ship-${issue}`);
    });

    test("creates a branch named ship-{issue}", () => {
      const issue = 512;
      createShipWorktree(testRepo, issue);

      const branches = execSync("git branch", { cwd: testRepo }).toString();
      expect(branches).toContain(`ship-${issue}`);
    });
  });

  describe("allocatePort", () => {
    test("returns basePort + index", () => {
      expect(allocatePort(0, 7776)).toBe(7776);
      expect(allocatePort(1, 7776)).toBe(7777);
      expect(allocatePort(2, 7776)).toBe(7778);
    });

    test("uses default base port of 7776 when not specified", () => {
      expect(allocatePort(0)).toBe(7776);
      expect(allocatePort(3)).toBe(7779);
    });
  });

  describe("generateContainerName", () => {
    test("returns {slug}-test-{issue}", () => {
      expect(generateContainerName("rungate", 512)).toBe("rungate-test-512");
      expect(generateContainerName("my-project", 307)).toBe("my-project-test-307");
    });
  });

  describe("cleanupShipWorktree", () => {
    test("removes worktree and branch", () => {
      const issue = 512;
      createShipWorktree(testRepo, issue);

      // Verify worktree exists
      let worktrees = execSync("git worktree list", { cwd: testRepo }).toString();
      expect(worktrees).toContain(`/tmp/ship-${issue}`);

      // Clean up
      cleanupShipWorktree(testRepo, issue);

      // Verify worktree is removed
      worktrees = execSync("git worktree list", { cwd: testRepo }).toString();
      expect(worktrees).not.toContain(`/tmp/ship-${issue}`);

      // Verify branch is removed
      const branches = execSync("git branch", { cwd: testRepo }).toString();
      expect(branches).not.toContain(`ship-${issue}`);
    });
  });

  describe("port allocation for concurrent issues", () => {
    test("allocates unique ports for 3 concurrent issues", () => {
      const ports = [
        allocatePort(0, 7776),
        allocatePort(1, 7776),
        allocatePort(2, 7776),
      ];

      // All ports should be unique
      const uniquePorts = new Set(ports);
      expect(uniquePorts.size).toBe(3);

      // Ports should be sequential
      expect(ports).toEqual([7776, 7777, 7778]);
    });
  });
});

// #2949 (ADR-029): a parallel ship launches the harness skill by its new name.
// The old slash command is Claude Code's built-in, so a session launched with
// it ran the built-in and never the harness.
describe("#2949: parallel-ship launches the ship skill by its new name", () => {
  const job = { issue: 42, worktreePath: "/tmp/ship-42", port: 7776, containerName: "x-42", status: "pending" as const };

  test("the prompt it hands claude is the skill's name and the issue, after the project flag", () => {
    expect(SHIP_SKILL_FOLDERS[0]).toBe("ship-issue");
    expect(shipLaunchArgs(job)).toEqual(["--bg", "--project", "/tmp/ship-42", "/ship-issue 42"]);
  });

  test("the dry run prints the same arguments the launch uses, so the two cannot disagree", () => {
    const src = require("fs").readFileSync(join(import.meta.dir, "..", "scripts", "parallel-ship.ts"), "utf-8") as string;
    expect(src.match(/shipLaunchArgs\(job\)/g)?.length, "the launch and the dry run both build their arguments here").toBe(2);
    expect(src).not.toMatch(/`\/ship /);
  });
});
