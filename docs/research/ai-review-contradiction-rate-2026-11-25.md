---
doc-type: research
status: active
owner: jason
updated: 2026-11-25
governs: "#1186's measurement of ai-review CONTRADICTION outcomes, a BLOCK verdict over findings none of which block, read from CI annotations 2026-10-20 to 2026-11-25"
---

# AI review contradictions, measured: 4 in 3,773 runs, none since 2026-11-05

#1186 asked which input varies when `ai-review` returns `BLOCK` while its own
payload says no finding blocks. When it was filed on 2026-10-22, that outcome
came back on about 6 of 20 runs, and a re-run of the same commit often came back
clean. #1185 had made each contradiction print its findings into the check run's
annotation, so the evidence would survive the runner.

## How it was read

Every `ai-review` run from 2026-10-20 to 2026-11-25 was listed, week by week.
For each failed attempt, and for every earlier attempt of a run that was re-run,
the failure annotations of its job were read and sorted by what they say. A
contradiction is an annotation saying the verdict "contradicts its own payload",
or the older `BLOCK over 0 of N` form. A run re-run to green keeps its earlier
attempts, so a contradiction a re-run cleared is still counted.

## What it found

| window | runs | contradictions |
|---|---|---|
| 2026-10-20 to 10-26 | 970 | 3, all on 10-22, the last at 14:31 UTC |
| 2026-10-27 to 11-02 | 450 | 0 |
| 2026-11-03 to 11-09 | 618 | 1, on 11-05 |
| 2026-11-10 to 11-16 | 735 | 0 |
| 2026-11-17 to 11-25 | 1,000 (1,007 attempts) | 0 |
| **total** | **3,773** | **4** |

Over the last window, the 117 failed runs were 88 blocking findings, 15
population replies owed, 12 unmeasured reviews and 2 reviewers that modified the
tree.

The four annotations, verbatim. The three from 10-22 ran under rungate 0.7.0,
which predates #1185's printing of the findings, so only the counts survive:

- run 39765961279, attempt 1, commit `a87913b`: *The AI review's verdict "BLOCK" contradicts its own payload: 0 of 1 finding(s) block.*
- run 39795440261, attempt 1, commit `2a0effd`: the same sentence.
- run 39796394689, attempt 1, commit `47e1045`: the same sentence.
- run 42108890208, attempt 1, commit `5e4d56f`: *0 of 2 finding(s) block.* Both findings are `medium` at one line of `scripts/board-walkthrough.ts`. One is a cleanup-ordering defect; the other says the round budget is spent and the same defect has survived since round 3.

Run 39795440261 is a pair on one commit: attempt 1 is the contradiction, and
attempt 2, 23 minutes later on `2a0effd`, logged `ai-review findings outcome:
CLEAN`. Run 39796394689 was cleared the same way by its third attempt. The clean
attempts' payload files did not survive the runner; their outcome annotations
did.

## What varied: the payload, and in the one printed case, the verdict word

The adjudicator is a pure function of the payload, and it gave two outcomes for
one diff, so the payload differed between the two attempts. That much is
measured. What in the payload differed is measured for one contradiction only:
run 42108890208 printed two findings, both `medium`, under a `BLOCK` verdict,
so there the verdict word disagreed with the severities beneath it. The clean
attempts' payloads were not kept, so whether their findings also differed, or
only the verdict, cannot be read. The three 10-22 contradictions printed counts
only, and are consistent with the same shape without showing it.

The rate fell from about 6 in 20 runs to 1 in the 2,803 runs from 10-27 to
11-25. The one was on 11-05, and none came after it: not in the rest of that
week, and not in the 1,735 runs from 11-10 to 11-25. This record does not tie the fall to
one change. The prompt line telling the reviewer that its verdict does not
decide whether the run blocks was already present on 10-22 (#800). The check
that compares the verdict with the findings moved ahead of CRC-B7's demotion of
pre-existing findings on 10-23 (#1435). A contradiction is still refused when it
happens, as #1185 requires: a verdict the adjudicator cannot explain fails the
job, and the findings are printed.
