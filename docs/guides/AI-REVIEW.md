---
doc-type: guide
governs: what the generated AI review job needs to run, who pays for each credential, and what a pull request costs
created: 2026-11-22
status: active
updated: 2026-11-22
---

# The AI review: what it needs, who pays, what it costs

`rungate scaffold` writes `.github/workflows/ai-review.yml`. On a pull
request it asks Claude to review the change, posts what it finds as review
threads, and fails the check on a blocking finding. This page says what the
job needs to run, who pays for it, and what a pull request costs.

## Nothing is spent until you add a credential

With no credential, no review runs and nothing is spent. The job writes a
warning saying the review is UNMEASURED, and the check passes. A tree with no
credential has not passed a review; it has not had one, and the warning says
so.

To make a missing credential fail the check instead, set the repository
variable `RUNGATE_REQUIRE_AI_REVIEW` to exactly `true`. No other spelling
turns it on.

## The credentials, in the order the job tries them

The job resolves one mode and hands the review action only that credential.
The first row that applies wins.

| Mode | What you set | Who pays |
|---|---|---|
| `vertex` | `ci.vertex` in `.claude/rungate/config.json`: a Google Cloud project with Claude enabled and a Workload Identity Federation provider. No key is stored anywhere. | your Google Cloud project's bill |
| `oauth` | the repository secret `CLAUDE_CODE_OAUTH_TOKEN`, made with `claude setup-token` on a Claude subscription | the usage limits of the person whose subscription made the token, shared with their own use of Claude |
| `api-key` | the repository secret `ANTHROPIC_API_KEY` | your Anthropic API bill |
| `none` | nothing | nobody: no review runs and nothing is spent |

- `ci.vertex` is read when the workflow is generated. When it is set, the job
  reviews on Vertex and does not look at either secret.
- When both secrets are set, the subscription token is used and the API key
  is never handed to the action.
- A subscription token belongs to the one person who made it. Every review on
  the repository spends that person's limits, whoever opened the pull request.
- No Claude GitHub App is needed. The job gives the action its own
  `GITHUB_TOKEN`, and a later step posts the threads with it.

## What a pull request costs

The default model is `claude-haiku-5-5`, and each round is several reviewer
runs whose findings are merged into one set, duplicates removed. A round runs
when a pull request opens and again on every push to it.

| Measure | Figure | Source |
|---|---|---|
| Per run on `claude-haiku-5-5` | $0.016 | `docs/research/ai-review-audit.md`, section 3 |
| Runs per round | 3 | `AI_REVIEW_RUNS` in `lib/scaffold/ai-review-step.ts` |
| Per round | $0.05 | the two above |
| Rounds per pull request | 2.7 | this repository's mean, 2026-11-14 to 2026-11-22, audit section 2 |
| Per pull request | $0.13 | the three above |

- The per-run figure is the action's own cost report, at Anthropic's list
  price. Vertex bills the same tokens at Google Cloud's rate for the model.
- On a subscription there is no per-token bill. The runs count against the
  token owner's usage limits instead.
- Rounds per pull request is this repository's figure. A team that pushes more
  often to each pull request runs more rounds.
- A Vertex consumer can name another model in `ci.vertex.model`, as an exact
  model id, and pays that model's price. The same audit measured Sonnet 5 at
  about $0.70 a run.

## Related

- `docs/research/ai-review-audit.md`: the measurements behind every figure here
- `docs/adr/ADR-025-where-the-ai-review-runs-and-who-pays.md`: why the default is Haiku 5.5, three runs a round, and no GitHub App
- `.claude/rules/config-access.md`: why a missing credential is reported, never skipped
