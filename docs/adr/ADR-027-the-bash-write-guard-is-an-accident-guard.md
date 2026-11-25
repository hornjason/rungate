---
doc-type: adr
status: proposed
created: 2026-11-25
updated: 2026-11-25
---

# ADR-027 — The bash write guard is an accident guard

## Status

**Proposed, 2026-11-25.** Jason chose this direction on 2026-11-25, after an audit of the guard ("Shrink via ADR"). Filed as #2841. He merges this ADR. Still open for him: the wording of SC-2810 and SC-2811, quoted under Criteria.

## Context

`hooks/BashWriteGuard.hook.ts` runs before every Bash command an agent issues. It refuses a command that writes `workflow-state.json`, `.gate-salt`, anything under `/witnesses/`, or a hook source (`*.hook.ts`, `*.hook.sh`). The decision lives in `lib/bash-write-guard.ts`. Each fact below was measured on main at `c6eb03f55`:

- **Size.** `lib/bash-write-guard.ts` is 4,167 lines, and `test/bash-write-guard.test.ts` is 5,163 (`wc -l`). Roughly by line:
  - 1 to 1,050: the scratch exemption's machinery (protected trees, link resolution, the chain of steps before a write, `mkdir` tracking);
  - 1,057 to 2,410: the shell reader (segments, quotes, heredocs, substitutions, write targets);
  - 2,409 to 3,940: reading a program body for its write targets, and proving a write function's identity;
  - 3,942 to 4,167: the decision.
- **It says it is not a boundary.** The docblock above `WRITE_INTENT` reads: "an interpreter can always evade this … It is not a boundary." `gates/witness.ts` calls the witness signature "tamper-EVIDENT, not tamper-proof", because the salt is readable by the agent's own user.
- **It is stepped around on main.** These commands went through `decideBashWrite` with nothing executed:
  - a program written to a file and then run: allowed;
  - the protected name split by a shell variable (`f=flow-state; echo x > …/work$f.json`): allowed;
  - `python3 -I -c "import shutil; shutil.copy(dst='hooks/X.hook.ts', src='/tmp/rg/X.hook.ts')"` from a checkout: allowed, and the copy writes the checkout's hook;
  - a plain `echo x > …/workflow-state.json`: refused, the control.
- **Its sibling tools are not covered.** The only PreToolUse hooks on Write and Edit are `WorkflowStateGuard` and `GateResultProtection`, and both protect `workflow-state.json` alone.
- **What it refused.** Of 108,310 unique Bash commands in this machine's transcripts, main refuses 65. Each was read by hand:
  - none was an attempt to forge a verdict;
  - three were deliberate maintenance of live hooks;
  - the rest were legitimate work: editing hooks in a worktree for a mutation battery, copying state to `/tmp` to read it, and probes of the guard itself.
- **What the interpreter exemption is worth.** With the exemption for interpreter bodies cut short to `false`, 0 of those 108,310 commands change. Five AI review rounds and four security passes on #2756 each found a new way through it. #2756 was closed unmerged on 2026-11-25.
- **What it cost.** About 30 to 40 issues and 30 or more pull requests in five weeks name the guard.
- **Who depends on it.**
  - The hook calls `decideBashWrite`.
  - `lib/issue-create-override.ts` imports `interpreterPrograms`.
  - SC-2750 pins `heredocReach` in the file.
  - Nothing else imports it.
- **Local verdicts do not decide merges today.** `ship.mode` is `direct` (`.claude/rules/ship-workflow.md`). Merges are decided by the required CI checks.

## Decision

Nothing in the guard changes when this ADR merges. The first row's pull request makes decisions 2 and 3 true, and the second row's makes SC-2810 true.

Once both rows ship, the guard catches accidents and says so. It refuses a shell command that writes a protected artifact. It also refuses an interpreter body that names one beside a declared write verb, wherever it points. It reads no program to find out where that program writes. Reads, and the sanctioned `writeWorkflowState` repair, stay allowed. Plain shell writes into a scratch directory stay exempt, decided by the target's real directory. The module shrinks to the size SC-2810 states.

## Decisions

1. **The guard is an accident guard, not a boundary — Jason, 2026-11-25.** A userland reader of command text cannot stop an agent running as the files' owner, and the code already admits it, but only in the `WRITE_INTENT` docblock. The cut writes it into the hook's docblock (`hooks/BashWriteGuard.hook.ts`) and into the BashWriteGuard row of `specs/HOOK-ARCHITECTURE-SPEC.md`, and leaves no comment claiming more.
2. **Program-body reading and the interpreter scratch exemption are deleted, in the first row's pull request — Jason, 2026-11-25.** No real command uses the exemption, and every review of it found a bypass. What goes:
   - `bodyTargets`, `callWrites`, the assignment and tuple readers, `codeMask` and the write-callee identity;
   - `lib/interpreter-calls.ts`, once nothing imports it.
