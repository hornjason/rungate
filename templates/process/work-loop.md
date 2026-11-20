---
argument-hint: "[issue number]"
description: Work one issue from the Ready lane to a merged pull request — claim it, branch off the default branch, test first, open a pull request that closes it, and merge pinned to its head
doc-type: reference
status: active
updated: 2026-11-19
---

Work one issue to a merged pull request. With an argument, work issue
**$ARGUMENTS**; without one, take the top of the Ready lane. Every command
runs from this repository's root and reads the repository from its origin
remote.

## Rules

- **Start only what Ready holds**, and only an issue nobody is assigned to.
- **Never work in the primary checkout.** Another session may be in it.
- **The test comes first, and it has to fail** for the reason the issue
  describes before you write the change.
- **Let the pull request close the issue.** Never close it by hand.
- **Merge pinned to the head you checked**, and check again after the merge.

## Steps

1. **Pick:** `env -u GH_TOKEN GITHUB_TOKEN="$(env -u GH_TOKEN gh auth token)" {{CLI}} work-status`.
   Take the top of its Ready lane, or the issue you were given. Read the
   issue: it names the files it will change and how we will know it worked.
2. **Claim:** `gh issue view <N> --json assignees`; if nobody holds it,
   `gh issue edit <N> --add-assignee @me`.
3. **Branch:** `git fetch -q origin`, then
   `git worktree add -b <branch> ../<worktree> origin/HEAD`, and do the rest
   inside that worktree. If `origin/HEAD` is not set,
   `git remote set-head origin --auto` sets it once.
4. **Test first:** write the test the issue's "How we will know" asks for,
   run `{{TEST_COMMAND}}`, and see it fail for the right reason. Commit it.
   Then make the change and run `{{TEST_COMMAND}}` until it passes. This is
   the command CI runs (`dev.testCmd` in the rungate config, or what scaffold
   found in the project); if it is wrong, set `dev.testCmd` and re-scaffold.
5. **Pull request:** push the branch, then
   `gh pr create --title "<what it does>" --body-file <file>`. The body says
   `Fixes #<N>` on its own line, and what you broke to see the test fail.
6. **Merge pinned:** `env -u GH_TOKEN GITHUB_TOKEN="$(env -u GH_TOKEN gh auth token)" {{CLI}} verify-merge-ref --pr <PR>`
   prints the head to pin. Arm the merge with that head:
   `gh pr merge <PR> --squash --auto --match-head-commit <sha>`.
   A review thread blocks the merge: push the fix, arm again, then reply and
   resolve.
7. **Wait for it:** `--auto` only arms the merge; it happens when CI passes.
   `gh pr checks <PR> --watch --fail-fast` waits, and the first red check
   ends the wait: fix it, push, and pin again from step 6. Go on only once
   `gh pr view <PR> --json state` says `MERGED`.
8. **Check after the merge:** `env -u GH_TOKEN GITHUB_TOKEN="$(env -u GH_TOKEN gh auth token)" {{CLI}} verify-merge-ref --pr <PR> --after-merge`.
   Only when it passes, remove the worktree with `git worktree remove ../<worktree>`.

## Done means

The pull request is merged, `verify-merge-ref --after-merge` passed, the
issue was closed by the merge, and the worktree is gone.
