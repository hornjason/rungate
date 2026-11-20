/**
 * `rungate board-init`: make a consumer's project board, or adopt the one
 * `board.id` names, and hand back the ids to write into config (ADR-023,
 * SC-2789).
 *
 * Every board command assumes a board somebody made: `board-ready` and
 * `board-intake-move` need a Status field with the six lanes, `board-mirror`
 * needs a Criteria text field, and `readBoardConfig` returns null without
 * `board.id` and `board.fields.Criteria`. This makes all of it, so nothing on
 * a consumer's board is made or looked up by hand.
 *
 * ## Read, plan, write, read again
 *
 * The project is read, and `boardPlan` lists only what is missing. With
 * `write`, each step runs in order. Then the project is read again and planned
 * again, and anything still missing is UNMEASURED: a write GitHub accepted
 * that did not stick reads exactly like one that did, from the write's side.
 * Only a clean re-read returns ids, so the caller writes config only for a
 * board that is whole.
 *
 * ## Never a second board
 *
 * `board.id` is written last, so a run that stops part-way leaves none. The
 * next run looks among the OWNER's projects for the title rungate gives its
 * boards (`boardTitle`) and resumes that one, rather than creating another.
 * The owner's, not the repository's linked projects: linking is the first
 * write after the project is made, so a run that stopped there left a project
 * the repository does not list, and every retry made another (review of #2513).
 *
 * ## What it changes on a board it did not make
 *
 * Nothing it did not add. An adopted board keeps every field and option, with
 * their ids, and gains only the missing lanes, the Criteria field and a board
 * view. GitHub's default Status options are replaced only on rungate's own
 * unfinished board: one this run created, or one found by rungate's title whose
 * Status still holds exactly GitHub's three defaults, left by a run that
 * stopped first (review of #2513). A board found by title whose lanes somebody
 * changed keeps them, like any adopted board.
 */

/** The Status options GitHub gives a new project. */
export const GITHUB_DEFAULT_STATUS = ["Todo", "In Progress", "Done"] as const;

/** Whether a project's Status field still holds exactly GitHub's defaults. */
export function hasGitHubDefaultLanes(p: ProjectReading): boolean {
  const status = p.fields.filter(f => f.name === STATUS_FIELD);
  if (status.length !== 1) return false;
  return (status[0].options ?? []).map(o => o.name).join("\n") === GITHUB_DEFAULT_STATUS.join("\n");
}

/** The six lanes, in board order. `lib/board-flow.ts`'s `Lane` names the same six. */
export const BOARD_STATUS_OPTIONS = ["Backlog", "Ready", "In progress", "In review", "Done", "Cancelled"] as const;

export const STATUS_FIELD = "Status";
export const CRITERIA_FIELD = "Criteria";
export const BOARD_VIEW_NAME = "Board";

/**
 * The built-in automations that write lanes `board-flow` owns: "Item closed"
 * moves every closed item to Done whatever its close reason, and "Pull request
 * linked to issue" moves an issue to In progress when a pull request links it.
 * Both were switched off by hand on this repository's board on 2026-11-05
 * (`.github/workflows/board-flow.yml`'s header). "Pull request merged" stays:
 * it moves the pull request's own card, which nothing else writes. GitHub's
 * API has no switch for these, only `deleteProjectV2Workflow`.
 */
export const AUTOMATIONS_OFF = ["Item closed", "Pull request linked to issue"] as const;

/** The title rungate gives a board it makes, and the one it resumes by. */
export function boardTitle(repo: string): string {
  return `${repo.split("/")[1]} (rungate)`;
}

export interface FieldOption {
  id: string;
  name: string;
  color: string;
  description: string;
}

export interface ProjectField {
  id: string;
  name: string;
  dataType: string;
  options?: FieldOption[];
}

export interface ProjectReading {
  id: string;
  number: number;
  title: string;
  /** `owner/name` of every linked repository. */
  linkedRepositories: string[];
  fields: ProjectField[];
  views: Array<{ id: string; name: string; layout: string }>;
  workflows: Array<{ id: string; name: string; enabled: boolean }>;
}

