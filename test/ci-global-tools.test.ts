/**
 * ci-global-tools.test.ts — #597.
 *
 * Three Layer 1 compliance tests decide their verdict by shelling out to
 * `agnix` and `npx @reporails/cli`. CI installed neither, so what the registry
 * served at that moment was the verdict: an identical SHA was re-run red to
 * green with no code change. The fix is a pinned global install in the
 * generated CI test job, declared in ONE place — `ci.globalTools` in
 * `.claude/rungate/config.json` — for the same reason #622 took the Bun
 * version and #488 took the test command: two positions that agree today are
 * one decider too many, and only a mutation of a shared binding can show the
 * agreement is load-bearing.
 *
 * ## What each case is pointed at
 *
 * - **AC-1** the declaration exists, is EXACT (a range or a moving tag is not
 *   a pin), and is the only place the version strings live. Any copy inside a
 *   generated workflow is checked for AGREEMENT rather than forbidden —
 *   `.github/workflows/ci.yml` is this declaration's output, and a check that
 *   went red the first time somebody re-scaffolded would be a check people
 *   learn to delete.
 * - **AC-2/AC-3** the generator READS it. The fixture declares versions no
 *   registry has ever served, so a generator that carried literals, or read
 *   the wrong field, cannot produce them.
 * - **AC-2b** the absent case is LOUD. `.claude/rules/config-access.md`: a
 *   built-in default substituted for an absent declaration must say so,
 *   because silence is indistinguishable from success. Same shape as
 *   `typecheckStep`.
 * - **AC-4** the pin can be removed, and the removal is visible.
 *
 * ## The cheapest wrong fix, named, per checks-must-be-able-to-fail.md
 *
 * The 5pm repair for "CI does not have these tools" is one line:
 * `- run: npm install -g agnix @reporails/cli`, unpinned, emitted as a bare
 * `run` step. It makes the symptom go away and reintroduces the defect —
 * whatever the registry serves that minute decides the verdict again — and it
 * ALSO silently steals the test command: `testCommandsNamedByCiWorkflow` reads
 * the first non-setup `- run:` line in the test job, so an install emitted
 * that way becomes "the project's test command" to #621's agreement check.
 * Both halves are asserted below, and neither survives that fix.
 *
 * ## Mutation counts (#597), run and reverted — none is left in the tree
 *
 * Measured over this file alone.
 *
 * | Row | Predicted | Measured |
 * |---|---|---|
 * | **baseline** — unmutated | 11 pass, 0 fail | **11 pass, 0 fail** |
 * | the version pin dropped in `lib/scaffold/steps.ts` (`'${p.package}@${p.version}'` → `'${p.package}'`) | 4 | **4 of 11** |
 * | the pin expression's variable renamed (`p` → `pin`), so the in-test mutant cannot be built | 3 | **3 of 11** |
 *
 * Row two's four reds are the AC-2/AC-3 reading case plus the three
 * mutant-building cases, which throw `could not build the mutant: the
 * pin-emitting expression appears 0 times` — the loud-abort property the
 * builder exists for, rather than three cases passing over a mutation that
 * was never applied. Row three leaves the AC-2/AC-3 case GREEN, because a
 * rename does not unpin anything, and that asymmetry is what says the two
 * rows measure different things.
 *
 * The input on which the mutant and the original differ, named and run rather
 * than assumed: a project whose config declares
 * `ci.globalTools = {"agnix": "9.99.99-unusual-pin.1", "@reporails/cli":
 * "0.0.0-deliberately-odd.7"}`. The original emits
 * `npm install -g 'agnix@9.99.99-unusual-pin.1'
 * '@reporails/cli@0.0.0-deliberately-odd.7'`; the mutant emits
 * `npm install -g 'agnix' '@reporails/cli'`, which is the unpinned install
 * that reintroduces #597.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { tryLoadRungateConfig } from "../lib/config-loader";
import { createCiWorkflows, globalToolInstallStep } from "../lib/scaffold/steps";
import { testCommandsNamedByCiWorkflow } from "../lib/test-command-positions";

const REPO_ROOT = join(import.meta.dir, "..");
const STEPS = join(REPO_ROOT, "lib", "scaffold", "steps.ts");
const STEPS_DIR = dirname(STEPS);
const CI_REL = join(".github", "workflows", "ci.yml");

/**
 * The tools `lib/compliance.ts` shells out to. Spelled as the package names
 * npm resolves, because that is what an install step can pin.
 */
