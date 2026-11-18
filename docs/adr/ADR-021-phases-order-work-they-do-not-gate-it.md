---
doc-type: adr
status: proposed
created: 2026-11-18
updated: 2026-11-18
---

# ADR-021 — Phases order work; they do not gate it

## Status

**Proposed, 2026-11-18.** Jason decided decisions 1, 2, 3 and 6 on 2026-11-18 (below). What is still open is the criterion wording in *Criteria, proposed wording*: it is his to accept or edit before he merges this.

## Context

Measured on main, 2026-11-18 (#2331's audit, `bun scripts/work-status.ts`, `bun bin/rungate.ts plan-deps --milestone-prefix Convergence`):

- **Ready draws from one milestone.** `activeMilestone` and `inReadyScope` in `lib/board-ready-rule.ts` read only the lowest Engine phase with an open issue (Engine Phase 10, 5 open). `board-ready` demotes any Ready card outside it (SC-2741).
- **Payload waits for the engine** (ADR-013 decision 9). No Convergence issue enters Ready while any Engine phase has an open issue. Today Engine Phase 10's open issues are four consumer reports and #1722, so all Convergence work waits behind them.
- **Phase order is written as links.** `chainAdjacentPhases` in `lib/spec-deps.ts` blocks every issue in a phase on every issue in the phase before (SC-2606). On Convergence that is 182 links.
- **The other 90 links are mostly old phase order, not dependencies.** `plan-deps` reports 90 links on Convergence issues that it did not derive and leaves alone. Read link by link from each issue's timeline (`blocked_by_added` events, 2026-11-18):
  - **77 point at a closed issue** and block nothing. Most were written in batches on 2026-10-29 and 2026-11-02, every issue of one phase on every issue of the phase before: earlier planner runs whose issues have since closed.
  - **11 are stale phase order that still blocks.** Written in one batch on 2026-11-13, when #1764 sat in Convergence Phase 3. ADR-019 moved #1764 to Phase 2, so the planner no longer derives them, and they now hold #1764 behind eight open issues of its own phase, and #1162, #1656 and #1657 behind #1764.
  - **2 are real dependencies, written by hand** on 2026-10-29, the day after rule 4: #1659 waits on #1658 (its body's `## Blocked by` says so), and #1481 waits on #1591.
- **Every link was written by us.** Agent sessions run under the `hornjason` login, and `specs-placed.yml` and `adr-accepted.yml` write as `github-actions[bot]`. No link came from outside.
- **The cost.** Of 37 open Convergence issues, 31 have no blocker anyone wrote, and 0 can start. Four issues are startable across the whole repository.
- **File overlap is advice only.** `lib/issue-file-overlap.ts` feeds `work-status`'s printout, and `board-ready` never reads it, so two issues naming the same file can both be pulled.
- **The readings read the same plan.** `board-snapshot`'s `dependency-edges` and `plan-deps` both call `dependencyPlan`. Once phase order leaves that plan it is empty, and stage item E3, which runs the reading, would have nothing to measure.

## Decision

An issue may start when nothing real blocks it. Phase is a sort order, never a link and never a wait. Ready takes any unblocked, unassigned issue in a placed phase. It ranks by how many open issues each unblocks, then engine before payload, then phase, then number, and never holds two issues naming the same file. The planner writes only the dependencies the planning step declares, an accepted ADR's `Blocked by` and `Blocks` cells, and never phase order. The 182 phase-order links and the 11 stale ones around #1764 come off the tracker. The 2 hand-written dependencies stay, and the 77 that point at closed issues are left, since they block nothing.

## Decisions

1. **Phases order work; they do not gate it — Jason, 2026-11-18.** 31 of 37 Convergence issues were held back by nothing anyone wrote.
2. **The phase-order links are removed, and the criteria behind them reworded — Jason, 2026-11-18.** Keeping the links while ranking by phase would leave the gate in place.
3. **"Payload waits for the engine" becomes ordering — Jason, 2026-11-18.** His words: "i understand what it means to have engine first but if we can safely do other work it shouldn't block". Engine issues rank first, and payload issues fill the remaining Ready slots. This supersedes ADR-013 decision 9.
4. **`dependency-edges` reads the links ADR tables declare — recommended, for Jason.** Every `Blocked by` cell in an accepted ADR's Decomposition must exist on the tracker. That gives E3 a real population, so `project-state.json`'s B3 and E3 keep their commands unchanged. `blocked-by-edges` keeps its definition (every link on an engine issue resolves), now over the authored links.
5. **"Same file" means a file both issues name in their files list — recommended.** That is `lib/issue-file-overlap.ts`'s existing notion, applied to the in-progress issues and to every issue picked earlier in the same fill.
6. **True ordering comes from planning — Jason, 2026-11-18.** His words: "Wasn't true ordering come from that step. Dependencies". A dependency is declared when the work is planned, in the ADR's `Blocked by` or `Blocks` column, and `plan-issues` writes it. A dependency between two issues that already exist, which no ADR row can express, is written by hand on the tracker, and the planner never removes a link it did not write.

## Not decided here

- **A link a person wrote by hand between two adjacent phases looks exactly like a phase-order link.** The removal row cannot tell them apart. It removes the 182 it derives plus the 11 named above, and nothing else. Its dry run lists every link before anything is written, and a link Jason wants kept is re-added by hand.
- **The 77 links to closed issues stay.** They block nothing, and removing them would only rewrite history.
- Ready's depth cap, the expedite label and `work-this-next` are unchanged.
- Consumers get the same Ready rule through the published CLI, and nothing in a consumer's config changes.

## Criteria, proposed wording (Jason's to accept or edit)

**SC-2741, reworded** (it states today's one-milestone rule):

> Ready holds work from every placed phase that nothing open blocks, plus `work-this-next`. It is ranked first by how many open issues each unblocks, then engine before payload, then phase, then number. A phase never holds back an issue nothing blocks, and adding or removing a milestone, or adding a label, triggers the refill.

**SC-2606, reworded** (it states that phase order becomes links):

> The planner writes a `blocked by` link only for a dependency the planning step declared: a `Blocked by` or `Blocks` cell in an accepted ADR's Decomposition table. Phase order in a placement table is a ranking key that Ready reads and is never written as a link, and the planner never removes a link it did not write.

**SC-2786, new:**

> `board-ready` never puts an issue in Ready that names a file an in-progress issue, or an issue it picked earlier in the same fill, also names. The skipped issue stays first in line for the next fill.

## Decomposition

Each row serves a criterion in specs/SPEC-TO-BOARD-PIPELINE-SPEC.md. SC-2786 is reserved to this branch in specs/sc-reservations.json, and its line is written in the spec by this ADR's pull request.

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| SC-2741 | Ready draws from every placed phase ranked by what each issue unblocks | lib/board-ready-rule.ts, scripts/board-ready.ts, scripts/work-status.ts, specs/SPEC-TO-BOARD-PIPELINE-SPEC.md, test/board-ready-rule.test.ts, test/work-status.test.ts | Engine Phase 6 — the board's state is a reading | — |
| SC-2786 | Ready never holds two issues that name the same file | lib/board-ready-rule.ts, lib/issue-file-overlap.ts, scripts/board-ready.ts, specs/SPEC-TO-BOARD-PIPELINE-SPEC.md, test/board-ready-rule.test.ts, test/issue-file-overlap.test.ts | Engine Phase 6 — the board's state is a reading | Ready draws from every placed phase ranked by what each issue unblocks |
| SC-2606 | The planner stops writing phase order as blocked-by links | lib/spec-deps.ts, scripts/plan-deps.ts, scripts/board-snapshot.ts, specs/SPEC-TO-BOARD-PIPELINE-SPEC.md, test/plan-deps.test.ts, test/board-snapshot.test.ts, test/board-conformance.test.ts | Engine Phase 6 — the board's state is a reading | — |
| SC-2606 | The planner's phase-order links come off the tracker and hand-written links stay | scripts/plan-deps.ts, test/plan-deps.test.ts, .github/workflows/specs-placed.yml, lib/scaffold/specs-placed-workflow.ts | Engine Phase 6 — the board's state is a reading | The planner stops writing phase order as blocked-by links |
