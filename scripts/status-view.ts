#!/usr/bin/env bun
/**
 * Where the current plan stands, in one place a person can read without an
 * agent — #2097.
 *
 * One renderer, two outputs:
 *   bun scripts/status-view.ts                        terminal text (what `/board` prints)
 *   bun scripts/status-view.ts --markdown > <f>       the pinned issue's body
 *   bun scripts/status-view.ts --publish <f> --repo owner/name
 *                                                     write <f> into the pinned issue
 *
 * `.github/workflows/status-issue.yml` runs the second and third on every
 * change. Reading and writing are separate invocations so the board token,
 * which the read needs, is never held by the step that writes (ADR-013).
 *
 * ## It follows the plan, not a name
 *
 * The goal and stages come from `project-state.json`. The phases are the
 * milestones in the configured focus family (`board.milestonePrefix`, the
 * setting Ready already orders by), and their one-line meanings come from the
 * spec configured as `board.engineSpec`. Nothing here names a family or a
 * spec. When the plan moves to other work, the config moves and so does the
 * view.
 *
 * ## Unread is never empty
 *
 * Every section is a `Reading`. A source that could not be read renders as
 * UNMEASURED with its reason, never as an empty list: an empty "In progress"
 * is byte-identical to a project with nothing in progress
 * (`.claude/rules/config-access.md`, Silent Default Substitution).
 *
 * Stage verdicts are each item's `done` flag. They are not re-run here:
 * `test/stage-ladder.test.ts` runs every done item's proof command in CI on
 * every pull request, so a `done` that stopped being true is already red
 * there. Re-running roughly forty commands on every issue event would add
 * minutes and decide nothing new.
 */
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readBoardConfig, readBoardInputs, readQueueLabel } from "../lib/config-readers";
import { nextCursor } from "../lib/graphql-cursor";
import { readMilestoneTitle } from "../lib/milestone-title";
import { parseCriteria } from "../lib/spec-evidence";
import { PHASE_VALUE, parsePlacementRows } from "../lib/spec-placement";
import { ladderReport } from "../lib/work-status";

/** The marker that identifies the pinned issue this script owns. */
export const STATUS_MARKER = "<!-- rungate:status-view -->";
/** Longest list a section prints before it links to the rest. */
export const LIST_LIMIT = 10;
/** The label a session puts on an issue it parks for a person to decide (#2138). */
export const NEEDS_DECISION = "needs-decision";
/** Every refusal exits through this. */
export const REFUSAL_EXIT = 1;
/** Where "How this view is made" points: the published package, which every repository using it can open. */
export const PACKAGE_PAGE = "https://www.npmjs.com/package/rungate";
/**
 * This package's own CLI. Not `<root>/bin/rungate.ts`: in a consumer the
 * package is in node_modules and the root has no bin/ (#2330).
 */
const CLI_ENTRY = join(import.meta.dir, "..", "bin", "rungate.ts");

export type Reading<T> = { kind: "READ"; value: T } | { kind: "UNMEASURED"; why: string };

export interface StageLine {
  id: string;
  name: string;
  meaning: string;
  state: "done" | "next" | "later";
  open: string[];
  total: number;
}

export interface PhaseLine {
  number: number;
  title: string;
  meaning: string | null;
  open: number;
  closed: number;
  url: string;
  state: "done" | "current" | "later" | "empty";
  /**
   * For a phase with no issues only: how many criteria the spec's Phase
   * placement table puts in it, and how many of those are unticked (#2147).
   * Absent when the phase has issues, or the spec places nothing in it.
   */
  criteria?: { placed: number; unticked: number };
}

/** A family other than the focus family: its totals, and every phase in it (#2330). */
export interface FamilyLine {
  family: string;
  open: number;
  closed: number;
  phases: PhaseLine[];
}

/** One open issue in a phase, with what still blocks it and who has it (#2330). */
export interface PhaseIssue {
  number: number;
  title: string;
  url: string;
  milestone: string;
  assignees: string[];
  /** Open blockers only: a closed blocker no longer holds anything back. */
  blockers: number[];
  /** The blocked-by list was longer than one page, so `blockers` may be short. */
  moreBlockers: boolean;
}

export interface WorkLine {
  number: number;
  title: string;
  url: string;
  note?: string;
}

export interface HealthLine {
  name: string;
  status: string;
  measured: number;
  target: number;
}

export interface StatusView {
  repo: string;
  generatedAt: string;
  commit: string | null;
  family: string | null;
  goal: Reading<string>;
  stages: Reading<StageLine[]>;
  phases: Reading<PhaseLine[]>;
  otherFamilies: Reading<FamilyLine[]>;
  /** Every open issue that sits in a milestone, for listing under its phase (#2330). */
  phaseIssues: Reading<PhaseIssue[]>;
  inProgress: Reading<WorkLine[]>;
  ready: Reading<WorkLine[]>;
  decisions: Reading<WorkLine[]>;
  unphased: Reading<WorkLine[]>;
  /**
   * What `unphased` holds: queued issues with no milestone when a queue label
   * is configured, or every open issue with no milestone when none is (#2330).
   */
  unphasedScope: "queued" | "all";
  health: Reading<HealthLine[]>;
  /** A link whose address could not be read carries `url: null` and why, rendered as UNMEASURED. */
  links: { label: string; url: string | null; why?: string }[];
}

