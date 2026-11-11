---
doc-type: adr
status: proposed
created: 2026-11-11
updated: 2026-11-11
---

# ADR-013 — alignment before code, and a board that moves by itself

## Status

**Proposed, 2026-11-11. Revision 3.** Revisions 1 and 2 were each audited by
a fresh reader with no part in the conversation; a process review and a
whole-process audit followed. Every decision below carries who made it.
Revision 2's full text, with every audit finding verbatim, is in this file's
git history (`git log -p -- docs/adr/ADR-013-alignment-before-code.md`).

The visual for this ADR is `docs/adr/ADR-013-flow.html`, produced by the
dry run (row 7).

## The problem

Jason, across sessions: *"the biggest problem I have is not knowing what the
true status at any given time is."* And on 2026-11-11: over-eagerness to
code before total alignment.

Measured 2026-11-11:

- **Ready fills itself with work nobody chose.** It tops up to 2 from 50
  candidates; 46 of the 50 carry only a label.
- **Placing a plan on the board is hand-run.** No workflow calls
  `plan-issues --decompose`, `plan-spec` or `plan-deps`. SUCCESS.md Claim 7
  counts a board state reachable only by hand as failure.
- **A PR need not close an issue, or close one that names a criterion.**
  14 of the last 40 merged PRs closed no issue; 41 open issues name no
  criterion, 24 of them filed in November. `closing-references` is not a
  required check.
- **The meter measures the wrong population.** `board-conformance` reads
  `spec-placement` SHORT 87 of 1,815; 87 is exactly the engine (26) and the
  payload (61), and the 1,728 short is 22 specs already declared UNPLANNED.
- **A consumer receives none of the process.** The scaffold does not emit
  `closing-references.yml`; nothing sets a consumer's branch protection.

## The law — the four-step process (Jason and Rayford, 2026-11-11)

1. **Agree, and file one issue the same turn**, with the existing issue
   template. (AGENTS.md rule 9.)
2. **If it is big** — more than one issue, or it changes a rule or a gate:
   write an ADR from `docs/adr/TEMPLATE.md`, write its SC lines into the
   governing spec, and run `/dry-run` until Jason agrees with every step it
   shows. One PR closes the step-1 issue carrying the accepted ADR, the SC
   lines and the filled table; Jason merges. Small decisions skip to 4.
3. **On merge, a workflow places the plan**: `plan-spec --write`, then
   `plan-issues --decompose --write`, then `plan-deps --write`, then
   `board-mirror --write`. It fires only when `status` changes to
   `accepted`.
4. **Build each issue**: a PR with `Fixes #N`. `closing-references` refuses
   a PR that closes no issue, or whose issue names neither a criterion nor
   `serves no criterion`.

**Exempt from step 1:** the work that decides what the issues are — an ADR,
a retro, a review, an audit — and session-record PRs. (Second audit,
finding 4; Jason, 2026-11-11.)

**No rule 11.** The law folds into rule 9. Rule 10 is narrowed: the stage
ladder is the plan for the engine build order; all work is an issue first.
(Process review; Jason, 2026-11-11.)

**Stays human by design:** agreeing, writing SC text, choosing the spec,
judging size, merging. **Everything else is mechanical** once rows 1-9 ship.

## How work reaches Ready — row 9 (Jason, 2026-11-11)

Kanban pull, as the industry runs it: one active focus, an ordered backlog,
a WIP cap, an expedite lane.

- **The active milestone is the lowest open phase.** `plan-deps` already
  blocks every later phase behind it.
- **As a slot opens, `board-ready` refills from it.** Inside a milestone:
  blocked-by edges where order matters, else oldest first.
- **`work-this-next` is the expedite lane**, bounded by Ready's depth.
- **Label-only issues never enter Ready.** Backlog clearing gets its own
  ordered milestone.
- **Nothing pickable → Ready stays empty.**

