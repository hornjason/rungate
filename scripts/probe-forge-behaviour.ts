#!/usr/bin/env bun
/**
 * Probe each forge behaviour this repository's tools rest on (#1910).
 *
 *   bun scripts/probe-forge-behaviour.ts [--only <id>] [--remote <name|path>]
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
 * id, written beside the line that relies on it. `citationViolations` compares
 * the two in both directions, and `test/probe-forge-behaviour.test.ts` runs it
 * over every file git tracks: a file citing an id the inventory lacks is red, and
 * so is a row whose named file does not carry its marker. A new dependency is
 * added by writing the marker and the row together.
 *
 * Each citation also names the text of the line that relies on the
 * behaviour, and the marker must stand within `BESIDE_LINES` of it. Delete or
 * rewrite that line and the marker left behind is red, so a citation cannot
 * outlive the code it describes (#2750 review).
 *
 * A row with no probe says why in `unprobedBecause`, reads `UNMEASURED` every
 * run, and is listed by the suite; today no row lacks one. Two rows open
 * throwaway pull requests to read (#2749): each closes them and deletes their
 * branches when it is done, a fixture it could not remove is named and is not a
 * pass, and the arm-time fixture's head carries a failing test so it can never
 * merge. In `forge-probe.yml` the job's token is read-only, so there those two
 * rows read UNMEASURED by name; run them where `gh` may open pull requests.
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

export interface Citation {
  path: string;
  /** Text found on the line that relies on the behaviour. */
  beside: string;
}

/** How far, in lines, a marker may stand from the line it cites. */
export const BESIDE_LINES = 3;

export interface ForgeBehaviour {
  /** Kebab-case, and what the marker in each citing file names. */
  id: string;
  /** What the tools assume, in one sentence. */
  assumes: string;
  /**
   * The files carrying this row's marker, exactly, each with the text of the
   * line that relies on the behaviour. The marker must stand beside it.
   */
  citedBy: readonly Citation[];
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
    citedBy: [{ path: "scripts/verify-merge-ref.ts", beside: "export const MAX_TIMEOUT_MS = " }],
  },
  {
    id: "ls-remote-absent-ref-exits-zero",
    assumes:
      "`git ls-remote <remote> refs/heads/<absent>` exits 0 with no output, so a branch that is gone is told " +
      "apart from a remote that was not read.",
    citedBy: [{ path: "scripts/verify-merge-ref.ts", beside: "remoteRead?: boolean;" }],
  },
  {
    id: "ls-remote-unreadable-exits-nonzero",
    assumes:
      "`git ls-remote` against a remote it cannot read exits non-zero (128 measured), so a failed read never " +
      "arrives as an empty answer.",
    citedBy: [{ path: "scripts/verify-merge-ref.ts", beside: "remoteRead?: boolean;" }],
  },
  {
    id: "head-ref-oid-frozen-at-merge",
    assumes:
      "a merged pull request's `headRefOid` stays at its merge-time head when its branch moves on, so a push " +
      "after the merge is visible as a difference.",
    citedBy: [{ path: "scripts/verify-merge-ref.ts", beside: "if (remoteHead && remoteHead !== prHead) {" }],
  },
  {
    id: "match-head-commit-checked-at-arm-time",
    assumes:
      "`gh pr merge --auto --match-head-commit` compares the pin when auto-merge is armed, not when the merge " +
      "fires, so it does not refuse a push that arrives after arming.",
    citedBy: [{ path: "scripts/verify-merge-ref.ts", beside: "push arriving after firing has no merge left to refuse." }],
  },
  {
    id: "dirty-pull-request-runs-no-checks",
    assumes: "a `pull_request` run checks out the merge ref, so a conflicted pull request runs no checks at all.",
    citedBy: [{ path: "reference/board-mechanics-worked-instances.md", beside: "Rebase first, then read the checks." }],
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
  /**
   * HEAD, the absent ref, the absent ref again, then HEAD again. A non-zero
   * exit for the absent ref means a changed behaviour only when it repeats,
   * with the same code, between two HEAD reads that both succeeded. Once is a
   * read that failed (#2750 review).
   */
  "ls-remote-absent-ref-exits-zero"?: { control: Ran; absent: Ran; absentAgain: Ran; controlAfter: Ran };
  "ls-remote-unreadable-exits-nonzero"?: { unreadable: Ran };
  "head-ref-oid-frozen-at-merge"?: { url: Ran; view: Ran; branch: Ran };
  "match-head-commit-checked-at-arm-time"?: ArmTimeObservation;
  "dirty-pull-request-runs-no-checks"?: DirtyObservation;
}

