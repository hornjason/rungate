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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { protectionFactsFromPayload, unreadableFacts } from "../lib/branch-protection";
import {
  LIVE_PROBES,
  PROJECT_TOKEN_SECRET,
  REQUIRE_CLOSING_REF_VARIABLE,
  githubSlugOf,
  humanSteps,
  readHumanSteps,
  timed,
  type HumanStepProbes,
  type HumanStepReadings,
} from "../lib/scaffold/human-steps";

const ROOT = join(import.meta.dir, "..");
const read = <T>(value: T) => ({ kind: "READ", value }) as const;
const unmeasured = (why: string) => ({ kind: "UNMEASURED", why }) as const;

const allSet: HumanStepReadings = {
  slug: "o/n",
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
    expect(lines).toHaveLength(3);
    expect(lines[0]).toStartWith(`OWED: gh secret set ${PROJECT_TOKEN_SECRET} -R o/n`);
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
    expect(lines).toHaveLength(1);
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
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("OWED: require closing-references on main");
    expect(lines[0], "PUT replaces the existing protection; POST 404s without required checks").not.toMatch(/-X (PUT|POST)/);
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
    ]);
    expect(lines.join("\n")).not.toMatch(/none owed|done/i);
  });

  test("no GitHub repository at all is one UNMEASURED line, not a clean report", () => {
    const lines = humanSteps({ ...allSet, slug: null });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("UNMEASURED: human steps");
  });

  test("everything in place says what it measured, and never says done", () => {
    const lines = humanSteps(allSet);
    expect(lines).toEqual([
      `Human steps: none owed — measured: ${PROJECT_TOKEN_SECRET} is set; ${REQUIRE_CLOSING_REF_VARIABLE} is true; closing-references required on main.`,
    ]);
    expect(lines[0]).not.toMatch(/\bdone\b/i);
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
    slug: () => "o/n",
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
    for (const url of [
      "git@github.com:o/n.git",
      "https://github.com/o/n",
      "https://x:token@github.com/o/n.git",
      "ssh://git@github.com/o/n.git",
      "https://GitHub.com/O/N.git",
    ]) expect(githubSlugOf(url), url).toBe("o/n");
    for (const url of [
      "git@gitlab.com:o/n.git",
      "https://gitlab.com/o/n",
      "https://github.com.evil.com/o/n",
      "/tmp/some/fixture.git",
      "",
    ]) expect(githubSlugOf(url), url).toBeNull();
  });

  test("a live read of a gitlab origin is the no-repository line and calls no GitHub probe", async () => {
    const root = mkdtempSync(join(tmpdir(), "rg-human-steps-gitlab-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: root });
      spawnSync("git", ["remote", "add", "origin", "git@gitlab.com:org/proj.git"], { cwd: root });
      const called: string[] = [];
      const r = await readHumanSteps(root, {
        slug: LIVE_PROBES.slug,
        secret: async () => (called.push("secret"), read(true)),
        variable: async () => (called.push("variable"), read("true")),
        protection: async slug => (called.push("protection"), unreadableFacts(slug, "")),
      });
      expect(r.slug).toBeNull();
      expect(called, "a GitHub probe ran for a non-GitHub origin").toEqual([]);
      expect(humanSteps(r)[0]).toStartWith("UNMEASURED: human steps");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Round 1 of PR #2162: the no-repository early return swallowed it.
  test("an unreadable workflow is still reported when there is no GitHub origin", () => {
    const lines = humanSteps({ ...allSet, slug: null, unreadableWorkflows: [".github/workflows/closing-references.yml could not be read (EISDIR)"] });
    expect(lines[0]).toStartWith("UNMEASURED: human steps");
    expect(lines.join("\n")).toContain("UNMEASURED: process checks — .github/workflows/closing-references.yml could not be read");
  });

  test("an unreadable process workflow is an UNMEASURED line naming it, and the read completes", async () => {
    const root = mkdtempSync(join(tmpdir(), "rg-human-steps-unreadable-"));
    try {
      // A directory where the workflow file belongs: existsSync is true and readFileSync throws.
      mkdirSync(join(root, ".github", "workflows", "closing-references.yml"), { recursive: true });
      const r = await readHumanSteps(root, {
        slug: () => "o/n",
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
