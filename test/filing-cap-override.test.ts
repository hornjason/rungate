/**
 * #2070 — the per-run filing cap as its own setting, apart from `ship.mode`.
 *
 * Before this, the only way to raise the cap was `ship.mode: "direct"`, which
 * also regenerates `ship-workflow.md` to tell agents NOT to use the harness.
 * A harness-mode consumer (asaCommandCenter) was therefore held at 1 filing
 * per run, and a real bug report was refused on 2026-11-13 (`OVER_CAP`).
 *
 * `board.filingsPerRun` is read by `filingsPerRunFor`, the one decider both
 * call sites already use. The direction it may be wrong in is the strict one:
 * an override that is present and unusable reads as the STRICT cap with the
 * unreadable note — never a raised cap, and never a throw that blocks every
 * filing on the machine.
 */
import { describe, expect, test } from "bun:test";

import {
  FILINGS_PER_RUN,
  FILINGS_PER_RUN_DIRECT,
  FILING_CAP_OVERRIDE_MAX,
  filingsPerRunFor,
  unreadableShipPolicyNote,
} from "../lib/issue-filing-gate";
import { resolveShipPolicy, shipWorkflowRule } from "../lib/ship-mode";

const DIRECT = { mode: "direct", since: "2026-10-19", reason: "stabilising" };

describe("#2070: board.filingsPerRun sets the cap whatever the ship mode", () => {
  test("a harness project with an override gets the override", () => {
    const r = filingsPerRunFor(() => ({ ship: { mode: "harness" }, board: { filingsPerRun: 5 } }));
    expect(r).toEqual({ cap: 5, unreadable: false });
  });

  test("a project with no ship block and an override gets the override", () => {
    expect(filingsPerRunFor(() => ({ board: { filingsPerRun: 4 } })).cap).toBe(4);
  });

  test("an override applies in direct mode too — it can lower the direct allowance", () => {
    expect(filingsPerRunFor(() => ({ ship: DIRECT, board: { filingsPerRun: 2 } })).cap).toBe(2);
  });

  test("CONTROL: no override is exactly the ship-mode derivation, unchanged", () => {
    expect(filingsPerRunFor(() => ({ ship: { mode: "harness" } }))).toEqual({
      cap: FILINGS_PER_RUN,
      unreadable: false,
    });
    expect(filingsPerRunFor(() => ({ ship: DIRECT }))).toEqual({
      cap: FILINGS_PER_RUN_DIRECT,
      unreadable: false,
    });
    expect(filingsPerRunFor(() => ({ ship: DIRECT, board: { queueLabel: "engine" } })).cap)
      .toBe(FILINGS_PER_RUN_DIRECT);
    expect(filingsPerRunFor(() => null)).toEqual({ cap: FILINGS_PER_RUN, unreadable: false });
  });

  // Each of these could be read as SOME number by a loose parse — `Number("12")`,
  // `Math.floor(1.5)`, a truthiness check that lets `-1` through. The strict
  // cap is asserted against direct mode, where a fall-through to the
  // ship-mode derivation would answer 12 and be visibly wrong.
  for (const bad of [0, -1, 1.5, "12", null, true, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
    test(`an unusable override ${JSON.stringify(bad)} is the STRICT cap, flagged — never a raise`, () => {
      const r = filingsPerRunFor(() => ({ ship: DIRECT, board: { filingsPerRun: bad } }));
      expect(r.cap, "an unusable override did not fall back to the strict cap").toBe(FILINGS_PER_RUN);
      expect(r.unreadable, "an unusable override was not reported").toBe(true);
    });
  }

  test("a valid override stands even when the ship block is corrupt — it does not depend on it", () => {
    // Review finding on #2075: the derivation was computed first, so a
    // ship block `resolveShipPolicy` refuses threw past the override and
    // the cap fell to the strict 1 with a note blaming the ship block.
    for (const ship of [{ mode: "dierct" }, { mode: "direct" }, "not an object"]) {
      const r = filingsPerRunFor(() => ({ ship, board: { filingsPerRun: 5 } }));
      expect(r, `ship ${JSON.stringify(ship)} discarded a valid override`).toEqual({ cap: 5, unreadable: false });
    }
    // CONTROL: with no override the corrupt ship block is still the strict
    // cap and still reported, exactly as before.
    expect(filingsPerRunFor(() => ({ ship: { mode: "dierct" } }))).toEqual({
      cap: FILINGS_PER_RUN,
      unreadable: true,
    });
  });

  test("the override is bounded like the direct-ship cap, and an over-ceiling value is refused, not clamped", () => {
    // Review finding on #2075: with no ceiling, `filingsPerRun: 999999` was a
    // valid cap and walked past the bound FG-194 holds for direct mode —
    // the #1595 swarm protection. Refused rather than clamped: a silent
    // clamp is a cap nobody chose, reported as if somebody had.
    expect(FILING_CAP_OVERRIDE_MAX, "the override ceiling is not the direct-ship allowance FG-194 bounds")
      .toBe(FILINGS_PER_RUN_DIRECT);
    expect(FILING_CAP_OVERRIDE_MAX, "the override ceiling drifted above the FG-194 bound")
      .toBeLessThanOrEqual(15);
    expect(FILING_CAP_OVERRIDE_MAX * 4, "the ceiling is no longer well below #1595's 57-per-day swarm")
      .toBeLessThan(57);
    expect(filingsPerRunFor(() => ({ board: { filingsPerRun: FILING_CAP_OVERRIDE_MAX } })).cap)
      .toBe(FILING_CAP_OVERRIDE_MAX);
    for (const over of [FILING_CAP_OVERRIDE_MAX + 1, 999999]) {
      const r = filingsPerRunFor(() => ({ ship: DIRECT, board: { filingsPerRun: over } }));
      expect(r, `${over} was accepted`).toEqual({
        cap: FILINGS_PER_RUN,
        unreadable: true,
        unreadableSource: "`board.filingsPerRun`",
      });
    }
  });

  test("a non-object board block is the strict cap, flagged", () => {
    const r = filingsPerRunFor(() => ({ ship: DIRECT, board: ["filingsPerRun", 9] }));
    expect(r).toEqual({ cap: FILINGS_PER_RUN, unreadable: true, unreadableSource: "`board.filingsPerRun`" });
  });

  test("the note names the setting that could not be read, not the ship block", () => {
    const r = filingsPerRunFor(() => ({ board: { filingsPerRun: "12" } }));
    expect(r.unreadableSource, "the reading does not say which setting was unusable")
      .toBe("`board.filingsPerRun`");
    const note = unreadableShipPolicyNote(r.cap, r.unreadableSource);
    expect(note).toContain("`board.filingsPerRun`");
    expect(note).not.toContain("`ship` block");
    // And the ship-block wording is unchanged when that is the cause.
    const ship = filingsPerRunFor(() => ({ ship: { mode: "dierct" } }));
    expect(unreadableShipPolicyNote(ship.cap, ship.unreadableSource)).toContain("`ship` block");
  });

  test("the override does not touch the generated ship-workflow rule", () => {
    const plain = shipWorkflowRule(resolveShipPolicy({ ship: { mode: "harness" } }));
    const raised = shipWorkflowRule(
      resolveShipPolicy({ ship: { mode: "harness" }, board: { filingsPerRun: 12 } }),
    );
    expect(raised).toBe(plain);
    expect(raised, "a harness project's rule stopped requiring the harness").toContain("Skill(\"ship\")");
  });
});
