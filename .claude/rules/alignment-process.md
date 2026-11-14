---
description: The four-step process — an agreement is not real until it is an issue
paths:
  - "docs/adr/**"
generated-sha: b95f58fac83878fb
---

## An agreement is not real until it is an issue

1. Agree and file one issue the same turn, naming its files.
2. Bigger than one issue, or a rule or gate change: an ADR from `docs/adr/TEMPLATE.md`, its criteria in the spec, and `/dry-run` until the repository owner agrees; the owner merges it.
3. On merge, `.github/workflows/adr-accepted.yml` places the plan on the tracker.
4. Each pull request says `Fixes #N`; `closing-references` refuses one that closes no issue, or whose issue names no criterion nor `serves no criterion`.

**Exempt.** Step 1 skips work that decides the issues — an ADR, a retro, a review, an audit — as its pull request closes the issue it was filed under. Step 4 skips a pull request whose files are all `project-state.json`, `PROJECT-STATE.md` and `SUCCESS.md`: the diff decides, never the branch name.

Steps 3 and 4 are enforced: `adr-accepted.yml` places an accepted ADR's plan,
and `closing-references` is the check that refuses a pull request breaking
step 4. Steps 1 and 2 are yours.
