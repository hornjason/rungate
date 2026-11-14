/**
 * Covers SC-2600 (SPEC-TO-BOARD-PIPELINE-SPEC.md).
 *
 * `lib/spec-placement.ts` — the placement table, and the milestones derived
 * from it (#1647).
 *
 * Every case here plants a whole document and runs it through the real
 * parser. None of them reimplements the id extraction or the cell split: a
 * control that reimplements the thing it controls proves `Array.filter`
 * works, and it goes green under exactly the mutations that matter
 * (`.claude/rules/checks-must-be-able-to-fail.md`, *two deciders that
 * agree*). That specific mistake was made in this file's sibling, caught by
 * a reviewer on #1647, and is the reason the helper below builds text.
 *
 * ## What was broken to prove each case can fail
 *
 * Each `*_violation` case is paired with a `*_clean` assertion over a
 * document differing in ONE row, so the red is attributable to that row and
 * not to the plant being malformed. The pairs are stated in each case's
 * name. Without the pair, a plant with a typo'd heading reports every
 * criterion unplaced and every case passes for the instrument's reason.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  NON_PHASE_PLACEMENTS,
  PLACEMENT_HEADING,
  milestoneBody,
  milestonePlan,
  parsePhaseHeadings,
  parsePlacementRows,
  placementCoverage,
  placementReading,
  uncoveredByMilestone,
} from "../lib/spec-placement";
import { REFUSAL_EXIT, main as planSpecMain } from "../scripts/plan-spec";
import type { PlanSpecGitHub } from "../scripts/plan-spec";

const REPO = join(import.meta.dir, "..");

/** A whole spec document: criteria, phase headings, then a placement table. */
function plant(opts: {
  criteria?: string[];
  phases?: [number, string][];
  rows?: [string, string][];
  heading?: string;
}): string {
  const criteria = opts.criteria ?? ["CRC-A1", "CRC-A2", "CRC-A3"];
  const phases = opts.phases ?? [
    [1, "stop the repeats"],
    [2, "stop the false findings"],
  ];
  const rows = opts.rows ?? [
    ["**Phase 1**", "CRC-A1, CRC-A2"],
    ["**Phase 2**", "CRC-A3"],
  ];
  return [
    "---",
    "doc-type: spec",
    "---",
    "",
    "# Planted",
    "",
    ...criteria.map((id, i) => `- [ ] ${id}: criterion number ${i + 1}`),
    "",
    ...phases.flatMap(([n, t]) => [`### Phase ${n} — ${t}`, "", "Some prose.", ""]),
    opts.heading ?? `${PLACEMENT_HEADING} — every criterion has exactly one home`,
    "",
    "| Placement | Criteria | What the value means |",
    "|---|---|---|",
    ...rows.map(([p, ids]) => `| ${p} | ${ids} | because |`),
    "",
    "### Exit conditions",
    "",
    "Nothing here.",
  ].join("\n");
}

/**
 * Covers SC-2611 (SPEC-TO-BOARD-PIPELINE-SPEC.md).
 *
 * `placementReading` answers the question for ONE spec and both of its
 * callers are handed a spec on the command line, so a spec with no
 * `### Phase placement` table contributed nothing to any whole-tree view:
 * no phases, so no milestone, so no lane. 1 of 26 specs had a table on
 * 2026-10-29 and the other 25 were indistinguishable from specs with no
 * work left (#1681).
 *
 * Every case hands `placementCoverage` its own enumerator and reader, so
 * none of them depends on what `specs/` happens to contain today.
 */
