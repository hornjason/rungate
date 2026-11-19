/**
 * #2507: `rungate board-flow` runs `scripts/board-flow.ts`, ships in
 * `files[]`, and finds the board the way `rungate board-ready` does:
 * `--project`, then `board.id` in the config of the directory it runs in.
 *
 * It ships before the generated `board-flow.yml` that calls it (#2481), so a
 * consumer's pinned release has the command the moment the workflow does.
 * Titled by issue number: #2481 completes the criterion.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { CLI_COMMANDS } from "../lib/cli-commands";
import { WEBHOOK_LANE_EVENTS } from "../lib/board-flow";
import { NO_BOARD_REFUSAL } from "../lib/scaffold/board-ready-workflow";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "board-flow.ts");

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
function dir(board?: Record<string, unknown>): string {
  const d = mkdtempSync(join(tmpdir(), "board-flow-cmd-"));
  made.push(d);
  if (board) {
    mkdirSync(join(d, ".claude", "rungate"), { recursive: true });
    writeFileSync(join(d, ".claude", "rungate", "config.json"), JSON.stringify({ project: "fixture", board }));
  }
  return d;
}
function run(entry: string[], cwd: string, args: string[]) {
  const env: Record<string, string | undefined> = { ...process.env };
  // No credential: a run that gets past the board stops before any read.
  for (const k of ["GITHUB_TOKEN", "GH_TOKEN", "BOARD_PROJECT_TOKEN", "RUNGATE_PROJECT_TOKEN"]) delete env[k];
  const r = spawnSync("bun", [...entry, ...args], { cwd, env, encoding: "utf-8", timeout: 30_000 });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const EVENT = WEBHOOK_LANE_EVENTS[0];

describe("#2507: board-flow finds its board from --project, then board.id", () => {
  test("with neither, it refuses with board-ready's own phrase, naming both, before anything is read", () => {
    const r = run([SCRIPT], dir(), ["--repo", "acme/widgets", "--event", EVENT]);
    expect(r.code, r.out).toBe(2);
    expect(r.out).toContain(`${NO_BOARD_REFUSAL} — pass --project <id>, or set board.id in the rungate config`);
  });

  test("board.id in the config of the directory it runs in is the board", () => {
    const r = run([SCRIPT], dir({ id: "PVT_fixture" }), ["--repo", "acme/widgets", "--event", EVENT]);
    expect(r.out, "board.id was not read").not.toContain(NO_BOARD_REFUSAL);
    // Reached only once a board is resolved: the next stage, the credential.
    expect(r.out).toContain("BOARD_PROJECT_TOKEN is not set");
  });

  test("--project still wins, with no config at all", () => {
    const r = run([SCRIPT], dir(), ["--repo", "acme/widgets", "--project", "PVT_flag", "--event", EVENT]);
    expect(r.out).not.toContain(NO_BOARD_REFUSAL);
    expect(r.out).toContain("BOARD_PROJECT_TOKEN is not set");
  });

  test("--repo and --event are still required", () => {
    const r = run([SCRIPT], dir({ id: "PVT_fixture" }), ["--event", EVENT]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("--repo");
  });
});

describe("#2507: it is a rungate command, and the script it runs ships", () => {
  test("registered and in files[]", () => {
    expect(CLI_COMMANDS["board-flow"]?.script).toBe("scripts/board-flow.ts");
    const files = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as { files: string[] }).files;
    expect(files).toContain("scripts/board-flow.ts");
  });

  test("rungate board-flow dispatches the script in the directory it was started in", () => {
    const r = run([join(ROOT, "bin", "rungate.ts"), "board-flow"], dir(), ["--repo", "acme/widgets", "--event", EVENT]);
    // This package's own tree HAS a board configured, so a dispatch that read
    // the package instead of the directory would not refuse on the board.
    expect(r.out).toContain(NO_BOARD_REFUSAL);
  });
});
