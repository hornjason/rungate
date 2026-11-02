# Project State

**Current phase: Engine — a spec becomes a readable board, with nothing hand-run (ADR-009) — IN PROGRESS**

**Session 73 (2026-11-02)** — STAGE B'S FOUR ITEMS EXIT 0 FROM MAIN, AND B2 WAS NOT STARTED.

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

Suite: No full local suite — .claude/rules/parallel-sessions.md forbids a concurrent full run while other sessions hold worktrees. Census-routed per diff: stage-ladder, prose-self-distance, closing-keywords, project-state-currency, project-state-shape, update-project-state, success-doc, distribution-standing and rule-lifecycle-spec — 284 pass, 12 todo, 0 fail across 9 files. Earlier in the day, on #1709: board-snapshot, live-issues, config-access-adoption, board-conformance, plan-deps, board-mirror and plan-spec — 323 pass, 0 fail — plus a 14-row mutation battery with zero holes. `bun run typecheck` at baseline throughout. CI ran the four shards on #1709, #1710 and #1711.

Read this before anything else. The suite is green under a CLEAN ENVIRONMENT, which is a stronger claim than the one this file made yesterday — run `bun scripts/test-clean-env.ts`, not `bun test`, before believing any gate. Plain `bun test` passes on this machine for reasons that have nothing to do with the code.

Pattern of the week, now found seven ways: checks that confirm something EXISTS rather than that it WORKS. Yesterday's five, plus two more from #71 — a test that stat'd a .gate-salt path abandoned in an earlier refactor and passed only because a leftover file sat on the developer's disk, and a documented `bunx tsc --noEmit` that had never type-checked a single file because no tsconfig.json existed.

The generalisable lesson from #71: when local and CI disagree, do not triage the failures one by one. Ask what the two environments differ by, remove it locally, and let the suite produce the list. My six-bucket hand triage was right about 28 of 28 failures but would have missed the eight tests that were passing on readdir order and the cluster that reports green while asserting nothing — the lever found those, the triage did not.
Suite: 25/25 SCs done.

**Next priorities:**
1. THE GOAL IS project-state.json`s top-level `goal` key — statement, the command that proves it, and the SUCCESS.md claim it serves. This entry is a pointer and deliberately does not restate it. Set 2026-10-30 by Jason, supersedes the 2026-10-23 SCOPE LOCK below. Decision record docs/adr/ADR-009-engine-goal-and-build-order.md, ON MAIN — PR #1685 merged 2026-10-31 as 4dcb9ff3, with the board identifiers in .claude/rungate/config.json under `board`. The goal text used to be duplicated here, in SUCCESS.md, in ~/.claude/FLEET-STATE.md and in ADR-009; three of those are now pointers and SUCCESS.md keeps it as claim 7 because SUCCESS.md is the charter. test/stage-ladder.test.ts asserts the claim it names exists.
2. THE STAGE LADDER AND THE GOALS ARE DATA, in this file, under the top-level `goal`, `goals` and `stages` keys. Read them there. This entry is a pointer and carries no checklist, no goal text and no done-condition of its own, deliberately. WHY: the definition of done used to live in three prose documents that nothing compared — ADR-009's stage table, ADR-009's goal table and this entry — so an agent reading any one of them read a complete, self-consistent answer with no way to discover the other two. Stage A was scored wrong twice that way. HOW IT IS HELD NOW: every item carries a `verify` shell command and a stage is complete when every command exits 0, derived and never asserted; every stage states its goal and which of the three agreed goals it serves; every completed stage carries a retro whose improvements each name the MECHANISM that enforces them, and nextStage refuses to advance past a complete stage that has none. lib/stage-ladder.ts is the one decider; test/stage-ladder.test.ts executes it. WHICH STAGE IS NEXT, AND WHETHER IT MAY BE STARTED, IS ALSO DATA — `nextStage` reads `agreed` and the retro gate and returns the answer. This entry does not name a stage, because the last version of it did and went stale the day Jason agreed Stage B's wording. LOOSE ENDS: commit 9f12ffd6 on rg/m12-proposal, 68 lines on no remote, headed 'the decision this needs from Jason'; and specs/HELP-SPEC.md, untracked and not on main.
3. BASELINES measured 2026-10-30 on origin/main at eae12e11, so a later reading can tell whether anything moved: 1 of 15 pipeline criteria proved by a test naming the id; 2 of 27 top-level specs carrying a Phase placement table; 71 open issues of which 46 name a criterion and 0 carry a blocked-by edge; 1131 of 1485 ticked criteria repo-wide satisfied by a symbol being present rather than a behaviour; 0 claims in SUCCESS.md naming the board, backlog or tracker; 0 repository locations recording the board node id before PR #1685.
4. THE DEFECT THIS EXISTS TO STOP. A criterion of the form `<file> contains [<symbol>]` is satisfied by a name being present. SC-2609 requires lib/board-mirror.ts to contain NAMES_NONE; it does, and its value is the empty string — satisfiable and false. That is how partial work reads as a finished plan. No criterion added under ADR-009 may be satisfied by a symbol existing. ADR-009 IS ON MAIN — PR #1685 merged 2026-10-31 as 4dcb9ff3, with the board identifiers in .claude/rungate/config.json under `board`.
5. LOOSE ENDS, both unmerged and invisible from GitHub: commit 9f12ffd6 in /Users/jhorn/Projects/rg-wt-m12-proposal is on no remote branch — 90 lines adding an increment-1 build plan to specs/CODE-REVIEW-CONVERGENCE-SPEC.md, containing a section headed the decision this needs from Jason; and specs/HELP-SPEC.md is untracked in /Users/jhorn/Projects/rg-wt-threads2 and not on main.
6. FLEET-STATE.md carried a goal set 2026-10-25 about making COMMENT_INSTEAD unwaivable, five days stale and about another subject, throughout the session that set this one. /goal reads that file. Re-point it before trusting any drift reading.
7. [SUPERSEDED — this is the 2026-10-23 convergence plan, kept for its ordering. The ACTIVE plan is the engine, items 1-6.] SCOPE LOCK (2026-10-23): all work is locked to specs/CODE-REVIEW-CONVERGENCE-SPEC.md. The build order is the section 'The order to build the remainder in' in that spec (landed via PR #1466). Do not pick criteria opportunistically — that is what produced three sessions in a row that ended in an analysis comment instead of code.
8. [SUPERSEDED — this is the 2026-10-23 convergence plan, kept for its ordering. The ACTIVE plan is the engine, items 1-6.] THE NUMBER THIS MOVES. Measured 2026-10-23 over the 44 most recent PRs that carried a ledger: passed-after-one-round 39.4% (blog before 65%, after 78%); five-or-more-rounds 20.5% (8.9% / 1.5%); mean rounds-to-pass 2.64 (2.08 / 1.32). We are WORSE than the state the source improved from, on all three. The tail is the damage, not the median — 20.5% is over twice their starting figure while the mean is only a quarter above it.
9. [SUPERSEDED — this is the 2026-10-23 convergence plan, kept for its ordering. The ACTIVE plan is the engine, items 1-6.] THE BACKLOG IS 30, NOT 47. Of the unticked criteria: 8 are mechanisms this tree cannot observe, 4 cannot be meaningful in this deployment (one human, one consumer), 2 are declared deviations, 3 are repository settings. Only 30 are engineering. The spec carried that split across four tables and nobody had summed them.
10. [SUPERSEDED — this is the 2026-10-23 convergence plan, kept for its ordering. The ACTIVE plan is the engine, items 1-6.] PHASE 0 — BLOCKED ON THE OWNER, NOT ON ENGINEERING. Three branch-protection settings, no code: CRC-F1 (strict:true), CRC-C3 (required_conversation_resolution), CRC-E8 (required_pull_request_reviews with dismiss_stale_reviews). First because CRC-E6 and CRC-M9 are VACUOUS rather than unbuilt until they land — there is no approval to count, so nothing can be built that counts one. Read CRC-F1's caveat before flipping it: a merge queue serialises merges, and on merge_group the review annotates UNMEASURED and passes, so 'every check' would be half true; strict:true is the cheaper half and closes the same hole.
11. [SUPERSEDED — this is the 2026-10-23 convergence plan, kept for its ordering. The ACTIVE plan is the engine, items 1-6.] PHASE 1 — STOP THE REPEATS. CRC-N4 (no repeats) depends on nothing and is the single highest-value item in the document: lib/ai-review-rounds.ts exports readLedger, priorFindings, carryForward, suppressRepeats, noRepeatsInstruction, atCapInstruction and reviewScopeForRound with ZERO production callers between the seven — every caller is a test. It is wiring, not design. A finding re-posted every round is arithmetically an extra round. Then CRC-B7 (needs the changed-file list reaching the adjudicator, then a release) and CRC-N2 (depends on N4; it is a declared deviation only until carryForward has a production caller).
12. [SUPERSEDED — this is the 2026-10-23 convergence plan, kept for its ordering. The ACTIVE plan is the engine, items 1-6.] PHASE 2 — STOP THE FALSE FINDINGS. CRC-B4 (verifier quorum) depends on nothing: lib/finding-jury.ts holds group size, quorum, per-verifier votes and a disagreement flag, and nothing deployed takes a vote. Then CRC-B6 (A/B the filters, variance bounded) and CRC-B3 (parallel generation) — B3 STRICTLY after B4, because without a quorum N generators are N chances to block falsely, which is worse than one. Run 39962683401 is the measured instance: a same-tree pair that disagreed BLOCKED/CLEAN with the false positive on the blocking side.
13. [SUPERSEDED — this is the 2026-10-23 convergence plan, kept for its ordering. The ACTIVE plan is the engine, items 1-6.] PHASES 3-6, in order and lower value. P3 what the reviewer is told (CRC-A4, B2, B9, A7) — sequenced after P2 on purpose, because context without a falsification step produces more confident false premises. P4 findings get answered (CRC-B8, A8, A2, A1, A3). P5 the instruments (CRC-M6, M10, M1, M3, M4, M5, M7, E3, E9). P6 release and detection (CRC-F3, F4, F5, N5, H2) — last because none of them moves rounds-to-pass.
14. [SUPERSEDED — this is the 2026-10-23 convergence plan, kept for its ordering. The ACTIVE plan is the engine, items 1-6.] WHAT WOULD FALSIFY THE PHASE ORDER. Re-take the CRC-M11 reading now #1449 and #1452 have landed. The 2.64 was measured across a harness defect that raised a blocking finding on EVERY pull request editing .claude/ or CLAUDE.md, which in this repository is how conventions ship. If the tail collapses on its own, Phases 1 and 2 are ordered against a baseline that no longer exists and the argument has to be made again rather than inherited.
15. [SUPERSEDED — this is the 2026-10-23 convergence plan, kept for its ordering. The ACTIVE plan is the engine, items 1-6.] RELEASE: DO NOT CUT ONE YET. npm serves rungate@0.8.2, published 2026-10-23T14:04:13Z; v0.8.2 was tagged 13:44:28Z; main has taken ~78 commits since. The ONLY dormant surface is lib/scaffold/ai-review-findings.ts and what it imports, because `bunx rungate@0.8.2 ai-review-findings` is the single pinned call in CI — everything else reaches CI live, either through `bun test` from the checkout or through committed generated YAML. So CRC-B7 (#1435) is dormant and CRC-B1 (#1387) is LIVE. A release now still activates nothing: main() takes the changed-file list as argv[1] and the generated step passes one argument, so CRC-B7 published is still inert. Correct order is #1356 first, then a release, then re-measure. See the comment on #1226.

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

**Session 2026-11-02 session 72:**
- THE BOARD COLUMN IS READ NOW, AND IT COULD NOT HAVE BEEN READ FROM THE ISSUE QUERY AT ALL.

#1709 merged (90ddf1ae). B4 exits 0 from main: `criteria-field` MET 5 of 5. The Criteria column is a Projects v2 CUSTOM FIELD, and `gh issue list --json projectItems` returns Status and nothing else — so the reading was UNMEASURED by construction, not because the column was empty. All five engine issues already carried a value; B4 was the read, never the population.

Three targeted GraphQL reads, each by number rather than by sweeping the repository: `readProjectFieldIdentity(fieldId)` resolves the configured field id to its NAME and its owning project, `readProjectFieldValues` reads the column for the engine issues only, and `readBoardConfig` is the config accessor. The field name is DERIVED from the id and never configured: `fieldValueByName` is the only value query GitHub offers, and a name sitting in config beside the id would be two identifiers for one field, free to disagree, with a rename on the board reading every value as blank and saying nothing.

`board.id` and `board.fields.Criteria` have sat in one config block since #1685 with nothing relating them. They are compared now — a field whose owning project is not the configured board is refused, because a Criteria field copied from another project's config answers perfectly well and the answers look exactly like a measurement of ours.

FOUR states, not two: value, empty, off-board, truncated. Empty and off-board both mean the column is not populated for this issue, which is what the reading asks, so both emit null; truncated omits the key, because an item list cut before this project was reached does not say whether the issue is on the board. A FAILED project read omits the key rather than refusing the whole snapshot — the deliberate call, published on the PR: the column feeds one reading, while `milestones` and `blocked-by-edges` are met and polled unattended, so refusing would turn a B4 outage into a B1 and B3 outage.

A 14-row mutation battery, zero holes, every predicted test red. It found two PRE-EXISTING cases asserting `criteriaField` is never emitted that were passing only because the fixture's project id did not match this repository's config — an accident, not a measurement. Both now pin a board-less project root.

Three review rounds, all three findings real. Round 1 named three unawaited `.rejects` assertions; there were ELEVEN in the tree and all eleven are fixed. The finding's stated failure mode was falsified by measurement rather than accepted: mutating the throw to a resolve turned both cases RED, and so did a scratch case whose promise settles on a later tick, so Bun holds a pending `.rejects` open and attributes it to the test. The `await` still went in — it is runner-independent — and NO census guard was added, because Bun already decides this and a scan would be a second decider for a property the runner enforces at runtime. Round 2 was a docblock orphaned by an insertion; the sweep found 87 stacked docblock pairs in the tree and declined to treat them as a population, because a section docblock above a symbol docblock is this tree's ordinary spelling and the defect is narrower — exactly one introduced here.

ROUND 3 WAS DECLINED UNDER RULE 5, AND IT NAMED A REAL GAP. The value query matches `... on ProjectV2ItemFieldTextValue` only, and nothing asserts the configured field IS text. Measured: `dataType` is TEXT today, so nothing is misreported. But retype the column to single-select and the fragment stops matching, `text` is absent, and every issue reads empty → null → SHORT 0 of 5 — a WRONG reading produced by a change that raises no error, which is the one thing this work claims it never does. Not filed as an issue: nobody would act on it with Stage B closing and the backlog at 3.75 to 1. It is carried into Stage B's retro with a mechanism and a verify instead.

CI CANNOT READ THE BOARD, AND THE LADDER NOW SAYS SO RATHER THAN GOING RED.

B4's verify passed locally and failed in CI on run 41406458500. Not a flake and not a timeout: the Criteria column is a ProjectV2 custom field on a USER-level project, and `secrets.GITHUB_TOKEN` is repository-scoped, so the one token CI holds structurally cannot see it. B1 and B3 — milestones and issues, both repository resources — passed in the SAME shard with the SAME token, which is the control that names the variable.

`scope: "credentialed"` is a third item scope, beside `repo` and `machine`. It is deliberately not `machine`: that word says the evidence sits on one operator's disk, and a reader who believes it looks in the wrong place. The item is not executed by the ladder, it is COUNTED and NAMED, and `CREDENTIALED_ALLOWED` is an equality — so a second one cannot appear quietly, and the constant falls the day CI gains a `read:project` token. Counted on the DECLARATION rather than on a failure, so the case reads the same on a laptop holding a PAT and on a runner holding none; a tally that differs by environment measures the environment. Five mutations, all red in the predicted cases: dropping B4's scope, marking B5 credentialed too, shrinking `ITEM_SCOPES`, making the validator reject a LISTED scope, and hardcoding the refusal message so it omits the new one.

The ladder also got a time budget. Ticking B4 added one more done item that calls the live API — a THIRD, not a fourth: B5 runs `--list-readings` and opens no connection, and B4 itself stopped being executed the moment it became `credentialed`, so the loop runs two today. Bun's 5s default cut `spawnSync` mid-call and the item came back as `B4 exited null`, which is the same text a genuine refusal produces. The budget states no count at all now: two revisions of that comment carried one and both were wrong, and a number in a comment is a second decider that nothing runs. What catches a budget gone tight is the failure message naming `exited null` and saying to raise the constant.

WHAT WOULD CLOSE THE DEBT: a `read:project` token in CI. That is a credential grant and Jason's call, not something to do quietly.

STAGE B: B1, B3, B4 and B5 all exit 0 from main. B6 remains and needs only the `engine` label on the five engine issues — the reading already works and says SHORT 0 of 5. B2 is NOT being started.

WHAT NEEDS JASON: 30 issues opened against 8 closed in seven days, 3.75 to 1. One of the thirty is mine. Nothing else needs him right now.

**Session 2026-11-02 session 71:**
- TWO DECIDERS THAT AGREED WAS THE DEFECT, AND THE FIX WAS A DELEGATION RATHER THAN A SECOND REPAIR.

#1705 merged (f8ac754b). `plan-deps` and `board-snapshot` both ask which milestones belong to a spec's family, and they asked it with two different spellings that agree on every input anybody had tried — the fourth shape in `.claude/rules/checks-must-be-able-to-fail.md`, where no behavioural test can tell which one is holding a result up. `lib/spec-placement.ts`'s `phaseInFamily(title, prefix)` is now the only compiled copy of the `<prefix> Phase N` anchor; `inMilestoneFamily` is DEFINED as that parse succeeding, and `milestonePlan`'s own `phaseOf` delegates to it. A census in `test/live-issues.test.ts` asserts the anchor is compiled in exactly one file, because the behavioural cases cannot see a second copy that agrees today — a battery confirmed it, reverting the delegation to an identical regex turned nothing red.

`--prefix` is one reading now too, with three states. `readMilestonePrefix` returns absent/blank/given. `plan-deps` had been testing `raw.trim() === ""` for emptiness while filtering with the UNTRIMMED `raw`, so `--milestone-prefix " Pipeline"` passed the guard, matched nothing, and refused naming a string that looks like it should obviously match. `plan-spec` and `board-snapshot` had the same split reversed — `if (!prefix)` admits `"   "`, and `plan-spec --write` would have created milestones called `"    Phase 1 — …"` on the live tracker. The POPULATION is guarded, not the three sites repaired: a test refuses any command declaring a `--prefix` string option that decides for itself.

Every refusal in `plan-deps` and `plan-spec` now honours `--json`. A caller parsing stdout used to get usage text on four and six paths respectively, which is a crash where a reading was asked for.

Three review rounds, six findings, every one real and every one answered by fixing the whole population rather than the member named. Round 3 was `low` and AGENTS.md rule 5 was applied — declined, with the reasoning published on the PR saying what a fourth round would fix. KNOWN AND DELIBERATELY UNFIXED, recorded there and not filed: `plan-deps` reads the API before checking a blank prefix, and `plan-spec --json --write` prints `wrote: "yes"` BEFORE `applyMilestones` runs.

STAGE B: B1 and B3 both exit 0 from main. B3 landed as #1706 and is ticked by #1708. `blocked-by-edges` resolved every `blocked by` number against the OPEN engine population, so a FINISHED blocker was indistinguishable from a typo — both simply absent — and the reading would have flipped MET to SHORT the first time an engine issue closed, reddening B3's verify on correct work. The producer now resolves only the numbers an edge names that the open population could not answer, and emits them as `closedBlockers`; an absent key makes the reading UNMEASURED rather than silently narrowing. NOT a full closed-issue read, which answers the same question: measured here, 72 open issues against 805 in total turns one GraphQL page into nine on a command CI runs and an unattended loop polls, and a 502 was observed on it. Ten mutations across two batteries, every row red in exactly the predicted tests.

CI on main was red at f8ac754b for `project-state currency` — this entry is what clears it. The suite is one shard behind the tree whenever a PR lands and nothing records it here, which is the file lying about where the project is.

WHAT NEEDS JASON: 30 issues opened against 7 closed in seven days, 4.3 to 1 — worse than the 3.6 recorded yesterday, and the shape of the swarm he stopped. One of the thirty is mine (#1704, closed by #1706). B2 is NOT being started: it requires creating issues, and whether to spend into a diverging backlog is his call rather than something a counter decides quietly.

