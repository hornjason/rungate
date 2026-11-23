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
export function worktreeIdentityRegion(
  source: string = readFileSync(SHIP_PATH, "utf-8"),
  bundle: string = worktreeRepoBundle(),
): string {
  return `${bundle}\n${markedRegion(source, "WORKTREE-IDENTITY")}`;
}

/**
 * ship.js's SECURITY-HELPERS region, START marker through the line before END
 * (#2290 wave 4-A1, plan on #2290). Refused, naming the markers, if either is
 * missing or doubled. Wave 4-B moves its copies of lib/workflow-security.ts
 * into the launch bundle; then only this function changes for its readers.
 */
export function securityHelpersRegion(source: string = readFileSync(SHIP_PATH, "utf-8")): string {
  return markedRegion(source, "SECURITY-HELPERS");
}

/**
 * One marked region, by literal markers. Both marker pairs are spelled out
 * in full below, not built from the name, so a grep for either anchor finds
 * this function.
 */
function markedRegion(source: string, name: "WORKTREE-IDENTITY" | "SECURITY-HELPERS"): string {
  const START = name === "WORKTREE-IDENTITY" ? "// ──── WORKTREE-IDENTITY-START ────" : "// ──── SECURITY-HELPERS-START ────";
  const END = name === "WORKTREE-IDENTITY" ? "// ──── WORKTREE-IDENTITY-END ────" : "// ──── SECURITY-HELPERS-END ────";
  const start = source.indexOf(START);
  const end = source.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`ship.js is missing the ${name}-START/END markers`);
  }
  if (source.indexOf(START, start + 1) !== -1 || source.indexOf(END, end + 1) !== -1) {
    throw new Error(`ship.js carries the ${name} markers more than once; a second copy survives any change to the first`);
  }
  return source.slice(start, end);
}

/** ship.js's own `worktreeIdentity`, built from the region rather than stubbed. */
export function shipWorktreeIdentity(source?: string): (...args: unknown[]) => any {
  return new Function(`${worktreeIdentityRegion(source)}\nreturn worktreeIdentity;`)() as (...args: unknown[]) => any;
}
