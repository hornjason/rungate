/**
 * scaffold/ai-review-step.ts — the ai-review job's auth-detect step (#630).
 *
 * One module, one decider. The generated bash is the ONLY place the mode is
 * resolved: there is deliberately no TypeScript `resolveAuthMode(env)` beside
 * it, because two deciders answering the same question about the same input
 * are behaviourally one decider, and no behavioural test can tell them apart
 * (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape). The
 * tests run the script.
 *
 * ## The two traps this step exists to avoid
 *
 * 1. **`secrets` is not available in an `if:` expression** at job or step
 *    level — `${{ secrets.X != '' }}` fails workflow validation outright.
 *    `vars` is available in both, which makes a `vars`-based condition the
 *    tempting fix and the second trap.
 * 2. **A job or step skipped by `if:` reports `skipped`, and a skipped
 *    required check can be treated as satisfied.** So nothing here is
 *    conditional from the outside: the step always runs, and it branches
 *    inside `run:` where it can emit an annotation and choose an exit code.
 *
 * ## The credential-less branch
 *
 * A tree with no credential has not passed an AI review; it has not had one.
 * Those are different states and only one of them is reportable, so mode
 * `none` emits a GitHub warning annotation naming the state UNMEASURED. `0`,
 * `{}`, `null` and `SKIP` are indistinguishable from success; `UNMEASURED`
 * is not. See `.claude/rules/config-access.md`.
 *
 * Whether UNMEASURED should also FAIL the job is the consumer's call, because
 * the honest default for a tree that has never configured a credential is not
 * a red pipeline on the first scaffold. `vars.RUNGATE_REQUIRE_AI_REVIEW` is
 * how a consumer opts in, and it is matched against the exact string `true`
 * — not `TRUE`, not `1`, not a prefix. A loose reading of a variable that
 * turns a gate on is a gate that turns itself on by accident.
 */

/**
 * The exit code every refusal in the generated script routes through.
 *
 * Declared once, interpolated once, and asserted to be the only non-zero exit
 * in this file by `test/ai-review-scaffold.test.ts`. The test builds a mutant
 * copy of this module with it set to 0 and requires the refusal case to stop
 * refusing — a later branch that inlined its own literal would survive that
 * mutation and the case would go green having witnessed nothing.
 */
export const AI_REVIEW_REQUIRED_EXIT = 1;

/** The five states the step can resolve. Exactly one is reached per run. */
export type AiReviewAuthMode = "vertex" | "oauth" | "api-key" | "adc" | "none";

export const AI_REVIEW_MODES: readonly AiReviewAuthMode[] = [
  "vertex",
  "oauth",
  "api-key",
  "adc",
  "none",
];

/**
 * The probe that resolves mode `adc` (#679).
 *
 * ## Why a fourth mode exists at all
 *
 * The three credentials above are all repository secrets, and this project's
 * owner **cannot produce any of them**: Vertex access is through an
 * organizational Google login, so there is no service-account key to mint and
 * no Claude OAuth token to paste. Every design in #630 and #631 assumed a
 * credential in the secret store, and for this consumer that assumption has
 * no satisfiable instance.
 *
 * Measured on `jhorn-mac` with nothing but `gcloud auth login`: a
 * `rawPredict` against `claude-sonnet-5` authenticated with Application
 * Default Credentials alone returned HTTP 200 and a real completion. No
 * `GCP_SA_KEY`, no `google-github-actions/auth`, no `credentials_json`. A
 * self-hosted runner executing as that user already holds a working
 * credential — it is simply not in the secret store.
 *
 * So the pre-#679 script annotated *"No Claude credential is configured …
 * This check is UNMEASURED, not a passing review"* on a runner that could
 * have reviewed the pull request. **That is #630's defect through the other
 * door**, and the more corrosive direction of the two: a false PASS is a
 * review nobody did, a false UNMEASURED trains people to ignore the
 * annotation that is supposed to mean something.
 *
 * ## Why this command and not a file test
 *
 * The cheap probe is `[ -f ~/.config/gcloud/application_default_credentials.json ]`.
 * That file is present on the machine above and was last written 2026-09-22;
 * its existence says nothing about whether the token still refreshes. A mode
 * resolved from a path that exists is a value read from somewhere that
 * answers confidently and incorrectly.
 *
 * `print-access-token` **attempts the credential**: it exits non-zero when
 * ADC is absent, unparseable or expired, and when `gcloud` is not installed
 * at all — which is every GitHub-hosted runner, so the hosted case still
 * resolves `none` and still annotates UNMEASURED.
 *
 * **The limit, stated rather than left to be discovered:** a credential that
 * has been REVOKED while an unexpired access token is still cached locally
 * will pass this probe. Closing that needs a call to the Vertex endpoint,
 * which needs the project id, and the project id is #631's to supply. The
 * residual is a window no longer than the cached token's life.
 *
 * ## Why the token is never captured
 *
 * The output is redirected to `/dev/null` rather than assigned, so the access
 * token never enters a shell variable, a log line, or `$GITHUB_OUTPUT`. The
 * exit status carries everything the decision needs. A later edit that
 * captures it to compare against the empty string would be a bearer token one
 * `set -x` away from the build log.
 */
