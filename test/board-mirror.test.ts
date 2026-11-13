/**
 * What the board is allowed to say (#1647).
 *
 * ## What was broken to prove these can fail
 *
 * Run `bash /tmp/rg-bm-battery/battery.sh`, 2026-10-28, against a 28-pass
 * baseline. Every row replaces one line in `lib/board-mirror.ts`:
 *
 *   baseline                                 0 red / 28 pass
 *   cap mirrorText at 6 with `+N more`       1 red / 27 pass
 *   criteriaNamedBy in mention order         1 red / 27 pass
 *   phaseOf without the `\b`                 1 red / 27 pass
 *   openFrontier ignores issue state         2 red / 26 pass
 *   isReady drops the assignee test          1 red / 27 pass
 *
 * The two `isReady` phase rows that stood here are gone with the gate they
 * measured — `phase !== frontier` and `frontier === null` are not code any
 * more, and a battery row naming a mutation nobody can perform is a number
 * that can never come back wrong.
 *   restored                                 0 red / 28 pass
 *
 * **Two of those rows were GREEN on the first run and are the reason the
 * battery was worth running.** `phaseOf` without the boundary changed
 * nothing because the case said `"Subphase 3"`, and the pattern is
 * case-sensitive — it never matched that string with or without the `\b`, so
 * the case could not disagree. And removing the null-phase guard changed
 * nothing because `null !== frontier` already carried it: two lines, one
 * decider, no behavioural test able to say which was live. The guard was
 * deleted rather than tested, and the one case it genuinely earns — both
 * sides null — was added.
 *
 * The first row is not hypothetical either. The cap SHIPPED, with a docblock saying
 * the overflow branch was unreachable because the widest issue named six ids,
 * and the first live run produced
 * `CRC-E1 CRC-E2 CRC-E3 CRC-E4 CRC-E5 CRC-E6 +3 more` for #1437, which names
 * nine. The bound was never measured; it was asserted in a comment. The case
 * below is that issue's real id list.
 *
 * The `isReady` rows are the ones worth having. An earlier version returned
 * "unblocked and unassigned", which made 36 of 46 open issues Ready because
 * this repository has almost no dependency edges — a lane holding the whole
 * backlog, answering "what can I pick up" with "anything".
 */
import { describe, expect, test } from "bun:test";
import {
  criterionIdsIn,
  criteriaNamedBy,
  declaresOwnCriterion,
  isReady,
  isUnblocked,
  mirrorRows,
  mirrorText,
  NAMES_NONE,
  NOT_A_SPEC,
  openFrontier,
  phaseOf,
  specCriteriaIn,
  unlocatableEntries,
} from "../lib/board-mirror";
import { parseCriteria } from "../lib/spec-evidence";
import {
  BACKLOG,
  READY,
  REFUSAL_EXIT,
  main as boardMirrorMain,
  parseRepo,
  queueLabelRepairs,
  queueLabelRun,
  readyPopulation,
  scopeDemotions,
  splitReadyChanges,
} from "../scripts/board-mirror";
import { NO_WORK_NEXT, activeMilestone, readyOrderFor } from "../lib/board-ready-rule";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SPEC_ORDER = [
  "CRC-A4",
  "CRC-B3",
  "CRC-B4",
  "CRC-B6",
  "CRC-E1",
  "CRC-E2",
  "CRC-E3",
  "CRC-E4",
  "CRC-E5",
  "CRC-E6",
  "CRC-E7",
  "CRC-E8",
  "CRC-E9",
  "CRC-M11",
  "CRC-N2",
];

/**
 * SC-2610 — the mirror reads every spec in `specs/`, not one named on the
 * command line.
 *
 * The defect this binds is not a crash. `--spec X` filtered the id set to X's
 * criteria, so an issue serving any OTHER spec's criterion got an empty cell,
 * which is indistinguishable from an issue that genuinely serves none. 28
 * cells on the live board were blank on 2026-10-29 and the column was unusable
 * for exactly the question it was built to answer.
 */
