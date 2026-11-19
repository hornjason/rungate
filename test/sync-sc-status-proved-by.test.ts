/**
 * #2487: a tick writes the proof line `audit-spec-evidence` reads.
 *
 * `sync-sc-status` used to flip `- [ ]` to `- [x]` and nothing else, so on a
 * spec that records evidence every tick left `audit-spec-evidence` red until
 * somebody hand-wrote `proved-by:`. Our first consumer did that on every tick
 * (2026-11-19, a dated record). The tick already knows which passing test
 * claimed the id, because that is how it decided to tick, so it now writes
 * the line itself: `proved-by: test/<file> "<title>"` when the claim sits in a
 * test title, or `proved-by: test/<file>` when it sits in a declaring comment.
 *
 * Fixture ids are in the 9800s, outside every live spec.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { criterionFingerprint, evidenceViolations, parseCriteria } from "../lib/spec-evidence";
import { flipCheckboxes, proofsFor, testTitleAt, withProofLine } from "../scripts/sync-sc-status";

const ROOT = join(import.meta.dir, "..");
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "sync-proved-by-"));
  made.push(d);
  return d;
}

const SPEC = `---
doc-type: spec
testable: true
---
# Fixture

- [ ] SC-9861: the first thing is true
      needs: test
- [ ] SC-9862: the second thing is true
- [ ] SC-9863: the third thing is true
      needs: test
      proved-by: test/already.test.ts "kept as written"
- [ ] SC-9864: the fourth thing is waived
      needs: test
      waived-reason: not this quarter
      waived-by: jason
      waived-until: 2027-01-01
`;

function specDir(): string {
  const d = scratch();
  writeFileSync(join(d, "FIXTURE-SPEC.md"), SPEC);
  return d;
}
const provedBy = (content: string, id: string) => parseCriteria(content).find(c => c.id === id)?.provedBy ?? null;

describe("#2487: withProofLine", () => {
  test("a ticked criterion with no proof line gets one, read back by the audit's own parser", () => {
    const ticked = SPEC.replace("- [ ] SC-9861:", "- [x] SC-9861:");
    const r = withProofLine(ticked, "SC-9861", 'test/a.test.ts "SC-9861: the first thing"');
    expect(r.wrote).toBe(true);
    expect(provedBy(r.content, "SC-9861")).toBe('test/a.test.ts "SC-9861: the first thing"');
    // Under its own needs: line, at the block's indent, before the next bullet.
    expect(r.content).toContain(
      '- [x] SC-9861: the first thing is true\n      needs: test\n      proved-by: test/a.test.ts "SC-9861: the first thing"\n- [ ] SC-9862:',
    );
  });

  test("a criterion with no annotation block gets the line straight under its bullet, at six spaces", () => {
    const ticked = SPEC.replace("- [ ] SC-9862:", "- [x] SC-9862:");
    const r = withProofLine(ticked, "SC-9862", "test/b.test.ts");
    expect(r.wrote).toBe(true);
    expect(r.content).toContain("- [x] SC-9862: the second thing is true\n      proved-by: test/b.test.ts\n- [ ] SC-9863:");
    expect(provedBy(r.content, "SC-9862")).toBe("test/b.test.ts");
  });

  test("an existing proof line is kept, not overwritten and not doubled", () => {
    const ticked = SPEC.replace("- [ ] SC-9863:", "- [x] SC-9863:");
    const r = withProofLine(ticked, "SC-9863", "test/c.test.ts");
    expect(r.wrote).toBe(false);
    expect(r.content).toBe(ticked);
    expect(provedBy(r.content, "SC-9863")).toBe('test/already.test.ts "kept as written"');
  });

  test("a waived criterion gets no proof line: a waiver replaces proved-by", () => {
    const ticked = SPEC.replace("- [ ] SC-9864:", "- [x] SC-9864:");
    const r = withProofLine(ticked, "SC-9864", "test/d.test.ts");
    expect(r.wrote).toBe(false);
    expect(r.content).toBe(ticked);
  });

  // Review of #2492: audit-specs --fix writes an unindented REVIEW marker
  // under a bullet, and parseCriteria reads past it.
  test("a REVIEW marker under the bullet does not hide an existing proof line", () => {
    const spec = "- [x] SC-9870: marked\n<!-- REVIEW: unmatched -->\n      needs: test\n      proved-by: test/old.test.ts\n";
    const r = withProofLine(spec, "SC-9870", "test/new.test.ts");
    expect(r.wrote).toBe(false);
    expect(r.content).toBe(spec);
  });

  test("a REVIEW marker under the bullet: a new proof goes after the block, where parseCriteria reads it", () => {
    const spec = "- [x] SC-9871: marked\n<!-- REVIEW: unmatched -->\n      needs: test\n\n";
    const r = withProofLine(spec, "SC-9871", "test/new.test.ts");
    expect(r.wrote).toBe(true);
    expect(provedBy(r.content, "SC-9871")).toBe("test/new.test.ts");
  });

  test("an unticked criterion is not given a proof line", () => {
    const r = withProofLine(SPEC, "SC-9861", "test/a.test.ts");
    expect(r.wrote).toBe(false);
    expect(r.content).toBe(SPEC);
  });
});

describe("#2487: flipCheckboxes writes the proof beside the tick", () => {
  test("the tick and its proof land in one write", () => {
    const dir = specDir();
    const n = flipCheckboxes("FIXTURE-SPEC.md", ["SC-9861", "SC-9862"], dir, false, new Map([
      ["SC-9861", 'test/a.test.ts "SC-9861: the first thing"'],
      ["SC-9862", "test/b.test.ts"],
    ]));
    expect(n).toBe(2);
    const after = readFileSync(join(dir, "FIXTURE-SPEC.md"), "utf8");
    expect(provedBy(after, "SC-9861")).toBe('test/a.test.ts "SC-9861: the first thing"');
    expect(provedBy(after, "SC-9862")).toBe("test/b.test.ts");
  });

  test("--dry-run writes nothing and says which proof line it would write", () => {
    const dir = specDir();
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const n = flipCheckboxes("FIXTURE-SPEC.md", ["SC-9861"], dir, true, new Map([["SC-9861", "test/a.test.ts"]]));
      expect(n).toBe(1);
      const said = log.mock.calls.map(c => String(c[0])).join("\n");
      expect(said).toContain("SC-9861: would write proved-by: test/a.test.ts");
    } finally {
      log.mockRestore();
    }
    expect(readFileSync(join(dir, "FIXTURE-SPEC.md"), "utf8")).toBe(SPEC);
  });

  test("with no proofs given, the flip is exactly what it was", () => {
    const dir = specDir();
    flipCheckboxes("FIXTURE-SPEC.md", ["SC-9862"], dir, false);
    expect(readFileSync(join(dir, "FIXTURE-SPEC.md"), "utf8")).toBe(SPEC.replace("- [ ] SC-9862:", "- [x] SC-9862:"));
  });
});

/**
 * #2508: in a spec that declares `evidence: required`, a ticked criterion
 * also needs `fingerprint:`, or `test/spec-evidence.test.ts` refuses it.
 * The tick wrote `proved-by:` and stopped, so every tick in a bound spec was
 * red until somebody ran `audit-spec-evidence --record-fingerprints` too.
 */
