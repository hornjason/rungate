/**
 * A spec's *Phase placement* table, and the milestones derived from it (#1647).
 *
 * `docs/adr/ADR-003-spec-to-tracker-mapping.md` decides the model: a criterion
 * is placed in the spec, a milestone is DERIVED from that placement, and an
 * issue carries the milestone and names its criteria. This file is step 2 of
 * that ADR made executable — until it existed, step 2 was eight milestones
 * created by hand with `gh`.
 *
 * ## Why derived rather than typed, measured on the eight that were typed
 *
 * The convergence milestones were created by hand on 2026-10-28 from the same
 * phase headings this function reads, and **two of the eight already disagree
 * with their heading**: `### Phase 0 — three settings, no engineering` became
 * *Convergence Phase 0 — three settings*, and `### Phase 4 — findings get
 * answered, and repeats get fixed at the source` became *Convergence Phase 4 —
 * findings get answered*. Nothing was wrong at the time and nothing noticed
 * since; a name typed from a heading is a copy, and a copy drifts. That is the
 * same defect as a spec listing issue numbers, one artefact over.
 *
 * ## The phase NUMBER is the identity, not the title
 *
 * {@link milestonePlan} matches an existing milestone on its phase number and
 * reports a title that no longer matches as a RENAME, never as a milestone to
 * create. Matching on the title would have produced eight duplicates against
 * the live repository on the first run, and a duplicate milestone silently
 * splits a phase's issues into two lanes that each look complete.
 *
 * ## What this does NOT decide
 *
 * Which criteria belong in one ISSUE. That is judgement — a criterion needs
 * several issues and an issue serves several criteria (ADR-003, *Cardinality*)
 * — and a tool that guessed it would file issues nobody asked for against rule
 * 7's opened-to-closed ratio. {@link uncoveredByMilestone} reports the input
 * to that decision and stops there.
 */
import { parseFrontmatter } from "./frontmatter";
import { PHASE_TOKEN, readMilestoneTitle } from "./milestone-title";
import { oneScMentionPattern } from "./sc-ids";
import { parseCriteria } from "./spec-evidence";

/** The heading a spec puts its placement table under. One spelling, by fiat. */
export const PLACEMENT_HEADING = "### Phase placement";

/**
 * Placement values that are NOT phases, and so get no milestone.
 *
 * Closed on purpose. A placement outside this set and not matching
 * {@link PHASE_VALUE} is a refusal rather than a row quietly skipped — ADR-003
 * records that forcing unstartable work into a numbered phase "states a plan
 * that is a lie", and silently dropping an unrecognised row does the same
 * thing by omission.
 */
export const NON_PHASE_PLACEMENTS = [
  "Blocked",
  "Done",
  "Not adopted — deliberate",
  "Not observable here",
] as const;

/**
 * The non-phase placements under which a criterion is DECLARED — SC-2778.
 *
 * A criterion placed here is named apart by `criterion-coverage` and
 * `declared-work` and leaves both targets: the spec has said it cannot start
 * (or was deliberately not adopted, or cannot be observed here), so counting
 * it as missing asks for an issue the spec says must not exist, and counting
 * it as covered would credit work nobody can do (ADR-018 Decision 5). `Done`
 * is not here: a done criterion is ticked, and both readings already handle
 * a ticked one.
 */
export const DECLARED_OUTSIDE_PHASES = [
  "Blocked",
  "Not adopted — deliberate",
  "Not observable here",
] as const satisfies readonly (typeof NON_PHASE_PLACEMENTS)[number][];

/**
 * Where one placement value puts a criterion, for both readings — SC-2778.
 *
 * THE one predicate. `criterionCoverage` and `readDeclaredWork` both annotate
 * their rows with it, so the two readings cannot disagree about a criterion.
 *
 * - `{ outside }`: one of {@link DECLARED_OUTSIDE_PHASES}, the value as written.
 * - `{ unknownPlacement }`: neither a phase nor a known non-phase value. Both
 *   readings go UNMEASURED on it, by name, rather than guessing.
 * - `null`: a phase, `Done`, or no placement at all — counted as before. A
 *   criterion placed nowhere is `spec-placement`'s UNPLANNED, not this.
 */
export function outsidePhases(placement: string | undefined): { outside: string } | { unknownPlacement: string } | null {
  if (placement === undefined || PHASE_VALUE.test(placement)) return null;
  if (DECLARED_OUTSIDE_PHASES.some(v => placement.startsWith(v))) return { outside: placement };
  if (NON_PHASE_PLACEMENTS.some(v => placement.startsWith(v))) return null;
  return { unknownPlacement: placement };
}

/**
 * Each criterion's placement value, read from the spec's own table. A
 * criterion placed more than once is an unknown placement naming both values: the
 * table contradicts itself, and picking one is a guess (SC-2778).
 */
export function placementsById(content: string): Map<string, string> {
  const where = new Map<string, string[]>();
  for (const r of parsePlacementRows(content)) for (const id of r.ids) where.set(id, [...(where.get(id) ?? []), r.placement]);
  return new Map([...where].map(([id, p]) => [id, p.length === 1 ? p[0]! : `placed ${p.length} times: ${p.join(" and ")}`]));
}

/** `Phase 0`, `Phase 11`. The capture is the number. */
export const PHASE_VALUE = new RegExp(`^${PHASE_TOKEN}$`);

