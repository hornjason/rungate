/**
 * Covers SC-2789 (SPEC-TO-BOARD-PIPELINE-SPEC.md, ADR-023): `rungate
 * board-init` makes a consumer's project board, or adopts the one `board.id`
 * names, and writes `board.id` and `board.fields` into the config. A second
 * run changes nothing, and anything it cannot create or read is UNMEASURED
 * with no partial config written.
 *
 * Every case runs against an in-memory board that records each mutation, so
 * "a second run changes nothing" is a count of writes, not a description.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  AUTOMATIONS_OFF,
  BOARD_STATUS_OPTIONS,
  boardInit,
  boardTitle,
  type BoardApi,
  type ProjectReading,
} from "../lib/board-init";
import { writeBoardConfig } from "../lib/config-loader";
import { CLI_COMMANDS } from "../lib/cli-commands";
import { REFUSAL_EXIT, main as boardInitMain } from "../scripts/board-init";

const REPO = "acme/widgets";

/** GitHub's defaults for a new project: three Status options and its built-in automations. */
function freshProject(id: string, title: string): ProjectReading {
  return {
    id,
    number: 1,
    title,
    linkedRepositories: [],
    fields: [
      { id: `${id}-title`, name: "Title", dataType: "TITLE" },
      {
        id: `${id}-status`,
        name: "Status",
        dataType: "SINGLE_SELECT",
        options: ["Todo", "In Progress", "Done"].map((name, i) => ({ id: `${id}-opt-${i}`, name, color: "GRAY", description: "" })),
      },
    ],
    views: [{ id: `${id}-view-table`, name: "View 1", layout: "TABLE_LAYOUT" }],
    workflows: [
      { id: `${id}-wf-closed`, name: "Item closed", enabled: true },
      { id: `${id}-wf-linked`, name: "Pull request linked to issue", enabled: true },
      { id: `${id}-wf-merged`, name: "Pull request merged", enabled: true },
      { id: `${id}-wf-added`, name: "Item added to project", enabled: true },
    ],
  };
}

/** An in-memory board. `writes` records every mutation in order. */
function memoryBoard(seed: ProjectReading[] = [], faults: { failOn?: string; ignoreOptions?: boolean } = {}) {
  const projects = new Map(seed.map(p => [p.id, structuredClone(p)]));
  const writes: string[] = [];
  let n = 0;
  const fault = (what: string) => {
    writes.push(what);
    if (faults.failOn && what.startsWith(faults.failOn)) throw new Error(`refused: ${what}`);
  };
  const api: BoardApi = {
    ownerId: async login => `owner:${login}`,
    repositoryId: async repo => `repo:${repo}`,
    project: async id => (projects.has(id) ? structuredClone(projects.get(id)!) : null),
    ownerProjects: async (_owner, title) => [...projects.values()].filter(p => p.title === title).map(p => ({ id: p.id, title: p.title })),
    createProject: async (_owner, title) => {
      fault(`create-project ${title}`);
      const id = `P${++n}`;
      projects.set(id, freshProject(id, title));
      return id;
    },
    linkRepository: async (projectId, repoId) => {
      fault(`link ${repoId}`);
      projects.get(projectId)!.linkedRepositories.push(repoId.replace(/^repo:/, ""));
    },
    createField: async (projectId, name, dataType, options) => {
      fault(`create-field ${name}`);
      projects.get(projectId)!.fields.push({
        id: `${projectId}-field-${name}`,
        name,
        dataType,
        ...(options ? { options: options.map((o, i) => ({ id: `${projectId}-${name}-${i}`, ...o })) } : {}),
      });
    },
    setOptions: async (fieldId, options) => {
      fault(`set-options ${options.map(o => o.name).join(",")}`);
      if (faults.ignoreOptions) return;
      for (const p of projects.values()) {
        const f = p.fields.find(x => x.id === fieldId);
        if (f) f.options = options.map((o, i) => ({ id: o.id ?? `${fieldId}-new-${i}`, name: o.name, color: o.color, description: o.description }));
      }
    },
    createView: async (projectId, name) => {
      fault(`create-view ${name}`);
      projects.get(projectId)!.views.push({ id: `${projectId}-view-${name}`, name, layout: "BOARD_LAYOUT" });
    },
    deleteWorkflow: async workflowId => {
      fault(`delete-workflow ${workflowId}`);
      for (const p of projects.values()) p.workflows = p.workflows.filter(w => w.id !== workflowId);
    },
  };
  return { api, writes, projects, faults };
}