describe("#2508: a tick in a spec that declares evidence also writes its fingerprint", () => {
  const BOUND = SPEC.replace("testable: true\n", "testable: true\nevidence: required\n");
  const boundDir = () => {
    const d = scratch();
    writeFileSync(join(d, "FIXTURE-SPEC.md"), BOUND);
    return d;
  };
  const criterion = (content: string, id: string) => parseCriteria(content).find(c => c.id === id)!;

  test("the tick gains both lines, and the audit's own checker has nothing left to refuse", () => {
    const dir = boundDir();
    flipCheckboxes("FIXTURE-SPEC.md", ["SC-9861", "SC-9862"], dir, false, new Map([
      ["SC-9861", 'test/a.test.ts "SC-9861: the first thing"'],
      ["SC-9862", "test/b.test.ts"],
    ]));
    const after = readFileSync(join(dir, "FIXTURE-SPEC.md"), "utf8");
    for (const id of ["SC-9861", "SC-9862"]) {
      const c = criterion(after, id);
      expect(c.recordedFingerprint, id).toBe(criterionFingerprint(c.text));
    }
    // The checker CI runs. SC-9861's block is complete, so nothing about it is
    // refused; SC-9862's fixture lacks a `needs:` line, which is not this
    // change's to write, so for it only the proof and fingerprint codes count.
    const violations = evidenceViolations(after, "2026-11-19");
    expect(violations.filter(v => v.id === "SC-9861")).toEqual([]);
    const evidenceCodes = ["FINGERPRINT_MISSING", "TICKED_WITHOUT_EVIDENCE", "EVIDENCE_BLANK", "EVIDENCE_STALE"];
    expect(violations.filter(v => v.id === "SC-9862" && evidenceCodes.includes(v.code))).toEqual([]);
  });

  test("a spec that does not declare evidence gets proved-by only, as before", () => {
    const dir = specDir();
    flipCheckboxes("FIXTURE-SPEC.md", ["SC-9861"], dir, false, new Map([["SC-9861", "test/a.test.ts"]]));
    const after = readFileSync(join(dir, "FIXTURE-SPEC.md"), "utf8");
    expect(criterion(after, "SC-9861").provedBy).toBe("test/a.test.ts");
    expect(criterion(after, "SC-9861").recordedFingerprint).toBeNull();
    expect(after).not.toContain("fingerprint:");
  });

  test("a criterion that already has its proof gets no fingerprint from the tick: recording one is the audit's call", () => {
    const dir = boundDir();
    flipCheckboxes("FIXTURE-SPEC.md", ["SC-9863"], dir, false, new Map([["SC-9863", "test/c.test.ts"]]));
    const after = readFileSync(join(dir, "FIXTURE-SPEC.md"), "utf8");
    expect(criterion(after, "SC-9863").recordedFingerprint).toBeNull();
  });

  test("--dry-run says which fingerprint it would write, and writes nothing", () => {
    const dir = boundDir();
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      flipCheckboxes("FIXTURE-SPEC.md", ["SC-9861"], dir, true, new Map([["SC-9861", "test/a.test.ts"]]));
      const said = log.mock.calls.map(c => String(c[0])).join("\n");
      expect(said).toContain(`SC-9861: would write fingerprint: ${criterionFingerprint("the first thing is true")}`);
    } finally {
      log.mockRestore();
    }
    expect(readFileSync(join(dir, "FIXTURE-SPEC.md"), "utf8")).toBe(BOUND);
  });
});

