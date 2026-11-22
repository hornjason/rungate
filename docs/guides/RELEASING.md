---
doc-type: guide
status: active
updated: 2026-11-14
---

# Releasing rungate

Everything here was learned by getting it wrong. `.github/workflows/release.yml`
already explains **why** each guard in the pipeline exists, at length. What was
never written down is the **sequence** — and the sequence is what fails, because
three of its steps are counter-intuitive and none of them is enforced.

On 2026-11-04 (v0.8.11) and again on 2026-11-13 (v0.8.18), a release was cut,
failed, and had to be re-cut under a new version number. Every cause is below.

## The sequence

Do these in order. Every step below has failed at least once when it was
skipped or reordered. `X.Y.Z` is the version you are cutting. `<T>` stands for
`env -u GH_TOKEN GITHUB_TOKEN="$(env -u GH_TOKEN gh auth token)"`. It is for
the `bun` scripts, which read `GITHUB_TOKEN`, a variable a shell does not
normally set; without it they come back UNMEASURED. Plain `gh` commands use
gh's own login and need no prefix.

Run one numbered step at a time. Any step with more than one command runs
inside `( set -euo pipefail … )`. So a failure stops that step and nothing
after it runs. An `exit` leaves only the subshell, never your terminal. Keep
the wrapper when you copy a step.

```bash
# 0. File the release issue. The release PR must say `Fixes #N`, or
#    closing-references refuses it. File from ~/Projects/rungate, without
#    --repo. The body needs the sections the filing gate asks for and the line
#    "This serves no criterion: a release." #2195 is a worked example.

# 1. What the registry serves now = PUBLISHED below
npm view rungate version

# 2. Branch off main in a worktree (never the primary checkout), and install
( set -euo pipefail
  git -C ~/Projects/rungate fetch -q origin
  git -C ~/Projects/rungate worktree add -b rg/release-XYZ ~/Projects/rg-wt-rel-XYZ origin/main
  cd ~/Projects/rg-wt-rel-XYZ && bun install --frozen-lockfile )

# 2b. The pre-flight, IN that worktree: the red that costs a version number
#    if found after tagging. It reads the LIVE board and must run on
#    the tree being released; the primary checkout can be far behind (#2207).
#    If it is red, nothing is tagged and nothing is spent: fix the board and
#    re-run only this line. The worktree from the block above stays.
(cd ~/Projects/rg-wt-rel-XYZ && <T> bun test test/stage-ladder.test.ts)

# 3. In the worktree: bump, standing line, pins. Steps 3 to 6 each cd into
#    it, because a cd inside one step's subshell does not carry to the next.
#    package.json  "version": "X.Y.Z"
#    SUCCESS.md    - **Distribution standing (<today>)** — tree `X.Y.Z`, published `rungate@<PUBLISHED>`.
( set -euo pipefail
  cd ~/Projects/rg-wt-rel-XYZ
  bun bin/rungate.ts scaffold . --fix   # moves every `bunx rungate@` pin
  git status --short )                  # only package.json, SUCCESS.md, .github/workflows/*;
                                        # `git checkout --` anything else (CODE-MAP.md churns)

# 4. Census
(cd ~/Projects/rg-wt-rel-XYZ && bun scripts/census-routing.ts)   # prints a `bun test …` line; run it as (cd ~/Projects/rg-wt-rel-XYZ && <that line>)
#    EXPECTED: test/distribution-standing.test.ts fails 2 cases ("no release
#    tag for X.Y.Z"). They clear once the tag exists. ANY OTHER red: stop and
#    fix it before tagging.

# 5. Commit, push the branch, tag THAT commit, push the tag
( set -euo pipefail
  cd ~/Projects/rg-wt-rel-XYZ
  git commit -am "release: X.Y.Z"
  git push -u origin rg/release-XYZ
  git tag -a vX.Y.Z -m "rungate X.Y.Z"
  git push origin vX.Y.Z )
#    release.yml runs the full suite and a typecheck, then publishes

# 6. Wait for the run, then the registry. It takes several minutes and prints
#    one reading. Only SPENT means X.Y.Z is used up: read the run's log, fix,
#    and cut the next version (see "A failed release costs a version number").
#    NO_RUN, NO_OUTCOME and NOT_SERVED spend nothing: look, then re-run it.
#    PUBLISHED is the only reading that goes on to step 7. The script and its
#    tests: scripts/release-wait.ts, test/release-wait.test.ts.
(cd ~/Projects/rg-wt-rel-XYZ && bun scripts/release-wait.ts --version X.Y.Z)

# 7. Published half: set SUCCESS.md's line to published `rungate@X.Y.Z`,
#    then commit and push

