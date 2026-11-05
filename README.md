# RunGate

A ship harness for AI-first development: from issue to merged PR, with a report you can trust.

You should be able to trust that report without checking it again by hand. Coding agents can write a lot of code quickly. The hard part is believing what they say about it. "Tests pass", "0 regressions" and "security: clean" are only useful if the thing reporting them could have said something else. RunGate is built around that. The automation isn't really the product. The product is a report you don't have to re-measure.

> **Status: active development, pre-1.0.** Published on npm as [`rungate`](https://www.npmjs.com/package/rungate). It is used daily on this repo and is being proven on a second, unrelated project. Expect breaking changes between minor versions.

## What it does

RunGate sits between an issue tracker and a coding agent (Claude Code today; the design is agent-agnostic) and runs every change through a fixed pipeline:

```
issue → SCOPE → BUILD → VERIFY → CLOSE → SHIP_PASSED | SHIP_FAILED
```

- **Gates, not guidelines.** Each phase ends at a gate: typecheck, tests, test-first sequencing, security review, compliance grade, review currency, and commit receipt. A failed gate stops the ship. It is not just written into a log.
- **Specs with checkable criteria.** Work is driven by specs whose success criteria name the evidence that proves them. A criterion ticked without evidence is refused.
- **Spec → board, automatically.** A spec's phases become milestones, issues and `blocked by` edges on the GitHub project board. Nobody has to place the plan there by hand.
- **Project-specific agent rules.** `scaffold` gives a repo its agent files and a conformity suite. `extract-constraints` mines the repo's own docs and history for rules an agent couldn't work out from the code.
- **AI review that blocks.** AI code-review findings are judged and posted as review threads on the PR diff, and a blocking finding fails the check.
- **Workflows** for `ship`, `prove` (reproduce and attest a fix), `verify`, `batch-ship`, `ship-and-heal` and multi-agent `council` decisions.

## What "done" means

The project measures itself against falsifiable claims in [`SUCCESS.md`](SUCCESS.md). Each claim has a named check:

1. **Every gate can fail, and has been seen failing.** A mutant with the refusal removed must ship where the real gate refuses.
2. **Every number a run reports describes the committed tree.** No figure can come from before the last edit it describes.
3. **A bad ship is stopped, not described.** Every verdict the harness computes can return `SHIP_FAILED`.
4. **"Could not measure" never reads as "nothing wrong."** Missing, empty or broken input is a separate, loud result.
5. **It works on a repo that isn't this one.**
6. **A managed repo carries its own rules**, mined from that repo's history, not just a generic baseline.
7. **The plan is on the tracker, and no person or agent put it there.**

A green test suite, a passing gate and a merged PR don't count as progress unless they meet these claims. Each of them has been wrong in this repo before.

## Where it stands

- **Working:** the ship pipeline and gates, the spec tooling, AI-review adjudication, scaffolding, and release automation to npm. About 1,500 commits and 900 merged PRs, most shipped through the harness itself. Since 2026-10-19 the repo has been shipping directly while RunGate is stabilised.
- **In progress:** the *engine*. The goal is for a spec to become a readable project board with no hand-run steps ([ADR-009](docs/adr/ADR-009-engine-goal-and-build-order.md)), and for issue intake to be governed so every issue names the criterion it serves.
- **Next:** a full run on a consumer project with a different config layout (claim 5). Until that is done, consumer support is unproven.

Live session-by-session state is in [`PROJECT-STATE.md`](PROJECT-STATE.md).

## Quick start

Requires [Bun](https://bun.sh).

```bash
# In the repository you want to manage
bunx rungate scaffold .                  # agent files, rules and conformity suite
bunx rungate create-success              # seed SUCCESS.md: what the project is for
bunx rungate create-spec "Title"         # a spec with checkable success criteria
bunx rungate board-mirror --project <id> # show the spec's criteria on the project board
bunx rungate board-conformance           # does the board match the spec? non-zero if not
bunx rungate --help                      # every command and its arguments
```

Projects are configured in `.claude/rungate.json` (project slug, code and issue repos, dev/test/prod commands). See [`HARNESS.md`](HARNESS.md) for the schema and workflow entry points.

## Repository layout

| Path | What lives there |
|---|---|
| `bin/`, `lib/` | CLI and core library |
| `gates/` | Gate runner, ship orchestrator and gate tests |
| `workflows/` | `ship`, `prove`, `verify`, `council` and friends |
| `specs/` | Specs that govern the harness's own behaviour |
| `docs/adr/` | Architecture decisions |
| `templates/`, `prompts/` | What `scaffold` writes and the agents read |
| `test/` | The suite. Run with `bun scripts/test-clean-env.ts` |

## Development

```bash
bun install
bun scripts/test-clean-env.ts    # the suite in a clean environment (trust this one)
bun test <file>                  # a single file
```

Start with [`AGENTS.md`](AGENTS.md) and [`CODE-MAP.md`](CODE-MAP.md).
