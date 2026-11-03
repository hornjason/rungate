/**
 * `lib/spec-deps.ts` — the phase order as `blocked by` edges (#1647).
 *
 * ## Every case asserts MEMBERSHIP, not a count
 *
 * `.claude/rules/checks-must-be-able-to-fail.md`, seventh shape: predict the
 * membership, not just the total. A cross-product of 2x6 is twelve edges, and
 * twelve is also what you get from pairing the wrong two phases, from
 * reversing blocked and blocker, and from chaining the last phase to the
 * first. Each of those is a real way to write this function and a count
 * cannot see any of them, so the cases below name the pairs.
 *
 * ## And the write cases assert on the CALLS, not the exit code
 *
 * `scripts/plan-spec.ts` shipped a refusal that was computed AFTER its write
 * loop: every milestone was created and the command then exited 1. Nothing
 * reading an exit code can tell that apart from a refusal that stopped
 * something, so the negative cases here record what reached GitHub.
 */
import { describe, expect, test } from "bun:test";
import { join } from "path";
import { dependencyPlan, groupByBlocked } from "../lib/spec-deps";
import type { DepIssue } from "../lib/spec-deps";
import { REFUSAL_EXIT, main as planDepsMain } from "../scripts/plan-deps";
import type { PlanDepsGitHub } from "../scripts/plan-deps";

/** One issue, spelled the way the GraphQL read spells it. */
function iss(
  number: number,
  phase: number | null,
  opts: { state?: string; blockedBy?: number[] } = {},
): DepIssue {
  return {
    number,
    state: opts.state ?? "OPEN",
    milestone: phase === null ? null : `Convergence Phase ${phase} — whatever it is called`,
    blockedBy: opts.blockedBy ?? [],
  };
}

/** `blocked<-blocker`, so a reversal is visible in the assertion text. */
const keys = (es: readonly { blocked: number; blocker: number }[]): string[] =>
  es.map(e => `${e.blocked}<-${e.blocker}`).sort();

describe("lib/spec-deps: the edges are the adjacent-phase cross product", () => {
  test("two phases: every phase-1 issue is blocked by every phase-0 issue, and not the reverse", () => {
    const plan = dependencyPlan([iss(10, 0), iss(11, 0), iss(20, 1), iss(21, 1)]);
    expect(keys(plan.missing)).toEqual(["20<-10", "20<-11", "21<-10", "21<-11"]);
    // The reversal is the wrong answer with the same count. Name it.
    expect(keys(plan.missing)).not.toContain("10<-20");
    expect(plan.phases).toEqual([0, 1]);
  });

  test("three phases chain ADJACENTLY — phase 2 is not blocked by phase 0 directly", () => {
    const plan = dependencyPlan([iss(10, 0), iss(20, 1), iss(30, 2)]);
    expect(keys(plan.missing)).toEqual(["20<-10", "30<-20"]);
    // The full-prefix version is the other plausible implementation and it is
    // the one the header argues against. It would add this edge.
    expect(keys(plan.missing)).not.toContain("30<-10");
  });

  test("a GAP in the numbering chains the phases that EXIST, not N-1", () => {
    // Phase 2 carries nothing. `p - 1` would leave #30 blocked by a phase
    // with no issues — zero blockers — which reads as startable and puts the
    // LAST phase in the Ready lane beside the first.
    const plan = dependencyPlan([iss(10, 0), iss(20, 1), iss(30, 3)]);
    expect(plan.phases).toEqual([0, 1, 3]);
    expect(keys(plan.missing)).toEqual(["20<-10", "30<-20"]);
  });

  test("the lowest phase is blocked by nothing — that is the frontier", () => {
    const plan = dependencyPlan([iss(10, 0), iss(20, 1)]);
    expect(plan.missing.some(e => e.blocked === 10)).toBe(false);
    expect(plan.frontier).toBe(0);
  });
});

describe("lib/spec-deps: what it refuses to touch", () => {
  test("an edge it did not derive is EXTRA and never appears in missing", () => {
    // #1481 blocked by #1591 is live, real, and WITHIN a phase. A tool that
    // reconciled by deletion would destroy it.
    const plan = dependencyPlan([iss(10, 0), iss(20, 2), iss(21, 2, { blockedBy: [20] })]);
    expect(keys(plan.extra)).toEqual(["21<-20"]);
    expect(keys(plan.missing)).toEqual(["20<-10", "21<-10"]);
  });

  test("an already-present derived edge is PRESENT, so a re-run adds nothing", () => {
    const first = dependencyPlan([iss(10, 0), iss(20, 1)]);
    expect(keys(first.missing)).toEqual(["20<-10"]);
    // Replay the world as it is after `--write`.
    const second = dependencyPlan([iss(10, 0), iss(20, 1, { blockedBy: [10] })]);
    expect(second.missing).toEqual([]);
    expect(keys(second.present)).toEqual(["20<-10"]);
    expect(second.extra).toEqual([]);
  });

  test("an issue with no Phase milestone gets no edge and is reported", () => {
    const plan = dependencyPlan([iss(10, 0), iss(20, 1), iss(99, null)]);
    expect(plan.unphased).toEqual([99]);
    expect(plan.missing.some(e => e.blocked === 99 || e.blocker === 99)).toBe(false);
  });

  test("a CLOSED issue is neither blocked nor a blocker by default", () => {
    const plan = dependencyPlan([iss(10, 0, { state: "CLOSED" }), iss(11, 0), iss(20, 1)]);
    expect(keys(plan.missing)).toEqual(["20<-11"]);
    // The pair: asking for them puts both back, so the case above is about
    // the filter and not about #10 being malformed.
    const withClosed = dependencyPlan(
      [iss(10, 0, { state: "CLOSED" }), iss(11, 0), iss(20, 1)],
      { includeClosed: true },
    );
    expect(keys(withClosed.missing)).toEqual(["20<-10", "20<-11"]);
  });
});

