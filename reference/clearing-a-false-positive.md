---
doc-type: reference
status: active
updated: 2026-11-06
---

# Clearing a false positive — the CRC-C3 procedure

`specs/CODE-REVIEW-CONVERGENCE-SPEC.md`, **CRC-C3**: *a false positive clears
by closing the thread with a short reason.*

This file is the step. Before it existed, clearing one was a judgement each
reviewer made again from scratch, and the two cheap ways out — merging past
the thread, or "fixing" code that was never wrong — are both worse than the
finding.

Not in `.claude/rules/` on purpose: the auto-loaded instruction surface has
258 bytes of headroom against its 64,000-byte budget, and raising that budget
is a decision rather than a fix. `lib/branch-protection.ts` routes to this
file from the remedy it prints, which is where somebody needs it.

## The procedure

**1. Decide which of three things it is.** They are not the same and only one
of them is a false positive.

| | What it means | What clears it |
|---|---|---|
| **True** | the code is wrong | change the code |
| **True, out of scope** | real, and not this PR's to fix | a comment, or an issue if somebody will act on it — AGENTS.md rule 7 |
| **False** | the reviewer's premise does not hold | this procedure |

A finding is false when **its premise is wrong**, not when the fix is
inconvenient. "This would break X" where X cannot be reached, "this field can
be null" where the type forbids it, "the guard is missing" where it is three
lines up. If you are arguing about severity rather than about a fact, it is
not false.

**2. Reply in the thread with the reason, in one or two sentences, naming the
evidence.** Not "not a bug". Not "by design". The next reader must be able to
check it without re-deriving your reasoning:

> Not reachable: `parse()` refuses an empty body at line 40, so the `null`
> this describes cannot arrive here. `bun test test/parse.test.ts -t empty`
> covers it.

**3. Resolve the thread.** The reply is the record; resolving is what lets the
merge proceed.

```bash
# the thread ids on a PR, with their state
gh api graphql -f query='
{ repository(owner:"OWNER",name:"NAME"){ pullRequest(number:N){
    reviewThreads(first:50){ nodes{ id isResolved path } } } } }'

gh api graphql -f query='mutation($t:ID!){ resolveReviewThread(input:{threadId:$t}){ thread{ isResolved } } }' -f t="<id>"
```

**4. If the same false positive recurs, fix the reviewer, not the thread.**
Twice is a pattern and the third round is wasted on both sides. That is a
finding about the review prompt or the rule it is reading from, and it goes on
the tracker.

## What this procedure refuses

**Resolving without replying.** A resolved thread with no reason is
indistinguishable from one nobody read, and it is the state this whole
criterion exists to prevent. The merge is unblocked and the record says
nothing.

**Merging past it.** `required_conversation_resolution` exists so that is not
an option. If it is possible, the setting is off and that is its own defect —
`readFindingDisposition` in `lib/branch-protection.ts` is the check, and it
has caught this exact regression once.

**Marking it false because three rounds have gone by.** Round pressure is real
(AGENTS.md rule 5) and the remedy for it is re-scoping, not reclassifying. A
finding you are tired of is not a finding whose premise is wrong.
