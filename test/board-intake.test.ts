/**
 * BI-1..BI-10 — `.github/workflows/board-intake.yml`.
 *
 * The workflow that puts every issue and pull request on the board, and moves
 * a pull request to In review when it opens. Covers the gap #1750 left open:
 * the board had an intake and no transitions, so four of five open pull
 * requests sat in Backlog while #1607 showed Done with the pull request still
 * open and blocked.
 *
 * Read as TEXT rather than parsed, which is this repository's idiom for
 * workflow files and is deliberate: the thing being asserted is what a reader
 * and a reviewer see, and a YAML round-trip would normalise away exactly the
 * spellings that make `pull_request_target` unsafe.
 *
 * COMMENTS ARE STRIPPED BEFORE ANY SAFETY ROW RUNS, and the first draft did
 * not do that. BI-3 asserts no checkout, and it failed against a workflow with
 * no checkout in it, because the header *discusses* `actions/checkout@v4` in
 * a sentence about another file. A detector that cannot tell a step from
 * prose reports the file's documentation as its behaviour
 * (`.claude/rules/checks-must-be-able-to-fail.md`, the second shape). `code`
 * below is the view every safety row reads, and BI-5 asserts that view is
 * non-empty so stripping can never turn a check into a vacuous pass.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW = join(import.meta.dir, "..", ".github", "workflows", "board-intake.yml");
const source = readFileSync(WORKFLOW, "utf8");
const lines = source.split("\n");

/** The file with whole-line comments removed — the only view the safety rows read. */
const code = lines.filter(l => !/^\s*#/.test(l));

/** Every `run:` block's body, as text. Block scalars only; the file uses no inline `run:`. */
function runBlocks(): string[] {
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)run:\s*[|>]/.exec(lines[i]!);
    if (open === null) continue;
    const outer = open[1]!.length;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.trim() !== "" && line.length - line.trimStart().length <= outer) break;
      body.push(line);
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

const usesLines = code.filter(l => /^\s*-?\s*uses:/.test(l)).map(l => l.trim());
const ifLines = code.filter(l => /^\s*if:/.test(l)).map(l => l.trim());

