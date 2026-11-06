/**
 * Generator unit test: agents-md
 * AC-4: Tests generators with mock ProjectScan data
 */
import { test, expect, describe } from "bun:test";
import { generateAgentsMd, generateScopedRules } from "../lib/generators/agents-md";
import { mockProjectScan, type ProjectScan } from "../lib/generators/types";
import { isRuleIncluded } from "../lib/scaffold/profiles";
import { scanProject } from "../lib/scanner";
import { join } from "path";

describe("generateAgentsMd with mock ProjectScan", () => {
  test("returns string containing project name and identity", () => {
    const scan = mockProjectScan({
      name: "alpha-project",
      identity: "Alpha project for testing generators",
      techStack: ["Bun", "TypeScript"],
      repoUrl: "https://github.com/test/alpha",
    });
    const result = generateAgentsMd(scan);
    expect(typeof result).toBe("string");
    expect(result).toContain("alpha-project");
    expect(result).toContain("Alpha project for testing generators");
  });

  test("includes tech stack in output", () => {
    const scan = mockProjectScan({
      name: "beta",
      techStack: ["Node.js", "ESM", "React"],
    });
    const result = generateAgentsMd(scan);
    expect(result).toContain("**Tech:** Node.js, ESM, React");
  });

  test("includes key files table rows in scoped rules", () => {
    const scan = mockProjectScan({
      name: "gamma",
      keyFiles: [
        { file: "AGENTS.md", what: "Entry point", when: "Always" },
        { file: "Makefile", what: "Build commands", when: "Deploying" },
      ],
    });
    const rules = generateScopedRules(scan);
    const keyFilesRule = rules.find(r => r.filename === "key-files.md");
    expect(keyFilesRule).toBeDefined();
    expect(keyFilesRule!.content).toContain("| AGENTS.md | Entry point | Always |");
    expect(keyFilesRule!.content).toContain("| Makefile | Build commands | Deploying |");
  });

  test("includes specs table in scoped rules", () => {
    const scan = mockProjectScan({
      name: "delta",
      specs: [
        { file: "AUTH-SPEC.md", governs: "Authentication flow", testable: "yes" },
      ],
    });
    const rules = generateScopedRules(scan);
    const specsRule = rules.find(r => r.filename === "specs-routing.md");
    expect(specsRule).toBeDefined();
    expect(specsRule!.content).toContain("| AUTH-SPEC.md | Authentication flow | yes |");
  });

  test("includes repo URL", () => {
    const scan = mockProjectScan({
      name: "epsilon",
      repoUrl: "https://github.com/org/epsilon",
    });
    const result = generateAgentsMd(scan);
    expect(result).toContain("https://github.com/org/epsilon");
  });

  test("includes doc routing entries in scoped rules", () => {
    const scan = mockProjectScan({
      name: "zeta",
      docRouting: [
        { need: "API reference", file: "docs/api.md" },
      ],
    });
    const rules = generateScopedRules(scan);
    const docsRule = rules.find(r => r.filename === "docs-routing.md");
    expect(docsRule).toBeDefined();
    expect(docsRule!.content).toContain("API reference");
  });

  test("includes consumers section when present", () => {
    const scan = mockProjectScan({
      name: "eta",
      consumers: ["project-a", "project-b"],
    });
    const result = generateAgentsMd(scan);
    expect(result).toContain("Consumers (2)");
    expect(result).toContain("project-a");
  });

  test("omits consumers section when empty", () => {
    const scan = mockProjectScan({
      name: "theta",
      consumers: [],
    });
    const result = generateAgentsMd(scan);
    expect(result).not.toContain("Consumers");
  });

  test("includes test command in output", () => {
    const scan = mockProjectScan({
      name: "iota",
      testCmd: "npm test",
    });
    const result = generateAgentsMd(scan);
    expect(result).toContain("npm test");
  });
});

