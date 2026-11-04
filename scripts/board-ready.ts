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
  if (!actorMayWrite(permission)) {
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
  const BLOCKING_QUERY = `query($o:String!,$n:String!,$i:Int!,$c:String){repository(owner:$o,name:$n){issue(number:$i){
       blocking(first:100,after:$c){
         pageInfo{hasNextPage endCursor}
         nodes{
           number state milestone{title} assignees{totalCount}
           issueDependenciesSummary{blockedBy}
           projectItems(first:100){
             pageInfo{hasNextPage endCursor}
             nodes{
               id project{id}
               fieldValues(first:100){
                 pageInfo{hasNextPage endCursor}
                 nodes{... on ProjectV2ItemFieldSingleSelectValue{
                   name optionId field{... on ProjectV2FieldCommon{id name}}}}}}}}}}}}`;
  const blocking: any[] = [];
  let cursor: string | null = null;
  do {
    const d = await gql(token, BLOCKING_QUERY, { o: owner, n: name, i: closed, c: cursor });
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
  const frontierItems: { state: string; phase: number | null }[] = [];
  let page = all.node.items;
  for (;;) {
    for (const n of page.nodes) {
      if (n.content?.__typename !== "Issue") continue;
      frontierItems.push({ state: n.content.state, phase: phaseOf(n.content.milestone?.title) });
    }
    if (!page.pageInfo.hasNextPage) break;
    page = (await gql(token, `query($p:ID!,$c:String){node(id:$p){... on ProjectV2{items(first:100,after:$c){
       pageInfo{hasNextPage endCursor}
       nodes{content{__typename ... on Issue{state milestone{title}}}}}}}}`,
      { p: project, c: page.pageInfo.endCursor })).node.items;
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
