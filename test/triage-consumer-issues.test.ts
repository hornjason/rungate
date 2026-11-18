/**
 * #2340: a consumer's issue gets a triage verdict from one decider, ADR-020
 * Decision 1.
 *
 * Covers SC-2782 (SPEC-TO-BOARD-PIPELINE-SPEC.md).
 *
 * The decider is `triageVerdict`; the CLI only reads the tracker, asks it,
 * and writes what it answered. Every fixture criterion id is in the 9000+
 * fixture range (`test/sc-fixture-namespace.test.ts`).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CONSUMER_LABEL,
  triageVerdict,
  verdictComment,
  verdictIn,
  verdictMarker,
  type OpenPull,
  type TriageIssue,
} from "../lib/consumer-triage";
import type { PlacingFamily } from "../lib/issue-repair";
import { main, REFUSAL_EXIT, type TriageGitHub } from "../scripts/consumer-triage";

const P9 = "Zq Phase 9 — the active one";
const P10 = "Zq Phase 10 — later";

const FAMILY: PlacingFamily = {
  prefix: "Zq",
  stated: ["SC-9811", "SC-9812", "SC-9813"],
  placements: new Map([
    ["SC-9811", "Phase 9"],
    ["SC-9812", "Phase 10"],
    ["SC-9813", "Phase 10"],
  ]),
  milestones: new Map([
    [9, P9],
    [10, P10],
  ]),
};

const files = (...paths: string[]) => `## Files this will change\n\n${paths.map(p => `- \`${p}\``).join("\n")}\n`;

/** Open work already on the tracker. */
const ACTIVE_WORK: TriageIssue = { number: 100, title: "Engine work in phase 9", body: files("lib/engine-a.ts"), milestone: P9 };
const LATER_WORK: TriageIssue = {
  number: 101,
  title: "Later engine work",
  body: `Serves SC-9812.\n\n${files("lib/engine-b.ts")}`,
  milestone: P10,
};
const UNPLACED_WORK: TriageIssue = { number: 102, title: "Unplaced chore", body: files("lib/engine-c.ts"), milestone: null };

const DUP_BODY =
  "The `alphaReader` drops the `betaWriter` row when `gammaCount` is zero, in `lib/dup-one.ts` and `lib/dup-two.ts`.";
const ORIGINAL: TriageIssue = { number: 103, title: "alphaReader drops a row", body: DUP_BODY, milestone: P10 };

const PULL: OpenPull = { number: 150, title: "A change in flight", body: "", milestone: P10, files: ["lib/in-flight.ts"] };

const consumer = (number: number, body: string, milestone: string | null = null): TriageIssue => ({
  number,
  title: `A consumer report ${number}`,
  body,
  milestone,
});

const ctx = (over: Partial<Parameters<typeof triageVerdict>[1]> = {}) => ({
  openIssues: [ACTIVE_WORK, LATER_WORK, UNPLACED_WORK, ORIGINAL],
  openPulls: [PULL],
  families: [FAMILY],
  enginePrefix: "Zq",
  ...over,
});

