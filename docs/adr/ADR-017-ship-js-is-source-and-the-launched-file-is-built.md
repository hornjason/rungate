---
doc-type: adr
status: accepted
created: 2026-11-15
updated: 2026-11-15
---

# ADR-017 — ship.js is source, and the file the Workflow tool launches is built from it

## Status

**Accepted, 2026-11-15.** The DA drafted it from a read-only audit. Jason
approved the ADR, all three Decisions, on #2219 the same day. He also approved
the four criteria (SC-2772..2775 in `specs/HARNESS-STANDARD.md`) as the DA
drafted them. Nothing is open.

## Context

Claude Code's Workflow tool refuses any script over **524,288 bytes**. The
cap is written into the tool's own definition (`maxLength: 524288` on its
script input), and DailyBriefDashboard #1513 hit it as a refusal before any
agent ran. `workflows/ship.js` is **556,509 bytes** on `main` at `b5132b82`
(#2213), so no consumer has been able to launch the ship workflow since
**2026-11-07**, when #1873 crossed the line.

Measured with TypeScript's own parser (`ts.createSourceFile`, comments taken
from node trivia; the first measurement in #2213, by a hand-written lexer, was
wrong and is corrected there):

| part | bytes | share |
|---|---|---|
| comments | 267,909 | 48.1% |
| code | 156,629 | 28.1% |
| template-literal prompt text | 107,054 | 19.2% |
| other strings | 24,917 | 4.5% |

What the audit (posted on #2213) found, with the commands beside each number:

- **Comments never reach a run.** No prompt sends an agent to read ship.js,
  and nothing calls `toString()` on its code. Roughly 50–60% of comment bytes
  are instructions an editor needs; 30–40% are incident history; at least 7%
  restate `.claude/rules/` or `specs/` word for word.
- **15 blocks are hand copies of `lib/`.** Each says so ("INLINED, not
  imported", "Mirror of"). Together they are 82.9 KB. 47.9 KB of that is not
  comment: 33.2 KB is code, and the rest is the strings and prompt text inside
  them. The largest copies (block size, comments included) are of
  `security-verdict` (14.9 KB), `worktree-repo` (11.7 KB),
  `scope-denylist`/`plan-coverage` (11.4 KB) and `workflow-security` (10.0 KB).
  `lib/prior-branch.ts` is copied inline as `priorWorkRefusal` while another
  prompt imports the same module through `bun -e`: one module, both routes.
  The copies exist because a workflow script cannot import at **run** time
  (#69). Nothing stops it at **build** time.
- **About 57% of the file exists because there is no build step:** 268 KB of
  comments plus the 47.9 KB of non-comment bytes in those copies.
- **Chained workflows are not available.** The runtime allows one level of
  nesting. `ship.js` already calls `prove.js`, and `ship-and-heal.js` already
  calls `ship.js`.
- **Stripping alone buys time, not a fix.** Non-comment code grew from 68 KB to
  289 KB between 2026-10-01 and 2026-10-25, about 9 KB a day. It has been flat
  since only because this repository stopped running ship.js
  (direct-ship mode, 2026-10-19).
- **Test coupling:** 151 test files read ship.js source. 82 cut it on
  `──── X-START ────` markers (which are comments), 75 execute extracted
  blocks, and about 30 match comment prose. Docs and code hold 120
  `ship.js:NNN` line citations.

## Decision

`workflows/ship.js` stays the file people edit and tests read. The file the
Workflow tool launches is **generated** from it: comments stripped, and the
pure `lib/` functions the hand copies imitate compiled in. A test fails when
the generated file is stale or over the cap, so the cap is enforced where it
bites rather than discovered by a consumer.

## Decisions

1. **Now, to unblock consumers: a generated, comment-stripped launch file —
   Jason.** About 289 KB today, parses with 0 errors, ~235 KB under the cap. No
   existing test moves, because they keep reading `ship.js`. The documented
   `scriptPath` changes to the generated file, including the ship skill at
   `~/.claude/skills/ship/SKILL.md`, which lives outside this repository.
2. **Then, the real fix: build-time bundling replaces the 15 hand copies —
   Jason.** The generator compiles the pure `lib/` functions in. Eight
   modules are copied. Measured by name on this ADR's review, from each
   module's `import` lines (this replaces the audit's unnamed "four and
   four"): three import a node built-in directly (`child_process`, `fs`,
   `crypto`), and three import another `lib/` module. `prior-branch` is in
   both groups. In detail: `security-verdict`, `scope-denylist` and
   `suite-measurement` import nothing, and `plan-coverage` imports only
   `scope-denylist`, so those bundle as they are. `worktree-repo` (`fs`,
   `child_process`) and `workflow-security` (`crypto`) import node built-ins;
   `prior-branch` imports `child_process` and `./github`; and `dev-liveness`
   reaches `child_process` through `./verified-push`. Those four need a pure
   core split out first, and they are the split row's files. The generator must keep the
   `meta` literal and the top-level `return`, which off-the-shelf bundlers
   reject. The parity tests that hold each copy to its original are retired
   with the copy.
3. **Going forward, incident history goes in the pull request, not the code —
   Jason.** A comment keeps the instruction and the issue number. The story
   lives in the PR. This is a writing rule for new code, not a migration of
   the existing 268 KB, which would cost the ~30 prose-matching tests and the
   120 line citations.

## Not decided here

- **A thin orchestrator** that moves every decision out of the sandbox into
  agent-run scripts. It removes the root cause, but each decision becomes an
  agent round-trip and the agent's report becomes the verdict
  (ship.js says it outright: "an agent that falsely reports ok:true makes
  ship.js proceed"). Reserve it for logic that needs I/O anyway.
- **Moving existing comment history to `reference/`** (the #1009 pattern). It's
  not needed once Decision 1 lands, and it's costly per the coupling numbers.
- Whether `ship.mode` returns to `harness` in this repository. Separate, and
  Jason's.

## Decomposition

The criteria are in `specs/HARNESS-STANDARD.md` (the spec governing the ship
workflow), worded as Jason approved them on 2026-11-15 and reserved in
`specs/sc-reservations.json`. The Milestone cells are empty because that spec
has no phase placement table, so these issues land unphased.

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| SC-2772 | Generate a comment-stripped ship launch file under the Workflow tool cap | scripts/build-workflow-launch.ts, workflows/ship.run.js, test/workflow-launch-build.test.ts, package.json | — | — |
| SC-2773 | Point every documented ship scriptPath at the generated launch file | lib/ship-mode.ts, .claude/rules/ship-workflow.md, CLAUDE.md | — | Generate a comment-stripped ship launch file under the Workflow tool cap |
| SC-2774 | Split pure cores out of the lib modules ship.js copies by hand | lib/worktree-repo.ts, lib/workflow-security.ts, lib/prior-branch.ts, lib/dev-liveness.ts, scripts/build-workflow-launch.ts, test/workflow-launch-build.test.ts | — | Generate a comment-stripped ship launch file under the Workflow tool cap |
| SC-2775 | Bundle the pure lib cores into the generated ship launch file | scripts/build-workflow-launch.ts, workflows/ship.js, test/workflow-launch-build.test.ts | — | Generate a comment-stripped ship launch file under the Workflow tool cap, Split pure cores out of the lib modules ship.js copies by hand |
