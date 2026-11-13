---
doc-type: spec
testable: true
compliance: strict
governs: THE ENGINE that turns a spec into board state — not the specs it ships. Payload: CODE-REVIEW-CONVERGENCE-SPEC.md
created: 2026-10-29
status: active
updated: 2026-11-12
---

# The spec-to-board pipeline

## Why this spec exists

**The machinery that exists so every issue names a criterion was governed by
no criterion.** Measured 2026-10-29 on `f1f9b1ba`: a grep across `specs/` for
`ADR-003`, `plan-spec`, `plan-deps`, `plan-issues`, `board-mirror` and
`criterion-inventory` returned nothing, and `ADR-003-spec-to-tracker-mapping.md`
— which defines the whole pipeline — states zero criteria.

That is circular in a way that stops the work. An issue filed to improve the
pipeline has nothing to name, so it lands in the same unaligned pile the
pipeline exists to drain; and the pipeline's own gaps are invisible to
`criterion-inventory`, which is the instrument that would otherwise find them.
An ADR records a decision. It is not a source of truth a tool can read, and
`.claude/rules/config-access.md` already says what happens to a rule nothing
executes.

## What must become true

Open the project board and you can see, without opening a single issue, what
to work on and in what order: every issue, its milestone, and **which spec
criteria it serves**. The backlog can then be driven to zero by a reproducible
process rather than by whoever is holding the most context.

Nine steps, each a command. The pattern is the same at every one:

> **a human-authored artefact in git → a deterministic transform → live state.**

Judgement never lives inside a tool. A tool that decided how many issues a
criterion deserves would be a tool nobody could review, and the artefact is
the record of why the shape is what it is.

## What this spec does NOT govern

**There are two boundaries and this is the first of them.** This section names
the *sibling specs* that own neighbouring subjects. The engine/payload
boundary — why no spec shipped *through* the pipeline is governed here — is a
second list, under *What this does not govern* in the Success Criteria. A
reader looking for the full scope boundary needs both.

- **What a good criterion says.** `specs/SPEC-AUTHORING-SPEC.md` owns that.
- **Whether a review finding is real.** `specs/CODE-REVIEW-CONVERGENCE-SPEC.md`
  owns the arbiter, the jury and the noise buckets.
- **The filing cap.** `docs/adr/ADR-007-filing-cap-plan-route.md` owns it. This
  spec only requires that a pipeline step which creates issues is reachable
  under it.

## Success Criteria

### The transform refuses rather than skips

A step that silently drops a row it cannot read produces a shorter list, and a
shorter list is exactly what a plan with less work in it produces. Those are
different facts and only one is actionable — *Silent Default Substitution*,
`.claude/rules/config-access.md`.

- [x] SC-2600: lib/spec-placement.ts contains [NON_PHASE_PLACEMENTS, placementReading] — a placement value outside the closed set is a refusal naming the row, never a row quietly skipped, and an absent table reports UNMEASURED rather than an empty reading that looks like a spec in perfect order
      proved-by: test/plan-spec.test.ts — 40 pass, 0 fail, 2026-11-02; claims the id in a declaring position
- [x] SC-2601: lib/issue-decomposition.ts contains [DecompositionReading, unmeasuredReasons] — one unreadable row makes the WHOLE reading UNMEASURED, because a plan that is partly unreadable is not a plan that is partly done and creating issues is not an operation to perform from half a table
      proved-by: test/issue-decomposition.test.ts "one bad row makes the WHOLE reading unmeasured, not a partial plan" — 63 pass, 0 fail, 2026-11-02
