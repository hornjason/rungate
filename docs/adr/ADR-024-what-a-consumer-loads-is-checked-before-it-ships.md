---
doc-type: adr
status: accepted
created: 2026-11-20
updated: 2026-11-21
---

# ADR-024 — What a consumer's agents load is checked before it ships

## Status

**Accepted, 2026-11-21 (#2568).** Jason approved merging it as written: decisions 2 to 7 as the DA proposed them, and the criteria stay in `specs/RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md` (`board-scope: deferred`) rather than moving to an active spec. The criteria are SC-2796 to SC-2805: SC-2795 was taken on main by #2589 before this merged, so the block moved up one. One wording change came with acceptance: SC-2801 said "a `CANARY_MARKER`", and that word alone matched the registry's `canary` pattern, whose assertion passes, so `sync-sc-status` would have ticked the whole criterion with nothing testing its other clauses (`test/sync-sc-todo-outranks-comment.test.ts` AC-4 refused it). It now says "the brief templates' test-only marker string", the same thing without the word. The rest of this paragraph is the proposal as it stood. **Proposed, 2026-11-20 (#2568).** Jason decides. Jason has already chosen the overall shape: render, then lint, then audit, then verify, with the surface check shipping to consumers as phase 1. Still open: decisions 4 to 7 below, and everything under "Not decided here".

## Context

rungate checks its own instruction surface. It does not check the surface it gives to consumers. Every measurement below was taken on 2026-11-20 against rungate main at c3c4bdc25 (0.8.41) and a consumer pinned to 0.8.37.

**1. The surface check works, and nothing runs it on a consumer.**

`scripts/check-instruction-surface.ts` has no relative imports (SC-2440). A copy extracted from main and run against the consumer's committed tree gives:

```
git -C <consumer> archive origin/main CLAUDE.md AGENTS.md .claude | tar -x -C $W/ddb
bun check-instruction-surface.ts --root $W/ddb
→ peak 2,003,937 bytes (~500,984 tokens), 3131% of the 64,000-byte budget, exit 1
  launch 2,000,223 over 345 files; 1,954,665 of them are 328 files under
  .claude/rules/mutations/, none path-scoped
  without that directory: 45,558 bytes, which is under budget
```

`git grep -l "measureSurface\|check-instruction-surface" -- lib/scaffold lib/conformity.ts lib/generators templates .github` matches only a comment in `lib/generators/agents-md.ts`. No scaffold step, generated conformity test, or consumer workflow calls the check. The consumer created the 2 MB directory itself (#1754 in its own tracker), so this is not a template bug. It is the kind of failure that only a check running on the consumer can see.

**2. Four template defects appear only in rendered output, and the suite passes with all of them present.** Found by reading one consumer's rendered `.claude/`. Filed as #2564, #2565, #2566 and #2567: #2564 and #2566 were fixed on main by #2574 and #2573 while this ADR was open, which is the point: each was found only by a person reading rendered output. Nothing would catch a recurrence.

| Defect | Where | Why no current check sees it |
|---|---|---|
| key-files states two sources of truth for project status (#2564) | `lib/scaffold/steps.ts` | each row is valid alone; the contradiction exists only between rows |
| the discovery brief points at an AGENTS.md "Specs table" that does not exist (#2565) | `templates/agent-briefs/discovery.md` | the brief is valid alone; the reference is wrong relative to the rendered AGENTS.md |
| docs-routing bakes `(N files)` into an always-loaded rule (#2566) | `lib/scaffold/steps.ts`, `lib/scanner.ts`, `lib/doc-routing.ts` | correct at render time; wrong one commit later |
| `CANARY_MARKER_FOR_SC354`, a bare `${SOURCE_DIRS}`, and lists numbered 1, 3 (#2567) | `templates/agent-briefs/marcus.md`, and aditi, rook, serena, discovery | SC-354 writes the canary into the real template (`test/agent-brief-template.test.ts`); it leaked in ba7a00ff0, and the test still passes because it asserts that the canary appears |

**3. Pressure language and model names are not rungate's problem today.** A count of MANDATORY, NEVER, CRITICAL, MUST, IMPORTANT and ZERO EXCEPTIONS gives at most 1 per brief in `templates/agent-briefs/`. A search for a model name in `templates/` finds none. The consumer's surface does have them: about 19 pressure markers in its CLAUDE.md, and its rules point at retired files. That text belongs to the consumer, so a lint for it belongs on the consumer side (row SC-2805). A rungate-side lint would have nothing to fail on.

**4. Evals cover four of the six briefs.** `evals/` holds marcus (6), quinn (2), rook (1) and serena (2). There are none for aditi or discovery. A line removed from those two briefs has nothing that would show the behavior change.

## Decision

Before a release, rungate renders its scaffold into fixture consumers and checks what was rendered:

1. Deterministic lints that can fail, each with a recorded mutation and a negative control.
2. A model-graded prompt-audit lens on pull requests that change what consumers load.
3. Evals that gate removing a line from a brief.

On the consumer side, the same surface check runs inside the conformity test rungate already generates. A `rungate prompt-audit` command sorts findings into the consumer's own and rungate's, and drafts a body for rungate's.

## Decisions

1. **Phase 1 ships `check-instruction-surface` to consumers. Decided by Jason, 2026-11-20.** It is the only check in this ADR that already exists, already has its mutations recorded (SC-2440 to SC-2447), and would have caught the largest measured defect, a 31x budget overrun.

2. **Lints read rendered output, never the templates. Proposed by the DA.** Three of the four defects in Context 2 are invisible in the template that produces them. The discovery brief's text is fine alone, and a count is right at render time. A template lint would pass on all three.

3. **The consumer budget is read from the consumer's rungate config, defaults to `SURFACE_BUDGET_BYTES`, and is held to SC-2447's 35% rule. Proposed by the DA.** A budget a consumer can raise freely would not constrain anything. A budget the consumer cannot set at all forces a fork of the harness.

4. **Over budget is a refusal from the first release, not a warning. Proposed by the DA.** #1069 measured that a 95% warning fired on every run while headroom fell to 37 bytes. A consumer chooses when to re-scaffold, so the refusal arrives when they are ready for it, and its message names the remedy: move worked records into `reference/` and route to them.

5. **Model-graded findings become PR threads and do not get their own gate. Proposed by the DA.** A model judgment has nothing to mutate, so it cannot be a check that fails reliably. A thread still blocks the merge until it is resolved, by a fix or by a one-sentence reason. That puts the human judgment where the diff is.

6. **A pull request that removes a line from a brief runs that brief's evals and must not regress. aditi and discovery get their first evals as part of this ADR. Proposed by the DA.** Removing a line is the default fix for an audit finding, and without an eval it is also the one change most likely to break behavior unnoticed.

7. **The consumer command never writes to rungate's tracker. Proposed by the DA.** It drafts the body defined in `reporting-upstream.md` and stops. Filing publishes the body to a public tracker, which needs the consumer's yes.

## Not decided here

- **How a model release triggers a re-audit.** Options are a scheduled run against rendered fixtures or a check when the configured default model changes. Either one opens a PR whose diff carries the findings as threads. Decided in a follow-up issue once SC-2803 exists.
- **Whether contradiction between rows (the key-files case) can be checked deterministically.** Until there is a detector that fails on that case and passes a negative control, it stays with the model lens.
- **The fixture set.** `test/fixtures/golden-project` is one fixture. Whether to add a legacy-monolith config consumer (as SUCCESS.md "Done, for a consumer" describes) belongs to SC-2799's issue.
- **Milestones.** Every row below says `—` until the phase placement table in `specs/RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md` gives them one (ADR-021).
- **Which spec governs these criteria.** `specs/RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md` declares `board-scope: deferred`, so SC-2796 to SC-2805 are banked as deferred (`.claude/spec-deferral-ratchet.json`, 28 to 38) and are not placed in board phases. ADR-022 and ADR-023 put theirs in the active `specs/SPEC-TO-BOARD-PIPELINE-SPEC.md`. `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` is active and already names this check (CRC-A3). Jason decides before merge whether to move them there.

## Decomposition

SC-2796 to SC-2805 are reserved in `specs/sc-reservations.json` on this ADR's branch, above ADR-023's 2789 to 2794. Each is a `- [ ] SC-<N>:` line under "What a consumer loads is checked before it ships (ADR-024, #2568)" in `specs/RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md`:

- SC-2796: A scaffold or re-scaffold run measures the consumer's launch and peak surface with `measureSurface`, and reports the reading with its largest contributors.
- SC-2797: The consumer budget is read from rungate config, defaults to `SURFACE_BUDGET_BYTES`, and a budget more than 35% above the measured surface is refused.
- SC-2798: The generated conformity test refuses an over-budget consumer surface, and refuses an unreadable one as UNMEASURED.
- SC-2799: CI renders the full scaffold into fixture consumers, and every lint below reads that rendered tree.
- SC-2800: Every file, heading or table that a rendered brief or rule tells its agent to read exists in the rendered tree.
- SC-2801: No rendered file carries an unexpanded `${…}`, the brief templates' test-only marker string, or a numbered list that skips, and the SC-354 test edits a copy, never the shipped template.
- SC-2802: No always-loaded rendered rule states a count of files that adding one file would change.
- SC-2803: Pull requests touching `templates/`, `lib/generators/` or `lib/doc-routing.ts` get a prompt-audit review lens that posts findings as threads, proven by a planted-cruft subject that it flags and a clean control that it does not.
- SC-2804: A pull request that removes a line from `templates/agent-briefs/<name>.md` runs that brief's evals, and aditi and discovery have at least one eval each.
- SC-2805: `rungate prompt-audit` runs the rendered-surface lints plus pressure-density and dangling-path lints on a consumer, labels each finding consumer-owned or harness-owned, and writes harness-owned findings as `reporting-upstream.md` bodies without filing them.

Each lint row records its mutation under the rule for mutation records: baseline and mutant counts, the tests that flipped, and a negative control.

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| SC-2796 | Scaffold measures the consumer instruction surface | scripts/check-instruction-surface.ts, lib/scaffold/steps.ts, test/consumer-instruction-surface.test.ts | — | — |
| SC-2797 | Consumer surface budget comes from rungate config | lib/config-loader.ts, scripts/check-instruction-surface.ts, test/consumer-instruction-surface.test.ts | — | Scaffold measures the consumer instruction surface |
| SC-2798 | Generated conformity test refuses an over-budget surface | lib/scaffold/steps.ts, lib/conformity.ts, test/scaffold-conformity-surface.test.ts | — | Consumer surface budget comes from rungate config |
| SC-2799 | CI renders the scaffold into fixture consumers | test/rendered-surface.test.ts, lib/surface-lint.ts, test/fixtures/golden-project/package.json | — | — |
| SC-2800 | Rendered briefs name only targets that exist | lib/surface-lint.ts, test/rendered-surface.test.ts, templates/agent-briefs/discovery.md, lib/create-brief.ts | — | CI renders the scaffold into fixture consumers |
| SC-2801 | Rendered surface carries no template artifacts | lib/surface-lint.ts, test/rendered-surface.test.ts, test/agent-brief-template.test.ts, templates/agent-briefs/marcus.md, templates/agent-briefs/aditi.md, templates/agent-briefs/rook.md, templates/agent-briefs/serena.md | — | CI renders the scaffold into fixture consumers |
| SC-2802 | Always-loaded rules carry no count a commit can stale | lib/surface-lint.ts, lib/doc-routing.ts, lib/scaffold/steps.ts, lib/scanner.ts, test/rendered-surface.test.ts | — | CI renders the scaffold into fixture consumers |
| SC-2803 | Prompt-audit lens reviews instruction-surface pull requests | lib/scaffold/ai-review-step.ts, REVIEW.md, evals/ai-review-control/subjects/planted-cruft/subject.json, evals/ai-review-control/subjects/planted-cruft/planted.ts, evals/ai-review-control/subjects/planted-cruft/clean.ts | — | — |
| SC-2804 | A brief line is removed only with its eval green | evals/aditi-visual-review/README.md, evals/discovery-finds-spec/README.md, evals/README.md, evals/scaffold-workspace.sh | — | — |
| SC-2805 | Consumer prompt-audit sorts findings by owner | lib/cli-commands.ts, lib/prompt-audit.ts, bin/rungate.ts, test/prompt-audit-command.test.ts | — | Rendered briefs name only targets that exist |
