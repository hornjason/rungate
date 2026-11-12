/**
 * #2020: an issue that names no criterion, and does not declare that it
 * serves none, carries `needs-criterion` from the moment it is opened — and
 * loses it the moment an edit makes it answer.
 *
 * Covers SC-2737 (SPEC-TO-BOARD-PIPELINE-SPEC.md): the PR-time refusal moves
 * to filing time, as a flag rather than a block.
 *
 * The fixture ids are `ZZ-<N>`, a namespace no spec uses, so nothing here is
 * read as a claim about a real criterion.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { NAMES_NONE, NEEDS_CRITERION_LABEL, answerableIds, criterionAnswer } from "../lib/board-mirror";
import { COMMENT_BODY, LABEL_COLOR, LABEL_DESCRIPTION, labelPlan, run } from "../scripts/criterion-label";

const ROOT = join(import.meta.dir, "..");
const IDS = ["ZZ-1", "ZZ-2"];
const L = NEEDS_CRITERION_LABEL;
const CREATE = ["label", "create", L, "--repo", "o/r", "--color", LABEL_COLOR, "--description", LABEL_DESCRIPTION, "--force"];

type Fixture = { number: number; title: string; body: string | null; labels: string[]; labelsTruncated?: boolean };
const issue = (number: number, body: string | null, labels: string[] = [], extra: Partial<Fixture> = {}): Fixture => ({
  number,
  title: `issue ${number}`,
  body,
  labels,
  ...extra,
});

describe("#2020: criterionAnswer — the one decider", () => {
  test("a named criterion answers; a declared none answers; silence does not", () => {
    expect(criterionAnswer(issue(1, "Serves ZZ-2."), IDS)).toEqual({ names: ["ZZ-2"], servesNone: false, answered: true });
    expect(criterionAnswer(issue(2, `Cleanup — ${NAMES_NONE}.`), IDS)).toEqual({ names: [], servesNone: true, answered: true });
    expect(criterionAnswer(issue(3, "Fix the thing."), IDS)).toEqual({ names: [], servesNone: false, answered: false });
    expect(criterionAnswer(issue(4, null), IDS).answered).toBe(false);
  });

  test("an id no spec states is not an answer, and the declaration is read exactly as criteria-named reads it", () => {
    // ZZ-9 is in no spec, so naming it answers nothing — the same as E2.
    expect(criterionAnswer(issue(5, "Serves ZZ-9."), IDS).answered).toBe(false);
    // Capitalised is not the declaration E2 counts (#1983 was measured
    // passing closing-references and short on the board with exactly this).
    expect(criterionAnswer(issue(6, "Serves No Criterion."), IDS).answered).toBe(false);
    // The declaration may sit in the title.
    expect(criterionAnswer({ title: `chore: ${NAMES_NONE}`, body: "" }, IDS).answered).toBe(true);
  });

  test("the declaration is matched in exactly one place, so the label and criteria-named cannot disagree", () => {
    // A second `.includes(NAMES_NONE)` is a second decider; a mutation of
    // one would leave the other holding the case up (checks-must-be-able-to-fail,
    // fourth shape). Population: every .ts under lib/ and scripts/.
    const sites: string[] = [];
    for (const dir of ["lib", "scripts"]) {
      for (const f of readdirSync(join(ROOT, dir), { recursive: true }) as string[]) {
        if (!f.endsWith(".ts")) continue;
        const n = (readFileSync(join(ROOT, dir, f), "utf8").match(/\.includes\(NAMES_NONE\)/g) ?? []).length;
        for (let i = 0; i < n; i++) sites.push(`${dir}/${f}`);
      }
    }
    expect(sites).toEqual(["lib/board-mirror.ts"]);
    const snapshot = readFileSync(join(ROOT, "scripts/board-snapshot.ts"), "utf8");
    expect(snapshot, "criteria-named must read criterionAnswer, not its own copy").toContain("criterionAnswer(");
  });

  test("an id two specs both state still answers, and the id set is built in one place", () => {
    // Review round 1 of #2032: the label and criteria-named read the sweep's
    // union without its collisions while finding-promotion read both, so an
    // issue naming only SC-A1 was labelled and refused a decline at once.
    const sweep = { reading: "MEASURED" as const, specs: [], ids: ["ZZ-1"], collisions: [{ id: "ZZ-7", specs: ["a.md", "b.md"] }], unmeasuredReasons: [] };
    expect(answerableIds(sweep)).toEqual(["ZZ-1", "ZZ-7"]);
    expect(criterionAnswer(issue(7, "Serves ZZ-7."), answerableIds(sweep)).answered).toBe(true);
    const sites: string[] = [];
    for (const dir of ["lib", "scripts"]) {
      for (const f of readdirSync(join(ROOT, dir), { recursive: true }) as string[]) {
        if (!f.endsWith(".ts")) continue;
        if (readFileSync(join(ROOT, dir, f), "utf8").includes("sweep.collisions.map(")) sites.push(`${dir}/${f}`);
      }
    }
    expect(sites, "build the answerable id set with answerableIds, not a copy").toEqual(["lib/board-mirror.ts"]);
    for (const f of ["scripts/criterion-label.ts", "scripts/board-snapshot.ts", "lib/finding-promotion.ts", "scripts/plan-issues.ts"]) {
      expect(readFileSync(join(ROOT, f), "utf8"), `${f} must read answerableIds`).toContain("answerableIds(");
    }
  });
});

describe("#2020: labelPlan", () => {
  test("adds to the unanswered, removes from the answered, leaves the rest", () => {
    const plan = labelPlan(
      [
        issue(10, "no criterion here"), //            unanswered, unlabelled → add
        issue(11, "Serves ZZ-1.", [L]), //             answered, labelled    → remove
        issue(12, `${NAMES_NONE}`, ["engine", L]), //  declared, labelled    → remove
        issue(13, "still silent", [L]), //             unanswered, labelled  → nothing
        issue(14, "Serves ZZ-2.", ["engine"]), //      answered, unlabelled  → nothing
      ],
      IDS,
      L,
    );
    expect(plan).toEqual({ add: [10], remove: [11, 12], unmeasured: [] });
  });

  test("a cut label list that does not show the label is UNMEASURED, never an add", () => {
    // The label could sit past the page boundary; adding it again is a
    // write decided on a reading that was not taken.
    const plan = labelPlan(
      [issue(20, "silent", ["a"], { labelsTruncated: true }), issue(21, "Serves ZZ-1.", [L, "b"], { labelsTruncated: true })],
      IDS,
      L,
    );
    // #21 shows the label, so it is decidable even though the list was cut.
    expect(plan).toEqual({ add: [], remove: [21], unmeasured: [20] });
  });
});

/** A fake `gh`: answers the issues query, records every other call. */
function fakeGh(issues: Fixture[]) {
  const calls: string[][] = [];
  const exec = (args: readonly string[]): string => {
    if (args[0] === "api" && args[1] === "graphql") {
      return JSON.stringify({
        data: {
          repository: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: "" },
              nodes: issues.map(i => ({
                number: i.number,
                state: "OPEN",
                title: i.title,
                body: i.body,
                milestone: null,
                labels: { pageInfo: { hasNextPage: i.labelsTruncated === true }, nodes: i.labels.map(name => ({ name })) },
                blockedBy: { pageInfo: { hasNextPage: false }, nodes: [] },
              })),
            },
          },
        },
      });
    }
    calls.push([...args]);
    return "";
  };
  return { exec, calls };
}

