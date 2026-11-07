/**
 * The stage ladder: one place that says what a stage is, and whether it is done.
 *
 * ## Why this exists
 *
 * Stage A of ADR-009 was scored wrong twice by the agent that built it. Once
 * as "5 of 6" against a real 3 of 7, and once — on 2026-11-01, after the
 * stage had actually passed — as a failure. Neither was carelessness in the
 * ordinary sense. The cause was structural and it is worth naming exactly,
 * because the repair follows from it:
 *
 * **A stage's definition of done lived in three documents, and nothing
 * compared them.** ADR-009 had a one-line done-when per stage, ADR-009 had a
 * second table of per-goal done-whens, and `project-state.json` had the
 * per-item ladder. All three were prose. An agent reading any one of them is
 * reading a complete, confident, self-consistent answer, and has no way to
 * discover that the other two exist and disagree.
 *
 * Two further defects rode on top of that one:
 *
 * - **The stage-level done-when could not come back wrong.** Stage A's was
 *   *"the goal and the engine spec exist and say the right things"*. "Say the
 *   right things" is the shape `.claude/rules/checks-must-be-able-to-fail.md`
 *   forbids in a test, written into a stage gate instead.
 * - **A ticked item could contain its own denial.** Stage A's A4 shipped as
 *   `[x]` carrying the clause *"0 of them ticked, and 'done when each has a
 *   failing test' is not met"*. Nothing refused it, and a later reader
 *   (correctly) could not tell whether the item or the clause was the truth.
 *
 * ## What is done about it
 *
 * The ladder becomes DATA, in `project-state.json`, under `stages`. It stays
 * in that file because `AGENTS.md` rule 9 makes it the place an agreement
 * becomes real; it stops being a paragraph because nothing can execute a
 * paragraph.
 *
 * Every item carries `verify`: a shell command. **A stage is complete when
 * every item's command exits 0** — derived, not asserted. That is the whole
 * point. There is no sentence anywhere saying Stage A is done; there are
 * seven commands, and `test/stage-ladder.test.ts` runs them.
 *
 * ## The direction this is allowed to be wrong in
 *
 * Toward refusing. A real item whose verify command is awkward to write costs
 * somebody ten minutes. The other direction is what produced the two
 * mis-scores above: a stage that reports done because a document said so.
 *
 * Every rule below is in ONE function with ONE return path, so a mutation of
 * it is observable. Do not add a second place that decides whether a stage is
 * done — a second decider is behaviourally invisible to any test of the first
 * (`.claude/rules/checks-must-be-able-to-fail.md`, *two deciders that agree*).
 */

/**
 * A command that could not be RUN did not fail.
 *
 * `sh` exits 127 when the program does not exist. A verify command whose
 * tool is missing — a different base image, a minimal container — is not
 * evidence that the item regressed, and reporting it as one is the mirror of
 * the defect SUCCESS.md claim 4 names: *"could not measure" never reads as
 * "nothing wrong"*. It must not read as "something wrong" either. The caller
 * separates this exit code and reports it as UNMEASURED, named.
 */
export const COMMAND_NOT_FOUND = 127;

/**
 * Where a `verify` can be run — see {@link StageItem.scope} for each.
 *
 * Declared as the list rather than only as a union so the validator's
 * refusal message is generated from it. A fourth scope added to the type
 * and forgotten in a hand-written message is a message that names a legal
 * value as illegal.
 */
export const ITEM_SCOPES = ["repo", "machine", "credentialed"] as const;
export type ItemScope = (typeof ITEM_SCOPES)[number];

/** One item on a stage: a thing to do, and the command that proves it done. */
export interface StageItem {
  /** `A1`, `B4` — the stage letter followed by a 1-based position. */
  id: string;
  /** What the item delivers, in the words of whoever agreed it. */
  what: string;
  done: boolean;
  /**
   * A shell command that exits 0 exactly when this item is delivered.
   *
   * Required on a `done` item and refused as empty. An item still open may
   * carry one — writing the check before the work is the TDD shape and is
   * encouraged — or may leave it `null` while the check is not yet knowable.
   */
  verify: string | null;
  /**
   * Where `verify` can be run.
   *
   * `"repo"` — anywhere this repository is checked out, so CI runs it and a
   * drift reddens the build. This is the default and the one to aim for.
   *
   * `"machine"` — the evidence is outside the repository, on the operator's
   * machine. Stage A's A2 is the live instance: the goal is set in
   * `~/.claude/FLEET-STATE.md`, which no CI runner has.
   *
   * `"credentialed"` — the evidence is reachable from anywhere, and reading
   * it needs a credential CI does not hold. Stage B's B4 is the live
   * instance: the board's Criteria column is a ProjectV2 custom field on a
   * USER-level project, and `secrets.GITHUB_TOKEN` is repository-scoped, so
   * the one token CI has structurally cannot see it. Measured 2026-11-02 —
   * B1 (milestones) and B3 (issues) are repository resources and passed in
   * the same shard that B4 failed in.
   *
   * It is deliberately NOT `"machine"`: that word says the evidence is on
   * one operator's disk, and a reader who believes it looks in the wrong
   * place. Giving CI a `read:project` token would move B4 to `"repo"` and
   * is the better end state; this records the state until somebody does.
   *
   * No non-`"repo"` item is silently skipped, because a check that quietly
   * declines to run is indistinguishable from a check that passed
   * (`.claude/rules/checks-must-be-able-to-fail.md`, *assertions that hold
   * vacuously*). Each is counted, named in the output, and its count is
   * itself asserted as an equality — so a second one of either kind cannot
   * appear without somebody deciding to allow it.
   */
  scope?: ItemScope;
}

/**
 * One improvement a retrospective produced.
 *
 * `mechanism` is the point. "We will stop repairing at round three" is a
 * resolution, and a resolution is the thing this repository keeps proving
 * does not survive contact with the next session — Stage A ran to fourteen
 * rounds against a rule that already said three. An improvement has to name
 * what ENFORCES it: a test, a gate, a refusal, a schema field. "Nothing yet,
 * needs a decision" is an acceptable mechanism and an honest one; an empty
 * string is not.
 */
