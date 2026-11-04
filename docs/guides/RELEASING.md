---
doc-type: guide
status: active
updated: 2026-11-04
---

# Releasing rungate

Everything here was learned by getting it wrong. `.github/workflows/release.yml`
already explains **why** each guard in the pipeline exists, at length. What was
never written down is the **sequence** — and the sequence is what fails, because
three of its steps are counter-intuitive and none of them is enforced.

On 2026-11-04 a release was cut, failed, and had to be re-cut under a new
version number. Every cause is below.

## The sequence

```
1. branch off main                      (NOT the primary checkout's main itself)
2. bump package.json                    tree version -> the new number
3. SUCCESS.md standing line             tree  -> the new number
                                        published -> WHAT THE REGISTRY SERVES TODAY
4. bun bin/rungate.ts scaffold . --fix  moves the five `bunx rungate@` pins
5. commit, push the BRANCH
6. tag that branch commit, push the tag → release.yml publishes
7. wait for the registry to serve it
8. open the PR and merge
```

Steps 6 and 8 are in that order, not the other one.

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

Run these locally before tagging and the round trip is minutes rather than a
failed job:

```bash
bun scripts/census-routing.ts    # the exact `bun test …` line for your diff
```

## Never hand-edit the version pins

Five `bunx rungate@<version>` sites live in generated workflows.
`scaffold . --fix` owns them; `test/harness-fixed-point.test.ts` refuses a
generated file the generator would rewrite. Editing one by hand reddens the
build and the remedy is to re-run the scaffold anyway.

## Moving the pin breaks every open pull request

The pin lives in `.github/workflows/ai-review.yml`, so a release rewrites that
file. The review action **refuses to run when a pull request's copy differs
from the default branch's** — so after a release merges, every open pull
request needs rebasing onto main before its reviewer will run again.

This is expected and is not a fault in any of those pull requests. On
2026-11-04 it took #1740, #1747 and #1607 out at once.

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