describe("#2020: run", () => {
  const fixtures = () => [issue(30, "silent"), issue(31, "Serves ZZ-1.", [L]), issue(32, "also silent")];
  const base = { repo: "o/r", issue: null as number | null, comment: false, write: true };

  test("a dry run plans and writes nothing", async () => {
    const gh = fakeGh(fixtures());
    const r = await run({ ...base, write: false }, IDS, gh.exec);
    expect(r.plan).toEqual({ add: [30, 32], remove: [31], unmeasured: [] });
    expect(gh.calls).toEqual([]);
    expect(r.exit).toBe(0);
  });

  test("the sweep labels and unlabels every open issue, and comments on none", async () => {
    const gh = fakeGh(fixtures());
    const r = await run(base, IDS, gh.exec);
    expect(gh.calls).toEqual([
      CREATE,
      ["issue", "edit", "30", "--repo", "o/r", "--add-label", L],
      ["issue", "edit", "32", "--repo", "o/r", "--add-label", L],
      ["issue", "edit", "31", "--repo", "o/r", "--remove-label", L],
    ]);
    expect(r.exit).toBe(0);
  });

  test("one issue with --comment: labelled and told why, once", async () => {
    const gh = fakeGh(fixtures());
    await run({ ...base, issue: 32, comment: true }, IDS, gh.exec);
    expect(gh.calls).toEqual([
      CREATE,
      ["issue", "edit", "32", "--repo", "o/r", "--add-label", L],
      ["issue", "comment", "32", "--repo", "o/r", "--body", COMMENT_BODY],
    ]);
  });

  test("an answered issue with --comment gets no comment", async () => {
    const gh = fakeGh(fixtures());
    await run({ ...base, issue: 31, comment: true }, IDS, gh.exec);
    expect(gh.calls).toEqual([["issue", "edit", "31", "--repo", "o/r", "--remove-label", L]]);
  });

  test("an issue that is not open is reported, not guessed at", async () => {
    const gh = fakeGh(fixtures());
    const r = await run({ ...base, issue: 99, comment: true }, IDS, gh.exec);
    expect(gh.calls).toEqual([]);
    expect(r.exit).toBe(0);
    expect(r.lines.join("\n")).toContain("#99 is not open");
  });

  test("an unreadable spec sweep refuses and writes nothing — an empty id set would label every issue", async () => {
    const gh = fakeGh(fixtures());
    const r = await run(base, null, gh.exec);
    expect(r.exit).not.toBe(0);
    expect(gh.calls).toEqual([]);
    expect(r.lines.join("\n")).toContain("UNMEASURED");
  });

  test("an UNMEASURED issue makes the run exit non-zero, after the decidable writes", async () => {
    const gh = fakeGh([issue(40, "silent", ["x"], { labelsTruncated: true }), issue(41, "silent")]);
    const r = await run(base, IDS, gh.exec);
    expect(gh.calls).toEqual([CREATE, ["issue", "edit", "41", "--repo", "o/r", "--add-label", L]]);
    expect(r.exit).not.toBe(0);
  });

  test("the label is created before the first add, never when nothing is added, and a failed create adds nothing", async () => {
    const gh = fakeGh(fixtures());
    await run({ ...base, issue: 31 }, IDS, gh.exec);
    expect(gh.calls.some(c => c[0] === "label"), "nothing to add, so nothing to create").toBe(false);

    const failing = fakeGh(fixtures());
    const exec = (args: readonly string[]) => {
      if (args[0] === "label") throw new Error("HTTP 403");
      return failing.exec(args);
    };
    const r = await run(base, IDS, exec);
    expect(failing.calls.filter(c => c.includes("--add-label")), "an add after a failed create would fail anyway").toEqual([]);
    expect(failing.calls, "removals do not depend on the label being creatable").toEqual([["issue", "edit", "31", "--repo", "o/r", "--remove-label", L]]);
    expect(r.exit).not.toBe(0);
    expect(r.lines.join("\n")).toContain(`FAILED label ${L}`);
  });

  test("the comment says how to clear the label, in the exact words the board counts", () => {
    expect(COMMENT_BODY).toContain(NAMES_NONE);
    expect(COMMENT_BODY).toContain(L);
  });
});

describe("#2020: the workflow", () => {
  const wf = readFileSync(join(ROOT, ".github/workflows/criterion-label.yml"), "utf8");
  const code = wf.replace(/^\s*#.*$/gm, "");

  test("fires on filing, on edits, daily, and by hand", () => {
    expect(code).toMatch(/issues:\s*\n\s*types:\s*\[opened, edited, reopened\]/);
    expect(code).toMatch(/schedule:\s*\n\s*- cron:/);
    expect(code).toContain("workflow_dispatch:");
    expect(code).toContain("bun scripts/criterion-label.ts");
  });

  test("comments only when the issue was just opened", () => {
    const commentLines = code.split("\n").filter(l => l.includes("--comment"));
    expect(commentLines.length).toBe(1);
    expect(commentLines[0]).toMatch(/\$ACTION" = "opened"/);
  });

  test("never interpolates issue text into a run: block", () => {
    // An issue's title and body are written by whoever opened it.
    expect(code).not.toMatch(/\$\{\{\s*github\.event\.issue\.(title|body)/);
    expect(code).toMatch(/ISSUE:\s*\$\{\{\s*github\.event\.issue\.number\s*\}\}/);
  });
});
