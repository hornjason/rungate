/**
 * Covers SC-2690, SC-2691, SC-2692 (specs/BOARD-FLOW-SPEC.md).
 *
 * The decider only. It takes a GitHub event and returns the lane that event
 * means, and that is deliberately all it does — the GraphQL that performs
 * the write lives in `scripts/board-flow.ts` and is not a decision.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  LANE_EVENTS,
  identitiesToAuthorise,
  laneFor,
  prEventMayWrite,
  type LaneEvent,
} from "../lib/board-flow";
import { whyNotReady } from "../lib/board-ready-fanout";
import { structuralCut } from "../lib/source-slice";

const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf-8");

describe("one decider owns every lane transition", () => {
  // ## SC-2690 — the mapping, stated as cases rather than as a table
  //
  // Each row is a transition BOARD-FLOW-SPEC.md's lane table declares, and
  // the spec is the reason each is what it is. They are listed out rather
  // than looped over a fixture, because a loop over the decider's own
  // mapping would assert that the code equals itself.
  test("SC-2690: assignment starts work", () => {
    expect(laneFor({ kind: "issue_assigned" }).lane).toBe("In progress");
  });

  test("SC-2690: a non-draft pull request means review, a draft does not reach the decider", () => {
    expect(laneFor({ kind: "pr_ready" }).lane).toBe("In review");
  });

  test("SC-2690: a completed close is Done and an abandoned one is Cancelled", () => {
    expect(laneFor({ kind: "issue_closed", stateReason: "COMPLETED" }).lane).toBe("Done");
    expect(laneFor({ kind: "issue_closed", stateReason: "NOT_PLANNED" }).lane).toBe("Cancelled");
    expect(
      laneFor({ kind: "issue_closed", stateReason: "DUPLICATE" }).lane,
      "the spec's Cancelled condition is `not_planned` OR `duplicate`, and lib/work-status.ts " +
        "already maps both to ABANDONED. Half the condition reads a cancellation as delivery.",
    ).toBe("Cancelled");
  });

  // ## SC-2691 — the reason this is a decider and not three `if`s in YAML
  //
  // *Silent Default Substitution*, in the place it does the most damage. A
  // close whose `state_reason` is absent, misspelled, or a value GitHub adds
  // after this was written is NOT a completed close. Defaulting it to Done
  // overstates throughput and contaminates every cycle-time percentile —
  // which the spec names as the cost of Done being wrong — and it does so
  // silently, because a card in Done looks exactly like a card in Done.
  //
  // `null` here is a refusal: the caller writes nothing and says so.
  test("SC-2691: an unreadable close reason refuses rather than defaulting to Done", () => {
    for (const reason of [null, undefined, "", "ARCHIVED", "not_planned "]) {
      const r = laneFor({ kind: "issue_closed", stateReason: reason as string | null });
      expect(
        r.lane,
        `state_reason ${JSON.stringify(reason)} is not a reason this decider knows. Writing ` +
          `Done for it counts an unknown outcome as delivered, which is the one direction ` +
          `this must never be wrong in.`,
      ).toBeNull();
      expect(r.why).toContain("state_reason");
    }
  });

  test("SC-2691: a refusal still explains itself, so the run is not silent", () => {
    const r = laneFor({ kind: "issue_closed", stateReason: "ARCHIVED" });
    expect(r.lane).toBeNull();
    expect(
      r.why.length,
      "a refusal with no reason is indistinguishable from a transition nobody configured",
    ).toBeGreaterThan(20);
  });

  // ## SC-2692 — one rule, and the test that it IS one rule
  //
  // Jason, 2026-11-05: an item that went backwards has an unknown blocker
  // graph, and Ready's entry condition is a claim about that graph. Both
  // backwards events therefore land in Backlog, where the Ready writer
  // re-checks eligibility and re-promotes on its own.
  test("SC-2692: both backwards events return to Backlog, and to the same lane", () => {
    const reopened = laneFor({ kind: "issue_reopened" });
    const abandoned = laneFor({ kind: "pr_closed_unmerged" });
    expect(reopened.lane).toBe("Backlog");
    expect(
      abandoned.lane,
      "a PR closed unmerged and a reopened issue are the same situation — work whose " +
        "blocker graph nobody has re-checked. Two rules here is two places to get it wrong.",
    ).toBe(reopened.lane);
  });

  // ## Anti-vacuity: the mapping has to be able to disagree with itself
  //
  // Every assertion above would also hold if `laneFor` returned a constant
  // for everything except the refusals. This is the row that cannot.
  test("SC-2690: the decider distinguishes its events rather than returning one lane", () => {
    const lanes = new Set(
      LANE_EVENTS.map(kind => laneFor({ kind, stateReason: "COMPLETED" } as LaneEvent).lane),
    );
    expect(
      lanes.size,
      "a decider that answers the same lane for every event passes every case above that " +
        "happens to expect that lane. Name the number of distinct answers.",
    ).toBeGreaterThan(3);
  });

  test("SC-2690: an event the decider does not know refuses, rather than falling through", () => {
    const r = laneFor({ kind: "wat" as LaneEvent["kind"] });
    expect(r.lane).toBeNull();
    expect(r.why).toContain("wat");
  });

  // ## The workflow must actually route every event the decider handles
  //
  // A decider nothing calls is the shape that let `runVerdict`'s UNMEASURED
  // branch sit unreachable through a whole pull request. Worse here: a
  // trigger missing from the YAML means that lane silently never moves,
  // which is the exact defect this spec was opened about.
  test("SC-2690: the workflow subscribes to every event the decider decides", () => {
    const yml = read(".github/workflows/board-flow.yml");
    for (const t of ["assigned", "closed", "reopened", "ready_for_review"]) {
      expect(
        yml,
        `the decider answers for "${t}" and the workflow never hears about it, so that lane ` +
          `never moves and nothing reports a failure — a silent lane is this spec's subject.`,
      ).toContain(t);
    }
  });

  // GitHub's built-ins and this workflow must not both write a lane. Two
  // writers for one transition is "two deciders that agree": a mutation of
  // either leaves the other holding the case up, and no behavioural test
  // can tell which one is dead.
  test("SC-2690: the workflow records which built-ins had to be switched off", () => {
    const yml = read(".github/workflows/board-flow.yml");
    expect(
      yml,
      "this workflow only owns closed->Done once GitHub's `Item closed` built-in is off. " +
        "If that is not written down next to the code, the next person turns it back on " +
        "and two writers race for the same column.",
    ).toContain("Item closed");
  });

  // ## A pull request's closing references are contributor-authored
  //
  // Both of these come from the security review of the first commit, and
  // both are correctness bugs as well as security ones.
  //
  // The gate in the workflow authorises the ACTOR. For `opened` and
  // `ready_for_review` the actor is the pull request's author, so an outside
  // contributor is already refused. For `closed` the actor is whoever closed
  // it — ordinarily a maintainer — while the closing references still come
  // from the contributor's body. Authorisation and target set are then
  // answered by different parties, which is the confused deputy exactly.
  test("SC-2692: a pull request event cannot drag an issue out of a terminal lane", () => {
    for (const lane of ["Done", "Cancelled"]) {
      const r = prEventMayWrite(lane);
      expect(
        r.allowed,
        `a drive-by pull request whose body says "Fixes #N" would otherwise pull #N out of ` +
          `${lane} the moment any maintainer closed that pull request. It is also wrong on ` +
          `the merits: work that shipped did not become unshipped because somebody else's ` +
          `branch was abandoned.`,
      ).toBe(false);
      expect(r.why).toContain(lane);
    }
  });

  // The anti-vacuity half. A guard that refuses EVERYTHING satisfies the row
  // above and silently switches the whole pull-request half of this workflow
  // off — In review would never be written again and nothing would say so.
  test("SC-2692: the terminal guard still lets ordinary lanes through", () => {
    for (const lane of ["Backlog", "Ready", "In progress", "In review", null]) {
      expect(
        prEventMayWrite(lane).allowed,
        `refusing "${lane}" would turn the pull-request half of this workflow off entirely, ` +
          `which reads exactly like the silent lane this spec exists to end.`,
      ).toBe(true);
    }
  });

  // ## Authorise the party that chose the targets, not only the one who fired
  //
  // The terminal-lane guard above narrows the damage and does not close the
  // hole. A drive-by pull request saying `Fixes #N` where #N sits in Backlog,
  // Ready, In progress or In review still moves #N the moment any maintainer
  // closes that pull request — the lane is not terminal, so the guard passes
  // it, and the card churns on a reference nobody with write access wrote.
  //
  // So for a pull request event BOTH identities are authorised: the one who
  // fired the event, and the one who authored the body the targets came from.
  test("SC-2690: a pull request event authorises its author as well as its actor", () => {
    expect(
      identitiesToAuthorise("pr_closed_unmerged", "maintainer", "drive-by"),
      "authorising only the closer answers a permission question about one party using " +
        "a target set chosen by another. That is the confused deputy, and the terminal-lane " +
        "guard only removes its worst outcome.",
    ).toEqual(["maintainer", "drive-by"]);
  });

  test("SC-2690: an issue event authorises only the actor", () => {
    expect(
      identitiesToAuthorise("issue_closed", "maintainer", null),
      "an issue event carries no contributor-authored target set — the issue IS the " +
        "target. Demanding a second identity here would refuse ordinary maintainer work.",
    ).toEqual(["maintainer"]);
  });

  test("SC-2690: a pull request event with no readable author is UNMEASURED, not just the actor", () => {
    expect(
      identitiesToAuthorise("pr_ready", "maintainer", null),
      "falling back to the actor alone is the silent default: an author nobody could read " +
        "becomes an author nobody checked, and the run reports success.",
    ).toBeNull();
  });

  // A cross-repo `Fixes owner/other#42` is a reference to ANOTHER
  // repository's issue 42, and issue numbers are per-repository. Taking the
  // bare number and resolving it here moves OUR #42 — an unrelated card,
  // picked by a number somebody else chose.
  test("SC-2690: the writer filters closing references to this repository", () => {
    const src = read("scripts/board-flow.ts");
    const fn = structuralCut(src, "async function closingIssues", { balanced: "{" });
    expect(
      fn,
      "`closingIssuesReferences` resolves across repositories, and issue numbers are " +
        "per-repository. Without reading each reference's own repository, `Fixes " +
        "other/repo#42` moves THIS repository's #42 — a card nobody named.",
    ).toContain("repository{owner{login} name}");
    expect(
      fn,
      "reading the reference's repository and not comparing it is the same bug with more " +
        "bytes. The filter is what makes the read mean anything.",
    ).toContain("filter");
  });

  // ## The workflow's shell is EXECUTED here, not described
  //
  // A `run:` block is the one part of this change no TypeScript test
  // reaches, and its failure mode is the worst available: the job runs, the
  // shell aborts, the lane is never written, and nothing on the board says
  // so. `.claude/rules/checks-must-be-able-to-fail.md` calls the written
  // version of this the fixture that is described rather than executed.
  //
  // So the block is cut out of the YAML, the one line that would hit the
  // network is replaced with `echo`, and it is RUN — on this machine's bash
  // 3.2.57, which is stricter than `ubuntu-latest`'s bash 5. A block that
  // survives the strict one survives both; the converse does not hold, and
  // the runner's bash version is not readable from here.
  //
  // This caught a real one: `reason_arg=()` expanded as `"${reason_arg[@]}"`
  // is `unbound variable` under `set -u` before bash 4.4.
  // **The real invoking line is executed, not a copy of it.** The first
  // version of this cut to the invocation as an end anchor and re-appended
  // a hardcoded copy — so the one line that decides what argv the script
  // receives was supplied by the test rather than read from the file. A
  // mutant adding a second array to that line was silently dropped by the
  // cut and the battery read 1 red where 3 was right. A fixture must not
  // describe the runner.
  //
  // It therefore reads to the end of the document, and BINDS that: the last
  // non-empty line must be the invocation. If somebody adds a step after
  // this one, the cut would run past the step and feed YAML to bash — this
  // says so by name instead.
  const runBlock = (): string => {
    const yml = read(".github/workflows/board-flow.yml");
    const at = yml.indexOf("          args=(--repo");
    expect(at, "the workflow's argv-building block moved or was renamed").toBeGreaterThan(-1);
    const dedented = yml
      .slice(at)
      .split("\n")
      .map(l => l.replace(/^ {10}/, ""))
      .join("\n");
    const lines = dedented.split("\n").filter(l => l.trim() !== "");
    expect(
      lines[lines.length - 1],
      "the last non-empty line of the cut is not the script invocation, so the cut has run " +
        "past the end of this step and would feed YAML to bash — or the step no longer ends " +
        "by invoking the script. Either way these cases are measuring the wrong text.",
    ).toMatch(/^bun scripts\/board-flow\.ts /);
    return dedented.replace(/^bun scripts\/board-flow\.ts /m, "echo ARGV ");
  };

  const runWith = (env: Record<string, string>): string => {
    const r = spawnSync("/bin/bash", ["-euo", "pipefail", "-c", runBlock()], {
      env: { ...env, PATH: process.env.PATH ?? "" },
      encoding: "utf-8",
    });
    expect(
      r.status,
      `the workflow's own shell aborted: ${r.stderr}\nA run: block that exits non-zero ` +
        `writes no lane and leaves the board silently stale.`,
    ).toBe(0);
    return r.stdout.trim();
  };

  test("SC-2690: the workflow's shell builds the issue argv without a close reason", () => {
    const out = runWith({
      GITHUB_REPOSITORY: "o/n",
      PROJECT_ID: "PVT_x",
      ACTOR: "someone",
      KIND: "issue_assigned",
      ISSUE: "42",
      PR: "",
      PR_AUTHOR: "",
      STATE_REASON: "",
    });
    expect(out).toBe(
      "ARGV --repo o/n --project PVT_x --actor someone --event issue_assigned --issue 42 --write",
    );
  });

  test("SC-2691: a close carries its reason through, and only when the payload had one", () => {
    const base = {
      GITHUB_REPOSITORY: "o/n",
      PROJECT_ID: "PVT_x",
      ACTOR: "someone",
      KIND: "issue_closed",
      ISSUE: "42",
      PR: "",
      PR_AUTHOR: "",
    };
    expect(runWith({ ...base, STATE_REASON: "not_planned" })).toContain(
      "--state-reason not_planned",
    );
    expect(
      runWith({ ...base, STATE_REASON: "" }),
      "an empty payload value must not become `--state-reason ''`. Both refuse, but only " +
        "omission is honest about what the webhook actually carried.",
    ).not.toContain("--state-reason");
  });

  test("SC-2690: a pull request event carries both the number and the author", () => {
    const out = runWith({
      GITHUB_REPOSITORY: "o/n",
      PROJECT_ID: "PVT_x",
      ACTOR: "maintainer",
      KIND: "pr_closed_unmerged",
      ISSUE: "",
      PR: "99",
      PR_AUTHOR: "drive-by",
      STATE_REASON: "",
    });
    expect(out).toContain("--pr 99 --pr-author drive-by");
    expect(
      out,
      "a pull request event must not also pass --issue: the script reads one target source " +
        "per event kind, and passing both hides which one it used.",
    ).not.toContain("--issue");
  });

  // ## #1921 — a merge is an event, and discarding it leaves a card parked
  //
  // The `closed` arm used to drop a MERGED pull request entirely, on the
  // argument that the issue fires its own `issues: closed` and handling the
  // merge here too would be two writers for one transition. The argument
  // holds only for a merge that actually closes its issue. A pull request
  // carrying `Fixes #N` that merges into a branch other than the default one
  // does NOT close #N — GitHub only applies closing keywords on the default
  // branch — so #N stays open, stays assigned, and its card stays in In
  // review while the work continues. No further event is coming.
  test("#1921 / SC-2690: a merged pull request is an event the decider answers for", () => {
    expect(
      (LANE_EVENTS as readonly string[]).includes("pr_merged"),
      "`scripts/board-flow.ts` validates --event against LANE_EVENTS, so a kind missing from " +
        "this list is refused by the writer however the workflow spells it.",
    ).toBe(true);
    expect(laneFor({ kind: "pr_merged" } as LaneEvent).lane).toBe("In progress");
  });

  // The control the issue asked for by name: the fix must not be "treat
  // every close the same". A merge and an abandonment are opposite outcomes
  // and they must still land in different lanes.
  test("#1921 / SC-2692: a merge and an abandoned pull request do not share a lane", () => {
    expect(
      laneFor({ kind: "pr_merged" } as LaneEvent).lane,
      "a kind the decider refuses answers `null`, which differs from every lane and satisfies " +
        "the row below while witnessing nothing. Name the lane before comparing it.",
    ).not.toBeNull();
    expect(
      laneFor({ kind: "pr_merged" } as LaneEvent).lane,
      "collapsing these two would send delivered work backwards into Backlog on the strength " +
        "of the thing that proves it was not abandoned.",
    ).not.toBe(laneFor({ kind: "pr_closed_unmerged" }).lane);
  });

  // ## Why In progress, and not Backlog with the rest of the movement
  //
  // Backlog is where everything going BACKWARDS lands, because Ready's entry
  // condition is a claim about a blocker graph nobody re-checked, and
  // `board-ready.yml` re-promotes on its own. That self-correction is the
  // whole reason Backlog is safe — and it does not apply here: Ready also
  // requires that nobody has claimed the issue, and an issue whose pull
  // request just merged is still assigned to whoever did the work. Sent to
  // Backlog it would sit there until a person moved it by hand.
  //
  // This is asserted against the Ready writer's own predicate rather than
  // restated, so the day Ready stops excluding assigned issues this case
  // goes red and the lane choice is re-decided rather than inherited.
  test("#1921: Backlog would strand the card, because Ready refuses an assigned issue", () => {
    expect(
      whyNotReady({
        number: 1,
        state: "OPEN",
        blockedByOpen: 0,
        assignees: 1,
        onBoard: true,
        boardStatus: "Backlog",
        phase: null,
        labels: [],
      }),
      "if Ready ever re-promotes an assigned issue, Backlog becomes a legal answer here and " +
        "this lane choice should be re-argued from the spec rather than left as it stands.",
    ).toBe("somebody has claimed it");
    const lane = laneFor({ kind: "pr_merged" } as LaneEvent).lane;
    expect(lane, "a refusal is not a lane choice, and `null` is not Backlog for free").not.toBeNull();
    expect(lane).not.toBe("Backlog");
  });

  // ## The merge that DOES close its issue must still reach Done, either order
  //
  // Two events now fire for one merge, and GitHub orders them however it
  // likes. Both orders are played out here against the real functions rather
  // than reasoned about in a comment, because "the existing guard handles
  // it" is exactly the claim that is cheap to assert and expensive to be
  // wrong about.
  test("#1921 / SC-2692: a merge that closes its issue ends in Done whichever event lands first", () => {
    const play = (order: readonly LaneEvent["kind"][]): string | null => {
      let lane: string | null = "In review";
      for (const kind of order) {
        if (!kind.startsWith("issue_") && !prEventMayWrite(lane).allowed) continue;
        const d = laneFor({ kind, stateReason: "COMPLETED" } as LaneEvent);
        if (d.lane !== null) lane = d.lane;
      }
      return lane;
    };
    // Anti-vacuity first. While `pr_merged` is a kind the decider refuses,
    // the simulator writes nothing for it and BOTH orders reach Done on the
    // close alone — the rows below would pass against the unfixed tree.
    expect(
      play(["pr_merged"]),
      "the merge event must move the card on its own, or the two orderings below are both " +
        "measuring the close and nothing else.",
    ).toBe("In progress");
    expect(
      play(["issue_closed", "pr_merged"]),
      "the close landed first, so the merge event must find Done terminal and write nothing. " +
        "A second writer here would pull delivered work back into In progress.",
    ).toBe("Done");
    expect(
      play(["pr_merged", "issue_closed"]),
      "the merge landed first. The close is an ISSUE event, which the terminal guard does not " +
        "gate, so it still writes Done over In progress.",
    ).toBe("Done");
  });

  test("#1921 / SC-2690: a merged pull request authorises its author as well as its actor", () => {
    expect(
      identitiesToAuthorise("pr_merged" as LaneEvent["kind"], "maintainer", "drive-by"),
      "a merge carries a contributor-authored target set exactly as every other pull request " +
        "event does. A kind that slipped past the `issue_` test would authorise the closer alone.",
    ).toEqual(["maintainer", "drive-by"]);
    expect(
      identitiesToAuthorise("pr_merged" as LaneEvent["kind"], "maintainer", null),
      "an author nobody could read is UNMEASURED here too.",
    ).toBeNull();
  });

  test("#1921: the workflow's shell builds a merge's argv from the pull request, not the issue", () => {
    const out = runWith({
      GITHUB_REPOSITORY: "o/n",
      PROJECT_ID: "PVT_x",
      ACTOR: "maintainer",
      KIND: "pr_merged",
      ISSUE: "",
      PR: "99",
      PR_AUTHOR: "author",
      STATE_REASON: "",
    });
    expect(out).toContain("--pr 99 --pr-author author");
    expect(out).not.toContain("--issue");
  });

  // ## The kind-derivation block is EXECUTED, like the argv block above
  //
  // It is the step that decides whether anything happens at all, and its
  // failure mode is the quiet one: an arm that matches nothing prints a
  // notice saying there was nothing to do, which is byte-identical to the
  // genuine no-transition case. Describing it in TypeScript would measure a
  // copy; this runs the real text on this machine's bash.
  const kindOf = (env: Record<string, string>): string => {
    const yml = read(".github/workflows/board-flow.yml");
    const all = yml.split("\n");
    const at = all.findIndex(l => l === '          kind=""');
    expect(at, "the kind-derivation block moved or was renamed").toBeGreaterThan(-1);
    const body: string[] = [];
    for (const l of all.slice(at)) {
      if (l.trim() !== "" && !l.startsWith("          ")) break;
      body.push(l.replace(/^ {10}/, ""));
    }
    const lines = body.filter(l => l.trim() !== "");
    expect(
      lines[lines.length - 1],
      "the last line of the cut is not the step's output write, so the cut has run past the " +
        "end of the step or the step no longer reports a kind. Either way this measures the " +
        "wrong text.",
    ).toBe('echo "kind=${kind}" >> "$GITHUB_OUTPUT"');

    const dir = mkdtempSync(join(tmpdir(), "board-flow-kind-"));
    try {
      const out = join(dir, "github_output");
      writeFileSync(out, "");
      const r = spawnSync("/bin/bash", ["-euo", "pipefail", "-c", body.join("\n")], {
        env: { ...env, GITHUB_OUTPUT: out, PATH: process.env.PATH ?? "" },
        encoding: "utf-8",
      });
      expect(r.status, `the kind step's own shell aborted: ${r.stderr}`).toBe(0);
      const m = /^kind=(.*)$/m.exec(readFileSync(out, "utf-8"));
      expect(m, "the step wrote no kind= line at all").not.toBeNull();
      return m?.[1] ?? "";
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const prEvent = (over: Record<string, string>): Record<string, string> => ({
    EVENT: "pull_request_target",
    ACTION: "closed",
    DRAFT: "false",
    MERGED: "false",
    BASE_REF: "rg/some-branch",
    DEFAULT_BRANCH: "main",
    ...over,
  });

  test("#1921: the workflow derives a kind for a merge instead of discarding it", () => {
    expect(
      kindOf(prEvent({ MERGED: "true" })),
      "a merged pull request that produced no kind is the defect: the job prints `means no " +
        "lane transition here` and the card it should have moved stays where it was.",
    ).toBe("pr_merged");
  });

  // ## The two events are made mutually exclusive, not serialised — #1922
  //
  // Review round 1 found the hole, and it is a real one this change
  // introduced: `scripts/board-flow.ts` reads the card's current lane, then
  // writes, and the two runs are independent workflow runs with no mutual
  // exclusion. A `pr_merged` run that reads "In review" before the close
  // lands still writes In progress afterwards, and its read-back compares
  // against what IT wrote — so it sees a match and reports success while
  // delivered work sits in In progress. "Either order ends at Done" is only
  // true of orders; it says nothing about overlap.
  //
  // A `concurrency:` group is the obvious fix and the wrong one: GitHub
  // keeps at most ONE pending run per group and cancels the previously
  // pending one, so a burst of three events silently drops the middle lane
  // write — the silent lane this whole file exists to end.
  //
  // The two events are instead made unable to co-occur. **GitHub applies
  // closing keywords only on the DEFAULT branch.** So a merge into the
  // default branch is exactly the case where a close is coming and owns the
  // card, and a merge anywhere else is exactly the case where none is. The
  // fact is in the payload, costs no API call, and leaves one writer per
  // merge rather than two racing.
  test("#1922: a merge into the default branch yields no kind, because the close owns the card", () => {
    expect(
      kindOf(prEvent({ MERGED: "true", BASE_REF: "main", DEFAULT_BRANCH: "main" })),
      "a default-branch merge closes the issues it names, and that close fires its own event. " +
        "Writing In progress from here races that close, and the loser is silent: the read-back " +
        "compares against this run's own value and matches.",
    ).toBe("");
    expect(
      kindOf(prEvent({ MERGED: "true", BASE_REF: "rg/feature", DEFAULT_BRANCH: "main" })),
      "a merge anywhere else closes nothing, so no second event is coming and this is the " +
        "whole of #1921. Suppressing it too would restore the defect.",
    ).toBe("pr_merged");
  });

  test("#1922: an unreadable branch pair is UNMEASURED, and UNMEASURED does not write", () => {
    for (const pair of [
      { BASE_REF: "", DEFAULT_BRANCH: "main" },
      { BASE_REF: "main", DEFAULT_BRANCH: "" },
    ]) {
      expect(
        kindOf(prEvent({ MERGED: "true", ...pair })),
        "an empty string is not a branch name, and two empty strings are not a match. " +
          "Comparing them raw makes an unreadable payload look like a non-default merge, " +
          "which writes In progress into the race. Not moving a card is recoverable; " +
          "overwriting Done is not.",
      ).toBe("");
    }
  });

  test("#1922: the branch pair does not reach the unmerged arm", () => {
    expect(
      kindOf(prEvent({ MERGED: "false", BASE_REF: "main", DEFAULT_BRANCH: "main" })),
      "an abandoned pull request closes no issue whatever branch it targeted, so there is no " +
        "second writer and no reason for the default-branch test to apply here.",
    ).toBe("pr_closed_unmerged");
  });

  // The negative control for the row above. A fix of "emit pr_merged for
  // every close" would pass it and destroy the distinction the decider rests
  // on, so the unmerged close is measured through the same shell.
  test("#1921: an unmerged close is still pr_closed_unmerged, through the same block", () => {
    expect(kindOf(prEvent({ MERGED: "false" }))).toBe("pr_closed_unmerged");
    expect(
      kindOf(prEvent({ MERGED: "" })),
      "GitHub omits `merged` on some payload shapes, and an absent value is not a merge. " +
        "Reading absent as merged would send abandoned work to In progress.",
    ).toBe("pr_closed_unmerged");
  });

  test("#1921: the merge arm did not disturb the events around it", () => {
    expect(kindOf({ EVENT: "issues", ACTION: "closed", DRAFT: "", MERGED: "" })).toBe(
      "issue_closed",
    );
    expect(kindOf(prEvent({ ACTION: "opened", DRAFT: "false" }))).toBe("pr_ready");
    expect(
      kindOf(prEvent({ ACTION: "opened", DRAFT: "true" })),
      "a draft in In review says somebody is waiting on a reader when nobody is.",
    ).toBe("");
  });
});
