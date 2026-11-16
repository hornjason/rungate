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
import { validateArtifactSchema } from "../gates/gate-executor";
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

const { proveReport, settleVerdict } = proveBlock<{
  proveReport: (a: Record<string, unknown>) => Record<string, unknown>;
  settleVerdict: (run: string, recorded: unknown) => string;
}>("PROVE-REPORT", "{ proveReport, settleVerdict }");

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
  opts: { state?: string; extra?: string[] } = {},
) {
  const dir = mkdtempSync(join(scratch, "run-"));
  const reportPath = join(dir, "prove-report.json");
  writeFileSync(reportPath, typeof reportBody === "string" ? reportBody : JSON.stringify(reportBody));
  if (opts.state !== undefined) writeFileSync(join(dir, "workflow-state.json"), opts.state);
  const p = Bun.spawnSync(
    ["bun", script, "--work-dir", dir, "--report", reportPath, "--source", "prove-workflow", ...(opts.extra ?? [])],
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
    expect(r.artifact.afterEvidence).toEqual(AFTER);
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
  const refusals: Array<[string, unknown, { state?: string; extra?: string[] }, string]> = [
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

  test("the artifact is written by the script, never by an agent's Write tool", () => {
    expect(PROVE_SOURCE).toContain("scripts/record-prove-evidence.ts");
    // The key, not the word: the comment explaining its removal may name it.
    expect(PROVE_SOURCE).not.toMatch(/contractVersion\s*:/);
    expect(PROVE_SOURCE).not.toMatch(/Write this JSON to \$\{WORK_DIR\}\/prove-evidence\.json/);
  });
});