/**
 * The WHOLE class of degenerate readings, as one table.
 *
 * Four review rounds each found a different input that walked between two
 * hand-written guards — the last was `phases.length === 0`, where issues
 * exist (so the empty check is skipped) and there is no single phase (so the
 * one-phase check is skipped), and the command prints *"the tracker already
 * carries the phase order"* about a board it could not read.
 *
 * So the cases below are not four more `if`s. They enumerate every route to
 * **fewer than two phases**, which is the property, and the last case is the
 * negative control: the only input that must reach none of them.
 */
describe("lib/spec-deps: every route to fewer than two phases is UNMEASURED", () => {
  const cases: [string, DepIssue[], { includeClosed?: boolean }, string][] = [
    ["nothing read", [], {}, "failed fetch"],
    [
      "read, but nothing considered — every issue closed",
      [iss(10, 0, { state: "CLOSED" }), iss(20, 1, { state: "CLOSED" })],
      {},
      "none was considered",
    ],
    [
      "considered, but NOT ONE carries a Phase milestone",
      [iss(10, null), iss(20, null), iss(30, null)],
      {},
      "NONE carries a Phase milestone",
    ],
    ["exactly one phase", [iss(10, 0), iss(11, 0)], {}, "one phase states no order"],
  ];
  for (const [name, issues, opts, reason] of cases) {
    test(`${name} is UNMEASURED, and says which`, () => {
      const plan = dependencyPlan(issues, opts);
      expect(plan.reading).toBe("UNMEASURED");
      expect(plan.unmeasuredReasons.join(" ")).toContain(reason);
      expect(plan.missing, "an edge was derived from a reading that could not be taken").toEqual([]);
    });
  }

  test("THE NEGATIVE CONTROL: two phases over a considered set reads MEASURED", () => {
    // Without this, every case above passes against a function that refuses
    // unconditionally — four green rows witnessing nothing.
    const plan = dependencyPlan([iss(10, 0), iss(20, 1)]);
    expect(plan.reading).toBe("MEASURED");
    expect(keys(plan.missing)).toEqual(["20<-10"]);
  });

  test("the unphased case is NOT the same as the no-issues case — the reasons differ", () => {
    // Both produce `missing: []`. Only the text distinguishes them, and the
    // whole point of the row is that a reader can act on which one it is.
    const empty = dependencyPlan([]).unmeasuredReasons.join(" ");
    const unphased = dependencyPlan([iss(10, null)]).unmeasuredReasons.join(" ");
    expect(unphased).not.toBe(empty);
    expect(unphased).toContain("plan-spec has not run");
  });

  test("a TRUNCATED blocker list refuses even when the phases are sound", () => {
    // Orthogonal to the count: two phases, a derivable order, and a live edge
    // list the reader could not see the end of. Deriving from it would re-add
    // an edge that already exists past the page boundary.
    const plan = dependencyPlan([
      iss(10, 0),
      { ...iss(20, 1), blockedBy: [10], blockedByTruncated: true },
    ]);
    expect(plan.reading).toBe("UNMEASURED");
    expect(plan.unmeasuredReasons.join(" ")).toContain("truncated");
    expect(plan.unmeasuredReasons.join(" ")).toContain("#20");
    // The pair: the identical input with the flag off is MEASURED.
    expect(dependencyPlan([iss(10, 0), iss(20, 1, { blockedBy: [10] })]).reading).toBe("MEASURED");
  });
});

describe("lib/spec-deps: the grouping is what reaches GitHub", () => {
  test("edges collapse to one call per BLOCKED issue, blockers sorted", () => {
    const plan = dependencyPlan([iss(10, 0), iss(11, 0), iss(20, 1), iss(21, 1)]);
    expect(groupByBlocked(plan.missing)).toEqual([
      { blocked: 20, blockers: [10, 11] },
      { blocked: 21, blockers: [10, 11] },
    ]);
  });

  test("the grouping loses no edge — 2x3 is six edges in three calls", () => {
    const plan = dependencyPlan([iss(1, 0), iss(2, 0), iss(7, 1), iss(8, 1), iss(9, 1)]);
    const groups = groupByBlocked(plan.missing);
    expect(groups).toHaveLength(3);
    expect(groups.flatMap(g => g.blockers.map(b => `${g.blocked}<-${b}`)).sort()).toEqual(
      keys(plan.missing),
    );
  });
});

/**
 * `scripts/plan-deps.ts --write` — what reaches GitHub, and when it does not.
 */