/**
 * #1742 — the scaffolded rule that tells a consumer where an upstream problem
 * goes.
 *
 * Three properties, and each is here because nothing else in the tree can see
 * it go wrong. The budget is deliberately NOT one of them:
 * `test/instruction-surface-budget.test.ts` already decides whether the
 * surface fits, and a second assertion over that same reading would be two
 * deciders agreeing — a mutation of either would leave the other holding
 * every case up (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
describe("#1742: reporting-upstream, the rule a consumer files from", () => {
  const ruleFor = (profile: "full" | "minimal") =>
    generateScopedRules(mockProjectScan({ name: "consumer" }))
      .filter(r => isRuleIncluded(r.filename, profile))
      .find(r => r.filename === "reporting-upstream.md");

  /**
   * A minimal consumer is if anything the LIKELIEST to find something and
   * have nowhere to put it, so `RULES_NOT_MINIMAL` must not acquire this
   * filename. That map is hand-maintained and adding a line to it is the
   * cheapest way to shave the minimal profile — this is the case that makes
   * it cost something.
   */
  test("#1742 / AC-1: emitted into the minimal profile, not only full", () => {
    expect(ruleFor("full")).toBeDefined();
    expect(
      ruleFor("minimal"),
      "reporting-upstream.md is excluded from the minimal profile — remove it " +
        "from RULES_NOT_MINIMAL in lib/scaffold/profiles.ts. A minimal consumer " +
        "still has an upstream to report to (#1742).",
    ).toBeDefined();
  });

  /**
   * The label is the decision, and it is the half most likely to be lost to a
   * tidy-up. `external-audit` means *rungate audited something else* — the
   * opposite direction — and fifteen open issues already carry it because
   * consumers reached for the nearest available label. A rule that permits it
   * re-creates the exact state #1742 was filed about, with every suite green.
   */
  test("#1742 / AC-2: names `from-consumer`, and rules `external-audit` out by name", () => {
    const body = ruleFor("full")!.content;
    expect(body).toContain("--label from-consumer");
    expect(
      body.includes("external-audit"),
      "the rule no longer mentions `external-audit`. Naming the wrong label and " +
        "saying why is the point — a consumer who cannot see it ruled out picks " +
        "it, which is what #1742 measured.",
    ).toBe(true);
  });

  /**
   * `--repo hornjason/rungate`, spelled out. A consumer running
   * `gh issue create` with no `--repo` files against THEIR OWN repository,
   * which is where the report is invisible to the people who can act on it —
   * and the command would still look right in review.
   */
  test("#1742 / AC-3: the filing command targets the upstream repository explicitly", () => {
    const body = ruleFor("full")!.content;
    expect(body).toContain("gh issue create --repo hornjason/rungate");
  });

  /**
   * Raised by the AI review of #1813: the rule told the reporter to quote
   * "the `rungate` entry in your `package.json`", and this repository's own
   * `package.json` is `"name": "rungate"` with a top-level `version` — no
   * such entry. Nor has a workspace-linked consumer one: its entry is a
   * path.
   *
   * The review's suggested fix was an `isHarnessItself(scan.root)` branch,
   * and that is the half-fix. It catches rungate's own repo and NOT the
   * linked consumer named in the same paragraph, so it would close one of
   * the two cases while reading as if it closed both — the shape #1810 spent
   * three rounds on. The rule enumerates all three layouts in prose instead.
   *
   * So the property is that there IS no branch: scan the real harness root
   * and a consumer mock, and the rule's bytes must agree. A future
   * `isHarnessItself` branch in this rule makes them differ and this goes
   * red naming it — which is the only thing standing between the next agent
   * and the half-fix.
   */
  test("#1742 / AC-4: no harness-vs-consumer branch — one body, every layout named", () => {
    const harness = generateScopedRules(scanProject(join(import.meta.dir, "..")))
      .find(r => r.filename === "reporting-upstream.md")!;
    const consumer = ruleFor("full")!;

    expect(
      harness.content,
      "the reporting-upstream rule now differs between the harness and a consumer. " +
        "An isHarnessItself branch here closes rungate's own repo and NOT a " +
        "workspace-linked consumer, which is half the population the AI review of " +
        "#1813 named. Name every layout in the prose instead.",
    ).toBe(consumer.content);

    // All three layouts, and the honest answer when none of them resolves.
    for (const layout of ["dependencies", "link:", "this project IS rungate", "UNMEASURED"]) {
      expect(harness.content, `the rule stopped naming the \`${layout}\` case`).toContain(layout);
    }
  });
});
