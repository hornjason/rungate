---
doc-type: adr
status: accepted
created: 2026-11-06
updated: 2026-11-07
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
| — | The filing gate resolves a filing against the session directory, not the checkout it was filed from | lib/issue-filing-gate.ts, test/issue-filing-gate.test.ts | — | — |
| — | Nothing proves the board can fail: 0 of 28 BOARD-FLOW-SPEC criteria are ticked | test/board-intake.test.ts, test/board-flow.test.ts, specs/BOARD-FLOW-SPEC.md | — | The filing gate resolves a filing against the session directory, not the checkout it was filed from |
| — | A leading quote disarms the newline escape, so a scratch path can forge a record | lib/scaffold/ai-review-step.ts, .github/workflows/ai-review.yml, test/ai-review-workflow.test.ts | — | — |
| — | Measure the anchor-suppression rate on rungate@0.8.14 across 10 multi-round pull requests | reporting only — no production file is expected to change | — | — |

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

## Amended 2026-11-06 — filing is a repository act, not a branch act

Jason, reading a live refusal: *"shouldn’t we open the issue on main? We
shouldn’t be checked out of a branch and opening an issue."*

He is right, and the gate’s own docblock already agrees with him without the
code doing so. `runIdFor` says the unit is **“the checkout it was filed
from”**. Measured 2026-11-06: a `gh issue create` run from
`/Users/jhorn/Projects/rg-wt-1675` on branch `rg/1675-skip-mutant` was
refused with advice naming branch `rg/ai-review-threads` and run
`/Users/jhorn/Projects/rg-wt-threads2` — the session’s launch directory. The
same misresolution made `--body-file .rg-new.md` unreadable (735 bytes, present
in the command’s directory, absent from the session’s), so the dedupe recorded
UNMEASURED on a file that reads fine, and one output said both “refused” and
“allowed through”.

An issue is a REPOSITORY object. GitHub never sees the filer’s branch, so no
part of a filing’s outcome may depend on it. The cap keying on a checkout is
defensible — it bounds a review swarm, which is per-worktree — but three
things follow that the gate does not do:

- resolve the run and every relative path from **where the command ran**
- never advise “comment on your PR instead” to a filing that is not a review
  finding about a diff. A person filing board work is in no diff at all.
- one output states one verdict. A refusal and an allow-through cannot both be
  printed for one attempt.

The second row below follows from the first: until an agent can file
ordinarily, nothing about intake can be exercised the way a new agent or a
consumer would exercise it.

## Amended 2026-11-07 — the last row was FOUND, and says so

The sixth row is not like the other five. They were planned: somebody decided
the work and then wrote it down. That one was **found** — the Claude review
trial on #1866 raised it, and #1866 is a step reorder that surfaced it only
because regenerating `ai-review.yml` shifted every line and put pre-existing
code in the diff.

A document titled *planned, not found* carrying a found finding is worth one
paragraph rather than a quiet row, because the distinction is the whole reason
the route exists. Three facts, and they are what this row is resting on:

- **It is out of every open diff.** #1866 is merged and the code is
  pre-existing, so rule 7's default — *a review finding is a PR comment* —
  has nothing to attach to. The arbiter agreed: it cleared
  `COMMENT_INSTEAD` on `out-of-pr-diff` and refused only on `OVER_CAP`.
- **Jason authorised it explicitly**, 2026-11-07, asked directly and answering
  *"File it, over the cap"*. The row records the authorisation where the gate
  can read it, which a sentence in a transcript is not.
- **It is engine code.** The defect is in the drift step this repository
  generates into every consumer's CI, which is the population the cap's own
  docblock carves out: the cap exists because of what a swarm did, and engine
  work is what makes the backlog shrink.

What this is **not** is a precedent that a finding may be filed by writing it
down here. The row is one title, merged through review like any other, and the
cap applies unchanged to everything that is not in the table. If found findings
start appearing in this document at a rate, that is the signal that the cap is
set wrong — not that the route is working.

## Amended 2026-11-07 (second) — a parked card needs something that can wake it

Jason, asked whether #1168 should move out of the In progress lane while it
waits for review rounds to accumulate: *"How do we know how to pick back up
eleven sixty eight?"*

There was no good answer, and that is the finding. The proposal was to park it
to Backlog and come back when there was data — which is memory, and memory is
the thing this whole board exists to replace. Nothing in this repository wakes
a parked card. A card parked on an intention is indistinguishable, a week
later, from a card nobody ever started; that is the same confusion
`.claude/rules/parallel-sessions.md` records about an unclaimed issue.

So the wait becomes a card, and `blocked by` carries the relationship:

- the seventh row is the measurement #1168's second criterion is waiting on
- #1168 is `blocked by` it
- `work-status` computes startability from the dependencies API, so #1168
  reappears among the promotion candidates when that closes, because the graph
  says so and not because anyone remembered

This is rule 4 — *ordering is data, not prose* — applied to a case the rule was
not written for. Rule 4 is about which work comes first. The same edge also
answers *when does this become work again*, and that is worth stating because
the obvious alternatives are all prose: a note in the issue, a line in a retro,
a date in someone's head.

**The row carries no criterion and changes no production file.** It is a
reading to be taken and recorded on #1168, which is the shape
`.claude/rules/checks-must-be-able-to-fail.md` asks for: a criterion is closed
by a measurement, never by a symbol being present in a package. #1168's second
criterion is *reachable* as of `rungate@0.8.14` and has been *observed* zero
times, and ticking it today would be exactly the defect SC-2622 exists to
refuse.
