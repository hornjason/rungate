/**
 * path-probe.ts — what is at a path, following links, or why it could not be
 * read (#2849, moved here by #2875).
 *
 * Its own module so the config loader can decide presence the way the
 * surface readers do, through {@link Presence.decide}, the only reader of the
 * raw probe, which this module does not export (#2896): `lib/surface-lint.ts` imports the config loader, so the
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
function probePath(abs: string): Probe {
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

/**
 * What a caller expects at a path (#2878). A reader that will read or walk
 * what it finds asks `file` or `dir`, so something of the other kind there
 * is named: it could not be read as expected. A caller that only asks whether
 * something is there asks `either` and reads the present branch's kind, so
 * nothing it merely finds is reported as unread (review round 1).
 */
export type Expect = "file" | "dir" | "either";

/** What {@link Presence} holds and never hands out. */
type Answer = { is: "present"; kind: "dir" | "file" | "other" } | { is: "absent" } | { is: "unread" };

/**
 * The one answer to "is it there?" (#2878), opaque (#2896):
 *
 * - **present**: something of the expected kind is there, and the branch is
 *   given which kind, for a walk that recurses into a directory and reads a
 *   file.
 * - **absent**: nothing is at the name, or something of another kind is: a
 *   regular file or FIFO where a directory is expected, a directory or FIFO
 *   where a file is. The second is named, with why, and is still absent.
 * - **unread**: something is there and cannot be followed or searched. It is
 *   named with its code.
 *
 * The answer is a private field, so the only way to take it is
 * {@link Presence.on}, which requires a branch for each. A caller cannot
 * fold `unread` into `absent` by reading the answer by hand: there is no
 * property to compare, switch on or destructure, and the compiler refuses
 * every spelling of one. Rounds 2 and 3 of #2887 each found a spelling a
 * source-text check had missed.
 */
export class Presence {
  readonly #answer: Answer;

  private constructor(answer: Answer) {
    this.#answer = answer;
  }

  /**
   * Presence at `abs`, naming through `note` what is unread or of another
   * kind than `expect`. The only reader of the raw probe; a caller wraps it
   * with its own `note`, so the naming cannot be left out (#2876 round 3).
   */
  static decide(abs: string, expect: Expect, note: (abs: string, why: string) => void): Presence {
    const p = probePath(abs);
    if (p.kind === "absent") return new Presence({ is: "absent" });
    if (p.kind === "unreadable") {
      note(abs, p.code);
      return new Presence({ is: "unread" });
    }
    if (expect === "dir" && p.kind !== "dir") {
      note(abs, NOT_A_DIRECTORY);
      return new Presence({ is: "absent" });
    }
    if (expect === "file" && p.kind !== "file") {
      note(abs, p.kind === "dir" ? "EISDIR" : NOT_A_REGULAR_FILE);
      return new Presence({ is: "absent" });
    }
    return new Presence({ is: "present", kind: p.kind });
  }

  /** Take one of the three answers. Each branch is required. */
  on<T>(branches: { present: (kind: "dir" | "file" | "other") => T; absent: () => T; unread: () => T }): T {
    const a = this.#answer;
    switch (a.is) {
      case "present":
        return branches.present(a.kind);
      case "absent":
        return branches.absent();
      case "unread":
        return branches.unread();
    }
  }
}

/**
 * Why a directory entry that is a file or a FIFO is named (#2876 round 3).
 * `stat` answered, so no errno applies; `ENOTDIR` read as a failed call.
 */
const NOT_A_DIRECTORY = "not a directory";

/** Why a name expected to be a file is something else that is not a directory. */
const NOT_A_REGULAR_FILE = "not a regular file";
