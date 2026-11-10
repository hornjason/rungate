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

import { NAMES_NONE, criteriaNamedBy, specCriteriaIn } from "./board-mirror";
import { allocateScNumber, formatSCLine } from "./create-sc";
import { ISSUE_SECTIONS, headingFor, headingOccurrencesOf } from "./issue-shape";
import type { ScRegistry } from "./sc-ids";

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
export function promotionViolations(input: PromotionInput): PromotionViolation[] {
  const out: PromotionViolation[] = [];

  for (const { field, refusal, why } of STATEMENT_FIELDS) {
    if (input[field].trim() === "") out.push({ refusal, why });
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
  const allIds = [...sweep.ids, ...sweep.collisions.map(c => c.id)];
  const hereIds = sweep.specs.find(s => resolve(input.projectRoot, s.path) === path)?.ids ?? [];

  if (hereIds.length === 0) {
    out.push({
      refusal: "SPEC_STATES_NO_CRITERIA",
      why:
        `${input.spec} states no criteria, so it has no section a criterion belongs in — ` +
        "promoting into it would put the first one somewhere nothing reads",
    });
  }

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
  if (violations.length > 0) {
    const first = violations[0]!;
    return { promoted: false, refusal: first.refusal, why: first.why };
  }

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
  };
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
      /** The markdown to put under the issue's Criteria heading, verbatim. */
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
  const allIds = [...sweep.ids, ...sweep.collisions.map(c => c.id)];

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

  if (`${input.issue.title}\n${body}`.includes(NAMES_NONE)) {
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
  if (headings.length > 1) {
    out.push({
      refusal: "AMBIGUOUS_HEADING",
      why:
        `#${input.issue.number} opens "${CRITERIA_HEADING}" ${headings.length} times, so there is ` +
        "no one section to write into and a reader cannot tell which one the board read",
    });
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
 * Decline on an issue's behalf, or refuse and say which refusal it was.
 *
 * Pure: it returns the markdown and writes nothing. The write is the
 * caller's, so a dry run and a real run compute the same answer.
 */
export function decline(input: DeclineInput): Decline {
  const violations = declineViolations(input);
  const first = violations[0];
  if (first) return { declined: false, refusal: first.refusal, why: first.why };
  return { declined: true, section: declineSection(input.why), issue: input.issue.number };
}
