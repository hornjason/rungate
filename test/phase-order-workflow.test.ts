/**
 * #2015: the phase-order links are re-written whenever an issue's milestone
 * changes, not only when an ADR merges.
 *
 * Before this, `plan-deps --write` ran only inside adr-accepted.yml. An issue
 * milestoned by hand afterwards got no order link until somebody remembered
 * to run it: the 2026-11-12 dry run found #1719 missing its link to #1752.
 *
 * #2062 / SC-2609: the same event also gives the issue what the board needs —
 * the queue label and its Criteria cell — and links the family of the
 * milestone that changed, not only the engine's. Measured 2026-11-12 (#2020):
 * six issues milestoned by hand left `queue-label` 6 of 12 and `criteria-field`
 * 8 of 12, and an unrelated PR went red twice. Measured 2026-11-13: #1934
 * placed in a Convergence phase left `dependency-edges` 247 of 256, because
 * this workflow ran plan-deps for `Pipeline` only.
 *
 * The workflow file is parsed, not grepped: the trigger, the commands, and
 * which credential each step holds.
 *
 * Broken to prove it: dropping `demilestoned` from the trigger, `--write` from
 * a command, the board token from the Criteria step, or moving the board token
 * onto a GITHUB_TOKEN step each turns a case red; so does deleting the
 * `"$FAMILY" != "$PREFIX"` test, which makes the family step re-run the
 * engine's own family.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { familyOf } from "../lib/spec-placement";

const ROOT = join(import.meta.dir, "..");
const PATH = join(ROOT, ".github", "workflows", "phase-order.yml");
const text = existsSync(PATH) ? readFileSync(PATH, "utf-8") : "";
const doc = (text ? Bun.YAML.parse(text) : {}) as any;
const steps: any[] = doc.jobs?.["phase-order"]?.steps ?? [];
const runOf = (s: any) => String(s.run ?? "");
const depsSteps = () => steps.filter(s => runOf(s).includes("scripts/plan-deps.ts"));
const mirrorSteps = () => steps.filter(s => runOf(s).includes("scripts/board-mirror.ts"));

describe("#2015: .github/workflows/phase-order.yml re-writes phase order when a milestone changes", () => {
  test("#2015: it exists and fires on milestoned and demilestoned issues, and nothing else", () => {
    expect(text.length, "phase-order.yml does not exist").toBeGreaterThan(0);
    expect(Object.keys(doc.on)).toEqual(["issues"]);
    expect(doc.on.issues.types).toEqual(["milestoned", "demilestoned"]);
  });

  test("#2015: it runs plan-deps with --write against this repository, for the engine's family", () => {
    const engine = depsSteps().filter(s => runOf(s).includes('--milestone-prefix "$PREFIX"'));
    expect(engine, "exactly one plan-deps step for the engine's family").toHaveLength(1);
    expect(runOf(engine[0])).toContain("--write");
    expect(runOf(engine[0])).toContain('--repo "$GITHUB_REPOSITORY"');
  });

  test("#2015: the prefix comes from config through the one reader, and an absent one is a red run", () => {
    const read = steps.find(s => s.id === "prefix");
    expect(read, "a step with id: prefix").toBeDefined();
    expect(runOf(read)).toContain('readBoardInputs(".").milestonePrefix');
    expect(runOf(read)).toContain("exit 1");
    const deps = depsSteps().find(s => runOf(s).includes('--milestone-prefix "$PREFIX"'));
    expect(deps.env.PREFIX).toBe("${{ steps.prefix.outputs.prefix }}");
  });

  test("#2015: no expression is interpolated into a script line, and permissions stay issue-scoped", () => {
    for (const s of steps) expect(runOf(s), "no expression is interpolated into a script line").not.toMatch(/\$\{\{/);
    expect(doc.permissions).toEqual({ contents: "read", issues: "write" });
  });

  test("#2015: every action is pinned to a full commit SHA, never a movable tag", () => {
    const uses = steps.map(s => s.uses).filter(Boolean);
    expect(uses.length, "no uses: steps found, so the pin check measured nothing").toBeGreaterThan(0);
    expect(uses.filter((u: string) => !/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(u))).toEqual([]);
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

describe("#2062 / SC-2609: a hand-milestoned engine issue gets its queue label and Criteria cell", () => {
  test("SC-2609: one step labels every engine-phase issue lacking the queue label, with the job's own token", () => {
    const label = mirrorSteps().filter(s => runOf(s).includes("--queue-label"));
    expect(label, "exactly one --queue-label step").toHaveLength(1);
    expect(runOf(label[0])).toContain('--repo "$GITHUB_REPOSITORY"');
    expect(runOf(label[0])).toContain("--write");
    expect(label[0].env.GITHUB_TOKEN).toBe("${{ secrets.GITHUB_TOKEN }}");
  });

  test("SC-2609: one step writes the Criteria column with the same command adr-accepted.yml runs", () => {
    const cells = mirrorSteps().filter(s => runOf(s).includes('--project "$PROJECT_ID"'));
    expect(cells, "exactly one Criteria step").toHaveLength(1);
    expect(runOf(cells[0])).toContain('bun scripts/board-mirror.ts --project "$PROJECT_ID" --write');
    // No --ready: Status belongs to board-ready.yml, which fires on the same event.
    expect(runOf(cells[0])).not.toContain("--ready");
    expect(cells[0].env.PROJECT_ID).toBe("${{ vars.RUNGATE_PROJECT_ID }}");
  });

  test("SC-2609: an unset RUNGATE_PROJECT_ID is a red run naming it, not a skipped write", () => {
    const run = runOf(mirrorSteps().find(s => runOf(s).includes('--project "$PROJECT_ID"')));
    const guard = run.slice(run.indexOf('if [ -z "$PROJECT_ID" ]'), run.indexOf("fi") + 2);
    expect(guard.startsWith("if")).toBe(true);
    const sh = (PROJECT_ID: string) =>
      spawnSync("bash", ["-e", "-c", `${guard}\necho passed`], { env: { PROJECT_ID }, encoding: "utf-8" });
    const bad = sh("");
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("RUNGATE_PROJECT_ID is not set");
    expect(sh("PVT_x").status).toBe(0);
  });

  test("SC-2609: the board token sits in the Criteria step's env only, and every other write holds GITHUB_TOKEN", () => {
    // ADR-013: issues, milestones and edges are written with GITHUB_TOKEN;
    // RUNGATE_PROJECT_TOKEN lives in the board-mirror step's env only, never
    // widened. Comments may name it; only expressions are counted.
    expect([...(text.match(/secrets\.\w+/g) ?? [])].sort()).toEqual([
      "secrets.GITHUB_TOKEN",
      "secrets.GITHUB_TOKEN",
      "secrets.GITHUB_TOKEN",
      "secrets.RUNGATE_PROJECT_TOKEN",
    ]);
    const holders = steps.filter(s => JSON.stringify(s.env ?? {}).includes("secrets.RUNGATE_PROJECT_TOKEN"));
    expect(holders, "exactly one step holds the board token").toHaveLength(1);
    expect(runOf(holders[0])).toContain('--project "$PROJECT_ID"');
    expect(holders[0].env.GITHUB_TOKEN).toBe("${{ secrets.RUNGATE_PROJECT_TOKEN }}");
    expect(doc.jobs["phase-order"].env, "no job-level env, so no step inherits a token").toBeUndefined();
    for (const s of [...depsSteps(), ...mirrorSteps().filter(m => runOf(m).includes("--queue-label"))]) {
      expect(s.env.GITHUB_TOKEN, `${s.name} must hold the job's own token`).toBe("${{ secrets.GITHUB_TOKEN }}");
    }
  });
});

describe("#2062: the family of the milestone that changed is linked too, not only the engine's", () => {
  const familyStep = () => steps.find(s => s.id === "family");

  test("#2062: a second plan-deps step links the changed milestone's family, and runs only when it names one", () => {
    const other = depsSteps().filter(s => runOf(s).includes('--milestone-prefix "$FAMILY"'));
    expect(other, "exactly one plan-deps step for the changed family").toHaveLength(1);
    expect(runOf(other[0])).toContain("--write");
    expect(other[0].env.FAMILY).toBe("${{ steps.family.outputs.family }}");
    expect(other[0].if).toBe("steps.family.outputs.family != ''");
    expect(familyStep().env.MILESTONE).toBe("${{ github.event.milestone.title }}");
    expect(familyStep().env.PREFIX).toBe("${{ steps.prefix.outputs.prefix }}");
  });

  /** Run the family step's real script, from the repository root, and return what it wrote to GITHUB_OUTPUT. */
  const family = (MILESTONE: string): { status: number | null; output: string } => {
    const dir = mkdtempSync(join(tmpdir(), "phase-order-family-"));
    try {
      const out = join(dir, "output");
      const r = spawnSync("bash", ["-e", "-c", runOf(familyStep())], {
        cwd: ROOT,
        env: { ...process.env, MILESTONE, PREFIX: "Pipeline", GITHUB_OUTPUT: out },
        encoding: "utf-8",
      });
      return { status: r.status, output: existsSync(out) ? readFileSync(out, "utf-8") : "" };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("#2062: a Convergence milestone names its family; the engine's own, or no phase at all, names none", () => {
    expect(family("Convergence Phase 5 — the instruments")).toEqual({ status: 0, output: "family=Convergence\n" });
    expect(family("Pipeline Phase 6 — the board's state is a reading")).toEqual({ status: 0, output: "" });
    expect(family("Issue intake")).toEqual({ status: 0, output: "" });
    // A bare `Phase N` title is the unprefixed family, which plan-deps refuses as a blank prefix.
    expect(family("Phase 3")).toEqual({ status: 0, output: "" });
  });

  test("#2062: the family comes from the one grammar, which cannot return a newline to forge an output key", () => {
    expect(runOf(familyStep())).toContain('import { familyOf } from "./lib/spec-placement"');
    // familyOf anchors at the start and `.` stops at a newline, so a title
    // carrying one is not a phase title at all. That property is why this
    // step needs no newline guard of its own; asserted, not assumed.
    expect(familyOf("Evil\nfamily=Pipeline Phase 1")).toBeNull();
    expect(family("Evil\nfamily=x Phase 1").output).toBe("");
  });
});
