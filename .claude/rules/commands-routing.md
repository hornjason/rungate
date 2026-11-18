---
description: Every command the rungate CLI exposes in this project, generated from its command registry
generated-sha: 8547526ee7e5d530
---

## Command Routing

Generated from the CLI's command registry. Run one as
`bun bin/rungate.ts <command>`; `--help` prints its arguments.

| Command | What it does |
|---------|--------------|
| `scaffold` | Generate or refresh a project's agent files, rules and conformity suite |
| `create-spec` | Create a spec file with the required frontmatter |
| `create-success` | Seed SUCCESS.md — what this project is for, and the claims that prove it |
| `create-sc` | Generate a matchable success-criterion line from a registered pattern |
| `convert-spec` | Convert an existing document into a testable spec |
| `audit-specs` | Report which success criteria are matched, unmatched or uncovered |
| `audit-spec-evidence` | Refuse a ticked criterion that does not name what proved it |
| `plan-spec` | Derive a repository's milestones from a spec's Phase placement table |
| `criterion-inventory` | Trace every criterion to the tests, issues and pull requests that name it |
| `board-mirror` | Show every spec's criteria, and what is ready to pick up, on the project board |
| `board-conformance` | Whether the board says what the spec says, reading by reading |
| `plan-issues` | Apply an approved issue plan: --decompose files issues, --repair links and demotes them |
| `consumer-triage` | Give each consumer-filed issue with no verdict one: duplicate, placed, overlaps or active |
| `board-scope` | Spec criteria and opt-in, with looks-done hints |
| `plan-deps` | Write a spec's phase order onto the tracker as blocked-by edges |
| `board-ready` | Move the work a closed blocker freed, or the top of the backlog, into the board's Ready lane |
| `board-id` | Print the board's node id from config |
| `ci-reading` | Print a merged pull request's CI breakdown — per-check time, queue, critical path, re-runs |
| `board-intake-move` | Move a board item to a column, verified in the item and in the board's search index |
| `unaccounted-work` | Report undone work declared in a repository's prose that no open issue covers |
| `intake` | Run each intake source and print its reading, MEASURED or UNMEASURED |
| `audit-closing-references` | Refuse a pull request whose closing reference GitHub will not act on, or that closes no issue |
| `sync-spec-tests` | Regenerate the conformity suite from the specs |
| `generate-code-map` | Regenerate CODE-MAP.md from the source tree |
| `extract-constraints` | Extract constraints from a project's docs into agent rules |
| `finding-promotion` | Turn a review finding that names real work into a spec criterion |
| `claim-files` | Claim the files an issue will change, so parallel agents do not collide |
| `ai-review-findings` | Adjudicate an AI review's findings payload — exits non-zero on a blocking finding |
| `ai-review-threads` | Post an AI review's findings onto the pull request's diff as review threads |
| `record-ai-review-unmeasured` | Record WHICH kind of unmeasured each unmeasured AI-review round was |
