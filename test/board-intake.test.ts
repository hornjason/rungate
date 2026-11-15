/**
 * BI-1..BI-12 — `.github/workflows/board-intake.yml`. Since #2183 the move
 * step is one call to `rungate board-intake-move`, and its logic is tested in
 * test/board-intake-move.test.ts.
 *
 * The workflow that puts every issue and pull request on the board, and moves
 * a pull request to In review when it opens. Covers the gap #1750 left open:
 * the board had an intake and no transitions, so four of five open pull
 * requests sat in Backlog while #1607 showed Done with the pull request still
 * open and blocked.
 *
 * Read as TEXT rather than parsed, which is this repository's idiom for
 * workflow files and is deliberate: the thing being asserted is what a reader
 * and a reviewer see, and a YAML round-trip would normalise away exactly the
 * spellings that make `pull_request_target` unsafe.
 *
 * COMMENTS ARE STRIPPED BEFORE ANY SAFETY ROW RUNS, and the first draft did
 * not do that. BI-3 asserts no checkout, and it failed against a workflow with
 * no checkout in it, because the header *discusses* `actions/checkout@v4` in
 * a sentence about another file. A detector that cannot tell a step from
 * prose reports the file's documentation as its behaviour
 * (`.claude/rules/checks-must-be-able-to-fail.md`, the second shape). `code`
 * below is the view every safety row reads, and BI-5 asserts that view is
 * non-empty so stripping can never turn a check into a vacuous pass.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOARD_ID_COMMAND,
  NO_BOARD_REFUSAL,
  buildBoardIntakeAddScript,
  buildBoardIntakeMoveScript,
  buildBoardIntakeWorkflow,
} from "../lib/scaffold/board-intake-workflow";
import { OWNED_FILES } from "../lib/scaffold/owned-files";

const WORKFLOW = join(import.meta.dir, "..", ".github", "workflows", "board-intake.yml");
/** The version the generator pins, read from package.json as the generator reads it. */
const VERSION = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version as string;
const source = readFileSync(WORKFLOW, "utf8");
const lines = source.split("\n");

/** The file with whole-line comments removed — the only view the safety rows read. */
const code = lines.filter(l => !/^\s*#/.test(l));

/** Every `run:` block's body, as text. Block scalars only; the file uses no inline `run:`. */
function runBlocks(): string[] {
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)run:\s*[|>]/.exec(lines[i]!);
    if (open === null) continue;
    const outer = open[1]!.length;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.trim() !== "" && line.length - line.trimStart().length <= outer) break;
      body.push(line);
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

const usesLines = code.filter(l => /^\s*-?\s*uses:/.test(l)).map(l => l.trim());
const ifLines = code.filter(l => /^\s*if:/.test(l)).map(l => l.trim());

