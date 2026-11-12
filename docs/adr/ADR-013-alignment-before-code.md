---
doc-type: adr
status: accepted
created: 2026-11-11
updated: 2026-11-11
---

# ADR-013 — alignment before code, and a board that moves by itself

## Status

**Accepted, 2026-11-11. Revision 4.** Revisions 1, 2 and 3 were each audited
by a fresh reader with no part in the conversation; a process review and a
whole-process audit sit between them. Every decision below carries who made
it. Earlier revisions, with every audit finding verbatim, are in this file's
git history (`git log -p -- docs/adr/ADR-013-alignment-before-code.md`).

The visual for this ADR is `docs/adr/ADR-013-flow.html`, produced by the dry
run (row 7).

## The problem

Jason, across sessions: *"the biggest problem I have is not knowing what the
true status at any given time is."* And on 2026-11-11: over-eagerness to
code before total alignment.

Measured 2026-11-11:

- **Ready fills itself with work nobody chose.** It tops up to 2 from 49
  candidates; 46 carry only a label.
- **Placing a plan on the board is hand-run.** No workflow calls
  `plan-issues --decompose`, `plan-spec` or `plan-deps`. SUCCESS.md Claim 7
  counts a board state reachable only by hand as failure.
- **A PR need not close an issue, or close one that names a criterion.**
  14 of the last 40 merged PRs closed no issue; 42 open issues name no
  criterion. `closing-references` is not a required check.
- **The meter measures the wrong population.** `board-conformance` reads
  `spec-placement` SHORT 87 of 1,815; 87 is exactly the engine (26) and the
  payload (61), and the 1,728 short is 22 specs already declared UNPLANNED.

## The law — the four-step process (Jason and Rayford, 2026-11-11)

1. **Agree, and file one issue the same turn**, with the existing issue
   template. (AGENTS.md rule 9.)
2. **If it is big** — more than one issue, or it changes a rule or a gate:
   write an ADR from the ADR template (row 6; until it ships, copy this
   ADR's Decomposition table), write its SC lines into the governing spec,
   and run `/dry-run` until Jason agrees with every step it shows. One PR
   closes the step-1 issue carrying the accepted ADR, the SC lines and the
   filled table; Jason merges. Small decisions skip to 4.
3. **On merge, a workflow places the plan**: `plan-spec --write`, then
   `plan-issues --decompose --write`, then `plan-deps --write`, then
   `board-mirror --write`, then `board-ready --top-up --write`. It fires only
   when `status` changes to `accepted`.
4. **Build each issue**: a PR with `Fixes #N`. `closing-references` refuses
   a PR that closes no issue, or whose issue names neither a criterion nor
   `serves no criterion`.

**Exempt from step 1:** the work that decides what the issues are — an ADR,
a retro, a review, an audit — and session-record PRs. **The decider is the
branch name**, the rule #1950 already uses: a branch naming no issue (for
example `rg/session-89-state`) owes no closing reference. The bypass this
opens is stated, not hidden: any PR can skip the check by naming its branch
without an issue number. (Second and third audits; Jason, 2026-11-11.)

**No rule 11.** The law folds into rule 9. Rule 10 is narrowed: the stage
ladder is the plan for the engine build order; all work is an issue first.
(Process review; Jason, 2026-11-11.)

**Stays human by design:** agreeing, writing SC text, choosing the spec,
judging size, merging. **Everything else is mechanical** once rows 1-8 ship.

## How work reaches Ready — row 8 (Jason, 2026-11-11)

Kanban pull, as the industry runs it: one active focus, an ordered backlog,
a WIP cap, an expedite lane.

- **The active milestone is the lowest Pipeline phase with an open issue.**
  This is `openFrontier` in `lib/board-mirror.ts`, which `plan-deps` already
  reports ("Frontier: Phase 6") — reused, not a second decider. Milestone
  open/closed state is not used: Phases 0-5 are open milestones with no open
  issues.
- **Payload waits for the car.** Convergence milestones enter Ready only when
  no Pipeline phase has an open issue. (Decision 9.)
- **As a slot opens, `board-ready` refills from the active milestone.**
  Inside it: blocked-by edges where order matters, else oldest first.
- **`work-this-next` is the expedite lane**, bounded by Ready's depth.
- **Label-only issues never enter Ready.** `LABEL_RANK` is deleted.
- **Nothing pickable → Ready stays empty.**
- **Reopening an issue in a finished phase moves the frontier back to it.**
  Intended: reopened work is unfinished work in an earlier phase.

