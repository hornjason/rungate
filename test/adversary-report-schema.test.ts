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
import { readFileSync } from "fs";
import { join } from "path";
import { adversaryReportReading, liveAdversaryReading } from "../gates/gate-executor";
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

describe("#2259 review round 1: the live B1 re-run at verify is read the same way", () => {
  // It spelled its own regex and JSON.parse, so a reply with no JSON returned
  // agentResult null and added nothing, and `"gameable": "2"` with no
  // exploits read as clean. Still advisory: every finding is a WARN.
  const TS = "2026-11-16T03:00:00.000Z";

  test("a reply with no JSON is a WARN, and the recorded result says UNMEASURED and why", () => {
    const r = liveAdversaryReading("claude: request timed out", TS);
    expect(r.warns).toBe(1);
    expect(r.results[0]).toEqual({ check: "B1-adversary-verify: report unreadable", result: "WARN", detail: expect.any(String) });
    expect(r.agentResult.status).toBe("UNMEASURED");
    expect(String(r.agentResult.reason)).toContain("report unreadable");
  });

  test("the named bug, gameable as a string, is refused by the schema, not read as clean", () => {
    const r = liveAdversaryReading(JSON.stringify({ gameable: "2", approved: true, exploits: [] }), TS);
    expect(r.results[0].check).toBe("B1-adversary-verify: report fails AdversaryReportSchema");
    expect(r.results[0].detail).toContain("gameable");
    expect(r.agentResult.status).toBe("UNMEASURED");
  });

  test("a count the exploits do not explain is a WARN naming both", () => {
    const r = liveAdversaryReading(JSON.stringify({ gameable: 2, approved: false, exploits: [] }), TS);
    expect(r.results[0].check).toBe("B1-adversary-verify: report contradicts itself");
  });

  test("a valid reply records the report, and each exploit is a WARN", () => {
    const r = liveAdversaryReading(JSON.stringify({ gameable: 1, approved: false, exploits: [exploit("AC-1")] }), TS);
    expect(r.warns).toBe(1);
    expect(r.results.map(x => x.check)).toEqual(["B1-adversary-verify: AC-1 gameable"]);
    expect(r.agentResult).toMatchObject({ ts: TS, gameable: 1, approved: false, source: "B1-adversary-verify-agent" });
    expect(r.agentResult.status).toBeUndefined();
  });

  test("a clean reply records approval and adds nothing", () => {
    const r = liveAdversaryReading(JSON.stringify({ gameable: 0, approved: true, exploits: [] }), TS);
    expect(r.warns).toBe(0);
    expect(r.results).toEqual([]);
    expect(r.agentResult.approved).toBe(true);
  });
});

describe("#2259: one read of the adversary report, not two", () => {
  test("gates/gate-executor.ts extracts the report's JSON in exactly one place", () => {
    // The shape review round 1 found: the on-disk read was fixed and a second
    // copy of the same regex kept swallowing. Asserted across the file, so a
    // third reader cannot reappear beside parseAdversaryReport.
    const source = readFileSync(join(import.meta.dir, "..", "gates", "gate-executor.ts"), "utf-8");
    expect(source.split('"gameable"[').length - 1).toBe(1);
  });
});

describe("#2259 review round 3: the scope spawn writes what the reader reads", () => {
  // spawnB1AdversaryAtScope ran `claude -p --output-format json`, which wraps
  // the model's answer in the CLI's envelope with the report as an escaped
  // string in `result`. The old reader could never read that file and only
  // warned, so the scope-time adversary was dead; with this issue's FAIL on an
  // unreadable report, every clean run would have failed verify instead.
  test("every model call in the gate executor prints bare text, which is what every reader extracts JSON from", () => {
    const source = readFileSync(join(import.meta.dir, "..", "gates", "gate-executor.ts"), "utf-8");
    const calls = [...source.matchAll(/claude -p[^`]*?--output-format (\w+)/g)].map(m => m[1]);
    expect(calls.length, "the model calls this case reads").toBeGreaterThanOrEqual(4);
    expect(calls.filter(f => f !== "text"), "a model call prints a format no reader parses").toEqual([]);
  });

  test("the CLI's JSON envelope is refused as unreadable, never passed", () => {
    const envelope = JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      result: JSON.stringify({ gameable: 0, approved: true, exploits: [] }),
      session_id: "s",
    });
    const r = adversaryReportReading(envelope, ACS);
    expect(r.fails).toBe(1);
    expect(r.results[0].result).toBe("FAIL");
  });
});
