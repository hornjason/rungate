/**
 * #1591: the spec says whether CRC-B4's vote recording runs in CI, and the
 * generated workflow decides it. The two must agree.
 *
 * Measured on main before this change: `AI_REVIEW_BALLOT_DIR` appeared once in
 * `.github/workflows/ai-review.yml`, inside a comment, and was set by no step.
 * So `scripts/ai-review-findings.ts` handed the adjudicator a `null` jury on
 * every CI run and no vote reached the ledger, while the spec's Phase 2 table
 * read "the recording half is deployed (#1476)" and CRC-B6's row read "CRC-B4's
 * recorded votes — which now accumulate". An empty ballot store and a jury in
 * perfect agreement leave the same artefact, so nothing downstream could tell.
 *
 * The decision recorded with this change is built, not wired, until the
 * deciding half's first prerequisite lands (#1481). A ballot one review
 * invocation writes is a quorum of one under several names, the counterfeit
 * CRC-B4's own entry names, so setting the variable now would record refusals
 * or counterfeit votes and CRC-B6 would read them as a population.
 *
 * What is asserted: wiring is read off the workflow (a line that SETS the
 * variable, comments ignored), and the three places the spec states it must
 * say what that reading says. Setting the variable without editing the spec
 * reds the live case; so does putting "deployed" back.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { AI_REVIEW_BALLOT_DIR_ENV } from "../lib/scaffold/ai-review-step";

const REPO = join(import.meta.dir, "..");
const SPEC = readFileSync(join(REPO, "specs", "CODE-REVIEW-CONVERGENCE-SPEC.md"), "utf-8");
const WORKFLOW = readFileSync(join(REPO, ".github", "workflows", "ai-review.yml"), "utf-8");

/**
 * Whether any non-comment line of the workflow SETS `name`: a YAML `env:` key,
 * a shell assignment or export, or a `$GITHUB_ENV` line. A line that only
 * mentions it — the generated comment does — is not wiring.
 */
function ballotWired(workflow: string, name: string): boolean {
  const sets = new RegExp(`(^|[^A-Za-z0-9_])${name}\\s*[:=]`);
  return workflow.split("\n").some(line => !/^\s*#/.test(line) && sets.test(line));
}

/** The one line of the spec that starts with `prefix`; anything else is a refusal, not a reading. */
function onlyLine(spec: string, prefix: string): string {
  const lines = spec.split("\n").filter(l => l.startsWith(prefix));
  if (lines.length !== 1) throw new Error(`expected one spec line starting ${JSON.stringify(prefix)}, found ${lines.length}`);
  return lines[0]!;
}

/** Every place the spec's statement of the wiring disagrees with `wired`. Empty means they agree. */
function wiringDisagreements(spec: string, wired: boolean): string[] {
  const b4Row = onlyLine(spec, "| **CRC-B4** —");
  const b6Row = onlyLine(spec, "| **CRC-B6** —");
  const b4Status = onlyLine(spec, "- **CRC-B4** ");
  const out: string[] = [];
  if (wired) {
    if (/not wired/.test(b4Row)) out.push("CRC-B4's Phase 2 row says not wired, and the workflow sets the ballot directory");
    if (/not wired/.test(b4Status)) out.push("CRC-B4's status entry says not wired, and the workflow sets the ballot directory");
    if (/not wired/.test(b6Row)) out.push("CRC-B6's Phase 2 row says the votes are not wired, and the workflow sets the ballot directory");
    return out;
  }
  if (!/built, not wired/.test(b4Row)) out.push("CRC-B4's Phase 2 row does not say built, not wired");
  if (/half is deployed/.test(b4Row)) out.push("CRC-B4's Phase 2 row says the recording half is deployed");
  if (!/built, not wired/.test(b4Status)) out.push("CRC-B4's status entry does not say built, not wired");
  if (/deployed adjudicator wrapper injects/.test(b4Status)) out.push("CRC-B4's status entry says the deployed wrapper injects the jury");
  if (/now accumulate/.test(b6Row)) out.push("CRC-B6's Phase 2 row says CRC-B4's votes now accumulate");
  if (!/not wired/.test(b6Row)) out.push("CRC-B6's Phase 2 row does not say the votes it depends on are not wired");
  return out;
}

/** The two Phase 2 rows as they read on main before #1591, verbatim. */
const B4_ROW_BEFORE =
  "| **CRC-B4** — verifier quorum | the *recording* half is deployed (#1476): per-verifier votes and the disagreement flag reach the ledger for every blocking finding. The *deciding* half depends on `VERIFIER_GROUP_SIZE` separate review-action invocations with per-verifier writable directories, and on reading the base ref rather than the head checkout |";
const B6_ROW_BEFORE =
  "| **CRC-B6** — A/B the filters | CRC-B4's recorded votes — which now accumulate — and a variance control that does not read zero by construction |";

function withRows(spec: string, b4: string, b6: string): string {
  return spec
    .split("\n")
    .map(l => (l.startsWith("| **CRC-B4** —") ? b4 : l.startsWith("| **CRC-B6** —") ? b6 : l))
    .join("\n");
}

describe("#1591: reading whether the workflow sets the ballot directory", () => {
  test("the variable name is the one the findings script reads", () => {
    expect(AI_REVIEW_BALLOT_DIR_ENV).toBe("AI_REVIEW_BALLOT_DIR");
  });

  test("a comment naming it is not wiring; an env key, an export and a GITHUB_ENV line are", () => {
    expect(ballotWired("          # `AI_REVIEW_BALLOT_DIR` and no third variable.", AI_REVIEW_BALLOT_DIR_ENV)).toBe(false);
    expect(ballotWired("        env:\n          AI_REVIEW_BALLOT_DIR: ${{ runner.temp }}/ballot", AI_REVIEW_BALLOT_DIR_ENV)).toBe(true);
    expect(ballotWired('          export AI_REVIEW_BALLOT_DIR="$RUNNER_TEMP/ballot"', AI_REVIEW_BALLOT_DIR_ENV)).toBe(true);
    expect(ballotWired('          echo "AI_REVIEW_BALLOT_DIR=$RUNNER_TEMP/ballot" >> "$GITHUB_ENV"', AI_REVIEW_BALLOT_DIR_ENV)).toBe(true);
  });

  test("the committed workflow sets it nowhere today, which is the reading the spec must state", () => {
    expect(WORKFLOW).toContain(AI_REVIEW_BALLOT_DIR_ENV);
    expect(ballotWired(WORKFLOW, AI_REVIEW_BALLOT_DIR_ENV)).toBe(false);
  });
});

describe("#1591: the spec says what the workflow does", () => {
  test("live: the spec and the committed workflow agree", () => {
    expect(wiringDisagreements(SPEC, ballotWired(WORKFLOW, AI_REVIEW_BALLOT_DIR_ENV))).toEqual([]);
  });

  test("the rows as they read before #1591 are refused against an unwired workflow, each by name", () => {
    const found = wiringDisagreements(withRows(SPEC, B4_ROW_BEFORE, B6_ROW_BEFORE), false);
    expect(found).toContain("CRC-B4's Phase 2 row says the recording half is deployed");
    expect(found).toContain("CRC-B6's Phase 2 row says CRC-B4's votes now accumulate");
  });

  test("wiring the variable without editing the spec is refused", () => {
    const wired = `${WORKFLOW}\n        env:\n          ${AI_REVIEW_BALLOT_DIR_ENV}: \${{ runner.temp }}/ballot\n`;
    expect(wiringDisagreements(SPEC, ballotWired(wired, AI_REVIEW_BALLOT_DIR_ENV)).length).toBeGreaterThan(0);
  });
});
