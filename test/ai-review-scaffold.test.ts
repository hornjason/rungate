import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  AI_REVIEW_ADC_MODE,
  AI_REVIEW_ADC_PROBE,
  AI_REVIEW_AUTH_PRECEDENCE,
  AI_REVIEW_MODES,
  AI_REVIEW_REQUIRED_EXIT,
  AI_REVIEW_REQUIRE_VAR,
  buildAuthDetectScript,
  buildAuthDetectStep,
} from "../lib/scaffold/ai-review-step";

/**
 * Covers AC-1, AC-5, AC-6, AC-6b (#630 — the ai-review auth-detect step).
 * Covers SC-2123, SC-2124, SC-2125 (HARNESS-STANDARD.md) — #679.
 *
 * The thing under test is a SCRIPT, so every case below runs it. Asserting on
 * the generated text would be asserting that a template literal contains what
 * the template literal contains — `.claude/rules/checks-must-be-able-to-fail.md`
 * calls that an assertion that holds vacuously.
 *
 * The refusal cases run TWICE: once against the real builder, and once against
 * a mutant copy of `lib/scaffold/ai-review-step.ts` whose single exit-code
 * constant is set to 0. The second run is the evidence — a case asserting only
 * "exit code != 0" cannot tell a refusal from a crash or a bash syntax error.
 *
 * The input on which the mutant and the original differ, named here rather than
 * assumed: no credential in the environment and `RUNGATE_REQUIRE_AI_REVIEW=true`.
 * The real script exits 1; the mutant exits 0. Every other input in this file
 * exits 0 under both, which is why only the required-and-absent case is run
 * against the mutant.
 */

const SOURCE_PATH = join(import.meta.dir, "..", "lib", "scaffold", "ai-review-step.ts");
const source = readFileSync(SOURCE_PATH, "utf-8");