export const AI_REVIEW_ADC_PROBE =
  "gcloud auth application-default print-access-token >/dev/null 2>&1";

/** The mode `AI_REVIEW_ADC_PROBE` resolves on success. */
export const AI_REVIEW_ADC_MODE: AiReviewAuthMode = "adc";

export interface AiReviewCredential {
  /** The repository secret the runner interpolates into the step's env. */
  secret: string;
  /** The mode resolved when that secret is the first non-empty one. */
  mode: Exclude<AiReviewAuthMode, "none">;
  /** What the mode authenticates against, for the step's own log line. */
  describes: string;
}

/**
 * The credentials, in the order the script tries them.
 *
 * Vertex first: it is the only one that bills a GCP project the consumer
 * already owns, and a tree carrying both a service-account key and a personal
 * OAuth token means the organisation credential, not the individual's.
 */
export const AI_REVIEW_AUTH_PRECEDENCE: readonly AiReviewCredential[] = [
  { secret: "GCP_SA_KEY", mode: "vertex", describes: "Vertex AI" },
  { secret: "CLAUDE_CODE_OAUTH_TOKEN", mode: "oauth", describes: "a Claude Code OAuth token" },
  { secret: "ANTHROPIC_API_KEY", mode: "api-key", describes: "the Anthropic API" },
];

/** The repository variable a consumer sets to make UNMEASURED a failure. */
export const AI_REVIEW_REQUIRE_VAR = "RUNGATE_REQUIRE_AI_REVIEW";

/** The exact value of that variable which turns the refusal on. */
export const AI_REVIEW_REQUIRE_VALUE = "true";

/** The step's `id:`, so a later step can read `steps.<id>.outputs.mode`. */
export const AI_REVIEW_AUTH_STEP_ID = "ai-review-auth";

/**
 * The generated workflow's filename and its one job name.
 *
 * Declared here rather than at either use site. `lib/scaffold/steps.ts` writes
 * the file and `lib/conformity.ts` reads it back and executes the step inside
 * it; two string literals that agree today are one decider too many, and a
 * generator and a checker that disagree about a filename is a checker that
 * reports a clean tree it never opened.
 */
export const AI_REVIEW_WORKFLOW_FILE = "ai-review.yml";

/** The single job in that file. Carries no `if:` — see the header. */
export const AI_REVIEW_JOB = "ai-review";

export const AI_REVIEW_AUTH_STEP_NAME = "Detect AI review credentials";

/** The annotation title, shared by the warning and the refusal. */
export const AI_REVIEW_UNMEASURED_TITLE = "AI review UNMEASURED";

/** The review step's `id:`. Separate from the auth step, so each has one job. */
export const AI_REVIEW_RUN_STEP_ID = "ai-review-run";

export const AI_REVIEW_RUN_STEP_NAME = "Run the AI review";

