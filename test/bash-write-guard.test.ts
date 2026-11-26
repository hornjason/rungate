/**
 * Covers #1120 — `lib/bash-write-guard.ts`.
 *
 * Two populations, and the second is the point. Witnesses prove the guard
 * refuses a write; CONTROLS prove it does not refuse everything, because a
 * check that refuses everything passes every witness ever written for it.
 *
 * The controls are not invented. F1-F4 are REAL commands from real work that
 * the old guard refused:
 *
 *   F1, F2  the session coordinating #1120, twice, trying to read this very
 *           file with `git show … | grep -nE "chmod|chflags"`
 *   F3      a peer staging a comparison copy of a hook under /tmp
 *   F4      `hornjason/pai-config#474` — the ONLY false positive ever
 *           recorded for this hook, recovered verbatim from the 2026-09-10
 *           transcript
 *
 * F5-F8 come from a sweep of 5,060 real commands extracted from this
 * machine's 35,040 transcripts — every Bash command ever run here that names
 * a protected artifact. F5's shape alone occurs 1,390 times.
 */

import { afterAll, describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import {
  decideBashWrite,
  interpreterPrograms,
  isScratchPath,
  programBody,
  segments,
  stripQuoted,
  stripHeredocs,
  dequote,
  commandWord,
  writeTargets,
} from "../lib/bash-write-guard";

const SALT = "." + "gate-" + "salt";
const STATE = "workflow-" + "state.json";

/**
 * A root that is absolute and is not any platform's scratch tree.
 *
 * Every witness below moved here in #1175. They were written under `/tmp`,
 * and `/tmp` is now the one place a protected NAME is not a protected
 * ARTIFACT — so a witness left there would have been asserting the false
 * positive this issue exists to remove. The move is not cosmetic: it is the
 * behaviour change, and `#1175 WITNESS` below holds both halves of it
 * against each other so the pair cannot drift apart.
 *
 * Deliberately not a path on this machine. A witness that only refuses
 * because of where one developer keeps their runs is a witness about a
 * machine.
 */
const LIVE = "/opt/bwprobe";

/**
 * A mutation battery copies the guard into a scratch directory and imports
 * the copy, so the copy's imports must resolve there too: the one sibling
 * module it imports. `lib/interpreter-calls.ts` and its `acorn` import went
 * with program-body reading in #2858. Without it the mutant dies on module
 * resolution, which reads as a refusal on the merits.
 */
function carryGuardImports(dir: string): void {
  for (const mod of ["interpreters.ts"]) {
    writeFileSync(join(dir, mod), readFileSync(join(import.meta.dir, "..", "lib", mod), "utf8"));
  }
}

/**
 * A fresh, real directory under the platform temp root, removed afterwards
 * (#1367). The scratch exemption now holds only for a destination whose
 * directories are REAL, so a fixture row makes the directory it writes into
 * rather than naming one that happens not to exist.
 */
// #2859: a missing directory is never exempt, so a fixture row writes into a
// directory that exists before the command is judged, as a real fixture's
// does once it is made in a command of its own. `/tmp` spelled, like the
// rows it replaces.
const FIX = mkdtempSync("/tmp/bw-fix-");
mkdirSync(join(FIX, "hooks"));
mkdirSync(join(FIX, "cp.d"));
afterAll(() => rmSync(FIX, { recursive: true, force: true }));

function inScratch(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "bw-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("#1120 WITNESS: a write to a protected artifact is refused", () => {
  const cases: [string, string][] = [
    ["a bare redirect — the control that proves the guard is wired", `echo x > ${LIVE}/${SALT}`],
    ["an allowlisted prefix in front of that redirect", `gh --version; echo x > ${LIVE}/${SALT}`],
    ["an allowlisted prefix in front of a chmod", `gh --version; chmod 777 lib/Foo.hook.ts`],
    ["an allowlisted prefix in front of the Keychain read", `gh --version; security find-generic-password -s pai-gate-salt -w`],
    ["an interpreter one-liner that opens for write", `python3 -c "open('${LIVE}/${SALT}','w').write('x')"`],
    ["the same interpreter reached by an absolute path", `/usr/bin/python3 -c "open('/x/${SALT}','w').write('x')"`],
    ["find -execdir, a plain synonym for -exec", `find . -name '*.json' -execdir rm /x/${STATE} ;`],
    ["sed -i, the ordinary way to edit a file from a shell", `sed -i '' 's/BUILD/DONE/' /Users/jhorn/.rungate/x/${STATE}`],
    ["cp carrying a flag before the destination", `cp -p /tmp/forged.json /Users/jhorn/.rungate/x/${STATE}`],
    ["a redirect whose target is quoted", `echo x > "${LIVE}/${SALT}"`],
    ["chmod whose path is quoted", `chmod 777 "hooks/Foo.hook.ts"`],
    ["rm of the salt", `rm -f /Users/jhorn/Projects/rungate/gates/${SALT}`],
    ["a quoted cp of a hook into a hooks directory", `cp "/a/hooks/X.hook.ts" "/b/hooks/X.hook.ts"`],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });
});

describe("#1120 CONTROL: real read-only work is not refused", () => {
  const cases: [string, string][] = [
    [
      "F1 — reading this file with git show | grep, which was refused twice in real work",
      `git -C /Users/jhorn/Projects/rungate show origin/main:hooks/BashWriteGuard.hook.ts | /usr/bin/grep -nE "READ_ONLY_PREFIXES|chmod|chflags"`,
    ],
    [
      "F2 — the same shape, second sighting",
      `git show origin/main:hooks/BashWriteGuard.hook.ts | grep -n "chflags"`,
    ],
    [
      "F3 — staging a comparison copy of a hook under /tmp",
      `cp -p /Users/jhorn/Projects/rungate/hooks/GateResultProtection.hook.ts /tmp/cmp/old-guard.ts && echo staged`,
    ],
    [
      "F4 — pai-config#474, a gh comment body quoting chflags and a hook filename",
      `gh issue close 473 --repo hornjason/pai-config --comment "$(cat <<'EOF'\n1. **BashWriteGuard.hook.ts** — blocks Bash writes to ${STATE}, ${SALT}, witnesses/, hook files.\n- Run \`chflags uchg\` on hook files for immutable protection (one-time)\nEOF\n)" 2>&1 | tail -1`,
    ],
    [
      "F5 — inspecting gate state with an interpreter; 1,390 real instances",
      `bun -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync("/Users/jhorn/.rungate/x/${STATE}","utf8"));console.log(Object.keys(j))'`,
    ],
    [
      "F6 — the same in python; 365 real instances",
      `/usr/bin/python3 -I -c "import json; s=json.load(open('/Users/jhorn/.rungate/x/${STATE}')); print(s['phase'])"`,
    ],
    [
      "F8 — an issue body quoting the Keychain command it proposes to guard",
      `gh issue comment 475 --repo hornjason/pai-config --body "SC-1: security find-generic-password -s 'pai-gate-salt' is reachable"`,
    ],
    ["an ordinary read", "ls -la"],
    ["grep naming a protected file", `grep -n phase ${STATE}`],
    ["plain find, which has no mutating action", `find . -name '*.hook.ts'`],
    ["a harmless interpreter one-liner", `python3 -c "print(1 + 1)"`],
    ["bun test, which names test files and writes nothing", `bun test test/bash-write-guard.test.ts`],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    const d = decideBashWrite(cmd);
    expect(d.blocked, `refused: ${d.reason}`).toBe(false);
  });
});

describe("#1120: the code/data split each check depends on", () => {
  test("stripHeredocs removes the document, keeping the command that writes it", () => {
    const cmd = "cat > notes.md <<'EOF'\nchmod 777 evil.hook.ts\nEOF";
    expect(stripHeredocs(cmd)).toContain("cat > notes.md");
    expect(stripHeredocs(cmd)).not.toContain("evil.hook.ts");
  });

  test("a heredoc body is never torn into segments by a pipe inside it", () => {
    // This was the bug that refused prose: a `|` in an issue body split the
    // document into fragments and each fragment was read as a command.
    const cmd = `cat > body.md <<'EOF'\n| col | ${STATE} |\nEOF\nrm -f scratch.txt`;
    expect(segments(cmd).some(s => s.includes("col"))).toBe(false);
  });

  test("stripQuoted removes a VERB that is only quoted text", () => {
    expect(stripQuoted(`grep -nE "chmod|chflags"`)).not.toContain("chmod");
  });

  test("dequote keeps a TARGET that is quoted", () => {
    expect(dequote(`chmod 777 "hooks/X.hook.ts"`)).toContain("hooks/X.hook.ts");
  });

  test("commandWord ignores wrappers, assignments, options and leading paths", () => {
    expect(commandWord("sudo chmod 777 x")).toBe("chmod");
    expect(commandWord("FOO=1 /usr/bin/python3 -c 'x'")).toBe("python3");
    expect(commandWord(`grep -nE "chmod" f`)).toBe("grep");
  });

  test("cp/mv destination is the LAST non-option argument, not the second token", () => {
    // Reading the second token mis-parsed every invocation with a flag, so
    // `cp -p src /x/workflow-state.json` never examined the real destination.
    expect(writeTargets(`cp -p src.json /x/${STATE}`)).toContain(`/x/${STATE}`);
  });

  test("2>&1 is stderr plumbing, not a write target", () => {
    expect(writeTargets("ls -la 2>&1")).toEqual([]);
  });
});

describe("#1120: the cheapest wrong fixes, run rather than described", () => {
  test("a guard that refuses everything passes every witness, and this separates it", () => {
    const refuseEverything = (_cmd: string) => ({ blocked: true, reason: "no" });
    const witness = `gh --version; echo x > ${LIVE}/${SALT}`;
    const control = "ls -la";
    // Both agree on the witness — which is why a witness alone proves nothing.
    expect(refuseEverything(witness).blocked).toBe(decideBashWrite(witness).blocked);
    // They disagree on the control, and that is the whole value of having one.
    expect(refuseEverything(control).blocked).toBe(true);
    expect(decideBashWrite(control).blocked).toBe(false);
  });

  test("the recorded false positive is what deleting the allowlist cost (#1176 keeps it green)", () => {
    // Measured before this rework: emptying READ_ONLY_PREFIXES turned F4 red
    // while STILL allowing the interpreter bypass. The allowlist is gone now
    // for a different reason — the checks became structural, so it had no
    // remaining job — and F4 stays green, which is the proof that removing it
    // this time is not the same act.
    const f4 = `gh issue close 473 --comment "$(cat <<'EOF'\n- Run \`chflags uchg\` on hooks/X.hook.ts\nEOF\n)"`;
    expect(decideBashWrite(f4).blocked).toBe(false);
  });
});

/**
 * Covers #1176 — six parser-differential bypasses shipped in #1145.
 *
 * One class: a check reads a TRANSFORMED view of the command — heredoc
 * stripped, quote stripped, segment split — and the transformation loses or
 * relocates the exact token the check is looking for. Seven were claimed by a
 * background review; six are real and the seventh is locked in below as a
 * NON-defect, because it was reported twice against a revision that no longer
 * exists and will be reported again.
 */
describe("#1176 WITNESS: a write the transformed view used to hide", () => {
  const cases: [string, string][] = [
    // G1. `[\s\S]*?` starts right after the delimiter word, so it ate the rest
    //     of the operator's line — and a redirect lives there.
    ["G1 a heredoc whose operator line also carries the redirect", `cat <<EOF > ${LIVE}/${SALT}\nhello\nEOF`],
    // G2. stripQuoted deletes quoted spans AND contents; the recovery pass
    //     only matched a target that was WHOLLY quoted, so a mid-word quote
    //     fell between the two.
    ["G2 a redirect target quoted in the middle of the word", `echo x > dir/"${STATE}"`],
    // G3. `.match` without /g, one capture group, but `tee` takes many files.
    ["G3 tee writing a protected file as its second operand", `echo x | tee /tmp/a ${LIVE}/${STATE}`],
    // G4. The real invocation quotes the key, and stripQuoted deleted it, so
    //     the arm could not fire on the one shape it exists for.
    ["G4 the Keychain key name in quotes", `security find-generic-password -s 'pai-gate-salt' -w`],
    // G6. The lookbehind excluded `2`, but `2> file` truncates like `> file`.
    ["G6 a stderr redirect, which truncates exactly like stdout", `echo x 2> ${LIVE}/${SALT}`],
    // G7. For a SHELL the `-c` body is shell, but it was matched against
    //     WRITE_INTENT, which enumerates Node and Python idioms only. Arm 1
    //     could not see it either, because stripQuoted deleted the body.
    ["G7 a shell -c body containing a plain redirect", `bash -c 'echo x > ${LIVE}/${SALT}'`],
    ["G7 the same through sh", `sh -c "rm -f ${LIVE}/${STATE}"`],
    // G8. Both of these are REAL commands from the corpus, and both are
    //     genuine writes that the #1176 rework briefly started allowing: an
    //     apostrophe inside a `#` comment opened a quote that stayed open
    //     across the newline and swallowed the redirect on a later line.
    //     Found by the sweep, not by reading. A shell comment is not a quote.
    [
      "G8 an apostrophe in a comment must not hide a later redirect",
      `# First, check if there's a test ${STATE} I can target\nmkdir -p ${LIVE}/rt\necho '{"phase":"BUILD"}' > ${LIVE}/rt/${STATE}`,
    ],
    [
      "G8 the same, hiding a write to a hook file",
      `# they're on main\ngit show HEAD~1:hooks/AutoVerifyGate.hook.ts > ${LIVE}/hooks/AutoVerifyGate.hook.ts`,
    ],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });
});

describe("#1176 CONTROL: the fixes must not widen the guard", () => {
  const cases: [string, string][] = [
    ["a heredoc writing an ordinary file still passes", `cat <<EOF > /tmp/bw/notes.md\nhello\nEOF`],
    ["tee to ordinary files", `echo x | tee /tmp/a /tmp/b`],
    ["a shell -c body that writes nothing protected", `bash -c 'echo hello > /tmp/bw/ordinary.txt'`],
    ["a shell -c body that only reads", `bash -c 'cat /tmp/bw/${STATE}'`],
    ["the Keychain name merely quoted in prose, command word is gh", `gh issue comment 475 --body "run security find-generic-password -s 'pai-gate-salt'"`],
    ["stderr discarded, the overwhelmingly common form", `grep -n phase ${STATE} 2>/dev/null`],
    ["stderr duplication, which names no path at all", `bun test 2>&1 | tail -5`],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    const d = decideBashWrite(cmd);
    expect(d.blocked, `refused: ${d.reason}`).toBe(false);
  });
});

/**
 * Covers #1184 — five more bypasses, one of them introduced by #1176's own
 * heredoc rewrite. H1 and H5 are asserted on `stripHeredocs` DIRECTLY as well
 * as through a decision, because an over-strip and a clean parse produce the
 * same decision and only the first is a bug.
 *
 * #1175 moved every destination in this block from `/tmp/bw` to `LIVE`. None
 * of these cases is about which tree the write lands in — they are about
 * terminators, quoted verbs and letter case — and `/tmp` is now the one tree
 * where a protected name is a fixture, so a witness left there would have
 * been asserting the false positive #1175 removed rather than the bypass it
 * was written for. The CONTROLS below keep their `/tmp` paths: they assert an
 * ALLOW, which is the direction the move cannot fake.
 */
describe("#1184 WITNESS: views, terminators and spellings", () => {
  const cases: [string, string][] = [
    // H1. #1176 replaced a terminator-anchored regex with a line scanner, and
    //     the scanner runs off the end when the terminator never arrives. The
    //     regex failed CLOSED here; the scanner failed open. A regression.
    ["H1 an unterminated heredoc must not delete the lines after it", `cat <<EOF\necho x > ${LIVE}/${SALT}`],
    ["H1b the same, hiding a hook write", `cat <<MARKER\ncp /tmp/evil.ts ${LIVE}/hooks/X.hook.ts`],
    // H5. `<<<` is a herestring. Matching it as a heredoc invents a delimiter
    //     that never terminates, which lands straight in H1.
    ["H5 a herestring is not a heredoc", `grep x <<< "t"\necho y > ${LIVE}/${SALT}`],
    // H3. The mirror of #1176's F2: there the TARGET was read off the
    //     quote-stripped view, here the VERB is.
    ["H3 a quoted command word still runs", `"chmod" 777 ${LIVE}/hooks/X.hook.ts`],
    ["H3b a partly quoted command word", `ch"mod" 777 ${LIVE}/hooks/X.hook.ts`],
    ["H3c a quoted interpreter", `"bash" -c 'echo x > ${LIVE}/${SALT}'`],
    // H4. A directory destination's real sink is join(dest, basename(src)).
    ["H4 cp into a directory, protected source basename", `cp /tmp/forged/${STATE} /Users/jhorn/.rungate/x/`],
    ["H4b mv into a directory", `mv /tmp/forged/${STATE} /Users/jhorn/.rungate/x/`],
    ["H4c cp a hook into a hooks directory", `cp /tmp/evil/X.hook.ts /Users/jhorn/Projects/rungate/hooks/`],
    // H6. Measured: this filesystem is case-insensitive, so these name the
    //     same files as their lowercase spellings.
    ["H6 an uppercase gate artifact", `echo x > ${LIVE}/${STATE.toUpperCase()}`],
    ["H6b an uppercase salt", `echo x > ${LIVE}/${SALT.toUpperCase()}`],
    ["H6c a mixed-case hook", `cp /tmp/evil.ts ${LIVE}/hooks/X.HOOK.TS`],
    // H7. Constructed, not from the corpus — the key reaching `security`
    //     through a variable set in an earlier segment. Measured cost of
    //     matching the key across the whole command: 0 of 125,644.
    ["H7 the keychain key arriving via a variable", `KEY=pai-gate-salt; security find-generic-password -s "$KEY" -w`],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });
});

/**
 * Covers #1196 — two regressions #1188 shipped, plus H6.
 *
 * R1 and R2 are mine. Every case is labelled witness or control, because the
 * first fixture written for R2 used an unprotected source basename and
 * measured nothing while looking like a clean result.
 */
describe("#1196 WITNESS: the verb, the filesystem, and the quoted operator", () => {
  const HOOK = LIVE + "/hooks/X.hook" + ".ts";
  const cases: [string, string][] = [
    // R1. #1188 made commandWord read `dequote(...)` then split on
    //     whitespace. That is not tokenisation: a quoted multi-word
    //     assignment VALUE survives the split as separate tokens and only
    //     the first carries the `=` that the skip looks for, so the verb
    //     resolves to a word out of the assignment.
    ["R1 an assignment prefix must not hide cp", `A="1 grep" cp /tmp/forged/${STATE} /x/${STATE}`],
    ["R1b the same for mv", `A="1 grep" mv /tmp/forged/${STATE} /x/${STATE}`],
    ["R1c the same for a hook mode change", `A="1 grep" chmod 777 ${HOOK}`],
    // R2. The destination's existence must not decide. A PreToolUse hook
    //     runs before the whole command, so in `mkdir -p d && cp <p> d` the
    //     directory never exists at decision time.
    ["R2 a directory destination that does not exist yet", `mkdir -p ${LIVE}/bwnope && cp /tmp/forged/${STATE} ${LIVE}/bwnope`],
    // H6. `<<WORD` inside a quoted span is not a heredoc operator. H5 was
    //     the same mistake at the wrong CHARACTER position; this is the
    //     wrong QUOTING position, and both fall into the same body-drop.
    ["H6 a quoted heredoc operator must not eat the next lines", `bun -e 'x = "<<EOF"'\nrm -rf /x/${STATE}\nEOF`],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });
});

describe("#1196 CONTROL: what must keep working", () => {
  const cases: [string, string][] = [
    // A heredoc nested in a command substitution inside double quotes is a
    // REAL heredoc. This is the recorded pai-config#474 false positive and
    // the reason H6 cannot be fixed by a plain "not inside quotes" test.
    [
      "pai-config#474 — a real heredoc inside \"$(…)\"",
      `gh issue close 473 --comment "$(cat <<'EOF'\n- Run \`chflags uchg\` on hooks/X.hook.ts\nEOF\n)"`,
    ],
    ["an ordinary assignment prefix on a harmless command", `FOO=1 ls -la`],
    ["a quoted multi-word assignment on a harmless command", `A="1 grep" ls -la`],
    ["an ordinary read", "ls -la"],
    // R2's cost, measured. The reviewer's simpler repair — push
    // `dest/basename(src)` unconditionally — refuses all four of these, and
    // on the corpus it refuses 19 real commands of exactly this shape while
    // catching no real write the directory oracles miss. The first two are
    // the backup `.claude/rules/checks-must-be-able-to-fail.md` tells an
    // agent to take before mutating a guard.
    ["backing up a hook before a mutation battery", `cp hooks/X.hook.ts /tmp/g239.bak`],
    ["the same with a quoted path", `cp "$W/hooks/X.hook.ts" "$B/hook.ts"`],
    ["staging gate state for a probe", `cp /Users/jhorn/.rungate/x/${STATE} /tmp/ws-254-probe.json`],
    ["copying a hook out with -p", `cp -p /Users/jhorn/Projects/rungate/hooks/X.hook.ts /tmp/cmp/old.ts`],
    // R1's own cost, found by the corpus sweep and not by review. Making the
    // tokeniser quote-aware makes a `--body "…"` ONE word, and the first
    // spelling returned that whole document as the command word — so a
    // continuation line of a `gh issue create` whose body described
    // `chflags uchg` on hook files matched IN_PLACE and was refused. Same
    // family as pai-config#474 above, reached through the verb rather than
    // through the heredoc.
    [
      "gh issue create whose BODY describes chflags on hooks",
      `gh issue create --repo hornjason/pai-config --label "p1-ship-next" \\\n  --title "Production lockdown — Keychain salt migration + hook immutable flags" \\\n  --body "## Goal\nHarden the enforcement stack.\n\n## Steps (human execution)\n4. find ~/.pai/hooks -name '*.hook.ts' -exec chflags uchg {} +\n5. chflags uchg ~/.claude/settings.json" 2>&1`,
    ],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    const d = decideBashWrite(cmd);
    expect(d.blocked, `refused: ${d.reason}`).toBe(false);
  });
});

/**
 * Covers #1196 R3 — an IO number read as an argument.
 *
 * Not relayed with the other three. The corpus sweep run for R2's cost found
 * it: four commands in the newly-blocked list were genuine writes INTO a
 * protected path, which #1188 should already have refused. `2>/dev/null` is
 * the whole bypass, and the head build was catching them only as a side
 * effect of the unconditional-directory rule — a case going green under a
 * fix aimed at something else, which is the fifth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 */
