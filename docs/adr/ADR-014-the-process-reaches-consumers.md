---
doc-type: adr
status: proposed
created: 2026-11-12
updated: 2026-11-12
---

# ADR-014 — the alignment process reaches consumers through scaffold

## Status

**Proposed, 2026-11-12. Revision 1.** Jason decides. Four decisions below
are open and marked **open**; each carries a recommendation. Filed under
#1988 (ADR-013 decision 8), which this ADR's acceptance PR closes.

## Context

ADR-013 built the four-step process for this repository. A consumer that
runs `bunx rungate scaffold .` receives almost none of it. Measured on main
at `812f7e04`, 2026-11-12:

- **The scaffold owns four workflows**: `ci.yml`, `gates.yml`,
  `ai-review.yml`, `ai-review-unmeasured.yml` (`OWNED_FILES`,
  `lib/scaffold/owned-files.ts`). None of ADR-013's four is among them —
  `closing-references.yml`, `adr-accepted.yml`, `board-ready.yml`,
  `board-intake.yml` exist only here.
- **`closing-references.yml` is unowned on purpose**: its header says the
  check is "a policy this repository holds about its own pull request bodies,
  not something the harness generates for its consumers". ADR-013 rule 9
  step 4 makes it the consumer's policy too, so that reason no longer holds.
- **Two scripts the workflows run do not ship**: `scripts/board-ready.ts`
  and `scripts/audit-closing-references.ts` are in neither `package.json`
  `files[]` (39 entries) nor `lib/cli-commands.ts`. `plan-spec`,
  `plan-issues`, `plan-deps`, `board-mirror` and `board-conformance` do ship.
- **The workflows name this repository's board**: `board-intake.yml` hardcodes
  `https://github.com/users/hornjason/projects/3` and `PVT_kwHOAZTQCM4BpMuR`.
- **The scaffold installs no `.claude/commands/`** (no match for
  `.claude/commands` under `lib/scaffold/`), so `/dry-run` (step 2) is absent,
  and it creates `docs/adr/` empty — no `TEMPLATE.md` (step 2).
- **Rule 9 lives in AGENTS.md's Hard Constraints**, a project-owned section
  the generator preserves and never writes.
- **Ten workflows need `RUNGATE_PROJECT_TOKEN`**, and nothing tells a
  consumer to create it, to set `RUNGATE_REQUIRE_CLOSING_REF`, or to make
  `closing-references` required. PROTECT-1 (`lib/branch-protection.ts`) reads
  `required_status_checks.contexts` but only asks whether merges serialise;
  it never compares the contexts with the checks the workflows define.