/**
 * A throwaway pull request, as built and removed (#2749). `built` is false
 * when any step of building it failed, and `failure` says which. `leftovers`
 * names every pull request or branch it could not remove: a fixture left
 * behind is reported by name, and the row is not a pass while it stands.
 */
export interface Fixture {
  built: boolean;
  failure: string;
  leftovers: string[];
}

/**
 * Auto-merge armed with the head pinned, then one more commit pushed. `armed`
 * is whether arming succeeded; `headAfter` and `armedAfter` are read once the
 * pull request's head is the second commit, or when the wait runs out.
 */
export interface ArmTimeObservation {
  fixture: Fixture;
  armed: boolean | null;
  secondHead: string;
  headAfter: string;
  armedAfter: boolean | null;
}

/**
 * Two pull requests into a throwaway base: one that conflicts with it and a
 * clean control. The runs are `pull_request` workflow runs on each head, read
 * once the control has some, so "none on the conflicted one" is told apart
 * from "no workflow runs on pull requests into this base at all".
 */
export interface DirtyObservation {
  fixture: Fixture;
  dirtyMergeable: string;
  dirtyRuns: number | null;
  cleanRuns: number | null;
}

/**
 * Does a remote's URL name `owner/name`? Its last two path segments, with any
 * `.git` dropped, so `https://github.com/o/n.git`, `git@github.com:o/n.git`
 * and a local `/path/to/o/n` all name `o/n`. The frozen-head row reads its
 * pull request from GitHub and its branch from the remote, and a remote that is
 * another repository's would compare one repository's head with another's
 * branch (#2750 review). The host is not compared: a probe, not a gate.
 */
export function remoteNamesRepo(url: string, repo: string): boolean {
  const parts = url.trim().replace(/\.git$/, "").replace(/\/+$/, "").split(/[/:]/).filter(Boolean);
  return parts.length >= 2 && `${parts[parts.length - 2]}/${parts[parts.length - 1]}`.toLowerCase() === repo.toLowerCase();
}

/** A child that was killed, or exited with no code, measured nothing. */
const finished = (r: Ran) => r.started && !r.killed && r.exit !== null;

export interface RowReading {
  id: string;
  reading: ForgeReading;
  detail: string;
}

const ranFully = (r: Ran) => r.started && !r.killed && r.exit === 0 && r.ms >= SLEEP_MS * 0.9;
const cutShort = (r: Ran) => r.started && r.killed && r.ms < SLEEP_MS / 2;
/**
 * A sleep that bun neither killed nor let run its length — it exited non-zero,
 * or returned early on its own — says nothing about bun's timeout (#2750
 * review): the `sleep` on PATH is not doing what the probe needs.
 */
