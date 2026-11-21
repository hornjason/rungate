#!/usr/bin/env bun
/**
 * Count the external API calls a CI run recorded (#2596).
 *
 *   bun scripts/ci-api-census.ts <record-or-job-log>… [--json]
 *   bun scripts/ci-api-census.ts --install-gh-tap <dir> [--real-gh <path>]
 *   bun scripts/ci-api-census.ts --model <review-job-log>…
 *   bun scripts/ci-api-census.ts --runs <runs.jsonl>
 *
 * Jason, on 2026-11-21: "we shouldn't be spamming API endpoints if we can find
 * a better method to batch." Nobody had counted. This reads what a run itself
 * wrote down — never an estimate — so the number describes the run it came
 * from, and the biggest caller can be named rather than guessed.
 *
 * Two taps write the record, one line per HTTP request:
 *
 * - `scripts/api-call-tap.ts`, a Bun preload, for every `fetch` — Octokit and
 *   the hand-rolled readers alike.
 * - The `gh` this script writes with `--install-gh-tap`: it runs the real gh
 *   with `GH_DEBUG=1`, moves gh's `* Request to <url>` lines into the record,
 *   and passes everything else through unchanged — stdout, the rest of stderr,
 *   the exit code. `--paginate` is counted page by page, because each page is
 *   a request.
 *
 * The record may be read raw or from inside a CI job log: a tap line is found
 * wherever `API-TAP` appears on a line, behind the runner's timestamps.
 *
 * **A record with no `API-TAP-START` line is UNMEASURED, never zero.** The
 * step that installs the taps writes that line first, so a tap that never
 * started and a run that made no calls stay different facts. An unreadable
 * file is UNMEASURED too. Either exits `CENSUS_UNMEASURED_EXIT`, naming the
 * file. A line that does not parse, and a request the preload could not write
 * down (`API-TAP-LOST`), are counted and printed, never dropped.
 *
 * `--model` reads the AI reviewers' model calls instead, from the result the
 * review action prints when it finishes: `num_turns` (one model request per
 * turn) and `total_cost_usd`. A log with no result made no model call — a
 * review skipped on push — and is counted as such, never as zero turns.
 *
 * `--runs` counts how often each workflow ran, from the Actions API's own
 * list (`gh api --paginate "…/actions/runs?created=>=<when>" --jq
 * '.workflow_runs[]'`), by event and conclusion. An empty list is UNMEASURED:
 * a window with no runs and a query that returned nothing look the same.
 *
 * Imports nothing relative, so a mutant copy of this file still loads.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";

/** The one exit code for every refusal: an unreadable or never-started record, or nothing to read. */
export const CENSUS_UNMEASURED_EXIT = 1;

/**
 * The `BUN_OPTIONS` value that turns the fetch tap on. With `=`, never a
 * space: Bun reads `--preload <path>` there as a flag and then a script name,
 * and `bun test` refuses with `Script not found "test"`.
 */
export function tapBunOptions(tapPath: string): string {
  return `--preload=${tapPath}`;
}

/** Written by the step that installs the taps, before the first request. */
export const TAP_START = "API-TAP-START";

const TAP_LINE = "API-TAP ";
const TAP_LOST = "API-TAP-LOST";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const LOOPBACK_API = "loopback (not external)";
const LOCAL_FILE_API = "local file (not external)";
/** The APIs a call can be filed under that leave no machine. Counted, never in the external total. */
export const NOT_EXTERNAL: ReadonlySet<string> = new Set([LOOPBACK_API, LOCAL_FILE_API]);
const ENDPOINTS_SHOWN = 15;

export interface TapCall {
  via: string;
  method: string;
  url: string;
  /** The calling file the fetch tap read off the stack; absent for gh, which has no stack to read. */
  from?: string;
}

export type TapReading =
  | { status: "measured"; calls: TapCall[]; starts: number; unparsed: number; lost: number }
  | { status: "unmeasured"; reason: string };