export interface Milestone {
  title: string;
  open: number;
  closed: number;
  url: string;
}

const read = <T>(value: T): Reading<T> => ({ kind: "READ", value });
const unmeasured = <T>(why: string): Reading<T> => ({ kind: "UNMEASURED", why });

/**
 * The goal and the finish line, from the plan's own text.
 *
 * Well-formedness and the next stage are `ladderReport`'s, the one reader
 * `work-status` also uses, so the two reports cannot disagree about which
 * stage is next.
 */
export function planLines(source: string | null, where: string): { goal: Reading<string>; stages: Reading<StageLine[]> } {
  const report = ladderReport(source, where);
  if (report.kind === "UNMEASURED") return { goal: unmeasured(report.why), stages: unmeasured(report.why) };
  // `ladderViolations` (inside `ladderReport`) has already refused a plan
  // without a goal statement, so this reads it rather than re-checking it.
  const doc = JSON.parse(source as string) as {
    goal: { statement: string };
    stages: { id: string; name: string; goal?: unknown; items: { id: string; done: boolean }[] }[];
  };
  const goal = read(doc.goal.statement.trim());
  const stages = doc.stages.map(s => {
    const open = s.items.filter(i => !i.done).map(i => i.id);
    const state: StageLine["state"] = open.length === 0 ? "done" : s.id === report.next ? "next" : "later";
    return {
      id: s.id,
      name: s.name,
      meaning: typeof s.goal === "string" ? s.goal : "",
      state,
      open,
      total: s.items.length,
    };
  });
  return { goal, stages: read(stages) };
}

/**
 * The first paragraph of a spec's `### Phase N` section, kept to whole
 * sentences within `limit` characters (at least one sentence).
 *
 * Read, never written here. Where that paragraph is jargon, rewriting it is
 * a spec edit, so the fix lands in one place and every reader gets it.
 */
export function phaseBlurb(specText: string, phase: number, limit = 280): string | null {
  const lines = specText.split("\n");
  const at = lines.findIndex(l => new RegExp(`^###\\s+Phase\\s+${phase}\\b`).test(l));
  if (at === -1) return null;
  const para: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    if (line.trim() === "") {
      if (para.length > 0) break;
      continue;
    }
    para.push(line.trim());
  }
  if (para.length === 0) return null;
  // A sentence ends at punctuation FOLLOWED BY WHITESPACE, so the dot in
  // "AGENTS.md" stays inside its sentence.
  const sentences = para.join(" ").split(/(?<=[.!?])\s+/);
  let out = "";
  for (const s of sentences) {
    const next = out === "" ? s : `${out} ${s}`;
    if (out !== "" && next.length > limit) break;
    out = next;
  }
  return out.trim();
}

/**
 * Per phase number, the criteria the spec's Phase placement table puts there
 * and how many are unticked. A placed id the spec never states counts as
 * unticked: a criterion nobody can find has not been shown true.
 */
export function placedCriteria(specText: string): Map<number, { placed: number; unticked: number }> {
  const ticked = new Map(parseCriteria(specText).map(c => [c.id, c.ticked]));
  const out = new Map<number, { placed: number; unticked: number }>();
  for (const row of parsePlacementRows(specText)) {
    const m = row.placement.match(PHASE_VALUE);
    if (m === null || row.ids.length === 0) continue;
    // Summed, not set: a phase whose criteria sit in two rows is judged on both.
    const prev = out.get(Number(m[1])) ?? { placed: 0, unticked: 0 };
    out.set(Number(m[1]), {
      placed: prev.placed + row.ids.length,
      unticked: prev.unticked + row.ids.filter(id => ticked.get(id) !== true).length,
    });
  }
  return out;
}

/**
 * The focus family's phases, in phase order, each with its meaning and progress.
 *
 * A phase with issues is judged by its issues. A phase with none is done only
 * when the spec places criteria in it and every one is ticked (#2147) — work
 * that landed before criteria became issues leaves a milestone empty and the
 * phase finished. Anything less stays "empty", never done.
 */
export function phaseLines(milestones: readonly Milestone[], family: string, specText: string | null): PhaseLine[] {
  const mine = milestones
    .map(m => ({ m, r: readMilestoneTitle(m.title) }))
    .filter(x => x.r !== null && x.r.family === family)
    .map(x => ({ m: x.m, number: x.r!.phase }))
    .sort((a, b) => a.number - b.number);
  const current = mine.find(x => x.m.open > 0)?.number;
  const placed = specText === null ? new Map<number, { placed: number; unticked: number }>() : placedCriteria(specText);
  return mine.map(({ m, number }) => {
    const criteria = m.open + m.closed === 0 ? placed.get(number) : undefined;
    const state: PhaseLine["state"] =
      m.open + m.closed === 0
        ? criteria !== undefined && criteria.unticked === 0
          ? "done"
          : "empty"
        : m.open === 0
          ? "done"
          : number === current
            ? "current"
            : "later";
    return {
      number,
      title: m.title,
      meaning: specText === null ? null : phaseBlurb(specText, number),
      open: m.open,
      closed: m.closed,
      url: m.url,
      state,
      ...(criteria === undefined ? {} : { criteria }),
    };
  });
}

