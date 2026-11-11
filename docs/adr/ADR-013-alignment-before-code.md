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

**Read "Where this stands" at the end of this file before anything else.**
The body below is revision 2. A second audit and a process review happened
after it was written, and their results, the agreed replacement process, and
the next steps are recorded there, not yet folded into the body.

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

## Where this stands — handoff, 2026-11-11

Written so a fresh session can resume with nothing but this file. Everything
after revision 2's body is recorded here. Nothing below has been folded into
the agreements above yet; that is revision 3.

### Second audit of revision 2 (fresh reader, no conversation context)

Every number and citation in revision 2 reproduced. The corrections from the
first audit hold. Six findings against what revision 2 proposes:

1. **The ratchet in agreement 1 is a bare total.** Both precedents it cites
   bind by name: `.claude/config-access-ratchet.json` is a per-file map, and
   `.claude/spec-write-opaque-ratchet.json` lists 268 sites. A total is
   satisfiable by swapping members. Fix: bank the 22 deferred spec paths, each
   with its criteria count.
2. **Agreement 8's order manufactures criterion-less issues.** An issue filed
   before its SC exists cannot name one, and nothing returns to it. #1954 and
   #1984 are both live instances. Nothing at filing time checks for a
   criterion. *Superseded by the process below, which writes the SCs during
   acceptance so work issues are born naming them.*
3. **Keeping the ladder is right, but rewording rule 10 does not satisfy
   "source of truth can't be two places".** Eight ladder items — D4, E1-E5,
   F1, F2 — exist only in the ladder, with no issue and no milestone. Either
   file them or exempt them by name. **Pending Jason's decision.**
4. **"All work is an issue first" is false for the work that decides what the
   issues are**: an ADR, a retro, a review, an audit. ADR-013 is itself that
   kind of work, and no issue preceded it. Name the exempt class.
5. **`.claude/rungate/hooks.json` records `TopLevelCdGuard` as NOT LIVE. It is
   live** — registered in `~/.claude/settings.json`, and it blocked the
   auditors' commands. Decision 3 quoted the stale record as evidence. File it
   as a bug.
6. The `plan-spec --coverage` block in Context shows two PLANNED detail lines
   the command does not print. The figures are right; the block was typed,
   and should say so.

### Process review (fresh reader, asked whether this is over-engineered)

Verdict: mostly the process this repository already uses, with ceremony added
at the edges, and the one step that serves SUCCESS.md Claim 7 left manual.
ADR-008, 010, 011 and 012 each landed as a single docs PR carrying the ADR and
its decomposition table (#1674, #1715, #1814, #1884), with no separate
acceptance issue; `plan-issues --decompose` was then run by hand.

Its findings, all accepted by Jason on 2026-11-11:

- **No separate "Accept ADR" issue kind.** It is just the issue rule 9
  already requires, and the PR closes it.
- **No rule 11.** It restates rules 2 and 9; fold it into rule 9.
- **A size threshold.** A decision that becomes one issue needs no ADR: file
  it with the existing `.github/ISSUE_TEMPLATE/spec-work.yml`, which already
  asks for criteria and files and accepts `serves no criterion`.
- **Decision 3 was wrong about the site.** `issue-audit.yml` runs on a daily
  schedule, against Jason's "no schedules" rule. The per-PR home is
  `.github/workflows/closing-references.yml`.
- **Automate the filing.** `plan-issues --decompose` run by hand breaks Claim
  7, which counts "a board state reachable only by someone running a command
  by hand" as failure. No workflow calls it today.
- **A trap in that automation:** `plan-issues`' duplicate check reads only
  OPEN issue titles. Re-running it on any ADR edit would re-file rows whose
  issues are closed. It must fire only on the change to `status: accepted`,
  or also check closed issues.

### The agreed process — Jason and Rayford, 2026-11-11

Replaces agreement 8's order. Revision 3 makes this the law.

1. **Agree, and file one issue the same turn**, with the existing template.
2. **If it is big** — it splits into more than one issue, or changes a rule or
   a gate: write the ADR with `create-adr`, write the SC lines into the
   governing spec (chosen by the spec's `governs:` frontmatter and
   `.claude/rules/specs-routing.md`; `create-spec` if none governs), run
   `/flush-out` until it holds, then one PR closes the step-1 issue carrying
   the accepted ADR, the SC lines and the filled table. Jason merges.
   Small decisions skip to step 4.
3. **On merge, a workflow files every table row** with `plan-issues
   --decompose` and `plan-deps`. Nobody places the plan by hand.
4. **Build each issue**: PR with `Fixes #N`, and `closing-references.yml`
   refuses a PR whose issue names neither a criterion nor `serves no
   criterion`.

**Mechanical after ADR-013 is built:** the ADR skeleton (`create-adr`),
accepted ADR to issues on the board (the workflow), issue to card and lane
(already), the per-PR criterion check, and the meter's population (the
ratchet). **Stays human by design:** agreeing, writing the SC text, choosing
the spec, judging size, merging. **Triggered by a person but scripted:** the
audit (`/flush-out`).