export function readTap(text: string): TapReading {
  let starts = 0;
  let unparsed = 0;
  let lost = 0;
  const calls: TapCall[] = [];
  for (const line of text.split("\n")) {
    if (line.includes(TAP_START)) {
      starts++;
      continue;
    }
    if (line.includes(TAP_LOST)) {
      lost++;
      continue;
    }
    const at = line.indexOf(TAP_LINE);
    if (at < 0) continue;
    const parts = line.slice(at + TAP_LINE.length).trim().split(/\s+/);
    const fromOk = parts.length === 3 || (parts.length === 4 && parts[3].startsWith("from="));
    if (!fromOk || !/^[a-z][a-z0-9+.-]*:\/\//i.test(parts[2])) {
      unparsed++;
      continue;
    }
    calls.push({ via: parts[0], method: parts[1], url: parts[2], ...(parts[3] ? { from: parts[3].slice(5) } : {}) });
  }
  if (starts === 0) {
    return {
      status: "unmeasured",
      reason: `the tap never started: no ${TAP_START} line, so this record cannot say how many calls the run made`,
    };
  }
  return { status: "measured", calls, starts, unparsed, lost };
}

/** Which API a call went to, and its endpoint with numbers and commit SHAs folded. */
export function classifyCall(url: string): { api: string; endpoint: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { api: "unparseable URL", endpoint: url.split("?")[0] };
  }
  const endpoint = u.pathname
    .split("/")
    .map(seg => (/^\d+$/.test(seg) ? "{n}" : /^[0-9a-f]{40}$/i.test(seg) ? "{sha}" : seg))
    .join("/");
  if (u.protocol === "file:") return { api: LOCAL_FILE_API, endpoint };
  if (LOOPBACK.has(u.hostname)) return { api: LOOPBACK_API, endpoint };
  if (u.hostname === "api.github.com") {
    return { api: u.pathname === "/graphql" ? "GitHub GraphQL" : "GitHub REST", endpoint };
  }
  return { api: u.hostname, endpoint };
}

export interface Census {
  records: number;
  unmeasured: string[];
  external: number;
  /** Calls to loopback or to local files: recorded, and never in `external`. */
  notExternal: number;
  unparsed: number;
  lost: number;
  apis: { api: string; calls: number; endpoints: { endpoint: string; calls: number }[] }[];
  /** External calls by the file that made them, where the tap could read it. */
  sources: { from: string; calls: number }[];
}

export function countCalls(readings: TapReading[]): Census {
  const byApi = new Map<string, Map<string, number>>();
  const census: Census = { records: readings.length, unmeasured: [], external: 0, notExternal: 0, unparsed: 0, lost: 0, apis: [], sources: [] };
  const bySource = new Map<string, number>();
  for (const r of readings) {
    if (r.status === "unmeasured") {
      census.unmeasured.push(r.reason);
      continue;
    }
    census.unparsed += r.unparsed;
    census.lost += r.lost;
    for (const call of r.calls) {
      const { api, endpoint } = classifyCall(call.url);
      if (NOT_EXTERNAL.has(api)) {
        census.notExternal++;
        continue;
      }
      census.external++;
      const from = call.from ?? (call.via === "gh" ? "(gh: caller not handed down)" : "-");
      bySource.set(from, (bySource.get(from) ?? 0) + 1);
      const endpoints = byApi.get(api) ?? new Map<string, number>();
      endpoints.set(endpoint, (endpoints.get(endpoint) ?? 0) + 1);
      byApi.set(api, endpoints);
    }
  }
  census.apis = [...byApi.entries()]
    .map(([api, endpoints]) => ({
      api,
      calls: [...endpoints.values()].reduce((s, n) => s + n, 0),
      endpoints: [...endpoints.entries()]
        .map(([endpoint, calls]) => ({ endpoint, calls }))
        .sort((a, b) => b.calls - a.calls || a.endpoint.localeCompare(b.endpoint)),
    }))
    .sort((a, b) => b.calls - a.calls || a.api.localeCompare(b.api));
  census.sources = [...bySource.entries()]
    .map(([from, calls]) => ({ from, calls }))
    .sort((a, b) => b.calls - a.calls || a.from.localeCompare(b.from));
  return census;
}

