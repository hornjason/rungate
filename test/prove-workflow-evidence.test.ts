/**
 * #2254 — `workflows/prove.js` writes `prove-evidence.json` against the one
 * contract, `ProveEvidenceSchema`.
 *
 * Covers SC-2770 (GATE-CONTRACTS-SPEC.md).
 *
 * #1559 made B3's writer meet the contract. `workflows/prove.js` was the third
 * writer: it handed an agent a JSON literal to save with the Write tool,
 * carrying the dead JSON schema's `contractVersion` and none of
 * `beforeEvidence`, `afterEvidence` or `comparisonSummary`, and nothing
 * checked it. Now prove.js builds a report (the PROVE-REPORT block, extracted
 * and executed below) and `scripts/record-prove-evidence.ts` builds, checks
 * and writes the artifact through `recordProveEvidence`, the function B3 uses.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { z } from "zod";
import { AFTER_OBSERVERS, validateArtifactSchema } from "../gates/gate-executor";
import { ProveEvidenceSchema } from "../gates/schema";

const ROOT = resolve(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "record-prove-evidence.ts");
const PROVE_JS = join(ROOT, "workflows", "prove.js");
const PROVE_SOURCE = readFileSync(PROVE_JS, "utf-8");

const scratch = mkdtempSync(join(tmpdir(), "prove-workflow-evidence-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A block of prove.js between its markers, executed. The sandbox gives prove.js no imports (#69). */
function proveBlock<T>(name: string, returns: string): T {
  const START = `// ──── ${name}-START ────`;
  const END = `// ──── ${name}-END ────`;
  expect(PROVE_SOURCE.split(START).length - 1, `${START} must appear exactly once`).toBe(1);
  expect(PROVE_SOURCE.split(END).length - 1, `${END} must appear exactly once`).toBe(1);
  const start = PROVE_SOURCE.indexOf(START);
  const end = PROVE_SOURCE.indexOf(END);
  expect(end, `${END} must follow ${START}`).toBeGreaterThan(start);
  return new Function(`${PROVE_SOURCE.slice(start, end)}\nreturn ${returns};`)() as T;
}

type LatestAfter = { evidence: unknown; observer: string };
const { proveReport, settleVerdict, foldQuinnAfterEvidence } = proveBlock<{
  proveReport: (a: Record<string, unknown>) => Record<string, unknown>;
  settleVerdict: (run: string, recorded: unknown) => string;
  foldQuinnAfterEvidence: (latest: LatestAfter, reply: unknown) => LatestAfter;
}>("PROVE-REPORT", "{ proveReport, settleVerdict, foldQuinnAfterEvidence }");

const COMMIT = "c".repeat(40);
const AFTER = {
  type: "api",
  path: null,
  capturedAt: "2026-11-16T01:00:00.000Z",
  environment: "local",
  description: "GET /health returned 200 with the field present",
};
const PASS_ROW = { scId: "SC-1", verdict: "PASS", evidence: "bun test exited 0" };

const report = (over: Record<string, unknown> = {}) => proveReport({
  issue: 2254, commitSHA: COMMIT, verdict: "PROVEN",
  criteriaResults: [PASS_ROW], reproduced: true, afterEvidence: AFTER,
  ...over,
});

