# Project State

**Current phase: Engine — a spec becomes a readable board, with nothing hand-run (ADR-009) — IN PROGRESS**

**Session 75 (2026-11-02)** — STAGE B IS COMPLETE. Every Pipeline reading is MET from main — B1 26/26, B2 26/26, B3 12/12, B4 12/12, B6 12/12 — and B2's verify, the stage's last open item, exits 0. Stage C is NOT started.

Three PRs landed it: #1714 recorded the eight criteria the tree already satisfies, #1715 wrote ADR-010 as the reviewed plan, #1723 filled its repair table with the issue numbers step one created. Then from the primary checkout: `plan-issues --repair` (4 annotate, 0 demote) and `board-mirror --ready --write`.

THE MECHANISM TO CARRY FORWARD: B2's reading is gated on board MEMBERSHIP, not on an issue existing. `criterion-coverage` credits a criterion only when its `satisfiedByIssue` is in `onBoard(b)`, so `--decompose --write` created seven issues and moved the number by nothing; `board-mirror --ready --write` is what moved it. And there are TWO doors, not one — an issue on the board, or `recordedTrue`. Eight of twenty-six went through the second, so the steady state is not one issue per criterion; ADR-003 names that as an anti-pattern and ADR-010's first draft had to be re-scoped from thirteen issues to seven.

WHAT WENT WRONG: I broke two already-ticked items with my own write commands and neither reported it. `--decompose --write` does not apply the `engine` label (B6 fell to 5 of 12), and `plan-deps --write` derives over all 49 issues carrying a `Phase N` milestone across two spec families while B3 resolves only against the 12 in `Pipeline Phase N` (B3 fell 12 to 7 to 4, 44 edges pointing at nothing). Both repaired by hand from a live snapshot. DO NOT RUN `plan-deps --write` here until that is fixed — `plan-issues --repair`'s own closing advice tells you to.

The two gaps are INDEPENDENT. The `engine` label is not upstream of the edges: `scripts/board-snapshot.ts` states that membership is *sits in a milestone whose title starts with the prefix*, not the label, and `lib/spec-deps.ts` reads no label at all.

WHAT NEEDS JASON: he asked for the two gaps filed as issues and the filing arbiter refused — this run had already filed #1704 today, the cap is 1 per 24h, no label waives it, and combining them into one issue was refused too because the cap counts filings rather than findings. The full content is a comment on #1722 ready to lift. He has since asked for the cap to be raised for engine work until the stages are complete; that is in flight on `rg/filing-cap-direct`.

Ratio: 37 opened against 8 closed over the seven days to 2026-11-02 — 4.6 to 1. Per Jason's standing correction it gates a SWARM on the backlog, not the engine work that shrinks it.

Suite: No full local suite — .claude/rules/parallel-sessions.md forbids a concurrent full run while other sessions hold worktrees. Census-routed per diff via `bun scripts/census-routing.ts`: the DA-owned state set plus test/stage-ladder.test.ts — 270 pass, 0 fail. The rewritten stage assertion was proved able to fail in both directions: COMPLETE_STAGES=3 against 2 real stages is red, and unticking B2 so only one stage is complete is red. On CI, #1724's `test` job and all four shards pass.

Read this before anything else. The suite is green under a CLEAN ENVIRONMENT, which is a stronger claim than the one this file made yesterday — run `bun scripts/test-clean-env.ts`, not `bun test`, before believing any gate. Plain `bun test` passes on this machine for reasons that have nothing to do with the code.

Pattern of the week, now found seven ways: checks that confirm something EXISTS rather than that it WORKS. Yesterday's five, plus two more from #71 — a test that stat'd a .gate-salt path abandoned in an earlier refactor and passed only because a leftover file sat on the developer's disk, and a documented `bunx tsc --noEmit` that had never type-checked a single file because no tsconfig.json existed.

The generalisable lesson from #71: when local and CI disagree, do not triage the failures one by one. Ask what the two environments differ by, remove it locally, and let the suite produce the list. My six-bucket hand triage was right about 28 of 28 failures but would have missed the eight tests that were passing on readdir order and the cluster that reports green while asserting nothing — the lever found those, the triage did not.
Suite: 25/25 SCs done.

