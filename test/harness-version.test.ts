/**
 * #2501: the version every generated `bunx rungate@` pin carries is read or
 * refused, never written empty.
 *
 * `harnessVersion()` used to swallow an unreadable `package.json` and return
 * "", and its callers wrote that into every generated workflow as
 * `bunx rungate@ <command>`. Scaffold reported success, and the first sign was
 * a confusing bunx error in a consumer's CI (raised on #2500).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";

import { readHarnessVersion } from "../lib/scaffold/steps";

const ROOT = join(import.meta.dir, "..");
const STEPS = join(ROOT, "lib", "scaffold", "steps.ts");
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
function root(manifest: string | null): string {
  const d = mkdtempSync(join(tmpdir(), "harness-version-"));
  made.push(d);
  if (manifest !== null) writeFileSync(join(d, "package.json"), manifest);
  return d;
}

describe("#2501: readHarnessVersion", () => {
  test("a readable manifest gives its version", () => {
    expect(readHarnessVersion(root('{"name":"rungate","version":"9.8.7"}'))).toBe("9.8.7");
  });

  test("a missing, unparseable, versionless or non-string-version manifest throws, naming the path", () => {
    for (const manifest of [null, '{"name":"rungate","version":', '{"name":"rungate"}', '{"version":3}', '{"version":""}']) {
      const dir = root(manifest);
      expect(() => readHarnessVersion(dir), String(manifest)).toThrow(join(dir, "package.json"));
    }
  });

  test("this repository's own manifest reads", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
    expect(readHarnessVersion(ROOT)).toBe(pkg.version);
  });

  // Review of #2502: every reader of the generating version goes through the
  // one that refuses. A copy of steps.ts is placed where it reads a manifest
  // we control, then run against a fresh project.
  test("a placed copy with no manifest above it refuses at every reader; with one, it reads it", () => {
    const placed = (manifest: string | null) => {
      const scratch = root(manifest);
      const copy = join(scratch, "lib", "scaffold", "steps-copy.ts");
      mkdirSync(dirname(copy), { recursive: true });
      const relocated = readFileSync(STEPS, "utf8").replace(
        /from "(\.\.?\/[^"]+)"/g,
        (_m, spec: string) => `from "${resolve(dirname(STEPS), spec)}"`,
      );
      // A relative import left behind would fail to load, and a load failure
      // reads exactly like a refusal on the merits.
      expect(relocated.match(/from "\.\.?\//g) ?? []).toEqual([]);
      writeFileSync(copy, relocated);
      const project = join(scratch, "project");
      mkdirSync(project);
      const driver = join(scratch, "driver.ts");
      writeFileSync(
        driver,
        `import { generateOrAuditProjectHarness, harnessDevDepRange } from ${JSON.stringify(copy)};\n` +
          `const out: Record<string, string> = {};\n` +
          `const actions: string[] = [];\n` +
          `try { generateOrAuditProjectHarness(process.argv[2], actions); out.config = "wrote"; } catch (e) { out.config = "THREW: " + (e as Error).message; }\n` +
          `try { out.range = harnessDevDepRange(); } catch (e) { out.range = "THREW: " + (e as Error).message; }\n` +
          `out.unparseable = harnessDevDepRange("not-a-version");\n` +
          `console.log("OUT_JSON:" + JSON.stringify(out));\n`,
      );
      const r = spawnSync("bun", [driver, project], { cwd: scratch, encoding: "utf8", timeout: 120000 });
      const m = /OUT_JSON:(.*)/.exec(`${r.stdout}${r.stderr}`);
      expect(m, `${r.stdout}${r.stderr}`).not.toBeNull();
      const configPath = join(project, ".claude", "rungate", "config.json");
      return {
        manifest: join(scratch, "package.json"),
        out: JSON.parse(m![1]) as Record<string, string>,
        written: existsSync(configPath) ? (JSON.parse(readFileSync(configPath, "utf8")) as { harnessVersion?: string }) : null,
      };
    };

    const none = placed(null);
    expect(none.out.config).toStartWith("THREW: ");
    expect(none.out.config).toContain(none.manifest);
    expect(none.written?.harnessVersion ?? null).toBeNull();
    expect(none.out.range).toStartWith("THREW: ");
    expect(none.out.range).toContain(none.manifest);
    // A version STRING that does not parse still gets the documented fallback.
    expect(none.out.unparseable).toBe("^0.2.0");

    const good = placed('{"name":"rungate","version":"9.8.7"}');
    expect(good.out.config).toBe("wrote");
    expect(good.written?.harnessVersion).toBe("9.8.7");
    expect(good.out.range).toBe("^9.8.0");
  });

  test("no generated workflow in this repository carries an empty bunx rungate@ pin", () => {
    const dir = join(ROOT, ".github/workflows");
    const empty = readdirSync(dir)
      .filter(f => f.endsWith(".yml"))
      // An empty pin is `bunx rungate@` followed by nothing, on a line that runs.
      // A comment showing `bunx rungate@<version>` as a placeholder is not one.
      .filter(f => /^(?!\s*#).*bunx rungate@(?:\s|$)/m.test(readFileSync(join(dir, f), "utf8")));
    expect(empty).toEqual([]);
  });
});
