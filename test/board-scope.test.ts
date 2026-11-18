/**
 * `rungate board-scope` — #2275, onboarding existing specs.
 *
 * A consumer's checkboxes do not say what is left: on two consumer repos 18 of
 * 59 unticked criteria were already done. So before a maintainer opts a spec
 * in, this prints what it holds and a looks-done HINT for each unticked
 * criterion, and never ticks anything. Every case runs the real script against
 * a fixture tree, with the hint decider also exercised on its own.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { onboardingHint, tracksOnBoard } from "../lib/spec-placement";
const SCRIPT = join(import.meta.dir, "..", "scripts", "board-scope.ts");
/**
 * The script's one refusal code, read from its source rather than imported:
 * importing it would put the credit scan on this file's import graph
 * (test/sc-scan-cost.test.ts), and the fixture tree here is a few files.
 */
const REFUSE_EXIT = Number(/^export const REFUSE_EXIT = (\d+);$/m.exec(readFileSync(SCRIPT, "utf-8"))?.[1]);

const spec = (fm: string, body: string) => `---\ndoc-type: spec\ntestable: true\n${fm}---\n\n# A spec\n\n${body}\n`;

/** A tree with an untracked spec, a tracked one sharing an id, a template and a generated copy. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "board-scope-"));
  const files: Record<string, string> = {
    "specs/UNTRACKED-SPEC.md": spec(
      "",
      [
        "- [ ] SC-9101: the first thing is true",
        "- [ ] SC-9102: the shared thing is true",
        "- [ ] SC-9103: the unproven thing is true",
        "- [x] SC-9104: the finished thing is true",
      ].join("\n"),
    ),
    "specs/TRACKED-SPEC.md": spec("board: { scope: active, prefix: Tracked }\n", "- [ ] SC-9102: a different thing under the same id"),
    "specs/SPEC-TEMPLATE.md": spec("", "- [ ] SC-9199: a placeholder"),
    "specs/GENERATED-SPEC.md": spec("generated-by: scripts/some-generator.ts\n", "- [ ] SC-9198: produced, not authored"),
    "specs/DRAFT-SPEC.md": spec("board: { scope: Active }\n", "No criteria yet."),
    "test/first.test.ts": 'import { test } from "bun:test";\ntest("SC-9101: the first thing is true", () => {});\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const run = (root: string, ...args: string[]) => {
  const r = spawnSync("bun", [SCRIPT, ...args], { cwd: root, encoding: "utf-8" });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
};

describe("#2275: board-scope reports each spec before it is opted in", () => {
  test("#2275: a done-but-unticked criterion shows the hint and stays unticked", () => {
    const root = fixture();
    try {
      const before = readFileSync(join(root, "specs/UNTRACKED-SPEC.md"), "utf-8");
      const r = run(root, "--spec", "specs/UNTRACKED-SPEC.md");
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("SC-9101  looks done: a test claims it");
      expect(r.out).toContain("SC-9103  cannot tell: no test claims it in a declaring position");
      // The ticked one is not hinted at all: there is nothing left to decide.
      expect(r.out).not.toContain("SC-9104 ");
      expect(readFileSync(join(root, "specs/UNTRACKED-SPEC.md"), "utf-8"), "the report wrote to the spec").toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("#2275: an id two specs state is ambiguous, never matched", () => {
    const root = fixture();
    try {
      const r = run(root, "--spec", "specs/UNTRACKED-SPEC.md");
      expect(r.out).toContain("SC-9102  ambiguous: also stated by specs/TRACKED-SPEC.md");
      expect(r.out).not.toContain("SC-9102  looks done");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #2333: a `generated-by:` copy repeats its source's ids. It is not a
  // second author, so the source keeps its hint at both deciders — the
  // who-states-this-id map AND the claim-credit rule. An authored duplicate
  // (SC-9102) is still ambiguous.
  test("#2333: a generated copy restating a claimed id leaves the source 'looks done'; an authored duplicate stays ambiguous", () => {
    const root = fixture();
    try {
      writeFileSync(
        join(root, "specs/MIRROR-SPEC.md"),
        spec("generated-by: scripts/some-generator.ts\n", "- [ ] SC-9101: the first thing is true"),
      );
      const r = run(root, "--spec", "specs/UNTRACKED-SPEC.md");
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("SC-9101  looks done: a test claims it");
      expect(r.out).not.toContain("SC-9101  ambiguous");
      expect(r.out).not.toContain("SC-9101  cannot tell");
      expect(r.out).toContain("SC-9102  ambiguous: also stated by specs/TRACKED-SPEC.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("#2275: a spec with criteria and no board: block is not tracked, a population of its own", () => {
    const root = fixture();
    try {
      const r = run(root);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("specs/UNTRACKED-SPEC.md — NOT TRACKED (undeclared): 4 criteria, 1 ticked");
      expect(r.out).toContain("specs/TRACKED-SPEC.md — tracked (active): 1 criteria, 0 ticked");
      expect(r.out).toContain("not tracked: 1 spec(s), 4 criteria the board does not show");
      // A generated copy is named apart and never counted: its source is what gets opted in.
      expect(r.out).toContain("specs/GENERATED-SPEC.md — generated by scripts/some-generator.ts; opt in its source, so it is not counted");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("#2275: a template and a generated copy are refused by name", () => {
    const root = fixture();
    try {
      const template = run(root, "--spec", "specs/SPEC-TEMPLATE.md");
      expect(template.code).toBe(REFUSE_EXIT);
      expect(template.out).toContain("specs/SPEC-TEMPLATE.md is the spec template");
      const generated = run(root, "--spec", "specs/GENERATED-SPEC.md");
      expect(generated.code).toBe(REFUSE_EXIT);
      expect(generated.out).toContain("specs/GENERATED-SPEC.md is generated by scripts/some-generator.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("#2275: a spec asked for by name is shown with no criteria, and a board: block it cannot read is named", () => {
    const root = fixture();
    try {
      expect(Number.isInteger(REFUSE_EXIT) && REFUSE_EXIT !== 0, "REFUSE_EXIT was not read from the script").toBe(true);
      const r = run(root, "--spec", "specs/DRAFT-SPEC.md");
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("specs/DRAFT-SPEC.md — NOT TRACKED (invalid): 0 criteria");
      expect(r.out).toContain("board: `board.scope: Active` is not a value the engine knows");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("#2275: a tree where no spec states a criterion yet is still listed, not refused", () => {
    // The id sweep refuses that tree for board-mirror's reasons (no cell can
    // be filled); a report made before onboarding must not inherit it.
    const root = mkdtempSync(join(tmpdir(), "board-scope-empty-"));
    try {
      mkdirSync(join(root, "specs"), { recursive: true });
      writeFileSync(join(root, "specs/FIRST-SPEC.md"), spec("", "No criteria yet."));
      const all = run(root);
      expect(all.code, all.out).toBe(0);
      expect(all.out).toContain("not tracked: 0 spec(s), 0 criteria the board does not show");
      const one = run(root, "--spec", "specs/FIRST-SPEC.md");
      expect(one.code, one.out).toBe(0);
      expect(one.out).toContain("specs/FIRST-SPEC.md — NOT TRACKED (undeclared): 0 criteria");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("#2275: the hint decider, one case per outcome", () => {
    const declaredBy = new Map([
      ["SC-9201", ["specs/A.md"]],
      ["SC-9202", ["specs/A.md", "specs/B.md"]],
    ]);
    const claimed = (id: string) => id === "SC-9201" || id === "SC-9202";
    expect(onboardingHint("SC-9201", "specs/A.md", claimed, declaredBy)).toEqual({ kind: "looks-done" });
    // Claimed AND stated twice: ambiguity wins, so a claim on the other spec's id never reads as done.
    expect(onboardingHint("SC-9202", "specs/A.md", claimed, declaredBy)).toEqual({ kind: "ambiguous", others: ["specs/B.md"] });
    expect(onboardingHint("SC-9203", "specs/A.md", claimed, declaredBy).kind).toBe("cannot-tell");
    expect(tracksOnBoard({ scope: "active", settings: {}, problems: [], unknownKeys: [] })).toBe(true);
    expect(tracksOnBoard({ scope: "deferred", settings: {}, problems: [], unknownKeys: [] })).toBe(false);
    expect(tracksOnBoard({ scope: "undeclared", settings: {}, problems: [], unknownKeys: [] })).toBe(false);
  });
});
