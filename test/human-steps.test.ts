/**
 * Covers SC-2749 (SPEC-TO-BOARD-PIPELINE-SPEC.md), #2051, ADR-014 row 6.
 *
 * `rungate scaffold` ends by printing each human step still owed as one
 * command — the project token secret, `RUNGATE_REQUIRE_CLOSING_REF`, and every
 * process check that runs but is not required on the default branch — and
 * prints `UNMEASURED` for any it could not read, never "done".
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { protectionFactsFromPayload, unreadableFacts } from "../lib/branch-protection";
import { CLI_COMMANDS } from "../lib/cli-commands";
import {
  BOARD_INIT_COMMAND,
  LIVE_PROBES,
  PROJECT_TOKEN_SECRET,
  REQUIRE_CLOSING_REF_VARIABLE,
  githubSlugOf,
  humanSteps,
  processChecksIn,
  wantedChecks,
  readHumanSteps,
  readBoardId,
  readOrigin,
  sshHostName,
  timed,
  type HumanStepProbes,
  type HumanStepReadings,
  type Run,
  type RunResult,
} from "../lib/scaffold/human-steps";

const ROOT = join(import.meta.dir, "..");
const read = <T>(value: T) => ({ kind: "READ", value }) as const;
const unmeasured = (why: string) => ({ kind: "UNMEASURED", why }) as const;

const BOARD = "PVT_kwDOtest";
const tokenRow = `UNMEASURED: whether ${PROJECT_TOKEN_SECRET} can write board ${BOARD}`;

const allSet: HumanStepReadings = {
  slug: read("o/n"),
  boardId: read(BOARD),
  secretPresent: read(true),
  requireClosingRef: read("true"),
  protection: read({ branch: "main", contexts: ["test", "closing-references"], statusChecks: "required-checks" }),
  processChecks: ["closing-references"],
  unreadableWorkflows: [],
};

describe("SC-2749: every human step still owed is one command", () => {
  test("nothing set: the secret, the variable and the unrequired check are each one OWED command", () => {
    const lines = humanSteps({
      ...allSet,
      secretPresent: read(false),
      requireClosingRef: read(null),
      protection: read({ branch: "main", contexts: ["test"], statusChecks: "required-checks" }),
    });
    expect(lines).toHaveLength(4);
    expect(lines[0]).toStartWith(`OWED: gh secret set ${PROJECT_TOKEN_SECRET} -R o/n`);
    expect(lines[3]).toStartWith(`${tokenRow} — no ${PROJECT_TOKEN_SECRET} is set`);
    expect(lines[1]).toStartWith(`OWED: gh variable set ${REQUIRE_CLOSING_REF_VARIABLE} -R o/n --body true`);
    expect(lines[2]).toStartWith(
      "OWED: gh api -X POST repos/o/n/branches/main/protection/required_status_checks/contexts -f 'contexts[]=closing-references'",
    );
  });

  // Review of #2154, round 2: the add-a-context call only works on a branch
  // that already requires checks. A fresh repository's branch is unprotected,
  // and the old line 404'd there — for exactly the audience it was written for.
  test("an unprotected branch gets one PUT that protects it and requires only the missing checks", () => {
    const lines = humanSteps({ ...allSet, protection: read({ branch: "main", contexts: [], statusChecks: "unprotected" }) });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toStartWith(tokenRow);
    expect(lines[0]).toStartWith("OWED: gh api -X PUT repos/o/n/branches/main/protection --input - <<<'");
    const body = JSON.parse(lines[0].match(/<<<'([^']*)'/)![1]);
    expect(body).toEqual({
      required_status_checks: { strict: false, contexts: ["closing-references"] },
      enforce_admins: null,
      required_pull_request_reviews: null,
      restrictions: null,
    });
    expect(lines[0]).not.toContain("-X POST");
  });

  test("a protected branch requiring no checks is never sent a call that would replace its rule", () => {
    const lines = humanSteps({ ...allSet, protection: read({ branch: "main", contexts: [], statusChecks: "no-required-checks" }) });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toStartWith(tokenRow);
    expect(lines[0]).toStartWith("OWED: require closing-references on main");
    expect(lines[0], "PUT replaces the existing protection; POST 404s without required checks").not.toMatch(/-X (PUT|POST)/);
  });

  // Review of #2362: with test and ai-review owed too, several missing at once
  // is the normal case, and each of the three branch states must name them all.
  describe("#2362 review: every missing check is owed, not only the first", () => {
    const three = ["closing-references", "test", "ai-review"];
    test("required-checks: one POST per missing check", () => {
      const lines = humanSteps({ ...allSet, processChecks: three, protection: read({ branch: "main", contexts: ["other"], statusChecks: "required-checks" }) });
      for (const c of three) expect(lines.filter(l => l.includes(`-f 'contexts[]=${c}'`))).toHaveLength(1);
    });
    test("unprotected: the PUT body requires all three", () => {
      const lines = humanSteps({ ...allSet, processChecks: three, protection: read({ branch: "main", contexts: [], statusChecks: "unprotected" }) });
      const body = JSON.parse(lines[0].match(/<<<'([^']*)'/)![1]);
      expect(body.required_status_checks.contexts).toEqual(three);
    });
    test("no-required-checks: the Settings line names all three", () => {
      const lines = humanSteps({ ...allSet, processChecks: three, protection: read({ branch: "main", contexts: [], statusChecks: "no-required-checks" }) });
      expect(lines[0]).toStartWith(`OWED: require ${three.join(", ")} on main`);
    });
  });

  test("the protection probe says which of the three a branch is", () => {
    expect(protectionFactsFromPayload("o/n", "main", "User", {}).statusChecks).toBe("no-required-checks");
    expect(protectionFactsFromPayload("o/n", "main", "User", { required_status_checks: { contexts: [] } }).statusChecks)
      .toBe("required-checks");
    const src = readFileSync(join(ROOT, "lib", "branch-protection.ts"), "utf-8");
    expect(src, "the unprotected return in githubProtectionProbe does not say so").toMatch(
      /if \(!isProtected\) \{\s*return \{[^}]*statusChecks: "unprotected"/,
    );
  });

  test("a variable set to anything but the string true is still owed", () => {
    for (const v of ["TRUE", "1", "yes", ""]) {
      expect(humanSteps({ ...allSet, requireClosingRef: read(v) })[0]).toStartWith(`OWED: gh variable set`);
    }
  });

  test("an unreadable reading is UNMEASURED with its reason, never folded into nothing owed", () => {
    const lines = humanSteps({
      ...allSet,
      secretPresent: unmeasured("HTTP 403: Resource not accessible"),
      protection: unmeasured("GET …/protection returned 403"),
    });
    expect(lines).toEqual([
      `UNMEASURED: ${PROJECT_TOKEN_SECRET} — HTTP 403: Resource not accessible`,
      "UNMEASURED: required checks (closing-references) — GET …/protection returned 403",
      `${tokenRow} — the secret could not be read, so it is not known that there is a token to ask about`,
    ]);
    expect(lines.join("\n")).not.toMatch(/none owed|done/i);
  });

  test("no GitHub repository at all is one UNMEASURED line, not a clean report", () => {
    const lines = humanSteps({ ...allSet, slug: read(null) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("UNMEASURED: human steps");
  });

  // SC-2793 made the token row UNMEASURED whenever a board is set: GitHub never
  // returns a secret's value, so no scaffold run can say the token writes the
  // board. Everything else in place leaves that row alone, and it is never done.
  test("everything else in place leaves only the token row, which is never done", () => {
    const lines = humanSteps(allSet);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith(tokenRow);
    expect(lines.join("\n")).not.toMatch(/none owed|\bdone\b/i);
  });
});

describe("SC-2749: a read that never answers is UNMEASURED, not a hung scaffold", () => {
  test("timed rejects after its bound, naming what it waited for", async () => {
    // Review of #2154: the secret and variable reads had no bound, and the
    // scaffold awaits them on every run.
    const never = new Promise<never>(() => {});
    await expect(timed(never, "GET the secret", 20)).rejects.toThrow("GET the secret did not answer within 20ms");
    expect(await timed(Promise.resolve(7), "fast", 20)).toBe(7);
  });

  test("a read that answers clears its deadline instead of leaving it to fire", async () => {
    // Review of #2154, round 2: the losing timer still fired up to 15s later.
    const real = globalThis.clearTimeout;
    let cleared = 0;
    globalThis.clearTimeout = ((h: Parameters<typeof real>[0]) => { cleared++; return real(h); }) as typeof real;
    try {
      expect(await timed(Promise.resolve(7), "fast", 10_000)).toBe(7);
    } finally {
      globalThis.clearTimeout = real;
    }
    expect(cleared, "the winning branch left its timer armed").toBeGreaterThan(0);
  });

  test("both live reads go through the bound", () => {
    const src = readFileSync(join(ROOT, "lib", "scaffold", "human-steps.ts"), "utf-8");
    const calls = src.match(/\.rest\.actions\.getRepo(Secret|Variable)\(/g) ?? [];
    const bounded = src.match(/timed\(\s*createGitHubClient\(\)\.rest\.actions\.getRepo(Secret|Variable)\(/g) ?? [];
    expect(calls.length, "the scan found no live read, so it measured nothing").toBe(2);
    expect(bounded.length, "a live read is not the first argument of timed(").toBe(calls.length);
  });
});

describe("SC-2749: the readings come from the tree and the probes, and the scaffold prints them", () => {
  const probes = (over: Partial<HumanStepProbes> = {}): HumanStepProbes => ({
    slug: () => read("o/n"),
    boardId: () => read(null),
    secret: async () => read(false),
    variable: async () => read(null),
    protection: async slug => ({
      ...unreadableFacts(slug, ""),
      unreadable: null,
      branch: "main",
      contexts: [],
      statusChecks: "unprotected" as const,
    }),
    ...over,
  });

  test("the process checks are read from the workflows this tree has", async () => {
    const root = mkdtempSync(join(tmpdir(), "rg-human-steps-"));
    try {
      expect((await readHumanSteps(root, probes())).processChecks, "a tree with no workflow defines no check").toEqual([]);
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(root, ".github", "workflows", "closing-references.yml"),
        "on: pull_request\njobs:\n  closing-references:\n    runs-on: ubuntu-24.04\n    steps: []\n",
      );
      expect((await readHumanSteps(root, probes())).processChecks).toEqual(["closing-references"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the probe's protection state reaches the reading, and a probe that does not say is UNMEASURED", async () => {
    const r = await readHumanSteps(ROOT, probes());
    expect(r.protection).toEqual(read({ branch: "main", contexts: [], statusChecks: "unprotected" }));
    const silent = await readHumanSteps(
      ROOT,
      probes({ protection: async slug => ({ ...unreadableFacts(slug, ""), unreadable: null, branch: "main", contexts: [] }) }),
    );
    expect(silent.protection.kind).toBe("UNMEASURED");
  });

  test("an unreadable protection probe reaches the report as UNMEASURED", async () => {
    const r = await readHumanSteps(ROOT, probes({ protection: async slug => unreadableFacts(slug, "no credential") }));
    expect(r.protection).toEqual(unmeasured("no credential"));
  });

  test("a scaffold run ends with the human steps", () => {
    // A tree with no GitHub remote, so the live reading is the no-repository
    // line and nothing reaches the network.
    const root = mkdtempSync(join(tmpdir(), "rg-human-steps-run-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: root });
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "c", version: "0.0.0" }));
      const r = spawnSync("bun", [join(ROOT, "scripts", "scaffold-project.ts"), root, "--fix"], {
        encoding: "utf-8",
        timeout: 120_000,
      });
      const out = `${r.stdout}${r.stderr}`;
      expect(out, "the scaffold printed no human-steps section").toContain("Human steps owed on GitHub:");
      expect(out).toContain("UNMEASURED: human steps — the origin remote names no GitHub repository");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 150_000);
});

describe("#2161: a reading that cannot be taken is UNMEASURED, never read against the wrong forge or crashed on", () => {
  test("githubSlugOf accepts a github.com remote in every spelling, and nothing else", () => {
    // An identity resolver, so the case reads the parser and not this
    // machine's ssh or ~/.ssh/config (review of PR #2187).
    const literal = (h: string) => read(h);
    for (const url of [
      "git@github.com:o/n.git",
      "https://github.com/o/n",
      "https://x:token@github.com/o/n.git",
      "ssh://git@github.com/o/n.git",
      "https://GitHub.com/O/N.git",
    ]) expect(githubSlugOf(url, literal), url).toEqual(read("o/n"));
    for (const url of [
      "git@gitlab.com:o/n.git",
      "https://gitlab.com/o/n",
      "https://github.com.evil.com/o/n",
      "/tmp/some/fixture.git",
      "",
    ]) expect(githubSlugOf(url, literal), url).toEqual(read(null));
  });

  test("a live read of a gitlab origin is the no-repository line and calls no GitHub probe", async () => {
    const root = mkdtempSync(join(tmpdir(), "rg-human-steps-gitlab-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: root });
      // https, so the live read never asks ssh and does not depend on this machine's ssh.
      spawnSync("git", ["remote", "add", "origin", "https://gitlab.com/org/proj.git"], { cwd: root });
      const called: string[] = [];
      const r = await readHumanSteps(root, {
        slug: LIVE_PROBES.slug,
        boardId: () => read(null),
        secret: async () => (called.push("secret"), read(true)),
        variable: async () => (called.push("variable"), read("true")),
        protection: async slug => (called.push("protection"), unreadableFacts(slug, "")),
      });
      expect(r.slug).toEqual(read(null));
      expect(called, "a GitHub probe ran for a non-GitHub origin").toEqual([]);
      expect(humanSteps(r)[0]).toStartWith("UNMEASURED: human steps");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Round 1 of PR #2162: the no-repository early return swallowed it.
  // Round 2 of PR #2162: the gitlab case alone cannot tell "not GitHub" from
  // "the remote was never read". A real github.com remote must come through.
  test("a live read of a github.com origin resolves its slug through git config", async () => {
    const root = mkdtempSync(join(tmpdir(), "rg-human-steps-github-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: root });
      spawnSync("git", ["remote", "add", "origin", "git@github.com:Some-Owner/Some-Repo.git"], { cwd: root });
      expect(LIVE_PROBES.slug(root)).toEqual(read("some-owner/some-repo"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Skipped, and reported as skipped, under root: root reads through any mode,
  // so the case would pass having exercised nothing (round 3 of PR #2162).
  test.skipIf(process.getuid?.() === 0)("a stat error other than not-found is UNMEASURED, never read as an absent workflow", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-human-steps-eacces-"));
    const dir = join(root, ".github", "workflows");
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "closing-references.yml"), "jobs:\n  closing-references: {}\n");
      chmodSync(dir, 0o000);
      const { checks, unreadable } = processChecksIn(root);
      expect(checks).toEqual([]);
      expect(unreadable.join("\n")).toMatch(/closing-references\.yml could not be read/);
    } finally {
      chmodSync(dir, 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #2361: rungate's own main requires test and ai-review as well as
  // closing-references; GitHub's auto-merge waits only for required checks.
  test("#2361: the generated test and ai-review checks are owed as required, not only closing-references", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-human-steps-2361-"));
    try {
      const dir = join(root, ".github", "workflows");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "closing-references.yml"), "jobs:\n  closing-references:\n    runs-on: x\n");
      writeFileSync(join(dir, "ci.yml"), "jobs:\n  test-shard:\n    runs-on: x\n  test:\n    runs-on: x\n");
      writeFileSync(join(dir, "ai-review.yml"), "jobs:\n  ai-review:\n    runs-on: x\n");
      expect(processChecksIn(root).checks.sort()).toEqual(["ai-review", "closing-references", "test"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("#2362 review: two contexts in one workflow are both kept, and an all-jobs entry is never narrowed", () => {
    const both = wantedChecks([], [{ workflow: "ci.yml", context: "test" }, { workflow: "ci.yml", context: "lint" }]);
    expect([...(both.get("ci.yml") ?? [])].sort()).toEqual(["lint", "test"]);
    for (const order of [
      wantedChecks(["ci.yml"], [{ workflow: "ci.yml", context: "test" }]),
      wantedChecks([], [{ workflow: "ci.yml", context: "test" }]),
    ]) expect(order.has("ci.yml")).toBe(true);
    expect(wantedChecks(["ci.yml"], [{ workflow: "ci.yml", context: "test" }]).get("ci.yml")).toBeNull();
  });

  test("#2361: a workflow without the named job owes nothing for it, and a matrix job is never owed", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-human-steps-2361b-"));
    try {
      const dir = join(root, ".github", "workflows");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "ci.yml"), "jobs:\n  build:\n    runs-on: x\n  test-shard:\n    runs-on: x\n");
      expect(processChecksIn(root).checks).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an unreadable workflow is still reported when there is no GitHub origin", () => {
    const lines = humanSteps({ ...allSet, slug: read(null), unreadableWorkflows: [".github/workflows/closing-references.yml could not be read (EISDIR)"] });
    expect(lines[0]).toStartWith("UNMEASURED: human steps");
    expect(lines.join("\n")).toContain("UNMEASURED: process checks — .github/workflows/closing-references.yml could not be read");
  });

  test("an unreadable process workflow is an UNMEASURED line naming it, and the read completes", async () => {
    const root = mkdtempSync(join(tmpdir(), "rg-human-steps-unreadable-"));
    try {
      // A directory where the workflow file belongs: existsSync is true and readFileSync throws.
      mkdirSync(join(root, ".github", "workflows", "closing-references.yml"), { recursive: true });
      const r = await readHumanSteps(root, {
        slug: () => read("o/n"),
        boardId: () => read(null),
        secret: async () => read(true),
        variable: async () => read("true"),
        protection: async slug => ({ ...unreadableFacts(slug, ""), unreadable: null, branch: "main", contexts: [], statusChecks: "unprotected" as const }),
      });
      expect(r.unreadableWorkflows).toHaveLength(1);
      const lines = humanSteps(r);
      expect(lines.join("\n")).toMatch(/UNMEASURED: process checks — \.github\/workflows\/closing-references\.yml could not be read/);
      expect(lines.join("\n"), "an unread workflow was folded into nothing owed").not.toMatch(/none owed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#2169: a failed git read is reported as one, and an SSH alias for github.com is followed", () => {
  const ran = (over: Partial<RunResult>): Run => () => ({ status: 0, stdout: "", ...over });

  test("readOrigin: git missing, a vanished root or a timeout is UNMEASURED naming why; only exit 1 means no origin", () => {
    const spawnError = readOrigin("/r", ran({ status: null, error: new Error("spawnSync git ENOENT") }));
    expect(spawnError).toEqual(unmeasured("git could not read it (spawnSync git ENOENT)"));
    const killed = readOrigin("/r", ran({ status: null, signal: "SIGTERM" }));
    expect(killed).toEqual(unmeasured("git was stopped by SIGTERM before it answered"));
    expect(readOrigin("/r", ran({ status: 3 }))).toEqual(unmeasured("git exited 3"));
    expect(readOrigin("/r", ran({ status: 1 })), "exit 1 is git saying no origin is configured").toEqual(read(""));
    expect(readOrigin("/r", ran({ status: 0, stdout: "git@github.com:o/n.git\n" }))).toEqual(read("git@github.com:o/n.git\n"));
  });

  test("a live read whose git cannot run in the root is an UNMEASURED line naming the failure, not the no-repository line", async () => {
    const gone = join(tmpdir(), `rg-human-steps-gone-${process.pid}-${Date.now()}`);
    const r = await readHumanSteps(gone, { ...LIVE_PROBES, secret: async () => read(true), variable: async () => read("true") });
    expect(r.slug.kind).toBe("UNMEASURED");
    const line = humanSteps(r)[0];
    expect(line).toStartWith("UNMEASURED: human steps — the origin remote could not be read (git could not read it (");
    expect(line).not.toContain("names no GitHub repository");
  });

  test("a live read of a repository with no origin is still the no-repository line", async () => {
    const root = mkdtempSync(join(tmpdir(), "rg-human-steps-no-origin-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: root });
      const r = await readHumanSteps(root, { ...LIVE_PROBES, secret: async () => read(true), variable: async () => read("true") });
      expect(r.slug).toEqual(read(null));
      expect(humanSteps(r)[0]).toStartWith("UNMEASURED: human steps — the origin remote names no GitHub repository");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an scp-style or ssh:// alias that ssh resolves to github.com is a github.com repository", () => {
    const work = (h: string) => read(h === "github.com-work" ? "github.com" : h);
    expect(githubSlugOf("git@github.com-work:o/r.git", work)).toEqual(read("o/r"));
    expect(githubSlugOf("ssh://git@github.com-work/o/r.git", work)).toEqual(read("o/r"));
    expect(githubSlugOf("git@gh-443:o/r.git", () => read("ssh.github.com")), "GitHub's port-443 SSH host").toEqual(read("o/r"));
    expect(githubSlugOf("git@github.com-work:o/r.git", () => read("gitlab.com")), "an alias for another forge").toEqual(read(null));
  });

  // Review of PR #2187: ssh missing or timed out says nothing about the host.
  test("an alias ssh could not resolve is UNMEASURED naming why, never the no-repository line", () => {
    const failed = githubSlugOf("git@github-work:o/n.git", () => unmeasured("ssh -G github-work could not run (ENOENT)"));
    expect(failed).toEqual(unmeasured("its host github-work could not be resolved: ssh -G github-work could not run (ENOENT)"));
    const line = humanSteps({ ...allSet, slug: failed })[0];
    expect(line).toStartWith("UNMEASURED: human steps — the origin remote could not be read (its host github-work could not be resolved");
    expect(line).not.toContain("names no GitHub repository");
  });

  test("an https host is a DNS name, never an alias: the resolver is not asked", () => {
    const asked: string[] = [];
    const yes = (h: string) => (asked.push(h), read("github.com"));
    expect(githubSlugOf("https://github.com-work/o/r", yes)).toEqual(read(null));
    expect(githubSlugOf("https://github.com.evil.com/o/n", yes)).toEqual(read(null));
    expect(asked).toEqual([]);
  });

  test("a literal github.com is accepted without asking ssh, so a Host github.com rewrite cannot refuse it", () => {
    const asked: string[] = [];
    expect(githubSlugOf("git@github.com:o/n.git", h => (asked.push(h), read("ssh.github.com")))).toEqual(read("o/n"));
    expect(asked).toEqual([]);
  });

  test("sshHostName reads the hostname line of ssh -G, never hands ssh an option, and a failed ssh is UNMEASURED", () => {
    const calls: string[][] = [];
    const run: Run = (cmd, args) => (calls.push([cmd, ...args]), { status: 0, stdout: "user git\nhostname github.com\nport 22\n" });
    expect(sshHostName("github.com-work", run)).toEqual(read("github.com"));
    expect(calls).toEqual([["ssh", "-G", "github.com-work"]]);
    expect(sshHostName("-oProxyCommand=x", run), "an option names no host").toEqual(read(null));
    expect(calls, "a host starting with - reached ssh").toHaveLength(1);
    expect(sshHostName("h", () => ({ status: 255, stdout: "" }))).toEqual(unmeasured("ssh -G h exited 255"));
    expect(sshHostName("h", () => ({ status: null, stdout: "", error: new Error("ENOENT") }))).toEqual(unmeasured("ssh -G h could not run (ENOENT)"));
    expect(sshHostName("h", () => ({ status: null, stdout: "", signal: "SIGTERM" }))).toEqual(unmeasured("ssh -G h was stopped by SIGTERM"));
    expect(sshHostName("h", () => ({ status: 0, stdout: "user git\n" }))).toEqual(unmeasured("ssh -G h printed no hostname line"));
  });
});

// Review round 2 of PR #2187: ssh.github.com is one of GitHub's SSH hosts, so
// spelled literally it must not depend on ssh, and its usual URL carries :443.
describe("#2169: GitHub's port-443 SSH host spelled literally is GitHub without asking ssh", () => {
  const refuse = (h: string) => (asked.push(h), unmeasured("ssh -G could not run (ENOENT)"));
  let asked: string[] = [];

  test("ssh://…ssh.github.com:443/o/n.git and git@ssh.github.com:o/n.git are o/n, and ssh is never asked", () => {
    asked = [];
    expect(githubSlugOf("ssh://git@ssh.github.com:443/o/n.git", refuse)).toEqual(read("o/n"));
    expect(githubSlugOf("git@ssh.github.com:O/N.git", refuse)).toEqual(read("o/n"));
    expect(asked, "a literal GitHub SSH host was sent to ssh").toEqual([]);
  });

  test("over https, ssh.github.com is not a git host and stays a literal compare", () => {
    asked = [];
    expect(githubSlugOf("https://ssh.github.com/o/n", refuse)).toEqual(read(null));
    expect(asked).toEqual([]);
  });

  test("a port on a github.com URL does not shift the slug", () => {
    expect(githubSlugOf("ssh://git@github.com:22/o/n.git", refuse)).toEqual(read("o/n"));
    expect(githubSlugOf("https://github.com:443/o/n", refuse)).toEqual(read("o/n"));
  });
});

// Review round 3 of PR #2187: OpenSSH matches `Host` case-sensitively
// (OpenSSH 10.5: `Host GitHub-Perso` resolves `GitHub-Perso`, not `github-perso`).
describe("#2169: an alias is resolved as written, because ssh's Host match is case-sensitive", () => {
  test("git@GitHub-Perso:o/r.git asks ssh about GitHub-Perso, not github-perso", () => {
    const asked: string[] = [];
    const ssh = (h: string) => (asked.push(h), read(h === "GitHub-Perso" ? "github.com" : h.toLowerCase()));
    expect(githubSlugOf("git@GitHub-Perso:o/r.git", ssh)).toEqual(read("o/r"));
    expect(asked).toEqual(["GitHub-Perso"]);
  });
});

/**
 * Covers SC-2793 (SPEC-TO-BOARD-PIPELINE-SPEC.md), #2485, ADR-023: the report
 * says whether `board.id` is set and whether the project token can write that
 * board, each as one OWED command or UNMEASURED with its reason, never "done".
 *
 * Before this the report read only that a secret named RUNGATE_PROJECT_TOKEN
 * existed. A consumer with no board, or with a token that cannot write the one
 * it has, was told nothing was owed, and every board step then refused.
 */