`create-adr` is Rayford's addition, which the process review did not
address: the workflow in step 3 parses each ADR's table, and a hand-typed
table is how that parse breaks (ADR-011 records one instance).

### What ADR-013 will file

ADR-013 builds the workflow that files issues, so its own rows are filed by
hand this once. Every later ADR files itself.

**By hand, before acceptance:**

- the rule-9 issue for ADR-013 — `serves no criterion`
- the `hooks.json` bug in audit finding 5 — one issue, so no ADR (the size
  threshold in action)

**One acceptance PR**, closing the rule-9 issue: ADR-013 at `accepted`, an SC
block reserved in `specs/sc-reservations.json`, the SC lines in
`specs/SPEC-TO-BOARD-PIPELINE-SPEC.md`, and the decomposition table's ids
filled. Revision 3 adds that table with these seven rows:

| # | Outcome | Main files |
|---|---|---|
| 1 | `spec-placement` honours a deferral declaration in spec frontmatter, with the 22 deferred specs ratcheted by path and count | `scripts/board-conformance.ts`, a new ratchet JSON |
| 2 | one `board.labels` block in project config replaces the four hardcoded label sites | `lib/board-ready-rule.ts`, `lib/issue-filing-gate.ts`, `lib/issue-create-override.ts`, `.claude/rungate/config.json` |
| 3 | AGENTS.md rule 9 names the exempt work and the size threshold; rule 10 narrowed to the engine build order | `AGENTS.md` |
| 4 | a PR whose issue names neither a criterion nor `serves no criterion` is refused | `.github/workflows/closing-references.yml` |
| 5 | merging an ADR that changes to `accepted` runs `plan-issues --decompose` and `plan-deps`; the duplicate check covers closed issues | a new workflow, `scripts/plan-issues.ts` |
| 6 | `create-adr` writes an ADR skeleton whose table the parser is guaranteed to read | `lib/cli-commands.ts`, a new script |
| 7 | `/flush-out` runs the adversarial audit on demand | `.claude/commands/` |

**Already filed, continuing alongside:** #1984 (`work-status` reads the
ladder; WIP on `rg/1984-stage-ladder-in-work-status`), #1954 (the 41 issues
naming no criterion), #1983 (D4's check cannot fail).

### Decisions taken — Jason, 2026-11-11 (after the handoff was first written)

1. **The eight ladder-only items are mostly not new work.** Measured item by
   item: D4 waits only on #1983; E1 is deferred by agreement 1; E2 is #1954;
   E3 is covered by row 5; E5 is SC-2623, open as #1720; F1 and F2 are the
   ladder's finish line, readings rather than tasks. Each ladder item points
   at the issue covering it. **E4 (`board-mirror --write`) was the one real
   gap** — no workflow runs it — and is **added to row 5's on-merge
   workflow**, Rayford's recommendation, accepted.
2. **Every solidified decision carries a visual.** `/flush-out` produces an
   HTML picture of the agreed process as its last step, and the final picture
   is committed next to the ADR as `docs/adr/ADR-NNN-flow.html`, in the same
   acceptance PR. Agreement 10 in revision 3.
3. **The two hand-filed issues are filed:** #1985 (the rule-9 issue for this
   ADR, which the acceptance PR closes) and #1986 (the `hooks.json` record).

