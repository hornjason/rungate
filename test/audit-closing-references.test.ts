/**
 * The refusal in `scripts/audit-closing-references.ts` is observed, not assumed (#1362).
 *
 * Every negative case runs twice — the real script, and a mutant whose
 * `REFUSE_EXIT` is zeroed — and asserts the real one refuses while the mutant
 * does not. That second assertion is the removal of the non-zero exit,
 * performed and watched, so a case that later passes for an unrelated reason
 * stops being indistinguishable from one that is genuinely caught
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 *
 * The script has one relative import, so the mutant cannot simply be dropped
 * in a temp directory — it would die on module resolution and a non-zero exit
 * would read as the refusal firing. The mutant therefore rewrites that
 * specifier to an absolute path, and the rewrite is asserted to have applied:
 * an unapplied mutation and a working guard produce the same colour.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { specCriteriaIn } from "../lib/board-mirror";
import { closingCriteria } from "../lib/closing-reference-audit";

const SCRIPT = join(import.meta.dir, "..", "scripts", "audit-closing-references.ts");
const LIB = join(import.meta.dir, "..", "lib", "closing-reference-audit.ts");
const SRC = readFileSync(SCRIPT, "utf-8");

/**
 * Read the exit code out of the source rather than importing it.
 *
 * The script runs `await main()` at import time — the same property
 * `scripts/audit-issue-closures.ts` documents — so importing the constant
 * executes the audit, reads stdin and calls `process.exit`, which kills the
 * test runner before any case runs. That is not a hypothetical: it is what
 * this file did on its first run.
 */
const REFUSE_EXIT = (() => {
  const m = SRC.match(/^export const REFUSE_EXIT = (\d+);$/m);
  if (!m) throw new Error("REFUSE_EXIT is not declared on its own line; the mutation would be untrustworthy");
  return Number.parseInt(m[1]!, 10);
})();