describe("board-intake workflow", () => {
  test("BI-5: the extractors found the file's real shape", () => {
    // Read before any row below. These are the evidence that the scanners are
    // looking at something. If a reformat breaks them this fails, instead of
    // letting the rest pass over empty collections.
    expect(code.length).toBeGreaterThan(10);
    expect(usesLines.length).toBeGreaterThanOrEqual(1);
    expect(runBlocks().length).toBeGreaterThanOrEqual(1);
    // The stripper must remove commentary without eating the workflow.
    expect(code.length).toBeLessThan(lines.length);
  });

  test("BI-1: a pull request is moved to In review, keyed to the item the add step created", () => {
    // `actions/add-to-project` has no field input, so the transition is a
    // second step. It must address the item the first step just created
    // rather than re-querying the board: a re-query races GitHub's built-in
    // "Item added to project" workflow, which is what puts the item in
    // Backlog in the first place.
    const body = code.join("\n");
    expect(body.includes("updateProjectV2ItemFieldValue")).toBe(true);
    expect(body.includes("steps.add.outputs.itemId")).toBe(true);
    expect(/id:\s*add\b/.test(body)).toBe(true);
  });

  test("BI-2: a draft pull request is not moved", () => {
    // Jason's call, 2026-11-04: drafts stay in Backlog until marked ready.
    // `opened` fires for a draft too, so without this the column would read
    // In review for work nobody has offered for review.
    const guard = ifLines.find(l => l.includes("draft"));
    expect(guard, `no 'if:' mentions draft; if: lines were ${JSON.stringify(ifLines)}`).toBeDefined();
    expect(guard!.includes("false")).toBe(true);
  });

  test("BI-3: no step checks out the pull request", () => {
    // `pull_request_target` runs with secrets in the BASE repository's
    // context. Checking out the head would execute a contributor's code with
    // a token that can write the board.
    const checkouts = usesLines.filter(l => l.includes("actions/checkout"));
    expect(checkouts).toEqual([]);
  });

  test("BI-6: the write is read back, and an unverified write is not reported as success", () => {
    // Keying off `steps.add.outputs.itemId` fixes WHICH item is written. It
    // does nothing about WHEN. This job and GitHub's built-in "Item added to
    // project" automation fire off the same event and run concurrently, and
    // this one does two extra round trips first — resolve the field, then
    // mutate — so it is the slower of the two. If the built-in's "set to
    // Backlog" lands after this step's "set to In review", the board reverts
    // and the bug this workflow exists to fix comes back non-deterministically.
    //
    // A write whose effect is never read is indistinguishable from a write
    // that was overwritten a millisecond later, so the mutation's own exit
    // code is not a reading of the board's state
    // (`.claude/rules/checks-must-be-able-to-fail.md`, the sixth shape).
    const move = runBlocks().find(b => b.includes("updateProjectV2ItemFieldValue"));
    expect(move, "no run block performs the Status mutation").toBeDefined();

    // Reads the item's own field value back, rather than re-reading the
    // project's field definitions, which it already did to resolve the id.
    expect(move!).toContain("fieldValues");
    // Bounded retry rather than one hopeful write.
    expect(/for .*attempt|while |until /.test(move!)).toBe(true);
    // And a loud refusal when the read-back never agrees.
    expect(move!).toContain("::error");
  });

  test("BI-7: every API call goes through one retrying helper", () => {
    // `set -euo pipefail` is on for the whole step, so a bare `gh api graphql`
    // that fails on a network blip or a secondary rate limit aborts the step
    // immediately with gh's raw error. None of the diagnostics below it ever
    // print, and the retry loop is never reached — so the loop guards the
    // race it was written for and nothing else.
    //
    // This is a POPULATION, which is why it is asserted rather than fixed at
    // the one site the reviewer named: the step makes three calls — resolve
    // the Status field, mutate, read back — and all three had it.
    const move = runBlocks().find(b => b.includes("updateProjectV2ItemFieldValue"));
    expect(move, "no run block performs the Status mutation").toBeDefined();

    // Comments are stripped first. The header explains the hazard and quotes
    // the forbidden spelling to do it, so a detector that counts prose fails
    // on the documentation rather than on the code — the same mistake BI-3
    // made against `actions/checkout`, which is why it is handled up front
    // here instead of after a red run.
    const code = move!.split("\n").filter(l => !/^\s*#/.test(l));
    const calls = code.filter(l => l.includes("gh api graphql")).map(l => l.trim());

    expect(
      calls.length,
      `exactly one 'gh api graphql' may exist — the one inside gql(). Every ` +
        `other call must go through that helper so a transient failure retries ` +
        `instead of aborting the step under 'set -e'. Found:\n${calls.join("\n")}`,
    ).toBe(1);
    expect(calls[0]!).toContain('"$@"');

    // The helper must exist and actually retry, or the row above is satisfied
    // by deleting the call sites rather than routing them.
    expect(code.some(l => /^\s*gql\(\)\s*\{/.test(l))).toBe(true);
    expect(move!).toContain("for attempt in");
    // And it must be USED — three call sites route through it today. The
    // trailing class includes `\` because one of the three continues onto the
    // next line; omitting it counted 2 and read as a missing call site rather
    // than as a narrow detector.
    const uses = code.filter(l => /(^|[^_a-z])gql\s+[-"'\\]/.test(l));
    expect(uses.length, `call sites routed through gql():\n${uses.join("\n")}`).toBeGreaterThanOrEqual(3);
  });

  test("BI-8: the helper's return value is stdout only, never stdout merged with stderr", () => {
    // `out=$(gh api graphql "$@" 2>&1)` is correct for the FAILURE path, where
    // ${out} is quoted into the ::error message, and wrong for the success
    // path, where the same ${out} is the function's return value.
    //
    // Two of the three call sites treat it as data, not as a log: `status` is
    // piped into `jq -r` to resolve field_id and option_id, and `current` is
    // compared byte-for-byte against ${COLUMN}. `gh` writes to stderr on
    // otherwise-successful calls — the update notifier, rate-limit warnings —
    // and that text would be prepended to both.
    //
    // The `current` case is the one that matters, because it fails SILENTLY:
    // the comparison simply stops matching, the loop logs "a concurrent write
    // won" for a race that never happened, and after three attempts the step
    // blames a competing writer for a polluted capture. Right exit code,
    // wrong mechanism, and the diagnostic names the wrong cause
    // (`.claude/rules/checks-must-be-able-to-fail.md`, the sixth shape).
    const move = runBlocks().find(b => b.includes("updateProjectV2ItemFieldValue"));
    expect(move, "no run block performs the Status mutation").toBeDefined();

    const code = move!.split("\n").filter(l => !/^\s*#/.test(l));
    const merged = code.filter(l => l.includes("gh api graphql") && l.includes("2>&1"));
    expect(
      merged,
      "the gh call must not merge stderr into the value it returns — callers jq-parse " +
        "and string-compare it. Redirect stderr to a separate file and read it only for " +
        "the error message.",
    ).toEqual([]);

    // Positive half: the stderr is still CAPTURED, not discarded. Dropping it
    // satisfies the row above and makes the failure diagnostic say nothing,
    // which is the cheapest wrong fix here
    // (`.claude/rules/checks-must-be-able-to-fail.md`, the fifth shape).
    const call = code.find(l => l.includes("gh api graphql"));
    expect(call, "no gh api graphql call found at all").toBeDefined();
    expect(/2>\s*"?\$\{?err/.test(call!), `stderr is not captured: ${call}`).toBe(true);
    expect(move!).toContain("Last error:");
  });

  test("BI-9: the read-back asks the SEARCH INDEX, not only the field value", () => {
    // Projects draws a board from a search index that is separate from the
    // item data, and they can disagree. Measured on this project 2026-11-04:
    // four pull requests held Status "In review" in the data,
    // `items(query: "status:...")` returned two, and the board drew exactly
    // those two. #1740 and #1747 were invisible for over an hour while every
    // field-value read said they were fine.
    //
    // A read-back that asks only the data path therefore CANNOT observe the
    // failure it exists to catch — it returns the right string, the job
    // reports success, and nobody sees the card. Right exit code, wrong
    // mechanism (`.claude/rules/checks-must-be-able-to-fail.md`, the sixth
    // shape), which is the one this whole step was written to avoid.
    const move = runBlocks().find(b => b.includes("updateProjectV2ItemFieldValue"));
    expect(move, "no run block performs the Status mutation").toBeDefined();
    const code = move!.split("\n").filter(l => !/^\s*#/.test(l));
    const body = code.join("\n");

    // The index is queried at all.
    expect(body).toContain("items(first: 100, query:");
    // Keyed to the column being written, not a hardcoded string that would
    // keep passing after COLUMN changes.
    expect(body).toContain('status:\\"${COLUMN}\\"');
    // And BOTH readings gate the success path. Asserting the index query
    // exists is not enough — it could be queried and ignored.
    expect(
      /\[ "\$\{current\}" = "\$\{COLUMN\}" \] && \[ -n "\$\{indexed\}" \]/.test(body),
      "the success branch must require the index reading as well as the field value",
    ).toBe(true);
  });

  test("BI-10: every paged connection reports truncation, and none reads a full page as absence", () => {
    // Round 8's finding, asserted as the POPULATION it is rather than at the
    // one site that was reported.
    //
    // This step asks three connections for a FIRST page — `fields`,
    // `fieldValues` and the index `items` query — and before this row all
    // three read "not in the page" as "not there". Each one then printed a
    // confident error naming a cause that had not happened:
    //
    //   fields      -> "Someone renamed the field"        (nobody did)
    //   fieldValues -> "a concurrent write won", 3 times  (nothing raced)
    //   items       -> "the index does not carry this"    (it does)
    //
    // A bigger page is not the fix; it has the same defect further out. The
    // fix is that a truncated page is UNMEASURED, which is the treatment
    // `scripts/board-status-sweep.ts` already gave the same fact under the
    // name `statusUnread` — and the commit that introduced that name is the
    // commit that left all three of these behind. A population fixed in one
    // half of a change and not the other is the thing this row exists to
    // stop recurring.
    const move = runBlocks().find(b => b.includes("updateProjectV2ItemFieldValue"));
    expect(move, "no run block performs the Status mutation").toBeDefined();
    const code = move!.split("\n").filter(l => !/^\s*#/.test(l));
    const body = code.join("\n");

    // A GraphQL connection asked for a bounded page. `| first // empty` in a
    // jq program is deliberately not matched — the colon and the number are
    // what make it a page request.
    const paged = code.filter(l => /\w+\(first: \d+/.test(l)).map(l => l.trim());
    const pageInfos = code.filter(l => l.includes("pageInfo { hasNextPage }"));

    // Anti-vacuity before anything is compared: three is what the step makes
    // today, and a row that passes by finding none of them is worthless.
    expect(
      paged.length,
      `expected the three paged connections (fields, fieldValues, index items); found:\n${paged.join("\n")}`,
    ).toBeGreaterThanOrEqual(3);

    expect(
      pageInfos.length,
      `every paged connection must ask whether there is more beyond its page. ` +
        `${paged.length} connection(s) request a page and ${pageInfos.length} ask for ` +
        `pageInfo:\n${paged.join("\n")}`,
    ).toBe(paged.length);

    // And asking is not enough — the answer has to change what the job says.
    // One refusal per connection, each naming the reading UNMEASURED, so a
    // truncated page cannot be reported as a rename, a race, or a missing
    // card.
    const guards = code.filter(l => l.includes("hasNextPage')\" = \"true\" ]"));
    expect(
      guards.length,
      `each paged connection needs a guard that fires when the wanted value was ` +
        `absent AND the page was full. Found ${guards.length} for ${paged.length} ` +
        `connection(s):\n${guards.join("\n")}`,
    ).toBe(paged.length);
    // Each guard's OWN message, not a count of the word in the step.
    //
    // This was `(body.match(/UNMEASURED/g) ?? []).length === paged.length`,
    // which says "every guard names it" and measures "nothing else in the
    // step does". BI-11 then added a fourth, correct use — a null-node
    // refusal — and this row went red over an improvement. UNMEASURED is the
    // project's word for a reading that could not be taken; a row that caps
    // how often it may appear is pointed at the wrong object.
    const guardMessages = code
      .map((l, i) => (l.includes("hasNextPage')\" = \"true\" ]") ? code[i + 1] : null))
      .filter((l): l is string => l !== null);
    expect(
      guardMessages.length,
      "every truncation guard must be followed by its own error line",
    ).toBe(guards.length);
    expect(
      guardMessages.filter(l => !l.includes("UNMEASURED")),
      "each truncation guard must name ITS OWN reading UNMEASURED, not guess a cause",
    ).toEqual([]);

    // The specific spelling round 8 reported, kept as a named regression:
    // the sweep half of the same commit moved to 50 and this half did not.
    expect(body).not.toContain("fieldValues(first: 20)");
  });

  test("BI-11: every node(id:) read refuses a null node by naming the id", () => {
    // Round 9's finding, and the same shape as BI-10 one layer down: a
    // reading that could not be taken, reported as a fact about the board.
    //
    // `node(id: ID!)` IS NULLABLE in GitHub's schema. A stale id, a wrong
    // `PROJECT_ID`, or a project the token lost access to returns
    //
    //     {"data": {"node": null}}
    //
    // with NO GraphQL error, so `gql` exits 0 and `--jq '.data.node.X'`
    // prints the four bytes `null`. Measured:
    //
    //     echo '{"data":{"node":null}}' | jq '.data.node.fields'   → null, exit 0
    //     printf 'null' | jq -r '[.nodes[] | …]'                   → exit 5
    //     printf 'null' | jq -r '.pageInfo.hasNextPage'            → null, exit 0
    //
    // So under `set -euo pipefail` the job does die rather than write the
    // wrong column — but it dies on jq's "Cannot iterate over null", which
    // names jq and not the id, and BI-10's truncation guard reads
    // `hasNextPage` as the string `null` rather than `true` and stays quiet.
    // Right exit code, unreadable cause.
    //
    // Asserted as the POPULATION, the same way BI-10 is: all three reads, not
    // the one the round reported. Two of three would leave a subtraction with
    // one unguarded operand and read as covered.
    //
    // Breaking it: drop any one `require_node` call and this goes red naming
    // the count.
    const move = runBlocks().find(b => b.includes("updateProjectV2ItemFieldValue"));
    expect(move, "no run block performs the Status mutation").toBeDefined();
    const code = move!.split("\n").filter(l => !/^\s*#/.test(l));

    const nodeReads = code.filter(l => /--jq '\.data\.node\./.test(l)).map(l => l.trim());
    expect(
      nodeReads.length,
      `expected the three node(id:) reads (fields, fieldValues, index items); found:\n${nodeReads.join("\n")}`,
    ).toBe(3);

    const checks = code.filter(l => /^\s*require_node /.test(l)).map(l => l.trim());
    expect(
      checks.length,
      `each node(id:) read must be followed by a require_node refusal that names which ` +
        `id did not resolve. ${nodeReads.length} read(s), ${checks.length} check(s):\n` +
        nodeReads.join("\n"),
    ).toBe(nodeReads.length);

    // The helper exists, exits, and says the id did not resolve — so a
    // require_node that quietly returned could not satisfy the count above.
    const body = code.join("\n");
    expect(body, "require_node must be declared in this step").toContain("require_node() {");
    expect(body).toMatch(/require_node\(\) \{[\s\S]*?did not resolve[\s\S]*?\n          \}/);
    expect(body).toMatch(/require_node\(\) \{[\s\S]*?exit 1[\s\S]*?\n          \}/);
  });

  test("BI-4: no run block interpolates a value", () => {
    // The other half of the same property, and the easy one to reintroduce.
    // A `${{ ... }}` inside `run:` is substituted into the shell BEFORE it
    // executes, so a pull request title containing shell syntax is code.
    // Every value reaches this workflow through `env:`, where it is data.
    // Comments are NOT stripped here, deliberately: Actions interpolates a
    // `${{ }}` inside a shell comment too.
    const offenders = runBlocks().filter(b => b.includes("${{"));
    expect(offenders).toEqual([]);
  });
});
