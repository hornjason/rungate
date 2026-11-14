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
 * to `github.event` (the review of #2092: a dropped queued run loses its work);
 * so do removing `set -euo pipefail` (a failed `gh api` goes green), running a
 * family's plan-deps bare (one refusal stops the rest), and dropping
 * `!cancelled()` from a write step (one failure stops the later writes).
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
  test("#2015 / #2099: it fires on milestoned, demilestoned and reopened issues, and nothing else", () => {
    expect(text.length, "phase-order.yml does not exist").toBeGreaterThan(0);
    expect(Object.keys(doc.on)).toEqual(["issues"]);
    // #2099 item 3: reopening #1964 made the plan derive an edge nothing
    // wrote, and a stage proof stayed red in every PR until a hand run.
    expect(doc.on.issues.types).toEqual(["milestoned", "demilestoned", "reopened"]);
    // An author with no access can raise these, so they stay off.
    for (const open of ["opened", "edited"]) expect(doc.on.issues.types).not.toContain(open);
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

  test("#2062: every write runs whether or not an earlier one failed, so one refusal cannot stop the rest", () => {
    // Review round 2 of #2092: one family's plan-deps refusal used to abort
    // the job before the queue label and the Criteria column were written.
    const writes = [...depsSteps(), ...mirrorSteps()];
    expect(writes.length, "the four write steps were not all found").toBe(4);
    for (const s of writes) expect(s.if, `${s.name} must run on !cancelled()`).toBe("${{ !cancelled() }}");
  });
});

describe("#2062: every milestone family is linked on every run, whichever event fired it", () => {
  const allFamilies = () => depsSteps().find(s => runOf(s).includes('--milestone-prefix "$family"'));

  test("#2062: one step loops plan-deps over every other family, with the job's own token", () => {
    const step = allFamilies();
    expect(step, "a plan-deps step looping over families").toBeDefined();
    expect(runOf(step)).toContain("--write");
    expect(runOf(step)).toContain('--repo "$GITHUB_REPOSITORY"');
    expect(runOf(step)).toContain('import { familyOf } from "./lib/spec-placement"');
    expect(step.env.PREFIX).toBe("${{ steps.prefix.outputs.prefix }}");
  });

  test("#2062: no step reads which event fired the run, so a dropped queued run loses nothing", () => {
    // The concurrency group keeps one pending run and drops the rest. A step
    // keyed to the firing event's milestone loses that milestone whenever its
    // run is the one dropped — round 1 of #2092's review. Reading the tracker
    // instead makes every surviving run cover what the dropped ones would have.
    expect(text).not.toContain("github.event");
  });

  /**
   * Run the WHOLE step as Actions does — `bash -e`, the default `run:` shell,
   * with no pipefail of its own — from the repository root.
   *
   * A fake `gh` prints the titles as `--jq '.[] | .title | @json'` would, or
   * fails. A fake `bun` hands `-e` to the real one (the step's familyOf read)
   * and records every other call (plan-deps), failing for `refuse`.
   *
   * The first version of this harness ran the enumeration line under
   * `bash -eo pipefail`, a stricter shell than the one Actions uses, so it
   * could not see the missing pipefail the review found (round 2).
   */
  const step = (opts: { titles?: string[]; ghFails?: boolean; refuse?: string; prefix?: string }) => {
    const dir = mkdtempSync(join(tmpdir(), "phase-order-step-"));
    try {
      const log = join(dir, "calls");
      const ghBody = opts.ghFails
        ? `echo "gh: HTTP 502" >&2\nexit 1\n`
        : `cat <<'EOF'\n${(opts.titles ?? []).map(t => JSON.stringify(t)).join("\n")}\nEOF\n`;
      writeFileSync(join(dir, "gh"), `#!/bin/sh\n${ghBody}`, { mode: 0o755 });
      const refuse = opts.refuse ? `case "$*" in *"--milestone-prefix ${opts.refuse} "*) exit 1 ;; esac\n` : "";
      writeFileSync(
        join(dir, "bun"),
        `#!/bin/sh\nif [ "$1" = "-e" ]; then exec "${process.execPath}" "$@"; fi\n` +
          `printf '%s|' "$@" >> "${log}"\necho >> "${log}"\n${refuse}`,
        { mode: 0o755 },
      );
      const r = spawnSync("bash", ["-e", "-c", runOf(allFamilies())], {
        cwd: ROOT,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PREFIX: opts.prefix ?? "Pipeline", GITHUB_REPOSITORY: "o/r" },
        encoding: "utf-8",
      });
      const calls = existsSync(log) ? readFileSync(log, "utf-8").split("\n").filter(Boolean) : [];
      return { status: r.status, out: r.stdout + r.stderr, calls };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const call = (family: string) => `scripts/plan-deps.ts|--repo|o/r|--milestone-prefix|${family}|--write|`;

  test("#2062: each other family is linked once, a two-word family as ONE argument; the engine's, an unprefixed one and non-phases are not", () => {
    const r = step({
      titles: [
        "Pipeline Phase 6 — the board's state is a reading",
        "Convergence Phase 5 — the instruments",
        "Convergence Phase 2 — stop the false findings",
        "Issue intake",
        "Phase 3",
        "Spec Two Phase 1 — a two-word family",
        // One title, one JSON line: a newline inside it is not a second title.
        "Evil\nfamily=x Phase 1",
      ],
    });
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toEqual([call("Convergence"), call("Spec Two")]);
  });

  test("#2062: no other family is a green run that calls nothing", () => {
    const r = step({ titles: ["Pipeline Phase 6"] });
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toEqual([]);
  });

  test("#2062: a failed milestone read is a red step, not an empty list of families", () => {
    const r = step({ ghFails: true });
    expect(r.status, "a failed gh api must fail the step under Actions' bash -e").not.toBe(0);
    expect(r.calls).toEqual([]);
  });

  test("#2062: one family's refusal does not stop the next, and the step ends red naming it", () => {
    const r = step({ titles: ["Convergence Phase 5", "Spec Two Phase 1"], refuse: "Convergence" });
    expect(r.calls).toEqual([call("Convergence"), call("Spec Two")]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("::error::plan-deps refused for [Convergence]");
  });

  test("#2099: with the prefix step failed, the step refuses by name and links nothing", () => {
    // `PREFIX=""` excludes nothing, so the engine's own family would be linked
    // through this loop, breaking the prefix step's "Nothing was written".
    const r = step({ titles: ["Pipeline Phase 6", "Convergence Phase 5"], prefix: "" });
    expect(r.calls, "a family was linked with no engine prefix to exclude").toEqual([]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("::error::");
    expect(r.out, "the refusal does not name the empty prefix").toContain("PREFIX is empty");
  });
});