**Next priorities:**
1. ISSUE INTAKE IS UNGOVERNED, AND THE STAGE B AUDIT OF 2026-11-02 IS WHY THIS IS A PRIORITY. Jason asked for an adversarial audit after Stage B closed, then asked three questions that each falsified the answer before it. Written here because rule 9 says an agreement is not real until it is in this file, and this record was four exchanges late.

MEASURED, all on 2026-11-02 against the live tracker:
  80 open issues; 55 carry a milestone (69%), 25 carry none.
  0 of 80 carry `What must become true`, the FIRST REQUIRED FIELD of `.github/ISSUE_TEMPLATE/spec-work.yml`. The form has never produced an issue.
  40 carry `Criteria this serves` and 31 `Files this will change` — not form submissions: #1722's body ends `Created by rungate plan-issues --decompose`, so the GENERATOR emits its own partial copy of the form's shape, 2 of its 5 fields, separately maintained. Two deciders about what an issue must contain, drifted, with nothing comparing them.
  The form CANNOT set a milestone — its own footer says so and tells the filer to run `gh issue edit` afterwards, and nothing checks that they did. That is the root of all 25.
  `filingAttempts` returns 1 for `gh issue create` and 0 for both `gh api repos/.../issues` and a `createIssue` GraphQL mutation. The gate covers ONE of three creation paths. Probed by execution, not read.

JASON'S DECISIONS, in order given: (a) build both /stage-audit and /round-rca; (b) close the gaps BEFORE building the skills; (c) a cross-repo filing gets a NEW `from-consumer` label and a triage milestone, not `external-audit`, which is a measurement stream counted separately; (d) the consumer-facing instructions ship as a SCAFFOLDED `.claude/rules/reporting-upstream.md` in the consumer repo, because an agent there has no reason to read rungate's docs; (e) ALL work issues belong on a board — he corrected me when I argued most should not, and the 69% says he is right; (f) the gate REFUSES a boardless same-repo filing rather than noting it.

THE DESIGN, NOT YET AGREED AND NOT YET BUILT: one decider for what an issue must carry, with the form, the gate and `--decompose` as its three consumers rather than three definitions. Milestone required when the target tracker is the repo you are in; PROVENANCE required instead when it is not, because a consumer cannot know another repo's taxonomy. A board that cannot be READ is UNMEASURED — allow and say so, never refuse, because this runs in a PreToolUse hook and #1725 already shipped one guard that made a harmless condition fatal.

OPEN AGAINST THIS: #1727 (--decompose sets no `engine` label), #1728 (plan-deps derives across every Phase family while board-conformance scores one). Both Claim 7. NOT YET FILED, allowance spent: the three creation paths, the form-vs-generator drift, and the heredoc hole — writing a body file with a heredoc in the SAME Bash command as `gh issue create` means the PreToolUse hook cannot read it, so the filing is recorded UNMEASURED and skips dedup entirely; #1727 and #1728 both went in that way.

TWO MORE DECISIONS, 2026-11-02, after an adversarial audit of the design above — and the second REORDERS the work.

A1, THE GATE SEES ONE OF THREE CREATION PATHS. Jason: teach the parser the other two. `filingAttempts` returns 1 for `gh issue create` and 0 for both `gh api repos/<o>/<r>/issues` and a `createIssue` GraphQL mutation, probed by execution. Widening the existing parser keeps ONE decider for *is this a filing*; a second matcher elsewhere would be two deciders over one input and a mutation of either would leave the other holding the case up.

A7, A STRICTER GATE PUSHES FINDINGS INTO COMMENTS NOBODY TRIAGES — AND THIS IS NOW FIRST. Jason: measure what refusals BECOME before tightening anything. The gate refused three filings in this session and I posted a comment instead each time, which is the exact shape of `feedback-a-metric-blind-to-the-bad-outcome`: issues-per-day falls identically whether a finding became a comment or was dropped, so a filing count cannot see the harm. /Users/jhorn/.rungate/finding-ledger.jsonl already records every refusal with its reason; what does not exist is a reading of what happened NEXT. Build that reading first, so the cost of every subsequent tightening is visible while it is being paid rather than after.