3. **An interpreter body that names a protected artifact beside a declared write verb is refused, wherever it points.** This is the write-intent window (`writesNear`, reading `WRITE_INTENT`), with the scratch exemption in front of it removed. It refuses only when a declared write verb is near the name, so a read of `workflow-state.json` stays allowed. So does the repair the harness prints, `bun -e … writeWorkflowState('…/workflow-state.json', …)`: the arm's docblock records why it must, and `test/bash-write-guard.test.ts` pins it.

   The arm is narrower than today's, in one direction. Today it is `writesNear || callWrites`, and `callWrites` is program-body reading, deleted by decision 2. So a body that hides its write verb from the window becomes allowed, where today it is refused. Two examples: an `open(…, 'w')` nested three calls deep, and a copy whose verb sits more than 80 characters before the name. That is the accident guard's trade: those shapes are written on purpose, and decision 1 says a purposeful agent is not what this stops.

   Both directions were measured on main over every unique Bash command in this machine's transcripts:
   - with the exemption cut short to `false`, 0 of 108,310 change (above);
   - with `callWrites` cut short to `false`, 0 of 109,328 change. Main refuses 65 of those, and `callWrites` alone decides none of them. The corpus is the same transcripts, read again later the same day. The 1,018 extra commands are what this machine's sessions ran in between, and none of them is refused either way.

   Review round 1 of #2843 corrected the first draft, which dropped the write-verb condition. Round 2 corrected "unchanged".
4. **Shell writes keep a scratch exemption, and links are judged by name.**
   - **The exemption.** A write that names a protected artifact is exempt only when it lands under a fixed scratch root. That is judged by the real directory it writes into, not by its spelling.
   - **A name that is not protected is not judged.** A write to `/tmp/g` goes through, whatever `/tmp/g` links to, as it does on main today.
   - **That route is closed where the link is made.** `ln`, and `cp` with a link flag (`-l`, `-s`, `--link`, `--symbolic-link`), are refused by name when any argument names a protected artifact, dangling or hard links included. Main refuses the `ln` forms today. It allows both `cp` forms (measured), so those two are refusals the cut adds.
   - **What stays outside.** A link made any other way is outside an accident guard, like the script-then-run route in Context.
   - **The detail goes in tests.** How the real directory is read, and the rows that pin it, belong to the cut. The rows: a link at the leaf, a dangling link, a hard link, a directory made in the same command. The cut writes them as a failure matrix in `test/bash-write-guard.test.ts` before its first push. Three review rounds on #2843 each found a new row, and a decision record is the wrong place to grow a matrix.

   This replaces the link-chain and step-order machinery (#1367). The cut's corpus sweep reports every command it newly refuses or newly allows, by name.
5. **What stays:**
   - the shell reader;
   - `interpreterPrograms` (`lib/issue-create-override.ts`);
   - `heredocReach` (SC-2750);
   - the refusals for `chmod`/`chflags` on a protected file and for `security` access to the salt.

## Not decided here

- **Real protection for local verdicts.** Options: a sandbox write-deny on the directory hooks execute from, a root-owned deployed hooks directory, or a signing key the agent cannot read. These are the controls that would stop a determined agent. They are not needed while CI decides merges. A sandbox on the live hooks directory also blocks the DA's own `git pull` in the primary checkout, so it needs a deploy step first. Decided in a later ADR, if harness mode returns.
- **Write and Edit of hook files.** Agents edit hooks in worktrees as normal work. Guarding the live tree on those tools belongs to the decision above.

## Criteria

Written in `specs/HOOK-ARCHITECTURE-SPEC.md` by `create-sc`, reserved in `specs/sc-reservations.json`. Quoted here once so the wording can be approved; the size limit is stated nowhere else in this record.

- SC-2810: lib/bash-write-guard.ts is between [100] and [2000] lines
- SC-2811: An interpreter body that names a protected artifact beside a declared write verb is refused by the bash write guard whatever directory it names (behavioral)

The shell reader alone is about 1,350 lines, so SC-2810's bound is about half of today's file.

## Decomposition

The first row's pull request also says `Fixes` for #2705, #2731 and #2772. Their defects live in the exemption it deletes, and each of their WITNESS rows must be refused after it.

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| SC-2811 | The write guard drops program-body reading and the interpreter scratch exemption | lib/bash-write-guard.ts, lib/interpreter-calls.ts, test/bash-write-guard.test.ts, test/interpreter-calls.test.ts | — | — |
| SC-2810 | The write guard is cut to the size SC-2810 states | lib/bash-write-guard.ts, test/bash-write-guard.test.ts, hooks/BashWriteGuard.hook.ts, specs/HOOK-ARCHITECTURE-SPEC.md | — | The write guard drops program-body reading and the interpreter scratch exemption |
