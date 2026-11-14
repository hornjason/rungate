/**
 * `.github/workflows/board-intake.yml`, generated — #2166, ADR-014 row 4,
 * the second half of SC-2745 (`board-ready.yml` is #2047's).
 *
 * Every new issue and pull request goes on the board, and a pull request
 * offered for review moves to In review. Hand-written and caller-owned until
 * now, with this repository's project URL and node id pasted in. A consumer
 * has neither, so the scaffold writes it and this repository's copy is the
 * generated one.
 *
 * ## It names no board
 *
 * The add step asks `bunx rungate@<version> board-id` (#2173), which reads
 * `board.id` from the checked-out config through the one loader. The add is
 * then `addProjectV2ItemById` on that node id, so a user board and an
 * organisation board need no branch, and no project URL exists anywhere in
 * the file. `actions/add-to-project` is gone: it accepts only a URL.
 *
 * ## The checkout is the default branch, never the pull request
 *
 * The trigger is `pull_request_target`, which runs with secrets in the BASE
 * repository's context. Checking out the head would run a contributor's code
 * holding a token that can write the board. The config is read from
 * `github.event.repository.default_branch`, with `persist-credentials: false`,
 * and `bunx` runs the published package, not anything in the tree.
 *
 * ## An unconfigured tree is UNMEASURED, an annotation and not a red run
 *
 * No `RUNGATE_PROJECT_TOKEN`, or no `board.id` (`board-id` exits 2), ends the
 * add step with a warning and no item id, and the move step's `if:` skips on
 * the empty id (`.claude/rules/config-access.md`). Any other failure stands.
 *
 * ## What the move step keeps, each piece asserted in test/board-intake.test.ts
 *
 * - It owns only the opened -> In review edge. `merged -> Done` and
 *   `closed -> Done` stay with GitHub's built-in workflows, so each
 *   transition has exactly one decider. Do not add a merge or close handler.
 * - Drafts are not moved (BI-2): Jason's call, 2026-11-04.
 * - It keys off the item the add step created (BI-1), never a re-query, which
 *   would race the built-in "Item added to project" workflow.
 * - Every call goes through one retrying helper (BI-7), whose value is stdout
 *   only (BI-8). Every write is read back from the item AND from the project's
 *   search index, which is what the board draws from (BI-6, BI-9). Every paged
 *   read reports truncation instead of reading a full page as absence (BI-10),
 *   and every `node(id:)` refuses a null node by naming the id (BI-11).
 * - No `${{ }}` inside a `run:` block (BI-4), and the one scratch file is
 *   removed on exit (BI-12).
 * - The field and option are resolved by NAME at run time, so a renamed
 *   column fails loudly rather than writing a stale id.
 *
 * The incidents behind each of these are in the hand-written file's history
 * (git log -- .github/workflows/board-intake.yml, before #2166).
 */

/** The file this module generates, under `.github/workflows/`. */
export const BOARD_INTAKE_WORKFLOW_FILE = "board-intake.yml";

/** The one job in it. */
export const BOARD_INTAKE_JOB = "add-to-board";

/** The CLI command the add step runs to learn the board (#2173). */
export const BOARD_ID_COMMAND = "board-id";

/** The add step's `run:` body. Exported so a test executes THIS text. */
export function buildBoardIntakeAddScript(version: string): string {
  return `set -euo pipefail
if [ -z "\${GH_TOKEN}" ]; then
  echo "::warning title=Board intake::UNMEASURED — RUNGATE_PROJECT_TOKEN is not set, so nothing was added to the board."
  exit 0
fi
# The board is board.id in the default branch's config. Exit 2 is the one
# refusal that means none is set.
code=0
project=$(bunx rungate@${version} ${BOARD_ID_COMMAND} 2>"\${RUNNER_TEMP}/board-id.stderr") || code=$?
cat "\${RUNNER_TEMP}/board-id.stderr" >&2
if [ "\${code}" -eq 2 ]; then
  echo "::warning title=Board intake::UNMEASURED — no board.id in the rungate config, so nothing was added. Set board.id and this runs."
  exit 0
fi
if [ "\${code}" -ne 0 ]; then
  exit "\${code}"
fi
item=""
for attempt in 1 2 3; do
  if item=$(gh api graphql -f project="\${project}" -f content="\${CONTENT_ID}" -f query='
    mutation($project: ID!, $content: ID!) {
      addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } }
    }' --jq '.data.addProjectV2ItemById.item.id' 2>"\${RUNNER_TEMP}/add.stderr"); then
    break
  fi
  item=""
  sleep $(( attempt * 2 ))
done
if [ -z "\${item}" ] || [ "\${item}" = "null" ]; then
  echo "::error title=Board intake::addProjectV2ItemById gave no item after three attempts, so the item is NOT on the board. Last error: $(cat "\${RUNNER_TEMP}/add.stderr")" >&2
  exit 1
fi
echo "itemId=\${item}" >> "\${GITHUB_OUTPUT}"
echo "projectId=\${project}" >> "\${GITHUB_OUTPUT}"
`;
}

