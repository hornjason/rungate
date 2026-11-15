---
doc-type: adr
status: proposed
created: 2026-11-15
updated: 2026-11-15
---

# ADR-018 — every placed spec runs through the engine

## Status

**Proposed, 2026-11-15.** Jason decided the three questions on 2026-11-15:
every placed spec, one queue, and an issue plan the DA drafts and he
approves. This draft is that plan. The four engine criteria (SC-2776 to
SC-2779) and the two placement moves in the convergence spec are drafts and
need his yes. Merging this file with `status: accepted` is the yes. It
closes #2238 and serves stage F of `project-state.json`.

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

Config lists every spec that carries a placement table. A push to main that
changes `specs/` runs `plan-spec`, `plan-deps` and `board-mirror` for every
listed family. The same run gives each family's phase issues the queue label,
and moves an unmilestoned issue into the phase its criterion holds. The
coverage readings count a criterion its spec places outside every phase as
declared, named apart, not as missing. Then the convergence family converges
with nobody touching it, and the readings show it.

## Decisions

1. **Every placed spec — Jason, 2026-11-15.** `board.families` in
   `.claude/rungate/config.json` lists `{ prefix, spec }` for every family
   other than the engine's. The engine keeps `board.engineSpec` and
   `board.milestonePrefix`, so nothing reading them today changes. A
   generated workflow, `specs-placed.yml`, runs on a push to main that
   touches `specs/**`. For each family it runs `plan-spec --write` and then
   `plan-deps --write`. Once, after the families, it runs `board-mirror`,
   which writes the Criteria column. `adr-accepted.yml` keeps placing ADR
   plans and is unchanged.
2. **One queue — Jason, 2026-11-15.** Every open issue in any listed
   family's phase milestone carries `board.queueLabel` (`engine`).
   `board-mirror --queue-label` and `phase-order.yml` label every family,
   not only the engine's. Ready's selection rule (SC-2741) is untouched: the
   active milestone is still the lowest engine phase with an open issue.
3. **The issue plan is drafted and approved — Jason, 2026-11-15.** The
   table below. Five rows build the engine automation, and one row is the
   only Phase 0 convergence work that remains.
4. **An unmilestoned issue is placed by the run, never by hand — DA's
   recommendation, for Jason.** SC-2625 rules out a hand repair. The run in
   Decision 1 moves an open issue with no milestone into the phase that its
   named criterion holds in a listed spec. If the issue names criteria in
   two phases, it goes to the lower one, because the issue cannot finish
   before its earliest phase does. An issue that already has a milestone is
   never moved, which keeps ADR-015's deliberate Phase 6 placements. The
   first push to `specs/` after rows 2 and 5 ship places #1883, #1885,
   #1495, #1571, #1816 and #1818.
5. **A criterion placed outside every phase is declared, not missing — DA's
   recommendation, for Jason.** criterion-coverage and declared-work stop
   counting the values Blocked, Not adopted — deliberate and Not observable
   here as missing. They are named apart in a line of their own, and they
   are never counted as covered by an issue. One predicate decides this for
   both readings, so the two cannot disagree. A placement value the engine
   does not know leaves both readings UNMEASURED. The alternative is nine
   issues for work the spec says cannot start, which rule 7 warns against.
6. **CRC-E8 moves to "Blocked — needs a second person" — a correction, for
   Jason.** The spec's own Phase 0 prose already says this. Only the table
   still disagrees.
7. **CRC-F1 moves to "Not adopted — deliberate" — DA's recommendation, for
   Jason.** "PROTECT-1 wins" is the standing the spec records, and the spec
   names the conditions for revisiting it: merge queues become available, or
   open pull requests stay at two or fewer. It stays in the *Contested*
   audit section, so the audit's buckets do not move. **If Jason says no,**
   F1 needs a row here instead: an issue to settle the contest. That issue
   is a decision with no files, and rule 2 cannot file one.

## Not decided here

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

The four engine criteria are written in `specs/SPEC-TO-BOARD-PIPELINE-SPEC.md`
and placed in Phase 9, *the payload ships*, the phase whose subject is
stage F. The ids SC-2776 to SC-2779 are reserved in
`specs/sc-reservations.json` by this branch. Every row lands in the active
milestone except the CRC-C3 row, which waits in Convergence Phase 0 until the
engine phases empty (SC-2741).

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| SC-2776 | Config lists every placed spec with its milestone prefix | lib/config-readers.ts, .claude/rungate/config.json, test/board-families.test.ts | Engine Phase 9 — the payload ships | — |
| SC-2777 | Every placed family's phase issues carry the queue label | scripts/board-mirror.ts, .github/workflows/phase-order.yml, test/board-mirror.test.ts, test/phase-order-workflow.test.ts | Engine Phase 9 — the payload ships | Config lists every placed spec with its milestone prefix |
| SC-2778 | A criterion placed outside every phase reads as declared and not as missing | scripts/board-conformance.ts, scripts/board-snapshot.ts, lib/spec-placement.ts, test/board-conformance.test.ts, test/board-snapshot.test.ts | Engine Phase 9 — the payload ships | — |
| SC-2779 | An unmilestoned issue moves into the phase milestone its criterion holds | lib/issue-repair.ts, scripts/plan-issues.ts, test/plan-issues.test.ts | Engine Phase 9 — the payload ships | — |
| SC-2776 | A push to main that changes specs runs every placed family through the engine | lib/scaffold/specs-placed-workflow.ts, .github/workflows/specs-placed.yml, lib/scaffold/owned-files.ts, lib/scaffold/steps.ts, .claude/rules/harness-managed.md, test/specs-placed-workflow.test.ts | Engine Phase 9 — the payload ships | Config lists every placed spec with its milestone prefix, Every placed family's phase issues carry the queue label, An unmilestoned issue moves into the phase milestone its criterion holds |
| CRC-C3 | A review thread resolved with no stated reason is reported on its pull request | lib/ai-review-threads.ts, scripts/ai-review-threads.ts, test/ai-review-threads.test.ts, reference/clearing-a-false-positive.md | Convergence Phase 0 — three settings, no engineering | — |
