/**
 * #1648: an archived run must not decide a live gate.
 *
 * Two layers, because the predicate alone proves nothing about the hook. The
 * first describes `isRunDirectory`; the second plants a work directory on
 * disk, runs the real hook against it, and asserts on what the hook DECIDED.
 *
 * ## What was broken to prove these can fail
 *
 * `bash /tmp/rg-lock-battery/battery.sh`, 2026-10-29:
 *
 *   baseline                              0 red / 9 pass
 *   isRunDirectory always true            5 red / 4 pass
 *   the hook drops the filter             3 red / 6 pass
 *   restored                              0 red / 9 pass
 *
 * The second row is the one that matters: it is the line actually removed to
 * create #1648, and it reddens the end-to-end cases rather than only the unit
 * ones.
 *
 * **Run the battery with `(cd <root> && bun test …)`, never `bun --cwd <root>
 * test`.** The second form resolves `test` as the package SCRIPT, so
 * `posttest` fires and `sync-sc-status` ticks real checkboxes in `specs/`.
 * It did, eight times, during the battery for `lib/board-mirror.ts` — three
 * criteria in the convergence spec among them, one of which (CRC-B4) #1591
 * records as never having run in CI at all.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRunDirectory } from "../lib/active-workflow";

const HOOK = join(import.meta.dir, "..", "hooks", "VerifyPhaseLock.hook.ts");
const FIND_WORKFLOW = join(import.meta.dir, "..", "hooks", "lib", "findWorkflow.ts");

/**
 * Ask the SHARED discovery module which run it picks, in a subprocess.
 *
 * `findWorkflow.ts` resolves `RUNGATE_WORK_DIR` at module load, so the env
 * has to be set before the import — an in-process call would read this
 * suite's environment and silently measure the wrong directory.
 */
async function discoveredSlug(runs: { dir: string; phase: string }[]): Promise<string | null> {
  const work = mkdtempSync(join(tmpdir(), "rg-verify-lock-"));
  try {
    for (const r of runs) {
      const d = join(work, ...r.dir.split("/"));
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "workflow-state.json"), JSON.stringify({ phase: r.phase }));
    }
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        `const { findWorkflowForIssue } = await import(${JSON.stringify(FIND_WORKFLOW)});
         const r = findWorkflowForIssue();
         console.log(JSON.stringify(r ? r.slug : null));`,
      ],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, RUNGATE_WORK_DIR: work } },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return JSON.parse(out.trim() || "null");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const CREATE = "gh issue create --repo o/r --title t --body b";

/** Plant a work dir and ask the real hook what it decides about `cmd`. */
async function hookDecision(
  runs: { dir: string; phase: string }[],
  cmd = CREATE,
): Promise<{
  blocked: boolean;
  blockedByLock: boolean;
  blockedByArbiter: boolean;
  text: string;
}> {
  const work = mkdtempSync(join(tmpdir(), "rg-verify-lock-"));
  let text: string;
  try {
    // Inside the `try`, because `mkdtempSync` has already created the
    // directory by this point: a throw in the planting loop leaked it when
    // the `try` started below the loop instead of above it. Raised on #1648
    // round 5, against a commit message that claimed "every exit path".
    for (const r of runs) {
      const d = join(work, ...r.dir.split("/"));
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "workflow-state.json"), JSON.stringify({ phase: r.phase }));
    }
    const proc = Bun.spawn(["bun", HOOK], {
      stdin: new TextEncoder().encode(
        JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd } }),
      ),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, RUNGATE_WORK_DIR: work },
    });
    text = await new Response(proc.stdout).text();
    await proc.exited;
  } finally {
    // Raised on #1648: five calls, five `rg-verify-lock-*` directories left
    // under the OS temp dir on every run — 40 of them on the author's machine.
    // In a `finally`, because a spawn or a read that throws leaves the scratch
    // behind on exactly the path this was written to close.
    rmSync(work, { recursive: true, force: true });
  }
  // The hook has TWO gates that each emit `"decision":"block"` — the VERIFY
  // lock this PR is about, and `filingGate`'s adjudication, which runs in
  // every phase. A bare read of the string cannot say which one answered, so
  // it is read per gate off the prefix each refusal names itself with.
  //
  // Not hypothetical: an assertion that filingGate stays quiet was tried here
  // and went red, because it refuses this very command some of the time. That
  // is the whole point — every case must read ONLY its own gate, and no case
  // may assert anything about the other one, or this suite inherits the
  // network-dependent behaviour of a gate it is not testing.
  //
  // `blocked` is kept for the text it reports on a failure; nothing asserts
  // on it.
  return {
    blocked: text.includes('"decision":"block"'),
    blockedByLock: text.includes("[VerifyPhaseLock]"),
    blockedByArbiter: text.includes("[FindingArbiter]"),
    text,
  };
}