describe("SC-2793: the human-steps report says whether board.id is set and whether the token can write that board", () => {
  test("no board.id is one OWED board-init command, registered and able to write", () => {
    const lines = humanSteps({ ...allSet, boardId: read(null) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith(`OWED: ${BOARD_INIT_COMMAND}`);
    expect(lines[0], "the token is asked about once there is a board to ask about").toContain(PROJECT_TOKEN_SECRET);
    expect(BOARD_INIT_COMMAND).toContain("bunx rungate board-init --write");
    expect(CLI_COMMANDS["board-init"]?.usage, "board-init writes nothing without --write").toContain("--write");
  });

  test("a board.id that could not be read is UNMEASURED with its reason, and the token was not asked about", () => {
    const lines = humanSteps({ ...allSet, boardId: unmeasured("the rungate config could not be read (JSON Parse error)") });
    expect(lines).toEqual([
      `UNMEASURED: the project board — board.id could not be read (the rungate config could not be read (JSON Parse error)), so whether ${PROJECT_TOKEN_SECRET} can write it was not asked`,
    ]);
  });

  test("board.id set and the secret present: UNMEASURED, saying why, naming the board, with the read-only check", () => {
    const [line] = humanSteps(allSet);
    expect(line).toStartWith(`${tokenRow} — GitHub never returns a secret's value, so scaffold cannot try it`);
    expect(line, "the check a person holding the token can run").toContain(
      `gh api graphql -f query='query($id: ID!) { node(id: $id) { ... on ProjectV2 { viewerCanUpdate } } }' -f id=${BOARD}`,
    );
    expect(line).toContain("organisation");
  });

  test("board.id set and no secret, or one that could not be read: the token row says there is no token to ask about", () => {
    expect(humanSteps({ ...allSet, secretPresent: read(false) }).at(-1)).toBe(`${tokenRow} — no ${PROJECT_TOKEN_SECRET} is set, so there is no token to ask about`);
    expect(humanSteps({ ...allSet, secretPresent: unmeasured("HTTP 403") }).at(-1)).toBe(
      `${tokenRow} — the secret could not be read, so it is not known that there is a token to ask about`,
    );
  });

  test("no GitHub repository: the one UNMEASURED line names the project board among what was not read", () => {
    const lines = humanSteps({ ...allSet, slug: read(null) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("the project board");
  });

  test("readBoardId: no config is no board; a board.id is read; a malformed config or an id no project has is UNMEASURED", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-human-steps-board-"));
    const config = (body: string) => {
      mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
      writeFileSync(join(root, ".claude", "rungate", "config.json"), body);
    };
    try {
      expect(readBoardId(root)).toEqual(read(null));
      config(JSON.stringify({ board: { id: BOARD } }));
      expect(readBoardId(root)).toEqual(read(BOARD));
      config(JSON.stringify({ board: { id: "PVT_x'; touch pwned; '" } }));
      const odd = readBoardId(root);
      expect(odd.kind, "an id that would break out of the printed command was passed through").toBe("UNMEASURED");
      config("{ not json");
      const bad = readBoardId(root);
      expect(bad.kind).toBe("UNMEASURED");
      expect(bad.kind === "UNMEASURED" && bad.why).toContain("the rungate config could not be read");
      expect(LIVE_PROBES.boardId, "the live probe is the reader").toBe(readBoardId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("readHumanSteps carries the board reading from its probe", async () => {
    const r = await readHumanSteps(ROOT, {
      slug: () => read("o/n"),
      boardId: () => read(BOARD),
      secret: async () => read(true),
      variable: async () => read("true"),
      protection: async slug => ({ ...unreadableFacts(slug, ""), unreadable: null, branch: "main", contexts: [], statusChecks: "unprotected" as const }),
    });
    expect(r.boardId).toEqual(read(BOARD));
  });
});
