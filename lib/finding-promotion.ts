/**
 * Covers SC-2612 (SPEC-TO-BOARD-PIPELINE-SPEC.md) — #1678.
 *
 * Turn a review finding that names real work into a criterion in a spec.
 *
 * ## The one design decision, stated out loud
 *
 * **`promote` does not decide whether a finding is real work.** That is a
 * judgement, it is not re-derivable, and `lib/criterion-issue-census.ts`
 * already refused to make the sibling judgement a column for exactly this
 * reason: a boolean settable by whoever is looking rebuilds the
 * tick-is-proof defect one level up, inside the instrument built to measure
 * it.
 *
 * So the judgement arrives as INPUT — the caller supplies the criterion's
 * sentence and the symbol it names, and owns them. What this module
 * mechanises is everything downstream of that judgement and nothing before
 * it:
 *
 * | Mechanical, decided here | Judgement, supplied by the caller |
 * |---|---|
 * | does the issue already serve a criterion | is this finding real work |
 * | is the target spec one a criterion can live in | which spec it belongs to |
 * | which id is free, and in whose block | what the criterion should say |
 * | the criterion line's form | which symbol proves it |
 *
 * The second column is why this is not a `--auto` flag over the backlog.
 *
 * ## It reuses the decider that already exists
 *
 * "Does this issue serve a criterion" is answered by `criteriaNamedBy` in
 * `lib/board-mirror.ts`, which the board renders from. A second answer to
 * that question here would be behaviourally ONE decider with a dead half
 * nobody can identify — the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`, and the defect this
 * repository hits most. The board and this module agree because they are the
 * same call, not because two implementations were kept in step.
 *
 * ## It fails closed
 *
 * Every refusal is a named member of {@link PROMOTION_REFUSALS}, and they are
 * all produced by {@link promotionViolations} — one binding, so a mutation of
 * it moves every refusing case at once and a case that passes for an
 * unrelated reason is distinguishable from one genuinely caught.
 */
import { existsSync, readFileSync } from "fs";
import { resolve, sep } from "path";

import { NAMES_NONE, answerableIds, criteriaNamedBy, criterionAnswer, specCriteriaIn } from "./board-mirror";
import { allocateScNumber, formatSCLine } from "./create-sc";
import { ISSUE_SECTIONS, headingFor, headingOccurrencesOf } from "./issue-shape";
import type { ScRegistry } from "./sc-ids";
import { declaresDeferred, parsePlacementRows, placementReading } from "./spec-placement";

/** The issue a finding was filed as. The shape `criteriaNamedBy` reads. */
export interface PromotableIssue {
  readonly number: number;
  readonly title: string;
  readonly body?: string | null;
}

export interface PromotionInput {
  readonly issue: PromotableIssue;
  /** Repo-relative path of the spec the criterion will live in. */
  readonly spec: string;
  /** The criterion's sentence. The caller's judgement, carried verbatim. */
  readonly outcome: string;
  /** The symbol the criterion names, so it points at something a test can move. */
  readonly symbol: string;
  /** The module the symbol lives in, e.g. `lib/finding-promotion.ts`. */
  readonly module: string;
  readonly projectRoot: string;
  /** Branch the reservation allocator should draw this id out of. */
  readonly owner?: string | null;
  /**
   * The letter group for a spec whose ids are grouped, like the convergence
   * spec's `CRC-M17` (#2066). Which section a criterion belongs to is the
   * caller's judgement, like the symbol; it is refused when the spec needs
   * one and none is given.
   */
  readonly group?: string | null;
}

/**
 * Every way a promotion can be refused.
 *
 * Closed set, by design. A refusal nobody can name is a refusal nobody can
 * act on, and "it didn't work" is the state this whole line of work exists to
 * stop being reportable.
 */
export const PROMOTION_REFUSALS = [
  "SPEC_OUTSIDE_TREE",
  "SPEC_ABSENT",
  "SPEC_UNREADABLE",
  "SWEEP_UNMEASURED",
  "SPEC_STATES_NO_CRITERIA",
  "ALREADY_SERVES",
  "NO_OUTCOME",
  "NO_SYMBOL",
  "NO_MODULE",
  "MALFORMED_STATEMENT",
  "ID_UNAVAILABLE",
  "SYMBOL_EXISTS",
  "AMBIGUOUS_HEADING",
  "GROUP_REQUIRED",
  "GROUP_UNKNOWN",
  "PHASE_REQUIRED",
  "PHASE_ROW_ABSENT",
  "BANK_DRIFT",
  "ALREADY_PLACED",
] as const;

export type PromotionRefusal = (typeof PROMOTION_REFUSALS)[number];

export interface PromotionViolation {
  readonly refusal: PromotionRefusal;
  readonly why: string;
}

export type Promotion =
  | {
      readonly promoted: true;
      /** The criterion id, e.g. `SC-2615`. */
      readonly id: string;
      /** The line to insert, already in the form `sync-sc-status` reads. */
      readonly line: string;
      readonly spec: string;
      readonly issue: number;
      /** Anything the allocator could not consult, carried rather than dropped. */
      readonly unmeasured: readonly string[];
      /**
       * The spec already states this exact criterion — a retry after the issue
       * link failed (review of #2065). The caller writes nothing and links.
       */
      readonly alreadyWritten: boolean;
    }
  | { readonly promoted: false; readonly refusal: PromotionRefusal; readonly why: string };