Holes closed by row 8, found walking every entry path: `board-ready` gains
the `milestoned`, `demilestoned` and `labeled` triggers; `board-intake`
handles `transferred` (#1752); `board-mirror --write` stops writing Ready on
its own rule.

## Decisions

1. **Car before payload, ratcheted by name — Jason.** `spec-placement`
   measures specs that declare themselves in scope; a spec held back says so
   in its own frontmatter. The deferred specs are banked by path with their
   criteria counts, refusing in both directions, like
   `.claude/config-access-ratchet.json`. SC-2615 is amended in the same PR,
   because row 1 changes the population it states.
2. **`criteria-named` keeps its repository-wide population.** Revision 1's
   premise ("the offenders predate the engine") was false. #1954 is the
   repair.
3. **The stage ladder stays — reversed by the first audit.** It carries
   `agreed`, `scope` and the denial check, and runs in CI. #1984 makes
   `work-status` read it. The eight ladder-only items each point at the
   issue covering them; E4 (`board-mirror --write`, #1945) is row 5.
4. **The PR check blocks from day one — Jason.** No warn period, no streak
   counter. The workflow also triggers on `edited`. Switch:
   `RUNGATE_REQUIRE_CLOSING_REF`, read exactly as `RUNGATE_REQUIRE_AI_REVIEW`
   is. Old issues with no criterion are fixed when a PR hits them; editing
   an issue fires no pull-request event, so the refusal prints the one
   command that re-runs the check (`gh run rerun <run-id>`).
5. **Labels that still decide something come from config — Jason.** Once
   row 8 deletes `LABEL_RANK`, two remain in library code:
   `WORK_NEXT_LABEL` (`lib/board-ready-rule.ts`) and `FILING_OVERRIDE_LABEL`
   (`lib/issue-filing-gate.ts`). Row 2 moves both into
   `.claude/rungate/config.json`. `OVERRIDE_LABELS` in
   `lib/issue-create-override.ts` is a different decider (the mid-VERIFY
   filing lock) and is left alone.
6. **ADR-013's rows go into the current frontier, Pipeline Phase 6 — Jason.**
   It is already the active milestone, so the rows go ahead of Phases 7-9
   with no renumbering. Renumbering was refused: `plan-spec` matches
   milestones by phase number (`liveByPhase` in `lib/spec-placement.ts`), so
   shifting 6-9 to 7-10 would retitle milestones while their issues stayed,
   leaving #1717 under the wrong title and Phase 10 empty.
7. **Every proposal is shown as a dry run before "go" — Jason.** Real tool
   output where a dry run exists, a visual next to the ADR, re-run after any
   change. Row 7.
8. **Consumers get this process through a follow-up ADR — Jason.** The third
   audit found the scaffold route mostly unbuilt: `board-ready.yml` is not
   scaffolded to consumers, `closing-references.yml` is deliberately not
   scaffold-owned (#1362), the scripts are in neither `files[]` nor the CLI
   registry, the scaffold installs no commands, and PROTECT-1
   (`lib/branch-protection.ts`) reads merge serialisation only — it cannot
   report a check that exists but is not required. **#1988** carries it.
   Every row here is built so the follow-up can ship it: config over
   constants, one command per human step.
9. **Payload waits for the car — Jason delegated, Rayford decided.** #1764
   leaves Ready when row 8 ships.
10. **Everyday work gets no milestone of its own — same.** It stays in
    Backlog until someone moves it into the active milestone, or marks it
    `work-this-next` when urgent. A second standing milestone would be a
    second queue.

## Decomposition

Ids SC-2734 to SC-2741 are written as criteria in
`specs/SPEC-TO-BOARD-PIPELINE-SPEC.md` and placed in Phase 6. They hold no
entry in `specs/sc-reservations.json`: they were checked free across every
open branch (none was open) and written in the same PR, and
`test/spec-to-board-pipeline.test.ts` refuses a block covering ids the spec
already states; once merged, `lib/create-sc.ts`'s `taken` set protects
them. All rows sit in the current frontier milestone.

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| SC-2734 | The meter counts only in-scope specs with deferred specs ratcheted by path | scripts/board-conformance.ts, .claude/spec-deferral-ratchet.json, specs/SPEC-TO-BOARD-PIPELINE-SPEC.md, test/board-conformance.test.ts | Pipeline Phase 6 — the board's state is a reading | |
| SC-2735 | The expedite and filing-override labels are read from config | .claude/rungate/config.json, lib/config-readers.ts, lib/board-ready-rule.ts, lib/issue-filing-gate.ts, test/board-ready-rule.test.ts | Pipeline Phase 6 — the board's state is a reading | |
| SC-2736 | Rule 9 carries the four-step process and its exempt class | AGENTS.md, test/rule-provenance.test.ts | Pipeline Phase 6 — the board's state is a reading | |
| SC-2737 | A PR must close an issue that names a criterion | .github/workflows/closing-references.yml, scripts/audit-closing-references.ts, test/audit-closing-references.test.ts | Pipeline Phase 6 — the board's state is a reading | |
| SC-2738 | Merging an accepted ADR places its plan on the board | .github/workflows/adr-accepted.yml, scripts/plan-issues.ts, lib/issue-decomposition.ts, test/issue-decomposition.test.ts, test/adr-accepted-workflow.test.ts | Pipeline Phase 6 — the board's state is a reading | ADR template whose table the filing tool reads |
| SC-2739 | ADR template whose table the filing tool reads | docs/adr/TEMPLATE.md, test/adr-template.test.ts | Pipeline Phase 6 — the board's state is a reading | |
| SC-2740 | The dry-run command shows a proposal as a real dry run with its visual | .claude/commands/dry-run.md, test/dry-run-command.test.ts | Pipeline Phase 6 — the board's state is a reading | |
| SC-2741 | Ready refills only from the active milestone | lib/board-ready-rule.ts, scripts/board-ready.ts, .github/workflows/board-ready.yml, .github/workflows/board-intake.yml, scripts/board-mirror.ts, test/board-ready-rule.test.ts, test/board-ready-fanout.test.ts | Pipeline Phase 6 — the board's state is a reading | The expedite and filing-override labels are read from config |

Notes per row:

- **Row 4 goes first** (`work-this-next`): every PR after it is checked.
- **Row 5** closes #1945 (E4). Its workflow splits credentials by step:
  `GITHUB_TOKEN` (passed as `GITHUB_TOKEN`, because `plan-issues` drops
  `GH_TOKEN`) for issues, milestones and edges; `RUNGATE_PROJECT_TOKEN` in
  the `board-mirror` step's env only, never widened. Issues created with
  `GITHUB_TOKEN` fire no `issues: opened` run, so the workflow ends with
  `board-ready --top-up --write`. Its duplicate check also covers closed
  issues, and it refuses a criterion id that exists in no spec (found by
  the first dry run).
- **Row 8** is blocked by row 2 because both edit `lib/board-ready-rule.ts`.
  It names #1752 (transferred) and relates to #1976 (grouping Ready by file
  overlap). It absorbs revision 3's row 8: `board-intake` already adds a
  card on `opened`, so only the missing triggers remain. **It also demotes
  any Ready card outside the active milestone** (that isn't
  `work-this-next`): measured, `incumbentDecisions` in
  `lib/board-ready-fanout.ts` demotes an incumbent only when it is blocked,
  so without this a card dragged in by hand, or #1764, would hold its slot
  forever.

## Not decided here

- Which specs are admitted after the car is done; whether
  `specs/HARNESS-STANDARD.md` (`doc-type: reference`, 648 criteria) is a
  spec; the duplicate `ADR-011`.
- The milestones "Issue intake" and "Convergence Machinery" lack `Phase N`
  in their titles, so `phaseOf` cannot rank them: rename or close, no code.

## Where this stands — 2026-11-11

- Filed: #1985 (this ADR's rule-9 issue; the acceptance PR closes it),
  #1986 (`hooks.json` records a live hook as not live), #1988 (the consumer
  follow-up, blocked by #1985).
- Continuing alongside: #1984 (`work-status` reads the ladder; WIP on
  `rg/1984-stage-ladder-in-work-status`), #1954, #1983.
- **Next:** Jason merges the acceptance PR (#1985 closes) → the eight rows
  are filed by hand this once with `plan-issues --decompose --write` → row 4
  gets `work-this-next` → row 4 is built first. SC-2615 is amended in row
  1's PR.
- **Human steps after row 4 merges, Jason's** (repository settings):
  add `closing-references` to main's required checks, and set the variable
  `RUNGATE_REQUIRE_CLOSING_REF` to `true`. The exact commands are printed
  when row 4 merges.
