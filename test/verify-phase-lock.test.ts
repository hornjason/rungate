/**
 * Covers SC-825, SC-826, SC-827 (HOOK-ARCHITECTURE-SPEC.md).
 *
 * #365 — `hooks/VerifyPhaseLock.hook.ts` decided whether to allow an issue
 * with:
 *
 *     if (cmd.includes('--label') && cmd.includes('follow-up'))
 *
 * which is a test that the string `follow-up` appears anywhere in the
 * command. The issue named the case that passes today and must not:
 *
 *   > `--label bug --title "Fix the follow-up handler"` → **must refuse**.
 *   > This passes today.
 *   >
 *   > Per the mutation standard: reverting the matcher to
 *   > `cmd.includes('follow-up')` must turn the first case red. If it stays
 *   > green the test is asserting on something other than the matcher.
 *
 * So the table below is driven against `verifyPhaseRefusal`, the one
 * exported decision, and the last describe SPAWNS the hook over stdin — a
 * decision that is correct in `lib/` and not reached by the hook is the
 * defect this repo keeps finding.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  OVERRIDE_LABELS,
  clauses,
  createsIssue,
  filingDirectory,
  labelValues,
  tokenize,
  verifyPhaseRefusal,
} from "../lib/issue-create-override";

const ROOT = join(import.meta.dir, "..");
const HOOK = join(ROOT, "hooks", "VerifyPhaseLock.hook.ts");
const scratch: string[] = [];

afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

/** [command, allowed, why]. `allowed === false` means the lock must refuse. */
const TABLE: Array<[string, boolean, string]> = [
  // The four the issue asked for, in its order.
  [`gh issue create --label bug --title "Fix the follow-up handler"`, false,
    "the override word is in the TITLE — this is the bypass #365 is about"],
  ["gh issue create --label follow-up --title 'x'", true, "the documented override"],
  ["gh issue create --label external-audit --title 'x'", true, "the origin #362/#363/#364 actually had"],
  ["gh issue create --label bug --title 'x'", false, "a label, but not an override"],

  // Argument forms gh accepts. Each would have been missed by a matcher that
  // only knows the spaced long form.
  ["gh issue create --label=follow-up", true, "the = form"],
  ["gh issue create -l follow-up", true, "the short form"],
  ["gh issue create -l=external-audit", true, "the short = form"],
  ["gh issue create --label bug,follow-up", true, "gh takes a comma list in one flag"],
  ["gh issue create --label 'follow up'", false, "a space is not a hyphen"],

  // Shapes the old substring form got wrong in the other direction.
  ["gh issue create --label --title follow-up", false,
    "`--label` with no value, and the word appears as a positional"],
  ["gh issue comment 7 --body 'see follow-up'", true, "not a create at all"],
  ["gh issue list --label follow-up", true, "not a create at all"],
  ["gh issue comment 7 --body x && gh issue create --label bug", false,
    "the comment clause must not excuse the create clause"],
  ["gh issue create --label follow-up && gh issue create --label bug", false,
    "every create in the command needs its own override"],
  ["gh issue create --label follow-up && gh issue create --label external-audit", true,
    "both creates carry one"],
  ["echo 'gh issue create --label bug'", true,
    "a quoted command inside another is an argument, not a create"],

  // Found by the commit security review of the FIRST version of this file,
  // which split on whitespace alone. Every one of these was allowed. They
  // are the same defect as the substring matcher, one layer in: a parser
  // that disagrees with the shell about where a command begins.
  ["foo;gh issue create --label bug", false,
    "a separator with no space before `gh` — the token was `foo;gh`"],
  ["gh issue comment 1&&gh issue create --label bug", false,
    "`&&` glued to its neighbours — the token was `1&&gh`"],
  ["gh issue create --label follow-up\ngh issue create --label bug", false,
    "a newline is a separator; without it one override covered both creates"],
  ["(gh issue create --label bug)", false, "a subshell — the token was `(gh`"],
  ["bash -c \"gh issue create --label bug\"", false,
    "a shell's -c argument is a command, not data"],
  ["sh -c \"gh issue create --label follow-up\"", true,
    "...and the override still works through one"],
  ["bash -c \"bash -c \\\"gh issue create --label bug\\\"\"", false,
    "nesting does not shake the guard off"],
  ["GH_TOKEN=x gh issue create --label bug", false, "an env prefix is not the program"],
  ["GH_TOKEN=x bash -c 'gh issue create --label bug'", false,
    "an env prefix in front of the SHELL — the program name is the second token"],
  [`python3 -c "print('gh issue create --label bug')"`, true,
    "-c is code for an interpreter that is not a shell; descending into it is a false refusal"],

  // Found by the SECOND commit security review, of the fix for the first.
  // Every one was allowed.
  ["`gh issue create --label bug`", false, "backticks — the token was '`gh'"],
  ["$(gh issue create --label bug)", false, "command substitution"],
  ["/usr/bin/gh issue create --label bug", false, "a path-qualified binary is the same binary"],
  ["./gh issue create --label bug", false, "...and so is a relative one"],
  ["sh -lc 'gh issue create --label bug'", false,
    "short flags combine; only the last letter takes the argument"],
  ["bash -ic 'gh issue create --label bug'", false, "the same, interactively"],
  ["eval 'gh issue create --label bug'", false, "eval's argument is a command"],
  ["`gh issue create --label follow-up`", true, "and the override survives all of it"],
  ["/usr/bin/gh issue create --label external-audit", true, "...both of them"],

  // Found by the THIRD commit security review. Both were allowed, and both
  // are shapes someone types on purpose rather than to evade: a long command
  // wrapped across lines, and a note after one.
  ["gh issue \\\n  create --label bug", false,
    "a backslash-newline joins; it was landing a literal newline inside the token"],
  ["gh issue \\\n  create --label follow-up", true, "...and the override still works through one"],
  ["gh issue create --label bug # --label follow-up", false,
    "a commented-out override is not an override"],
  ["gh issue create --label follow-up # a note", true, "a real override with a note after it"],
  ["echo hi # gh issue create --label bug", true, "a create inside a comment creates nothing"],
  ["gh issue create --label bug --title '#5 regression'", false,
    "`#` inside a quoted argument is not a comment"],
  ["gh issue create --label follow-up --body 'a#b'", true,
    "`#` mid-word is not a comment either — the shell's rule is word-start"],

  // Found by the THIRD review's second pass: #365's own defect, reintroduced
  // by the parser that fixed it. A flag-shaped VALUE was read as a flag.
  [`gh issue create --label bug --title "--label=follow-up"`, false,
    "the override is the TITLE again — #365 with one more layer of quoting"],
  ["gh issue create --label bug --title '--label=external-audit'", false, "either override"],
  [`gh issue create --label bug --body "--label=follow-up"`, false, "any value-taking flag"],
  [`gh issue create --label bug --title "-l=follow-up"`, false, "the short form too"],
  ["gh issue create --label bug --title --label=follow-up", false,
    "unquoted is the same command — the shell strips the quotes either way"],
  // ...and the forms that must keep working, because a guard that refuses a
  // real override teaches people to work around it.
  [`gh issue create --label="follow-up"`, true, "a partially quoted value is still a flag"],
  [`gh issue create "--label=follow-up"`, true, "...and so is a fully quoted one"],
  ["gh issue create -lfollow-up", true, "pflag lets a short flag carry its value attached"],
  ["gh issue create --web --label follow-up", true,
    "a BOOLEAN flag eats nothing — assuming it did would refuse a real override"],
  // #1261: an ATTACHED short flag eats nothing either, for the same reason.
  // Both of these were REFUSED before `VALUE_SHORT_FLAGS` — `-aalice` and
  // `-tx` were unknown flags under the conservative default, so each ate the
  // `--label` that followed it and the override went unseen. That was the
  // allowed error direction and it was still a wrong answer about a command
  // somebody types. Nothing here lets a label be read where none was
  // written: the following token is parsed on its own merits, and it still
  // has to be a real `--label` argument.
  ["gh issue create -aalice --label follow-up", true,
    "an attached short carries its own value, so it does not swallow the override"],
  [`gh issue create -tx --label bug`, false,
    "...and the control: the token after it is read, and `bug` is not an override"],

  // Documented as out of scope, asserted so the boundary is a measurement
  // rather than a claim. See the module docblock.
  ["GH=gh; $GH issue create --label bug", true,
    "variable indirection — resolving it is the shell interpreter this is not"],
  // WAS out of scope, with the reason "a here-string is not a shape anyone
  // types to file an issue". #1302 reversed it, and the reversal is a
  // consequence rather than a judgement: stripping document heredoc bodies
  // means the interpreter bodies have to be put back, and the binding that
  // puts them back — `interpreterPrograms` in `lib/bash-write-guard.ts` —
  // returns herestrings in the same list. Narrowing it again would mean
  // writing a second decider to disagree with the first one.
  //
  // The old reason was about typing frequency, which is not a property of
  // the input. This row now asserts the refusal, in the direction that costs
  // a legitimate command nothing: a herestring filing still clears by
  // carrying a real `--label` override, exactly like the inline form.
  ["bash <<< 'gh issue create --label bug'", false,
    "a herestring to a shell is a program, the same reading BashWriteGuard takes"],
  ["bash <<< 'gh issue create --label follow-up'", true,
    "...and the control: the override is read inside the program, so nothing legitimate is lost"],
];

