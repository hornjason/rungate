/**
 * #2274 / SC-1947: scaffold runs the doc-rule scan in report mode.
 *
 * Jason decided on #1126 (2026-11-16) that setup runs the doc-rule scan, and
 * on #2240 that nothing is consumed blindly. So scaffold REPORTS each rule a
 * project's docs state ("never X", "always Y") and writes none of them:
 * `extract-constraints --apply` stays the one, deliberate, write. A scan that
 * could not read its docs is UNMEASURED with the reason, never "no rules",
 * and the scan's own result never fails scaffold.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

import { reportDocRules, DOC_RULES_SHOWN } from "../lib/scaffold/steps";
import { planDocScan } from "../lib/doc-scan-targets";

const ROOT = resolve(import.meta.dir, "..");
const RULE = "Never commit secrets to the repository";

function fixture(docs: Record<string, string> = { "docs/guide.md": `# Guide\n\n- ${RULE}.\n\nSome prose.\n` }): string {
  const dir = mkdtempSync(join(tmpdir(), "rungate-2274-"));
  writeFileSync(join(dir, "README.md"), "# Probe\n\nA project.\n");
  for (const [rel, text] of Object.entries(docs)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  const git = (...a: string[]) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  return dir;
}

function withFixture<T>(fn: (dir: string) => Promise<T> | T, docs?: Record<string, string>): Promise<T> {
  const dir = fixture(docs);
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("#2274: the report", () => {
  test("names each candidate rule and the doc line it came from, and writes nothing", () =>
    withFixture(async dir => {
      const actions: string[] = [];
      await reportDocRules(dir, actions);
      const text = actions.join("\n");
      expect(text).toContain("DOC-RULES: 1 candidate rule");
      expect(actions.some(a => a.startsWith("DOC-RULE:") && a.includes(RULE) && a.includes("docs/guide.md:3"))).toBe(true);
      expect(text).toContain("extract-constraints");
      // No action line may read as a write, or `postScaffoldCommit` would stage it.
      expect(actions.some(a => /^(CREATED|REPLACED|UPDATED|AUTO-FIXED|REFUSED)/.test(a))).toBe(false);
    }));

  test("a long list shows the first few and says how many more, rather than flooding the report", () =>
    withFixture(async dir => {
      const actions: string[] = [];
      await reportDocRules(dir, actions);
      const shown = actions.filter(a => a.startsWith("DOC-RULE:"));
      expect(shown.length).toBe(DOC_RULES_SHOWN);
      expect(actions.join("\n")).toContain(`and ${DOC_RULES_SHOWN + 5 - DOC_RULES_SHOWN} more`);
    }, { "docs/many.md": Array.from({ length: DOC_RULES_SHOWN + 5 }, (_, i) => `- Never do thing number ${i} here.`).join("\n") + "\n" }));
});

describe("#2274: report mode writes nothing", () => {
  test("an AGENTS.md the --apply path WOULD write into is byte-identical after the report", () =>
    withFixture(async dir => {
      // `applyToAgentsMd` inserts after a `## Hard Constraints` heading and a
      // blank line, and does nothing without one — so only an AGENTS.md shaped
      // like this can witness that the scan ran with apply off.
      const path = join(dir, "AGENTS.md");
      const before = readFileSync(path);
      const actions: string[] = [];
      await reportDocRules(dir, actions);
      expect(actions.join("\n")).toContain(RULE);
      expect(readFileSync(path).equals(before)).toBe(true);
    }, {
      "docs/guide.md": `# Guide\n\n- ${RULE}.\n`,
      "AGENTS.md": "# P\n\n## Hard Constraints\n\n- Keep the build green at all times.\n",
    }));
});

describe("#2274: text rungate wrote is not reported as the project's rules", () => {
  test("a generated file's rule is left out and counted; a seeded-once file's rule is the project's", () =>
    withFixture(async dir => {
      const actions: string[] = [];
      await reportDocRules(dir, actions);
      const shown = actions.filter(a => a.startsWith("DOC-RULE:")).join("\n");
      // AGENTS.md is section-preserving: outside Hard Constraints it is generated.
      expect(shown).not.toContain("Always run the generated linter");
      // specs/SPEC-TEMPLATE.md is the scaffold's starter template.
      expect(shown).not.toContain("Never ship the template");
      // PROJECT-STATE.md is create-only: seeded once, then the project's.
      expect(shown).toContain("Never deploy on a Friday");
      expect(actions.join("\n")).toContain("2 from files rungate generates left out");
    }, {
      "AGENTS.md": "# P\n\n## Rules\n\n- Always run the generated linter first.\n",
      "specs/SPEC-TEMPLATE.md": "# T\n\n- Never ship the template as a spec.\n",
      "PROJECT-STATE.md": "# State\n\n- Never deploy on a Friday afternoon.\n",
    }));
});

describe("#2274: what could not be read is UNMEASURED, never 'no rules'", () => {
  test("a planned doc that cannot be read names the file and why", () =>
    withFixture(async dir => {
      const plan = planDocScan(dir);
      plan.files.push(join(dir, "docs", "vanished.md"));
      const actions: string[] = [];
      await reportDocRules(dir, actions, { plan });
      const text = actions.join("\n");
      expect(text).toContain("DOC-RULES: UNMEASURED");
      expect(text).toContain("docs/vanished.md");
      expect(text).toContain("ENOENT");
    }));

  test("a scan that throws is UNMEASURED with its message, and does not throw out of scaffold", () =>
    withFixture(async dir => {
      const actions: string[] = [];
      await reportDocRules(dir, actions, { extract: async () => { throw new Error("disk on fire"); } });
      expect(actions.join("\n")).toContain("DOC-RULES: UNMEASURED");
      expect(actions.join("\n")).toContain("disk on fire");
    }));
});

describe("#2274: scaffold and re-scaffold run it, and AGENTS.md is untouched by it", () => {
  test("re-scaffold prints the candidate, and AGENTS.md is byte-identical afterwards", () =>
    withFixture(dir => {
      const scaffold = (...extra: string[]) =>
        spawnSync("bun", [join(ROOT, "scripts", "scaffold-project.ts"), dir, ...extra], { cwd: ROOT, encoding: "utf-8" });
      const first = scaffold("--fix");
      expect(first.stdout).toContain(RULE);
      // A fresh tree's second scaffold re-detects the project type (content on
      // the first run, infra once scaffold has added .github/) and rewrites
      // AGENTS.md's identity line — unrelated to the scan. Settle it first.
      scaffold("--fix");
      const before = readFileSync(join(dir, "AGENTS.md"));
      const again = scaffold("--fix");
      expect(again.status).toBe(0);
      expect(again.stdout).toContain("DOC-RULES: 1 candidate rule");
      expect(again.stdout).toContain(RULE);
      expect(readFileSync(join(dir, "AGENTS.md")).equals(before)).toBe(true);
      expect(before.toString()).not.toContain(RULE);
      // The audit (no --fix) reports it too.
      expect(scaffold().stdout).toContain(RULE);
    }), 120_000);
});
