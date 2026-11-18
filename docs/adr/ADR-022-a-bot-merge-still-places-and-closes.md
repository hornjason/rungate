---
doc-type: adr
status: proposed
created: 2026-11-18
updated: 2026-11-18
---

# ADR-022 — A merge made by automation still places the plan and closes its issues

## Status

**Proposed, 2026-11-18.** Jason chose the route on 2026-11-18: rungate's own workflow handles a merge made with `GITHUB_TOKEN` (option B on #2337), rather than asking every consumer for a PAT or a GitHub App. Still open: the two criterion texts in *Criteria*, which are his to accept or edit, and his merge.

## Context

Measured in asaCommandCenter on rungate 0.8.26, 2026-11-17 (#2337):

- **A merge made with `GITHUB_TOKEN` starts no workflow.** GitHub creates no run for an event that token causes; only `workflow_dispatch` and `repository_dispatch` are exempt. The consumer's own auto-merge workflow merges green pull requests with that token.
- **So `adr-accepted.yml` never ran for a bot-merged ADR.** asaCommandCenter#2056 (ADR-055, `status: accepted`) was merged by `app/github-actions`, and its 22 issues and 6 links had to be filed by hand with `plan-issues --decompose --write`.
- **Closing keywords did not act either.** asaCommandCenter#2083 and #2085 were merged by `app/github-actions`, and the issues they name stayed open until closed by hand. The control: #2088 and #2090 were merged by a person and closed theirs on merge.
- **Today's trigger cannot see it.** `adr-accepted.yml` runs on `push` to main under `docs/adr/**` and reads `github.event.before` (`plan-issues --accepted-since "$BEFORE"`). A `pull_request: [closed]` trigger has the same blind spot.
- **The pieces exist.** `plan-issues --decompose` is idempotent: it keys on open issue titles, so re-running it over an already-placed ADR files nothing. `linkedIssuesInThisRepo` in `lib/closing-reference-audit.ts` already reads a pull request's `closingIssuesReferences`, the links GitHub records even when it does not act on them.

## Decision

A consumer names its merge workflow in `board.mergeWorkflow`. The generated `adr-accepted.yml` then also runs when that workflow completes, and it does two things a person's merge would have caused. It places every ADR accepted since the last commit it placed. And it closes each still-open issue that a pull request merged by automation declares as closed. A consumer with no merge workflow configured changes nothing.

## Decisions

1. **Rungate's workflow handles the bot merge, not a consumer secret — Jason, 2026-11-18 (option B on #2337).** A PAT or App token is a credential every consumer must mint, rotate and scope, and the failure when it lapses is the same silent one.
2. **The trigger is `workflow_run` on the named merge workflow — recommended.** A `workflow_run` event is created even when the triggering run's own events were not, so it is the one event that follows a `GITHUB_TOKEN` merge. Its name comes from config, because rungate cannot guess a consumer's workflow name, and `scaffold` emits the trigger only when the key is set.
3. **The range is "since the last commit this workflow placed" — recommended.** A `workflow_run` carries no `before` sha. The job reads the head sha of the last successful `adr-accepted.yml` run on main and passes it to `--accepted-since`. When there is no such run, or it cannot be read, the job refuses UNMEASURED rather than guess a range. Because the planner is idempotent, overlapping ranges from the push trigger and this one file nothing twice.
4. **Only issues a merged pull request declares are closed — recommended.** The job closes an issue only if it is in the pull request's `closingIssuesReferences`, still open, and in this repository. It comments with the pull request's number. A mention in prose closes nothing, and an issue a person reopened after the merge is not closed again.
5. **The command ships before the workflow calls it** (RELEASING.md, "A command a generated workflow calls ships BEFORE the workflow that calls it"). The closing command is its own row, and the row that wires it into the workflow waits for it and for a release.

## Not decided here

- **Consumers whose merge is not a workflow** (a person, the merge queue, an external bot) are unaffected; their merges already start workflows.
- **Which repositories set `board.mergeWorkflow`** is each consumer's choice. asaCommandCenter's is `approve-on-green`.
- **rungate's own repository** sets nothing. Its auto-merge is GitHub's native one, whose merges start workflows.

## Criteria, proposed wording (Jason's to accept or edit)

**SC-2787, new:**

> When `board.mergeWorkflow` names a consumer's merge workflow, the generated `adr-accepted.yml` also runs on that workflow's `workflow_run` completion, and places every ADR accepted since the head of its own last successful run on main. With no such run it refuses UNMEASURED rather than guess a range.

**SC-2788, new:**

> A pull request merged into main by automation closes the issues it declares: each issue in its `closingIssuesReferences` that is still open, in this repository, and was not reopened after the merge is closed with a comment naming the pull request. An issue the body only mentions is never closed.

## Decomposition

Each row serves a criterion in specs/SPEC-TO-BOARD-PIPELINE-SPEC.md. SC-2787 and SC-2788 are reserved to this branch in specs/sc-reservations.json, and their lines are written in the spec by this ADR's pull request.

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| SC-2787 | adr-accepted also runs when the named merge workflow completes | lib/scaffold/adr-accepted-workflow.ts, .github/workflows/adr-accepted.yml, lib/config-readers.ts, test/adr-accepted-workflow.test.ts, test/board-merge-workflow.test.ts, specs/SPEC-TO-BOARD-PIPELINE-SPEC.md | Engine Phase 10 — the payload ships | — |
| SC-2788 | close-merged-references closes the issues a bot-merged pull request declares | scripts/close-merged-references.ts, lib/closing-reference-audit.ts, lib/cli-commands.ts, test/close-merged-references.test.ts, specs/SPEC-TO-BOARD-PIPELINE-SPEC.md | Engine Phase 10 — the payload ships | — |
| SC-2788 | The generated workflow closes a bot merge's declared issues | lib/scaffold/adr-accepted-workflow.ts, .github/workflows/adr-accepted.yml, test/adr-accepted-workflow.test.ts | Engine Phase 10 — the payload ships | adr-accepted also runs when the named merge workflow completes, close-merged-references closes the issues a bot-merged pull request declares |