const statusNames = (p: ProjectReading) => p.fields.find(f => f.name === "Status")?.options?.map(o => o.name);

describe("SC-2789: board-init makes a board and wires it", () => {
  test("SC-2789: a fresh board gets the six lanes, a Criteria text field, a board view, and the two automations off", async () => {
    const { api, projects } = memoryBoard();
    const r = await boardInit({ repo: REPO, owner: "acme", boardId: null, write: true, api });
    expect(r.kind, "why" in r ? r.why : "").toBe("DONE");
    if (r.kind !== "DONE") return;
    const p = projects.get(r.projectId)!;
    expect(p.title).toBe(boardTitle(REPO));
    expect(p.linkedRepositories).toEqual([REPO]);
    // GitHub's defaults were rungate's to replace: it created this project.
    expect(statusNames(p)).toEqual([...BOARD_STATUS_OPTIONS]);
    expect(p.fields.find(f => f.name === "Criteria")?.dataType).toBe("TEXT");
    expect(p.views.some(v => v.layout === "BOARD_LAYOUT")).toBe(true);
    expect(p.workflows.map(w => w.name).sort()).toEqual(["Item added to project", "Pull request merged"]);
    expect(r.fields).toEqual({ Status: `${r.projectId}-status`, Criteria: `${r.projectId}-field-Criteria` });
  });

  test("SC-2789: a second run changes nothing", async () => {
    const { api, writes } = memoryBoard();
    const first = await boardInit({ repo: REPO, owner: "acme", boardId: null, write: true, api });
    expect(first.kind).toBe("DONE");
    if (first.kind !== "DONE") return;
    const before = writes.length;
    const second = await boardInit({ repo: REPO, owner: "acme", boardId: first.projectId, write: true, api });
    expect(second.kind).toBe("DONE");
    expect(writes.slice(before)).toEqual([]);
    if (second.kind === "DONE") expect(second.changed).toEqual([]);
  });

  test("SC-2789: an adopted board keeps every field and option it has, and gains only what is missing", async () => {
    const mine = freshProject("MINE", "Our own board");
    mine.linkedRepositories = [REPO];
    mine.fields.push({ id: "MINE-criteria", name: "Criteria", dataType: "TEXT" });
    mine.views.push({ id: "MINE-board", name: "Kanban", layout: "BOARD_LAYOUT" });
    const { api, writes, projects } = memoryBoard([mine]);
    const r = await boardInit({ repo: REPO, owner: "acme", boardId: "MINE", write: true, api });
    expect(r.kind, "why" in r ? r.why : "").toBe("DONE");
    const p = projects.get("MINE")!;
    // Kept, with their ids; "In Progress" is not "In progress", so both stand.
    expect(statusNames(p)).toEqual(["Todo", "In Progress", "Done", "Backlog", "Ready", "In progress", "In review", "Cancelled"]);
    expect(p.fields.find(f => f.name === "Status")!.options!.slice(0, 3).map(o => o.id)).toEqual(["MINE-opt-0", "MINE-opt-1", "MINE-opt-2"]);
    expect(writes.some(w => w.startsWith("create-project") || w.startsWith("create-field") || w.startsWith("create-view") || w.startsWith("link"))).toBe(false);
    expect(r.kind === "DONE" && r.fields.Criteria).toBe("MINE-criteria");
  });

  test("SC-2789: a run that stopped part-way is resumed on the board it made, never a second one", async () => {
    const half = memoryBoard([], { failOn: "create-view" });
    const first = await boardInit({ repo: REPO, owner: "acme", boardId: null, write: true, api: half.api });
    expect(first.kind).toBe("UNMEASURED");
    // board.id was never written, so the next run finds the board by the title
    // rungate gives it, among the owner's projects.
    half.faults.failOn = undefined;
    const resumed = await boardInit({ repo: REPO, owner: "acme", boardId: null, write: true, api: half.api });
    expect(resumed.kind, "why" in resumed ? resumed.why : "").toBe("DONE");
    expect(half.writes.filter(w => w.startsWith("create-project"))).toHaveLength(1);
    expect(half.projects.size).toBe(1);
  });

  // Review of #2513: the link to the repository is the first write after the
  // project is made. A run that stopped there left a project no search of the
  // repository's linked projects could find, so every retry made another.
  test("SC-2789: a run that stopped before the repository link is resumed, never a second board", async () => {
    const half = memoryBoard([], { failOn: "link" });
    const first = await boardInit({ repo: REPO, owner: "acme", boardId: null, write: true, api: half.api });
    expect(first.kind).toBe("UNMEASURED");
    expect(half.projects.size).toBe(1);
    expect([...half.projects.values()][0].linkedRepositories).toEqual([]);
    half.faults.failOn = undefined;
    const resumed = await boardInit({ repo: REPO, owner: "acme", boardId: null, write: true, api: half.api });
    expect(resumed.kind, "why" in resumed ? resumed.why : "").toBe("DONE");
    expect(half.writes.filter(w => w.startsWith("create-project"))).toHaveLength(1);
    expect(half.projects.size).toBe(1);
  });

  test("SC-2789: a dry run lists what it would do and writes nothing", async () => {
    const { api, writes } = memoryBoard();
    const r = await boardInit({ repo: REPO, owner: "acme", boardId: null, write: false, api });
    expect(r.kind).toBe("PLANNED");
    if (r.kind === "PLANNED") expect(r.steps.join("\n")).toContain(`create a project "${boardTitle(REPO)}" owned by acme`);
    expect(writes).toEqual([]);
  });
});

