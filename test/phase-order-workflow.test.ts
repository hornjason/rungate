/**
 * #2015: the phase-order links are re-written whenever an issue's milestone
 * changes, not only when an ADR merges.
 *
 * Before this, `plan-deps --write` ran only inside adr-accepted.yml. An issue
 * milestoned by hand afterwards got no order link until somebody remembered
 * to run it: the 2026-11-12 dry run found #1719 missing its link to #1752.
 *
 * The workflow file is parsed, not grepped: the trigger, the one command, and
 * which credential it holds.
 *
 * Broken to prove it: dropping `demilestoned` from the trigger, `--write` from
 * the command, or swapping the token for RUNGATE_PROJECT_TOKEN each turns a
 * case red.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const PATH = join(import.meta.dir, "..", ".github", "workflows", "phase-order.yml");
const text = existsSync(PATH) ? readFileSync(PATH, "utf-8") : "";
const doc = (text ? Bun.YAML.parse(text) : {}) as any;
const steps: any[] = doc.jobs?.["phase-order"]?.steps ?? [];
const runOf = (s: any) => String(s.run ?? "");

describe("#2015: .github/workflows/phase-order.yml re-writes phase order when a milestone changes", () => {
  test("#2015: it exists and fires on milestoned and demilestoned issues, and nothing else", () => {
    expect(text.length, "phase-order.yml does not exist").toBeGreaterThan(0);
    expect(Object.keys(doc.on)).toEqual(["issues"]);
    expect(doc.on.issues.types).toEqual(["milestoned", "demilestoned"]);
  });

  test("#2015: it runs plan-deps with --write against this repository", () => {
    const deps = steps.filter(s => runOf(s).includes("scripts/plan-deps.ts"));
    expect(deps, "exactly one plan-deps step").toHaveLength(1);
    expect(runOf(deps[0])).toContain("--write");
    expect(runOf(deps[0])).toContain('--repo "$GITHUB_REPOSITORY"');
    expect(runOf(deps[0])).toContain('--milestone-prefix "$PREFIX"');
  });

  test("#2015: the prefix comes from config through the one reader, and an absent one is a red run", () => {
    const read = steps.find(s => s.id === "prefix");
    expect(read, "a step with id: prefix").toBeDefined();
    expect(runOf(read)).toContain('readBoardInputs(".").milestonePrefix');
    expect(runOf(read)).toContain("exit 1");
    const deps = steps.find(s => runOf(s).includes("scripts/plan-deps.ts"));
    expect(deps.env.PREFIX).toBe("${{ steps.prefix.outputs.prefix }}");
  });

  test("#2015: it holds the job's own GITHUB_TOKEN and never the board token", () => {
    // The comment may name the board token; no expression may reach it, or any other secret.
    expect(text.match(/secrets\.\w+/g)).toEqual(["secrets.GITHUB_TOKEN"]);
    const deps = steps.find(s => runOf(s).includes("scripts/plan-deps.ts"));
    expect(deps.env.GITHUB_TOKEN).toBe("${{ secrets.GITHUB_TOKEN }}");
    for (const s of steps) expect(runOf(s), "no expression is interpolated into a script line").not.toMatch(/\$\{\{/);
    expect(doc.permissions).toEqual({ contents: "read", issues: "write" });
  });

  test("#2015: runs queue rather than race, so a bulk re-milestone never writes the same edge twice at once", () => {
    expect(doc.concurrency).toEqual({ group: "phase-order", "cancel-in-progress": false });
  });

  test("#2015: the prefix read refuses a newline that would forge a GITHUB_OUTPUT key", () => {
    const run = runOf(steps.find(s => s.id === "prefix"));
    const guard = run.slice(run.indexOf('case "$prefix" in'), run.indexOf("esac") + 4);
    expect(guard.startsWith("case")).toBe(true);
    const sh = (prefix: string) =>
      spawnSync("bash", ["-e", "-c", `${guard}\necho passed`], { env: { prefix }, encoding: "utf-8" });
    const bad = sh("Pipeline\nprefix=other");
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("contains a newline");
    const good = sh("Pipeline");
    expect(good.status).toBe(0);
    expect(good.stdout).toContain("passed");
  });
});
