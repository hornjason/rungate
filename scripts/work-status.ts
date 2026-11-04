/**
 * What is the state of the work we agreed on — read live, from the systems
 * that own the answer, never from a session's memory.
 *
 * ## Two sources, and they own different questions
 *
 * **GitHub owns the state of work.** Whether an issue is open, what blocks it,
 * who claimed it, which pull request touches it, what column it sits in. Every
 * one of those is fetched here and none is cached.
 *
 * **`project-state.json` owns the plan** — AGENTS.md rule 10, the one place a
 * done-condition lives. The agreed ORDER of the intake items is read from it
 * and is not restated here.
 *
 * The mapping between the two — which agreed item is which issue — is the one
 * thing neither system holds, so it is declared below and printed with a
 * `tracker:` column that says plainly when an item has no object at all. An
 * item with nothing to point at is the report's most useful row.
 *
 * Read-only. It opens nothing, edits nothing and writes nothing.
 */
import { assertTokenMayReach, resolveGitHubToken } from "../lib/github";
import { isPickable, orderReading, type TrackerFacts } from "../lib/work-status";

const REPO = "hornjason/rungate";
const PROJECT = "PVT_kwHOAZTQCM4BpMuR";
const MILESTONE = "Issue intake";

// `resolveGitHubToken()`, never the raw environment variable — this file
// read it by name and printed "UNMEASURED: no credential" on a machine
// holding a perfectly good one, because `gh auth login` sets `GH_TOKEN` and
// exports nothing else. That is #139/#140 exactly, which cost
// this repository a month of silently broken Octokit calls and is the reason
// `resolveGitHubToken` exists at all. A status tool that reports no
// credential when there is one is the precise failure this whole script was
// written to stop.
//
// `test/token-host-allowlist.test.ts` now asserts it as a census: no file
// outside `lib/github.ts` may read the variable, so the next one fails the
// suite rather than the user.
const token = resolveGitHubToken();
if (!token) {
  console.error(
    "UNMEASURED: no GitHub credential. Set GH_TOKEN or GITHUB_TOKEN — " +
      'export GITHUB_TOKEN="$(gh auth token)"',
  );
  process.exit(2);
}
const H = { authorization: `bearer ${token}`, accept: "application/vnd.github+json" };

/** A redirect loop is a bug or an attack; neither deserves unbounded hops. */
const MAX_REDIRECTS = 5;

/**
 * One request, with the token, and **every hop checked before it is taken.**
 *
 * The first version of this checked `r.url` after the fetch returned. Security
 * review called that TOCTOU and was right: by the time a landing URL can be
 * read, the request has already been made and the credential has already
 * gone. A detector that runs after the exfiltration is a log line, not a
 * control.
 *
 * So redirects are **not** followed automatically. A 3xx stops here, its
 * `Location` is validated like any other untrusted URL, and only then is the
 * request re-issued. `redirect: "manual"` also makes `r.url` equal the URL we
 * asked for, which is why no post-hoc assertion on it remains — it could no
 * longer disagree, and a check that cannot fail is worse than none
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
async function send(url: string, init: RequestInit = {}): Promise<Response> {
  let target = assertTokenMayReach(url, "request URL").toString();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const r = await fetch(target, { ...init, headers: { ...H, ...(init.headers ?? {}) }, redirect: "manual" });
    if (r.status < 300 || r.status > 399) return r;
    const location = r.headers.get("location");
    if (location === null) throw new Error(`${r.status} from ${target} with no Location header`);
    target = assertTokenMayReach(location, "Location header", target).toString();
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects starting at ${url}`);
}

async function rest(path: string): Promise<any> {
  const r = await send(`https://api.github.com/${path}`);
  if (!r.ok) throw new Error(`${r.status} on ${path}`);
  return r.json();
}

/**
 * Every LIST read goes through here, and it follows `Link: rel="next"` to the
 * end.
 *
 * Caught in review of #1740: three list reads took a single page while
 * `boardStatus()` beside them paginated correctly. At 84 open issues the next
 * sixteen would have vanished from "N unblocked across the repo" with no
 * truncation notice — the same shape as the search qualifier this file was
 * written to avoid, arriving by a different route. A silently short list is
 * not a smaller answer, it is a wrong one.
 *
 * **The next URL is a response header, so the responder chooses it.** Every
 * hop is checked against `lib/github.ts` before the token goes with it —
 * same decider `GITHUB_API_URL` has used since security review flagged that
 * variable, asked of the second input that has the same shape.
 */
