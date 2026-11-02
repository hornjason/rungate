/**
 * `lib/live-issues.ts` — the ONE reader of issues and their `blocked by`
 * edges.
 *
 * ## Why this file exists
 *
 * Round 1 of #1703: `scripts/board-snapshot.ts` and `scripts/plan-deps.ts`
 * both inject a fake at the `readIssues` seam ABOVE this module, so every
 * case in both their suites runs with this file's only logic — the GraphQL
 * field mapping and the pagination loop — never executed. The module was
 * introduced precisely so there would be one reader rather than two, and
 * the one reader had no behavioural test.
 *
 * So these drive `readLiveIssues` directly through an injected transport and
 * assert on what comes out, not on what a fake was told to return.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  ISSUE_PAGE,
  LIVE_ISSUES_QUERY,
  inMilestoneFamily,
  readLiveIssues,
  readMilestonePrefix,
  type GraphQlExec,
} from "../lib/live-issues";

type Node = {
  number: number;
  state?: string;
  milestone?: { title: string } | null;
  blockedBy?: { pageInfo: { hasNextPage: boolean }; nodes: { number: number }[] } | null;
};

const page = (nodes: Node[], next?: string) =>
  JSON.stringify({
    data: {
      repository: {
        issues: {
          pageInfo: { hasNextPage: next !== undefined, endCursor: next ?? "" },
          nodes: nodes.map(n => ({
            state: "OPEN",
            milestone: null,
            blockedBy: { pageInfo: { hasNextPage: false }, nodes: [] },
            ...n,
          })),
        },
      },
    },
  });

/** Replays canned pages in order, recording the argv it was handed. */
function transport(pages: string[]): { exec: GraphQlExec; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  return {
    calls,
    exec: (args: readonly string[]) => {
      calls.push([...args]);
      const out = pages[i];
      if (out === undefined) throw new Error(`the reader asked for page ${i + 1} and there are ${pages.length}`);
      i += 1;
      return out;
    },
  };
}

describe("the field mapping", () => {
  test("every field lands where the readings look for it", async () => {
    const t = transport([
      page([
        {
          number: 10,
          state: "CLOSED",
          milestone: { title: "Pipeline Phase 2 — the order is data" },
          blockedBy: { pageInfo: { hasNextPage: false }, nodes: [{ number: 7 }, { number: 8 }] },
        },
      ]),
    ]);
    const [issue] = await readLiveIssues("o/n", true, t.exec);
    expect(issue).toEqual({
      number: 10,
      state: "CLOSED",
      milestone: "Pipeline Phase 2 — the order is data",
      blockedBy: [7, 8],
      blockedByTruncated: false,
    });
  });

  test("a null milestone and an absent blocker list are empty, not a throw", async () => {
    const t = transport([page([{ number: 11, milestone: null, blockedBy: null }])]);
    const [issue] = await readLiveIssues("o/n", false, t.exec);
    expect(issue!.milestone).toBeNull();
    expect(issue!.blockedBy).toEqual([]);
  });

  test("a CUT blocker list is reported, and a complete one is not", async () => {
    // Both arms in one read. A reader hardcoding either value passes a
    // case where every row agrees.
    const t = transport([
      page([
        { number: 12, blockedBy: { pageInfo: { hasNextPage: true }, nodes: [{ number: 1 }] } },
        { number: 13, blockedBy: { pageInfo: { hasNextPage: false }, nodes: [{ number: 2 }] } },
      ]),
    ]);
    const got = await readLiveIssues("o/n", false, t.exec);
    expect(got.map(i => i.blockedByTruncated)).toEqual([true, false]);
  });
});

describe("the pagination loop", () => {
  test("it follows every page and concatenates in order", async () => {
    const t = transport([
      page([{ number: 1 }, { number: 2 }], "CURSOR-A"),
      page([{ number: 3 }], "CURSOR-B"),
      page([{ number: 4 }]),
    ]);
    const got = await readLiveIssues("o/n", false, t.exec);
    expect(got.map(i => i.number)).toEqual([1, 2, 3, 4]);
    expect(t.calls).toHaveLength(3);
  });

  test("it advances the cursor — page two is asked for with page one's endCursor", async () => {
    // Not advancing is the quiet bug: the first page returns forever and
    // the loop never ends, or (with a `hasNextPage: false` second page)
    // page one is read twice and everything past it is silently dropped.
    const t = transport([page([{ number: 1 }], "CURSOR-A"), page([{ number: 2 }])]);
    await readLiveIssues("o/n", false, t.exec);
    expect(t.calls[0]!.join(" "), "the first call sent a cursor it could not have").not.toContain("after=");
    expect(t.calls[1]!).toContain("after=CURSOR-A");
  });

  test("the owner, the name and the state filter are what the caller asked for", async () => {
    const open = transport([page([])]);
    await readLiveIssues("someone/their-repo", false, open.exec);
    expect(open.calls[0]!).toContain("owner=someone");
    expect(open.calls[0]!).toContain("name=their-repo");
    expect(open.calls[0]!, "includeClosed:false did not restrict to OPEN").toContain("states=OPEN");

    // The control: the SAME call with includeClosed sends no state filter,
    // so the assertion above is about the argument and not about a
    // constant this reader always sends.
    const all = transport([page([])]);
    await readLiveIssues("someone/their-repo", true, all.exec);
    expect(all.calls[0]!.join(" "), "includeClosed:true still restricted to OPEN").not.toContain("states=OPEN");
  });

  test("a transport that throws is not an empty repository", async () => {
    const boom: GraphQlExec = () => {
      throw new Error("HTTP 403");
    };
    expect(readLiveIssues("o/n", false, boom)).rejects.toThrow("HTTP 403");
  });
});