const scratch = mkdtempSync(join(tmpdir(), "closing-ref-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The real script's source, with the exit constant zeroed. */
function buildMutant(): string {
  const decl = `export const REFUSE_EXIT = ${REFUSE_EXIT};`;
  if (SRC.split(decl).length - 1 !== 1) {
    throw new Error("could not build the mutant: the exit constant is not declared exactly once");
  }
  const spec = `"../lib/closing-reference-audit"`;
  if (SRC.split(spec).length - 1 !== 1) {
    throw new Error("could not build the mutant: the lib specifier is not written exactly once");
  }
  const out = SRC.replace(decl, "export const REFUSE_EXIT = 0;").replace(spec, JSON.stringify(LIB));
  if (out.includes(decl) || out.includes(spec)) {
    throw new Error("could not build the mutant: a substitution did not apply");
  }
  const path = join(scratch, "mutant.ts");
  writeFileSync(path, out);
  return path;
}

/** The repository every fixture below belongs to, unless a case says otherwise. */
const THIS_REPO = "hornjason/rungate";

/** An issue body that names a criterion, so step 4's second half is met. */
const SERVES = "## Criteria this serves\n\nSC-2737\n";

/**
 * `gh`'s node shape: repository.owner.login + repository.name, and — since
 * SC-2737 — the issue body on the same node, from the workflow's one query.
 * Since #2061 the title too: `criterionAnswer` reads both.
 */
function closes(
  number: number,
  nameWithOwner: string = THIS_REPO,
  body: string = SERVES,
  title: string = "An issue",
) {
  const [login, name] = nameWithOwner.split("/");
  return { number, title, body, repository: { name, owner: { login } } };
}

/** An ordinary diff: one file that is not a session record. */
const CODE = [{ path: "lib/x.ts" }];

/** The switch, on, exactly as the repository variable is spelled. */
const ON = { RUNGATE_REQUIRE_CLOSING_REF: "true" };

/**
 * The workflow sends `closingIssuesTotal` beside the nodes. A payload that
 * leaves it out gets the honest value (the node count) here, so each case
 * keeps testing what it names; the one case about an ABSENT total passes
 * `RAW` so nothing is filled in.
 */
const RAW = Symbol("raw");
function withTotal(payload: string): string {
  try {
    const p = JSON.parse(payload);
    if (p && Array.isArray(p.closingIssuesReferences) && !("closingIssuesTotal" in p)) {
      return JSON.stringify({ ...p, closingIssuesTotal: p.closingIssuesReferences.length });
    }
  } catch {
    // Not JSON: a case about an unparseable payload, passed through untouched.
  }
  return payload;
}

function run(
  script: string,
  payload: string | { [RAW]: string },
  repo: string | null = THIS_REPO,
  env: Record<string, string> = {},
  cwd: string = join(import.meta.dir, ".."),
): { code: number; err: string; out: string } {
  const file = join(scratch, "payload.json");
  writeFileSync(file, typeof payload === "string" ? withTotal(payload) : payload[RAW]);
  const argv = repo === null ? [script, "--fixture", file] : [script, "--fixture", file, "--repo", repo];
  // The ambient switch and run id are stripped, so a developer or a CI job
  // that has either set cannot change what a case observes.
  const base = { ...process.env };
  delete base.RUNGATE_REQUIRE_CLOSING_REF;
  delete base.GITHUB_RUN_ID;
  try {
    const out = execFileSync(process.execPath, argv, { encoding: "utf-8", env: { ...base, ...env }, cwd });
    return { code: 0, err: "", out };
  } catch (e: any) {
    return { code: e.status ?? -1, err: String(e.stderr ?? ""), out: String(e.stdout ?? "") };
  }
}

// PR #1208's real shape: the keyword and the number inside a code span, and
// GitHub recording no link at all.
const BACKTICKED = "Fixes #1157".replace(/^/, "`").replace(/$/, "`");
const DEFECTIVE = JSON.stringify({
  number: 1208,
  body: `${BACKTICKED}\n`,
  closingIssuesReferences: [],
  files: CODE,
});

// The same contradiction one issue over, and the state the script used to
// pass clean: a live link to #1362 AND a suppressed closing keyword for a
// DIFFERENT issue. #777 never closes, so it becomes an open issue carrying a
// merged pull request — the exact population this script was written to find.
// The early return on `linked.length > 0` meant the body was never read.
const LINKED_PLUS_INERT = JSON.stringify({
  number: 1376,
  body: `Fixes #1362\n\n${"Fixes #777".replace(/^/, "`").replace(/$/, "`")}\n`,
  closingIssuesReferences: [closes(1362)],
  files: CODE,
});

/**
 * PR #1903's shape, the one that froze the board: no closing reference and
 * no keyword anywhere. #1950 caught it only because its branch opened with
 * an issue number; under SC-2737 the branch is not read at all.
 */
const DECLARES_NOTHING = JSON.stringify({
  number: 1903,
  body:
    "Produce the three Phase 6 readings the board is missing.\n\n" +
    "Neither new reading resolves an issue number, so `readsIssueRefs` is unchanged.\n",
  closingIssuesReferences: [],
  files: CODE,
});

/** A pull request closing an issue whose body names no criterion. */
const CLOSES_UNNAMED = JSON.stringify({
  number: 1905,
  body: "Fixes #42\n",
  closingIssuesReferences: [closes(42, THIS_REPO, "Something is wrong. No criterion here.\n")],
  files: CODE,
});

describe("the refusal is observed, against a mutant that cannot refuse", () => {
  test("the exit constant is declared exactly once, or no mutation is trustworthy", () => {
    expect(SRC.split(`export const REFUSE_EXIT = ${REFUSE_EXIT};`).length - 1).toBe(1);
    // No other literal exit can bypass it.
    expect(SRC).not.toMatch(/process\.exit\(\s*[1-9]/);
  });

  for (const [name, payload] of [
    ["an inert closing reference", DEFECTIVE],
    ["a linked pull request carrying an inert reference to ANOTHER issue", LINKED_PLUS_INERT],
    // SC-2737, with the switch on.
    ["a pull request that closes no issue", DECLARES_NOTHING],
    ["a pull request closing an issue that names no criterion", CLOSES_UNNAMED],
    [
      "a payload with no files key",
      JSON.stringify({ number: 6, body: "Fixes #9", closingIssuesReferences: [closes(9)] }),
    ],
    [
      "a linked issue node with no body",
      JSON.stringify({
        number: 7,
        body: "Fixes #9",
        closingIssuesReferences: [{ number: 9, repository: { name: "rungate", owner: { login: "hornjason" } } }],
        files: CODE,
      }),
    ],
    ["a payload with no closingIssuesReferences key", JSON.stringify({ number: 1, body: "x", files: CODE })],
    ["a payload that is not JSON", "not json at all"],
    ["an empty payload", ""],
  ] as const) {
    test(`${name} refuses, and the mutant does not`, () => {
      const real = run(SCRIPT, payload, THIS_REPO, ON);
      expect(real.code, `real script should refuse on: ${name}`).toBe(REFUSE_EXIT);
      expect(real.err).toContain("CLOSING-REFERENCE REFUSED");
      const mutant = run(buildMutant(), payload, THIS_REPO, ON);
      expect(mutant.code, `mutant should NOT refuse on: ${name}`).toBe(0);
    });
  }
});

describe("what it deliberately lets through", () => {
  test("a pull request that links an issue naming a criterion passes", () => {
    const r = run(
      SCRIPT,
      JSON.stringify({ number: 2, body: "Fixes #9", closingIssuesReferences: [closes(9)], files: CODE }),
      THIS_REPO,
      ON,
    );
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("links 1 issue");
  });

  test("an inert reference to an issue that IS linked passes", () => {
    // The row that keeps the widened check narrow. #9 closes on the live
    // reference whatever the code span says, so firing here would be a
    // false positive — and it is the one the cheapest version of this fix
    // produces, because "scan the body whenever there are inert refs" and
    // "scan the body for inert refs NOT already linked" differ only here.
    const body = "Fixes #9\n\nsee also `Fixes #9` in the old description.\n";
    const r = run(
      SCRIPT,
      JSON.stringify({ number: 5, body, closingIssuesReferences: [closes(9)], files: CODE }),
      THIS_REPO,
      ON,
    );
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("links 1 issue");
  });

  test("with the switch off, a mention or a negation is reported, not refused", () => {
    // The 23-of-24 case and the denial case. Off, nothing new blocks: the
    // reading is an annotation, so turning the variable on is the only step
    // that changes what merges.
    for (const body of [
      "This is the same class as #1204, and #1286 is open about the writer.\n",
      "Fixes nothing on its own — leaving #713 open deliberately.\n",
    ]) {
      const r = run(SCRIPT, JSON.stringify({ number: 3, body, closingIssuesReferences: [], files: CODE }));
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain("::warning");
      expect(r.out).toContain("NOT ENFORCED");
    }
  });
});

/**
 * SC-2737: a pull request closes an issue that names a criterion.
 *
 * Each case fixes everything but one variable, so a change that simply
 * refused more, or less, cannot turn one green for the wrong reason.
 */
describe("SC-2737: every pull request closes an issue that names a criterion", () => {
  const payload = (files: { path: string }[], refs: unknown[] = [], number = 20) =>
    JSON.stringify({ number, body: "Some change.\n", closingIssuesReferences: refs, files });

  test("a diff of only session-record files closes nothing and passes", () => {
    for (const files of [
      [{ path: "project-state.json" }],
      [{ path: "project-state.json" }, { path: "PROJECT-STATE.md" }, { path: "SUCCESS.md" }],
    ]) {
      const r = run(SCRIPT, payload(files), THIS_REPO, ON);
      expect(r.code, `${JSON.stringify(files)}: ${r.err}`).toBe(0);
    }
  });

  test("ONE more file in the diff and the same pull request owes a reference", () => {
    // The bypass the AI review of #1989 found in the branch rule, closed:
    // the exemption cannot be borrowed by a pull request that also changes
    // something else.
    const r = run(SCRIPT, payload([{ path: "project-state.json" }, { path: "lib/x.ts" }]), THIS_REPO, ON);
    expect(r.code).toBe(REFUSE_EXIT);
    expect(r.err).toContain("closes no issue");
  });

  test("a session-record file NAME outside the root is not a session record", () => {
    const r = run(SCRIPT, payload([{ path: "docs/SUCCESS.md" }]), THIS_REPO, ON);
    expect(r.code).toBe(REFUSE_EXIT);
  });

  test("the branch name is never read — a branch naming no issue still owes one", () => {
    // #1950 let these through: `rg/state-session-90`, `docs/readme`. The
    // field is not even in the payload any more; it is passed here to show
    // that supplying it changes nothing.
    const r = run(
      SCRIPT,
      JSON.stringify({
        number: 21,
        body: "Docs pass.\n",
        closingIssuesReferences: [],
        files: CODE,
        headRefName: "docs/readme",
      }),
      THIS_REPO,
      ON,
    );
    expect(r.code).toBe(REFUSE_EXIT);
  });

  test("an issue saying it serves no criterion satisfies the second half", () => {
    const r = run(
      SCRIPT,
      payload(CODE, [closes(42, THIS_REPO, "Cleanup. This serves no criterion.\n")]),
      THIS_REPO,
      ON,
    );
    expect(r.code, r.err).toBe(0);
  });

  test("the unnamed-criterion refusal names the issue and prints the one rerun command", () => {
    const r = run(SCRIPT, CLOSES_UNNAMED, THIS_REPO, { ...ON, GITHUB_RUN_ID: "4242" });
    expect(r.code).toBe(REFUSE_EXIT);
    expect(r.err).toContain("#42");
    expect(r.err).toContain(`gh run rerun 4242 --repo ${THIS_REPO}`);
  });

  test("the switch is read exactly: only the string true refuses", () => {
    for (const value of ["TRUE", "1", "yes", "true ", ""]) {
      const r = run(SCRIPT, DECLARES_NOTHING, THIS_REPO, { RUNGATE_REQUIRE_CLOSING_REF: value });
      expect(r.code, `"${value}" must not turn the refusal on`).toBe(0);
      expect(r.out).toContain("NOT ENFORCED");
    }
    expect(run(SCRIPT, DECLARES_NOTHING, THIS_REPO, ON).code).toBe(REFUSE_EXIT);
  });

  test("a CROSS-REPOSITORY closing reference does not count as closing an issue here", () => {
    // ai-review round 2 of #1978, and the same class `declaredClosingIn` was
    // added for in round 5 of #1974. `Fixes other-org/other-repo#9` is
    // documented GitHub syntax and lands a node numbered 9 here.
    const r = run(
      SCRIPT,
      JSON.stringify({
        number: 11,
        body: "Fixes other-org/other-repo#9\n",
        closingIssuesReferences: [closes(9, "other-org/other-repo")],
        files: CODE,
      }),
      THIS_REPO,
      ON,
    );
    expect(r.code, r.out).toBe(REFUSE_EXIT);
    expect(r.err, "the raw field is NOT empty — one reference was recorded").not.toContain(
      "closingIssuesReferences is empty",
    );
    expect(r.err).toContain("none of the 1 closing reference(s)");
  });

  test("a SAME-NUMBER issue in another repository cannot lend this one its body", () => {
    // AI review of #2003. `Fixes #9` here names no criterion; another
    // repository's #9 does. Matching bodies by bare number let the foreign
    // body pass the check for this repository's issue.
    const r = run(
      SCRIPT,
      JSON.stringify({
        number: 22,
        body: "Fixes #9\n\nFixes other-org/other-repo#9\n",
        closingIssuesReferences: [
          closes(9, THIS_REPO, "No criterion here.\n"),
          closes(9, "other-org/other-repo", "SC-9999, somebody else's.\n"),
        ],
        files: CODE,
      }),
      THIS_REPO,
      ON,
    );
    expect(r.code, r.out).toBe(REFUSE_EXIT);
    expect(r.err).toContain("#9, whose title and body name neither");
  });

  test("the control — the foreign node listed FIRST still cannot lend its body", () => {
    // Order is the one variable changed: a last-write-wins map would pass
    // the case above by luck and fail this one.
    const r = run(
      SCRIPT,
      JSON.stringify({
        number: 23,
        body: "Fixes other-org/other-repo#9\n\nFixes #9\n",
        closingIssuesReferences: [
          closes(9, "other-org/other-repo", "SC-9999, somebody else's.\n"),
          closes(9, THIS_REPO, "No criterion here.\n"),
        ],
        files: CODE,
      }),
      THIS_REPO,
      ON,
    );
    expect(r.code, r.out).toBe(REFUSE_EXIT);
  });

  test("a closed-issue list GitHub cut short is UNMEASURED, not clean", () => {
    // AI review of #2003. The fetched issues all name a criterion; the one
    // past the page might not.
    const base = { number: 24, body: "Fixes #9\n", closingIssuesReferences: [closes(9)], files: CODE };
    const short = run(SCRIPT, JSON.stringify({ ...base, closingIssuesTotal: 2 }), THIS_REPO, ON);
    expect(short.code).toBe(REFUSE_EXIT);
    expect(short.err).toContain("UNMEASURED");
    // The control: the same payload whose total matches what was fetched.
    const whole = run(SCRIPT, JSON.stringify({ ...base, closingIssuesTotal: 1 }), THIS_REPO, ON);
    expect(whole.code, whole.err).toBe(0);
  });

  test("an ABSENT total is UNMEASURED, and the mutant does not refuse", () => {
    // AI review of #2003, round 2: every other field refuses when absent,
    // and this one was skipped silently.
    const payload = {
      [RAW]: JSON.stringify({ number: 25, body: "Fixes #9\n", closingIssuesReferences: [closes(9)], files: CODE }),
    };
    const real = run(SCRIPT, payload, THIS_REPO, ON);
    expect(real.code).toBe(REFUSE_EXIT);
    expect(real.err).toContain("no closingIssuesTotal");
    expect(run(buildMutant(), payload, THIS_REPO, ON).code).toBe(0);
  });

  test("no --repo is UNMEASURED, not a clean pull request", () => {
    const r = run(
      SCRIPT,
      JSON.stringify({ number: 13, body: "Fixes #9\n", closingIssuesReferences: [closes(9)], files: CODE }),
      null,
      ON,
    );
    expect(r.code).toBe(REFUSE_EXIT);
    expect(r.err).toContain("UNMEASURED");
  });

  test("the gh node shape this filter reads is pinned to a real gh payload", () => {
    // ai-review round 4 of #1978. Everything above builds its nodes with the
    // local `closes()` helper, so the suite and the code agreed with each
    // other about a shape neither of them had checked against `gh`.
    //
    // CAPTURED VERBATIM, not hand-written: the output of
    //   gh pr view 1971 --repo hornjason/rungate --json closingIssuesReferences
    // taken 2026-11-11. An unrelated pull request, deliberately — a fixture
    // taken from this one would move with it. The GraphQL query the workflow
    // runs returns the same repository.name / repository.owner.login paths.
    const live = JSON.parse(
      '{"closingIssuesReferences":[{"id":"I_kwDOUe1c0M8AAAABeDH43Q","number":1962,' +
        '"repository":{"id":"R_kgDOUe1c0A","name":"rungate","owner":{"id":"MDQ6VXNlcjI2NTI5ODAw",' +
        '"login":"hornjason"}},"url":"https://github.com/hornjason/rungate/issues/1962"}]}',
    );
    const mine = closes(1962);
    const node = live.closingIssuesReferences[0];
    expect(typeof node.repository?.name).toBe(typeof mine.repository.name);
    expect(typeof node.repository?.owner?.login).toBe(typeof mine.repository.owner.login);

    // And the end-to-end reading, through the real script, with the title and
    // body the workflow's query adds to each node (#2061 added the title).
    const r = run(
      SCRIPT,
      JSON.stringify({
        number: 1971,
        body: "Fixes #1962\n",
        closingIssuesReferences: [{ ...node, title: "An issue", body: SERVES }],
        files: CODE,
      }),
      THIS_REPO,
      ON,
    );
    expect(r.code, r.err).toBe(0);
    expect(r.out, "a live gh payload must be CREDITED, not filtered to nothing").toContain(
      "links 1 issue",
    );
  });

  test("the message may only name values the function was given", () => {
    // THE CLASS, not the instance. Rounds 1 and 3 of #1978 were the same
    // defect in two different clauses, repaired one at a time. The message
    // is handed one object, so every substitution must come off it.
    const lib = readFileSync(LIB, "utf-8");
    const start = lib.indexOf("export function closingRequirementMessage");
    expect(start, "closingRequirementMessage is gone or renamed").toBeGreaterThan(-1);
    const body = lib.slice(start, lib.indexOf("\n}", start));
    const substitutions = [...body.matchAll(/\$\{([^}]+)\}/g)].map(x => x[1]!.trim());
    expect(substitutions.length, "no interpolation left — this guard would be vacuous").toBeGreaterThan(2);
    const foreign = substitutions.filter(
      s => !/^(f\.\w+|f\.issues\.join\(", #"\)|prNumber|NAMES_NONE)$/.test(s),
    );
    expect(
      foreign,
      "closingRequirementMessage interpolated something that is not `prNumber`, a field of `f`, " +
        "or the declaration constant. Carry it on ClosingRequirementFailure instead.",
    ).toEqual([]);
  });

  test("the workflow fetches files and issue bodies, re-runs on edit, and reads the switch", () => {
    const yml = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "closing-references.yml"), "utf-8");
    expect(yml).toMatch(/types:\s*\[[^\]]*\bedited\b[^\]]*\]/);
    expect(yml).toContain("files(first: 100) { nodes { path } }");
    expect(yml).toMatch(/closingIssuesReferences\(first: \d+\) \{ totalCount\s*nodes \{ number title body /);
    expect(yml).toContain("closingIssuesTotal: .closingIssuesReferences.totalCount");
    expect(yml).toContain("RUNGATE_REQUIRE_CLOSING_REF: ${{ vars.RUNGATE_REQUIRE_CLOSING_REF }}");
    const invokeLine = yml.split("\n").find(l => l.includes("audit-closing-references.ts"));
    expect(invokeLine, "closing-references.yml no longer invokes the script").toBeDefined();
    expect(invokeLine).toContain('--repo "$GITHUB_REPOSITORY"');
  });
});