export interface Improvement {
  what: string;
  mechanism: string;
  /**
   * `in-place` — the mechanism exists and `verify` proves it. `open` — it
   * does not, nobody has built it, and that is declared rather than
   * implied. There is no third state: a lesson is either enforced or it is
   * outstanding, and a retro that cannot say which is a retro nobody can
   * act on.
   */
  status: "in-place" | "open";
  /**
   * A command that exits 0 only when the mechanism is really there.
   *
   * Required on `in-place` and refused on `open` — an open improvement with
   * a command would be claiming the thing it says is missing.
   *
   * **Where the command is `bun test <file> -t <name>`, it must also assert
   * a case RAN.** `bun test -t` exits 0 when the pattern matches nothing,
   * so a renamed or deleted case makes the improvement look enforced while
   * nothing checks it — the vacuous shape, measured here on 2026-11-01.
   * Piping to `grep -qE '^ 1 pass'` is the guard the live entries use.
   */
  verify: string | null;
  /**
   * The tracker issue carrying this improvement, where one exists.
   *
   * Optional, because a retro is written before the issues are filed. It
   * earns a field rather than a sentence in `what` for the reason rule 4
   * gives: ordering and ownership are data, and an improvement whose only
   * home is this file is the note rule 10 exists to refuse.
   *
   * Refused unless it is a positive integer — `"1727"` and `0` both read as
   * a link while resolving to nothing.
   */
  issue?: number;
}

/**
 * What a stage taught, recorded before the next stage may start.
 *
 * Structured rather than prose for the same reason the ladder is: a
 * paragraph of lessons is read once and never executed. Three lists, and
 * `nextStage` refuses to advance past a complete stage that has none.
 */
export interface Retro {
  wentWell: string[];
  wentPoorly: string[];
  improvements: Improvement[];
}

/**
 * One of the sequenced goals the stages serve.
 *
 * These are Jason's, agreed on 2026-10-30 and recorded in ADR-009 §3. They
 * are here rather than there because a done-condition nothing executes is
 * the defect this whole module exists to remove.
 */
export interface Goal {
  id: number;
  goal: string;
  doneWhen: string;
}

/** One stage of the build order. */
export interface Stage {
  /** A single uppercase letter. Position in the array IS the order. */
  id: string;
  name: string;
  /**
   * What this stage is FOR, in one sentence.
   *
   * Distinct from `name`, which is a label. "Write it down" is a label;
   * "the goal and the engine spec exist and say what they must, so every
   * stage below has something to build against" is a goal. The distinction
   * is not pedantry — Stage A shipped with only a label, and the question
   * "what was this stage for" had no answer anybody could point at.
   */
  goal: string;
  /** Which `Goal.id` this stage serves. */
  serves: number;
  /**
   * Who agreed this stage's contents, and when — `"2026-10-30 Jason"`.
   *
   * `null` means NOBODY has. ADR-009 drafted Stage B's six items after the
   * conversation that set the ladder, so they are the engine's proposal and
   * not an agreement. An unagreed stage may hold items; it may not hold a
   * done one, and it may not be complete. That is rule 9 made executable
   * rather than restated.
   */
  agreed: string | null;
  items: StageItem[];
  /**
   * What the stage taught. `null` until it is written.
   *
   * A complete stage with `retro: null` BLOCKS the next stage. That is the
   * whole mechanism: the retrospective is a gate rather than a good
   * intention, because a good intention is what Stage A had.
   */
  retro: Retro | null;
}

const ITEM_ID = /^([A-Z])(\d+)$/;

/**
 * Phrases that mean "this is not finished", found in the text of items that
 * were nonetheless ticked.
 *
 * Deliberately a short, literal list rather than anything clever. A clever
 * matcher over English prose is a detector narrower than what it detects
 * wearing a disguise — it will miss a phrasing nobody predicted and read as
 * a clean pass. These five are the ones observed in the live file on
 * 2026-11-01; adding a sixth is a one-line edit when a sixth is observed.
 *
 * `0 of` is here because A4's clause was `0 of them ticked`, and because a
 * count of zero in the text of a completed item is always worth a human
 * reading it, even when the item is genuinely done.
 */
const DENIALS = ["is not met", "are not met", "0 of", "not applied", "does not exist"];

/** Every violation in one stage's `retro`, or none if it is absent. */
function retroViolations(raw: unknown, at: string): string[] {
  if (raw === null || raw === undefined) return [];
  const out: string[] = [];
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return [`${at}.retro is ${Array.isArray(raw) ? "an array" : typeof raw}, expected an object or null`];
  }
  const r = raw as Record<string, unknown>;

  for (const k of ["wentWell", "wentPoorly"]) {
    const v = r[k];
    if (!Array.isArray(v) || v.some(e => typeof e !== "string")) {
      out.push(`${at}.retro.${k} is ${JSON.stringify(v)}, expected an array of strings`);
    }
  }

  if (!Array.isArray(r.improvements)) {
    out.push(`${at}.retro.improvements is ${JSON.stringify(r.improvements)}, expected an array`);
    return out;
  }
  // An empty improvements list is allowed and means "nothing to change",
  // which is a real finding. What is refused is an improvement that names
  // no mechanism — see the Improvement docblock.
  r.improvements.forEach((im, i) => {
    const iAt = `${at}.retro.improvements[${i}]`;
    if (im === null || typeof im !== "object" || Array.isArray(im)) {
      out.push(`${iAt} is not an object`);
      return;
    }
    const e = im as Record<string, unknown>;
    if (typeof e.what !== "string" || e.what.length === 0) {
      out.push(`${iAt}.what is ${JSON.stringify(e.what)}, expected a non-empty string`);
    }
    if (typeof e.mechanism !== "string" || e.mechanism.trim().length === 0) {
      out.push(
        `${iAt}.mechanism is ${JSON.stringify(e.mechanism)} — name what ENFORCES this improvement: a test, ` +
          `a gate, a refusal, a schema field. A resolution with no mechanism is what Stage A already had, ` +
          `and it ran to fourteen review rounds against a rule that said three.`,
      );
    }

    // Before the status branch, which returns early: a bad link on an entry
    // that also has a bad status would otherwise go unreported.
    if (e.issue !== undefined && (typeof e.issue !== "number" || !Number.isInteger(e.issue) || e.issue <= 0)) {
      out.push(`${iAt}.issue is ${JSON.stringify(e.issue)}, expected a positive integer issue number`);
    }

    if (e.status !== "in-place" && e.status !== "open") {
      out.push(`${iAt}.status is ${JSON.stringify(e.status)}, expected "in-place" or "open"`);
      return;
    }
    // The pairing is the point. `in-place` with no command is a claim
    // nobody can check — which is the exact defect the retro is recording.
    // `open` with a command claims the thing it says is missing.
    if (e.status === "in-place" && (typeof e.verify !== "string" || e.verify.trim().length === 0)) {
      out.push(
        `${iAt} says the mechanism is in place and gives no command to prove it. A named mechanism is ` +
          `still prose — "${String(e.mechanism).slice(0, 60)}" is a description, not evidence. Write the ` +
          `command that exits 0 only while it is really there, or set status to "open".`,
      );
    }
    if (e.status === "open" && e.verify !== null && e.verify !== undefined) {
      out.push(`${iAt} is open but carries a verify command — an outstanding improvement cannot prove itself`);
    }
  });
  return out;
}

