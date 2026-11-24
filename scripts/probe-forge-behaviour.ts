#!/usr/bin/env bun
/**
 * Probe each forge behaviour this repository's tools rest on (#1910).
 *
 *   bun scripts/probe-forge-behaviour.ts [--only <id>] [--remote <name>] [--repo owner/name]
 *
 * Several tools here are correct only while GitHub, git or bun behaves a
 * particular way. Their tests plant a fixture that ASSUMES the behaviour, so if
 * the behaviour changed every suite would stay green and the tool would go on
 * reporting confidently about a mechanism it no longer reaches. This script
 * reads each behaviour against the real thing.
 *
 * ## The three readings
 *
 * | Reading      | Meaning                                                        |
 * |--------------|----------------------------------------------------------------|
 * | `CONFIRMED`  | the behaviour was read, and it is what the tools assume        |
 * | `CHANGED`    | the behaviour was read, and it is not — a tool names it below  |
 * | `UNMEASURED` | nothing was read: no credential, no network, no fixture, or no probe built yet |
 *
 * Exit 0 only when every row it ran is `CONFIRMED`. Anything else exits through
 * `REFUSE_EXIT`, `CHANGED` included: a bun upgrade that closes the timeout
 * window is good news, and it still means a constant should move. This is a
 * question somebody asks by hand, or through `forge-probe.yml`, never a gate.
 *
 * ## The inventory is the list, and the suite holds the tree to it
 *
 * `FORGE_BEHAVIOURS` names every behaviour and the files that rely on it. Each
 * of those files carries a marker, the words `forge-behaviour:` and the row's
 * id, beside the line that relies on it. `citationViolations` compares the two
 * in both directions, and `test/probe-forge-behaviour.test.ts` runs it over the
 * tree: a file citing an id the inventory lacks is red, and so is a row whose
 * named file does not carry its marker. A new dependency is added by writing
 * the marker and the row together.
 *
 * A row with no probe says why in `unprobedBecause`, reads `UNMEASURED` every
 * run, and is listed by the suite. Two rows need a throwaway pull request to
 * read and have none yet (#2749).
 *
 * ## Properties the test asserts
 *
 * 1. Every refusal exits through `REFUSE_EXIT`, declared exactly once; the test
 *    runs each refusing case against a mutant with it set to 0.
 * 2. No relative imports, so the mutant loads from a temp directory.
 * 3. `gh` and `git` are real subprocesses found on PATH, so a planted `gh`
 *    drives the same call the script makes against GitHub.
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** The one exit code every refusal travels through. */
export const REFUSE_EXIT = 1;

export type ForgeReading = "CONFIRMED" | "CHANGED" | "UNMEASURED";

export interface ForgeBehaviour {
  /** Kebab-case, and what the marker in each citing file names. */
  id: string;
  /** What the tools assume, in one sentence. */
  assumes: string;
  /** Repository-relative files carrying this row's marker, exactly. */
  citedBy: readonly string[];
  /** Why there is no probe yet. Absent when one exists. */
  unprobedBecause?: string;
}

/**
 * The pull request `head-ref-oid-frozen-at-merge` reads. #1847 merged at
 * `94a6e7de`, and two more commits were pushed to its branch afterwards, so its
 * branch and its recorded head differ for as long as the branch exists. The
 * branch is a fixture: deleting it turns this row UNMEASURED, not CONFIRMED.
 */
export const MERGED_FIXTURE = {
  repo: "hornjason/rungate",
  pr: "1847",
  branch: "rg/1842-stage-g",
  mergeTimeHead: "94a6e7deea501859206dfe207bb634e3cfabdae5",
} as const;

