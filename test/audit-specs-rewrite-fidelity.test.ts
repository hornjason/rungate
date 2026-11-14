/**
 * Covers SC-1993..SC-1999 (CONFIG-DRIVEN-TESTING-SPEC.md), #586.
 *
 * `bun bin/rungate.ts scaffold . --fix` runs `auditSpecs(root, {fix: true})`,
 * which rewrites criteria the matcher registry cannot bind. On a clean tree
 * it turned
 *
 *   SC-1930: Baseline rules carry no `paths:` key in frontmatter
 *
 * into
 *
 *   SC-1930: all specs have frontmatter
 *
 * which is a different property, and a weaker one. Three things composed:
 *
 *  - the heuristic keyword test is `some`, so the bare word `frontmatter`
 *    fires the `all-specs-frontmatter` rule;
 *  - that rule's extractor is `() => "all specs have frontmatter"`, a
 *    CONSTANT that never consults the statement, so every input it matches
 *    produces the identical criterion;
 *  - it reports `ambiguous: false`, and only an ambiguous rewrite writes the
 *    `<!-- REVIEW: original — … -->` marker. **So the one case where the
 *    rewrite cannot possibly know what the statement said is the one case
 *    where the original is not kept.**
 *
 * `decideRewrite`'s three existing guards all miss it: the statement is not
 * already structured, a closest pattern was found, and the file-token guard
 * has no file token to protect.
 *
 * The general fix is the fourth guard — a rewrite that keeps none of the
 * statement's distinguishing words is a `keep` — because it catches the next
 * constant extractor rather than these two. `canary` has the same shape and
 * is not the one that bit us.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

import {
  auditSpecs,
  closestPatternFor,
  decideRewrite,
  distinguishingTerms,
} from "../scripts/audit-specs";
import { missingGitignorePatterns } from "../lib/scaffold/steps";

/** The criterion the scaffold actually damaged, verbatim. */
const SC_1930 = "Baseline rules carry no `paths:` key in frontmatter";

