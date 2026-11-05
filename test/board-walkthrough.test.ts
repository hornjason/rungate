/**
 * Covers SC-2641, SC-2642, SC-2643 (specs/BOARD-FLOW-SPEC.md).
 *
 * SC-2640 is deliberately NOT covered here. It says the walk-through drives a
 * real issue through every lane, its `needs:` is `run`, and no unit test can
 * prove it — a fixture asserting that a real event happened is the thing this
 * increment exists to stop. It ticks when a dispatch is executed and its
 * output recorded, and not before.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  WALKTHROUGH_STEPS,
  stepVerdict,
  runVerdict,
  reportLines,
  type Lane,
  type Reading,
  type Step,
} from "../lib/board-walkthrough";

const ROOT = join(import.meta.dir, "..");
const step = (over: Partial<Step> = {}): Step => ({
  n: 1,
  action: "a",
  expect: "Ready",
  writer: "board-ready.yml",
  ...over,
});
const reading = (over: Partial<Reading> = {}): Reading => {
  const s = over.step ?? step();
  const observed = over.observed ?? s.expect;
  return { step: s, observed, verdict: stepVerdict(s, observed), waitExpired: false, ...over };
};

describe("the walk-through reports what each lane did", () => {
  // The whole verdict table in one grid, because the interesting cases are
  // the two that are neither pass nor fail and they are only distinguishable
  // from each other by the writer.
  test("SC-2641: a lane with a writer that did not move is a FAIL, not a retry", () => {
    const withWriter = step({ expect: "Ready", writer: "board-ready.yml" });
    const noWriter = step({ expect: "In progress", writer: null });
    expect(stepVerdict(withWriter, "Ready")).toBe("PASS");
    expect(stepVerdict(withWriter, "Backlog")).toBe("FAIL");
    expect(stepVerdict(noWriter, "Backlog")).toBe("EXPECTED_RED");
  });

  // The half that is easy to forget, and the reason this instrument is worth
  // having at all: the day a lane with no writer starts working must not look
  // like every day before it.
  test("SC-2641: a lane with NO writer that DID move is UNEXPECTED_PASS, never a quiet pass", () => {
    const noWriter = step({ expect: "In progress", writer: null });
    expect(
      stepVerdict(noWriter, "In progress"),
      "a row marked expected-red that starts passing is the most informative reading " +
        "this instrument can produce. Collapsing it into PASS means the day In progress " +
        "begins working is indistinguishable from the day before.",
    ).toBe("UNEXPECTED_PASS");
  });

  // Anti-vacuity, and it is a real failure mode here rather than a ritual:
  // a driver that threw before step one produces zero readings, and zero
  // readings contain zero failures.
  test("SC-2641: no readings at all REFUSES — it is not the same as every lane working", () => {
    const empty = runVerdict([]);
    expect(empty.ok).toBe(false);
    expect(empty.why).toContain("UNMEASURED");
    // and the contrast, so the refusal is not simply "always false"
    expect(runVerdict([reading()]).ok).toBe(true);
  });

  test("SC-2641: an EXPECTED_RED row does not fail the run, and a FAIL does", () => {
    const red = reading({ step: step({ n: 3, expect: "In progress", writer: null }), observed: "Backlog" });
    expect(red.verdict).toBe("EXPECTED_RED");
    expect(runVerdict([red]).ok, "a declared gap must not make the run unmergeable forever").toBe(true);

    const broke = reading({ step: step({ n: 2, expect: "Ready", writer: "board-ready.yml" }), observed: "Backlog" });
    expect(broke.verdict).toBe("FAIL");
    const v = runVerdict([broke]);
    expect(v.ok).toBe(false);
    expect(v.why, "the failure must name the lane and its writer, not just a count").toContain("board-ready.yml");
  });

  // Without this row the walk-through passes against a board that moves
  // everything to Ready unconditionally — a board that lies in the other
  // direction. The control is asserted to EXIST, over the step list, because
  // deleting it is the cheapest way to make a red run green.
  test("SC-2642: a negative control for Ready is present and expects Backlog", () => {
    const control = WALKTHROUGH_STEPS.filter(s => s.action.includes("NEGATIVE CONTROL"));
    expect(
      control.length,
      "the walk-through must drive an issue with an OPEN blocker and assert it does " +
        "NOT reach Ready. Without it, a board that moves everything passes.",
    ).toBe(1);
    expect(control[0]!.expect).toBe("Backlog");
    expect(control[0]!.writer).not.toBeNull();
  });

  test("SC-2642: the step list covers every lane the spec names", () => {
    const lanes = new Set(WALKTHROUGH_STEPS.map(s => s.expect));
    for (const lane of ["Backlog", "Ready", "In progress", "In review", "Done", "Cancelled"] as Lane[]) {
      expect(lanes.has(lane), `no step asserts the ${lane} lane`).toBe(true);
    }
  });

  // The report is asserted rather than the I/O, because a row missing from
  // the printed output is exactly the failure this increment exists to catch
  // and it is invisible if formatting lives inside the driver.
  test("SC-2641: every reading appears in the report, and a writerless lane says so", () => {
    const rs = WALKTHROUGH_STEPS.map(s => reading({ step: s, observed: "Backlog" }));
    const lines = reportLines(rs);
    expect(lines.length).toBe(WALKTHROUGH_STEPS.length);
    for (const s of WALKTHROUGH_STEPS) {
      expect(lines.some(l => l.startsWith(`row ${s.n} `)), `row ${s.n} is missing from the report`).toBe(true);
    }
    expect(lines.join("\n")).toContain("NOTHING WRITES THIS LANE YET");
  });

  test("SC-2641: an expired bounded wait is reported on the row, not swallowed", () => {
    const [line] = reportLines([reading({ observed: "Backlog", waitExpired: true })]);
    expect(line).toContain("bounded wait expired");
    expect(line, "and it must say what that means, or it reads as a retry").toContain("not a retry");
  });
});

describe("the walk-through cleans up after itself", () => {
  const src = readFileSync(join(ROOT, "scripts/board-walkthrough.ts"), "utf-8");

  // A throwaway issue that outlives its run becomes indistinguishable from
  // real work on the tracker — and this run creates FOUR of them plus a
  // branch and a PR. Asserted on the source because the alternative is
  // discovering it by finding the litter.
  test("SC-2643: cleanup runs in a finally, so a thrown step still tidies", () => {
    expect(
      /finally\s*\{/.test(src),
      "cleanup must be in a `finally` — a step that throws is the case most likely " +
        "to leave issues behind, and it is the case a trailing cleanup call misses",
    ).toBe(true);
  });

  test("SC-2643: every created artefact has a deletion path", () => {
    // Four issues, a branch and a pull request. Every one is created by this
    // script, so every one must be destroyable by it — the needles name the
    // helper per artefact rather than counting them, because a count goes
    // green when somebody deletes the same thing twice.
    for (const needle of ["deleteIssue", "deleteBranch", "closeIssue"]) {
      expect(src, `nothing in the driver calls ${needle} — an artefact with no deletion path`).toContain(needle);
    }
    // The pull request is closed rather than deleted, because GitHub cannot
    // delete one. Asserted separately so the difference is deliberate.
    expect(src, "a throwaway pull request that was not merged must be closed").toContain(`state: "closed"`);
  });

  // ## `issue_id` is a database id, and passing a number does not fail
  //
  // Caught by `ai-review` on this pull request, and the probe made it worse
  // than the finding said. Measured 2026-11-05 on two throwaway issues,
  // both since deleted:
  //
  //   POST …/issues/1771/dependencies/blocked_by  issue_id=1770
  //     → 200, and 1771's blocked_by became [4]
  //   POST …/issues/1771/dependencies/blocked_by  issue_id=6229750699
  //     → 200, and 1771's blocked_by became [1770]
  //
  // `6229750699` is issue #1770's REST database id. Passing the repo-scoped
  // NUMBER is not rejected — it is resolved as a database id and silently
  // links a DIFFERENT issue. So the walk-through would have created a
  // dependency on an unrelated issue, watched Ready not move, and reported
  // the Ready lane broken. A false reading from the instrument built to
  // stop false readings.
  //
  // Asserted on the source because the alternative is an API call in a unit
  // test. `.number` next to `issue_id` is the whole defect and it is one
  // token.
  test("SC-2643: the dependency link uses the database id, never the issue number", () => {
    const call = /issue_id:\s*([A-Za-z0-9_.]+)/.exec(src);
    expect(call, "no issue_id is passed at all — the blocked_by link is not being created").not.toBeNull();
    expect(
      call![1],
      "`issue_id` on the dependencies endpoint is the REST DATABASE id. A repo-scoped " +
        "number is accepted and resolves to a different issue, so row 2 would watch the " +
        "wrong blocker and report Ready broken. Measured: issue_id=1770 linked #4.",
    ).not.toMatch(/\.number$/);
    expect(call![1], "it must be the id read back from the created issue").toMatch(/\.id$/);
  });

  // ## Row 5 merges into main, so the scratch commit lands on main
  //
  // Caught by `ai-review` on this pull request, second round. Row 5 has to
  // squash-merge into the DEFAULT branch — GitHub's "pull request merged"
  // built-in fires nowhere else — so whatever the throwaway PR contains
  // becomes part of main the moment the walk-through succeeds.
  //
  // With a FIXED scratch path that is a one-shot instrument: run one leaves
  // `.github/walkthrough-scratch.md` on main for good, and run two's
  // `PUT /contents/...` with no `sha` is a 422 because the file already
  // exists. The walk-through would have worked exactly once and then failed
  // forever, with the failure looking like a board problem.
  //
  // Two properties fix it and BOTH are needed. A per-run path means a
  // leftover never blocks a later run — including a leftover from a run
  // that crashed between merge and cleanup, which is the case a `sha`
  // retry does not cover. Deleting it from main afterwards stops the repo
  // accumulating one scratch file per run forever.
  test("SC-2643: the scratch path is unique per run, so a leftover cannot block the next", () => {
    const put = /contents\/([^`"']*)/.exec(src);
    expect(put, "no contents write found — the throwaway commit is not being made").not.toBeNull();
    expect(
      put![1],
      "a FIXED scratch path becomes permanent on main at the first successful merge, " +
        "and every later run 422s creating a file that already exists. Interpolate the " +
        "run stamp into the path.",
    ).toContain("${");
  });

  test("SC-2643: the scratch file is deleted from the default branch after the merge", () => {
    expect(
      src,
      "row 5 merges into main, so the scratch file lands on main. Without a DELETE the " +
        "repository accumulates one per walk-through run, permanently.",
    ).toMatch(/"DELETE",\s*`\/repos\/\$\{repo\}\/contents\//);
  });

  // The run must be reachable ONLY by hand. A schedule is the thing #1744 was
  // filed to remove, and this one creates and deletes real issues.
  test("SC-2643: the walk-through is dispatch-only, never scheduled", () => {
    const yml = readFileSync(join(ROOT, ".github/workflows/board-walkthrough.yml"), "utf-8");
    const live = yml.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
    expect(live, "a cron here would create and delete issues unattended").not.toContain("schedule:");
    expect(live).toContain("workflow_dispatch:");
  });
});