const sleepMisbehaved = (r: Ran) => r.started && !r.killed && !ranFully(r);
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
      if (sleepMisbehaved(o.honoured) || sleepMisbehaved(o.window)) {
        return say("UNMEASURED", `${at}. A sleep that exits on its own before its time is not bun's timeout, so nothing was read.`);
      }
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
      if (!finished(o.absent)) {
        return say("UNMEASURED", `the absent-ref read ${describeRan(o.absent)}, so it measured nothing.`);
      }
      if (o.absent.exit !== 0) {
        const repeated =
          finished(o.absentAgain) && o.absentAgain.exit === o.absent.exit &&
          finished(o.controlAfter) && o.controlAfter.exit === 0 && o.controlAfter.out !== "";
        if (!repeated) {
          return say(
            "UNMEASURED",
            `an absent ref exited ${o.absent.exit} once, and the repeat (absent ref ${describeRan(o.absentAgain)}, HEAD ${describeRan(o.controlAfter)}) did not confirm it, so this reads as a failed read.`,
          );
        }
        return say("CHANGED", `an absent ref exited ${o.absent.exit} twice between two good HEAD reads, so a branch that is gone now reads as a remote that was not read.`);
      }
      if (o.absent.out !== "") {
        return say("CHANGED", `an absent ref exited 0 and printed \`${o.absent.out.split("\n")[0]}\`, so the empty answer no longer means gone.`);
      }
      return say("CONFIRMED", "the remote answered HEAD, and an absent ref exited 0 with no output.");
    }
    case "ls-remote-unreadable-exits-nonzero": {
      const o = obs[id];
      if (!o || !finished(o.unreadable)) {
        return say("UNMEASURED", `the read of a remote that does not exist ${o ? describeRan(o.unreadable) : "did not run"}, so it measured nothing.`);
      }
      if (o.unreadable.exit === 0) {
        return say("CHANGED", "a remote that does not exist exited 0, so a failed read now arrives as an empty answer.");
      }
      return say("CONFIRMED", `a remote that does not exist exited ${o.unreadable.exit}.`);
    }
    case "head-ref-oid-frozen-at-merge": {
      const o = obs[id];
      const f = MERGED_FIXTURE;
      if (!o || !o.url.started) return say("UNMEASURED", "`git` could not be started.");
      if (!finished(o.url) || o.url.exit !== 0 || !remoteNamesRepo(o.url.out, f.repo)) {
        return say(
          "UNMEASURED",
          `the remote is ${o.url.out === "" ? "unreadable" : `\`${o.url.out}\``}, not ${f.repo}, so its branch says nothing about ${f.repo}'s pull request.`,
        );
      }
      if (!o.view.started) return say("UNMEASURED", "`gh` could not be started.");
      if (o.view.exit !== 0 || o.view.out === "") {
        return say("UNMEASURED", `\`gh pr view ${f.pr}\` did not answer: not authenticated, or offline.`);
      }
      let pj: { state?: unknown; headRefOid?: unknown };
      try {
        pj = JSON.parse(o.view.out);
      } catch {
        return say("UNMEASURED", `\`gh pr view ${f.pr}\` returned something that is not JSON.`);
      }
      // `null` parses, and reading a field of it throws (#2750 review).
      if (pj === null || typeof pj !== "object") {
        return say("UNMEASURED", `\`gh pr view ${f.pr}\` returned JSON that is not an object.`);
      }
      if (pj.state !== "MERGED") return say("UNMEASURED", `the fixture, pull request ${f.pr}, reads ${String(pj.state)}, not MERGED.`);
      const head = typeof pj.headRefOid === "string" ? pj.headRefOid : "";
      if (head === "") return say("UNMEASURED", `\`gh pr view ${f.pr}\` answered with no \`headRefOid\`.`);
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
    case "match-head-commit-checked-at-arm-time": {
      const o = obs[id];
      if (!o) return say("UNMEASURED", "the throwaway pull request was not observed.");
      const left = fixtureNotPassing(o.fixture);
      if (left) return say("UNMEASURED", left);
      if (o.armed !== true) return say("UNMEASURED", "auto-merge could not be armed with the head pinned, so nothing about the pin was read.");
      if (o.secondHead === "" || o.headAfter !== o.secondHead) {
        return say("UNMEASURED", "the second commit did not become the pull request's head in time, so the push was not observed.");
      }
      if (o.armedAfter === true) {
        return say("CONFIRMED", `auto-merge armed with the head pinned stayed armed after a push moved the head to ${o.headAfter.slice(0, 8)}.`);
      }
      if (o.armedAfter === false) {
        return say("CHANGED", "a push after arming turned auto-merge off, so the pin is no longer checked only when auto-merge is armed.");
      }
      return say("UNMEASURED", "auto-merge's state after the push could not be read.");
    }
    case "dirty-pull-request-runs-no-checks": {
      const o = obs[id];
      if (!o) return say("UNMEASURED", "the throwaway pull requests were not observed.");
      const left = fixtureNotPassing(o.fixture);
      if (left) return say("UNMEASURED", left);
      if (o.dirtyMergeable !== "CONFLICTING") {
        return say("UNMEASURED", `the conflicting pull request reads \`${o.dirtyMergeable || "nothing"}\`, not CONFLICTING, so it was not a conflicted pull request.`);
      }
      if (o.cleanRuns === null || o.cleanRuns === 0) {
        return say("UNMEASURED", "the clean control started no pull_request run, so none on the conflicted one says nothing.");
      }
      if (o.dirtyRuns === null) return say("UNMEASURED", "the conflicted pull request's runs could not be read.");
      if (o.dirtyRuns === 0) {
        return say("CONFIRMED", `the clean control started ${o.cleanRuns} pull_request run(s), and the conflicted pull request started none.`);
      }
      return say("CHANGED", `the conflicted pull request started ${o.dirtyRuns} pull_request run(s), so a conflict no longer means no checks.`);
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
    for (const { path, beside } of b.citedBy) {
      const text = files[path];
      if (text === undefined) {
        out.push(`${b.id}: names ${path}, which was not read`);
        continue;
      }
      const lines = text.split("\n");
      const markerLines = lines.flatMap((l, i) => ([...l.matchAll(MARKER)].some((m) => m[1] === b.id) ? [i] : []));
      const besideLines = lines.flatMap((l, i) => (l.includes(beside) ? [i] : []));
      if (markerLines.length === 0) out.push(`${b.id}: ${path} carries no marker for it`);
      else if (besideLines.length === 0) out.push(`${b.id}: ${path} has no line containing \`${beside}\`, the line its marker cites`);
      else if (!markerLines.some((m) => besideLines.some((l) => Math.abs(m - l) <= BESIDE_LINES))) {
        out.push(`${b.id}: ${path}'s marker is not within ${BESIDE_LINES} lines of \`${beside}\``);
      }
    }
  }
  for (const [path, text] of Object.entries(files)) {
    for (const m of text.matchAll(MARKER)) {
      const row = known.get(m[1]);
      if (!row) out.push(`${path}: cites \`${m[1]}\`, which the inventory does not list`);
      else if (!row.citedBy.some((c) => c.path === path)) out.push(`${path}: cites \`${m[1]}\`, whose row does not name this file`);
    }
  }
  return out;
}

