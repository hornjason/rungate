---
doc-type: adr
status: accepted
created: 2026-11-22
updated: 2026-11-22
---

# ADR-025 — Where the AI review runs, on which model, and who pays

## Status

**Accepted, 2026-11-22 (#2642).** Proposed in #2634 (#2628) and merged by Jason
the same day with its criteria unwritten. The evidence is
`docs/research/ai-review-audit.md`, the audit he approved on 2026-11-21. Jason
then asked for the five criteria below to be written into
`specs/CODE-REVIEW-CONVERGENCE-SPEC.md` as drafted, for him to merge. They are
CRC-B10 to CRC-B13 and CRC-M19, and the Decomposition places one issue each
when this merges.

## Context

On 2026-11-21 Jason asked whether the AI review that can block a merge is any
good, what it costs, whether a consumer who has Claude can actually run it,
and whether it burns other people's budgets. He scrapped the trial reviewer
the same day (#2626 merged; #2631 and #2627 finish the deletion).

What the audit measured:

- **It is useful, and not mainly as a gate.** Of 40 findings graded blind,
  11 were real defects, 22 valid but minor and 7 wrong. None of the 12 an
  author declined was a real defect. Of the 4 that blocked a merge, 2 were
  right; 9 of the 11 real defects arrived without blocking.
- **It costs $0.70 a run and 2.7 runs per pull request**, about $1.88 per
  pull request on Sonnet 5 and $28–112 a day on this repository.
- **One run finds about half of what it can, and a different half each
  time.** Re-run at the commits behind those 11 real defects, today's
  reviewer found 5, then 3. Its two runs agreed on 2 of the 6 found.
- **The same prompt on Haiku 5.5 found 8, 8 and 8**, agreeing on 7 or 8 each
  time, at $0.016 a run. Three Haiku runs together found 9 of 11 for $0.05.
- **Haiku's extra findings are not noise.** Graded blind, 7 of its 15 findings that matched no known defect were real defects nobody had recorded, and none was wrong. Sonnet's extras were 3 real out of 9, also none wrong.
- **A consumer needs one of three credentials and the Claude GitHub App.**
  The credentials are a Vertex project, a Claude subscription token or an API
  key. The App is installed with its whole permission set, including write
  access to workflows, Actions and repository hooks. rungate requires it only
  because the generated job passes the action no `github_token`; the action
  skips the App when given one.
- **With no credential, nothing is spent.** The job reports that no review
  ran and passes, unless the consumer sets `RUNGATE_REQUIRE_AI_REVIEW`.
- **No consumer document says any of this.**

## Decision

The generated AI review runs on Haiku 5.5 by default, three times per round,
with the drafts merged. It needs no Claude GitHub App. A consumer guide says
what it costs, what it needs, and that nothing is spent until a credential is
added. CRC-M18 is retired with the trial that proved it.

## Decisions

1. **The default reviewer model is Haiku 5.5 — Jason decides.** It found
   more of the known defects than Sonnet, consistently, at about a
   fortieth of the price. `AI_REVIEW_MODEL` is the one constant; a Vertex
   consumer can still name another model in `ci.vertex.model`, and this
   repository's own config follows the default.
2. **Three runs per round, merged — Jason decides.** This is #1885's shape
   at three rather than five, and the cost question parked on #1885 is
   answered: three Haiku runs cost $0.05, against $0.60 for one Sonnet run
   today. Each run is a separate action invocation, as CRC-B4's verifiers
   already are, so the runs are independent by construction. A finding
   raised by one run blocks exactly as it would alone; the merge removes
   duplicates and does not vote anything away.
3. **The generated job passes the job's own token to the action — the DA
   recommends.** The reviewer has no shell and posts nothing itself; the
   threads are posted by a later step with `GITHUB_TOKEN`. The App's
   permissions buy the review nothing.
4. **A consumer guide, `docs/guides/AI-REVIEW.md` — the DA recommends.** The
   three credentials and who pays for each; that a subscription token spends
   one person's usage limits; the per-pull-request cost on the default
   model; that no credential means no spend; and the switch that makes a
   missing credential fatal.
5. **CRC-M18 is retired — Jason decides.** It said a diff over the
   reviewer's byte budget is still reviewed, with coverage stated as "n of m
   files read". The byte budget belonged to the trial, which pasted the diff
   into its prompt. The AI review reads files itself and has no such
   ceiling. The diff-budget script kept for it, scripts/review-diff-subject.ts (deleted in #2651),
   is deleted with it. If a measured miss on a large diff turns up, it is a
   new criterion with its own evidence.

   **The reading module stays.** `lib/review-execution-reading.ts` and
   `scripts/read-review-execution.ts` were kept for CRC-M18, but CRC-M13 (open)
   needs them too: it is met when the required reviewer reports the tool-call
   census that module computes. Only the coverage statement, "n of m files
   read", goes with CRC-M18.

## Not decided here

- **Whether a high-severity finding should keep failing the check.** 2 of the
  4 blocking findings in the sample were wrong, but 4 is too few to change a
  gate on. The next 100 pull requests on Haiku give the number.
- **A reviewer that is not Claude.** CodeRabbit, Qodo PR-Agent and Greptile
  can post a required check; PR-Agent runs on any model key. None was
  measured. A consumer who wants one can add it beside the generated job.
- **Bedrock, Foundry and Anthropic's own workload identity federation.** The
  action supports all three and the job resolves none. Added when a consumer
  asks, each with its own resolution test.
- **The defects nothing found.** `F10`, a test that cannot fail, was missed
  by every setup in every run. That is mutation testing's job, not the
  reviewer's.

## Criteria

Written into `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` as drafted (#2642). The
four reviewer criteria are placed in Phase 2, the next open Convergence phase
with reviewer work in it, so they reach Ready before the instruments; CRC-M19
sits in Phase 5 beside CRC-M18. CRC-B13 names the guide as plain text, not as a
code path, until row 4 creates it: the spec's citation test requires every
quoted path to exist.

- CRC-B10: The generated AI review runs on `AI_REVIEW_MODEL`, which is Haiku 5.5, unless the consumer's config names an exact model.
- CRC-B11: Each AI review round is three separate reviewer invocations, and the round's findings are their union with duplicates removed; no finding is dropped for being raised by one run.
- CRC-B12: The generated AI review passes the job's own token to the review action, so a consumer runs it without installing the Claude GitHub App.
- CRC-B13: `docs/guides/AI-REVIEW.md` states every credential the generated job resolves, who pays for each, the per-pull-request cost on the default model, and that a tree with no credential spends nothing.
- CRC-M19: CRC-M18 is retired, and the diff-budget script it named is deleted. The reading module CRC-M13 needs is kept.

## Decomposition

Filed by `adr-accepted.yml` when this merges, one issue per row, each into the
phase its criterion is placed in. Rows 1 and 3 change the generated
`ai-review.yml`, which the reviewer refuses to review on its own pull request,
so those two need the `ai-review-override` label and Jason merges them. Row 2
absorbs #1885, and its pull request closes both. Row 5 was blocked by #2627,
which is merged; the spec edit that retires CRC-M18's own line goes with it.

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| CRC-B10 | The AI review defaults to Haiku 5.5 | lib/scaffold/ai-review-step.ts, .claude/rungate/config.json, .github/workflows/ai-review.yml, test/ai-review-model-alias.test.ts | — | — |
| CRC-B11 | Three reviewer runs merged into one round | lib/scaffold/ai-review-step.ts, lib/scaffold/ai-review-findings.ts, .github/workflows/ai-review.yml, test/ai-review-workflow.test.ts | — | The AI review defaults to Haiku 5.5 |
| CRC-B12 | The AI review needs no Claude GitHub App | lib/scaffold/ai-review-step.ts, .github/workflows/ai-review.yml, test/ai-review-credentialed-job.test.ts | — | — |
| CRC-B13 | The consumer AI review guide | docs/guides/AI-REVIEW.md, docs/guides/HOW-WORK-FLOWS.md, test/agents-md-refs.test.ts | — | The AI review defaults to Haiku 5.5, Three reviewer runs merged into one round, The AI review needs no Claude GitHub App |
| CRC-M19 | CRC-M18 and its diff-budget script retired | scripts/review-diff-subject.ts, test/review-diff-subject.test.ts, .claude/spec-write-opaque-ratchet.json, lib/review-execution-reading.ts, test/review-execution-reading.test.ts, specs/CODE-REVIEW-CONVERGENCE-SPEC.md | — | — |