/**
 * #2061 (SC-2737): the closing check asks "has this issue answered the
 * criterion question" through `criterionAnswer`, the one decider the
 * `needs-criterion` label and the `criteria-named` reading already use.
 *
 * Its own copy disagreed with them three ways, each measured against the
 * last 400 issues on 2026-11-13: it accepted any `SC-<digits>`, so the 37
 * open payload issues naming `CRC-…` criteria were refused a closing PR while
 * the board counted them answered; it accepted a NONEXISTENT `SC-` id; and it
 * read "serves no criterion" in any case, in the body only. Every case below
 * fails against that copy.
 */
describe("#2061: the closing check and the board answer the criterion question the same way", () => {
  const payload = (refs: unknown[], files: unknown[] = CODE) =>
    JSON.stringify({ number: 2061, body: "Some change.\n", closingIssuesReferences: refs, files });

  test("an issue naming a payload criterion (not SC-<N>) satisfies the second half", () => {
    // A TICKED payload criterion, so this case is about the criterion
    // question alone; #2005's tick requirement has its own block below.
    const r = run(SCRIPT, payload([closes(42, THIS_REPO, "## Criteria this serves\n\nCRC-A5\n")]), THIS_REPO, ON);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("closing references OK");
  });

  test("an SC id no spec states does not, and the mutant does not refuse it", () => {
    const p = payload([closes(42, THIS_REPO, "## Criteria this serves\n\nSC-9998\n")]);
    const real = run(SCRIPT, p, THIS_REPO, ON);
    expect(real.code).toBe(REFUSE_EXIT);
    expect(real.err).toContain("#42, whose title and body name neither");
    expect(run(buildMutant(), p, THIS_REPO, ON).code).toBe(0);
  });

  test("the declaration in the TITLE answers it, as it does for the label", () => {
    const r = run(
      SCRIPT,
      payload([closes(42, THIS_REPO, "Tidy the helper.\n", "Rename a helper — serves no criterion")]),
      THIS_REPO,
      ON,
    );
    expect(r.code, r.err).toBe(0);
  });

  test("the declaration is the exact words: a capitalised one is refused, exactly as the label reads it", () => {
    const r = run(SCRIPT, payload([closes(42, THIS_REPO, "Cleanup. Serves no criterion.\n")]), THIS_REPO, ON);
    expect(r.code).toBe(REFUSE_EXIT);
    expect(r.err, "the refusal must print the exact words to write").toContain('"serves no criterion"');
  });

  test("a node with no title is UNMEASURED, not an issue that declared nothing", () => {
    const node = { number: 42, body: SERVES, repository: { name: "rungate", owner: { login: "hornjason" } } };
    const real = run(SCRIPT, payload([node]), THIS_REPO, ON);
    expect(real.code).toBe(REFUSE_EXIT);
    expect(real.err).toContain("carries no title");
    expect(run(buildMutant(), payload([node]), THIS_REPO, ON).code).toBe(0);
  });

  test("a spec sweep that cannot be taken is UNMEASURED, and the mutant does not refuse", () => {
    // `scratch` has no specs/, so no criterion id can be read from it. Read as
    // "no ids", every issue that names one would be refused for naming none.
    const p = payload([closes(42)]);
    const real = run(SCRIPT, p, THIS_REPO, ON, scratch);
    expect(real.code).toBe(REFUSE_EXIT);
    expect(real.err).toContain("spec sweep");
    expect(real.err).toContain("UNMEASURED");
    expect(run(buildMutant(), p, THIS_REPO, ON, scratch).code).toBe(0);
    // The control: a session-record-only diff owes no criterion, so the same
    // unreadable tree does not stop it.
    const record = run(SCRIPT, payload([], [{ path: "project-state.json" }]), THIS_REPO, ON, scratch);
    expect(record.code, record.err).toBe(0);
  });
});