describe("SC-2610: every spec contributes, not the one on the command line", () => {
  /** A tree with the spec shapes that matter: two flat, one nested. */
  function tree(specs: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "rg-mirror-specs-"));
    for (const [rel, text] of Object.entries(specs)) {
      const at = join(root, "specs", rel);
      mkdirSync(join(at, ".."), { recursive: true });
      writeFileSync(at, text);
    }
    return root;
  }

  const spec = (...ids: string[]) =>
    ["# A spec", "", "## Success Criteria", "", ...ids.map(id => `- [ ] ${id}: it holds`), ""].join(
      "\n",
    );

  test("two specs in the tree contribute BOTH their ids", () => {
    const root = tree({ "A-SPEC.md": spec("SC-10", "SC-11"), "B-SPEC.md": spec("SC-20") });
    try {
      const r = specCriteriaIn(root);
      expect(r.reading).toBe("MEASURED");
      // The whole point, stated as the union. A one-spec reader returns
      // either the first two or the last one, and both are a strict subset.
      expect(r.ids).toEqual(["SC-10", "SC-11", "SC-20"]);
      expect(r.specs.map(s => s.path)).toEqual(["specs/A-SPEC.md", "specs/B-SPEC.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a spec in a SUBDIRECTORY is read too", () => {
    // `specs/bootstrap-data-flow/` holds six of this repository's specs. A
    // non-recursive walk finds none of them and still reports MEASURED.
    const root = tree({ "A-SPEC.md": spec("SC-10"), "nested/B-SPEC.md": spec("SC-20") });
    try {
      expect(specCriteriaIn(root).ids).toEqual(["SC-10", "SC-20"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the order is deterministic — spec path, then the order inside the spec", () => {
    // Two issues serving the same pair must render the SAME cell, or the
    // column cannot be scanned down a group. A `Set` iteration order that
    // follows the filesystem would break that silently between machines.
    const root = tree({ "Z-SPEC.md": spec("SC-30"), "A-SPEC.md": spec("SC-11", "SC-10") });
    try {
      expect(specCriteriaIn(root).ids).toEqual(["SC-11", "SC-10", "SC-30"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * An id two specs both state cannot be attributed by a cell that has room
   * for the id and not for the spec. Writing it picks one spec at random and
   * the reader has no way to know a choice was made — so it is dropped and
   * reported, and the issue keeps the unambiguous ids it also names.
   */
  test("an id two specs both state is DROPPED and reported, never guessed at", () => {
    const root = tree({ "A-SPEC.md": spec("SC-10"), "B-SPEC.md": spec("SC-10", "SC-20") });
    try {
      const r = specCriteriaIn(root);
      expect(r.ids, "an ambiguous id reached the column").toEqual(["SC-20"]);
      expect(r.collisions).toEqual([{ id: "SC-10", specs: ["specs/A-SPEC.md", "specs/B-SPEC.md"] }]);
      // The control: dropping is not the same as the sweep failing. The
      // unambiguous id from the SAME spec still arrives.
      expect(r.reading).toBe("MEASURED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * The other way a cell goes wrong once every spec is read: the issue is
   * writing its OWN acceptance criteria in a spec's shape.
   */
  test("a checkbox line is the issue STATING a criterion, not serving one", () => {
    const serves = { title: "x", body: "## Criteria this serves\n\nSC-10\n" };
    const states = { title: "x", body: "- [ ] SC-10 — a test fails when the trees diverge\n" };
    expect(criteriaNamedBy(serves, ["SC-10"])).toEqual(["SC-10"]);
    expect(criteriaNamedBy(states, ["SC-10"]), "#713's shape reached the column").toEqual([]);
    // Ticked, starred, and indented are the same act.
    expect(criteriaNamedBy({ title: "x", body: "  * [x] SC-10 done" }, ["SC-10"])).toEqual([]);
    // The control: a checkbox for a DIFFERENT id must not suppress this one.
    expect(
      criteriaNamedBy({ title: "x", body: "- [ ] SC-99 other\n\nserves SC-10" }, ["SC-10"]),
    ).toEqual(["SC-10"]);
  });

  /**
   * One spec stating the same id twice is not two specs stating it once.
   *
   * `parseCriteria` matches every `- [ ] ID:` line independently and does
   * not dedupe, so the duplicate pushed the spec's own path twice and read
   * downstream as a cross-spec collision — the id dropped as ambiguous, and
   * a note reading "stated by specs/A-SPEC.md and specs/A-SPEC.md". An
   * unambiguous criterion misreported as ambiguous, for a nonsensical
   * reason. Found by the AI review of #1679. Zero specs state a duplicate
   * today, so this is the case that arrives rather than one that has.
   */
  test("one spec stating an id TWICE is not a collision with itself", () => {
    const root = tree({ "A-SPEC.md": spec("SC-10", "SC-10", "SC-20") });
    try {
      const r = specCriteriaIn(root);
      // The premise: the file really does state it twice, so the dedupe is
      // doing work rather than the fixture being wrong.
      const stated = parseCriteria(readFileSync(join(root, "specs/A-SPEC.md"), "utf-8"));
      expect(stated.filter(c => c.id === "SC-10").length, "the fixture states it once").toBe(2);

      expect(r.reading).toBe("MEASURED");
      expect(r.ids, "a duplicate within one spec was read as ambiguous").toEqual([
        "SC-10",
        "SC-20",
      ]);
      expect(r.collisions, "a spec collided with itself").toEqual([]);
      expect(r.specs[0].ids, "the per-spec list carries the duplicate").toEqual(["SC-10", "SC-20"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * There is no safe fallback for a missing `parentPath`, so there is none.
   *
   * `Dirent.path` under a recursive `readdir` historically resolved to the
   * top-level directory rather than the entry's parent — that bug is WHY
   * `parentPath` exists — so on a runtime old enough to lack `parentPath`,
   * `path` carries the wrong value rather than a usable one. `?? dir` and
   * `?? e.path` are the same guess wearing different names, and both flatten
   * a nested spec silently. I wrote both, one round apart, and the AI review
   * of #1679 caught both.
   */
  test("an entry whose parent cannot be established refuses the sweep", () => {
    // `readdirSync` cannot be asked to omit the field, so the predicate is
    // its own function and the case hands it the shape directly. Without
    // this the refusal is unreachable from a test and reads exactly like a
    // refusal that works.
    expect(unlocatableEntries([{ name: "a.md", parentPath: "specs" }])).toEqual([]);
    expect(unlocatableEntries([{ name: "a.md" }]).map(e => e.name)).toEqual(["a.md"]);
    expect(unlocatableEntries([{ name: "a.md", parentPath: "" }]).map(e => e.name)).toEqual([
      "a.md",
    ]);
    // The control against the live tree: this runtime DOES report it, so the
    // sweep above is measuring specs rather than refusing on every run.
    const r = specCriteriaIn(join(import.meta.dir, ".."));
    expect(r.reading, "this runtime cannot locate its own spec files").toBe("MEASURED");
    expect(
      r.specs.some(s => s.path.includes("/bootstrap-data-flow/")),
      "no nested spec was located, so flattening would be invisible here",
    ).toBe(true);
  });

  /**
   * The refusal itself, driven through `specCriteriaIn` rather than through
   * the predicate it calls.
   *
   * The case above tests `unlocatableEntries` with hand-built objects and
   * separately asserts the live tree reads MEASURED — so nothing executed the
   * `SpecSweep` the refusal assembles, and a wrong field or a broken message
   * inside it would have gone unobserved. A predicate is not the object built
   * from it. Raised by the AI review of #1679.
   *
   * `readdirSync` on a runtime that HAS `parentPath` cannot produce an entry
   * without one, so the listing is a parameter and the case supplies it. The
   * CONTROL is the first half: the same entries WITH `parentPath` go through
   * the same injected seam and read MEASURED, so the refusal below is the
   * missing field and not the injection.
   */
  test("the refusal returns an UNMEASURED sweep that names what it could not locate", () => {
    const root = tree({
      "A-SPEC.md": spec("SC-10"),
      "nested/B-SPEC.md": spec("SC-20"),
    });
    const entries = (withParent: boolean) => [
      { name: "A-SPEC.md", parentPath: join(root, "specs"), isFile: () => true },
      {
        name: "B-SPEC.md",
        ...(withParent ? { parentPath: join(root, "specs", "nested") } : {}),
        isFile: () => true,
      },
    ];
    try {
      // Control: the seam carries a normal listing through to a real read.
      const ok = specCriteriaIn(root, () => entries(true));
      expect(ok.reading, "the injected listing cannot reach a real sweep").toBe("MEASURED");
      expect(ok.ids).toEqual(["SC-10", "SC-20"]);

      const r = specCriteriaIn(root, () => entries(false));
      expect(r.reading).toBe("UNMEASURED");
      // Every field of the object, because the object is what was untested.
      // A sweep that refuses must report NOTHING read — a partial list is the
      // flattening it refused, delivered quietly.
      expect(r.ids).toEqual([]);
      expect(r.specs).toEqual([]);
      expect(r.collisions).toEqual([]);
      expect(r.unmeasuredReasons.length).toBe(1);
      const why = r.unmeasuredReasons[0]!;
      expect(why).toContain("1 spec file(s)");
      expect(why).toContain(join(root, "specs"));
      expect(why).toContain("B-SPEC.md");
      // The id the locatable spec DID state must not appear anywhere in the
      // refusal: reporting it would read as a partial result.
      expect(why).not.toContain("SC-10");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * The THIRD refusal — a spec the listing can see and `readFileSync`
   * cannot open — and the property that stops there being a fourth.
   *
   * The two branches above were each written, reviewed and fixed on their
   * own round. This one pushed a reason, carried on, and returned
   * `reading: "UNMEASURED"` with the other specs' `ids` and `specs` still in
   * it: a short list that looks whole to any caller reading the array before
   * the reading. No behavioural test of either fixed branch could see it —
   * three branches answering one question is *two deciders that agree* at
   * N=3, and a behavioural suite catches only the last one to regress. So
   * the second half of this case asserts the property across the SITES.
   * Raised by the AI review of #1679.
   */
  test("a spec that cannot be opened refuses with nothing in it, and no branch spells the reading", () => {
    const root = tree({ "A-SPEC.md": spec("SC-10") });
    const at = join(root, "specs");
    // A file the listing reports and the disk does not have — the race with
    // a delete, deterministically, without chmod (which does nothing when
    // the suite runs as root).
    const listing = (withGhost: boolean) => [
      { name: "A-SPEC.md", parentPath: at, isFile: () => true },
      ...(withGhost ? [{ name: "GHOST.md", parentPath: at, isFile: () => true }] : []),
    ];
    try {
      const ok = specCriteriaIn(root, () => listing(false));
      expect(ok.reading, "the control cannot reach a real read").toBe("MEASURED");
      expect(ok.ids).toEqual(["SC-10"]);

      const r = specCriteriaIn(root, () => listing(true));
      expect(r.reading).toBe("UNMEASURED");
      expect(r.ids, "the refusal handed back the specs it DID read").toEqual([]);
      expect(r.specs).toEqual([]);
      expect(r.collisions).toEqual([]);
      expect(r.unmeasuredReasons.length).toBe(1);
      expect(r.unmeasuredReasons[0]).toContain("could not read specs/GHOST.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    // The cross-site property. `unmeasuredSweep` is the only thing allowed to
    // name the reading, so a branch added later cannot leak a partial result
    // however carelessly it is written — it has no way to say UNMEASURED.
    const src = readFileSync(join(import.meta.dir, "..", "lib", "board-mirror.ts"), "utf-8");
    const from = src.indexOf("export function specCriteriaIn(");
    const to = src.indexOf("/** What the board is told about one issue. */", from);
    expect(from, "specCriteriaIn was renamed, so this scan examines nothing").toBeGreaterThan(-1);
    expect(to, "the slice overran past the function it meant to read").toBeGreaterThan(from);
    const body = src.slice(from, to);
    // The premise: the slice really is the sweep, and it really does hold the
    // branches. Without this the assertion below passes on an empty string.
    expect(body).toContain("readDir(dir)");
    expect(body.split("return unmeasuredSweep(").length - 1).toBe(3);
    expect(
      body.split('"UNMEASURED"').length - 1,
      "a branch of specCriteriaIn spells the reading itself, so it can return one with data in it",
    ).toBe(0);
  });

  /**
   * Every place in the tree that documents `--spec`, swept together.
   *
   * Making the flag optional in `scripts/board-mirror.ts` left two siblings
   * describing the old contract: the command registry spelled `--spec`
   * unbracketed, so a reader of `rungate --help` believes it is required,
   * and `plan-issues` PRINTED a follow-up command combining `--spec` with
   * `--write` — handing the reader SC-2610 as advice. Both are the fix this
   * PR makes, restated where the fix did not reach.
   *
   * The AI review raised them on ten consecutive rounds and each round found
   * them unswept, because each round's answer was to look again at the file
   * that was already right. The repo's own rule is the other way round: on
   * replacing one name, sweep for the others
   * (`.claude/rules/checks-must-be-able-to-fail.md`, *two deciders that
   * agree*). So this is the sweep, as an assertion.
   */
  test("every site documenting board-mirror --spec says the same thing about it", () => {
    const root = join(import.meta.dir, "..");
    const read = (p: string) => readFileSync(join(root, p), "utf-8");

    // The strongest form: the two documented contracts must AGREE, byte for
    // byte. Drift in either one is what shipped.
    // Found by its declaration, never by line number — a line index dates a
    // revision and this file has already moved under one citation tonight.
    const usageLine = read("scripts/board-mirror.ts")
      .split("\n")
      .find(l => l.startsWith("const USAGE = `"))!
      .replace("const USAGE = `", "");
    const registry = read("lib/cli-commands.ts")
      .split("\n")
      .find(l => l.includes("rungate board-mirror --project"))!;
    expect(usageLine, "scripts/board-mirror.ts USAGE moved; this scan read the wrong line").toContain(
      "rungate board-mirror --project",
    );
    expect(registry.includes(usageLine), `the registry and USAGE disagree:\n  ${registry.trim()}\n  ${usageLine}`).toBe(true);

    // And the sweep, so a THIRD site added later cannot drift quietly. A
    // bracketed `--spec` is documentation that it is optional; a bare one is
    // either a command somebody will run or a flag they will believe
    // mandatory, and both reintroduce SC-2610.
    const bare: string[] = [];
    let population = 0;
    for (const file of ["lib/cli-commands.ts", "scripts/board-mirror.ts", "scripts/plan-issues.ts"]) {
      for (const line of read(file).split("\n")) {
        if (!line.includes("board-mirror") || !line.includes("--spec")) continue;
        population++;
        if (!line.includes("[--spec")) bare.push(`${file}: ${line.trim()}`);
      }
    }
    // The control. Without it a rename of the command empties the population
    // and this passes having examined nothing.
    expect(population, "no site mentions board-mirror and --spec, so this scan proves nothing").toBeGreaterThanOrEqual(
      2,
    );
    expect(bare, "a site spells --spec as required, or passes it to a write").toEqual([]);
  });

  /**
   * Both readers of a spec, agreeing by construction rather than by having
   * been fixed twice.
   *
   * The sweep was de-duplicated first and the `--spec` path was left parsing
   * for itself, so the two paths of ONE script disagreed about the very case
   * the fix was written for: `--spec` produced `SC-10 SC-10` in the cell
   * where the sweep produced `SC-10`. Two deciders, and no behavioural test
   * of either can see the other going wrong — so this asserts the property
   * across the call SITES, not just the behaviour of the shared one.
   */
  test("both readers of a spec collapse a repeated id, and neither parses alone", () => {
    const text = spec("SC-10", "SC-10", "SC-20");
    expect(criterionIdsIn(text)).toEqual(["SC-10", "SC-20"]);
    // The premise: without the dedupe there really would be two.
    expect(parseCriteria(text).filter(c => c.id === "SC-10").length).toBe(2);
    // And the cell that would have been written.
    expect(mirrorText(criterionIdsIn(text))).toBe("SC-10 SC-20");

    // The site property. A second `parseCriteria` anywhere in the CLI is a
    // second decider, which is how this bug survived the first fix.
    const cli = readFileSync(join(import.meta.dir, "..", "scripts", "board-mirror.ts"), "utf-8");
    expect(cli.includes("criterionIdsIn"), "the CLI no longer uses the shared reader").toBe(true);
    expect(
      cli.split("\n").filter(l => l.includes("parseCriteria(")),
      "scripts/board-mirror.ts reads a spec for itself instead of through criterionIdsIn, so " +
        "the --spec path and the default sweep can disagree about the same file",
    ).toEqual([]);
  });

  test("a specs/ directory stating nothing is UNMEASURED, not an empty reading", () => {
    const root = tree({ "EMPTY-SPEC.md": "# A spec with no criteria\n" });
    try {
      const r = specCriteriaIn(root);
      expect(r.reading).toBe("UNMEASURED");
      expect(r.ids).toEqual([]);
      expect(r.unmeasuredReasons.join(" ")).toContain("no spec");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * Two ways to reach an empty id set, and they are different facts. The
   * caller refuses on UNMEASURED before printing the collision notes, so if
   * the emptiness came from ambiguity the reason line is the only place that
   * can say so — and the "no spec states a criterion" sentence is then false
   * about a tree full of criteria. Raised by the AI review of #1679.
   */
  test("all-ambiguous is UNMEASURED for the AMBIGUITY, not for an absence", () => {
    const root = tree({ "A-SPEC.md": spec("SC-10"), "B-SPEC.md": spec("SC-10") });
    try {
      const r = specCriteriaIn(root);
      expect(r.reading).toBe("UNMEASURED");
      expect(r.ids).toEqual([]);
      const why = r.unmeasuredReasons.join(" ");
      expect(why, "it blamed an absence in a tree that states a criterion").not.toContain(
        "no spec",
      );
      expect(why).toContain("stated by more than one spec");
      // The diagnostic the caller would otherwise never print must be IN the
      // reason, not merely available on a field nothing reads on this path.
      expect(why).toContain("SC-10");
      expect(why).toContain("specs/A-SPEC.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no specs/ directory at all is UNMEASURED, naming the path it looked at", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-mirror-nospecs-"));
    try {
      const r = specCriteriaIn(root);
      expect(r.reading).toBe("UNMEASURED");
      expect(r.unmeasuredReasons.join(" ")).toContain(join(root, "specs"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * The live control. Every case above builds its own tree, so all of them
   * would still pass against a walk that works on two-file fixtures and finds
   * one spec in the real one. This reads THIS repository.
   */
  test("against this repository, the sweep spans many specs and both id shapes", () => {
    const r = specCriteriaIn(join(import.meta.dir, ".."));
    expect(r.reading).toBe("MEASURED");
    const stating = r.specs.filter(s => s.ids.length > 0);
    expect(stating.length, "a one-spec reader would report 1 here").toBeGreaterThan(10);
    // Two different id namespaces live in different specs, so a cell can only
    // carry both if the sweep really crossed spec boundaries.
    expect(r.ids.some(id => /^SC-\d+$/.test(id)), "no SC- id was found").toBe(true);
    expect(r.ids.some(id => /^CRC-/.test(id)), "no CRC- id was found").toBe(true);
    // And the spec this criterion is stated in is itself in the reading.
    expect(r.ids).toContain("SC-2610");
  });

  /**
   * An exclusion naming a file that no longer exists excludes nothing, and
   * reads in review exactly like one that works.
   *
   * What it changes is narrower than it first looks, and the first version of
   * this case asserted the wrong thing. Every id the template states —
   * `SC-1`, `SC-2`, `SC-A1`, `SC-A2` — is ALSO stated by a real spec, so
   * excluding it removes no id from the column. What it removes is four false
   * collision reports, each naming the template as a spec that states a
   * criterion. That is the claim worth binding, so it is the one asserted.
   */
  /**
   * Every site that builds a pattern around an id must escape it the same
   * way, and the property is asserted across the SITES rather than repaired
   * at one of them: two escapers that agree are behaviourally one, and a
   * mutation of either leaves the other holding the case up
   * (`.claude/rules/checks-must-be-able-to-fail.md`).
   *
   * Found by the AI review of #1679 — `declaresOwnCriterion` interpolated the
   * id raw while its sibling `oneScMentionPattern` escaped it. Today's id
   * grammar contains no metacharacter, so no behavioural case could separate
   * them; what the review saw was the asymmetry.
   */
  test("an id carrying a regex metacharacter is matched LITERALLY, at every site", () => {
    // `.` is the metacharacter, and the id still ENDS in a word character,
    // because both patterns terminate on a boundary and a `)` would fail
    // that for reasons unrelated to escaping.
    const id = "SC-1.5";
    const text = `- [ ] ${id} — the issue states its own\n`;
    // Unescaped, the `.` matches any character, so `SC-115` satisfies the
    // pattern. The positive case cannot show this — it passes either way —
    // so the NEGATIVE is the half that can fail.
    expect(declaresOwnCriterion(text, id), "the literal case stopped matching").toBe(true);
    expect(declaresOwnCriterion("- [ ] SC-115 — something else\n", id)).toBe(false);
    expect(criteriaNamedBy({ title: "x", body: "serves SC-115" }, [id])).toEqual([]);
    // Both sites agree on the same input, which is the property.
    expect(criteriaNamedBy({ title: "x", body: `serves ${id}` }, [id])).toEqual([id]);
    expect(criteriaNamedBy({ title: "x", body: text }, [id]), "a declaration counted").toEqual([]);
  });

  /**
   * The other half of matching an id, and the one `\b` gets wrong.
   *
   * `\b` fires on a word-to-non-word transition, so a trailing hyphen counts
   * as a boundary and `SC-1` matches the front of `SC-1-draft`. That is #148,
   * and `declaresOwnCriterion` reintroduced it one round after the escaping
   * half was fixed — found by the AI review of #1679. Both sites now close
   * the id through `idBoundedPattern`, so this asserts the property at both.
   */
  test("an id does not match the front of a LONGER id, at either site", () => {
    const longer = "- [ ] SC-1-draft — a different criterion entirely\n";
    expect(declaresOwnCriterion(longer, "SC-1"), "SC-1 matched inside SC-1-draft").toBe(false);
    expect(declaresOwnCriterion(longer, "SC-1-draft"), "the real id stopped matching").toBe(true);
    // The digit case #148 was originally about, at the same site.
    expect(declaresOwnCriterion("- [ ] SC-15 — another\n", "SC-1")).toBe(false);
    // And the sibling, on the same inputs, so the two cannot drift apart.
    expect(criteriaNamedBy({ title: "x", body: "serves SC-1-draft" }, ["SC-1"])).toEqual([]);
    expect(criteriaNamedBy({ title: "x", body: "serves SC-15" }, ["SC-1"])).toEqual([]);
  });

  test("the excluded file exists, states criteria, and leaves the sweep", () => {
    const root = join(import.meta.dir, "..");
    expect(NOT_A_SPEC).toEqual(["specs/SPEC-TEMPLATE.md"]);
    const sweep = specCriteriaIn(root);
    for (const p of NOT_A_SPEC) {
      expect(existsSync(join(root, p)), `${p} is excluded but does not exist`).toBe(true);
      // The control: it really would have contributed. A template that had
      // stopped stating criteria would make this exclusion a no-op nobody
      // could see, and the case above would still be green.
      const stated = parseCriteria(readFileSync(join(root, p), "utf-8")).map(c => c.id);
      expect(stated.length, `${p} states nothing, so excluding it does nothing`).toBeGreaterThan(0);
      expect(sweep.specs.map(s => s.path), `${p} is still in the reading`).not.toContain(p);
      expect(
        sweep.collisions.flatMap(c => c.specs),
        `${p} is still named as a colliding spec`,
      ).not.toContain(p);
    }
  });
});

describe("#1647: the Criteria column", () => {
  describe("mirrorText carries every id", () => {
    /**
     * Covers SC-2609 (SPEC-TO-BOARD-PIPELINE-SPEC.md).
     *
     * This case asserted `NAMES_NONE === ""` until #1716, on the grounds that
     * a word "sorts and filters as a value" and empty is absence. Absence is
     * the defect: a blank spells *not yet filled in*, *the tool could not
     * tell* and *deliberately none* identically, so the only reading that
     * means the board is fine cannot be told from the two that do not.
     */
    test("SC-2609: no criteria is SPELLED, and a cell nobody wrote stays blank", () => {
      expect(mirrorText([])).toBe(NAMES_NONE);
      // The whole of the criterion, in one line: a judgement is not a gap.
      // Anchored on the literal, NOT on the constant — `toBe(NAMES_NONE)`
      // above moves with any mutation of it and so can never come back wrong.
      expect(NAMES_NONE).not.toBe("");
      expect(mirrorText([])).not.toBe("");
      expect(NAMES_NONE.trim()).toBe(NAMES_NONE);
    });

    test("SC-2609: the phrase cannot be mistaken for a criterion it names", () => {
      // A reader scanning the column must not try to look this up. Assert on
      // the id SHAPE rather than on two prefixes a third id class walks past.
      expect(NAMES_NONE).not.toMatch(/[A-Z]{2,}-[A-Z]?\d/);
      expect(mirrorText(["SC-2609"])).not.toBe(NAMES_NONE);
    });

    test("one id is just the id", () => {
      expect(mirrorText(["CRC-F1"])).toBe("CRC-F1");
    });

    test("nine ids — #1437's real list — are all nine, uncut", () => {
      const nine = ["CRC-E1", "CRC-E2", "CRC-E3", "CRC-E4", "CRC-E5", "CRC-E6", "CRC-E7", "CRC-E8", "CRC-E9"];
      const cell = mirrorText(nine);
      expect(cell).toBe(nine.join(" "));
      expect(cell).not.toContain("more");
      for (const id of nine) expect(cell).toContain(id);
    });
  });

  describe("criteriaNamedBy asks the question criterion-inventory already asks", () => {
    test("a title mention counts", () => {
      expect(criteriaNamedBy({ title: "CRC-B4's jury never runs in CI", body: "" }, SPEC_ORDER)).toEqual(
        ["CRC-B4"],
      );
    });

    test("a body mention counts", () => {
      expect(criteriaNamedBy({ title: "something", body: "serves CRC-N2 only" }, SPEC_ORDER)).toEqual([
        "CRC-N2",
      ]);
    });

    test("a null body is not a crash and not a match", () => {
      expect(criteriaNamedBy({ title: "nothing here", body: null }, SPEC_ORDER)).toEqual([]);
    });

    test("CRC-B4 does not match inside CRC-B41", () => {
      // The trailing boundary in `oneScMentionPattern` is "not a word
      // character and not a hyphen". Without it the column would credit a
      // criterion the issue never names.
      expect(criteriaNamedBy({ title: "about CRC-B41", body: "" }, ["CRC-B4"])).toEqual([]);
    });

    test("the order is the spec's, not the order the prose happens to mention them", () => {
      // Two issues serving the same pair must render identically, or the
      // column stops being scannable down a group.
      const a = criteriaNamedBy({ title: "CRC-N2 then CRC-A4", body: "" }, SPEC_ORDER);
      const b = criteriaNamedBy({ title: "CRC-A4 then CRC-N2", body: "" }, SPEC_ORDER);
      expect(a).toEqual(["CRC-A4", "CRC-N2"]);
      expect(a).toEqual(b);
    });

    test("an id absent from the spec is never credited, however loudly the issue says it", () => {
      expect(criteriaNamedBy({ title: "CRC-Z9 CRC-Z9 CRC-Z9", body: "" }, SPEC_ORDER)).toEqual([]);
    });
  });

  test("mirrorRows pairs each issue with its own cell", () => {
    const rows = mirrorRows(
      [
        { number: 1, title: "CRC-B3 and CRC-B4", body: "" },
        { number: 2, title: "nothing", body: "" },
      ],
      SPEC_ORDER,
    );
    expect(rows).toEqual([
      { number: 1, criteria: ["CRC-B3", "CRC-B4"], text: "CRC-B3 CRC-B4" },
      // SC-2609: the row for an issue naming nothing carries the spelled
      // phrase, not a blank. `criteria` stays empty — the list is the data,
      // the cell is what a reader sees.
      { number: 2, criteria: [], text: NAMES_NONE },
    ]);
    // Against the literal too: the line above compares the row to the same
    // constant the row is built from, so it survives any value of it.
    expect(rows[1]!.text).not.toBe("");
  });
});

describe("#1647: the Ready lane", () => {
  test("phaseOf reads the number out of a milestone title", () => {
    expect(phaseOf("Convergence Phase 0 — three settings")).toBe(0);
    expect(phaseOf("Convergence Phase 6 — release and detection")).toBe(6);
  });

  test("phaseOf refuses a milestone that is not a phase", () => {
    // `Convergence Machinery` is a real milestone on this repository that no
    // phase row derives, and `plan-spec` reports it as unmanaged. Reading a
    // phase number out of it would put unordered work into the queue.
    expect(phaseOf("Convergence Machinery")).toBeNull();
    expect(phaseOf(null)).toBeNull();
    expect(phaseOf("")).toBeNull();
  });

  test("phaseOf does not read a number out of a word ENDING in Phase", () => {
    // The first spelling of this case was `"Subphase 3"`, and it could not
    // disagree with anything: the pattern is case-sensitive, so `Phase` never
    // matched `subphase` with or without the `\b`. Removing the boundary left
    // the whole file green. The word has to end in a capital `Phase` for the
    // boundary to be the thing under test.
    expect(phaseOf("TestPhase 3 — something")).toBeNull();
    expect(phaseOf("Convergence Phase 3 — something")).toBe(3);
  });

  describe("openFrontier", () => {
    test("is the lowest phase with OPEN work", () => {
      expect(
        openFrontier([
          { state: "OPEN", phase: 3 },
          { state: "OPEN", phase: 1 },
          { state: "OPEN", phase: 5 },
        ]),
      ).toBe(1);
    });

    test("a closed issue does not hold a phase open", () => {
      // The whole point of the lane: finishing Phase 0 must promote Phase 1.
      expect(
        openFrontier([
          { state: "CLOSED", phase: 0 },
          { state: "OPEN", phase: 1 },
        ]),
      ).toBe(1);
    });

    test("an issue in no phase does not become the frontier", () => {
      expect(
        openFrontier([
          { state: "OPEN", phase: null },
          { state: "OPEN", phase: 2 },
        ]),
      ).toBe(2);
    });

    test("no open phased work at all is null, not zero", () => {
      // `0` is a real phase number here, so returning it for "nothing" would
      // make every unphased issue in Phase 0 look ready.
      expect(openFrontier([{ state: "CLOSED", phase: 0 }])).toBeNull();
      expect(openFrontier([])).toBeNull();
    });
  });

  describe("isReady — eligibility is unblocked and unclaimed, and phase is not a gate", () => {
    const base = { state: "OPEN", blockedByOpen: 0, assignees: 0 };

    test("open, unblocked, unclaimed", () => {
      expect(isReady(base)).toBe(true);
    });

    test("an OPEN blocker refuses it", () => {
      expect(isReady({ ...base, blockedByOpen: 1 })).toBe(false);
    });

    test("a claimed issue is not ready — somebody already took it", () => {
      expect(isReady({ ...base, assignees: 1 })).toBe(false);
    });

    test("a closed issue is never ready", () => {
      expect(isReady({ ...base, state: "CLOSED" })).toBe(false);
    });

    // **The three cases the phase gate used to own, inverted.** They were
    // "a later phase is not ready", "an issue in no phase is never ready"
    // and "no frontier means nothing is ready", and each asserted FALSE.
    // Jason's call of 2026-11-05 makes phase ordering rather than
    // eligibility, so the same inputs must now be eligible.
    //
    // **The input must CARRY a phase, and the first version of these did
    // not.** `{ ...base }` spreads an object the parameter type no longer
    // declares a phase on, so both cases were byte-identical to the plain
    // base case above and re-asserted it — vacuous in the exact shape
    // `.claude/rules/checks-must-be-able-to-fail.md` names, while a comment
    // right here claimed they stopped the gate returning. A gate spelled
    // `"phase" in item && item.phase !== 0` would have left them green.
    // Built through `withPhase` now, which puts the key on the object; a
    // variable rather than an inline literal, because an object literal
    // with a property the parameter type does not declare is refused by the
    // excess-property check. ai-review round 2 of #1796.
    const withPhase = (phase: number | null) => ({ ...base, phase });

    test("phase is not an input at all — the signature cannot carry one", () => {
      expect(isReady.length, "a frontier parameter coming back is the gate coming back").toBe(1);
    });

    test("an issue in a later phase is eligible, and is ordered later instead", () => {
      expect(
        isReady(withPhase(6)),
        "a later phase is pickable when the lane has room — this input carries phase 6",
      ).toBe(true);
      expect(
        readyOrderFor("P", NO_WORK_NEXT)({ milestone: "P Phase 6", number: 1, labels: [] }, { milestone: "P Phase 0", number: 99, labels: [] }),
        "phase still decides who goes FIRST — that is where it moved to",
      ).toBeGreaterThan(0);
    });

    test("an issue with no phase milestone is eligible, and sorts last", () => {
      expect(
        isReady(withPhase(null)),
        "an explicit null phase is pickable, not refused",
      ).toBe(true);
      expect(
        readyOrderFor("P", NO_WORK_NEXT)({ milestone: null, number: 1, labels: [] }, { milestone: "P Phase 9", number: 99, labels: [] }),
        "a null phase ranks behind every numbered one rather than being refused",
      ).toBeGreaterThan(0);
    });

    // The control the two above need: a phase-carrying input must be able
    // to read FALSE for a non-phase reason, or "returns true" would be
    // satisfied by `isReady` ignoring its argument entirely.
    test("a phase-carrying issue is still refused when it is blocked", () => {
      expect(isReady({ ...withPhase(6), blockedByOpen: 1 })).toBe(false);
    });

  });

  describe("isUnblocked reads the OPEN count, which is why Ready is written and not filtered", () => {
    test("zero open blockers and nobody on it", () => {
      expect(isUnblocked({ blockedBy: 0 }, 0)).toBe(true);
    });

    test("one open blocker is blocked", () => {
      expect(isUnblocked({ blockedBy: 1 }, 0)).toBe(false);
    });

    test("an assignee is a claim, not a block, but it still leaves the lane", () => {
      expect(isUnblocked({ blockedBy: 0 }, 1)).toBe(false);
    });
  });
});

/**
 * ## The mutation batteries
 *
 *   mutant                                         reading   predicted
 *   the cap ignored entirely                         5          4
 *   demotions dropped from writable                  2          2
 *   demotions capped too (the naive version)         2          1
 *   --repo validation dropped (FIRST attempt)        0          2
 *   parseRepo drops the arity check                  1          2
 *   parseRepo drops the empty-side check             1          1
 *   main stops calling parseRepo (FIRST attempt)     0          0
 *
 * **Two rows read ZERO, and both were real gaps rather than wrong
 * predictions.** The `--repo` guard was inline in `main()` where no case
 * could reach it — four assertions later added over an exported
 * `parseRepo`. Then removing `main`'s CALL to it read zero as well: a
 * validator nothing invokes is four green cases and no guard, which is
 * `runVerdict`'s unreachable branch one layer out. Both are closed.
 *
 * The arity miss is instructive: dropping `parts.length !== 2` still
 * refuses `"rungate"`, because the empty-side check catches it. Only
 * `"a/b/c"` survives, so one case moves and not two. Predicting the
 * MEMBERSHIP rather than the total is what would have got this right.
 */
describe("SC-2722: the hand-run writer fills to the same depth as the workflow", () => {
  const c = (
    number: number,
    phase: number | null,
    to: string,
    status = "Backlog",
    labels: readonly string[] = [],
  ) => ({
    item: { number, milestone: phase === null ? null : `Engine Phase ${phase}`, labels, status },
    to,
  });
  const promote = (n: number) => c(n, 0, "Ready");
  /** The focus for every phase-0 card here (SC-2741). */
  const FOCUS0 = activeMilestone([{ milestone: "Engine Phase 0" }], "Engine");
  /** A card LEAVING Ready. Its status is what frees a slot in this batch. */
  const demote = (n: number) => c(n, 0, "Backlog", "Ready");

  test("more eligible promotions than depth writes exactly the depth, in order", () => {
    const { readyWritable, heldByCap } = splitReadyChanges(
      [promote(5), promote(1), promote(9), promote(3)],
      2,
      0,
      "Engine",
      null,
      FOCUS0,
    );
    expect(readyWritable.map(x => x.item.number)).toEqual([1, 3]);
    expect(heldByCap.map(x => x.item.number)).toEqual([5, 9]);
  });

  test("a full lane promotes nothing", () => {
    const { readyWritable, heldByCap } = splitReadyChanges([promote(1), promote(2)], 2, 2, "Engine", null, FOCUS0);
    expect(readyWritable).toEqual([]);
    expect(heldByCap.map(x => x.item.number)).toEqual([1, 2]);
  });

  // The half a naive implementation gets wrong. Capping departures would
  // pin a claimed or newly-blocked card in the lane for as long as the
  // lane stayed full — the cap preserving the staleness it exists to
  // prevent.
  test("a demotion to Backlog is NEVER capped, even when the lane is over its depth", () => {
    const { readyWritable, heldByCap } = splitReadyChanges(
      [demote(7), demote(8), promote(1)],
      2,
      99,
      "Engine",
      null,
      FOCUS0,
    );
    expect(
      readyWritable.map(x => x.item.number).sort(),
      "the cap bounds what may ENTER Ready, not what may leave it",
    ).toEqual([7, 8]);
    expect(heldByCap.map(x => x.item.number)).toEqual([1]);
  });

  // A board can span repositories, so there is no repository to derive a
  // depth from and no honest default. Promoting everything on an unread
  // depth is the uncapped behaviour this replaces.
  test("an unmeasured depth promotes nothing but still demotes", () => {
    const { readyWritable, heldByCap, selection } = splitReadyChanges(
      [demote(7), promote(1), promote(2)],
      null,
      0,
      "Engine",
      null,
      FOCUS0,
    );
    expect(readyWritable.map(x => x.item.number)).toEqual([7]);
    expect(heldByCap.map(x => x.item.number)).toEqual([1, 2]);
    expect(selection.why).toContain("UNMEASURED");
  });

  test("SC-2741: only the active milestone is promoted, and a phase-less issue waits", () => {
    const { readyWritable } = splitReadyChanges(
      [c(4, null, "Ready"), c(9, 2, "Ready")],
      1,
      0,
      "Engine",
      null,
      activeMilestone([{ milestone: "Engine Phase 2" }], "Engine"),
    );
    expect(
      readyWritable.map(x => x.item.number),
      "the focus is Phase 2, so the phase-less issue waits outside it",
    ).toEqual([9]);
  });

  // ROUND 2, finding 1. The case above cannot see this: its board order
  // and its ranked order are the same list, so a `filter` over the
  // candidates reproduces the right answer by luck. Here they disagree —
  // #1 outranks #2 on age while #2 comes first on the board — and a
  // re-derived subset writes them backwards. (Both sit in the focus since
  // SC-2741, so age is the rank that differs.)
  test("the promotions are written in RANKED order, not in board order", () => {
    const { readyWritable } = splitReadyChanges([c(2, 0, "Ready"), c(1, 0, "Ready")], 2, 0, "Engine", null, FOCUS0);
    expect(
      readyWritable.map(x => x.item.number),
      "membership can be right while the sequence is wrong, and the log then " +
        "claims a phase-then-age ranking it did not write",
    ).toEqual([1, 2]);
  });

  test("SC-2741: an eligible card outside the focus waits — it is not held by the cap", () => {
    const { readyWritable, heldByCap, outOfScope } = splitReadyChanges(
      [c(1, 0, "Ready"), c(2, 7, "Ready"), c(3, null, "Ready", "Backlog", ["engine"])],
      5,
      0,
      "Engine",
      null,
      FOCUS0,
    );
    expect(readyWritable.map(x => x.item.number)).toEqual([1]);
    expect(heldByCap, "a waiting card reported as held by the cap is a lie about the lane").toEqual([]);
    expect(outOfScope.map(x => x.item.number)).toEqual([2, 3]);
  });

  // ROUND 2, finding 3 — the HIGH one. `occupied` is counted before the
  // write, so a frontier move that demotes one and promotes one promoted
  // NOTHING: the departing card was still counted as holding its slot.
  test("a card leaving Ready in this batch frees its slot in this batch", () => {
    const { readyWritable, heldByCap } = splitReadyChanges(
      [demote(7), promote(1), promote(2)],
      2,
      2,
      "Engine",
      null,
      FOCUS0,
    );
    expect(
      readyWritable.map(x => x.item.number),
      "Ready holds 2 of 2 and one card is leaving, so exactly one may enter",
    ).toEqual([7, 1]);
    expect(heldByCap.map(x => x.item.number)).toEqual([2]);
  });

  // The control for the case above, and the error the obvious fix makes.
  // This command may also overwrite a card carrying NO status at all;
  // that card was never in Ready, so counting it as a departure would
  // promote past the cap — the opposite failure, reached by subtracting
  // `demotions.length`.
  test("a demotion of a card that was never in Ready frees nothing", () => {
    const { readyWritable, heldByCap } = splitReadyChanges(
      [c(7, 0, "Backlog", ""), promote(1)],
      2,
      2,
      "Engine",
      null,
      FOCUS0,
    );
    expect(
      readyWritable.map(x => x.item.number),
      "the lane is still full — nothing left it — so the promotion waits",
    ).toEqual([7]);
    expect(heldByCap.map(x => x.item.number)).toEqual([1]);
  });
});

describe("SC-2724: occupancy is counted over the items the command can move", () => {
  const it_ = (number: number, state: string, status: string) => ({ number, state, status });

  // ai-review round 3. `occupied` was counted over EVERY board item while
  // the transitions were computed over the open ones, so anything this
  // command can never move counted against the cap forever.
  test("a closed issue left at Ready does not hold a slot", () => {
    const { writable, occupied } = readyPopulation([
      it_(1, "OPEN", "Ready"),
      it_(2, "CLOSED", "Ready"),
    ]);
    expect(occupied, "nothing demotes a closed issue, so counting it starves Ready forever").toBe(1);
    expect(writable.map(i => i.number)).toEqual([1]);
  });

  // The case the finding did not name and the board actually held: a
  // DRAFT project item has no issue behind it and so no state at all.
  // Measured 2026-11-05 — Ready carried six items, five open issues and
  // one draft, which is why the lane read 5 of 4 OVER.
  test("a draft board item, which has no state, holds no slot", () => {
    const { writable, occupied } = readyPopulation([
      it_(1, "OPEN", "Ready"),
      { number: 2, state: undefined as unknown as string, status: "Ready" },
    ]);
    expect(occupied).toBe(1);
    expect(writable.map(i => i.number)).toEqual([1]);
  });

  // The control. A guard that refused everything would also pass both
  // cases above while making the cap unreachable.
  test("open issues in Ready are still counted", () => {
    const { occupied } = readyPopulation([
      it_(1, "OPEN", "Ready"),
      it_(2, "OPEN", "Ready"),
      it_(3, "OPEN", "Backlog"),
    ]);
    expect(occupied).toBe(2);
  });

  // **The two readings come from one array.** Re-spelling the open filter
  // beside the count is what let them drift apart, and two deciders
  // agreeing is invisible to every behavioural case above.
  test("the writable list and the occupancy count never disagree", () => {
    const items = [
      it_(1, "OPEN", "Ready"),
      it_(2, "CLOSED", "Ready"),
      it_(3, "OPEN", "Backlog"),
      it_(4, "CLOSED", "Backlog"),
    ];
    const { writable, occupied } = readyPopulation(items);
    expect(
      occupied,
      "occupancy must be a count OF the writable list, not a second pass over the board",
    ).toBe(writable.filter(i => i.status === "Ready").length);
  });
});

describe("SC-2722: a repository argument is owner/name or it is refused", () => {
  test("a well-formed value parses", () => {
    expect(parseRepo("hornjason/rungate")).toEqual({ owner: "hornjason", name: "rungate" });
  });

  // The shape ai-review named on #1795: `split("/")[1]` is undefined and
  // the `!` only silences the type checker, so the undefined reaches
  // measureClosedIssues and surfaces as an opaque GraphQL error far from
  // the typo.
  test("a bare name with no slash is refused, not half-parsed", () => {
    expect(parseRepo("rungate")).toBeNull();
  });

  // **The decider is called.** Mutant G2c removed `main`'s call to
  // `parseRepo` and read ZERO: four green cases over a function nothing
  // invokes. That is the same shape as the inline guard they replaced,
  // one layer out — `runVerdict`'s unreachable UNMEASURED branch is the
  // worked instance. Asserted on code with comments stripped, because
  // this very block names the symbol in prose.
  test("main refuses a malformed --repo before any network call", () => {
    const src = readFileSync(join(import.meta.dir, "..", "scripts/board-mirror.ts"), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src, "a validator nothing calls is four green cases and no guard").toContain(
      "parseRepo(values.repo) === null",
    );
  });

  // ROUND 2, finding 2. Gated on `repo` alone, a plain Criteria sync that
  // happens to pass `--repo` paged every closed issue in the repository to
  // compute a depth it then never used.
  test("the throughput pass runs only when --ready asked for a depth", () => {
    const src = readFileSync(join(import.meta.dir, "..", "scripts/board-mirror.ts"), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src, "a depth nothing reads is not worth a full pass over the closed issues").toContain(
      "values.ready && repo",
    );
  });

  test("an empty side or an extra slash is refused", () => {
    expect(parseRepo("/rungate")).toBeNull();
    expect(parseRepo("hornjason/")).toBeNull();
    expect(parseRepo("")).toBeNull();
    expect(parseRepo("a/b/c")).toBeNull();
  });
});

/**
 * #2007 / SC-2741: a card already in Ready that has fallen outside the active
 * milestone is demoted by this writer too.
 *
 * `isReady` computes `to = Ready` for an unblocked, unclaimed incumbent, so the
 * change was filtered out as "no change" and the card held its slot forever,
 * while `scripts/board-ready.ts` demoted the same card through
 * `incumbentDecisions`. `scopeDemotions` asks that same decider, so the two
 * writers cannot disagree about incumbents.
 */
describe("#2007 / SC-2741: board-mirror demotes a Ready incumbent outside the active milestone", () => {
  const FOCUS6 = activeMilestone([{ milestone: "Engine Phase 6" }], "Engine");
  const card = (number: number, milestone: string | null, status = READY, labels: string[] = [], blockedByOpen = 0) => ({
    number,
    state: "OPEN",
    status,
    blockedByOpen,
    milestone,
    labels,
  });

  test("#2007: an unblocked, unclaimed Ready card in a later phase is demoted to Backlog", () => {
    const out = scopeDemotions([card(1, "Engine Phase 7")], FOCUS6, "work-this-next");
    expect(out.map(d => [d.item.number, d.to])).toEqual([[1, BACKLOG]]);
  });

  test("#2007: a Ready card with no milestone is demoted too", () => {
    expect(scopeDemotions([card(2, null)], FOCUS6, null).map(d => d.item.number)).toEqual([2]);
  });

  test("#2007: a Ready card inside the active milestone keeps its slot", () => {
    expect(scopeDemotions([card(3, "Engine Phase 6")], FOCUS6, null)).toEqual([]);
  });

  test("#2007: the expedite label keeps an out-of-scope card in Ready", () => {
    expect(scopeDemotions([card(4, "Engine Phase 7", READY, ["work-this-next"])], FOCUS6, "work-this-next")).toEqual([]);
  });

  test("#2007: a card whose blocker count could not be read is left alone, not demoted", () => {
    // Review of #2027: GitHub omits issueDependenciesSummary when the token
    // cannot read it, and \`?? 0\` made that read as "unblocked". The decider
    // refuses an unmeasured card; it has to be told the card is unmeasured.
    const unread = { ...card(6, "Engine Phase 7"), blockersRead: false };
    expect(scopeDemotions([unread], FOCUS6, null)).toEqual([]);
  });

  test("#2007: a card that is not in Ready is never touched", () => {
    expect(scopeDemotions([card(5, "Engine Phase 7", BACKLOG)], FOCUS6, null)).toEqual([]);
  });

  test("#2007: the writer merges these demotions into its Ready changes", () => {
    const src = readFileSync(join(import.meta.dir, "..", "scripts", "board-mirror.ts"), "utf-8");
    expect(src).toContain("scopeDemotions(writable");
    // One decider: the demotion comes from incumbentDecisions, not a predicate of this file's own.
    expect(src).toContain("incumbentDecisions(");
  });
});

/**
 * #2062 / SC-2609: an engine issue placed in a phase by hand gets the queue label.
 *
 * Measured 2026-11-12 on #2020: milestoning six issues into Pipeline Phase 6 by
 * hand left them without `engine`, and `queue-label` (B6) fell 12 of 12 → 6 of
 * 12. That reading counts open issues in the engine's milestone family, so the
 * repair must pick the same population (`inMilestoneFamily`) or the two disagree.
 *
 * Broken to prove it: dropping the family test labels #3, #4, #5 and #7 below;
 * dropping the has-label test labels #2; dropping the open test labels #6. Each
 * turns the first case red.
 */
describe("#2062 / SC-2609: board-mirror --queue-label labels every engine-phase issue lacking the queue label", () => {
  type Row = { number: number; state: string; milestone: string | null; labels: string[]; labelsTruncated?: boolean };
  const row = (number: number, milestone: string | null, labels: string[] = [], extra: Partial<Row> = {}): Row => ({
    number,
    state: "OPEN",
    milestone,
    labels,
    ...extra,
  });

  test("SC-2609: only an open issue in the engine family without the label is repaired", () => {
    const r = queueLabelRepairs(
      [
        row(1, "Pipeline Phase 6 — the board's state is a reading"),
        row(2, "Pipeline Phase 6 — the board's state is a reading", ["engine"]),
        row(3, "Convergence Phase 5 — the instruments"),
        row(4, null),
        row(5, "Pipelines Phase 2"),
        row(6, "Pipeline Phase 7 — nothing is hand-run", [], { state: "CLOSED" }),
        row(7, "Issue intake"),
      ],
      "Pipeline",
      "engine",
    );
    expect(r).toEqual({ add: [1], unreadable: [] });
  });

  test("SC-2609: a cut label list is UNMEASURED rather than missing, unless the label was read", () => {
    const r = queueLabelRepairs(
      [
        row(8, "Pipeline Phase 6", ["a"], { labelsTruncated: true }),
        row(9, "Pipeline Phase 6", ["engine"], { labelsTruncated: true }),
      ],
      "Pipeline",
      "engine",
    );
    expect(r).toEqual({ add: [], unreadable: [8] });
  });

  /** A fake `gh`: one page of issues for the read, and every `issue edit` recorded. */
  const fakeGh = (nodes: object[]) => {
    const edits: string[][] = [];
    const exec = (args: readonly string[]): string => {
      if (args[0] === "api" && args[1] === "graphql") {
        return JSON.stringify({
          data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: "" }, nodes } } },
        });
      }
      if (args[0] === "issue" && args[1] === "edit") {
        edits.push([...args]);
        return "";
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };
    return { exec, edits };
  };
  const node = (number: number, milestone: string | null, labels: string[] = [], truncated = false) => ({
    number,
    state: "OPEN",
    title: `#${number}`,
    body: null,
    milestone: milestone === null ? null : { title: milestone },
    labels: { pageInfo: { hasNextPage: truncated }, nodes: labels.map(name => ({ name })) },
    blockedBy: { pageInfo: { hasNextPage: false }, nodes: [] },
  });
  const quiet = () => {};

  test("SC-2609: --write adds the label with one gh issue edit per repair, naming the repository", async () => {
    const gh = fakeGh([node(11, "Pipeline Phase 6"), node(12, "Pipeline Phase 6", ["engine"]), node(13, "Convergence Phase 2")]);
    const code = await queueLabelRun({
      repo: "o/r",
      prefix: "Pipeline",
      prefixUnmeasured: null,
      queueLabel: "engine",
      write: true,
      exec: gh.exec,
      log: quiet,
    });
    expect(code).toBe(0);
    expect(gh.edits).toEqual([["issue", "edit", "11", "--repo", "o/r", "--add-label", "engine"]]);
  });

  test("SC-2609: without --write it reports the repair and edits nothing", async () => {
    const gh = fakeGh([node(11, "Pipeline Phase 6")]);
    const lines: string[] = [];
    const code = await queueLabelRun({
      repo: "o/r",
      prefix: "Pipeline",
      prefixUnmeasured: null,
      queueLabel: "engine",
      write: false,
      exec: gh.exec,
      log: s => lines.push(s),
    });
    expect(code).toBe(0);
    expect(gh.edits).toEqual([]);
    expect(lines.join("\n")).toContain("#11");
  });

  test("SC-2609: no engine family, or no queue label, refuses and edits nothing", async () => {
    for (const cfg of [
      { prefix: null, prefixUnmeasured: "UNMEASURED: no rungate config", queueLabel: "engine" },
      { prefix: "Pipeline", prefixUnmeasured: null, queueLabel: null },
    ]) {
      const gh = fakeGh([node(11, "Pipeline Phase 6")]);
      const code = await queueLabelRun({ repo: "o/r", ...cfg, write: true, exec: gh.exec, log: quiet });
      expect(code).toBe(REFUSAL_EXIT);
      expect(gh.edits).toEqual([]);
    }
  });

  test("SC-2609: one cut label list refuses the whole run, so nothing is labelled from a partial read", async () => {
    const gh = fakeGh([node(11, "Pipeline Phase 6"), node(14, "Pipeline Phase 6", ["x"], true)]);
    const code = await queueLabelRun({
      repo: "o/r",
      prefix: "Pipeline",
      prefixUnmeasured: null,
      queueLabel: "engine",
      write: true,
      exec: gh.exec,
      log: quiet,
    });
    expect(code).toBe(REFUSAL_EXIT);
    expect(gh.edits).toEqual([]);
  });

  test("SC-2609: --queue-label needs --repo, and refuses to share a run with --project", async () => {
    // Two credentials, two modes (ADR-013): the label is an issue write made
    // with the job's own token, the Criteria cell a board write made with the
    // board token. One run holding both is the widening ADR-013 forbids.
    expect(await boardMirrorMain(["--queue-label"])).toBe(REFUSAL_EXIT);
    expect(await boardMirrorMain(["--queue-label", "--repo", "o/r", "--project", "PVT_x"])).toBe(REFUSAL_EXIT);
  });
});
