/**
 * Covers SC-2812 (SCAFFOLD-DECOMPOSITION-SPEC.md): rungate publishes a
 * feature-manifest schema, and its validator refuses a manifest that names a
 * file, page or route the tree does not hold (ADR-028, #2888).
 *
 * Every case runs one valid manifest with one thing changed, so a refusal can
 * only come from that change, and asserts the reason the validator gives, not
 * just its verdict: a refused manifest is refused for many reasons, and a
 * case that checked only `verdict` would pass on the wrong one.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  FEATURE_MANIFEST_VERSION,
  featureManifestSchema,
  treeReading,
  validateManifest,
  validateManifestText,
  type FileReading,
  type TreeReading,
} from "../lib/feature-manifest";

const scratch = mkdtempSync(join(tmpdir(), "rungate-2888-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const FILES: Record<string, FileReading> = {
  "src/cases.ts": { kind: "file" },
  "src/shared/db.ts": { kind: "file" },
  "src/pages": { kind: "other" },
  "src/locked.ts": { kind: "unread", why: "EACCES" },
};

const tree = (over: Partial<TreeReading> = {}): TreeReading => ({
  fileAt: rel => FILES[rel] ?? { kind: "absent" },
  pages: new Set(["/cases", "/home"]),
  routes: new Set(["GET /api/cases", "POST /api/cases"]),
  ...over,
});

const manifest = () => ({
  schema: FEATURE_MANIFEST_VERSION,
  generatedBy: "bun scripts/feature-manifest.ts",
  features: [
    {
      name: "cases",
      summary: "Shows each account's open support cases.",
      entryFiles: ["src/cases.ts"],
      pages: ["/cases"],
      routes: ["GET /api/cases"],
      sources: ["case-api"],
    },
  ],
  sources: [{ name: "case-api", kind: "http" }],
  consumers: [{ name: "dashboard", uses: ["cases"] }],
  shared: { files: ["src/shared/db.ts"], pages: ["/home"], routes: [] as string[] },
});

type M = ReturnType<typeof manifest>;
const refusalsOf = (m: unknown, t: TreeReading = tree()) => {
  const v = validateManifest(m, t);
  return v.verdict === "refused" ? v.refusals : [];
};
const edit = (f: (m: M) => void) => {
  const m = manifest();
  f(m);
  return m;
};

describe("#2888: the schema", () => {
  test("a complete manifest whose every name is in the tree is valid", () => {
    expect(validateManifest(manifest(), tree())).toEqual({ verdict: "valid", manifest: featureManifestSchema.parse(manifest()) });
  });

  test("optional sections default to empty, so a minimal manifest is valid", () => {
    const minimal = { schema: FEATURE_MANIFEST_VERSION, generatedBy: "x", features: [{ name: "cases", summary: "s", entryFiles: ["src/cases.ts"] }] };
    expect(validateManifest(minimal, tree()).verdict).toBe("valid");
  });

  test("a key this version does not define is refused, never ignored", () => {
    expect(refusalsOf({ ...manifest(), extra: 1 })).toEqual([expect.stringContaining("extra")]);
    expect(refusalsOf(edit(m => Object.assign(m.features[0], { entryfiles: [] })))).toEqual([expect.stringContaining("entryfiles")]);
  });

  test("a wrong schema version, no features, or a feature with no entry file is refused", () => {
    expect(refusalsOf({ ...manifest(), schema: "rungate.feature-manifest/v2" })).toEqual([expect.stringMatching(/^schema:/)]);
    expect(refusalsOf({ ...manifest(), features: [] })).toEqual([expect.stringMatching(/^features:/)]);
    expect(refusalsOf(edit(m => (m.features[0].entryFiles = [])))).toEqual([expect.stringMatching(/^features\.0\.entryFiles:/)]);
  });

  test("a route must be a method and a path", () => {
    expect(refusalsOf(edit(m => (m.features[0].routes = ["/api/cases"])))).toEqual([expect.stringContaining("a route is an upper-case method, one space, and a path")]);
  });
});

describe("#2888: names that do not agree with each other", () => {
  test("a feature declared twice is refused", () => {
    expect(refusalsOf(edit(m => m.features.push({ ...m.features[0] })))).toEqual(["feature 'cases' is declared more than once"]);
  });

  test("a feature's source must be declared, and a consumer must use a feature", () => {
    expect(refusalsOf(edit(m => (m.features[0].sources = ["feed"])))).toEqual(["feature 'cases' names source 'feed', which the manifest does not declare"]);
    expect(refusalsOf(edit(m => (m.consumers[0].uses = ["campaigns"])))).toEqual(["consumer 'dashboard' uses 'campaigns', which is not a feature"]);
  });
});

describe("#2888: names the tree does not hold are refused", () => {
  test("a file the tree does not hold, in a feature or in shared", () => {
    expect(refusalsOf(edit(m => (m.features[0].entryFiles = ["src/gone.ts"])))).toEqual(["feature 'cases' names 'src/gone.ts', which the tree does not hold"]);
    expect(refusalsOf(edit(m => (m.shared.files = ["src/gone.ts"])))).toEqual(["shared names 'src/gone.ts', which the tree does not hold"]);
  });

  test("something at the name that is not a file", () => {
    expect(refusalsOf(edit(m => (m.features[0].entryFiles = ["src/pages"])))).toEqual(["feature 'cases' names 'src/pages', which is not a file"]);
  });

  test("a page or a route the tree does not hold", () => {
    expect(refusalsOf(edit(m => (m.features[0].pages = ["/gone"])))).toEqual(["feature 'cases' names page '/gone', which the tree does not hold"]);
    expect(refusalsOf(edit(m => (m.features[0].routes = ["DELETE /api/cases"])))).toEqual(["feature 'cases' names route 'DELETE /api/cases', which the tree does not hold"]);
    expect(refusalsOf(edit(m => (m.shared.pages = ["/gone"])))).toEqual(["shared names page '/gone', which the tree does not hold"]);
  });

  test("a path that cannot name a file in the tree is refused before it is looked up", () => {
    const looked: string[] = [];
    const watching = tree({ fileAt: rel => (looked.push(rel), FILES[rel] ?? { kind: "absent" }) });
    for (const [bad, why] of [
      ["/src/cases.ts", "is absolute; paths are written from the repository root"],
      ["../src/cases.ts", "leaves the repository"],
      ["src\\cases.ts", "uses a backslash; paths are written with '/'"],
      ["./src/cases.ts", "is not written plainly; write it as 'src/cases.ts'"],
      ["src//cases.ts", "is not written plainly; write it as 'src/cases.ts'"],
      ["src/x/../cases.ts", "is not written plainly; write it as 'src/cases.ts'"],
      ["src/", "is not written plainly; write it as 'src'"],
    ]) {
      expect(refusalsOf(edit(m => (m.features[0].entryFiles = [bad])), watching)).toEqual([`feature 'cases' file '${bad}' ${why}`]);
    }
    // Only the manifest's other file, the shared one, is ever looked up.
    expect([...new Set(looked)], "a path refused for its spelling was still looked up").toEqual(["src/shared/db.ts"]);
  });

  test("every reason is listed, not only the first", () => {
    const m = edit(m => {
      m.features[0].entryFiles = ["src/gone.ts"];
      m.features[0].pages = ["/gone"];
      m.consumers[0].uses = ["campaigns"];
    });
    expect(refusalsOf(m)).toHaveLength(3);
  });
});

describe("#2888: what could not be checked is unmeasured, never valid", () => {
  test("a file that could not be read is named, with why", () => {
    const v = validateManifest(edit(m => (m.features[0].entryFiles = ["src/locked.ts"])), tree());
    expect(v).toMatchObject({ verdict: "unmeasured", unmeasured: ["feature 'cases' file 'src/locked.ts' could not be read (EACCES)"] });
  });

  test("pages or routes with no reading of the tree's own are unmeasured, counted", () => {
    expect(validateManifest(manifest(), tree({ pages: undefined }))).toMatchObject({
      verdict: "unmeasured",
      unmeasured: ["2 page(s) not checked: no reading of the tree's pages was supplied"],
    });
    expect(validateManifest(manifest(), tree({ routes: undefined }))).toMatchObject({
      verdict: "unmeasured",
      unmeasured: ["1 route(s) not checked: no reading of the tree's routes was supplied"],
    });
  });

  test("CONTROL: a manifest naming no pages needs no page reading", () => {
    const m = edit(m => {
      m.features[0].pages = [];
      m.shared.pages = [];
    });
    expect(validateManifest(m, tree({ pages: undefined })).verdict).toBe("valid");
  });

  test("an empty page reading is a reading: a page named against it is refused", () => {
    expect(refusalsOf(manifest(), tree({ pages: new Set() }))).toEqual([
      "feature 'cases' names page '/cases', which the tree does not hold",
      "shared names page '/home', which the tree does not hold",
    ]);
  });

  test("a refusal is not hidden by something unmeasured beside it", () => {
    const v = validateManifest(edit(m => (m.features[0].entryFiles = ["src/gone.ts", "src/locked.ts"])), tree());
    expect(v).toEqual({
      verdict: "refused",
      refusals: ["feature 'cases' names 'src/gone.ts', which the tree does not hold"],
      unmeasured: ["feature 'cases' file 'src/locked.ts' could not be read (EACCES)"],
    });
  });
});

describe("#2888: from the manifest file's text", () => {
  test("text that is not JSON is refused, naming the parser's reason", () => {
    expect(validateManifestText("{ not json", tree())).toMatchObject({ verdict: "refused", refusals: [expect.stringMatching(/^the manifest is not JSON: /)] });
  });

  test("a byte-order mark, CRLF line endings and tabs read as the same manifest", () => {
    const text = JSON.stringify(manifest(), null, "\t").replace(/\n/g, "\r\n");
    expect(validateManifestText(`﻿${text}`, tree()).verdict).toBe("valid");
  });

  test("a name in any script is a name", () => {
    expect(validateManifest(edit(m => (m.consumers[0].name = "tableau-café")), tree()).verdict).toBe("valid");
  });
});

describe("#2888: against a real tree, read through the presence decider", () => {
  const root = mkdtempSync(join(scratch, "tree-"));
  mkdirSync(join(root, "src", "shared"), { recursive: true });
  mkdirSync(join(root, "src", "pages"));
  writeFileSync(join(root, "src", "cases.ts"), "export {};\n");
  writeFileSync(join(root, "src", "shared", "db.ts"), "export {};\n");
  symlinkSync(join(root, "nowhere.ts"), join(root, "src", "dangling.ts"));
  const fifo = spawnSync("mkfifo", [join(root, "src", "pipe.ts")]);
  const real = treeReading(root, { pages: ["/cases", "/home"], routes: ["GET /api/cases"] });

  test("each kind of thing at a name gets its own reading", () => {
    expect(real.fileAt("src/cases.ts")).toEqual({ kind: "file" });
    expect(real.fileAt("src/gone.ts")).toEqual({ kind: "absent" });
    expect(real.fileAt("src/pages")).toEqual({ kind: "other" });
    expect(real.fileAt("src/dangling.ts")).toEqual({ kind: "unread", why: "ENOENT" });
    if (fifo.status === 0) expect(real.fileAt("src/pipe.ts")).toEqual({ kind: "other" });
  });

  test("the sample manifest is valid against it, and a missing file is refused", () => {
    expect(validateManifest(manifest(), real).verdict).toBe("valid");
    expect(refusalsOf(edit(m => (m.features[0].entryFiles = ["src/gone.ts"])), real)).toEqual(["feature 'cases' names 'src/gone.ts', which the tree does not hold"]);
  });

  test("with no pages or routes read, the reader supplies no reading, so they are unmeasured", () => {
    expect(validateManifest(manifest(), treeReading(root)).verdict).toBe("unmeasured");
  });
});