- **Two config keys fail closed when absent** (#2004, comment on #1988):
  `board.expediteLabel` and `board.filingOverrideLabel`. A consumer without
  them loses the expedite lane and the filing waiver, silently.

## Decision

After every row ships, `bunx rungate scaffold .` on a consumer writes the
four process workflows, the dry-run command, the ADR template and the
process rule as owned files, writes or reports the two label keys, and ends
by printing each human step still owed as one command — measured where the
API allows, `UNMEASURED` where it does not.

## Decisions

1. **Process workflows become scaffold-owned, regenerated — open.**
   Recommendation: owned, the way `ai-review.yml` already is: a generator in
   `lib/scaffold/`, a `generated-sha` marker, WORKFLOW-DRIFT-1 reporting hand
   edits. The alternative, write-once-if-absent, leaves every consumer on the
   version they first installed, and a fix here never reaches them — the
   failure `#622` recorded for a hand-copied `setup-bun` pin. This repository
   regenerates its own copies too, so the bytes here are the bytes consumers
   get.
2. **Consumer workflows call the CLI, never `bun scripts/…` — Rayford, from
   the measurement.** A consumer has `node_modules/rungate`, not `scripts/`.
   Row 1 makes every called script a command first.
3. **The board's identity comes from config — Rayford, same.** `board.project`
   and the project URL are read from `.claude/rungate/config.json`; no
   generator writes a literal project id. ADR-013 decision 5 already did this
   for labels.
4. **Rule 9 reaches consumers as an owned rules file — open.**
   Recommendation: `.claude/rules/alignment-process.md`, scaffold-owned,
   generated from one source that this repository's AGENTS.md rule 9 is
   checked against, so the two cannot drift. The alternative, writing into
   AGENTS.md, means the generator starts editing a section it has always
   preserved.
5. **Rows go into Pipeline Phase 7 — open.** Recommendation: Phase 7,
   "nothing is hand-run" — a consumer copying workflows by hand is exactly
   that. Phase 6 still holds ADR-013's own rows (#2021, #2024), so ADR-014's
   wait until this repository's version is finished, which is the order
   ADR-013 decision 8 asked for.
6. **Scope: ADR-013's four workflows only — open.** Recommendation: yes.
   `board-flow`, `board-sweep`, `phase-order`, `criterion-label` (#2020) and
   `board-conformance` also run here and are left out of revision 1: the
   process works without them, and each adds a generator. A second wave is a
   second ADR or a row added on review.

## Not decided here

- A consumer with no GitHub Projects board: whether the board steps skip
  with an `UNMEASURED` annotation or the scaffold refuses to emit them.
- A consumer who already hand-copied a workflow: WORKFLOW-DRIFT reports the
  copy NOT-OWNED today; whether the scaffold offers to adopt it, and how.
- The second wave named in decision 6.

## Decomposition

Ids SC-2742 to SC-2749 are written as criteria in
`specs/SPEC-TO-BOARD-PIPELINE-SPEC.md` and placed in Phase 7. Like ADR-013's,
they hold no entry in `specs/sc-reservations.json`: checked free (the
highest id any spec states is SC-2741, no reservation is open) and written in
this PR, after which `lib/create-sc.ts`'s `taken` set protects them.

Rows 2 to 6 all edit `lib/scaffold/owned-files.ts` and
`.claude/rules/harness-managed.md`, so they are chained by blocked-by edges
rather than run in parallel.

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| SC-2742 | The process workflows' scripts ship in the package and run as CLI commands | lib/cli-commands.ts, package.json, scripts/board-ready.ts, scripts/audit-closing-references.ts, .claude/rules/commands-routing.md, test/package-closure.test.ts | Pipeline Phase 7 — nothing is hand-run | — |
| SC-2743 | Scaffold emits closing-references.yml as an owned workflow | lib/scaffold/closing-references-workflow.ts, lib/scaffold/owned-files.ts, .claude/rules/harness-managed.md, .github/workflows/closing-references.yml, test/closing-references-workflow.test.ts | Pipeline Phase 7 — nothing is hand-run | The process workflows' scripts ship in the package and run as CLI commands |
| SC-2744 | Scaffold emits adr-accepted.yml as an owned workflow | lib/scaffold/adr-accepted-workflow.ts, lib/scaffold/owned-files.ts, .claude/rules/harness-managed.md, .github/workflows/adr-accepted.yml, test/adr-accepted-workflow.test.ts | Pipeline Phase 7 — nothing is hand-run | Scaffold emits closing-references.yml as an owned workflow |
| SC-2745 | Scaffold emits board-ready.yml and board-intake.yml with the board read from config | lib/scaffold/board-ready-workflow.ts, lib/scaffold/board-intake-workflow.ts, lib/scaffold/owned-files.ts, .claude/rules/harness-managed.md, .github/workflows/board-ready.yml, .github/workflows/board-intake.yml, test/board-ready-fanout.test.ts, test/board-intake.test.ts | Pipeline Phase 7 — nothing is hand-run | Scaffold emits adr-accepted.yml as an owned workflow |
| SC-2746 | Scaffold installs the dry-run command and the ADR template | lib/scaffold/owned-files.ts, lib/scaffold/write-steps.ts, .claude/rules/harness-managed.md, test/scaffold-ownership.test.ts, test/dry-run-command.test.ts | Pipeline Phase 7 — nothing is hand-run | Scaffold emits board-ready.yml and board-intake.yml with the board read from config |
| SC-2747 | Scaffold installs the four-step process as an owned rules file | lib/scaffold/process-rules.ts, lib/scaffold/owned-files.ts, .claude/rules/harness-managed.md, test/process-rules.test.ts, test/rule-provenance.test.ts | Pipeline Phase 7 — nothing is hand-run | Scaffold installs the dry-run command and the ADR template |
| SC-2748 | Scaffold writes the two label keys or reports each one unset | lib/scaffold/steps.ts, test/scaffold-label-keys.test.ts | Pipeline Phase 7 — nothing is hand-run | — |
| SC-2749 | Scaffold ends by printing every human step still owed as one command | lib/branch-protection.ts, lib/scaffold/human-steps.ts, scripts/scaffold-project.ts, test/human-steps.test.ts, test/branch-protection-gate.test.ts | Pipeline Phase 7 — nothing is hand-run | Scaffold emits board-ready.yml and board-intake.yml with the board read from config |

Notes per row:

- **Row 1 goes first**: every emitted workflow calls a command it adds.
- **Row 8** prints, in this order and only the ones still owed: create
  `RUNGATE_PROJECT_TOKEN` (`gh secret set RUNGATE_PROJECT_TOKEN`), set
  `RUNGATE_REQUIRE_CLOSING_REF` (`gh variable set RUNGATE_REQUIRE_CLOSING_REF
  --body true`), and add each process check that runs but is not required to
  the default branch's required checks (one `gh api` call each). A secret's
  value cannot be read; its presence can, by name, with admin scope — without
  it the line says `UNMEASURED`, never "done".
- **Row 7** closes the #2004 comment on #1988.
