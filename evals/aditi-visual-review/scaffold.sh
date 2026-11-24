#!/usr/bin/env bash
# Scaffold a small UI workspace for the aditi-visual-review case (#2751).
# Called by case.yaml context.scaffold_script.
set -euo pipefail

# Refuse anything but an empty directory. The fixture below writes files, and a
# directory that holds anything, a .git included, is somebody's work. The eval
# harness hands the case an empty directory (measured 2026-11-24, claude
# 2.1.331), so this refuses nothing the harness runs.
# A listing that fails is not an empty directory, so it is refused too.
if ! listing="$(ls -A . 2>&1)"; then
  echo "scaffold.sh: refusing to write into a directory that cannot be listed: $PWD ($listing)" >&2
  exit 1
fi
if [ -n "$listing" ]; then
  echo "scaffold.sh: refusing to write into a directory that is not empty: $PWD" >&2
  exit 1
fi

# Claude Code needs a git repository. The harness's directory is already inside
# one it created with no commits, rooted one level up, and that is used as it
# is. Outside any repository, one is made here. Any other answer from git, such
# as a repository it will not open, is refused rather than read as "none".
# Nothing here writes git config or commits, so no repository's identity is
# touched (#84).
if ! out="$(git rev-parse --git-dir 2>&1)"; then
  case "$out" in
    *"not a git repository"*) git init -q ;;
    *) echo "scaffold.sh: git could not read this directory: $out" >&2; exit 1 ;;
  esac
fi

mkdir -p components .claude/rungate

# A UI project: `pages` names the page the component renders on, so the brief's
# project-type check says to proceed with the review rather than SKIP.
cat > .claude/rungate/config.json << 'JSONEOF'
{
  "project": "billing-ui",
  "repo": "example/billing-ui",
  "issueRepo": "example/billing-ui",
  "pages": { "/settings/billing": "SaveBar" }
}
JSONEOF

cat > CODE-MAP.md << 'MDEOF'
# CODE-MAP

## Page → Component Map

| Page | Components |
|------|------------|
| /settings/billing | SaveBar |

## React Components

| Component | File |
|-----------|------|
| SaveBar | components/SaveBar.tsx |
MDEOF

# Three planted defects, each one the brief names a rule for:
# - status text #9e9e9e on #ffffff is about 2.7:1, under WCAG AA's 4.5:1;
# - the delete button is an icon with no accessible name;
# - padding 5px 7px is off the 4px spacing scale.
cat > components/SaveBar.tsx << 'TSXEOF'
import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";

export function SaveBar({ dirty, onSave, onDelete }: { dirty: boolean; onSave: () => void; onDelete: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 7px", background: "#ffffff" }}>
      <span style={{ color: "#9e9e9e", fontSize: 14 }}>{dirty ? "Unsaved changes" : "All changes saved"}</span>
      <Button onClick={onSave} disabled={!dirty}>Save</Button>
      <Button variant="ghost" size="icon" onClick={onDelete}>
        <Trash2 />
      </Button>
    </div>
  );
}
TSXEOF

