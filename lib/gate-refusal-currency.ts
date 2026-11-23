/**
 * Which recorded refusals are still true at the end of the run (#532).
 *
 * The ship gate RE-RUNS the verify checks. `runGateTests` spawns
 * `bun test gates/ --test-name-pattern "schema|scope|verify|ship|B1|B2"` for
 * the ship gate, so every `verify checks > …` name is measured a second
 * time, later, against a tree the heal rounds have since changed.
 *
 * Measured on run `wf_e230fddc-a71`:
 *
 * | Check | `gates.verify.failures` | `gates.ship.failures` |
 * |---|---|---|
 * | `verify checks > tests-pass` | FAIL | FAIL |
 * | `verify checks > evidence-prevalidation` | **FAIL** | **absent** |
 * | `verify checks > tsc-pass` | FAIL | FAIL |
 *
 * `state.evidencePrevalidation` in that same file reads
 * `{"verdict":"PASS", acs: [… all "ok" …]}`. The refusal was round one, a
 * heal fixed it, the ship gate re-ran it and it passed — and the terminal
 * report listed it anyway, because the report is the UNION of every gate's
 * list rather than the latest reading of each check.
 *
 * The run returned 19 refusals. Several were already resolved, so the real
 * count was smaller, and the one that actually blocked the run — a
 * `SECURITY_REVIEW_STALE` — was buried among them. A report with false
 * entries in it is a report nobody reads twice.
 *
 * ## Absence is not a pass
 *
 * The whole thing turns on one distinction, and getting it wrong is worse
 * than the bug it fixes: a check missing from a later gate's FAILURES means
 * either *it passed there* or *that gate never ran it*. Those are opposite
 * facts and a failure list cannot tell them apart. Retiring on absence
 * would silently drop every refusal a later gate's narrower pattern skipped.
 *
 * So retirement requires a positive witness — `checksRun`, the names the
 * later gate reported a verdict for, recorded by `gates/orchestrator.ts`
 * from the same `results` array the failures come from. A gate with no
 * `checksRun` retires NOTHING. `null` and `[]` are different answers here
 * and only one of them is a measurement
 * (.claude/rules/config-access.md, Silent Default Substitution).
 *
 * ## How ship.js runs this
 *
 * `workflows/ship.js` runs in a sandbox with no module loading (#69), so it
 * cannot import this. Until #2688 it carried a hand copy; now
 * `scripts/build-workflow-launch.ts` bundles this module's code into
 * `workflows/ship.run.js`, and `test/gate-refusal-currency.test.ts` runs
 * the launch file's bundled copy and this module over one input matrix, as
 * `test/suite-measurement-parity.test.ts` does for `suiteCurrency`.
 */

/** What a gate run reported back: the names it measured and the ones it failed. */
export interface GateReport {
  checksRun?: unknown;
  failedChecks?: unknown;
  /** The gate's free-text failure lines, each meant to begin with its check's name. */
  failures?: unknown;
}

/** One recorded refusal. `check` is absent for refusals no gate produced. */
export interface RefusalEntry {
  check?: unknown;
  [k: string]: unknown;
}

/**
 * The checks a gate ran and did NOT fail — the only thing that can retire an
 * earlier refusal.
 *
 * `null` when the gate reported no `checksRun`, and that is the
 * load-bearing return rather than an empty array: a caller has to be able
 * to tell "this gate said nothing about what it ran" from "this gate ran
 * nothing".
 *
 * Also `null` when `failedChecks` is absent or not a list (#2688). A report
 * naming what it ran but not what it failed says nothing about which checks
 * passed. Reading the missing list as "nothing failed" retired a refusal for a
 * check the same gate had just failed again.
 *
 * And `null` when the report lists a failure line no single `failedChecks`
 * entry claims (#2690). The agent copies those names from the lines, and a
 * partial copy left a still-failing check out of the list, so it counted as
 * resolved. Claimed means `failureCheckName` finds its one name.
 *
 * And `null` when a failure line belongs to a check that ran and is missing
 * from `failedChecks` (#2691 review round 1). Check names can contain ": ", so
 * a truncated copy can still claim a line at a boundary; the line naming a
 * ran-but-unlisted check in full is the report contradicting itself.
 */
export function resolvedCheckNames(report: GateReport | null | undefined): string[] | null {
  if (!report || !Array.isArray(report.checksRun) || !Array.isArray(report.failedChecks)) return null;
  if (Array.isArray(report.failures)) {
    for (const line of report.failures) {
      if (typeof line === "string" && line !== "" && failureCheckName(line, report.failedChecks) === undefined) return null;
    }
  }
  const failed = new Set(
    report.failedChecks.filter(
      (c: unknown): c is string => typeof c === "string" && c !== "",
    ),
  );
  if (Array.isArray(report.failures)) {
    for (const line of report.failures) {
      if (typeof line !== "string" || line === "") continue;
      for (const ran of report.checksRun) {
        if (typeof ran === "string" && ran !== "" && !failed.has(ran) && checkNameClaimsLine(ran, line)) return null;
      }
    }
  }
  return report.checksRun.filter(
    (c: unknown): c is string => typeof c === "string" && c !== "" && !failed.has(c),
  );
}

/**
 * The one reported check name that claims a free-text failure line (#532), or
 * undefined. A line is claimed only when EXACTLY ONE name claims it, at a
 * boundary (`checkNameClaimsLine`): two names that both claim one line would
 * make its refusal retirable by either, and a refusal retired by the wrong
 * check's pass is the defect #532 fixed, pointed the other way. ship.js tags
 * its refusals with this, and `resolvedCheckNames` refuses a report with an
 * unclaimed line (#2690).
 */
export function failureCheckName(line: unknown, failedChecks: unknown): string | undefined {
  if (typeof line !== "string" || line === "") return undefined;
  const reported = (Array.isArray(failedChecks) ? failedChecks : []).filter(
    (c: unknown): c is string => typeof c === "string" && c !== "",
  );
  const hits = reported.filter(c => checkNameClaimsLine(c, line));
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * Whether a failure line is about `name`: the line IS the name, or the name is
 * followed by ": " (#2691 review round 1). A bare prefix let "tsc" claim a
 * "tsc-strict: 2 errors" line. A line in any other shape is claimed by no
 * name, which retires nothing: the safe direction.
 */
function checkNameClaimsLine(name: string, line: string): boolean {
  return line === name || line.startsWith(`${name}: `);
}

/**
 * Remove, IN PLACE, every earlier refusal about a check this gate re-ran and
 * did not reproduce. Returns the entries it removed.
 *
 * In place because the ledger is one array the whole run appends to, and
 * returning a copy would leave the original to be reported by whichever
 * reader got there first. The removed entries are returned rather than
 * discarded: a refusal that was retired is a thing an operator may want to
 * see, and silently shortening a list is how a report stops being checkable.
 */
export function retireSupersededRefusals(
  entries: RefusalEntry[],
  report: GateReport | null | undefined,
): RefusalEntry[] {
  const resolved = resolvedCheckNames(report);
  if (resolved === null || resolved.length === 0) return [];
  const names = new Set(resolved);
  const dropped: RefusalEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const check = entries[i]?.check;
    if (typeof check === "string" && check !== "" && names.has(check)) {
      dropped.unshift(entries.splice(i, 1)[0]);
    }
  }
  return dropped;
}
