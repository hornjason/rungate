/**
 * scripts/probe-forge-behaviour.ts — every forge behaviour a tool here rests
 * on, read against the real thing (#1910).
 *
 * Three halves:
 *
 * - `forgeBehaviourReading` is pure, and is driven through every reading of
 *   every probed row. Breaking one row's observation moves that row and no
 *   other.
 * - `citationViolations` holds the tree to the inventory, in both directions,
 *   and runs here over the real tree.
 * - The script is spawned for real: `git` against local repositories, `gh`
 *   planted on PATH answering only the exact call the script should make. Each
 *   refusing case runs twice, against the script and a mutant whose
 *   `REFUSE_EXIT` is 0, so the refusal is what the case observed.
 *
 * The live probes themselves are not run against GitHub here. A unit suite
 * that asks the forge a question goes red when the network does; the readings
 * are pure and the dispatch is not.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  citationViolations,
  FORGE_BEHAVIOURS,
  forgeBehaviourReading,
  MERGED_FIXTURE,
  type Observations,
  type Ran,
  BESIDE_LINES,
  REFUSE_EXIT,
  remoteNamesRepo,
  SLEEP_MS,
} from "../scripts/probe-forge-behaviour";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "probe-forge-behaviour.ts");
const SOURCE = readFileSync(SCRIPT, "utf-8");

// ── observations ────────────────────────────────────────────

const ran = (over: Partial<Ran> = {}): Ran => ({ started: true, exit: 0, out: "", killed: false, ms: 5, ...over });
const BRANCH_HEAD = "6c3d11115fb7bc9cab67fd19f9b9e200f437970d";

/** Every probed row observed as the tools assume. */
function confirmedObservations(): Observations {
  return {
    "bun-spawn-timeout-window": {
      honoured: ran({ ms: SLEEP_MS + 10 }),
      window: ran({ exit: null, killed: true, ms: 2 }),
    },
    "ls-remote-absent-ref-exits-zero": {
      control: ran({ out: `${BRANCH_HEAD}\tHEAD` }),
      absent: ran(),
      absentAgain: ran(),
      controlAfter: ran({ out: `${BRANCH_HEAD}\tHEAD` }),
    },
    "ls-remote-unreadable-exits-nonzero": { unreadable: ran({ exit: 128 }) },
    "head-ref-oid-frozen-at-merge": {
      url: ran({ out: `https://github.com/${MERGED_FIXTURE.repo}.git` }),
      view: ran({ out: JSON.stringify({ state: "MERGED", headRefOid: MERGED_FIXTURE.mergeTimeHead }) }),
      branch: ran({ out: `${BRANCH_HEAD}\trefs/heads/${MERGED_FIXTURE.branch}` }),
    },
    "match-head-commit-checked-at-arm-time": {
      fixture: { built: true, failure: "", leftovers: [] },
      staleRefused: true,
      armed: true,
      secondHead: BRANCH_HEAD,
      headAfter: BRANCH_HEAD,
      armedAfter: true,
    },
    "dirty-pull-request-runs-no-checks": {
      fixture: { built: true, failure: "", leftovers: [] },
      dirtyMergeable: "CONFLICTING",
      dirtyRuns: 0,
      cleanRuns: 3,
    },
  };
}

/** One way each probed row can come back different, and only that row. */
const BREAKS: Record<string, (o: Observations) => void> = {
  "bun-spawn-timeout-window": (o) => { o["bun-spawn-timeout-window"]!.window = ran({ ms: SLEEP_MS + 10 }); },
  "ls-remote-absent-ref-exits-zero": (o) => { o["ls-remote-absent-ref-exits-zero"]!.absent = ran({ out: `${BRANCH_HEAD}\trefs/heads/x` }); },
  "ls-remote-unreadable-exits-nonzero": (o) => { o["ls-remote-unreadable-exits-nonzero"]!.unreadable = ran({ exit: 0 }); },
  "head-ref-oid-frozen-at-merge": (o) => {
    o["head-ref-oid-frozen-at-merge"]!.view = ran({ out: JSON.stringify({ state: "MERGED", headRefOid: BRANCH_HEAD }) });
  },
  "match-head-commit-checked-at-arm-time": (o) => { o["match-head-commit-checked-at-arm-time"]!.armedAfter = false; },
  "dirty-pull-request-runs-no-checks": (o) => { o["dirty-pull-request-runs-no-checks"]!.dirtyRuns = 2; },
};

const PROBED = FORGE_BEHAVIOURS.filter((b) => !b.unprobedBecause).map((b) => b.id);

