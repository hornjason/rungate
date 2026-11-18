/**
 * The one writer of `blocked by` links — #2345.
 *
 * `gh issue edit --add-blocked-by` exists only in recent `gh` releases. A
 * consumer's self-hosted runner with an older `gh` failed every edge of a
 * 35-issue plan with `unknown flag: --add-blocked-by` (2026-11-17). `gh api`
 * is in every release, so links are written through the REST dependencies
 * endpoint instead, and the runner's `gh` version stops mattering.
 *
 * **`issue_id` is the blocker's DATABASE id, not its number.** A number is
 * accepted too and links whichever issue has that database id — measured
 * 2026-11-05, recorded in `scripts/board-walkthrough.ts`. So each blocker's id
 * is read first, and the blocked issue's links are read back once all are
 * written: every blocker must be there, or the write is refused, never
 * reported as wired. The read-back and not the POST's reply, because GitHub's
 * documentation does not say which of the two issues that reply describes.
 *
 * **Calls, per blocked issue:** one id read per blocker not yet in `ids` (a
 * caller writing many groups passes one map, so a blocker shared by many
 * issues is read once), one POST per link, and one read-back. The REST
 * endpoint takes one link per call, so a group can no longer be one call the
 * way `issue edit --add-blocked-by a --add-blocked-by b` was.
 */

/** How a `gh` call is made. Injected so a test never shells out. */
export type GhExec = (args: readonly string[]) => string;

function databaseId(repo: string, blocker: number, exec: GhExec, ids: Map<string, number>): number {
  // Keyed by repository too: a dependency may cross repositories, so the same
  // number in another repository is another issue (review of #2357).
  const key = `${repo}#${blocker}`;
  const known = ids.get(key);
  if (known !== undefined) return known;
  const raw = exec(["api", `repos/${repo}/issues/${blocker}`, "--jq", ".id"]).trim();
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`#${blocker}: could not read its database id (got "${raw.slice(0, 40)}"), so no link was written`);
  }
  ids.set(key, id);
  return id;
}

export function addBlockers(
  repo: string,
  blocked: number,
  blockers: readonly number[],
  exec: GhExec,
  ids: Map<string, number> = new Map(),
): void {
  if (blockers.length === 0) return;
  // Every id before any write, so an unreadable one writes nothing for this issue.
  const resolved = blockers.map(b => ({ number: b, id: databaseId(repo, b, exec, ids) }));
  for (const b of resolved) {
    exec(["api", "-X", "POST", `repos/${repo}/issues/${blocked}/dependencies/blocked_by`, "-F", `issue_id=${b.id}`]);
  }
  // One number per line: `--paginate` concatenates pages, so one JSON document would not parse.
  const linked = new Set(
    exec(["api", "--paginate", `repos/${repo}/issues/${blocked}/dependencies/blocked_by?per_page=100`, "--jq", ".[].number"])
      .split("\n")
      .map(l => l.trim())
      .filter(l => l !== "")
      .map(Number),
  );
  const missing = blockers.filter(b => !linked.has(b));
  if (missing.length > 0) {
    throw new Error(
      `#${blocked}: the writes returned, but ${missing.map(b => `#${b}`).join(", ")} ${missing.length === 1 ? "is" : "are"} not among its blockers ` +
        `on read-back (${linked.size === 0 ? "none" : [...linked].map(n => `#${n}`).join(", ")})`,
    );
  }
}

/**
 * Remove one `blocked by` link, through the same REST endpoint and by the same
 * database id — `issue edit --remove-blocked-by` is missing from the same old
 * `gh` (review of #2357). Read back afterwards: a link still there is refused.
 */
export function removeBlocker(
  repo: string,
  blocked: number,
  blocker: number,
  exec: GhExec,
  ids: Map<string, number> = new Map(),
): void {
  const id = databaseId(repo, blocker, exec, ids);
  exec(["api", "-X", "DELETE", `repos/${repo}/issues/${blocked}/dependencies/blocked_by/${id}`]);
  const linked = exec(["api", "--paginate", `repos/${repo}/issues/${blocked}/dependencies/blocked_by?per_page=100`, "--jq", ".[].number"])
    .split("\n")
    .map(l => l.trim())
    .filter(l => l !== "")
    .map(Number);
  if (linked.includes(blocker)) {
    throw new Error(`#${blocked}: the removal returned, but #${blocker} is still among its blockers on read-back`);
  }
}
