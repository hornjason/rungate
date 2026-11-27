---
doc-type: adr
status: accepted
created: 2026-11-26
updated: 2026-11-27
---

# ADR-030 — A consumer sets nothing by hand: seven gaps from one DDB day

## Status

**Accepted, 2026-11-27.** Jason accepted this ADR as drafted on 2026-11-27 ("yes file it accepted"), including his rulings on decisions 1 and 2. The DDB consumer session reported the gaps on 2026-11-26. The rungate session drafted the ADR, numbered it, and wrote its criteria; the wording of SC-2820 to SC-2822 and CRC-B14 to CRC-B16 below is for him to approve by merging. The status is set to accepted on this branch, so his merge is the step that places the plan, as decision 1 requires. Filed as #2917, which this ADR's pull request closes. Still open: everything under "Not decided here".

## Context

Jason's rule: someone who uses rungate should never have to set anything by hand. On 2026-11-26 the session working on DDB (hornjason/asaCommandCenter, pinned to rungate 0.8.48) did ten things by hand. Each was checked against rungate main at `3d2c6262f`, and against DDB's own runs and pull requests.

**Getting an ADR's plan onto the tracker**

1. **Issues landed in no phase.** DDB #2460–#2477 were created at 17:45Z with no milestone, and the session milestoned all 18 by hand at 19:03Z. `adr-accepted.yml` runs `plan-spec` for the engine spec, then `plan-issues --decompose`, then `plan-deps`. It never runs `plan-issues --place` (`lib/scaffold/adr-accepted-workflow.ts`). This is already filed as #2895.
2. **The ADR's Milestone column had to say `—`.** `plan-issues --decompose` refuses a milestone that does not exist yet (`lib/issue-decomposition.ts`). That refusal is deliberate: only `plan-spec` makes milestones. DDB's "Upstream Phase 4" was created at 16:33Z, after the ADR was written. Once #2895 places issues by their criteria, `—` is the right value and the column is no longer needed. A gap remains, though. `adr-accepted.yml` makes milestones only for `board.engineSpec` (DDB's is the `CI` family). `--place` refuses the whole run when any issue belongs to a phase that has no milestone yet (`scripts/plan-issues.ts`). So an ADR whose merge also adds a phase to another family, as "Upstream" here, turns that run red. `specs-placed.yml` already runs `plan-spec` for every family before it places (`lib/scaffold/specs-placed-workflow.ts`).
3. **A proposed ADR was merged, so nothing was placed.** A "family" here means the phase milestones that share a name prefix and come from one spec. `plan-issues --accepted-since` lists an ADR only when its frontmatter changes to `status: accepted` (`lib/issue-decomposition.ts`). The process rule tells the owner to merge it (`.claude/rules/alignment-process.md`, AGENTS.md rule 9 steps 2–3). The template tells the author to leave it `proposed` until the owner accepts it (`docs/adr/TEMPLATE.md`). Nothing says who changes the status, or when. Jason merged DDB #2455 while it still said proposed, and #2458 was opened only to change the status. Rungate did the same three times: #2634→#2643, #2843→#2854, #2857→#2880.
4. **Criterion ids were picked by searching for the highest one.** `create-sc` sets its root to the package's own directory (`scripts/create-sc.ts`), and it is registered without `projectRootFlag` (`lib/cli-commands.ts`). Run from a consumer, it allocates against rungate's packaged files and ignores the consumer's specs and `specs/sc-reservations.json`. A scratch consumer on 0.8.49 was set up with SC-10, SC-50 and a reserved block 200–210. Given `--owner` for that block, `create-sc --behavioral` wrote **SC-2809**, and said "no reservation store at specs/sc-reservations.json". `sync-sc-status` had this exact defect and was fixed in #2360 (`lib/cli-commands.ts`). The "prose criteria do not fit" half is a version gap: `--behavioral` shipped in 0.8.49 (#2846), and DDB is on 0.8.48.

**The merge path**

