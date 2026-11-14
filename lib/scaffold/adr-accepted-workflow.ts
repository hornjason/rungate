/**
 * `.github/workflows/adr-accepted.yml`, generated — #2046, ADR-014 row 3,
 * SC-2744.
 *
 * Merging an ADR whose status changes to accepted places its plan on the board
 * with no command typed by hand (SC-2738, ADR-013 rule 9 step 3). The file was
 * hand-written and caller-owned, and it ran `bun scripts/…` — paths a consumer
 * does not have. Rule 9 is every consumer's process, so the scaffold now
 * writes it, and this repository's copy is the generated one (ADR-014
 * decision 1).
 *
 * ## It calls the published CLI
 *
 * A consumer has `node_modules/rungate`, not `scripts/` (ADR-014 decision 2),
 * so every step runs `bunx rungate@<version> <command>`, at the generating
 * version — the same reading every other `bunx` pin takes.
 *
 * ## The engine's spec and family are read at scaffold time
 *
 * The hand-written file read `board.engineSpec` and `board.milestonePrefix`
 * at run time by importing `./lib/config-readers`, which a consumer does not
 * have either. They are read here instead, through the one loader, and
 * written into the job's `env:`. A config change is a re-scaffold, and the
 * workflow drift check sees a committed file that no longer matches.
 *
 * A value that is unset, or one that would be read as something other than
 * itself — a newline, or an Actions expression — is not written. The
 * acceptance step then refuses UNMEASURED, naming the key and why: a skipped
 * step reads as satisfied, and a missing family is not "nothing to place".
 */

/** The file this module generates, under `.github/workflows/`. */
export const ADR_ACCEPTED_WORKFLOW_FILE = "adr-accepted.yml";

/** The one job in it. */
export const ADR_ACCEPTED_JOB = "place-the-plan";

/**
 * The five commands, in the order each needs the one before it, after the
 * acceptance read (`plan-issues --accepted-since`). Each must be registered in
 * `lib/cli-commands.ts`, or the workflow calls a command `bin/rungate.ts`
 * refuses (#675's defect).
 */
export const ADR_ACCEPTED_COMMANDS = ["plan-issues", "plan-spec", "plan-deps", "board-mirror", "board-ready"] as const;

/** One engine input as the generator will write it, or why it will not. */
export type BoardInput = { value: string } | { value: null; why: string };

/**
 * Whether `raw` can be written into the job's `env:` as itself. A newline
 * could forge a second key wherever a step echoes it, and `${{` is evaluated
 * by Actions before the shell sees it — either way the step would read
 * something the config does not say.
 */
export function boardInput(key: string, raw: string | null): BoardInput {
  if (raw === null) return { value: null, why: `board.${key} is not set` };
  if (/[\r\n]/.test(raw)) return { value: null, why: `board.${key} contains a newline` };
  if (raw.includes("${{")) return { value: null, why: `board.${key} contains an Actions expression marker, a dollar sign and two braces` };
  return { value: raw };
}

export interface AdrAcceptedWorkflowOptions {
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
  /** `board.engineSpec`, read through `readBoardInputs`. */
  engineSpec: string | null;
  /** `board.milestonePrefix`, read through `readBoardInputs`. */
  milestonePrefix: string | null;
}

