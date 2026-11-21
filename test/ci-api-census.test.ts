/**
 * #2596: count every external API call a CI run makes, from what the run
 * itself recorded, never from an estimate.
 *
 * Two taps write the record and one counter reads it:
 *
 * - `scripts/api-call-tap.ts` is a Bun preload (`BUN_OPTIONS=--preload=…`).
 *   It wraps `fetch`, which is what Octokit and every hand-rolled GitHub
 *   reader here call, and appends one line per request.
 * - `scripts/ci-api-census.ts --install-gh-tap <dir>` writes a `gh` that runs
 *   the real one with `GH_DEBUG=1`, moves its `* Request to …` lines into the
 *   same record, and is otherwise gh: same stdout, same stderr, same exit.
 * - `scripts/ci-api-census.ts <record>…` counts them by API and endpoint.
 *
 * A record with no start line is UNMEASURED, never zero: a tap that never
 * started and a run that made no calls are different facts.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  CENSUS_UNMEASURED_EXIT,
  TAP_START,
  classifyCall,
  countCalls,
  ghTapScript,
  countRuns,
  readModelRun,
  readTap,
  renderCensus,
  renderModelRuns,
  tapBunOptions,
} from "../scripts/ci-api-census";

const ROOT = join(import.meta.dir, "..");
const CENSUS = join(ROOT, "scripts", "ci-api-census.ts");
const TAP = join(ROOT, "scripts", "api-call-tap.ts");
const scratch = mkdtempSync(join(tmpdir(), "rg-2596-census-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
function file(name: string, text: string): string {
  const p = join(scratch, `${n++}-${name}`);
  writeFileSync(p, text);
  return p;
}

describe("#2596: a record is read, or refused by name", () => {
  test("a record with no start line is UNMEASURED, not zero calls", () => {
    const reading = readTap("");
    expect(reading.status).toBe("unmeasured");
    if (reading.status === "unmeasured") expect(reading.reason).toContain("never started");
  });

  test("a started record with no calls is a measured zero", () => {
    const reading = readTap(`${TAP_START}\n`);
    expect(reading).toMatchObject({ status: "measured", calls: [], starts: 1, unparsed: 0 });
  });

  test("tap lines are found inside a CI job log, behind its timestamps", () => {
    const log = [
      `2026-11-21T19:07:24.4109810Z ${TAP_START}`,
      "2026-11-21T19:07:25.0000000Z (pass) something unrelated",
      "2026-11-21T19:07:26.0000000Z API-TAP fetch GET https://api.github.com/repos/o/r/issues/12?per_page=100",
      "2026-11-21T19:07:27.0000000Z API-TAP gh - https://api.github.com/graphql",
    ].join("\n");
    const reading = readTap(log);
    expect(reading.status).toBe("measured");
    if (reading.status === "measured") {
      expect(reading.calls.map(c => `${c.via} ${c.method} ${c.url}`)).toEqual([
        "fetch GET https://api.github.com/repos/o/r/issues/12?per_page=100",
        "gh - https://api.github.com/graphql",
      ]);
    }
  });

  test("a tap line that does not parse is counted and shown, not dropped", () => {
    const reading = readTap(`${TAP_START}\nAPI-TAP fetch\nAPI-TAP gh - https://api.github.com/graphql\n`);
    expect(reading).toMatchObject({ status: "measured", unparsed: 1 });
    expect(renderCensus(countCalls([reading]))).toContain("1 tap line did not parse");
  });
});

describe("#2596: each call is put under its API, and loopback is not external", () => {
  test("GitHub GraphQL, GitHub REST, loopback and any other host are told apart", () => {
    expect(classifyCall("https://api.github.com/graphql").api).toBe("GitHub GraphQL");
    expect(classifyCall("https://api.github.com/repos/o/r/pulls/7").api).toBe("GitHub REST");
    expect(classifyCall("http://127.0.0.1:4567/repos/o/r").api).toBe("loopback (not external)");
    expect(classifyCall("http://localhost:4567/x").api).toBe("loopback (not external)");
    // A test reading a fixture through fetch("file://…") leaves no machine.
    expect(classifyCall("file:///tmp/rungate-relreg-x/rungate").api).toBe("local file (not external)");
    expect(classifyCall("https://registry.npmjs.org/agnix").api).toBe("registry.npmjs.org");
  });

  test("numbers and commit SHAs in a path fold into one endpoint; the query string is dropped", () => {
    const a = classifyCall("https://api.github.com/repos/o/r/issues/12/comments?page=2");
    const b = classifyCall("https://api.github.com/repos/o/r/issues/9071/comments");
    expect(a.endpoint).toBe("/repos/o/r/issues/{n}/comments");
    expect(b.endpoint).toBe(a.endpoint);
    const sha = "0d233f593c33248bb33cfda664428017ef9914e1";
    expect(classifyCall(`https://api.github.com/repos/o/r/commits/${sha}/check-runs`).endpoint).toBe(
      "/repos/o/r/commits/{sha}/check-runs",
    );
  });

  test("the census counts per API and per endpoint, and its total is the sum of its rows", () => {
    const one = readTap(
      [
        TAP_START,
        "API-TAP fetch GET https://api.github.com/repos/o/r/issues/1",
        "API-TAP fetch GET https://api.github.com/repos/o/r/issues/2",
        "API-TAP gh - https://api.github.com/graphql",
        "API-TAP fetch GET http://127.0.0.1:9/x",
        "API-TAP fetch GET file:///tmp/fixture/rungate",
      ].join("\n"),
    );
    const two = readTap([TAP_START, "API-TAP gh - https://api.github.com/graphql"].join("\n"));
    const census = countCalls([one, two]);
    expect(census.records).toBe(2);
    expect(census.external).toBe(4);
    expect(census.notExternal).toBe(2);
    expect(census.unparsed).toBe(0);
    const byApi = Object.fromEntries(census.apis.map(a => [a.api, a.calls]));
    expect(byApi).toEqual({ "GitHub GraphQL": 2, "GitHub REST": 2 });
    expect(census.apis.reduce((s, a) => s + a.calls, 0)).toBe(census.external);
    const rest = census.apis.find(a => a.api === "GitHub REST")!;
    expect(rest.endpoints).toEqual([{ endpoint: "/repos/o/r/issues/{n}", calls: 2 }]);
  });
});

describe("#2596: the CLI", () => {
  test("an UNMEASURED record exits non-zero and names the file", () => {
    const bad = file("never-started.log", "API-TAP gh - https://api.github.com/graphql\n");
    const run = Bun.spawnSync([process.execPath, CENSUS, bad], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).toBe(CENSUS_UNMEASURED_EXIT);
    expect(CENSUS_UNMEASURED_EXIT).not.toBe(0);
    expect(run.stdout.toString() + run.stderr.toString()).toContain(bad);
  });

  test("an unreadable record is UNMEASURED, not an empty one", () => {
    const run = Bun.spawnSync([process.execPath, CENSUS, join(scratch, "absent.log")], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).toBe(CENSUS_UNMEASURED_EXIT);
    expect(run.exitCode).not.toBe(0);
    expect(run.stdout.toString() + run.stderr.toString()).toContain("UNMEASURED");
  });

  test("measured records print the count and exit zero", () => {
    const ok = file("ok.log", `${TAP_START}\nAPI-TAP gh - https://api.github.com/graphql\n`);
    const run = Bun.spawnSync([process.execPath, CENSUS, ok], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect(run.stdout.toString()).toContain("GitHub GraphQL: 1");
  });

  test("the exit constant is declared once, so no refusal can bypass it", () => {
    const source = readFileSync(CENSUS, "utf-8");
    expect(source.match(/CENSUS_UNMEASURED_EXIT = /g)?.length).toBe(1);
    expect(source.match(/process\.exit\(1\)/g)).toBeNull();
  });
});

describe("#2596: the fetch tap records what Octokit and hand-rolled readers send", () => {
  test("a request made under the preload is appended to the record", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    try {
      const record = file("fetch-tap.log", `${TAP_START}\n`);
      const script = file(
        "client.ts",
        `await fetch("http://127.0.0.1:${server.port}/repos/o/r/issues/5?x=1", { method: "PATCH" });\n`,
      );
      const run = Bun.spawn([process.execPath, script], {
        env: { ...process.env, BUN_OPTIONS: tapBunOptions(TAP), RUNGATE_API_TAP: record },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await run.exited, await new Response(run.stderr).text()).toBe(0);
      // The query string is not written: a record is printed into CI logs.
      expect(readFileSync(record, "utf-8")).toBe(
        `${TAP_START}\nAPI-TAP fetch PATCH http://127.0.0.1:${server.port}/repos/o/r/issues/5\n`,
      );
    } finally {
      server.stop(true);
    }
  });

  test("bun test runs under the preload, and a test's request is recorded", async () => {
    // The spelling matters: `--preload <path>` with a space makes `bun test`
    // answer `Script not found "test"`, and a CI suite run that way runs nothing.
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    try {
      const record = file("bun-test-tap.log", `${TAP_START}\n`);
      const dir = mkdtempSync(join(scratch, "suite-"));
      writeFileSync(
        join(dir, "probe.test.ts"),
        `import { expect, test } from "bun:test";\n` +
          `test("asks", async () => { expect((await fetch("http://127.0.0.1:${server.port}/graphql")).ok).toBe(true); });\n`,
      );
      const run = Bun.spawn([process.execPath, "test", "./probe.test.ts"], {
        cwd: dir,
        env: { ...process.env, BUN_OPTIONS: tapBunOptions(TAP), RUNGATE_API_TAP: record },
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await run.exited;
      const err = await new Response(run.stderr).text();
      expect(code, err).toBe(0);
      expect(err).toContain("1 pass");
      expect(readFileSync(record, "utf-8")).toBe(`${TAP_START}\nAPI-TAP fetch GET http://127.0.0.1:${server.port}/graphql\n`);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("a file: fetch is written scheme-first, not as the string null", async () => {
    const dir = mkdtempSync(join(scratch, "fixture-"));
    writeFileSync(join(dir, "body.txt"), "local");
    const record = file("file-tap.log", `${TAP_START}\n`);
    const script = file("client3.ts", `await (await fetch("file://${dir}/body.txt")).text();\n`);
    const run = Bun.spawn([process.execPath, script], {
      env: { ...process.env, BUN_OPTIONS: tapBunOptions(TAP), RUNGATE_API_TAP: record },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await run.exited, await new Response(run.stderr).text()).toBe(0);
    expect(readFileSync(record, "utf-8")).toBe(`${TAP_START}\nAPI-TAP fetch GET file://${dir}/body.txt\n`);
    const reading = readTap(readFileSync(record, "utf-8"));
    expect(countCalls([reading])).toMatchObject({ external: 0, notExternal: 1, unparsed: 0 });
  });

  test("with no record named, the tap writes nothing and changes nothing", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("body-7") });
    try {
      const script = file("client2.ts", `console.log(await (await fetch("http://127.0.0.1:${server.port}/")).text());\n`);
      const env = { ...process.env, BUN_OPTIONS: tapBunOptions(TAP) };
      delete (env as Record<string, string | undefined>).RUNGATE_API_TAP;
      const run = Bun.spawn([process.execPath, script], { env, stdout: "pipe", stderr: "pipe" });
      expect(await run.exited).toBe(0);
      expect((await new Response(run.stdout).text()).trim()).toBe("body-7");
    } finally {
      server.stop(true);
    }
  });
});

describe("#2596: the gh tap is gh, plus a record", () => {
  // A stand-in for the real gh: it prints what GH_DEBUG=1 prints, one line of
  // its own on stderr, a line on stdout, and exits 3.
  const fakeGh = file(
    "real-gh",
    [
      "#!/bin/sh",
      'if [ -n "$GH_DEBUG" ]; then',
      "  echo '* Request at 2026-11-21 14:13:00 -0500 EST' >&2",
      "  echo '* Request to https://api.github.com/graphql' >&2",
      "  echo '* Request took 301ms' >&2",
      "  echo '[git remote -v]' >&2",
      "fi",
      "echo 'a real warning' >&2",
      'echo "stdout:$*"',
      "exit 3",
      "",
    ].join("\n"),
  );
  chmodSync(fakeGh, 0o755);

  function installed(): string {
    const shim = file("gh", ghTapScript(fakeGh));
    chmodSync(shim, 0o755);
    return shim;
  }

  test("each request lands in the record; stdout, other stderr and the exit code pass through", () => {
    const record = file("gh-tap.log", `${TAP_START}\n`);
    const run = Bun.spawnSync([installed(), "api", "graphql"], {
      env: { ...process.env, RUNGATE_API_TAP: record },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(3);
    expect(run.stdout.toString()).toBe("stdout:api graphql\n");
    expect(run.stderr.toString()).toBe("a real warning\n");
    expect(readFileSync(record, "utf-8")).toBe(`${TAP_START}\nAPI-TAP gh - https://api.github.com/graphql\n`);
  });

  test("with no record named it is the real gh, untouched", () => {
    const env = { ...process.env };
    delete env.RUNGATE_API_TAP;
    const run = Bun.spawnSync([installed(), "pr", "list"], { env, stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).toBe(3);
    expect(run.stdout.toString()).toBe("stdout:pr list\n");
    expect(run.stderr.toString()).toBe("a real warning\n");
  });

  test("--install-gh-tap writes an executable gh that names the real one", () => {
    const dir = mkdtempSync(join(scratch, "bin-"));
    const run = Bun.spawnSync([process.execPath, CENSUS, "--install-gh-tap", dir, "--real-gh", fakeGh], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    const shim = join(dir, "gh");
    expect(existsSync(shim)).toBe(true);
    expect(readFileSync(shim, "utf-8")).toContain(fakeGh);
    const call = Bun.spawnSync([shim, "x"], { stdout: "pipe", stderr: "pipe" });
    expect(call.stdout.toString()).toBe("stdout:x\n");
  });
});

/**
 * The reviewers' model calls are read from what the review action itself
 * prints at the end of a run — its result object carries `num_turns`, one
 * model request per turn, and `total_cost_usd`. No tap is needed, and none
 * could see inside the action.
 */