4. **The board must move mechanically — Jason, 2026-11-11.** Placing #1986 by
   hand-adding a label was proposed and rejected. Measured: `board-intake.yml`
   writes a card and a Status column and never a placement; both issue
   templates carry `labels: []`, and template labels apply only through the
   web form, which `gh issue create` skips. An unplaced issue is never
   promoted to Ready. **Row 8 is proposed:** intake places an issue when it
   opens — a named criterion in a phase sets that phase's milestone; `serves
   no criterion` adds the everyday label from `board.labels`; neither is
   reported UNPLACED by name. #1986 is left alone until row 8 ships.
5. **A second placement gap, from live `work-status` on 2026-11-11:** #1752
   carries the milestone "Issue intake" and still reads UNPLACED, because the
   phase tier counts only milestones in the Pipeline and Convergence
   families. Row 8 must cover it.
6. **Neither audit nor the process review caught the placement gap.** Every
   reviewer audited against `board-conformance`, and none of its seven
   readings measures whether an issue is placed. `/flush-out` must require
   the auditor to trace one issue of each kind from filing to Ready, not only
   read documents.
7. **A whole-process audit is ordered — Jason, 2026-11-11** — covering every
   path by which work enters the board, traced end to end, before revision 3.

### Whole-process audit, 2026-11-11 (fresh reader, every intake path traced on live issues)

**Paths.** Not three. Five live paths onto the board, plus one that never
reaches it. The ADR and spec paths are ONE path: `create-spec` only writes a
file, and under the agreed process a spec reaches the board only through an
ADR's table. The "side door" is four doors that each check different things.

| path | how | notes |
|---|---|---|
| A | `gh issue create` by an agent or Jason | the local filing hook runs only on this machine |
| B | GitHub web form (spec-work, everyday-work) | skips the local hook |
| C | `plan-issues --decompose` from an ADR or spec table | hand-run today; row 5 automates |
| D | a consumer reporting upstream, `--label from-consumer` | never used; label not ranked |
| E | ship.js sub-issues via Octokit | dormant while `ship.mode` is direct; no hook, label, milestone or dependency edges |
| F | an issue transferred in | intake ignores `transferred`, so it never reaches the board (#1752) |

Not intake paths, because none creates an issue: `finding-promotion`,
`ai-review-findings`/`threads`, `issue-audit`, `board-sweep`.
`scripts/lib/gap-emit.sh` has no caller.

**Two corrections to this file, verified by Rayford in the code:**

- Decision 4 said an unplaced issue is "never promoted". Wrong: UNPLACED is
  the last tier, so it **sorts last** (`lib/board-ready-rule.ts`). With 48
  placed issues ahead and a Ready cap of 2 it starves in practice, which is
  why the fix still matters.
- Decision 5 blamed #1752's placement on its milestone being outside the two
  families. Wrong: `phaseOf` in `lib/board-mirror.ts` needs `Phase N` in the
  milestone title. "Issue intake" and "Convergence Machinery" both lack it.
  Fix: close or rename those two milestones — no code.

**Gaps, worst first:**

1. **Row 8 cannot place most criteria.** Only 87 of 1,815 criteria sit in a
   phase. An issue naming a criterion from a deferred spec is neither phased
   nor `serves no criterion`. Fix: a criterion with no phase falls to a
   ranked label.
2. **Placing an issue never triggers a promotion.** `board-ready.yml` listens
   for opened, closed, assigned, unassigned, reopened — not labeled or
   milestoned. Placing inside `board-intake` races `board-ready` on the same
   `opened` event. Fix: place inside `board-ready`'s own run, before ranking.
3. **A PR without `Fixes #N` strands its issue** out of In review and Done
   (#1921; #1717 had six merged PRs). `closing-references.yml` refuses only a
   keyword GitHub cannot see, not a missing one, and is **not a required
   check** — main requires only `test` and `ai-review`. Row 4 lives on that
   job, so it is advisory too. Fix: make it required and refuse a PR with no
   closing reference.
4. **Two front doors cannot write the token rows 4 and 8 key on.**
   `everyday-work.yml` has no `serves no criterion` field; the consumer text
   in `lib/generators/agents-md.ts` asks for none; free text like "Criteria
   this serves: none" does not match `NAMES_NONE`. Fix: a prefilled
   declaration in both, and rank `from-consumer`.
5. **Blocked-by on paths A, B, D, E is prose**, and `board-ready` reads only
   dependency edges. Fix: intake turns the Blocked-by field into edges.
6. **Row 5 misses `plan-spec`.** If the acceptance PR adds a phase,
   decompose refuses because the milestone does not exist. Fix: run
   `plan-spec --write` first. Also: decompose labels every row `engine`.
7. **This ADR's own table uses the wrong columns.** The parser wants
   `Criterion | Outcome | Files | Milestone | Blocked by`.

**What rows 1-8 close:** path C end to end except gaps 3 and 6. Row 8 is
right in intent and must also cover gaps 1, 2, 4 and 5. Rows 1, 2, 3, 6, 7
do not move intake at all.

**Over-engineering, in the auditor's view:** row 7 (`/flush-out`) and the
per-ADR visual are ceremony that does not move the board; row 6
(`create-adr`) could be a template file, since decompose already refuses an
unreadable table; row 2 (`board.labels`) could wait, since one repository
reads the labels today; row 1 measures specs, not the board. **This
conflicts with Jason's explicit decision 2 on the visual** — his call.

Could not be checked: web-form issues are indistinguishable from CLI ones
(all 86 open issues are authored by `hornjason`), so path B is inferred from
the templates.

**Decided — Jason, 2026-11-11, taking Rayford's recommendation:** keep row 1
(the ratchet is the meter fix), row 2 (`board.labels`: Jason asked for no
hardcoded labels, and Claim 5 needs it), row 7 (`/flush-out`) and the
per-ADR visual (decision 2). **Row 6 becomes a template file**, not a
`create-adr` command — decompose already refuses a table it cannot read.

**Row 4's shape, decided — Jason, 2026-11-11: block now, fix as we go.**
A warning nobody reads helps nothing, so this repository blocks from the day
row 4 merges; there is no warn period and no streak counter. The check
refuses a PR that closes no issue, or whose issue names neither a criterion
nor "serves no criterion". Session-record PRs are exempt by name (Jason's
call) — they were most of the 14 of the last 40 merged PRs that closed no
issue. An old issue with no criterion (#1954) is fixed when a PR hits it, by
adding one line to the issue. The workflow must also trigger on `edited`:
measured, it runs on the default `pull_request` types only, so a corrected
description would stay red. A repository variable,
`RUNGATE_REQUIRE_CLOSING_REF`, is the switch, read exactly as
`RUNGATE_REQUIRE_AI_REVIEW` is: `true` here; off by default for a consumer,
whose fresh repository has no issue naming a criterion yet. Branch
protection is per repository (no account-wide setting on a personal
account): after row 4 merges Jason runs one command adding
`closing-references` to main's required checks — measured 2026-11-11,
they are `test` and `ai-review` only.

**Consumers must get all of this easily — Jason, 2026-11-11:** *"our
consumers will have to do all this as well, so we want an easy process."*
Measured: the scaffold does NOT emit `closing-references.yml`, so a consumer
has no such check today; `lib/branch-protection.ts` (PROTECT-1) READS a
repository's protection and reports, and nothing SETS it. So revision 3 must
state, for every row, how a consumer receives it — by `rungate scaffold`, not
by copying this repository — and every human step a consumer must take must
be printed by the tool at the moment it is needed, as one command, never
looked up in a document. Row 4 for a consumer: `scaffold` emits the check in
warn mode; the check prints the two commands (add it to required checks;
flip the variable) when they are due; PROTECT-1 reports a check that exists
but is not required.

### Open decisions — Jason's

1. Make `closing-references` a required check (gap 3) — a branch-protection
   change, which is Jason's to make.

### Known defects in this branch

- `test/line-citation-ratchet.test.ts` fails: this file carries four
  `path:line` citations and is not in the ratchet. Fix by rewording each as a
  symbol name, not by growing the ratchet.
- The flow diagram for this process was drawn at
  `~/.rungate/show-me-adr013-flow.html` — outside the repository, a picture of
  this section and not a source of truth.

### Next steps, in order

1. ~~Jason decides the two open items.~~ Done.
2. ~~File the rule-9 issue and the `hooks.json` issue.~~ #1985, #1986.
3. Write revision 3: fold every finding above into the body, replace
   agreement 8 with the agreed process, drop rule 11, move decision 3's site
   to `closing-references.yml`, add the seven-row table, fix the citations.
4. Audit revision 3 with a fresh reader.
5. Acceptance PR; Jason merges; file the seven rows by hand this once.