const SECRET_NAMES = AI_REVIEW_AUTH_PRECEDENCE.map(c => c.secret);

/**
 * The bash the auth-detect step runs.
 *
 * No `set -e`: `[ -n ... ]` returning false is the ordinary control flow here,
 * and a shell that exits on it would resolve `vertex` for every tree. `-u` is
 * safe because every variable is read through `${X:-}` — an unset GitHub
 * secret interpolates to the empty string, so absent and empty have to be the
 * same case anyway.
 */
export function buildAuthDetectScript(): string {
  const branches = AI_REVIEW_AUTH_PRECEDENCE.map((c, i) => {
    const keyword = i === 0 ? "if" : "elif";
    return `${keyword} [ -n "\${${c.secret}:-}" ]; then\n  mode=${c.mode}`;
  }).join("\n");

  // Every path that was tried, by name. A warning that does not say what was
  // missing is a warning nobody can act on — and since #679 the set of paths
  // is not just the secret store, so naming only the secrets would send a
  // reader to configure the one thing this consumer cannot produce.
  const warning =
    `No Claude credential is configured ` +
    `(${SECRET_NAMES.join(", ")}), and no usable Google Application Default ` +
    `Credential is available on this runner, so no AI review ran on this ` +
    `pull request. This check is UNMEASURED, not a passing review. ` +
    `Set the repository variable ${AI_REVIEW_REQUIRE_VAR} to ` +
    `'${AI_REVIEW_REQUIRE_VALUE}' to make an unmeasured review fail instead.`;

  const refusal =
    `${AI_REVIEW_REQUIRE_VAR} is '${AI_REVIEW_REQUIRE_VALUE}' and no credential ` +
    `is configured, so this pull request has no AI review. Failing rather than ` +
    `reporting a green check for a review that never happened.`;

  return `# Generated by rungate — lib/scaffold/ai-review-step.ts. Do not edit.
#
# Resolves exactly one of ${AI_REVIEW_MODES.length} modes: ${AI_REVIEW_MODES.join(", ")}.
# The decision is here and not in an \`if:\` expression on purpose — \`secrets\`
# is unavailable in \`if:\`, and a skipped step can satisfy a required check.
set -uo pipefail

mode=none
${branches}
# The secret store is exhausted. ADC is LAST on purpose (#679 AC-4): a
# repository that configures a credential must not be silently switched onto
# whichever developer's ambient login the runner happens to be executing as.
elif ${AI_REVIEW_ADC_PROBE}; then
  mode=${AI_REVIEW_ADC_MODE}
fi

echo "ai-review auth mode: \${mode}"
if [ -n "\${GITHUB_OUTPUT:-}" ]; then
  echo "mode=\${mode}" >> "\${GITHUB_OUTPUT}"
fi

if [ "\${mode}" != none ]; then
  exit 0
fi

echo "::warning title=${AI_REVIEW_UNMEASURED_TITLE}::${warning}"

if [ "\${${AI_REVIEW_REQUIRE_VAR}:-}" = "${AI_REVIEW_REQUIRE_VALUE}" ]; then
  echo "::error title=${AI_REVIEW_UNMEASURED_TITLE}::${refusal}" >&2
  exit ${AI_REVIEW_REQUIRED_EXIT}
fi

exit 0
`;
}

/**
 * The step, as YAML, ready to be indented under a job's `steps:`.
 *
 * Every credential reaches the script through `env:` and nowhere else. That
 * is not style: an expression is interpolated into the script text before
 * bash sees it, so a `${{ secrets.X }}` inside `run:` is a value a crafted
 * secret could break out of, and `${{ vars.X }}` inside `run:` is a shell
 * injection a repository variable can carry.
 */
