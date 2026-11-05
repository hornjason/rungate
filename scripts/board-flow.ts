/**
 * The entry point `.github/workflows/board-flow.yml` runs: a GitHub event
 * happened, so move the ISSUE's card to the lane that event means.
 *
 * The decision is `lib/board-flow.ts`'s and nothing here second-guesses it.
 * This file is the I/O: authorise the actor, resolve which issue the event
 * is about, resolve the Status field and the lane's option BY NAME, write,
 * and read back.
 *
 * **It never adds an item to the board** and it never writes a field other
 * than Status — both are `board-mirror`'s, for the same reason
 * `scripts/board-ready.ts` gives: an Action that grew either would make the
 * board's contents depend on which events happened to fire.
 *
 * Exits non-zero only on a refusal, through `EXIT_REFUSED`. An absent
 * credential is one, and so is a close whose `state_reason` this run could
 * not read: `GITHUB_TOKEN` cannot write ProjectsV2, and a run that could not
 * look has not found nothing.
 */
import { actorMayWrite, readBoardCredential } from "../lib/board-ready-fanout";
import { LANE_EVENTS, laneFor, type LaneEvent } from "../lib/board-flow";

/**
 * Every refusal leaves through this one constant, so a mutant copy with it
 * set to 0 proves each negative case observed the refusal and not something
 * that happened to exit non-zero (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
export const EXIT_REFUSED = 2;

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
  // `r.ok` BEFORE the body means anything. A GraphQL query error is a 200
  // with an `errors` array; an expired PAT, a secondary rate limit and a 5xx
  // carry neither key, so without this the caller dereferences `undefined`
  // and an expired credential reads as a stack trace rather than a refusal.
  // The same defect was fixed in `scripts/board-ready.ts` (BR-38) and in
  // `scripts/work-status.ts`.
  if (!r.ok) throw new Error(`${r.status} from the GraphQL endpoint`);
  const j = (await r.json()) as { data?: any; errors?: unknown };
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

/**
 * The acting identity's permission ON THIS REPOSITORY, or `null` when the
 * answer could not be read. `null` is UNMEASURED and refuses.
 */
async function actorPermission(token: string, repo: string, actor: string): Promise<string | null> {
  const r = await fetch(`https://api.github.com/repos/${repo}/collaborators/${actor}/permission`, {
    headers: { authorization: `bearer ${token}`, accept: "application/vnd.github+json" },
  });
  // 404 is the documented answer for "not a collaborator", which is a READ
  // of "no permission" rather than a failure to read. 401, 403 and 5xx are
  // unreadable and must not be flattened into it.
  if (r.status === 404) return "none";
  if (!r.ok) return null;
  const j = (await r.json()) as { permission?: unknown };
  return typeof j.permission === "string" ? j.permission : null;
}

/**
 * The issues a pull request will close, from its closing references.
 *
 * `null` means the read was truncated — more references than one page holds
 * — which is UNMEASURED rather than "these are all of them". Paged rather
 * than refused outright because the limit is per connection, and the product
 * of every `first:` in a document is checked against GitHub's 500,000 node
 * ceiling BEFORE anything executes (BR-46).
 */
async function closingIssues(
  token: string,
  owner: string,
  name: string,
  pr: number,
): Promise<number[] | null> {
  const d = await gql(
    token,
    `query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){
       closingIssuesReferences(first:50){pageInfo{hasNextPage} nodes{number}}}}}`,
    { o: owner, n: name, p: pr },
  );
  const refs = d.repository?.pullRequest?.closingIssuesReferences;
  if (!refs) return [];
  if (refs.pageInfo.hasNextPage) return null;
  return refs.nodes.map((n: { number: number }) => n.number);
}