describe("board-intake workflow", () => {
  test("BI-5: the extractors found the file's real shape", () => {
    // Read before any row below. These are the evidence that the scanners are
    // looking at something. If a reformat breaks them this fails, instead of
    // letting the rest pass over empty collections.
    expect(code.length).toBeGreaterThan(10);
    expect(usesLines.length).toBeGreaterThanOrEqual(1);
    expect(runBlocks().length).toBeGreaterThanOrEqual(1);
    // The stripper must remove commentary without eating the workflow.
    expect(code.length).toBeLessThan(lines.length);
  });

  test("BI-1: a pull request is moved to In review, keyed to the item the add step created", () => {
    // `actions/add-to-project` has no field input, so the transition is a
    // second step. It must address the item the first step just created
    // rather than re-querying the board: a re-query races GitHub's built-in
    // "Item added to project" workflow, which is what puts the item in
    // Backlog in the first place.
    const body = code.join("\n");
    expect(body.includes("board-intake-move")).toBe(true);
    expect(body.includes('--item "${ITEM_ID}"')).toBe(true);
    expect(body.includes("steps.add.outputs.itemId")).toBe(true);
    expect(/id:\s*add\b/.test(body)).toBe(true);
  });

  test("BI-2: a draft pull request is not moved", () => {
    // Jason's call, 2026-11-04: drafts stay in Backlog until marked ready.
    // `opened` fires for a draft too, so without this the column would read
    // In review for work nobody has offered for review.
    const guard = ifLines.find(l => l.includes("draft"));
    expect(guard, `no 'if:' mentions draft; if: lines were ${JSON.stringify(ifLines)}`).toBeDefined();
    expect(guard!.includes("false")).toBe(true);
  });

  test("BI-3: no step checks out the pull request", () => {
    // `pull_request_target` runs with secrets in the BASE repository's
    // context. Checking out the head would execute a contributor's code with
    // a token that can write the board.
    //
    // Since #2166 the job checks out ONE tree, the default branch, because the
    // board id is read from its config. So the property is now: exactly one
    // checkout, its ref the default branch, no credential kept, and nothing in
    // the file names the pull request's head.
    const checkouts = usesLines.filter(l => l.includes("actions/checkout"));
    expect(checkouts.length, "expected exactly one checkout").toBe(1);
    const body = code.join("\n");
    expect(body).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(body).toContain("persist-credentials: false");
    expect(body, "nothing may name the pull request's head").not.toMatch(/pull_request\.head\./);
  });

  test("BI-6..BI-11 moved to code: the move step is one call to the tested command, and no shell logic is left", () => {
    // #2183: the read-back, the retrying helper, stdout-only results, the
    // search-index reading, truncation and null-node refusals all live in
    // lib/board-intake-move.ts now, each observed failing against a stub
    // client in test/board-intake-move.test.ts. What this file owns is that
    // the workflow delegates to that code and does not grow its own again.
    const move = runBlocks().find(b => b.includes("board-intake-move"));
    expect(move, "no run block calls board-intake-move").toBeDefined();
    const steps = move!.split("\n").map(l => l.trim()).filter(l => l !== "" && !l.startsWith("#"));
    expect(steps).toEqual([
      "set -euo pipefail",
      `bunx rungate@${VERSION} board-intake-move --project "\${PROJECT_ID}" --item "\${ITEM_ID}" --column "\${COLUMN}"`,
    ]);
    const all = runBlocks().join("\n");
    expect(all, "a GraphQL call came back into a run block").not.toMatch(/gh api graphql[^\n]*updateProjectV2ItemFieldValue|updateProjectV2ItemFieldValue/);
    expect(move!, "the move step calls the API itself again").not.toContain("gh api");
  });

  test("BI-4: no run block interpolates a value", () => {
    // The other half of the same property, and the easy one to reintroduce.
    // A `${{ ... }}` inside `run:` is substituted into the shell BEFORE it
    // executes, so a pull request title containing shell syntax is code.
    // Every value reaches this workflow through `env:`, where it is data.
    // Comments are NOT stripped here, deliberately: Actions interpolates a
    // `${{ }}` inside a shell comment too.
    const offenders = runBlocks().filter(b => b.includes("${{"));
    expect(offenders).toEqual([]);
  });

  test("BI-12: the workflow makes no scratch file of its own to leak", () => {
    // The move step's `err=$(mktemp)` went with the shell (#2183). The add
    // step writes only under \${RUNNER_TEMP}, which the runner empties per job.
    // Exactly zero `mktemp`, so a new one is red here until its cleanup is
    // written, the same way the old row counted exactly one.
    expect(code.join("\n")).not.toMatch(/mktemp/);
    const writes = [...code.join("\n").matchAll(/2>"([^"]+)"/g)].map(m => m[1]!);
    expect(writes.length, "the add step's stderr captures were not found, so this read nothing").toBeGreaterThan(0);
    expect(writes.filter(w => !w.startsWith("\${RUNNER_TEMP}/"))).toEqual([]);
  });
});

/**
 * #2166, ADR-014 row 4: the scaffold writes board-intake.yml, and this
 * repository's copy is the generated one. The board is read from the default
 * branch's config by the published CLI (#2173), so the file carries no
 * project id and no project URL. With #2047 this completes the area's
 * generation; the criterion is ticked by its own follow-up.
 */
