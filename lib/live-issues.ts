/**
 * The repository's issues as the board readings need them — one reader.
 *
 * `scripts/plan-deps.ts` has read issues, their phase milestone and their
 * live `blocked by` edges since ADR-003 step 5. `scripts/board-snapshot.ts`
 * (item **B3**) needs exactly the same reading to say whether the order is
 * on the tracker. Copying the query would make two readers of one fact, and
 * `.claude/rules/checks-must-be-able-to-fail.md` names that shape: two
 * deciders that agree are behaviourally one, so no behavioural test can tell
 * them apart and a mutation of either leaves the other holding the case up.
 *
 * So the query, its page size and the subprocess live here, and both
 * consumers call {@link readLiveIssues}.
 *
 * ## It never writes
 *
 * `plan-deps --write` applies edges. This reads them.
 */
import { phaseInFamily } from "./spec-placement";
import type { DepIssue } from "./spec-deps";

/**
 * Page size, for the issue list and for each issue's blocker connection.
 *
 * The blocker connection matters more than the issue list: a second page of
 * issues is followed, and a second page of BLOCKERS is reported as
 * {@link LiveIssue.blockedByTruncated} rather than followed, because an edge
 * past the boundary reads as missing and would be re-added.
 */
export const ISSUE_PAGE = 100;

/**
 * Does this milestone belong to the spec family named by `prefix`?
 *
 * DEFINED as the anchored phase parse succeeding, rather than spelled out
 * again here. `lib/spec-placement.ts` builds every derived title as
 * `${prefix} ${heading}` where the heading is `Phase N` or `Phase N — text`,
 * and `phaseInFamily` is the one function that reads that grammar.
 *
 * ## Why it is a delegation and not a `startsWith`
 *
 * It WAS a `startsWith(`${prefix} Phase `)`, with a docblock claiming to be
 * the one binding `plan-deps` and `board-snapshot` shared. That claim was
 * false: `board-snapshot` reaches the question through `milestonePlan`,
 * whose own `phaseOf` compiled `^<prefix> Phase (\d+)\b`. Two deciders
 * answering one question about one input — the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md` — and they disagreed, on
 * `"Pipeline Phase  1 — oops"` and on anything else with no number after
 * `Phase `. Round 2 of #1705.
 *
 * The anchor itself is still the point, and still not a bare
 * `startsWith(prefix)`: that admits any family whose name merely BEGINS
 * with this one — `Pipe` matching `Pipeline Phase 0`, `Fix` matching
 * `Fixture Phase 2` — which is the cross-spec contamination the prefix
 * exists to prevent, arriving through the fix for it (round 2 of #1703).
 */
export function inMilestoneFamily(milestone: string | null | undefined, prefix: string): boolean {
  return phaseInFamily(milestone, prefix) !== null;
}

/**
 * What a `--prefix` / `--milestone-prefix` argument actually said.
 *
 * Three states, never two. A command that collapses them has to pick which
 * lie to tell: `absent` folded into `blank` refuses a caller who asked for no
 * filter, and `blank` folded into `given` hands {@link inMilestoneFamily} the
 * string `""`, which matches `" Phase "` in every family at once.
 *
 * ## It trims, and that is the whole of round 1 of #1705
 *
 * `plan-deps` tested `raw.trim() === ""` for emptiness and then filtered with
 * the UNTRIMMED `raw`, so the guard and the use disagreed about every input
 * with whitespace on an end. `--milestone-prefix " Pipeline"` — a shell
 * variable with a stray space, a CI input, a copy-paste — passed the guard,
 * matched nothing, and refused with a message naming a string that looks like
 * it should obviously match.
 *
 * `plan-spec` and `board-snapshot` had the same split in the other direction:
 * `if (!prefix)` admits `"   "`, and `plan-spec --write` would then CREATE
 * milestones called `"    Phase 0 — …"`. One reading, returned trimmed, so
 * there is nothing for a guard and a use to disagree about.
 *
 * Ends only. `" Spec Two "` is `"Spec Two"`, not `"SpecTwo"` — a two-word
 * family name is the ordinary case on a tracker carrying more than one spec.
 *
 * `scripts/board-conformance.ts` deliberately does NOT call this: it must
 * stay free of relative imports or its mutation battery's copy dies on module
 * resolution and every negative case goes green having witnessed nothing. It
 * forwards the argument to `board-snapshot`, which does call this, so the
 * decision still happens exactly once — see
 * `.claude/rules/checks-must-be-able-to-fail.md`, *two deciders that agree*.
 */
