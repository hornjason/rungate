---
doc-type: research
governs: .github/workflows/ai-review.yml
created: 2026-11-21
status: active
owner: jason
updated: 2026-11-21
---

# The AI review audit (#2628)

## Why this exists

On 2026-11-21 Jason asked four things about the AI review that can block a
merge:

- Is it doing a good job?
- What does it really cost?
- rungate assumes every consumer uses Claude. Can someone who has Claude
  actually run this review, with the GitHub Action and credentials it needs?
- Does it burn other people's budgets, and is there a better option?

He also scrapped the second, trial reviewer (`claude-review.yml`). It was
disabled the same day, and #2626 and #2627 delete it. This audit is about the
reviewer that stays: the generated `ai-review` job in
`.github/workflows/ai-review.yml`.

`docs/research/pr-review-gate-tooling.md` (2026-10-18) already surveyed the
products and the billing paths. This document does not repeat that survey. It
adds what was not measured then: how accurate the reviewer is, what it costs
per pull request, whether a cheaper setup catches the same defects, and what
a consumer must have before it runs at all.

## The answers in short

- **Accuracy.** About a quarter of its findings are real defects and about
  half are valid but minor. Roughly one in six is wrong. When it blocks a
  merge, it is right about half the time in our sample, and most real defects
  it finds arrive without blocking.
- **Cost.** $0.70 a run on Sonnet, 2.7 runs per pull request, so about $1.88
  per pull request. On this repository that has been $28–112 a day.
- **Cheaper setups.** The same prompt on Haiku found 8 of 11 known real defects on each of three runs, at $0.016 a run. Today's Sonnet reviewer found 5, then 3, at $0.60. A single Sonnet run finds about half of what it can, and a different half each time.
- **Consumer access.** A consumer needs one of three credentials and must
  install the Claude GitHub App on the repository. The App requirement is
  ours, not the action's. Nothing in the consumer documentation says any of
  this. With no credential the review reports that it did not run and spends
  nothing, so nobody's budget is touched by default.

## 1. How good the reviewer is

### What was read

The last 100 merged pull requests on this repository and every AI review
finding posted on them: **224 findings across 61 of the 100**. Each finding's
replies were read to say what the author did with it: acted on it (154),
declined it (68) or never answered (2). The appendix lists the 40 graded
findings.

### The blind grade

40 findings were drawn at random (seed `20261121`) and graded **without
seeing whether the author acted on them**, against the code at the commit the
finding was posted on and the commits that followed:

| Grade | Count | Share |
|---|---|---|
| Real defect: a wrong result, crash or data loss on an input the finding names | 11 | 28% |
| Valid but minor: true, worth a line, would not have hurt anyone | 22 | 55% |
| Wrong: the code does not do what the finding says | 7 | 18% |

8 of the 40 (20%) were judged worth blocking a merge over.

Then the grades were joined to what the author did:

| Author's response | Real | Minor | Wrong |
|---|---|---|---|
| Acted on it (28) | 11 | 15 | 2 |
| Declined it (12) | 0 | 7 | 5 |

None of the declined findings was a real defect, so declining has not been
throwing away real bugs. Acting on everything has cost some churn: 17 of the
28 changes made in response fixed something minor or something that was not
wrong.

### Blocking

Severity is recorded on 103 of the 224 findings; older rounds posted threads
without it. Of those 103, **16 were blocking (`high`), on 12 of the 100 pull
requests**: 12 acted on, 4 declined.

In the graded sample, 4 findings were blocking: **2 real, 2 wrong.** Of the
11 real defects, 2 were raised as blocking, 4 as `medium` (not blocking) and
5 without a severity. So the block is not where the value is. Most of what
the reviewer catches reaches the author as a comment, and the author fixes it
because it is right, not because the check is red.

### The limits of this grade

The grader was Claude, the same model family as the reviewer, so the grade is
not independent. The 11 real defects were each confirmed against the commit
that later fixed them, which is the strongest evidence here. The wrong and
minor calls are judgement.