describe("SC-2611: a spec with no placement table is UNPLANNED, not absent", () => {
  const sweep = (...paths: string[]) => () =>
    ({ reading: "MEASURED" as const, unmeasuredReasons: [], paths });
  const files = (m: Record<string, string>) => (_root: string, path: string) => {
    const c = m[path];
    if (c === undefined) throw new Error(`no such planted spec: ${path}`);
    return c;
  };

  const NO_TABLE = plant({ heading: "### Something else entirely" });
  const NO_CRITERIA_SPEC = plant({ criteria: [], rows: [] });

  test("a spec stating criteria and placing none is NAMED as UNPLANNED", () => {
    const r = placementCoverage("/x", sweep("specs/A.md"), files({ "specs/A.md": NO_TABLE }));
    expect(r.reading).toBe("MEASURED");
    // The membership, not the count: a reader has to be able to open it.
    expect(r.unplanned).toEqual(["specs/A.md"]);
    expect(r.specs[0]!.criteria).toBe(3);
    expect(r.specs[0]!.placed).toBe(0);
    // And the reason travels with it, or the name is a number again.
    expect(r.specs[0]!.reasons.join(" ")).toContain(PLACEMENT_HEADING);
  });

  test("a spec that places its criteria is PLANNED, and carries no reason", () => {
    const r = placementCoverage("/x", sweep("specs/A.md"), files({ "specs/A.md": plant({}) }));
    expect(r.planned).toEqual(["specs/A.md"]);
    expect(r.unplanned).toEqual([]);
    expect(r.specs[0]!.reasons).toEqual([]);
    expect(r.specs[0]!.placed).toBe(3);
  });

  test("NO_CRITERIA is NOT unplanned — that distinction is the whole criterion", () => {
    // Folding "nothing to place" into "placed nothing" reproduces the defect
    // one level up: the count would be honest and still unactionable.
    const r = placementCoverage(
      "/x",
      sweep("specs/A.md", "specs/B.md"),
      files({ "specs/A.md": NO_CRITERIA_SPEC, "specs/B.md": NO_TABLE }),
    );
    expect(r.noCriteria).toEqual(["specs/A.md"]);
    expect(r.unplanned).toEqual(["specs/B.md"]);
    expect(r.planned).toEqual([]);
  });

  test("one unreadable spec makes the WHOLE reading unmeasured, and names the file", () => {
    // A shorter list is exactly what a tree with fewer specs produces.
    const r = placementCoverage(
      "/x",
      sweep("specs/A.md", "specs/GONE.md"),
      files({ "specs/A.md": plant({}) }),
    );
    expect(r.reading).toBe("UNMEASURED");
    expect(r.unmeasuredReasons.join(" ")).toContain("specs/GONE.md");
    expect(r.specs.find(s => s.path === "specs/GONE.md")!.state).toBe("UNREADABLE");
    // The three roll-ups must be EMPTY on a refusal: a populated `planned`
    // beside UNMEASURED is the partial result the refusal exists to prevent.
    expect([r.planned, r.unplanned, r.noCriteria]).toEqual([[], [], []]);
  });

  test("an unmeasured sweep reads nothing at all — not a partial tree", () => {
    const read = (_r: string, _p: string): string => {
      throw new Error("the reader must not be called when the sweep refused");
    };
    const r = placementCoverage(
      "/x",
      () => ({ reading: "UNMEASURED", unmeasuredReasons: ["this runtime cannot locate them"], paths: ["specs/A.md"] }),
      read,
    );
    expect(r.reading).toBe("UNMEASURED");
    expect(r.specs).toEqual([]);
    expect(r.unmeasuredReasons.join(" ")).toContain("cannot locate them");
  });
});

describe("lib/spec-placement: the table parses, and parses only the table", () => {
  test("rows come from the second cell, and prose outside the section is not a placement", () => {
    const rows = parsePlacementRows(plant({}));
    expect(rows.map(r => r.placement)).toEqual(["Phase 1", "Phase 2"]);
    expect(rows.flatMap(r => r.ids)).toEqual(["CRC-A1", "CRC-A2", "CRC-A3"]);
  });

  test("a heading at ### ends the section — a table AFTER it is not read", () => {
    const withTrailer = plant({}) + "\n| **Phase 9** | CRC-Z9 | a table in another section |\n";
    expect(parsePlacementRows(withTrailer).map(r => r.placement)).toEqual(["Phase 1", "Phase 2"]);
  });

  test("an absent section is UNMEASURED, not a clean reading", () => {
    const r = placementReading(plant({ heading: "### Something else entirely" }));
    expect(r.reading).toBe("UNMEASURED");
    expect(r.unmeasuredReasons.join(" ")).toContain(PLACEMENT_HEADING);
    // The pair: the SAME document with the right heading is MEASURED. Without
    // this, the case above passes for any plant at all.
    expect(placementReading(plant({})).reading).toBe("MEASURED");
  });

  test("a section with no rows is UNMEASURED, and differs from a section with one", () => {
    expect(placementReading(plant({ rows: [] })).reading).toBe("UNMEASURED");
    expect(placementReading(plant({ rows: [["**Phase 1**", "CRC-A1, CRC-A2, CRC-A3"]] })).reading)
      .toBe("MEASURED");
  });

  test("a spec stating no criteria is UNMEASURED — nothing to place is not placed", () => {
    expect(placementReading(plant({ criteria: [], rows: [["**Phase 1**", "CRC-A1"]] })).reading)
      .toBe("UNMEASURED");
  });
});

