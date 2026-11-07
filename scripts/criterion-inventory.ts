#!/usr/bin/env bun
/**
 * The criterion inventory: for every criterion in one spec, what state it is
 * in and who has been near it.
 *
 *   bun scripts/criterion-inventory.ts [--snapshot <dir>] [--spec <path>] [--json]
 *
 * ## It takes its own reading — SC-2619, item D1
 *
 * The three readings it needs are a full issue list, a full pull-request list,
 * and the changed files of every pull request that names a criterion. Until
 * #1718 all three were assembled by hand: the header printed two `gh`
 * commands to copy, the run reported which pull requests were still
 * UNCLASSIFIED, and you appended one line per pull request and ran it again.
 *
 * The number that came out on 2026-10-30 was therefore reproducible by nobody
 * else. Nothing in the directory, and nothing in the output, said which
 * tracker it was taken from, when, or whether a line had been edited after
 * the fetch. That is the defect SC-2619 names, and it is the same shape as
 * the one in `.claude/rules/config-access.md`: a reading nobody can retake is
 * not a measurement.
 *
 * So with no `--snapshot` the command fetches all three itself and writes
 * nothing. The changed-file read is still one API call per pull request, and
 * it is still only taken for the pull requests that NAME a criterion — which
 * the command now works out for itself by running the inventory once against
 * an empty classification and asking it which numbers it could not place.
 *
 * ## `--snapshot <dir>` is a cache this command owns, not an input you build
 *
 * Pass it and the first run writes the three readings there, beside a
 * {@link PROVENANCE} file recording when and from which repository. A later
 * run reads them back and makes no API call at all.
 *
 * A directory holding those readings WITHOUT that file was assembled by
 * something other than this command, and is a **refusal naming the
 * directory** — not a measurement. Deleting the directory, or dropping
 * `--snapshot`, is the remedy, and the refusal says so.
 *
 * ## Which absences are refusals, and which are the first pass
 *
 * `issues.json` or `prs.json` missing — or present and empty — is a
 * **refusal**. Both are taken in one shot, so an empty reading means the
 * fetch failed, and a pull-request list that silently came back empty would
 * report every criterion as NOT STARTED: the one direction that reads as
 * good news.
 *
 * `pr-files.jsonl` missing is **not**. It is the normal state of a cache
 * written before any pull request named a criterion, and refusing on it
 * made the old hand recipe circular — the file could only be filled from a
 * reading that would not run until the file existed. It is read as empty
 * and every merged pull request is unclassified, which the run says by
 * name. Both halves were raised by the required reviewer on #1642.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { ghWithoutGhToken } from "../lib/live-issues";
import { hasContent, isIsoDay, parseCriteria } from "../lib/spec-evidence";
import { oneScMentionPattern } from "../lib/sc-ids";
import { localCalendarDay } from "../lib/local-calendar-day";

/** Every refusal exits through this, so a test can mutate one site. */
export const EXIT_REFUSED = 1;

/**
 * The day this report is anchored to — **UTC, explicitly**, and the only
 * place this script decides it.
 *
 * `waiverProblem` compares `waiver.until < today`, and `waiver.until` is
 * validated by `isIsoDay` in `lib/spec-evidence.ts` under a UTC convention.
 * A bare `localCalendarDay()` returns the day the RUNNER is living in, so
 * the two sides of that comparison were anchored differently: a waiver
 * reading `2026-10-28`, read at 02:00Z on the 29th from Los Angeles, is
 * live here and expired to `scripts/audit-spec-evidence.ts` — which anchors
 * UTC and whose comment calls itself the one place the anchoring is
 * decided. That is the same defect #1639 fixed in that gate, reintroduced
 * in a second reader of the same field, which is what makes it a class
 * rather than a bug: two deciders, one question, and whichever one you run
 * is the answer you get. Raised by the required reviewer on #1642.
 *
 * The display stamp uses it too. A report whose heading says one day while
 * its expiry maths uses another is the drift in miniature.
 */
export function inventoryToday(at: Date = new Date()): string {
  return localCalendarDay(at, "UTC");
}

export const STATES = [
  "DONE",
  "WAIVED",
  "BOUND",
  "TOUCHED",
  "DOCUMENT ONLY",
  "NOT STARTED",
] as const;
export type State = (typeof STATES)[number];

