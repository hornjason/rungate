/**
 * #1743 — two issues editing the same file cannot both sit in the pickable
 * set with nothing saying so.
 *
 * ## The measurement this exists for
 *
 * Taken 2026-11-03 over the 20 open issues with no milestone: 16 declare at
 * least one file in the body, and there are 10 overlapping pairs including a
 * cluster of FOUR — #1407, #1425, #1585 and #1355 — all rewriting
 * `lib/bash-write-guard.ts`. Hand four agents
 * `gh issue list --search "is:open -is:blocked no:assignee"` and four of them
 * collide on one file.
 *
 * That cluster is the fixture below, by name, because the issue asks for it
 * by name: four must resolve to one lead and three edges.
 *
 * ## A conflict, not a dependency
 *
 * 20 of the 23 milestone-less issues are genuinely unblocked, and inventing
 * dependencies for them would make the board lie. What they have is file
 * conflicts. The `blocked by` edge is the output only because it is the
 * primitive GitHub gives us for *not these two at once*.
 *
 * ## It reads the files section through `lib/issue-shape.ts`
 *
 * Not its own heading. #1741 put one decider behind what a valid issue looks
 * like, and a second opinion about which heading holds the file list is the
 * *two deciders that agree* shape — `FO-10` is the binding.
 */

import { describe, expect, test } from "bun:test";

import {
  declaredFiles,
  fileClusters,
  overlapNote,
  sharedFiles,
} from "../lib/issue-file-overlap";
import { ISSUE_SECTIONS, headingFor } from "../lib/issue-shape";

const FILES = headingFor(ISSUE_SECTIONS.find(s => s.id === "files")!);

/** A body declaring these paths under the files heading. */
const bodyWith = (paths: readonly string[], intro = "Something is wrong.") =>
  `${intro}\n\n${FILES}\n\n${paths.map(p => `- \`${p}\``).join("\n")}\n`;

describe("FO-1: reading the files an issue declares", () => {
  test("FO-1: a bulleted, backticked list is read", () => {
    expect(declaredFiles(bodyWith(["lib/a.ts", "test/a.test.ts"]))).toEqual([
      "lib/a.ts",
      "test/a.test.ts",
    ]);
  });

  test("FO-2: bare lines with no bullet and no backticks are read", () => {
    expect(declaredFiles(`x\n\n${FILES}\n\nlib/a.ts\nlib/b.ts\n`)).toEqual([
      "lib/a.ts",
      "lib/b.ts",
    ]);
  });

  test("FO-3: the section ENDS at the next heading", () => {
    const body = `${FILES}\n\n- \`lib/a.ts\`\n\n## How we will know\n\n- \`lib/not-a-file.ts\`\n`;

    // The next section's prose is not a file list. Reading past the boundary
    // is how a census grows a population nobody declared.
    expect(declaredFiles(body)).toEqual(["lib/a.ts"]);
  });

  test("FO-4: a body with no files section declares nothing", () => {
    expect(declaredFiles("Just prose, no headings at all.")).toEqual([]);
  });

  test("FO-5: prose inside the section is not a path", () => {
    const body = `${FILES}\n\nProbably these, but I am not sure yet.\n\n- \`lib/a.ts\`\n`;

    // A line with no `/` and no `.` is a sentence. The direction this is
    // allowed to be wrong in is toward reading FEWER files: a missed path
    // costs a warning nobody gets, and an invented one — `sure` — costs a
    // collision report against a file that does not exist, which is how a
    // warning channel becomes noise people learn to skip.
    expect(declaredFiles(body)).toEqual(["lib/a.ts"]);
  });

  test("FO-6: a fenced block inside the section is not a file list", () => {
    const body = `${FILES}\n\n- \`lib/a.ts\`\n\n\`\`\`\nlib/example.ts\n\`\`\`\n`;

    expect(declaredFiles(body)).toEqual(["lib/a.ts"]);
  });

  test("FO-7: the same path twice is one path", () => {
    expect(declaredFiles(bodyWith(["lib/a.ts", "lib/a.ts"]))).toEqual(["lib/a.ts"]);
  });

  test("FO-8: a leading ./ is the same file", () => {
    expect(declaredFiles(bodyWith(["./lib/a.ts"]))).toEqual(["lib/a.ts"]);
  });

  test("FO-10: the files heading comes from the ONE decider, not from here", () => {
    const src = readSource();

    // A heading spelled here as well as in lib/issue-shape.ts is a second
    // opinion about what the file list is: a mutation of either would leave
    // the other holding every case up, and both would read as covered.
    expect(src).not.toContain("Files this will change");
  });
});

