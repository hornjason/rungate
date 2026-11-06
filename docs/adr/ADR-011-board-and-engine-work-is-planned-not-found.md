---
doc-type: adr
status: accepted
created: 2026-11-06
updated: 2026-11-06
---

# ADR-011 — board and engine work is planned, not found

## Status

Accepted, 2026-11-06. Jason's call, in his own words: *"We should have the
ability to work on the board, the engine, and everything correctly without
hitting a filing cap. I think that file and cap is for when we're swarming
the backlogs and it's for findings."*

## Context — the cap's denominator held three findings and refused two engine fixes

`FILINGS_PER_RUN` is a count, not a judgement, and ADR-007 is right that it
must stay one. What it is not is a count of the right population.

Read from `~/.rungate/finding-ledger.jsonl` on 2026-11-06, the 36 rows this
run wrote in 24 hours. The three that consumed the cap:

| time (UTC) | title | kind |
|---|---|---|
| 11-05 17:24 | Claim 3: decide by measurement how to get first-pass completeness | review finding |
| 11-05 22:33 | Claim 2: census-routing misses bun-version-agreement for a new workflow | review finding |
| 11-06 12:32 | A finding naming one member of a population is not checked for whether | review finding |

All three are swarm review findings, which is the population ADR-007 says
the number was calibrated against — Cloudflare's 1.2 findings per review and
this machine's 0.23 filings per run per day. The cap did exactly its job on
them.

What it then refused, in the same 24 hours and out of the same budget:

| time (UTC) | title | kind | what happened instead |
|---|---|---|---|
| 11-06 16:18 | board-sweep releases a claim with the board PAT, which cannot write issues | engine fix | shipped as PR #1824, **tied to no issue** |
| 11-06 16:44 | work-status read 8 of 82 open issues: the milestone was hardcoded | engine fix | opened as PR #1825, **tied to no issue** |

Two merged-or-open changes to the board machinery with nothing on the board
representing them. Jason found it by looking at **In progress** and not
seeing the work, which is the exact failure the board exists to prevent.

A third reading makes it worse: the cap's denominator is `runIdFor`, the
**session's** launch directory. Every worktree this session opens shares one
budget with the swarm review it was launched to run. Working the engine and
reviewing the backlog are not two runs; they are one.

## The decision — use the route ADR-007 already built, and do not touch the cap

`lib/filing-plan.ts` already answers this and no code changes:

> the title appears, verbatim, in a plan file that is committed on
> `origin/main`

That is the exemption, it is not arguable, and it costs a reviewed and merged
document. **This ADR is that document for board and engine work.** The cap
stays 3, it stays a count, and nothing about it becomes configurable.

The alternative — teaching the gate to tell an engine fix from a finding —
was rejected. The distinguishing fact would have to come from the filer, and
ADR-007 records what that costs: on 2026-10-24 three of three filings cleared
a BAR on individually sound arguments. "This is engine work, not a finding"
is a sentence an agent can write about anything.

## The work, and the titles it will be filed under

Each row's `Outcome` is the **exact** issue title. `plannedFiling` matches on
equality, never substring, so a row whose wording drifts from the filing
grants nothing.

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| — | work-status read 8 of 82 open issues: the milestone was hardcoded | lib/work-status.ts, scripts/work-status.ts, test/work-status.test.ts | — | — |
| — | The board PAT cannot write issues, so 6 of 6 stale-claim releases were refused | scripts/board-status-sweep.ts, .github/workflows/board-sweep.yml, test/board-status-sweep.test.ts | — | — |
| — | clearAssignees reads a REST response through the GraphQL envelope, so every release is UNMEASURED | scripts/board-status-sweep.ts, test/board-status-sweep.test.ts | — | The board PAT cannot write issues, so 6 of 6 stale-claim releases were refused |

The third row is live, found while watching run `42254789078` drain the
board. `clearAssignees` is REST — `PATCH /repos/{repo}/issues/{n}` — and it
passes the response through `interpretResponse`, which ends
`return body.data`. A REST body has no `data` key, so the verified reading is
`undefined`, `Array.isArray(undefined)` is false, and every release throws
*"the unassign response carried no 'assignees' array"*. It was invisible
until #1824 landed, because before that the call never got past HTTP 403.

Two refusals, two different causes, one symptom — which is why the sweep
refusing loudly rather than reporting success is the thing that made the
second one findable at all.

## Consequences

- Filing any of the three titles above is exempt from the cap once this is on
  `origin/main`. Filing anything else from this session is not, and that is
  the point.
- A future engine item that is not in this table is **not** pre-approved. Add
  a row and merge it, or file it against the cap like a finding.
- The rows carry no criterion. These are repairs to the machinery, not
  decompositions of a spec, and writing a criterion id beside work that does
  not serve one would make `criterion-inventory` report a trace that is not
  there.