// ── the I/O half ────────────────────────────────────────────

const CALL_TIMEOUT_MS = 30_000;

function run(cmd: string[], timeoutMs = CALL_TIMEOUT_MS): Ran {
  const start = performance.now();
  try {
    // `killSignal` as scripts/verify-merge-ref.ts spawns, so the timeout row
    // measures the kill path the dependent takes (#2750 review).
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs, killSignal: "SIGKILL" });
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

/** A value-taking flag given with no value after it; `null` when every one has its value. */
function flagMissingValue(argv: string[]): string | null {
  for (const name of ["only", "remote"]) {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0 && (i + 1 >= argv.length || argv[i + 1].startsWith("--"))) return `--${name}`;
  }
  return null;
}

function observe(id: string, remote: string): Observations {
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
          absentAgain: run(["git", "ls-remote", remote, `refs/heads/rungate-forge-probe-absent-${crypto.randomUUID()}`]),
          controlAfter: run(["git", "ls-remote", remote, "HEAD"]),
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
          url: run(["git", "ls-remote", "--get-url", remote]),
          view: run(["gh", "pr", "view", MERGED_FIXTURE.pr, "--repo", MERGED_FIXTURE.repo, "--json", "state,headRefOid"]),
          branch: run(["git", "ls-remote", remote, `refs/heads/${MERGED_FIXTURE.branch}`]),
        },
      };
    case "match-head-commit-checked-at-arm-time":
      return { [id]: observeArmTime() };
    case "dirty-pull-request-runs-no-checks":
      return { [id]: observeDirty() };
  }
  return {};
}

// ── the throwaway pull requests (#2749) ─────────────────────

/** The repository the throwaway pull requests are opened in: the merged fixture's. */
const FIXTURE_REPO = MERGED_FIXTURE.repo;

/** How long a fixture waits for GitHub to settle a pull request, and how often it looks. */
const SETTLE_MS = 180_000;
const POLL_MS = 5_000;

const FIXTURE_BODY =
  "A throwaway pull request opened by `scripts/probe-forge-behaviour.ts` (#2749). " +
  "It is closed and its branch deleted by the probe that opened it. Never merge it.";

/**
 * The arm-time fixture's first commit: a test that always fails. A required
 * check therefore stays red, so the pull request can never merge, even when
 * the probe dies before it closes it (Jason, 2026-11-24, #2749).
 */
const NEVER_MERGES =
  "// Forge probe fixture (#2749). It fails on purpose, so this pull request can never merge.\n" +
  'import { test } from "bun:test";\n' +
  'test("forge probe fixture never merges", () => {\n  throw new Error("forge probe fixture: never merge");\n});\n';

/** Why a fixture's row cannot read CONFIRMED or CHANGED, or "" when it can. */
function fixtureNotPassing(f: Fixture): string {
  if (f.leftovers.length > 0) {
    return `the fixture could not be removed: ${f.leftovers.join(", ")}. Remove it by hand; a fixture left behind is not a pass.`;
  }
  if (!f.built) return `the fixture was not built: ${f.failure || "no reason recorded"}.`;
  return "";
}

