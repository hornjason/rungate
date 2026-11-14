/**
 * #2097: .github/workflows/status-issue.yml rewrites the pinned "where we
 * are" issue on every change. Serves no criterion (the issue says so).
 *
 * The workflow file is parsed, not grepped, for its triggers, steps and
 * tokens, the same way test/phase-order-workflow.test.ts reads its own.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

const PATH = join(import.meta.dir, "..", ".github", "workflows", "status-issue.yml");
const text = existsSync(PATH) ? readFileSync(PATH, "utf-8") : "";
const doc = (text ? Bun.YAML.parse(text) : {}) as any;
const steps: any[] = doc?.jobs?.status?.steps ?? [];
const runOf = (s: any) => String(s?.run ?? "");
const reader = () => steps.find(s => runOf(s).includes("scripts/status-view.ts --markdown"));
const writer = () => steps.find(s => runOf(s).includes("scripts/status-view.ts --publish"));

describe("#2097: the status workflow", () => {
  test("it fires on a push to main and on the issue events that change progress, never on opened or edited", () => {
    expect(doc.on.push).toEqual({ branches: ["main"] });
    expect([...doc.on.issues.types].sort()).toEqual(
      ["assigned", "closed", "demilestoned", "labeled", "milestoned", "reopened", "unassigned", "unlabeled"].sort(),
    );
    for (const strangerEvent of ["opened", "edited"]) {
      expect(doc.on.issues.types, `${strangerEvent} puts the board token behind an event anyone can raise`).not.toContain(
        strangerEvent,
      );
    }
    expect(doc.on.schedule, "a change fires it; there is no cron").toBeUndefined();
  });

  test("it renders, then publishes the file it rendered, through the one script", () => {
    expect(reader(), "no step renders the view").toBeDefined();
    expect(writer(), "no step publishes it").toBeDefined();
    expect(steps.indexOf(reader())).toBeLessThan(steps.indexOf(writer()));
    expect(runOf(reader())).toContain('> "$RUNNER_TEMP/status.md"');
    expect(runOf(writer())).toContain('--publish "$RUNNER_TEMP/status.md"');
  });

  test("the board token reads and never writes; the write holds only the job's own token", () => {
    // ADR-013. Comments may name the secrets; only expressions are counted.
    expect(JSON.stringify(writer().env)).not.toContain("RUNGATE_PROJECT_TOKEN");
    expect(writer().env.GH_TOKEN).toBe("${{ secrets.GITHUB_TOKEN }}");
    const holders = steps.filter(s => JSON.stringify(s.env ?? {}).includes("secrets.RUNGATE_PROJECT_TOKEN"));
    expect(holders, "exactly one step holds the board token").toEqual([reader()]);
    expect(doc.jobs.status.env, "no job-level env, so no step inherits a token").toBeUndefined();
    expect(doc.permissions).toEqual({ contents: "read", issues: "write" });
  });

  test("no step reads the firing event, and no expression is interpolated into a script line", () => {
    expect(text).not.toContain("github.event");
    for (const s of steps) expect(runOf(s)).not.toMatch(/\$\{\{/);
  });

  test("a newer run supersedes an older one, which loses nothing because every run reads everything", () => {
    expect(doc.concurrency).toEqual({ group: "status-issue", "cancel-in-progress": true });
  });

  test("every action is pinned to a full commit SHA, and the checkout has the history board-conformance reads", () => {
    const uses = steps.map(s => s.uses).filter(Boolean);
    expect(uses.length, "no uses: steps found, so the pin check measured nothing").toBeGreaterThan(0);
    expect(uses.filter((u: string) => !/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(u))).toEqual([]);
    expect(steps.find(s => String(s.uses ?? "").startsWith("actions/checkout@"))?.with?.["fetch-depth"]).toBe(0);
  });
});

describe("#2097 review round 2: Ready changes reach the view", () => {
  test("it re-reads when a workflow that writes Ready finishes, and every one it names exists", () => {
    const names = doc.on.workflow_run?.workflows ?? [];
    expect(doc.on.workflow_run?.types).toEqual(["completed"]);
    expect(names.length, "no Ready-writing workflow is listed").toBeGreaterThan(0);
    const dir = join(import.meta.dir, "..", ".github", "workflows");
    const declared = readdirSync(dir)
      .filter(f => f.endsWith(".yml"))
      .map(f => (Bun.YAML.parse(readFileSync(join(dir, f), "utf-8")) as any)?.name);
    for (const n of names) expect(declared, `no workflow is named "${n}", so this trigger never fires`).toContain(n);
  });
});