describe("SC-2789: what cannot be created or read is UNMEASURED, and no config follows", () => {
  test("SC-2789: board.id naming no project this token can read is refused, and nothing is created", async () => {
    const { api, writes } = memoryBoard();
    const r = await boardInit({ repo: REPO, owner: "acme", boardId: "PVT_gone", write: true, api });
    expect(r.kind).toBe("UNMEASURED");
    expect("why" in r && r.why).toContain("PVT_gone");
    expect(writes).toEqual([]);
  });

  test("SC-2789: a write GitHub refuses stops the run, naming the step", async () => {
    const { api } = memoryBoard([], { failOn: "delete-workflow" });
    const r = await boardInit({ repo: REPO, owner: "acme", boardId: null, write: true, api });
    expect(r.kind).toBe("UNMEASURED");
    expect("why" in r && r.why).toContain("Item closed");
  });

  test("SC-2789: a write that is accepted and does not stick is caught by the re-read", async () => {
    const { api } = memoryBoard([], { ignoreOptions: true });
    const r = await boardInit({ repo: REPO, owner: "acme", boardId: null, write: true, api });
    expect(r.kind).toBe("UNMEASURED");
    expect("why" in r && r.why).toContain("Backlog");
  });

  test("SC-2789: a Criteria field that exists and is not text is refused, not replaced", async () => {
    const odd = freshProject("ODD", "x");
    odd.linkedRepositories = [REPO];
    odd.fields.push({ id: "ODD-criteria", name: "Criteria", dataType: "NUMBER" });
    const { api, writes } = memoryBoard([odd]);
    const r = await boardInit({ repo: REPO, owner: "acme", boardId: "ODD", write: true, api });
    expect(r.kind).toBe("UNMEASURED");
    expect("why" in r && r.why).toContain("NUMBER");
    expect(writes).toEqual([]);
  });

  test("SC-2789: the automations turned off are exactly the two that write lanes board-flow owns", () => {
    expect([...AUTOMATIONS_OFF]).toEqual(["Item closed", "Pull request linked to issue"]);
  });
});

