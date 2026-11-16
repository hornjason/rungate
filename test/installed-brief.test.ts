/**
 * #1194 / SC-2768: a brief assembled from the INSTALLED package.
 *
 * `CLOSURE-1`, `CLOSURE-8` and `CLOSURE-14` prove the files are in the
 * tarball and that the paths resolve statically. None of them executes the
 * assembler from an installed tree, and #446 recorded what that misses: the
 * suites resolve those paths against the repository, where they exist.
 *
 * So this packs the real tarball, extracts it into a scratch directory,
 * installs its runtime dependencies there, and runs `assembleBrief` from the
 * installed copy. Two controls make the positive case mean something:
 *
 * - the installed `config/brief-policies.json` is changed to require a marker
 *   no brief carries, and the same brief then fails — so it is that file the
 *   assembler read, not the repository's copy or a hardcoded fallback;
 * - `gates/` is removed, the shape `rungate@0.8.0` shipped, and the reading
 *   is then not MEASURED — the same test fails against a tree without it.
 *
 * Never skips: a pack or install that fails throws, and the case goes red.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
/**
 * Every child gets a timeout. `spawnSync` blocks the thread, so a test-runner
 * timeout cannot fire while a wedged `npm`, `tar` or `bun` holds it; only the
 * child's own timeout turns a hang into a failure (review, PR #2281). The
 * setup hook's own budget is the sum of its three, plus room, so a slow step
 * fails with its own error rather than a generic hook timeout.
 */
const CHILD_TIMEOUT_MS = 60_000;
const SETUP_TIMEOUT_MS = 3 * CHILD_TIMEOUT_MS + 30_000;
let scratch = "";
let pkg = "";

type Reading = { status: "MEASURED"; validated: boolean; brief: string } | { status: "UNMEASURED"; reason: string };

/** A child's output, whatever `spawnSync` left: null when it was killed or never spawned. */
const said = (r: { stdout: unknown; stderr: unknown; error?: Error }) =>
  [r.error?.message, r.stderr, r.stdout].map(v => (v == null ? "" : String(v).trim())).filter(Boolean).join(" | ").slice(0, 400);

/**
 * Assemble a brief from the package installed at `pkgDir`, in an isolated child.
 *
 * Isolated by construction rather than leak by leak (review round 6, PR
 * #2281): the child gets a MINIMAL environment — PATH to find `bun`, an empty
 * HOME so the local override at ~/.claude/skills/ship cannot be what passes,
 * and TMPDIR — never a copy of the parent's. Its answer goes to a result file
 * it is handed, not to stdout, so nothing else it prints can be mistaken for
 * the answer.
 */