/**
 * The move step's `run:` body, carried verbatim from the hand-written file
 * (#2166). PROJECT_ID now comes from the add step's output rather than a
 * pasted id; nothing in this text changed.
 */
export const BOARD_INTAKE_MOVE_SCRIPT = `set -euo pipefail

# EVERY API CALL GOES THROUGH HERE, and the reason is \`set -e\`.
# A bare \`gh api graphql\` that fails on a network blip, a secondary
# rate limit or a momentary 5xx aborts this step instantly with gh's
# raw error: the retry loop below is never reached and none of the
# diagnostics in this script ever print. The loop would then be
# guarding the race it was written for and nothing else.
#
# Three calls had that exposure, not the one that was reported —
# resolving the field, mutating, and reading back — so it is fixed
# as a population and \`test/board-intake.test.ts\` BI-7 asserts no
# bare \`gh api graphql\` survives anywhere in this step.
#
# STDERR GOES TO A FILE, NOT INTO THE RETURN VALUE. An earlier
# revision captured \`2>&1\`, which is right for the failure path —
# \${out} is quoted into the ::error — and wrong for the success
# path, because the same \${out} is what callers parse. \`gh\` writes
# to stderr on calls that SUCCEED: the update notifier, rate-limit
# warnings. Two of the three call sites treat the result as data,
# and the read-back is the dangerous one. A comparison against
# "\${COLUMN}" that is polluted by a one-line warning simply stops
# matching, so the loop logs "a concurrent write won" for a race
# that never happened and then blames a competing writer for a
# dirty capture — the right exit code reporting the wrong
# mechanism (\`.claude/rules/checks-must-be-able-to-fail.md\`, the
# sixth shape).
#
# Setting GH_NO_UPDATE_NOTIFIER would silence the one warning that
# was named and leave the class open, so it is not the fix.
err=$(mktemp)
# A trap, not a trailing \`rm\`. Every refusal below exits the step
# early, so a cleanup line at the bottom runs on exactly the path
# that did not need it. Asserted by BI-12.
trap 'rm -f "\${err}"' EXIT
gql() {
  local out attempt
  for attempt in 1 2 3; do
    if out=$(gh api graphql "$@" 2>"\${err}"); then
      printf '%s' "\${out}"
      return 0
    fi
    sleep $(( attempt * 2 ))
  done
  echo "::error title=Board intake::GitHub's GraphQL API failed three times. The item may or may not be on the board and its Status is UNKNOWN — this run measured nothing. Last error: $(< "\${err}")" >&2
  return 1
}

# \`node(id: ID!)\` IS NULLABLE, and a null node is an id that did not
# resolve rather than an empty reading. A stale id, a wrong
# PROJECT_ID, or a project this token lost access to returns
# \`{"data":{"node":null}}\` with NO GraphQL error, so \`gql\` exits 0
# and \`--jq '.data.node.X'\` prints the four bytes \`null\`.
#
# What that does downstream, measured:
#
#   jq '.data.node.fields'  on a null node   -> null,  exit 0
#   jq -r '[.nodes[] | …]'  on \`null\`        -> exit 5
#   jq -r '.pageInfo.hasNextPage' on \`null\`  -> null,  exit 0
#
# So \`set -euo pipefail\` does kill the job rather than write the
# wrong column — but it dies on jq's "Cannot iterate over null",
# naming jq and not the id, and the truncation guard above compares
# the string \`null\` against \`true\` and stays silent. Right exit
# code, unreadable cause, which is this workflow's own subject one
# layer down. BI-11 asserts it over all three reads.
require_node() {
  if [ -z "$2" ] || [ "$2" = "null" ]; then
    echo "::error title=Board intake::\${1} is UNMEASURED and nothing was written: node(id: \${3}) came back null, so that id did not resolve — it is stale, it names an object this token cannot see, or PROJECT_ID is wrong. This is NOT a missing field, NOT an unset column and NOT an empty board." >&2
    exit 1
  fi
}

# An empty item id means the add step did not produce one. Writing a
# field against "" returns a confusing NOT_FOUND about the project,
# so say which half actually failed.
if [ -z "\${ITEM_ID}" ]; then
  echo "::error title=Board intake::The add step produced no itemId, so there is nothing to move. The item was NOT added and its Status is UNSET — this is not a board that merely missed a transition." >&2
  exit 1
fi

# A TRUNCATED PAGE IS NOT AN ABSENT VALUE, and this step asked three
# connections for a FIRST page and then read "not in it" as "not
# there" at all three. Every one of them had the same consequence:
# a confident error message naming a cause that did not happen.
#
# Found in review round 8, reported at one site. It is a population
# — \`fields\`, \`fieldValues\` and the index \`items\` query — and the
# round that introduced it fixed the identical shape in the board
# sweep without carrying it across.
#
# THAT SWEEP IS NOT IN THIS TREE. It is \`scripts/board-status-sweep.ts\`
# on branch \`rg/board-sweep\`, open as PR #1754 and unmerged, so a
# reader of this file cannot resolve the path and review was right
# to say so. Naming the pull request instead: a cross-branch
# reference a reader can follow beats a path that 404s, and the
# citation is kept rather than deleted because the precedent is the
# reason this fix has the shape it does.
#
# The repair is NOT a bigger page. A bigger page has the same defect
# further out. Each connection now asks \`pageInfo { hasNextPage }\`,
# and "wanted value not found AND the page was full" is reported as
# UNMEASURED with its own message — the same treatment #1754 gives
# the same fact under the name \`statusUnread\`, so the two halves
# answer it the same way once both land.
# \`test/board-intake.test.ts\` BI-10 asserts the population rather
# than any one site.
fields=$(gql -f project="\${PROJECT_ID}" -f query='
  query($project: ID!) {
    node(id: $project) {
      ... on ProjectV2 {
        fields(first: 50) {
          pageInfo { hasNextPage }
          nodes { ... on ProjectV2SingleSelectField { id name options { id name } } }
        }
      }
    }
  }' --jq '.data.node.fields')
require_node "the project's field list" "\${fields}" "\${PROJECT_ID}"

status=$(printf '%s' "\${fields}" | jq -r '[.nodes[] | select(.name == "Status")] | first // empty')
field_id=$(printf '%s' "\${status}" | jq -r '.id // empty')
option_id=$(printf '%s' "\${status}" | jq -r --arg c "\${COLUMN}" '.options[]? | select(.name == $c) | .id')

if [ -z "\${field_id}" ] && [ "$(printf '%s' "\${fields}" | jq -r '.pageInfo.hasNextPage')" = "true" ]; then
  echo "::error title=Board intake::The first 50 fields on this project do not include one named 'Status', AND there are more fields beyond that page — so this read is UNMEASURED, not a missing field. Nothing was written. Do not rename anything on the strength of this message; page the fields query instead." >&2
  exit 1
fi

# Resolved by name on purpose, so a renamed field or column is a red
# job rather than a stale node id writing the wrong column quietly.
# Reachable only when the page was NOT truncated, so it can now say
# "renamed" and mean it.
if [ -z "\${field_id}" ] || [ -z "\${option_id}" ]; then
  echo "::error title=Board intake::Could not resolve the Status field or its '\${COLUMN}' option on this project. The whole field list was read, so this is not a truncated page. The item WAS added; only the transition failed. Someone renamed the field or the column — update COLUMN in this workflow to match the board." >&2
  exit 1
fi

# WRITE, THEN READ BACK. Keying off the add step's itemId settles
# WHICH item is written and says nothing about WHEN. This job and
# GitHub's built-in "Item added to project" automation fire off the
# same event and run concurrently, and this one is the slower of
# the two by construction: it resolves the field and the option
# first, which is two round trips the built-in does not make. If
# the built-in's "set to Backlog" lands after this step's write,
# the board reverts and the defect this workflow exists to fix
# returns non-deterministically.
#
# So the mutation's exit code is NOT a reading of the board. A
# write whose effect is never read is indistinguishable from one
# overwritten a millisecond later
# (\`.claude/rules/checks-must-be-able-to-fail.md\`, the sixth
# shape). Three attempts, each verified, and a loud refusal if the
# last one did not stick.
for attempt in 1 2 3; do
  gql \\
    -f project="\${PROJECT_ID}" -f item="\${ITEM_ID}" \\
    -f field="\${field_id}" -f option="\${option_id}" -f query='
    mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $project, itemId: $item, fieldId: $field,
        value: { singleSelectOptionId: $option }
      }) { projectV2Item { id } }
    }' --jq '.data.updateProjectV2ItemFieldValue.projectV2Item.id' > /dev/null

  # Give a concurrent built-in write time to land, so the read-back
  # observes the SETTLED value rather than this step's own write
  # racing ahead of it. Reading immediately would report success
  # and then be overwritten, which is the exact failure being
  # guarded against.
  sleep 3

  values=$(gql -f item="\${ITEM_ID}" -f query='
    query($item: ID!) {
      node(id: $item) {
        ... on ProjectV2Item {
          fieldValues(first: 50) {
            pageInfo { hasNextPage }
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name field { ... on ProjectV2FieldCommon { name } }
              }
            }
          }
        }
      }
    }' --jq '.data.node.fieldValues')
  require_node "the item's field values, read back after the write" "\${values}" "\${ITEM_ID}"

  current=$(printf '%s' "\${values}" | jq -r '[.nodes[] | select(.field.name == "Status") | .name] | first // ""')

  # The worst of the three, because its wrong diagnosis is the one
  # a reader would act on: an item carrying more field values than
  # the page holds reads back as "" and the loop below blames a
  # competing writer for a race that never happened, three times,
  # then fails a job whose write in fact succeeded.
  if [ -z "\${current}" ] && [ "$(printf '%s' "\${values}" | jq -r '.pageInfo.hasNextPage')" = "true" ]; then
    echo "::error title=Board intake::Status was not among this item's first 50 field values and there are more beyond that page, so the read-back is UNMEASURED — the write may well have worked. This is NOT a competing writer and NOT an unset column. Page the fieldValues query." >&2
    exit 1
  fi

  # THE FIELD VALUE IS NOT WHAT THE BOARD DRAWS, AND THIS STEP USED
  # TO STOP HERE. Projects serves a board view from a SEARCH INDEX
  # that is separate from the item data, and the two can disagree.
  #
  # Measured on this project, 2026-11-04. Four pull requests held
  # Status "In review" in the data; \`items(query: "status:...")\`
  # returned two, and the board drew exactly those two. #1740 and
  # #1747 were invisible on the board for over an hour while every
  # field-value read said they were fine — which is precisely the
  # read this loop was doing.
  #
  # So a read-back that only asks the data path CANNOT observe the
  # failure it exists to catch: it returns "In review", the job
  # reports success, and nobody sees the card. Right exit code,
  # wrong mechanism (\`.claude/rules/checks-must-be-able-to-fail.md\`,
  # the sixth shape).
  #
  # Both readings must agree before this job claims the move worked.
  index_page=$(gql -f project="\${PROJECT_ID}" -f q="status:\\"\${COLUMN}\\"" -f query='
    query($project: ID!, $q: String!) {
      node(id: $project) {
        ... on ProjectV2 {
          items(first: 100, query: $q) {
            pageInfo { hasNextPage }
            nodes { id }
          }
        }
      }
    }' --jq '.data.node.items')
  require_node "the search index for the '\${COLUMN}' column" "\${index_page}" "\${PROJECT_ID}"

  # \`--arg\` rather than interpolating ITEM_ID into the jq program.
  # The id is minted by GitHub so this is not a sanitisation fix; a
  # value pasted into a program text is simply a different thing
  # from a value passed to one, and only one of them stays a value.
  indexed=$(printf '%s' "\${index_page}" | jq -r --arg id "\${ITEM_ID}" '[.nodes[].id] | index($id) // empty')

  # The third site. A column holding more than 100 cards is not
  # hypothetical on a 121-item board, and without this the job
  # reports the card as absent from the index and tells a human to
  # go and look at an index that is in fact correct.
  if [ -z "\${indexed}" ] && [ "$(printf '%s' "\${index_page}" | jq -r '.pageInfo.hasNextPage')" = "true" ]; then
    echo "::error title=Board intake::More than 100 items match '\${COLUMN}' in the project's search index and this item was not in the first page, so its membership is UNMEASURED — it may well be indexed and rendering. Do not read this as a missing card. Page the index query." >&2
    exit 1
  fi

  if [ "\${current}" = "\${COLUMN}" ] && [ -n "\${indexed}" ]; then
    echo "::notice title=Board intake::Moved to '\${COLUMN}' on attempt \${attempt}, confirmed in BOTH the item's field value and the project's search index — so the card will actually render. This workflow owns only the opened->In review edge; merged->Done and closed->Done remain GitHub's built-in project workflows, so exactly one decider writes each transition."
    exit 0
  fi

  if [ "\${current}" = "\${COLUMN}" ]; then
    echo "Attempt \${attempt}: the field value reads '\${COLUMN}' but the search index does not carry this item yet, so the board would not draw it. Re-writing to prompt a re-index."
  else
    echo "Attempt \${attempt}: wrote '\${COLUMN}', read back '\${current:-(nothing)}' — a concurrent write won. Retrying."
  fi
done

if [ "\${current}" = "\${COLUMN}" ]; then
  echo "::error title=Board intake::The Status field reads '\${COLUMN}' but after three attempts the project's SEARCH INDEX still does not list this item under it, and the board draws from the index. The data is right and the card is invisible — do not 'fix' the Status, it is already correct. Re-writing the same value is what repairs the index entry; if three did not take, the index is lagging and this needs a human to re-check later." >&2
  exit 1
fi

echo "::error title=Board intake::Wrote '\${COLUMN}' three times and the board still reads '\${current:-(nothing)}'. Something else is writing this item's Status and winning: check the project's built-in workflows for a rule that also fires on a pull request being added. The item IS on the board; only its column is wrong. Not exiting 0 on this — a job that writes and does not check is how the column silently reverted before." >&2
exit 1
`;

