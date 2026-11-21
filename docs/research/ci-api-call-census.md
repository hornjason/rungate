---
doc-type: research
status: active
owner: jason
updated: 2026-11-21
governs: "#2596's count of the external API calls this repository's CI makes, taken 2026-11-21 from real runs and counted stubs"
---

# What CI calls, counted

Jason, 2026-11-21: *"we shouldn't be spamming API endpoints if we can find a
better method to batch."* RepoRails was the case he could see: 33 calls a run.
Nobody had counted the rest. This counts them, from what runs recorded about
themselves, never from an estimate.

**The answer, in four lines:**

1. **The two AI reviewers are the cost.** Every pull-request push runs both:
   about 45 model requests and $1.43 a push, about $47 a day. Half of it is
   `claude-review.yml`, a trial whose issue (#630) closed on 2026-10-18.
2. **The test suite is the biggest GitHub caller.** 144 external calls a CI
   run, about 6,500 a day, and two-thirds of them come from one test:
   `test/stage-ladder.test.ts`, which runs every done item's verify command,
   nine of which read the whole board again.
3. **The pinned status issue is the busiest workflow.** 145 runs a day, 106 of
   them cancelled after checking out and installing; each finished one makes
   21 GitHub calls to render.
4. **RepoRails is fixed.** 33 calls a run before #2608; 0 on the first pull
   request run after it (`RepoRails cache: 33 from cache, 0 checked`).

## How it was counted

Two taps write one line per HTTP request into a record, and
`scripts/ci-api-census.ts` counts the record. Neither guesses.

- `scripts/api-call-tap.ts`, a Bun preload, wraps `fetch` — which Octokit and
  every hand-rolled reader here go through — and names the file that asked.
- `bun scripts/ci-api-census.ts --install-gh-tap <dir>` writes a `gh` that runs
  the real one with `GH_DEBUG=1` and moves gh's `* Request to …` lines into the
  record. A `--paginate` is counted page by page.
- A record with no start line is UNMEASURED, never zero.

The reviewers' model requests are read from the result the review action prints
when it finishes (`num_turns`, one request each, and `total_cost_usd`), with
`--model`. How often each workflow ran is read from the Actions API's own list,
with `--runs`.

## How often each workflow runs

`bun scripts/ci-api-census.ts --runs` over the 629 runs created between
2026-11-20T19:00Z and 2026-11-21T19:00Z:

```text
629 runs across 20 workflows
   145  Status — rewrite the pinned "where we are" issue  (issues cancelled 25, push cancelled 15, workflow_run cancelled 66, workflow_run success 39)
    55  Closing references  (pull_request failure 1, pull_request success 54)
    51  AI Review  (pull_request failure 4, pull_request success 32, push success 15)
    51  AI Review Unmeasured  (workflow_run success 51)
    50  Board — one decider writes every lane  (issues success 24, pull_request_target success 26)
    50  CI  (pull_request cancelled 5, pull_request failure 4, pull_request success 26, push failure 1, push success 14)
    50  Gates  (pull_request success 35, push success 15)
    36  Claude review (trial)  (pull_request cancelled 3, pull_request success 32, workflow_dispatch success 1)
    31  Board — keep Ready full from the events the repo already emits  (issues success 31)
    24  Board — reconcile every card against GitHub  (issues success 24)
    21  Criterion label  (issues success 20, schedule success 1)
    17  Board intake  (issues success 6, pull_request_target success 11)
    15  Board conformance — does the board say what the spec says?  (push failure 4, push success 11)
    15  Intake — fix commits  (push success 15)
     7  Consumer issues — give each one a triage verdict  (issues success 6, schedule success 1)
     7  Specs changed — run every opted-in family through the engine  (push failure 2, push success 5)
     1  ADR accepted — place its plan on the board  (push success 1)
     1  Issue closure audit  (schedule success 1)
     1  Phase order — re-link on a milestone change  (issues success 1)
     1  Release  (push success 1)
```

## Calls per run

| Workflow | Runs that day | External calls per run | Source of the per-run figure |
|---|---|---|---|
| AI Review (pull request) | 32 finished | **28.7 model requests**, $0.70 (20–37) | 7 runs' own results: 44922678250, 44924125072, 44924797507, 44927310138, 44934891489, 44935752742, 44938696518 |
| AI Review (push) | 15 | 0 model requests | 5 runs' logs: none printed a result |
| Claude review (trial) | 33 finished | **15.9 model requests**, $0.73 (5–27) | 12 runs' own results: 44917545546 … 44938696475 |
| CI (four shards together) | 45 finished | **144**: 81 GitHub GraphQL, 51 GitHub REST, 12 npm registry | the taps, in one run of all four shards: 44944260453 (#2611, a diagnostic never merged) |
| Status — the pinned issue | 39 finished, 106 cancelled | **21 GitHub** to render; the publish was not run, because it writes | the taps, `status-view.ts --markdown` run locally against the live repository |
| Board conformance | 15 | **6 GitHub** | the taps, locally |
| Gates | 50 | **3 GitHub** (the conformity suite), 0 for spec evidence | the taps, locally |
| Closing references | 55 | **1 GitHub** | the taps, the job's own two commands run locally against PR #2610 |
| Criterion label | 21 | **1–2 GitHub** per step | the taps, each step as a dry run |
| Intake — fix commits | 15 | **0** | the taps, locally |

**Not measured, named rather than guessed:**

- **The four board-writing workflows** — board flow (50 a day), keep Ready full
  (31), reconcile every card (24), board intake (17). Each reads and writes the
  project board, which needs `RUNGATE_PROJECT_TOKEN`; a session does not hold
  it, and their write paths are not runs to take from a laptop.
- **The AI review's GitHub side and AI Review Unmeasured (51 a day)** — they
  post threads and records, so a local run would write.
- **Package downloads.** Every `bunx rungate@<pin>` downloads the package, and
  `bun install` resolves the lockfile, through Bun's native installer, which no
  `fetch` tap sees. The suite's own `fetch`es to the npm registry are counted.

## The three biggest, and what to do about each

### 1. Two AI reviewers on every push — about $47 a day

At the day's counts: AI Review 32 × 28.7 ≈ 918 model requests and 32 × $0.70
≈ $22; the Claude review trial 33 × 15.9 ≈ 525 requests and 33 × $0.73 ≈ $24.

- **End the trial, or make it on-demand.** `claude-review.yml` is hand-written,
  comments only, gates nothing, and the issue it was trialled under closed on
  2026-10-18. Switching it to `workflow_dispatch` removes about half the model
  spend with no change to what blocks a merge. **This is Jason's call** —
  it is his trial and his billing.
- **#1885 (five reviewer passes a round) multiplies the first line.** At 28.7
  requests and $0.70 a pass, five passes plus the merge call is about 150
  requests and $3.50+ a round, about $90–100 a day more at today's volume.
  Approved on 2026-11-21 before these figures existed; worth re-reading
  against them before it is built.

### 2. The test suite — 144 calls a run, 96 of them from one test

Counted with both taps in one CI run of all four shards, every shard green
(run 44944260453); the run before the attribution was added recorded the same
total (44942338089). 145 lines were recorded; one was this PR's own test planting a stand-in request,
fixed here, so a run makes 144. By the file that made them:

```text
   96  test/stage-ladder.test.ts            80 GraphQL (gh) + 16 milestone reads
   10  test/harness-fixed-point.test.ts     repository, branch, protection, secret and variable reads
    8  test/active-workflow.test.ts         4 of them about a repository that does not exist
    8  test/sync-sc-todo-outranks-comment.test.ts   the same
    6  test/distribution-currency.test.ts   npm: the published version and its tarball
   16  nine more files, 1 to 3 each
```

At 45 finished CI runs a day that is 144 × 45 ≈ 6,480 calls.

- **Read the board once per ladder run (#2612).** The ladder runs each done
  item's verify command in turn, and nine of them run `board-conformance
  --produce`, each reading the whole board again. One snapshot, handed to all
  nine, removes most of the 96 — and makes the nine readings describe one
  moment instead of nine.
- **Stop asking GitHub about repositories that do not exist (#2613).** Four
  tests send 12 requests a run to `/repos/o/r` and `/repos/test/repo` on the
  real API and pass on whatever it answers.
- **The npm reads stay.** The distribution tests read the published package on
  purpose — that is what they check — and 12 requests a run to a CDN is not
  the problem.

### 3. The pinned status issue — 145 runs a day

One issue event fans out: `status-issue.yml` runs on the event itself and again
when each of the three board workflows that the same event started completes.
`cancel-in-progress` then cancels most of them — 106 of 145 — after each has
done a full-history checkout (`fetch-depth: 0`) and a `bun install`. The run
that survives makes 21 GitHub calls to render: 17 GraphQL requests through
`gh` (12 from `scripts/status-view.ts`, 5 from `lib/live-issues.ts`) and 4
REST reads.

- **Stop triggering on `issues` and on board-workflow completion separately.**
  Either is enough to see the change; both start the same render two to four
  times.
- **Batch the render's GraphQL reads.** Most are one question each about the
  same repository; GraphQL lets one request carry several.
- **Skip the publish when the body is unchanged.** The publish already reads
  the pinned issue's body to find it.

## What was found on the way

- **Four tests ask the real GitHub API about repositories that do not exist.**
  12 requests a run, each case passing on GitHub's answer for a missing
  repository (#2613).
- **A cold runner read RepoRails as broken.** The probe's 5-second budget
  killed the CLI's first-run install; fixed in #2610.
- **`BUN_OPTIONS="--preload <path>"` breaks `bun test`.** With a space, Bun
  1.3.14 reads the path as the script to run and `bun test` answers
  `Script not found "test"`. `tapBunOptions` spells it `--preload=<path>`, and
  `test/ci-api-census.test.ts` runs `bun test` under it.

## How to repeat it

```bash
# 1. How often each workflow ran, in a fixed window
gh api --paginate "repos/hornjason/rungate/actions/runs?created=<from>..<to>&per_page=100" \
  --jq '.workflow_runs[] | {id, name, event, conclusion, created_at}' > runs.jsonl
bun scripts/ci-api-census.ts --runs runs.jsonl

# 2. The reviewers' model requests, from their job logs
bun scripts/ci-api-census.ts --model <ai-review job logs>…

# 3. Any command's GitHub and other calls, run through both taps
bun scripts/ci-api-census.ts --install-gh-tap /tmp/gh-tap
echo API-TAP-START > /tmp/rec.log
PATH="/tmp/gh-tap:$PATH" BUN_OPTIONS="--preload=$PWD/scripts/api-call-tap.ts" \
  RUNGATE_API_TAP=/tmp/rec.log bun scripts/status-view.ts --markdown --repo hornjason/rungate
bun scripts/ci-api-census.ts /tmp/rec.log
```

For the suite in CI, the same two taps were turned on through the suite job's
own extension point, `scripts/ci-setup.sh`, on a diagnostic branch, and each
shard printed its record when `bun test` finished; the census then read the
four job logs.

## Follow-ups

| Caller | What happens next |
|---|---|
| The Claude review trial | **Jason's call**: keep it, make it on-demand, or end it. About $24 a day; its issue closed 2026-10-18. |
| #1885, five reviewer passes a round | Approved 2026-11-21, not started. About $90–100 a day more at today's volume; worth re-reading against these figures first. |
| The stage ladder's nine board readings | #2612 |
| Four tests that reach the real API with made-up repositories | #2613 |
| The pinned status issue's fan-out and its 21-call render | Not filed. It moves no SUCCESS.md claim — it is cleanup — and the filing gate refuses an issue that names none, rightly. Ready to build the moment Jason asks for it. |
| The four board-writing workflows, unmeasured | Not filed. Counting them needs the project token in a run, the way the suite was counted here: the same two taps, turned on for one run. |
| RepoRails | Done: #2608 and #2610. |
