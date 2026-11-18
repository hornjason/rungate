/**
 * The one way a test reaches ship.js's WORKTREE-IDENTITY region (#2421,
 * SC-2775 wave 3c-A1, plan on #2290).
 *
 * Fourteen suites sliced that region by hand, and eleven execute it. Since
 * wave 3c-B the region keeps only `worktreeRecords`: the rest is
 * lib/worktree-repo.ts's own code, carried into ship.run.js by the launch
 * bundle. So the region is returned with THAT module's bundle in front of it,
 * built exactly as ship.run.js builds it, and every reader runs what the
 * launch file runs.
 *
 * One module's bundle, never the whole prelude: the prelude also defines
 * names some readers inject (rookGateVerdict, rookScopeCommand), and
 * declaring them inside the block would shadow the injected ones (#2418).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { bundleLibCores, LAUNCH_BUNDLE } from "../../scripts/build-workflow-launch";

const ROOT = join(import.meta.dir, "..", "..");
const SHIP_PATH = join(ROOT, "workflows", "ship.js");

/** The module the region's bundled half comes from. */
export const WORKTREE_REPO_MODULE = "lib/worktree-repo.ts";

/** lib/worktree-repo.ts as ship.run.js bundles it; refused if the bundle no longer carries it. */
export function worktreeRepoBundle(): string {
  const names = LAUNCH_BUNDLE[WORKTREE_REPO_MODULE];
  if (names === undefined) {
    throw new Error(`LAUNCH_BUNDLE no longer carries ${WORKTREE_REPO_MODULE}, so the WORKTREE-IDENTITY region cannot run`);
  }
  return bundleLibCores({ [WORKTREE_REPO_MODULE]: names }, path => readFileSync(join(ROOT, path), "utf-8")).text;
}

/**
 * The region's text, START marker through the line before END, with
 * lib/worktree-repo.ts's bundle in front; refused, naming the marker, if
 * either is missing or doubled.
 */
export function worktreeIdentityRegion(source: string = readFileSync(SHIP_PATH, "utf-8")): string {
  const start = source.indexOf("// ──── WORKTREE-IDENTITY-START ────");
  const end = source.indexOf("// ──── WORKTREE-IDENTITY-END ────");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("ship.js is missing the WORKTREE-IDENTITY-START/END markers");
  }
  if (
    source.indexOf("// ──── WORKTREE-IDENTITY-START ────", start + 1) !== -1 ||
    source.indexOf("// ──── WORKTREE-IDENTITY-END ────", end + 1) !== -1
  ) {
    throw new Error("ship.js carries the WORKTREE-IDENTITY markers more than once; a second copy survives any change to the first");
  }
  return `${worktreeRepoBundle()}\n${source.slice(start, end)}`;
}

/** ship.js's own `worktreeIdentity`, built from the region rather than stubbed. */
export function shipWorktreeIdentity(source?: string): (...args: unknown[]) => any {
  return new Function(`${worktreeIdentityRegion(source)}\nreturn worktreeIdentity;`)() as (...args: unknown[]) => any;
}
