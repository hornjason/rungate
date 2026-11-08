#!/usr/bin/env bun
/**
 * Produce the board snapshot `rungate board-conformance` reads (item **B1**).
 *
 * `board-conformance` takes readings; it does not fetch. This is the half
 * that fetches. The split exists for one reason: that command's refusal is
 * proved by a mutation battery that copies its source into a temp directory,
 * so the source must have no relative imports — and the live sources
 * (`lib/spec-placement`, `lib/github`) are imports. Keeping the producer in
 * a sibling file lets the reader stay self-contained and still have a real
 * source.
 *
 * ## Why the phase population is not the issue population
 *
 * The obvious reading for B1 is *every engine issue sits in a milestone*.
 * It cannot fail. The set of "engine issues" is not written down anywhere;
 * the only way to enumerate it is to ask which issues sit in a Pipeline
 * Phase milestone, and a population defined by having a milestone is 100%
 * in a milestone by construction. Measured 2026-11-01: zero issues carry
 * the `engine` label, and the six in Pipeline Phase milestones would have
 * read 6 of 6.
 *
 * The population that can fail is the spec's own criteria. The engine spec
 * places all of them across phases in its Phase placement table, and a
 * phase whose milestone does not exist is a criterion with no home on the
 * board. On 2026-11-01 that read 15 of 26: Pipeline Phase 0-5 existed and
 * phases 6-9 did not.
 *
 * ## It never writes to the tracker
 *
 * `plan-spec --write` is what creates a missing milestone. This reports.
 * A producer that repaired the thing it measures would make the reading
 * true by taking it.
 */
import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { isAbsolute, join } from "path";
import { parseArgs } from "util";
import { describeSpecSource, resolveSpecSource, type GitRunner } from "../lib/spec-source";
import { openFrontier, phaseOf } from "../lib/board-mirror";
import { createGitHubClient, listMilestones } from "../lib/github";
import { readBoardConfig, readBoardInputs, readQueueLabel } from "../lib/config-readers";
import { resolveRepoSlug } from "../lib/branch-cleanup";
import {
  inMilestoneFamily,
  readIssueStates,
  readLiveIssues,
  readMilestonePrefix,
  readProjectFieldIdentity,
  readProjectFieldValues,
  type LiveIssue,
  type ProjectFieldReading,
} from "../lib/live-issues";
import { criterionCoverage, milestonePlan, placementReading, type CriterionCoverage } from "../lib/spec-placement";

/**
 * THE one non-zero exit, declared once so `test/board-snapshot.test.ts` can
 * build a mutant with it set to `0` and prove each refusal is what the case
 * observed (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
export const REFUSAL_EXIT = 1;

/**
 * The GitHub calls, injected so a test can hand this a board without a
 * network and — more to the point — count whether it called anything at all
 * on the paths that are supposed to refuse before reaching the API.
 */
export interface BoardSnapshotGitHub {
  createClient: typeof createGitHubClient;
  listMilestones: typeof listMilestones;
  /** Every OPEN issue in the repository, with its milestone, edges and labels. */
  readIssues: (repo: string) => Promise<LiveIssue[]>;
  /**
   * The state of SPECIFIC issue numbers — #1704.
   *
   * Targeted rather than a second full read. Reading every closed issue to
   * answer the same question costs nine pages against this repository where
   * this costs one call, on a command CI runs and an unattended loop polls.
   *
   * A number naming no issue is ABSENT from the map rather than defaulted,
   * because telling a finished blocker from a typo is the entire point.
   */
  readStates: (repo: string, numbers: readonly number[]) => Promise<Map<number, string>>;
  /** A ProjectV2 field id resolved to its name and owning project — B4. */
  readFieldIdentity: (fieldId: string) => Promise<{ name: string; projectId: string }>;
  /** One project field's value for specific issue numbers — B4. */
  readFieldValues: (
    repo: string,
    numbers: readonly number[],
    projectId: string,
    fieldName: string,
  ) => Promise<Map<number, ProjectFieldReading>>;
}