const SECRETS = ["GCP_SA_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

// ── Running the generated script ─────────────────────────────────────────

let SCRATCH = "";

beforeAll(() => {
  SCRATCH = mkdtempSync(join(tmpdir(), "ai-review-step-"));
});

afterAll(() => {
  if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  /** The `name=value` lines the step wrote to `$GITHUB_OUTPUT`. */
  outputs: string;
  /** The single mode the step resolved, or null if it resolved none at all. */
  mode: string | null;
}

let runSeq = 0;

/** `bash`, resolved once from this process's PATH — see `runScript`. */
const BASH = (() => {
  const found = spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf-8" });
  const path = (found.stdout ?? "").trim();
  if (!path) throw new Error("no bash on PATH — these cases execute the generated script");
  return path;
})();

/**
 * Execute a generated script with an environment built from scratch.
 *
 * Inheriting `process.env` would be a fixture that can satisfy the assertion
 * without the feature: a developer with a real `ANTHROPIC_API_KEY` exported
 * would see the "no credentials" cases resolve a mode and the refusal cases
 * go green for the wrong reason.
 */
function runScript(
  script: string,
  env: Record<string, string>,
  opts: { gcloud?: { exit: number } } = {},
): Run {
  const dir = join(SCRATCH, `run-${runSeq++}`);
  const sh = join(dir, "auth-detect.sh");
  const outFile = join(dir, "github_output");
  const bin = join(dir, "bin");
  spawnSync("mkdir", ["-p", bin]);
  writeFileSync(sh, script);
  writeFileSync(outFile, "");

  // `gcloud` is supplied by the case or absent, never inherited (#679).
  //
  // The script's only external command is the ADC probe, so PATH is the
  // scratch bin and NOTHING else: `echo`, `[` and `exit` are bash builtins.
  // Inheriting the real PATH would make every case machine-dependent in the
  // direction nobody checks — this project's owner HAS working ADC and
  // `gcloud` on their PATH, so "no credential resolves none" would go red on
  // their laptop and green in CI, and "a resolved mode emits no annotation"
  // would pass there for a reason the case does not name. #507: a fixture
  // must not lose its witness to an input it does not control.
  if (opts.gcloud) {
    const stub = join(bin, "gcloud");
    writeFileSync(stub, `#!/bin/sh\nexit ${opts.gcloud.exit}\n`, { mode: 0o755 });
    chmodSync(stub, 0o755);
  }

  // Absolute, because the child's PATH is the scratch bin: `bash` has to be
  // resolved from THIS process's environment or nothing spawns at all, and a
  // failure to spawn reports exit -1, which is non-zero and reads exactly
  // like a refusal.
  const r = spawnSync(BASH, [sh], {
    encoding: "utf-8",
    env: {
      PATH: bin,
      // Scratch, never the developer's real home. Same argument as PATH
      // above: with the real HOME, the file-existence mutant in #679 AC-6
      // finds this machine's own ADC file and reds five cases that have
      // nothing to do with the case under test — a count that depends on
      // whether the developer has run `gcloud auth login` is not a count.
      // Measured: 11 red with the real HOME, 6 with this one, in CI 6 either
      // way. A case that controls its inputs is the only one that witnesses.
      HOME: dir,
      GITHUB_OUTPUT: outFile,
      ...env,
    },
  });
  expect(r.error, `the script did not run: ${r.error?.message}`).toBeUndefined();

  const outputs = readFileSync(outFile, "utf-8");
  const modes = [...outputs.matchAll(/^mode=(.*)$/gm)].map(m => m[1]);
  expect(
    modes.length,
    `the step wrote ${modes.length} mode lines to $GITHUB_OUTPUT — a step that ` +
      `resolves "exactly one" mode must write exactly one\n${outputs}`,
  ).toBeLessThanOrEqual(1);

  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    outputs,
    mode: modes.length === 1 ? modes[0] : null,
  };
}

// ── The mutant ───────────────────────────────────────────────────────────
//
// A copy of the module with `AI_REVIEW_REQUIRED_EXIT` set to 0, written to a
// temp directory OUTSIDE the repo and imported from there. Running it from
// there is what proves the module has no relative imports: a later
// `from "../config-loader"` would make the mutant die on module resolution,
// and an import that throws reads as "the mutation was rejected on the merits"
// when in fact the mutant never ran.

let mutantScript = "";

beforeAll(async () => {
  const mutated = source.replace(/AI_REVIEW_REQUIRED_EXIT\s*=\s*1\b/, "AI_REVIEW_REQUIRED_EXIT = 0");
  if (mutated === source) {
    throw new Error(
      "could not build the mutant: no `AI_REVIEW_REQUIRED_EXIT = 1` in " +
        "lib/scaffold/ai-review-step.ts",
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "ai-review-mutant-"));
  const path = join(dir, "ai-review-step.ts");
  writeFileSync(path, mutated);
  const mod = (await import(path)) as { buildAuthDetectScript: () => string };
  mutantScript = mod.buildAuthDetectScript();
  rmSync(dir, { recursive: true, force: true });
});

// ── AC-6b: one exit constant, and nothing bypasses it ────────────────────

describe("AC-6b: the non-zero exit is routed through one exported constant", () => {
  test("AC-6b: AI_REVIEW_REQUIRED_EXIT is assigned exactly once", () => {
    const decls = source.match(/AI_REVIEW_REQUIRED_EXIT\s*=/g) || [];
    expect(
      decls.length,
      "more than one assignment to AI_REVIEW_REQUIRED_EXIT — the mutant would " +
        "only neutralise one of them",
    ).toBe(1);
  });

  test("AC-6b: it is exported, so a caller reads the refusal rather than guessing it", () => {
    expect(source).toContain("export const AI_REVIEW_REQUIRED_EXIT");
    expect(AI_REVIEW_REQUIRED_EXIT).not.toBe(0);
  });

  test("AC-6b: no refusal inlines a non-zero exit literal", () => {
    // Only the generated bash has lines beginning `exit `; TypeScript has no
    // such statement, so this reads the emitted script's exits out of the
    // template without needing to run it.
    const exits = source
      .split("\n")
      .map(l => l.trim())
      .filter(l => /^exit\s/.test(l))
      .map(l => l.replace(/^exit\s+/, "").trim());

    expect(exits.length, "no exit at all in the generated script").toBeGreaterThan(0);
    for (const code of exits) {
      expect(
        code,
        `\`exit ${code}\` bypasses AI_REVIEW_REQUIRED_EXIT, so the mutant cannot ` +
          `neutralise it and the refusal case below would pass for the wrong reason`,
      ).toMatch(/^(0|\$\{AI_REVIEW_REQUIRED_EXIT\})$/);
    }
  });

  test("AC-6b: the module has no relative imports", () => {
    const rel = source.match(/from\s+["']\.{1,2}\//g) || [];
    expect(rel, "a relative import would make the mutant fail to resolve").toEqual([]);
  });
});

// ── AC-1: exactly one of five modes, in precedence order ─────────────────

describe("AC-1: the builder resolves exactly one of five modes", () => {
  test("AC-1: the precedence list is the three credentials, in order, then adc, then none", () => {
    expect(AI_REVIEW_AUTH_PRECEDENCE.map(e => e.secret)).toEqual([...SECRETS]);
    // Five since #679: `adc` is not a secret, so it is not in the precedence
    // table — it is the branch after the table is exhausted.
    expect(AI_REVIEW_MODES.length).toBe(5);
    expect(AI_REVIEW_MODES[AI_REVIEW_MODES.length - 1]).toBe("none");
    expect(AI_REVIEW_MODES[AI_REVIEW_MODES.length - 2]).toBe(AI_REVIEW_ADC_MODE);
    expect([...new Set(AI_REVIEW_MODES)].length, "two modes share a name").toBe(5);
  });

  test("AC-1: each credential alone resolves its own mode", () => {
    const script = buildAuthDetectScript();
    for (const { secret, mode } of AI_REVIEW_AUTH_PRECEDENCE) {
      const r = runScript(script, { [secret]: "x" });
      expect(r.mode, `${secret} alone should resolve ${mode}\n${r.stdout}${r.stderr}`).toBe(mode);
      expect(r.code, `${secret} alone must not fail the job`).toBe(0);
    }
  });

  test("AC-1: no credential resolves none", () => {
    const r = runScript(buildAuthDetectScript(), {});
    expect(r.mode).toBe("none");
  });

  test("AC-1: precedence is GCP_SA_KEY, then CLAUDE_CODE_OAUTH_TOKEN, then ANTHROPIC_API_KEY", () => {
    const script = buildAuthDetectScript();
    // Each case sets the winner AND every credential below it, so a script
    // that simply checked them in the wrong order would resolve the loser.
    for (let i = 0; i < AI_REVIEW_AUTH_PRECEDENCE.length; i++) {
      const env: Record<string, string> = {};
      for (let j = i; j < AI_REVIEW_AUTH_PRECEDENCE.length; j++) {
        env[AI_REVIEW_AUTH_PRECEDENCE[j].secret] = "x";
      }
      const r = runScript(script, env);
      expect(
        r.mode,
        `with ${Object.keys(env).join(", ")} all set, ` +
          `${AI_REVIEW_AUTH_PRECEDENCE[i].secret} wins`,
      ).toBe(AI_REVIEW_AUTH_PRECEDENCE[i].mode);
    }
  });

  test("AC-1: an empty secret is an absent secret", () => {
    // An unset GitHub secret interpolates to the empty string, so `-n` rather
    // than `-v` is the only reading that matches what the runner produces.
    const r = runScript(buildAuthDetectScript(), { GCP_SA_KEY: "", ANTHROPIC_API_KEY: "x" });
    expect(r.mode).toBe("api-key");
  });

  test("AC-1: no mode is decided in an `if:` expression", () => {
    const step = buildAuthDetectStep();
    const conditions = step
      .split("\n")
      .map(l => l.trim())
      .filter(l => /^if\s*:/.test(l));
    expect(
      conditions,
      "a step-level `if:` makes the step report skipped, which can satisfy a " +
        "required status check — the mode has to be decided inside `run:`",
    ).toEqual([]);

    // The credentials may appear in `env:` and in the script. They must not
    // appear inside a `${{ }}` expression outside `env:` — `secrets` is not
    // available in `if:` at all, and a `vars` condition is the same trap.
    const runIndex = step.indexOf("run: |");
    expect(runIndex, "the step has no run block").toBeGreaterThan(-1);
    const head = step.slice(0, runIndex);
    for (const secret of [...SECRETS, AI_REVIEW_REQUIRE_VAR]) {
      const lines = head.split("\n").filter(l => l.includes(secret));
      expect(lines.length, `${secret} is not passed to the step`).toBeGreaterThan(0);
      for (const line of lines) {
        expect(
          line.trim(),
          `${secret} is read somewhere other than an env mapping: ${line.trim()}`,
        ).toMatch(new RegExp(`^${secret}:\\s*\\$\\{\\{\\s*(secrets|vars)\\.${secret}\\s*\\}\\}$`));
      }
    }
  });
});

// ── #679: Application Default Credentials are a credential ───────────────

/**
 * Covers #679 AC-1, AC-2, AC-4, AC-5, AC-6.
 *
 * #679 AC-3 — mode `adc` runs claude-code-action with `use_vertex` and no
 * `google-github-actions/auth` step — is NOT covered here and cannot be:
 * the generated workflow has no claude-code-action in it at all yet.
 * `buildReviewRunScript` annotates "a credential resolved, but no review
 * step is wired into this job yet (#631)". There is nothing to point an
 * assertion at until #631 lands the reviewer, and writing one against the
 * absent step would be the vacuous assertion this file's header warns about.
 */
describe("#679: ADC is a credential, and only when it actually works", () => {
  /** A HOME carrying an ADC credentials file — what a revoked login leaves. */
  let adcHomeSeq = 0;
  const adcHome = (): string => {
    const home = join(SCRATCH, `adc-home-${adcHomeSeq++}`);
    const dir = join(home, ".config", "gcloud");
    spawnSync("mkdir", ["-p", dir]);
    writeFileSync(join(dir, "application_default_credentials.json"), "{}");
    return home;
  };

  test("#679 AC-1: no secret, working ADC, resolves adc rather than none", () => {
    const r = runScript(buildAuthDetectScript(), {}, { gcloud: { exit: 0 } });
    expect(r.mode, `${r.stdout}${r.stderr}`).toBe(AI_REVIEW_ADC_MODE);
    expect(r.code, "a runner that can review must not fail the job").toBe(0);
    expect(r.stdout + r.stderr, "a resolved credential is not UNMEASURED")
      .not.toContain("::warning");
  });

  test("#679 AC-2: a failing probe resolves none, however present the ADC file is", () => {
    // The whole risk. `gcloud` is on PATH and exits non-zero — stale,
    // revoked or expired ADC — AND the credentials file is present, which is
    // exactly the state a revoked login leaves behind and exactly what a
    // file-existence test cannot tell from a working credential.
    //
    // The file is PLANTED and not assumed. Without it this case is green
    // under the file-existence probe too, since there would be no file for
    // that probe to find: measured at 4 red where 6 was predicted, and the
    // two missing reds were this case and nothing else. A fixture whose
    // name says "however present the ADC file is" has to make it present.
    const r = runScript(buildAuthDetectScript(), { HOME: adcHome() }, { gcloud: { exit: 1 } });
    expect(r.mode, `${r.stdout}${r.stderr}`).toBe("none");
  });

  test("#679 AC-5: no secret and no gcloud at all still resolves none and annotates", () => {
    // The GitHub-hosted runner, where `gcloud` is not installed. The new
    // branch must not swallow the credential-less case.
    const r = runScript(buildAuthDetectScript(), {});
    expect(r.mode).toBe("none");
    expect(r.stdout + r.stderr).toContain("::warning");
    expect(r.code, "UNMEASURED is not a failure unless the consumer asked").toBe(0);
  });

  test("#679 AC-5: the annotation names ADC, not only the three secrets", () => {
    // A warning that lists only the secret store sends a reader to configure
    // the one thing this consumer cannot produce (#679's premise).
    const r = runScript(buildAuthDetectScript(), {});
    expect(r.stdout + r.stderr).toContain("Application Default Credential");
  });

  test("#679 AC-4: every secret still wins over a working ADC", () => {
    const script = buildAuthDetectScript();
    for (const { secret, mode } of AI_REVIEW_AUTH_PRECEDENCE) {
      const r = runScript(script, { [secret]: "x" }, { gcloud: { exit: 0 } });
      expect(
        r.mode,
        `${secret} was configured and the job used somebody's ambient login instead`,
      ).toBe(mode);
    }
  });

  test("#679 AC-4: the ADC branch is last in the script, not merely last in the table", () => {
    // The case above passes if the branches are ordered correctly. It also
    // passes if ADC were FIRST and the stub happened to fail — so the order
    // is read off the script too, with both halves required.
    const script = buildAuthDetectScript();
    const adcAt = script.indexOf(AI_REVIEW_ADC_PROBE);
    expect(adcAt, "the probe is not in the generated script").toBeGreaterThan(-1);
    for (const { secret } of AI_REVIEW_AUTH_PRECEDENCE) {
      expect(script.indexOf(secret), `${secret} is tested after ADC`).toBeLessThan(adcAt);
    }
  });

  test("#679 AC-2: the probe attempts a credential, it does not stat a path", () => {
    const script = buildAuthDetectScript();
    // Named forms rather than a general scan: the point is that THESE two
    // cheap probes are absent, because each resolves a usable-looking mode
    // from something that is true of a revoked credential.
    expect(script, "a file test decides the mode").not.toContain("application_default_credentials.json");
    expect(script, "a runner label decides the mode").not.toContain("RUNNER_LABELS");
    expect(script).toContain("print-access-token");
  });

  test("#679 AC-6: the access token is never captured or printed", () => {
    // A bearer token in a shell variable is one `set -x` away from the build
    // log, and `$GITHUB_OUTPUT` is read by later steps.
    const script = buildAuthDetectScript();
    expect(script).toContain("print-access-token >/dev/null 2>&1");
    expect(script, "the token is assigned to a variable").not.toMatch(
      /\w+=\$\((?:.*)print-access-token/,
    );
  });

  test("#679 AC-6: the file-existence mutant resolves adc where the real script does not", () => {
    // The counterfactual, run rather than described. The mutant is the cheap
    // probe #679 names: it tests the ADC file and ignores whether the
    // credential works. Both are driven with a gcloud that FAILS and the
    // file present — the state a revoked login leaves behind.
    const real = buildAuthDetectScript();
    const mutant = real.replace(
      AI_REVIEW_ADC_PROBE,
      '[ -f "${HOME}/.config/gcloud/application_default_credentials.json" ]',
    );
    expect(mutant, "could not build the mutant: the probe moved").not.toBe(real);

    const env = { HOME: adcHome() };

    expect(
      runScript(mutant, env, { gcloud: { exit: 1 } }).mode,
      "the mutant was expected to resolve adc from the file alone — if this is " +
        "none the counterfactual is wrong, not the probe",
    ).toBe(AI_REVIEW_ADC_MODE);
    expect(
      runScript(real, env, { gcloud: { exit: 1 } }).mode,
      "the real script read the file instead of the credential",
    ).toBe("none");
  });
});

// ── AC-5: mode none annotates UNMEASURED rather than passing silently ────

describe("AC-5: mode none is UNMEASURED, not silence", () => {
  test("AC-5: a warning annotation naming UNMEASURED is emitted", () => {
    const r = runScript(buildAuthDetectScript(), {});
    const annotations = r.stdout.split("\n").filter(l => l.startsWith("::warning"));
    expect(
      annotations.length,
      `mode none printed no ::warning annotation — a silent pass is exactly ` +
        `what this exists to prevent\n${r.stdout}`,
    ).toBe(1);
    expect(annotations[0]).toContain("UNMEASURED");
    for (const secret of SECRETS) expect(annotations[0]).toContain(secret);
  });

  test("AC-5: a resolved mode emits no UNMEASURED annotation", () => {
    // Without this the annotation could be unconditional, and "UNMEASURED"
    // would stop meaning anything.
    for (const { secret } of AI_REVIEW_AUTH_PRECEDENCE) {
      const r = runScript(buildAuthDetectScript(), { [secret]: "x" });
      expect(r.stdout, `${secret} resolved a mode and still warned`).not.toContain("UNMEASURED");
    }
  });

  test("AC-5: the UNMEASURED-not-silent wording is recorded in config-access.md", () => {
    const rule = readFileSync(
      join(import.meta.dir, "..", ".claude", "rules", "config-access.md"),
      "utf-8",
    );
    // Search the slice, not the document: "UNMEASURED" already appears in the
    // Silent Default Substitution bullet, so a whole-file search is satisfied
    // by text that says nothing about credentials.
    const heading = "## An absent credential is UNMEASURED, not a silent pass";
    const start = rule.indexOf(heading);
    expect(start, `${heading} is not in .claude/rules/config-access.md`).toBeGreaterThan(-1);
    const rest = rule.slice(start + heading.length);
    const end = rest.indexOf("\n## ");
    const section = (end === -1 ? rest : rest.slice(0, end)).trim();

    expect(section.length, "the section is empty — a heading is not a rule").toBeGreaterThan(200);
    expect(section).toContain("UNMEASURED");
    expect(section).toContain(AI_REVIEW_REQUIRE_VAR);
    for (const secret of SECRETS) expect(section).toContain(secret);
  });
});

// ── AC-6: the required-review variable, and only the string "true" ───────

describe("AC-6: mode none fails only when RUNGATE_REQUIRE_AI_REVIEW is the string true", () => {
  test("AC-6: the string true with no credential exits non-zero", () => {
    const r = runScript(buildAuthDetectScript(), { [AI_REVIEW_REQUIRE_VAR]: "true" });
    expect(r.code, `expected a refusal\n${r.stdout}${r.stderr}`).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(r.mode).toBe("none");

    const mutant = runScript(mutantScript, { [AI_REVIEW_REQUIRE_VAR]: "true" });
    expect(
      mutant.code,
      `the mutant (AI_REVIEW_REQUIRED_EXIT = 0) still exited ${mutant.code} — ` +
        `this case is not being caught by the refusal under test\n${mutant.stderr}`,
    ).toBe(0);
    expect(mutant.mode, "the mutant stopped resolving a mode, so it is not a mutant").toBe("none");
  });

  test("AC-6: every other value of the variable exits zero", () => {
    const script = buildAuthDetectScript();
    const cases: Array<[string, Record<string, string>]> = [
      ["unset", {}],
      ["empty", { [AI_REVIEW_REQUIRE_VAR]: "" }],
      ["TRUE", { [AI_REVIEW_REQUIRE_VAR]: "TRUE" }],
      ["True", { [AI_REVIEW_REQUIRE_VAR]: "True" }],
      ["1", { [AI_REVIEW_REQUIRE_VAR]: "1" }],
      ["yes", { [AI_REVIEW_REQUIRE_VAR]: "yes" }],
      ["false", { [AI_REVIEW_REQUIRE_VAR]: "false" }],
      ["true with trailing space", { [AI_REVIEW_REQUIRE_VAR]: "true " }],
    ];
    for (const [label, env] of cases) {
      const r = runScript(script, env);
      expect(r.code, `${label} must not fail the job\n${r.stdout}${r.stderr}`).toBe(0);
      expect(r.mode, `${label} changed the resolved mode`).toBe("none");
      expect(
        r.stdout,
        `${label} exits zero, but it must still say the review is UNMEASURED`,
      ).toContain("UNMEASURED");
    }
  });

  test("AC-6: the variable does not fail a job that DID review", () => {
    // The refusal is about an unmeasured review, not about the variable. A
    // script that read the variable first would fail every job on a tree that
    // sets it, which is the cheapest wrong fix for "make it required".
    for (const { secret } of AI_REVIEW_AUTH_PRECEDENCE) {
      const r = runScript(buildAuthDetectScript(), {
        [secret]: "x",
        [AI_REVIEW_REQUIRE_VAR]: "true",
      });
      expect(r.code, `${secret} resolved a mode and the job still failed`).toBe(0);
    }
  });
});