/**
 * Improvements a retro claims are in place, so a caller can RUN their
 * commands. Flat across every stage, newest stages last.
 *
 * Separate from the validator because this module takes no I/O: the
 * validator says the retro is well-formed, and the caller proves the
 * learning actually landed. Both are needed — Stage A's retro named six
 * mechanisms correctly and could have named six that did not exist.
 */
export function claimedImprovements(
  stages: readonly Stage[],
): { stage: string; what: string; verify: string }[] {
  const out: { stage: string; what: string; verify: string }[] = [];
  for (const s of stages) {
    for (const im of s.retro?.improvements ?? []) {
      if (im.status === "in-place" && typeof im.verify === "string") {
        out.push({ stage: s.id, what: im.what, verify: im.verify });
      }
    }
  }
  return out;
}

/**
 * Improvements a retro declares outstanding — reported, never hidden.
 *
 * **The WHOLE improvement, not a two-field summary** (#1745). It used to
 * return `{stage, what}`, and the only caller printed it to a `console.log`
 * nobody reads — so three improvements that nothing could measure were
 * invisible to the document every session is told to read first, while
 * `test/stage-ladder.test.ts` scored stage ITEMS and reported the ladder
 * healthy. That is the fail-open SUCCESS.md claim 4 names: *could not
 * measure* reading as *nothing wrong*.
 *
 * `mechanism` and `issue` ride along because a reader needs both: the first
 * says whether anybody has decided HOW, the second whether it is on the
 * tracker at all. One function answers *what is outstanding* — a renderer
 * that re-filtered `status === "open"` itself would be a second decider over
 * one input, and a mutation of either would leave the other holding the case
 * up.
 */
export function openImprovements(stages: readonly Stage[]): ({ stage: string } & Improvement)[] {
  return stages.flatMap(s =>
    (s.retro?.improvements ?? [])
      .filter(im => im.status === "open")
      // `stage` LAST. Spelled `{ stage: s.id, ...im }` for one commit, which
      // lets an improvement carrying its own `stage` key overwrite the one
      // computed from the stage it is actually in — and the key
      // `OPEN_WITHOUT_ISSUE` matches on in `test/stage-ladder.test.ts` is
      // `${stage}: ${what}`, so data in `project-state.json` could forge a
      // ratchet key and tick a line reserved for a different improvement.
      // Found by the security review of #1812. The computed field is the
      // identity here, so it goes last and the data cannot reach it.
      .map(im => ({ ...im, stage: s.id })),
  );
}

/**
 * Every violation in a stage ladder, in document order.
 *
 * Empty means the ladder is internally consistent. It does NOT mean the
 * stages are done — that is what running the `verify` commands answers, and
 * running them is the caller's job because this module stays free of I/O so
 * it can be unit-tested without a repository around it.
 */
export function stageLadderViolations(raw: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(raw)) {
    return [`stages is ${raw === null ? "null" : typeof raw}, not an array`];
  }

  const seen = new Set<string>();
  raw.forEach((s, i) => {
    const at = `stages[${i}]`;
    if (s === null || typeof s !== "object" || Array.isArray(s)) {
      out.push(`${at} is not an object`);
      return;
    }
    const stage = s as Record<string, unknown>;

    if (typeof stage.id !== "string" || !/^[A-Z]$/.test(stage.id)) {
      out.push(`${at}.id is ${JSON.stringify(stage.id)}, expected a single uppercase letter`);
      return;
    }
    const id = stage.id;
    if (seen.has(id)) out.push(`${at}.id is "${id}", which stages[${raw.findIndex(o => (o as Stage)?.id === id)}] already uses`);
    seen.add(id);

    // Contiguity catches the defect that cost the first mis-score: ADR-009
    // inserted a new Stage B and shifted every later letter, and the ladder
    // and the ADR drifted apart with nothing able to see it. A gap or a
    // reorder here is now a red test rather than a sentence warning readers
    // to be careful.
    const expected = String.fromCharCode(65 + i);
    if (id !== expected) out.push(`${at}.id is "${id}" but it sits at position ${i}, where the ladder's order makes it "${expected}" — a stage was inserted, removed or reordered without the letters following`);

    if (typeof stage.name !== "string" || stage.name.length === 0) {
      out.push(`${at}.name is ${JSON.stringify(stage.name)}, expected a non-empty string`);
    }
    if (typeof stage.goal !== "string" || stage.goal.length === 0) {
      out.push(
        `${at}.goal is ${JSON.stringify(stage.goal)}, expected a sentence saying what this stage is FOR. ` +
          `"${typeof stage.name === "string" ? stage.name : "?"}" is a label, not a goal — Stage A shipped with ` +
          `only a label and the question "what was this stage for" had no answer anybody could point at.`,
      );
    }
    if (typeof stage.serves !== "number") {
      out.push(`${at}.serves is ${JSON.stringify(stage.serves)}, expected the id of the goal this stage serves`);
    }
    out.push(...retroViolations(stage.retro, at));
    const agreed = stage.agreed;
    if (agreed !== null && typeof agreed !== "string") {
      out.push(`${at}.agreed is ${JSON.stringify(agreed)}, expected a string like "2026-10-30 Jason" or null for not-yet-agreed`);
    }

    if (!Array.isArray(stage.items)) {
      out.push(`${at}.items is ${JSON.stringify(stage.items)}, expected an array`);
      return;
    }

    stage.items.forEach((it, j) => {
      const iAt = `${at}.items[${j}]`;
      if (it === null || typeof it !== "object" || Array.isArray(it)) {
        out.push(`${iAt} is not an object`);
        return;
      }
      const item = it as Record<string, unknown>;

      const m = typeof item.id === "string" ? ITEM_ID.exec(item.id) : null;
      if (m === null) {
        out.push(`${iAt}.id is ${JSON.stringify(item.id)}, expected a stage letter and a number like "${id}${j + 1}"`);
      } else {
        if (m[1] !== id) out.push(`${iAt}.id is "${item.id}" but it sits in stage ${id} — an item's letter must be its stage's`);
        if (Number(m[2]) !== j + 1) out.push(`${iAt}.id is "${item.id}" but it sits at position ${j + 1} — item numbers are their position, so a count can be checked rather than asserted`);
      }

      if (typeof item.what !== "string" || item.what.length === 0) {
        out.push(`${iAt}.what is ${JSON.stringify(item.what)}, expected a non-empty string`);
      }
      if (typeof item.done !== "boolean") {
        out.push(`${iAt}.done is ${JSON.stringify(item.done)}, expected a boolean`);
      }
      if (item.verify !== null && typeof item.verify !== "string") {
        out.push(`${iAt}.verify is ${JSON.stringify(item.verify)}, expected a shell command or null`);
      }
      // Widened to `readonly string[]` on purpose: this validator reads
      // parsed JSON, so the value is whatever was in the file, and a
      // narrowly typed `includes` refuses to be asked about it.
      if (item.scope !== undefined && !(ITEM_SCOPES as readonly string[]).includes(item.scope as string)) {
        out.push(
          `${iAt}.scope is ${JSON.stringify(item.scope)}, expected ` +
            `${ITEM_SCOPES.map(s => `"${s}"`).join(", ")} or absent (absent means "repo")`,
        );
      }

      if (item.done === true) {
        if (typeof item.verify !== "string" || item.verify.trim().length === 0) {
          out.push(
            `${iAt} ("${item.id}") is done with no verify command. A done item states a fact about ` +
              `the repository; without a command the fact is an assertion that goes stale silently — ` +
              `which is how Stage A was scored 5 of 6 against a real 3 of 7. Write the command that ` +
              `exits 0 only when this item is delivered.`,
          );
        }
        if (typeof item.what === "string") {
          // Bound to a local because narrowing does not reach inside the
          // closure — `item.what` is still `unknown` there.
          const what = item.what.toLowerCase();
          const hit = DENIALS.find(d => what.includes(d));
          if (hit !== undefined) {
            out.push(
              `${iAt} ("${item.id}") is done and its own text says "${hit}". One of the two is wrong. ` +
                `Stage A's A4 shipped in exactly this state and no reader could tell whether the tick ` +
                `or the clause was the truth. Decide, then either untick it or move the caveat to a note.`,
            );
          }
        }
        if (agreed === null) {
          out.push(
            `${iAt} ("${item.id}") is done, but stage ${id} has agreed: null — nobody has signed off ` +
              `what this stage contains. AGENTS.md rule 9: an agreement is not real until it is written ` +
              `here. Get the wording agreed and set "agreed" before ticking anything in this stage.`,
          );
        }
      }
    });
  });

  return out;
}

