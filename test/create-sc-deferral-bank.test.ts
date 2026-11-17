/**
 * create-sc moves a deferred spec's deferral bank with the criterion it
 * appends, or refuses and writes nothing.
 *
 * Found on #2293: `create-sc` took specs/SCAFFOLD-DECOMPOSITION-SPEC.md from 79
 * criteria to 80 and left `.claude/spec-deferral-ratchet.json` at 79, so
 * SC-2734's ratchet and stage item E1 went red with only a hand edit to clear
 * them. #2066 fixed the same gap in `finding-promotion`; this is the other
 * writer.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { bankAfterAppend } from "../lib/finding-promotion";

const ROOT = join(import.meta.dir, "..");
const BANK = join(ROOT, ".claude", "spec-deferral-ratchet.json");

function spec(deferred: boolean, ids: number[]): string {
  return [
    "---",
    "doc-type: spec",
    "testable: true",
    ...(deferred ? ["board-scope: deferred"] : []),
    "---",
    "",
    "# Fixture",
    "",
    "## Success Criteria",
    "",
    ...ids.map(n => `- [ ] SC-${n}: fixture criterion ${n}`),
    "",
  ].join("\n");
}

const bank = (path: string, criteria: number) =>
  `${JSON.stringify({ deferred: [{ path: "specs/OTHER.md", criteria: 3 }, { path, criteria }] }, null, 2)}\n`;

describe("bankAfterAppend: the bank after a criterion is appended", () => {
  const before = spec(true, [9001, 9002]);
  const after = spec(true, [9001, 9002, 9003]);

  test("a deferred spec's bank moves from its old count to its new one", () => {
    const r = bankAfterAppend(bank("specs/FIX.md", 2), "specs/FIX.md", before, after);
    expect(r.ok).toBe(true);
    const moved = JSON.parse((r as { text: string }).text);
    expect(moved.deferred).toEqual([
      { path: "specs/OTHER.md", criteria: 3 },
      { path: "specs/FIX.md", criteria: 3 },
    ]);
  });

  test("a spec that is not deferred leaves the bank alone", () => {
    const r = bankAfterAppend(bank("specs/FIX.md", 2), "specs/FIX.md", spec(false, [9001, 9002]), spec(false, [9001, 9002, 9003]));
    expect(r).toEqual({ ok: true, text: null });
  });

  test("an append that does not change the count leaves the bank alone", () => {
    expect(bankAfterAppend(bank("specs/FIX.md", 2), "specs/FIX.md", before, before)).toEqual({ ok: true, text: null });
  });

  test("a bank already out of step refuses rather than hiding the drift", () => {
    const r = bankAfterAppend(bank("specs/FIX.md", 1), "specs/FIX.md", before, after);
    expect(r.ok).toBe(false);
    expect((r as { refusal: string }).refusal).toBe("BANK_DRIFT");
  });

  test("a deferred spec missing from the bank, or with no bank at all, refuses", () => {
    expect(bankAfterAppend(bank("specs/ELSEWHERE.md", 2), "specs/FIX.md", before, after).ok).toBe(false);
    expect(bankAfterAppend(null, "specs/FIX.md", before, after).ok).toBe(false);
  });
});

describe("create-sc consults the bank before it writes anything", () => {
  // A deferred fixture outside this repository can never be in its bank, so
  // the CLI must refuse. Asserting the refusal proves the bank was read, and
  // the byte checks prove the refusal came BEFORE either write, without this
  // case ever moving the real bank.
  test(
    "a deferred spec the bank does not hold: refused, spec and bank untouched",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "create-sc-deferral-"));
      const file = join(dir, "FIX-SPEC.md");
      const fixture = spec(true, [9001]);
      writeFileSync(file, fixture);
      const bankBefore = readFileSync(BANK, "utf-8");
      try {
        const out = spawnSync(
          "bun",
          [join(ROOT, "scripts", "create-sc.ts"), "--pattern", "file-exists", "--params", JSON.stringify({ file: "README.md" }), "--spec", file],
          { cwd: ROOT, encoding: "utf-8", timeout: 25_000 },
        );
        expect(out.status, out.stdout + out.stderr).toBe(1);
        expect(out.stderr).toContain("BANK_DRIFT");
        expect(readFileSync(file, "utf-8"), "the spec was written before the bank refused").toBe(fixture);
        expect(readFileSync(BANK, "utf-8"), "the real bank changed").toBe(bankBefore);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