describe("#1196 R3 WITNESS: a trailing redirect must not demote the destination", () => {
  const cases: [string, string][] = [
    ["cp with 2>/dev/null", `cp /tmp/x.json /r/${STATE} 2>/dev/null`],
    ["cp with 2>&1", `cp /tmp/x.json /r/${STATE} 2>&1`],
    ["cp with >/dev/null 2>&1", `cp /tmp/x.json /r/${STATE} >/dev/null 2>&1`],
    ["mv with 2>/dev/null", `mv /tmp/x.json /r/${STATE} 2>/dev/null`],
    ["a hook, from the corpus", `cp /tmp/x.ts /Users/jhorn/.claude/hooks/Y.hook.ts 2>/dev/null`],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("the IO number is dropped, and a real numeric argument is not", () => {
    // `2` is a descriptor here, so the destination is the last word.
    expect(writeTargets(`cp /tmp/x.json /r/${STATE} 2>/dev/null`)).toContain(`/r/${STATE}`);
    // …but a bare `2` that is not followed by a redirect is an argument.
    expect(writeTargets(`cp 2 /r/${STATE}`)).toContain(`/r/${STATE}`);
  });
});

/**
 * Covers #1196 R4 — an assignment prefix whose VALUE is a path.
 *
 * The same defect #1196 names, reached through a different assignment shape.
 * `commandWord` ran `^.*\/` before testing for `=`, so the strip took the
 * `=` away with the directory part and `FOO=/x/grep` was returned spelled
 * `grep` — a fake verb standing in front of the real one. ALLOW on
 * origin/main and ALLOW behind the first spelling of the R1 fix; the same
 * commands with no prefix BLOCK.
 */
describe("#1196 R4 WITNESS: a path-valued assignment must not become the verb", () => {
  const cases: [string, string][] = [
    ["masking a mode change on a hook", `FOO=/x/grep chmod 777 ${LIVE}/h/X.hook.ts`],
    ["masking chflags on a hook", `FOO=/x/grep chflags uchg ${LIVE}/h/X.hook.ts`],
    ["masking cp into a protected path", `FOO=/x/grep cp /tmp/a /r/${STATE}`],
    ["masking an interpreter body", `FOO=/x/grep bun -e 'writeFileSync("/r/${STATE}","")'`],
    ["an array-subscript assignment", `A[0]=/x/grep chmod 777 ${LIVE}/h/X.hook.ts`],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("a real path is not mistaken for an assignment", () => {
    // The POSIX shape, not `includes('=')`: this one does not start with an
    // identifier, so it stays a verb.
    expect(commandWord(`/opt/a=b/bin/chmod 777 x`)).toBe("chmod");
    expect(commandWord(`FOO=/x/grep chmod 777 x`)).toBe("chmod");
    // An assignment with no verb after it resolves to nothing, and nothing
    // is what the arms must then find.
    expect(commandWord(`FOO=/x/${STATE}`)).toBe("");
    expect(decideBashWrite(`FOO=/x/${STATE}`).blocked).toBe(false);
  });
});

describe("#1196: the mechanisms, asserted directly", () => {
  test("a quoted multi-word assignment value stays inside its token", () => {
    expect(commandWord(`A="1 grep" cp /tmp/forged/${STATE} /x/${STATE}`)).toBe("cp");
    // …and the #1184 behaviour it must not undo.
    expect(commandWord(`"chmod" 777 x.hook.ts`)).toBe("chmod");
    expect(commandWord(`grep -nE "chmod" f`)).toBe("grep");
  });

  test("a directory destination is settled syntactically before the disk", () => {
    // #1175: a LIVE root, not `/tmp`. The oracles under test are about the
    // DESTINATION being a directory; under `/tmp` the resulting target is a
    // fixture and the row would assert the tree question instead of the one
    // it is named for.
    const d = LIVE + "/bw-no-such-dir-" + process.pid;
    // Oracle 1: a trailing slash. Oracle 2: more than two operands. Oracle 3:
    // a `mkdir` earlier in the same command. None of the three touches the
    // filesystem, and `d` does not exist.
    expect(decideBashWrite(`cp /tmp/forged/${STATE} ${d}/`).blocked).toBe(true);
    expect(decideBashWrite(`cp /tmp/forged/${STATE} /tmp/a.json ${d}`).blocked).toBe(true);
    expect(decideBashWrite(`mkdir -p ${d} && cp /tmp/forged/${STATE} ${d}`).blocked).toBe(true);
    // And with no oracle satisfied it is a plain destination: a read.
    expect(decideBashWrite(`cp /tmp/forged/${STATE} ${d}`).blocked).toBe(false);
  });

  test("a quoted `<<WORD` is not a heredoc operator, but one inside $( ) is", () => {
    // Quoted text: the lines after it must survive.
    expect(stripHeredocs(`bun -e 'x = "<<EOF"'\nrm -rf /x/f\nEOF`)).toContain("rm -rf /x/f");
    // Command substitution resets quoting, so this one IS a heredoc and its
    // body is the document being written.
    expect(stripHeredocs(`gh x --body "$(cat <<'EOF'\nchflags uchg hooks/X.hook.ts\nEOF\n)"`)).not.toContain(
      "chflags uchg",
    );
  });
});

describe("#1184 CONTROL: the fixes must not widen the guard", () => {
  const cases: [string, string][] = [
    ["a terminated heredoc still drops its body", `cat <<EOF > /tmp/bw/notes.md\nchmod 777 evil.hook.ts\nEOF`],
    ["a herestring feeding an ordinary read", `grep -n phase <<< "some text"`],
    ["an unterminated heredoc writing nothing protected", `cat <<EOF\necho hello > /tmp/bw/ordinary.txt`],
    ["copying a protected file OUT to a plain name is a read", `cp /x/${STATE} /tmp/backup.json`],
    ["cp into a directory with an unprotected source", `cp /tmp/notes.md /Users/jhorn/.rungate/x/`],
    ["a quoted grep PATTERN is still not a verb", `git show HEAD:f | grep -nE "chmod|chflags"`],
    ["an ordinary read", "ls -la"],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    const d = decideBashWrite(cmd);
    expect(d.blocked, `refused: ${d.reason}`).toBe(false);
  });
});

describe("#1184: the mechanisms, asserted directly", () => {
  test("an unterminated heredoc leaves the text after it UNCHANGED", () => {
    // The decision-level case cannot tell an over-strip from a clean parse.
    // This can: the bytes must survive.
    const cmd = `cat <<EOF\necho x > /tmp/bw/${SALT}`;
    expect(stripHeredocs(cmd)).toContain(`echo x > /tmp/bw/${SALT}`);
  });

  test("a herestring is not treated as a heredoc", () => {
    expect(stripHeredocs(`grep x <<< "t"\necho y > /tmp/f`)).toContain("echo y > /tmp/f");
  });

  test("commandWord resolves a quoted verb", () => {
    expect(commandWord(`"chmod" 777 x.hook.ts`)).toBe("chmod");
    expect(commandWord(`ch"mod" 777 x.hook.ts`)).toBe("chmod");
    // …and still does not promote a quoted grep PATTERN to a verb.
    expect(commandWord(`grep -nE "chmod" f`)).toBe("grep");
  });

  test("a directory destination resolves to dest/basename for every source", () => {
    expect(writeTargets(`cp /tmp/forged/${STATE} /Users/jhorn/.rungate/x/`).join(" ")).toContain(STATE);
  });

  test("protected names match whatever case the filesystem would fold", () => {
    expect(decideBashWrite(`echo x > ${LIVE}/${STATE.toUpperCase()}`).blocked).toBe(true);
  });
});

describe("#1176: the mechanisms, asserted directly", () => {
  test("stripHeredocs keeps the operator's own line and drops only the body", () => {
    const out = stripHeredocs("cat <<EOF > out.txt\nbody line\nEOF");
    expect(out).toContain("> out.txt");
    expect(out).not.toContain("body line");
  });

  test("#1741: the two readers get different views, and the CALLER chooses", () => {
    // Found by building the filing gate's shape check. #1176 blanks any
    // line opening with `#`, because an apostrophe in a prose comment was
    // opening a quote that swallowed a redirect two lines later. That rule
    // is right for the write guard and wrong for a markdown heading inside
    // an argument: an issue body typed as `--body "…"` across several lines
    // reached the filing gate with every `##` heading DELETED, so the dedupe
    // and the symptom scan read a body with holes and no reader could tell.
    //
    // Three revisions tried to decide per line whether the `#` was inside a
    // quote so one output could serve both. Each hand-rolled predicate had a
    // narrower view than the shell and each cost a review round. The caller
    // already knows which reader it is, so it says.
    const cmd = [
      'gh issue create --title "t" --body "intro',
      "",
      "## Files this will change",
      "",
      "lib/x.ts",
      '"',
    ].join("\n");

    expect(stripHeredocs(cmd, false)).toContain("## Files this will change");
    // The default is #1176's behaviour, unchanged, and this is the half that
    // makes the pair a contrast rather than two statements of one fact.
    expect(stripHeredocs(cmd)).not.toContain("## Files this will change");
  });

  test("#1741: a `#` line inside a quote still cannot OPEN A HEREDOC", () => {
    // Found by the security review of this change, and it was a real new
    // bypass. #1176 skipped heredoc detection for every `#`-leading line;
    // scoping the comment test to `open === null` let a `#` line inside a
    // quoted operand reach `heredocDelimiter`, and a terminated heredoc body
    // is DELETED from the guard's view — so the write two lines down
    // vanished. The docblock claimed the change "can only keep MORE of the
    // command, never less", and this input is the counter-example.
    //
    // The exemption reads the RAW line, so it does not move when
    // `blankComments` does. Kept after the re-scope removed the quote
    // tracker, because the property is about heredoc detection and not
    // about which view the caller asked for.
    //
    // **The quote CLOSES before the write, and that is what makes this a
    // bypass rather than a curiosity.** A redirect still inside the quoted
    // operand is not a write in any shell, so the guard is right to pass it
    // and an assertion there would be asserting a defect. Here the operand
    // ends on line 3 and line 4 is a real command — which the heredoc
    // opened on line 2 would swallow all the way to its terminator.
    const cmd = [
      'gh issue create --body "intro',
      "# cat <<EOF",
      '"',
      `echo x > ${LIVE}/${STATE}`,
      "EOF",
    ].join("\n");

    expect(stripHeredocs(cmd)).toContain(`> ${LIVE}/${STATE}`);
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("#1741 CONTROL: #1176's own case still blanks, so the re-scope is not a revert", () => {
    // The input the comment rule was added for, on the DEFAULT path every
    // write-guard arm takes. Its apostrophe must not open a quote — if this
    // line were kept, `> notes.md` on the next line would read as quoted
    // text and the write would go unseen.
    //
    // This is what the parameter buys: #1176's behaviour is reachable
    // unchanged and is the default, so none of the three hand-rolled
    // predicates is needed to get it.
    const cmd = "# First, check if there's a test workflow-state.json\necho x > notes.md";

    expect(stripHeredocs(cmd)).not.toContain("workflow-state.json");
    expect(stripHeredocs(cmd)).toContain("> notes.md");
  });

  test("writeTargets collects every tee operand, not just the first", () => {
    expect(writeTargets(`tee /tmp/a /tmp/bw/${STATE}`)).toContain(`/tmp/bw/${STATE}`);
  });

  test("a mid-word quoted redirect target survives as a target", () => {
    expect(writeTargets(`echo x > dir/"${STATE}"`).join(" ")).toContain(STATE);
  });

  test("2> is a write sink; 2>&1 and 2>/dev/null are not", () => {
    expect(writeTargets(`echo x 2> /tmp/bw/${SALT}`)).toContain(`/tmp/bw/${SALT}`);
    // The duplication form names a descriptor, not a path. This is the
    // negative control for dropping `2` from the lookbehind — without it the
    // fix would turn every `2>&1` in the corpus into a write.
    expect(writeTargets("ls -la 2>&1")).toEqual([]);
    expect(writeTargets("ls -la 2>/dev/null")).toEqual([]);
  });

  test("G5 is NOT a defect: over-splitting closes &> rather than opening it", () => {
    // Reported twice, and real in the round-1 revision where the whole command
    // hit the `(?<![2&])` lookbehind at once. Segmentation dissolved it: the
    // `&` becomes a separator, so the `>` opening the next segment is no
    // longer preceded by it. Locked in so the next review can be answered with
    // a run instead of an argument.
    expect(segments(`echo x &> ${LIVE}/${SALT}`)).toEqual(["echo x", `> ${LIVE}/${SALT}`]);
    expect(decideBashWrite(`echo x &> ${LIVE}/${SALT}`).blocked).toBe(true);
  });
});

/**
 * Covers #1175 — `PROTECTED_FILES` matched a NAME in any tree.
 *
 * Swept over 5,531 real commands from this machine's 35,261 transcripts, the
 * guard as merged refuses 502. Thirty-seven of those are agents building test
 * fixtures under `/tmp` — several of them fixtures for this very module — and
 * every one is a true positive against the rule and a false positive against
 * intent.
 *
 * The scoping is to the SCRATCH tree and not, as the issue's acceptance asked,
 * to the project root. That is a measurement. Of the 3,240 absolute artifact
 * references in the corpus, 16 are inside a repository tree and 3,141 are not
 * — a live `workflow-state.json` lives in the run store, which is nobody's
 * project root. `the cheapest wrong fixes` below runs the root-relative
 * reading rather than arguing with it.
 */
describe("#1175 WITNESS: the same write is a fixture here and an artifact there", () => {
  const pairs: [string, (root: string) => string][] = [
    ["a redirect", root => `echo '{}' > ${root}/p/${STATE}`],
    ["a heredoc", root => `cat > ${root}/p/${STATE} <<'EOF'\n{"phase":"BUILD"}\nEOF`],
    ["cp over it", root => `cp -p src.json ${root}/p/${STATE}`],
    ["sed -i on it", root => `sed -i '' 's/BUILD/DONE/' ${root}/p/${STATE}`],
    ["rm of it", root => `rm -f ${root}/p/${STATE}`],
    ["a shell -c body", root => `bash -c 'echo x > ${root}/p/${SALT}'`],
    ["tee", root => `echo x | tee ${root}/p/${STATE}`],
    ["chmod on a hook", root => `chmod 777 ${root}/p/Foo.hook.ts`],
  ];

  // #1367: the exemption holds only for a directory that is REAL, so the
  // fixture's directory is made first — a write into a directory nothing
  // made would fail, and is refused.
  test.each(pairs)("%s under a scratch root is a fixture", (_label, build) => {
    inScratch(root => {
      mkdirSync(join(root, "p"));
      const d = decideBashWrite(build(root));
      expect(d.blocked, `refused: ${d.reason}`).toBe(false);
    });
  });

  test.each(pairs)("%s under a live root is still refused", (_label, build) => {
    expect(decideBashWrite(build(LIVE)).blocked).toBe(true);
  });

  // #2858: an interpreter body has no scratch exemption, so the
  // interpreter spellings of the same write are refused under both roots.
  const interpreters: [string, (root: string) => string][] = [
    ["an interpreter opening for write", root => `python3 -I -c "import json; json.dump({}, open('${root}/p/${STATE}','w'))"`],
    ["a node interpreter", root => `bun -e 'require("fs").writeFileSync("${root}/p/${STATE}","{}")'`],
  ];
  test.each(interpreters)("%s is refused under a scratch root as under a live one (#2858)", (_label, build) => {
    inScratch(root => {
      mkdirSync(join(root, "p"));
      expect(decideBashWrite(build(root)).blocked).toBe(true);
    });
    expect(decideBashWrite(build(LIVE)).blocked).toBe(true);
  });

  test("the literal /tmp spelling is scratch as well as the resolved one", () => {
    expect(decideBashWrite(`echo '{}' > ${FIX}/${STATE}`).blocked).toBe(false);
    // macOS also spells /tmp as /private/tmp. On Linux /private does not
    // exist, and a missing directory is never exempt (#2859).
    expect(decideBashWrite(`echo '{}' > /private${FIX}/${STATE}`).blocked).toBe(!existsSync("/private/tmp"));
  });
});

describe("#1175 CONTROL: an exemption that cannot be shown refuses", () => {
  // The fail-closed half. A path this module cannot place in a tree is not a
  // fixture by default — it keeps the behaviour it had before #1175. The
  // acceptance asked for an unresolvable ROOT to refuse; there is no root
  // here, and the equivalent is an unresolvable DESTINATION.
  const cases: [string, string][] = [
    ["a bare basename, which is the overwhelmingly common interpreter shape", `bun -e 'require("fs").writeFileSync("${STATE}","{}")'`],
    ["a path assembled by join from a variable", `bun -e 'const p=join(dir,"${STATE}");require("fs").writeFileSync(p,"{}")'`],
    ["a path assembled by concatenation", `bun -e 'require("fs").writeFileSync(dir+"/${STATE}","{}")'`],
    ["a shell variable the command does not define", `echo x > $W/${STATE}`],
    ["a relative path", `echo x > ./run/${STATE}`],
    ["a scratch-looking path that climbs back out", `echo x > /tmp/../opt/run/${STATE}`],
    ["one scratch mention does not exempt a live one in the same command", `cp /tmp/p/${STATE} ${LIVE}/p/${STATE}`],
    ["the run store, which is where the artifact actually lives", `echo x > $HOME/.rungate/slug/${STATE}`],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("a symlink out of the scratch tree is not an exemption", () => {
    // Two commands is the whole attack: link a scratch name at the run store,
    // then write through it. `resolve()` cannot see this — it normalises
    // `..` and stops — so the deepest existing ancestor is realpath'd.
    const dir = mkdtempSync(join(tmpdir(), "bw-link-"));
    const link = join(dir, "esc");
    try {
      // Positive control: a plain name in that same scratch directory IS
      // exempt, so a red below is about the link and not about the tree.
      expect(isScratchPath(join(dir, STATE))).toBe(true);
      // `/usr` stands in for the run store: it exists, so realpath resolves,
      // and it is outside every temp root.
      symlinkSync("/usr", link);
      expect(isScratchPath(join(link, STATE))).toBe(false);
      expect(decideBashWrite(`echo x > ${join(link, STATE)}`).blocked).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#1175: the cheapest wrong fixes, run rather than described", () => {
  // A real corpus command: it rewrites every FAIL and PENDING verdict in a
  // live run's state to SKIPPED. This is the thing the guard exists for.
  const FORGE =
    `cat /Users/jhorn/.rungate/ddb-562/${STATE} | python3 -c "\n` +
    `import sys, json\nd = json.load(sys.stdin)\nd['phase'] = 'SKIPPED'\n` +
    `json.dump(d, open('/Users/jhorn/.rungate/ddb-562/${STATE}','w'), indent=2)"`;

  test("the real guard refuses it", () => {
    expect(decideBashWrite(FORGE).blocked).toBe(true);
  });

  test("scoping to the PROJECT ROOT, as the issue asked, allows it", () => {
    // #1175 AC-1 taken literally: protected == inside the project root.
    const root = resolve(process.cwd());
    const insideRoot = (p: string) => p === root || p.startsWith(root + "/");
    const target = `/Users/jhorn/.rungate/ddb-562/${STATE}`;
    expect(FORGE).toContain(target);
    expect(insideRoot(target)).toBe(false); // so the root-relative rule exempts it
    // Swept: this reading newly allows 169 of the 502 the guard refuses, 133
    // of them naming an artifact at a real absolute path.
  });

  test("exempting any command that MENTIONS a scratch directory allows a live write", () => {
    // The cheapest fix of all, and the shape `pai-config#474` was fixed for:
    // a whole-command predicate consulted before anything looks at the
    // destination. Swept: 192 newly allowed, 25 of them naming an artifact at
    // a real absolute path.
    const mentionsScratch = (cmd: string) => /\/tmp\/|\/var\/folders\/|mkdtemp|mktemp/.test(cmd);
    const real = `T=$(mktemp -d /tmp/why-XXXXXX); cp "$T/${STATE}" /Users/jhorn/.rungate/x/${STATE}`;
    expect(mentionsScratch(real)).toBe(true); // so the cheap fix allows it
    expect(decideBashWrite(real).blocked).toBe(true); // and this module does not
  });
});

describe("#1175: isScratchPath, asserted directly", () => {
  test("only an absolute path can be placed in a tree", () => {
    expect(isScratchPath(STATE)).toBe(false);
    expect(isScratchPath(`./${STATE}`)).toBe(false);
    expect(isScratchPath("")).toBe(false);
  });

  test("a sibling of a scratch root is not inside it", () => {
    expect(isScratchPath(`/tmpfoo/${STATE}`)).toBe(false);
    expect(isScratchPath(`/var/foldersx/${STATE}`)).toBe(false);
  });

  test("the platform temp directory is a scratch root whatever it is called", () => {
    expect(isScratchPath(join(tmpdir(), "p", STATE))).toBe(true);
  });

  test("TMPDIR is read at call time, but it can only SELECT a fixed root", () => {
    // This test used to assert that TMPDIR could NAME a new root, which is
    // the defect the review of #1197 found: the writer sets the variable that
    // decides whether their own write is exempt. Reading at call time is
    // still the behaviour — a harness that moves TMPDIR inside /tmp is
    // honoured — but naming a tree outside the fixed set now buys nothing.
    const before = process.env.TMPDIR;
    const inside = mkdtempSync(join("/tmp", "bw-tmpdir-"));
    try {
      process.env.TMPDIR = "/opt/relocated";
      expect(isScratchPath(`/opt/relocated/${STATE}`)).toBe(false);
      process.env.TMPDIR = inside;
      expect(isScratchPath(join(inside, STATE))).toBe(true);
    } finally {
      if (before === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before;
      rmSync(inside, { recursive: true, force: true });
    }
  });
});

/**
 * Covers the review of #1197. Six findings were raised; two were real, one
 * would have re-broken #1175, and a seventh defect was found by trying to
 * build the witness for one of the unmeasured ones.
 */
describe("#1175 review: TMPDIR is the writer's variable", () => {
  // The serious one. `scratchRoots()` took `process.env.TMPDIR` as given, so
  // the agent whose write is being judged set the variable that decided
  // whether the write was exempt.
  const RUN = `${process.env.HOME}/.rungate/victim/${STATE}`;

  test("pointing TMPDIR at the run store does not exempt the run store", () => {
    const before = process.env.TMPDIR;
    try {
      expect(isScratchPath(RUN)).toBe(false); // control: refused to begin with
      process.env.TMPDIR = `${process.env.HOME}/.rungate`;
      expect(isScratchPath(RUN)).toBe(false);
      expect(decideBashWrite(`echo x > ${RUN}`).blocked).toBe(true);
    } finally {
      if (before === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before;
    }
  });

  test.each([
    ["the project tree", () => resolve(process.cwd())],
    ["the home directory", () => process.env.HOME ?? "/"],
    ["the run store's parent", () => `${process.env.HOME}/.rungate/..`],
    ["the root of the disk", () => "/"],
  ])("TMPDIR pointed at %s extends nothing", (_label, build) => {
    const before = process.env.TMPDIR;
    try {
      process.env.TMPDIR = build();
      // The invariant: no exemption root may contain a protected tree. Asserted
      // through the only observable that matters — whether a real artifact is
      // exempted — rather than by reading the list back.
      expect(isScratchPath(RUN)).toBe(false);
      expect(isScratchPath(`${LIVE}/${STATE}`)).toBe(false);
      // and the fixed roots still work, so this is not a guard that died.
      expect(isScratchPath(`/tmp/p/${STATE}`)).toBe(true);
    } finally {
      if (before === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before;
    }
  });

  test("a TMPDIR inside a fixed root is still honoured", () => {
    const before = process.env.TMPDIR;
    const inside = mkdtempSync(join("/tmp", "bw-sel-"));
    try {
      process.env.TMPDIR = inside;
      expect(isScratchPath(join(inside, STATE))).toBe(true);
    } finally {
      if (before === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before;
      rmSync(inside, { recursive: true, force: true });
    }
  });
});

describe("#1175 review: the six spellings of an escape", () => {
  // Five of these were already refused before the review; they are the
  // controls that say the design holds, and they are locked so the next
  // review can be answered with a run. The sixth, `$X`, was the one leak.
  const RUN = `${process.env.HOME}/.rungate/victim`;
  const cases: [string, string][] = [
    ["an unexpanded $X — the one that leaked", `echo x > /tmp/$X/${STATE}`],
    ["the brace form", `echo x > /tmp/\${X}/${STATE}`],
    ["a command substitution with no space in it", `echo x > /tmp/\`id\`/${STATE}`],
    ["the same through $()", `echo x > /tmp/$(id)/${STATE}`],
    ["climbing out with ..", `echo x > /tmp/../${RUN.slice(1)}/${STATE}`],
    ["$HOME, which is not an absolute path until the shell expands it", `echo x > $HOME/.rungate/v/${STATE}`],
    ["a tilde, same reason", `echo x > ~/.rungate/v/${STATE}`],
  ];
  test.each(cases)("%s is refused", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("refusing `$` costs the fixtures nothing", () => {
    // The negative control for the widening: a plain fixture must still clear,
    // or the refusal above is just the guard turning itself off.
    expect(decideBashWrite(`echo x > ${FIX}/${STATE}`).blocked).toBe(false);
  });
});

describe("#1175 review: a link made by the same command voids the exemption", () => {
  // Recorded as unmeasured by the reviewer. Built here, and it is worse than
  // the race that was described: no second actor and no timing window are
  // needed, because the link and the write fit in one command.
  const RUN = `${process.env.HOME}/.rungate/victim`;
  const cases: [string, string][] = [
    ["&& chained", `ln -s ${RUN} /tmp/esc && echo x > /tmp/esc/${STATE}`],
    ["semicolon", `ln -s ${RUN} /tmp/esc; echo x > /tmp/esc/${STATE}`],
    ["a heredoc write after the link", `ln -s ${RUN} /tmp/esc\ncat > /tmp/esc/${STATE} <<'EOF'\n{}\nEOF`],
    ["symlinkSync inside an interpreter body", `bun -e 'symlinkSync("${RUN}","/tmp/esc"); writeFileSync("/tmp/esc/${STATE}","{}")'`],
    ["python's os.symlink", `python3 -c "os.symlink('${RUN}','/tmp/esc'); open('/tmp/esc/${STATE}','w').write('x')"`],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("the traversal half is real, not theoretical", () => {
    // Executed rather than asserted: a write through a link lands at the
    // link's target. Proved with a harmless filename, because the live
    // BashWriteGuard refuses the real one — correctly.
    const dir = mkdtempSync(join(tmpdir(), "bw-tgt-"));
    const link = join(mkdtempSync(join(tmpdir(), "bw-src-")), "esc");
    try {
      symlinkSync(dir, link);
      writeFileSync(join(link, "SENTINEL"), "through");
      expect(readFileSync(join(dir, "SENTINEL"), "utf8")).toBe("through");
    } finally {
      rmSync(dirname(link), { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CONTROL: a write into a real scratch directory is a fixture (#2859)", () => {
    // If this went red the link rule would be refusing every write, and every
    // fixture would return to being refused.
    expect(decideBashWrite(`echo x > ${FIX}/${STATE}`).blocked).toBe(false);
    expect(decideBashWrite(`bun run learn.ts > ${FIX}/${STATE}`).blocked).toBe(false);
    expect(decideBashWrite(`echo kiln > ${FIX}/${STATE}`).blocked).toBe(false);
  });
});

describe("#1175 review: the hook arm keeps the exemption — REFUSED suggestion", () => {
  /**
   * The review asked for the scratch exemption to be restricted to
   * `PROTECTED_FILES`, leaving `PROTECTED_HOOKS` matching in every tree.
   *
   * Refused, and these are the rows that say why. Every real hook path stays
   * blocked with or without the restriction, so it buys nothing; the ONLY
   * behaviour it changes is refusing a hook file inside a scratch tree, which
   * is the exact false positive #1175 exists to remove — `cp -p
   * <real hook> /tmp/cmp/old-guard.hook.ts` is a recorded one, staging a
   * comparison copy.
   *
   * Locked as a test so it is not raised a third time.
   */
  const REAL = [
    `echo x > ${process.env.HOME}/.claude/hooks/X.hook.ts`,
    `echo x > /tmp/../${(process.env.HOME ?? "").slice(1)}/.claude/hooks/X.hook.ts`,
    `cp evil.ts ${LIVE}/hooks/X.hook.ts`,
    `chmod 777 ${process.env.HOME}/.claude/hooks/X.hook.ts`,
    `echo x > ${LIVE}/hooks/X.hook.ts`,
  ];
  test.each(REAL)("a hook OUTSIDE a scratch tree is still refused: %s", cmd => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  // #2859: each fixture writes into a directory that exists, as a real one does.
  const FIXTURES = [
    `cp -p /Users/x/hooks/Guard.hook.ts ${FIX}/old-guard.hook.ts`,
    `echo x > ${FIX}/hooks/X.hook.ts`,
    `chmod 777 ${FIX}/X.hook.ts`,
  ];
  test.each(FIXTURES)("a hook INSIDE one is the false positive #1175 removes: %s", cmd => {
    const d = decideBashWrite(cmd);
    expect(d.blocked, `refused: ${d.reason}`).toBe(false);
  });
});

describe("#1175 review: a command substitution containing a SPACE — pre-existing, not this change", () => {
  /**
   * Found while building the six-spellings table. `writeTargets` reads an
   * operand as a WORD, and a word ends at whitespace, so
   *
   *     echo x > /tmp/`id -un`/workflow-state.json
   *
   * yields the target `/tmp/\`id` — which names no protected artifact, so arm
   * 1 never fires. The scratch exemption is not involved: `isScratchPath`
   * refuses every one of these spellings.
   *
   * Measured on `origin/main` as well, including at a live run-store path, so
   * it is a pre-existing limit of operand reading and NOT something #1175
   * introduced. Filed separately rather than fixed here — widening `readWord`
   * across whitespace is a change to the arm every other check depends on.
   *
   * What is asserted here is this module's own half, so a future fix to
   * `readWord` lands on a guard that already refuses the path.
   */
  const spellings = [`/tmp/\`id -un\`/${STATE}`, `/tmp/$(id -un)/${STATE}`, `/tmp/\`id\`/${STATE}`, `/tmp/$(id)/${STATE}`];
  test.each(spellings)("isScratchPath refuses %s", p => {
    expect(isScratchPath(p)).toBe(false);
  });
});

describe("#1175 review: the invariant must not switch the exemption off", () => {
  /**
   * Found by sweeping my own fix. The first version of the invariant dropped
   * any scratch root containing a protected tree — and `RUNGATE_WORK_DIR=
   * /tmp/e2e-gate-test` is a real corpus command, a harness deliberately
   * putting the run store in scratch for a test. Under it, `/tmp` contained a
   * protected tree, `/tmp` was dropped, and every fixture on the machine went
   * back to being refused. Measured before the clause was added.
   *
   * A guard that turns itself off under one environment variable is worse
   * than the hole it was closing, so a protected tree that is ITSELF inside a
   * fixed root no longer drops that root.
   */
  const withEnv = <T,>(env: Record<string, string | undefined>, fn: () => T): T => {
    const before: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) before[k] = process.env[k];
    try {
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      return fn();
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  test("a run store inside /tmp does not drop /tmp", () => {
    withEnv({ RUNGATE_WORK_DIR: "/tmp/e2e-gate-test" }, () => {
      expect(isScratchPath(`/tmp/p/${STATE}`)).toBe(true);
    });
  });

  test("a run store OUTSIDE scratch is still never exempt, however TMPDIR is pointed", () => {
    withEnv({ RUNGATE_WORK_DIR: "/opt/runs", TMPDIR: "/opt/runs" }, () => {
      expect(isScratchPath(`/opt/runs/v/${STATE}`)).toBe(false);
      expect(isScratchPath(`/tmp/p/${STATE}`)).toBe(true); // and the guard is still alive
    });
  });

  test("the fixed roots survive every environment in this block", () => {
    // The negative control for all of the above: if this ever goes red, the
    // invariant has started eating the roots again and the 37 cleared
    // commands are quietly back to being refused.
    for (const env of [
      { TMPDIR: undefined },
      { TMPDIR: `${process.env.HOME}/.rungate` },
      { RUNGATE_WORK_DIR: "/tmp/x" },
      { RUNGATE_WORK_DIR: "/opt/runs", TMPDIR: "/opt/runs" },
    ]) {
      withEnv(env, () => {
        expect(isScratchPath(`/tmp/p/${STATE}`), JSON.stringify(env)).toBe(true);
      });
    }
  });
});

describe("#1175 review round 2: live trees are SUBTRACTED, not approximated", () => {
  /**
   * Round one vetted the ROOT LIST against the run store. Round two subtracts
   * the live trees from the exemption directly, which is the property rather
   * than a proxy for it: it holds for a root nobody has added yet.
   *
   * The two mechanisms are not interchangeable and the difference is
   * measured. Dropping a ROOT that contains a protected tree removes `/tmp`
   * wholesale as soon as `RUNGATE_WORK_DIR` points inside it; subtracting the
   * TREE removes only that subtree. Both rows are below.
   */
  const H = process.env.HOME!;
  const withEnv = <T,>(env: Record<string, string | undefined>, fn: () => T): T => {
    const before: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) before[k] = process.env[k];
    try {
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      return fn();
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  const rows: [string, Record<string, string | undefined>, string, boolean][] = [
    ["a plain fixture", {}, `/tmp/p/${STATE}`, true],
    ["the run store", {}, `${H}/.rungate/v/${STATE}`, false],
    ["the run store with TMPDIR aimed at it", { TMPDIR: `${H}/.rungate` }, `${H}/.rungate/v/${STATE}`, false],
    ["…and /tmp is still alive under that TMPDIR", { TMPDIR: `${H}/.rungate` }, `/tmp/p/${STATE}`, true],
    ["a run store relocated INTO /tmp — the subtree is subtracted", { RUNGATE_WORK_DIR: "/tmp/e2e" }, `/tmp/e2e/s/${STATE}`, false],
    ["…and the rest of /tmp survives, which the root-vetting version did not", { RUNGATE_WORK_DIR: "/tmp/e2e" }, `/tmp/p/${STATE}`, true],
    ["the WIRED hook tree, even in a /tmp worktree", { RUNGATE_HOOKS_DIR: "/tmp/wg97/hooks" }, "/tmp/wg97/hooks/X.hook.ts", false],
    ["a /tmp worktree nothing registers is still a fixture", { RUNGATE_HOOKS_DIR: "/tmp/wg97/hooks" }, "/tmp/rv1188/hooks/X.hook.ts", true],
    ["~/.pai/hooks", {}, `${H}/.pai/hooks/X.hook.ts`, false],
    ["~/.claude/hooks", {}, `${H}/.claude/hooks/X.hook.ts`, false],
    ["staging a comparison copy — the recorded false positive", {}, "/tmp/cmp/old-guard.hook.ts", true],
  ];
  test.each(rows)("%s", (_label, env, path, want) => {
    expect(withEnv(env, () => isScratchPath(path))).toBe(want);
  });
});

describe("#1175 review round 2: PROTECTED_HOOKS keeps the exemption, for a measured reason", () => {
  /**
   * The restriction was raised twice. Round one argued a regression and there
   * was none. Round two argued something sharper and TRUE — a `.hook.ts`
   * under `/tmp` is as likely to be a real checkout as a fixture, because
   * worktrees under `/tmp` are routine here.
   *
   * The counter-argument offered for refusing it a second time — that a hook
   * source in a checkout is never the live hook — is FALSE on this machine.
   * Every registration in `~/.claude/settings.json` is spelled
   * `${PAI_HOOKS_DIR}/…` or `${RUNGATE_HOOKS_DIR}/…`, and
   * `lib/hook-target-tree.ts` records `RUNGATE_HOOKS_DIR` resolving to a
   * checkout that was not this one, with fourteen hooks running from it and
   * a merged security fix never reaching the bytes that execute.
   *
   * So neither "refuse the exemption" nor "trust the checkout" is right. The
   * wired tree is subtracted wherever it is; an unwired one stays a fixture.
   * These rows are the ones the restriction would change, and they are the
   * bug #1175 exists to fix.
   */
  // #2859: each fixture writes into a directory that exists, as a real one does.
  const fixtures = [
    `cp -p /Users/x/hooks/Guard.hook.ts ${FIX}/old-guard.hook.ts`,
    `rm -f ${FIX}/hooks/X.hook.ts`,
    `cp /Users/jhorn/.pai/hooks/DocHygiene.hook.ts /tmp/DocHygiene.hook.ts.bak-299`,
  ];
  test.each(fixtures)("a hook in an unwired scratch tree is a fixture: %s", cmd => {
    const d = decideBashWrite(cmd);
    expect(d.blocked, `refused: ${d.reason}`).toBe(false);
  });

  test("the alternative — excluding every git work tree — is a proxy, and these rows say so", () => {
    // Priced on the corpus: it costs 0 of the 37, same as the subtraction, so
    // the corpus does NOT decide between them. It is declined on a ground the
    // corpus cannot see: it answers "is this a checkout", and the property is
    // "is this live". It misses a wired tree that is not a git work tree, and
    // it refuses a fixture built inside a worktree — which is what the agents
    // on this repo do.
    //
    // BUILT, not asserted about the ambient cwd. The first version of this
    // case read `process.cwd()`, which is under /tmp on the machine the
    // branch was written on and under /home/runner on the CI runner: it
    // asserted the environment rather than the code, passed locally and went
    // red on shard 3 only. The difference is removed here rather than the
    // failure.
    // `/tmp` rather than `tmpdir()`: it is a literal fixed root on both
    // platforms, so the row cannot depend on what TMPDIR happens to be on
    // the machine reading it — which is the defect this case just had.
    const tree = mkdtempSync(join("/tmp", "bw-wt-"));
    const plain = mkdtempSync(join("/tmp", "bw-plain-"));
    try {
      mkdirSync(join(tree, ".git"));
      mkdirSync(join(tree, "hooks"));
      const hook = join(tree, "hooks", "X.hook.ts");
      writeFileSync(hook, "// fixture\n");
      const loose = join(plain, "X.hook.ts");
      writeFileSync(loose, "// fixture\n");

      // the proxy, written out so its cost is visible rather than described
      const inGitWorkTree = (p: string): boolean => {
        let d = dirname(p);
        while (d !== "/") {
          if (existsSync(join(d, ".git"))) return true;
          d = dirname(d);
        }
        return false;
      };

      // the row the two rules disagree on: scratch, a work tree, unwired
      expect(inGitWorkTree(hook)).toBe(true); // the proxy refuses it
      expect(isScratchPath(hook)).toBe(true); // the shipped rule exempts it

      // and the control, so the proxy is not simply always true
      expect(inGitWorkTree(loose)).toBe(false);
      expect(isScratchPath(loose)).toBe(true);
    } finally {
      rmSync(tree, { recursive: true, force: true });
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("#1175 review round 2: the expansion predicate stays narrow", () => {
  test("the wide predicate would refuse a real fixture; the narrow one does not", () => {
    // A review proposed /[$`*?~\\]|\$\(|\{/. Priced: 1 of the 37 cleared goes
    // back to refused — a glob cleanup — and 975 corpus commands match it
    // against 211 for the narrow one. The extra breadth buys only cases that
    // were already blocked.
    // #1367: the directory is made real first. The corpus command ran when
    // it existed; with it absent the chain property refuses it, which the
    // #1367 sweep reports as a disk-state cost rather than a live one.
    inScratch(root => {
      mkdirSync(join(root, "pai-wrongfix"));
      const glob = `rm -f ${root}/pai-wrongfix/*.hook.ts && rmdir ${root}/pai-wrongfix`;
      expect(decideBashWrite(glob).blocked).toBe(false);
    });
    expect(/[$`*?~\\]|\$\(|\{/.test("/tmp/713-battery/pai-wrongfix/*.hook.ts")).toBe(true); // the wide one fires
    expect(/[$`]/.test("/tmp/713-battery/pai-wrongfix/*.hook.ts")).toBe(false); // the shipped one does not
    // and the leak the narrow one exists for is still closed
    expect(isScratchPath(`/tmp/$X/${STATE}`)).toBe(false);
  });
});

describe("#1175 review round 3: the verb is resolved, not pattern-matched", () => {
  /**
   * `exemptionIsVoid` tested `/(?:^|[\s;&|(])ln\s/` against the raw command,
   * which needs whitespace or a separator immediately before `ln`. Two
   * spellings the shell resolves identically walked straight past it, and
   * this is the control the entire scratch exemption rests on.
   *
   * The fix is `commandWord` per segment rather than a wider regex: it
   * already strips a leading path and a leading `\`, and already skips the
   * wrappers, because #1120 and #1184 taught it to. One tokeniser, not two.
   */
  const RUN = `${process.env.HOME}/.rungate/victim`;
  const spellings = [
    ["plain", `ln -s ${RUN} /tmp/x`],
    ["sudo wrapper", `sudo ln -s ${RUN} /tmp/x`],
    ["path-qualified — walked past the old regex", `/bin/ln -s ${RUN} /tmp/x`],
    ["backslash-escaped — walked past it too", `\\ln -s ${RUN} /tmp/x`],
    ["env wrapper", `env ln -s ${RUN} /tmp/x`],
    ["xargs wrapper", `xargs ln -s ${RUN} /tmp/x`],
    ["via find -exec, which resolves to `find`", `find . -exec ln -s ${RUN} /tmp/x \;`],
  ];
  test.each(spellings)("%s voids the exemption", (_label, link) => {
    expect(decideBashWrite(`${link} && echo y > /tmp/x/${STATE}`).blocked).toBe(true);
  });

  test("CONTROL: words that merely contain the letters do not void it", () => {
    // If these go red the voiding has become a substring match and every
    // fixture whose path happens to contain `ln` is refused.
    for (const cmd of [
      `echo kiln > ${FIX}/${STATE}`,
      `bun run learn.ts > ${FIX}/${STATE}`,
      `echo x > ${FIX}/${STATE}`,
    ]) {
      const d = decideBashWrite(cmd);
      expect(d.blocked, `refused: ${cmd} — ${d.reason}`).toBe(false);
    }
  });
});

/**
 * #1411: `ln` is not the only verb that makes a link.
 *
 * Raised as a CRITICAL by the review on #1354, a PR that does not touch
 * this file. Every row below was run as a command and observed ALLOWED
 * before `flagMakesLink` existed — the bypass the `exemptionIsVoid`
 * docblock describes for `ln -s`, reached by a verb the four alternatives
 * of `LINK_CREATION` do not spell.
 *
 * Seven of the ten walk around a test for the literal string `cp -s`,
 * which is why the reading is token-level and the clusters are derived
 * rather than listed.
 *
 * No corpus sweep can witness any of this, and the reason is worth stating
 * where the rows are: nobody has ever run `cp -s` to walk this guard, so it
 * is absent from 132,638 historical commands BY CONSTRUCTION. A sweep is a
 * regression control. It answers "did I break anything that happened",
 * never "did I close anything that could happen".
 *
 * #1367 deleted the flag reader these rows were written against, along with
 * the rest of the verb list. The rows stay, unchanged, as witnesses that
 * every spelling is still refused — now by the chain property, because
 * `/tmp/esc` is a directory nothing made. They pass whatever the verb is,
 * which is the point; the mutation tests that pinned the flag reader went
 * with it, and the nested reading's is rewritten against what it now feeds.
 */
describe("#1411 WITNESS: a link made by a verb that is not `ln`", () => {
  const VICTIM = `${process.env.HOME}/.rungate/victim`;
  const esc = (mk: string) => `${mk} && echo '{}' > /tmp/esc/${STATE}`;

  const voids: [string, string][] = [
    ["ln -s, the documented shape, unchanged", `ln -s ${VICTIM} /tmp/esc`],
    ["cp -s", `cp -s ${VICTIM} /tmp/esc`],
    ["cp --symbolic-link", `cp --symbolic-link ${VICTIM} /tmp/esc`],
    ["cp --sym, an abbreviation GNU accepts", `cp --sym ${VICTIM} /tmp/esc`],
    // A hard link aims the later write at the victim's INODE. Same bypass,
    // one indirection fewer.
    ["cp -l, a HARD link to the victim's inode", `cp -l ${VICTIM} /tmp/esc`],
    ["cp --link", `cp --link ${VICTIM} /tmp/esc`],
    ["cp -rs, clustered", `cp -rs ${VICTIM} /tmp/esc`],
    ["cp -as, clustered", `cp -as ${VICTIM} /tmp/esc`],
    ["cp -sv, clustered the other way", `cp -sv ${VICTIM} /tmp/esc`],
    ["/bin/cp -s, path-qualified", `/bin/cp -s ${VICTIM} /tmp/esc`],
    ["sudo cp -s, wrapped", `sudo cp -s ${VICTIM} /tmp/esc`],
    ["install -l s, which also makes links", `install -l s ${VICTIM} /tmp/esc`],
    // The position `LINK_CREATION` exists to reach for `ln`: `commandWord`
    // resolves this segment to `find`, so a verb-keyed reading would miss it
    // and the scan is position-independent for that reason.
    ["find -exec cp -s, where the verb resolves to `find`", `find . -exec cp -s ${VICTIM} /tmp/esc \\;`],

    // The review on #1429 raised these as a CRITICAL and it was right:
    // the first reading tokenised with `stripQuoted`, which DELETES a
    // quoted span's content, so quoting the flag removed it from the
    // token stream entirely. Seven spellings, every one a command the
    // shell runs identically to the row above, and all seven were
    // observed ALLOWED before `shellTokens` replaced it.
    ["cp with the FLAG single-quoted", `cp '-s' ${VICTIM} /tmp/esc`],
    ["cp with the FLAG double-quoted", `cp "-s" ${VICTIM} /tmp/esc`],
    ["cp with the flag partly quoted", `cp -'s' ${VICTIM} /tmp/esc`],
    ["cp with the VERB spliced by an empty string", `c""p -s ${VICTIM} /tmp/esc`],
    ["cp with the verb quoted", `'cp' -s ${VICTIM} /tmp/esc`],
    ["cp with verb and flag both quoted", `'cp' '-s' ${VICTIM} /tmp/esc`],
    ["cp with the long flag quoted", `cp '--symbolic-link' ${VICTIM} /tmp/esc`],
    // A flag whose letters cannot be read is one that cannot be ruled out,
    // on a verb already known to make links on request. Fail-closed, and
    // measured: 0 of 174 real `cp`/`install` commands in the corpus move.
    ["cp with the flag behind a variable", `cp "-$F" ${VICTIM} /tmp/esc`],
    ["cp with the flag behind a brace expansion", `cp -\${OPT} ${VICTIM} /tmp/esc`],
    ["cp with the verb double-quoted", `"cp" -s ${VICTIM} /tmp/esc`],
    ["cp with one letter of the long flag quoted", `cp --'s'ymbolic-link ${VICTIM} /tmp/esc`],
    ["cp with the flag last, as getopt permits", `cp ${VICTIM} /tmp/esc -s`],

    // The ATTACHED OPTION ARGUMENT, which neither the fix nor its first
    // review caught. `-st/tmp/esc` bundles `-s` with `-t`'s argument and
    // `-sS.bak` bundles it with `-S`'s; an anchored `^-[A-Za-z]+$` rejected
    // the whole token on the `/` and the `.` and never read the `s`.
    ["cp -st/tmp/esc, the link letter bundled with an attached argument", `cp -st/tmp/esc ${VICTIM}`],
    ["cp -sS.bak, the same through a suffix argument", `cp -sS.bak ${VICTIM} /tmp/esc`],
    ["cp -lt/tmp/esc, the hard-link letter bundled", `cp -lt/tmp/esc ${VICTIM}`],

    // Text handed to ANOTHER shell. `ln` is caught in all four of these by
    // `LINK_CREATION`, which is a raw-text regex and does not care about
    // nesting; a reading built on segments and tokens does, so all four
    // were measured allowed for `cp` while their `ln` twins were refused.
    ["cp -s inside bash -c", `bash -c 'cp -s ${VICTIM} /tmp/esc'`],
    ["cp -s inside sh -c with double quotes", `sh -c "cp -s ${VICTIM} /tmp/esc"`],
    ["cp -s inside a command substitution", `$(cp -s ${VICTIM} /tmp/esc)`],
    ["cp -s inside eval", `eval 'cp -s ${VICTIM} /tmp/esc'`],

    // ESCAPE REMOVAL, the transform the previous two rounds did not read.
    // Confirmed against the shell rather than assumed: `printf '[%s]' -\s
    // -\l -r\s -\-symbolic-link --sy\mbolic-link` prints
    // `[-s][-l][-rs][--symbolic-link][--symbolic-link]`, so every one of
    // these reaches `cp` as a flag the bare rows above are refused for.
    // All five were measured ALLOWED: against the raw token the leading
    // letter run reads `''` and the long name fails its prefix test.
    ["cp -\\s, the short letter escaped", `cp -\\s ${VICTIM} /tmp/esc`],
    ["cp -\\l, the hard-link letter escaped", `cp -\\l ${VICTIM} /tmp/esc`],
    ["cp -r\\s, an escape inside the cluster", `cp -r\\s ${VICTIM} /tmp/esc`],
    // Both branches, not just the short one: the escape can hide the second
    // dash, which moves the token out of the `--` branch entirely, or sit
    // inside the long name, which defeats the prefix test.
    ["cp -\\-symbolic-link, the second DASH escaped", `cp -\\-symbolic-link ${VICTIM} /tmp/esc`],
    ["cp --sy\\mbolic-link, an escape inside the long name", `cp --sy\\mbolic-link ${VICTIM} /tmp/esc`],

    // SUBSTITUTION GROUPING, the two spellings the first nested reading
    // missed. Backticks were absent from it altogether; `$(…)` was read by
    // a flat `/\$\(([^()]*)\)/` that cannot match a substitution containing
    // parentheses, so for the first of these it matched only the INNER
    // `$(echo …)` and the outer body carrying `cp -s` was never read.
    ["cp -s inside BACKTICKS", "`cp -s " + VICTIM + " /tmp/esc`"],
    ["cp -s inside backticks inside eval", "eval `cp -s " + VICTIM + " /tmp/esc`"],
    // Seen NOT moving under the nested mutation, the way `ln -s` is seen
    // not moving under the flag mutation: `LINK_CREATION` is a raw-text
    // regex and holds this one however the grouping is read.
    ["ln -s inside backticks, the family control", "`ln -s " + VICTIM + " /tmp/esc`"],
    ["cp -s in a $( ) containing a nested $( )", `$(cp -s $(echo ${VICTIM}) /tmp/esc)`],
    ["cp -s in a $( ) wrapping a parenthesised subshell", `$( (cp -s ${VICTIM} /tmp/esc) )`],
  ];
  test.each(voids)("%s voids the exemption", (_l, mk) => {
    expect(decideBashWrite(esc(mk)).blocked, esc(mk)).toBe(true);
  });

  /**
   * The load-bearing half. A rule that refused every `cp` would pass every
   * row above and make the guard useless, so each refusal is paired with the
   * nearest spelling that must stay exempt.
   *
   * #2859: each row writes into a directory that exists before the command
   * is judged (`FIX`), as a real fixture does; a missing directory is never
   * exempt. The rows copy INTO it, never build it with `cp -r src d`.
   */
  const stay: [string, string][] = [
    ["a plain cp into scratch", `cp /tmp/a/${STATE} ${FIX}/${STATE}`],
    ["cp -r, the commonest fixture copy", `cp -r /tmp/a/${STATE} ${FIX}/${STATE}`],
    ["cp -L, which follows links instead of making them", `cp -L /tmp/a/${STATE} ${FIX}/${STATE}`],
    ["cp -p", `cp -p /tmp/a/${STATE} ${FIX}/${STATE}`],
    ["cp -a", `cp -a /tmp/a/${STATE} ${FIX}/${STATE}`],
    // `-m755` attached: `writeTargets` reads a detached `-m 755` as a third
    // operand and the destination as a directory, which the chain property
    // then finds does not exist. A pre-existing misparse, not this change's.
    ["install -m755, a flag with neither letter", `install -m755 /tmp/a/${STATE} ${FIX}/${STATE}`],
    ["a plain redirect into a real directory", `echo '{}' > ${FIX}/${STATE}`],
    ["a path that merely contains the letters", `echo '{}' > ${FIX}/cp.d/${STATE}`],
    ["cp with a quoted FILENAME, not a flag", `cp 'a b.txt' ${FIX}/${STATE}`],
    ["cp '-L' quoted, which still creates no link", `cp '-L' /tmp/a/${STATE} ${FIX}/${STATE}`],
    ["cp '-r' quoted", `cp '-r' /tmp/a/${STATE} ${FIX}/${STATE}`],
    ["cp with a variable in the PATH rather than the flag", `cp -r "$SRC" ${FIX}/${STATE}`],
    // #2867: `-t` is now read, so its directory must exist, as a fixture's does
    ["cp -tDIR, an attached argument and no link letter", `cp -t${FIX} /tmp/a/${STATE} && echo '{}' > ${FIX}/${STATE}`],
    ["cp -S.bak, a suffix argument", `cp -S.bak /tmp/a/${STATE} ${FIX}/${STATE}`],
    ["cp --sparse=always, a long option that is not a link", `cp --sparse=always /tmp/a/${STATE} ${FIX}/${STATE}`],
    ["cp with a quoted filename containing a backslash", `cp 'a\\b.txt' ${FIX}/${STATE}`],
    ["cp with a backslash in the DESTINATION word", `cp /tmp/a/x ${FIX}/a\\b-${STATE}`],
  ];
  test.each(stay)("CONTROL: %s stays exempt", (_l, cmd) => {
    const d = decideBashWrite(cmd);
    expect(d.blocked, `refused: ${cmd} — ${d.reason}`).toBe(false);
  });


  /**
   * The FOURTH transform, raised on the PR for the first three: ANSI-C
   * quoting. `$'-s'` is the word `-s` and `$'-\163'` is too —
   * `printf '[%s]' $'-s' $'-\163' $'cp'` prints `[-s][-s][cp]` — and
   * reading the `$` as an ordinary character left the token `$-s`, which
   * never met `isLinkFlag`'s `startsWith('-')` precondition.
   *
   * It is read in `readWord` rather than in `isLinkFlag`, and the last two
   * rows are why: what `$'…'` hides can be the VERB, and a hidden verb
   * never reaches a flag test at all. `LINK_CREATION` does not hold the
   * `ln` rows here either — `\bln\s` needs `ln` followed by whitespace and
   * `$'ln'` has a quote in the way — so unlike every other `ln` row in this
   * file these two are held by the tokeniser.
   */
  const ansiC: [string, string][] = [
    ["cp $'-s'", `cp $'-s' ${VICTIM} /tmp/esc`],
    ["cp $'-\\163', the letter in octal", `cp $'-\\163' ${VICTIM} /tmp/esc`],
    ["cp $'-\\x73', the letter in hex", `cp $'-\\x73' ${VICTIM} /tmp/esc`],
    ["cp $'--symbolic-link'", `cp $'--symbolic-link' ${VICTIM} /tmp/esc`],
    ["$'cp' -s, the VERB hidden", `$'cp' -s ${VICTIM} /tmp/esc`],
    ["$'ln' -s, the ln verb hidden from the raw-text regex too", `$'ln' -s ${VICTIM} /tmp/esc`],
    ["$'\\154n' -s, the ln verb in octal", `$'\\154n' -s ${VICTIM} /tmp/esc`],
  ];
  test.each(ansiC)("%s voids the exemption", (_l, mk) => {
    expect(decideBashWrite(esc(mk)).blocked, esc(mk)).toBe(true);
  });

  /**
   * An ANSI-C quote left open swallows the redirect operator, which is
   * #1205's shape. The plain `'` and `"` spellings were already refused;
   * this one was ALLOWED, and `$` was the whole difference.
   */
  test("an open ANSI-C quote cannot swallow the operator", () => {
    expect(decideBashWrite(`cp $'-s /x /tmp/esc && echo ' {} > /tmp/esc/${STATE}`).blocked).toBe(true);
  });

  /**
   * The controls, and ONE of them changed direction, which is worth saying
   * out loud rather than leaving for someone to find.
   *
   * `cp $'-L'` was REFUSED before this change and is allowed now. It was
   * never refused for the flag: the `$` survived into the token stream and
   * made the path unprovable, so the fail-closed arm fired. `$'-L'` is
   * deterministically `-L`, creates no link, and `cp -L` is allowed — so
   * allowing it is the reading that agrees with the rest of the table.
   *
   * The relaxation is bounded to ANSI-C, and the last two rows are the
   * boundary: a variable and a command substitution in a path are still
   * unprovable and still refused, because unlike `$'…'` they are not
   * settled until the command runs.
   */
  const ansiCStay: [string, string, boolean][] = [
    ["cp $'-L', which creates no link", `cp $'-L' /tmp/a/${STATE} ${FIX}/${STATE}`, false],
    ["cp $'-r'", `cp $'-r' /tmp/a/${STATE} ${FIX}/${STATE}`, false],
    ["ANSI-C in a PATH is now resolvable", `echo '{}' > /tmp/$'${FIX.slice(5)}'/${STATE}`, false],
    ["a VARIABLE in a path is still unprovable", `echo '{}' > /tmp/$FIX/${STATE}`, true],
    ["a SUBSTITUTION in a path is still unprovable", `echo '{}' > /tmp/$(id -un)/${STATE}`, true],
  ];
  test.each(ansiCStay)("CONTROL: %s", (_l, cmd, blocked) => {
    expect(decideBashWrite(cmd).blocked, cmd).toBe(blocked);
  });

  /**
   * Octal and `\x` are BYTES in bash, not code points, which is why the
   * decode assembles bytes and decodes UTF-8 once at the end. Raised by a
   * push review on this branch, and the diagnosis was right.
   *
   * The shell half is executed rather than described, because the claim
   * this rests on is a claim about bash: all three spellings below emit the
   * same two bytes, which is the UTF-8 encoding of one character. A
   * per-escape `String.fromCharCode` would give U+00C3 U+00A9 instead — a
   * different string, four bytes — so above 0x7F the decoder would hand the
   * module a token the shell never produced.
   *
   * The next test is what settled the repair: refusing to decode above
   * 0x80 — the conservative option, and the one the review proposed — does
   * not close the hole it names, because an undecoded name is just a
   * directory nobody made and that is exempt.
   */
  test("bash emits BYTES for octal and \\x, which is why the decode assembles bytes", () => {
    // Whitespace-normalised, because BSD `od` and GNU `od` pad their columns
    // differently and the claim here is about the BYTES. Pinning the padding
    // made this red on CI and green on the machine it was written on — a
    // detector narrower than the thing it detects.
    const hex = (a: string) =>
      // late-env-ok: the child is `printf` under bash, which reads no RUNGATE
      // variable and no TMPDIR — every escape is a literal on its command line.
      spawnSync("/bin/bash", ["-c", `printf '%s' ${a} | od -An -tx1`], { encoding: "utf8" })
        .stdout.trim()
        .replace(/\s+/g, " ");
    expect(hex(String.raw`$'\303\251'`)).toBe("c3 a9");
    expect(hex(String.raw`$'\xc3\xa9'`)).toBe("c3 a9");
    expect(hex("$'é'")).toBe("c3 a9");
    // The ASCII side still agrees, which is what keeps the octal and hex
    // void rows above meaningful rather than accidental.
    expect(hex(String.raw`$'\163'`)).toBe("73");
    expect(hex(String.raw`$'\x73'`)).toBe("73");
  });

  /**
   * And the consequence, executed: a symlink out of scratch whose NAME is
   * non-ASCII. Every spelling of that name must reach the same verdict,
   * because the shell reaches the same file.
   *
   * This is the row that chose the implementation. The first repair for
   * the byte differential was to refuse to decode above 0x80, and it does
   * NOT close this: an undecoded `caf\303\251` is simply a directory that
   * does not exist, and a non-existent directory under a scratch root is
   * exempt — the last row is that control. The conservative answer and the
   * wrong answer were the same answer, which is why the decode assembles
   * bytes instead.
   */
  test("every spelling of a non-ASCII symlink name reaches the same verdict", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "bw-ansi-")));
    try {
      symlinkSync("/usr", join(dir, "café")); // stands in for the run store
      const write = (name: string) => decideBashWrite(`echo '{}' > ${dir}/${name}/${STATE}`).blocked;
      expect(write("café"), "the literal name").toBe(true);
      expect(write(String.raw`$'café'`), "ANSI-C, literal character").toBe(true);
      expect(write(String.raw`$'caf\303\251'`), "ANSI-C, the two UTF-8 bytes in octal").toBe(true);
      expect(write(String.raw`$'caf\xc3\xa9'`), "ANSI-C, the two UTF-8 bytes in hex").toBe(true);
      expect(write("$'caf\\u00e9'"), "ANSI-C, the CODE POINT rather than the bytes").toBe(true);
      // The control that makes the four above mean something: a REAL
      // directory under a plain name stays exempt. Without it, a decoder that
      // resolved everything to nonsense would pass. (#1367: it used to be a
      // name nobody created, which the chain property now refuses.)
      mkdirSync(join(dir, "plain"));
      expect(write("plain"), "a real directory").toBe(false);
      expect(write(String.raw`$'pla\x69n'`), "the same name, spelled with an escape").toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * MUTATION: the octal escape decoded as a CODE POINT instead of a byte.
   *
   * This is not a removal, it is the WRONG FIX — the spelling the decoder
   * had before the symlink row above was measured, and the one anybody
   * writes first. The fifth shape in
   * `.claude/rules/checks-must-be-able-to-fail.md` is a case that goes
   * green under the cheapest wrong repair, so the repair is applied here
   * and the case is watched going red.
   *
   * The literal row must stay refused under the mutant. That is what makes
   * this a differential rather than a mutant that breaks everything: the
   * fixture, the link and the verdict for the literal name are all held
   * fixed, and only the spelling of the name varies.
   */

});

describe("#1175 review round 3: a glob in a DIRECTORY component", () => {
  /**
   * `echo '{}' > /tmp/sym*​/workflow-state.json` with `/tmp/syma` a symlink
   * into the run store: the literal does not exist, the walk climbs past it
   * to `/tmp`, the path is exempted, and the shell then expands the glob
   * through the link. The same escape as the `ln` case with no `ln` in the
   * command to see.
   *
   * Only the DIRECTORY part is tested, and that is a measurement rather than
   * caution. A basename glob is already safe because the directory above it
   * is exactly what gets realpath'd — the executed proof is below. Refusing
   * it anyway costs a real command, `rm -f /tmp/.../*.hook.ts`, 1 of the 37
   * this branch clears.
   */
  test.each([`/tmp/sym*/${STATE}`, `/tmp/sym?/${STATE}`, `/tmp/[sx]ym/${STATE}`, `/tmp/{a,b}/${STATE}`])(
    "a glob in a directory component is not exempt: %s",
    p => {
      expect(isScratchPath(p)).toBe(false);
    },
  );

  test("a basename glob stays exempt, and the directory above it is still resolved", () => {
    // Both halves executed. The link makes the directory resolve out of
    // scratch, and the basename glob does not prevent that being seen — which
    // is why the refusal is scoped to the directory part.
    const src = mkdtempSync(join(tmpdir(), "bw-glob-"));
    const out = mkdtempSync(join(tmpdir(), "bw-out-"));
    try {
      expect(isScratchPath(join(src, "*.json"))).toBe(true); // a real scratch dir
      symlinkSync("/usr", join(src, "syma")); // now link it out of scratch
      expect(isScratchPath(join(src, "syma", "*.json"))).toBe(false); // caught
      expect(isScratchPath(join(src, "sym*", "x.json"))).toBe(false); // and the glob form
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("the real command a blanket metacharacter class would have cost", () => {
    // #1367: with its directory real, as it was when the command ran.
    inScratch(root => {
      mkdirSync(join(root, "pai-wrongfix"));
      expect(decideBashWrite(`rm -f ${root}/pai-wrongfix/*.hook.ts`).blocked).toBe(false);
    });
  });
});

/**
 * A root that is absolute and is not any platform's scratch tree.
 *
 * Separate from #1197's `LIVE` on purpose: that PR is open against this same
 * file and declares its own constant at the top. A second identifier in a
 * region #1197 does not touch is one merge without a conflict; a second
 * declaration of the same name is a conflict for whoever rebases last.
 *
 * Witnesses below use it rather than `/tmp` because #1197 makes `/tmp` the
 * one place a protected NAME is not a protected ARTIFACT. A witness planted
 * under `/tmp` passes today and flips to ALLOW the moment #1197 lands — it
 * would be asserting the false positive that PR exists to remove.
 */
const LIVE_TREE = "/opt/bwprobe";

/** A backslash-newline, spelled once so the witnesses read as commands. */
const CONT = " \\\n  ";

describe("#1203 WITNESS: a line continuation must not separate a verb from its target", () => {
  // The shell joins `\` + newline into one command BEFORE it does anything
  // else. `segments()` split on the newline instead, so each continuation
  // line became its own "command" and the verb never met its target. All six
  // rows are ALLOW on `origin/main` @ dbf10445 and must be BLOCK.
  const cases: [string, string][] = [
    ["cp, whose destination is on the next line", `cp /tmp/x.json${CONT}${LIVE_TREE}/${STATE}`],
    ["mv, same shape", `mv /tmp/x${CONT}${LIVE_TREE}/${STATE}`],
    ["chmod reached through two continuations", `chmod${CONT}777${CONT}${LIVE}/h/Y.hook.ts`],
    ["rm of the salt, continued", `rm${CONT}${LIVE_TREE}/${SALT}`],
    ["tee, whose file operand is continued", `tee${CONT}${LIVE_TREE}/${STATE}`],
    ["a redirect whose target is on the continuation line", `echo x >${CONT}${LIVE_TREE}/${SALT}`],
    ["a continuation inside an interpreter invocation", `python3 -c${CONT}"open('${LIVE_TREE}/${SALT}','w').write('x')"`],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });
});

describe("#1203 CONTROL: the join is the shell's join, not a blanket one", () => {
  test("a backslash at end of line INSIDE single quotes is literal, not a continuation", () => {
    // The cheapest wrong fix is `cmd.replace(/\\\n/g, ' ')` at the top of
    // segments(). It passes every witness above and fails this row: inside a
    // single quote the backslash is data, and the newline is data too.
    const quoted = "echo 'a \\\nb'";
    expect(segments(quoted)).toEqual([quoted]);
  });

  test("an ESCAPED backslash at end of line does not swallow the newline", () => {
    // `\\` is one literal backslash; the newline after it still separates.
    // A naive scanner that consumes `\` then looks at the next character
    // reads the second `\` as the start of a continuation and joins two
    // genuinely separate commands into one.
    expect(segments("echo x \\\\\nls")).toEqual(["echo x \\\\", "ls"]);
  });

  test("F9: a real continued `git add` of hook sources stays allowed", () => {
    // Recovered from the corpus. Before the join this command's continuation
    // lines were read as commands in their own right, so `commandWord`
    // returned `hooks/GateEnforcement.hook.ts` — a FILENAME as a verb. That
    // mis-reading is the defect; joining must not turn the command into a
    // refusal, because `git add` writes nothing the guard protects.
    const cmd =
      `git -C /Users/jhorn/Projects/rungate add${CONT}lib/gate-enforcement.ts${CONT}` +
      `test/gate-enforcement.test.ts${CONT}hooks/GateEnforcement.hook.ts`;
    expect(decideBashWrite(cmd).blocked).toBe(false);
  });

  test("F10: a real continued `grep -rn` across hook sources stays allowed", () => {
    const cmd =
      `grep -rn 'MEMORY.*WORK'${CONT}~/.claude/hooks/AgentBriefGuard.hook.ts${CONT}` +
      `~/.claude/hooks/GateEnforcement.hook.ts`;
    expect(decideBashWrite(cmd).blocked).toBe(false);
  });

  test("a heredoc body's continuations are the document, not commands", () => {
    // The `pai-config#474` shape: a `gh` body written with a heredoc, whose
    // lines are backslash-continued and whose text quotes a protected name.
    const cmd = `gh issue create --body "$(cat <<'EOF'\nrun it with:\n  cp a \\\n  b/${STATE}\nEOF\n)"`;
    expect(decideBashWrite(cmd).blocked).toBe(false);
  });

  test("MECHANISM: a continued command is ONE segment", () => {
    // The join inserts NOTHING. `CONT` is a space, a backslash, a newline and
    // two spaces; removing the backslash-newline leaves the three spaces that
    // were really there. Every consumer splits on /\s+/ or skips whitespace,
    // so the run is invisible to them — and asserting the exact string is
    // what keeps "joined with nothing" distinguishable from "joined with a
    // space", which the next row shows is a real difference.
    expect(segments(`cp /tmp/x.json${CONT}${LIVE_TREE}/${STATE}`)).toEqual([
      `cp /tmp/x.json   ${LIVE_TREE}/${STATE}`,
    ]);
  });

  test("MECHANISM: a continuation INSIDE a verb rejoins the verb", () => {
    // `ch\<nl>mod 777 x.hook.ts` runs chmod — the shell removes the
    // backslash-newline with no separator, so the two halves are one token.
    // Joining with a SPACE instead resolves the command word to `ch` and the
    // arm-4 test never fires, so this row is what separates the two spellings
    // of the fix. It is also a bypass in its own right.
    expect(commandWord(segments("ch\\\nmod 777 /tmp/h/Y.hook.ts")[0])).toBe("chmod");
    expect(decideBashWrite(`ch\\\nmod 777 ${LIVE}/h/Y.hook.ts`).blocked).toBe(true);
  });
});

describe("#1205 WITNESS: a command substitution containing a space is one word", () => {
  // `readWord` ended the redirect operand at the first space, so a
  // substitution with an argument split the target in half and the surviving
  // fragment named no protected artifact. Arm 1 then never fired at all.
  const cases: [string, string][] = [
    ["a backtick substitution with an argument", "echo x > /tmp/`id -un`/" + STATE],
    ["the $() spelling of the same thing", `echo x > /tmp/$(id -un)/${STATE}`],
    ["the live run-store row — the witness #1205 names", "echo x > ~/.rungate/`id -un`/" + STATE],
    ["a nested substitution", `echo x > $(dirname $(echo /a/b))/${STATE}`],
    ["an UNTERMINATED substitution fails closed", `echo x > /tmp/$(id -un/${STATE}`],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("MECHANISM: the operand survives whole rather than as a fragment", () => {
    expect(writeTargets("echo x > /tmp/`id -un`/" + STATE)).toEqual(["/tmp/`id -un`/" + STATE]);
    expect(writeTargets(`echo x > /tmp/$(id -un)/${STATE}`)).toEqual([`/tmp/$(id -un)/${STATE}`]);
  });
});

describe("#1205 CONTROL: carrying the substitution is not refusing every $", () => {
  test("the space-free form stays blocked — it was never the defect", () => {
    expect(decideBashWrite("echo x > /tmp/`id`/" + STATE).blocked).toBe(true);
  });

  test("the already-quoted form stays blocked", () => {
    expect(decideBashWrite(`echo x > "$(dirname /a/b)"/${STATE}`).blocked).toBe(true);
  });

  test("a substitution-built path naming NOTHING protected stays allowed", () => {
    // This is the row that kills the cheapest wrong fix. #1205's acceptance
    // offers "OR the whole operand is refused as unreadable", and refusing
    // every operand containing `$(` or a backtick passes all five witnesses
    // above. It also refuses this, which is ordinary work.
    expect(decideBashWrite("echo x > $(mktemp -d)/out.txt").blocked).toBe(false);
    expect(decideBashWrite("echo x > /tmp/`date +%s`/log.txt").blocked).toBe(false);
  });

  test("an ordinary operand is read exactly as before", () => {
    expect(writeTargets("echo x > /tmp/plain.txt")).toEqual(["/tmp/plain.txt"]);
    expect(writeTargets("ls -la 2>&1")).toEqual([]);
    expect(writeTargets("ls -la 2>/dev/null")).toEqual([]);
  });

  test("a `>` INSIDE a substitution does not end the operand", () => {
    expect(writeTargets(`echo x > $(f > /dev/null; echo d)/${STATE}`)).toEqual([
      `$(f > /dev/null; echo d)/${STATE}`,
    ]);
  });
});

describe("#1146: the two gaps the issue names are already closed — locked, not re-fixed", () => {
  // Re-derived against `origin/main` @ dbf10445 before any code was written.
  // #1120 moved cp/mv destination extraction to the last non-option argument
  // and #1184/#1188 filled IN_PLACE. Every row below is BLOCK on main today.
  // They are regression locks, not new behaviour, and they are the reason
  // this PR adds two verbs rather than the eight the issue lists.
  const verbs: [string, string][] = [
    ["sed -i", `sed -i s/a/b/ ${LIVE_TREE}/${STATE}`],
    ["perl -i", `perl -i -pe s/a/b/ ${LIVE_TREE}/${STATE}`],
    ["dd of=", `dd of=${LIVE_TREE}/${STATE} if=/dev/zero`],
    ["truncate", `truncate -s0 ${LIVE_TREE}/${STATE}`],
    ["rm", `rm ${LIVE_TREE}/${SALT}`],
    ["ln", `ln -sf /tmp/a ${LIVE_TREE}/${STATE}`],
    ["install", `install -m644 /tmp/a ${LIVE_TREE}/${STATE}`],
    ["git checkout", `git checkout ${LIVE_TREE}/${STATE}`],
    ["git restore", `git restore ${LIVE_TREE}/${STATE}`],
    ["cp with a flag before the destination", `cp -p source.json ${LIVE_TREE}/${STATE}`],
    ["mv with a flag before the destination", `mv -f source.json ${LIVE_TREE}/${STATE}`],
    ["rsync with a flag before the destination", `rsync -a src ${LIVE_TREE}/${STATE}`],
  ];
  test.each(verbs)("%s already blocks on main", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });
});

describe("#1146 WITNESS: the two verbs the corpus says are worth adding", () => {
  test("chmod on a NON-hook protected artifact — a real corpus command", () => {
    // Arm 4 fired only on PROTECTED_HOOKS, so a permission change on the
    // gate salt was allowed. Recovered verbatim from the transcript corpus;
    // it is the single command this widening newly blocks in 5,059.
    const cmd = `chmod 600 /Users/jhorn/.claude/.claude/worktrees/agent-abbce86bb83ada9c6/hooks/lib/${SALT}`;
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("chflags on a protected file", () => {
    expect(decideBashWrite(`chflags uchg ${LIVE_TREE}/${STATE}`).blocked).toBe(true);
  });

  test("xattr -d on a hook — a real corpus command", () => {
    // Also recovered verbatim. Extended attributes are file metadata, and
    // `com.apple.provenance` is what was blocking writes to these hooks, so
    // removing it is a mutation of hook integrity by any reading.
    const cmd = "xattr -d com.apple.provenance /Users/jhorn/.pai/hooks/IssueCloseGuard.hook.ts";
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("xattr -w on a protected file", () => {
    expect(decideBashWrite(`xattr -w k v ${LIVE_TREE}/${STATE}`).blocked).toBe(true);
  });
});

describe("#1146 CONTROL: the verbs that did NOT earn their place", () => {
  test("a bare `xattr` is a READ and stays allowed", () => {
    // Two real corpus commands do exactly this. The broad `/\bxattr\b/`
    // newly blocks 3 commands of which these 2 are reads; the narrow
    // `-d`/`-w`/`-s` form newly blocks 1, and that one is the mutation
    // above. This row is what separates the two patterns.
    expect(decideBashWrite("xattr /Users/jhorn/.pai/hooks/IssueCloseGuard.hook.ts").blocked).toBe(false);
    expect(decideBashWrite("ls -la@ /Users/jhorn/.pai/hooks/IssueCloseGuard.hook.ts").blocked).toBe(false);
  });

  test("F11: chmod is still a COMMAND WORD test, not a substring one", () => {
    // Widening arm 4's TARGET list must not widen its VERB test.
    //
    // The obvious control here — #1120's `git show … | grep -nE
    // "chmod|chflags"` — is VACUOUS for this mutation, and it was written
    // that way first. It names no protected artifact, so the substring
    // reading finds nothing to refuse and the row passes under the wrong fix
    // as readily as under the right one. The separating shape has to carry
    // BOTH halves: the verb as data AND a protected artifact as the target.
    //
    // So this is a real command from the corpus. Seven read-only commands
    // there have that shape; the substring reading newly refuses all seven.
    const cmd =
      'grep -n "uchg\\|chflags\\|nouchg\\|schg" /Users/jhorn/.pai/hooks/BashWriteGuard.hook.ts 2>/dev/null';
    expect(decideBashWrite(cmd).blocked).toBe(false);
  });

  test("chmod on an unprotected path stays allowed", () => {
    expect(decideBashWrite("chmod 644 /tmp/notes.md").blocked).toBe(false);
  });

  test("touch, mkdir, mktemp and split were PRICED and left out", () => {
    // Measured on the 5,059 allowed commands naming a protected artifact:
    // touch 0 newly blocked, mkdir 1, mktemp 1, split 9 — and every one of
    // the 11 was read and is a false positive (`split` matches `.split(`
    // inside Python heredoc bodies; `mkdir -p <run store> && bun -e …` is
    // arm 3's business, not a mutation by `mkdir`). A verb that newly blocks
    // real work and catches nothing is a regression, so none shipped.
    expect(decideBashWrite(`touch ${LIVE_TREE}/${STATE}`).blocked).toBe(false);
    expect(decideBashWrite(`mkdir -p /Users/jhorn/.rungate/x && echo hi`).blocked).toBe(false);
  });
});

describe("#1203: an escaped quote outside a quote does not OPEN one", () => {
  // Not predicted, and found by the corpus sweep rather than by reading.
  //
  // Handling `\<newline>` meant deciding what the scanner does with a
  // backslash generally, and the honest answer is the shell's: outside a
  // quote, `\X` escapes X for every X. The scanner used to fall through to
  // `cur += c` and then read the NEXT character normally — so `\'` opened a
  // quote that never closed, the tracker desynchronised, and every separator
  // for the rest of the command was swallowed or invented.
  //
  // `'\''` — close, escaped literal quote, reopen — is THE way to put an
  // apostrophe inside a single-quoted shell string. It is everywhere in this
  // machine's history: inside `sed` scripts, `jq` filters and `--body` text.

  test("MECHANISM: the tracker stays in sync across `\\'`", () => {
    // On `origin/main` this returns ONE segment: the `\'` opened a quote, so
    // the `;` was read as quoted text instead of as a separator.
    expect(segments("echo \\' ; rm /r/x")).toEqual(["echo \\'", "rm /r/x"]);
  });

  test("F12: a real `sed -i` on a real hook, ALLOWED on main", () => {
    // Recovered from the corpus. The desync put `sed -i` and its target in
    // different segments, so arm 2 read a verb with no protected argument.
    const cmd = "sed -i '' 's|x|'\\''y'\\''|g' /Users/jhorn/.pai/hooks/X.hook.ts";
    expect(segments(cmd)).toHaveLength(1);
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("F13: a real `jq … && mv` onto a LIVE run-store artifact, ALLOWED on main", () => {
    // The serious one. A `jq` filter carrying `'\''` tore the command apart,
    // and the `mv` that writes the live gate artifact landed in a fragment
    // of its own with no verb the guard recognised.
    const cmd =
      `jq '.acs[3].evidenceMethod.command = "grep -ch '\\''x()'\\'' a.ts"' ` +
      `/Users/jhorn/.rungate/ddb-1452/${STATE} > /tmp/ws-fix.json && ` +
      `mv /tmp/ws-fix.json /Users/jhorn/.rungate/ddb-1452/${STATE}`;
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("F14: a literal backslash before a closing SINGLE quote ends the span", () => {
    // Raised by the AI review against the first revision of this PR, and it
    // was right — the first version of this very describe asserted the defect
    // as intended behaviour, in a control that passed vacuously because the
    // string it used contained no separator to swallow.
    //
    // Inside single quotes POSIX sh escapes NOTHING, not even a backslash, so
    // the first `'` always closes. Treating `\'` as an escape there kept the
    // span open past its real end and swallowed the separator AND the verb.
    expect(segments("echo 'a\\' ; rm /r/x")).toEqual(["echo 'a\\'", "rm /r/x"]);
  });

  test("F14 WITNESS: the swallowed segment is a real bypass of the verb-gated arms", () => {
    // Arm 4 requires the COMMAND WORD to be chmod. With the span held open,
    // the whole command is one segment whose command word is `echo`, so the
    // arm never fires. ALLOW on origin/main, BLOCK here. The redirect and
    // in-place arms happened to survive it, which is why this needs the
    // command-word-gated arm to show the hole at all.
    expect(decideBashWrite("echo 'x\\' ; chmod 777 /h/Y.hook.ts").blocked).toBe(true);
  });

  test("CONTROL: inside DOUBLE quotes a backslash IS an escape", () => {
    // The two cases are told apart rather than handled by one rule, so this
    // is the row that stops the fix becoming "a quote always closes".
    expect(segments('echo "a\\" ; rm /r/x"')).toHaveLength(1);
  });

  test("CONTROL: the `'\\''` idiom is unaffected by the single-quote rule", () => {
    // Its backslash sits OUTSIDE the quotes — between the closing quote of
    // one span and the opening quote of the next — so it is the escape branch
    // above that handles it, not this one. Both halves must hold at once.
    expect(decideBashWrite("echo 'a'\\''b' ; rm /r/x").blocked).toBe(false);
    expect(segments("echo 'a'\\''b' ; rm /r/x")).toEqual(["echo 'a'\\''b'", "rm /r/x"]);
  });
});

describe("#1249 WITNESS: an escaped BACKSLASH inside double quotes is a pair", () => {
  // F14's twin in the other quote. Inside double quotes `\\` is an escaped
  // backslash — a complete pair — and the `"` after it is the CLOSING quote.
  // A one-character lookbehind cannot tell that `"` from the escaped `\"` of
  // the control above, so it read the span as still open, swallowed the
  // separator and the verb, and left one segment whose command word is
  // `echo`.
  //
  // The outside-quote branch of the same scanner already consumed the pair,
  // for this exact reason, and says so in its comment. This applies the same
  // rule inside the span.
  //
  // WHY THIS LOOKED UNREAL: the issue's example used `rm`, and `rm` is the
  // one shape that does NOT escape. The in-place arm matches over the
  // segment TEXT, so a merged segment still carries its target; the same is
  // true of the redirect and `tee` arms. Only the arms gated on the COMMAND
  // WORD are bypassable. A battery built from the issue's own example
  // therefore reports BLOCK on every row and the hole stays invisible. The
  // three rows below are the ones that do escape, each measured ALLOW
  // against `origin/main` at 52750f04 before the fix.

  test("MECHANISM: the quote after `\\\\` closes the span", () => {
    // ONE segment on origin/main, where the separator is quoted text.
    expect(segments('echo "x\\\\" ; rm /r/x')).toEqual(['echo "x\\\\"', "rm /r/x"]);
  });

  test("WITNESS: `cp` overwrites the artifact — ALLOW on origin/main", () => {
    // Arm 1 resolves the COPY verb from the command word, so a merged
    // segment beginning `echo` never reaches it.
    expect(
      decideBashWrite(`echo "x\\\\" ; cp /etc/hosts ${LIVE_TREE}/run/${STATE}`).blocked,
    ).toBe(true);
  });

  test("WITNESS: `chmod` on the artifact — ALLOW on origin/main", () => {
    // Arm 4, the same arm F14 used to show the single-quote hole.
    expect(decideBashWrite(`echo "x\\\\" ; chmod 777 ${LIVE_TREE}/run/${STATE}`).blocked).toBe(
      true,
    );
  });

  test("WITNESS: an interpreter writing the artifact — ALLOW on origin/main", () => {
    // Arm 3 fires on an interpreter COMMAND WORD. Hidden by the merge, the
    // program text is never read at all.
    const body = `bun -e 'require("fs").writeFileSync("${LIVE_TREE}/run/${STATE}","{}")'`;
    // The unmerged spelling FIRST. Without it this row cannot tell #1249
    // from arm 3 simply not recognising the write — which is how the first
    // draft of it went red: `open(p,"w")` on its own is ALLOWed on main
    // whether merged or not, because arm 3 reads a list of write verbs and
    // `open` is not on it. That is a pre-existing gap of the same
    // enumeration class as #1269's finding 3, and not what this row is for.
    expect(decideBashWrite(`echo x ; ${body}`).blocked).toBe(true);
    expect(decideBashWrite(`echo "x\\\\" ; ${body}`).blocked).toBe(true);
  });

  test("the shell really runs both commands — the premise, not an assumption", () => {
    // Without this row the three above only assert that two readers of a
    // string disagree. `bash -n` says the spelling parses; this says the
    // second command is reached and has its effect.
    const dir = mkdtempSync(join(tmpdir(), "bw1249-"));
    try {
      const victim = join(dir, "victim.txt");
      // late-env-ok: the child is `echo` and `cp` under bash, which read no
      // RUNGATE variable and no TMPDIR — the destination is an absolute path
      // computed here and passed on the command line. Nothing this file
      // writes to process.env can change what this row measures.
      spawnSync("/bin/bash", ["-c", `echo "x\\\\" ; cp /etc/hosts ${victim}`]);
      expect(existsSync(victim)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("END TO END through the hook — the payload, not the exit code", () => {
    // Every row above reads the library. This one runs the hook the way the
    // tool runner does, because that is where the refusal has to happen.
    const hook = join(import.meta.dir, "..", "hooks", "BashWriteGuard.hook.ts");
    // This child DOES read RUNGATE_WORK_DIR and TMPDIR, so it gets an
    // EXPLICIT env rather than a stated reason (#1096). Earlier tests in
    // this file write both, and relying on Bun dropping a late write to
    // keep them out of the child would make that an accident of the
    // runtime rather than a property of the row.
    const env: Record<string, string | undefined> = { ...process.env, TMPDIR: "/tmp" };
    delete env.RUNGATE_WORK_DIR;
    delete env.PAI_HOOKS_DIR;
    delete env.RUNGATE_HOOKS_DIR;
    const run = (command: string) => {
      const r = spawnSync("bun", ["run", hook], {
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
        encoding: "utf8",
        env,
      });
      return { status: r.status, stdout: (r.stdout || "").trim() };
    };
    const refused = run(`echo "x\\\\" ; chmod 777 ${LIVE_TREE}/run/${STATE}`);
    expect(JSON.parse(refused.stdout).decision).toBe("block");
    // The control that makes this row readable rather than decorative: the
    // hook ALWAYS exits 0 and signals a refusal on stdout. A permitted
    // command exits 0 and prints nothing, so the two directions are
    // indistinguishable by status and a test asserting on it cannot fail.
    const permitted = run("echo hello");
    expect(permitted.stdout).toBe("");
    expect(refused.status).toBe(0);
    expect(permitted.status).toBe(0);
  });

  test("CONTROL: a separator INSIDE the double-quoted span still does not split", () => {
    // The fix must close the span at its real end, not widen the splitter.
    expect(segments('echo "a\\\\;b"')).toHaveLength(1);
    expect(segments('echo "a\\"b ; c" ; rm /r/x')).toHaveLength(2);
  });

  test("CONTROL: the single-quote rule is untouched by the pair rule", () => {
    // Inside single quotes nothing is escaped, so the first `'` closes and
    // the pair branch must not run there. Two backslashes, the #1249 shape,
    // in the #1203 quote.
    expect(decideBashWrite(`echo 'x\\\\' ; chmod 777 ${LIVE_TREE}/run/${STATE}`).blocked).toBe(
      true,
    );
  });

  test("CONTROL: a dangling backslash at the end of the string is not an index past it", () => {
    expect(() => segments('echo "x\\')).not.toThrow();
  });
});

describe("#1249: the cheapest wrong fix, run rather than described", () => {
  // Three rules for "where does this double-quoted span close", run against
  // the two inputs that tell them apart rather than argued about. The
  // cheapest fix — delete the escape handling, a quote always closes — gets
  // the new row right and gets the row already in the suite above wrong.
  const closesAt = (s: string, rule: "naive" | "lookbehind" | "pair"): number => {
    for (let i = 1; i < s.length; i++) {
      if (rule === "pair" && s[i] === "\\" && i + 1 < s.length) {
        i++;
        continue;
      }
      if (s[i] !== '"') continue;
      if (rule === "lookbehind" && s[i - 1] === "\\") continue;
      return i;
    }
    return -1; // the span never closed
  };
  const ESCAPED_BACKSLASH = '"x\\\\"'; // bytes: "x\\"  — a pair, closes at 4
  const ESCAPED_QUOTE = '"x\\""'; // bytes: "x\""  — an escape, closes at 4

  test("the lookbehind that shipped never closes the escaped-backslash span", () => {
    expect(closesAt(ESCAPED_BACKSLASH, "lookbehind")).toBe(-1);
    expect(closesAt(ESCAPED_QUOTE, "lookbehind")).toBe(4);
  });

  test("`a quote always closes` fixes this row and breaks the escaped quote", () => {
    expect(closesAt(ESCAPED_BACKSLASH, "naive")).toBe(4);
    expect(closesAt(ESCAPED_QUOTE, "naive")).toBe(3); // ends the span early
  });

  test("consuming the PAIR is the only one of the three that gets both", () => {
    expect(closesAt(ESCAPED_BACKSLASH, "pair")).toBe(4);
    expect(closesAt(ESCAPED_QUOTE, "pair")).toBe(4);
  });
});

/**
 * `bash -n` — does this spelling even parse? A guard that lets through a
 * string the shell refuses to run has let through nothing, and this is the
 * only thing that tells a bypass apart from a typo. Used in both directions
 * below: to prove the witnesses are programs, and to prove the fail-open
 * exits the review flagged are unreachable.
 */
function parses(cmd: string): boolean {
  // late-env-ok: this file became a candidate for the #1096 scan when #1175
  // added cases that assign `process.env.TMPDIR`, and the scan is right to
  // ask. The answer is that this child cannot be affected by them: `bash -n`
  // parses the string it is handed and does not execute it, so it reads no
  // variable at all, and `TMPDIR` here is read by `isScratchPath` IN THIS
  // PROCESS. Every assignment is also restored in a `finally` in the same
  // test, so no value outlives the case that set it.
  return spawnSync("/bin/bash", ["-n", "-c", cmd], { encoding: "utf8" }).status === 0;
}

describe("#1205 WITNESS: the $() depth scan must skip quoted spans", () => {
  // Raised by the plugin security review against the pushed branch and
  // confirmed by execution. The depth counter counted a `)` that was INSIDE
  // a string literal, dropped to zero early and ended the word mid
  // substitution. The leftover `"` then had no partner, so `readWord`'s
  // quote branch took `close === -1` and swallowed the rest of the line —
  // including the `>` operator. No operator, no target, ALLOW.
  //
  // It is the same sentence as #1205 itself: the bug is what the scanner
  // cannot see, not the substitution.
  const cases: [string, string][] = [
    ["a paren inside DOUBLE quotes", `echo $(echo "x)") > ${LIVE_TREE}/${SALT}`],
    ["a paren inside SINGLE quotes", `echo $(echo 'x)') > ${LIVE_TREE}/${SALT}`],
    ["the quoted paren in the second of two substitutions", `echo $(date) $(echo "x)") > ${LIVE_TREE}/${SALT}`],
    ["a quoted paren in a tee operand's neighbour", `echo $(echo "x)") | tee ${LIVE_TREE}/${STATE}`],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("CONTROL: every witness above is a program bash will run", () => {
    // Without this the witnesses prove nothing — a string the shell refuses
    // is not a bypass. The review's own reproduction wrote a file through
    // the first spelling.
    for (const [, cmd] of cases) expect(parses(cmd)).toBe(true);
  });
});

describe("#1205 CONTROL: skipping quoted spans is not widening the scan", () => {
  test("a balanced substitution with no quotes is unchanged", () => {
    expect(decideBashWrite(`echo $(echo x) > ${LIVE_TREE}/${SALT}`).blocked).toBe(true);
    expect(writeTargets(`echo x > $(dirname /a/b)/${STATE}`)).toEqual([`$(dirname /a/b)/${STATE}`]);
  });

  test("a substitution-built path naming nothing protected stays allowed", () => {
    expect(decideBashWrite("echo x > $(mktemp -d)/out.txt").blocked).toBe(false);
    expect(decideBashWrite('echo $(echo "x)") > /tmp/out.txt').blocked).toBe(false);
  });

  test("the three UNTERMINATED spellings are bash syntax errors, so no refusal path is added", () => {
    // The security review called these fail-open and asked for an
    // `unparseable` flag. They ARE the consume-to-end branch, and the branch
    // is deliberate — but the question is moot: none of them is a program,
    // so there is no write for a refusal to prevent. Machinery guarding an
    // unreachable state costs real commands and protects nothing.
    //
    // Recorded as an assertion rather than as prose so that if any of these
    // ever becomes valid shell, this row goes red and the decision is re-made
    // with evidence instead of being inherited.
    const unterminated = [
      "echo x > `id -un/" + STATE,
      `echo x > /tmp/$(id -un/${STATE}`,
      `echo x > "${LIVE_TREE}/${STATE}`,
      // The spelling that genuinely ALLOWs: an unterminated quote placed
      // BEFORE the operator swallows the `>` itself. Also not a program.
      `echo "x > ${LIVE_TREE}/${STATE}`,
    ];
    for (const cmd of unterminated) expect(parses(cmd)).toBe(false);
  });
});

describe("#1146: xattr's mutating forms are -w, -d and -c, read off the tool", () => {
  // `xattr --help` on macOS:
  //   xattr [-lrsvx] file …                    list      — a READ
  //   xattr -p [-lrsvx] attr file …            print     — a READ
  //   xattr -w [-rsx] attr value file …        set       — MUTATES
  //   xattr -d [-rsv] attr file …              delete    — MUTATES
  //   xattr -c [-rsv] file …                   clear ALL — MUTATES
  //
  // The pattern shipped in the first revision of this PR, `-[dws]`, is wrong
  // in BOTH directions against that: it misses `-c`, which deletes every
  // attribute on the file, and it treats `-s` — "act on the symbolic link
  // itself" — as a mutation. It also reads a single letter, so any cluster
  // hides the verb.
  const mutating: [string, string][] = [
    ["-d, the recorded corpus command", `xattr -d com.apple.provenance /h/X.hook.ts`],
    ["-w", `xattr -w a b /h/X.hook.ts`],
    ["-c, which clears every attribute", `xattr -c /h/X.hook.ts`],
    ["-rc, the mutating letter last in the cluster", `xattr -rc /h/X.hook.ts`],
    ["-cr, the mutating letter FIRST in the cluster", `xattr -cr /h/X.hook.ts`],
    ["-dr, same shape with delete", `xattr -dr a /h/X.hook.ts`],
    ["-sw, a read modifier in front of a write", `xattr -sw a b /h/X.hook.ts`],
  ];
  test.each(mutating)("%s mutates", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  const reads: [string, string][] = [
    ["a bare invocation lists attributes", `xattr /h/X.hook.ts`],
    ["-l is long format", `xattr -l /h/X.hook.ts`],
    ["-p prints one attribute", `xattr -p com.apple.provenance /h/X.hook.ts`],
    ["-lr", `xattr -lr /h/X.hook.ts`],
    ["-x is hex output", `xattr -x /h/X.hook.ts`],
    ["-rsv are all modifiers", `xattr -rsv /h/X.hook.ts`],
    // This one CHANGES with this revision: `-[dws]` refused it. `-s` does not
    // mutate, so refusing it was a false positive — stated rather than
    // quietly dropped.
    ["-s alone acts on the link and reads", `xattr -s /h/X.hook.ts`],
  ];
  test.each(reads)("%s stays allowed", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(false);
  });

  test("CONTROL: the cluster rule still needs a protected target", () => {
    expect(decideBashWrite("xattr -c /tmp/notes.md").blocked).toBe(false);
    expect(decideBashWrite("xattr -cr ~/Projects/x/README.md").blocked).toBe(false);
  });
});

/**
 * #1240: a heredoc fed to an INTERPRETER is a program, not a document.
 *
 * Pre-existing on `origin/main`, not introduced by #1175 — every witness
 * below was measured against `git show origin/main:lib/bash-write-guard.ts`
 * and reads ALLOW there, with no symlink and no `ln` anywhere.
 *
 * `stripHeredocs` deletes the body before every arm, and arm 3a only reads a
 * body back as shell when the segment also carries `-c`/`-e`. A
 * `bash <<'EOF'` segment carries neither, so the guard decided on the single
 * word `bash` while the program underneath wrote whatever it liked.
 *
 * The controls are the load-bearing half. A fix of "stop stripping heredocs"
 * passes every witness and reintroduces the 1,860-command over-blocking that
 * stripping exists to prevent, so a document heredoc, a `gh --body-file -`
 * heredoc and an interpreter heredoc writing a genuine fixture all assert
 * ALLOW.
 */
describe("#1240 WITNESS: a program handed to an interpreter on stdin", () => {
  const VICTIM = `${LIVE}/run/${STATE}`;
  const witnesses: [string, string][] = [
    ["bash", `bash <<'EOF'\necho '{}' > ${VICTIM}\nEOF`],
    ["sh", `sh <<'SH'\necho '{}' > ${VICTIM}\nSH`],
    ["zsh", `zsh <<'Z'\necho '{}' > ${VICTIM}\nZ`],
    ["an unquoted delimiter", `bash <<EOF\necho '{}' > ${VICTIM}\nEOF`],
    ["an indented terminator", `bash <<-'EOF'\n\techo '{}' > ${VICTIM}\n\tEOF`],
    ["a pipe into an interpreter", `cat <<'EOF' | bash\necho '{}' > ${VICTIM}\nEOF`],
    ["a path-spelled interpreter", `/bin/bash <<'EOF'\necho '{}' > ${VICTIM}\nEOF`],
    // Not in the issue's table, measured here: a HERESTRING reaches the same
    // interpreter by a route `heredocDelimiter` deliberately excludes
    // (#1184 — it has no terminator), and is allowed for the other half of
    // the mechanism: the `>` sits in a quoted span the VERB view removes.
    ["a herestring", `bash <<<"echo '{}' > ${VICTIM}"`],
    // A python body is not shell. Reading it as shell finds nothing, which
    // is why it needs arm 3's treatment — a declared write verb near the
    // name — rather than the shell recursion.
    ["python, which is not shell", `python3 <<'PY'\nopen("${VICTIM}", "w").write("{}")\nPY`],
    ["an ln inside the body, the originally reported case", `bash <<'EOF'\nln -s ${LIVE}/run /tmp/bw1240esc\necho '{}' > /tmp/bw1240esc/${STATE}\nEOF`],
  ];
  test.each(witnesses)("a write to a live artifact through %s is refused", (_n, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("CONTROL: a document heredoc keeps its exemption", () => {
    const cmd = `cat > /tmp/bw1240/notes.md <<'EOF'\necho '{}' > ${VICTIM}\nln -s a b\nEOF`;
    expect(decideBashWrite(cmd).blocked).toBe(false);
  });

  test("CONTROL: a gh body heredoc still passes — pai-config#474's shape", () => {
    const cmd = `gh issue comment 1 --body-file - <<'EOF'\nThe guard refuses a write to ${STATE}\nEOF`;
    expect(decideBashWrite(cmd).blocked).toBe(false);
  });

  test("CONTROL: an interpreter heredoc writing a FIXTURE is still allowed", () => {
    // #2859: the directory exists before the program runs.
    const cmd = `bash <<'EOF'\necho '{}' > ${FIX}/${STATE}\nEOF`;
    expect(decideBashWrite(cmd).blocked).toBe(false);
  });

  test("CONTROL: an interpreter heredoc that only READS is still allowed", () => {
    const cmd = `python3 <<'PY'\nimport json\nprint(json.load(open("${VICTIM}"))["phase"])\nPY`;
    expect(decideBashWrite(cmd).blocked).toBe(false);
  });

  /**
   * REVERSED by #2858. #1240 asked this arm for an ABSOLUTE path, because a
   * relative spelling could not be shown to be scratch and refusing it
   * refused 23 hook-fixture builds the exemption existed for. The exemption
   * is gone (ADR-027), so a relative spelling of a write is the same write,
   * and the `-c` spelling of this body was always refused. Review of #2863,
   * round 2, found the absolute-only reading allowing a relative write from
   * the run store and any absolute path with a space in it.
   */
  test("REVERSED (#2858): a relative spelling beside a write verb is refused, as its -c spelling is", () => {
    const assembled = `python3 <<'PY'\nimport os\nopen(os.path.join(dst, n + ".hook.ts"), "w").write("// stand-in")\nPY`;
    expect(decideBashWrite(assembled).blocked).toBe(true);
    expect(decideBashWrite(`python3 -c 'import os; open(os.path.join(dst, n + ".hook.ts"), "w").write("// stand-in")'`).blocked).toBe(true);
    // and the absolute spelling of the same write is refused, so the row
    // above is not passing because the arm is dead
    const absolute = `python3 <<'PY'\nopen("${LIVE}/hooks/X.hook.ts", "w").write("// stand-in")\nPY`;
    expect(decideBashWrite(absolute).blocked).toBe(true);
  });

  test("MECHANISM: only an interpreter's heredoc is returned as a program", () => {
    expect(interpreterPrograms(`bash <<'EOF'\nx\nEOF`).map(p => p.program)).toEqual(["x"]);
    expect(interpreterPrograms(`cat > f <<'EOF'\nx\nEOF`)).toEqual([]);
    expect(interpreterPrograms(`cat <<'EOF' | bash\nx\nEOF`).map(p => p.shell)).toEqual([true]);
    expect(interpreterPrograms(`python3 <<'PY'\nx\nPY`).map(p => p.shell)).toEqual([false]);
    // An UNTERMINATED heredoc is already visible to every arm (#1184 emits
    // it unchanged), so returning it here would decide the same bytes twice.
    expect(interpreterPrograms(`bash <<'EOF'\nx`)).toEqual([]);
  });
});

/**
 * #1269: a protected tree is subtracted under BOTH of its spellings.
 *
 * #1175 realpathed the scratch roots and not the protected trees, so a tree
 * named through a symlink — which `/tmp` is, on every macOS install — was
 * subtracted under one spelling and exempted under the other. The run store
 * was reachable by typing `realpath` once.
 *
 * Built against the real filesystem rather than asserted about strings: the
 * directory is created, so `realpathSync` has something to resolve, and the
 * two spellings are the two names of one inode rather than two literals
 * that happen to differ.
 */
describe("#1269 WITNESS: a protected tree is subtracted under both spellings", () => {
  const vars: string[] = ["RUNGATE_WORK_DIR", "RUNGATE_HOOKS_DIR"];
  test.each(vars)("%s named through a symlink is protected by its realpath too", (v: string) => {
    const dir = mkdtempSync(join("/tmp", "bw1269-"));
    const before = process.env[v];
    try {
      mkdirSync(join(dir, "p"), { recursive: true });
      process.env[v] = dir; // the /tmp spelling, which is how anyone types it
      const real = realpathSync(dir); // /private/tmp/... on macOS
      const artifact = v === "RUNGATE_HOOKS_DIR" ? "X.hook.ts" : STATE;

      // The premise: the two spellings really are different names. Without
      // this the case is vacuous on a filesystem where /tmp is not a link.
      if (real === dir) return;

      expect(isScratchPath(`${dir}/p/${artifact}`)).toBe(false);
      expect(isScratchPath(`${real}/p/${artifact}`)).toBe(false);
      expect(decideBashWrite(`echo '{}' > ${real}/p/${artifact}`).blocked).toBe(true);
    } finally {
      if (before === undefined) delete process.env[v];
      else process.env[v] = before;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CONTROL: a sibling scratch tree nothing points at is still a fixture", () => {
    const dir = mkdtempSync(join("/tmp", "bw1269-live-"));
    const other = mkdtempSync(join("/tmp", "bw1269-fix-"));
    const before = process.env.RUNGATE_WORK_DIR;
    try {
      process.env.RUNGATE_WORK_DIR = dir;
      // Both spellings of the UNRELATED tree stay exempt — the fix subtracts
      // one tree's two names, not every path that realpaths to /private/tmp.
      expect(isScratchPath(`${other}/${STATE}`)).toBe(true);
      expect(isScratchPath(`${realpathSync(other)}/${STATE}`)).toBe(true);
    } finally {
      if (before === undefined) delete process.env.RUNGATE_WORK_DIR;
      else process.env.RUNGATE_WORK_DIR = before;
      rmSync(dir, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("CONTROL: a tree that does not exist keeps its resolved spelling", () => {
    const before = process.env.RUNGATE_WORK_DIR;
    try {
      // `realpathSync` throws here. The resolved name must still protect.
      process.env.RUNGATE_WORK_DIR = "/tmp/bw1269-never-created";
      expect(isScratchPath(`/tmp/bw1269-never-created/${STATE}`)).toBe(false);
    } finally {
      if (before === undefined) delete process.env.RUNGATE_WORK_DIR;
      else process.env.RUNGATE_WORK_DIR = before;
    }
  });
});

/**
 * #1269 finding 2: arm 3's exemption asks about the whole body.
 *
 * Arm 3 refuses because an interpreter's program is OPAQUE — what it writes
 * cannot be read off the command line. Deciding the exemption from a single
 * path word contradicted that premise, because a destination can be
 * computed. Measured against the module as merged, one of three computed
 * spellings escaped; the other two happened to normalise back into the run
 * store, which is luck and not coverage.
 *
 * The stopgap this block was written for is GONE (#1277), and so is the
 * reader that replaced it (#2858): an interpreter body has no scratch
 * exemption, so every row naming a protected artifact beside a write verb is
 * refused, the fixture rows included. Reads stay allowed — see #1214's rows.
 */
describe("#1269 WITNESS: a computed destination in an interpreter body", () => {
  const RUN = `${process.env.HOME}/.rungate/run`;

  test("a scratch literal rewritten into the run store is refused", () => {
    const cmd = `bun -e 'writeFileSync("/tmp/x/${STATE}".replace("/tmp/x", "${RUN}"), "{}")'`;
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("the same shape with a hook file is refused", () => {
    const cmd = `bun -e 'writeFileSync("/tmp/x/X.hook.ts".replace("/tmp/x", "${LIVE}/hooks"), "")'`;
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  // #2858: the fixture shapes these rows once kept allowed are refused. A
  // read beside them is not — #1214's rows hold that half.
  test("#2858: a body writing a protected name into scratch is refused like any other", () => {
    for (const cmd of [
      `mkdir -p /tmp/fix && bun -e 'writeFileSync("/tmp/fix/${STATE}", "{}")'`,
      `mkdir -p /tmp/a /tmp/b && python3 -I -c "import shutil; shutil.copy('/tmp/a/${STATE}', '/tmp/b/${STATE}')"`,
      `mkdir -p /tmp/fix && bun -e '// build the fixture\nwriteFileSync("/tmp/fix/${STATE}", "{}")'`,
      `mkdir -p /tmp/fix && bun -e 'readFileSync("${LIVE}/notes"); writeFileSync("/tmp/fix/${STATE}", "{}")'`,
    ]) expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
  });

  test("CONTROL: a literal run-store path was always refused", () => {
    expect(decideBashWrite(`bun -e 'writeFileSync("${RUN}/${STATE}", "{}")'`).blocked).toBe(true);
  });

  test("CONTROL: the same shape where the extra literal IS an artifact still refuses", () => {
    const cmd = `bun -e 'readFileSync("${RUN}/${STATE}"); writeFileSync("/tmp/fix/${STATE}", "{}")'`;
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("CONTROL #1371: the same shape where the extra literal is in a LIVE TREE refuses", () => {
    // Spells no protected artifact, so the name-list control above cannot
    // see it. Refused since #2858 whatever the extra literal is.
    const cmd = `bun -e 'readFileSync("${RUN}/notes"); writeFileSync("/tmp/fix/${STATE}", "{}")'`;
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  /**
   * The spellings that DO NOT need this fix, measured rather than assumed.
   * My first draft of this block asserted that a `$HOME`-assembled
   * destination escapes. It does not — the carrying word is
   * `/.rungate/run/workflow-state.json`, which is absolute and not scratch,
   * so the body already failed the all-scratch test. Three of the four
   * computed spellings I tried were refused on `origin/main` too, and only
   * the `.replace` of a scratch literal ever escaped:
   *
   *     env + absolute suffix          main BLOCK   variant BLOCK
   *     env var + absolute suffix      main BLOCK   variant BLOCK
   *     command substitution           main BLOCK   variant BLOCK
   *     replace of a scratch literal   main ALLOW   variant BLOCK   ← this fix
   */
  test("the computed spellings that were already refused stay refused", () => {
    const run = `${process.env.HOME}/.rungate/run`;
    for (const cmd of [
      `bun -e 'writeFileSync(process.env.HOME + "/.rungate/run/${STATE}", "{}")'`,
      `bun -e 'writeFileSync(process.env.RUNGATE_WORK_DIR + "/${STATE}", "{}")'`,
      `bun -e 'writeFileSync("$(echo ${run})/${STATE}", "{}")'`,
    ]) {
      expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
    }
  });

  /**
   * KNOWN LIMITATION, asserted so it is visible and goes red the day it is
   * closed. It is NOT the exemption's doing and resolving the write target
   * would not close it either: when the artifact NAME is assembled from
   * pieces, `pathWordsContaining` finds no word carrying it, so arm 3 never
   * gets a candidate to judge. Pre-existing — `origin/main` allows this row
   * identically. Recorded here because the row next to it could otherwise
   * be read as "computed destinations are handled".
   */
  test("LIMITATION: an assembled artifact NAME is invisible to every arm", () => {
    const cmd = `python3 -c "import os; open(os.environ['RUNGATE_WORK_DIR'] + os.sep + 'workflow' + '-state.json','w').write('{}')"`;
    expect(decideBashWrite(cmd).blocked).toBe(false);
  });
});

/**
 * Covers #1214 — arm 3 allows an interpreter that writes a live gate
 * artifact through an imported project function.
 *
 * ## The result is that the predicate was REJECTED, and this pins it
 *
 * #1214 offered two framings and asked for the measurement to choose. The
 * narrower one — derive the suspicious-call set from the body's own `import`
 * statement, enumerating nothing — was implemented and swept over 130,247
 * real commands: 616 newly blocked, 0 newly allowed, 600 of them calling a
 * writing orchestrator symbol against the live run store. 97% precision, and
 * still wrong, because `workflows/ship.js` EMITS those commands itself.
 *
 * The filed "bypass" is the harness's own GOAL-phase step 1. Blocking it
 * refuses every run. `WRITE_INTENT`'s docstring carries the full numbers and
 * the three places that prescribe the shape.
 *
 * So these rows are not decoration. They are the cost of the obvious fix,
 * made executable: this block went RED — 600 corpus commands and every row
 * below — against the predicate while it existed, which is the evidence that
 * it can fail. Reach for that fix again and the suite says what it breaks.
 */
describe("#1214 WITNESS: the harness's own prescribed commands stay allowed", () => {
  const HARNESS = "/opt/bwprobe/harness";
  const WORK = "/opt/bwprobe/runstore";

  /**
   * The premise, checked rather than asserted. If `ship.js` ever stops
   * prescribing this shape, the reason these rows are allowed has gone away
   * and the question deserves re-opening — so this goes red instead of
   * quietly becoming a permission nobody can justify.
   */
  test("PREMISE: ship.js really does emit the shape #1214 filed", () => {
    const ship = readFileSync(join(import.meta.dir, "..", "workflows", "ship.js"), "utf8");
    expect(ship).toContain("import {initWorkflow, writeACs} from");
    expect(ship).toContain("gates/orchestrator.ts");
    expect(ship).toContain("Run this EXACTLY as written");
    // The payload spelling is generated, not hand-written, and it is the
    // fingerprint that identifies the filed command as the harness's own.
    const transport = readFileSync(join(import.meta.dir, "..", "lib", "evidence-command-transport.ts"), "utf8");
    expect(transport).toContain("JSON.parse(process.argv[");
  });

  test("the filed command — GOAL phase step 1 — is allowed", () => {
    const cmd = `mkdir -p ${WORK} && bun -e "
import {initWorkflow, writeACs} from '${HARNESS}/gates/orchestrator.ts';
const sf = '${WORK}/${STATE}';
initWorkflow(sf, { issue: 624, slug: 'pai-harness-624' });
writeACs(sf, JSON.parse(process.argv[1]));
const s=JSON.parse(require('fs').readFileSync(sf,'utf-8'));
console.log(JSON.stringify({initialized:true,acCount:s.acs.length}));
" '[]' 2>&1`;
    expect(decideBashWrite(cmd).blocked).toBe(false);
  });

  test("the sanctioned gate-state repair is allowed", () => {
    // Printed to the agent verbatim by `lib/gate-result-protection.ts` and
    // `lib/gate-enforcement.ts`, and documented in `gates/SCHEMA-GUIDE.md`
    // as the replacement for the Write tool and `cat >`.
    const cmd = `bun -e "import {writeWorkflowState} from '${HARNESS}/gates/orchestrator.ts'; import {readFileSync} from 'fs'; const s = JSON.parse(readFileSync('${WORK}/${STATE}','utf8')); writeWorkflowState('${WORK}/${STATE}', s);"`;
    expect(decideBashWrite(cmd).blocked).toBe(false);
  });

  test("#1176's reading witnesses are untouched", () => {
    // The issue names these explicitly: a guard that refuses the normal way
    // of looking at gate state gets switched off.
    for (const cmd of [
      `bun -e "const s = readFileSync('${WORK}/${STATE}','utf8'); console.log(s)"`,
      `python3 -I -c "import json; print(json.load(open('${WORK}/${STATE}')))"`,
      `bun -e "import {readWorkflow} from '${HARNESS}/gates/orchestrator.ts'; console.log(readWorkflow('${WORK}/${STATE}').phase)"`,
    ]) {
      expect(decideBashWrite(cmd).blocked, cmd).toBe(false);
    }
  });

  test("CONTROL: arm 3 still refuses a DECLARED write verb on the same path", () => {
    // Without this the block above would pass against a guard whose arm 3
    // had been deleted outright, which is the vacuous reading of "allowed".
    for (const cmd of [
      `bun -e "writeFileSync('${WORK}/${STATE}', '{}')"`,
      `python3 -I -c "open('${WORK}/${STATE}','w').write('{}')"`,
      `bun -e "import {x} from '${HARNESS}/gates/orchestrator.ts'; writeFileSync('${WORK}/${STATE}', '{}')"`,
    ]) {
      expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
    }
  });

  test("CONTROL: no consumer-specific symbol was added to the guard", () => {
    // #1214's explicit constraint. `initWorkflow`/`writeACs` are this
    // project's API; a harness module naming them is wrong in every other
    // tree. The docstring DISCUSSES them, so the check is scoped to the
    // executable constant rather than the file.
    const src = readFileSync(join(import.meta.dir, "..", "lib", "bash-write-guard.ts"), "utf8");
    // late-env-ok: this is RegExp.prototype.exec against a string already read
    // into memory, not a child process. #1096's SPAWN pattern carries a bare
    // `exec` alternative and `\b` matches after the dot, so a regex `.exec(` in
    // a file that also writes `process.env` lands in its population. Widening
    // the pattern's view is the safe direction for that scan; the site is the
    // place to say so, which is what this marker is for.
    const m = /const WRITE_INTENT =\s*([\s\S]*?);\n/.exec(src);
    expect(m, "WRITE_INTENT must remain a single declared constant").not.toBeNull();
    for (const sym of ["initWorkflow", "writeACs", "writeWorkflowState", "updateAC", "writeEvidence"]) {
      expect(m![1]).not.toContain(sym);
    }
  });
});

/**
 * Covers #1239 — an escaped quote desynchronises the word scanner, the
 * redirect operator is swallowed with the rest of the word, and the write is
 * ALLOWed.
 *
 * ## Why this is a battery and not two witnesses
 *
 * The issue filed two spellings, both inside `$( )`. Enumerating the space
 * instead of asserting the filed shapes found **seven** executable bypasses
 * across **two** scanners, from one root cause: `indexOf` cannot tell `"`
 * from `\"`, so inside a double-quoted span the escaped quote is read as the
 * closing one. Three of the seven need no `$( )` at all —
 * `echo "x\"" > <protected>` is the shortest of them and nobody had written
 * it down.
 *
 * `.claude/rules/checks-must-be-able-to-fail.md`, seventh shape: a battery
 * that varies the guard while holding the input shape fixed cannot be wrong
 * about an input nobody wrote. So the redirect is held fixed at `> <target>`
 * — that is the thing under test — and the axis that varies is the QUOTING
 * of the word in front of it, which is where the defect lives.
 *
 * ## Why every row is executed
 *
 * The whole defence of the unterminated spellings is that they are not valid
 * bash. That is a claim about bash, so it is measured by bash rather than
 * asserted: each row is written to a file and run against a seeded victim,
 * and the row's `runs` column is the reading. A row that RUNS and is ALLOWed
 * is a bypass; a row that is inert is not, and this file deliberately
 * constrains the guard's answer for none of them.
 *
 * The payloads are JS string literals written to a file with `writeFileSync`
 * and handed to `bash <file>`. They are never interpolated through another
 * shell, which would eat the backslashes before either bash or the guard saw
 * them and leave the battery proving something about the fixture. `stderr` is
 * asserted empty on every row expected to run, so a fixture that arrived
 * mangled is visible rather than silently scored as inert.
 */
describe("#1239 BATTERY: an escaped quote must not swallow the redirect", () => {
  /**
   * Each row is `<prefix> > <target>`. `scanner` records which of the two
   * `indexOf` sites the row exercises — the word-level quote branch, or the
   * `$( )` substitution branch — so a fix applied to only one of them leaves
   * the other half of the table red.
   */
  const SPELLINGS: {
    id: string;
    scanner: "word" | "subst" | "backtick";
    prefix: string;
    runs: boolean;
    /**
     * bash COMPLAINS about this spelling on stderr and performs the redirect
     * anyway. Declared per row, never inferred, and asserted in BOTH
     * directions by the FIXTURE case: a row that stops warning is as much a
     * change in what the table measures as a row that starts.
     *
     * The noise check exists to catch a payload damaged in transport, and
     * that is still what it does for every row without this flag. These two
     * are a different fact: bash reports the substitution unterminated,
     * substitutes nothing, and still truncates the target. A warning on
     * stderr is not a refusal — the file is overwritten either way, which is
     * the only thing the guard is for.
     */
    warns?: true;
  }[] = [
    // --- word-level quote scanner ---
    { id: "bare word", scanner: "word", prefix: `echo x`, runs: true },
    { id: "dq word", scanner: "word", prefix: `echo "x"`, runs: true },
    { id: "sq word", scanner: "word", prefix: `echo 'x'`, runs: true },
    { id: "dq inside sq word", scanner: "word", prefix: `echo '"'`, runs: true },
    { id: "sq inside dq word", scanner: "word", prefix: `echo "'"`, runs: true },
    { id: "escaped backslash in dq word", scanner: "word", prefix: `echo "x\\\\"`, runs: true },
    { id: "backslash in sq word (no escapes)", scanner: "word", prefix: `echo 'x\\'`, runs: true },
    { id: "backtick sub in word", scanner: "word", prefix: "echo `echo y`", runs: true },
    // the three the issue did not name
    { id: "escaped dq in dq word", scanner: "word", prefix: `echo "x\\""`, runs: true },
    { id: "escaped dq, two dq words", scanner: "word", prefix: `echo "a\\"" "b"`, runs: true },
    { id: "escaped dq outside quotes", scanner: "word", prefix: `echo \\"`, runs: true },
    { id: "unterminated dq word", scanner: "word", prefix: `echo "x`, runs: false },

    // --- $( ) substitution scanner ---
    { id: "plain sub", scanner: "subst", prefix: `echo $(echo x)`, runs: true },
    { id: "dq in sub", scanner: "subst", prefix: `echo $(echo "x")`, runs: true },
    { id: "sq in sub", scanner: "subst", prefix: `echo $(echo 'x')`, runs: true },
    { id: "paren in dq", scanner: "subst", prefix: `echo $(echo "x)")`, runs: true },
    { id: "paren in sq", scanner: "subst", prefix: `echo $(echo 'x)')`, runs: true },
    { id: "dq inside sq", scanner: "subst", prefix: `echo $(echo '"')`, runs: true },
    { id: "sq inside dq", scanner: "subst", prefix: `echo $(echo "'")`, runs: true },
    { id: "escaped backslash in dq", scanner: "subst", prefix: `echo $(echo "x\\\\")`, runs: true },
    { id: "backslash in sq (no escapes)", scanner: "subst", prefix: `echo $(echo 'x\\')`, runs: true },
    { id: "escaped paren outside quotes", scanner: "subst", prefix: `echo $(echo \\))`, runs: true },
    { id: "nested substitution", scanner: "subst", prefix: `echo $(echo $(echo y))`, runs: true },
    { id: "backtick inside dq", scanner: "subst", prefix: 'echo $(echo "`echo y`")', runs: true },
    // the issue's two, plus the nested spelling of the same defect
    { id: "escaped dq in dq", scanner: "subst", prefix: `echo $(echo "x\\"")`, runs: true },
    { id: "escaped dq then paren in dq", scanner: "subst", prefix: `echo $(echo "a\\")b")`, runs: true },
    { id: "escaped dq outside quotes, in sub", scanner: "subst", prefix: `echo $(echo \\")`, runs: true },
    { id: "nested sub with escaped dq", scanner: "subst", prefix: `echo $(echo $(echo "y\\""))`, runs: true },
    // inert: syntax errors. The guard's answer is NOT asserted for these —
    // the issue explicitly does not ask for them, and fail-closing on an
    // unterminated span would make every row above green for two reasons.
    { id: "escaped dq then paren, outside quotes", scanner: "subst", prefix: `echo $(echo \\")b\\")`, runs: false },
    { id: "unterminated dq in sub", scanner: "subst", prefix: `echo $(echo "x)`, runs: false },
    { id: "unterminated sq in sub", scanner: "subst", prefix: `echo $(echo 'x)`, runs: false },

    // --- backtick substitution scanner ---
    //
    // The THIRD `indexOf` partner-finder, and the one #1239 left behind.
    // Found by #1361's own AI review, which was right: `indexOf` cannot tell
    // `` ` `` from ``\` ``, so the scanner took the escaped backtick as the
    // closer, ended the word in the wrong place and never saw the `>`.
    //
    // These are not "the same shape, probably". Each was run both ways
    // before it was written down: `writeTargets` returned `[]` — no targets
    // at all, not a wrong one — and bash performed the write.
    { id: "backtick sub, plain", scanner: "backtick", prefix: "echo `echo y`", runs: true },
    { id: "escaped backtick in sub", scanner: "backtick", prefix: "echo `echo a\\`b`", runs: true, warns: true },
    { id: "escaped backtick alone in sub", scanner: "backtick", prefix: "echo `echo \\``", runs: true, warns: true },
    { id: "two escaped backticks in sub", scanner: "backtick", prefix: "echo `echo \\`\\`x`", runs: true },
    { id: "unterminated backtick", scanner: "backtick", prefix: "echo `echo x", runs: false },
  ];

  /** Does bash run this row, and does it reach the redirect? */
  function execute(prefix: string): { runs: boolean; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), "bwg-1239-"));
    try {
      const victim = join(dir, STATE);
      const script = join(dir, "payload.sh");
      writeFileSync(victim, "ORIGINAL\n");
      writeFileSync(script, `${prefix} > ${victim}\n`);
      // late-env-ok: this child reads no variable this file writes. The script
      // is `<prefix> > <victim>` with both paths absolute from `mkdtempSync`,
      // resolved in the PARENT before the spawn, and every prefix is an `echo`.
      // The file's `process.env.TMPDIR` writes belong to the `scratchRoots()`
      // cases, which call an in-process function and restore the value in a
      // `finally`; they never overlap this battery. Passing the parent's env
      // would be inert here, and inert noise at a spawn site is how a reader
      // stops believing the ones that matter (#1096).
      const r = spawnSync("bash", [script], { encoding: "utf8" });
      return { runs: readFileSync(victim, "utf8").trim() !== "ORIGINAL", stderr: r.stderr ?? "" };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("POPULATION: the table is the one this issue measured", () => {
    // The count that failed is not the finding; the population is. If a row
    // is dropped to make the suite green, this goes red naming the shortfall.
    expect(SPELLINGS.length).toBe(36);
    expect(SPELLINGS.filter(s => s.scanner === "word").length).toBe(12);
    expect(SPELLINGS.filter(s => s.scanner === "subst").length).toBe(19);
    // The third site, added when #1361's review found it still on `indexOf`.
    expect(SPELLINGS.filter(s => s.scanner === "backtick").length).toBe(5);
    expect(SPELLINGS.filter(s => s.runs).length).toBe(31);
    expect(new Set(SPELLINGS.map(s => s.id)).size).toBe(SPELLINGS.length);
  });

  test("FIXTURE: bash agrees with the `runs` column, and the payloads arrived intact", () => {
    const disagree: string[] = [];
    const noisy: string[] = [];
    const quiet: string[] = [];
    for (const s of SPELLINGS) {
      const { runs, stderr } = execute(s.prefix);
      if (runs !== s.runs) disagree.push(`${s.id}: bash says runs=${runs}, table says ${s.runs}`);
      // A row that should run and emitted anything on stderr did not arrive
      // the way it was written. That is a broken fixture, not a finding —
      // UNLESS the row declares `warns`, where the complaint is bash's own
      // and the redirect is performed regardless.
      if (s.runs && !s.warns && stderr.trim()) {
        noisy.push(`${s.id}: ${stderr.trim().split("\n")[0]}`);
      }
      // The other direction, so the flag cannot go stale. A declared warning
      // that stopped appearing means bash changed its mind about the
      // spelling, and the row is no longer the one that was measured.
      if (s.runs && s.warns && !stderr.trim()) quiet.push(s.id);
    }
    expect(disagree).toEqual([]);
    expect(noisy).toEqual([]);
    expect(quiet, "a row declares `warns` and bash said nothing — it is not the row measured").toEqual(
      [],
    );
  });

  test("every spelling that bash actually RUNS is refused", () => {
    const bypasses: string[] = [];
    for (const s of SPELLINGS.filter(r => r.runs)) {
      const cmd = `${s.prefix} > ${LIVE}/${STATE}`;
      if (!decideBashWrite(cmd).blocked) bypasses.push(`${s.scanner}/${s.id}: ${cmd}`);
    }
    expect(bypasses).toEqual([]);
  });

  test("CONTROL: the guard still refuses nothing it did not refuse before", () => {
    // A scanner change that simply blocked everything would pass the battery
    // above. These are ordinary reads that name a protected artifact and must
    // stay allowed — including the escaped-quote spellings, so the fix cannot
    // be "treat a backslash as suspicious".
    for (const cmd of [
      `grep -n "chmod" ${LIVE}/${STATE}`,
      `cat ${LIVE}/${STATE}`,
      `echo "x\\"" > ${FIX}/${STATE}`,
      `git show HEAD:${STATE} | grep -nE "a\\"b"`,
      `jq . ${LIVE}/${STATE}`,
    ]) {
      expect(decideBashWrite(cmd).blocked, cmd).toBe(false);
    }
  });
});

/**
 * #1277: the exemption is decided on the resolved write TARGET, not on a
 * path literal somewhere in the command.
 *
 * ## What was broken to make these fail
 *
 * Nothing had to be broken. All four WITNESS rows below were ALLOWED by
 * `origin/main` (`e17bacf6`) and are refused here — run before the fix, with
 * the four CONTROL rows green in the same run, so the reds are the escape
 * and not a module that stopped loading.
 *
 * Two of the four are the spelling #1276's stopgap was written for, reached
 * by routes it does not cover: a heredoc, which had no body gate at all, and
 * a `.replace` whose replacement is not a literal, so the "is every absolute
 * literal scratch" question answers yes and the write still lands in the run
 * store. That is the class #1277 predicted and the reason the stopgap
 * labelled itself one.
 *
 * ## The population, enumerated rather than asserted to be unchanged
 *
 * Swept over this machine's transcripts — 23,905 files, 50,189 unique Bash
 * commands, 1,843 of them naming a protected artifact:
 *
 *     newly blocked   0
 *     newly allowed   2      both real `/tmp` fixture builds; see REVERSED above
 *
 * A `0` in the blocked column is the reading `.claude/rules/
 * checks-must-be-able-to-fail.md` calls an instrument reporting nothing, so
 * here is what the instrument DID see, at the level the change operates on.
 * Of 531 non-shell interpreter segments in that corpus:
 *
 *     exempt before   15        exempt after    7
 *     lost exemption  11        gained          3
 *     a carrying literal consumed by an expression      235
 *     a body that does not read as complete literals     10
 *     no literal carrying a protected artifact          182
 *
 * So the fragment mechanism is exercised 235 times by real commands, and in
 * every one of them `origin/main` already refused for another reason — which
 * is why the command-level column is 0 and why that 0 is not blindness. The
 * four witnesses are synthesised because no agent on this machine has yet
 * written the escape; that is the same position #1270 was in.
 */
describe("#1277 WITNESS: a computed destination that leaves no non-scratch literal", () => {
  const RUN2 = `${process.env.HOME}/.rungate/run`;
  const escapes: [string, string][] = [
    [
      "a heredoc, which had no body gate at all",
      `python3 <<'PY'\nopen("/tmp/x/${STATE}".replace("/tmp/x", "${RUN2}"), "w").write("{}")\nPY`,
    ],
    [
      "a -e body whose replacement is an env var, not a literal",
      `bun -e 'writeFileSync("/tmp/x/${STATE}".replace("/tmp/x", process.env.RUNGATE_WORK_DIR), "{}")'`,
    ],
    [
      "a -c body whose replacement is expanduser, so no literal is absolute",
      `python3 -I -c "import os; open('/tmp/x/${STATE}'.replace('/tmp/x', os.path.expanduser('~/.rungate/run')),'w').write('{}')"`,
    ],
    [
      "the witnesses DIRECTORY, where there is no basename to compare",
      `bun -e 'writeFileSync("/tmp/x/witnesses/ac-1.json".replace("/tmp/x", process.env.RUNGATE_WORK_DIR), "{}")'`,
    ],
  ];

  test.each(escapes)("%s is refused", (_n, cmd) => {
    expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
  });

  test("MECHANISM: programBody keeps inner quoting, which dequote destroys", () => {
    const seg = `bun -e 'writeFileSync("/tmp/fix/${STATE}", "{}")'`;
    expect(programBody(seg)).toBe(`writeFileSync("/tmp/fix/${STATE}", "{}")`);
    // The view the exemption used to be decided on. With no quotes in it
    // there is no boundary between a literal and the expression consuming
    // it, which is why the `.replace` spelling was invisible: the carrying
    // WORD is `/tmp/x/workflow-state.json.replace`, and it is scratch.
    expect(dequote(seg)).not.toContain('"');
    expect(isScratchPath(`/tmp/x/${STATE}.replace`)).toBe(true);
  });
});

describe("#1277 CONTROL: a destination that is a shell word keeps the plain exemption", () => {
  // The interpreter fixture rows this block held are refused since #2858;
  // their commands are in the #1269 block. What stays exempt is a
  // destination the command line spells as a shell word.
  test("a mutating find keeps the plain exemption — its operands are shell words", () => {
    // `find` has no source literals, so a reader of them would refuse every
    // one. The target question is already asked of its operands directly.
    expect(decideBashWrite(`find ${FIX} -name '*.json' -exec rm ${FIX}/${STATE} ;`).blocked).toBe(false);
    expect(decideBashWrite(`find /tmp/fix -name '*.json' -exec rm ${LIVE}/run/${STATE} ;`).blocked).toBe(true);
  });

  test("a shell -c body keeps the plain exemption — arm 3a re-enters it as shell", () => {
    // #2859: the directory exists before the body runs.
    expect(decideBashWrite(`bash -c 'echo x > ${FIX}/${SALT}'`).blocked).toBe(false);
    expect(decideBashWrite(`bash -c 'echo x > ${LIVE}/run/${SALT}'`).blocked).toBe(true);
  });
});

// ── #1471: a quoted FINAL word kept its closing quote ────────────────────
//
// `endOfQuoted` returned a bare index. For a span closing at the very last
// character that index IS `s.length` — the same value an UNTERMINATED span
// returns — and the one caller that strips the quotes resolved the tie with
// `end === s.length ? s.length : end - 1`. A correctly closed final word
// took the unterminated branch and kept its closing quote.
//
// #1239's defect one level down: there `indexOf` could not tell `"` from
// `\"`; here `s.length` could not tell *closed at the end* from *never
// closed*. `.claude/rules/checks-must-be-able-to-fail.md` names the shape —
// one value is almost never specific to one mechanism. The fix is in
// `endOfQuoted`'s RETURN (`{ end, contentEnd }`), not at the three call
// sites: computing `terminated` locally at each would be three deciders
// over one question, and a mutation of any one would leave the others
// holding the case up.
//
// **The trailing space is not a control at the decision level.** #1471's
// table pairs each spelling with a spaced variant, and `segments()` TRIMS
// the trailing space — so by the time `decideBashWrite` sees them the two
// are the same string. The spaced rows below are asserted at `writeTargets`,
// where the difference is real; the decision-level witness uses the
// UNQUOTED spelling as its control instead.

describe("#1471 WITNESS: a quoted final word resolves without its quote", () => {
  const P = "/tmp/probe-store/workflow-state.json";

  const rows: { id: string; cmd: string }[] = [
    { id: "redirect, double-quoted", cmd: `echo x > "${P}"` },
    { id: "redirect, single-quoted", cmd: `echo x > '${P}'` },
    { id: "append, double-quoted", cmd: `echo x >> "${P}"` },
    { id: "append, single-quoted", cmd: `echo x >> '${P}'` },
    { id: "cp, double-quoted", cmd: `cp /tmp/x "${P}"` },
    { id: "cp, single-quoted", cmd: `cp /tmp/x '${P}'` },
    { id: "mv, double-quoted", cmd: `mv /tmp/x "${P}"` },
    { id: "tee, double-quoted", cmd: `echo x | tee "${P}"` },
  ];

  for (const { id, cmd } of rows) {
    test(`#1471: ${id} — final word`, () => {
      expect(writeTargets(cmd), cmd).toContain(P);
    });

    // The same spelling with one trailing space. It passed BEFORE the fix
    // and must go on passing: it is what shows the quote-stripping itself
    // was never broken, only its boundary case.
    test(`#1471 CONTROL: ${id} — trailing space`, () => {
      expect(writeTargets(`${cmd} `), `${cmd} `).toContain(P);
    });
  }

  test("#1471 CONTROL: an UNTERMINATED quote still runs to end-of-string", () => {
    // The case the ternary was written for. Both are syntax errors bash
    // refuses, so no real write hangs on the answer — but a fix that
    // resolved the ambiguity by always subtracting one would eat the last
    // character of the path here, and that is a silent change to a
    // fail-closed reading.
    expect(writeTargets(`echo x > "${P}`), "unterminated double").toContain(P);
    expect(writeTargets(`echo x > '${P}`), "unterminated single").toContain(P);
  });

  test("#1471 CONTROL: a backtick span still keeps its backticks", () => {
    // The third caller reads `end`, never `contentEnd`, because #1175 wants
    // the span VERBATIM so an unexpanded path stays unplaceable. A fix that
    // handed every caller the stripped boundary would quietly expand it.
    const t = writeTargets("echo x > /tmp/`id -un`/workflow-state.json");
    expect(t.join(" "), "the backtick span was stripped").toContain("`id -un`");
  });
});

describe("#1471 WITNESS: the bypass this reached, at the decision", () => {
  // A trailing quote on a target is not by itself a bypass — `names()`
  // matches with `includes`, so `…/workflow-state.json"` still names the
  // protected file. Measured on the unfixed tree: every PROTECTED_FILES and
  // PROTECTED_HOOKS row still blocked.
  //
  // The reachable bypass is the DIRECTORY destination. `…/hooks/"` does not
  // end with `/`, so the directory is read as a plain file, the
  // `dest/basename(src)` expansion never runs, and the single remaining
  // target names no protected artifact at all. That is #1184's H4 through a
  // new door, and before this fix it ALLOWED.
  const HOOKS = join(import.meta.dir, "..", "hooks");
  const SRC = join(import.meta.dir, "..", "evil.hook.ts");

  test("#1471: the fixture's own premises", () => {
    // Asserted, not assumed. A scratch directory is exempt, so every row
    // would read `blocked=false` INCLUDING the control — which is exactly
    // how this measurement went wrong on its first attempt, against
    // `mkdtemp` under TMPDIR, where all five rows came back identical and
    // the table witnessed nothing.
    expect(existsSync(HOOKS), "the fixture directory does not exist").toBe(true);
    expect(isScratchPath(HOOKS), "the fixture directory is scratch, so every row is exempt").toBe(
      false,
    );
  });

  test("#1471: cp into a quoted directory is refused, as the unquoted form is", () => {
    const unquoted = decideBashWrite(`cp ${SRC} ${HOOKS}/`);
    const quoted = decideBashWrite(`cp ${SRC} "${HOOKS}/"`);

    expect(unquoted.blocked, "the CONTROL stopped refusing, so this row measures nothing").toBe(
      true,
    );
    expect(
      quoted.blocked,
      "a quoted directory destination allowed a hook write — the dest/basename(src) " +
        "expansion was lost because the target kept its closing quote",
    ).toBe(true);
  });

  test("#1471: the expansion itself is back, not just the verdict", () => {
    // `blocked` is one bit and several mechanisms produce it. This asserts
    // the mechanism: the expanded sink is present, and no target carries a
    // quote.
    const t = writeTargets(`cp ${SRC} "${HOOKS}/"`);
    expect(
      t.some(x => x.endsWith("evil.hook.ts")),
      `the dest/basename(src) expansion did not run: ${JSON.stringify(t)}`,
    ).toBe(true);
    expect(
      t.every(x => !x.includes('"')),
      `a target kept its quote: ${JSON.stringify(t)}`,
    ).toBe(true);
  });
});

/**
 * #1367: the scratch exemption holds only when the destination's chain is
 * REAL — not when the command spells no verb on a list.
 *
 * `origin/main` voided the exemption by recognising link-making verbs: a
 * regex over the raw text, an `ln` command-word test and a `cp`/`install`
 * flag reader. A list of ways to make a link is wrong the moment somebody
 * uses one that is not on it. The list is copied here ONLY so the witness
 * rows can prove they walk past it; nothing in `lib/` reads it any more.
 *
 * The property that replaces it, in three parts:
 *
 *   1. every directory between the scratch root and the destination exists
 *      now as a real directory, or a `mkdir` in this command makes it;
 *   2. nothing that runs before the write names one of those directories,
 *      or the destination itself — a `mkdir`'s own arguments excepted;
 *   3. an existing destination is not a link of either kind, and no
 *      existing directory in the chain is a symbolic link.
 *
 * Part 1 is the issue's. Parts 2 and 3 exist because part 1 alone, with the
 * list deleted, re-opens three bypasses the list catches today — each has
 * its own describe below, written before the rule that closes it.
 */
const OLD_LINK_CREATION = /\bln\s|\bsymlinkSync\b|\bos\.symlink\b|\bsymlink\s*\(/;
const VICTIM_1367 = `${process.env.HOME}/.rungate/victim`;


describe("#1367 WITNESS: a link spelling the old list never named", () => {
  // Every row makes `esc` with a spelling `OLD_LINK_CREATION`, the `ln`
  // command word and the `cp -s`/`cp -l` flag reader all miss, then writes
  // through it. `esc` does not exist and nothing `mkdir`s it, so the chain
  // is not real — whichever verb made it.
  const spellings: [string, (b: string) => string][] = [
    ["pathlib's symlink_to", b => `python3 -c "import pathlib; pathlib.Path('${b}/esc').symlink_to('${VICTIM_1367}')"`],
    ["ruby's File.symlink without parentheses", b => `ruby -e 'File.symlink "${VICTIM_1367}", "${b}/esc"'`],
    ["cp -a of a link planted earlier (#1425)", b => `cp -a ${b}/planted ${b}/esc`],
    ["cp -r of a link planted earlier", b => `cp -r ${b}/planted ${b}/esc`],
    ["mv of a link planted earlier", b => `mv ${b}/planted ${b}/esc`],
    ["rsync -a of a link planted earlier", b => `rsync -a ${b}/planted ${b}/esc`],
    ["an archive that carries the link", b => `tar -xf ${b}.tar -C ${b}`],
  ];

  test.each(spellings)("%s: the old list does not name it", (_l, mk) => {
    const cmd = `${mk("/tmp/bw1367")} && echo '{}' > /tmp/bw1367/esc/${STATE}`;
    expect(OLD_LINK_CREATION.test(cmd), cmd).toBe(false);
    expect(segments(cmd).some(s => commandWord(s) === "ln"), cmd).toBe(false);
  });

  test.each(spellings)("%s: refused", (_l, mk) => {
    inScratch(base => {
      const cmd = `${mk(base)} && echo '{}' > ${base}/esc/${STATE}`;
      expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
    });
  });

  // #1425. Its residual was the same-command case: `cp -a` preserves an
  // existing link as a link, and a write through the copy in the SAME command
  // reached the link's target with no link-creating flag anywhere. The rule
  // above (the chain must be real) closes it, and the row in `spellings`
  // shows the decision. This shows the case is a real bypass: run without the
  // guard, the write lands in the target.
  test("#1425: the cp -a row is a real bypass, executed rather than described", () => {
    // A harmless filename stands in for the gate artifact, which the live
    // hook refuses if this test names it.
    inScratch(base => {
      mkdirSync(join(base, "victim"));
      symlinkSync(join(base, "victim"), join(base, "planted"));
      // late-env-ok: the child is `cp` and `echo` under bash, which read no
      // RUNGATE variable and no TMPDIR — both paths are absolute literals
      // computed here and passed on the command line.
      const r = spawnSync("/bin/bash", ["-c", `cp -a ${base}/planted ${base}/esc && echo x > ${base}/esc/SENTINEL`]);
      expect(r.status, String(r.stderr)).toBe(0);
      expect(lstatSync(join(base, "esc")).isSymbolicLink(), "cp -a dereferenced the link, so this platform cannot show the bypass").toBe(true);
      expect(readFileSync(join(base, "victim", "SENTINEL"), "utf8")).toBe("x\n");
      // The same command aimed at the gate artifact is refused.
      expect(decideBashWrite(`cp -a ${base}/planted ${base}/esc2 && echo '{}' > ${base}/esc2/${STATE}`).blocked).toBe(true);
    });
  });

  test("the mv row is a real bypass, executed rather than described", () => {
    // A harmless filename stands in for the gate artifact, which the live
    // hook refuses — correctly — if this test names it.
    inScratch(base => {
      mkdirSync(join(base, "victim"));
      symlinkSync(join(base, "victim"), join(base, "planted"));
      // late-env-ok: the child is `mv` and `echo` under bash, which read no
      // RUNGATE variable and no TMPDIR — both paths are absolute literals
      // computed here and passed on the command line.
      const r = spawnSync("/bin/bash", ["-c", `mv ${base}/planted ${base}/esc && echo x > ${base}/esc/SENTINEL`]);
      expect(r.status).toBe(0);
      expect(readFileSync(join(base, "victim", "SENTINEL"), "utf8")).toBe("x\n");
    });
  });

  test("part 1 alone: an unlisted verb at a path no word spells", () => {
    // Every row above also NAMES `esc`, so part 2 refuses it too and a
    // mutation of part 1 alone moves none of them. This one decodes the path
    // at run time with a verb the old list never had, so the only thing that
    // can see it is the property the issue asked for: `esc` does not exist
    // and nothing `mkdir`s it.
    inScratch(base => {
      const encoded = Buffer.from(`${base}/esc`).toString("base64");
      const cmd =
        `python3 -c "import base64, pathlib; pathlib.Path(base64.b64decode('${encoded}').decode()).symlink_to('/usr')" ` +
        `&& echo '{}' > ${base}/esc/${STATE}`;
      expect(OLD_LINK_CREATION.test(cmd), cmd).toBe(false);
      expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
    });
  });

  test("CONTROL: the documented `ln -s` shape is still refused", () => {
    inScratch(base => {
      expect(decideBashWrite(`ln -s ${VICTIM_1367} ${base}/esc && echo '{}' > ${base}/esc/${STATE}`).blocked).toBe(true);
    });
  });
});

describe("#1367 CONTROL: a fixture whose directory is real stays exempt", () => {
  // The load-bearing half: a property that refused every fixture would pass
  // every witness above. Since #2859 the directory is made before the
  // command is judged, in a command of its own, as `d` and `d/e` are here.
  const rows: [string, (b: string) => string][] = [
    ["cp x d", b => `cp ${b}/src.json ${b}/d/${STATE}`],
    ["cp x into d/", b => `cp ${b}/x/${STATE} ${b}/d/`],
    ["a redirect two levels down", b => `echo '{}' > ${b}/d/e/${STATE}`],
    ["a mkdir of a directory that already exists changes nothing", b => `mkdir -p ${b}/d && echo '{}' > ${b}/d/${STATE}`],
    ["a directory that already exists, no mkdir", b => `echo '{}' > ${b}/${STATE}`],
    ["the write read back afterwards", b => `echo '{}' > ${b}/d/${STATE} && cat ${b}/d/${STATE}`],
    [
      "the directory handed to a later step",
      b => `echo '{}' > ${b}/d/${STATE} && TEST_WORK_DIR=${b}/d bun test x 2>&1 | tail -20`,
    ],
    ["a hook copied into a backup directory", b => `cp -p hooks/X.hook.ts ${b}/d/`],
  ];
  test.each(rows)("%s", (_l, build) => {
    inScratch(base => {
      mkdirSync(join(base, "d", "e"), { recursive: true });
      const cmd = build(base);
      const d = decideBashWrite(cmd);
      expect(d.blocked, `refused: ${cmd} — ${d.reason}`).toBe(false);
    });
  });
});

describe("#1367 COST: refused, and the reason is the property", () => {
  // #2859: a missing directory is never exempt, whoever makes it: a
  // program, a variable, or a shell `mkdir` in the same command.
  test("a directory a program makes, or one behind a variable, is refused (#2859)", () => {
    inScratch(base => {
      for (const cmd of [
        `bun -e 'require("fs").mkdirSync("${base}/d/e", {recursive: true})' && echo '{}' > ${base}/d/e/${STATE}`,
        `python3 -I -c "import os; os.makedirs('${base}/d', exist_ok=True)" && echo '{}' > ${base}/d/${STATE}`,
        `D=${base}/d; mkdir -p $D/e && echo '{}' > ${base}/d/e/${STATE}`,
      ]) expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
    });
  });

  test("a directory nothing makes is refused — the write would fail anyway", () => {
    inScratch(base => {
      expect(decideBashWrite(`echo '{}' > ${base}/nosuch/${STATE}`).blocked).toBe(true);
    });
  });

  // Refused for #2859's reason: `d` does not exist when the command is
  // judged, whatever the `mkdir` after the reset makes. The `ln -s` spelling
  // is refused because a command that links has no exemption.
  test("resetting the directory in the same command is refused, and so is its linking spelling", () => {
    inScratch(base => {
      expect(decideBashWrite(`rm -rf ${base}/d && mkdir -p ${base}/d && cat > ${base}/d/${STATE} <<'EOF'\n{}\nEOF`).blocked).toBe(true);
      expect(decideBashWrite(`ln -s /usr ${base}/d && mkdir -p ${base}/d && cat > ${base}/d/${STATE} <<'EOF'\n{}\nEOF`).blocked).toBe(true);
    });
  });
});

describe("#1367 BYPASS 1: a link made before the mkdir that forgives it", () => {
  // `mkdir -p` succeeds silently when its argument is already a link to a
  // directory, so the forgiveness clause alone forgave the link.
  const rows: [string, (b: string) => string][] = [
    ["ln -s, then mkdir -p", b => `ln -s ${VICTIM_1367} ${b}/esc && mkdir -p ${b}/esc && echo '{}' > ${b}/esc/${STATE}`],
    [
      // The link target is built from the environment on purpose: a literal
      // run-store path in a writing body is refused by #1371's live-tree
      // reading, which would hold this row up for the wrong reason.
      "pathlib, then os.makedirs, in one body",
      b =>
        `python3 -c "import os, pathlib; pathlib.Path('${b}/esc').symlink_to(os.environ['HOME'] + '/.rungate/victim'); ` +
        `os.makedirs('${b}/esc', exist_ok=True); open('${b}/esc/${STATE}','w').write('{}')"`,
    ],
    ["ln -s through a variable", b => `E=${b}/esc; ln -s ${VICTIM_1367} $E && mkdir -p $E && echo '{}' > ${b}/esc/${STATE}`],
    ["ln -s from the parent, relatively", b => `cd ${b} && ln -s ${VICTIM_1367} esc && mkdir -p ${b}/esc && echo '{}' > ${b}/esc/${STATE}`],
    ["ln -s spelled in another case", b => `ln -s ${VICTIM_1367} ${b}/ESC && mkdir -p ${b}/esc && echo '{}' > ${b}/esc/${STATE}`],
  ];
  test.each(rows)("%s", (_l, build) => {
    inScratch(base => {
      const cmd = build(base);
      expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
    });
  });

  test("the link really survives mkdir -p, executed", () => {
    inScratch(base => {
      mkdirSync(join(base, "victim"));
      // late-env-ok: the child is `ln`, `mkdir` and `echo` under bash, which
      // read no RUNGATE variable and no TMPDIR — every path is an absolute literal.
      const r = spawnSync("/bin/bash", [
        "-c",
        `ln -s ${base}/victim ${base}/esc && mkdir -p ${base}/esc && echo x > ${base}/esc/SENTINEL`,
      ]);
      expect(r.status).toBe(0);
      expect(readFileSync(join(base, "victim", "SENTINEL"), "utf8")).toBe("x\n");
    });
  });
});

describe("#1367 BYPASS 2: an existing directory removed and replaced in the same command", () => {
  // The chain is real when the decision is taken, and is not by the time
  // the write runs.
  const rows: [string, (b: string) => string][] = [
    ["rmdir, then ln -s", b => `rmdir ${b}/real && ln -s ${VICTIM_1367} ${b}/real && echo '{}' > ${b}/real/${STATE}`],
    ["rmdir and ln -s inside eval", b => `eval 'rmdir ${b}/real; ln -s ${VICTIM_1367} ${b}/real' && echo '{}' > ${b}/real/${STATE}`],
    [
      "rmdir and ln -s in a shell -c body",
      b => `bash -c 'rmdir ${b}/real && ln -s ${VICTIM_1367} ${b}/real' && echo '{}' > ${b}/real/${STATE}`,
    ],
    ["the path built by a substitution", b => `rmdir "$(echo ${b}/real)" && ln -s ${VICTIM_1367} ${b}/real && echo '{}' > ${b}/real/${STATE}`],
    ["concurrently, in a pipeline", b => `echo '{}' > ${b}/real/${STATE} | (rmdir ${b}/real; ln -s ${VICTIM_1367} ${b}/real)`],
  ];
  test.each(rows)("%s", (_l, build) => {
    inScratch(base => {
      mkdirSync(join(base, "real"));
      const cmd = build(base);
      expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
    });
  });

  // ADR-027 decision 4: a link made some other way is outside an accident
  // guard. An `mv` of a link planted earlier, over a directory that is real
  // when the decision is taken, is one, and #2859 concedes it.
  test("CONCESSION: rm -rf, then mv a planted link, is allowed (#2859)", () => {
    inScratch(base => {
      mkdirSync(join(base, "real"));
      const cmd = `rm -rf ${base}/real && mv ${base}/planted ${base}/real && echo '{}' > ${base}/real/${STATE}`;
      expect(decideBashWrite(cmd).blocked, cmd).toBe(false);
    });
  });

  test("CONTROL: the same directory, untouched, stays exempt", () => {
    inScratch(base => {
      mkdirSync(join(base, "real"));
      expect(decideBashWrite(`echo '{}' > ${base}/real/${STATE} && ls ${base}/real`).blocked).toBe(false);
    });
  });
});

describe("#1367 BYPASS 3: a link at the destination file itself", () => {
  // The chain property is about DIRECTORIES. A hard link at the file aims
  // the write at the victim's inode with every directory real.
  const rows: [string, (b: string) => string][] = [
    ["cp -l, the same command", b => `cp -l ${VICTIM_1367}/${STATE} ${b}/${STATE} && echo '{}' > ${b}/${STATE}`],
    ["link(1), which the old list never named", b => `link ${VICTIM_1367}/${STATE} ${b}/${STATE} && echo '{}' > ${b}/${STATE}`],
  ];
  test.each(rows)("%s", (_l, build) => {
    inScratch(base => {
      const cmd = build(base);
      expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
    });
  });

  test("a destination that is already a hard link is refused — the two-command form", () => {
    inScratch(base => {
      writeFileSync(join(base, "other.json"), "{}");
      linkSync(join(base, "other.json"), join(base, STATE));
      expect(decideBashWrite(`echo '{}' > ${base}/${STATE}`).blocked).toBe(true);
    });
  });

  test("a destination that is already a symbolic link is refused", () => {
    inScratch(base => {
      writeFileSync(join(base, "other.json"), "{}");
      symlinkSync(join(base, "other.json"), join(base, STATE));
      expect(decideBashWrite(`echo '{}' > ${base}/${STATE}`).blocked).toBe(true);
    });
  });

  test("CONTROL: an ordinary existing destination stays exempt", () => {
    inScratch(base => {
      writeFileSync(join(base, STATE), "{}");
      expect(decideBashWrite(`echo '{}' > ${base}/${STATE}`).blocked).toBe(false);
    });
  });
});

describe("#1367: an existing directory in the chain must not be a link", () => {
  test("a symlink that points INTO scratch is refused — it can be re-aimed unseen", () => {
    inScratch(base => {
      mkdirSync(join(base, "realdir"));
      symlinkSync(join(base, "realdir"), join(base, "esc"));
      expect(decideBashWrite(`echo '{}' > ${base}/esc/${STATE}`).blocked).toBe(true);
      // The control: the same directory under its own name.
      expect(decideBashWrite(`echo '{}' > ${base}/realdir/${STATE}`).blocked).toBe(false);
    });
  });
});

describe("#1367: a program that calls a link function names every path (Jason, option (b), 2026-11-16)", () => {
  // Was a KNOWN GAP pinned as allowed: a program that decodes a directory's
  // name at run time and re-links an EXISTING directory names nothing a
  // reader can see. With the verb list deleted, that was a regression for
  // the list's own spellings (`os.symlink`, `symlinkSync`, `symlink(`) —
  // refused on main, allowed here. Jason chose a narrow fail-closed check:
  // an interpreter body that calls a link function names every path, so a
  // write after it or alongside it is not exempt. A body that only makes
  // directories (the mkdirSync fixtures) calls none and is unaffected.
  test("an existing directory re-linked from a decoded name is refused", () => {
    inScratch(base => {
      mkdirSync(join(base, "real"));
      const encoded = Buffer.from(`${base}/real`).toString("base64");
      const cmd =
        `python3 -c "import os, base64; p = base64.b64decode('${encoded}').decode(); ` +
        `os.rmdir(p); os.symlink('${VICTIM_1367}', p)" && echo '{}' > ${base}/real/${STATE}`;
      expect(decideBashWrite(cmd).blocked).toBe(true);
    });
  });

  // Every spelling, each re-linking (or hard-linking) with a name it computes.
  const rows: [string, (b64: string) => string][] = [
    ["node fs.symlinkSync", e => `node -e "const fs=require('fs');const p=Buffer.from('${e}','base64').toString();fs.rmdirSync(p);fs.symlinkSync('${VICTIM_1367}',p)"`],
    ["node fs.promises.symlink(", e => `node -e "const fs=require('fs');const p=Buffer.from('${e}','base64').toString();fs.rmdirSync(p);fs.promises.symlink('${VICTIM_1367}',p)"`],
    ["python pathlib symlink_to", e => `python3 -c "import base64, pathlib; p = pathlib.Path(base64.b64decode('${e}').decode()); p.rmdir(); p.symlink_to('${VICTIM_1367}')"`],
    ["ruby File.symlink, no parentheses", e => `ruby -e "require 'base64'; p = Base64.decode64('${e}'); Dir.rmdir(p); File.symlink '${VICTIM_1367}', p"`],
    ["perl symlink, no parentheses", e => `perl -e "use MIME::Base64; my \\$p = decode_base64('${e}'); rmdir \\$p; symlink '${VICTIM_1367}', \\$p"`],
    ["python subprocess ln", e => `python3 -c "import base64, os, subprocess; p = base64.b64decode('${e}').decode(); os.rmdir(p); subprocess.run(['ln', '-s', '${VICTIM_1367}', p])"`],
  ];
  test.each(rows)("%s, re-linking an existing directory from a decoded name, is refused", (_l, body) => {
    inScratch(base => {
      mkdirSync(join(base, "real"));
      const cmd = `${body(Buffer.from(`${base}/real`).toString("base64"))} && echo '{}' > ${base}/real/${STATE}`;
      expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
    });
  });

  const hard: [string, (b64: string) => string][] = [
    ["python os.link", e => `python3 -c "import base64, os; os.link('${VICTIM_1367}', base64.b64decode('${e}').decode())"`],
    ["node fs.linkSync", e => `node -e "require('fs').linkSync('${VICTIM_1367}', Buffer.from('${e}','base64').toString())"`],
    ["python pathlib hardlink_to", e => `python3 -c "import base64, pathlib; pathlib.Path(base64.b64decode('${e}').decode()).hardlink_to('${VICTIM_1367}')"`],
  ];
  test.each(hard)("%s, hard-linking the destination file from a decoded name, is refused", (_l, body) => {
    inScratch(base => {
      const cmd = `${body(Buffer.from(`${base}/${STATE}`).toString("base64"))} && echo '{}' > ${base}/${STATE}`;
      expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
    });
  });

  test("the link call and the write in ONE body are refused", () => {
    inScratch(base => {
      mkdirSync(join(base, "real"));
      const encoded = Buffer.from(`${base}/real`).toString("base64");
      const cmd =
        `python3 -c "import os, base64; p = base64.b64decode('${encoded}').decode(); os.rmdir(p); ` +
        `os.symlink('${VICTIM_1367}', p); open('${base}/real/${STATE}', 'w').write('{}')"`;
      expect(decideBashWrite(cmd).blocked).toBe(true);
    });
  });

  // #2859: the guard does not track which step runs when, so a link call
  // anywhere in the command withdraws the exemption, after the write too.
  test("a link call that runs AFTER the write still withdraws the exemption (#2859)", () => {
    inScratch(base => {
      mkdirSync(join(base, "real"));
      const cmd = `echo '{}' > ${base}/real/${STATE} && python3 -c "import os; os.symlink('/nonexistent-a', '/nonexistent-b')"`;
      expect(decideBashWrite(cmd).blocked).toBe(true);
      // the same write with no link call is a fixture
      expect(decideBashWrite(`echo '{}' > ${base}/real/${STATE}`).blocked).toBe(false);
    });
  });

  test("the same program against a directory that does not exist is refused", () => {
    inScratch(base => {
      const encoded = Buffer.from(`${base}/esc`).toString("base64");
      const cmd =
        `python3 -c "import os, base64; os.symlink('${VICTIM_1367}', base64.b64decode('${encoded}').decode())" ` +
        `&& echo '{}' > ${base}/esc/${STATE}`;
      expect(decideBashWrite(cmd).blocked).toBe(true);
    });
  });
});

/**
 * #1367 review findings 4–6: three more bypasses an automated security
 * review found in parts 2 and 3, each written red before its fix.
 */
describe("#1367 BYPASS 4: a link whose NAME is a source operand's basename", () => {
  // `ln -s V DIR/` and `ln -s V -t DIR` name the link after `V`'s basename.
  // When DIR is the scratch root, no word spells the chain directory at all.
  const ROOT = tmpdir();
  const name = "bw1367-root-esc";
  const V = `${process.env.HOME}/.rungate/${name}`;
  const write = `mkdir -p ${ROOT}/${name} && echo '{}' > ${ROOT}/${name}/${STATE}`;
  const rows: [string, string][] = [
    ["ln -s V ROOT/", `ln -s ${V} ${ROOT}/ && ${write}`],
    ["ln -s V -t ROOT", `ln -s ${V} -t ${ROOT} && ${write}`],
    ["ln -s V --target-directory=ROOT", `ln -s ${V} --target-directory=${ROOT} && ${write}`],
  ];
  test.each(rows)("%s", (_l, cmd) => {
    expect(existsSync(join(ROOT, name)), "the row needs the directory absent").toBe(false);
    expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
  });
});

describe("#1367 BYPASS 5: a path spelled through the command's own HOME, a tilde form, or the environment", () => {
  const rows: [string, (b: string) => string][] = [
    ["HOME reassigned, then ~/", b => `HOME=${b}; ln -s ${VICTIM_1367} ~/esc && mkdir -p ${b}/esc && echo '{}' > ${b}/esc/${STATE}`],
    ["HOME reassigned, then $HOME", b => `HOME=${b}; ln -s ${VICTIM_1367} $HOME/esc && mkdir -p ${b}/esc && echo '{}' > ${b}/esc/${STATE}`],
    // The link is named after the source's basename, inside the working
    // directory an EARLIER command left the session in.
    ["~+ — the working directory", b => `ln -s ${process.env.HOME}/.rungate/bw1367v ~+ && mkdir -p ${b}/bw1367v && echo '{}' > ${b}/bw1367v/${STATE}`],
    ["~user", b => `ln -s ${process.env.HOME}/.rungate/bw1367v ~nobody && mkdir -p ${b}/bw1367v && echo '{}' > ${b}/bw1367v/${STATE}`],
    [
      "a plain assignment to a name the environment already exports",
      b =>
        // expanduser reads HOME from the environment without the body ever
        // spelling the name — so only the assignment carries the path.
        `HOME=${b}/esc; python3 -c "import os; os.symlink('/usr', os.path.expanduser('~'))" && ` +
        `mkdir -p ${b}/esc && echo '{}' > ${b}/esc/${STATE}`,
    ],
  ];
  test.each(rows)("%s", (_l, build) => {
    inScratch(base => {
      const cmd = build(base);
      expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
    });
  });

  // #2859: a missing directory is never exempt, so a `mkdir` forgives
  // nothing, spelled out or behind a variable.
  test("a mkdir, spelled out or behind a variable, does not make a missing directory exempt (#2859)", () => {
    inScratch(base => {
      expect(decideBashWrite(`D1367=${base}/d; mkdir -p $D1367 && echo '{}' > ${base}/d/${STATE}`).blocked).toBe(true);
      expect(decideBashWrite(`mkdir -p ${base}/d && echo '{}' > ${base}/d/${STATE}`).blocked).toBe(true);
      mkdirSync(join(base, "d"));
      expect(decideBashWrite(`echo '{}' > ${base}/d/${STATE}`).blocked).toBe(false);
    });
  });
});

describe("#1367 BYPASS 6: a write that runs LATER than a step after it", () => {
  // Position is not order when a step runs asynchronously. Each write below
  // is delayed, and the re-link after it wins the race.
  const rows: [string, (b: string) => string][] = [
    [
      "coproc with a brace group",
      b => `coproc { sleep 1; echo '{}' > ${b}/real/${STATE}; }; rmdir ${b}/real; ln -s ${VICTIM_1367} ${b}/real`,
    ],
    ["coproc, simple form", b => `coproc cat > ${b}/real/${STATE}; rmdir ${b}/real; ln -s ${VICTIM_1367} ${b}/real`],
    [
      "a process substitution",
      b => `echo '{}' > >(sleep 1; cat > ${b}/real/${STATE}); rmdir ${b}/real; ln -s ${VICTIM_1367} ${b}/real`,
    ],
    [
      "a subshell",
      b => `( sleep 1; echo '{}' > ${b}/real/${STATE} ) & rmdir ${b}/real; ln -s ${VICTIM_1367} ${b}/real`,
    ],
  ];
  test.each(rows)("%s", (_l, build) => {
    inScratch(base => {
      mkdirSync(join(base, "real"));
      const cmd = build(base);
      expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
    });
  });
});

/**
 * #2701: write spellings `WRITE_INTENT` did not list. `shutil\.copy\b` does
 * not match `copy2`, a digit being a word character, and the Node verbs were
 * listed only in their `Sync` forms. Each is a write onto a protected
 * artifact, short enough that the window reaches it: the verb list is the
 * question here, not distance (#1407 was distance).
 */
describe("#2701: the write spellings the verb list missed", () => {
  const witnesses: Array<[string, string]> = [
    ["shutil.copy2", `python3 -c "import shutil; shutil.copy2('/tmp/a.json', '${LIVE}/${STATE}')"`],
    ["shutil.copyfile", `python3 -c "import shutil; shutil.copyfile('/tmp/a.json', '${LIVE}/${STATE}')"`],
    ["shutil.copytree", `python3 -c "import shutil; shutil.copytree('/tmp/w', '${LIVE}/witnesses/')"`],
    ["Path.write_bytes", `python3 -c "import pathlib; pathlib.Path('${LIVE}/${STATE}').write_bytes(b'{}')"`],
    ["Path.rename", `python3 -c "import pathlib; pathlib.Path('/tmp/a.json').rename('${LIVE}/${STATE}')"`],
    ["fs.writeFile", `node -e "require('fs').writeFile('${LIVE}/${STATE}', '{}', () => {})"`],
    ["fs.appendFile", `node -e "require('fs').appendFile('${LIVE}/${STATE}', '{}', () => {})"`],
    ["fs.copyFile", `node -e "require('fs').copyFile('/tmp/a.json', '${LIVE}/${STATE}', () => {})"`],
    ["fs.rename", `node -e "require('fs').rename('/tmp/a.json', '${LIVE}/${STATE}', () => {})"`],
    ["fs.promises.writeFile", `node -e "require('fs').promises.writeFile('${LIVE}/${STATE}', '{}')"`],
    ["fs.openSync with a write flag", `node -e "require('fs').openSync('${LIVE}/${STATE}', 'w')"`],
    // #2704 review round 1: the deletions in the same Sync-only class.
    ["fs.unlink", `node -e "require('fs').unlink('${LIVE}/${STATE}', () => {})"`],
    ["fs.rm", `node -e "require('fs').rm('${LIVE}/${STATE}', () => {})"`],
    ["fs.truncate", `node -e "require('fs').truncate('${LIVE}/${STATE}', 0, () => {})"`],
    ["Path.unlink", `python3 -c "import pathlib; pathlib.Path('${LIVE}/${STATE}').unlink()"`],
    // #2704 review round 2.
    ["fs.cpSync", `node -e "require('fs').cpSync('/tmp/a.json', '${LIVE}/${STATE}')"`],
    ["fs.cp", `node -e "require('fs').cp('/tmp/a.json', '${LIVE}/${STATE}', () => {})"`],
    ["os.open with a write flag", `python3 -c "import os; os.open('${LIVE}/${STATE}', os.O_WRONLY | os.O_TRUNC)"`],
    ["os.open with a nested call in its path", `python3 -c "import os; os.open(os.path.join(os.environ['R'], '${STATE}'), os.O_WRONLY)"`],
  ];
  test.each(witnesses)("WITNESS: %s onto a protected artifact is refused", (_l, cmd) => {
    expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
  });

  // #1411's shape for two of the new copies: a scratch SOURCE and a
  // destination the guard cannot read. The scratch source must not exempt it.
  test.each([
    ["shutil.copy2", `mkdir -p /tmp/rg2701a && python3 -I -c "import shutil, os; shutil.copy2('/tmp/rg2701a/${STATE}', os.environ['RG'])"`],
    ["fs.copyFile", `mkdir -p /tmp/rg2701a && node -e "require('fs').copyFile('/tmp/rg2701a/${STATE}', process.env.RG, () => {})"`],
  ])("WITNESS: %s from a scratch source to an unread destination is refused", (_l, cmd) => {
    expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
  });

  // A scratch fixture writing a protected name through one of these verbs is
  // refused. #2701 pinned this as the cost of keeping the verbs out of the
  // exemption's callee list; since #2858 there is no interpreter exemption
  // and no list, and every interpreter write beside a protected name is
  // refused wherever it points.
  test.each([
    ["shutil.copy2", `mkdir -p /tmp/rg2701a /tmp/rg2701b && python3 -I -c "import shutil; shutil.copy2('/tmp/rg2701a/${STATE}', '/tmp/rg2701b/${STATE}')"`],
    ["fs.writeFile", `mkdir -p /tmp/rg2701b && node -e "require('fs').writeFile('/tmp/rg2701b/${STATE}', '{}', () => {})"`],
    ["fs.rm", `mkdir -p /tmp/rg2701b && node -e "require('fs').rm('/tmp/rg2701b/${STATE}', () => {})"`],
  ])("COST: a scratch fixture writing through %s is refused", (_l, cmd) => {
    expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
  });

  // A receiver write (`Path(p).write_text(…)`) puts the path where the
  // exemption cannot place it, so a scratch one was refused before #2701 and
  // still is. `write_bytes` is the same shape and must answer the same way.
  test("PARITY: write_bytes answers as write_text does, on a scratch tree and a live one", () => {
    for (const path of [`/tmp/rg2701b/${STATE}`, `${LIVE}/${STATE}`]) {
      const text = decideBashWrite(`mkdir -p /tmp/rg2701b && python3 -I -c "import pathlib; pathlib.Path('${path}').write_text('{}')"`).blocked;
      const bytes = decideBashWrite(`mkdir -p /tmp/rg2701b && python3 -I -c "import pathlib; pathlib.Path('${path}').write_bytes(b'{}')"`).blocked;
      expect(bytes, path).toBe(text);
    }
  });

  test("CONTROL: fs.openSync and os.open for reading are not writes", () => {
    for (const cmd of [
      `node -e "const fd = require('fs').openSync('${LIVE}/${STATE}', 'r'); console.log(fd)"`,
      `python3 -c "import os; print(os.open('${LIVE}/${STATE}', os.O_RDONLY))"`,
    ]) expect(decideBashWrite(cmd).blocked, cmd).toBe(false);
  });
});

/**
 * #2704 review: the exemption's callee list (deleted with the exemption in
 * #2858) trusted a name by its last segment, so a body that bound its own
 * function under it and called it on a scratch literal exempted itself.
 * Every form below was refused on main and still is: an interpreter body
 * beside a protected name has no exemption to walk through.
 */
describe("#2704: the new verbs do not open the scratch exemption", () => {
  const forms: Array<[string, string]> = [
    ["a Python def rm", `import os\ndef rm(p): os.remove(os.environ['RG'])\nrm('/tmp/rg2704c/${STATE}')`],
    ["a compound statement binding rm", `import os\nif True: rm = lambda p: os.remove(os.environ['RG'])\nrm('/tmp/rg2704c/${STATE}')`],
    ["a parameter named rm", `import os\ndef go(rm): rm('/tmp/rg2704c/${STATE}')\ngo(lambda p: os.remove(os.environ['RG']))`],
    ["a loop variable named rm", `import os\nfor rm in [lambda p: os.remove(os.environ['RG'])]: rm('/tmp/rg2704c/${STATE}')`],
    ["a tuple binding rm", `import os\nrm, _ = (lambda p: os.remove(os.environ['RG'])), 0\nrm('/tmp/rg2704c/${STATE}')`],
    ["an import bound as rm", `import os\nfrom os import remove as rm\nrm('/tmp/rg2704c/${STATE}'); os.remove(os.environ['RG'])`],
  ];
  test.each(forms)("WITNESS: %s is refused, as on main", (_l, body) => {
    const cmd = `mkdir -p /tmp/rg2704c && python3 -I -c "${body}"`;
    expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
  });

  test("WITNESS: a JavaScript function or const rm is refused, as on main", () => {
    for (const body of [
      `function rm(p) { require('fs').rmSync(process.env.RG) }; rm('/tmp/rg2704c/${STATE}')`,
      `const rm = p => require('fs').rmSync(process.env.RG); rm('/tmp/rg2704c/${STATE}')`,
    ]) {
      const cmd = `mkdir -p /tmp/rg2704c && node -e "${body}"`;
      expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
    }
  });

  // #2705: a body defining its own `copy` exempted itself while the
  // exemption read callees by name. With the exemption gone (#2858) it is
  // refused like the forms above.
  test("WITNESS (#2705): a body defining its own copy is refused", () => {
    const cmd = `mkdir -p /tmp/rg2704c && python3 -I -c "import os, shutil\ndef copy(a, b): shutil.copy(b, os.environ['RG'])\ncopy('/tmp/rg2704c/x', '/tmp/rg2704c/${STATE}')"`;
    expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
  });
});

/**
 * #2858, ADR-027 decisions 2 and 3: the behaviour that criterion SC-2811 in
 * HOOK-ARCHITECTURE-SPEC.md states. Written as a citation and not a claim on
 * purpose: the criterion is tagged behavioural, and ticking it would raise
 * the behavioural ratchet in `test/behavioral-sc-ratchet.test.ts`, which only
 * falls. Whether the tag goes is the criterion owner's call, recorded on the
 * pull request.
 *
 * An interpreter body that names a protected artifact beside a declared write
 * verb is refused, whatever directory it names. Before #2858 a body whose
 * write targets the guard could read as scratch was exempt; the reading that
 * decided it (`bodyTargets`, `callWrites` and the callee identity) is gone,
 * and only the write-intent window decides. A shell write into a scratch tree
 * keeps its exemption: its destination is a shell word, not a source literal.
 */
describe("#2858: an interpreter body naming a protected artifact beside a write verb is refused wherever it points", () => {
  const HARNESS = "/opt/bwprobe/harness";
  const bodies: Array<[string, (p: string) => string]> = [
    ["python open(…, 'w')", p => `python3 -I -c "open('${p}', 'w').write('{}')"`],
    ["python shutil.copy", p => `python3 -I -c "import shutil; shutil.copy('/tmp/rg2858/src', '${p}')"`],
    ["node writeFileSync", p => `node -e "require('fs').writeFileSync('${p}', '{}')"`],
    ["bun copyFileSync", p => `bun -e "require('fs').copyFileSync('/tmp/rg2858/src', '${p}')"`],
    ["python on stdin", p => `python3 <<'PY'\nopen('${p}', 'w').write('{}')\nPY`],
    ["node on stdin", p => `node <<'JS'\nrequire('fs').writeFileSync('${p}', '{}')\nJS`],
  ];
  const targets: Array<[string, string]> = [
    ["a scratch tree the command makes", `/tmp/rg2858/${STATE}`],
    ["a scratch tree, the gate salt", `/tmp/rg2858/${SALT}`],
    ["a scratch tree, a witness", `/tmp/rg2858/witnesses/w.json`],
    ["a scratch tree, a hook", `/tmp/rg2858/hooks/X.hook.ts`],
    ["a live tree", `${LIVE}/${STATE}`],
  ];
  const rows = bodies.flatMap(([b, body]) =>
    targets.map(([t, p]) => [`${b} into ${t}`, `mkdir -p /tmp/rg2858/witnesses /tmp/rg2858/hooks && ${body(p)}`] as [string, string]),
  );

  test.each(rows)("WITNESS: %s is refused", (_l, cmd) => {
    const d = decideBashWrite(cmd);
    expect(d.blocked, cmd).toBe(true);
    // The interpreter arm's own words, so a refusal by another arm cannot
    // pass for this one.
    expect(d.reason ?? "", cmd).toContain("runs an interpreter");
  });

  test("WITNESS: a body writing into a real directory under the platform temp root is refused", () => {
    inScratch(root => {
      for (const [, body] of bodies) {
        const cmd = body(`${root}/${STATE}`);
        expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
      }
    });
  });

  test("CONTROL: reading a protected artifact is not a write, in either tree", () => {
    for (const p of [`/tmp/rg2858/${STATE}`, `${LIVE}/${STATE}`]) {
      for (const cmd of [
        `python3 -I -c "import json; print(json.load(open('${p}')))"`,
        `node -e "console.log(require('fs').readFileSync('${p}', 'utf8'))"`,
        `python3 <<'PY'\nimport json\nprint(json.load(open('${p}')))\nPY`,
      ]) expect(decideBashWrite(cmd).blocked, cmd).toBe(false);
    }
  });

  test("CONTROL: the sanctioned writeWorkflowState repair stays allowed, in either tree", () => {
    for (const p of [`/tmp/rg2858/${STATE}`, `${LIVE}/${STATE}`]) {
      const cmd = `bun -e "import {writeWorkflowState} from '${HARNESS}/gates/orchestrator.ts'; import {readFileSync} from 'fs'; const s = JSON.parse(readFileSync('${p}','utf8')); writeWorkflowState('${p}', s);"`;
      expect(decideBashWrite(cmd).blocked, cmd).toBe(false);
    }
  });

  test("CONTROL: a shell write into a scratch tree keeps its exemption", () => {
    for (const cmd of [
      `echo '{}' > ${FIX}/${STATE}`,
      `cp ${FIX}/src ${FIX}/${STATE}`,
    ]) expect(decideBashWrite(cmd).blocked, cmd).toBe(false);
    // The same write into the live tree is refused, so the rows above are the
    // exemption working and not an arm that refuses nothing.
    expect(decideBashWrite(`echo '{}' > ${LIVE}/${STATE}`).blocked).toBe(true);
  });

  // Local review of #2858: a shell `-c` body kept the plain exemption for its
  // write-verb check, so wrapping the body in `bash -c` with a `mkdir` got the
  // scratch exemption back.
  test("WITNESS: an interpreter body inside a bash -c body is refused, as unwrapped", () => {
    for (const cmd of [
      `bash -c "mkdir -p /tmp/rg2858 && python3 -c \\"open('/tmp/rg2858/${STATE}','w')\\""`,
      `mkdir -p /tmp/rg2858 && python3 -c "open('/tmp/rg2858/${STATE}','w')"`,
    ]) expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
    // The shell write in the same wrapper keeps its exemption.
    expect(decideBashWrite(`bash -c 'echo x > ${FIX}/${SALT}'`).blocked).toBe(false);
  });

  // The window opens at the path start, so the depth of the directory does
  // not decide the verdict. A write verb before a long path that is only read
  // refuses, as it did on main before a short one.
  test("PARITY: a read near an unrelated write answers the same for a short path and a long one", () => {
    const deep = `/Users/someone/.rungate/my-project-slug/runs/wf_0b15a933-b2b-abcdef`;
    const body = (dir: string) => `python3 -c "import json; open('/tmp/out.md','w').write('x'); d = json.load(open('${dir}/${STATE}'))"`;
    expect(decideBashWrite(body("/x")).blocked).toBe(true);
    expect(decideBashWrite(body(deep)).blocked).toBe(decideBashWrite(body("/x")).blocked);
  });

  // Local review of #2858: an unbounded walk back to the path start made a
  // body of one name repeated with no separator quadratic — 4.6 s for 40 KB.
  test("a body of one name repeated 2,000 times is decided in bounded time", () => {
    const cmd = `python3 <<'PY'\nx = '/a${("/" + STATE).repeat(2000)}'\nopen(x,'w')\nPY`;
    const t = performance.now();
    expect(decideBashWrite(cmd).blocked).toBe(true);
    expect(performance.now() - t).toBeLessThan(2000);
  });

  // Review of #2863, round 3: the window closes at the end of the path, not
  // the name; and a grouped flag with a capital is still `-c`.
  test.each([
    ["a witness with a 200-character tail after the name", `python3 -c "open('/home/u/witnesses/${"a".repeat(200)}.json','w').write('{}')"`],
    ["a grouped -Ic flag", `python3 -Ic "open('/repo/${STATE}','w').write('{}')"`],
    ["a shell body behind a grouped -Ec flag", `bash -Ec 'echo x > /opt/bwprobe/${STATE}'`],
    ["a shell body attached to its -c flag", `bash -c'echo x > /opt/bwprobe/${STATE}'`],
  ])("WITNESS: %s is refused", (_l, cmd) => {
    expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
  });

  // Review of #2863, round 2: a space inside a path, a relative name on
  // stdin, and a body attached to its flag.
  test.each([
    ["a stdin path with a space in it", `python3 - <<'PY'\nopen('/Users/alice/Library/Application Support/rungate/${STATE}','w').write('{}')\nPY`],
    ["a relative name on stdin", `python3 - <<'PY'\nopen('${STATE}','w').write('{}')\nPY`],
    ["a long directory, then a space before the name", `python3 -c "open('/home/runner/work/some-very-long-checkout-directory-name/another-directory-segment-here-x/and-more-nested/My Notes/${STATE}','w')"`],
    ["a body attached to its -c flag", `python3 -c'import os;open("/x/${SALT}","w").close()'`],
  ])("WITNESS: %s is refused", (_l, cmd) => {
    expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
  });

  // Review of #2863, round 1: three spellings the window missed. A directory
  // longer than the first version's walk cap; a herestring, whose program was
  // read only with its quotes stripped; and a character whose lower case is
  // longer than itself, which shifted the path word off its leading slash.
  test.each([
    ["a 330-character directory, -c", `python3 -c "open('/tmp/${"a".repeat(329)}/${STATE}','w')"`],
    ["a 330-character directory, a copy", `python3 -c "import shutil; shutil.copyfile('/tmp/s', '/home/u/${"a".repeat(330)}/${SALT}')"`],
    ["a herestring", `python3 <<< "open('/home/u/.run-store/${STATE}','w')"`],
    ["a herestring that closes what it opened", `python3 <<< "f=open('/home/u/.rungate/run/${STATE}','w'); f.close()"`],
    ["a stdin body with a dotted capital I before the write", `python3 <<'PY'\nprint('\u0130')\nopen('/tmp/x/${SALT}','w').write('x')\nPY`],
    // Security review of the round-1 push: the Kelvin sign folds to `k` for
    // `names`, so the path search must fold it too or the name is dropped.
    ["a hook name spelled with the Kelvin sign, -c", `python3 -c "open('/opt/bwprobe/X.hoo\u212A.ts','w')"`],
    ["a hook name spelled with the Kelvin sign, stdin", `python3 <<'PY'\nopen('/opt/bwprobe/X.hoo\u212A.ts','w')\nPY`],
  ])("WITNESS: %s is refused", (_l, cmd) => {
    expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
  });

  // ADR-027 decision 3: a body that hides its write verb from the window is
  // allowed. Pinned so the trade is visible; if one turns red, something
  // started reading program bodies again — read the ADR first.
  test("CONCESSION: a verb the window cannot see allows the body", () => {
    const longSource = `/private/var/folders/m7/${"x".repeat(32)}/T/rg2858-${"y".repeat(24)}/src.json`;
    for (const cmd of [
      // a long SOURCE between the copy verb and the destination
      `python3 -c "import shutil; shutil.copy('${longSource}', '${LIVE}/${STATE}')"`,
      // an open-for-write nested three calls deep
      `python3 -c "import os; open(os.path.join(os.path.dirname(os.path.abspath(f)), '${STATE}'), 'w').close()"`,
      // a separator inside a long directory, more than the window after the
      // verb (review of #2863, round 3: spanning the whole literal closed it
      // and newly refused 3 real commands editing specs and plans)
      `python3 -c "open('/Users/alice/Library/Application Support/Claude Desktop Extension Manager Storage Folder/Dev (Beta)/run-store/${STATE}','w')"`,
      // a path bound to a name, written through it more than the window later
      // (the assignment readers that followed it were deleted with the rest)
      `python3 -c "p = '${LIVE}/${STATE}'${"\nx = 1".repeat(20)}\nopen(p, 'w').write('{}')"`,
    ]) expect(decideBashWrite(cmd).blocked, cmd).toBe(false);
  });

  test("the body reading is gone from the module, and lib/interpreter-calls.ts with it", () => {
    const src = readFileSync(join(import.meta.dir, "..", "lib", "bash-write-guard.ts"), "utf8");
    for (const name of ["bodyTargets", "callWrites", "codeMask", "isWriteCallee", "bodyTargetsAreScratch", "assignmentTargets", "tupleTargets"]) {
      expect(src, name).not.toMatch(new RegExp(`function ${name}\\b`));
    }
    expect(src).not.toContain("./interpreter-calls");
    expect(existsSync(join(import.meta.dir, "..", "lib", "interpreter-calls.ts"))).toBe(false);
  });
});

/**
 * #2705, #2731, #2772: bypasses of the interpreter scratch exemption that
 * #2858 deletes. Each body below was allowed on main, because the exemption
 * read its scratch literal as the write's target. With the exemption gone, the
 * write verb beside the protected name decides, and each is refused.
 */
describe("#2705 / #2731 / #2772 WITNESS: the exemption's bypasses are refused once it is gone", () => {
  const witnesses: Array<[string, string]> = [
    ["#2705: a body defining its own copy", `import os, shutil\ndef copy(a, b): shutil.copy(b, os.environ['RG'])\ncopy('/tmp/rg2858/x', '/tmp/rg2858/${STATE}')`],
    ["#2731: a comment's apostrophe hiding a definition", `import os, shutil\n# don't\ndef copy(a, b): shutil.copy(b, os.getenv('RG'))  # it's\ncopy('/tmp/rg2858/x', '/tmp/rg2858/${STATE}')`],
    ["#2731: string-keyed rebinding", `import os, shutil\nglobals()['copy'] = lambda a, b: shutil.copy(b, os.environ['RG'])\ncopy('/tmp/rg2858/x', '/tmp/rg2858/${STATE}')`],
    ["#2772: f_builtins rebound in place", `import io, os, sys\nsys._getframe().f_builtins['open'] = lambda p, m='r': io.open(os.environ['T'], m)\nopen('/tmp/rg2858/${STATE}', 'w').write('{}')`],
    ["#2772: f_builtins bound to a name first", `import io, os, sys\nb = sys._getframe().f_builtins\nb['open'] = lambda p, m='r': io.open(os.environ['T'], m)\nopen('/tmp/rg2858/${STATE}', 'w').write('{}')`],
  ];
  test.each(witnesses)("%s is refused", (_l, body) => {
    const cmd = `mkdir -p /tmp/rg2858 && python3 -I -c "${body}"`;
    expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
  });
});

/**
 * #2859, ADR-027 decisions 1 and 4: the guard is an accident guard, cut to
 * size, and a shell write's scratch exemption is decided by the target's
 * real directory, not by tracking what earlier steps of the command mention.
 */
describe("#2859: an accident guard, sized and judged by the real directory", () => {
  test("SC-2810: lib/bash-write-guard.ts is between 100 and 2000 lines", () => {
    const lines = readFileSync(join(import.meta.dir, "..", "lib", "bash-write-guard.ts"), "utf8").split("\n").length;
    expect(lines).toBeGreaterThanOrEqual(100);
    expect(lines).toBeLessThanOrEqual(2000);
  });

  // ADR-027 decision 4's failure matrix, written before the cut.
  test("a link at the leaf is refused, whatever it points at", () => {
    inScratch(root => {
      symlinkSync(join(root, "elsewhere.json"), join(root, STATE));
      expect(decideBashWrite(`echo '{}' > ${root}/${STATE}`).blocked).toBe(true);
    });
  });

  test("a dangling link at the leaf is refused", () => {
    inScratch(root => {
      symlinkSync(`${LIVE}/run/${STATE}`, join(root, STATE));
      expect(existsSync(join(root, STATE))).toBe(false); // dangling: lstat sees it, stat does not
      expect(decideBashWrite(`echo '{}' > ${root}/${STATE}`).blocked).toBe(true);
    });
  });

  test("a hard link at the leaf is refused", () => {
    inScratch(root => {
      writeFileSync(join(root, "other.json"), "{}");
      linkSync(join(root, "other.json"), join(root, STATE));
      expect(decideBashWrite(`echo '{}' > ${root}/${STATE}`).blocked).toBe(true);
    });
  });

  test("a directory made in the same command is refused: it has no real directory yet", () => {
    inScratch(root => {
      const made = decideBashWrite(`mkdir -p ${root}/new/d && echo '{}' > ${root}/new/d/${STATE}`);
      expect(made.blocked).toBe(true);
      // the refusal says how a fixture gets through
      expect(made.reason).toContain("make its directory in a command of its own first");
      expect(decideBashWrite(`echo '{}' > ${LIVE}/${STATE}`).reason).not.toContain("For a fixture");
      expect(decideBashWrite(`mkdir ${root}/new && echo '{}' > ${root}/new/${STATE}`).blocked).toBe(true);
      // made first, in a command of its own, it is a fixture
      mkdirSync(join(root, "new", "d"), { recursive: true });
      expect(decideBashWrite(`echo '{}' > ${root}/new/d/${STATE}`).blocked).toBe(false);
    });
  });

  // Witnessed into a directory that EXISTS, so the missing-directory rule
  // cannot hold these rows up for the wrong reason.
  test("a command that makes a link anywhere has no exemption, nested bodies included", () => {
    inScratch(root => {
      mkdirSync(join(root, "real"));
      expect(decideBashWrite(`echo '{}' > ${root}/real/${STATE}`).blocked).toBe(false);
      // the link need not come first, or touch the directory by name
      expect(decideBashWrite(`echo '{}' > ${root}/real/${STATE} && ln -s a b`).blocked).toBe(true);
      // the local review of #2859: cp's link flag inside a shell body counts
      for (const mk of [
        `bash -c 'cp -sR ${LIVE}/run/. ${root}/real/'`,
        `eval "cp -sR ${LIVE}/run/. ${root}/real/"`,
        `echo $(cp -s ${LIVE}/run/x ${root}/real/)`,
      ]) {
        const cmd = `${mk} && echo '{}' > ${root}/real/${STATE}`;
        expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
      }
      // `-ln` is a flag of ls and grep, not a link
      expect(decideBashWrite(`ls -ln ${root} && echo '{}' > ${root}/real/${STATE}`).blocked).toBe(false);
    });
  });

  test("an existing directory that is a link is refused", () => {
    inScratch(root => {
      mkdirSync(join(root, "real"));
      symlinkSync(join(root, "real"), join(root, "via"));
      expect(decideBashWrite(`echo '{}' > ${root}/via/${STATE}`).blocked).toBe(true);
      expect(decideBashWrite(`echo '{}' > ${root}/real/${STATE}`).blocked).toBe(false);
    });
  });

  test("ln and cp's link flags are refused by name when an argument names a protected artifact, scratch or not", () => {
    for (const cmd of [
      `ln -s ${LIVE}/run/${STATE} ${FIX}/x.json`,
      `ln ${FIX}/a ${FIX}/${STATE}`,
      `cp -s ${LIVE}/run/${STATE} ${FIX}/x.json`,
      `cp -l ${LIVE}/run/${STATE} ${FIX}/x.json`,
      `cp --link ${FIX}/a ${FIX}/${STATE}`,
      `cp --symbolic-link ${LIVE}/hooks/X.hook.ts ${FIX}/x.ts`,
      // the local review of #2859: a quoted span inside the name is the same name
      `ln -sf /tmp/evil.ts hooks/Foo.ho"ok".ts`,
    ]) expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
    // a plain copy between scratch paths is a fixture
    expect(decideBashWrite(`cp ${FIX}/a ${FIX}/${STATE}`).blocked).toBe(false);
    // the word `ln` as an argument makes no link: a read stays a read
    expect(decideBashWrite(`grep -nw ln hooks/Foo.hook.ts`).blocked).toBe(false);
  });

  // The automated security review of the first #2859 commit and the local
  // review of the third: each found a verb that lands a link where a `mkdir`
  // had been trusted to make a directory. A missing directory is never
  // exempt, so the whole class is refused, not each spelling.
  test("a missing directory is refused, whatever makes it or lands there", () => {
    inScratch(base => {
      for (const cmd of [
        `cp -a ${base}/planted ${base}/esc && echo '{}' > ${base}/esc/${STATE}`,
        `mv ${base}/planted ${base}/esc && echo '{}' > ${base}/esc/${STATE}`,
        `rsync -a ${base}/planted ${base}/esc && echo '{}' > ${base}/esc/${STATE}`,
        `tar -xf ${base}.tar -C ${base} && echo '{}' > ${base}/esc/${STATE}`,
        `python3 -c "import pathlib; pathlib.Path('${base}/esc').symlink_to('/usr')" && echo '{}' > ${base}/esc/${STATE}`,
        `cp -a ${base}/planted ${base}/esc && mkdir -p ${base}/esc && echo '{}' > ${base}/esc/${STATE}`,
        `mv ${base}/oldlink ${base}/esc && mkdir -p ${base}/esc/b && echo '{}' > ${base}/esc/b/${STATE}`,
        `cd ${base} && mv oldlink esc && mkdir -p ${base}/esc && echo '{}' > ${base}/esc/${STATE}`,
        `mv ${base}/oldlink /private${base}/esc && mkdir -p ${base}/esc && echo '{}' > ${base}/esc/${STATE}`,
        `D=${base}/esc; mv ${base}/oldlink $D && mkdir -p ${base}/esc && echo '{}' > ${base}/esc/${STATE}`,
        `tar -xf ${base}.tar -C ${base} && mkdir -p ${base}/esc && echo '{}' > ${base}/esc/${STATE}`,
        `mkdir -p ${base}/esc && rmdir ${base}/esc && mv ${base}/oldlink ${base}/esc && echo '{}' > ${base}/esc/${STATE}`,
      ]) expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
      // a copy INTO a directory that exists is ordinary fixture work
      mkdirSync(join(base, "d"));
      expect(decideBashWrite(`cp ${base}/x/${STATE} ${base}/d/`).blocked).toBe(false);
    });
  });

  // #2866 review round 1: a link verb in a subshell, a substitution, behind
  // a wrapper that takes words, or behind `eval` is a link verb. Main refused
  // all but `eval` by reading `ln` anywhere; this reads it where a command
  // starts, so an argument `ln` stays a read.
  test("a link verb wherever a command starts is refused by name, and an argument ln keeps a fixture exempt", () => {
    for (const cmd of [
      `(timeout 5 ln -s ${LIVE}/run/${STATE} ${FIX}/x)`,
      `(nice ln -s ${LIVE}/run/${SALT} ${FIX}/x)`,
      `echo $(ln -s ${LIVE}/run/${STATE} ${FIX}/x)`,
      `echo \`ln -s ${LIVE}/run/${STATE} ${FIX}/x\``,
      `eval "ln -s ${LIVE}/run/${STATE} ${FIX}/x"`,
      `timeout -s KILL 30 ln -s ${LIVE}/run/${SALT} ${FIX}/x`,
      `env A=1 ln -s ${LIVE}/run/${STATE} ${FIX}/x`,
      `find . -exec ln -s ${LIVE}/run/${STATE} ${FIX}/x \;`,
      `echo $(cp -s ${LIVE}/run/${STATE} ${FIX}/x)`,
    ]) expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
    for (const cmd of [
      `grep -nw ln hooks/a.ts; echo '{}' > ${FIX}/${STATE}`,
      `echo '{}' > ${FIX}/${SALT}; grep -nw ln hooks/Foo.hook.ts`,
      `git log --oneline -3 && echo '{}' > ${FIX}/${STATE}`,
    ]) expect(decideBashWrite(cmd).blocked, cmd).toBe(false);
  });

  // #2866 review round 2: the command word looked through `sudo` and `env`
  // but not `timeout` or `nice`, so a copy behind one wrote unread. Main
  // allowed these too; the wrapper list is one line.
  test("a write verb behind timeout, nice, stdbuf or caffeinate is the write verb", () => {
    for (const cmd of [
      `timeout 30 cp /tmp/fixture.json ${LIVE}/run/${STATE}`,
      `nice cp /tmp/f ${LIVE}/run/${STATE}`,
      `stdbuf -o0 mv /tmp/f ${LIVE}/run/${STATE}`,
      `caffeinate -i cp /tmp/f ${LIVE}/run/${STATE}`,
      `nice -n 10 chmod 777 ${LIVE}/hooks/X.hook.ts`,
    ]) expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
    for (const cmd of [`timeout 30 cp /tmp/a ${FIX}/${STATE}`, `timeout 30 grep -n x ${LIVE}/run/${STATE}`]) {
      expect(decideBashWrite(cmd).blocked, cmd).toBe(false);
    }
  });

  // #2866 review round 3: a reserved word starts a command too. Main refused
  // `do ln …` by reading `ln` anywhere, so missing it was this PR's
  // regression; `then cp` was missed on main as well.
  test("a link or copy after do, then, else or ! is read as the command", () => {
    for (const cmd of [
      `for f in a; do ln -s /tmp/scratch/a ${LIVE}/run/${STATE}; done`,
      `for i in 1; do ln -s ${LIVE}/run/${STATE} ${FIX}/ws; done`,
      `if [ -f a ]; then cp /tmp/x ${LIVE}/run/${STATE}; fi`,
      `for f in x; do cp /tmp/a.json ${LIVE}/run/${STATE}; done`,
      `if false; then :; else ln -s ${LIVE}/run/${SALT} ${FIX}/s; fi`,
      `! ln -s ${LIVE}/run/${STATE} ${FIX}/x`,
    ]) expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
    for (const cmd of [
      `if grep -q ln ${LIVE}/hooks/X.hook.ts; then echo y; fi`,
      `for f in a; do cp /tmp/a ${FIX}/${STATE}; done`,
    ]) expect(decideBashWrite(cmd).blocked, cmd).toBe(false);
  });

  // #2866 review round 3: the walk read the lexically resolved path, so a
  // link before a `..` was never looked at. A fixture never needs `..`.
  test("a path with a .. component has no scratch exemption", () => {
    inScratch(base => {
      const away = mkdtempSync(join(tmpdir(), "bw-away-"));
      try {
        mkdirSync(join(away, "inner"));
        symlinkSync(join(away, "inner"), join(base, "l"));
        expect(decideBashWrite(`echo '{}' > ${base}/l/../${STATE}`).blocked).toBe(true);
        expect(decideBashWrite(`echo '{}' > ${base}/${STATE}`).blocked).toBe(false);
      } finally {
        rmSync(away, { recursive: true, force: true });
      }
    });
  });

  // #2867: a copy's real destination and verb, in three spellings main and
  // #2866 both missed: `-t DIR`, a wrapper flag that takes a word, and a
  // wrapper on no list. The copy verb is found where it stands, as `tee` is.
  test("cp -t, a wrapper flag that takes a word, and an unlisted wrapper still name the destination (#2867)", () => {
    for (const cmd of [
      `cp -t ${LIVE}/witnesses/ /tmp/forged.json`,
      `cp --target-directory=${LIVE}/witnesses/ /tmp/x.json`,
      `mv --target-directory ${LIVE}/witnesses /tmp/x.json`,
      `cp -rt ${LIVE}/hooks /tmp/X.hook.ts`,
      `timeout -s KILL 30 cp /tmp/a.json ${LIVE}/run/${STATE}`,
      `sudo -u x cp /tmp/a ${LIVE}/run/${STATE}`,
      `doas -u x mv /tmp/a ${LIVE}/run/${STATE}`,
      `ionice -c3 cp /tmp/fixture.json ${LIVE}/run/${STATE}`,
      `setsid cp /tmp/a ${LIVE}/run/${STATE}`,
      `busybox cp /tmp/a ${LIVE}/run/${STATE}`,
      `ionice -c3 ln -s ${LIVE}/run/${STATE} ${FIX}/x`,
      `setsid ln -s ${LIVE}/run/${SALT} ${FIX}/x`,
    ]) expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
    for (const cmd of [
      `cp -t ${FIX} /tmp/x/${STATE}`,
      `ionice -c3 cp /tmp/a ${FIX}/${STATE}`,
      `rsync -t /tmp/a ${FIX}/${STATE}`,
      `grep -n cp ${LIVE}/run/${STATE}`,
    ]) expect(decideBashWrite(cmd).blocked, cmd).toBe(false);
  });

  // #2867 local review: the copy verb is read where a command stands, not
  // anywhere, so a read that mentions `cp` stays a read; `\cp` and `(cp` are
  // `cp`; and `--target-directory` is read in every prefix GNU accepts.
  test("the copy verb is where the command stands: escaped and subshell copies are copies, a grep naming cp is a read (#2867)", () => {
    for (const cmd of [
      `\\cp /tmp/a ${LIVE}/run/${STATE}`,
      `(cp /tmp/a ${LIVE}/run/${STATE})`,
      `\\mv -t ${LIVE}/run /tmp/${STATE}`,
      `cp --target=${LIVE}/run /tmp/${STATE}`,
      `cp --target-dir ${LIVE}/run /tmp/${STATE}`,
      // a lazy cluster: `-texport/…` is `-t export/…`, a relative directory, not `-texpor` + `t/…`
      `cp -texport${FIX} /tmp/x/${STATE}`,
    ]) expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
    for (const cmd of [
      `grep -c cp ${LIVE}/run/${STATE} ${LIVE}/run2/${STATE}`,
      `rg -n cp ${LIVE}/hooks/a.hook.ts ${LIVE}/hooks/b.hook.ts`,
      `grep -rn install /opt/a ${LIVE}/run/${STATE}`,
      `echo mv old ${LIVE}/run/${STATE}`,
    ]) expect(decideBashWrite(cmd).blocked, cmd).toBe(false);
  });

  // #2870 review round 1: `-t DIR` with its sources on stdin still writes
  // into DIR; a copy inside `$(…)` or backticks is a copy; a `t` inside a
  // value flag's attached argument (`-Sext`) is not `-t`; `eval cp` is cp.
  test("xargs cp -t DIR, a copy inside a substitution, cp -Sext and eval cp all name the destination (#2870)", () => {
    for (const cmd of [
      `xargs cp -t ${LIVE}/witnesses/`,
      `ls /tmp/fixture* | xargs cp -t ${LIVE}/witnesses/`,
      `echo $(cp /tmp/x.json ${LIVE}/run/${STATE})`,
      `x=$(cp /tmp/a ${LIVE}/run/${SALT})`,
      `echo \`cp /tmp/a ${LIVE}/run/${STATE}\``,
      `cp -Sext /tmp/seed ${LIVE}/run/${STATE}`,
      `install -gstaff /tmp/x ${LIVE}/run/${SALT}`,
      `eval cp /tmp/forged.json ${LIVE}/run/${STATE}`,
    ]) expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
    for (const cmd of [`xargs cp -t ${FIX}`, `echo $(cat ${LIVE}/run/${STATE})`, `x=$(grep -c cp ${LIVE}/run/${STATE})`]) {
      expect(decideBashWrite(cmd).blocked, cmd).toBe(false);
    }
  });

  // #2870 review round 2: a double-quoted substitution runs (only single
  // quotes stop it), and its body keeps its own quotes; `-Zt` is `-t`; an
  // attached wrapper flag with a slash is a flag; a trailing `--suffix .bak`
  // is a value, not the destination.
  test("a double-quoted substitution, cp -Zt, env -C/dir cp and a trailing --suffix still name the destination (#2870)", () => {
    for (const cmd of [
      `echo "$(cp /tmp/x ${LIVE}/run/${SALT})"`,
      `echo $(cp /tmp/forged.json "${LIVE}/run/${STATE}")`,
      `echo "\`cp /tmp/a ${LIVE}/run/${STATE}\`"`,
      `echo "$(echo x > ${LIVE}/run/${STATE})"`,
      `cp -Zt ${LIVE}/witnesses/ /tmp/forged.json`,
      `env -C/tmp/scratch cp /tmp/forged.json ${LIVE}/witnesses/x`,
      `sudo -D/tmp chmod 777 ${LIVE}/run/${SALT}`,
      `cp /tmp/a ${LIVE}/run/${STATE} --suffix .bak`,
      `cp /tmp/a ${LIVE}/run/${STATE} -S .bak`,
    ]) expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
    // single quotes run nothing
    expect(decideBashWrite(`echo '$(cp /tmp/x ${LIVE}/run/${SALT})'`).blocked).toBe(false);
  });

  test("cp's link flag is read as the shell hands it over, and ln behind a wrapper is ln", () => {
    for (const cmd of [
      `cp '-s' ${LIVE}/run/${STATE} ${FIX}/x.json`,
      `cp "--symbolic-link" ${LIVE}/run/${STATE} ${FIX}/x.json`,
      `cp --sym ${LIVE}/run/${STATE} ${FIX}/x.json`,
      `cp -st ${FIX} ${LIVE}/run/${STATE}`,
      `nice ln -s ${LIVE}/run/${STATE} ${FIX}/x.json`,
      `nice -n 10 ln -s ${LIVE}/run/${STATE} ${FIX}/x.json`,
    ]) expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
    // a flag cp has that is not a link flag stays a copy
    expect(decideBashWrite(`cp -p ${FIX}/a ${FIX}/${STATE}`).blocked).toBe(false);
  });

  test("the chain machinery is gone: no step-order or mention tracking decides the exemption", () => {
    const src = readFileSync(join(import.meta.dir, "..", "lib", "bash-write-guard.ts"), "utf8");
    for (const name of ["chainHolds", "chainContext", "collectShell", "collectBody", "mentionNames", "stepOrder", "outerFor", "judgeFor"]) {
      expect(src, name).not.toMatch(new RegExp(`function ${name}\\b`));
    }
  });

  test("the hook says it is an accident guard and not a boundary", () => {
    const hook = readFileSync(join(import.meta.dir, "..", "hooks", "BashWriteGuard.hook.ts"), "utf8");
    expect(hook).toContain("accident guard");
    expect(hook).toContain("not a boundary");
  });
});
