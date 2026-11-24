---
doc-type: adr
status: proposed
created: 2026-11-24
updated: 2026-11-24
---

# ADR-026 — A criterion's phase is written beneath it, and no placement list is stored

## Status

**Proposed, 2026-11-24 (#2488).** Jason chose the direction on 2026-11-24:
each criterion line names its own phase, and the phase table is generated
from those lines. One part changes in this draft, because a measurement
contradicted it: the generated table cannot be stored in the spec. Decision 2
says why. The four criteria below are drafted for Jason's review and his merge.

## Context

A spec's Phase placement table puts every criterion of a phase on one line:
`| **Phase 7** | SC-2618, SC-2619, … |`. Two pull requests that each add a
criterion to the same phase both edit that line, so the second one to merge
conflicts. #2443 (ADR-022) and #2454 (ADR-023) conflicted on Phase 7's line
on 2026-11-19, and a script resolved it by taking the union of the two lines.
Our first consumer resolved the same conflict by script twice on one ADR.
Each resolution is a hand step, and a wrong one drops a criterion from its
phase with nothing to show for it.

Their criteria lines did not conflict. ADR-022's SC-2787 and SC-2788 sit
under *Exit conditions*, and ADR-023's SC-2789 to SC-2794 sit under *The
process reaches consumers through scaffold*. Only the shared table line was
touched by both.

**Measured on 2026-11-24.** Two branches each added one Phase 7 criterion in a
different section of one spec, and were merged with `git merge`, in a fresh
scratch repository for each form:

| Form | Result |
|---|---|
| Today: the phase's ids on one table line | conflict |
| One table row per criterion, appended after the phase's last row | conflict |
| A `placement:` line beneath each criterion, no table | merges clean |
| `placement:` lines, plus a committed table both branches regenerate | conflict |
| `placement:` lines, both criteria added at the end of the same section | conflict |

Git treats two insertions at the same point as a conflict. New criteria
always land at the same point in a table, the end of their phase, because ids
are allocated in increasing order. A table regenerated on each branch is the
same insertion made by a tool. The last row is a conflict on the criteria
lines themselves. It happens today with or without a table, and this ADR does
not change it.

**What reads and writes the table today.** Every reader goes through
`lib/spec-placement.ts`: `parsePlacementRows`, `placementsById`,
`placementReading` and `placementCoverage`. Its callers are `plan-spec`,
`plan-issues`, `board-mirror`, `board-snapshot`, `board-scope`,
`board-conformance`, `status-view`, `criterion-successor`,
`finding-promotion`, `lib/scaffold/spec-scope.ts`, and `lib/issue-repair.ts`,
which takes the values `milestonePlan` and `placementsById` produce. Each already accepts
several rows per phase. The one writer is `withPhase` in
`lib/finding-promotion.ts`, which appends an id to the phase's existing line.

**Annotations are not criterion text.** The criterion parser in
`lib/spec-evidence.ts` reads a closed set of indented `key: value` lines
beneath a criterion (`ANNOTATION_KEYS`: `needs`, `proved-by`, `fingerprint`
and the waiver keys). They stay out of the hashed text, so adding one moves
no criterion's `fingerprint`.

## Decision

A criterion's placement is a `placement:` line indented beneath it, alongside
`needs:` and `proved-by:`. No list of criteria by phase is stored anywhere in
the spec. `plan-spec --placement` prints that list on demand from the
placement lines. Every reader gets placement through the one parser, which
reads both forms during the change. Both of rungate's own placed specs are
converted by a tool, not by hand.

## Decisions

1. **Placement is an annotation beneath the criterion — Jason chose the
   direction on 2026-11-24; the annotation form is the DA's.** The key is `placement`, and the values are the ones the
   table's first column takes today: `Phase N`, or one of
   `NON_PHASE_PLACEMENTS` (`Done`, `Blocked`, `Not adopted — deliberate`, `Not
   observable here`). One line per criterion: a criterion with a second
   `placement:` line is UNMEASURED and named, as a criterion placed in two
   table rows is today (`doubled` in `placementReading`). The annotation
   reader keeps only the last value of a repeated key, so the placement
   reader counts the lines itself rather than trusting that map. Adding a
   placement line does not touch the criterion's wording or its fingerprint.
2. **The generated view is printed, not stored — Jason decides.** This
   changes what he agreed to on 2026-11-24, which was a generated table in
   the spec. A stored table conflicts whether a person or a tool writes it
   (the fourth row above). `plan-spec <spec> --placement` prints each
   placement value with its criteria in phase order, and the pinned status
   view keeps showing each phase's progress as it does today.
3. **One parser reads both forms, and a spec may not mix them — the DA
   recommends.** `parsePlacementRows` builds its rows from the placement
   lines when a spec has them, and from the table when it does not. The
   change is inside `lib/spec-placement.ts`: `placementReading` today reads a
   spec with no `### Phase placement` heading as UNMEASURED, and it must
   accept a spec whose criteria all carry placement lines instead. No caller
   changes, and a consumer whose spec still has a table keeps working.
   A spec that has both, meaning a `### Phase placement` table that lists any
   criterion id and at least one placement line, is UNMEASURED and names
   itself, since two sources for one fact will disagree eventually.
4. **The writer writes the form the spec already uses — the DA recommends.**
   `finding-promotion --phase N` writes `placement: Phase N` beneath the
   criterion it adds. In a spec that still has a table, it appends to the
   table as it does now. A tool that rewrote a consumer's spec into another
   form, unasked, would be a surprise.
5. **A converter moves a table into placement lines — the DA recommends.**
   `plan-spec <spec> --convert-placement --write` writes each table id
   beneath its criterion and removes the table's criteria column. It refuses
   if any reader's reading would differ afterwards. Rungate's two specs are
   converted with it, so a consumer runs the same command we did.
6. **Each placement value's meaning stays in the spec — the DA recommends.**
   `CODE-REVIEW-CONVERGENCE-SPEC.md`'s table has a third column, *What the
   value means*. It moves to a table of placement values under its own
   heading, `### What each placement means`, with no criteria column, so no
   placement reader reads it and it cannot make the spec read as mixed.
   Adding a phase still edits that table; adding a criterion never does.

## Not decided here

- **When the table form stops being read.** That decision waits until the
  consumer has converted. Until then, refusing it would break a spec that
  works today.
- **Two criteria added at the end of the same section.** They conflict today
  and will still conflict. Putting each new criterion where it belongs,
  rather than at the end, avoids most of these. A merge driver would need
  evidence that GitHub honours it, and nobody has measured that.

## Criteria

Drafted into `specs/SPEC-TO-BOARD-PIPELINE-SPEC.md` under *Nothing in the
engine is hand-run*, and placed in Phase 7. A hand-resolved placement
conflict is a hand-run step, and Claim 7 in `SUCCESS.md` is that the plan is
on the tracker and no person or agent placed it there. Ids SC-2806 to SC-2809 are reserved in
`specs/sc-reservations.json` for this branch.

This branch places them the old way, by adding them to Phase 7's line in the
stored table, because the table is the only form any reader understands
today. That line is the conflict this ADR removes. It stays until row 4
converts the spec.

- SC-2806: the parser reads `placement:` lines and reads the table
  identically. A spec that mixes the two, and a criterion with two placement
  lines, are each UNMEASURED.
- SC-2807: `finding-promotion` writes a placement line.
- SC-2808: `plan-spec --placement` prints the view, and
  `--convert-placement --write` converts without changing any reading.
- SC-2809: both engine specs are converted, and a test shows two same-phase
  additions merging cleanly.

## Decomposition

Filed by `adr-accepted.yml` when this merges, one issue per row, into Engine
Phase 7. Row 1 comes first because every other row reads through its parser.
Row 4 converts the specs with row 3's tool.

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| SC-2806 | Placement is read from the line beneath each criterion | lib/spec-placement.ts, lib/spec-evidence.ts, test/spec-to-board-pipeline.test.ts, test/spec-evidence.test.ts | Engine Phase 7 — nothing is hand-run | — |
| SC-2807 | Promotion writes a placement line beneath the criterion it adds | lib/finding-promotion.ts, test/finding-promotion.test.ts, templates/process/adr-template.md, docs/adr/TEMPLATE.md | Engine Phase 7 — nothing is hand-run | Placement is read from the line beneath each criterion |
| SC-2808 | plan-spec prints the placement view and converts a table | scripts/plan-spec.ts, lib/spec-placement.ts, lib/cli-commands.ts, test/plan-spec.test.ts | Engine Phase 7 — nothing is hand-run | Placement is read from the line beneath each criterion |
| SC-2809 | Both engine specs carry their placement beneath each criterion | specs/SPEC-TO-BOARD-PIPELINE-SPEC.md, specs/CODE-REVIEW-CONVERGENCE-SPEC.md, test/spec-placement-merge.test.ts, .github/ISSUE_TEMPLATE/spec-work.yml | Engine Phase 7 — nothing is hand-run | plan-spec prints the placement view and converts a table |