/** Is every item in this stage done? The only definition of a complete stage. */
export function stageIsComplete(stage: Stage): boolean {
  return stage.items.length > 0 && stage.items.every(i => i.done);
}

/**
 * The next stage to work, and why it is or is not available.
 *
 * "What's next" is derived rather than written down, for the same reason the
 * completion is: a sentence naming the current stage is a thing that goes
 * stale the moment a stage closes, and the two mis-scores above were both
 * somebody trusting a stale sentence.
 */
export function retrosOwed(stages: readonly Stage[]): string[] {
  return stages.filter(s => stageIsComplete(s) && (s.retro === null || s.retro === undefined)).map(s => s.id);
}

/** The message for a set of stages owing a retro. One wording, one site. */
function retroDebt(owed: readonly string[], next: string): string {
  return (
    `stage ${owed.join(", ")} is complete and has no retro. Write what went well, what went poorly, and ` +
    `the improvements WITH the mechanism that enforces each, then ${next}. A stage that teaches nothing ` +
    `forward is a stage whose mistakes are scheduled to repeat.`
  );
}

export function nextStage(
  stages: readonly Stage[],
): { stage: Stage | null; blocked: string | null } | null {
  // Walked in order so the FIRST unmet precondition is the one reported. A
  // caller shown two blockers at once fixes the convenient one.
  const owed: string[] = [];
  for (const stage of stages) {
    if (stageIsComplete(stage)) {
      // The retro gate. A finished stage with nothing written down is how
      // every lesson from Stage A would have been lost: the work lands, the
      // context is compacted, and the next stage repeats it.
      if (stage.retro === null || stage.retro === undefined) owed.push(stage.id);
      continue;
    }
    const blocked =
      owed.length > 0
        ? retroDebt(owed, `stage ${stage.id} is available`)
        : stage.agreed === null
          ? `stage ${stage.id} has agreed: null — its ${stage.items.length} item(s) are a proposal, not an ` +
            `agreement. Nothing in it may be started or ticked until the wording is agreed and written here ` +
            `(AGENTS.md rule 9).`
          : null;
    return { stage, blocked };
  }

  // Every stage is complete — but that is not the same as finished.
  //
  // This branch used to `return null`, which a caller reads as "nothing
  // left to do". A ladder whose LAST stage completes with retro: null then
  // reported done while the one retro nobody can be reminded of later —
  // the final one — was silently skipped. Found by review on #1696, and it
  // is the retro gate failing exactly where there is no next stage to carry
  // the message. `stage: null` says the work is done; a non-null `blocked`
  // says the plan is not.
  const debt = retrosOwed(stages);
  if (debt.length > 0) return { stage: null, blocked: retroDebt(debt, "the plan is finished") };
  return null;
}

/**
 * Every violation in the whole ladder document — the goal, the goals, and
 * the stages together.
 *
 * Separate from `stageLadderViolations` only because the stages can be
 * checked without the goals and the cross-reference cannot. This is the
 * function a caller should use; it is the single decider for "is the plan
 * well-formed".
 */
export function ladderViolations(raw: unknown): string[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return [`the document is ${Array.isArray(raw) ? "an array" : typeof raw}, not an object`];
  }
  const doc = raw as Record<string, unknown>;
  const out: string[] = [];

  // The overall goal. One place, and it carries its own check — a goal with
  // no way to tell whether it is met is the shape Stage A's done-when had.
  const goal = doc.goal;
  if (goal === null || typeof goal !== "object" || Array.isArray(goal)) {
    out.push(`goal is ${JSON.stringify(goal)}, expected an object with "statement" and "verify"`);
  } else {
    const g = goal as Record<string, unknown>;
    if (typeof g.statement !== "string" || g.statement.length === 0) {
      out.push(`goal.statement is ${JSON.stringify(g.statement)}, expected the one sentence everything serves`);
    }
    if (typeof g.verify !== "string" || g.verify.trim().length === 0) {
      out.push(
        `goal.verify is ${JSON.stringify(g.verify)} — the overall goal needs a command that says whether it ` +
          `is met, for the same reason every item does.`,
      );
    }
  }

  const ids = new Set<number>();
  if (!Array.isArray(doc.goals)) {
    out.push(`goals is ${JSON.stringify(doc.goals)}, expected an array`);
  } else {
    doc.goals.forEach((g, i) => {
      const at = `goals[${i}]`;
      if (g === null || typeof g !== "object" || Array.isArray(g)) {
        out.push(`${at} is not an object`);
        return;
      }
      const e = g as Record<string, unknown>;
      if (typeof e.id !== "number") out.push(`${at}.id is ${JSON.stringify(e.id)}, expected a number`);
      else ids.add(e.id);
      for (const k of ["goal", "doneWhen"]) {
        if (typeof e[k] !== "string" || (e[k] as string).length === 0) {
          out.push(`${at}.${k} is ${JSON.stringify(e[k])}, expected a non-empty string`);
        }
      }
    });
  }

  out.push(...stageLadderViolations(doc.stages));

  // Every stage serves a goal that exists. A dangling `serves` is how a
  // stage ends up orphaned from the thing it is supposed to advance.
  if (Array.isArray(doc.stages) && ids.size > 0) {
    doc.stages.forEach((s, i) => {
      const e = s as Record<string, unknown> | null;
      if (e === null || typeof e !== "object") return;
      if (typeof e.serves === "number" && !ids.has(e.serves)) {
        out.push(
          `stages[${i}].serves is ${e.serves}, which is not the id of any goal. ` +
            `Known goal ids: ${[...ids].join(", ")}.`,
        );
      }
    });
  }

  return out;
}