/**
 * Every family other than the focus family, with its phases (#2330).
 *
 * A consumer's own work is usually NOT the focus family: the focus is the
 * family Ready orders by, and on 2026-11-17 the one consumer had it set to a
 * family whose phases were all closed. Shown as a count, its open family read
 * `3 phase(s), 0 of 22 done` and named none of the 22 issues. The renderer
 * collapses a family only when nothing in it is open.
 */
export function otherFamilyLines(milestones: readonly Milestone[], family: string): FamilyLine[] {
  const names = new Set<string>();
  for (const m of milestones) {
    const f = readMilestoneTitle(m.title)?.family ?? null;
    if (f !== null && f !== "" && f !== family) names.add(f);
  }
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map(f => {
      const phases = phaseLines(milestones, f, null);
      return {
        family: f,
        open: phases.reduce((n, p) => n + p.open, 0),
        closed: phases.reduce((n, p) => n + p.closed, 0),
        phases,
      };
    });
}

/**
 * Repository text made safe to place in the issue body.
 *
 * Titles are written by anyone who can open an issue. Unescaped, an
 * `@name` would notify that person on every rewrite, and brackets or angle
 * brackets would let a title inject a link or markup into the pinned view.
 *
 * **Criterion ids are broken with a non-breaking hyphen.** The pinned view is
 * an open issue, and every reader that asks "does an open issue name SC-N?"
 * reads its body. A title or spec sentence quoting `SC-2752` would make this
 * issue cover that criterion for as long as it stays open, which is forever,
 * so a real gap would never show again. `SC‑2752` (U+2011) reads the same and
 * matches no id pattern.
 */
