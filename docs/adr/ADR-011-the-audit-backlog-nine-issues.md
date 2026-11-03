---
doc-type: adr
status: accepted
created: 2026-11-02
updated: 2026-11-02
---

# ADR-011: The audit backlog — nine issues, and no more notes

## Status

Accepted, 2026-11-02.

## Context

The post-implementation audit of the spec-to-board pipeline produced
fourteen items. Jason's instruction on reading them was one sentence:
**everything goes into issues with dependencies, no more notes.**

That instruction is the whole of this ADR's motivation, and it is aimed at
a specific failure this repository keeps repeating. `project-state.json`
currently carries a single priority entry 8,350 characters long. It is a
to-do list written as prose, in a file no tool queries and no agent is
routed to by work. Nothing in it can be claimed, blocked, assigned or
closed, so two sessions can act on the same line and neither can see the
other. An agreement that lives only there is an agreement nobody can pick
up.

Five of the fourteen were already resolved or in flight, which is why this
plan has nine rows and not fourteen:

| Audit item | Where it went |
|---|---|
| The filing parser cannot see a same-command heredoc | #1677, already open |
| An evidence bound is published before it is true | #1720, already open |
| `--decompose` sets no queue label | #1727, PR open |
| `plan-deps` derives across every milestone family | #1728, PR open |
| The board's Criteria column drifts from the body | a verify, not work — `board-conformance --reading criteria-field` |

## Decision

File the nine below. Four carry a success criterion in
`specs/SPEC-TO-BOARD-PIPELINE-SPEC.md` and are created by
`rungate plan-issues --decompose`; five are cleanup against a standing
SUCCESS.md claim and are created directly.

The split is not cosmetic. `CLAUDE.md` says a thing that moves none of the
five claims is cleanup and should say so rather than borrowing urgency —
so the five say so, in the only place that survives: the issue itself.

### The ordering of the work, which is not the ordering of this document

The four criterion-backed issues are created **before**
`specs/SPEC-TO-BOARD-PIPELINE-SPEC.md` gains `SC-2626..SC-2629`. That is
deliberate and it is the opposite of the intuitive order.

The ladder runs `board-conformance` against the **live** board as a verify
command, and `#1700` gave the CI suite a tracker token so that reading is
real in CI rather than UNMEASURED. `criterion-coverage` scores every
criterion the spec declares against the issues that exist. So a commit
that adds four criteria while their issues do not yet exist takes the
reading short — on the pull request, and then on `main`. Creating the
issues first makes the spec change green the moment it lands.

`--decompose` does not validate a criterion id against the live spec; it
reads the id's shape only. That is what makes this order possible, and it
is recorded here because it looks like a gap and is load-bearing.

### Issues with a criterion

<!-- Read by `rungate plan-issues --decompose`. The header spelling is the
     contract: `lib/issue-decomposition.ts` finds this table by matching
     `| Criterion | Outcome | Files |` and nothing else, so the second
     table below is invisible to it. An outcome may not contain a comma —
     a `Blocked by` cell is a comma-separated list and the two cannot be
     told apart. -->

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| SC-2626 | A refusal records what the finding became so the gate can be measured | lib/issue-filing-gate.ts, lib/finding-arbiter.ts, test/issue-filing-gate.test.ts, specs/SPEC-TO-BOARD-PIPELINE-SPEC.md | Pipeline Phase 6 — the board's state is a reading | — |
| SC-2627 | One issue shape that the generator emits and every filing path matches | lib/issue-decomposition.ts, lib/issue-repair.ts, .github/ISSUE_TEMPLATE, test/issue-decomposition.test.ts, specs/SPEC-TO-BOARD-PIPELINE-SPEC.md | Pipeline Phase 1 — a criterion becomes issues | — |
| SC-2628 | A consumer's upstream finding carries its provenance onto this tracker | lib/issue-filing-gate.ts, lib/finding-arbiter.ts, test/finding-arbiter.test.ts, specs/SPEC-TO-BOARD-PIPELINE-SPEC.md | Pipeline Phase 8 — the chain traces back to a goal | — |
| SC-2629 | Scaffolded consumers get a rule saying how to report a finding upstream | lib/scaffold/owned-files.ts, lib/generators/rules.ts, test/scaffold-ownership.test.ts, specs/SPEC-TO-BOARD-PIPELINE-SPEC.md | Pipeline Phase 8 — the chain traces back to a goal | — |

Every `Blocked by` cell is `—` **on purpose**. The phase order is derived,
not typed: `rungate plan-deps --repo hornjason/rungate --milestone-prefix
Pipeline --write` computes the adjacent-phase cross product and writes it.
Hand-typing an edge here would be a second source for the one thing rule 4
says must be data, and it is how a row ends up blocked by an issue that
closed last week.

**`--milestone-prefix Pipeline` is not optional.** Without it the derivation
spans both milestone families — `Pipeline Phase N` and `Convergence Phase
N` — and on 2026-11-02 an unscoped run wrote 89 edges across 38 issues and
took `blocked-by-edges` from 12 of 12 to 4 of 12. That is #1728.

Whether the *tool* stops you depends on which tree you are standing in, and
this document deliberately does not say. #1730 is the change that makes an
omitted flag a refusal; before it, `scripts/plan-deps.ts` refuses only a
*blank* prefix and reads an *omitted* one as no filter at all. Check the
tracker rather than this paragraph:

```bash
gh pr view 1730 --json state -q .state   # MERGED => the refusal is live
```

The PR rather than the issue, deliberately. #1730 is the only pull request
whose `closingIssuesReferences` names #1728, so the two states are in fact
equivalent — but a reader cannot see that from here, and #1728 is cited
elsewhere in this document for the original cross-family bug. Asking about
the change that makes the refusal is a question with one answer.

