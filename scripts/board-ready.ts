/**
 * The entry point #1744's workflow runs: a blocker closed, so move whatever
 * it freed to Ready.
 *
 * The decisions are `lib/board-ready-fanout.ts`'s and the readiness rule is
 * `isReady`'s. This file is the I/O: read the closed issue's `blocking` list
 * and the board, ask, and perform only the moves it was handed.
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
import { phaseOf, openFrontier } from "../lib/board-mirror";

/**
 * Every refusal leaves through this one constant, so a mutant copy with it
 * set to 0 proves each negative case observed the refusal and not something
 * that happened to exit non-zero (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
export const EXIT_REFUSED = 2;

const READY_COLUMN = "Ready";

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
  // `Number(null)` is 0 and `Number.isFinite(0)` is true, so the first
  // version of this guard passed a MISSING `--closed-issue` straight through
  // and fanned out from issue 0. Caught in review of #1747. The absence is
  // checked before the conversion, and the value must be a positive integer
  // rather than merely finite — `1e9`, `0` and `-3` are all finite.
  if (repo === null || project === null || rawClosed === null) {
    console.error("UNMEASURED: --repo <owner/name> --closed-issue <n> --project <id> are all required");
    return EXIT_REFUSED;
  }
  const closed = Number(rawClosed);
  if (!Number.isInteger(closed) || closed <= 0) {
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
  const blocking: any[] = [];
  let cursor: string | null = null;
  do {
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
    blocking.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  if (blocking.length === 0) {
    console.log(`#${closed} was blocking nothing. No issue changed.`);
    return 0;
  }

  // The frontier is a property of the whole board, not of this fan-out: the
  // earliest phase with open work. Reading it from the dependents alone would
  // make "what is next" depend on which blocker happened to close.
  const all = await gql(
    token,
    `query($p:ID!,$c:String){node(id:$p){... on ProjectV2{items(first:100,after:$c){
       pageInfo{hasNextPage endCursor}
       nodes{content{__typename ... on Issue{state milestone{title}}}}}}}}`,
    { p: project, c: null },
  );
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
  const frontierItems: { state: string; phase: number | null }[] = [];
  let page = itemsPage(all);
  if (page === null) {
    console.log(
      `::warning::the project id ${project} did not resolve to a ProjectV2 with items — it may be ` +
        `deleted, recreated under a new id, or not a project at all. UNMEASURED, nothing written.`,
    );
    return EXIT_REFUSED;
  }
  for (;;) {
    for (const n of page.nodes) {
      if (n.content?.__typename !== "Issue") continue;
      frontierItems.push({ state: n.content.state, phase: phaseOf(n.content.milestone?.title) });
    }
    if (!page.pageInfo.hasNextPage) break;
    const next = itemsPage(
      await gql(token, `query($p:ID!,$c:String){node(id:$p){... on ProjectV2{items(first:100,after:$c){
       pageInfo{hasNextPage endCursor}
       nodes{content{__typename ... on Issue{state milestone{title}}}}}}}}`,
        { p: project, c: page.pageInfo.endCursor }),
    );
    if (next === null) {
      // Mid-pagination, so a partial frontier is already in hand — and a
      // frontier read from SOME of the board is the reading that moves the
      // wrong issues to Ready. Refuse rather than finish with what arrived.
      console.log(
        `::warning::the project id ${project} stopped resolving part-way through the board, so the ` +
          `frontier was read only in part. UNMEASURED, nothing written.`,
      );
      return EXIT_REFUSED;
    }
    page = next;
  }
  const frontier = openFrontier(frontierItems);

  // A truncated sub-selection means this run saw PART of a dependent's board
  // membership or part of its fields, and "I did not find the Status field"
  // and "the Status field was on page two" produce the same `null`. Refuse
  // the whole run rather than write a subset: a board half-moved is harder to
  // notice than one that did not move.
  const unreadable = truncatedReadings(blocking);
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
  const dependents: Dependent[] = blocking.map((b: any) => {
    const item = (b.projectItems?.nodes ?? []).find((i: any) => i.project?.id === project);
    const statusValue = item?.fieldValues?.nodes?.find((f: any) => f?.field?.name === "Status");
    if (item) {
      itemOf.set(b.number, { itemId: item.id });
    }
    return {
      number: b.number,
      state: b.state,
      phase: phaseOf(b.milestone?.title),
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

  const decisions = fanoutDecisions(dependents, frontier, READY_COLUMN);
  console.log(`#${closed} closed. Frontier is phase ${frontier ?? "none"}.`);
  for (const dec of decisions) {
    console.log(dec.move ? `  #${dec.number} -> ${READY_COLUMN}` : `  #${dec.number} unchanged: ${dec.why}`);
  }

  const moving = decisions.filter(dec => dec.move);
  if (!apply) {
    console.log(`\nDry run. ${moving.length} issue(s) would move. Pass --write to perform it.`);
    return 0;
  }

  // **Nothing to move, so nothing to resolve.** This block ran whenever
  // `--write` was passed, so a correctly-idle run — every dependent already
  // Ready, still blocked, or claimed — against a board whose "Ready" column
  // had been renamed exited `EXIT_REFUSED` instead of 0. A no-op success
  // reported as a failure is red CI for a scenario where nothing needed
  // writing, and the `blocking.length === 0` case above already short-circuits
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
