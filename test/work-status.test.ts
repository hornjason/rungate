/**
 * The status reader's two deciders, and a mutation battery over each.
 *
 * Both guard the same class of defect — a reading that is WRONG while looking
 * HEALTHY — so a case that cannot fail here is worse than no case at all
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { isPickable, orderReading } from "../lib/work-status";

const ROOT = join(import.meta.dir, "..");
const open = (blockers: { state: string }[] = [], assignees: unknown[] = []) =>
  ({ state: "open", assignees, blockers }) as const;

describe("isPickable: the 44-issue error, as cases", () => {
  test("an issue with no blockers and no assignee is pickable", () => {
    expect(isPickable(open())).toBe(true);
  });

  // The regression that produced 77. `-is:blocked` was dropped by two of three
  // transports and every blocked issue came back pickable.
  test("an OPEN blocker makes it unpickable", () => {
    expect(isPickable(open([{ state: "open" }]))).toBe(false);
  });

  // The opposite error, and the one a naive `blockers.length > 0` makes: a
  // chain whose dependency has landed is pickable, and parking it forever is
  // how a finished chain stops being worked.
  test("a CLOSED blocker does not block — this is not blockers.length", () => {
    expect(isPickable(open([{ state: "closed" }]))).toBe(true);
    expect(isPickable(open([{ state: "closed" }, { state: "open" }]))).toBe(false);
  });

  test("an assignee makes it unpickable — somebody has claimed it", () => {
    expect(isPickable(open([], ["someone"]))).toBe(false);
  });

  test("a closed issue is never pickable however clear its blockers", () => {
    expect(isPickable({ state: "closed", assignees: [], blockers: [] })).toBe(false);
  });
});

describe("orderReading: an item nothing can observe is UNMEASURED, never DONE", () => {
  // The failure this exists for, by name. On 2026-11-03 items 1 and 2 of the
  // agreed order were reported to Jason as DONE out of a session's context
  // while PROJECT-STATE.md said 1, 2 and 3 were untouched — and item 1 was an
  // OPEN pull request. A reading taken from memory is indistinguishable from
  // one taken from the tracker, which is the whole defect.
  test("no tracker object is UNMEASURED", () => {
    expect(orderReading({ tracker: null })).toBe("UNMEASURED");
  });

  test("a tracker named but never fetched is UNMEASURED, not DONE", () => {
    expect(orderReading({ tracker: "#1741" })).toBe("UNMEASURED");
  });

  test("open reads through, for either kind", () => {
    expect(orderReading({ tracker: "#1741", facts: { kind: "issue", state: "open", stateReason: null } })).toBe("OPEN");
    expect(orderReading({ tracker: "PR #1607", facts: { kind: "pr", state: "open", merged: false } })).toBe("OPEN");
  });

  test("a merged pull request is DONE", () => {
    expect(orderReading({ tracker: "PR #1730", facts: { kind: "pr", state: "closed", merged: true } })).toBe("DONE");
  });

  test("an issue closed as completed is DONE", () => {
    expect(orderReading({ tracker: "#1727", facts: { kind: "issue", state: "closed", stateReason: "completed" } })).toBe("DONE");
  });

  // Caught in review of #1740. The first version asked only `state ===
  // "closed"`, so both of these reported DONE and the report would have
  // ticked an agreed item whose work never happened — the same
  // wrong-but-healthy reading as the dropped search qualifier, by a
  // different route. CLOSED and DONE are different facts.
  test("a pull request closed WITHOUT merging is ABANDONED, not DONE", () => {
    expect(orderReading({ tracker: "PR #1607", facts: { kind: "pr", state: "closed", merged: false } })).toBe("ABANDONED");
  });

  test("an issue closed not_planned is ABANDONED, not DONE", () => {
    expect(orderReading({ tracker: "#999", facts: { kind: "issue", state: "closed", stateReason: "not_planned" } })).toBe("ABANDONED");
  });

  // Caught in review of #1740, and it is the same defect as the two above
  // with the default on the other side. `stateReason === "not_planned" ?
  // ABANDONED : DONE` FAILS OPEN: every reason the function does not know
  // about came out DONE, including `null`, which is what GitHub returns for
  // an issue closed before the field existed or by a client that does not
  // set it. A tick for a closure nobody confirmed as completion is exactly
  // the hallucinated reading this file exists to stop.
  //
  // Introspected rather than recalled — `IssueStateReason` on the live
  // schema is REOPENED, NOT_PLANNED, COMPLETED, DUPLICATE, and REST adds
  // `null`. So the set is closed today and will not stay closed, which is
  // why the default is UNMEASURED rather than a fifth named case.
  test("a closed issue is DONE only when GitHub says completed — everything else fails CLOSED", () => {
    const closed = (stateReason: string | null) =>
      orderReading({ tracker: "#999", facts: { kind: "issue", state: "closed", stateReason } });

    // The positive half, in the same row. Without it the cheapest wrong fix
    // — returning UNMEASURED for every closed issue — goes green.
    expect(closed("completed")).toBe("DONE");

    // Explicit non-completion. GitHub said the work did not happen.
    expect(closed("not_planned")).toBe("ABANDONED");
    expect(closed("duplicate")).toBe("ABANDONED");

    // Not a claim either way. `reopened` on a CLOSED issue is contradictory,
    // `null` is the field never having been set, and an unknown string is a
    // value this function was written before.
    expect(closed(null), "a null reason is the absence of a reason, not completion").toBe("UNMEASURED");
    expect(closed("reopened"), "reopened on a closed issue is a contradiction, not a tick").toBe("UNMEASURED");
    expect(closed("some_future_reason"), "a reason added after this code was written is not completion").toBe(
      "UNMEASURED",
    );
  });

  // Item 7 — "re-run the Stage B audit" — WAS completed, on 2026-11-03, and
  // printed blank for a day because it has no tracker object. Understating is
  // a real cost: Jason read the report and asked why finished work showed as
  // outstanding.
  //
  // The fix is NOT to tick it. This function's own docblock records what that
  // costs — on 2026-11-03 items 1 and 2 were reported ticked because a session
  // remembered them that way, while PROJECT-STATE.md said all three were
  // untouched. A fifth reading keeps the two apart: RECORDED means a human
  // wrote it down, DONE means the tracker was observed. They render
  // differently and only DONE is a tick.
  test("RECORDED is a fifth reading: written down, not observed", () => {
    expect(
      orderReading({ tracker: null, recordedDone: "project-state.json priorities[0], 2026-11-03 session 79" }),
    ).toBe("RECORDED");
  });

  test("RECORDED requires a citation — a bare flag is still UNMEASURED", () => {
    // The whole guard. `recordedDone: true` would make this reading reachable
    // by a session's memory, which is the 2026-11-03 defect with an extra
    // field. The evidence must be a non-empty string saying WHERE it is
    // written, so a reader can go and disagree.
    expect(orderReading({ tracker: null, recordedDone: "" })).toBe("UNMEASURED");
    expect(orderReading({ tracker: null, recordedDone: "   " })).toBe("UNMEASURED");
    expect(orderReading({ tracker: null, recordedDone: null })).toBe("UNMEASURED");
  });

  test("a tracker object always wins — RECORDED never overrides an observation", () => {
    // If the thing has an issue or a PR, the tracker is the answer and a note
    // in project-state.json does not get to contradict it. Otherwise a stale
    // hand-written line could tick an item whose PR is sitting open.
    expect(
      orderReading({
        tracker: "PR #1607",
        facts: { kind: "pr", state: "open", merged: false },
        recordedDone: "somebody wrote that this was finished",
      }),
    ).toBe("OPEN");
  });
});

describe("the script asks the dependencies endpoint, not a search qualifier", () => {
  const src = readFileSync(join(ROOT, "scripts/work-status.ts"), "utf-8");

  // Asserted rather than left as a comment. `-is:blocked` is honoured by
  // `gh issue list --search` and silently dropped by GraphQL `search` and
  // REST `/search/issues` — 33 against 77 on this repository, with no error
  // on either wrong path. The qualifier reaching this file again is that
  // 44-issue reading coming back.
  test("the blocked qualifier appears nowhere outside a comment", () => {
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    expect(code).not.toContain("is:blocked");
  });

  test("it reads blocked_by per issue", () => {
    expect(src).toContain("dependencies/blocked_by");
  });

  // An absent credential is UNMEASURED, not an empty reading
  // (`.claude/rules/config-access.md`).
  test("a missing token refuses rather than reporting an empty tracker", () => {
    // The message used to be asserted as the literal "no GITHUB_TOKEN", which
    // pinned the WRONG half: it bound the one variable name whose exclusivity
    // was the defect. The script read that name directly and refused on a
    // machine authenticated through `GH_TOKEN` — #139/#140 — so the case
    // guarding the refusal was also guarding the bug.
    //
    // What matters is that an absent credential is UNMEASURED and non-zero,
    // never an empty tracker reported as a reading.
    expect(src).toContain("UNMEASURED: no GitHub credential");
    expect(src).toContain("process.exit(2)");
    // And that it resolves through the one resolver, which accepts both names.
    expect(src).toContain("resolveGitHubToken()");
  });

  // Caught in review of #1740. Three list reads took one page each while
  // `boardStatus()` beside them paginated correctly, so at 84 open issues the
  // tail would have vanished with no truncation notice — a short list reads
  // as a smaller answer and is a wrong one. The population is asserted, not
  // the three sites, so a FOURTH list read added later is caught too
  // (`.claude/rules/checks-must-be-able-to-fail.md`, two deciders that agree).
  test("every list endpoint is read through the paginating helper", () => {
    for (const path of [
      "issues?state=all&milestone=*",
      "pulls?state=open",
      "issues?state=open",
    ]) {
      expect(src).toContain(`restAll(\`repos/\${REPO}/${path}`);
    }
    // the per-issue dependency read, interpolated number and all
    expect(src).toMatch(/restAll\(`repos\/\$\{REPO\}\/issues\/\$\{[^}]+\}\/dependencies\/blocked_by`\)/);
    // and nothing is left taking a single page: the only `rest(` calls that
    // remain fetch ONE object.
    expect(src.match(/await rest\(`[^`]+`\)/g) ?? []).toEqual([
      "await rest(`repos/${REPO}/issues/${num}`)",
      "await rest(`repos/${REPO}/pulls/${num}`)",
    ]);
  });

  test("the helper follows Link rel=next rather than stopping at one page", () => {
    expect(src).toContain('rel="next"');
  });

  // The REST half was fixed in round 2 and the GraphQL half was not, because
  // `timelineItems(first:20)` and `fieldValues(first:20)` were exempted by
  // reasoning — "sub-selections with hard upper bounds". Review found the
  // first at round 7 and the second at round 9, and the same exemption had
  // by then been written into #1747's BR-19 as well. That is four instances
  // of one shape in a day, every repair correct and every sweep prose.
  //
  // So the sweep is a census now: every `first:` in the file asks for a full
  // page AND declares a `pageInfo`, with no exemption for nesting. Comment
  // lines are stripped — this file's own prose names the numbers it rejects.
  test("every GraphQL list in the script declares its own truncation", () => {
    const code = src.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    const firsts = [...code.matchAll(/\bfirst:\s*(\d+)/g)].map(m => Number(m[1]));
    expect(firsts.length).toBeGreaterThanOrEqual(3);
    for (const n of firsts) expect(n, `a first:${n} asks for less than a page`).toBe(100);
    expect([...code.matchAll(/pageInfo\s*\{\s*hasNextPage/g)].length).toBe(firsts.length);
  });

  // And a truncated reading is reported as one, rather than becoming the
  // same `(no status)` an item with no Status field gets. Telling a reading
  // from an absence is this script's entire subject.
  test("a truncated field page is UNMEASURED, not the same as no status", () => {
    expect(src).toContain("(UNMEASURED — fields truncated)");
    expect(src).toContain("(no status)");
  });
});

/**
 * Moved here from `test/token-host-allowlist.test.ts` when #1740 was split.
 * All four read `scripts/work-status.ts`, so they are tests of the status
 * reader that happen to concern its token handling — not tests of the
 * allowlist library. Keeping them in the library suite is a large part of
 * what made the library and the tool inseparable in review.
 */