Two earlier rounds of review on this ADR were both about the same sentence,
in opposite directions — one caught it claiming the fix in the present tense
while the fix sat unmerged, the next caught the correction contradicting
itself two paragraphs later. A prose claim about merge state is wrong at
some point in every PR's life by construction, so the sentence is gone
rather than repaired a third time. The requirement above is true in every
tree; the enforcement is a tracker reading.

### Issues with no criterion — cleanup, and saying so

<!-- NOT read by `--decompose`: the header below is deliberately not
     `| Criterion | Outcome | Files |`. It IS read by
     `lib/filing-plan.ts`, which authorises a title when any table in a
     plan on `origin/main` has a header cell spelled exactly `Outcome`.
     That is what exempts these five from the filing cap. -->

| Claim | Outcome | Files |
|---|---|---|
| Claim 2 | A measurement in a PR body is compared against the tree it describes | .claude/rules, lib/ai-review-findings.ts, test/ai-review-findings.test.ts |
| Claim 2 | A finding naming one instance is checked for a population before the sweep | .claude/rules, prompts, test/prose-self-distance.test.ts |
| Claim 7 | PROJECT-STATE.md renders the retro improvements that are still open | lib/stage-ladder.ts, lib/project-state.ts, test/project-state-shape.test.ts |
| Claim 7 | /stage-audit runs the adversarial gap analysis that closing a stage needs | .claude/skills, lib/stage-ladder.ts, test/stage-ladder.test.ts |
| Claim 3 | /round-rca runs the root-cause pass when a PR reaches its round budget | .claude/skills, lib/review-rounds.ts, test/review-rounds.test.ts |

The five file lists are the **intended** scope, not a measurement. Rule 2
says an issue names the files it will change and an issue that cannot is
not ready — these can, and each is under ten files, which is rule 3. Where
a list names a directory rather than a file it is because the file does
not exist yet; the issue says which directory it will be born in.

## Why a merged plan is what authorises nine filings

`lib/issue-filing-gate.ts` caps filings at one per checkout per day, and
the cap is deliberately not configurable — a cap read from config is a cap
an agent raises. Nine issues in one sitting is exactly the population that
cap was not calibrated against.

The second route past it is `lib/filing-plan.ts`: a title appearing
**verbatim**, in an `Outcome` column, in a file committed on
`origin/main`. An agent cannot argue into that and cannot nominate its own
plan. It has to get one reviewed and merged first, and the merged plan is
the human reading the cap stands in for.

So this document is not a description of the filings. It **is** the
authorisation, and the exact strings in the two `Outcome` columns above
are the only nine titles it authorises. A tenth filing is refused, which
is the property worth having.

## Consequences

**The 8,350-character priority entry is retired.** Once these nine exist,
`project-state.json` carries the plan — `goal`, `goals`, `stages` — and
nothing that belongs on the tracker. Rule 10 says the plan is those three
keys and nowhere else; a prose backlog beside them is the third copy that
got Stage A scored wrong twice.

**The board becomes the list.** All nine carry a milestone in one family,
all four criterion-backed ones get derived edges, and all nine carry the
queue label. `rungate board-conformance --prefix Pipeline` is then a
complete answer to *what is left*, which is the thing a 3,000-word note
has never once been.

**The opened-against-closed ratio gets worse before it gets better, and
that is accepted.** Rule 7 watches issues opened against issues closed and
says above 1 the backlog diverges. The live ratio is 39 opened to 8 closed
since 2026-10-26 — 4.9 to 1 — and nine more filings move it to 6.0. The
ratio gates **swarm** runs, which this is not: this is the engine that
reduces the backlog, and Jason's standing call is that the gate applies
once the engine is under control and a swarm starts. Recorded here rather
than left for someone to rediscover in the audit.

## Alternatives considered

**File them as they come up, under the cap.** Nine days, and the cap's own
record says a filer that has to wait files a worse issue: it batches
unrelated findings into one title to fit. The cap is right about review
findings and wrong about a decomposition, which is why the second route
exists.

**Keep them in `project-state.json` and work from there.** This is the
status quo and it is what Jason rejected in one sentence. The entry is
unqueryable, unassignable and invisible to every tool in the repository,
and two sessions acting on it cannot see each other.

**Put all nine behind criteria.** Five of them move no claim in
`SUCCESS.md` and inventing a criterion to carry them would be the exact
thing `CLAUDE.md` forbids — cleanup borrowing urgency. A criterion that
exists so an issue can be filed is a criterion nothing will ever retire.

## References

- `docs/adr/ADR-003-spec-to-tracker-mapping.md` — the mapping `--decompose`
  serves. It states **three** steps, not five: placement, milestone,
  issue-citation. This ADR said "the five steps this is step 4 of" and that
  citation did not resolve to the document it named. The *"step 4"* and
  *"step 5"* numbering is real but lives elsewhere — `plan-issues`' own
  command description calls `--decompose` step 4 and `scripts/plan-deps.ts`
  calls itself "Step 5 of ADR-003" — so three places number a sequence
  ADR-003 does not carry. Corrected here only; the other two are a
  pre-existing inconsistency and not this plan's to fix.
- `docs/adr/ADR-010-engine-backlog-the-remaining-thirteen.md` — the previous plan, same shape
- `lib/filing-plan.ts` — what makes a merged plan an authorisation
- `lib/issue-decomposition.ts` — the table contract the first table above satisfies
- #1728 — why `--milestone-prefix` is required on the `plan-deps` run above
