---
doc-type: research
status: active
owner: jason
updated: 2026-11-20
governs: "#1764's measurement of how to get first-pass completeness from the AI review: five independent round-1 draws (Arm A) against one REVIEW.md instruction to work through its failure table (Arm B)"
---

# First-pass completeness, measured: draws find everything, the checklist instruction finds less

#1764 asked which of two changes makes one review round surface every defect
instead of one per round. Measured on 2026-11-20, eight round-1 `ai-review`
runs over one subject:

- **Arm A wins.** The union of five independent draws found all six planted
  defects. A single draw found 2 to 5, median 4.
- **Arm B adds nothing.** Telling the reviewer to work through `REVIEW.md`'s
  table row by row found 3 of 6 on each of three draws, always the same three.
  The reviewer did follow it: its summary lists every row. On the rows it
  missed it wrote "no defect found" over a planted defect, so the instruction
  bought a completeness claim rather than completeness.
- **Every finding was real.** 27 findings across 8 draws, each one a plant.
  There were no false positives on this subject.

## The subject

`adf37b36`, the subject the issue named, cannot measure a first pass. It is at
round 27, the reviewer there is told not to hunt, the scope is diff-only and
the prior set holds 27 rounds of threads (issue comment, 2026-11-07). So the
subject was a scratch branch off `main` (`d3ab830d1`) carrying one planted
defect per row of `REVIEW.md`'s table. They were planted in real files rather
than under `evals/**/subjects/**`, which `REVIEW.md` tells the reviewer not to
flag.

| Row | File | Plant |
|---|---|---|
| 1 a check passes on input it never looked at | `scripts/check-instruction-surface.ts` | a missing always-loaded file counts as 0 bytes instead of UNMEASURED |
| 2 shell in a `run:` block | `lib/scaffold/criterion-label-workflow.ts` | `filed=$(grep -c …)` under `set -euo pipefail` aborts the step when nothing was filed |
| 3 a test that cannot fail | `test/rounds-to-pass.test.ts` | R-10 asserts only that the result is defined |
| 4 a comment that lies | `lib/rounds-to-pass.ts` | docblock says `Math.max`; the code reads the newest entry |
| 5 corrupt config reads as missing | `lib/config-readers.ts` | `readQueueLabel` catches the loader's throw |
| 6 breaks an always-loaded rule | `scripts/worktree-sweep.ts` | runs `git worktree prune` |

Each draw was a separate draft pull request on a fresh branch, so each was
round 1: full scope, budget unspent, no prior threads. Arm B's pull requests
targeted a base branch carrying the one extra `REVIEW.md` section.
`ai-review` restores `REVIEW.md` from the base branch's tip, and the run log
confirms it (`restored from refs/remotes/origin/eval/1764-enumerate`). Both
arms' diffs were byte-identical. Titles and bodies were identical and did not
say the defects were planted. The commits stay reachable through the closed
pull requests: Arm A's head is `b6acbc5ea`, Arm B's base is `1481b08ea` and
its head is `948d765cb`.

## What each draw found

| PR | Arm | Rows found | Count | Turns |
|---|---|---|---|---|
| #2555 | A | 2, 3, 5 | 3 | 37 |
| #2556 | A | 2, 5 | 2 | 31 |
| #2557 | A | 2, 3, 4, 5 | 4 | 28 |
| #2558 | A | 2, 3, 4, 5 | 4 | 31 |
| #2559 | A | 1, 2, 3, 5, 6 | 5 | 32 |
| #2560 | B | 2, 3, 5 | 3 | 43 |
| #2561 | B | 2, 3, 5 | 3 | 35 |
| #2562 | B | 2, 3, 5 | 3 | 33 |

Arm A's union over draws in order: 3, 3, 4, 4, 6. Rows 2 and 5 were found by
every draw in both arms, and row 3 by seven of eight. Rows 1 and 6 were found
by one draw of eight, and row 4 by two. Arm B spent more turns (mean 37 against
32) and found none of rows 1, 4 or 6.

The findings come from each pull request's ledger comment, and the row-by-row
summary from the `AI review summary` annotation on #2560's run.

## Against the predictions written before the draws

| | Predicted | Measured |
|---|---|---|
| single draw | 1–2 of 6 | 2–5, median 4 |
| union of 5 | 3–5 of 6 | 6 of 6 |
| one Arm B pass | 3–5 of 6 | 3 of 6, three times |

Arm B's falsifier fires. An enumerated pass found no more than an ordinary
one, so the taxonomy is not what limits the search. Arm A's falsifier does
not: the draws were not the same single finding, and their union reached
every class.

## What this does not show

- **One subject and eight draws.** These plants are easier than the defects
  that took #1740 and #1607 dozens of rounds, so a round-1 median of 4 here
  says nothing about those pull requests. The comparison between arms is the
  result; the absolute numbers are not.
- **Precision on a harder subject.** No draw raised a false finding here.
  Whether union-of-N stays clean when the defects are subtle is the question
  that decides whether N draws can block. The issue ties that to making
  `ai-review` advisory, which is Jason's decision.
- **Cost.** Five draws are five review runs. #1885 is the build that would
  run them and merge the drafts.
