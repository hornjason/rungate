/**
 * #1553 / SC-2769: a generated rule file carries a `## Project-owned` section
 * for hand edits. Re-scaffold rewrites everything outside it and carries the
 * section forward verbatim, so a hand edit never freezes the rest of the
 * file. An edit OUTSIDE the section refuses the write, names the lines, and
 * leaves the file untouched (Jason, #1553, 2026-11-16).
 *
 * Before this, one hand-edited line froze the whole file: on 2026-11-16 five
 * of this repository's fourteen generated rule files were PRESERVED and took
 * no generator change at all (baseline recorded on #1553).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";

import { carryMarkedSection, splitMarked, PROJECT_OWNED_SECTION } from "../lib/scaffold/marked-section";
import { bodySha, declaredSha, decideRuleWrite, stampProvenance } from "../lib/rule-provenance";

const ROOT = resolve(import.meta.dir, "..");
const V1 = "---\ndescription: A generated rule for the marked-section cases\n---\n\n## The rule\n\n- Generated line one.\n- Generated line two.\n";
const V2 = "---\ndescription: A generated rule for the marked-section cases\n---\n\n## The rule\n\n- Generated line one, reworded by a newer generator.\n- Generated line two.\n";
const OURS = "## Project-owned\n\n- Never deploy on a Friday — our team's rule, 2026-11-16.\n- Keep this exact spacing:   three spaces.";

describe("#1553 / SC-2769: a hand edit inside ## Project-owned is never touched", () => {
  test("the generator changes, the section comes through byte for byte, and the rest is rewritten", () => {
    const existing = `${stampProvenance(V1)}\n${OURS}\n`;
    const d = decideRuleWrite(existing, V2);
    expect(d.action).toBe("update");
    expect(d.content).toContain(OURS);
    expect(d.content).toContain("reworded by a newer generator");
    expect(d.content).not.toContain("- Generated line one.\n");
    // and the file it writes is itself recognised next time: stamp == outside
    const again = decideRuleWrite(d.content!, V2);
    expect(again.action).toBe("update");
    expect(again.content).toBe(d.content);
  });

  test("a generated body ending in blank lines is adopted too — trailing blank lines are not an edit (review, #2285)", () => {
    const tailed = `${V1}\n`; // the body ends "\n\n", and the stamp covers both
    const created = decideRuleWrite(null, tailed);
    expect(created.action).toBe("create");
    for (const join of ["", "\n"]) {
      const existing = `${created.content}${join}${OURS}\n`;
      const d = decideRuleWrite(existing, tailed);
      expect([join, d.action]).toEqual([join, "update"]);
      expect(d.content).toContain(OURS);
    }
    // and a real edit outside, with the same tail, is still refused
    const edited = `${created.content!.replace("- Generated line two.", "- Edited.")}${OURS}\n`;
    expect(decideRuleWrite(edited, tailed).action).toBe("preserve");
  });

  test("a section placed mid-file is carried too, and lands at the end", () => {
    const stamped = stampProvenance(V1);
    const at = stamped.indexOf("## The rule");
    const existing = `${stamped.slice(0, at)}${OURS}\n\n${stamped.slice(at)}`;
    const d = decideRuleWrite(existing, V2);
    expect(d.action).toBe("update");
    expect(d.content!.endsWith(`${OURS}\n`)).toBe(true);
  });
});

describe("#1553 / SC-2769: an edit outside the section refuses, names the line, writes nothing", () => {
  test("a hand-changed generated line is named, and the decision carries no content", () => {
    const existing = `${stampProvenance(V1).replace("- Generated line two.", "- Generated line two, edited by hand.")}\n${OURS}\n`;
    const d = decideRuleWrite(existing, V2);
    expect(d.action).toBe("preserve");
    expect(d.content).toBeUndefined();
    expect(d.reason).toContain("Generated line two, edited by hand.");
    expect(d.reason).toContain("## Project-owned");
  });

  test("a file with no stamp and a section is refused, not adopted", () => {
    const d = decideRuleWrite(`${V1}\n${OURS}\n`, V2);
    expect(d.action).toBe("preserve");
    expect(d.content).toBeUndefined();
  });
});

describe("#1553 / SC-2769: the pieces", () => {
  test("splitMarked finds the section through the section reader, and is null without one", () => {
    expect(splitMarked(V1)).toBeNull();
    const s = splitMarked(`${stampProvenance(V1)}\n${OURS}\n`);
    expect(s?.section).toBe(OURS);
    expect(declaredSha(stampProvenance(V1))).toBe(bodySha(s!.outside));
    expect(PROJECT_OWNED_SECTION.heading.test("## Project-owned")).toBe(true);
  });

  test("the split is anchored where the heading matched, not where its text first recurs (review, #2285)", () => {
    // The section's exact text also appears earlier, mid-line, where the
    // heading regex (line-anchored) does not match but a substring search does.
    const decoy = `An example, inline: ${OURS} (end of example)`;
    const existing = `${stampProvenance(V1)}${decoy}\n\n${OURS}\n`;
    const s = splitMarked(existing);
    expect(s?.section).toBe(OURS);
    // the decoy line survives whole, and the real section is gone from outside
    expect(s?.outside).toContain(decoy);
    expect(s!.outside.split(OURS).length - 1).toBe(1);
  });

  test("carryMarkedSection appends the section verbatim after the generated text", () => {
    expect(carryMarkedSection(V2, OURS)).toBe(`${V2}\n${OURS}\n`);
  });

  test("adoption on a real generated rule file: append a section, and the next write carries it", () => {
    const real = readFileSync(join(ROOT, ".claude", "rules", "commands-routing.md"), "utf-8");
    expect(declaredSha(real)).toBe(bodySha(real)); // stamped and untouched
    const generated = real.replace(/^generated-sha: [0-9a-f]{16}\n/m, "");
    const d = decideRuleWrite(`${real}\n${OURS}\n`, generated);
    expect(d.action).toBe("update");
    expect(d.content).toContain(OURS);
  });

  test("no template writes the heading, so it costs nothing until a project uses it", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (PROJECT_OWNED_SECTION.heading.test(readFileSync(p, "utf-8"))) hits.push(p);
      }
    };
    walk(join(ROOT, "templates"));
    expect(hits).toEqual([]);
  });
});
