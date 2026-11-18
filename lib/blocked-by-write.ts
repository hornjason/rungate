/**
 * The one writer of a `blocked by` link — #2345.
 *
 * `gh issue edit --add-blocked-by` exists only in recent `gh` releases. A
 * consumer's self-hosted runner with an older `gh` failed every edge of a
 * 35-issue plan with `unknown flag: --add-blocked-by` (asaCommandCenter run
 * 44200189258, 2026-11-17). `gh api` is in every release, so the link is
 * written through the REST dependencies endpoint instead, and the runner's
 * `gh` version stops mattering.
 *
 * **`issue_id` is the blocker's DATABASE id, not its number.** A number is
 * accepted too and links whichever issue has that database id — measured
 * 2026-11-05, recorded in `scripts/board-walkthrough.ts`. So the id is read
 * first, and the link is read back: the blocked issue's own blocker list must
 * name the blocker, or the write is refused, never reported as wired. The
 * read-back and not the POST's reply, because GitHub's documentation does not
 * say which of the two issues that reply describes.
 */

/** How a `gh` call is made. Injected so a test never shells out. */
export type GhExec = (args: readonly string[]) => string;

export function addBlockedBy(repo: string, blocked: number, blocker: number, exec: GhExec): void {
  const raw = exec(["api", `repos/${repo}/issues/${blocker}`, "--jq", ".id"]).trim();
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`#${blocker}: could not read its database id (got "${raw.slice(0, 40)}"), so no link was written`);
  }
  exec(["api", "-X", "POST", `repos/${repo}/issues/${blocked}/dependencies/blocked_by`, "-F", `issue_id=${id}`]);
  // One number per line: `--paginate` concatenates pages, so one JSON document would not parse.
  const linked = exec(["api", "--paginate", `repos/${repo}/issues/${blocked}/dependencies/blocked_by?per_page=100`, "--jq", ".[].number"])
    .split("\n")
    .map(l => l.trim())
    .filter(l => l !== "")
    .map(Number);
  if (!linked.includes(blocker)) {
    throw new Error(
      `#${blocked} blocked by #${blocker}: the write returned, but #${blocked}'s blockers read back as ` +
        `${linked.length === 0 ? "none" : linked.map(n => `#${n}`).join(", ")}`,
    );
  }
}
