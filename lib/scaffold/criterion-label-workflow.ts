/**
 * `.github/workflows/criterion-label.yml`, generated — #2467.
 *
 * An issue that names no criterion and does not say it serves none is
 * labelled `needs-criterion` when it is filed, gets one comment saying why,
 * and loses the label when an edit answers it (#2020). The daily run re-reads
 * every open issue, so a missed event cannot leave the label stale, and a run
 * by hand with no issue is the backfill.
 *
 * ## Why it is generated
 *
 * `board-conformance`'s `criteria-named` reading and the label are compared
 * (by `/board` and `work-status`), and until #2467 only this repository had
 * the workflow. It was caller-owned and ran `bun scripts/criterion-label.ts`,
 * a path no consumer has, so every consumer read the label at 0 beside a
 * real shortfall — our first consumer, 2026-11-19: `criteria-named` 196 short,
 * label 0.
 *
 * ## It calls the published CLI
 *
 * Like every generated workflow it runs `bunx rungate@<version>`, so
 * `criterion-label` had to be in a published release before this file was
 * (`docs/guides/RELEASING.md`). It shipped in 0.8.36 (#2470).
 *
 * ## On a close, it files the successor
 *
 * #2532, serving SC-2625: when an issue closes, the job runs
 * `criterion-successor` on it, so a criterion whose last open issue closed
 * unticked gets a successor filed in its phase milestone, and nobody touches a
 * label, milestone or body by hand. The label step does not run on a close.
 * The command shipped in 0.8.40 (#2490, #2536).
 */

/** The file this module generates, under `.github/workflows/`. */
export const CRITERION_LABEL_WORKFLOW_FILE = "criterion-label.yml";

/** The one job in it. */
export const CRITERION_LABEL_JOB = "criterion-label";

/** Every command the job calls. Each must be registered in `lib/cli-commands.ts`. */
export const CRITERION_LABEL_COMMANDS = ["criterion-label", "criterion-successor"] as const;

/** Once a day, off the hour so it does not queue behind every other scheduled job. */
export const CRITERION_LABEL_CRON = "41 6 * * *";

export interface CriterionLabelWorkflowOptions {
  /** The `runs-on:` value, already JSON-quoted by the caller. */
  runsOn: string;
  /** The pinned `actions/checkout` reference. */
  checkout: string;
  /** The pinned `oven-sh/setup-bun` reference. */
  setupBun: string;
  /** The `with:` body of that step, at ten spaces — the project's single bun declaration (#622). */
  setupBunWith: string;
  /** The step's `env:` block, from `setupBunEnv` (#2039). */
  setupBunEnv: string;
  /** The published harness version every step runs through `bunx`. */
  version: string;
}

/** The whole `criterion-label.yml` body. */
export function buildCriterionLabelWorkflow(opts: CriterionLabelWorkflowOptions): string {
  const cli = `bunx rungate@${opts.version}`;
  return `# Managed by rungate — do not edit the generated job.
#
# #2020, generated since #2467: an issue that names no criterion and does not
# say it serves none is labelled needs-criterion when it is filed, told why
# once, and unlabelled when an edit answers it. The daily run re-reads every
# open issue, and a run by hand with no issue is the backfill. When an issue
# closes, a criterion it leaves owed by nobody gets a successor (#2532).
name: Criterion label

on:
  issues:
    types: [opened, edited, reopened, closed]
  schedule:
    - cron: "${CRITERION_LABEL_CRON}"
  workflow_dispatch:

permissions:
  contents: read
  # The label and the one comment, and a successor issue on a close.
  issues: write

# One run per issue at a time; the daily sweep has its own group.
concurrency:
  group: criterion-label-\${{ github.event.issue.number || 'all' }}
  cancel-in-progress: false

jobs:
  ${CRITERION_LABEL_JOB}:
    runs-on: ${opts.runsOn}
    steps:
      - uses: ${opts.checkout}
      - uses: ${opts.setupBun}
        with:
${opts.setupBunWith}
${opts.setupBunEnv}
      # The issue number and the event name go through env:, never into the
      # script text. The title and body are written by whoever opened the
      # issue, so they are read through the API and never interpolated here.
      - name: Label issues that name no criterion
        if: github.event.action != 'closed'
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          ISSUE: \${{ github.event.issue.number }}
          ACTION: \${{ github.event.action }}
        run: |
          set -euo pipefail
          args=(--repo "$GITHUB_REPOSITORY" --write)
          if [ -n "\${ISSUE}" ]; then
            args+=(--issue "$ISSUE")
            if [ "$ACTION" = "opened" ]; then args+=(--comment); fi
          fi
          ${cli} criterion-label "\${args[@]}"

      # #2532: a criterion this close left unticked and named by no open issue
      # gets one successor, in its phase milestone. A second run files none.
      - name: File a successor for each criterion the closed issue left owed
        if: github.event_name == 'issues' && github.event.action == 'closed'
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          ISSUE: \${{ github.event.issue.number }}
        run: ${cli} criterion-successor --issue "$ISSUE" --repo "$GITHUB_REPOSITORY" --write
`;
}
