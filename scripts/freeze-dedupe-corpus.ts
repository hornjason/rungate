#!/usr/bin/env bun
/**
 * Freeze the dedupe corpus into a fixture, so the tables in
 * `lib/finding-arbiter.ts` stop being readings nobody can retake (#1365).
 *
 * ## What was wrong
 *
 * `DUPLICATE_CONTAINMENT_RATIO` and `DUPLICATE_MIN_SHARED_QUANTITIES` are
 * justified by a table over 946 pairs — 44 findings, `C(44,2) = 946`. That
 * table was measured live against the issue tracker and **no corpus was
 * stored**. The tracker has moved, so the numbers cannot be re-derived by
 * anyone, including anyone who wants to argue they are wrong. An
 * unreproducible table reads as the strongest evidence in the file and is the
 * one thing in it that cannot be shown to be mistaken.
 *
 * **This does NOT recover those 946 pairs.** They are gone. What it does is
 * stop the next table having the same property: this script fetches the
 * declared issues once, writes their bodies to a fixture, and from then on
 * `scripts/print-dedupe-pair-table.ts` reads ONLY that fixture.
 *
 * ## Run it only to re-freeze
 *
 * ```
 * GITHUB_TOKEN="$(env -u GH_TOKEN gh auth token)" bun scripts/freeze-dedupe-corpus.ts
 * ```
 *
 * It writes `test/fixtures/finding-dedupe-corpus.json` and nothing else. The
 * output is COMMITTED, the same treatment `finding-incident-1195-1196.json`,
 * `finding-incident-1175-1177.json` and `finding-distinct-1239.json` already
 * get. Re-freezing is a deliberate act that changes the tables, so it belongs
 * in a commit that also updates them — not in a test run and not in CI.
 */
import { writeFileSync } from "fs";
import { join } from "path";
import { localCalendarDay } from "../lib/local-calendar-day";

/**
 * THE CORPUS, DECLARED RATHER THAN DISCOVERED.
 *
 * **A finding is a member when the docblocks name it inside a PAIR or a
 * CLUSTER — never when they name it as an attribution.** Those are the two
 * shapes an `#NNNN` takes in `lib/finding-arbiter.ts` and they mean opposite
 * things. `1175/1177` and the six-issue `lib/bash-write-guard.ts` cluster are
 * findings the cut was measured *over*. A parenthetical after a heading —
 * `(#1301)`, `(#1318)`, `(#1333)`, `(#1385)`, `(#1536)`, and #1365 itself — is
 * the change that moved the cut. Including those would grow the corpus every
 * time somebody edits a constant, which is the opposite of freezing it.
 *
 * Applying that rule by hand found two defects in the first draft of this
 * list: it carried #1301 and #1385, which are attributions, and it was
 * **missing #1269 and #1286**, which line 493 of the arbiter names as one of
 * the four pairs `qty>=2 AND loc>=1` flags. A corpus short by a measured pair
 * is the exact fault #1365 exists to stop, so it is written down rather than
 * quietly corrected.
 *
 * Declared and not derived from a grep of the docblock on purpose: a corpus
 * that recomputes itself from the prose it justifies moves whenever the prose
 * does, which is the property this issue exists to remove.
 *
 * **But a hand-applied rule is one nobody can check, and this list had
 * already been wrong once.** So every id carries the sentence that admits it,
 * in `MEMBERSHIP` below, and `test/dedupe-corpus-membership.test.ts` refuses
 * an id whose sentence is absent from `lib/finding-arbiter.ts`, does not name
 * it, or sits inside the table this corpus GENERATES. That last clause is the
 * one that matters: without it a member could be justified by the output it
 * produced, which is circular, and a reviewer was right to say the prose rule
 * alone could not rule that out.
 */
export const CORPUS = [
  "1162", "1175", "1176", "1177", "1184", "1187", "1195",
  "1196", "1226", "1239", "1269", "1286", "1454", "1456",
] as const;

/** The admitting sentences, verbatim from `lib/finding-arbiter.ts`. */
const CLUSTER =
  "#1175, #1176, #1177, #1184, #1195, #1196 all landed on `lib/bash-write-guard.ts` in a " +
  "single afternoon and name the same functions while describing genuinely different defects.";
const QTY_ROW = "| `qty>=2 AND loc>=1` | 4 — 1175/1177, 1195/1196, 1269/1286, 1162/1226 |";
const CONTAINMENT_ROW = "| containment >= 0.6 | 3 — 1175/1177, 1195/1196, 1195/1239 |";
const PAIR_1454_1456 = "Both true duplicates on that corpus survive (#1456/#1454 at 0.900,";
const PAIR_1187 =
  "#1187 is that shape: it reproduces #1175's 234 and 5,060 and #1176's 60 verbatim, and " +
  "under measurement alone it is indistinguishable from a duplicate of each.";

/**
 * Why each id is in `CORPUS`, as a verbatim sentence from the arbiter.
 *
 * Each value must appear in `lib/finding-arbiter.ts` with comment leaders and
 * runs of whitespace collapsed, must contain the id it admits, and must lie
 * OUTSIDE the generated pair table. One sentence may admit several ids — the
 * `bash-write-guard` cluster admits six — which is the point: a reader can see
 * at a glance which ids share a justification and how thin the thinnest one is.
 */
