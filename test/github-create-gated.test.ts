/**
 * Covers SC-2613 (SPEC-TO-BOARD-PIPELINE-SPEC.md) — #1677.
 *
 * ## What this is for
 *
 * `lib/issue-create-override.ts` meters issue filing by PARSING A BASH
 * COMMAND: it tokenizes the command, walks its clauses, and recognises
 * `gh issue create`. That is the whole of the gate's reach, and it means the
 * gate can only see a filing an agent made by typing one.
 *
 * `createIssue` in `lib/github.ts` is the other path. It is Octokit, called
 * from `scripts/github-op.ts` and from `workflows/ship.js`, and no bash
 * command exists for anything to parse. A run that reaches for the tool
 * instead of the CLI files as many issues as it likes, and the ledger never
 * hears about it — so the cap measures one of the two ways this repository
 * creates issues and reports that number as the run's total.
 *
 * ## The property
 *
 * **`createIssue` must not reach the network unless something allowed it.**
 * Not "should ask" — must not POST. The assertion every case below makes is
 * on `created`, the count of calls that reached the fake client, because a
 * refusal that still files is the only failure that matters here.
 *
 * ## Why a required parameter and not a default
 *
 * The gate argument has no default, deliberately, and the reasoning is
 * `reserveAllowance`'s `cap: number` verbatim: a defaulted gate makes "a call
 * site that forgot to pass one" a silent behaviour change that only a
 * reviewer or a text-matching test can catch, one occurrence at a time. With
 * no default the compiler catches it at every site for free. AC-4 asserts
 * there is no `= ` default in the signature, so a later edit that adds one is
 * red here rather than discovered by a filing nobody metered.
 *
 * ## The mutant
 *
 * `REFUSED_UNGATED` is the single exported refusal string, and the battery
 * builds a copy of `lib/github.ts` with the guard clause removed. Every
 * refusing case runs twice — real module and mutant — asserting the real one
 * files nothing and the mutant files. Without that second half a case that
 * passes for an unrelated reason is indistinguishable from one genuinely
 * caught (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createIssue, REFUSED_UNGATED, type FilingDecision } from "../lib/github";

const SOURCE = join(import.meta.dir, "..", "lib", "github.ts");

/** A client that records what reached it and never touches a network. */
function fakeClient(): { client: any; created: { title: string }[] } {
  const created: { title: string }[] = [];
  return {
    created,
    client: {
      rest: {
        issues: {
          create: async (args: { title: string }) => {
            created.push({ title: args.title });
            return { data: { number: 1, html_url: "https://example.invalid/1" } };
          },
        },
      },
    } as any,
  };
}

const OPTS = { title: "a title", body: "a body" };

const allow = (release: () => void = () => {}): (() => FilingDecision) =>
  () => ({ allowed: true, release });

const refuse = (reason: string): (() => FilingDecision) =>
  () => ({ allowed: false, reason });

async function attempt(gate: () => FilingDecision): Promise<{ created: number; error: string | null }> {
  const { client, created } = fakeClient();
  let error: string | null = null;
  try {
    await createIssue(client, "o/r", OPTS, gate);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { created: created.length, error };
}

describe("AC-1 (#1677): an allowed filing still files", () => {
  test("the one case that must reach the client, so the rest are not vacuous", async () => {
    const { created, error } = await attempt(allow());
    expect(error).toBeNull();
    expect(created).toBe(1);
  });

  test("the reservation is NOT released when the create succeeds", async () => {
    let released = 0;
    const { created } = await attempt(allow(() => { released += 1; }));
    expect(created).toBe(1);
    // A release here would hand the allowance back for a filing that happened,
    // which is the cap undercounting rather than overcounting — the direction
    // `issue-filing-gate.ts` refuses everywhere else.
    expect(released).toBe(0);
  });
});

describe("AC-2 (#1677): a refused filing never reaches the client", () => {
  test("OVER_CAP-shaped refusal files nothing and says why", async () => {
    const { created, error } = await attempt(refuse("this run has already filed 3 issue(s)"));
    expect(created).toBe(0);
    expect(error).toContain(REFUSED_UNGATED);
    expect(error).toContain("already filed 3");
  });

  test("the refusal reason is carried verbatim, not summarised", async () => {
    const reason = "a reason nothing else in this file could have produced";
    const { error } = await attempt(refuse(reason));
    expect(error).toContain(reason);
  });
});

describe("AC-3 (#1677): a gate that THROWS refuses, it does not fall open", () => {
  test("an unreadable ledger files nothing", async () => {
    const { created, error } = await attempt(() => {
      throw new Error("ledger unreadable");
    });
    // The whole point. `lib/issue-filing-gate.ts` reserves by appending to a
    // file; an unwritable or unreadable ledger is a failure to update the
    // cap's STATE, which is indistinguishable from an attempt to switch the
    // cap off. It refuses there and it refuses here.
    expect(created).toBe(0);
    expect(error).toContain(REFUSED_UNGATED);
    expect(error).toContain("ledger unreadable");
  });

  test("a gate returning a malformed value refuses rather than guessing", async () => {
    const { created, error } = await attempt((() => undefined) as unknown as () => FilingDecision);
    expect(created).toBe(0);
    expect(error).toContain(REFUSED_UNGATED);
  });
});

describe("AC-4 (#1677): the gate parameter has no default", () => {
  const source = readFileSync(SOURCE, "utf8");

  test("the signature does not default the gate, so the compiler catches every call site", () => {
    const sig = source.slice(source.indexOf("export async function createIssue"));
    const params = sig.slice(0, sig.indexOf("): Promise"));
    expect(params).toContain("gate:");
    // A `gate: ... = something` would make a forgotten argument silent.
    expect(/gate\s*:[^,)]*=/.test(params)).toBe(false);
  });

  test("the refusal is routed through exactly one exported constant", () => {
    const declarations = source.match(/export const REFUSED_UNGATED\b/g) ?? [];
    expect(declarations.length).toBe(1);
  });
});

