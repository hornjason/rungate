/**
 * `scripts/board-snapshot.ts` — the live source behind the `milestones`
 * reading (item **B1** of the ladder in `project-state.json`).
 *
 * ## These assert on the CALLS, not only on the exit code
 *
 * The same reason `test/plan-spec.test.ts` does. A producer that fetched
 * the board and then decided the spec was unsound would exit non-zero
 * having already spent the request, and nothing reading an exit code can
 * tell that apart from a refusal that stopped before it. Every refusal
 * below that is supposed to happen BEFORE the API also asserts the spy saw
 * nothing — `.claude/rules/checks-must-be-able-to-fail.md`, *green on the
 * exit code, witnessing the wrong mechanism*.
 *
 * ## And on the handoff, which is where a two-file design goes wrong
 *
 * The producer and the reader are separate files precisely so the reader
 * can stay import-free for its mutation battery, and two files agreeing
 * about a JSON shape by convention is the three-copy defect in miniature.
 * So the last case runs the producer's real output through the reader's
 * real parser and asserts a board comes out.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  GIT_TIMEOUT_MS,
  gitEnv,
  gitTimeoutFor,
  LIVE_GIT,
  REFUSAL_EXIT,
  main as boardSnapshotMain,
  type BoardSnapshotGitHub,
  type GitSpawn,
  type ProducedSnapshot,
} from "../scripts/board-snapshot";
import {
  GIT_AMBIENT_CONFIG_PREFIX,
  GIT_EXEC_VARS,
  GIT_LOCATION_VARS,
  gitIsolatedEnv,
  withoutAmbientGitOverrides,
} from "../lib/git-isolation";
import type { LiveIssue, ProjectFieldReading } from "../lib/live-issues";
import { oneScMentionPattern } from "../lib/sc-ids";
import { PRODUCE_TIMEOUT_MS, readSnapshotText, takeReadings } from "../scripts/board-conformance";

const ROOT = join(import.meta.dir, "..");
const SOURCE = readFileSync(join(ROOT, "scripts/board-snapshot.ts"), "utf-8");

type Live = { number: number; title: string; description: string | null };

interface SpyOptions {
  /** What `readIssues` returns. Default: none, so the issue reading is empty. */
  issues?: LiveIssue[];
  /** What `listMilestones` throws instead of answering. */
  throws?: Error;
  /** What `readIssues` throws instead of answering. */
  issuesThrow?: Error;
  /**
   * What `readStates` answers, by number. A number ASKED about and absent
   * from this map names no issue at all — which is the distinction #1704
   * turns on, so it is spelled as absence here too rather than as a state.
   */
  states?: Record<number, string>;
  /** What `readStates` throws instead of answering. */
  statesThrow?: Error;
  /**
   * What `readFieldValues` answers per issue number — B4. A number ASKED
   * about and absent from this map is `off-board`: the issue is on no item
   * of this project, which is a MEASURED fact and not a failure to look.
   */
  fields?: Record<number, ProjectFieldReading>;
  /** What `readFieldValues` throws instead of answering. */
  fieldsThrow?: Error;
  /** What `readFieldIdentity` resolves the configured field id to. */
  identity?: { name: string; projectId: string };
  /** What `readFieldIdentity` throws instead of answering. */
  identityThrow?: Error;
}

/** One live issue, with the fields a case is not asserting on defaulted. */
const iss = (o: Partial<LiveIssue> & { number: number }): LiveIssue => ({
  state: "OPEN",
  milestone: null,
  blockedBy: [],
  labels: [],
  // Defaulted to the EMPTY states, not to text naming a criterion: a case
  // that does not pass a body is a case about something else, and an issue
  // with no body names nothing (SC-2616).
  title: `issue ${o.number}`,
  body: null,
  ...o,
});

/** Records whether the API was reached at all, and with what. */
function spy(live: Live[] = [], throwsOrOpts?: Error | SpyOptions) {
  const o: SpyOptions =
    throwsOrOpts instanceof Error ? { throws: throwsOrOpts } : (throwsOrOpts ?? {});
  const calls: string[] = [];
  /** Every number list `readStates` was handed, one entry per call. */
  const asked: number[][] = [];
  /** The same, for `readFieldValues` — B4. */
  const askedFields: number[][] = [];
  const gh: BoardSnapshotGitHub = {
    createClient: (() => {
      calls.push("createClient");
      return {} as never;
    }) as unknown as BoardSnapshotGitHub["createClient"],
    listMilestones: (async (_c: unknown, repo: string) => {
      calls.push(`listMilestones ${repo}`);
      if (o.throws) throw o.throws;
      return live;
    }) as unknown as BoardSnapshotGitHub["listMilestones"],
    readIssues: async (repo: string) => {
      calls.push(`readIssues ${repo}`);
      if (o.issuesThrow) throw o.issuesThrow;
      return o.issues ?? [];
    },
    readStates: async (repo: string, numbers: readonly number[]) => {
      // The numbers go into the record so a case can assert WHICH ones were
      // asked about. A call count cannot tell a targeted read from one that
      // handed over every number on the board.
      asked.push([...numbers]);
      calls.push(`readStates ${repo} ${[...numbers].sort((a, b) => a - b).join(",")}`);
      if (o.statesThrow) throw o.statesThrow;
      const out = new Map<number, string>();
      for (const n of numbers) {
        const state = o.states?.[n];
        if (state !== undefined) out.set(n, state);
      }
      return out;
    },
    readFieldIdentity: async (fieldId: string) => {
      calls.push(`readFieldIdentity ${fieldId}`);
      if (o.identityThrow) throw o.identityThrow;
      return o.identity ?? { name: "Criteria", projectId: BOARD.id };
    },
    readFieldValues: async (repo: string, numbers: readonly number[], projectId: string, field: string) => {
      askedFields.push([...numbers]);
      calls.push(`readFieldValues ${repo} ${projectId} ${field} ${[...numbers].sort((a, b) => a - b).join(",")}`);
      if (o.fieldsThrow) throw o.fieldsThrow;
      const out = new Map<number, ProjectFieldReading>();
      for (const n of numbers) out.set(n, o.fields?.[n] ?? { kind: "off-board" });
      return out;
    },
  };
  return { gh, calls, asked, askedFields };
}

/**
 * A spec with two phases, three criteria, and the heading text the
 * milestone titles are derived from.
 *
 * Unequal phase sizes on purpose: the reading counts criteria, and a
 * fixture with one criterion per phase cannot tell the two denominators
 * apart.
 */
const SPEC = `---
doc-type: spec
testable: true
governs: a fixture
---

# A fixture spec

## Success Criteria

- [ ] SC-9001: the first thing
- [ ] SC-9002: the second thing
- [ ] SC-9003: the third thing

### Phase placement — every criterion has exactly one home

| Placement | Criteria |
|---|---|
| **Phase 0** | SC-9001, SC-9002 |
| **Phase 1** | SC-9003 |

### Phase 0 — the first one

### Phase 1 — the second one
`;

const BODY = (ids: string[]) =>
  `${ids.length} criteria: ${ids.join(", ")}\n\nDerived from the spec's Phase placement table by \`rungate plan-spec\`. Edit the table, not this.`;

/** Both phases already on the board exactly as the table derives them. */
const CONFORMANT_LIVE: Live[] = [
  { number: 1, title: "Fix Phase 0 — the first one", description: BODY(["SC-9001", "SC-9002"]) },
  { number: 2, title: "Fix Phase 1 — the second one", description: BODY(["SC-9003"]) },
];

