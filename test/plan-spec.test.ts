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
  PLACEMENT_MEANINGS_HEADING,
  convertPlacement,
  milestoneBody,
  milestonePlan,
  parsePhaseHeadings,
  parsePlacementRows,
  placementConversionDiff,
  placementCoverage,
  placementReading,
  placementsById,
  previousMilestoneBody,
  uncoveredByMilestone,
} from "../lib/spec-placement";
import { criterionFingerprint, parseCriteria } from "../lib/spec-evidence";
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

  // #2797: the sentence changed, and the live milestones still hold the old
  // one. Reading it as `update` would make the live milestones reading short
  // on every pull request until somebody rewrote them by hand.
  test("#2797: the previous sentence with the current criteria is unchanged, and marked for rewording", () => {
    const plan = (description: string | null, title = "Conv Phase 1 — stop the repeats") =>
      milestonePlan(spec, [{ number: 4, title, description }], "Conv").actions.find(a => a.phase === 1)!;
    const older = plan(previousMilestoneBody(["CRC-A1", "CRC-A2"]));
    expect([older.action, older.reword]).toEqual(["unchanged", true]);
    const current = plan(milestoneBody(["CRC-A1", "CRC-A2"]));
    expect([current.action, current.reword]).toEqual(["unchanged", undefined]);
    // The old sentence over a criteria list that moved is still an update.
    const moved = plan(previousMilestoneBody(["CRC-A1"]));
    expect([moved.action, moved.reword]).toEqual(["update", undefined]);
    // And a moved title is a rename, which writes the new sentence anyway.
    const renamed = plan(previousMilestoneBody(["CRC-A1", "CRC-A2"]), "Conv Phase 1 — stop repeats");
    expect([renamed.action, renamed.reword]).toEqual(["rename", undefined]);
  });

  test("#2797: the previous sentence is byte-for-byte what the live milestones hold, and the new one names the placement lines", () => {
    expect(previousMilestoneBody(["CRC-A1", "CRC-A2"])).toBe(
      "2 criteria: CRC-A1, CRC-A2\n\nDerived from the spec's Phase placement table by `rungate plan-spec`. Edit the table, not this.",
    );
    const body = milestoneBody(["CRC-A1", "CRC-A2"]);
    expect(body.startsWith("2 criteria: CRC-A1, CRC-A2\n\n")).toBe(true);
    expect(body).toContain("`placement:` line");
    expect(body).not.toMatch(/Edit the table/);
    expect(body).not.toBe(previousMilestoneBody(["CRC-A1", "CRC-A2"]));
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
    const { conflicts, actions, unmanaged } = milestonePlan(spec, [NEW_1, OLD_1, OLD_2], "Conv", "Old");
    expect(conflicts).toEqual([{ phase: 1, current: NEW_1, previous: OLD_1 }]);
    // Review of #2126: the conflicting old milestone is in no action, so it
    // must be reported as left alone rather than vanish from the output.
    expect(actions.some(a => a.existing?.number === 7)).toBe(false);
    expect(unmanaged.map(m => m.number)).toContain(7);
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
    const described: string[] = [];
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
      renameMilestone: (async (_c: unknown, _r: unknown, n: number, o: { title: string; description?: string }) => {
        renamed.push(`#${n} -> ${o.title}`);
        described.push(o.description ?? "");
      }) as unknown as PlanSpecGitHub["renameMilestone"],
    };
    return { gh, created, renamed, described };
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
      return { code, created: s.created, renamed: s.renamed, described: s.described };
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

  test("#2797: --write rewords a milestone holding the previous sentence, and the dry run says it would", async () => {
    const live = [
      { number: 4, title: "Conv Phase 1 — stop the repeats", description: previousMilestoneBody(["CRC-A1", "CRC-A2"]) },
      { number: 5, title: "Conv Phase 2 — stop the false findings", description: milestoneBody(["CRC-A3"]) },
    ];
    const out: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    let dry;
    try {
      dry = await run(SOUND, [], live);
    } finally {
      console.log = log;
    }
    expect(dry.renamed).toEqual([]);
    expect(out.join("\n")).toContain("REWORD  Conv Phase 1 — stop the repeats");
    expect(out.join("\n")).toContain("Re-run with --write to apply 1 milestone change(s)");
    const wrote = await run(SOUND, ["--write"], live);
    // Phase 1 gets the new sentence; phase 2 already has it and is not touched.
    expect(wrote.renamed).toEqual(["#4 -> Conv Phase 1 — stop the repeats"]);
    expect(wrote.described).toEqual([milestoneBody(["CRC-A1", "CRC-A2"])]);
    expect(wrote.code).toBe(0);
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

/**
 * Covers SC-2808 (SPEC-TO-BOARD-PIPELINE-SPEC.md; ADR-026 row 3).
 *
 * `--placement` prints the view the table used to store, and writes nothing.
 * `--convert-placement --write` moves a table into placement lines, and refuses
 * without writing when any criterion would read differently afterwards. Every
 * case runs the command against a planted spec with a GitHub client that
 * throws, so a run that reached the network fails rather than passing quietly.
 */
describe("SC-2808: plan-spec prints the placement view and converts a table", () => {
  const NO_NETWORK = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error("plan-spec reached the network");
      },
    },
  ) as unknown as PlanSpecGitHub;

  async function run(argv: string[], spec: string) {
    const dir = mkdtempSync(join(tmpdir(), "rg-plan-spec-2808-"));
    const out: string[] = [];
    const err: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    console.error = (...a: unknown[]) => void err.push(a.join(" "));
    try {
      writeFileSync(join(dir, "SPEC.md"), spec);
      const code = await planSpecMain(["--project-root", dir, "SPEC.md", ...argv], NO_NETWORK);
      return { code, stdout: out.join("\n"), stderr: err.join("\n"), after: readFileSync(join(dir, "SPEC.md"), "utf-8") };
    } finally {
      console.log = log;
      console.error = error;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const LINES = [
    "---",
    "doc-type: spec",
    "---",
    "",
    "# Planted",
    "",
    "- [ ] CRC-A1: one",
    "      placement: Phase 2",
    "- [ ] CRC-A2: two",
    "      needs: test",
    "      placement: Done",
    "- [ ] CRC-A3: three",
    "      placement: Phase 1",
    "- [ ] CRC-A4: four",
    "      placement: Phase 2",
    "",
  ].join("\n");
  const viewLines = (stdout: string) => stdout.split("\n").map(l => l.trim()).filter(l => /^(Phase \d+|Done|Blocked)\b/.test(l));
  const fingerprints = (spec: string) => new Map(parseCriteria(spec).map(c => [c.id, criterionFingerprint(c.text)]));

  test("--placement prints each value with its criteria, phases in order, and writes nothing", async () => {
    const r = await run(["--placement"], LINES);
    expect(r.code, r.stderr).toBe(0);
    expect(viewLines(r.stdout)).toEqual(["Phase 1: CRC-A3", "Phase 2: CRC-A1, CRC-A4", "Done: CRC-A2"]);
    expect(r.after).toBe(LINES);
  });

  test("--placement reads a spec that still has a table through the same parser", async () => {
    const r = await run(["--placement"], plant({}));
    expect(r.code, r.stderr).toBe(0);
    expect(viewLines(r.stdout)).toEqual(["Phase 1: CRC-A1, CRC-A2", "Phase 2: CRC-A3"]);
  });

  test("--convert-placement without --write says what it would write, and writes nothing", async () => {
    const before = plant({});
    const r = await run(["--convert-placement"], before);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("would write 3 placement line(s)");
    expect(r.after).toBe(before);
  });

  test("--convert-placement --write moves every table id beneath its criterion and drops the criteria column", async () => {
    const before = plant({});
    const r = await run(["--convert-placement", "--write"], before);
    expect(r.code, r.stderr).toBe(0);
    expect([...placementsById(r.after)]).toEqual([...placementsById(before)]);
    expect(placementReading(r.after).reading).toBe("MEASURED");
    expect(fingerprints(r.after)).toEqual(fingerprints(before));
    for (const c of parseCriteria(r.after)) expect(c.placements.length, c.id).toBe(1);
    // The table keeps its other columns and loses the criteria one.
    expect(r.after).toContain("| Placement | What the value means |");
    expect(r.after).not.toContain("| Criteria |");
    // ADR-026 Decision 6: what is left of the table is the meanings, under
    // its own heading, so no placement reader reads its ids. The heading's
    // own text after the prefix stays with it (#2805).
    expect(r.after).toContain(`\n${PLACEMENT_MEANINGS_HEADING} — every criterion has exactly one home\n`);
    expect(r.after).not.toContain(PLACEMENT_HEADING);
    expect(parsePlacementRows(r.after).map(row => [row.placement, row.ids])).toEqual([
      ["Phase 1", ["CRC-A1", "CRC-A2"]],
      ["Phase 2", ["CRC-A3"]],
    ]);
  });

  test("it refuses without writing when a criterion would read differently afterwards", async () => {
    const unknown = plant({ rows: [["**Phase 1**", "CRC-A1, CRC-A2, CRC-A9"], ["**Phase 2**", "CRC-A3"]] });
    const doubled = plant({ rows: [["**Phase 1**", "CRC-A1, CRC-A2"], ["**Phase 2**", "CRC-A3, CRC-A1"]] });
    for (const [spec, named] of [[unknown, "CRC-A9"], [doubled, "CRC-A1"]] as const) {
      const r = await run(["--convert-placement", "--write"], spec);
      expect(r.code).toBe(REFUSAL_EXIT);
      expect(r.stderr).toContain("nothing written");
      expect(r.stderr).toContain(named);
      expect(r.after).toBe(spec);
    }
  });

  test("a spec already in placement lines has nothing to convert, and is not touched", async () => {
    const r = await run(["--convert-placement", "--write"], LINES);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("nothing to convert");
    expect(r.after).toBe(LINES);
  });

  test("placementConversionDiff names a criterion whose placement or fingerprint would change", () => {
    const before = plant({});
    const converted = convertPlacement(before);
    if (!("after" in converted)) throw new Error(`the planted spec did not convert: ${JSON.stringify(converted)}`);
    expect(placementConversionDiff(before, converted.after)).toEqual([]);
    const reworded = converted.after.replace("criterion number 1", "criterion number one");
    expect(placementConversionDiff(before, reworded).join("\n")).toContain("CRC-A1: its fingerprint would change");
    const moved = converted.after.replace("placement: Phase 2", "placement: Phase 1");
    expect(placementConversionDiff(before, moved).join("\n")).toContain("CRC-A3: placed Phase 2 before and Phase 1 after");
  });

  // A meanings column that names criteria would read as a second table of
  // them once the criteria column is gone; the convergence spec's does.
  // #2767 converted both with this command, so each now has nothing to convert.
  test("both of rungate's placed specs are converted: nothing is left to convert and nothing is refused", () => {
    for (const name of ["SPEC-TO-BOARD-PIPELINE-SPEC.md", "CODE-REVIEW-CONVERGENCE-SPEC.md"]) {
      const c = convertPlacement(readFileSync(join(REPO, "specs", name), "utf-8"));
      expect("refusal" in c ? c.refusal : [], name).toEqual([]);
      expect("nothing" in c, name).toBe(true);
    }
  });

  // #2797: neither keeps a one-column list of placement values under the
  // meanings heading, which is what converting a two-column table used to leave.
  test("neither of rungate's placed specs keeps a meanings table with no meanings in it", () => {
    for (const name of ["SPEC-TO-BOARD-PIPELINE-SPEC.md", "CODE-REVIEW-CONVERGENCE-SPEC.md"]) {
      const lines = readFileSync(join(REPO, "specs", name), "utf-8").split("\n");
      const start = lines.findIndex(l => l.startsWith(PLACEMENT_MEANINGS_HEADING));
      if (start < 0) continue;
      const end = lines.findIndex((l, i) => i > start && /^#{1,3} /.test(l));
      const rows = lines.slice(start + 1, end < 0 ? undefined : end).filter(l => l.startsWith("|"));
      const oneColumn = rows.filter(l => l.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").length === 1);
      expect(oneColumn, name).toEqual([]);
    }
  });

  // #2782 review: the column drop touches exactly the rows the parser reads.
  test("a row the placement reader skips refuses the conversion, so its criteria cannot be dropped unseen", () => {
    const spec = plant({}).replace("| **Phase 2** | CRC-A3 | because |", "|Phase 2|CRC-A3|because|");
    const c = convertPlacement(spec);
    expect("refusal" in c).toBe(true);
    if ("refusal" in c) expect(c.refusal.join("\n")).toMatch(/line \d+ .*reader skips/);
  });

  test("a table written without closing pipes still loses its criteria column", () => {
    const spec = plant({})
      .replace("| Placement | Criteria | What the value means |", "| Placement | Criteria | What the value means")
      .replace("|---|---|---|", "|---|---|---")
      .replace("| **Phase 1** | CRC-A1, CRC-A2 | because |", "| **Phase 1** | CRC-A1, CRC-A2 | because")
      .replace("| **Phase 2** | CRC-A3 | because |", "| **Phase 2** | CRC-A3 | because");
    const c = convertPlacement(spec);
    if (!("after" in c)) throw new Error(`did not convert: ${JSON.stringify(c)}`);
    expect(c.meanings).toBe("kept");
    expect(c.after.indexOf(PLACEMENT_MEANINGS_HEADING)).toBeGreaterThan(0);
    const meanings = c.after.slice(c.after.indexOf(PLACEMENT_MEANINGS_HEADING));
    expect(meanings).not.toMatch(/CRC-A\d/);
    expect([...placementsById(c.after)]).toEqual([["CRC-A1", "Phase 1"], ["CRC-A2", "Phase 1"], ["CRC-A3", "Phase 2"]]);
  });

  // #2797: a table whose only other column was its criteria has nothing left
  // to say once they move into lines. Its heading is bare: text after the
  // prefix goes where the heading goes (#2805), which a case below covers.
  const TWO_COLUMN = plant({ heading: PLACEMENT_HEADING })
    .replace("| Placement | Criteria | What the value means |", "| Placement | Criteria |")
    .replace("|---|---|---|", "|---|---|")
    .replace("| **Phase 1** | CRC-A1, CRC-A2 | because |", "| **Phase 1** | CRC-A1, CRC-A2 |")
    .replace("| **Phase 2** | CRC-A3 | because |", "| **Phase 2** | CRC-A3 |");

  test("#2797: a table with no column but its placements is removed, and its heading with it", () => {
    expect(TWO_COLUMN).toContain("| Placement | Criteria |\n|---|---|\n");
    expect(TWO_COLUMN).not.toMatch(/\n\n\n/);
    const c = convertPlacement(TWO_COLUMN);
    if (!("after" in c)) throw new Error(`did not convert: ${JSON.stringify(c)}`);
    expect(c.meanings).toBe("removed");
    expect(c.after).not.toContain(PLACEMENT_MEANINGS_HEADING);
    expect(c.after).not.toContain(PLACEMENT_HEADING);
    expect(c.after.split("\n").filter(l => l.startsWith("|"))).toEqual([]);
    // The removal leaves no doubled blank line where the table stood.
    expect(c.after).not.toMatch(/\n\n\n/);
    expect([...placementsById(c.after)]).toEqual([...placementsById(TWO_COLUMN)]);
    expect(placementReading(c.after).reading).toBe("MEASURED");
    // A table that keeps a meanings column keeps it, under the meanings heading.
    const three = convertPlacement(plant({}));
    expect("after" in three && three.meanings).toBe("kept");
  });

  test("#2797: prose written under the heading keeps it when the table goes", () => {
    const prose = "A criterion in no phase is unreadable as anything.";
    const spec = TWO_COLUMN.replace(/(### Phase placement[^\n]*\n\n)/, `$1${prose}\n\n`);
    expect(spec).toContain(prose);
    const c = convertPlacement(spec);
    if (!("after" in c)) throw new Error(`did not convert: ${JSON.stringify(c)}`);
    expect(c.meanings).toBe("removed");
    expect(c.after).toContain(`${PLACEMENT_MEANINGS_HEADING}\n\n${prose}\n`);
    expect(c.after.split("\n").filter(l => l.startsWith("|"))).toEqual([]);
    expect(c.after).not.toMatch(/\n\n\n/);
  });

  // #2805: text after the heading's prefix is the author's, and goes where the
  // heading goes.
  test("#2805: a heading's text after the prefix is kept after the new heading", () => {
    const headingOf = (after: string) => after.split("\n").find(l => l.startsWith(PLACEMENT_MEANINGS_HEADING));
    for (const tail of [" — with notes", " — every criterion has exactly one home", ": in order"]) {
      const c = convertPlacement(plant({ heading: `${PLACEMENT_HEADING}${tail}` }));
      if (!("after" in c)) throw new Error(`did not convert: ${JSON.stringify(c)}`);
      expect(c.meanings).toBe("kept");
      expect(headingOf(c.after), tail).toBe(`${PLACEMENT_MEANINGS_HEADING}${tail}`);
    }
    // A heading with nothing after the prefix converts exactly as it did.
    for (const bare of [PLACEMENT_HEADING, `${PLACEMENT_HEADING}   `]) {
      const c = convertPlacement(plant({ heading: bare }));
      if (!("after" in c)) throw new Error(`did not convert: ${JSON.stringify(c)}`);
      expect(headingOf(c.after), JSON.stringify(bare)).toBe(PLACEMENT_MEANINGS_HEADING);
    }
  });

  test("#2805: a heading whose text would go with a removed table, or that runs on past the prefix, refuses by name", async () => {
    // The table holds nothing but its placements, so it goes, and its heading
    // with it: the heading's own text would go too.
    const noted = TWO_COLUMN.replace(`${PLACEMENT_HEADING}\n`, `${PLACEMENT_HEADING} — with notes\n`);
    expect(noted).toContain(`${PLACEMENT_HEADING} — with notes\n`);
    const c = convertPlacement(noted);
    expect("refusal" in c ? c.refusal.join("\n") : JSON.stringify(c)).toMatch(/line \d+: .*"— with notes"/);
    const r = await run(["--convert-placement", "--write"], noted);
    expect(r.code).toBe(REFUSAL_EXIT);
    expect(r.stderr).toContain("— with notes");
    expect(r.after).toBe(noted);
    // Prose under the heading keeps it, so the heading's text stays with it.
    const prose = TWO_COLUMN.replace(`${PLACEMENT_HEADING}\n\n`, `${PLACEMENT_HEADING} — with notes\n\nA note.\n\n`);
    const kept = convertPlacement(prose);
    if (!("after" in kept)) throw new Error(`did not convert: ${JSON.stringify(kept)}`);
    expect(kept.after).toContain(`${PLACEMENT_MEANINGS_HEADING} — with notes\n\nA note.\n`);
    // A heading the reader reads that runs on into its last word cannot be
    // retitled as written: a letter in any script, a digit or a hyphen (#2811 review).
    for (const tail of ["s", "é", "ś", "2", "-notes", "(s)"]) {
      const runOn = convertPlacement(plant({ heading: `${PLACEMENT_HEADING}${tail}` }));
      expect("refusal" in runOn ? runOn.refusal.join("\n") : JSON.stringify(runOn), tail).toContain(`runs on past`);
      if ("refusal" in runOn) expect(runOn.refusal.join("\n")).toContain(`"${tail}"`);
    }
  });

  test("#2797: --convert-placement says it removes a placements-only table rather than retitling it", async () => {
    const dry = await run(["--convert-placement"], TWO_COLUMN);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain("remove the table, which holds nothing but its placements");
    expect(dry.stdout).not.toContain("retitle");
    const wrote = await run(["--convert-placement", "--write"], TWO_COLUMN);
    expect(wrote.stdout).toContain("the table held nothing but its placements, so it was removed");
    expect(wrote.after).not.toContain(PLACEMENT_MEANINGS_HEADING);
  });

  // #2804 review, round 2: rows a placement line cannot carry refuse, by line.
  test("#2797: a row listing no criterion, or other text in its criteria cell, refuses the conversion", async () => {
    const empty = TWO_COLUMN.replace("| **Phase 2** | CRC-A3 |", "| **Phase 2** | CRC-A3 |\n| **Phase 4** | |");
    const c1 = convertPlacement(empty);
    expect("refusal" in c1 ? c1.refusal.join("\n") : JSON.stringify(c1)).toMatch(/line \d+: Phase 4 lists no criterion/);
    const note = TWO_COLUMN.replace("| **Phase 2** | CRC-A3 |", "| **Phase 2** | CRC-A3 (see the note) |");
    const c2 = convertPlacement(note);
    expect("refusal" in c2 ? c2.refusal.join("\n") : JSON.stringify(c2)).toMatch(/line \d+: the criteria cell holds text that is not a criterion id/);
    // A second table under the heading, carrying meanings in the cell the reader reads.
    const second = TWO_COLUMN.replace("| **Phase 2** | CRC-A3 |\n", "| **Phase 2** | CRC-A3 |\n\n| Placement | Meaning |\n|---|---|\n| Phase 1 | does x |\n");
    const c3 = convertPlacement(second);
    expect("refusal" in c3 ? c3.refusal.join("\n") : JSON.stringify(c3)).toMatch(/lists no criterion/);
    // Nothing is written through the command either.
    const r = await run(["--convert-placement", "--write"], empty);
    expect(r.code).toBe(REFUSAL_EXIT);
    expect(r.after).toBe(empty);
    // Bold, commas and backticks around ids are not other text.
    const styled = TWO_COLUMN.replace("| **Phase 1** | CRC-A1, CRC-A2 |", "| **Phase 1** | `CRC-A1`, **CRC-A2** |");
    expect("after" in convertPlacement(styled)).toBe(true);
  });

  // #2804 review: the usage text says both outcomes, not only the retitle.
  test("#2797: the usage text says a placements-only table is removed and one with meanings is retitled", async () => {
    const r = await run([], TWO_COLUMN);
    const usage = r.stderr.slice(r.stderr.indexOf("--convert-placement"));
    expect(usage).toContain('retitled "What each placement means" when it has');
    expect(usage).toContain("removed when it has none");
  });

  // #2782 review round 2: the milestone plan and the placement view are one reading.
  test("two table rows with one phase value give the milestone every criterion the view prints", async () => {
    const spec = plant({ rows: [["**Phase 1**", "CRC-A1"], ["**Phase 1**", "CRC-A2"], ["**Phase 2**", "CRC-A3"]] });
    const r = await run(["--placement"], spec);
    expect(viewLines(r.stdout)).toEqual(["Phase 1: CRC-A1, CRC-A2", "Phase 2: CRC-A3"]);
    const { actions } = milestonePlan(spec, [], "Planted");
    expect(actions.map(a => [a.phase, a.criteria])).toEqual([[1, ["CRC-A1", "CRC-A2"]], [2, ["CRC-A3"]]]);
    expect(uncoveredByMilestone(actions, []).flatMap(u => u.uncovered)).toEqual(["CRC-A1", "CRC-A2", "CRC-A3"]);
  });

  test("a row that only starts like the header is not exempt: it refuses rather than losing its criteria", () => {
    const spec = plant({}).replace("| **Phase 2** | CRC-A3 | because |", "| Placement 2 | CRC-A3 | because |");
    const c = convertPlacement(spec);
    expect("refusal" in c ? c.refusal.join("\n") : JSON.stringify(c)).toMatch(/line \d+ .*reader skips/);
  });

  test("placementConversionDiff compares criteria with criteria when a spec states one id twice", () => {
    const spec = plant({ criteria: ["CRC-A1", "CRC-A2", "CRC-A1"], rows: [["**Phase 1**", "CRC-A1, CRC-A2"]] });
    expect(placementConversionDiff(spec, spec)).toEqual([]);
    const dropped = spec.replace("- [ ] CRC-A1: criterion number 3\n", "");
    expect(placementConversionDiff(spec, dropped)).toContain("the spec would state 2 criteria, not 3");
  });

  // #2788: a placement given by id cannot say which of two same-id blocks it belongs to.
  test("a spec stating one id in two criterion blocks is refused, naming the id and both lines", async () => {
    const spec = plant({ criteria: ["CRC-A1", "CRC-A2", "CRC-A1"], rows: [["**Phase 1**", "CRC-A1, CRC-A2"]] });
    const c = convertPlacement(spec);
    expect("refusal" in c ? c.refusal.join("\n") : JSON.stringify(c)).toMatch(/CRC-A1 .*lines 7, 9/);
    const r = await run(["--convert-placement", "--write"], spec);
    expect(r.code).toBe(REFUSAL_EXIT);
    expect(r.stderr).toContain("CRC-A1");
    expect(r.after).toBe(spec);
  });

  // #2794 review: the reader, not just the converter, refuses a repeated id.
  test("placementReading reads a spec stating one id in two criterion blocks as UNMEASURED, naming the id and both lines", () => {
    const lines = [
      "# Planted",
      "",
      "- [ ] CRC-A1: one",
      "      placement: Phase 1",
      "- [ ] CRC-A2: two",
      "      placement: Phase 1",
      "- [ ] CRC-A1: three",
      "",
    ].join("\n");
    const table = plant({ criteria: ["CRC-A1", "CRC-A2", "CRC-A1"], rows: [["**Phase 1**", "CRC-A1, CRC-A2"]] });
    for (const spec of [lines, table]) {
      const r = placementReading(spec);
      expect(r.reading).toBe("UNMEASURED");
      expect(r.unmeasuredReasons.join("\n")).toMatch(/CRC-A1 is stated in 2 criterion blocks \(lines \d+, \d+\)/);
    }
  });

  test("--placement and --convert-placement together are refused", async () => {
    const r = await run(["--placement", "--convert-placement"], LINES);
    expect(r.code).toBe(REFUSAL_EXIT);
    expect(r.after).toBe(LINES);
  });
});
