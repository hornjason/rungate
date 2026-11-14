/**
 * Covers SC-2750 (SPEC-TO-BOARD-PIPELINE-SPEC.md), #1355.
 *
 * A heredoc body reaches an interpreter through text the opener line does
 * not contain, and the filing cap used to read only that line. Four
 * spellings ran a filing under `/bin/bash` while the cap recorded 0 attempts:
 *
 *     (cat <<'EOF' … EOF⏎) | bash        — a subshell piped into a shell
 *     { cat <<'EOF' … EOF⏎} | bash       — a brace group, the same
 *     cat <<'EOF' \⏎| bash …             — the pipe on a continued line
 *     eval "$(cat <<'EOF' … EOF⏎)"       — a substitution handed to eval
 *
 * **Every row is executed, not described.** The payload is written to a file
 * with `writeFileSync` and that file is run by `/bin/bash` with a stub `gh`
 * first on a PATH that holds nothing else of ours. The bytes the gate decides
 * are read back from the SAME file, so a JavaScript escape that ate a
 * backslash would change what both sides see, and the empty-stderr assertion
 * turns that into a failure instead of a fixture that proves something about
 * itself. Each row carries its own title, so the stub's log names the row
 * that produced it.
 *
 * **The words are never written adjacent in a literal here**, for the reason
 * `test/issue-filing-gate.test.ts` gives at #1302.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { decideBashWrite, interpreterPrograms, stripHeredocs } from "../lib/bash-write-guard";
import { filingAttempts } from "../lib/issue-filing-gate";

const GH = ["gh", "issue", "create"].join(" ");
const filing = (title: string): string => `${GH} --title "${title}" --body "x" --label follow-up`;
/** What the stub logs for `filing(title)` — `"$*"`, so quotes are gone. */
const logged = (title: string): string => `issue create --title ${title} --body x --label follow-up`;

let dir = "";
let stubLog = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rg-heredoc-reach-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  stubLog = join(dir, "gh-calls.log");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${stubLog}"\n`);
  chmodSync(join(bin, "gh"), 0o755);
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/**
 * Write `payload` to a file, run it under `/bin/bash`, and hand back the
 * bytes on disk beside what the shell did with them.
 *
 * PATH is the stub directory and the two system directories only, so the
 * real `gh` — which lives in neither — cannot be reached even if the stub
 * were missing; a missing stub reads as `command not found` on stderr.
 */
