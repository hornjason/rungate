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
import ts from "typescript";
import { laneHealth, type LaneHealth, type LaneReading } from "../lib/board-lane-health";
import { structuralCut } from "../lib/source-slice";
import {
  NO_MILESTONE,
  isPickable,
  milestoneOf,
  ladderLines,
  ladderReport,
  milestoneRollup,
  netGrowthLine,
  readyRefusal,
  resolveFocus,
} from "../lib/work-status";

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

describe("#1984: the report reads the plan from project-state.json", () => {
  // A plan whose one finished stage owes a retro and whose next stage holds
  // one item a command can tick, one with no command, and one already done.
  // Membership, not a count: the two open items must print differently.
  const plan = (stages: unknown = [
    {
      id: "A", name: "Write it down", goal: "the documents exist", serves: 1, agreed: "2026-10-30 Jason",
      items: [{ id: "A1", what: "a thing", done: true, verify: "true" }],
      retro: null,
    },
    {
      id: "B", name: "Measure it", goal: "the board is a reading", serves: 1, agreed: "2026-10-30 Jason",
      items: [
        { id: "B1", what: "a reading with a command", done: false, verify: "bun test test/x.test.ts" },
        { id: "B2", what: "a reading nobody can run", done: false, verify: null },
        { id: "B3", what: "a reading already true", done: true, verify: "true" },
      ],
      retro: null,
    },
  ]) =>
    JSON.stringify({
      goal: { statement: "x", verify: "true" },
      goals: [{ id: 1, goal: "g", doneWhen: "d" }],
      stages,
    });

  test("an item with a command is OPEN and one with verify: null is UNVERIFIABLE", () => {
    const r = ladderReport(plan(), "project-state.json");
    expect(r.kind).toBe("READ");
    if (r.kind !== "READ") return;
    expect(r.open.map(o => [o.id, o.reading])).toEqual([["B1", "OPEN"], ["B2", "UNVERIFIABLE"]]);
    const lines = ladderLines(r);
    const b1 = lines.find(l => l.includes("B1"));
    const b2 = lines.find(l => l.includes("B2"));
    expect(b1).toContain("OPEN");
    expect(b1).not.toContain("UNVERIFIABLE");
    expect(b2).toContain("UNVERIFIABLE");
    expect(lines.some(l => l.includes("B3"))).toBe(false);
  });

  test("the next stage and every retro owed are printed", () => {
    const r = ladderReport(plan(), "project-state.json");
    const text = ladderLines(r).join("\n");
    expect(text).toContain("Next stage: B");
    expect(text).toContain("Retros owed: A");
    // nextStage's own blocker, verbatim: the retro debt on A gates B.
    expect(text).toContain("stage A is complete and has no retro");
  });

  test("no stages key is UNMEASURED, by name, and prints no open-item list", () => {
    // Written out, not `plan(undefined)`: a default parameter would put the stages back.
    const noStages = JSON.stringify({ goal: { statement: "x", verify: "true" }, goals: [{ id: 1, goal: "g", doneWhen: "d" }] });
    const r = ladderReport(noStages, "project-state.json");
    expect(r.kind).toBe("UNMEASURED");
    const text = ladderLines(r).join("\n");
    expect(text).toContain("UNMEASURED");
    expect(text).toContain("stages");
    expect(text).not.toContain("Open items");
  });

  test("an absent file and an unparseable file are UNMEASURED for different reasons", () => {
    const absent = ladderReport(null, "project-state.json");
    const broken = ladderReport("{ not json", "project-state.json");
    expect(absent.kind).toBe("UNMEASURED");
    expect(broken.kind).toBe("UNMEASURED");
    if (absent.kind !== "UNMEASURED" || broken.kind !== "UNMEASURED") return;
    expect(absent.why).toContain("could not be read");
    expect(broken.why).toContain("not valid JSON");
    expect(ladderLines(absent).join("\n")).not.toContain("Open items");
  });

  test("item text reaches the terminal with control characters removed", () => {
    const stages = [{
      id: "A", name: "Measure it", goal: "g", serves: 1, agreed: "2026-10-30 Jason",
      items: [{ id: "A1", what: "real\u001b[2K\u001b[1AOPEN fake row", done: false, verify: null }],
      retro: null,
    }];
    const lines = ladderLines(ladderReport(plan(stages), "project-state.json"));
    for (const l of lines) expect(l).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(lines.find(l => l.includes("A1"))).toContain("UNVERIFIABLE");
  });

  test("the script reads the plan through these two functions, and the hand-typed list is gone", () => {
    const script = readFileSync(join(ROOT, "scripts", "work-status.ts"), "utf-8");
    expect(script).toMatch(/\bladderReport\(/);
    expect(script).toMatch(/\bladderLines\(/);
    expect(script).toMatch(/project-state\.json/);
    expect(script, "the hand-typed ORDER array must be deleted, not kept beside the reading").not.toMatch(
      /\bconst ORDER\b/,
    );
    expect(script).not.toMatch(/\borderReading\b/);
    // An unreadable plan must print UNMEASURED, not throw past the report: the
    // read sits in a try, and no existence pre-check races it.
    expect(script).toMatch(/try \{\n\s*planSource = readFileSync\(STATE_FILE/);
    expect(script).not.toMatch(/existsSync\(STATE_FILE\)/);
  });

  test("the live plan reads, so the report is not UNMEASURED on this tree", () => {
    const r = ladderReport(readFileSync(join(ROOT, "project-state.json"), "utf-8"), "project-state.json");
    expect(r.kind, r.kind === "UNMEASURED" ? r.why : "").toBe("READ");
  });
});

describe("the report covers every lane, and can be pointed at one", () => {
  // THE DEFECT THESE EXIST FOR WAS A CONSTANT. `scripts/work-status.ts` read
  // `const MILESTONE = "Issue intake"`, and on 2026-11-06 that milestone held
  // 1 open issue of the repository's 82. Eight Convergence lanes, nine
  // Pipeline lanes and 26 issues with NO milestone were absent from the
  // report the status was read from. Nothing was forgotten; the instrument
  // was narrower than the work.
  const iss = (
    n: number,
    state: string,
    milestone: string | null,
    assignees: unknown[] = [],
    blockers: { state: string }[] = [],
    // **Defaulted to null, never to "completed".** A default of completed
    // would let every closed fixture count as done without saying so, which
    // is the fixture choosing the answer to the question under test.
    state_reason: string | null = null,
  ) => ({
    number: n,
    state,
    milestone: milestone === null ? null : { title: milestone },
    assignees,
    blockers,
    state_reason,
  });

  test("an issue with no milestone lands in a named lane, not in nothing", () => {
    // 26 of 82 on the day this was written. A rollup that drops them loses
    // the largest group it has, and loses it SILENTLY — the table still adds
    // up, against a smaller population.
    expect(milestoneOf(iss(1, "open", null))).toBe(NO_MILESTONE);
    expect(milestoneOf(iss(1, "open", ""))).toBe(NO_MILESTONE);
    expect(milestoneOf(iss(1, "open", "   "))).toBe(NO_MILESTONE);
    expect(milestoneOf(iss(1, "open", "Phase 2"))).toBe("Phase 2");
  });

  test("the rollup counts open, claimed, blocked, pickable, done and dropped apart", () => {
    const rows = milestoneRollup([
      iss(1, "open", "A"), //                                      pickable
      iss(2, "open", "A", ["me"]), //                               claimed
      iss(3, "open", "A", [], [{ state: "open" }]), //              blocked
      iss(4, "open", "A", [], [{ state: "closed" }]), //            pickable: a closed blocker does not block
      iss(5, "closed", "A", [], [], "completed"), //                done
      iss(6, "open", null), //                                      the unmilestoned lane
    ]);
    const a = rows.find(r => r.milestone === "A")!;
    expect(a).toEqual({
      milestone: "A",
      open: 4,
      done: 1,
      dropped: 0,
      claimed: 1,
      blocked: 1,
      pickable: 2,
    });
    expect(rows.find(r => r.milestone === NO_MILESTONE)!.open).toBe(1);
  });

  test("CLOSED IS NOT DONE — only `completed` counts as done", () => {
    // `orderReading` three functions up exists entirely to stop this
    // conflation, and the first version of the rollup reintroduced it one
    // table later: it printed `closed` under a header reading `done`, so a
    // lane that abandoned four of ten closures reported ten completed.
    // Caught by the AI review of #1825.
    //
    // CLOSED FAILS CLOSED, the same direction orderReading takes it: `null`
    // is the absence of a reason, not a completion, and a reason added to
    // GitHub after this was written must not arrive pre-counted as done.
    const rows = milestoneRollup([
      iss(1, "closed", "A", [], [], "completed"),
      iss(2, "closed", "A", [], [], "not_planned"),
      iss(3, "closed", "A", [], [], "duplicate"),
      iss(4, "closed", "A", [], [], null),
      iss(5, "closed", "A", [], [], "a_reason_invented_in_2027"),
    ]);
    const a = rows.find(r => r.milestone === "A")!;
    expect(a.done, "only the `completed` closure is done").toBe(1);
    expect(a.dropped, "the other four are closed and were not completed").toBe(4);
  });

  test("a pull request is not an issue — /issues returns both", () => {
    // A PR counted as an issue inflates every lane it lands in, and the
    // endpoint hands them over in the same array with no flag the caller is
    // forced to read.
    const rows = milestoneRollup([
      iss(1, "open", "A"),
      { ...iss(2, "open", "A"), pull_request: { url: "…" } },
    ]);
    expect(rows.find(r => r.milestone === "A")!.open).toBe(1);
  });

  test("lanes sort by open work, so the biggest pile is read first", () => {
    const rows = milestoneRollup([
      iss(1, "open", "small"),
      iss(2, "open", "big"),
      iss(3, "open", "big"),
      iss(4, "open", null),
    ]);
    expect(rows.map(r => r.milestone)).toEqual(["big", NO_MILESTONE, "small"]);
  });

  test("absent focus is EVERY lane — the hardcoded default is gone", () => {
    expect(resolveFocus(undefined, ["A", "B"])).toEqual({ kind: "all" });
    expect(resolveFocus("all", ["A", "B"])).toEqual({ kind: "all" });
  });

  test("`--milestone` with no value is a MISTAKE, not a default", () => {
    // Absent and present-and-empty were one branch, so `--milestone` typed
    // as the last argument printed the unpinned report and read as if the
    // pin had been honoured — the same Silent Default Substitution the
    // unknown-name refusal exists to stop, reached by a shorter route.
    // Caught by the AI review of #1825.
    for (const empty of ["", "   "]) {
      const r = resolveFocus(empty, ["A", "B"]);
      expect(r.kind, `--milestone ${JSON.stringify(empty)} must refuse`).toBe("unknown");
      expect(r.kind === "unknown" && r.known).toEqual(["A", "B"]);
    }
  });

  test("the unmilestoned lane is reachable by both of its names", () => {
    // `none` to type, and the rendered label so a reader can copy it out of
    // the table and pass it straight back.
    expect(resolveFocus("none", ["A"])).toEqual({ kind: "one", title: NO_MILESTONE });
    expect(resolveFocus(NO_MILESTONE, ["A"])).toEqual({ kind: "one", title: NO_MILESTONE });
  });

  test("a REAL milestone named `all` or `none` beats the keyword", () => {
    // GitHub milestone titles are free text, so both names are legal. The
    // keywords were checked first, so a milestone actually titled `none`
    // could never be selected: the keyword answered, the real lane was never
    // consulted, and the unmilestoned issues were shown in its place with no
    // error. Caught by the AI review of #1825.
    expect(resolveFocus("none", ["none", "A"])).toEqual({ kind: "one", title: "none" });
    expect(resolveFocus("all", ["all", "A"])).toEqual({ kind: "one", title: "all" });

    // And the keywords still work wherever no such milestone exists, which
    // is every repository but the unlucky one.
    expect(resolveFocus("none", ["A"])).toEqual({ kind: "one", title: NO_MILESTONE });
    expect(resolveFocus("all", ["A"])).toEqual({ kind: "all" });
  });

  test("a milestone that does not exist is REFUSED, and says what does", () => {
    // THE WHOLE REASON THIS IS A FUNCTION. A focus that selects zero issues
    // prints a correct-looking report with an empty body, and then a typo is
    // indistinguishable from a milestone whose work is finished — Silent
    // Default Substitution, in the tool whose entire purpose is that the
    // status is not hallucinated.
    const r = resolveFocus("Issue Intake", ["Issue intake", "Convergence Phase 2"]);
    expect(r.kind).toBe("unknown");
    expect(r.kind === "unknown" && r.asked).toBe("Issue Intake");
    // Sorted, and complete — a refusal that does not say what WAS available
    // is a refusal nobody can act on.
    expect(r.kind === "unknown" && r.known).toEqual(["Convergence Phase 2", "Issue intake"]);
  });

  test("the script no longer carries a milestone constant", () => {
    const src = readFileSync(join(ROOT, "scripts", "work-status.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    expect(
      code,
      "a hardcoded milestone is what made 81 of 82 issues invisible — the " +
        "focus comes from --milestone and defaults to every lane",
    ).not.toMatch(/const MILESTONE\s*=/);
    expect(code, "the flag must actually be read").toContain('"--milestone"');
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
    // DERIVED FROM THE SOURCE, NOT A LIST OF THREE. This named the three
    // paths as literals, which made it a thing to edit whenever a query
    // changed rather than a thing that could be wrong: widening the
    // milestone read from `issues?state=all&milestone=*` to `issues?state=all`
    // turned it red for a reason that had nothing to do with pagination.
    //
    // A query string is what makes a path a LIST. Every one of them must go
    // through the paginating helper, and the population is whatever the file
    // contains today — so a fourth list read added later is caught without
    // anybody remembering to add a row.
    const listCalls = [...src.matchAll(/(\w+)\(`repos\/\$\{REPO\}\/([^`]*\?[^`]*)`/g)];
    expect(
      listCalls.length,
      "no paginated list read was found at all — either the file stopped " +
        "reading lists, or the spelling changed and this assertion is now " +
        "vacuous, and those are not the same thing",
    ).toBeGreaterThan(0);
    expect(
      listCalls.filter(m => m[1] !== "restAll").map(m => `${m[1]}(… ${m[2]})`),
      "a query string makes a path a list, and a single-page read of a list " +
        "silently returns a smaller answer that looks like a correct one",
    ).toEqual([]);
    // the per-issue dependency read, interpolated number and all
    expect(src).toMatch(/restAll\(`repos\/\$\{REPO\}\/issues\/\$\{[^}]+\}\/dependencies\/blocked_by`\)/);
    // and nothing is left taking a single page. The two single-object reads
    // that used to sit here served the hand-typed agreed order, deleted by
    // #1984; `rest()` stays as the guarded single-object reader.
    expect(src.match(/await rest\(`[^`]+`\)/g) ?? []).toEqual([]);
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
describe("SC-2731: a reading is UNMEASURED only when its OWN source failed", () => {
  const code = readFileSync(join(ROOT, "scripts/work-status.ts"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  // The Cancelled denominator moved from the repo-wide closed-issue pass
  // to the board traversal, and its null-guard was left pointing at the
  // old source. A throttled throughput pass would have blanked a count
  // boardStatus() had already read, reporting the lane UNMEASURED when it
  // was measured. ai-review round 1 of #1802.
  test("the board-scoped cancelled count is not gated on the throughput pass", () => {
    const line = code.split("\n").find(l => l.includes("const cancelledClosed"))!;
    expect(line, "the assignment moved out of the script").toBeDefined();
    expect(
      line,
      "cancelledClosed comes from boardStatus(), so gating it on the closed-issue pass makes " +
        "an unrelated failure blank a reading that succeeded",
    ).not.toContain("closedReadings");
    expect(line).toContain("abandonedOnBoard");
  });

  // The message named two readings and now feeds one. A refusal naming
  // the wrong reading sends whoever reads the log to the wrong pass.
  test("the closed-issue failure message claims only what that pass feeds", () => {
    const msg = code.split("\n").find(l => l.includes("the closed-issue pass failed"))!;
    expect(msg).toBeDefined();
    expect(msg, "this pass no longer feeds the cancelled count").not.toContain("cancelled count");
    expect(msg).toContain("depth");
  });
});

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
    // **Comments stripped first.** The `{0,400}` below is a proxy for "inside
    // `send()`", and measured against raw source it counts COMMENT
    // characters — so adding a docblock to the function moves it past the
    // window and the row goes red against code that did not change. That is
    // exactly what happened: an eight-line comment naming `hop === 0` pushed
    // the distance from 203 characters of code to 739 of source, and this row
    // was the only red in CI on a commit whose behaviour was identical.
    // `.claude/rules/self-referential-tests.md` — a detector that reads a
    // whole file reads its comments. Counting `fetch(` on the stripped text
    // is the same correction: one written inside a comment is not a call.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    const fetches = [...code.matchAll(/\bfetch\(/g)];
    expect(fetches.length).toBe(1);
    expect(code).toMatch(/async function send\([\s\S]{0,400}?\bfetch\(/);
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

  // Caught in review of #1740. A 3xx whose body is never read holds its
  // socket out of the connection pool, and this script is nothing but
  // sequential requests — one dependency call and one timeline page per open
  // issue, ~80 of each.
  //
  // The first version of this row said the redirect branch was "the only place
  // a response is discarded without being parsed, so it is the only place that
  // needs this". **That sentence was false, and review of #1740 said so:** the
  // four `throw` paths — the missing `Location`, and the `!r.ok` in `rest()`,
  // `restAll()` and `gql()` — each abandon a Response with its body untouched,
  // which is the identical defect. Fixing the one site that was reported and
  // writing a row shaped around it is how a population becomes four rounds.
  test("a redirect's body is released before the next hop", () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    // Anti-vacuity: the hop loop must still be here for the row to mean
    // anything. Zero matches is a renamed helper, not a satisfied property.
    expect(
      (code.match(/redirect:\s*"manual"/g) ?? []).length,
      "expected the one manual-redirect fetch in send(); see the comment above",
    ).toBe(1);
    expect(
      code,
      "the redirect branch must release the response before re-fetching — " +
        "an unconsumed body keeps its socket out of the pool",
    ).toMatch(/r\.body\?\.cancel\(\)/);
  });

  // Caught in review of #1740. Two GraphQL queries spelled the owner and the
  // repository as string literals while every REST path in the file was built
  // from `REPO`. That is two deciders over one fact: after a rename — this
  // repository was `hornjason/pai-harness` until 2026-10-28 — the REST reads
  // follow the constant and these two keep pointing at the old name, and
  // GitHub's redirect means they keep WORKING, against the wrong repository.
  // A status tool reading two repositories and printing one table is the
  // failure this file exists to stop.
  test("the repository is named once — no query spells the owner itself", () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

    // Anti-vacuity: the constant must exist and must be the thing the count
    // below is counting. Without this the assertion passes on a file that
    // renamed REPO away entirely.
    expect(code, "scripts/work-status.ts must declare REPO").toMatch(
      /const REPO = "hornjason\/rungate";/,
    );

    for (const word of ["hornjason", "rungate"]) {
      expect(
        (code.match(new RegExp(word, "g")) ?? []).length,
        `"${word}" must appear exactly once in scripts/work-status.ts — inside ` +
          `REPO. A query that spells it again is a second decider over which ` +
          `repository this tool reports on, and a rename moves only one of them.`,
      ).toBe(1);
    }
  });

  // The population the row above was too narrow to cover. Every abandonment of
  // a Response goes through `releaseAndThrow`, so there is one binding to
  // mutate rather than five sites to remember.
  test("every path that abandons a response releases it — the whole population", () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

    // Anti-vacuity. Four throw sites abandon a Response in this file: the
    // absent `Location`, and `!r.ok` in rest(), restAll() and gql(). A fifth
    // arriving must come through the helper too; zero means it was renamed and
    // the assertion below is ranging over nothing.
    expect(
      (code.match(/releaseAndThrow\(/g) ?? []).length,
      "expected one definition plus four call sites of `releaseAndThrow` in " +
        "scripts/work-status.ts — the four places a Response is thrown away.",
    ).toBe(5);

    // The defect, as source: a bare throw that still holds the response.
    const bare = [...code.matchAll(/^\s*(?:if \([^)]*\) )?throw new Error\(`\$\{r\.status\}/gm)];
    expect(
      bare.map(m => m[0].trim()),
      "a `throw` that names `r.status` is abandoning a Response — route it " +
        "through `releaseAndThrow(r, ...)` so the socket returns to the pool. " +
        "An unconsumed body leaks a connection on every error response, which " +
        "is the same defect the redirect hop above was fixed for.",
    ).toEqual([]);
  });
});

// ── #1842: one startable list, and a lane that refuses when it runs dry ──

describe("#1842: the report offers one startable list and it is Ready", () => {
  const src = readFileSync(join(ROOT, "scripts/work-status.ts"), "utf-8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  test("the startable heading names Ready, and the candidate heading disowns itself", () => {
    expect(code).toContain("START HERE — the Ready lane");
    expect(code).toContain("PROMOTION CANDIDATES");
    expect(code).toContain("NOT work to start");
  });

  test("no heading still presents the repo-wide set as pickable work", () => {
    // The old heading was `PICKABLE — computed per issue …`, printed above a
    // list of 36 while Ready held one. A reader could not tell which to
    // start from, and chose the longer list.
    expect(
      code,
      "a heading that reads as an instruction to pick is what this change removed",
    ).not.toMatch(/bar\(\s*"PICKABLE/);
  });

  test("the Ready list is read from the board, not re-derived from the candidates", () => {
    // Two deciders otherwise: a board whose Ready column disagreed with the
    // rule would print as agreeing, which is the defect being fixed.
    expect(code).toContain('status.get(i.number) === "Ready"');
  });

  test("an empty Ready lane says so instead of printing nothing", () => {
    expect(code).toContain("NOTHING IS READY");
  });
});

describe("#1842: a short Ready lane refuses", () => {
  const src = readFileSync(join(ROOT, "scripts/work-status.ts"), "utf-8");

  const lane = (health: LaneHealth, count = 1, against: number | null = 3): LaneReading[] => [
    { lane: "Backlog", count: 76, against: null, health: "NO_TARGET", why: "no second source" },
    { lane: "Ready", count, against, health, why: `${against} allowed in the queue` },
    { lane: "In progress", count: 1, against: 1, health: "OK", why: "one open and assigned" },
  ];

  test("SHORT refuses and carries the numbers a reader needs", () => {
    const r = readyRefusal(lane("SHORT", 1, 3), 1, 0);
    expect(r?.verdict).toBe("REFUSE");
    expect(r!.count).toBe(1);
    expect(r!.against).toBe(3);
    expect(r!.why).toContain("allowed in the queue");
  });

  // THE BOUNDARY THIS GATE EXISTS FOR, and the first version of it passed.
  //
  // `laneHealth` returns UNWRITTEN, not SHORT, when `count === 0` and the
  // denominator is positive — so the SHORT branch is UNREACHABLE at zero and
  // a gate keyed on SHORT alone exits 0 on a completely empty Ready lane.
  // The control first written here asserted that pass as correct, which
  // would have certified the bypass at the moment it arrived.
  //
  // Found by the automated security review of the pushed commit, not by the
  // mutation battery: the battery varied the health VALUE and never asked
  // which value the producer emits at the boundary.
  test("an EMPTY Ready lane refuses — it is UNWRITTEN, not SHORT", () => {
    expect(readyRefusal(lane("UNWRITTEN", 0, 3), 0, 0)?.verdict).toBe("REFUSE");
  });

  test("the producer really does emit UNWRITTEN at zero, so the case above is not hypothetical", () => {
    // Asserted against `laneHealth` itself rather than described, or this
    // whole section rests on a reading of the source that nothing re-takes.
    const readings = laneHealth({
      counts: new Map([["Ready", 0]]),
      pickable: 9,
      openAssigned: 0,
      cancelledClosed: 0,
      throughput: { delivered: 84, days: 14 },
      complete: true,
    });
    const ready = readings.find(r => r.lane === "Ready");
    expect(ready?.count).toBe(0);
    expect(ready?.against ?? 0).toBeGreaterThan(0);
    expect(ready?.health, "if this is ever SHORT, the case above stops testing the boundary")
      .toBe("UNWRITTEN");
    expect(readyRefusal(readings, 0, 0)?.verdict).toBe("REFUSE");
  });

  // THE SECOND BYPASS, found by the security review of the pushed commit.
  //
  // The lane's own count is every board item in the column, closed ones
  // included. A Ready holding three CLOSED cards read `3 of 3 OK` while the
  // startable list printed nothing — the gate passed with no work to start,
  // which is the state it exists to catch. Two numbers for one question, on
  // one page, disagreeing.
  test("a Ready lane full of CLOSED cards refuses, however healthy the lane count looks", () => {
    const r = readyRefusal(lane("OK", 3, 3), 0, 0);
    expect(r?.verdict).toBe("REFUSE");
    expect(r!.count, "the refusal reports what can be STARTED, not what is parked").toBe(0);
    expect(r!.why).toContain("not an open issue");
  });

  test("and it names how many are stale rather than silently subtracting them", () => {
    // A gate that quietly corrects for closed cards hides the board defect
    // somebody has to clear.
    expect(readyRefusal(lane("OK", 3, 3), 1, 0)!.why).toContain("2 of the 3 card(s)");
  });

  test("THE CONTROL: a lane at depth does not refuse", () => {
    // Without this the refusal fires on everyone, which reviews nothing and
    // teaches people to ignore the exit code.
    expect(readyRefusal(lane("OK", 3, 3), 3, 0)).toBeNull();
  });

  test("NO_TARGET is not a refusal — there is nothing it could be short OF", () => {
    expect(readyRefusal(lane("NO_TARGET", 1, null), 1, 0)).toBeNull();
  });

  test("UNMEASURED is its own verdict, never silence", () => {
    // Returning null here would make "the census failed" and "the lane is
    // fine" the same bytes, which is the confusion this report exists to end.
    expect(readyRefusal(lane("UNMEASURED", 0, null), 0, 0)?.verdict).toBe("UNMEASURED");
  });

  test("a board with no Ready row is UNMEASURED, not fine", () => {
    const r = readyRefusal(lane("SHORT").filter(x => x.lane !== "Ready"), 1, 0);
    expect(r?.verdict).toBe("UNMEASURED");
    expect(r!.why).toContain("no Ready lane");
  });

  test("every LaneHealth is classified, and the three outcomes are disjoint", () => {
    const expected: Record<LaneHealth, "REFUSE" | "UNMEASURED" | "fine"> = {
      SHORT: "REFUSE",
      UNWRITTEN: "REFUSE",
      UNMEASURED: "UNMEASURED",
      OK: "fine",
      OVER: "fine",
      NO_TARGET: "fine",
    };
    // Each row carries the shape the PRODUCER emits for that health, not a
    // uniform fixture: NO_TARGET and UNMEASURED always have a null
    // denominator, and a row claiming otherwise would test an input
    // `laneHealth` cannot return.
    const shape: Record<LaneHealth, [count: number, against: number | null, open: number]> = {
      SHORT: [1, 3, 1],
      UNWRITTEN: [0, 3, 0],
      UNMEASURED: [0, null, 0],
      NO_TARGET: [1, null, 1],
      OK: [3, 3, 3],
      OVER: [5, 3, 5],
    };
    for (const [health, want] of Object.entries(expected) as [LaneHealth, string][]) {
      const [count, against, open] = shape[health];
      const got = readyRefusal(lane(health, count, against), open, 0)?.verdict ?? "fine";
      expect(got, `${health} must be ${want}`).toBe(want);
    }
    // The population is the producer's own, so a seventh member cannot be
    // added without this going red — a default-to-fine arm is how UNWRITTEN
    // bypassed the gate the first time.
    const src = readFileSync(join(ROOT, "lib/board-lane-health.ts"), "utf-8");
    const declared = src
      .slice(src.indexOf("export type LaneHealth ="))
      .slice(0, src.slice(src.indexOf("export type LaneHealth =")).indexOf(";"))
      .match(/"([A-Z_]+)"/g)!
      .map(s => s.replaceAll('"', ""));
    expect([...declared].sort()).toEqual(Object.keys(expected).sort());
  });

  test("the exit code is routed through ONE constant, so a mutation has one site", () => {
    // A later branch inlining `process.exit(3)` would bypass the mutation
    // and its case would go green having witnessed nothing —
    // `.claude/rules/checks-must-be-able-to-fail.md`.
    for (const name of ["EXIT_READY_SHORT", "EXIT_READY_UNMEASURED"]) {
      const uses = src.match(new RegExp(name, "g")) ?? [];
      expect(uses.length, `${name}: declaration plus exactly one use`).toBe(2);
    }
    // All four outcomes this script can reach are distinguishable: 0, the
    // argument refusals' 2, a drained lane, and a reading that failed.
    const codes = [...src.matchAll(/export const EXIT_READY_\w+ = (\d+);/g)].map(m => Number(m[1]));
    expect(codes).toHaveLength(2);
    expect(new Set([0, 2, ...codes]).size, "a shared code makes two mechanisms one signal").toBe(4);
    // Read from source, not imported: the script runs on import and would
    // start reaching for a token and the network.
    const declared = src.match(/export const EXIT_READY_SHORT = (\d+);/);
    expect(declared, "the constant must be declared on one line").not.toBeNull();
    const value = Number(declared![1]);
    expect(value, "a zero here is the mutation, not the shipped value").toBeGreaterThan(0);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    expect(code, "a literal would bypass the mutation").not.toMatch(
      new RegExp(`process\\.exit\\(\\s*${value}\\s*\\)`),
    );
    // And the code is SPECIFIC to this mechanism. The script already exits 2
    // when its arguments refuse; sharing that code would make a drained lane
    // and a typo'd flag the same observable, so no assertion on either could
    // say which one it witnessed.
    expect(code, "the argument refusals must keep their own code").toContain("process.exit(2)");
    expect(value, "sharing exit 2 would make two mechanisms one signal").not.toBe(2);
  });

  test("the script restates the decider's answer and spells no condition of its own", () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    expect(code).toContain("readyRefusal(laneReadings, readyNow.length, readyUnseen)");
    // The gate judges the same number the page printed as startable. Any
    // other count here lets the report disagree with itself in one page.
    expect(code, "the gate must not re-derive its own Ready count").toMatch(
      /readyRefusal\(laneReadings, readyNow\.length, readyUnseen\)/,
    );
    // **And the third argument has to be the lane's unseen cards, read from
    // the same board pass.** Every case below hands `readyRefusal` its
    // populations by hand, so none of them can say what the PRODUCER passes —
    // which is how the gate came to judge an issues-only count against a
    // contract that says "every card in the lane" (ai-review round 1 of
    // #1857). This is the only instrument in the file that looks at the
    // wiring, so it names the binding rather than a shape.
    expect(
      code,
      "`readyUnseen` must come from the board reading's own unseen-by-lane map; a literal " +
        "or a re-count would be a second population one edit from drifting",
    ).toContain('const readyUnseen = unseenByLane.get("Ready") ?? 0;');
    expect(
      code.match(/const readyUnseen\s*=/g) ?? [],
      "exactly one binding, so there is one site to mutate",
    ).toHaveLength(1);
    expect(code, "a second condition here would be a second decider").not.toMatch(
      /health\s*===\s*"SHORT"/,
    );
  });
});

describe("#1842 G5: the report says what its reading could not see", () => {
  const src = readFileSync(join(ROOT, "scripts/work-status.ts"), "utf-8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  test("a non-Issue card is counted against its lane BEFORE the skip", () => {
    // Every reading below keys on an issue number, so a draft is invisible
    // to all of them. The `continue` that drops it is the only point in the
    // whole report where its existence is observable at all — counting
    // after it would count nothing.
    const skip = code.indexOf('n.content?.__typename !== "Issue"');
    const count = code.indexOf("unseenByLane.set");
    const bail = code.indexOf("continue;", skip);
    expect(skip, "the non-Issue branch must still exist").toBeGreaterThan(-1);
    expect(count, "the count must be inside that branch").toBeGreaterThan(skip);
    expect(count, "and before the continue, or it never runs").toBeLessThan(bail);
  });

  test("the count reaches the Ready section and names the consequence", () => {
    expect(code).toContain('unseenByLane.get("Ready")');
    expect(code).toContain("NOT SHOWN");
    // A number with no consequence attached is a number nobody acts on.
    expect(code).toContain("holding a");
  });

  test("a lane with nothing hidden prints nothing — silence is the common case", () => {
    expect(code, "an unconditional line would appear on every clean board").toMatch(
      /readyUnseen > 0/,
    );
  });

  test("boardStatus returns the per-lane count, so it is not re-derived downstream", () => {
    expect(code).toContain("unseenByLane: Map<string, number>");
    expect(code).toContain("return { statuses: out, abandonedOnBoard, unseenByLane };");
  });
});

/**
 * #1853 H4: the report names how many candidates nothing can rank.
 *
 * Measured 2026-11-06: 38 promotion candidates, 28 of them printed under one
 * `(no milestone)` heading. All 28 ranked `POSITIVE_INFINITY` in `readyOrder`
 * and fell through to the issue-number tiebreak, so **the lane was ordered by
 * age** and this report said nothing about it. Nine of the 28 carried no
 * rankable label either — UNPLACED — and read exactly like an issue ranked
 * last, which is the distinction every row in BOARD LANE HEALTH exists to
 * keep.
 *
 * Asserted on the source, like the G5 block above: the printing happens after
 * three network reads, and the shape of the report is the thing that
 * regresses. The RULE these lines call is covered behaviourally in
 * `test/board-ready-rule.test.ts`.
 */
describe("#1853 H4: the candidate list says how many are UNPLACED", () => {
  const src = readFileSync(join(ROOT, "scripts/work-status.ts"), "utf-8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  test("the census comes from the shared rule, not from a count written here", () => {
    // Two deciders that agree are behaviourally one. If this file counted
    // tiers itself, a mutation of `placementOf` would leave the report
    // agreeing with a writer that had changed underneath it.
    expect(code, "placementCensus is the one reading").toContain("placementCensus(");
    expect(
      code.match(/tier\s*===\s*"(PHASE|LABEL)"/g),
      "the report must not re-derive the placed tiers — that is a second decider",
    ).toBeNull();
  });

  test("UNPLACED is printed as its own number, beside the placed tiers", () => {
    expect(code).toContain("UNPLACED ${census.unplaced}");
    expect(code, "a bare count is a number nobody can act on — it must name the issues").toContain(
      'tier === "UNPLACED"',
    );
  });

  test("the UNPLACED line is conditional — a fully placed board prints nothing", () => {
    expect(
      code,
      "an unconditional line would appear on every clean board and stop being read",
    ).toMatch(/if\s*\(census\.unplaced\s*>\s*0\)/);
  });

  test("SC-2741: the report lists only what Ready would pull, from the one scope", () => {
    // The label rank this row used to assert is deleted. The report now takes
    // the writers' scope, so its "next" list is what the writer would pull.
    expect(code, "the report must not cite a label rank that no longer exists").not.toContain("LABEL_RANK");
    expect(code).toContain("activeMilestone(");
    expect(code).toContain("scopedCandidates(candidateRankables, active, workNext.honoured)");
    expect(code, "the next list must come from the in-scope set").toContain("[...scoped.inScope].sort(");
  });

  test("the candidates are sorted with readyOrder, so the report shows plan order", () => {
    expect(code, "sorting by anything else makes this list disagree with the writer").toContain(
      ".sort(readyOrderFor(",
    );
    // **And with the CONFIGURED prefix, not a literal** (#1943). The
    // comparator takes the engine milestone family, and a report that
    // handed it `null` would order `Convergence Phase 3` above `Pipeline
    // Phase 6` again while this row stayed green on the call shape alone.
    expect(
      code,
      "the report resolves the engine family from config — a literal here is the second " +
        "spelling lib/config-readers.ts exists to prevent",
    ).toContain("enginePrefixReading(process.cwd())");
    // **And with the promotion set, not `NO_WORK_NEXT`** (#1962). Passing
    // the empty set compiles, orders correctly, and silently turns the
    // `work-this-next` lever off in this report alone — so the shape of the
    // call is asserted, not just its name.
    expect(
      code,
      "the report must sort with the promotion reading it just took, or the lever is on " +
        "for the writer and off for the report that is supposed to explain it",
    ).toContain(".sort(readyOrderFor(enginePrefix, workNext.honoured))");

    // #1965 round 2: and it must SURFACE the reading, not just take it. A
    // `null` prefix is the pre-#1943 ordering, so a config the script could
    // not find has to reach the operator rather than quietly reverting the
    // fix. Reading the value and dropping the warning is exactly the state
    // the review found.
    expect(
      code,
      "the script takes the reading and never prints it — an unfindable config reverts " +
        "the ordering in silence",
    ).toContain("engine.unmeasured");
  });
});

/**
 * #1852: the gate refuses a WEDGED lane, and does not do its own subtraction.
 *
 * `readyRefusal` spelled `ready.count - openInReady` itself, which made it
 * the second place deciding how full Ready is. On 2026-11-07 the two
 * disagreed in production — the writer said `2 of 2, full` over every card
 * while this said `1 of 2, SHORT` over open issues — and no single site a
 * mutation could move said which was right.
 */
describe("#1852: the Ready gate reads one occupancy", () => {
  const laneAt = (health: string, count: number, against: number | null) =>
    [
      {
        lane: "Ready",
        count,
        against,
        health: health as never,
        why: `${against} allowed in the queue`,
      },
    ] as const;

  // **A wedged lane was already refused, for the wrong reason.** The first
  // draft of this added `if (occ.verdict === "WEDGED") return REFUSE` and a
  // mutation of that line reddened NOTHING: for any `against > 0`,
  // `openInReady < against` is already true whenever nothing is startable,
  // and for `against === 0` nothing is eligible and refusing would be wrong.
  // The branch was dead the day it was written —
  // `.claude/rules/checks-must-be-able-to-fail.md`, sixth shape: green on
  // the verdict, witnessing a mechanism that never ran. So what WEDGED adds
  // is the REMEDY in the sentence, and that is what these assert.
  test("a wedged lane is refused, and told to clear itself rather than grow", () => {
    const r = readyRefusal(laneAt("OK", 2, 2), 0, 0);
    expect(r!.verdict).toBe("REFUSE");
    expect(r!.why).toContain("not an open issue");
    expect(
      r!.why,
      "SHORT sends the reader to promotion, and no promotion can reach a lane that is " +
        "already at its depth — the remedy is the half the count cannot carry",
    ).toContain("clearing the lane is the fix");
  });

  test("CONTROL: a lane with SOME startable work is not told to clear itself", () => {
    // **This control had to be rewritten twice.** Its first form passed a
    // lane with nothing undispatchable, which never reaches the remedy at
    // all — so a mutant that printed it on EVERY refusal stayed green and the
    // case witnessed nothing. Its second form fixed that and introduced a
    // worse fault: it spelled the live 2026-11-07 lane as `count: 2`, a
    // number `scripts/work-status.ts` CANNOT produce for a lane holding one
    // issue and one draft, because `laneCounts` is built from issues only.
    // The fixture described a board state and then asserted against a
    // reading of a different one (ai-review round 1 of #1857).
    //
    // The producible spelling of that lane: one issue card, one draft, depth
    // 2, one startable.
    const live = readyRefusal(laneAt("SHORT", 1, 2), 1, 1);
    expect(live!.verdict).toBe("REFUSE");
    expect(live!.why, "the card count still has to be named").toContain("not an open issue");
    expect(
      live!.why,
      "the draft has to be COUNTED, or the lane reads as holding one card of a depth of two " +
        "and the gate is back to disagreeing with the writer about the same column",
    ).toContain("1 of the 2 card(s)");
    expect(
      live!.why,
      "one startable issue is not a wedge, so it must NOT be told to clear the lane",
    ).not.toContain("clearing the lane is the fix");
    expect(
      live!.why,
      "and it still gets a remedy — promotion cannot help a lane already at its depth",
    ).toContain("Ready is at its depth");
  });

  // The ROOM half of the same question, which the first version of #1857 got
  // wrong: `heldReason`'s ROOM arm says "Ready is at its depth", true of an
  // item a promoter held back and false of a lane this gate is refusing for
  // being SHORT. Two cards of a depth of five is not at its depth.
  test("a SHORT lane holding a stale card is sent to promote, NOT to clear", () => {
    const short = readyRefusal(laneAt("SHORT", 2, 5), 1, 0);
    expect(short!.verdict).toBe("REFUSE");
    expect(short!.why).toContain("not an open issue");
    expect(
      short!.why,
      "the lane holds 2 of a depth of 5. Telling its reader the lane is at its depth is " +
        "false, and it sends them to the one fix that cannot work",
    ).not.toContain("Ready is at its depth");
    expect(short!.why, "the true remedy for a short lane is promotion").toContain("PROMOTING");
  });

  test("CONTROL: a genuinely full lane of startable work still passes", () => {
    expect(readyRefusal(laneAt("OK", 2, 2), 2, 0)).toBeNull();
  });

  // A lane whose cards are all startable AND whose depth is not reached has
  // nothing undispatchable, so it must get no remedy clause at all — the
  // control that proves the clause above is conditional on the thing it
  // describes, rather than appended to every refusal.
  test("CONTROL: a short lane with nothing stale gets no remedy clause", () => {
    const clean = readyRefusal(laneAt("SHORT", 1, 5), 1, 0);
    expect(clean!.verdict).toBe("REFUSE");
    expect(clean!.why).not.toContain("not an open issue");
    expect(clean!.why).not.toContain("PROMOTING");
    expect(clean!.why).not.toContain("Ready is at its depth");
  });

  test("the stale count comes from the occupancy, not from a subtraction here", () => {
    const src = readFileSync(join(ROOT, "lib/work-status.ts"), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    expect(src, "the one decider must be called").toContain("readyOccupancy(");
    expect(
      src.match(/ready\.count\s*-\s*openInReady/),
      "this file must not re-derive how many cards are undispatchable — that is the " +
        "second decider #1852 removed, and a mutation of readyOccupancy would not move it",
    ).toBeNull();
  });
});

/**
 * #1944. D4 in `project-state.json`: *it names unmerged and uncommitted
 * work in EVERY run, not when an agent remembers to check*. "Every run" is
 * the operative half, so these are source-position assertions — a section
 * behind a flag, or one an agent has to ask for, is the thing the stage
 * item says is broken.
 */
describe("#1944: the report names local work every run, from the one decider", () => {
  const src = readFileSync(join(ROOT, "scripts/work-status.ts"), "utf-8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  test("all three local readings are taken, and the verdict is not re-derived here", () => {
    for (const reader of ["readLocalWork(", "readPushedBranches(", "readWorktreeStates("]) {
      expect(code, `${reader} is never called, so that half of the evidence is never read`).toContain(reader);
    }
    expect(
      code,
      "the verdict must come from workVerdict in lib/board-lane-health.ts — a second decider " +
        "here would survive any mutation of that one and nothing could tell which was live",
    ).toContain("workVerdict({");
    // The literal strings the decider owns must NOT appear in this script.
    for (const owned of ["INVISIBLE —", "an assignee and nothing else"]) {
      expect(
        code.includes(owned),
        `scripts/work-status.ts spells out "${owned}" itself instead of printing the ` +
          `decider's sentence`,
      ).toBe(false);
    }
  });

  /**
   * Cut to the construct, never to a character count (#664). The section
   * runs from its own `bar(...)` heading to the next one, and both are
   * code rather than comments, so the comment strip above cannot eat
   * either boundary. A 2,600-character window was the first cut and CI
   * refused it — correctly: the window is a guess about how long the
   * section will stay that size, and the day it is wrong it accuses the
   * wrong code.
   */
  const SECTION_START = 'bar("WHAT IS ACTUALLY BEING WORKED';
  const SECTION_END = 'bar("START HERE';
  const section = structuralCut(code, SECTION_START, { endAnchor: SECTION_END });

  test("the cut found a real section, so nothing below holds vacuously", () => {
    expect(section.length).toBeGreaterThan(800);
    expect(section).toContain("workVerdict({");
  });

  /**
   * #1983: D4's binding. The first version matched three spellings of a flag
   * (`values.x`, `args.x`, `flags.x`) inside the cut section, so a flag read
   * any other way walked past, and a guard wrapping the section's own heading
   * sat outside the cut entirely. Measured: `if (process.argv.includes(...))`
   * in front of the heading left it green.
   *
   * So this asks a structural question instead of naming spellings: the
   * heading and the local reading are TOP-LEVEL statements, at brace depth 0,
   * with nothing conditional in front of them in the same statement. Any
   * `if`, `&&` or `?:`, however the flag is read, fails it.
   */
  /**
   * The early exits that may run before the section, by the condition that
   * guards each. Both end the WHOLE report rather than skipping this
   * section: no GitHub credential (UNMEASURED), and an unknown `--milestone`
   * value. Review of #2031, round 1: a separate guard line,
   * `if (!flag) process.exit(0);`, gates the section with no brace and an
   * empty statement prefix. Round 2: a count cannot tell the two known exits
   * from one of them deleted and a new one added. So every `process.exit(`
   * before the heading is identified by its guard and the list must match
   * exactly; a new legitimate one is named here, which a reviewer sees.
   * Not covered: a top-level `throw` used as a guard — the script has none,
   * and nothing here can tell one from the throws inside the functions above.
   */
  const KNOWN_EXITS_BEFORE_SECTION = ["if (!token)", 'if (focus.kind === "unknown")'];

  /**
   * #2041: read through the TypeScript parser, never a hand-written scanner.
   * Each review round of #2031 found one more literal shape the scanner got
   * wrong — a GraphQL query in a template, a regex holding `rel="next"`, a
   * `process.exit(` inside a template's `${}`. The parser has no such shapes:
   * a call is a call wherever it sits, and text inside a literal is text.
   *
   * A path from the anchor up to the file may pass only through these
   * kinds. Anything else — an `if`, a `&&`, a `?:`, a block, a function
   * that might never be called — is a condition, however the flag is read.
   */
  const UNCONDITIONAL_PATH = new Set([
    ts.SyntaxKind.ExpressionStatement,
    ts.SyntaxKind.VariableStatement,
    ts.SyntaxKind.VariableDeclarationList,
    ts.SyntaxKind.VariableDeclaration,
    ts.SyntaxKind.CallExpression,
    ts.SyntaxKind.AwaitExpression,
    ts.SyntaxKind.ParenthesizedExpression,
  ]);

  const unconditionalFailures = (source: string): string[] => {
    const failures: string[] = [];
    const sf = ts.createSourceFile("work-status.ts", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    const calls: ts.CallExpression[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) calls.push(n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    const callee = (c: ts.CallExpression) => c.expression.getText(sf);
    const conditionOn = (n: ts.Node): string | null => {
      for (let p = n.parent; p && p !== sf; p = p.parent) {
        if (!UNCONDITIONAL_PATH.has(p.kind)) return ts.SyntaxKind[p.kind];
      }
      return null;
    };
    const topLevel = (n: ts.Node): ts.Node => {
      let t = n;
      while (t.parent && t.parent !== sf) t = t.parent;
      return t;
    };

    const headings = calls.filter(
      c => callee(c) === "bar" && c.arguments.length > 0 && ts.isStringLiteral(c.arguments[0]) &&
        `bar("${c.arguments[0].text}`.startsWith(SECTION_START),
    );
    const readings = calls.filter(c => callee(c) === "readLocalWork");
    for (const [name, found] of [[SECTION_START, headings], ["readLocalWork(", readings]] as const) {
      if (found.length === 0) failures.push(`${name} is missing, so there is nothing to hold unconditional`);
      for (const c of found) {
        const cond = conditionOn(c);
        if (cond !== null) failures.push(`${name} is reached through a ${cond}, so some run skips it`);
      }
    }

    if (headings.length > 0) {
      const before = topLevel(headings[0]).getStart(sf);
      const guards = calls
        .filter(c => callee(c) === "process.exit" && c.getStart(sf) < before)
        .map(c => {
          for (let p: ts.Node | undefined = c.parent; p && p !== sf; p = p.parent) {
            if (ts.isFunctionLike(p)) return `(inside a function, line ${sf.getLineAndCharacterOfPosition(p.getStart(sf)).line + 1})`;
            if (ts.isIfStatement(p)) return `if (${p.expression.getText(sf)})`;
            if (!UNCONDITIONAL_PATH.has(p.kind) && p.kind !== ts.SyntaxKind.Block) {
              return `(guarded by a ${ts.SyntaxKind[p.kind]})`;
            }
          }
          return "(unguarded, top level)";
        });
      const got = [...guards].sort();
      const want = [...KNOWN_EXITS_BEFORE_SECTION].sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        failures.push(
          `the exits before the section are guarded by [${got.join(" | ")}], and the known ones are ` +
            `[${want.join(" | ")}]. A new exit can gate the section; name its guard in ` +
            `KNOWN_EXITS_BEFORE_SECTION only if it ends the whole report`,
        );
      }
    }
    return failures;
  };

  test("the section is unconditional — no flag, no opt-in", () => {
    // D4's whole complaint is "when an agent remembers to check". A flag is
    // exactly that, moved into the tool.
    expect(unconditionalFailures(src), "D4 says the local-work section must run in EVERY run").toEqual([]);
  });

  test("#1983: every way of putting the section behind a flag reddens it", () => {
    const heading = SECTION_START;
    const mutants: [string, string][] = [
      ["values.local in front of the heading", src.replace(heading, `if (values.local) ${heading}`)],
      ["process.argv in front of the heading", src.replace(heading, `if (process.argv.includes("--local")) ${heading}`)],
      ["a block around the whole section", src.replace(heading, `if (process.argv.includes("--local")) {\n${heading}`).replace(SECTION_END, `}\n${SECTION_END}`)],
      ["&& in front of the reading", src.replace("const localWork = readLocalWork(", "const localWork = process.argv.includes(\"--local\") && readLocalWork(")],
      // Review of #2031: a separate guard line, no brace, empty prefix.
      ["a guard clause on its own line", src.replace(heading, `if (!process.argv.includes("--local")) process.exit(0);\n${heading}`)],
      // Round 2: one known exit removed and a new one added — the count is
      // unchanged, the guards are not.
      [
        "a known exit swapped for a new one",
        src
          .replace(/(if \(focus\.kind === "unknown"\) \{[\s\S]*?)process\.exit\(2\);/, "$1")
          .replace(heading, `if (!process.argv.includes("--local")) process.exit(0);\n${heading}`),
      ],
      // Review round 3 of #2031, #2041: an exit inside a template's `${}`
      // runs, and a text scanner that blanks literal interiors never sees it.
      ["an exit inside a template substitution", src.replace(heading, "console.log(`${process.argv.includes(\"--local\") ? \"\" : process.exit(0)}`);\n" + heading)],
    ];
    for (const [name, mutant] of mutants) {
      expect(mutant, `the ${name} mutant changed nothing, so it proves nothing`).not.toBe(src);
      expect(unconditionalFailures(mutant).length, `${name}: not caught`).toBeGreaterThan(0);
    }
  });

  test("#1983: braces, semicolons and exits inside literals and comments before the section change nothing", () => {
    // Negative controls for the masking: none of this is structure.
    const noise: [string, string][] = [
      ["a string", `console.log("{ ; process.exit( ");\n`],
      ["a template", "console.log(`{ ; process.exit( ${1} }`);\n"],
      ["a regex", "const re = /[;{}]|(process.exit())/;\n"],
      ["a trailing comment", "const x = 1; // { ; process.exit(\n"],
    ];
    for (const [name, line] of noise) {
      const noisy = src.replace(SECTION_START, `${line}${SECTION_START}`);
      expect(noisy).not.toBe(src);
      expect(unconditionalFailures(noisy), `${name} was read as structure`).toEqual([]);
    }
  });

  /**
   * ai-review round 1 of #1974. The skip for healthy rows came BEFORE the
   * line that reports uncommitted changes, so an issue with an open pull
   * request and uncommitted edits in its worktree printed nothing at all —
   * the "and uncommitted" half of this issue's own title, dropped for the
   * subset most likely to have it. Uncommitted work is in no ref, so
   * deleting the directory ends it.
   *
   * **This is a source-position assertion and that is a real weakness.**
   * `scripts/work-status.ts` performs network calls at module scope, so it
   * cannot be imported and the loop cannot be driven. The decision this
   * case guards is a `continue`, not a value, so there was nothing to lift
   * into `lib/` the way `openPullRequestReading` was. Stated rather than
   * left for a reader to discover.
   */
  test("a healthy row is still printed when it holds uncommitted work", () => {
    const skip = section.match(/if \(r\.verdict === "WORKING"[^)]*\) continue;/);
    expect(skip, "the healthy-row skip was not found, so this holds vacuously").not.toBeNull();
    expect(
      skip![0],
      "the skip drops every WORKING row before the uncommitted-work line can run. An issue " +
        "with an open pull request AND uncommitted edits in its worktree then prints nothing",
    ).toContain("!r.alsoDirty");
    // And the count must span every verdict, not only the printed ones.
    expect(section, "the summary must count dirty worktrees across all verdicts").toContain(
      "workRows.filter(r => r.alsoDirty)",
    );
  });

  /**
   * ai-review round 2 of #1974. `issueFromBranch` reads a name, and a name
   * is not a fact about the tracker — `rg/2620-tick` is live here against
   * a highest issue of #1973. This script is the only caller that holds
   * the issue list, so it is the only one that can close the gap.
   */
  test("the real issue list is handed to the walk, and strays are named", () => {
    /**
     * All three readers, not just the one a reviewer named. Round 2 wired
     * the list into `readLocalWork` and round 3 found the other two still
     * crediting a number read from a name — `origin/2-factor-auth` making
     * issue #2 read WORKING. Asserting the call sites as a set is what
     * stops the next one being found the same way.
     */
    const wired = [
      "readLocalWork(process.cwd(), knownIssueNumbers)",
      "readPushedBranches(process.cwd(), knownIssueNumbers)",
      "issuesWithUncommittedWork(wtStates, knownIssueNumbers)",
    ];
    const missing = wired.filter(call => !section.includes(call));
    expect(
      missing,
      "a local reading is taken without the tracker's issue list, so any branch opening " +
        "with digits — a date stamp, a version, 2-factor-auth — is credited to whatever " +
        "issue that number happens to be, and reports it as being worked",
    ).toEqual([]);
    expect(
      section,
      "a branch with unpushed commits and no matching issue must be printed. Dropping it " +
        "silently is the empty-result-that-looks-clean this whole section exists to refuse",
    ).toContain("localWork.unattributed");
  });

  /**
   * ai-review round 4 of #1974 reported the `closingIssuesReferences`
   * query as having one brace too many. It does not — 10 opens, 10
   * closes, and running it against the API returns
   * `closes: [1944]`. The finding was refused.
   *
   * But the reason it took executing the query to settle is that
   * **nothing here could have caught it if it had been true.** An
   * unbalanced query string is a runtime throw in a script no test can
   * import, so it fails in the operator's terminal and never in CI.
   *
   * So the refusal comes with the guard the argument needed. Every
   * GraphQL template in the script is balanced, counted — a cheap check
   * for a defect class whose only other detector was somebody reading
   * carefully.
   */
  /**
   * ai-review round 5. Closing keywords resolve across repositories, so
   * the closing list is filtered by repository — and that filter needs a
   * field the QUERY has to ask for.
   *
   * The pairing is the point, and the battery showed why: dropping
   * `repository{nameWithOwner}` from the query reddened nothing, because
   * `declaredClosingIn` then matches no node at all and every issue reads
   * `openPullRequest: false`. A filter silently discarding its whole
   * input looks exactly like a repository with no closing references —
   * the worst direction, since it sends live claims toward PARKED.
   */
  test("the closing query asks which repository, and the filter uses it", () => {
    const closingQuery = [...src.matchAll(/`(query\([\s\S]*?)`/g)]
      .map(m => m[1]!)
      .find(t => t.includes("closingIssuesReferences"));
    expect(closingQuery, "the closing-references query was not found").toBeDefined();
    expect(
      closingQuery!,
      "the query does not request repository{nameWithOwner}, so declaredClosingIn matches " +
        "nothing and every issue reads as having no open pull request",
    ).toContain("repository{nameWithOwner}");
    expect(
      section.includes("declaredClosingIn(") || code.includes("declaredClosingIn("),
      "the closing nodes are read without the cross-repo filter",
    ).toBe(true);
  });

  test("every GraphQL template in the script is brace-balanced", () => {
    const templates = [...src.matchAll(/`(query\([\s\S]*?)`/g)].map(m => m[1]!);
    expect(
      templates.length,
      "no GraphQL templates were found, so this holds vacuously",
    ).toBeGreaterThanOrEqual(2);
    const unbalanced = templates
      .map(t => ({
        opens: (t.match(/\{/g) ?? []).length,
        closes: (t.match(/\}/g) ?? []).length,
        head: t.slice(0, 60),
      }))
      .filter(t => t.opens !== t.closes);
    expect(
      unbalanced,
      "a GraphQL query in this script does not balance its braces. That is a runtime throw " +
        "in a module no test can import, so it surfaces in an operator's terminal and never " +
        "in CI",
    ).toEqual([]);
  });

  test("an unreadable reading is announced, never dropped", () => {
    const announcements = section.match(/UNMEASURED —/g) ?? [];
    expect(
      announcements.length,
      "each of the three local readings can fail independently and each must say so. A " +
        "section that prints nothing when it could not look reads exactly like a clean board",
    ).toBeGreaterThanOrEqual(2);
    expect(section, "localCommitsFor carries the null; the script must not coerce it").toContain(
      "localCommitsFor(localWork",
    );
    expect(
      section.match(/localCommitsFor\([^)]*\)\s*(?:\?\?|\|\|)/),
      "the script defaults the local reading when it is null, which turns 'nobody looked' " +
        "into 'nothing found' — the one thing lib/local-work.ts exists to prevent",
    ).toBeNull();
  });
});

/**
 * #2087 / SC-2764: work-status prints the trailing day's opened and closed
 * issue counts and the filing cap they set (ADR-016). The cap itself is
 * decided by `netGrowthCeiling` in lib/issue-filing-gate.ts; this only says
 * what that decision was, so the board and the gate cannot disagree.
 */
describe("SC-2764: the filing cap line names the counts and the cap they set", () => {
  const caps = { shipCap: 12, ceiling: 36, queueCap: 24 };

  test("closing keeps pace: the ceiling applies, and the line says so with both counts", () => {
    const line = netGrowthLine({ cap: 36, basis: { reading: "MEASURED", opened: 20, closed: 25, ceiling: true } }, caps);
    expect(line).toContain("36");
    expect(line).toContain("opened 20");
    expect(line).toContain("closed 25");
    expect(line).toContain("ceiling applies");
  });

  test("opening outruns closing: the ship-mode cap, the net growth, and what lifts it", () => {
    const line = netGrowthLine({ cap: 12, basis: { reading: "MEASURED", opened: 34, closed: 27, ceiling: false } }, caps);
    expect(line).toMatch(/^Filing cap: 12\b/);
    expect(line).toContain("opened 34");
    expect(line).toContain("closed 27");
    expect(line).toContain("+7");
    expect(line).toContain("24 for an engine-labelled filing");
    expect(line).not.toContain("ceiling applies");
  });

  test("an unread count says UNMEASURED and why, and never claims the ceiling", () => {
    const line = netGrowthLine({ cap: 12, basis: { reading: "UNMEASURED", why: "no token" } }, caps);
    expect(line).toContain("UNMEASURED");
    expect(line).toContain("no token");
    expect(line).not.toContain("ceiling applies");
    expect(line).toMatch(/^Filing cap: 12\b/);
  });

  test("a cap the ceiling cannot reach says the ceiling does not apply", () => {
    const line = netGrowthLine({ cap: 1, basis: null }, caps);
    expect(line).toMatch(/^Filing cap: 1\b/);
    expect(line).toContain("does not apply");
  });

  test("the script prints the gate's own decision, through these two functions", () => {
    const src = readFileSync(join(ROOT, "scripts", "work-status.ts"), "utf8");
    expect(src).toContain("netGrowthCeiling(");
    expect(src).toContain("readNetGrowth(");
    expect(src).toContain("netGrowthLine(");
  });
});

