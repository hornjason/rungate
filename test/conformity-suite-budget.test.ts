import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CONFORMITY_TEST_BUDGET_MS } from "../lib/conformity";
import { FALLOW_BUDGET_MS } from "../lib/fallow-availability";
import { GATE_TEST_TIMEOUT_MS } from "../lib/gate-timeouts";
import { perTestTimeoutDeclarations } from "../lib/per-test-timeouts";
import { generateConformityTest } from "../lib/scaffold/steps";

/**
 * #2384: the generated conformity suite gives its whole-tree scans a budget.
 *
 * A consumer's CI (asacommandcenter, 2026-11-18) timed out four things the
 * generated `test/scaffold-conformity.test.ts` registers, each at bun's 5000ms
 * default, none of which the consumer can edit because the file is
 * regenerated:
 *
 *  - `HYGIENE-3: No orphaned files` — 19915.54ms in run 44227718982
 *  - `WARN HYGIENE-6: Unreviewed constraint candidates in changed docs`
 *  - `CONFIG-1: only the loader reads the rungate config` — 30.9s in run
 *    44241728522
 *  - `(unnamed) a beforeEach/afterEach hook timed out` — 7526.04ms, the
 *    suite's own `afterAll(() => writeFindingsReport(ROOT))`
 *
 * The repair is one `setDefaultTimeout` at the top of the generated file, for
 * the reason `lib/gate-timeouts.ts` gives: a budget on three named tests
 * covers three tests, and the next scan added inherits nothing.
 */

const ROOT = join(import.meta.dir, "..");

/** bun's own default, which is what a consumer with no `--timeout` runs at. */
const BUN_DEFAULT_MS = 5000;

/** The checks the consumer saw killed, by the name each is registered under. */
const KILLED_ON_CONSUMER = [
  "HYGIENE-3: No orphaned files (zero references outside reference/)",
  "WARN HYGIENE-6: Unreviewed constraint candidates in changed docs",
  "CONFIG-1: only the loader reads the rungate config",
];

/**
 * The budget names a census can resolve to a number. Anything else is
 * refused rather than guessed, so a new spelling cannot read as covered.
 */
const KNOWN_BUDGETS: Record<string, number> = {
  CONFORMITY_TEST_BUDGET_MS,
  FALLOW_BUDGET_MS,
};

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function consumerDir(): string {
  const d = mkdtempSync(join(tmpdir(), "rg-2384-consumer-"));
  scratch.push(d);
  writeFileSync(join(d, "package.json"), JSON.stringify({ name: "some-consumer" }));
  return d;
}