/**
 * A pull request counts as having changed code when it touched one of these.
 * Everything else — `specs/`, `docs/`, `reference/`, a README — is writing
 * about the criterion rather than building it, and the distinction is the
 * whole reason TOUCHED and DOCUMENT ONLY are different columns: six of the
 * most-cited pull requests in this repository are spec revisions that name
 * every id in the document by construction.
 */
export const CODE_DIRS = [
  "lib",
  "test",
  "scripts",
  "gates",
  "hooks",
  "bin",
  "workflows",
  "config",
  "evals",
  "prompts",
  ".github",
] as const;

export function changedCode(files: readonly string[]): boolean {
  return files.some(f => CODE_DIRS.some(d => f.startsWith(`${d}/`)));
}

export interface Tracked {
  number: number;
  title: string;
  body: string | null;
  state: string;
  mergedAt?: string | null;
}

export interface InventoryRow {
  id: string;
  ticked: boolean;
  waived: boolean;
  needs: string | null;
  provedBy: string | null;
  text: string;
  openIssues: number[];
  closedIssues: number[];
  mergedPrs: number[];
  tests: string[];
  state: State;
  /**
   * Why a waiver on this row does not settle it, or `null`.
   *
   * Reported rather than silently swallowed: a row that falls out of WAIVED
   * looks identical to one that never had a waiver, and those are different
   * facts. The script prints these by name.
   */
  waiverProblem: string | null;
}

export interface Snapshot {
  issues: Tracked[];
  prs: Tracked[];
  /** PR number → whether that PR changed code. Absent = unclassified. */
  prChangedCode: Record<number, boolean>;
}

/**
 * Why a waiver does not settle this criterion — or `null` if it does.
 *
 * Three ways a waiver fails to settle anything, all raised by the required
 * reviewer on #1642 and all of them states `lib/spec-evidence.ts` already
 * treats as violations:
 *
 * - **It sits on an unticked box.** `parseCriteria` records a waiver whenever
 *   any `waived-*` field appears, ticked or not, deliberately — *"a
 *   half-written waiver on an unticked criterion is still a waiver nobody can
 *   act on"*. Reading that as a settled state is the opposite of what the
 *   annotation means.
 * - **It is incomplete.** All three of reason, signer and expiry must carry
 *   content, or `evidenceViolations` refuses it.
 * - **It has expired.** `lib/spec-evidence.ts`: a waiver past its date is *"a
 *   violation again"*. An expired excuse reading as a settled state is the
 *   single most flattering way this report could be wrong.
 *
 * `today` is passed in rather than read, so the expiry boundary is testable
 * and so this function has no clock of its own.
 */
export function waiverProblem(
  row: Pick<InventoryRow, "ticked">,
  waiver: { reason: string; by: string; until: string } | null,
  today: string,
): string | null {
  if (!waiver) return null;
  if (!row.ticked) return "a waiver on an unticked criterion settles nothing";
  const missing = (["reason", "by", "until"] as const).filter(k => !hasContent(waiver[k]));
  if (missing.length > 0) return `the waiver is missing: ${missing.join(", ")}`;
  if (!isIsoDay(waiver.until)) return `\`waived-until: ${waiver.until}\` is not a real day`;
  if (waiver.until < today) return `the waiver expired on ${waiver.until}`;
  return null;
}

export function classify(
  row: Omit<InventoryRow, "state">,
  prChangedCode: Record<number, boolean>,
): State {
  // A waiver settles the row only when nothing is wrong with it. Otherwise it
  // falls through the ladder on its other evidence, and `waiverProblem` says
  // why — an expired or misplaced waiver must never read as settled.
  if (row.waived && row.waiverProblem === null) return "WAIVED";
  // DONE requires the proof, not just the tick. A ticked criterion whose
  // waiver has expired would otherwise land in DONE — a worse reading than
  // the one the expiry check was added to prevent. A tick with neither proof
  // nor a standing waiver falls through on its other evidence, and the script
  // names it as a false tick rather than letting it pass as finished.
  if (row.ticked && hasContent(row.provedBy ?? null)) return "DONE";
  if (row.tests.length > 0) return "BOUND";
  if (row.mergedPrs.some(n => prChangedCode[n] === true)) return "TOUCHED";
  if (row.mergedPrs.length > 0 || row.openIssues.length > 0 || row.closedIssues.length > 0) {
    return "DOCUMENT ONLY";
  }
  return "NOT STARTED";
}

