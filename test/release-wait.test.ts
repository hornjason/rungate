/**
 * scripts/release-wait.ts — step 6 of docs/guides/RELEASING.md as a tested
 * command (#2201).
 *
 * Two halves. `releaseReading` is pure and is driven through every reading.
 * The script is spawned for real against a fake `gh` and `npm` on PATH, which
 * answer ONLY when asked about the exact tag, workflow and `package@version`
 * the case planted — so a script that asked about the wrong release would
 * read NO_RUN or NOT_SERVED, not agree with itself.
 *
 * Every negative case runs twice — the real script and a mutant whose
 * `REFUSE_EXIT` is 0. The second assertion is the point: the refusal is what
 * the case observed, not some other non-zero exit.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { REFUSE_EXIT, releaseReading } from "../scripts/release-wait";

const SCRIPT = join(import.meta.dir, "..", "scripts", "release-wait.ts");
const SOURCE = readFileSync(SCRIPT, "utf-8");

describe("releaseReading: only a recorded failure spends the version", () => {
  test("no run is NO_RUN, and says nothing is spent", () => {
    const r = releaseReading({});
    expect(r.reading).toBe("NO_RUN");
    expect(r.detail).toContain("Nothing is spent");
  });

  for (const c of ["failure", "cancelled", "timed_out", "startup_failure", "skipped"]) {
    test(`a run that concluded '${c}' is SPENT`, () => {
      const r = releaseReading({ runId: "42", conclusion: c });
      expect(r.reading).toBe("SPENT");
      expect(r.detail).toContain("cut the next version");
    });
  }

  // The expensive mistake is reading "could not tell" as "failed". Each of
  // these is a run whose outcome nobody read, and none of them may spend.
  for (const c of [null, undefined, "", "  ", "in_progress", "queued", "neutral", "action_required"]) {
    test(`a conclusion of ${JSON.stringify(c)} is NO_OUTCOME, never SPENT`, () => {
      const r = releaseReading({ runId: "42", conclusion: c });
      expect(r.reading).toBe("NO_OUTCOME");
      expect(r.detail).toContain("Nothing is known to be spent");
    });
  }

  test("a success the registry does not serve is NOT_SERVED", () => {
    expect(releaseReading({ runId: "42", conclusion: "success", served: false }).reading).toBe("NOT_SERVED");
    expect(releaseReading({ runId: "42", conclusion: "success" }).reading).toBe("NOT_SERVED");
  });

  test("a success the registry serves is PUBLISHED", () => {
    expect(releaseReading({ runId: "42", conclusion: "success", served: true }).reading).toBe("PUBLISHED");
  });

  // The control: served is only consulted after a success, so a registry
  // answer cannot rescue a failed run.
  test("a failed run is SPENT even if the registry somehow serves the version", () => {
    expect(releaseReading({ runId: "42", conclusion: "failure", served: true }).reading).toBe("SPENT");
  });
});

// ── the script, spawned for real ────────────────────────────

let dir = "";
let bin = "";
let work = "";
let mutant = "";

const VERSION = "1.2.3";
const FAST = ["--run-attempts", "2", "--run-interval-ms", "0", "--registry-attempts", "2", "--registry-interval-ms", "0"];

interface Plant {
  /** The tag the fake `gh run list` answers for; any other --branch gets nothing. */
  tag?: string;
  runId?: string;
  conclusion?: string;
  viewFails?: boolean;
  watchExit?: number;
  /** The `package@version` the fake `npm view` answers for. */
  npmSpec?: string;
  npmServes?: string;
}

function runScript(path: string, plant: Plant, args: string[]) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_TAG: plant.tag ?? `v${VERSION}`,
    FAKE_RUN_ID: plant.runId ?? "",
    FAKE_CONCLUSION: plant.conclusion ?? "",
    FAKE_VIEW_FAIL: plant.viewFails ? "1" : "",
    FAKE_WATCH_EXIT: String(plant.watchExit ?? 0),
    FAKE_NPM_SPEC: plant.npmSpec ?? `fakepkg@${VERSION}`,
    FAKE_NPM_SERVES: plant.npmServes ?? "",
    FAKE_LOG: join(dir, "calls.log"),
  };
  const r = Bun.spawnSync(["bun", path, ...args], { cwd: work, env, stdout: "pipe", stderr: "pipe" });
  return {
    code: r.exitCode,
    out: new TextDecoder().decode(r.stdout).trim(),
    err: new TextDecoder().decode(r.stderr).trim(),
  };
}

/** Both halves of a negative case: the real script refuses, the mutant does not. */
function bothHalves(plant: Plant, args: string[]) {
  const real = runScript(SCRIPT, plant, args);
  const mut = runScript(mutant, plant, args);
  expect(real.code, `the real script did not refuse:\n${real.err}`).toBe(REFUSE_EXIT);
  expect(mut.code, "the mutant refused too — the case did not observe the exit constant").toBe(0);
  return real;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rg-release-wait-"));
  bin = join(dir, "bin");
  work = join(dir, "work");
  mkdirSync(bin, { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "fakepkg", version: VERSION }));

  // A `gh` that answers `run list` only for the planted tag AND release.yml,
  // and logs every call so a case can assert what was asked.
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
echo "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "run list")
    branch=""; wf=""; prev=""
    for a in "$@"; do
      [ "$prev" = "--branch" ] && branch="$a"
      [ "$prev" = "--workflow" ] && wf="$a"
      prev="$a"
    done
    [ "$branch" = "$FAKE_TAG" ] && [ "$wf" = "release.yml" ] && printf '%s' "$FAKE_RUN_ID"
    exit 0 ;;
  "run watch") exit "$FAKE_WATCH_EXIT" ;;
  "run view") [ -n "$FAKE_VIEW_FAIL" ] && exit 1; printf '%s' "$FAKE_CONCLUSION"; exit 0 ;;