AGREED ORDER, and nothing starts before the one above it: (1) the refusal-outcome reading; (2) widen the parser to all three creation paths; (3) one decider for issue shape, with the form, the gate and --decompose as consumers — these must land TOGETHER, because the generator emits 2 of the form's 5 fields and a gate requiring the other 3 breaks every decompose run; (4) #1727; (5) #1728; (6) render the retro's open improvements in PROJECT-STATE.md, which today shows none; (7) re-run the Stage B audit, which is the only thing that makes its green REPRODUCIBLE rather than hand-placed; (8) /stage-audit and /round-rca. Stage C does not start before 7.

TWO THINGS THE DESIGN MUST SAY OUT LOUD OR SOMEBODY WILL 'FIX' THEM. A triage milestone is NOT a `<prefix> Phase <n>` milestone, so `phaseOf` will not match it and board-conformance will not score a `from-consumer` issue — that is CORRECT, and making Triage a Phase to 'complete the board' would redden every reading. And the gate checks the SHAPE of provenance, never its truth: it can see that a version string is present, not that it is the version the consumer ran.

FOUR THINGS FROM THE SAME CONVERSATION THAT THE ENTRY ABOVE DID NOT CARRY, added when Jason asked whether any of it had been lost. Three of them have no issue and no owner.

THE /round-rca DESIGN, which is a deliverable and existed only in a conversation. At the review round budget, do NOT re-scope on the trigger. Ask three questions IN ORDER and re-scope only if the third is yes: (1) IS THE ROUND COUNT REAL? `.github/workflows/ai-review.yml` sets `round="${total}"` where total is `total_count` from the workflow-runs API, so it counts RUNS, not reviewed commits — #1725 read 6 against 4, because each #1307 flake remediation is close/reopen and that is another run. #1592 already tracks the counter; do not re-file it. (2) IS THE FINDING REAL? #1725 rounds 5 and 6 both recommended consolidating two cap sites; killing each separately reddens DIFFERENT sets — 23 cases with 14 unique against 12 with 3 unique — which two deciders that agree cannot produce, so the recommendation would have deleted #1595's race fix. (3) IS THE WORK WRONG? Only then re-scope. Had the trigger alone been obeyed on #1725, a correct green PR would have been split and a race fix deleted.

TWO STAGE B AUDIT GAPS WITH NO ISSUE AND NO OWNER. (G3) Four of the eight retro improvements are `open`; imp7 and imp8 are now #1727 and #1728, but imp4 (*a measurement published in a PR body stops being a second copy that nothing compares*) and imp6 (*a finding naming one member of a population is checked for whether it IS a population before the sweep*) have NO issue, NO verify and no owner. They are the only wholly untracked items in the stage. (G4) `specs/SPEC-TO-BOARD-PIPELINE-SPEC.md` is 8 ticked of 26 and is UNBOUND in `audit-spec-evidence` — it does not declare `evidence: required`, so rule 6 (*the proof is a test, not a tick*) does not bind it and those 8 ticks are self-asserted.

THE ITEM 1 BASELINE, measured by hand on the 324-row ledger BEFORE building the reading, so the reading can be reconciled against it rather than believed: 102 refusals not emitted; 77 later emitted under the same symptomHash; 25 never. Of the 25, five DUPLICATE and one DROPPED_CATEGORY are CORRECT refusals and not harm, leaving 7 OVER_CAP + 6 NO_CLAIM + 1 NO_QUORUM + 5 COMMENT_INSTEAD = 19 refused for a reason that does not mean *wrong* and never reaching the tracker. The ledger answers two of three arms alone; whether those 19 became comments is UNMEASURED and must be named as such, never folded into *dropped*, which would overstate the harm. `gh issue comment` is as invisible to the parser as `gh api` is, so item 2 is what makes that arm measurable.

