---
doc-type: adr
status: proposed
created: 2026-11-13
updated: 2026-11-13
---

# ADR-016 — the filing cap meters net backlog growth, not every filing

## Status

**Proposed, 2026-11-13.** Jason asked for this ("do we need to rethink what
the cap is actually in place for?") and chose to fix it properly. Open
until he picks an option and the ceiling below with `/dry-run`. The
criterion ids in the table are placeholders until then.

## Context

The per-run issue cap (`lib/issue-filing-gate.ts`) exists for one reason:
rule 7's warning that when issues are opened faster than they are closed,
the backlog diverges however fast the work goes. A swarm once ran at 3 to
1, and #1595's swarm filed 57 issues in a day (`FG-194`).

What it measures instead is **every `gh issue create`**, counted per
launch checkout over 24 hours:

| Constant | Value | Applies to |
|---|---|---|
| `FILINGS_PER_RUN` | 1 | harness mode |
| `FILINGS_PER_RUN_DIRECT` | 12 | direct mode (today) |
| `QUEUE_FILINGS_PER_RUN` | 24 | a filing labelled `engine` with no `-R` |
| `FILING_CAP_OVERRIDE_MAX` | 12 | the ceiling on `board.filingsPerRun` (#2070) |

Measured on 2026-11-13, from `~/.rungate/finding-ledger.jsonl` and the
tracker:

- **13 filings were counted against this session in 24 hours, and all 13
  were agreed work:** splits Jason asked for, follow-ups to review
  findings, and plan items. Only 3 were credited to the engine route. The
  other engine filings lost it to an explicit `-R` or a stale launch
  checkout.
- **Repo-wide, 30 issues were opened and 28 closed** in the same window.
  That's a ratio of 1.07: the backlog was not diverging.
- **The cap still refused agreed work.** Jason had to file the README
  (#2081) and a split he had agreed to (#2082) by hand.

Three things are wrong with the current shape:

1. **It counts agreed work as if it were a finding.** Rule 9 says agree on
   work and file it the same turn, and the cap can refuse that filing.
2. **Its bypasses are stand-ins for "this was agreed".** The engine label
   names an area, not an approval, and an explicit repo flag quietly
   cancels it. A merged plan is the only other route, and it needs an ADR.
3. **Engine filings share the window**, so building the engine uses up the
   allowance for everything else. That contradicts Jason's 2026-11-13 call
   that the engine should not be capped. `board.filingsPerRun` cannot help,
   because its ceiling is 12.

## Decision

The cap measures what it exists to stop. **While the repository closes
issues at least as fast as it opens them, a run may file up to a hard
ceiling. When opening outruns closing, it falls back to today's cap.** The
duplicate, no-claim and comment-instead refusals are unchanged, so a
review finding still defaults to a PR comment (rule 7). Only the count
changes.

### Options (Jason picks one)

- **A. Net-growth ceiling (recommended).** Over the trailing 24 hours,
  take repo-wide *opened − closed*, counting closes the way
  `closedIssueCounts` already does. At zero or below, every run's cap is
  the ceiling **H**. Above zero, it is today's cap. If the count cannot be
  read, it is today's cap, so the fallback is always the lower number.
  This fixes all three problems: agreed work, the stand-in bypasses, and
  the shared window.
- **B. Separate pools.** Engine-labelled filings stop consuming the
  12-filing allowance and get their own 24. The smallest change, but the
  README case is still refused, and the cap still measures filings rather
  than growth.
- **C. Agreed-work label.** A label meaning "agreed with Jason" exempts a
  filing. Rejected in advance: any agent can apply a label, which is why
  the existing waiver label is deliberately never named in a refusal.

**The ceiling H.** Proposed **36**: three times the direct allowance, and
still well under the 57 a day that `FG-194` was written against. One
runaway session that pushes opened above closed drops every run back to
12 within the window.

## Decisions

1. **What the cap measures: net growth, not filings. Jason, 2026-11-13.**
   He chose "both" when asked. The interim raise turned out not to exist
   (`board.filingsPerRun` is capped at 12), so this ADR carries the whole
   change.
2. **Option and ceiling: pending Jason (A, B or C; H = 36 proposed).**

## Not decided here

- **Turning the cap off in direct-ship mode.** Not proposed. The ceiling
  keeps a bound for the case `FG-194` was written for.
- **Reading the cap from committed config only** is #1964's job (SC-2753).
  This ADR changes the number, not where it is read from.
- **Harness mode keeps its cap of 1** below the ceiling. Whether harness
  projects get the net-growth ceiling too is left for when `ship.mode`
  returns to harness.

## Decomposition

Placeholder ids `SC-NG1` and `SC-NG2` become real `SC-<N>` lines in
`specs/SPEC-TO-BOARD-PIPELINE-SPEC.md`, with Phase 6 placement rows, once
Jason has approved the option and the wording.

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| SC-NG1 | The filing cap rises to its ceiling while the repository closes issues as fast as it opens them | lib/issue-filing-gate.ts, test/issue-filing-gate.test.ts, specs/sc-reservations.json | Pipeline Phase 6 — the board's state is a reading | — |
| SC-NG2 | work-status shows the trailing day's opened and closed counts and the filing cap they set | scripts/work-status.ts, test/work-status.test.ts | Pipeline Phase 6 — the board's state is a reading | The filing cap rises to its ceiling while the repository closes issues as fast as it opens them |