/* ────────────────────────────────────────────────────────────────────────
 * #1849 — a verify command may not name a test that does not exist.
 *
 * `verify` is free text. Nothing related it to the set of test titles that
 * exist, so a command could name a case nobody wrote and its item could be
 * ticked against it. Three of Stage G's five verify commands did exactly
 * that; two of Stage C's six did, and one of those named a FILE whose 47
 * tests contain nothing matching — which is the half the runtime guard
 * cannot see, because `grep -qE '^ [1-9][0-9]* pass'` only catches a title
 * that matches nothing IN THE FILE NAMED.
 *
 * Static, by AC-1: this reads the file, it does not run it. A check that
 * had to run the suite to know whether the suite would be selected is the
 * thing it is checking.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * What a single `bun test <file> -t <name>` fragment turned out to be.
 *
 * `UNMEASURED` is a first-class reading and not a quiet pass, for the
 * reason `.claude/rules/config-access.md` gives: a fragment this cannot
 * read has not been checked, and "not checked" and "fine" are different
 * facts. Every one is reported.
 */
export const VERIFY_TITLE_READINGS = ["MATCHED", "NO_SUCH_TITLE", "FILE_ABSENT", "UNMEASURED"] as const;
export type VerifyTitleReading = (typeof VERIFY_TITLE_READINGS)[number];

export interface VerifyTitleFragment {
  /** The item, improvement or goal the command belongs to. */
  where: string;
  /** The path as the command spells it, relative to the project root. */
  file: string;
  /** The `-t` pattern, verbatim. */
  name: string;
  reading: VerifyTitleReading;
  /** What the reader saw. Empty only on `MATCHED`. */
  why: string;
}

/**
 * `bun test <file> -t "<name>"`, wherever it appears in a command.
 *
 * Global and non-anchored because a verify may chain several with `&&` —
 * C6 chains three — and a chain whose FIRST command is checked and whose
 * second is not is the population defect this repository keeps paying for
 * (#1818).
 */
