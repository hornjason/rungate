/**
 * The entry point #1744's workflow runs: a blocker closed, so move whatever
 * it freed to Ready.
 *
 * The decisions are `lib/board-ready-fanout.ts`'s and the readiness rule is
 * `isReady`'s. This file is the I/O: read the closed issue's `blocking` list
 * and the board, ask, and perform only the moves it was handed.
 *
 * ## Two candidate sources, one decider (#1842, G1)
 *
 * The fan-out above answers "what did THIS close free", and that is the whole
 * of what it can answer. An issue that was **never blocked** appears in no
 * `blocking` list, so no close can ever reach it — this file's own header used
 * to say *"there is no 'became unblocked' event"* and stopped one sentence
 * short of the consequence: a repository whose next piece of work has no
 * dependencies had no event at all that could put it in Ready, and the lane
 * was refilled by somebody running a command by hand. That is Claim 7's third
 * falsification verbatim, surviving inside the mechanism written to remove it.
 *
 * `--top-up` is the second candidate source: every OPEN issue in the
 * repository, asked the same question. It is deliberately a source and not a
 * second decider — both paths converge on one `candidates.map(...)`, one
 * `fanoutDecisions`, one `readyCap`, one `selectReady`. A mutation of any of
 * those reddens both modes, which is the only reason a second entry point is
 * safe here (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
 *
 * **The cap is what makes this safe to run on an ordinary event.** Top-up's
 * eligible set is the 36-of-46 population `lib/board-ready-rule.ts` was
 * written about; `selectReady` promotes at most `cap - occupied` of it and
 * says so. Without that bound this mode would be "move the backlog to Ready".
 *
 * **It never adds an item to the board** and it never writes a field other
 * than Status. Both are `board-mirror`'s, and an Action that grew either
 * would make the board's contents depend on which issues happened to close.
 *
 * Exits non-zero only on a refusal, through `EXIT_REFUSED`. An absent
 * credential is one: `GITHUB_TOKEN` cannot write ProjectsV2, and a run that
 * could not look has not found nothing.
 */
import {
  actorMayWrite,
  fanoutDecisions,
  readBoardCredential,
  truncatedReadings,
  type Dependent,
} from "../lib/board-ready-fanout";
import { phaseOf } from "../lib/board-mirror";
import { heldReason, readyCap, selectReady } from "../lib/board-ready-rule";
import { measureClosedIssues } from "../lib/board-throughput";
import { nextCursor } from "../lib/graphql-cursor";

/**
 * Every refusal leaves through this one constant, so a mutant copy with it
 * set to 0 proves each negative case observed the refusal and not something
 * that happened to exit non-zero (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
export const EXIT_REFUSED = 2;

const READY_COLUMN = "Ready";

/**
 * One query for the first page and every page after it.
 *
 * It was typed out twice, which is one edit away from two pages reading
 * different fields — and a page that stopped carrying `fieldValues` would
 * undercount Ready's occupancy and promote past the cap with nothing red.
 */
const BOARD_PAGE_QUERY = `query($p:ID!,$c:String){node(id:$p){... on ProjectV2{items(first:100,after:$c){
       pageInfo{hasNextPage endCursor}
       nodes{
         fieldValues(first:50){pageInfo{hasNextPage} nodes{
           ... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2FieldCommon{name}}}}}
         content{__typename ... on Issue{state milestone{title}}}}}}}}`;

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

async function gql(token: string, query: string, variables: Record<string, unknown>): Promise<any> {
  const r = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `bearer ${token}`,
      "content-type": "application/json",
      accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ query, variables }),
  });
  // **`r.ok` first, before the body means anything.** A GraphQL *query* error
  // comes back 200 with an `errors` array, which is the check below and the
  // usual path. An expired PAT, a secondary-rate-limit 403 and a 5xx come back
  // with a plain `{"message": "..."}` body carrying NEITHER key — so `errors`
  // was falsy, `data` was `undefined`, and this returned it. Every caller
  // dereferences the result directly (`d.repository?.issue`, `all.node.items`,
  // `.node?.field`), so an expired credential died as `Cannot read properties
  // of undefined` rather than as this file's own UNMEASURED refusal. Caught in
  // review of #1747; the same defect round 8 of #1740 fixed in
  // `scripts/work-status.ts`. BR-38..BR-39 assert it across BOTH fetches here.
  if (!r.ok) throw new Error(`${r.status} from the GraphQL endpoint`);
  const j = (await r.json()) as { data?: any; errors?: unknown };
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

