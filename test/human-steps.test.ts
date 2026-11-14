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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { unreadableFacts } from "../lib/branch-protection";
import {
  PROJECT_TOKEN_SECRET,
  REQUIRE_CLOSING_REF_VARIABLE,
  humanSteps,
  readHumanSteps,
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
  protection: read({ branch: "main", contexts: ["test", "closing-references"] }),
  processChecks: ["closing-references"],
};

describe("SC-2749: every human step still owed is one command", () => {
  test("nothing set: the secret, the variable and the unrequired check are each one OWED command", () => {
    const lines = humanSteps({
      ...allSet,
      secretPresent: read(false),
      requireClosingRef: read(null),
      protection: read({ branch: "main", contexts: ["test"] }),
    });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toStartWith(`OWED: gh secret set ${PROJECT_TOKEN_SECRET} -R o/n`);
    expect(lines[1]).toStartWith(`OWED: gh variable set ${REQUIRE_CLOSING_REF_VARIABLE} -R o/n --body true`);
    expect(lines[2]).toStartWith(
      "OWED: gh api -X POST repos/o/n/branches/main/protection/required_status_checks/contexts -f 'contexts[]=closing-references'",
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

describe("SC-2749: the readings come from the tree and the probes, and the scaffold prints them", () => {
  const probes = (over: Partial<HumanStepProbes> = {}): HumanStepProbes => ({
    slug: () => "o/n",
    secret: async () => read(false),
    variable: async () => read(null),
    protection: async slug => ({ ...unreadableFacts(slug, ""), unreadable: null, branch: "main", contexts: [] }),
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
