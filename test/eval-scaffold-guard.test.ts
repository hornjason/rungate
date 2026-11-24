/**
 * The eval case scaffolds write fixture files only where nobody's work can be
 * hit (#2751, review of #2753).
 *
 * A case's `scaffold.sh` runs as the operator under `claude plugin eval
 * --scaffold`. The harness hands it an empty directory inside a repository it
 * has just made, with no commits and no refs (measured 2026-11-24, claude
 * 2.1.331). Everywhere else the scaffold must refuse and write nothing. The
 * review rounds of #2753 found a new input each round while the table of
 * starting states was checked by hand; this file runs the table, so the next
 * input is a red row rather than another round.
 *
 * Every scaffold listed here runs every row, so two copies of the guard
 * cannot drift apart. Moving the guard into the shared
 * `evals/scaffold-workspace.sh` is #2605's work.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const REAL_GIT = Bun.which("git") ?? "git";
const SCAFFOLDS = ["evals/aditi-visual-review/scaffold.sh", "evals/discovery-finds-spec/scaffold.sh"];

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) {
    // A row may leave a directory unreadable; give it back before removing.
    if (existsSync(join(d, "d"))) chmodSync(join(d, "d"), 0o755);
    rmSync(d, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
}

/** Run a scaffold in `cwd`, with `env` laid over the inherited environment. */
function scaffold(path: string, cwd: string, env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["bash", join(ROOT, path)], { cwd, env: { ...process.env, ...env } as Record<string, string>, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, err: new TextDecoder().decode(r.stderr) };
}

/** A fresh scratch root, and the directory inside it that the scaffold runs in. */
interface Row {
  name: string;
  setup: (root: string) => string;
  writes: boolean;
  env?: Record<string, string>;
  /** Extra checks on the scratch root after the run. */
  after?: (root: string, cwd: string) => void;
}

