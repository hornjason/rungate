#!/usr/bin/env bun
/**
 * Put a spec's criteria onto the project board, where they can be SEEN (#1647).
 *
 * Step 3 of `docs/adr/ADR-003-spec-to-tracker-mapping.md` says the issue body
 * declares which criteria the work serves. That is the right place for the
 * fact and the wrong place to read it from: a board renders FIELDS, not
 * bodies, so grouping by milestone shows the phase and the criteria stay
 * invisible until somebody opens all 27 issues one at a time.
 *
 * This command derives a text field from the bodies and writes it to the
 * board. **The field is a mirror. The body is the source.** A project custom
 * field is invisible to `gh` — `gh issue list --json projectItems` returns
 * Status and nothing else, measured on #1592 — so an agent can never read this
 * column, and nothing load-bearing may be put in it. It exists so a person can
 * look at the board and see the trace. If the column and the body disagree,
 * the body is right; re-run this, do not edit the cell.
 *
 * ## Ready is written, not filtered, and that is measured
 *
 * The obvious design is a saved view on `is:open no:blocked-by`. It does not
 * work: those filters match on whether a dependency LINK exists, not on
 * whether the blocker is still open. See `isReady` in `lib/board-mirror.ts`
 * for the four public issues that prove it. So readiness is computed from
 * `issueDependenciesSummary.blockedBy` — the OPEN count, a different field
 * from `totalBlockedBy` — and written to Status.
 *
 * ## It only ever moves Status between Backlog and Ready
 *
 * A board column is also a person's workspace. An item somebody has dragged to
 * *In progress*, *In review* or *Done* is a statement this command has no
 * standing to overrule, and the whole value of the lane dies the first time it
 * stamps on one. So the transition set is closed and tiny: empty or Backlog
 * may become Ready, Ready may fall back to Backlog, and every other reading is
 * left exactly where it is and reported as skipped.
 */
import { existsSync, readFileSync } from "fs";
import { isAbsolute, join } from "path";
import { parseArgs } from "util";
import { createGitHubClient } from "../lib/github";
import { readBoardInputs } from "../lib/config-readers";
import {
  heldReason,
  readyCap,
  readyOccupancy,
  selectReady,
  type ReadyOccupancy,
} from "../lib/board-ready-rule";
import { measureClosedIssues } from "../lib/board-throughput";
import {
  criterionIdsIn,
  isReady,
  mirrorRows,
  phaseOf,
  specCriteriaIn,
} from "../lib/board-mirror";

/**
 * THE one non-zero exit, so `test/board-mirror.test.ts` can build a mutant
 * with it set to `0` and prove each refusal is what the case observed
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
export const REFUSAL_EXIT = 1;

/**
 * `owner/name`, or `null` for anything that is not exactly that.
 *
 * **`split("/")[1]` is `undefined` for `--repo rungate`, and a `!` only
 * silences the type checker.** That `undefined` reached
 * `measureClosedIssues` and surfaced as an opaque GraphQL error far from
 * the typo that caused it — ai-review on #1795.
 *
 * Exported because the first version of this guard was inline in
 * `main()`, where no case could reach it: the mutation battery removed
 * the whole condition and read ZERO. A guard no test can observe is a
 * line in a file (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
export function parseRepo(value: string): { owner: string; name: string } | null {
  const parts = value.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!owner || !name) return null;
  return { owner, name };
}

/**
 * Split what this command MAY write into what the cap lets through.
 *
 * **The cap applies here too, and from the same function the workflow
 * uses.** This command is the hand-run second CALLER of Ready's rule —
 * not a second rule, which is the distinction that matters: it and
 * `board-ready.yml` both read `lib/board-ready-rule.ts`, so they cannot
 * size the lane differently. Before this, the workflow filled to a
 * derived depth and one hand-run of this command refilled the lane to
 * whatever happened to be eligible.
 *
 * **A demotion to Backlog is never capped**, and that is the half a
 * naive implementation gets wrong. The cap bounds what may ENTER Ready;
 * applying it to departures would pin a claimed or newly-blocked card in
 * the lane for as long as the lane stayed full — the cap would start
 * preserving exactly the staleness it exists to prevent.
 *
 * Exported so a case can hold it. Inline, the only way to observe it was
 * to run the command against a live board.
 */
