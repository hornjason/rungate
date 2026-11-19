/**
 * Undone work declared in a repository's prose that no open issue covers (#2100).
 *
 * #1953 (PR #2096) built the structured half: `board-conformance`'s
 * `declared-work` reading covers unticked criteria and open stage items. This
 * is the prose half: a TODO, a "we need to", a priority paragraph, a fact kept
 * only in agent memory.
 *
 * RunGate ships to consumers, and a consumer repository has no stages and
 * usually no plan file or agent memory. So sources are DISCOVERED from what the
 * repository contains, never typed into a list. A source that is not there is
 * ABSENT, a source that is there but cannot be read is UNMEASURED, and neither
 * is ever reported as zero.
 *
 * A declaration is accounted for only when it cites an issue that is open now.
 * It errs toward reporting too much: a false positive costs a glance, while a
 * false negative is the defect itself and cannot be seen. So a citation whose
 * state could not be read is not credited.
 */
import { spawnSync } from "child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

export type SourceName = "tracked-files" | "plan-file" | "agent-memory" | "pr-bodies";

export interface Declaration {
  source: SourceName;
  /** Relative to the root for repository sources; absolute for agent memory, which lives outside it. */
  path: string;
  line: number;
  text: string;
  cites: number[];
}

export type SourceReading =
  | { source: SourceName; kind: "READ"; declarations: Declaration[]; unreadable: string[]; files: number }
  | { source: SourceName; kind: "ABSENT"; why: string }
  | { source: SourceName; kind: "UNMEASURED"; why: string };

/** The phrases that declare undone work. Matched per line. */
export const PROSE_MARKERS: readonly RegExp[] = [/\bTODO\b/, /\bFIXME\b/, /\bwe need to\b/i, /\bnot yet built\b/i];

/** The plan file a repository may carry. Read by its own source, so the tracked-file scan skips it. */
export const PLAN_FILE = "project-state.json";

/**
 * `#N` standing alone: not `page#14`, not `&#15;`. At most nine digits, so every
 * value is a GraphQL `Int` (32-bit) and one hash-prefixed id cannot fail the batched
 * issue-state query for every real citation (review round 3 of PR #2188).
 */