function run(
  script: string,
  reportBody: unknown,
  opts: { state?: string; extra?: string[]; trusted?: string[]; source?: string | null } = {},
) {
  const dir = mkdtempSync(join(scratch, "run-"));
  const reportPath = join(dir, "prove-report.json");
  writeFileSync(reportPath, typeof reportBody === "string" ? reportBody : JSON.stringify(reportBody));
  if (opts.state !== undefined) writeFileSync(join(dir, "workflow-state.json"), opts.state);
  const p = Bun.spawnSync(
    [
      "bun", script, "--work-dir", dir, "--report", reportPath,
      ...(opts.source === null ? [] : ["--source", opts.source ?? "prove-workflow"]),
      // What prove.js holds in-process, passed beside the agent-written report.
      ...(opts.trusted ?? ["--issue", "2254", "--commit", COMMIT]),
      ...(opts.extra ?? []),
    ],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const lastLine = p.stdout.toString().trim().split("\n").pop() ?? "";
  let printed: any = null;
  try {
    printed = JSON.parse(lastLine);
  } catch {
    printed = { unparseable: lastLine };
  }
  const artifactPath = join(dir, "prove-evidence.json");
  return {
    code: p.exitCode,
    printed,
    stderr: p.stderr.toString(),
    artifact: existsSync(artifactPath) ? JSON.parse(readFileSync(artifactPath, "utf-8")) : null,
  };
}

describe("#2254: a report built the way prove.js builds it", () => {
  test("SC-2770: is written, and the file on disk meets the contract", () => {
    const r = run(SCRIPT, report());
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.printed).toEqual({ written: true, verdict: "PROVEN" });
    expect(validateArtifactSchema(r.artifact, ProveEvidenceSchema)).toEqual([]);
    expect(r.artifact.source).toBe("prove-workflow");
    expect(r.artifact.commitSHA).toBe(COMMIT);
    expect(r.artifact.afterEvidence).toEqual({ ...AFTER, observedBy: "reproducer" });
    // The dead JSON schema's field, which nothing reads.
    expect("contractVersion" in r.artifact).toBe(false);
  });

  test("THE MUTATION: a schema with one required field more than the artifact carries turns it red", () => {
    const r = run(SCRIPT, report());
    const stricter = ProveEvidenceSchema.extend({ reviewedBy: z.string() });
    expect(validateArtifactSchema(r.artifact, stricter).join("\n")).toContain("reviewedBy");
  });

  test("an absent after-evidence leaves the key out, and the record says INCONCLUSIVE and why", () => {
    const built = report({ afterEvidence: undefined });
    expect("afterEvidence" in built).toBe(false);
    const r = run(SCRIPT, built);
    expect(r.code).toBe(0);
    expect(r.printed.verdict).toBe("INCONCLUSIVE");
    expect(r.printed.reason).toContain("no after-evidence");
    expect(r.artifact.afterEvidence.type).toBe("none");
  });

  test("all SKIP is INCONCLUSIVE — prove.js's computeVerdict calls it PROVEN, the contract does not", () => {
    const r = run(SCRIPT, report({ criteriaResults: [{ scId: "SC-1", verdict: "SKIP", evidence: "no browser" }] }));
    expect(r.code).toBe(0);
    expect(r.printed.verdict).toBe("INCONCLUSIVE");
    expect(r.printed.reason).toContain("no criterion verified");
  });

  test("reproduced is a boolean the report states, never a truthy string", () => {
    expect(report({ reproduced: "yes" }).reproduced).toBe(false);
    expect(report({ reproduced: true }).reproduced).toBe(true);
  });
});

describe("#2254: the relayed record may only make prove.js's verdict stricter", () => {
  // The record step's reply comes back through an agent, and the workflow
  // sandbox cannot read the artifact to check it. Flagged by the commit
  // security review: a misreported reply must not turn a verdict into PROVEN.
  const cases: Array<[string, unknown, string]> = [
    ["INCONCLUSIVE", { written: true, verdict: "PROVEN" }, "INCONCLUSIVE"],
    ["UNPROVEN", { written: true, verdict: "PROVEN" }, "UNPROVEN"],
    ["UNPROVEN", { written: false, reason: "x" }, "UNPROVEN"],
    ["PROVEN", { written: true, verdict: "INCONCLUSIVE" }, "INCONCLUSIVE"],
    ["PROVEN", { written: true, verdict: "UNPROVEN" }, "UNPROVEN"],
    ["PROVEN", { written: false, reason: "refused" }, "INCONCLUSIVE"],
    ["PROVEN", null, "INCONCLUSIVE"],
    ["PROVEN", { written: true, verdict: "PASSED" }, "INCONCLUSIVE"],
    ["PROVEN", { written: "true", verdict: "PROVEN" }, "INCONCLUSIVE"],
    ["PROVEN", { written: true, verdict: "PROVEN" }, "PROVEN"],
  ];
  for (const [run, recorded, want] of cases) {
    test(`${run} with ${JSON.stringify(recorded)} settles ${want}`, () => {
      expect(settleVerdict(run, recorded)).toBe(want);
    });
  }
});