const BUN_TEST_T = /bun test\s+(\S+)\s+-t\s+(["'])(.*?)\2/g;

/**
 * `describe(` / `test(` / `it(`, with a quoted title and any modifier.
 *
 * The lookbehind is load-bearing. `\b` alone matches between the `.` and
 * the `t` of `RegExp.prototype.test`, so `/^ 1 pass$/m.test(\`${out}\`)` —
 * an ordinary line in this file's own suite — read as a declaration with
 * an interpolated title, and marked the whole file UNMEASURED. Found by
 * AC-4's mutation failing to redden anything: the victim it picked was a
 * fragment this parser had quietly given up on.
 */
const TITLE_CALL = /(?<![.\w$])(describe|test|it)(?:\.\w+)?\(\s*(["'`])((?:\\.|(?!\2).)*)\2/g;

/**
 * Every name `bun test -t` could match in one source file.
 *
 * **Measured, not assumed** (2026-11-07, bun 1.3.14). Against
 * `describe("outer group") > test("inner case")`:
 *
 * | `-t` pattern                 | result |
 * |------------------------------|--------|
 * | `inner case`                 | runs   |
 * | `outer group`                | runs   |
 * | `outer group inner case`     | runs   |
 * | `outer group > inner case`   | NO     |
 * | `group.*inner`               | runs   |
 *
 * So the thing matched is a regular expression against the **space-joined**
 * path of enclosing describes plus the title — not the reporter's `>`
 * spelling, and not a substring test. Getting this from the documentation
 * rather than from the binary would have produced a check that refuses
 * every path pattern in the tree.
 *
 * Returns `null` when the source cannot be parsed into a path set with
 * confidence. A file whose nesting this cannot follow is UNMEASURED, never
 * a refusal: the cost of reading it wrong is a red row for a command that
 * is correct, which is how a check becomes an obstacle people route around.
 * `scanSource` says when that is — see its three guards.
 */
/**
 * Why a file's names could not be read — the two causes are different
 * facts and the message must not conflate them.
 *
 * It did. Everything unreadable was reported as "builds at least one
 * title by interpolation", and the first file that proved it wrong was
 * `test/board-ready-rule.test.ts`, whose real cause was a regex the
 * scanner could not see. A reader chasing that message would have gone
 * looking for a template literal that is not there.
 */
export type TitleReading =
  | { paths: string[]; why: null }
  | { paths: null; why: "INTERPOLATED" | "UNPARSEABLE" };

export function titleReading(raw: string): TitleReading {
  const scan = scanSource(raw);
  if (!scan.ok) return { paths: null, why: "UNPARSEABLE" };
  const paths = pathsFrom(scan);
  return paths === null ? { paths: null, why: "INTERPOLATED" } : { paths, why: null };
}

export function titlePathsIn(raw: string): string[] | null {
  // Comments are masked before the title scan. A `describe("outer group",
  // …)` written INSIDE a comment is not a declaration, and reading it as
  // one adds a name no test has — the docblock in
  // `test/stage-ladder.test.ts` explaining that hazard became a title path
  // of that file. Masked rather than removed, so offsets still line up.
  const scan = scanSource(raw);
  if (!scan.ok) return null;
  return pathsFrom(scan);
}

/** The path set of an already-scanned source, or `null` if interpolated. */
function pathsFrom(scan: Scan): string[] | null {
  const source = scan.forTitles;

  const stack: { title: string; depth: number }[] = [];
  const paths: string[] = [];
  let depth = 0;
  let interpolated = false;

  // One pass, walking the braces between title calls. `lastIndex` on a
  // global regex is the cursor; the text between two calls is where the
  // depth moves. The depth is read off `forDepth`, where strings are
  // masked too — a `{` inside a title would otherwise open a block.
  TITLE_CALL.lastIndex = 0;
  let cursor = 0;
  for (const m of source.matchAll(TITLE_CALL)) {
    const at = m.index!;
    depth += braceDelta(scan.forDepth.slice(cursor, at));
    cursor = at;
    // Pop on STRICTLY greater. A describe records the depth INSIDE its own
    // body, which is the depth every call it encloses is read at, so `>=`
    // pops the enclosing describe at its own first child and every path
    // comes out as the bare test title. The first draft had `>=` and the
    // probe caught it: `test/stage-ladder.test.ts` read 41 paths of which
    // not one carried its describe.
    while (stack.length > 0 && stack[stack.length - 1]!.depth > depth) stack.pop();

    const [, kind, quote, raw] = m as unknown as [string, string, string, string];
    if (quote === "`" && raw.includes("${")) {
      // An interpolated title is a name this cannot know. One is enough to
      // make the whole file's path set incomplete, and an incomplete set
      // can only produce false refusals.
      interpolated = true;
      continue;
    }
    const title = raw.replace(/\\(.)/g, "$1");
    const path = [...stack.map(s => s.title), title].join(" ");
    paths.push(path);
    if (kind === "describe") stack.push({ title, depth: depth + 1 });
  }

  if (interpolated) return null;
  return paths;
}

/**
 * One tokenizer pass, two masked copies of the source and a verdict.
 *
 * ## Why one pass and not two scanners
 *
 * The first version had a `blankComments` and a `braceDelta` that each
 * walked the text with their own idea of what a token is, and both were
 * missing the same thing. Review of #1877 traced it, in full: neither
 * recognised a **regex literal**, so the `"` inside a character class like
 * `/["x]/` — an idiom that already appears in this repository, at
 * `test/branch-cleanup-slug.test.ts` — opened a string that never closed.
 * The scan then ran off the end of the slice without ever seeing the `}`
 * that closed the enclosing block, the depth came back 1 instead of 0, and
 * a sibling `test` was recorded as nested inside a `describe` whose body
 * had already ended.
 *
 * That is the dangerous direction: not a refusal, not a `null`, but a
 * **confident wrong answer** — a path this invented, which a verify
 * command naming no real test could then match. It is also what the old
 * `braceDelta` docstring claimed it handled. Two deciders, the same blind
 * spot, and a comment asserting the property neither had.
 *
 * ## The three guards
 *
 * 1. Regex literals are recognised and masked, so ordinary files stay
 *    readable rather than being written off as UNMEASURED.
 * 2. Anything unterminated — string, template, comment, regex — sets
 *    `ok: false`. The old `endOfString` returned `text.length`, which
 *    spells "the rest of the file is inside this string" and is how a
 *    misparse became silent.
 * 3. Braces must never go negative and must return to zero at the end.
 *    This is the GLOBAL check, and it is the one that does not depend on
 *    having thought of every token: a scan knocked off the rails by
 *    something nobody anticipated comes out unbalanced.
 *
 * Any of the three failing makes `titlePathsIn` return `null`, which is
 * UNMEASURED and reported — never a refusal.
 *
 * `forTitles` keeps string literals (the titles live in them) and blanks
 * comments and regexes. `forDepth` blanks all three. Both are the same
 * length as the input, so one set of offsets indexes both.
 */
interface Scan {
  forTitles: string;
  forDepth: string;
  ok: boolean;
  /**
   * How far the scan actually got. Everything from here on is RAW — not
   * masked, comments included.
   *
   * Round 2 of review found `titlesIn` reading `forTitles` whole while
   * ignoring `ok`, so a `describe("phantom")` sitting in a comment in the
   * unscanned tail of an unparseable file was returned as a declared
   * title, and the literal fast path reported MATCHED for a test that
   * exists nowhere. The mitigation for a confidently-wrong answer was
   * itself confidently wrong. A reader of a failed scan may only trust
   * the prefix the scan completed.
   */
  scannedUpTo: number;
}

/**
 * Characters after which a `/` opens a regex rather than dividing.
 *
 * `!` is in the set and needs the lookback below: in TypeScript a `!`
 * after an expression is the non-null assertion, so `a.b! / c` is
 * DIVISION, while `!/re/.test(x)` is negation followed by a regex. Both
 * spellings are live in this tree; `test/crc-reading.test.ts` has the
 * first.
 */
const REGEX_MAY_FOLLOW = new Set([..."(,=:[!&|?{};+-*%~^<>", "\n"]);

/**
 * Keywords after which a `/` opens a regex.
 *
 * Without these, `return /labels\s*:/.test(src)` reads the `/` as
 * division, scans on INTO the pattern, and the `"` in the next regex on
 * the same line opens a string that never closes. That is
 * `test/board-ready-rule.test.ts:478`, which five live verify fragments
 * point at — so the whole file went UNMEASURED and five items lost their
 * check. A character class is not the only way in.
 */
const REGEX_AFTER_WORD = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete",
  "void", "do", "else", "case", "yield", "await", "throw",
]);

function scanSource(text: string): Scan {
  const titles = text.split("");
  const depth = text.split("");
  const blank = (buf: string[], from: number, to: number) => {
    for (let k = from; k < to && k < buf.length; k++) if (buf[k] !== "\n") buf[k] = " ";
  };

  let i = 0;
  // The last two significant tokens — a whole word, or one character. Two,
  // because the `!` call needs to know what came before the `!`.
  let prev = "\n";
  let prev2 = "\n";
  let ok = true;
  let braces = 0;

  /**
   * Is the `/` at `at` opening a regex, or dividing?
   *
   * Round 3 of review found both remaining members of this set, and both
   * were real:
   *
   * - `return !/\bcwd\s*:/.test(line)` — the old lookback asked whether
   *   the token before `!` "ends an expression" by its LAST CHARACTER, so
   *   `return` ended in `n` and counted as one. The regex was read as
   *   division, the scan ran on into the pattern, and the pattern's real
   *   closing `/` was then taken as a new regex that never closed. One
   *   ordinary file became unreadable
   *   (`test/unit/git-identity-isolation.test.ts:91`).
   * - `i++ / n` — `prev` was a bare `+` either way, so postfix increment
   *   was indistinguishable from binary plus. MEASURED on a planted
   *   file: a `test("swallowed")` sitting after it was silently dropped
   *   from the name set with a CLEAN reading, while the same file with
   *   `i + 1` kept all three titles. A real test vanishing with no
   *   UNMEASURED signal is a false refusal waiting to happen.
   *
   * The lookback is gone. `++`/`--` are now one token, so postfix is
   * visible, and the genuinely ambiguous `!` is decided by TRYING the
   * regex read: a pattern that closes on the same line is a regex, and
   * one that does not is division. That is the same question the scanner
   * would have to answer anyway, asked once instead of guessed at.
   *
   * Known remaining ambiguity, stated rather than papered over: `a.b! / c
   * / d`, two divisions on one line after a non-null assertion, reads as
   * a regex. No instance exists in this tree; a fourth round on this
   * function is writing a JavaScript tokenizer, which is a different
   * problem and would be a different issue.
   */
  const opensARegex = (at: number) => {
    if (REGEX_AFTER_WORD.has(prev)) return true;
    if (prev === "++" || prev === "--") return false;
    if (prev === "!") return endOfRegex(text, at) !== -1;
    return prev.length === 1 && REGEX_MAY_FOLLOW.has(prev);
  };
  const remember = (tok: string) => {
    prev2 = prev;
    prev = tok;
  };

  while (i < text.length) {
    const c = text[i]!;

    // An identifier or keyword is one token, not its last letter.
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < text.length && /[\w$]/.test(text[j]!)) j++;
      remember(text.slice(i, j));
      i = j;
      continue;
    }

    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      blank(titles, i, stop);
      blank(depth, i, stop);
      i = stop;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) { ok = false; break; }
      blank(titles, i, end + 2);
      blank(depth, i, end + 2);
      i = end + 2;
      continue;
    }
    // `++` and `--` are ONE token. Character-by-character, postfix
    // increment and binary plus both leave `prev` as a bare `+`.
    if ((c === "+" || c === "-") && text[i + 1] === c) {
      remember(c + c);
      i += 2;
      continue;
    }

    if (c === "/" && opensARegex(i)) {
      const end = endOfRegex(text, i);
      if (end === -1) { ok = false; break; }
      blank(titles, i, end);
      blank(depth, i, end);
      i = end;
      remember("/re/");
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const end = endOfString(text, i);
      if (end === -1) { ok = false; break; }
      // Kept in `forTitles` — this is where a title lives.
      blank(depth, i, end);
      i = end;
      remember(c);
      continue;
    }
    if (c === "{") braces++;
    else if (c === "}") {
      braces--;
      if (braces < 0) { ok = false; break; }
    }
    if (!/\s/.test(c)) remember(c);
    i++;
  }

  return {
    forTitles: titles.join(""),
    forDepth: depth.join(""),
    ok: ok && braces === 0,
    // Where the loop stopped. On a clean run that is the end; on a bail
    // it is the token that defeated it, and nothing past it was masked.
    scannedUpTo: i,
  };
}

