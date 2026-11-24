---
doc-type: reference
status: active
updated: 2026-11-14
---

# How GitHub behaves under this board — measured, with the command beside each

Moved out of agent memory by #1951. Each of these was load-bearing and lived
only in a session's private notes, where nobody could audit it. One had
already gone stale there: the required-check list below gained
`closing-references` after the note was written. A fact with no command
beside it cannot be re-taken, so every section names the command.

## Blocked-by search matches the link; `is:blocked` matches an open blocker

Measured 2026-11-14 against this repository's open issues:

```bash
# Ground truth: blockers counted per issue (GraphQL only; `gh issue view --json` lacks it)
gh api graphql -f query='query{repository(owner:"hornjason",name:"rungate"){issues(states:OPEN,first:100){nodes{number issueDependenciesSummary{blockedBy totalBlockedBy}}}}}'
# The qualifiers, in advanced search
gh api graphql -f query='query{search(type:ISSUE_ADVANCED,first:1,query:"repo:hornjason/rungate is:issue is:open no:blocked-by"){issueCount}}'
```

| Reading | Count | What it tracks |
|---|---|---|
| open issues | 76 | |
| `totalBlockedBy > 0` (any blocker linked) | 44 | the link |
| `blockedBy > 0` (an open blocker) | 40 | readiness |
| `has:blocked-by` | 44 | the link |
| `no:blocked-by` | 32 | the link — hides #1951, #1952, #2045 and #2082, whose blockers have all shipped |
| `is:blocked` | 40 | an open blocker |
| `-is:blocked` | 36 | includes the four above |

So `is:open no:blocked-by` hides an issue for ever once anything has been
linked to it, including a blocker that shipped. `is:open -is:blocked` does
not. First measured 2026-10-28 against `LucasDesenvGit/financas-local`, when
this repository had no edges to measure on; `is:blocked` was not part of that
reading.

**Only advanced search applies these qualifiers.** Two other search
interfaces ignore them. On the same day, both returned 76 (every open issue)
for `has:blocked-by` and for `no:blocked-by`, and 0 for `is:blocked`:

```bash
# REST search
gh api -X GET search/issues -f q='repo:hornjason/rungate is:issue is:open no:blocked-by' -q .total_count
# GraphQL, the non-advanced search type
gh api graphql -f query='query{search(type:ISSUE,first:1,query:"repo:hornjason/rungate is:issue is:open no:blocked-by"){issueCount}}'
```

Swap `no:blocked-by` for `has:blocked-by` or `is:blocked` to take the other
two readings.

## This repository's branch protection, read live

```bash
gh api repos/hornjason/rungate/branches/main/protection
```

Read 2026-11-14: required checks are exactly `ai-review`,
`closing-references` and `test`; `strict: false`; `enforce_admins: true`;
`required_conversation_resolution: true`; no required pull-request reviews,
so `review` is not a required check. The endpoint needs admin on the
repository, which the default Actions token does not have.

## A conflicted pull request runs no `pull_request` workflow

GitHub's own words, from *Events that trigger workflows* → `pull_request`:
"Workflows will not run on `pull_request` activity if the pull request has a
merge conflict. The merge conflict must be resolved first." The event builds
`refs/pull/<N>/merge` and runs against that merge commit, so a pull request
GitHub reports as `DIRTY` has no merge commit to run on, and its checks
simply never start. That looks the same as a queue that has not picked them
up yet. Rebase first, then read the checks.
(forge-behaviour: dirty-pull-request-runs-no-checks)

To take the reading on any pull request whose checks have not started:

```bash
gh pr view <N> --json mergeable,mergeStateStatus   # CONFLICTING / DIRTY means no run is coming
gh pr checks <N>                                    # empty while it stays conflicted
```