/**
 * The one resolver, exported so the CLI writes the file this module read.
 *
 * It had two: this resolved an absolute `--spec` as-is while
 * `scripts/finding-promotion.ts` did `join(ROOT, spec)`, so for an absolute
 * path the file VALIDATED and the file WRITTEN were different files. A guard
 * whose subject is not the consumer's subject is not a guard.
 *
 * Containment to `specs/` is not a privilege boundary — the caller is a
 * developer running a CLI in their own checkout and already owns the disk.
 * It is here because a criterion written anywhere else is invisible to
 * `specCriteriaIn`, `criterion-inventory` and `sync-sc-status`: the write
 * would succeed and the criterion would not exist as far as this repository
 * can tell.
 */
export function specPath(input: Pick<PromotionInput, "spec" | "projectRoot">): string {
  return resolve(input.projectRoot, input.spec);
}

/** Is the resolved target inside the project's `specs/` directory. */
function insideSpecs(input: Pick<PromotionInput, "spec" | "projectRoot">): boolean {
  return specPath(input).startsWith(resolve(input.projectRoot, "specs") + sep);
}

/**
 * A criterion is ONE line, and this is what keeps it one.
 *
 * `outcome`, `symbol` and `module` are the caller's free text and they are
 * interpolated straight into markdown that `sync-sc-status` later parses. A
 * newline in any of them appends further lines to a spec, and the cheapest
 * useful one to append is `- [x] SC-NNNN: …` — a ticked criterion nobody
 * wrote, in the file that is this repository's record of what is proved.
 * `create-sc` guards its own statement with a regex; this is that guard.
 */
const CRITERION_LINE = /^- \[ \] SC-\d+: [^\n\r]+$/;

/**
 * Every free-text field `promotionStatement` interpolates, and its refusal.
 *
 * A LIST rather than three `if` blocks, because the first version guarded
 * `outcome` and `symbol` and silently left `module` — an empty module
 * produced `" contains [promote] — …"`, which still matches
 * {@link CRITERION_LINE} and so sailed past the only other guard. Two of
 * three is the shape this repository keeps shipping: the named instance
 * repaired, its siblings left, and no behavioural case able to tell.
 *
 * `test/finding-promotion.test.ts` derives its cases from this array, so a
 * fourth field added to `promotionStatement` without a row here is red
 * rather than unguarded.
 */
const STATEMENT_FIELDS = [
  {
    field: "outcome",
    refusal: "NO_OUTCOME",
    why: "a criterion with no sentence states nothing, so nothing could ever prove it",
  },
  {
    field: "symbol",
    refusal: "NO_SYMBOL",
    why:
      "a criterion that names no symbol cannot be moved by a mutation, so a test claiming " +
      "it would be green by construction",
  },
  {
    field: "module",
    refusal: "NO_MODULE",
    why:
      "a criterion that names no module points its symbol at the whole tree, and " +
      "sync-sc-status has no file to look in",
  },
] as const satisfies readonly {
  field: "outcome" | "symbol" | "module";
  refusal: PromotionRefusal;
  why: string;
}[];

/** The fields above, for a test that wants to sweep them. */
export const STATEMENT_FIELD_NAMES = STATEMENT_FIELDS.map(f => f.field);

/**
 * Every reason this promotion must not happen, in the order a reader should
 * hear them.
 *
 * **This is the single binding.** `promote` adds no condition of its own, so
 * short-circuiting this function to `[]` turns every refusing case into a
 * promoting one — which is what `test/finding-promotion.test.ts` does to
 * prove the refusals are observed rather than incidental.
 */
/**
 * Would `<module> contains [<symbol>]` already read as met? The SAME reading
 * the matcher takes — `content-contains` in `lib/conformity.ts` is
 * `expect(content).toContain(item)`: raw substring, comments and strings
 * included. A narrower check here (a whole-identifier match, the first cut
 * of #2060) let `promoted` through for symbol `promote`, which the matcher
 * then reads as present: the false pass this refusal exists to stop.
 */
function matcherWouldPass(text: string, symbol: string): boolean {
  return text.includes(symbol);
}