export function inventory(
  specText: string,
  snapshot: Snapshot,
  testFiles: readonly { file: string; content: string }[],
  today: string,
): InventoryRow[] {
  return parseCriteria(specText).map(c => {
    const names = oneScMentionPattern(c.id);
    const hits = (xs: readonly Tracked[]) =>
      xs.filter(x => names.test(x.title) || names.test(x.body ?? ""));
    const issues = hits(snapshot.issues);
    const prs = hits(snapshot.prs);
    const partial: Omit<InventoryRow, "state"> = {
      id: c.id,
      ticked: c.ticked,
      waived: Boolean(c.waiver),
      needs: c.needs,
      provedBy: c.provedBy,
      text: c.text,
      openIssues: issues.filter(i => i.state === "OPEN").map(i => i.number),
      closedIssues: issues.filter(i => i.state !== "OPEN").map(i => i.number),
      mergedPrs: prs.filter(p => p.mergedAt).map(p => p.number),
      tests: testFiles.filter(t => names.test(t.content)).map(t => t.file),
      waiverProblem: waiverProblem({ ticked: c.ticked }, c.waiver, today),
    };
    return { ...partial, state: classify(partial, snapshot.prChangedCode) };
  });
}

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

const HEADING: Record<State, string> = {
  DONE: "DONE — ticked, and it names what proved it",
  WAIVED: "WAIVED — ticked against a signed, unexpired excuse",
  BOUND: "BOUND — a test names it, and the box is not ticked",
  TOUCHED: "TOUCHED — a pull request that changed code names it; no test does",
  "DOCUMENT ONLY": "DOCUMENT ONLY — the spec and the tracker discuss it; nothing has been built",
  "NOT STARTED": "NOT STARTED — nothing anywhere names it",
};

/** First sentence only. Three criteria in this spec carry a page of reasoning. */
/**
 * Free text, safe to put in a markdown table cell.
 *
 * Every cell holding text that came out of the spec goes through this. The
 * first version escaped `|` inside `gist()` only, so the criterion text was
 * safe and `proved-by:` and `needs:` — both free-form annotations a human
 * types — were not. One `|` in a `proved-by:` like
 * `371 pass, 0 fail | re-run 2026-10-28` silently misaligns every column to
 * its right in the committed document, which is the failure `gist()` was
 * written to avoid, left in place two cells over. Raised by the required
 * reviewer on #1642.
 */
export function cell(text: string | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
}

function gist(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const cut = flat.match(/^.{0,170}?[.?!](?=\s|$)/);
  const short = cut ? cut[0] : flat.slice(0, 170);
  return cell(short.length < flat.length ? `${short} …` : short);
}

