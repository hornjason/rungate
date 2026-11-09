---
description: Tests that assert a property about this repository itself — what trips them, and the exact file and line to edit when one goes red
doc-type: reference
status: active
owner: jason
updated: 2026-10-21
---

## The shape

Some tests here assert a property about **this repository** rather than a unit
of code: a census of citations, a list of files on disk, a count of ticked
criteria, two documents agreeing. They go red when your change is correct, in a
file you never opened, because the tree moved.

Three of eight PRs from one swarm were red this way, none a flake
(`reference/self-referential-tests-worked-instances.md`).

**Read this before you add a file, add a doc, add an anchor, or rename
anything.**

## First, the one that will mislead you

**`DRIFT-3` forbids the escape hatch.** `.claude/conformity-allowlists.json`
looks like the place to record "this new file is fine". Adding an entry
**fails the suite** — `lib/conformity.ts` diffs it against `origin/main` and
refuses any array that grew. For the orphan and untested-spec checks the only
legal fix is to make something genuinely reference the new file. DRIFT-3
refuses entries **yours has that main lacks**, so somebody else's merged
*removal* reddens a branch that is behind — rebase before you debug.

## Tier 1 — tripped by adding ANY ordinary file

Most likely to hit a PR that has nothing to do with them.

| Check | Fires when | Fix |
|---|---|---|
| `HYGIENE-3` orphaned files | a new top-level file in `specs/`, `scripts/` or `prompts/` is referenced nowhere | make something reference it — **not** the allowlist |
| `HYGIENE-4` spec routing | a new `specs/*.md` | add a row to `.claude/rules/specs-routing.md` |
| `SC-1891` | same population, second binding over `AGENTS.md` + `.claude/rules/*` | same row |
| `DRIFT-2` untested specs | a new `testable: true` spec no test names | name the spec in a test |
| `CLOSURE-1` / `CLOSURE-8` / `CLOSURE-14` | a published file imports, **`readFileSync`s**, or **tells the user to run** something outside `files[]` | add it to `package.json` `files[]` |
| `Cannot find module` from a `/tmp/…mutant…` path | a new **`import`** in a file some mutation battery copies into an `mkdtemp` | teach the copier to carry it, or keep the file import-free and bind the value with an agreement assertion |

`CLOSURE-8` is the one people miss: a `join(import.meta.dir, "..")` read is an
import in different syntax.

The last row is the UNMEASURED shape, not a noisy one — a battery whose
mutant fails to load goes **green while witnessing nothing**
(`reference/self-referential-tests-worked-instances.md`, *adding an import*).

## Tier 2 — a hand-maintained list or number you must update

The constant is in the test file unless stated otherwise.

| Tripped by | Edit |
|---|---|
| a new `test/consumer-*.ts` | `SCANNED_FILES`, `test/consumer-no-rebuild-delegation.test.ts` |
| a doc gaining or losing a `path:NNN` citation | `.claude/line-citation-ratchet.json` → `documents` |
| a computed anchor cutting `ship.js` | spell it as a string literal — no exemption list, by design |
| a fixed-character `.slice(at, at + N)` in `test/` | `structuralCut`, `lib/source-slice.ts` — no exemption list |
| a new direct `.claude/rungate.json` path read | `.claude/config-access-ratchet.json` (absent file = zero allowed) |
| a write site whose target the resolver cannot follow, in `lib`,`scripts`,`gates`,`bin`,`hooks`,`workflows`,`.github` | `.claude/spec-write-opaque-ratchet.json` — the failure prints the line; absent file = UNMEASURED, not zero |
| ticking an SC with no coverage claim (`sync-sc-status`) | `BANKED`, `test/ticked-sc-cover.test.ts` |
| ticking a `(behavioral)` SC — same event | `BEHAVIORAL_TICKED_RATCHET`, `test/behavioral-sc-ratchet.test.ts` |
| ticking or unticking ANY SC, whether or not a test claims it | `UNCLAIMED_RATCHET` **and** `CLAIMED_UNBINDABLE`, `test/sc-binding-split.test.ts` — equalities, so a fall is refused too |
| an unqualified `SC-N` mention in a test | `CENSUS`, `test/sc-id-namespace.test.ts` |
| a consumer's NAME in `lib/`,`gates/`,`scripts/` | **remove the name** — `CONSUMERS` in `test/anti.test.ts` only shrinks; delist, never add |
| a gate check test with no assertion | `WARN_TIER_CHECKS`, `lib/gate-check-audit.ts` — reason must exceed 80 chars |
| a new gate check test | `config/check-registry.json` |
| a new matcher handler | `config/matcher-registry.json` |
| a new file in `gates/` | `GATE_FILES`, `test/gate-contracts.test.ts` + per-gate SCs in the spec |
| a writer of a tracked file that does not commit it | `KNOWN_UNDECLARED_WRITES`, `scripts/contract-parity.ts` |
| a new file the scaffold owns | `OWNED_FILES`, `lib/scaffold/owned-files.ts` **and** the table in `.claude/rules/harness-managed.md` — both, or `test/scaffold-ownership.test.ts` is red |
| a new hook | its `SC-` comment, `.claude/rungate/hooks.json`, the table in `specs/HOOK-ARCHITECTURE-SPEC.md`, **and** `.claude/settings.json` |
| a `test.todo` naming an SC | it will be refused — bind it or do not name the id |
| a new `specs/` doc with no `- [ ]` criteria | declare "states none" explicitly, and in the routing row too |
| a prompt telling an agent to read a doc | the doc must exist, or the read be qualified |
| a new MCP tool named in a `workflows/*.js` prompt | grant it in `.claude/rungate/roles.json` |
| a raw day stamp in `lib`,`scripts`,`gates`,`hooks`,`bin`,`test`,`workflows` | attach a justification comment |
| a fixed in-repo scratch dir in a test | use `mkdtemp` |
| committing a file `.gitignore` also matches | one or the other, not both |

