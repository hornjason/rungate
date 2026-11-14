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

import { EXPEDITE_LABEL_DEFAULT, generateOrAuditProjectHarness } from "../lib/scaffold/steps";

/** Scaffold `config` (or nothing) into a throwaway tree; hand back what was written and said. */
function scaffold(config: Record<string, unknown> | null) {
  const root = mkdtempSync(join(tmpdir(), "rg-label-keys-"));
  try {
    if (config !== null) {
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

describe("SC-2748: scaffold writes the expedite key, and names the override key as unset", () => {
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
    const { written, said } = scaffold(null);
    expect(written, "no config was created").not.toBeNull();
    expect(written.board?.expediteLabel).toBe(EXPEDITE_LABEL_DEFAULT);
    expect(written.board && "filingOverrideLabel" in written.board).toBe(false);
    expect(said).toMatch(/UNSET: board\.filingOverrideLabel/);
  });
});
