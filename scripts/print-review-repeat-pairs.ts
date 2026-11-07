// Print the summary PAIR for every same-anchor collision, so "repeat" is judged
// rather than asserted. An anchor collision is not a repeat: a reviewer may raise a
// genuinely different finding at the same line — #1858 r3->r4 is the suspected case.
//
// This is the step that turned #1168's count into a reading. `measure-review-repeats.ts`
// says eight collisions exist; only reading both summaries says whether each one is the
// same defect restated. All eight were, which is why the summary component came out of
// the suppression key — `anchorOnlyKey` in `lib/ai-review-rounds.ts`.
//
// The default list is the five pull requests carrying a collision at the time of that
// reading. Pass numbers to read any others:
//   bun scripts/print-review-repeat-pairs.ts 1900 1899
const ARGS = process.argv.slice(2).filter(a => /^\d+$/.test(a)).map(Number);
const PRS = ARGS.length > 0 ? ARGS : [1858, 1857, 1846, 1831, 1826];
const Q = `
query($n: Int!) { repository(owner:"hornjason", name:"rungate") { pullRequest(number:$n) {
  reviewThreads(first:100) { nodes { path comments(first:1){ nodes {
    createdAt author{login} originalCommit{oid} diffHunk body } } } } } } }`;
function gh(a: string[]) {
  const p = Bun.spawnSync(["gh", ...a], { env: { ...process.env, GH_TOKEN: undefined as any } });
  return JSON.parse(new TextDecoder().decode(p.stdout));
}
const summaryOf = (b: string) => b.split("<!-- rungate")[0].replace(/^\*\*(low|medium|high|critical)\*\*\s*—\s*/i, "").trim();
const anchorOf = (h: string) => ((h ?? "").split("\n").filter((l) => l.trim()).at(-1) ?? "").replace(/^[+\- ]/, "").trim();

for (const n of PRS) {
  const pr = gh(["api", "graphql", "-f", `query=${Q}`, "-F", `n=${n}`]).data.repository.pullRequest;
  const f = pr.reviewThreads.nodes
    .filter((t: any) => t.comments.nodes[0]?.author?.login === "github-actions")
    .map((t: any) => { const c = t.comments.nodes[0]; return { sha: c.originalCommit?.oid, path: t.path, anchor: anchorOf(c.diffHunk), summary: summaryOf(c.body), at: c.createdAt }; })
    .filter((x: any) => x.sha);
  const order = [...new Set(f.slice().sort((a: any, b: any) => a.at.localeCompare(b.at)).map((x: any) => x.sha))];
  for (const x of f) x.round = order.indexOf(x.sha) + 1;
  const seen: any[] = [];
  for (const x of f.slice().sort((a: any, b: any) => a.round - b.round)) {
    const hit = seen.find((e) => e.path === x.path && e.anchor === x.anchor && e.anchor !== "");
    if (hit) {
      console.log(`\n######## #${n}  r${hit.round} -> r${x.round}   ${x.path}`);
      console.log(`  anchor: ${x.anchor.slice(0, 90)}`);
      console.log(`  FIRST : ${hit.summary.replace(/\s+/g, " ").slice(0, 300)}`);
      console.log(`  LATER : ${x.summary.replace(/\s+/g, " ").slice(0, 300)}`);
    }
    seen.push(x);
  }
}
