---
doc-type: guide
governs: the order in which work reaches the board, for both spec work and everyday work
created: 2026-11-03
status: active
updated: 2026-11-03
---

# How work flows

Nineteen commands exist. `.claude/rules/commands-routing.md` lists them
**alphabetically**, which is the right shape for a reference and the wrong
shape for a person trying to get work onto the board. This file states the
**order**, and nothing else — no done-conditions, no plan. The plan is
`project-state.json`'s `goal`, `goals` and `stages` (AGENTS.md rule 10).

There are two paths. Most work is Path B.

---

## Path A — work that comes from a spec

Two artefacts are written by a **person** and reviewed in a diff. Four
commands are deterministic transforms over them. This split is the decision
in ADR-009: *a human-authored artefact in git → a deterministic transform →
live state*. An agent is never the transform.

```
  YOU write                           COMMAND transforms         GITHUB holds
  ─────────                           ──────────────────         ────────────
1 a spec, with a
  "Phase placement" table
                                 2 →  plan-spec            →     milestones

3 an ADR with a
  decompose table
                                 4 →  plan-issues          →     issues
                                 5 →  plan-deps            →     blocked-by edges
                                 6 →  board-conformance    →     a verdict
```

### 1. Write the spec

```bash
bun bin/rungate.ts create-spec "title"
```

Creates the file with the required frontmatter. You then write the criteria
and — this is the part the later steps depend on — a **Phase placement
table** saying which phase each criterion belongs to.

### 2. Placement table → milestones

```bash
bun bin/rungate.ts plan-spec <spec.md> \
  --repo <owner/name> --prefix <name> --write
```

Reads the table and creates the milestones. `--prefix Pipeline` gives
`Pipeline Phase 0`, `Pipeline Phase 1`, and so on. **It writes no file.**
Without `--write` it reports and mutates nothing.

The prefix matters beyond naming: `phaseOf()` in `lib/board-mirror.ts`
extracts the phase number with `/\bPhase (\d+)\b/`, and everything
downstream that orders work reads that number.

### 3. Write the issue plan

A reviewed table in an ADR under `docs/adr/`, one row per issue. **This is
not generated.** It is the second place a person makes a judgement, and the
review of that diff is where the judgement is checked.

Three parser facts that are easy to get wrong:

- a `--decompose` row takes exactly **one** criterion
- `Files` and `Blocked by` cells split on **commas**
- an em dash (`—`) means none

### 4. Plan → issues

```bash
bun bin/rungate.ts plan-issues --decompose <plan.md> \
  --repo <owner/name> --write
```

Creates the issues. `--repair <plan.md>` is the other mode: it links and
demotes issues that already exist. A demotion removes **that issue's** edges
and only that issue's.

Issues reach the project board on their own — the *Auto-add to project*
workflow is on and covers every open issue.

### 5. Phase order → blocked-by edges

```bash
bun bin/rungate.ts plan-deps \
  --repo <owner/name> --milestone-prefix <name> --write
```

Writes GitHub's real issue dependencies, so that *what is next* is computed
rather than remembered.

`--milestone-prefix` is **required, and an absent one is a refusal** — the
command stops with *"`--milestone-prefix` is required"* and writes nothing.
The dry run is refused too, because the dry run is what you consult before
writing and an unscoped count is the misleading half. It used to derive across
every issue carrying any `Phase N` title, which sequences one spec's issues
against another's; #1730 turned that into the refusal, closing #1728.

`plan-deps` never removes an edge. Hand-authored dependencies that no
derivation can reproduce survive it.

### 6. Check it landed

```bash
bun bin/rungate.ts board-conformance
bun bin/rungate.ts board-conformance --list-readings
```

One command, one verdict. It exits non-zero while any reading is short.

---

## Path B — everyday work

Housekeeping, a reviewer's follow-up, something an agent noticed in a
consumer repository. **It has no spec, no criteria and no milestone, and
that is correct** — it is not a degraded Path A.

### File it

```bash
gh issue create --title "..." --label follow-up
```

Say what must become true, and **name the files it will change**. The files
are not decoration: they are what lets anything detect that two issues
cannot be worked in parallel.

### Say what blocks it, if anything

```bash
gh issue edit <N> --add-blocked-by <M>
```

