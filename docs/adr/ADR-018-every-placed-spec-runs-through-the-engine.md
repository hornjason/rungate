---
doc-type: adr
status: accepted
created: 2026-11-15
updated: 2026-11-16
---

# ADR-018 — every opted-in spec runs through the engine

## Status

**Accepted, 2026-11-16.** Jason approved the plan and the five engine
criteria as redrafted, Decisions 4 to 9, and the two convergence placement
moves, on #2240 on 2026-11-16, after the consumer onboarding measurement.
Nothing is open.

**History.** Proposed 2026-11-15, revised 2026-11-16. Jason decided the three
questions on 2026-11-15: placed specs go through the engine, one queue, and
an issue plan the DA drafts and he approves. On 2026-11-16 he narrowed the
first: **a spec is consumed only when its own frontmatter opts it in**,
and a placement table alone pulls nothing (Decisions 1, 8 and 9). It
closes #2238 and serves stage F of `project-state.json`.

**#2239 is in, so this can merge.** The five engine rows land in Engine
Phase 9, where the only open engine issue already sits; the CRC-C3 row lands
in Convergence Phase 0. `plan-deps` exited 1 on a family whose open issues
sit in one phase, and `adr-accepted.yml` then skipped the Criteria column.
The dry run found this. #2239 (merged as #2242, released in 0.8.22) makes
one phase *nothing to sequence* and keeps the board steps running.

## Context

Stage F is the last stage. Its two items are read by these commands, both
taken on 2026-11-15 against `d63a2a21`:

- **F1**: five readings of the convergence family, each
  `board-conformance --produce --spec specs/CODE-REVIEW-CONVERGENCE-SPEC.md --prefix Convergence --reading <r>`.
  The results were milestones 17 of 49, criterion-coverage 50 of 66,
  blocked-by-edges 32 of 32, criteria-field 32 of 32 and queue-label 0 of 32.
- **F2**: `board-conformance --repo hornjason/rungate`. Eight readings were
  met and two were short. criteria-named was 58 of 59, because #2238 lacked
  its `serves no criterion` line (since fixed). declared-work was 44 of 58,
  with 14 short: twelve convergence criteria, plus stage items F1 and F2,
  which name no issue.

Each shortfall traces back to the same cause. **Only the engine's own spec
goes through the engine.**

| Reading | Short | Why |
|---|---|---|
| milestones | 32 | Convergence Phases 1, 5 and 6 list criteria that ADR-015 added to the placement table. `plan-spec` would update them, but `adr-accepted.yml` runs it for `board.engineSpec` only, and only when an ADR merges. Dry run: `plan-spec specs/CODE-REVIEW-CONVERGENCE-SPEC.md --prefix Convergence` prints `UPDATE` for #4, #8 and #9. |
| queue-label | 32 | `board-mirror --queue-label` adds `board.queueLabel` to the engine family only (`enginePrefixReading`). No convergence issue carries `engine`. |
| criterion-coverage | 16 | **9** criteria are placed outside every phase on purpose: Blocked (E5, E6, E7, M9), Not observable here (H1, H3, H4, H5) and Not adopted (M8). The reading asks each for an open issue anyway. **4** are open issues with no milestone, so the reading never sees them: #1883 (N3), #1818 (N7), #1816 (M16), and #1495 and #1571 (F6). #1885 (B3) is also unmilestoned, but B3 is covered by other issues. **3** are Phase 0 criteria with no issue: C3, E8 and F1. |
| declared-work | 14 | The 9 criteria placed outside phases, plus C3, E8 and F1, plus F1 and F2 in `project-state.json`. N3, N7, M16 and F6 count here, because declared-work does not read milestones. |

Two facts from the convergence spec decide the last three:

- **CRC-E8 is withdrawn, but the table still places it in Phase 0.**
  Phase 0's prose says *"CRC-E8 does not belong in this phase and is moved
  to the table above it"*. With one account and `enforce_admins`, a
  required approval deadlocks the repository. The placement table was never
  updated.
- **CRC-F1 is contested, and the spec records the outcome as "PROTECT-1
  wins".** `PROTECT-1` fails on `strict: true` in the pre-push hook, and
  setting it once refused every session's push. Nothing will be built for
  it. The spec says the decision is the owner's.

The engine spec has already answered the 9: its Phase 9 exit condition
reads *"every criterion in every spec is reachable from the board: a
milestone, an issue, or an explicit 'not started'"*. A placement outside
every phase is that explicit statement. The convergence spec says why it is
not an issue: *"forcing 'needs a second person' or 'nothing here can
observe it' into a numbered phase would state a plan for work that cannot
start"*.

SC-2625 is what F1 ends on. It fails any run in which an agent edits an
issue, milestone, edge or field by hand. So milestoning the four issues by
hand, or with a typed `plan-issues --repair --write` as ADR-015 did, would
fail the test this stage exists to pass.

## Decision