describe("#2487: the proof names the claiming test", () => {
  const SRC = [
    'import { test } from "bun:test";',
    "/**",
    " * Covers SC-9866.",
    " */",
    'test("SC-9865: the title names it", () => {});',
    "test('SC-9867 in single quotes', () => {});",
    "",
  ].join("\n");

  test("testTitleAt reads the title around a claim inside it, and nothing for a comment", () => {
    expect(testTitleAt(SRC, SRC.indexOf("SC-9865"))).toBe("SC-9865: the title names it");
    expect(testTitleAt(SRC, SRC.indexOf("SC-9867"))).toBe("SC-9867 in single quotes");
    expect(testTitleAt(SRC, SRC.indexOf("SC-9866"))).toBeUndefined();
  });

  // Review of #2492: one id declared by two specs, claimed by two titles.
  test("an id two specs declare, claimed by one title per spec, cites each spec's own title", () => {
    const dir = scratch();
    writeFileSync(
      join(dir, "dual.test.ts"),
      'import { test } from "bun:test";\ntest("SC-9872 for ALPHA-SPEC", () => {});\ntest("SC-9872 for BRAVO-SPEC", () => {});\n',
    );
    const map = new Map([
      ["dual.test.ts", [
        { id: "SC-9872", specFile: "ALPHA-SPEC.md" },
        { id: "SC-9872", specFile: "BRAVO-SPEC.md" },
      ]],
    ]);
    const proofs = proofsFor(map, new Set(["ALPHA-SPEC.md::SC-9872", "BRAVO-SPEC.md::SC-9872"]), dir);
    expect(proofs.get("ALPHA-SPEC.md::SC-9872")).toBe('test/dual.test.ts "SC-9872 for ALPHA-SPEC"');
    expect(proofs.get("BRAVO-SPEC.md::SC-9872")).toBe('test/dual.test.ts "SC-9872 for BRAVO-SPEC"');
  });

  test("proofsFor names file and title for a title claim, the file alone for a comment claim, and only passing files", () => {
    const dir = scratch();
    writeFileSync(join(dir, "claims.test.ts"), SRC);
    writeFileSync(join(dir, "red.test.ts"), 'import { test } from "bun:test";\ntest("SC-9868: red", () => {});\n');
    const map = new Map([
      ["claims.test.ts", [
        { id: "SC-9865", specFile: "FIXTURE-SPEC.md" },
        { id: "SC-9866", specFile: "FIXTURE-SPEC.md" },
      ]],
      ["red.test.ts", [{ id: "SC-9868", specFile: "FIXTURE-SPEC.md" }]],
    ]);
    const passing = new Set(["FIXTURE-SPEC.md::SC-9865", "FIXTURE-SPEC.md::SC-9866"]);
    const proofs = proofsFor(map, passing, dir);
    expect(proofs.get("FIXTURE-SPEC.md::SC-9865")).toBe('test/claims.test.ts "SC-9865: the title names it"');
    expect(proofs.get("FIXTURE-SPEC.md::SC-9866")).toBe("test/claims.test.ts");
    expect(proofs.has("FIXTURE-SPEC.md::SC-9868")).toBe(false);
  });
});

