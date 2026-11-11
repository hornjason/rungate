---
doc-type: adr
status: proposed
created: 2026-11-11
updated: 2026-11-11
---

# ADR-013 — alignment before code, and what the engine is allowed to measure

## Status

**Proposed, 2026-11-11. Revision 2.** Revision 1 was audited adversarially by
a reader with no part in the conversation that produced it. Seven of its
twelve items were wrong; two were reversed outright. Every correction below
carries the measurement that forced it.

This document is the first instance of what it decides: the agreements were
reached in conversation on 2026-11-11, and nothing was built from them until
they were written here and attacked.

**Each item carries who agreed it.** Revision 1 did not, and the auditor's
first structural finding was that it could not tell Jason's call from the
session's inference attributed to him. Every other agreement surface in this
repository carries attribution — `agreed: "2026-10-30 Jason"` on each stage,
a named date on each AGENTS.md rule — and this one now does too.

## Context

Jason, repeatedly and across sessions: *"this is the biggest problem I have is
not knowing what the true status at any given time is. We get hallucinated
status readings at all times."* And on 2026-11-11, naming the behaviour
directly: over-eagerness to code before total alignment.

Three measurements set the frame. The audit reproduced all three exactly.

**The car and the payload are already fully placed.** `plan-spec --coverage`
over 34 specs:

```
PLANNED      2
  specs/CODE-REVIEW-CONVERGENCE-SPEC.md — 61 of 61 placed
  specs/SPEC-TO-BOARD-PIPELINE-SPEC.md  — 26 of 26 placed
UNPLANNED    22
NO_CRITERIA  10
```

**The goal command is short, and only one of the two reasons is about the
car.** `bun bin/rungate.ts board-conformance` exits 1:

| reading | result | scope |
|---|---|---|
| milestones | MET 26 of 26 | engine spec only |
| criterion-coverage | MET 26 of 26 | engine spec only |
| blocked-by-edges | MET 5 of 5 | engine spec only |
| criteria-field | MET 5 of 5 | engine spec only |
| queue-label | MET 5 of 5 | engine spec only |
| spec-placement | **SHORT 87 of 1815** | whole repository |
| criteria-named | **SHORT 43 of 84** | whole repository |

87 is 61 + 26 — the payload and the engine, and nothing else. The 1,728 short
is 22 specs that are neither; 648 of it is `specs/HARNESS-STANDARD.md`, whose
own frontmatter reads `doc-type: reference`.

**`spec-placement`'s contract and its arithmetic disagree.** It describes
itself as *"every criterion in every testable spec sits in a phase, **or its
spec is named UNPLANNED**"*, and its measure excludes only `NO_CRITERIA`:

```ts
const specs = b.specPlacements!.filter(s => s.state !== "NO_CRITERIA");
measured: specs.reduce((n, s) => n + s.placed,   0)   // UNPLANNED contributes 0
target:   specs.reduce((n, s) => n + s.criteria, 0)   // UNPLANNED contributes ALL
```

All 22 are already named UNPLANNED and every one is still counted short.

## The agreements

### 1. Car before payload, and the deferral is ratcheted — Jason, 2026-11-11

Until the engine spec and the convergence spec are both through,
`spec-placement` measures those two and nothing else.

**Revision 1 said "until" and named nothing that notices the condition.** The
audit's finding: re-admission would be 22 separate frontmatter edits that
nothing requires, so exit 0 becomes reachable on 2 of 34 specs and can stay
there indefinitely.

**The mechanism is a deferral ratchet**, the construction this repository
already uses twice — `.claude/config-access-ratchet.json` and
`.claude/spec-write-opaque-ratchet.json`. The deferred-criteria count is
banked in a JSON file, and the reading refuses **in both directions**: above
the number is new deferral nobody declared, below it is a file somebody
cleared without deleting its entry. Today's number is 1,728.

### 2. Deferral is a DECLARATION, never an absence — Rayford's framing, Jason's intent, 2026-11-11

A spec outside the engine says so in its own frontmatter. A spec with no
phase table because nobody wrote one and a spec deliberately held back are
different facts, and today they produce identical bytes.

*Survived the audit unchanged.*

### 3. WITHDRAWN — `criteria-named` keeps its repository-wide population

Revision 1 proposed narrowing `criteria-named` to admitted specs, justified
by: *"41 open issues, which predate the engine."*

**That premise is false.** The audit re-ran the reading with the command's
own parser:

```
offenders: 41
  predate 2026-10-30 (ADR-009): 17
  created ON/AFTER 2026-10-30:  24   — all 24 in November 2026
```

The reading is not short because of old debt. This project is filing issues
with no criterion at roughly two a day, right now. The offender list contains
**#1954**, the issue whose stated purpose is to repair this exact reading,
and **#1984**, an issue filed by this session on the day the ADR was written.

Narrowing the population would delete the only instrument that can see the
divergence AGENTS.md rule 7 exists to watch.