A spec opts itself in. Its frontmatter carries a `board:` block with
`scope: active` and the `prefix` its milestones use, and it has a placement
table. A spec with no `board:` block is not pulled in, whatever else it
carries. A push to main that changes `specs/` runs `plan-spec`, `plan-deps`
and `board-mirror` for every opted-in family. The same run gives each family's phase issues the queue label,
and moves an unmilestoned issue into the phase its criterion holds. The
coverage readings count a criterion its spec places outside every phase as
declared, named apart, not as missing. Then the convergence family converges
with nobody touching it, and the readings show it.

## Decisions

1. **Every opted-in spec — Jason, 2026-11-15, narrowed 2026-11-16.** The
   families are read from the specs themselves: a spec whose frontmatter
   says `board: { scope: active, prefix: <Name> }` and which carries a
   placement table. There is no list in config. The engine spec declares
   its block too, and `board.engineSpec` and `board.milestonePrefix` stay,
   so nothing reading them today changes; a disagreement between the two is
   reported by name. A generated workflow, `specs-placed.yml`, runs on a
   push to main that touches `specs/**`. For each family it runs `plan-spec --write` and then
   `plan-deps --write`. Once, after the families, it runs `board-mirror`,
   which writes the Criteria column. `adr-accepted.yml` keeps placing ADR
   plans and is unchanged.
2. **One queue — Jason, 2026-11-15.** Every open issue in any opted-in
   family's phase milestone carries `board.queueLabel` (`engine`).
   `board-mirror --queue-label` and `phase-order.yml` label every family,
   not only the engine's. Ready's selection rule (SC-2741) is untouched: the
   active milestone is still the lowest engine phase with an open issue.
3. **The issue plan is drafted and approved — Jason, 2026-11-15.** The
   table below. Five rows build the engine automation, and one row is the
   only Phase 0 convergence work that remains.
4. **An unmilestoned issue is placed by the run, never by hand — Jason,
   2026-11-16, on the DA's recommendation.** SC-2625 rules out a hand repair. The run in
   Decision 1 moves an open issue with no milestone into the phase that its
   named criterion holds in a listed spec. If the issue names criteria in
   two phases of one family, it goes to the lower one, because the issue
   cannot finish before its earliest phase does. If its criteria come from
   two families' specs, it is reported by name and left unmilestoned:
   Engine Phase 1 and Convergence Phase 1 are unrelated milestones that
   share a numeral, so neither is "lower". An issue that already has a milestone is
   never moved, which keeps ADR-015's deliberate Phase 6 placements. The
   first push to `specs/` after row 5 ships places #1883, #1885,
   #1495, #1571, #1816 and #1818. Row 5 is blocked by rows 1, 2 and 4, so
   the placement logic (row 4) and the family config it reads (row 1) are
   in by then.
5. **A criterion placed outside every phase is declared, not missing — Jason,
   2026-11-16, on the DA's recommendation.** criterion-coverage and declared-work stop
   counting the values Blocked, Not adopted — deliberate and Not observable
   here as missing. They are named apart in a line of their own, and they
   are never counted as covered by an issue. One predicate decides this for
   both readings, so the two cannot disagree. A placement value the engine
   does not know leaves both readings UNMEASURED. The alternative is nine
   issues for work the spec says cannot start, which rule 7 warns against.
6. **CRC-E8 moves to "Blocked — needs a second person" — Jason,
   2026-11-16, a correction.** The spec's own Phase 0 prose already says this. Only the table
   still disagrees.
7. **CRC-F1 moves to "Not adopted — deliberate" — Jason, 2026-11-16, on
   the DA's recommendation.** "PROTECT-1 wins" is the standing the spec records, and the spec
   names the conditions for revisiting it: merge queues become available, or
   open pull requests stay at two or fewer. It stays in the *Contested*
   audit section, so the audit's buckets do not move. **If Jason says no,**
   F1 needs a row here instead: an issue to settle the contest. That issue
   is a decision with no files, and rule 2 cannot file one.
8. **Opt-in by default — Jason, 2026-11-16.** A spec with no `board:` block
   is never planned, labelled or placed, even with a placement table. An
   ADR's decomposition table is unaffected: `adr-accepted.yml` places an
   accepted ADR's plan as before, because merging the ADR is the opt-in.
   Why: a consumer's checkboxes do not say what is done. Measured
   2026-11-16 on DailyBriefDashboard and pov-plugin, reading every line:
   18 of 59 unticked criteria (31%; 41% on DailyBriefDashboard) were
   already done, and nothing in either repo ever ticks one. Pulling a spec
   in on its table alone would file finished work.
   `spec-placement` (SC-2615, SC-2734) asks the same question of the same
   population: only opted-in specs must carry a placement table. Jason
   approved rewording both so "in scope" means opted in. The rewording lands
   in SC-2776's pull request, the change that makes it true, so neither
   ticked criterion ever claims what is not yet built.