/**
 * Ticked, and neither a `proved-by:` nor a standing waiver holds it up.
 *
 * One exported decider, read by `renderMarkdown()` and by the console branch
 * of `main()`. The first draft spelled the filter only in the console branch,
 * so the committed document — the artefact anybody actually reads — filed a
 * false tick silently under whatever other evidence it happened to have, and
 * a reader of the document could not tell it from an honest row. Raised by
 * the required reviewer on #1642.
 *
 * Two copies of this predicate would be two deciders that agree, so a
 * mutation of either leaves the other holding every case up
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
export function falseTicks(rows: readonly InventoryRow[]): InventoryRow[] {
  return rows.filter(r => r.ticked && r.state !== "DONE" && r.state !== "WAIVED");
}

export function renderMarkdown(
  rows: readonly InventoryRow[],
  snapshot: Snapshot,
  unclassified: readonly number[],
  today: string,
): string {
  const prs = (ns: readonly number[]): string => {
    if (ns.length === 0) return "—";
    const desc = [...ns].sort((a, b) => b - a);
    const shown = desc
      .slice(0, 4)
      .map(n => (snapshot.prChangedCode[n] === false ? `#${n}*` : `#${n}`))
      .join(" ");
    return desc.length > 4 ? `${shown} (+${desc.length - 4})` : shown;
  };
  const issues = (r: InventoryRow): string => {
    if (r.openIssues.length === 0 && r.closedIssues.length === 0) return "—";
    const open = [...r.openIssues].sort((a, b) => b - a).map(n => `**#${n}**`);
    const closed = [...r.closedIssues].sort((a, b) => b - a).slice(0, 3).map(n => `#${n}`);
    const more = r.closedIssues.length > 3 ? ` (+${r.closedIssues.length - 3} closed)` : "";
    return [...open, ...closed].join(" ") + more;
  };
  const evidence = (r: InventoryRow): string => {
    if (r.state === "DONE") return `\`${cell(r.provedBy ?? "")}\``;
    if (r.state === "WAIVED") return "a waiver that still stands";
    if (r.tests.length > 0) return r.tests.map(t => `\`${t.replace(".test.ts", "")}\``).join(" ");
    return "—";
  };

  const n = rows.length;
  const count = (s: State) => rows.filter(r => r.state === s).length;
  const ticked = rows.filter(r => r.ticked).length;
  const ticked0 = falseTicks(rows);
  const out: string[] = [
    "---",
    "doc-type: research",
    "status: active",
    "owner: jason",
    `updated: ${today}`,
    "governs: Increment 1 of the code-review convergence work — which criteria have been started, by which pull request, against which issue",
    "---",
    "",
    "# Increment 1 — what has actually been built, criterion by criterion",
    "",
    "**Generated. Do not hand-edit** — `bun scripts/criterion-inventory.ts --snapshot <dir> --markdown`.",
    "That script's header states the commands that take a snapshot.",
    "",
    `Every criterion in \`specs/CODE-REVIEW-CONVERGENCE-SPEC.md\`, with the issues and the pull`,
    "requests that name it. This is the baseline for a board: one row is one card, and the state",
    "is the column it starts in.",
    "",
    "## The headline",
    "",
    // Counted off `row.ticked` and `falseTicks()`, never off the state
    // buckets. `count("DONE") + count("WAIVED")` is NOT the ticked count: a
    // ticked row with nothing holding it up falls through into BOUND /
    // TOUCHED / DOCUMENT ONLY / NOT STARTED, so the bucket arithmetic
    // reported it as unstarted work and undercounted the ticks — the third
    // instance of this document's own defect class, two readings of one
    // fact drifting because nothing made them agree. Dormant at 0 false
    // ticks and live the moment there is one. Raised by the required
    // reviewer on #1642.
    `${ticked} of ${n} are ticked: ${count("DONE")} name what proved them, ${count("WAIVED")} stand on a waiver` +
      (ticked0.length > 0
        ? `, and **${ticked0.length} have neither** and are listed below.`
        : ", and none are ticked without one or the other."),
    `${count("BOUND")} more have a test naming them and no tick. The rest divide into work that`,
    "touched code, work that exists only as writing, and work nobody has started — and before",
    "this inventory all of them looked identical, because a checkbox has two states.",
    "",
    "## How the state was derived",
    "",
    "Mechanical, from the spec and the tracker only. No judgement is recorded here.",
    "",
    "| State | Rule |",
    "|---|---|",
    "| DONE | ticked, **and** carrying a `proved-by:` naming what ran |",
    "| WAIVED | ticked, with a complete, signed, unexpired waiver |",
    "| BOUND | not ticked, and a file in `test/` names the id |",
    "| TOUCHED | not ticked, no test names it, and a merged pull request that changed code names it |",
    "| DOCUMENT ONLY | not ticked, and every pull request naming it changed only prose |",
    "| NOT STARTED | not ticked, and nothing in the tracker or `test/` names the id |",
    "",
    "A pull request counts as *changing code* when it touched any of " +
      CODE_DIRS.map(d => `\`${d}/\``).join(", ") +
      ". Pull requests marked `*` changed prose only.",
    "",
    "A tick alone never reaches DONE, and an expired or misplaced waiver never reaches WAIVED —",
    "both fall through onto whatever other evidence exists, and the script names them.",
    "",
    "## What this cannot tell you",
    "",
    "Every column is a word-boundary name match, so a pull request naming an id may have *touched*",
    "the criterion rather than satisfied it, and a test naming an id may be citing it in a comment",
    "rather than claiming it. TOUCHED means *somebody has been here*, never *this is nearly done*.",
    "",
    "**The state cannot say how far along something is.** A criterion is a checkbox: done, or not",
    "done. Splitting a broad criterion into narrow ones that can each be proved is a change to the",
    "spec, and it is the main thing this inventory argues for.",
    "",
    `Taken ${today} over ${snapshot.issues.length} issues and ${snapshot.prs.length} pull requests.`,
    unclassified.length === 0
      ? "Every merged pull request named below has a changed-file reading, so the split between" +
        " TOUCHED and DOCUMENT ONLY is complete rather than a lower bound."
      : `${unclassified.length} merged pull request(s) have no changed-file reading, so TOUCHED is a lower bound.`,
    "**Open issues are bold.** Long criteria are cut to their first sentence.",
    "",
  ];

  out.push("## Ticked, with nothing holding the tick up", "");
  if (ticked0.length === 0) {
    out.push(
      "None. Every ticked criterion carries either a `proved-by:` naming what ran or a",
      "complete, signed, unexpired waiver.",
      "",
    );
  } else {
    out.push(
      `${ticked0.length} of the ${rows.length} criteria are ticked and neither a \`proved-by:\` nor a standing`,
      "waiver holds the tick up. Each one is listed again below under whatever other evidence it",
      "has, which is exactly why it is named here first: in the tables, a false tick is",
      "indistinguishable from an honest row.",
      "",
      "| Criterion | Why the tick settles nothing | Filed under |",
      "|---|---|---|",
    );
    for (const r of ticked0) {
      out.push(`| **${r.id}** | ${cell(r.waiverProblem ?? "no proof recorded")} | ${HEADING[r.state]} |`);
    }
    out.push("");
  }

  for (const state of STATES) {
    const group = rows.filter(r => r.state === state);
    out.push(`## ${HEADING[state]} — ${group.length} of ${n}`, "");
    out.push("| Criterion | What it says | Needs | Test naming it | Issues | Merged PRs |");
    out.push("|---|---|---|---|---|---|");
    for (const r of group) {
      out.push(
        `| **${r.id}** | ${gist(r.text)} | ${cell(r.needs)} | ${evidence(r)} | ${issues(r)} | ${prs(r.mergedPrs)} |`,
      );
    }
    out.push("");
  }
  return out.join("\n");
}

/**
 * Every `*.test.ts` under `test/`, at any depth, except fixtures.
 *
 * The first draft used a flat `readdirSync`, which silently skipped the 70
 * test files in `test/unit/`, `test/helpers/` and `test/types/` — a directory
 * entry named `unit` does not end in `.test.ts`, so it was filtered out rather
 * than descended into, and the criteria those files bind read as unbound.
 * Raised by the required reviewer on #1642.
 *
 * `test/fixtures/` is excluded on purpose and not by accident of the glob: a
 * fixture plants criterion ids deliberately, so counting one as a binding
 * would report a criterion as BOUND on the strength of a test's own scratch
 * input.
 */