- [x] SC-2602: test/issue-decomposition.test.ts contains [a bad row skipped instead of rejected] — the refusals are proved able to fail by a mutant that converts every rejection into a skip, and the membership is DECLARED rather than counted. This line used to predict seven, "the six refusal cases plus the whole-reading case"; measured 2026-11-06 the mutant reddens eleven, because the prediction counted `reject(` CALL SITES and what a mutant can redden is CASES — the cells check is one site with two cases, and two further cases assert a refusal through a site they share
      proved-by: test/issue-decomposition.test.ts "SC-2602: the skip mutant reddens exactly the declared cases" — 66 pass, 0 fail, 2026-11-06; the mutant it builds reddens the eleven DECLARED names and no others, and a 1 ms spawn budget reddens the case itself, so a killed run cannot read as a measurement (PR #1831)

### One criterion becomes the right number of issues

- [x] SC-2603: lib/issue-decomposition.ts contains [parseDecompositionPlan, planDecomposition] — the plan file decides how many issues a criterion deserves and the tool only reads it, so the judgement sits in a reviewed diff rather than in a heuristic nobody can argue with
      proved-by: test/issue-decomposition.test.ts — 63 pass, 0 fail, 2026-11-02; drives the real parseDecompositionPlan
- [x] SC-2604: lib/issue-decomposition.ts contains [MAX_FILES, MIN_OUTCOME] — AGENTS.md rules 2 and 3 are enforced when the plan is READ, not found at review time, because the point of a plan file is that the shape is settled before anything is created
      proved-by: test/issue-decomposition.test.ts — 63 pass, 0 fail, 2026-11-02; MAX_FILES and MIN_OUTCOME refuse at READ time
- [x] SC-2605: test/issue-decomposition.test.ts contains [RE-RUN: an open issue with the same title is not created again] — the title is the identity and the match is exact, so a plan whose first run died halfway does not duplicate on the second; the exact-match control is a separate case because a substring match would silently skip a row whose title merely contains another
      proved-by: test/issue-decomposition.test.ts "RE-RUN: an open issue with the same title is not created again" — 63 pass, 0 fail, 2026-11-02

### Ordering is data, not prose

- [x] SC-2606: lib/spec-deps.ts contains [chainAdjacentPhases] — the phase order in the placement table becomes `blocked by` edges on the tracker, so *what is next* is everything unblocked rather than a sentence a human has to read
      proved-by: test/plan-deps.test.ts "SC-2606: chainAdjacentPhases is where adjacency is decided" — 58 pass, 0 fail, 2026-11-06; the token was [adjacent] and it matched a header comment, so the criterion named nothing a mutation could move (#1680). Two mutants of the extracted symbol: N-1 arithmetic reddens 3 cases, predicted and observed the same 3; a full-prefix chain reddens 6, where 4 were predicted — the two unpredicted are the live-board shape cases, and the number is not retrofitted
- [x] SC-2607: test/issue-decomposition.test.ts contains [an edge to a row created in the same run is wired, not dropped] — creation and wiring are two passes, because a row blocked by another row in the same plan has no number until that row exists and a one-pass implementation loses every forward reference silently
      proved-by: test/issue-decomposition.test.ts "an edge to a row created in the same run is wired, not dropped" — 63 pass, 0 fail, 2026-11-02

### Every criterion is traceable, in both directions

- [x] SC-2608: lib/issue-repair.ts contains [CRITERIA_HEADING] — a created issue and a repaired one name their criterion under ONE heading, or an inventory reading sees half the population and reports the other half as uncovered
      proved-by: test/plan-issues.test.ts — 33 pass, 0 fail, 2026-11-02; CRITERIA_HEADING is the one heading both paths write
- [x] SC-2609: lib/board-mirror.ts contains [NAMES_NONE] — "this issue serves no criterion" is spelled, never left as an empty cell: a blank reads as *not yet filled in*, *the tool could not tell* and *deliberately none* at once, and 28 cells on the live board were blank for this reason on 2026-10-29
      proved-by: test/board-mirror.test.ts "SC-2609: no criteria is SPELLED, and a cell nobody wrote stays blank" — 64 pass, 0 fail, 2026-11-06; the constant was `""` and a shipped case asserted it, so this criterion and the suite disagreed (#1716). Two mutants: blanking the constant reddens 2 cases, predicted and observed the same 2; making `mirrorText` return it for every input reddens 5, predicted and observed the same 5. Two assertions are anchored on the empty-string LITERAL, because `toBe(NAMES_NONE)` moves with any mutation of it
- [x] SC-2610: lib/board-mirror.ts contains [specCriteriaIn] — the mirror reads every spec in `specs/`, not one named on the command line, because a board built from one spec reports every criterion of the other 25 as having no issue
      proved-by: test/board-mirror.test.ts "SC-2610: every spec contributes, not the one on the command line" — 64 pass, 0 fail, 2026-11-06; the token was [every spec] and it matched a header comment, so the criterion named nothing a mutation could move. `specCriteriaIn` is the sweep the default path calls, and `mirrorText` returning a constant for every input reddens one of this describe's cases (#1716)

### The gaps the board has to make visible

These are unticked because they are not true yet. They are here so that
`criterion-inventory` can see them and so an issue filed against them has
something to name — which is the whole argument of this spec.

- [x] SC-2611: lib/spec-placement.ts contains [placementCoverage] — a spec with no Phase placement table is REPORTED as unplanned rather than contributing nothing; 1 of 26 specs had one on 2026-10-29, and the other 25 were indistinguishable from specs with no work left
      proved-by: test/plan-spec.test.ts "SC-2611: a spec with no placement table is UNPLANNED, not absent" — 49 pass, 0 fail, 2026-11-06; `placementReading` answered this for ONE spec and both callers are handed a spec on the command line, so `placementCoverage` plus `plan-spec --coverage` is the whole-tree reading that did not exist. Live on this repository: 34 specs, 2 PLANNED, 22 UNPLANNED, 10 NO_CRITERIA — and NO_CRITERIA is separate from UNPLANNED deliberately, because folding them reproduces the defect one level up. Three mutants: folding the two states reddens 1 case and an unreadable spec read as MEASURED reddens 1, both predicted exactly; blanking `unplanned` was predicted at 3 and observed 2, and the missing third was a real second decider in the printer, fixed in the same PR (#1681)
- [x] SC-2612: lib/finding-promotion.ts contains [promote] — a review finding that names real work becomes a criterion in a spec, so the backlog stops accumulating issues that serve none; 22 open issues carried no criterion on 2026-10-29 and 20 of them were labelled follow-up or external-audit
      proved-by: test/finding-promotion.test.ts — 26 pass, 0 fail, 2026-11-07. `promote` does NOT judge whether a finding is real work: that judgement is the caller's input, because `lib/criterion-issue-census.ts` already refused to make the sibling judgement a column and a second refusal here would rebuild the tick-is-proof defect inside the instrument built to measure it. "Does this issue already serve a criterion" is `criteriaNamedBy` from `lib/board-mirror.ts`, imported rather than reimplemented, and AC-3 asserts the reimplementation spellings are absent — two deciders over one question are behaviourally one decider with a dead half (`.claude/rules/checks-must-be-able-to-fail.md`). What was broken: `promotionViolations` short-circuited to `return []`, predicted 4 of 4 refusing inputs would promote, observed 4, and the forged one came back carrying `- [x] SC-9999` — membership, not just the count. The first mutant died on module resolution (`Cannot find module './board-mirror'`) and read as a refusal — green while witnessing nothing — so the copy rewrites its relative imports and asserts the rewrite fired. Three defects found by the security review of the first commit and fixed before the PR opened: `outcome`/`symbol`/`module` were interpolated into markdown with no single-line guard, so a newline appended a ticked criterion nobody wrote to the file that records what is proved (MALFORMED_STATEMENT); `ALREADY_SERVES` read only the TARGET spec's ids, so an issue serving spec A promoted into spec B unopposed, producing the exact two-criteria outcome the refusal prevents (now the whole-tree `specCriteriaIn` sweep, with an UNMEASURED sweep refusing rather than reading as "none found"); and the lib honoured an absolute `--spec` while the CLI did `join(ROOT, spec)`, so the file validated and the file written were different files (one exported `specPath`, contained to `specs/`). The AI review of `4d48c7a3` then found a fourth, and it was worse than reported: `specCriteriaIn` answers UNMEASURED with `specs: []`, so the UNMEASURED branch added for the second defect above was unreachable AND this suite's own SPEC_STATES_NO_CRITERIA case was passing through it — a criterion green for the wrong reason. Probed directly before changing anything (`reading UNMEASURED, specs 0, ids 0`), and UNMEASURED is now its own refusal, taken first and returning; the two states are separated by a case where another spec states criteria so the sweep is MEASURED and the target still contributes none. Round 4 found the same shape twice more and is the reason the guards are now POPULATIONS rather than lists: `outcome` and `symbol` each had an empty-guard and `module` did not, and two of three reads of the target spec were wrapped while the CLI's was bare — in both cases the instances a reviewer named were repaired and their siblings left, which no behavioural case can see because each case only knows the member it was written for. `STATEMENT_FIELDS` is now the one list the guards and the test cases are both derived from, and a single assertion requires every `readFileSync` across both files to sit inside a `try` with a count of 3 as its vacuity guard. That detector was run against `50a75080` and reports `guarded: 0, bare: 1` — it would have caught the defect review found, which is the evidence it is a check rather than a line in a report. Round 5 found a FIFTH instance of the same class and proved the round-4 sweep too narrow: it covered the library's interpolated fields and stopped at the CLI's flags, so `--issue` had no named refusal while `outcome`, `symbol` and `module` all did — `Number("abc")` became `"NaN"` and surfaced as a tracker error about issue #NaN, and `getFlag` handed back the NEXT FLAG as a value, so `--issue --spec x` ran on a value nobody passed. The CLI's required-flag set is now read out of the script's own `required(...)` calls and swept the same way, with the derived list asserted against the five names so a regex matching nothing cannot make the cases vacuous. The first version of that sweep corrupted one flag and omitted the rest, so `--issue is required` answered four of five cases — a contrast is only a control if ONE variable differs, and every other flag is now supplied validly. Round 7 found the subtlest member of the class: `ALREADY_SERVES` read `sweep.ids`, which keeps only criteria stated by exactly ONE spec because the board's cell has to attribute an issue to a single one — a set built to answer "which criterion" reused to answer "any criterion", so an issue naming a collided id such as `SC-A1`, stated by three specs here, promoted unopposed. `allIds` is now the union of `ids` and `collisions`. Controlled by reverting only `lib/finding-promotion.ts` to the prior commit and running the new case against it: 0 pass / 1 fail against the old reading, 1 pass / 0 fail against the new, and the fixture carries a third unambiguous spec because with only the two twins every id collides and the sweep is UNMEASURED, which would have passed the case on the wrong refusal
- [x] SC-2613: lib/github.ts contains [filingGate] — `createIssue` is adjudicated by the filing cap, so a tool that creates issues is metered the way a `gh issue create` in a Bash command already is
      proved-by: test/github-create-gated.test.ts + test/github-op.test.ts — 44 pass, 0 fail, 2026-11-07. Shipped as #1873 (merge `849ad16c`), and that merge left this criterion UNTICKED while closing #1677, which turned `main` red: B2 of the stage ladder reads "every engine criterion names an open issue, or is recorded as already true", and a criterion whose only issue has just closed is neither. The snapshot named it — `{"id":"SC-2613","satisfiedByIssue":null,"recordedTrue":false}`, 25 of 26. `filingGate` did not exist at that point either: #1873 built the mechanism as an anonymous try/catch inside `createIssue`, so the criterion named a symbol the tree did not contain and ticking it would have been false. It is now the named binding that turns a gate's answer into a decision — a decision returned unchanged, anything else refusing, a throw refusing with its message — because the thing that adjudicates a filing has to be something a mutation can move rather than a position in a function. What was broken: the guard `if (!decision.allowed)` replaced by `if (false)` in a copy of `lib/github.ts`, against a control copy differing only in the stubbed `@octokit/rest` import; control refused and filed 0, mutant filed 1
- [x] SC-2614: lib/finding-arbiter.ts contains [STALE_CITATION] — a finding whose quoted source does not appear in the tree the review ran on is reported STALE rather than adjudicated as live, because a finding and its own staleness are indistinguishable to the person answering it; on PR #1672 round 4, two findings from ONE run at ONE head SHA disagreed about whether the milestone read was paginated, the one that said it was not quoted source the reviewed commit had deleted, and the sibling that said it was cited a file containing zero matches for either fetcher
      proved-by: test/finding-arbiter.test.ts — 108 pass, 0 fail, 2026-11-02; STALE_CITATION is reported, not adjudicated live

### The board's own state is a reading, not an impression

Every criterion above names a symbol in `lib/`, and a symbol being present is
not the same as the board being right. Measured 2026-10-30: **15 of 15** of
them are that form, and SC-2609 is satisfiable — `NAMES_NONE` exists — while
being false, because its value is `""`. The criteria below state the OUTCOME,
so the thing this spec exists for is checkable rather than inferred from
fifteen symbols. ADR-009 records the decision and the baselines.

**None of them carries the `(behavioral)` marker, and that is deliberate.**
They were written with it and `test/behavioral-cache.test.ts` AC-8 went red:
in this repository `(behavioral)` means *verified through the behavioural
eval system and mapped in `config/behavioral-sc-map.json`*, and the unmapped
population is banded at 10-20 precisely to stop behavioural criteria
accumulating with nothing able to verify them. Adding ten unmapped ones took
it to 29. "States a behaviour" and "is eval-verified" are different
properties and the marker already owns the second. Do not re-add it to buy
the first; SC-2622 is what forbids symbol-satisfaction here.

- [x] SC-2615: every criterion in every in-scope testable spec resolves to exactly one phase; a spec held back says so in its own frontmatter and is banked by path (SC-2734)
      proved-by: test/board-conformance.test.ts, `-t "spec-placement names the UNPLANNED spec"` (1 pass) and the `SC-2734` describe (11 pass), and test/board-snapshot.test.ts, the `repository-wide populations (SC-2615, SC-2616)` describe (4 pass) — 0 fail, 2026-11-12, on the PR that closes #1717. Live: `board-conformance` reads `spec-placement` MET 95 of 95. Wording narrowed to the in-scope population by Jason on 2026-11-12, as ADR-013 decision 1 required of row 1 and row 1's PR (#2013) did not do.
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
- [x] SC-2616: an open issue naming no criterion is reported as a refusal naming the issue, never counted as covered, and a blank cell is distinguishable from a deliberate "serves none" — 25 of 71 open issues named nothing on 2026-10-30 and the two states rendered identically
      proved-by: test/board-conformance.test.ts, `-t "criteria-named names the ISSUE"` (1 pass), and test/board-snapshot.test.ts, the `repository-wide populations (SC-2615, SC-2616)` describe (4 pass) — 0 fail, 2026-11-12, on the PR that closes #1717. Live: `criteria-named` names each of its 41 offenders by number and does not count a declared `serves no criterion`. The 41 are repair work (#1954, stage item E2), not this criterion.
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
- [ ] SC-2617: every issue whose work depends on another carries a `blocked by` edge on the tracker, so *what is next* is computed from the graph — 0 of 71 open issues carried one on 2026-10-30, which makes every ordering claim prose
<!-- REVIEW: unmatched (no registry pattern was close enough) -->

### Alignment before code, and a board that moves by itself

ADR-013 records the decisions; its Decomposition table files one issue per
criterion below. Measured 2026-11-11: Ready topped up from 49 candidates of
which 46 carried only a label, no workflow placed a plan on the board, and 14
of the last 40 merged PRs closed no issue.

- [x] SC-2734: `spec-placement` measures only the specs in scope — a spec held back declares so in its own frontmatter, and the deferred specs are banked by path with their criteria counts in a ratchet that refuses both a rise and a fall, so the reading cannot go green on a population shrunk by swapping members
      proved-by: test/board-conformance.test.ts, the `SC-2734` describe (`-t SC-2734`) — 11 pass, 0 fail, 2026-11-12, on the PR that closes #1995. A spec is held back by `board-scope: deferred` in its frontmatter (a body line does not count); `.claude/spec-deferral-ratchet.json` banks the 22 deferred specs by path and criteria count; a swap, a rise, a fall, a moved count, a path banked twice, or no bank read each turns `spec-placement` UNMEASURED; the live tree equals its bank and leaves exactly the engine and payload specs in scope.
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
- [x] SC-2735: the expedite label and the filing-override label are read from project config, and no label that decides Ready or filing is a constant in library code
      proved-by: test/board-ready-rule.test.ts and test/issue-filing-gate.test.ts, the two `SC-2735` describes — 8 pass, 0 fail, 2026-11-11, on the PR that closes #1996. Restoring either hardcoded label string turns 4 of the 8 red; the library-wide scan finds no quoted spelling of either configured label in lib, scripts, hooks or bin.
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
- [x] SC-2736: AGENTS.md rule 9 states the four-step process — agree and file the same turn, an ADR for work bigger than one issue, the plan placed on merge, each PR closing its issue — and names the exempt work with the rule that decides it
      proved-by: test/rule-provenance.test.ts, the `SC-2736` describe — 12 pass, 0 fail, 2026-11-12, on the PR that closes #1997. Each step's anchor, the exempt work and the diff-not-branch decider are read between rule 9's number and rule 10's, so a phrase moved out of the rule reads as missing; no rule 11 exists, and the exempt files are stated DA-owned. Removing `Fixes #N`, the decider, or two of the four exempt kinds each turns one case red.
<!-- REVIEW: unmatched (rewriting as file-exists would assert only that AGENTS.md exists, while the criterion coordinates a further claim (file the same turn, an ADR for work bigger than one issue, the plan placed on merge, each PR closing its issue — and names the exempt work with the rule that decides it) — the file is mentioned, not what the criterion is about) -->
- [x] SC-2737: a pull request that closes no issue, or whose issue names neither a criterion nor "serves no criterion", is refused when `RUNGATE_REQUIRE_CLOSING_REF` is `true`; only a PR whose changed files are all session-record files (`project-state.json`, `PROJECT-STATE.md`, `SUCCESS.md`) owes none, decided from the diff and never from the branch name; the check re-runs when the description is edited, and its refusal prints the one command that re-runs it
      proved-by: test/audit-closing-references.test.ts — 29 pass, 0 fail, 2026-11-11, merged in #2003 (closing #1998). Live: `RUNGATE_REQUIRE_CLOSING_REF` is `true` and `closing-references` is a required check on main, so the refusal is enforced rather than annotated.
<!-- REVIEW: unmatched (rewriting as file-exists would assert only that project-state.json exists, while the criterion coordinates a further claim (whose issue names neither a criterion nor "serves no criterion", is refused when `RUNGATE_REQUIRE_CLOSING_REF` is `true`; only a PR whose changed files are all session-record files (`project-state.json`, `PROJECT-STATE.md`, `SUCCESS.md`) owes none, decided from the diff and never from the branch name; the check re-runs when the description is edited, and its refusal prints the one command that re-runs it) — the file is mentioned, not what the criterion is about) -->
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
- [x] SC-2738: merging an ADR whose status changes to accepted places its plan on the board with no command typed by hand — milestones, issues, blocked-by edges, board fields and a Ready top-up — and the filing refuses both a duplicate of a closed issue and a criterion id that exists in no spec
      proved-by: test/adr-accepted-workflow.test.ts (16 pass) and the `SC-2738` describe in test/issue-decomposition.test.ts (7 pass), 0 fail, 2026-11-12, on the PR that closes #1999. `.github/workflows/adr-accepted.yml` is parsed: it fires on a push to main touching docs/adr, runs plan-spec, plan-issues --decompose, plan-deps, board-mirror and board-ready --top-up in that order, each gated on the acceptance read, with the board token in the two board steps only. `plan-issues --accepted-since` lists exactly the ADR a real git history accepted and refuses a commit the clone lacks; `--decompose` files nothing for a title closed as completed by a trusted author, and refuses an id no spec states. Ten mutants, each caught. The first live run is the first ADR accepted after merge.
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
- [x] SC-2739: an ADR written from the repository's ADR template carries a Decomposition table that `plan-issues --decompose` reads with no refusal
      proved-by: test/adr-template.test.ts, the `SC-2739` describe — 6 pass, 0 fail, 2026-11-11, on the PR that closes #2000. `docs/adr/TEMPLATE.md` filled the way an author fills it parses MEASURED through `parseDecompositionPlan`; unfilled it is refused. Renaming the Outcome header, adding a column, dropping the file limit or pre-filling the criterion each turns 1 to 4 of the cases red; `plannedTitles` reads the real template and yields no title.
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
- [x] SC-2740: one command shows a proposal as a dry run — the real planning tools without `--write`, what reaches Ready, the gaps found — and writes its visual next to the document
      proved-by: test/dry-run-command.test.ts, the `SC-2740` describe — 13 pass, 0 fail, 2026-11-12, on the PR that closes #2001. `.claude/commands/dry-run.md` is read from the repository: it names the three planning tools and work-status, What reaches Ready, Gaps found, Needs you and the `-flow.html` visual opened on macOS or Linux, forbids `--write`, and no command line in it passes one. Dropping `Gaps found`, or adding `--write` to the plan-deps line, each turns one case red.
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
- [x] SC-2741: Ready holds only work from the active milestone, the lowest Pipeline phase with an open issue, plus `work-this-next`; label-only and payload work never enter while a Pipeline phase has an open issue, a card outside the active milestone is demoted, and adding or removing a milestone, or adding a label, triggers the refill — issues enter by filing, never by transfer (Jason, 2026-11-12, #1752)
      proved-by: one test per clause, 2026-11-13, -t "SC-2741|#2037|#2007" — active milestone plus work-this-next: test/board-mirror.test.ts (9 pass) and test/active-milestone.test.ts (7 pass, both Ready writers read one population); label-only and payload kept out, and demotion outside the focus: test/board-ready-fanout.test.ts (8 pass); the refill triggers and issues entering by filing, never by transfer: test/board-ready-rule.test.ts (11 pass). 0 fail. Ticked by `sync-sc-status --only SC-2741` (#2054).
<!-- REVIEW: unmatched (no registry pattern was close enough) -->

### The process reaches consumers through scaffold

ADR-014 records the decisions; its Decomposition table files one issue per
criterion below. Measured 2026-11-12 at `812f7e04`: the scaffold owns four
workflows and none of ADR-013's four, two of the scripts they run ship in
neither `files[]` nor the CLI, and nothing prints the steps only a person can
take.

- [ ] SC-2742: every script a process workflow runs ships in `package.json` `files[]` and runs as a `rungate` CLI command, so a consumer's workflow calls the CLI and never `bun scripts/…`
<!-- REVIEW: unmatched (rewriting as file-exists would assert only that package.json exists, while the criterion coordinates a further claim (runs as a `rungate` CLI command, so a consumer's workflow calls the CLI and never `bun scripts/…`) — the file is mentioned, not what the criterion is about) -->
- [ ] SC-2743: `rungate scaffold` emits `.github/workflows/closing-references.yml` as an owned, regenerated workflow, and this repository's copy is the generated one
<!-- REVIEW: unmatched (rewriting as file-exists would assert only that github/workflows/closing-references.yml exists, while the criterion coordinates a further claim (this repository's copy is the generated one) — the file is mentioned, not what the criterion is about) -->
- [ ] SC-2744: `rungate scaffold` emits `.github/workflows/adr-accepted.yml` as an owned, regenerated workflow, and this repository's copy is the generated one
<!-- REVIEW: unmatched (rewriting as file-exists would assert only that github/workflows/adr-accepted.yml exists, while the criterion coordinates a further claim (this repository's copy is the generated one) — the file is mentioned, not what the criterion is about) -->
- [ ] SC-2745: `rungate scaffold` emits `board-ready.yml` and `board-intake.yml` as owned workflows that read the board's identity from project config, and no generated workflow contains a literal project id or URL
<!-- REVIEW: unmatched (rewriting as file-exists would assert only that board-ready.yml exists, while the criterion coordinates a further claim (`board-intake.yml` as owned workflows that read the board's identity from project config, and no generated workflow contains a literal project id or URL) — the file is mentioned, not what the criterion is about) -->
- [ ] SC-2746: `rungate scaffold` installs `.claude/commands/dry-run.md` and `docs/adr/TEMPLATE.md` as owned files
<!-- REVIEW: unmatched (rewriting as file-exists would assert only that claude/commands/dry-run.md exists, while the criterion coordinates a further claim (`docs/adr/TEMPLATE.md` as owned files) — the file is mentioned, not what the criterion is about) -->
- [ ] SC-2747: `rungate scaffold` installs the four-step process as an owned rules file, generated from the same single source that this repository's own rule 9 is checked against, so the consumer's copy and ours cannot drift
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
- [ ] SC-2748: `rungate scaffold` writes `board.expediteLabel` and `board.filingOverrideLabel` when the config lacks them, or names each one that stays unset
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
- [ ] SC-2749: `rungate scaffold` ends by printing each human step still owed as one command — the project token secret, `RUNGATE_REQUIRE_CLOSING_REF`, and every process check that runs but is not required on the default branch — and prints `UNMEASURED` for any it could not read, never "done"
<!-- REVIEW: unmatched (no registry pattern was close enough) -->

### Nothing in the engine is hand-run

The engine is the tooling that turns a spec into board state. The payload is a
spec shipped through it. Judgement belongs on the payload and in
human-authored artefacts in git; it does not belong in an agent's hands at
run time. ADR-009 draws the boundary.

- [x] SC-2618: one command reports the board's conformance and exits non-zero while any reading is short of its target, so a loop has a terminal condition that is not an agent's opinion
      proved-by: test/board-conformance.test.ts — 75 pass, 0 fail, 2026-11-07 (PR #1890). The terminal condition was already right before #1718 and the DIAGNOSIS was not: a bare run exited 1 while printing five UNMEASURED rows saying the reading's source was not wired yet — a claim that the tool was unfinished, emitted because nobody had passed a spec. A reader acts on the reason, not the exit code. The command now produces exactly two verdicts, exit 0 with `every reading is met` or non-zero naming how many are short, and it produced the SHORT one within minutes of this tick: merging #1718 closed the only issue naming SC-2618, SC-2619 and SC-2620 and took `criterion-coverage` to 23 of 26. That is the criterion working, not failing — the identical sequence is recorded in SC-2613's own proved-by against #1873 and merge `849ad16c`. What was broken: the two no-source cases run a staged copy of the command AND a staged copy with `REFUSE_EXIT = 0`, against ONE shared refusing producer, so the contrast is the exit constant rather than two different ways of failing; a bare `run(SCRIPT, [])` would reach the live API from inside the suite and report a pass.
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
- [x] SC-2619: every input that command reads comes from the repository or the live API, and a step that reads a file an agent assembled by hand is a refusal naming it — `criterion-inventory` needed a hand-built snapshot handed to it on 2026-10-30, so its numbers were reproducible by nobody else
      proved-by: test/board-snapshot.test.ts — 63 pass, 0 fail, 2026-11-07 (PR #1890), plus test/criterion-inventory.test.ts for the half this criterion names by hand. `criterion-inventory` already refused a hand-built snapshot, measured directly: a directory holding only issues.json and prs.json exits 1 saying there is no taken.json, so nothing says which tracker it came from. The half that was missing was the conformance command's own three inputs, which arrived only as command-line arguments. Spec now falls back to `board.engineSpec`, prefix to `board.milestonePrefix`, repository to GITHUB_REPOSITORY and then this project's origin through the existing `resolveRepoSlug` rather than a second reader. A GIVEN-AND-BLANK value still refuses and never spawns; only ABSENCE falls through, because a typed empty is a mistake to name and reaching past it to config would override a person with a file. Review round 1 of #1890 found that rule applied to two of the three inputs — an empty string survives `??` and `resolveRepoSlug` reads it as not-given, so a blank --repo took a live reading against whatever origin pointed at — and both the gate and its test now ENUMERATE the forwarded flags and derive their rows, so a fourth added without one is a visible omission rather than three hand-written conditions short by one. What was broken: each blank row runs against a project whose config COULD satisfy the blanked flag, so a pass cannot come from there being nothing to fall back to, and the control with real values runs.
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
- [x] SC-2620: the conformance command runs as a test on main, so a board that drifts reddens CI rather than waiting for somebody to look at it
      proved-by: Actions run 42462454243 on `a0201e21`, the push that merged #1898, plus test/board-conformance-job.test.ts — 15 pass, 0 fail, 2026-11-08. The criterion says "as a test" and this is a job rather than a case in the suite, deliberately: the `test` job is a required check, so a short board would have reddened every pull request, and a merge that legitimately closes the last issue for a criterion takes the board short for the minutes between the merge and the tick. #1892 settled that as report-only, which is what `.github/workflows/board-conformance.yml` does — no `pull_request` trigger, so nothing can make it required. **The first real run is the evidence, not the suite.** It fired on the push to `main`, resolved `secrets.RUNGATE_PROJECT_TOKEN` inside `run:`, read the live board, printed `SHORT criterion-coverage 25 of 26 — 1 short` and exited 1, with the failure annotation titled `Board conformance` and no `Board conformance UNMEASURED` warning anywhere in the run's annotations — so the reading was taken rather than skipped. The one short criterion it caught was this one: closing #1892 removed SC-2620's only open issue, which is the exact sequence SC-2613's `proved-by` records against #1873 and the exact failure #1892 was filed about. What was broken to prove the check can fail: `test/board-conformance-job.test.ts` executes the step's own `run:` body under `bash -e` and re-runs the short-board input against a mutant body whose `exit $status` is `exit 0` — real exits 1, mutant exits 0; separately, adding `continue-on-error: true` to the step turned exactly one case red.
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
- [ ] SC-2621: the project board's identifiers are read from project config, so a session told nothing can address the board, and an absent board config is UNMEASURED rather than an empty reading — the node id appeared in 0 repository locations on 2026-10-30 and lived only in agent prompts
<!-- REVIEW: unmatched (no registry pattern was close enough) -->

### The chain traces back to a goal

- [ ] SC-2622: no criterion in this section is satisfied by a symbol being present — each names a behaviour, and a mutant removing that behaviour turns its test red; 1131 of 1485 ticked criteria repo-wide were symbol-presence on 2026-10-30
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
- [ ] SC-2623: a spec declares which of the project's standing success claims it serves, so *which goal does this spec serve* is answerable without reading the spec — the same traceability this document demands of issues, one level up
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
- [ ] SC-2624: `/goal` establishes a goal from measured evidence when none exists or the recorded one is past its own staleness bound, instead of reporting against it — the fleet goal file carried one five days stale and about another subject throughout the session that wrote this
<!-- REVIEW: unmatched (no registry pattern was close enough) -->

### What this does not govern

**The second of two boundaries.** The first, *What this spec does NOT govern*
near the top, names the sibling specs that own neighbouring subjects. This one
is the engine/payload split. Grepping this document for "does not govern"
finds both; stopping at either gives half the scope.

**This spec is the ENGINE. It governs no payload, and a payload's own
criteria are never repaired by editing this file.**

| | What it is | Who reviews it | Where its criteria live |
|---|---|---|---|
| **Engine** | the tooling that turns a spec into milestones, issues, blocked-by edges and board state | nobody by hand — a command | here |
| **Payload** | a spec shipped *through* the engine | Jason | in that spec |

`specs/CODE-REVIEW-CONVERGENCE-SPEC.md` is the first real payload and is
named here so the boundary has an instance rather than a definition. Its 44
phase criteria are its own; none of them is in scope for this document, and
a finding against the convergence spec is not a finding against the engine.

The two were conflated once already and it cost a build order. ADR-008 ran
the pipeline against the pipeline's own spec, which is legitimate — the
engine's work is also work — but it made *engine* and *payload* look like one
population, and a criterion that belongs to neither is how 25 of 71 open
issues came to name nothing at all.

- [ ] SC-2625: the engine is finished when `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` reaches the board through the pipeline with no agent editing any issue, milestone, edge or field by hand — the acceptance test is a payload shipping untouched, not a count of criteria ticked here, because every criterion in this document can be green on a tool nobody else can run; a run in which any hand edit occurs fails it and names the edit
<!-- REVIEW: unmatched (rewriting as file-exists would assert only that specs/CODE-REVIEW-CONVERGENCE-SPEC.md exists, while the criterion coordinates a further claim (field by hand — the acceptance test is a payload shipping untouched, not a count of criteria ticked here, because every criterion in this document can be green on a tool nobody else can run; a run in which any hand edit occurs fails it and names the edit) — the file is mentioned, not what the criterion is about) -->

### Phase placement — every criterion has exactly one home

A criterion in no phase is unreadable as anything: *nobody has reached it*,
*it cannot start* and *it is finished* all render as absence, and the backlog
is built from this document.

| Placement | Criteria |
|---|---|
| **Phase 0** | SC-2600, SC-2601, SC-2602 |
| **Phase 1** | SC-2603, SC-2604, SC-2605 |
| **Phase 2** | SC-2606, SC-2607 |
| **Phase 3** | SC-2608, SC-2609, SC-2610 |
| **Phase 4** | SC-2611 |
| **Phase 5** | SC-2612, SC-2613, SC-2614, SC-2750 |
| **Phase 6** | SC-2615, SC-2616, SC-2617, SC-2734, SC-2735, SC-2736, SC-2737, SC-2738, SC-2739, SC-2740, SC-2741, SC-2752, SC-2753, SC-2762 |
| **Phase 7** | SC-2618, SC-2619, SC-2620, SC-2621, SC-2742, SC-2743, SC-2744, SC-2745, SC-2746, SC-2747, SC-2748, SC-2749, SC-2751 |
| **Phase 8** | SC-2622, SC-2623, SC-2624 |
| **Phase 9** | SC-2625 |

### Phase 0 — the transform refuses

Every step reports UNMEASURED rather than an empty reading. Mostly true
already; SC-2602 is the proof that the refusals can fail.

### Phase 1 — a criterion becomes issues

Step 4 of ADR-003, the step nothing performed. Measured 2026-10-29: 42 of the
47 covered criteria sat at exactly one issue, a 1:1 shape nobody chose.

### Phase 2 — the order is data

AGENTS.md rule 4. Edges exist for the phases a spec places; the gap is specs
with no placement table, which is Phase 4.

### Phase 3 — the board tells the truth

What the board must show: open it and see every issue, its milestone, and the
criteria it serves, without opening anything. This is the *readable board* half
of the goal, and it is measured on the engine's own issues.

It is not the acceptance test — that is Phase 9, and the two are different
questions. This one can be satisfied by a board an agent populated by hand;
Phase 9 cannot, because its subject is a spec the engine did not write.

### Phase 4 — every spec is planned

Until a spec has a placement table, `plan-spec` makes it no milestones and
the board cannot place its criteria. This is the widest gap by count.

### Phase 5 — the loop closes

A finding becomes a criterion, and every path that creates an issue is
metered. Without these the backlog grows faster than the pipeline drains it —
AGENTS.md rule 7, opened against closed.

### Phase 6 — the board's state is a reading

Phases 0-5 are about the machinery. This one is about its output: placed,
attributed and ordered are three readings anybody can take, and each is
currently taken by an agent looking at four tools and forming a view.

### Phase 7 — nothing is hand-run

One command, runnable by a person and by CI, reading only the repository and
the live API. This is what takes the agent out of the trust chain, and it is
also what makes `/loop` able to terminate on something other than an opinion.

### Phase 8 — the chain traces back to a goal

The defect this document fixes for issues, applied to specs. An issue that
names no criterion and a spec that names no goal are the same failure at two
heights, and only the first one has a tool.

### Phase 9 — the payload ships

Strictly last, and the only phase whose subject is not this document. Every
phase above can be green on an engine nobody but its author can run; this one
cannot, because it is measured on a spec the engine did not write. It is the
acceptance test, so it is also the honest answer to *when is the engine done*
— and that answer is deliberately not "every box above is ticked".

### Exit conditions

- Every open issue names at least one criterion, or carries a recorded reason
  it serves none.
- `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` has reached the board through the
  engine with no hand edits (SC-2625). This is the one that ends the work.
- Every criterion in every spec is reachable from the board: a milestone, an
  issue, or an explicit "not started".
- `rungate plan-deps` with no `--write` reports no missing edge.
- [ ] SC-2750: lib/issue-filing-gate.ts contains [heredocFilingReach] — a gh issue create reached through a heredoc — inside a subshell, a brace group, a continued line or eval — is metered by the filing cap as a filing attempt, never passed unmetered
- [ ] SC-2751: lib/issue-closure-audit.ts contains [openWithMergedCloser] — a merged pull request whose closing reference names an issue that is still open is reported naming both, so shipped work never reads as outstanding
- [ ] SC-2752: scripts/board-conformance.ts contains [declaredWorkUnaccounted] — every unticked criterion in an in-scope spec and every open stage item in project-state.json names an open issue, or board-conformance reports it as unaccounted, by name
- [ ] SC-2753: lib/issue-filing-gate.ts contains [committedFilingCap] — the filing cap's size and ceiling are read from committed config only, so a working-tree edit cannot raise an agent's own cap
- [ ] SC-2762: lib/board-ready-rule.ts contains [needsCriterionRefusal] — an issue labelled needs-criterion is never promoted into Ready (work-this-next refuses it by name), and work-status prints how many open issues carry the label and the oldest
