---
doc-type: adr
status: accepted
created: 2026-11-17
updated: 2026-11-17
---

# ADR-020 — An issue a consumer files gets a verdict, and the board shows one that has not

## Status

**Accepted, 2026-11-17.** Jason accepted it on 2026-11-17, after confirming that a
consumer issue is triaged when it is opened and the daily run only catches
what an event missed. He asked for this on 2026-11-17 and chose the
shape: triage by a tool, a sweep on a schedule, and a board reading that goes
short when a consumer issue has no verdict. He also asked that the filing cap
stop limiting work while nobody is swarming. He answered Decisions 4 and 5
the same day: the 36 ceiling in direct-ship mode, and Engine Phase 9. #2305's
first run has since renamed Engine Phase 9, so what remains is his merge.

## Context

- **Nothing reads the `from-consumer` label.** `git grep from-consumer -- lib
  scripts .github` on main at c1bc9556 finds only the generated
  reporting-upstream rule, which tells a consumer to apply it. No workflow,
  intake source or board reading acts on it.
- **Consumer issues land where Ready never looks.** #2317 and #2318 arrived on
  2026-11-17 with no milestone. Ready draws only from the active engine
  milestone (SC-2741). `plan-issues --place` (SC-2779) places only an issue
  that names a placed criterion, and a consumer's report names none. 24 open
  issues had no milestone that day.
- **They arrive in a shape this repository's gates refuse.** Neither answered
  the criterion question, so `criteria-named` (E2) went short. Every pull
  request's CI was red until the DA added "serves no criterion" to both by
  hand. #2318 also records the FindingArbiter refusing the reporting rule's
  own documented command.
- **The filing cap was built for a swarm.** In direct-ship mode a run files 12
  issues a day, or 36 when the repository closed at least as many as it opened
  (ADR-016). On 2026-11-17 the repository opened 20 and closed 11, so the cap
  was 12, and the DA's 12 were spent. That included a release issue and this
  ADR's own issue. Consumer reports make the trailing day's growth positive
  more often, so the 36 ceiling applies less often.

## Decision

Every issue a consumer files reaches a verdict from a tool within a day. The
verdict is one of these:

- placed in the phase its criteria hold;
- placed beside the open work it overlaps;
- marked a duplicate;
- placed in the active phase, so Ready draws it next.

The board reading goes short, by issue, when one has waited two days with
none. In direct-ship mode the filing cap is the ceiling every day.

## Decisions

1. **One decider gives the verdict — Jason, 2026-11-17.** `rungate
   consumer-triage` reads each open `from-consumer` issue with no verdict. It
   writes the first verdict that fits:
   - **DUPLICATE #N**: the FindingArbiter's duplicate test matches an open
     issue. It gets a comment naming #N. Closing it stays a person's call.
   - **PLACED**: it names a criterion an opted-in spec places in a phase. It
     moves through `issuePlacement`, the SC-2779 decider, never a second one.
   - **OVERLAPS #N**: its declared files meet those of an open issue or open
     pull request (`lib/issue-file-overlap.ts`), or it names a criterion that
     issue names. It joins #N's milestone, and a comment names the overlap. No
     blocked-by link is written: a shared file is a conflict, not an order,
     which `lib/issue-file-overlap.ts` already records.
   - **ACTIVE**: none of the above. It joins the active engine milestone (the
     lowest engine phase with an open issue, SC-2741), so Ready draws it in
     phase order, ahead of later phases and behind the active phase's own
     work.

   Each verdict leaves a marker comment the reading can find. Every verdict
   but DUPLICATE gives the issue `board.queueLabel`.