describe("#365 SC-825: the override is a label argument, not a word in the command", () => {
  for (const [cmd, allowed, why] of TABLE) {
    test(`${allowed ? "allows" : "refuses"}: ${cmd}`, () => {
      const refusal = verifyPhaseRefusal(cmd);
      if (allowed) expect(refusal, why).toBeNull();
      else expect(refusal, why).not.toBeNull();
    });
  }

  test("the table exercises both outcomes", () => {
    // A positive control on the table itself. Every case above is satisfied
    // by a matcher that always allows, or always refuses, unless both
    // outcomes are present — and `test.each`-style loops report zero
    // failures over an empty or one-sided table, not zero tests.
    const allows = TABLE.filter(([, a]) => a).length;
    expect(allows).toBeGreaterThan(2);
    expect(TABLE.length - allows).toBeGreaterThan(2);
  });
});

describe("#365 SC-826: the parts the decision is built from", () => {
  test("a quoted argument is one token, flags inside it are not flags", () => {
    expect(tokenize(`gh issue create --title "a --label follow-up b"`)).toEqual([
      "gh", "issue", "create", "--title", "a --label follow-up b",
    ]);
  });

  test("an unterminated quote does not split into things that look like flags", () => {
    // The direction this is allowed to be wrong in. A malformed command
    // yielding a stray `--label` token would be an override nobody wrote.
    expect(tokenize(`gh issue create --title "oops --label follow-up`)).toEqual([
      "gh", "issue", "create", "--title", "oops --label follow-up",
    ]);
  });

  test("clauses split on shell separators, spaced or not", () => {
    expect(clauses("a && b ; c | d").map(c => c[0])).toEqual(["a", "b", "c", "d"]);
    expect(clauses("a&&b;c|d").map(c => c[0]), "operators glued to words").toEqual([
      "a", "b", "c", "d",
    ]);
    expect(clauses("a\nb").map(c => c[0]), "a newline ends a command").toEqual(["a", "b"]);
  });

  test("an operator is a token even inside a word, but not inside quotes", () => {
    expect(tokenize("1&&gh")).toEqual(["1", "&&", "gh"]);
    expect(tokenize(`--title "a && b"`)).toEqual(["--title", "a && b"]);
  });

  test("a -c argument is parsed as a command; anything else is data", () => {
    // Refusing `echo` too would be the safer direction and the wrong one —
    // a guard that refuses commands creating nothing is a guard people
    // learn to work around. `-c` is the whole condition: an allowlist of
    // shell names was removed because no input could distinguish it.
    expect(clauses(`bash -c "gh issue create"`).some(createsIssue)).toBe(true);
    expect(clauses(`echo "gh issue create"`).some(createsIssue)).toBe(false);
  });

  test("a backslash-newline joins rather than landing a newline in the token", () => {
    // It was producing `\ncreate`, so `createsIssue` never saw three
    // adjacent words. Mid-token too: the shell joins there as well.
    expect(tokenize("gh issue \\\n  create")).toEqual(["gh", "issue", "create"]);
    expect(tokenize("gh is\\\nsue create")).toEqual(["gh", "issue", "create"]);
  });

  test("`#` starts a comment only at the start of a word", () => {
    expect(tokenize("gh issue create # --label follow-up")).toEqual(["gh", "issue", "create"]);
    expect(tokenize("--title a#b"), "mid-word is not a comment").toEqual(["--title", "a#b"]);
    expect(tokenize(`--title "#5"`), "nor is one inside quotes").toEqual(["--title", "#5"]);
    expect(tokenize("a # b\nc"), "a comment ends at the newline, which still separates").toEqual([
      "a", "\n", "c",
    ]);
  });

  test("the out-of-scope boundary is written down where the next reviewer reads it", () => {
    // Two rounds of security review walked this parser inward and a third
    // would too. The answer to "what about `curl`?" is a documented scope,
    // not another branch — a guard that refuses commands creating nothing
    // teaches people to work around it. If this assertion is failing,
    // someone deleted the paragraph, not the boundary.
    const src = readFileSync(join(ROOT, "lib", "issue-create-override.ts"), "utf-8");
    expect(src, "the scope boundary is undocumented").toContain("It is not a sandbox");
    for (const outOfScope of ["curl", "ssh host", "MCP", "Variable indirection"]) {
      expect(src).toContain(outOfScope);
    }
  });

  test("the recursion is bounded", () => {
    // Four levels, then it stops looking. Not a correctness property —
    // a wrapper chain that deep is not an accident — but an unbounded
    // recursion over attacker-shaped input is its own problem.
    const deep = Array.from({ length: 12 }).reduce<string>(
      acc => `bash -c "${acc.replace(/"/g, '\\"')}"`,
      "gh issue create --label bug",
    );
    expect(() => clauses(deep)).not.toThrow();
  });

  test("createsIssue needs the three words adjacent", () => {
    expect(createsIssue(["gh", "issue", "create"])).toBe(true);
    expect(createsIssue(["gh", "issue", "list"])).toBe(false);
    expect(createsIssue(["gh", "create", "issue"])).toBe(false);
    expect(createsIssue(["create"])).toBe(false);
  });

  test("labelValues reads every form and nothing else", () => {
    expect(labelValues(tokenize("x --label a -l b --label=c -l=d --title --label"))).toEqual([
      "a", "b", "c", "d",
    ]);
    expect(labelValues(tokenize("x -le")), "a short flag's attached value").toEqual(["e"]);
  });

  test("a flag's value is data, even when it is shaped like a flag", () => {
    // The whole of #365, reintroduced by the parser that fixed it: scanning
    // for `--label=` anywhere let a TITLE carry the override again.
    expect(
      labelValues(tokenize(`gh issue create --label bug --title "--label=follow-up"`)),
      "the title was read as a label",
    ).toEqual(["bug"]);
    // ...and the direction this is allowed to be wrong in. An unknown flag
    // is assumed to take a value, so a `--label` hidden behind one is missed
    // — which refuses, rather than allows.
    expect(labelValues(tokenize("x --unknown --label follow-up"))).toEqual([]);
    // A boolean flag eats nothing, or every override after one would vanish.
    expect(labelValues(tokenize("x --web --label follow-up"))).toEqual(["follow-up"]);
  });

  test("both overrides are documented where the refusal reads them", () => {
    // The refusal text is generated from the same map the decision uses, so
    // a third override cannot be accepted while the message still names two.
    const refusal = verifyPhaseRefusal("gh issue create --label bug")!;
    for (const name of Object.keys(OVERRIDE_LABELS)) expect(refusal).toContain(`--label ${name}`);
    expect(Object.keys(OVERRIDE_LABELS)).toContain("external-audit");
  });
});

