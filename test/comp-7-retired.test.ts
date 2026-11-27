/**
 * #2939: COMP-7 ("use Read, not cat/head/tail via Bash") is retired —
 * registered nowhere, scaffolded to no consumer, graded for no role, and no
 * hill-climb can bring it back from the history file.
 *
 * Why it was retired, for the record (Jason's decision, 2026-11-27): Claude
 * Code's Edit and Write tools refuse a file that was not Read in the session,
 * and its bypass-mode prompt tells the model to read files with cat or head.
 * BashToolGuard refused 1,205 tool calls in 30 days and protected nothing the
 * platform does not.
 *
 * Every assertion is paired with a positive one over the same reading — a
 * hooks list, criteria list or rule set that came back empty would satisfy
 * every `not.toContain` below and witness nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildDefaultHooks } from "../lib/scaffold/defaults";
import { getCriteria, type Role } from "../lib/transcript-checker";
import {
  detectHillClimbNeeds,
  hillClimbSectionPreference,
  setComplianceProjectRoot,
  type ComplianceReport,
} from "../lib/compliance-report";

const ROOT = join(import.meta.dir, "..");
const RETIRED_HOOK = "BashToolGuard";
const RETIRED_COMP = "COMP-7";
// The directive id the policy used to fold into COMP-7.
const RETIRED_DIRECTIVE = "DIR-L25";

describe("#2939: COMP-7 is registered nowhere", () => {
  test("the repo's hook declarations do not name BashToolGuard", () => {
    const hooks: { name: string }[] = JSON.parse(
      readFileSync(join(ROOT, ".claude/rungate/hooks.json"), "utf-8"),
    );
    const names = hooks.map((h) => h.name);
    expect(names).toContain("TopLevelCdGuard");
    expect(names).not.toContain(RETIRED_HOOK);
  });

  test("the committed project settings do not run it", () => {
    const settings = readFileSync(join(ROOT, ".claude/settings.json"), "utf-8");
    expect(settings).toContain("BunTestPathGuard.hook.ts");
    expect(settings).not.toContain(`${RETIRED_HOOK}.hook.ts`);
  });

  test("the hook file is gone, so nothing can register it by path", () => {
    expect(existsSync(join(ROOT, "hooks", "TopLevelCdGuard.hook.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "hooks", `${RETIRED_HOOK}.hook.ts`))).toBe(false);
  });
});

describe("#2939: COMP-7 is scaffolded to no consumer", () => {
  test("a greenfield hooks.json carries no BashToolGuard", () => {
    const names = buildDefaultHooks().map((h) => h.name);
    expect(names).toContain("TestSuiteGuard");
    expect(names).not.toContain(RETIRED_HOOK);
  });
});

describe("#2939: COMP-7 is graded for no role", () => {
  const ROLES: Role[] = ["da", "marcus", "quinn"];

  test.each(ROLES)("%s has criteria, and none is COMP-7", (role) => {
    const ids = getCriteria(role).map((c) => c.id);
    expect(ids).toContain("COMP-6");
    expect(ids).not.toContain(RETIRED_COMP);
  });
});

describe("#2939: no hill-climb revives COMP-7 from the history file", () => {
  // The history file keeps every COMP-7 verdict ever recorded, so a trend
  // over it still carries COMP-7 failures. Retirement means the policy has
  // nothing to reinforce or promote for them — under the repo's own
  // compliance.json AND under the hardcoded fallback a consumer with no
  // config gets.
  const FAILING = ["IGNORED", "IGNORED", "IGNORED", "IGNORED", "IGNORED"];
  const report = (): ComplianceReport => ({
    role: "marcus",
    issue: "#2939",
    current: { followed: 0, total: 3, pct: 0 },
    threshold: 70,
    belowThreshold: true,
    trend: { pcts: [0], direction: "stable" },
    compTrends: [
      // The control: a live COMP failing the same way must still raise an
      // action, or an empty result below proves nothing.
      { compId: "COMP-6", rule: "No duplicate reads", lastN: FAILING, passRate: 0, direction: "stable" },
      { compId: RETIRED_COMP, rule: "No cat/head via Bash", lastN: FAILING, passRate: 0, direction: "stable" },
      { compId: RETIRED_DIRECTIVE, rule: "cat via Bash", lastN: FAILING, passRate: 0, direction: "stable" },
    ],
    alerts: [],
  });

  let scratch: string | undefined;
  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  test("the repo's compliance.json declares no COMP-7 and folds no directive into it", () => {
    const config: { rules: Record<string, { directives: string[] }> } = JSON.parse(
      readFileSync(join(ROOT, ".claude/rungate/compliance.json"), "utf-8"),
    );
    expect(Object.keys(config.rules)).toContain("COMP-6");
    expect(Object.keys(config.rules)).not.toContain(RETIRED_COMP);
    const directives = Object.values(config.rules).flatMap((r) => r.directives);
    expect(directives).toContain("DIR-L29");
    expect(directives).not.toContain(RETIRED_DIRECTIVE);
  });

  test("under the repo's compliance.json", () => {
    setComplianceProjectRoot(ROOT);
    const ids = detectHillClimbNeeds(report()).map((a) => a.compId);
    expect(ids).toContain("COMP-6");
    expect(ids).not.toContain(RETIRED_COMP);
    expect(ids).not.toContain(RETIRED_DIRECTIVE);
  });

  test("and a COMP-7 action handed in by hand has no section to land in", () => {
    expect(hillClimbSectionPreference("COMP-6")).not.toBeNull();
    expect(hillClimbSectionPreference(RETIRED_COMP)).toBeNull();
  });

  test("under the fallback maps a project with no compliance.json gets", () => {
    scratch = mkdtempSync(join(tmpdir(), "comp-7-retired-"));
    setComplianceProjectRoot(scratch);
    const ids = detectHillClimbNeeds(report()).map((a) => a.compId);
    expect(ids).toContain("COMP-6");
    expect(ids).not.toContain(RETIRED_COMP);
    expect(ids).not.toContain(RETIRED_DIRECTIVE);
  });
});
