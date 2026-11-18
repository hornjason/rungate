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

import { bankAfterAppend, writeDeferralBank, writeSpecWithBank } from "../lib/finding-promotion";
import { writeSpec } from "../lib/write-spec";
import { KNOWN_UNDECLARED_WRITES, trackedWriteSites } from "../scripts/contract-parity";
import { execFileSync } from "child_process";
import { mkdirSync } from "fs";

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

describe("writeSpecWithBank: the spec and the bank land together or not at all (review, #2298)", () => {
  /** An in-memory writer that fails on the paths it is told to. */
  function writer(failOn: string[] = []) {
    const files = new Map<string, string>();
    const write = (p: string, c: string) => {
      if (failOn.includes(p)) return { written: false, refusal: `${p} refused` };
      files.set(p, c);
      return { written: true };
    };
    return { files, write };
  }
  const spec = { path: "spec.md", before: "old", after: "new" };

  test("both written when both succeed", () => {
    const w = writer();
    expect(writeSpecWithBank(w.write, spec, { path: "bank.json", text: "{}" })).toEqual({ ok: true });
    expect(w.files.get("spec.md")).toBe("new");
    expect(w.files.get("bank.json")).toBe("{}");
  });

  test("a failed bank write puts the spec back", () => {
    const w = writer(["bank.json"]);
    const r = writeSpecWithBank(w.write, spec, { path: "bank.json", text: "{}" });
    expect(r.ok).toBe(false);
    expect((r as { restored: boolean }).restored).toBe(true);
    expect(w.files.get("spec.md"), "the spec kept the line the bank does not count").toBe("old");
  });

  test("a failed bank write whose restore also fails says so: restored is false (review, #2298)", () => {
    // The one state that needs a person. Simulated by refusing the restore,
    // which is the second write to the spec path.
    let specWrites = 0;
    const files = new Map<string, string>();
    const write = (p: string, c: string) => {
      if (p === "bank.json") return { written: false, refusal: "bank refused" };
      if (p === "spec.md" && ++specWrites > 1) return { written: false, refusal: "restore refused" };
      files.set(p, c);
      return { written: true };
    };
    const r = writeSpecWithBank(write, spec, { path: "bank.json", text: "{}" });
    expect(r).toEqual({ ok: false, why: "the deferral bank could not be written (bank refused)", restored: false });
    expect(files.get("spec.md"), "the spec holds the new line the bank does not count").toBe("new");
  });

  test("no bank to move writes only the spec", () => {
    const w = writer(["bank.json"]);
    expect(writeSpecWithBank(w.write, spec, { path: "bank.json", text: null })).toEqual({ ok: true });
    expect(w.files.get("spec.md")).toBe("new");
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

/**
 * #2300 — the deferral bank's write path.
 *
 * Half 2, concurrency: two sessions moving different deferred specs from the
 * same bank each read the old bank, and the second write dropped the first
 * update. `writeSpec` now takes the bytes its caller read and refuses when
 * the file holds different ones, so the second move is refused, not lost.
 *
 * Half 1, accountability: every bank write goes through `writeDeferralBank`,
 * whose one write write-accountability resolves. A writer through it needs no
 * entry of its own; a writer around it is a new site and goes red.
 */
describe("#2300: the deferral bank has one write path, and a stale write is refused", () => {
  const scratch = () => mkdtempSync(join(tmpdir(), "rg-2300-"));

  test("writeSpec refuses when the file changed since its caller read it", () => {
    const dir = scratch();
    try {
      const p = join(dir, "x.json");
      writeFileSync(p, "B1");
      const stale = writeSpec(p, "B2", { expected: "B0" });
      expect(stale.written).toBe(false);
      expect(stale.refusal).toContain("changed on disk since it was read");
      expect(readFileSync(p, "utf-8")).toBe("B1");
      expect(writeSpec(p, "B2", { expected: "B1" }).written).toBe(true);
      expect(readFileSync(p, "utf-8")).toBe("B2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("expected: null means 'it did not exist', and a file that appeared since is refused", () => {
    const dir = scratch();
    try {
      const p = join(dir, "y.json");
      expect(writeSpec(p, "A", { expected: null }).written).toBe(true);
      expect(writeSpec(p, "B", { expected: null }).written, "a file that appeared since was overwritten").toBe(false);
      expect(writeSpec(join(dir, "z.json"), "C", { expected: "was here" }).written, "a file that vanished since was recreated").toBe(false);
      // No `expected` at all keeps today's behaviour for every other caller.
      expect(writeSpec(p, "D").written).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two bank moves from the same starting bank: the second is refused, the first survives", () => {
    const dir = scratch();
    try {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      const b0 = bank("specs/A.md", 1);
      writeFileSync(join(dir, ".claude", "spec-deferral-ratchet.json"), b0);
      const first = bankAfterAppend(b0, "specs/A.md", spec(true, [9001]), spec(true, [9001, 9002]));
      const second = bankAfterAppend(b0, "specs/OTHER.md", spec(true, [1, 2, 3]), spec(true, [1, 2, 3, 4]));
      if (!first.ok || !second.ok || first.text === null || second.text === null) throw new Error("fixture banks did not move");
      expect(writeDeferralBank(dir, first.text, b0).written).toBe(true);
      const lost = writeDeferralBank(dir, second.text, b0);
      expect(lost.written, "the second move overwrote the first").toBe(false);
      expect(readFileSync(join(dir, ".claude", "spec-deferral-ratchet.json"), "utf-8")).toBe(first.text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a write whose path is spelled inline as join(root, …) is resolved, not read as the identifier 'join'", () => {
    // Found building #2300: the scanner's identifier branch came first, so
    // `writeSpec(join(root, "x"), …)` matched as the bare word `join`, found no
    // assignment for it, and dropped the write from accountability unseen.
    const dir = scratch();
    try {
      mkdirSync(join(dir, "lib"), { recursive: true });
      writeFileSync(join(dir, "lib", "w.ts"), 'export function w(root: string, t: string) { writeSpec(join(root, "kept.json"), t); }\n');
      const sites = trackedWriteSites(dir, new Set(["kept.json"]));
      expect(sites.map(x => `${x.file} → ${x.destination}`)).toEqual(["lib/w.ts → kept.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("write accountability sees ONE bank write, in the shared function, and no per-caller entry", () => {
    const tracked = new Set(execFileSync("git", ["-C", ROOT, "ls-files"], { encoding: "utf-8" }).split("\n").filter(Boolean));
    const bankSites = trackedWriteSites(ROOT, tracked)
      .filter(w => w.destination === ".claude/spec-deferral-ratchet.json")
      .map(w => w.file);
    expect(bankSites).toEqual(["lib/finding-promotion.ts"]);
    expect(Object.keys(KNOWN_UNDECLARED_WRITES).filter(k => k.endsWith("→ .claude/spec-deferral-ratchet.json"))).toEqual([
      "lib/finding-promotion.ts → .claude/spec-deferral-ratchet.json",
    ]);
  });

  test("review of #2381: the put-back refuses rather than erase a write another session landed on top", () => {
    const dir = scratch();
    try {
      const specFile = join(dir, "spec.md");
      writeFileSync(specFile, "old");
      const r = writeSpecWithBank(
        (p, c, e) => {
          if (p === "bank.json") {
            // Session B lands its own append between this run's spec write
            // and its bank write, and then this run's bank write fails.
            writeFileSync(specFile, "theirs");
            return { written: false, refusal: "bank refused" };
          }
          return writeSpec(p, c, { expected: e });
        },
        { path: specFile, before: "old", after: "mine" },
        { path: "bank.json", text: "{}" },
      );
      expect(r).toMatchObject({ ok: false, restored: false });
      expect(readFileSync(specFile, "utf-8"), "the put-back erased the other session's write").toBe("theirs");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("review of #2381: writeSpecWithBank hands each spec write the bytes it expects to replace", () => {
    const seen: [string, string, string | undefined][] = [];
    writeSpecWithBank(
      (p, c, e) => {
        seen.push([p, c, e]);
        return { written: p !== "bank.json", refusal: p === "bank.json" ? "no" : null };
      },
      { path: "spec.md", before: "old", after: "new" },
      { path: "bank.json", text: "{}" },
    );
    expect(seen).toEqual([
      ["spec.md", "new", "old"],
      ["bank.json", "{}", undefined],
      ["spec.md", "old", "new"],
    ]);
  });
});
