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
 * onto a GITHUB_TOKEN step each turns a case red; so do deleting the
 * `f !== process.env.PREFIX` test (the engine's family is linked twice),
 * unquoting `"$family"` (a two-word family splits), and keying the family step
 * to `github.event` (the review of #2092: a dropped queued run loses its work).
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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

describe("#2062: every milestone family is linked on every run, whichever event fired it", () => {
  const allFamilies = () => depsSteps().find(s => runOf(s).includes('--milestone-prefix "$family"'));
  const lines = () => runOf(allFamilies()).split("\n");

  test("#2062: one step loops plan-deps over every other family, unconditionally, with the job's own token", () => {
    const step = allFamilies();
    expect(step, "a plan-deps step looping over families").toBeDefined();
    expect(runOf(step)).toContain("--write");
    expect(runOf(step)).toContain('--repo "$GITHUB_REPOSITORY"');
    expect(runOf(step)).toContain('import { familyOf } from "./lib/spec-placement"');
    expect(step.env.PREFIX).toBe("${{ steps.prefix.outputs.prefix }}");
    expect(step.if, "a skipped step reads as satisfied, so this one never skips").toBeUndefined();
  });

  test("#2062: no step reads which event fired the run, so a dropped queued run loses nothing", () => {
    // The concurrency group keeps one pending run and drops the rest. A step
    // keyed to the firing event's milestone loses that milestone whenever its
    // run is the one dropped — the review of #2092. Reading the tracker
    // instead makes every surviving run cover what the dropped ones would have.
    expect(text).not.toContain("github.event");
  });

  /** Run the step's real enumeration line, from the repository root, against a fake `gh` printing these titles. */
  const families = (titles: string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "phase-order-families-"));
    try {
      // What `gh api … --jq '.[] | .title | @json'` prints: one JSON string per line.
      writeFileSync(join(dir, "gh"), `#!/bin/sh\ncat <<'EOF'\n${titles.map(t => JSON.stringify(t)).join("\n")}\nEOF\n`, {
        mode: 0o755,
      });
      const enumerate = lines().find(l => l.trimStart().startsWith("families=$("));
      expect(enumerate, "the enumeration line was not found, so nothing was executed").toBeDefined();
      const r = spawnSync("bash", ["-eo", "pipefail", "-c", `${enumerate}\nprintf '%s' "$families"`], {
        cwd: ROOT,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PREFIX: "Pipeline", GITHUB_REPOSITORY: "o/r" },
        encoding: "utf-8",
      });
      expect(r.status, r.stderr).toBe(0);
      return r.stdout;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("#2062: every family with an open milestone is named once, except the engine's, an unprefixed one, or a non-phase", () => {
    expect(
      families([
        "Pipeline Phase 6 — the board's state is a reading",
        "Convergence Phase 5 — the instruments",
        "Convergence Phase 2 — stop the false findings",
        "Issue intake",
        "Phase 3",
        "Spec Two Phase 1 — a two-word family",
        // One title, one JSON line: a newline inside it is not a second title.
        "Evil\nfamily=x Phase 1",
      ]),
    ).toBe("Convergence\nSpec Two");
    expect(families(["Pipeline Phase 6"])).toBe("");
  });

  /** Run the step's loop against a fake `bun`, returning each call's arguments joined by `|`. */
  const loop = (familyList: string): string[] => {
    const dir = mkdtempSync(join(tmpdir(), "phase-order-loop-"));
    try {
      const log = join(dir, "calls");
      writeFileSync(join(dir, "bun"), `#!/bin/sh\nprintf '%s|' "$@" >> "${log}"\necho >> "${log}"\n`, { mode: 0o755 });
      const body = lines();
      const from = body.findIndex(l => l.trimStart().startsWith("while IFS= read -r family"));
      const to = body.findIndex(l => l.trimStart().startsWith('done <<< "$families"'));
      expect(from >= 0 && to > from, "the loop was not found, so nothing was executed").toBe(true);
      const r = spawnSync("bash", ["-e", "-c", body.slice(from, to + 1).join("\n")], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, families: familyList, GITHUB_REPOSITORY: "o/r" },
        encoding: "utf-8",
      });
      expect(r.status, r.stderr).toBe(0);
      return existsSync(log) ? readFileSync(log, "utf-8").split("\n").filter(Boolean) : [];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("#2062: the loop runs plan-deps once per family, a two-word family as ONE argument, and nothing for none", () => {
    expect(loop("Convergence\nSpec Two")).toEqual([
      "scripts/plan-deps.ts|--repo|o/r|--milestone-prefix|Convergence|--write|",
      "scripts/plan-deps.ts|--repo|o/r|--milestone-prefix|Spec Two|--write|",
    ]);
    expect(loop("")).toEqual([]);
  });
});
