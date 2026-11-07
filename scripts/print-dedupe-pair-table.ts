#!/usr/bin/env bun
/**
 * Print the dedupe pair table from the frozen corpus — the command the
 * `lib/finding-arbiter.ts` docblocks cite instead of a reading (#1365).
 *
 * ```
 * bun scripts/print-dedupe-pair-table.ts
 * bun scripts/print-dedupe-pair-table.ts --control   # prove the table can move
 * ```
 *
 * **It reads `test/fixtures/finding-dedupe-corpus.json` and nothing else.** No
 * network, no `gh`, no tracker. That is the whole point: every number it
 * prints is re-derivable by anyone with the repository, including anyone who
 * wants to argue a constant is wrong.
 *
 * ## What it deliberately does NOT print
 *
 * **The floor sweep.** `DUPLICATE_CONTAINMENT_MIN_KEYS` is applied inside
 * `containmentOf`, which returns `0` below it. Sweeping the floor means
 * computing the ratio at floors the shipped function refuses, and the only
 * way to do that is to spell the ratio a second time here — which that
 * function's own header forbids by name: a second decider over the same
 * question, where a mutation of either leaves the other holding the case up
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape). The
 * per-finding key counts below are what a reader needs to see which findings
 * the floor eats; the sweep itself needs a change to the arbiter, not to this
 * script.
 *
 * ## The negative control
 *
 * `--control` appends a byte-identical clone of the first corpus finding
 * under a fresh id. A clone is contained in its original at `1.000` by
 * construction, so the `>= 0.8` row MUST rise by at least one and a new pair
 * MUST appear. If the table does not move, the instrument is not reading the
 * corpus and every row above it is decoration.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  DUPLICATE_CONTAINMENT_RATIO,
  DUPLICATE_CONTAINMENT_MIN_KEYS,
  DUPLICATE_MIN_SHARED_QUANTITIES,
  DUPLICATE_MIN_SHARED_LOCATIONS,
  containmentOf,
  duplicateOverlap,
  quantityKeys,
  sharedKeys,
  symptomKeys,
  type Finding,
} from "../lib/finding-arbiter";

/**
 * The markers the binding test cuts on.
 *
 * `test/dedupe-corpus-table.test.ts` extracts everything between them from
 * BOTH this script's stdout and the `lib/finding-arbiter.ts` docblock, and
 * refuses when they differ. So the table in that docblock is this script's
 * output or the suite is red — which is the one thing #1365 is actually for.
 */
export const TABLE_BEGIN = "<!-- BEGIN dedupe-pair-table -->";
export const TABLE_END = "<!-- END dedupe-pair-table -->";

const FIXTURE = join(import.meta.dir, "..", "test", "fixtures", "finding-dedupe-corpus.json");

interface Corpus {
  frozenAt: string;
  repo: string;
  note: string;
  findings: Array<{ id: string; title: string; body: string }>;
}

const corpus = JSON.parse(readFileSync(FIXTURE, "utf8")) as Corpus;
const findings: Finding[] = corpus.findings.map(f => ({ id: f.id, title: f.title, body: f.body }));

const control = process.argv.includes("--control");
if (control) {
  const first = findings[0] as Finding;
  findings.push({ id: `${first.id}-clone`, title: first.title, body: first.body });
}

const pairs: Array<{
  a: Finding;
  b: Finding;
  containment: number;
  quantities: number;
  locations: number;
  duplicate: boolean;
}> = [];

for (let i = 0; i < findings.length; i++) {
  for (let j = i + 1; j < findings.length; j++) {
    const a = findings[i] as Finding;
    const b = findings[j] as Finding;
    const keys = sharedKeys(a, b);
    const quantities = keys.filter(k => k.startsWith("qty:")).length;
    pairs.push({
      a,
      b,
      containment: containmentOf(a, b),
      quantities,
      locations: keys.length - quantities,
      duplicate: duplicateOverlap(a, b).duplicate,
    });
  }
}

const label = (p: (typeof pairs)[number]) => `${p.a.id}/${p.b.id}`;
const sameSymptom = pairs.filter(
  p => p.quantities >= DUPLICATE_MIN_SHARED_QUANTITIES && p.locations >= DUPLICATE_MIN_SHARED_LOCATIONS,
);
const over6 = pairs.filter(p => p.containment >= 0.6);
const overCut = pairs.filter(p => p.containment >= DUPLICATE_CONTAINMENT_RATIO);
const flagged = pairs.filter(p => p.duplicate);
const onFloor = findings.filter(f => symptomKeys(f).length < DUPLICATE_CONTAINMENT_MIN_KEYS);

const names = (list: typeof pairs) => (list.length === 0 ? "none" : list.map(label).join(", "));

const out: string[] = [];
out.push(TABLE_BEGIN);
out.push(`Corpus: ${findings.length} findings, ${pairs.length} pairs, frozen ${corpus.frozenAt}.`);
out.push("Regenerate with `bun scripts/print-dedupe-pair-table.ts`.");
out.push("");
out.push("| rule | pairs | which |");
out.push("|---|---|---|");
out.push(
  `| \`qty>=${DUPLICATE_MIN_SHARED_QUANTITIES} AND loc>=${DUPLICATE_MIN_SHARED_LOCATIONS}\` | ${sameSymptom.length} | ${names(sameSymptom)} |`,
);
out.push(`| containment >= 0.6 | ${over6.length} | ${names(over6)} |`);
out.push(
  `| containment >= ${DUPLICATE_CONTAINMENT_RATIO} (shipped) | ${overCut.length} | ${names(overCut)} |`,
);
out.push(`| either arm — what the arbiter calls DUPLICATE | ${flagged.length} | ${names(flagged)} |`);
out.push("");
out.push(
  `Findings under the floor of ${DUPLICATE_CONTAINMENT_MIN_KEYS} identity keys, which the ` +
    `containment arm scores 0 against everything: ${onFloor.length === 0 ? "none" : onFloor.map(f => `#${f.id}`).join(", ")}.`,
);
out.push(TABLE_END);

console.log(out.join("\n"));

if (!control) {
  console.log("");
  console.log("Per-finding key counts (not part of the bound table):");
  for (const f of findings) {
    console.log(
      `  #${f.id}  identity ${String(symptomKeys(f).length).padStart(3)}  quantity ${String(quantityKeys(f).length).padStart(3)}`,
    );
  }
  console.log("");
  console.log("Every pair scoring above 0, strongest first:");
  for (const p of [...pairs].filter(p => p.containment > 0).sort((x, y) => y.containment - x.containment)) {
    console.log(
      `  ${label(p).padEnd(14)} containment ${p.containment.toFixed(3)}  qty ${p.quantities}  loc ${p.locations}${p.duplicate ? "  DUPLICATE" : ""}`,
    );
  }
}