describe("#2254: the before-state comes from the run's own workflow-state.json", () => {
  test("a captured before-state is CAPTURED in the artifact", () => {
    const state = JSON.stringify({
      beforeState: { type: "api", capturedAt: "2026-11-15T00:00:00.000Z", description: "GET /x returned 500" },
    });
    const r = run(SCRIPT, report(), { state });
    expect(r.code).toBe(0);
    expect(r.artifact.beforeEvidence.status).toBe("CAPTURED");
  });

  test("no workflow-state.json is UNMEASURED, and says so in the artifact", () => {
    const r = run(SCRIPT, report());
    expect(r.artifact.beforeEvidence.status).toBe("UNMEASURED");
  });
});

describe("#2254: refusals — nothing is written, and the reason is printed", () => {
  const refusals: Array<[string, unknown, { state?: string; extra?: string[]; trusted?: string[] }, string]> = [
    // Review round 3 on PR #2256: the report is transcribed by an agent; the
    // issue and commit prove.js already holds are passed beside it, and a
    // report that disagrees is not trusted for anything else either.
    ["a report whose commit differs from the run's", report(), { trusted: ["--issue", "2254", "--commit", "d".repeat(40)] }, "commitSHA"],
    ["a report whose issue differs from the run's", report(), { trusted: ["--issue", "9999", "--commit", COMMIT] }, "issueNumber"],
    ["a run that does not pass its own issue and commit", report(), { trusted: [] }, "--issue"],
    ["a criteria row with no evidence", report({ criteriaResults: [{ scId: "SC-1", verdict: "PASS" }] }), {}, "criteriaResults.0.evidence"],
    ["a workflow-state.json present and unreadable", report(), { state: "{not json" }, "workflow-state.json"],
    ["a report that is not JSON", "{nope", {}, "report"],
    ["a report with no issue number", { ...report(), issueNumber: "2254" }, {}, "issueNumber"],
    ["a report with no commit", { ...report(), commitSHA: "" }, {}, "commitSHA"],
    ["an argument the script does not know", report(), { extra: ["--write-anyway"] }, "--write-anyway"],
  ];

  for (const [name, body, opts, named] of refusals) {
    test(`${name} is refused, naming ${named}`, () => {
      const r = run(SCRIPT, body, opts);
      expect(r.code).not.toBe(0);
      expect(r.printed.written).toBe(false);
      expect(r.printed.reason).toContain(named);
      expect(r.artifact).toBeNull();
    });
  }
});