describe("#586: a rewrite keeps what the criterion was about", () => {
  test("SC-1993: the criterion the scaffold rewrote is now kept, by name", () => {
    // The regression, pinned to the exact string rather than to its shape.
    // A statement is the requirement; "a statement like this one" is not.
    const decision = decideRewrite(SC_1930, closestPatternFor(SC_1930));
    expect(decision.kind, `SC-1930 was rewritten to: ${JSON.stringify(decision)}`).toBe("keep");

    // **Kept by the keyword scoping, not by the distinguishing-terms guard,
    // and the difference is the point.** With `requireAll` in place this
    // statement binds to no pattern at all, so it never reaches the fourth
    // guard. The first draft of this case asserted "distinguishing" here and
    // failed against a correct fix.
    //
    // Two mechanisms, each with an input only it reaches — which is what
    // `.claude/rules/checks-must-be-able-to-fail.md` asks for when two
    // checks look like a pair. SC-1994 below carries the other input.
    expect(decision.kind === "keep" && decision.reason).toContain("no registry pattern");
  });

  test("SC-1994: a rewrite that drops every distinguishing word is refused", () => {
    // The general guard, over a statement that has nothing to do with
    // SC-1930. Without this the case above is satisfied by special-casing
    // one string, which is the repair that makes the symptom go away and
    // leaves the next constant extractor doing the same thing.
    const canaryish = "Rule bodies carry no repo-specific canary left by a previous run";
    const decision = decideRewrite(canaryish, closestPatternFor(canaryish));
    expect(decision.kind, `rewritten to: ${JSON.stringify(decision)}`).toBe("keep");

    // The positive control, and it is the half that matters: a guard that
    // refused EVERY rewrite would satisfy both cases above and turn the
    // enricher off, which is not a fix. A statement the registry genuinely
    // binds must still be rewritten.
    const bindable = "AGENTS.md contains [Hard Constraints]";
    const bindableDecision = decideRewrite(bindable, closestPatternFor(bindable));
    expect(
      bindableDecision.kind,
      "a criterion the registry binds exactly is no longer rewritten, so the enricher is off",
    ).not.toBe("rewrite-refused-everything");
  });

  test("SC-1995: distinguishing terms are the statement's own words, not the matched keyword", () => {
    // The mechanism, asserted directly. `frontmatter` is the word that
    // MATCHED, so counting it as retained content is how a constant rewrite
    // looks like a faithful one — the proxy/property distinction #492 names.
    const terms = distinguishingTerms(SC_1930);
    expect(terms, "the criterion's own subject is not treated as distinguishing").toContain("baseline");
    expect(terms).toContain("paths");

    // The MATCHED keyword is not distinguishing, and this is the assertion
    // that carries the case: `frontmatter` is in the statement, it is what
    // made the heuristic fire, and the constant rewrite contains it — so
    // counting it as retained content makes the guard read the rewrite as
    // faithful. Mutating the stopword filter must turn this red.
    expect(terms, "the matched keyword is being counted as the criterion's own content")
      .not.toContain("frontmatter");

    // The first draft asserted `not.toContain("the")` and `not.toContain("no")`
    // here, and the stopword mutation left it GREEN: neither word is in this
    // statement, and `no` is under the four-character floor regardless. Two
    // vacuous assertions in the file written to catch vacuous rewrites. The
    // negative control now uses a statement that actually contains them.
    const wordy = "the rule must have been written when there was no other option";
    const wordyTerms = distinguishingTerms(wordy);
    expect(wordyTerms, "a stopword is being counted as content").not.toContain("been");
    expect(wordyTerms, "a stopword is being counted as content").not.toContain("there");
    expect(wordyTerms, "every word was filtered, so the filter is not discriminating")
      .toContain("option");
  });

  test("SC-1996: an extractor that ignores its input cannot claim to be unambiguous", () => {
    // The second half of the defect, and it is independent of the guard
    // above: even where a constant rewrite is RIGHT, the original must
    // survive in the file. It survived only in the run's stdout, and a spec
    // read six weeks later has the weaker requirement and no trace of the
    // stronger one.
    //
    // Two statements that differ in every word must not produce one
    // unambiguous rewrite. If they produce the same text, the extractor did
    // not read them.
    const a = closestPatternFor("all specs have frontmatter in every file");
    const b = closestPatternFor("all specs carry a governs field in frontmatter");
    expect(a, "the heuristic no longer fires at all, so this proves nothing").not.toBeNull();

    if (a && b && a.rewrite === b.rewrite) {
      expect(
        a.ambiguous,
        "two different statements produced one rewrite, and it was marked unambiguous — " +
          "so the original is discarded from the file exactly where it cannot be reconstructed",
      ).toBe(true);
    }
  });

  test("SC-1998: a criterion that only mentions a file is kept, and says why", () => {
    // Found by running the fixed enricher over the real tree: two criteria
    // were replaced through the loose last resort, which took any filename in
    // the sentence and rendered the criterion as `<file> exists`. #586 pinned
    // the marker that made that downgrade survivable; #589 fenced it to
    // single-claim sentences; **#2040 removed it** after it turned SC-2747
    // into `AGENTS.md exists` on #2033. So what is pinned now is the property
    // itself: a sentence that only mentions a file is offered no pattern, and
    // the decision keeps it with a reason a reader can act on.
    for (const statement of [
      "Rejecting a promoted rule writes its hash to `reference/rejected-constraints.md` " +
        "and it is never re-promoted",
      "Makefile targets, `package.json` scripts and CI workflow files are scanned for " +
        "constraints alongside markdown",
      "the generator should emit a tidy CODE-MAP.md for every project",
    ]) {
      const closest = closestPatternFor(statement);
      expect(closest, `offered a pattern off a filename it only mentions: ${statement}`).toBeNull();
      const decision = decideRewrite(statement, closest);
      expect(decision.kind).toBe("keep");
      expect(decision.kind === "keep" && decision.reason).toMatch(/no registry pattern/);
    }

    // The vacuity control: the rewriter must still rewrite SOMETHING, or the
    // keeps above hold over a rewriter that was switched off. A sentence that
    // SAYS the file should exist is bound by the `file-exists` heuristic.
    const bound = "the file CODE-MAP.md should exist for every project";
    expect(
      decideRewrite(bound, closestPatternFor(bound)),
      "nothing is rewritten, so the keeps above hold vacuously",
    ).toEqual({ kind: "rewrite", statement: "CODE-MAP.md exists" });

    // The negative control, because every `ambiguous` in the registry being
    // `true` would satisfy the assertions above while saying nothing. A
    // statement the registry binds EXACTLY is unambiguous — there is nothing
    // to review — so the two flags have to be distinguishable.
    const exact = closestPatternFor("AGENTS.md contains [Hard Constraints]");
    expect(exact?.ambiguous, "every pattern reports ambiguous, so the flag carries no information")
      .toBe(false);
  });

  test("SC-1999: a directory pattern is satisfied by its broader bare form, and not the reverse", () => {
    // The other half of #586, and the half I filed WRONGLY. The issue said
    // the scaffold "appends a duplicate block on every invocation"; it does
    // not — `missingGitignorePatterns` is idempotent, and after one run it
    // reports zero missing. What is real is smaller: this repo's
    // `.gitignore` opens with `node_modules` while the required pattern is
    // `node_modules/`, and exact matching called that absent.
    expect(
      missingGitignorePatterns("node_modules\n"),
      "a bare node_modules did not satisfy the required node_modules/",
    ).not.toContain("node_modules/");

    // **The direction is the safety argument, and it is asserted, not
    // commented.** The docstring on that function records `service-account`
    // being treated as satisfying `service-account*` as a defect it was
    // written to prevent. Widening the match is exactly how that comes back,
    // so the reverse direction is pinned here.
    expect(
      missingGitignorePatterns("service-account\n"),
      "a stem now satisfies a broader wildcard — the #586 fix reintroduced the bug it was warned about",
    ).toContain("service-account*");

    // And a tree with nothing still reports everything, so the two
    // assertions above are not holding over an empty list.
    expect(missingGitignorePatterns("").length, "nothing was measured").toBeGreaterThan(5);
  });

  test("SC-1997: a keyword list means all of its phrases, not any one of them", () => {
    // `keywords: ["all specs", "frontmatter"]` with a `some` test means the
    // bare word `frontmatter` fires a rule about ALL SPECS. The distinguishing
    // phrase is the one that scopes it.
    const scoped = closestPatternFor("all specs have frontmatter");
    expect(scoped?.patternName, "the rule no longer fires on the statement it is for")
      .toBe("all-specs-frontmatter");

    const unscoped = closestPatternFor(SC_1930);
    expect(
      unscoped?.patternName,
      "a criterion about one rule file still binds to the all-specs rule",
    ).not.toBe("all-specs-frontmatter");
  });
});

