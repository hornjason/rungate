/**
 * #2878: one presence decider for both surfaces, run through every caller.
 *
 * Over #2876's local review and three review rounds, ten defects were each one
 * call site deciding for itself what "missing", "present" and "could not be
 * read" mean. The reader now has one decider (`decidePresence`, reached as a
 * surface's `presence`), and every caller takes its three answers through
 * `onPresence`. This table runs each kind of thing a path can be through
 * each caller and pins the caller's outcome, so a caller that drifts from
 * the decider, or a decider that folds "unread" into "absent", turns its
 * cells red together.
 *
 * Breaking it: map `unreadable` to absent in `decidePresence` and every row's
 * `dangling` and `underUnsearchable` cell changes (the battery in the PR).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, relative } from "path";

import { lineOwners, promptAudit } from "../lib/prompt-audit";
import {
  NotRenderedSurface,
  danglingReadTargets,
  lintRenderedTree,
  presenceRecorder,
  readRenderedSurface,
  readUserSurface,
} from "../lib/surface-lint";

const ROOT = join(import.meta.dir, "..");
const asRoot = process.getuid?.() === 0; // root reads and searches mode-000 paths anyway

/** Every kind of thing a path can be, as the decider sees it. */
const KINDS = ["absent", "file", "dir", "fifo", "mode000", "dangling", "underUnsearchable"] as const;
type Kind = (typeof KINDS)[number];
/** Needs a non-root user to mean what it says. */
const NEEDS_PERMISSIONS: ReadonlySet<Kind> = new Set(["mode000", "underUnsearchable"]);

const scratch = mkdtempSync(join(tmpdir(), "rungate-2878-"));
const locked: string[] = [];
afterAll(() => {
  for (const p of locked) chmodSync(p, 0o755);
  rmSync(scratch, { recursive: true, force: true });
});

/** A rendered tree just big enough for `readRenderedSurface`, with one rule that names `docs/s.md`. */
function renderedTree(): string {
  const root = mkdtempSync(join(scratch, "tree-"));
  mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
  mkdirSync(join(root, ".claude", "agents"));
  mkdirSync(join(root, ".claude", "rules"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, ".claude", "rungate", "config.json"), "{}");
  writeFileSync(join(root, "AGENTS.md"), "# Agents\n");
  writeFileSync(join(root, ".claude", "agents", "a.md"), "An agent.\n");
  writeFileSync(join(root, ".claude", "rules", "r.md"), "Read `docs/s.md` first.\n");
  return root;
}

/**
 * Make `abs` one `kind`, in the shape its caller expects (`natural`). A
 * mode-000 path keeps that shape and loses its permissions; a path under an
 * unsearchable directory is placed whole, then its parent is locked.
 */
function plant(abs: string, kind: Kind, natural: "file" | "dir"): void {
  rmSync(abs, { recursive: true, force: true });
  mkdirSync(dirname(abs), { recursive: true });
  const shaped = () => {
    if (natural === "dir") {
      mkdirSync(abs);
      writeFileSync(join(abs, "in.md"), "Inside.\n");
    } else writeFileSync(abs, "A file.\n");
  };
  switch (kind) {
    case "absent":
      return;
    case "file":
      writeFileSync(abs, "A file.\n");
      return;
    case "dir":
      mkdirSync(abs);
      writeFileSync(join(abs, "in.md"), "Inside.\n");
      return;
    case "fifo": {
      const made = spawnSync("mkfifo", [abs]);
      if (made.status !== 0) throw new Error(`mkfifo failed: ${made.stderr}`);
      return;
    }
    case "mode000":
      shaped();
      chmodSync(abs, 0o000);
      locked.push(abs);
      return;
    case "dangling":
      symlinkSync(join(dirname(abs), "nowhere"), abs);
      return;
    case "underUnsearchable":
      shaped();
      chmodSync(dirname(abs), 0o000);
      locked.push(dirname(abs));
      return;
  }
}

/** The reason an `unreadable` entry gives for `rel`, or null when it names nothing there. */
function namedWhy(unreadable: readonly string[], rel: string): string | null {
  const entry = unreadable.find(u => u.startsWith(`${rel} (`));
  return entry ? entry.slice(rel.length + 2, -1) : null;
}

const named = (base: string, why: string | null) => (why === null ? base : `${base}, named ${why}`);

interface Caller {
  /** The function that asks, and what it asks about. */
  name: string;
  /** Run the caller over one kind; its outcome, in words. */
  run(kind: Kind): string;
  /** The outcome per kind. `n/a` where the kind cannot be placed for this caller. */
  expected: Record<Kind, string>;
}