describe("#2722: a command substitution inside double quotes is a command", () => {
  // The shell keeps a double-quoted string as one word and still runs what it
  // substitutes. Each WITNESS yielded no inner clause on main.
  const has = (cmd: string, words: string[]) =>
    clauses(cmd).some(c => words.every((w, i) => c[i] === w));

  test.each([
    ["$(…) in a --body", `gh issue comment 2714 --body "$(gh issue edit 2655 --body x)"`, ["gh", "issue", "edit", "2655"]],
    ["backticks", 'echo "`gh issue create --label follow-up`"', ["gh", "issue", "create"]],
    ["the second of two in one string", `echo "a $(echo b) $(gh issue create)"`, ["gh", "issue", "create"]],
    ["after an apostrophe in the same string", `echo "it's $(gh issue create)"`, ["gh", "issue", "create"]],
    ["after a quoted ) inside it", `echo "$(echo ')'; gh issue create)"`, ["gh", "issue", "create"]],
  ])("WITNESS: %s", (_l, cmd, words) => {
    expect(has(cmd as string, words as string[]), cmd as string).toBe(true);
  });

  test.each([
    ["single quotes", "echo '$(gh issue create)'"],
    ["double quotes inside single quotes", `echo '"$(gh issue create)"'`],
    ["an escaped $", 'echo "\\$(gh issue create)"'],
    ["text inside the substitution's own single quotes", `echo "$(echo 'gh issue create')"`],
  ])("CONTROL: %s stay text", (_l, cmd) => {
    expect(clauses(cmd).some(createsIssue), cmd).toBe(false);
  });

  // Read on main as well, where the tokenizer's misreading of the nested
  // quotes happened to expose the inner command; kept.
  test("KEPT: a nested quoted substitution is read", () => {
    expect(has(`echo "$(echo "$(gh issue create)")"`, ["gh", "issue", "create"])).toBe(true);
  });

  test("the lock refuses a filing inside a quoted substitution, as it refuses one outside", () => {
    expect(verifyPhaseRefusal('echo "$(gh issue create --label bug)"')).not.toBeNull();
    expect(verifyPhaseRefusal("echo $(gh issue create --label bug)")).not.toBeNull();
  });
});

