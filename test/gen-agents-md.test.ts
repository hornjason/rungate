/**
 * Generator unit test: agents-md
 * AC-4: Tests generators with mock ProjectScan data
 */
import { test, expect, describe } from "bun:test";
import { generateAgentsMd, generateScopedRules } from "../lib/generators/agents-md";
import { mockProjectScan, type ProjectScan } from "../lib/generators/types";
import { isRuleIncluded } from "../lib/scaffold/profiles";
import { commentClaimForm, titleCall } from "../lib/sc-claim-forms";
import { scanProject } from "../lib/scanner";
import {
  adjudicateFiling,
  COMMENT_EXEMPTIONS,
  declaredExemption,
  filingAttempts,
  measuredCorpus,
  namedClaim,
} from "../lib/issue-filing-gate";
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

/**
 * #2375: a consumer gets the claim convention `sync-sc-status` enforces.
 *
 * Measured in one consumer on 2026-11-17: a dry run would have ticked six
 * criteria because build tests named the criterion they work toward in a
 * `describe` title, and the consumer had no rule saying a title is a claim.
 *
 * The examples in the rule are RUN through the two predicates that decide,
 * so the rule cannot promise a form the scanner does not honour, or call a
 * form safe that the scanner credits.
 */
describe("#2375: claiming-sc-coverage, the claim convention a consumer writes tests by", () => {
  const ruleFor = (profile: "full" | "minimal") =>
    generateScopedRules(mockProjectScan({ name: "consumer" }))
      .filter(r => isRuleIncluded(r.filename, profile))
      .find(r => r.filename === "claiming-sc-coverage.md");

  test("#2375: emitted into both profiles", () => {
    expect(ruleFor("full"), "scaffold does not emit claiming-sc-coverage.md").toBeDefined();
    expect(ruleFor("minimal"), "a minimal consumer runs sync-sc-status too").toBeDefined();
  });

  /** Backticked examples in the table under a heading line, up to the next blank-line-then-prose. */
  function examples(body: string, heading: string): string[] {
    const at = body.indexOf(heading);
    expect(at, `the rule lost its "${heading}" table`).toBeGreaterThan(-1);
    const rest = body.slice(at + heading.length);
    const table = rest.slice(0, rest.search(/\n\n(?!\|)/) === -1 ? undefined : rest.search(/\n\n(?!\|)/) + 1);
    return [...table.matchAll(/^\|[^|\n]*\|\s*`([^`]+)`\s*\|$/gm)].map(m => m[1]);
  }

  /** What the scanner makes of one example: a claim, a citation, or no id at all. */
  function reading(example: string): "claim" | "not-a-claim" | "no-id" {
    const id = /\bSC-\d+\b/.exec(example);
    if (id === null) return "no-id";
    const title = /^(.*?\b(?:describe|test|it)\b[^("']*\()\s*["'`]/.exec(example);
    if (title !== null) return titleCall(title[1]) === "runs" ? "claim" : "not-a-claim";
    return commentClaimForm(example, id.index, id[0]) !== null ? "claim" : "not-a-claim";
  }

  test("#2375: every example under 'Counts' is a claim to the scanner", () => {
    const counts = examples(ruleFor("full")!.content, "Counts as a claim");
    expect(counts.length, "the Counts table is empty, so this case is vacuous").toBeGreaterThanOrEqual(6);
    for (const ex of counts) expect(reading(ex), `the rule says \`${ex}\` counts; the scanner disagrees`).toBe("claim");
  });

  test("#2375: every example under 'Does not count' is NOT a claim to the scanner", () => {
    const not = examples(ruleFor("full")!.content, "Does not count");
    expect(not.length, "the Does-not-count table is empty, so this case is vacuous").toBeGreaterThanOrEqual(3);
    // Review of #2377: a row with no criterion id would pass `not.toBe("claim")`
    // without either predicate running. So every row reads exactly
    // "not-a-claim", except the ONE row whose point is that the id is absent —
    // and that row is held to what it says: a title that runs, naming an issue.
    const noId = not.filter(ex => reading(ex) === "no-id");
    expect(noId.length, `rows with no criterion id: ${noId.join(" · ")}`).toBe(1);
    const title = /^(.*?\b(?:describe|test|it)\b[^("']*\()\s*["'`]/.exec(noId[0]);
    expect(title && titleCall(title[1]), "the issue-number row is not a running title").toBe("runs");
    expect(noId[0], "the issue-number row names no issue").toMatch(/#\d+/);
    for (const ex of not.filter(e => e !== noId[0])) {
      expect(reading(ex), `the rule says \`${ex}\` is safe; the scanner credits it`).toBe("not-a-claim");
    }
  });

  test("#2375: it tells a test that only works toward a criterion what to write instead", () => {
    const body = ruleFor("full")!.content;
    expect(body).toContain("works toward");
    expect(body).toContain("issue number");
    expect(body).toContain("sync-sc-status");
  });

  test("#2375 CONTROL: the reader can tell the two apart", () => {
    // Or both tables could hold the same kind of example and the two cases
    // above would pass on an empty distinction.
    expect(reading("// covers SC-9012")).toBe("claim");
    expect(reading("// part of the work toward SC-9012")).toBe("not-a-claim");
    expect(reading('describe("SC-9012: x", () => {})')).toBe("claim");
    expect(reading('test.todo("SC-9012: x")')).toBe("not-a-claim");
  });
});

/**
 * #2318: a consumer's agent learns the filing gate from the rule, before the
 * gate refuses it.
 *
 * Measured in one consumer on 2026-11-17: the rule's command, run as written,
 * was answered `COMMENT_INSTEAD` until the body carried a `Cannot be a
 * comment:` line the rule never mentioned, and nothing installed named the
 * `Claim <N>` declaration either. So the rule's own command and example body
 * are RUN through the gate's adjudicator here, with no placeholder left that
 * the gate would read as an answer.
 */
describe("#2318: the rule's command passes the filing gate as written", () => {
  const rule = () =>
    generateScopedRules(mockProjectScan({ name: "consumer" })).find(r => r.filename === "reporting-upstream.md")!.content;

  /** The one fenced block of a language, refused when there is not exactly one. */
  function fenced(body: string, lang: string): string {
    const blocks = [...body.matchAll(new RegExp("^```" + lang + "\\n([\\s\\S]*?)^```$", "gm"))].map(m => m[1]);
    expect(blocks.length, `the rule carries ${blocks.length} \`\`\`${lang} blocks, and this reads exactly one`).toBe(1);
    return blocks[0];
  }

  /**
   * The example body with its placeholders filled the way a reporter would:
   * the symptom names a file, because the rule says to, and every other
   * placeholder gets prose that names nothing.
   */
  const filledBody = (symptom = "`lib/generators/agents-md.ts` writes a path that does not exist, 3 of 3 runs") =>
    fenced(rule(), "markdown")
      .replace(/<N>/g, "1")
      .replace(/<the symptom[^>\n]*>/, symptom)
      .replace(/<[^>\n]+>/g, "measured twice, same result");

  test("#2318 AC-2: the example body declares a claim and a reason the gate reads", () => {
    const body = filledBody();
    expect(namedClaim(body, { kind: "claims", numbers: [1] }), "the example names no claim the gate reads").toBe(1);
    expect(declaredExemption(body), "the example declares no reason the gate reads").not.toBeNull();
  });

  test("#2318 AC-2: the command and the example body together are ALLOWED by the gate", async () => {
    const cmd = fenced(rule(), "bash")
      .replace(/\\\n\s*/g, "")
      .replace(/"<[^"]*>"/g, '"the generated rule names a path that does not exist"')
      .replace(/<a file you wrote FIRST[^>]*>/, "/tmp/body.md");
    const attempts = filingAttempts(cmd);
    expect(attempts.length, `the rule's command is not one gh issue create: ${cmd}`).toBe(1);
    const v = await adjudicateFiling(attempts[0], async () => measuredCorpus([]), () => filledBody(), undefined, {
      kind: "claims",
      numbers: [1],
    });
    expect(v.refusal, `the gate refused the rule's own example: ${v.reason}`).toBeNull();
    expect(v.outcome).toBe("ALLOW");
  });

  test("#2318 AC-2 CONTROL: without the declarations the same filing is refused", async () => {
    const bare = filledBody()
      .split("\n")
      .filter(l => !/^(Claim|Cannot be a comment)/.test(l))
      .join("\n");
    const [attempt] = filingAttempts('gh issue create --repo hornjason/rungate --title "x" --body-file /tmp/body.md');
    const v = await adjudicateFiling(attempt, async () => measuredCorpus([]), () => bare, undefined, {
      kind: "claims",
      numbers: [1],
    });
    expect(v.refusal, "the control was allowed, so the case above witnesses nothing").not.toBeNull();
  });

  /**
   * Review of #2424: the first wording said a COMMAND satisfies the gate, and
   * the gate keys only on repository paths and shaped identifiers. So each
   * thing the rule says is not enough is run, and refused.
   */
  test("#2318 AC-2 CONTROL: a symptom naming only a command, or nothing, is refused, as the rule warns", async () => {
    const [attempt] = filingAttempts('gh issue create --repo hornjason/rungate --title "x" --body-file /tmp/body.md');
    for (const symptom of ["the generated rule is wrong", "`bunx rungate scaffold .` skips the gates job, 2 of 2 runs"]) {
      const v = await adjudicateFiling(attempt, async () => measuredCorpus([]), () => filledBody(symptom), undefined, {
        kind: "claims",
        numbers: [1],
      });
      expect(v.refusal, `"${symptom}" was allowed, so the rule's warning describes no refusal`).not.toBeNull();
    }
    expect(rule(), "the rule no longer warns that a body must name a path or a function").toContain(
      "names no repository path and no function",
    );
    expect(rule(), "the rule no longer says a command alone is not enough").toContain("A command alone");
  });

  test("#2318 AC-2: a symptom naming a function in backticks is allowed, as the rule says", async () => {
    const [attempt] = filingAttempts('gh issue create --repo hornjason/rungate --title "x" --body-file /tmp/body.md');
    const v = await adjudicateFiling(
      attempt,
      async () => measuredCorpus([]),
      () => filledBody("`generateScopedRules` writes a path that does not exist, 3 of 3 runs"),
      undefined,
      { kind: "claims", numbers: [1] },
    );
    expect(v.refusal, `a function name was refused: ${v.reason}`).toBeNull();
  });

  test("#2318 AC-3: every reason the gate accepts is named, and the claim is this project's own", () => {
    const body = rule();
    for (const token of Object.keys(COMMENT_EXEMPTIONS)) {
      // Named AND glossed (review of #2424): a token with no meaning beside
      // it leaves a consumer guessing which one applies.
      expect(body, `the rule does not name and explain \`${token}\`, which the gate accepts`).toMatch(
        new RegExp("`" + token + "`: \\S"),
      );
    }
    expect(body, "the rule does not say the claim comes from this project's SUCCESS.md (#2317)").toContain(
      "this project's `SUCCESS.md`",
    );
  });

  test("#2318 AC-1: a consumer's AGENTS.md, which always loads, names the rule; rungate's own does not", () => {
    const consumer = generateAgentsMd(mockProjectScan({ name: "consumer" }));
    expect(consumer, "a consumer agent that never opens package.json cannot learn the rule exists").toContain(
      ".claude/rules/reporting-upstream.md",
    );
    const harness = generateAgentsMd(scanProject(join(import.meta.dir, "..")));
    expect(harness, "rungate has no upstream, so its own AGENTS.md should not point at one").not.toContain(
      ".claude/rules/reporting-upstream.md",
    );
  });
});