describe("#1648: isRunDirectory", () => {
  test("an ordinary run slug is a run", () => {
    expect(isRunDirectory("pai-harness-892")).toBe(true);
    expect(isRunDirectory("agentgrit-311")).toBe(true);
  });

  test(".archive is not — it is the work dir's own bookkeeping", () => {
    expect(isRunDirectory(".archive")).toBe(false);
  });

  test("any hidden entry is not, because a list of one name is a list someone must extend", () => {
    expect(isRunDirectory(".tmp")).toBe(false);
    expect(isRunDirectory(".anything-added-later")).toBe(false);
  });

  test("a dot INSIDE the name is still a run — only a leading dot hides it", () => {
    expect(isRunDirectory("repo.name-12")).toBe(true);
  });
});

describe("#1648: the hook, end to end against a planted work directory", () => {
  test("a LIVE run in VERIFY still blocks — the gate is not disabled", async () => {
    // The control. Without this the fix below could have switched the whole
    // lock off and every case would still read as a pass.
    const { blockedByLock, text } = await hookDecision([{ dir: "proj-1", phase: "VERIFY" }]);
    expect(blockedByLock).toBe(true);
    expect(text).toContain("VerifyPhaseLock");
  });

  test("an ARCHIVED run in VERIFY does not block", async () => {
    // Exactly #1648: `.archive/<slug>/workflow-state.json` matches the nested
    // scan, so a run that finished on 21 October was deciding the gate.
    const { blockedByLock } = await hookDecision([
      { dir: ".archive/proj-892", phase: "VERIFY" },
    ]);
    expect(blockedByLock).toBe(false);
  });

  test("a hidden directory INSIDE a live run does not decide the lock either", async () => {
    // Raised on #1648 by the reviewer. The predicate started out on the
    // outer `readdirSync` only, so the same stale-bookkeeping defect sat
    // one level deeper: `proj-169/.archive/workflow-state.json` is read by
    // the nested scan, and being written last it outranks the live run by
    // mtime. Red before `isRunDirectory(sub.name)` was added to that loop.
    const { blockedByLock } = await hookDecision([
      { dir: "proj-169", phase: "DONE" },
      { dir: "proj-169/.archive", phase: "VERIFY" },
    ]);
    expect(blockedByLock).toBe(false);
  });

  test("an archived VERIFY alongside a live non-VERIFY run does not block", async () => {
    // The real shape on this machine: three live runs, none in VERIFY, and
    // the newest file of all sitting in `.archive` at VERIFY. The archived
    // one won because the scan ranks by mtime.
    const { blockedByLock } = await hookDecision([
      { dir: "proj-169", phase: "DONE" },
      { dir: ".archive/proj-892", phase: "VERIFY" },
    ]);
    expect(blockedByLock).toBe(false);
  });

  test("a live VERIFY run blocks even when an archived run is newer", async () => {
    // The other direction, so the fix cannot be "ignore VERIFY when anything
    // is archived". The live run is written FIRST and is therefore older.
    const { blockedByLock } = await hookDecision([
      { dir: "proj-1", phase: "VERIFY" },
      { dir: ".archive/proj-892", phase: "DONE" },
    ]);
    expect(blockedByLock).toBe(true);
  });

  test("no work directory entries at all does not block", async () => {
    expect((await hookDecision([])).blockedByLock).toBe(false);
  });
});