function readSource(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("fs")
    .readFileSync(new URL("../lib/issue-file-overlap.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
}

describe("FO-20: what two issues share", () => {
  test("FO-20: the shared paths are named, not counted", () => {
    expect(sharedFiles(["lib/a.ts", "lib/b.ts"], ["lib/b.ts", "lib/c.ts"])).toEqual(["lib/b.ts"]);
  });

  test("FO-21: no shared path is an empty list, which is a reading", () => {
    expect(sharedFiles(["lib/a.ts"], ["lib/c.ts"])).toEqual([]);
  });

  test("FO-22: a test file and its source are DIFFERENT files", () => {
    // Deliberately no stem matching. `lib/a.ts` and `test/a.test.ts` are
    // edited together constantly and by the same issue; treating them as one
    // file would make almost every pair collide and the warning worthless.
    expect(sharedFiles(["lib/a.ts"], ["test/a.test.ts"])).toEqual([]);
  });
});

describe("FO-30: the #1407/#1425/#1585/#1355 cluster is the fixture", () => {
  // The four real issues from the 2026-11-03 measurement, by number, each
  // declaring the file they were measured to share.
  const CLUSTER = [
    { id: 1355, files: ["lib/bash-write-guard.ts", "test/bash-write-guard.test.ts"] },
    { id: 1407, files: ["lib/bash-write-guard.ts"] },
    { id: 1425, files: ["lib/bash-write-guard.ts", "lib/issue-create-override.ts"] },
    { id: 1585, files: ["lib/bash-write-guard.ts"] },
  ];

  test("FO-30: four issues on one file resolve to ONE lead and THREE edges", () => {
    const out = fileClusters(CLUSTER);

    expect(out).toHaveLength(1);
    expect(out[0].lead).toBe(1355);
    expect(out[0].blocked).toEqual([1407, 1425, 1585]);
    expect(out[0].files).toEqual(["lib/bash-write-guard.ts"]);
  });

  test("FO-31: the LOWEST number leads, so a re-run names the same lead", () => {
    // Any stable rule would do; this one is the only one that does not
    // depend on the order the tracker happened to return. A cluster whose
    // lead moves between runs produces a different set of edges each time
    // and the board churns.
    const shuffled = [...CLUSTER].reverse();

    expect(fileClusters(shuffled)[0].lead).toBe(fileClusters(CLUSTER)[0].lead);
  });

  test("FO-32: issues sharing nothing form NO cluster", () => {
    expect(fileClusters([
      { id: 1, files: ["lib/a.ts"] },
      { id: 2, files: ["lib/b.ts"] },
    ])).toEqual([]);
  });

  test("FO-33: an issue declaring no files joins nothing", () => {
    // Not a cluster with everyone. An empty declaration is an absent
    // reading, and a reading nobody took must not become an edge somebody
    // has to clear.
    expect(fileClusters([
      { id: 1, files: [] },
      { id: 2, files: [] },
    ])).toEqual([]);
  });

  test("FO-34: two disjoint clusters stay two", () => {
    const out = fileClusters([
      { id: 1, files: ["lib/a.ts"] },
      { id: 2, files: ["lib/a.ts"] },
      { id: 3, files: ["lib/z.ts"] },
      { id: 4, files: ["lib/z.ts"] },
    ]);

    expect(out.map(c => c.lead)).toEqual([1, 3]);
  });

  test("FO-35: a chain through a shared file is ONE cluster, not two pairs", () => {
    // 1 and 3 share nothing directly, but both collide with 2. Handing them
    // out as two independent pairs puts 2 in two clusters and the lead
    // becomes ambiguous — so the grouping is transitive.
    const out = fileClusters([
      { id: 1, files: ["lib/a.ts"] },
      { id: 2, files: ["lib/a.ts", "lib/z.ts"] },
      { id: 3, files: ["lib/z.ts"] },
    ]);

    expect(out).toHaveLength(1);
    expect(out[0].lead).toBe(1);
    expect(out[0].blocked).toEqual([2, 3]);
  });
});

describe("FO-40: the sentence an agent reads", () => {
  test("FO-40: it names the issue, the file, and the command that fixes it", () => {
    const note = overlapNote([{ id: 1407, files: ["lib/bash-write-guard.ts"] }], 1743);

    expect(note).toContain("#1407");
    expect(note).toContain("lib/bash-write-guard.ts");
    // A warning that does not name the remedy is a warning nobody can act
    // on — .claude/rules/config-access.md says this about UNMEASURED and it
    // is true of every channel this gate writes to.
    expect(note).toContain("--add-blocked-by");
  });

  test("FO-41: no overlap produces NO note, not an empty one", () => {
    expect(overlapNote([], 1743)).toBeNull();
  });

  test("FO-42: several collisions are one sentence naming all of them", () => {
    const note = overlapNote(
      [
        { id: 1407, files: ["lib/bash-write-guard.ts"] },
        { id: 1425, files: ["lib/issue-create-override.ts"] },
      ],
      1743,
    );

    expect(note).toContain("#1407");
    expect(note).toContain("#1425");
  });
});
