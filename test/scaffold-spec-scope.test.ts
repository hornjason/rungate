/**
 * #2307: scaffold writes `board: { scope: deferred }` into every spec that
 * declares no scope, banks it, and names each file. Serves no criterion (the
 * issue says so): it carries out Jason's call of 2026-11-17 on #2301.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { DEFERRED_LINE, deferUndeclaredSpecs, withDeferredScope } from "../lib/scaffold/spec-scope";
import { boardDeclaration } from "../lib/spec-placement";

const ROOT = join(import.meta.dir, "..");
const BANK = ".claude/spec-deferral-ratchet.json";

const spec = (fm: string, body: string) => `---\ndoc-type: spec\ntestable: true\n${fm}---\n\n# A spec\n\n${body}\n`;

const FILES: Record<string, string> = {
  "specs/UNDECLARED-SPEC.md": spec("", "- [ ] SC-9301: one\n- [ ] SC-9302: two"),
  "specs/DEFERRED-SPEC.md": spec("board: { scope: deferred }\n", "- [ ] SC-9303: held back"),
  "specs/ACTIVE-SPEC.md": spec("board: { scope: active, prefix: Zqactive }\n", "- [ ] SC-9304: opted in"),
  "specs/GENERATED-SPEC.md": spec("generated-by: scripts/some-generator.ts\n", "- [ ] SC-9305: produced"),
  "specs/SPEC-TEMPLATE.md": spec("", "- [ ] SC-9306: a placeholder"),
  // The sweep drops only the top-level template by path; a template elsewhere reaches this step.
  "specs/nested/AREA-SPEC-TEMPLATE.md": spec("", "- [ ] SC-9307: another placeholder"),
  // A column-0 comment the frontmatter parser refuses, so an added line would read as invalid.
  "specs/COMMENTED-SPEC.md": spec("# a column-0 comment\n", "States none."),
  "specs/nested/EMPTY-SPEC.md": spec("", "States none."),
};

function tree(bank: string | null = JSON.stringify({ deferred: [{ path: "specs/DEFERRED-SPEC.md", criteria: 1 }] }, null, 2) + "\n"): string {
  const root = mkdtempSync(join(tmpdir(), "scaffold-spec-scope-"));
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  if (bank !== null) {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, BANK), bank);
  }
  return root;
}

const readAt = (root: string, rel: string) => readFileSync(join(root, rel), "utf-8");

describe("#2307: every spec declares a board scope after one scaffold", () => {
  test("only the undeclared specs get the line; it reads as deferred; the other four are byte-identical", () => {
    const root = tree();
    try {
      const actions: string[] = [];
      deferUndeclaredSpecs(root, actions);
      for (const rel of ["specs/UNDECLARED-SPEC.md", "specs/nested/EMPTY-SPEC.md"]) {
        expect(readAt(root, rel)).toContain(`${DEFERRED_LINE}\n---`);
        expect(boardDeclaration(readAt(root, rel)).scope, rel).toBe("deferred");
      }
      for (const rel of [
        "specs/DEFERRED-SPEC.md",
        "specs/ACTIVE-SPEC.md",
        "specs/GENERATED-SPEC.md",
        "specs/SPEC-TEMPLATE.md",
        "specs/nested/AREA-SPEC-TEMPLATE.md",
        "specs/COMMENTED-SPEC.md",
      ]) {
        expect(readAt(root, rel), `${rel} was rewritten`).toBe(FILES[rel]);
      }
      expect(actions).toContain(`UPDATED: specs/UNDECLARED-SPEC.md (${DEFERRED_LINE} — it declared no scope)`);
      expect(actions).toContain(`UPDATED: specs/nested/EMPTY-SPEC.md (${DEFERRED_LINE} — it declared no scope)`);
      expect(actions).toContain(`UPDATED: ${BANK} (2 spec(s) banked as deferred)`);
      // Left alone and said so, every run: the engine still cannot read this spec's scope.
      expect(actions.some(a => a.startsWith("SKIP: specs/COMMENTED-SPEC.md: its frontmatter cannot be read"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the bank gains each newly deferred spec at its criteria count and keeps the rows it had", () => {
    const root = tree();
    try {
      deferUndeclaredSpecs(root, []);
      expect(JSON.parse(readAt(root, BANK)).deferred).toEqual([
        { path: "specs/DEFERRED-SPEC.md", criteria: 1 },
        { path: "specs/UNDECLARED-SPEC.md", criteria: 2 },
        { path: "specs/nested/EMPTY-SPEC.md", criteria: 0 },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a second scaffold writes nothing and reports nothing", () => {
    const root = tree();
    try {
      deferUndeclaredSpecs(root, []);
      const snapshot = Object.keys(FILES).map(rel => readAt(root, rel)).concat(readAt(root, BANK));
      const again: string[] = [];
      deferUndeclaredSpecs(root, again);
      expect(again.filter(a => !a.startsWith("SKIP: specs/COMMENTED-SPEC.md"))).toEqual([]);
      expect(Object.keys(FILES).map(rel => readAt(root, rel)).concat(readAt(root, BANK))).toEqual(snapshot);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a tree with no bank gets one; a bank that is not JSON refuses and nothing is written", () => {
    const fresh = tree(null);
    try {
      deferUndeclaredSpecs(fresh, []);
      expect(existsSync(join(fresh, BANK))).toBe(true);
      expect(JSON.parse(readAt(fresh, BANK)).deferred.map((d: { path: string }) => d.path)).toEqual([
        "specs/UNDECLARED-SPEC.md",
        "specs/nested/EMPTY-SPEC.md",
      ]);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
    const broken = tree("{ not json");
    try {
      const actions: string[] = [];
      deferUndeclaredSpecs(broken, actions);
      expect(actions.some(a => a.startsWith("REFUSED: spec board scopes (the deferral bank is not JSON"))).toBe(true);
      expect(readAt(broken, "specs/UNDECLARED-SPEC.md")).toBe(FILES["specs/UNDECLARED-SPEC.md"]);
      expect(readAt(broken, BANK)).toBe("{ not json");
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  test("a bank already holding an undeclared spec refuses rather than overwrite the row", () => {
    const root = tree(JSON.stringify({ deferred: [{ path: "specs/UNDECLARED-SPEC.md", criteria: 7 }] }));
    try {
      const actions: string[] = [];
      deferUndeclaredSpecs(root, actions);
      expect(actions.some(a => a.includes("already holds specs/UNDECLARED-SPEC.md"))).toBe(true);
      expect(readAt(root, "specs/UNDECLARED-SPEC.md")).toBe(FILES["specs/UNDECLARED-SPEC.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a write that keeps failing, restores included, ends in a refusal naming the stuck spec, never a throw", () => {
    const root = tree();
    try {
      const actions: string[] = [];
      let calls = 0;
      // The first spec lands; every later write throws, the restore among them.
      const flaky = (path: string, content: string) => {
        calls++;
        if (calls > 1) throw new Error("ENOSPC: no space left on device");
        writeFileSync(path, content);
        return { written: true };
      };
      expect(() => deferUndeclaredSpecs(root, actions, flaky)).not.toThrow();
      const refusal = actions.find(a => a.startsWith("REFUSED: spec board scopes (a write threw: ENOSPC"));
      expect(refusal, actions.join("\n")).toBeDefined();
      expect(refusal).toContain("specs/UNDECLARED-SPEC.md could not be put back");
      expect(actions.some(a => a.startsWith("UPDATED:")), "a refused run reported a write").toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("withDeferredScope keeps the file's line endings and refuses a file with no frontmatter", () => {
    expect(withDeferredScope("---\r\ndoc-type: spec\r\n---\r\nbody\r\n")).toBe(`---\r\ndoc-type: spec\r\n${DEFERRED_LINE}\r\n---\r\nbody\r\n`);
    expect(withDeferredScope("# no frontmatter\n")).toBeNull();
  });

  test("scaffold runs the step: write-steps calls it", () => {
    const src = readFileSync(join(ROOT, "lib", "scaffold", "write-steps.ts"), "utf-8");
    expect(src).toMatch(/^\s*deferUndeclaredSpecs\(projectPath, actions\);$/m);
  });
});
