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
  unmeasuredReading,
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

  // ## Measured by the first real dispatch, run 42092949455
  //
  // The first dispatch died 0.3s in, on `404 POST /repos/.../issues`, and
  // what it printed was a Bun stack trace. Not the UNMEASURED refusal
  // directly above, which is tested, correct, and was **unreachable**: the
  // throw escaped `main`'s `try` after the `finally`, so no reading was ever
  // handed to `runVerdict`.
  //
  // That is shape three in `.claude/rules/checks-must-be-able-to-fail.md` —
  // an assertion that holds vacuously. The case proved the function refuses;
  // nothing proved the program reaches the function. An instrument built to
  // stop false readings reported its own first failure as a crash.
  //
  // An abort is also NOT the same reading as "no readings". Four rows
  // observed and then a throw is a partial measurement, and the verdict has
  // to say both halves or the next reader re-runs the whole thing.
  test("SC-2641: an aborted run names the act that threw, and is not the same as an empty one", () => {
    const empty = runVerdict([], "create issue A");
    expect(empty.ok).toBe(false);
    expect(
      empty.why,
      "a run that died must name WHICH act died. `404 POST /issues` and `the Ready " +
        "lane did not move` are different problems and the report must not spell them alike.",
    ).toContain("create issue A");
    expect(runVerdict([]).why, "and an abort must be distinguishable from no dispatch at all").not.toContain(
      "create issue A",
    );
  });

  test("SC-2641: an abort after some rows reports the rows it DID observe", () => {
    const v = runVerdict([reading(), reading()], "merge the PR");
    expect(v.ok).toBe(false);
    expect(
      v.why,
      "two rows were genuinely measured before the throw. Discarding them makes a " +
        "partial reading indistinguishable from a dispatch that never started.",
    ).toContain("2");
    expect(v.why).toContain("merge the PR");
  });

  // ## A row whose EVENT never happened is not a lane failure
  //
  // `ai-review` finding `04843009` on PR #1772, and it is the sharpest kind
  // of finding: the code contradicted its own pull request description. A
  // timed-out `awaitMergeable` printed a warning saying row 5 measured
  // nothing, and then recorded row 5 anyway — so the machine-read verdict
  // said "a lane with a writer did not move", naming the Done writer, for a
  // run in which the Done writer was never given an event.
  //
  // Prose in a warning does not correct a verdict. UNMEASURED is a fourth
  // verdict rather than a flag on FAIL, because the two have opposite
  // remedies: FAIL means fix the writer, UNMEASURED means run it again with
  // a bigger budget.
  test("SC-2641: a row whose event never happened is UNMEASURED, not a FAIL", () => {
    const s = step({ n: 5, expect: "Done", writer: "GitHub native" });
    const r = unmeasuredReading(s, "the throwaway pull request never became mergeable");
    expect(r.verdict).toBe("UNMEASURED");
    expect(
      r.verdict,
      "recording it as FAIL blames the Done writer for a merge that branch protection " +
        "refused — the exact false reading this instrument exists to remove",
    ).not.toBe("FAIL");
    expect(reportLines([r]).join("\n")).toContain("never became mergeable");
  });

  test("SC-2641: UNMEASURED does not pass the run, and does not read as a lane failure", () => {
    const s = step({ n: 5, expect: "Done", writer: "GitHub native" });
    const v = runVerdict([unmeasuredReading(s, "CI was still running")]);
    expect(v.ok, "a walk-through that did not measure Done has not shown Done works").toBe(false);
    expect(
      v.why,
      "and it must NOT say a lane with a writer failed to move — that sentence sends the " +
        "next reader to the Done writer, which is not where the problem is",
    ).not.toContain("did not move");
    expect(v.why).toContain("UNMEASURED");
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

  // ## The board credential has no repository scope — measured, not inferred
  //
  // Run `42092949455`, 2026-11-05T19:20:44Z: `404 POST
  // /repos/hornjason/rungate/issues`. `.github/workflows/board-intake.yml`
  // records `RUNGATE_PROJECT_TOKEN` as minted `read:project` on 2026-11-02
  // and later measured carrying project WRITE (run `42039773150`, by the
  // board row it produced). Project scope is not repository scope, and the
  // walk-through is the first thing that ever asked it to write a repo.
  //
  // So the two credentials are separated by what they are each scoped for,
  // rather than one token being asked to carry everything: the PAT reads the
  // board because `GITHUB_TOKEN` cannot read ProjectsV2 at all, and the repo
  // acts use the token that is actually scoped for this repository.
  test("SC-2643: the board read and the repository acts use different credentials", () => {
    expect(
      src,
      "the PAT carries project scope and no repository scope (measured: run 42092949455, " +
        "404 on POST /issues). Asking it to create an issue is asking for a scope it was " +
        "never minted with.",
    ).toContain("repoToken");
    expect(src, "and the board read still needs the PAT, because GITHUB_TOKEN cannot read ProjectsV2").toContain(
      "boardToken",
    );
  });

  test("SC-2643: a thrown act is caught and reported, never left as a stack trace", () => {
    expect(
      /catch\s*\(/.test(src),
      "run 42092949455 printed a Bun stack trace because nothing caught the throw. " +
        "The UNMEASURED verdict exists and was unreachable.",
    ).toBe(true);
    expect(
      src,
      "the catch must feed the failing act's name into runVerdict, or the report says " +
        "something died without saying what",
    ).toMatch(/runVerdict\(readings,\s*\w+/);
  });

  // ## `deleteIssue` needs repository ADMIN, which GITHUB_TOKEN never has
  //
  // Blocking `ai-review` finding on PR #1772. GitHub's `deleteIssue` GraphQL
  // mutation requires the actor to hold the repository Admin role, and
  // `GITHUB_TOKEN` cannot be granted that by any `permissions:` block — the
  // ceiling is `write`. So moving the repository acts onto `GITHUB_TOKEN`
  // fixed issue CREATION and silently broke issue DELETION, and the symptom
  // is three throwaway issues left on the tracker per run.
  //
  // That matters beyond tidiness: the spec's whole Cancelled argument rests
  // on the cancellation rate being observable, and throwaway `not_planned`
  // closes pollute exactly that number. The fallback below is damage
  // control, not a fix — a self-cleaning walk-through needs a credential
  // carrying repository admin, and the driver has to say so out loud rather
  // than leave a `::warning::` nobody reads.
  test("SC-2643: a refused deletion falls back to closing, and says admin is why", () => {
    expect(
      src,
      "deletion will be refused for GITHUB_TOKEN on every run. Leaving the issue OPEN " +
        "puts throwaway work in the pickable set, which is worse than a closed one.",
    ).toMatch(/could not DELETE[\s\S]{0,400}not_planned|not_planned[\s\S]{0,400}could not DELETE/);
    expect(
      src,
      "and the warning must name ADMIN as the requirement, or the next reader re-derives " +
        "it from a 403 that does not say so",
    ).toMatch(/[Aa]dmin/);
  });

  test("SC-2643: row 5 is recorded as UNMEASURED when the merge never happened", () => {
    expect(
      src,
      "the driver must build an UNMEASURED reading for row 5 on a merge that did not " +
        "happen, not call record() and let the lane take the blame",
    ).toContain("unmeasuredReading");
  });

  // The run must be reachable ONLY by hand. A schedule is the thing #1744 was
  // filed to remove, and this one creates and deletes real issues.
  // ## Probe the credential before creating three things it may not remove
  //
  // Automated security review of the pushed commit, finding 2: the driver
  // was fail-open on a precondition it could cheaply have checked. "If the
  // widening has not happened the first act 404s" is true for issue
  // CREATION and says nothing about DELETION — the two need different
  // scopes, and the bad case is precisely the one where create works and
  // delete does not. That case strands three issues.
  //
  // **`permissions.admin` from `GET /repos/{repo}` is NOT the probe**, and
  // reaching for it would be the wrong fix that goes green. That field
  // reports the authenticated USER's role, and Jason is the owner, so a
  // classic PAT carrying no `repo` scope at all still reads
  // `admin: true` against a public repository while every write 404s. It
  // would pass in exactly the state it exists to catch.
  //
  // So the probe is the act itself: create ONE throwaway and delete it. It
  // exercises both scopes end to end, it leaves nothing behind when it
  // succeeds, and when it fails it has stranded one issue instead of three.
  test("SC-2643: the credential is probed by a real create-and-delete before anything else", () => {
    // Comments stripped first. The prose in the driver explains WHY the
    // permissions field is the wrong probe, and that explanation contains
    // the very string this forbids — a needle that matches the warning
    // against itself. Same shape as the markdown-emphasis miss on #1769:
    // search the code, never the commentary about the code.
    const code = src
      .split("\n")
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(
      code,
      "a capability probe must EXERCISE create and delete, not read a permissions field. " +
        "`permissions.admin` reports the user's role and reads true for an owner's token " +
        "that has no repo scope at all — it passes in the state it exists to catch.",
    ).not.toMatch(/permissions\s*[?.]*\.admin/);
    expect(
      src,
      "nothing calls a probe — the driver still creates three issues before discovering " +
        "whether it can remove any of them",
    ).toMatch(/probe/i);
  });

  // ## The deletion credential must be one that CAN hold admin
  //
  // `ai-review` raised the admin finding twice, and the second time it was
  // right about something the first fix dodged: a fallback does not excuse a
  // primary path that fails **deterministically**. Calling `deleteIssue`
  // with `GITHUB_TOKEN` is not a cleanup attempt, it is a known-futile call
  // whose failure handler is doing all the work.
  //
  // Jason's call, 2026-11-05: widen `RUNGATE_PROJECT_TOKEN` to carry `repo`
  // as well as `project`. As the repository owner that credential then holds
  // admin, so it can create, delete, open a pull request and merge — and it
  // is also the only credential that can read ProjectsV2. One token, every
  // act, each one actually permitted.
  //
  // The failure mode if the widening has not happened yet is GOOD: the very
  // first act 404s, the abort verdict names it, and **nothing is created**,
  // so there is nothing to strand. That is strictly better than creating
  // three issues with a token that cannot remove them.
  test("SC-2643: the repository acts do not run on a token that cannot delete", () => {
    const yml = readFileSync(join(ROOT, ".github/workflows/board-walkthrough.yml"), "utf-8");
    const repoTokenLine = yml.split("\n").find(l => l.includes("REPO_TOKEN:")) ?? "";
    expect(repoTokenLine, "REPO_TOKEN is not set at all — the driver refuses without it").not.toBe("");
    expect(
      repoTokenLine,
      "`deleteIssue` requires repository ADMIN and GITHUB_TOKEN can never hold it at any " +
        "permissions setting, so wiring it here makes the primary cleanup path fail on every " +
        "single run and leaves the catch doing the work. Use the PAT, which can.",
    ).not.toContain("secrets.GITHUB_TOKEN");
  });

  test("SC-2643: the walk-through is dispatch-only, never scheduled", () => {
    const yml = readFileSync(join(ROOT, ".github/workflows/board-walkthrough.yml"), "utf-8");
    const live = yml.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
    expect(live, "a cron here would create and delete issues unattended").not.toContain("schedule:");
    expect(live).toContain("workflow_dispatch:");
  });
});