export function renderCensus(c: Census): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const out = [
    `External API calls recorded: ${c.external} (plus ${c.notExternal} to loopback or local files, not external), over ${plural(c.records, "record")}`,
  ];
  for (const a of c.apis) {
    out.push(`  ${a.api}: ${a.calls}`);
    for (const e of a.endpoints.slice(0, ENDPOINTS_SHOWN)) out.push(`    ${String(e.calls).padStart(5)}  ${e.endpoint}`);
    if (a.endpoints.length > ENDPOINTS_SHOWN) out.push(`    … ${a.endpoints.length - ENDPOINTS_SHOWN} more endpoints`);
  }
  if (c.sources.length > 0) {
    out.push("  by the file that made them:");
    for (const s of c.sources.slice(0, ENDPOINTS_SHOWN)) out.push(`    ${String(s.calls).padStart(5)}  ${s.from}`);
    if (c.sources.length > ENDPOINTS_SHOWN) out.push(`    … ${c.sources.length - ENDPOINTS_SHOWN} more files`);
  }
  if (c.unparsed > 0) out.push(`${plural(c.unparsed, "tap line")} did not parse, and ${c.unparsed === 1 ? "is" : "are"} not in the count above`);
  if (c.lost > 0) out.push(`${plural(c.lost, "request")} went out but could not be written down (API-TAP-LOST), so the count above is short by at least that`);
  for (const u of c.unmeasured) out.push(`UNMEASURED: ${u}`);
  return out.join("\n");
}

export interface RunCount {
  total: number;
  workflows: { name: string; runs: number; by: Record<string, number> }[];
}

/** Runs per workflow from one Actions run object per line. A line that is not one refuses the list. */
export function countRuns(jsonl: string): RunCount {
  const byName = new Map<string, Record<string, number>>();
  let total = 0;
  jsonl.split("\n").forEach((raw, i) => {
    if (raw.trim() === "") return;
    let run: { name?: unknown; event?: unknown; conclusion?: unknown };
    try {
      run = JSON.parse(raw);
    } catch {
      throw new Error(`line ${i + 1} is not a JSON run object`);
    }
    if (typeof run.name !== "string" || typeof run.event !== "string") throw new Error(`line ${i + 1} has no name or event`);
    const key = `${run.event} ${typeof run.conclusion === "string" ? run.conclusion : "in progress"}`;
    const by = byName.get(run.name) ?? {};
    by[key] = (by[key] ?? 0) + 1;
    byName.set(run.name, by);
    total++;
  });
  const workflows = [...byName.entries()]
    .map(([name, by]) => ({
      name,
      runs: Object.values(by).reduce((s, n) => s + n, 0),
      by: Object.fromEntries(Object.entries(by).sort(([a], [b]) => a.localeCompare(b))),
    }))
    .sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));
  return { total, workflows };
}

/** One review job's model run, from the last result object its log printed; null when it printed none. */
export function readModelRun(log: string): { turns: number; costUsd: number | null } | null {
  const turns = [...log.matchAll(/"num_turns":\s*(\d+)/g)];
  if (turns.length === 0) return null;
  const costs = [...log.matchAll(/"total_cost_usd":\s*([0-9.]+)/g)];
  return {
    turns: Number(turns[turns.length - 1][1]),
    costUsd: costs.length === 0 ? null : Number(costs[costs.length - 1][1]),
  };
}

export function renderModelRuns(rows: { log: string; run: { turns: number; costUsd: number | null } | null }[]): string {
  const runs = rows.flatMap(r => (r.run ? [r.run] : []));
  const turns = runs.map(r => r.turns);
  const total = turns.reduce((s, n) => s + n, 0);
  const costed = runs.filter(r => r.costUsd !== null);
  const cost = costed.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const out = [`${rows.length} logs: ${runs.length} with a model run, ${rows.length - runs.length} without`];
  if (runs.length > 0) {
    out.push(
      `${total} model turns (one request each): mean ${(total / runs.length).toFixed(1)}, min ${Math.min(...turns)}, max ${Math.max(...turns)}`,
    );
    out.push(`cost $${cost.toFixed(2)} over ${costed.length} run${costed.length === 1 ? "" : "s"} that reported one, mean $${costed.length ? (cost / costed.length).toFixed(2) : "n/a"}`);
  }
  return out.join("\n");
}

