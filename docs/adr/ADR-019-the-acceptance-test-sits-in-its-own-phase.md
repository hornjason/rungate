---
doc-type: adr
status: accepted
created: 2026-11-17
updated: 2026-11-17
---

# ADR-019 — the acceptance test sits in its own phase, and milestones follow the spec

## Status

**Accepted, 2026-11-17.** Jason asked for this on 2026-11-17, after the Ready
lane showed #1722 as startable while the work it depends on was still open.
He reviewed the dry run (`docs/adr/ADR-019-flow.html`) and agreed to Decisions
1 to 4 and the SC-2779 rewording the same day.

## Context

- **#1722 looked startable when it was not.** #1722 serves SC-2625, the engine's
  acceptance test ("the payload ships untouched"). It sits in *Engine Phase 9*
  with #2301 to #2305, the ADR-018 work it depends on. On 2026-11-17
  `work-status` listed it as the only item in Ready.
- **No tool derives that order.** The engine has two sources of ordering.
  `plan-deps` makes Phase N+1 wait on Phase N and never links two issues in the
  same phase. An ADR's Decomposition table links its own new rows, once, on
  merge, and cannot say that an *older* issue waits on them. #1722 (ADR-010)
  waiting on #2301 to #2305 (ADR-018) inside one phase fits neither, so the
  dependency lived only in prose. AGENTS.md rule 4 says that is not ordering.
- **The check could not see it.** `dependency-edges` (stage item E3) asks
  whether every link the plan derives is on the tracker. A link nothing derives
  can never read as missing.
- **The spec already says Phase 9 is last.** The `Phase 9 — the payload ships`
  section opens with "Strictly last … It is the acceptance test". ADR-018 placed
  its five building criteria in that same phase, which put building work
  beside the test that is meant to run after it.
- **The fix must not be a hand edit.** On 2026-11-17 the DA added #1722's two
  links by hand, and Jason had them removed. SC-2625 fails any run in which an
  agent edits a link by hand.
- **Moving one issue between milestones has no automatic path.** ADR-018
  Decision 4 says the placing run never moves an issue that already has a
  milestone, and SC-2779 says so in its text. Measured 2026-11-17 over the 39
  open issues in an Engine or Convergence phase milestone (each issue's
  title and body matched against its family spec's criteria and placement
  table, read-only):
  34 sit in the phase their criteria hold, 4 name criteria in two placements,
  and 1 does not match — #1764, in Convergence Phase 3, names only CRC-B4,
  which the spec places in Phase 2.

## Decision

The acceptance test gets its own phase, last, so the engine's existing phase
rule makes it wait on everything before it. Milestones follow the spec: when
every criterion an issue names sits in one phase of its family, the placing
run moves the issue to that phase's milestone, whether or not it has one. Then
changing a placement table row is the whole change. The board follows on the
next push to `specs/`, and nobody touches an issue.

## Decisions

1. **SC-2625 moves to a new Phase 10 — proposed by the DA, agreed by Jason 2026-11-17.** The placement
   table changes by one row:

   ```diff
   -| **Phase 9** | SC-2625, SC-2776, SC-2777, SC-2778, SC-2779, SC-2780 |
   +| **Phase 9** | SC-2776, SC-2777, SC-2778, SC-2779, SC-2780 |
   +| **Phase 10** | SC-2625 |
   ```

   Phase 9 gets a new heading, *every opted-in spec runs through the engine*.
   The old heading and its "strictly last" prose become *Phase 10 — the
   payload ships*. `plan-spec` matches milestones by phase number, so it
   renames the Phase 9 milestone in place, and #2301 to #2305 keep their lane.
   It also creates *Engine Phase 10 — the payload ships*. `plan-deps` then
   makes every Phase 10 issue wait on every Phase 9 issue, including any Phase 9
   issue a later ADR adds. Dry run of `plan-spec` on the edited table,
   2026-11-17: `RENAME Engine Phase 9 — every opted-in spec runs through the
   engine (was: Engine Phase 9 — the payload ships, #20)` and `CREATE Engine
   Phase 10 — the payload ships`; 2 milestone changes, nothing else.