const COMPLIANCE_TOOLS = ["agnix", "@reporails/cli"];

/** An exact version: not a range, not `latest`, not a dist-tag. */
const EXACT_VERSION = /^[0-9][A-Za-z0-9.+-]*$/;

/**
 * Versions no registry has ever served, so the generated file cannot contain
 * them by coincidence and a literal in the generator cannot produce them.
 */
const UNUSUAL_PINS: Record<string, string> = {
  agnix: "9.99.99-unusual-pin.1",
  "@reporails/cli": "0.0.0-deliberately-odd.7",
};

interface Step {
  name?: string;
  run?: string;
  uses?: string;
}

function testJobSteps(yml: string): Step[] {
  const parsed = Bun.YAML.parse(yml) as { jobs?: { test?: { steps?: Step[] } } };
  return parsed?.jobs?.test?.steps ?? [];
}

const indexOfRun = (steps: Step[], needle: string): number =>
  steps.findIndex(s => typeof s.run === "string" && s.run.includes(needle));

let SCRATCH = "";

beforeEach(() => {
  SCRATCH = mkdtempSync(join(tmpdir(), "ci-global-tools-"));
});

afterEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

function plantProject(label: string, ci: Record<string, unknown>): string {
  const project = join(SCRATCH, `project-${label}`);
  mkdirSync(join(project, ".claude", "rungate"), { recursive: true });
  writeFileSync(
    join(project, ".claude", "rungate", "config.json"),
    JSON.stringify({ project: "global-tools-fixture", ci, test: { command: "bun test" } }, null, 2) + "\n",
  );
  return project;
}

function generate(label: string, ci: Record<string, unknown>): { yml: string; actions: string[] } {
  const project = plantProject(label, ci);
  const actions: string[] = [];
  createCiWorkflows(project, actions);
  return { yml: readFileSync(join(project, CI_REL), "utf-8"), actions };
}

const BASE_CI = { runner: "ubuntu-latest", bunVersion: "1.2.0", branches: ["main"] };