/** Index just past a regex literal's closing `/` and flags, or -1. */
function endOfRegex(text: string, from: number): number {
  let i = from + 1;
  let inClass = false;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\\") { i += 2; continue; }
    if (c === "\n") return -1; // a regex literal cannot span a line
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      i++;
      while (i < text.length && /[a-z]/.test(text[i]!)) i++;
      return i;
    }
    i++;
  }
  return -1;
}

/**
 * Index just past a string's closing quote, or -1 when it never closes.
 *
 * A template is NOT "scan to the next backtick". `${x.map(p => \`-${p}\`)}`
 * — a template nested inside its own substitution — is ordinary in this
 * tree, and the naive scan ends the outer template at the INNER opening
 * backtick. Everything after that is read in the wrong state, which on
 * `test/issue-file-overlap.test.ts` ate a `{` and the file came out with
 * a negative brace depth 280 lines later. So a substitution is walked as
 * a brace group, with its own strings and templates inside it.
 */
function endOfString(text: string, from: number): number {
  const quote = text[from]!;
  if (quote === "`") return endOfTemplate(text, from);
  let i = from + 1;
  while (i < text.length) {
    if (text[i] === "\\") { i += 2; continue; }
    if (text[i] === quote) return i + 1;
    if (text[i] === "\n") return -1; // a quoted string does not span lines
    i++;
  }
  return -1;
}

/**
 * A template, walked to its closing backtick.
 *
 * A substitution holding its OWN template — `${xs.map(p => \`-${p}\`)}` —
 * ends this scan at the inner opening backtick. That is a real misparse
 * and it is deliberately NOT fixed here.
 *
 * It was attempted: a recursive substitution walker took the unparseable
 * corpus from four files to eleven, because the substitution needs its
 * own regex handling, which needs its own character-class handling, and
 * each repair had the next instance of the same class inside it. Three
 * rounds, which is where AGENTS.md rule 5 says stop repairing and
 * re-scope.
 *
 * The re-scope is `titlesIn` plus the fallback in `verifyTitleFragments`:
 * a file this cannot nest correctly still yields its title LITERALS, and
 * a pattern matching one of those is MATCHED without any nesting being
 * believed. The parser is allowed to be imperfect; what it is not allowed
 * to be is confidently wrong, and `scan.ok` is what separates those.
 */