/** What board-init needs from GitHub. Injected so a test never reaches the network. */
export interface BoardApi {
  ownerId(login: string): Promise<string>;
  repositoryId(repo: string): Promise<string>;
  /** Null when no project the token can read has that id. */
  project(id: string): Promise<ProjectReading | null>;
  /** The owner's projects whose title is `title`, linked to a repository or not. */
  ownerProjects(owner: string, title: string): Promise<Array<{ id: string; title: string }>>;
  createProject(ownerId: string, title: string): Promise<string>;
  linkRepository(projectId: string, repositoryId: string): Promise<void>;
  createField(projectId: string, name: string, dataType: "TEXT" | "SINGLE_SELECT", options?: Array<Omit<FieldOption, "id">>): Promise<void>;
  /** Replace a single-select field's options; an option given with its id keeps its values on every item. */
  setOptions(fieldId: string, options: Array<Omit<FieldOption, "id"> & { id?: string }>): Promise<void>;
  createView(projectId: string, name: string): Promise<void>;
  deleteWorkflow(workflowId: string): Promise<void>;
}

export type BoardStep =
  | { kind: "link-repository" }
  | { kind: "create-status-field" }
  | { kind: "set-status-options"; fieldId: string; options: Array<Omit<FieldOption, "id"> & { id?: string }>; added: string[] }
  | { kind: "create-criteria-field" }
  | { kind: "create-view" }
  | { kind: "turn-off-automation"; id: string; name: string };

const newOption = (name: string) => ({ name, color: "GRAY", description: "" });

/** One line per step, as the run prints it. */
export function describeStep(s: BoardStep, repo: string): string {
  switch (s.kind) {
    case "link-repository":
      return `link the project to ${repo}`;
    case "create-status-field":
      return `create the ${STATUS_FIELD} field with ${BOARD_STATUS_OPTIONS.join(", ")}`;
    case "set-status-options":
      return `give ${STATUS_FIELD} the lanes it lacks: ${s.added.join(", ")}`;
    case "create-criteria-field":
      return `create the ${CRITERIA_FIELD} text field`;
    case "create-view":
      return `create a board view, "${BOARD_VIEW_NAME}", by ${STATUS_FIELD}`;
    case "turn-off-automation":
      return `turn off the built-in automation "${s.name}"`;
  }
}

/**
 * What the project still needs, or why it cannot be planned. `fresh`: this run
 * created the project, so GitHub's default Status options are replaced rather
 * than kept.
 */
export function boardPlan(p: ProjectReading, repo: string, fresh: boolean): { steps: BoardStep[] } | { why: string } {
  const steps: BoardStep[] = [];
  if (!p.linkedRepositories.some(r => r.toLowerCase() === repo.toLowerCase())) steps.push({ kind: "link-repository" });

  const status = p.fields.filter(f => f.name === STATUS_FIELD);
  if (status.length > 1) return { why: `the project has ${status.length} fields named ${STATUS_FIELD}, so which one the lanes live in cannot be read` };
  if (status.length === 0) {
    steps.push({ kind: "create-status-field" });
  } else if (status[0].dataType !== "SINGLE_SELECT") {
    return { why: `the project's ${STATUS_FIELD} field is ${status[0].dataType}, not a single select, and board-init never replaces a field` };
  } else {
    const have = status[0].options ?? [];
    const added = BOARD_STATUS_OPTIONS.filter(name => !have.some(o => o.name === name));
    if (fresh && have.map(o => o.name).join("\n") !== BOARD_STATUS_OPTIONS.join("\n")) {
      steps.push({ kind: "set-status-options", fieldId: status[0].id, options: BOARD_STATUS_OPTIONS.map(newOption), added: [...BOARD_STATUS_OPTIONS] });
    } else if (!fresh && added.length > 0) {
      steps.push({ kind: "set-status-options", fieldId: status[0].id, options: [...have, ...added.map(newOption)], added });
    }
  }

  const criteria = p.fields.filter(f => f.name === CRITERIA_FIELD);
  if (criteria.length > 1) return { why: `the project has ${criteria.length} fields named ${CRITERIA_FIELD}` };
  if (criteria.length === 0) steps.push({ kind: "create-criteria-field" });
  else if (criteria[0].dataType !== "TEXT") {
    return { why: `the project's ${CRITERIA_FIELD} field is ${criteria[0].dataType}, not text, and board-init never replaces a field` };
  }

  if (!p.views.some(v => v.layout === "BOARD_LAYOUT")) steps.push({ kind: "create-view" });

  for (const name of AUTOMATIONS_OFF) {
    for (const w of p.workflows.filter(x => x.name === name && x.enabled)) steps.push({ kind: "turn-off-automation", id: w.id, name });
  }
  return { steps };
}

