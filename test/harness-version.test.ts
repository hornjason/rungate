/**
 * #2501: the version every generated `bunx rungate@` pin carries is read or
 * refused, never written empty.
 *
 * `harnessVersion()` used to swallow an unreadable `package.json` and return
 * "", and its 13 callers wrote that into every generated workflow as
 * `bunx rungate@ <command>`. Scaffold reported success, and the first sign was
 * a confusing bunx error in a consumer's CI (raised on #2500).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { readHarnessVersion } from "../lib/scaffold/steps";

const ROOT = join(import.meta.dir, "..");
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
