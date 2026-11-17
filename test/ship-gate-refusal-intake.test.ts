/**
 * #2234: the `gate-refusals` intake source runs at the end of a ship run, and
 * its reading never reaches the run's verdict.
 *
 * Jason decided on #1126 (2026-11-15) that each intake source runs on its own
 * trigger. This one needs the local run store, so it runs as the ship run
 * ends: on every terminal exit, because a failing run is where refusals come
 * from. The block is cut from `workflows/ship.js` on its markers and run with
 * stubbed agents, and the command it names is run for real so the parser and
 * the CLI cannot drift apart.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO = join(import.meta.dir, "..");
const SHIP = readFileSync(join(REPO, "workflows", "ship.js"), "utf-8");

const START = "// ──── GATE-REFUSAL-INTAKE-START ────";
const END = "// ──── GATE-REFUSAL-INTAKE-END ────";

/** Module scope, so missing markers fail every case rather than skipping them. */
const BLOCK: string = (() => {
  const start = SHIP.indexOf(START);
  const end = SHIP.indexOf(END);
  if (start === -1 || end === -1) throw new Error(`workflows/ship.js is missing the ${START} / ${END} markers`);
  return SHIP.slice(start, end);
})();

type Reading = { reading: string; line: string };
type Agent = (prompt: string, opts: Record<string, unknown>) => Promise<unknown>;

/** The step, with its agent replaced. `prompts` collects what it asked. */
function step(agent: Agent): { run: (status: string) => Promise<Reading>; prompts: string[]; logs: string[] } {
  const prompts: string[] = [];
  const logs: string[] = [];
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const make = new Function("timedAgent", "log", "shellQuote", "HARNESS_ROOT", "PROJECT_ROOT", `${BLOCK}\nreturn gateRefusalIntake`);
  const run = make(
    (prompt: string, opts: Record<string, unknown>) => {
      prompts.push(prompt);
      return agent(prompt, opts);
    },
    (line: string) => logs.push(line),
    quote,
    REPO,
    REPO,
  ) as (status: string) => Promise<Reading>;
  return { run, prompts, logs };
}

describe("#2234: the gate-refusals intake step", () => {
  test("asks for exactly the gate-refusals source, against this project", async () => {
    const s = step(async () => ({ line: "gate-refusals: UNMEASURED — NO_RUN_STORE" }));
    await s.run("SHIPPED");
    expect(s.prompts.length).toBe(1);
    expect(s.prompts[0]).toContain("bin/rungate.ts intake --project-root");
    expect(s.prompts[0]).toContain("--source gate-refusals");
  });

  test("relays MEASURED and UNMEASURED as the command printed them", async () => {
    const measured = await step(async () => ({ line: "gate-refusals: MEASURED — 3 candidate(s)" })).run("SHIPPED");
    expect(measured).toEqual({ reading: "MEASURED", line: "gate-refusals: MEASURED — 3 candidate(s)" });
    const unmeasured = await step(async () => ({ line: "gate-refusals: UNMEASURED — NO_RUN_STORE" })).run("VERIFY_FAILED");
    expect(unmeasured.reading).toBe("UNMEASURED");
    expect(unmeasured.line).toContain("NO_RUN_STORE");
  });

  test("a reply that names no reading is UNMEASURED, never a pass", async () => {
    const replies = [{ line: "rungate-version: 0.8.24" }, { line: "gate-refusals: PASS" }, { line: "" }, {}, null, "MEASURED"];
    for (const reply of replies) {
      const r = await step(async () => reply).run("SHIPPED");
      expect(r.reading, `reply ${JSON.stringify(reply)} was read as a reading`).toBe("UNMEASURED");
    }
  });

  test("an agent that throws ends the step UNMEASURED and does not throw", async () => {
    const s = step(async () => {
      throw new Error("agent unavailable");
    });
    const r = await s.run("IMPLEMENT_FAILED");
    expect(r.reading).toBe("UNMEASURED");
    expect(r.line).toContain("agent unavailable");
    expect(s.logs.some(l => l.includes("agent unavailable")), "the failure was not logged").toBe(true);
  });

  test("the command it names prints a line the step can read, and exits 0", () => {
    // Taken from the prompt, not retyped here, so the case runs what ship.js asks for.
    const s = step(async () => ({ line: "" }));
    void s.run("SHIPPED");
    const command = s.prompts[0].split("\n").find(l => l.startsWith("bun --cwd "));
    expect(command, "the prompt names no command line").toBeDefined();
    const store = mkdtempSync(join(tmpdir(), "gate-refusal-intake-"));
    try {
      const out = spawnSync("bash", ["-c", command!], {
        encoding: "utf-8",
        env: { ...process.env, RUNGATE_WORK_DIR: join(store, "absent") },
      });
      expect(out.status, out.stderr).toBe(0);
      const line = (out.stdout + out.stderr).split("\n").find(l => l.startsWith("gate-refusals:"));
      expect(line, `no gate-refusals line in:\n${out.stdout}${out.stderr}`).toBeDefined();
      expect(line!).toMatch(/^gate-refusals: (MEASURED|UNMEASURED)\b/);
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });
});

describe("#2234: every terminal exit takes the reading, and nothing decides a status on it", () => {
  /** A function body cut from its signature to the next top-level `}`. */
  function body(signature: string): string {
    const at = SHIP.indexOf(signature);
    expect(at, `ship.js has no ${signature}`).toBeGreaterThan(-1);
    return SHIP.slice(at, SHIP.indexOf("\n}\n", at));
  }

  test("terminalFailure, shipFailed and the run's last return each call it", () => {
    expect(body("async function terminalFailure(status, extra = {}) {")).toContain("await gateRefusalIntake(status)");
    expect(body("async function shipFailed(phaseName, immediateReason, extra = {}) {")).toContain(
      "await gateRefusalIntake('SHIP_FAILED')",
    );
    const last = SHIP.lastIndexOf("\nreturn {\n  status: terminalStatus,");
    expect(last, "the run's last return moved").toBeGreaterThan(-1);
    expect(SHIP.slice(last - 80, last)).toContain("const intake = await gateRefusalIntake(terminalStatus)");
  });

  test("the reading is returned, and read by nothing", () => {
    // The one way the advisory reading could reach a verdict is for some code
    // to read it. Outside its own block, nothing does.
    const outside = SHIP.replace(BLOCK, "");
    expect(outside.match(/\bintake\s*\??\.\s*(reading|line)\b/g) ?? []).toEqual([]);
    expect((outside.match(/\bintake,/g) ?? []).length, "the three exits no longer return the reading").toBeGreaterThanOrEqual(3);
  });
});
