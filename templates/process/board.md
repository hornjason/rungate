---
argument-hint: "[milestone name]"
description: Show this repository's board on one screen — what is being worked, what is Ready next, progress against the plan, what shipped, and what needs the owner. Read-only
doc-type: reference
status: active
updated: 2026-11-19
---

Show this repository's board on one screen, in plain words. Everything comes
from the repository this command sits in, and it names no other.

## Rules

- **Read-only.** Never pass `--write`, never edit an issue, never pull. If the
  checkout is behind, say how far and read anyway.
- **Live sources only.** Every line comes from the commands below, never from
  memory of this session or from a status document's prose.
- **Run every command from this repository's root**, the directory that holds
  `.claude/commands/board.md`. Each one reads the repository from its origin
  remote, so a command run from another directory reads another repository.
- **Pass the token as shown.** The `rungate` commands read `GITHUB_TOKEN` and
  report UNMEASURED without it.
- **Report problems and anything needing the owner first**, in plain words,
  about 15 lines, no tables. Name an issue by number and a few words of what
  it does.

## Steps

Run 1–6 in parallel; they are independent.

1. **Tree:** `git fetch -q origin`, then `git rev-list --count HEAD..origin/HEAD`.
   A count above zero means everything below was read from a tree that many
   commits old. If `origin/HEAD` is not set, `git remote set-head origin --auto`
   sets it once.
2. **Lanes and plan:** `env -u GH_TOKEN GITHUB_TOKEN="$(env -u GH_TOKEN gh auth token)" {{CLI}} work-status`.
   Read what is being worked, the Ready lane, the open pull requests, every
   milestone, and the plan. With an argument, add `--milestone "$ARGUMENTS"`.
3. **Board health:** `env -u GH_TOKEN GITHUB_TOKEN="$(env -u GH_TOKEN gh auth token)" {{CLI}} board-conformance`.
   Count MET against SHORT, and name each SHORT reading in plain words.
4. **Phases:** `env -u GH_TOKEN GITHUB_TOKEN="$(env -u GH_TOKEN gh auth token)" {{CLI}} board`.
   Each phase's open issues and what blocks them.
5. **Recently shipped:** `gh pr list --state merged --limit 15 --json number,title,mergedAt`.
   Keep the ones merged in the last 24 hours.
6. **Unaccounted:** `gh issue list --label needs-criterion --state open --limit 200 --json number,title,createdAt`.
   Count them and name the oldest. These are open issues that name no
   criterion and do not say they serve none. The count should equal
   `criteria-named`'s short figure from step 3; if it does not, say so as a
   problem.

## Output

```
Needs you: <decisions only the owner can make, one line each — or "nothing">
Problems:  <anything SHORT, red, stuck or UNMEASURED — or "none">

Working on now:  #N what it does (PR #M, CI state) …
Ready next:      #N what it does …
Progress:        <what the plan has left>; board <m> of <n> checks met
Unaccounted:     <n> issues name no criterion (oldest #N, <age>) — or "none"
Shipped (24h):   #N, #N, … — one line
Tree:            <current | N commits behind>
```

Then step 4's output verbatim in a fenced `text` block, and one line offering
to go deeper on any of it.

## What counts as "needs you"

Only decisions the repository's own rules reserve for its owner: writing
criterion text, merging an ADR, changing the plan, renaming or closing a
milestone, anything a review round left for them, and an issue a session
parked for them. Work that is waiting for CI is not theirs.
