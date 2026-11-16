/**
 * #2265 — the B2 evidence validator's reply is read once, and a reply nobody
 * could read says so.
 *
 * `runB2EvidenceValidatorAgent` (gates/gate-executor.ts) read the validator's
 * reply with a regex and `JSON.parse`. When there was no JSON, or it did not
 * parse, it printed a console warning and added nothing: no gate result and
 * no recorded reading. At verify, a B2 run whose reply nobody read looked
 * exactly like one that found every criterion's evidence sound. A `verdicts`
 * that was not a list, or rows with no `acId` or `verdict`, went the same way.
 *
 * PR #2264 (#2259) closed this shape for B1. Its round-4 review asked for a
 * sweep of every model reply in the file, and B2 was the one left. B2 stays
 * advisory: every reading here is a WARN.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { b2ReplyReading, parseB2Reply } from "../gates/gate-executor";

const TS = "2026-11-16T03:00:00.000Z";
const row = (acId: string, verdict: string, rawOutput = "ok") => ({ acId, command: "echo 1", rawOutput, threshold: { op: ">=", value: "1" }, actual: "1", verdict });
const reply = (body: unknown) => `Here is the result:\n${JSON.stringify(body)}\n`;

describe("#2265: a readable reply is read as before", () => {
  test("one WARN per FAIL verdict, naming the criterion, and the verdicts are recorded", () => {
    const r = b2ReplyReading(reply({ verdicts: [row("SC-1", "PASS"), row("SC-2", "FAIL", "0 matches")] }), TS);
    expect(r.results).toEqual([{ check: "B2-validator: SC-2 evidence gap", result: "WARN", detail: "0 matches" }]);
    expect(r.warns).toBe(1);
    expect(r.agentResult).toMatchObject({ ts: TS, source: "B2-evidence-validator-agent" });
    expect((r.agentResult.verdicts as unknown[]).length).toBe(2);
    expect("status" in r.agentResult).toBe(false);
  });

  test("all PASS adds no result and records the verdicts", () => {
    const r = b2ReplyReading(reply({ verdicts: [row("SC-1", "PASS")] }), TS);
    expect(r.results).toEqual([]);
    expect(r.warns).toBe(0);
    expect(Array.isArray(r.agentResult.verdicts)).toBe(true);
  });
});

describe("#2265: an unreadable reply is a WARN naming why, and an UNMEASURED reading — never nothing", () => {
  const unreadable: Array<[string, string, string]> = [
    ["no JSON at all", "I checked every criterion and they all look fine.", "no JSON object"],
    ["JSON that does not parse", '{"verdicts": [ {"acId": "SC-1", } ]}', "does not parse"],
    ["verdicts that is not a list", reply({ verdicts: "all good" }), "not a list"],
    ["verdicts that is null", reply({ verdicts: null }), "not a list"],
    ["a row with no acId", reply({ verdicts: [{ verdict: "PASS" }] }), "verdicts[0]"],
    ["a row whose verdict is neither PASS nor FAIL", reply({ verdicts: [row("SC-1", "PASS"), row("SC-2", "SKIP")] }), "verdicts[1]"],
    ["a row that is not an object", reply({ verdicts: ["SC-1 PASS"] }), "verdicts[0]"],
  ];
  for (const [name, output, named] of unreadable) {
    test(`${name}`, () => {
      const r = b2ReplyReading(output, TS);
      expect(r.results).toHaveLength(1);
      expect(r.results[0]!.check).toBe("B2-validator: reply unreadable");
      expect(r.results[0]!.result).toBe("WARN");
      expect(r.results[0]!.detail).toContain(named);
      expect(r.warns).toBe(1);
      expect(r.agentResult).toMatchObject({ ts: TS, status: "UNMEASURED", source: "B2-evidence-validator-agent" });
      expect(String(r.agentResult.reason)).toContain(named);
      // An UNMEASURED record carries no verdicts a reader could mistake for a clean run.
      expect("verdicts" in r.agentResult).toBe(false);
    });
  }

  test("parseB2Reply says not-read for each of them, and read for a good reply", () => {
    expect(parseB2Reply("nothing here").status).toBe("not-read");
    expect(parseB2Reply(reply({ verdicts: [] })).status).toBe("read");
  });
});

describe("#2265: one place reads B2's reply", () => {
  test("the reply's JSON is extracted at exactly one site in the gate executor, and the agent runner calls the reading", () => {
    const source = readFileSync(join(import.meta.dir, "..", "gates", "gate-executor.ts"), "utf-8");
    // Two copies of the extraction are two readers that can disagree; #2264's round 1 was that.
    expect(source.split('"verdicts"[').length - 1, 'regex sites naming "verdicts"').toBe(1);
    const body = source.slice(source.indexOf("function runB2EvidenceValidatorAgent("));
    const end = body.indexOf("\n}\n");
    expect(body.slice(0, end)).toContain("b2ReplyReading(");
    expect(body.slice(0, end)).not.toContain("JSON.parse(");
  });
});