function execute(name: string, payload: string): { cmd: string; calls: string[]; stderr: string } {
  const file = join(dir, `${name}.sh`);
  writeFileSync(file, payload);
  writeFileSync(stubLog, "");
  const run = spawnSync("/bin/bash", [file], {
    env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin` },
    encoding: "utf8",
  });
  const calls = readFileSync(stubLog, "utf8").split("\n").filter(Boolean);
  return { cmd: readFileSync(file, "utf8"), calls, stderr: run.stderr };
}

/** The four spellings #1355 names, each with the title its stub call carries. */
const REACH: Array<[string, (f: string) => string]> = [
  ["subshell", f => `(cat <<'EOF'\n${f}\nEOF\n) | bash\n`],
  ["brace", f => `{ cat <<'EOF'\n${f}\nEOF\n} | bash\n`],
  ["continued", f => `cat <<'EOF' \\\n| bash\n${f}\nEOF\n`],
  ["eval", f => `eval "$(cat <<'EOF'\n${f}\nEOF\n)"\n`],
];

describe("SC-2750: a filing reached through a heredoc past its opener line is metered", () => {
  for (const [name, spell] of REACH) {
    test(`${name}: the shell files it, and the cap counts exactly one attempt`, () => {
      const title = `probe-${name}`;
      const { cmd, calls, stderr } = execute(name, spell(filing(title)));
      // The payload arrived intact and genuinely files — otherwise the row
      // below would be asserting about a command that does nothing.
      expect(stderr, `${name}: bash reported an error, so the fixture is not the spelling`).toBe("");
      expect(calls).toEqual([logged(title)]);

      const attempts = filingAttempts(cmd);
      expect(attempts, `${name}: the shell filed and the cap recorded nothing`).toHaveLength(1);
      expect(attempts[0].title).toBe(title);
      expect(attempts[0].labels).toEqual(["follow-up"]);
    });
  }
});

describe("#1355 controls: the destination still decides, not the writer word", () => {
  test("a document heredoc stays at 0 — the shell writes a file and files nothing", () => {
    const { cmd, calls, stderr } = execute("document", `cat <<'EOF' > ${join(dir, "notes.md")}\n${filing("doc")}\nEOF\n`);
    expect(stderr).toBe("");
    expect(calls).toEqual([]);
    expect(filingAttempts(cmd)).toEqual([]);
    // The spelling the issue names, byte for byte.
    expect(filingAttempts(`cat <<'EOF' > /tmp/notes.md\n${filing("doc")}\nEOF`)).toEqual([]);
  });

  const STILL_ONE: Array<[string, (f: string) => string]> = [
    ["pipe", f => `cat <<'EOF' | bash\n${f}\nEOF\n`],
    ["bash-c", f => `bash -c "$(cat <<'EOF'\n${f}\nEOF\n)"\n`],
    ["process-substitution", f => `bash <(cat <<'EOF'\n${f}\nEOF\n)\n`],
  ];
  for (const [name, spell] of STILL_ONE) {
    test(`${name} stays at 1`, () => {
      const title = `probe-${name}`;
      const { cmd, calls, stderr } = execute(name, spell(filing(title)));
      expect(stderr).toBe("");
      expect(calls).toEqual([logged(title)]);
      expect(filingAttempts(cmd)).toHaveLength(1);
    });
  }

  test("a document heredoc inside a group that is NOT piped into an interpreter stays at 0", () => {
    // The cheapest wrong fix for the subshell and brace rows is "a heredoc
    // inside a group is a program". These go to a file and to a pager, and
    // the third group's pipeline ENDS at `&&` — the shell after it is fed
    // by `echo`, not by the group. No redirect on that one: a redirect would
    // sever the body first and hold the row up for a different reason.
    for (const cmd of [
      `{ cat <<'EOF'\n${filing("doc")}\nEOF\n} > /tmp/notes.md`,
      `(cat <<'EOF'\n${filing("doc")}\nEOF\n) | less`,
      `(cat <<'EOF'\n${filing("doc")}\nEOF\n) && echo : | bash`,
    ]) {
      expect(filingAttempts(cmd), cmd.slice(0, 24)).toEqual([]);
    }
  });

  test("a commit message is not a program because a LATER clause pipes into one", () => {
    // The cheapest wrong fix for the eval row is to read the whole statement
    // with the opener line's rule, which pipes anything after `|` into the
    // first interpreter word it finds. `bun` is one, and this is the most
    // common heredoc shape there is.
    const cmd = `git commit -m "$(cat <<'EOF'\n${filing("doc")}\nEOF\n)" && bun test | tee /tmp/out`;
    expect(filingAttempts(cmd)).toEqual([]);
  });

  /**
   * Review round 2 of PR #2077. The shell is the oracle in every row: the cap
   * must count exactly what `/bin/bash` files from the same bytes.
   *
   * - A heredoc whose OWN stdout is redirected never reaches the group's
   *   pipe, before or after the operator, and neither does a group whose
   *   stdout is redirected. `2>` moves stderr only and severs nothing.
   * - A `#` line continuing the opener is a comment once the shell joins it,
   *   so the `| bash` in it is comment text.
   */
  const SHELL_IS_ORACLE: Array<[string, (f: string) => string, number]> = [
    ["own-redirect-after", f => `(cat <<'EOF' > ${join(dir, "a.md")}\n${f}\nEOF\n) | bash\n`, 0],
    ["own-redirect-before", f => `(cat > ${join(dir, "b.md")} <<'EOF'\n${f}\nEOF\n) | bash\n`, 0],
    ["group-redirect", f => `{ cat <<'EOF'\n${f}\nEOF\n} > ${join(dir, "c.md")} | bash\n`, 0],
    ["stderr-only", f => `(cat <<'EOF' 2>/dev/null\n${f}\nEOF\n) | bash\n`, 1],
    ["comment-continuation", f => `cat <<'EOF' \\\n# note | bash\n${f}\nEOF\n`, 0],
  ];
  for (const [name, spell, files] of SHELL_IS_ORACLE) {
    test(`${name}: the cap counts what the shell files (${files})`, () => {
      const title = `probe-${name}`;
      const { cmd, calls, stderr } = execute(name, spell(filing(title)));
      expect(stderr).toBe("");
      expect(calls).toEqual(files ? [logged(title)] : []);
      expect(filingAttempts(cmd), `${name}: the shell filed ${files}`).toHaveLength(files);
    });
  }

  test("two heredocs in one group are routed separately", () => {
    // A body is a program because of where IT goes, not because some other
    // heredoc in the same statement goes to a shell.
    const cmd = `{ cat <<'A' > /tmp/doc.md\n${filing("doc")}\nA\nbash <<'B'\n${filing("ran")}\nB\n}`;
    const attempts = filingAttempts(cmd);
    expect(attempts.map(a => a.title)).toEqual(["ran"]);
  });
});

describe("#1355 BashWriteGuard reads the same reach", () => {
  // `interpreterPrograms` is the one binding both guards read (#1302), so the
  // write guard gains exactly what the filing cap gains.
  const TARGET = "/opt/bwprobe/" + "workflow-" + "state.json";
  const write = `echo x > ${TARGET}`;

  for (const [name, spell] of REACH) {
    test(`${name}: a protected write in the body is refused`, () => {
      const cmd = spell(write);
      expect(interpreterPrograms(cmd).map(p => p.program)).toEqual([write]);
      expect(decideBashWrite(cmd).blocked, name).toBe(true);
    });
  }

  test("a continued opener line is the command, not the first line of the body", () => {
    // The body starts after the LOGICAL line. Reading the continued line as
    // body deleted it from every view, and with it this redirect.
    const cmd = `cat <<'EOF' \\\n> ${TARGET}\nhello\nEOF`;
    expect(stripHeredocs(cmd)).toBe(`cat <<'EOF' \\\n> ${TARGET}`);
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("a backslash inside a comment glued to an operator does not continue the line", () => {
    // Review of PR #2077: `;#` opens a comment, so the trailing backslash is
    // comment text and the next line is the BODY. Executed first, because
    // the shell's reading is the whole question: had bash joined the lines,
    // the filing would be comment text and the stub would never be called.
    const opener = `bash <<'EOF' ;# note \\`;
    const ran = execute("glued-comment", `${opener}\n${filing("probe-glued")}\nEOF\n`);
    expect(ran.stderr).toBe("");
    expect(ran.calls).toEqual([logged("probe-glued")]);

    // `continues` and `nest` now ask one predicate where a comment starts;
    // with the narrower copy, the first body line was swallowed as opener.
    const cmd = `${opener}\n${write}\nEOF`;
    expect(interpreterPrograms(cmd).map(p => p.program)).toEqual([write]);
    expect(stripHeredocs(cmd)).toBe(opener);
  });
});

/**
 * #2079: a heredoc whose interpreter sits INSIDE a command or process
 * substitution. The opener line's command word was read from the line start
 * (`X=$(bash`), not from the innermost command that owns the `<<` (`bash`),
 * and `source` / `.` run a file as shell text without being on the
 * interpreter list. Four spellings filed under `/bin/bash` while the cap
 * recorded 0. The shell is the oracle in every row.
 */
const INSIDE: Array<[string, (f: string) => string, { sourcesProcessSubstitution?: true }]> = [
  ["assign-substitution", f => `X=$(bash <<'EOF'\n${f}\nEOF\n)\n`, {}],
  ["echo-substitution", f => `echo "$(bash <<'EOF'\n${f}\nEOF\n)"\n`, {}],
  // The interpreter runs its stdin wherever its own stdout goes.
  ["assign-substitution-redirected", f => `X=$(bash <<'EOF' > /dev/null\n${f}\nEOF\n)\n`, {}],
  ["source-process-substitution", f => `source <(cat <<'EOF'\n${f}\nEOF\n)\n`, { sourcesProcessSubstitution: true }],
  ["dot-process-substitution", f => `. <(cat <<'EOF'\n${f}\nEOF\n)\n`, { sourcesProcessSubstitution: true }],
];

/**
 * `source <(…)` reads nothing under bash 3.2, which is macOS's `/bin/bash`;
 * bash 4 and later, which is CI's, runs it. The oracle is the shell on this
 * machine, so those rows expect what it does. The cap counts one either way:
 * an agent's shell is not ours to choose, and every current bash files it.
 */
const BASH_MAJOR = Number(spawnSync("/bin/bash", ["-c", "echo ${BASH_VERSINFO[0]}"], { encoding: "utf8" }).stdout.trim());

describe("#2079: a heredoc owned by a command inside a substitution is metered", () => {
  test("the oracle's bash version was read", () => {
    expect(Number.isInteger(BASH_MAJOR) && BASH_MAJOR >= 3).toBe(true);
  });

  for (const [name, spell, how] of INSIDE) {
    test(`${name}: the shell files it, and the cap counts exactly one attempt`, () => {
      const title = `probe-${name}`;
      const { cmd, calls, stderr } = execute(name, spell(filing(title)));
      expect(stderr, `${name}: bash reported an error, so the fixture is not the spelling`).toBe("");
      const shellFiles = !how.sourcesProcessSubstitution || BASH_MAJOR >= 4;
      expect(calls).toEqual(shellFiles ? [logged(title)] : []);
      const attempts = filingAttempts(cmd);
      expect(attempts, `${name}: the shell filed and the cap recorded nothing`).toHaveLength(1);
      expect(attempts[0].title).toBe(title);
    });
  }

  test("a document captured into a variable, echoed, or sourced into a file stays at 0", () => {
    // The cheapest wrong fix is "a heredoc inside a substitution is a
    // program". These capture or print the text; the shell files nothing.
    const CAPTURED: Array<[string, (f: string) => string]> = [
      ["assign-cat", f => `X=$(cat <<'EOF'\n${f}\nEOF\n)\n`],
      ["echo-cat", f => `echo "$(cat <<'EOF'\n${f}\nEOF\n)" > ${join(dir, "echoed.md")}\n`],
      ["source-severed", f => `source <(cat <<'EOF' > ${join(dir, "sev.md")}\n${f}\nEOF\n)\n`],
    ];
    for (const [name, spell] of CAPTURED) {
      const { cmd, calls, stderr } = execute(name, spell(filing(`doc-${name}`)));
      expect(stderr, name).toBe("");
      expect(calls, name).toEqual([]);
      expect(filingAttempts(cmd), name).toEqual([]);
    }
  });

  test("`source` given a COMMAND substitution reads a file name, so its heredoc is no program", () => {
    // `source "$(…)"` sources the file the output NAMES; only `source <(…)`
    // runs the output itself. Treating both alike would read a path as code.
    const TARGET = "/opt/bwprobe/" + "workflow-" + "state.json";
    for (const word of ["source", "."]) {
      const cmd = `${word} "$(cat <<'EOF'\necho x > ${TARGET}\nEOF\n)"`;
      expect(interpreterPrograms(cmd), word).toEqual([]);
    }
  });

  test("BashWriteGuard reads the same reach: a protected write in each body is refused", () => {
    const TARGET = "/opt/bwprobe/" + "workflow-" + "state.json";
    const write = `echo x > ${TARGET}`;
    for (const [name, spell] of INSIDE) {
      const cmd = spell(write);
      expect(interpreterPrograms(cmd).map(p => p.program), name).toEqual([write]);
      expect(decideBashWrite(cmd).blocked, name).toBe(true);
    }
  });
});