**#1954 is the repair, and it already decided this the other way.** Filed
2026-11-09: *"This issue is the repair… No new tooling: `spec-placement` and
`criteria-named` already exist as readings."* It routes the offenders through
`plan-issues --repair` and `plan-deps`. Revision 1 proposed the opposite
remedy and never mentioned it. **#1953** is the general form of the same gap
and was also unmentioned.

The agreement is withdrawn. #1954 stands.

### 4. CORRECTED — the empty-population guard exists; the real hole is different

Revision 1 proposed building a guard so that an empty admitted population
reads UNMEASURED rather than MET. **It is already built and already firing**,
`scripts/board-conformance.ts`:

```ts
if (target === 0) {
  return { ...base, status: "unmeasured", measured, target,
    why: "the board carries nothing for this reading to count, so 0 of 0 is not a pass",
    offenders: [] };
}
```

The audit traced the three cases agreement 2 can produce:

| admitted population | arithmetic | status | refused? |
|---|---|---|---|
| 0 specs | `target 0` | UNMEASURED | already |
| 1 spec, zero criteria | filtered to `target 0` | UNMEASURED | already |
| **1–2 specs with criteria, all placed** | `87 of 87` | **MET** | **no** |

Only the third is what agreement 2 actually creates, and nothing catches it.
Revision 1 claimed this guard "exists because agreement 2 opens exactly this
hole." It does not. The hole is a non-empty but arbitrarily small admitted
population, and the only thing that closes it is agreement 1's ratchet.

### 5. CORRECTED — one `board.labels` config block, replacing at least seven hardcoded sites — Jason, 2026-11-11

Jason: *"are those labels hardcoded somewhere? we shouldn't hard code
convergence or specific work labels right?"* Correct, and revision 1 named
one site when the audit found at least four live ones in `lib/`:

```
lib/board-ready-rule.ts:192-195    engine, spec:convergence, follow-up, external-audit
lib/board-ready-rule.ts:211        WORK_NEXT_LABEL — fifteen lines below, unnamed
lib/issue-filing-gate.ts:157       FILING_OVERRIDE_LABEL = "arbiter-override"
lib/issue-create-override.ts:92-93 "follow-up" and "external-audit" AGAIN
```

The last is the serious one: **two files hold one label vocabulary and
neither knows about the other.** `engine` is additionally already
`board.queueLabel` in `.claude/rungate/config.json`, so one label is written
in three places.

Nothing catches any of it — `CONSUMERS` in `test/anti.test.ts` censuses
consumer *names*, not consumer-specific *values*. **Fix the shape, not the
name:** one `board.labels` block in project config, read by every site.

This falsifies SUCCESS.md Claim 5 today: a consumer repository is shipped
this repository's label vocabulary in library code.

(`lib/generators/agents-md.ts` writes `hornjason/rungate` into a consumer's
rules deliberately, for upstream reporting. Left alone.)

### 6. The board is the source of truth; `project-state.json` is reference — Jason, 2026-11-11

Jason: *"source of truth can't be two places… shouldn't we ensure all work is
created on board first?"*

