/**
 * One decider for "is there another page, and what is its cursor".
 *
 * Covers SC-2720, SC-2721 (specs/BOARD-FLOW-SPEC.md).
 *
 * ## Why this is a module and not four `if`s
 *
 * Every GraphQL pager in this repository spelled the same line:
 *
 * ```ts
 * c = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
 * ```
 *
 * and every one of them **ends the loop and returns a confident partial
 * reading** for three different malformed pages: a `pageInfo` that is
 * absent, one that exists without `hasNextPage`, and one whose `endCursor`
 * is `""`. The last is the nastiest — an empty string passes a `typeof`
 * check and is then falsy, so a guard that looks correct lets it through.
 *
 * All three were found on `lib/board-throughput.ts` across two pull
 * requests, one variant at a time, and the third was found with the
 * correct spelling already sitting in `scripts/board-status-sweep.ts`.
 * Fixing them one site at a time is the defect that keeps producing the
 * defect: `.claude/rules/checks-must-be-able-to-fail.md` calls a
 * behavioural suite over N copies "catches only the last one to regress".
 *
 * So the property is asserted across the sites rather than repaired at
 * them. One binding, one mutation, every pager.
 *
 * ## A truncation is UNMEASURED, and that is not the same as an error
 *
 * The caller decides what to do — refuse the run, mark a row, throw — but
 * it may not decide that a page it could not read was the last one. That
 * distinction is the whole point and it is why `done` and `unreadable` are
 * separate cases rather than one nullable cursor.
 */

export type CursorReading =
  /** There is another page, and this is a cursor that can fetch it. */
  | { readonly kind: "more"; readonly cursor: string }
  /** That was the last page. The reading is complete. */
  | { readonly kind: "done" }
  /** The page could not say. **Never treat this as `done`.** */
  | { readonly kind: "unreadable"; readonly why: string };

/**
 * Read a connection's `pageInfo`.
 *
 * Takes `unknown` on purpose: every caller is handing over a value parsed
 * from a network response, and typing the parameter as a well-formed
 * `pageInfo` would make the compiler assert exactly the property this
 * function exists to check.
 */
export function nextCursor(pageInfo: unknown): CursorReading {
  if (typeof pageInfo !== "object" || pageInfo === null) {
    return {
      kind: "unreadable",
      why: "the page carried no pageInfo, so whether more pages exist is unknown",
    };
  }
  const info = pageInfo as { hasNextPage?: unknown; endCursor?: unknown };
  if (typeof info.hasNextPage !== "boolean") {
    return {
      kind: "unreadable",
      why: `pageInfo.hasNextPage is ${typeof info.hasNextPage}, not a boolean, so "no more pages" cannot be read from it`,
    };
  }
  if (!info.hasNextPage) return { kind: "done" };
  // **Non-empty, not merely a string.** `""` is a string and is falsy, so
  // a `typeof` check passes it and `while (cursor)` then ends the loop —
  // a guard that reads correctly and admits the exact value it was
  // written to exclude. ai-review round 1 of #1794.
  if (typeof info.endCursor !== "string" || info.endCursor.length === 0) {
    return {
      kind: "unreadable",
      why: "the page says more exist and gave no usable endCursor, so the rest cannot be fetched",
    };
  }
  return { kind: "more", cursor: info.endCursor };
}
