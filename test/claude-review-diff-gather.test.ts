/**
 * The step that hands the diff to the agent, EXECUTED (#732).
 *
 * ## Why this file exists rather than a text assertion
 *
 * The reviewer's whole subject now arrives through
 * `steps.subject.outputs.diff`. A text assertion that the step "writes a
 * heredoc" would have been green over the defect that actually happened:
 *
 * > `##[error]Unable to process file command 'output' successfully.`
 * > `##[error]Invalid value. Matching delimiter not found 'EOF_ed27254a…'`
 *
 * Run **39339388211**, against a 110,547-byte diff. `head -c` cuts mid-line,
 * so the closing delimiter was appended to the end of a partial diff line and
 * GitHub refused the whole `GITHUB_OUTPUT` write. The step died, `auth` and
 * `Review` were skipped, and the only reason anyone saw it is that the
 * post-step this same change adds turned the job red — on the UNMEASURED
 * path, not on a finding.
 *
 * Nothing in the first dispatch could have caught it: that PR's diff was
 * 'under the cap, so the truncation branch had never run. Every natural
 * fixture is a fixture of the feature
 * (`.claude/rules/checks-must-be-able-to-fail.md`, "a battery whose fixtures
 * all meet a precondition"), and the branch on the other side of the cap is
 * the one nobody writes.
 *
 * So the step's own `run:` body is cut out of the workflow and RUN, against a
 * stub `gh` on `PATH` and a temporary `GITHUB_OUTPUT`, and the file it writes
 * is parsed the way the runner parses it.
 *
 * ## The cheapest wrong fix, named
 *
 * **Raise `MAX_BYTES`.** The symptom is one PR failing, and a bigger number
 * makes it stop — until the next PR. The cases here survive it: the cap is
 * read from the step's own `env:` and the fixture is sized relative to it, so
 * a larger cap produces a larger fixture and the truncation branch still runs.
 *
 * The second-cheapest: **drop the heredoc and write the diff to a file
 * instead.** That is arguably the better design, and these cases do not
 * survive it — they would abort in `beforeAll` with "the gather step does not
 * write a heredoc", which is a loud refusal to measure rather than a green
 * pass over a changed mechanism.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobSteps } from "../lib/review-tool-agreement";

const WORKFLOW = join(import.meta.dir, "..", ".github", "workflows", "claude-review.yml");
const source = readFileSync(WORKFLOW, "utf8");

/** The gather step, located by the command it runs rather than by its name. */
const gatherStep = (() => {
  const hits = jobSteps(source).filter(s => /^\s*gh pr diff /m.test(s));
  if (hits.length !== 1) throw new Error(`${hits.length} steps run \`gh pr diff\`, not one`);
  return hits[0];
})();

/**
 * The step's `run:` body, dedented to column zero so bash can run it.
 *
 * Bounded by INDENTATION, not by the end of the step. A step's trailing
 * comment block belongs to the next step's preamble in `jobSteps` (see its
 * docstring), and taking it produced `syntax error near unexpected token '('`
 * from a dedented `# … (#677, AC-15).` — a harness failure that reads exactly
 * like the step being broken.
 */
const runBody = (() => {
  const lines = gatherStep.split("\n");
  const at = lines.findIndex(l => l.trimStart() === "run: |");
  if (at === -1) throw new Error("the gather step has no `run: |` block");
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const base = indentOf(lines[at]);
  const body: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i].trim() !== "" && indentOf(lines[i]) <= base) break;
    body.push(lines[i]);
  }
  const indent = indentOf(body[0]);
  const out = body.map(l => l.slice(indent));
  if (!out.join("\n").includes("diff<<")) {
    throw new Error("the gather step does not write a heredoc — this file measures nothing");
  }
  return out.join("\n");
})();

const MAX_BYTES = Number(/MAX_BYTES:\s*"(\d+)"/.exec(gatherStep)?.[1]);

