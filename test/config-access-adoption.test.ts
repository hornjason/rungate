/**
 * ADR-001 D1, the adoption half (#214).
 *
 * Covers SC-1449, SC-1450, SC-1451, SC-1452 (CONFIG-DIRECTORY-STRUCTURE-SPEC.md).
 *
 * #309 built the two conformity checks ADR-001 specified and never got, with a
 * known-violations ratchet banking the 61 sites that existed on the day. A
 * ratchet is only worth having if someone lowers it; this file is the evidence
 * for the first decrement, and the shape of the evidence is the point.
 *
 * ## Why these are behavioural and not "the file imports the loader"
 *
 * ADR-001 diagnosed its own failure precisely:
 *
 *   > SC-478 and SC-479 are both existence assertions over source text. A
 *   > loader that is written correctly and called by nothing satisfies them
 *   > perfectly. The spec verified that the solution was authored; it never
 *   > verified that it was adopted.
 *
 * So every case below runs the migrated function against a project root on the
 * DIRECTORY layout and asserts it returns the configured value. That assertion
 * is false on `main`: all six sites read `.claude/rungate.json` and nothing
 * else, so a directory-layout consumer got `{}`, `"project"` and the built-in
 * defaults from them — silently, with no error and no warning. A re-import of
 * the old reader would turn every one of these red.
 *
 * ## The control
 *
 * A fixture that only proves "directory works" is satisfied by a reader that
 * ignores the monolith, which would be a new bug wearing the fix's clothes.
 * Each accessor is therefore run against BOTH layouts over the same authored
 * values, and the two results are compared to each other rather than to a
 * literal.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { enginePrefixReading, loadRoleConfig, readBoardConfig, readBoardInputs, readProjectSlug, readRemoteHosts } from "../lib/config-readers";
import { loadRegistry } from "../lib/create-sc";
import { loadValidRoles, loadRoleBriefPaths } from "../scripts/grade-deterministic";
import { getProjectSlug } from "../scripts/parallel-ship";

// ── fixtures ────────────────────────────────────────────────────────────────

/** The authored values every case below reads back. Shared so the two layouts
 *  cannot drift apart and quietly make the parity assertion vacuous. */
const AUTHORED = {
  project: "adoption-fixture",
  roles: {
    marcus: { brief: "prompts/marcus.md", standardTask: "implement" },
    quinn: { brief: "prompts/quinn.md", standardTask: "verify" },
  },
  remoteHosts: { db: { host: "db.invalid", preFlightCmd: "true" } },
  board: { owner: "someone", number: 3, id: "PVT_fixture", fields: { Criteria: "PVTF_fixture" } },
  customMatchers: [{ name: "adoption-only-matcher", description: "fixture", kind: "contains" }],
};

const scratch: string[] = [];

function makeRoot(layout: "directory" | "monolith" | "neither" | "malformed"): string {
  const root = mkdtempSync(join(tmpdir(), "rungate-214-"));
  scratch.push(root);
  const claude = join(root, ".claude");
  mkdirSync(claude, { recursive: true });

  if (layout === "neither") return root;

  if (layout === "malformed") {
    mkdirSync(join(claude, "rungate"), { recursive: true });
    writeFileSync(join(claude, "rungate", "config.json"), "{ this is not json");
    return root;
  }

  const { roles, ...rest } = AUTHORED;
  if (layout === "monolith") {
    writeFileSync(join(claude, "rungate.json"), JSON.stringify({ ...rest, roles }, null, 2));
    return root;
  }

  // Directory layout: roles live in their own file, which is the merge the
  // monolith readers never performed.
  const dir = join(claude, "rungate");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(rest, null, 2));
  writeFileSync(join(dir, "roles.json"), JSON.stringify(roles, null, 2));
  return root;
}

function cleanup() {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
}

// ── SC-1449 ─────────────────────────────────────────────────────────────────