describe("#2723 review round 1: one scanner, and the directory reader reads what it reads", () => {
  test("an apostrophe in a # comment does not hide a later quoted substitution", () => {
    const cmd = `echo ok # it's done\necho "$(gh issue create --title t)"`;
    expect(clauses(cmd).some(createsIssue), cmd).toBe(true);
    expect(verifyPhaseRefusal(cmd)).not.toBeNull();
  });

  test("CONTROL: a quoted substitution inside a # comment is not a command", () => {
    expect(clauses(`echo hi # "$(gh issue create)"`).some(createsIssue)).toBe(false);
  });

  test("an apostrophe in a comment inside the substitution does not end it early", () => {
    const cmd = `echo "$(echo hi # it's\ngh issue create)"`;
    expect(clauses(cmd).some(createsIssue), cmd).toBe(true);
  });

  test("an apostrophe in a comment inside the substitution does not swallow what follows it", () => {
    const cmd = `echo "$(echo hi # it's\n)"; gh issue create --title t`;
    expect(clauses(cmd).some(createsIssue), cmd).toBe(true);
  });

  test("filingDirectory reads a filing inside a quoted substitution where it runs", () => {
    expect(filingDirectory(`(cd /wt/a && gh issue comment 1 --body "$(gh issue create --title t)")`, "/home/u/main")).toBe("/wt/a");
    expect(filingDirectory(`echo "$(cd /wt/a && gh issue create --title t)"`, "/main")).toBe("/wt/a");
  });

  test("CONTROL: a cd inside a quoted substitution does not move what follows", () => {
    expect(filingDirectory(`echo "$(cd /wt/a)"; gh issue create --title t`, "/main")).toBe("/main");
  });
});