## 2. What it costs

| Measure | Value | Source |
|---|---|---|
| Per run | **$0.695** mean, $0.29–1.19, 27.5 turns | the action's own execution files, last 40 runs |
| Runs per pull request | **2.7** mean, median 2, max 19 | 737 `pull_request` runs over 273 branches, 2026-11-14 to 2026-11-22 |
| Per pull request | **about $1.88** | the two above |
| Runs per day on this repository | 40–161, about 92 on a full day | the same 737 runs |
| Per day on this repository | **$28–112**, about $64 | the two above |

The run counts come from:

```
gh run list -R hornjason/rungate --workflow ai-review.yml --limit 1000 \
  --json headBranch,event,createdAt
```

This repository bills its runs to its own Vertex project. The number that
matters for a consumer is the per-pull-request figure: a team merging ten
pull requests a day would spend about $19 a day on Sonnet through an API key,
or the equivalent share of a subscription's usage limits.

## 3. Cheaper setups, re-run on the same commits

### Method

The 11 findings graded real defects in section 1 came from 10 pull requests.
Each was re-reviewed at the commit the finding was raised on, by several
setups, and each run was scored on one question: did it find that defect?

Every run used Claude Code locally against the `jhorn-pai` Vertex project,
in a scratch checkout of the commit, with an empty Claude Code config
directory so no personal settings, hooks or instructions loaded. Every setup
got the same inputs:
- the pull request's title and body;
- the changed-file list;
- the round-1 carry state;
- the diff, as a file.

| Setup | Prompt | Model | Can open files |
|---|---|---|---|
| **Today's reviewer** | the CI prompt, verbatim from `ai-review.yml` | Sonnet 5 | yes: Read, Grep, Glob |
| CI prompt on Haiku | the same | Haiku 5.5 | yes |
| Short prompt | 20 lines: correctness defects only, read `REVIEW.md`, the same output shape | Sonnet 5 | yes |
| Diff only, Sonnet | the short prompt with the diff pasted in | Sonnet 5 | no |
| Diff only, Haiku | the same | Haiku 5.5 | no |

Today's reviewer was run twice and the Haiku setup three times, to see how
much one run varies from the next.

A no-tools Sonnet call compared each run's findings with the known defect and
said whether any finding named the same root cause. I checked nine of its
calls by hand: eight held, and one was too generous. That one was a diff-only
Sonnet finding that described the right scenario as a mismatch between the
description and a test, at low severity. It is counted as a miss.

### Results

| Setup | Runs | Defects found per run | Found by any run | Cost per run |
|---|---|---|---|---|
| **Today's reviewer** | 2 | **5, 3** | 6 of 11 | **$0.60** |
| CI prompt on Haiku | 3 | **8, 8, 8** | 9 of 11 | **$0.016** |
| Short prompt, Sonnet | 1 | 6 | — | $0.55 |
| Diff only, Sonnet | 1 | 5 | — | $0.24 |
| Diff only, Haiku | 1 | 6 | — | $0.006 |

What the table says:

- **One run of today's reviewer finds about half of what it can find, and not
  the same half twice.** Its two runs agreed on 2 of the 6 defects either
  found. All 11 were found by this reviewer in CI originally, over 2.7 runs
  per pull request on average, which is the same sampling seen from the
  other side. #1290 says the reviewer is a sampled instrument; this measures
  it.
- **Haiku on the same prompt found more, and found it consistently.** Its
  three runs found 8 each and agreed on 7 or 8 of them. Three Haiku runs
  together found 9 of 11 for $0.05. Two Sonnet runs together found 6 for
  $1.21.
- **The long prompt is not what finds the defects.** The 20-line prompt found
  6 on Sonnet, against today's 3 to 5. What the long prompt buys is the
  machinery around a finding: round budgets, carried findings, the
  population count, and the injection defences. Those are worth keeping for
  other reasons, but they are not where the catch rate comes from.
