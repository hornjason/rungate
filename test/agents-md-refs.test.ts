/**
 * Covers SC-846, SC-847, SC-848 (AGENTS-MD-TEMPLATE-SPEC.md).
 *
 * #380 — `refreshAgentsMd`'s broken-link check read a backtick span as a
 * file path. AGENTS.md has a Commands table whose commands end in
 * filenames, so the whole command string went to `existsSync`. On this repo
 * it produced three reports, three false positives and zero true positives:
 * the check had never once validated a real reference here.
 *
 * Both directions are asserted throughout, because narrowing a detector to
 * buy green is shape two of `.claude/rules/checks-must-be-able-to-fail.md`
 * and this change is exactly that kind of narrowing.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isPathReference, referencedPaths } from "../lib/agents-md-refs";
import {
  AI_REVIEW_AUTH_PRECEDENCE,
  AI_REVIEW_MODE_NONE,
  AI_REVIEW_MODE_VERTEX,
  AI_REVIEW_MODEL,
  AI_REVIEW_PULL_REQUEST_TYPES,
  AI_REVIEW_REQUIRE_VALUE,
  AI_REVIEW_REQUIRE_VAR,
  AI_REVIEW_RUNS,
} from "../lib/scaffold/ai-review-step";
import { refreshAgentsMd } from "../lib/scaffold/steps";

const ROOT = join(import.meta.dir, "..");

describe("#380 SC-846: a command that ends in a filename is not a file reference", () => {
  test("the three spans this repo actually reported are rejected", () => {
    // Verbatim from AGENTS.md's Commands table at the time of the fix.
    for (const span of [
      "bun test test/scaffold-conformity.test.ts",
      "bun scripts/typecheck.ts",
      "bun scripts/test-clean-env.ts",
    ]) {
      expect(isPathReference(span), `${span} is still read as a path`).toBe(false);
    }
  });

  test("a real relative path is still a reference", () => {
    // The other direction, and the one that matters: narrowing the detector
    // until it reports nothing would satisfy the case above for free.
    for (const span of [
      "CODE-MAP.md",
      "PROJECT-STATE.md",
      ".claude/rungate/config.json",
      "lib/scaffold/steps.ts",
      "docs/adr/ADR-002-config-access.md",
      "tsconfig.json",
      ".github/workflows/ci.yml",
    ]) {
      expect(isPathReference(span), `${span} stopped being checked`).toBe(true);
    }
  });

  test("the boundary is whitespace and path characters, both ways", () => {
    // SC-B. These are the cases that decide the predicate, written down so
    // a future widening has to argue with them rather than with a comment.
    expect(isPathReference("a.md")).toBe(true);
    expect(isPathReference("a b.md"), "whitespace makes it a phrase").toBe(false);
    expect(isPathReference("https://example.com/x.md"), "a URL is not a path").toBe(false);
    expect(isPathReference("--config=x.json"), "a flag is not a path").toBe(false);
    expect(isPathReference("specs/<name>.md"), "a placeholder is not a path").toBe(false);
    expect(isPathReference("$DIR/x.ts"), "a variable is not a path").toBe(false);
    expect(isPathReference("specs/*.md"), "a glob is not a path").toBe(false);
    expect(isPathReference("README"), "no extension, nothing to resolve").toBe(false);
    expect(isPathReference("x.rs"), "an extension the check cannot resolve").toBe(false);
    // The end anchor, which nothing else reaches. `^` plus a character
    // class with no space in it already rejects every command, so dropping
    // `$` scored 0 until this case existed — and without `$` the span is
    // accepted on its `.json` prefix and then resolved whole.
    expect(isPathReference("config.json.example"), "an unknown extension after a known one")
      .toBe(false);
    expect(isPathReference("ADR-002.md"), "a known extension last is still a path").toBe(true);
  });
});

describe("#380 SC-847: the real AGENTS.md produces no false positives and does not go blind", () => {
  const content = readFileSync(join(ROOT, "AGENTS.md"), "utf-8");

  test("every reference the predicate accepts resolves on disk", () => {
    const unresolved = referencedPaths(content).filter(
      rel => !require("fs").existsSync(join(ROOT, rel)),
    );
    expect(unresolved, `AGENTS.md names files that do not exist`).toEqual([]);
  });

  test("the Commands table's spans are not among them", () => {
    const refs = referencedPaths(content);
    for (const ref of refs) {
      expect(ref, "a command string is being treated as a path").not.toMatch(/\s/);
    }
  });

  test("a dangling reference planted in the document IS reported", () => {
    // The positive control, and it has to be here rather than over the
    // shipped file. "Zero unresolved references" is produced just as readily
    // by a scan that resolves nothing at all — which is the state this check
    // shipped in: three reports, none of them real.
    const planted = `${content}\n\nSee \`docs/nope.md\` for details.\n`;
    const refs = referencedPaths(planted);
    expect(refs, "the scan did not see a planted reference").toContain("docs/nope.md");
    expect(require("fs").existsSync(join(ROOT, "docs/nope.md"))).toBe(false);
    // And a planted REAL reference is seen too, so the scan is not merely
    // finding things that happen not to exist.
    expect(referencedPaths(`${content}\n\`CODE-MAP.md\`\n`)).toContain("CODE-MAP.md");
  });

  test("rungate's own AGENTS.md names one file, and the check has real work to do here", () => {
    // Measured, and written down because it is the uncomfortable half of
    // the finding. The check reported three spans here, all false; its
    // true-positive count was zero because there was nothing true to find.
    // D-15 capped AGENTS.md at 100 lines and moved the routing and key-file
    // tables into `.claude/rules/`, so every real path reference left with
    // them. What remained was a Commands table full of command strings.
    //
    // It stopped being zero on 2026-10-28, which this test's previous
    // revision said to handle by UPDATING the assertion rather than
    // deleting the reference. `## Hard Constraints` rule 5 cites the spec
    // that holds the measurement it argues against, because a rule whose
    // evidence is a bare number is a rule nobody can check. So the
    // population is now exactly one, asserted by name: the check is no
    // longer vacuous here, and a second path arriving is a deliberate
    // edit somebody should see in this diff.
    //
    // The second one arrived on 2026-10-31: rule 9 names `project-state.json`
    // because that is where an agreement has to land to count, and a rule
    // that will not say which file is a rule nobody can comply with.
    //
    // Four more arrived on 2026-11-12 with ADR-013 row 3 (SC-2736): rule 9
    // now names the ADR template and the workflow that places a plan (steps
    // 2 and 3), and the three session-record files step 4 exempts, because an
    // exemption that will not name its file set is one nobody can check.
    const named = [
      "specs/CODE-REVIEW-CONVERGENCE-SPEC.md",
      "docs/adr/TEMPLATE.md",
      ".github/workflows/adr-accepted.yml",
      "project-state.json",
      "PROJECT-STATE.md",
      "SUCCESS.md",
    ];
    expect(referencedPaths(content)).toEqual(named);
    // And they resolve — the half that makes naming them worth anything.
    for (const p of named) expect(require("fs").existsSync(join(ROOT, p))).toBe(true);
  });
});

describe("#380 SC-848: refreshAgentsMd itself stops reporting commands as missing files", () => {
  // EXECUTED, not grepped. The first version of this asserted that the
  // function's source text contained "referencedPaths" — and the mutation
  // that replaced the call with `const refs: string[] = []` left it GREEN,
  // because the comment above the call says the word too. A detector
  // satisfied by the prose warning against the thing is the self-reference
  // trap `.claude/rules/checks-must-be-able-to-fail.md` names.

  function audit(agentsMd: string): string[] {
    const d = mkdtempSync(join(tmpdir(), "agents-refs-"));
    try {
      writeFileSync(join(d, "AGENTS.md"), agentsMd);
      const actions: string[] = [];
      refreshAgentsMd(d, "code", actions);
      return actions;
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }

  /** The broken-reference count the audit reports. */
  function brokenCount(agentsMd: string): number {
    const line = audit(agentsMd).find(a => a.startsWith("AUDITED: AGENTS.md"));
    expect(line, "the audit reported nothing at all").toBeDefined();
    if (/all references valid/.test(line!)) return 0;
    return Number(/\((\d+) broken refs/.exec(line!)?.[1] ?? NaN);
  }

  test("a Commands table of command strings reports zero broken references", () => {
    // The regression. Every one of these ends in a real extension and none
    // of them is a path; all three were reported before the fix.
    expect(
      brokenCount(
        "# p\n\n| Action | Command |\n|---|---|\n" +
          "| Test | `bun test test/scaffold-conformity.test.ts` |\n" +
          "| Type check | `bun scripts/typecheck.ts` |\n" +
          "| CI | `bun scripts/test-clean-env.ts` |\n",
      ),
    ).toBe(0);
  });

  test("a genuinely dangling path is still reported", () => {
    // The positive control, through the real function. Without it, a
    // predicate narrowed to `return false` passes the case above.
    expect(brokenCount("# p\n\nSee `docs/nope.md` and `lib/gone.ts`.\n")).toBe(2);
  });

  test("the two scans agree: the staleness scan sees no span the link scan rejects", () => {
    // They had separate patterns. Two scans with two ideas of what a
    // reference is means the second silently stops covering spans the first
    // rejects, and nothing can notice because they never compare answers.
    const src = readFileSync(join(ROOT, "lib", "scaffold", "steps.ts"), "utf-8");
    const fn = src.slice(src.indexOf("export function refreshAgentsMd"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body, "a second inline backtick pattern survives in refreshAgentsMd")
      .not.toMatch(/`\(\[\^`\]\+/);
  });
});