describe("#1910: the inventory and its probes", () => {
  test("no row lacks a probe (#2749 emptied the list)", () => {
    // A row added without a probe is named here, by id, until it has one.
    expect(FORGE_BEHAVIOURS.filter((b) => b.unprobedBecause).map((b) => b.id)).toEqual([]);
  });

  test("every probed row has its own reading, and none falls through", () => {
    expect(PROBED.length).toBe(6);
    expect(Object.keys(BREAKS).sort()).toEqual([...PROBED].sort());
    for (const id of PROBED) {
      const r = forgeBehaviourReading(id, {});
      expect(r.reading, id).toBe("UNMEASURED");
      expect(r.detail, id).not.toContain("has no reading");
    }
  });

  test("ids are unique and every row names at least one citing file", () => {
    const ids = FORGE_BEHAVIOURS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of FORGE_BEHAVIOURS) expect(b.citedBy.length, b.id).toBeGreaterThan(0);
  });

  test("an id the inventory does not list reads UNMEASURED, never CONFIRMED", () => {
    expect(forgeBehaviourReading("no-such-behaviour", confirmedObservations()).reading).toBe("UNMEASURED");
  });
});

describe("#1910: forgeBehaviourReading", () => {
  // #2750 review: a killed child has no exit code, so wherever a row reads a
  // child's exit, a kill there reads UNMEASURED. Every git and gh child the
  // rows consult, one at a time. The timeout row is not here: a kill is its
  // observation.
  const killed = ran({ exit: null, killed: true, ms: 30_000 });
  const KILLS: Array<[string, string, (o: Observations) => void]> = [
    ["ls-remote-absent-ref-exits-zero", "control", (o) => { o["ls-remote-absent-ref-exits-zero"]!.control = killed; }],
    ["ls-remote-absent-ref-exits-zero", "absent", (o) => { o["ls-remote-absent-ref-exits-zero"]!.absent = killed; }],
    ["ls-remote-absent-ref-exits-zero", "absentAgain, after one failure", (o) => {
      o["ls-remote-absent-ref-exits-zero"]!.absent = ran({ exit: 2 });
      o["ls-remote-absent-ref-exits-zero"]!.absentAgain = killed;
    }],
    ["ls-remote-absent-ref-exits-zero", "controlAfter, after two failures", (o) => {
      o["ls-remote-absent-ref-exits-zero"]!.absent = ran({ exit: 2 });
      o["ls-remote-absent-ref-exits-zero"]!.absentAgain = ran({ exit: 2 });
      o["ls-remote-absent-ref-exits-zero"]!.controlAfter = killed;
    }],
    ["ls-remote-unreadable-exits-nonzero", "unreadable", (o) => { o["ls-remote-unreadable-exits-nonzero"]!.unreadable = killed; }],
    ["head-ref-oid-frozen-at-merge", "url", (o) => { o["head-ref-oid-frozen-at-merge"]!.url = killed; }],
    ["head-ref-oid-frozen-at-merge", "view", (o) => { o["head-ref-oid-frozen-at-merge"]!.view = killed; }],
    ["head-ref-oid-frozen-at-merge", "branch", (o) => { o["head-ref-oid-frozen-at-merge"]!.branch = killed; }],
  ];
  test.each(KILLS)("%s: a killed %s reads UNMEASURED", (id, _child, kill) => {
    const obs = confirmedObservations();
    kill(obs);
    expect(forgeBehaviourReading(id, obs).reading).toBe("UNMEASURED");
  });

  test("every probed row reads CONFIRMED when observed as assumed", () => {
    const obs = confirmedObservations();
    for (const id of PROBED) expect(forgeBehaviourReading(id, obs).reading, id).toBe("CONFIRMED");
  });

  for (const broken of Object.keys(BREAKS)) {
    test(`breaking ${broken} turns that row CHANGED and no other`, () => {
      const obs = confirmedObservations();
      BREAKS[broken](obs);
      for (const id of PROBED) {
        expect(forgeBehaviourReading(id, obs).reading, id).toBe(id === broken ? "CHANGED" : "CONFIRMED");
      }
    });
  }

  describe("bun-spawn-timeout-window", () => {
    const id = "bun-spawn-timeout-window";
    const at = (honoured: Ran, window: Ran) => forgeBehaviourReading(id, { [id]: { honoured, window } });

    test("2**31 - 1 killed early is CHANGED, and says the cap now admits a bad bound", () => {
      const r = at(ran({ exit: null, killed: true, ms: 3 }), ran({ exit: null, killed: true, ms: 2 }));
      expect(r.reading).toBe("CHANGED");
      expect(r.detail).toContain("no longer honoured");
    });
    test("2**31 honoured is CHANGED, and says the window moved", () => {
      const r = at(ran({ ms: SLEEP_MS + 5 }), ran({ ms: SLEEP_MS + 5 }));
      expect(r.reading).toBe("CHANGED");
      expect(r.detail).toContain("moved or closed");
    });
    test("a run that returned early without being killed is not an honoured timeout", () => {
      expect(at(ran({ ms: 3 }), ran({ exit: null, killed: true, ms: 2 })).reading).not.toBe("CONFIRMED");
    });
    // #2750 review: a sleep that exits on its own, early or non-zero, is not bun.
    test("a sleep that exits non-zero, or returns early unkilled, is UNMEASURED, not CHANGED", () => {
      expect(at(ran({ exit: 1, ms: 2 }), ran({ exit: null, killed: true, ms: 2 })).reading).toBe("UNMEASURED");
      expect(at(ran({ ms: SLEEP_MS + 5 }), ran({ exit: 1, ms: 2 })).reading).toBe("UNMEASURED");
    });
    test("a sleep that could not start is UNMEASURED", () => {
      expect(at(ran({ started: false, exit: null }), ran({ started: false, exit: null })).reading).toBe("UNMEASURED");
    });
  });

  describe("ls-remote-absent-ref-exits-zero", () => {
    const id = "ls-remote-absent-ref-exits-zero";
    const reachable = ran({ out: `${BRANCH_HEAD}\tHEAD` });
    const at = (control: Ran, absent: Ran, absentAgain: Ran = absent, controlAfter: Ran = reachable) =>
      forgeBehaviourReading(id, { [id]: { control, absent, absentAgain, controlAfter } });

    // The control is the point: without it a remote that was not read and an
    // absent ref are the same empty answer.
    test("a remote that did not answer HEAD is UNMEASURED, whatever the absent ref did", () => {
      expect(at(ran({ exit: 128 }), ran()).reading).toBe("UNMEASURED");
      expect(at(ran({ exit: 0, out: "" }), ran()).reading).toBe("UNMEASURED");
    });
    test("output for an absent ref is CHANGED", () => {
      expect(at(reachable, ran({ out: `${BRANCH_HEAD}\trefs/heads/x` })).reading).toBe("CHANGED");
    });
    test("a non-zero exit for an absent ref, twice between two good HEAD reads, is CHANGED", () => {
      expect(at(reachable, ran({ exit: 2 })).reading).toBe("CHANGED");
    });
    // #2750 review: one failure after a good control is a failed read.
    test("a non-zero exit once, not repeated, is UNMEASURED", () => {
      expect(at(reachable, ran({ exit: 128 }), ran()).reading).toBe("UNMEASURED");
      expect(at(reachable, ran({ exit: 128 }), ran({ exit: 2 })).reading).toBe("UNMEASURED");
      expect(at(reachable, ran({ exit: 128 }), ran({ exit: 128 }), ran({ exit: 128 })).reading).toBe("UNMEASURED");
    });
    // #2750 review: a killed child has no exit code, and null is not a code.
    test("an absent-ref read that was killed is UNMEASURED, not CHANGED", () => {
      expect(at(reachable, ran({ exit: null, killed: true, ms: 30_000 })).reading).toBe("UNMEASURED");
    });
  });

  describe("ls-remote-unreadable-exits-nonzero", () => {
    const id = "ls-remote-unreadable-exits-nonzero";
    test("any non-zero exit is CONFIRMED and names the code", () => {
      const r = forgeBehaviourReading(id, { [id]: { unreadable: ran({ exit: 129 }) } });
      expect(r.reading).toBe("CONFIRMED");
      expect(r.detail).toContain("129");
    });
    test("git that could not start is UNMEASURED", () => {
      expect(forgeBehaviourReading(id, { [id]: { unreadable: ran({ started: false, exit: null }) } }).reading).toBe("UNMEASURED");
    });
    test("a read that was killed is UNMEASURED, not CONFIRMED", () => {
      const r = forgeBehaviourReading(id, { [id]: { unreadable: ran({ exit: null, killed: true, ms: 30_000 }) } });
      expect(r.reading).toBe("UNMEASURED");
      expect(r.detail).toContain("killed");
    });
  });

  describe("head-ref-oid-frozen-at-merge", () => {
    const id = "head-ref-oid-frozen-at-merge";
    const view = (o: object) => ran({ out: JSON.stringify(o) });
    const branch = (sha: string) => ran({ out: sha ? `${sha}\trefs/heads/${MERGED_FIXTURE.branch}` : "" });
    const fixtureUrl = ran({ out: `git@github.com:${MERGED_FIXTURE.repo}.git` });
    const at = (v: Ran, b: Ran, url: Ran = fixtureUrl) => forgeBehaviourReading(id, { [id]: { url, view: v, branch: b } });
    const merged = view({ state: "MERGED", headRefOid: MERGED_FIXTURE.mergeTimeHead });

    test("gh that did not answer is UNMEASURED, not CONFIRMED", () => {
      expect(at(ran({ exit: 1 }), branch(BRANCH_HEAD)).reading).toBe("UNMEASURED");
      expect(at(ran({ out: "not json" }), branch(BRANCH_HEAD)).reading).toBe("UNMEASURED");
    });
    test("a fixture that is not merged is UNMEASURED", () => {
      expect(at(view({ state: "OPEN", headRefOid: MERGED_FIXTURE.mergeTimeHead }), branch(BRANCH_HEAD)).reading).toBe("UNMEASURED");
    });
    test("a fixture branch that is gone, or back at the merge head, is UNMEASURED", () => {
      expect(at(merged, branch("")).reading).toBe("UNMEASURED");
      expect(at(merged, branch(MERGED_FIXTURE.mergeTimeHead)).reading).toBe("UNMEASURED");
      expect(at(merged, ran({ exit: 128 })).reading).toBe("UNMEASURED");
    });
    test("a headRefOid that is neither head is CHANGED", () => {
      expect(at(view({ state: "MERGED", headRefOid: "f".repeat(40) }), branch(BRANCH_HEAD)).reading).toBe("CHANGED");
    });
    // #2750 review: an incomplete reply is not a changed behaviour.
    test("a merged reply with no headRefOid is UNMEASURED, not CHANGED", () => {
      expect(at(view({ state: "MERGED" }), branch(BRANCH_HEAD)).reading).toBe("UNMEASURED");
    });
    // #2750 review: the pull request is read from GitHub and the branch from
    // the remote, so the remote must be that repository.
    test("a remote that is another repository is UNMEASURED, whatever its branch holds", () => {
      const r = at(merged, branch(BRANCH_HEAD), ran({ out: "https://github.com/alice/rungate.git" }));
      expect(r.reading).toBe("UNMEASURED");
      expect(r.detail).toContain("alice/rungate");
      expect(at(merged, branch(BRANCH_HEAD), ran({ exit: 2 })).reading).toBe("UNMEASURED");
    });
  });

  describe("remoteNamesRepo", () => {
    const repo = "hornjason/rungate";
    test.each([
      ["https://github.com/hornjason/rungate.git", true],
      ["https://github.com/hornjason/rungate", true],
      ["git@github.com:hornjason/rungate.git", true],
      ["/tmp/x/hornjason/rungate", true],
      ["https://github.com/HornJason/RunGate/", true],
      ["https://github.com/alice/rungate.git", false],
      ["https://github.com/hornjason/rungate-fork.git", false],
      ["rungate", false],
      ["", false],
    ])("%s names the repository: %p", (url, want) => {
      expect(remoteNamesRepo(url, repo)).toBe(want);
    });
  });
});

