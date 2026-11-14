/**
 * Covers SC-2748 (SPEC-TO-BOARD-PIPELINE-SPEC.md), #2050.
 *
 * Two config keys fail closed when absent (#2004): `board.expediteLabel` (no
 * expedite lane) and `board.filingOverrideLabel` (no FindingArbiter waiver).
 * A consumer without them lost both features with nothing saying so.
 *
 * Jason's call, 2026-11-14: scaffold WRITES the expedite key when it is
 * missing, because the label does nothing until someone with triage access
 * applies it. It NEVER writes the override key: that is the escape hatch from
 * a safety gate whose refusal deliberately never names it, so a default would
 * hand every consumer's agents its name. It is reported as unset instead,
 * with what that switches off and the line that sets it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { readExpediteLabel } from "../lib/config-readers";
import {
  expediteLabelDefault,
  expediteLabelTemplate,
  generateOrAuditProjectHarness,
  labelKeyRepairs,
} from "../lib/scaffold/steps";

/** Read from the shipped template, never spelled here — the census in board-ready-rule.test.ts refuses a literal. */
const EXPEDITE_LABEL_DEFAULT = expediteLabelDefault();

/** Scaffold `config` (or nothing) into a throwaway tree; hand back what was written and said. */
function scaffold(config: unknown) {
  const root = mkdtempSync(join(tmpdir(), "rg-label-keys-"));
  try {
    if (config !== undefined) {
      mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
      writeFileSync(join(root, ".claude", "rungate", "config.json"), JSON.stringify(config, null, 2));
    }
    const actions: string[] = [];
    generateOrAuditProjectHarness(root, actions);
    const path = join(root, ".claude", "rungate", "config.json");
    const written = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : null;
    return { written, said: actions.join("\n") };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Scaffold a monolith `.claude/rungate.json`; hand back the directory config if one was written, and what was said. */
function scaffoldMonolith(config: unknown) {
  const root = mkdtempSync(join(tmpdir(), "rg-label-keys-mono-"));
  try {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "rungate.json"), JSON.stringify(config, null, 2));
    const actions: string[] = [];
    generateOrAuditProjectHarness(root, actions);
    const dir = join(root, ".claude", "rungate", "config.json");
    return { split: existsSync(dir) ? JSON.parse(readFileSync(dir, "utf-8")) : null, said: actions.join("\n") };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("#2050 review: every config path reaches the label keys, and names the file it read", () => {
  test("a monolith split into the directory layout gets the expedite key and the override report", () => {
    const { split, said } = scaffoldMonolith({ project: "x", roles: { engineer: { model: "opus" } } });
    expect(split, "the monolith was not split — this case is not on the split path").not.toBeNull();
    expect(split.board?.expediteLabel).toBe(EXPEDITE_LABEL_DEFAULT);
    expect(said).toMatch(/UNSET: board\.filingOverrideLabel/);
  });

  test("a monolith left in place is told about .claude/rungate.json, never the directory file", () => {
    const { split, said } = scaffoldMonolith({ project: "x" });
    expect(split, "this case is meant to stay a monolith").toBeNull();
    expect(said).toMatch(/UNSET: board\.expediteLabel/);
    expect(said).toMatch(/UNSET: board\.filingOverrideLabel/);
    expect(said, "a monolith consumer was pointed at a file they do not have").not.toContain(".claude/rungate/config.json");
    expect(said).toContain(".claude/rungate.json");
  });

  test("a monolith whose board is not an object is refused naming .claude/rungate.json", () => {
    const { said } = scaffoldMonolith({ project: "x", board: "work-board" });
    expect(said).toMatch(/REFUSED: board\.expediteLabel .*\.claude\/rungate\.json/);
    expect(said).not.toContain(".claude/rungate/config.json");
  });
});

describe("SC-2748: scaffold writes the expedite key, and names the override key as unset", () => {
  test("the shipped default is the name this repository runs on", () => {
    // Premise for every case below: a null here would make each `toBe` compare
    // against null, and a config that never gained the key would pass.
    expect(EXPEDITE_LABEL_DEFAULT, "templates/board-defaults.json gave no expedite label").not.toBeNull();
    expect(EXPEDITE_LABEL_DEFAULT).toBe(readExpediteLabel(join(import.meta.dir, "..")));
  });

  test("an installation missing the template writes nothing and names the expedite key as unset", () => {
    const missing = join(tmpdir(), "rg-no-such-template.json");
    expect(expediteLabelDefault(missing)).toBeNull();
    const { config, changed, lines } = labelKeyRepairs({ project: "x", board: {} }, { template: expediteLabelTemplate(missing) });
    expect(changed).toBe(false);
    expect("expediteLabel" in config.board, "a blank or null label was written").toBe(false);
    expect(lines.join("\n"), "the missing template was not named").toMatch(
      /UNSET: board\.expediteLabel — .*templates\/board-defaults\.json/,
    );
  });

  test("a config lacking both: the expedite key is written, the override key is reported and never written", () => {
    const { written, said } = scaffold({ project: "x", board: { queueLabel: "work" } });
    expect(written.board.expediteLabel).toBe(EXPEDITE_LABEL_DEFAULT);
    expect(written.board.queueLabel, "a key scaffold does not own was lost").toBe("work");
    expect("filingOverrideLabel" in written.board, "the waiver label was written as a default").toBe(false);
    expect(said).toMatch(/board\.expediteLabel/);
    expect(said, "the unset override key was not named").toMatch(/UNSET: board\.filingOverrideLabel/);
    expect(said, "the report does not say how to set it").toContain('"filingOverrideLabel"');
  });

  test("a config with no board block at all gets one carrying only the expedite key", () => {
    const { written, said } = scaffold({ project: "x" });
    expect(written.board).toEqual({ expediteLabel: EXPEDITE_LABEL_DEFAULT });
    expect(said).toMatch(/UNSET: board\.filingOverrideLabel/);
  });

  test("keys a consumer set are kept as they are, and nothing about them is reported", () => {
    const { written, said } = scaffold({
      project: "x",
      board: { expediteLabel: "hot", filingOverrideLabel: "waive-it" },
    });
    expect(written.board).toEqual({ expediteLabel: "hot", filingOverrideLabel: "waive-it" });
    expect(said).not.toMatch(/board\.expediteLabel|board\.filingOverrideLabel/);
  });

  test("a blank expedite key is absent, not set", () => {
    const { written } = scaffold({ project: "x", board: { expediteLabel: "  " } });
    expect(written.board.expediteLabel).toBe(EXPEDITE_LABEL_DEFAULT);
  });

  test("a new project's config carries the expedite key and reports the override key unset", () => {
    const { written, said } = scaffold(undefined);
    expect(written, "no config was created").not.toBeNull();
    expect(written.board?.expediteLabel).toBe(EXPEDITE_LABEL_DEFAULT);
    expect(written.board && "filingOverrideLabel" in written.board).toBe(false);
    expect(said).toMatch(/UNSET: board\.filingOverrideLabel/);
  });
});

describe("#2156: input edge cases are refused or reported by name, never crashed on or misreported", () => {
  for (const [what, value] of [["null", null], ["a number", 7], ["an array", []]] as const) {
    test(`a directory config.json of ${what} is refused naming the file, and the run completes`, () => {
      const { said } = scaffold(value);
      expect(said).toMatch(/REFUSED: \.claude\/rungate\/config\.json is valid JSON but not an object/);
    });
    test(`a monolith of ${what} is refused naming .claude/rungate.json, and the run completes`, () => {
      const { said } = scaffoldMonolith(value);
      expect(said).toMatch(/REFUSED: \.claude\/rungate\.json is valid JSON but not an object/);
    });
  }

  test("labelKeyRepairs refuses a non-object config by name rather than throwing", () => {
    const { changed, lines } = labelKeyRepairs(null as never, { file: "cfg.json" });
    expect(changed).toBe(false);
    expect(lines.join("\n")).toMatch(/REFUSED: board\.expediteLabel .*cfg\.json is not a JSON object/);
  });

  test("a template with no usable expediteLabel says so, never that it is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-label-template-"));
    try {
      const cases: [string, string, RegExp][] = [
        ["blank", '{"expediteLabel": ""}', /carries no expediteLabel \(blank\)/],
        ["absent", "{}", /carries no expediteLabel \(absent\)/],
        ["not a string", '{"expediteLabel": 3}', /carries no expediteLabel \(not a string\)/],
        ["unparseable", "{", /could not be parsed/],
      ];
      for (const [name, body, why] of cases) {
        const path = join(dir, `${name.replace(/ /g, "-")}.json`);
        writeFileSync(path, body);
        const reading = expediteLabelTemplate(path);
        expect(reading.label, `${name}: a label was read`).toBeNull();
        const said = labelKeyRepairs({ board: {} }, { template: reading }).lines.join("\n");
        expect(said, `${name}: wrong reason`).toMatch(why);
        expect(said, `${name}: reported as missing`).not.toMatch(/missing/);
      }
      expect(expediteLabelTemplate(join(dir, "nope.json"))).toEqual({
        label: null,
        why: expect.stringContaining("is missing"),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