## Tier 3 — agreements that trip on housekeeping

- `SUCCESS.md`'s standing line must equal `package.json` `version` **and** the
  live npm version — a bump without a publish is red.
- `.bun-version` must equal the version CI declares.
- `AGENTS.md`'s Commands row, `.github/workflows/ci.yml` and
  `.claude/rungate/config.json`'s `test.command` must all name the same string.
- The `#666` table must be **byte-identical** in
  `reference/check-failure-worked-instances.md` and `specs/HARNESS-STANDARD.md`.
- The auto-loaded surface — `CLAUDE.md`, `AGENTS.md`, every un-scoped
  `.claude/rules/*.md` — must stay under `SURFACE_BUDGET_BYTES` in
  `scripts/check-instruction-surface.ts`, itself within 35% of what it
  measures. Adding a rule, or a table row, can redden it.
- Every reference in `AGENTS.md` must resolve on disk.
- Every `.claude/rules/*.md` needs a `description` over 20 characters.

## What to run before you push

No bare full suites — concurrent full runs have killed this machine. Run your
targeted paths **plus the census tests your change can trip**, derived rather
than remembered:

```bash
bun scripts/census-routing.ts          # the `bun test …` line for YOUR diff
bun scripts/census-routing.ts --all    # every row, and what it routes to
```

It reads the diff, not the file list — #990: **an edit to a spec and a tick
inside one are the same path and different events.**

