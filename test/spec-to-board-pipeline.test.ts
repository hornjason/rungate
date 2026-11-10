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
import { readFileSync } from "fs";
import { join } from "path";
import { PHASE_VALUE, parsePhaseHeadings, parsePlacementRows } from "../lib/spec-placement";
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
 */
function reservationFaults(used: number[], scBlocks: Block[]): string[] {
  const faults: string[] = [];
  for (const b of scBlocks) {
    if (b.owner === OWNER) continue;
    const squatted = used.filter(n => n >= b.from && n <= b.to);
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
    expect(reservationFaults(used, scBlocks), "the live store disagrees with this spec's ids")
      .toEqual([]);

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

  test("it is listed in the spec routing table", () => {
    // HYGIENE-4 enforces this across all specs; asserting it here means the
    // failure names THIS file rather than arriving as a bare empty-array
    // mismatch in the conformity suite.
    const routing = readFileSync(join(ROOT, ".claude/rules/specs-routing.md"), "utf-8");
    expect(routing).toContain("SPEC-TO-BOARD-PIPELINE-SPEC.md");
  });

  /**
   * SC-2625 is the engine's terminal condition and NOTHING can check it yet:
   * no mechanism distinguishes a tool-made edit from a hand edit through the
   * GitHub API. Raised three times in review against CLAUDE.md's "SCs
   * without tests are wishes".
   *
   * Writing a behavioural test would mean writing one that cannot fail,
   * which `.claude/rules/checks-must-be-able-to-fail.md` refuses by name. So
   * this binds the only property that IS checkable today and is the one that
   * actually goes wrong: that the criterion stays declared-unmeasured until
   * somebody builds the detector, rather than being quietly ticked.
   *
   * It is not decoration. It fails in both directions a wish would drift in:
   * tick SC-2625 with no detector and it goes red; delete the generator's
   * `REVIEW: unmatched` marker — the mechanical record that no registry
   * pattern matches it — and it goes red. The marker is emitted by
   * `scaffold . --fix`, not typed here, so it cannot be satisfied by writing
   * a comment that says so.
   */
  test("SC-2625 is declared unmeasured, and cannot be ticked without a detector", () => {
    const line = SPEC.split("\n").findIndex(l => l.includes("SC-2625:"));
    expect(line, "SC-2625 is the acceptance test and must be present").toBeGreaterThan(-1);

    const lines = SPEC.split("\n");
    expect(
      lines[line].startsWith("- [ ]"),
      "SC-2625 is ticked, but no mechanism yet distinguishes a tool edit from a hand " +
        "edit on the GitHub API. Build that detector (Stage D of ADR-009) before ticking it.",
    ).toBe(true);

    expect(
      lines[line + 1] ?? "",
      "SC-2625 lost its generator-emitted `REVIEW: unmatched` marker. That marker is the " +
        "mechanical record that no registry pattern checks this criterion; without it the " +
        "criterion reads as covered. Re-run `bun bin/rungate.ts scaffold . --fix`.",
    ).toContain("REVIEW: unmatched");
  });
});