export function promotionViolations(input: PromotionInput): PromotionViolation[] {
  const out: PromotionViolation[] = [];

  for (const { field, refusal, why } of STATEMENT_FIELDS) {
    if (input[field].trim() === "") out.push({ refusal, why });
  }

  // #2060: the criterion is matched by `<module> contains [<symbol>]`, a
  // presence check. A symbol the module already contains makes a criterion
  // for work nobody has done read as met — `heredocInterpreter` on #2034.
  // A module that exists and cannot be read cannot prove the symbol absent.
  if (input.symbol.trim() !== "" && input.module.trim() !== "") {
    const modulePath = resolve(input.projectRoot, input.module);
    if (existsSync(modulePath)) {
      let text: string | null;
      try {
        text = readFileSync(modulePath, "utf8");
      } catch {
        text = null;
      }
      if (text === null || matcherWouldPass(text, input.symbol)) {
        out.push({
          refusal: "SYMBOL_EXISTS",
          why:
            text === null
              ? `${input.module} exists and could not be read, so ${input.symbol} cannot be shown to be absent`
              : `${input.module} already contains ${input.symbol}, so \`contains [${input.symbol}]\` would read ` +
                "as met before the work it names is done — pick a name the work will introduce",
        });
      }
    }
  }

  // Checked before `existsSync`, so a path outside the tree is named for what
  // it is rather than reported as a missing spec.
  if (!insideSpecs(input)) {
    out.push({
      refusal: "SPEC_OUTSIDE_TREE",
      why:
        `${input.spec} resolves outside ${input.projectRoot}/specs, and a criterion written ` +
        "there is invisible to specCriteriaIn, criterion-inventory and sync-sc-status",
    });
    return out;
  }

  const path = specPath(input);
  if (!existsSync(path)) {
    out.push({
      refusal: "SPEC_ABSENT",
      why: `${input.spec} is not in this tree, so the criterion would have no home`,
    });
    // Everything below reads the file. Stop rather than guess at its contents.
    return out;
  }

  // EXISTS is not READABLE, and the two refusals must not share a message.
  // A directory where a file was, or a permission, satisfies `existsSync`
  // and throws here. Checked before the sweep because the sweep answers a
  // target it cannot parse by simply contributing no ids, which reads
  // downstream as "this spec states no criteria" — a true-sounding sentence
  // about a file nobody managed to open.
  try {
    readFileSync(path, "utf8");
  } catch (e) {
    out.push({
      refusal: "SPEC_UNREADABLE",
      why: `${input.spec} exists and could not be read: ${e instanceof Error ? e.message : String(e)}`,
    });
    return out;
  }

  // The WHOLE tree, not this spec's ids. Scoping the duplicate check to the
  // target let an issue serving a criterion in spec A promote into spec B
  // unopposed — which is the outcome the refusal below says it prevents, so
  // the detector was narrower than the thing it detects.
  const sweep = specCriteriaIn(input.projectRoot);

  // FIRST, and returning. `specCriteriaIn` answers UNMEASURED with
  // `specs: []` and `ids: []`, so every reading below it is the reading for
  // an empty tree: `hereIds` is empty and SPEC_STATES_NO_CRITERIA fires,
  // reporting "this spec states no criteria" when the fact is "the sweep
  // could not be taken". Two different states, one message, and the
  // UNMEASURED branch that used to sit further down could never be reached.
  //
  // Found by the AI review of `4d48c7a3`, and the measurement is worse than
  // the finding: `test/finding-promotion.test.ts`'s own
  // SPEC_STATES_NO_CRITERIA case was passing through this path, so the
  // criterion it claimed to cover was green for the wrong reason.
  if (sweep.reading === "UNMEASURED") {
    out.push({
      refusal: "SWEEP_UNMEASURED",
      why:
        "the spec sweep could not be taken, so neither 'this spec states no criteria' nor " +
        "'this issue serves none' is a reading anything here can make: " +
        sweep.unmeasuredReasons.join("; "),
    });
    return out;
  }

  // `sweep.ids` keeps only criteria stated by exactly ONE spec — an id two
  // specs both state is dropped and reported under `collisions`, because the
  // board's cell has no room to say which spec was meant.
  //
  // That exclusion answers "which criterion do I attribute this issue to".
  // The question here is "does this issue serve ANY criterion", and for that
  // the ambiguity is irrelevant: an issue naming `SC-A1`, which three specs
  // in this tree state, serves a criterion whichever one it meant. Reusing
  // the narrower set let exactly those issues promote.
  const allIds = answerableIds(sweep);
  const hereIds = sweep.specs.find(s => resolve(input.projectRoot, s.path) === path)?.ids ?? [];

  if (hereIds.length === 0) {
    out.push({
      refusal: "SPEC_STATES_NO_CRITERIA",
      why:
        `${input.spec} states no criteria, so it has no section a criterion belongs in — ` +
        "promoting into it would put the first one somewhere nothing reads",
    });
  }

  // Before the spec is written, not when the link fails after it: the link
  // has no one section to write into (review of #2065).
  const ambiguity = criteriaHeadingAmbiguity(input.issue.body ?? "", `#${input.issue.number}`);
  if (ambiguity !== null) out.push({ refusal: "AMBIGUOUS_HEADING", why: ambiguity });

  // The existing decider, not a second one. See the module docblock.
  const alreadyServes = criteriaNamedBy(input.issue, allIds);
  if (alreadyServes.length > 0) {
    out.push({
      refusal: "ALREADY_SERVES",
      why:
        `#${input.issue.number} already names ${alreadyServes.join(", ")}, so promoting it ` +
        "would give one piece of work two criteria and make both of them partly true",
    });
  }

  // Last, because it reads `outcome` and `symbol`, and an empty one of those
  // is already reported above with a reason a caller can act on.
  if (out.length === 0 && !CRITERION_LINE.test(formatSCLine(1, promotionStatement(input)))) {
    out.push({
      refusal: "MALFORMED_STATEMENT",
      why:
        "the statement would not be a single criterion line — a newline or carriage return in " +
        "--outcome, --symbol or --module appends further markdown to the spec, and the cheapest " +
        "thing to append is a ticked criterion nobody wrote",
    });
  }

  return out;
}

/**
 * The criterion a promoted finding becomes.
 *
 * Form follows `create-sc`: `contains [symbol]` is what `sync-sc-status`
 * matches on, so a criterion written any other way is one nothing can tick.
 */