async function main(): Promise<number> {
  const repo = arg("repo");
  const project = arg("project");
  const actor = arg("actor");
  const event = arg("event");
  const apply = process.argv.includes("--write");

  if (repo === null || project === null || event === null) {
    console.error("UNMEASURED: --repo <owner/name> --project <id> --event <kind> are all required");
    return EXIT_REFUSED;
  }
  // The event kind is checked against the decider's OWN list rather than a
  // second one spelled here. A typo in the workflow would otherwise reach
  // `laneFor`'s default arm and be reported as "no rule for event kind",
  // which is true and unhelpful — it reads as a missing feature rather than
  // as a misspelled argument.
  if (!(LANE_EVENTS as readonly string[]).includes(event)) {
    console.error(
      `UNMEASURED: --event "${event}" is not one of ${LANE_EVENTS.join(", ")}. ` +
        `Nothing was read and nothing was written.`,
    );
    return EXIT_REFUSED;
  }

  // **The decision is taken before any credential is read.** It depends on
  // nothing the network can tell us, so a refusal arrives without a token
  // and without touching the board — and a `null` lane must never reach a
  // write path at all.
  //
  // `--state-reason` absent is `null`, which for a close is exactly the
  // unreadable case SC-2691 is about. It is NOT normalised to COMPLETED.
  //
  // **Case is normalised here and nowhere else.** The webhook payload spells
  // it `not_planned`; GraphQL spells it `NOT_PLANNED`; `lib/board-flow.ts`
  // compares exactly, because a loose comparison on the field separating
  // "delivered" from "abandoned" is the one place a near-match must not
  // pass. Upper-casing is the whole of the conversion — it does NOT trim, so
  // a value carrying stray whitespace still reaches the refusal rather than
  // being tidied into a lane.
  const rawReason = arg("state-reason");
  const stateReason = rawReason === null ? null : rawReason.toUpperCase();
  const decision = laneFor({ kind: event, stateReason } as LaneEvent);
  if (decision.lane === null) {
    console.log(
      `::warning::UNMEASURED — ${decision.why}. The board was not read and nothing was ` +
        `written. This is not a card that stayed where it was by decision; it is a card ` +
        `nobody decided about.`,
    );
    return EXIT_REFUSED;
  }
  const column = decision.lane;

  const credential = readBoardCredential(process.env);
  if (credential.kind === "UNMEASURED") {
    console.log(`::warning::UNMEASURED — ${credential.why}`);
    return EXIT_REFUSED;
  }
  const token = credential.token;
  const [owner, name] = repo.split("/");

  // **The trust gate, before the first read.** Every trigger on this
  // workflow is reachable by an outside contributor — anyone may open an
  // issue, assign nobody, close their own, or open a pull request — and this
  // job holds a ProjectsV2 PAT. The permission answer depends on no board
  // data, so it is taken here, before any `gql()`, and nothing privileged
  // happens until it clears. `board-ready.yml` learned this the expensive
  // way: its gate was correct and too late.
  if (actor === null) {
    console.log("::warning::UNMEASURED — --actor was not supplied, so nothing could be authorised. Nothing was read.");
    return EXIT_REFUSED;
  }
  const permission = await actorPermission(token, repo, actor);
  if (!actorMayWrite(permission, { actor, owner: owner ?? "" })) {
    console.log(
      `::warning::refusing to run: ${actor} has permission "${permission ?? "UNMEASURED"}" on ${repo}, ` +
        `and this job holds a board-writing credential.`,
    );
    return EXIT_REFUSED;
  }

  // Which issues this event is about. An issue event names one; a pull
  // request event names however many issues it closes, and that is the
  // whole of the link — a PR that closes nothing moves nothing, which is a
  // reading and not a failure.
  let targets: number[];
  if (event.startsWith("issue_")) {
    const raw = arg("issue");
    const n = Number(raw);
    // `Number(null)` is 0 and `Number.isFinite(0)` is true, so absence is
    // checked before the conversion and the value must be a positive
    // integer rather than merely finite.
    if (raw === null || !Number.isInteger(n) || n <= 0) {
      console.error(`UNMEASURED: --issue must be a positive integer for ${event}, got "${raw}"`);
      return EXIT_REFUSED;
    }
    targets = [n];
  } else {
    const raw = arg("pr");
    const n = Number(raw);
    if (raw === null || !Number.isInteger(n) || n <= 0) {
      console.error(`UNMEASURED: --pr must be a positive integer for ${event}, got "${raw}"`);
      return EXIT_REFUSED;
    }
    const closes = await closingIssues(token, owner ?? "", name ?? "", n);
    if (closes === null) {
      console.log(
        `::warning::UNMEASURED — #${n} closes more issues than one page holds, so the set of ` +
          `cards this event is about was read only in part. Nothing was written: a board ` +
          `half-moved is harder to notice than one that did not move.`,
      );
      return EXIT_REFUSED;
    }
    if (closes.length === 0) {
      console.log(
        `#${n} names no closing issue, so no issue card is about it. Nothing to move. ` +
          `(Closing keywords inside backticks do not create the link.)`,
      );
      return 0;
    }
    targets = closes;
  }

  // The Status field and the lane's option, resolved BY NAME at run time.
  // A pasted node id would survive a board rename and write the wrong
  // column silently; a name that stops resolving fails this job loudly.
  const fieldsData = await gql(
    token,
    `query($p:ID!){node(id:$p){... on ProjectV2{fields(first:50){
       pageInfo{hasNextPage}
       nodes{... on ProjectV2SingleSelectField{id name options{id name}}}}}}}`,
    { p: project },
  );
  // `node(id:)` is null for an id GitHub cannot resolve, and the inline
  // fragment is an empty object for an id that is not a ProjectV2. Both are
  // SUCCESSFUL responses, so without this a stale `RUNGATE_PROJECT_ID`
  // crashes with an opaque TypeError in a script that reports UNMEASURED
  // for every other unreadable state.
  const fields = fieldsData?.node?.fields ?? null;
  if (fields === null) {
    console.log(
      `::warning::the project id ${project} did not resolve to a ProjectV2 with fields — it may ` +
        `be deleted, recreated under a new id, or not a project at all. UNMEASURED, nothing written.`,
    );
    return EXIT_REFUSED;
  }
  const status = fields.nodes.find((f: any) => f?.name === "Status") ?? null;
  // A truncated page and a renamed field produce the same `null`, and only
  // one of them is something to act on. Say which this is.
  if (status === null && fields.pageInfo.hasNextPage) {
    console.log(
      `::warning::UNMEASURED — the first 50 fields on this project do not include one named ` +
        `"Status" AND there are more beyond that page. This is not a missing field. Nothing ` +
        `was written; page the fields query before renaming anything.`,
    );
    return EXIT_REFUSED;
  }
  const option = status?.options?.find((o: any) => o?.name === column) ?? null;
  if (status === null || option === null) {
    console.log(
      `::warning::could not resolve the Status field or its "${column}" option on project ` +
        `${project}. The whole field list was read, so this is not a truncated page — someone ` +
        `renamed the field or the column. Update specs/BOARD-FLOW-SPEC.md and lib/board-flow.ts ` +
        `to match the board.`,
    );
    return EXIT_REFUSED;
  }

  let refused = false;
  for (const issue of targets) {
    const d = await gql(
      token,
      `query($o:String!,$n:String!,$i:Int!){repository(owner:$o,name:$n){issue(number:$i){
         projectItems(first:20){pageInfo{hasNextPage} nodes{id project{id}}}}}}`,
      { o: owner, n: name, i: issue },
    );
    // `issue(number:)` resolves to null with no `errors` for a number that
    // is not an Issue — issues and pull requests share one numbering space.
    if (!d.repository?.issue) {
      console.log(
        `::warning::#${issue} is not an issue on ${repo} — it may be a pull request number, a ` +
          `deleted issue, or a typo. UNMEASURED, nothing written for it.`,
      );
      refused = true;
      continue;
    }
    const items = d.repository.issue.projectItems;
    const item = items.nodes.find((i: any) => i?.project?.id === project) ?? null;
    if (item === null && items.pageInfo.hasNextPage) {
      console.log(
        `::warning::UNMEASURED — #${issue} sits on more projects than one page holds and this ` +
          `board was not among the first 20, so its membership was read only in part. Nothing ` +
          `written for it.`,
      );
      refused = true;
      continue;
    }
    if (item === null) {
      // Not a refusal. `board-intake.yml` adds items on `opened`, so an
      // issue predating it is genuinely absent from the board and adding it
      // here is not this script's job.
      console.log(`#${issue} is not on this board, so there is no card to move. Skipped.`);
      continue;
    }

    if (!apply) {
      console.log(`would move #${issue} to "${column}" — ${decision.why}`);
      continue;
    }

    await gql(
      token,
      `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{
         projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}`,
      { p: project, i: item.id, f: status.id, o: option.id },
    );

    // **WRITE, THEN READ BACK.** The mutation's exit code says the request
    // was accepted, not that the value stuck — GitHub's built-in project
    // automations fire off the same events and race this one. A write whose
    // effect is never read is indistinguishable from one overwritten a
    // millisecond later (`.claude/rules/checks-must-be-able-to-fail.md`,
    // the sixth shape).
    const back = await gql(
      token,
      `query($i:ID!){node(id:$i){... on ProjectV2Item{fieldValues(first:50){
         pageInfo{hasNextPage}
         nodes{... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2FieldCommon{name}}}}}}}}`,
      { i: item.id },
    );
    const values = back?.node?.fieldValues ?? null;
    const current =
      values?.nodes?.find((v: any) => v?.field?.name === "Status")?.name ?? null;
    if (current === null && values?.pageInfo?.hasNextPage) {
      console.log(
        `::warning::UNMEASURED — Status was not among #${issue}'s first 50 field values and ` +
          `there are more beyond that page, so the read-back measured nothing. The write may ` +
          `well have worked. This is NOT a competing writer.`,
      );
      refused = true;
      continue;
    }
    if (current !== column) {
      console.log(
        `::warning::wrote "${column}" to #${issue} and read back "${current ?? "(nothing)"}". ` +
          `Something else is writing this item's Status and winning — check the project's ` +
          `built-in workflows for a rule that also fires on this event.`,
      );
      refused = true;
      continue;
    }
    console.log(`#${issue} -> "${column}" (${decision.why}), confirmed by read-back.`);
  }

  return refused ? EXIT_REFUSED : 0;
}

if (import.meta.main) {
  main()
    .then(code => process.exit(code))
    .catch(e => {
      console.log(`::warning::UNMEASURED — ${e}`);
      process.exit(EXIT_REFUSED);
    });
}
