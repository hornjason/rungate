/**
 * Refuse a pull request whose closing keyword GitHub will never act on (#1362).
 *
 * Usage (the payload is `gh pr view`-shaped: number, body, files[].path, and
 * closingIssuesReferences nodes that carry each issue body — the workflow
 * builds it from one GraphQL query):
 *   <payload> | bun scripts/audit-closing-references.ts --repo owner/name
 *   bun scripts/audit-closing-references.ts --fixture <file.json> --repo owner/name   # offline
 *
 * ## Why this reads a payload instead of calling the API
 *
 * The reading it needs — `closingIssuesReferences` — is GitHub's own answer to
 * the question the check is about, and the one thing this script must not do
 * is compute its own version of it. Taking the field as input makes that a
 * structural impossibility rather than a convention: there is no code path
 * here that could decide an issue is linked.
 *
 * It also makes the whole check runnable offline against a fixture, which is
 * how `test/audit-closing-references.test.ts` exercises the refusal without a
 * network or a token.
 *
 * ## What it refuses, and what it deliberately does not
 *
 * It refuses exactly one state: **`closingIssuesReferences` is empty AND the
 * body contains a closing keyword adjacent to an issue number inside markup
 * the markdown parser does not scan.** That is a contradiction inside one
 * pull request — the author wrote a closing reference and GitHub recorded
 * none — and it is the state that left #1157 open after PR #1208 merged.
 *
 * It does NOT refuse a pull request that merely mentions an issue without
 * closing it. Measured at 2026-10-23T15:31Z, 27 of the 50 open issues had a
 * merged pull request referencing them and 26 of those were discussion
 * mentions — `#1204's class`, `#1286 is open about this`. A check that fired
 * on a mention would be wrong 26 times out of 27 on the only corpus
 * available, and a check wrong that often is one people route around.
 *
 * ONE PROPERTY THIS FILE MUST KEEP, asserted by its test: every refusal exits
 * through REFUSE_EXIT, declared exactly once.
 */

import { readFileSync } from "fs";
import {
  type ClosedIssue,
  type ClosingCriteria,
  closingCriteria,
  closingRequirement,
  closingRequirementMessage,
  inertClosingMessage,
  inertClosingReferences,
  isSessionRecordOnly,
  linkedIssuesInThisRepo,
} from "../lib/closing-reference-audit";

/** The one exit code every refusal travels through. */
export const REFUSE_EXIT = 1;

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

/**
 * A payload that could not be read is UNMEASURED, not a pass.
 *
 * `.claude/rules/config-access.md`'s *Silent Default Substitution*: an
 * unparseable payload and a clean pull request must not produce the same
 * exit, or the check switches itself off the first time the input shape
 * moves.
 */
function refuse(message: string): never {
  console.error(`CLOSING-REFERENCE REFUSED: ${message}`);
  process.exit(REFUSE_EXIT);
}

async function readPayload(): Promise<string> {
  const fixture = arg("fixture");
  if (fixture) return readFileSync(fixture, "utf-8");
  if (process.stdin.isTTY) {
    refuse("no payload on stdin and no --fixture. See the usage at the top of this file.");
  }
  return await new Response(process.stdin as unknown as ReadableStream).text();
}