export function promotionStatement(input: PromotionInput): string {
  return `${input.module} contains [${input.symbol}] — ${input.outcome}`;
}

/**
 * Promote a finding into a criterion, or refuse and say which refusal it was.
 *
 * Pure: it allocates an id and returns the line. The write is the caller's,
 * so a dry run and a real run read the same spec and compute the same answer.
 *
 * `registry` has **no default**, for the reason `createIssue`'s `gate` has
 * none (#1677): the reader lives in `scripts/sync-sc-status.ts`, and a lib
 * reaching into `scripts/` to supply its own would both invert the
 * dependency and make "a caller that forgot" a silent behaviour change. With
 * no default the compiler catches every site.
 */
export function promote(input: PromotionInput, registry: ScRegistry): Promotion {
  const violations = promotionViolations(input);
  // SYMBOL_EXISTS alone is held until the already-written scan below: once
  // the criterion is in the spec, the symbol appearing is the work landing,
  // and a retry of a failed link must still reach the link (review of #2065).
  // Every other refusal holds. SYMBOL_EXISTS alone also means every spec
  // check passed, so the read below is of a spec inside the tree.
  // The blocker is reported, not SYMBOL_EXISTS, which is pushed early and
  // would otherwise sit at index 0 over a missing spec (review of #2065).
  const blocker = violations.find(v => v.refusal !== "SYMBOL_EXISTS");
  if (blocker) return { promoted: false, refusal: blocker.refusal, why: blocker.why };

  // Inside a guard, because `promotionViolations` proved the file EXISTS and
  // existing is not the same as readable — a permission, a directory where a
  // file was, or a removal between the two calls. An uncaught throw out of a
  // function whose docblock says it fails closed is the one shape a caller
  // cannot handle as a refusal.
  let specText: string;
  try {
    specText = readFileSync(specPath(input), "utf8");
  } catch (e) {
    return {
      promoted: false,
      refusal: "SPEC_UNREADABLE",
      why: `${input.spec} exists and could not be read: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // A retry after a failed issue link finds its own line already written.
  // Allocating again would append a second copy of one criterion for one
  // finding (review of #2065), so the existing line is the answer.
  const statement = promotionStatement(input);
  for (const raw of specText.split("\n")) {
    const m = /^- \[[ xX]\] ([A-Z]+-[A-Z]?\d+): (.*)$/.exec(raw);
    if (m && m[2] === statement) {
      return {
        promoted: true,
        id: m[1]!,
        line: raw,
        spec: input.spec,
        issue: input.issue.number,
        unmeasured: [],
        alreadyWritten: true,
      };
    }
  }

  if (violations.length > 0) {
    const first = violations[0]!;
    return { promoted: false, refusal: first.refusal, why: first.why };
  }

  // #2066: a spec whose criteria use their own grouped family (the
  // convergence spec's `CRC-M17`) gets an id in that family, never an `SC-`
  // id. It used to be allocated `SC-N` and renamed by hand.
  const family = idFamily(specText);
  if (family !== "SC") {
    const grouped = nextGroupedId(specText, family, input.group ?? null);
    if (!grouped.ok) return { promoted: false, refusal: grouped.refusal, why: grouped.why };
    return {
      promoted: true,
      id: grouped.id,
      line: `- [ ] ${grouped.id}: ${statement}`,
      spec: input.spec,
      issue: input.issue.number,
      // Said, not hidden: `SC-` ids go through specs/sc-reservations.json, and
      // a grouped family has no reservation registry, so another branch
      // promoting into the same group can take the same id (review of #2105).
      unmeasured: [
        `${family}-* ids have no reservation registry: an id another branch allocated in group ${input.group} is not visible here`,
      ],
      alreadyWritten: false,
    };
  }

  let allocated: { number: number; namespace: { unmeasured: string[] } };
  try {
    allocated = allocateScNumber(input.projectRoot, specText, registry, {
      owner: input.owner ?? null,
    }) as typeof allocated;
  } catch (e) {
    // The allocator refuses on an unreadable reservation store and on a spent
    // block. Both are states where handing out a number would collide with
    // work nobody in this session can see.
    return {
      promoted: false,
      refusal: "ID_UNAVAILABLE",
      why: e instanceof Error ? e.message : String(e),
    };
  }

  return {
    promoted: true,
    id: `SC-${allocated.number}`,
    line: formatSCLine(allocated.number, promotionStatement(input)),
    spec: input.spec,
    issue: input.issue.number,
    unmeasured: allocated.namespace.unmeasured ?? [],
    alreadyWritten: false,
  };
}

/** A criterion id at the start of a checkbox line, any family: `SC-12`, `CRC-M17`. */
const ANY_CRITERION_LINE = /^- \[[ xX]\] ([A-Z]+)-([A-Z]?)(\d+):/;

/**
 * The id family a spec's criteria use — #2066.
 *
 * `SC` unless every criterion in the spec uses one other prefix, as the
 * convergence spec's `CRC-*` do. A spec with no criteria, or a mixture, is
 * `SC`: a mixture has no single family to continue, and `SC` is the
 * repository's default.
 */
export function idFamily(specText: string): string {
  const prefixes = new Set<string>();
  for (const line of specText.split("\n")) {
    const m = ANY_CRITERION_LINE.exec(line);
    if (m) prefixes.add(m[1]!);
  }
  return prefixes.size === 1 && !prefixes.has("SC") ? [...prefixes][0]! : "SC";
}

/**
 * The next id in a grouped family: one above the highest number in the
 * group. The group must already exist in the spec — a letter nothing uses is
 * almost always a typo, and a new section is a spec edit, not a promotion.
 */
export function nextGroupedId(
  specText: string,
  family: string,
  group: string | null,
): { ok: true; id: string } | { ok: false; refusal: PromotionRefusal; why: string } {
  if (group === null || group.trim() === "") {
    return {
      ok: false,
      refusal: "GROUP_REQUIRED",
      why: `this spec's criteria are ${family}-* ids in letter groups; pass --group <letter> to say which section this one belongs to`,
    };
  }
  let highest = 0;
  let seen = false;
  for (const line of specText.split("\n")) {
    const m = ANY_CRITERION_LINE.exec(line);
    if (m && m[1] === family && m[2] === group) {
      seen = true;
      highest = Math.max(highest, Number(m[3]));
    }
  }
  if (!seen) {
    return { ok: false, refusal: "GROUP_UNKNOWN", why: `no criterion in this spec is ${family}-${group}*; check the letter` };
  }
  return { ok: true, id: `${family}-${group}${highest + 1}` };
}

