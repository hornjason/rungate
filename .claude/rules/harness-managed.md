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
---

These files are managed by rungate. **Do not edit them directly.** What
"managed" means differs per file — the third column says which, because
#208 was a row that promised regeneration for a file the generator skipped
forever.

| File | Strategy | How to customize | What NOT to do |
|------|----------|-----------------|----------------|
| `AGENTS.md` | section-preserving | Everything but `## Hard Constraints` is generated from the scan and `.claude/rungate/`; put non-inferable project rules in that section and they carry forward | Don't hand-edit the generated sections — a re-scaffold rewrites them without reporting it |
| `.github/workflows/ci.yml` | job-preserving | Set `ci` fields in `.claude/rungate/config.json`; add your own jobs alongside the generated `test` job | Don't edit the generated `test` job |
| `.github/workflows/gates.yml` | job-preserving | Settings from `.claude/rungate/config.json`; add your own jobs alongside the generated `gates` job | Don't edit the generated `gates` job |
| `.github/workflows/ai-review.yml` | job-preserving | Set `ci.vertex` in `.claude/rungate/config.json` to authenticate on Vertex with Workload Identity Federation; add your own jobs alongside the generated `ai-review` job | Don't edit the generated `ai-review` job |
| `.github/workflows/ai-review-unmeasured.yml` | job-preserving | Set `ci.runner` in `.claude/rungate/config.json`; add your own jobs alongside the generated `record-unmeasured` job | Don't edit the generated `record-unmeasured` job, and don't give it a `merge_group` trigger — it reports no status to the pull request and cannot be a required check |
| `.claude/agents/*.md` | section-preserving | Everything but `## Project Constraints` is generated from `.claude/rungate/roles.json` and the templates; put rules mined from this repo's own history in that section and they carry forward | Don't hand-edit the generated sections — a re-scaffold rewrites them without reporting it |
| `.claude/rules/*.md` | provenance | Edit freely — a hand-edited rule is preserved and reported (#370) | Don't expect edits to survive if you also delete the `generated-sha` marker |
| `test/scaffold-conformity.test.ts` | regenerate | Runs automatically | Don't edit |
| `CODE-MAP.md` | regenerate | Auto-generated from code scan | Don't edit |
| `project-state.json` | create-only | DA-owned (#296) — seeded once, then yours | Don't expect re-scaffold to update it; an agent in a worktree must never write it |
| `PROJECT-STATE.md` | create-only | DA-owned (#296) — maintained by the DA; whether this project derives it from the state JSON is reported per project in .claude/rules/key-files.md | Don't edit directly; don't expect re-scaffold to update it |
| `SUCCESS.md` | create-only | Seeded as a template (#485) — fill in the claims; `bunx rungate create-success` re-seeds | Don't leave it as the seed; SUCCESS-1 refuses a template, and re-scaffold will not fill it in |

| Strategy | What re-scaffold does |
|----------|----------------------|
| regenerate | Rewrites it every run; reports CHANGED only when the bytes differ |
| provenance | Rewrites it unless you edited it, in which case it is preserved and reported (#370) |
| job-preserving | Owns named jobs inside a file you also write to; your jobs are carried forward |
| section-preserving | Rewrites the file every run except for named sections, which are carried forward verbatim |
| create-only | Seeds it once and never touches it again — the content is yours, not the harness's |

### The four section-ownership and CI rules moved out (#1069)

`AGENTS.md`'s `## Hard Constraints` and an agent brief's
`## Project Constraints` are **yours** — carried forward verbatim, or the
run **refuses the write** and names the lines it could not carry. The
generated CI jobs are config-driven and never hand-edited. Every workflow
in `.github/workflows/` is reported, owned or not.

Those four rules in full, with the mechanisms and the incidents:
`reference/harness-managed-worked-instances.md`. Moved there because this
file loads on every path under `.claude/agents/**` and `.claude/rules/**`
and sets the PEAK instruction surface — the same reason #544 moved the
worked records, and the budget was down to 246 bytes when this was done.

---

The incidents behind each strategy above — the 37 constraint lines #568 lost,
the unpinned install that re-ran red to green on an identical SHA, the five
`engine: copilot` workflows a clean report never mentioned — are in
`reference/harness-managed-worked-instances.md`. They were moved there by #544
because this rule loads on every file under `.claude/agents/**` and
`.claude/rules/**`, and at 9,484 bytes it put the peak instruction surface
2,124 bytes over budget.
