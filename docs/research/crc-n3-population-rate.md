---
doc-type: research
status: active
owner: jason
updated: 2026-11-20
governs: "#2463's reading of CRC-N3's population rate over pull requests reviewed after #2459 made the ledger keep each finding's class size"
---

# CRC-N3's population rate, measured: 29 of 45 judged findings (64.4%)

CRC-N3 (`specs/CODE-REVIEW-CONVERGENCE-SPEC.md`) asks the reviewer to flag the
class of a bug, not the line. Since #1883 a finding states its class as a count,
`population`, backed by `populationSearch`: the literal text whose matching lines
in the cited file are the class. The rate is how many findings counted their class
by a search that ran.

#2437 built the instrument. Until #2459 it could report no rate: the ledger step
dropped both fields, so every finding read *not recorded* (31 of 31 on PRs
2400-2448). #2459 merged at 2026-11-19T13:05:45Z and the ledger has kept both
fields since. This reads the first window after it.

## The reading

| | count |
|---|---|
| window | #2465–#2537, the first pull request reviewed after #2459 to the last merged, read on 2026-11-20 |
| pull requests read | 35 |
| rounds with a review | 63, of 77 recorded |
| rounds that reported at least one finding | 33, across 12 pull requests |
| findings | 45 |
| **measured**: the search ran and its count is the class size | **29** |
| contradicted: the search ran and found a different number from the one declared | 8 |
| undeclared: no count and no search | 6 |
| unmeasured: the search could not run, or matched no line of the cited file | 2 |
| unbacked: a count with no search behind it | 0 |
| not recorded: the ledger kept no class-size field | **0** |
| **rate** | **29 of 45 judged findings, 64.4%** |

Every round in the window recorded the fields, so *not recorded* is 0, which is
what #2459 promised. A round after it that still dropped them would be a defect in
#2459, not an empty reading. Every searched file was read at the round's head
commit (39); none at a merge commit and none nowhere, so no finding was left out
for want of a tree.

## What it says, and what it does not

- **Most findings now carry a checkable class size.** Two in three counted their
  class by a search that ran, rather than by a number the reviewer asserted.
- **One in six disagreed with its own search** (8 contradicted). The reviewer
  declared a count, the search it named found another, and the adjudicator
  reports the search's number. Those 8 are where the reviewer's sense of the class
  and the file disagree. They are the next thing worth reading when the CRC-N3
  instrument is turned on its own output.
- **The window is small and mostly one author's work.** The 12 pull requests that
  drew findings were opened by one agent over about a day. A second window of
  similar size, opened by other work, is what would show whether 64% is the
  reviewer or this window.
- **It is a rate of compliance, not of correctness.** A measured finding's class
  is counted honestly; whether the class was the right one to name is not
  something this reading can see.

## How to take it again

```
bun scripts/crc-reading.ts --lo 2465 --hi 2537 --save /tmp/window.json
bun lib/finding-population-rate.ts --from /tmp/window.json --repo-dir .
```

The first prints the rounds-to-pass table for the window and saves every
pull request's findings ledger. The second re-runs the adjudicator's own
`populationVerdict` (`lib/scaffold/ai-review-findings.ts`) over each round's tree
and prints the line above. Rounds that reported a finding were counted from the
saved ledgers: a round whose `findings` is a non-empty array.
