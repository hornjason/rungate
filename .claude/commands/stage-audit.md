---
argument-hint: <stage-id>
description: Re-take every reading a stage was closed on, from main, and say whether its green is reproducible or hand-placed
doc-type: reference
status: active
updated: 2026-11-07
---

## Where this ran

!`git rev-parse --git-dir --git-common-dir 2>/dev/null | tr '\n' ' '; echo; git status --porcelain --branch 2>/dev/null | head -5`

## The stage, and the commands it was closed on

!`bun -e 'const id=(process.argv[1]??"").trim().toUpperCase(); const s=JSON.parse(await Bun.file("project-state.json").text()); const st=(s.stages??[]).find(x=>String(x.id).toUpperCase()===id); if(!st){console.log("UNMEASURED: project-state.json declares no stage "+JSON.stringify(id)+". It has: "+(s.stages??[]).map(x=>x.id).join(", "));process.exit(0);} console.log("stage "+st.id+" — "+st.name); console.log("goal: "+st.goal); for(const i of st.items??[]){console.log("\n"+i.id+"  done="+i.done); console.log("  what:   "+i.what); console.log("  verify: "+(i.verify??"(none)"));}' -- $ARGUMENTS`

---

Audit stage **$ARGUMENTS**. A stage's green is only worth something if it can be
taken again; this re-takes it.

## Refuse before you measure

Read the first block above. **Stop and report `UNMEASURED` — do not run
anything else — if any of these is true:**

- `--git-dir` and `--git-common-dir` differ. That is a linked worktree, not the
  primary checkout, and a reading taken there describes a tree nobody else has.
- The branch line is not `## main...origin/main`. On 2026-11-03 the first
  attempt at this audit was taken off `rg/release-089` and had to be retaken —
  **read the branch line before calling any reading a main reading.**
- The tree is dirty. An uncommitted edit means the numbers describe a tree that
  exists on one machine.

Say which one refused and stop. A reading that could not be taken is not one
that passed.

## Then re-take every reading

Run each DONE item's `verify` command above, from the repository root,
through `bash -o pipefail -c`. One at a time. For each, record the exit code
**and the command's own output**, because the exit code alone cannot tell a
reading that was MET from one the guard never reached.

Do not pass an expected number to anything. The numbers are the output of this
run; a command told what to expect has measured nothing. If you catch yourself
comparing against a figure you brought with you, that figure is a hypothesis to
state, not an argument to supply.

Also run the ladder itself, which executes every stage's DONE verifies:

```bash
bun test test/stage-ladder.test.ts
```

## Report

Four lines, plus one row per item:

```
stage <id>: REPRODUCIBLE | NOT REPRODUCIBLE | UNMEASURED
<n> of <m> DONE items re-took their reading from main
<what differs, or "nothing">
<what needs a person, or "nothing">
```

Rules for the verdict:

- **REPRODUCIBLE** — every DONE item's verify exited 0, here, now, on main.
- **NOT REPRODUCIBLE** — at least one exited non-zero. Name it, give its
  output, and say what the number is **now** against what the stage recorded.
  This is the finding; it is not a failure of the audit.
- **UNMEASURED** — a precondition refused, or a command could not run at all
  (no credential, no network, a missing file). Never fold this into
  REPRODUCIBLE. "Could not measure" must never read as "nothing wrong".

An item with `done: false` is not audited and is not counted against the
stage. Say how many you skipped for that reason.

## What this is for

Jason asked for it after Stage B closed: a stage that was green because
somebody read four tools' output correctly is not the same as a stage that is
green. Stage B was audited by hand on 2026-11-03 and it took most of a
session. This is that session as a command.