export type MilestonePrefixReading =
  | { readonly kind: "absent" }
  | { readonly kind: "blank"; readonly raw: string }
  | { readonly kind: "given"; readonly prefix: string };

export function readMilestonePrefix(raw: string | undefined): MilestonePrefixReading {
  if (raw === undefined) return { kind: "absent" };
  const prefix = raw.trim();
  return prefix === "" ? { kind: "blank", raw } : { kind: "given", prefix };
}

/**
 * One issue, with everything a board reading asks about it.
 *
 * ## Labels come back too, and they are read rather than assumed
 *
 * `board-conformance`'s `queue-label` reading counts issues carrying
 * `engine`, so the snapshot has to say something about labels. Emitting an
 * empty list for every issue would report a number nobody measured — a zero
 * that happens to be right is `.claude/rules/config-access.md`'s *Silent
 * Default Substitution*, and it is indistinguishable from a board where
 * nothing is labelled. One extra field on a query already being run is the
 * honest option.
 */
export interface LiveIssue extends DepIssue {
  /** Every label name on the issue, as GitHub spells them. */
  readonly labels: readonly string[];
  /**
   * The issue's title and body, for reading which criteria it names — SC-2616.
   *
   * ADR-003 step 3 says an issue declares what it serves as plain text in its
   * body, so `criteriaNamedBy` needs both. Neither is a paged connection, so
   * neither carries a truncation flag: GitHub returns a body whole or not at
   * all.
   *
   * `body` is `null` when the issue has none, which is a real state and not a
   * read that failed — an issue with an empty body names no criterion, which
   * is exactly what `criteria-named` is there to report.
   */
  readonly title: string;
  readonly body: string | null;
  /**
   * True when the LABEL list was cut — a paged connection reporting another
   * page. Same reasoning as {@link DepIssue.blockedByTruncated}, and here
   * for the same reason: `queue-label` asks `labels.includes("engine")`, so
   * a label past the boundary reads as ABSENT and the issue counts short
   * having been looked at wrong.
   *
   * Every paged connection in {@link LIVE_ISSUES_QUERY} either carries a
   * truncation flag or is followed to the end. Round 1 of #1703 found this
   * on `labels` after `blockedBy` had been handled correctly; it is
   * recorded as the property because repairing one member of a population
   * leaves the next one silent.
   */
  readonly labelsTruncated?: boolean;
}

export const LIVE_ISSUES_QUERY = `
query($owner:String!,$name:String!,$states:[IssueState!],$after:String){
  repository(owner:$owner,name:$name){
    issues(first:${ISSUE_PAGE},after:$after,states:$states){
      pageInfo{hasNextPage endCursor}
      nodes{
        number
        state
        title
        body
        milestone{title}
        labels(first:${ISSUE_PAGE}){pageInfo{hasNextPage} nodes{name}}
        blockedBy(first:${ISSUE_PAGE}){pageInfo{hasNextPage} nodes{number}}
      }
    }
  }
}`;

/** One shape of the GraphQL page, so nothing below is inferred as `any`. */
interface IssuePage {
  pageInfo: { hasNextPage: boolean; endCursor: string };
  nodes: {
    number: number;
    state: string;
    title: string;
    body: string | null;
    milestone: { title: string } | null;
    labels: { pageInfo: { hasNextPage: boolean }; nodes: { name: string }[] } | null;
    blockedBy: { pageInfo: { hasNextPage: boolean }; nodes: { number: number }[] } | null;
  }[];
}

/**
 * `gh`, with `GH_TOKEN` unset.
 *
 * Deleted rather than set to `undefined`: spreading `process.env` and
 * overwriting one key with `undefined` leaves the key PRESENT in the object
 * Bun hands the child, and `gh` prefers `GH_TOKEN` to its own keychain
 * whenever the variable exists at all.
 *
 * ## `cwd`, because that is what `gh` infers the repository from
 *
 * With no `--repo`, `gh` reads the git remote of the directory it runs in.
 * A caller that was told which tree to work on by an argument — rather than
 * by having been launched in it — would otherwise read one repository's
 * tracker while reporting about another's files, and nothing in either
 * reading would say so. Raised in review of #1878. Absent means the
 * process's own directory, which is what every existing caller gets.
 */
export function ghWithoutGhToken(args: readonly string[], opts: { cwd?: string } = {}): string {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.GH_TOKEN;
  const proc = Bun.spawnSync(["gh", ...args], { env, ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }) });
  if (proc.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(proc.stderr).trim().slice(0, 300));
  }
  return new TextDecoder().decode(proc.stdout);
}

/** How a GraphQL call is made. Injected so the mapping below has a test. */
export type GraphQlExec = (args: readonly string[]) => string;