async function withSpec<T>(content: string, fn: (dir: string, specPath: string) => Promise<T>): Promise<T> {
  // `await`, not a bare `try/finally` around a promise — the first version
  // deleted the directory before the callback had run and six cases failed
  // on a spec that was no longer there.
  const dir = mkdtempSync(join(tmpdir(), "board-snapshot-"));
  try {
    const at = join(dir, "FIXTURE-SPEC.md");
    writeFileSync(at, content);
    return await fn(dir, at);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A project root carrying a rungate config, for the B4 cases.
 *
 * The producer resolves the project board out of `.claude/rungate/config.json`
 * under `--project-root`. Writing a real one into the scratch tree exercises
 * the real loader; the cases that want NO board simply pass a root without it,
 * which is also the state of every consumer that has not configured one.
 */
function writeBoardConfig(dir: string, board: unknown): void {
  mkdirSync(join(dir, ".claude", "rungate"), { recursive: true });
  writeFileSync(join(dir, ".claude", "rungate", "config.json"), JSON.stringify({ project: "fixture", board }));
}

/** The shape `.claude/rungate/config.json` carries on this repository. */
const BOARD = { owner: "hornjason", number: 3, id: "PVT_board", fields: { Criteria: "PVTF_criteria" } };

/**
 * Run the producer and capture what it printed.
 *
 * stdout is the only output it has. It writes no file by design: a
 * snapshot somebody can commit is one that goes stale, and SC-2619 of
 * `specs/SPEC-TO-BOARD-PIPELINE-SPEC.md` refuses a step reading a board
 * state that was assembled earlier by somebody else.
 */
const capture = async (argv: string[], gh: BoardSnapshotGitHub): Promise<{ code: number; text: string }> => {
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => {
    chunks.push(s);
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: await boardSnapshotMain(argv, gh), text: chunks.join("") };
  } finally {
    process.stdout.write = write;
  }
};

const emitted = async (argv: string[], gh: BoardSnapshotGitHub): Promise<ProducedSnapshot> => {
  const { code, text } = await capture(argv, gh);
  expect(code, "the producer refused a case that is supposed to succeed").toBe(0);
  return JSON.parse(text) as ProducedSnapshot;
};

describe("what it produces", () => {
  test("a phase whose milestone the board already carries is `unchanged`, and a missing one is `create`", async () => {
    await withSpec(SPEC, async (dir, at) => {
      // One of the two live, so the SAME run reports both verdicts. A
      // fixture where every phase lands on one verdict cannot show that
      // the producer reads the board rather than asserting a constant.
      const { gh } = spy([CONFORMANT_LIVE[0]!]);
      const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n"], gh);
      expect(snap.phases).toEqual([
        { phase: 0, criteria: ["SC-9001", "SC-9002"], milestoneState: "unchanged" },
        { phase: 1, criteria: ["SC-9003"], milestoneState: "create" },
      ]);
    });
  });

  test("a milestone whose criteria list has drifted is `update`, not `unchanged`", async () => {
    await withSpec(SPEC, async (dir, at) => {
      const stale: Live[] = [
        { ...CONFORMANT_LIVE[0]!, description: BODY(["SC-9001"]) },
        CONFORMANT_LIVE[1]!,
      ];
      const { gh } = spy(stale);
      const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n"], gh);
      expect(snap.phases.find(p => p.phase === 0)?.milestoneState).toBe("update");
      // The control: the phase whose body did not drift is still unchanged,
      // so the `update` above is the drift and not the whole run going red.
      expect(snap.phases.find(p => p.phase === 1)?.milestoneState).toBe("unchanged");
    });
  });

  test("the CRITERION population is empty when there is no board to read it from", async () => {
    // This said "because B2 has not wired it" until B2 wired it. The
    // assertion is unchanged and the REASON is not: emitting partial
    // criterion data makes `criterion-coverage` report SHORT — a number
    // nobody measured — where empty makes it UNMEASURED. What has moved is
    // that the population is now empty because this run has no board and
    // no `--project-root`, not because the producer cannot build one. The
    // cases that prove it CAN are in `the criterion population (B2)`.
    await withSpec(SPEC, async (dir, at) => {
      const { gh } = spy(CONFORMANT_LIVE);
      const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n"], gh);
      expect(snap.criteria).toEqual([]);
    });
  });

  test("it writes no file — the snapshot is stdout and nothing else", async () => {
    // A producer with an --out flag invites a committed snapshot, and a
    // committed snapshot is a board state that was true once. SC-2619
    // refuses a step that reads one. Asserted on the SOURCE, because a
    // behavioural case cannot show that a file was not written somewhere
    // the case never looked.
    expect(SOURCE, "the producer writes a file").not.toContain("writeFileSync");
    expect(SOURCE, "the producer takes an output path").not.toContain("--out");
  });
});

/**
 * The issue population (item **B3**).
 *
 * The thing every case here is really guarding is the circularity the
 * `milestones` reading already walked into once: if the set of engine
 * issues were defined as *the ones carrying the `engine` label*, then
 * `queue-label` is 100% by construction and `blocked-by-edges` is measured
 * over whatever subset happens to be labelled. Membership is the MILESTONE
 * and the predicates are the edges and the label, so each can fail.
 */
describe("the issue population (B3)", () => {
  const IN_PHASE_0 = "Fix Phase 0 — the first one";
  const IN_PHASE_1 = "Fix Phase 1 — the second one";

  test("membership is the prefixed phase milestone — not the label, and not the edges", async () => {
    await withSpec(SPEC, async (dir, at) => {
      const { gh } = spy(CONFORMANT_LIVE, {
        issues: [
          iss({ number: 10, milestone: IN_PHASE_0 }),
          iss({ number: 11, milestone: IN_PHASE_1, labels: ["engine"] }),
          // Each of the next three is a near miss, and each is OUT:
          iss({ number: 12, milestone: null, labels: ["engine"] }), // labelled, no milestone
          iss({ number: 13, milestone: "Other Phase 1 — somebody else's" }), // wrong prefix
          iss({ number: 14, milestone: "Fix the flaky test" }), // right prefix, no phase
          // Round 2 of #1703: a LONGER family name beginning with this
          // one. A bare `startsWith("Fix")` admits it.
          iss({ number: 15, milestone: "Fixture Phase 2 — a longer family" })
        ],
      });
      const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n"], gh);
      expect(snap.issues.map(i => i.number)).toEqual([10, 11]);
    });
  });

  test("the lowest phase carrying an issue is rootReady, and nothing above it is", async () => {
    await withSpec(SPEC, async (dir, at) => {
      const { gh } = spy(CONFORMANT_LIVE, {
        issues: [iss({ number: 11, milestone: IN_PHASE_1 }), iss({ number: 10, milestone: IN_PHASE_0 })],
      });
      const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n"], gh);
      // Both arms. Marking everything root, or nothing, both satisfy a
      // single-arm case and both make `blocked-by-edges` unable to fail.
      expect(snap.issues.find(i => i.number === 10)?.rootReady).toBe(true);
      expect(snap.issues.find(i => i.number === 11)?.rootReady).toBe(false);
    });
  });

  test("the frontier is derived, not hardcoded to phase 0", async () => {
    // Phase 0 carrying no issue is the ordinary mid-project state. A
    // producer testing `phase === 0` would mark NOTHING root here, and
    // every issue in the first phase with work in it would read as
    // missing an edge it can never legitimately have.
    await withSpec(SPEC, async (dir, at) => {
      const { gh } = spy(CONFORMANT_LIVE, { issues: [iss({ number: 11, milestone: IN_PHASE_1 })] });
      const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n"], gh);
      expect(snap.issues[0]?.rootReady).toBe(true);
    });
  });

  test("blockedBy and labels come through as read", async () => {
    await withSpec(SPEC, async (dir, at) => {
      const { gh } = spy(CONFORMANT_LIVE, {
        issues: [
          iss({ number: 10, milestone: IN_PHASE_0, labels: ["engine", "bug"] }),
          iss({ number: 11, milestone: IN_PHASE_1, blockedBy: [10] }),
        ],
      });
      const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n"], gh);
      expect(snap.issues.find(i => i.number === 10)?.labels).toEqual(["engine", "bug"]);
      expect(snap.issues.find(i => i.number === 11)?.blockedBy).toEqual([10]);
      // The control for `labels`: an unlabelled issue reports an EMPTY
      // list and not the other one's. A producer returning a constant
      // would satisfy the assertion above.
      expect(snap.issues.find(i => i.number === 11)?.labels).toEqual([]);
    });
  });

  test("a project with NO board emits no criteriaField key at all", async () => {
    // The key's ABSENCE is the signal `board-conformance` reads to report
    // `criteria-field` UNMEASURED. Writing `criteriaField: null` here would
    // make it say `0 of N — N short` about a Projects v2 column nothing
    // queried.
    //
    // `--project-root` is the scratch tree and pinning it is the point: B4
    // taught this producer to read the column when a board IS configured,
    // and without the pin the root is the repository's own checkout, where
    // one is. The case would then be asserting "the fixture's project id
    // does not match the repo's", which is true and is not what it says.
    await withSpec(SPEC, async (dir, at) => {
      const { gh } = spy(CONFORMANT_LIVE, { issues: [iss({ number: 10, milestone: IN_PHASE_0 })] });
      const { text } = await capture([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], gh);
      expect(text, "the producer emitted a Criteria column it never queried").not.toContain("criteriaField");
    });
  });
});

describe("the refusals, and whether the API was reached", () => {
  test("an unsound placement table refuses BEFORE any request", async () => {
    // A criterion the table never places makes the denominator wrong in
    // the quiet direction: the reading would go met while the criteria
    // with no home are not in it at all.
    const unplaced = SPEC.replace("| **Phase 1** | SC-9003 |\n", "");
    await withSpec(unplaced, async (_dir, at) => {
      const { gh, calls } = spy(CONFORMANT_LIVE);
      expect(await boardSnapshotMain([at, "--prefix", "Fix", "--repo", "o/n"], gh)).toBe(REFUSAL_EXIT);
      expect(calls, "it fetched the board and then decided the spec was unsound").toEqual([]);
    });

    // The control: one row restored, same everything else, and it runs.
    await withSpec(SPEC, async (_dir, at) => {
      const { gh, calls } = spy(CONFORMANT_LIVE);
      expect(await boardSnapshotMain([at, "--prefix", "Fix", "--repo", "o/n"], gh)).toBe(0);
      // The names, not a count. A count drifts silently every time the
      // producer gains a call, and then the control is passing on a
      // number nobody re-derived.
      expect(calls, "the control never reached the API either, so the case above proves nothing").toEqual([
        "createClient",
        "listMilestones o/n",
        "readIssues o/n",
      ]);
    });
  });

  test("a criterion placed twice refuses — a doubled row counts one criterion as two homes", async () => {
    const doubled = SPEC.replace("| **Phase 1** | SC-9003 |", "| **Phase 1** | SC-9003, SC-9001 |");
    await withSpec(doubled, async (_dir, at) => {
      const { gh, calls } = spy(CONFORMANT_LIVE);
      expect(await boardSnapshotMain([at, "--prefix", "Fix", "--repo", "o/n"], gh)).toBe(REFUSAL_EXIT);
      expect(calls).toEqual([]);
    });
  });

  test("a spec with no placement table is UNMEASURED, not a spec with no phases", async () => {
    const none = SPEC.slice(0, SPEC.indexOf("### Phase placement"));
    await withSpec(none, async (_dir, at) => {
      const { gh, calls } = spy(CONFORMANT_LIVE);
      expect(await boardSnapshotMain([at, "--prefix", "Fix", "--repo", "o/n"], gh)).toBe(REFUSAL_EXIT);
      expect(calls).toEqual([]);
    });
  });

  test("an API that cannot be reached is UNMEASURED, never a repository with no milestones", async () => {
    // `.claude/rules/config-access.md`, Silent Default Substitution. An
    // empty milestone list and a failed request render identically once
    // the error is swallowed, and one of them says every phase needs
    // creating.
    await withSpec(SPEC, async (_dir, at) => {
      const { gh } = spy([], new Error("502 from the API"));
      expect(await boardSnapshotMain([at, "--prefix", "Fix", "--repo", "o/n"], gh)).toBe(REFUSAL_EXIT);
    });

    // And the control that makes it a real distinction: a repository that
    // genuinely has no milestones is a READABLE board, every phase short.
    await withSpec(SPEC, async (dir, at) => {
      const { gh } = spy([]);
      const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n"], gh);
      expect(snap.phases.map(p => p.milestoneState)).toEqual(["create", "create"]);
    });
  });

  test("the arguments it cannot run without refuse, and none of them reaches the API", async () => {
    await withSpec(SPEC, async (_dir, at) => {
      // `--project-root _dir` on every case, and _dir carries no config.
      // Without it the root is the SUITE's cwd — this repository — whose
      // config now sets `board.engineSpec` and `board.milestonePrefix`
      // (#1718), so the first two cases would resolve real values and stop
      // refusing while still reporting a pass. The control that this is not
      // merely a narrower root is the case below, which uses the same
      // directory WITH a config and runs.
      const cases: { why: string; argv: string[] }[] = [
        { why: "no spec, and no board.engineSpec", argv: ["--prefix", "Fix", "--repo", "o/n", "--project-root", _dir] },
        { why: "no --prefix, and no board.milestonePrefix", argv: [at, "--repo", "o/n", "--project-root", _dir] },
        {
          why: "no spec on disk",
          argv: [join(_dir, "absent.md"), "--prefix", "Fix", "--repo", "o/n", "--project-root", _dir],
        },
      ];
      for (const c of cases) {
        const { gh, calls } = spy(CONFORMANT_LIVE);
        expect(await boardSnapshotMain(c.argv, gh), `${c.why} did not refuse`).toBe(REFUSAL_EXIT);
        expect(calls, `${c.why} still reached the API`).toEqual([]);
      }
    });
  });
});

/**
 * Covers SC-2619 (SPEC-TO-BOARD-PIPELINE-SPEC.md): the inputs come from the
 * repository, not from whoever remembered to type them.
 *
 * `rungate board-conformance` with no arguments printed five UNMEASURED
 * readings reading `B1 has not wired this reading's source yet` — a claim
 * that the tool was unfinished, emitted because nobody had passed a spec.
 * #1718. The cases below are a pair: the same argv refuses against a root
 * with no config and runs against one that configures the two keys, so
 * neither half can pass by accident of scope.
 */
describe("#1718: the spec, the prefix and the repository come from the project", () => {
  test("with neither given, both are read from board.engineSpec and board.milestonePrefix", async () => {
    await withSpec(SPEC, async (dir, at) => {
      // THE NEGATIVE FIRST, so the positive below is a contrast and not a
      // lone green. Same argv, same spec on disk, no config.
      const bare = spy(CONFORMANT_LIVE);
      expect(
        await boardSnapshotMain(["--repo", "o/n", "--project-root", dir], bare.gh),
        "a root with no board config resolved a spec from somewhere",
      ).toBe(REFUSAL_EXIT);
      expect(bare.calls, "it refused and had already asked the API").toEqual([]);

      writeBoardConfig(dir, {
        ...BOARD,
        engineSpec: at.slice(dir.length + 1),
        milestonePrefix: "Fix",
      });
      const { gh, calls } = spy(CONFORMANT_LIVE);
      const snap = await emitted(["--repo", "o/n", "--project-root", dir], gh);
      expect(calls, "the configured run never reached the API, so it measured nothing").toContain("listMilestones o/n");
      // The PREFIX is what proves the second key was read, not just the
      // first: `Fix` is the only prefix under which these two milestones
      // are the spec's phases. A wrong or blank one reports both as
      // `create` and the case would still be green on the spec alone.
      expect(
        snap.phases.map(p => p.milestoneState),
        "the configured prefix was not the one the reading was taken with",
      ).toEqual(["unchanged", "unchanged"]);
    });
  });

  test("a value typed on the command line wins, and a BLANK one still refuses rather than falling back", async () => {
    await withSpec(SPEC, async (dir, at) => {
      writeBoardConfig(dir, { ...BOARD, engineSpec: at.slice(dir.length + 1), milestonePrefix: "Fix" });

      // Config present and complete, and `--prefix ""` still refuses. A
      // fallback reached by a blank would override a person with a file —
      // the typed empty is a mistake to name, not a request for a default.
      const blank = spy(CONFORMANT_LIVE);
      expect(
        await boardSnapshotMain(["--prefix", "", "--repo", "o/n", "--project-root", dir], blank.gh),
        "a blank --prefix fell through to board.milestonePrefix",
      ).toBe(REFUSAL_EXIT);
      expect(blank.calls).toEqual([]);

      // And a typed prefix that is NOT the configured one is the one used.
      // `Other` matches no milestone here, so both phases read `create`;
      // under the configured `Fix` they read `unchanged`. One input, two
      // outcomes, so the case cannot pass on the config either way.
      const { gh } = spy(CONFORMANT_LIVE);
      const snap = await emitted(["--prefix", "Other", "--repo", "o/n", "--project-root", dir], gh);
      expect(snap.phases.map(p => p.milestoneState), "the configured prefix overrode the typed one").toEqual([
        "create",
        "create",
      ]);
    });
  });

  /**
   * Round 1 of #1890. `--spec ""` and `--prefix ""` refused; `--repo ""`
   * did not, because `"" ?? env` keeps the empty string and
   * `resolveRepoSlug`'s own `if (repo && repo.trim())` reads it as "not
   * given" — so a CI line interpolating an unset `$REPO` took a live
   * reading against this checkout's `origin`, a repository the caller
   * never named, with no refusal and no provenance line.
   *
   * Swept over the three inputs rather than adding the missing one, and
   * every other flag is held at a good value in each row, so a refusal
   * can only be about the blank.
   */
  test("a BLANK value on ANY of the three inputs refuses, and none of them reaches the API", async () => {
    await withSpec(SPEC, async (dir, at) => {
      // Config fully present, so a fallback is available for all three and
      // the rows prove it is NOT taken. Without this the case would pass
      // on there being nothing to fall back to.
      writeBoardConfig(dir, { ...BOARD, engineSpec: at.slice(dir.length + 1), milestonePrefix: "Fix" });
      for (const [which, argv] of [
        ["--prefix", ["--prefix", "", "--repo", "o/n"]],
        ["--prefix whitespace", ["--prefix", "   ", "--repo", "o/n"]],
        ["--repo", ["--prefix", "Fix", "--repo", ""]],
        ["--repo whitespace", ["--prefix", "Fix", "--repo", "  "]],
      ] as [string, string[]][]) {
        const { gh, calls } = spy(CONFORMANT_LIVE);
        expect(
          await boardSnapshotMain([at, ...argv, "--project-root", dir], gh),
          `a blank ${which} did not refuse`,
        ).toBe(REFUSAL_EXIT);
        expect(calls, `a blank ${which} reached the API anyway`).toEqual([]);
      }
      // The control: the same argv shape with real values runs, so the
      // four rows above are not refusing for some unrelated reason.
      const { gh, calls } = spy(CONFORMANT_LIVE);
      expect(await boardSnapshotMain([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], gh)).toBe(0);
      expect(calls).toContain("listMilestones o/n");
    });
  });

  test("the refusal names the config key, not only the flag", async () => {
    await withSpec(SPEC, async (dir, at) => {
      const said: string[] = [];
      const err = console.error;
      console.error = (...a: unknown[]) => void said.push(a.join(" "));
      try {
        await boardSnapshotMain(["--repo", "o/n", "--project-root", dir], spy(CONFORMANT_LIVE).gh);
        writeBoardConfig(dir, { ...BOARD, engineSpec: at.slice(dir.length + 1) });
        await boardSnapshotMain(["--repo", "o/n", "--project-root", dir], spy(CONFORMANT_LIVE).gh);
      } finally {
        console.error = err;
      }
      // A refusal that names only the flag tells a reader to type the value
      // again, which is the thing #1718 is removing. It has to name the
      // place the value can live permanently.
      expect(said.join("\n"), "the spec refusal never named board.engineSpec").toContain("board.engineSpec");
      expect(said.join("\n"), "the prefix refusal never named board.milestonePrefix").toContain(
        "board.milestonePrefix",
      );
    });
  });

  test("it says on stderr which inputs it resolved from the repository, and stdout stays the snapshot", async () => {
    await withSpec(SPEC, async (dir, at) => {
      writeBoardConfig(dir, { ...BOARD, engineSpec: at.slice(dir.length + 1), milestonePrefix: "Fix" });
      const said: string[] = [];
      const err = console.error;
      console.error = (...a: unknown[]) => void said.push(a.join(" "));
      let snap: ProducedSnapshot;
      try {
        snap = await emitted(["--repo", "o/n", "--project-root", dir], spy(CONFORMANT_LIVE).gh);
      } finally {
        console.error = err;
      }
      // Two readings taken from config and one typed are the same bytes on
      // stdout. Only one of them is reproducible by somebody who did not
      // watch it being typed, so the difference is stated.
      expect(said.join("\n")).toContain("board.engineSpec");
      expect(said.join("\n")).toContain("board.milestonePrefix");
      // And the control: with both typed, there is nothing to announce.
      const quiet: string[] = [];
      console.error = (...a: unknown[]) => void quiet.push(a.join(" "));
      try {
        await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], spy(CONFORMANT_LIVE).gh);
      } finally {
        console.error = err;
      }
      expect(
        quiet.join("\n"),
        "it announced a config resolution for arguments the caller typed in full",
      ).not.toContain("resolved from the repository");
      expect(snap.phases.length, "the snapshot itself changed shape").toBe(2);
    });
  });
});

