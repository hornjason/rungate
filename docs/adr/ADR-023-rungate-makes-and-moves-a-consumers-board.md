---
doc-type: adr
status: accepted
created: 2026-11-19
updated: 2026-11-19
---

# ADR-023 — Rungate makes, wires and moves a consumer's project board

## Status

**Accepted, 2026-11-19.** Filed under #2344. Jason decided the direction (decisions 1 to 3 below), and on 2026-11-19 accepted the six criterion texts in *Criteria* and both proposals under *Decided by Jason, 2026-11-19*. His merge of this file places the plan (`adr-accepted.yml`); until he merges it, nothing is filed.

## Context

Measured on main at `8bfb0e1e`, 2026-11-19, unless a line says otherwise.

- **Nothing makes a board.** No file in `lib/` or `scripts/` calls `createProjectV2`, `createProjectV2Field` or `updateProjectV2Field`. The only project mutation the scaffold emits is `addProjectV2ItemById`, in `lib/scaffold/board-intake-workflow.ts`. Under `board`, the scaffold writes `board.expediteLabel` and nothing else. This repository's own `board` block, with the project id, the field ids and the views, was written by hand.
- **Every board command assumes a board somebody else made.**
  - `board-id` refuses UNMEASURED without `board.id`.
  - `board-mirror` says its Criteria field "must already exist on the project — this does not create one".
  - `board-ready` and `board-intake-move` need a field named Status with the right options.
  - `readBoardConfig` in `lib/config-readers.ts` returns `null` unless both `board.id` and `board.fields.Criteria` are set.
- **GitHub's API can do all of it.** The live GraphQL schema, read 2026-11-19, has `createProjectV2`, `linkProjectV2ToRepository`, `createProjectV2Field`, `updateProjectV2Field`, `createProjectV2View` and `deleteProjectV2Workflow`.
- **Cards move only in this repository.**
  - `.github/workflows/board-flow.yml` starts "Not managed by rungate … This one is caller-owned". It is not in `OWNED_FILES` and not among the 11 workflows `lib/scaffold/steps.ts` emits; ADR-014 decision 6 left it out.
  - It runs `bun scripts/board-flow.ts`, which is not in `package.json` `files[]`, and reads the board from the variable `RUNGATE_PROJECT_ID` rather than `board.id`.
  - Its rules live in `laneFor` in `lib/board-flow.ts`:
    - assigned → In progress;
    - a pull request opened or marked ready → In review;
    - closed as completed → Done;
    - closed as not planned or duplicate → Cancelled;
    - reopened, or a pull request closed unmerged → Backlog.
  - Two of GitHub's built-in project automations were switched off on this board by hand on 2026-11-05. The only record is a comment.
