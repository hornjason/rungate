/**
 * Config path naming — generated guidance must point agents at the rungate
 * config directory (`.claude/rungate/`), never the retired monolith
 * `.claude/rungate.json`.
 *
 * AC-1: generated AGENTS.md harness-owned table names the rungate directory
 *       for ci.yml, gates.yml, and agent briefs
 * AC-2: Dev UI / Dev API not-configured fallbacks name the rungate directory
 * AC-3: no agent-brief template names .claude/rungate.json
 * AC-4: regression — .claude/rungate.json must not reappear in generated
 *       AGENTS.md content or generated brief content
 *
 * #2621: "never the monolith" holds for a project that is not on it. A
 * consumer still on the monolith keeps it — the scaffold never rewrites it,
 * and `.claude/rules/config-access.md` supports both layouts indefinitely —
 * so a brief rendered for that consumer names `.claude/rungate.json`, the
 * file it has, rather than sending its agent to a directory that does not
 * exist. No template or generator spells either path: the brief generator
 * fills `${CONFIG_FILE}` from `resolveConfig`.
 */
import { test, expect, describe, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const TEMPLATES_DIR = join(ROOT, "templates/agent-briefs");

/** The retired monolith path. Must never appear in generated guidance. */
const MONOLITH = ".claude/rungate.json";
/** The directory that replaced it. */
const CONFIG_DIR = ".claude/rungate/";

/** Matches `.claude/rungate.json` but not `.claude/rungate/config.json`. */
const MONOLITH_RE = /\.claude\/rungate\.json/;
/** Either layout's config file, spelled out. */
const ANY_CONFIG_PATH_RE = /\.claude\/rungate(?:\.json|\/config\.json)/;

async function scopedRules() {
  const { generateScopedRules } = await import("../lib/generators/agents-md");
  const { mockProjectScan } = await import("../lib/generators/types");
  return generateScopedRules(mockProjectScan({ name: "test-project" }));
}

async function harnessManagedRule() {
  const rules = await scopedRules();
  const rule = rules.find(r => r.filename === "harness-managed.md");
  expect(rule).toBeDefined();
  return rule!;
}

/**
 * The TABLE row for one file, not the first line that mentions it.
 *
 * `.find(l => l.includes("ci.yml"))` used to be enough. #208 made the rule's
 * frontmatter list the owned paths, so `  - ".github/workflows/ci.yml"` now
 * comes first and these three tests failed against a correct file. A
 * selector that picks "the first line containing a string" is the same
 * defect as an assertion that matches a string rather than a position —
 * `.claude/rules/claiming-sc-coverage.md`. Anchor on the table's own shape.
 */
async function managedRow(path: string): Promise<string> {
  const rule = await harnessManagedRule();
  const rows = rule.content
    .split("\n")
    .filter(l => l.startsWith(`| \`${path}\` |`));
  expect(rows, `no table row declares \`${path}\``).toHaveLength(1);
  return rows[0];
}

// ── AC-1: harness-owned table names the rungate directory ──────────────

describe("AC-1: generated AGENTS.md harness-owned table", () => {
  test("ci.yml row names the rungate directory, not the monolith", async () => {
    const row = await managedRow(".github/workflows/ci.yml");
    expect(row).toContain(CONFIG_DIR);
    expect(row).not.toMatch(MONOLITH_RE);
  });

  test("gates.yml row names the rungate directory, not the monolith", async () => {
    const row = await managedRow(".github/workflows/gates.yml");
    expect(row).toContain(CONFIG_DIR);
    expect(row).not.toMatch(MONOLITH_RE);
  });

  test("agent briefs row names the rungate directory, not the monolith", async () => {
    const row = await managedRow(".claude/agents/*.md");
    expect(row).toContain(CONFIG_DIR);
    expect(row).not.toMatch(MONOLITH_RE);
  });
});

// ── AC-2: Dev UI / Dev API fallbacks ───────────────────────────────────

describe("AC-2: not-configured fallback lines", () => {
  test("agent-briefs.ts fallbacks spell no config path: they name the file the consumer has (#2621)", () => {
    const src = readFileSync(join(ROOT, "lib/generators/agent-briefs.ts"), "utf-8");
    const fallbacks = src.split("\n").filter(l => l.includes("not configured"));
    expect(fallbacks.length).toBeGreaterThanOrEqual(2);
    for (const line of fallbacks) {
      expect(line).not.toMatch(ANY_CONFIG_PATH_RE);
      expect(line).toContain("configFile");
    }
  });

  test("generated briefs render the directory path when dev is unconfigured", async () => {
    const { generateAgentBriefs } = await import("../lib/generators/agent-briefs");
    const { mockProjectScan } = await import("../lib/generators/types");
    const briefs = generateAgentBriefs(mockProjectScan({
      name: "test-project",
      harnessTemplatesDir: TEMPLATES_DIR,
    }));
    const rendered = Object.values(briefs).join("\n");
    expect(rendered.length).toBeGreaterThan(0);

    const notConfigured = rendered.split("\n").filter(l => l.includes("not configured"));
    expect(notConfigured.length).toBeGreaterThanOrEqual(2);
    for (const line of notConfigured) {
      expect(line).toContain(CONFIG_DIR);
    }
  });
});

// ── AC-3: no template names the monolith ───────────────────────────────

describe("AC-3: agent-brief templates", () => {
  const templates = readdirSync(TEMPLATES_DIR).filter(f => f.endsWith(".md"));

  test("template directory is non-empty", () => {
    expect(templates.length).toBeGreaterThan(0);
  });

  for (const file of templates) {
    test(`${file} does not name ${MONOLITH}`, () => {
      const content = readFileSync(join(TEMPLATES_DIR, file), "utf-8");
      expect(content).not.toMatch(MONOLITH_RE);
    });
    // #2621: nor the directory layout's file. A literal there is what sent a
    // monolith consumer's agent to a file it does not have.
    test(`${file} spells no config path, only \${CONFIG_FILE}`, () => {
      const content = readFileSync(join(TEMPLATES_DIR, file), "utf-8");
      expect(content).not.toMatch(ANY_CONFIG_PATH_RE);
    });
  }

  test("the three briefs that send their agent to the config do it through ${CONFIG_FILE}", () => {
    for (const file of ["aditi.md", "discovery.md", "quinn.md"]) {
      expect(readFileSync(join(TEMPLATES_DIR, file), "utf-8"), file).toContain("${CONFIG_FILE}");
    }
  });
});

// ── AC-4: regression guard on generated output ─────────────────────────

describe("AC-4: regression — monolith path must not reappear", () => {
  test("generated AGENTS.md body is free of the monolith path", async () => {
    const { generateAgentsMd } = await import("../lib/generators/agents-md");
    const { mockProjectScan } = await import("../lib/generators/types");
    const md = generateAgentsMd(mockProjectScan({ name: "test-project" }));
    expect(md).not.toMatch(MONOLITH_RE);
  });

  test("every generated scoped rule file is free of the monolith path", async () => {
    const rules = await scopedRules();
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.content).not.toMatch(MONOLITH_RE);
    }
  });

  test("every generated agent brief is free of the monolith path", async () => {
    const { generateAgentBriefs } = await import("../lib/generators/agent-briefs");
    const { mockProjectScan } = await import("../lib/generators/types");
    const briefs = generateAgentBriefs(mockProjectScan({
      name: "test-project",
      harnessTemplatesDir: TEMPLATES_DIR,
    }));
    expect(Object.keys(briefs).length).toBeGreaterThan(0);
    for (const [name, content] of Object.entries(briefs)) {
      expect(`${name}: ${content}`).not.toMatch(MONOLITH_RE);
    }
  });
});