2. **The table edit lands in #2305's pull request, not this one — proposed by
   the DA, agreed by Jason 2026-11-17.** #2305 builds `specs-placed.yml`, the run that applies a
   placement change on a push to `specs/`. Landing the edit in that pull
   request means the merge that creates the run also triggers it. One
   automatic run then renames the milestone, creates Phase 10, moves #1722
   (Decision 3) and links it. Landing it here instead would break things:
   this ADR has no Decomposition table, so `adr-accepted.yml` places nothing
   for it (`plan-issues --accepted-since` lists only ADRs that carry one). The
   spec would then say Phase 10 while no Phase 10 milestone existed, and stage
   item B1's `milestones` reading, which CI runs, would go short until #2305
   shipped. #2305 grows from 6 files to 7.
   #2305's review should check that its run places issues (#2304's rule)
   *before* it runs `plan-deps`, so the links follow the new milestones in
   the same run.
3. **ADR-018 Decision 4 is narrowed — proposed by the DA, agreed by Jason 2026-11-17.** It was "an issue
   that already has a milestone is never moved". It becomes: an issue whose
   named criteria all sit in ONE phase of ONE family moves to that phase's
   milestone, even if it already has a different milestone of that family.
   - An issue naming criteria in two phases is never moved.
   - An issue whose criteria come from two families is never moved.
   - An issue in another family's milestone, or none, is handled as before.

   The four issues that name criteria in two placements stay put, as they did
   under the old rule. This lands in SC-2779's issue (#2304). That issue is not
   built yet, and its files (`lib/issue-repair.ts`, `scripts/plan-issues.ts`,
   `test/plan-issues.test.ts`) do not change.
4. **Two issues move on that first run — agreed by Jason 2026-11-17.**
   - #1722 moves Phase 9 → Phase 10. That is the point of this ADR.
   - #1764 moves Convergence Phase 3 → Phase 2, because it names only CRC-B4.
     If #1764 belongs in Phase 3 on purpose, the answer is to place what it
     serves in Phase 3, or have it name a Phase 3 criterion. A milestone that
     disagrees with the spec is the drift this ADR removes.

## SC-2779, reworded — approved by Jason 2026-11-17

This is ADR-018 Decision 8's pattern. The rewording lands in #2304's pull
request, with the code that makes it true, so the criterion never claims what is
not built:

> **SC-2779**: an open issue whose named criteria are all placed in ONE phase
> by ONE opted-in family's spec is moved by the run SC-2780 describes into that
> family's milestone for that phase, whether it has no milestone or a different
> one of that family; an issue with no milestone whose criteria span phases of
> one family goes to the lowest of them; an issue whose criteria are placed by
> two families' specs is reported by name and left where it is, because phase
> numbers do not compare across specs; and an issue with a milestone whose
> criteria span two phases is never moved

## Not decided here

- **Same-phase dependencies across plans, in general.** This ADR fixes the one
  case found by turning an ordering into a phase boundary. It does not make
  `dependency-edges` able to see a dependency that only prose states.
  #1722 is the only instance measured, and nobody has looked for more. Finding
  others means reading issue prose for ordering words, which is
  `unaccounted-work`'s (#2100) territory. Worth a measurement before any rule.
- **Until #2304 and #2305 ship, #1722 stays in Phase 9 and Ready can show it.**
  Nobody should start it. Its own text says it is the acceptance run.

## Decomposition

None, on purpose: no new issues and no new criteria. Decision 1's table edit
rides in #2305 (Decision 2). Decision 3 widens #2304, whose criterion is
reworded above. With no table, `adr-accepted.yml` places nothing when this
merges. That is checked, not assumed: `plan-issues --accepted-since` prints
"accepted, and carries no Decomposition table — nothing to place" for such an
ADR. A table with a header and no rows would instead fail the merge run
(`plan-issues --decompose`: "the table has a header and no rows").
