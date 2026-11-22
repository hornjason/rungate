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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findingIdentity, mergeDrafts, mergeReport, roundRepresentative, severityStrictness } from "../lib/ai-review-drafts";
import { advisoryKey, severityBlocks, summaryReading } from "../lib/scaffold/ai-review-findings";
import { MERGE_DRAFTS_REFUSED_EXIT } from "../scripts/ai-review-merge-drafts";

const finding = (file: string, summary: string, severity = "high", line = 1) => ({
  severity,
  file,
  line,
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

  // PR #2656 round 1: an undeclared severity reads the round UNMEASURED,
  // which is weaker than a block and stronger than a pass. So it ranks below
  // every blocking severity and above every advisory one.
  test("a blocking severity outranks one the table does not declare, so the round still blocks", () => {
    for (const order of [["critical", "Critical"], ["Critical", "critical"]]) {
      const m = mergeDrafts(order.map((sev, i) => ({ path: `d${i}`, text: draft([finding("lib/a.ts", "One", sev)]) })));
      expect((m.payload!.findings as { severity: string }[]).map(f => f.severity)).toEqual(["critical"]);
    }
  });

  test("a severity the table does not declare outranks an advisory one, so the adjudicator refuses it by name", () => {
    for (const order of [["low", "urgent"], ["urgent", "low"]]) {
      const m = mergeDrafts(order.map((sev, i) => ({ path: `d${i}`, text: draft([finding("lib/a.ts", "One", sev)]) })));
      expect((m.payload!.findings as { severity: string }[]).map(f => f.severity)).toEqual(["urgent"]);
    }
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

  // PR #2656 round 7: a round that planned three runs and heard from fewer
  // may establish a block, never a pass. One silent run already reads
  // UNMEASURED today; three runs must not turn two silent ones into a pass.
  test("a partial round with nothing that blocks writes no payload, and says why", () => {
    for (const listed of [[], [finding("lib/a.ts", "One", "low")]]) {
      const m = mergeDrafts([
        { path: "d1", text: draft(listed, "PASS") },
        { path: "d2", text: null },
        { path: "d3", text: "{not json" },
      ]);
      expect(m.payload).toBeNull();
      expect(mergeReport(m)[0]).toContain("no payload written");
      expect(mergeReport(m)[0]).toContain("1 of 3 drafts parsed and none of them blocks");
    }
  });

  test("a partial round with a blocking finding still writes the union, so the block stands", () => {
    const m = mergeDrafts([
      { path: "d1", text: draft([finding("lib/a.ts", "One", "low")], "PASS") },
      { path: "d2", text: draft([finding("lib/b.ts", "Two", "critical")]) },
      { path: "d3", text: null },
    ]);
    expect((m.payload!.findings as { file: string }[]).map(x => x.file)).toEqual(["lib/a.ts", "lib/b.ts"]);
  });

  test("a full round that blocks nothing writes its payload — every planned run was heard", () => {
    const m = mergeDrafts([
      { path: "d1", text: draft([], "PASS") },
      { path: "d2", text: draft([finding("lib/a.ts", "One", "low")], "PASS") },
    ]);
    expect(m.payload).not.toBeNull();
    expect(m.payload!.verdict).toBe("PASS");
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

// PR #2656 round 3, re-scoped under rule 5: rounds 1 to 3 each found a
// defect in a rule that lived in a different line, so "same finding" and
// "stricter" are now one function each, and these cases read them as tables.
describe("#2648: one identity, one ranking", () => {
  const f = (file: string, line: unknown, summary: string) => ({ file, line, summary, severity: "high" });

  test("the identity is file, line and normalised summary — each row says whether two findings are one", () => {
    const rows: [string, Record<string, unknown>, Record<string, unknown>, boolean][] = [
      ["same everything", f("lib/a.ts", 10, "Token logged"), f("lib/a.ts", 10, "Token logged"), true],
      ["summary differs only in case and spacing", f("lib/a.ts", 10, "Token logged"), f("lib/a.ts", 10, "  token   LOGGED "), true],
      ["severity differs", f("lib/a.ts", 10, "Token logged"), { ...f("lib/a.ts", 10, "Token logged"), severity: "low" }, true],
      ["line differs", f("lib/a.ts", 10, "Token logged"), f("lib/a.ts", 200, "Token logged"), false],
      ["file differs", f("lib/a.ts", 10, "Token logged"), f("lib/b.ts", 10, "Token logged"), false],
      // PR #2662: a path is compared as written; two files differing only by
      // case are two files on a case-sensitive checkout.
      ["file differs only by case", f("lib/Parser.ts", 10, "Token logged"), f("lib/parser.ts", 10, "Token logged"), false],
      ["file differs only by surrounding space", f("lib/a.ts", 10, "Token logged"), f(" lib/a.ts ", 10, "Token logged"), true],
      ["summary differs", f("lib/a.ts", 10, "Token logged"), f("lib/a.ts", 10, "Error swallowed"), false],
      ["line absent on one", f("lib/a.ts", 10, "Token logged"), f("lib/a.ts", undefined, "Token logged"), false],
      ["line as a string and a number", f("lib/a.ts", 10, "Token logged"), f("lib/a.ts", "10", "Token logged"), false],
    ];
    for (const [name, a, b, same] of rows) {
      expect(findingIdentity(a) === findingIdentity(b), name).toBe(same);
    }
  });

  // PR #2656 round 5: the identity compares the normalised TEXT. Keyed on
  // advisoryKey, a 32-bit hash, two different findings that collide were one,
  // and the second was dropped with no line naming it. This pair was found by
  // brute force and collides today; the first assertion proves it still does.
  test("two summaries whose 32-bit advisoryKey collides are two findings", () => {
    const a = f("lib/a.ts", 10, "token logged 4978");
    const b = f("lib/a.ts", 10, "token logged 374420");
    expect(advisoryKey(a), "the fixture no longer collides, so this case witnesses nothing").toBe(advisoryKey(b));
    expect(findingIdentity(a)).not.toBe(findingIdentity(b));
    const m = mergeDrafts([
      { path: "d1", text: draft([{ ...a, failure_scenario: "x" }]) },
      { path: "d2", text: draft([{ ...b, failure_scenario: "x" }]) },
    ]);
    expect((m.payload!.findings as unknown[]).length).toBe(2);
    expect(m.duplicates).toBe(0);
  });

  test("the ranking is one order, strictest first: blocking, then undeclared, then advisory", () => {
    const strictestFirst: unknown[] = ["critical", "high", "Critical", "medium", "low", "info"];
    const ranks = strictestFirst.map(sev => severityStrictness({ severity: sev }));
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i - 1], `${String(strictestFirst[i - 1])} before ${String(strictestFirst[i])}`).toBeLessThan(ranks[i]);
    }
    // Every undeclared spelling, and no severity at all, is one rank — the
    // names every object inherits too, which a plain property read of the
    // severity table returns as functions rather than undefined (round 4).
    for (const sev of ["urgent", "", 3, null, undefined, "constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(severityStrictness({ severity: sev }), String(sev)).toBe(severityStrictness({ severity: "Critical" }));
    }
  });
});

describe("#2648: the union keeps every occurrence any one run reported", () => {
  test("two defects one run raised with the same words on different lines are both kept", () => {
    const m = mergeDrafts([
      { path: "d1", text: draft([finding("lib/a.ts", "Token logged", "critical", 10), finding("lib/a.ts", "Token logged", "critical", 200)]) },
    ]);
    expect((m.payload!.findings as { line: number }[]).map(x => x.line)).toEqual([10, 200]);
    expect(m.duplicates).toBe(0);
  });

  test("the same words on different lines from different runs are both kept", () => {
    const m = mergeDrafts([
      { path: "d1", text: draft([finding("lib/a.ts", "Token logged", "critical", 10)]) },
      { path: "d2", text: draft([finding("lib/a.ts", "Token logged", "critical", 200)]) },
    ]);
    expect((m.payload!.findings as { line: number }[]).map(x => x.line)).toEqual([10, 200]);
    expect(m.duplicates).toBe(0);
  });

  test("a finding one run listed twice and another once is kept twice — the most any one run reported", () => {
    const x = finding("lib/a.ts", "Token logged", "critical", 10);
    const m = mergeDrafts([
      { path: "d1", text: draft([x, x]) },
      { path: "d2", text: draft([x]) },
      { path: "d3", text: draft([x, x]) },
    ]);
    expect((m.payload!.findings as unknown[]).length).toBe(2);
    expect(m.duplicates).toBe(3);
  });
});

// PR #2656 round 6: every defect rounds 1 to 5 found was one rule of the
// merge answered wrongly for an input no row had written. So the merge's
// whole contract is asserted here over generated drafts, not row by row:
// the union holds each identity as many times as the most any one draft
// listed it, its n-th copy is the strictest n-th copy any draft gave, it
// holds nothing no draft listed, and one draft merges to itself.
describe("#2648: the merge's contract, over generated drafts", () => {
  // A seeded generator, so a failure names a draft that reproduces.
  const prng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  // Small pools, so collisions — the cases the rules are about — are common.
  const FILES = ["lib/a.ts", "lib/b.ts"];
  const LINES = [1, 2];
  const SUMMARIES = ["Token logged", "  token LOGGED ", "Error swallowed"];
  const SEVERITIES = ["critical", "high", "medium", "low", "info", "urgent", "constructor"];
  const genDraft = (r: () => number) =>
    Array.from({ length: Math.floor(r() * 6) }, () => ({
      severity: pick(r, SEVERITIES),
      file: pick(r, FILES),
      line: pick(r, LINES),
      summary: pick(r, SUMMARIES),
      failure_scenario: `scenario ${Math.floor(r() * 1000)}`,
    }));
  const occurrences = (list: Record<string, unknown>[]) => {
    const by = new Map<string, Record<string, unknown>[]>();
    for (const x of list) by.set(findingIdentity(x), [...(by.get(findingIdentity(x)) ?? []), x]);
    return by;
  };

  test("400 generated rounds keep every rule of the union", () => {
    let collisions = 0;
    let withheld = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const r = prng(seed);
      const planned = 1 + Math.floor(r() * 3);
      const all = Array.from({ length: planned }, () => (r() < 0.2 ? null : genDraft(r)));
      const drafts = all.filter((d): d is ReturnType<typeof genDraft> => d !== null);
      const m = mergeDrafts(all.map((d, i) => ({ path: `d${i}`, text: d === null ? null : draft(d) })));
      const at = `seed ${seed}`;
      const blocksSomewhere = drafts.flat().some(x => severityBlocks(x.severity) === true);
      const outcomes = ["success", "failure", "cancelled", "skipped"];
      const runs = all.map((_, i) => ({ outcome: pick(r, outcomes), execution: `/x/e${i}.json` }));
      const rep = roundRepresentative(m, runs);
      const firstHeard = all.findIndex(d => d !== null);
      const firstSilent = all.findIndex(d => d === null);
      if (m.payload !== null) {
        expect(rep, `${at}: a written payload is reported by the first run heard, as a success`).toEqual({ run: firstHeard, outcome: "success", execution: runs[firstHeard].execution });
      } else {
        const gap = firstSilent === -1 ? 0 : firstSilent;
        expect(rep, `${at}: a withheld payload is reported by the first run not heard`).toEqual({ run: gap, ...runs[gap] });
      }
      if (drafts.length === 0 || (drafts.length < planned && !blocksSomewhere)) {
        expect(m.payload, `${at}: ${drafts.length} of ${planned} heard and nothing blocks — no payload`).toBeNull();
        withheld += drafts.length > 0 ? 1 : 0;
        continue;
      }
      const merged = m.payload!.findings as Record<string, unknown>[];

      if (drafts.length === 1 && planned === 1) expect(merged, `${at}: one draft merges to itself`).toEqual(drafts[0]);

      const inputs = new Set(drafts.flat().map(x => JSON.stringify(x)));
      for (const x of merged) expect(inputs.has(JSON.stringify(x)), `${at}: a merged finding no draft listed`).toBe(true);

      const mergedBy = occurrences(merged);
      const perDraft = drafts.map(occurrences);
      const keys = new Set(perDraft.flatMap(d => [...d.keys()]));
      expect(new Set(mergedBy.keys()), `${at}: the identities kept are the identities listed`).toEqual(keys);
      for (const k of keys) {
        const most = Math.max(...perDraft.map(d => d.get(k)?.length ?? 0));
        const kept = mergedBy.get(k) ?? [];
        expect(kept.length, `${at}: ${k} kept as often as the most any draft listed it`).toBe(most);
        if (perDraft.filter(d => d.has(k)).length > 1) collisions++;
        for (let n = 0; n < most; n++) {
          const strictest = Math.min(
            ...perDraft.filter(d => (d.get(k)?.length ?? 0) > n).map(d => severityStrictness(d.get(k)![n])),
          );
          expect(severityStrictness(kept[n]), `${at}: copy ${n} of ${k} is the strictest any draft gave`).toBe(strictest);
        }
      }
      // The blocking findings are what decide a round, so say it directly too.
      const blockingIn = new Set(drafts.flat().filter(x => severityBlocks(x.severity) === true).map(findingIdentity));
      const blockingOut = new Set(merged.filter(x => severityBlocks(x.severity) === true).map(findingIdentity));
      expect(blockingOut, `${at}: every identity some run blocked on still blocks`).toEqual(blockingIn);
    }
    expect(collisions, "the generator produced no cross-draft duplicates, so the strictness rule was never exercised").toBeGreaterThan(100);
    expect(withheld, "no generated round was partial and blocked nothing, so the partial rule was never exercised").toBeGreaterThan(5);
  });
});

// #2661: the steps after the review read ONE action outcome and ONE
// execution file. Which run supplies them is decided here, once: a written
// payload is reported by the first run whose draft parsed, as a success; a
// withheld one by the first run whose draft did not, with its own outcome —
// so a partial round is reported by the run that made it partial.
describe("#2661: the run a round reports", () => {
  const runs = [
    { outcome: "success", execution: "/x/execution-1.json" },
    { outcome: "failure", execution: "" },
    { outcome: "success", execution: "/x/execution-3.json" },
  ];
  const pass = draft([], "PASS");
  const block = draft([finding("lib/a.ts", "One", "critical")]);

  test("each row names the run and the outcome the round reports", () => {
    const rows: [string, (string | null)[], { run: number; outcome: string; execution: string }][] = [
      ["every draft parsed: the first, as a success", [pass, pass, pass], { run: 0, outcome: "success", execution: "/x/execution-1.json" }],
      ["run 1 silent, the rest block: the first parsed run, run 2's slot", [null, block, pass], { run: 1, outcome: "success", execution: "" }],
      ["partial and nothing blocks: the first run that did not parse", [pass, null, pass], { run: 1, outcome: "failure", execution: "" }],
      ["partial and nothing blocks, run 1 the gap", [null, pass, pass], { run: 0, outcome: "success", execution: "/x/execution-1.json" }],
      ["no draft parsed: run 1, as today", [null, null, null], { run: 0, outcome: "success", execution: "/x/execution-1.json" }],
      ["unreadable counts as not parsed", [pass, pass, "{nope"], { run: 2, outcome: "success", execution: "/x/execution-3.json" }],
    ];
    for (const [name, texts, want] of rows) {
      const m = mergeDrafts(texts.map((text, i) => ({ path: `d${i}`, text })));
      expect(roundRepresentative(m, runs), name).toEqual(want);
    }
  });

  test("a written payload is never reported as anything but a success, and a withheld one never as a success it did not earn", () => {
    const failing = runs.map(r => ({ ...r, outcome: "failure" }));
    const written = mergeDrafts([pass, pass, pass].map((text, i) => ({ path: `d${i}`, text })));
    expect(roundRepresentative(written, failing).outcome).toBe("success");
    const withheld = mergeDrafts([pass, null, pass].map((text, i) => ({ path: `d${i}`, text })));
    expect(roundRepresentative(withheld, failing).outcome).toBe("failure");
  });

  test("a run list that does not match the drafts is refused, not guessed", () => {
    const m = mergeDrafts([pass, pass].map((text, i) => ({ path: `d${i}`, text })));
    expect(() => roundRepresentative(m, runs)).toThrow(/2 drafts and 3 runs/);
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

  test("a draft path that exists but cannot be read is named UNREADABLE, and the union is taken over the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-merge-drafts-"));
    try {
      writeFileSync(join(dir, "d1.json"), draft([finding("lib/a.ts", "One")]));
      mkdirSync(join(dir, "d2.json"));
      const out = join(dir, "payload.json");
      const r = run(["--out", out, join(dir, "d1.json"), join(dir, "d2.json")]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("drafts: 1 of 2 parsed");
      expect(r.stdout).toMatch(/d2\.json: UNREADABLE — could not be read/);
      expect((JSON.parse(readFileSync(out, "utf-8")).findings as unknown[]).length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // PR #2656 round 2: existsSync answers false when stat fails, so a draft in
  // a directory nobody can search read as ABSENT — "that run wrote no
  // payload" about a file that run did write. Only ENOENT is absent.
  test("a draft in a directory that cannot be searched is UNREADABLE, not ABSENT", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-merge-drafts-"));
    const locked = join(dir, "locked");
    try {
      writeFileSync(join(dir, "d1.json"), draft([finding("lib/a.ts", "One")]));
      mkdirSync(locked);
      writeFileSync(join(locked, "d2.json"), draft([finding("lib/b.ts", "Two")]));
      chmodSync(locked, 0o000);
      const r = run(["--out", join(dir, "payload.json"), join(dir, "d1.json"), join(locked, "d2.json")]);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/d2\.json: UNREADABLE — could not be read/);
      expect(r.stdout).not.toContain("ABSENT");
    } finally {
      chmodSync(locked, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a partial round that blocks nothing: exits 0 and writes no payload", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-merge-drafts-"));
    try {
      writeFileSync(join(dir, "d1.json"), draft([], "PASS"));
      const out = join(dir, "payload.json");
      const r = run(["--out", out, join(dir, "d1.json"), join(dir, "d2.json"), join(dir, "d3.json")]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("1 of 3 drafts parsed and none of them blocks");
      expect(existsSync(out)).toBe(false);
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

  // PR #2656 round 8: a payload that should have been written and was not
  // would read as no payload, and a block that stands would read UNMEASURED.
  // So an unwritable --out refuses, by name, through the one constant.
  test("a payload it cannot write refuses through the same constant, naming the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-merge-drafts-"));
    try {
      writeFileSync(join(dir, "d1.json"), draft([finding("lib/a.ts", "One", "critical")]));
      const out = join(dir, "missing-dir", "payload.json");
      const r = run(["--out", out, join(dir, "d1.json")]);
      expect(r.status).toBe(MERGE_DRAFTS_REFUSED_EXIT);
      expect(r.stderr).toContain(`could not write the payload to ${out}`);
      expect(r.stderr, "an uncaught throw, not a refusal").not.toMatch(/^\s+at /m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the usage names every planned path, written or not, as the plan", () => {
    expect(run([]).stderr).toContain("every planned draft path, written or not");
  });

  test("#2661: --outcome, --execution and --github-output append the run the round reports", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-merge-drafts-"));
    try {
      writeFileSync(join(dir, "d1.json"), draft([], "PASS"));
      const gh = join(dir, "github-output");
      writeFileSync(gh, "earlier=kept\n");
      const r = run([
        "--out", join(dir, "payload.json"),
        "--outcome", "success", "--outcome", "failure", "--outcome", "success",
        "--execution", join(dir, "e1.json"), "--execution", "", "--execution", join(dir, "e3.json"),
        "--github-output", gh,
        join(dir, "d1.json"), join(dir, "d2.json"), join(dir, "d3.json"),
      ]);
      expect(r.status).toBe(0);
      expect(readFileSync(gh, "utf-8")).toBe("earlier=kept\noutcome=failure\nexecution_file=\n");
      expect(r.stdout).toContain("reports run 2: outcome failure");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("#2661: each malformed run list refuses through the one constant, and writes no output", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-merge-drafts-"));
    try {
      writeFileSync(join(dir, "d1.json"), draft([], "PASS"));
      const gh = join(dir, "github-output");
      const base = ["--out", join(dir, "payload.json")];
      const d = [join(dir, "d1.json"), join(dir, "d2.json")];
      const cases: [string, string[]][] = [
        ["fewer outcomes than drafts", [...base, "--outcome", "success", "--execution", "a", "--execution", "b", "--github-output", gh, ...d]],
        ["an outcome GitHub does not report", [...base, "--outcome", "success", "--outcome", "maybe", "--execution", "a", "--execution", "b", "--github-output", gh, ...d]],
        ["a newline in an execution path", [...base, "--outcome", "success", "--outcome", "success", "--execution", "a\nexecution_file=evil", "--execution", "b", "--github-output", gh, ...d]],
        ["outcomes with no output file", [...base, "--outcome", "success", "--outcome", "success", "--execution", "a", "--execution", "b", ...d]],
        ["an output file with no outcomes", [...base, "--github-output", gh, ...d]],
      ];
      for (const [name, args] of cases) {
        const r = run(args);
        expect(r.status, name).toBe(MERGE_DRAFTS_REFUSED_EXIT);
        expect(existsSync(gh), `${name}: wrote the output anyway`).toBe(false);
      }
      const unwritable = run([...base, "--outcome", "success", "--outcome", "success", "--execution", "a", "--execution", "b",
        "--github-output", join(dir, "missing-dir", "out"), ...d]);
      expect(unwritable.status, "an output file it cannot append to").toBe(MERGE_DRAFTS_REFUSED_EXIT);
      expect(unwritable.stderr).toContain("could not append the round's run to");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a call it cannot read refuses through its one exit constant", () => {
    expect(run([]).status).toBe(MERGE_DRAFTS_REFUSED_EXIT);
    expect(run(["--out", "x.json"]).status).toBe(MERGE_DRAFTS_REFUSED_EXIT);
    const source = readFileSync(SCRIPT, "utf-8");
    expect(source.split("MERGE_DRAFTS_REFUSED_EXIT = ").length - 1, "the constant is declared more than once").toBe(1);
    expect(source, "a write that can throw out of main").not.toMatch(/^\s*if \(merged\.payload !== null\) writeFileSync/m);
    expect(source, "a refusal inlines its own literal").not.toMatch(/return [1-9];|process\.exit\([1-9]\)/);
  });
});