/** The whole `adr-accepted.yml` body. */
export function buildAdrAcceptedWorkflow(opts: AdrAcceptedWorkflowOptions): string {
  const spec = boardInput("engineSpec", opts.engineSpec);
  const prefix = boardInput("milestonePrefix", opts.milestonePrefix);
  const missing = [spec, prefix].flatMap(i => (i.value === null ? [i.why] : []));
  const cli = `bunx rungate@${opts.version}`;
  // JSON is a YAML double-quoted scalar, so a quote or backslash in a value
  // stays inside it.
  const envValue = (i: BoardInput) => JSON.stringify(i.value ?? "");
  const refusal =
    missing.length === 0
      ? ""
      : `
          echo "::error::UNMEASURED — ${missing.join("; ")}, so this push's plan has no milestones to land in. Nothing was written. Set board.engineSpec and board.milestonePrefix in the rungate config and re-run rungate scaffold."
          exit 1`;

  return `# Managed by rungate — do not edit. Set board.engineSpec and board.milestonePrefix
# in .claude/rungate/config.json and re-run \`rungate scaffold\`.
#
# SC-2738 (ADR-013 row 5): merging an ADR whose status changes to accepted
# places its plan on the board, with no command typed by hand. Generated since
# #2046 (ADR-014 row 3), so a consumer gets step 3 of the four-step process and
# this repository's copy is the generated one.
#
# The five commands, in the order each needs the one before it:
#
#   plan-spec      the engine spec's milestones, so every row's milestone exists
#   plan-issues    the ADR's Decomposition rows become issues, with blocked-by
#   plan-deps      the phase-order links between milestones
#   board-mirror   the Criteria column on the board
#   board-ready    a Ready top-up, because issues created with GITHUB_TOKEN
#                  fire no \`issues: opened\` run of board-ready.yml
#
# Every one is idempotent, so a re-run writes only what is missing. An edit to
# an ADR that was ALREADY accepted lists nothing and every later step is skipped.
#
# CREDENTIALS, SPLIT BY STEP. The issue, milestone and edge writes use the
# job's own GITHUB_TOKEN, passed as GITHUB_TOKEN because plan-issues drops
# GH_TOKEN. RUNGATE_PROJECT_TOKEN reaches only the two board steps, in their
# own env (#1761). The first \`bunx\` runs in the acceptance step, which holds
# no token, so the package is fetched before any step that holds the PAT.
name: ADR accepted — place its plan on the board

on:
  push:
    branches: [main]
    paths: ["docs/adr/**"]

permissions:
  contents: read
  # Issues, milestones and blocked-by edges. Nothing else this job writes is
  # reachable with GITHUB_TOKEN.
  issues: write

# Two merges in quick succession must not race each other's issue creation:
# the second run reads the tracker the first one wrote.
concurrency:
  group: adr-accepted
  cancel-in-progress: false

jobs:
  ${ADR_ACCEPTED_JOB}:
    runs-on: ${opts.runsOn}
    env:
      SPEC: ${envValue(spec)}
      PREFIX: ${envValue(prefix)}
    steps:
      # fetch-depth 0: the acceptance read compares each ADR with the commit
      # before this push, and refuses when that commit is not in the clone.
      - uses: ${opts.checkout}
        with:
          fetch-depth: 0
      - uses: ${opts.setupBun}
        with:
${opts.setupBunWith}
${opts.setupBunEnv}
      - id: accepted
        name: Which ADRs did this push accept?
        env:
          BEFORE: \${{ github.event.before }}
        run: |
          ${cli} plan-issues --accepted-since "$BEFORE" > accepted.txt
          echo "Accepted by this push:"
          cat accepted.txt
          if [ ! -s accepted.txt ]; then
            echo "any=false" >> "$GITHUB_OUTPUT"
            exit 0
          fi${refusal}
          echo "any=true" >> "$GITHUB_OUTPUT"

      - name: Milestones from the engine spec's placement table
        if: steps.accepted.outputs.any == 'true'
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: ${cli} plan-spec "$SPEC" --repo "$GITHUB_REPOSITORY" --prefix "$PREFIX" --write

      # One ADR at a time; \`bash -e\` stops at the first refusal, so a plan the
      # filing tool refuses is a red run naming the ADR.
      - name: Issues and blocked-by edges from each accepted ADR
        if: steps.accepted.outputs.any == 'true'
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          while IFS= read -r adr; do
            echo "== $adr"
            ${cli} plan-issues --decompose "$adr" --repo "$GITHUB_REPOSITORY" --write
          done < accepted.txt

      - name: Phase-order links between milestones
        if: steps.accepted.outputs.any == 'true'
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: ${cli} plan-deps --repo "$GITHUB_REPOSITORY" --milestone-prefix "$PREFIX" --write

      # The board steps. THE SECRET IS \`RUNGATE_PROJECT_TOKEN\`: board-mirror
      # reads it as GITHUB_TOKEN, board-ready as BOARD_PROJECT_TOKEN. An absent
      # secret is the empty string with no error, so each command's own
      # UNMEASURED refusal is what reports it.
      - name: Criteria column on the board
        if: steps.accepted.outputs.any == 'true'
        env:
          GITHUB_TOKEN: \${{ secrets.RUNGATE_PROJECT_TOKEN }}
          PROJECT_ID: \${{ vars.RUNGATE_PROJECT_ID }}
        run: |
          if [ -z "$PROJECT_ID" ]; then
            echo "::error::UNMEASURED — RUNGATE_PROJECT_ID is not set, so there is no board to write."
            exit 1
          fi
          ${cli} board-mirror --project "$PROJECT_ID" --write

      - name: Top up Ready from the new issues
        if: steps.accepted.outputs.any == 'true'
        env:
          BOARD_PROJECT_TOKEN: \${{ secrets.RUNGATE_PROJECT_TOKEN }}
          PROJECT_ID: \${{ vars.RUNGATE_PROJECT_ID }}
          ACTOR: \${{ github.actor }}
        run: ${cli} board-ready --repo "$GITHUB_REPOSITORY" --project "$PROJECT_ID" --actor "$ACTOR" --top-up --write
`;
}