function endOfTemplate(text: string, from: number): number {
  let i = from + 1;
  while (i < text.length) {
    if (text[i] === "\\") { i += 2; continue; }
    if (text[i] === "`") return i + 1;
    if (text[i] === "$" && text[i + 1] === "{") {
      const end = endOfSubstitution(text, i + 1);
      if (end === -1) return -1;
      i = end;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * Index just past the `}` closing a `${…}`, or -1.
 *
 * The first attempt at this was deleted for taking the unparseable
 * corpus from 4 files to 11, and the reason was precise: it knew about
 * strings and comments and **not** about regex literals, so it repeated
 * the exact defect the outer scanner had just been fixed for. One level
 * down, same blind spot. It is here now, with the regex branch.
 */
function endOfSubstitution(text: string, from: number): number {
  let i = from + 1;
  let open = 1;
  let prev = "{";
  while (i < text.length) {
    const c = text[i]!;
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < text.length && /[\w$]/.test(text[j]!)) j++;
      prev = text.slice(i, j);
      i = j;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const e = text.indexOf("\n", i);
      i = e === -1 ? text.length : e;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      if (e === -1) return -1;
      i = e + 2;
      continue;
    }
    if (c === "/" && (REGEX_AFTER_WORD.has(prev) || (prev.length === 1 && REGEX_MAY_FOLLOW.has(prev)))) {
      const e = endOfRegex(text, i);
      if (e === -1) return -1;
      i = e;
      prev = "/re/";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const e = endOfString(text, i);
      if (e === -1) return -1;
      i = e;
      prev = c;
      continue;
    }
    if (c === "{") open++;
    else if (c === "}") {
      open--;
      if (open === 0) return i + 1;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return -1;
}

/**
 * A `describe` / `test` / `it` whose call does NOT open with a quote.
 *
 * Review round 2 named `test.each(CASES)("%s", fn)` — 46 files here use
 * it — and the general shape is wider than that one spelling: anything
 * whose first argument is not a string literal declares names this
 * cannot resolve.
 *
 * | spelling | first argument |
 * |---|---|
 * | `test.each(CASES)("%s", fn)` | `CASES`, and the title is printf bun fills in |
 * | `test.skipIf(cond)("title")` | `cond` |
 * | `test(NAME, fn)` | a variable |
 *
 * Enumerated as a SHAPE rather than repaired per spelling, because the
 * finding named one member of exactly this population (#1818). A file
 * holding one of these has names this cannot see, so a pattern matching
 * nothing in it is UNMEASURED — never the false refusal review predicted.
 */
const UNRESOLVED_CALL = /(?<![.\w$])(?:describe|test|it)(?:\.\w+)*\s*\(\s*(.)/g;

function hasUnresolvedDeclaration(masked: string): boolean {
  UNRESOLVED_CALL.lastIndex = 0;
  for (const m of masked.matchAll(UNRESOLVED_CALL)) {
    const first = m[1]!;
    if (first !== '"' && first !== "'" && first !== "`") return true;
  }
  return false;
}

/**
 * Every title LITERAL in a file, with no nesting believed.
 *
 * Comments are masked, so a `describe("…")` in prose is still excluded,
 * but nothing here depends on brace depth — which is the half that can
 * be confidently wrong. This is what a file the scanner cannot nest
 * falls back to.
 *
 * **Only the prefix the scan completed is read.** Past that point
 * nothing was masked, so a `describe("phantom")` inside a COMMENT in the
 * tail of an unparseable file would be returned as a declared name, and
 * the literal fast path in `verifyTitleFragments` would report MATCHED
 * for a test that exists nowhere. Round 2 of review on #1877.
 */
export function titlesIn(raw: string): string[] {
  const scan = scanSource(raw);
  const source = scan.forTitles.slice(0, scan.scannedUpTo);
  const out: string[] = [];
  TITLE_CALL.lastIndex = 0;
  for (const m of source.matchAll(TITLE_CALL)) {
    const [, , quote, text] = m as unknown as [string, string, string, string];
    if (quote === "`" && text.includes("${")) continue;
    out.push(text.replace(/\\(.)/g, "$1"));
  }
  return out;
}

/**
 * Can this file's set of names be known in full?
 *
 * The single predicate behind every UNMEASURED, so there is one place
 * that decides and one place to mutate. `false` means a pattern matching
 * nothing here is UNMEASURED rather than a refusal.
 */
export function namesAreComplete(raw: string): { complete: boolean; why: string | null } {
  const scan = scanSource(raw);
  if (!scan.ok) {
    return { complete: false, why: "the scanner could not read the whole file — an unterminated string, comment or regex, or braces that do not balance" };
  }
  if (hasUnresolvedDeclaration(scan.forTitles)) {
    return { complete: false, why: "it declares at least one test whose title is not a string literal (`.each`, `.skipIf(…)(…)`, or a variable)" };
  }
  if (pathsFrom(scan) === null) {
    return { complete: false, why: "it builds at least one title by interpolation" };
  }
  return { complete: true, why: null };
}

/** Net `{` minus `}` over an already-masked slice. */
function braceDelta(masked: string): number {
  let d = 0;
  for (const c of masked) {
    if (c === "{") d++;
    else if (c === "}") d--;
  }
  return d;
}

/**
 * Every `bun test … -t …` in one command, read against the tree.
 *
 * `readSource` returns the file's text, or `null` when there is no such
 * file. Injected rather than read here so the caller owns the root and so
 * a test can plant a corpus without a temp directory — the same reason
 * `promote` takes its registry.
 *
 * A command containing no such fragment yields NOTHING. That is not a
 * pass: `verifyTitleViolations` counts it separately, so "this shape was
 * not checked" stays visible instead of being absorbed into a green.
 */
export function verifyTitleFragments(
  where: string,
  verify: string,
  readSource: (file: string) => string | null,
): VerifyTitleFragment[] {
  const out: VerifyTitleFragment[] = [];
  BUN_TEST_T.lastIndex = 0;
  for (const m of verify.matchAll(BUN_TEST_T)) {
    const file = m[1]!;
    const name = m[3]!;
    const push = (reading: VerifyTitleReading, why: string) => out.push({ where, file, name, reading, why });

    const src = readSource(file);
    if (src === null) {
      push("FILE_ABSENT", `${file} does not exist, so this command selects nothing`);
      continue;
    }
    const literals = titlesIn(src);
    if (literals.length === 0) {
      push("UNMEASURED", `${file} states no describe/test title this can read`);
      continue;
    }
    let re: RegExp;
    try {
      re = new RegExp(name);
    } catch (e) {
      push("UNMEASURED", `-t ${JSON.stringify(name)} is not a regular expression: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    // A literal match needs no nesting to be believed, so it is asked
    // first and answers every live fragment in the plan today.
    if (literals.some(t => re.test(t))) {
      push("MATCHED", "");
      continue;
    }

    // Then nesting: the pattern may name a PATH spanning a describe and
    // the test inside it.
    const paths = titlePathsIn(src);
    if (paths !== null && paths.some(p => re.test(p))) {
      push("MATCHED", "");
      continue;
    }

    // Nothing matched. Whether that is a REFUSAL or an UNMEASURED turns
    // on one question, asked in one place: could this file's names be
    // known in full? Refusing a file whose names this cannot see is the
    // false red that makes a check an obstacle.
    const { complete, why } = namesAreComplete(src);
    if (!complete) {
      push("UNMEASURED", `${JSON.stringify(name)} matches nothing in ${file}, and ${file} cannot be read in full: ${why}`);
      continue;
    }
    push(
      "NO_SUCH_TITLE",
      `no describe/test title in ${file} matches ${JSON.stringify(name)} — ${(paths ?? literals).length} name(s) read`,
    );
  }
  return out;
}

/**
 * The refusal. One line per fragment that is not `MATCHED`, naming the
 * item, the file and the title — AC-2, because a bare count sends the next
 * reader back through every command in the plan.
 *
 * `UNMEASURED` is reported and does NOT refuse. It is a statement that
 * this instrument could not see the fragment, and turning that into a red
 * row would make the honest reading the expensive one.
 */
export function verifyTitleViolations(
  commands: readonly { where: string; verify: string | null }[],
  readSource: (file: string) => string | null,
): { violations: string[]; unmeasured: string[]; matched: number; outOfShape: number } {
  const violations: string[] = [];
  const unmeasured: string[] = [];
  let matched = 0;
  let outOfShape = 0;

  for (const c of commands) {
    if (c.verify === null || c.verify.trim().length === 0) continue;
    const frags = verifyTitleFragments(c.where, c.verify, readSource);
    if (frags.length === 0) {
      outOfShape++;
      continue;
    }
    for (const f of frags) {
      if (f.reading === "MATCHED") matched++;
      else if (f.reading === "UNMEASURED") unmeasured.push(`${f.where}: ${f.why}`);
      else violations.push(`${f.where}: ${f.why}`);
    }
  }
  return { violations, unmeasured, matched, outOfShape };
}