const LIVE_GITHUB: BoardSnapshotGitHub = {
  createClient: createGitHubClient,
  listMilestones,
  readIssues: repo => readLiveIssues(repo, false),
  readStates: (repo, numbers) => readIssueStates(repo, numbers),
  readFieldIdentity: fieldId => readProjectFieldIdentity(fieldId),
  readFieldValues: (repo, numbers, projectId, fieldName) =>
    readProjectFieldValues(repo, numbers, projectId, fieldName),
};

const USAGE = `rungate board-snapshot <spec.md> --prefix <name> [--repo <owner/name>]

  --prefix   the milestone name prefix, e.g. "Pipeline" for
             "Pipeline Phase 4 — every spec is planned". Required, for the
             reason plan-spec states: deriving it from the filename calls
             the live milestones something they are not.
  --repo     owner/name. Defaults to $GITHUB_REPOSITORY.

The snapshot goes to stdout. It writes no file on purpose: a snapshot
somebody can commit is a snapshot that goes stale, and SC-2619 of
SPEC-TO-BOARD-PIPELINE-SPEC.md refuses a step that reads one.`;

/** One phase of the spec, and whether the board already carries its milestone. */
export interface SnapshotPhase {
  phase: number;
  criteria: string[];
  /** `milestonePlan`'s verdict verbatim; `unchanged` is the conformant one. */
  milestoneState: "create" | "rename" | "update" | "unchanged";
}

/**
 * One engine issue (item **B3**).
 *
 * ## What makes an issue an engine issue, and why it is not the label
 *
 * Membership is *sits in a milestone whose title starts with the prefix*.
 * Not the `engine` label — that is what the `queue-label` reading COUNTS,
 * and a population defined by the predicate it is measured against is 100%
 * conformant by construction. It is the same trap the `milestones` reading
 * walked into: see the note at the top of this file.
 *
 * ## `criteriaField` is read from the project, not from the issue
 *
 * The board's Criteria column is a Projects v2 custom field; the issue query
 * cannot see it, which is why B4 is a second read. The key is PRESENT with a
 * value or `null` when the column was read, and ABSENT when it was not —
 * because no board is configured, because the project read failed, or
 * because that issue's project-item list was cut. `board-conformance` turns
 * the absent key into UNMEASURED, and emitting `null` in those cases would
 * report `0 of N — N short` for a column nobody finished reading.
 */
export interface SnapshotIssue {
  number: number;
  /** The issue numbers that already block this one, live. */
  blockedBy: number[];
  /**
   * True when the issue sits in the lowest phase that carries any engine
   * issue. Derived from the milestone order, not declared: the first phase
   * has nothing before it to be blocked by, so an edge there would be a
   * fiction.
   */
  rootReady: boolean;
  /** Every label on the issue, read rather than assumed empty. */
  labels: string[];
  /**
   * The board's Criteria column for this issue — B4.
   *
   * PRESENT and a string: populated. PRESENT and `null`: read, and either
   * blank or the issue is on no item of this project — both are *the column
   * is not populated*, which is the question `criteria-field` asks. ABSENT:
   * not read, which makes the reading UNMEASURED rather than short.
   */
  criteriaField?: string | null;
}

export interface ProducedSnapshot {
  /** When this was taken. A snapshot with no timestamp cannot be called stale. */
  producedAt: string;
  /** The spec the phases came from, as given. */
  spec: string;
  phases: SnapshotPhase[];
  /** The engine issues — see {@link SnapshotIssue} for what makes one. */
  issues: SnapshotIssue[];
  /**
   * The CLOSED issues at least one engine issue names as a blocker — #1704.
   *
   * ALWAYS emitted, `[]` when there are none. `board-conformance` treats an
   * absent key as "closed issues were never read" and makes
   * `blocked-by-edges` UNMEASURED, so omitting it on an empty list would
   * turn every clean board into a refusal.
   *
   * Only the ones NAMED. Emitting every closed issue in the repository
   * would widen what an edge may resolve to across the whole tracker, so a
   * typo landing on any finished issue would resolve — the defect this
   * fixes, one size larger.
   *
   * Not narrowed to the family. The question is whether the number names a
   * real issue, and an engine issue blocked by another spec's finished work
   * has a resolved edge.
   */
  closedBlockers: number[];
  /**
   * The work-queue label from `board.queueLabel`, or `null` when the
   * project configures none. Resolved HERE because `board-conformance`
   * must stay free of relative imports — its mutation battery copies it
   * into an `mkdtemp` and a relative import makes the mutant fail to load
   * (`.claude/rules/self-referential-tests.md`).
   */
  queueLabel: string | null;
  /**
   * The spec's criteria, and what the board says about each — item **B2**.
   *
   * EMPTY when the Criteria column was not read for every engine issue, or
   * when there was no column to read: `board-conformance` reports that
   * UNMEASURED, which is the true thing to say. Filling it with partial
   * data would make the reading SHORT — a number nobody measured. See
   * {@link criterionCoverage}, which owns that decision.
   */
  criteria: CriterionCoverage[];
}