describe("AC-5 (#1677): the guard is proved able to fail", () => {
  /**
   * ## Two copies, because the mutant cannot be a one-line edit
   *
   * `lib/github.ts` imports `Octokit` from `@octokit/rest`, and a copy in an
   * `mkdtemp` outside the repository cannot resolve it — the mutant dies on
   * module resolution, which reads as a refusal and makes the battery green
   * while witnessing nothing. So the copy stubs the import.
   *
   * That is a SECOND variable, and a battery varying two cannot attribute its
   * result to either. So there are two copies and they differ in exactly one
   * line:
   *
   * | copy | import | guard | must |
   * |---|---|---|---|
   * | control | stubbed | intact | REFUSE |
   * | mutant  | stubbed | removed | FILE |
   *
   * The control is the half that matters. It proves the import substitution
   * changes nothing about the decision, so the mutant's behaviour is
   * attributable to the guard and to nothing else.
   */
  const IMPORT = `import { Octokit } from "@octokit/rest";`;
  const STUB = `class Octokit { constructor(_?: unknown) { /* unused by createIssue */ } }`;
  const GUARD = "if (!decision.allowed) {";

  /**
   * One directory per copy, and not one directory holding two files. Bun
   * caches a directory's listing on first read, so a second module written
   * into a directory something has already imported from is not found — the
   * battery then dies on resolution, which is the UNMEASURED shape this whole
   * block exists to avoid.
   */
  async function copyOf(removeGuard: boolean, parent: string, name: string) {
    const source = readFileSync(SOURCE, "utf8");
    expect(source).toContain(IMPORT);
    expect(source).toContain(GUARD);

    let text = source.replace(IMPORT, STUB);
    expect(text).not.toBe(source);
    if (removeGuard) {
      const before = text;
      text = text.replace(GUARD, "if (false) {");
      expect(text).not.toBe(before);
    }
    const dir = mkdtempSync(join(parent, `${name}-`));
    const path = join(dir, "github.ts");
    writeFileSync(path, text);
    return (await import(path)) as typeof import("../lib/github");
  }

  test("the control refuses and the mutant files, differing only in the guard", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-1677-mutant-"));
    try {
      // The control FIRST. A mutant read before its baseline is a reading
      // with nothing to compare against.
      const control = await copyOf(false, dir, "control");
      const a = fakeClient();
      let controlRefused = false;
      try {
        await control.createIssue(a.client, "o/r", OPTS, refuse("over cap"));
      } catch {
        controlRefused = true;
      }
      expect(controlRefused).toBe(true);
      expect(a.created.length).toBe(0);

      const mutant = await copyOf(true, dir, "mutant");
      const b = fakeClient();
      await mutant.createIssue(b.client, "o/r", OPTS, refuse("over cap"));

      // The mutant FILES what the control refuses, on the same input, with
      // the same stubbed import. That difference is the guard.
      expect(b.created.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