describe("#2596: model calls are read from the review action's own result", () => {
  const result = (turns: number, cost: number) =>
    [
      "2026-11-21T19:04:22.5000000Z {",
      `2026-11-21T19:04:22.5224731Z   "num_turns": ${turns},`,
      `2026-11-21T19:04:22.5300000Z   "total_cost_usd": ${cost},`,
      "2026-11-21T19:04:22.5400000Z }",
    ].join("\n");

  test("a log with a result reads its turns and cost", () => {
    expect(readModelRun(result(24, 0.4822))).toEqual({ turns: 24, costUsd: 0.4822 });
  });

  test("a log with no result is no model run, not zero turns", () => {
    expect(readModelRun("2026-11-21T19:04:22Z the review was skipped on push")).toBeNull();
  });

  test("a result printed twice is one run, read once", () => {
    expect(readModelRun(`${result(24, 0.48)}\n${result(24, 0.48)}`)).toEqual({ turns: 24, costUsd: 0.48 });
  });

  test("the summary counts runs with and without a model call, and its total is the sum", () => {
    const text = renderModelRuns([
      { log: "a.log", run: { turns: 20, costUsd: 0.5 } },
      { log: "b.log", run: { turns: 30, costUsd: 1 } },
      { log: "c.log", run: null },
    ]);
    expect(text).toContain("3 logs: 2 with a model run, 1 without");
    expect(text).toContain("50 model turns");
    expect(text).toContain("mean 25.0, min 20, max 30");
    expect(text).toContain("$1.50");
  });

  test("--model over an unreadable log is UNMEASURED", () => {
    const run = Bun.spawnSync([process.execPath, CENSUS, "--model", join(scratch, "no-such.log")], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).toBe(CENSUS_UNMEASURED_EXIT);
    expect(run.exitCode).not.toBe(0);
  });

  test("--model over real-shaped logs prints the count", () => {
    const a = file("air-a.log", result(20, 0.5));
    const b = file("air-b.log", "no model here");
    const run = Bun.spawnSync([process.execPath, CENSUS, "--model", a, b], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect(run.stdout.toString()).toContain("2 logs: 1 with a model run, 1 without");
  });
});

/**
 * How often each workflow runs, from the Actions API's own list — the other
 * half of a per-day figure. One JSON object per line, as
 * `gh api --paginate …/actions/runs --jq '.workflow_runs[]'` writes them.
 */
describe("#2596: runs per workflow are counted from the Actions API's list", () => {
  const line = (name: string, event: string, conclusion: string | null) => JSON.stringify({ name, event, conclusion, id: 1 });

  test("each workflow is counted by event and conclusion, and the total is the sum of the rows", () => {
    const runs = countRuns(
      [line("CI", "push", "success"), line("CI", "pull_request", "success"), line("CI", "pull_request", "success"), line("Status", "workflow_run", "cancelled")].join("\n"),
    );
    expect(runs.total).toBe(4);
    expect(runs.workflows.map(w => [w.name, w.runs])).toEqual([
      ["CI", 3],
      ["Status", 1],
    ]);
    expect(runs.workflows.reduce((s, w) => s + w.runs, 0)).toBe(runs.total);
    expect(runs.workflows[0].by).toEqual({ "pull_request success": 2, "push success": 1 });
  });

  test("a run still going is counted as in progress, not dropped", () => {
    expect(countRuns(line("CI", "push", null)).workflows[0].by).toEqual({ "push in progress": 1 });
  });

  test("a line that is not a run refuses the whole list", () => {
    expect(() => countRuns(`${line("CI", "push", "success")}\nnot json`)).toThrow(/line 2/);
  });

  test("--runs over an empty list is UNMEASURED, not zero runs", () => {
    const empty = file("runs-empty.jsonl", "");
    const run = Bun.spawnSync([process.execPath, CENSUS, "--runs", empty], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).toBe(CENSUS_UNMEASURED_EXIT);
    expect(run.exitCode).not.toBe(0);
  });
});