# 8. Open the PR, labelled when you open it, closing the step-0 issue
gh pr create -R hornjason/rungate --label ai-review-override \
  --title "chore(release): X.Y.Z — <what it ships>" --body-file <file>
#    The body says `Fixes #<step-0 issue>`. For each SC-N the issue cites, it
#    also says "does not complete SC-N", one phrase per id.

# 9. Merge BY HAND once `test` passes. Never --auto on this label.
#    `--by-hand`, because the label refuses the arming mode (WAIVED_REVIEW,
#    no SHA printed). It still refuses a head the branch has moved past.
( set -euo pipefail
  SHA=$(<T> bun scripts/verify-merge-ref.ts --pr <N> --by-hand)
  gh pr merge <N> -R hornjason/rungate --squash --match-head-commit "$SHA"
  <T> bun scripts/verify-merge-ref.ts --pr <N> --after-merge
  git -C ~/Projects/rungate worktree remove ~/Projects/rg-wt-rel-XYZ )

# 10. Rebase every open PR onto main. See "Moving the pins" below. A
#     generator PR that was waiting on this release: rebase it, run
#     `scaffold . --fix` so its pin moves to X.Y.Z, and push.
```

Steps 5 and 9 run in that order: the package publishes before the PR merges.
Step 8's label is required (see below). Step 9 is a hand merge because the
label waives the AI review, so auto-merge would land a diff nobody has read.

## A command a generated workflow calls ships BEFORE the workflow that calls it

Generated workflows run `bunx rungate@<package.json version>`
(`harnessVersion()` in `lib/scaffold/steps.ts`). That fetches the
**published** package. So if a generator change makes a workflow call a
command npm does not serve yet, the workflow breaks the moment the change
merges.

Split the work into three pieces and order them with `blocked by` edges
(AGENTS.md rule 4):

1. the command PR. It merges, and nothing reaches consumers yet;
2. the release that publishes it;
3. the generator PR. Rebase it after the release so `scaffold . --fix` moves
   its pin to a version that contains the command.

`board-id` went #2173 → 0.8.19 → #2166. `board-intake-move` went #2193 →
0.8.20 → #2183.

## The three that bite

### The published half of the standing line LAGS by one release

`SUCCESS.md` carries one line:

```
- **Distribution standing (YYYY-MM-DD)** — tree `X.Y.Z`, published `rungate@A.B.C`.
```

`tree` is `package.json`'s version and moves in the bump commit. **`published`
is what the registry serves at the moment you write it** — the *previous*
release — and it moves in a later commit, after the publish.

Why it cannot be set to the version you are cutting: `release.yml` runs
`bun test` **before** `npm publish`, and `test/distribution-standing.test.ts`
asserts the published half is a version the registry actually serves. Naming
the unpublished version fails the job and nothing is published.

The evidence is in the repository and was there to be read: at tag `v0.8.10`
the line reads ``tree `0.8.10`, published `rungate@0.8.8` ``. Two different
numbers, deliberately.

The tolerance is one release. Two behind is refused as stale, not as lag.

### The tag goes on a BRANCH commit, and publishes before the PR merges

`release.yml` triggers on `push: tags: v*`. The tag names the commit the
release is cut from, and that commit lives on the release branch — `v0.8.10`
points at a commit on `rg/release-089` that is not on main and never was.

This is not a workaround. The standing line cannot be made correct on main
before the publish, because until the publish happens the version is not one a
consumer can obtain. Publishing first and merging second is what makes both
halves true at the same time.

### A failed release costs a version number

Tags are not moved, deleted or re-pointed — a reference that can be re-aimed
stops identifying a commit. So a release that fails is re-cut as the **next**
version, not as a second attempt at the same one.

`v0.8.11` exists and published nothing. `v0.8.12` is the release that carried
the same change. That is the expected shape of a failure, not debris to tidy.

## What runs before anything is published

`release.yml` runs the **full suite** and a typecheck before `npm publish`, so
any red anywhere blocks the release — including self-referential checks that
have nothing to do with the version. Two reddened the 2026-11-04 attempt:

| Red | Cause | Fix |
|---|---|---|
| `distribution-standing` | published half named the unpublished version | name what the registry serves |
| `line-citation-ratchet` | the rendered `PROJECT-STATE.md` inherited a `path:NNN` citation from a session entry | drop the line number — the entry already named the symbol |
| `stage-ladder` live plan row (v0.8.18, 2026-11-13) | the suite reads the **live board**. Criterion coverage was 47 of 49: #2047 had closed before its successors were placed in the engine milestone | fix the board, then cut the next version (0.8.19). Nothing in the tree was wrong, which is why step 2b runs this before the tag, in the release worktree |

Run these locally before tagging and the round trip is minutes rather than a
failed job:

```bash
bun scripts/census-routing.ts    # the exact `bun test …` line for your diff
```

## Never hand-edit the version pins

The `bunx rungate@<version>` pins live in several generated workflows. On
2026-11-04 that was six pins in two files. On 2026-11-14 it was fifteen pins in
six files. Every new generated workflow adds more, so this guide gives no
number. Count them:

```bash
git grep -c 'bunx rungate@' origin/main -- .github/workflows/
```

`scaffold . --fix` owns every pin. `test/harness-fixed-point.test.ts` refuses a
generated file the generator would rewrite. Editing one by hand reddens the
build and the remedy is to re-run the scaffold anyway.

## Moving the pins breaks every open pull request

A release rewrites every file that command lists. One of them is
`.github/workflows/ai-review.yml`, and that is the one with a consequence: the
review action **refuses to run when a pull request's copy of its own workflow
differs from the default branch's** — so after a release merges, every open
pull request needs rebasing onto main before its reviewer will run again.

The other pinned workflows have no such guard, so they change without
breaking anything.

This is expected and is not a fault in any of those pull requests. On
2026-11-04 it took #1740, #1747 and #1607 out at once.

## The release PR cannot pass `ai-review`, and that is why step 8 carries a label

The same refusal lands on the release pull request **itself**, every time,
without exception. Step 3 rewrites the pin inside `.github/workflows/ai-review.yml`,
so the release branch's copy of that file necessarily differs from main's, so
the action declines before it starts. `ai-review` is a required check on main
and it stays **red** until the label — no re-run and no rebase can clear it,
because the difference is the thing being shipped. (Red, not pending: the
reason it gives is `UNMEASURED`, and the distinction is spelled out below.)

`ai-review-override` is the designed answer, and this is the one case the
standing rule against that label explicitly allows: the reviewer is
**structurally unable to run**, not being waived after reporting something.
Verified on the last release — #1749 carried the label and its `ai-review`
check reports pass in 30s, which is the waiver path, not a review.

Label it when you open the pull request rather than after watching the check
fail. The waiver is standing: it survives later pushes, so a human reads the
diff instead.

### One red check on a release PR is expected. A second one is not — investigate it

Required on main is exactly `test` and `ai-review` — nothing else, no required
reviewers, `strict: false`. So:

| Check | On a release PR | Why | Blocks the merge? |
|---|---|---|---|
| `ai-review` | **red until the label** — the step exits 1 | structural: step 3 rewrites the pin inside `ai-review.yml`, so the action declines | **yes** — required |

Any other red check on a release pull request is an unexplained failure, not
scenery: investigate it before merging. This table once had a second row, for
the trial reviewer's `review` check, and an earlier revision called that check
red-but-normal on a release. It was wrong: `review` passed on #1738 and #1634
and failed on #1749 for a reason never established. The trial was deleted in
#2627, and the lesson stays: writing a red check off as expected is how a real
one gets waved through.

**The outcome and the reason are different things, and this repository is
strict about not confusing them.** `ai-review` is red, not pending and not
neutral: the no-payload branch ends in `exit 1`. What is UNMEASURED is the
*review*, not the check — nobody looked at the diff, so there is no verdict,
and the check refuses rather than reporting a pass for a review that never
happened. "UNMEASURED, not a silent pass" is the rule in
`.claude/rules/config-access.md`; a green check there would be the defect.

Applying `ai-review-override` turns that red into a pass and prints
`AI review WAIVED`. The review is still UNMEASURED afterwards — the label
changes what the pipeline does about it, not whether anyone read the diff.
That is why a human reads the release diff.

**What actually blocks a merge, in order of how often it catches people:**
`required_conversation_resolution` is on, so an unresolved review thread
blocks — resolve threads, do not just re-run checks. A failing *required*
check blocks, and the required set is only `test` and `ai-review`. A failing
non-required check makes the pull request `UNSTABLE`, which is still
mergeable — but see the paragraph above: on a release that is a signal to
investigate, not a state to merge through.

## A merged fix is not a shipped fix

CI runs the adjudicator as `bunx rungate@<version>`, which resolves to the
**published package**. Code merged into `lib/` is dormant until a release cuts
— the only half of a change that takes effect on merge is whatever lives inside
a generated workflow file.

#1748 merged a reviewer prompt and the instrument that reads its output. The
prompt was live immediately; the instrument emitted nothing, because 0.8.10 did
not contain it. Before concluding a merged change does not work, check whether
it is published.

## Authentication

OIDC trusted publishing — no token, no `NODE_AUTH_TOKEN`, no `--provenance`
flag. `release.yml`'s header documents the constraints that come with it
(npm >= 11.5.1, node >= 22.14.0, an exact `repository.url`). Nothing in this
guide changes any of that.