const CALLERS: Caller[] = [
  {
    name: "readRenderedSurface: the AGENTS.md marker",
    run(kind) {
      const root = renderedTree();
      plant(join(root, "AGENTS.md"), kind, "file");
      try {
        readRenderedSurface(root);
        return "rendered";
      } catch (e) {
        if (e instanceof NotRenderedSurface && /missing[^\n]*AGENTS\.md/.test(e.message)) return "missing";
        throw e;
      }
    },
    expected: { absent: "missing", file: "rendered", dir: "missing", fifo: "missing", mode000: "rendered", dangling: "rendered", underUnsearchable: "n/a" },
  },
  {
    name: "readRenderedSurface: the .claude/rules marker",
    run(kind) {
      const root = renderedTree();
      plant(join(root, ".claude", "rules"), kind, "dir");
      try {
        readRenderedSurface(root);
        return "rendered";
      } catch (e) {
        if (e instanceof NotRenderedSurface && /missing[^\n]*\.claude\/rules\/\*\.md/.test(e.message)) return "missing";
        throw e;
      }
    },
    expected: { absent: "missing", file: "missing", dir: "rendered", fifo: "missing", mode000: "rendered", dangling: "rendered", underUnsearchable: "rendered" },
  },
  {
    name: "readUserSurface: the rules entry",
    run(kind) {
      const home = mkdtempSync(join(scratch, "home-"));
      plant(join(home, ".claude", "rules"), kind, "dir");
      const s = readUserSurface(home);
      if (s.files.has("rules/in.md")) return "walked";
      const why = namedWhy(s.unreadable, "rules");
      return why === null ? "silent" : `named ${why}`;
    },
    expected: {
      absent: "silent", file: "named not a directory", dir: "walked", fifo: "named not a directory",
      mode000: "named EACCES", dangling: "named ENOENT", underUnsearchable: "named EACCES",
    },
  },
  {
    name: "surfaceReader's walk: an entry under .claude/rules",
    run(kind) {
      const root = renderedTree();
      const at = join(root, ".claude", "rules", "deep", "s.md");
      plant(at, kind, "file");
      const s = readRenderedSurface(root);
      if (s.files.has(".claude/rules/deep/s.md")) return "read";
      if (s.files.has(".claude/rules/deep/s.md/in.md")) return "walked";
      const own = namedWhy(s.unreadable, ".claude/rules/deep/s.md");
      if (own !== null) return `named ${own}`;
      const parent = namedWhy(s.unreadable, ".claude/rules/deep");
      return parent === null ? "skipped" : `parent named ${parent}`;
    },
    expected: {
      absent: "skipped", file: "read", dir: "walked", fifo: "named not a regular file",
      mode000: "named EACCES", dangling: "named ENOENT", underUnsearchable: "parent named EACCES",
    },
  },
  {
    name: "inRenderedTree: the file a lint reports on",
    run(kind) {
      const root = renderedTree();
      plant(join(root, "docs", "s.md"), kind, "file");
      const surface = readRenderedSurface(root);
      const reportsIt = { name: "reports-docs-s", check: () => [{ file: "docs/s.md", message: "x" }] };
      try {
        lintRenderedTree(surface, [reportsIt]);
      } catch (e) {
        if (/not in the rendered tree/.test((e as Error).message)) return "outside";
        throw e;
      }
      return named("inside", namedWhy(surface.unreadable, "docs/s.md") ?? namedWhy(surface.unreadable, "docs"));
    },
    expected: {
      absent: "outside", file: "inside", dir: "inside", fifo: "inside",
      mode000: "inside", dangling: "inside, named ENOENT", underUnsearchable: "inside, named EACCES",
    },
  },
  {
    name: "resolveTarget: a file a rule says to read",
    run(kind) {
      const root = renderedTree();
      plant(join(root, "docs", "s.md"), kind, "file");
      const surface = readRenderedSurface(root);
      const pkg = mkdtempSync(join(scratch, "pkg-"));
      const findings = lintRenderedTree(surface, [danglingReadTargets(pkg)]);
      if (findings.some(f => f.message.includes("docs/s.md"))) return "dangling";
      return named("found", namedWhy(surface.unreadable, "docs/s.md"));
    },
    expected: {
      absent: "dangling", file: "found", dir: "found", fifo: "found",
      mode000: "found", dangling: "found, named ENOENT", underUnsearchable: "found, named EACCES",
    },
  },
  {
    name: "danglingPathFindings: a backticked path in a rule",
    run(kind) {
      const root = renderedTree();
      plant(join(root, "docs", "s.md"), kind, "file");
      const home = mkdtempSync(join(scratch, "home-"));
      const audit = promptAudit(root, mkdtempSync(join(scratch, "pkg-")), { home });
      const finding = audit.findings.some(f => f.lint === "dangling-path" && f.message.includes("docs/s.md"));
      const unread = audit.unmeasured.join("\n");
      const why = /docs\/s\.md \(([^)]+)\)/.exec(unread)?.[1] ?? null;
      return named(finding ? "finding" : "none", why);
    },
    expected: {
      absent: "finding", file: "none", dir: "none", fifo: "none",
      mode000: "none", dangling: "none, named ENOENT", underUnsearchable: "none, named EACCES",
    },
  },
  {
    name: "lineOwners: an agent's brief template",
    run(kind) {
      const pkg = mkdtempSync(join(scratch, "pkg-"));
      const template = join(pkg, "templates", "agent-briefs", "b.md");
      plant(template, kind, "file");
      const recorder = presenceRecorder();
      const owners = lineOwners(".claude/agents/b.md", "A brief.\n", recorder.presence, pkg);
      return named(owners.includes("harness") ? "harness" : "consumer", namedWhy(recorder.unreadable, template) ?? namedWhy(recorder.unreadable, dirname(template)));
    },
    expected: {
      absent: "consumer", file: "harness", dir: "consumer, named EISDIR", fifo: "consumer, named not a regular file",
      mode000: "harness", dangling: "consumer, named ENOENT", underUnsearchable: "consumer, named EACCES",
    },
  },
];