// ── the tree held to the inventory ──────────────────────────

/**
 * Every file git tracks, plus new ones it would track, whatever the directory
 * or extension (#2750 review: a list of roots left specs/ and test/ unread).
 * Nothing is skipped by size or content: a binary file is read as text too, so
 * a marker in it is seen. This file's own planted markers are built by `mark`,
 * so its source carries none.
 */
function readTree(): Record<string, string> {
  const r = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ls-files failed: ${new TextDecoder().decode(r.stderr)}`);
  const files: Record<string, string> = {};
  for (const path of new TextDecoder().decode(r.stdout).split("\0").filter(Boolean)) {
    const full = join(ROOT, path);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // listed by the index and deleted in this worktree: nothing to read
    }
    if (st.isFile()) files[path] = readFileSync(full, "utf-8");
  }
  return files;
}

/** A marker, assembled so that this file's own source carries no marker. */
const mark = (id: string) => "// forge" + "-behaviour: " + id;

describe("#1910: citationViolations — the tree and the inventory agree", () => {
  const tree = readTree();

  test("the scan read the tree, and found one marker per named file", () => {
    expect(Object.keys(tree).length).toBeGreaterThan(1500);
    expect(Object.keys(tree)).toContain("test/probe-forge-behaviour.test.ts");
    // Every listed file that is on disk was read, so nothing is skipped silently.
    const listed = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, stdout: "pipe" });
    const onDisk = new TextDecoder().decode(listed.stdout).split("\0").filter((p) => p && statSync(join(ROOT, p), { throwIfNoEntry: false })?.isFile());
    expect(Object.keys(tree).length).toBe(onDisk.length);
    expect(Object.keys(tree).some((p) => p.startsWith("specs/"))).toBe(true);
    const markers = Object.values(tree).flatMap((t) => [...t.matchAll(/forge-behaviour: ([a-z0-9][a-z0-9-]*)/g)]);
    expect(markers.length).toBe(FORGE_BEHAVIOURS.reduce((n, b) => n + b.citedBy.length, 0));
  });

  test("this tree has no disagreement", () => {
    expect(citationViolations(FORGE_BEHAVIOURS, tree)).toEqual([]);
  });

  const row = { id: "a-behaviour", assumes: "x", citedBy: [{ path: "scripts/a.ts", beside: "relies()" }] };
  const cited = (lines: string[]) => lines.join("\n");

  test("a file citing an id the inventory does not list is named", () => {
    const v = citationViolations([row], { "scripts/a.ts": cited([mark("a-behaviour"), "relies()"]), "lib/b.ts": mark("another-one") });
    expect(v).toEqual(["lib/b.ts: cites `another-one`, which the inventory does not list"]);
  });

  test("a row whose named file carries no marker is named", () => {
    expect(citationViolations([row], { "scripts/a.ts": "// nothing here" })).toEqual(["a-behaviour: scripts/a.ts carries no marker for it"]);
  });

  // #2750 review: a marker binds to the line it cites, so one that outlives
  // that line, or drifts away from it, is red.
  test("a marker whose cited line is gone is named", () => {
    expect(citationViolations([row], { "scripts/a.ts": cited([mark("a-behaviour"), "other()"]) })).toEqual([
      "a-behaviour: scripts/a.ts has no line containing `relies()`, the line its marker cites",
    ]);
  });

  test("a marker more than BESIDE_LINES from its cited line is named, and one at the limit is not", () => {
    const far = cited([mark("a-behaviour"), ...Array(BESIDE_LINES).fill("x"), "relies()"]);
    const near = cited([mark("a-behaviour"), ...Array(BESIDE_LINES - 1).fill("x"), "relies()"]);
    expect(citationViolations([row], { "scripts/a.ts": far })).toEqual([
      `a-behaviour: scripts/a.ts's marker is not within ${BESIDE_LINES} lines of \`relies()\``,
    ]);
    expect(citationViolations([row], { "scripts/a.ts": near })).toEqual([]);
  });

  test("a row naming a file that was not read is named, not skipped", () => {
    expect(citationViolations([row], {})).toEqual(["a-behaviour: names scripts/a.ts, which was not read"]);
  });

  test("a marker in a file its row does not name is named", () => {
    const v = citationViolations([row], { "scripts/a.ts": cited([mark("a-behaviour"), "relies()"]), "lib/c.ts": mark("a-behaviour") });
    expect(v).toEqual(["lib/c.ts: cites `a-behaviour`, whose row does not name this file"]);
  });
});