/**
 * Every issue in the repository, paged to the end.
 *
 * Throws on a failed call rather than returning an empty list. A caller that
 * cannot tell "the repository has no issues" from "the call failed" reports
 * the flattering one.
 *
 * `exec` is a parameter because both consumers inject a fake at the
 * `readIssues` seam ABOVE this function, so without it the field mapping and
 * the pagination loop — the only logic this module has — run in no test.
 * Round 1 of #1703.
 */
export async function readLiveIssues(
  repo: string,
  includeClosed: boolean,
  exec: GraphQlExec = ghWithoutGhToken,
): Promise<LiveIssue[]> {
  const [owner, name] = repo.split("/");
  const out: LiveIssue[] = [];
  let after: string | null = null;
  for (;;) {
    const raw = exec([
      "api",
      "graphql",
      "-f",
      `query=${LIVE_ISSUES_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      ...(includeClosed ? [] : ["-f", "states=OPEN"]),
      ...(after === null ? [] : ["-f", `after=${after}`]),
    ]);
    const page = (JSON.parse(raw) as { data: { repository: { issues: IssuePage } } }).data
      .repository.issues;
    for (const n of page.nodes) {
      out.push({
        number: n.number,
        state: n.state,
        title: n.title,
        body: n.body,
        milestone: n.milestone?.title ?? null,
        labels: (n.labels?.nodes ?? []).map(l => l.name),
        labelsTruncated: n.labels?.pageInfo.hasNextPage === true,
        blockedBy: (n.blockedBy?.nodes ?? []).map(b => b.number),
        // A second page means this list is CUT, not short. `dependencyPlan`
        // refuses rather than deriving from it: an unread blocker past the
        // boundary reads as missing and gets re-added.
        blockedByTruncated: n.blockedBy?.pageInfo.hasNextPage === true,
      });
    }
    if (!page.pageInfo.hasNextPage) return out;
    after = page.pageInfo.endCursor;
  }
}

/**
 * How many numbers one {@link readIssueStates} call resolves.
 *
 * Aliased `issue(number:)` lookups in a single query. GitHub scores a
 * query by its node count, so this is a chunk size rather than a limit on
 * what the caller may ask for.
 */
export const STATE_BATCH = 50;

/**
 * The state of specific issues, BY NUMBER — #1704.
 *
 * ## Why this is not `readLiveIssues(repo, true)`
 *
 * `board-snapshot` needs to tell a FINISHED blocker from one that never
 * existed, and both are simply absent from the open population. The
 * obvious fix is to read closed issues too. Measured on hornjason/rungate:
 * 72 open issues, 805 in total — so that turns a one-page read into nine,
 * on a command CI runs and an unattended loop polls, and every extra page
 * is another chance at the HTTP 502 that was observed while this was being
 * written.
 *
 * This resolves only the numbers actually named by an edge, which is a
 * handful and does not grow with the repository's age.
 *
 * A number naming no issue at all is ABSENT from the returned map — not
 * recorded with some placeholder state. That is the distinction the whole
 * change exists to preserve, so it must survive this function: a typo and
 * a finished issue have to come back different.
 */
export async function readIssueStates(
  repo: string,
  numbers: readonly number[],
  exec: GraphQlExec = ghWithoutGhToken,
): Promise<Map<number, string>> {
  const [owner, name] = repo.split("/");
  const out = new Map<number, string>();
  const unique = [...new Set(numbers)];
  for (let at = 0; at < unique.length; at += STATE_BATCH) {
    const chunk = unique.slice(at, at + STATE_BATCH);
    const fields = chunk.map(n => `i${n}: issue(number:${n}){number state}`).join(" ");
    const raw = exec([
      "api",
      "graphql",
      "-f",
      `query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${fields}}}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
    ]);
    const repoNode = (JSON.parse(raw) as { data: { repository: Record<string, { number: number; state: string } | null> } })
      .data.repository;
    for (const node of Object.values(repoNode ?? {})) {
      if (node !== null && node !== undefined) out.set(node.number, node.state);
    }
  }
  return out;
}

/**
 * What a project board's custom field says about one issue — item **B4**.
 *
 * FOUR states, and each of the three that are not a value means something
 * different to the reading:
 *
 * - `value`    the column is populated. Counted.
 * - `empty`    the issue is on this project and the column is blank.
 * - `off-board` the issue is on no item of this project at all.
 * - `truncated` its project-item list was cut before this project was
 *   reached, so whether it is on the board is UNKNOWN.
 *
 * `empty` and `off-board` are both *the column is not populated for this
 * issue*, which is what `criteria-field` asks, so `board-snapshot` emits
 * `null` for both. `truncated` is not an answer at all and omits the key,
 * which is what turns the reading UNMEASURED. Collapsing it into
 * `off-board` would report a board nobody finished reading as short.
 */