export function collectTestFiles(testDir: string): { file: string; content: string }[] {
  const out: { file: string; content: string }[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const next = join(dir, entry.name);
      const relNext = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "fixtures") continue;
        walk(next, relNext);
      } else if (entry.name.endsWith(".test.ts")) {
        out.push({ file: relNext, content: readFileSync(next, "utf-8") });
      }
    }
  };
  walk(testDir, "");
  return out;
}

/**
 * The file a snapshot this command took carries, and one assembled by hand
 * does not. Named once, because the writer, the reader and the refusal all
 * have to mean the same file — and the test imports it rather than spelling
 * it again, so a rename cannot leave a case asserting about a filename
 * nothing writes.
 */
export const PROVENANCE = "taken.json";

/** What a `--snapshot` directory turned out to be. */
export type DirState = "empty" | "taken" | "hand";

/**
 * Three states, never two.
 *
 * `empty` is a path with nothing of ours in it — the first run with a cache
 * location, which writes. `taken` is one we wrote. `hand` is readings with
 * no record of where they came from, which is SC-2619's refusal: folding it
 * into `taken` is exactly the silent default the criterion exists to stop,
 * and folding it into `empty` would OVERWRITE somebody's files.
 */
export function dirState(dir: string): DirState {
  if (existsSync(join(dir, PROVENANCE))) return "taken";
  const data = ["issues.json", "prs.json", "pr-files.jsonl"];
  return data.some(name => existsSync(join(dir, name))) ? "hand" : "empty";
}

/** How a `gh` call is made. A parameter so the fetch has a seam. */
export type Exec = (args: readonly string[]) => string;

/**
 * The page size for the two list reads.
 *
 * One number for both, because they are one reading taken in one shot and a
 * limit that differed between them would truncate one list against the
 * other — which reads as criteria nobody has started.
 */
export const FETCH_LIMIT = 3000;

function repoArgs(repo: string | undefined): string[] {
  return repo === undefined ? [] : ["--repo", repo];
}