9. **One `board:` block, open to new keys — Jason, 2026-11-16.** Board
   settings sit under one frontmatter key so that a later setting is a new
   line inside it, not a new top-level field. Today it holds `scope`
   (`active` or `deferred`) and `prefix`. A key the engine does not know is
   reported by name and otherwise ignored, so a typo never silently opts a
   spec in. The legacy `board-scope: deferred` line on 22 specs (the 22 `.claude/spec-deferral-ratchet.json` banks) means
   `scope: deferred`, so those files need no edit.

## Not decided here

- **Two workflows can write the board on one push.** Once SC-2780 builds
  `specs-placed.yml`, a merge that adds an accepted ADR and edits `specs/`
  fires it and `adr-accepted.yml` together. SC-2780's pull request must stop
  them writing the board at the same time, for example with one shared
  concurrency group. Recorded here so that row's review checks it. This pull
  request triggers only `adr-accepted.yml`, because `specs-placed.yml` does
  not exist yet.

- **How a consumer with many existing specs chooses which to opt in.**
  Jason adopted the strategy on 2026-11-16, after a read-only measurement
  of DailyBriefDashboard and pov-plugin: existing specs stay off the board;
  a report flags criteria that look done; the maintainer confirms and ticks
  with evidence before anything is filed; templates and generated copies
  are refused; untracked specs read as not tracked. It is #2275, blocked by
  this ADR's SC-2776 row, not a row here.

- **An issue filed between two pushes to `specs/` waits for the next push**
  before it is placed. Adding `issues: opened` to the trigger is a separate
  decision, because `board-ready.yml` already acts on that event.
- **Stage items F1 and F2 name no issue.** After this merges, the DA records
  `issue: 1722` on both, because #1722 is SC-2625's open issue and the
  acceptance test both items measure. That is `project-state.json`, written
  from the primary checkout (#296), not in this pull request.
- **#1722 has no blocked-by edges to these rows.** `plan-issues --decompose`
  writes edges on the rows it creates, never on an existing issue. #1722 is
  the acceptance test and closes when F1's readings are met, so the missing
  edge is recorded here rather than built.
- **Applying a repair table automatically** (`plan-issues --repair` from
  `adr-accepted.yml`) is not needed once Decision 4 ships, and is not built.

## Decomposition

The five engine criteria are written in `specs/SPEC-TO-BOARD-PIPELINE-SPEC.md`
and placed in Phase 9, *the payload ships*, the phase whose subject is
stage F, one per row. The ids SC-2776 to SC-2780 are numbered above ADR-017's SC-2772
to SC-2775 (#2219, not yet merged). They are written in the pull request
that consumes them, as #1506 decided, and they are not reserved:
`test/spec-to-board-pipeline.test.ts` refuses a reservation over ids the
spec already states. Every row lands in the active
milestone except the CRC-C3 row, which waits in Convergence Phase 0 until the
engine phases empty (SC-2741).

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| SC-2776 | A spec is consumed only when its frontmatter opts it in | lib/spec-placement.ts, scripts/board-conformance.ts, specs/SPEC-TO-BOARD-PIPELINE-SPEC.md, specs/CODE-REVIEW-CONVERGENCE-SPEC.md, test/board-families.test.ts, test/board-conformance.test.ts | Engine Phase 9 — the payload ships | — |
| SC-2777 | Every opted-in family's phase issues carry the queue label | scripts/board-mirror.ts, .github/workflows/phase-order.yml, test/board-mirror.test.ts, test/phase-order-workflow.test.ts | Engine Phase 9 — the payload ships | A spec is consumed only when its frontmatter opts it in |
| SC-2778 | A criterion placed outside every phase reads as declared and not as missing | scripts/board-conformance.ts, scripts/board-snapshot.ts, lib/spec-placement.ts, test/board-conformance.test.ts, test/board-snapshot.test.ts | Engine Phase 9 — the payload ships | A spec is consumed only when its frontmatter opts it in |
| SC-2779 | An unmilestoned issue moves into the phase milestone its criterion holds | lib/issue-repair.ts, scripts/plan-issues.ts, test/plan-issues.test.ts | Engine Phase 9 — the payload ships | A spec is consumed only when its frontmatter opts it in |
| SC-2780 | A push to main that changes specs runs every opted-in family through the engine | lib/scaffold/specs-placed-workflow.ts, .github/workflows/specs-placed.yml, lib/scaffold/owned-files.ts, lib/scaffold/steps.ts, .claude/rules/harness-managed.md, test/specs-placed-workflow.test.ts | Engine Phase 9 — the payload ships | A spec is consumed only when its frontmatter opts it in, Every opted-in family's phase issues carry the queue label, An unmilestoned issue moves into the phase milestone its criterion holds |
| CRC-C3 | A review thread resolved with no stated reason is reported on its pull request | lib/ai-review-threads.ts, scripts/ai-review-threads.ts, test/ai-review-threads.test.ts, reference/clearing-a-false-positive.md | Convergence Phase 0 — three settings, no engineering | — |