2. **It runs when an issue is filed, and every day — Jason, 2026-11-17.** A
   generated workflow, `consumer-intake.yml`, runs the triage with `--write`
   on `issues: opened` and `labeled` carrying `from-consumer`, and on a daily
   schedule. The schedule catches anything an event missed. It uses the job's
   `GITHUB_TOKEN`, so its milestone writes fire no further event.
   **An outside reporter's label is put back first — Jason, 2026-11-17.**
   GitHub silently drops the labels on a new issue whose author has no push
   access. So the scaffolded `reporting-upstream.md` rule's `--label
   from-consumer` never arrives from a real outside consumer, and a trigger
   keyed on the label alone would miss every one of their reports, the daily
   run included. The workflow therefore also acts on a newly opened issue
   whose author association is not `OWNER`, `MEMBER` or `COLLABORATOR`. It
   adds `from-consumer` to that issue, and the triage and the reading then
   see it like any other. Every report so far carried the label only because
   this repository's own sessions filed them with the owner's token.
3. **The board shows what was missed — Jason, 2026-11-17.** A new reading,
   `consumer-intake`, counts open `from-consumer` issues older than two days.
   Each must carry a verdict marker or a milestone. One with neither makes the
   reading SHORT, naming it. The reading joins the goal command, so
   `board-conformance` and `/board` both show it.
4. **In direct-ship mode the filing cap is the ceiling every day — proposed by
   the DA, agreed by Jason 2026-11-17.** In `ship.mode: direct`, every run
   gets `NET_GROWTH_CEILING` (36). The net-growth fallback to 12 then applies
   only in harness mode, where swarms run and where #1595 filed 57 in a day.
   The net-growth reading is still printed on every refusal.
5. **Placement in Engine Phase 9 — proposed by the DA, agreed by Jason
   2026-11-17.** The four criteria go in Phase 9 beside ADR-018's, so Ready
   draws this work next. Phase 10, the acceptance test (#1722), waits on them
   by the phase rule. Stage item F1 does not: its readings are about the
   convergence family and are met by #2305's first run. The alternative, a
   stage G after stage F, was declined: it would leave consumer work waiting
   behind the acceptance test.

## Not decided here

- **How a consumer's report is shaped.** #2318 already covers making the
  reporting rule's command pass the FindingArbiter and answer the criterion
  question, and #2317 covers the filing gate's claim numbers. The triage then
  gives both a verdict like any other consumer issue. They are not rows here.
- **Closing a duplicate.** A comment names the original. Closing stays a
  person's act (AGENTS.md: never close an issue by hand to stand in for a
  merge).
- **Consumers other than this repository's.** The triage reads this repository's
  tracker. A consumer that wants the same for its own reporters scaffolds the
  same workflow; whether that is on by default is decided with the row that
  generates it.

## Decomposition

The criteria are written in `specs/SPEC-TO-BOARD-PIPELINE-SPEC.md`, placed in
Phase 9 (Decision 5). Their ids are reserved for this branch in
`specs/sc-reservations.json` (`rg/adr-020-consumer-verdict`, 2782-2785), which
#2327 made possible; after merge `lib/create-sc.ts`'s taken set holds them and
the block is deleted. `consumer-intake.yml` calls `consumer-triage` through the
published CLI, so a release falls between the first row and the third
(`docs/guides/RELEASING.md`, "A command a generated workflow calls ships
BEFORE the workflow that calls it").

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| SC-2782 | A consumer's issue gets a triage verdict from one decider | lib/consumer-triage.ts, scripts/consumer-triage.ts, lib/cli-commands.ts, test/consumer-triage.test.ts, package.json | Engine Phase 9 — every opted-in spec runs through the engine | — |
| SC-2783 | The board reads a consumer issue with no verdict after two days as short | scripts/board-snapshot.ts, scripts/board-conformance.ts, test/board-conformance.test.ts, test/board-snapshot.test.ts | Engine Phase 9 — every opted-in spec runs through the engine | A consumer's issue gets a triage verdict from one decider |
| SC-2784 | A consumer's issue is triaged when it is filed and swept every day | lib/scaffold/consumer-intake-workflow.ts, .github/workflows/consumer-intake.yml, lib/scaffold/owned-files.ts, lib/scaffold/steps.ts, .claude/rules/harness-managed.md, test/release-guard.test.ts, test/consumer-intake-workflow.test.ts | Engine Phase 9 — every opted-in spec runs through the engine | A consumer's issue gets a triage verdict from one decider |
| SC-2785 | In direct-ship mode the filing cap is the ceiling whatever the day's growth | lib/issue-filing-gate.ts, test/issue-filing-gate.test.ts | Engine Phase 9 — every opted-in spec runs through the engine | — |