describe("scripts/plan-deps --write: nothing reaches GitHub on an unmeasured reading", () => {
  function spy(issues: DepIssue[]) {
    const calls: string[] = [];
    const gh: PlanDepsGitHub = {
      createClient: (() => ({}) as never) as PlanDepsGitHub["createClient"],
      readIssues: async () => issues,
      addBlockers: async (_repo, blocked, blockers) => {
        calls.push(`#${blocked} +${[...blockers].join(",")}`);
      },
    };
    return { gh, calls };
  }

  test("a sound two-phase reading writes, one call per blocked issue", async () => {
    const s = spy([iss(10, 0), iss(11, 0), iss(20, 1)]);
    const code = await planDepsMain(["--repo", "o/r", "--write", "--milestone-prefix", "Convergence"], s.gh);
    expect(s.calls).toEqual(["#20 +10,11"]);
    expect(code).toBe(0);
  });

  test("an EMPTY read writes nothing and refuses", async () => {
    const s = spy([]);
    const code = await planDepsMain(["--repo", "o/r", "--write", "--milestone-prefix", "Convergence"], s.gh);
    expect(s.calls, "an edge was written despite the refusal").toEqual([]);
    expect(code).toBe(REFUSAL_EXIT);
  });

  test("a SINGLE-PHASE read writes nothing and refuses", async () => {
    const s = spy([iss(10, 0), iss(11, 0)]);
    const code = await planDepsMain(["--repo", "o/r", "--write", "--milestone-prefix", "Convergence"], s.gh);
    expect(s.calls).toEqual([]);
    expect(code).toBe(REFUSAL_EXIT);
  });

  test("a FAILED write exits non-zero — the status is derived from what happened", async () => {
    // `applyEdges` catches each failure into a "FAILED" string and returns
    // it. Nothing read that array, so a run where every `gh issue edit` call
    // failed printed its failures among the successes and returned 0. The
    // same defect was fixed in `plan-issues` by this PR and left here.
    const gh: PlanDepsGitHub = {
      createClient: (() => ({}) as never) as PlanDepsGitHub["createClient"],
      readIssues: async () => [iss(10, 0), iss(20, 1)],
      addBlockers: async () => {
        throw new Error("gh: HTTP 503");
      },
    };
    const code = await planDepsMain(["--repo", "o/r", "--write", "--milestone-prefix", "Convergence"], gh);
    expect(code, "every write failed and the command reported success").toBe(REFUSAL_EXIT);
  });

  test("--json --write reports `partial` on a failed write, not `yes`", async () => {
    const out: string[] = [];
    const log = console.log;
    console.log = (x: string) => void out.push(x);
    const gh: PlanDepsGitHub = {
      createClient: (() => ({}) as never) as PlanDepsGitHub["createClient"],
      readIssues: async () => [iss(10, 0), iss(20, 1)],
      addBlockers: async () => {
        throw new Error("gh: HTTP 503");
      },
    };
    let code;
    try {
      code = await planDepsMain(["--repo", "o/r", "--write", "--json", "--milestone-prefix", "Convergence"], gh);
    } finally {
      console.log = log;
    }
    const json = JSON.parse(out.join("\n"));
    expect(json.wrote, "a run whose every write failed printed a clean status").toBe("partial");
    expect(json.results.join(" ")).toContain("FAILED");
    expect(code).toBe(REFUSAL_EXIT);
  });

  test("--json --write on a sound plan still reports `yes` and applies", async () => {
    // The pair for both cases above: without it they pass against a command
    // that reports "partial" unconditionally.
    const out: string[] = [];
    const log = console.log;
    console.log = (x: string) => void out.push(x);
    const s = spy([iss(10, 0), iss(20, 1)]);
    let code;
    try {
      code = await planDepsMain(["--repo", "o/r", "--write", "--json", "--milestone-prefix", "Convergence"], s.gh);
    } finally {
      console.log = log;
    }
    expect(JSON.parse(out.join("\n")).wrote).toBe("yes");
    expect(s.calls).toEqual(["#20 +10"]);
    expect(code).toBe(0);
  });

  test("a second --write run is a no-op — the command is idempotent", async () => {
    const s = spy([iss(10, 0), iss(20, 1, { blockedBy: [10] })]);
    const code = await planDepsMain(["--repo", "o/r", "--write", "--milestone-prefix", "Convergence"], s.gh);
    expect(s.calls, "an edge that already exists was written again").toEqual([]);
    expect(code).toBe(0);
  });

  test("--write never removes an EXTRA edge", async () => {
    const s = spy([iss(10, 0), iss(20, 1), iss(21, 1, { blockedBy: [20] })]);
    await planDepsMain(["--repo", "o/r", "--write", "--milestone-prefix", "Convergence"], s.gh);
    // Only the derived pair is added; nothing in the call list removes 21<-20
    // and `addBlockers` is the only mutation the seam exposes.
    expect(s.calls).toEqual(["#20 +10", "#21 +10"]);
  });

  test("--json --write writes too, and says which of the three states it was in", async () => {
    const out: string[] = [];
    const log = console.log;
    console.log = (x: string) => void out.push(x);
    const s = spy([iss(10, 0), iss(20, 1)]);
    try {
      await planDepsMain(["--repo", "o/r", "--write", "--json", "--milestone-prefix", "Convergence"], s.gh);
    } finally {
      console.log = log;
    }
    expect(s.calls).toEqual(["#20 +10"]);
    expect(JSON.parse(out.join("\n")).wrote).toBe("yes");
  });

  test("--json --write on an unmeasured reading reports `refused`, and writes nothing", async () => {
    const out: string[] = [];
    const log = console.log;
    console.log = (x: string) => void out.push(x);
    const s = spy([]);
    let code;
    try {
      code = await planDepsMain(["--repo", "o/r", "--write", "--json", "--milestone-prefix", "Convergence"], s.gh);
    } finally {
      console.log = log;
    }
    expect(s.calls).toEqual([]);
    expect(code).toBe(REFUSAL_EXIT);
    expect(JSON.parse(out.join("\n")).wrote).toBe("refused");
  });

  test("no --repo and no GITHUB_REPOSITORY refuses before reading anything", async () => {
    const s = spy([iss(10, 0), iss(20, 1)]);
    const saved = process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPOSITORY;
    try {
      // The prefix is supplied even though this case is about the repo.
      // Without it, #1728's new refusal fires too and the exit code is
      // overdetermined — the case would stay green with the repo guard
      // deleted. One missing thing at a time.
      expect(await planDepsMain(["--write", "--milestone-prefix", "Convergence"], s.gh)).toBe(REFUSAL_EXIT);
      expect(s.calls).toEqual([]);
    } finally {
      if (saved !== undefined) process.env.GITHUB_REPOSITORY = saved;
    }
  });
});