/**
 * The items this command may move, and how many of them hold Ready.
 *
 * **One array, read twice — not two filters that happen to agree.**
 * `occupied` used to be counted over EVERY board item while the
 * transitions were computed over the open ones, so anything the command
 * can never move counted against the cap forever and silently starved
 * promotions. A closed issue whose Status was never taken off Ready is
 * the case ai-review named; a DRAFT board item, which has no state at
 * all, is the one that was live on the board when this was written.
 *
 * Returning both from one pass is the point. Re-spelling
 * `state === "OPEN"` beside the count would be two deciders answering one
 * question, which no behavioural test can tell apart
 * (`.claude/rules/checks-must-be-able-to-fail.md`) — and that is exactly
 * how the two came to disagree. ai-review round 3 of #1795.
 */
export function readyPopulation<T extends { state: string; status: string }>(
  items: readonly T[],
): { writable: T[]; occupied: number } {
  const writable = items.filter(i => i.state === "OPEN");
  return { writable, occupied: writable.filter(i => i.status === READY).length };
}

export function splitReadyChanges<
  T extends {
    item: { number: number; milestone: string | null; labels: readonly string[]; status: string };
    to: string;
  },
>(
  eligible: readonly T[],
  cap: number | null,
  occupied: number,
  /**
   * `board.milestonePrefix` — the ENGINE milestone family (#1943). Passed
   * in, never read here: `lib/config-readers.ts` holds the one binding, and
   * a second reader is two deciders over one config key.
   */
  enginePrefix: string | null,
): {
  readyWritable: T[];
  heldByCap: T[];
  selection: ReturnType<typeof selectReady>;
  /** The reading the caller must restate, never re-derive (#1852). */
  occ: ReadyOccupancy;
} {
  const promotions = eligible.filter(c => c.to === READY);
  const demotions = eligible.filter(c => c.to !== READY);
  // **A demotion in THIS batch frees a slot in this batch.** `occupied`
  // is the pre-write count, so handing it to `selectReady` unchanged
  // under-promotes by however many cards are leaving Ready in the same
  // run — a frontier move that demotes three and promotes three would
  // promote none. ai-review round 2 of #1795.
  //
  // Only demotions FROM Ready free anything. This command may also
  // overwrite a card with no Status at all, and counting those would
  // over-promote past the cap — the opposite error, reached by the
  // obvious fix.
  const freed = demotions.filter(c => c.item.status === READY).length;
  // **This command's lane view is OPEN ISSUES ONLY, by design, so its two
  // occupancy counts are one number** (#1852). `readyPopulation` filters to
  // `state === "OPEN"` before counting, deliberately: a closed issue left on
  // Ready counted against the cap forever and starved promotions
  // (ai-review round 3 of #1795), and a draft has no state at all and is
  // dropped before it reaches here.
  //
  // So WEDGED is unreachable from this caller, and that is HONEST rather
  // than convenient: a lane held full by cards this command cannot see is a
  // lane it also cannot clear, and `scripts/board-ready.ts` reads the whole
  // column and reports it. What this caller must not do is invent a second
  // free-slot calculation, which is the defect #1852 closed.
  const after = Math.max(0, occupied - freed);
  const occ = readyOccupancy(after, after, cap);
  const selection = selectReady(
    promotions.map(c => ({ number: c.item.number, milestone: c.item.milestone, labels: c.item.labels })),
    occ,
    enginePrefix,
  );
  // **Written in the order `selectReady` chose, not in board order.**
  // A `filter` over `promotions` re-derives the right MEMBERSHIP in the
  // wrong SEQUENCE, so the log and the write order stop matching the
  // phase-then-age ranking the lane is supposed to express — and a run
  // that dies part-way through would have written an arbitrary subset
  // rather than the highest-ranked one. ai-review round 2 of #1795.
  const byNumber = new Map(promotions.map(c => [c.item.number, c]));
  const chosen = selection.promote.map(p => byNumber.get(p.number)!).filter(Boolean);
  const chosenNumbers = new Set(chosen.map(c => c.item.number));
  return {
    readyWritable: [...demotions, ...chosen],
    heldByCap: promotions.filter(c => !chosenNumbers.has(c.item.number)),
    selection,
    occ,
  };
}