describe("the refusals, and whether the API was reached", () => {
  /**
   * Round 1 of #1705, swept. The finding was reported against `plan-deps`,
   * where a guard trimmed and a filter did not. Here the split runs the
   * other way: `if (!prefix)` is false for `"   "`, so a blank prefix was
   * accepted and `milestonePlan` would plan milestones called
   * `"    Phase 0 — …"`. One trimmed reading now serves both commands.
   */
  test("a BLANK --prefix refuses, and never reaches the API", async () => {
    await withSpec(SPEC, async (_dir, at) => {
      for (const blank of ["", "   ", "\t", "\n "]) {
        const { gh, calls } = spy(CONFORMANT_LIVE);
        expect(
          await boardSnapshotMain([at, "--prefix", blank, "--repo", "o/n"], gh),
          `--prefix ${JSON.stringify(blank)} was accepted`,
        ).toBe(REFUSAL_EXIT);
        expect(calls, `--prefix ${JSON.stringify(blank)} reached the API`).toEqual([]);
      }
    });
  });

  test("a --prefix with whitespace on an end is TRIMMED, and names the same family", async () => {
    // The control for the case above: a guard that refuses every prefix
    // containing whitespace would pass it. These two must disagree, and the
    // only reading that makes them disagree is a trimmed one.
    // `CONFORMANT_LIVE` holds milestones already named `Fix Phase N — …`.
    // An untrimmed `"  Fix  "` derives `"  Fix    Phase 0 — …"`, matches none
    // of them, and every phase comes back `create` — a board that is already
    // right, reported as needing six milestones made.
    await withSpec(SPEC, async (_dir, at) => {
      const padded = await emitted([at, "--prefix", "  Fix  ", "--repo", "o/n"], spy(CONFORMANT_LIVE).gh);
      const plain = await emitted([at, "--prefix", "Fix", "--repo", "o/n"], spy(CONFORMANT_LIVE).gh);
      expect(padded.phases.map(p => p.milestoneState)).toEqual(plain.phases.map(p => p.milestoneState));
      expect(
        plain.phases.map(p => p.milestoneState),
        "the control is vacuous — the plain prefix did not recognise the live board either",
      ).toEqual(["unchanged", "unchanged"]);
    });
  });

  test("an issue read that failed is UNMEASURED, not a board with no engine issues", async () => {
    await withSpec(SPEC, async (_dir, at) => {
      const { gh } = spy(CONFORMANT_LIVE, { issuesThrow: new Error("HTTP 403: Resource not accessible") });
      const code = await boardSnapshotMain([at, "--prefix", "Fix", "--repo", "o/n"], gh);
      expect(code, "a failed issue read produced a snapshot").toBe(REFUSAL_EXIT);
    });
  });

  test("a CUT list refuses on EITHER paged connection — a row past the boundary reads as absent", async () => {
    // Both members, because round 1 of #1703 found that `blockedBy` was
    // handled and `labels` was not, in the same query. A blocker past the
    // boundary makes `blocked-by-edges` count the issue short; a label
    // past it makes `queue-label` read `engine` as absent. Same shape,
    // same refusal, asserted over the population rather than the one a
    // reviewer happened to name.
    const cut: { why: string; issue: Parameters<typeof iss>[0] }[] = [
      {
        why: "blockers",
        issue: { number: 10, milestone: "Fix Phase 0 — the first one", blockedBy: [1], blockedByTruncated: true },
      },
      {
        why: "labels",
        issue: { number: 10, milestone: "Fix Phase 0 — the first one", labels: ["engine"], labelsTruncated: true },
      },
    ];
    await withSpec(SPEC, async (_dir, at) => {
      for (const c of cut) {
        const { gh } = spy(CONFORMANT_LIVE, { issues: [iss(c.issue)] });
        expect(
          await boardSnapshotMain([at, "--prefix", "Fix", "--repo", "o/n"], gh),
          `a cut ${c.why} list produced a snapshot`,
        ).toBe(REFUSAL_EXIT);

        // The control, per member: the SAME issue with the same content
        // and the flag off produces a snapshot. Without it, a producer
        // refusing every issue that has a blocker or a label would pass.
        const flag = c.why === "blockers" ? "blockedByTruncated" : "labelsTruncated";
        const { [flag]: _dropped, ...rest } = c.issue as Record<string, unknown>;
        const ok = spy(CONFORMANT_LIVE, { issues: [iss(rest as Parameters<typeof iss>[0])] });
        expect(
          (await capture([at, "--prefix", "Fix", "--repo", "o/n"], ok.gh)).code,
          `the ${c.why} control refused too, so the case above proves nothing`,
        ).toBe(0);
      }
    });
  });

  const IN_PHASE_0 = "Fix Phase 0 — the first one";
  const IN_PHASE_1 = "Fix Phase 1 — the second one";

  /**
   * `closedBlockers` — #1704, the producer half.
   *
   * The reader resolves an edge against the open population. A FINISHED
   * blocker is not in it, so it read exactly like a typo and
   * `blocked-by-edges` would have flipped MET -> SHORT the first time an
   * engine issue closed. The producer has to say which absent numbers are
   * finished work; nothing downstream can work it out.
   */
  test("a FINISHED blocker is emitted, and does not join the engine population", async () => {
    await withSpec(SPEC, async (_dir, at) => {
      const { gh } = spy(CONFORMANT_LIVE, {
        issues: [
          iss({ number: 10, milestone: IN_PHASE_0 }),
          iss({ number: 11, milestone: IN_PHASE_1, blockedBy: [10, 9] }),
        ],
        states: { 9: "CLOSED" },
      });
      const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n"], gh);
      expect(snap.closedBlockers, "the finished blocker was not recorded").toEqual([9]);
      expect(
        snap.issues.map(i => i.number).sort(),
        "a finished blocker entered the engine population — finished work is not work",
      ).toEqual([10, 11]);
    });
  });

  test("a number naming NO issue is NOT emitted — a typo stays short", async () => {
    // The whole point of resolving rather than guessing. `states` answers
    // for 9 and says nothing about 404, so the two arrive at the producer
    // as different facts and must leave it as different facts. A producer
    // defaulting an unanswered number to CLOSED passes the case above and
    // resolves every typo on the board.
    await withSpec(SPEC, async (_dir, at) => {
      const { gh } = spy(CONFORMANT_LIVE, {
        issues: [
          iss({ number: 10, milestone: IN_PHASE_0 }),
          iss({ number: 11, milestone: IN_PHASE_1, blockedBy: [10, 9, 404] }),
        ],
        states: { 9: "CLOSED" },
      });
      const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n"], gh);
      expect(snap.closedBlockers, "a number naming nothing was called finished work").toEqual([9]);
    });
  });

  test("an OPEN blocker outside the engine population is not emitted either", async () => {
    // The third state. An open issue that is not engine work exists, so it
    // resolves — but it is not FINISHED, and `closedBlockers` is the list
    // of finished ones. Without this row, "answered" and "answered CLOSED"
    // are the same input and a producer ignoring the state passes.
    await withSpec(SPEC, async (_dir, at) => {
      const { gh } = spy(CONFORMANT_LIVE, {
        issues: [
          iss({ number: 10, milestone: IN_PHASE_0 }),
          iss({ number: 11, milestone: IN_PHASE_1, blockedBy: [10, 6] }),
        ],
        states: { 6: "OPEN" },
      });
      const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n"], gh);
      expect(snap.closedBlockers).toEqual([]);
    });
  });

  test("the key is ALWAYS present — read-and-none is not the same as never looked", async () => {
    // `board-conformance` makes an absent key UNMEASURED on purpose, so a
    // producer that omits it when the list is empty turns every clean
    // board into a refusal.
    await withSpec(SPEC, async (_dir, at) => {
      const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n"], spy(CONFORMANT_LIVE).gh);
      expect(Object.keys(snap)).toContain("closedBlockers");
      expect(snap.closedBlockers).toEqual([]);
    });
  });

  test("a closed blocker OUTSIDE the family still counts — it is a real issue", async () => {
    // The population filter is about what is WORK, not about what exists.
    // An engine issue blocked by a finished issue from another spec has a
    // resolved edge, and narrowing the resolution to the family here would
    // report it short for pointing at something real.
    await withSpec(SPEC, async (_dir, at) => {
      const { gh } = spy(CONFORMANT_LIVE, {
        issues: [
          iss({ number: 10, milestone: IN_PHASE_0 }),
          iss({ number: 11, milestone: IN_PHASE_1, blockedBy: [10, 7] }),
        ],
        states: { 7: "CLOSED" },
      });
      const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n"], gh);
      expect(snap.closedBlockers).toEqual([7]);
    });
  });

  test("only the UNRESOLVED numbers are asked about — the read does not grow with the repository", async () => {
    // The cost property, asserted on the numbers rather than on a call
    // count. The obvious fix for #1704 is `readLiveIssues(repo, true)`,
    // which answers the same question and passes every case above:
    // measured on hornjason/rungate it turns a one-page read into nine, on
    // a command CI runs and an unattended loop polls, and a 502 was
    // observed on it while this was being written.
    //
    // 10, 11 and 5 are all in hand — 5 because `readIssues` returns every
    // OPEN issue, not only the engine ones, so an out-of-family blocker is
    // known OPEN the moment it returns. Round 1 of #1706 found 5 being
    // asked about.
    await withSpec(SPEC, async (_dir, at) => {
      const { gh, asked } = spy(CONFORMANT_LIVE, {
        issues: [
          iss({ number: 10, milestone: IN_PHASE_0, blockedBy: [] }),
          iss({ number: 11, milestone: IN_PHASE_1, blockedBy: [10, 5, 9, 9, 404] }),
          iss({ number: 5, milestone: "Other Phase 1 — another spec" }),
        ],
        states: { 9: "CLOSED" },
      });
      await emitted([at, "--prefix", "Fix", "--repo", "o/n"], gh);
      expect(asked, "the producer made more than one targeted call").toHaveLength(1);
      expect(
        [...asked[0]!].sort((a, b) => a - b),
        "it asked about a number it had already resolved, or asked twice about one",
      ).toEqual([9, 404]);
    });
  });

  test("an OPEN issue OUTSIDE the family is already resolved — it costs no call at all", async () => {
    // The population half of the row above. `known` is the whole open
    // read; narrowing it to the engine subset is the same answer at the
    // cost of a round trip per cross-spec edge, and on a tracker carrying
    // several specs that is most of them.
    // `--project-root` is the scratch tree, which carries no board config,
    // so the Criteria read adds no calls and this list stays about blocker
    // resolution. Without it the root is the repository's own checkout and
    // the case quietly starts asserting B4's calls too.
    await withSpec(SPEC, async (dir, at) => {
      const { gh, calls } = spy(CONFORMANT_LIVE, {
        issues: [
          iss({ number: 10, milestone: IN_PHASE_0 }),
          iss({ number: 11, milestone: IN_PHASE_1, blockedBy: [10, 5] }),
          iss({ number: 5, milestone: "Other Phase 1 — another spec" }),
        ],
      });
      const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], gh);
      expect(calls, "an open issue the producer already has was asked about").toEqual([
        "createClient",
        "listMilestones o/n",
        "readIssues o/n",
      ]);
      // And it is still not finished work, so the emitted list is unmoved.
      expect(snap.closedBlockers).toEqual([]);
    });
  });

  test("nothing unresolved costs NO call at all", async () => {
    // The control for the row above: `toHaveLength(1)` is satisfied by a
    // producer that always calls once, and the ordinary board — every edge
    // pointing at another engine issue — must reach the API for milestones
    // and issues and then stop.
    await withSpec(SPEC, async (dir, at) => {
      const { gh, calls } = spy(CONFORMANT_LIVE, {
        issues: [
          iss({ number: 10, milestone: IN_PHASE_0 }),
          iss({ number: 11, milestone: IN_PHASE_1, blockedBy: [10] }),
        ],
      });
      // Board-less root, same reason as the case above.
      await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], gh);
      expect(calls).toEqual(["createClient", "listMilestones o/n", "readIssues o/n"]);
    });
  });

  test("a resolution that FAILED is UNMEASURED, not a board with no finished blockers", async () => {
    // Same refusal as the milestone and issue reads, for the same reason.
    // An empty `closedBlockers` after a failed call is a board where every
    // edge to finished work reads as a typo — the exact defect #1704 is.
    await withSpec(SPEC, async (_dir, at) => {
      const { gh } = spy(CONFORMANT_LIVE, {
        issues: [
          iss({ number: 10, milestone: IN_PHASE_0 }),
          iss({ number: 11, milestone: IN_PHASE_1, blockedBy: [10, 9] }),
        ],
        statesThrow: new Error("HTTP 502"),
      });
      expect(await boardSnapshotMain([at, "--prefix", "Fix", "--repo", "o/n"], gh)).toBe(REFUSAL_EXIT);
    });
  });

  /**
   * `criteriaField` — item **B4**, the producer half.
   *
   * The Criteria column is a Projects v2 CUSTOM FIELD. `gh issue list --json
   * projectItems` returns Status and nothing else, so until this landed the
   * producer emitted no `criteriaField` key at all and `criteria-field` was
   * UNMEASURED by construction — which was the true thing to say, and is
   * exactly why the absent key must keep meaning *not read* rather than
   * *empty*.
   */
  describe("the board's Criteria column", () => {
    const twoEngineIssues = {
      issues: [iss({ number: 10, milestone: IN_PHASE_0 }), iss({ number: 11, milestone: IN_PHASE_1 })],
    };

    test("a value on the board is emitted verbatim", async () => {
      await withSpec(SPEC, async (dir, at) => {
        writeBoardConfig(dir, BOARD);
        const { gh } = spy(CONFORMANT_LIVE, {
          ...twoEngineIssues,
          fields: { 10: { kind: "value", value: "SC-9001" }, 11: { kind: "value", value: "SC-9003" } },
        });
        const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], gh);
        expect(snap.issues.map(i => [i.number, i.criteriaField])).toEqual([
          [10, "SC-9001"],
          [11, "SC-9003"],
        ]);
      });
    });

    test("read-and-empty is NULL, and the key is still there", async () => {
      // The whole three-state point. `null` is a measurement — the column
      // was read and nothing is in it — and `criteria-field` counts it
      // SHORT. An omitted key would make the same board UNMEASURED, which
      // is a different and much more flattering sentence.
      await withSpec(SPEC, async (dir, at) => {
        writeBoardConfig(dir, BOARD);
        const { gh } = spy(CONFORMANT_LIVE, {
          ...twoEngineIssues,
          fields: { 10: { kind: "value", value: "SC-9001" }, 11: { kind: "empty" } },
        });
        const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], gh);
        expect(snap.issues.map(i => i.criteriaField)).toEqual(["SC-9001", null]);
        expect(snap.issues.every(i => "criteriaField" in i), "a read issue lost its key").toBe(true);
      });
    });

    test("an issue on NO item of this project is null too — it was looked for", async () => {
      // Off-board and on-board-but-blank are both "the column is not
      // populated for this issue", which is the question the reading asks.
      // Neither is a failure to look, so neither may omit the key.
      await withSpec(SPEC, async (dir, at) => {
        writeBoardConfig(dir, BOARD);
        const { gh } = spy(CONFORMANT_LIVE, {
          ...twoEngineIssues,
          fields: { 10: { kind: "value", value: "SC-9001" }, 11: { kind: "off-board" } },
        });
        const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], gh);
        expect(snap.issues.map(i => i.criteriaField)).toEqual(["SC-9001", null]);
      });
    });

    test("a TRUNCATED project-item list omits the key for that issue ALONE", async () => {
      // The issue's item list was cut before this project was reached, so
      // whether it is on the board is unknown — not absent. The reader's
      // `unreadable` hook fires on ANY issue missing the key, so one
      // truncated row makes the whole reading UNMEASURED, which is the
      // honest answer and is why this must not be flattened to null.
      await withSpec(SPEC, async (dir, at) => {
        writeBoardConfig(dir, BOARD);
        const { gh } = spy(CONFORMANT_LIVE, {
          ...twoEngineIssues,
          fields: { 10: { kind: "value", value: "SC-9001" }, 11: { kind: "truncated" } },
        });
        const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], gh);
        expect(snap.issues.map(i => "criteriaField" in i)).toEqual([true, false]);
        expect(snap.issues[0]!.criteriaField).toBe("SC-9001");
      });
    });

    test("NO board configured omits the key for every issue, and reaches no project API", async () => {
      // A consumer with no `board` block has not got an empty Criteria
      // column — it has not got a board. Emitting null for every issue
      // would report `0 of N — N short` for a column nothing queried.
      await withSpec(SPEC, async (dir, at) => {
        const { gh, calls } = spy(CONFORMANT_LIVE, twoEngineIssues);
        const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], gh);
        expect(snap.issues.map(i => "criteriaField" in i)).toEqual([false, false]);
        expect(
          calls.filter(c => c.startsWith("readField")),
          "it queried a project the config never named",
        ).toEqual([]);
      });
    });

    test("a FAILED project read omits the key — it does not refuse the whole snapshot", async () => {
      // Deliberate, and the one judgement call in this change. The Criteria
      // column feeds ONE reading; `milestones` and `blocked-by-edges` are
      // already met and their verify commands run unattended. Refusing the
      // whole snapshot would turn a B4 outage into a B1 and B3 outage. The
      // key is omitted, so `criteria-field` reports UNMEASURED by itself —
      // fail-closed for the reading that could not be taken, and silent for
      // the two that could.
      await withSpec(SPEC, async (dir, at) => {
        writeBoardConfig(dir, BOARD);
        const { gh } = spy(CONFORMANT_LIVE, { ...twoEngineIssues, fieldsThrow: new Error("HTTP 502") });
        const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], gh);
        expect(snap.issues.map(i => "criteriaField" in i)).toEqual([false, false]);
        // The control: the two readings that do not depend on it still have
        // their data, so what came back is a snapshot and not a stub.
        expect(snap.phases.map(p => p.milestoneState)).toEqual(["unchanged", "unchanged"]);
      });
    });

    test("a field id that resolves into ANOTHER project is not read", async () => {
      // `board.id` and `board.fields.Criteria` are two identifiers in one
      // config block and nothing has ever compared them. A Criteria field
      // copied from another project's config reads values off a board this
      // repository does not use, and every one of them would look like a
      // measurement of ours.
      await withSpec(SPEC, async (dir, at) => {
        writeBoardConfig(dir, BOARD);
        const { gh, calls } = spy(CONFORMANT_LIVE, {
          ...twoEngineIssues,
          identity: { name: "Criteria", projectId: "PVT_someone_elses" },
        });
        const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], gh);
        expect(snap.issues.map(i => "criteriaField" in i)).toEqual([false, false]);
        expect(
          calls.filter(c => c.startsWith("readFieldValues")),
          "it read values from a field belonging to another project",
        ).toEqual([]);
      });
    });

    test("the field NAME comes from the id, not from a second copy of the word", async () => {
      // One identifier. The config names the field by ID; the name used in
      // the query is whatever that id resolves to, so a rename on the board
      // follows automatically and there is no second spelling to drift.
      await withSpec(SPEC, async (dir, at) => {
        writeBoardConfig(dir, BOARD);
        const { gh, calls } = spy(CONFORMANT_LIVE, {
          ...twoEngineIssues,
          identity: { name: "Acceptance criteria", projectId: BOARD.id },
          fields: { 10: { kind: "value", value: "SC-9001" }, 11: { kind: "value", value: "SC-9003" } },
        });
        await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], gh);
        expect(calls).toContain(`readFieldIdentity ${BOARD.fields.Criteria}`);
        expect(calls.find(c => c.startsWith("readFieldValues"))).toContain("Acceptance criteria");
      });
    });

    test("only the ENGINE issues are asked about", async () => {
      // Not every open issue in the repository. The reading's denominator
      // is the engine population, so a query over the rest is a cost with
      // no reader — and on this tracker that is 70-odd issues against five.
      await withSpec(SPEC, async (dir, at) => {
        writeBoardConfig(dir, BOARD);
        const { gh, askedFields } = spy(CONFORMANT_LIVE, {
          issues: [
            iss({ number: 10, milestone: IN_PHASE_0 }),
            iss({ number: 11, milestone: IN_PHASE_1 }),
            iss({ number: 99, milestone: "Other Phase 1 — another spec" }),
            iss({ number: 98, milestone: null }),
          ],
        });
        await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], gh);
        expect(askedFields).toHaveLength(1);
        expect([...askedFields[0]!].sort((a, b) => a - b)).toEqual([10, 11]);
      });
    });

    test("the emitted snapshot makes `criteria-field` MET through the real reader", async () => {
      // End to end across the file boundary, because the producer and the
      // reader agreeing about a JSON key by convention is the three-copy
      // defect in miniature. A populated column must come out MET, and the
      // same board with one blank must come out SHORT.
      await withSpec(SPEC, async (dir, at) => {
        writeBoardConfig(dir, BOARD);
        const full = spy(CONFORMANT_LIVE, {
          ...twoEngineIssues,
          fields: { 10: { kind: "value", value: "SC-9001" }, 11: { kind: "value", value: "SC-9003" } },
        });
        const met = await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], full.gh);
        const read = readSnapshotText(JSON.stringify(met));
        const reading = takeReadings(read.board).find(r => r.name === "criteria-field")!;
        expect([reading.status, reading.why]).toEqual(["met", "2 of 2"]);

        const partial = spy(CONFORMANT_LIVE, {
          ...twoEngineIssues,
          fields: { 10: { kind: "value", value: "SC-9001" }, 11: { kind: "empty" } },
        });
        const short = await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], partial.gh);
        const shortReading = takeReadings(readSnapshotText(JSON.stringify(short)).board).find(
          r => r.name === "criteria-field",
        )!;
        expect(shortReading.status).toBe("short");
      });
    });
  });

  /**
   * `criteria` — item **B2**, the producer half.
   *
   * The population is the SPEC's criteria, and the board's answer about each
   * one is which engine issue names it in the Criteria column B4 wired, or
   * the spec's own tick. Until this landed the producer emitted `[]` and
   * `criterion-coverage` was UNMEASURED by construction.
   *
   * The whole population is inverted out of ONE source — the Criteria column
   * readings already gathered for `criteriaField`. There is no second query
   * and no second spelling of "which issue covers what", because two
   * deciders answering that would be behaviourally one and a mutation of
   * either would leave the other holding every case up.
   */
  describe("the criterion population (B2)", () => {
    const twoEngineIssues = {
      issues: [iss({ number: 10, milestone: IN_PHASE_0 }), iss({ number: 11, milestone: IN_PHASE_1 })],
    };

    /** The spec's three criteria, with what the board said about each. */
    const coverage = (snap: ProducedSnapshot) =>
      snap.criteria.map(c => [c.id, c.satisfiedByIssue, c.recordedTrue]);

    test("an issue naming a criterion covers it, and the rest are explicitly uncovered", async () => {
      await withSpec(SPEC, async (dir, at) => {
        writeBoardConfig(dir, BOARD);
        const { gh } = spy(CONFORMANT_LIVE, {
          ...twoEngineIssues,
          fields: { 10: { kind: "value", value: "SC-9001" }, 11: { kind: "empty" } },
        });
        const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], gh);
        expect(coverage(snap)).toEqual([
          ["SC-9001", 10, false],
          ["SC-9002", null, false],
          ["SC-9003", null, false],
        ]);
      });
    });

    test("an uncovered criterion carries an EXPLICIT null, never an omitted key", async () => {
      // `board-conformance` counts `typeof satisfiedByIssue === "number"`
      // precisely because `undefined !== null` is true: a generator relying
      // on ordinary object omission would have every uncovered criterion
      // counted as covered. That is this command's own failure mode,
      // inverted — a reading reporting met on data it never saw.
      await withSpec(SPEC, async (dir, at) => {
        writeBoardConfig(dir, BOARD);
        const { gh } = spy(CONFORMANT_LIVE, { ...twoEngineIssues, fields: { 10: { kind: "empty" }, 11: { kind: "empty" } } });
        const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], gh);
        expect(snap.criteria.every(c => "satisfiedByIssue" in c), "an uncovered criterion omitted the key").toBe(true);
        expect(snap.criteria.map(c => c.satisfiedByIssue)).toEqual([null, null, null]);
      });
    });

    test("a TICKED criterion is recorded true even though no issue names it", async () => {
      const ticked = SPEC.replace("- [ ] SC-9002", "- [x] SC-9002");
      expect(ticked, "the fixture edit did not land, so this case asserts nothing").toContain("- [x] SC-9002");
      await withSpec(ticked, async (dir, at) => {
        writeBoardConfig(dir, BOARD);
        const { gh } = spy(CONFORMANT_LIVE, { ...twoEngineIssues, fields: { 10: { kind: "empty" }, 11: { kind: "empty" } } });
        const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], gh);
        expect(coverage(snap)).toEqual([
          ["SC-9001", null, false],
          ["SC-9002", null, true],
          ["SC-9003", null, false],
        ]);
      });
    });

    test("one field naming SEVERAL criteria covers all of them", async () => {
      await withSpec(SPEC, async (dir, at) => {
        writeBoardConfig(dir, BOARD);
        const { gh } = spy(CONFORMANT_LIVE, {
          ...twoEngineIssues,
          fields: { 10: { kind: "value", value: "SC-9001, SC-9003" }, 11: { kind: "empty" } },
        });
        const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], gh);
        expect(coverage(snap)).toEqual([
          ["SC-9001", 10, false],
          ["SC-9002", null, false],
          ["SC-9003", 10, false],
        ]);
      });
    });

    test("a criterion id is matched whole — `SC-9001` does not land inside a longer id", async () => {
      // The quiet direction, and the half of the boundary that must not
      // move when the shared `oneScMentionPattern` is the decider: its
      // `(?![\w-])` is what stops `SC-9001` matching inside `SC-90011`.
      // Crediting a criterion no issue names produces a number
      // indistinguishable from a board somebody actually populated.
      //
      // The leading side deliberately has no case here. The shared pattern
      // uses `\b`, which DOES fire on a hyphen-to-letter transition, so
      // `partial-SC-9001` counts as naming it — asserting otherwise would
      // be this reading disagreeing with every other consumer of the
      // pattern, which is the defect review of #1713 found.
      await withSpec(SPEC, async (dir, at) => {
        writeBoardConfig(dir, BOARD);
        const { gh } = spy(CONFORMANT_LIVE, {
          ...twoEngineIssues,
          fields: { 10: { kind: "value", value: "SC-90011" }, 11: { kind: "value", value: "SC-9001x" } },
        });
        const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], gh);
        expect(snap.criteria.map(c => c.satisfiedByIssue)).toEqual([null, null, null]);
      });
    });

    test("the decider is the SHARED one, so a hyphen-prefixed mention counts here too", async () => {
      // Not a preference about hyphens — an agreement assertion. `\b` in
      // `oneScMentionPattern` matches `partial-SC-9001`, and
      // `uncoveredByMilestone` in the same file reads the same text the
      // same way. The case exists so a future hand-rolled boundary in this
      // function goes red instead of quietly splitting the two answers.
      await withSpec(SPEC, async (dir, at) => {
        writeBoardConfig(dir, BOARD);
        const { gh } = spy(CONFORMANT_LIVE, {
          ...twoEngineIssues,
          fields: { 10: { kind: "value", value: "partial-SC-9001" }, 11: { kind: "empty" } },
        });
        const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], gh);
        expect(snap.criteria.find(c => c.id === "SC-9001")!.satisfiedByIssue).toBe(10);
        expect(
          oneScMentionPattern("SC-9001").test("partial-SC-9001"),
          "the shared pattern stopped matching this, so the agreement above is vacuous",
        ).toBe(true);
      });
    });

    test("an id the spec does not state invents no criterion", async () => {
      await withSpec(SPEC, async (dir, at) => {
        writeBoardConfig(dir, BOARD);
        const { gh } = spy(CONFORMANT_LIVE, {
          ...twoEngineIssues,
          fields: { 10: { kind: "value", value: "SC-9999" }, 11: { kind: "empty" } },
        });
        const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], gh);
        expect(snap.criteria.map(c => c.id)).toEqual(["SC-9001", "SC-9002", "SC-9003"]);
        expect(snap.criteria.map(c => c.satisfiedByIssue)).toEqual([null, null, null]);
      });
    });

    test("two issues naming one criterion resolve to the LOWEST number, every time", async () => {
      // Determinism, so a re-run of an unchanged board cannot produce a
      // different snapshot and read as a change on the board.
      await withSpec(SPEC, async (dir, at) => {
        writeBoardConfig(dir, BOARD);
        const { gh } = spy(CONFORMANT_LIVE, {
          ...twoEngineIssues,
          fields: { 10: { kind: "value", value: "SC-9001" }, 11: { kind: "value", value: "SC-9001" } },
        });
        const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], gh);
        expect(snap.criteria.find(c => c.id === "SC-9001")!.satisfiedByIssue).toBe(10);
      });
    });

    test("ONE unread issue emits no population at all — partial coverage is not a measurement", async () => {
      // The B4 rule, one level up. A truncated row means some issue's
      // Criteria column is unknown, so a criterion nothing else names
      // cannot be called uncovered. Emitting the rest would report SHORT —
      // a number nobody measured — where UNMEASURED is the true answer.
      await withSpec(SPEC, async (dir, at) => {
        writeBoardConfig(dir, BOARD);
        const { gh } = spy(CONFORMANT_LIVE, {
          ...twoEngineIssues,
          fields: { 10: { kind: "value", value: "SC-9001" }, 11: { kind: "truncated" } },
        });
        const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], gh);
        expect(snap.criteria, "a partially-read column produced a countable population").toEqual([]);
      });
    });

    test("NO board configured emits no population either", async () => {
      await withSpec(SPEC, async (dir, at) => {
        const { gh } = spy(CONFORMANT_LIVE, twoEngineIssues);
        const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], gh);
        expect(snap.criteria).toEqual([]);
      });
    });

    test("a board with no engine issues on it is still UNMEASURED, not 0 of 3", async () => {
      // There is no column to read and nothing to invert. Emitting the
      // population all-null would say the board was consulted and carries
      // no coverage, which is a sentence about data nobody fetched.
      await withSpec(SPEC, async (dir, at) => {
        writeBoardConfig(dir, BOARD);
        const { gh, calls } = spy(CONFORMANT_LIVE, { issues: [] });
        const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], gh);
        expect(snap.criteria).toEqual([]);
        expect(calls.filter(c => c.startsWith("readField")), "it queried a column with nothing to ask about").toEqual([]);
      });
    });

    test("the emitted snapshot makes `criterion-coverage` MET through the real reader", async () => {
      // Across the file boundary, for the same reason B4 does it: producer
      // and reader agreeing about a JSON key by convention is the
      // three-copy defect in miniature.
      await withSpec(SPEC, async (dir, at) => {
        writeBoardConfig(dir, BOARD);
        const all = spy(CONFORMANT_LIVE, {
          ...twoEngineIssues,
          fields: { 10: { kind: "value", value: "SC-9001, SC-9002" }, 11: { kind: "value", value: "SC-9003" } },
        });
        const met = await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], all.gh);
        const reading = takeReadings(readSnapshotText(JSON.stringify(met)).board).find(
          r => r.name === "criterion-coverage",
        )!;
        expect([reading.status, reading.why]).toEqual(["met", "3 of 3"]);

        const some = spy(CONFORMANT_LIVE, {
          ...twoEngineIssues,
          fields: { 10: { kind: "value", value: "SC-9001" }, 11: { kind: "empty" } },
        });
        const short = await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], some.gh);
        const shortReading = takeReadings(readSnapshotText(JSON.stringify(short)).board).find(
          r => r.name === "criterion-coverage",
        )!;
        expect([shortReading.status, shortReading.why]).toEqual(["short", "1 of 3 — 2 short"]);
      });
    });
  });

  test("the live seam resolves BY NUMBER — it does not page the whole repository", async () => {
    // Everything above runs against an injected seam, so none of it can
    // see what the live one asks the API for. Without this the feature
    // passes while `LIVE_GITHUB` reads every closed issue in the
    // repository, which is the same answer at nine times the cost.
    expect(
      SOURCE,
      "the producer pages every closed issue in the repository to answer a question about a handful of numbers",
    ).not.toContain("readLiveIssues(repo, true)");
    expect(SOURCE, "the open population is no longer read open-only").toContain("readLiveIssues(repo, false)");
    expect(SOURCE, "nothing resolves the unresolved numbers").toContain("readIssueStates");
  });

  /**
   * THREE SOURCES SINCE #1718, in this order: the flag, `GITHUB_REPOSITORY`,
   * then the project's own `origin`. The third is new — the command has to
   * be able to take its own reading, and the repository it is standing in
   * is the only honest answer when nobody has said otherwise.
   *
   * The refusal therefore needs a root that is not a git repository at all,
   * which the scratch directory is. Running this against the suite's cwd
   * would resolve this repository's origin and never refuse — and would do
   * so quietly, reporting a pass.
   */
  test("--repo falls back to GITHUB_REPOSITORY, then to origin, and refuses when none resolves", async () => {
    await withSpec(SPEC, async (_dir, at) => {
      const had = process.env.GITHUB_REPOSITORY;
      try {
        delete process.env.GITHUB_REPOSITORY;
        const bare = spy(CONFORMANT_LIVE);
        expect(
          await boardSnapshotMain([at, "--prefix", "Fix", "--project-root", _dir], bare.gh),
          "a root with no origin resolved a repository from somewhere",
        ).toBe(REFUSAL_EXIT);
        expect(bare.calls).toEqual([]);

        process.env.GITHUB_REPOSITORY = "env/slug";
        const fromEnv = spy(CONFORMANT_LIVE);
        expect((await capture([at, "--prefix", "Fix", "--project-root", _dir], fromEnv.gh)).code).toBe(0);
        expect(fromEnv.calls).toContain("listMilestones env/slug");

        // And the flag still beats the environment, or the ordering above
        // is asserted only at its weakest step.
        const fromFlag = spy(CONFORMANT_LIVE);
        expect(
          (await capture([at, "--prefix", "Fix", "--repo", "flag/slug", "--project-root", _dir], fromFlag.gh)).code,
        ).toBe(0);
        expect(fromFlag.calls, "GITHUB_REPOSITORY overrode an explicit --repo").toContain("listMilestones flag/slug");
      } finally {
        if (had === undefined) delete process.env.GITHUB_REPOSITORY;
        else process.env.GITHUB_REPOSITORY = had;
      }
    });
  });

  /**
   * The third source, exercised rather than described: a root that IS a git
   * repository with an `origin`, no flag and no environment variable.
   *
   * The scratch tree gets its own `origin` pointing at a name no real
   * repository has, so a pass here cannot come from this checkout's remote
   * leaking in through cwd — the asserted slug is one only this fixture
   * could have produced.
   */
  test("with no flag and no environment, the repository is this project's own origin", async () => {
    await withSpec(SPEC, async (dir, at) => {
      const had = process.env.GITHUB_REPOSITORY;
      try {
        delete process.env.GITHUB_REPOSITORY;
        // Spelled out, not built from a shared prefix. `#84`'s guard reads
        // SOURCE TEXT for the git argv it polices, so a literal is the only
        // form it can see — a prefix spread past it once already.
        // late-env-ok: git reads no GITHUB_REPOSITORY, and this case deletes it
        // precisely so the slug can only come from the remote planted below.
        const init = spawnSync("git", ["-C", dir, "init", "-q"], { encoding: "utf-8" });
        expect(init.status, `git init failed in the fixture: ${init.stderr}`).toBe(0);
        // late-env-ok: same call, same reason — git does not consult the
        // environment variable this file writes, and must not.
        const remote = spawnSync(
          "git",
          ["-C", dir, "remote", "add", "origin", "git@github.com:fixture-owner/fixture-repo.git"],
          { encoding: "utf-8" },
        );
        expect(remote.status, `git remote add failed in the fixture: ${remote.stderr}`).toBe(0);
        // **AND A RESOLVABLE `origin/main`, because a reading needs one.**
        // Round 4 made an unresolvable ref fail closed — a configured
        // remote whose ref will not resolve is a reading nobody took, and
        // this fixture used to be exactly that shape while asserting a
        // successful run. Committing and planting the ref makes it a real
        // D3 repository instead of a repository the reader has to excuse.
        for (const argv of [
          ["-C", dir, "add", "-A"],
          ["-C", dir, "-c", "user.email=f@f", "-c", "user.name=f", "commit", "-q", "-m", "fixture"],
          ["-C", dir, "update-ref", "refs/remotes/origin/main", "HEAD"],
        ]) {
          // late-env-ok: git reads no GITHUB_REPOSITORY, and this case deletes it
          const step = spawnSync("git", argv, { encoding: "utf-8" });
          expect(step.status, `${argv[2]} failed in the fixture: ${step.stderr}`).toBe(0);
        }
        const { gh, calls } = spy(CONFORMANT_LIVE);
        expect((await capture([at, "--prefix", "Fix", "--project-root", dir], gh)).code).toBe(0);
        expect(calls, "the slug did not come from the fixture's own origin").toContain(
          "listMilestones fixture-owner/fixture-repo",
        );
      } finally {
        if (had === undefined) delete process.env.GITHUB_REPOSITORY;
        else process.env.GITHUB_REPOSITORY = had;
      }
    });
  });
});

