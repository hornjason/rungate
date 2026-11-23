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
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
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

  test.each(BOARD_WRITE_FLAGS.map(f => [f]))("%s on a payload issue is refused, and says to comment instead", async flag => {
    const r = await decide(`gh issue edit 2655 ${flag}${VALUELESS.has(flag) ? "" : " x"}`);
    expect(r).not.toBeNull();
    expect(r!).toContain("#2655");
    expect(r!).toContain(PAYLOAD);
    expect(r!).toContain("gh issue comment 2655");
  });

  test("the forms gh accepts: flags first, --repo, an env prefix, an =value, a URL, several issues", async () => {
    expect(await decide("gh issue edit --body-file b.md 2655")).toContain("#2655");
    expect(await decide("env -u GH_TOKEN gh issue edit 2655 --repo hornjason/rungate --add-label x")).toContain("#2655");
    expect(await decide("cd /tmp && gh issue edit 2655 --title=renamed")).toContain("#2655");
    expect(await decide("gh issue edit https://github.com/hornjason/rungate/issues/2655 -b x")).toContain("#2655");
    expect(await decide("gh issue edit 2714 2655 --add-label x")).toContain("#2655");
    seen.length = 0;
    await decide("gh issue edit 2655 -R hornjason/rungate --body x");
    await decide("gh issue edit https://github.com/o/r/issues/2655 --body x");
    expect(seen).toEqual([["2655", "hornjason/rungate"], ["2655", "o/r"]]);
  });

  test("CONTROL: an assignee, a comment, a view, and the same edit outside the family are allowed", async () => {
    expect(await decide("gh issue edit 2655 --add-assignee @me")).toBeNull();
    expect(await decide("gh issue comment 2655 --body-file c.md")).toBeNull();
    expect(await decide("gh issue view 2655 --json milestone")).toBeNull();
    expect(await decide("gh issue edit 2714 --body x")).toBeNull();
    expect(await decide("gh issue edit 100 --add-label x")).toBeNull();
    // No payload declared: the guard has nothing to protect.
    expect(await payloadEditRefusal("gh issue edit 2655 --body x", { prefix: null, milestoneOf: lookup })).toBeNull();
  });

  test("an edit it cannot check is refused, not allowed", async () => {
    expect(await decide("gh issue edit 999 --body x")).toContain("could not be read");
    expect(await decide("gh issue edit $N --body x")).toContain("does not name an issue");
    expect(await decide("gh issue edit --body x")).toContain("names no issue");
  });
});

describe("#2719 review round 1", () => {
  test("a backslash-continued edit is read as one command", async () => {
    expect(await decide("gh issue edit 2655 \\\n  --body-file /tmp/b.md")).toContain("#2655");
    expect(await decide("gh issue edit \\\n 2655 --title x")).toContain("#2655");
  });

  test("a milestone set that moves an issue into the payload family is refused", async () => {
    const r = await decide(`gh issue edit 2714 --milestone '${PAYLOAD}'`);
    expect(r).toContain("#2714");
    expect(r).toContain(PAYLOAD);
    expect(r).toContain("gh issue comment 2714");
    expect(await decide(`gh issue edit 2714 -m "${PAYLOAD}"`)).toContain("#2714");
    expect(await decide(`gh issue edit 2714 --milestone="${PAYLOAD}"`)).toContain("#2714");
  });

  test("CONTROL: a milestone set outside the family, on an issue outside it, is allowed", async () => {
    expect(await decide("gh issue edit 2714 --milestone 'Engine Phase 1 — the engine'")).toBeNull();
  });

  test("a payload that is declared but unreadable refuses a board edit instead of turning the guard off", async () => {
    const tree = (files: Record<string, string>) => {
      const root = mkdtempSync(join(tmpdir(), "peg-payload-"));
      mkdirSync(join(root, "specs"));
      for (const [name, text] of Object.entries(files)) writeFileSync(join(root, "specs", name), text);
      return root;
    };
    const gone = tree({ "ENGINE.md": "---\ngoverns: THE ENGINE. Payload: GONE.md\n---\n" });
    expect(() => payloadPrefix(gone)).toThrow(/GONE\.md/);
    expect(await payloadEditRefusal("gh issue edit 2655 --body x", { root: gone, milestoneOf: lookup }))
      .toContain("payload declaration");
    const noPrefix = tree({ "ENGINE.md": "---\ngoverns: THE ENGINE. Payload: PAY.md\n---\n", "PAY.md": "---\ntitle: x\n---\n" });
    expect(() => payloadPrefix(noPrefix)).toThrow(/board\.prefix/);
    expect(await payloadEditRefusal("gh issue edit 2655 --body x", { root: noPrefix, milestoneOf: lookup }))
      .toContain("payload declaration");
    // CONTROL: a tree that declares no payload still refuses nothing.
    const none = tree({ "ENGINE.md": "---\ngoverns: THE ENGINE\n---\n" });
    expect(payloadPrefix(none)).toBeNull();
    expect(await payloadEditRefusal("gh issue edit 2655 --body x", { root: none, milestoneOf: lookup })).toBeNull();
  });

  test("GH_REPO in the command's own env prefix names the repository; -R and a URL still win", async () => {
    seen.length = 0;
    await decide("env GH_REPO=o/other gh issue edit 2655 --body x");
    await decide("GH_REPO=o/other gh issue edit 2655 --body x");
    await decide("env GH_REPO=o/other gh issue edit 2655 -R o/r --body x");
    await decide("GH_REPO=o/other gh issue edit https://github.com/o/u/issues/2655 --body x");
    expect(seen).toEqual([["2655", "o/other"], ["2655", "o/other"], ["2655", "o/r"], ["2655", "o/u"]]);
  });

  test("text inside quotes is not split into commands", async () => {
    expect(await decide('gh issue comment 2655 --body "Note; gh issue edit 2655 --body x"')).toBeNull();
    expect(await decide("gh issue comment 2655 --body 'a | gh issue edit 2655 --title y & z'")).toBeNull();
    // A real edit after a quoted separator still counts.
    expect(await decide('echo "a;b" && gh issue edit 2655 --body x')).toContain("#2655");
  });
});

