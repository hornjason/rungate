---
argument-hint: <stage-id>
description: Re-take every reading a stage was closed on, from main, and say whether its green is reproducible or hand-placed
doc-type: reference
status: active
updated: 2026-11-07
---

## Can this tree be measured at all?

!`bun -e 'const sh=a=>{const p=Bun.spawnSync(a);return p.exitCode===0?new TextDecoder().decode(p.stdout).trim():null}; const gd=sh(["git","rev-parse","--git-dir"]),gc=sh(["git","rev-parse","--git-common-dir"]),st=sh(["git","status","--porcelain","--branch"]); if(gd===null||gc===null||st===null){console.log("REFUSE: UNMEASURED — git did not answer, so the tree this would measure is unknown.");process.exit(0)} const {resolve}=await import("path"); const why=[]; if(resolve(gd)!==resolve(gc))why.push("this is a LINKED WORKTREE ("+gd+"), not the primary checkout"); const lines=st.split("\n"),branch=(lines[0]??"").replace(/^## /,""); const bm=/^main\.\.\.origin\/main(?: \[(.+)\])?$/.exec(branch); if(bm===null)why.push("the branch is "+JSON.stringify(branch)+", not main...origin/main"); else if(bm[1]!==undefined)why.push("main has diverged from origin/main ["+bm[1]+"], so a reading taken here is not a reading of what origin holds"); const dirty=lines.slice(1).filter(l=>l.trim()!==""); if(dirty.length)why.push(dirty.length+" uncommitted change(s)"); console.log(why.length?"REFUSE: "+why.join("; ")+".":"PRIMARY CHECKOUT ON MAIN, clean. Proceed."); console.log("  git-dir="+gd+"  git-common-dir="+gc+"  branch="+branch+"  dirty="+dirty.length);'`

## The stage, and the commands it was closed on

!`bun -e 'const f=Bun.file("project-state.json"); if(!(await f.exists())){console.log("UNMEASURED: project-state.json is not present in this directory, so no stage index could be built. Run this from the repository root.");process.exit(0);} let s; try{s=JSON.parse(await f.text());}catch(e){console.log("UNMEASURED: project-state.json is present and could not be parsed — "+(e&&e.message?e.message:String(e))+". A corrupt plan is not an empty plan.");process.exit(0);} const st=s.stages??[]; if(!st.length){console.log("UNMEASURED: project-state.json declares no stages.");process.exit(0);} console.log("id  done/items  with-verify  name"); for(const x of st){const it=x.items??[]; const done=it.filter(i=>i.done); const withV=done.filter(i=>typeof i.verify==="string"&&i.verify.length>0); console.log(" "+String(x.id).padEnd(3)+" "+String(done.length+"/"+it.length).padEnd(10)+" "+String(withV.length).padEnd(12)+" "+(x.name??""));} console.log("\nevery DONE item above must carry a verify, or the stage cannot be audited at all.");'`

---

Audit stage **$ARGUMENTS**. A stage's green is only worth something if it can be
taken again; this re-takes it.

## Read the first block before anything else

The first block **decides**; it does not hand you readings to interpret. It
resolves `--git-dir` against `--git-common-dir`, reads the branch line and
counts uncommitted entries, and prints one of two verdicts.

- **`REFUSE: …`** — stop. Report `UNMEASURED` and repeat the reason it gave.
  Run nothing else. A reading that could not be taken is not one that passed.
- **`PRIMARY CHECKOUT ON MAIN, clean. Proceed.`** — continue.

Why it decides rather than reports: on 2026-11-03 the first attempt at this
audit was taken off `rg/release-089` and had to be retaken. A probe that
prints raw `git` output and trusts the reader to compare it is a probe that
was already available, and it did not prevent that.

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
- **UNMEASURED** — the first block refused, or a command could not run at all
  (no credential, no network, a missing file). Never fold this into
  REPRODUCIBLE. "Could not measure" must never read as "nothing wrong".

An item with `done: false` is not audited and is not counted against the
stage. Say how many you skipped for that reason.

## What this is for

Jason asked for it after Stage B closed: a stage that was green because
somebody read four tools' output correctly is not the same as a stage that is
green. Stage B was audited by hand on 2026-11-03 and it took most of a
session. This is that session as a command.

## Why the blocks take no argument

Neither block above reads `$ARGUMENTS`. That is deliberate and it is the third
answer to the same problem.

The runtime substitutes `$ARGUMENTS` **textually** into the command line before
the shell parses it, so nothing written inside the line can contain it. Passing
it bare was plainly unsafe. Quoting it as `RG_STAGE="$ARGUMENTS"` looked safe
and was not: an argument holding a `"` closes the quoting early, and
`B" ; rm -f <file> ; #` executed — measured, with the file gone and the
interpreter never reached. A guard inside the script cannot help, because the
shell has finished by the time the script starts.

So the shell never sees the argument at all. The blocks take a reading that
needs no argument, and the stage id stays in the prose below, where it is text
in a prompt and never a command. `test/command-contracts.test.ts` refuses any
executable block in this directory that interpolates `$ARGUMENTS`, and proves
that refusal fires against a planted one.
