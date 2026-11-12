---
doc-type: adr
status: accepted
created: 2026-11-12
updated: 2026-11-12
---

# ADR-015 — repairing the forty issues that name no criterion

## Status

**Accepted, 2026-11-12. Revision 1.** Jason accepted the four-way split,
the write-guard call and the stale closes as recommended, and chose to review
the 22 promote drafts with Rayford one batch at a time.
Widens #1954 (fifteen of these issues) to all forty, and this ADR's PR
closes it. Precedent and format: ADR-005.

## Context

`criteria-named` (E2) reads **40 short** of 87 open issues, and since #2020
each of the forty carries `needs-criterion`. Each body was read and checked
against every criterion line under `specs/`. Spot-checked on 2026-11-12:
#1554's store is empty on main (PR #1970), #1948's PR #1937 lists it as
closed yet it is open (the defect #1952 names), and #1993 says
"Serves no criterion." with a capital S, which E2 does not count.

Each issue is exactly one of four things:

| | What it is | Tool | Writes |
|---|---|---|---|
| **annotate** | its subject IS an existing criterion | `plan-issues --repair` (a) | a `## Criteria this serves` section |
| **declare** | cleanup or machinery, no criterion | `finding-promotion --declines` | the `serves no criterion` line, with why |
| **promote** | real work no criterion states | `finding-promotion --outcome` | a new criterion in the spec, and the issue's link to it |
| **stale** | already fixed or obsolete | close, citing the evidence | — |

`confidence` is the reader's; `HIGH` means the body states the criterion's
own subject, `MEDIUM` that the link is an argument. Overrule any row.

## Decisions

1. **The four-way split — Jason, 2026-11-12.** As below: 3 annotate, 12
   declare, 22 promote, 3 stale.
2. **Promote rows need Jason's criterion text — Jason, by AGENTS.md rule 9.**
   The drafts below are reviewed with him in batches before any is written.
3. **The write-guard cluster (#1355, #1367, #1407, #1425) — Jason, 2026-11-12.** Declare
   each, or write one bypass-resistance criterion in
   `specs/HOOK-ARCHITECTURE-SPEC.md` covering all four. Recommendation:
   declare #1367, #1407, #1425 and promote #1355, whose subject (filings
   escaping the meter) is the engine's own SC-2613. Accepted as recommended.
4. **Stale issues are closed by hand with the evidence — Jason, 2026-11-12.** A hand close
   is attributed to nobody (#925); the comment names the merged PR so
   `issue-audit.yml` can read it.

## Not decided here

- **No tool places a milestone on an existing issue.** `--decompose` places
  new issues and `--repair` only demotes. The milestone column below is a
  suggestion; promote rows get a phase when their criterion is written into a
  spec with a placement table (only the engine and convergence specs have
  one).
- **`closing-references` cannot read `CRC-*` ids** (`namesCriterion`,
  `lib/closing-reference-audit.ts`, matches `SC-\d+` only), so #1883 and #1885
  stay refused at PR time even after annotation. Recorded on #2020 as the
  follow-up that makes it read `criterionAnswer`.
- #1987 is two subjects and should be split before it is promoted.

## Repair table — annotate

Applied by `plan-issues --repair docs/adr/ADR-015-backlog-criterion-repair-the-forty.md --repo hornjason/rungate --write`.
`Phase` is required by the parser and used by nothing; it carries the
suggested phase in the governing spec's family, and `0` where that spec has
no placement table.

| Issue | Phase | Repair | Criteria | Confidence | Why |
|---|---|---|---|---|---|
| #1126 | 0 | (a) | `SC-1947` | HIGH | SC-1947 (constraint extraction runs as part of scaffold and re-scaffold) is #545 criterion 7 restated, and intake is that extraction. |
| #1883 | 1 | (a) | `CRC-N3` | HIGH | REVIEW.md defines `population` as the size of the flagged class, so a self-declared, unchecked population is CRC-N3 failing. |
| #1885 | 2 | (a) | `CRC-B3` | HIGH | Several independent reviewer passes merged into one is CRC-B3's "several agents look for bugs at the same time", with its warning that recall and false positives rise together. |

## Declare — `finding-promotion --issue N --declines "<why>" --write`

| Issue | Title | Confidence | Why it serves no criterion |
|---|---|---|---|
| #713 | Two hook trees: 8 duplicated names, all diverged | HIGH | The repository-side criteria shipped (#778, #970, #1006, #1045); what remains is machine state under `~/.pai` that CI cannot see. |
| #1160 | SecurityValidator refuses rm -rf of a named /tmp dir as root | HIGH | The matcher and hook live in hornjason/pai-config and `~/.pai/hooks`, not in this repository. |
| #1367 | exemptionIsVoid enumerates link-creating verbs | MEDIUM | Guard hardening; the issue itself says it moves no SUCCESS.md claim directly. |
| #1407 | bash-write-guard: second literal borrows first's exemption? | MEDIUM | An unwitnessed conjecture whose own first step is to run the witness. |
| #1425 | bash-write-guard: `cp -a` preserves an existing symlink | MEDIUM | Guard hardening; only the same-command case remains open. |
| #1643 | A judgement naming a nonexistent criterion or issue is ignored | HIGH | ADR-005 already classified it "(b) demote — census machinery". |
| #1951 | Repository facts live only in agent memory | MEDIUM | Moves measured facts into repository docs; the Ready fact behind it is SC-2642, already ticked. |
| #1954 | 15 issues filed by hand have no criterion or milestone | HIGH | Backlog repair that decides other issues — this ADR is its step 2, and its PR closes it. |
| #1968 | --project-root for work-status and board-ready | MEDIUM | CLI flag parity with `board-mirror.ts`. |
| #1973 | scripts/board-ready.ts has no test that runs it | MEDIUM | Test coverage of a script's wiring. |
| #1975 | A 5s timeout and a missing verdict look identical in the ladder | HIGH | Flake handling inside the stage-ladder test, which is rule 10 machinery. |
| #1993 | audit-specs writes two REVIEW notes under one criterion | HIGH | Its body already declares this, capitalised; the write lowercases it so E2 counts it. |

## Promote — Jason writes the criterion, then `finding-promotion --issue N --spec <spec> --symbol <s> --module <m> --outcome "<criterion>" --write`

| Issue | Title | Draft criterion | Spec | Suggested milestone |
|---|---|---|---|---|
| #1046 | Harness measures agent time and suites but nothing about CI | Every merged PR carries a CI reading — per-check duration, queue time, open→first-check→last-check→merge — and a check that did not run reads UNMEASURED, never 0. | HARNESS-STANDARD.md | — |
| #1194 | Consumer-shaped test: install the tarball, assemble a brief | A brief assembled from the installed package contains `_shared.md`, and the same test fails against a version that does not ship `gates/`. | AGENT-BRIEF-TEMPLATE-SPEC.md | — |
| #1355 | heredocInterpreter reads only the opener line | A `gh issue create` reached through a heredoc in a subshell, brace group, continued line or `eval` is metered as a filing attempt. | SPEC-TO-BOARD-PIPELINE-SPEC.md | Pipeline Phase 5 (beside SC-2613) |
| #1495 | ai-review waiver disarm is one-shot; re-arm never seen | A waived review cannot merge unread: auto-merge armed after the review's last run is disarmed or refused. | CODE-REVIEW-CONVERGENCE-SPEC.md | Convergence Phase 6 |
| #1506 | Reservation protocol unfollowable under enforce_admins | An id reservation reaches the shared store before any id it covers is consumed, by a route branch protection permits. | PARALLEL-AGENT-COORDINATION-SPEC.md | — |
| #1553 | Rewriting a stale generated rule row needs per-row provenance | A re-scaffold refreshes a stale generated row in a preserved rule file and cannot change a hand-edited row beside it. | RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md | — |
| #1559 | prove-evidence.schema.json has no live reader | Every gate artifact with a declared schema is validated against it, so a required field the writer does not emit turns the suite red. | GATE-CONTRACTS-SPEC.md | — |
| #1571 | #1242's disarm step has never succeeded (0 of 65) | A waived review whose auto-merge cannot be disarmed reads differently from one that found something, and the operator learns it when arming. | CODE-REVIEW-CONVERGENCE-SPEC.md | Convergence Phase 6 |
| #1816 | Nothing sees an author repairing past round three | A PR repaired a fourth time after the round-three step-back is reported, distinguishable from one whose author re-scoped. | CODE-REVIEW-CONVERGENCE-SPEC.md | Convergence Phase 5 |
| #1818 | A finding naming one member of a population is not checked | A class-tagged finding's thread cannot resolve until the author states the population — N sites, M defective — and the search that found it. | CODE-REVIEW-CONVERGENCE-SPEC.md | Convergence Phase 1 |
| #1887 | ai-review returns clean over files restored from base, unread | Every review prints which changed files it saw only at their base version — count and list, explicit zero included. | CODE-REVIEW-CONVERGENCE-SPEC.md | Convergence Phase 5 |
| #1910 | Nothing pins forge behaviours our tools depend on | Every forge behaviour a tool depends on has a live probe reading CONFIRMED, CHANGED or UNMEASURED, and a dependency with no probe turns the suite red. | GITHUB-API-MIGRATION-SPEC.md | — |
| #1911 | remoteRepoReading compares path but never host | A merge-ref reading against a remote whose host or owner/name differs from the PR's repository is UNMEASURED. | PARALLEL-AGENT-COORDINATION-SPEC.md | — |
| #1921 | What writes In review for an issue with no closing reference? | An issue card in In review with no linked PR is reported as hand-placed, so In review has a second source. | BOARD-FLOW-SPEC.md | — |
| #1934 | Review reports DIFF_TRUNCATED on every state-record PR | A diff over the reviewer's budget is still reviewed, and the reading states coverage as n of m files read. | CODE-REVIEW-CONVERGENCE-SPEC.md | Convergence Phase 5 |
| #1942 | Stale-claim sweep reads updatedAt, which a comment bumps | A claim is released as stale from silence in its work artifacts — commits and PR events — never from `updatedAt`. | BOARD-FLOW-SPEC.md | — |
| #1945 | board-mirror --write has no criterion, evidence or issue | The board's Criteria column agrees with every engine issue's body, written by a workflow holding a project credential, never by hand. | SPEC-TO-BOARD-PIPELINE-SPEC.md | Pipeline Phase 7 |
| #1952 | Merged PR with a valid closing ref left its issue open | A merged PR whose closing reference names a still-open issue is reported naming both. | SPEC-TO-BOARD-PIPELINE-SPEC.md | Pipeline Phase 7 |
| #1953 | Nothing reports declared work that no issue covers | Every declaration of work in a tracked file names an open issue or is reported unaccounted. | SPEC-TO-BOARD-PIPELINE-SPEC.md | Pipeline Phase 6 |
| #1964 | Filing cap size and ceiling read from the working tree | The filing cap's size and ceiling resolve from committed config, so a working-tree edit cannot raise an agent's own cap. | SPEC-TO-BOARD-PIPELINE-SPEC.md | Pipeline Phase 6 |
| #1976 | Group Ready by file overlap in work-status | The what's-next report groups Ready and candidates by declared file overlap, and issues naming no files are never grouped. | BOARD-FLOW-SPEC.md | — |
| #1987 | GateEnforcement counts .archive runs; ship.js over the script cap | Split first: (1) an archived run never counts toward a strike; (2) every workflow entry script stays under 524,288 bytes. | HARNESS-GATES.md | — |

## Stale — close with the evidence

| Issue | Title | Evidence |
|---|---|---|
| #1554 | Ten reservation blocks and nothing prunes them | PR #1970 (merged 2026-11-10) removed every block; `specs/sc-reservations.json` is `[]` on main. |
| #1565 | census-routing omits ai-review-surface-census for workflows | PR #1930 (closing #1927, merged 2026-11-09) derives the suite population, including that file. |
| #1948 | project-state.json lacks assignment-evidence finding | PR #1937 (merged 2026-11-09) lists #1948 as closed and shipped it; it stayed open — the defect #1952 names. |

## Decomposition — the gaps this repair's dry runs found

Filed by `adr-accepted.yml` when this ADR merges (Jason, 2026-11-12: "we
should file all 7"). Four of the seven serve a criterion and are rows here;
the three that serve none (the milestone-placing repair, the converter that
rewrote SC-2747, D4's parser binding) are filed as ordinary issues. Each
issue's full evidence is added to its body after filing.

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| SC-2737 | closing-references reads the criterion question through criterionAnswer | lib/closing-reference-audit.ts, scripts/audit-closing-references.ts, lib/board-mirror.ts, test/audit-closing-references.test.ts | Pipeline Phase 6 — the board's state is a reading | — |
| SC-2741 | A hand-milestoned engine issue gets its queue label and Criteria cell | .github/workflows/phase-order.yml, scripts/board-mirror.ts, test/phase-order-workflow.test.ts | Pipeline Phase 6 — the board's state is a reading | — |
| SC-2741 | work-this-next refuses an issue labelled needs-criterion and work-status shows the count | lib/board-ready-rule.ts, test/board-ready-rule.test.ts, scripts/work-status.ts, test/work-status.test.ts | Pipeline Phase 6 — the board's state is a reading | board-mirror takes the active milestone from repository issues like board-ready |
| SC-2741 | board-mirror takes the active milestone from repository issues like board-ready | lib/active-milestone.ts, scripts/board-mirror.ts, scripts/board-ready.ts, scripts/work-status.ts, test/board-ready-rule.test.ts | Pipeline Phase 6 — the board's state is a reading | A hand-milestoned engine issue gets its queue label and Criteria cell |
