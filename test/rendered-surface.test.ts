/**
 * Covers SC-2799 (RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md).
 *
 * #2600, ADR-024 decision 2: four template defects existed only in rendered
 * output, and each template read fine alone, so a lint over `templates/`
 * passes on all of them. CI therefore renders the scaffold into fixture
 * consumers — with the command a consumer runs — and the lints read what was
 * rendered. `lib/surface-lint.ts` is the one way in: it refuses a tree the
 * scaffold has not rendered, and refuses a finding about a file outside it.
 *
 * Two fixture consumers, one fixture directory: `test/fixtures/golden-project`
 * as the scaffold leaves it (directory config), and the same project carrying
 * a legacy monolith `.claude/rungate.json`, which the scaffold keeps and does
 * not rewrite. ADR-024 left the fixture set to this issue; SUCCESS.md's
 * "Done, for a consumer" names the monolith consumer as one a reader must not
 * get wrong.
 *
 * Covers SC-2800 (RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md) as well.
 *
 * #2601: every file, and every table in a file, that a rendered brief or rule
 * tells its agent to read exists in the rendered tree. #2565 is the case: the
 * discovery brief sent its agent to "the AGENTS.md Specs table", which the
 * rendered AGENTS.md does not have. Building this lint found a second one,
 * #2621 — three briefs sent a monolith consumer's agent to
 * `.claude/rungate/config.json`, a file it does not have.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { resolveConfig } from "../lib/config-loader";
import { DEFAULT_AGENT_META } from "../lib/create-brief";
import { OWNED_FILES } from "../lib/scaffold/owned-files";
import {
  NotRenderedSurface,
  SURFACE_LINTS,
  danglingReadTargets,
  lintRenderedTree,
  readRenderedSurface,
  readTargets,
  type RenderedSurface,
  type SurfaceLint,
} from "../lib/surface-lint";
import { commitFixture, initFixtureRepo } from "./helpers/git-fixture";

const ROOT = join(import.meta.dir, "..");
const FIXTURE = join(ROOT, "test", "fixtures", "golden-project");
const TEMPLATES = join(ROOT, "templates");

interface Consumer {
  name: string;
  /** Written into the copy before it is scaffolded. */
  seed?: (dest: string) => void;
  /** The config layout the rendered tree must resolve to. */
  layout: "directory" | "monolith";
}

const CONSUMERS: Consumer[] = [
  { name: "golden-project", layout: "directory" },
  {
    name: "golden-project, legacy monolith config",
    layout: "monolith",
    seed: dest => {
      mkdirSync(join(dest, ".claude"), { recursive: true });
      writeFileSync(join(dest, ".claude", "rungate.json"), JSON.stringify({ project: "golden-project" }, null, 2) + "\n");
    },
  },
];

interface Rendered {
  consumer: Consumer;
  root: string;
  exit: number | null;
  stdout: string;
  stderr: string;
}