export interface BoardIntakeWorkflowOptions {
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
  /** The published harness version the add step runs through `bunx`. */
  version: string;
}

/** The whole `board-intake.yml` body. */
export function buildBoardIntakeWorkflow(opts: BoardIntakeWorkflowOptions): string {
  const indent = (text: string, pad: string) =>
    text
      .trimEnd()
      .split("\n")
      .map(line => (line === "" ? "" : `${pad}${line}`))
      .join("\n");

  return `# Managed by rungate — do not edit. The board is board.id in .claude/rungate/config.json.
#
# Every new issue and pull request goes on the board, and a pull request
# offered for review moves to In review. Generated since #2166, and it names
# no project id or URL: \`rungate ${BOARD_ID_COMMAND}\` reads board.id from the
# default branch's config, and the add uses that node id.
#
# Needs the RUNGATE_PROJECT_TOKEN secret: a token that can write the project
# board, which GITHUB_TOKEN cannot. Without it, or without board.id, the run
# is an UNMEASURED annotation, not a red run.
name: Board intake

on:
  issues:
    types: [opened, reopened]
  pull_request_target:
    types: [opened, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  ${BOARD_INTAKE_JOB}:
    runs-on: ${opts.runsOn}
    steps:
      # The default branch, never the pull request: pull_request_target holds a
      # board-writing token, and the config is the only input read from the tree.
      - uses: ${opts.checkout}
        with:
          ref: \${{ github.event.repository.default_branch }}
          persist-credentials: false
      - uses: ${opts.setupBun}
        with:
${opts.setupBunWith}
${opts.setupBunEnv}
      - id: add
        name: Add the issue or pull request to the board
        env:
          GH_TOKEN: \${{ secrets.RUNGATE_PROJECT_TOKEN }}
          CONTENT_ID: \${{ github.event.issue.node_id || github.event.pull_request.node_id }}
        run: |
${indent(buildBoardIntakeAddScript(opts.version), "          ")}
      # Only the opened -> In review edge; merged and closed stay with GitHub's
      # built-in workflows, so each transition has one decider. Not a draft:
      # a draft in \`In review\` says somebody is waiting on a reader when nobody is.
      # Drafts stay in Backlog until \`ready_for_review\`, which this subscribes to.
      - name: Move the pull request to In review
        if: github.event_name == 'pull_request_target' && github.event.pull_request.draft == false && steps.add.outputs.itemId != ''
        env:
          GH_TOKEN: \${{ secrets.RUNGATE_PROJECT_TOKEN }}
          PROJECT_ID: \${{ steps.add.outputs.projectId }}
          ITEM_ID: \${{ steps.add.outputs.itemId }}
          COLUMN: In review
        run: |
${indent(BOARD_INTAKE_MOVE_SCRIPT, "          ")}
`;
}
