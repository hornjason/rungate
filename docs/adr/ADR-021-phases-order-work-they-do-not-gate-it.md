---
doc-type: adr
status: proposed
created: 2026-11-18
updated: 2026-11-18
---

# ADR-021 — Phases order work; they do not gate it

## Status

**Proposed, 2026-11-18.** Jason decided every decision below on 2026-11-18, and accepted the three criterion texts in *Criteria* the same day. What is left is his merge.

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
- **Nothing steers Ready toward a chosen milestone.** Config names one engine spec (`board.engineSpec`), and the `work-this-next` label lifts one issue at a time; `board-ready` takes no other flag than `--write` and `--top-up`. No code reads a milestone's due date, none of the 18 open milestones has one, and nothing reads the board's Priority field, which needs a project-scoped token this session does not hold. 12 of 54 open issues have no milestone and never enter Ready unless labelled.
- **The readings read the same plan.** `board-snapshot`'s `dependency-edges` and `plan-deps` both call `dependencyPlan`. Once phase order leaves that plan it is empty, and stage item E3, which runs the reading, would have nothing to measure.

## Decision

An issue may start when nothing real blocks it. Phase is a sort order, never a link and never a wait. Ready takes any unblocked, unassigned issue in a placed phase. `work-this-next` ranks first, then the milestone's due date (earliest first, undated last), then engine before payload, then lowest phase, then how many open issues each unblocks, then number. With no due date set it simply takes the placed backlog in that order. It never holds two issues naming the same file. The planner writes only the dependencies the planning step declares, an accepted ADR's `Blocked by` and `Blocks` cells, and never phase order. The 182 phase-order links and the 11 stale ones around #1764 come off the tracker. The 2 hand-written dependencies stay, and the 77 that point at closed issues are left, since they block nothing.

## Decisions

1. **Phases order work; they do not gate it — Jason, 2026-11-18.** 31 of 37 Convergence issues were held back by nothing anyone wrote.
2. **The phase-order links are removed, and the criteria behind them reworded — Jason, 2026-11-18.** Keeping the links while ranking by phase would leave the gate in place.
3. **"Payload waits for the engine" becomes ordering — Jason, 2026-11-18.** His words: "i understand what it means to have engine first but if we can safely do other work it shouldn't block". Engine issues rank first, and payload issues fill the remaining Ready slots. This supersedes ADR-013 decision 9.
4. **The board's dependency check is `plan-deps` without writing — Jason, 2026-11-18.** `dependency-edges` asks whether every dependency an accepted ADR declares is on the tracker: MET when `plan-deps` would add nothing, SHORT naming what is missing. It never decides order; Ready does. `project-state.json`'s B3 and E3 keep their commands unchanged, and `blocked-by-edges` keeps its definition (every link on an engine issue resolves).
5. **"Same file" means a file both issues name in their files list, and an open pull request's real changes count too — Jason, 2026-11-18.** The files list is `lib/issue-file-overlap.ts`'s existing notion, applied to the in-progress issues and to every issue picked earlier in the same fill. The open-PR clause is his safeguard against a files list that is wrong: the check runs when Ready pulls work in, before anyone starts it.
6. **True ordering comes from planning — Jason, 2026-11-18.** His words: "Wasn't true ordering come from that step. Dependencies". A dependency is declared when the work is planned, in the ADR's `Blocked by` or `Blocks` column, and `plan-issues` writes it. A dependency between two issues that already exist, which no ADR row can express, is written by hand on the tracker, and the planner never removes a link it did not write.
7. **Focus is a milestone's due date — Jason, 2026-11-18.** He asked for a way to say "this milestone, or this spec, next" without new machinery: "i feel like we already have the tooling to make this a mechanical sort". GitHub milestones carry a due date that nothing here reads. Ready ranks the earliest-due milestone's work first, so changing focus is an edit on GitHub's milestone page, not a pull request, and focusing a whole spec means dating its phases. Undated milestones follow the rest of the ranking. A due date changing triggers the refill, and `work-status`, which `/board` reads, prints the order.
8. **After focus, phase ranks before what an issue unblocks — Jason, 2026-11-18.** Ranking by what an issue unblocks first could pull later-phase or payload work ahead of the engine, and spread Ready over every phase at once.