5. **Auto-merge was turned on by hand on DDB #2458.** See "By design, not changed".
6. **The AI review "did not complete" and was re-run by hand.** On DDB run 45858831620, attempt 1, run 2 of 3 failed in about one second: "Failed to check permissions: HttpError: Unable to connect". Runs 1 and 3 succeeded. A second DDB run, 45892096619 on #2483 (head `3cc3731b`), failed four attempts on 11-26. Attempts 1 and 3 could not resolve `claude.ai` or `api.github.com`, the Linux runners' DNS outage from 20:27Z that ended when the runner VM restarted on 11-27. Attempt 2 failed in the step that refuses a reviewer that modified the tree. It listed 32 paths as absent: every file under `.claude/` (agents, commands, rules, `rungate/`) and `CLAUDE.md`. That is the whole config the review action sets aside and restores, not a file a reviewer would edit, so why they were missing is UNMEASURED. One review round is three reviewer runs, merged into one result (`lib/scaffold/ai-review-step.ts`, ADR-025 decision 2). A round where any run failed never counts as a pass (`lib/ai-review-drafts.ts`), so the job failed. Nothing retries a reviewer run. The only retry in the job is the round counter's (`ai-review-step.ts`). DDB's second instance, #2423 on 11-25, was not reproduced: its only listed review run is attempt 1, success.
7. **The same false finding twice.** On DDB #2455 and again on #2458 the reviewer reported that a comma in a Blocked by cell would split one blocker into two. The plan-issues dry run linked both blockers correctly, and both threads were answered "not a defect". The reviewer can use only Read, Grep, Glob and Write (`ai-review-step.ts`), so it cannot run that dry run. Nothing in the review job mentions `plan-issues` or a Decomposition table.

**Seeing and dispatching work**

8. **The goal had to be written into a second file.** `work-status` and `rungate board` read the goal from `project-state.json`'s `goal.statement`, and need `goal`, `goals` and `stages` (`lib/stage-ladder.ts`, `scripts/work-status.ts`, `scripts/status-view.ts`). The scaffold creates `project-state.json` with only `updated`, `priorities`, `notes`, `phases` and `sessions` (`lib/scaffold/steps.ts`). DDB's file has exactly those keys, so every plan view reads UNMEASURED. Every consumer already states its goal in SUCCESS.md's `## The thing`, which `create-success` creates.
9. **The work lanes were built by hand.** See "By design, not changed".

**Config**

10. **A model pin was removed by hand.** DDB's `ci.vertex.model: claude-sonnet-5` was typed in by hand in DDB #1939 (rungate's scaffold never writes `ci.vertex`). It was removed in DDB #2425. The scaffold honours a pin over the default (`ai-review-step.ts`), as ADR-025 decision 1 allows. Nothing reports that a pin differs from the default, so this one silently kept the old model after the default moved to `claude-haiku-5-5`.

## Decision

Once every row below ships:

- An accepted ADR's issues land in their phases on the merge that accepts it, whichever spec family the phases are in.
- A pull request cannot merge an ADR that carries a plan while it still says `proposed`.
- `create-sc` allocates in the project it runs in.
- A reviewer run that failed before the reviewer started is retried once.
- An ADR pull request's review sees how `plan-issues` reads its table.
- The plan views show a consumer's goal from SUCCESS.md.
- A re-scaffold names a model pin that differs from rungate's default.

## Decisions

1. **A proposed ADR with a plan cannot be merged — Jason's ruling, 2026-11-27.** "Merge means accepted" is rejected. The check fails while any ADR in the pull request has a Decomposition table and a status other than `accepted`. It runs in the `closing-references` job, which branch protection already requires. The author changes the status to `accepted` in the same pull request once the owner agrees, and the owner then merges it. The alternative was to treat the owner's merge itself as acceptance. That leaves a file reading `proposed` on main next to a plan that was placed. It also cannot tell the owner's merge from a bot's: DDB's approve-on-green merges any green pull request that edits no workflow, ADRs included, so treating a merge as acceptance would let a bot accept a plan.
2. **#2895 is widened to cover item 2 — Jason's ruling, 2026-11-27.** One fix makes every spec family's milestones (the `plan-issues --families` loop that `specs-placed.yml` uses) and then runs `--place`, so there is no separate row for the milestone pass. The template's Milestone guidance then says `—`: the merge places the issue in its criterion's phase.
3. **`create-sc` takes `--project-root` like `sync-sc-status` — the DA recommends.** Ids, the reservation store and the deferral bank are all read from the consumer's tree.
4. **Retry only a run that never started — the DA recommends.** A run whose step failed and wrote no execution file did not reach the model, so running it once more changes nothing about what is measured. A run that started and failed is still reported as it is today. The rule that a pass is never measured from fewer runs than planned stays.
5. **Review evidence, not a REVIEW.md line — the DA recommends.** When the pull request changes a `docs/adr/*.md` file that has a Decomposition table, the job writes `plan-issues --decompose <adr> --json` (the dry run, with no `--write`) to a file in the findings directory, the same way it passes the intent and the changed-file list. The prompt tells the reviewer that this file is how the filing tool parsed the table.
6. **One goal source per project: SUCCESS.md for a consumer — the DA recommends.** When `project-state.json` has no `goal`, the plan views show SUCCESS.md's `## The thing` and say where it came from. Stages without a ladder read "no stages written", not UNMEASURED for the whole plan. Rungate's own ladder is unchanged.
7. **A model pin is reported, not removed — the DA recommends.** ADR-025 decision 1 leaves the model to the consumer. Scaffold prints a note naming the pin and the default, and says that removing the key follows the default.