export function citationsIn(text: string): number[] {
  return [...text.matchAll(/(?<![\w&/#])#(\d{1,9})\b(?!;)/g)].map(m => Number(m[1]));
}

/**
 * Control characters out, then at most 160 characters. A pull request body is
 * written by whoever opened the PR, and the report prints it to a terminal, so
 * an escape sequence in it must not reach one (#2489, security review).
 */
export const clip = (s: string) => {
  const safe = s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "\uFFFD");
  return safe.length > 160 ? `${safe.slice(0, 157)}...` : safe;
};

/** Who may add a line to the report through an OPEN pull request: people with a say in the repository. */
export const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * The open pull requests whose author has a say in the repository (#2489,
 * security review). A merged PR was merged by a maintainer, so its body is
 * read whoever wrote it. An open one from a stranger is not read, or anyone
 * could make this command report work by opening a PR.
 */
export function trustedOpen<T extends { author_association?: string }>(items: readonly T[]): T[] {
  return items.filter(i => TRUSTED_ASSOCIATIONS.has(i.author_association ?? ""));
}

/**
 * The markers read in a pull request body (#2489): the prose markers, plus the
 * two ways an agent writes down work it could not file at the time. Kept off
 * the tracked-file scan, where "not done" is ordinary prose.
 */
export const PR_BODY_MARKERS: readonly RegExp[] = [...PROSE_MARKERS, /\bnot (?:yet )?filed\b/i, /\bnot done\b/i];

/** Every line of `text` carrying a marker. */
export function declarationsIn(
  text: string,
  path: string,
  source: SourceName,
  markers: readonly RegExp[] = PROSE_MARKERS,
): Declaration[] {
  const out: Declaration[] = [];
  text.split("\n").forEach((line, i) => {
    if (markers.some(re => re.test(line))) {
      out.push({ source, path, line: i + 1, text: clip(line.trim()), cites: citationsIn(line) });
    }
  });
  return out;
}

const looksBinary = (b: Buffer) => b.subarray(0, 8000).includes(0);

/** Read `abs`, or say why not; `null` text for a binary file, which holds no prose. */
function readProse(abs: string): { text: string | null } | { why: string } {
  try {
    const buf = readFileSync(abs);
    return { text: looksBinary(buf) ? null : buf.toString("utf-8") };
  } catch (e) {
    return { why: (e as Error).message };
  }
}

/** Every file git tracks in `root`. A file list that cannot be read is UNMEASURED. */
export function trackedFilesSource(root: string): SourceReading {
  const source = "tracked-files";
  const r = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf-8", timeout: 30_000, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) return { source, kind: "UNMEASURED", why: `git ls-files could not run (${r.error.message})` };
  if (r.status !== 0) return { source, kind: "UNMEASURED", why: `git ls-files exited ${r.status}: ${(r.stderr ?? "").trim()}` };
  const files = r.stdout.split("\0").filter(Boolean);
  const declarations: Declaration[] = [];
  const unreadable: string[] = [];
  for (const rel of files) {
    if (rel === PLAN_FILE) continue;
    const abs = join(root, rel);
    let st;
    try {
      st = lstatSync(abs);
    } catch (e) {
      unreadable.push(`${rel} could not be read (${(e as Error).message})`);
      continue;
    }
    // A symlink points at content tracked elsewhere, or outside; a directory is a submodule.
    if (!st.isFile()) continue;
    const read = readProse(abs);
    if ("why" in read) unreadable.push(`${rel} could not be read (${read.why})`);
    else if (read.text !== null) declarations.push(...declarationsIn(read.text, rel, source));
  }
  return { source, kind: "READ", declarations, unreadable, files: files.length };
}

/**
 * The plan file's `priorities`. Each one states work, so each is a declaration,
 * placed at the line where its text starts.
 */
export function planFileSource(root: string): SourceReading {
  const source = "plan-file";
  const abs = join(root, PLAN_FILE);
  if (!existsSync(abs)) return { source, kind: "ABSENT", why: `no ${PLAN_FILE}` };
  let raw: string;
  let parsed: unknown;
  try {
    raw = readFileSync(abs, "utf-8");
    parsed = JSON.parse(raw);
  } catch (e) {
    return { source, kind: "UNMEASURED", why: `${PLAN_FILE} could not be read (${(e as Error).message})` };
  }
  const priorities = (parsed as { priorities?: unknown })?.priorities;
  // No key is ABSENT; a key holding something else is a source present and
  // unreadable, never zero (review round 4 of PR #2188).
  if (priorities === undefined) return { source, kind: "ABSENT", why: `${PLAN_FILE} has no priorities` };
  if (!Array.isArray(priorities)) return { source, kind: "UNMEASURED", why: `${PLAN_FILE}'s priorities is not an array` };
  // A JSON-aware walk rather than a text search: an object-valued priority
  // never appears in the file as its compact stringification, and a search
  // slice can cut an escape in half (review of PR #2188). A walk that cannot
  // place every entry says so; it never prints line 0 as a location.
  const lines = arrayElementLines(raw, "priorities");
  if (lines === null || lines.length !== priorities.length) {
    const found = lines === null ? "no top-level priorities array" : `${lines.length} element(s) for ${priorities.length}`;
    return { source, kind: "UNMEASURED", why: `${PLAN_FILE}'s priorities could not be placed by line (${found})` };
  }
  const declarations = priorities.map((p, i): Declaration => {
    const text = typeof p === "string" ? p : JSON.stringify(p);
    return { source, path: PLAN_FILE, line: lines[i]!, text: clip(text), cites: citationsIn(text) };
  });
  return { source, kind: "READ", declarations, unreadable: [], files: 1 };
}

/**
 * The line each element of the top-level array `key` starts on, from a walk
 * that tracks strings, escapes and depth; `null` when there is no such array.
 * A raw newline cannot occur inside a JSON string, so counting every `\n`
 * counts lines.
 */
export function arrayElementLines(raw: string, key: string): number[] | null {
  let depth = 0;
  let line = 1;
  let inString = false;
  let stringStart = -1;
  let lastKey: string | null = null;
  let afterKeyColon = false;
  let inArray = false;
  let expectElement = false;
  const lines: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === "\n") line++;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') {
        inString = false;
        if (depth === 1 && !inArray) lastKey = raw.slice(stringStart + 1, i);
      }
      continue;
    }
    if (/\s/.test(c)) continue;
    if (expectElement && c !== "]") {
      lines.push(line);
      expectElement = false;
    }
    if (c === '"') {
      inString = true;
      stringStart = i;
    } else if (c === ":") {
      afterKeyColon = depth === 1 && lastKey === key;
      continue;
    } else if (c === "{" || c === "[") {
      depth++;
      if (afterKeyColon && c === "[" && depth === 2) {
        inArray = true;
        expectElement = true;
      }
    } else if (c === "}" || c === "]") {
      if (inArray && depth === 2 && c === "]") return lines;
      depth--;
    } else if (c === "," && inArray && depth === 2) {
      expectElement = true;
    }
    afterKeyColon = false;
  }
  return null;
}