/**
 * Both `gh` stubs below answer `gh api` with THREE ID LINES, not the bare
 * number `3`. That is what `--paginate --jq '.[].id'` emits, and AC-8 is why
 * the shape matters: under `--paginate` the jq program runs once per page, so
 * `--jq 'length'` prints one number per page rather than a total. The stubs
 * modelled the old single-page contract, and when the reader changed, AC-1 and
 * AC-2 went red rather than passing a stale fixture through — which is the
 * behaviour wanted from a fixture that models an API.
 */

/** `GITHUB_OUTPUT` as the runner reads it: `k=v` lines and `k<<D … D` blocks. */
function parseOutputs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const heredoc = /^([A-Za-z0-9_-]+)<<(.+)$/.exec(lines[i]);
    if (heredoc) {
      const [, key, delimiter] = heredoc;
      const body: string[] = [];
      let closed = false;
      for (i++; i < lines.length; i++) {
        if (lines[i] === delimiter) {
          closed = true;
          break;
        }
        body.push(lines[i]);
      }
      if (!closed) {
        throw new Error(`Invalid value. Matching delimiter not found '${delimiter}'`);
      }
      out[key] = body.join("\n");
      continue;
    }
    const scalar = /^([A-Za-z0-9_-]+)=(.*)$/.exec(lines[i]);
    if (scalar) out[scalar[1]] = scalar[2];
  }
  return out;
}

/**
 * Run the real step body with a stub `gh`.
 *
 * `diffBytes` sizes the patch the stub prints. The final line is deliberately
 * long and unterminated at the cut point, which is what a real patch looks
 * like and what the defect needed.
 */
function runGather(diffBytes: number) {
  const dir = mkdtempSync(join(tmpdir(), "r732-gather-"));
  const bin = join(dir, "bin");
  writeFileSync(join(dir, "ignored"), "");
  Bun.spawnSync(["mkdir", "-p", bin]);
  const stub = join(bin, "gh");
  writeFileSync(
    stub,
    `#!/bin/bash
if [ "$1" = "pr" ] && [ "$2" = "diff" ]; then
  # One long unterminated line at the end, which is what a patch hunk is and
  # what makes a byte-cut land mid-line.
  printf 'diff --git a/x b/x\\n'
  head -c ${diffBytes} < /dev/zero | tr '\\0' '+'
  exit 0
fi
if [ "$1" = "api" ]; then printf '101\\n102\\n103\\n'; exit 0; fi
exit 1
`,
  );
  chmodSync(stub, 0o755);
  const outputFile = join(dir, "github_output");
  writeFileSync(outputFile, "");
  const script = join(dir, "step.sh");
  writeFileSync(script, runBody);
  const p = Bun.spawnSync(["bash", script], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_OUTPUT: outputFile,
      GH_TOKEN: "stub",
      PR: "746",
      REPO: "hornjason/pai-harness",
      MAX_BYTES: String(MAX_BYTES),
    },
  });
  return {
    code: p.exitCode,
    stdout: new TextDecoder().decode(p.stdout),
    outputs: () => parseOutputs(readFileSync(outputFile, "utf8")),
  };
}