Holes found walking every entry path, closed by rows 8 and 9: adding a
milestone or `work-this-next` triggers nothing (`board-ready` listens for
neither `milestoned` nor `labeled`); `board-mirror --write` is a second,
hand-run writer of Ready; a transferred issue gets no card (#1752).

## Decisions

1. **Car before payload, ratcheted by name — Jason.** `spec-placement`
   measures specs that declare themselves in scope; a spec held back says so
   in its own frontmatter. The deferred specs are banked by path with their
   criteria counts, refusing in both directions, like
   `.claude/config-access-ratchet.json`. A bare total was refused by the
   second audit: it is satisfiable by swapping members.
2. **`criteria-named` keeps its repository-wide population.** Revision 1's
   premise ("the offenders predate the engine") was false. #1954 is the
   repair.
3. **The stage ladder stays — reversed by the first audit.** It carries
   `agreed`, `scope` and the denial check, and runs in CI. #1984 makes
   `work-status` read it. The eight ladder-only items each point at the
   issue covering them; E4 (`board-mirror --write`) joins step 3's workflow.
4. **The PR check blocks from day one — Jason.** No warn period, no streak
   counter. The workflow also triggers on `edited`. Switch:
   `RUNGATE_REQUIRE_CLOSING_REF`, read exactly as `RUNGATE_REQUIRE_AI_REVIEW`
   is — `true` here, off by default for a consumer. Old issues with no
   criterion are fixed when a PR hits them.
5. **One `board.labels` config block — Jason.** No label vocabulary in
   library code: `RANKED_LABELS` and `WORK_NEXT_LABEL` in
   `lib/board-ready-rule.ts`, `FILING_OVERRIDE_LABEL` in
   `lib/issue-filing-gate.ts`, and a second copy of two labels in
   `lib/issue-create-override.ts`.
6. **ADR-013's work goes ahead of open engine phases — Jason.** It becomes
   Pipeline Phase 6; today's Phases 6-9 become 7-10. `plan-spec` renames
   the milestones from the table; existing order edges stay valid because
   relative order is unchanged.
7. **Every proposal is shown as a dry run before "go" — Jason.** Real tool
   output where a dry run exists, a visual next to the ADR, re-run after any
   change. Row 7.
8. **A consumer gets every row through `rungate scaffold` — Jason.** Each
   human step is printed by the tool when it is due, as one command, never
   looked up in a document. Branch protection is per repository; PROTECT-1
   (`lib/branch-protection.ts`) reports a check that exists but is not
   required.

## Decomposition

Ids are reserved in `specs/sc-reservations.json` at acceptance and written
here then; `SC-TBD` marks each until that PR. All rows sit in the new
milestone.

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| SC-TBD | The meter counts only in-scope specs with deferred specs ratcheted by path | scripts/board-conformance.ts, .claude/spec-deferral-ratchet.json, test/board-conformance.test.ts | Pipeline Phase 6 — alignment before code | |
| SC-TBD | Ranked labels are read from one board.labels config block | .claude/rungate/config.json, lib/config-readers.ts, lib/board-ready-rule.ts, lib/issue-filing-gate.ts, lib/issue-create-override.ts, test/board-ready-rule.test.ts | Pipeline Phase 6 — alignment before code | |
| SC-TBD | Rule 9 carries the four-step process and its exempt class | AGENTS.md, lib/generators/agents-md.ts | Pipeline Phase 6 — alignment before code | |
| SC-TBD | A PR must close an issue that names a criterion | .github/workflows/closing-references.yml, scripts/audit-closing-references.ts, test/audit-closing-references.test.ts, lib/scaffold/steps.ts, lib/branch-protection.ts | Pipeline Phase 6 — alignment before code | |
| SC-TBD | Merging an accepted ADR places its plan on the board | .github/workflows/adr-accepted.yml, scripts/plan-issues.ts, lib/issue-decomposition.ts, test/issue-decomposition.test.ts, lib/scaffold/steps.ts | Pipeline Phase 6 — alignment before code | ADR template whose table the filing tool reads |
| SC-TBD | ADR template whose table the filing tool reads | docs/adr/TEMPLATE.md, lib/scaffold/steps.ts | Pipeline Phase 6 — alignment before code | |
| SC-TBD | The dry-run command shows a proposal as a real dry run with its visual | .claude/commands/dry-run.md, lib/scaffold/owned-files.ts, .claude/rules/harness-managed.md | Pipeline Phase 6 — alignment before code | |
| SC-TBD | A new issue is placed on the board when it is opened | scripts/board-ready.ts, lib/board-ready-rule.ts, .github/workflows/board-ready.yml, .github/ISSUE_TEMPLATE/spec-work.yml, .github/ISSUE_TEMPLATE/everyday-work.yml | Pipeline Phase 6 — alignment before code | Ranked labels are read from one board.labels config block |
| SC-TBD | Ready refills only from the active milestone | lib/board-ready-rule.ts, scripts/board-ready.ts, .github/workflows/board-ready.yml, scripts/board-mirror.ts, .github/workflows/board-intake.yml, test/board-ready-rule.test.ts | Pipeline Phase 6 — alignment before code | A new issue is placed on the board when it is opened |

What each row adds for a consumer:

1. The deferral field and the ratchet ship in the CLI.
2. `scaffold` seeds `board.labels` with defaults.
3. The generated AGENTS.md carries the process.
4. `scaffold` emits the check, off by default; it prints the two commands
   (require it, switch it on) when due.
5. `scaffold` emits the workflow.
6. `scaffold` writes the template.
7. `scaffold` installs the command.
8. and 9. ship in the generated board workflows.

**Row 4 goes first** (`work-this-next`): every PR after it is checked.

## Not decided here

- **Does payload (Convergence) milestone work wait until the car's phases
  are done?** Jason's call; #1764 holds a Ready slot today.
- **Where everyday work (`serves no criterion`) lives under row 9** — with
  no milestone it never reaches Ready.
- Whether a card dragged into Ready by hand is demoted by the next run —
  not yet checked.
- Which specs are admitted after the car is done; whether
  `specs/HARNESS-STANDARD.md` (`doc-type: reference`, 648 criteria) is a
  spec; the duplicate `ADR-011`.
- The milestones "Issue intake" and "Convergence Machinery" lack `Phase N`
  in their titles, so `phaseOf` cannot rank them: rename or close, no code.

## Where this stands — 2026-11-11

- Filed: #1985 (this ADR's rule-9 issue; the acceptance PR closes it),
  #1986 (`hooks.json` records a live hook as not live; waits for row 8).
- Continuing alongside: #1984 (`work-status` reads the ladder; WIP on
  `rg/1984-stage-ladder-in-work-status`), #1954, #1983.
- **Next:** `/dry-run` on this revision → fresh audit → Jason agrees →
  acceptance PR (ids reserved, SC lines and the Phase 6 renumber in
  `specs/SPEC-TO-BOARD-PIPELINE-SPEC.md`, visual committed) → Jason merges →
  rows filed by hand this once → row 4 first.
