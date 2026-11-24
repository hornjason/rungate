#!/usr/bin/env bash
# Scaffold a small project with two specs for the discovery-finds-spec case (#2752).
# Called by case.yaml context.scaffold_script.
set -euo pipefail

# Refuse anything but an empty directory. The fixture below writes files, and a
# directory that holds anything, a .git included, is somebody's work. The eval
# harness hands the case an empty directory (measured 2026-11-24, claude
# 2.1.331, in #2751), so this refuses nothing the harness runs.
# A listing that fails is not an empty directory, so it is refused too.
if ! listing="$(ls -A . 2>&1)"; then
  echo "scaffold.sh: refusing to write into a directory that cannot be listed: $PWD ($listing)" >&2
  exit 1
fi
if [ -n "$listing" ]; then
  echo "scaffold.sh: refusing to write into a directory that is not empty: $PWD" >&2
  exit 1
fi

# Claude Code needs a git repository. The harness runs the case in a directory
# inside a repository it has just created, with no commits and no refs at all,
# and that repository is used as it is. Any repository with a ref, a branch or
# a tag on any line of history, is somebody's checkout, and is refused, so no
# fixture file lands in a real working tree. Outside any repository, one is
# made here. git's answer is read in the C locale, so a translated git is not
# misread, and any other answer is refused rather than read as "none".
# Nothing here writes git config or commits, so no repository's identity is
# touched (#84).
if out="$(LC_ALL=C git rev-parse --git-dir 2>&1)"; then
  if ! refs="$(git for-each-ref --count=1 2>&1)" || [ -n "$refs" ] || git rev-parse --verify -q HEAD >/dev/null; then
    echo "scaffold.sh: refusing to write inside a git repository that has history: $(git rev-parse --show-toplevel 2>&1)" >&2
    exit 1
  fi
else
  case "$out" in
    *"not a git repository"*) git init -q ;;
    *) echo "scaffold.sh: git could not read this directory: $out" >&2; exit 1 ;;
  esac
fi

mkdir -p .claude/rules specs lib

# Two specs, routed by area. The issue is about invoice totals, so the
# billing spec governs it; the auth spec is the wrong answer.
cat > .claude/rules/specs-routing.md << 'MDEOF'
Read the governing spec BEFORE making changes in that area.

| Spec | Governs | Testable |
|------|---------|----------|
| AUTH-SPEC.md | Sign-in, sessions and password reset | true |
| BILLING-SPEC.md | Invoices: line items, totals, rounding, and the PDF export | true |
MDEOF

cat > specs/AUTH-SPEC.md << 'MDEOF'
---
doc-type: spec
governs: Sign-in, sessions and password reset
---
# Auth

## Success Criteria

- [ ] SC-A1: A session expires after 30 minutes without a request.
- [ ] SC-A2: A password reset link works once.
MDEOF

cat > specs/BILLING-SPEC.md << 'MDEOF'
---
doc-type: spec
governs: Invoices — line items, totals, rounding, and the PDF export
---
# Billing

## Success Criteria

- [ ] SC-B1: A line total is quantity times unit price, kept to tenths of a cent until display.
- [ ] SC-B2: Every place that shows a total — the screen and the PDF — rounds half-cents up, the same way.
- [ ] SC-B3: The PDF lists every line the screen lists, in the same order.
MDEOF

cat > PROJECT-STATE.md << 'MDEOF'
# Project state

Current priority: billing correctness before the January invoicing run. Open: PDF export parity with the screen.
MDEOF

# The defect the issue describes: two rounding rules for one total.
cat > lib/invoice.ts << 'TSEOF'
export interface Line { quantity: number; unitPrice: number }

export function lineTotal(line: Line): number {
  return line.quantity * line.unitPrice;
}

/** The on-screen total. */
export function screenTotal(lines: Line[]): string {
  const raw = lines.reduce((sum, l) => sum + lineTotal(l), 0);
  return (Math.round(raw * 100) / 100).toFixed(2);
}

/** The PDF total. */
export function pdfTotal(lines: Line[]): string {
  const raw = lines.reduce((sum, l) => sum + lineTotal(l), 0);
  return (Math.floor(raw * 100) / 100).toFixed(2);
}
TSEOF