async function main(): Promise<void> {
  const raw = (await readPayload()).trim();
  if (!raw) refuse("the payload is empty, so no reading was taken. This is UNMEASURED, not a clean pull request.");

  let pr: { number?: number; body?: string; files?: unknown; closingIssuesReferences?: unknown };
  try {
    pr = JSON.parse(raw);
  } catch (e) {
    refuse(`the payload is not JSON (${(e as Error).message}). UNMEASURED, not clean.`);
  }

  // An absent key and an empty list are different facts, and only one of them
  // is a reading — #530's shape. A payload fetched without the field would
  // otherwise look exactly like a pull request that closes nothing.
  if (!("closingIssuesReferences" in pr) || !Array.isArray(pr.closingIssuesReferences)) {
    refuse(
      "the payload carries no closingIssuesReferences array, so the field this check " +
        "compares against was never fetched. Add it to the --json list. UNMEASURED, not clean.",
    );
  }
  if (typeof pr.body !== "string") {
    refuse("the payload carries no body string. Add `body` to the --json list. UNMEASURED, not clean.");
  }
  // ADR-013, SC-2737. Same shape as the two readings above, for the same
  // reason: a payload fetched without the changed files would look exactly
  // like a pull request that touches nothing, and "all session-record files"
  // is the one exemption this check grants. Absent is NOT READ, and NOT READ
  // is not a pass.
  if (!Array.isArray(pr.files)) {
    refuse(
      "the payload carries no files array, so whether this pull request changes only " +
        "session-record files was never read. Add `files` to the query. UNMEASURED, not clean.",
    );
  }
  const changedPaths = (pr.files as unknown[]).map(f =>
    f !== null && typeof f === "object" && typeof (f as { path?: unknown }).path === "string"
      ? (f as { path: string }).path
      : "",
  );
  if (changedPaths.includes("")) {
    refuse("a changed file in the payload carries no path string. UNMEASURED, not clean.");
  }

  const prNumber = typeof pr.number === "number" ? pr.number : 0;
  const linked = pr.closingIssuesReferences as unknown[];
  // The linked set is read for its ISSUE NUMBERS, not for its length.
  //
  // This used to return early whenever `linked.length > 0`, and that let the
  // defect through one issue over: a pull request that correctly links #A and
  // also carries a backticked `Fixes #B` passed clean, #B never closed, and
  // #B is then an open issue with a merged pull request — the exact symptom
  // this script exists to find. The contradiction the docblock describes is
  // not "GitHub recorded nothing", it is "the author wrote a closing
  // reference GitHub did not record", and a non-empty linked set does not
  // make that false for a DIFFERENT issue.
  //
  // An entry whose number is unreadable contributes nothing to this set,
  // which is the safe direction: it can only cause an inert reference to be
  // reported, never suppressed.
  // SCOPED TO THIS REPOSITORY — ai-review round 2 of #1978. A bare `number`
  // is not an identity: `Fixes other-org/other-repo#9` is documented GitHub
  // syntax and lands a node numbered 9 here. Counting it let a pull request
  // satisfy its own closing requirement with somebody else's issue.
  const repoNameWithOwner = arg("repo");
  if (repoNameWithOwner === null || !repoNameWithOwner.includes("/")) {
    refuse(
      "no --repo owner/name was given, so a closing reference cannot be told from a " +
        "cross-repository one. Pass --repo \"$GITHUB_REPOSITORY\". UNMEASURED, not clean.",
    );
  }
  const linkedIssues = linkedIssuesInThisRepo(linked, repoNameWithOwner);

  // An inert keyword naming an issue that IS linked is harmless — the issue
  // closes on the live reference regardless, so firing on it would be the
  // false positive the docblock refuses to ship. Only the unlinked ones are
  // the contradiction.
  const inert = inertClosingReferences(pr.body).filter(r => !linkedIssues.has(r.issue));

  // THE INERT READING IS REPORTED FIRST, and ai-review round 1 of #1978 was
  // right to insist on it. My first cut ran #1950's check ahead of this one,
  // and because `refuse` exits the process the two did not compose — they
  // shadowed. A pull request on branch `rg/1717-fix` with a backticked
  // `Fixes #1717` in its body hit the new check, never reached this one, and
  // was told to ADD a reference that was already written four characters
  // away. The actionable finding is always the more specific one: "you wrote
  // it and GitHub cannot see it" beats "you wrote nothing".
  //
  // Composition rather than ordering-by-preference: the step-4 check below
  // (SC-2737, which replaced #1950's) asks whether a reference is OWED and
  // this one asks whether a written
  // reference LANDED, so when both could speak the written one is the
  // better remedy and the other is reported by the next run if it survives.
  if (inert.length > 0) refuse(inertClosingMessage(inert, prNumber));

  // A list GitHub cut short is not a list of every issue this closes. The
  // workflow passes the total beside the nodes; when it exceeds them, an
  // issue that names no criterion could sit in the part never fetched.
  // Absent is NOT READ, like every field above (AI review of #2003): a total
  // the workflow stopped sending would otherwise turn this guard off silently.
  const total = (pr as { closingIssuesTotal?: unknown }).closingIssuesTotal;
  if (typeof total !== "number") {
    refuse(
      "the payload carries no closingIssuesTotal number, so whether the closed-issue list was " +
        "cut short was never read. Add `totalCount` to the query. UNMEASURED, not clean.",
    );
  }
  if (total > linked.length) {
    refuse(
      `this pull request closes ${total} issue(s) and only ${linked.length} were fetched, so ` +
        `whether every one names a criterion was never read. UNMEASURED, not clean.`,
    );
  }

  // The body of every issue this pull request closes HERE, read off the same
  // nodes `closingIssuesReferences` returned. The workflow asks GitHub for the
  // body on each node, so no second query decides which issues are linked.
  //
  // Each NODE is asked whether it belongs here, through the same decider as
  // the set above — never its bare number. AI review of #2003: `Fixes #9` and
  // `Fixes other-org/other-repo#9` share a number, and a number-only test let
  // the other repository's body stand in for this one's.
  //
  // The TITLE too (#2061): `criterionAnswer` reads title and body, so a
  // declaration written in the title answers the question for the label and
  // the board, and a node fetched without one was never fully read.
  const issues = new Map<number, ClosedIssue>();
  for (const node of linked) {
    const n = node as { number?: unknown; title?: unknown; body?: unknown } | null;
    if (n === null || typeof n !== "object" || typeof n.number !== "number") continue;
    if (linkedIssuesInThisRepo([n], repoNameWithOwner).size === 0) continue;
    if (typeof n.body !== "string") {
      refuse(
        `issue #${n.number} is closed by this pull request but its node carries no body, so ` +
          `whether it names a criterion was never read. Add \`body\` to the closingIssuesReferences ` +
          `query. UNMEASURED, not clean.`,
      );
    }
    if (typeof n.title !== "string") {
      refuse(
        `issue #${n.number} is closed by this pull request but its node carries no title, so ` +
          `whether it names a criterion was never fully read. Add \`title\` to the ` +
          `closingIssuesReferences query. UNMEASURED, not clean.`,
      );
    }
    issues.set(n.number, { title: n.title, body: n.body });
  }

  // The ids a criterion can be named by come from the checkout's specs/ — the
  // pull request's merge commit, so a criterion it adds counts. Taken only
  // when an issue's answer depends on it: a session-record diff owes none.
  //
  // The same read says which criteria are still unticked (#2005), so a tick
  // this pull request makes is seen and one it forgot is caught here, before
  // the merge, rather than as a short criterion-coverage on main.
  let criteria: ClosingCriteria = { ids: [], unticked: [] };
  if (!isSessionRecordOnly(changedPaths) && issues.size > 0) {
    const read = closingCriteria(process.cwd());
    if (read === null) {
      refuse(
        `the spec sweep of ${process.cwd()}/specs could not be taken, so no closed issue's ` +
          `criteria can be read. UNMEASURED, not an issue that names none.`,
      );
    }
    criteria = read;
  }

  const runId = process.env.GITHUB_RUN_ID;
  const rerun = `gh run rerun ${runId ? runId : "<run-id>"} --repo ${repoNameWithOwner}`;
  const failure = closingRequirement(
    changedPaths,
    issues,
    criteria,
    pr.body,
    linked.length,
    repoNameWithOwner,
    rerun,
  );
  if (failure !== null) {
    const message = closingRequirementMessage(failure, prNumber);
    // Read EXACTLY as `RUNGATE_REQUIRE_AI_REVIEW` is: the string `true` and
    // no other value turns the refusal on (`.claude/rules/config-access.md`).
    if (process.env.RUNGATE_REQUIRE_CLOSING_REF === "true") refuse(message);
    // Off, the reading is still reported, as an annotation rather than as a
    // silent pass. Newlines are encoded so the annotation keeps all of it.
    console.log(`::warning title=Closing reference (not enforced)::${message.replace(/\n/g, "%0A")}`);
    console.log(
      `closing references NOT ENFORCED: PR #${prNumber} fails ADR-013 step 4, and ` +
        `RUNGATE_REQUIRE_CLOSING_REF is not "true".`,
    );
    return;
  }

  // Counts what was CREDITED, not what was returned — a summary saying
  // "links 1 issue" for a cross-repository node would describe the check as
  // doing the thing round 2 found it was not doing.
  const links =
    linkedIssues.size > 0 ? `links ${linkedIssues.size} issue(s)` : "links none and claims none";
  console.log(`closing references OK: PR #${prNumber} ${links}.`);
}

await main();
