/**
 * #2037: every writer of Ready takes the active milestone from the same
 * population — every OPEN issue in the repository — so the hand-run
 * `board-mirror` and the `board-ready` workflow cannot pick different
 * focuses. Before this, `board-mirror` read the open cards on the project
 * board, so an earlier-phase issue that never reached the board (a failed
 * intake run) moved the hand-run writer's focus and nobody else's.
 *
 * Covers SC-2741 (SPEC-TO-BOARD-PIPELINE-SPEC.md): "Ready holds only work
 * from the active milestone, the lowest Pipeline phase with an open issue".
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { OPEN_MILESTONES_QUERY, readOpenIssueMilestones } from "../lib/active-milestone";

const ROOT = join(import.meta.dir, "..");
const src = (f: string) => readFileSync(join(ROOT, f), "utf8");

/** A fake GraphQL function serving `pages` in order, recording each cursor. */
function pager(pages: Array<{ milestones: (string | null)[]; next: string | null } | "missing">) {
  const cursors: (string | null)[] = [];
  let i = 0;
  const gql = async (query: string, vars: Record<string, unknown>) => {
    expect(query).toBe(OPEN_MILESTONES_QUERY);
    cursors.push((vars.c as string | null) ?? null);
    const p = pages[i++];
    if (p === "missing") return { repository: null };
    return {
      repository: {
        issues: {
          pageInfo: { hasNextPage: p.next !== null, endCursor: p.next },
          nodes: p.milestones.map(m => ({ milestone: m === null ? null : { title: m } })),
        },
      },
    };
  };
  return { gql, cursors };
}

describe("#2037: readOpenIssueMilestones", () => {
  test("reads every page of the repository's open issues, milestone or not", async () => {
    const p = pager([
      { milestones: ["Pipeline Phase 6 — x", null], next: "c1" },
      { milestones: ["Pipeline Phase 7 — y"], next: null },
    ]);
    const open = await readOpenIssueMilestones(p.gql, "o", "r");
    expect(open).toEqual([
      { milestone: "Pipeline Phase 6 — x" },
      { milestone: null },
      { milestone: "Pipeline Phase 7 — y" },
    ]);
    expect(p.cursors).toEqual([null, "c1"]);
  });

  test("a read that returns no issues connection is UNMEASURED (null), never a short list", async () => {
    // A shorter list is exactly what a repository with fewer open issues
    // produces, and it would move the focus forward silently.
    const first = pager(["missing"]);
    expect(await readOpenIssueMilestones(first.gql, "o", "r")).toBeNull();
    const later = pager([{ milestones: ["Pipeline Phase 6 — x"], next: "c1" }, "missing"]);
    expect(await readOpenIssueMilestones(later.gql, "o", "r")).toBeNull();
  });

  test("a page that cannot say whether more exist is UNMEASURED, not the last page", async () => {
    const gql = async () => ({
      repository: { issues: { pageInfo: {}, nodes: [{ milestone: { title: "Pipeline Phase 7 — y" } }] } },
    });
    expect(await readOpenIssueMilestones(gql, "o", "r")).toBeNull();
  });

  test("the query asks for OPEN issues only", () => {
    expect(OPEN_MILESTONES_QUERY).toMatch(/states:\s*\[OPEN\]/);
  });
});

describe("#2037: every writer of Ready reads the same population", () => {
  /** The argument text of each `activeMilestone(` call in a source file. */
  const focusArguments = (text: string): string[] => {
    const out: string[] = [];
    for (let at = text.indexOf("activeMilestone("); at !== -1; at = text.indexOf("activeMilestone(", at + 1)) {
      // Skip the import line and type references.
      const lineStart = text.lastIndexOf("\n", at) + 1;
      if (/^\s*(import|export|\*|\/\/)/.test(text.slice(lineStart, at))) continue;
      let depth = 0;
      let k = at + "activeMilestone".length;
      for (; k < text.length; k++) {
        if (text[k] === "(") depth++;
        else if (text[k] === ")" && --depth === 0) break;
      }
      out.push(text.slice(at + "activeMilestone(".length, k));
    }
    return out;
  };

  test("board-mirror computes the focus from the repository's open issues, never from board cards", () => {
    const text = src("scripts/board-mirror.ts");
    const args = focusArguments(text);
    expect(args.length, "board-mirror no longer computes a focus, so this case proves nothing").toBe(1);
    // The argument is ONE identifier, and that identifier is assigned from
    // the repository read. Asserting "not `items`" alone goes green under a
    // rename of the board slice, which is the cheapest wrong fix.
    const ident = args[0].split(",")[0].trim();
    expect(ident, "the focus is computed from an expression, not the repository read").toMatch(/^[A-Za-z_]\w*$/);
    const assigned = new RegExp(`const ${ident}\\s*=[^;]*?await readOpenIssueMilestones\\(`, "s");
    expect(text, `\`${ident}\` is not the repository's open issues (#2037)`).toMatch(assigned);
  });

  test("board-mirror demotes out of scope only on a focus it actually read", () => {
    // An unread focus is `title: null`, and every incumbent is out of scope
    // against that, so an unguarded call empties Ready whenever --repo is
    // missing or the repository read fails.
    const text = src("scripts/board-mirror.ts");
    const ident = focusArguments(text)[0].split(",")[0].trim();
    const calls = text.split("scopeDemotions(writable").length - 1;
    expect(calls).toBe(1);
    const guarded = new RegExp(`if \\(${ident} !== null\\) \\{\\s*for \\(const d of scopeDemotions\\(writable`);
    expect(text, "scopeDemotions runs on a focus nobody read").toMatch(guarded);
  });

  test("board-ready and work-status keep their repository-wide reads", () => {
    // Both already read every open issue (board-ready's labels pass pages
    // `states:[OPEN]`; work-status filters its rollup to open). Pinned so a
    // later edit cannot narrow either to a board or candidate slice.
    const ready = focusArguments(src("scripts/board-ready.ts"));
    expect(ready.length).toBeGreaterThan(0);
    for (const a of ready) expect(a.trim().startsWith("openMilestones")).toBe(true);
    const status = focusArguments(src("scripts/work-status.ts"));
    expect(status.length).toBeGreaterThan(0);
    for (const a of status) expect(a.trim().startsWith("open.map(")).toBe(true);
  });
});