async function restAll(path: string): Promise<any[]> {
  const out: any[] = [];
  let url: string | null = `https://api.github.com/${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  while (url) {
    const r: Response = await send(url);
    if (!r.ok) throw new Error(`${r.status} on ${url}`);
    out.push(...((await r.json()) as any[]));
    const next = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get("link") ?? "");
    url = next ? assertTokenMayReach(next[1], 'Link rel="next"', url).toString() : null;
  }
  return out;
}
/**
 * The GraphQL endpoint, through the SAME `send()` as every REST read.
 *
 * It was exempted at first on the reasoning that the URL is a literal we
 * wrote and GitHub does not redirect it. Review round 7 rejected that, and
 * was right twice over: the exemption was a sentence rather than a
 * mechanism, and a *literal request* URL says nothing about where a 30x
 * would send the token next. Exempting one member of a population by
 * argument is how the population stops being fixed — the test below now
 * asserts every credentialed fetch, with no carve-out.
 */
async function gql(query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const r = await send("https://api.github.com/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  // `r.ok` first, like `rest()` and `restAll()`. GraphQL answers 200 for a
  // query error, so the `errors` check below is the usual path — but a 401,
  // a 502 or a secondary-rate-limit 403 returns a body with neither `data`
  // nor `errors`, and this returned `undefined` for all three. Every caller
  // then read a property of undefined, or worse, treated it as an empty
  // reading. Round 8 of #1740, and the same class as the rest: a site the
  // neighbouring functions guard and this one did not.
  if (!r.ok) throw new Error(`${r.status} from the GraphQL endpoint`);
  const j = (await r.json()) as { data?: unknown; errors?: unknown };
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

/**
 * Board Status per issue number. The board is the only place this lives.
 *
 * **`fieldValues` pages too.** It was `first:20`, exempted by the reasoning
 * that a project item has a bounded number of fields — which is the fourth
 * time on this day's work that "bounded in practice" was the thing that was
 * wrong. A Status value on page two and an item with no Status at all
 * produce the same `undefined`, and telling a reading apart from an absence
 * is this script's entire subject, so a truncated page says so.
 */
async function boardStatus(): Promise<Map<number, string>> {
  const q = `query($p:ID!,$c:String){node(id:$p){... on ProjectV2{items(first:100,after:$c){
    pageInfo{hasNextPage endCursor}
    nodes{fieldValues(first:100){pageInfo{hasNextPage}
      nodes{... on ProjectV2ItemFieldSingleSelectValue{
      name field{... on ProjectV2FieldCommon{name}}}}}
      content{__typename ... on Issue{number}}}}}}}`;
  const out = new Map<number, string>();
  let c: string | null = null;
  do {
    const d = await gql(q, { p: PROJECT, c });
    for (const n of d.node.items.nodes) {
      if (n.content?.__typename !== "Issue") continue;
      const s = n.fieldValues.nodes.find((f: any) => f?.field?.name === "Status")?.name;
      const unreadable = n.fieldValues.pageInfo?.hasNextPage === true && s === undefined;
      out.set(n.content.number, s ?? (unreadable ? "(UNMEASURED — fields truncated)" : "(no status)"));
    }
    c = d.node.items.pageInfo.hasNextPage ? d.node.items.pageInfo.endCursor : null;
  } while (c);
  return out;
}

/**
 * The agreed order, as a mapping from `project-state.json`'s numbered list to
 * the tracker objects that can be observed.
 *
 * **This array is hand-maintained and that is a known defect, not a design.**
 * The banner below says the order comes from `project-state.json`; the ORDER
 * is its, but nothing here READS it — the list lives in prose inside
 * `priorities[0]` and this is a transcription of it. A transcription goes
 * stale silently, and did: item 2 had no tracker for a day after #1759 was
 * filed for it, and item 7 printed blank for a day after it was completed.
 * Parsing the prose is the real fix and is not in this change.
 */
const ORDER: {
  n: number;
  what: string;
  tracker: string | null;
  /** Where a human recorded completion, when there is no tracker object. */
  recordedDone?: string;
}[] = [
  { n: 1, what: "the refusal-outcome reading", tracker: "PR #1607" },
  { n: 2, what: "widen the parser to all three creation paths", tracker: "#1759" },
  { n: 3, what: "one decider for issue shape", tracker: "#1741" },
  { n: 4, what: "#1727", tracker: "#1727" },
  { n: 5, what: "#1728", tracker: "#1728" },
  { n: 6, what: "render the retro's open improvements", tracker: "#1745" },
  {
    n: 7,
    what: "re-run the Stage B audit",
    tracker: null,
    recordedDone:
      "project-state.json priorities[0], 2026-11-03 session 79 — five Stage B readings " +
      "retaken from the primary checkout on main at 87d7c832, all MET",
  },
  { n: 8, what: "/stage-audit and /round-rca", tracker: "#1746" },
];

const bar = (s: string) => console.log(`\n${s}\n${"─".repeat(s.length)}`);

const status = await boardStatus();

// ── the agreed order ────────────────────────────────────────────────────────
bar("THE AGREED ORDER — order from project-state.json, state from GitHub");
for (const it of ORDER) {
  let facts: TrackerFacts | undefined;
  let detail = "";
  if (it.tracker) {
    const num = Number(it.tracker.replace(/\D/g, ""));
    const o = await rest(`repos/${REPO}/issues/${num}`);
    const state = o.state === "closed" ? ("closed" as const) : ("open" as const);
    if (o.pull_request) {
      // merged, not closed. A pull request closed unmerged ends `closed` too
      // and the work did not happen.
      const pr = await rest(`repos/${REPO}/pulls/${num}`);
      facts = { kind: "pr", state, merged: Boolean(pr.merged) };
      detail = ` ${pr.mergeable_state ?? "?"}`;
    } else {
      facts = { kind: "issue", state, stateReason: o.state_reason ?? null };
    }
  }
  // One decider, in `lib/work-status.ts`, so a mutation of it reddens
  // `test/work-status.test.ts` rather than leaving a second copy here holding
  // the case up. UNMEASURED never prints a tick.
  const reading = orderReading({ tracker: it.tracker, facts, recordedDone: it.recordedDone ?? null });
  // RECORDED is NOT a tick. `~` and `x` are different glyphs because they are
  // different facts: `x` means the tracker was read and says so, `~` means a
  // person wrote it down and nothing can confirm it.
  const mark = reading === "DONE" ? "x" : reading === "RECORDED" ? "~" : " ";
  const shown =
    reading === "UNMEASURED"
      ? "no tracker object — cannot be measured"
      : reading === "RECORDED"
        ? `RECORDED, not observed — ${it.recordedDone}`
        : `${reading}${detail}`;
  console.log(`  [${mark}] ${it.n}. ${it.what.padEnd(44)} ${(it.tracker ?? "—").padEnd(9)} ${shown}`);
}

// ── the milestone ───────────────────────────────────────────────────────────
bar(`MILESTONE "${MILESTONE}" — every field below is a live read`);
const issues = (await restAll(`repos/${REPO}/issues?state=all&milestone=*`))
  .filter((i: any) => i.milestone?.title === MILESTONE && !i.pull_request)
  .sort((a: any, b: any) => a.number - b.number);

for (const i of issues) {
  const blockers = await restAll(`repos/${REPO}/issues/${i.number}/dependencies/blocked_by`);
  const openB = blockers.filter((b: any) => b.state === "open").map((b: any) => `#${b.number}`);
  const who = i.assignees?.length ? i.assignees.map((a: any) => a.login).join(",") : "unclaimed";
  // Paginated, like every other list in this file. `first: 20` was the last
  // unpaginated read left after round 2 fixed the REST ones, and #1592 is the
  // proof it matters: fourteen cross-references on one issue, so twenty is
  // not a comfortable ceiling, it is the next one to be hit. A silently short
  // list of linked pull requests reads as "none yet".
  const prs: string[] = [];
  let after: string | null = null;
  do {
    const linked: any = await gql(
      `query($o:String!,$n:String!,$i:Int!,$c:String){repository(owner:$o,name:$n){issue(number:$i){
         timelineItems(first:100,after:$c,itemTypes:[CROSS_REFERENCED_EVENT]){
           pageInfo{hasNextPage endCursor}
           nodes{... on CrossReferencedEvent{source{... on PullRequest{number state}}}}}}}}`,
      { o: "hornjason", n: "rungate", i: i.number, c: after },
    );
    const page = linked.repository.issue.timelineItems;
    for (const n of page.nodes) {
      if (n?.source?.number) prs.push(`PR#${n.source.number} ${n.source.state}`);
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  console.log(`\n  #${i.number}  ${i.state.toUpperCase()}  board=${status.get(i.number) ?? "NOT ON BOARD"}`);
  console.log(`        ${i.title.slice(0, 72)}`);
  console.log(`        claimed by: ${who}`);
  console.log(`        blocked by: ${openB.length ? openB.join(", ") : "nothing — pickable"}`);
  console.log(`        pull requests: ${prs.length ? prs.join(", ") : "none yet"}`);
}

// ── open pull requests ──────────────────────────────────────────────────────
bar("OPEN PULL REQUESTS — rollup read from GitHub, not from a previous run");
const prs = await restAll(`repos/${REPO}/pulls?state=open`);
for (const p of prs) {
  const d = await gql(
    `{repository(owner:"hornjason",name:"rungate"){pullRequest(number:${p.number}){
       mergeStateStatus commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}`,
  );
  const pr = d.repository.pullRequest;
  const roll = pr.commits.nodes[0]?.commit?.statusCheckRollup?.state ?? "NO CHECKS REPORTED";
  console.log(`  PR #${p.number}  ${pr.mergeStateStatus.padEnd(9)} checks=${roll.padEnd(8)} ${p.title.slice(0, 54)}`);
}

// ── what anyone may pick up ─────────────────────────────────────────────────
//
// Computed from the per-issue dependencies endpoint, one call per open issue,
// and NOT from a search qualifier. Measured 2026-11-03 on this repository with
// one query string — `is:open -is:blocked no:assignee`:
//
//     gh issue list --search  →  33     correct; excludes #1743 and #1746,
//                                       whose blockers were wired by hand
//     GraphQL `search`        →  77     `-is:blocked` silently ignored
//     REST  /search/issues    →  77     `-is:blocked` silently ignored
//
// No error on either wrong path — they return a larger set and look fine. The
// qualifier appears nowhere in GitHub's documentation, which is the same fact
// seen from the other side. So this file pays for 80-odd requests rather than
// trusting a qualifier that two of its three transports drop.
bar("PICKABLE — computed per issue from the dependencies API, not from a search");
const open = await restAll(`repos/${REPO}/issues?state=open`);
const pickable: any[] = [];
for (const i of open) {
  if (i.pull_request) continue;
  const blockers = await restAll(`repos/${REPO}/issues/${i.number}/dependencies/blocked_by`);
  if (isPickable({ state: i.state, assignees: i.assignees ?? [], blockers })) pickable.push(i);
}
console.log(`  ${pickable.length} unblocked and unclaimed across the repo.`);
console.log(`  In "${MILESTONE}":`);
for (const i of pickable.filter(x => x.milestone?.title === MILESTONE)) {
  console.log(`    #${i.number} ${i.title.slice(0, 62)}`);
}
console.log("\n  Nothing above was remembered. Re-run to re-read.");