describe("AC-1: one declaration, and it is a pin", () => {
  test("ci.globalTools declares an exact version for every tool the compliance layer shells out to", () => {
    const config = tryLoadRungateConfig(REPO_ROOT) as { ci?: { globalTools?: Record<string, string> } } | null;
    const declared = config?.ci?.globalTools;
    expect(declared, "this repository's own config must declare ci.globalTools").toBeTruthy();

    for (const pkg of COMPLIANCE_TOOLS) {
      const version = declared?.[pkg];
      expect(typeof version, `ci.globalTools must declare ${pkg}`).toBe("string");
      // A range or a dist-tag is not a pin: it reintroduces #597 while looking
      // like the fix for it.
      expect(EXACT_VERSION.test(String(version)), `${pkg} is declared as ${version}, which is not an exact version`).toBe(
        true,
      );
    }
  });

  test("each declared version string has exactly one declaring position, and any generated copy agrees", () => {
    const config = tryLoadRungateConfig(REPO_ROOT) as { ci?: { globalTools?: Record<string, string> } } | null;
    const declared = config?.ci?.globalTools ?? {};
    const versions = COMPLIANCE_TOOLS.map(pkg => declared[pkg]).filter((v): v is string => typeof v === "string");
    // A battery over an empty list is perfect agreement. Refuse it.
    expect(versions.length, "nothing to count — the declaration is missing").toBe(COMPLIANCE_TOOLS.length);

    for (const version of versions) {
      const r = spawnSync("git", ["grep", "-nF", "--", version], { cwd: REPO_ROOT, encoding: "utf-8" });
      const hits = (r.stdout ?? "")
        .split("\n")
        .filter(l => l.trim() !== "")
        .map(l => l.slice(0, l.indexOf(":")));

      const declaringPositions = hits.filter(f => !f.startsWith(".github/workflows/"));
      expect(declaringPositions, `${version} is declared in more than one place`).toEqual([
        ".claude/rungate/config.json",
      ]);

      // The generated workflow is this declaration's OUTPUT, not a second
      // declaration — so a copy there is allowed, and is checked for drift
      // rather than forbidden.
      for (const generated of hits.filter(f => f.startsWith(".github/workflows/"))) {
        const text = readFileSync(join(REPO_ROOT, generated), "utf-8");
        const run = /^\s*npm install -g (.*)$/m.exec(text);
        expect(run, `${generated} names ${version} outside a global-install step`).not.toBeNull();
        expect(run?.[1], `${generated} has drifted from ci.globalTools`).toContain(version);
      }
    }
  });

  /**
   * The case above is a loop over the workflow files that mention the version,
   * so a tree where NO workflow mentions it runs the loop zero times and
   * agrees perfectly — the third shape in
   * `.claude/rules/checks-must-be-able-to-fail.md`, a filter over an extracted
   * set satisfied by extracting nothing. It passed on the tree that had the
   * #597 defect, which is the whole point of this file.
   *
   * It cannot be strengthened in place, because a copy in a workflow really is
   * optional for a consumer that declares no tools. What is NOT optional is
   * THIS repository's own `test` job, which is the job whose three Layer 1
   * checks flaked. So that is asserted directly, against the file CI reads.
   *
   * The checked-in copy is maintained BY HAND to match
   * `globalToolInstallStep`'s output, and this case is what notices when it
   * stops matching — because a re-scaffold cannot currently be relied on to
   * do it. `bun bin/rungate.ts scaffold .` on this tree reported
   * `UPDATED: .github/workflows/ci.yml (+3 lines)` and left the file
   * byte-identical to HEAD: `git status` showed nothing. Three lines is
   * exactly the install step, so the generator produced the right bytes and
   * the write did not land. That is #642, reproduced independently on two
   * other repositories.
   *
   * Which makes this case load-bearing in a second way: it is the thing that
   * catches a silent no-op for this file, where the scaffold's own report
   * cannot be trusted to.
   */
  test("this repository's own CI test job installs every compliance tool, pinned", () => {
    const yml = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf-8");
    const run = /^\s*npm install -g (.*)$/m.exec(yml);
    expect(run, ".github/workflows/ci.yml has no global-tool install step — CI will probe tools it never installed (#597)")
      .not.toBeNull();

    const config = tryLoadRungateConfig(REPO_ROOT) as { ci?: { globalTools?: Record<string, string> } } | null;
    const declared = config?.ci?.globalTools ?? {};
    for (const pkg of COMPLIANCE_TOOLS) {
      const version = declared[pkg];
      expect(typeof version, `ci.globalTools does not declare ${pkg}`).toBe("string");
      expect(run?.[1], `ci.yml does not install ${pkg} at the declared ${version}`).toContain(`'${pkg}@${version}'`);
    }

    // The install has to precede the step that probes, or it buys nothing.
    expect(yml.indexOf("npm install -g")).toBeLessThan(yml.indexOf("- run: bun test"));
  });
});

describe("AC-2/AC-3: the generator reads the declaration", () => {
  test("a planted config's unusual versions reach the install step, ahead of the test step", () => {
    const { yml } = generate("declared", { ...BASE_CI, globalTools: UNUSUAL_PINS });

    const steps = testJobSteps(yml);
    expect(steps.length, "the generated test job has no steps — the fixture never ran").toBeGreaterThan(3);

    const install = indexOfRun(steps, "npm install -g");
    expect(install, "no global-install step was emitted").toBeGreaterThanOrEqual(0);

    // Search the slice, not the document: the versions must be on the install
    // command itself, not anywhere in the file.
    const command = String(steps[install].run);
    for (const [pkg, version] of Object.entries(UNUSUAL_PINS)) {
      expect(command).toContain(`${pkg}@${version}`);
    }

    // Ahead of the test step, and after dependencies are installed.
    const deps = indexOfRun(steps, "bun install");
    const tests = steps.findIndex(s => s.run === "bun test");
    expect(tests, "the fixture's test step is missing").toBeGreaterThanOrEqual(0);
    expect(deps).toBeLessThan(install);
    expect(install).toBeLessThan(tests);
  });

  test("the install step does not become the project's test command", () => {
    // The cheapest wrong fix emits `- run: npm install -g ...`, which
    // `testCommandsNamedByCiWorkflow` (#621) reads as the test command,
    // silently breaking the three-position agreement check.
    const { yml } = generate("parity", { ...BASE_CI, globalTools: UNUSUAL_PINS });
    expect(yml).toContain("npm install -g");
    expect(testCommandsNamedByCiWorkflow(yml).map(c => c.command)).toEqual(["bun test"]);
  });
});