describe("#2487: end to end, the consumer's case", () => {
  test("sync-sc-status --only ticks and writes the proof, and audit-spec-evidence then passes with no hand edit", () => {
    const root = scratch();
    mkdirSync(join(root, "specs"));
    mkdirSync(join(root, "test"));
    writeFileSync(
      join(root, "specs/FIXTURE-SPEC.md"),
      "---\ndoc-type: spec\ntestable: true\nevidence: required\n---\n# Fixture\n\n" +
        "## Success Criteria\n\n- [ ] SC-9869: the claimed thing is true\n      needs: test\n",
    );
    writeFileSync(
      join(root, "test/claimed.test.ts"),
      'import { test, expect } from "bun:test";\ntest("SC-9869: the claimed thing is true", () => { expect(1).toBe(1); });\n',
    );
    const run = (script: string, args: string[]) =>
      spawnSync(process.execPath, [join(ROOT, script), ...args], { cwd: root, encoding: "utf8" });

    const sync = run("scripts/sync-sc-status.ts", ["--project-root", root, "--only", "SC-9869"]);
    expect(sync.status, sync.stdout + sync.stderr).toBe(0);
    const spec = readFileSync(join(root, "specs/FIXTURE-SPEC.md"), "utf8");
    expect(spec).toContain("- [x] SC-9869:");
    expect(provedBy(spec, "SC-9869")).toBe('test/claimed.test.ts "SC-9869: the claimed thing is true"');

    // A spec that records evidence also binds it to the wording; that line is
    // written by the tool that has always written it.
    const record = run("scripts/audit-spec-evidence.ts", ["--project-root", root, "--record-fingerprints"]);
    const audit = run("scripts/audit-spec-evidence.ts", ["--project-root", root]);
    expect(audit.status, record.stdout + record.stderr + audit.stdout + audit.stderr).toBe(0);
  });
});
