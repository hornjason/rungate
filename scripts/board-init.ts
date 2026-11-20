/**
 * Make a consumer's project board and write its ids into config (ADR-023, SC-2789).
 *
 * Usage:
 *   rungate board-init [--repo owner/name] [--owner <login>] [--project-root <dir>] [--write]
 *
 * Without `--write` it prints what it would do and changes nothing. With it,
 * it creates the project (or adopts the one `board.id` names), links it to
 * the repository, gives it the six lanes, a Criteria text field and a board
 * view, turns off the two built-in automations that write lanes `board-flow`
 * owns, and writes `board.id` and `board.fields` into `.claude/rungate/`.
 * A second run changes nothing. `lib/board-init.ts` decides; this reads,
 * writes and reports.
 *
 * The repository is `--repo`, then `GITHUB_REPOSITORY`, then the origin
 * remote (`rungate board`'s resolver). The board is owned by the repository's
 * owner unless `--owner` says otherwise (Jason, 2026-11-19, ADR-023). The token
 * needs the `project` scope; one without it is refused by GitHub, and that
 * refusal is printed as UNMEASURED.
 */
import { resolve } from "path";

import { boardInit, type BoardApi, type ProjectReading } from "../lib/board-init";
import { readBoardProjectId } from "../lib/config-readers";
import { resolveConfig, writeBoardConfig } from "../lib/config-loader";
import { createGitHubClient, parseOwnerRepo, resolveGitHubToken, type GitHubClient } from "../lib/github";
import { resolveRepo } from "./status-view";

/** A reading not taken, or a run asked for wrongly. Nothing was written to config. */
export const REFUSAL_EXIT = 2;

/** How many of each list one read takes. A project with more is refused, not read in part. */
const PAGE = 100;

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? "");
}

/** Every list must have been read whole: a field or workflow past the page would read as absent. */
function whole<T>(conn: { totalCount?: unknown; nodes?: unknown } | undefined, what: string): T[] {
  if (!conn || !Array.isArray(conn.nodes) || typeof conn.totalCount !== "number") throw new Error(`the project's ${what} could not be read`);
  if (conn.totalCount !== conn.nodes.length) throw new Error(`the project has ${conn.totalCount} ${what} and ${conn.nodes.length} were read`);
  return conn.nodes as T[];
}

export function liveBoardApi(client: GitHubClient): BoardApi {
  const q = async <T>(query: string, vars: Record<string, unknown>) => (await client.graphql(query, vars)) as T;
  return {
    ownerId: async login => {
      const r = await q<{ repositoryOwner?: { id?: string } | null }>(`query($l: String!) { repositoryOwner(login: $l) { id } }`, { l: login });
      if (!r.repositoryOwner?.id) throw new Error(`no user or organisation named ${login}`);
      return r.repositoryOwner.id;
    },
    repositoryId: async repo => {
      const { owner, repo: name } = parseOwnerRepo(repo);
      const r = await q<{ repository?: { id?: string } | null }>(`query($o: String!, $n: String!) { repository(owner: $o, name: $n) { id } }`, { o: owner, n: name });
      if (!r.repository?.id) throw new Error(`${repo} was not found, or the token cannot read it`);
      return r.repository.id;
    },
    project: async id => {
      const r = await q<{ node?: Record<string, any> | null }>(
        `query($id: ID!) { node(id: $id) { ... on ProjectV2 {
          id number title
          repositories(first: ${PAGE}) { totalCount nodes { nameWithOwner } }
          fields(first: ${PAGE}) { totalCount nodes {
            ... on ProjectV2FieldCommon { id name dataType }
            ... on ProjectV2SingleSelectField { options { id name color description } }
          } }
          views(first: ${PAGE}) { totalCount nodes { id name layout } }
          workflows(first: ${PAGE}) { totalCount nodes { id name enabled } }
        } } }`,
        { id },
      );
      const p = r.node;
      if (!p || typeof p.id !== "string") return null;
      const reading: ProjectReading = {
        id: p.id,
        number: p.number,
        title: p.title,
        linkedRepositories: whole<{ nameWithOwner: string }>(p.repositories, "linked repositories").map(x => x.nameWithOwner),
        fields: whole<ProjectReading["fields"][number]>(p.fields, "fields"),
        views: whole<ProjectReading["views"][number]>(p.views, "views"),
        workflows: whole<ProjectReading["workflows"][number]>(p.workflows, "workflows"),
      };
      return reading;
    },
    // A user and an organisation each own projects; `query` narrows the list
    // to titles matching the words, and board-init keeps the exact title.
    ownerProjects: async (login, title) => {
      const r = await q<{ repositoryOwner?: { projectsV2?: { totalCount?: number; nodes?: unknown } } | null }>(
        `query($l: String!, $t: String!) { repositoryOwner(login: $l) {
          ... on User { projectsV2(first: ${PAGE}, query: $t) { totalCount nodes { id title } } }
          ... on Organization { projectsV2(first: ${PAGE}, query: $t) { totalCount nodes { id title } } }
        } }`,
        { l: login, t: title },
      );
      if (!r.repositoryOwner) throw new Error(`no user or organisation named ${login}`);
      return whole<{ id: string; title: string }>(r.repositoryOwner.projectsV2, `projects owned by ${login}`);
    },
    createProject: async (ownerId, title) => {
      const r = await q<{ createProjectV2?: { projectV2?: { id?: string } } }>(
        `mutation($o: ID!, $t: String!) { createProjectV2(input: { ownerId: $o, title: $t }) { projectV2 { id } } }`,
        { o: ownerId, t: title },
      );
      if (!r.createProjectV2?.projectV2?.id) throw new Error("createProjectV2 returned no project");
      return r.createProjectV2.projectV2.id;
    },
    linkRepository: async (projectId, repositoryId) => {
      await q(`mutation($p: ID!, $r: ID!) { linkProjectV2ToRepository(input: { projectId: $p, repositoryId: $r }) { repository { id } } }`, { p: projectId, r: repositoryId });
    },
    createField: async (projectId, name, dataType, options) => {
      await q(
        `mutation($p: ID!, $n: String!, $d: ProjectV2CustomFieldType!, $o: [ProjectV2SingleSelectFieldOptionInput!]) {
          createProjectV2Field(input: { projectId: $p, name: $n, dataType: $d, singleSelectOptions: $o }) { projectV2Field { ... on ProjectV2FieldCommon { id } } } }`,
        { p: projectId, n: name, d: dataType, o: options ?? null },
      );
    },
    setOptions: async (fieldId, options) => {
      await q(
        `mutation($f: ID!, $o: [ProjectV2SingleSelectFieldOptionInput!]) {
          updateProjectV2Field(input: { fieldId: $f, singleSelectOptions: $o }) { projectV2Field { ... on ProjectV2FieldCommon { id } } } }`,
        { f: fieldId, o: options },
      );
    },
    createView: async (projectId, name) => {
      await q(`mutation($p: ID!, $n: String!) { createProjectV2View(input: { projectId: $p, name: $n, layout: BOARD_LAYOUT }) { projectV2View { id } } }`, { p: projectId, n: name });
    },
    deleteWorkflow: async workflowId => {
      await q(`mutation($w: ID!) { deleteProjectV2Workflow(input: { workflowId: $w }) { deletedWorkflowId } }`, { w: workflowId });
    },
  };
}