/** Where Claude Code keeps agent memory for a session launched in `root`. */
export function memoryDirFor(root: string, home: string): string {
  return join(home, ".claude", "projects", root.replace(/[^A-Za-z0-9]/g, "-"), "memory");
}

/** The markdown files in this root's agent memory, which live outside the repository. */
export function agentMemorySource(root: string, home: string): SourceReading {
  const source = "agent-memory";
  const dir = memoryDirFor(root, home);
  if (!existsSync(dir)) return { source, kind: "ABSENT", why: `no agent memory at ${dir}` };
  let names: string[];
  try {
    names = readdirSync(dir).filter(n => n.endsWith(".md") && n !== "MEMORY.md");
  } catch (e) {
    return { source, kind: "UNMEASURED", why: `${dir} could not be listed (${(e as Error).message})` };
  }
  const declarations: Declaration[] = [];
  const unreadable: string[] = [];
  for (const name of names) {
    const abs = join(dir, name);
    const read = readProse(abs);
    if ("why" in read) unreadable.push(`${abs} could not be read (${read.why})`);
    else if (read.text !== null) declarations.push(...declarationsIn(read.text, abs, source));
  }
  return { source, kind: "READ", declarations, unreadable, files: names.length };
}

/** One pull request's number and body, as GitHub returns them. A PR with no description has a null body. */
export interface PrBody {
  number: number;
  body: string | null;
}

/**
 * Pull request bodies as a source (#2489). The PRs are fetched by the command
 * (`--since`, or `--prs-fixture` in tests), so this only turns the reading it
 * is handed into declarations, each placed at `PR #N` and its line in the body.
 * Not reading them is ABSENT, and a read that failed is UNMEASURED, both with
 * the reason; neither is a zero.
 */
export function prBodiesSource(
  read: { prs: readonly PrBody[] } | { kind: "ABSENT" | "UNMEASURED"; why: string },
): SourceReading {
  const source = "pr-bodies";
  if ("kind" in read) return { source, kind: read.kind, why: read.why };
  const declarations = read.prs.flatMap(pr =>
    pr.body ? declarationsIn(pr.body, `PR #${pr.number}`, source, PR_BODY_MARKERS) : [],
  );
  return { source, kind: "READ", declarations, unreadable: [], files: read.prs.length };
}

/** Every source this command knows how to discover, in report order. */
export function discoverSources(root: string, home: string): SourceReading[] {
  return [trackedFilesSource(root), planFileSource(root), agentMemorySource(root, home)];
}

/** The open/closed state of each cited number, or why it could not be read. */
export type IssueStates = { kind: "READ"; open: ReadonlySet<number> } | { kind: "UNMEASURED"; why: string };

