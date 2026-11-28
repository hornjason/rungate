/**
 * `.github/workflows/closing-references.yml`, generated — #2045, ADR-014 row 2,
 * SC-2743.
 *
 * The check refuses a pull request whose closing keyword GitHub will never
 * act on, or that closes no issue, or whose issue has not answered the
 * criterion question (ADR-013 rule 9 step 4). It was hand-written and
 * NOT-OWNED on the reasoning that it was this repository's policy about its
 * own pull request bodies. Rule 9 made it every consumer's policy, so the
 * scaffold now writes it, and this repository's copy is the generated one
 * (ADR-014 decision 1): the bytes here are the bytes a consumer gets.
 *
 * ## It calls the published CLI
 *
 * A consumer has `node_modules/rungate`, not `scripts/` (ADR-014 decision 2),
 * so the step runs `bunx rungate@<version> audit-closing-references`. The
 * version is the generating one, the same reading every other `bunx` pin
 * takes, so a tree ahead of npm emits a command the registry cannot satisfy
 * until the release ships. `docs/guides/RELEASING.md` is the sequence.
 *
 * ## It runs in a merge queue too, and reads a real pull request there
 *
 * A required check with no `merge_group` trigger hangs a queue
 * (`test/merge-group-trigger.test.ts`). A queue run has no pull request in
 * its payload, but its ref names one — `gh-readonly-queue/<base>/pr-<N>-<sha>`
 * — so the step reads that pull request rather than reporting a reading it
 * did not take. A ref naming none is UNMEASURED and red.
 */

/** The file this module generates, under `.github/workflows/`. */
export const CLOSING_REFERENCES_WORKFLOW_FILE = "closing-references.yml";

/** The one job in it, which is also the required status context's name. */
export const CLOSING_REFERENCES_JOB = "closing-references";

/**
 * The CLI command the step runs. `lib/cli-commands.ts` must register it, or
 * the workflow calls a command `bin/rungate.ts` refuses (#675's defect).
 */
export const CLOSING_REFERENCES_COMMAND = "audit-closing-references";

/**
 * ONE query, with each issue body on the `closingIssuesReferences` node GitHub
 * returned (SC-2737). `files` is the diff the session-record exemption is
 * decided from, and the list of ADRs the pull request changes (SC-2820), so
 * each file carries its `changeType`: a deleted ADR is not read. `totalCount`
 * travels with the files, the issues and the commits so the command can
 * refuse a list that was cut short.
 */
const QUERY_LINES = [
  "query($owner: String!, $name: String!, $number: Int!) {",
  "repository(owner: $owner, name: $name) { pullRequest(number: $number) {",
  "number body",
  "files(first: 100) { totalCount nodes { path changeType } }",
  "closingIssuesReferences(first: 100) { totalCount",
  "nodes { number title body repository { name owner { login } } } }",
  "commits(first: 250) { totalCount nodes { commit { oid message } } }",
  "} } }",
];

/**
 * The step's `run:` body. Exported so `test/closing-references-workflow.test.ts`
 * executes THIS text against a stub `gh` and `bunx`, rather than a paraphrase.
 *
 * `pipefail` because `run:` is `bash -e`, which takes a pipeline's status from
 * its LAST command: a failed query would hand the command an empty stdin and
 * the step's status would be the command's. No `|| true` and no
 * `2>/dev/null` for the same reason.
 */
export function buildClosingReferencesScript(version: string): string {
  return `set -o pipefail
# A pull request run carries its number. A merge-queue run does not, but its
# ref names the pull request: gh-readonly-queue/<base>/pr-<N>-<sha>.
number="\${PR:-}"
if [ -z "$number" ]; then
  number=$(printf '%s' "\${QUEUE_REF:-}" | sed -n 's|^.*/pr-\\([0-9][0-9]*\\)-[0-9a-f][0-9a-f]*$|\\1|p')
fi
if [ -z "$number" ]; then
  echo "::error::UNMEASURED — this run carries no pull request number and its ref (\${QUEUE_REF:-none}) names none, so there is no pull request body to check. Nothing was read."
  exit 1
fi
# GitHub's answer is the input: the command never computes its own idea of
# whether an issue is linked. --repo because a bare number is not an identity.
gh api graphql -f query="$QUERY" \\
  -f owner="\${GITHUB_REPOSITORY%/*}" -f name="\${GITHUB_REPOSITORY#*/}" -F number="$number" \\
  --jq '.data.repository.pullRequest | {number, body, files: .files.nodes, filesTotal: .files.totalCount, closingIssuesReferences: .closingIssuesReferences.nodes, closingIssuesTotal: .closingIssuesReferences.totalCount, commits: [.commits.nodes[].commit | {sha: .oid, message}], commitsTotal: .commits.totalCount}' \\
  | bunx rungate@${version} ${CLOSING_REFERENCES_COMMAND} --repo "$GITHUB_REPOSITORY"
`;
}

export interface ClosingReferencesWorkflowOptions {
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
  /** The published harness version the step runs through `bunx`. */
  version: string;
}

/**
 * The whole `closing-references.yml` body.
 *
 * It checks out the pull request's tree because the command reads `specs/`
 * for its fourth refusal (a closed issue naming a criterion the tree leaves
 * unticked). The trigger is `pull_request`, never `pull_request_target`, and
 * every permission is read-only, so a fork's code runs with no write token.
 */
export function buildClosingReferencesWorkflow(opts: ClosingReferencesWorkflowOptions): string {
  const indent = (text: string, pad: string) =>
    text
      .trimEnd()
      .split("\n")
      .map(line => (line === "" ? "" : `${pad}${line}`))
      .join("\n");

  return `# Managed by rungate — do not edit. Customize the ci section of .claude/rungate/config.json.
#
# A closing keyword GitHub cannot see, and a pull request that closes no issue
# (#1362, ADR-013 rule 9 step 4). Generated since #2045: rule 9 is every
# consumer's policy, so the scaffold writes this file and this repository's
# copy is the generated one.
#
# RUNGATE_REQUIRE_CLOSING_REF turns the last two refusals on when it is the
# string \`true\`, and at no other value; otherwise they are a warning
# annotation. Make \`${CLOSING_REFERENCES_JOB}\` a required check to enforce it.
name: Closing references

on:
  # \`edited\` is ADR-013 decision 4: adding "Fixes #N" to the description is
  # the remedy the refusal prints, so editing the body re-runs it.
  pull_request:
    types: [opened, synchronize, reopened, edited]
  # A required check must report in a merge queue or the queue waits for it
  # forever. The queue run reads the pull request its ref names.
  merge_group:

permissions:
  contents: read
  # \`closingIssuesReferences\` resolves through the GraphQL API and reads the
  # linked ISSUES, not just the pull request, so both are needed.
  pull-requests: read
  issues: read

jobs:
  ${CLOSING_REFERENCES_JOB}:
    runs-on: ${opts.runsOn}
    steps:
      - uses: ${opts.checkout}
      - uses: ${opts.setupBun}
        with:
${opts.setupBunWith}
${opts.setupBunEnv}
      - name: A closing keyword GitHub cannot see, and a pull request that closes no issue
        env:
          GH_TOKEN: \${{ github.token }}
          PR: \${{ github.event.pull_request.number }}
          QUEUE_REF: \${{ github.event.merge_group.head_ref }}
          RUNGATE_REQUIRE_CLOSING_REF: \${{ vars.RUNGATE_REQUIRE_CLOSING_REF }}
          QUERY: >-
${indent(QUERY_LINES.join("\n"), "            ")}
        run: |
${indent(buildClosingReferencesScript(opts.version), "          ")}
`;
}