describe("the query itself", () => {
  test("every paged connection asks for the declared page size", () => {
    // Three connections, one constant. A hand-typed 100 on one of them
    // drifts the day ISSUE_PAGE moves.
    const sizes = [...LIVE_ISSUES_QUERY.matchAll(/first:(\d+)/g)].map(m => Number(m[1]));
    expect(sizes).toHaveLength(2);
    expect(new Set(sizes)).toEqual(new Set([ISSUE_PAGE]));
  });

  test("every paged connection either carries a truncation signal or is followed", () => {
    // `issues` is followed to the end, so its pageInfo is consumed by the
    // loop. Anything read ONCE must SAY it was cut. Written as a loop over
    // a list rather than one assertion, because the next connection added
    // here is the one that will be silent.
    for (const field of ["blockedBy"]) {
      const at = LIVE_ISSUES_QUERY.indexOf(`${field}(first:`);
      expect(at, `${field} is not in the query`).toBeGreaterThan(-1);
      const connection = LIVE_ISSUES_QUERY.slice(at, LIVE_ISSUES_QUERY.indexOf("}", at) + 1);
      expect(connection, `${field} is paged and cannot report being cut`).toContain("pageInfo{hasNextPage}");
    }
  });
});

/**
 * `inMilestoneFamily` — round 2 of #1703.
 *
 * A bare `startsWith(prefix)` admits any family whose NAME begins with this
 * one, which is the cross-spec contamination the prefix was added to
 * prevent, arriving through the fix for it.
 */
describe("which milestones belong to a spec's family", () => {
  const cases: { title: string | null; prefix: string; want: boolean; why: string }[] = [
    { title: "Pipeline Phase 0 — the transform refuses", prefix: "Pipeline", want: true, why: "the derived shape" },
    { title: "Pipeline Phase 10 — a two-digit phase", prefix: "Pipeline", want: true, why: "phases past nine" },
    { title: "Pipeline Phase 3", prefix: "Pipeline", want: true, why: "a heading with no em dash" },
    { title: "Pipeline Phase 0 — x", prefix: "Pipe", want: false, why: "a prefix of ANOTHER family's name" },
    { title: "Pipelines Phase 1 — x", prefix: "Pipeline", want: false, why: "a longer family name" },
    // The trailing space in the anchor is load-bearing, and nothing above
    // showed it: every other row differs before `Phase` is reached.
    // Without it `${prefix} Phase` matches this, and `phaseOf` then finds
    // the 1 and calls it Phase 1.
    { title: "Pipeline Phases 1 — a plural", prefix: "Pipeline", want: false, why: "`Phase` not followed by a space" },
    { title: "Not Pipeline Phase 1 — x", prefix: "Pipeline", want: false, why: "the prefix mid-title" },
    { title: "Pipeline — no phase at all", prefix: "Pipeline", want: false, why: "no phase to order by" },
    { title: "Pipeline", prefix: "Pipeline", want: false, why: "the bare family name" },
    { title: null, prefix: "Pipeline", want: false, why: "no milestone" },
    { title: "Pipeline Phase 0 — x", prefix: "", want: false, why: "an empty prefix matches nothing here either" },
  ];

  for (const c of cases) {
    test(`${JSON.stringify(c.title)} with prefix ${JSON.stringify(c.prefix)} is ${c.want} — ${c.why}`, () => {
      expect(inMilestoneFamily(c.title, c.prefix)).toBe(c.want);
    });
  }

  test("both arms are present, so no constant satisfies the table above", () => {
    expect(cases.some(c => c.want)).toBe(true);
    expect(cases.some(c => !c.want)).toBe(true);
  });
});

/**
 * `readMilestonePrefix` — round 1 of #1705.
 *
 * The finding was reported against `plan-deps`: the emptiness guard tested
 * `raw.trim() === ""` and the filter used the untrimmed `raw`, so the two
 * disagreed about every input with whitespace on an end. `plan-spec` and
 * `board-snapshot` had the same split reversed — `if (!prefix)` admits
 * `"   "`, and `plan-spec --write` would have created milestones called
 * `"    Phase 1 — …"` on a live tracker.
 *
 * One reading, so there is nothing for a guard and a use to disagree about.
 */
