/**
 * #1559, Jason's option (a) of 2026-11-15 — `prove-evidence.json` meets its
 * one contract.
 *
 * Covers SC-2770 (GATE-CONTRACTS-SPEC.md).
 *
 * B3 wrote an artifact that failed BOTH declared contracts: it lacked the
 * dead JSON schema's `contractVersion`, and the zod `ProveEvidenceSchema`'s
 * `beforeEvidence`, `afterEvidence` and `comparisonSummary`. Nothing read
 * either one at write time. Option (a): the zod schema is the contract, the
 * reproducer reports the environment it tested and what it saw, B3 writes
 * that as `afterEvidence`, and a PROVEN with no after-evidence is downgraded
 * to INCONCLUSIVE rather than written with an invented environment.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  buildProveEvidence,
  readBeforeState,
  validateArtifactSchema,
} from "../gates/gate-executor";
import { ProveEvidenceSchema } from "../gates/schema";

const CTX = {
  issueNumber: 1559,
  commitSHA: "a".repeat(40),
  capturedAt: "2026-11-15T20:00:00.000Z",
  beforeReading: readBeforeState({}),
};

const AFTER = {
  type: "api",
  path: null,
  capturedAt: "2026-11-15T19:59:00.000Z",
  environment: "local",
  description: "GET /health returned 200 with the new field present",
};

const report = (over: Record<string, unknown> = {}) => ({
  verdict: "PROVEN",
  // The reproducer's own vocabulary (gates/prompts/prove-reproducer.md), and
  // prove.test.ts's: one row per criterion, PASS or FAIL.
  criteriaResults: [{ scId: "SC-1", verdict: "PASS", evidence: "bun test exited 0" }],
  reproduced: true,
  afterEvidence: AFTER,
  ...over,
});

describe("#1559: B3 builds prove-evidence.json from the reproducer's own report", () => {
  test("SC-2770: a report with after-evidence builds an artifact the zod contract accepts", () => {
    const built = buildProveEvidence(report(), CTX);
    expect(built.verdict).toBe("PROVEN");
    expect(built.afterEvidence).toEqual(AFTER);
    expect(ProveEvidenceSchema.safeParse(built).success).toBe(true);
    expect(validateArtifactSchema(built, ProveEvidenceSchema)).toEqual([]);
  });

  test("the before-evidence and comparison come from B3's own reading, not from the reproducer", () => {
    const built = buildProveEvidence(report({ beforeEvidence: { status: "CAPTURED" } }), CTX);
    expect(built.beforeEvidence).toEqual({ status: "UNMEASURED", reason: expect.any(String) });
    expect(built.comparisonSummary).toContain("1/1 criteria passed");
  });

  test("the comparison counts PASS rows only", () => {
    const built = buildProveEvidence(report({
      verdict: "UNPROVEN",
      criteriaResults: [
        { scId: "SC-1", verdict: "PASS", evidence: "ok" },
        { scId: "SC-2", verdict: "FAIL", evidence: "still broken" },
      ],
    }), CTX);
    expect(built.comparisonSummary).toContain("1/2 criteria passed");
  });

  test("PROVEN with no after-evidence is downgraded to INCONCLUSIVE, and says why", () => {
    const built = buildProveEvidence(report({ afterEvidence: undefined }), CTX);
    expect(built.verdict).toBe("INCONCLUSIVE");
    expect(built.verdictDowngrade).toEqual({ reported: "PROVEN", reason: expect.stringContaining("no after-evidence") });
    expect(built.afterEvidence.type).toBe("none");
    expect(built.afterEvidence.description).toContain("no after-evidence");
    // Still a valid artifact: the downgrade is a reading, not a crash.
    expect(validateArtifactSchema(built, ProveEvidenceSchema)).toEqual([]);
  });

  test("an environment other than local or prod is no after-evidence, and the record never claims prod", () => {
    // The schema requires an environment even on a `none` record. `local` is
    // the one value that satisfies no STANDARD+ prod requirement
    // (gates/prove.test.ts), so a missing after-evidence fails closed.
    for (const environment of ["staging", "", undefined, 3, "PROD"]) {
      const built = buildProveEvidence(report({ afterEvidence: { ...AFTER, environment } }), CTX);
      expect(built.verdict, `environment ${JSON.stringify(environment)}`).toBe("INCONCLUSIVE");
      expect(built.afterEvidence.type).toBe("none");
      expect(built.afterEvidence.environment).toBe("local");
    }
  });

  test("a reported prod environment is written through as prod", () => {
    const built = buildProveEvidence(report({ afterEvidence: { ...AFTER, environment: "prod" } }), CTX);
    expect(built.verdict).toBe("PROVEN");
    expect(built.afterEvidence.environment).toBe("prod");
  });

  test("after-evidence missing its type, time or description is no after-evidence", () => {
    for (const broken of [{ type: "video" }, { type: "none" }, { capturedAt: 7 }, { description: "" }]) {
      const built = buildProveEvidence(report({ afterEvidence: { ...AFTER, ...broken } }), CTX);
      expect(built.verdict, JSON.stringify(broken)).toBe("INCONCLUSIVE");
    }
  });

  test("UNPROVEN and INCONCLUSIVE are kept as the reproducer reported them", () => {
    const unproven = buildProveEvidence(report({ verdict: "UNPROVEN", afterEvidence: undefined }), CTX);
    expect(unproven.verdict).toBe("UNPROVEN");
    expect(unproven.verdictDowngrade).toBeUndefined();
    expect(buildProveEvidence(report({ verdict: "INCONCLUSIVE" }), CTX).verdict).toBe("INCONCLUSIVE");
  });

  test("a verdict outside the enum is INCONCLUSIVE, never written through", () => {
    const built = buildProveEvidence(report({ verdict: "PASSED" }), CTX);
    expect(built.verdict).toBe("INCONCLUSIVE");
    expect(built.verdictDowngrade?.reported).toBe("PASSED");
    expect(validateArtifactSchema(built, ProveEvidenceSchema)).toEqual([]);
  });
});

describe("#1559 / SC-2770: validateArtifactSchema refuses a required field the writer does not emit", () => {
  test("a missing required field is named", () => {
    const built = buildProveEvidence(report(), CTX) as Record<string, unknown>;
    const { comparisonSummary: _dropped, ...withoutSummary } = built;
    const violations = validateArtifactSchema(withoutSummary, ProveEvidenceSchema);
    expect(violations.join("\n")).toContain("comparisonSummary");
  });

  test("THE MUTATION: a schema requiring one field more than the writer emits turns the reading red", () => {
    // The case SC-2770 names: add a required field to the contract and the
    // writer, unchanged, must fail it. Without this the cases above pass
    // against a validator that accepts anything.
    const stricter = ProveEvidenceSchema.extend({ reviewedBy: z.string() });
    const violations = validateArtifactSchema(buildProveEvidence(report(), CTX), stricter);
    expect(violations.join("\n")).toContain("reviewedBy");
  });
});
