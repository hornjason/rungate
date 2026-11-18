/**
 * `.github/workflows/consumer-intake.yml`, generated — SC-2784, ADR-020
 * Decision 2.
 *
 * A consumer's issue gets its triage verdict with no command typed by hand:
 * when it is opened, when it is labelled `from-consumer`, and once a day, so
 * an issue whose event was missed is triaged within a day. The work is
 * `rungate consumer-triage --write` (SC-2782), the one decider.
 *
 * ## An outside reporter's label is put back first
 *
 * GitHub silently drops the labels on a new issue whose author has no push
 * access, so `--label from-consumer` never arrives from a real outside
 * consumer. On `opened`, an issue whose author association is not one the
 * triage trusts (`TRUSTED_ASSOCIATIONS`, the same list that decides whose
 * marker counts) is given the label before the triage reads the tracker. A
 * label written with the job's own token fires no further run, so this run
 * is the one that triages it.
 *
 * ## The daily run catches an `opened` run that never happened (#2379)
 *
 * The triage reads only labelled issues, so an outside reporter's issue whose
 * `opened` run was missed would never be triaged. The schedule therefore
 * labels open issues from the last `CONSUMER_INTAKE_SWEEP_DAYS` by an author
 * outside the trusted set that carry no label yet. The window is the board's
 * grace period, and keeping it short means a label a maintainer took off an
 * older issue on purpose is not put back. Issues filed before this workflow
 * existed are labelled by hand, once.
 *
 * ## It calls the published CLI
 *
 * Like every generated workflow it runs `bunx rungate@<version>`, so
 * `consumer-triage` must be in a published release before this file is
 * (`docs/guides/RELEASING.md`).
 */

import { CONSUMER_LABEL, TRUSTED_ASSOCIATIONS } from "../consumer-triage";

/** The file this module generates, under `.github/workflows/`. */
export const CONSUMER_INTAKE_WORKFLOW_FILE = "consumer-intake.yml";

/** The one job in it. */
export const CONSUMER_INTAKE_JOB = "triage";

/** Every command the job calls. Each must be registered in `lib/cli-commands.ts`. */
export const CONSUMER_INTAKE_COMMANDS = ["consumer-triage"] as const;

/** Its own group, never cancelling: each run re-reads the whole tracker. */
export const CONSUMER_INTAKE_GROUP = "consumer-intake";

/**
 * How far back the daily run looks for a missed outside reporter's issue. It
 * equals `CONSUMER_INTAKE_GRACE_MS` in scripts/board-conformance.ts, which
 * test/intake-triage-workflow.test.ts asserts: an issue the board would call
 * overdue is one this run had a day to label.
 */
export const CONSUMER_INTAKE_SWEEP_DAYS = 2;

/** Once a day, off the hour so it does not queue behind every other scheduled job. */
export const CONSUMER_INTAKE_CRON = "17 6 * * *";

export interface ConsumerIntakeWorkflowOptions {
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

/** The whole `consumer-intake.yml` body. */
export function buildConsumerIntakeWorkflow(opts: ConsumerIntakeWorkflowOptions): string {
  const cli = `bunx rungate@${opts.version}`;
  const trusted = JSON.stringify(TRUSTED_ASSOCIATIONS);
  return `# Managed by rungate — do not edit the generated job.
#
# SC-2784 (ADR-020 Decision 2): a consumer's issue is triaged when it is filed
# or labelled ${CONSUMER_LABEL}, and every day, by consumer-triage --write.
# An outside reporter's new issue is given ${CONSUMER_LABEL} first, because
# GitHub drops the labels an author without push access sets.
name: Consumer issues — give each one a triage verdict

on:
  issues:
    types: [opened, labeled]
  schedule:
    - cron: "${CONSUMER_INTAKE_CRON}"

permissions:
  contents: read
  # Milestones, labels and the verdict comment.
  issues: write
  # The triage reads open pull requests for shared files.
  pull-requests: read

concurrency:
  group: ${CONSUMER_INTAKE_GROUP}
  cancel-in-progress: false

jobs:
  ${CONSUMER_INTAKE_JOB}:
    if: \${{ github.event_name == 'schedule' || github.event.action == 'opened' || (github.event.action == 'labeled' && github.event.label.name == '${CONSUMER_LABEL}') }}
    runs-on: ${opts.runsOn}
    steps:
      - name: Give an outside reporter's issue the ${CONSUMER_LABEL} label
        if: \${{ !contains(fromJSON('${trusted}'), github.event.issue.author_association) && github.event.action == 'opened' }}
        env:
          GH_TOKEN: \${{ github.token }}
          NUMBER: \${{ github.event.issue.number }}
        run: gh issue edit "$NUMBER" --repo "$GITHUB_REPOSITORY" --add-label ${CONSUMER_LABEL}

      - name: Give an outside reporter's recent issue the ${CONSUMER_LABEL} label, if its opened run was missed
        if: \${{ github.event_name == 'schedule' }}
        env:
          GH_TOKEN: \${{ github.token }}
          TRUSTED: '${trusted}'
        run: |
          # The default run shell has no pipefail, so a failed read would end
          # in a clean exit and the missed issues would go unlabelled silently.
          set -o pipefail
          SINCE="$(date -u -d '${CONSUMER_INTAKE_SWEEP_DAYS} days ago' +%Y-%m-%dT%H:%M:%SZ)"
          export SINCE
          gh api --paginate "repos/$GITHUB_REPOSITORY/issues?state=open&since=$SINCE&per_page=100" --jq '.[] | select(.pull_request == null) | select(.created_at >= env.SINCE) | select(.author_association as $a | env.TRUSTED | fromjson | index($a) | not) | select([.labels[].name] | index("${CONSUMER_LABEL}") | not) | .number' \\
            | while read -r n; do gh issue edit "$n" --repo "$GITHUB_REPOSITORY" --add-label ${CONSUMER_LABEL}; done

      - uses: ${opts.checkout}
      - uses: ${opts.setupBun}
        with:
${opts.setupBunWith}
${opts.setupBunEnv}
      - name: Triage every consumer issue that has no verdict
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: ${cli} consumer-triage --repo "$GITHUB_REPOSITORY" --write
`;
}
