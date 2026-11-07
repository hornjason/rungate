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

import { criteriaNamedBy, specCriteriaIn } from "./board-mirror";
import { allocateScNumber, formatSCLine } from "./create-sc";
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
  "SPEC_STATES_NO_CRITERIA",
  "ALREADY_SERVES",
  "NO_OUTCOME",
  "NO_SYMBOL",
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

  if (input.outcome.trim() === "") {
    out.push({
      refusal: "NO_OUTCOME",
      why: "a criterion with no sentence states nothing, so nothing could ever prove it",
    });
  }

  if (input.symbol.trim() === "") {
    out.push({
      refusal: "NO_SYMBOL",
      why:
        "a criterion that names no symbol cannot be moved by a mutation, so a test claiming " +
        "it would be green by construction",
    });
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

  // The WHOLE tree, not this spec's ids. Scoping the duplicate check to the
  // target let an issue serving a criterion in spec A promote into spec B
  // unopposed — which is the outcome the refusal below says it prevents, so
  // the detector was narrower than the thing it detects.
  const sweep = specCriteriaIn(input.projectRoot);
  const allIds = sweep.ids;
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
  } else if (sweep.reading === "UNMEASURED") {
    // An UNMEASURED sweep read SOME of the tree. "No criterion found" from a
    // partial read and from a complete one are the same value and different
    // facts, and only one of them clears this refusal.
    out.push({
      refusal: "ALREADY_SERVES",
      why:
        "the spec sweep is UNMEASURED, so a criterion this issue already serves may sit in a " +
        `spec that was not read: ${sweep.unmeasuredReasons.join("; ")}`,
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

  const specText = readFileSync(specPath(input), "utf8");
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
