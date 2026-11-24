/**
 * SPEC-TO-BOARD-PIPELINE-SPEC.md — the pipeline reads its own spec.
 *
 * This file exists for a narrower reason than "the new spec needs a test".
 * The spec's argument is that the machinery which makes every issue name a
 * criterion was itself governed by none, and the first thing that claim
 * implies is checkable: the pipeline's own steps must be able to READ this
 * document. A spec the tools cannot parse states its criteria to nobody, and
 * that failure is silent — `plan-spec` would make no milestones and report
 * exactly what it reports for a spec with no work left.
 *
 * So every case below runs a real pipeline step against the real file, and
 * each is paired with a control that would also go green if the step had
 * simply found nothing.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  PHASE_VALUE,
  parsePhaseHeadings,
  parsePlacementRows,
  parsePlacementTable,
  placementReading,
  placementsById,
} from "../lib/spec-placement";
import { parseCriteria } from "../lib/spec-evidence";

const ROOT = join(import.meta.dir, "..");
const PATH = "specs/SPEC-TO-BOARD-PIPELINE-SPEC.md";
const SPEC = readFileSync(join(ROOT, PATH), "utf-8");

/** The reservation owner this spec's ids were allocated under. */
const OWNER = "rg/pipeline-spec";

type Block = { owner: string; from: number; to: number; namespace?: string };

/**
 * What the reservation store may not say about the ids this spec consumes.
 *
 * Two faults, and neither of them is "no block exists" (#1969). A block is a
 * claim on ids IN FLIGHT; `.claude/rules/parallel-sessions.md` tells its owner
 * to delete it at merge, and after merge the ids are held by `lib/create-sc.ts`'s
 * `taken` set — built from the ids actually written in `specs/` — rather than
 * by the block. So an absent block is the correct resting state and faults
 * nothing.
 *
 * - **Somebody else reserved an id this spec already consumed.** A live claim
 *   on a spent id is the collision the store exists to prevent, and it is
 *   invisible in either branch alone.
 * - **This spec's own block is declared and does not contain its ids.** While
 *   the block exists it is a statement about where these ids live, and a
 *   statement that is wrong is worse than none.
 *
 * Takes the blocks rather than reading them, so both arms can be planted.
 * SC-namespace blocks only — an `FG-2600..2629` block claims different ids.
 *
 * #2327: `base` is origin/main's ids and blocks. With it, a foreign block
 * faults only on what THIS tree changed: a block it adds over an id origin/main
 * already states (reserving a spent id), or ids it adds inside a block
 * origin/main already holds (writing into someone else's live reservation).
 * A held block this tree widens over an id main already states is the first
 * of those, and is read the same way (#2332).
 * A block and the ids it covers arriving together is a reservation in flight,
 * and once both are on main it is the same reservation merged. With `base`
 * null — origin/main unreadable — every foreign block over any id faults, the
 * strict reading.
 */
function reservationFaults(used: number[], scBlocks: Block[], base: { used: number[]; blocks: Block[] } | null = null): string[] {
  const faults: string[] = [];
  // An owner's reservation, whatever its range: a resized block is still held.
  const key = (b: Block) => `${b.namespace ?? "SC"}:${b.owner}`;
  const heldOnMain = new Set((base?.blocks ?? []).map(key));
  const inside = (n: number, r: Block) => n >= r.from && n <= r.to;
  for (const b of scBlocks) {
    if (b.owner === OWNER) continue;
    // A held reservation covers main's range as well as this tree's copy of
    // it, so a block widened on main after this branch forked still counts.
    const onMain = (base?.blocks ?? []).filter(m => key(m) === key(b));
    const ranges = [b, ...onMain];
    const covered = used.filter(n => ranges.some(r => inside(n, r)));
    // #2332: a held block this tree WIDENS onto an id main already states is
    // the same spent-id reservation as a new block over it, so the ids the
    // tree's range adds beyond main's range are read the way a new block is.
    const widened = (n: number) => inside(n, b) && !onMain.some(r => inside(n, r));
    const squatted =
      base === null
        ? covered
        : heldOnMain.has(key(b))
          ? covered.filter(n => !base.used.includes(n) || widened(n))
          : covered.filter(n => base.used.includes(n));
    if (squatted.length > 0) {
      faults.push(
        `${b.owner} reserves ${b.from}-${b.to}, which covers ${squatted.join(", ")} — ` +
          `ids ${PATH} has already consumed`,
      );
    }
  }
  const mine = scBlocks.filter(b => b.owner === OWNER);
  for (const b of mine) {
    const outside = used.filter(n => n < b.from || n > b.to);
    if (outside.length > 0) {
      faults.push(`ids outside the reserved ${b.from}..${b.to}: ${outside.join(", ")}`);
    }
  }
  return faults;
}