export type BoardInitResult =
  | { kind: "PLANNED"; steps: string[] }
  | { kind: "DONE"; projectId: string; fields: { Status: string; Criteria: string }; changed: string[] }
  | { kind: "UNMEASURED"; why: string; changed: string[] };

async function apply(api: BoardApi, projectId: string, repo: string, s: BoardStep): Promise<void> {
  switch (s.kind) {
    case "link-repository":
      return api.linkRepository(projectId, await api.repositoryId(repo));
    case "create-status-field":
      return api.createField(projectId, STATUS_FIELD, "SINGLE_SELECT", BOARD_STATUS_OPTIONS.map(newOption));
    case "set-status-options":
      return api.setOptions(s.fieldId, s.options);
    case "create-criteria-field":
      return api.createField(projectId, CRITERIA_FIELD, "TEXT");
    case "create-view":
      return api.createView(projectId, BOARD_VIEW_NAME);
    case "turn-off-automation":
      return api.deleteWorkflow(s.id);
  }
}

const fieldId = (p: ProjectReading, name: string) => p.fields.find(f => f.name === name)?.id ?? "";

export async function boardInit(opts: {
  repo: string;
  owner: string;
  boardId: string | null;
  write: boolean;
  api: BoardApi;
}): Promise<BoardInitResult> {
  const { repo, owner, boardId, write, api } = opts;
  const changed: string[] = [];
  const no = (why: string): BoardInitResult => ({ kind: "UNMEASURED", why, changed: [...changed] });

  try {
    let reading: ProjectReading | null;
    let fresh = false;
    if (boardId !== null) {
      reading = await api.project(boardId);
      if (reading === null) return no(`board.id is ${boardId}, and no project the token can read has that id`);
    } else {
      const title = boardTitle(repo);
      const ours = (await api.ownerProjects(owner, title)).filter(p => p.title === title);
      if (ours.length > 1) return no(`${ours.length} projects owned by ${owner} carry the title "${title}", so which one to resume cannot be read`);
      if (ours.length === 1) {
        reading = await api.project(ours[0].id);
        if (reading === null) return no(`the project "${title}" owned by ${owner} could not be read`);
        fresh = hasGitHubDefaultLanes(reading);
      } else {
        if (!write) {
          return {
            kind: "PLANNED",
            steps: [
              `create a project "${title}" owned by ${owner}`,
              ...["link-repository", "create-status-field", "create-criteria-field", "create-view"].map(k => describeStep({ kind: k } as BoardStep, repo)),
              ...AUTOMATIONS_OFF.map(name => `turn off the built-in automation "${name}"`),
            ],
          };
        }
        const id = await api.createProject(await api.ownerId(owner), title);
        changed.push(`created the project "${title}" owned by ${owner}`);
        reading = await api.project(id);
        if (reading === null) return no(`the project just created (${id}) could not be read back`);
        fresh = true;
      }
    }

    const plan = boardPlan(reading, repo, fresh);
    if ("why" in plan) return no(plan.why);
    if (!write) return { kind: "PLANNED", steps: plan.steps.map(s => describeStep(s, repo)) };

    for (const s of plan.steps) {
      try {
        await apply(api, reading.id, repo, s);
      } catch (e) {
        return no(`GitHub refused to ${describeStep(s, repo)} (${(e as Error).message})`);
      }
      changed.push(describeStep(s, repo));
    }

    const after = await api.project(reading.id);
    if (after === null) return no(`the project ${reading.id} could not be read back after the writes`);
    const left = boardPlan(after, repo, false);
    if ("why" in left) return no(left.why);
    if (left.steps.length > 0) {
      return no(`after the writes the board still needs: ${left.steps.map(s => describeStep(s, repo)).join("; ")}`);
    }
    return { kind: "DONE", projectId: after.id, fields: { Status: fieldId(after, STATUS_FIELD), Criteria: fieldId(after, CRITERIA_FIELD) }, changed };
  } catch (e) {
    return no(`GitHub could not be read (${(e as Error).message})`);
  }
}