describe("SC-2789: board.id and board.fields are written into the config, and nothing else moves", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });
  const project = (config: unknown) => {
    const d = mkdtempSync(join(tmpdir(), "board-init-config-"));
    made.push(d);
    mkdirSync(join(d, ".claude", "rungate"), { recursive: true });
    writeFileSync(join(d, ".claude", "rungate", "config.json"), JSON.stringify(config, null, 2) + "\n");
    return d;
  };
  const read = (d: string) => JSON.parse(readFileSync(join(d, ".claude", "rungate", "config.json"), "utf8"));

  test("SC-2789: the ids land under board, beside every key already there", () => {
    const d = project({ project: "w", board: { expediteLabel: "now", fields: { Priority: "F_p" } } });
    const r = writeBoardConfig(d, { id: "PVT_1", fields: { Status: "F_s", Criteria: "F_c" } });
    expect(r.changed).toBe(true);
    expect(read(d)).toEqual({ project: "w", board: { expediteLabel: "now", id: "PVT_1", fields: { Priority: "F_p", Status: "F_s", Criteria: "F_c" } } });
  });

  test("SC-2789: writing the same ids again leaves the file byte-identical", () => {
    const d = project({ project: "w", board: { id: "PVT_1", fields: { Status: "F_s", Criteria: "F_c" } } });
    const before = readFileSync(join(d, ".claude", "rungate", "config.json"), "utf8");
    const r = writeBoardConfig(d, { id: "PVT_1", fields: { Status: "F_s", Criteria: "F_c" } });
    expect(r.changed).toBe(false);
    expect(readFileSync(join(d, ".claude", "rungate", "config.json"), "utf8")).toBe(before);
  });

  test("SC-2789: no config at all is refused; board-init writes into a scaffolded project only", () => {
    const d = mkdtempSync(join(tmpdir(), "board-init-noconfig-"));
    made.push(d);
    expect(() => writeBoardConfig(d, { id: "PVT_1", fields: { Status: "F_s", Criteria: "F_c" } })).toThrow("scaffold");
  });

  test("SC-2789: the command writes the ids only after a whole board, and a second run leaves the file alone", async () => {
    const d = project({ project: "w", board: { expediteLabel: "now" } });
    const { api, writes } = memoryBoard();
    const out: string[] = [];
    const real = { log: console.log, error: console.error };
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    console.error = (...a: unknown[]) => void out.push(a.join(" "));
    try {
      // A dry run changes neither the board nor the file.
      expect(await boardInitMain(["--repo", REPO, "--project-root", d], d, api)).toBe(0);
      expect(writes).toEqual([]);
      expect(read(d).board).toEqual({ expediteLabel: "now" });

      expect(await boardInitMain(["--repo", REPO, "--project-root", d, "--write"], d, api)).toBe(0);
      const written = read(d).board;
      expect(written.expediteLabel).toBe("now");
      expect(typeof written.id).toBe("string");
      expect(Object.keys(written.fields).sort()).toEqual(["Criteria", "Status"]);

      const file = readFileSync(join(d, ".claude", "rungate", "config.json"), "utf8");
      const before = writes.length;
      expect(await boardInitMain(["--repo", REPO, "--project-root", d, "--write"], d, api)).toBe(0);
      expect(writes.length).toBe(before);
      expect(readFileSync(join(d, ".claude", "rungate", "config.json"), "utf8")).toBe(file);
      expect(out.join("\n")).toContain("already names this board");
    } finally {
      console.log = real.log;
      console.error = real.error;
    }
  });

  test("SC-2789: a refused board leaves the config untouched, and an unscaffolded project is refused first", async () => {
    const d = project({ project: "w" });
    const { api } = memoryBoard([], { failOn: "create-view" });
    const errs: string[] = [];
    const real = { log: console.log, error: console.error };
    console.log = () => {};
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    try {
      expect(await boardInitMain(["--repo", REPO, "--project-root", d, "--write"], d, api)).toBe(REFUSAL_EXIT);
      expect(read(d)).toEqual({ project: "w" });
      const bare = mkdtempSync(join(tmpdir(), "board-init-bare-"));
      made.push(bare);
      expect(await boardInitMain(["--repo", REPO, "--project-root", bare, "--write"], bare, api)).toBe(REFUSAL_EXIT);
      expect(errs.join("\n")).toContain("rungate scaffold first");
    } finally {
      console.log = real.log;
      console.error = real.error;
    }
  });

  test("SC-2789: it is a rungate command, and the script it runs ships", () => {
    expect(CLI_COMMANDS["board-init"]?.script).toBe("scripts/board-init.ts");
    const files = (JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { files: string[] }).files;
    expect(files).toContain("scripts/board-init.ts");
  });
});
