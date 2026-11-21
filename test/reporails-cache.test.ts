/**
 * #2595: a RepoRails reading is cached by file content and CLI version, so a
 * CI run where no instruction file changed makes no RepoRails call.
 *
 * Measured before this existed: every run spent one check per file, 33 on
 * this tree, against a limit of 100 an hour with a key and 5 without one.
 *
 * Two halves. The pure store (`lib/reporails-cache.ts`): the key, the
 * seven-day expiry, and an unreadable file read as an EMPTY cache with a
 * reason, never as "no findings". And the caller (`runTemplateCompliance`),
 * driven through its runner seam so every RepoRails call is counted: a warm
 * cache makes none, one changed file makes one, a refused reading is never
 * cached, and a null cache path turns the cache off.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { tryLoadRungateConfig } from "../lib/config-loader";
import {
  REPORAILS_CACHE_REL,
  REPORAILS_CACHE_SCHEMA,
  REPORAILS_CACHE_TTL_MS,
  freshReading,
  loadReporailsCache,
  reporailsCacheKey,
  saveReporailsCache,
} from "../lib/reporails-cache";
import { runTemplateCompliance, type RepoRailsOutput } from "../lib/compliance";

const roots: string[] = [];
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "rungate-rrcache-"));
  roots.push(d);
  return d;
};
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const anyFinding = (x: unknown): boolean => typeof x === "object" && x !== null && typeof (x as { line?: unknown }).line === "number";
const reading = { quality: 6.5, findings: [{ line: 3, severity: "warning", rule: "R1", message: "m" }] };

describe("#2595: the store", () => {
  test("the key changes with the content and with the CLI version, and with nothing else", () => {
    const k = reporailsCacheKey("body", "9.9.1");
    expect(reporailsCacheKey("body", "9.9.1")).toBe(k);
    expect(reporailsCacheKey("body!", "9.9.1")).not.toBe(k);
    expect(reporailsCacheKey("body", "9.9.2")).not.toBe(k);
  });

  test("a reading is fresh inside seven days and gone a millisecond past it", () => {
    const now = Date.parse("2026-11-21T12:00:00.000Z");
    const at = new Date(now - REPORAILS_CACHE_TTL_MS).toISOString();
    const cache = { entries: { k: { ...reading, at } }, unreadable: null };
    expect(freshReading(cache, "k", now)).not.toBeNull();
    expect(freshReading(cache, "k", now + 1)).toBeNull();
    expect(freshReading(cache, "missing", now)).toBeNull();
  });

  test("an absent file is an empty cache with nothing to report", () => {
    const c = loadReporailsCache(join(scratch(), "none.json"), anyFinding);
    expect(c).toEqual({ entries: {}, unreadable: null });
  });

  test("an unreadable or foreign file is an EMPTY cache with a reason, never a silent one", () => {
    const d = scratch();
    for (const [name, body] of [
      ["garbage.json", "not json"],
      ["schema.json", JSON.stringify({ schema: REPORAILS_CACHE_SCHEMA + 1, entries: {} })],
      ["shape.json", JSON.stringify({ schema: REPORAILS_CACHE_SCHEMA, entries: [] })],
    ] as const) {
      writeFileSync(join(d, name), body);
      const c = loadReporailsCache(join(d, name), anyFinding);
      expect(c.entries, name).toEqual({});
      expect(c.unreadable, `${name} was read as clean`).not.toBeNull();
    }
  });

  test("one malformed entry is dropped as a miss; its neighbours survive", () => {
    const d = scratch();
    const at = new Date().toISOString();
    writeFileSync(
      join(d, "c.json"),
      JSON.stringify({
        schema: REPORAILS_CACHE_SCHEMA,
        entries: {
          good: { ...reading, at },
          badQuality: { ...reading, quality: "high", at },
          badFinding: { ...reading, findings: [null], at },
          badAt: { ...reading, at: "yesterday" },
        },
      }),
    );
    const c = loadReporailsCache(join(d, "c.json"), anyFinding);
    expect(Object.keys(c.entries)).toEqual(["good"]);
    expect(c.unreadable).toBeNull();
  });

  test("save prunes expired entries and round-trips the rest", () => {
    const d = scratch();
    const now = Date.parse("2026-11-21T12:00:00.000Z");
    const path = join(d, "nested", "c.json");
    saveReporailsCache(path, {
      keep: { ...reading, at: new Date(now - 1000).toISOString() },
      old: { ...reading, at: new Date(now - REPORAILS_CACHE_TTL_MS - 1).toISOString() },
    }, now);
    const c = loadReporailsCache(path, anyFinding);
    expect(Object.keys(c.entries)).toEqual(["keep"]);
  });
});

describe("#2608 review: the file CI persists is the file the runner reads", () => {
  test("this repository's ci.persistPaths names REPORAILS_CACHE_REL", () => {
    // Without this, renaming the cache in lib/ leaves CI restoring and saving
    // a file nothing reads: every run silently misses, at full call cost.
    const config = tryLoadRungateConfig(join(import.meta.dir, "..")) as { ci?: { persistPaths?: string[] } } | null;
    expect(config?.ci?.persistPaths ?? [], "ci.persistPaths does not carry the cache the runner reads").toContain(REPORAILS_CACHE_REL);
  });
});

describe("#2595: the caller counts its calls", () => {
  /** A project with two instruction files, and a runner that counts what it is asked. */
  const project = () => {
    const root = scratch();
    mkdirSync(join(root, ".claude", "agents"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "# Agents\n\nDo the thing.\n");
    writeFileSync(join(root, ".claude", "agents", "marcus.md"), "# Marcus\n\nBuild it.\n");
    const asked: string[] = [];
    const runner = async (path: string): Promise<RepoRailsOutput | null> => {
      asked.push(path);
      return { quality: 7, files: { [path]: { findings: [{ line: 1, severity: "warning", rule: "R", message: "m" }] } } } as unknown as RepoRailsOutput;
    };
    const surface = ["AGENTS.md", ".claude/agents/marcus.md"];
    const probes = {
      agnix: { outcome: "absent" as const, available: false, tool: "agnix", exitCode: null, reason: "PLANTED-agnix-absent" },
      reporails: { outcome: "available" as const, available: true, tool: "reporails", exitCode: 0, reason: "PLANTED-reporails-present" },
    };
    const run = (extra: Record<string, unknown> = {}) =>
      runTemplateCompliance(root, { surface, writeReport: false, probes, reporailsRunner: runner, reporailsVersion: "9.9.1", ...extra });
    return { root, asked, run };
  };

  test("a cold cache checks every file; the warm run after it checks none", async () => {
    const p = project();
    const cold = await p.run();
    expect(p.asked.length).toBe(2);
    expect(cold.reporailsCache).toMatchObject({ hits: 0, checked: 2 });
    p.asked.length = 0;
    const warm = await p.run();
    expect(p.asked.length, "a warm cache still called RepoRails").toBe(0);
    expect(warm.reporailsCache).toMatchObject({ hits: 2, checked: 0 });
    // The cached reading is the reading: same score, same findings.
    expect(warm.files.map((f) => f.reporailsQuality)).toEqual(cold.files.map((f) => f.reporailsQuality));
    expect(warm.totalFindings).toBe(cold.totalFindings);
  });

  test("changing one file checks exactly that file", async () => {
    const p = project();
    await p.run();
    p.asked.length = 0;
    writeFileSync(join(p.root, "AGENTS.md"), "# Agents\n\nDo the other thing.\n");
    await p.run();
    expect(p.asked).toEqual([join(p.root, "AGENTS.md")]);
  });

  test("a new CLI version checks everything again", async () => {
    const p = project();
    await p.run();
    p.asked.length = 0;
    await p.run({ reporailsVersion: "9.9.2" });
    expect(p.asked.length).toBe(2);
  });

  test("a refused reading is never cached, so the next run asks again", async () => {
    const p = project();
    let refuse = true;
    const asked: string[] = [];
    const flaky = async (path: string): Promise<RepoRailsOutput | null> => {
      asked.push(path);
      return refuse ? null : ({ quality: 7, files: { [path]: { findings: [] } } } as unknown as RepoRailsOutput);
    };
    await p.run({ reporailsRunner: flaky });
    refuse = false;
    asked.length = 0;
    await p.run({ reporailsRunner: flaky });
    expect(asked.length, "a refusal was cached as a reading").toBe(2);
  });

  test("a file that cannot be read is checked, not a crash that loses the rest (#2608)", async () => {
    const p = project();
    const locked = join(p.root, ".claude", "agents", "marcus.md");
    chmodSync(locked, 0o000);
    try {
      const report = await p.run();
      expect(p.asked.length, "the unreadable file or its neighbour was skipped").toBe(2);
      expect(report.reporailsCache).toMatchObject({ hits: 0, checked: 2 });
    } finally {
      chmodSync(locked, 0o644);
    }
  });

  test("a null cache path turns the cache off and writes nothing", async () => {
    const p = project();
    await p.run({ reporailsCachePath: null });
    p.asked.length = 0;
    const second = await p.run({ reporailsCachePath: null });
    expect(p.asked.length).toBe(2);
    expect(second.reporailsCache).toMatchObject({ path: null, hits: 0, checked: 2 });
    expect(existsSync(join(p.root, ".rungate", "reporails-cache.json"))).toBe(false);
  });

  test("the default cache lives at REPORAILS_CACHE_REL, under .rungate/, which git ignores", async () => {
    const p = project();
    await p.run();
    expect(REPORAILS_CACHE_REL.startsWith(".rungate/")).toBe(true);
    const path = join(p.root, REPORAILS_CACHE_REL);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf-8")).schema).toBe(REPORAILS_CACHE_SCHEMA);
  });
});
