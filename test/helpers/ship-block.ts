/**
 * The one way a test reaches ship.js's WORKTREE-IDENTITY region (#2421,
 * SC-2775 wave 3c-A1, plan on #2290).
 *
 * Fourteen suites sliced that region by hand, and eleven execute it. When its
 * copies of lib/worktree-repo.ts move into the bundle ship.run.js carries,
 * only this file has to change, so the move stays under ten files. Until then
 * it returns exactly the slice the suites took themselves.
 */
import { readFileSync } from "fs";
import { join } from "path";

const SHIP_PATH = join(import.meta.dir, "..", "..", "workflows", "ship.js");

/** The region's text, START marker through the line before END; refused, naming the marker, if either is missing or doubled. */
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
  return source.slice(start, end);
}

/** ship.js's own `worktreeIdentity`, built from the region rather than stubbed. */
export function shipWorktreeIdentity(source?: string): (...args: unknown[]) => any {
  return new Function(`${worktreeIdentityRegion(source)}\nreturn worktreeIdentity;`)() as (...args: unknown[]) => any;
}