// ── the script, spawned for real ────────────────────────────

let dir = "";
let bin = "";
let remote = "";
let mutant = "";
let branchHead = "";

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
  return new TextDecoder().decode(r.stdout).trim();
}

interface Plant {
  /** What the planted `gh` prints for the exact fixture call. Absent: it exits 1. */
  view?: object;
}

function runScript(path: string, args: string[], plant: Plant = {}) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_VIEW: plant.view ? JSON.stringify(plant.view) : "",
    FAKE_EXPECT: `pr view ${MERGED_FIXTURE.pr} --repo ${MERGED_FIXTURE.repo} --json state,headRefOid`,
  };
  const r = Bun.spawnSync(["bun", path, ...args], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout).trim(), err: new TextDecoder().decode(r.stderr).trim() };
}

/** Both halves of a refusing case: the real script refuses, the mutant does not. */
function bothHalves(args: string[], plant: Plant = {}) {
  const real = runScript(SCRIPT, args, plant);
  const mut = runScript(mutant, args, plant);
  expect(real.code, `the real script did not refuse:\n${real.out}\n${real.err}`).toBe(REFUSE_EXIT);
  expect(mut.code, "the mutant refused too — the case did not observe the exit constant").toBe(0);
  return real;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rg-forge-probe-test-"));
  bin = join(dir, "bin");
  // Named like the fixture's repository, as a real remote's URL is.
  remote = join(dir, ...MERGED_FIXTURE.repo.split("/"));
  mkdirSync(bin, { recursive: true });
  mkdirSync(remote, { recursive: true });

  // A remote with a HEAD, and the fixture branch one commit past it.
  git(remote, "init", "-q", "-b", "main");
  git(remote, "commit", "-q", "--allow-empty", "-m", "base");
  git(remote, "checkout", "-q", "-b", MERGED_FIXTURE.branch);
  git(remote, "commit", "-q", "--allow-empty", "-m", "pushed after the merge");
  branchHead = git(remote, "rev-parse", "HEAD");
  git(remote, "checkout", "-q", "main");

  // A `gh` that answers only the exact fixture call, and fails everything else.
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
[ "$*" = "$FAKE_EXPECT" ] && [ -n "$FAKE_VIEW" ] && { printf '%s' "$FAKE_VIEW"; exit 0; }
exit 1
`,
  );
  chmodSync(join(bin, "gh"), 0o755);

  // The mutant, guarded: one that fails to build or load reports nothing and
  // reads exactly like a case that passed.
  const decl = "export const REFUSE_EXIT = 1;";
  const hits = SOURCE.split(decl).length - 1;
  if (hits !== 1) throw new Error(`could not build the mutant: the exit constant appears ${hits} times, not once`);
  if ([...SOURCE.matchAll(/process\.exit\(\s*[1-9]/g)].length > 0) throw new Error("could not build the mutant: a refusal exits with a literal code");
  if ([...SOURCE.matchAll(/from\s+["']\.{1,2}\//g)].length > 0) throw new Error("could not build the mutant: a relative import would not resolve");
  mutant = join(dir, "mutant", "probe-forge-behaviour.ts");
  mkdirSync(dirname(mutant), { recursive: true });
  writeFileSync(mutant, SOURCE.replace(decl, "export const REFUSE_EXIT = 0;"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("#1910: the script, end to end", () => {
  test("an absent ref on a remote that answers reads CONFIRMED and exits 0", () => {
    const r = runScript(SCRIPT, ["--only", "ls-remote-absent-ref-exits-zero", "--remote", remote]);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toStartWith("CONFIRMED ls-remote-absent-ref-exits-zero:");
  });

  test("a remote that cannot be read makes the absent-ref row UNMEASURED, and refuses", () => {
    const r = bothHalves(["--only", "ls-remote-absent-ref-exits-zero", "--remote", join(dir, "nowhere")]);
    expect(r.out).toStartWith("UNMEASURED ls-remote-absent-ref-exits-zero:");
    expect(r.out).toContain("relied on by: scripts/verify-merge-ref.ts");
  });

  test("an unreadable remote reads CONFIRMED", () => {
    const r = runScript(SCRIPT, ["--only", "ls-remote-unreadable-exits-nonzero"]);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toStartWith("CONFIRMED ls-remote-unreadable-exits-nonzero:");
  });

  test("the merged fixture, recorded at its merge-time head while its branch moved on, reads CONFIRMED", () => {
    const r = runScript(SCRIPT, ["--only", "head-ref-oid-frozen-at-merge", "--remote", remote], {
      view: { state: "MERGED", headRefOid: MERGED_FIXTURE.mergeTimeHead },
    });
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toStartWith("CONFIRMED head-ref-oid-frozen-at-merge:");
    expect(r.out).toContain(branchHead.slice(0, 8));
  });

  test("a headRefOid that follows the branch reads CHANGED, and refuses", () => {
    const r = bothHalves(["--only", "head-ref-oid-frozen-at-merge", "--remote", remote], { view: { state: "MERGED", headRefOid: branchHead } });
    expect(r.out).toStartWith("CHANGED head-ref-oid-frozen-at-merge:");
  });

  test("gh that does not answer — unauthenticated or offline — reads UNMEASURED, and refuses", () => {
    const r = bothHalves(["--only", "head-ref-oid-frozen-at-merge", "--remote", remote]);
    expect(r.out).toStartWith("UNMEASURED head-ref-oid-frozen-at-merge:");
  });

  // #2749: with a gh that answers nothing it was not planted for, the
  // throwaway-pull-request rows build nothing, so nothing needs removing.
  test("a throwaway-pull-request row whose gh does not answer builds nothing, reads UNMEASURED, and refuses", () => {
    for (const id of ["match-head-commit-checked-at-arm-time", "dirty-pull-request-runs-no-checks"]) {
      const r = bothHalves(["--only", id]);
      expect(r.out).toStartWith(`UNMEASURED ${id}: the fixture was not built: main's head could not be read`);
    }
  });

  test("a value-taking flag given last is refused, not read as absent (#2749)", () => {
    for (const flag of ["--only", "--remote"]) {
      const r = bothHalves([flag]);
      expect(r.err).toContain(`${flag} needs a value after it`);
    }
  });

  test("an unknown row is refused, naming the known ones", () => {
    const r = bothHalves(["--only", "no-such-behaviour"]);
    expect(r.err).toContain("bun-spawn-timeout-window");
  });

  test("the timeout row prints exactly one reading, and exits 0 only on CONFIRMED", () => {
    const r = runScript(SCRIPT, ["--only", "bun-spawn-timeout-window"]);
    const m = r.out.match(/^(CONFIRMED|CHANGED|UNMEASURED) bun-spawn-timeout-window: /);
    expect(m, r.out + r.err).not.toBeNull();
    expect(r.code).toBe(m![1] === "CONFIRMED" ? 0 : REFUSE_EXIT);
  });
});