const USAGE = `rungate board-mirror --project <node-id> [--spec <spec.md>] [--field <name>] [--write] [--ready] [--json]

  --project  the ProjectV2 node id, e.g. PVT_kwHO…
  --spec     narrow the column to ONE spec's criteria. Omit it — which is the
             normal case — and every spec under specs/ is read. An issue does
             not know which spec you had in mind, so narrowing blanks the cell
             of every issue serving any other spec (SC-2610).
  --field    the TEXT field to mirror into. Default "Criteria". It must
             already exist on the project — this does not create one, because
             a typo would silently add a column nobody looks at.
  --write    write the field. Without it nothing is mutated.
  --repo     owner/name — required with --ready, which derives Ready's depth
             from how much that repository delivered. A board can span
             repositories and carries no single answer, so there is no
             default: without it the depth is UNMEASURED and nothing moves.
  --ready    also move Status between Backlog and Ready from the OPEN
             blocked-by count. Implies nothing unless --write is given too.
  --json     the whole reading.`;

/** Status names this command is allowed to write, and what it may overwrite. */
export const READY = "Ready";
export const BACKLOG = "Backlog";
export const MAY_OVERWRITE: readonly string[] = ["", BACKLOG, READY];

interface Item {
  itemId: string;
  number: number;
  title: string;
  body: string;
  state: string;
  status: string;
  assignees: number;
  blockedByOpen: number;
  blockedByTotal: number;
  criteriaCell: string;
  milestone: string;
  /** Ordering's second source when no milestone places the issue (#1853). */
  labels: readonly string[];
}