describe("#1648: hooks/lib/findWorkflow.ts — the same scan, one more hook", () => {
  // Raised on #1648 round 5, and correct. `findWorkflow.ts` repeats the
  // two-level scan with an mtime fallback, so fixing only VerifyPhaseLock
  // left the archived run deciding it too.
  //
  // Its one importer is `CommitEnforcement.hook.ts`. An earlier version of
  // this comment also named IssueCloseGuard and AutoVerifyGate and was
  // wrong — those two use `findWorkflowState` from `hooks/lib/utils.ts`, a
  // third implementation of this scan, which #1668 filtered and which has its
  // own cases below.
  //
  // The archived entry is planted LAST in each case, so it is the newest
  // file and wins `Priority 3` unless it is filtered out.

  test("the control: a live run is found", async () => {
    expect(await discoveredSlug([{ dir: "proj-169", phase: "BUILD" }])).toBe("proj-169");
  });

  test("an archived run is never the answer, even when it is newest", async () => {
    expect(
      await discoveredSlug([
        { dir: "proj-169", phase: "BUILD" },
        { dir: ".archive/proj-892", phase: "VERIFY" },
      ]),
    ).toBe("proj-169");
  });

  test("a hidden directory INSIDE a live run is not the answer either", async () => {
    expect(
      await discoveredSlug([
        { dir: "proj-169", phase: "BUILD" },
        { dir: "proj-169/.archive", phase: "VERIFY" },
      ]),
    ).toBe("proj-169");
  });

  test("an archived run ALONE discovers nothing, rather than itself", async () => {
    expect(await discoveredSlug([{ dir: ".archive/proj-892", phase: "VERIFY" }])).toBe(null);
  });
});

// ── #1668: the third scan, and the two more the census found ────────────────

/**
 * `hooks/lib/utils.ts` is the third independent copy of this scan and the one
 * #1648 did not reach. Writing the cross-site case AC-4 asks for turned up two
 * sites the issue does not name — `MergeGuard.hook.ts` (`.ship-active`) and
 * `HarnessAFKGate.hook.ts` (`PRD.md`) — so the population is five, not three.
 *
 * That is the point of asserting the property across the sites rather than
 * repairing them one at a time: the per-site cases below could all have been
 * green with two live instances left in the tree, which is exactly how #1648
 * shipped believing it was finished.
 *
 * ## The second defect, and why it hides the first
 *
 * `WORK_DIR` was `join(RUNGATE_WORK_DIR || HOME, '.rungate')` — the `join` is
 * outside the `||`, so an absolute override resolved to
 * `$RUNGATE_WORK_DIR/.rungate`. A ship run and the test harness both set that
 * variable, so in exactly those conditions the two consumer hooks read a
 * directory that does not exist and find NO live workflow at all. A scan that
 * reads nothing cannot be caught reading the wrong thing, so this defect made
 * the first one untestable.
 *
 * `hooks/lib/paths.ts` already resolved it correctly except for the
 * `PAI_WORK_DIR` fallback, which six siblings spell and it did not. So the fix
 * is one binding rather than a ninth copy of the expression: `paths.ts` gains
 * the fallback and `utils.ts` re-exports it.
 *
 * ## What was broken to prove these can fail
 *
 * Recorded per case in the PR. The two that matter: dropping the
 * `isRunDirectory` filter from `findWorkflowState` reddens the two end-to-end
 * consumer cases and the census; restoring the `.rungate` suffix reddens the
 * resolution cases and BOTH consumer cases, because the hooks then read an
 * empty directory.
 */

/**
 * Every hook that lists the work directory, and HOW MANY `readdirSync` calls
 * each one makes.
 *
 * The count is the half that matters, and it is the half the first version of
 * this census got wrong — see the comment on `unguardedSites`. Three of these
 * five files scan twice, once per level, and predicting the membership rather
 * than a total is what makes the second scan impossible to lose
 * (`.claude/rules/checks-must-be-able-to-fail.md`, seventh shape).
 */
const WORK_DIR_SCAN_SITES: Readonly<Record<string, number>> = {
  "HarnessAFKGate.hook.ts": 1,
  "MergeGuard.hook.ts": 1,
  "VerifyPhaseLock.hook.ts": 2,
  "lib/findWorkflow.ts": 2,
  "lib/utils.ts": 2,
};

