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
import { existsSync, readFileSync, writeFileSync } from "fs";
import { isAbsolute, join } from "path";
import { parseArgs } from "util";
import { createGitHubClient, listMilestones } from "../lib/github";
import { milestonePlan, placementReading } from "../lib/spec-placement";

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
}

const LIVE_GITHUB: BoardSnapshotGitHub = { createClient: createGitHubClient, listMilestones };

const USAGE = `rungate board-snapshot <spec.md> --prefix <name> [--repo <owner/name>] [--out <path>]

  --prefix   the milestone name prefix, e.g. "Pipeline" for
             "Pipeline Phase 4 — every spec is planned". Required, for the
             reason plan-spec states: deriving it from the filename calls
             the live milestones something they are not.
  --repo     owner/name. Defaults to $GITHUB_REPOSITORY.
  --out      write the snapshot here. Default: stdout.`;

/** One phase of the spec, and whether the board already carries its milestone. */
export interface SnapshotPhase {
  phase: number;
  criteria: string[];
  /** `milestonePlan`'s verdict verbatim; `unchanged` is the conformant one. */
  milestoneState: "create" | "rename" | "update" | "unchanged";
}

export interface ProducedSnapshot {
  /** When this was taken. A snapshot with no timestamp cannot be called stale. */
  producedAt: string;
  /** The spec the phases came from, as given. */
  spec: string;
  phases: SnapshotPhase[];
  /**
   * Empty, and deliberately so. B3, B4 and B6 own the issue population and
   * B2 owns the criterion population; until one of them wires its source,
   * an empty array makes its reading UNMEASURED, which is the true thing to
   * say. Filling them with partial data here would make those readings
   * SHORT — a number nobody measured.
   */
  issues: never[];
  criteria: never[];
}

export async function main(argv: string[], gh: BoardSnapshotGitHub = LIVE_GITHUB): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        prefix: { type: "string" },
        repo: { type: "string" },
        out: { type: "string" },
        "project-root": { type: "string" },
      },
      allowPositionals: true,
    });
  } catch (e) {
    console.error(`board-snapshot: ${(e as Error).message}\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }

  const { values, positionals } = parsed;
  const specArg = positionals[0];
  if (!specArg) {
    console.error(`board-snapshot: no spec given\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }
  const prefix = values.prefix;
  if (!prefix) {
    console.error(`board-snapshot: --prefix is required\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }
  const repo = values.repo ?? process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error(`board-snapshot: --repo is required (or set GITHUB_REPOSITORY)\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }

  const root = values["project-root"] ?? process.cwd();
  const specPath = isAbsolute(specArg) ? specArg : join(root, specArg);
  if (!existsSync(specPath)) {
    console.error(`board-snapshot: no such spec: ${specPath}`);
    return REFUSAL_EXIT;
  }
  const content = readFileSync(specPath, "utf-8");

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

  const { actions } = milestonePlan(content, live, prefix);
  const snapshot: ProducedSnapshot = {
    producedAt: new Date().toISOString(),
    spec: specArg,
    phases: actions.map(a => ({ phase: a.phase, criteria: a.criteria, milestoneState: a.action })),
    issues: [],
    criteria: [],
  };

  const text = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (values.out) {
    writeFileSync(isAbsolute(values.out) ? values.out : join(root, values.out), text);
  } else {
    process.stdout.write(text);
  }
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
