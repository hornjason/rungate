/**
 * path-probe.ts — what is at a path, following links, or why it could not be
 * read (#2849, moved here by #2875).
 *
 * Its own module so the config loader can decide presence the way the
 * surface readers do: `lib/surface-lint.ts` imports the config loader, so the
 * loader could not import this from there without a cycle. One decider, read
 * by both, so a config that is there and cannot be read is never taken for
 * absent on one side while the other names it (#2875).
 */

import { lstatSync, statSync } from "fs";
import { dirname } from "path";

/** The error code an fs call failed with, or its message when it has none. */
export function codeOf(e: unknown): string {
  return (e as NodeJS.ErrnoException).code ?? (e as Error).message;
}

/** What is at a path, following links, or why it could not be read. */
export type Probe = { kind: "dir" | "file" | "other" } | { kind: "absent" } | { kind: "unreadable"; code: string };

/**
 * The one reading of a user-level path (review round 4 of #2844). Earlier
 * rounds fixed one errno per round across three separate readers. Every
 * user-side touch now goes through this function, so "missing" and "could
 * not be read" are told apart in one place:
 *
 * - **absent**: nothing at the name. ENOENT or ENOTDIR from `stat`, `lstat`
 *   finds nothing either, and the nearest ancestor that exists is a directory
 *   or a regular file, not a link that leads nowhere (review round 6 of
 *   #2844). Nothing can be under a regular file, so a path through one is
 *   absent. Under a dangling link, the path is unreadable, not missing.
 * - **unreadable**: something is there and cannot be followed or read. A
 *   dangling or looping link, EACCES, or any other error.
 *
 * The project side reads through it too (#2849): `readRenderedSurface`,
 * `inRenderedTree` and `resolveTarget` decide presence here and nowhere
 * else, so neither side reads an unreadable path as a missing one.
 */
export function probePath(abs: string): Probe {
  try {
    const st = statSync(abs);
    return { kind: st.isDirectory() ? "dir" : st.isFile() ? "file" : "other" };
  } catch (e) {
    const code = codeOf(e);
    if (code !== "ENOENT" && code !== "ENOTDIR") return { kind: "unreadable", code };
    try {
      lstatSync(abs);
    } catch (e2) {
      const code2 = codeOf(e2);
      if (code2 !== "ENOENT" && code2 !== "ENOTDIR") return { kind: "unreadable", code: code2 };
      const blocked = blockingAncestor(abs);
      return blocked === null ? { kind: "absent" } : { kind: "unreadable", code: blocked };
    }
    return { kind: "unreadable", code };
  }
}

/**
 * Why the nearest ancestor of `abs` that exists stops a read, or null when
 * it does not: a link to nowhere (ENOENT), or a directory the walk up could
 * not look into (its error code).
 */
function blockingAncestor(abs: string): string | null {
  for (let d = dirname(abs); d !== dirname(d); d = dirname(d)) {
    let isLink: boolean;
    try {
      isLink = lstatSync(d).isSymbolicLink();
    } catch (e) {
      const code = codeOf(e);
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      return code;
    }
    if (!isLink) return null;
    try {
      statSync(d);
      return null;
    } catch (e) {
      return codeOf(e);
    }
  }
  return null;
}