export const MEMBERSHIP: Record<string, string> = {
  // The six-issue cluster the quantity threshold was tuned to KEEP APART.
  "1175": CLUSTER,
  "1176": CLUSTER,
  "1177": CLUSTER,
  "1184": CLUSTER,
  "1195": CLUSTER,
  "1196": CLUSTER,
  // The four pairs the quantity arm flags, from the 946-pair table's own row.
  "1162": QTY_ROW,
  "1226": QTY_ROW,
  "1269": QTY_ROW,
  "1286": QTY_ROW,
  // The containment row names #1239 as the distinct pair against #1195.
  "1239": CONTAINMENT_ROW,
  // A true duplicate pair, named with its score.
  "1454": PAIR_1454_1456,
  "1456": PAIR_1454_1456,
  // #1187 is the thinnest admission here and it is a real one: the
  // `duplicateOverlap` header names it paired with #1175 AND #1176 by number,
  // and says measurement alone cannot tell it from a duplicate of EACH. It is
  // not an attribution — the same docblock records that the cross-reference
  // escape removes only "2 false positives of 7", so #1187's pairs are
  // measured members that mostly survive. #1187 cites #1175 and #1177 by
  // number and does NOT cite #1176, so #1176/#1187 is precisely the survivor
  // that header predicts.
  "1187": PAIR_1187,
};

const REPO = "hornjason/rungate";
const OUT = join(import.meta.dir, "..", "test", "fixtures", "finding-dedupe-corpus.json");

function gh(args: string[]): string {
  const p = Bun.spawnSync(["gh", ...args], { env: { ...process.env, GH_TOKEN: undefined as never } });
  if (p.exitCode !== 0) {
    const why = new TextDecoder().decode(p.stderr).trim().replace(/\s+/g, " ").slice(0, 300);
    throw new Error(
      `gh ${args.slice(0, 3).join(" ")} exited ${p.exitCode}: ${why === "" ? "(no stderr)" : why}`,
    );
  }
  return new TextDecoder().decode(p.stdout);
}

/**
 * Everything below runs ONLY as a CLI.
 *
 * `test/dedupe-corpus-membership.test.ts` imports `CORPUS` and `MEMBERSHIP`
 * from this module, and an import that fetched fourteen issues as a side
 * effect would make reading two constants cost fourteen network calls — and
 * would fail the import for reasons that have nothing to do with the test.
 */
function main(): number {
const findings: Array<{ id: string; title: string; body: string }> = [];
const missing: Array<{ id: string; why: string }> = [];

for (const id of CORPUS) {
  // **Every way reading one id can fail lands in `missing`.** The spawn, the
  // parse, and the shape are one try on purpose: a `gh` that exits 0 and
  // prints an update notice ahead of its JSON is a bad read of ONE id, and
  // letting its `SyntaxError` escape would kill the run for all fourteen with
  // a stack trace — the designed refusal, bypassed by the one failure mode
  // that does not announce itself as one.
  //
  // REFUSE rather than skip. A corpus quietly short by one issue produces a
  // table that is wrong in a way nothing in the output says — which is the
  // exact failure mode #1365 is about, rebuilt in the tool that fixes it.
  //
  // **And carry the reason, never a bare id.** `gh` fails for reasons that
  // are not about this issue at all — unauthenticated, rate-limited, not on
  // PATH, no network — and under every one of them all fourteen ids fail
  // identically. A refusal listing fourteen numbers reads as "the corpus is
  // wrong" when the true state is "nothing was read". That is the same
  // conversion `.claude/rules/config-access.md` forbids by name: a bare
  // `catch` turning corruption into absence.
  try {
    const raw = gh(["issue", "view", id, "--repo", REPO, "--json", "number,title,body"]);
    const j = JSON.parse(raw) as { number?: number; title?: string; body?: string | null };
    // A shape check, because `JSON.parse` succeeds on plenty of things that
    // are not an issue. Without it a missing `number` is frozen as the string
    // `"undefined"` and the corpus is wrong in exactly the silent way above.
    if (typeof j.number !== "number" || typeof j.title !== "string") {
      throw new Error(`gh returned no issue shape — got ${JSON.stringify(j).slice(0, 120)}`);
    }
    findings.push({ id: String(j.number), title: j.title, body: j.body ?? "" });
  } catch (e) {
    missing.push({ id, why: e instanceof Error ? e.message : String(e) });
  }
}

if (missing.length > 0) {
  const all = missing.length === CORPUS.length;
  console.error(
    `REFUSING: ${missing.length} of ${CORPUS.length} declared issues could not be read. ` +
      `A corpus short by one issue is a table that is wrong and does not say so. ` +
      `Nothing was written.`,
  );
  for (const m of missing) console.error(`  #${m.id}: ${m.why}`);
  if (all) {
    // Every id failing is a statement about the reader, not about the corpus
    // — the reasons above say which reader fault it was.
    console.error(
      `  ALL ${CORPUS.length} failed, which is a statement about \`gh\` and not about the ` +
        `corpus. The reasons above say which; fix the reader before editing CORPUS.`,
    );
  }
  return 1;
}

const pairs = (findings.length * (findings.length - 1)) / 2;
writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      frozenAt: localCalendarDay(),
      repo: REPO,
      declaredBy: "scripts/freeze-dedupe-corpus.ts — CORPUS",
      note:
        "Bodies as the tracker held them on frozenAt. This is NOT the 946-pair corpus the " +
        "original tables were measured over; that one was never stored and is unrecoverable. " +
        "Regenerate the tables with `bun scripts/print-dedupe-pair-table.ts`.",
      findings: findings.sort((a, b) => Number(a.id) - Number(b.id)),
    },
    null,
    2,
  )}\n`,
);

console.log(`froze ${findings.length} findings (${pairs} pairs) to ${OUT}`);
  return 0;
}

if (import.meta.main) process.exit(main());
