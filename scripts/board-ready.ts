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
import { fanoutDecisions, readBoardCredential, type Dependent } from "../lib/board-ready-fanout";
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

async function main(): Promise<number> {
  const repo = arg("repo");
  const rawClosed = arg("closed-issue");
  const project = arg("project");
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
           projectItems(first:10){nodes{
             id project{id}
             fieldValues(first:20){nodes{... on ProjectV2ItemFieldSingleSelectValue{
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

  const itemOf = new Map<number, { itemId: string; fieldId: string; optionId: string | null }>();
  const dependents: Dependent[] = blocking.map((b: any) => {
    const item = (b.projectItems?.nodes ?? []).find((i: any) => i.project?.id === project);
    const statusValue = item?.fieldValues?.nodes?.find((f: any) => f?.field?.name === "Status");
    if (item && statusValue?.field?.id) {
      itemOf.set(b.number, { itemId: item.id, fieldId: statusValue.field.id, optionId: null });
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
      assignees: b.assignees?.totalCount ?? 0,
      boardStatus: item ? (statusValue?.name ?? null) : null,
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
  for (const dec of moving) {
    const target = itemOf.get(dec.number);
    if (!target) {
      // Decided to move and nothing to move it with. Loud, because a silent
      // skip here is indistinguishable from "it moved".
      console.log(`::warning::#${dec.number} is Ready but its Status field could not be located — UNMEASURED`);
      continue;
    }
    const field = await gql(
      token,
      `query($f:ID!){node(id:$f){... on ProjectV2SingleSelectField{options{id name}}}}`,
      { f: target.fieldId },
    );
    const option = (field.node.options ?? []).find((o: any) => o.name === READY_COLUMN);
    if (!option) {
      console.log(`::warning::the board has no "${READY_COLUMN}" option — UNMEASURED, nothing written`);
      return EXIT_REFUSED;
    }
    await gql(
      token,
      `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(
         input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}`,
      { p: project, i: target.itemId, f: target.fieldId, o: option.id },
    );
    console.log(`  wrote #${dec.number} -> ${READY_COLUMN}`);
  }
  return 0;
}

process.exit(await main());