describe("#2723 review round 2", () => {
  test("a case pattern's ) inside a quoted substitution does not end it", () => {
    for (const cmd of [
      `echo "$(case x in x) gh issue create --title t;; esac)"`,
      `echo "$(case x in (x) gh issue create --title t;; esac)"`,
    ]) {
      expect(verifyPhaseRefusal(cmd), cmd).not.toBeNull();
    }
  });

  test("a word that only ends in case opens no case statement", () => {
    // Read as one, its `)` would not close the substitution, and the filing
    // after it would be swallowed into the quoted word.
    expect(clauses(`echo "$(echo showcase x)"; gh issue create --title t`).some(createsIssue)).toBe(true);
  });

  test("the comment rule, in both scans, on its edge inputs", () => {
    for (const cmd of [
      `echo a;# it's\necho "$(gh issue create)"`,
      `echo ok # it's\r\necho "$(gh issue create)"`,
      `echo "$(echo a;# it's\n)"; gh issue create`,
    ]) {
      expect(clauses(cmd).some(createsIssue), cmd).toBe(true);
    }
    for (const cmd of [`echo a#b "x"`, `echo "# it's" '$(gh issue create)'`]) {
      expect(clauses(cmd).some(createsIssue), cmd).toBe(false);
    }
  });
});

