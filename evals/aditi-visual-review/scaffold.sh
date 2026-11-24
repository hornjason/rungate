#!/usr/bin/env bash
# Scaffold a small UI workspace for the aditi-visual-review case (#2751).
# Called by case.yaml context.scaffold_script.
set -euo pipefail

# Refuse to scaffold into an existing checkout. The identity writes below are
# repo-scoped, so running this from a real repo rewrites that repo's author (#84).
# The eval harness runs the case in a directory inside a repository it has just
# created with no commits (measured 2026-11-24, claude 2.1.331: the repository
# is rooted one level above the case's directory). An empty repository is used
# as it is. A repository with any commit is somebody's checkout, and is refused.
if git rev-parse --git-dir >/dev/null 2>&1; then
  if git rev-parse --verify -q HEAD >/dev/null; then
    echo "scaffold.sh: refusing to run inside a git repo that has commits: $(git rev-parse --show-toplevel)" >&2
    exit 1
  fi
else
  git init
fi
WORKSPACE="$PWD"
git -C "$WORKSPACE" config user.email "eval@test.com"
git -C "$WORKSPACE" config user.name "Eval"

mkdir -p components .claude/rungate

# A UI project: `pages` names the page the component renders on, so the brief's
# project-type check says to proceed with the review rather than SKIP.
cat > .claude/rungate/config.json << 'JSONEOF'
{
  "project": "billing-ui",
  "pages": { "/settings/billing": ["SaveBar"] }
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

