/**
 * Covers #1727 — the queue label has ONE binding, read by the writer that
 * applies it and the reading that scores it.
 *
 * `plan-issues --decompose --write` created #1716..#1722 on 2026-11-02 and
 * set no label, so `queue-label` fell MET 12 of 12 → 5 of 12 on a command
 * that never consulted it. It was repaired with seven `gh issue edit` calls
 * by hand, which is the thing SC-2625 forbids.
 *
 * The defect is not "the writer forgot". It is that the writer and the
 * reading had no shared answer to *what is the queue label* — and the
 * cheapest fix, spelling `"engine"` in the writer too, is the two-deciders
 * shape `.claude/rules/checks-must-be-able-to-fail.md` names: no behavioural
 * test can tell two agreeing guards apart, and a mutation of either leaves
 * the other holding every case up.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readQueueLabel } from "../lib/config-readers.ts";

/** A scaffolded tree whose `board` block is whatever the case needs. */
function treeWithBoard(board: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "rg-queue-label-"));
  mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "rungate", "config.json"),
    JSON.stringify({ project: "x", ...(board === undefined ? {} : { board }) }),
  );
  return root;
}

describe("the queue label is configured, never assumed", () => {
  test("a configured label is read", () => {
    const root = treeWithBoard({ queueLabel: "engine" });
    try {
      expect(readQueueLabel(root)).toBe("engine");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the value is the CONFIGURED one — not a built-in that happens to match", () => {
    // The control that makes the case above mean something. A reader
    // hardcoded to return "engine" passes that test and fails this one.
    const root = treeWithBoard({ queueLabel: "queue" });
    try {
      expect(readQueueLabel(root)).toBe("queue");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("absent, blank and non-string all read NULL — never a silent default", () => {
    // `.claude/rules/config-access.md`: a built-in substituted for absent
    // config without recording it is Silent Default Substitution. A tree
    // that never configured a queue has not got an empty queue — it has no
    // queue, and the two are different facts.
    for (const board of [undefined, {}, { queueLabel: "" }, { queueLabel: "   " }, { queueLabel: 7 }]) {
      const root = treeWithBoard(board);
      try {
        expect(readQueueLabel(root), `board=${JSON.stringify(board)} produced a label`).toBeNull();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("an unscaffolded tree reads NULL rather than throwing", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-queue-label-bare-"));
    try {
      expect(readQueueLabel(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the writer and the reading share that one binding", () => {
  test("no script spells the queue label itself — all three go through the binding", async () => {
    // The whole point of #1727. Two sites spelling `"engine"` agree today
    // and cannot be told apart by any behavioural case, so this asserts the
    // STRUCTURE instead: the literal appears in none of them.
    //
    // `board-conformance.ts` is the exception that proves where the binding
    // had to live. It may not IMPORT `readQueueLabel` — its mutation
    // battery copies the file into an `mkdtemp` and a relative import makes
    // the mutant fail to load, which reads as a refusal on the merits
    // (`.claude/rules/self-referential-tests.md`). So the producer resolves
    // the label and it reaches the reading as snapshot data.
    // `lib/issue-filing-gate.ts` joined the population in #1961: the filing
    // cap's third route asks whether a filing is in the project's work
    // queue, which is the same question these two ask and must not be a
    // fourth opinion about what the queue is called.
    const reaches = [
      "scripts/plan-issues.ts",
      "scripts/board-snapshot.ts",
      "lib/issue-filing-gate.ts",
    ];
    const importFree = ["scripts/board-conformance.ts"];

    // The detector, named once so the control below runs the SAME code the
    // census runs. Two copies would be two deciders and the control would
    // prove nothing about the one that scores the repository.
    const spelledIn = (src: string) => [
      ...src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "")
        .matchAll(/["'`]engine["'`]/g),
    ].map(m => m[0]);

    // The control. A stripper that ate the code as well as the comments
    // would pass every assertion below having looked at nothing, which is
    // exactly the shape `.claude/rules/checks-must-be-able-to-fail.md`
    // calls an assertion that holds vacuously. Each line is a spelling a
    // real regression would arrive as.
    expect(
      spelledIn([
        `/* a docblock mentioning "engine" is prose */`,
        `// so is a line comment about 'engine'`,
        `const label = "engine";`,
        `args.push("--label", 'engine');`,
        "const t = `engine`;",
      ].join("\n")),
      "the comment stripper also removed the code — every assertion below is vacuous",
    ).toEqual([`"engine"`, `'engine'`, "`engine`"]);

    for (const path of [...reaches, ...importFree]) {
      const src = await Bun.file(join(import.meta.dir, "..", path)).text();
      // The property is about CODE, so strip comments before matching.
      // Prose naming the label is the whole point of explaining why it is
      // configured — `board-conformance.ts` says in as many words that it
      // used to spell `"engine"` and no longer does, and a matcher that
      // reads that sentence as the defect it describes makes the only
      // honest fix deleting the explanation.
      //
      // Narrowing the pattern instead was the first attempt and was the
      // wrong shape twice: dropping backticks let a quoted mention
      // through, and dropping quotes too would stop detecting the defect.
      // A comment stripper separates the two populations; a cleverer
      // regex only moves the line between them.
      const spelled = spelledIn(src);
      // `.toEqual([])` on the matches, and `.toBe(true)` on a boolean
      // below: a failed `toContain` on source prints the whole file, and
      // these are 20KB each.
      expect(spelled, `${path} spells the queue label itself — read it through readQueueLabel`).toEqual([]);
    }
    for (const path of reaches) {
      const src = await Bun.file(join(import.meta.dir, "..", path)).text();
      expect(src.includes("readQueueLabel"), `${path} does not reach the one binding`).toBe(true);
    }
    for (const path of importFree) {
      const src = await Bun.file(join(import.meta.dir, "..", path)).text();
      expect(
        [...src.matchAll(/^import .*from "\.\..*$/gm)].map(m => m[0]),
        `${path} gained a relative import — its mutant will fail to load and every negative case ` +
          `in test/board-conformance.test.ts will witness nothing`,
      ).toEqual([]);
    }
  });
});