/** A field of a parsed JSON reply, or "" when it is absent or not a string. */
function field(json: unknown, ...path: string[]): string {
  let v: unknown = json;
  for (const k of path) v = v !== null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

/** `gh` with a JSON reply, or `null` when it did not finish, failed, or answered with something that is not JSON. */
function ghJson(args: string[]): unknown {
  const r = run(["gh", ...args]);
  if (!finished(r) || r.exit !== 0) return null;
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
}

/**
 * Builds throwaway branches and pull requests through the API, and removes
 * every one it built. Nothing touches the local checkout.
 */
class Throwaway {
  readonly tag = `rungate-forge-probe-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  failure = "";
  private readonly branches: string[] = [];
  private readonly pulls: string[] = [];

  private fail(why: string): false {
    if (this.failure === "") this.failure = why;
    return false;
  }

  mainHead(): string {
    const sha = field(ghJson(["api", `repos/${FIXTURE_REPO}/git/ref/heads/main`]), "object", "sha");
    if (sha === "") this.fail("main's head could not be read: not authenticated, or offline");
    return sha;
  }

  branch(name: string, sha: string): boolean {
    const made = field(ghJson(["api", "-X", "POST", `repos/${FIXTURE_REPO}/git/refs`, "-f", `ref=refs/heads/${name}`, "-f", `sha=${sha}`]), "ref");
    if (made === "") return this.fail(`branch ${name} could not be created`);
    this.branches.push(name);
    return true;
  }

  /** Commit one new file onto `branch`; the new commit's sha, or "". */
  commit(branch: string, path: string, content: string): string {
    const reply = ghJson([
      "api", "-X", "PUT", `repos/${FIXTURE_REPO}/contents/${path}`,
      "-f", "message=Forge probe fixture (#2749)",
      "-f", `content=${Buffer.from(content).toString("base64")}`,
      "-f", `branch=${branch}`,
    ]);
    const sha = field(reply, "commit", "sha");
    if (sha === "") this.fail(`a commit to ${branch} could not be made`);
    return sha;
  }

  /** Open a pull request; its number, or "". */
  open(head: string, base: string): string {
    const reply = ghJson([
      "api", "-X", "POST", `repos/${FIXTURE_REPO}/pulls`,
      "-f", `title=Forge probe fixture, never merge (${this.tag})`,
      "-f", `head=${head}`, "-f", `base=${base}`, "-f", `body=${FIXTURE_BODY}`,
    ]);
    const n = field(reply, "number");
    if (n === "") {
      this.fail(`a pull request from ${head} into ${base} could not be opened`);
      return "";
    }
    this.pulls.push(n);
    return n;
  }

  /** Close every pull request and delete every branch; what could not be removed, by name. */
  cleanup(): string[] {
    const left: string[] = [];
    for (const n of this.pulls) {
      run(["gh", "pr", "close", n, "--repo", FIXTURE_REPO]);
      if (field(ghJson(["pr", "view", n, "--repo", FIXTURE_REPO, "--json", "state"]), "state") !== "CLOSED") left.push(`pull request #${n}`);
    }
    for (const b of this.branches) {
      run(["gh", "api", "-X", "DELETE", `repos/${FIXTURE_REPO}/git/refs/heads/${b}`]);
      // Gone only when GitHub says so. A read that failed is not a 404.
      const after = run(["gh", "api", `repos/${FIXTURE_REPO}/git/ref/heads/${b}`]);
      if (after.exit === 0 || !after.out.includes("Not Found")) left.push(`branch ${b}`);
    }
    return left;
  }
}

/** Poll `read` until `done` holds or the wait runs out; the last value read. */
function settle<T>(read: () => T, done: (v: T) => boolean, ms = SETTLE_MS): T {
  const until = Date.now() + ms;
  let v = read();
  while (!done(v) && Date.now() < until) {
    Bun.sleepSync(POLL_MS);
    v = read();
  }
  return v;
}

