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

| Lane | The question only it answers | May enter when | Leaves when | Who writes it | What it costs when wrong |
|---|---|---|---|---|---|
| **Backlog** | What might we do? | anything filed | it is committed to, or cancelled | GitHub native (on) | nothing directly — it is the option pool, and options are discardable |
| **Ready** | What should be picked up **next**, and in what order? | zero open blockers **and** a free slot in the queue | a worker pulls it | automation proposes, the queue limit decides | **the lane we actually have.** 6 named, 34 eligible: a picker reads six items, cannot see the other 28, and either duplicates work or picks by scrolling Backlog — which is how #1415 duplicated #1409 |
| **In progress** | What is being worked on **right now**, and by whom? | a worker performs a starting act | the change is submitted for review | the worker's own first act | 1 shown against 9 claimed. Eight sessions are invisible to each other, which is the condition that produces duplicated work and the hallucinated status readings this spec exists to end |
| **In review** | What is finished but not yet landed? | a PR exists for it | the PR merges or closes | GitHub native (on) | work completes into an unbounded queue; review becomes the constraint and nothing reports it |
| **Done** | What did we actually deliver? | closed as `completed` | never | GitHub native (on) | if it ever admits `not_planned`, throughput is overstated and cycle-time percentiles are contaminated |
| **Cancelled** | What did we decide **not** to do, and how often? | closed as `not_planned` or `duplicate` | never | does not exist today | 23 issues have left the system through an exit nothing counts. Little's Law's second assumption is violated, so no forecast from this board is defensible |

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
| 3 | B is started | B is **In progress** | nothing exists yet |
| 4 | open a PR saying `Fixes #B` | B is **In review** | GitHub native |
| 5 | merge the PR | B is **Done** | GitHub native |
| 6 | close issue C as `not_planned` | C is **not** in Done | nothing exists yet |

Rows 3 and 6 will be **red on arrival**, and that is the point: a failing row
naming the lane that did not move is worth more than the absence of a test,
and it is how we learn a lane started working rather than being told it has.

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

**Deviations record — written after the measurement, and empty until then.**

## Increment 2 — not scoped until Increment 1 measures

Ready's queue limit, the In progress writer and its starting act, and the
Cancelled exit. All three depend on readings Increment 1 has not taken, and
two of them are the designs the research just overturned. Not to be started
before Increment 1's decision criteria fire.

## The decisions that are genuinely ours

Practice is split or silent on these four. They are recorded as open rather
than resolved, so that nobody later reads a choice as a finding.

1. **Is Ready a commitment or an eligibility filter?** The two canonical
   Kanban sources answer differently. The variable nobody decides for us is
   whether Ready is size-limited. No industry number exists for the limit.
2. **Which act moves a card to In progress?** Industry is consistent that it
   is *not* assignment. Ours to choose: worktree creation, first commit,
   draft PR, or an explicit claim. No source addresses this for agents.
3. **Where does Cancelled live** — a sixth lane, or `state_reason` alone?
   A lane is visible but the Done-on-close automation must then branch on
   the reason; the field alone is clean but every reader must remember to
   filter.
4. **Does a limit bind, or only report?** If hitting it does not stop new
   work starting, it is decoration. If it binds, we have chosen to leave
   agents idle to protect review attention.

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
automation docs. Full report with per-source caveats, including which claims
are vendor marketing and which figure was checked and discarded as
worthless, is in the session transcript.

## Success Criteria

- [ ] SC-2640: the walk-through drives a real issue through every lane
      needs: run
      proved-by:
- [ ] SC-2641: a lane that does not move inside the bounded wait fails
      needs: test
      proved-by:
- [ ] SC-2642: an issue with an open blocker does not reach Ready
      needs: test
      proved-by:
- [ ] SC-2643: the walk-through deletes its own issues whether it passed
      needs: test
      proved-by:
- [ ] SC-2644: every lane in the purpose table names its cost of being wrong
      needs: test
      proved-by:
