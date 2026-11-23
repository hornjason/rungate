/**
 * Covers SC-1636..SC-1640 (CONFIG-DRIVEN-TESTING-SPEC.md), #441.
 *
 * `UNMATCHED_CHECKED_RATCHET` counted checked SCs the engine can build no
 * assertion for, and read that number as debt: "marked done, carry no
 * assertion, and are therefore wishes by this project's own rule."
 *
 * That reading was right at 54. It stopped being right once the repo started
 * writing criteria about REFUSALS, because the registry's whole vocabulary —
 * file-exists, content-contains, count-threshold, json-field-equals — is
 * claims about the STATE OF THE TREE, and no state of a tree expresses "X
 * refuses, and says which of two things happened".
 *
 * So 239 → 242 → 252 → 258 across #397, #398 and #399, for criteria that are
 * every one of them covered by executed tests. The only way to lower it was
 * to rewrite them as weaker claims about file contents — lowering the number
 * by making the spec say less. A ratchet that rises whenever an issue writes
 * a good behavioural criterion is measuring the matcher's vocabulary, not the
 * project's honesty.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { scScanTestTimeout } from "./helpers/sc-scan-budget";
import {
  splitUnmatchedChecked,
  unclaimedCensusResidue,
  uncoveredTickedScs,
} from "../lib/sc-cover";
import { claimedScKeys, scopedKey } from "../scripts/sync-sc-status";

// This file reaches the whole-tree scan through `claimedScKeys` (#1271). It
// was the WORST case in #1223 — 7958ms and 8192ms — and carried no budget,
// because the roster matched entry-point spellings in a test file's own
// source and this one's call is a level down. Measured 4093ms at load 160,
// against the 5000ms it used to inherit.
setDefaultTimeout(scScanTestTimeout());

const REPO = join(import.meta.dir, "..");
const SPECS = join(REPO, "specs");

/**
 * Checked, unmatchable, and no test file declares it.
 *
 * This is the half the old docblock actually meant, and it is a ratchet: it
 * may fall freely, and a rise means a criterion was ticked with nothing
 * testing it.
 *
 * It is NOT the primary refusal. 153 of these 153 are in the census
 * `test/ticked-sc-cover.test.ts` already ratchets PER SPEC, both directions,
 * naming the ids — so banking a second global number here would be two
 * deciders answering one question, and a mutation of either would leave the
 * other holding every case up. The subset relation is asserted below instead,
 * which is what makes this number safe to carry: it cannot drift away from
 * the ratchet that does the refusing.
 */
// 153 -> 152 on 2026-10-22 (#1161). SC-453 of INSTRUCTION-COMPLIANCE-SPEC.md
// left the unclaimed half by withdrawal: it named `runBehavioralCompliance`,
// which has no declaration, export, caller or test anywhere in the tree, and
// is now a SUPERSEDED pointer to SC-242, the unticked criterion tracking the
// same thing. The subset relation asserted below carried the edit — the
// per-spec census in `test/ticked-sc-cover.test.ts` moved by the same one.
//
// 152 -> 150 on 2026-10-22 (#1217). Three criteria of
// bootstrap-data-flow/success-criteria.md were unticked — SC-108 and SC-135,
// one orphaned `workflow-state.json` field each, and SC-237, a JSON schema
// for a file nothing writes — and two of them were in the unclaimed half.
// The per-spec census moved 120 -> 118 in the same commit.
const UNCLAIMED_RATCHET = 150;

/**
 * Checked, unmatchable, and a test file DOES declare it.
 *
 * Tracked and reported; it does not fail the suite. This is a measure of the
 * registry's vocabulary, and the honest way down is a matcher shape that can
 * express a refusal — see the recorded decision in
 * CONFIG-DRIVEN-TESTING-SPEC.md — not a rewritten criterion.
 *
 * Asserted only for non-vacuity, in both directions. A floor, because a zero
 * here would mean the split collapsed and every assertion below it would hold
 * over an empty set. A ceiling, because "tracked" has to mean somebody
 * notices it moving, and a number nothing can refuse is a number nobody
 * lowers.
 */
// 100 -> 66 on 2026-10-17 (#574). A criterion whose only test was a
// `test.todo` was being counted as claimed, and a todo claims nothing: 34
// of the 100 were ids named by a test that can never run. The number moved
// because the question got stricter, not because anything was bound.
//
// 66 -> 72 on 2026-10-19 (#704). Six criteria about the hill-climb's section
// selector, every one of them driven by `test/hill-climb-section-selector.test.ts`
// against the real `applyHillClimb`, and none of them expressible as a claim
// about the state of the tree: "one binding with exactly one call site",
// "`## Project Constraints` outranks the COMP's own primary", "the brief on
// disk is byte-identical after a refusal". This is the number rising for the
// reason the docblock above says it rises for.
//
// 72 -> 73 on 2026-10-21 (#544/#545). One criterion, about the ORDER two
// candidates come back in: a candidate carrying no observed failure never
// outranks one that does. `test/failure-intake-promotion.test.ts` drives the
// real `rankForPromotion` and `promoteCandidates` over a pair built to make
// both a string compare and a hash-order sort get it wrong, so it is bound by
// an executed test — and it is unmatchable for the reason the docblock gives,
// because no claim about the state of the tree expresses a comparator's
// answer. Same rise, same cause as #704's six.
//
// 73 -> 81 on 2026-10-21 (#1009). Eight criteria about the auto-loaded
// instruction surface check, all driven by `test/instruction-surface-budget.test.ts`
// against the real script and a mutant of it. Unmatchable for the reason the
// docblock gives: every one is a claim about what the check DOES to an input
// — refuses an unmeasured tree, excludes a path-scoped rule, keeps the budget
// within 35% of what it measures — and no file-exists pattern expresses the
// behaviour of a predicate on a planted tree.
//
// 81 -> 86 on 2026-10-21 (#544). Five criteria about the max-concurrent-load
// budget, same check and same battery: the peak reading and the file that
// produces it, the refusal that names the overlapping rules, the absence of
// a count cap, the glob that matches everything, and the per-rule glob
// limits. Unmatchable for the same reason — each is a claim about what the
// predicate returns for a planted tree, which no file-exists pattern states.
//
// 86 -> 87 on 2026-10-21 (#544). SC-1941, auto-retirement: a claim about
// what `retireUnresolvable` returns for a candidate citing a commit that is
// not in the history, and for the same candidate against a real shallow
// clone. Unmatchable for the same reason — no file-exists pattern expresses
// a three-armed reading over a planted git repository.
//
// 87 -> 91 on 2026-10-23. The first four criteria of
// CODE-REVIEW-CONVERGENCE-SPEC.md to be bound to anything: CRC-A6 (a check
// reads the action's own execution transcript for the reviewer's load of
// REVIEW.md), CRC-B5 (a style, diagnostics or cleanup filing is refused at
// the `gh issue create` chokepoint the hook calls), CRC-C4 (`synchronize`
// re-runs the review on every push, so a repaired defect is simply not found
// again) and CRC-N1 (the round cap). All four rose for the reason the
// docblock above gives: each is a claim about what a predicate, a generated
// bash step or a hook DOES to an input, and no file-exists pattern states
// that. The fifth criterion ticked in the same commit, CRC-A5, is in neither
// half — `REVIEW.md` exists is matchable, so the registry builds its
// assertion and the split never sees it.
// 91 -> 94 on 2026-10-23 (#1437): CRC-E1, CRC-E2 and CRC-E4 ticked, claimed
// by `test/risk-tier.test.ts`, and unbindable for the same reason as the four
// above — "the change sets the tier, not the author" is a claim about what a
// classifier DOES to an input, and no file-exists pattern states that. The
// battery that stands in for a matchable assertion here is five mutations of
// `lib/risk-tier.ts` with membership predicted before each run, recorded on
// #1437; all five matched.
// 94 -> 95 on 2026-10-23 (#1447): CRC-M11 ticked, claimed by
// `lib/rounds-to-pass.ts` and `test/rounds-to-pass.test.ts`. Unbindable
// because "rounds-to-pass is tracked alongside recall" is a claim about a
// number being PRODUCED, and the only honest matcher for it is the reading
// itself: `bun evals/ai-review-control/run.ts rounds` went from
// `measured 1, unmeasured 39` to `measured 44, unmeasured 1` once #1448
// taught the reader the derivation its writer already made. A file-exists
// pattern would have been satisfiable while the command printed UNMEASURED
// on every row, which is the state this criterion sat in for two days.
// 95 -> 96 on 2026-10-24 (#1587): CRC-B7 ticked, claimed by
// `test/ai-review-findings.test.ts`. Unbindable because the criterion is two
// claims about RENDERED OUTPUT — an order and three labels — and no
// registered matcher pattern reads an annotation string. A file-exists or
// symbol-present pattern would be satisfied by `SEVERITY_RANK` existing,
// which is precisely the state the criterion sat in for months: the
// vocabulary was declared in `lib/finding-jury.ts` and the deployed CI path
// could not import it, so a matcher over the symbol would have ticked a
// criterion nothing in CI could reach.
// 96 -> 112 on 2026-10-28: SC-2560..SC-2575 of
// SPEC-AUTHORING-SPEC.md, all sixteen ticked, all claimed by
// `test/spec-evidence.test.ts` and `test/spec-template.test.ts`. Unbindable
// because each is a claim about what `evidenceViolations` RETURNS for a
// planted document — "a waiver whose expiry has passed is a violation again"
// is a statement about a verdict, and no registered matcher reads one. The
// available patterns would bind to `lib/spec-evidence.ts` existing or
// containing `WAIVER_EXPIRED`, both of which are satisfied by a module that
// declares the code and never emits it: the exact decorative-check shape
// this spec exists to refuse. The real binding is the mutation battery in
// `test/spec-evidence.test.ts`, which runs each case against the module and
// against a copy with the decider short-circuited, and the document's own
// `proved-by:` lines name it per criterion.
// 112 -> 113 on 2026-10-28: SC-2576, same spec, same reason. "the audit's
// `today` is anchored in UTC, so two runners cannot disagree" is a claim
// about what one script STAMPS under two process timezones, and the only
// honest matcher for it is running the script twice. A file-exists or
// content-contains pattern would bind to the string `"UTC"` appearing in
// `scripts/audit-spec-evidence.ts`, which is satisfied by the word sitting in
// a comment above a call that does not pass it — which is exactly the state
// the module was in when the reviewer found this on #1639.
// 113 -> 116 on 2026-10-28: SC-2577, SC-2578, SC-2579, same spec, same
// reason. Each is a claim about what a SPAWNED command does to a planted
// tree — which document it reads, what it says when there is nothing to
// read, whether the instruction it emits names something the reader has —
// and no registered matcher pattern expresses a spawn. The available ones
// would bind to `scripts/audit-spec-evidence.ts` appearing in
// `package.json`, which is satisfied by the string sitting in a `files[]`
// array while the command defaults its root to the installed package and
// reports rungate's own compliance as the consumer's. That mutation was run:
// removing `projectRootFlag` makes it answer "1494 of 1753 across 23 specs"
// for a consumer holding one spec, and exit zero.
// 116 -> 118 on 2026-10-28: SC-2580, SC-2581, same spec, same reason.
// SC-2580 is a claim about one BRANCH ORDER inside the decider — that a
// complete, unexpired, signed waiver still owes a `needs:` line — and the
// registry has no pattern for "this function reports exactly this code and
// no other on this input". SC-2581 is a census over two populations at once,
// the decider's own emitted messages and two documents, and a matcher that
// bound it would bind to the field names appearing somewhere, which is the
// state that produced the finding: four copies named the three `waived-*`
// fields and none named `needs:`.
// 118 -> 145 on 2026-11-06 (#1834): the 27 criteria BOARD-FLOW-SPEC.md ticked
// in one commit. Each already carried `<!-- REVIEW: unmatched (no registry
// pattern was close enough) -->` while UNticked, so the population they moved
// into is the one this number counts and not a new kind of gap: a tick is what
// makes an unmatched criterion CLAIMED, and the claims were already there —
// every one of the 27 was named by a test in a declaring position, which is
// why `bun scripts/sync-sc-status.ts` ticked them.
//
// They are unbindable for the reason the rows above are. A lane rule is a
// claim about what a DECIDER returns for a planted wrong state — "an
// unreadable close reason refuses rather than defaulting to Done", "a lane
// above its depth is OVER, not OK" — and no registered pattern expresses a
// return value. The available ones would bind to `laneFor` appearing in
// `lib/board-flow.ts`, which is satisfied by the symbol existing and says
// nothing about what it answers.
//
// What the ticks rest on instead is three mutants, each predicted before it
// ran: collapsing `laneFor` to one lane reddens 7 cases (membership exact),
// reading an incomplete census as complete reddens 1 (exact), and turning an
// unreadable cap into full eligibility reddens 2 where 3 were predicted — the
// miss is recorded in the PR rather than retrofitted.
//
// 145 -> 147 on 2026-11-07 (#1718): SC-2618 and SC-2619 of
// SPEC-TO-BOARD-PIPELINE-SPEC.md. Both were already CLAIMED — named in a
// declaring position by `test/board-conformance.test.ts` and
// `test/board-snapshot.test.ts` — so ticking them moved them into this
// population rather than creating a new kind of gap, the same way the 27
// above did.
//
// They are unbindable for the same reason: each is a claim about what a
// COMMAND answers for a given input, not about a symbol existing. SC-2618
// is "exits non-zero while any reading is short", SC-2619 is "every input
// comes from the repository or the live API, and a hand-assembled file is
// a refusal naming it". No registered pattern expresses an exit code or a
// refusal; the available ones would bind to `board-conformance` appearing
// in the tree, which is satisfied by the file existing.
//
// What the ticks rest on is in each criterion's own `proved-by`: for
// SC-2618, two staged copies of the command differing only in
// `REFUSE_EXIT`, run against one shared refusing producer, real refusing
// and mutant not; for SC-2619, blank-value rows for all three forwarded
// inputs against a project whose config COULD have satisfied each one, so
// a refusal cannot come from there being nothing to fall back to.
//
// 148 adds SC-2620 (#1892), the third of that run and unbindable for the
// same reason: "the conformance command runs on main, so a board that
// drifts reddens CI" is a claim about what a JOB does when it fires, and no
// registered pattern expresses that. `test/board-conformance-job.test.ts`
// names it in a declaring position, so the tick moved it into this
// population rather than creating a new gap.
//
// What the tick rests on is in the criterion's own `proved-by`, and the
// operative half is NOT the suite: Actions run 42462454243 on `a0201e21`
// fired on the push that merged #1898, read the live board with the PAT,
// printed `SHORT criterion-coverage 25 of 26 — 1 short` and exited 1 — with
// no `Board conformance UNMEASURED` warning in the run's annotations, so
// the reading was taken rather than skipped. The suite's half is the
// mutation: the step's own `run:` body, executed under `bash -e`, refuses
// the short-board input where a copy with `exit $status` set to `exit 0`
// ships.
//
// 150 adds SC-2735 (#1996) and SC-2737 (#1998), both ADR-013 rows and both
// unbindable for the reason SC-2620 is: each is a claim about where a value
// comes from or what a required check refuses, which no registered pattern
// expresses. Each is named in a declaring position by its own suite, so the
// ticks moved them into this population rather than opening a gap. SC-2737's
// box was left unticked when #2003 merged, which is what reddened `main`'s
// B2 reading at `0bae5df1`.
// 150 -> 151: SC-2739 ticked on the PR closing #2000 (ADR-013 row 6). A
// claim that a template's table parses, which no registered pattern
// expresses; `test/adr-template.test.ts` names it in a declaring position.
// 151 -> 152: SC-2738 ticked on the PR closing #1999 (ADR-013 row 5). A
// claim about what a workflow runs and what the filing refuses, which no
// registered pattern expresses; `test/adr-accepted-workflow.test.ts` and
// `test/issue-decomposition.test.ts` name it in a declaring position.
// 152 -> 153: SC-2736 ticked on the PR closing #1997 (ADR-013 row 3). A
// claim about what a rule's prose states, which no registered pattern
// expresses; `test/rule-provenance.test.ts` names it in a declaring position.
// 153 -> 154: SC-2740 ticked on the PR closing #2001 (ADR-013 row 7). A
// claim about what a command file instructs, which no registered pattern
// expresses; `test/dry-run-command.test.ts` names it in a declaring position.
// 154 -> 155: SC-2734 ticked on the PR closing #1995 (ADR-013 row 1). A
// claim about which specs a board reading counts, which no registered pattern
// expresses; `test/board-conformance.test.ts` names it in a declaring position.
// 155 -> 157: SC-2615 and SC-2616 ticked on the PR closing #1717. Claims about
// which population a board reading counts and how it names an offender, which
// no registered pattern expresses; `test/board-snapshot.test.ts` names both in
// a declaring position (its `repository-wide populations` describe title).
// 157 -> 158: SC-2741 ticked by `sync-sc-status --only SC-2741` on the PR
// closing #2054 (ADR-013 row 8). A claim about which work Ready may hold and
// what triggers its refill, which no registered pattern expresses; its
// `SC-2741:` cases in test/board-ready-rule.test.ts, test/board-mirror.test.ts
// and test/board-ready-fanout.test.ts name it in a declaring position.
// 158 -> 159: SC-2617 ticked by `sync-sc-status --only SC-2617` on the PR
// closing #2056. A claim about which edges the tracker carries, which no
// registered pattern expresses; test/plan-deps.test.ts and
// test/board-snapshot.test.ts name it in a declaring position.
// 159 -> 160: SC-2621 ticked by `sync-sc-status --only SC-2621` on the PR for
// #1719. A claim about where the board's identifiers are read from, which no
// registered pattern expresses; test/board-status-sweep.test.ts and
// test/work-status.test.ts name it in a declaring position.
// 160 -> 161: SC-2747 ticked by `sync-sc-status --only SC-2747` on the PR for
// #2049. A claim that the process rules file and AGENTS.md's rule 9 come from
// one source, which no registered pattern expresses; the `SC-2747` describes
// in test/process-rules.test.ts name it in a declaring position.
// 161 -> 162: SC-2748 ticked by `sync-sc-status --only SC-2748` on the PR for
// #2050. A claim about which config keys scaffold writes and which it only
// reports, which no registered pattern expresses; the `SC-2748` describe in
// test/scaffold-label-keys.test.ts names it in a declaring position.
// 162 -> 163: SC-2749 ticked by `sync-sc-status --only SC-2749` on the PR for
// #2051. A claim about what scaffold prints after it writes, which no
// registered pattern expresses; test/human-steps.test.ts names it in a
// declaring position.
// 163 -> 164: SC-2746 ticked by `sync-sc-status --only SC-2746` on the PR for
// #2048. A claim about which files scaffold owns and how, which no registered
// pattern expresses; the `SC-2746` describe in test/dry-run-command.test.ts
// names it in a declaring position.
// 164 -> 165: SC-2744 ticked by `sync-sc-status --only SC-2744` on the PR for
// #2046. A claim that scaffold emits adr-accepted.yml and this repository's
// copy is the generated one, which no registered pattern expresses; the
// `SC-2744` describe in test/adr-accepted-workflow.test.ts names it.
// 165 -> 166: SC-2743 ticked by `sync-sc-status --only SC-2743` on the PR for
// #2045. A claim that scaffold emits closing-references.yml and this
// repository's copy is the generated one, which no registered pattern
// expresses; the `SC-2743` describe in test/closing-references-workflow.test.ts
// names it.
// 166 -> 168: SC-2742 and SC-2745 ticked by `sync-sc-status --only` on the PR
// for #2179, once #2166 generated the fourth process workflow. Neither claim
// (process workflows call only registered CLI commands; the board workflows
// are owned and name no board) has a registered pattern; the `SC-2742` describe
// in test/package-closure.test.ts and the `SC-2745` describe in
// test/board-intake.test.ts name them.
// 168 -> 169: CRC-M17 rewritten to state its behaviour with no file or symbol
// (Jason's decision on #1887, 2026-11-15) and ticked against the
// `#1887 / CRC-M17` describe in test/ai-review-finding-scope.test.ts. A
// behaviour with no registered pattern is unbindable by design here.
// 169 -> 171: SC-2622 and SC-2623 (#1720) ticked as behaviours with no
// registered pattern, claimed by the `SC-2622:` and `SC-2623:` cases in
// test/spec-requirements.test.ts.
// 171 -> 172: SC-1947 (#2274) ticked by hand, as SC-1939 and SC-1941 beside it
// were: a behaviour with no registered pattern, claimed by the `#2274 / SC-1947`
// header of test/scaffold-extract-constraints.test.ts once the todo that
// outranked it was deleted from test/rule-lifecycle-spec.test.ts.
// 172 -> 173: SC-2776 (#2301) ticked by `sync-sc-status --only SC-2776`: a
// spec opts into the engine through its own `board:` frontmatter, a behaviour
// no registered pattern expresses; the `SC-2776` describes in
// test/board-families.test.ts and test/board-conformance.test.ts name it.
// 173 -> 174: SC-2778 (#2303) ticked by `sync-sc-status --only SC-2778`: a
// criterion placed outside every phase reads as declared, a behaviour no
// registered pattern expresses; the `SC-2778` describes in
// test/board-conformance.test.ts and test/board-snapshot.test.ts name it.
// 174 -> 175: SC-2777 (#2302) ticked by `sync-sc-status --only SC-2777`: the
// queue label reaches every opted-in family, a behaviour no registered pattern
// expresses; the `SC-2777` describe in test/board-mirror.test.ts names it.
// 175 -> 176: SC-2779 (#2304) ticked by `sync-sc-status --only SC-2779`: an
// issue moves into the phase milestone its criteria hold, a behaviour no
// registered pattern expresses; the two `SC-2779` describes in
// test/plan-issues.test.ts name it.
// 176 -> 177: SC-2780 (#2305) ticked by `sync-sc-status --only SC-2780`: a
// push that changes specs/ runs every opted-in family through the engine, a
// generated workflow no registered pattern expresses; the `SC-2780`
// describes in test/specs-placed-workflow.test.ts name it.
// 177 -> 178: SC-2785 (#2343) ticked by `sync-sc-status --only SC-2785`: in
// direct-ship mode the filing cap is the ceiling whatever the day's growth, a
// behaviour no registered pattern expresses; the FG-266..FG-278 describe in
// test/issue-filing-gate.test.ts names it.
// 178 -> 179: SC-2782 (#2340) ticked by `sync-sc-status --only SC-2782`: a
// consumer's issue gets one triage verdict from one decider, a tracker read
// no registered pattern expresses; the three `SC-2782` describes in
// test/triage-consumer-issues.test.ts name it.
// 179 -> 180: SC-2783 (#2341) ticked by `sync-sc-status --only SC-2783`: the
// board reads an unanswered consumer issue as short, a reading no registered
// pattern expresses; the `SC-2783` describe in test/board-conformance.test.ts
// names it.
// 180 -> 181: SC-2784 (#2342) ticked by `sync-sc-status --only SC-2784`: a
// generated workflow's triggers and its pinned published call, a reading no
// registered pattern expresses; the `SC-2784` describe in
// test/intake-triage-workflow.test.ts names it.
// 181 -> 182: CRC-C3 (#2306) ticked by `sync-sc-status --only CRC-C3`: a
// thread resolved with no reply is named on the conversation, a reading of
// review threads no registered pattern expresses; the `CRC-C3` describe in
// test/ai-review-threads.test.ts names it.
// 182 -> 181: SC-2741 UNTICKED on the PR for #2430. ADR-021 reworded it to
// Jason's accepted text (Ready draws from every placed phase, ranked by due
// date), and the ranking half is #2434's, so the new wording is not yet true.
// #2434 ticks it again with `sync-sc-status --only SC-2741`.
// 181 -> 182: SC-2786 (#2431) ticked by `sync-sc-status --only SC-2786`:
// Ready passes over an issue naming a file already taken, a reading of issue
// bodies and open pull requests no registered pattern expresses; the
// `SC-2786` describe in test/board-ready-rule.test.ts names it.
// 182 -> 183: SC-2741 (#2434) ticked again by `sync-sc-status --only SC-2741`,
// as the #2430 line above said it would be: Ready ranked by milestone due
// date and refilled on a milestone event, a reading no registered pattern
// expresses; the `SC-2741` describes in test/board-ready-rule.test.ts and
// test/board-ready-fanout.test.ts name it.
// 183 -> 184: CRC-A7 (#1653) ticked by `sync-sc-status --only CRC-A7`:
// REVIEW.md states four clauses and the payload carries the summary slot the
// fourth needs, a reading of a prose document and a prompt no registered
// pattern expresses; the `#1653` describes in test/ai-review-conventions.test.ts
// name it.
// 184 -> 185: SC-2787 (#2495) ticked by `sync-sc-status --only SC-2787`:
// adr-accepted.yml gains a workflow_run trigger when board.mergeWorkflow names
// a merge workflow, and reads its range from its own last successful run, a
// reading of a generated workflow and a git history no registered pattern
// expresses; the `SC-2787` describes in test/board-merge-workflow.test.ts
// name it.
// 185 -> 186: SC-2791 (#2484) ticked by `sync-sc-status --only SC-2791`:
// scaffold installs a /board command that names no repository, a reading of a
// rendered command file no registered pattern expresses; the `SC-2791`
// describe in test/board-command.test.ts names it (2026-11-19).
// 186 -> 187: SC-2789 (#2480) ticked by `sync-sc-status --only SC-2789`:
// board-init makes a consumer's board and writes its ids into the config, a
// reading of GitHub project mutations and a config write no registered
// pattern expresses; the `SC-2789` describes in test/board-init.test.ts name
// it (2026-11-19).
// 187 -> 188: SC-2792 (#2483) ticked by `sync-sc-status --only SC-2792`:
// work-status and verify-merge-ref run as rungate commands and read the
// repository from --repo, then GITHUB_REPOSITORY, then origin, a reading of
// the CLI registry and the repository resolution no registered pattern
// expresses; the `SC-2792` describes in test/verify-merge-ref.test.ts name it
// (2026-11-19).
// 188 -> 189: SC-2794 (#2486) ticked by `sync-sc-status --only SC-2794`:
// scaffold installs a work-loop command naming only commands a consumer has
// and the project's own test command, a reading of a rendered command file no
// registered pattern expresses; the `SC-2794` describe in
// test/work-loop-command.test.ts names it (2026-11-19).
// 189 -> 190: SC-2790 (#2481) ticked by `sync-sc-status --only SC-2790`:
// scaffold emits board-flow.yml calling the published CLI and reading the board
// from board.id, a reading of a generated workflow no registered pattern
// expresses; the `SC-2790` describe in test/board-flow-workflow.test.ts names
// it (2026-11-19).
// 191: SC-2793 (#2485) ticked from its describe in test/human-steps.test.ts —
// the human-steps report's board.id and token-write rows, a reading of a
// printed report no registered pattern expresses (2026-11-20).
// 192: SC-2788 (#2497) ticked from its describe in test/adr-accepted-workflow.test.ts —
// a merge-triggered adr-accepted run runs close-merged-references, a reading of a
// generated workflow no registered pattern expresses (2026-11-20).
// 193: CRC-N3 (#2544) ticked by `sync-sc-status --only CRC-N3` — flag the class
// of a bug, a reading of the adjudicator's re-count and the class thread's hold
// that no registered pattern expresses; the `CRC-N3` describe in
// test/ai-review-population-declared.test.ts names it (2026-11-21).
// 194: CRC-N4 (#2552) ticked by `sync-sc-status --only CRC-N4` — no repeats of
// advisory findings already posted, a reading of the adjudicator's suppression
// gate over a thread list that no registered pattern expresses; the `CRC-N4`
// describe in test/ai-review-suppression.test.ts names it (2026-11-21).
// 195: SC-2795 (#2589) ticked from its describe in test/board-conformance.test.ts —
// criteria-named does not count a consumer issue short for its first two days, a
// reading of a board snapshot no registered pattern expresses (2026-11-21).
// 196: SC-2796 (#2597) ticked by `sync-sc-status --only SC-2796` — a scaffold
// run reports the consumer's instruction surface, a reading of the run's
// report lines that no registered pattern expresses; the `SC-2796` describe in
// test/consumer-instruction-surface.test.ts names it (2026-11-21).
// 197: SC-2799 (#2600) ticked by `sync-sc-status --only SC-2799` — CI renders the
// scaffold into fixture consumers and lints read that rendered tree, a reading of
// a scaffold run and the surface reader that no registered pattern expresses; the
// `SC-2799` describe in test/rendered-surface.test.ts names it (2026-11-21).
// 198: SC-2797 (#2598) ticked by `sync-sc-status --only SC-2797` — the consumer's
// budget comes from its rungate config, defaults to SURFACE_BUDGET_BYTES and may sit
// at most 35% above the measured peak, a reading of the config and the scaffold's
// report that no registered pattern expresses; the `SC-2797` describe in
// test/consumer-instruction-surface.test.ts names it (2026-11-21).
// 199: SC-2798 (#2599) ticked by `sync-sc-status --only SC-2798` — the generated
// conformity test refuses an over-budget consumer surface and an unreadable one as
// UNMEASURED, a reading of a spawned conformity check that no registered pattern
// expresses; the `SC-2798` describe in test/scaffold-conformity-surface.test.ts
// names it (2026-11-21).
// 200: SC-2800 (#2601) ticked by `sync-sc-status --only SC-2800` — every file,
// heading or table a rendered brief or rule tells its agent to read exists in the
// rendered tree, a reading of the fixture renders that no registered pattern
// expresses; the `SC-2800` describe in test/rendered-surface.test.ts names it
// (2026-11-21).
// 201: SC-2801 (#2602) ticked by `sync-sc-status --only SC-2801` — no rendered
// file carries an unexpanded template variable, the test-only marker or a numbered
// list that skips, a reading of the fixture renders that no registered pattern
// expresses; the `SC-2801` describe in test/rendered-surface.test.ts names it
// (2026-11-21).
// 202: SC-2802 (#2603) ticked by `sync-sc-status --only SC-2802` — no always-loaded
// rendered rule states a count of files that adding one file would change, a reading
// of the fixture renders that no registered pattern expresses; the `SC-2802` describe
// in test/rendered-surface.test.ts names it (2026-11-21).
// 203: SC-2805 (#2606) ticked by `sync-sc-status --only SC-2805` — `rungate
// prompt-audit` runs the surface lints plus two more on a consumer, labels each
// finding by owner and drafts rungate's without filing, a reading of a rendered
// consumer that no registered pattern expresses; the `SC-2805` describe in
// test/prompt-audit-command.test.ts names it (2026-11-22).
// 204: SC-2625 (#1722) ticked by hand from the live `hand-edits` reading, MET
// since the second run opened — the engine's acceptance test, a reading of the
// live board that no registered pattern expresses; the `SC-2625` describe in
// test/board-conformance-job.test.ts names it, and the job it covers takes the
// reading on every push to main (2026-11-22).
// 205: CRC-M19 (#2651) ticked by `sync-sc-status --only CRC-M19` while CRC-M18
// was unticked and retired (ADR-025) — the diff-budget script is gone and the
// census half kept, a reading of the tree that no registered pattern expresses;
// the `CRC-M19` describe in test/review-execution-reading.test.ts names it
// (2026-11-22).
// 206: CRC-B10 (#2647) ticked by `sync-sc-status --only CRC-B10` — the generated
// AI review defaults to Haiku 5.5 unless the consumer names an exact model, a
// reading of the generated workflow that no registered pattern expresses; the
// `CRC-B10` describe in test/ai-review-model-alias.test.ts names it (2026-11-22).
// 207: CRC-B12 (#2649) ticked by `sync-sc-status --only CRC-B12` — the generated
// review action is handed the job's own token, so no Claude GitHub App is
// needed, a reading of the generated workflow that no registered pattern
// expresses; the `CRC-B12` describe in test/ai-review-credentialed-job.test.ts
// names it (2026-11-22).
// 208: CRC-B11 (#2648) ticked by `sync-sc-status --only CRC-B11` — each review
// round is three reviewer runs merged into their union, a reading of the
// generated workflow and its keep and merge scripts that no registered pattern
// expresses; the `CRC-B11` describe in test/ai-review-three-runs.test.ts names
// it (2026-11-22).
const CLAIMED_UNBINDABLE = 208;

function split() {
  return splitUnmatchedChecked({ projectRoot: REPO, claimed: claimedScKeys(SPECS), scopedKey });
}

describe("SC-1636: unmatched checked SCs are split by whether a test claims them", () => {
  test("both halves are non-empty, so neither assertion below is vacuous", () => {
    const s = split();
    expect(s.unclaimed.length, "nothing landed in the unclaimed half").toBeGreaterThan(0);
    expect(s.claimed.length, "nothing landed in the claimed half").toBeGreaterThan(0);
  });

  test("every row carries the spec that declares it, so a rise is actionable", () => {
    for (const row of [...split().unclaimed, ...split().claimed]) {
      expect(row.specFile, `${row.id} has no spec`).toMatch(/\.md$/);
      expect(row.statement.length, `${row.id} has no statement`).toBeGreaterThan(0);
    }
  });
});

describe("SC-1637: the unclaimed count is the ratchet and may only fall", () => {
  test(`at most ${UNCLAIMED_RATCHET} checked SCs are unmatched AND unclaimed`, () => {
    const unclaimed = split().unclaimed;
    expect(
      unclaimed.length,
      unclaimed.slice(0, 5).map(u => `${u.specFile} ${u.id}`).join("\n"),
    ).toBeLessThanOrEqual(UNCLAIMED_RATCHET);
  });

  test("the ratchet carries no slack, so raising it cannot buy green", () => {
    // A ratchet is `<=`, so raising the constant is invisible to the test
    // above — the vacuity shape in `.claude/rules/checks-must-be-able-to-fail.md`,
    // and the one that measured 0 red on #440's depth bound. Headroom is
    // what makes a ratchet decorative, so the headroom is the assertion:
    // the number must track what was actually measured, and lowering it is
    // an edit somebody makes deliberately.
    expect(
      UNCLAIMED_RATCHET - split().unclaimed.length,
      "the ratchet has slack and would not notice a new untested criterion",
    ).toBe(0);
  });
});

describe("SC-1638: the claimed-but-unbindable count is tracked, not refused", () => {
  test(`the count is ${CLAIMED_UNBINDABLE}, and moving it is visible`, () => {
    // Both directions. A floor alone lets the number grow unremarked, which
    // is how the single ratchet this issue replaces reached 258; a ceiling
    // alone would make it a ratchet, which is the thing #441 argues it must
    // not be. Bracketing it means a move is noticed and then BANKED by
    // editing this line — a decision, rather than a silent rise.
    expect(split().claimed.length).toBe(CLAIMED_UNBINDABLE);
  });

  test("a criterion covered by an executed test is not in the unclaimed half", () => {
    // The specific wrong the issue names. #397's six, #398's ten and #399's
    // six are all executed, and all of them used to count as debt.
    const unclaimed = new Set(split().unclaimed.map(u => u.id));
    const claimed = new Set(split().claimed.map(u => u.id));
    for (const id of ["SC-1506", "SC-1510", "SC-1520"]) {
      expect(claimed.has(id) || !unclaimed.has(id), `${id} is counted as a wish`).toBe(true);
    }
    // At least one of them must actually be in the claimed half, or the
    // assertion above passes by the id having vanished from the specs.
    expect(
      ["SC-1506", "SC-1510", "SC-1520"].some(id => claimed.has(id)),
      "none of the three is in the claimed half, so the loop proved nothing",
    ).toBe(true);
  });
});

describe("SC-1639: the split does not become a second decider", () => {
  test("every unclaimed criterion is one the per-spec census already governs", () => {
    // 154 of 154, measured. `test/ticked-sc-cover.test.ts` ratchets that
    // census per spec, both directions, naming the ids — so it is the one
    // place a new untested criterion is refused, and this file must not
    // quietly become a second one. The relationship is checked rather than
    // assumed, so the two cannot drift apart.
    const claimed = claimedScKeys(SPECS);
    const s = splitUnmatchedChecked({ projectRoot: REPO, claimed, scopedKey });
    const census = uncoveredTickedScs({ specsDir: SPECS, projectRoot: REPO, claimed, scopedKey });
    const residue = unclaimedCensusResidue({ unclaimed: s.unclaimed, census, scopedKey });

    expect(
      residue.onlyUnclaimed,
      "a criterion is refused here that the per-spec ratchet cannot see",
    ).toEqual([]);
  });

  test("the census residue is only what `testable: no` explains", () => {
    // The other direction, and it must stay small and named. The census
    // reads every spec; the split reads only testable ones, so a
    // `testable: no` spec is in one population and not the other. Naming
    // the ids means a THIRD cause appearing is a failure rather than a
    // number that drifted.
    const claimed = claimedScKeys(SPECS);
    const s = splitUnmatchedChecked({ projectRoot: REPO, claimed, scopedKey });
    const census = uncoveredTickedScs({ specsDir: SPECS, projectRoot: REPO, claimed, scopedKey });
    const residue = unclaimedCensusResidue({ unclaimed: s.unclaimed, census, scopedKey });

    expect(residue.onlyCensus).toEqual([
      "DA-COMPLIANCE-SPEC.md::SC-440",
      "DA-COMPLIANCE-SPEC.md::SC-441",
    ]);
  });
});

describe("SC-1640: both halves are proved against a planted spec and test", () => {
  // Fixture ids in the 9700 range. A real id written anywhere in a test file
  // is read by sync-sc-status as a coverage claim for that criterion (#149),
  // so fixtures use numbers this repo does not issue.
  const UNMATCHABLE = "The runner refuses, and says which of two things happened";

  function plant(opts: { withTest: boolean }): { root: string; testDir: string } {
    const root = mkdtempSync(join(tmpdir(), "rg-441-"));
    mkdirSync(join(root, "specs"), { recursive: true });
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(
      join(root, "specs", "PLANTED-SPEC.md"),
      ["---", "doc-type: spec", "testable: true", "governs: a planted thing", "---", "",
       "# Planted", "", "## Success Criteria", "",
       `- [x] SC-9701: ${UNMATCHABLE}`, ""].join("\n"),
    );
    if (opts.withTest) {
      writeFileSync(
        join(root, "test", "planted.test.ts"),
        ['import { test, expect } from "bun:test";', "",
         'test("SC-9701: the runner refuses", () => { expect(1).toBe(1); });', ""].join("\n"),
      );
    }
    return { root, testDir: join(root, "test") };
  }

  test("a planted SC with no test lands in unclaimed and NOT in claimed", () => {
    const { root, testDir } = plant({ withTest: false });
    try {
      const s = splitUnmatchedChecked({
        projectRoot: root,
        claimed: claimedScKeys(join(root, "specs"), testDir),
        scopedKey,
      });
      expect(s.unclaimed.map(u => u.id)).toContain("SC-9701");
      expect(s.claimed.map(u => u.id), "an unclaimed SC escaped the ratchet").not.toContain("SC-9701");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the same SC with a test that declares it moves to claimed", () => {
    // One input, one difference: the test file. Both directions over the
    // same planted criterion, so neither bucket can be right by accident.
    const { root, testDir } = plant({ withTest: true });
    try {
      const s = splitUnmatchedChecked({
        projectRoot: root,
        claimed: claimedScKeys(join(root, "specs"), testDir),
        scopedKey,
      });
      expect(s.claimed.map(u => u.id)).toContain("SC-9701");
      expect(
        s.unclaimed.map(u => u.id),
        "a criterion with an executed test is still counted as a wish",
      ).not.toContain("SC-9701");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the planted criterion really is unmatchable, or neither case proves anything", () => {
    // The vacuity guard the two cases above depend on. If a matcher ever
    // binds this sentence, both land in neither half and both assertions
    // pass over an empty set.
    const { root, testDir } = plant({ withTest: false });
    try {
      const s = splitUnmatchedChecked({
        projectRoot: root,
        claimed: claimedScKeys(join(root, "specs"), testDir),
        scopedKey,
      });
      expect(
        s.unclaimed.length + s.claimed.length,
        "the planted SC bound to a matcher, so the cases above are vacuous",
      ).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a SUPERSEDED tick is in neither half", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-441-"));
    mkdirSync(join(root, "specs"), { recursive: true });
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(
      join(root, "specs", "PLANTED-SPEC.md"),
      ["---", "doc-type: spec", "testable: true", "governs: a planted thing", "---", "",
       "# Planted", "", "## Success Criteria", "",
       "- [x] SC-9702: SUPERSEDED by SC-9701 — was a refusal claim", ""].join("\n"),
    );
    try {
      const s = splitUnmatchedChecked({
        projectRoot: root,
        claimed: claimedScKeys(join(root, "specs"), join(root, "test")),
        scopedKey,
      });
      expect(s.unclaimed.map(u => u.id)).not.toContain("SC-9702");
      expect(s.claimed.map(u => u.id)).not.toContain("SC-9702");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