REPO HYGIENE, NOT STAGE B'S DOING AND NOT ON ANYONE'S LIST: 588 remote branches on origin besides main. Counted 2026-11-02. Squash merges mean `rev-list --count main..branch` reports a merged branch as ahead, so the count is a ceiling and the real backlog needs reading branch log subjects.
2. THE GOAL IS project-state.json`s top-level `goal` key — statement, the command that proves it, and the SUCCESS.md claim it serves. This entry is a pointer and deliberately does not restate it. Set 2026-10-30 by Jason, supersedes the 2026-10-23 SCOPE LOCK below. Decision record docs/adr/ADR-009-engine-goal-and-build-order.md, ON MAIN — PR #1685 merged 2026-10-31 as 4dcb9ff3, with the board identifiers in .claude/rungate/config.json under `board`. The goal text used to be duplicated here, in SUCCESS.md, in ~/.claude/FLEET-STATE.md and in ADR-009; three of those are now pointers and SUCCESS.md keeps it as claim 7 because SUCCESS.md is the charter. test/stage-ladder.test.ts asserts the claim it names exists.
3. THE STAGE LADDER AND THE GOALS ARE DATA, in this file, under the top-level `goal`, `goals` and `stages` keys. Read them there. This entry is a pointer and carries no checklist, no goal text and no done-condition of its own, deliberately. WHY: the definition of done used to live in three prose documents that nothing compared — ADR-009's stage table, ADR-009's goal table and this entry — so an agent reading any one of them read a complete, self-consistent answer with no way to discover the other two. Stage A was scored wrong twice that way. HOW IT IS HELD NOW: every item carries a `verify` shell command and a stage is complete when every command exits 0, derived and never asserted; every stage states its goal and which of the three agreed goals it serves; every completed stage carries a retro whose improvements each name the MECHANISM that enforces them, and nextStage refuses to advance past a complete stage that has none. lib/stage-ladder.ts is the one decider; test/stage-ladder.test.ts executes it. WHICH STAGE IS NEXT, AND WHETHER IT MAY BE STARTED, IS ALSO DATA — `nextStage` reads `agreed` and the retro gate and returns the answer. This entry does not name a stage, because the last version of it did and went stale the day Jason agreed Stage B's wording. LOOSE ENDS: commit 9f12ffd6 on rg/m12-proposal, 68 lines on no remote, headed 'the decision this needs from Jason'; and specs/HELP-SPEC.md, untracked and not on main.
4. BASELINES measured 2026-10-30 on origin/main at eae12e11, so a later reading can tell whether anything moved: 1 of 15 pipeline criteria proved by a test naming the id; 2 of 27 top-level specs carrying a Phase placement table; 71 open issues of which 46 name a criterion and 0 carry a blocked-by edge; 1131 of 1485 ticked criteria repo-wide satisfied by a symbol being present rather than a behaviour; 0 claims in SUCCESS.md naming the board, backlog or tracker; 0 repository locations recording the board node id before PR #1685.
5. THE DEFECT THIS EXISTS TO STOP. A criterion of the form `<file> contains [<symbol>]` is satisfied by a name being present. SC-2609 requires lib/board-mirror.ts to contain NAMES_NONE; it does, and its value is the empty string — satisfiable and false. That is how partial work reads as a finished plan. No criterion added under ADR-009 may be satisfied by a symbol existing. ADR-009 IS ON MAIN — PR #1685 merged 2026-10-31 as 4dcb9ff3, with the board identifiers in .claude/rungate/config.json under `board`.
6. LOOSE ENDS, both unmerged and invisible from GitHub: commit 9f12ffd6 in /Users/jhorn/Projects/rg-wt-m12-proposal is on no remote branch — 90 lines adding an increment-1 build plan to specs/CODE-REVIEW-CONVERGENCE-SPEC.md, containing a section headed the decision this needs from Jason; and specs/HELP-SPEC.md is untracked in /Users/jhorn/Projects/rg-wt-threads2 and not on main.
7. FLEET-STATE.md carried a goal set 2026-10-25 about making COMMENT_INSTEAD unwaivable, five days stale and about another subject, throughout the session that set this one. /goal reads that file. Re-point it before trusting any drift reading.
8. [SUPERSEDED — this is the 2026-10-23 convergence plan, kept for its ordering. The ACTIVE plan is the engine, items 1-6.] SCOPE LOCK (2026-10-23): all work is locked to specs/CODE-REVIEW-CONVERGENCE-SPEC.md. The build order is the section 'The order to build the remainder in' in that spec (landed via PR #1466). Do not pick criteria opportunistically — that is what produced three sessions in a row that ended in an analysis comment instead of code.
9. [SUPERSEDED — this is the 2026-10-23 convergence plan, kept for its ordering. The ACTIVE plan is the engine, items 1-6.] THE NUMBER THIS MOVES. Measured 2026-10-23 over the 44 most recent PRs that carried a ledger: passed-after-one-round 39.4% (blog before 65%, after 78%); five-or-more-rounds 20.5% (8.9% / 1.5%); mean rounds-to-pass 2.64 (2.08 / 1.32). We are WORSE than the state the source improved from, on all three. The tail is the damage, not the median — 20.5% is over twice their starting figure while the mean is only a quarter above it.
10. [SUPERSEDED — this is the 2026-10-23 convergence plan, kept for its ordering. The ACTIVE plan is the engine, items 1-6.] THE BACKLOG IS 30, NOT 47. Of the unticked criteria: 8 are mechanisms this tree cannot observe, 4 cannot be meaningful in this deployment (one human, one consumer), 2 are declared deviations, 3 are repository settings. Only 30 are engineering. The spec carried that split across four tables and nobody had summed them.
11. [SUPERSEDED — this is the 2026-10-23 convergence plan, kept for its ordering. The ACTIVE plan is the engine, items 1-6.] PHASE 0 — BLOCKED ON THE OWNER, NOT ON ENGINEERING. Three branch-protection settings, no code: CRC-F1 (strict:true), CRC-C3 (required_conversation_resolution), CRC-E8 (required_pull_request_reviews with dismiss_stale_reviews). First because CRC-E6 and CRC-M9 are VACUOUS rather than unbuilt until they land — there is no approval to count, so nothing can be built that counts one. Read CRC-F1's caveat before flipping it: a merge queue serialises merges, and on merge_group the review annotates UNMEASURED and passes, so 'every check' would be half true; strict:true is the cheaper half and closes the same hole.
12. [SUPERSEDED — this is the 2026-10-23 convergence plan, kept for its ordering. The ACTIVE plan is the engine, items 1-6.] PHASE 1 — STOP THE REPEATS. CRC-N4 (no repeats) depends on nothing and is the single highest-value item in the document: lib/ai-review-rounds.ts exports readLedger, priorFindings, carryForward, suppressRepeats, noRepeatsInstruction, atCapInstruction and reviewScopeForRound with ZERO production callers between the seven — every caller is a test. It is wiring, not design. A finding re-posted every round is arithmetically an extra round. Then CRC-B7 (needs the changed-file list reaching the adjudicator, then a release) and CRC-N2 (depends on N4; it is a declared deviation only until carryForward has a production caller).
13. [SUPERSEDED — this is the 2026-10-23 convergence plan, kept for its ordering. The ACTIVE plan is the engine, items 1-6.] PHASE 2 — STOP THE FALSE FINDINGS. CRC-B4 (verifier quorum) depends on nothing: lib/finding-jury.ts holds group size, quorum, per-verifier votes and a disagreement flag, and nothing deployed takes a vote. Then CRC-B6 (A/B the filters, variance bounded) and CRC-B3 (parallel generation) — B3 STRICTLY after B4, because without a quorum N generators are N chances to block falsely, which is worse than one. Run 39962683401 is the measured instance: a same-tree pair that disagreed BLOCKED/CLEAN with the false positive on the blocking side.
14. [SUPERSEDED — this is the 2026-10-23 convergence plan, kept for its ordering. The ACTIVE plan is the engine, items 1-6.] PHASES 3-6, in order and lower value. P3 what the reviewer is told (CRC-A4, B2, B9, A7) — sequenced after P2 on purpose, because context without a falsification step produces more confident false premises. P4 findings get answered (CRC-B8, A8, A2, A1, A3). P5 the instruments (CRC-M6, M10, M1, M3, M4, M5, M7, E3, E9). P6 release and detection (CRC-F3, F4, F5, N5, H2) — last because none of them moves rounds-to-pass.
15. [SUPERSEDED — this is the 2026-10-23 convergence plan, kept for its ordering. The ACTIVE plan is the engine, items 1-6.] WHAT WOULD FALSIFY THE PHASE ORDER. Re-take the CRC-M11 reading now #1449 and #1452 have landed. The 2.64 was measured across a harness defect that raised a blocking finding on EVERY pull request editing .claude/ or CLAUDE.md, which in this repository is how conventions ship. If the tail collapses on its own, Phases 1 and 2 are ordered against a baseline that no longer exists and the argument has to be made again rather than inherited.
16. [SUPERSEDED — this is the 2026-10-23 convergence plan, kept for its ordering. The ACTIVE plan is the engine, items 1-6.] RELEASE: DO NOT CUT ONE YET. npm serves rungate@0.8.2, published 2026-10-23T14:04:13Z; v0.8.2 was tagged 13:44:28Z; main has taken ~78 commits since. The ONLY dormant surface is lib/scaffold/ai-review-findings.ts and what it imports, because `bunx rungate@0.8.2 ai-review-findings` is the single pinned call in CI — everything else reaches CI live, either through `bun test` from the checkout or through committed generated YAML. So CRC-B7 (#1435) is dormant and CRC-B1 (#1387) is LIVE. A release now still activates nothing: main() takes the changed-file list as argv[1] and the generated step passes one argument, so CRC-B7 published is still inert. Correct order is #1356 first, then a release, then re-measure. See the comment on #1226.

## 🔄 Engine — a spec becomes a readable board, with nothing hand-run (ADR-009) (IN PROGRESS)

## 🔄 Code Review Convergence (CRC) — the PAYLOAD, sequenced behind the engine (IN PROGRESS)

## ✅ Phase 0+1 — Scaffold + Knowledge Extraction (COMPLETE)

## ✅ Phase 1.5 — Context Quality + Config-Driven Testing (A-H) (COMPLETE)

## ✅ Brief Compliance + Agent Brief Templates (COMPLETE)

## ✅ Instruction Compliance — Grading Pipeline (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-465 | Every directive has category (quality|process) |
| ✅ | SC-466 | Context/Always Do/Ask First → process |
| ✅ | SC-467 | All other sections → quality |
| ✅ | SC-468 | process_overrides frontmatter |

## 🔄 AES Quality Gate + Pipeline Optimization (IN PROGRESS)

## ✅ Scaffold Decomposition (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-358 | lib/scanner.ts with ProjectScan interface |
| ✅ | SC-359 | Scanner detects tech, specs, consumers, dirs |
| ✅ | SC-360 | AGENTS.md generator from ProjectScan |
| ✅ | SC-361 | Brief generator reads template files |
| ✅ | SC-362 | CODE-MAP generator from ProjectScan |
| ✅ | SC-363 | scaffold-project.ts under 200 lines |
| ✅ | SC-364 | Identical output before and after |
| ✅ | SC-365 | Scanner importable without generation |
| ✅ | SC-366 | Generators testable with mock data |

## ✅ Hook Architecture (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-367 | AgentBriefGuard under 50 lines |
| ✅ | SC-368 | lib/brief-validator.ts independently testable |
| ✅ | SC-369 | GateEnforcement under 100 lines |
| ✅ | SC-370 | Every hook traces to an SC |
| ✅ | SC-371 | No hook over 150 lines |
| ✅ | SC-372 | Hook logic in lib/ has unit tests |

## ✅ Gate Contracts (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-373 | Every gate has typed input/output |
| ✅ | SC-374 | Pass/fail criteria documented as SCs |
| ✅ | SC-375 | Gate chain order documented |
| ✅ | SC-376 | run-gate.ts under 400 lines |
| ✅ | SC-377 | Contracts testable by conformity engine |
| ✅ | SC-378 | No implicit state passing |

---

**Session 2026-11-02 session 75 (STAGE B IS COMPLETE — every reading MET from main):**
- STAGE B IS DONE. B2 was the last open item and its verify now exits 0 from main: `board-conformance --reading criterion-coverage` reads MET 26 of 26, and all five Pipeline readings are met — B1 26/26, B2 26/26, B3 12/12, B4 12/12, B6 12/12. This SUPERSEDES session 74's line saying B2 'has not been started in this session'. Three PRs landed it: #1714 recorded eight criteria the tree already satisfies, #1715 wrote ADR-010 (the reviewed plan), #1723 filled its repair table with the real issue numbers. Stage C is NOT started.
- THE MECHANISM NOBODY HAD WRITTEN DOWN: B2's reading is gated on board MEMBERSHIP, not on an issue existing. `criterion-coverage` credits a criterion only when its `satisfiedByIssue` is in `onBoard(b)`, so `plan-issues --decompose --write` created seven issues and moved the number by nothing. `board-mirror --ready --write` is what took it 13 to 20, and `plan-issues --repair` plus a second mirror took it to 26. Two doors satisfy a criterion, not one: an issue ON THE BOARD, or `recordedTrue`. Eight of the twenty-six went through the second door, so the steady state is NOT one issue per criterion — ADR-003 names that as an anti-pattern and the first ADR-010 draft had to be re-scoped from thirteen issues to seven.
- I BROKE TWO DONE ITEMS WITH MY OWN WRITE COMMANDS AND NEITHER COMMAND REPORTED IT. `--decompose --write` does not apply the `engine` label, so B6 fell to 5 of 12. `plan-deps --write` derives edges over every issue carrying a `Phase N` milestone — 49 of them, across TWO families, Pipeline and Convergence — while B3 resolves only against the 12 in `Pipeline Phase N`, so 44 edges became pointers at nothing and B3 fell 12 to 7 to 4. DO NOT RUN `plan-deps --write` on this repository until that is fixed, and note that `plan-issues --repair`'s own closing advice tells you to. Both were repaired by hand, from a live `board-snapshot` rather than a typed list.
- THE TWO GAPS ARE INDEPENDENT, and establishing that cost the most time this session. The `engine` label is NOT upstream of the edge resolution: `scripts/board-snapshot.ts` states by name that membership is *sits in a milestone whose title starts with the prefix*, not the label, and `lib/spec-deps.ts` reads no label at all. Labelling every issue correctly would not change one edge. The disagreement is the milestone PREFIX.
- WHAT NEEDS JASON: he asked for the two gaps to be filed as issues and the filing arbiter refused — this run had already filed #1704 today and the cap is 1 per 24h, waivable by no label, and combining them into one issue was refused too because the cap counts filings rather than findings. The full content is posted as a comment on #1722 (issues/1722#issuecomment-6582969086) with files, acceptance criteria and the independence argument, ready to lift into an issue. He has since asked for the cap to be RAISED for engine work until the stages are complete; that work is in flight on `rg/filing-cap-direct`.
- Ratio: 37 opened against 8 closed over the seven days to 2026-11-02 — 4.6 to 1. Recompute it, never relay it. Per Jason's standing correction it does not gate engine work; it gates a swarm on the backlog.

**Session 2026-11-02 session 74:**
- THE BOARD IS READABLE BY CI NOW, AND STAGE B'S LAST OPEN DEBT IS CLOSED.

Jason created a `read:project` token and added it as the repository secret `RUNGATE_PROJECT_TOKEN`. `ci.trackerTokenSecret` names it, the scaffold emits it into the generated test step, B4 is back on the DEFAULT scope and `CREDENTIALED_ALLOWED` is 0 — so CI executes B4's verify like any other item and the debt recorded hours earlier is paid rather than carried.

The config key names WHICH secret; `ci.suiteReadsTracker` still decides WHETHER. Two keys because they are two questions, and a consumer who names a secret and forgets the flag must not be handed a credential — asserted, in both workflow bodies.

A MALFORMED name THROWS rather than falling back to the built-in token. The fallback is the dangerous direction: the built-in token authenticates perfectly and cannot see a ProjectV2 board, so a typo in config would produce an UNMEASURED reading with nothing naming the cause. The same pattern is the injection guard — the value is interpolated into a `${{ }}` expression, so a name carrying `}}` would close it and write the rest into a consumer's pipeline. There is a case asserting an injection-shaped name never reaches the YAML, which is the half the refusal test cannot make on its own.

Three mutations, each red in exactly the predicted pair: removing the name pattern reddens the refusal and the injection case; making the generator ignore the configured name reddens both bodies' hand-over cases; letting a named secret turn the token on without the flag reddens both flag-off cases.

`scope: "credentialed"` STAYS in the scope list even though nothing uses it. It is the right answer the next time evidence sits behind a credential, and deleting it would mean rediscovering it under a red build.

ON THE RATIO, A CORRECTION FROM JASON: the issues-opened-against-closed count does NOT gate engine work. Building the engine is what reduces the backlog, so holding B2 because the ratio is 3.75 to 1 blocks the fix on the symptom. The ratio applies when a SWARM runs on the backlog, which is where three-to-one actually hurt. B2 is therefore unblocked on that ground; it has not been started in this session.

WHAT NEEDS JASON: nothing right now. One thing worth knowing rather than acting on — a classic PAT with `repo` scope is write-capable, and the whole test suite sees it on same-repo pull requests. A fine-grained token with read-only Projects, Contents and Issues would do the same job with less reach, and swapping it needs no code change because the secret name stays the same.

**Session 2026-11-02 session 73:**
- STAGE B'S FOUR ITEMS EXIT 0 FROM MAIN, AND B2 WAS NOT STARTED.

#1710 merged (45fa2a25). Ticked from main at that commit, each command run before the tick and not after:

  milestones          MET 26 of 26   exit 0   B1
  blocked-by-edges    MET 5 of 5     exit 0   B3
  criteria-field      MET 5 of 5     exit 0   B4
  queue-label         MET 5 of 5     exit 0   B6
  criterion-coverage  UNMEASURED     exit 1   B2 — NOT STARTED

B6 was the `engine` label on the five engine issues, and the population was derived live rather than taken from a carried-forward list: every open issue in a `Pipeline Phase N` milestone, which is #1675, #1677, #1678, #1680 and #1681. The reading already worked and said SHORT 0 of 5; nothing was built for it.

B2 IS NOT STARTED AND THAT IS JASON'S CALL, NOT A BLOCKER. It requires creating an issue per engine criterion, and the backlog is running at 30 opened against 8 closed over seven days — 3.75 to 1. Spending into a diverging backlog is a decision about the project, not something a counter decides quietly. Stage B is therefore five of six, and `stageIsComplete` says so: the retro is written, but the stage does not read complete and Stage C is not available. That is the honest state and it is derived, not asserted.

THE RETRO IS WRITTEN, with six improvements — three in-place with a command that proves each, three open and declared as open. The three in-place: a stage item CI cannot verify now says so by name through `scope: "credentialed"` bounded by an equality; a reading that could not be TAKEN is distinguishable from one that came back empty at every layer, through an absent key rather than a null; and two identifiers in one config block are compared, so a field copied from another project cannot be read as this board's.

THE WORST THING STAGE B DID, recorded as an open improvement because nothing enforces it yet: a number published in a PR body is a second copy of a measurement with nothing comparing them, and it went stale three times in one stage — `four API-backed items` when two was right, `31 pass` against a file holding 32 cases, and a session narrative saying `a fourth done item` after the test file had already been corrected. Every one was caught by a reviewer. In every one I had already fixed the number in the file.

WHAT NEEDS JASON, two things, neither urgent:
  1. B2 — whether to create issues against a 3.75-to-1 backlog.
  2. A `read:project` credential for CI. Without it B4 cannot be verified by CI at all, which is recorded as `scope: "credentialed"` with a constant that falls to zero the day the token exists. Granting CI a credential is his decision and was put to him on #1710.

STAGE C IS NOT STARTED.