/**
 * `git -C <root> …`, built per root so the runner cannot be pointed at one
 * checkout while the reading is taken in another.
 *
 * Injected for the same reason {@link BoardSnapshotGitHub} is: a case that
 * reaches a real repository measures whatever this machine happens to be on,
 * and goes green or red for reasons the case never wrote down.
 */
export const LIVE_GIT = (root: string): GitRunner => {
  return args => {
    const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf-8" });
    // `code` carries `status`, and `status` is NULL when the process never
    // ran — no `git` on PATH, or killed by a signal. That is a different
    // fact from any exit code, and `lib/spec-source.ts` refuses on it
    // rather than reading it as an answer about a file.
    return { ok: r.status === 0, code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
};

export async function main(
  argv: string[],
  gh: BoardSnapshotGitHub = LIVE_GITHUB,
  git: (root: string) => GitRunner = LIVE_GIT,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        prefix: { type: "string" },
        repo: { type: "string" },
        "project-root": { type: "string" },
      },
      allowPositionals: true,
    });
  } catch (e) {
    console.error(`board-snapshot: ${(e as Error).message}\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }

  const { values, positionals } = parsed;
  // THE ROOT IS RESOLVED FIRST, because the config under it is now one of
  // the places the arguments come from (#1718). It used to be read after
  // every argument check, which is fine when arguments are the only source
  // and impossible once they are not.
  const root = values["project-root"] ?? process.cwd();
  const configured = readBoardInputs(root);

  // **An argument the caller gave always wins, and a BLANK one still
  // refuses.** Falling back to config on a blank would substitute a value
  // for one somebody typed — `--prefix ""` is a mistake to name, not a
  // request for the default. So the fallback is reached only by absence,
  // which is the one case that carries no instruction to override.
  const specArg = positionals[0] ?? configured.engineSpec ?? undefined;
  if (!specArg) {
    console.error(
      `board-snapshot: no spec given, and no \`board.engineSpec\` in this project's rungate config ` +
        `(read from ${root}). Pass the spec as the first argument, or set \`board.engineSpec\` so the ` +
        `command can take its own reading.\n\n${USAGE}`,
    );
    return REFUSAL_EXIT;
  }
  // ONE reading, trimmed once — the same binding `plan-spec` and `plan-deps`
  // call. `if (!prefix)` was false for `"   "`, so a blank prefix derived
  // milestone titles starting with the space, matched none of the live ones,
  // and reported a conformant board as needing every milestone created.
  // Round 1 of #1705.
  const prefixRead = readMilestonePrefix(values.prefix ?? configured.milestonePrefix ?? undefined);
  if (prefixRead.kind !== "given") {
    console.error(
      prefixRead.kind === "absent"
        ? `board-snapshot: --prefix is required, and no \`board.milestonePrefix\` is set in this ` +
            `project's rungate config (read from ${root})\n\n${USAGE}`
        : `board-snapshot: --prefix was given as ${JSON.stringify(prefixRead.raw)}, which is blank. ` +
            `It would match no milestone on the board and report every phase as missing.\n\n${USAGE}`,
    );
    return REFUSAL_EXIT;
  }
  const prefix = prefixRead.prefix;
  // The third input, same shape: the flag, then the environment CI sets,
  // then the project's own `origin`. `resolveRepoSlug` is the existing
  // binding for that last step and carries its own reason when it fails —
  // a second reader here would be two deciders over one fact.
  //
  // **AND THE SAME BLANK RULE, which review of #1890 found applied to two
  // of the three inputs.** `"" ?? x` keeps `""`, and `resolveRepoSlug`'s
  // own `if (repo && repo.trim())` is falsy for it, so `--repo ""` — a CI
  // line interpolating an unset `$REPO` — fell through to this checkout's
  // `origin` and took a live reading against a repository the caller never
  // named, without even the provenance line, which fires only when the
  // flag was ABSENT. Spelled here rather than inside `resolveRepoSlug`:
  // its other callers may legitimately read a blank as "not given", and
  // this command's contract is that a typed empty is a mistake to name.
  if (values.repo !== undefined && String(values.repo).trim() === "") {
    console.error(
      `board-snapshot: --repo was given as ${JSON.stringify(values.repo)}, which is blank. Falling back to ` +
        `this project's origin would take a reading against a repository you did not name. Pass a value, or ` +
        `omit --repo entirely.\n\n${USAGE}`,
    );
    return REFUSAL_EXIT;
  }
  const slug = resolveRepoSlug({ projectRoot: root, repo: values.repo ?? process.env.GITHUB_REPOSITORY });
  const repo = slug.slug;
  if (!repo) {
    console.error(
      `board-snapshot: --repo is required (or set GITHUB_REPOSITORY). Falling back to this ` +
        `project's origin remote did not resolve one either: ${slug.reason ?? "no reason given"}\n\n${USAGE}`,
    );
    return REFUSAL_EXIT;
  }

  // WHERE EACH INPUT CAME FROM, on stderr so it never reaches the snapshot
  // on stdout. A reading taken from config and one taken from the command
  // line are the same bytes downstream, and only one of them is reproducible
  // by somebody who did not watch you type it.
  const fromConfig = [
    positionals[0] === undefined && configured.engineSpec !== null ? `spec=${specArg} (board.engineSpec)` : null,
    values.prefix === undefined && configured.milestonePrefix !== null
      ? `prefix=${prefix} (board.milestonePrefix)`
      : null,
    slug.source === "origin" ? `repo=${repo} (origin remote of ${root})` : null,
  ].filter((s): s is string => s !== null);
  if (fromConfig.length > 0) {
    console.error(`board-snapshot: resolved from the repository, not the command line — ${fromConfig.join(", ")}`);
  }

  // **THE SPEC COMES FROM `origin/main`, AND THE LINE BELOW SAYS SO** — D3.
  // This was a bare `readFileSync` until 2026-11-08, so every reading it
  // produced was scoped by whichever branch the caller stood on and the
  // output named none of them. A branch mid-edit on a Phase placement table
  // and a branch four days behind main give different numbers against the
  // SAME live board, and both printed as an ordinary reading.
  //
  // Three answers, and the third is the point: a tracked path is read from
  // the ref; an UNTRACKED one is read from disk and said so (a planted
  // fixture has no `origin/main` version, which is a fact about the file);
  // and a failure anywhere in between is UNMEASURED. It does NOT fall back
  // to disk — that is the working-tree read wearing a repair, and it fires
  // in exactly the case where the two disagree most.
  const specPath = isAbsolute(specArg) ? specArg : join(root, specArg);
  const source = resolveSpecSource({ root, absPath: specPath, git: git(root) });
  // ALWAYS, never only on the interesting arm. A provenance line that
  // appears when something is odd teaches the reader that silence means
  // origin/main, and silence is also what a broken emitter looks like.
  console.error(`board-snapshot: ${describeSpecSource(source)}`);
  if (source.kind === "unmeasured") return REFUSAL_EXIT;
  if (source.kind === "untracked" && !existsSync(specPath)) {
    console.error(`board-snapshot: no such spec: ${specPath}`);
    return REFUSAL_EXIT;
  }
  const content = source.kind === "ref" ? source.content : readFileSync(specPath, "utf-8");

  // An unsound placement table is UNMEASURED, not a board with fewer
  // phases. A criterion the table never places, or places twice, makes the
  // denominator wrong in the quiet direction — the reading would go met
  // while the criteria nobody placed have no home at all.
  const placement = placementReading(content);
  if (placement.reading === "UNMEASURED") {
    console.error(
      `board-snapshot: UNMEASURED — ${specArg}'s Phase placement table could not be read:\n` +
        placement.unmeasuredReasons.map(r => `  - ${r}`).join("\n"),
    );
    return REFUSAL_EXIT;
  }
  const unsound = [
    ...placement.unplaced.map(id => `${id} is placed in no phase`),
    ...placement.doubled.map(d => `${d.id} is placed in ${d.placements.join(" and ")}`),
    ...placement.unknown.map(id => `${id} is in the table and stated nowhere`),
    ...placement.unrecognised.map(p => `"${p}" is neither a phase nor a known non-phase placement`),
  ];
  if (unsound.length > 0) {
    console.error(
      `board-snapshot: UNMEASURED — ${specArg}'s Phase placement table is unsound, so the ` +
        `denominator would be wrong:\n` +
        unsound.map(r => `  - ${r}`).join("\n"),
    );
    return REFUSAL_EXIT;
  }

  // A board this could not reach is UNMEASURED and says so by name. An
  // empty milestone list would render identically to a repository whose
  // milestones were all deleted, and those are different facts —
  // `.claude/rules/config-access.md`, Silent Default Substitution.
  let live;
  try {
    live = await gh.listMilestones(gh.createClient(), repo);
  } catch (e) {
    console.error(
      `board-snapshot: UNMEASURED — could not read ${repo}'s milestones: ${(e as Error).message}. ` +
        `That is not a repository with no milestones.`,
    );
    return REFUSAL_EXIT;
  }

  // Same refusal, same reason: a repository whose issues could not be read
  // and one with no issues produce the same empty array, and only one of
  // them is a reading.
  let liveIssues;
  try {
    liveIssues = await gh.readIssues(repo);
  } catch (e) {
    console.error(
      `board-snapshot: UNMEASURED — could not read ${repo}'s issues: ${(e as Error).message}. ` +
        `That is not a repository with no engine issues.`,
    );
    return REFUSAL_EXIT;
  }

  // The population: a milestone in this spec's family that carries a phase
  // number. `inMilestoneFamily` is the single binding `plan-deps` also
  // calls — it anchors on `<prefix> Phase `, so a family whose name merely
  // begins with this one is out. `phaseOf` is still required on top: a
  // hand-made `Pipeline Phase X` has no place in an order.
  const engine = liveIssues.filter(
    i => inMilestoneFamily(i.milestone, prefix) && phaseOf(i.milestone) !== null,
  );

  // A CUT list is not a short one, on EITHER connection. A blocker past the
  // page boundary makes `blocked-by-edges` count the issue short — or, once
  // somebody adds one edge, met on a list this never saw the end of. A label
  // past the boundary makes `queue-label` read `engine` as absent. One loop
  // over both, because fixing the connection a reviewer names and leaving
  // the next one silent is how this came back in round 1.
  const cut: string[] = [
    ...engine.filter(i => i.blockedByTruncated === true).map(i => `#${i.number} (blockers)`),
    ...engine.filter(i => i.labelsTruncated === true).map(i => `#${i.number} (labels)`),
  ];
  if (cut.length > 0) {
    console.error(
      `board-snapshot: UNMEASURED — a paged list was cut for ${cut.length} issue(s) ` +
        `(${cut.join(", ")}). A row past the page boundary reads as absent.`,
    );
    return REFUSAL_EXIT;
  }

  const frontier = openFrontier(engine.map(i => ({ state: i.state, phase: phaseOf(i.milestone) })));

  // Which absent numbers are FINISHED, rather than never-existed — #1704.
  //
  // Only the edges that did NOT resolve against the engine population are
  // asked about, so this costs one extra call for a handful of numbers
  // rather than paging the whole repository. A number naming no issue at
  // all comes back ABSENT from the map, which is the distinction the
  // reading depends on: a typo stays short.
  // Against the whole OPEN read, not the engine subset of it. An issue
  // outside the milestone family is known OPEN the moment `readIssues`
  // returns, so asking the API about it is a round trip for an answer
  // already in hand — and on a tracker carrying several specs, most of a
  // cross-spec edge list is exactly that. Round 1 of #1706.
  const known = new Set(liveIssues.map(i => i.number));
  const unresolved = [...new Set(engine.flatMap(i => i.blockedBy))].filter(n => !known.has(n));
  let states: Map<number, string>;
  try {
    states = unresolved.length === 0 ? new Map() : await gh.readStates(repo, unresolved);
  } catch (e) {
    console.error(
      `board-snapshot: UNMEASURED — could not resolve ${unresolved.length} blocker number(s) ` +
        `against ${repo}: ${(e as Error).message}. Guessing would make a FINISHED blocker and a ` +
        `typo the same answer, which is the whole reason this read exists.`,
    );
    return REFUSAL_EXIT;
  }
  const named = unresolved.filter(n => (states.get(n) ?? "OPEN") !== "OPEN");

  // The board's Criteria column — item B4.
  //
  // Everything here fails to ABSENT rather than to `null`, and never to a
  // refusal. A tree with no `board` block, a project API that is down, and
  // an item list that was cut are all "this column was not read", which
  // `board-conformance` reports UNMEASURED. Refusing the whole snapshot
  // instead would take `milestones` and `blocked-by-edges` down with it,
  // and both are met and polled unattended; emitting `null` instead would
  // report `0 of N — N short` for a column nobody finished reading.
  const criteria = new Map<number, ProjectFieldReading>();
  const board = readBoardConfig(root);
  if (board !== null && engine.length > 0) {
    try {
      const identity = await gh.readFieldIdentity(board.criteriaFieldId);
      if (identity.projectId !== board.projectId) {
        // Two identifiers in one config block, finally compared. A field
        // from another project would answer, and the answers would look
        // exactly like a reading of this board.
        console.error(
          `board-snapshot: the Criteria column was NOT read — the configured field ` +
            `${board.criteriaFieldId} belongs to project ${identity.projectId}, not to the configured ` +
            `board ${board.projectId}. Reading it would measure another project's column.`,
        );
      } else {
        for (const [number, reading] of await gh.readFieldValues(
          repo,
          engine.map(i => i.number),
          board.projectId,
          identity.name,
        )) {
          criteria.set(number, reading);
        }
      }
    } catch (e) {
      console.error(
        `board-snapshot: the Criteria column was NOT read — ${(e as Error).message}. The ` +
          `criteria-field reading is UNMEASURED; every other reading in this snapshot stands.`,
      );
    }
  } else if (board === null) {
    console.error(
      `board-snapshot: the Criteria column was NOT read — no board.id and board.fields.Criteria in ` +
        `${root}'s rungate config. That is a project with no board, not a board with an empty column.`,
    );
  }

  /** PRESENT only when the column was actually read for this issue. */
  const criteriaKey = (number: number): { criteriaField?: string | null } => {
    const reading = criteria.get(number);
    if (reading === undefined || reading.kind === "truncated") return {};
    return { criteriaField: reading.kind === "value" ? reading.value : null };
  };

  const { actions } = milestonePlan(content, live, prefix);
  const snapshotIssues = engine.map(i => ({
    number: i.number,
    blockedBy: [...i.blockedBy],
    rootReady: frontier !== null && phaseOf(i.milestone) === frontier,
    labels: [...i.labels],
    ...criteriaKey(i.number),
  }));

  // B2's population is inverted out of the SAME readings `criteriaField`
  // emits — one query, one answer about which issue covers what. A second
  // source for the same question would be behaviourally one decider, so no
  // test could tell them apart and a mutation of either would leave the
  // other holding every case up.
  //
  // `columnRead` is the gate, and it is deliberately conjunctive: a board
  // must be configured AND there must be an engine issue to ask about AND
  // every one of them must have come back with a key. A population built
  // from a column read for only some of them would call a criterion
  // uncovered on the strength of a row nobody could read.
  const columnRead =
    board !== null && snapshotIssues.length > 0 && snapshotIssues.every(i => "criteriaField" in i);

  const snapshot: ProducedSnapshot = {
    producedAt: new Date().toISOString(),
    spec: specArg,
    phases: actions.map(a => ({ phase: a.phase, criteria: a.criteria, milestoneState: a.action })),
    issues: snapshotIssues,
    closedBlockers: [...named].sort((a, b) => a - b),
    queueLabel: readQueueLabel(root),
    criteria: criterionCoverage(content, snapshotIssues, columnRead),
  };

  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
