/**
 * #2946: the brief guard and the gates compile a brief-policy pattern through
 * one function, so they read one policy file the same way.
 *
 * Before this, the gates (`validateBriefAgainst`) stripped a leading `(?i)` and
 * set the `i` flag, which is the format `config/brief-policies.json` ships in.
 * The guard (`validateBriefPolicies`) called `new RegExp(pattern, 'i')`, which
 * throws on `(?i)`, so the shipped file copied into the skill folder read
 * `BRIEF CONTENT UNMEASURED` for every brief. And an entry with no pattern
 * compiled in the guard as `new RegExp(undefined)`, which matches every brief.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { briefPolicyMap, compileBriefPattern, compileBriefPolicy } from "../lib/brief-policy-pattern";
import { validateAgentBrief } from "../lib/agent-brief-validation";
import { shipSkillPath } from "../lib/ship-skill-folder";
import { loadBriefPolicies, validateBriefAgainst } from "../gates/brief-assembler";

const ROOT = join(import.meta.dir, "..");
const SHIPPED = readFileSync(join(ROOT, "config", "brief-policies.json"), "utf-8");

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** A base directory whose ship skill folder holds `policies` as its brief-policies.json. */
function baseWith(policies: string): string {
  const base = mkdtempSync(join(tmpdir(), "rg-2946-"));
  scratch.push(base);
  const file = shipSkillPath(base, "brief-policies.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, policies);
  mkdirSync(join(base, "work"), { recursive: true });
  return base;
}

/** What the guard says about a Marcus brief, given a policy file. */
function guard(policies: string, prompt: string): string[] {
  const base = baseWith(policies);
  const input = { tool_name: "Agent", tool_input: { prompt, subagent_type: "Engineer", mode: "bypassPermissions" } };
  return validateAgentBrief(input as never, join(base, "work"), base).outputs.filter(o => o.startsWith("BRIEF CONTENT"));
}

const BARE = ["## Context", "## Task", "## Verify", "## Report back"].join("\n\nContent here.\n\n");

describe("#2946: one function compiles a brief-policy pattern", () => {
  test("the shipped (?i) form is case-insensitive, and a plain pattern is not", () => {
    const shipped = compileBriefPattern({ name: "goal", pattern: "(?i)(goal|objective)" });
    expect(shipped.ok && shipped.re.test("The GOAL is x")).toBe(true);
    expect(shipped.ok && shipped.re.source).toBe("(goal|objective)");
    const plain = compileBriefPattern({ name: "goal", pattern: "goal" });
    expect(plain.ok && plain.re.test("goal")).toBe(true);
    expect(plain.ok && plain.re.test("GOAL")).toBe(false);
  });

  test("an entry with no pattern, a non-string one, or one that matches every brief is unreadable, naming the entry", () => {
    for (const [entry, says] of [
      [{ name: "goal" }, `"goal" has no pattern`],
      [{ name: "goal", pattern: 7 }, `"goal" has a pattern that is number, not a string`],
      [{ name: "goal", pattern: null }, `"goal" has a pattern that is null, not a string`],
      [{ name: "goal", pattern: "" }, `"goal" has an empty pattern`],
      [{ name: "goal", pattern: "(?i)" }, `"goal" has an empty pattern`],
      // Review of #2960: a name is what a WARN reports, so an entry without one is refused.
      [{ pattern: 7 }, "an entry with no name"],
      [{ pattern: "(?i)goal" }, "an entry with no name"],
      [{ name: " ", pattern: "(?i)goal" }, "an entry with no name"],
      ["goal", "an entry that is not an object"],
    ] as const) {
      const c = compileBriefPattern(entry);
      expect(c.ok, JSON.stringify(entry)).toBe(false);
      expect(c.ok ? "" : c.why, JSON.stringify(entry)).toContain(says);
    }
    const broken = compileBriefPattern({ name: "goal", pattern: "(unclosed" });
    expect(broken.ok ? "" : broken.why).toContain(`the pattern for "goal" is not a regular expression`);
  });

  test("every pattern in the shipped policy file compiles", () => {
    const policies = JSON.parse(SHIPPED).policies as Record<string, { requiredPatterns: unknown[] }>;
    const entries = Object.values(policies).flatMap(p => p.requiredPatterns);
    expect(entries.length, "the shipped file holds almost nothing, so this case measured nothing").toBeGreaterThan(5);
    expect(entries.map(compileBriefPattern).filter(c => !c.ok)).toEqual([]);
  });
});

describe("#2946: the guard and the gates read the shipped file the same way", () => {
  test("the shipped file, copied unchanged into the skill folder, is read by the guard: a bare brief gets a WARN, never UNMEASURED", () => {
    const said = guard(SHIPPED, BARE);
    expect(said.filter(o => o.startsWith("BRIEF CONTENT UNMEASURED")), said.join("\n")).toEqual([]);
    expect(said.filter(o => o.startsWith("BRIEF CONTENT WARN")), said.join("\n")).toHaveLength(1);
  });

  test("the guard and the gates agree on the shipped file: a bare brief fails both, a full one passes both", () => {
    // Review of #2960: the Marcus template markers too, or the guard blocks the
    // brief before it reads any policy and the last assertion holds vacuously.
    const full = [
      "## Context\n\nThe goal is what to implement: the thing.",
      "## Task\n\nAC-1 holds. Files to modify: lib/x.ts. Out of scope: everything else; do not touch lib/y.ts.",
      "## Verify\n\nRun the tests.",
      "## Report back\n\nSay what changed.",
    ].join("\n\n");
    const policies = JSON.parse(SHIPPED);
    expect(validateBriefAgainst(BARE, policies)).toBe(false);
    expect(guard(SHIPPED, BARE).some(o => o.startsWith("BRIEF CONTENT WARN"))).toBe(true);
    expect(validateBriefAgainst(full, policies)).toBe(true);
    expect(guard(SHIPPED, full), "a full brief got a content line from the guard").toEqual([]);
    // The full brief reaches the policy stage: one more required pattern it lacks is warned about.
    const plus = { policies: { marcus: { requiredPatterns: [...policies.policies.marcus.requiredPatterns, { name: "never", pattern: "zz-never-present-zz" }] } } };
    expect(guard(JSON.stringify(plus), full).filter(o => o.startsWith("BRIEF CONTENT WARN")).join("")).toContain("never");
  });

  test("an entry with no pattern is reported unreadable by both readers, naming it", () => {
    const policies = { policies: { marcus: { requiredPatterns: [{ name: "goal", pattern: "(?i)goal" }, { name: "scope" }] } } };
    const said = guard(JSON.stringify(policies), BARE);
    const unmeasured = said.filter(o => o.startsWith("BRIEF CONTENT UNMEASURED"));
    expect(unmeasured, said.join("\n")).toHaveLength(1);
    expect(unmeasured[0]).toContain(`"scope" has no pattern`);
    expect(() => validateBriefAgainst("goal and scope", policies)).toThrow(/"scope" has no pattern/);
  });
});

describe("#2946, review of #2960: both readers read the whole list, and an empty one, the same way", () => {
  test("compileBriefPolicy compiles every entry before any is tested, and refuses an absent or empty list", () => {
    const ok = compileBriefPolicy([{ name: "goal", pattern: "(?i)goal" }, { name: "scope", pattern: "scope" }]);
    expect(ok.ok && ok.patterns.map(p => p.name)).toEqual(["goal", "scope"]);
    for (const list of [[], undefined, null, {}, "x"]) {
      const c = compileBriefPolicy(list);
      expect(c.ok ? "" : c.why, JSON.stringify(list)).toContain("declares no requiredPatterns");
    }
    const late = compileBriefPolicy([{ name: "goal", pattern: "(?i)goal" }, { name: "scope" }]);
    expect(late.ok ? "" : late.why).toContain(`"scope" has no pattern`);
  });

  test("an unreadable entry after one the brief misses is named by the gates, as the guard names it", () => {
    const policies = { policies: { marcus: { requiredPatterns: [{ name: "goal", pattern: "(?i)goal" }, { name: "scope" }] } } };
    expect(() => validateBriefAgainst("nothing here", policies)).toThrow(/"scope" has no pattern/);
    const said = guard(JSON.stringify(policies), BARE).filter(o => o.startsWith("BRIEF CONTENT UNMEASURED"));
    expect(said.join(""), "the guard and the gates disagree on the file").toContain(`"scope" has no pattern`);
  });

  test("an empty or absent requiredPatterns is unreadable to the guard, as the gates refuse it", () => {
    for (const marcus of [{ requiredPatterns: [] }, {}]) {
      const policies = { policies: { marcus } };
      expect(() => validateBriefAgainst(BARE, policies), JSON.stringify(marcus)).toThrow(/no requiredPatterns/);
      const said = guard(JSON.stringify(policies), BARE);
      expect(said.filter(o => o.startsWith("BRIEF CONTENT UNMEASURED")).join(""), JSON.stringify(marcus)).toContain("declares no requiredPatterns");
    }
    // Control: a file that names no policy for this agent polices nothing for it.
    expect(guard(JSON.stringify({ policies: { quinn: { requiredPatterns: [{ name: "x", pattern: "x" }] } } }), BARE)).toEqual([]);
  });
});

describe("#2946, review round 2 of #2960: a policies member that is not an object is unreadable, never no policy", () => {
  const CORRUPT = [{ policies: "oops" }, { policies: null }, { policies: [] }, { description: "x" }];

  test("briefPolicyMap refuses a file, or a policies member, that is not an object", () => {
    for (const doc of [...CORRUPT, [], "x", null]) expect(briefPolicyMap(doc).ok, JSON.stringify(doc)).toBe(false);
    expect(briefPolicyMap({ policies: "oops" })).toEqual({ ok: false, why: `has no "policies" object (it is string)` });
    expect(briefPolicyMap({ policies: [] })).toEqual({ ok: false, why: `has no "policies" object (it is an array)` });
    expect(briefPolicyMap({ description: "x" })).toEqual({ ok: false, why: `has no "policies" object (it is absent)` });
    expect(briefPolicyMap([])).toEqual({ ok: false, why: "is not a JSON object" });
    const ok = briefPolicyMap({ policies: { quinn: {} } });
    expect(ok.ok && Object.keys(ok.policies)).toEqual(["quinn"]);
  });

  test("the guard reports each one UNMEASURED and the gates refuse it, both naming the policies member", () => {
    for (const doc of CORRUPT) {
      const said = guard(JSON.stringify(doc), BARE).filter(o => o.startsWith("BRIEF CONTENT UNMEASURED"));
      expect(said.join(""), JSON.stringify(doc)).toContain(`has no "policies" object`);
      expect(() => validateBriefAgainst(BARE, doc), JSON.stringify(doc)).toThrow(/has no "policies" object/);
    }
  });

  test("the gates' loader refuses a local override whose policies is not an object, rather than merging it as nothing", () => {
    const home = mkdtempSync(join(tmpdir(), "rg-2946-home-"));
    scratch.push(home);
    const file = shipSkillPath(join(home, ".claude"), "brief-policies.json");
    mkdirSync(dirname(file), { recursive: true });
    const was = process.env.HOME;
    process.env.HOME = home;
    try {
      for (const doc of CORRUPT) {
        writeFileSync(file, JSON.stringify(doc));
        expect(() => loadBriefPolicies(), JSON.stringify(doc)).toThrow(/override .* has no "policies" object/);
      }
      // Control: a readable override is merged over the shipped file.
      const mine = [{ name: "x", pattern: "x" }];
      writeFileSync(file, JSON.stringify({ policies: { marcus: { requiredPatterns: mine } } }));
      expect(loadBriefPolicies().policies.marcus.requiredPatterns).toEqual(mine);
    } finally {
      if (was === undefined) delete process.env.HOME;
      else process.env.HOME = was;
    }
  });
});
