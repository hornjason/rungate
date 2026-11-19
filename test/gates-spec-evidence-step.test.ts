/**
 * #2499: the generated gates job runs `audit-spec-evidence`, so a consumer's
 * tick with no proof fails a check instead of passing every one.
 *
 * Our first consumer's PR ticked a criterion with no `proved-by:` line on
 * 2026-11-19 (a dated record) and nothing went red, because no generated
 * workflow ran the audit. Writing the check by hand would be a hand-made
 * workflow, which is what this project is removing.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { workflowCensus } from "../lib/scaffold/workflow-census";

const ROOT = join(import.meta.dir, "..");
const GATES = readFileSync(join(ROOT, ".github/workflows/gates.yml"), "utf8");
const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;

/** The text of the step named `name` in the gates job, up to the next step. */
function step(yaml: string, name: string): string {
  const at = yaml.indexOf(`- name: ${name}`);
  if (at === -1) return "";
  const next = yaml.indexOf("\n      - ", at + 1);
  return yaml.slice(at, next === -1 ? undefined : next);
}

describe("#2499: the gates job audits spec evidence", () => {
  test("this repository's gates.yml has the step, and it calls the published CLI at the pinned version", () => {
    const s = step(GATES, "Spec evidence");
    expect(s, "no 'Spec evidence' step in .github/workflows/gates.yml").not.toBe("");
    expect(s).toContain(`bunx rungate@${VERSION} audit-spec-evidence --project-root .`);
  });

  test("a tree with no specs/ warns by name instead of passing silently or failing", () => {
    const s = step(GATES, "Spec evidence");
    expect(s).toContain("if [ -d specs ]");
    expect(s).toMatch(/::warning title=Spec evidence UNMEASURED::/);
  });

  test("the step runs after the conformity suite, inside the gates job", () => {
    const conformity = GATES.indexOf("- name: Conformity + spec drift");
    const evidence = GATES.indexOf("- name: Spec evidence");
    expect(conformity).toBeGreaterThan(-1);
    expect(evidence).toBeGreaterThan(conformity);
  });

  test("the generator writes it: this repository's copy is the generated one, untouched", () => {
    const row = workflowCensus(ROOT).files.find(f => f.name === "gates.yml");
    expect(row?.status, row?.detail).toBe("generated-and-unchanged");
  });
});

describe("#2499: what the step depends on in audit-spec-evidence", () => {
  const run = (root: string) =>
    spawnSync(process.execPath, [join(ROOT, "scripts/audit-spec-evidence.ts"), "--project-root", root], { encoding: "utf8" });

  test("a spec that requires evidence and has a tick with no proof fails", () => {
    const root = mkdtempSync(join(tmpdir(), "gates-evidence-"));
    try {
      mkdirSync(join(root, "specs"));
      writeFileSync(
        join(root, "specs/X.md"),
        "---\ndoc-type: spec\nevidence: required\n---\n# X\n\n## Success Criteria\n\n- [x] SC-9891: a thing is true\n      needs: test\n",
      );
      expect(run(root).status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("specs that do not require evidence pass, so a consumer that has not opted in stays green", () => {
    const root = mkdtempSync(join(tmpdir(), "gates-evidence-"));
    try {
      mkdirSync(join(root, "specs"));
      writeFileSync(join(root, "specs/X.md"), "---\ndoc-type: spec\n---\n# X\n\n- [x] SC-9892: a thing is true\n");
      expect(run(root).status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