AGENTS.md rule 9 (*"an agreement is not real until it is an issue"*) and rule
10 (*"the plan is `project-state.json`'s `goal`, `goals` and `stages` —
nowhere else"*) cannot both hold. Rule 9 wins for **work**. Rule 10 is
narrowed rather than deleted — see decision 1, which the audit reversed.

### 7. Re-run this audit against the implementation once the instrument is fixed — Jason, 2026-11-11

Any gap list produced before `spec-placement` is corrected is measuring the
wrong population.

*Survived the audit unchanged.*

### 8. CORRECTED — no code before alignment, and the order is `agree → ADR → issue → SC → branch → code` — Jason, 2026-11-11

Jason: *"this process we are going through now needs to be law moving
forward to prevent over eagerness of just coding at will without total
alignment."* This becomes AGENTS.md rule 11.

**Revision 1 ordered it `agree → ADR → SC → issue → …` and that breaks rule
9.** The audit: rule 9 requires the issue filed *before the turn ends*, and
`.claude/rules/parallel-sessions.md` requires an SC block reserved **and
pushed to main** before any id is consumed — which cannot complete in the
same turn. Agreement 6 says rule 9 wins, so revision 1's own law violated the
rule it promoted.

The issue moves ahead of the SC. The issue is the cheap durable record and
satisfies rule 9 inside the turn; the SC block is reserved on main afterwards
and the criterion is written on the branch.

### 9. The flush-out is invokable, not remembered — Jason, 2026-11-11

A command in `.claude/commands/`, the convention this repository already uses
for `round-rca`, `ship-issue` and `stage-audit`.

*Survived the audit unchanged.*

## The decisions

### Decision 1 — REVERSED. The stage ladder stays.

Revision 1 proposed demoting the ladder to a generated view, keeping only the
retro gate, on the grounds that three of its four properties were held
elsewhere. **Two of those three rows were false, and four more properties
were missed.**

```
"stage ordering → blocked-by edges"     FALSE. The repo-wide dependency
                                        reading was written, measured
                                        129 of 154, and WITHDRAWN as
                                        family-blind — this repo has two
                                        live milestone families, Pipeline
                                        and Convergence. #1717 holds it.
                                        The surviving blocked-by-edges
                                        reading is 5 of 5, engine only.

"a verify per item → proved-by"         FALSE for 8 of 41 items. D4 and
                                        every item of stages E and F have
                                        verify: null, name no criterion and
                                        sit in no milestone. Demoting the
                                        ladder orphans eight agreed items.
                                        The ladder's commands are not
                                        criteria anyway: A2 greps
                                        $HOME/.claude/FLEET-STATE.md.

"stage grouping → milestones"           stands.
```

Four properties revision 1 never listed, none of which the board can hold:

| the ladder holds | board equivalent |
|---|---|
| `agreed: "<date> <who>"` per stage; a done item in an unagreed stage is a violation | none — this is rule 9 made executable |
| `scope: repo \| machine \| credentialed`, each counted as an equality | none |
| `DENIALS` — a done item whose own text says "is not met" | none |
| improvement status plus the ~700-line check (#1849) that a verify command names a test that EXISTS | `audit-spec-evidence` only checks `proved-by` is non-blank |

**And the ladder executes.** `test/stage-ladder.test.ts` runs in the sharded
CI suite and in `release.yml`, runs every done item's verify command, and
asserts completion as an equality. Revision 1 called the ladder "a file only
an agent reads"; it is a CI gate. Demoting it also removes
`openImprovements` from `scripts/update-project-state.ts`, so PROJECT-STATE.md
stops reporting outstanding improvements — reopening the fail-open #1745
closed.

**A Claim 5 exposure revision 1 did not mention:** `project-state.json` is
scaffold-owned and create-only (`lib/scaffold/owned-files.ts`,
`.claude/rules/harness-managed.md`). Its shape is consumer-visible surface.
Changing it is not an internal refactor.

**What replaces the demotion:** keep the ladder, and close #1984 as
originally written — make `work-status` read it. That fixes the stated
problem, nine planned items appearing in no report, without removing the only
thing carrying `agreed`, `scope` and the denial check. Rule 10 is narrowed to
say the ladder is the plan **for the engine build order**, and that all
*work* is an issue first.

### Decision 2 — the audit is run by a fresh adversarial reader — Jason, 2026-11-11

*Survived, and earned its place: it reversed two decisions and withdrew an
agreement built on a false premise.*

What such a reader cannot see, in its own words: which agreements Jason said
and which the session concluded and attributed to him, and what alternatives
were rejected. Both are fixed by the attribution added in revision 2.

### Decision 3 — RESOLVED. Rule 11 is enforced at PR time, inside `issue-audit.yml`.

Revision 1 left the site open for the audit to decide. Its recommendation is
a third option neither of revision 1's two: extend
`.github/workflows/issue-audit.yml`, which already correlates merged pull
requests with issues and already records "closed with no ship record" (#925).
One more reading in a job that has the API wired.

**Cost, stated:** the code is written by the time it fires. Mitigated by
shipping it as a *recorded reading* first and a *refusal* second — #240,
#261, #445 and #407 are this repository's record of new blocking gates
failing false-red on arrival.

**Why not the write-time hook:** a hook's liveness is not readable from the
repository. `.claude/rungate/hooks.json` records `TopLevelCdGuard` as
NOT LIVE, and that guard blocked two of the auditor's own commands during
this audit. User-scope hook registration also lives outside the scaffold, so
a consumer receives rule 11 as text only — Claim 5 again.

## What the audit must look for, next time and every time

- **FALSE GREEN** — anything that lets `board-conformance` exit 0 while the
  car does not work. The live instance is agreement 4's corrected table: a
  small non-empty admitted population reads MET.
- **FALSE RED** — anything that stops it exiting 0 for a reason that is not
  the car. The live instance is 1,728 deferred criteria.

And of every agreement: is it **falsifiable**, does it have a **home**, does
something **execute** it? An agreement failing the third is a resolution, and
resolutions in this repository do not survive a compaction.

## Consequences

- AGENTS.md rules 9, 10 and 11 are rewritten or added in one edit. Rule 10 is
  narrowed, not deleted.
- `spec-placement` changes population and gains a ratchet. It is expected to
  read MET immediately afterwards, which is a finding to be proved rather
  than assumed: a reading that goes green the moment it is edited is the
  shape this repository distrusts most.
- `criteria-named` is unchanged. **#1954 is the repair** and is not
  superseded.
- **#1984 is un-paused and proceeds as originally filed.**
- Nothing in `reference/`, `docs/research/` or any deferred spec is deleted.
  Deferral is a declaration about measurement, not about value.

## What this does not decide

- Which specs are admitted after the car is done, or in what order.
- Whether `specs/HARNESS-STANDARD.md` is a spec at all, given its
  `doc-type: reference` frontmatter and 648 criteria.
- The duplicate ADR number: `ADR-011` exists twice, as
  `ADR-011-board-and-engine-work-is-planned-not-found.md` and
  `ADR-011-the-audit-backlog-nine-issues.md`.