describe("the status reader does not leak the token on any hop", () => {
  const src = readFileSync(join(ROOT, "scripts/work-status.ts"), "utf-8");

  test("the paginating reader checks every hop before sending the token", () => {
    expect(src).toContain('assertTokenMayReach(next[1], \'Link rel="next"\'');
  });
  // The TOCTOU finding, as a case. Checking `r.url` after the fetch returns
  // is a log line, not a control: the request has been made and the token has
  // gone. The redirect must not be followed automatically at all.
  test("redirects are refused rather than followed, and the Location is checked", () => {
    expect(src).toContain('redirect: "manual"');
    expect(src).toContain('assertTokenMayReach(location, "Location header", target)');
    // **Exactly one `fetch(` in the file, and it is inside `send()`.**
    //
    // The first spelling of this allowed a carve-out: the GraphQL POST was
    // exempted on the reasoning that its URL is a literal we wrote and GitHub
    // does not redirect it. Review round 7 rejected that and was right twice
    // — the exemption was a sentence rather than a mechanism, and a literal
    // REQUEST url says nothing about where a 30x would send the token next.
    // An allowlist naming the exempt member proves only that somebody named
    // it. So the population is now asserted with no exemption at all.
    const fetches = [...src.matchAll(/\bfetch\(/g)];
    expect(fetches.length).toBe(1);
    expect(src).toMatch(/async function send\([\s\S]{0,400}?\bfetch\(/);
  });
  // Same population, second property. `rest()` and `restAll()` both refuse a
  // non-2xx before parsing; `gql()` did not, and a 401 or a 502 returns a
  // body with neither `data` nor `errors`, so it handed back `undefined`.
  // Asserted as "every reader of a Response checks ok" rather than against
  // the three that exist today.
  test("every response reader refuses a non-2xx before parsing it", () => {
    const readers = [...src.matchAll(/async function (rest|restAll|gql)\b[\s\S]*?\n\}/g)].map(m => [m[1], m[0]] as const);
    expect(readers.map(([n]) => n).sort()).toEqual(["gql", "rest", "restAll"]);
    for (const [name, body] of readers) {
      expect(body, `${name} parses a response without checking r.ok`).toMatch(/if \(!r\.ok\)/);
    }
  });
  test("the hop count is bounded", () => {
    expect(src).toMatch(/MAX_REDIRECTS\s*=\s*\d+/);
  });
});
