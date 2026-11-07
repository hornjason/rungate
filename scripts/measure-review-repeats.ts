// #1168 measurement: review rounds per PR, and what fraction of round-2+ findings
// cite a line unchanged since the round that first raised one.
//
// NEGATIVE CONTROL: --control injects a synthetic byte-identical repeat into every
// multi-round PR. A run that reports 0 repeats on real data AND 0 under --control is
// an instrument that cannot see a repeat, not a clean repo.

const CONTROL = process.argv.includes("--control");
const N = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 25);

function gh(args: string[]): any {
  const p = Bun.spawnSync(["gh", ...args], { env: { ...process.env, GH_TOKEN: undefined as any } });
  const out = new TextDecoder().decode(p.stdout);
  const err = new TextDecoder().decode(p.stderr);
  if (!out.trim()) throw new Error(`gh ${args.slice(0, 2).join(" ")} returned nothing: ${err.slice(0, 300)}`);
  return JSON.parse(out);
}

const THREADS_Q = `
query($n: Int!) {
  repository(owner:"hornjason", name:"rungate") {
    pullRequest(number:$n) {
      number title mergedAt
      reviewThreads(first:100) { nodes {
        path
        comments(first:1){ nodes { createdAt author{login} originalCommit{oid} diffHunk body } }
      } }
    }
  }
}`;

// strip the machine key and the severity prefix; keep the prose a human would compare
function summaryOf(body: string): string {
  return body.split("<!-- rungate")[0].replace(/^\*\*(low|medium|high|critical)\*\*\s*—\s*/i, "").trim();
}
function anchorOf(hunk: string): string {
  const lines = (hunk ?? "").split("\n").filter((l) => l.trim().length > 0);
  return (lines.at(-1) ?? "").replace(/^[+\- ]/, "").trim();
}
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

const prs: number[] = gh([
  "pr", "list", "--repo", "hornjason/rungate", "--state", "merged",
  "--limit", String(N), "--json", "number", "-q", "[.[].number]",
]);

type Finding = { round: number; sha: string; path: string; anchor: string; summary: string; at: string };

let prsWithRounds = 0, prsMultiRound = 0, totalRounds = 0;
let round2plus = 0, byteKeyRepeats = 0, unchangedLineRepeats = 0, pathUntouchedRepeats = 0;
const repeatDetail: string[] = [];
const roundsPerPr: [number, number][] = [];
const changedCache = new Map<string, Set<string>>();

function changedPaths(a: string, b: string): Set<string> | null {
  const k = `${a}..${b}`;
  if (changedCache.has(k)) return changedCache.get(k)!;
  try {
    const j = gh(["api", `repos/hornjason/rungate/compare/${a}...${b}`, "--jq", "[.files[]?.filename]"]);
    const s = new Set<string>(j);
    changedCache.set(k, s);
    return s;
  } catch {
    return null; // UNMEASURED for this pair — never counted as "unchanged"
  }
}
let unmeasuredPairs = 0;

for (const n of prs) {
  let pr: any;
  try { pr = gh(["api", "graphql", "-f", `query=${THREADS_Q}`, "-F", `n=${n}`]).data.repository.pullRequest; }
  catch { continue; }
  const nodes = (pr.reviewThreads?.nodes ?? []).filter((t: any) => t.comments.nodes[0]?.author?.login === "github-actions");
  if (nodes.length === 0) continue;

  const findings: Finding[] = nodes.map((t: any) => {
    const c = t.comments.nodes[0];
    return { round: 0, sha: c.originalCommit?.oid ?? "", path: t.path, anchor: anchorOf(c.diffHunk), summary: summaryOf(c.body), at: c.createdAt };
  }).filter((f: Finding) => f.sha);

  const order = [...new Set(findings.slice().sort((a, b) => a.at.localeCompare(b.at)).map((f) => f.sha))];
  for (const f of findings) f.round = order.indexOf(f.sha) + 1;

  if (CONTROL && order.length >= 2) {
    const first = findings.find((f) => f.round === 1);
    if (first) findings.push({ ...first, round: order.length, sha: order[order.length - 1], at: "9999" });
  }

  prsWithRounds++; totalRounds += order.length; roundsPerPr.push([n, order.length]);
  if (order.length >= 2) prsMultiRound++;

  const earlier: Finding[] = [];
  for (const f of findings.slice().sort((a, b) => a.round - b.round)) {
    if (f.round === 1) { earlier.push(f); continue; }
    round2plus++;
    const byteKey = earlier.find((e) => e.path === f.path && e.anchor === f.anchor && norm(e.summary) === norm(f.summary));
    if (byteKey) { byteKeyRepeats++; repeatDetail.push(`BYTE-KEY #${n} r${byteKey.round}->r${f.round} ${f.path} :: ${f.summary.slice(0, 70)}`); }

    const sameSpot = earlier.find((e) => e.path === f.path && e.anchor === f.anchor && e.anchor !== "");
    if (sameSpot) {
      const changed = changedPaths(sameSpot.sha, f.sha);
      if (changed === null) unmeasuredPairs++;
      else if (!changed.has(f.path)) { pathUntouchedRepeats++; unchangedLineRepeats++; repeatDetail.push(`PATH-UNTOUCHED #${n} r${sameSpot.round}->r${f.round} ${f.path}:${f.anchor.slice(0,40)}`); }
      else { unchangedLineRepeats++; repeatDetail.push(`SAME-ANCHOR #${n} r${sameSpot.round}->r${f.round} ${f.path}:${f.anchor.slice(0,40)}`); }
    }
    earlier.push(f);
  }
}

const pct = (a: number, b: number) => (b === 0 ? "n/a" : `${((100 * a) / b).toFixed(1)}%`);
console.log(CONTROL ? "=== NEGATIVE CONTROL RUN (synthetic repeat injected per multi-round PR) ===" : "=== REAL DATA ===");
console.log(`merged PRs examined          ${prs.length}`);
console.log(`  with at least one finding  ${prsWithRounds}`);
console.log(`  with 2+ rounds             ${prsMultiRound}`);
console.log(`rounds per reviewed PR       ${prsWithRounds ? (totalRounds / prsWithRounds).toFixed(2) : "n/a"}  (${totalRounds} rounds)`);
console.log(`round-2+ findings            ${round2plus}`);
console.log(`  byte-key repeats           ${byteKeyRepeats}  ${pct(byteKeyRepeats, round2plus)}`);
console.log(`  same-anchor repeats        ${unchangedLineRepeats}  ${pct(unchangedLineRepeats, round2plus)}`);
console.log(`    of which path untouched  ${pathUntouchedRepeats}`);
console.log(`UNMEASURED commit pairs      ${unmeasuredPairs}`);
console.log(`\nworst rounds:`);
for (const [n, r] of roundsPerPr.sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${r} rounds  #${n}`);
if (repeatDetail.length) { console.log(`\nrepeats:`); for (const d of repeatDetail.slice(0, 20)) console.log("  " + d); }