describe("#2384: the generated conformity suite gives its checks a budget", () => {
  test("both emitted forms declare one file-wide budget before any check is registered", () => {
    for (const [who, text] of [
      ["rungate", generateConformityTest(ROOT)],
      ["a consumer", generateConformityTest(consumerDir())],
    ] as const) {
      const found = perTestTimeoutDeclarations(text);
      expect(found, `${who}'s generated suite did not parse`).not.toBeNull();
      const defaults = found!.filter(d => d.kind === "file-default");
      expect(defaults.map(d => d.expression), `${who}'s generated suite: the file-wide budget`).toEqual([
        "CONFORMITY_TEST_BUDGET_MS",
      ]);

      // Before the first registration. MEASURED on bun 1.3.14: a test
      // registered before setDefaultTimeout keeps the old default, and a
      // 400ms test under `--timeout 100` is killed at 100ms.
      const lines = text.split("\n");
      const at = lines.findIndex(l => l.startsWith("setDefaultTimeout("));
      const firstRun = lines.findIndex(l => /^run[A-Za-z]+\(ROOT\);$/.test(l));
      expect(firstRun, `${who}'s generated suite registers no checks`).toBeGreaterThan(-1);
      expect(at, `${who}'s setDefaultTimeout is not a top-level line the order can be read from`).toBeGreaterThan(-1);
      expect(at, `${who}'s setDefaultTimeout comes after the first check`).toBeLessThan(firstRun);
    }
  });

  test("the budget is above bun's default and below the gate suite's", () => {
    expect(CONFORMITY_TEST_BUDGET_MS).toBeGreaterThan(BUN_DEFAULT_MS);
    // 30.9s is the slowest reading in the issue; a budget under it repeats
    // the consumer's red run.
    expect(CONFORMITY_TEST_BUDGET_MS).toBeGreaterThan(30_900);
    // These checks start no subprocess, so they get less than the gate suite,
    // whose checks run a real compiler.
    expect(CONFORMITY_TEST_BUDGET_MS).toBeLessThan(GATE_TEST_TIMEOUT_MS);
  });

  test("each check the consumer saw killed runs under the file-wide budget", () => {
    const src = readFileSync(join(ROOT, "lib", "conformity.ts"), "utf-8");
    const found = perTestTimeoutDeclarations(src);
    expect(found, "lib/conformity.ts did not parse").not.toBeNull();
    const reading: string[] = [];
    for (const name of KILLED_ON_CONSUMER) {
      // Registered under exactly this name, or the next assertion is about a
      // test that no longer exists.
      expect(src, `no test is registered as "${name}"`).toContain(`test(${JSON.stringify(name)},`);
      const own = found!.find(d => d.kind === "per-test" && d.caseName === name);
      reading.push(`${name} → ${own ? own.expression : "CONFORMITY_TEST_BUDGET_MS (file-wide)"}`);
      if (own) expect(KNOWN_BUDGETS[own.expression] ?? 0, reading.at(-1)).toBeGreaterThan(BUN_DEFAULT_MS);
    }
    expect(reading).toEqual(KILLED_ON_CONSUMER.map(n => `${n} → CONFORMITY_TEST_BUDGET_MS (file-wide)`));
  });

  test("census: no check or hook lib/conformity.ts registers gives itself a budget at or below bun's default", () => {
    const src = readFileSync(join(ROOT, "lib", "conformity.ts"), "utf-8");
    const found = perTestTimeoutDeclarations(src);
    expect(found, "lib/conformity.ts did not parse").not.toBeNull();
    // The file-wide budget belongs to the generated file. One in the library
    // would leak into every suite that imports it.
    expect(found!.filter(d => d.kind === "file-default")).toEqual([]);
    const refused = found!
      .filter(d => !(d.expression in KNOWN_BUDGETS) || KNOWN_BUDGETS[d.expression]! <= BUN_DEFAULT_MS)
      .map(d => `${d.caseName ?? "a case"}: ${d.expression}`);
    expect(
      refused,
      "a check declares a budget this census cannot read as above bun's default — use CONFORMITY_TEST_BUDGET_MS " +
        "or name the constant in KNOWN_BUDGETS",
    ).toEqual([]);
    // Not vacuous: the fallow checks are the declarations this reads today.
    expect(found!.length).toBeGreaterThan(0);
  });
});

describe("#2384: the generated statement is what keeps a slow check and the closing hook green", () => {
  /**
   * The mechanism, executed. bun 1.3.14 marks a synchronous test timed out
   * AFTER it finishes, so the budget decides the verdict, not when the scan
   * stops. The witness runs the generator's own `setDefaultTimeout` line,
   * time-scaled: a 100ms command-line budget stands in for bun's 5000ms
   * default, and the constant is bound to 2000ms in the scratch file.
   */
  test("with the generated line a 400ms check and hook pass at a 100ms default; without it both are killed", () => {
    const line = generateConformityTest(consumerDir())
      .split("\n")
      .find(l => l.startsWith("setDefaultTimeout("));
    expect(line, "the generated suite has no setDefaultTimeout line").toBeDefined();

    const body = (withLine: boolean) =>
      [
        `import { afterAll, setDefaultTimeout, test } from "bun:test";`,
        `const CONFORMITY_TEST_BUDGET_MS = 2000;`,
        withLine ? line! : "",
        `const spin = (ms: number) => { const t = Date.now(); while (Date.now() - t < ms) {} };`,
        `test("a slow whole-tree scan", () => { spin(400); });`,
        `afterAll(() => spin(400));`,
        "",
      ].join("\n");

    const d = mkdtempSync(join(tmpdir(), "rg-2384-witness-"));
    scratch.push(d);
    const run = (name: string, withLine: boolean) => {
      const dir = join(d, name);
      mkdirSync(dir);
      writeFileSync(join(dir, "w.test.ts"), body(withLine));
      const r = Bun.spawnSync([process.execPath, "test", "--timeout", "100", "./w.test.ts"], { cwd: dir });
      return r.stdout.toString() + r.stderr.toString();
    };

    const kept = run("kept", true);
    expect(kept, kept).toMatch(/^ 1 pass$/m);
    expect(kept, kept).toMatch(/^ 0 fail$/m);

    const dropped = run("dropped", false);
    expect(dropped, dropped).toContain("this test timed out after 100ms");
    expect(dropped, dropped).toContain("a beforeEach/afterEach hook timed out");
  }, CONFORMITY_TEST_BUDGET_MS);
});