const ITEMS_QUERY = `query($project: ID!, $field: String!, $after: String) {
  node(id: $project) {
    ... on ProjectV2 {
      field(name: $field) { ... on ProjectV2Field { id name dataType } }
      items(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          fieldValueByName(name: $field) { ... on ProjectV2ItemFieldTextValue { text } }
          status: fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
          content {
            ... on Issue {
              number title body state
              milestone { title }
              labels(first: 20) { pageInfo { hasNextPage } nodes { name } }
              assignees { totalCount }
              issueDependenciesSummary { blockedBy totalBlockedBy }
            }
          }
        }
      }
    }
  }
}`;

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        project: { type: "string" },
        spec: { type: "string" },
        field: { type: "string", default: "Criteria" },
        write: { type: "boolean", default: false },
        ready: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        "project-root": { type: "string" },
        repo: { type: "string" },
      },
      allowPositionals: false,
    });
  } catch (e) {
    console.error(`board-mirror: ${(e as Error).message}\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }
  const { values } = parsed;
  // **`split("/")[1]` is `undefined` for `--repo rungate`, and the `!`
  // only silences the type checker.** That `undefined` reaches
  // `measureClosedIssues` and surfaces as an opaque GraphQL error far
  // from the typo that caused it. Validated here, where the message can
  // name the flag. ai-review on #1795.
  if (values.repo !== undefined && parseRepo(values.repo) === null) {
    console.error(`board-mirror: --repo must be owner/name, got "${values.repo}"\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }
  if (!values.project) {
    console.error(`board-mirror: --project is required\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }
  const root = values["project-root"] ?? process.cwd();

  // The id set the column is drawn from. Default: every spec in the tree —
  // see SC-2610 and `specCriteriaIn`. `--spec` narrows it, which is useful
  // for inspecting one spec and wrong for writing the board.
  let ids: string[];
  let sourceDescription: string;
  if (values.spec) {
    const specPath = isAbsolute(values.spec) ? values.spec : join(root, values.spec);
    if (!existsSync(specPath)) {
      console.error(`board-mirror: no such spec: ${specPath}`);
      return REFUSAL_EXIT;
    }
    // Through the SAME reader as the sweep below, or the two paths of
    // this one script disagree about a spec that states an id twice.
    ids = criterionIdsIn(readFileSync(specPath, "utf-8"));
    if (ids.length === 0) {
      console.error(`board-mirror: ${specPath} declares no criteria — nothing could be mirrored`);
      return REFUSAL_EXIT;
    }
    sourceDescription = `${values.spec} only — every other spec's criteria will render as an empty cell`;
  } else {
    const sweep = specCriteriaIn(root);
    if (sweep.reading === "UNMEASURED") {
      console.error(`board-mirror: UNMEASURED — the criteria could not be read:`);
      for (const r of sweep.unmeasuredReasons) console.error(`  - ${r}`);
      return REFUSAL_EXIT;
    }
    // Reported, not refused: an id two specs both state still produces one
    // correct cell. What it breaks is the reader's ability to tell which
    // spec the cell meant, and that is worth saying out loud once.
    for (const c of sweep.collisions) {
      console.error(`board-mirror: note — ${c.id} is stated by ${c.specs.join(" and ")}`);
    }
    ids = [...sweep.ids];
    sourceDescription = `${sweep.specs.filter(s => s.ids.length > 0).length} specs under specs/`;
  }

  const client = createGitHubClient();

  // ── Read every item, and the field we are about to write ─────────────────
  const items: Item[] = [];
  let fieldId: string | undefined;
  let after: string | null = null;
  for (;;) {
    const page: any = await client.graphql(ITEMS_QUERY, {
      project: values.project,
      field: values.field,
      after,
    });
    const node = page?.node;
    if (!node) {
      console.error(`board-mirror: ${values.project} is not a project this token can read`);
      return REFUSAL_EXIT;
    }
    if (!node.field) {
      console.error(
        `board-mirror: the project has no field named "${values.field}". ` +
          `Create it first — this command does not, because a typo would add a ` +
          `column nobody looks at rather than failing.`,
      );
      return REFUSAL_EXIT;
    }
    if (node.field.dataType !== "TEXT") {
      console.error(
        `board-mirror: field "${values.field}" is ${node.field.dataType}, not TEXT. ` +
          `Refusing: writing a single-select regenerates every option id and ` +
          `clears every value on the board.`,
      );
      return REFUSAL_EXIT;
    }
    fieldId = node.field.id;
    for (const n of node.items.nodes) {
      if (!n.content?.number) continue; // a draft item has no issue
      // **A truncated label list is UNMEASURED, not a short one** (#1853).
      // Ordering reads a label when no milestone places the issue, so a
      // ranked label sitting on page two makes this writer promote the
      // issue as if nothing placed it — and that is indistinguishable from
      // an issue nothing places. `scripts/board-ready.ts` refuses the same
      // state; this file silently did not, which is the one-site-fixed
      // shape ai-review round 1 of #1855 named.
      if (n.content.labels?.pageInfo?.hasNextPage) {
        console.error(
          `board-mirror: #${n.content.number} carries more than 20 labels, so the label that ` +
            `ranks it may be unread and its position in Ready would be wrong. UNMEASURED, ` +
            `nothing written.`,
        );
        return REFUSAL_EXIT;
      }
      items.push({
        itemId: n.id,
        number: n.content.number,
        title: n.content.title ?? "",
        body: n.content.body ?? "",
        state: n.content.state ?? "",
        status: n.status?.name ?? "",
        assignees: n.content.assignees?.totalCount ?? 0,
        blockedByOpen: n.content.issueDependenciesSummary?.blockedBy ?? 0,
        blockedByTotal: n.content.issueDependenciesSummary?.totalBlockedBy ?? 0,
        criteriaCell: n.fieldValueByName?.text ?? "",
        milestone: n.content.milestone?.title ?? "",
        // Ordering's second source (#1853). This writer promotes too, so a
        // mirror run that ranked everything milestone-less as UNPLACED
        // would order by age exactly where the fan-out no longer does.
        labels: (n.content.labels?.nodes ?? [])
          .map((l: any) => l?.name)
          .filter((x: any) => typeof x === "string"),
      });
    }
    if (!node.items.pageInfo.hasNextPage) break;
    after = node.items.pageInfo.endCursor;
  }

  const rows = mirrorRows(items, ids);
  const byNumber = new Map(rows.map(r => [r.number, r]));

  const fieldChanges = items
    .filter(i => (byNumber.get(i.number)?.text ?? "") !== i.criteriaCell)
    .map(i => ({ item: i, to: byNumber.get(i.number)!.text }));

  const { writable, occupied } = readyPopulation(items);
  const readyChanges = writable
    .map(i => ({ item: i, to: isReady(i) ? READY : BACKLOG }))
    .filter(c => c.to !== c.item.status);

  // An assignee is a person saying "mine". Where their card sits is then
  // theirs to decide, and demoting a claimed issue to Backlog makes it look
  // abandoned on a board somebody is reading at a glance. So the guard is
  // two-part: the status must be one this command may overwrite, AND nobody
  // may have claimed the issue.
  const mayWrite = (c: { item: Item }) =>
    MAY_OVERWRITE.includes(c.item.status) && c.item.assignees === 0;
  const eligible = readyChanges.filter(mayWrite);
  const readySkipped = readyChanges.filter(c => !mayWrite(c));

  // A board can span repositories, so there is no repository to default
  // to and no honest depth without one. UNMEASURED, and nothing is
  // promoted on a null cap.
  // Re-parsed rather than carried, so there is one spelling of what a
  // repository argument is. `main` has already refused anything this
  // returns null for.
  const repo = values.repo === undefined ? null : parseRepo(values.repo);
  // **Gated on `--ready`, not merely on `--repo`.** This pages every
  // closed issue in the repository, and a plain Criteria sync that
  // happens to pass `--repo` has no use for a depth. ai-review round 2
  // of #1795.
  const closedReadings =
    values.ready && repo
      ? await measureClosedIssues((q, v) => client.graphql(q, v), repo.owner, repo.name)
      : null;
  const cap = closedReadings === null ? null : readyCap(closedReadings.throughput);
  // The ENGINE milestone family, from this project's own config (#1943).
  // `null` on a tree that declares none, which orders by phase alone.
  const enginePrefix = readBoardInputs(root).milestonePrefix;
  const { readyWritable, heldByCap, selection, occ } = splitReadyChanges(
    eligible,
    cap,
    occupied,
    enginePrefix,
  );

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          field: values.field,
          criteriaInSpec: ids.length,
          items: items.length,
          rows: rows.map(r => ({ number: r.number, criteria: r.criteria })),
          fieldChanges: fieldChanges.map(c => ({ number: c.item.number, from: c.item.criteriaCell, to: c.to })),
          readyWritable: readyWritable.map(c => ({ number: c.item.number, from: c.item.status, to: c.to })),
          readySkipped: readySkipped.map(c => ({ number: c.item.number, status: c.item.status })),
          // The depth and what it held back, so a consumer reading this
          // JSON can tell "nothing was eligible" from "the lane is full"
          // from "the depth could not be read". Three different facts
          // that all used to come out as an empty `readyWritable`.
          readyCap: cap,
          readyOccupied: occupied,
          readyHeldByCap: heldByCap.map(c => c.item.number),
          wrote: values.write,
        },
        null,
        2,
      ),
    );
  } else {
    const named = rows.filter(r => r.criteria.length > 0);
    console.log(`\nboard-mirror — ${values.field} on ${items.length} item(s)\n`);
    console.log(`  ${ids.length} criteria, read from ${sourceDescription}`);
    console.log(`  ${named.length} of ${items.length} items name at least one`);
    console.log(`  ${new Set(named.flatMap(r => r.criteria)).size} distinct criteria reached\n`);
    for (const c of fieldChanges) {
      console.log(`  #${c.item.number}  "${c.item.criteriaCell}" -> "${c.to}"`);
    }
    if (fieldChanges.length === 0) console.log(`  every cell already agrees with its issue body`);
    if (values.ready) {
      console.log(
        `\n  Ready lane — eligibility is unblocked and unclaimed; phase orders, it does not gate`,
      );
      console.log(`    depth: ${cap ?? "UNMEASURED"}. ${selection.why}`);
      if (cap === null && !values.repo) {
        console.log(
          `    pass --repo owner/name to derive the depth; a board can span repositories ` +
            `so there is nothing to default to, and nothing is promoted without it`,
        );
      }
      for (const c of heldByCap) {
        // `heldReason(cap)`, never a literal. The literal was the exact
        // defect ai-review found in `scripts/board-ready.ts` on #1794 —
        // an unmeasured depth reported as a full lane — and I wrote it
        // fresh here one pull request later, with the fix exported and
        // in the tree. `test/board-ready-rule.test.ts` now refuses the
        // string anywhere but its own binding.
        console.log(`    #${c.item.number} eligible but held: ${heldReason(occ)}`);
      }
      for (const c of readyWritable) {
        console.log(`    #${c.item.number}  ${c.item.status || "(none)"} -> ${c.to}  (${c.item.milestone || "no milestone"}; ${c.item.blockedByOpen} open of ${c.item.blockedByTotal} blockers, ${c.item.assignees} assignee(s))`);
      }
      for (const c of readySkipped) {
        const why =
          c.item.assignees > 0 ? `someone has claimed it` : `not this command's to move`;
        console.log(`    #${c.item.number}  left at ${c.item.status || "(none)"} — ${why}`);
      }
      if (readyWritable.length === 0) console.log(`    nothing to move`);
    }
    if (!values.write) console.log(`\n  (reporting only — pass --write to apply)`);
  }

  if (!values.write) return 0;

  for (const c of fieldChanges) {
    await client.graphql(
      `mutation($p:ID!,$i:ID!,$f:ID!,$v:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{text:$v}}){projectV2Item{id}}}`,
      { p: values.project, i: c.item.itemId, f: fieldId, v: c.to },
    );
  }
  if (values.ready) {
    const statusField: any = await client.graphql(
      `query($p:ID!){node(id:$p){... on ProjectV2{field(name:"Status"){... on ProjectV2SingleSelectField{id options{id name}}}}}}`,
      { p: values.project },
    );
    const sf = statusField?.node?.field;
    if (!sf) {
      console.error(`board-mirror: the project has no Status field — --ready cannot be applied`);
      return REFUSAL_EXIT;
    }
    const optionFor = new Map<string, string>(sf.options.map((o: any) => [o.name, o.id]));
    for (const c of readyWritable) {
      const option = optionFor.get(c.to);
      if (!option) {
        console.error(`board-mirror: Status has no option named "${c.to}" — refusing`);
        return REFUSAL_EXIT;
      }
      await client.graphql(
        `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}`,
        { p: values.project, i: c.item.itemId, f: sf.id, o: option },
      );
    }
  }
  console.log(
    `\n  wrote ${fieldChanges.length} ${values.field} cell(s)` +
      (values.ready ? ` and ${readyWritable.length} Status value(s)` : ``),
  );
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