- **`/board` and `/dry-run` are not rungate's in the place they are used.** The scaffold installs one command, `.claude/commands/dry-run.md`. The `/board` and `/dry-run` that run in every session are user-level skills an agent wrote in `~/.claude/skills/` (correction on #2344, 2026-11-18). The user-level `/board` reads only `hornjason/rungate`.
- **The pieces of the work loop do not ship.**
  - `scripts/work-status.ts` hard-codes `const REPO = "hornjason/rungate"`.
  - Neither `work-status.ts` nor `scripts/verify-merge-ref.ts` is in `files[]`, and neither is a CLI command.
  - `status-view.ts` is both, as `rungate board` (#2330), and it already resolves the repository from `--repo`, then `GITHUB_REPOSITORY`, then the origin remote.
- **Nothing checks the token can write the board.** `humanSteps` in `lib/scaffold/human-steps.ts` checks that a secret named `RUNGATE_PROJECT_TOKEN` exists, and nothing else. It does not check that `board.id` is set.
- **The consumer.** hornjason/asaCommandCenter pins rungate 0.8.26 and runs a 57-issue plan. Its agent has had to improvise every piece above, and was offered a hand-built board, which is what this ADR replaces.

## Decision

One rungate command makes a consumer's board and writes its ids into the config, and a second run changes nothing. Scaffold owns the workflow that moves cards, the `/board` command and a work-loop command. Each runs the published CLI against the repository it is in. `work-status` and `verify-merge-ref` become CLI commands that read the repository rather than a constant. Scaffold's report of human steps owed says whether the token can write the board. Nothing on a consumer's board is made, looked up or moved by hand.

## Decisions

1. **Rungate creates the board; nothing is hand-built — Jason, 2026-11-17.** His words, when offered a hand-built board for a consumer: "i thought rungate created one we would scaffold and own for consumers to use on their repo's ... no project creation option handfiled/crafted etc...this is part of the ability to move work effeciently through project/repo".
2. **Rungate's scaffolded `/board` and `/dry-run` replace the user-level skills — 2026-11-18, recorded on #2344.** Jason has no personal skills: the user-level ones were written by the agent, so there is no clash to settle. Once the scaffolded commands ship, the user-level copies are retired. That is an edit under `~/.claude`, which an agent here is denied, so it is a one-command hand step for Jason after the release and is not a row below.
3. **The work loop belongs in this ADR, not in a separate runner issue — 2026-11-17, agreed with the rungate session and recorded on #2344.** Jason's test: "i just dont want to duplicate issues if someting is working in rungate already but is carried forward to consumers". The loop is a session prompt plus scripts and rules, so carrying it forward means shipping the scripts and scaffolding the prompt.

## Decided by Jason, 2026-11-19

Both were open questions in the proposal. Jason accepted each as proposed.

- **Whose account owns a consumer's board.** `board-init` can create the project under the repository's owner, a user or an organisation, with the token the person running it holds. Decided: the repository's owner, with `--owner` to override. An organisation board needs a token with organisation project scope, which the human-steps row reports.
- **`census-routing` stays rungate's own.** #2344 listed it with the scripts to ship. Its triggers name this repository's census tests (`CENSUS_TRIGGERS` in `scripts/census-routing.ts`), so in a consumer it would print commands for test files that do not exist. Decided: it does not ship, and the work-loop command tells a consumer's agent to run its own `test.command` from config.

## Not decided here

- **The minimal profile.** `RULES_NOT_MINIMAL` in `lib/scaffold/profiles.ts` keeps `ship-workflow.md` out of the minimal profile. Its reason is about harness mode and does not hold in direct mode. Whether the minimal profile should get the direct-ship rule is a separate change.
- **Adopting a board somebody already made.** `board-init` adopts the project `board.id` names and adds only what is missing. It does not merge two boards, and it never deletes a field or an option it did not create.
- **Moving the consumer.** After the release, asaCommandCenter runs `board-init` once through its own session. That happens in another repository and is not a row here.
- **The Priority field and saved views beyond the one board layout.** Nothing reads them (ADR-021, *Context*).

## Criteria (Jason accepted these texts, 2026-11-19)

Each goes in `specs/SPEC-TO-BOARD-PIPELINE-SPEC.md`, under *The process reaches consumers through scaffold*, placed in Phase 7 beside SC-2742 to SC-2749, the other criteria of that section. Phase 10 is "strictly last, and the only phase whose subject is not this document"; these are criteria of this document (review of #2454). The ids are reserved to this branch in `specs/sc-reservations.json`.

**SC-2789, new:**

> `rungate board-init` makes a consumer's project board: it creates a project linked to the repository, or adopts the one `board.id` names. It gives the board the Status options Backlog, Ready, In progress, In review, Done and Cancelled, a Criteria text field and a board view by Status, turns off the built-in automations that move cards on close and on a linked pull request, and writes `board.id` and `board.fields` into `.claude/rungate/config.json`. A second run changes nothing. Anything it cannot create or read is named UNMEASURED, and no partial config is written.

**SC-2790, new:**

> `rungate scaffold` emits `.github/workflows/board-flow.yml` as an owned workflow that calls the published CLI and reads the board from `board.id`. A consumer's card then moves to In progress when its issue is assigned, to In review when a pull request for it opens, and to Done or Cancelled when it closes. This repository's copy is the generated one.

**SC-2791, new:**

> `rungate scaffold` installs `.claude/commands/board.md`, a `/board` command that runs the published CLI against the repository it sits in, and names no other repository.

**SC-2792, new:**

> `work-status` and `verify-merge-ref` run as `rungate` CLI commands, and ship in `files[]`. They read the repository from `--repo`, then `GITHUB_REPOSITORY`, then the origin remote, and never from a constant.

**SC-2793, new:**

> `rungate scaffold`'s report of human steps owed says whether `board.id` is set and whether the project token can write that board. Each is one OWED command or UNMEASURED with its reason, never "done".

**SC-2794, new:**

> `rungate scaffold` installs the work loop as `.claude/commands/work-loop.md`: pick from Ready with `rungate work-status`, claim the issue, work in a worktree off the default branch, test first with the project's own test command, open a pull request with `Fixes #N`, and merge pinned with `rungate verify-merge-ref`. It names only commands a consumer has.

## Decomposition

Each row serves a criterion above. The criterion lines and the Phase 7 placement are written in the spec by this ADR's pull request.

SC-2792 spans two rows, so they are ordered: the `verify-merge-ref` row waits on the `work-status` row and is the one that completes SC-2792. The `work-status` row titles its tests by its issue number, not by the criterion id, so `sync-sc-status` cannot tick SC-2792 on half of it.

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| SC-2789 | rungate board-init makes and wires a consumer's project board | lib/board-init.ts, scripts/board-init.ts, lib/cli-commands.ts, package.json, test/board-init.test.ts, docs/guides/HOW-WORK-FLOWS.md | Engine Phase 7 — nothing is hand-run | — |
| SC-2790 | board-flow.yml is generated for consumers and moves their cards | lib/scaffold/board-flow-workflow.ts, lib/scaffold/steps.ts, lib/scaffold/owned-files.ts, .claude/rules/harness-managed.md, .github/workflows/board-flow.yml, scripts/board-flow.ts, lib/cli-commands.ts, package.json, test/board-flow-workflow.test.ts | Engine Phase 7 — nothing is hand-run | — |
| SC-2792 | work-status runs as a rungate command and reads the repository it is in | scripts/work-status.ts, lib/cli-commands.ts, package.json, test/work-status.test.ts, test/package-closure.test.ts | Engine Phase 7 — nothing is hand-run | — |
| SC-2792 | verify-merge-ref runs as a rungate command | scripts/verify-merge-ref.ts, lib/cli-commands.ts, package.json, test/verify-merge-ref.test.ts, test/package-closure.test.ts | Engine Phase 7 — nothing is hand-run | work-status runs as a rungate command and reads the repository it is in |
| SC-2791 | Scaffold installs /board as a rungate command that reads its own repository | templates/process/board.md, lib/scaffold/process-files.ts, lib/scaffold/owned-files.ts, .claude/rules/harness-managed.md, .claude/commands/board.md, test/board-command.test.ts | Engine Phase 7 — nothing is hand-run | work-status runs as a rungate command and reads the repository it is in |
| SC-2793 | The human-steps report says whether the token can write the board | lib/scaffold/human-steps.ts, scripts/scaffold-project.ts, test/human-steps.test.ts | Engine Phase 7 — nothing is hand-run | rungate board-init makes and wires a consumer's project board |
| SC-2794 | Scaffold installs the work loop as a project command | templates/process/work-loop.md, lib/scaffold/process-files.ts, lib/scaffold/owned-files.ts, .claude/rules/harness-managed.md, .claude/commands/work-loop.md, test/work-loop-command.test.ts | Engine Phase 7 — nothing is hand-run | work-status runs as a rungate command and reads the repository it is in, verify-merge-ref runs as a rungate command |
