---
argument-hint: <issue-number>
doc-type: reference
status: active
updated: 2026-11-07
---

Ship issue **$ARGUMENTS** through the harness. Follow the pipeline:

1. Read the issue yourself and understand the goal — run
   `gh issue view <the number above> --repo hornjason/rungate` as your own
   tool call, not through this file.
   It used to be fetched by an executable block here. That block interpolated
   `$ARGUMENTS` into a shell line, and the runtime substitutes it textually
   before the shell parses — so an argument containing a quote closed the
   quoting and ran as commands. No quoting inside the line can fix that, so
   the block was removed rather than patched (#1746 review, round 3).
2. Read the governing spec (check specs-routing rule)
3. Invoke Skill("harness") to orchestrate implementation
4. The harness delegates to Marcus (code), Quinn (test), Rook (security)
