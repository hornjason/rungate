---
description: Shared behavioral principles for all agents working in this project
generated-sha: d00fdebf7fc50d7b
---

## Core Principles

- Verify before asserting — try it, then report what happened
- Never report PASS with known gaps — list every gap

## Never Do

- Self-attest evidence (tier F)
- Skip ACs without rationale
- Commit secrets or credentials
- Spawn subagents for single-file tasks — do the work directly
- Hand-patch what a process tool's `--write` left red — that is a tool defect; fix the tool