/** The `gh` the tap installs: the real one, with each request moved into the record. */
export function ghTapScript(realGh: string): string {
  const quoted = `'${realGh.replace(/'/g, `'\\''`)}'`;
  return [
    "#!/bin/sh",
    "# Written by scripts/ci-api-census.ts --install-gh-tap (#2596). It is the real gh,",
    "# plus one record line per HTTP request gh makes. With RUNGATE_API_TAP unset it is",
    "# exactly the real gh.",
    `real=${quoted}`,
    'tap="${RUNGATE_API_TAP:-}"',
    '[ -n "$tap" ] || exec "$real" "$@"',
    'err="$(mktemp "${TMPDIR:-/tmp}/gh-tap.XXXXXX")" || exec "$real" "$@"',
    "# Who asked: scripts/api-call-tap.ts hands every child the caller it read.",
    'from="$(printf %s "${RUNGATE_API_TAP_FROM:--}" | tr -s " \\t" "__")"',
    'GH_DEBUG=1 "$real" "$@" 2>"$err"',
    "status=$?",
    'while IFS= read -r line || [ -n "$line" ]; do',
    '  case "$line" in',
    `    "* Request to "*) printf 'API-TAP gh - %s from=%s\\n' "\${line#\\* Request to }" "$from" >> "$tap" ;;`,
    '    "* Request at "*|"* Request took "*|"[git "*|"[]") ;;',
    "    *) printf '%s\\n' \"$line\" >&2 ;;",
    "  esac",
    'done < "$err"',
    'rm -f "$err"',
    "exit $status",
    "",
  ].join("\n");
}

function refuse(message: string): never {
  console.error(`UNMEASURED: ${message}`);
  process.exit(CENSUS_UNMEASURED_EXIT);
}

function installGhTap(dir: string, realGhArg: string | undefined): void {
  const target = resolve(dir);
  const found = realGhArg ?? Bun.which("gh") ?? undefined;
  if (!found) refuse("gh is not on PATH, so there is no gh to tap");
  const realGh = realpathSync(found);
  if (dirname(realGh) === realpathSync(existsSync(target) ? target : dirname(target))) {
    refuse(`the gh found (${realGh}) is the tap itself; pass --real-gh <path>`);
  }
  mkdirSync(target, { recursive: true });
  const shim = join(target, "gh");
  writeFileSync(shim, ghTapScript(realGh));
  chmodSync(shim, 0o755);
  console.log(`gh tap written to ${shim}, running ${realGh}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const tapAt = args.indexOf("--install-gh-tap");
  if (tapAt >= 0) {
    const dir = args[tapAt + 1];
    if (!dir || dir.startsWith("--")) refuse("--install-gh-tap needs a directory");
    const realAt = args.indexOf("--real-gh");
    installGhTap(dir, realAt >= 0 ? args[realAt + 1] : undefined);
    process.exit(0);
  }
  const json = args.includes("--json");
  const files = args.filter(a => !a.startsWith("--"));
  if (files.length === 0) refuse("name at least one record or CI job log to count");
  if (args.includes("--runs")) {
    let counted: RunCount;
    try {
      counted = countRuns(readFileSync(files[0], "utf-8"));
    } catch (e) {
      refuse(`${files[0]}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
    if (counted.total === 0) refuse(`${files[0]}: no runs in the list, which cannot be told from a query that returned nothing`);
    if (json) console.log(JSON.stringify(counted, null, 2));
    else {
      console.log(`${counted.total} runs across ${counted.workflows.length} workflows`);
      for (const w of counted.workflows) {
        console.log(`  ${String(w.runs).padStart(4)}  ${w.name}  (${Object.entries(w.by).map(([k, n]) => `${k} ${n}`).join(", ")})`);
      }
    }
    process.exit(0);
  }
  if (args.includes("--model")) {
    const rows = files.map(f => {
      let text: string;
      try {
        text = readFileSync(f, "utf-8");
      } catch (e) {
        refuse(`${f}: unreadable (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`);
      }
      return { log: f, run: readModelRun(text) };
    });
    console.log(json ? JSON.stringify(rows, null, 2) : renderModelRuns(rows));
    process.exit(0);
  }
  const readings: TapReading[] = files.map(f => {
    let text: string;
    try {
      text = readFileSync(f, "utf-8");
    } catch (e) {
      return { status: "unmeasured", reason: `${f}: unreadable (${e instanceof Error ? e.message.split("\n")[0] : String(e)})` };
    }
    const r = readTap(text);
    return r.status === "unmeasured" ? { status: "unmeasured", reason: `${f}: ${r.reason}` } : r;
  });
  const census = countCalls(readings);
  console.log(json ? JSON.stringify(census, null, 2) : renderCensus(census));
  if (census.unmeasured.length > 0) process.exit(CENSUS_UNMEASURED_EXIT);
}