// ── #2749: the throwaway-pull-request rows ──────────────────

const builtFixture = () => ({ built: true, failure: "", leftovers: [] as string[] });

describe("#2749: the arm-time and conflicted-pull-request readings", () => {
  const arm = (over: Partial<NonNullable<Observations["match-head-commit-checked-at-arm-time"]>> = {}) =>
    forgeBehaviourReading("match-head-commit-checked-at-arm-time", {
      "match-head-commit-checked-at-arm-time": { ...confirmedObservations()["match-head-commit-checked-at-arm-time"]!, ...over },
    });
  const dirty = (over: Partial<NonNullable<Observations["dirty-pull-request-runs-no-checks"]>> = {}) =>
    forgeBehaviourReading("dirty-pull-request-runs-no-checks", {
      "dirty-pull-request-runs-no-checks": { ...confirmedObservations()["dirty-pull-request-runs-no-checks"]!, ...over },
    });

  test("a fixture that could not be removed is named, and is not a pass, in both rows", () => {
    const left = { built: true, failure: "", leftovers: ["pull request #9", "branch rungate-forge-probe-x-arm"] };
    for (const r of [arm({ fixture: left }), dirty({ fixture: left })]) {
      expect(r.reading).toBe("UNMEASURED");
      expect(r.detail).toContain("pull request #9");
      expect(r.detail).toContain("branch rungate-forge-probe-x-arm");
    }
  });

  test("a fixture that was not built says which step failed, in both rows", () => {
    const unbuilt = { built: false, failure: "main's head could not be read: not authenticated, or offline", leftovers: [] };
    for (const r of [arm({ fixture: unbuilt }), dirty({ fixture: unbuilt })]) {
      expect(r.reading).toBe("UNMEASURED");
      expect(r.detail).toContain("main's head could not be read");
    }
  });

  test("arm-time: arming that failed, a push not yet visible, and an unreadable state are UNMEASURED", () => {
    expect(arm({ armed: false }).reading).toBe("UNMEASURED");
    expect(arm({ headAfter: "0000000000000000000000000000000000000000" }).reading).toBe("UNMEASURED");
    expect(arm({ secondHead: "" }).reading).toBe("UNMEASURED");
    expect(arm({ armedAfter: null }).reading).toBe("UNMEASURED");
  });

  test("arm-time: still armed after the push is CONFIRMED, and turned off is CHANGED", () => {
    expect(arm().reading).toBe("CONFIRMED");
    expect(arm({ armedAfter: false }).reading).toBe("CHANGED");
  });

  // #2768 review: "still armed" is what a pin checked only when the merge
  // fires produces too, so the stale pin is the half that tells them apart.
  test("arm-time: a stale pin that arms is CHANGED, and one not read is UNMEASURED", () => {
    expect(arm({ staleRefused: false }).reading).toBe("CHANGED");
    expect(arm({ staleRefused: null }).reading).toBe("UNMEASURED");
  });

  test("arm-time: CONFIRMED says the pin is not observed when the merge fires", () => {
    expect(arm().detail).toContain("Whether the merge compares the pin again when it fires is not observed");
  });

  test("conflicted: a fixture that did not conflict, and a control with no runs, are UNMEASURED", () => {
    expect(dirty({ dirtyMergeable: "MERGEABLE" }).reading).toBe("UNMEASURED");
    expect(dirty({ dirtyMergeable: "" }).reading).toBe("UNMEASURED");
    expect(dirty({ cleanRuns: 0 }).reading).toBe("UNMEASURED");
    expect(dirty({ cleanRuns: null }).reading).toBe("UNMEASURED");
    expect(dirty({ dirtyRuns: null }).reading).toBe("UNMEASURED");
  });

  test("conflicted: no runs beside a control that ran is CONFIRMED, and runs on it are CHANGED", () => {
    expect(dirty().reading).toBe("CONFIRMED");
    expect(dirty({ dirtyRuns: 1 }).reading).toBe("CHANGED");
  });
});

