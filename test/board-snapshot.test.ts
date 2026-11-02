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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  REFUSAL_EXIT,
  main as boardSnapshotMain,
  type BoardSnapshotGitHub,
  type ProducedSnapshot,
} from "../scripts/board-snapshot";
import type { LiveIssue } from "../lib/live-issues";
import { readSnapshotText, takeReadings } from "../scripts/board-conformance";

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
}

/** One live issue, with the fields a case is not asserting on defaulted. */
const iss = (o: Partial<LiveIssue> & { number: number }): LiveIssue => ({
  state: "OPEN",
  milestone: null,
  blockedBy: [],
  labels: [],
  ...o,
});

/** Records whether the API was reached at all, and with what. */
function spy(live: Live[] = [], throwsOrOpts?: Error | SpyOptions) {
  const o: SpyOptions =
    throwsOrOpts instanceof Error ? { throws: throwsOrOpts } : (throwsOrOpts ?? {});
  const calls: string[] = [];
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
  };
  return { gh, calls };
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

  test("the CRITERION population is empty, because B2 has not wired it", async () => {
    // Emitting partial criterion data would make `criterion-coverage`
    // report SHORT — a number nobody measured. Empty makes it UNMEASURED,
    // which is the true thing to say about a source that does not exist.
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

  test("no issue carries a criteriaField key — that column was never read", async () => {
    // The key's ABSENCE is the signal `board-conformance` reads to report
    // `criteria-field` UNMEASURED. Writing `criteriaField: null` here
    // would make it say `0 of N — N short` about a Projects v2 field
    // nothing in this file can see.
    await withSpec(SPEC, async (dir, at) => {
      const { gh } = spy(CONFORMANT_LIVE, { issues: [iss({ number: 10, milestone: IN_PHASE_0 })] });
      const { text } = await capture([at, "--prefix", "Fix", "--repo", "o/n"], gh);
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
      const cases: { why: string; argv: string[] }[] = [
        { why: "no spec", argv: ["--prefix", "Fix", "--repo", "o/n"] },
        { why: "no --prefix", argv: [at, "--repo", "o/n"] },
        { why: "no spec on disk", argv: [join(_dir, "absent.md"), "--prefix", "Fix", "--repo", "o/n"] },
      ];
      for (const c of cases) {
        const { gh, calls } = spy(CONFORMANT_LIVE);
        expect(await boardSnapshotMain(c.argv, gh), `${c.why} did not refuse`).toBe(REFUSAL_EXIT);
        expect(calls, `${c.why} still reached the API`).toEqual([]);
      }
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

  test("--repo falls back to GITHUB_REPOSITORY, and refuses when neither is set", async () => {
    await withSpec(SPEC, async (_dir, at) => {
      const had = process.env.GITHUB_REPOSITORY;
      try {
        delete process.env.GITHUB_REPOSITORY;
        const bare = spy(CONFORMANT_LIVE);
        expect(await boardSnapshotMain([at, "--prefix", "Fix"], bare.gh)).toBe(REFUSAL_EXIT);
        expect(bare.calls).toEqual([]);

        process.env.GITHUB_REPOSITORY = "env/slug";
        const fromEnv = spy(CONFORMANT_LIVE);
        expect((await capture([at, "--prefix", "Fix"], fromEnv.gh)).code).toBe(0);
        expect(fromEnv.calls).toContain("listMilestones env/slug");
      } finally {
        if (had === undefined) delete process.env.GITHUB_REPOSITORY;
        else process.env.GITHUB_REPOSITORY = had;
      }
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

  test("the issues the producer emits drive blocked-by-edges, and criteria-field stays UNMEASURED", async () => {
    // The whole point of B3, asserted end to end through both files: an
    // unsequenced board reads SHORT, the same board with the edge reads
    // MET, and the column nobody queried never becomes a number.
    await withSpec(SPEC, async (_dir, at) => {
      const unsequenced = spy(CONFORMANT_LIVE, {
        issues: [
          iss({ number: 10, milestone: "Fix Phase 0 — the first one" }),
          iss({ number: 11, milestone: "Fix Phase 1 — the second one" }),
        ],
      });
      const before = readSnapshotText((await capture([at, "--prefix", "Fix", "--repo", "o/n"], unsequenced.gh)).text);
      const edges = (b: typeof before) => takeReadings(b.board!).find(r => r.name === "blocked-by-edges")!;
      expect(edges(before).status, "an unsequenced board read as sequenced").toBe("short");
      expect(edges(before).why).toContain("1 of 2");

      const sequenced = spy(CONFORMANT_LIVE, {
        issues: [
          iss({ number: 10, milestone: "Fix Phase 0 — the first one" }),
          iss({ number: 11, milestone: "Fix Phase 1 — the second one", blockedBy: [10] }),
        ],
      });
      const after = readSnapshotText((await capture([at, "--prefix", "Fix", "--repo", "o/n"], sequenced.gh)).text);
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
