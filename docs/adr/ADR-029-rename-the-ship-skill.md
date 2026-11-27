---
doc-type: adr
status: accepted
created: 2026-11-26
updated: 2026-11-27
---

# ADR-029 — The harness ship skill is renamed ship-issue

## Status

**Accepted, 2026-11-26, on merge.** Jason chose the name on 2026-11-26 ("2882: ship-issue"). Filed as #2882, which this ADR's pull request closes; the rename itself is the four rows below. The status is set to accepted on this branch, so his merge is the only step that places the plan. The wording of SC-2819 is for him to approve by merging.

Review round 2 found that this repository already has a `/ship-issue` command (`.claude/commands/ship-issue.md`). Decision 6 retires it. If Jason would rather keep the command and give the skill another name, that is his call before merging.

Review round 3 left two changes to Jason, and he chose them on 2026-11-27 ("2900 1"): the command's retirement is its own unblocked row, which step 1 waits for, and every read of the skill's folder goes through one resolver, which SC-2819 now names.

## Context

Claude Code now has a built-in `/ship`: commit, push, open a pull request, and watch it until merged. The harness's ship skill has the same name. In this session's skill list the built-in shows as `ship-local (ship)`, so the two collide. An agent or a person asking for "ship" can get the wrong one. The DailyBriefDashboard consumer reported it on 2026-11-26.

Measured on main at `7c0713e38`:

- **23 files name the skill** (`git grep -E 'Skill\(["'"'"']ship["'"'"']\)|skills/ship\b|/ship\b'`), with 78 matches. They fall into four groups:
  - **Text rungate generates for consumers.** `lib/ship-mode.ts` writes `.claude/rules/ship-workflow.md` for every consumer. In harness mode it says `Skill("ship") → Workflow(...)`; in direct mode it says not to call `Skill("ship")`. Its test is `test/ship-mode.test.ts`. `lib/scaffold/profiles.ts` names it in a profile description.
  - **Code that reads the skill's folder.** Three readers build a path under `~/.claude/skills/ship/` from parts (`"skills", "ship"`), which the search above cannot see:
    - `validateAgentBrief` in `lib/agent-brief-validation.ts` reads `brief-policies.json` as the brief guard's policies;
    - `loadBriefPolicies` in `gates/brief-assembler.ts` layers the same file, as a local override, over the `config/brief-policies.json` the package ships;
    - `executeGate` in `gates/gate-executor.ts` falls back to `ceremony-profiles.json` there when none sits beside the module.

    Two tests read the folder too: `gates/workflow.test.ts` (`spec-policies.json`) and `gates/e2e-smoke.test.ts`. On this machine the folder holds only `SKILL.md` and `profiles/`, so every read finds nothing today. The hook is registered per user, so another machine's folder may hold the files. Review rounds 1 and 2 each found a reader the first count missed.
  - **A command with the new name.** `.claude/commands/ship-issue.md` is rungate's own `/ship-issue` command, written on 2026-09-30. It routes into `Skill("harness")`, not the ship skill, and the scaffold does not ship it to consumers. `test/command-contracts.test.ts` sweeps it.
  - **Rungate's own instructions and specs.** `CLAUDE.md`, `specs/HARNESS-STANDARD.md`, `specs/HARNESS-SKILL-CHAIN.md` and a comment in `test/argument-shape-refusal.test.ts` name it. The rest are dated records (`docs/adr/`, `docs/research/`, `reference/`), which keep the old name, as records do.
- **The skill itself is not in this repository.** It is `~/.claude/skills/ship/` in each user's own configuration. Its `SKILL.md` has no `name:` line, so the folder's name is the skill's name.
- **One consumer runs in harness mode.** DailyBriefDashboard's config sets no `ship.mode`, which means `harness`, and its generated rule tells agents to call `Skill("ship")`. This repository is in direct mode.

## Decision

Once the four rows ship and the steps below are done, the harness ship skill is `ship-issue`. Rungate tells agents to call `Skill("ship-issue")` everywhere it generates or keeps live text, nothing else of rungate's answers to `/ship-issue`, and the built-in `/ship` is the only skill called `ship`.

## Decisions