export const FORGE_BEHAVIOURS: readonly ForgeBehaviour[] = [
  {
    id: "bun-spawn-timeout-window",
    assumes:
      "`Bun.spawnSync` honours a `timeout` of 2**31 - 1 ms, and kills the child within milliseconds at 2**31, " +
      "so `MAX_TIMEOUT_MS` is the largest bound measured to behave.",
    citedBy: ["scripts/verify-merge-ref.ts"],
  },
  {
    id: "ls-remote-absent-ref-exits-zero",
    assumes:
      "`git ls-remote <remote> refs/heads/<absent>` exits 0 with no output, so a branch that is gone is told " +
      "apart from a remote that was not read.",
    citedBy: ["scripts/verify-merge-ref.ts"],
  },
  {
    id: "ls-remote-unreadable-exits-nonzero",
    assumes:
      "`git ls-remote` against a remote it cannot read exits non-zero (128 measured), so a failed read never " +
      "arrives as an empty answer.",
    citedBy: ["scripts/verify-merge-ref.ts"],
  },
  {
    id: "head-ref-oid-frozen-at-merge",
    assumes:
      "a merged pull request's `headRefOid` stays at its merge-time head when its branch moves on, so a push " +
      "after the merge is visible as a difference.",
    citedBy: ["scripts/verify-merge-ref.ts"],
  },
  {
    id: "match-head-commit-checked-at-arm-time",
    assumes:
      "`gh pr merge --auto --match-head-commit` compares the pin when auto-merge is armed, not when the merge " +
      "fires, so it does not refuse a push that arrives after arming.",
    citedBy: ["scripts/verify-merge-ref.ts"],
    unprobedBecause: "reading it needs a throwaway pull request armed and then pushed to (#2749)",
  },
  {
    id: "dirty-pull-request-runs-no-checks",
    assumes: "a `pull_request` run checks out the merge ref, so a conflicted pull request runs no checks at all.",
    citedBy: ["reference/board-mechanics-worked-instances.md"],
    unprobedBecause: "reading it needs a throwaway pull request that conflicts with main (#2749)",
  },
];

// ── what a probe observed ───────────────────────────────────

/** One subprocess, as observed. `started: false` is a tool that is not there. */
export interface Ran {
  started: boolean;
  exit: number | null;
  out: string;
  killed: boolean;
  ms: number;
}

/** How long the timeout probe's child sleeps. */
export const SLEEP_MS = 1000;

export interface Observations {
  "bun-spawn-timeout-window"?: { honoured: Ran; window: Ran };
  "ls-remote-absent-ref-exits-zero"?: { control: Ran; absent: Ran };
  "ls-remote-unreadable-exits-nonzero"?: { unreadable: Ran };
  "head-ref-oid-frozen-at-merge"?: { view: Ran; branch: Ran };
}

export interface RowReading {
  id: string;
  reading: ForgeReading;
  detail: string;
}

const ranFully = (r: Ran) => r.started && !r.killed && r.exit === 0 && r.ms >= SLEEP_MS * 0.9;
const cutShort = (r: Ran) => r.started && r.killed && r.ms < SLEEP_MS / 2;
const describeRan = (r: Ran) =>
  !r.started ? "did not start" : r.killed ? `was killed after ${Math.round(r.ms)}ms` : `exited ${r.exit} after ${Math.round(r.ms)}ms`;

