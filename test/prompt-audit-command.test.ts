/**
 * Covers SC-2805 (RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md).
 *
 * #2606: `rungate prompt-audit` runs every rendered-surface lint plus
 * pressure-density and dangling-path on a consumer, labels each finding
 * consumer-owned or harness-owned, and writes rungate's findings as upstream
 * drafts without filing them (ADR-024 decision 7).
 *
 * Every case runs against the golden fixture rendered by the consumer's own
 * command, `rungate scaffold <dir> --fix`, then planted. Ownership is asserted
 * on both sides of each boundary the scaffold preserves, because a reader
 * that called everything one owner would pass any one-sided case.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  PRESSURE_FLOOR,
  PROMPT_AUDIT_LINTS,
  generatedNames,
  lineOwners,
  looksLikeRepoPath,
  promptAudit,
  upstreamBodies,
  writeUpstreamBodies,
  type PromptAudit,
} from "../lib/prompt-audit";
import { symptomKeys } from "../lib/finding-arbiter";
import { SURFACE_LINTS } from "../lib/surface-lint";
import { commitFixture, initFixtureRepo } from "./helpers/git-fixture";

const ROOT = join(import.meta.dir, "..");
const FIXTURE = join(import.meta.dir, "fixtures", "golden-project");
const scratch = mkdtempSync(join(tmpdir(), "rg-2606-prompt-audit-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let rendered = "";
beforeAll(() => {
  rendered = join(scratch, "rendered");
  cpSync(FIXTURE, rendered, { recursive: true });
  initFixtureRepo(rendered);
  commitFixture(rendered, "init fixture consumer");
  const r = spawnSync("bun", [join(ROOT, "bin", "rungate.ts"), "scaffold", rendered, "--fix"], {
    cwd: rendered,
    encoding: "utf-8",
    timeout: 120_000,
    env: { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "", GITHUB_API_URL: "http://127.0.0.1:1" },
  });
  expect(r.status, r.stderr).toBe(0);
}, 180_000);

/** A copy of the render with each `[path, text]` appended to (or creating) that file. */
function planted(...edits: [string, string][]): string {
  const root = join(scratch, `planted-${Math.random().toString(36).slice(2)}`);
  cpSync(rendered, root, { recursive: true });
  for (const [rel, text] of edits) {
    const at = join(root, rel);
    mkdirSync(join(at, ".."), { recursive: true });
    writeFileSync(at, (existsSync(at) ? readFileSync(at, "utf-8") : "") + "\n" + text + "\n");
  }
  return root;
}

const of = (audit: PromptAudit, lint: string) => audit.findings.filter(f => f.lint === lint).map(f => `${f.owner} ${f.file}`);

/** Six markers in about sixty words: over both the floor and the rate. */
const PRESSURE = "You MUST read this. You MUST NOT skip it. NEVER edit it. This is CRITICAL and IMPORTANT, and it is MANDATORY for every agent working in this project today.";