/**
 * Which phase of `prefix`'s family this milestone title is, or `null`.
 *
 * THE anchored parse. `milestonePlan` calls it to file live milestones by
 * phase, and `inMilestoneFamily` in `lib/live-issues.ts` is defined as
 * "this returned a number" — so `plan-deps` narrowing a population and
 * `board-snapshot` matching the board are the same decision, not two that
 * happen to agree.
 *
 * Round 2 of #1705 found them disagreeing. `inMilestoneFamily` tested
 * `startsWith(`${prefix} Phase `)`, which admits anything at all after the
 * space; this needs a number there. On `"Pipeline Phase  1 — oops"` — one
 * stray space — the first said yes and this says no, so `plan-deps` would
 * have sequenced an issue whose phase `board-snapshot` files as unmanaged
 * and `lib/board-mirror.ts` reads as 1. Two spellings of one grammar drift
 * the moment either is edited, and nothing behavioural can see which of
 * them a case is holding up: `.claude/rules/checks-must-be-able-to-fail.md`,
 * fourth shape.
 *
 * The family is compared as a string against `readMilestoneTitle`'s reading,
 * never compiled into a pattern, so a family name containing regex
 * punctuation (`C++`) means itself.
 *
 * Not to be confused with `phaseOf` in `lib/board-mirror.ts`, which reads a
 * phase number out of ANY title regardless of family. That one answers a
 * different question — "what phase is this, whoever owns it" — and is the
 * reason `--milestone-prefix` has to narrow the population before the order
 * is derived.
 */
export function phaseInFamily(title: string | null | undefined, prefix: string): number | null {
  // #2057: compared against the one reading, not interpolated into a second
  // regex. An empty prefix is no family here: it is refused upstream
  // (lib/live-issues.ts) and must not match every bare `Phase N` title.
  const r = readMilestoneTitle(title);
  return prefix !== "" && r !== null && r.family === prefix ? r.phase : null;
}

/**
 * The family a phase milestone belongs to — `Pipeline` for `Pipeline Phase 6
 * — …`, `""` for a bare `Phase N` title (a repository with no prefix has one
 * family, the reading `familyRank` takes for a null prefix), or null when
 * the title is neither shape (#2024). Null is not a family: a caller must
 * not fold it into one, or every unreadable title chains to every other.
 *
 * The same grammar as {@link phaseInFamily}, read the other way: for every
 * title this returns a NON-EMPTY family for, `phaseInFamily(title,
 * familyOf(title))` is the title's phase. The unprefixed family `""` is the
 * one exception — `phaseInFamily` takes a prefix and an empty one is refused
 * upstream (`lib/live-issues.ts`), so it has no `""` reading to agree with. `test/plan-deps.test.ts` asserts that agreement, so the
 * two cannot drift into a second decider of what a family is.
 */
export function familyOf(title: string | null | undefined): string | null {
  return readMilestoneTitle(title)?.family ?? null;
}

export interface PlacementRow {
  /** The first cell, asterisks stripped: `Phase 3`, `Done`, `Blocked — …`. */
  placement: string;
  /** Every criterion id in the second cell, in document order. */
  ids: string[];
  /** 1-indexed line of the row, for a message somebody can act on. */
  line: number;
}

export interface PhaseHeading {
  number: number;
  /** The text after `Phase N — `, or `""` when the heading carries none. */
  title: string;
  /** The whole heading minus the `### `, which is what a milestone is named from. */
  heading: string;
  line: number;
}

/**
 * Every row of the placement table.
 *
 * Returns `[]` when the section is absent, which callers must distinguish from
 * a present-but-empty table: {@link placementReading} does, by reporting
 * `UNMEASURED` with the reason, because an empty violation list from a section
 * that was never found reads exactly like a spec in perfect order
 * (`.claude/rules/config-access.md`).
 */