| what you did | what to run |
|---|---|
| added or renamed a file | `test/scaffold-conformity.test.ts` `test/package-closure.test.ts` `test/harness-fixed-point.test.ts` |
| added a doc, or edited one containing file:line citations | `test/line-citation-ratchet.test.ts` `test/agents-md-refs.test.ts` |
| edited any markdown outside test/fixtures/ | `test/prose-self-distance.test.ts` |
| added or edited CLAUDE.md, AGENTS.md or a .claude/rules/ doc | `test/rule-provenance.test.ts` `test/instruction-surface-budget.test.ts` `test/harness-fixed-point.test.ts` |
| added a test file | `test/sc-id-namespace.test.ts` `test/sc-fixture-namespace.test.ts` `test/scratch-paths-unique.test.ts` `test/scratch-cleanup.test.ts` `test/consumer-no-rebuild-delegation.test.ts` `test/ai-review-runner-shell-parity.test.ts` `test/unit/ambiguous-anchor.test.ts` `test/source-census.test.ts` `test/verify-title-check.test.ts` `test/census-routing.test.ts` |
| touched specs/ | `test/agents-md-spec-listing.test.ts` `test/spec-requirements.test.ts` |
| added a specs/ file | `test/audit-specs.test.ts` `test/scanner.test.ts` |
| ticked or unticked an SC (ran sync-sc-status) | `test/sc-binding-split.test.ts` `test/ticked-sc-cover.test.ts` `test/behavioral-sc-ratchet.test.ts` `test/ticked-sc-absent-symbol.test.ts` |
| touched a specs/ file that has a suite named after it | the suite named after it: `test/` + its basename lowercased + `.test.ts` |
| touched gates/, hooks/ or the scaffold | `test/gate-contracts.test.ts` `test/scaffold-ownership.test.ts` `test/hook-traceability.test.ts` |
| changed a generated workflow, or the scaffold source that emits one | `test/action-pin-freshness-schedule.test.ts` `test/action-pin-parity.test.ts` `test/agents-md-refs.test.ts` `test/ai-review-credentialed-job.test.ts` `test/ai-review-model-alias.test.ts` `test/ai-review-push-trigger.test.ts` `test/ai-review-runner-shell-parity.test.ts` `test/ai-review-surface-census.test.ts` `test/ai-review-turn-budget.test.ts` `test/ai-review-wif.test.ts` `test/ai-review-workflow.test.ts` `test/ai-review-write-scope.test.ts` `test/allowlist-growth.test.ts` `test/branch-protection-gate.test.ts` `test/bun-version-agreement.test.ts` `test/bun-version-moving-tag.test.ts` `test/ci-concurrency.test.ts` `test/ci-global-tools.test.ts` `test/ci-history-depth.test.ts` `test/ci-setup-step.test.ts` `test/ci-shard-aggregate-measured.test.ts` `test/ci-shard.test.ts` `test/ci-workflow-probe.test.ts` `test/clean-env-suite-job.test.ts` `test/consumer-requirements-ownership.test.ts` `test/failure-intake-promotion.test.ts` `test/generated-workflow-pins.test.ts` `test/generators-config-path.test.ts` `test/issue-file-overlap.test.ts` `test/merge-group-trigger.test.ts` `test/no-fixed-window-slices.test.ts` `test/one-managed-write-path.test.ts` `test/owned-strategy-reachability.test.ts` `test/phase-0.test.ts` `test/post-fix-verify.test.ts` `test/release-guard.test.ts` `test/risk-tier.test.ts` `test/scaffold-audit-agreement.test.ts` `test/scaffold-ci-config.test.ts` `test/scaffold-ci-preservation-mutation.test.ts` `test/scaffold-ci-preservation.test.ts` `test/scaffold-idempotent.test.ts` `test/scaffold-ownership.test.ts` `test/scaffold-permissions-merge.test.ts` `test/scaffold-profile.test.ts` `test/scaffold-rehearsal-marking.test.ts` `test/stacked-pr-ci-trigger.test.ts` `test/suite-flake-truncation.test.ts` `test/suite-flake.test.ts` `test/suite-timeout-margin.test.ts` `test/test-clean-env.test.ts` `test/test-command-agreement.test.ts` `test/test-command-binding.test.ts` `test/transcript-checker.test.ts` `test/typescript-project.test.ts` `test/unit/gates-tier1-jwt.test.ts` `test/unit/generated-shell-syntax.test.ts` `test/unit/secret-patterns.test.ts` `test/workflow-added-section-comment.test.ts` `test/workflow-dispatch-trigger.test.ts` `test/workflow-drift-validation.test.ts` `test/workflow-provenance-merge.test.ts` `test/workflow-residual-comment.test.ts` `test/workflow-top-level-merge.test.ts` `test/workflow-version-skew.test.ts` |
| touched config/ | `test/check-registry.test.ts` `test/matcher-registry-parity.test.ts` |
| wrote the DA-owned session state (project-state.json, PROJECT-STATE.md, SUCCESS.md) | `test/closing-keywords.test.ts` `test/project-state-currency.test.ts` `test/project-state-shape.test.ts` `test/update-project-state.test.ts` `test/success-doc.test.ts` `test/distribution-standing.test.ts` `test/rule-lifecycle-spec.test.ts` `test/check-state-claims.test.ts` |

**Rendered from `CENSUS_TRIGGERS` in `scripts/census-routing.ts` and compared
byte-for-byte by its test**, both directions, so nobody maintains it by hand.
The point is not to run everything: the file you changed is never the only
file with an opinion about it. **This prints a command, it does not enforce**;
a ship run no longer depends on you reading it (#1004).

## If you are writing one of these

Say what to do in the failure message — a bare `expect(violations).toEqual([])`
makes the next agent re-derive the whole mechanism. **Use `remedyMessage` from
`lib/check-remedy.ts`** (#813):

```ts
expect(unlisted, remedyMessage({ root, check: "HYGIENE-4", violations: unlisted, fix: "add a row to …" })).toEqual([]);
```

Every Tier 1 check carries one and `test/check-remedy.test.ts` holds the
population, so a new Tier 1 check needs a row there too. The reasoning, and
what this file's own three failures taught — **cite a stable symbol, never a
line number** — are in `reference/self-referential-tests-worked-instances.md`.

Related: `.claude/rules/checks-must-be-able-to-fail.md`,
`.claude/rules/claiming-sc-coverage.md`, `.claude/rules/harness-managed.md`.