/**
 * The live convergence set, as a regression control.
 *
 * These numbers are a snapshot of a real board and will move. What must not
 * move is the SHAPE: the frontier is blocked by nothing, each later phase is
 * blocked by exactly the size of the phase before it, and the two
 * hand-authored within-phase edges are reported as EXTRA rather than planned.
 */
/**
 * `--milestone-prefix` (item **B3**).
 *
 * `phaseOf` reads `Phase <n>` out of a milestone title and nothing else, so
 * two specs that both numbered their phases put unrelated issues in the same
 * phase. Measured on hornjason/rungate 2026-11-01: an unfiltered run derived
 * 48 edges across 28 issues, and the engine issues in Pipeline Phase 5 came
 * out blocked by #1162, #1656 and #1657 — three issues from a different
 * spec's Phase 4, which block them in no sense anybody intended.
 *
 * The flag narrows the POPULATION, which is the only thing that can fix
 * this: the edge derivation is right about the order it is given, and what
 * it is given has to be one spec's issues.
 */
describe("scripts/plan-deps --milestone-prefix: one spec's issues, not every Phase N", () => {
  /** An issue in a named milestone family, so two can be mixed in one read. */
  const fam = (number: number, family: string, phase: number): DepIssue => ({
    number,
    state: "OPEN",
    milestone: `${family} Phase ${phase} — a heading`,
    blockedBy: [],
  });

  function spy(issues: DepIssue[]) {
    const calls: string[] = [];
    const gh: PlanDepsGitHub = {
      createClient: (() => ({}) as never) as PlanDepsGitHub["createClient"],
      readIssues: async () => issues,
      addBlockers: async (_repo, blocked, blockers) => {
        calls.push(`#${blocked} +${[...blockers].join(",")}`);
      },
    };
    return { gh, calls };
  }

  const MIXED = [fam(10, "Pipeline", 0), fam(11, "Pipeline", 1), fam(20, "Other", 0), fam(21, "Other", 1)];

  test("OMITTING it refuses — an unscoped run is the defect, not the default (#1728)", async () => {
    // This case previously asserted the opposite: that omitting the flag
    // sequenced both families together, recorded so that "adding the flag
    // cannot silently change the default for every existing caller."
    // #1728 measured what that default costs — a `--write` with no prefix
    // resolved 89 edges across 38 issues spanning `Pipeline Phase 0..9`
    // and `Convergence Phase 0..6`, and `board-conformance --prefix
    // Pipeline` scores only the first, so `blocked-by-edges` fell 12 of 12
    // to 4 of 12 on edges the reading cannot resolve.
    //
    // There is no caller to protect: no workflow, script or CI job invokes
    // `plan-deps`, and `lib/cli-commands.ts`'s usage string never listed
    // the flag. `plan-spec` and `board-snapshot` both REQUIRE `--prefix`
    // for the reason plan-spec states — deriving the family silently calls
    // the live milestones something they are not. This makes the third
    // tool agree, which is the Stage B retro improvement "two tools that
    // write the same board agree about which issues ARE the board".
    for (const argv of [
      ["--repo", "o/r", "--write"],
      ["--repo", "o/r"], // the dry run misleads too — it is what you read before writing
    ]) {
      const s = spy(MIXED);
      expect(await planDepsMain(argv, s.gh), `${argv.join(" ")} was accepted`).toBe(REFUSAL_EXIT);
      expect(s.calls, "an unscoped run wrote edges across both families").toEqual([]);
    }
  });

  test("with it, only that family is read and only its edges are written", async () => {
    const s = spy(MIXED);
    expect(await planDepsMain(["--repo", "o/r", "--write", "--milestone-prefix", "Pipeline"], s.gh)).toBe(0);
    expect(s.calls).toEqual(["#11 +10"]);
  });

  test("every near miss is OUT — no milestone, the prefix mid-title, or a LONGER family name", async () => {
    // The last row is round 2 of #1703: a bare `startsWith` admits any
    // family whose name begins with this one, which is the contamination
    // the flag exists to prevent arriving through the fix for it.
    const s = spy([
      ...MIXED,
      { number: 30, state: "OPEN", milestone: null, blockedBy: [] },
      { number: 31, state: "OPEN", milestone: "Not Pipeline Phase 1 — mid-title", blockedBy: [] },
      { number: 32, state: "OPEN", milestone: "Pipelines Phase 1 — a longer name", blockedBy: [] },
      { number: 33, state: "OPEN", milestone: "Pipeline — no phase at all", blockedBy: [] },
    ]);
    expect(await planDepsMain(["--repo", "o/r", "--write", "--milestone-prefix", "Pipeline"], s.gh)).toBe(0);
    expect(s.calls).toEqual(["#11 +10"]);
  });

  test("a prefix that is a PREFIX of the real family name matches nothing", async () => {
    // `--milestone-prefix Pipe` against `Pipeline Phase N` used to admit
    // the whole family and sequence it as if it were the caller's own.
    const s = spy(MIXED);
    expect(await planDepsMain(["--repo", "o/r", "--write", "--milestone-prefix", "Pipe"], s.gh)).toBe(
      REFUSAL_EXIT,
    );
    expect(s.calls, "a truncated prefix sequenced another family's issues").toEqual([]);
  });

  test('an EMPTY prefix refuses — it is not "no filter requested"', async () => {
    // Round 1 of #1703. `"".startsWith("")` is true for every string,
    // including the `""` a null milestone normalises to, so
    // `--milestone-prefix "$X"` with $X unset quietly re-admits every
    // spec's issues and reports success — the exact contamination the
    // flag exists to prevent.
    for (const empty of ["", "   "]) {
      const s = spy(MIXED);
      expect(
        await planDepsMain(["--repo", "o/r", "--write", "--milestone-prefix", empty], s.gh),
        `--milestone-prefix ${JSON.stringify(empty)} was accepted`,
      ).toBe(REFUSAL_EXIT);
      expect(s.calls, "an empty prefix wrote the unfiltered population").toEqual([]);
    }

    // The control, and it had to change shape when #1728 made an omitted
    // flag a refusal too. It used to be "omitting it still writes", which
    // can no longer distinguish anything. A VALID prefix still writing is
    // what rules out a guard that refuses every run — the property the
    // old control was actually buying.
    const valid = spy(MIXED);
    expect(await planDepsMain(["--repo", "o/r", "--write", "--milestone-prefix", "Pipeline"], valid.gh)).toBe(0);
    expect(valid.calls.length).toBeGreaterThan(0);
  });

  test("a prefix matching nothing says THAT, not 'no issues were read'", async () => {
    // The exit code alone cannot carry this: an unknown-flag refusal, an
    // empty repository and a typo'd prefix are all 1, and only one of them
    // is about the prefix. A reader told "an empty repository and a failed
    // fetch produce the same empty edge list" goes and checks the API.
    const s = spy(MIXED);
    const said: string[] = [];
    const err = console.error;
    console.error = (...a: unknown[]) => void said.push(a.join(" "));
    try {
      expect(await planDepsMain(["--repo", "o/r", "--write", "--milestone-prefix", "Nope"], s.gh)).toBe(
        REFUSAL_EXIT,
      );
    } finally {
      console.error = err;
    }
    expect(s.calls, "a prefix that matched nothing still wrote").toEqual([]);
    const text = said.join("\n");
    expect(text).toContain('"Nope"');
    expect(text).toContain("4 issue(s) were read");
    expect(text, "it blamed the read for what the filter did").not.toContain("no issues were read");
  });

  /**
   * Round 1 of #1705. The emptiness guard tested `prefix.trim() === ""` and
   * the filter then used the UNTRIMMED value, so the two disagreed about
   * every input with whitespace on an end: `" Pipeline"` passes the guard,
   * matches nothing, and refuses with a message naming a string that looks
   * like it should obviously match.
   *
   * The pair of cases below is the point. Trimming only the GUARD is the
   * state this is leaving; trimming only the FILTER would accept `"   "` and
   * silently sequence every family. One trimmed reading feeds both.
   */
  test("a prefix with whitespace on an end is TRIMMED, not refused for matching nothing", async () => {
    for (const padded of [" Pipeline", "Pipeline ", "  Pipeline  ", "\tPipeline\n"]) {
      const s = spy(MIXED);
      expect(
        await planDepsMain(["--repo", "o/r", "--write", "--milestone-prefix", padded], s.gh),
        `--milestone-prefix ${JSON.stringify(padded)} was refused`,
      ).toBe(0);
      expect(s.calls, `${JSON.stringify(padded)} did not reach the Pipeline family`).toEqual([
        "#11 +10",
      ]);
    }
  });

  test("trimming touches the ENDS only — a family name with a space inside survives", async () => {
    // The control for the case above. `replaceAll(" ", "")` and a
    // `trim()`-shaped fix are the same on every input there; this input
    // separates them, and a prefix of two words is the ordinary case on a
    // tracker carrying more than one spec.
    const s = spy([
      { number: 40, state: "OPEN", milestone: "Spec Two Phase 0 — a", blockedBy: [] },
      { number: 41, state: "OPEN", milestone: "Spec Two Phase 1 — b", blockedBy: [] },
    ]);
    expect(await planDepsMain(["--repo", "o/r", "--write", "--milestone-prefix", " Spec Two "], s.gh)).toBe(0);
    expect(s.calls).toEqual(["#41 +40"]);
  });
});