describe("AC-2b: an absent or unusable declaration is stated, not silent", () => {
  test("no ci.globalTools emits no install step and says why", () => {
    const { yml } = generate("absent", { ...BASE_CI });
    expect(indexOfRun(testJobSteps(yml), "npm install -g")).toBe(-1);
    expect(yml).toContain("# No global tools installed: the config declares no ci.globalTools.");
  });

  test("a moving tag is refused by name rather than installed unpinned", () => {
    const { yml } = generate("moving", { ...BASE_CI, globalTools: { agnix: "latest" } });
    expect(indexOfRun(testJobSteps(yml), "npm install -g")).toBe(-1);
    expect(yml).toContain("agnix@latest");
    expect(yml).toContain("not an exact version");
  });

  test("the decision reports the pins it resolved, and the ones it refused", () => {
    const pinned = globalToolInstallStep({ globalTools: UNUSUAL_PINS });
    expect(pinned.pins.map(p => p.package)).toEqual(COMPLIANCE_TOOLS);
    expect(pinned.rejected).toEqual([]);

    const refused = globalToolInstallStep({ globalTools: { "agnix": "^1.0.0" } });
    expect(refused.pins).toEqual([]);
    expect(refused.rejected.join(" ")).toContain("agnix@^1.0.0");
  });
});

/**
 * The mutation: the version dropped from the install spec, which is the
 * unpinned install that reintroduces #597.
 *
 * Declared as a literal rather than regex-built, so renaming or reshaping the
 * emitting expression ABORTS this file instead of quietly mutating nothing.
 */
const PIN_SIGNATURE = "`'${p.package}@${p.version}'`";
const UNPINNED = "`'${p.package}'` /* MUTANT: the version pin dropped */";

export function buildMutantSource(src: string, signature = PIN_SIGNATURE): string {
  const occurrences = src.split(signature).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `could not build the mutant: the pin-emitting expression appears ${occurrences} times, expected exactly 1. ` +
        `Either it moved, or a second site builds the install spec and removing one would leave the other pinning.`,
    );
  }
  const mutated = src.replace(signature, UNPINNED);
  const relocated = mutated.replace(/from "(\.\.?\/[^"]+)"/g, (_m, spec: string) => `from "${resolve(STEPS_DIR, spec)}"`);
  const leftover = relocated.match(/from "\.\.?\//g) || [];
  if (leftover.length > 0) {
    throw new Error(
      `could not build the mutant: ${leftover.length} relative import(s) were not rewritten; ` +
        `the mutant would die on module resolution and that non-zero exit reads as a refusal`,
    );
  }
  return relocated;
}

interface Run {
  ran: boolean;
  noThrow: boolean;
  actions: string[];
  yml: string;
}

/**
 * Run `createCiWorkflows` out of `modulePath` against a freshly planted
 * project and read the workflow back off disk.
 *
 * `ran` is not a formality: a module that fails to load produces no actions
 * and writes no file, which is indistinguishable from a generator that
 * decided to emit nothing — the exact thing the mutant is supposed to do with
 * the version and not with the step.
 */
function runGenerator(modulePath: string, label: string): Run {
  const project = plantProject(label, { ...BASE_CI, globalTools: UNUSUAL_PINS });
  const driver = join(SCRATCH, `driver-${label}.ts`);
  writeFileSync(
    driver,
    `import { createCiWorkflows } from ${JSON.stringify(modulePath)};\n` +
      `const actions: string[] = [];\n` +
      `try { createCiWorkflows(process.argv[2], actions); } catch (e) { actions.push("THREW: " + (e as Error).message); }\n` +
      `console.log("ACTIONS_JSON:" + JSON.stringify(actions));\n`,
  );

  const r = spawnSync("bun", [driver, project], { cwd: SCRATCH, encoding: "utf-8", timeout: 120000 });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const m = /ACTIONS_JSON:(.*)/.exec(output);
  const actions = m ? (JSON.parse(m[1]) as string[]) : [];
  return {
    ran: r.status === 0 && m !== null,
    noThrow: !actions.some(a => a.startsWith("THREW:")),
    actions,
    yml: m ? readFileSync(join(project, CI_REL), "utf-8") : "",
  };
}