- **Two defects need code outside the diff.** `F28` and `F36` are defects in
  code the pull request did not change but now depends on. Only setups that
  can open files found them, and the diff-only setups never did. So a
  diff-only reviewer, which is what the cheapest products are, has a ceiling.
- **One defect was found by nothing.** `F10` is a test that cannot fail, and
  seeing it means imagining the mutation. No setup did, in any run.

### What else they raised

A setup that finds more by raising more is not better, so every finding that
matched no known defect was graded too. These were the findings from the
first Haiku run and the first Sonnet run. A separate Sonnet session read the
code for each and was not told which setup produced it:

| Setup | Extra findings | Real defect | Valid but minor | Wrong |
|---|---|---|---|---|
| CI prompt on Haiku | 15 | 7 | 8 | 0 |
| Today's reviewer | 9 | 3 | 6 | 0 |

Haiku's extra volume is not noise. About half its extra findings are real
defects nobody had recorded. Across the 11 pull requests, one Haiku run
surfaced 15 real defects (8 known and 7 new), and one Sonnet run surfaced 8
(5 and 3).

The grader called nothing wrong, against 7 of 40 in section 1's blind grade
of the live findings, so it is probably lenient. It was lenient to both
setups alike.

### The limits of this comparison

- 11 defects, all of them ones today's reviewer found first. That favours
  today's reviewer, and it still came last on catch rate.
- The replay handed every setup the diff as a file. In CI the reviewer has
  the changed-file list and reads the files itself. The input was the same
  for every setup, so the comparison is fair, but the absolute numbers may
  differ from CI's.
- Every run was round 1. No setup was tested on later rounds, where the
  carried-findings list changes what the reviewer is asked to do.
- The appendix lists every run's result per defect.

## 4. Who can run it, and who pays

### The three credentials

The generated job resolves one mode from what the repository holds, inside
`run:` so that a missing credential is reported rather than skipped
(`.claude/rules/config-access.md`):

| Mode | What the consumer needs | Who pays |
|---|---|---|
| Vertex | a Google Cloud project with Claude enabled, and `ci.vertex` in the rungate config; no stored key, Workload Identity Federation | the consumer's Google Cloud bill |
| Subscription | `CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token`; a Pro, Max, Ultra, Team or Enterprise plan | the subscriber's usage limits, shared with their own interactive use; the token belongs to the one person who made it |
| API key | `ANTHROPIC_API_KEY` | the consumer's Anthropic API bill |
| None | nothing | nobody: the job reports UNMEASURED and passes, unless `RUNGATE_REQUIRE_AI_REVIEW` is `true` |

The action also supports Bedrock, Foundry, and Anthropic's own workload
identity federation (`anthropic_federation_rule_id`, no stored secret). rungate's
job resolves none of them. If both an API key and a subscription token are set, the API key wins
and is billed (`pr-review-gate-tooling.md` §3).

So the default does not burn anyone's budget. A consumer who scaffolds and
adds no credential gets an annotation saying no review ran, and spends
nothing. The money is spent only once someone adds a credential, and then it
is their own.

### The Claude GitHub App

`anthropics/claude-code-action` needs a GitHub token. It takes one as the
`github_token` input. When that input is empty it exchanges the run's OIDC
token for a Claude GitHub App token (`setupGitHubToken` in the action's
`src/github/token.ts`, at the pinned commit), which only works if the **Claude
GitHub App is installed on the repository**. Anthropic's docs say the same:
"When omitted, the Claude Code GitHub Action authenticates as the Claude
GitHub App."

The App is shared by every Claude feature on GitHub, so installing it grants
its whole permission set, and GitHub does not allow a subset. That set
includes read and write on contents, issues, pull requests, checks, actions,
workflows, discussions, repository hooks and repository creation.