/** The pure half: what one row's observation means. */
export function forgeBehaviourReading(id: string, obs: Observations): RowReading {
  const row = FORGE_BEHAVIOURS.find((b) => b.id === id);
  const say = (reading: ForgeReading, detail: string): RowReading => ({ id, reading, detail });
  if (!row) return say("UNMEASURED", `no behaviour named \`${id}\` is in the inventory.`);
  if (row.unprobedBecause) return say("UNMEASURED", `no probe: ${row.unprobedBecause}.`);

  switch (id) {
    case "bun-spawn-timeout-window": {
      const o = obs[id];
      if (!o || !o.honoured.started || !o.window.started) {
        return say("UNMEASURED", "`sleep` could not be started, so no timeout was observed.");
      }
      const at = `a ${SLEEP_MS}ms sleep with timeout 2**31 - 1 ${describeRan(o.honoured)}; with 2**31 it ${describeRan(o.window)}`;
      if (!ranFully(o.honoured)) {
        return say("CHANGED", `${at}. 2**31 - 1 is no longer honoured, so \`MAX_TIMEOUT_MS\` admits a bound that misbehaves.`);
      }
      if (!cutShort(o.window)) {
        return say("CHANGED", `${at}. The window above 2**31 has moved or closed, so \`MAX_TIMEOUT_MS\` may be stricter than it needs to be.`);
      }
      return say("CONFIRMED", `${at}.`);
    }
    case "ls-remote-absent-ref-exits-zero": {
      const o = obs[id];
      if (!o || !o.control.started) return say("UNMEASURED", "`git` could not be started.");
      if (o.control.exit !== 0 || o.control.out === "") {
        return say(
          "UNMEASURED",
          `the remote was not read (\`git ls-remote <remote> HEAD\` exited ${o.control.exit} with ${o.control.out === "" ? "no" : "some"} output), ` +
            "so an absent ref could not be told apart from a failed read.",
        );
      }
      if (!o.absent.started) return say("UNMEASURED", "`git` could not be started for the absent ref.");
      if (o.absent.exit !== 0) {
        return say("CHANGED", `an absent ref exited ${o.absent.exit}, so a branch that is gone now reads as a remote that was not read.`);
      }
      if (o.absent.out !== "") {
        return say("CHANGED", `an absent ref exited 0 and printed \`${o.absent.out.split("\n")[0]}\`, so the empty answer no longer means gone.`);
      }
      return say("CONFIRMED", "the remote answered HEAD, and an absent ref exited 0 with no output.");
    }
    case "ls-remote-unreadable-exits-nonzero": {
      const o = obs[id];
      if (!o || !o.unreadable.started) return say("UNMEASURED", "`git` could not be started.");
      if (o.unreadable.exit === 0) {
        return say("CHANGED", "a remote that does not exist exited 0, so a failed read now arrives as an empty answer.");
      }
      return say("CONFIRMED", `a remote that does not exist exited ${o.unreadable.exit}.`);
    }
    case "head-ref-oid-frozen-at-merge": {
      const o = obs[id];
      const f = MERGED_FIXTURE;
      if (!o || !o.view.started) return say("UNMEASURED", "`gh` could not be started.");
      if (o.view.exit !== 0 || o.view.out === "") {
        return say("UNMEASURED", `\`gh pr view ${f.pr}\` did not answer: not authenticated, or offline.`);
      }
      let pj: { state?: unknown; headRefOid?: unknown };
      try {
        pj = JSON.parse(o.view.out);
      } catch {
        return say("UNMEASURED", `\`gh pr view ${f.pr}\` returned something that is not JSON.`);
      }
      if (pj.state !== "MERGED") return say("UNMEASURED", `the fixture, pull request ${f.pr}, reads ${String(pj.state)}, not MERGED.`);
      const head = typeof pj.headRefOid === "string" ? pj.headRefOid : "";
      if (!o.branch.started || o.branch.exit !== 0) {
        return say("UNMEASURED", `\`git ls-remote\` did not read the fixture branch \`${f.branch}\`.`);
      }
      const branchHead = o.branch.out.split(/\s+/)[0] ?? "";
      if (branchHead === "") {
        return say("UNMEASURED", `the fixture branch \`${f.branch}\` is gone, so frozen and following look the same. Rebuild the fixture.`);
      }
      if (branchHead === f.mergeTimeHead) {
        return say("UNMEASURED", `the fixture branch \`${f.branch}\` is back at the merge-time head, so frozen and following look the same.`);
      }
      if (head === f.mergeTimeHead) {
        return say("CONFIRMED", `pull request ${f.pr} still records ${head.slice(0, 8)} while its branch is at ${branchHead.slice(0, 8)}.`);
      }
      if (head === branchHead) {
        return say("CHANGED", `pull request ${f.pr}'s \`headRefOid\` now follows its branch (${head.slice(0, 8)}), so a push after a merge can no longer be seen.`);
      }
      return say("CHANGED", `pull request ${f.pr}'s \`headRefOid\` is \`${head}\`: neither its merge-time head nor its branch.`);
    }
  }
  return say("UNMEASURED", `\`${id}\` names no unprobed reason and has no reading. Add one, or say why there is none.`);
}

// ── the tree held to the inventory ──────────────────────────

const MARKER = /forge-behaviour: ([a-z0-9][a-z0-9-]*)/g;

