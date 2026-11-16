/**
 * #2259 — the verify gate reads `adversary-report.json` against
 * `AdversaryReportSchema`, and an unreadable or malformed report is a FAIL.
 *
 * Covers SC-2770 (GATE-CONTRACTS-SPEC.md).
 *
 * The report is raw output from the model B1 spawns. It was read with a regex
 * and `JSON.parse` and never checked, so `"gameable": "2"` with no exploits,
 * or a report whose `exploits` was not a list, produced no FAIL and no WARN —
 * the same reading as a clean report. And a report with no JSON at all only
 * printed a warning, so the gate passed on a report it never read.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { adversaryReportReading } from "../gates/gate-executor";
import { AdversaryReportSchema } from "../gates/schema";

const ACS = [
  { id: "AC-1", type: "OUTCOME" },
  { id: "AC-2", type: "CODE" },
];

const exploit = (acId: string) => ({ acId, exploit: `${acId} passes on an empty file`, recommendation: "assert the content" });

describe("#2259: a report that meets the contract is read as before", () => {
  test("a clean report adds nothing", () => {
    const r = adversaryReportReading(JSON.stringify({ gameable: 0, approved: true, exploits: [] }), ACS);
    expect(r).toEqual({ fails: 0, warns: 0, results: [] });
  });

  test("a gameable OUTCOME criterion FAILs and a gameable CODE criterion WARNs", () => {
    const raw = `model preamble ${JSON.stringify({ gameable: 2, approved: false, exploits: [exploit("AC-1"), exploit("AC-2")] })}`;
    const r = adversaryReportReading(raw, ACS);
    expect(r.fails).toBe(1);
    expect(r.warns).toBe(1);
    expect(r.results.map(x => `${x.result} ${x.check}`)).toEqual([
      "FAIL B1-adversary: AC-1 gameable (OUTCOME)",
      "WARN B1-adversary: AC-2 gameable",
    ]);
  });
});

describe("#2259 / SC-2770: a report the contract refuses is a FAIL naming the field", () => {
  const refused: Array<[string, Record<string, unknown>, string]> = [
    ["exploits that is not a list", { gameable: 1, approved: false, exploits: "none" }, "exploits"],
    // Read as `"2" > 0` and then a loop over nothing: no FAIL and no WARN for a
    // report that says two criteria are gameable.
    ["gameable as a string", { gameable: "2", approved: true, exploits: [] }, "gameable"],
    ["no approved field", { gameable: 0, exploits: [] }, "approved"],
    ["an exploit with no acId", { gameable: 1, approved: false, exploits: [{ exploit: "x", recommendation: "y" }] }, "exploits.0.acId"],
  ];
  for (const [name, report, field] of refused) {
    test(`${name} is refused, naming ${field}`, () => {
      const r = adversaryReportReading(JSON.stringify(report), ACS);
      expect(r.fails).toBe(1);
      expect(r.results).toHaveLength(1);
      expect(r.results[0].result).toBe("FAIL");
      expect(r.results[0].check).toBe("B1-adversary: report fails AdversaryReportSchema");
      expect(r.results[0].detail).toContain(field);
    });
  }

  test("THE MUTATION: a schema requiring one field more than the report carries refuses it", () => {
    const valid = JSON.stringify({ gameable: 0, approved: true, exploits: [] });
    const stricter = AdversaryReportSchema.extend({ reviewedBy: z.string() });
    const r = adversaryReportReading(valid, ACS, stricter);
    expect(r.fails).toBe(1);
    expect(r.results[0].detail).toContain("reviewedBy");
  });
});

describe("#2259 review round 1: the counts must agree with the exploits listed", () => {
  test("gameable 3 with no exploits is a FAIL naming both counts — not a clean report", () => {
    const r = adversaryReportReading(JSON.stringify({ gameable: 3, approved: false, exploits: [] }), ACS);
    expect(r.fails).toBe(1);
    expect(r.results[0].check).toBe("B1-adversary: report contradicts itself");
    expect(r.results[0].detail).toContain("gameable 3");
    expect(r.results[0].detail).toContain("0 exploit(s)");
  });

  test("gameable 0 with an exploit listed still reports the exploit — nothing listed is dropped", () => {
    const r = adversaryReportReading(JSON.stringify({ gameable: 0, approved: true, exploits: [exploit("AC-1")] }), ACS);
    expect(r.results.map(x => `${x.result} ${x.check}`)).toEqual(["FAIL B1-adversary: AC-1 gameable (OUTCOME)"]);
  });

  test("more exploits than gameable is read, not refused — two ways to game one criterion", () => {
    const r = adversaryReportReading(JSON.stringify({ gameable: 1, approved: false, exploits: [exploit("AC-2"), exploit("AC-2")] }), ACS);
    expect(r.fails).toBe(0);
    expect(r.warns).toBe(2);
  });
});

describe("#2259: a report that cannot be read is a FAIL, never a pass", () => {
  test("no JSON at all", () => {
    const r = adversaryReportReading("the model timed out before answering", ACS);
    expect(r.fails).toBe(1);
    expect(r.results[0].check).toBe("B1-adversary: report unreadable");
  });

  test("JSON that does not parse", () => {
    const r = adversaryReportReading('{"gameable": 1, "approved": false, }', ACS);
    expect(r.fails).toBe(1);
    expect(r.results[0].check).toBe("B1-adversary: report unreadable");
  });
});