describe("SC-2805: `rungate prompt-audit` runs the rendered-surface lints plus pressure-density and dangling-path lints on a consumer, labels each finding consumer-owned or harness-owned, and writes harness-owned findings as reporting-upstream.md bodies without filing them", () => {
  test("every lint runs, the clean render has no finding, and the reader saw real files", () => {
    const audit = promptAudit(rendered);
    expect(audit.lints).toEqual([...SURFACE_LINTS.map(l => l.name), "pressure-density", "dangling-path"]);
    expect(PROMPT_AUDIT_LINTS).toEqual(audit.lints);
    expect(audit.findings).toEqual([]);
    // Not vacuous: the render has generated rules and briefs for the owners below.
    expect(readdirSync(join(rendered, ".claude", "rules")).length).toBeGreaterThan(3);
    expect(existsSync(join(rendered, ".claude", "agents", "marcus.md"))).toBe(true);
  });

  test("pressure-density: enough markers at a high enough rate is a finding; fewer, or the same spread thin, is not", () => {
    expect(of(promptAudit(planted(["CLAUDE.md", PRESSURE])), "pressure-density")).toEqual(["consumer CLAUDE.md"]);
    // One under the floor.
    const four = "You MUST read this. NEVER edit it. This is CRITICAL and IMPORTANT for every agent.";
    expect((four.match(/\b(?:MANDATORY|NEVER|CRITICAL|MUST|IMPORTANT|ZERO EXCEPTIONS)\b/g) ?? []).length).toBe(PRESSURE_FLOOR - 1);
    expect(of(promptAudit(planted(["CLAUDE.md", four])), "pressure-density")).toEqual([]);
    // Six markers in about 3,000 words is under the rate.
    const thin = `${PRESSURE}\n\n${"This line is ordinary guidance for the project. ".repeat(400)}`;
    expect(of(promptAudit(planted(["CLAUDE.md", thin])), "pressure-density")).toEqual([]);
    // Lower-case words are not pressure, and a fenced example is not read.
    expect(of(promptAudit(planted(["CLAUDE.md", PRESSURE.toLowerCase()])), "pressure-density")).toEqual([]);
    expect(of(promptAudit(planted(["CLAUDE.md", "```\n" + PRESSURE + "\n```"])), "pressure-density")).toEqual([]);
  });

  test("dangling-path: a path whose directory exists and file does not is a finding; anything else is not", () => {
    const audit = promptAudit(planted(["CLAUDE.md", "The rules live in `specs/RETIRED-SPEC.md`."]));
    expect(audit.findings.filter(f => f.lint === "dangling-path").map(f => f.message)).toEqual([
      expect.stringContaining("names `specs/RETIRED-SPEC.md`; its directory exists and the file does not"),
    ]);
    for (const quiet of [
      "See `specs/api-spec.md`.", // exists
      "See `nowhere/at-all.md`.", // no such directory: an example, not a reference
      "See `specs/*.md`.", // a pattern
      "```\nsee `specs/RETIRED-SPEC.md`\n```", // fenced
      "See `node_modules/rungate/AGENTS.md`.", // the package, not the project
    ]) {
      expect(of(promptAudit(planted(["CLAUDE.md", quiet])), "dangling-path"), quiet).toEqual([]);
    }
  });

  // #2779: an example path in a rendered rule names no directory any tree has,
  // so rungate's own audit reports no harness-owned dangling-path finding on
  // rungate, where `lib/scaffold/` exists. A real file would dangle in every
  // consumer with that directory. This pins that one lint, not the whole audit.
  test("rungate's own tree has no harness-owned dangling-path finding", () => {
    expect(promptAudit(ROOT).findings.filter(f => f.lint === "dangling-path" && f.owner === "harness").map(f => `${f.file}: ${f.message}`)).toEqual([]);
  });

  // #2784: every lint, not one. The same reading runs on rungate's own tree and
  // on a render planted with one harness-owned trigger per lint, so the empty
  // reading on rungate is only believed for lints the planted case shows it
  // can see.
  const harnessFindings = (root: string): string[] =>
    promptAudit(root).findings.filter(f => f.owner === "harness").map(f => `${f.lint} ${f.file}: ${f.message}`);

  test("rungate's own tree has no harness-owned finding of any lint", () => {
    expect(harnessFindings(ROOT)).toEqual([]);
  });

  // #2799 review: `lints` is a constant, so its length proved nothing ran, and
  // one planted lint left the other four unwitnessed. Each lint the audit
  // registers gets its own trigger here, in a file rungate owns, so a lint
  // dropped from the run or a lint's findings filtered out turns this red.
  test("the same reading names a harness-owned finding of every lint, on a render planted for each", () => {
    const triggers: Record<string, [string, string]> = {
      "dangling-read-target": [".claude/agents/discovery.md", "Look up the governing spec in the AGENTS.md Specs table."],
      "template-artifact": [".claude/agents/marcus.md", "Read ${SOURCE_DIRS} first."],
      "stale-count": [".claude/rules/docs-routing.md", "| Decisions | `docs/adr/` (3 files) |"],
      "pressure-density": [".claude/rules/key-files.md", PRESSURE],
      "dangling-path": ["AGENTS.md", "The rules live in `specs/RETIRED-SPEC.md`."],
    };
    // Every lint the registry runs, plus the audit's own two, has a trigger:
    // a lint added without one fails here rather than going unwitnessed.
    const registered = [...SURFACE_LINTS.map(l => l.name), "pressure-density", "dangling-path"];
    expect(registered.length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(triggers).sort()).toEqual([...registered].sort());
    const root = planted(...Object.values(triggers));
    expect([...promptAudit(root).lints].sort()).toEqual([...registered].sort());
    const found = new Set(harnessFindings(root).map(h => h.split(" ")[0]));
    expect(registered.filter(l => !found.has(l)), "these lints found nothing in a render planted for them").toEqual([]);
  });

  // #2780 review: the filing rule's example is a placeholder, not a path, so an
  // agent that copies it names no path, and two reports that both copied it
  // share no duplicate key.
  test("the reporting-upstream example is read as a placeholder by both the lint and the filing gate's keys", () => {
    const rule = readFileSync(join(ROOT, ".claude", "rules", "reporting-upstream.md"), "utf-8");
    const line = rule.split("\n").find(l => l.includes("path with its directory"));
    expect(line, "the rule's example line").toBeDefined();
    const tokens = [...line!.matchAll(/`([^`]+)`/g)].map(m => m[1]!);
    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) expect(looksLikeRepoPath(t), t).toBe(false);
    expect(symptomKeys({ title: "t", body: line! } as Parameters<typeof symptomKeys>[0]).filter(k => k.startsWith("file:"))).toEqual([]);
  });

  test("a finding belongs to whoever wrote the line: each preserved section on both sides of its boundary", () => {
    const artifact = "Read the files in ${SOURCE_DIRS} first.";
    const owners = (root: string) => of(promptAudit(root), "template-artifact");
    // AGENTS.md: rungate's, except under ## Hard Constraints.
    expect(owners(planted(["AGENTS.md", artifact]))).toEqual(["harness AGENTS.md"]);
    const agents = readFileSync(join(rendered, "AGENTS.md"), "utf-8");
    expect(agents).toMatch(/^## Hard Constraints/m);
    const underHard = planted();
    writeFileSync(join(underHard, "AGENTS.md"), agents.replace(/^(## Hard Constraints[^\n]*\n)/m, `$1\n${artifact}\n`));
    expect(owners(underHard)).toEqual(["consumer AGENTS.md"]);
    // A generated rule: rungate's, except under ## Project-owned.
    expect(owners(planted([".claude/rules/key-files.md", artifact]))).toEqual(["harness .claude/rules/key-files.md"]);
    expect(owners(planted([".claude/rules/key-files.md", `## Project-owned\n\n${artifact}`]))).toEqual(["consumer .claude/rules/key-files.md"]);
    // A generated rule from a scaffold that did not stamp yet is still rungate's.
    const unstamped = planted();
    const keyFiles = join(unstamped, ".claude", "rules", "key-files.md");
    writeFileSync(keyFiles, readFileSync(keyFiles, "utf-8").replace(/^generated-sha:.*\n/m, "") + `\n${artifact}\n`);
    expect(readFileSync(keyFiles, "utf-8")).not.toContain("generated-sha:");
    expect(owners(unstamped)).toEqual(["harness .claude/rules/key-files.md"]);
    // A rule the project wrote is the project's.
    expect(owners(planted([".claude/rules/our-own.md", `---\ndescription: our own rule, written by hand\n---\n\n${artifact}`]))).toEqual(["consumer .claude/rules/our-own.md"]);
    // A brief: rungate's, except under ## Project Constraints; a brief with no template is the project's.
    expect(owners(planted([".claude/agents/marcus.md", artifact]))).toEqual(["harness .claude/agents/marcus.md"]);
    expect(owners(planted([".claude/agents/marcus.md", `## Project Constraints\n\n${artifact}`]))).toEqual(["consumer .claude/agents/marcus.md"]);
    expect(owners(planted([".claude/agents/our-agent.md", artifact]))).toEqual(["consumer .claude/agents/our-agent.md"]);
    // CLAUDE.md is the project's.
    expect(owners(planted(["CLAUDE.md", artifact]))).toEqual(["consumer CLAUDE.md"]);
  });

  test("the generator decides which rule names are rungate's, so a new generated rule needs no second list", () => {
    const { rules, commands } = generatedNames();
    for (const r of readdirSync(join(rendered, ".claude", "rules"))) {
      const text = readFileSync(join(rendered, ".claude", "rules", r), "utf-8");
      if (/^generated-sha:/m.test(text)) expect(rules.has(r), `${r} is stamped by the scaffold but not a generated name`).toBe(true);
    }
    expect([...commands].sort()).toEqual(["board.md", "dry-run.md", "work-loop.md"]);
    expect(lineOwners(".claude/rules/docs-routing.md", "no stamp at all\n").every(o => o === "harness")).toBe(true);
  });

  test("rungate's findings become upstream drafts, the project's do not, and nothing is filed", () => {
    const root = planted([".claude/agents/marcus.md", "Read ${SOURCE_DIRS}."], ["CLAUDE.md", PRESSURE]);
    const audit = promptAudit(root);
    expect(audit.findings.map(f => `${f.owner} ${f.lint}`).sort()).toEqual(["consumer pressure-density", "harness template-artifact"]);
    const bodies = upstreamBodies(audit, "rungate 9.9.9, read for this test");
    expect([...bodies.keys()]).toEqual(["template-artifact"]);
    const body = bodies.get("template-artifact")!;
    for (const part of [
      /^Claim <N>: /m,
      /^Cannot be a comment: out-of-pr-diff$/m,
      /^## What must become true$/m,
      /^## Files this will change$/m,
      /^## How we will know$/m,
      /`\.claude\/agents\/marcus\.md`/, // a path with its directory, which the filing gate dedupes on
      /rungate 9\.9\.9/,
    ]) expect(body).toMatch(part);
    const out = join(scratch, `drafts-${Math.random().toString(36).slice(2)}`);
    expect(writeUpstreamBodies(bodies, out)).toEqual([join(out, "upstream-template-artifact.md")]);
    expect(readFileSync(join(out, "upstream-template-artifact.md"), "utf-8")).toBe(body);
    // Nothing that could file: no gh, no GitHub API, no network call, in the module or its script.
    for (const src of ["lib/prompt-audit.ts", "scripts/prompt-audit.ts"]) {
      const code = readFileSync(join(ROOT, src), "utf-8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      expect(code, src).not.toMatch(/spawn|exec|fetch\(|Octokit|api\.github|["'`]gh["'`\s]/);
    }
  });

  test("the command prints both owners, writes the drafts, and refuses a tree rungate did not render", () => {
    const root = planted([".claude/agents/marcus.md", "Read ${SOURCE_DIRS}."], ["CLAUDE.md", PRESSURE]);
    const out = join(scratch, `cli-${Math.random().toString(36).slice(2)}`);
    const run = (args: string[]) => spawnSync("bun", [join(ROOT, "bin", "rungate.ts"), "prompt-audit", ...args], { cwd: root, encoding: "utf-8" });
    const r = run(["--out", out]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("harness-owned (1)");
    expect(r.stdout).toContain("consumer-owned (1)");
    expect(r.stdout).toContain("NOT filed");
    expect(readdirSync(out)).toEqual(["upstream-template-artifact.md"]);
    const empty = mkdtempSync(join(scratch, "unrendered-"));
    const refused = run(["--project-root", empty]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("UNMEASURED");
    expect(refused.stdout).not.toContain("finding(s)");
  });
});
