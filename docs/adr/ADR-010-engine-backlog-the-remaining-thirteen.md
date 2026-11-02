---
doc-type: adr
status: accepted
created: 2026-11-02
updated: 2026-11-02
---

# ADR-010 — the thirteen engine criteria that still name nothing

## Status

Accepted, 2026-11-02. This is the second half of ladder item B2 in
`project-state.json`: *every engine criterion either names an open issue or is
recorded as already true*. The first half merged as #1714.

## Context

`SPEC-TO-BOARD-PIPELINE-SPEC.md` has grown from the 15 criteria ADR-008
decomposed to 26. Measured from `origin/main` at `1e07b626`:

```
bun bin/rungate.ts board-conformance --produce \
  --spec specs/SPEC-TO-BOARD-PIPELINE-SPEC.md --prefix Pipeline \
  --repo hornjason/rungate --reading criterion-coverage

SHORT  criterion-coverage  13 of 26 — 13 short
```

The thirteen that are covered are eight recorded as already true by #1714 and
five that already carry an open issue from ADR-008: SC-2602 (#1675), SC-2606
(#1680), SC-2611 (#1681), SC-2612 (#1678), SC-2613 (#1677). The thirteen
below are the remainder.

## The decision, and why it is seven issues and not thirteen

**The first version of this ADR proposed thirteen, one per criterion, and
that is a named anti-pattern.** ADR-003 says so in as many words —
*"One issue per criterion is a named anti-pattern (chunking a requirements
document into tickets) and would push the opened-against-closed ratio past
1"* — and it is the rule AGENTS.md rule 7 is the consequence of. The first
draft justified thirteen by claiming ADR-003's cardinality runs one way only.
It does not. ADR-003's heading is *Cardinality — many to many*, and its second
bullet is the direction the draft denied: *"An issue usually serves several
criteria. #1507 names six, #1509 five."* The AI review of this PR caught it.

What is true, and what the draft confused with it, is a property of **one
tool**: `lib/issue-decomposition.ts` refuses a plan row whose first cell names
more than one criterion — *"one row is one issue serving one criterion"*. That
is a constraint on the `--decompose` table, not on an issue. The many-to-many
direction is reached through `--repair`'s `annotate`, whose `Criteria` cell is
a list, and ADR-005 is the precedent for a repair plan a person wrote.

So this plan is two tables and runs in two steps. Seven issues serve thirteen
criteria, which is 1.9 criteria per issue against the 2.7 ADR-003 measured on
the convergence spec.

### The grouping, and why each group is one change

| Issues | Criteria | Why one change |
|---|---|---|
| 1 | SC-2609, SC-2610 | both are `board-mirror`'s criteria cell — one spells "serves none", the other points its criterion at the symbol that already reads every spec |
| 2 | SC-2615, SC-2616, SC-2617 | the three readings Phase 6 is missing; two are the corpus-wide outcome of mechanisms #1681 and #1680 already build |
| 3 | SC-2618, SC-2619, SC-2620 | one command — give `board-conformance` a terminal condition, refuse hand-assembled inputs, and bind it as a test so drift reddens CI |
| 4 | SC-2621 | different files and no dependency on the command's shape |
| 5 | SC-2622, SC-2623 | both are what a spec must declare and prove about itself |
| 6 | SC-2624 | a different command entirely |
| 7 | SC-2625 | the acceptance test, which is not a criterion like the others |

Groups 4 and 6 are single-criterion on purpose. Merging them into a
neighbour to improve a ratio would be the opposite error: an issue nobody can
finish because it is two unrelated changes.

### SC-2610's behaviour already exists, and its issue must say so

`board-mirror` **does** read every spec. `specCriteriaIn` in
`lib/board-mirror.ts` takes a root rather than a spec and sweeps
`<root>/specs` through `readSpecDir`, which calls `readdirSync(dir, {
recursive: true, withFileTypes: true })`; `main` in
`scripts/board-mirror.ts` documents the id set's default as *"every spec in
the tree"*.

A first draft of this paragraph attributed the sweep's docblock —
*"Every criterion id in `<root>/specs`, from every spec, including nested
ones"* — to `criterionIdsIn`, and the AI review caught it. That function
takes one spec's text and cannot read a directory. The docblock is followed
immediately by a second docblock, so it is attached to nothing in the
syntax, which is how it reads as belonging to the export below it. Worth
noticing in a section whose whole subject is a criterion pointed at prose
instead of code: the same ambiguity, one level down.

What is wrong is the criterion's evidence, not the code. It reads
`lib/board-mirror.ts contains [every spec]`, and `every spec` is a prose
phrase that occurs only inside comments — so the matcher credits a behaviour
it never looked at. This is exactly the row ADR-008 wrote for SC-2606, one
spec later: *name the real symbol, or name the criterion after the symbol.*
Group 1's outcome is worded that way so nobody rebuilds working code.

It cost something already. #1676 was created from ADR-008 for SC-2610 and
**closed on 2026-10-30**, and the criterion was ticked on the strength of the
comment. #1714 unticked it. A closed issue plus a ticked criterion is how a
criterion nothing proves becomes invisible, and the only reason this one came
back is that `project-state.json`'s stage C had written it down by hand.

### SC-2609, by contrast, is genuinely absent

`export const NAMES_NONE = ""` in `lib/board-mirror.ts` — still the empty
string. The criterion asks that *"this issue serves no criterion"* be spelled
out, so the cell is distinguishable from one nobody filled in. It is false and
the work is real.

## Step one — the decomposition

`bun bin/rungate.ts plan-issues --decompose docs/adr/ADR-010-engine-backlog-the-remaining-thirteen.md --repo hornjason/rungate --write`

Each row names the group's **lead** criterion, because that is all a
`--decompose` row may name. The rest arrive in step two.

The lead is the criterion the group's edges hang off, not the lowest-numbered
one — and for group 2 those differ. SC-2616 leads because it is the criterion
that depends on group 1: a reading cannot refuse an issue naming no criterion
until the cell can say *"serves none"* out loud. SC-2615 is numerically first
and depends on nothing in this plan. The other three groups happen to have
their lead first as well, which is coincidence rather than a convention.

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| SC-2609 | Make board-mirror's criteria cell say what it means | lib/board-mirror.ts, scripts/board-mirror.ts, specs/SPEC-TO-BOARD-PIPELINE-SPEC.md, test/board-mirror.test.ts | Pipeline Phase 3 — the board tells the truth | — |
| SC-2616 | Produce the three Phase 6 readings the board is missing | lib/spec-placement.ts, lib/criterion-issue-census.ts, lib/spec-deps.ts, scripts/board-conformance.ts, test/plan-spec.test.ts, test/criterion-issue-census.test.ts, test/plan-deps.test.ts | Pipeline Phase 6 — the board's state is a reading | #1680, #1681, Make board-mirror's criteria cell say what it means |
| SC-2618 | Give board-conformance a terminal condition and real inputs | scripts/board-conformance.ts, scripts/criterion-inventory.ts, test/board-conformance.test.ts, test/criterion-inventory.test.ts | Pipeline Phase 7 — nothing is hand-run | — |
| SC-2621 | Read the board's identifiers from project config | lib/live-issues.ts, .claude/rungate/config.json, test/live-issues.test.ts | Pipeline Phase 7 — nothing is hand-run | — |
| SC-2622 | Make this spec prove and trace its own criteria | specs/SPEC-TO-BOARD-PIPELINE-SPEC.md, lib/spec-evidence.ts, lib/spec-template.ts, lib/spec-requirements.ts, test/spec-evidence.test.ts, test/spec-requirements.test.ts | Pipeline Phase 8 — the chain traces back to a goal | — |
| SC-2624 | Establish a goal from evidence when the recorded one is stale | scripts/precompute-goal.ts, test/precompute-goal.test.ts | Pipeline Phase 8 — the chain traces back to a goal | — |
| SC-2625 | Ship the convergence spec to the board with no hand edit | specs/SPEC-TO-BOARD-PIPELINE-SPEC.md, test/board-conformance.test.ts | Pipeline Phase 9 — the payload ships | Give board-conformance a terminal condition and real inputs |

**No row names `.github/workflows/ci.yml`, and SC-2620 is the reason that is
not an omission.** The generated `test` job already runs `bun test`, so a
`board-conformance` case under `test/` reddens CI by existing. The first
draft listed the workflow and the AI review refused it: that file is
scaffold-owned — `lib/scaffold/owned-files.ts` carries it as
*regenerated, job-preserving* — so an issue naming it invites a hand edit
the next `rungate scaffold` overwrites, in every consumer repository as
well as this one. AGENTS.md: *fix the generator, not generated files*.

Seven rows. Five carry `—` in `Blocked by` and two carry edges, which is four
edges in total: group 2 waits on `#1680`, `#1681` and group 1, and group 7
waits on group 3. Every number in this paragraph is countable from the column
above it, which is the failure the first draft shipped — three different
totals in the prose, none of them the table's.

## Step two — the criteria the lead row could not carry

`--decompose` writes the lead criterion into each new body. The other six are
annotated afterwards, once the issues have numbers:

`bun bin/rungate.ts plan-issues --repair <repair-plan.md> --repo hornjason/rungate --write`

| Issue | Phase | Repair | Criteria | Confidence | Why |
|---|---|---|---|---|---|
| *group 1* | 3 | annotate | SC-2609, SC-2610 | high | one change to the criteria cell; SC-2610 is an evidence repair, not a build |
| *group 2* | 6 | annotate | SC-2615, SC-2616, SC-2617 | high | the three readings Phase 6 is missing |
| *group 3* | 7 | annotate | SC-2618, SC-2619, SC-2620 | high | one command: terminal condition, inputs, where it runs |
| *group 5* | 8 | annotate | SC-2622, SC-2623 | high | both are what a spec declares and proves about itself |

The `Issue` column is written when step one has run and the numbers exist.
That is a hand-assembled intermediate and it is worth naming as one: it is
the shape SC-2619 refuses for a *conformance reading*, and the reason the
same shape is acceptable here is that a plan is an adjudication somebody
approves, while a reading is a measurement nobody should be able to author.
`lib/issue-repair.ts` says the same thing in its own words — *"the judgement
is in the plan file, never here"*.

## Consequences

**Seven, not thirteen, and the difference is the whole of ADR-003's second
bullet.** Thirteen would have moved the opened-against-closed figure — 30
opened against 8 closed over the seven days to 2026-11-02 — by thirteen, to
buy exactly the same coverage reading seven buys.

**It still moves the wrong way, and that is the deal.** B2 is not "the
backlog is small"; it is "no criterion is invisible". A criterion naming
nothing reads as *nobody has reached it*, *it cannot start* and *it is
finished* at once, and the engine cannot be driven from a board that renders
those three the same.

**Two of the thirteen are evidence repairs, not builds.** SC-2610 and SC-2622
are both about criteria credited on the wrong thing. An agent that reads
either as a feature request will write code the tree already has. Group 1 and
group 5's outcomes are worded to prevent that, and SC-2610's is the one to
check first if this plan is ever re-read.

**Nothing here is ticked by this ADR.** The plan creates issues; the board
reading decides what is covered; and #1714's eight are the only criteria this
stage records as already true.

### Three review rounds, one defect class — what a fourth would not fix

AGENTS.md rule 5 stops the repairing here, and the reviewer reached the same
count independently. Every round found something live, and they were not
three unrelated misses:

| Round | Found |
|---|---|
| 1 | `SC-2020` for `SC-2620`; three disagreeing edge counts in one paragraph; ADR-003's cardinality stated one-way when the source says both |
| 2 | a docblock attributed to `criterionIdsIn`, which takes one spec's text; a generated file named as one an issue would edit |
| 3 | a lead criterion chosen on a rule the document never stated |

Six findings, five of them one class: **a hand-written value in prose that
has to agree with a table or a source somewhere else, and nothing derives
it.** Each round caught the next instance because a reader was the only
instrument.

The sixth — naming a generated file in a plan row — is not in that class. It
is a policy error, not a disagreement between two copies of a value, and
`lib/scaffold/owned-files.ts` already answers it for anyone who asks. It is
counted in the table above and excluded here, because a class that absorbs
every finding is a class that predicts nothing.

A review round found the five-against-six slip in this very paragraph, which
is the class reproducing inside the section written to retire it. That is
the strongest argument for the derived check below and it is left standing
rather than tidied away.

A fourth round would not fix a defect in this document — the round-3 review
re-checked every count, the 13-criterion total, the four edges, the 2.7
ratio and the `board-mirror` attribution, and reports they agree with each
other and with the code. It would fix the *class*, and that is a different
problem: deriving a plan's prose totals from its own table is work on the
planner, not on this plan. It is not filed as an eighth issue, in a document
whose subject is not over-filing; it belongs to group 5, which is already
*what a spec must declare and prove about itself*, and this section is the
record so whoever picks that up does not rediscover it.