1. **The new name is `ship-issue` — Jason, 2026-11-26.** It ships one tracked issue through the gates, which the built-in does not.
2. **Both names exist for a window, and the old one goes last.** The issue proposed renaming rungate's text first, then the folder, then re-scaffolding consumers. That order breaks a harness-mode consumer in between. After the folder is renamed, its rule still names `Skill("ship")`, which then reaches the built-in. If rungate's text moves first and the folder has not, its rule names a skill that does not exist yet. So:
   1. **Jason adds `~/.claude/skills/ship-issue/`** as a copy of `~/.claude/skills/ship/`, once the row that retires rungate's own `/ship-issue` command has merged, and before any harness-mode consumer takes the release below. The command and the skill then never both answer to `/ship-issue` (review round 3). I hand him a tested script for it, because I cannot write `~/.claude`.
   2. **The generated rule's row and the resolver's row land and are released.**
   3. **Consumers bump and re-scaffold.** DailyBriefDashboard is the only harness-mode consumer today.
   4. **Jason removes `~/.claude/skills/ship/`** once every consumer's pin is at or past that release. From then on `ship` means the built-in only.

   Step 1 runs on one user's machine. On any other machine, a re-scaffolded consumer's rule names a skill that is not installed there. So the generated rule's harness-mode text says what to do when `Skill("ship-issue")` is not available: invoke the ship workflow directly, which the rule already names (review round 2).
3. **A consumer still on an older pin after step 4 reaches the built-in.** That is the accepted risk, and it fails safe: the built-in's own instructions tell an agent never to call it itself, only to ask the user to type `/ship`. So the agent stops and asks; it does not commit and push. Rungate keeps no alias, because an alias named `ship` is the collision this removes.
4. **Every read of the skill's folder goes through one exported resolver, `lib/ship-skill-folder.ts`, which looks in `~/.claude/skills/ship-issue/` first, then `~/.claude/skills/ship/`.** Today that is the brief guard, the gates' brief-policy override, the ceremony-profile fallback and two tests. Rounds 1 to 3 each found a reader the hand-kept list had missed, because three of them build the path from parts. With one resolver, SC-2819's test refuses any other spelling of the path instead of checking a list (review round 3). A machine where the step-1 copy was never made keeps its files instead of silently losing them, which is the one-laptop fail-open `gates/brief-assembler.ts` already warns about (#1174). Once the old folder is gone, the second look finds nothing and costs nothing.
5. **Internal names stay.** `workflows/ship.js`, `ship.run.js`, the `.ship-active` marker and the `ship.mode` config key collide with nothing a user can call. Renaming them would touch every consumer's config for no gain.
6. **The repository's own `/ship-issue` command is retired.** A project command and a user skill that share a name are the same collision this ADR removes. The command duplicates an entry point into the harness, and the skill is the entry point this ADR keeps. Its own row deletes it and updates the command sweep. That row depends on nothing, and step 1 waits for it (review round 3).

## Not decided here

- **Renaming the workflow file or the config key.** Decision 5 keeps them. Revisit only if a second collision appears.
- **The dated records.** ADRs, research notes and `reference/` keep `Skill("ship")` as written. SC-2819's test excludes them by directory.

## Criteria

Written in `specs/HARNESS-STANDARD.md`, in a section of its own placed just before the #836 section, which a battery record requires to stay last. The id is reserved in `specs/sc-reservations.json` for this branch, and the reservation is released once the line is on main. Quoted here once so the wording can be approved:

- SC-2819: No file rungate generates for a consumer, and no live source, spec or test of rungate's own, tells an agent to invoke the ship skill by its old name; they name `Skill("ship-issue")`, only dated records under `docs/adr/`, `docs/research/` and `reference/` keep the old name, no command of rungate's own answers to `/ship-issue`, and every read of a file in the skill's folder goes through one exported resolver, which looks in `~/.claude/skills/ship-issue/` before `~/.claude/skills/ship/`

The criterion names the old call only in words, never as the literal, so its own test does not flag the line that states it (review round 1). The rows before the last do not complete SC-2819. The last row does, because its test reads the scaffold's output, every read of the folder and rungate's own tree.

## Decomposition

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| SC-2819 | Rungate's generated ship rule names the ship-issue skill and falls back to the workflow when it is missing | lib/ship-mode.ts, test/ship-mode.test.ts, .claude/rules/ship-workflow.md, lib/scaffold/profiles.ts | — | — |
| SC-2819 | Rungate's own ship-issue command is retired | .claude/commands/ship-issue.md, test/command-contracts.test.ts | — | — |
| SC-2819 | One resolver finds the skill folder and every source reader uses it | lib/ship-skill-folder.ts, test/ship-skill-folder.test.ts, lib/agent-brief-validation.ts, test/unit/agent-brief-guard-ship.test.ts, gates/brief-assembler.ts, gates/brief-assembler.test.ts, gates/gate-executor.ts, gates/orchestrator.test.ts | — | — |
| SC-2819 | Rungate's own instructions and specs name the ship-issue skill and a test refuses the old name | CLAUDE.md, specs/HARNESS-STANDARD.md, specs/HARNESS-SKILL-CHAIN.md, test/argument-shape-refusal.test.ts, gates/workflow.test.ts, gates/e2e-smoke.test.ts, test/ship-skill-name.test.ts | — | Rungate's generated ship rule names the ship-issue skill and falls back to the workflow when it is missing, One resolver finds the skill folder and every source reader uses it, Rungate's own ship-issue command is retired |
