---
doc-type: adr
status: accepted
created: 2026-11-06
updated: 2026-11-06
---

# ADR-012 — the three open retro improvements become three issues

## Status

Accepted, 2026-11-06. Jason's call: *"we agreed to not have a cap for work
we're doing to improve RunGate until RunGate is stable."*

## The decision, and why it is a plan rather than a raised cap

The agreement above is already the project's policy, and ADR-007 chose how to
honour it: **"Do not raise the number."** A cap nobody can defend is a cap
someone raises, and the two readings behind `FILINGS_PER_RUN` — Cloudflare's
1.2 findings per 131,246 reviews, and this machine's 0.23 filings per run per
day across 284 worktrees — both measure *a review finding filed mid-change*.
That is not this population.

So the route is the one ADR-007 built: a filing whose title appears verbatim
in an `Outcome` column in a merged `docs/adr/` file is exempt from the
per-run allowance entirely. The merged plan is the human reading the cap
stands in for. This file is that plan.

Nothing in `lib/issue-filing-gate.ts` changes, and
`FILINGS_PER_RUN_DIRECT` stays at 3. `FG-194` asserts it stays at or below
five; this ADR does not test that boundary because it does not approach it.

## What must become true

`project-state.json` carries three retro improvements with `status: "open"`
and no `issue`. They are the only things in the whole ladder that nothing can
measure, and `test/stage-ladder.test.ts` scores stage **items** — an
improvement is not an item, so Stage B read complete while two of its own
improvements were outstanding. That is how *is Stage B done?* got two
different answers in one session, and it is SUCCESS.md claim 4 exactly:
*could not measure* reading as *nothing wrong*.

`OPEN_WITHOUT_ISSUE` in `test/stage-ladder.test.ts` banks them as an
equality, in both directions. Filing one means setting `issue` on it in
`project-state.json` **and** deleting its line from that constant in the same
commit, or the suite goes red — which is what makes this ADR's work
self-closing rather than a note.

## The plan

| Outcome | Stage | Moves |
|---|---|---|
| Nothing can see an author repairing past the third review round instead of re-scoping | A | Claim 4 |
| A measurement typed into a PR body is a second copy nothing compares to its source | B | Claim 4 |
| A finding naming one member of a population is not checked for whether it IS one | B | Claim 4 |

Each row is the title of one issue to be filed on `hornjason/rungate`,
verbatim. The titles are symptoms, not fixes, per the repository's issue
shape; the improvement text they come from is in `project-state.json` under
each stage's `retro.improvements`, and is **not** restated here —
`AGENTS.md` rule 10 says a done-condition lives in one place.

### Why the third one is filed at all, given its own mechanism says nothing can enforce it

Stage B's record is that this is a judgement each time: eleven unawaited
`.rejects` **were** a population and all eleven were fixed; eighty-seven
stacked docblock pairs were **not** one, because a section docblock above a
symbol docblock is this tree's ordinary spelling. An issue that resolves to
*this stays a judgement* is a real outcome and closes the improvement
honestly. An improvement left open because its answer might be "no mechanism"
is an improvement nothing will ever measure, which is the state this ADR
exists to leave.

## What this does not do

It does not write `project-state.json`. That file is DA-owned (#296) and an
agent in a worktree must never write it, so attaching the three issue numbers
to the three improvements — and emptying `OPEN_WITHOUT_ISSUE` in the same
commit — is the DA's edit, from the primary checkout, after these are filed.

## Related

- #1745 — the issue this plan serves
- ADR-007 — the route, and the argument against raising the number