rungate's job passes no `github_token`, so every consumer must install the
App. Nothing in the review step needs those permissions. The reviewer has no
shell and writes one file outside the checkout, and the threads are posted by
a later rungate step with the job's own `GITHUB_TOKEN`. Passing the job's
token to the action skips the exchange entirely; the action's source shows a
provided token returned before any OIDC request. That is a change to the
generator, and it is tested before anyone relies on it.

### What the consumer is told

Nothing. `docs/guides/` has no page on the AI review: not the credentials,
not the App, not the cost, not the switch that makes a missing credential
fatal. A consumer finds out by reading the UNMEASURED annotation.

### The other options

From `pr-review-gate-tooling.md`, unchanged since: Anthropic's hosted Code
Review never blocks a merge and is for Team and Enterprise plans only, at
Anthropic's stated $15–25 per review. Of the non-Claude tools, CodeRabbit,
Qodo PR-Agent and Greptile can post a check that branch protection can
require; PR-Agent is open source and runs on the consumer's own model key.

## 5. CRC-M18

CRC-M18 says a diff larger than the reviewer's budget is still reviewed, with
its coverage stated as "n of m files read". Its proof was a live run of the
trial reviewer, which is being deleted. ADR-025 decides whether the real
reviewer adopts it or the criterion is retired; #2627 keeps the helpers it
names until then.

## Not measured

- How often the cheaper setups raise wrong findings. Section 3 measures
  whether they catch known-real defects and counts what else they raise; it
  does not grade the rest.
- Any consumer's real spend. No consumer has run the review with a
  credential yet.
- Whether passing `github_token` removes the App requirement end to end. It
  is read from the action's source and Anthropic's docs, not run.
- Anthropic's published code-review plugin (`code-review@claude-plugins-official`,
  the review workflow `/install-github-app` sets up). It reads the pull request
  from GitHub as it stands, and it stops on a closed one, so it cannot be
  replayed at the commit a defect was found on. Its bug agents read only the
  diff and are told not to flag "potential issues that depend on specific
  inputs or state". The diff-only setups in section 3 are the nearest measured
  stand-in.

## Appendix

### A. The 40 graded findings

Drawn with seed `20261121` from the 224 findings; graded before the author's response was joined.