describe("#2878: every caller takes the decider's three answers, for every kind of path", () => {
  for (const caller of CALLERS) {
    for (const kind of KINDS) {
      const want = caller.expected[kind];
      if (want === "n/a") continue;
      test.skipIf(asRoot && NEEDS_PERMISSIONS.has(kind))(`${caller.name} × ${kind} → ${want}`, () => {
        expect(caller.run(kind)).toBe(want);
      });
    }
  }
});

describe("#2878: presence is decided in one place in both files", () => {
  const files = ["lib/surface-lint.ts", "lib/prompt-audit.ts"];
  /** Top-level function blocks: `function name(` or `export function name(` up to the next one. */
  const blocks = (src: string) => {
    const out: Array<{ name: string; body: string }> = [];
    const re = /^(?:export )?function (\w+)/gm;
    const starts = [...src.matchAll(re)];
    starts.forEach((m, i) => out.push({ name: m[1], body: src.slice(m.index!, starts[i + 1]?.index ?? src.length) }));
    return out;
  };

  /** Every direct presence decision in `src`, by function: the one binding both cases below read. */
  const refusals = (f: string, src: string): string[] => {
    const refused: string[] = [];
    for (const b of blocks(src)) {
      for (const call of ["statSync(", "lstatSync(", "existsSync("]) if (b.body.includes(call)) refused.push(`${f} ${b.name}: ${call}`);
      if (b.name !== "decidePresence" && /\bprobePath\(/.test(b.body)) refused.push(`${f} ${b.name}: probePath(`);
      if (b.name !== "onPresence" && /\.is\s*[!=]==/.test(b.body)) refused.push(`${f} ${b.name}: reads .is by hand`);
    }
    return refused;
  };

  test("no direct stat, lstat, existsSync, or probePath call outside decidePresence, and no hand-read of an answer", () => {
    const refused = files.flatMap(f => refusals(f, readFileSync(join(ROOT, f), "utf-8")));
    expect(refused, "decide presence through the reader's presence and onPresence").toEqual([]);
  });

  test("every function that asks presence is a row in the table, or is named here as unlisted", () => {
    // The table's rows, by the function that holds the call. surfaceReader
    // holds readText and walk; readText is reached through every read.
    const LISTED = new Set([
      "surfaceReader", "readRenderedSurface", "readUserSurface", "inRenderedTree",
      "resolveTarget", "danglingPathFindings", "lineOwners",
    ]);
    const askers: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), "utf-8");
      for (const b of blocks(src)) if (/\bpresence\(/.test(b.body)) askers.push(b.name);
    }
    expect(askers.filter(n => !LISTED.has(n)), "a new caller of presence: add its row to CALLERS").toEqual([]);
    expect([...LISTED].filter(n => !askers.includes(n)), "a listed caller no longer asks; drop it").toEqual([]);
  });

  test("a planted direct call, or a hand-read answer, is refused by name", () => {
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), "utf-8");
      const planted = src +
        "\nfunction plantedCheck(p: string) { return statSync(p).isFile() || probePath(p).kind === \"file\"; }\n" +
        "function plantedRead(s: { presence: (a: string, e: string) => { is: string } }, p: string) { return s.presence(p, \"file\").is === \"present\"; }\n";
      expect(refusals(f, planted)).toEqual([
        `${f} plantedCheck: statSync(`,
        `${f} plantedCheck: probePath(`,
        `${f} plantedRead: reads .is by hand`,
      ]);
    }
  });
});
