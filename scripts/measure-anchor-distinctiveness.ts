// #1168 round 3: is a cited-line TEXT distinctive enough to be an identity?
//
// The round-3 review finding: `anchorOnlyKey` drops the summary, so a finding
// cited at a line whose text recurs in the file — `}`, `return null;` — shares
// an anchor with every other occurrence. A later, unrelated finding at a
// DIFFERENT occurrence would be suppressed as "the same finding restated".
//
// This measures the premise rather than arguing about it: for every finding in
// the corpus, how many lines in the file it cites carry the same normalised
// text at the commit that was reviewed.
//
// NEGATIVE CONTROL: --control replaces every anchor with "}" before counting.
// A run reporting "all anchors unique" on real data AND under --control is an
// instrument that never read a file.

const CONTROL = process.argv.includes("--control");
const N = Number(process.argv.find(a => /^\d+$/.test(a)) ?? 25);

function gh(args: string[]): any {
  const p = Bun.spawnSync(["gh", ...args], { env: { ...process.env, GH_TOKEN: undefined as any } });
  const out = new TextDecoder().decode(p.stdout);
  const err = new TextDecoder().decode(p.stderr);
  if (!out.trim()) throw new Error(`gh ${args.slice(0, 2).join(" ")} returned nothing: ${err.slice(0, 200)}`);
  return JSON.parse(out);
}
function ghRaw(args: string[]): string | null {
  const p = Bun.spawnSync(["gh", ...args], { env: { ...process.env, GH_TOKEN: undefined as any } });
  if (p.exitCode !== 0) return null;
  return new TextDecoder().decode(p.stdout);
}

const THREADS_Q = `
query($n: Int!) {
  repository(owner:"hornjason", name:"rungate") {
    pullRequest(number:$n) {
      number
      reviewThreads(first:100) { nodes {
        path
        comments(first:1){ nodes { createdAt author{login} originalCommit{oid} diffHunk } }
      } }
    }
  }
}`;

function anchorOf(hunk: string): string {
  const lines = (hunk ?? "").split("\n").filter(l => l.trim().length > 0);
  return (lines.at(-1) ?? "").replace(/^[+\- ]/, "").trim();
}
// the same normalisation `normalise()` in lib/ai-review-rounds.ts applies
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

const prs: number[] = gh([
  "pr", "list", "--repo", "hornjason/rungate", "--state", "merged",
  "--limit", String(N), "--json", "number", "-q", "[.[].number]",
]);

const fileCache = new Map<string, string[] | null>();
function linesAt(sha: string, path: string): string[] | null {
  const k = `${sha}:${path}`;
  if (fileCache.has(k)) return fileCache.get(k)!;
  const raw = ghRaw([
    "api", `repos/hornjason/rungate/contents/${path}?ref=${sha}`,
    "-H", "Accept: application/vnd.github.raw",
  ]);
  const v = raw === null ? null : raw.split("\n");
  fileCache.set(k, v);
  return v;
}

type Row = { pr: number; path: string; anchor: string; occurrences: number; len: number };
const rows: Row[] = [];
let unmeasured = 0;

for (const n of prs) {
  let pr: any;
  try { pr = gh(["api", "graphql", "-f", `query=${THREADS_Q}`, "-F", `n=${n}`]).data.repository.pullRequest; }
  catch { continue; }
  const nodes = (pr.reviewThreads?.nodes ?? []).filter(
    (t: any) => t.comments.nodes[0]?.author?.login === "github-actions",
  );
  for (const t of nodes) {
    const c = t.comments.nodes[0];
    const sha = c.originalCommit?.oid;
    if (!sha) continue;
    const anchor = CONTROL ? "}" : anchorOf(c.diffHunk);
    if (anchor === "") continue;
    const lines = linesAt(sha, t.path);
    if (lines === null) { unmeasured++; continue; }
    const want = norm(anchor);
    let occ = 0;
    for (const l of lines) if (norm(l) === want) occ++;
    rows.push({ pr: n, path: t.path, anchor, occurrences: occ, len: want.length });
  }
}

const amb = rows.filter(r => r.occurrences > 1);
const pct = (a: number, b: number) => (b === 0 ? "n/a" : `${((100 * a) / b).toFixed(1)}%`);

console.log(CONTROL ? "=== NEGATIVE CONTROL (every anchor forced to `}`) ===" : "=== REAL DATA ===");
console.log(`findings with a text anchor   ${rows.length}`);
console.log(`  anchor recurs in its file   ${amb.length}  ${pct(amb.length, rows.length)}`);
console.log(`UNMEASURED (file unreadable)  ${unmeasured}`);

// What threshold, if any, separates the ambiguous ones?
console.log(`\nambiguous anchors by normalised length:`);
for (const [lo, hi] of [[0, 4], [5, 9], [10, 19], [20, 39], [40, 9999]] as [number, number][]) {
  const inBand = rows.filter(r => r.len >= lo && r.len <= hi);
  const ambIn = inBand.filter(r => r.occurrences > 1);
  console.log(
    `  len ${String(lo).padStart(3)}..${hi === 9999 ? "  +" : String(hi).padStart(3)}  ` +
    `${String(ambIn.length).padStart(3)} of ${String(inBand.length).padStart(3)}  ${pct(ambIn.length, inBand.length)}`,
  );
}

if (amb.length) {
  console.log(`\nevery ambiguous anchor, worst first:`);
  for (const r of amb.sort((a, b) => b.occurrences - a.occurrences).slice(0, 40)) {
    console.log(`  x${String(r.occurrences).padStart(3)}  len ${String(r.len).padStart(3)}  #${r.pr}  ${r.path}  ::  ${r.anchor.slice(0, 60)}`);
  }
}
