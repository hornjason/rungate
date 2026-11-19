---
description: Files managed by rungate scaffold — do not edit directly
paths:
  - "AGENTS.md"
  - ".github/workflows/ci.yml"
  - ".github/workflows/gates.yml"
  - ".claude/agents/**"
  - ".claude/rules/**"
  - "test/scaffold-conformity.test.ts"
  - "CODE-MAP.md"
generated-sha: 5c9c9cb87f5f036f
doc-type: reference
status: active
updated: 2026-11-15
---

These files are managed by rungate. **Do not edit them directly.** What
"managed" means differs per file; the Strategy column says which (#208).

| File | Strategy | How to customize | What NOT to do |
|------|----------|-----------------|----------------|
| `AGENTS.md` | section-preserving | Everything but `## Hard Constraints` is generated from the scan and `.claude/rungate/`; put non-inferable project rules in that section and they carry forward | Don't hand-edit the generated sections — a re-scaffold rewrites them without reporting it |
| `.github/workflows/ci.yml` | job-preserving | Set `ci` fields in `.claude/rungate/config.json`; add your own jobs alongside the generated `test` job | Don't edit the generated `test` job |
| `.github/workflows/gates.yml` | job-preserving | Settings from `.claude/rungate/config.json`; add your own jobs alongside the generated `gates` job | Don't edit the generated `gates` job |
| `.github/workflows/ai-review.yml` | job-preserving | Set `ci.vertex` in `.claude/rungate/config.json` to authenticate on Vertex with Workload Identity Federation; add your own triggers or jobs alongside the generated `ai-review` job | Don't edit the generated `ai-review` job, or the trigger types under `on.pull_request` — scaffold rewrites them (#2292) |
| `.github/workflows/ai-review-unmeasured.yml` | job-preserving | Set `ci.runner` in `.claude/rungate/config.json`; add your own jobs alongside the generated `record-unmeasured` job | Don't edit the generated `record-unmeasured` job or give it a `merge_group` trigger — it reports no status, so it cannot be required |
| `.github/workflows/adr-accepted.yml` | job-preserving | Set `board.engineSpec` and `board.milestonePrefix` in `.claude/rungate/config.json` and re-scaffold; add your own jobs alongside the generated `place-the-plan` job | Don't edit the generated `place-the-plan` job |
| `.github/workflows/closing-references.yml` | job-preserving | Variable `RUNGATE_REQUIRE_CLOSING_REF=true` refuses rather than warns; add your own triggers or jobs alongside the generated `closing-references` job | Don't edit the generated `closing-references` job, or the trigger types under `on.pull_request` — scaffold rewrites them (#2292) |
| `.github/workflows/board-ready.yml` | job-preserving | Set `board.id` in config and secret `RUNGATE_PROJECT_TOKEN`; add your own jobs alongside the generated `move-freed-issues-to-ready` job | Don't edit the generated `move-freed-issues-to-ready` job |
| `.github/workflows/board-intake.yml` | job-preserving | Set `board.id` in config and secret `RUNGATE_PROJECT_TOKEN`; add your own jobs alongside the generated `add-to-board` job | Don't edit the generated `add-to-board` job |
| `.github/workflows/intake.yml` | job-preserving | Advisory — a reading never fails the run; add your own jobs alongside the generated `fix-commit-intake` job | Don't edit the generated `fix-commit-intake` job, and don't drop `fetch-depth: 0` — a shallow clone reads UNMEASURED |
| `.github/workflows/specs-placed.yml` | job-preserving | Opt specs in with a `board:` block; add jobs beside `run-the-engine` | Don't edit `run-the-engine` or share adr-accepted's group |
| `.github/workflows/consumer-intake.yml` | job-preserving | Add jobs beside `triage` | Don't edit `triage` |
| `.github/workflows/criterion-label.yml` | job-preserving | Add jobs beside `criterion-label` | Don't edit `criterion-label` |
| `.claude/agents/*.md` | section-preserving | Everything but `## Project Constraints` is generated from `.claude/rungate/roles.json` and the templates; put rules mined from this repo's own history in that section and they carry forward | Don't hand-edit the generated sections — a re-scaffold rewrites them without reporting it |
| `.claude/commands/dry-run.md` | provenance | Edit freely — a hand-edited command is preserved and reported | Don't delete its `generated-sha` marker, or edits stop surviving |
| `docs/adr/TEMPLATE.md` | regenerate | Copy it to docs/adr/ADR-<n>-<slug>.md and edit the copy | Don't edit the template itself — a re-scaffold rewrites it |
| `.claude/rules/*.md` | provenance | Put edits under `## Project-owned`; it carries forward, the rest regenerates (#1553) | Don't edit outside it — the write is refused, naming the lines |
| `test/scaffold-conformity.test.ts` | regenerate | Runs automatically | Don't edit |
| `CODE-MAP.md` | regenerate | Auto-generated from code scan | Don't edit |
| `project-state.json` | create-only | DA-owned (#296) — seeded once, then yours | Don't expect re-scaffold to update it; an agent in a worktree must never write it |
| `PROJECT-STATE.md` | create-only | DA-owned (#296) ; whether it is derived from the state JSON is reported in .claude/rules/key-files.md | Don't edit directly; don't expect re-scaffold to update it |
| `SUCCESS.md` | create-only | Seeded as a template (#485) — fill in the claims; `bunx rungate create-success` re-seeds | Don't leave it as the seed; SUCCESS-1 refuses a template, and re-scaffold will not fill it in |

| Strategy | What re-scaffold does |
|----------|----------------------|
| regenerate | Rewrites it every run; reports CHANGED only when the bytes differ |
| provenance | Rewrites it unless you edited it; then it is preserved and reported (#370) |
| job-preserving | Owns named jobs inside a file you also write to; your jobs are carried forward |
| section-preserving | Rewrites the file except named sections, carried forward verbatim |
| create-only | Seeds it once and never touches it again — the content is yours, not the harness's |

Section ownership, CI-job rules and incidents: `reference/harness-managed-worked-instances.md`.
This file sets the PEAK instruction surface (#544, #1069).
