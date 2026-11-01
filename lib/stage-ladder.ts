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
   * `~/.claude/FLEET-STATE.md`, which no CI runner has. Such an item is NOT
   * silently skipped, because a check that quietly declines to run is
   * indistinguishable from a check that passed
   * (`.claude/rules/checks-must-be-able-to-fail.md`, *assertions that hold
   * vacuously*). It is counted, named in the output, and the count is itself
   * asserted — so a second machine-scoped item cannot appear without somebody
   * deciding to allow it.
   */
  scope?: "repo" | "machine";
}

/** One stage of the build order. */
export interface Stage {
  /** A single uppercase letter. Position in the array IS the order. */
  id: string;
  name: string;
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
      if (item.scope !== undefined && item.scope !== "repo" && item.scope !== "machine") {
        out.push(`${iAt}.scope is ${JSON.stringify(item.scope)}, expected "repo", "machine" or absent (absent means "repo")`);
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
export function nextStage(
  stages: readonly Stage[],
): { stage: Stage; blocked: string | null } | null {
  for (const stage of stages) {
    if (stageIsComplete(stage)) continue;
    return {
      stage,
      blocked:
        stage.agreed === null
          ? `stage ${stage.id} has agreed: null — its ${stage.items.length} item(s) are a proposal, not an agreement. Nothing in it may be started or ticked until the wording is agreed and written here (AGENTS.md rule 9).`
          : null,
    };
  }
  return null;
}