/**
 * #2005: a pull request that closes a criterion's issue ticks the criterion,
 * or says it does not complete it.
 *
 * Twice in three days a merge closed the last open issue naming an engine
 * criterion while the criterion stayed unticked: #2003 closing #1998 (SC-2737)
 * and #2094 closing #1964 (SC-2753). `criterion-coverage` then read short on
 * main, every open pull request's CI went red on the stage proof, and the only
 * repair was reopening the issue by hand. Neither merge's own CI could see it,
 * because the reading takes the spec from main. This check reads the spec from
 * the pull request's own tree, before the merge.
 */
describe("#2005: closing a criterion's issue ticks the criterion, or says it does not complete it", () => {
  const roots: string[] = [];
  afterAll(() => roots.forEach(r => rmSync(r, { recursive: true, force: true })));

  /** A checkout whose one spec states SC-9101, ticked or not. */
  const tree = (ticked: boolean): string => {
    const root = mkdtempSync(join(tmpdir(), "closing-tick-"));
    roots.push(root);
    mkdirSync(join(root, "specs"));
    writeFileSync(
      join(root, "specs", "FIXTURE-SPEC.md"),
      `# Fixture\n\n- [${ticked ? "x" : " "}] SC-9101: the fixture criterion\n- [x] SC-9102: a ticked neighbour\n`,
    );
    return root;
  };
  const payload = (body: string, issueBody = "## Criteria this serves\n\nSC-9101\n") =>
    JSON.stringify({ number: 2005, body, closingIssuesReferences: [closes(77, THIS_REPO, issueBody)], files: CODE });

  test("closing an issue whose criterion is unticked in this tree is refused, by name", () => {
    const root = tree(false);
    const real = run(SCRIPT, payload("Fixes #77\n"), THIS_REPO, ON, root);
    expect(real.code, real.out).toBe(REFUSE_EXIT);
    expect(real.err).toContain("#77");
    expect(real.err).toContain("SC-9101");
    expect(real.err, "the refusal must print the exact words that excuse it").toContain("does not complete SC-9101");
    expect(run(buildMutant(), payload("Fixes #77\n"), THIS_REPO, ON, root).code).toBe(0);
  });

  test("the same pull request with the criterion ticked passes", () => {
    const r = run(SCRIPT, payload("Fixes #77\n"), THIS_REPO, ON, tree(true));
    expect(r.code, r.err).toBe(0);
  });

  test("saying it does not complete the criterion passes, for that criterion only", () => {
    const root = tree(false);
    const said = run(SCRIPT, payload("Fixes #77\n\nThis does not complete SC-9101; #78 carries it.\n"), THIS_REPO, ON, root);
    expect(said.code, said.err).toBe(0);
    // Excusing a different criterion excuses nothing here.
    const other = run(SCRIPT, payload("Fixes #77\n\nThis does not complete SC-9102.\n"), THIS_REPO, ON, root);
    expect(other.code).toBe(REFUSE_EXIT);
    // Nor does a longer id that merely starts with it.
    const longer = run(SCRIPT, payload("Fixes #77\n\nThis does not complete SC-91010.\n"), THIS_REPO, ON, root);
    expect(longer.code).toBe(REFUSE_EXIT);
  });

  test("an issue that serves no criterion owes no tick", () => {
    const r = run(SCRIPT, payload("Fixes #77\n", "Cleanup. This serves no criterion.\n"), THIS_REPO, ON, tree(false));
    expect(r.code, r.err).toBe(0);
  });

  test("with the switch off, the unticked criterion is reported, not refused", () => {
    const r = run(SCRIPT, payload("Fixes #77\n"), THIS_REPO, {}, tree(false));
    expect(r.code).toBe(0);
    expect(r.out).toContain("NOT ENFORCED");
    expect(r.out).toContain("SC-9101");
  });

  test("the sweep says which criteria are unticked, from the same read as the ids", () => {
    const root = tree(false);
    const sweep = specCriteriaIn(root);
    expect(sweep.reading).toBe("MEASURED");
    expect(sweep.specs.flatMap(s => s.unticked)).toEqual(["SC-9101"]);
    expect(closingCriteria(root)).toEqual({ ids: ["SC-9101", "SC-9102"], unticked: ["SC-9101"] });
  });
});