describe("AC-4: the pin can be removed, and the removal is visible", () => {
  test("the real generator pins both tools; the mutant installs them unpinned", () => {
    const mutantPath = join(SCRATCH, "steps-mutant.ts");
    writeFileSync(mutantPath, buildMutantSource(readFileSync(STEPS, "utf-8")));

    const real = runGenerator(STEPS, "real");
    const mutant = runGenerator(mutantPath, "mutant");

    // Neither half may be read as a result unless it actually ran.
    expect(real.ran, real.actions.join("\n")).toBe(true);
    expect(real.noThrow, real.actions.join("\n")).toBe(true);
    expect(mutant.ran, mutant.actions.join("\n")).toBe(true);
    expect(mutant.noThrow, mutant.actions.join("\n")).toBe(true);

    const realCommand = String(testJobSteps(real.yml)[indexOfRun(testJobSteps(real.yml), "npm install -g")]?.run);
    const mutantSteps = testJobSteps(mutant.yml);
    const mutantInstall = indexOfRun(mutantSteps, "npm install -g");

    // The mutant still emits the STEP — this measures the pin, not the step.
    // A mutant that stopped emitting anything would be a broken mutant.
    expect(mutantInstall).toBeGreaterThanOrEqual(0);
    const mutantCommand = String(mutantSteps[mutantInstall].run);

    for (const [pkg, version] of Object.entries(UNUSUAL_PINS)) {
      expect(realCommand).toContain(`${pkg}@${version}`);
      expect(mutantCommand).toContain(pkg);
      expect(mutantCommand).not.toContain(version);
    }
  }, 180_000);

  test("a moved pin expression aborts the harness instead of mutating nothing", () => {
    expect(() => buildMutantSource(readFileSync(STEPS, "utf-8"), "`'${p.name}@${p.v}'`")).toThrow(/appears 0 times/);
  });

  test("a duplicated pin expression aborts the harness", () => {
    expect(() => buildMutantSource(readFileSync(STEPS, "utf-8") + `\nconst x = ${PIN_SIGNATURE};\n`)).toThrow(
      /appears 2 times/,
    );
  });

  test("the mutant carries no relative import the rewriter missed", () => {
    const mutant = buildMutantSource(readFileSync(STEPS, "utf-8"));
    expect(mutant.match(/from "\.\.?\//g)).toBeNull();
    expect(mutant).toContain("MUTANT: the version pin dropped");
  });
});

/**
 * The rejection path is the one that formats hostile input by definition.
 *
 * A declaration reaches a generated YAML COMMENT only when it was refused,
 * and it was refused precisely because it did not match the charsets the
 * accepted path is quoted for. So the branch whose whole job is to refuse an
 * unsafe declaration was, before `commentSafe`, the branch that emitted it
 * verbatim — a newline ends the comment and the next line is a step.
 *
 * Run rather than argued: each case below produced a real, runnable step in
 * the generated `ci.yml`. The third is the one a fix aimed only at the
 * "everything was refused" branch would miss, because one valid pin sends
 * the refusals string through the SUCCESS path instead.
 */
describe("AC-5: a refused declaration cannot write YAML of its own", () => {
  const INJECTIONS: Array<{ label: string; tools: Record<string, string>; marker: string }> = [
    {
      label: "through the package name",
      tools: { "pwned\n      - name: Injected step\n        run: echo INJECTED": "1.0.0" },
      marker: "INJECTED",
    },
    {
      label: "through the version",
      tools: { agnix: "1.0.0\n      - run: echo VIA_VERSION" },
      marker: "VIA_VERSION",
    },
    {
      // The version here is a stand-in, not the declared one: this file must
      // not become a second position naming a real pin, which the
      // one-declaring-position case above would (correctly) refuse.
      label: "through the success path, alongside one valid pin",
      tools: { agnix: "9.9.9", "@reporails/cli": "x\n      - run: echo MIXED" },
      marker: "MIXED",
    },
    {
      label: "through a bare carriage return",
      tools: { "a\r      - run: echo CR": "1.0.0" },
      marker: "CR",
    },
  ];

  for (const { label, tools, marker } of INJECTIONS) {
    test(`a hostile declaration ${label} stays inside the comment`, () => {
      const step = globalToolInstallStep({ globalTools: tools }).step;

      // The control: if the hostile text never reached the output at all,
      // every assertion below passes for a reason that is not the fix.
      expect(step, "the refused entry was not reported at all").toContain(marker);

      // The skeleton is DERIVED from a benign generation rather than listed
      // here: every line the step emits except the install command itself is
      // fixed prose with no interpolation, so a hostile declaration can only
      // ever reach the one line that carries declared values. Deriving it
      // means a line added to the step later is still checked — an allowlist
      // written out by hand would have to be widened to keep this green, and
      // widening it is indistinguishable from letting an injection through.
      const skeleton = new Set(
        globalToolInstallStep({ globalTools: { agnix: "9.9.9" } })
          .step.split("\n")
          .map(l => l.trim())
          .filter(l => l !== "" && !l.startsWith("#") && !l.startsWith("npm install -g ")),
      );
      expect(skeleton.size, "the benign step produced no fixed lines, so this case compares nothing").toBeGreaterThan(0);

      for (const line of step.split("\n")) {
        if (line.trim() === "") continue;
        expect(
          line.trim().startsWith("#") || skeleton.has(line.trim()) || /^\s+npm install -g /.test(line),
          `line escaped the comment: ${JSON.stringify(line)}`,
        ).toBe(true);
      }
    });
  }

  test("the sanitiser is not load-bearing for the accepted path", () => {
    // Stated so a later reader does not relax the charset check believing
    // `commentSafe` covers it. It does not: accepted values never pass
    // through it, and are defended by the regex and the single quotes.
    const good = globalToolInstallStep({ globalTools: { agnix: "9.9.9" } });
    expect(good.rejected).toEqual([]);
    expect(good.step).toContain("npm install -g 'agnix@9.9.9'");
  });
});

/**
 * AC-6 — a registry or CDN outage is UNMEASURED, not a red build and not a
 * silent pass.
 *
 * ## What happened, and why a warning is the honest reading
 *
 * On 2026-11-08 `agnix`'s postinstall binary download returned HTTP 504 for
 * several hours. The npm REGISTRY was fine — `GET /agnix` answered 200 — so
 * nothing about the pin, the lockfile or this repository was wrong; the
 * platform binary's host was down. `npm install -g` exited 1, the step had no
 * handling for that, and every `test-shard` leg died before running a single
 * test. Measured across two unrelated pull requests, #1894 and #1900: five
 * shards, five identical `Failed to install agnix: Download failed with status
 * 504`. **For those hours no change could merge in this repository**, including
 * a two-literal state correction, because `test` is a required check.
 *
 * The tools are not what the suite measures. `lib/compliance.ts` probes each
 * one with `--version` and returns `reading: "UNMEASURED"` naming the tools it
 * could not reach, so a runner without them already reports the three Layer 1
 * checks as unmeasured rather than passed. The install step was the only part
 * of the pipeline that treated a missing tool as fatal, and it was fatal to
 * the whole suite rather than to the checks that need it.
 *
 * ## The cheapest wrong fix, named
 *
 * `npm install -g ... || true`. It clears the symptom and produces exactly the
 * *Silent Default Substitution* `.claude/rules/config-access.md` forbids: a
 * green step, no annotation, and nothing in the log that distinguishes "the
 * tools are here" from "the tools are absent and three checks measured
 * nothing". The case below that catches it is `a failed install still says so`
 * — the status is 0 AND an annotation naming UNMEASURED must be on stdout.
 * `|| true` passes the first half and fails the second.
 *
 * ## Why the body is EXECUTED here rather than pattern-matched
 *
 * The step is shell, and the thing being asserted is what the shell DOES with
 * a non-zero npm. A `toContain("::warning")` would pass over a body whose
 * `if` can never be reached. Each case below runs the emitted body under
 * `/bin/bash` against a stub `npm` on `PATH` whose exit code the case chooses,
 * and the stub echoes a marker that every case asserts — so a body that never
 * invokes npm cannot pass vacuously.
 */
describe("AC-6: a failed global-tool install is UNMEASURED, not fatal and not silent", () => {
  const NPM_MARKER = "STUB-NPM-INVOKED";

  /** The emitted `run:` body for a project declaring the unusual pins. */
  function installBody(): string {
    const { yml } = generate("unmeasured", { ...BASE_CI, globalTools: UNUSUAL_PINS });
    const steps = testJobSteps(yml);
    const at = indexOfRun(steps, "npm install -g");
    expect(at, "no global-install step was emitted, so there is no body to run").toBeGreaterThanOrEqual(0);
    return String(steps[at].run);
  }

  interface Outcome {
    status: number | null;
    out: string;
  }

  /**
   * Run `body` with a stub `npm` that exits `npmExit`.
   *
   * `require` is the value of the consumer's switch, passed the way the
   * workflow passes it — as an environment variable on the step, never as an
   * `if:` condition, because a step skipped by `if:` reports SKIPPED and a
   * skipped required check reads as satisfied (`.claude/rules/config-access.md`).
   */
  function exec(body: string, opts: { npmExit: number; require?: string }): Outcome {
    const dir = mkdtempSync(join(tmpdir(), "global-tools-exec-"));
    try {
      const stub = join(dir, "npm");
      writeFileSync(stub, `#!/bin/sh\necho "${NPM_MARKER} $*"\nexit ${opts.npmExit}\n`, { mode: 0o755 });
      const script = join(dir, "step.sh");
      writeFileSync(script, body);
      const env: Record<string, string> = {
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        HOME: process.env.HOME ?? dir,
      };
      if (opts.require !== undefined) env.RUNGATE_REQUIRE_GLOBAL_TOOLS = opts.require;
      // `-e` is how Actions invokes a `run:` block, so a body that relies on
      // the shell continuing past a non-zero command fails here exactly as it
      // would on a runner (`.claude/rules/checks-must-be-able-to-fail.md`).
      const r = spawnSync("/bin/bash", ["-e", script], { encoding: "utf-8", env, timeout: 60000 });
      return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a successful install exits 0 and annotates nothing", () => {
    const r = exec(installBody(), { npmExit: 0 });
    expect(r.out, "the stub npm was never invoked, so this case measured nothing").toContain(NPM_MARKER);
    expect(r.status).toBe(0);
    expect(r.out).not.toContain("::warning");
    expect(r.out).not.toContain("::error");
  });

  test("a failed install still says so — the step is green, the annotation is not", () => {
    const r = exec(installBody(), { npmExit: 1 });
    expect(r.out, "the stub npm was never invoked, so this case measured nothing").toContain(NPM_MARKER);
    // Green, so one unreachable CDN cannot stop every merge in the repository.
    expect(r.status, "a third-party outage must not fail the suite").toBe(0);
    // And loud, so it is never mistaken for a tree that has the tools. This
    // half is what `|| true` cannot satisfy.
    expect(r.out).toContain("::warning");
    expect(r.out).toContain("UNMEASURED");
  });

  test("the warning names the switch that makes it fatal, so the default is a choice a reader can change", () => {
    const r = exec(installBody(), { npmExit: 7 });
    expect(r.out).toContain("RUNGATE_REQUIRE_GLOBAL_TOOLS");
    // The exit code is reported rather than swallowed: 7 is not 1, and a
    // message that cannot tell them apart cannot be acted on.
    expect(r.out).toContain("7");
  });

  test("a consumer that declares the tools required gets a red step instead", () => {
    const r = exec(installBody(), { npmExit: 1, require: "true" });
    expect(r.out, "the stub npm was never invoked, so this case measured nothing").toContain(NPM_MARKER);
    expect(r.status).toBe(1);
    expect(r.out).toContain("::error");
  });

  /**
   * The switch is read EXACTLY, for the reason `config-access.md` gives: a
   * loose reading of a variable that turns a gate on is a gate that turns
   * itself on by accident. These are the spellings a `[ -n "$VAR" ]` or a
   * case-insensitive compare would wrongly accept.
   */
  for (const spelling of ["TRUE", "True", "1", "yes", "true ", "truthy"]) {
    test(`RUNGATE_REQUIRE_GLOBAL_TOOLS=${JSON.stringify(spelling)} is not the string "true" and does not arm the refusal`, () => {
      const r = exec(installBody(), { npmExit: 1, require: spelling });
      expect(r.status, `${JSON.stringify(spelling)} armed a gate that only "true" may arm`).toBe(0);
      expect(r.out).toContain("::warning");
    });
  }

  test("the pin survives the change — this is still the step that installs declared versions", () => {
    const body = installBody();
    for (const [pkg, version] of Object.entries(UNUSUAL_PINS)) {
      expect(body, "the UNMEASURED handling must not have cost the pin").toContain(`'${pkg}@${version}'`);
    }
  });

  test("the refusal's exit code has exactly one declaring position", () => {
    // One site to mutate. A second literal would let a later branch refuse
    // without going through the constant, and the mutation above would leave
    // that branch refusing while reading as covered.
    const src = readFileSync(STEPS, "utf-8");
    const declarations = src.match(/^export const GLOBAL_TOOLS_REQUIRED_EXIT = \d+;$/gm) ?? [];
    expect(declarations.length, "GLOBAL_TOOLS_REQUIRED_EXIT must be declared exactly once").toBe(1);
  });
});