// ── #2621: a brief names the config file the consumer actually has ────────

describe("#2621: a rendered brief names the config file the consumer actually has", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  function consumerOn(layout: "directory" | "monolith" | "none"): string {
    const root = mkdtempSync(join(tmpdir(), "rg-2621-brief-"));
    made.push(root);
    const config = JSON.stringify({ project: "c" }) + "\n";
    if (layout === "directory") {
      mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
      writeFileSync(join(root, ".claude", "rungate", "config.json"), config);
    } else if (layout === "monolith") {
      mkdirSync(join(root, ".claude"), { recursive: true });
      writeFileSync(join(root, ".claude", "rungate.json"), config);
    }
    return root;
  }

  async function briefsFor(root: string): Promise<Record<string, string>> {
    const { generateAgentBriefs } = await import("../lib/generators/agent-briefs");
    const { mockProjectScan } = await import("../lib/generators/types");
    return generateAgentBriefs(mockProjectScan({ name: "c", root, harnessTemplatesDir: TEMPLATES_DIR }));
  }

  /** Every line of a brief that sends its agent to the config file. */
  const configLines = (brief: string) => brief.split("\n").filter(l => ANY_CONFIG_PATH_RE.test(l));

  test("a monolith consumer's briefs name .claude/rungate.json, and never the directory it does not have", async () => {
    const briefs = await briefsFor(consumerOn("monolith"));
    expect(briefs.aditi).toContain("Read `.claude/rungate.json` and check the `pages` field");
    expect(briefs.discovery).toContain("Check .claude/rungate.json `pages` field");
    const quinnFallbacks = briefs.quinn.split("\n").filter(l => l.includes("not configured"));
    expect(quinnFallbacks.length).toBeGreaterThanOrEqual(2);
    for (const l of quinnFallbacks) expect(l).toContain(".claude/rungate.json");
    for (const [name, brief] of Object.entries(briefs)) {
      expect(brief, `${name} names the directory layout to a monolith consumer`).not.toContain(".claude/rungate/config.json");
    }
  });

  test("a directory-layout consumer, or one with no config yet, is told .claude/rungate/config.json", async () => {
    for (const layout of ["directory", "none"] as const) {
      const briefs = await briefsFor(consumerOn(layout));
      expect(briefs.aditi, layout).toContain("Read `.claude/rungate/config.json` and check the `pages` field");
      const lines = Object.values(briefs).flatMap(configLines);
      expect(lines.length, layout).toBeGreaterThanOrEqual(4);
      for (const l of lines) expect(l, layout).not.toMatch(MONOLITH_RE);
    }
  });

  test("no brief keeps an unfilled ${CONFIG_FILE}", async () => {
    for (const layout of ["directory", "monolith", "none"] as const) {
      for (const [name, brief] of Object.entries(await briefsFor(consumerOn(layout)))) {
        expect(brief, `${layout} ${name}`).not.toContain("${CONFIG_FILE}");
      }
    }
  });
});
