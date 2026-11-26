---
doc-type: adr
status: accepted
created: 2026-11-26
updated: 2026-11-26
---

# ADR-029 — The harness ship skill is renamed ship-issue

## Status

**Accepted, 2026-11-26, on merge.** Jason chose the name on 2026-11-26 ("2882: ship-issue"). Filed as #2882. The status is set to accepted on this branch, so his merge is the only step that places the plan. The wording of SC-2819 below is for him to approve by merging.

## Context

Claude Code now has a built-in `/ship`: commit, push, open a pull request, and watch it until merged. The harness's ship skill has the same name. In this session's skill list the built-in shows as `ship-local (ship)`, so the two collide. An agent or a person asking for "ship" can get the wrong one. The DailyBriefDashboard consumer reported it on 2026-11-26.

Measured on main at `7c0713e38`:

- **23 files name the skill** (`git grep -E 'Skill\(["'"'"']ship["'"'"']\)|skills/ship\b|/ship\b'`), with 78 matches. They fall into three groups:
  - **Text rungate generates for consumers.** `lib/ship-mode.ts` writes `.claude/rules/ship-workflow.md` for every consumer. In harness mode it says `Skill("ship") → Workflow(...)`; in direct mode it says not to call `Skill("ship")`. Its test is `test/ship-mode.test.ts`. `lib/scaffold/profiles.ts` names it in a profile description.
  - **Code that reads the skill's folder by name.** Two readers build `~/.claude/skills/ship/brief-policies.json` from parts (`"skills", "ship"`), which the search above cannot see. `validateAgentBrief` in `lib/agent-brief-validation.ts` reads it as the brief guard's policies. `loadBriefPolicies` in `gates/brief-assembler.ts` layers it, as a local override, over the `config/brief-policies.json` the package ships. On this machine the folder holds only `SKILL.md` and `profiles/`, so both reads find nothing today. The hook is registered per user, so another machine's folder may hold the file. (Review round 1 found the second reader.)
  - **Rungate's own instructions and specs.** `CLAUDE.md`, `specs/HARNESS-STANDARD.md`, `specs/HARNESS-SKILL-CHAIN.md` and a comment in `test/argument-shape-refusal.test.ts` name it. The rest are dated records (`docs/adr/`, `docs/research/`, `reference/`), which keep the old name, as records do.
- **The skill itself is not in this repository.** It is `~/.claude/skills/ship/` in Jason's own configuration. Its `SKILL.md` has no `name:` line, so the folder's name is the skill's name.
- **One consumer runs in harness mode.** DailyBriefDashboard's config sets no `ship.mode`, which means `harness`, and its generated rule tells agents to call `Skill("ship")`. This repository is in direct mode.

## Decision

Once both rows ship and the steps below are done, the harness ship skill is `ship-issue`. Rungate tells agents to call `Skill("ship-issue")` everywhere it generates or keeps live text, and the built-in `/ship` is the only skill called `ship`.

## Decisions

1. **The new name is `ship-issue` — Jason, 2026-11-26.** It ships one tracked issue through the gates, which the built-in does not.
2. **Both names exist for a window, and the old one goes last.** The issue proposed renaming rungate's text first, then the folder, then re-scaffolding consumers. That order breaks a harness-mode consumer in between. After the folder is renamed, its rule still names `Skill("ship")`, which then reaches the built-in. If rungate's text moves first and the folder has not, its rule names a skill that does not exist yet. So:
   1. **Jason adds `~/.claude/skills/ship-issue/`** as a copy of `skills/ship/`, before any harness-mode consumer takes the release below. I hand him a tested script for it, because I cannot write `~/.claude`.
   2. **Row 1 lands and is released.** Rungate's generated rule and brief guard name `ship-issue`.
   3. **Consumers bump and re-scaffold.** DailyBriefDashboard is the only harness-mode consumer today.
   4. **Jason removes `~/.claude/skills/ship/`** once every consumer's pin is at or past that release. From then on `ship` means the built-in only.
3. **A consumer still on an older pin after step 4 reaches the built-in.** That is the accepted risk, and it fails safe: the built-in's own instructions tell an agent never to call it itself, only to ask the user to type `/ship`. So the agent stops and asks; it does not commit and push. Rungate keeps no alias, because an alias named `ship` is the collision this removes.
4. **Both brief-policy readers look in `skills/ship-issue/` first, then `skills/ship/`.** A machine where the step-1 copy was never made keeps its policies instead of silently losing them, which is the one-laptop fail-open `gates/brief-assembler.ts` already warns about (#1174). Once the old folder is gone, the second look finds nothing and costs nothing. Review round 1 corrected the first draft, which moved one reader with no fallback.
5. **Internal names stay.** `workflows/ship.js`, `ship.run.js`, the `.ship-active` marker and the `ship.mode` config key collide with nothing a user can call. Renaming them would touch every consumer's config for no gain.

## Not decided here

- **Renaming the workflow file or the config key.** Decision 5 keeps them. Revisit only if a second collision appears.
- **The dated records.** ADRs, research notes and `reference/` keep `Skill("ship")` as written. SC-2819's test excludes them by directory.

## Criteria

Written in `specs/HARNESS-STANDARD.md`, in a section of its own at the end. The id is reserved in `specs/sc-reservations.json` for this branch, and the reservation is released once the line is on main. Quoted here once so the wording can be approved:

- SC-2819: No file rungate generates for a consumer, and no live source, spec or test of rungate's own, tells an agent to invoke the ship skill by its old name; they name `Skill("ship-issue")`, only dated records under `docs/adr/`, `docs/research/` and `reference/` keep the old name, and every reader of the local brief-policy override looks in `skills/ship-issue/` before `skills/ship/`

The criterion names the old call only in words, never as the literal, so its own test does not flag the line that states it (review round 1). Row 1 does not complete SC-2819. Row 2 does, because its test reads both the scaffold's output and rungate's own tree.

## Decomposition

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| SC-2819 | Rungate's generated ship rule and both brief-policy readers name the ship-issue skill | lib/ship-mode.ts, test/ship-mode.test.ts, .claude/rules/ship-workflow.md, lib/scaffold/profiles.ts, lib/agent-brief-validation.ts, test/unit/agent-brief-guard-ship.test.ts, gates/brief-assembler.ts, gates/brief-assembler.test.ts | — | — |
| SC-2819 | Rungate's own instructions and specs name the ship-issue skill and a test refuses the old name | CLAUDE.md, specs/HARNESS-STANDARD.md, specs/HARNESS-SKILL-CHAIN.md, test/argument-shape-refusal.test.ts, test/ship-skill-name.test.ts | — | Rungate's generated ship rule and both brief-policy readers name the ship-issue skill |