describe("SC-1449: the accessors read the directory layout, which is what the old readers could not", () => {
  test("roles resolve from roles.json, not only from the monolith", () => {
    const dir = makeRoot("directory");
    const mono = makeRoot("monolith");
    try {
      const fromDir = loadRoleConfig(dir);
      expect(Object.keys(fromDir).sort()).toEqual(["marcus", "quinn"]);
      expect(fromDir.marcus?.brief).toBe("prompts/marcus.md");
      // Parity, not a literal: a reader that handled only the directory form
      // would pass the assertion above and be a new instance of the same bug.
      expect(fromDir).toEqual(loadRoleConfig(mono));
    } finally {
      cleanup();
    }
  });

  test("the slug resolves from both layouts, and absence is null rather than a shared literal", () => {
    const dir = makeRoot("directory");
    const mono = makeRoot("monolith");
    const none = makeRoot("neither");
    try {
      expect(readProjectSlug(dir)).toBe(AUTHORED.project);
      expect(readProjectSlug(mono)).toBe(AUTHORED.project);
      // Null, not "project": two unconfigured repos sharing one default would
      // name the same worktree directory and collide.
      expect(readProjectSlug(none)).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("remoteHosts survives the schema, which does not declare it", () => {
    const dir = makeRoot("directory");
    const mono = makeRoot("monolith");
    try {
      // `.passthrough()` is the whole reason this works. If the resolved
      // schema ever stops passing unknown keys through, pre-flight silently
      // stops running and nothing else notices.
      expect(readRemoteHosts(dir)).toEqual(AUTHORED.remoteHosts);
      expect(readRemoteHosts(dir)).toEqual(readRemoteHosts(mono));
    } finally {
      cleanup();
    }
  });

  test("the board resolves from both layouts, and a HALF-configured one is null — B4", () => {
    const dir = makeRoot("directory");
    const mono = makeRoot("monolith");
    const none = makeRoot("neither");
    try {
      expect(readBoardConfig(dir)).toEqual({ projectId: "PVT_fixture", criteriaFieldId: "PVTF_fixture" });
      expect(readBoardConfig(dir)).toEqual(readBoardConfig(mono));
      expect(readBoardConfig(none), "a project with no config has no board").toBeNull();
    } finally {
      cleanup();
    }
  });

  test("every half-written board is null, not a half-filled object — B4", () => {
    // `board-snapshot` reads a column with a project id AND a field id.
    // Handing it one of the two makes it decide for itself what to do about
    // the other, which is a second decider in every caller. Written as a
    // table because the shape that will be added next is the one a single
    // hand-picked case cannot see.
    const rows: { why: string; board: unknown }[] = [
      { why: "no board key at all", board: undefined },
      { why: "an empty object", board: {} },
      { why: "an array, not a block", board: [] },
      { why: "a project id and no fields", board: { id: "PVT_x" } },
      { why: "fields with no Criteria", board: { id: "PVT_x", fields: { Status: "PVTSSF_x" } } },
      { why: "a Criteria id and no project id", board: { fields: { Criteria: "PVTF_x" } } },
      { why: "a blank project id", board: { id: "   ", fields: { Criteria: "PVTF_x" } } },
      { why: "a blank Criteria id", board: { id: "PVT_x", fields: { Criteria: "  " } } },
      { why: "fields as a string", board: { id: "PVT_x", fields: "Criteria" } },
      { why: "a numeric Criteria id", board: { id: "PVT_x", fields: { Criteria: 7 } } },
    ];
    const root = mkdtempSync(join(tmpdir(), "rungate-board-"));
    scratch.push(root);
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    const at = join(root, ".claude", "rungate", "config.json");
    try {
      for (const row of rows) {
        writeFileSync(at, JSON.stringify(row.board === undefined ? {} : { board: row.board }));
        expect(readBoardConfig(root), `${row.why} produced a board`).toBeNull();
      }
      // The control: the same file with BOTH identifiers reads, so the ten
      // rows above are not passing against a reader that returns null for
      // everything.
      writeFileSync(at, JSON.stringify({ board: { id: "PVT_x", fields: { Criteria: "PVTF_x" } } }));
      expect(readBoardConfig(root)).toEqual({ projectId: "PVT_x", criteriaFieldId: "PVTF_x" });
    } finally {
      cleanup();
    }
  });

  /**
   * Covers SC-2619 (SPEC-TO-BOARD-PIPELINE-SPEC.md) — #1718.
   *
   * `board.engineSpec` and `board.milestonePrefix` are what let
   * `board-conformance` take its own reading instead of reporting five
   * UNMEASURED rows blaming itself for an argument nobody passed.
   *
   * **Each key is independent**, unlike the B4 pair above: a project may
   * configure a prefix and pass the spec, or the other way round, and
   * collapsing one absent key into both would refuse a half-configured
   * tree that has everything it needs on the command line.
   */
  test("engineSpec and milestonePrefix read independently, and absent is null per key — #1718", () => {
    const rows: { why: string; board: unknown; want: { engineSpec: string | null; milestonePrefix: string | null } }[] =
      [
        { why: "no board key at all", board: undefined, want: { engineSpec: null, milestonePrefix: null } },
        { why: "an empty board", board: {}, want: { engineSpec: null, milestonePrefix: null } },
        { why: "an array, not a block", board: [], want: { engineSpec: null, milestonePrefix: null } },
        {
          why: "a spec and no prefix",
          board: { engineSpec: "specs/X.md" },
          want: { engineSpec: "specs/X.md", milestonePrefix: null },
        },
        {
          why: "a prefix and no spec",
          board: { milestonePrefix: "Pipeline" },
          want: { engineSpec: null, milestonePrefix: "Pipeline" },
        },
        {
          why: "blank is absent, not a value — a blank prefix matches no milestone",
          board: { engineSpec: "   ", milestonePrefix: "" },
          want: { engineSpec: null, milestonePrefix: null },
        },
        {
          why: "a non-string is absent too",
          board: { engineSpec: 7, milestonePrefix: ["Pipeline"] },
          want: { engineSpec: null, milestonePrefix: null },
        },
        {
          why: "whitespace around a real value is trimmed, not refused",
          board: { engineSpec: " specs/X.md ", milestonePrefix: " Pipeline " },
          want: { engineSpec: "specs/X.md", milestonePrefix: "Pipeline" },
        },
      ];
    const root = mkdtempSync(join(tmpdir(), "rungate-board-inputs-"));
    scratch.push(root);
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    const at = join(root, ".claude", "rungate", "config.json");
    try {
      for (const row of rows) {
        writeFileSync(at, JSON.stringify(row.board === undefined ? {} : { board: row.board }));
        expect(readBoardInputs(root), row.why).toEqual(row.want);
      }
    } finally {
      cleanup();
    }
  });

  /**
   * #1965 round 2: two `null`s that mean different things.
   *
   * `readBoardInputs` returns `{milestonePrefix: null}` both for a tree that
   * declares no engine family and for a root with no rungate config at all.
   * `scripts/work-status.ts` and `scripts/board-ready.ts` pass
   * `process.cwd()`, and a `null` prefix means *order by phase alone* — the
   * pre-#1943 behaviour. So a run from the wrong directory silently reports
   * the payload above the engine, which is the bug #1943 exists to remove,
   * with nothing saying the config was never found.
   *
   * Breaking it: delete the `resolveConfig` line and the UNCONFIGURED row
   * goes red, while the DECLARED-NONE row stays green — which is the point.
   * A reading that warned on both would be noise on every tree that has no
   * engine family, and a reading that warned on neither is what shipped.
   */
  test("#1965: an absent config is UNMEASURED, and a config that declares none is not", () => {
    const root = mkdtempSync(join(tmpdir(), "rungate-engine-prefix-"));
    scratch.push(root);
    try {
      // No config anywhere under this root.
      const absent = enginePrefixReading(root);
      expect(absent.prefix, "nothing to read").toBeNull();
      expect(absent.unmeasured, "an unreadable root reported as an ordinary null").not.toBeNull();
      expect(
        absent.unmeasured,
        "the warning must name the directory — the whole failure is that it was the " +
          "wrong one, so a message without it is unactionable",
      ).toContain(root);

      // A config that is present and declares no engine family. A real
      // reading, not a failure to read.
      mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
      const at = join(root, ".claude", "rungate", "config.json");
      writeFileSync(at, JSON.stringify({ project: "x", board: {} }));
      const declaredNone = enginePrefixReading(root);
      expect(declaredNone.prefix, "still no prefix").toBeNull();
      expect(
        declaredNone.unmeasured,
        "a tree that declares one family is not unmeasured, and warning here would make " +
          "the warning noise on every such tree",
      ).toBeNull();

      // And a configured prefix is returned unchanged, with no warning.
      writeFileSync(at, JSON.stringify({ project: "x", board: { milestonePrefix: "Pipeline" } }));
      expect(enginePrefixReading(root)).toEqual({ prefix: "Pipeline", unmeasured: null });
    } finally {
      cleanup();
    }
  });
});

// ── SC-1450 ─────────────────────────────────────────────────────────────────

describe("SC-1450: absent is empty, malformed throws - the distinction ADR-001 D2 exists for", () => {
  test("an unscaffolded directory yields the empty value from every accessor", () => {
    const none = makeRoot("neither");
    try {
      expect(loadRoleConfig(none)).toEqual({});
      expect(readProjectSlug(none)).toBeNull();
      expect(readRemoteHosts(none)).toEqual({});
    } finally {
      cleanup();
    }
  });

  test("a corrupt config throws rather than reading as unconfigured", () => {
    const bad = makeRoot("malformed");
    try {
      // Four of the six migrated sites wrapped their read in a bare catch that
      // returned the default. That converts "configured wrong" into "not
      // configured", which is the silence #70 shipped in.
      expect(() => loadRoleConfig(bad)).toThrow();
      expect(() => readProjectSlug(bad)).toThrow();
      expect(() => readRemoteHosts(bad)).toThrow();
    } finally {
      cleanup();
    }
  });
});

// ── SC-1451 ─────────────────────────────────────────────────────────────────

describe("SC-1451: the migrated call sites are executed, not merely rewritten", () => {
  test("loadRegistry picks up customMatchers authored in the directory layout", () => {
    const dir = makeRoot("directory");
    try {
      const names = loadRegistry(dir).map(e => e.name);
      // #212/#90: a consumer on the directory layout could not supply custom
      // matchers at all, because this reader looked only at the monolith.
      expect(names, "the custom matcher did not survive the directory layout")
        .toContain("adoption-only-matcher");
    } finally {
      cleanup();
    }
  });

  test("the grader's role list comes from config rather than its built-in fallback", () => {
    const dir = makeRoot("directory");
    try {
      const roles = loadValidRoles(dir);
      expect([...roles].sort()).toEqual(["marcus", "quinn"]);
      // The fallback set is the tell: if the read failed, "serena" is present.
      expect(roles.has("serena"), "fell back to the built-in role list").toBe(false);
    } finally {
      cleanup();
    }
  });

  test("the grader resolves brief paths from the directory layout", () => {
    const dir = makeRoot("directory");
    try {
      expect(loadRoleBriefPaths(dir)).toEqual({
        marcus: join(dir, "prompts/marcus.md"),
        quinn: join(dir, "prompts/quinn.md"),
      });
    } finally {
      cleanup();
    }
  });

  test("the worktree slug comes from config, and from neither layout exclusively", () => {
    const dir = makeRoot("directory");
    const mono = makeRoot("monolith");
    const none = makeRoot("neither");
    try {
      expect(getProjectSlug(dir)).toBe(AUTHORED.project);
      expect(getProjectSlug(mono)).toBe(AUTHORED.project);
      // The literal default stays at this call site, where the collision is
      // visible, rather than inside the accessor.
      expect(getProjectSlug(none)).toBe("project");
    } finally {
      cleanup();
    }
  });
});

// ── SC-1452 ─────────────────────────────────────────────────────────────────

describe("SC-1452: no migrated file keeps a private reader beside the shared one", () => {
  const MIGRATED = [
    "lib/create-sc.ts",
    "lib/task-completion-checks.ts",
    "scripts/fresh-eyes-test.ts",
    "scripts/grade-deterministic.ts",
    "scripts/parallel-ship.ts",
    "scripts/precompute-goal.ts",
    "scripts/test-brief.ts",
  ];

  test("every migrated file is gone from the ratchet, and the ratchet still has entries", () => {
    // The both-ways ratchet in lib/conformity.ts refuses a banked file with no
    // violations left, so leaving an entry behind is itself a failure. This
    // says which files this change claims, so a later revert cannot quietly
    // put one back while the suite stays green.
    const { readConfigAccessRatchet } = require("../lib/conformity");
    const banked = readConfigAccessRatchet(join(import.meta.dir, ".."));
    for (const f of MIGRATED) {
      expect(banked[f], `${f} is still banked — the decrement did not land`).toBeUndefined();
    }
    expect(
      Object.keys(banked).length,
      "the ratchet emptied; the remaining sites belong to #307 and should still be banked",
    ).toBeGreaterThan(0);
  });
});
