/**
 * BS-1..BS-8 — `scripts/board-status-sweep.ts`.
 *
 * The sweep that makes the board's Status column agree with GitHub. Every
 * decision it makes is `verdictFor`, so these cases run against that one
 * binding rather than against the network.
 *
 * BS-7 is the row that matters most and is the easiest to lose: an open ISSUE
 * marked Done must be reported and never written. Done is certainly wrong for
 * it, and no column is derivable — so the tempting "fix" is to put it in
 * Backlog, which replaces a visibly wrong board with a plausibly wrong one.
 * That is the fifth shape in `.claude/rules/checks-must-be-able-to-fail.md`:
 * a case that goes green under the wrong repair.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  BOARD_QUERY,
  DONE,
  IN_REVIEW,
  applyCorrections,
  interpretResponse,
  requireNode,
  sweep,
  withRetry,
  verdictFor,
  type BoardItem,
  type ItemKind,
  type ItemState,
} from "../scripts/board-status-sweep";

function item(
  number: number,
  kind: ItemKind,
  state: ItemState,
  status: string | null,
  draft = false,
): BoardItem {
  return { itemId: `PVTI_${number}`, number, kind, state, status, draft, statusUnread: false };
}

describe("board status sweep", () => {
  test("BS-1: a merged pull request not marked Done is corrected to Done", () => {
    const v = verdictFor(item(1749, "PullRequest", "MERGED", "In review"));
    expect(v.kind).toBe("correct");
    expect(v.kind === "correct" && v.to).toBe(DONE);
  });

  test("BS-2: a closed issue not marked Done is corrected to Done", () => {
    const v = verdictFor(item(1727, "Issue", "CLOSED", "In progress"));
    expect(v.kind).toBe("correct");
    expect(v.kind === "correct" && v.to).toBe(DONE);
  });

  test("BS-3: an item with NO status at all is still corrected when closed", () => {
    // `null` and "some wrong column" are different readings of the board and
    // must not be conflated — an item that was never given a Status is the
    // commonest way a closed item escapes a sweep that only looks for
    // disagreement between two present values.
    const v = verdictFor(item(1646, "PullRequest", "MERGED", null));
    expect(v.kind).toBe("correct");
    expect(v.kind === "correct" && v.to).toBe(DONE);
  });

  test("BS-4: a merged pull request already marked Done is left alone", () => {
    expect(verdictFor(item(1645, "PullRequest", "MERGED", DONE)).kind).toBe("agrees");
  });

  test("BS-5: an open READY pull request marked Done is corrected to In review", () => {
    // #1607, the instance that started this: OPEN and BLOCKED, board said Done.
    // Ready, not draft — BS-13 is the draft half and they must not be merged
    // into one row, because the two have opposite verdicts.
    const v = verdictFor(item(1607, "PullRequest", "OPEN", DONE));
    expect(v.kind).toBe("correct");
    expect(v.kind === "correct" && v.to).toBe(IN_REVIEW);
  });

  test("BS-13: an open DRAFT pull request marked Done is undecidable, never moved to In review", () => {
    // The other half of BS-5, and the one that contradicts this PR's own
    // other half if it is missed. `board-intake.yml` excludes drafts from
    // In review deliberately — "a draft in In review says somebody is
    // waiting on a reader when nobody is" — so a sweep that writes In review
    // for a draft is a SECOND DECIDER disagreeing with the first
    // (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape),
    // and the two never meet because intake fires on an event and the sweep
    // runs by hand.
    //
    // Undecidable rather than Backlog for the same reason BS-7 is: Done is
    // certainly wrong and the right column is not derivable. Backlog, Ready
    // and In progress are all consistent with an open draft.
    const v = verdictFor(item(1700, "PullRequest", "OPEN", DONE, true));
    expect(v.kind).toBe("undecidable");
    expect(v.kind === "undecidable" && v.why).toContain("draft");
  });

  test("BS-14: the board query asks for isDraft, so the verdict is not taken blind", () => {
    // BS-13 can be satisfied by a `verdictFor` that reads a field nothing
    // ever populates: every real item would arrive with `draft` undefined,
    // the draft branch would never run, and BS-13 would stay green against a
    // sweep that still moves drafts
    // (`.claude/rules/checks-must-be-able-to-fail.md`, the third shape —
    // a case that holds vacuously because the input is stripped upstream).
    expect(BOARD_QUERY).toContain("isDraft");
    // And on the PullRequest fragment specifically. `isDraft` does not exist
    // on Issue, so a stray one elsewhere in the document is a GraphQL error
    // at run time rather than a field.
    expect(/\.\.\. on PullRequest \{[^}]*isDraft/.test(BOARD_QUERY)).toBe(true);
  });

  test("BS-6: an open item in any non-Done column is left alone", () => {
    // The sweep is not a second opinion on where open work sits. Backlog,
    // Ready and In progress are all legitimate for an open item, and moving
    // them would make this a competing decider against board-intake.yml.
    for (const status of ["Backlog", "Ready", "In progress", IN_REVIEW, null]) {
      expect(verdictFor(item(1740, "PullRequest", "OPEN", status)).kind).toBe("agrees");
      expect(verdictFor(item(1741, "Issue", "OPEN", status)).kind).toBe("agrees");
    }
  });

  test("BS-7: an open ISSUE marked Done is undecidable, never corrected", () => {
    const v = verdictFor(item(1744, "Issue", "OPEN", DONE));
    expect(v.kind).toBe("undecidable");
    // The reason has to name why a guess is refused, or the next reader
    // deletes the branch as an oversight and writes Backlog.
    expect(v.kind === "undecidable" && v.why).toContain("not derivable");
  });

  test("BS-9: a non-JSON error body reports the HTTP status, not a parse error", () => {
    // 502s, HTML rate-limit pages and proxy errors all arrive as non-JSON.
    // Parsing before checking the status turned the one failure this function
    // exists to make legible into `SyntaxError: Unexpected token <`.
    expect(() => interpretResponse(502, false, "<html><body>Bad Gateway</body></html>")).toThrow(
      /HTTP 502/,
    );
    // And it carries what the server actually said, so the next reader does
    // not have to reproduce the outage to find out.
    expect(() => interpretResponse(502, false, "<html>Bad Gateway</html>")).toThrow(/Bad Gateway/);
  });

  test("BS-10: an empty body is named as empty rather than silently truncated", () => {
    expect(() => interpretResponse(503, false, "")).toThrow(/empty body/);
  });

  test("BS-11: a GraphQL error at HTTP 200 is still an error", () => {
    // The reason the status alone was never sufficient. This must survive the
    // reordering above — it is the property the original comment defended.
    expect(() =>
      interpretResponse(200, true, JSON.stringify({ errors: [{ message: "NOT_FOUND" }] })),
    ).toThrow(/GraphQL.*NOT_FOUND/);
  });

  test("BS-12: a good response returns its data", () => {
    // Anti-vacuity for the three rows above: if interpretResponse threw
    // unconditionally they would all pass.
    expect(interpretResponse(200, true, JSON.stringify({ data: { node: { id: "x" } } }))).toEqual({
      node: { id: "x" },
    });
  });

  test("BS-20: a literal null body is a legible refusal, not a TypeError", () => {
    // `JSON.parse("null")` succeeds, so the parse guard does not fire, and
    // `body.errors` is then a property read on null. The function written to
    // turn a bad response into a legible error dies with
    // `Cannot read properties of null` — which does not name the status, the
    // body, or this function's purpose.
    expect(() => interpretResponse(200, true, "null")).toThrow(/not a response object/);
    expect(() => interpretResponse(200, true, "null")).toThrow(/HTTP 200/);
  });

  test("BS-21: a bare JSON primitive is refused, not silently returned as undefined", () => {
    // The quieter half of the same class and the reason this is two rows.
    // `JSON.parse("5")` is 5; `(5).errors` is undefined, so NOTHING throws —
    // the function returns `body.data`, which is undefined, and the caller
    // walks into it. A crash is recoverable; a silent undefined is the sweep
    // reporting on a board it never read.
    expect(() => interpretResponse(200, true, "5")).toThrow(/not a response object/);
    expect(() => interpretResponse(200, true, '"a string"')).toThrow(/not a response object/);
    expect(() => interpretResponse(200, true, "[1,2]")).toThrow(/not a response object/);
  });

  test("BS-22: a null node says the token cannot SEE the project, not that the id is wrong", () => {
    // The third site of BS-20's class and the one the report did not name,
    // reached by an input GitHub really returns: `node(id: …)` resolves to
    // null for a project the credential cannot see. The query SUCCEEDS, so
    // there is no GraphQL error and no bad status — and `data.node.items` was
    // a property read on null, exactly as `body.errors` was.
    //
    // The message has to separate the two readings a null node collapses: a
    // wrong id and an invisible project are the same bytes.
    expect(() => requireNode({ node: null }, "project board")).toThrow(/SUCCEEDED/);
    expect(() => requireNode({ node: null }, "project board")).toThrow(/scope/);
    expect(() => requireNode({}, "project board")).toThrow(/node: null/);
    expect(() => requireNode(null, "project board")).toThrow(/no data object/);
  });

  test("BS-23: a real node is returned unchanged", () => {
    // Anti-vacuity for BS-22: all four cases above pass against a function
    // that throws unconditionally, which would take the whole sweep down.
    expect(requireNode({ node: { items: { nodes: [] } } }, "project board")).toEqual({
      items: { nodes: [] },
    });
  });

  test("BS-24: a status that was NOT READ is undecidable, never agreement", () => {
    // The false zero one level down. `items` is paged; the per-item
    // `fieldValues` connection was not, so an item carrying more field values
    // than the page holds loses Status off the end — and a missing Status
    // read as `null`, which every branch below treats as "some non-Done
    // column", i.e. agreement. A genuinely wrong Done column would be
    // counted as agreeing and left uncorrected by --write.
    //
    // "No column" and "column not read" are the same `null` with opposite
    // correct answers, which is why this is a separate field and not a
    // sentinel string.
    const v = verdictFor({ ...item(1700, "PullRequest", "OPEN", null), statusUnread: true });
    expect(v.kind).toBe("undecidable");
    expect(v.kind === "undecidable" && v.why).toContain("NOT READ");

    // It outranks every other branch, including the closed-item correction —
    // a MERGED row whose column was never read must not be written to Done
    // on the strength of a column nobody saw.
    const closed = verdictFor({
      ...item(1701, "PullRequest", "MERGED", null),
      statusUnread: true,
    });
    expect(closed.kind).toBe("undecidable");
  });

  test("BS-25: a transient failure is retried, and a permanent one still refuses", async () => {
    // The two halves of this change make the same call and only the workflow
    // half retried. Same reasoning applies to `fetch`, and harder on the
    // --write path, which issues one mutation per correction.
    let calls = 0;
    const flaky = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("socket hang up");
        return "ok";
      },
      3,
      async () => {},
    );
    expect(flaky).toBe("ok");
    expect(calls).toBe(3);

    // Anti-vacuity: a withRetry that swallowed everything would satisfy the
    // row above. Three real failures must still throw, carrying the last one.
    let tries = 0;
    await expect(
      withRetry(
        async () => {
          tries += 1;
          throw new Error("401 Bad credentials");
        },
        3,
        async () => {},
      ),
    ).rejects.toThrow(/Bad credentials/);
    expect(tries).toBe(3);
  });

  test("BS-26: one failed correction does not abandon the batch", async () => {
    // The loop threw out of main(), so a transient failure on correction 3 of
    // 5 left the board partially corrected with no record of which writes
    // landed. A tool whose job is to make the board legible must not end by
    // being illegible about itself.
    const corrections = [
      { number: 1, to: DONE },
      { number: 2, to: DONE },
      { number: 3, to: DONE },
    ];
    const applied = await applyCorrections(corrections, async c => {
      if (c.number === 2) throw new Error("502 Bad Gateway");
    });

    expect(applied.wrote.map(w => w.number)).toEqual([1, 3]);
    expect(applied.failed.map(f => f.number)).toEqual([2]);
    // The failure has to carry WHY, or the row names a number and nothing else.
    expect(applied.failed[0]?.error).toContain("502");
  });

  test("BS-8: the reading partitions the population exactly once", () => {
    // Anti-vacuity. Every item lands in exactly one bucket and the totals add
    // up, so a verdict that silently returns nothing cannot read as a clean
    // board.
    const items = [
      item(1749, "PullRequest", "MERGED", "In review"), // correct -> Done
      item(1645, "PullRequest", "MERGED", DONE), // agrees
      item(1607, "PullRequest", "OPEN", DONE), // correct -> In review
      item(1744, "Issue", "OPEN", DONE), // undecidable
      item(1700, "PullRequest", "OPEN", DONE, true), // undecidable — draft
      item(1740, "PullRequest", "OPEN", "Backlog"), // agrees
    ];
    const r = sweep(items);

    expect(r.agrees).toBe(2);
    expect(r.corrections.map(c => c.number).sort()).toEqual([1607, 1749]);
    expect(r.undecidable.map(u => u.number).sort()).toEqual([1700, 1744]);
    expect(r.agrees + r.corrections.length + r.undecidable.length).toBe(items.length);
  });

  // BS-27. `errors` PRESENT is not `errors` POPULATED, and the guard tested
  // the wrong one of those. `body.errors !== undefined` fires on
  // `"errors": null` and on `"errors": []`, so a response that succeeded and
  // carried an empty errors key was reported as a GraphQL failure — with
  // `GraphQL: null` or `GraphQL: []` as the whole message, which names no
  // defect and sends the reader looking for a query problem that is not
  // there.
  //
  // A spec-compliant server does not send either on success. This function
  // exists ENTIRELY to be defensive about servers that do not behave, which
  // is why "the spec forbids it" is not a defence here — it is the premise.
  test("BS-27: an absent, null or empty errors key is not a GraphQL error", () => {
    const ok = JSON.stringify({ data: { node: { id: "x" } } });
    expect(interpretResponse(200, true, ok)).toEqual({ node: { id: "x" } });

    for (const spelling of ["null", "[]"]) {
      const body = `{"errors":${spelling},"data":{"node":{"id":"x"}}}`;
      expect(
        () => interpretResponse(200, true, body),
        `"errors": ${spelling} is an empty errors key on a successful response, not a failure`,
      ).not.toThrow();
      expect(interpretResponse(200, true, body)).toEqual({ node: { id: "x" } });
    }

    // The positive half, in the same case: a POPULATED errors array must
    // still throw, and the message must carry the error so it is actionable.
    // Without this the cheapest repair — deleting the check — goes green.
    expect(() =>
      interpretResponse(200, true, '{"errors":[{"message":"Bad credentials"}]}'),
    ).toThrow(/Bad credentials/);

    // And a non-array truthy `errors` is a shape this function does not
    // understand. Refusing is right: silently returning data on an
    // unrecognised envelope is Silent Default Substitution.
    expect(() => interpretResponse(200, true, '{"errors":{"message":"odd"}}')).toThrow(/odd/);
  });
});

// ── BS-28: the refusal, performed and observed ───────────────────────────
//
// THIS BATTERY EXISTS BECAUSE ITS ABSENCE WAS BEING CLAIMED AS PRESENT.
// `DRIFT_EXIT`'s docblock read "Mutated to 0 to prove the refusal is real",
// and nothing in this file imported `DRIFT_EXIT`, ran `main()`, or observed
// an exit code. A comment saying a property is tested is the reason nobody
// tests it (`.claude/rules/checks-must-be-able-to-fail.md`) — so the claim
// is made true here rather than softened in the comment.
//
// The shape is `test/rook-review-scope.test.ts`'s, with one difference that
// matters: that script has no relative imports, so its mutant is a lone file
// in a temp directory. This one imports `../lib/github`, so the sandbox
// carries `lib/` and a link to `node_modules`. A mutant that died on module
// resolution would also exit non-zero and read as the mutation having been
// rejected on the merits — which is why every case below asserts the run
// PRINTED ITS DECISION as well as what it exited with.
const ROOT = join(import.meta.dir, "..");
const SWEEP = "scripts/board-status-sweep.ts";
const source = readFileSync(join(ROOT, SWEEP), "utf-8");

let SANDBOX = "";
let REAL = "";
let MUTANT = "";

beforeAll(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "board-sweep-mutant-"));
  cpSync(join(ROOT, "lib"), join(SANDBOX, "lib"), { recursive: true });
  cpSync(join(ROOT, "scripts"), join(SANDBOX, "scripts"), { recursive: true });
  cpSync(join(ROOT, "package.json"), join(SANDBOX, "package.json"));
  symlinkSync(join(ROOT, "node_modules"), join(SANDBOX, "node_modules"));

  REAL = join(SANDBOX, SWEEP);
  MUTANT = join(SANDBOX, "scripts", "board-status-sweep.mutant.ts");

  const mutated = source.replace(/DRIFT_EXIT\s*=\s*1\b/, "DRIFT_EXIT = 0");
  expect(
    mutated,
    "could not build the mutant: no `DRIFT_EXIT = 1` in " + SWEEP,
  ).not.toBe(source);
  writeFileSync(MUTANT, mutated);
});

afterAll(() => {
  if (SANDBOX) rmSync(SANDBOX, { recursive: true, force: true });
});

/** Run a copy with NO credential in the environment, whatever this machine has. */
function runWithoutCredential(script: string): { code: number; out: string } {
  const env = { ...process.env };
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  const r = spawnSync("bun", [script], { encoding: "utf-8", env, cwd: SANDBOX });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("BS-28: DRIFT_EXIT is the refusal, and the mutant proves it", () => {
  test("the real script refuses an absent credential, and says so", () => {
    const r = runWithoutCredential(REAL);
    // The DECISION first. A non-zero exit on its own is also what a crash,
    // a missing module and a syntax error produce.
    expect(r.out, `the script printed no UNMEASURED reading:\n${r.out}`).toContain("UNMEASURED");
    expect(r.code, `expected a refusal, got ${r.code}:\n${r.out}`).toBe(1);
  });

  test("the mutant reaches the same decision and does NOT refuse", () => {
    const r = runWithoutCredential(MUTANT);
    // Same reading printed — so this run demonstrably reached the mechanism
    // rather than dying before it.
    expect(r.out, `the mutant printed no UNMEASURED reading:\n${r.out}`).toContain("UNMEASURED");
    // And the refusal is gone, which is the whole point: the non-zero exit
    // was removed, performed, and observed.
    expect(
      r.code,
      `the mutant (DRIFT_EXIT = 0) still exited ${r.code} — the refusal under ` +
        `test is not what the case above observed.\n${r.out}`,
    ).toBe(0);
  });

  test("DRIFT_EXIT is assigned exactly once, so the mutation cannot be bypassed", () => {
    const assignments = source.match(/DRIFT_EXIT\s*=/g) ?? [];
    expect(
      assignments.length,
      "more than one assignment to DRIFT_EXIT — the mutant would neutralise only one",
    ).toBe(1);
  });

  test("no refusal inlines its own exit code", () => {
    // A `process.exit(1)` or `return 1` elsewhere would survive the mutation
    // and leave a refusal this battery cannot see.
    //
    // The first spelling of this captured `([^)]*)` and so stopped at the
    // first inner paren of `main(process.argv.slice(2))`, reporting the
    // entrypoint as an offender. Counting the call sites and asserting the
    // one spelling is both narrower and correct — a detector that cannot
    // parse the code it guards reports the code's shape as a defect.
    const exits = [...source.matchAll(/process\.exit\(/g)];
    expect(exits.length, "exactly one process.exit, and it returns main()'s value").toBe(1);
    expect(source).toContain("process.exit(await main(");
    expect(
      /process\.exit\(\s*\d/.test(source),
      "a numeric literal passed to process.exit bypasses DRIFT_EXIT entirely",
    ).toBe(false);
    const literals = [...source.matchAll(/^\s*return\s+([1-9]\d*)\s*;/gm)].map(m => m[0].trim());
    expect(literals, "a literal non-zero return bypasses DRIFT_EXIT").toEqual([]);
  });
});