describe("#2719 review round 2: the command is read by the shell tokenizer the filing guard uses", () => {
  test("an escaped quote inside double quotes does not swallow the flags after it", async () => {
    expect(await decide('gh issue edit 2655 --add-assignee "x\\"y" --body "new"')).toContain("#2655");
  });

  test("a short flag with its value attached is the flag it is", async () => {
    expect(await decide("gh issue edit 2655 -bnew")).toContain("#2655");
    expect(await decide(`gh issue edit 2714 -m"${PAYLOAD}"`)).toContain("#2714");
    seen.length = 0;
    expect(await decide("gh issue edit 2655 -Ro/r --body x")).toContain("#2655");
    expect(seen).toEqual([["2655", "o/r"]]);
  });

  test("a redirection is not an issue, and an edit outside the family with one stays allowed", async () => {
    expect(await decide("gh issue edit 2714 --body-file b.md 2>&1")).toBeNull();
    expect(await decide("gh issue edit 2714 --body x >/dev/null")).toBeNull();
    expect(await decide("gh issue edit 2714 --body x > /tmp/out 2>/dev/null")).toBeNull();
    expect(await decide("gh issue edit 2714 --body x &> /tmp/out")).toBeNull();
    // The same redirections on a payload issue are still refused.
    expect(await decide("gh issue edit 2655 --body x 2>&1")).toContain("#2655");
    expect(await decide("gh issue edit 2655 2>&1 --body x")).toContain("#2655");
  });

  test("an edit inside bash -c is read too", async () => {
    expect(await decide("bash -c 'gh issue edit 2655 --body x'")).toContain("#2655");
  });

  test("board.prefix is read as YAML: a quoted prefix is the prefix, and unparsable frontmatter is a broken declaration", () => {
    const tree = (pay: string) => {
      const root = mkdtempSync(join(tmpdir(), "peg-yaml-"));
      mkdirSync(join(root, "specs"));
      writeFileSync(join(root, "specs", "ENGINE.md"), "---\ngoverns: THE ENGINE. Payload: PAY.md\n---\n");
      writeFileSync(join(root, "specs", "PAY.md"), pay);
      return root;
    };
    expect(payloadPrefix(tree('---\nboard:\n  scope: active\n  prefix: "Convergence"\n---\n'))).toBe("Convergence");
    expect(payloadPrefix(tree("---\nboard:\n  prefix: 'Convergence'\n---\n"))).toBe("Convergence");
    expect(() => payloadPrefix(tree("---\nboard: [unclosed\n---\n"))).toThrow(/PAY\.md/);
  });
});

describe("#2713: the hook runs the guard", () => {
  // A GitHub API that answers the milestone lookup, so the hook is driven end
  // to end through lib/github.ts with no network: issue 2655 is in the
  // payload family, 2714 in no milestone, and 500 cannot be read.
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const n = /\/repos\/hornjason\/rungate\/issues\/(\d+)$/.exec(new URL(req.url).pathname)?.[1];
      if (n === "2655") return Response.json({ number: 2655, milestone: { title: PAYLOAD } });
      if (n === "2714") return Response.json({ number: 2714, milestone: null });
      return new Response("unavailable", { status: 503 });
    },
  });
  afterAll(() => server.stop(true));

  const hook = async (command: string): Promise<string> => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
      GITHUB_TOKEN: "fake-token-for-the-local-api",
    };
    delete env.GH_TOKEN;
    delete env.GH_REPO;
    const p = Bun.spawn(["bun", HOOK], {
      stdin: new TextEncoder().encode(JSON.stringify({ tool_name: "Bash", tool_input: { command } })),
      stdout: "pipe",
      stderr: "pipe",
      env: env as Record<string, string>,
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
  };

  test("a body edit on a payload issue is blocked", async () => {
    const out = await hook("gh issue edit 2655 -R hornjason/rungate --body-file b.md");
    expect(out).toContain('"decision":"block"');
    expect(out).toContain("gh issue comment 2655");
  });

  test("an edit whose milestone cannot be read is blocked", async () => {
    expect(await hook("gh issue edit 500 -R hornjason/rungate --add-label x")).toContain('"decision":"block"');
  });

  test("CONTROL: the same edit outside the family, and an assignee on a payload issue, pass", async () => {
    expect(await hook("gh issue edit 2714 -R hornjason/rungate --body-file b.md")).not.toContain('"decision":"block"');
    expect(await hook("gh issue edit 2655 -R hornjason/rungate --add-assignee @me")).not.toContain('"decision":"block"');
  });
});