describe("#2749: the fixes folded in from #2750's round 5", () => {
  test("a reply of JSON null makes the frozen-head row UNMEASURED rather than throwing", () => {
    const o = confirmedObservations();
    o["head-ref-oid-frozen-at-merge"]!.view = ran({ out: "null" });
    const r = forgeBehaviourReading("head-ref-oid-frozen-at-merge", o);
    expect(r.reading).toBe("UNMEASURED");
    expect(r.detail).toContain("not an object");
  });

  test("the probe spawns with the kill signal scripts/verify-merge-ref.ts uses", () => {
    const runBody = SOURCE.slice(SOURCE.indexOf("function run("), SOURCE.indexOf("function arg("));
    expect(runBody).toContain('killSignal: "SIGKILL"');
    expect(readFileSync(join(ROOT, "scripts", "verify-merge-ref.ts"), "utf-8")).toContain('killSignal: "SIGKILL"');
  });
});

// ── #2768 review: the fixtures, through a gh that answers by rule ──

describe("#2768 review: what the throwaway fixtures do when GitHub's replies go wrong", () => {
  const R = MERGED_FIXTURE.repo;
  let scriptedBin = "";
  let calls = 0;

  beforeAll(() => {
    scriptedBin = join(dir, "scripted-bin");
    mkdirSync(scriptedBin, { recursive: true });
    // Logs every call, and answers with the first rule whose `has` the
    // arguments contain; with no rule it fails, like gh with no network.
    writeFileSync(
      join(scriptedBin, "gh"),
      [
        "#!/usr/bin/env bun",
        'const { appendFileSync } = require("node:fs");',
        'const argv = process.argv.slice(2).join(" ");',
        'appendFileSync(process.env.FAKE_GH_LOG, argv + "\\n");',
        'for (const r of JSON.parse(process.env.FAKE_GH_RULES || "[]")) {',
        "  if (!argv.includes(r.has)) continue;",
        '  if (r.out !== undefined) process.stdout.write(typeof r.out === "string" ? r.out : JSON.stringify(r.out));',
        "  process.exit(r.exit ?? 0);",
        "}",
        "process.exit(1);",
        "",
      ].join("\n"),
    );
    chmodSync(join(scriptedBin, "gh"), 0o755);
  });

  interface Rule { has: string; out?: unknown; exit?: number }
  const mainRequires = (contexts: string[]): Rule[] => [
    { has: `api repos/${R}/branches/main`, out: { protection: { required_status_checks: { contexts } } } },
    { has: `api repos/${R}/git/ref/heads/main`, out: { object: { sha: "base1" } } },
  ];
  const BRANCH_OK: Rule = { has: `api -X POST repos/${R}/git/refs`, out: { ref: "refs/heads/x" } };
  const COMMIT_OK: Rule = { has: `api -X PUT repos/${R}/contents/`, out: { commit: { sha: "first1" } } };
  const PULL_OK: Rule = { has: `api -X POST repos/${R}/pulls`, out: { number: 7 } };
  const CLEANS: Rule[] = [
    { has: "pr list", out: [] },
    { has: "pr close", exit: 0 },
    { has: "--json state", out: { state: "CLOSED" } },
    { has: `api -X DELETE repos/${R}/git/refs/heads/`, exit: 0 },
    { has: `api repos/${R}/git/ref/heads/rungate-forge-probe-`, out: '{"message":"Not Found"}', exit: 1 },
  ];

  function scripted(rules: Rule[]) {
    const log = join(dir, `scripted-${++calls}.log`);
    writeFileSync(log, "");
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: `${scriptedBin}:${process.env.PATH}`,
      FAKE_GH_RULES: JSON.stringify(rules),
      FAKE_GH_LOG: log,
    };
    const r = Bun.spawnSync(["bun", SCRIPT, "--only", "match-head-commit-checked-at-arm-time"], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: new TextDecoder().decode(r.stdout).trim(), log: readFileSync(log, "utf-8") };
  }

  test("arming that is refused is reported as arming, and the pull request it opened is closed", () => {
    const r = scripted([
      ...mainRequires(["test"]), BRANCH_OK, COMMIT_OK, PULL_OK,
      { has: "pr merge 7", exit: 1 },
      { has: "--json headRefOid,autoMergeRequest", out: { headRefOid: "first1", autoMergeRequest: null } },
      ...CLEANS,
    ]);
    expect(r.out).toStartWith("UNMEASURED match-head-commit-checked-at-arm-time: auto-merge could not be armed with the pull request's own head pinned");
    expect(r.out).not.toContain("not built");
    // The stale pin is tried first, then the pull request's own head.
    expect(r.log.indexOf("--match-head-commit base1")).toBeGreaterThan(-1);
    expect(r.log.indexOf("--match-head-commit first1")).toBeGreaterThan(r.log.indexOf("--match-head-commit base1"));
    expect(r.log).toContain(`pr close 7 --repo ${R}`);
    expect(r.code).toBe(REFUSE_EXIT);
  }, 30_000);

  test("a branch whose create reply was lost is still deleted", () => {
    const r = scripted([...mainRequires(["test"]), { has: `api -X POST repos/${R}/git/refs`, exit: 1 }, ...CLEANS]);
    expect(r.out).toMatch(/the fixture was not built: branch rungate-forge-probe-\S+-arm could not be created/);
    expect(r.log).toMatch(new RegExp(`api -X DELETE repos/${R}/git/refs/heads/rungate-forge-probe-\\S+-arm`));
  }, 30_000);

  test("a branch whose create reply was lost, and that will not delete, is named", () => {
    const r = scripted([
      ...mainRequires(["test"]),
      { has: `api -X POST repos/${R}/git/refs`, exit: 1 },
      { has: `api repos/${R}/git/ref/heads/rungate-forge-probe-`, out: { ref: "refs/heads/x" } },
      ...CLEANS,
    ]);
    expect(r.out).toMatch(/the fixture could not be removed: branch rungate-forge-probe-\S+-arm/);
  }, 30_000);

  test("a pull request whose open reply was lost is found by its head and closed", () => {
    const r = scripted([
      ...mainRequires(["test"]), BRANCH_OK, COMMIT_OK,
      { has: `api -X POST repos/${R}/pulls`, exit: 1 },
      { has: "pr list", out: [{ number: 8 }] },
      ...CLEANS,
    ]);
    expect(r.out).toContain("could not be opened");
    expect(r.log).toMatch(/pr list --repo \S+ --head rungate-forge-probe-\S+-arm/);
    expect(r.log).toContain(`pr close 8 --repo ${R}`);
    expect(r.out).not.toContain("could not be removed");
  }, 30_000);

  test("a main that does not require the test check gets no fixture at all", () => {
    const r = scripted([...mainRequires(["ai-review"]), BRANCH_OK, COMMIT_OK, PULL_OK, ...CLEANS]);
    expect(r.out).toContain("main does not require the `test` check");
    expect(r.log).not.toContain("git/refs -f");
    expect(r.log).not.toContain("pr merge");
  }, 30_000);

  test("a negative is read only after the whole wait, in both rows", () => {
    const body = (from: string, to: string) => SOURCE.slice(SOURCE.indexOf(from), SOURCE.indexOf(to));
    const armTime = body("function observeArmTime(", "function observeDirty(");
    const dirty = body("function observeDirty(", "export function main(");
    // Still armed: a settle that stops only when auto-merge reads off.
    expect(armTime).toContain("const later = settle(view, (v) => v !== null && !armedIn(v));");
    expect(armTime).toContain("o.armedAfter = later === null ? null : armedIn(later);");
    // No runs on the conflicted head: a settle that stops only at its first run.
    expect(dirty).toContain("o.dirtyRuns = settle(() => runsOn(dirtyHead), (n) => n !== null && n > 0);");
  });
});