const WORK_DIR_SCANNERS = Object.keys(WORK_DIR_SCAN_SITES);

const HOOKS_DIR = join(import.meta.dir, "..", "hooks");
const ISSUE_CLOSE_GUARD = join(HOOKS_DIR, "IssueCloseGuard.hook.ts");
const AUTO_VERIFY_GATE = join(HOOKS_DIR, "AutoVerifyGate.hook.ts");

interface PlantedRun {
  dir: string;
  file?: string;
  body: unknown;
}

/** Plant runs under a fresh work directory, in the order given. */
function plantWork(runs: PlantedRun[]): string {
  const work = mkdtempSync(join(tmpdir(), "rg-1668-"));
  for (const r of runs) {
    const d = join(work, ...r.dir.split("/"));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, r.file ?? "workflow-state.json"), JSON.stringify(r.body));
  }
  return work;
}

/**
 * Run a hook as a subprocess with `RUNGATE_WORK_DIR` set and `payload` on
 * stdin, and return everything it said.
 *
 * A subprocess, not an in-process call: `utils.ts` resolves `WORK_DIR` at
 * module load, so an import inside this suite would bind this suite's
 * environment and measure a directory the case never planted.
 */
async function runHook(hook: string, payload: unknown, work: string): Promise<string> {
  // Deleted rather than set to undefined: the resolution under test reads
  // PAI_WORK_DIR as a fallback, so a stray one in the developer's own shell
  // would decide these cases instead of the planted directory.
  const env: Record<string, string> = { ...(process.env as Record<string, string>), RUNGATE_WORK_DIR: work };
  delete env.PAI_WORK_DIR;
  const proc = Bun.spawn(["bun", hook], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return `${out}${err}`;
}

/** What `WORK_DIR` resolves to under a given environment. */
async function resolvedWorkDir(env: Record<string, string | undefined>): Promise<string> {
  const proc = Bun.spawn(
    ["bun", "-e", `const m = await import(${JSON.stringify(join(HOOKS_DIR, "lib", "utils.ts"))}); console.log(m.WORK_DIR);`],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } as Record<string, string> },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

describe("#1668: WORK_DIR resolves the override itself, not a .rungate inside it", () => {
  test("an absolute RUNGATE_WORK_DIR resolves to exactly that path", async () => {
    const got = await resolvedWorkDir({ RUNGATE_WORK_DIR: "/tmp/rg-1668-override", PAI_WORK_DIR: undefined });
    // The defect appended '.rungate', so the hooks read a directory that a
    // ship run never creates and found no live workflow at all.
    expect(got).toBe("/tmp/rg-1668-override");
    expect(got.endsWith(".rungate")).toBe(false);
  });

  test("PAI_WORK_DIR is the second choice, as six siblings already spell it", async () => {
    const got = await resolvedWorkDir({ RUNGATE_WORK_DIR: undefined, PAI_WORK_DIR: "/tmp/rg-1668-pai" });
    expect(got).toBe("/tmp/rg-1668-pai");
  });

  test("RUNGATE_WORK_DIR wins over PAI_WORK_DIR", async () => {
    const got = await resolvedWorkDir({ RUNGATE_WORK_DIR: "/tmp/rg-1668-a", PAI_WORK_DIR: "/tmp/rg-1668-b" });
    expect(got).toBe("/tmp/rg-1668-a");
  });

  test("with neither set it falls back to ~/.rungate", async () => {
    const got = await resolvedWorkDir({ RUNGATE_WORK_DIR: undefined, PAI_WORK_DIR: undefined });
    expect(got.endsWith("/.rungate")).toBe(true);
  });
});

describe("#1668: IssueCloseGuard — an archived run does not decide the close", () => {
  /**
   * The refusal names the slug it vetted, so this asserts on IssueCloseGuard's
   * OWN text rather than a shared `decision: block` that both consumers emit.
   * `.archive` is planted FIRST: `findWorkflowState` returns the first
   * candidate whose issue matches, in readdir order, and a dot sorts early.
   */
  const payload = {
    tool_name: "Bash",
    tool_input: { command: "gh issue close 500 --repo hornjason/rungate" },
  };
  const state = (slug: string) => ({ issue: "500", phase: "BUILD", slug, gates: { ship: { result: "FAIL" } } });

  test("the control: with only a live run, the refusal names it", async () => {
    const work = plantWork([{ dir: "proj-500", body: state("proj-500") }]);
    try {
      const said = await runHook(ISSUE_CLOSE_GUARD, payload, work);
      expect(said, "the guard said nothing, so this case measured nothing").toContain("Cannot close #500");
      expect(said).toContain("--slug proj-500");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("an archived run carrying the same issue number is not the one vetted", async () => {
    const work = plantWork([
      { dir: ".archive/arch-500", body: state("arch-500") },
      { dir: "proj-500", body: state("proj-500") },
    ]);
    try {
      const said = await runHook(ISSUE_CLOSE_GUARD, payload, work);
      expect(said).toContain("--slug proj-500");
      expect(said, "the guard vetted the ARCHIVED run — #1648 at its third site").not.toContain("arch-500");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("#1668: AutoVerifyGate — an archived run does not trigger the gate", () => {
  /**
   * Its own text again: the reminder names the slug the verify gate would be
   * run against, so an archived run deciding here would send the operator at
   * a finished run.
   */
  const payload = {
    tool_name: "Agent",
    tool_input: { subagent_type: "marcus", prompt: "work issue #500" },
    tool_response: "all tests pass, failures: 0",
  };
  const state = (slug: string) => ({ issue: "500", phase: "BUILD", slug });

  test("the control: a live run triggers and is named", async () => {
    const work = plantWork([{ dir: "proj-500", body: state("proj-500") }]);
    try {
      const said = await runHook(AUTO_VERIFY_GATE, payload, work);
      expect(said, "the gate skipped, so this case measured nothing").toContain("AUTO-VERIFY TRIGGERED");
      expect(said).toContain("--slug proj-500");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("an archived run carrying the same issue number does not become the target", async () => {
    const work = plantWork([
      { dir: ".archive/arch-500", body: state("arch-500") },
      { dir: "proj-500", body: state("proj-500") },
    ]);
    try {
      const said = await runHook(AUTO_VERIFY_GATE, payload, work);
      expect(said).toContain("--slug proj-500");
      expect(said).not.toContain("arch-500");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  /**
   * The INNER filter's only witness.
   *
   * The battery for this change measured `0 red` when the inner
   * `isRunDirectory` was dropped while every other case stayed green — the
   * guard was there and nothing could see it. The two cases above cannot:
   * `findWorkflowState` collects the outer `workflow-state.json` before
   * descending, so a live outer run always matches first and the inner scan
   * never decides anything.
   *
   * So the hidden directory is the ONLY candidate here. Filtered, there is no
   * live workflow and the gate skips; unfiltered, it triggers the verify gate
   * against a slug ending in `.archive`. AutoVerifyGate rather than
   * IssueCloseGuard because its no-workflow path exits without reaching
   * GitHub, so the case needs no token and no network.
   */
  test("a hidden directory INSIDE a run is not a run, even as the only candidate", async () => {
    const work = plantWork([{ dir: "proj-500/.archive", body: state("proj-500/.archive") }]);
    try {
      const said = await runHook(AUTO_VERIFY_GATE, payload, work);
      expect(said, "the gate produced no output at all, so this case measured nothing").not.toBe("");
      expect(said, "a hidden directory inside a live run became the verify target").not.toContain("AUTO-VERIFY TRIGGERED");
      expect(said).toContain("No active workflow");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("#1668: the property across every work-dir scan site", () => {
  /**
   * The cases above are per-site, and per-site cases are what let #1648 ship
   * with a third instance live. This one reads the POPULATION.
   *
   * It is deliberately a source census rather than a behavioural sweep: the
   * thing it has to catch is the scan somebody adds NEXT, which by definition
   * has no behavioural case pointed at it.
   */
  function hookSources(): { rel: string; src: string }[] {
    const out: { rel: string; src: string }[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`);
        else if (e.name.endsWith(".ts")) out.push({ rel: `${prefix}${e.name}`, src: readFileSync(join(dir, e.name), "utf-8") });
      }
    };
    walk(HOOKS_DIR, "");
    return out;
  }

  const SCAN_CALL = "readdirSync(";
  const NAMES_WORK_DIR = /\b(WORK_DIR|RUNGATE_WORK_DIR|PAI_WORK_DIR)\b/;

  /** The hooks that list the work directory, by source rather than by list. */
  const scanners = () =>
    hookSources().filter(f => f.src.includes(SCAN_CALL) && NAMES_WORK_DIR.test(f.src));

  /** Every `readdirSync(` in a source, as byte offsets in source order. */
  function scanOffsets(src: string): number[] {
    const out: number[] = [];
    for (let i = src.indexOf(SCAN_CALL); i >= 0; i = src.indexOf(SCAN_CALL, i + 1)) out.push(i);
    return out;
  }

  /**
   * The 1-based lines of the scan sites with no `isRunDirectory` between them
   * and the next scan site. A site owns the text up to the next one, which is
   * where its own consumer is written.
   *
   * ## Pairing is the whole point, and the first version did not pair
   *
   * ai-review raised both halves on #1902 and was right about both. It
   * counted `readdirSync(<work-dir-ish identifier>)` regex matches against
   * `isRunDirectory(` occurrences FILE-WIDE, and asserted `guards < scans`:
   *
   *   - the pattern required the work-dir name to be the FIRST token inside
   *     the call, so `readdirSync(join(WORK_DIR, d.name), …)` — the inner
   *     scan in `hooks/lib/utils.ts` — did not count, and neither did
   *     `readdirSync(subDir, …)` in findWorkflow or `readdirSync(nested, …)`
   *     in VerifyPhaseLock. Every file read as exactly one scan;
   *   - a file-wide total lets a surplus guard anywhere in the file stand in
   *     for a missing one anywhere else.
   *
   * The second swallowed the first: `utils.ts` read `scans = 1, guards = 2`,
   * so deleting EITHER filter still left `guards >= scans`. The census was
   * green by coincidence and could not fail on the regression it exists to
   * catch — `.claude/rules/checks-must-be-able-to-fail.md`, third shape.
   *
   * Both spellings of the guard count, deliberately. A chained
   * `.filter(d => … isRunDirectory(d.name))` and an
   * `if (!isRunDirectory(entry.name)) continue;` in the loop body are both
   * live in this population, and neither is more correct than the other.
   */
  function unguardedSites(src: string): number[] {
    const offsets = scanOffsets(src);
    return offsets
      .filter((at, i) => {
        const until = i + 1 < offsets.length ? offsets[i + 1] : src.length;
        return !src.slice(at, until).includes("isRunDirectory(");
      })
      .map(at => src.slice(0, at).split("\n").length);
  }

  test("the population is exactly the files this test knows about", () => {
    expect(
      scanners().map(f => f.rel).sort(),
      "a hook started or stopped scanning the work directory. If it is NEW, it must filter " +
        "through isRunDirectory from lib/active-workflow (#1648, #1668) — then add it to " +
        "WORK_DIR_SCAN_SITES. Do not add it without the filter.",
    ).toEqual([...WORK_DIR_SCANNERS].sort());
  });

  test("the census sees every scan site, including the second one in a nested scanner", () => {
    // The membership, not the total: the defect this replaced read 1 site in
    // each of the five files and was internally consistent about it.
    const counted = Object.fromEntries(scanners().map(f => [f.rel, scanOffsets(f.src).length]));
    expect(
      counted,
      "the scan-site count moved. If a hook gained or lost a readdirSync, update " +
        "WORK_DIR_SCAN_SITES; if it did not, this census has stopped seeing one, and " +
        "every case below it is vacuous for that site.",
    ).toEqual(WORK_DIR_SCAN_SITES);
  });

  test("every scan site in every one of them is filtered by isRunDirectory", () => {
    const unfiltered = scanners()
      .flatMap(f => unguardedSites(f.src).map(line => `${f.rel}:${line}`));
    expect(
      unfiltered,
      "an unfiltered work-dir scan reads .archive, and an archived run is newest, so it decides " +
        "the gate (#1648). Filter THAT scan — each call site is paired with the guard written " +
        "between it and the next one, so a filter elsewhere in the file does not cover for it.",
    ).toEqual([]);
  });
});