export function buildAuthDetectStep(indent = "      "): string {
  const env = [
    ...AI_REVIEW_AUTH_PRECEDENCE.map(c => `${c.secret}: \${{ secrets.${c.secret} }}`),
    `${AI_REVIEW_REQUIRE_VAR}: \${{ vars.${AI_REVIEW_REQUIRE_VAR} }}`,
  ];

  const lines = [
    `- name: ${AI_REVIEW_AUTH_STEP_NAME}`,
    `  id: ${AI_REVIEW_AUTH_STEP_ID}`,
    `  env:`,
    ...env.map(e => `    ${e}`),
    `  run: |`,
    ...buildAuthDetectScript().trimEnd().split("\n").map(l => (l ? `    ${l}` : "")),
  ];

  return lines.map(l => (l ? `${indent}${l}` : "")).join("\n") + "\n";
}

/**
 * The bash the review step runs once a credential has resolved.
 *
 * ## Why this step exists before the reviewer it will hold does
 *
 * The auth-detect step makes `none` honest. It does nothing for the other
 * three, and on a repository that HAS a credential those are the only modes
 * reachable — so without this, a job named "AI Review" concludes success on
 * every pull request, having reviewed nothing, and says nothing about it.
 *
 * That is the defect #630 is named after, reached by the other door. "No
 * credential, so no review" and "a credential, but nothing wired to use it"
 * are the same state as far as a required check is concerned: UNMEASURED.
 * The first was already said out loud. This says the second.
 *
 * #631 replaces the body of this step with the review that actually runs.
 * Until it does, the step reports what it is rather than passing quietly,
 * and `AI_REVIEW_REQUIRE_VAR` refuses here for the same reason it refuses
 * there — a consumer who asked for a review and did not get one has not had
 * a review, and which half of the job failed to produce it is not their
 * problem.
 *
 * No `if:`, at step level or any other. The mode arrives through `env:` like
 * every other value in this file: it is one of four literals we generated,
 * not user input, but a `${{ }}` inside `run:` is interpolated before bash
 * sees it and the convention does not get to have exceptions for the cases
 * we think are safe.
 */
export function buildReviewRunScript(): string {
  const pending =
    `A credential resolved, but no review step is wired into this job yet ` +
    `(#631), so no AI review ran on this pull request. This check is ` +
    `UNMEASURED, not a passing review.`;

  const refusal =
    `${AI_REVIEW_REQUIRE_VAR} is '${AI_REVIEW_REQUIRE_VALUE}' and no review ` +
    `step is wired into this job yet (#631), so this pull request has no AI ` +
    `review. Failing rather than reporting a green check for a review that ` +
    `never happened.`;

  return `# Generated by rungate — lib/scaffold/ai-review-step.ts. Do not edit.
#
# Mode \`none\` has already annotated itself in the previous step. Annotating
# it again here would report one state as two.
set -uo pipefail

if [ "\${AI_REVIEW_MODE:-none}" = none ]; then
  exit 0
fi

echo "::warning title=${AI_REVIEW_UNMEASURED_TITLE}::${pending}"

if [ "\${${AI_REVIEW_REQUIRE_VAR}:-}" = "${AI_REVIEW_REQUIRE_VALUE}" ]; then
  echo "::error title=${AI_REVIEW_UNMEASURED_TITLE}::${refusal}" >&2
  exit ${AI_REVIEW_REQUIRED_EXIT}
fi

exit 0
`;
}

/** The review step, as YAML, ready to be indented under a job's `steps:`. */
export function buildReviewRunStep(indent = "      "): string {
  const lines = [
    `- name: ${AI_REVIEW_RUN_STEP_NAME}`,
    `  id: ${AI_REVIEW_RUN_STEP_ID}`,
    `  env:`,
    `    AI_REVIEW_MODE: \${{ steps.${AI_REVIEW_AUTH_STEP_ID}.outputs.mode }}`,
    `    ${AI_REVIEW_REQUIRE_VAR}: \${{ vars.${AI_REVIEW_REQUIRE_VAR} }}`,
    `  run: |`,
    ...buildReviewRunScript().trimEnd().split("\n").map(l => (l ? `    ${l}` : "")),
  ];

  return lines.map(l => (l ? `${indent}${l}` : "")).join("\n") + "\n";
}