export function parsePlacementRows(content: string): PlacementRow[] {
  const lines = content.split("\n");
  const start = lines.findIndex(l => l.startsWith(PLACEMENT_HEADING));
  if (start === -1) return [];

  const out: PlacementRow[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // Any heading at `###` or shallower ends the section. A `####` inside it
    // is still inside it.
    if (/^#{1,3} /.test(line)) break;
    if (!line.startsWith("| ") || line.startsWith("|---") || line.startsWith("| Placement")) continue;
    const cells = line.split("|");
    out.push({
      placement: (cells[1] ?? "").replaceAll("*", "").trim(),
      ids: [...(cells[2] ?? "").matchAll(/\b[A-Z]+(?:-[A-Z]?\d+)+\b/g)].map(m => m[0]),
      line: i + 1,
    });
  }
  return out;
}

/** `## Phase N — title` to `#### …`: the heading a milestone is named from. */
const PHASE_HEADING = new RegExp(String.raw`^#{2,4} (${PHASE_TOKEN}(?:\s*[—–-]\s*(.*))?)\s*$`);

/** Every `### Phase N — …` heading, in document order. */
export function parsePhaseHeadings(content: string): PhaseHeading[] {
  const out: PhaseHeading[] = [];
  content.split("\n").forEach((line, i) => {
    const m = line.match(PHASE_HEADING);
    if (!m) return;
    out.push({ number: Number(m[2]), title: (m[3] ?? "").trim(), heading: m[1].trim(), line: i + 1 });
  });
  return out;
}

export interface PlacementReading {
  /** UNMEASURED FAILS. An empty violation list from an absent table is not a clean one. */
  reading: "MEASURED" | "UNMEASURED";
  unmeasuredReasons: string[];
  rows: PlacementRow[];
  /** Criteria the spec states and the table does not place. */
  unplaced: string[];
  /** Criteria placed more than once, with where. */
  doubled: { id: string; placements: string[] }[];
  /** Ids in the table that the spec states nowhere. */
  unknown: string[];
  /** Placement values matching neither `Phase N` nor a `NON_PHASE_PLACEMENTS` prefix. */
  unrecognised: string[];
  /** Every criterion id the spec states. */
  criteria: string[];
}

export function placementReading(content: string): PlacementReading {
  const criteria = parseCriteria(content).map(c => c.id);
  const rows = parsePlacementRows(content);
  const reasons: string[] = [];

  if (!content.includes(PLACEMENT_HEADING)) {
    reasons.push(
      `no \`${PLACEMENT_HEADING}\` section — every criterion is unplaced for an instrument ` +
        `reason, which reads the same as a spec nobody has started`,
    );
  } else if (rows.length === 0) {
    reasons.push(`the \`${PLACEMENT_HEADING}\` section has no table rows`);
  }
  if (criteria.length === 0) {
    reasons.push("the spec states no criteria — nothing to place, which is not the same as placed");
  }

  const where = new Map<string, string[]>();
  for (const r of rows) for (const id of r.ids) where.set(id, [...(where.get(id) ?? []), r.placement]);

  return {
    reading: reasons.length > 0 ? "UNMEASURED" : "MEASURED",
    unmeasuredReasons: reasons,
    rows,
    criteria,
    unplaced: criteria.filter(id => !where.has(id)),
    doubled: [...where].filter(([, p]) => p.length > 1).map(([id, placements]) => ({ id, placements })),
    unknown: [...where.keys()].filter(id => !criteria.includes(id)),
    unrecognised: rows
      .map(r => r.placement)
      .filter(p => !PHASE_VALUE.test(p) && !NON_PHASE_PLACEMENTS.some(v => p.startsWith(v))),
  };
}

/** What one spec's planning state is, across the whole tree — SC-2611. */
export type PlacementState = "PLANNED" | "UNPLANNED" | "NO_CRITERIA" | "UNREADABLE";

export interface SpecPlacement {
  /** Repo-relative, as the sweep spells it. */
  path: string;
  state: PlacementState;
  /** Why it is not PLANNED. Empty exactly when it is. */
  reasons: string[];
  /** How many criteria the spec states, and how many the table places. */
  criteria: number;
  placed: number;
  /** The spec declares `scope: deferred` (or the legacy `board-scope: deferred`) — SC-2734. */
  deferred: boolean;
  /** What the spec's own frontmatter says about the board — SC-2776. */
  board: BoardDeclaration;
}

/**
 * Whether a spec is on the board, read from its own frontmatter — SC-2776.
 *
 * - `active`: a `board:` block with `scope: active`. The only value the
 *   engine consumes.
 * - `deferred`: `scope: deferred`, or the legacy `board-scope: deferred`
 *   line, which reads the same (ADR-018 Decision 9).
 * - `undeclared`: no `board:` block and no legacy line. Never planned,
 *   labelled or placed, whatever else the spec carries — a placement table
 *   alone pulls nothing in (ADR-018 Decision 8).
 * - `invalid`: a declaration the engine could not read. `problems` says why,
 *   and the spec is consumed no more than an undeclared one.
 */
export type BoardScope = "active" | "deferred" | "undeclared" | "invalid";

export interface BoardDeclaration {
  scope: BoardScope;
  /**
   * Every key in {@link BOARD_KEYS} the block sets, as text — `prefix` is
   * `settings.prefix`. Carried whole, so the snapshot and
   * `board-conformance` pass a new setting through without naming it.
   */
  settings: Record<string, string>;
  /**
   * What stops the engine reading the declaration as written — an unknown
   * scope value, an active spec with no prefix, a block that is not YAML, a
   * declaration made twice. `spec-placement` refuses on any of these, by name.
   */
  problems: string[];
  /**
   * Keys {@link BOARD_KEYS} does not hold. Reported by name and otherwise
   * ignored (ADR-018 Decision 9): they never block a reading, and
   * `test/board-families.test.ts` fails the pull request that adds one to a
   * spec in this tree, which is where a teammate hears about a typo.
   */
  unknownKeys: string[];
}

/**
 * The keys the engine reads inside `board:` — ADR-018 Decision 9.
 *
 * **THE one place a board setting is added.** The sweep, the snapshot and
 * `board-conformance` carry {@link BoardDeclaration} whole, so none of them
 * names a key; only the code that acts on a setting has to know it exists.
 * `values` closes a key to a set, reported by name when anything else is
 * written; a key without it takes any single value.
 *
 * The list lives in code, not config, on purpose: a key with no code behind it
 * does nothing, and a config that could name one would promise a setting the
 * engine silently ignores.
 */
export const BOARD_KEYS: Readonly<Record<string, { what: string; values?: readonly string[] }>> = {
  scope: { what: "whether the engine consumes this spec", values: ["active", "deferred"] },
  prefix: { what: "the milestone family the spec's phases are named in" },
  // Jason's call of 2026-11-17, a stopgap ahead of #2331. It is read by
  // `plan-deps` through {@link phaseOrderFor}.
  phaseOrder: {
    what:
      "whether plan-deps writes the family's phase order as blocked-by links; false means phases set priority " +
      "and only real blocked-by links hold work back",
    values: ["true", "false"],
  },
};

/**
 * Whether `plan-deps` writes a family's phase order, read from every spec that
 * names the family as its `board.prefix`. Absent means on, which is how
 * every family behaved before the key existed.
 *
 * Specs of one family that disagree are unreadable, not resolved: picking
 * either is the guess {@link boardDeclaration} exists not to make.
 */
export function phaseOrderFor(
  specs: readonly { path: string; text: string }[],
  prefix: string,
): { kind: "on" } | { kind: "off"; spec: string } | { kind: "unreadable"; why: string } {
  const family = specs
    .map(s => ({ path: s.path, board: boardDeclaration(s.text) }))
    .filter(s => s.board.settings.prefix === prefix);
  // A declaration the engine cannot read — `phaseOrder: flase` among them, since
  // `boardDeclaration` checks every key's values — refuses rather than reading
  // the raw text as "not false", which would be on (review of #2352).
  const unreadable = family.find(s => s.board.problems.length > 0);
  if (unreadable !== undefined) {
    return {
      kind: "unreadable",
      why: `${unreadable.path}: its board: declaration cannot be read, so family ${prefix}'s phaseOrder cannot be — ${unreadable.board.problems.join("; ")}`,
    };
  }
  // Only an active spec is the family; a deferred one carrying the prefix is shelved (review of #2352).
  const declared = family
    .filter(s => s.board.scope === "active")
    .map(s => ({ path: s.path, value: s.board.settings.phaseOrder ?? "true" }));
  const off = declared.filter(d => d.value === "false");
  const on = declared.filter(d => d.value !== "false");
  if (off.length > 0 && on.length > 0) {
    return {
      kind: "unreadable",
      why:
        `the specs of family ${prefix} disagree on board.phaseOrder: ${off[0]!.path} says false and ${on[0]!.path} says ` +
        `${on[0]!.value}, so whether to write its phase order cannot be read`,
    };
  }
  return off.length > 0 ? { kind: "off", spec: off[0]!.path } : { kind: "on" };
}

/**
 * One frontmatter entry's value, parsed as YAML — only that entry, never the
 * whole block. Whole-block YAML is not available here: the engine spec's own
 * `governs:` line carries a `: ` inside a plain scalar, which YAML refuses.
 */
function yamlValue(e: { key: string; inline: string; block: string[] }): { value: unknown } | { error: string } {
  const text = [`${e.key}:${e.inline === "" ? "" : ` ${e.inline}`}`, ...e.block].join("\n");
  try {
    const doc = Bun.YAML.parse(text) as Record<string, unknown> | null;
    return { value: doc?.[e.key] ?? null };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * The index of the `}` closing the flow mapping that opens `text`, or -1.
 * Quoted text is skipped (with YAML's `\"` and `''` escapes), so a brace
 * inside a value or a trailing comment cannot end the mapping early.
 */
function closingBrace(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
    } else if (c === "'") {
      for (i++; i < text.length; i++) {
        if (text[i] !== "'") continue;
        if (text[i + 1] === "'") i++;
        else break;
      }
    } else if (c === "{" || c === "[") depth++;
    else if ((c === "}" || c === "]") && --depth === 0) return i;
  }
  return -1;
}

/**
 * Keys written twice at the top of `board:`, in either form. YAML keeps the
 * last silently, which is the guess this reading must not make.
 *
 * The block form is read line by line at the first key's indent. The one-line
 * form is re-read by the YAML parser as a SEQUENCE — `{ a: 1, a: 2 }` becomes
 * `[ a: 1, a: 2 ]`, which YAML parses as one single-pair mapping per entry —
 * so every pair survives, duplicates included, with YAML's own quoting and
 * nesting rules. `null` means the one-line form could not be re-read, which
 * the caller reports rather than taking as "no repeats".
 */
function repeatedKeys(e: { inline: string; block: string[] }): string[] | null {
  const names: string[] = [];
  if (e.inline.startsWith("{")) {
    const close = closingBrace(e.inline);
    if (close < 0) return null;
    try {
      const pairs = (Bun.YAML.parse(`x: [${e.inline.slice(1, close)}]`) as { x: unknown }).x;
      if (!Array.isArray(pairs)) return null;
      for (const p of pairs) {
        if (typeof p !== "object" || p === null || Array.isArray(p)) return null;
        names.push(...Object.keys(p));
      }
    } catch {
      // Refused as a sequence while it parsed as a mapping: the pairs cannot
      // be counted, so the caller reports it instead of reading "no repeats".
      return null;
    }
  }
  // The block form's top level is read as bare `key:` names ONLY. A line
  // there spelled any other way — a quoted key, a `? ` complex key, a `<<:`
  // merge — is refused rather than parsed, so no YAML spelling of a repeat
  // can slip past (review of #2308). Deeper lines are nested values.
  const lines = e.block.filter(l => l.trim() !== "" && !l.trim().startsWith("#"));
  const top = lines[0]?.match(/^[ \t]*/)?.[0];
  for (const l of lines) {
    if (l.match(/^[ \t]*/)?.[0] !== top) continue;
    const m = /^[ \t]+([A-Za-z_][\w-]*)[ \t]*:/.exec(l);
    if (m === null) return null;
    names.push(m[1]!);
  }
  return [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
}

/**
 * What a spec's frontmatter says about the board — SC-2776.
 *
 * Read from the FRONTMATTER only, through `parseFrontmatter`: a body line
 * spelling the same words is prose about the convention, not a declaration,
 * and reading it would let a spec opt itself in, or hold itself back, by
 * quoting this rule. The `board:` entry itself is parsed by Bun's YAML
 * parser, so quoting, commas, comments and the one-line `{ … }` form mean
 * what YAML says they mean.
 *
 * **Reported, never guessed.** An unknown key is named and otherwise
 * ignored, so a typo — `scpoe: active` — leaves the spec with no scope and
 * opts nothing in. An unknown scope value is named and opts nothing in. An
 * active spec with no prefix stays active, so the reading can name it,
 * and the prefix is not invented from the filename: `CODE-REVIEW-CONVERGENCE-SPEC.md`
 * would derive *Code Review Convergence*, which is not what its milestones
 * are called (see {@link milestonePlan}).
 */
export function boardDeclaration(content: string): BoardDeclaration {
  const none = (): BoardDeclaration => ({ scope: "undeclared", settings: {}, problems: [], unknownKeys: [] });
  if (!/^---\r?\n/.test(content)) return none();
  const fm = parseFrontmatter(content);
  if (fm === null) {
    // A block the parser refuses — a column-0 `#` comment is the live one —
    // still cannot opt in if no line of it so much as starts a board key.
    // With no closing fence at all, everything after the opening one is the
    // block as far as anyone can tell, so that is what gets scanned — the
    // fenced regex alone would hand back "" and read the most broken input
    // as undeclared (review of #2308).
    const fenced = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    const raw = fenced?.[1] ?? content.replace(/^---\r?\n/, "");
    if (!/^board(?:-scope)?[ \t]*:/m.test(raw)) return none();
    return {
      ...none(),
      scope: "invalid",
      problems: ["the frontmatter has a line no key owns, so whether it opts this spec in cannot be read"],
    };
  }
  const blocks = fm.entries.filter(e => e.key === "board");
  const legacy = fm.entries.filter(e => e.key === "board-scope");
  if (blocks.length === 0 && legacy.length === 0) return none();

  const settings: Record<string, string> = {};
  const problems: string[] = [];
  const unknownKeys: string[] = [];
  // A declaration made twice, or two that disagree, is one the engine cannot
  // read: picking either is the guess this function exists not to make.
  let contested = false;
  const twice = (what: string) => {
    problems.push(`${what} is declared more than once`);
    contested = true;
  };
  if (blocks.length > 1) twice("`board:`");
  if (legacy.length > 1) twice("`board-scope:`");

  const block = blocks[0];
  if (block !== undefined) {
    const read = yamlValue(block);
    const keys = Object.keys(BOARD_KEYS).join(", ");
    if ("error" in read) problems.push(`the \`board:\` block is not valid YAML (${read.error})`);
    else if (typeof read.value !== "object" || read.value === null || Array.isArray(read.value)) {
      problems.push(`\`board:\` must be a block of keys (${keys}), not ${JSON.stringify(read.value)}`);
    } else {
      const repeats = repeatedKeys(block);
      if (repeats === null) {
        problems.push(
          "`board:` could not be checked for a key written twice — at its top level the engine reads only " +
            "bare `key:` names, so a quoted, complex or merge key is refused",
        );
        contested = true;
      } else for (const k of repeats) twice(`\`board.${k}\``);
      for (const [key, v] of Object.entries(read.value as Record<string, unknown>)) {
        const known = BOARD_KEYS[key];
        if (known === undefined) {
          unknownKeys.push(key);
          continue;
        }
        if (v !== null && typeof v === "object") {
          problems.push(`\`board.${key}\` takes a single value, not ${JSON.stringify(v)}`);
          continue;
        }
        const text = v === null ? "" : String(v);
        if (known.values !== undefined && !known.values.includes(text)) {
          problems.push(`\`board.${key}: ${text}\` is not a value the engine knows (${known.values.join(" or ")})`);
        }
        if (text !== "") settings[key] = text;
      }
      if (!("scope" in (read.value as object))) problems.push("the `board:` block declares no `scope`");
    }
  }

  let scope = settings.scope;
  const old = legacy[0];
  if (old !== undefined) {
    const read = yamlValue(old);
    if ("error" in read || read.value !== "deferred") {
      problems.push(`\`board-scope: ${old.inline}\` — the legacy line takes only \`deferred\``);
      contested = true;
    } else if (scope !== undefined && scope !== "deferred") {
      problems.push(`\`board.scope: ${scope}\` and the legacy \`board-scope: deferred\` disagree`);
      contested = true;
    } else scope = "deferred";
  }
  if (scope === "active" && settings.prefix === undefined) {
    problems.push("the spec is active and declares no `prefix`, so no milestone can be named for its phases");
  }

  const read: BoardScope = !contested && (scope === "active" || scope === "deferred") ? scope : "invalid";
  return { scope: read, settings, problems, unknownKeys };
}

/**
 * Whether a spec holds itself back from the board — SC-2734, read through
 * {@link boardDeclaration} so the deferral and the opt-in are one reading.
 */
export function declaresDeferred(content: string): boolean {
  return boardDeclaration(content).scope === "deferred";
}

export interface PlacementCoverage {
  /** UNMEASURED FAILS. An empty list from a sweep that failed is not a clean one. */
  reading: "MEASURED" | "UNMEASURED";
  unmeasuredReasons: string[];
  /** Every spec the sweep located, in its order. */
  specs: SpecPlacement[];
  /** The paths in each state, so a caller reports names rather than a count. */
  planned: string[];
  unplanned: string[];
  noCriteria: string[];
}

/** THE one way out of {@link placementCoverage} without a reading. */
function unmeasuredCoverage(reasons: string[]): PlacementCoverage {
  return { reading: "UNMEASURED", unmeasuredReasons: reasons, specs: [], planned: [], unplanned: [], noCriteria: [] };
}

/**
 * Every spec in the tree, and whether its criteria are placed — SC-2611.
 *
 * **The gap this closes.** {@link placementReading} answers the question for
 * ONE spec, and both of its callers are given a spec on the command line. So
 * a spec with no `### Phase placement` table contributed nothing to any
 * repository-wide view: it had no phases, so it raised no milestone, so it
 * appeared in no lane. 1 of 26 specs had a table on 2026-10-29 and the other
 * 25 were indistinguishable from specs with no work left — which is the
 * flattering reading of the two, and the wrong one.
 *
 * **`NO_CRITERIA` is separate from `UNPLANNED` deliberately.** A spec that
 * states nothing to place genuinely has no work in it; a spec that states
 * twelve criteria and places none has twelve. Folding them together
 * reproduces the defect one level up — the count would be honest and the
 * reader still could not act on it.
 *
 * **One unreadable spec makes the whole reading UNMEASURED**, not a shorter
 * list: a shorter list is exactly what a tree with fewer specs produces. The
 * spec is still carried in `specs` as `UNREADABLE` so the reason names it.
 *
 * The enumeration is `listSpecs`, not a second directory walk. `specs/` is
 * already swept in one place, and a second walk is a second decider for
 * "which files are specs" that no behavioural test of either could separate
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
export function placementCoverage(
  root: string,
  listSpecs: (root: string) => { reading: "MEASURED" | "UNMEASURED"; unmeasuredReasons: string[]; paths: string[] },
  readSpec: (root: string, path: string) => string,
): PlacementCoverage {
  const sweep = listSpecs(root);
  if (sweep.reading === "UNMEASURED") {
    return unmeasuredCoverage([
      `the specs/ sweep could not be taken, so nothing below is a reading of this tree: ` +
        sweep.unmeasuredReasons.join("; "),
    ]);
  }

  const specs: SpecPlacement[] = [];
  const reasons: string[] = [];
  for (const path of sweep.paths) {
    let content: string;
    try {
      content = readSpec(root, path);
    } catch (e) {
      specs.push({
        path,
        state: "UNREADABLE",
        reasons: [(e as Error).message],
        criteria: 0,
        placed: 0,
        deferred: false,
        board: { scope: "undeclared", settings: {}, problems: [], unknownKeys: [] },
      });
      reasons.push(`could not read ${path}: ${(e as Error).message}`);
      continue;
    }
    const r = placementReading(content);
    const board = boardDeclaration(content);
    const placed = r.criteria.length - r.unplaced.length;
    const state: PlacementState =
      r.criteria.length === 0 ? "NO_CRITERIA" : r.reading === "MEASURED" ? "PLANNED" : "UNPLANNED";
    specs.push({
      path,
      state,
      reasons: state === "PLANNED" ? [] : r.unmeasuredReasons,
      criteria: r.criteria.length,
      placed,
      deferred: board.scope === "deferred",
      board,
    });
  }

  if (reasons.length > 0) {
    // Carry the per-spec rows: the refusal has to be able to NAME the file.
    return { ...unmeasuredCoverage(reasons), specs };
  }
  return {
    reading: "MEASURED",
    unmeasuredReasons: [],
    specs,
    planned: specs.filter(s => s.state === "PLANNED").map(s => s.path),
    unplanned: specs.filter(s => s.state === "UNPLANNED").map(s => s.path),
    noCriteria: specs.filter(s => s.state === "NO_CRITERIA").map(s => s.path),
  };
}

/** One criterion, and what the board says about it — item **B2**. */
export interface CriterionCoverage {
  id: string;
  /**
   * The engine issue whose Criteria column names it, or EXPLICIT null.
   *
   * Never omitted. `board-conformance` counts
   * `typeof satisfiedByIssue === "number"` precisely because
   * `undefined !== null` is true, so a generator relying on ordinary object
   * omission would have every uncovered criterion counted as covered.
   *
   * The LOWEST number when several issues name it, so an unchanged board
   * cannot produce a different snapshot on a re-run and read as movement.
   */
  satisfiedByIssue: number | null;
  /** The spec's own checkbox is ticked — already true, needing only a binding. */
  recordedTrue: boolean;
  /** Placed under one of {@link DECLARED_OUTSIDE_PHASES} — SC-2778. Present only when it is. */
  outside?: string;
  /** Placed under a value the engine does not know — SC-2778. Present only when it is. */
  unknownPlacement?: string;
}

/**
 * Invert the board's Criteria column into the spec's criterion population.
 *
 * The population is the SPEC's, never the board's: an id some issue names
 * and the spec does not state is not a criterion, and counting it would let
 * the board raise its own denominator.
 *
 * **`columnRead` is the three-state gate.** It must be `false` whenever the
 * Criteria column was not read for every engine issue — a truncated item
 * list, a failed project query, or a project with no board at all. The
 * population then comes back EMPTY, which `board-conformance` reports
 * UNMEASURED. Emitting the rest would report SHORT: a criterion no *read*
 * issue names is indistinguishable from one named by an issue nobody could
 * read, and only one of those is a measurement.
 *
 * ## `oneScMentionPattern`, not a pattern of its own
 *
 * The same mistake {@link uncoveredByMilestone} records below, made again
 * 150 lines above it. The first version of this built its own
 * `(^|[^\w-])id($|[^\w-])` regex, which is a SECOND DECIDER for the
 * question "does this text name this criterion" — one this repository has
 * answered in one place since `criterion-inventory` was written. The two
 * were free to disagree and did: `oneScMentionPattern`'s `\b` fires on a
 * hyphen-to-letter transition, so it matches `partial-SC-9001`, and the
 * hand-rolled leading class `[^\w-]` refused that same text. A criterion
 * named in that form would have been reported uncovered by this reading
 * and covered by every other consumer of the shared pattern. Found in
 * review of #1713.
 *
 * Trailing-side behaviour is the part that must not move: `(?![\w-])`
 * stops `SC-9001` matching inside `SC-90011`, and a reading that credited
 * a criterion no issue names is indistinguishable from a board somebody
 * actually populated.
 */
export function criterionCoverage(
  content: string,
  issues: readonly { number: number; criteriaField?: string | null }[],
  columnRead: boolean,
): CriterionCoverage[] {
  if (!columnRead) return [];
  // Ascending, so "the lowest number wins" is the first write rather than a
  // comparison every later issue has to remember to make.
  const ordered = [...issues].sort((a, b) => a.number - b.number);
  const placed = placementsById(content);
  return parseCriteria(content).map(c => {
    const naming = ordered.find(
      i => typeof i.criteriaField === "string" && oneScMentionPattern(c.id).test(i.criteriaField),
    );
    return { id: c.id, satisfiedByIssue: naming?.number ?? null, recordedTrue: c.ticked, ...outsidePhases(placed.get(c.id)) };
  });
}

export interface MilestoneAction {
  /** What the milestone should be called. Derived, never typed. */
  title: string;
  phase: number;
  /** How many criteria the table places in this phase. */
  criteria: string[];
  /**
   * `rename` is a changed TITLE; `update` is the same title and a changed
   * DESCRIPTION. Both write; they are separate values because the human
   * output prints `was: <old title>` for a rename and that line is
   * meaningless — and misleading — when the title did not move.
   */
  action: "create" | "rename" | "update" | "unchanged";
  /** Set for everything but `create`: the live milestone this matched. */
  existing?: { number: number; title: string; description: string | null };
}

export interface LiveMilestone {
  number: number;
  title: string;
  /**
   * **Read, and load-bearing.** `milestonePlan` used to call a phase
   * `unchanged` on title equality alone, so a milestone whose criteria list
   * changed while its heading text did not was never rewritten — and
   * `milestoneBody`'s own docblock claimed the opposite, that a description
   * "is rewritten on every `--write`, so it cannot drift from the table the
   * way a typed title did". A comment asserting a property nothing checks is
   * the reason nobody checks it. Found by the AI review of PR #1647.
   *
   * `null` is what the API returns for a milestone with no description, and
   * it is a different fact from `""`.
   */
  description: string | null;
}

/**
 * What a milestone's description says.
 *
 * The criteria, and where they came from. A milestone description is the one
 * place a person looking at the board can see what the phase is FOR without
 * opening the spec.
 *
 * **It lives here, beside the comparison that reads it**, and not in
 * `scripts/plan-spec.ts` where it was written. The plan has to decide whether
 * a live description already equals the derived one, and a deriver the plan
 * cannot see is a plan that can only compare titles — which is exactly the
 * defect above. Two places deriving this string would be two deciders over
 * one question (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
export function milestoneBody(criteria: string[]): string {
  return `${criteria.length} criteria: ${criteria.join(", ")}\n\nDerived from the spec's Phase placement table by \`rungate plan-spec\`. Edit the table, not this.`;
}

/**
 * What to do to the repository's milestones so they match the spec's phases.
 *
 * `prefix` is the spec's short name — `Convergence` gives *Convergence Phase 1
 * — stop the repeats*. It is an argument rather than derived from the filename
 * because `CODE-REVIEW-CONVERGENCE-SPEC.md` would derive *Code Review
 * Convergence*, which is not what the eight live milestones are called, and a
 * renaming migration is a worse first run than typing one word.
 *
 * A live milestone whose title carries no `Phase N` for this prefix is left
 * alone and reported by the caller, not deleted. `Convergence Machinery` is
 * the live instance: real, in use, and derived from nothing here.
 *
 * ## `renameFrom`: moving a whole family to a new name (#2124)
 *
 * Without it, renaming the family in config plans a CREATE per phase, and
 * every issue stays in the old milestones, now unmanaged. With it, a phase
 * that has no milestone in `prefix` takes the one `renameFrom` holds for that
 * phase as its existing milestone. The action is then a rename that keeps
 * the milestone number, so every issue keeps its lane. Only the table's
 * phases are adopted; an old-family milestone for any other phase stays
 * unmanaged.
 *
 * A phase both families hold is a `conflict`. Neither milestone is picked,
 * because either pick strands the other's issues. The caller refuses.
 */
export interface FamilyConflict {
  phase: number;
  /** The milestone already in the family being written. */
  current: LiveMilestone;
  /** The milestone in the family being renamed from. */
  previous: LiveMilestone;
}

export function milestonePlan(
  content: string,
  live: LiveMilestone[],
  prefix: string,
  renameFrom?: string,
): { actions: MilestoneAction[]; unmanaged: LiveMilestone[]; conflicts: FamilyConflict[] } {
  const headings = new Map(parsePhaseHeadings(content).map(h => [h.number, h]));
  const rows = parsePlacementRows(content);
  const byPhase = new Map<number, string[]>();
  for (const r of rows) {
    const m = r.placement.match(PHASE_VALUE);
    if (m) byPhase.set(Number(m[1]), r.ids);
  }

  const phaseOf = (title: string): number | null => phaseInFamily(title, prefix);
  const liveByPhase = new Map<number, LiveMilestone>();
  for (const l of live) {
    const n = phaseOf(l.title);
    if (n !== null) liveByPhase.set(n, l);
  }
  const previousByPhase = new Map<number, LiveMilestone>();
  if (renameFrom !== undefined) {
    for (const l of live) {
      const n = phaseInFamily(l.title, renameFrom);
      if (n !== null && byPhase.has(n)) previousByPhase.set(n, l);
    }
  }
  const conflicts: FamilyConflict[] = [];
  for (const [phase, previous] of previousByPhase) {
    const current = liveByPhase.get(phase);
    if (current) conflicts.push({ phase, current, previous });
  }
  // Adopted means USED as a phase's existing milestone. A conflicting phase
  // keeps its current-family milestone, so its old one is in no action and
  // must stay in `unmanaged` rather than vanish (review of #2126).
  const adopted = new Set(
    [...previousByPhase].filter(([phase]) => !liveByPhase.has(phase)).map(([, m]) => m.number),
  );

  const actions = [...byPhase.keys()]
    .sort((a, b) => a - b)
    .map((phase): MilestoneAction => {
      const heading = headings.get(phase);
      const title = `${prefix} ${heading ? heading.heading : `Phase ${phase}`}`;
      const existing = liveByPhase.get(phase) ?? previousByPhase.get(phase);
      const criteria = byPhase.get(phase) ?? [];
      if (!existing) return { title, phase, criteria, action: "create" };
      // Both halves of what `--write` would put there, so `unchanged` means
      // the live milestone already IS the derived one rather than merely
      // sharing its name. A title-only comparison leaves a stale criteria
      // list on a phase whose heading text did not move — see
      // `LiveMilestone.description`.
      const titleMoved = existing.title !== title;
      const bodyMoved = existing.description !== milestoneBody(criteria);
      return {
        title,
        phase,
        criteria,
        action: titleMoved ? "rename" : bodyMoved ? "update" : "unchanged",
        existing,
      };
    });

  return {
    actions,
    unmanaged: live.filter(l => phaseOf(l.title) === null && !adopted.has(l.number)),
    conflicts: conflicts.sort((a, b) => a.phase - b.phase),
  };
}

/**
 * Which of a phase's criteria no open issue names, per milestone.
 *
 * **The reading is NAMES, not SERVES.** Whether an issue genuinely advances a
 * criterion is a judgement, and a column holding a judgement is the
 * human-settable boolean this whole change exists to escape, rebuilt one level
 * up. A word-boundary name match is mechanical and re-derivable by anyone, and
 * its error rate is known and bad in the safe direction: the tick-versus-issue
 * sweep on 2026-10-28 returned 12 raw hits of which 2 to 3 were real, so this
 * OVER-reports coverage's absence being fixed and never invents it.
 *
 * ## `oneScMentionPattern`, not a pattern of its own
 *
 * The first version built its own `(?<!…)id(?!…)` regex. That was a SECOND
 * DECIDER for a question `scripts/criterion-inventory.ts` has answered since
 * it was written, via `oneScMentionPattern`. The two were free to disagree
 * about exactly the input that matters — an id that is a prefix of another,
 * `CRC-M1` inside `CRC-M15` — with each side's tests green, which is
 * `.claude/rules/checks-must-be-able-to-fail.md`'s *two deciders that agree*.
 * They did already differ: this one excluded a trailing `-` and
 * `oneScMentionPattern`'s `(?![\w-])` excludes a trailing `_` as well.
 *
 * Caught by Jason asking whether a tool for this already existed, two hours
 * after the duplicate was committed. It did, and it is the better one.
 */
export function uncoveredByMilestone(
  actions: MilestoneAction[],
  issueBodies: { number: number; text: string }[],
): { title: string; phase: number; covered: string[]; uncovered: string[] }[] {
  const names = (id: string): boolean =>
    issueBodies.some(i => oneScMentionPattern(id).test(i.text));
  return actions.map(a => ({
    title: a.title,
    phase: a.phase,
    covered: a.criteria.filter(names),
    uncovered: a.criteria.filter(id => !names(id)),
  }));
}

/**
 * Whether a spec's criteria reach the board — #2275. Only an active `board:`
 * scope opts a spec in (SC-2776); deferred and undeclared are both outside,
 * and `rungate board-scope` names them as NOT TRACKED so "not on the board"
 * never reads as "done".
 */
export function tracksOnBoard(board: BoardDeclaration): boolean {
  return board.scope === "active";
}

/** The looks-done hint for one unticked criterion — see {@link onboardingHint}. */
export type OnboardingHint =
  | { kind: "looks-done" }
  | { kind: "ambiguous"; others: string[] }
  | { kind: "cannot-tell"; why: string };

/**
 * A HINT, never a tick, for one unticked criterion of `specPath` — #2275.
 *
 * `claimed` is the credit rule's own answer (`claimedScKeys` in
 * scripts/sync-sc-status.ts, read through the caller), so what counts as a
 * test claiming an id is decided in one place. An id that another spec also
 * states is ambiguous and is never matched, even when a test claims it: the
 * claim may be about the other spec's criterion.
 */
export function onboardingHint(
  id: string,
  specPath: string,
  claimed: (id: string) => boolean,
  declaredBy: ReadonlyMap<string, readonly string[]>,
): OnboardingHint {
  const others = (declaredBy.get(id) ?? []).filter(p => p !== specPath);
  if (others.length > 0) return { kind: "ambiguous", others };
  if (claimed(id)) return { kind: "looks-done" };
  return { kind: "cannot-tell", why: "no test claims it in a declaring position" };
}
