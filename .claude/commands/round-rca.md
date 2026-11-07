---
argument-hint: <pr-number>
description: At the review-round budget, ask three questions in order before re-scoping anything
doc-type: reference
status: active
updated: 2026-11-07
---

## Runs against reviewed commits, for this pull request

!`bun -e 'const sh=async a=>{const p=Bun.spawnSync(["gh",...a],{env:Object.fromEntries(Object.entries(process.env).filter(([k,v])=>k!=="GH_TOKEN"&&v!==undefined))}); return p.exitCode===0?new TextDecoder().decode(p.stdout):null;}; const meta=await sh(["pr","view","--json","number,headRefName,createdAt,state,url"]); if(meta===null){console.log("UNMEASURED: gh could not resolve a pull request for the current branch. Run this from the branch whose pull request you are reviewing.");process.exit(0);} const m=JSON.parse(meta); const n=String(m.number); const runs=await sh(["api","-X","GET","repos/{owner}/{repo}/actions/workflows/ai-review.yml/runs","-f","event=pull_request","-f","branch="+m.headRefName,"-f","created=>="+m.createdAt,"-f","per_page=100"]); if(runs===null){console.log("UNMEASURED: the workflow-runs API did not answer. This is the same reading ai-review.yml takes; without it the round number is unreadable, not 1.");process.exit(0);} const r=JSON.parse(runs); const list=r.workflow_runs??[]; console.log("pull request #"+n+"  "+m.state+"  "+m.url); console.log("head branch:      "+m.headRefName); if(list.length!==r.total_count){console.log("UNMEASURED: the API reports "+r.total_count+" matching runs and returned "+list.length+" on one page. total_count spans the whole result set and the commit count would span only the page, so comparing them would be two different populations. Paginate before answering.");process.exit(0);} const shas=new Set(list.map(x=>x.head_sha)); console.log("runs counted:     "+r.total_count+"   <- this is the number ai-review.yml calls the round"); console.log("distinct commits: "+shas.size+"   <- this is how many trees were actually reviewed"); console.log(r.total_count===shas.size?"\nAGREE. The round count is not inflated by re-runs on this reading.":"\nDISAGREE by "+(r.total_count-shas.size)+". The round number counts RUNS, not reviewed commits."); console.log("\nper run:"); for(const x of list.slice(0,30)) console.log("  "+x.head_sha.slice(0,8)+"  "+x.event+"  "+x.conclusion+"  "+x.created_at);'`

---

Pull request **$ARGUMENTS** has reached the review-round budget. **Do not
re-scope on the trigger.** Ask these three questions in order and re-scope only
if the third is yes.

Had the trigger alone been obeyed on #1725, a correct green pull request would
have been split and a race fix deleted. That is what this command exists to
stop.

## 1. Is the round count real?

Read the block above. `.github/workflows/ai-review.yml` sets
`round="${total}"` from `total_count` on the workflow-runs API, filtered by
head branch and the PR's creation time — so it counts **runs**, not reviewed
commits. Every close/reopen and every re-run adds one.

- **AGREE** — the count is honest. Go to question 2.
- **DISAGREE** — the trigger fired early. Say so, give both numbers, and
  carry on working. The budget has not actually been reached.
- **UNMEASURED** — the API did not answer, or it reported more runs than one
  page returned. That is not a count of 1 and not permission to re-scope; say
  which reading failed.

**#1592 already tracks this counter. Do not re-file it.** #1725 read 6 against
4 because each #1307 flake remediation is a close/reopen, and that is another
run.

## 2. Is the finding real?

Only reached if the count is honest. Take the repeated finding and ask what
input would make it false, then go and run that input. A recommendation is not
evidence; a reading is.

The worked case: #1725 rounds 5 and 6 both recommended consolidating two cap
sites into one. Killing each site separately reddened **different** sets — 23
cases with 14 unique against 12 with 3 unique. Two deciders that agree cannot
produce that, so the two sites were not duplicates and the recommendation
would have deleted #1595's race fix.

- **Not real** — answer it on the thread with the reading, resolve it, and
  carry on. A round spent refuting a finding is not a round spent repairing.
- **Real** — go to question 3.

## 3. Is the work wrong?

Only now. Rounds are a rejection signal rather than progress — across 40,214
pull requests each extra reviewer comment *lowered* merge odds 2.8% on
agent-authored changes (Yoshioka et al., MSR '26).

Re-scope, and say what a further round would fix that this one did not. If
that is a different problem it is a second issue, not a fourth round.

## Report

```
pr #<n>: COUNT REAL? yes|no|unmeasured  ->  FINDING REAL? yes|no|-  ->  RE-SCOPE? yes|no
<the two numbers from the block above>
<what you are doing next, in one line>
```

Stop at the first `no`. Three noes in a row has never happened; one is the
common case and it means keep working.

## Why the block takes no argument

The block reads no `$ARGUMENTS`. It resolves the pull request from the branch
you are standing on — `gh pr view` with no number — so **run it from that
branch**. If you are somewhere else it says `UNMEASURED` and tells you so
rather than reading the wrong pull request.

That is the third answer to the same problem, and the first two are worth
recording because both looked fine. The runtime substitutes `$ARGUMENTS`
**textually** into the command line before the shell parses it. Passing it bare
was plainly unsafe: `1725; rm -f <file>` deleted the file, and the
`/^[0-9]+$/` guard ran afterwards, which made it no guard at all. Quoting it as
`RG_PR="$ARGUMENTS"` fixed that case and still failed, because an argument
holding a `"` closes the quoting early — `1882" ; rm -f <file> ; #` executed,
file gone, interpreter never reached. No quoting inside the line survives a
substitution that happens before parsing.

So the shell never sees an argument. `test/command-contracts.test.ts` refuses
any executable block in this directory that interpolates `$ARGUMENTS`, and
proves that refusal fires against a planted one.