export async function main(argv: string[], root = process.cwd(), api?: BoardApi): Promise<number> {
  const refuse = (why: string) => {
    console.error(`board-init: UNMEASURED — ${why}. Nothing was written to config.`);
    return REFUSAL_EXIT;
  };
  const rootFlag = flag(argv, "--project-root");
  if (rootFlag === "") return refuse("--project-root needs a directory after it");
  const projectRoot = rootFlag === null ? root : resolve(rootFlag);
  const write = argv.includes("--write");

  if (resolveConfig(projectRoot).status === "absent") return refuse(`${projectRoot} has no rungate config; run rungate scaffold first`);

  const named = resolveRepo(argv, process.env, projectRoot);
  let repo: string;
  try {
    if (named === null) throw new Error("no --repo, no GITHUB_REPOSITORY, and no GitHub origin remote");
    const { owner, repo: name } = parseOwnerRepo(named);
    repo = `${owner}/${name}`;
  } catch (e) {
    return refuse(`no repository to make a board for (${(e as Error).message})`);
  }
  const ownerFlag = flag(argv, "--owner");
  if (ownerFlag === "") return refuse("--owner needs a login after it");
  const owner = ownerFlag ?? repo.split("/")[0];

  let board = api;
  if (!board) {
    if (!resolveGitHubToken()) return refuse("no GitHub credential; set GITHUB_TOKEN or GH_TOKEN to a token with the project scope");
    board = liveBoardApi(createGitHubClient());
  }

  const r = await boardInit({ repo, owner, boardId: readBoardProjectId(projectRoot), write, api: board });
  for (const c of r.kind === "PLANNED" ? [] : r.changed) console.log(`board-init: ${c}`);
  if (r.kind === "UNMEASURED") return refuse(r.why);
  if (r.kind === "PLANNED") {
    if (r.steps.length === 0) console.log("board-init: the board is whole; nothing to do.");
    for (const s of r.steps) console.log(`board-init: would ${s}`);
    if (r.steps.length > 0) console.log("board-init: nothing was changed; --write makes these changes and writes board.id and board.fields.");
    return 0;
  }
  // #2514: the board is whole by now, so a refused config write is reported
  // like every other refusal. The next run finds the board by its title.
  let written: { path: string; changed: boolean };
  try {
    written = writeBoardConfig(projectRoot, { id: r.projectId, fields: r.fields });
  } catch (e) {
    return refuse(`the board ${r.projectId} is whole on GitHub, but its ids could not be written into the config (${(e as Error).message})`);
  }
  console.log(
    written.changed
      ? `board-init: wrote board.id and board.fields into ${written.path}.`
      : `board-init: ${written.path} already names this board; nothing changed.`,
  );
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
