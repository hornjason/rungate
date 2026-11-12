---
argument-hint: <path to the ADR or design doc>
description: Show a proposal as a dry run — the real planning tools without --write, what reaches Ready, the gaps found — and write its visual next to the document
doc-type: reference
status: active
updated: 2026-11-12
---

Show **$ARGUMENTS** as a dry run (ADR-013 step 2, SC-2740). Re-run it after
every change to the document until Jason agrees with every step it shows.

## Rules

- **Never pass `--write`.** Nothing is filed or changed on GitHub; the
  `-flow.html` visual is the only file written, besides the local refs
  `git fetch` updates.
- **Quote the path in every command, and stop if it is not an existing file.**
- **Read the document from disk every run.** The document is the input, never
  the conversation, so an edit is picked up by re-running.
- **Real output beats description.** Where a tool can dry-run, run it and
  paste its output in a fenced block. Anything a tool did not produce is
  labelled `SIMULATED`.
- **One line per step.** No prose paragraphs and no tables in the terminal;
  dense content goes in the visual.

If no path was given, use the ADR or design doc under discussion; if there is
none, say so and stop.

## Steps

0. Check the checkout is current before measuring anything (#2016), in this
   order, against the primary checkout step 2 runs from, passed by path and
   never reached with `cd`:
   - Resolve `<checkout>` first, from wherever the session is: run
     `git rev-parse --path-format=absolute --git-common-dir` on its own. If it
     errors or prints nothing, stop: the session is not inside this project.
     `<checkout>` is what it printed with the trailing `/.git` removed. From a
     linked worktree that names the main checkout, never the worktree — the
     same `--git-common-dir` question `repoRootFrom` in `lib/paths.ts` asks.
     Use that path below and in step 2.
   - `git -C "<checkout>" fetch origin main`. If the fetch fails, stop and run nothing else:
     the count below would read a stale ref and could say zero.
   - `git -C "<checkout>" rev-list --count HEAD..origin/main`. If the count is above zero
     the tree is behind origin/main, so stop: print how many commits behind it
     is and that it must be updated first, and run nothing else. If it errors
     or prints anything but a number, stop the same way: no count is not zero.
   - Only when both pass, print `Measured commit: ` and the output of
     `git -C "<checkout>" rev-parse --short HEAD`, so every run names the tree it read.
1. Read the document. Find its decomposition table
   (`| Criterion | Outcome | Files | Milestone | Blocked by |`).
2. Run the real dry runs from the primary checkout, read-only, with
   `env -u GH_TOKEN` wrapping each call that reaches GitHub. Each tool reads
   `GITHUB_TOKEN` and reports UNMEASURED without it, so pass it as shown. The spec and
   milestone prefix come from `readBoardInputs` in `lib/config-readers.ts`.
   - issues and order links: `env -u GH_TOKEN GITHUB_TOKEN="$(env -u GH_TOKEN gh auth token)" bun bin/rungate.ts plan-issues --decompose <doc> --repo <owner/name>`
   - milestones, if the document adds or moves a phase: `env -u GH_TOKEN GITHUB_TOKEN="$(env -u GH_TOKEN gh auth token)" bun bin/rungate.ts plan-spec <spec> --repo <owner/name> --prefix <prefix>`
   - phase-order links: `env -u GH_TOKEN GITHUB_TOKEN="$(env -u GH_TOKEN gh auth token)" bun bin/rungate.ts plan-deps --repo <owner/name> --milestone-prefix <prefix>`
   - what Ready holds now: `env -u GH_TOKEN GITHUB_TOKEN="$(env -u GH_TOKEN gh auth token)" bun scripts/work-status.ts` (START HERE section only)

   If the table is not yet in parser shape, copy it into a `mktemp -d`
   scratch file, run against that, label the ids `PLACEHOLDER`, and delete
   the scratch in the same command.
3. Print the run, one line per step, and paste each real output under it:
   `N. [YOU|ME|HAND|AUTO] what happens → what it creates or changes`.
   YOU = Jason decides or merges. ME = the agent. HAND = a command someone
   must remember. AUTO = a workflow fires on an event.
4. Print **What reaches Ready** once the proposal lands: the active milestone,
   what is pulled first and the cap, what follows as slots open, what is kept
   out and why, and any expedite. Beside it, what work-status START HERE
   pulls today, so the difference is visible.
5. Print **Gaps found** — anything the dry run refused, accepted wrongly, or
   left by hand. One line each.
6. Print **Improves going forward** — one line per change: what stops being
   done by hand or unchecked.
7. Print **Needs you** — each decision as one yes/no line, or "nothing".
8. Write the visual next to the document as `<document-basename>-flow.html`:
   dark theme, a legend for hand / auto / judgement, the run as a timeline,
   every issue as a card, today against after. Open it with `open` on macOS
   or `xdg-open` on Linux; where neither exists, print the path instead.

## Done means

The terminal shows only the numbered run, real outputs, gaps, improvements
and decisions, and the `-flow.html` visual is written and opened, or its path printed.