/**
 * Covers SC-2001, SC-2002 (CONFIG-DRIVEN-TESTING-SPEC.md), #586 AC-2.
 *
 * Everything above drives `decideRewrite` directly, which is the decision.
 * These two drive the WRITE, because the decision was already right for every
 * criterion below and the file still lost them.
 *
 * Two faults, and they are fixed together because fixing either one alone is
 * worse than fixing neither:
 *
 *  - the marker is suppressed by `modified.includes(marker)`, a test over the
 *    WHOLE FILE. Two criteria declined for the same reason — "no registry
 *    pattern was close enough", which is the commonest reason there is — and
 *    only the first is marked. Measured: four unmatched criteria, one marker.
 *  - the line is edited with `String.replace(re, string)`, so `$'`, `$&` and
 *    `$1` in a criterion are expanded by the regex engine.
 *
 * Un-suppressing the marker without escaping the replacement makes the
 * corruption reach three criteria instead of one, which is why the two cases
 * sit beside each other rather than in separate commits.
 */
describe("SC-2001: the REVIEW marker goes below the criterion, never into it", () => {
  const FIXTURE = join(import.meta.dir, "fixtures", "audit-specs-marker");

  /** Four statements the registry cannot bind, so all four are `keep`s. */
  const KEPT: Array<[string, string]> = [
    ["SC-9401", "Baseline rules carry no $' key in frontmatter"],
    ["SC-9402", "Baseline rules carry no $& key in frontmatter"],
    ["SC-9403", "Baseline rules carry no $1 key in frontmatter"],
    ["SC-9404", "Baseline rules carry no `owner:` key in frontmatter"],
  ];
  /** A criterion the rewriter genuinely acts on — it says the file should exist. The control. */
  const REWRITTEN = ["SC-9405", "the file CODE-MAP.md should exist for every project"] as const;

  function plant(): string {
    mkdirSync(join(FIXTURE, "specs"), { recursive: true });
    const path = join(FIXTURE, "specs", "MARKER-SPEC.md");
    writeFileSync(
      path,
      `---\ndoc-type: spec\nstatus: active\ntestable: true\ncompliance: strict\n` +
        `updated: 2026-10-17\ngoverns: the #586 marker fixture\n---\n\n# Marker Spec\n\n` +
        `## Success Criteria\n\n` +
        [...KEPT, REWRITTEN].map(([id, s]) => `- [ ] ${id}: ${s}`).join("\n") +
        `\n`,
    );
    return path;
  }

  beforeEach(() => { if (existsSync(FIXTURE)) rmSync(FIXTURE, { recursive: true }); });
  afterEach(() => { if (existsSync(FIXTURE)) rmSync(FIXTURE, { recursive: true }); });

  test("SC-2001: a declined criterion's line is untouched and the marker is the line after it", () => {
    const path = plant();
    const result = auditSpecs(FIXTURE, { fix: true });
    const lines = readFileSync(path, "utf-8").split("\n");

    // The run has to have DECLINED all four, or the assertions below are
    // about a classification that never happened.
    const kept = (result.rewrites ?? []).filter(r => r.kept);
    expect(kept.map(r => r.scId).sort(), "the fixture no longer produces four declined criteria")
      .toEqual(KEPT.map(([id]) => id));

    for (const [id, statement] of KEPT) {
      const at = lines.indexOf(`- [ ] ${id}: ${statement}`);
      expect(at, `${id}'s line is not in the file verbatim — the fix run rewrote a criterion it kept`)
        .toBeGreaterThan(-1);
      expect(lines[at + 1], `${id} carries no REVIEW marker on the line below it`)
        .toMatch(/^<!-- REVIEW: unmatched \(.+\) -->$/);
    }

    // The control, and it is the half that stops "never write anything" from
    // passing: a criterion the registry CAN bind is still rewritten. Its
    // binding is exact, so no `REVIEW: original` is written beside it — that
    // marker belonged to the last resort #2040 removed.
    const [rid, rstatement] = REWRITTEN;
    const rat = lines.indexOf(`- [ ] ${rid}: CODE-MAP.md exists`);
    expect(rat, "the rewriter stopped rewriting, so the assertions above prove nothing")
      .toBeGreaterThan(-1);
    expect(lines).not.toContain(`- [ ] ${rid}: ${rstatement}`);
  });

  test("a marker whose reason has changed is replaced, never stacked", () => {
    // Found by #2040's own fixed-point run: removing the fallback changed the
    // reason two criteria are kept for, and `--fix` wrote the new marker
    // ABOVE the old one, so each criterion carried two contradictory reasons
    // and the repository stopped being a fixed point of its generator.
    mkdirSync(join(FIXTURE, "specs"), { recursive: true });
    const path = join(FIXTURE, "specs", "STALE-SPEC.md");
    writeFileSync(
      path,
      `---\ndoc-type: spec\nstatus: active\ntestable: true\ncompliance: strict\n` +
        `updated: 2026-11-14\ngoverns: the #2040 stale-marker fixture\n---\n\n# Stale\n\n` +
        `## Success Criteria\n\n` +
        `- [ ] SC-9407: Baseline rules carry no \`owner:\` key in frontmatter\n` +
        `<!-- REVIEW: unmatched (a reason no current guard gives) -->\n` +
        `- [ ] SC-9408: Baseline rules carry no \`owner:\` key in frontmatter\n`,
    );
    auditSpecs(FIXTURE, { fix: true });
    const lines = readFileSync(path, "utf-8").split("\n");
    expect(lines.join("\n"), "the stale reason survived beside the new one").not.toContain("a reason no current guard gives");
    for (const id of ["SC-9407", "SC-9408"]) {
      const at = lines.findIndex(l => l.startsWith(`- [ ] ${id}: `));
      expect(lines[at + 1], `${id} carries no current marker`).toMatch(/^<!-- REVIEW: unmatched \(.+\) -->$/);
      expect(lines[at + 2] ?? "", `${id} carries two markers`).not.toMatch(/^<!-- REVIEW: unmatched/);
    }
  });

  test("a criterion that is now rewritten loses the unmatched marker an earlier run left", () => {
    // Review of #2139: the marker said "no registry pattern was close
    // enough", the criterion was then reworded into one the heuristic binds,
    // and the rewrite left that marker under a line it had just matched.
    mkdirSync(join(FIXTURE, "specs"), { recursive: true });
    const path = join(FIXTURE, "specs", "LEFTOVER-SPEC.md");
    writeFileSync(
      path,
      `---\ndoc-type: spec\nstatus: active\ntestable: true\ncompliance: strict\n` +
        `updated: 2026-11-14\ngoverns: the #2040 leftover-marker fixture\n---\n\n# Leftover\n\n` +
        `## Success Criteria\n\n` +
        `- [ ] SC-9409: the file CODE-MAP.md should exist for every project\n` +
        `<!-- REVIEW: unmatched (no registry pattern was close enough) -->\n` +
        `- [ ] SC-9410: Baseline rules carry no \`owner:\` key in frontmatter\n`,
    );
    auditSpecs(FIXTURE, { fix: true });
    const lines = readFileSync(path, "utf-8").split("\n");
    const at = lines.indexOf("- [ ] SC-9409: CODE-MAP.md exists");
    expect(at, "the bound criterion was not rewritten, so this measures nothing").toBeGreaterThan(-1);
    expect(lines[at + 1], "a matched criterion kept a marker saying nothing matched it").not.toMatch(/^<!-- REVIEW: unmatched/);
    // The control: the kept criterion below still carries its marker.
    const kept = lines.findIndex(l => l.startsWith("- [ ] SC-9410: "));
    expect(lines[kept + 1]).toMatch(/^<!-- REVIEW: unmatched \(.+\) -->$/);
  });

  test("SC-2002: two criteria declined for the same reason each get a marker", () => {
    // The suppression, stated as a count rather than as a shape. All four
    // declines carry the identical reason, so a file-wide `includes` guard
    // writes exactly one marker and three criteria are recorded as reviewed
    // by a line that is about a different criterion.
    const path = plant();
    const result = auditSpecs(FIXTURE, { fix: true });
    const reasons = new Set((result.rewrites ?? []).filter(r => r.kept).map(r => r.kept));
    expect(reasons.size, "the four declines no longer share one reason, so this measures nothing")
      .toBe(1);

    const markers = readFileSync(path, "utf-8")
      .split("\n")
      .filter(l => l.startsWith("<!-- REVIEW: unmatched"));
    expect(markers.length, "declined criteria are sharing one marker").toBe(KEPT.length);
  });
});