/**
 * The spec with the criterion line inserted where the spec keeps its
 * criteria, and its id placed in a phase when asked — #2066.
 *
 * The line goes after the last criterion of its own group (any criterion, for
 * an ungrouped family), below that criterion's indented `proved-by:` lines.
 * It used to be appended at the end of the file, under whatever section came
 * last, and moved by hand.
 *
 * **A spec that places its criteria refuses an unplaced one.** When the spec
 * has a Phase placement table that is fully read, a criterion with no phase
 * leaves `spec-placement` short, and that reading is stage item E1's proof,
 * run live in every pull request's CI. So `--phase` is required there, and
 * the result is re-read with `placementReading`, the reader the check uses.
 */
export function specWithCriterion(
  specText: string,
  line: string,
  id: string,
  phase: number | null,
): { ok: true; text: string } | { ok: false; refusal: PromotionRefusal; why: string } {
  // Already written (a retry after a failed link): the line stays where it
  // is, and the phase and placement checks below still run on it, so a retry
  // with --phase places it and a missing row still refuses (review of #2105).
  const lines = specText.split("\n");
  const present = lines.includes(line);
  const [, family, group] = /^([A-Z]+)-([A-Z]?)\d+$/.exec(id) ?? [];
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = ANY_CRITERION_LINE.exec(lines[i]!);
    if (m && (family === "SC" || (m[1] === family && m[2] === group))) last = i;
  }
  let text: string;
  if (present) {
    text = specText;
  } else if (last === -1) {
    text = `${specText.trimEnd()}\n${line}\n`;
  } else {
    let at = last + 1;
    // Past the criterion's indented proof lines AND any note directly under
    // it, such as a `<!-- REVIEW: … -->` line: both belong to that criterion,
    // and a new line between them moves the note onto the wrong one (#2107).
    while (
      at < lines.length &&
      (/^\s+\S/.test(lines[at]!) || /^<!--.*-->\s*$/.test(lines[at]!)) &&
      !ANY_CRITERION_LINE.test(lines[at]!)
    ) {
      at++;
    }
    text = [...lines.slice(0, at), line, ...lines.slice(at)].join("\n");
  }
  if (phase !== null) {
    // One home per criterion: an id already in a DIFFERENT phase row is refused
    // rather than listed twice (#2107). Its own row again is a no-op below.
    const elsewhere = parsePlacementRows(text).find(r => r.ids.includes(id) && r.placement !== `Phase ${phase}`);
    if (elsewhere) {
      return {
        ok: false,
        refusal: "ALREADY_PLACED",
        why: `${id} is already placed in ${elsewhere.placement}; a criterion has one phase, so move it by editing the table`,
      };
    }
    const placed = withPhase(text, id, phase);
    if (placed === null) {
      return { ok: false, refusal: "PHASE_ROW_ABSENT", why: `this spec's Phase placement table has no row for Phase ${phase}` };
    }
    text = placed;
  }
  const reading = placementReading(text);
  if (reading.reading === "MEASURED" && reading.unplaced.includes(id)) {
    return {
      ok: false,
      refusal: "PHASE_REQUIRED",
      why: `this spec places every criterion in a phase, so ${id} needs --phase N; unplaced, it would leave spec-placement short`,
    };
  }
  return { ok: true, text };
}

/** The spec with `id` added to its `Phase N` placement row, or null when there is no such row. */
function withPhase(specText: string, id: string, phase: number | null): string | null {
  if (phase === null) return specText;
  const row = parsePlacementRows(specText).find(r => r.placement === `Phase ${phase}`);
  if (!row) return null;
  if (row.ids.includes(id)) return specText;
  const lines = specText.split("\n");
  const cells = lines[row.line - 1]!.split("|");
  // `| **Phase 6** | SC-1, SC-2 | notes |` splits to ["", " **Phase 6** ", " SC-1, SC-2 ", " notes ", ""].
  const idsCell = cells[2]!.trim();
  cells[2] = ` ${idsCell === "" ? id : `${idsCell}, ${id}`} `;
  lines[row.line - 1] = cells.join("|");
  return lines.join("\n");
}