describe("#2723 review round 3", () => {
  test("case as an argument opens no case statement, so the substitution closes at its )", () => {
    // Round 2 counted every word `case`; the `)` was then read as a pattern's,
    // and the filing after the closing quote was swallowed into the word.
    for (const cmd of [
      `echo "$(printf case x)" ; gh issue create --title t`,
      `echo "$(echo case )" ; gh issue create --label bug`,
      `gh issue comment 2714 --body "$(grep case )" && gh issue create --label bug`,
      `gh issue comment 2714 --body "$(git log --grep=x case )" && gh issue create --label bug`,
    ]) {
      expect(clauses(cmd).some(createsIssue), cmd).toBe(true);
    }
  });

  test("esac as an argument closes no case statement", () => {
    // Read as one, the next pattern's `)` would end the substitution early,
    // and the filing in that branch would sit in the outer word as text.
    const cmd = `echo "$(case x in x) echo esac;; y) gh issue create --title t;; esac)"`;
    expect(verifyPhaseRefusal(cmd), cmd).not.toBeNull();
  });

  test("case at a command's start still opens one: after ;, &&, a newline, then, and a pattern's )", () => {
    for (const cmd of [
      `echo "$(true; case x in x) gh issue create --title t;; esac)"`,
      `echo "$(true && case x in x) gh issue create --title t;; esac)"`,
      `echo "$(true\ncase x in x) gh issue create --title t;; esac)"`,
      `echo "$(if true; then case x in x) gh issue create --title t;; esac; fi)"`,
      `echo "$(case a in a) case b in b) gh issue create --title t;; esac;; esac)"`,
      // The nested case counted: else the outer `c)` ends the substitution.
      `echo "$(case a in a) case b in b) true;; esac;; c) gh issue create --title t;; esac)"`,
    ]) {
      expect(verifyPhaseRefusal(cmd), cmd).not.toBeNull();
    }
  });

  test("esac closes a case wherever the shell reads it as a keyword", () => {
    // A second case follows each, with a filing in its branch: an esac missed
    // leaves the first case open, the case-aware scan never closes, and only
    // the case-blind reading is left, which stops at the second pattern's `)`.
    for (const first of [
      `case x in esac`,
      // An empty branch: the pattern's `)` then `esac`.
      `case x in x) esac`,
      `case x in (x) esac`,
      // After a compound command's closer, with no `;;`.
      `case x in x) if true; then true; fi esac`,
      `case x in x) { true; } esac`,
      `case a in a) case b in b) true;; esac esac`,
    ]) {
      const cmd = `echo "$(${first}; case y in y) gh issue create --title t;; esac)"`;
      expect(verifyPhaseRefusal(cmd), cmd).not.toBeNull();
    }
  });

  test("the outer word goes on from the first ), whatever the case reading says", () => {
    // `echo fi case` counts a case (the word before is `fi`), so the
    // case-aware scan skips the real `)`, reads the outer quotes inverted, and
    // closes inside the last string. The outer reading does not follow it.
    const cmd = `echo "$(echo fi case )" ; gh issue create --title t ; echo " ; esac )"`;
    expect(clauses(cmd).some(createsIssue), cmd).toBe(true);
  });

  test("a case branch that prints a quote does not hide what follows", () => {
    // Read case-blind, the substitution ends at the pattern's `)`, the `"`
    // printed in the branch closes the outer quote, and the `'` opens one
    // that runs to the end. Bash closes at the last `)`, and the command is
    // read that way too.
    for (const cmd of [
      `echo "$(case x in x) echo '"';; esac)"; gh issue create --title t`,
      `echo "$(case x in x) echo '"';; esac)" && gh issue create --title t`,
    ]) {
      expect(clauses(cmd).some(createsIssue), cmd).toBe(true);
    }
    // The filing gate's reader takes the same second reading, in the
    // directory the command is in.
    expect(filingDirectory(`cd /wt/a && echo "$(case x in x) echo '"';; esac)"; gh issue create --title t`, "/main")).toBe("/wt/a");
  });

  test("a command is read at most twice, however many case substitutions it holds", () => {
    // One second reading per command, not one per substitution. Read once per
    // substitution, each re-read recursed again: 16 of these gave 283,778
    // clauses and 2.7 seconds. The count is asserted, not the time.
    const k = 16;
    const sub = `"$(case x in x) echo a;; esac)"`;
    const cmd = `echo ${Array(k).fill(sub).join(" ")}; gh issue create --title t`;
    const read = clauses(cmd);
    expect(read.some(createsIssue)).toBe(true);
    expect(read.length).toBeLessThan(10 * k);
    expect(filingDirectory(`cd /wt/a && ${cmd}`, "/main")).toBe("/wt/a");
  }, 30_000);

  test("CONTROL: an argument case adds no reading, so a filing quoted later is text", () => {
    // Counted, each would add a case-aware reading that ends inside the last
    // string and reads the filing quoted there as a command.
    for (const cmd of [
      `echo "$(echo case )" ; echo " ; gh issue create --title t ; esac )"`,
      // After a word part's `)` or `}`, the word goes on: `case` is an argument.
      `echo "$(echo $(date) case )" ; echo " ; gh issue create --title t ; esac )"`,
      `echo "$(echo <(date) case )" ; echo " ; gh issue create --title t ; esac )"`,
      `echo "$(echo \${x} case )" ; echo " ; gh issue create --title t ; esac )"`,
    ]) {
      expect(clauses(cmd).some(createsIssue), cmd).toBe(false);
    }
  });

  test("CONTROL: a case scan that never closes adds no reading", () => {
    // A case no esac closes (a syntax error to the shell): the scan runs to
    // the end and falls back to the case-blind close, so the filing quoted in
    // the next command stays text.
    const cmd = `echo "$(echo x; case )"; echo "; gh issue create --title t"`;
    expect(clauses(cmd).some(createsIssue), cmd).toBe(false);
  });
});

