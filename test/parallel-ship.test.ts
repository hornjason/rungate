import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { execSync } from "child_process";
import { tmpdir } from "os";
import {
  createShipWorktree,
  allocatePort,
  generateContainerName,
  cleanupShipWorktree,
  shipLaunchArgs,
  shipLaunchRefusal,
} from "../scripts/parallel-ship";
import { SHIP_SKILL_FOLDERS, shipSkillPath } from "../lib/ship-skill-folder";
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

// Review of #2962: the launch names the new folder, so a machine that has only
// the old one (every machine until ADR-029 step 1 is run there) must not launch.
describe("#2949: parallel-ship refuses to launch where the skill is not installed under its new name", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });
  /** A `.claude` holding the named skill folders, each with a SKILL.md unless `bare`, the skills directory derived through the resolver. */
  function claudeWith(folders: string[], bare = false): string {
    const home = mkdtempSync(join(tmpdir(), "rg-2962-home-"));
    homes.push(home);
    const claude = join(home, ".claude");
    const skills = dirname(dirname(shipSkillPath(claude, "probe")));
    for (const f of folders) {
      mkdirSync(join(skills, f), { recursive: true });
      if (!bare) writeFileSync(join(skills, f, "SKILL.md"), "---\nname: probe\n---\n");
    }
    return claude;
  }
  const [NEW_NAME, OLD_NAME] = SHIP_SKILL_FOLDERS as readonly [string, string];

  test("only the old folder, or none: refused, naming why; the new folder, alone or beside the old: launched", () => {
    expect(shipLaunchRefusal(claudeWith([OLD_NAME])) ?? "").toContain("only under its old name");
    expect(shipLaunchRefusal(claudeWith([OLD_NAME])) ?? "").toContain("ADR-029 step 1");
    expect(shipLaunchRefusal(claudeWith([])) ?? "").toContain("no ship skill is installed");
    expect(shipLaunchRefusal(claudeWith([NEW_NAME]))).toBeNull();
    expect(shipLaunchRefusal(claudeWith([NEW_NAME, OLD_NAME]))).toBeNull();
  });

  test("a new folder with no SKILL.md is refused, naming the missing file", () => {
    for (const folders of [[NEW_NAME], [NEW_NAME, OLD_NAME]]) {
      const why = shipLaunchRefusal(claudeWith(folders, true)) ?? "";
      expect(why, folders.join(",")).toContain("holds no SKILL.md");
      expect(why, folders.join(",")).toContain("ADR-029 step 1");
    }
  });

  test("the script refuses before it makes any worktree, dry run included", () => {
    const claude = claudeWith([OLD_NAME]);
    const repo = mkdtempSync(join(tmpdir(), "rg-2962-repo-"));
    initFixtureRepo(repo);
    execSync("git commit --allow-empty -m init", { cwd: repo });
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "scripts", "parallel-ship.ts"), "dry-run", "42"], {
      cwd: repo,
      env: { ...process.env, HOME: dirname(claude) },
    });
    const err = new TextDecoder().decode(r.stderr);
    expect(r.exitCode, err).toBe(1);
    expect(err).toContain("parallel-ship: REFUSED");
    expect(err).toContain("only under its old name");
    const worktrees = execSync("git worktree list --porcelain", { cwd: repo, encoding: "utf-8" });
    expect(worktrees, "a worktree was made before the refusal").not.toContain("ship-42");
    rmSync(repo, { recursive: true, force: true });
  });
});
