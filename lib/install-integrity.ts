/**
 * Whether this rungate install can load its own dependencies — #2479.
 *
 * A version-pinned `bunx rungate@<v>` installs into one shared temporary
 * directory per version, so agents starting it at the same moment can find
 * that directory half-written. The command then dies inside a script on
 * `Cannot find package 'zod'` (or `@octokit/rest`), naming a temp path, and
 * nothing in the message says what happened or what to do. `bin/rungate.ts`
 * asks this module first and says so in words instead.
 *
 * It imports node builtins only, and no other lib file, because it runs
 * inside an install that may be missing any dependency. It never exits: the
 * CLI owns the one refusal, through `INCOMPLETE_INSTALL_EXIT`, so a test can
 * set it to 0 and watch the refusal go.
 */
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";

/** The CLI's exit status for an incomplete install. One site, so a mutant can zero it. */
export const INCOMPLETE_INSTALL_EXIT = 1;

type Manifest = { dependencies?: Record<string, string> };

/** The parsed manifest, or the reason it could not be read. Never throws. */
function readManifest(dir: string): Manifest | string {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Where `name` is installed as seen from `from`, by node's own walk up the node_modules directories, or null. */
function packageDir(name: string, from: string): string | null {
  for (let d = from; ; d = dirname(d)) {
    const candidate = join(d, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(d) === d) return null;
  }
}

/**
 * Every package this install needs and cannot find, in the order found, each
 * named by the path that needed it (`@octokit/rest > @octokit/core`).
 *
 * The whole `dependencies` tree is walked, not only rungate's own list
 * (review of #2491). A half-written install can hold `@octokit/rest` and not
 * one of the packages it loads, and that fails inside the script exactly as
 * a missing top-level package does. rungate's own dependencies must also
 * resolve to an entry file. A package further down must have a readable
 * manifest: some legitimately ship no entry (types only), so resolving them
 * would refuse a complete install. `optionalDependencies` and
 * `peerDependencies` are not walked, because an install may lack them by
 * design.
 *
 * An unreadable `package.json` is itself the incomplete install, and is
 * named as the one thing missing: never "nothing missing", because a check
 * that cannot read what it checks has not passed, and never a throw, because
 * the same race that half-writes a dependency can half-write this file, and a
 * stack trace naming a temp path is the crash this module exists to replace
 * (review of #2491).
 */
export function missingDependencies(packageRoot: string): string[] {
  const own = readManifest(packageRoot);
  if (typeof own === "string") return [`package.json (unreadable: ${own})`];
  // rungate's own manifest always declares dependencies, so one that parses
  // and declares none is as torn as one that does not parse (review round 4
  // of #2491). A package further down may legitimately declare none.
  const deps = (own as { dependencies?: unknown }).dependencies;
  if (deps === null || typeof deps !== "object" || Array.isArray(deps) || Object.keys(deps).length === 0) {
    return ["package.json (unreadable: it declares no dependencies)"];
  }
  const missing: string[] = [];
  const seen = new Set<string>();
  const queue = Object.keys(own.dependencies ?? {}).map(name => ({ name, from: packageRoot, via: "" }));
  while (queue.length > 0) {
    const { name, from, via } = queue.shift()!;
    const label = via ? `${via} > ${name}` : name;
    const dir = packageDir(name, from);
    // Not found is the reading itself, recorded rather than dropped: the
    // package goes on the list the CLI refuses with.
    if (dir === null) {
      missing.push(label);
      continue;
    }
    if (seen.has(dir)) continue;
    seen.add(dir);
    const manifest = readManifest(dir);
    if (typeof manifest === "string") {
      missing.push(`${label} (package.json unreadable: ${manifest})`);
      continue;
    }
    if (via === "") {
      try {
        Bun.resolveSync(name, packageRoot);
      } catch {
        missing.push(label);
        continue;
      }
    }
    for (const dep of Object.keys(manifest.dependencies ?? {})) queue.push({ name: dep, from: dir, via: label });
  }
  return missing;
}

/** What the CLI prints when `missingDependencies` is not empty. */
export function incompleteInstallMessage(packageRoot: string, missing: string[]): string {
  return [
    `rungate: this install is incomplete — ${packageRoot} cannot load ${missing.join(", ")}.`,
    "The usual cause is two `bunx rungate@<version>` runs installing into the same",
    "temporary directory at once. Re-run the command, or install rungate in the",
    "project and run node_modules/.bin/rungate, which installs nothing at run time.",
  ].join("\n");
}
