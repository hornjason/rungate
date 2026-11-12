/**
 * Covers SC-2738 (SPEC-TO-BOARD-PIPELINE-SPEC.md): merging an ADR whose status
 * changes to accepted places its plan on the board with no command typed by
 * hand.
 *
 * ADR-013 row 5. Until this shipped, step 4 of the four-step process was a
 * person remembering five commands in order — `plan-spec`, `plan-issues
 * --decompose`, `plan-deps`, `board-mirror`, `board-ready --top-up` — and the
 * first ADR-013 dry run found the order links had never been written.
 *
 * Three layers, each executed rather than described:
 *
 *   1. `newlyAccepted` — the one decider for "did this push accept it".
 *   2. `plan-issues --accepted-since <sha>` against a real git history, so the
 *      read of the ADR at the earlier commit is inside what is measured.
 *   3. The workflow file, parsed: the trigger, the order of the five steps,
 *      and which credential each step holds.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { adrStatus, newlyAccepted } from "../lib/issue-decomposition";
import { REFUSAL_EXIT, main as planIssuesMain } from "../scripts/plan-issues";

const adr = (status: string, table = true) =>
  [
    "---",
    "doc-type: adr",
    `status: ${status}`,
    "---",
    "",
    "# ADR-099 — a decision",
    "",
    ...(table
      ? [
          "| Criterion | Outcome | Files | Milestone | Blocked by |",
          "|---|---|---|---|---|",
          "| CRC-C2 | a row this ADR plans | lib/a.ts | — | — |",
        ]
      : ["No decomposition: this ADR decides and files nothing."]),
    "",
  ].join("\n");

describe("SC-2738: newlyAccepted reads the frontmatter status at both ends", () => {
  test("SC-2738: proposed → accepted is a new acceptance", () => {
    expect(newlyAccepted(adr("proposed"), adr("accepted"))).toBe(true);
  });

  test("SC-2738: a file that did not exist before and lands accepted is a new acceptance", () => {
    expect(newlyAccepted(null, adr("accepted"))).toBe(true);
  });

  test("SC-2738: accepted → accepted is NOT — an edit to an accepted ADR re-files nothing", () => {
    expect(newlyAccepted(adr("accepted"), adr("accepted"))).toBe(false);
  });

  test("SC-2738: accepted → superseded, and proposed → proposed, are not acceptances", () => {
    expect(newlyAccepted(adr("accepted"), adr("superseded"))).toBe(false);
    expect(newlyAccepted(adr("proposed"), adr("proposed"))).toBe(false);
  });

  test("SC-2738: only the FRONTMATTER decides — a body line reading `status: accepted` does not", () => {
    const body = adr("proposed").replace("# ADR-099 — a decision", "# ADR-099\n\nstatus: accepted");
    expect(adrStatus(body)).toBe("proposed");
    expect(newlyAccepted(adr("proposed"), body)).toBe(false);
    // And a file with no frontmatter has no status at all.
    expect(adrStatus("status: accepted\n")).toBeNull();
  });
});

describe("SC-2738: plan-issues --accepted-since lists what a push accepted", () => {
  function repo() {
    const dir = mkdtempSync(join(tmpdir(), "rg-adr-accepted-"));
    const git = (...args: string[]) => {
      const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
      if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
      return r.stdout.trim();
    };
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    mkdirSync(join(dir, "docs", "adr"), { recursive: true });
    return { dir, git };
  }

  async function since(dir: string, sha: string) {
    const said: string[] = [];
    const errs: string[] = [];
    const real = { log: console.log, error: console.error };
    console.log = (...a: unknown[]) => void said.push(a.join(" "));
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    try {
      const code = await planIssuesMain(["--accepted-since", sha, "--project-root", dir]);
      return { code, out: said.join("\n"), err: errs.join("\n") };
    } finally {
      console.log = real.log;
      console.error = real.error;
    }
  }

  test("SC-2738: exactly the ADR this push accepted is listed — not the one already accepted", async () => {
    const { dir, git } = repo();
    try {
      writeFileSync(join(dir, "docs/adr/ADR-098-old.md"), adr("accepted"));
      writeFileSync(join(dir, "docs/adr/ADR-099-new.md"), adr("proposed"));
      writeFileSync(join(dir, "docs/adr/ADR-100-decides.md"), adr("proposed", false));
      git("add", "-A");
      git("commit", "-q", "-m", "before");
      const before = git("rev-parse", "HEAD");
      writeFileSync(join(dir, "docs/adr/ADR-099-new.md"), adr("accepted"));
      writeFileSync(join(dir, "docs/adr/ADR-100-decides.md"), adr("accepted", false));
      writeFileSync(join(dir, "docs/adr/ADR-101-born.md"), adr("accepted"));
      git("add", "-A");
      git("commit", "-q", "-m", "accept");

      const r = await since(dir, before);
      expect(r.code).toBe(0);
      // ADR-098 was accepted already; ADR-100 was accepted but plans nothing.
      expect(r.out.split("\n").filter(Boolean)).toEqual([
        "docs/adr/ADR-099-new.md",
        "docs/adr/ADR-101-born.md",
      ]);
      expect(r.err).toContain("ADR-100-decides.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SC-2738 CONTROL: a commit the clone does not hold REFUSES — it is not 'nothing was accepted'", async () => {
    // A shallow checkout cannot read the earlier commit. Reading every ADR
    // as absent there would list every accepted ADR in the repository and
    // re-run all of their plans.
    const { dir, git } = repo();
    try {
      writeFileSync(join(dir, "docs/adr/ADR-099-new.md"), adr("accepted"));
      git("add", "-A");
      git("commit", "-q", "-m", "only");
      const r = await since(dir, "0123456789abcdef0123456789abcdef01234567");
      expect(r.code).toBe(REFUSAL_EXIT);
      expect(r.out).toBe("");
      expect(r.err).toMatch(/UNMEASURED/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SC-2738: .github/workflows/adr-accepted.yml runs the five steps in order", () => {
  const path = join(import.meta.dir, "..", ".github", "workflows", "adr-accepted.yml");
  const text = readFileSync(path, "utf-8");
  const doc = Bun.YAML.parse(text) as any;
  const steps: any[] = doc.jobs["place-the-plan"].steps;
  const runOf = (s: any) => String(s.run ?? "");

  test("SC-2738: it fires on a push to main that touches docs/adr, and on nothing else", () => {
    expect(Object.keys(doc.on)).toEqual(["push"]);
    expect(doc.on.push.branches).toEqual(["main"]);
    expect(doc.on.push.paths).toEqual(["docs/adr/**"]);
  });

  test("SC-2738: the earlier commit is fetched, or the acceptance read refuses on every run", () => {
    const checkout = steps.find(s => String(s.uses ?? "").startsWith("actions/checkout@"));
    expect(checkout.with["fetch-depth"]).toBe(0);
  });

  test("SC-2738: the five board commands run in plan order, each after the acceptance read", () => {
    const order = [
      "plan-issues.ts --accepted-since",
      "plan-spec.ts",
      "plan-issues.ts --decompose",
      "plan-deps.ts",
      "board-mirror.ts",
      "board-ready.ts",
    ];
    const at = order.map(cmd => steps.findIndex(s => runOf(s).includes(cmd)));
    expect(at.every(i => i >= 0), `every command is present: ${JSON.stringify(at)}`).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // Every step after the read is gated on it, so an edit to an accepted ADR
    // runs nothing.
    for (const i of at.slice(1)) expect(steps[i].if).toBe("steps.accepted.outputs.any == 'true'");
    expect(runOf(steps[at[5]])).toContain("--top-up");
    expect(runOf(steps[at[5]])).toContain("--write");
  });

  test("SC-2738: the board token reaches only the two board steps, through env", () => {
    // `RUNGATE_PROJECT_TOKEN` is never widened (ADR-013 row 5's note): the
    // issue, milestone and edge writes use the job's own GITHUB_TOKEN.
    const holders = steps
      .filter(s => JSON.stringify(s.env ?? {}).includes("secrets.RUNGATE_PROJECT_TOKEN"))
      .map(runOf);
    expect(holders).toHaveLength(2);
    expect(holders[0]).toContain("board-mirror.ts");
    expect(holders[1]).toContain("board-ready.ts");
    for (const s of steps) expect(runOf(s), "no secret is interpolated into a script line").not.toMatch(/\$\{\{\s*secrets\./);
    // plan-issues drops GH_TOKEN, so the issue writes get it as GITHUB_TOKEN.
    const decompose = steps.find(s => runOf(s).includes("plan-issues.ts --decompose"));
    expect(decompose.env.GITHUB_TOKEN).toBe("${{ secrets.GITHUB_TOKEN }}");
    expect(doc.permissions).toEqual({ contents: "read", issues: "write" });
  });
});