describe("#1727: the queue label reaches the snapshot", () => {
  /**
   * The producer half of the one binding.
   *
   * `board-conformance.ts` may not import `readQueueLabel` — its mutation
   * battery copies the file into an `mkdtemp` and a relative import makes
   * the mutant fail to load, which reads as a refusal on the merits. So the
   * producer resolves the label and hands it over as snapshot data, and
   * this is the case that says it actually arrives. Before it, the only
   * thing holding the producer to the binding was a census over its source
   * text in `test/board-queue-label.test.ts` — which a `readQueueLabel`
   * call whose result never reached the emitted object would satisfy.
   *
   * Proved able to fail, each mutation run and reverted:
   *
   *   | `scripts/board-snapshot.ts` mutation       | red          |
   *   |--------------------------------------------|--------------|
   *   | drop the `queueLabel:` line from `snapshot` | all three    |
   *   | `readQueueLabel(root)` -> `"engine"`        | the last two |
   *
   * The second row is why the first case is not enough on its own:
   * `"engine"` is this repository's own label, so spelling it in the
   * producer satisfies the first case exactly and builds the *two deciders
   * that agree* shape — which is the defect #1727 is about, not a repair
   * for it.
   */
  test("a configured label is in the emitted JSON", async () => {
    await withSpec(SPEC, async (dir, at) => {
      writeBoardConfig(dir, { ...BOARD, queueLabel: "engine" });
      const { gh } = spy(CONFORMANT_LIVE);
      const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], gh);
      expect(
        snap.queueLabel,
        "the configured queue label did not reach the snapshot, so `queue-label` is " +
          "scored against a reading the producer never supplied",
      ).toBe("engine");
    });
  });

  test("CONTROL: the emitted value is the CONFIGURED one, not a built-in that matches", async () => {
    // `"engine"` is this repository's own label, so a producer that spelled
    // it would pass the case above on every fixture anybody is likely to
    // write. A different label is the only input that can tell them apart.
    await withSpec(SPEC, async (dir, at) => {
      writeBoardConfig(dir, { ...BOARD, queueLabel: "queue" });
      const { gh } = spy(CONFORMANT_LIVE);
      const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], gh);
      expect(snap.queueLabel, "the label is invented rather than read").toBe("queue");
    });
  });

  test("an unconfigured tree emits NULL, and the key is still present", async () => {
    // `.claude/rules/config-access.md`: absent is not empty. The key has to
    // be there or the reader cannot tell "no queue configured" from "the
    // producer predates this field", and those take different actions.
    await withSpec(SPEC, async (dir, at) => {
      const { gh } = spy(CONFORMANT_LIVE);
      const snap = await emitted([at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir], gh);
      expect(Object.keys(snap), "the key vanished on an unconfigured tree").toContain("queueLabel");
      expect(snap.queueLabel).toBeNull();
    });
  });
});