describe("SC-2782: one decider gives a consumer's issue exactly one verdict, the first that fits", () => {
  test("DUPLICATE: the arbiter's duplicate test matches an older open issue", () => {
    const issue = consumer(200, DUP_BODY);
    const t = triageVerdict(issue, ctx({ openIssues: [...ctx().openIssues, issue] }));
    expect(t.kind).toBe("DUPLICATE");
    if (t.kind === "DUPLICATE") expect(t.of).toBe(103);
  });

  test("DUPLICATE is only ever of an OLDER issue, so two consumer reports cannot each be the other's duplicate", () => {
    const older = consumer(200, DUP_BODY);
    const newer = consumer(201, DUP_BODY);
    const open = [ACTIVE_WORK, older, newer];
    const first = triageVerdict(older, ctx({ openIssues: open }));
    const second = triageVerdict(newer, ctx({ openIssues: open }));
    expect(first.kind).not.toBe("DUPLICATE");
    expect(second.kind).toBe("DUPLICATE");
    if (second.kind === "DUPLICATE") expect(second.of).toBe(200);
  });

  test("PLACED: it names a placed criterion, and SC-2779's decider names the phase", () => {
    const t = triageVerdict(consumer(202, "This needs SC-9811 to hold."), ctx());
    expect(t).toMatchObject({ kind: "PLACED", milestone: P9 });
  });

  test("OVERLAPS: its declared files meet an open issue's, and it joins that issue's milestone", () => {
    const t = triageVerdict(consumer(203, files("lib/engine-b.ts", "lib/other.ts")), ctx());
    expect(t).toMatchObject({ kind: "OVERLAPS", of: 101, milestone: P10, shared: ["lib/engine-b.ts"] });
  });

  test("OVERLAPS: a file an open pull request changes counts, and it joins the pull request's milestone", () => {
    const t = triageVerdict(consumer(204, files("lib/in-flight.ts")), ctx());
    expect(t).toMatchObject({ kind: "OVERLAPS", of: 150, milestone: P10, shared: ["lib/in-flight.ts"] });
  });

  test("OVERLAPS: a criterion an open issue names counts, when the criterion is placed nowhere that would PLACE it", () => {
    // SC-9813 is placed in Phase 10, so on its own it PLACES. Read with a family
    // that does not place it, the shared criterion is what joins the two.
    const unplacing: PlacingFamily = { ...FAMILY, placements: new Map([["SC-9811", "Phase 9"], ["SC-9812", "Phase 10"]]) };
    const named: TriageIssue = { number: 104, title: "Names a criterion", body: "Serves SC-9813.", milestone: P10 };
    const t = triageVerdict(consumer(205, "Touches SC-9813 too."), ctx({ families: [unplacing], openIssues: [ACTIVE_WORK, named] }));
    expect(t).toMatchObject({ kind: "OVERLAPS", of: 104, milestone: P10, shared: ["SC-9813"] });
  });

  test("OVERLAPS skips open work with no milestone, because there is nothing to join", () => {
    const t = triageVerdict(consumer(206, files("lib/engine-c.ts")), ctx());
    expect(t).toMatchObject({ kind: "ACTIVE", milestone: P9 });
  });

  test("ACTIVE: none of the above, so it joins the lowest engine phase with an open issue", () => {
    const t = triageVerdict(consumer(207, "Something is off and I cannot say where."), ctx());
    expect(t).toMatchObject({ kind: "ACTIVE", milestone: P9 });
  });

  test("the order is the ADR's: a duplicate that also names a placed criterion is a DUPLICATE", () => {
    const issue = consumer(208, `${DUP_BODY} It needs SC-9811.`);
    expect(triageVerdict(issue, ctx()).kind).toBe("DUPLICATE");
  });

  test("the order is the ADR's: a placed criterion beats a shared file", () => {
    const t = triageVerdict(consumer(209, `Needs SC-9811.\n\n${files("lib/engine-b.ts")}`), ctx());
    expect(t).toMatchObject({ kind: "PLACED", milestone: P9 });
  });

  test("a milestone a person already set is never moved: LEFT, with no verdict", () => {
    const t = triageVerdict(consumer(210, files("lib/engine-b.ts"), "Somewhere Else"), ctx());
    expect(t.kind).toBe("LEFT");
  });

  test("a phase with no milestone is REFUSED, never guessed", () => {
    const noP9: PlacingFamily = { ...FAMILY, milestones: new Map([[10, P10]]) };
    const t = triageVerdict(consumer(211, "Needs SC-9811."), ctx({ families: [noP9] }));
    expect(t.kind).toBe("REFUSED");
  });

  test("no open issue in any phase milestone: ACTIVE has nowhere to go, so it is REFUSED", () => {
    const t = triageVerdict(consumer(212, "Vague report."), ctx({ openIssues: [UNPLACED_WORK], openPulls: [] }));
    expect(t.kind).toBe("REFUSED");
  });
});

describe("SC-2782: each verdict is recorded as a marker comment the reading can find", () => {
  test("verdictIn reads the marker back, and reads nothing from a comment without one", () => {
    const comment = verdictComment({ kind: "ACTIVE", milestone: P9, why: "x" });
    expect(comment.startsWith(verdictMarker("ACTIVE"))).toBe(true);
    expect(verdictIn(["a plain comment", comment])).toBe("ACTIVE");
    expect(verdictIn(["a plain comment", "mentions rungate:consumer-triage in prose"])).toBeNull();
  });

  test("every verdict kind round-trips through its marker", () => {
    for (const kind of ["DUPLICATE", "PLACED", "OVERLAPS", "ACTIVE"] as const) {
      expect(verdictIn([verdictMarker(kind)])).toBe(kind);
    }
  });
});

// ── The CLI: reads, asks the decider, writes what it said ────────────────

interface Wrote {
  op: "comment" | "milestone" | "label";
  number: number;
  value: string;
}

const MARKED: Record<number, string[]> = { 302: [verdictMarker("ACTIVE")] };

function fakeGitHub(over: Partial<TriageGitHub> = {}): { gh: TriageGitHub; wrote: Wrote[] } {
  const wrote: Wrote[] = [];
  const issues = [
    { ...ACTIVE_WORK, labels: ["engine"] },
    { ...LATER_WORK, labels: ["engine"] },
    { ...consumer(300, "Needs SC-9811."), labels: [CONSUMER_LABEL] },
    { ...consumer(301, DUP_BODY), labels: [CONSUMER_LABEL] },
    { ...consumer(302, "Already triaged."), labels: [CONSUMER_LABEL] },
    { ...ORIGINAL, labels: [] },
  ];
  const gh: TriageGitHub = {
    milestones: async () => [],
    openIssues: async () => issues,
    openPulls: async () => [PULL],
    comments: async (_repo, n) => MARKED[n] ?? [],
    comment: async (_repo, number, value) => void wrote.push({ op: "comment", number, value }),
    setMilestone: async (_repo, number, value) => void wrote.push({ op: "milestone", number, value }),
    addLabel: async (_repo, number, value) => void wrote.push({ op: "label", number, value }),
    families: () => ({ families: [FAMILY], refusals: [] }),
    ...over,
  };
  return { gh, wrote };
}