Most everyday work is blocked by nothing, and leaving it empty is the
correct answer — an empty `blocked by` is what puts an issue in the pickable
set. Do not invent an ordering to make the board look tidier.

### Pick it up

```bash
gh issue list --search "is:open -is:blocked no:assignee"
gh issue edit <N> --add-assignee @me
```

`-is:blocked` is computed by GitHub at query time, from live data. **It
cannot go stale**, it needs nothing running, and it does not care whether an
issue has a milestone. This is the one question an agent should ask before
starting anything.

Assigning yourself is the claim. The issue tracker is the only registry
every session can see; a claim anywhere else is not a claim.

---

## Making the board

`rungate board-init --write` makes the project board every command above
reads, so nobody builds one by hand (ADR-023). It creates a project linked to
the repository, or adopts the one `board.id` names. It gives the project the
six lanes (Backlog, Ready, In progress, In review, Done, Cancelled), a Criteria
text field and a board view. It turns off GitHub's "Item closed" and "Pull
request linked to issue" automations, because `board-flow` owns those
moves. Then it writes `board.id` and `board.fields` into the config.

Run it without `--write` first to see what it would do. A second run changes
nothing. Anything it cannot create or read is UNMEASURED, and then no config is
written. The token needs the `project` scope.

---

## What updates itself, and what you run

The commands above run when you **change the plan** — the way a compiler runs
when you change source, not on a timer. Everything else is event-driven.

| Self-updating, nothing to run | Run once, when you decide something |
|---|---|
| issue opened → on the board | you write a spec → `plan-spec` |
| PR linked to issue → In progress | you write an issue plan → `plan-issues` |
| issue closed → Done | phases change → `plan-deps` |
| PR merged → Done | criteria change → `board-mirror` |
| `is:blocked` / `-is:blocked` | |

### Two things GitHub does not do

Neither has a built-in workflow, an official action, or a roadmap item;
GitHub's documented answer for both is a self-written Action driving
`updateProjectV2ItemFieldValue`, with a PAT or GitHub App because
`GITHUB_TOKEN` cannot write ProjectsV2.

- a blocker closing does **not** move the issues it unblocked to Ready
- assigning an issue does **not** set it to In progress

Until those exist, the Ready **column** reflects spec work only, and
`-is:blocked` is the answer for everything else.

---

## Why the Ready column and the pickable query are different

`isReady()` requires an issue to be unblocked, unassigned, **and** in a
placed phase: any milestone `phaseOf` reads. Since ADR-021 a phase orders the
work and never gates it, so an issue nothing open blocks may enter Ready from
any placed phase, up to the lane's depth.

**How Ready ranks** (SC-2741, ADR-021): `work-this-next` first. Then the
milestone's **due date**, earliest first and undated last. Then the engine
before the payload, then the lowest phase, then how many open issues each
unblocks, then the oldest. **To change focus, set or change a milestone's due
date on GitHub's milestone page**; that is the whole mechanism, and to focus a
whole spec you date its phases. Creating, editing or deleting a milestone
refills the lane, as an issue being labelled, milestoned or closed does.
`work-status` (which `/board` reads) prints the same order.

**Ready never holds two issues naming the same file** (SC-2786). A file is
taken when a claimed issue or a card already in Ready names it, an open pull
request changes it, or an issue picked earlier in the same fill names it. An
issue passed over keeps its place and is picked first once the file is free.

**An issue with no phase milestone is never Ready**, and that is correct
rather than a defect to route around. It enters by being placed in a
milestone, or one at a time through `work-this-next`.

**Do not give a triage milestone a `Phase <n>` name to make it score.** It
would match `phaseOf`, enter the frontier calculation, and redden every
board-conformance reading.

Two lanes, and they answer different questions:

| | answers | mechanism |
|---|---|---|
| the board's **Ready** column | what is the next spec work | `isReady`, ranked by due date, then phase (SC-2741) |
| `-is:blocked no:assignee` | what can anyone pick up | GitHub search, live |

---

## Related

- `.claude/rules/commands-routing.md` — every command, alphabetically
- `.claude/rules/parallel-sessions.md` — claiming, worktrees, merging
- `docs/adr/ADR-009-engine-goal-and-build-order.md` — why the transform is deterministic
- `docs/adr/ADR-003-spec-to-tracker-mapping.md` — which phase a criterion belongs to