/**
 * The deferral bank with this spec's count moved to its new number, when the
 * spec is deferred — #2066.
 *
 * `spec-placement` refuses a deferred spec whose criteria count disagrees with
 * `.claude/spec-deferral-ratchet.json`, so a promotion into one left E1's proof
 * red until the bank was edited by hand. The bank moves only from the count
 * the spec had BEFORE this promotion: a bank already out of step is drift
 * someone has to look at, and moving it silently would hide it.
 */
export function bankWithPromotion(
  bankText: string,
  specPath: string,
  before: number,
  after: number,
): { ok: true; text: string } | { ok: false; refusal: PromotionRefusal; why: string } {
  let bank: { deferred?: { path: string; criteria: number }[] };
  try {
    bank = JSON.parse(bankText);
  } catch (e) {
    return { ok: false, refusal: "BANK_DRIFT", why: `the deferral bank is not JSON (${(e as Error).message})` };
  }
  const row = Array.isArray(bank.deferred) ? bank.deferred.find(d => d.path === specPath) : undefined;
  if (!row) return { ok: false, refusal: "BANK_DRIFT", why: `${specPath} is deferred and not in the deferral bank` };
  if (row.criteria !== before) {
    return {
      ok: false,
      refusal: "BANK_DRIFT",
      why: `the deferral bank holds ${row.criteria} for ${specPath}, which states ${before}; reconcile it before promoting`,
    };
  }
  row.criteria = after;
  return { ok: true, text: `${JSON.stringify(bank, null, 2)}\n` };
}

/**
 * The bank on a RETRY, when the criterion is already in the spec — review of
 * #2105.
 *
 * A run whose spec write landed and whose bank write failed leaves the bank
 * one behind. A retry finds the line already written, sees no count change,
 * and without this would report success over a bank that disagrees with the
 * spec, so the next unrelated promotion is the one refused. So: in step, write
 * nothing (`text: null`); exactly one behind, move it; further out, refuse.
 */
export function bankForRetry(
  bankText: string,
  specPath: string,
  count: number,
): { ok: true; text: string | null } | { ok: false; refusal: PromotionRefusal; why: string } {
  let bank: { deferred?: { path: string; criteria: number }[] };
  try {
    bank = JSON.parse(bankText);
  } catch (e) {
    return { ok: false, refusal: "BANK_DRIFT", why: `the deferral bank is not JSON (${(e as Error).message})` };
  }
  const row = Array.isArray(bank.deferred) ? bank.deferred.find(d => d.path === specPath) : undefined;
  if (row?.criteria === count) return { ok: true, text: null };
  return bankWithPromotion(bankText, specPath, count - 1, count);
}

/** Whether `specText` is deferred, and how many criteria it states, as `spec-placement` reads them. */
export function placementCount(specText: string): { deferred: boolean; criteria: number } {
  return { deferred: declaresDeferred(specText), criteria: placementReading(specText).criteria.length };
}

/**
 * ## Declining — the router's other outcome
 *
 * `NAMES_NONE` has been readable since SC-2609 and writable by nothing.
 * `scripts/board-snapshot.ts` reports an issue carrying the literal as a
 * DELIBERATE decline rather than a blank cell, which is the whole point of
 * spelling the value: *not yet filled in*, *the tool could not tell* and
 * *deliberately none* stop being the same zero bytes.
 *
 * The one creation path was worse than none. `.github/ISSUE_TEMPLATE/
 * spec-work.yml` tells a human author to type the phrase, so the board's
 * only source for "this work serves no criterion" was a **self-declaration**
 * — the shape `lib/criterion-issue-census.ts` refused to make a column and
 * this module's own docblock refuses to make a flag, for the same reason in
 * all three places: a judgement settable by whoever is looking rebuilds the
 * tick-is-proof defect inside the instrument built to measure it.
 *
 * So the declaration is an OUTCOME here, on the same terms as a promotion:
 *
 * - The board must already agree there is no criterion. {@link decline} asks
 *   `criteriaNamedBy` — the call the board renders from, not a second answer
 *   to the same question.
 * - A sweep that could not be taken refuses. "This issue serves none" is not
 *   a reading available to something that could not enumerate the criteria.
 * - The phrase is interpolated from {@link NAMES_NONE}. A producer that
 *   retyped it would be a second language for one value, which is exactly
 *   the drift `test/board-snapshot.test.ts` had to add a case for when the
 *   form said `none — machinery` and the reader matched the constant.
 */
export const DECLINE_REFUSALS = [
  "NO_WHY",
  "MALFORMED_WHY",
  "WHY_NAMES_CRITERION",
  "SWEEP_UNMEASURED",
  "ALREADY_SERVES",
  "ALREADY_DECLINED",
  "AMBIGUOUS_HEADING",
  "CRITERIA_SECTION_OCCUPIED",
] as const;

export type DeclineRefusal = (typeof DECLINE_REFUSALS)[number];

export interface DeclineViolation {
  readonly refusal: DeclineRefusal;
  readonly why: string;
}

export interface DeclineInput {
  readonly issue: PromotableIssue;
  /** The caller's reason. Their judgement, owned by them, and required. */
  readonly why: string;
  readonly projectRoot: string;
}