/** The issue list and the pull-request list, live. */
export function fetchTracked(
  repo: string | undefined,
  exec: Exec = ghWithoutGhToken,
): { issues: Tracked[]; prs: Tracked[] } {
  const limit = String(FETCH_LIMIT);
  const issues = JSON.parse(
    exec(["issue", "list", "--state", "all", "--limit", limit, "--json", "number,title,body,state", ...repoArgs(repo)]),
  ) as Tracked[];
  const prs = JSON.parse(
    exec([
      "pr", "list", "--state", "all", "--limit", limit,
      "--json", "number,title,body,state,mergedAt",
      ...repoArgs(repo),
    ]),
  ) as Tracked[];
  return { issues, prs };
}

/**
 * The changed paths of each pull request named, one call apiece.
 *
 * Only the ones that NAME a criterion are asked for — `main` works that set
 * out by running the inventory once against an empty classification, which
 * is the same `unclassified` list the hand recipe used to print for a person
 * to copy.
 */
export function fetchChangedFiles(
  numbers: readonly number[],
  repo: string | undefined,
  exec: Exec = ghWithoutGhToken,
): Record<number, string[]> {
  const out: Record<number, string[]> = {};
  for (const n of numbers) {
    const raw = JSON.parse(exec(["pr", "view", String(n), "--json", "number,files", ...repoArgs(repo)])) as {
      files?: { path: string }[];
    };
    out[n] = (raw.files ?? []).map(f => f.path);
  }
  return out;
}

/**
 * Write a cache, with the record that makes it one.
 *
 * The raw path lists are written, not the `changedCode` verdict computed
 * from them: storing the verdict would make the cache carry this version of
 * `CODE_DIRS` forever, so widening that list would leave old caches
 * answering with the old one and no reading would say so.
 *
 * {@link PROVENANCE} is written LAST. A run killed partway then leaves a
 * directory in the `hand` state, which refuses — rather than one that looks
 * taken and is half-written.
 */
export function writeSnapshotDir(
  dir: string,
  data: { issues: Tracked[]; prs: Tracked[]; files: Record<number, string[]> },
  meta: { takenAt: string; repo: string | null },
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "issues.json"), JSON.stringify(data.issues));
  writeFileSync(join(dir, "prs.json"), JSON.stringify(data.prs));
  const lines = Object.entries(data.files).map(([n, files]) => JSON.stringify({ number: Number(n), files }));
  writeFileSync(join(dir, "pr-files.jsonl"), lines.length === 0 ? "" : `${lines.join("\n")}\n`);
  writeFileSync(
    join(dir, PROVENANCE),
    `${JSON.stringify({ by: "criterion-inventory", takenAt: meta.takenAt, repo: meta.repo }, null, 2)}\n`,
  );
}

function readSnapshot(dir: string): Snapshot {
  const need = (name: string): string => {
    const path = join(dir, name);
    if (!existsSync(path)) {
      throw new Error(
        `UNMEASURED: ${path} is absent. A snapshot missing either of its two required readings ` +
          `reports criteria as NOT STARTED that the tracker names — see this file's header ` +
          `for the commands that take one.`,
      );
    }
    return readFileSync(path, "utf-8");
  };

  /**
   * Parse a required reading, or refuse by name.
   *
   * `JSON.parse` straight into a `.length === 0` check let two shapes past.
   * Truncated JSON threw an unhandled `SyntaxError` — a stack trace naming
   * neither the snapshot nor the remedy, in place of the careful refusal
   * this function produces for an empty read. And a JSON **object** — a
   * `gh` error payload redirected into the file is the realistic case —
   * has `length === undefined`, and `undefined === 0` is false, so the
   * emptiness guard was silently SKIPPED and the run died later in
   * `issues.filter is not a function`. A failed fetch reading as a
   * measurement is the whole thing this guard exists to stop. Raised by
   * the required reviewer on #1642.
   */
  const readList = (name: string): Tracked[] => {
    const text = need(name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `UNMEASURED: ${join(dir, name)} is not readable JSON (${(err as Error).message}). ` +
          `A truncated or half-written snapshot is a failed fetch, not an empty tracker.`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        `UNMEASURED: ${join(dir, name)} parsed to ${parsed === null ? "null" : typeof parsed}, not an array. ` +
          `\`gh\` writes a JSON array here; an object is usually its error payload redirected into the file.`,
      );
    }
    return parsed as Tracked[];
  };
  const issues = readList("issues.json");
  const prs = readList("prs.json");
  if (issues.length === 0 || prs.length === 0) {
    throw new Error(
      `UNMEASURED: the snapshot holds ${issues.length} issue(s) and ${prs.length} pull ` +
        `request(s). An empty reading is a failed fetch, not an empty tracker.`,
    );
  }
  // An absent `pr-files.jsonl` is the first pass, not a failed fetch: it is
  // populated FROM this script's own UNCLASSIFIED report, so refusing on it
  // made the documented recipe circular — the file could only be filled from
  // a reading that would not run until the file existed. Read as empty, every
  // merged pull request is unclassified and the run says so by name, which is
  // a louder reading than a refusal and not a silent default. The refusal
  // above stays for `issues.json` and `prs.json`, where absent or empty means
  // the fetch failed. Raised by the required reviewer on #1642.
  const prFiles = join(dir, "pr-files.jsonl");
  const prChangedCode: Record<number, boolean> = {};
  for (const line of (existsSync(prFiles) ? readFileSync(prFiles, "utf-8") : "").split("\n")) {
    if (line.trim() === "") continue;
    const parsed = JSON.parse(line) as { number: number; files: string[] };
    prChangedCode[parsed.number] = changedCode(parsed.files);
  }
  return { issues, prs, prChangedCode };
}