/**
 * origin/main's ids for this spec and its SC blocks — #2327. `null` when
 * either file cannot be read there or an id there does not parse, so the
 * reading falls back to the strict one rather than exempting anything.
 */
function mainBase(): { used: number[]; blocks: Block[] } | null {
  const show = (path: string) => spawnSync("git", ["-C", ROOT, "show", `origin/main:${path}`], { encoding: "utf-8" });
  const spec = show(PATH);
  const store = show("specs/sc-reservations.json");
  if (spec.status !== 0 || store.status !== 0) return null;
  const ids = parseCriteria(spec.stdout).map(c => /^SC-(\d+)$/.exec(c.id));
  if (ids.length === 0 || ids.some(m => m === null)) return null;
  let parsed: { reservations?: unknown };
  try {
    parsed = JSON.parse(store.stdout) as { reservations?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.reservations)) return null;
  const blocks = (parsed.reservations as Block[]).filter(r => (r.namespace ?? "SC") === "SC");
  return { used: ids.map(m => Number(m![1])), blocks };
}

/** The spec this suite is about, named where a scanner can see the claim. */
describe("SPEC-TO-BOARD-PIPELINE-SPEC.md is readable by the pipeline it governs", () => {
  test("it states criteria, and they are the ones the placement table places", () => {
    const stated = parseCriteria(SPEC).map(c => c.id);
    expect(stated.length, "the spec states no criteria, so it governs nothing").toBeGreaterThan(0);

    const placed = parsePlacementRows(SPEC).flatMap(r => r.ids);
    // Both directions. A criterion in no phase is unreadable as anything —
    // *nobody has reached it*, *it cannot start* and *it is finished* all
    // render as absence — and a phase naming an id the spec does not state
    // is a milestone pointing at nothing.
    expect(stated.filter(id => !placed.includes(id)), "criteria in no phase").toEqual([]);
    expect(placed.filter(id => !stated.includes(id)), "phases naming unstated ids").toEqual([]);
  });

  test("every placement value is one plan-spec can turn into a milestone", () => {
    const rows = parsePlacementRows(SPEC);
    expect(rows.length, "no placement table was found at all").toBeGreaterThan(0);
    // The control the row above needs: an unparsed table and a table of
    // values `PHASE_VALUE` rejects both yield zero milestones, and only one
    // of them is a spec somebody has to fix.
    const unusable = rows.map(r => r.placement).filter(p => !PHASE_VALUE.test(p));
    expect(
      unusable,
      "a placement cell plan-spec cannot read — it must be exactly `Phase N`, with the " +
        "title carried by the `### Phase N — …` heading instead",
    ).toEqual([]);
  });

  test("every phase placed has a heading, and every heading is placed", () => {
    const headings = new Set(parsePhaseHeadings(SPEC).map(h => h.number));
    const placed = new Set(
      parsePlacementRows(SPEC)
        .map(r => PHASE_VALUE.exec(r.placement)?.[1])
        .filter((n): n is string => n !== undefined)
        .map(Number),
    );
    expect(placed.size, "nothing was placed, so this agrees vacuously").toBeGreaterThan(0);
    expect([...placed].filter(n => !headings.has(n)), "phases with no heading").toEqual([]);
    expect([...headings].filter(n => !placed.has(n)), "headings placing nothing").toEqual([]);
  });

  test("no live block disagrees with the ids it consumes", () => {
    // `.claude/rules/parallel-sessions.md`: every path that consumes an id is
    // an allocation, including hand-written ones. A collision is only visible
    // in the union of two branches, so neither PR's CI can see it.
    //
    // #1969: this used to require `rg/pipeline-spec`'s block to EXIST. That
    // branch merged as PR #1673, and the same rule says "delete your entry
    // when your branch merges", so the check and the rule asked for opposite
    // things and the check won — the block is still there. It also asked for
    // the wrong property. A reservation protects ids IN FLIGHT; once the spec
    // is on main its ids are protected by `lib/create-sc.ts`'s `taken` set,
    // built from the ids actually written in `specs/`, whether or not a block
    // still names them. What must hold forever is narrower and is asserted
    // below: no OTHER owner may reserve an id this spec has consumed, and if
    // this spec's own block is still declared, its ids must be inside it.
    const store = JSON.parse(readFileSync(join(ROOT, "specs/sc-reservations.json"), "utf-8")) as {
      reservations: { owner: string; from: number; to: number; namespace?: string }[];
    };
    const scBlocks = store.reservations.filter(r => (r.namespace ?? "SC") === "SC");
    const mine = scBlocks.filter(r => r.owner === OWNER);
    expect(
      mine.length,
      `${OWNER} declares more than one SC block, so "inside the reservation" names no single range`,
    ).toBeLessThanOrEqual(1);

    // An id this check cannot parse must FAIL it, never be filtered out of
    // the population. `.filter(Number.isInteger)` dropped anything that was
    // not exactly `SC-<digits>`, and the only guard was that SOME id parsed
    // — so a single differently-shaped criterion sitting outside the
    // reserved block would have been skipped silently while the check went
    // green. "Assertions that hold vacuously", in
    // `.claude/rules/checks-must-be-able-to-fail.md`. Found by the AI review
    // of this change.
    const ids = parseCriteria(SPEC).map(c => c.id);
    expect(ids.length, "no criteria were read, so the range check is vacuous").toBeGreaterThan(0);
    expect(
      ids.filter(id => !/^SC-\d+$/.test(id)),
      "an id this check cannot parse would be dropped from the range test below rather " +
        "than examined by it, so a criterion outside the reservation could pass unseen",
    ).toEqual([]);
    const used = ids.map(id => Number(/^SC-(\d+)$/.exec(id)![1]));
    // The collision that does harm is one id meaning two criteria. It is
    // asserted directly, so it is caught whether or not a block was declared
    // and whatever origin/main holds (review of #2328). A block left covering
    // an id somebody else took is stale, not a collision: `lib/create-sc.ts`
    // hands out `lowestFreeInBlock(block, taken)`, so a taken id is never
    // handed out again from inside a block.
    expect(
      ids.filter((id, i) => ids.indexOf(id) !== i),
      "an id is stated twice in this spec, so two criteria share it",
    ).toEqual([]);
    // With no origin/main to read the strict reading applies, and the failure
    // says so: "could not compare" and "a real collision" must not read alike.
    const liveBase = mainBase();
    expect(
      reservationFaults(used, scBlocks, liveBase),
      liveBase === null
        ? "origin/main could not be read, so every foreign block was read strictly, an in-flight one included; " +
            "fetch origin/main and re-run before treating this as a collision"
        : "the live store disagrees with this spec's ids",
    ).toEqual([]);

    // **There is deliberately no "which arm did the live store take" line
    // here.** The first version of this case had one, and round 1 of this
    // PR's review was right about it twice over:
    // `expect(mine.length === 1 ? "own-block" : "no-own-block").toMatch(/^(own-block|no-own-block)$/)`
    // resolves to one of exactly the two strings the pattern accepts, for
    // every value of `mine.length`. "Assertions that hold vacuously",
    // `.claude/rules/checks-must-be-able-to-fail.md` — written in the act of
    // quoting the rule it broke.
    //
    // It has no honest form, which is why it is gone rather than repaired.
    // Re-deriving the arm from the same file is a second decider that agrees
    // with the first by construction, and pinning it to `0` would forbid the
    // legal state this whole change exists to allow: a future block, declared
    // while new ids for this spec are in flight. Both arms ARE exercised
    // unconditionally, by the planted-store case below; what the live store
    // is in is data, not a property.
  });

  test("the reservation reading, both arms, against planted stores", () => {
    // #1969. `reservationFaults` is the single binding the case above reads
    // through, and the live store exercises at most one of its arms — none of
    // them once the block is deleted, which is the resting state. These are
    // the arms, planted.
    const used = [2600, 2610, 2624];
    const mineBlock = { owner: OWNER, from: 2600, to: 2629 };
    const theirs = { owner: "rg/someone-else", from: 2600, to: 2629 };

    expect(reservationFaults(used, []), "an empty store faulted ids nobody reserved").toEqual([]);
    expect(reservationFaults(used, [mineBlock]), "ids inside this spec's own block faulted").toEqual([]);
    expect(
      reservationFaults(used, [{ owner: OWNER, from: 2700, to: 2729 }]).join(" | "),
      "an id OUTSIDE this spec's own declared block was not reported",
    ).toContain("2600");
    expect(
      reservationFaults(used, [theirs]).join(" | "),
      "another owner reserving an id this spec consumed was not reported",
    ).toContain("rg/someone-else");
    // The control for the row above: the same foreign block over ids this
    // spec does NOT consume is not a fault, so the detector is answering
    // about the overlap rather than about the owner's name.
    expect(
      reservationFaults(used, [{ owner: "rg/someone-else", from: 2700, to: 2729 }]),
      "a foreign block over ids this spec never consumed was reported as a collision",
    ).toEqual([]);
  });

  test("#2327: a branch that writes new ids can reserve them, read against origin/main", () => {
    // ADR-020 (#2321) wrote four criterion ids by hand and could not reserve them:
    // a block from the branch that adds the ids covers them by definition, so
    // with no base the reading above refuses it and the only accepted state is
    // no block at all. With origin/main as the base, what each block COVERS is
    // read against what was already there.
    const onMain = [2600, 2610];
    const inTree = [2600, 2610, 2782, 2785];
    const adr = { owner: "rg/adr-branch", from: 2782, to: 2785 };
    const live = { owner: "rg/other-branch", from: 2780, to: 2789 };

    // In flight: the block and the ids it covers both arrive in this tree.
    expect(reservationFaults(inTree, [adr], { used: onMain, blocks: [] }), "an in-flight block was refused").toEqual([]);
    // Merged together: both are on origin/main, and the tree adds nothing.
    expect(reservationFaults(inTree, [adr], { used: inTree, blocks: [adr] }), "a merged block was refused").toEqual([]);

    // This tree adds a block over an id origin/main already states: a spent id.
    expect(
      reservationFaults(inTree, [{ owner: "rg/late", from: 2600, to: 2605 }], { used: onMain, blocks: [] }).join(" | "),
      "a new block over an id origin/main already states was not reported",
    ).toContain("rg/late reserves 2600-2605, which covers 2600");
    // This tree writes ids into a block origin/main already holds for someone else.
    expect(
      reservationFaults(inTree, [live], { used: onMain, blocks: [live] }).join(" | "),
      "ids written into another branch's live reservation were not reported",
    ).toContain("rg/other-branch reserves 2780-2789, which covers 2782, 2785");

    // An owner's reservation is the same reservation when its range moved:
    // a block resized on main, or a branch behind main's edit to it, still
    // holds new ids written inside it (review of #2328).
    const resizedOnMain = { owner: "rg/other-branch", from: 2780, to: 2799 };
    expect(
      reservationFaults([...inTree, 2795], [live], { used: onMain, blocks: [resizedOnMain] }).join(" | "),
      "an id written into another branch's reservation went unseen because its range differs from main's",
    ).toContain("rg/other-branch reserves 2780-2789, which covers 2782, 2785, 2795");

    // The live case reads its base from origin/main. A reader that always
    // answered null would refuse every in-flight block with no case failing.
    // Only where origin/main resolves: CI's fetch of it is best-effort, and a
    // checkout with no such ref has nothing for the reader to read.
    const hasMain =
      spawnSync("git", ["-C", ROOT, "rev-parse", "--verify", "--quiet", "origin/main^{commit}"], { encoding: "utf-8" }).status === 0;
    if (hasMain) {
      const base = mainBase();
      expect(base, "origin/main resolves and its spec or store could not be read").not.toBeNull();
      expect(base!.used, "origin/main's copy of this spec was read as stating none of its ids").toContain(2615);
    }

    // No base to read: the strict reading above, so the in-flight block is refused.
    expect(reservationFaults(inTree, [adr], null).join(" | "), "an unreadable origin/main exempted a block").toContain(
      "rg/adr-branch reserves 2782-2785",
    );
  });

  test("#2332: a held block widened in this tree onto an id origin/main already states is reported", () => {
    // Found in round 6 of #2328's review. A block origin/main holds was
    // checked only for ids NEW in this tree, so widening it over a spent id
    // went unreported, though a brand-new block over the same id is.
    const onMain = { used: [100, 110], blocks: [{ owner: "rg/x", from: 100, to: 105 }] };
    expect(
      reservationFaults([100, 110], [{ owner: "rg/x", from: 100, to: 115 }], onMain).join(" | "),
      "a held block widened over an id main already states was not reported",
    ).toContain("rg/x reserves 100-115, which covers 110");
    // The control: the same tree without the widening is clean.
    expect(reservationFaults([100, 110], [{ owner: "rg/x", from: 100, to: 105 }], onMain), "an unchanged held block was reported").toEqual([]);
    // Widening onto ids nobody states is room, not a fault.
    expect(reservationFaults([100], [{ owner: "rg/x", from: 100, to: 115 }], { used: [100], blocks: onMain.blocks })).toEqual([]);
  });

  test("it is listed in the spec routing table", () => {
    // HYGIENE-4 enforces this across all specs; asserting it here means the
    // failure names THIS file rather than arriving as a bare empty-array
    // mismatch in the conformity suite.
    const routing = readFileSync(join(ROOT, ".claude/rules/specs-routing.md"), "utf-8");
    expect(routing).toContain("SPEC-TO-BOARD-PIPELINE-SPEC.md");
  });

  /**
   * SC-2625 is the engine's terminal condition. Until #2388 nothing could check
   * it, and this case held it unticked: no mechanism told a tool-made edit from
   * a hand edit through the GitHub API, and a behavioural test would have been
   * one that cannot fail.
   *
   * The detector is `scripts/hand-edits.ts`, and since #1722 the board job
   * runs it on every push to main. So the property this binds moved with it:
   * SC-2625 may be ticked only while that detector exists AND the job runs it.
   * A tick that outlives its detector, or a job that stops taking the reading,
   * is the wish this case was written against, arriving from the other side.
   *
   * It fails in both directions a wish would drift in. Tick SC-2625 with the
   * detector gone or unrun and it goes red. Delete the generator's
   * `REVIEW: unmatched` marker, the mechanical record that no registry pattern
   * matches it, and it goes red. The marker is emitted by `scaffold . --fix`,
   * not typed here, so it cannot be satisfied by writing a comment that says so.
   */
  test("SC-2625 is ticked only while its detector runs on every push to main", () => {
    const line = SPEC.split("\n").findIndex(l => l.includes("SC-2625:"));
    expect(line, "SC-2625 is the acceptance test and must be present").toBeGreaterThan(-1);

    const lines = SPEC.split("\n");
    const job = readFileSync(join(ROOT, ".github/workflows/board-conformance.yml"), "utf-8")
      .split("\n")
      .filter(l => !/^\s*#/.test(l))
      .join("\n");
    const detectorRuns =
      existsSync(join(ROOT, "scripts/hand-edits.ts")) && /^\s*bun scripts\/hand-edits\.ts /m.test(job);
    if (lines[line].startsWith("- [x]")) {
      expect(
        detectorRuns,
        "SC-2625 is ticked, but its detector is not taken on main: scripts/hand-edits.ts is " +
          "missing, or .github/workflows/board-conformance.yml no longer runs it. Restore the " +
          "reading, or untick the criterion.",
      ).toBe(true);
    }

    expect(
      lines[line + 1] ?? "",
      "SC-2625 lost its generator-emitted `REVIEW: unmatched` marker. That marker is the " +
        "mechanical record that no registry pattern checks this criterion; without it the " +
        "criterion reads as covered. Re-run `bun bin/rungate.ts scaffold . --fix`.",
    ).toContain("REVIEW: unmatched");
  });
});

// covers SC-2806
describe("SC-2806: a criterion's placement is read from the line beneath it (ADR-026)", () => {
  const spec = (lines: string[]) => `---\ndoc-type: spec\n---\n\n## Success Criteria\n\n${lines.join("\n")}\n`;
  const LINES = spec([
    "- [ ] SC-1: one.",
    "      placement: Phase 1",
    "- [ ] SC-2: two.",
    "      needs: test",
    "      placement: Phase 2",
    "- [ ] SC-3: three.",
    "      placement: Phase 1",
    "- [ ] SC-4: four.",
    "      placement: Blocked — on the vendor",
  ]);
  const TABLE = spec([
    "- [ ] SC-1: one.",
    "- [ ] SC-2: two.",
    "",
    "### Phase placement",
    "",
    "| Placement | Criteria |",
    "|---|---|",
    "| **Phase 1** | SC-1 |",
    "| Done | SC-2 |",
  ]);

  test("rows come from the placement lines: one per value, in first-seen order, ids in document order", () => {
    expect(parsePlacementRows(LINES).map(r => [r.placement, r.ids])).toEqual([
      ["Phase 1", ["SC-1", "SC-3"]],
      ["Phase 2", ["SC-2"]],
      ["Blocked — on the vendor", ["SC-4"]],
    ]);
    // A row's line is its first placement line, so a message points at one.
    expect(parsePlacementRows(LINES)[0]!.line).toBe(LINES.split("\n").indexOf("      placement: Phase 1") + 1);
  });

  test("a spec of placement lines and no table reads MEASURED, and every reader gets the same values", () => {
    const r = placementReading(LINES);
    expect(r.reading, r.unmeasuredReasons.join("; ")).toBe("MEASURED");
    expect(r.unplaced).toEqual([]);
    expect(r.doubled).toEqual([]);
    expect(placementsById(LINES).get("SC-2")).toBe("Phase 2");
    expect(placementsById(LINES).get("SC-4")).toBe("Blocked — on the vendor");
  });

  test("a spec with no placement lines is read from its table exactly as before", () => {
    expect(parsePlacementRows(TABLE)).toEqual(parsePlacementTable(TABLE));
    expect(parsePlacementRows(TABLE).map(r => [r.placement, r.ids])).toEqual([["Phase 1", ["SC-1"]], ["Done", ["SC-2"]]]);
    expect(placementReading(TABLE).reading).toBe("MEASURED");
    // Both of rungate's placed specs are still tables, and read as tables.
    for (const name of ["SPEC-TO-BOARD-PIPELINE-SPEC.md", "CODE-REVIEW-CONVERGENCE-SPEC.md"]) {
      const content = readFileSync(join(ROOT, "specs", name), "utf-8");
      expect(parseCriteria(content).some(c => c.placements.length > 0), name).toBe(false);
      expect(parsePlacementRows(content), name).toEqual(parsePlacementTable(content));
    }
  });

  test("a table that lists a criterion beside a placement line is UNMEASURED, naming the spec's two sources", () => {
    const mixed = TABLE.replace("- [ ] SC-1: one.", "- [ ] SC-1: one.\n      placement: Phase 1");
    const r = placementReading(mixed);
    expect(r.reading).toBe("UNMEASURED");
    expect(r.unmeasuredReasons.join("\n")).toContain("this spec places criteria both ways");
    expect(r.unmeasuredReasons.join("\n")).toContain("SC-1");
  });

  test("a table heading that lists no criterion id does not make a spec of placement lines mixed", () => {
    const meanings = LINES + "\n### Phase placement\n\n| Placement | Criteria |\n|---|---|\n| Phase 1 | |\n";
    expect(placementReading(meanings).reading, placementReading(meanings).unmeasuredReasons.join("; ")).toBe("MEASURED");
  });

  test("a criterion with two placement lines is UNMEASURED and named, even when both say the same", () => {
    for (const second of ["      placement: Phase 2", "      placement: Phase 1"]) {
      const twice = LINES.replace("      placement: Phase 1\n- [ ] SC-2", `      placement: Phase 1\n${second}\n- [ ] SC-2`);
      const r = placementReading(twice);
      expect(r.reading).toBe("UNMEASURED");
      expect(r.unmeasuredReasons.join("\n")).toContain("SC-1 has 2 placement lines");
    }
  });

  test("a placement line's value is checked as a table's is", () => {
    const odd = LINES.replace("placement: Phase 2", "placement: Phase two");
    expect(placementReading(odd).unrecognised).toEqual(["Phase two"]);
  });
});
