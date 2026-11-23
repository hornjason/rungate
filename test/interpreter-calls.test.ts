/**
 * #2702: a JavaScript body's calls read by a parser, not by a lexical mask.
 * `lib/bash-write-guard.ts` asks this reader first and falls back to its mask
 * readings only for a body that does not parse as JavaScript (Python, shell).
 */
import { describe, expect, test } from "bun:test";
import { readJsCalls } from "../lib/interpreter-calls";

const at = (body: string, needle: string): number => {
  const i = body.indexOf(needle);
  if (i < 0) throw new Error(`needle not in body: ${needle}`);
  return i;
};

describe("#2702: readJsCalls", () => {
  test("a body that is not JavaScript reads as null", () => {
    for (const body of [
      "import shutil\nshutil.copy('a', 'b')",
      "with open('x', 'w') as f:\n    f.write('y')",
      "x = '''a'''\nprint(x)",
      "note = \"it's",
    ]) expect(readJsCalls(body), body).toBeNull();
  });

  test("the calls holding an offset, innermost first, with the method chain after", () => {
    const body = "require('fs').createWriteStream(path.join(d, 'state.json')).write('{}')";
    const calls = readJsCalls(body)!.enclosingCalls(at(body, "state.json"));
    expect(calls).toEqual([
      "path.join(d, 'state.json')",
      "require('fs').createWriteStream(path.join(d, 'state.json')).write('{}')",
    ]);
  });

  test("a name in a callee is not an argument of that call", () => {
    const body = "obj['state.json'](1)";
    expect(readJsCalls(body)!.enclosingCalls(at(body, "state.json"))).toEqual([]);
  });

  test("comments, regex literals, template literals and private names are the parser's to read, not a mask's", () => {
    for (const body of [
      "// don't\nif (x) /[/*]/.test(s); require('fs').copyFileSync('/a/x', '/b/state.json') /* end */",
      "const r = () => { return /'/.test(s) }; require('fs').copyFileSync('/a/x', '/b/state.json')",
      "const r = o .in / 2; require('fs').copyFileSync('/a/x', '/b/state.json')",
      "const t = `it's ${\"q\"}`; require('fs').copyFileSync('/a/x', '/b/state.json')",
      "class A { #x = 1; m() { return this.#x } }; require('fs').copyFileSync('/a/x', '/b/state.json')",
    ]) {
      const calls = readJsCalls(body)!.enclosingCalls(at(body, "state.json"));
      expect(calls[0], body).toBe("require('fs').copyFileSync('/a/x', '/b/state.json')");
    }
  });

  test("a literal assigned to a name binds it; one that only mentions the name does not", () => {
    const yes = [
      ["const dst = '/b/state.json'", "dst"],
      ["let dst; dst = '/b/state.json'", "dst"],
      ["var dst = '/b/' + 'state.json'", "dst"],
      // Either operand of a `+` (#2702 security review): main's mask binds the
      // left one, so a parser that climbed only from the right was narrower.
      ["const dst = '/b/state.json' + suffix", "dst"],
      ["const dst = ROOT + '/b/state.json'", "dst"],
      // #2714: through a path-building call, a fallback, a branch, and a
      // template literal's text between its values.
      ["const dst = path.join(ROOT, '/b/state.json')", "dst"],
      ["const dst = join(ROOT, 'b', 'state.json')", "dst"],
      ["const dst = require('path').posix.resolve(R, '/b/state.json')", "dst"],
      ["const dst = base || '/b/state.json'", "dst"],
      ["const dst = base ?? '/b/state.json'", "dst"],
      ["const dst = ok ? '/b/state.json' : other", "dst"],
      ["const dst = ok ? other : '/b/state.json'", "dst"],
      ["const dst = `${R}/b/state.json`", "dst"],
      ["const dst = path.join(R, `${w}/b/state.json`)", "dst"],
      // #2718 review: an optional chain wraps the call in a ChainExpression.
      ["const dst = path?.join(R, '/b/state.json')", "dst"],
      ["const dst = path.join?.(R, '/b/state.json')", "dst"],
      // #2718 review round 2: `ok && '…'` is the literal whenever ok is truthy.
      ["const dst = ok && '/b/state.json'", "dst"],
      ["function f(dst = '/b/state.json') {}", "dst"],
      ["const dst = `/b/state.json`", "dst"],
    ];
    for (const [body, name] of yes) {
      const i = at(body, "state.json");
      expect(readJsCalls(body)!.boundIdentifier(i, i + "state.json".length), body).toBe(name);
    }
    for (const body of [
      "const note = 'see /b/state.json for details'",
      "const t = `/b/${x}/state.json!`",
      "console.log('/b/state.json')",
      // A call that does not build a path transforms its argument; the
      // test of a branch is never its value; a member of the literal is not it.
      "const n = count('/b/state.json')",
      "const v = '/b/state.json' ? a : b",
      // #2718 review round 3: a truthy literal on the left of && is never the value.
      "const dst = '/b/state.json' && '/tmp/out.json'",
      "const n = '/b/state.json'.length",
      "const t = `${R}/b/state.json.bak`",
    ]) {
      const i = at(body, "state.json");
      expect(readJsCalls(body)!.boundIdentifier(i, i + "state.json".length), body).toBeNull();
    }
  });

  test("a 50,000-term + chain is read, not a stack overflow (#2702 review)", () => {
    // A recursive walk threw RangeError here, and the guard's hook refused
    // this read-only command as one it could not evaluate.
    const body = `const d = '/x/state.json'; console.log(d); const z = ${Array(50_000).fill("1").join(" + ")};`;
    const reading = readJsCalls(body);
    expect(reading).not.toBeNull();
    const i = at(body, "state.json");
    expect(reading!.boundIdentifier(i, i + "state.json".length)).toBe("d");
  });

  test("references find a name's uses, not its declaration or a property spelled the same", () => {
    const body = "const dst = '/b/x'; o.dst = 1; copy(src, dst); ({ dst: 2 })";
    const refs = readJsCalls(body)!.references("dst");
    expect(refs).toEqual([body.indexOf("dst)")]);
  });
});