describe("the gather step hands the agent a diff the runner can actually read (#732)", () => {
  test("AC-0: the step was found and the cap was read — otherwise this file measures nothing", () => {
    expect(MAX_BYTES).toBeGreaterThan(0);
    expect(runBody).toContain("gh pr diff");
    expect(runBody).toContain("reviews_before=");
  });

  /**
   * AC-5: the ceiling on the cap, which nothing asserted while the cap was a
   * number somebody could raise.
   *
   * The step writes the diff into `GITHUB_OUTPUT`, and the runner refuses the
   * whole file above **1 MB in total** — shared with `truncated`,
   * `reviews_before` and every other output this job sets. A cap at or above
   * that limit does not produce a truncated review; it produces the run
   * 39339388211 failure mode this file was written for, where the step dies
   * and `auth` and `Review` are skipped. So the honest bound is well under it.
   *
   * HALF, and the reason is not caution. A diff is not the only output, and a
   * fixture at `MAX_BYTES * 2` is constructed by AC-2 above — so a cap over
   * half the limit makes this file's own over-the-cap case unrunnable, and the
   * truncation branch would stop being exercised while every row stayed green.
   * The bound and the battery are the same constraint.
   *
   * Breaking it: set `MAX_BYTES` to `"600000"` in the workflow and this goes
   * red naming the limit, while AC-1 and AC-2 keep passing — which is the
   * point, because they are what a raiser would run.
   */
  test("AC-5: the cap leaves room under GITHUB_OUTPUT's 1 MB total", () => {
    const GITHUB_OUTPUT_LIMIT = 1_000_000;
    expect(
      MAX_BYTES,
      `MAX_BYTES is ${MAX_BYTES}; GITHUB_OUTPUT accepts ${GITHUB_OUTPUT_LIMIT} bytes in TOTAL ` +
        "across every output this step writes, and AC-2 builds a fixture at twice the cap. " +
        "Raising it past half the limit breaks the runner's write, not the review's coverage.",
    ).toBeLessThanOrEqual(GITHUB_OUTPUT_LIMIT / 2);
  });

  /**
   * AC-8: every review count is read over ALL pages, in both places.
   *
   * `reviews_before` and `after` are the two halves of one subtraction, and
   * `NO_REVIEW_POSTED` — a failure of this required check — fires when the
   * difference is zero. `gh api <path>` without `--paginate` returns the FIRST
   * PAGE, 30 items. So at 30 reviews both halves saturate at 30, the
   * difference is 0 forever, and the check reports that no review was posted
   * on every run of that pull request whatever the reviewer did.
   *
   * It fires on exactly the pull requests that have been reviewed the most,
   * and once it fires it can never clear, because nothing a later run posts
   * can move a saturated count. Measured 2026-11-04, unpaginated against
   * paginated on the three pull requests then failing this way:
   *
   *   #1740  30 → 58      #1607  30 → 63      #1753  30 → 30
   *
   * and #1754, #1755, #1756, all under 30 reviews, all passed.
   *
   * THE COUNT IS THE POPULATION. Both reads are the same expression against
   * the same path, so repairing one leaves a subtraction with one saturated
   * operand — which is still always wrong, just less obviously. This row
   * asserts the property over every `pulls/.../reviews` read in the file
   * rather than naming two line numbers, so a third reader added later is
   * covered without anybody remembering this comment.
   *
   * Breaking it: drop `--paginate` from either read and this goes red naming
   * the one that lost it. No other row sees it.
   */
  test("AC-8: every review-count read paginates — an unpaginated one saturates at 30", () => {
    const reads = source
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => !l.startsWith("#") && /gh api .*pulls\/.*\/reviews/.test(l));

    expect(
      reads.length,
      "no `gh api …/pulls/<n>/reviews` read found — this row would pass vacuously",
    ).toBe(2);

    expect(
      reads.filter((l) => !l.includes("--paginate")),
      "`gh api` without `--paginate` returns 30 items. `reviews_before` and `after` are " +
        "the two halves of the subtraction NO_REVIEW_POSTED reads, so at 30 reviews both " +
        "saturate, the difference is 0 forever, and this required check fails on every " +
        "run of the most-reviewed pull requests. Measured: #1740 read 30, really 58.",
    ).toEqual([]);
  });

  /**
   * AC-6: the cap's REAL ceiling, which is not the one AC-5 asserts.
   *
   * AC-5 bounds the cap by `GITHUB_OUTPUT`'s 1 MB, and that bound is true and
   * not the binding one. The gathered diff does not stop at `GITHUB_OUTPUT`:
   * it is interpolated into the `prompt:` input, and the action marshals every
   * input into ONE environment variable — `ALL_INPUTS` — before `execve`ing
   * bash. Linux caps a single argv/env string at `MAX_ARG_STRLEN`, 32 pages,
   * 131072 bytes. Over it, `execve` returns `E2BIG` and the runner prints
   *
   *   An error occurred trying to start process '/usr/bin/bash' … Argument
   *   list too long
   *
   * which names no variable, no step and no size, and the review never runs.
   *
   * MEASURED, not inferred. Run 41879146916 on PR #1753, 2026-11-04:
   * `ALL_INPUTS` was 161,683 bytes, the step died with exactly that message,
   * and the post-step reported `NO_REVIEW_POSTED`. The cap did not fire,
   * because 161,683 is under the 262,144 it was then set to — AC-5's ceiling
   * was satisfied the whole time.
   *
   * THREE QUARTERS, and the quarter is not caution. The variable also carries
   * the prompt literal and every other input, and JSON-escaping a diff adds
   * roughly a byte per line. A cap AT the limit overflows on the envelope.
   *
   * Breaking it: set `MAX_BYTES` back to `"262144"` and this goes red naming
   * the limit, while AC-1, AC-2, AC-3 and AC-5 all stay green — which is the
   * point, because those are the rows a raiser would run.
   */
  test("AC-6: the cap leaves room under MAX_ARG_STRLEN, which is what actually refused", () => {
    const MAX_ARG_STRLEN = 32 * 4096;
    expect(
      MAX_BYTES,
      `MAX_BYTES is ${MAX_BYTES}. The diff reaches the agent inside ONE environment ` +
        `variable, and Linux refuses any single env string over ${MAX_ARG_STRLEN} bytes ` +
        "with 'Argument list too long' before bash starts — see run 41879146916. " +
        "GITHUB_OUTPUT's 1 MB (AC-5) is the looser of the two limits and not the one " +
        "that fires.",
    ).toBeLessThanOrEqual(Math.floor((MAX_ARG_STRLEN * 3) / 4));
  });

  /**
   * AC-7: the subject is the PR's combined diff, never its per-commit series.
   *
   * `gh pr diff --patch` emits `git format-patch` output — every commit on the
   * branch, each with its own header and message. Its size tracks the number
   * of ROUNDS, not the size of the change, so the input grows every time the
   * reviewer asks for a fix. Measured on PR #1753 at round 8, 2026-11-04:
   *
   *   gh pr diff 1753 --patch  →  155,370 bytes
   *   gh pr diff 1753          →   37,160 bytes
   *
   * Four times the subject for the same change, and it was the 155 KB that
   * pushed `ALL_INPUTS` past AC-6's limit. The feedback loop points the wrong
   * way: the pull requests that have needed the most review are the ones whose
   * reviewer cannot start. A reviewer wants the diff of the merge, which is
   * what the prompt's own DIFF markers promise.
   *
   * Breaking it: put `--patch` back on the command and this goes red. No other
   * row sees it — the stub `gh` in `runGather` ignores its flags, exactly as a
   * reviewer reading only the round-trip cannot tell the two outputs apart.
   *
   * IT READS THE COMMAND, NOT THE STEP. A substring search over the whole body
   * was the first spelling and it was wrong in the safe direction: the comment
   * warning the next person off the flag has to name it, so the row went red
   * on the fix that satisfied it. A detector that cannot tell a command from a
   * sentence about a command measures the prose.
   */
  test("AC-7: the step gathers the combined diff, not the per-commit patch series", () => {
    const commands = runBody
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => !l.startsWith("#") && l.includes("gh pr diff"));

    expect(
      commands.length,
      "no `gh pr diff` command line outside a comment — this row would pass vacuously",
    ).toBe(1);

    expect(
      commands.filter((l) => l.includes("--patch")),
      "`gh pr diff --patch` emits one patch per COMMIT, so the subject grows with the " +
        "round count rather than the change: 155,370 bytes against 37,160 on PR #1753 at " +
        "round 8. That is what overflowed AC-6's limit. Gather the combined diff.",
    ).toEqual([]);
  });

  /**
   * The control. Under the cap, nothing is truncated and the diff round-trips
   * whole — so a failure in the row below is about the cut and not about the
   * harness.
   */
  test("AC-1: a diff under the cap round-trips whole, truncated=false", () => {
    const r = runGather(Math.floor(MAX_BYTES / 2));
    expect(r.code).toBe(0);
    const o = r.outputs();
    expect(o.truncated).toBe("false");
    expect(o.reviews_before).toBe("3");
    expect(o.diff.length).toBeGreaterThan(MAX_BYTES / 4);
    expect(o.diff).toContain("diff --git a/x b/x");
    expect(o.diff).not.toContain("truncated at");
  });

  /**
   * Run 39339388211, reproduced. The cut lands mid-line; without a newline
   * after it the delimiter is swallowed by that line and `parseOutputs`
   * raises the runner's own message.
   */
  test("AC-2: a diff over the cap is truncated AND the delimiter is still readable", () => {
    const r = runGather(MAX_BYTES * 2);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("::warning::diff truncated");
    const o = r.outputs();
    expect(o.truncated).toBe("true");
    expect(o.reviews_before).toBe("3");
    // The agent is TOLD its subject is incomplete. A silently cut diff is the
    // same defect as a silently skipped review, one layer down.
    expect(o.diff).toContain("*** diff truncated at");
    expect(o.diff.length).toBeGreaterThan(MAX_BYTES - 1000);
  });

  /**
   * The mutation, performed rather than asserted: the line break removed.
   *
   * **The fixture is UNDER the cap, and that is the whole point.** Over the
   * cap the truncation marker ends in a newline of its own, so either line
   * saves the parse and a mutation of one is invisible — two deciders that
   * agree (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
   * Measured rather than argued: with the live workflow intact and this
   * fixture pointed over the cap, the mutant's output parses and bun reports
   * *"Received function did not throw"*. An over-cap fixture cannot witness
   * this mutation at all.
   *
   * The untruncated branch is the input only `echo ""` reaches, and it is the
   * branch nobody writes a fixture for: every real `gh pr diff` happens to
   * end in a newline, so the defect only shows when one does not.
   *
   * `parseOutputs` must raise, and it must raise the RUNNER's sentence — a
   * harness that merely returned a short string would pass this row over a
   * step that still kills the job.
   */
  test("AC-3: without the line break before it, the runner cannot parse the output at all", () => {
    const needle = '  echo ""\n  echo "$d"\n';
    const occurrences = runBody.split(needle).length - 1;
    if (occurrences !== 1) {
      throw new Error(`could not build the mutant: the blank line appears ${occurrences} times`);
    }
    const broken = runBody.replace(needle, '  echo "$d"\n');
    expect(broken, "the mutation did not apply").not.toEqual(runBody);

    const dir = mkdtempSync(join(tmpdir(), "r732-broken-"));
    const bin = join(dir, "bin");
    Bun.spawnSync(["mkdir", "-p", bin]);
    const stub = join(bin, "gh");
    writeFileSync(
      stub,
      `#!/bin/bash
if [ "$1" = "pr" ] && [ "$2" = "diff" ]; then
  printf 'diff --git a/x b/x\\n'
  head -c ${Math.floor(MAX_BYTES / 2)} < /dev/zero | tr '\\0' '+'
  exit 0
fi
if [ "$1" = "api" ]; then printf '101\\n102\\n103\\n'; exit 0; fi
exit 1
`,
    );
    chmodSync(stub, 0o755);
    const outputFile = join(dir, "github_output");
    writeFileSync(outputFile, "");
    const script = join(dir, "step.sh");
    writeFileSync(script, broken);
    const p = Bun.spawnSync(["bash", script], {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_OUTPUT: outputFile,
        GH_TOKEN: "stub",
        PR: "746",
        REPO: "hornjason/pai-harness",
        MAX_BYTES: String(MAX_BYTES),
      },
    });
    // bash is happy — which is the whole problem. The runner is not.
    expect(p.exitCode).toBe(0);
    expect(() => parseOutputs(readFileSync(outputFile, "utf8"))).toThrow(
      /Matching delimiter not found/,
    );
  });
});