describe("lib/spec-placement: what the reading refuses", () => {
  test("unplaced: dropping CRC-A3 from the table names it, and restoring it clears", () => {
    const bad = placementReading(plant({ rows: [["**Phase 1**", "CRC-A1, CRC-A2"]] }));
    expect(bad.unplaced).toEqual(["CRC-A3"]);
    expect(placementReading(plant({})).unplaced).toEqual([]);
  });

  test("doubled: the same id in two rows names both placements", () => {
    const bad = placementReading(
      plant({ rows: [["**Phase 1**", "CRC-A1, CRC-A2"], ["**Phase 2**", "CRC-A2, CRC-A3"]] }),
    );
    expect(bad.doubled).toEqual([{ id: "CRC-A2", placements: ["Phase 1", "Phase 2"] }]);
    expect(placementReading(plant({})).doubled).toEqual([]);
  });

  test("unknown: an id in the table the spec states nowhere", () => {
    const bad = placementReading(
      plant({ rows: [["**Phase 1**", "CRC-A1, CRC-A2"], ["**Phase 2**", "CRC-A3, CRC-Z9"]] }),
    );
    expect(bad.unknown).toEqual(["CRC-Z9"]);
    expect(placementReading(plant({})).unknown).toEqual([]);
  });

  test("unrecognised: a placement value outside the closed set", () => {
    const bad = placementReading(
      plant({ rows: [["**Phase 1**", "CRC-A1, CRC-A2"], ["**Later maybe**", "CRC-A3"]] }),
    );
    expect(bad.unrecognised).toEqual(["Later maybe"]);
    // Every declared non-phase value is accepted, so the refusal above is
    // about THAT value and not about the set being empty.
    for (const v of NON_PHASE_PLACEMENTS) {
      const r = placementReading(
        plant({ rows: [["**Phase 1**", "CRC-A1, CRC-A2"], [`**${v} — why**`, "CRC-A3"]] }),
      );
      expect(r.unrecognised, `${v} should be an accepted placement`).toEqual([]);
    }
  });
});

describe("lib/spec-placement: milestones are derived, and matched on the phase NUMBER", () => {
  const spec = plant({});

  test("phase headings parse with their titles", () => {
    expect(parsePhaseHeadings(spec).map(h => h.heading)).toEqual([
      "Phase 1 — stop the repeats",
      "Phase 2 — stop the false findings",
    ]);
  });

  test("no live milestones: every phase is a create, and only phases get one", () => {
    const withBlocked = plant({
      rows: [["**Phase 1**", "CRC-A1"], ["**Phase 2**", "CRC-A2"], ["**Done**", "CRC-A3"]],
    });
    const { actions } = milestonePlan(withBlocked, [], "Conv");
    expect(actions.map(a => `${a.action} ${a.title}`)).toEqual([
      "create Conv Phase 1 — stop the repeats",
      "create Conv Phase 2 — stop the false findings",
    ]);
  });

  /** The description `--write` would put on phase 1 of `spec`. */
  const PHASE_1_BODY = milestoneBody(["CRC-A1", "CRC-A2"]);

  test("an exactly-matching title AND description is unchanged — nothing is written", () => {
    const { actions } = milestonePlan(
      spec,
      [{ number: 4, title: "Conv Phase 1 — stop the repeats", description: PHASE_1_BODY }],
      "Conv",
    );
    expect(actions.find(a => a.phase === 1)?.action).toBe("unchanged");
  });

  test("a DRIFTED title is a rename, never a second create — the live defect", () => {
    // Exactly what `Convergence Phase 0 — three settings` is against
    // `### Phase 0 — three settings, no engineering` on 2026-10-28: the live
    // milestone was typed from the heading and the heading moved. Matching on
    // the title would make this a create, and a duplicate milestone splits a
    // phase's issues into two lanes that each look complete.
    const existing = { number: 4, title: "Conv Phase 1 — stop repeats", description: PHASE_1_BODY };
    const { actions } = milestonePlan(spec, [existing], "Conv");
    const one = actions.find(a => a.phase === 1)!;
    expect(one.action).toBe("rename");
    expect(one.existing).toEqual(existing);
    expect(actions.filter(a => a.phase === 1)).toHaveLength(1);
  });

  // ── The description half, found by the AI review of PR #1647 ─────────────
  //
  // `action` was `existing.title === title ? "unchanged" : "rename"`, so a
  // phase whose criteria list moved while its heading text did not was never
  // rewritten. These three differ in ONE thing — the live description — and
  // the pairing is what makes the red attributable: restoring the title-only
  // comparison turns the first two green and leaves the third alone, which is
  // the mutation reported in the commit.

  test("the same title with a STALE criteria list is an update, not unchanged", () => {
    const { actions } = milestonePlan(
      spec,
      [
        {
          number: 4,
          title: "Conv Phase 1 — stop the repeats",
          description: milestoneBody(["CRC-A1"]), // the table now says A1 AND A2
        },
      ],
      "Conv",
    );
    const one = actions.find(a => a.phase === 1)!;
    expect(one.action).toBe("update");
    expect(one.title).toBe("Conv Phase 1 — stop the repeats");
  });

  test("a milestone with NO description at all is an update — null is not the derived body", () => {
    // `null` is what the API returns for a milestone created by hand, which
    // is how all eight live ones were made. An `unchanged` here would mean
    // the board never shows a phase's criteria until its heading changes.
    const { actions } = milestonePlan(
      spec,
      [{ number: 4, title: "Conv Phase 1 — stop the repeats", description: null }],
      "Conv",
    );
    expect(actions.find(a => a.phase === 1)?.action).toBe("update");
  });

  test("a title that moved AND a description that moved is a rename, not an update", () => {
    // Both halves differ, so the two arms could each claim it. `rename` wins
    // because the human output prints `was: <old title>` and that line is the
    // one a reader needs; the description is rewritten either way.
    const { actions } = milestonePlan(
      spec,
      [{ number: 4, title: "Conv Phase 1 — stop repeats", description: null }],
      "Conv",
    );
    expect(actions.find(a => a.phase === 1)?.action).toBe("rename");
  });

  test("a milestone this spec does not derive is reported, never touched", () => {
    const outsider = { number: 10, title: "Conv Machinery", description: null };
    const { actions, unmanaged } = milestonePlan(spec, [outsider], "Conv");
    expect(unmanaged).toEqual([outsider]);
    expect(actions.every(a => a.action === "create")).toBe(true);
  });

  test("another spec's milestones are unmanaged, not renamed into this one's", () => {
    const { actions, unmanaged } = milestonePlan(
      spec,
      [{ number: 2, title: "Bootstrap Phase 1 — scan", description: null }],
      "Conv",
    );
    expect(unmanaged.map(m => m.number)).toEqual([2]);
    expect(actions.find(a => a.phase === 1)?.action).toBe("create");
  });
});