/**
 * Take all three readings live, and write them to `dir` when there is one.
 *
 * The changed-file call is taken only for the pull requests that NAME a
 * criterion, and the inventory itself is what says which those are: run it
 * once against an empty classification and `mergedPrs` is exactly the set
 * the id match found. That is the step the hand recipe made a person do, and
 * the reason it is not a second matcher here — a list built by a different
 * predicate from the one that consumes it would quietly ask about the wrong
 * pull requests (`.claude/rules/checks-must-be-able-to-fail.md`, *two
 * deciders*).
 */
function takeReading(
  dir: string | undefined,
  repo: string | undefined,
  specText: string,
  testFiles: { file: string; content: string }[],
  today: string,
): Snapshot {
  const { issues, prs } = fetchTracked(repo);
  const naming = inventory(specText, { issues, prs, prChangedCode: {} }, testFiles, today);
  const want = [...new Set(naming.flatMap(r => r.mergedPrs))].sort((a, b) => a - b);
  const files = fetchChangedFiles(want, repo);
  const prChangedCode: Record<number, boolean> = {};
  for (const [n, paths] of Object.entries(files)) prChangedCode[Number(n)] = changedCode(paths);
  if (dir !== undefined) {
    writeSnapshotDir(dir, { issues, prs, files }, { takenAt: new Date().toISOString(), repo: repo ?? null });
  }
  return { issues, prs, prChangedCode };
}