describe("#2254: the refusal is the exit code, and the exit code can be removed", () => {
  const source = readFileSync(SCRIPT, "utf-8");
  const DECLARATION = /^export const EXIT_REFUSED = [1-9]\d*;$/m;

  test("one exported constant carries every refusal, and no literal exit bypasses it", () => {
    expect(source.match(new RegExp(DECLARATION.source, "gm"))?.length ?? 0).toBe(1);
    expect(source.match(/process\.exit\(\s*[1-9]/g) ?? []).toEqual([]);
  });

  test("with the constant set to 0, a refused row exits 0 — the refusal was the constant", () => {
    const absolutised = source
      .replace(DECLARATION, "export const EXIT_REFUSED = 0;")
      .replace(/from (['"])(\.[^'"]*)\1/g, (_m, q: string, rel: string) => `from ${q}${resolve(join(ROOT, "scripts"), rel)}${q}`);
    const survivors = [...absolutised.matchAll(/from ['"](\.[^'"]*)['"]/g)].map((m) => m[1]);
    expect(survivors, "relative imports survived the rewrite, so the mutant would die on resolution").toEqual([]);
    expect(absolutised).toContain("export const EXIT_REFUSED = 0;");
    const mutantDir = mkdtempSync(join(scratch, "mutant-"));
    const mutant = join(mutantDir, "record-prove-evidence.mutant.ts");
    writeFileSync(mutant, absolutised);

    const body = report({ criteriaResults: [{ scId: "SC-1", verdict: "PASS" }] });
    const real = run(SCRIPT, body);
    const mutated = run(mutant, body);
    expect(real.code).not.toBe(0);
    expect(mutated.code).toBe(0);
    // Same refusal on both, so the mutant reached the same decision.
    expect(mutated.printed.written).toBe(false);
    expect(mutated.printed.reason).toBe(real.printed.reason);
  });
});

describe("#2254: prove.js asks for what the contract needs, and no longer writes the artifact by hand", () => {
  const schemas = proveBlock<{ REPRODUCER_SCHEMA: any; QUINN_SCHEMA: any }>(
    "PROVE-SCHEMAS", "{ REPRODUCER_SCHEMA, QUINN_SCHEMA }",
  );

  test("the reproducer schema carries afterEvidence, with the environments the contract admits", () => {
    const after = schemas.REPRODUCER_SCHEMA.properties.afterEvidence;
    expect(after.properties.environment.enum).toEqual(["local", "prod"]);
    expect(after.properties.type.enum).toEqual(["text", "api", "data"]);
    expect(after.required).toEqual(expect.arrayContaining(["type", "capturedAt", "environment", "description"]));
  });

  test("every criteria row a reproducer or Quinn reports must carry its evidence", () => {
    expect(schemas.REPRODUCER_SCHEMA.properties.criteriaResults.items.required).toContain("evidence");
    expect(schemas.QUINN_SCHEMA.properties.criteriaResults.items.required).toContain("evidence");
  });

  test("every reproducer spawn is told to read the prompt that defines afterEvidence", () => {
    // Review round 1 on PR #2256: the self-heal re-validation is a separate
    // agent with no context from the first spawn, and was told to report
    // afterEvidence "as the prompt specifies" without being told to read it.
    // Split on each spawn rather than one regex over the file: a label like
    // `self-heal-validate-${selfHealIteration}` puts a `}` inside the options.
    const spawns = PROVE_SOURCE.split("agent(`").slice(1).map((chunk) => {
      const close = chunk.indexOf("`, {");
      return { prompt: chunk.slice(0, close), opts: chunk.slice(close, chunk.indexOf("})", close)) };
    }).filter((s) => s.opts.includes("schema: REPRODUCER_SCHEMA"));
    // Both are named, so a spawn that stops matching is red, not silently skipped.
    expect(spawns.map((s) => /label: [`']([a-z0-9-]+)/.exec(s.opts)?.[1])).toEqual(["b3-reproducer", "self-heal-validate-"]);
    for (const { prompt, opts } of spawns) {
      expect(prompt, `the spawn with ${opts.trim()}`).toContain("Read ${PROVE_PROMPT}");
    }
  });

  test("the artifact is written by the script, never by an agent's Write tool", () => {
    expect(PROVE_SOURCE).toContain("scripts/record-prove-evidence.ts");
    // The run's own issue and commit go beside the report, never only inside it.
    expect(PROVE_SOURCE).toContain("--issue ${shellQuote(String(ISSUE))} --commit ${shellQuote(COMMIT_SHA)}");
    // The key, not the word: the comment explaining its removal may name it.
    expect(PROVE_SOURCE).not.toMatch(/contractVersion\s*:/);
    // Review round 3 on PR #2256: a second, unused statement of the artifact's
    // shape is a contract someone may edit instead of gates/schema.ts.
    expect(PROVE_SOURCE).not.toMatch(/PROVE_EVIDENCE_SCHEMA\s*=/);
    expect(PROVE_SOURCE).not.toMatch(/Write this JSON to \$\{WORK_DIR\}\/prove-evidence\.json/);
  });
});

// ── #2262: Quinn's after-evidence, and the field table ──────────────────────

// A real file: a screenshot is evidence only when the file it names exists (review round 1, PR #2266).
const SHOT = join(scratch, "SC-1-banner-visible.png");
writeFileSync(SHOT, "\x89PNG fixture");
const QUINN_AFTER = {
  type: "screenshot",
  path: SHOT,
  capturedAt: "2026-11-16T02:00:00.000Z",
  environment: "prod",
  description: "the prove container's dashboard shows the restored banner for a new user",
};
const QUINN_ROW = { scId: "SC-1", verdict: "PASS", evidence: "browser_verify_text_visible('Welcome back') passed" };
const quinnReport = (over: Record<string, unknown> = {}) => report({ criteriaResults: [QUINN_ROW], afterEvidence: QUINN_AFTER, ...over });
const AS_QUINN = { extra: ["--after-observer", "quinn"] };

describe("#2262: Quinn's after-evidence reaches the record, attributed to Quinn", () => {
  test("SC-2770: a UI-only run Quinn proved with a prod screenshot records PROVEN, the screenshot, and Quinn", () => {
    const r = run(SCRIPT, quinnReport(), AS_QUINN);
    expect(r.stderr).toBe("");
    expect(r.printed).toEqual({ written: true, verdict: "PROVEN" });
    expect(r.artifact.afterEvidence).toEqual({ ...QUINN_AFTER, observedBy: "quinn" });
    expect(validateArtifactSchema(r.artifact, ProveEvidenceSchema)).toEqual([]);
  });

  test("the reproducer still cannot report a screenshot — no browser, so it is not after-evidence", () => {
    const r = run(SCRIPT, quinnReport());
    expect(r.code).toBe(0);
    expect(r.printed.verdict).toBe("INCONCLUSIVE");
    expect(r.printed.reason).toContain("screenshot");
    expect(r.artifact.afterEvidence.type).toBe("none");
  });

  test("an agent writing observedBy: quinn into its own after-evidence is not believed", () => {
    const r = run(SCRIPT, quinnReport({ afterEvidence: { ...QUINN_AFTER, observedBy: "quinn" } }));
    expect(r.printed.verdict).toBe("INCONCLUSIVE");
    expect(r.artifact.afterEvidence.type).toBe("none");
  });

  test("a screenshot with no file is not evidence, from Quinn either", () => {
    const r = run(SCRIPT, quinnReport({ afterEvidence: { ...QUINN_AFTER, path: null } }), AS_QUINN);
    expect(r.printed.verdict).toBe("INCONCLUSIVE");
    expect(r.printed.reason).toContain("afterEvidence.path");
  });

  test("review round 1: a screenshot naming a file that was never written is not evidence", () => {
    const r = run(SCRIPT, quinnReport({ afterEvidence: { ...QUINN_AFTER, path: join(scratch, "never-taken.png") } }), AS_QUINN);
    expect(r.printed.verdict).toBe("INCONCLUSIVE");
    expect(r.printed.reason).toContain("is not a file");
    // A directory is not a screenshot either.
    const d = run(SCRIPT, quinnReport({ afterEvidence: { ...QUINN_AFTER, path: scratch } }), AS_QUINN);
    expect(d.printed.reason).toContain("is not a file");
  });

  describe("the fold prove.js runs on Quinn's reply, executed", () => {
    const fromB3: LatestAfter = { evidence: AFTER, observer: "reproducer" };
    test("Quinn's after-evidence replaces the reproducer's, and the observer travels with it", () => {
      expect(foldQuinnAfterEvidence(fromB3, { verdict: "PASS", afterEvidence: QUINN_AFTER }))
        .toEqual({ evidence: QUINN_AFTER, observer: "quinn" });
    });
    test("a Quinn reply with none keeps the reproducer's, still attributed to the reproducer", () => {
      expect(foldQuinnAfterEvidence(fromB3, { verdict: "PASS" })).toEqual(fromB3);
      expect(foldQuinnAfterEvidence(fromB3, null)).toEqual(fromB3);
    });
  });

  describe("prove.js is wired to it", () => {
    const schemas = proveBlock<{ REPRODUCER_SCHEMA: any; QUINN_SCHEMA: any }>(
      "PROVE-SCHEMAS", "{ REPRODUCER_SCHEMA, QUINN_SCHEMA }",
    );
    test("each spawn's schema asks for exactly the types its observer may report — one list, three statements", () => {
      expect(schemas.REPRODUCER_SCHEMA.properties.afterEvidence.properties.type.enum).toEqual([...AFTER_OBSERVERS.reproducer]);
      expect(schemas.QUINN_SCHEMA.properties.afterEvidence.properties.type.enum).toEqual([...AFTER_OBSERVERS.quinn]);
      const observedBy = (ProveEvidenceSchema.shape.afterEvidence.shape as any).observedBy.unwrap().options;
      expect(observedBy).toEqual(Object.keys(AFTER_OBSERVERS));
    });
    test("Quinn's reply is folded, the self-heal re-validation resets to the reproducer, and the record names the observer", () => {
      expect(PROVE_SOURCE).toContain("latestAfter = foldQuinnAfterEvidence(latestAfter, quinnResults)");
      expect(PROVE_SOURCE).toContain("latestAfter = { evidence: revalidateResult.afterEvidence, observer: 'reproducer' }");
      expect(PROVE_SOURCE).toContain("--after-observer ${shellQuote(latestAfter.observer)}");
      expect(PROVE_SOURCE).toContain("afterEvidence: latestAfter.evidence");
    });
  });
});

/**
 * #2262: every field of the written artifact, where it comes from, and what
 * happens when the report leaves it out, gets it wrong, or disagrees with what
 * the run knows. PR #2256's review rounds found these one field per round; the
 * table asks the question for every field at once. A cell is a case run
 * through the script, or the reason no such case exists.
 *
 * beforeEvidence is one row: B3 builds it whole from workflow-state.json
 * (#1540), so nothing a report says reaches its fields.
 */
type Run = ReturnType<typeof run>;
type Cell = string | { body?: (base: Record<string, any>) => unknown; opts?: Parameters<typeof run>[2]; then: (r: Run) => void };
type Row = { source: string; absent: Cell; malformed: Cell; disagreeing: Cell };

const without = (o: Record<string, any>, k: string) => { const { [k]: _gone, ...rest } = o; return rest; };
const withAfter = (a: Record<string, any>) => (b: Record<string, any>) => ({ ...b, afterEvidence: a });
const refused = (named: string) => (r: Run) => {
  expect(r.code).not.toBe(0);
  expect(r.printed.written).toBe(false);
  expect(r.printed.reason).toContain(named);
  expect(r.artifact).toBeNull();
};
const noAfter = (named: string) => (r: Run) => {
  expect(r.code).toBe(0);
  expect(r.artifact.afterEvidence.type).toBe("none");
  expect(r.artifact.afterEvidence.description).toContain(named);
  expect(r.printed.verdict).toBe("INCONCLUSIVE");
};
const recorded = (check: (a: Record<string, any>) => void) => (r: Run) => {
  expect(r.code).toBe(0);
  check(r.artifact);
};
const BUILT = "nothing reports it — the builder writes it from its own decision";
const NOT_WRITTEN = "this writer never writes it; the schema leaves it optional for other writers";
const OBSERVED_ONLY = "only the observer saw it — nothing else in the run states one to compare";

const FIELDS: Record<string, Row> = {
  issueNumber: {
    source: "the run's --issue, checked against the report",
    absent: { body: (b) => without(b, "issueNumber"), then: refused("issueNumber") },
    malformed: { body: (b) => ({ ...b, issueNumber: "2254" }), then: refused("issueNumber") },
    disagreeing: { opts: { trusted: ["--issue", "9999", "--commit", COMMIT] }, then: refused("issueNumber") },
  },
  commitSHA: {
    source: "the run's --commit, checked against the report",
    absent: { body: (b) => without(b, "commitSHA"), then: refused("commitSHA") },
    malformed: { body: (b) => ({ ...b, commitSHA: "" }), then: refused("commitSHA") },
    disagreeing: { opts: { trusted: ["--issue", "2254", "--commit", "d".repeat(40)] }, then: refused("commitSHA") },
  },
  verdict: {
    source: "the report, made only stricter by the builder",
    absent: { body: (b) => without(b, "verdict"), then: (r) => { expect(r.printed.verdict).toBe("INCONCLUSIVE"); expect(r.printed.reason).toContain("is not one of"); } },
    malformed: { body: (b) => ({ ...b, verdict: "PASSED" }), then: (r) => { expect(r.printed.verdict).toBe("INCONCLUSIVE"); expect(r.printed.reason).toContain("is not one of"); } },
    disagreeing: { body: (b) => ({ ...b, criteriaResults: [{ scId: "SC-1", verdict: "SKIP", evidence: "no browser" }] }), then: (r) => { expect(r.printed.verdict).toBe("INCONCLUSIVE"); expect(r.printed.reason).toContain("no criterion verified"); } },
  },
  verdictDowngrade: {
    source: "the builder, present only when it changed the reported verdict",
    absent: { then: recorded((a) => expect("verdictDowngrade" in a).toBe(false)) },
    malformed: BUILT,
    disagreeing: { body: (b) => ({ ...b, verdictDowngrade: { reported: "X", reason: "planted" } }), then: recorded((a) => expect("verdictDowngrade" in a).toBe(false)) },
  },
  capturedAt: {
    source: "the builder's clock",
    absent: BUILT,
    malformed: BUILT,
    disagreeing: { body: (b) => ({ ...b, capturedAt: "1999-01-01T00:00:00.000Z" }), then: recorded((a) => expect(a.capturedAt).not.toBe("1999-01-01T00:00:00.000Z")) },
  },
  beforeEvidence: {
    source: "the run's own workflow-state.json, never the report",
    absent: { then: recorded((a) => expect(a.beforeEvidence.status).toBe("UNMEASURED")) },
    malformed: { opts: { state: "{not json" }, then: refused("workflow-state.json") },
    disagreeing: { body: (b) => ({ ...b, beforeEvidence: { status: "CAPTURED" } }), then: recorded((a) => expect(a.beforeEvidence.status).toBe("UNMEASURED")) },
  },
  afterEvidence: {
    source: "the report, as seen by the observer --after-observer names",
    absent: { body: (b) => without(b, "afterEvidence"), then: noAfter("reported no afterEvidence") },
    malformed: { body: (b) => ({ ...b, afterEvidence: "it looked fine" }), then: noAfter("not an object") },
    disagreeing: { body: withAfter(QUINN_AFTER), then: noAfter("screenshot") },
  },
  "afterEvidence.type": {
    source: "the report, limited to the types its observer can see",
    absent: { body: withAfter(without(AFTER, "type")), then: noAfter("afterEvidence.type") },
    malformed: { body: withAfter({ ...AFTER, type: "video" }), then: noAfter("afterEvidence.type") },
    disagreeing: { body: withAfter(QUINN_AFTER), opts: { extra: ["--after-observer", "reproducer"] }, then: noAfter("reproducer") },
  },
  "afterEvidence.path": {
    source: "the report; required for a screenshot, optional otherwise",
    absent: { body: withAfter(without(QUINN_AFTER, "path")), opts: AS_QUINN, then: noAfter("afterEvidence.path") },
    malformed: { body: withAfter({ ...AFTER, path: 42 }), then: recorded((a) => expect(a.afterEvidence.path).toBeNull()) },
    disagreeing: { body: withAfter({ ...QUINN_AFTER, path: join(scratch, "never-taken.png") }), opts: AS_QUINN, then: noAfter("is not a file") },
  },
  "afterEvidence.capturedAt": {
    source: "the report",
    absent: { body: withAfter(without(AFTER, "capturedAt")), then: noAfter("afterEvidence.capturedAt") },
    malformed: { body: withAfter({ ...AFTER, capturedAt: 0 }), then: noAfter("afterEvidence.capturedAt") },
    disagreeing: OBSERVED_ONLY,
  },
  "afterEvidence.environment": {
    source: "the report; whether STANDARD+ needs prod is gates/prove.test.ts's check",
    absent: { body: withAfter(without(AFTER, "environment")), then: noAfter("afterEvidence.environment") },
    malformed: { body: withAfter({ ...AFTER, environment: "staging" }), then: noAfter("afterEvidence.environment") },
    disagreeing: OBSERVED_ONLY,
  },
  "afterEvidence.description": {
    source: "the report",
    absent: { body: withAfter(without(AFTER, "description")), then: noAfter("afterEvidence.description") },
    malformed: { body: withAfter({ ...AFTER, description: "   " }), then: noAfter("afterEvidence.description") },
    disagreeing: OBSERVED_ONLY,
  },
  "afterEvidence.observedBy": {
    source: "--after-observer, never the report",
    absent: { then: recorded((a) => expect(a.afterEvidence.observedBy).toBe("reproducer")) },
    malformed: { opts: { extra: ["--after-observer", "rook"] }, then: refused("--after-observer") },
    disagreeing: { body: withAfter({ ...AFTER, observedBy: "quinn" }), then: recorded((a) => expect(a.afterEvidence.observedBy).toBe("reproducer")) },
  },
  comparisonSummary: {
    source: "the builder, from the before-state reading and the criteria counts",
    absent: BUILT,
    malformed: BUILT,
    disagreeing: { body: (b) => ({ ...b, comparisonSummary: "all good" }), then: recorded((a) => { expect(a.comparisonSummary).not.toBe("all good"); expect(a.comparisonSummary).toContain("1/1 criteria passed"); }) },
  },
  reproduced: {
    source: "the report — the first reproducer spawn's, see proveReport's call",
    absent: { body: (b) => without(b, "reproduced"), then: recorded((a) => expect(a.reproduced).toBe(false)) },
    malformed: { body: (b) => ({ ...b, reproduced: "yes" }), then: recorded((a) => expect(a.reproduced).toBe(false)) },
    disagreeing: "only the first spawn looks at the before-state, so nothing else in the run answers it",
  },
  criteriaResults: {
    source: "the report — Quinn's rows have replaced the reproducer's SKIPs before it is built",
    absent: { body: (b) => without(b, "criteriaResults"), then: (r) => { expect(r.artifact.criteriaResults).toEqual([]); expect(r.printed.reason).toContain("no criterion verified"); } },
    malformed: { body: (b) => ({ ...b, criteriaResults: [{ scId: "SC-1", verdict: "PASS" }] }), then: refused("criteriaResults.0.evidence") },
    disagreeing: "the rows are the observers' own verdicts; nothing else in the run states a verdict per criterion",
  },
  evidence: {
    source: "the report, kept only as a list",
    absent: { then: recorded((a) => expect(a.evidence).toEqual([])) },
    malformed: { body: (b) => ({ ...b, evidence: "see logs" }), then: recorded((a) => expect(a.evidence).toEqual([])) },
    disagreeing: "free-form supporting evidence; nothing else in the run states any to compare",
  },
  source: {
    source: "--source, never the report",
    absent: { opts: { source: null }, then: recorded((a) => expect(a.source).toBe("prove-workflow")) },
    malformed: { opts: { source: null, extra: ["--source"] }, then: refused("--source needs a value") },
    disagreeing: { body: (b) => ({ ...b, source: "B3-prove-reproducer" }), then: recorded((a) => expect(a.source).toBe("prove-workflow")) },
  },
  quinnVerdict: {
    source: "not this writer's",
    absent: NOT_WRITTEN,
    malformed: NOT_WRITTEN,
    disagreeing: { body: (b) => ({ ...b, quinnVerdict: "PASS" }), then: recorded((a) => expect("quinnVerdict" in a).toBe(false)) },
  },
  gaps: {
    source: "not this writer's",
    absent: NOT_WRITTEN,
    malformed: NOT_WRITTEN,
    disagreeing: { body: (b) => ({ ...b, gaps: [{ ac: "SC-1", status: "open", detail: "planted" }] }), then: recorded((a) => expect("gaps" in a).toBe(false)) },
  },
};

describe("#2262: every field of prove-evidence.json — its source, and what happens when it is absent, malformed or disagrees", () => {
  test("a row for every key the artifact carries and every key the contract names; a field added without a row is red", () => {
    // Downgraded and observed by Quinn, so the optional keys are present too.
    const full = run(SCRIPT, quinnReport({ criteriaResults: [{ scId: "SC-1", verdict: "SKIP", evidence: "no browser" }] }), AS_QUINN).artifact;
    const keys = new Set<string>([
      ...Object.keys(full),
      ...Object.keys(full.afterEvidence).map((k) => `afterEvidence.${k}`),
      ...Object.keys(ProveEvidenceSchema.shape),
      ...Object.keys(ProveEvidenceSchema.shape.afterEvidence.shape).map((k) => `afterEvidence.${k}`),
    ]);
    expect("verdictDowngrade" in full && "observedBy" in full.afterEvidence).toBe(true);
    expect(Object.keys(FIELDS).sort()).toEqual([...keys].sort());
  });

  for (const [field, row] of Object.entries(FIELDS)) {
    for (const kind of ["absent", "malformed", "disagreeing"] as const) {
      const cell = row[kind];
      if (typeof cell === "string") {
        test(`${field} ${kind}: no such case — ${cell}`, () => expect(cell.length).toBeGreaterThan(20));
        continue;
      }
      test(`${field} ${kind} (${row.source})`, () => {
        const base = report() as Record<string, any>;
        cell.then(run(SCRIPT, cell.body ? cell.body(base) : base, cell.opts));
      });
    }
  }
});