/**
 * Every disagreement between the inventory and the files' markers. `files`
 * maps a repository-relative path to its text; a path a row names that is not
 * in it is reported, never skipped.
 */
export function citationViolations(inventory: readonly ForgeBehaviour[], files: Record<string, string>): string[] {
  const out: string[] = [];
  const known = new Map(inventory.map((b) => [b.id, b]));
  for (const b of inventory) {
    for (const path of b.citedBy) {
      const text = files[path];
      if (text === undefined) out.push(`${b.id}: names ${path}, which was not read`);
      else if (![...text.matchAll(MARKER)].some((m) => m[1] === b.id)) out.push(`${b.id}: ${path} carries no marker for it`);
    }
  }
  for (const [path, text] of Object.entries(files)) {
    for (const m of text.matchAll(MARKER)) {
      const row = known.get(m[1]);
      if (!row) out.push(`${path}: cites \`${m[1]}\`, which the inventory does not list`);
      else if (!row.citedBy.includes(path)) out.push(`${path}: cites \`${m[1]}\`, whose row does not name this file`);
    }
  }
  return out;
}

// ── the I/O half ────────────────────────────────────────────

const CALL_TIMEOUT_MS = 30_000;

function run(cmd: string[], timeoutMs = CALL_TIMEOUT_MS): Ran {
  const start = performance.now();
  try {
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    return {
      started: true,
      exit: r.exitCode,
      out: new TextDecoder().decode(r.stdout ?? new Uint8Array()).trim(),
      killed: r.signalCode != null || r.exitCode === null,
      ms: performance.now() - start,
    };
  } catch {
    return { started: false, exit: null, out: "", killed: false, ms: performance.now() - start };
  }
}

function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function observe(id: string, remote: string, repo: string): Observations {
  switch (id) {
    case "bun-spawn-timeout-window":
      return {
        [id]: {
          honoured: run(["sleep", String(SLEEP_MS / 1000)], 2 ** 31 - 1),
          window: run(["sleep", String(SLEEP_MS / 1000)], 2 ** 31),
        },
      };
    case "ls-remote-absent-ref-exits-zero":
      return {
        [id]: {
          control: run(["git", "ls-remote", remote, "HEAD"]),
          absent: run(["git", "ls-remote", remote, `refs/heads/rungate-forge-probe-absent-${crypto.randomUUID()}`]),
        },
      };
    case "ls-remote-unreadable-exits-nonzero": {
      const dir = mkdtempSync(join(tmpdir(), "rg-forge-probe-"));
      try {
        return { [id]: { unreadable: run(["git", "ls-remote", join(dir, "no-such-remote")]) } };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    case "head-ref-oid-frozen-at-merge":
      return {
        [id]: {
          view: run(["gh", "pr", "view", MERGED_FIXTURE.pr, "--repo", repo, "--json", "state,headRefOid"]),
          branch: run(["git", "ls-remote", remote, `refs/heads/${MERGED_FIXTURE.branch}`]),
        },
      };
  }
  return {};
}

export function main(argv: string[]): number {
  const only = arg("only", argv);
  const remote = arg("remote", argv) ?? "origin";
  const repo = arg("repo", argv) ?? MERGED_FIXTURE.repo;
  const rows = only === undefined ? FORGE_BEHAVIOURS : FORGE_BEHAVIOURS.filter((b) => b.id === only);
  if (rows.length === 0) {
    console.error(`UNMEASURED: no behaviour named \`${only}\`. Known: ${FORGE_BEHAVIOURS.map((b) => b.id).join(", ")}.`);
    return REFUSE_EXIT;
  }
  let allConfirmed = true;
  for (const row of rows) {
    const r = forgeBehaviourReading(row.id, row.unprobedBecause ? {} : observe(row.id, remote, repo));
    console.log(`${r.reading} ${r.id}: ${r.detail}`);
    if (r.reading !== "CONFIRMED") {
      allConfirmed = false;
      console.log(`  assumed: ${row.assumes}`);
      console.log(`  relied on by: ${row.citedBy.join(", ")}`);
    }
  }
  return allConfirmed ? 0 : REFUSE_EXIT;
}

if (import.meta.main) process.exit(main(Bun.argv.slice(2)));