describe("#2166: board-intake.yml is generated and names no board", () => {
  const version = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version as string;

  test("the committed file is the generator's, and says so", () => {
    expect(source, "board-intake.yml is not the generated copy").toMatch(/^(?:# generated-sha: [0-9a-f]+\n)?# Managed by rungate/);
    const indented = buildBoardIntakeAddScript(version).trimEnd().split("\n").map(l => (l === "" ? "" : `          ${l}`)).join("\n");
    expect(source, "the add step's run: body is not the generator's").toContain(indented);
    // And the move step, the larger half (review round 3): byte for byte, indented.
    const move = buildBoardIntakeMoveScript(version).trimEnd().split("\n").map(l => (l === "" ? "" : `          ${l}`)).join("\n");
    expect(source, "the move step's run: body is not the generator's").toContain(move);
  });

  test("it learns the board from the published CLI, and adds by node id", () => {
    const body = code.join("\n");
    expect(body).toContain(`bunx rungate@${version} ${BOARD_ID_COMMAND}`);
    expect(body).toContain("addProjectV2ItemById");
    expect(body, "add-to-project takes only a URL").not.toContain("actions/add-to-project");
  });

  test("no project id, no project URL, anywhere in it", () => {
    // The whole file, comments included: an id in a comment is still an id.
    expect(source).not.toMatch(/PVT_[A-Za-z0-9_-]+/);
    expect(source).not.toMatch(/github\.com\/(?:users|orgs)\/[^/\s]+\/projects\//);
    expect(source).not.toContain("RUNGATE_PROJECT_ID");
    const src = readFileSync(join(import.meta.dir, "..", "lib/scaffold/board-intake-workflow.ts"), "utf8");
    const iface = /export interface BoardIntakeWorkflowOptions \{([\s\S]*?)\n\}/.exec(src)?.[1];
    expect(iface, "BoardIntakeWorkflowOptions not found — this row would pass vacuously").toBeDefined();
    const fields = [...iface!.matchAll(/^\s*(\w+)\??:/gm)].map(m => m[1]!);
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.filter(f => /project|board|url/i.test(f)), "a board input on the generator can be emitted").toEqual([]);
  });

  test("the move step waits for an item, so an unconfigured add skips it", () => {
    const guard = ifLines.find(l => l.includes("draft"));
    expect(guard).toContain("steps.add.outputs.itemId != ''");
  });
});

/**
 * #2166: the add step, EXECUTED against stub `bunx` and `gh`. An unconfigured
 * tree is an annotation; every other failure stands.
 */
describe("#2166: the add step's readings", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "board-intake-add-")));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const stubs = join(dir, "bin");
  mkdirSync(stubs);
  writeFileSync(join(stubs, "bunx"), '#!/bin/sh\n[ -n "$ID_ERR" ] && printf "%s\\n" "$ID_ERR" >&2\n[ -n "$ID_OUT" ] && printf "%s\\n" "$ID_OUT"\nexit "$ID_CODE"\n', { mode: 0o755 });
  writeFileSync(join(stubs, "gh"), '#!/bin/sh\nprintf "%s" "$GH_OUT"\nexit "${GH_CODE:-0}"\n', { mode: 0o755 });
  writeFileSync(join(stubs, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const script = join(dir, "add.sh");
  writeFileSync(script, buildBoardIntakeAddScript("9.9.9"));

  function add(env: Record<string, string>) {
    const output = join(dir, `out-${Math.random().toString(36).slice(2)}`);
    writeFileSync(output, "");
    const r = Bun.spawnSync(["bash", script], {
      env: { PATH: `${stubs}:${process.env.PATH}`, RUNNER_TEMP: dir, GITHUB_OUTPUT: output, CONTENT_ID: "I_x", ID_CODE: "0", ...env },
    });
    return { code: r.exitCode, out: r.stdout.toString(), written: readFileSync(output, "utf8") };
  }

  test("no token: a warning, exit 0, and no item id", () => {
    const r = add({ GH_TOKEN: "" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("UNMEASURED — RUNGATE_PROJECT_TOKEN is not set");
    expect(r.written).toBe("");
  });

  test("no board.id (board-id exits 2): a warning, exit 0, and no item id", () => {
    const r = add({ GH_TOKEN: "t", ID_CODE: "2", ID_ERR: "UNMEASURED: no board — set board.id" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("UNMEASURED — no board.id in the rungate config");
    expect(r.written).toBe("");
  });

  test("any other board-id failure stands, including an exit-2 usage error", () => {
    expect(add({ GH_TOKEN: "t", ID_CODE: "1", ID_ERR: "SyntaxError: bad config" }).code).toBe(1);
    // Review round 1: exit 2 also means a usage error, so the code alone
    // would soften a real defect into "nothing to do".
    const usage = add({ GH_TOKEN: "t", ID_CODE: "2", ID_ERR: "UNMEASURED: unknown argument \"--x\". Usage: rungate board-id" });
    expect(usage.code).toBe(2);
    expect(usage.out).not.toContain("no board.id in the rungate config");
  });

  test("the softened refusal is board-id's own wording", () => {
    expect(readFileSync(join(import.meta.dir, "..", "scripts/board-id.ts"), "utf8")).toContain(`${NO_BOARD_REFUSAL} —`);
  });

  test("an add that never returns an item is a red run, not a silent one", () => {
    const r = add({ GH_TOKEN: "t", ID_OUT: "PVT_fixture", GH_CODE: "1" });
    expect(r.code).toBe(1);
    expect(r.written).toBe("");
  });

  test("success writes the item and the project for the move step", () => {
    const r = add({ GH_TOKEN: "t", ID_OUT: "PVT_fixture", GH_OUT: "PVTI_item" });
    expect(r.code).toBe(0);
    expect(r.written).toBe("itemId=PVTI_item\nprojectId=PVT_fixture\n");
  });
});

/**
 * SC-2745: `rungate scaffold` emits board-ready.yml and board-intake.yml as
 * owned workflows that read the board from project config, and no generated
 * workflow carries a literal project id or URL. Read over EVERY workflow the
 * scaffold manages, comments included, so a third generated file that pasted
 * an id would fail here too.
 */
describe("SC-2745: the board workflows are owned, and no generated workflow names a board", () => {
  const dir = join(import.meta.dir, "..", ".github", "workflows");
  const managed = readdirSync(dir)
    .filter(f => f.endsWith(".yml"))
    .map(f => ({ f, text: readFileSync(join(dir, f), "utf8") }))
    .filter(w => /^(?:# generated-sha: [0-9a-f]+\n)?# Managed by rungate/.test(w.text));

  test("SC-2745: both board workflows are owned by the scaffold, and generated", () => {
    const owned = OWNED_FILES.map(o => o.path);
    for (const f of ["board-ready.yml", "board-intake.yml"]) {
      expect(owned, `${f} is not in OWNED_FILES`).toContain(`.github/workflows/${f}`);
      expect(managed.map(w => w.f), `${f} is not the generated copy`).toContain(f);
    }
  });

  test("SC-2745: no generated workflow contains a project id or a project URL", () => {
    expect(managed.length, "found no managed workflow — this row would pass vacuously").toBeGreaterThanOrEqual(7);
    const named = managed.filter(w => /PVT_[A-Za-z0-9_-]+|github\.com\/(?:users|orgs)\/[^/\s]+\/projects\//.test(w.text)).map(w => w.f);
    expect(named, "a generated workflow names a board; read it from board.id instead").toEqual([]);
  });
});

/**
 * #2185: an add that exits 0 but returns no item is retried, and the refusal
 * counts the attempts it actually made. Found by review after #2180 merged:
 * the loop broke on gh's exit code alone, so a `null` id ended it at once and
 * the error still said "three attempts".
 */
describe("#2185: a null item is retried, and the attempts are counted", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "board-intake-null-")));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const stubs = join(dir, "bin");
  mkdirSync(stubs);
  writeFileSync(join(stubs, "bunx"), '#!/bin/sh\nprintf "PVT_fixture\\n"\nexit 0\n', { mode: 0o755 });
  // Answers the nth call with the nth comma-separated value of GH_SEQ, always exit 0.
  writeFileSync(
    join(stubs, "gh"),
    '#!/bin/sh\nn=$(cat "$COUNT" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$COUNT"\nprintf "%s" "$(printf "%s" "$GH_SEQ" | cut -d, -f"$n")"\nexit 0\n',
    { mode: 0o755 },
  );
  writeFileSync(join(stubs, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const script = join(dir, "add.sh");
  writeFileSync(script, buildBoardIntakeAddScript("9.9.9"));

  function add(seq: string) {
    const tag = Math.random().toString(36).slice(2);
    const output = join(dir, `out-${tag}`);
    const count = join(dir, `count-${tag}`);
    writeFileSync(output, "");
    const r = Bun.spawnSync(["bash", script], {
      env: { PATH: `${stubs}:${process.env.PATH}`, RUNNER_TEMP: dir, GITHUB_OUTPUT: output, CONTENT_ID: "I_x", GH_TOKEN: "t", COUNT: count, GH_SEQ: seq },
    });
    return { code: r.exitCode, err: r.stderr.toString(), written: readFileSync(output, "utf8"), calls: Number(readFileSync(count, "utf8").trim()) };
  }

  test("null every time: three calls, exit 1, and the error says three", () => {
    const r = add("null,null,null");
    expect(r.calls, "a null item ended the loop before it retried").toBe(3);
    expect(r.code).toBe(1);
    expect(r.err).toContain("after 3 attempt(s)");
    expect(r.written).toBe("");
  });

  test("null once, then an item: success on the second call", () => {
    const r = add("null,PVTI_item");
    expect(r.calls).toBe(2);
    expect(r.code).toBe(0);
    expect(r.written).toBe("itemId=PVTI_item\nprojectId=PVT_fixture\n");
  });
});
