/**
 * #2802: the hook census reads the hook file behind a leading assignment
 * whose value is quoted, spaces included.
 *
 * `executedHookPath` split a command on whitespace before it read the leading
 * `VAR=value` assignments, so `TOKEN="a b" bun /x/A.hook.ts` became `TOKEN="a`,
 * `b"`, `bun`, …, the assignment walk stopped at `b"`, and the parse returned
 * null: a hook the shell runs, read as executing nothing. Every census reading
 * built on the parse (registration, tree divergence, currency) then read a
 * registered hook as unregistered.
 */
import { describe, expect, test } from "bun:test";

import { commandNamesHook, executedHookPath } from "../lib/hook-trees";

describe("#2802: a quoted leading assignment is read, spaces and all", () => {
  test("a double- or single-quoted value with spaces is an assignment, and the hook after it is read", () => {
    for (const command of [
      'TOKEN="a b" bun /x/A.hook.ts',
      "T='a b' bun /x/A.hook.ts",
      // Escaped quotes inside a double-quoted value, one followed by a space,
      // which a reading that ends the value at the first quote splits.
      'T="a \\"b\\" c" bun /x/A.hook.ts',
      'T="a \\" b" bun /x/A.hook.ts',
      // A quoted separator is part of the value, not the end of the command.
      'T="x; y && z" bun /x/A.hook.ts',
      'T="# not a comment" bun /x/A.hook.ts',
      // Several, mixed with unquoted ones, and after `env`.
      'A=1 B="x y" C=\'p q\' bun /x/A.hook.ts',
      'env T="a b" bun /x/A.hook.ts',
      'X=1 env T="a b" U=2 bun run /x/A.hook.ts',
      // A value made of a quoted part and an unquoted one is one word.
      'T="a b"c bun /x/A.hook.ts',
      // A backslash-escaped space outside quotes is part of the value.
      "T=a\\ b bun /x/A.hook.ts",
    ]) {
      expect(executedHookPath(command), command).toBe("/x/A.hook.ts");
      expect(commandNamesHook(command, "A"), command).toBe(true);
    }
  });

  test("an unterminated quote is no command, as the shell would not run it", () => {
    for (const command of [
      'T="a b bun /x/A.hook.ts',
      // No space inside the quote: a whitespace walk would read `T="a` as an
      // assignment and the hook after it.
      'T="a bun /x/A.hook.ts',
      "T='a bun /x/A.hook.ts",
      // An escaped quote then an unterminated one: the shell refuses it, so no
      // hook runs, though `\'x'` read without the escape is a closed quote
      // (security review of #2815).
      "A=\\'x' bun /x/A.hook.ts",
      'A=\\"x" bun /x/A.hook.ts',
      'A=\\"x y" bun /x/A.hook.ts',
      // An open quote on the command word itself (#2815 review).
      'bun "/x/A.hook.ts',
      'A=1 bun "/x/A.hook.ts',
      'bun /x/A.hook.ts"',
      // An open quote after the path: the word is read, but the line never runs.
      'bun /x/A.hook.ts "--x',
      // Balanced, but the quoted word is the path and a flag together.
      'bun "/x/A.hook.ts --flag"',
    ]) {
      expect(executedHookPath(command), command).toBeNull();
    }
  });

  test("the existing readings are unchanged: separators, env, flags, preload", () => {
    expect(executedHookPath("bun ${D}/A.hook.ts")).toBe("${D}/A.hook.ts");
    expect(executedHookPath("TOKEN=x env FOO=2 bun ${D}/A.hook.ts")).toBe("${D}/A.hook.ts");
    expect(executedHookPath("bun --conditions=node /x/A.hook.ts")).toBe("/x/A.hook.ts");
    // An unquoted separator still ends the first command, glued or not.
    expect(executedHookPath("A=x;bun /x/A.hook.ts")).toBeNull();
    expect(executedHookPath("A=x && bun /x/A.hook.ts")).toBeNull();
    expect(executedHookPath("bun run x.ts # /x/A.hook.ts")).toBeNull();
    // A bare flag is still refused, and a preloaded file is not the executed one.
    expect(executedHookPath("bun --inspect /x/A.hook.ts")).toBeNull();
    expect(executedHookPath("bun --preload /x/A.hook.ts run real.ts")).toBeNull();
    // The command inside a quoted string is still not read.
    expect(executedHookPath('sh -c "bun /x/A.hook.ts"')).toBeNull();
    // A path wrapped whole in quotes is read, and a quote in a comment or a later command is not an open one.
    expect(executedHookPath('bun "${D}/A.hook.ts"')).toBe("${D}/A.hook.ts");
    expect(executedHookPath("bun '/x/A.hook.ts'")).toBe("/x/A.hook.ts");
    expect(executedHookPath("bun /x/A.hook.ts # it's here")).toBe("/x/A.hook.ts");
    expect(executedHookPath("bun /x/A.hook.ts; echo \"done")).toBe("/x/A.hook.ts");
  });
});