/**
 * #2124: a family rename keeps every milestone, so every issue keeps its lane.
 *
 * `milestonePlan` matched live milestones only inside the family it was
 * given, so renaming the engine's milestones from `Pipeline` to `Engine`
 * planned ten CREATEs and left every issue in the old ten. `renameFrom` names
 * the old family: within the table's phases, its milestone IS the existing
 * one, and the action is a rename that keeps the number.
 */
describe("#2124: milestonePlan renames a whole family when told the old name", () => {
  const spec = plant({});
  const OLD_1 = { number: 7, title: "Old Phase 1 — stop the repeats", description: null };
  const OLD_2 = { number: 8, title: "Old Phase 2 — stop the false findings", description: null };

  test("every old-family phase is a RENAME that keeps its number, and nothing is created", () => {
    const { actions, unmanaged, conflicts } = milestonePlan(spec, [OLD_1, OLD_2], "Conv", "Old");
    expect(actions.map(a => `${a.action} #${a.existing?.number} ${a.title}`)).toEqual([
      "rename #7 Conv Phase 1 — stop the repeats",
      "rename #8 Conv Phase 2 — stop the false findings",
    ]);
    expect(unmanaged).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  test("the control: without the old name, the same milestones are unmanaged and every phase is a create", () => {
    const { actions, unmanaged } = milestonePlan(spec, [OLD_1, OLD_2], "Conv");
    expect(actions.map(a => a.action)).toEqual(["create", "create"]);
    expect(unmanaged.map(m => m.number)).toEqual([7, 8]);
  });

  test("a phase present in BOTH families is a conflict naming both, never a silent pick", () => {
    const NEW_1 = { number: 3, title: "Conv Phase 1 — stop the repeats", description: null };
    const { conflicts } = milestonePlan(spec, [NEW_1, OLD_1, OLD_2], "Conv", "Old");
    expect(conflicts).toEqual([{ phase: 1, current: NEW_1, previous: OLD_1 }]);
  });

  test("an old-family milestone for a phase the table does not hold is left alone and reported", () => {
    const OLD_9 = { number: 9, title: "Old Phase 9 — later", description: null };
    const { actions, unmanaged } = milestonePlan(spec, [OLD_1, OLD_9], "Conv", "Old");
    expect(actions.map(a => `${a.action} ${a.phase}`)).toEqual(["rename 1", "create 2"]);
    expect(unmanaged).toEqual([OLD_9]);
  });
});

/**
 * `scripts/plan-spec.ts --write` — what reaches GitHub, and when it does not.
 *
 * **These assert on the CALLS, not on the exit code.** The defect they cover
 * is that the refusal was a non-zero return computed after the write loop had
 * already run: every milestone was created, and the command then exited 1. An
 * exit code cannot tell that apart from a refusal that stopped something, so a
 * case reading only `expect(code).toBe(REFUSAL_EXIT)` would have been green
 * against the bug — `.claude/rules/checks-must-be-able-to-fail.md`, *green on
 * the exit code, witnessing the wrong mechanism*. Found by the AI review of
 * PR #1647.
 *
 * Every case is paired with a control differing in ONE row of the planted
 * table, so the red is attributable to the placement problem and not to a
 * plant the parser could not read at all.
 */
describe("scripts/plan-spec --write: nothing reaches GitHub on an unsound table", () => {
  /** Records every call, and returns the shapes the command reads. */
  function spy(live: { number: number; title: string; description: string | null }[] = []) {
    const created: string[] = [];
    const renamed: string[] = [];
    const gh: PlanSpecGitHub = {
      createClient: (() => ({}) as any) as PlanSpecGitHub["createClient"],
      listMilestones: (async () => live) as unknown as PlanSpecGitHub["listMilestones"],
      listOpenIssues: (async () => ({
        issues: [],
        droppedRows: [],
      })) as unknown as PlanSpecGitHub["listOpenIssues"],
      createMilestone: (async (_c: unknown, _r: unknown, o: { title: string }) => {
        created.push(o.title);
        return { number: 900 + created.length };
      }) as unknown as PlanSpecGitHub["createMilestone"],
      renameMilestone: (async (_c: unknown, _r: unknown, n: number, o: { title: string }) => {
        renamed.push(`#${n} -> ${o.title}`);
      }) as unknown as PlanSpecGitHub["renameMilestone"],
    };
    return { gh, created, renamed };
  }

  /** Run the real `main` against a planted spec on disk. */
  async function run(
    content: string,
    extra: string[],
    live?: { number: number; title: string; description: string | null }[],
  ) {
    const dir = mkdtempSync(join(tmpdir(), "rg-plan-spec-"));
    try {
      writeFileSync(join(dir, "SPEC.md"), content);
      const s = spy(live);
      const code = await planSpecMain(
        ["SPEC.md", "--repo", "o/r", "--prefix", "Conv", "--project-root", dir, ...extra],
        s.gh,
      );
      return { code, created: s.created, renamed: s.renamed };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** CRC-A3 is stated and placed nowhere — `reading.unplaced` names it. */
  const UNPLACED = plant({ rows: [["**Phase 1**", "CRC-A1, CRC-A2"]] });
  /** The same document with that one row restored. */
  const SOUND = plant({
    rows: [
      ["**Phase 1**", "CRC-A1, CRC-A2"],
      ["**Phase 2**", "CRC-A3"],
    ],
  });

  /**
   * Round 1 of #1705, swept. The finding named `plan-deps`, where the
   * emptiness guard trimmed and the filter did not. The same split is here
   * with the halves reversed: `if (!prefix)` is false for `"   "`, so a
   * blank prefix was ACCEPTED — and this command writes, so it would have
   * created live milestones called `"    Phase 1 — stop the repeats"`.
   *
   * The two cases are a pair. Refusing blank without trimming leaves
   * `" Conv "` creating `"  Conv   Phase 1 …"`; trimming without refusing
   * blank leaves `"   "` creating `" Phase 1 …"`. One reading does both.
   */
  async function runWithPrefix(prefix: string, extra: string[] = []) {
    const dir = mkdtempSync(join(tmpdir(), "rg-plan-spec-prefix-"));
    try {
      writeFileSync(join(dir, "SPEC.md"), SOUND);
      const s = spy([]);
      const code = await planSpecMain(
        ["SPEC.md", "--repo", "o/r", "--prefix", prefix, "--project-root", dir, "--write", ...extra],
        s.gh,
      );
      return { code, created: s.created };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a BLANK --prefix refuses, and creates nothing", async () => {
    for (const blank of ["", "   ", "\t"]) {
      const { code, created } = await runWithPrefix(blank);
      expect(code, `--prefix ${JSON.stringify(blank)} was accepted`).toBe(REFUSAL_EXIT);
      expect(created, `--prefix ${JSON.stringify(blank)} created milestones`).toEqual([]);
    }
  });

  test("a --prefix with whitespace on an end is TRIMMED before it names anything", async () => {
    const { code, created } = await runWithPrefix("  Conv  ");
    expect(code).toBe(0);
    expect(created, "the untrimmed prefix reached the milestone title").toEqual([
      "Conv Phase 1 — stop the repeats",
      "Conv Phase 2 — stop the false findings",
    ]);
  });

  /**
   * Round 2 of #1705. The blank-prefix refusal added in round 1 wrote plain
   * text whatever `--json` said — reintroducing, in this PR, the exact gap
   * round 1 closed in `plan-deps`. It is not the only one: SIX refusals
   * return before `plan-spec`'s `--json` block, so this is the population
   * rather than the line the finding pointed at.
   */
  async function jsonRefusal(argv: string[], onDisk = SOUND) {
    const dir = mkdtempSync(join(tmpdir(), "rg-plan-spec-json-"));
    const out: string[] = [];
    const err: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    console.error = (...a: unknown[]) => void err.push(a.join(" "));
    try {
      writeFileSync(join(dir, "SPEC.md"), onDisk);
      const s = spy([]);
      const code = await planSpecMain(["--project-root", dir, ...argv], s.gh);
      return { code, stdout: out.join("\n"), stderr: err.join("\n"), created: s.created };
    } finally {
      console.log = log;
      console.error = error;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * Covers SC-2611 (SPEC-TO-BOARD-PIPELINE-SPEC.md) at the command.
   *
   * `jsonRefusal` plants ONE spec under the temp root and spies the GitHub
   * client, so a `--coverage` run that reached the network or demanded a
   * `--repo` would be visible here rather than inferred.
   */
  describe("SC-2611: --coverage reads the tree, reaches nothing, writes nothing", () => {
    /**
     * Like `jsonRefusal`, but the spec is planted under `specs/` — which is
     * the directory the sweep reads, and the reason this cannot reuse it.
     */
    async function coverageRun(argv: string[], onDisk = SOUND) {
      const dir = mkdtempSync(join(tmpdir(), "rg-plan-spec-coverage-"));
      const out: string[] = [];
      const err: string[] = [];
      const log = console.log;
      const error = console.error;
      console.log = (...a: unknown[]) => void out.push(a.join(" "));
      console.error = (...a: unknown[]) => void err.push(a.join(" "));
      try {
        mkdirSync(join(dir, "specs"), { recursive: true });
        writeFileSync(join(dir, "specs", "SPEC.md"), onDisk);
        const s = spy([]);
        const code = await planSpecMain(["--project-root", dir, ...argv], s.gh);
        return { code, stdout: out.join("\n"), stderr: err.join("\n"), created: s.created };
      } finally {
        console.log = log;
        console.error = error;
        rmSync(dir, { recursive: true, force: true });
      }
    }

    test("an unplanned spec is REPORTED and the exit is 0 — a finding, not a refusal", async () => {
      // Non-zero here would be a gate nobody could get green: 22 of 34 specs
      // in this repository are unplanned today, so everyone would learn to
      // append `|| true` and the reading would stop being read.
      const r = await coverageRun(["--coverage"], plant({ heading: "### Something else entirely" }));
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("UNPLANNED");
      expect(r.stdout).toContain("SPEC.md");
      expect(r.created, "--coverage wrote a milestone").toEqual([]);
    });

    test("a planted spec WITH a table reports no unplanned row — one input, one difference", async () => {
      const r = await coverageRun(["--coverage"], plant({}));
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("every spec stating criteria places them");
    });

    test("--coverage with a spec argument REFUSES rather than silently reading one", async () => {
      const r = await coverageRun(["--coverage", "SPEC.md"]);
      expect(r.code).toBe(REFUSAL_EXIT);
      expect(r.stderr).toContain("takes none");
    });

    test("--coverage --json puts the whole reading on stdout", async () => {
      const r = await coverageRun(["--coverage", "--json"], plant({}));
      expect(r.code).toBe(0);
      const parsedOut = JSON.parse(r.stdout);
      expect(parsedOut.reading).toBe("MEASURED");
      expect(parsedOut.planned).toEqual(["specs/SPEC.md"]);
    });
  });

  const PLAN_SPEC_REFUSALS: { why: string; argv: string[]; names: string; spec?: string }[] = [
    { why: "an unparseable argument", argv: ["SPEC.md", "--repo", "o/r", "--prefix", "C", "--nope"], names: "nope" },
    { why: "no spec", argv: ["--repo", "o/r", "--prefix", "C"], names: "no spec given" },
    { why: "a blank --prefix", argv: ["SPEC.md", "--repo", "o/r", "--prefix", "   "], names: "blank" },
    { why: "no --prefix", argv: ["SPEC.md", "--repo", "o/r"], names: "--prefix" },
    { why: "no --repo", argv: ["SPEC.md", "--prefix", "C"], names: "--repo" },
    { why: "no spec on disk", argv: ["absent.md", "--repo", "o/r", "--prefix", "C"], names: "absent.md" },
    {
      why: "an unreadable placement table",
      argv: ["SPEC.md", "--repo", "o/r", "--prefix", "C"],
      names: "UNMEASURED",
      spec: "# A spec with no placement table at all\n",
    },
    // #2124: the old family name is read the way --prefix is.
    {
      why: "a blank --rename-from",
      argv: ["SPEC.md", "--repo", "o/r", "--prefix", "C", "--rename-from", "   "],
      names: "--rename-from was given as",
    },
    {
      why: "a --rename-from naming the --prefix family",
      argv: ["SPEC.md", "--repo", "o/r", "--prefix", "C", "--rename-from", " C "],
      names: "same family",
    },
  ];

  for (const r of PLAN_SPEC_REFUSALS) {
    test(`${r.why} emits a parseable payload under --json`, async () => {
      const saved = process.env.GITHUB_REPOSITORY;
      delete process.env.GITHUB_REPOSITORY;
      let got;
      try {
        got = await jsonRefusal([...r.argv, "--json", "--write"], r.spec ?? SOUND);
      } finally {
        if (saved !== undefined) process.env.GITHUB_REPOSITORY = saved;
      }
      expect(got.code).toBe(REFUSAL_EXIT);
      expect(got.created, "a refusal still created milestones").toEqual([]);
      let payload: { wrote?: string; problems?: string[] };
      try {
        payload = JSON.parse(got.stdout);
      } catch {
        throw new Error(
          `--json refusal (${r.why}) put nothing parseable on stdout. stdout was ` +
            `${JSON.stringify(got.stdout)}; stderr was ${JSON.stringify(got.stderr.slice(0, 200))}`,
        );
      }
      expect(payload.wrote).toBe("refused");
      expect((payload.problems ?? []).join(" "), "the payload did not say which refusal").toContain(
        r.names,
      );
    });
  }

  test("WITHOUT --json those refusals stay on stderr and leave stdout empty", async () => {
    // The control, as in plan-deps: a fix that emits JSON unconditionally
    // passes every case above and breaks every human caller.
    const saved = process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPOSITORY;
    try {
      for (const r of PLAN_SPEC_REFUSALS) {
        const got = await jsonRefusal([...r.argv, "--write"], r.spec ?? SOUND);
        expect(got.code).toBe(REFUSAL_EXIT);
        expect(got.stdout.trim(), `${r.why} printed a payload nobody asked for`).toBe("");
        expect(got.stderr, `${r.why} said nothing on stderr`).toContain(r.names);
      }
    } finally {
      if (saved !== undefined) process.env.GITHUB_REPOSITORY = saved;
    }
  });

  test("the refusal payload carries every key a SOUND --json run does", async () => {
    const sound = await jsonRefusal(["SPEC.md", "--repo", "o/r", "--prefix", "Conv", "--json"]);
    const refused = await jsonRefusal(["SPEC.md", "--repo", "o/r", "--prefix", "   ", "--json"]);
    expect(sound.code).toBe(0);
    expect(Object.keys(JSON.parse(refused.stdout)).sort()).toEqual(
      Object.keys(JSON.parse(sound.stdout)).sort(),
    );
  });

  test("an unplaced criterion: --write creates NOTHING and refuses", async () => {
    const { code, created, renamed } = await run(UNPLACED, ["--write"]);
    expect(created, "a milestone was created despite the refusal").toEqual([]);
    expect(renamed).toEqual([]);
    expect(code).toBe(REFUSAL_EXIT);
  });

  test("the control: the same table with CRC-A3 placed DOES write", async () => {
    // Without this the case above passes against a command that never writes
    // at all — a plant the parser rejects outright looks identical to a
    // refusal that worked.
    const { code, created } = await run(SOUND, ["--write"]);
    expect(created).toEqual([
      "Conv Phase 1 — stop the repeats",
      "Conv Phase 2 — stop the false findings",
    ]);
    expect(code).toBe(0);
  });

  test("a DOUBLED placement also writes nothing", async () => {
    const doubled = plant({
      rows: [
        ["**Phase 1**", "CRC-A1, CRC-A2"],
        ["**Phase 2**", "CRC-A2, CRC-A3"],
      ],
    });
    const { code, created } = await run(doubled, ["--write"]);
    expect(created).toEqual([]);
    expect(code).toBe(REFUSAL_EXIT);
  });

  test("--json --write writes too, and says which of the three states it was in", async () => {
    // It used to return before the write loop, so `--json --write` did
    // nothing and reported the same object as a run that had written eight.
    const out: string[] = [];
    const log = console.log;
    console.log = (s: string) => void out.push(s);
    let result;
    try {
      result = await run(SOUND, ["--write", "--json"]);
    } finally {
      console.log = log;
    }
    expect(result.created).toHaveLength(2);
    expect(JSON.parse(out.join("\n")).wrote).toBe("yes");
  });

  test("--json --write on an unsound table reports `refused`, and writes nothing", async () => {
    const out: string[] = [];
    const log = console.log;
    console.log = (s: string) => void out.push(s);
    let result;
    try {
      result = await run(UNPLACED, ["--write", "--json"]);
    } finally {
      console.log = log;
    }
    expect(result.created).toEqual([]);
    expect(result.code).toBe(REFUSAL_EXIT);
    expect(JSON.parse(out.join("\n")).wrote).toBe("refused");
  });

  test("a stale description on a sound table is written, and it is a rename call", async () => {
    const { code, created, renamed } = await run(SOUND, ["--write"], [
      { number: 4, title: "Conv Phase 1 — stop the repeats", description: null },
      { number: 5, title: "Conv Phase 2 — stop the false findings", description: milestoneBody(["CRC-A3"]) },
    ]);
    // Phase 1's body moved; phase 2's already matches and must not be touched.
    expect(renamed).toEqual(["#4 -> Conv Phase 1 — stop the repeats"]);
    expect(created).toEqual([]);
    expect(code).toBe(0);
  });

  // ── #2124: --rename-from ─────────────────────────────────────────────────
  const OLD_FAMILY = [
    { number: 7, title: "Old Phase 1 — stop the repeats", description: null },
    { number: 8, title: "Old Phase 2 — stop the false findings", description: null },
  ];

  test("#2124: --rename-from --write renames the old family in place and creates nothing", async () => {
    const { code, created, renamed } = await run(SOUND, ["--rename-from", "Old", "--write"], OLD_FAMILY);
    expect(renamed).toEqual([
      "#7 -> Conv Phase 1 — stop the repeats",
      "#8 -> Conv Phase 2 — stop the false findings",
    ]);
    expect(created).toEqual([]);
    expect(code).toBe(0);
  });

  test("#2124: a phase in both families refuses, names both, and writes NOTHING", async () => {
    const both = [{ number: 3, title: "Conv Phase 1 — stop the repeats", description: null }, ...OLD_FAMILY];
    const err: string[] = [];
    const error = console.error;
    console.error = (...a: unknown[]) => void err.push(a.join(" "));
    let r;
    try {
      r = await run(SOUND, ["--rename-from", "Old", "--write"], both);
    } finally {
      console.error = error;
    }
    expect(r.created).toEqual([]);
    expect(r.renamed).toEqual([]);
    expect(r.code).toBe(REFUSAL_EXIT);
    expect(err.join("\n")).toContain("#3 Conv Phase 1 — stop the repeats");
    expect(err.join("\n")).toContain("#7 Old Phase 1 — stop the repeats");
  });

  test("#2124: the same conflict under --json is a parseable refusal naming both", async () => {
    const both = [{ number: 3, title: "Conv Phase 1 — stop the repeats", description: null }, ...OLD_FAMILY];
    const out: string[] = [];
    const log = console.log;
    console.log = (s: string) => void out.push(s);
    let r;
    try {
      r = await run(SOUND, ["--rename-from", "Old", "--write", "--json"], both);
    } finally {
      console.log = log;
    }
    expect(r.created).toEqual([]);
    expect(r.renamed).toEqual([]);
    expect(r.code).toBe(REFUSAL_EXIT);
    const payload = JSON.parse(out.join("\n"));
    expect(payload.wrote).toBe("refused");
    expect(payload.problems.join(" ")).toContain("#7 Old Phase 1");
  });
});

describe("lib/spec-placement: coverage is a NAME match, and the boundary is load-bearing", () => {
  const actions = milestonePlan(
    plant({ criteria: ["CRC-M1", "CRC-M15"], rows: [["**Phase 1**", "CRC-M1, CRC-M15"]] }),
    [],
    "Conv",
  ).actions;

  test("CRC-M1 is not named by an issue that only mentions CRC-M15", () => {
    const [m] = uncoveredByMilestone(actions, [{ number: 1, text: "fix CRC-M15 at last" }]);
    expect(m.covered).toEqual(["CRC-M15"]);
    expect(m.uncovered).toEqual(["CRC-M1"]);
  });

  test("the same id as a whole word IS named, so the case above is about the boundary", () => {
    const [m] = uncoveredByMilestone(actions, [{ number: 1, text: "fix CRC-M1 and CRC-M15" }]);
    expect(m.uncovered).toEqual([]);
  });

  test("no issues at all leaves everything uncovered", () => {
    const [m] = uncoveredByMilestone(actions, []);
    expect(m.uncovered).toEqual(["CRC-M1", "CRC-M15"]);
  });
});

describe("the live convergence spec, against this parser", () => {
  const spec = readFileSync(join(REPO, "specs/CODE-REVIEW-CONVERGENCE-SPEC.md"), "utf-8");

  test("it reads MEASURED with every criterion placed exactly once", () => {
    const r = placementReading(spec);
    expect(r.reading, r.unmeasuredReasons.join("; ")).toBe("MEASURED");
    expect(r.unplaced).toEqual([]);
    expect(r.doubled).toEqual([]);
    expect(r.unknown).toEqual([]);
    expect(r.unrecognised).toEqual([]);
    // Anti-vacuity: the three assertions above are over a real population.
    expect(r.criteria.length).toBeGreaterThan(40);
    expect(r.rows.length).toBeGreaterThan(5);
  });

  test("every phase row has a heading to take its milestone name from", () => {
    const { actions } = milestonePlan(spec, [], "Convergence");
    expect(actions.length).toBeGreaterThan(5);
    for (const a of actions) {
      expect(a.title, `Phase ${a.phase} has no "### Phase ${a.phase} — …" heading to name a milestone from`)
        .not.toBe(`Convergence Phase ${a.phase}`);
    }
  });
});