export type ProjectFieldReading =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "empty" }
  | { readonly kind: "off-board" }
  | { readonly kind: "truncated" };

/**
 * How many project items one issue's connection is read for.
 *
 * An issue is normally on one project, occasionally two. This is generous
 * and still reports being cut rather than guessing — see `truncated` above.
 */
export const PROJECT_ITEM_PAGE = 20;

/** How many issues one {@link readProjectFieldValues} call resolves. */
export const FIELD_BATCH = 25;

/**
 * Resolve a ProjectV2 field ID to its name and the project that owns it.
 *
 * ## Why the NAME is derived rather than configured
 *
 * The value query is `fieldValueByName(name:)` — GitHub offers no
 * by-id form — so the name has to come from somewhere. Putting it in config
 * beside the id would be two identifiers for one field, free to disagree,
 * and a rename on the board would silently read every value as blank. The
 * id is the one identifier; the name is whatever it resolves to today.
 *
 * The project id comes back for the same reason: `board.id` and
 * `board.fields.Criteria` sit in one config block and nothing has ever
 * compared them. A field belonging to another project would read values off
 * a board this repository does not use, and they would look like ours.
 */
export async function readProjectFieldIdentity(
  fieldId: string,
  exec: GraphQlExec = ghWithoutGhToken,
): Promise<{ name: string; projectId: string }> {
  const raw = exec([
    "api",
    "graphql",
    "-f",
    "query=query($id:ID!){node(id:$id){... on ProjectV2FieldCommon{name project{id}}}}",
    "-f",
    `id=${fieldId}`,
  ]);
  const node = (JSON.parse(raw) as { data: { node: { name?: string; project?: { id?: string } } | null } }).data
    .node;
  if (!node?.name || !node.project?.id) {
    throw new Error(`${fieldId} did not resolve to a project field with a name and a project`);
  }
  return { name: node.name, projectId: node.project.id };
}

/**
 * One project field's value for specific issues — item **B4**.
 *
 * Targeted by number, for the reason {@link readIssueStates} gives: the
 * population that matters is the handful of engine issues, not every issue
 * the repository has ever had.
 *
 * The item is matched on `projectId` rather than taken as `nodes[0]`. An
 * issue on two projects returns two items in an order nothing guarantees,
 * and reading the wrong one is a measurement of somebody else's board.
 */
export async function readProjectFieldValues(
  repo: string,
  numbers: readonly number[],
  projectId: string,
  fieldName: string,
  exec: GraphQlExec = ghWithoutGhToken,
): Promise<Map<number, ProjectFieldReading>> {
  const [owner, name] = repo.split("/");
  const out = new Map<number, ProjectFieldReading>();
  const unique = [...new Set(numbers)];
  for (let at = 0; at < unique.length; at += FIELD_BATCH) {
    const chunk = unique.slice(at, at + FIELD_BATCH);
    const selection =
      `number projectItems(first:${PROJECT_ITEM_PAGE}){pageInfo{hasNextPage} ` +
      `nodes{project{id} fieldValueByName(name:$field){... on ProjectV2ItemFieldTextValue{text}}}}`;
    const aliases = chunk.map(n => `i${n}: issue(number:${n}){${selection}}`).join(" ");
    const raw = exec([
      "api",
      "graphql",
      "-f",
      `query=query($owner:String!,$name:String!,$field:String!){repository(owner:$owner,name:$name){${aliases}}}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-f",
      `field=${fieldName}`,
    ]);
    const repoNode = (
      JSON.parse(raw) as {
        data: {
          repository: Record<
            string,
            {
              number: number;
              projectItems: {
                pageInfo: { hasNextPage: boolean };
                nodes: { project: { id: string } | null; fieldValueByName: { text?: string | null } | null }[];
              };
            } | null
          >;
        };
      }
    ).data.repository;
    for (const n of chunk) {
      const node = repoNode?.[`i${n}`];
      if (node === null || node === undefined) {
        out.set(n, { kind: "off-board" });
        continue;
      }
      const item = node.projectItems.nodes.find(i => i.project?.id === projectId);
      if (item === undefined) {
        out.set(n, node.projectItems.pageInfo.hasNextPage ? { kind: "truncated" } : { kind: "off-board" });
        continue;
      }
      const text = (item.fieldValueByName?.text ?? "").trim();
      out.set(n, text === "" ? { kind: "empty" } : { kind: "value", value: text });
    }
  }
  return out;
}
