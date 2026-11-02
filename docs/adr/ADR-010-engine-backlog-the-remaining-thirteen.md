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

## The decision, and why it is thirteen issues and not fewer

Not a judgement. `lib/issue-decomposition.ts` refuses a plan row whose first
cell names more than one criterion — *"one row is one issue serving one
criterion"* — so two criteria cannot share an issue through this tool at all.
ADR-003's cardinality judgement runs one way only: a criterion may become
several issues. Thirteen is the floor, and the question a plan can still
answer is whether any of these needs more than one. None does.

That is worth saying plainly because AGENTS.md rule 7 asks us to watch issues
opened against issues closed, and this plan moves it the wrong way. Over the
seven days to 2026-11-02 the repository opened 30 and closed 8. These
thirteen are engine work — the backlog this spec exists to make readable —
and they are filed through the metered path rather than by hand, which is the
whole point of SC-2613.

### SC-2610's behaviour already exists, and its issue must say so

`board-mirror` **does** read every spec. `readSpecDir` in
`lib/board-mirror.ts` calls `readdirSync(dir, { recursive: true,
withFileTypes: true })` over `<root>/specs`, the docblock above
`criterionIdsIn` reads *"Every criterion id in `<root>/specs`, from every
spec, including nested ones"*, and `main` in `scripts/board-mirror.ts`
documents the id set's default as *"every spec in the tree"*.

What is wrong is the criterion's evidence, not the code. It reads
`lib/board-mirror.ts contains [every spec]`, and `every spec` is a prose
phrase that occurs only inside comments — so the matcher credits a behaviour
it never looked at. This is exactly the row ADR-008 wrote for SC-2606, one
spec later: *name the real symbol, or name the criterion after the symbol.*
The issue below is worded that way so nobody rebuilds working code.

It cost something already. #1676 was created from ADR-008 for SC-2610 and
**closed on 2026-10-30**, and the criterion was ticked on the strength of the
comment. #1714 unticked it. A closed issue plus a ticked criterion is how a
criterion nothing proves becomes invisible, and the only reason this one came
back is that `project-state.json`'s stage C had written it down by hand.

### SC-2609, by contrast, is genuinely absent

`export const NAMES_NONE = ""` in `lib/board-mirror.ts` — still the empty
string. The criterion asks that *"this issue serves no criterion"* be spelled
out, so the cell is distinguishable from one nobody filled in. It is false,
the work is real, and it is one issue.

## The plan

`bun bin/rungate.ts plan-issues --decompose docs/adr/ADR-010-engine-backlog-the-remaining-thirteen.md --repo hornjason/rungate --write`

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| SC-2609 | Spell "serves no criterion" rather than leaving the cell blank | lib/board-mirror.ts, test/board-mirror.test.ts | Pipeline Phase 3 — the board tells the truth | — |
| SC-2610 | Point SC-2610 at the symbol that reads every spec instead of a comment | specs/SPEC-TO-BOARD-PIPELINE-SPEC.md, lib/board-mirror.ts, test/board-mirror.test.ts | Pipeline Phase 3 — the board tells the truth | — |
| SC-2615 | Sweep every testable spec and name the ones no phase places | lib/spec-placement.ts, scripts/board-snapshot.ts, test/plan-spec.test.ts | Pipeline Phase 6 — the board's state is a reading | #1681 |
| SC-2616 | Refuse an open issue that names no criterion instead of counting it covered | lib/criterion-issue-census.ts, scripts/board-conformance.ts, test/criterion-issue-census.test.ts | Pipeline Phase 6 — the board's state is a reading | Spell "serves no criterion" rather than leaving the cell blank |
| SC-2617 | Carry a blocked-by edge on every issue whose work depends on another | lib/spec-deps.ts, test/plan-deps.test.ts | Pipeline Phase 6 — the board's state is a reading | #1680 |
| SC-2618 | Exit non-zero while any board reading is short of its target | scripts/board-conformance.ts, test/board-conformance.test.ts | Pipeline Phase 7 — nothing is hand-run | — |
| SC-2619 | Refuse a conformance input that an agent assembled by hand | scripts/criterion-inventory.ts, scripts/board-conformance.ts, test/criterion-inventory.test.ts | Pipeline Phase 7 — nothing is hand-run | Exit non-zero while any board reading is short of its target |
| SC-2620 | Run the conformance command as a test so board drift reddens CI | test/board-conformance.test.ts, .github/workflows/ci.yml | Pipeline Phase 7 — nothing is hand-run | Exit non-zero while any board reading is short of its target |
| SC-2621 | Read the board's identifiers from project config not an agent prompt | lib/live-issues.ts, .claude/rungate/config.json, test/live-issues.test.ts | Pipeline Phase 7 — nothing is hand-run | — |
| SC-2622 | Prove each criterion here with a mutant that turns its own test red | specs/SPEC-TO-BOARD-PIPELINE-SPEC.md, lib/spec-evidence.ts, test/spec-evidence.test.ts | Pipeline Phase 8 — the chain traces back to a goal | — |
| SC-2623 | Declare in a spec which standing success claim it serves | lib/spec-template.ts, lib/spec-requirements.ts, test/spec-requirements.test.ts | Pipeline Phase 8 — the chain traces back to a goal | — |
| SC-2624 | Establish a goal from evidence when the recorded one is stale | scripts/precompute-goal.ts, test/precompute-goal.test.ts | Pipeline Phase 8 — the chain traces back to a goal | — |
| SC-2625 | Ship the convergence spec to the board with no issue edited by hand | specs/SPEC-TO-BOARD-PIPELINE-SPEC.md, test/board-conformance.test.ts | Pipeline Phase 9 — the payload ships | Exit non-zero while any board reading is short of its target |

### The edges, and why these five

Ordering is data (AGENTS.md rule 4) and inventing order is worse than
recording none, so eight of the thirteen are written independent.

Two point at issues ADR-008 already filed. SC-2615's sweep is the corpus-wide
reading of the mechanism #1681 builds, and SC-2617's edges are the tracker
side of the function #1680 names. Writing them as `#1681` and `#1680` rather
than restating their work keeps one piece of work at one issue, the way
ADR-008 worded SC-2613 to match ADR-007.

Three point within this plan. SC-2616 needs a cell that can say "none" before
it can refuse one that says nothing, which is SC-2609. SC-2619, SC-2620 and
SC-2625 all need the conformance command to have a terminal condition before
they can be about where it runs, what it reads, or what it accepts — that is
SC-2618, and it is the only row three others wait on.

## Consequences

**The backlog gets thirteen wider before it gets narrower, and that is the
deal.** B2 is not "the backlog is small"; it is "no criterion is invisible".
A criterion naming nothing reads as *nobody has reached it*, *it cannot
start* and *it is finished* at once, and the engine cannot be driven from a
board that renders those three the same.

**Two of the thirteen are evidence repairs, not builds.** SC-2610 and SC-2622
are both about criteria that are credited on the wrong thing. An agent that
reads either as a feature request will write code the tree already has. Each
outcome above is worded to prevent that, and SC-2610's is the one to check
first if this plan is ever re-read.

**Nothing here is ticked by this ADR.** The plan creates issues; the board
reading decides what is covered; and `#1714`'s eight are the only criteria
this stage records as already true.