## Not decided here

- Whether `work-status` should show the work that can start now when a project has no board (see item 9). That is Jason's call between this and `board-init`.
- Whether the `closing-references` refusal in decision 1 warns by default and refuses only when a variable is set, as `RUNGATE_REQUIRE_CLOSING_REF` does today. The row's review settles it.
- DDB's own `approve-on-green.yml` (item 5) is DDB's file, so any change to it belongs to DDB.
- Whether the tree guard should tell a config the review action set aside and never restored apart from a reviewer's edit (item 6, DDB #2483 attempt 2). That run is the only instance, and its mechanism is UNMEASURED, so it gets no row until a second run shows how it happens.

## By design, not changed

- **Item 5, arming auto-merge.** Rungate generates no merge workflow. ADR-022 records that DDB's merges come from "the consumer's own auto-merge workflow" (`docs/adr/ADR-022-a-bot-merge-still-places-and-closes.md`). DDB's approve-on-green approved #2458 and then printed "NOT MERGING: PR #2458 has 2 unresolved review thread(s) … re-run this workflow for PR #2458 or merge by hand" (run 45865461182). It states that resolving a thread re-runs nothing (DDB `.github/workflows/approve-on-green.yml`). Its own fix for this is `gh workflow run approve-on-green.yml -f pr=N`, not `gh pr merge --auto`. It chose an immediate merge pinned to the head commit over `--auto` on purpose.
- **Item 9, the work lanes.** ADR-023 decision 1 says rungate makes the consumer's board, with `board-init` run once by the consumer's session (`docs/adr/ADR-023-rungate-makes-and-moves-a-consumers-board.md`). The scaffold's human-steps report lists a missing `board.id` as a `board-init` still owed (`lib/scaffold/human-steps.ts`). `work-status` reads Ready from the board on purpose (`scripts/work-status.ts`) and stops when `board.id` is unset. It already computes the unblocked, unclaimed issues and the file overlaps between them. If Jason prefers no board, the smallest change is to move that check so that only the lane sections need a board. DDB has not run `board-init` (its `board` block has no `id`).
- **Item 2, the refusal itself.** Refusing a milestone that does not exist is deliberate (`lib/issue-decomposition.ts`). What decision 2 removes is the hand step that followed it.

## Decomposition

#2895 is already filed. Widened, it is the work for items 1 and 2: its body gains the milestone pass for every family and two more files, `templates/process/adr-template.md` and `docs/adr/TEMPLATE.md`. That edit is made when Jason accepts this ADR. Its title contains a comma, so it cannot be a row: an Outcome cannot contain one, and a different title would file a duplicate. The draft had the proposed-ADR row blocked by #2895. That edge is dropped. The refusal reads the pull request's own ADR and does not depend on what an accepted merge places. An engine issue blocked by an issue in no engine phase also reads short on `board-conformance`'s blocked-by-edges, on every pull request's live check. The three engine criteria are SC-2820 to SC-2822, reserved in `specs/sc-reservations.json` for this branch. The three review criteria are CRC-B14 to CRC-B16, after ADR-025's CRC-B13, in Phase 2 with it.

Three rows change `lib/scaffold/ai-review-step.ts`. That is a file overlap, not an ordering, so it has no blocked-by edge. `work-status` reports the overlap.

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| SC-2820 | A pull request carrying a proposed ADR with a plan is refused | lib/issue-decomposition.ts, scripts/plan-issues.ts, lib/scaffold/closing-references-workflow.ts, .github/workflows/closing-references.yml, lib/scaffold/process-rules.ts, .claude/rules/alignment-process.md, test/issue-decomposition.test.ts, test/closing-references-workflow.test.ts | — | — |
| SC-2821 | create-sc allocates and writes in the project it runs in | scripts/create-sc.ts, lib/cli-commands.ts, test/create-sc.test.ts | — | — |
| CRC-B14 | A review run that failed before the reviewer started runs once more | lib/scaffold/ai-review-step.ts, lib/ai-review-drafts.ts, test/ai-review-drafts-merge.test.ts, .github/workflows/ai-review.yml | — | — |
| CRC-B15 | An ADR pull request's review reads the plan-issues dry run | lib/scaffold/ai-review-step.ts, test/ai-review-plan-evidence.test.ts, .github/workflows/ai-review.yml | — | — |
| SC-2822 | The plan views read the goal from SUCCESS.md when no plan is written | lib/work-status.ts, lib/success-doc.ts, scripts/status-view.ts, scripts/work-status.ts, test/status-view.test.ts, test/work-status.test.ts | — | — |
| CRC-B16 | Scaffold names a review model pin that differs from the default | lib/scaffold/ai-review-step.ts, scripts/scaffold-project.ts, test/ai-review-model-alias.test.ts | — | — |