function installedBrief(pkgDir: string): Reading {
  const run = mkdtempSync(join(scratch, "run-"));
  const work = join(run, "work");
  const proj = join(run, "proj");
  const home = join(run, "home");
  for (const d of [work, proj, home]) mkdirSync(d);
  writeFileSync(
    join(work, "workflow-state.json"),
    JSON.stringify({ issue: 1, issueGoal: "Make the thing work", acs: [{ id: "AC-1", statement: "the installed brief carries this AC", evidenceMethod: { type: "test", command: "bun test test/installed-marker.test.ts" } }] }),
  );
  const result = join(run, "result.json");
  const runner = join(run, "assemble.ts");
  writeFileSync(
    runner,
    `import { writeFileSync } from "fs";\n` +
      `const { assembleBrief } = await import(${JSON.stringify(join(pkgDir, "gates", "brief-assembler.ts"))});\n` +
      `writeFileSync(${JSON.stringify(result)}, JSON.stringify(await assembleBrief({ slug: "s", workDir: ${JSON.stringify(work)}, projectRoot: ${JSON.stringify(proj)} })));\n`,
  );
  const env = { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: tmpdir() };
  const r = spawnSync("bun", [runner], { cwd: run, env, encoding: "utf-8", timeout: CHILD_TIMEOUT_MS, killSignal: "SIGKILL" });
  if (r.status !== 0) return { status: "UNMEASURED", reason: `assembleBrief did not run (exit ${r.status}): ${said(r)}` };
  let out: { validated?: unknown; briefPath?: unknown };
  try {
    out = JSON.parse(readFileSync(result, "utf-8"));
  } catch (e) {
    return { status: "UNMEASURED", reason: `the runner wrote no readable result: ${(e as Error).message}; ${said(r)}` };
  }
  if (typeof out.validated !== "boolean" || typeof out.briefPath !== "string") {
    return { status: "UNMEASURED", reason: `the result holds no { validated, briefPath }: ${JSON.stringify(out).slice(0, 300)}` };
  }
  return { status: "MEASURED", validated: out.validated, brief: readFileSync(out.briefPath, "utf-8") };
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "rungate-1194-"));
  const packed = spawnSync("npm", ["pack", "--silent", "--pack-destination", scratch], { cwd: ROOT, encoding: "utf-8", timeout: CHILD_TIMEOUT_MS, killSignal: "SIGKILL" });
  if (packed.status !== 0) throw new Error(`npm pack failed: ${said(packed)}`);
  const tgz = readdirSync(scratch).find(f => f.endsWith(".tgz"));
  if (!tgz) throw new Error(`npm pack wrote no tarball into ${scratch}`);
  const unpacked = join(scratch, "unpacked");
  mkdirSync(unpacked);
  const tar = spawnSync("tar", ["-xzf", join(scratch, tgz), "-C", unpacked], { encoding: "utf-8", timeout: CHILD_TIMEOUT_MS, killSignal: "SIGKILL" });
  if (tar.status !== 0) throw new Error(`tar failed: ${said(tar)}`);
  pkg = join(unpacked, "package");
  // A cache of its own. With the shared one, this fresh resolution changed what
  // Bun's auto-install later resolved for test/local-review-loop.test.ts's
  // sandbox in the same CI shard — "ENOENT while resolving package 'zod'" on
  // every loop turn (diagnosed on PR #2284). A consumer install should not
  // reach into anyone else's cache anyway.
  const installed = spawnSync("bun", ["install", "--production", "--silent"], {
    cwd: pkg,
    encoding: "utf-8",
    timeout: CHILD_TIMEOUT_MS,
    killSignal: "SIGKILL",
    env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(scratch, "bun-cache") },
  });
  if (installed.status !== 0) throw new Error(`bun install in the unpacked package failed: ${said(installed)}`);
}, SETUP_TIMEOUT_MS);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("#1194 / SC-2768: a brief assembled from the installed package", () => {
  test("validates against the packaged config/brief-policies.json", () => {
    expect(existsSync(join(pkg, "config", "brief-policies.json"))).toBe(true);
    const r = installedBrief(pkg);
    expect(r.status).toBe("MEASURED");
    if (r.status !== "MEASURED") return;
    expect(r.validated).toBe(true);
    expect(r.brief).toContain("Make the thing work");
    // The AC and its verify command reach the brief — the policy patterns
    // match static headings, so only these two prove AC data flowed (review, #2281).
    expect(r.brief).toContain("the installed brief carries this AC");
    expect(r.brief).toContain("bun test test/installed-marker.test.ts");
  }, 60_000);

  test("it is the PACKAGED policy file that decides: require a marker no brief has, and the same brief fails", () => {
    const path = join(pkg, "config", "brief-policies.json");
    const original = readFileSync(path, "utf-8");
    try {
      const policies = JSON.parse(original);
      policies.policies.marcus.requiredPatterns.push({ name: "Marker", pattern: "ZZ-MARKER-NO-BRIEF-CARRIES", description: "control" });
      writeFileSync(path, JSON.stringify(policies));
      const r = installedBrief(pkg);
      expect(r.status).toBe("MEASURED");
      if (r.status !== "MEASURED") return;
      expect(r.validated).toBe(false);
    } finally {
      writeFileSync(path, original);
    }
  }, 60_000);

  test("the same test fails against a tree without gates/ (the 0.8.0 shape)", () => {
    const gates = join(pkg, "gates");
    const away = join(pkg, "gates.removed");
    renameSync(gates, away);
    try {
      const r = installedBrief(pkg);
      expect(r.status).toBe("UNMEASURED");
      if (r.status === "UNMEASURED") expect(r.reason).toContain("brief-assembler");
    } finally {
      renameSync(away, gates);
    }
  }, 60_000);
});