## Not decided here

- **A link a person wrote by hand between two adjacent phases looks exactly like a phase-order link.** The removal row cannot tell them apart. It removes the 182 it derives plus the 11 named above, and nothing else. Its dry run lists every link before anything is written, and a link Jason wants kept is re-added by hand.
- **The 77 links to closed issues stay.** They block nothing, and removing them would only rewrite history.
- Ready's depth cap (10 today, half a day of live throughput) and the `work-this-next` label are unchanged.
- **The 12 issues with no milestone stay out of Ready**, as SC-2741 already says: they enter by being placed in a milestone, or one at a time through `work-this-next`.
- **A due date is used as a priority, not a deadline.** Nothing alerts on a passed date; a passed date still ranks first until it is moved or cleared.
- Consumers get the same Ready rule through the published CLI, and nothing in a consumer's config changes.

## Criteria (Jason accepted these texts, 2026-11-18)

**SC-2741, reworded** (it states today's one-milestone rule):

> Ready holds work from every placed phase that nothing open blocks, up to its depth cap, plus `work-this-next`, which always ranks first. The rest rank by their milestone's due date, earliest first and undated last, then engine before payload, then lowest phase, then how many open issues each unblocks, then number. A phase never holds back an issue nothing blocks, and adding or removing a milestone, changing a milestone's due date, or adding a label triggers the refill.

**SC-2606, reworded** (it states that phase order becomes links):

> lib/spec-deps.ts contains [declaredDependencies] — plan-deps writes a `blocked by` link only for a dependency planning declared: a `Blocked by` or `Blocks` cell in an accepted ADR's Decomposition table. It adds any that are missing, never writes phase order, and never removes a link it did not write. Phase order is how Ready sorts.

**SC-2786, new:**

> `board-ready` never puts an issue in Ready that names a file an in-progress issue names, an open pull request changes, or an issue it picked earlier in the same fill names. The skipped issue stays first in line for the next fill.

## Decomposition

Each row serves a criterion in specs/SPEC-TO-BOARD-PIPELINE-SPEC.md. SC-2786 is reserved to this branch in specs/sc-reservations.json, and its line is written in the spec by this ADR's pull request.

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| SC-2741 | Ready draws from every placed phase that nothing open blocks | lib/board-ready-rule.ts, scripts/board-ready.ts, scripts/work-status.ts, specs/SPEC-TO-BOARD-PIPELINE-SPEC.md, test/board-ready-rule.test.ts, test/work-status.test.ts | Engine Phase 6 — the board's state is a reading | — |
| SC-2786 | Ready never holds two issues that name the same file | lib/board-ready-rule.ts, lib/issue-file-overlap.ts, scripts/board-ready.ts, specs/SPEC-TO-BOARD-PIPELINE-SPEC.md, test/board-ready-rule.test.ts, test/issue-file-overlap.test.ts | Engine Phase 6 — the board's state is a reading | Ready draws from every placed phase that nothing open blocks |
| SC-2606 | plan-deps writes only the dependencies planning declared | lib/spec-deps.ts, scripts/plan-deps.ts, scripts/board-snapshot.ts, specs/SPEC-TO-BOARD-PIPELINE-SPEC.md, test/plan-deps.test.ts, test/board-snapshot.test.ts, test/board-conformance.test.ts | Engine Phase 6 — the board's state is a reading | — |
| SC-2606 | The planner's phase-order links come off the tracker and hand-written links stay | scripts/plan-deps.ts, test/plan-deps.test.ts, .github/workflows/specs-placed.yml, lib/scaffold/specs-placed-workflow.ts | Engine Phase 6 — the board's state is a reading | plan-deps writes only the dependencies planning declared |
| SC-2741 | Ready ranks the earliest-due milestone first | lib/board-ready-rule.ts, scripts/board-ready.ts, scripts/work-status.ts, lib/scaffold/board-ready-workflow.ts, .github/workflows/board-ready.yml, docs/guides/HOW-WORK-FLOWS.md, test/board-ready-rule.test.ts, test/work-status.test.ts | Engine Phase 6 — the board's state is a reading | Ready draws from every placed phase that nothing open blocks |
