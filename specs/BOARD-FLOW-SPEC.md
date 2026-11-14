---
doc-type: spec
status: draft
owner: jason
created: 2026-11-05
updated: 2026-11-05
governs: Board flow — what each lane is FOR, what may enter it, who writes the transition, and what it costs when a lane is wrong
testable: true
compliance: strict
evidence: required
board-scope: deferred
---

# Board Flow

## Why this exists

Jason, 2026-11-05: *"This is the biggest problem I have — not knowing what the
true status at any given time is. We get hallucinated status readings at all
times."*

The board is the answer to that, and today it cannot be. Measured on
2026-11-05 across all 135 items (`gh api graphql` paged, two pages):

| Lane | Holds | Should hold |
|---|---|---|
| Backlog | 80 | — |
| Ready | **6** | 34 are unblocked and unclaimed |
| In progress | **1** | 9 open issues have an assignee |
| In review | 1 | — |
| Done | 47 | — |

Two lanes are wrong by roughly 6× and 9×. And the lane everyone looks at
first has **never moved an issue in its life** — four separate repairs
(#1744, #1761, PR #1765, PR #1766) were each reported as the fix by somebody
who had not executed it, because four guards in a chain each exited zero on a
state they could not measure.

**This spec exists because we were designing the board as we went.** Jason,
2026-11-05: *"we should have been designing the requirements up front."* It
is written against industry practice rather than against our own intuitions,
at his instruction: *"We should research all of this and not take my word for
it."*

### Three findings that contradict the plan we were about to build

The research (2026-11-05, sources in § References) overturned two of three
pending changes. They are recorded here rather than quietly dropped.

1. **Ready is a commitment, not a computed view.** We were about to write
   Ready automatically for every issue with no open blockers. In Anderson's
   Kanban Method, Ready is the *replenishment commitment point* — the
   boundary where an item stops being a discardable option. An unlimited
   mechanical Ready is a second Backlog: it carries no information, nobody
   can say why one item is above another, and nothing stops it reaching 34.
   The workable form is mechanical **eligibility** feeding a **size-limited**
   Ready queue. The limit is what makes it mean something.

2. **No mainstream tool moves a card to In progress on assignment.** This was
   #1758's whole design. Jira and Linear both automate the transition, but on
   the worker's first *physical act* — branch created, branch name copied,
   draft PR opened. GitHub Projects has no built-in trigger at all, and Azure
   Boards explicitly does not transition on branch creation. Assignment is a
   statement of intent; starting is an act.

3. **`not_planned` work is invisible, and that is worse than mislabelling
   it.** We assumed abandoned issues were being counted as delivered. They
   are not: **0 of 135 board items carry `NOT_PLANNED`**, while 23 closed
   issues do. They are not on the board at all. Little's Law requires that
   everything entering a workflow leaves it through a counted exit;
   silently deleting work from the board violates the assumption directly,
   which makes every forecast built on this board unsound rather than
   merely imprecise. The cancellation rate is currently unobservable.

### The boundary this board does not currently draw

Backlog and Ready sit **upstream** of the commitment point. In progress, In
review and Done sit downstream and are the only lanes that are work in
progress in any guide's sense. Every defect listed above sits exactly on that
boundary. The spec draws it explicitly.

## What each lane is FOR

Jason, 2026-11-05: *"we should make sure that we understand and have
requirements or outcomes — what is it that we want from each swim lane?"*
This table is that answer, and it is the part of the spec the rest is
derived from. **The last column is why each lane is testable at all**: a
lane with no stated cost of being wrong cannot be given a target.

**Every entry and exit below names a GitHub event.** That is a hard
requirement, not a style: a condition no event can decide is a condition a
person has to apply by hand, and a lane maintained by hand is a lane that
drifts the moment nobody is looking. Jason, 2026-11-05: *"no handcrafting…
we should be able to move something all the way through correctly."*

| Lane | The question only it answers | May enter when | Leaves when | Who writes it | What it costs when wrong |
|---|---|---|---|---|---|
| **Backlog** | What might we do? | `issues: [opened]`, or **anything moving backwards** (below) | it is promoted to Ready, or it closes | `board-intake.yml` | nothing directly — it is the option pool, and options are discardable |
| **Ready** | What should be picked up **next**, and in what order? | zero open blockers, nobody assigned, **and** Ready is below the depth derived from live throughput — ordered by phase, then by age | `issues: [assigned]`, or a pull frees a slot | `board-ready.yml` | **the lane we actually have.** 6 named, 34 eligible: the ordering decision does not disappear, it RELOCATES — each puller exhausts Ready, falls back to Backlog and applies its own heuristic, so prioritisation happens 28 more times, inconsistently, inside agents, leaving no record anybody can review |
| **In progress** | What is being worked on **right now**, and by whom? | `issues: [assigned]` — assignment **is** our starting act (below) | a linked PR becomes ready for review | `board-flow.yml` on the event, `board-sweep.yml` for cards whose event predates it (below) | 1 shown against 9 claimed. Eight sessions are invisible to each other. And because this lane carries the start timestamp, cycle time is not approximate — it is **absent**; a blocked item left here also consumes a slot, so if a limit ever binds a phantom throttles real throughput |
| **In review** | What is finished but not yet landed? | a linked PR is **not a draft** — `pull_request: [opened, ready_for_review]` with `draft == false` | the PR merges or closes | board-flow workflow | this lane is WIP, so an unbounded In review means **unbounded WIP however tight In progress is** — "finishing" into an unlimited queue defeats the limit. For agent work this is where the real constraint sits: coding got ten times faster, review did not |
| **Done** | What did we actually deliver? | `issues: [closed]` with `state_reason: completed` | `issues: [reopened]` sends it to Backlog | board-flow workflow | if it ever admits `not_planned`, throughput is overstated and cycle-time percentiles are contaminated |
| **Cancelled** | What did we decide **not** to do, and how often? | `issues: [closed]` with `state_reason` of `not_planned` or `duplicate` | `issues: [reopened]` sends it to Backlog | board-flow workflow | 23 issues have left the system through an exit nothing counts. Little's Law's second assumption is violated, so no forecast from this board is defensible |

### An event-driven writer cannot reach a card whose event already fired

Every entry above names a GitHub event, which is the requirement that makes
this board testable. It also carries a consequence worth stating once: a
writer that fires on an event can only ever correct the cards whose event
happens *after* it ships. Nothing replays a past event, and GitHub offers no
trigger that does.

Measured 2026-11-06, with `board-flow.yml` live and demonstrably working —
the end-to-end walk-through's In progress row passes on a real event:

| Lane | Held | Should hold |
|---|---|---|
| In progress | 1 | 9 open and assigned |
| Ready | 5 | at most 4, its throughput-derived cap |

Eight of those nine were assigned before any workflow wrote this lane, so
the writer was correct and the board was wrong at the same time. Two of the
strays sat in **Ready**, whose entry condition is "nobody assigned", holding
it over its cap — so `board-ready.yml` correctly promoted nothing into a
full lane, and the walk-through recorded that correct refusal as a failing
lane. **One backlog of stale cards produced three separate symptoms, none of
which was a defect in any writer.**

`board-sweep.yml` closes it, and the shape of the fix is the part to keep:

- **It rides the events the board already emits** — any issue assigned,
  unassigned, closed or reopened re-reads the whole board and corrects every
  row it can decide. **No schedule, and no hand-run backfill.** Both are the
  thing this spec exists to remove; "a board state reachable only by someone
  running a command by hand" is Claim 7's own falsification, and a one-off
  catch-up is that verbatim.
- **It decides nothing of its own.** `verdictFor` in
  `scripts/board-status-sweep.ts` routes through `laneFor`, the same
  function the live writer applies, so "what does an assignment mean" has
  one owner and the catch-up cannot drift away from the writer.
- **It corrects only what is derivable, and the set is closed.** An
  assignment contradicts **Backlog** and **Ready** and no other lane. In
  review means a pull request is out and the issue is still legitimately
  assigned; Done and Cancelled are terminal, and a bulk writer able to pull
  from those would drag finished work backwards.
- **An unread field is not an empty one.** A query that fails to carry
  `assignees` makes every row UNDECIDABLE and says so, rather than reading
  as a board where nobody is assigned to anything.

### Assignment means it is being worked, and the Backlog is for unassigned work

Jason's call, 2026-11-06: *"if they're assigned, that means someone's
working on them, right? Because they're assigned to somebody… But the
backlog is for unassigned work."*

This is what makes the row above decidable at all. An open issue used to be
undecidable on purpose — Backlog, Ready and In progress are all consistent
with "open", and guessing a column replaces a visibly wrong board with a
plausibly wrong one. Adding an assignee removes the ambiguity: the lane
table already gives In progress the entry condition `issues: [assigned]` and
Ready the entry condition "nobody assigned", so exactly one lane is
consistent with an assigned open issue.

It does **not** extend to an open issue marked **Done**. That is a different
corruption — something wrote a terminal lane for work that has not ended —
and In progress is a plausible-looking cover for it. It stays UNDECIDABLE.

### Anything moving backwards returns to Backlog, and the return is counted

One rule, no special cases: a **reopened** issue, and an issue whose **PR
closed without merging**, both go to Backlog.

Jason's reasoning, 2026-11-05, and it is better than the rule it replaced:
*"if something was closed and you're reopening it, doesn't it go all the way
back to the backlog? Someone needs to make sure it's ready to be picked up
before just sticking it in Ready, because we don't know if there's
dependencies or any edges on it."* An item that went backwards has an
unknown blocker graph, and Ready's entry condition is precisely a statement
about that graph. Putting it straight back into Ready asserts something
nobody re-checked.

**This costs nothing to recover from, which is why one rule is enough.**
Ready's writer already tests blockers on every pass, so an item dropped to
Backlog is re-promoted automatically the moment it is genuinely eligible.
Backlog is not a penalty box here; it is "re-run the eligibility check".

The return is recorded rather than silent, because a board where work
bounces twice and a board where it goes through cleanly must not read the
same.

### Five of these six are mechanisms. One is a display.

This decides where tests go, so it is stated rather than left to taste.

**Backlog is a display.** Nothing downstream depends on its size; an oversized
one costs readability and nothing else. It needs almost no automation and no
test. Its only real failure is keeping items that should have been cancelled,
which is a Cancelled-lane problem wearing a Backlog costume.

**The other five are load-bearing.** Ready gates what gets pulled and in what
order. In progress consumes capacity against a limit *and* starts the
measurement clock. In review is WIP and is where the constraint actually sits.
Done defines throughput and stops the clock. Cancelled protects all of them
and carries its own signal. Each of those five earns a test.

### Ready is two things, and they fail differently

Worth separating, because we pass one and fail the other, and a single
number cannot tell them apart.

| Ready as… | Its test | Our reading |
|---|---|---|
| a **buffer** against the next worker idling | Ready is never empty while eligible work exists | **probably fine.** 6 is a plausible buffer depth; starvation is not our problem |
| the **commitment point** — these items, in this order | every item in Ready has a rank and a reason, and eligible-but-unranked is a reportable count | **total failure.** 28 items are ranked nowhere a puller can see |

The second failure also means the number reports *when somebody last curated*,
not what is available. That is the precise mechanism behind "the board lies":
Ready = 6 is a true fact about our replenishment habit and a false fact about
our work.

**One rule binds the whole table.** A transition caused by a *downstream*
slot opening is a pull; a transition caused by an *upstream* event finishing
is a push wearing automation. Automating Done and In review is bookkeeping —
they record a fact that already happened. Automating Backlog→Ready and
Ready→In progress allocates capacity, and those two are the ones that must
answer to a limit.

## Outcomes

| Outcome | Baseline today | Command that produced the baseline | Target |
|---|---|---|---|
| A lane transition is observed happening with nobody running a command | **UNMEASURED** — nothing in the tree can observe one; 8 board test files assert functions against fixtures and 0 drive a real event | `ls test/board-*.test.ts` and read them | one walk-through, every row observed |
| Ready names what is actually pickable | 6 named / 34 eligible | `bun scripts/work-status.ts` | the gap is closed, or Ready is limited on purpose and the limit is stated |
| In progress names who is actually working | 1 shown / 9 assigned | `gh api graphql` lane census; `gh search` for `is:open assignee:*` | every started item appears, and only started items |
| Abandoned work is countable | 0 of 23 `not_planned` issues are on the board | `gh api graphql` lane census, `stateReason` over all 135 items | every closed issue has a counted exit |

The first row has no baseline and says so. **That makes Increment 1
*instrument it*, not *improve it*** — which is also the only honest response
to four consecutive repairs reported as fixes by people who had not run them.

## Increment 1 — the walk-through, before any further lane work

**Moves:** row one.

A test that drives ONE throwaway issue through every lane using **real
events**, because the native project workflows cannot be faked — they fire on
genuine activity or not at all.

| # | Action taken | Lane asserted after | Who should move it |
|---|---|---|---|
| 1 | create issue A, and issue B `blocked by` A | B is **Backlog** | GitHub native |
| 2 | close A | B is **Ready** | `board-ready.yml` |
| 3 | B is started | B is **In progress** | `board-flow.yml` |
| 4 | open a PR saying `Fixes #B` | B is **In review** | `board-flow.yml` |
| 5 | merge the PR | B is **Done** | `board-flow.yml` |
| 6 | close issue C as `not_planned` | C is **not** in Done | `board-flow.yml` |

Rows 3 and 6 were **red on arrival**, and that was the point: a failing row
naming the lane that did not move is worth more than the absence of a test,
and it is how we learn a lane started working rather than being told it has.
**That is exactly what happened.** Run `42124533332` reported both as
`UNEXPECTED_PASS` — "expected RED and PASSED" — and the instrument demanded
this table be corrected before the improvement was forgotten.

Rows 4 and 5 said `GitHub native` and that was wrong by the time it was
measured. The built-ins that covered them, "Pull request linked to issue"
and "Item closed", are both **switched off** so that one decider writes each
transition; run `42125045931` shows the merged pull request's own event
declining with "no lane transition here", and the issue's close is what
writes Done. Only rows 1 and 7 are still GitHub's — the "Item added to
project" built-in, which puts a new card in Backlog.

**Appetite:** one pull request. If the walk-through cannot be made to run
inside it, this increment is **cancelled and re-scoped, not extended** — most
likely by dropping to rows 1, 2, 4 and 5 and leaving the two unwritten lanes
unmeasured and declared so.

**Exit criteria — how we know it is done:**

- [ ] The walk-through has been executed end to end and every row's reading
      recorded, including the red ones, with the command that produced them.
- [ ] A lane that does not move inside its bounded wait is a **failure**, and
      that has been observed rather than argued.
- [ ] An issue with an **open** blocker does not reach Ready, so the
      walk-through cannot pass against a board that moves everything.
- [ ] It deletes its own issues, branch and PR whether it passed or failed.

**Pre-specified decision criteria — written BEFORE the measurement:**

| Reading | Selects | Next increment |
|---|---|---|
| rows 1, 2, 4, 5 green | H1 — the wired lanes work and the gaps are only the unwritten ones | write In progress and Cancelled |
| row 2 red | H2 — Ready is still broken after four repairs | stop adding lanes; fix the one that has never run |
| any of rows 1, 4, 5 red | H3 — a lane we believe GitHub handles natively does not | re-measure the seven native workflows before trusting any of them |
| the walk-through cannot be made to run at all | neither — **futility** | cancel; the board is not mechanically observable and every reading of it stays a person's claim |

**Deviations record — written after the measurement.**

Measured 2026-11-05, run `42124533332`, dispatched with `wait-seconds=120`
and `merge-wait-seconds=900`. The command and the full row readings:

```
gh workflow run board-walkthrough.yml -f wait-seconds=120 -f merge-wait-seconds=900

row 1  PASS            expected Backlog, observed Backlog — GitHub native
row 7  PASS            expected Backlog, observed Backlog — GitHub native
row 2  FAIL            expected Ready, observed Backlog — board-ready.yml
                       [bounded wait expired — a failure, not a retry]
row 3  UNEXPECTED_PASS expected In progress, observed In progress
row 4  PASS            expected In review, observed In review
row 5  PASS            expected Done, observed Done
row 6  UNEXPECTED_PASS expected Cancelled, observed Cancelled
```

**Six of seven lanes observed correct, against three before this increment.**

**The selected hypothesis is H2, and the criteria were written before the
measurement, so it binds: stop adding lanes and fix the one that has never
run.** Rows 1, 4 and 5 are green, which rules out H3; row 2 is red, which
selects H2 over H1.

**What row 2 actually was, and why its own label is wrong.** The row reports
"a lane with a writer did not move". The writer ran. Run `42124584288` reached
its decision and declined, in its own words:

```
#1786 closed. Frontier is phase 0.
  #1787 unchanged: no phase milestone — it serves no criterion (ADR-003)
```

`isReady` in `lib/board-mirror.ts` requires `item.phase === frontier`, and a
milestone-less issue has `phase === null`. The walk-through creates its
throwaway issues with no milestone, so **it cannot exercise Ready at all** —
the one lane the whole increment was aimed at. A red row naming the wrong
cause is worse than no row, because it sends the next reader to the writer.

**And the same root makes the standing Ready reading permanently false.**
`lib/board-lane-health.ts` targets Ready against `pickable` — unblocked and
unclaimed, repo-wide — with no phase condition, while the writer additionally
requires the frontier phase. Measured the same day over all 35 pickable
issues:

| Milestone | Count | `phaseOf` | Ready-eligible |
|---|---|---|---|
| (none) | 22 | `null` | no |
| Convergence Machinery | 6 | `null` | no |
| Issue intake | 4 | `null` | no |
| Convergence Phase 0 | 2 | `0` | **yes** |
| Pipeline Phase 0 | 1 | `0` | **yes** |

So at most **3** of the 35 can ever reach Ready under the writer's own rule,
and Ready currently holds **5**. The report says `SHORT by 30` and will say
so forever. That is not a gap in the board; it is two rules disagreeing, with
the instrument blaming the board — which is the failure mode this whole spec
exists to remove.

**Settled by Jason on 2026-11-05** — `#1758` comment `6672873406`.

| | Eligibility | Ordering | Size |
|---|---|---|---|
| before | unblocked + unclaimed + **current phase** | — | unbounded |
| now | unblocked + unclaimed | by phase, then age | **capped, derived** |

Both halves are live as of 2026-11-05: the cap through #1792/#1793/#1794/#1795,
the eligibility change with the phase gate removed from `isReady`.

**Phase moves from eligibility to ordering.** It was doing crowd-control
work inside an eligibility test, and the cap is the thing that was actually
missing. The unbounded version was tried: `lib/board-mirror.ts` records that
it made 36 of 46 open issues Ready — "the backlog with a different name".
A cap answers that; a phase filter answers it by excluding 32 of 35
candidates.

**The depth is derived, not typed in.** Little's Law on live throughput,
recomputed on every reading, so it rises when a swarm runs and falls when
one stops. A literal goes stale in both directions and a number nobody can
re-derive is a number nobody changes. `READY_TOLERANCE_DAYS` in
`lib/board-ready-rule.ts` is the only constant, and it is a *tolerance*, not
a depth.

**The depth is 4 today, not the 8 quoted when the decision was taken.** The
`237 over 14 days ≈ 17/day` figure put to Jason does not reproduce. Measured
2026-11-05 by paging every closed issue and reading `closedAt`:

| window | delivered | not_planned | per day | depth |
|---|---|---|---|---|
| 7 days | 9 | 0 | 1.3 | 1 |
| **14 days** | **132** | 4 | **9.4** | **4** |
| 30 days | 646 | 23 | 21.5 | 10 |

So the mechanism Jason chose — *derived from live throughput* — is what
shipped, and it currently yields 4. **The window is the live decision here,
not the depth**: the 7-day and 30-day readings differ by a factor of ten,
because 30 days contains a swarm and the last 7 do not. 14 days is the
compromise and it is stated in `scripts/work-status.ts` with its reasoning,
not buried in a constant.

Only delivered closures count. A cancellation leaves the system without
adding capacity, so including it would deepen the queue exactly when the
repository is abandoning work.

**A binding cap does not idle agents.** A pull frees a slot and the next
event refills it; replenishment is the policy, the number is not.

### What landed, and what has not

`lib/board-ready-rule.ts` is the one definition of the SIZE, read by
`lib/board-lane-health.ts` and fed by `scripts/work-status.ts`. The mutation
battery is in `test/board-ready-rule.test.ts`: four mutants, readings
`3/3`, `1/0`, `1/1`, `1/4` against predictions `3/3`, `1/0`, `1/1`, `1/4` —
every mutant that changes a NUMBER reddens both files, which is the property
two separate definitions could not have.

**The first live run found a defect no fixture had.** Ready held 5 against
a derived depth of 4 and the row read `OK`: `count > against` was
unreachable for a lane judged against an unbounded repo-wide count, so the
OK branch had quietly absorbed it. A cap makes it reachable immediately,
because the lane was filled under the rule the cap replaces. `OVER` is now
a verdict of its own — SHORT means promote more, OVER means stop promoting
and let the queue drain.

**The writer now fills to the depth the reading judges against.**
`scripts/board-ready.ts` counts Ready's occupancy in the board pass it
already makes for the frontier, derives the cap from
`lib/board-throughput.ts`, and promotes only what fits — in phase order,
then age. An eligible issue held back by a full queue is named in the log,
because *not eligible* and *no room* send a reader to different places.

Occupancy counts every card in Ready, issue or pull request: the lane's
size is what a puller sees, and a PR parked there takes a slot. It refuses
rather than guesses when a card's field values were read only in part — a
Status on page two and no Status at all produce the same `undefined`, and
an undercount promotes past the cap.

### Every pager reads one decider, because three variants of one bug were not enough

`lib/graphql-cursor.ts`. Every GraphQL pager here spelled
`c = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null`, and every
one of them **ends the loop and returns a confident partial reading** for
three malformed pages: a `pageInfo` that is absent, one that exists
without `hasNextPage`, and one whose `endCursor` is `""`. The last is the
nastiest — an empty string passes a `typeof` check and is then falsy, so a
guard that reads correctly admits the value it was written to exclude.

All three were found on one file, one at a time, across #1793 and #1794,
while four sibling pagers held all three. The siblings were found by
ai-review rather than by anything in the repository. A behavioural case per
site catches only the last one to regress, so the property is asserted over
the population: `test/graphql-cursor.test.ts` fails the build when a file
in `lib/` or `scripts/` advances a cursor itself.

Three sites outside this work still do — `lib/live-issues.ts`,
`scripts/board-mirror.ts`, `scripts/board-status-sweep.ts`. They are an
**equality** ratchet rather than an allowlist: a file leaving the list
fails as loudly as one joining it.

### The cap can be overshot by concurrent runs, and is not locked

ai-review, #1793, and it is real. Occupancy is read once per run and there
is no lock, so two `board-ready.yml` runs triggered by two near-simultaneous
closures each see the same free slots and each fill them. Ready holding 2
against a depth of 4 can end at 6.

**Not fixed, and that is a choice with a reason.** The overshoot is bounded
by the number of concurrent runs, it is visible — the health row reads
`OVER` rather than `OK`, which is what that verdict was added for — and it
self-corrects, because the next run promotes nothing until the lane drains.
A lock or a compare-and-set would be a new failure mode (a stuck lease
blocks the lane entirely) traded against a transient overshoot that the
report already names. If `OVER` starts appearing in readings rather than in
this paragraph, that is the evidence to revisit it.

**Both callers now fill to the same depth.** `scripts/board-mirror.ts
--ready --write` is the hand-run one, and it was refilling the lane to
whatever happened to be eligible — undoing the workflow's cap in a single
command. It is a second CALLER, not a second rule, which is the
distinction that matters: both read `lib/board-ready-rule.ts`, so they
cannot size the lane differently.

It is not refused outright because `scripts/plan-issues.ts` names it as
the step-4 advice for a project bootstrapping its board, and
`board-ready.yml`'s dispatch fans out from one closed issue rather than
sweeping. Refusing would cost a consumer the only full-board path there
is.

It takes `--repo owner/name`, and without it the depth is UNMEASURED and
nothing is promoted. A board can span repositories and so carries no
single delivery rate; defaulting to one would be a number with no claim
to being that board's.

**Only ENTRY is capped. A demotion to Backlog never is** — that is the
half a naive implementation gets wrong. Applying the cap to departures
would pin a claimed or newly-blocked card in the lane for as long as the
lane stayed full, so the cap would start preserving exactly the staleness
it exists to prevent.

**The same defect was written three times, and the third was after the
fix shipped.** ai-review found a hardcoded "Ready is at its depth" in
`scripts/board-ready.ts` on #1794 — an unmeasured depth reported as a
full lane. `heldReason` was created, exported and merged. One pull
request later the literal was typed fresh into the sibling script and
ai-review found it again. A case per script catches only the script that
has one, so the string is now a population check: it may appear in its
own binding and nowhere else in `lib/` or `scripts/`.

This is the third class in this area to need that treatment, after the
cursor advance and the two Ready definitions. The pattern is consistent
enough to state plainly: **in this codebase, fixing an instance reliably
leaves siblings, and only a check over the population closes it.**

**Closed, and it was the last piece: the phase gate is off `isReady`.**
Eligibility is `state === "OPEN"` plus unblocked plus unclaimed; phase
orders the lane through `readyOrder` and the cap bounds it. Dropping the
gate no longer reproduces the 36-of-46 reading because the lane is sized
by `readyCap`, not by being narrow — the two were conflated, and that is
what the gate was really doing.

An issue with **no phase milestone is now eligible** and sorts last.
`isReady`'s docblock said "never Ready" and the fanout's BR-4 asserted it;
both are inverted rather than deleted, so reintroducing the gate fails a
test instead of passing silently. `openFrontier` survives with one
consumer — `rootReady` in `scripts/board-snapshot.ts` — and is no longer
read by either writer.

Ready also still has **one** automatic trigger — `issues: [closed]`, fanning
out to whatever the closed issue was blocking. Measured 2026-11-05: 34 of 34
pickable issues had never had a blocker, so none was reachable by it.
Replenishing on a freed slot fixes that by construction.

## Increment 2 — not scoped until Increment 1 measures

Ready's queue limit, the In progress writer and its starting act, and the
Cancelled exit. All three depend on readings Increment 1 has not taken, and
two of them are the designs the research just overturned. Not to be started
before Increment 1's decision criteria fire.

## The decisions that were genuinely ours — all four settled 2026-11-05

Practice was split or silent on these four, so each is recorded with the
reasoning that closed it. **A choice is not a finding**, and the research
behind each is named so nobody later reads one as the other.

**1. Which act moves a card to In progress? — assignment, and ONLY because
of a convention this repository already enforces.**

**The industry finding stands and is not being overturned: the trigger is
not assignment.** No mainstream tool moves a card on assignment; Jira and
Linear both wait for the worker's first physical act, and nothing
published addresses the question for agents at all. A board that promotes
on assignment *in general* is #1758's original design, and it is wrong.

What makes our case different is narrow and checkable.
`.claude/rules/parallel-sessions.md` requires a worker to claim the issue
by assigning themselves and **then** write code — assignment is already
our first physical act, not a statement about who owns something
eventually. So we are not adopting the rejected trigger; we are observing
that our start act happens to be spelled the same way.

**This justification is load-bearing. If that rule is ever relaxed so that
assignment can mean "yours eventually", this decision dies with it** and
In progress needs a different trigger. The 1-shown-against-9-assigned gap
is the board failing to honour a rule the repository has had all along.

**2. Is Ready size-limited, and does the limit bind? — yes, and yes, and
the number is derived rather than chosen.** No published number exists, and
the one source that examined coding agents makes the operative point: *the
number is not the policy, the policy is what happens once it is reached.*
So the limit binds — a Ready cap that does not stop promotion is
decoration.

**A binding Ready cap does not idle anyone**, and an earlier draft of this
spec said it would. That was wrong. A worker pulling an item frees a slot,
replenishment promotes the next eligible item, and the queue refills. The
only thing a cap can starve is a worker with nothing eligible anywhere,
which is a different problem. What the cap actually costs is that
prioritisation has to really happen, in one reviewable place, instead of
being deferred into each puller's private heuristic.

**The number comes from Little's Law against our own throughput**, because
copying a figure nobody published would be a guess wearing a citation.
Depth = completion rate × the longest we are willing to let a ranked item
wait. Measured 2026-11-05: 237 issues completed in 14 days, ~17/day, so a
half-day tolerance gives a depth of 8 or 9. It is recomputed from live
throughput, which is what makes it survive a swarm — the cap rises with
the rate instead of throttling it.

**3. Where does Cancelled live? — a sixth lane on the board.** The field
alone is cleaner to write and requires every reader to remember to filter,
which is the failure mode this whole spec exists to remove. The cost is
named rather than discovered later: **GitHub's built-in close handler must
be turned off**, because it sends every closure to Done and cannot branch
on the reason. We trade a native feature for a workflow we own.

The column does not exist yet and is created **mechanically**, not by
hand. `updateProjectV2Field` takes the full option list, and
`ProjectV2SingleSelectFieldOptionInput` accepts an `id` — verified against
the schema 2026-11-05. Passing the five existing options back **with their
ids** plus a sixth preserves every option id and every item's value.
Omitting the ids is what regenerates them and silently blanks the board.

**4. Does a draft pull request put an item in In review? — no.** A draft is
work in flight, so the item stays In progress and moves on
`ready_for_review`. In review has to mean "finished, waiting on a
reviewer", or it cannot measure the constraint it exists to measure.

Not a decision: counting `not_planned` as delivered. That is a defect.

## References

Research conducted 2026-11-05 at Jason's instruction not to take his word
for the semantics. Kanban Guide 2025.5 (`kanbanguides.org`); Anderson's
commitment point and two-phase commitment; Cohn's *Dangers of a Definition
of Ready* against, Galen and the Scrum Patterns DoR for; Mahlberg on
per-column entry/exit policies; Vacanti on Little's Law instability
(`leanability.com`, 2017-08) and Bowler's reference-class rule for excluding
cancelled work; ProKanban on cancellation rate (2026-06-10); Yeret on WIP
limits with coding agents (2026-07-22) — *the number is not the policy, the
policy is what happens once it is reached*; GitHub Projects built-in
automation docs. Full report with per-source caveats, including which figure
was checked and discarded as worthless, is in the session transcript.

**Two sourcing caveats, recorded rather than smoothed over.** The
buffer-versus-commitment material leans on vendor blogs (Businessmap, Nave,
Teamhood, Kanban Zone) more than is comfortable — all of them sell Kanban
tooling. The concepts are consistent across them and with Anderson's
published board components, but neither Anderson's book nor Vacanti's
*Actionable Agile Metrics* was read directly for this; the Little's Law
material is from Vacanti via a primary interview. And three questions came
back genuinely unanswered by the literature: assignment semantics when the
assignee is a **bot**, a formal data requirement for per-lane timestamps,
and whether automatic promotion to Ready is a named anti-pattern — it is
neither catalogued nor endorsed anywhere. **The practical consequence of the
second: flow efficiency is the one metric this spec must not promise.**

## Success Criteria

- [ ] SC-2640: the walk-through drives a real issue through every lane
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: run
      proved-by:
- [x] SC-2641: a lane that does not move inside the bounded wait fails
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: test
      proved-by: test/board-walkthrough.test.ts — 28 pass, 0 fail, 2026-11-06
      fingerprint: 1a12f4f4
- [x] SC-2642: an issue with an open blocker does not reach Ready
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: test
      proved-by: test/board-walkthrough.test.ts — 28 pass, 0 fail, 2026-11-06
      fingerprint: bbad6cec
- [x] SC-2643: the walk-through deletes its own issues whether it passed
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: test
      proved-by: test/board-walkthrough.test.ts — 28 pass, 0 fail, 2026-11-06
      fingerprint: 15e8e7ef
- [x] SC-2644: every lane in the purpose table names its cost of being wrong
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: test
      proved-by: test/board-flow-spec.test.ts — 6 pass, 0 fail, 2026-11-06
      fingerprint: b649cd76
- [x] SC-2670: the status report reads every lane against what should be in it
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: test
      proved-by: test/board-lane-health.test.ts — 24 pass, 0 fail, 2026-11-06; the mutant reading an incomplete census as complete reddens 1 case, the one predicted
      fingerprint: 308702db
- [x] SC-2690: one decider maps every lane event, and no event maps to two lanes
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: test
      proved-by: test/board-flow.test.ts — 19 pass, 0 fail, 2026-11-06; the mutant collapsing `laneFor` to one lane reddens 7 cases, exactly the predicted membership
      fingerprint: be75eb66
- [x] SC-2691: a close whose reason cannot be read refuses instead of saying Done
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: test
      proved-by: test/board-flow.test.ts — 19 pass, 0 fail, 2026-11-06; the mutant collapsing `laneFor` to one lane reddens 7 cases, exactly the predicted membership
      fingerprint: 235a8c3f
- [x] SC-2692: every backwards move returns to Backlog under one rule
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: test
      proved-by: test/board-flow.test.ts — 19 pass, 0 fail, 2026-11-06
      fingerprint: 74191ffe
- [x] SC-2710: Ready's depth is derived from live throughput, never typed in
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: test
      proved-by: test/board-ready-rule.test.ts — 25 pass, 0 fail, 2026-11-06
      fingerprint: 106d0e35
- [x] SC-2711: a throughput that could not be read leaves Ready unjudged, not healthy
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: test
      proved-by: test/board-ready-rule.test.ts — 25 pass, 0 fail; test/board-lane-health.test.ts — 24 pass, 0 fail, 2026-11-06; the mutant turning an unreadable cap into full eligibility reddens this case
      fingerprint: 7cc82f39
- [x] SC-2712: the writer and the health reading read ONE definition of Ready's size
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: test
      proved-by: test/board-ready-rule.test.ts — 25 pass, 0 fail; test/board-lane-health.test.ts — 24 pass, 0 fail, 2026-11-06
      fingerprint: 5f19acb5
- [x] SC-2713: throughput counts delivery inside a stated window, and nothing else
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: test
      proved-by: test/board-throughput.test.ts — 20 pass, 0 fail, 2026-11-06
      fingerprint: 91844a62
- [x] SC-2714: a throughput pass that did not complete is UNMEASURED, never zero
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: test
      proved-by: test/board-throughput.test.ts — 20 pass, 0 fail, 2026-11-06
      fingerprint: 24d90590
- [x] SC-2715: phase orders Ready and never empties it
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: test
      proved-by: test/board-ready-rule.test.ts — 25 pass, 0 fail, 2026-11-06
      fingerprint: c2bf19d1
- [x] SC-2716: the writer promotes only what fits, and replenishes as slots free
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: test
      proved-by: test/board-ready-rule.test.ts — 25 pass, 0 fail, 2026-11-06
      fingerprint: 54e8110e
- [x] SC-2717: a page whose pageInfo cannot be read is UNMEASURED, not the last page
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: test
      proved-by: test/board-throughput.test.ts — 20 pass, 0 fail, 2026-11-06
      fingerprint: fdc4f67e
- [x] SC-2718: one pass over the closed issues answers both readings
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: test
      proved-by: test/board-throughput.test.ts — 20 pass, 0 fail, 2026-11-06
      fingerprint: 53576aee
- [x] SC-2719: a held issue is told which of the two causes held it
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: test
      proved-by: test/board-ready-rule.test.ts — 25 pass, 0 fail, 2026-11-06
      fingerprint: 4473c458
- [x] SC-2720: a page that cannot say whether more exist is UNREADABLE, never done
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: test
      proved-by: test/graphql-cursor.test.ts — 12 pass, 0 fail, 2026-11-06
      fingerprint: b3a0a9d8
- [x] SC-2721: no pager decides for itself that a page it could not read was the last
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: test
      proved-by: test/graphql-cursor.test.ts — 12 pass, 0 fail, 2026-11-06
      fingerprint: c4d9aeaa
- [x] SC-2722: both callers of the Ready rule fill to the same depth, and only entry is capped
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: test
      proved-by: test/board-mirror.test.ts — 63 pass, 0 fail, 2026-11-06
      fingerprint: 59fac479
- [x] SC-2723: no site spells a held reason for itself
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: test
      proved-by: test/board-ready-rule.test.ts — 25 pass, 0 fail, 2026-11-06; the mutant turning an unreadable cap into full eligibility reddens this case
      fingerprint: 2b37aec4
- [x] SC-2724: Ready's occupancy is counted over the items the writer can actually move
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: test
      proved-by: test/board-mirror.test.ts — 63 pass, 0 fail, 2026-11-06
      fingerprint: 9f50364e
- [x] SC-2730: every lane row measures its count against a denominator drawn from the same population
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: test
      proved-by: test/board-lane-health.test.ts — 24 pass, 0 fail, 2026-11-06
      fingerprint: 494216cc
- [x] SC-2731: a verdict names only what the census observed, never a writer it did not look for
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: test
      proved-by: test/board-lane-health.test.ts — 24 pass, 0 fail; test/work-status.test.ts — 45 pass, 0 fail, 2026-11-06
      fingerprint: 4ec7bb30
- [x] SC-2732: a population census reaches files in subdirectories, not only the top level
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: test
      proved-by: test/source-census.test.ts — 8 pass, 0 fail, 2026-11-06
      fingerprint: 5fcf4645
- [x] SC-2733: every census over lib/ and scripts/ lists its population through one binding
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
      needs: test
      proved-by: test/source-census.test.ts — 8 pass, 0 fail, 2026-11-06
      fingerprint: 0e65db21
- [x] SC-2759: lib/board-lane-health.ts contains [handPlacedInReview] — an issue card in In review with no linked open pull request is reported as hand-placed
      needs: test
      proved-by: test/board-lane-health.test.ts "#1921 / SC-2759: handPlacedInReview" — 38 pass, 0 fail, 2026-11-14, on the PR that closes #1921. An In-review issue no open pull request declares is named by number; the control with a declaring pull request reads none; a cut closing list and a partial board both read UNMEASURED, never none. Ten mutants each redden the cases naming them: board completeness ignored, cut list ignored, every card reported, nothing reported, some printed as none, unsorted, duplicates kept, and the report dropping its closing list, its cut list, or the line. Live: work-status printed "every issue card in In review has an open pull request declaring it closes the issue" with one card there (#2079, PR #2132).
      fingerprint: 81dd05a8
- [x] SC-2760: scripts/board-status-sweep.ts contains [claimSilence] — a claim is released as stale from silence in its work — branch commits and pull-request events — never from the issue's last-updated time
      needs: test
      proved-by: test/board-status-sweep.test.ts "#1942 / SC-2760: a claim's silence is read from its work" — 94 pass, 0 fail, 2026-11-13, on the PR that closes #1942. The regression runs the live node shape end to end: an issue updated today by a comment, claimed 10 days ago with no work, is released. Seven mutants each redden exactly the case naming them: work ignored, the last-updated clock restored, any branch counted, a cut page read, a bad date dropped, every row given a clock, main skipping the read. The query was run against live GitHub for #2061 (claim, branch rg/2061, PR #2113 read) and #1942 (claim, no work).
      fingerprint: 976b8025
- [x] SC-2761: scripts/work-status.ts contains [fileOverlapGroups] — the what's-next report groups Ready and promotion candidates by declared file overlap, and issues naming no files are never grouped together
      needs: test
      proved-by: test/issue-file-overlap.test.ts "#1976 / SC-2761: fileOverlapGroups", 2026-11-14, on the PR that closes #1976. Two issues naming one file share a row, disjoint ones share none, and issues naming no files or no section are never grouped. Keyed by file, so A and C sharing nothing are never joined through B. Four mutants each redden the cases naming them: no groups (3), grouping on an empty set (4), Ready not read (1), a list of one printed (1). Live: the report ran against the board and printed three contested files among 40 candidates and none among the 4 in Ready.
      fingerprint: 67c33164
