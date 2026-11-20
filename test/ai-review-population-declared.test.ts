/**
 * Covers CRC-N7 (CODE-REVIEW-CONVERGENCE-SPEC.md), #1818.
 *
 * A review finding that names a class — a declared population of two or more
 * sites — cannot be resolved by fixing the one cited line. Its thread carries
 * the population, and from the next round on the adjudicator refuses until a
 * reply on that thread states the population the author found: N sites, M
 * defective, and the search that found them.
 *
 * Measured before this: `git grep populationDeclared origin/main -- lib scripts`
 * returned nothing, and one pull request resolved a class finding by fixing
 * the named instance seven times.
 *
 * What separates pass from fail: the same CLEAN payload exits 0 or refuses
 * depending only on whether the class thread has a stating reply. A mutant
 * whose `populationDeclared` always answers true passes the owing case, which
 * is the case that catches it; one that never answers true reds the declared
 * case.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  AI_REVIEW_THREAD_POPULATION_MARKER,
  main,
  populationDeclared,
  populationOwed,
  threadBody,
  threadPopulationFrom,
} from "../lib/scaffold/ai-review-findings";
import { AI_REVIEW_OUTCOME_LINE, AI_REVIEW_REQUIRED_EXIT, buildCarryScript } from "../lib/scaffold/ai-review-step";
import { populationOwedFromThreads } from "../lib/ai-review-suppression";

let SCRATCH = "";
beforeAll(() => {
  SCRATCH = mkdtempSync(join(tmpdir(), "ai-review-population-declared-"));
});
afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

const CLASS_FINDING = {
  severity: "medium",
  file: "lib/a.ts",
  line: 3,
  summary: "Five REST reads are unpaginated",
  failure_scenario: "a repository with 101 issues reads 100",
  population: 5,
};

const STATED = "population: 5 sites, 5 defective — search: `per_page=100`";

function captured(fn: () => number): { lines: string[]; code: number } {
  const out: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  let code: number;
  try {
    code = fn();
  } finally {
    console.log = log;
    console.error = err;
  }
  return { lines: out.join("\n").split("\n"), code };
}

let seq = 0;
function cleanPayload(): string {
  const path = join(SCRATCH, `findings-${seq++}.json`);
  writeFileSync(path, JSON.stringify({ findings: [], verdict: "PASS" }));
  return path;
}

describe("#1818: a class finding's thread carries its population", () => {
  test("PD-1: a declared population of two or more is marked, and read back", () => {
    const body = threadBody(CLASS_FINDING, "k");
    expect(body).toContain(`<!-- ${AI_REVIEW_THREAD_POPULATION_MARKER} 5 -->`);
    expect(threadPopulationFrom(body)).toBe(5);
  });

  test("PD-2: a population of one, none, or a non-number marks nothing", () => {
    for (const population of [1, undefined, "5", 0, 2.5]) {
      const body = threadBody({ ...CLASS_FINDING, population }, "k");
      expect(body, `population ${String(population)}`).not.toContain(AI_REVIEW_THREAD_POPULATION_MARKER);
      expect(threadPopulationFrom(body)).toBeNull();
    }
  });

  test("PD-3: the key marker is still the one the thread's key is read from", () => {
    const body = threadBody(CLASS_FINDING, "the-key");
    expect(body.trimEnd().endsWith("-->")).toBe(true);
    expect(body.lastIndexOf(AI_REVIEW_THREAD_POPULATION_MARKER)).toBeLessThan(body.lastIndexOf("ai-review-finding-key"));
  });
});

describe("#1818: what counts as stating the population", () => {
  test("PD-4: N sites, M defective and a search, in any dash", () => {
    expect(populationDeclared(STATED)).toBe(true);
    expect(populationDeclared("Fixed all. Population: 7 sites, 2 defective – search: foo(")).toBe(true);
    expect(populationDeclared("population: 1 site, 0 defective - search: bar")).toBe(true);
  });

  test("PD-5: a count with no search, more defective than sites, no sites, or prose is not a statement", () => {
    expect(populationDeclared("population: 5 sites, 5 defective")).toBe(false);
    expect(populationDeclared("population: 2 sites, 3 defective — search: x")).toBe(false);
    expect(populationDeclared("population: 0 sites, 0 defective — search: x")).toBe(false);
    expect(populationDeclared("fixed every instance of this")).toBe(false);
    expect(populationDeclared(undefined)).toBe(false);
  });
});

describe("#1818: which class threads still owe a population", () => {
  const classBody = threadBody(CLASS_FINDING, "k");

  test("PD-6: a class thread with no stating reply owes one, resolved or not", () => {
    const r = populationOwed([{ body: classBody, replies: [{ body: "fixed", bot: false }] }]);
    expect(r.status).toBe("MEASURED");
    expect(r.status === "MEASURED" ? r.owed.length : -1).toBe(1);
    expect(r.status === "MEASURED" ? r.owed[0] : "").toContain("Five REST reads are unpaginated");
  });

  test("PD-7: a stating reply from a person clears it; the same words from a bot do not", () => {
    expect(populationOwed([{ body: classBody, replies: [{ body: STATED, bot: false }] }])).toEqual({ status: "MEASURED", owed: [] });
    const bot = populationOwed([{ body: classBody, replies: [{ body: STATED, bot: true }] }]);
    expect(bot.status === "MEASURED" ? bot.owed.length : -1).toBe(1);
  });

  test("PD-8: a thread that names no class owes nothing", () => {
    expect(populationOwed([{ body: threadBody({ ...CLASS_FINDING, population: 1 }, "k"), replies: [] }])).toEqual({
      status: "MEASURED",
      owed: [],
    });
  });

  test("PD-9: a list carrying no replies at all is UNMEASURED, never all-declared and never all-owed", () => {
    const r = populationOwed([{ body: classBody, replies: undefined }]);
    expect(r.status).toBe("UNMEASURED");
  });

  test("PD-10: read from the bytes the carry step writes", () => {
    const owing = JSON.stringify([{ isResolved: true, body: classBody, replies: [{ body: "done", bot: false }] }]);
    const declared = JSON.stringify([{ isResolved: true, body: classBody, replies: [{ body: STATED, bot: false }] }]);
    const older = JSON.stringify([{ isResolved: false, body: classBody }]);
    const a = populationOwedFromThreads(owing);
    expect(a.status === "MEASURED" ? a.owed.length : -1).toBe(1);
    expect(populationOwedFromThreads(declared)).toEqual({ status: "MEASURED", owed: [] });
    expect(populationOwedFromThreads(older).status).toBe("UNMEASURED");
    expect(populationOwedFromThreads(null).status).toBe("UNMEASURED");
    expect(populationOwedFromThreads("{ not json").status).toBe("UNMEASURED");
  });
});

describe("#1818: the adjudicator refuses while a population is owed", () => {
  const classBody = threadBody(CLASS_FINDING, "k");

  test("PD-11: a clean payload refuses while a class thread owes its population, and names it", () => {
    const owed = populationOwed([{ body: classBody, replies: [] }]);
    const r = captured(() => main([cleanPayload()], null, null, null, undefined, owed));
    expect(r.code).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(r.lines).toContain(`${AI_REVIEW_OUTCOME_LINE} BLOCKED`);
    expect(r.lines.some(l => l.startsWith("::error") && l.includes("Five REST reads are unpaginated"))).toBe(true);
  });

  test("PD-12: the same payload passes once a reply states the population", () => {
    const owed = populationOwed([{ body: classBody, replies: [{ body: STATED, bot: false }] }]);
    const r = captured(() => main([cleanPayload()], null, null, null, undefined, owed));
    expect(r.code).toBe(0);
    expect(r.lines).toContain(`${AI_REVIEW_OUTCOME_LINE} CLEAN`);
  });

  test("PD-13: an unreadable reply list passes with a named warning, not a refusal", () => {
    const owed = populationOwed([{ body: classBody, replies: undefined }]);
    const r = captured(() => main([cleanPayload()], null, null, null, undefined, owed));
    expect(r.code).toBe(0);
    expect(r.lines.some(l => l.startsWith("::warning") && l.includes("UNMEASURED"))).toBe(true);
  });
});

describe("#1818: the carry step fetches the replies the rule reads", () => {
  test("PD-14: the generated thread query reads past the first comment and keeps who wrote each reply", () => {
    const yml = buildCarryScript();
    expect(yml).not.toContain("comments(first:1){nodes{body}}");
    expect(yml).toMatch(/comments\(first:\d{2,3}\)\{nodes\{body author\{__typename login\}\}\}/);
    expect(yml).toContain("replies:");
  });
});
