/**
 * Covers SC-2776 (SPEC-TO-BOARD-PIPELINE-SPEC.md): a spec is consumed by the
 * engine only when its own frontmatter opts it in.
 *
 * ADR-018 Decisions 8 and 9. A spec opts in with one `board:` block —
 * `scope: active` and the `prefix` its milestones use. No block is never
 * consumed, whatever else the spec carries; `scope: deferred`, and the legacy
 * `board-scope: deferred` line, hold it back. An unknown scope value and an
 * active spec with no prefix are reported by name and never guessed; an
 * unknown key is reported by name and otherwise ignored.
 *
 * The board-conformance half — `spec-placement` measuring only these specs,
 * and the engine spec's block agreeing with config — is in
 * `test/board-conformance.test.ts`, the `SC-2776` describe.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { BOARD_KEYS, boardDeclaration, declaresDeferred, placementCoverage } from "../lib/spec-placement.ts";
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
      settings: { scope: "active", prefix: "Engine" },
      problems: [],
      unknownKeys: [],
    });
  });

  test("SC-2776: the one-line form ADR-018 writes reads the same", () => {
    expect(boardDeclaration(spec("board: { scope: active, prefix: Convergence }\n")).settings).toEqual({
      scope: "active",
      prefix: "Convergence",
    });
  });

  // Regressions found reviewing the first version, which parsed this block by
  // hand: a comma inside a quoted prefix split the value, and a trailing YAML
  // comment made `active` an unknown scope. Both are ordinary YAML.
  test("SC-2776: quoting, commas and comments mean what YAML says they mean", () => {
    expect(boardDeclaration(spec(`board: { scope: active, prefix: "A, B" }\n`)).settings.prefix).toBe("A, B");
    const commented = boardDeclaration(spec("board:\n  scope: active  # opted in 2026-11-17\n  prefix: Engine\n"));
    expect(commented.scope).toBe("active");
    expect(commented.problems).toEqual([]);
    expect(boardDeclaration(spec(`board:\n  scope: "active"\n  prefix: 'Two Words'\n`)).settings.prefix).toBe("Two Words");
  });

  test("SC-2776: no board: block is undeclared — a placement table alone opts nothing in", () => {
    expect(boardDeclaration(spec(""))).toEqual({ scope: "undeclared", settings: {}, problems: [], unknownKeys: [] });
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
    const both = boardDeclaration(spec("board-scope: deferred\nboard:\n  scope: deferred\n"));
    expect([both.scope, both.problems]).toEqual(["deferred", []]);
  });

  test("SC-2776: an unknown scope value is reported by name and opts nothing in", () => {
    const d = boardDeclaration(spec("board:\n  scope: activ\n  prefix: Engine\n"));
    expect(d.scope).toBe("invalid");
    expect(d.problems.join("\n")).toContain("`board.scope: activ` is not a value the engine knows");
    // An unpaired quote is not the value it nearly spells.
    const unpaired = boardDeclaration(spec(`board:\n  scope: "active\n  prefix: Engine\n`));
    expect(unpaired.scope).toBe("invalid");
    expect(unpaired.problems.join("\n")).toContain("not valid YAML");
  });

  test("SC-2776: an unknown key is reported by name and otherwise ignored — it never blocks", () => {
    const extra = boardDeclaration(spec("board:\n  scope: active\n  prefix: Engine\n  owner: jason\n"));
    expect(extra.scope).toBe("active");
    expect(extra.settings).toEqual({ scope: "active", prefix: "Engine" });
    expect(extra.problems).toEqual([]);
    expect(extra.unknownKeys).toEqual(["owner"]);
  });

  test("SC-2776: a typo of scope is an unknown key AND no scope, so it never opts a spec in", () => {
    const typo = boardDeclaration(spec("board:\n  scpoe: active\n  prefix: Engine\n"));
    expect(typo.scope).toBe("invalid");
    expect(typo.unknownKeys).toEqual(["scpoe"]);
    expect(typo.problems.join("\n")).toContain("declares no `scope`");
  });

  test("SC-2776: an active spec with no prefix is reported, and no prefix is invented from the filename", () => {
    const d = boardDeclaration(spec("board:\n  scope: active\n"));
    expect(d.scope).toBe("active");
    expect(d.settings.prefix).toBeUndefined();
    expect(d.problems.join("\n")).toContain("declares no `prefix`");
    expect(boardDeclaration(spec(`board:\n  scope: active\n  prefix: ""\n`)).problems.join("\n")).toContain("declares no `prefix`");
  });

  test("SC-2776: a declaration made twice, or two that disagree, is reported and never picked between", () => {
    const disagree = boardDeclaration(spec("board-scope: deferred\nboard:\n  scope: active\n  prefix: Engine\n"));
    expect(disagree.scope).toBe("invalid");
    expect(disagree.problems.join("\n")).toContain("disagree");

    // YAML keeps the last of two keys silently; the engine refuses to.
    const twice = boardDeclaration(spec("board:\n  scope: active\n  scope: deferred\n  prefix: Engine\n"));
    expect(twice.scope).toBe("invalid");
    expect(twice.problems.join("\n")).toContain("`board.scope` is declared more than once");

    // Review of #2308: the one-line form hid the same repeat, because only the
    // indented lines were scanned. A quoted key is the same key.
    for (const flow of [
      "board: { scope: deferred, prefix: Engine, scope: active }\n",
      `board: { "scope": deferred, scope: active, prefix: Engine }\n`,
    ]) {
      const repeated = boardDeclaration(spec(flow));
      expect(repeated.scope, flow).toBe("invalid");
      expect(repeated.problems.join("\n"), flow).toContain("`board.scope` is declared more than once");
    }
    // ...and a comma, colon or brace inside a quoted value or a trailing
    // comment is not a second key.
    const quoted = boardDeclaration(spec(`board: { scope: active, prefix: "A, scope: B }" }  # a } here\n`));
    expect([quoted.scope, quoted.settings.prefix, quoted.problems]).toEqual(["active", "A, scope: B }", []]);

    const legacyOther = boardDeclaration(spec("board-scope: in\n"));
    expect(legacyOther.scope).toBe("invalid");
    expect(legacyOther.problems.join("\n")).toContain("takes only `deferred`");
  });

  test("SC-2776: a board: value the engine cannot read is named, not skipped", () => {
    const scalar = boardDeclaration(spec("board: active\n"));
    expect(scalar.scope).toBe("invalid");
    expect(scalar.problems.join("\n")).toContain("must be a block of keys");
    const nested = boardDeclaration(spec("board:\n  scope: active\n  prefix:\n    deeper: x\n"));
    expect(nested.problems.join("\n")).toContain("`board.prefix` takes a single value");
    // A frontmatter the parser refuses, which DOES start a board key, cannot
    // be read as undeclared — that would be guessing it opts nothing in.
    const refused = boardDeclaration("---\ndoc-type: spec\n# a column-0 comment\nboard:\n  scope: active\n---\n");
    expect(refused.scope).toBe("invalid");
    // ...and one that starts no board key is simply undeclared.
    expect(boardDeclaration("---\ndoc-type: spec\n# a column-0 comment\n---\n").scope).toBe("undeclared");
    // Review of #2308: a block with NO closing fence is the same refusal, not
    // a silent opt-out — and with no board key in it, still undeclared.
    const unterminated = boardDeclaration("---\ndoc-type: spec\nboard:\n  scope: active\n  prefix: X\n\n# body\n");
    expect(unterminated.scope).toBe("invalid");
    expect(boardDeclaration("---\ndoc-type: spec\n\n# body, and no closing fence\n").scope).toBe("undeclared");
  });

  test("SC-2776: a key added to BOARD_KEYS is read with no other change — the table is the one place", () => {
    const keys = BOARD_KEYS as Record<string, { what: string; values?: readonly string[] }>;
    keys.queue = { what: "a setting this test adds", values: ["engine", "payload"] };
    try {
      const d = boardDeclaration(spec("board:\n  scope: active\n  prefix: Engine\n  queue: payload\n"));
      expect(d.settings.queue).toBe("payload");
      expect(d.unknownKeys).toEqual([]);
      expect(boardDeclaration(spec("board:\n  scope: active\n  prefix: Engine\n  queue: other\n")).problems.join("\n"))
        .toContain("`board.queue: other` is not a value the engine knows (engine or payload)");
    } finally {
      delete keys.queue;
    }
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
    expect(cov.specs.map((s): unknown[] => [s.path, s.board.scope, s.board.settings.prefix ?? null, s.deferred])).toEqual([
      ["specs/ON.md", "active", "On", false],
      ["specs/OFF.md", "undeclared", null, false],
      ["specs/HELD.md", "deferred", null, true],
    ]);
  });

  test("SC-2776: this tree opts in exactly the engine and payload specs, and the engine's block agrees with config", () => {
    const cov = placementCoverage(ROOT, specPathSweep, (b, p) => readFileSync(join(b, p), "utf-8"));
    expect(cov.reading).toBe("MEASURED");
    const active = cov.specs.filter(s => s.board.scope === "active").map(s => [s.path, s.board.settings.prefix]);
    expect(active).toEqual([
      ["specs/CODE-REVIEW-CONVERGENCE-SPEC.md", "Convergence"],
      ["specs/SPEC-TO-BOARD-PIPELINE-SPEC.md", "Engine"],
    ]);
    // An unknown key never blocks a reading, so THIS is where a typo in any
    // spec in the tree is reported: on the pull request that adds it.
    const reported = cov.specs
      .filter(s => s.board.problems.length > 0 || s.board.unknownKeys.length > 0)
      .map(s => `${s.path}: ${[...s.board.problems, ...s.board.unknownKeys.map(k => `unknown key ${k}`)].join("; ")}`);
    expect(reported).toEqual([]);
    const { engineSpec, milestonePrefix } = readBoardInputs(ROOT);
    expect(active as unknown[][]).toContainEqual([engineSpec, milestonePrefix]);
  });
});
