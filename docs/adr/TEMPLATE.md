---
doc-type: adr
status: proposed
created: {date}
updated: {date}
---

# ADR-{number} — {title}

<!--
The ADR template (ADR-013 row 6, SC-2739). Copy this file to
docs/adr/ADR-<next number>-<slug>.md and replace every {placeholder}.

Write an ADR when the work is bigger than one issue, or when it changes a
rule or a gate (AGENTS.md rule 9, step 2). Small decisions skip straight to
an issue.

Leave `status: proposed` until Jason accepts it. Merging the ADR with
`status: accepted` is what places its plan on the board.
-->

## Status

**Proposed, {date}.** {Who is deciding, and what is still open.}

## Context

{What is true today, measured, with the command or run that measured it. A
claim with no measurement behind it belongs under "Not decided here".}

## Decision

{What will be true once every row below ships, in a few lines.}

## Decisions

1. **{The decision} — {who decided}.** {Why, in one or two sentences.}

## Not decided here

- {What this ADR deliberately leaves open, and where it will be decided.}

## Decomposition

{Write each criterion id as a `- [ ] SC-<N>: …` line in the governing spec,
and reserve the ids first (`.claude/rules/parallel-sessions.md`).}

One row per issue. `plan-issues --decompose` reads this table and refuses
the whole plan if any row breaks a rule, so check each one:

- **Criterion**: one `SC-<N>` id, already written in the governing spec.
  Several rows may serve the same criterion.
- **Outcome**: becomes the issue title word for word. At least 12 characters,
  and no comma, because a Blocked by cell is a comma-separated list.
- **Files**: the paths the issue will change, comma-separated. At least one,
  and at most 9 files (AGENTS.md rules 2 and 3).
- **Milestone**: the exact title of a milestone that exists, or `—` for
  none.
- **Blocked by**: `#<issue>`, or another row's Outcome word for word, or `—`.
  A cycle is refused.

Keep the table outside code fences and comments. The filing tool reads only
live table rows.

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| {criterion} | {outcome} | {files} | {milestone} | {blocked-by} |