// #2650. The consumer guide is the document a person reads before adding a
// credential, so every figure in it is bound to the generator it describes:
// the modes and secrets to `AI_REVIEW_AUTH_PRECEDENCE`, the order the generated
// script walks; the events a round runs on to `AI_REVIEW_PULL_REQUEST_TYPES`;
// the price to `AI_REVIEW_MODEL`, and the runs a round to `AI_REVIEW_RUNS`.
// A change to any of them turns this red until the guide says it.
const GUIDE = "docs/guides/AI-REVIEW.md";
const audit = readFileSync(join(ROOT, "docs/research/ai-review-audit.md"), "utf-8");

/** The table whose header row opens with `first`, as trimmed cells. */
function markdownTable(md: string, first: string): { header: string[]; rows: string[][] } | null {
  const lines = md.split("\n");
  const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
  const at = lines.findIndex(l => l.trim().startsWith("|") && cells(l)[0] === first);
  if (at < 0) return null;
  const rows: string[][] = [];
  for (let i = at + 2; i < lines.length && lines[i].trim().startsWith("|"); i++) rows.push(cells(lines[i]));
  return { header: cells(lines[at]), rows };
}

/** Everything the guide gets wrong about the generated job, as sentences. */
function aiReviewGuideViolations(
  guide: string,
  precedence: readonly { secret: string; mode: string }[] = AI_REVIEW_AUTH_PRECEDENCE,
  events: readonly string[] = AI_REVIEW_PULL_REQUEST_TYPES,
): string[] {
  const v: string[] = [];
  const bare = (s: string) => s.replace(/`/g, "");
  // #2715 review: the order the generated script tries, read off the list it
  // walks. A hand-typed mode list stayed green with that list reordered.
  const order = [AI_REVIEW_MODE_VERTEX, ...precedence.map(c => c.mode), AI_REVIEW_MODE_NONE];

  const creds = markdownTable(guide, "Mode");
  if (creds === null) return ["no table opens with a Mode column"];
  const pays = creds.header.findIndex(h => /^who pays$/i.test(h));
  if (pays < 0) v.push("the Mode table has no Who pays column");
  const modes = creds.rows.map(r => bare(r[0]));
  if (modes.join(",") !== order.join(",")) {
    v.push(`the Mode table lists ${modes.join(", ")}, not the job's ${order.join(", ")} in the order it tries them`);
  }
  if (precedence.length >= 2 && !guide.includes(
    `When both secrets are set, \`${precedence[0].secret}\` wins, and \`${precedence[1].secret}\` is never handed to the action.`,
  )) {
    v.push(`the guide does not say ${precedence[0].secret} wins when both secrets are set`);
  }
  for (const r of creds.rows) {
    const mode = bare(r[0]);
    const what = r[1] ?? "";
    const named = precedence.find(c => c.mode === mode)?.secret;
    if (named !== undefined && !what.includes(`\`${named}\``)) v.push(`the ${mode} row does not name ${named}`);
    if (mode === AI_REVIEW_MODE_VERTEX && !what.includes("`ci.vertex`")) v.push("the vertex row does not name ci.vertex");
    const payer = pays < 0 ? "" : (r[pays] ?? "");
    if (payer === "") v.push(`the ${mode} row names no payer`);
    if (mode === AI_REVIEW_MODE_NONE && !/nothing is spent/i.test(payer)) v.push("the none row does not say nothing is spent");
  }
  // The no-credential prose, read as well as the table cell: the job exits 0
  // with an UNMEASURED warning unless the switch below is set.
  const free = guide.split(/^## /m).find(s => s.startsWith("Nothing is spent")) ?? "";
  if (!free.includes("UNMEASURED") || !free.includes("the check passes")) {
    v.push("the no-credential section does not say the check passes with an UNMEASURED warning");
  }
  if (!guide.includes("refused as a whole") || !guide.includes("picks from the secrets as if `ci.vertex` were not set")) {
    v.push("the guide does not say a ci.vertex the scaffold refuses falls back to the secrets");
  }
  // The events the guide lists, compared both ways (#2715 review round 2): a
  // listed event the job no longer subscribes to is as wrong as a missing one.
  const listing = /A round runs\s+on every pull request event the job subscribes to:([^.]*)\./.exec(guide)?.[1];
  if (listing === undefined) {
    v.push("the guide does not list the pull request events a round runs on");
  } else {
    const listed = [...listing.matchAll(/`([a-z_]+)`/g)].map(m => m[1]);
    for (const e of events) if (!listed.includes(e)) v.push(`the guide does not name the ${e} event, which runs a round`);
    for (const e of listed) if (!events.includes(e)) v.push(`the guide names the ${e} event, which the job does not subscribe to`);
  }
  if (!guide.includes(`\`${AI_REVIEW_REQUIRE_VAR}\` to exactly \`${AI_REVIEW_REQUIRE_VALUE}\``)) {
    v.push(`the guide does not name ${AI_REVIEW_REQUIRE_VAR} and the exact value that makes a missing credential fail`);
  }

  const cost = markdownTable(guide, "Measure");
  if (cost === null) return [...v, "no table opens with a Measure column"];
  const cell = (label: RegExp) => cost.rows.find(r => label.test(r[0]));
  const money = (s: string | undefined) => Number(/^\$(\d+(?:\.\d+)?)$/.exec(s ?? "")?.[1] ?? NaN);
  const cents = (x: number) => Math.round(x * 100) / 100;
  const perRunRow = cell(/^Per run on /);
  if (perRunRow === undefined || !perRunRow[0].includes(`\`${AI_REVIEW_MODEL}\``)) {
    v.push(`the cost table does not price a run on the default model, ${AI_REVIEW_MODEL}`);
  }
  const perRun = money(perRunRow?.[1]);
  const runs = Number(cell(/^Runs per round$/)?.[1] ?? NaN);
  const rounds = Number(cell(/^Rounds per pull request$/)?.[1] ?? NaN);
  // #2715 review round 4: the rounds figure is the audit's measurement, so it
  // is held to the audit's own table, not left free to drift within a rounding.
  const measured = Number(/^\| Runs per pull request \| \*\*(\d+(?:\.\d+)?)\*\* mean/m.exec(audit)?.[1] ?? NaN);
  if (rounds !== measured) v.push(`the cost table says ${rounds} rounds a pull request; the audit measured ${measured}`);
  const perRound = money(cell(/^Per round$/)?.[1]);
  const perPr = money(cell(/^Per pull request$/)?.[1]);
  if (!(perRun > 0)) v.push("the cost table states no price a run");
  if (runs !== AI_REVIEW_RUNS) v.push(`the cost table says ${runs} runs a round; the job makes ${AI_REVIEW_RUNS}`);
  if (!(rounds > 0)) v.push("the cost table states no rounds per pull request");
  if (perRound !== cents(perRun * AI_REVIEW_RUNS)) {
    v.push(`the cost table says $${perRound} a round; ${AI_REVIEW_RUNS} runs at $${perRun} is $${cents(perRun * AI_REVIEW_RUNS)}`);
  }
  if (perPr !== cents(perRun * AI_REVIEW_RUNS * rounds)) {
    v.push(`the cost table says $${perPr} a pull request; ${rounds} rounds of ${AI_REVIEW_RUNS} runs at $${perRun} is $${cents(perRun * AI_REVIEW_RUNS * rounds)}`);
  }
  return v;
}

describe("CRC-B13: the consumer AI review guide says what the job resolves, who pays, what a pull request costs, and that no credential spends nothing", () => {
  const guide = readFileSync(join(ROOT, GUIDE), "utf-8");

  test("the shipped guide agrees with the generated job on every figure it states", () => {
    expect(aiReviewGuideViolations(guide)).toEqual([]);
  });

  // The controls. "No violations" is produced just as readily by a checker
  // that reads nothing, so each case breaks one statement in a copy of the
  // shipped guide and asserts the sentence naming that break.
  const broken = (from: string, to: string) => {
    expect(guide.split(from).length - 1, `the control's anchor is not in the guide once: ${from}`).toBe(1);
    return aiReviewGuideViolations(guide.replace(from, () => to));
  };

  test("CONTROL: a credential the job resolves, missing from the guide, is reported", () => {
    const row = guide.split("\n").find(l => l.startsWith("| `api-key` |"))!;
    expect(broken(`${row}\n`, "")).toContain(
      "the Mode table lists vertex, oauth, none, not the job's vertex, oauth, api-key, none in the order it tries them",
    );
  });

  test("CONTROL: a row that names no payer is reported", () => {
    expect(broken("| your Anthropic API bill |", "| |")).toContain("the api-key row names no payer");
  });

  test("CONTROL: a guide that stops saying no credential spends nothing is reported", () => {
    expect(broken("nobody: no review runs and nothing is spent", "you")).toContain("the none row does not say nothing is spent");
  });

  test("CONTROL: a runs-a-round figure the job does not make is reported", () => {
    const v = broken("| Runs per round | 3 |", "| Runs per round | 4 |");
    expect(v).toContain(`the cost table says 4 runs a round; the job makes ${AI_REVIEW_RUNS}`);
  });

  test("CONTROL: a rounds figure the audit did not measure is reported, even inside a rounding", () => {
    expect(broken("| Rounds per pull request | 2.7 |", "| Rounds per pull request | 2.8 |"))
      .toContain("the cost table says 2.8 rounds a pull request; the audit measured 2.7");
  });

  test("CONTROL: a per-pull-request cost that does not follow from the table is reported", () => {
    const v = broken("| Per pull request | $0.13 |", "| Per pull request | $0.50 |");
    expect(v.some(s => s.startsWith("the cost table says $0.5 a pull request"))).toBe(true);
  });

  test("CONTROL: a price on a model the job does not default to is reported", () => {
    const v = broken(`| Per run on \`${AI_REVIEW_MODEL}\` |`, "| Per run on `claude-sonnet-5` |");
    expect(v).toContain(`the cost table does not price a run on the default model, ${AI_REVIEW_MODEL}`);
  });

  test("CONTROL: dropping the switch that makes a missing credential fail is reported", () => {
    const v = broken(`\`${AI_REVIEW_REQUIRE_VAR}\` to exactly \`${AI_REVIEW_REQUIRE_VALUE}\``, `\`${AI_REVIEW_REQUIRE_VAR}\``);
    expect(v).toContain(`the guide does not name ${AI_REVIEW_REQUIRE_VAR} and the exact value that makes a missing credential fail`);
  });

  test("CONTROL: a guide written for the other precedence order is reported", () => {
    const v = aiReviewGuideViolations(guide, [...AI_REVIEW_AUTH_PRECEDENCE].reverse());
    expect(v.some(s => s.startsWith("the Mode table lists "))).toBe(true);
    expect(v).toContain(`the guide does not say ${AI_REVIEW_AUTH_PRECEDENCE[1].secret} wins when both secrets are set`);
  });

  test("CONTROL: an event the job runs a round on, missing from the guide, is reported", () => {
    expect(broken("`reopened`", "reopened")).toContain("the guide does not name the reopened event, which runs a round");
    expect(aiReviewGuideViolations(guide, AI_REVIEW_AUTH_PRECEDENCE, AI_REVIEW_PULL_REQUEST_TYPES.filter(e => e !== "unlabeled")))
      .toContain("the guide names the unlabeled event, which the job does not subscribe to");
    expect(aiReviewGuideViolations(guide, AI_REVIEW_AUTH_PRECEDENCE, [...AI_REVIEW_PULL_REQUEST_TYPES, "edited"]))
      .toContain("the guide does not name the edited event, which runs a round");
  });

  test("CONTROL: a guide saying no credential fails the check is reported", () => {
    expect(broken("and the check passes", "and the check fails"))
      .toContain("the no-credential section does not say the check passes with an UNMEASURED warning");
  });

  test("CONTROL: a guide that drops the refused ci.vertex fallback is reported", () => {
    expect(broken("is refused as a whole", "is ignored"))
      .toContain("the guide does not say a ci.vertex the scaffold refuses falls back to the secrets");
  });

  test("HOW-WORK-FLOWS.md points at the guide, and the reference resolves", () => {
    const flows = readFileSync(join(ROOT, "docs/guides/HOW-WORK-FLOWS.md"), "utf-8");
    expect(referencedPaths(flows)).toContain(GUIDE);
    expect(require("fs").existsSync(join(ROOT, GUIDE))).toBe(true);
  });
});
