/**
 * Covers SC-2776 (SPEC-TO-BOARD-PIPELINE-SPEC.md): a spec is consumed by the
 * engine only when its own frontmatter opts it in.
 *
 * ADR-018 Decisions 8 and 9. A spec opts in with one `board:` block —
 * `scope: active` and the `prefix` its milestones use. No block is never
 * consumed, whatever else the spec carries; `scope: deferred`, and the legacy
 * `board-scope: deferred` line, hold it back. A key or a scope value the
 * engine does not know, and an active spec with no prefix, are reported by
 * name and never guessed.
 *
 * The board-conformance half — `spec-placement` measuring only these specs,
 * and the engine spec's block agreeing with config — is in
 * `test/board-conformance.test.ts`, the `SC-2776` describe.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { boardDeclaration, declaresDeferred, placementCoverage } from "../lib/spec-placement.ts";
import { specPathSweep } from "../lib/board-mirror.ts";
import { readBoardInputs } from "../lib/config-readers.ts";

const ROOT = join(import.meta.dir, "..");

/** A spec with this frontmatter tail, and a body holding a placement table. */
const spec = (frontmatter: string, body = "") =>
  `---\ndoc-type: spec\ntestable: true\n${frontmatter}---\n# X\n\n${body}### Phase placement\n\n| Placement | Criteria |\n|---|---|\n| Phase 1 | SC-9001 |\n\n- [ ] SC-9001: a criterion\n`;

