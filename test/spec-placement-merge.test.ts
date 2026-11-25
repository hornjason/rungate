/**
 * Covers SC-2809 (SPEC-TO-BOARD-PIPELINE-SPEC.md; ADR-026 row 4).
 *
 * Why placement moved beneath each criterion: two branches that each add a
 * criterion to the same phase both edited the one table row, so every such
 * pair conflicted. With a `placement:` line beside each criterion, the two
 * additions touch different sections and merge cleanly. Both halves are run
 * here through `git merge-file`, never described, and both engine specs are
 * read to show that neither still lists criteria in a table.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parsePlacementTable, placementLines, placementReading, placementsById } from "../lib/spec-placement";

const REPO = join(import.meta.dir, "..");
const ENGINE_SPECS = ["SPEC-TO-BOARD-PIPELINE-SPEC.md", "CODE-REVIEW-CONVERGENCE-SPEC.md"];

/** A three-way merge of one file: the merged text and how many conflicts git counted. */
function mergeFile(base: string, ours: string, theirs: string): { conflicts: number; text: string } {
  const dir = mkdtempSync(join(tmpdir(), "rg-placement-merge-"));
  try {
    writeFileSync(join(dir, "base.md"), base);
    writeFileSync(join(dir, "ours.md"), ours);
    writeFileSync(join(dir, "theirs.md"), theirs);
    const r = spawnSync("git", ["merge-file", "-p", "ours.md", "base.md", "theirs.md"], { cwd: dir, encoding: "utf-8" });
    // git merge-file exits with the number of conflicts, and negative on an error.
    if (r.status === null || r.status < 0 || r.status > 127) throw new Error(`git merge-file failed: ${r.stderr}`);
    return { conflicts: r.status, text: r.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const doc = (sections: string[]): string => ["---", "doc-type: spec", "---", "", "# Planted", "", ...sections, ""].join("\n");

describe("SC-2809: both engine specs place criteria beneath them, and two same-phase additions merge cleanly", () => {
  test("neither engine spec lists a criterion in a placement table, and each places its criteria in lines", () => {
    for (const name of ENGINE_SPECS) {
      const text = readFileSync(join(REPO, "specs", name), "utf-8");
      expect(parsePlacementTable(text).flatMap(r => r.ids), name).toEqual([]);
      expect(placementLines(text).length, name).toBeGreaterThan(0);
      expect(placementReading(text).unmeasuredReasons, name).toEqual([]);
    }
  });

  const A = (extra: string[]) => ["## Section A", "", "- [ ] CRC-A1: one", "      placement: Phase 1", ...extra, ""];
  const B = (extra: string[]) => ["## Section B", "", "- [ ] CRC-B1: two", "      placement: Phase 1", ...extra, ""];
  const MEANINGS = ["### What each placement means", "", "| Placement | What the value means |", "|---|---|", "| **Phase 1** | first |"];

  test("placement lines: one branch adds a Phase 1 criterion in section A, the other in section B, and git merges them with no conflict", () => {
    const base = doc([...A([]), ...B([]), ...MEANINGS]);
    const ours = doc([...A(["- [ ] CRC-A2: added on one branch", "      placement: Phase 1"]), ...B([]), ...MEANINGS]);
    const theirs = doc([...A([]), ...B(["- [ ] CRC-B2: added on the other", "      placement: Phase 1"]), ...MEANINGS]);
    const m = mergeFile(base, ours, theirs);
    expect(m.conflicts).toBe(0);
    expect(placementsById(m.text).get("CRC-A2")).toBe("Phase 1");
    expect(placementsById(m.text).get("CRC-B2")).toBe("Phase 1");
    expect(placementReading(m.text).reading).toBe("MEASURED");
  });

  test("the same two additions in the table form both edit the Phase 1 row, and git reports a conflict", () => {
    const sectionA = (extra: string[]) => ["## Section A", "", "- [ ] CRC-A1: one", ...extra, ""];
    const sectionB = (extra: string[]) => ["## Section B", "", "- [ ] CRC-B1: two", ...extra, ""];
    const table = (ids: string) => ["### Phase placement", "", "| Placement | Criteria | What the value means |", "|---|---|---|", `| **Phase 1** | ${ids} | first |`];
    const base = doc([...sectionA([]), ...sectionB([]), ...table("CRC-A1, CRC-B1")]);
    const ours = doc([...sectionA(["- [ ] CRC-A2: added on one branch"]), ...sectionB([]), ...table("CRC-A1, CRC-B1, CRC-A2")]);
    const theirs = doc([...sectionA([]), ...sectionB(["- [ ] CRC-B2: added on the other"]), ...table("CRC-A1, CRC-B1, CRC-B2")]);
    const m = mergeFile(base, ours, theirs);
    expect(m.conflicts).toBe(1);
    expect(m.text).toContain("<<<<<<<");
  });
});