/**
 * The acting identity's permission ON THIS REPOSITORY, or `null` when the
 * answer could not be read. `null` is UNMEASURED and refuses — see
 * `actorMayWrite`.
 */
async function actorPermission(token: string, repo: string, actor: string): Promise<string | null> {
  const r = await fetch(`https://api.github.com/repos/${repo}/collaborators/${actor}/permission`, {
    headers: { authorization: `bearer ${token}`, accept: "application/vnd.github+json" },
  });
  // 404 is the documented answer for "not a collaborator", which is a READ
  // of "no permission" rather than a failure to read. Everything else —
  // 401, 403, 5xx — is unreadable and must not be flattened into it.
  if (r.status === 404) return "none";
  if (!r.ok) return null;
  const j = (await r.json()) as { permission?: unknown };
  return typeof j.permission === "string" ? j.permission : null;
}


async function main(): Promise<number> {
  const repo = arg("repo");
  const rawClosed = arg("closed-issue");
  const project = arg("project");
  const actor = arg("actor");
  const apply = process.argv.includes("--write");
  const topUp = process.argv.includes("--top-up");
  // `Number(null)` is 0 and `Number.isFinite(0)` is true, so the first
  // version of this guard passed a MISSING `--closed-issue` straight through
  // and fanned out from issue 0. Caught in review of #1747. The absence is
  // checked before the conversion, and the value must be a positive integer
  // rather than merely finite — `1e9`, `0` and `-3` are all finite.
  if (repo === null || project === null) {
    console.error("UNMEASURED: --repo <owner/name> and --project <id> are both required");
    return EXIT_REFUSED;
  }
  // **Exactly one candidate source.** Neither is the original defect — an
  // invocation with no source has nothing to look at and must not quietly
  // become the other one. BOTH is worse than either: `--top-up` already
  // contains every candidate `--closed-issue` can produce, so a run given both
  // would report a fan-out it did not perform, and whichever branch lost would
  // do so silently.
  if (topUp === (rawClosed !== null)) {
    console.error(
      "UNMEASURED: pass exactly one of --closed-issue <n> (fan out from what that close freed) " +
        "or --top-up (consider every open issue). " +
        (topUp ? "Both were given." : "Neither was given."),
    );
    return EXIT_REFUSED;
  }
  // Only reachable with a `--closed-issue` present, by the guard above.
  const closed = rawClosed === null ? null : Number(rawClosed);
  if (closed !== null && (!Number.isInteger(closed) || closed <= 0)) {
    console.error(`UNMEASURED: --closed-issue must be a positive integer, got "${rawClosed}"`);
    return EXIT_REFUSED;
  }

  const credential = readBoardCredential(process.env);
  if (credential.kind === "UNMEASURED") {
    // A warning annotation, not silence, and not a skipped step. Naming the
    // variable is the difference between a warning somebody can act on and
    // one they learn to scroll past.
    console.log(`::warning::UNMEASURED — ${credential.why}`);
    return EXIT_REFUSED;
  }
  const token = credential.token;
  const [owner, name] = repo.split("/");

  // **The trust gate, before the first read.** `issues: [closed]` is
  // triggerable by anyone who can close an issue — including an outside
  // contributor closing their own — and this job holds a ProjectsV2 PAT.
  //
  // It was first an Actions `if:` reading
  // `github.event.issue.author_association`, which is the association of
  // whoever OPENED the issue and never whoever closed it; the ordinary
  // direction is the damaging one, since a maintainer closing an outsider's
  // issue was refused and the feature silently did not work for exactly the
  // issues most likely to come from outside.
  //
  // Moving it into the script fixed the predicate and then put it too late:
  // an untrusted close still started a job that read the board with the PAT
  // before refusing to write. Security review caught the relocation. The
  // permission answer depends on no board data, so it is taken here —
  // before any `gql()` — and nothing privileged happens until it clears.
  if (actor === null) {
    console.log("::warning::UNMEASURED — --actor was not supplied, so nothing could be authorised. Nothing was read.");
    return EXIT_REFUSED;
  }
  const permission = await actorPermission(token, repo, actor);
  // `owner` is already destructured from `--repo` above — there is no new
  // input to forget to wire. `GITHUB_TOKEN` cannot read the permission
  // endpoint, so without the identity the person who owns the board is
  // refused by an answer the run was never able to obtain.
  if (!actorMayWrite(permission, { actor, owner: owner ?? "" })) {
    console.log(
      `::warning::refusing to run: ${actor} has permission "${permission ?? "UNMEASURED"}" on ${repo}, ` +
        `and this job holds a board-writing credential.`,
    );
    return EXIT_REFUSED;
  }

  // What the closed issue was blocking, with everything isReady reads.
  //
  // **Paginated.** `first: 50` was the third unpaginated read caught on this
  // changeset's sibling, and I wrote it anyway. A blocker freeing more than
  // fifty issues is unlikely and is exactly the case where silently moving
  // the first fifty is worst: the lane looks correct and the tail is
  // invisible.
  //
  // **And then the page sizes made the query unsendable.** `100 × 100 × 100`
  // is 1,000,000 possible nodes against GitHub's limit of 500,000, and the
  // limit is computed from the `first:` values BEFORE anything executes — so
  // this failed identically on an empty board and a full one. Run
  // `42083551881` is the record, and it is the first run that ever got far
  // enough to find out, because five earlier faults refused before this line.
  //
  // The smaller pages cost nothing, because every one of these connections
  // reports its own truncation through `truncatedReadings` and the run
  // refuses rather than silently reading a prefix. An issue sits on one or
  // two projects, and a project item carries a handful of field values;
  // 100 × 20 × 50 is 100,000 and leaves a 5× margin for a nested read
  // somebody adds later. BR-46 asserts the product over EVERY query here,
  // because a page size that cannot be sent is a population.
  const BLOCKING_QUERY = `query($o:String!,$n:String!,$i:Int!,$c:String){repository(owner:$o,name:$n){issue(number:$i){
       blocking(first:100,after:$c){
         pageInfo{hasNextPage endCursor}
         nodes{
           number state milestone{title} assignees{totalCount}
           issueDependenciesSummary{blockedBy}
           projectItems(first:20){
             pageInfo{hasNextPage endCursor}
             nodes{
               id project{id}
               fieldValues(first:50){
                 pageInfo{hasNextPage endCursor}
                 nodes{... on ProjectV2ItemFieldSingleSelectValue{
                   name optionId field{... on ProjectV2FieldCommon{id name}}}}}}}}}}}}`;
  // **The top-up source, same shape and same sub-selections.** `issues` is the
  // repository's own OPEN list rather than one issue's `blocking` list, and
  // everything below this point cannot tell which produced the array — that
  // is the property, not a coincidence. `states:[OPEN]` is asked for rather
  // than filtered afterwards: a CLOSED issue is refused by `whyNotReady`
  // anyway, so filtering here only decides how many pages get fetched.
  //
  // Page sizes are the fan-out's exactly. 100 × 20 × 50 is 100,000 against
  // GitHub's 500,000 node limit, which it computes from the `first:` values
  // before executing anything — BR-46, and run `42083551881` is why.
  const TOP_UP_QUERY = `query($o:String!,$n:String!,$c:String){repository(owner:$o,name:$n){
       issues(first:100,after:$c,states:[OPEN]){
         pageInfo{hasNextPage endCursor}
         nodes{
           number state milestone{title} assignees{totalCount}
           issueDependenciesSummary{blockedBy}
           projectItems(first:20){
             pageInfo{hasNextPage endCursor}
             nodes{
               id project{id}
               fieldValues(first:50){
                 pageInfo{hasNextPage endCursor}
                 nodes{... on ProjectV2ItemFieldSingleSelectValue{
                   name optionId field{... on ProjectV2FieldCommon{id name}}}}}}}}}}}`;

  // One array, two sources. Named for what it holds rather than where it came
  // from, because nothing after this line may branch on the mode.
  const candidates: any[] = [];
  let cursor: string | null = null;
  while (topUp) {
    const d = await gql(token, TOP_UP_QUERY, { o: owner, n: name, c: cursor });
    // `repository` is null with no `errors` for a name the credential cannot
    // see or that does not exist — the same well-formed-but-empty response
    // BR-37 covers on the fan-out path, at the site that path does not reach.
    if (!d.repository?.issues) {
      console.log(
        `::warning::${owner}/${name} did not resolve to a repository with issues — it may be ` +
          `renamed, deleted, or unreadable by this credential. UNMEASURED, nothing written.`,
      );
      return EXIT_REFUSED;
    }
    const page = d.repository.issues;
    candidates.push(...page.nodes);
    const step = nextCursor(page.pageInfo);
    if (step.kind === "unreadable") {
      console.log(
        `::warning::the repository's open issues stopped paging — ${step.why}. ` +
          `A partial list tops Ready up from SOME of the candidates, which silently ` +
          `changes WHICH work is next. UNMEASURED, nothing written.`,
      );
      return EXIT_REFUSED;
    }
    cursor = step.kind === "more" ? step.cursor : null;
    if (cursor === null) break;
  }
  while (closed !== null) {
    const d = await gql(token, BLOCKING_QUERY, { o: owner, n: name, i: closed, c: cursor });
    // **`issue(number:)` resolves to null, with no `errors`, for a number
    // that is not an Issue.** Issues and pull requests share one numbering
    // space and this field resolves only Issues, so a PR number — or a
    // deleted or mistyped one — returns a well-formed response whose `issue`
    // is null. The `issues: closed` trigger always supplies a real issue, but
    // this script is also reachable through `workflow_dispatch` with a
    // free-text `issue` input, and there an operator's typo crashed with
    // `Cannot read properties of null (reading 'blocking')` — an opaque
    // stack trace where every other unreadable state in this file reports
    // UNMEASURED and refuses. Caught in review of #1744.
    if (!d.repository?.issue) {
      console.log(
        `::warning::#${closed} is not an issue on ${owner}/${name} — it may be a pull ` +
          `request number, a deleted issue, or a typo. UNMEASURED, nothing written.`,
      );
      return EXIT_REFUSED;
    }
    const page = d.repository.issue.blocking;
    candidates.push(...page.nodes);
    const step = nextCursor(page.pageInfo);
    if (step.kind === "unreadable") {
      console.log(
        `::warning::#${closed}'s blocking list stopped paging — ${step.why}. ` +
          `A partial list moves SOME of the issues this close unblocked, which is worse ` +
          `than moving none. UNMEASURED, nothing written.`,
      );
      return EXIT_REFUSED;
    }
    cursor = step.kind === "more" ? step.cursor : null;
    if (cursor === null) break;
  }
  if (candidates.length === 0) {
    console.log(
      topUp
        ? `${owner}/${name} has no open issues. No issue changed.`
        : `#${closed} was blocking nothing. No issue changed.`,
    );
    return 0;
  }

  // **This pass counts how full Ready is**, which the cap needs. It also
  // used to read the phase frontier; that went with the phase gate, and the
  // pass stayed because occupancy still has to come from the whole board
  // rather than from the dependents this fan-out happens to be holding.
  // One query string, used for the first page and every page after it: it
  // used to be typed out twice, which is one edit away from two pages
  // reading different fields.
  const all = await gql(token, BOARD_PAGE_QUERY, { p: project, c: null });
  // **`node(id:)` is null for an id GitHub cannot resolve**, and the inline
  // fragment resolves to an empty object for an id that exists and is not a
  // ProjectV2. Both are SUCCESSFUL responses — no `errors`, so `gql()` returns
  // normally per its own contract — and `all.node.items` therefore threw
  // `TypeError: Cannot read properties of null (reading 'items')`. A stale or
  // mistyped `RUNGATE_PROJECT_ID` (project recreated, deleted, or a typo in
  // the variable) crashed with an opaque stack trace, in the one script that
  // reports UNMEASURED and returns EXIT_REFUSED for every other unreadable
  // node. Caught in review of #1747 — the class BR-37 covers on the
  // `issue(number:)` path, at the site it did not reach.
  //
  // Both reads of this query go through the helper, not just the one the
  // finding named: the first page and every page after it. BR-40..BR-41.
  const itemsPage = (d: any): any => d?.node?.items ?? null;
  let page = itemsPage(all);
  if (page === null) {
    console.log(
      `::warning::the project id ${project} did not resolve to a ProjectV2 with items — it may be ` +
        `deleted, recreated under a new id, or not a project at all. UNMEASURED, nothing written.`,
    );
    return EXIT_REFUSED;
  }
  let occupied = 0;
  let occupancyTruncated = false;
  for (;;) {
    for (const n of page.nodes) {
      // **Occupancy counts every card in Ready, issue or not.** The lane's
      // size is what a puller sees, and a pull request parked there takes a
      // slot exactly as an issue does. Filtering to issues here would let
      // the lane exceed its depth by however many PRs it holds, silently.
      const status = (n.fieldValues?.nodes ?? []).find(
        (f: any) => f?.field?.name === "Status",
      )?.name;
      if (status === READY_COLUMN) occupied++;
      // A Status on page two and no Status at all produce the same
      // `undefined`, and one means "this card is not in Ready" while the
      // other means "I could not look". An undercount here promotes past
      // the cap, so it refuses rather than guesses.
      if (n.fieldValues?.pageInfo?.hasNextPage) occupancyTruncated = true;
    }
    const step = nextCursor(page.pageInfo);
    if (step.kind === "unreadable") {
      console.log(
        `::warning::the board stopped paging — ${step.why}. Ready's occupancy ` +
          `was read only in part. UNMEASURED, nothing written.`,
      );
      return EXIT_REFUSED;
    }
    if (step.kind === "done") break;
    const next = itemsPage(await gql(token, BOARD_PAGE_QUERY, { p: project, c: step.cursor }));
    if (next === null) {
      // Mid-pagination, so a partial occupancy is already in hand — and an
      // occupancy read from SOME of the board undercounts, which promotes
      // past the cap. Refuse rather than finish with what arrived.
      console.log(
        `::warning::the project id ${project} stopped resolving part-way through the board, so ` +
          `Ready's occupancy was read only in part. UNMEASURED, nothing written.`,
      );
      return EXIT_REFUSED;
    }
    page = next;
  }

  // ── Labels, in a query of their own — #1853 ──────────────────────────────
  //
  // Ordering reads a label when no milestone places the issue, so every
  // candidate needs its labels. **They are not a sub-selection of the two
  // queries above**, and the reason is BR-46: that detector multiplies every
  // `first:` in a query, the two big ones are already at 100 × 20 × 50 =
  // 100,000, and any further selection puts them over GitHub's 500,000 node
  // ceiling as the detector models it. BR-45's own message says what to do —
  // *split the query rather than shrinking a selection until it fits* — so
  // this is the split. 100 × 20 = 2,000, five hundred times under.
  //
  // It is one pass over the repository's open issues rather than a lookup per
  // candidate: the candidate set is a subset of it on both source paths, and
  // one paged read cannot disagree with itself the way N reads can.
  const LABELS_QUERY = `query($o:String!,$n:String!,$c:String){repository(owner:$o,name:$n){
       issues(first:100,after:$c,states:[OPEN]){
         pageInfo{hasNextPage endCursor}
         nodes{number labels(first:20){pageInfo{hasNextPage endCursor} nodes{name}}}}}}`;
  const labelsOf = new Map<number, string[]>();
  let labelCursor: string | null = null;
  for (;;) {
    const d = await gql(token, LABELS_QUERY, { o: owner, n: name, c: labelCursor });
    const page = d?.repository?.issues;
    if (!page) {
      console.log(
        "::warning::UNMEASURED — the open-issue label read returned no issues connection, so " +
          "no candidate could be ranked by label and every one would have read UNPLACED. " +
          "Nothing written.",
      );
      return EXIT_REFUSED;
    }
    for (const n2 of page.nodes ?? []) {
      // A truncated label list is UNMEASURED, not a short list: the ranked
      // label could be the one on page two, and ranking without it silently
      // demotes the issue. Refusing here is the same choice the field-value
      // read above makes.
      if (n2?.labels?.pageInfo?.hasNextPage) {
        console.log(
          `::warning::UNMEASURED — #${n2.number} carries more than 20 labels, so its ranked ` +
            "label may be unread and its position would be wrong. Nothing written.",
        );
        return EXIT_REFUSED;
      }
      labelsOf.set(
        n2.number,
        (n2?.labels?.nodes ?? []).map((l: any) => l?.name).filter((x: any) => typeof x === "string"),
      );
    }
    // SC-2721: `hasNextPage` is never read here. A file that decides "is
    // there another page" itself is how three variants of one silent
    // truncation reached main one at a time — `nextCursor` is the single
    // binding, and an unreadable pageInfo is UNMEASURED rather than the end
    // of the list. ai-review round 1 of #1855 caught this shape in the
    // sibling file; the suite caught it here.
    const step = nextCursor(page.pageInfo);
    if (step.kind === "unreadable") {
      console.log(
        `::warning::UNMEASURED — the open-issue label read could not tell whether more pages ` +
          `exist: ${step.why}. Candidates past this page would have ranked UNPLACED for an ` +
          "instrument reason. Nothing written.",
      );
      return EXIT_REFUSED;
    }
    if (step.kind === "done") break;
    labelCursor = step.cursor;
  }
  for (const c of candidates) {
    // Shaped as the GraphQL response so the mapping below reads one way,
    // whichever query produced the candidate.
    c.labels = { nodes: (labelsOf.get(c.number) ?? []).map(name2 => ({ name: name2 })) };
  }

  // A truncated sub-selection means this run saw PART of a dependent's board
  // membership or part of its fields, and "I did not find the Status field"
  // and "the Status field was on page two" produce the same `null`. Refuse
  // the whole run rather than write a subset: a board half-moved is harder to
  // notice than one that did not move.
  const unreadable = truncatedReadings(candidates);
  if (unreadable.length > 0) {
    console.log(
      `::warning::UNMEASURED — ${unreadable.map(n => `#${n}`).join(", ")} ` +
        `returned more project items or field values than one page holds, so their board ` +
        `membership was read only in part. Nothing was written.`,
    );
    return EXIT_REFUSED;
  }

  // **The item id, and nothing else.** This used to carry the Status field
  // id read off the item's OWN Status value node, so an item with no Status
  // at all produced no entry here and the write loop below logged "its
  // Status field could not be located — UNMEASURED" for an item whose field
  // id was perfectly resolvable, just not from there. An issue freshly added
  // to the board with no column yet is the one this lane most needs to move,
  // and it was the one guaranteed to be skipped. The field belongs to the
  // PROJECT; it is resolved once, below. BR-34..BR-36.
  const itemOf = new Map<number, { itemId: string }>();
  const dependents: Dependent[] = candidates.map((b: any) => {
    const item = (b.projectItems?.nodes ?? []).find((i: any) => i.project?.id === project);
    const statusValue = item?.fieldValues?.nodes?.find((f: any) => f?.field?.name === "Status");
    if (item) {
      itemOf.set(b.number, { itemId: item.id });
    }
    return {
      number: b.number,
      state: b.state,
      phase: phaseOf(b.milestone?.title),
      // The ordering's second source (#1853). Not `?? []` as a convenience:
      // a page that could not carry labels would read as an issue with none,
      // and that is UNPLACED rather than unmeasured. The LABELS_QUERY pass
      // above refuses the run on a truncated label list and sets this on
      // every candidate, so the only way it is empty is that the issue
      // genuinely has none.
      labels: (b.labels?.nodes ?? []).map((l: any) => l?.name).filter((n: any) => typeof n === "string"),
      // NOT `?? 0`. An absent summary means the field could not be read —
      // a token not scoped for it returns no object — and calling that zero
      // says "nothing is blocking this", which moves a genuinely blocked
      // issue to Ready. `null` is UNMEASURED and never moves.
      blockedByOpen:
        typeof b.issueDependenciesSummary?.blockedBy === "number"
          ? (b.issueDependenciesSummary.blockedBy as number)
          : null,
      // NOT `?? 0`, for the same reason and in the damaging direction: a
      // count read as zero says "nobody has claimed it", which MOVES an
      // issue somebody is already working on into Ready.
      assignees: typeof b.assignees?.totalCount === "number" ? (b.assignees.totalCount as number) : null,
      // Two questions, two fields. `statusValue` is absent both when the
      // issue is not on the board and when it is on the board with no
      // Status value set, and only `item` can tell those apart.
      onBoard: item !== undefined,
      boardStatus: statusValue?.name ?? null,
    };
  });

  const decisions = fanoutDecisions(dependents, READY_COLUMN);
  console.log(
    topUp
      ? `Top-up: ${candidates.length} open issue(s) considered.`
      : `#${closed} closed.`,
  );
  // **Only the movers, in top-up.** A fan-out holds a handful of dependents
  // and naming every one is the log's value; a top-up holds every open issue,
  // and ~250 lines of "somebody has claimed it" is a log nobody reads, which
  // is how the one line that mattered gets missed.
  for (const dec of decisions) {
    if (topUp && !dec.move) continue;
    console.log(dec.move ? `  #${dec.number} -> ${READY_COLUMN}` : `  #${dec.number} unchanged: ${dec.why}`);
  }

  // **The cap, between deciding and writing.** `fanoutDecisions` answers
  // "may this issue be in Ready"; it does not and must not answer "is there
  // room", because that is a property of the lane rather than of the issue,
  // and putting both in one function means no mutation can tell them apart.
  if (occupancyTruncated) {
    console.log(
      `::warning::at least one card's field values were read only in part, so Ready's occupancy ` +
        `is a floor and not a count. UNMEASURED, nothing written.`,
    );
    return EXIT_REFUSED;
  }
  const closedReadings = await measureClosedIssues(
    (query, variables) => gql(token, query, variables),
    owner,
    name,
  );
  const throughput = closedReadings?.throughput ?? null;
  const cap = throughput === null ? null : readyCap(throughput);
  const phaseOfNumber = new Map(dependents.map(d => [d.number, d.phase]));
  // Labels travel with the phase because ordering now reads both (#1853).
  // A decision whose issue is not in `dependents` cannot be ranked by label
  // either, and `[]` is the honest reading for it: UNPLACED, sorted behind
  // everything the plan does place.
  const labelsOfNumber = new Map(dependents.map(d => [d.number, d.labels]));
  const eligible = decisions
    .filter(dec => dec.move)
    .map(dec => ({
      ...dec,
      phase: phaseOfNumber.get(dec.number) ?? null,
      labels: labelsOfNumber.get(dec.number) ?? [],
    }));
  const selection = selectReady(eligible, cap, occupied);
  console.log(
    `  depth: ${cap ?? "UNMEASURED"}` +
      (throughput === null
        ? " (throughput could not be read)"
        : ` (${throughput.delivered} delivered in ${throughput.days} days)`) +
      `. ${selection.why}`,
  );
  // Named, not merely dropped. An eligible issue that did not move because
  // the queue is full is a different fact from one that was never eligible,
  // and a reader who cannot tell them apart goes looking for a bug in the
  // decider.
  for (const dec of eligible) {
    if (!selection.promote.includes(dec)) {
      console.log(`  #${dec.number} eligible but held: ${heldReason(cap)}`);
    }
  }

  const moving = selection.promote;
  if (!apply) {
    console.log(`\nDry run. ${moving.length} issue(s) would move. Pass --write to perform it.`);
    return 0;
  }

  // **Nothing to move, so nothing to resolve.** This block ran whenever
  // `--write` was passed, so a correctly-idle run — every dependent already
  // Ready, still blocked, or claimed — against a board whose "Ready" column
  // had been renamed exited `EXIT_REFUSED` instead of 0. A no-op success
  // reported as a failure is red CI for a scenario where nothing needed
  // writing, and the `candidates.length === 0` case above already short-circuits
  // for exactly this reason. Caught in review of #1747; BR-42. Same class as
  // BS-38 in `scripts/board-status-sweep.ts`, found one round earlier in the
  // other script.
  if (moving.length === 0) {
    console.log(`\nNothing to move. No issue changed.`);
    return 0;
  }

  // **One resolve, from the project, before the loop.** `ProjectV2.field` is
  // a by-name lookup that takes no cursor — introspected 2026-11-04 against
  // the live schema rather than read off this query — so it adds no `first:`
  // for BR-19's census to police, and it costs one round trip instead of one
  // per moved item.
  const statusField = (
    await gql(
      token,
      `query($p:ID!){node(id:$p){... on ProjectV2{
         field(name: "Status"){... on ProjectV2SingleSelectField{id options{id name}}}}}}`,
      { p: project },
    )
  ).node?.field;
  if (!statusField?.id) {
    console.log(`::warning::the board has no Status field — UNMEASURED, nothing written`);
    return EXIT_REFUSED;
  }
  const option = (statusField.options ?? []).find((o: any) => o.name === READY_COLUMN);
  if (!option) {
    console.log(`::warning::the board has no "${READY_COLUMN}" option — UNMEASURED, nothing written`);
    return EXIT_REFUSED;
  }

  for (const dec of moving) {
    const target = itemOf.get(dec.number);
    if (!target) {
      // Decided to move and nothing to move it with. Loud, because a silent
      // skip here is indistinguishable from "it moved". This now means only
      // ONE thing — the issue is not on this board — because the field id no
      // longer comes from the item.
      console.log(`::warning::#${dec.number} is Ready but is not an item on this board — UNMEASURED`);
      continue;
    }
    await gql(
      token,
      `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(
         input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}`,
      { p: project, i: target.itemId, f: statusField.id, o: option.id },
    );
    console.log(`  wrote #${dec.number} -> ${READY_COLUMN}`);
  }
  return 0;
}

process.exit(await main());
