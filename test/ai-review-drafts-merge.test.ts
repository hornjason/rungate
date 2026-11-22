/**
 * The union of an AI review round's drafts (#2648, ADR-025 decision 2).
 *
 * Serves CRC-B11 without completing it: the merge ships here as a command so
 * a release carries it, and the workflow that runs three reviewers and calls
 * it is a separate change. These cases hold the merge's own promises — every
 * finding any draft raised survives, only an exact duplicate is dropped, and
 * a draft that did not parse is named rather than skipped.
 *
 * What was broken to prove it: keying on the file alone collapses two
 * different findings in one file, which the second case catches; dropping
 * the `seen` check keeps duplicates, which the first catches; treating an
 * unreadable draft as empty hides it, which the third catches; keeping the
 * first of two duplicates whatever its severity drops a blocking finding
 * behind an advisory one, which the severity cases catch.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeDrafts, mergeReport } from "../lib/ai-review-drafts";
import { summaryReading } from "../lib/scaffold/ai-review-findings";
import { MERGE_DRAFTS_USAGE_EXIT } from "../scripts/ai-review-merge-drafts";

const finding = (file: string, summary: string, severity = "high") => ({
  severity,
  file,
  line: 1,
  summary,
  failure_scenario: "given x, y happens",
});
const draft = (findings: unknown[], verdict = "BLOCK") => JSON.stringify({ verdict, findings, review_summary: `${findings.length} finding(s)` });

describe("#2648: the drafts merge into their union", () => {
  test("a finding two runs raised identically is kept once; one only a single run raised is kept", () => {
    const a = finding("lib/a.ts", "Null check is missing");
    const m = mergeDrafts([
      { path: "d1", text: draft([a]) },
      { path: "d2", text: draft([{ ...a, summary: "  null CHECK is   missing " }]) },
      { path: "d3", text: draft([finding("lib/b.ts", "Off by one")]) },
    ]);
    const kept = (m.payload!.findings as { file: string }[]).map(f => f.file);
    expect(kept).toEqual(["lib/a.ts", "lib/b.ts"]);
    expect(m.duplicates).toBe(1);
  });

  test("a duplicate one run called advisory and another blocking is kept at the blocking severity", () => {
    const m = mergeDrafts([
      { path: "d1", text: draft([finding("lib/a.ts", "Null check is missing", "low")]) },
      { path: "d2", text: draft([finding("lib/a.ts", "Null check is missing", "high")]) },
      { path: "d3", text: draft([finding("lib/a.ts", "Null check is missing", "medium")]) },
    ]);
    expect((m.payload!.findings as { severity: string }[]).map(f => f.severity)).toEqual(["high"]);
    expect(m.duplicates).toBe(2);
  });

  test("a severity the table does not declare outranks every declared one, so the adjudicator refuses it by name", () => {
    const m = mergeDrafts([
      { path: "d1", text: draft([finding("lib/a.ts", "One", "critical")]) },
      { path: "d2", text: draft([finding("lib/a.ts", "One", "urgent")]) },
    ]);
    expect((m.payload!.findings as { severity: string }[]).map(f => f.severity)).toEqual(["urgent"]);
  });

  test("the stricter duplicate takes the first one's place, so the order is unchanged", () => {
    const m = mergeDrafts([
      { path: "d1", text: draft([finding("lib/a.ts", "One", "low"), finding("lib/b.ts", "Two")]) },
      { path: "d2", text: draft([finding("lib/a.ts", "One", "critical")]) },
    ]);
    expect((m.payload!.findings as { file: string; severity: string }[]).map(f => `${f.file}:${f.severity}`)).toEqual([
      "lib/a.ts:critical",
      "lib/b.ts:high",
    ]);
  });

  test("two different findings in one file both survive — a file is not an identity", () => {
    const m = mergeDrafts([
      { path: "d1", text: draft([finding("lib/a.ts", "Null check is missing")]) },
      { path: "d2", text: draft([finding("lib/a.ts", "Error is swallowed")]) },
    ]);
    expect((m.payload!.findings as unknown[]).length).toBe(2);
    expect(m.duplicates).toBe(0);
  });

  test("an absent and an unreadable draft are named, and the union is taken over the rest", () => {
    const m = mergeDrafts([
      { path: "d1", text: draft([finding("lib/a.ts", "Null check is missing")]) },
      { path: "d2", text: null },
      { path: "d3", text: "{not json" },
    ]);
    expect(m.drafts.map(d => d.status)).toEqual(["parsed", "absent", "unreadable"]);
    const report = mergeReport(m);
    expect(report[0]).toStartWith("drafts: 1 of 3 parsed");
    expect(report.join("\n")).toContain("draft d2: ABSENT");
    expect(report.join("\n")).toContain("draft d3: UNREADABLE");
  });

  test("no draft parsed: no payload, so the job's no-payload routes decide the round", () => {
    const m = mergeDrafts([{ path: "d1", text: null }, { path: "d2", text: "[]" }]);
    expect(m.payload).toBeNull();
    expect(mergeReport(m)[0]).toContain("no payload written");
  });

  test("the union's summary opens with its own count, so the summary reading stays clean", () => {
    const m = mergeDrafts([
      { path: "d1", text: draft([finding("lib/a.ts", "One")]) },
      { path: "d2", text: draft([finding("lib/b.ts", "Two")]) },
    ]);
    const text = m.payload!.review_summary as string;
    expect(summaryReading({ text, listed: (m.payload!.findings as unknown[]).length }).kind).toBe("OPENS_WITH_COUNT");
  });

  test("the strictest verdict word any draft carried is kept", () => {
    const m = mergeDrafts([
      { path: "d1", text: draft([], "PASS") },
      { path: "d2", text: draft([finding("lib/a.ts", "One")], "BLOCK") },
    ]);
    expect(m.payload!.verdict).toBe("BLOCK");
  });

  test("one draft merges to that draft's findings unchanged and in order", () => {
    const list = [finding("lib/a.ts", "One"), finding("lib/b.ts", "Two"), finding("lib/c.ts", "Three")];
    const m = mergeDrafts([{ path: "d1", text: draft(list) }]);
    expect(m.payload!.findings).toEqual(list);
  });
});

describe("#2648: rungate ai-review-merge-drafts", () => {
  const SCRIPT = join(import.meta.dir, "..", "scripts", "ai-review-merge-drafts.ts");
  const run = (args: string[]) => spawnSync("bun", [SCRIPT, ...args], { encoding: "utf-8" });

  test("writes the union to --out and prints the counts", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-merge-drafts-"));
    try {
      writeFileSync(join(dir, "d1.json"), draft([finding("lib/a.ts", "One")]));
      writeFileSync(join(dir, "d2.json"), draft([finding("lib/a.ts", "One"), finding("lib/b.ts", "Two")]));
      const out = join(dir, "payload.json");
      const r = run(["--out", out, join(dir, "d1.json"), join(dir, "d2.json"), join(dir, "d3.json")]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("drafts: 2 of 3 parsed; 2 finding(s) kept, 1 duplicate(s) removed");
      expect(r.stdout).toContain("ABSENT");
      expect((JSON.parse(readFileSync(out, "utf-8")).findings as unknown[]).length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no draft parsed: exits 0 and writes no payload", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-merge-drafts-"));
    try {
      const out = join(dir, "payload.json");
      const r = run(["--out", out, join(dir, "missing.json")]);
      expect(r.status).toBe(0);
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a call it cannot read refuses through its one exit constant", () => {
    expect(run([]).status).toBe(MERGE_DRAFTS_USAGE_EXIT);
    expect(run(["--out", "x.json"]).status).toBe(MERGE_DRAFTS_USAGE_EXIT);
    const source = readFileSync(SCRIPT, "utf-8");
    expect(source.split("MERGE_DRAFTS_USAGE_EXIT = ").length - 1, "the constant is declared more than once").toBe(1);
    expect(source, "a refusal inlines its own literal").not.toMatch(/return [1-9];|process\.exit\([1-9]\)/);
  });
});