function observeArmTime(): ArmTimeObservation {
  const t = new Throwaway();
  const o: ArmTimeObservation = { fixture: { built: false, failure: "", leftovers: [] }, armed: null, secondHead: "", headAfter: "", armedAfter: null };
  try {
    const base = t.mainHead();
    const head = `${t.tag}-arm`;
    if (base === "" || !t.branch(head, base)) return o;
    const first = t.commit(head, `test/${t.tag}.test.ts`, NEVER_MERGES);
    const pr = first === "" ? "" : t.open(head, "main");
    if (pr === "") return o;
    const view = () => ghJson(["pr", "view", pr, "--repo", FIXTURE_REPO, "--json", "headRefOid,autoMergeRequest"]);
    const arm = run(["gh", "pr", "merge", pr, "--repo", FIXTURE_REPO, "--squash", "--auto", "--match-head-commit", first]);
    const armedView = settle(view, (v) => field(v, "autoMergeRequest", "enabledAt") !== "", 30_000);
    o.armed = arm.exit === 0 && field(armedView, "autoMergeRequest", "enabledAt") !== "";
    if (!o.armed) return o;
    o.secondHead = t.commit(head, `test/${t.tag}-second.txt`, "the commit pushed after arming\n");
    if (o.secondHead === "") return o;
    const after = settle(view, (v) => field(v, "headRefOid") === o.secondHead, 60_000);
    o.headAfter = field(after, "headRefOid");
    o.armedAfter = after === null ? null : field(after, "autoMergeRequest", "enabledAt") !== "";
    o.fixture.built = true;
    return o;
  } finally {
    o.fixture.failure = t.failure;
    o.fixture.leftovers = t.cleanup();
  }
}

function observeDirty(): DirtyObservation {
  const t = new Throwaway();
  const o: DirtyObservation = { fixture: { built: false, failure: "", leftovers: [] }, dirtyMergeable: "", dirtyRuns: null, cleanRuns: null };
  const runsOn = (sha: string): number | null => {
    const n = field(ghJson(["api", `repos/${FIXTURE_REPO}/actions/runs?event=pull_request&head_sha=${sha}`]), "total_count");
    return n === "" ? null : Number(n);
  };
  try {
    const main = t.mainHead();
    const base = `${t.tag}-base`;
    const dirty = `${t.tag}-dirty`;
    const clean = `${t.tag}-clean`;
    if (main === "" || !t.branch(base, main) || !t.branch(dirty, main)) return o;
    // Both sides add the same new file with different contents: a conflict
    // that no rebase of main can resolve or race.
    const dirtyHead = t.commit(dirty, `${t.tag}.txt`, "the conflicting side\n");
    const baseHead = dirtyHead === "" ? "" : t.commit(base, `${t.tag}.txt`, "the base side\n");
    if (baseHead === "" || !t.branch(clean, baseHead)) return o;
    const cleanHead = t.commit(clean, `${t.tag}-clean.txt`, "the clean control\n");
    if (cleanHead === "") return o;
    const dirtyPr = t.open(dirty, base);
    if (dirtyPr === "" || t.open(clean, base) === "") return o;
    const mergeable = () => field(ghJson(["pr", "view", dirtyPr, "--repo", FIXTURE_REPO, "--json", "mergeable"]), "mergeable");
    o.cleanRuns = settle(() => runsOn(cleanHead), (n) => n !== null && n > 0);
    o.dirtyMergeable = settle(mergeable, (m) => m !== "" && m !== "UNKNOWN", 60_000);
    o.dirtyRuns = runsOn(dirtyHead);
    o.fixture.built = true;
    return o;
  } finally {
    o.fixture.failure = t.failure;
    o.fixture.leftovers = t.cleanup();
  }
}

export function main(argv: string[]): number {
  // Given last, `--only` would read as absent and run every row, and
  // `--remote` would fall back to origin (#2750 review).
  const missing = flagMissingValue(argv);
  if (missing !== null) {
    console.error(`UNMEASURED: ${missing} needs a value after it.`);
    return REFUSE_EXIT;
  }
  const only = arg("only", argv);
  const remote = arg("remote", argv) ?? "origin";
  const rows = only === undefined ? FORGE_BEHAVIOURS : FORGE_BEHAVIOURS.filter((b) => b.id === only);
  if (rows.length === 0) {
    console.error(`UNMEASURED: no behaviour named \`${only}\`. Known: ${FORGE_BEHAVIOURS.map((b) => b.id).join(", ")}.`);
    return REFUSE_EXIT;
  }
  let allConfirmed = true;
  for (const row of rows) {
    const r = forgeBehaviourReading(row.id, row.unprobedBecause ? {} : observe(row.id, remote));
    console.log(`${r.reading} ${r.id}: ${r.detail}`);
    if (r.reading !== "CONFIRMED") {
      allConfirmed = false;
      console.log(`  assumed: ${row.assumes}`);
      console.log(`  relied on by: ${row.citedBy.map((c) => c.path).join(", ")}`);
    }
  }
  return allConfirmed ? 0 : REFUSE_EXIT;
}

if (import.meta.main) process.exit(main(Bun.argv.slice(2)));
