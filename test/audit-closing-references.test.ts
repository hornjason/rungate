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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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
 */
function closes(number: number, nameWithOwner: string = THIS_REPO, body: string = SERVES) {
  const [login, name] = nameWithOwner.split("/");
  return { number, body, repository: { name, owner: { login } } };
}

/** An ordinary diff: one file that is not a session record. */
const CODE = [{ path: "lib/x.ts" }];

/** The switch, on, exactly as the repository variable is spelled. */
const ON = { RUNGATE_REQUIRE_CLOSING_REF: "true" };

function run(
  script: string,
  payload: string,
  repo: string | null = THIS_REPO,
  env: Record<string, string> = {},
): { code: number; err: string; out: string } {
  const file = join(scratch, "payload.json");
  writeFileSync(file, payload);
  const argv = repo === null ? [script, "--fixture", file] : [script, "--fixture", file, "--repo", repo];
  // The ambient switch and run id are stripped, so a developer or a CI job
  // that has either set cannot change what a case observes.
  const base = { ...process.env };
  delete base.RUNGATE_REQUIRE_CLOSING_REF;
  delete base.GITHUB_RUN_ID;
  try {
    const out = execFileSync(process.execPath, argv, { encoding: "utf-8", env: { ...base, ...env } });
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
      payload(CODE, [closes(42, THIS_REPO, "Cleanup. Serves no criterion.\n")]),
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

    // And the end-to-end reading, through the real script, with the body the
    // workflow's query adds to each node.
    const r = run(
      SCRIPT,
      JSON.stringify({
        number: 1971,
        body: "Fixes #1962\n",
        closingIssuesReferences: [{ ...node, body: SERVES }],
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
      s => !/^(f\.\w+|f\.issues\.join\(", #"\)|prNumber|NO_CRITERION_DECLARATION)$/.test(s),
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
    expect(yml).toMatch(/closingIssuesReferences\(first: \d+\) \{\s*nodes \{ number body /);
    expect(yml).toContain("RUNGATE_REQUIRE_CLOSING_REF: ${{ vars.RUNGATE_REQUIRE_CLOSING_REF }}");
    const invokeLine = yml.split("\n").find(l => l.includes("audit-closing-references.ts"));
    expect(invokeLine, "closing-references.yml no longer invokes the script").toBeDefined();
    expect(invokeLine).toContain('--repo "$GITHUB_REPOSITORY"');
  });
});