function scratchRoot(queueLabel: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "consumer-triage-"));
  mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
  const board: Record<string, string> = { milestonePrefix: "Zq" };
  if (queueLabel !== null) board.queueLabel = queueLabel;
  writeFileSync(join(root, ".claude", "rungate", "config.json"), JSON.stringify({ board }));
  return root;
}

async function run(argv: string[], gh: TriageGitHub, queueLabel: string | null = "engine") {
  const root = scratchRoot(queueLabel);
  const out: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void out.push(a.join(" "));
  try {
    const code = await main(["--repo", "o/r", "--project-root", root, ...argv], gh);
    return { code, out: out.join("\n") };
  } finally {
    console.log = log;
    console.error = err;
    rmSync(root, { recursive: true, force: true });
  }
}

describe("SC-2782: rungate consumer-triage --write gives the verdict with no hand edit", () => {
  test("without --write nothing is written, and each verdict is printed", async () => {
    const { gh, wrote } = fakeGitHub();
    const r = await run([], gh);
    expect(r.code).toBe(0);
    expect(wrote).toEqual([]);
    expect(r.out).toContain("#300");
    expect(r.out).toContain("PLACED");
    expect(r.out).toContain("DUPLICATE");
  });

  test("--write: milestone and queue label first, the marker comment last; DUPLICATE gets only the comment", async () => {
    const { gh, wrote } = fakeGitHub();
    const r = await run(["--write"], gh);
    expect(r.code).toBe(0);
    expect(wrote.filter(w => w.number === 300).map(w => w.op)).toEqual(["milestone", "label", "comment"]);
    expect(wrote.find(w => w.number === 300 && w.op === "milestone")?.value).toBe(P9);
    expect(wrote.find(w => w.number === 300 && w.op === "label")?.value).toBe("engine");
    expect(verdictIn([wrote.find(w => w.number === 300 && w.op === "comment")!.value])).toBe("PLACED");
    expect(wrote.filter(w => w.number === 301).map(w => w.op)).toEqual(["comment"]);
    expect(wrote.find(w => w.number === 301)!.value).toContain("#103");
  });

  test("an issue that already carries a verdict marker is never triaged again", async () => {
    const { gh, wrote } = fakeGitHub();
    await run(["--write"], gh);
    expect(wrote.filter(w => w.number === 302)).toEqual([]);
  });

  test("only issues labelled from-consumer are triaged", async () => {
    const { gh, wrote } = fakeGitHub();
    await run(["--write"], gh);
    expect(wrote.some(w => [100, 101, 103].includes(w.number))).toBe(false);
  });

  test("a move that fails writes no marker, so the next run tries again, and the run refuses", async () => {
    const { gh, wrote } = fakeGitHub({
      setMilestone: async () => {
        throw new Error("boom");
      },
    });
    const r = await run(["--write"], gh);
    expect(r.code).toBe(REFUSAL_EXIT);
    expect(wrote.filter(w => w.number === 300)).toEqual([]);
    expect(r.out).toContain("FAILED");
  });

  test("a tracker it cannot read is UNMEASURED, and nothing is written", async () => {
    const { gh, wrote } = fakeGitHub({
      openPulls: async () => {
        throw new Error("rate limited");
      },
    });
    const r = await run(["--write"], gh);
    expect(r.code).toBe(REFUSAL_EXIT);
    expect(r.out).toContain("UNMEASURED");
    expect(wrote).toEqual([]);
  });

  test("families that cannot be read are UNMEASURED, and nothing is written", async () => {
    const { gh, wrote } = fakeGitHub({ families: () => ({ families: [], refusals: ["specs/X.md: unsound"] }) });
    const r = await run(["--write"], gh);
    expect(r.code).toBe(REFUSAL_EXIT);
    expect(r.out).toContain("specs/X.md: unsound");
    expect(wrote).toEqual([]);
  });

  test("no board.queueLabel: the verdicts are written, no label is, and the run says so", async () => {
    const { gh, wrote } = fakeGitHub();
    const r = await run(["--write"], gh, null);
    expect(r.code).toBe(0);
    expect(wrote.some(w => w.op === "label")).toBe(false);
    expect(wrote.filter(w => w.number === 300).map(w => w.op)).toEqual(["milestone", "comment"]);
    expect(r.out).toContain("board.queueLabel");
  });

  test("an issue already carrying the queue label is not labelled twice, and one already in its milestone is not moved", async () => {
    const { gh, wrote } = fakeGitHub({
      openIssues: async () => [
        { ...ACTIVE_WORK, labels: ["engine"] },
        { ...consumer(303, "Needs SC-9811.", P9), labels: [CONSUMER_LABEL, "engine"] },
      ],
    });
    const r = await run(["--write"], gh);
    expect(r.code).toBe(0);
    expect(wrote.filter(w => w.number === 303).map(w => w.op)).toEqual(["comment"]);
  });
});