const ROWS: Row[] = [
  {
    name: "the harness's shape: an empty directory inside a repository with no commits and no refs",
    setup: (root) => { git(root, "init", "-q"); mkdirSync(join(root, "cwd")); return join(root, "cwd"); },
    writes: true,
    after: (root) => {
      const cfg = Bun.spawnSync(["git", "config", "--local", "--get", "user.email"], { cwd: root, stdout: "pipe" });
      expect(cfg.exitCode, "the scaffold wrote a git identity into the repository").not.toBe(0);
    },
  },
  {
    name: "an empty directory outside any repository",
    setup: (root) => { mkdirSync(join(root, "cwd")); return join(root, "cwd"); },
    writes: true,
    after: (_root, cwd) => expect(existsSync(join(cwd, ".git"))).toBe(true),
  },
  {
    // This machine's git may carry no translations, so a translated git is
    // planted: outside the C locale it answers rev-parse in German. A guard
    // that matched git's English text without forcing the locale would read
    // that as "git could not read this directory" and refuse.
    name: "an empty directory outside any repository, with git's messages translated",
    setup: (root) => {
      mkdirSync(join(root, "cwd"));
      mkdirSync(join(root, "bin"));
      writeFileSync(
        join(root, "bin", "git"),
        `#!/bin/sh
if [ "$1" = "rev-parse" ] && [ "\${LC_ALL:-}" != "C" ]; then
  out=$("$REAL_GIT" "$@" 2>&1); rc=$?
  case "$out" in *"not a git repository"*) echo "fatal: kein Git-Repository (oder irgendeines der Elternverzeichnisse)" >&2; exit $rc ;; esac
  printf '%s\\n' "$out"; exit $rc
fi
exec "$REAL_GIT" "$@"
`,
      );
      chmodSync(join(root, "bin", "git"), 0o755);
      return join(root, "cwd");
    },
    writes: true,
    env: { LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8", LANGUAGE: "de" },
  },
  {
    name: "an empty subdirectory of a checkout with a commit",
    setup: (root) => {
      git(root, "init", "-q");
      git(root, "commit", "-q", "--allow-empty", "-m", "history");
      mkdirSync(join(root, "tmp"));
      return join(root, "tmp");
    },
    writes: false,
  },
  {
    name: "an empty subdirectory of a checkout on an orphan branch, with history on another branch",
    setup: (root) => {
      git(root, "init", "-q");
      git(root, "commit", "-q", "--allow-empty", "-m", "history");
      git(root, "checkout", "-q", "--orphan", "fresh");
      mkdirSync(join(root, "tmp"));
      return join(root, "tmp");
    },
    writes: false,
  },
  {
    name: "a directory that already holds a file",
    setup: (root) => { mkdirSync(join(root, "cwd")); writeFileSync(join(root, "cwd", "mine.txt"), "mine"); return join(root, "cwd"); },
    writes: false,
    after: (_root, cwd) => expect(readFileSync(join(cwd, "mine.txt"), "utf-8")).toBe("mine"),
  },
  {
    name: "a just-initialised repository's own directory, holding only .git",
    setup: (root) => { mkdirSync(join(root, "cwd")); git(join(root, "cwd"), "init", "-q"); return join(root, "cwd"); },
    writes: false,
  },
  {
    name: "a directory that cannot be listed, holding a file",
    setup: (root) => {
      mkdirSync(join(root, "d", "components"), { recursive: true });
      writeFileSync(join(root, "d", "components", "SaveBar.tsx"), "mine");
      chmodSync(join(root, "d"), 0o311);
      return join(root, "d");
    },
    writes: false,
    after: (root) => {
      chmodSync(join(root, "d"), 0o755);
      expect(readFileSync(join(root, "d", "components", "SaveBar.tsx"), "utf-8")).toBe("mine");
    },
  },
];

for (const path of SCAFFOLDS) {
  describe(`#2751: ${path} writes only where the harness runs it`, () => {
    test.each(ROWS.map((r) => [r.name, r] as const))("%s", (_name, row) => {
      const root = mkdtempSync(join(tmpdir(), "rg-eval-scaffold-"));
      scratch.push(root);
      const cwd = row.setup(root);
      const planted = existsSync(join(root, "bin", "git"));
      const r = scaffold(path, cwd, planted ? { ...row.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, REAL_GIT: REAL_GIT } : row.env);
      if (row.writes) {
        expect(r.code, r.err).toBe(0);
        expect(readdirSync(cwd).filter((e) => e !== ".git").length, "the fixture was not written").toBeGreaterThan(0);
      } else {
        expect(r.code, "the scaffold did not refuse").toBe(1);
        expect(r.err).toContain("scaffold.sh: refusing");
        expect(existsSync(join(cwd, ".claude")), "a refused run wrote the fixture anyway").toBe(false);
      }
      row.after?.(root, cwd);
    });
  });
}

// #2754 review: the issue in the discovery prompt names one invoice line and
// the two totals it shows. The planted code must produce exactly those totals,
// or an agent that runs it against the issue finds no defect to size.
describe("#2752: the discovery fixture shows the symptom its issue reports", () => {
  test("the issue's line gives the issue's screen and PDF totals, and they differ", async () => {
    const prompt = readFileSync(join(ROOT, "evals/discovery-finds-spec/prompt.md"), "utf-8");
    const m = prompt.match(/a line of (\d+) x \$([\d.]+) shows a total of \$([\d.]+) on screen but \$([\d.]+) in the PDF/);
    expect(m, "the prompt's issue no longer names a line and two totals").not.toBeNull();
    const [, quantity, unitPrice, screen, pdf] = m!;
    expect(screen).not.toBe(pdf);
    const root = mkdtempSync(join(tmpdir(), "rg-eval-scaffold-"));
    scratch.push(root);
    mkdirSync(join(root, "cwd"));
    expect(scaffold("evals/discovery-finds-spec/scaffold.sh", join(root, "cwd")).code).toBe(0);
    const invoice = await import(join(root, "cwd", "lib", "invoice.ts"));
    const lines = [{ quantity: Number(quantity), unitPrice: Number(unitPrice) }];
    expect(invoice.screenTotal(lines)).toBe(screen);
    expect(invoice.pdfTotal(lines)).toBe(pdf);
  });
});