function main(): number {
  const argv = process.argv.slice(2);
  const dir = flag(argv, "--snapshot");
  const repo = flag(argv, "--repo");
  if (argv.includes("--snapshot") && !dir) {
    console.error("usage: bun scripts/criterion-inventory.ts [--snapshot <dir>] [--spec <path>] [--repo <owner/name>]");
    return EXIT_REFUSED;
  }
  // `--project-root`, not `import.meta.dir/..`, for the reason registering
  // this as a CLI command made load-bearing (#1647). The dispatcher passes
  // the consumer's cwd; without it, `bunx rungate criterion-inventory` would
  // read `node_modules/rungate/test/` and `node_modules/rungate/specs/`, and
  // report RUNGATE's traceability as the consumer's — a full, plausible
  // matrix about a tree the caller has never opened. That is the exact defect
  // `audit-spec-evidence`'s registry entry records catching.
  const root = flag(argv, "--project-root") ?? join(import.meta.dir, "..");
  const specFlag = flag(argv, "--spec");
  if (!specFlag && flag(argv, "--project-root")) {
    console.error(
      "criterion-inventory: --spec is required when --project-root is given. The default " +
        "spec is rungate's own convergence spec, which is not yours.",
    );
    return EXIT_REFUSED;
  }
  const specPath = specFlag
    ? (isAbsolute(specFlag) ? specFlag : join(root, specFlag))
    : join(root, "specs/CODE-REVIEW-CONVERGENCE-SPEC.md");

  const testFiles = collectTestFiles(join(root, "test"));
  if (testFiles.length === 0) {
    console.error(`UNMEASURED: no test files under ${join(root, "test")}. Every criterion would read as unbound.`);
    return EXIT_REFUSED;
  }
  const today = inventoryToday();
  const specText = readFileSync(specPath, "utf-8");

  // SC-2619. A directory holding readings with no record of where they came
  // from is refused by name, and `taken` is the only state that is read back
  // — so the source of every number this prints is either a directory this
  // command wrote or the live API it just called.
  if (dir !== undefined && dirState(dir) === "hand") {
    console.error(
      `UNMEASURED: ${dir} holds a snapshot this command did not take — there is no ${join(dir, PROVENANCE)}, ` +
        `so nothing says which tracker it came from or when, and the numbers would be reproducible by nobody ` +
        `else. Drop --snapshot and the command takes its own reading, or delete ${dir} and pass --snapshot ` +
        `${dir} again to have one written there.`,
    );
    return EXIT_REFUSED;
  }

  let snapshot: Snapshot;
  if (dir !== undefined && dirState(dir) === "taken") {
    snapshot = readSnapshot(dir);
  } else {
    try {
      snapshot = takeReading(dir, repo, specText, testFiles, today);
    } catch (err) {
      // A failed fetch is UNMEASURED and says so. Letting the throw out
      // would print a stack trace naming `gh`, which reads as a crash in
      // this command rather than a tracker it could not reach.
      console.error(
        `UNMEASURED: could not take the reading — ${(err as Error).message}. That is not an empty tracker.`,
      );
      return EXIT_REFUSED;
    }
  }
  const rows = inventory(specText, snapshot, testFiles, today);

  const unclassified = [
    ...new Set(rows.flatMap(r => r.mergedPrs).filter(n => snapshot.prChangedCode[n] === undefined)),
  ].sort((a, b) => a - b);

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ taken: today, rows, unclassified }, null, 2));
    return 0;
  }

  if (argv.includes("--markdown")) {
    // `docs/research/increment-1-criterion-inventory.md` is written by this
    // branch and by nothing else. An earlier draft rendered it from a
    // throwaway script in a scratch directory, which made the committed
    // document a reading nobody could retake — the exact defect the document
    // is about.
    console.log(renderMarkdown(rows, snapshot, unclassified, today));
    return 0;
  }

  console.log(`criterion inventory — ${specPath.split("/").pop()}, ${today} (UTC)`);
  console.log(`  ${rows.length} criteria, ${snapshot.issues.length} issues, ${snapshot.prs.length} PRs read\n`);
  for (const state of STATES) {
    const group = rows.filter(r => r.state === state);
    console.log(`${state} — ${group.length} of ${rows.length}`);
    for (const r of group) {
      const bits = [
        r.tests.length > 0 ? `tests: ${r.tests.join(" ")}` : "",
        r.openIssues.length > 0 ? `open issues: ${r.openIssues.map(n => `#${n}`).join(" ")}` : "",
        r.mergedPrs.length > 0 ? `PRs: ${r.mergedPrs.map(n => `#${n}`).join(" ")}` : "",
      ].filter(Boolean);
      console.log(`  ${r.id.padEnd(9)} ${bits.join("  |  ") || "nothing names it"}`);
    }
    console.log();
  }
  const ticked0 = falseTicks(rows);
  if (ticked0.length > 0) {
    console.log(`FALSE TICKS: ${ticked0.length} criterion(s) are ticked with neither a \`proved-by:\` nor a standing waiver:`);
    for (const r of ticked0) {
      console.log(`  ${r.id} — ${r.waiverProblem ?? "no proof recorded"} (reported as ${r.state})`);
    }
    console.log();
  }
  const waiverProblems = rows.filter(r => r.waiverProblem !== null && !ticked0.includes(r));
  if (waiverProblems.length > 0) {
    console.log("WAIVERS THAT SETTLE NOTHING:");
    for (const r of waiverProblems) console.log(`  ${r.id} — ${r.waiverProblem}`);
    console.log();
  }
  if (unclassified.length > 0) {
    console.log(
      `UNCLASSIFIED: ${unclassified.length} merged PR(s) have no changed-file reading, so ` +
        `TOUCHED is a lower bound. Fetch them:\n  ${unclassified.map(n => `#${n}`).join(" ")}`,
    );
  }
  return 0;
}

if (import.meta.main) process.exit(main());