| Finding | PR | File | Severity | Grade | Worth blocking | Author |
|---|---|---|---|---|---|---|
| F01 | #2622 | `specs/RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md` | medium | real | yes | acted |
| F02 | #2622 | `scripts/check-instruction-surface.ts` | low | minor | no | declined |
| F03 | #2614 | `scripts/ci-api-census.ts` | medium | minor | no | declined |
| F04 | #2608 | `lib/scaffold/steps.ts` | high | real | yes | acted |
| F05 | #2592 | `scripts/board-conformance.ts` | medium | real | yes | acted |
| F06 | #2593 | `test/ai-review-suppression.test.ts` | medium | real | yes | acted |
| F07 | #2593 | `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` | medium | minor | no | acted |
| F08 | #2590 | `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` | medium | minor | no | acted |
| F09 | #2543 | `test/ai-review-conventions.test.ts` | unlabelled | minor | no | acted |
| F10 | #2578 | `test/affected-tests.test.ts` | medium | real | yes | acted |
| F11 | #2572 | `lib/scaffold/consumer-intake-workflow.ts` | low | minor | no | declined |
| F12 | #2563 | `docs/research/first-pass-completeness-1764.md` | unlabelled | minor | no | acted |
| F13 | #2563 | `docs/research/first-pass-completeness-1764.md` | medium | minor | no | acted |
| F14 | #2553 | `lib/scaffold/write-steps.ts` | unlabelled | minor | no | acted |
| F15 | #2551 | `lib/rounds-to-pass.ts` | unlabelled | minor | no | acted |
| F16 | #2545 | `scripts/criterion-successor.ts` | unlabelled | minor | no | declined |
| F17 | #2534 | `scripts/criterion-successor.ts` | high | wrong | no | declined |
| F18 | #2518 | `lib/scaffold/write-steps.ts` | high | wrong | no | declined |
| F19 | #2518 | `lib/scaffold/write-steps.ts` | unlabelled | minor | no | acted |
| F20 | #2513 | `lib/board-init.ts` | high | real | yes | acted |
| F21 | #2513 | `lib/board-init.ts` | unlabelled | real | yes | acted |
| F22 | #2513 | `scripts/board-init.ts` | unlabelled | minor | no | acted |
| F23 | #2512 | `scripts/sync-sc-status.ts` | unlabelled | minor | no | acted |
| F24 | #2494 | `scripts/unaccounted-work.ts` | unlabelled | minor | no | acted |
| F25 | #2443 | `specs/sc-reservations.json` | unlabelled | wrong | no | declined |
| F26 | #2491 | `lib/install-integrity.ts` | unlabelled | real | no | acted |
| F27 | #2492 | `scripts/sync-sc-status.ts` | unlabelled | minor | no | declined |
| F28 | #2465 | `lib/scaffold/ai-review-findings.ts` | unlabelled | real | no | acted |
| F29 | #2454 | `docs/adr/ADR-023-rungate-makes-and-moves-a-consumers-board.md` | unlabelled | minor | no | acted |
| F30 | #2454 | `docs/adr/ADR-023-flow.html` | medium | minor | no | declined |
| F31 | #2454 | `docs/adr/ADR-023-rungate-makes-and-moves-a-consumers-board.md` | medium | minor | no | declined |
| F32 | #2476 | `.github/workflows/criterion-label.yml` | unlabelled | wrong | no | declined |
| F33 | #2475 | `.claude/rules/self-referential-tests.md` | unlabelled | wrong | no | acted |
| F34 | #2456 | `lib/git-dates.ts` | unlabelled | wrong | no | acted |
| F35 | #2450 | `evals/ai-review-control/README.md` | medium | minor | no | acted |
| F36 | #2450 | `evals/ai-review-control/control.ts` | unlabelled | real | yes | acted |
| F37 | #2447 | `scripts/board-conformance.ts` | unlabelled | real | no | acted |
| F38 | #2447 | `scripts/board-snapshot.ts` | unlabelled | minor | no | acted |
| F39 | #2439 | `scripts/board-snapshot.ts` | unlabelled | wrong | no | declined |
| F40 | #2412 | `docs/adr/ADR-021-flow.html` | medium | minor | no | acted |

### B. Which run found which defect

`X` found it; `.` did not. One judged call counted as a miss is marked `.*`.

| Defect | PR | Today's, run 1 | Today's, run 2 | Haiku, run 1 | Haiku, run 2 | Haiku, run 3 | Short, Sonnet | Diff only, Sonnet | Diff only, Haiku |
|---|---|---|---|---|---|---|---|---|---|
| F01 | #2622 | . | . | X | X | X | . | .* | X |
| F04 | #2608 | X | X | X | X | X | X | X | X |
| F05 | #2592 | X | X | X | X | X | X | X | X |
| F06 | #2593 | . | . | X | . | . | X | . | . |
| F10 | #2578 | . | . | . | . | . | . | . | . |
| F20 | #2513 | . | . | X | X | X | . | X | X |
| F21 | #2513 | . | X | X | X | X | . | X | X |
| F26 | #2491 | X | . | X | X | X | . | X | X |
| F28 | #2465 | X | . | . | X | X | X | . | . |
| F36 | #2450 | X | . | . | . | . | X | . | . |
| F37 | #2447 | . | . | X | X | X | X | . | . |
| **Found** | | 5 | 3 | 8 | 8 | 8 | 6 | 5 | 6 |
| **Cost per run** | | $0.615 | $0.591 | $0.017 | $0.016 | $0.015 | $0.545 | $0.235 | $0.006 |
