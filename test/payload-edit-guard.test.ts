/**
 * #2713: an agent's `gh issue edit` that writes a payload issue's board
 * fields is refused before it runs.
 *
 * The second hand-edit run behind #1722 ended on an agent's body edit to a
 * Convergence-family issue, where a comment would have done. This is a speed
 * bump, like `IssueCloseGuard`'s close check (#144): a command spelled
 * another way gets past it, and the control stays `scripts/hand-edits.ts`,
 * which reads the outcome. A bypass found here is not a defect to file.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { BOARD_WRITE_FLAGS, payloadEditRefusal, payloadPrefix } from "../lib/payload-edit-guard";

const ROOT = join(import.meta.dir, "..");
const HOOK = join(ROOT, "hooks", "IssueCloseGuard.hook.ts");
const PAYLOAD = "Convergence Phase 2 — stop the false findings";
const MILESTONES: Record<string, string> = { "2655": PAYLOAD, "2714": "", "100": "Engine Phase 1 — the engine" };
const seen: Array<[string, string | null]> = [];
const lookup = (issue: string, repo: string | null): string => {
  seen.push([issue, repo]);
  if (!(issue in MILESTONES)) throw new Error(`no issue ${issue}`);
  return MILESTONES[issue];
};
const decide = (command: string) => payloadEditRefusal(command, { prefix: "Convergence", milestoneOf: lookup });
const VALUELESS = new Set(["--remove-milestone"]);

describe("#2713: a board write to a payload issue is refused", () => {
  test("the prefix is the payload spec's board.prefix, found through the engine spec's governs line", () => {
    expect(payloadPrefix(ROOT)).toBe("Convergence");
    expect(payloadPrefix(mkdtempSync(join(tmpdir(), "peg-nospecs-")))).toBeNull();
  });

  test.each(BOARD_WRITE_FLAGS.map(f => [f]))("%s on a payload issue is refused, and says to comment instead", flag => {
    const r = decide(`gh issue edit 2655 ${flag}${VALUELESS.has(flag) ? "" : " x"}`);
    expect(r).not.toBeNull();
    expect(r!).toContain("#2655");
    expect(r!).toContain(PAYLOAD);
    expect(r!).toContain("gh issue comment 2655");
  });

  test("the forms gh accepts: flags first, --repo, an env prefix, an =value, a URL, several issues", () => {
    expect(decide("gh issue edit --body-file b.md 2655")).toContain("#2655");
    expect(decide("env -u GH_TOKEN gh issue edit 2655 --repo hornjason/rungate --add-label x")).toContain("#2655");
    expect(decide("cd /tmp && gh issue edit 2655 --title=renamed")).toContain("#2655");
    expect(decide("gh issue edit https://github.com/hornjason/rungate/issues/2655 -b x")).toContain("#2655");
    expect(decide("gh issue edit 2714 2655 --add-label x")).toContain("#2655");
    seen.length = 0;
    decide("gh issue edit 2655 -R hornjason/rungate --body x");
    decide("gh issue edit https://github.com/o/r/issues/2655 --body x");
    expect(seen).toEqual([["2655", "hornjason/rungate"], ["2655", "o/r"]]);
  });

  test("CONTROL: an assignee, a comment, a view, and the same edit outside the family are allowed", () => {
    expect(decide("gh issue edit 2655 --add-assignee @me")).toBeNull();
    expect(decide("gh issue comment 2655 --body-file c.md")).toBeNull();
    expect(decide("gh issue view 2655 --json milestone")).toBeNull();
    expect(decide("gh issue edit 2714 --body x")).toBeNull();
    expect(decide("gh issue edit 100 --add-label x")).toBeNull();
    // No payload declared: the guard has nothing to protect.
    expect(payloadEditRefusal("gh issue edit 2655 --body x", { prefix: null, milestoneOf: lookup })).toBeNull();
  });

  test("an edit it cannot check is refused, not allowed", () => {
    expect(decide("gh issue edit 999 --body x")).toContain("could not be read");
    expect(decide("gh issue edit $N --body x")).toContain("does not name an issue");
    expect(decide("gh issue edit --body x")).toContain("names no issue");
  });
});

describe("#2713: the hook runs the guard", () => {
  const dir = mkdtempSync(join(tmpdir(), "peg-fake-gh-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // A `gh` that answers the milestone lookup from the environment, so the
  // hook is driven end to end with no network and no credentials.
  const fake = join(dir, "gh");
  writeFileSync(fake, '#!/bin/sh\nif [ -n "$FAKE_GH_FAIL" ]; then echo "fake gh: offline" >&2; exit 1; fi\nprintf "%s\\n" "$FAKE_GH_MILESTONE"\n');
  chmodSync(fake, 0o755);
  const hook = (command: string, env: Record<string, string>) => {
    const r = Bun.spawnSync(["bun", HOOK], {
      stdin: new TextEncoder().encode(JSON.stringify({ tool_name: "Bash", tool_input: { command } })),
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...env },
    });
    return r.stdout.toString();
  };

  test("a body edit on a payload issue is blocked", () => {
    const out = hook("gh issue edit 2655 --body-file b.md", { FAKE_GH_MILESTONE: PAYLOAD });
    expect(out).toContain('"decision":"block"');
    expect(out).toContain("gh issue comment 2655");
  });

  test("an edit whose milestone cannot be read is blocked", () => {
    expect(hook("gh issue edit 2655 --add-label x", { FAKE_GH_FAIL: "1" })).toContain('"decision":"block"');
  });

  test("CONTROL: the same edit outside the family, and an assignee on a payload issue, pass", () => {
    expect(hook("gh issue edit 2655 --body-file b.md", { FAKE_GH_MILESTONE: "" })).not.toContain('"decision":"block"');
    expect(hook("gh issue edit 2655 --add-assignee @me", { FAKE_GH_MILESTONE: PAYLOAD })).not.toContain('"decision":"block"');
  });
});