describe("the two files agree, and the producer never writes", () => {
  test("what the producer emits is what board-conformance can read", async () => {
    // The shape is declared in two files. Asserting the handoff is the
    // only thing that stops them drifting apart — a producer emitting a
    // key the reader does not know about would be refused as unreadable
    // at the moment somebody wires the verify command, not here.
    await withSpec(SPEC, async (_dir, at) => {
      const { gh } = spy(CONFORMANT_LIVE);
      const { code, text } = await capture([at, "--prefix", "Fix", "--repo", "o/n"], gh);
      expect(code).toBe(0);
      const read = readSnapshotText(text);
      expect(read.why, "the reader could not parse what the producer wrote").toBeNull();
      expect(read.board!.phases.map(p => p.milestoneState)).toEqual(["unchanged", "unchanged"]);
    });
  });

  test("the issues the producer emits drive blocked-by-edges, and an unconfigured column stays UNMEASURED", async () => {
    // The whole point of B3, asserted end to end through both files: an
    // unsequenced board reads SHORT, the same board with the edge reads
    // MET, and a column this project has not configured never becomes a
    // number. `--project-root` is the board-less scratch tree, so the last
    // assertion is about the producer and not about a fixture id failing
    // to match the repository's own config.
    await withSpec(SPEC, async (dir, at) => {
      const argv = [at, "--prefix", "Fix", "--repo", "o/n", "--project-root", dir];
      const unsequenced = spy(CONFORMANT_LIVE, {
        issues: [
          iss({ number: 10, milestone: "Fix Phase 0 — the first one" }),
          iss({ number: 11, milestone: "Fix Phase 1 — the second one" }),
        ],
      });
      const before = readSnapshotText((await capture(argv, unsequenced.gh)).text);
      const edges = (b: typeof before) => takeReadings(b.board!).find(r => r.name === "blocked-by-edges")!;
      expect(edges(before).status, "an unsequenced board read as sequenced").toBe("short");
      expect(edges(before).why).toContain("1 of 2");

      const sequenced = spy(CONFORMANT_LIVE, {
        issues: [
          iss({ number: 10, milestone: "Fix Phase 0 — the first one" }),
          iss({ number: 11, milestone: "Fix Phase 1 — the second one", blockedBy: [10] }),
        ],
      });
      const after = readSnapshotText((await capture(argv, sequenced.gh)).text);
      expect(edges(after).status, "adding the edge did not move the reading").toBe("met");

      // And the column B4 owns is untouched by either.
      for (const r of [before, after]) {
        expect(takeReadings(r.board!).find(x => x.name === "criteria-field")!.status).toBe("unmeasured");
      }
    });
  });

  test("it names no mutating GitHub call — a producer that repaired the board would measure its own work", async () => {
    for (const call of ["createMilestone", "renameMilestone", "createIssue", "updateIssue"]) {
      expect(SOURCE, `board-snapshot names ${call}; producing a reading must not change what it reads`).not.toContain(
        call,
      );
    }
  });

  test("REFUSAL_EXIT is assigned exactly once, and nothing returns a bare refusal code", () => {
    expect((SOURCE.match(/REFUSAL_EXIT\s*=/g) || []).length).toBe(1);
    expect(SOURCE.match(/return\s+-?[1-9]\d*\s*;/g) || []).toEqual([]);
    expect((SOURCE.match(/process\.exit\(/g) || []).length).toBe(1);
  });
});

// ── Security review of PR #1896, round 3 ───────────────────────────────
//
// `resolveSpecSource` put network I/O behind this runner — `git fetch` —
// and `spawnSync` with no `timeout` waits forever. Through
// `board-conformance` the outer `PRODUCE_TIMEOUT_MS` eventually kills the
// child, but `board-snapshot` is a standalone entry point too and nothing
// is above it there. A wedge is worse than a refusal because nothing
// observes it, which is the reasoning `PRODUCE_TIMEOUT_MS`'s own comment
// already carries one level up.
describe("LIVE_GIT bounds every call, because one of them is the network", () => {
  const seen: { cmd: string; args: readonly string[]; opts: Record<string, unknown> }[] = [];
  const recorder = ((cmd: string, args: readonly string[], opts: Record<string, unknown>) => {
    seen.push({ cmd, args, opts });
    return { status: 0, stdout: "out", stderr: "", pid: 1, output: [], signal: null };
  }) as unknown as GitSpawn;

  test("every invocation carries a timeout and refuses to prompt for credentials", () => {
    seen.length = 0;
    LIVE_GIT("/r", recorder)(["fetch", "--quiet", "origin", "main"]);

    expect(seen.length).toBe(1);
    const opts = seen[0]!.opts;
    expect(opts.timeout, "a git call with no timeout can wedge an unattended run").toBe(GIT_TIMEOUT_MS);
    expect(GIT_TIMEOUT_MS).toBeGreaterThan(0);
    // A credential prompt is a hang wearing a different hat: git blocks on
    // a terminal nobody is sitting at. Asserted because the timeout alone
    // turns a 2-second failure into a full-length one.
    expect((opts.env as Record<string, string>).GIT_TERMINAL_PROMPT).toBe("0");
  });

  test("a killed child is `code: null` and SAYS it ran too long", () => {
    // What `spawnSync` hands back when the timeout fires: `status: null`
    // and an `error`. `lib/spec-source.ts` already refuses on a null code,
    // so the open question is whether the refusal can say WHY — "it never
    // started" and "it ran too long" are different facts, and only one of
    // them is worth retrying.
    //
    // The fake carries `error.code` because round 8 made that — not the
    // signal — what licenses naming the bound: a `maxBuffer` overrun has
    // the same signal and a different cause.
    const timedOut = ((_cmd: string, _args: readonly string[]) => ({
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }),
      pid: 1,
      output: [],
      signal: "SIGTERM",
    })) as unknown as GitSpawn;

    const r = LIVE_GIT("/r", timedOut)(["fetch"]);
    expect(r.ok).toBe(false);
    expect(r.code).toBeNull();
    expect(r.stderr).toContain("ETIMEDOUT");
    expect(r.stderr, "the reason omits the bound that was exceeded").toContain(String(GIT_TIMEOUT_MS));
  });

  test("a `git` that was never THERE says so, and does NOT claim a timeout", () => {
    // **The axis the first version of this battery never varied.** A null
    // status has two causes and the code's own comment names both, but
    // every row here handed it the timeout shape — so no count could come
    // back wrong about an `ENOENT`, which failed instantly and printed as
    // having run for a full minute. `signal` is what separates them: a
    // timeout kills, an absent binary never started.
    const absent = ((_cmd: string, _args: readonly string[]) => ({
      status: null,
      stdout: "",
      stderr: "",
      error: new Error("spawnSync git ENOENT"),
      pid: 0,
      output: [],
      signal: null,
    })) as unknown as GitSpawn;

    const r = LIVE_GIT("/r", absent)(["fetch"]);
    expect(r.code).toBeNull();
    expect(r.stderr).toContain("ENOENT");
    expect(r.stderr, "an instant failure claimed the full timeout").not.toContain(String(GIT_TIMEOUT_MS));
    expect(r.stderr).not.toContain("SIGTERM");
    expect(r.stderr).toContain("never started");
  });

  test("a child that exited normally carries NO invented reason — the control", () => {
    // Without this, "a kill says why" is satisfied by appending the timeout
    // note to every call, which would put a timeout message on a successful
    // fetch and teach the reader to ignore it.
    seen.length = 0;
    const r = LIVE_GIT("/r", recorder)(["rev-parse", "--show-toplevel"]);
    expect(r.ok).toBe(true);
    expect(r.stderr).toBe("");
  });
});