describe("what a --prefix argument actually said", () => {
  const rows: { raw: string | undefined; kind: string; prefix?: string; why: string }[] = [
    { raw: undefined, kind: "absent", why: "the flag was not passed at all" },
    { raw: "Pipeline", kind: "given", prefix: "Pipeline", why: "the ordinary case" },
    { raw: " Pipeline", kind: "given", prefix: "Pipeline", why: "a leading space" },
    { raw: "Pipeline ", kind: "given", prefix: "Pipeline", why: "a trailing space" },
    { raw: "\tPipeline\n", kind: "given", prefix: "Pipeline", why: "a tab and a newline" },
    { raw: " Spec Two ", kind: "given", prefix: "Spec Two", why: "ENDS only — the inner space stays" },
    { raw: "", kind: "blank", why: "an unset shell variable" },
    { raw: "   ", kind: "blank", why: "spaces only" },
    { raw: "\t\n", kind: "blank", why: "other whitespace only" },
  ];

  for (const r of rows) {
    test(`${JSON.stringify(r.raw)} reads as ${r.kind} — ${r.why}`, () => {
      const got = readMilestonePrefix(r.raw);
      expect(got.kind).toBe(r.kind as typeof got.kind);
      if (got.kind === "given") expect(got.prefix).toBe(r.prefix!);
    });
  }

  test("all three states occur above, so no constant satisfies the table", () => {
    const kinds = new Set(rows.map(r => r.kind));
    expect(kinds).toEqual(new Set(["absent", "blank", "given"]));
  });

  test("a blank reading carries the RAW text, so the refusal can quote it", () => {
    // `--prefix "   " was given` and `--prefix was not given` are different
    // facts and a caller debugging a CI input needs to be told which.
    const got = readMilestonePrefix("  ");
    expect(got.kind === "blank" && got.raw).toBe("  ");
  });

  /**
   * The POPULATION, not the three sites repaired.
   *
   * `.claude/rules/checks-must-be-able-to-fail.md`, fourth shape: at N sites
   * a behavioural suite catches only the last one to regress. A fourth
   * command taking a milestone prefix is the thing this has to see, and the
   * three behavioural suites cannot.
   *
   * The exemption is DERIVED rather than listed. `scripts/board-conformance.ts`
   * carries no relative imports on purpose — its mutation battery copies the
   * file into a temp directory, and an import would kill the copy on module
   * resolution, so every negative case would go green having witnessed
   * nothing. A file in that state cannot call this binding and must not grow
   * a second decider; it forwards its prefix to `board-snapshot`, which does
   * call it. Naming the file here instead would be an allowlist whose only
   * evidence is that somebody wrote the name down.
   */
  test("every command taking a milestone prefix routes through this one reading", () => {
    const dir = join(import.meta.dir, "..", "scripts");
    const offenders: string[] = [];
    for (const name of readdirSync(dir).filter(f => f.endsWith(".ts"))) {
      const src = readFileSync(join(dir, name), "utf-8");
      if (!/prefix"?\s*:\s*\{\s*type:\s*"string"/.test(src)) continue;
      const importFree = !/from\s+"\.\.?\//.test(src);
      // A WHOLE-WORD match, and the module it comes from. `src.includes(...)`
      // was the first spelling and it is green against a file that renamed
      // the symbol to `readMilestonePrefixX` and decides for itself — proved
      // by doing exactly that, which is why this line is not `includes`.
      const routed = /\breadMilestonePrefix\b/.test(src) && /lib\/live-issues/.test(src);
      if (importFree || routed) continue;
      offenders.push(name);
    }
    expect(
      offenders,
      `these declare a --prefix string option, decide on it themselves, and can import: ` +
        `call readMilestonePrefix from lib/live-issues.ts instead. Two guards answering the ` +
        `same question about the same input are behaviourally one.`,
    ).toEqual([]);
  });

  test("that scan actually found the commands — it is not vacuous on an empty set", () => {
    // The control. A regex that matches nothing passes the case above
    // forever, and the whole point of the case is the file nobody has
    // written yet.
    const dir = join(import.meta.dir, "..", "scripts");
    const withPrefix = readdirSync(dir)
      .filter(f => f.endsWith(".ts"))
      .filter(f => /prefix"?\s*:\s*\{\s*type:\s*"string"/.test(readFileSync(join(dir, f), "utf-8")));
    expect(withPrefix.sort()).toEqual([
      "board-conformance.ts",
      "board-snapshot.ts",
      "plan-deps.ts",
      "plan-spec.ts",
    ]);
  });
});