/**
 * `--json` is a CONTRACT, and a refusal has to keep it — round 1 of #1705.
 *
 * `--json` is documented as "the whole plan, for something other than a
 * person". Four refusals returned before the `--json` block, so a caller
 * doing `JSON.parse(stdout)` got an empty string and a crash where it should
 * have got a structured `wrote: "refused"` payload. The UNMEASURED-from-
 * `dependencyPlan` case already honoured both channels; these four did not,
 * which is the population.
 *
 * Each case asserts the payload PARSES and says which refusal it was. An
 * exit code cannot carry that: all four are 1.
 */
describe("scripts/plan-deps --json: every refusal reaches the channel the caller asked for", () => {
  function spy(issues: DepIssue[]) {
    const calls: string[] = [];
    const gh: PlanDepsGitHub = {
      createClient: (() => ({}) as never) as PlanDepsGitHub["createClient"],
      readIssues: async () => issues,
      addBlockers: async (_repo, blocked, blockers) => {
        calls.push(`#${blocked} +${[...blockers].join(",")}`);
      },
    };
    return { gh, calls };
  }

  const MIXED: DepIssue[] = [
    { number: 10, state: "OPEN", milestone: "Pipeline Phase 0 — a", blockedBy: [] },
    { number: 11, state: "OPEN", milestone: "Pipeline Phase 1 — b", blockedBy: [] },
  ];

  /** Runs `main` with both channels captured, so neither can hide. */
  async function run(argv: string[], gh: PlanDepsGitHub) {
    const out: string[] = [];
    const err: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    console.error = (...a: unknown[]) => void err.push(a.join(" "));
    try {
      const code = await planDepsMain(argv, gh);
      return { code, stdout: out.join("\n"), stderr: err.join("\n") };
    } finally {
      console.log = log;
      console.error = error;
    }
  }

  const REFUSALS: { why: string; argv: string[]; names: string }[] = [
    { why: "an unparseable argument", argv: ["--repo", "o/r", "--nonsense"], names: "nonsense" },
    { why: "no --repo", argv: [], names: "--repo" },
    { why: "a blank --milestone-prefix", argv: ["--repo", "o/r", "--milestone-prefix", "   "], names: "blank" },
    {
      why: "a --milestone-prefix matching nothing",
      argv: ["--repo", "o/r", "--milestone-prefix", "Nope"],
      names: "Nope",
    },
  ];

  for (const r of REFUSALS) {
    test(`${r.why} still emits a parseable payload under --json`, async () => {
      const s = spy(MIXED);
      const saved = process.env.GITHUB_REPOSITORY;
      delete process.env.GITHUB_REPOSITORY;
      let got;
      try {
        got = await run([...r.argv, "--json", "--write"], s.gh);
      } finally {
        if (saved !== undefined) process.env.GITHUB_REPOSITORY = saved;
      }
      expect(got.code, "the refusal stopped reporting a failure").toBe(REFUSAL_EXIT);
      expect(s.calls, "a refusal still wrote").toEqual([]);

      let payload: { wrote?: string; reading?: string; unmeasuredReasons?: string[] };
      try {
        payload = JSON.parse(got.stdout);
      } catch {
        throw new Error(
          `--json refusal (${r.why}) put nothing parseable on stdout. stdout was ` +
            `${JSON.stringify(got.stdout)}; stderr was ${JSON.stringify(got.stderr)}`,
        );
      }
      expect(payload.wrote, "the payload did not say the write was refused").toBe("refused");
      expect(payload.reading).toBe("UNMEASURED");
      expect(
        (payload.unmeasuredReasons ?? []).join(" "),
        "the payload refused without saying which refusal it was",
      ).toContain(r.names);
    });
  }

  test("the blank refusal's advice is one the tool accepts — no circle", async () => {
    // Found in review of #1730. The blank-prefix message was written when an
    // omitted flag meant "no filter", and said so: "omit the flag if you
    // meant no filter." This PR makes an omitted flag a refusal, so a caller
    // who followed that sentence was sent straight into the next refusal and
    // round-tripped between two error messages with no way out.
    //
    // Both halves are run rather than asserted about, because the defect is
    // precisely that the advice and the behaviour disagreed and each was
    // individually correct.
    const saved = process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPOSITORY;
    try {
      const blank = await run(["--repo", "o/r", "--milestone-prefix", "   "], spy(MIXED).gh);
      const omitted = await run(["--repo", "o/r"], spy(MIXED).gh);
      expect(blank.code, "the blank refusal stopped refusing").toBe(REFUSAL_EXIT);

      // The premise. If omitting were accepted the advice would be fine and
      // this case would be asserting a style preference.
      expect(
        omitted.code,
        "omitting the flag is accepted, so the blank message's advice works and " +
          "this case is measuring nothing",
      ).toBe(REFUSAL_EXIT);

      // So the blank message may not send the caller there.
      expect(
        blank.stderr.toLowerCase(),
        "the blank refusal still tells the caller to omit a flag the very next " +
          "check refuses — following the advice reaches the absent-prefix " +
          "refusal and the caller is in a loop between two error messages",
      ).not.toContain("omit the flag");

      // And it must name the remedy that does work, or the caller is told
      // what not to do and nothing else. Deleting the advice is the cheapest
      // wrong fix for the assertion above.
      expect(
        blank.stderr,
        "the blank refusal names no working remedy — it says the prefix is blank " +
          "and leaves the caller to guess",
      ).toContain("--milestone-prefix");
      expect(blank.stderr).toMatch(/--milestone-prefix \w/);
    } finally {
      if (saved !== undefined) process.env.GITHUB_REPOSITORY = saved;
    }
  });

  /**
   * Round 2 of #1705. `readLiveIssues` throws rather than returning an empty
   * list — a caller that cannot tell "no issues" from "the call failed"
   * reports the flattering one. Nothing caught it here, so a bad token, a
   * rate limit or an outage left `main()` rejecting: a stack trace on
   * stderr and an EMPTY stdout, which under `--json` is the same crash the
   * four cases above exist to stop, on the input that needs the payload
   * most.
   */
  const THROWS: PlanDepsGitHub = {
    createClient: (() => ({}) as never) as PlanDepsGitHub["createClient"],
    readIssues: async () => {
      throw new Error("gh: HTTP 403 — Bad credentials");
    },
    addBlockers: async () => {},
  };

  // Every case below passes `--milestone-prefix`, and that is not noise: the
  // prefix is resolved BEFORE the network read (review of #1730), so a run
  // that omits it never reaches the read at all. The case that asserts that
  // ordering is at the bottom of this block.
  test("a FAILED issue read refuses on the --json channel, not as a rejection", async () => {
    const got = await run(["--repo", "o/r", "--json", "--write", "--milestone-prefix", "Pipeline"], THROWS);
    expect(got.code).toBe(REFUSAL_EXIT);
    const payload = JSON.parse(got.stdout);
    expect(payload.wrote).toBe("refused");
    expect(payload.reading).toBe("UNMEASURED");
    expect(
      payload.unmeasuredReasons.join(" "),
      "the payload refused without naming what the API said",
    ).toContain("403");
  });

  test("the same failure on the TEXT channel says so too, and is not a stack trace", async () => {
    const got = await run(["--repo", "o/r", "--write", "--milestone-prefix", "Pipeline"], THROWS);
    expect(got.code).toBe(REFUSAL_EXIT);
    expect(got.stdout.trim()).toBe("");
    expect(got.stderr).toContain("403");
    expect(got.stderr, "a failed read was reported as an empty repository").not.toContain(
      "0 issue(s) read",
    );
  });

  test("a client that cannot be built is the same refusal, not a rejection", async () => {
    // `createClient` is the other call on this path that can throw, and a
    // repair of only the one the finding named leaves it. Both go through
    // the same guard.
    const noClient: PlanDepsGitHub = {
      createClient: (() => {
        throw new Error("no GITHUB_TOKEN in the environment");
      }) as PlanDepsGitHub["createClient"],
      readIssues: async () => MIXED,
      addBlockers: async () => {},
    };
    const got = await run(["--repo", "o/r", "--json", "--milestone-prefix", "Pipeline"], noClient);
    expect(got.code).toBe(REFUSAL_EXIT);
    expect(JSON.parse(got.stdout).unmeasuredReasons.join(" ")).toContain("GITHUB_TOKEN");
  });

  test("a MISSING prefix is refused BEFORE the read, so the message is the actionable one", async () => {
    // Review of #1730. With the prefix check below the read, the one mistake
    // #1728 exists to catch reports as "the issues could not be read" on any
    // tree whose `gh` cannot authenticate — the API's problem, not the
    // caller's, and the actionable sentence never arrives.
    //
    // Both assertions are needed and neither implies the other. The message
    // alone would pass if the read ran and threw and something downstream
    // re-refused; `calls === 0` alone would pass if the refusal said the
    // wrong thing. A static argument check must not depend on the network.
    let calls = 0;
    const counted: PlanDepsGitHub = {
      createClient: (() => ({}) as never) as PlanDepsGitHub["createClient"],
      readIssues: async () => {
        calls++;
        throw new Error("gh: HTTP 403 — Bad credentials");
      },
      addBlockers: async () => {},
    };
    const got = await run(["--repo", "o/r", "--json"], counted);
    expect(got.code).toBe(REFUSAL_EXIT);
    const reasons = JSON.parse(got.stdout).unmeasuredReasons.join(" ");
    expect(reasons).toContain("--milestone-prefix is required");
    expect(reasons, "the API's failure was reported instead of the caller's").not.toContain("403");
    expect(calls, "the network was read before a static argument was checked").toBe(0);
  });

  test("the text header NAMES the scope it measured, both counts and the prefix", async () => {
    // Review of #1730, round 3. Two `prefix === undefined` branches were
    // left behind when the flag became required, and deleting both broke
    // no test — so nothing asserted this line at all, which is why a dead
    // branch could sit in it reading as a reachable unscoped path.
    //
    // Three facts, because the filtered count alone cannot show that a
    // filter ran: MIXED carries issues from two families, so `read` and
    // `issues` must differ here. A header that printed one number twice
    // would pass an assertion naming only the total.
    // A LOCAL fixture, not the `MIXED` in this describe — that one is
    // Pipeline-only, so it cannot show a filter narrowing anything.
    const families: DepIssue[] = [
      { number: 10, state: "OPEN", milestone: "Pipeline Phase 0 — a", blockedBy: [] },
      { number: 11, state: "OPEN", milestone: "Pipeline Phase 1 — b", blockedBy: [] },
      { number: 20, state: "OPEN", milestone: "Convergence Phase 0 — c", blockedBy: [] },
    ];
    const scoped = families.filter(i => (i.milestone ?? "").startsWith("Pipeline")).length;
    expect(scoped, "the fixture stopped mixing families, so this case cannot see a filter run")
      .toBeLessThan(families.length);

    const got = await run(["--repo", "o/r", "--milestone-prefix", "Pipeline"], spy(families).gh);
    expect(got.code, got.stderr).toBe(0);
    expect(got.stdout).toContain(`${scoped} issue(s) read`);
    expect(got.stdout).toContain(`of ${families.length}, narrowed to milestones starting "Pipeline"`);
  });

  test("the follow-up `plan-issues --repair` PRINTS is a command this still accepts", async () => {
    // Review of #1730, round 2. Making the flag required made somebody
    // else's advice stale: `plan-issues --write` prints a `plan-deps` line
    // as the exact next step, and that line carried no prefix, so a reader
    // who followed it got a refusal. Advice that cannot run is worse than
    // none — the reader learns it is stale only after acting on it.
    //
    // The printed string is READ OUT OF THE SOURCE and executed here
    // rather than copied into an expectation. A `toContain` would hold
    // just as well against a line that is stale in some NEW way, which is
    // the whole failure mode: this asserts the command runs, not that it
    // looks like it used to.
    const src = await Bun.file(join(import.meta.dir, "..", "scripts", "plan-issues.ts")).text();
    const printed = src.match(/rungate plan-deps ([^`\n\\]*)/);
    expect(printed, "plan-issues no longer prints a plan-deps follow-up — delete this case or follow it").not.toBeNull();

    const argv = printed![1]!
      .trim()
      .split(/\s+/)
      // The two placeholders the printed line carries. `${repo}` is a
      // template hole in the source; `<name>` is deliberate, because a
      // repair cannot know which family the issues that STAYED belong to.
      .map(a => (a === "${repo}" ? "o/r" : a === "<name>" ? "Pipeline" : a));

    const s = spy(MIXED);
    const got = await run(argv, s.gh);
    expect(
      got.code,
      `the follow-up plan-issues prints is refused by plan-deps:\n  rungate plan-deps ${argv.join(" ")}\n${got.stderr}`,
    ).toBe(0);
  });

  test("the control: a read that SUCCEEDS is not reported as a failed one", async () => {
    const got = await run(["--repo", "o/r", "--json", "--milestone-prefix", "Pipeline"], spy(MIXED).gh);
    expect(got.code).toBe(0);
    expect(JSON.parse(got.stdout).reading).toBe("MEASURED");
  });

  test("WITHOUT --json those same four stay on stderr and leave stdout empty", async () => {
    // The control. A fix that emits JSON unconditionally passes every case
    // above and breaks every human caller, and nothing above can see it.
    const saved = process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPOSITORY;
    try {
      for (const r of REFUSALS) {
        const s = spy(MIXED);
        const got = await run([...r.argv, "--write"], s.gh);
        expect(got.code).toBe(REFUSAL_EXIT);
        expect(got.stdout.trim(), `${r.why} printed a payload nobody asked for`).toBe("");
        expect(got.stderr, `${r.why} said nothing on stderr`).toContain(r.names);
      }
    } finally {
      if (saved !== undefined) process.env.GITHUB_REPOSITORY = saved;
    }
  });

  test("a SOUND --json run is unchanged — same keys, and `wrote` is not `refused`", async () => {
    // Without this, a refusal payload that happens to be well-formed proves
    // nothing about the shape a consumer actually switches on.
    const s = spy(MIXED);
    const got = await run(["--repo", "o/r", "--json", "--write", "--milestone-prefix", "Pipeline"], s.gh);
    expect(got.code).toBe(0);
    const payload = JSON.parse(got.stdout);
    expect(payload.wrote).toBe("yes");
    expect(payload.reading).toBe("MEASURED");
    for (const key of ["reading", "unmeasuredReasons", "phases", "missing", "present", "extra", "results", "wrote"]) {
      expect(Object.keys(payload), `the success payload lost \`${key}\``).toContain(key);
    }
  });

  test("the refusal payload carries every key the success payload does", async () => {
    // A consumer reading `.missing.length` on a refusal must get `[]`, not a
    // TypeError. The two shapes are asserted against each other rather than
    // against a hand-copied list, so neither can drift alone.
    const sound = await run(["--repo", "o/r", "--json", "--milestone-prefix", "Pipeline"], spy(MIXED).gh);
    const refused = await run(["--repo", "o/r", "--json", "--milestone-prefix", "Nope"], spy(MIXED).gh);
    const soundKeys = Object.keys(JSON.parse(sound.stdout)).sort();
    const refusedKeys = Object.keys(JSON.parse(refused.stdout)).sort();
    expect(refusedKeys).toEqual(soundKeys);
  });
});

describe("the shape the live convergence board has", () => {
  const phaseSizes = [2, 6, 8, 4, 3, 10, 6];
  const issues: DepIssue[] = [];
  let next = 1;
  phaseSizes.forEach((size, phase) => {
    for (let k = 0; k < size; k++) issues.push(iss(next++, phase));
  });

  test("194 edges over 37 blocked issues, and the frontier carries none", () => {
    const plan = dependencyPlan(issues);
    const expected = phaseSizes.slice(1).reduce((sum, size, k) => sum + size * phaseSizes[k], 0);
    expect(expected).toBe(194);
    expect(plan.missing).toHaveLength(194);
    expect(groupByBlocked(plan.missing)).toHaveLength(37);
    expect(plan.missing.some(e => e.blocked <= phaseSizes[0])).toBe(false);
  });

  test("each issue carries exactly the previous phase's size in blockers", () => {
    const plan = dependencyPlan(issues);
    const counts = new Map<number, number>();
    for (const e of plan.missing) counts.set(e.blocked, (counts.get(e.blocked) ?? 0) + 1);
    let n = phaseSizes[0] + 1;
    for (let p = 1; p < phaseSizes.length; p++) {
      for (let k = 0; k < phaseSizes[p]; k++, n++) {
        expect(counts.get(n), `issue ${n} in phase ${p}`).toBe(phaseSizes[p - 1]);
      }
    }
  });
});