const scratch = mkdtempSync(join(tmpdir(), "rg-2600-rendered-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * Copy the fixture, commit it, and run the consumer's command on it:
 * `rungate scaffold <dir> --fix`. No GitHub credential and an API that
 * refuses, so the render reads nothing remote.
 */
function render(consumer: Consumer, i: number): Rendered {
  const root = join(scratch, `consumer-${i}`);
  cpSync(FIXTURE, root, { recursive: true });
  consumer.seed?.(root);
  initFixtureRepo(root);
  commitFixture(root, "init fixture consumer");
  const r = spawnSync("bun", [join(ROOT, "bin", "rungate.ts"), "scaffold", root, "--fix"], {
    cwd: root,
    encoding: "utf-8",
    timeout: 120_000,
    env: { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "", GITHUB_API_URL: "http://127.0.0.1:1" },
  });
  return { consumer, root, exit: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

let rendered: Rendered[] = [];
beforeAll(() => {
  rendered = CONSUMERS.map(render);
}, 300_000);

/**
 * The markdown the scaffold run reported writing that is not a document: specs,
 * ADRs, the code map and the state files are read on demand as records; every
 * other `.md` it renders is text an agent is told to load. Decided here, NOT
 * from `SURFACE_DIRS` — a classifier built from the reader's own list would
 * agree with the reader however narrow it became.
 */
const NOT_INSTRUCTIONS = [/^specs\//, /^docs\//, /^(CODE-MAP|PROJECT-STATE|SUCCESS)\.md$/];

function reportedInstructionWrites(stdout: string): string[] {
  const out = new Set<string>();
  for (const m of stdout.matchAll(/^\s*(?:CREATED|UPDATED|REPLACED|REGENERATED|REFRESHED|GENERATED):\s+(\S+\.md)\b/gm)) {
    if (!NOT_INSTRUCTIONS.some(re => re.test(m[1]))) out.add(m[1]);
  }
  return [...out].sort();
}

const probe = (seen: RenderedSurface[]): SurfaceLint => ({
  name: "probe",
  check(surface) {
    seen.push(surface);
    return [{ file: ".claude/agents/marcus.md", message: "probe finding" }];
  },
});

describe("SC-2799: CI renders the full scaffold into fixture consumers, and lints read that rendered tree", () => {
  test("each fixture consumer renders through the consumer's own scaffold command, with every brief and command", () => {
    expect(rendered).toHaveLength(CONSUMERS.length);
    for (const r of rendered) {
      expect(r.exit, `${r.consumer.name}: scaffold exited ${r.exit}\n${r.stderr.slice(-2000)}`).toBe(0);
      expect(r.stdout, r.consumer.name).toContain("Profile: full");
      const config = resolveConfig(r.root);
      expect(config.status === "resolved" ? config.source : "absent", r.consumer.name).toBe(r.consumer.layout);

      const surface = readRenderedSurface(r.root);
      const want = [
        "CLAUDE.md",
        "AGENTS.md",
        ...Object.keys(DEFAULT_AGENT_META).map(role => `.claude/agents/${role}.md`),
        ...OWNED_FILES.map(f => f.path).filter(p => p.startsWith(".claude/commands/") && !p.includes("*")),
      ];
      const missing = want.filter(f => !surface.files.has(f));
      expect(missing, `${r.consumer.name}: the rendered surface lacks these`).toEqual([]);
      expect([...surface.files.keys()].filter(f => f.startsWith(".claude/rules/")).length, r.consumer.name).toBeGreaterThan(0);
    }
  });

  test("the surface a lint gets holds every instruction file the scaffold run reported writing", () => {
    for (const r of rendered) {
      const wrote = reportedInstructionWrites(r.stdout);
      // The two briefs, rules and commands at least — a report the regex
      // stopped matching would make the next assertion vacuous.
      expect(wrote.length, `${r.consumer.name}: ${wrote.join(", ")}`).toBeGreaterThanOrEqual(10);
      const surface = readRenderedSurface(r.root);
      expect(wrote.filter(f => !surface.files.has(f)), `${r.consumer.name}: written but not handed to the lints`).toEqual([]);
    }
  });

  test("a tree the scaffold has not rendered is refused, and no lint runs on it", () => {
    for (const unrendered of [TEMPLATES, FIXTURE]) {
      expect(() => readRenderedSurface(unrendered)).toThrow(NotRenderedSurface);
      const seen: RenderedSurface[] = [];
      expect(() => lintRenderedTree(unrendered, [probe(seen)])).toThrow(/is not a rendered consumer/);
      expect(seen, unrendered).toHaveLength(0);
    }
    expect(() => readRenderedSurface(TEMPLATES)).toThrow(/a rungate config, AGENTS\.md, \.claude\/agents\/\*\.md, \.claude\/rules\/\*\.md/);
  });

  test("every lint is handed the rendered text, never the template's", () => {
    for (const r of rendered) {
      const seen: RenderedSurface[] = [];
      const findings = lintRenderedTree(r.root, [probe(seen)]);
      expect(seen, r.consumer.name).toHaveLength(1);
      const brief = seen[0].files.get(".claude/agents/marcus.md");
      expect(brief, r.consumer.name).toBe(readFileSync(join(r.root, ".claude", "agents", "marcus.md"), "utf-8"));
      expect(brief, `${r.consumer.name}: the lint was handed the template`).not.toBe(
        readFileSync(join(TEMPLATES, "agent-briefs", "marcus.md"), "utf-8"),
      );
      expect(findings).toEqual([{ lint: "probe", file: ".claude/agents/marcus.md", message: "probe finding" }]);
    }
  });

  test("a finding about a file outside the rendered tree is refused, naming the lint", () => {
    const r = rendered[0];
    expect(existsSync(join(r.root, "templates"))).toBe(false);
    for (const file of ["templates/agent-briefs/marcus.md", "../outside.md", join(TEMPLATES, "agent-briefs", "marcus.md")]) {
      const reader: SurfaceLint = { name: "reads-the-template", check: () => [{ file, message: "x" }] };
      expect(() => lintRenderedTree(r.root, [reader]), file).toThrow(/lint reads-the-template reported on .* not in the rendered tree/);
    }
  });
});

/** A copy of a rendered consumer with `text` appended to one of its surface files. */
function plantedCopy(from: string, rel: string, text: string): string {
  const root = join(scratch, `planted-${Math.random().toString(36).slice(2)}`);
  cpSync(from, root, { recursive: true });
  writeFileSync(join(root, rel), readFileSync(join(root, rel), "utf-8") + "\n" + text + "\n");
  return root;
}

describe("SC-2800: every file, heading or table a rendered brief or rule tells its agent to read exists in the rendered tree", () => {
  test("both fixture consumers render clean, and the lint read real instructions to say so", () => {
    for (const r of rendered) {
      const targets = readTargets(readRenderedSurface(r.root));
      // The config read, the specs-routing table and the two shipped prompts at
      // least: a detector that stopped matching would make the next line vacuous.
      expect(targets.length, `${r.consumer.name}: ${targets.map(t => t.target).join(", ")}`).toBeGreaterThanOrEqual(5);
      expect(targets.some(t => t.table !== null), r.consumer.name).toBe(true);
      expect(lintRenderedTree(r.root, SURFACE_LINTS), r.consumer.name).toEqual([]);
    }
    expect(SURFACE_LINTS.map(l => l.name)).toContain("dangling-read-target");
  });

  test("#2565 again: a brief sending its agent to a table AGENTS.md does not have is a finding", () => {
    const root = plantedCopy(rendered[0].root, ".claude/agents/discovery.md", "Look up the governing spec in the AGENTS.md Specs table.");
    const findings = lintRenderedTree(root, [danglingReadTargets()]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ lint: "dangling-read-target", file: ".claude/agents/discovery.md" });
    expect(findings[0].message).toContain("Specs table in AGENTS.md");
  });

  test("a file it is told to read that is not there is a finding, backticked or bare, here or in the shipped package", () => {
    for (const line of ["Read `docs/missing-guide.md` first.", "Check docs/missing-guide.md before sizing.", "Read `node_modules/rungate/prompts/no-such-prompt.md`."]) {
      const root = plantedCopy(rendered[0].root, ".claude/agents/aditi.md", line);
      const findings = lintRenderedTree(root, [danglingReadTargets()]);
      expect(findings.map(f => f.message), line).toHaveLength(1);
      expect(findings[0].message, line).toContain("not in the rendered tree");
    }
  });

  test("a mention that is not an instruction to read, or sits in a fenced example, is not a finding", () => {
    const text = "Name a path with its directory (`lib/scaffold/emit.ts`), not its bare name.\n\n```\nRead `docs/example-only.md`\n```";
    const root = plantedCopy(rendered[0].root, ".claude/rules/agent-principles.md", text);
    expect(lintRenderedTree(root, [danglingReadTargets()])).toEqual([]);
  });
});