describe("#365 SC-827: the hook reaches the decision", () => {
  /**
   * Spawn the real hook with a real VERIFY workflow state.
   *
   * A decision that is correct in `lib/` and never consulted is the
   * decorative check `.claude/rules/checks-must-be-able-to-fail.md` is
   * about, and the unreachable `gh issue comment` branch this change
   * deleted is what that looks like when it ships.
   */
  function runHook(cmd: string, phase: string): string {
    const work = mkdtempSync(join(tmpdir(), "rungate-vpl-"));
    scratch.push(work);
    mkdirSync(join(work, "run"), { recursive: true });
    writeFileSync(join(work, "run", "workflow-state.json"), JSON.stringify({ phase }));
    writeFileSync(join(work, "open-issues.json"), "[]");
    const r = spawnSync("bun", [HOOK], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd } }),
      encoding: "utf-8",
      timeout: 60_000,
      env: {
        ...process.env,
        RUNGATE_WORK_DIR: work,
        // #1261 added a SECOND gate at this chokepoint, and it reads the open
        // tracker. Pinned to an empty fixture so this file keeps measuring the
        // phase lock and never shells out to `gh` — a case whose reading
        // depends on the live tracker is a case that changes answer on its own.
        RUNGATE_OPEN_FINDINGS: join(work, "open-issues.json"),
        RUNGATE_FINDING_LEDGER: join(work, "finding-ledger.jsonl"),
      },
    });
    return r.stdout;
  }

  /**
   * Whether the hook REFUSED, as distinct from whether it printed.
   *
   * These cases asserted `stdout === ""` until #1261, and that equality was
   * reading two properties at once: no refusal, and no output of any kind.
   * The adjudication added beside the lock emits a non-blocking
   * `systemMessage` when a filing could not be adjudicated, so the equality
   * now fails for a reason that has nothing to do with the phase lock.
   *
   * Relaxing it to `not.toContain("block")` would be the cheapest wrong fix —
   * it is also satisfied by a hook that crashed, or printed something
   * unparseable. So this parses instead: empty output, or one JSON object
   * carrying no `decision`. That is strictly more specific about the thing
   * these cases test than the equality it replaces.
   */
  function refused(out: string): boolean {
    if (out.trim() === "") return false;
    const payload = JSON.parse(out) as { decision?: string };
    return payload.decision === "block";
  }

  test("the title bypass is blocked by the hook, not just by the library", () => {
    const out = runHook(`gh issue create --label bug --title "Fix the follow-up handler"`, "VERIFY");
    expect(out, "the hook allowed the command #365 is about").toContain('"decision":"block"');
  }, 120_000);

  test("an override label passes the hook", () => {
    expect(refused(runHook("gh issue create --label external-audit --title 'x'", "VERIFY"))).toBe(false);
  }, 120_000);

  test("outside VERIFY the hook does not block", () => {
    // The control. A hook that blocked everything would satisfy the first
    // case, and this is the phase gate it must still respect.
    const out = runHook(`gh issue create --label bug --title "Fix the follow-up handler"`, "EXECUTION");
    expect(refused(out), "the lock fired outside the phase it locks").toBe(false);
  }, 120_000);
});
