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
 */
const CORPUS = [
  "1162", "1175", "1176", "1177", "1184", "1187", "1195",
  "1196", "1226", "1239", "1269", "1286", "1454", "1456",
] as const;

const REPO = "hornjason/rungate";
const OUT = join(import.meta.dir, "..", "test", "fixtures", "finding-dedupe-corpus.json");

function gh(args: string[]): string {
  const p = Bun.spawnSync(["gh", ...args], { env: { ...process.env, GH_TOKEN: undefined as never } });
  if (p.exitCode !== 0) {
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${new TextDecoder().decode(p.stderr).slice(0, 300)}`);
  }
  return new TextDecoder().decode(p.stdout);
}

const findings: Array<{ id: string; title: string; body: string }> = [];
const missing: string[] = [];

for (const id of CORPUS) {
  let raw: string;
  try {
    raw = gh(["issue", "view", id, "--repo", REPO, "--json", "number,title,body"]);
  } catch {
    // REFUSE rather than skip. A corpus quietly short by one issue produces a
    // table that is wrong in a way nothing in the output says — which is the
    // exact failure mode #1365 is about, rebuilt in the tool that fixes it.
    missing.push(id);
    continue;
  }
  const j = JSON.parse(raw) as { number: number; title: string; body: string | null };
  findings.push({ id: String(j.number), title: j.title, body: j.body ?? "" });
}

if (missing.length > 0) {
  console.error(
    `REFUSING: ${missing.length} of ${CORPUS.length} declared issues could not be read ` +
      `(${missing.join(", ")}). A corpus short by one issue is a table that is wrong ` +
      `and does not say so. Nothing was written.`,
  );
  process.exit(1);
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