esac
exit 2
`,
  );
  // An `npm` that serves the planted version only for the planted spec.
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh
echo "npm $*" >> "$FAKE_LOG"
[ "$1" = "view" ] && [ "$2" = "$FAKE_NPM_SPEC" ] && [ -n "$FAKE_NPM_SERVES" ] && { printf '%s' "$FAKE_NPM_SERVES"; exit 0; }
exit 1
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "npm"), 0o755);

  // The mutant, guarded: one that fails to build or load reports zero
  // failures and reads exactly like a case that passed.
  const decl = "export const REFUSE_EXIT = 1;";
  const hits = SOURCE.split(decl).length - 1;
  if (hits !== 1) throw new Error(`could not build the mutant: the exit constant appears ${hits} times, not once`);
  if ([...SOURCE.matchAll(/process\.exit\(\s*[1-9]/g)].length > 0) {
    throw new Error("could not build the mutant: a refusal exits with a literal code");
  }
  if ([...SOURCE.matchAll(/from\s+["']\.{1,2}\//g)].length > 0) {
    throw new Error("could not build the mutant: a relative import would die on module resolution from a temp directory");
  }
  mutant = join(dir, "mutant", "release-wait.ts");
  mkdirSync(dirname(mutant), { recursive: true });
  writeFileSync(mutant, SOURCE.replace(decl, "export const REFUSE_EXIT = 0;"));
});

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("the script: each reading end to end", () => {
  test("PUBLISHED: the run succeeded and the registry serves the version", () => {
    const r = runScript(SCRIPT, { runId: "42", conclusion: "success", npmServes: VERSION }, ["--version", VERSION, ...FAST]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe(`PUBLISHED: fakepkg@${VERSION} (run 42)`);
  });

  // The watch's exit code is not the outcome. A dropped connection makes it
  // fail on a run that succeeded, and that must not read as anything but the
  // recorded conclusion.
  test("a failed WATCH on a successful run is still PUBLISHED", () => {
    const r = runScript(SCRIPT, { runId: "42", conclusion: "success", watchExit: 1, npmServes: VERSION }, ["--version", VERSION, ...FAST]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("PUBLISHED");
  });

  test("SPENT: the run's recorded conclusion is a failure", () => {
    const r = bothHalves({ runId: "42", conclusion: "failure" }, ["--version", VERSION, ...FAST]);
    expect(r.err).toStartWith(`SPENT: v${VERSION}:`);
  });

  test("NO_RUN: nothing registered for the tag", () => {
    const r = bothHalves({ runId: "" }, ["--version", VERSION, ...FAST]);
    expect(r.err).toStartWith(`NO_RUN: v${VERSION}:`);
    expect(r.err).toContain("Nothing is spent");
  });

  // The wiring of the tag: the fake has a run, but only for another tag. A
  // script that ignored --version, or spelled the tag differently, would find
  // the run and go on to read its conclusion.
  test("NO_RUN: a run exists only for another tag, so it is not this release's", () => {
    const r = bothHalves({ tag: "v9.9.9", runId: "42", conclusion: "failure" }, ["--version", VERSION, ...FAST]);
    expect(r.err).toStartWith("NO_RUN:");
    const calls = readFileSync(join(dir, "calls.log"), "utf-8");
    expect(calls).toContain(`--branch v${VERSION}`);
    expect(calls).toContain("--workflow release.yml");
  });

  test("NO_OUTCOME: the run exists and its conclusion cannot be read", () => {
    const r = bothHalves({ runId: "42", viewFails: true }, ["--version", VERSION, ...FAST]);
    expect(r.err).toStartWith(`NO_OUTCOME: v${VERSION}:`);
    expect(r.err).not.toContain("SPENT");
  });

  test("NO_OUTCOME: the run has not concluded", () => {
    const r = bothHalves({ runId: "42", conclusion: "" }, ["--version", VERSION, ...FAST]);
    expect(r.err).toStartWith("NO_OUTCOME:");
  });

  test("NOT_SERVED: the run succeeded and the registry does not serve the version", () => {
    const r = bothHalves({ runId: "42", conclusion: "success", npmServes: "" }, ["--version", VERSION, ...FAST]);
    expect(r.err).toStartWith(`NOT_SERVED: v${VERSION}:`);
  });

  // The wiring of the package name: the registry serves the version, but for
  // another package. A script that looked up the wrong name would read it as
  // published.
  test("NOT_SERVED: the registry serves this version only under another package name", () => {
    const r = bothHalves(
      { runId: "42", conclusion: "success", npmSpec: `otherpkg@${VERSION}`, npmServes: VERSION },
      ["--version", VERSION, ...FAST],
    );
    expect(r.err).toStartWith("NOT_SERVED:");
  });

  test("refuses a missing or malformed --version before asking anything", () => {
    for (const args of [[], ["--version"], ["--version", "1.2"], ["--version", "v1.2.3"]]) {
      const r = bothHalves({}, [...args, ...FAST]);
      expect(r.err).toContain("usage:");
    }
  });

  test("refuses a malformed attempts or interval flag", () => {
    const r = bothHalves({}, ["--version", VERSION, "--run-attempts", "-1"]);
    expect(r.err).toContain("take a whole number");
  });
});
