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
  requireWrittenItem,
  interpretResponse,
  parseBoardItem,
  requireConnection,
  requireCursorAdvanced,
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

  // ── BS-29..BS-33: the parsing half, against real-shaped payloads ────────
  //
  // Caught in review of #1754, and it was right: every case above builds a
  // `BoardItem` by hand and sets `statusUnread` as a literal. The function
  // that DERIVES it from a GraphQL node had no case at all, so a typo in the
  // `Status` filter, a wrong nesting level or an inverted `hasNextPage`
  // would produce wrong values and leave all 26 rows green — the third shape
  // in `.claude/rules/checks-must-be-able-to-fail.md`, an assertion holding
  // against a value the test itself just set.
  //
  // These five feed `parseBoardItem` the shape the server actually sends.
  const node = (over: Record<string, unknown> = {}, fieldValues?: unknown) => ({
    id: "PVTI_x",
    content: { __typename: "PullRequest", number: 7, state: "OPEN", isDraft: false, ...over },
    fieldValues: fieldValues ?? { pageInfo: { hasNextPage: false }, nodes: [] },
  });
  const values = (names: Record<string, string>, hasNextPage = false) => ({
    pageInfo: { hasNextPage },
    nodes: Object.entries(names).map(([field, name]) => ({ name, field: { name: field } })),
  });

  test("BS-29: Status is read from the nested field name, not from position", () => {
    // Two decoys either side, so a parser that takes `nodes[0].name` or the
    // last node passes nothing. The filter has to look at `field.name`.
    const item = parseBoardItem(
      node({}, values({ Priority: "P1", Status: "Done", Size: "M" })),
    );
    expect(item?.status).toBe(DONE);
    expect(item?.statusUnread).toBe(false);
    expect(item).toMatchObject({ itemId: "PVTI_x", number: 7, kind: "PullRequest", state: "OPEN" });
  });

  test("BS-30: Status absent off the end of a FULL page is statusUnread, derived", () => {
    // The finding's exact ask: prove `statusUnread` comes out true from a
    // real-shaped payload, not from a hand-set fixture field. This is the
    // false zero one level down — Status is not in the page, and the page
    // says there is more.
    const item = parseBoardItem(node({}, values({ Priority: "P1" }, true)));
    expect(item?.status).toBeNull();
    expect(item?.statusUnread).toBe(true);
    // And the verdict that follows from it, so the two halves meet in one
    // case rather than each being correct against its own fixture.
    expect(verdictFor(item!).kind).toBe("undecidable");
  });

  test("BS-31: Status absent off a COMPLETE page is not read, it is not set", () => {
    // The distinction the whole fix exists for. Same `status: null`, opposite
    // meaning, and nothing but `hasNextPage` tells them apart — so a parser
    // that ignored `pageInfo` would pass BS-30 and fail here, and one that
    // always trusted it would pass here and fail BS-30.
    const item = parseBoardItem(node({}, values({ Priority: "P1" }, false)));
    expect(item?.status).toBeNull();
    expect(item?.statusUnread).toBe(false);
  });

  test("BS-32: a truncated page that DID carry Status was read", () => {
    // `&& status === null` in the other direction. Dropping it refuses every
    // item with more fields than a page, for no reason, and BS-30 and BS-31
    // both stay green while it does.
    const item = parseBoardItem(node({}, values({ Status: IN_REVIEW }, true)));
    expect(item?.status).toBe(IN_REVIEW);
    expect(item?.statusUnread).toBe(false);
  });

  // ── BS-34..BS-35: two review findings about what a run tells its reader ──
  const SRC = readFileSync(join(import.meta.dir, "..", "scripts", "board-status-sweep.ts"), "utf-8");

  test("BS-34: every network call carries a timeout, so a hang reaches withRetry", () => {
    // `withRetry` survives failures that REJECT. A connection accepted and
    // never answered rejects nothing, so it never retries and `main()`
    // blocks forever — in CI, on the `--write` path, with nobody watching.
    // Caught in review of #1754.
    //
    // A census over the population rather than the one site: a second fetch
    // added later without a signal is the same defect at a new address.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    const fetches = [...code.matchAll(/\bfetch\(/g)];
    // Anti-vacuity. Zero means the request path was rewritten and the row
    // below is asserting over nothing.
    expect(fetches.length, "expected at least one fetch( in the sweep").toBeGreaterThanOrEqual(1);
    expect(
      (code.match(/signal:\s*AbortSignal\.timeout\(/g) ?? []).length,
      "every fetch( in this file must carry `signal: AbortSignal.timeout(...)` — " +
        "a stalled connection never rejects, so withRetry never gets to retry it",
    ).toBe(fetches.length);
    // And the budget is per attempt, so three attempts get three chances.
    expect(code).toMatch(/REQUEST_TIMEOUT_MS\s*=\s*[\d_]+/);
  });

  // ── BS-36..BS-37: two more, from the round that reviewed BS-34/BS-35 ────

  test("BS-36: an HTTP failure reports what the server said, not just the code", () => {
    // GitHub answers a bad or scopeless token with 401/403 and a well-formed
    // JSON body — `{"message": "Bad credentials", ...}` — carrying no `errors`
    // key at all. So `failed` is false, the two branches that preserve
    // `snippet` are both skipped, and execution reached `throw new Error(
    // \`HTTP ${status}\`)`, discarding the one sentence that says WHY.
    //
    // Through `withRetry` the reader finally saw "3 attempts failed, last:
    // HTTP 401" for a permanent, non-retryable credential problem — and this
    // function's own docblock promises it "keeps both facts available: the
    // status, and what the server actually said". Caught in review of #1754.
    //
    // Behavioural, not source-text: `interpretResponse` is exported, so the
    // message a reader actually gets is the thing asserted.
    const body = JSON.stringify({ message: "Bad credentials", documentation_url: "https://docs" });
    let message = "";
    try {
      interpretResponse(401, false, body);
      throw new Error("interpretResponse did not refuse a 401");
    } catch (e) {
      message = (e as Error).message;
    }
    // Anti-vacuity: the row must be observing the !ok branch, not the
    // not-JSON or not-an-object branch, both of which already carry text.
    expect(message, "expected the status in the message").toContain("401");
    expect(
      message,
      "a 401/403 body parses as JSON and carries no `errors`, so it reaches the " +
        "`!ok` throw — which must carry the server's own text. Without it the " +
        "reader gets a bare HTTP code for a permanent credential failure.",
    ).toContain("Bad credentials");
  });

  test("BS-37: the field list is paginated, or says it could not be read", () => {
    // `fields(first: 50)` with no `pageInfo`, in a file that loops `items`
    // with a cursor and explicitly flags `statusUnread` when `fieldValues`
    // truncates. A board that grows past fifty custom fields puts Status on
    // page two, and `.find(f => f?.name === "Status")` returns undefined —
    // throwing "no Status field on this project" about a field that exists
    // and was simply not fetched. Not silent-wrong, but the message sends the
    // reader to the board to look for something that is already there.
    // Caught in review of #1754. `.claude/rules/…` — page every list.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    const q = code.slice(code.indexOf("const FIELDS_QUERY"), code.indexOf("const SET_STATUS"));
    // Anti-vacuity: the query must still be here and must still be the one
    // that asks for fields.
    expect(q, "FIELDS_QUERY must still request fields").toMatch(/fields\(first:/);
    expect(
      q,
      "FIELDS_QUERY must ask for `pageInfo { hasNextPage }` like every other " +
        "list in this file, so a Status field on page two is UNMEASURED " +
        "rather than reported as absent.",
    ).toMatch(/pageInfo\s*\{[^}]*hasNextPage/);
    // And the absence must be told apart from the truncation when it is
    // reported, or the pageInfo is fetched and ignored.
    expect(
      code,
      "the 'no Status field' refusal must distinguish a field that is absent " +
        "from one that was never fetched — otherwise reading pageInfo changes nothing",
    ).toMatch(/hasNextPage[\s\S]{0,600}?no Status field|no Status field[\s\S]{0,600}?hasNextPage/);
  });

  test("BS-39: a write nothing confirms is a FAILURE, not a success", () => {
    // `SET_STATUS` returns `projectV2Item { id }` and the result was thrown
    // away, so `applyCorrections` logged `wrote #N` for anything that did not
    // throw. `updateProjectV2ItemFieldValue` can answer 200 with no `errors`
    // and `{ projectV2Item: null }` — item concurrently removed, or a
    // credential that writes some fields and not this one — and the board
    // then went on disagreeing with GitHub while the tool said it had fixed
    // it. Caught in review of #1754.
    //
    // Behavioural, through the exported binding, because the whole point is
    // which BUCKET a null payload lands in.
    expect(
      requireWrittenItem({ updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_x" } } }, 7),
    ).toBe("PVTI_x");
    // The three shapes a 200-with-no-errors can carry.
    for (const [label, payload] of [
      ["a null item", { updateProjectV2ItemFieldValue: { projectV2Item: null } }],
      ["a null mutation payload", { updateProjectV2ItemFieldValue: null }],
      ["no key at all", {}],
    ] as const) {
      expect(() => requireWrittenItem(payload, 7), `${label} must refuse`).toThrow(/#7/);
    }
    // An empty-string id is "present" to a truthiness check and confirms
    // nothing, which is the `?? 0` mistake in another costume.
    expect(() =>
      requireWrittenItem({ updateProjectV2ItemFieldValue: { projectV2Item: { id: "" } } }, 7),
    ).toThrow();

    // And the write path must actually call it — a validator nothing invokes
    // is the comment-saying-it-was-checked failure.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    expect(
      (code.match(/requireWrittenItem\(/g) ?? []).length,
      "expected the definition plus exactly one call site on the write path",
    ).toBe(2);
    expect(
      code,
      "the SET_STATUS mutation's result must go through requireWrittenItem",
    ).toMatch(/requireWrittenItem\(\s*await graphql\(token, SET_STATUS/);
  });

  // BS-41. THIS FILE MAKES FACTUAL CLAIMS ABOUT A FILE IT DOES NOT CONTAIN,
  // AND TWICE NOW THEY HAVE BEEN FALSE.
  //
  // Round 7 found the draft refusal citing a mechanism in `board-intake.yml`
  // that was not there. The round-8 repair rewrote that one sentence and put
  // TWO new false claims in its place — including a quotation ("WHAT IT
  // DELIBERATELY DOES NOT DO: set a field") that exists nowhere in
  // `board-intake.yml` and only ever existed in the comment quoting it. Both
  // repairs were written against a worktree whose `origin/main` was five
  // merges stale, so the file being described was read correctly and was the
  // wrong file.
  //
  // Rewriting the sentence a third time fixes one sentence. This asserts the
  // property instead: every string this file puts in quotation marks and
  // attributes to `board-intake.yml` must be findable in `board-intake.yml`.
  // A claim about a sibling file is now checked by CI on the merge ref, where
  // the sibling is current by construction, rather than by whoever last
  // remembered to go and look.
  test("BS-41: every phrase this file quotes from board-intake.yml is in board-intake.yml", () => {
    const workflow = readFileSync(join(ROOT, ".github/workflows/board-intake.yml"), "utf-8");

    // Anti-vacuity, both directions. The workflow must have actually been
    // read — an empty or missing file would make every `includes` below fail
    // rather than pass, but a TRUNCATED one would quietly shrink what the
    // claims are checked against. And the matcher must be able to say no.
    expect(workflow.length, "board-intake.yml was not read").toBeGreaterThan(5000);
    expect(
      workflow.includes("WHAT IT DELIBERATELY DOES NOT DO: set a field"),
      "control: the phrase the round-8 comment attributed to board-intake.yml " +
        "must NOT be in it — if this ever passes, the control has stopped " +
        "being able to disagree and every row below is vacuous",
    ).toBe(false);

    // The phrases `scripts/board-status-sweep.ts` attributes to the workflow.
    // Adding a quoted claim to that file means adding it here.
    const QUOTED = [
      "a draft in `In review` says somebody is waiting",
      "Drafts stay in Backlog until",
    ];
    expect(QUOTED.length, "the claim list must not be empty").toBeGreaterThan(0);

    const src = SRC.replace(/\r/g, "");
    for (const phrase of QUOTED) {
      // Each phrase must be BOTH claimed by the script and true of the
      // workflow. Checking only the second half would let a claim be deleted
      // from the script and still pass.
      // Compared verbatim on BOTH sides, backticks included. Normalising the
      // punctuation away would let the script quote something the workflow
      // does not actually say and still pass — the comparison has to be over
      // the bytes the reader would go and look for.
      expect(src.includes(phrase), `the script must actually claim: ${phrase}`).toBe(true);
      expect(
        workflow.includes(phrase),
        `scripts/board-status-sweep.ts attributes "${phrase}" to board-intake.yml, ` +
          `and board-intake.yml does not contain it. Re-read the workflow — on ` +
          `the CURRENT main, not a stale worktree ref — before describing it.`,
      ).toBe(true);
    }
  });

  // BS-42. `requireConnection` validated `nodes` and said nothing about
  // `pageInfo`, and `readBoard` then dereferenced `page.pageInfo.hasNextPage`
  // and `page.pageInfo.endCursor` bare — no `?.`, no shape check — in the one
  // list in this file with no pageInfo-shape row comparable to BS-37's for
  // FIELDS_QUERY. Schema-non-null in a well-formed response, which is exactly
  // the premise this file refuses to rest on everywhere else: if it is ever
  // hit, `readBoard` dies with a bare TypeError instead of the legible
  // refusal this script works hard to produce.
  //
  // Guarded in the single binding rather than at the two dereferences, so the
  // `fields` page gets it too and there is one site to mutate. Found in
  // review of #1754.
  test("BS-42: a connection must carry a usable pageInfo, not just nodes", () => {
    const ok = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    expect(requireConnection({ node: { items: ok } }, "items", "project board")).toEqual(ok);

    // Anti-vacuity: a well-formed page with `hasNextPage: true` must also
    // pass, so the row is not accidentally asserting "false only".
    const more = { nodes: [], pageInfo: { hasNextPage: true, endCursor: "c1" } };
    expect(requireConnection({ node: { items: more } }, "items", "project board")).toEqual(more);

    for (const [label, page] of [
      ["pageInfo absent entirely", { nodes: [] }],
      ["pageInfo null", { nodes: [], pageInfo: null }],
      ["pageInfo a scalar", { nodes: [], pageInfo: "yes" }],
      ["hasNextPage missing", { nodes: [], pageInfo: { endCursor: "c1" } }],
      ["hasNextPage a string, not a boolean", { nodes: [], pageInfo: { hasNextPage: "true" } }],
    ] as const) {
      expect(
        () => requireConnection({ node: { items: page } }, "items", "project board"),
        `${label} must refuse — a pagination flag that is not a boolean ends the ` +
          `loop early and reports a SHORT board as a complete one`,
      ).toThrow(/pageInfo/);
    }
  });

  // BS-43. THE SYMMETRIC HALF OF BS-42, WHICH I MISSED BY FIXING THE
  // MEMBER THE FINDING NAMED.
  //
  // BS-42 made a non-boolean `hasNextPage` refuse, because a falsy one ENDS
  // pagination early and reports a short board as complete. The mirror image
  // is a `hasNextPage: true` that cannot be followed: `endCursor` null, empty
  // or non-string. `readBoard` assigns it, the next request carries an `after`
  // that is effectively unset, GitHub returns page one again with
  // `hasNextPage: true`, and `for (;;)` never exits — an unbounded loop
  // burning API calls in a `--write` run with nobody watching. Worse than the
  // short read it is the twin of.
  //
  // Keyed on whether the connection ASKED for a cursor. A GraphQL response
  // carries exactly the selection set, so `endCursor` absent from `pageInfo`
  // means the query never requested it — which is `FIELDS_QUERY`, a
  // connection that refuses rather than pages. Present-and-unusable and
  // never-requested are different facts and only the first is a defect.
  // Found in review of #1754.
  test("BS-43: a hasNextPage that cannot be followed must refuse, not spin", () => {
    const conn = (pageInfo: unknown) => ({ node: { items: { nodes: [], pageInfo } } });

    // Anti-vacuity, three passing controls. Without these the row is
    // satisfied by a guard that refuses every connection in the file.
    expect(
      requireConnection(conn({ hasNextPage: true, endCursor: "c1" }), "items", "project board"),
      "a followable next page must pass",
    ).toBeDefined();
    expect(
      requireConnection(conn({ hasNextPage: false, endCursor: null }), "items", "project board"),
      "a null cursor at the END of a list is normal and must pass",
    ).toBeDefined();
    expect(
      requireConnection(conn({ hasNextPage: true }), "items", "project board"),
      "no endCursor KEY means the query never asked for one — that is " +
        "FIELDS_QUERY, which refuses rather than pages, and must not be " +
        "caught by a rule about following cursors",
    ).toBeDefined();

    for (const [label, cursor] of [
      ["endCursor null", null],
      ["endCursor empty string", ""],
      ["endCursor a number", 7],
    ] as const) {
      expect(
        () => requireConnection(conn({ hasNextPage: true, endCursor: cursor }), "items", "project board"),
        `${label} with hasNextPage true must refuse — the next request would ` +
          `re-fetch page one and the loop would never terminate`,
      ).toThrow(/endCursor/);
    }

    // THE GUARD MUST BE LIVE FOR THE ONE CALLER THAT PAGINATES. Because the
    // rule keys on the cursor being requested, dropping `endCursor` from
    // BOARD_QUERY would silently switch it off and leave the loop unguarded
    // with every row above still green.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    expect(
      code,
      "BOARD_QUERY's items connection must request endCursor, or BS-43's " +
        "refusal never applies to the only loop that can spin",
    ).toMatch(/items\(first: 100, after: \$endCursor\)\s*\{\s*pageInfo\s*\{\s*hasNextPage endCursor \}/);
  });

  // BS-44. The finding behind BS-43 named THREE ways a next page can fail to
  // be followable — `endCursor` null, undefined, "or a value that doesn't
  // actually advance the cursor". BS-43 closes the first two. This is the
  // third, and it is the one `requireConnection` structurally cannot see:
  // whether a cursor advanced is a property of two consecutive responses, and
  // that function is handed one. A well-formed, non-empty cursor returned
  // unchanged forever is an unbounded loop that passes every shape check.
  //
  // A page cap would also stop it and would be the wrong instrument — it
  // cannot tell a board that grew from a server that stopped advancing, so it
  // either fires on legitimate growth or is set so high it never fires at
  // all. Repetition is the exact signal and needs no threshold.
  test("BS-44: a cursor that does not advance is refused, not followed forever", () => {
    expect(requireCursorAdvanced(null, "c1"), "the first page must pass").toBe("c1");
    expect(requireCursorAdvanced("c1", "c2"), "an advancing cursor must pass").toBe("c2");

    expect(
      () => requireCursorAdvanced("c1", "c1"),
      "the same cursor twice is a server that stopped advancing — the next " +
        "request would repeat the page that produced it",
    ).toThrow(/same endCursor/);

    // The loop must actually use it. A progress invariant nothing calls is
    // the docblock-saying-it-was-checked failure.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    expect(
      (code.match(/requireCursorAdvanced\(/g) ?? []).length,
      "expected the definition plus exactly one call site — readBoard's loop, " +
        "the only unbounded loop in this file",
    ).toBe(2);
    expect(
      code,
      "readBoard must assign its next cursor THROUGH the invariant, not beside it",
    ).toMatch(/endCursor = requireCursorAdvanced\(/);
  });

  // BS-40. `requireNode` guards the TOP-LEVEL node being null — the case
  // GitHub returns for an id the token cannot see — and both call sites then
  // reached straight into a nested connection it does not check:
  // `(requireNode(data, …) as any).items` and `… as any).fields`. An id that
  // resolves to something which is not a ProjectV2 leaves the `... on
  // ProjectV2` fragment unmatched, so `node` is a perfectly good object and
  // the connection is `undefined` — and `page.nodes` threw a bare
  // `Cannot read properties of undefined (reading 'nodes')` from the one
  // script whose entire subject is telling a reading from an absence.
  //
  // Found in review of #1754 — and it is the SAME class as BR-40/BR-41, fixed
  // in `scripts/board-ready.ts` in this same session without sweeping the
  // sibling. Population here is 2 of 2; both go through one binding.
  test("BS-40: a nested connection is guarded like the node that carries it", () => {
    expect(
      requireConnection(
        { node: { items: { nodes: [], pageInfo: { hasNextPage: false } } } },
        "items",
        "project board",
      ),
    ).toEqual({ nodes: [], pageInfo: { hasNextPage: false } });

    // Anti-vacuity: each refusal must be observed for its OWN shape, and the
    // top-level cases must still refuse through requireNode underneath.
    for (const [label, payload] of [
      ["the fragment did not match, so the key is absent", { node: {} }],
      ["the key is present and null", { node: { items: null } }],
      ["the key is a scalar, not a connection", { node: { items: 7 } }],
      ["the connection carries no nodes array", { node: { items: { pageInfo: {} } } }],
    ] as const) {
      expect(
        () => requireConnection(payload, "items", "project board"),
        `${label} must refuse`,
      ).toThrow(/items/);
    }
    expect(() => requireConnection({ node: null }, "items", "project board")).toThrow(/SUCCEEDED/);

    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    expect(
      (code.match(/requireConnection\(/g) ?? []).length,
      "expected the definition plus exactly two call sites — the board items " +
        "page and the project fields page, which are the only two nested " +
        "connections this script reaches into",
    ).toBe(3);

    // The defect, as source: a requireNode result cast and indexed directly.
    expect(
      [...code.matchAll(/requireNode\([^)]*\)\s*as any\)\s*\./g)].map(m => m[0]),
      "a `(requireNode(…) as any).<key>` reach-through is the unguarded " +
        "connection this row exists to stop — route it through " +
        "requireConnection so the absence is named instead of thrown past.",
    ).toEqual([]);
  });

  test("BS-38: a --write run with nothing to write resolves no fields", () => {
    // `--write` fell through to FIELDS_QUERY whatever the reading said, so a
    // no-op run was exposed to two failures that have nothing to do with the
    // work: the page-two Status refusal and "no Status field on this
    // project". The equivalent report-only run cannot fail either way, which
    // made passing --write on a clean board strictly more fragile than not
    // passing it. Caught in review of #1754.
    //
    // **This is a source-ORDER assertion, not a behavioural one, and the
    // review that raised it said so first** — exercising `main()` needs a
    // live GraphQL endpoint, and a mock deep enough to reach line 544 would
    // be asserting against its own fixture. The property that is checkable
    // from here is the one that matters: the guard exists and precedes the
    // fetch. BS-37 covers what happens when the fetch does run.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    const guard = code.search(/if \(reading\.corrections\.length === 0\)/);
    const fetchFields = code.search(/graphql\(token, FIELDS_QUERY/);
    // Anti-vacuity, both halves. A renamed query or a deleted guard gives -1,
    // and -1 < anything would otherwise satisfy the ordering vacuously.
    expect(fetchFields, "FIELDS_QUERY must still be fetched somewhere").toBeGreaterThan(-1);
    expect(
      guard,
      "a `--write` run must short-circuit when `reading.corrections.length === 0`",
    ).toBeGreaterThan(-1);
    expect(
      guard < fetchFields,
      "the empty-corrections guard must come BEFORE the Status field is resolved, " +
        "or a run with nothing to write can still abort on a field lookup it never needed",
    ).toBe(true);
  });

  test("BS-35: the re-run instruction is not printed when nothing is writable", () => {
    // One message served both branches, so a run finding only undecidable
    // rows said "re-run with --write to apply the corrections above" when
    // there were none above and --write is explicitly refused for those
    // rows. An instruction that cannot work teaches the reader to distrust
    // the tool rather than to go and pick the column.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    // The corrections branch must be guarded on corrections ALONE.
    expect(
      code,
      "the --write instruction must be reachable only when there are corrections",
    ).toMatch(/if\s*\(reading\.corrections\.length > 0\)\s*\{\s*\n\s*console\.log\([^)]*--write/);
    // And the undecidable-only case must say so rather than borrow it.
    expect(
      code,
      "a run with only undecidable rows needs its own message saying nothing is writable",
    ).toMatch(/every row above is UNDECIDABLE/);
    // Anti-vacuity: the old single-condition guard must be gone, not merely
    // joined by a second one.
    expect(
      /reading\.corrections\.length > 0 \|\| reading\.undecidable\.length > 0/.test(code),
      "the merged condition is the defect — the two cases print different instructions",
    ).toBe(false);
  });

  test("BS-33: isDraft is coerced, and a node this sweep cannot judge is null", () => {
    // `isDraft` is absent on the Issue fragment. An `undefined` reaching
    // `BoardItem.draft` makes `!item.draft` true for every item, so the draft
    // branch never runs — BS-13 is green against a sweep that moves drafts.
    expect(parseBoardItem(node({ __typename: "Issue", isDraft: undefined }))?.draft).toBe(false);
    expect(parseBoardItem(node({ isDraft: true }))?.draft).toBe(true);

    // And the three nodes that are not items of this sweep.
    expect(parseBoardItem({ id: "a", content: null })).toBeNull();
    expect(parseBoardItem({ id: "a" })).toBeNull();
    expect(parseBoardItem({ id: "a", content: { __typename: "DraftIssue" } })).toBeNull();
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