/** Accounted for only by an issue that is open now. An unread state credits nothing. */
export function isAccounted(d: Declaration, states: IssueStates): boolean {
  return states.kind === "READ" && d.cites.some(n => states.open.has(n));
}

export interface Report {
  root: string;
  sources: Array<{ source: SourceName; kind: SourceReading["kind"]; why?: string; files?: number; declarations?: number }>;
  issueStates: { kind: IssueStates["kind"]; why?: string; cited: number; open?: number };
  unaccounted: Declaration[];
  unmeasured: string[];
}

export function buildReport(root: string, sources: readonly SourceReading[], cited: readonly number[], states: IssueStates): Report {
  const all = sources.flatMap(s => (s.kind === "READ" ? s.declarations : []));
  const unmeasured = sources.flatMap(s =>
    s.kind === "UNMEASURED" ? [`${s.source} — ${s.why}`] : s.kind === "READ" ? s.unreadable.map(u => `${s.source} — ${u}`) : [],
  );
  // Whether or not anything cites an issue: an unreadable --issues-fixture is a
  // bad input, and dropping it when nothing cites is a refusal swallowed (review
  // round 2 of PR #2188). A live read only happens when something cites.
  if (states.kind === "UNMEASURED") unmeasured.push(`issue-states — ${states.why}`);
  return {
    root,
    sources: sources.map(s =>
      s.kind === "READ"
        ? { source: s.source, kind: s.kind, files: s.files, declarations: s.declarations.length }
        : { source: s.source, kind: s.kind, why: s.why },
    ),
    issueStates:
      states.kind === "READ"
        ? { kind: "READ", cited: cited.length, open: cited.filter(n => states.open.has(n)).length }
        : { kind: "UNMEASURED", why: states.why, cited: cited.length },
    unaccounted: all.filter(d => !isAccounted(d, states)),
    unmeasured,
  };
}

/** The distinct numbers cited across every source. */
export function citedNumbers(sources: readonly SourceReading[]): number[] {
  const set = new Set(sources.flatMap(s => (s.kind === "READ" ? s.declarations.flatMap(d => d.cites) : [])));
  return [...set].sort((a, b) => a - b);
}

export function renderReport(r: Report): string[] {
  const lines = [`unaccounted-work: ${r.root}`];
  for (const s of r.sources) {
    lines.push(
      s.kind === "READ"
        ? `  ${s.source}: READ — ${s.files} file(s), ${s.declarations} declaration(s)`
        : `  ${s.source}: ${s.kind} — ${s.why}`,
    );
  }
  const st = r.issueStates;
  lines.push(st.kind === "READ" ? `  issue-states: READ — ${st.cited} cited, ${st.open} open` : `  issue-states: UNMEASURED — ${st.why} (${st.cited} cited)`);
  lines.push(`UNACCOUNTED (${r.unaccounted.length}) — declared undone, citing no open issue:`);
  for (const d of r.unaccounted) {
    lines.push(`  ${d.path}:${d.line}  ${d.text}${d.cites.length ? `   [cites ${d.cites.map(n => `#${n}`).join(", ")}]` : ""}`);
  }
  for (const u of r.unmeasured) lines.push(`UNMEASURED: ${u}`);
  return lines;
}

/**
 * The open issues among `chunk` in one `repository { nN: issueOrPullRequest }`
 * page. A page with no `repository` (a wrong or renamed name, or one this token
 * cannot see) throws: it is a reading not taken, and reading it as "none open"
 * would report every citation as unaccounted (review round 5 of PR #2188).
 * A pull request, a missing number and a closed issue are not open.
 */
export function openIssuesInPage(data: unknown, chunk: readonly number[]): number[] {
  const repository = (data as { repository?: Record<string, unknown> | null } | null | undefined)?.repository;
  if (!repository) {
    throw new Error("the response carried no repository (a wrong or renamed name, or one this token cannot see)");
  }
  return chunk.filter(n => {
    const node = repository[`n${n}`] as { __typename?: string; state?: string } | null | undefined;
    return node?.__typename === "Issue" && node.state === "OPEN";
  });
}