// ── Security review of PR #1896, round 8 ───────────────────────────────
describe("round 8: the environment can move the repository out from under `-C root`", () => {
  test("the repo-locating variables are stripped from every git call", () => {
    // `GIT_DIR` and friends take precedence over `-C root`'s discovery, so
    // a caller that already set them — a git hook, a wrapper around its
    // own nested git — points every call at a DIFFERENT repository while
    // each downstream check reports a clean, confident reading for the
    // wrong tree. This module's whole defect, reached through the
    // environment rather than through an exit code.
    const got = gitEnv({ PATH: "/usr/bin", GIT_DIR: "/elsewhere/.git", GIT_WORK_TREE: "/elsewhere", HOME: "/h" });

    for (const name of GIT_LOCATION_VARS) {
      expect(got[name], `${name} survived into the spawn env`).toBeUndefined();
    }
    // The control: stripping is not "empty the environment". PATH is how
    // the child finds git at all.
    expect(got.PATH).toBe("/usr/bin");
    expect(got.HOME).toBe("/h");
    expect(got.GIT_TERMINAL_PROMPT).toBe("0");
  });

  test("the list is what LIVE_GIT actually passes, not a parallel list", () => {
    const seen: Record<string, unknown>[] = [];
    const rec = ((_c: string, _a: readonly string[], o: Record<string, unknown>) => {
      seen.push(o);
      return { status: 0, stdout: "", stderr: "", pid: 1, output: [], signal: null };
    }) as unknown as GitSpawn;

    LIVE_GIT("/r", rec)(["status"]);
    const env = seen[0]!.env as NodeJS.ProcessEnv;
    for (const name of GIT_LOCATION_VARS) expect(env[name], `${name} reached the child`).toBeUndefined();
  });
});