export type Decline =
  | {
      readonly declined: true;
      /**
       * The issue's COMPLETE new body — exactly the bytes a caller writes.
       *
       * The first version returned only `section` and documented it as the
       * preview. For a body already carrying an empty criteria heading
       * {@link bodyWithDecline} inserts the line alone, so the preview
       * showed a second heading that never appeared: a false report about
       * a write, which is the one thing this module exists not to produce.
       */
      readonly body: string;
      /** The standalone section, for a body that has no criteria heading. */
      readonly section: string;
      readonly issue: number;
    }
  | { readonly declined: false; readonly refusal: DeclineRefusal; readonly why: string };

/** The heading a declaration lives under, from the one place that names it. */
const CRITERIA_HEADING = headingFor(ISSUE_SECTIONS.find(s => s.id === "criteria")!);

/**
 * The text a decline writes.
 *
 * `NAMES_NONE` is interpolated, never retyped: `scripts/board-snapshot.ts`
 * matches the literal, so a producer spelling it itself would be a second
 * language for one value and the two would drift silently.
 */
export function declineSection(why: string): string {
  return `${CRITERIA_HEADING}\n\n${NAMES_NONE} — ${why.trim()}\n`;
}

/**
 * Every reason this decline must not be written.
 *
 * **The single binding.** {@link decline} adds no condition of its own, so
 * short-circuiting this to `[]` turns every refusing input into a declining
 * one — which is what `test/finding-promotion.test.ts` does to prove the
 * refusals are observed rather than incidental.
 */
export function declineViolations(input: DeclineInput): DeclineViolation[] {
  const out: DeclineViolation[] = [];

  if (input.why.trim() === "") {
    out.push({
      refusal: "NO_WHY",
      why:
        "a decline with no reason is a tick — it asserts a judgement and records nothing " +
        "anybody could later disagree with",
    });
  }

  // The `why` is interpolated into an issue BODY that `missingSections`
  // parses by heading, so a line opening with `#` forges a section. Same
  // class as MALFORMED_STATEMENT above, one layer out: there the cheapest
  // thing to append was a ticked criterion, here it is a Files heading that
  // makes an issue look like it named files nobody wrote.
  if (/^[ \t]*#{1,6}[ \t]/m.test(input.why)) {
    out.push({
      refusal: "MALFORMED_WHY",
      why:
        "--why opens a markdown heading, which forges a section in the issue body that " +
        "missingSections and every reader would then treat as the author's",
    });
  }

  // A FENCE, not only a heading. The first version guarded the heading and
  // not this, which is a detector narrower than what it detects: an odd
  // number of fence lines flips fence state for everything below, and
  // `headingOccurrencesOf`, `hasContent` and `missingSections` all track
  // fences the same way — so every later heading in the body becomes
  // invisible to all three at once and the issue parses as having no
  // sections at all. Refused outright rather than balanced, because a
  // one-line reason has no use for a code block.
  if (/^[ \t]*```/m.test(input.why)) {
    out.push({
      refusal: "MALFORMED_WHY",
      why:
        "--why contains a code fence, and an odd number of them flips fence state for the " +
        "rest of the body — every heading below it becomes invisible to headingOccurrencesOf, " +
        "hasContent and missingSections at once",
    });
  }

  const sweep = specCriteriaIn(input.projectRoot);

  // FIRST among the sweep-dependent readings, and returning. An UNMEASURED
  // sweep answers with `ids: []`, which makes "this issue serves no
  // criterion" true of every issue — the sentence this whole function exists
  // to stop being writable without evidence.
  if (sweep.reading === "UNMEASURED") {
    out.push({
      refusal: "SWEEP_UNMEASURED",
      why:
        "the spec sweep could not be taken, so 'this issue serves no criterion' is not a " +
        "reading anything here can make: " + sweep.unmeasuredReasons.join("; "),
    });
    return out;
  }

  // `collisions` folded in for the reason `promotionViolations` folds them
  // in: the question is whether the issue serves ANY criterion, and an id two
  // specs both state is still a criterion served.
  const allIds = answerableIds(sweep);

  // The existing decider, not a second one — the same call the board renders
  // from. A decline and a populated criteria cell are states the board cannot
  // hold at once, and the board, not this module, is the one that decides.
  const serves = criteriaNamedBy(input.issue, allIds);
  if (serves.length > 0) {
    out.push({
      refusal: "ALREADY_SERVES",
      why:
        `#${input.issue.number} already names ${serves.join(", ")}, so a decline would make the ` +
        "board say both that it serves a criterion and that it serves none",
    });
  }

  // Same decider again, pointed at the text about to be written. A reason
  // mentioning an id puts that id in the cell the moment this is appended,
  // so the declaration would contradict itself in the bytes it is made of.
  const namedByWhy = criteriaNamedBy({ title: "", body: input.why }, allIds);
  if (namedByWhy.length > 0) {
    out.push({
      refusal: "WHY_NAMES_CRITERION",
      why:
        `--why names ${namedByWhy.join(", ")}, and criteriaNamedBy reads the body this would be ` +
        "appended to, so the issue would declare no criterion in text that names one",
    });
  }

  const body = input.issue.body ?? "";

  // The one decider for the declaration (#2020), not a third copy of it.
  if (criterionAnswer(input.issue, allIds).servesNone) {
    out.push({
      refusal: "ALREADY_DECLINED",
      why:
        `#${input.issue.number} already declares it serves no criterion, and a second ` +
        "declaration would give board-snapshot two reasons it cannot tell apart",
    });
  }

  // Where the declaration would go. Both readings below are about the
  // WRITE, so they live here rather than in `bodyWithDecline`: a refusal
  // discovered by the writer is a refusal discovered after the caller was
  // told it would work.
  const headings = headingOccurrencesOf(body, CRITERIA_HEADING);
  const ambiguity = criteriaHeadingAmbiguity(body, `#${input.issue.number}`);
  if (ambiguity !== null) {
    out.push({ refusal: "AMBIGUOUS_HEADING", why: ambiguity });
  } else if (headings.length === 1 && hasTextUnder(body, headings[0]!)) {
    out.push({
      refusal: "CRITERIA_SECTION_OCCUPIED",
      why:
        `#${input.issue.number}'s criteria section already says something that names no ` +
        "criterion, and overwriting it would delete what the author wrote while declaring " +
        "the opposite of it",
    });
  }

  return out;
}