export function plain(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([[\]`*_|\\])/g, "\\$1")
    .replace(/@/g, "@&#8203;")
    .replace(/\b([A-Z]{2,5})-([A-Z]?\d+)\b/g, "$1‑$2");
}

/** Terminal text: control characters only, so an escape code cannot redraw the screen. */
function term(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

/** The note after an open issue in a phase: its open blockers, then who has it. */
function issueNote(i: PhaseIssue): string {
  const notes: string[] = [];
  if (i.blockers.length > 0) notes.push(`blocked by ${i.blockers.map(n => `#${n}`).join(", ")}${i.moreBlockers ? " and more" : ""}`);
  else if (i.moreBlockers) notes.push("blocked by more than one page of issues");
  if (i.assignees.length > 0) notes.push(i.assignees.join(", "));
  return notes.join("; ");
}

const STAGE_MARK = { done: "✓", next: "●", later: "○" } as const;
const PHASE_MARK = { done: "✓", current: "●", later: "○", empty: "–" } as const;

type Fmt = {
  text: (s: string) => string;
  heading: (s: string) => string;
  link: (label: string, url: string) => string;
  item: (s: string) => string;
  /** A list item nested `depth` levels under an item. */
  sub: (depth: number, s: string) => string;
};

const MARKDOWN: Fmt = {
  text: plain,
  heading: s => `### ${s}`,
  link: (label, url) => `[${plain(label)}](${url})`,
  item: s => `- ${s}`,
  sub: (depth, s) => `${"  ".repeat(depth)}- ${s}`,
};

const TEXT: Fmt = {
  text: term,
  heading: s => `\n${s}\n${"─".repeat(s.length)}`,
  link: (label, url) => `${term(label)} (${url})`,
  item: s => `  ${s}`,
  sub: (depth, s) => `${"    ".repeat(depth)}  ${s}`,
};

function section<T>(f: Fmt, title: string, r: Reading<T>, body: (v: T) => string[]): string[] {
  const out = [f.heading(title)];
  if (r.kind === "UNMEASURED") out.push(f.item(`UNMEASURED — ${f.text(r.why)}`));
  else out.push(...body(r.value));
  return out;
}

function workList(f: Fmt, lines: WorkLine[], empty: string, more?: string): string[] {
  if (lines.length === 0) return [f.item(empty)];
  const shown = lines.slice(0, LIST_LIMIT).map(w =>
    f.item(`${f.link(`#${w.number}`, w.url)} ${f.text(w.title)}${w.note ? ` — ${f.text(w.note)}` : ""}`),
  );
  if (lines.length > LIST_LIMIT) {
    shown.push(f.item(`… and ${lines.length - LIST_LIMIT} more${more ? ` (${more})` : ""}`));
  }
  return shown;
}

/** A phase's line, its meaning, and the open issues in it, at list depth `depth`. */
function phaseBlock(f: Fmt, p: PhaseLine, issues: Reading<PhaseIssue[]>, markdown: boolean, depth: number): string[] {
  const total = p.open + p.closed;
  const c = p.criteria;
  const why =
    c === undefined
      ? ""
      : c.unticked === 0
        ? `; its ${c.placed} criteria are ticked`
        : `; ${c.unticked} of its ${c.placed} criteria unticked`;
  const progress = total === 0 ? `no issues${why}` : `${p.closed} of ${total} done`;
  const line = `${PHASE_MARK[p.state]} ${f.link(p.title, p.url)} — ${progress}`;
  const out = [depth === 0 ? f.item(line) : f.sub(depth, line)];
  if (p.meaning) out.push(`${markdown ? "  ".repeat(depth + 1) : "    ".repeat(depth) + "      "}${f.text(p.meaning)}`);
  if (issues.kind === "READ" && p.open > 0) {
    const mine = issues.value.filter(i => i.milestone === p.title);
    for (const i of mine.slice(0, LIST_LIMIT)) {
      const note = issueNote(i);
      out.push(f.sub(depth + 1, `${f.link(`#${i.number}`, i.url)} ${f.text(i.title)}${note ? ` — ${f.text(note)}` : ""}`));
    }
    if (mine.length > LIST_LIMIT) out.push(f.sub(depth + 1, `… and ${mine.length - LIST_LIMIT} more`));
    // A milestone's open count includes pull requests, and the issue read
    // returns issues only, so the difference is said rather than left as a
    // phase that reads open with too little under it (review of #2334).
    const prs = p.open - mine.length;
    if (prs > 0) out.push(f.sub(depth + 1, `and ${prs} open pull request(s), which the milestone counts`));
  }
  return out;
}

/** One line when the open issues could not be read, so a phase without them is not read as a phase without issues. */
function issuesUnread(f: Fmt, issues: Reading<PhaseIssue[]>): string[] {
  return issues.kind === "UNMEASURED" ? [f.item(`open issues per phase: UNMEASURED — ${f.text(issues.why)}`)] : [];
}

function render(v: StatusView, f: Fmt, markdown: boolean): string {
  const out: string[] = [];
  if (markdown) {
    out.push(STATUS_MARKER);
    out.push(
      `> Rewritten from live readings by \`scripts/status-view.ts\` on every change. Do not edit by hand; ` +
        `edits are overwritten. Read at ${v.generatedAt}${v.commit ? ` from \`${v.commit.slice(0, 8)}\`` : ""}.`,
    );
  } else {
    out.push(`Where we are — read at ${v.generatedAt}${v.commit ? ` from ${v.commit.slice(0, 8)}` : ""}`);
  }

  out.push(...section(f, "The goal", v.goal, g => [f.text(g)]));

  out.push(
    ...section(f, "The finish line", v.stages, stages =>
      stages.map(s => {
        const left = s.open.length === 0 ? "" : ` — ${s.open.length} of ${s.total} left: ${f.text(s.open.join(", "))}`;
        const id = markdown ? `**${f.text(s.id)}**` : s.id;
        return f.item(`${STAGE_MARK[s.state]} ${id} ${f.text(s.name)}: ${f.text(s.meaning)}${left}`);
      }),
    ),
  );

  const phaseTitle = v.family === null ? "Phases" : `Phases (${v.family})`;
  out.push(
    ...section(f, phaseTitle, v.phases, phases =>
      phases.length === 0
        ? [f.item(`no milestone is in the ${f.text(v.family ?? "")} family`)]
        : [...issuesUnread(f, v.phaseIssues), ...phases.flatMap(p => phaseBlock(f, p, v.phaseIssues, markdown, 0))],
    ),
  );
  out.push(
    ...section(f, "Other work", v.otherFamilies, fams =>
      fams.length === 0
        ? [f.item("no other milestone family")]
        : [
            ...(fams.some(x => x.open > 0) ? issuesUnread(f, v.phaseIssues) : []),
            ...fams.flatMap(x =>
              x.open === 0
                ? [f.item(`✓ ${f.text(x.family)}: done — ${x.phases.length} phase(s), ${x.closed} closed`)]
                : [
                    f.item(`${f.text(x.family)}: ${x.closed} of ${x.open + x.closed} done`),
                    ...x.phases.flatMap(p => phaseBlock(f, p, v.phaseIssues, markdown, 1)),
                  ],
            ),
          ],
    ),
  );

  out.push(...section(f, "In progress", v.inProgress, w => workList(f, w, "nothing is assigned or in a pull request")));
  out.push(...section(f, "Ready next", v.ready, w => workList(f, w, "nothing is in Ready")));
  out.push(...section(f, "Needs a decision", v.decisions, w => workList(f, w, "nothing is waiting on a decision")));
  out.push(
    ...section(f, "Unphased", v.unphased, w =>
      v.unphasedScope === "queued"
        ? workList(f, w, "every queued issue has a phase", "queued issues with no milestone")
        : w.length === 0
          ? [f.item("every open issue has a milestone")]
          : [f.item(`${w.length} open issue(s) have no milestone; the oldest is ${f.link(`#${w[0].number}`, w[0].url)} ${f.text(w[0].title)}`)],
    ),
  );
  out.push(
    ...section(f, "Health", v.health, h => {
      const met = h.filter(x => x.status === "met").length;
      return [
        f.item(`board checks: ${met} of ${h.length} met`),
        ...h.filter(x => x.status !== "met").map(x => f.item(`${x.status.toUpperCase()} ${x.name}: ${x.measured} of ${x.target}`)),
      ];
    }),
  );
  out.push(
    f.heading("Links"),
    ...v.links.map(l => f.item(l.url === null ? `${f.text(l.label)} — UNMEASURED: ${f.text(l.why ?? "unknown")}` : f.link(l.label, l.url))),
  );
  if (markdown) {
    out.push("", "_This view serves no criterion; it reports on the ones the plan names._");
  }
  return `${out.join("\n")}\n`;
}

/** The pinned issue's body. */
export function renderMarkdown(v: StatusView): string {
  return render(v, MARKDOWN, true);
}

/** What `/board` prints in a terminal: the same sections, no markup. */
export function renderText(v: StatusView): string {
  return render(v, TEXT, false);
}

// ---------------------------------------------------------------------------
// Reading the live sources. Everything below is I/O; everything above is pure.
// ---------------------------------------------------------------------------

type Gh = (args: string[]) => { ok: true; out: string } | { ok: false; why: string };

const liveGh: Gh = args => {
  const r = spawnSync("gh", args, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { ok: false, why: `gh could not start: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, why: `gh ${args[0]} exited ${r.status}: ${(r.stderr ?? "").trim().split("\n")[0]}` };
  return { ok: true, out: r.stdout };
};

function ghJson<T>(gh: Gh, args: string[]): Reading<T> {
  const r = gh(args);
  if (!r.ok) return unmeasured(r.why);
  try {
    return read(JSON.parse(r.out) as T);
  } catch (e) {
    return unmeasured(`gh returned text that is not JSON (${(e as Error).message})`);
  }
}

/** `gh api --paginate` prints one JSON array per page; `--jq '.[]'` makes it one value per line. */
function ghLines<T>(gh: Gh, path: string, jq: string): Reading<T[]> {
  const r = gh(["api", "--paginate", path, "--jq", jq]);
  if (!r.ok) return unmeasured(r.why);
  try {
    return read(r.out.split("\n").filter(l => l.trim() !== "").map(l => JSON.parse(l) as T));
  } catch (e) {
    return unmeasured(`gh returned a line that is not JSON (${(e as Error).message})`);
  }
}

interface OpenItem {
  number: number;
  title: string;
  url: string;
  pr: boolean;
  assignees: string[];
  labels: string[];
  milestone: string | null;
}

export function gather(
  root: string,
  repo: string,
  gh: Gh = liveGh,
  now = new Date(),
  health: (root: string) => Reading<HealthLine[]> = readHealth,
): StatusView {
  const planPath = join(root, "project-state.json");
  const plan = planLines(existsSync(planPath) ? readFileSync(planPath, "utf-8") : null, "project-state.json");
  const { engineSpec, milestonePrefix } = readBoardInputs(root);
  const queueLabel = readQueueLabel(root);
  let specText: string | null = null;
  if (engineSpec !== null && existsSync(join(root, engineSpec))) specText = readFileSync(join(root, engineSpec), "utf-8");

  const milestones = ghLines<Milestone>(
    gh,
    `repos/${repo}/milestones?state=all&per_page=100`,
    ".[] | {title, open: .open_issues, closed: .closed_issues, url: .html_url}",
  );
  const phases: Reading<PhaseLine[]> =
    milestonePrefix === null
      ? unmeasured("board.milestonePrefix is not set, so there is no focus family to show")
      : milestones.kind === "UNMEASURED"
        ? unmeasured(milestones.why)
        : read(phaseLines(milestones.value, milestonePrefix, specText));
  const otherFamilies: Reading<FamilyLine[]> =
    milestones.kind === "UNMEASURED" ? unmeasured(milestones.why) : read(otherFamilyLines(milestones.value, milestonePrefix ?? ""));

  const items = ghLines<OpenItem>(
    gh,
    `repos/${repo}/issues?state=open&per_page=100`,
    ".[] | {number, title, url: .html_url, pr: (.pull_request != null), assignees: [.assignees[].login], labels: [.labels[].name], milestone: .milestone.title}",
  );
  const own = (i: OpenItem) => !i.pr;
  const toLine = (i: OpenItem, note?: string): WorkLine => ({ number: i.number, title: i.title, url: i.url, note });

  const inProgress: Reading<WorkLine[]> =
    items.kind === "UNMEASURED"
      ? unmeasured(items.why)
      : read([
          ...items.value.filter(i => i.pr).map(i => toLine(i, "pull request")),
          ...items.value.filter(i => own(i) && i.assignees.length > 0).map(i => toLine(i, i.assignees.join(", "))),
        ]);

  // With no queue label there is no work queue to check, but an issue with no
  // milestone is still outside every phase: count them, oldest first (#2330).
  const unphased: Reading<WorkLine[]> =
    items.kind === "UNMEASURED"
      ? unmeasured(items.why)
      : read(
          items.value
            .filter(i => own(i) && i.milestone === null && (queueLabel === null || i.labels.includes(queueLabel)))
            .sort((a, b) => (queueLabel === null ? a.number - b.number : 0))
            .map(i => toLine(i)),
        );

  const phaseIssues = readPhaseIssues(gh, repo);

  const decisions = readDecisions(gh, repo, items);
  const ready = readReady(gh, root, items);
  const healthReading = health(root);
  const head = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf-8" });

  const links: StatusView["links"] = [{ label: "Milestones", url: `https://github.com/${repo}/milestones` }];
  // The board's address comes from the API, never built from config: a
  // project owned by an organisation lives under /orgs/, one owned by a user
  // under /users/, and the config does not say which (AI review of #2103).
  const boardConfig = readBoardConfig(root);
  if (boardConfig !== null) {
    const r = ghJson<{ data?: { node?: { url?: string } } }>(gh, [
      "api", "graphql", "-f", "query=query($p:ID!){node(id:$p){... on ProjectV2{url}}}", "-f", `p=${boardConfig.projectId}`,
    ]);
    const url = r.kind === "READ" ? r.value.data?.node?.url : undefined;
    links.push(
      typeof url === "string" && url.startsWith("https://")
        ? { label: "The board", url }
        : { label: "The board", url: null, why: r.kind === "UNMEASURED" ? r.why : "this token cannot see the project" },
    );
  }
  if (queueLabel !== null) {
    links.push({
      label: `Open issues labelled ${queueLabel}`,
      url: `https://github.com/${repo}/issues?q=${encodeURIComponent(`is:open label:${queueLabel}`)}`,
    });
  }
  // The package, not a path in `repo`: in a consumer, scripts/status-view.ts
  // is in node_modules, and a link built from the repository named a file the
  // consumer does not have (#2330).
  links.push({ label: "How this view is made", url: PACKAGE_PAGE });

  return {
    repo,
    generatedAt: now.toISOString().replace(/\.\d+Z$/, "Z"),
    commit: head.status === 0 ? head.stdout.trim() : null,
    family: milestonePrefix,
    goal: plan.goal,
    stages: plan.stages,
    phases,
    otherFamilies,
    phaseIssues,
    inProgress,
    ready,
    decisions,
    unphased,
    unphasedScope: queueLabel === null ? "all" : "queued",
    health: healthReading,
    links,
  };
}

/**
 * Every open issue in a milestone, with its open blockers and assignees
 * (#2330). One paged GraphQL read rather than a blocked-by call per issue:
 * the workflow runs this on every issue event.
 */
const PHASE_ISSUES_QUERY =
  "query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){" +
  "issues(first:100,after:$after,states:OPEN){pageInfo{hasNextPage endCursor} nodes{number title url " +
  "milestone{title} assignees(first:10){nodes{login}} blockedBy(first:50){pageInfo{hasNextPage} nodes{number state}}}}}}";

/**
 * Paged by hand, as `readReady` and `lib/live-issues.ts` do, rather than
 * with `gh --paginate`: the query nests a second paged connection
 * (`blockedBy`) in every node, and a hand loop follows the outer cursor by
 * name instead of trusting gh to find the right `pageInfo` (review of #2334).
 */
function readPhaseIssues(gh: Gh, repo: string): Reading<PhaseIssue[]> {
  const [owner, name] = repo.split("/");
  const out: PhaseIssue[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const args = ["api", "graphql", "-f", `query=${PHASE_ISSUES_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`];
    if (cursor !== null) args.push("-f", `after=${cursor}`);
    const r = ghJson<{ data?: { repository?: { issues?: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: any[] } } } }>(gh, args);
    if (r.kind === "UNMEASURED") return unmeasured(r.why);
    const conn = r.value.data?.repository?.issues;
    if (!conn) return unmeasured("the open issues could not be read: the reply carried no issues connection");
    for (const n of conn.nodes) {
      if (!n?.milestone?.title) continue;
      out.push({
        number: n.number,
        title: n.title,
        url: n.url,
        milestone: n.milestone.title,
        assignees: (n.assignees?.nodes ?? []).map((a: { login: string }) => a.login),
        blockers: (n.blockedBy?.nodes ?? []).filter((b: { state: string }) => b.state === "OPEN").map((b: { number: number }) => b.number),
        moreBlockers: n.blockedBy?.pageInfo?.hasNextPage === true,
      });
    }
    // The one decider of "is there another page" (SC-2721), so an empty or
    // missing cursor on a page that says more exist is UNMEASURED, not the end.
    const next = nextCursor(conn.pageInfo);
    if (next.kind === "done") return read(out);
    if (next.kind === "unreadable") return unmeasured(`the open issues could not be paged: ${next.why}`);
    cursor = next.cursor;
  }
  return unmeasured("the open issues kept paging past 5,000");
}

/**
 * What only a person can decide, as far as the tracker records it: an open
 * pull request that changes a decision record (`docs/adr/`), which a person
 * merges; open issues labelled `needs-criterion`, whose criterion text a
 * person writes; and open issues labelled `needs-decision`, which a session
 * parked for a person (#2138). A decision parked only in prose is still
 * invisible here: on 2026-11-14 two were, and this section said nothing was
 * waiting. Label the issue, or it is not on this list.
 */
function readDecisions(gh: Gh, repo: string, items: Reading<OpenItem[]>): Reading<WorkLine[]> {
  if (items.kind === "UNMEASURED") return unmeasured(items.why);
  const out: WorkLine[] = [];
  for (const pr of items.value.filter(i => i.pr)) {
    const files = ghLines<string>(gh, `repos/${repo}/pulls/${pr.number}/files?per_page=100`, ".[] | .filename | @json");
    if (files.kind === "UNMEASURED") return unmeasured(`files of pull request #${pr.number}: ${files.why}`);
    if (files.value.some(f => f.startsWith("docs/adr/"))) out.push({ number: pr.number, title: pr.title, url: pr.url, note: "decision record to merge" });
  }
  for (const i of items.value.filter(i => !i.pr)) {
    const notes = [
      ...(i.labels.includes("needs-criterion") ? ["names no criterion"] : []),
      ...(i.labels.includes(NEEDS_DECISION) ? ["parked for a decision"] : []),
    ];
    if (notes.length > 0) out.push({ number: i.number, title: i.title, url: i.url, note: notes.join("; ") });
  }
  return read(out);
}

/** The board's Ready lane: issues whose Status is `Ready`, in board order. */
function readReady(gh: Gh, root: string, items: Reading<OpenItem[]>): Reading<WorkLine[]> {
  const board = readBoardConfig(root);
  if (board === null) return unmeasured("no board is configured (board.id and board.fields.Criteria)");
  if (items.kind === "UNMEASURED") return unmeasured(items.why);
  const q =
    "query($p:ID!,$c:String){node(id:$p){... on ProjectV2{items(first:100,after:$c){pageInfo{hasNextPage endCursor} " +
    "nodes{status:fieldValueByName(name:\"Status\"){... on ProjectV2ItemFieldSingleSelectValue{name}} " +
    "content{... on Issue{number state}}}}}}}";
  const ready: number[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const args = ["api", "graphql", "-f", `query=${q}`, "-f", `p=${board.projectId}`];
    if (cursor !== null) args.push("-f", `c=${cursor}`);
    const r = ghJson<{ data?: { node?: { items?: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: any[] } } } }>(gh, args);
    if (r.kind === "UNMEASURED") return unmeasured(`the board could not be read: ${r.why}`);
    const conn = r.value.data?.node?.items;
    if (!conn) return unmeasured("the board could not be read: this token cannot see the project");
    for (const n of conn.nodes) {
      if (n?.status?.name === "Ready" && n?.content?.state === "OPEN" && typeof n.content.number === "number") ready.push(n.content.number);
    }
    if (!conn.pageInfo.hasNextPage) {
      const byNumber = new Map(items.value.map(i => [i.number, i]));
      return read(
        ready.flatMap(n => {
          const i = byNumber.get(n);
          return i ? [{ number: i.number, title: i.title, url: i.url }] : [];
        }),
      );
    }
    cursor = conn.pageInfo.endCursor;
  }
  return unmeasured("the board kept paging past 5,000 items");
}

/** Board health: `board-conformance`'s own readings, written as JSON by the command itself (#1889). */
function readHealth(root: string): Reading<HealthLine[]> {
  const dir = mkdtempSync(join(tmpdir(), "status-view-"));
  try {
    const out = join(dir, "readings.json");
    const r = spawnSync("bun", [CLI_ENTRY, "board-conformance", "--emit-readings", out], {
      cwd: root,
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (!existsSync(out)) {
      return unmeasured(`board-conformance wrote no readings (exit ${r.status}): ${(r.stderr ?? "").trim().split("\n").pop() ?? ""}`);
    }
    const rows = JSON.parse(readFileSync(out, "utf-8")) as HealthLine[];
    if (!Array.isArray(rows) || rows.length === 0) return unmeasured("board-conformance wrote an empty list of readings");
    return read(rows.map(x => ({ name: x.name, status: x.status, measured: x.measured, target: x.target })));
  } catch (e) {
    return unmeasured(`board-conformance's readings could not be parsed (${(e as Error).message})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Write the rendered body into the issue that carries the marker, pinned or
 * not. If there is none, create one. Then make sure it is pinned.
 *
 * **Found by marker among ALL open issues, not only the pinned ones** (AI
 * review of #2103). Looking only at pinned issues meant a pin that failed
 * once (the repository's three pin slots full, or a token without the right)
 * created a fresh issue on every later run, because the one just created was
 * never pinned and so was never found. Now it is found, reused, and the pin is
 * retried. A pin that still fails is a warning annotation on its own line,
 * and the body is still written.
 */
export function publish(body: string, repo: string, title: string, gh: Gh = liveGh): { ok: boolean; message: string } {
  if (!body.startsWith(STATUS_MARKER)) return { ok: false, message: "refusing to publish a body without the status marker" };
  const [owner, name] = repo.split("/");
  const pinned = ghJson<{ data?: { repository?: { pinnedIssues?: { nodes: { issue: { number: number; body: string } }[] } } } }>(gh, [
    "api", "graphql", "-f",
    "query=query($o:String!,$n:String!){repository(owner:$o,name:$n){pinnedIssues(first:3){nodes{issue{number body}}}}}",
    "-f", `o=${owner}`, "-f", `n=${name}`,
  ]);
  if (pinned.kind === "UNMEASURED") return { ok: false, message: `UNMEASURED — the pinned issues could not be read: ${pinned.why}` };
  const pinnedMine = (pinned.value.data?.repository?.pinnedIssues?.nodes ?? []).find(n => n.issue.body.startsWith(STATUS_MARKER));
  let number: string | null = pinnedMine ? String(pinnedMine.issue.number) : null;
  if (number === null) {
    // Only an issue this workflow or a maintainer wrote. The marker is text
    // anyone can type into an issue they open; reusing a stranger's issue
    // would pin it, and its author could edit it back afterwards while it
    // stays pinned (security review of #2103). A pinned issue needs no such
    // check: pinning already takes maintainer rights.
    const open = ghLines<{ number: number; body: string | null; login: string | null; association: string | null }>(
      gh,
      `repos/${repo}/issues?state=open&per_page=100`,
      ".[] | select(.pull_request == null) | {number, body, login: .user.login, association: .author_association}",
    );
    if (open.kind === "UNMEASURED") return { ok: false, message: `UNMEASURED — the open issues could not be read: ${open.why}` };
    const found = open.value.find(i => (i.body ?? "").startsWith(STATUS_MARKER) && trustedAuthor(i.login, i.association));
    if (found) number = String(found.number);
  }
  const dir = mkdtempSync(join(tmpdir(), "status-publish-"));
  try {
    const file = join(dir, "body.md");
    writeFileSync(file, body);
    let verb: string;
    if (number !== null) {
      const r = gh(["issue", "edit", number, "-R", repo, "--title", title, "--body-file", file]);
      if (!r.ok) return { ok: false, message: r.why };
      verb = "updated";
    } else {
      const created = gh(["issue", "create", "-R", repo, "--title", title, "--body-file", file]);
      if (!created.ok) return { ok: false, message: created.why };
      number = /\/issues\/(\d+)/.exec(created.out)?.[1] ?? null;
      if (number === null) return { ok: false, message: `created an issue but could not read its number from: ${created.out.trim()}` };
      verb = "created";
    }
    if (pinnedMine) return { ok: true, message: `${verb} #${number}` };
    const pin = gh(["issue", "pin", number, "-R", repo]);
    return pin.ok
      ? { ok: true, message: `${verb} and pinned #${number}` }
      : {
          ok: true,
          message:
            `${verb} #${number}\n::warning title=Status view::#${number} could not be pinned (${pin.why}). ` +
            "Pin it once by hand; later runs find and reuse it either way.",
        };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The workflow's own identity, or someone with write access to the repository. */
export function trustedAuthor(login: string | null, association: string | null): boolean {
  return login === "github-actions[bot]" || ["OWNER", "MEMBER", "COLLABORATOR"].includes(association ?? "");
}

/** The pinned issue's title: follows the focus family, never a fixed name. */
export function viewTitle(family: string | null): string {
  return family === null ? "Where we are" : `Where we are: ${family}`;
}

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? "");
}

/** `owner/name` from a git remote URL in any spelling git writes, or null for one that names no repository. */
export function repoFromRemote(url: string): string | null {
  const m = /^(?:[a-z+]+:\/\/(?:[^@/]+@)?[^/]+\/|[^@/\s]+@[^:/\s]+:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m === null ? null : `${m[1]}/${m[2]}`;
}

/**
 * Which repository to read: `--repo`, then `GITHUB_REPOSITORY`, then the
 * checkout's `origin` remote (#2330), so `rungate board` run in a consumer
 * reads that consumer with no flag. Null when none of the three names one.
 */
export function resolveRepo(argv: string[], env: Record<string, string | undefined>, root: string): string | null {
  // An explicit `--repo` is used as given, even empty, so a bad flag is
  // refused rather than guessed past. An empty GITHUB_REPOSITORY names
  // nothing and falls through to the remote (review of #2334).
  const flagged = flag(argv, "--repo");
  if (flagged !== null) return flagged;
  if (env.GITHUB_REPOSITORY !== undefined && env.GITHUB_REPOSITORY !== "") return env.GITHUB_REPOSITORY;
  const origin = spawnSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf-8" });
  return origin.status === 0 ? repoFromRemote(origin.stdout) : null;
}

export function main(argv: string[], root = process.cwd()): number {
  const repo = resolveRepo(argv, process.env, root);
  if (repo === null || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    console.error("status-view: name the repository with --repo owner/name (or GITHUB_REPOSITORY), or run it in a checkout whose origin remote is the repository.");
    return REFUSAL_EXIT;
  }
  const toPublish = flag(argv, "--publish");
  if (toPublish !== null) {
    if (toPublish === "" || !existsSync(toPublish)) {
      console.error(`status-view: --publish needs a rendered file; "${toPublish}" does not exist.`);
      return REFUSAL_EXIT;
    }
    const body = readFileSync(toPublish, "utf-8");
    const family = readBoardInputs(root).milestonePrefix;
    const r = publish(body, repo, viewTitle(family));
    console.log(`status-view: ${r.message}`);
    return r.ok ? 0 : REFUSAL_EXIT;
  }
  const view = gather(root, repo);
  // Printed, never written to a path from argv: the caller redirects it.
  // A write to an argv path is a site the spec-write sweep cannot follow
  // (#1584), and a redirect in the workflow says where it goes in plain sight.
  if (argv.includes("--markdown")) {
    process.stdout.write(renderMarkdown(view));
  } else {
    process.stdout.write(renderText(view));
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