// ── Security review of PR #1896, round 12 ──────────────────────────────
describe("round 12: the inner timeout must be able to fire before the outer one", () => {
  test("GIT_TIMEOUT_MS is strictly under board-conformance's PRODUCE_TIMEOUT_MS", () => {
    // The two were both 60_000, so the outer `spawnSync` killed the whole
    // child at the same moment the inner timeout would have fired and the
    // specific "it timed out — the bound is Nms" message never reached
    // anyone through the primary caller. A diagnostic that cannot fire in
    // the path it was written for is a line in a report
    // (`.claude/rules/checks-must-be-able-to-fail.md`).
    expect(GIT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(
      GIT_TIMEOUT_MS,
      "the outer bound kills the child before the inner one can say why",
    ).toBeLessThan(PRODUCE_TIMEOUT_MS);
  });

  test("it TRACKS the outer bound rather than being a smaller fixed number", () => {
    // A fixed 30s would pass the assertion above and still be wrong for a
    // consumer who lowers the outer bound to 20s — the margin has to
    // follow the variable, not the default. Driven through the exported
    // function because the module-level const reads `process.env` once at
    // import and a late edit cannot reach it
    // (`feedback-bun-late-env-edits-dont-reach-children`).
    expect(gitTimeoutFor({ RUNGATE_PRODUCE_TIMEOUT_MS: "20000" })).toBeLessThan(20000);
    expect(gitTimeoutFor({ RUNGATE_PRODUCE_TIMEOUT_MS: "600000" })).toBeGreaterThan(60000);
    // The control: an unset or unparseable value falls back to the same
    // default the outer one falls back to, not to zero.
    expect(gitTimeoutFor({})).toBe(gitTimeoutFor({ RUNGATE_PRODUCE_TIMEOUT_MS: "nonsense" }));
    expect(gitTimeoutFor({})).toBeGreaterThan(0);
  });

  test("the bound LIVE_GIT actually passes is the derived one", () => {
    const seen: Record<string, unknown>[] = [];
    const rec = ((_c: string, _a: readonly string[], o: Record<string, unknown>) => {
      seen.push(o);
      return { status: 0, stdout: "", stderr: "", pid: 1, output: [], signal: null };
    }) as unknown as GitSpawn;

    LIVE_GIT("/r", rec)(["fetch"]);
    expect(seen[0]!.timeout).toBe(GIT_TIMEOUT_MS);
  });
});

// ── Security review of PR #1896, round 9 ───────────────────────────────
describe("round 9: the denylist was short, and a second denylist is why", () => {
  // Round 8 named seven location variables and stopped. The family it
  // missed does not redirect the repository — it reconfigures git, and
  // several git config keys are COMMANDS. `core.fsmonitor` is the one
  // `lib/git-isolation.ts` measured executing under #960/#965.
  const poisoned = {
    PATH: "/usr/bin",
    HOME: "/h",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "touch /tmp/pwned",
    GIT_CONFIG_GLOBAL: "/attacker/gitconfig",
    GIT_CONFIG_SYSTEM: "/attacker/system",
    GIT_CONFIG_NOSYSTEM: "0",
    GIT_CONFIG: "/attacker/legacy",
  };

  test("every `GIT_CONFIG*` spelling is stripped, including the open-ended one", () => {
    const got = gitEnv(poisoned);

    for (const name of Object.keys(poisoned)) {
      if (!name.startsWith(GIT_AMBIENT_CONFIG_PREFIX)) continue;
      expect(got[name], `${name} survived into the spawn env`).toBeUndefined();
    }
    // The control, and it is the half that makes the strip a strip rather
    // than an emptying: the child still has to find git and a home.
    expect(got.PATH).toBe("/usr/bin");
    expect(got.HOME).toBe("/h");
    expect(got.GIT_TERMINAL_PROMPT).toBe("0");
  });

  test("`KEY_<n>` is matched by PREFIX — an enumeration cannot reach the last one", () => {
    // The reason this is a prefix and not a list. `GIT_CONFIG_COUNT` may
    // be any integer, so the set of names is unbounded and a denylist of
    // literals is short by construction — which is exactly how round 8's
    // list came to be short.
    const many: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    for (let i = 0; i < 64; i++) {
      many[`GIT_CONFIG_KEY_${i}`] = "core.pager";
      many[`GIT_CONFIG_VALUE_${i}`] = "sh -c 'id > /tmp/pwned'";
    }
    const got = gitEnv(many);
    const survivors = Object.keys(got).filter(n => n.startsWith(GIT_AMBIENT_CONFIG_PREFIX));
    expect(survivors, "an injected config entry reached git").toEqual([]);
  });

  test("round 10: a variable git EXECUTES is stripped too, config-spelled or not", () => {
    // The gap my own round-9 refactor opened. Stripping `GIT_CONFIG_*`
    // removes an injected `core.sshCommand`/`core.pager`/`core.fsmonitor`,
    // so leaving `GIT_SSH_COMMAND` set closes the config spelling of a
    // route and leaves the direct one — which buys nothing, because
    // anyone who can set the first can set the second.
    const got = gitEnv({
      PATH: "/usr/bin",
      GIT_SSH_COMMAND: "sh -c 'id > /tmp/pwned'",
      GIT_EXTERNAL_DIFF: "/attacker/diff",
      GIT_ASKPASS: "/attacker/askpass",
      SSH_ASKPASS: "/attacker/askpass",
      GIT_PROXY_COMMAND: "/attacker/proxy",
      GIT_PAGER: "/attacker/pager",
    });

    for (const name of GIT_EXEC_VARS) {
      expect(got[name], `${name} is executed by git and reached the child`).toBeUndefined();
    }
    expect(got.PATH, "stripping became emptying").toBe("/usr/bin");
  });

  test("round 11: the sweep covers names NOBODY listed — that is the point of it", () => {
    // Rounds 8, 9 and 10 each added names to a list and each found the
    // previous list short. The fix is the namespace, not a fourth patch:
    // these are real `GIT_*` variables that appear in none of the
    // exported lists, and a denylist of literals cannot remove them.
    const unlisted = {
      GIT_EXEC_PATH: "/attacker/git-core",
      GIT_TEMPLATE_DIR: "/attacker/template",
      GIT_NAMESPACE: "refs/namespaces/evil",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_A_VARIABLE_GIT_HAS_NOT_INVENTED_YET: "x",
    };
    for (const name of Object.keys(unlisted)) {
      expect(
        [...GIT_LOCATION_VARS, ...GIT_EXEC_VARS].includes(name as never),
        `${name} is in a list, so it cannot show the sweep did the work`,
      ).toBe(false);
    }

    const got = gitEnv({ ...unlisted, PATH: "/usr/bin", HOME: "/h" });
    for (const name of Object.keys(unlisted)) {
      expect(got[name], `${name} reached git`).toBeUndefined();
    }
    expect(got.PATH).toBe("/usr/bin");
    expect(got.HOME).toBe("/h");
  });

  test("round 11: the named lists are DOCUMENTATION — the sweep must cover each", () => {
    // Keeps the lists honest without letting them decide. If a name is
    // worth documenting it must actually be removed; if the sweep ever
    // stops covering one, this says which.
    const every = Object.fromEntries(
      [...GIT_LOCATION_VARS, ...GIT_EXEC_VARS].map(n => [n, "/attacker/x"]),
    );
    const got = gitEnv(every);
    const survivors = [...GIT_LOCATION_VARS, ...GIT_EXEC_VARS].filter(n => got[n] !== undefined);
    expect(survivors, "a documented name is not actually removed").toEqual([]);
  });

  test("round 11: `SSH_AUTH_SOCK` SURVIVES — the control on how wide the sweep is", () => {
    // Without this the sweep is free to widen to `SSH_` and nothing here
    // would notice, which would break fetching over SSH for every
    // consumer using an agent. `SSH_ASKPASS` is a command and is removed
    // by name, so the two assertions together say where the line is.
    const got = gitEnv({ SSH_AUTH_SOCK: "/tmp/agent.sock", SSH_ASKPASS: "/attacker/ask" });
    expect(got.SSH_AUTH_SOCK, "an agent socket is not a command, and fetch needs it").toBe(
      "/tmp/agent.sock",
    );
    expect(got.SSH_ASKPASS, "an askpass IS a command").toBeUndefined();
  });

  test("the declaration lives in lib/git-isolation.ts, and this file consumes it", () => {
    // The finding's actual subject. A behavioural assertion cannot tell a
    // second denylist from the first — both answer, one is dead — so the
    // property asserted is that the reader's env IS the registry's
    // projection, not merely equal to it today.
    const base = { ...poisoned, GIT_DIR: "/elsewhere/.git" };
    expect(gitEnv(base)).toEqual({
      ...withoutAmbientGitOverrides(base),
      GIT_TERMINAL_PROMPT: "0",
    });
  });

  test("the reader does NOT adopt `gitIsolatedEnv` — one of these calls is a fetch", () => {
    // `gitIsolatedEnv` is the other projection and it is wrong here. It
    // SETS `GIT_CONFIG_GLOBAL=/dev/null`, which discards the system
    // gitconfig's `credential.helper` along with everything else —
    // measured in `lib/git-isolation.ts`'s own docblock as the reason
    // `gitCredentialEnv` exists. `resolveSpecSource` runs `git fetch`
    // through this runner, so adopting it would convert a reading into an
    // authentication failure on every HTTPS remote.
    expect(gitIsolatedEnv({}).GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(
      gitEnv({}).GIT_CONFIG_GLOBAL,
      "the snapshot reader nulled the config file that declares credential.helper",
    ).toBeUndefined();
  });

  test("isolation survives the strip — the two halves are not composed by a caller", () => {
    // Both halves are individually correct and the series is not: strip
    // after set removes the isolation, and the result is byte-identical
    // to the isolated case on every channel but the one var. So
    // `gitIsolatedEnv` performs both internally and there is no order for
    // a caller to get wrong.
    const got = gitIsolatedEnv(poisoned);
    expect(got.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(got.GIT_CONFIG_SYSTEM).toBe("/dev/null");
    expect(got.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(got.GIT_CONFIG_COUNT, "an injected entry outlived the isolation").toBeUndefined();
    expect(got.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(got.GIT_CONFIG_VALUE_0).toBeUndefined();
  });
});

describe("round 8: a signal is not a mechanism, and `status` is not always null", () => {
  const shaped = (over: Record<string, unknown>): GitSpawn =>
    ((_c: string, _a: readonly string[]) => ({
      status: null, stdout: "", stderr: "", pid: 1, output: [], signal: null, ...over,
    })) as unknown as GitSpawn;

  test("only ETIMEDOUT names the bound — a maxBuffer kill carries the same signal", () => {
    // Measured: a `maxBuffer` overrun is `status null, signal SIGTERM,
    // code ENOBUFS` — identical to a timeout on the channel the previous
    // version watched. So is an OOM kill. Naming the bound there is the
    // "a duration is not a mechanism" shape in
    // `.claude/rules/checks-must-be-able-to-fail.md`.
    const err = Object.assign(new Error("spawnSync git ENOBUFS"), { code: "ENOBUFS" });
    const r = LIVE_GIT("/r", shaped({ signal: "SIGTERM", error: err }))(["fetch"]);

    expect(r.stderr).toContain("ENOBUFS");
    expect(r.stderr).toContain("SIGTERM");
    expect(r.stderr, "a buffer overrun was attributed to the timeout").not.toContain("timed out");
    expect(r.stderr, "it named a bound it has no evidence was exceeded").not.toContain(String(GIT_TIMEOUT_MS));
  });

  test("a real timeout still names the bound — the control", () => {
    const err = Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" });
    const r = LIVE_GIT("/r", shaped({ signal: "SIGTERM", error: err }))(["fetch"]);

    expect(r.stderr).toContain("timed out");
    expect(r.stderr).toContain(String(GIT_TIMEOUT_MS));
  });

  test("an `undefined` status becomes null, so the never-ran guard can see it", () => {
    // Measured, and NOT what the fake had been saying: a missing binary
    // returns `status: undefined` under Bun, not null. `code: r.status`
    // therefore made `spec-source`'s `code === null` guard false, and a
    // `git` that is not installed walked past the one check written for
    // it and into a working-tree read.
    const err = Object.assign(new Error("spawnSync git ENOENT"), { code: "ENOENT" });
    const r = LIVE_GIT("/r", shaped({ status: undefined, error: err }))(["fetch"]);

    expect(r.code, "undefined is not null, and the guard tests for null").toBeNull();
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("never started");
  });

  test("real spawnSync: the three shapes are what this code claims they are", () => {
    // The pin, against the actual runtime. Assumed exit semantics have
    // cost this PR two rounds already.
    // late-env-ok: `sleep` reads no environment at all; this measures spawnSync's own timeout shape
    const t = spawnSync("sleep", ["5"], { timeout: 300, encoding: "utf-8" });
    expect(t.status).toBeNull();
    expect((t.error as NodeJS.ErrnoException | undefined)?.code).toBe("ETIMEDOUT");

    // late-env-ok: a binary that does not exist reads nothing; this measures the ENOENT shape
    const n = spawnSync("definitely-not-a-binary-xyz", [], { encoding: "utf-8" });
    expect(n.status, "a missing binary returns undefined, not null").toBeUndefined();
    expect((n.error as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
  });
});