/**
 * Why `body` has no one criteria section to write into, or null when it has
 * zero or one. The one decider for the decline path, the promote path and
 * the link (review of #2065), so the three cannot disagree about the shape.
 */
export function criteriaHeadingAmbiguity(body: string, who: string): string | null {
  const count = headingOccurrencesOf(body, CRITERIA_HEADING).length;
  if (count <= 1) return null;
  return (
    `${who} opens "${CRITERIA_HEADING}" ${count} times, so there is ` +
    "no one section to write into and a reader cannot tell which one the board read"
  );
}

/** Non-blank text between the heading at `at` and the next heading. */
function hasTextUnder(body: string, at: number): boolean {
  for (const line of body.slice(at).split("\n").slice(1)) {
    if (/^#{1,6}\s+\S/.test(line)) return false;
    if (line.trim() !== "") return true;
  }
  return false;
}

/**
 * `body` with the declaration in the section the readers parse.
 *
 * Two shapes, because issues arrive in both: an `everyday-work` body has no
 * criteria heading and gains the whole section, and a `spec-work` body
 * filed through the form carries the heading with nothing under it and
 * gains only the line. Appending blindly in the second case puts the
 * declaration under whatever heading happens to be last — `Files this will
 * change`, in the form's own order — where `missingSections` still reports
 * the criteria section empty and the author sees a stray sentence in the
 * wrong place.
 *
 * Fence-aware through `headingOccurrencesOf`, which is the whole reason that
 * function was generalised out of `lib/issue-repair.ts`: these bodies quote
 * the template constantly, and a fence-blind insert lands inside a code
 * block where no reader of the rendered issue ever sees it.
 *
 * The ambiguous and occupied cases are refused upstream by
 * {@link declineViolations}, so this handles zero or one empty heading.
 */
export function bodyWithDecline(body: string, why: string): string {
  const at = headingOccurrencesOf(body, CRITERIA_HEADING)[0];
  const line = `${NAMES_NONE} — ${why.trim()}`;
  if (at === undefined) return `${body.trimEnd()}\n\n${declineSection(why)}`;
  const headingEnd = body.indexOf("\n", at);
  const cut = headingEnd === -1 ? body.length : headingEnd;
  return `${body.slice(0, cut)}\n\n${line}\n${body.slice(cut).replace(/^\n+/, "\n")}`;
}

/**
 * The issue body with `id` named under its `## Criteria this serves` heading
 * (#2060). A promotion used to print "now make #N name it" and leave the
 * edit to a person; ADR-015 linked twelve issues through repair rows
 * instead. Unchanged when the body already names `id`.
 *
 * Refuses a body with two criteria headings rather than picking the first.
 * `promote` refuses that shape before the spec is written; this catches a
 * body that gained one between that check and the re-read.
 */
export type CriterionLink =
  | { readonly linked: true; readonly body: string }
  | { readonly linked: false; readonly why: string };

export function withCriterionLinked(body: string, id: string): CriterionLink {
  if (criteriaNamedBy({ title: "", body }, [id]).length > 0) return { linked: true, body };
  // The number is not known here; the CLI names the issue in its message.
  const ambiguity = criteriaHeadingAmbiguity(body, "the issue");
  if (ambiguity !== null) return { linked: false, why: ambiguity };
  const at = headingOccurrencesOf(body, CRITERIA_HEADING)[0];
  if (at === undefined) return { linked: true, body: `${body.trimEnd()}\n\n${CRITERIA_HEADING}\n\n${id}\n` };
  const headingEnd = body.indexOf("\n", at);
  const cut = headingEnd === -1 ? body.length : headingEnd;
  return { linked: true, body: `${body.slice(0, cut)}\n\n${id}${body.slice(cut).replace(/^\n+/, "\n")}` };
}

/**
 * Decline on an issue's behalf, or refuse and say which refusal it was.
 *
 * Pure: it returns the markdown and writes nothing. The write is the
 * caller's, so a dry run and a real run compute the same answer.
 */
export function decline(input: DeclineInput): Decline {
  const violations = declineViolations(input);
  const first = violations[0];
  if (first) return { declined: false, refusal: first.refusal, why: first.why };
  return {
    declined: true,
    body: bodyWithDecline(input.issue.body ?? "", input.why),
    section: declineSection(input.why),
    issue: input.issue.number,
  };
}