describe("SC-2776: a spec opts itself in through one board: block in its own frontmatter", () => {
  test("SC-2776: a block with scope active and a prefix opts the spec in", () => {
    expect(boardDeclaration(spec("board:\n  scope: active\n  prefix: Engine\n"))).toEqual({
      scope: "active",
      prefix: "Engine",
      problems: [],
    });
  });

  test("SC-2776: the one-line form ADR-018 writes reads the same, quotes paired", () => {
    expect(boardDeclaration(spec("board: { scope: active, prefix: Convergence }\n"))).toEqual({
      scope: "active",
      prefix: "Convergence",
      problems: [],
    });
    expect(boardDeclaration(spec(`board:\n  scope: "active"\n  prefix: 'Two Words'\n`)).prefix).toBe("Two Words");
  });

  test("SC-2776: no board: block is undeclared — a placement table alone opts nothing in", () => {
    const d = boardDeclaration(spec(""));
    expect(d).toEqual({ scope: "undeclared", prefix: null, problems: [] });
    // A spec with no frontmatter at all is the same fact.
    expect(boardDeclaration("# X\n\n- [ ] SC-9001: a criterion\n").scope).toBe("undeclared");
  });

  test("SC-2776: a board: block in the body is prose about the convention, not a declaration", () => {
    expect(boardDeclaration(spec("", "board:\n  scope: active\n  prefix: Engine\n\n")).scope).toBe("undeclared");
  });

  test("SC-2776: scope deferred, and the legacy board-scope line, both hold the spec back", () => {
    expect(boardDeclaration(spec("board:\n  scope: deferred\n")).scope).toBe("deferred");
    expect(boardDeclaration(spec("board-scope: deferred\n")).scope).toBe("deferred");
    expect(declaresDeferred(spec("board:\n  scope: deferred\n"))).toBe(true);
    expect(declaresDeferred(spec("board:\n  scope: active\n  prefix: Engine\n"))).toBe(false);
    // Both spellings at once agree, so it is still one reading.
    expect(boardDeclaration(spec("board-scope: deferred\nboard:\n  scope: deferred\n"))).toEqual({
      scope: "deferred",
      prefix: null,
      problems: [],
    });
  });

  test("SC-2776: an unknown scope value is reported by name and opts nothing in", () => {
    const d = boardDeclaration(spec("board:\n  scope: activ\n  prefix: Engine\n"));
    expect(d.scope).toBe("invalid");
    expect(d.problems.join("\n")).toContain("`board.scope: activ` is not a scope the engine knows");
    // An unpaired quote is not the value it nearly spells.
    expect(boardDeclaration(spec(`board:\n  scope: "active\n  prefix: Engine\n`)).scope).toBe("invalid");
  });

  test("SC-2776: an unknown key is reported by name and otherwise ignored — a typo never opts a spec in", () => {
    const typo = boardDeclaration(spec("board:\n  scpoe: active\n  prefix: Engine\n"));
    expect(typo.scope).toBe("invalid");
    expect(typo.problems.join("\n")).toContain("`board.scpoe` is not a key the engine knows");
    expect(typo.problems.join("\n")).toContain("declares no `scope`");

    const extra = boardDeclaration(spec("board:\n  scope: active\n  prefix: Engine\n  colour: red\n"));
    expect(extra.scope).toBe("active");
    expect(extra.prefix).toBe("Engine");
    expect(extra.problems).toEqual(["`board.colour` is not a key the engine knows (it reads scope, prefix)"]);
  });

  test("SC-2776: an active spec with no prefix is reported, and no prefix is invented from the filename", () => {
    const d = boardDeclaration(spec("board:\n  scope: active\n"));
    expect(d.scope).toBe("active");
    expect(d.prefix).toBeNull();
    expect(d.problems.join("\n")).toContain("declares no `prefix`");
    expect(boardDeclaration(spec(`board:\n  scope: active\n  prefix: ""\n`)).prefix).toBeNull();
  });

  test("SC-2776: a declaration made twice, or two that disagree, is reported and never picked between", () => {
    const disagree = boardDeclaration(spec("board-scope: deferred\nboard:\n  scope: active\n  prefix: Engine\n"));
    expect(disagree.scope).toBe("invalid");
    expect(disagree.problems.join("\n")).toContain("disagree");

    const twice = boardDeclaration(spec("board:\n  scope: active\n  scope: deferred\n  prefix: Engine\n"));
    expect(twice.scope).toBe("invalid");
    expect(twice.problems.join("\n")).toContain("`board.scope` is declared more than once");

    const legacyOther = boardDeclaration(spec("board-scope: in\n"));
    expect(legacyOther.scope).toBe("invalid");
    expect(legacyOther.problems.join("\n")).toContain("takes only `deferred`");
  });

  test("SC-2776: a board: value or line the engine cannot read is named, not skipped", () => {
    expect(boardDeclaration(spec("board: active\n")).problems.join("\n")).toContain("must be a block of keys");
    expect(boardDeclaration(spec("board: active\n")).scope).toBe("invalid");
    const nested = boardDeclaration(spec("board:\n  scope: active\n  prefix: Engine\n    deeper: x\n"));
    expect(nested.problems.join("\n")).toContain("nested under another key");
    // A frontmatter the parser refuses, which DOES start a board key, cannot
    // be read as undeclared — that would be guessing it opts nothing in.
    const refused = boardDeclaration("---\ndoc-type: spec\n# a column-0 comment\nboard:\n  scope: active\n---\n");
    expect(refused.scope).toBe("invalid");
    // ...and one that starts no board key is simply undeclared.
    expect(boardDeclaration("---\ndoc-type: spec\n# a column-0 comment\n---\n").scope).toBe("undeclared");
  });

  test("SC-2776: the tree sweep carries each spec's declaration, so a caller never re-reads it", () => {
    const files: Record<string, string> = {
      "specs/ON.md": spec("board:\n  scope: active\n  prefix: On\n"),
      "specs/OFF.md": spec(""),
      "specs/HELD.md": spec("board-scope: deferred\n"),
    };
    const cov = placementCoverage(
      "/nowhere",
      () => ({ reading: "MEASURED", unmeasuredReasons: [], paths: Object.keys(files) }),
      (_root, path) => files[path]!,
    );
    expect(cov.specs.map(s => [s.path, s.board.scope, s.board.prefix, s.deferred])).toEqual([
      ["specs/ON.md", "active", "On", false],
      ["specs/OFF.md", "undeclared", null, false],
      ["specs/HELD.md", "deferred", null, true],
    ]);
  });

  test("SC-2776: this tree opts in exactly the engine and payload specs, and the engine's block agrees with config", () => {
    const cov = placementCoverage(ROOT, specPathSweep, (b, p) => readFileSync(join(b, p), "utf-8"));
    expect(cov.reading).toBe("MEASURED");
    const active = cov.specs.filter(s => s.board.scope === "active").map(s => [s.path, s.board.prefix]);
    expect(active).toEqual([
      ["specs/CODE-REVIEW-CONVERGENCE-SPEC.md", "Convergence"],
      ["specs/SPEC-TO-BOARD-PIPELINE-SPEC.md", "Engine"],
    ]);
    const reported = cov.specs.filter(s => s.board.problems.length > 0).map(s => `${s.path}: ${s.board.problems.join("; ")}`);
    expect(reported).toEqual([]);
    const { engineSpec, milestonePrefix } = readBoardInputs(ROOT);
    expect(active).toContainEqual([engineSpec, milestonePrefix]);
  });
});
