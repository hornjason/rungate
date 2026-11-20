/**
 * The human steps a scaffold cannot take, printed as one command each —
 * #2051, ADR-014 row 6, SC-2749.
 *
 * The scaffold writes files. Three things the process needs are settings on
 * GitHub that only a person with the right access can make, and nothing told
 * a consumer they were owed:
 *
 * 1. the `RUNGATE_PROJECT_TOKEN` secret — every board step refuses without it;
 * 2. the `RUNGATE_REQUIRE_CLOSING_REF` variable set to `true` — without it
 *    `closing-references` warns instead of refusing;
 * 3. every process check that runs on pull requests but is not REQUIRED on
 *    the default branch — a check nobody requires blocks nothing.
 *
 * Each is read where the API allows it. A reading that could not be taken is
 * printed `UNMEASURED` with why, never folded into "nothing owed".
 *
 * #2485, ADR-023, SC-2793: the report ends with one line about the project
 * board — `board.id` not set is an OWED `board-init`, and with a board set it
 * says whether the project token can write it. That row is never "done":
 * GitHub never returns a secret's value, so no scaffold run can try the token,
 * and the line gives the read-only check a person holding the token can run.
 * So the report has no all-clear any more; it ended in "none owed — measured:
 * …", which a board row that is always present would have contradicted.
 */
import { spawnSync } from "child_process";
import { readFileSync, statSync } from "fs";
import { join } from "path";

import { readBoardProjectId } from "../config-readers";
import { createGitHubClient, parseOwnerRepo } from "../github";
import { githubProtectionProbe, jobContextNames, type ProtectionFacts, type ProtectionProbe } from "../branch-protection";
import { parseRemoteSlug } from "../verified-push";

export type Reading<T> = { kind: "READ"; value: T } | { kind: "UNMEASURED"; why: string };

export const PROJECT_TOKEN_SECRET = "RUNGATE_PROJECT_TOKEN";
export const REQUIRE_CLOSING_REF_VARIABLE = "RUNGATE_REQUIRE_CLOSING_REF";

/** The process workflows whose jobs report a status on pull requests (ADR-014 decision 6's scope). */
export const PROCESS_CHECK_WORKFLOWS = ["closing-references.yml"] as const;

/**
 * Generated checks that must pass before a merge, one context each, owed only
 * when the workflow defines that job (#2361). rungate's own `main` requires
 * `test` and `ai-review` beside `closing-references`; GitHub's auto-merge, and
 * any approve-on-green bot, waits only for checks branch protection requires,
 * so a consumer that never required `ai-review` merged a PR mid-review. Named
 * rather than every job of the workflow: `ci.yml`'s `test-shard` is a matrix
 * whose contexts are not one name, and `test` is the job that speaks for them.
 */
export const MERGE_GATE_CHECKS = [
  { workflow: "ci.yml", context: "test" },
  { workflow: "ai-review.yml", context: "ai-review" },
] as const;

/** The command that makes a consumer's board and writes `board.id` (SC-2789). It writes nothing without `--write`. */
export const BOARD_INIT_COMMAND = 'env -u GH_TOKEN GITHUB_TOKEN="$(env -u GH_TOKEN gh auth token)" bunx rungate board-init --write';

export interface HumanStepReadings {
  /** `owner/name`; null when the origin remote names no GitHub repository; UNMEASURED when it could not be read (#2169). */
  slug: Reading<string | null>;
  /** `board.id` from the rungate config; null when none is set (SC-2793). */
  boardId: Reading<string | null>;
  secretPresent: Reading<boolean>;
  /** The variable's value, or null when it is not set. */
  requireClosingRef: Reading<string | null>;
  /** The default branch, its required status checks, and which protection state it is in. */
  protection: Reading<{ branch: string; contexts: string[]; statusChecks: NonNullable<ProtectionFacts["statusChecks"]> }>;
  /** Job names of the process checks this tree's workflows define. */
  processChecks: string[];
  /** Process workflows present but unreadable, each with why (#2161). */
  unreadableWorkflows: string[];
}

/**
 * The project board's row (SC-2793): whether `board.id` is set, and whether
 * the project token can write that board. Always exactly one line, never done.
 */
function boardRow(boardId: Reading<string | null>, secretPresent: Reading<boolean>, noRepository?: string): string {
  if (boardId.kind === "UNMEASURED") {
    return `UNMEASURED: the project board — board.id could not be read (${boardId.why}), so whether ${PROJECT_TOKEN_SECRET} can write it was not asked`;
  }
  // board.id is read from the local config, so it is reported even with no
  // GitHub repository; only the parts that need one say why they are not read
  // (review of #2529). `noRepository` is either a confirmed absence or an
  // origin that could not be read, so these lines never assert there is no
  // repository: they say what was not done, and its reason says why.
  if (noRepository !== undefined) {
    return boardId.value === null
      ? `UNMEASURED: the project board — board.id is not set, and ${noRepository}, so no board-init command is given: it makes the board for the origin's GitHub repository`
      : `UNMEASURED: whether ${PROJECT_TOKEN_SECRET} can write board ${boardId.value} — ${noRepository}, so the secret was not read`;
  }
  if (boardId.value === null) {
    return (
      `OWED: ${BOARD_INIT_COMMAND}   # board.id is not set: this makes the project board and writes board.id, ` +
      `and the next scaffold asks whether ${PROJECT_TOKEN_SECRET} can write it`
    );
  }
  const id = boardId.value;
  const head = `UNMEASURED: whether ${PROJECT_TOKEN_SECRET} can write board ${id}`;
  if (secretPresent.kind === "UNMEASURED") return `${head} — the secret could not be read (${secretPresent.why}), so it is not known that there is a token to ask about`;
  if (!secretPresent.value) return `${head} — no ${PROJECT_TOKEN_SECRET} is set, so there is no token to ask about`;
  return (
    `${head} — GitHub never returns a secret's value, so scaffold cannot try it. With the token in hand: ` +
    `GH_TOKEN=<the token> gh api graphql -f query='query($id: ID!) { node(id: $id) { ... on ProjectV2 { viewerCanUpdate } } }' -f id=${id}` +
    `   # true means it can write the board; a board an organisation owns needs a token with that organisation's project scope`
  );
}

/** One line per step owed or unread, ending with the project board's row. Pure. */
export function humanSteps(r: HumanStepReadings): string[] {
  const unreadWorkflows = r.unreadableWorkflows.map(why => `UNMEASURED: process checks — ${why}`);
  if (r.slug.kind === "UNMEASURED" || r.slug.value === null) {
    const why =
      r.slug.kind === "UNMEASURED"
        ? `the origin remote could not be read (${r.slug.why})`
        : "the origin remote names no GitHub repository";
    return [
      `UNMEASURED: human steps — ${why}, so the project token, ` +
        `${REQUIRE_CLOSING_REF_VARIABLE} and the required checks were not read.`,
      // Read from the tree, not from GitHub, so it is owed whatever the remote is.
      ...unreadWorkflows,
      boardRow(r.boardId, r.secretPresent, why),
    ];
  }
  const slug = r.slug.value;
  const out: string[] = [];
  if (r.secretPresent.kind === "UNMEASURED") out.push(`UNMEASURED: ${PROJECT_TOKEN_SECRET} — ${r.secretPresent.why}`);
  else if (!r.secretPresent.value) {
    out.push(
      `OWED: gh secret set ${PROJECT_TOKEN_SECRET} -R ${slug}   # a token that can write the project board; every board step refuses without it`,
    );
  }

  if (r.requireClosingRef.kind === "UNMEASURED") {
    out.push(`UNMEASURED: ${REQUIRE_CLOSING_REF_VARIABLE} — ${r.requireClosingRef.why}`);
  } else if (r.requireClosingRef.value !== "true") {
    out.push(
      `OWED: gh variable set ${REQUIRE_CLOSING_REF_VARIABLE} -R ${slug} --body true   # closing-references refuses instead of warning`,
    );
  }

  out.push(...unreadWorkflows);

  if (r.processChecks.length > 0) {
    if (r.protection.kind === "UNMEASURED") {
      out.push(`UNMEASURED: required checks (${r.processChecks.join(", ")}) — ${r.protection.why}`);
    } else {
      const { branch, contexts, statusChecks } = r.protection.value;
      const missing = r.processChecks.filter(c => !contexts.includes(c));
      if (missing.length > 0 && statusChecks === "required-checks") {
        for (const check of missing) {
          out.push(
            `OWED: gh api -X POST repos/${slug}/branches/${branch}/protection/required_status_checks/contexts ` +
              `-f 'contexts[]=${check}'   # ${check} runs on every pull request and blocks nothing until it is required; a merge bot of your own must wait for it too`,
          );
        }
      } else if (missing.length > 0 && statusChecks === "unprotected") {
        // PUT replaces the whole rule, which is safe only because there is no
        // rule yet: it protects the branch and requires the missing checks.
        const body = {
          required_status_checks: { strict: false, contexts: missing },
          enforce_admins: null,
          required_pull_request_reviews: null,
          restrictions: null,
        };
        out.push(
          `OWED: gh api -X PUT repos/${slug}/branches/${branch}/protection --input - <<<'${JSON.stringify(body)}'` +
            `   # ${branch} is unprotected; this protects it and requires ${missing.join(", ")}, nothing else`,
        );
      } else if (missing.length > 0) {
        // Protected with no required checks: the POST above 404s here and a
        // PUT would replace the rule's other settings, so no single call is safe.
        out.push(
          `OWED: require ${missing.join(", ")} on ${branch} — in the repository's Settings → Branches, edit the rule ` +
            `for ${branch}, turn on "Require status checks to pass" and add ${missing.join(", ")}` +
            `   # no single API call adds a check here without replacing the rest of the rule`,
        );
      }
    }
  }

  out.push(boardRow(r.boardId, r.secretPresent));
  return out;
}

/**
 * Which contexts each workflow owes: `null` is every job in it, a set is only
 * those. Entries for one file MERGE — a second context is added, and an
 * all-jobs entry is never narrowed by a single-context one — so a workflow
 * that gains a second tracked job cannot silently drop the first (review of
 * #2362).
 */
export function wantedChecks(
  allJobs: readonly string[],
  gates: readonly { workflow: string; context: string }[],
): Map<string, Set<string> | null> {
  const wanted = new Map<string, Set<string> | null>();
  for (const f of allJobs) wanted.set(f, null);
  for (const g of gates) {
    const had = wanted.get(g.workflow);
    if (had === null) continue;
    wanted.set(g.workflow, new Set([...(had ?? []), g.context]));
  }
  return wanted;
}

/**
 * The job names of the process checks present in `root`'s workflows, and the
 * workflows that are present but could not be read (#2161). A directory, a
 * permission error or a file removed between the two calls throws on read;
 * that is a reading not taken, never a crash and never "nothing owed".
 */
export function processChecksIn(root: string): { checks: string[]; unreadable: string[] } {
  const checks: string[] = [];
  const unreadable: string[] = [];
  for (const [file, only] of wantedChecks(PROCESS_CHECK_WORKFLOWS, MERGE_GATE_CHECKS)) {
    const rel = `.github/workflows/${file}`;
    const p = join(root, ".github", "workflows", file);
    // The stat decides absence, and only its ENOENT counts: existsSync also
    // answers false for an untraversable directory (round 2 of PR #2162).
    // The read gets its own try, so a file removed after the stat is a reading
    // not taken rather than an absent workflow (round 3).
    try {
      statSync(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      unreadable.push(`${rel} could not be read (${(e as Error).message})`);
      continue;
    }
    try {
      const jobs = jobContextNames(readFileSync(p, "utf-8"));
      checks.push(...(only === null ? jobs : jobs.filter(j => only.has(j))));
    } catch (e) {
      unreadable.push(`${rel} could not be read (${(e as Error).message})`);
    }
  }
  return { checks, unreadable };
}

/**
 * `owner/name` when `url` is a github.com remote, else `null` (#2161).
 *
 * The GitHub client only ever talks to github.com (`lib/github.ts` refuses
 * any other API host), so a remote on another forge has no settings this
 * module can read. `parseRemoteSlug` deliberately ignores the host, because
 * repo identity is its question; which forge to ask is this one's.
 */
export function githubSlugOf(
  url: string,
  resolveSshHost: (host: string) => Reading<string | null> = sshHostName,
): Reading<string | null> {
  const none = { kind: "READ", value: null } as const;
  const trimmed = url.trim();
  if (!trimmed) return none;
  let host: string | null = null;
  let viaSsh = false;
  // A URL's slug comes from its path, so a port (`ssh.github.com:443`) cannot
  // be read as the owner; an scp-style remote has no port to confuse.
  let slug: () => string | null = () => parseRemoteSlug(trimmed);
  if (/^[a-z+]+:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return none; // not a URL at all, so it names no GitHub repository
    }
    host = parsed.hostname;
    viaSsh = /^(?:ssh|git\+ssh|ssh\+git):$/i.test(parsed.protocol);
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/").filter(Boolean);
    slug = () => (parts.length === 2 ? `${parts[0]}/${parts[1]}`.toLowerCase() : null);
  } else {
    host = trimmed.match(/^(?:[^@/]+@)?([^:/]+):/)?.[1] ?? null;
    viaSsh = host !== null;
  }
  if (host === null) return none;
  const literal = host.toLowerCase();
  // A GitHub host spelled literally is accepted before asking ssh, so a
  // `Host` block rewriting its HostName cannot refuse it, and a machine with
  // no ssh can still read it. Over ssh that is both of GitHub's SSH hosts
  // (review round 2 of PR #2187); over https it is github.com alone.
  if (viaSsh ? GITHUB_SSH_HOSTS.has(literal) : literal === "github.com") return { kind: "READ", value: slug() };
  // An scp-style or ssh:// host may be an alias in ~/.ssh/config
  // (`Host github.com-work` / `HostName github.com`), so ssh decides what it
  // names (#2169). An https host is a DNS name, so it stays a literal compare
  // and a lookalike is still refused.
  if (!viaSsh) return none;
  // The host as written: OpenSSH matches `Host` patterns case-sensitively, so a
  // lowercased `GitHub-Perso` misses its own stanza (review round 3 of PR #2187).
  const resolved = resolveSshHost(host);
  // ssh missing or timed out says nothing about whether the host is GitHub
  // (review of PR #2187), so it is UNMEASURED, never "no GitHub repository".
  if (resolved.kind === "UNMEASURED") return { kind: "UNMEASURED", why: `its host ${host} could not be resolved: ${resolved.why}` };
  const named = resolved.value?.toLowerCase();
  return { kind: "READ", value: named !== undefined && GITHUB_SSH_HOSTS.has(named) ? slug() : null };
}

/** The hosts GitHub serves git over SSH on: the usual one, and the port-443 one its docs give for blocked networks. */
const GITHUB_SSH_HOSTS = new Set(["github.com", "ssh.github.com"]);

/** What `spawnSync` reports, narrowed to what the reads below look at, so a failed read can be tested. */
export type RunResult = { status: number | null; stdout: string; error?: Error; signal?: NodeJS.Signals | null };
export type Run = (cmd: string, args: string[], cwd?: string) => RunResult;
const runLive: Run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: "utf-8", timeout: 5000 });

/**
 * The host `ssh -G` resolves `host` to (its `hostname` line). A host that could
 * be read as an option never reaches ssh and names nothing. ssh missing, the
 * timeout, a non-zero exit or no hostname line is a reading not taken.
 */
export function sshHostName(host: string, run: Run = runLive): Reading<string | null> {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(host)) return { kind: "READ", value: null };
  const r = run("ssh", ["-G", host]);
  if (r.error) return { kind: "UNMEASURED", why: `ssh -G ${host} could not run (${r.error.message})` };
  if (r.status !== 0) {
    const how = r.status === null ? `was stopped${r.signal ? ` by ${r.signal}` : ""}` : `exited ${r.status}`;
    return { kind: "UNMEASURED", why: `ssh -G ${host} ${how}` };
  }
  const name = r.stdout.match(/^hostname (\S+)$/m)?.[1];
  return name ? { kind: "READ", value: name } : { kind: "UNMEASURED", why: `ssh -G ${host} printed no hostname line` };
}

/**
 * The configured `origin` url of `root` (#2169). `""` only when git ran and
 * said none is configured: `git config --get` exits 1 for an absent key. Git
 * missing, a root that does not exist, the timeout, or any other exit is a
 * reading not taken, never "no repository".
 */
export function readOrigin(root: string, run: Run = runLive): Reading<string> {
  const r = run("git", ["config", "--get", "remote.origin.url"], root);
  if (r.error) return { kind: "UNMEASURED", why: `git could not read it (${r.error.message})` };
  if (r.status === 0) return { kind: "READ", value: r.stdout };
  if (r.status === 1) return { kind: "READ", value: "" };
  const why = r.status === null ? `git was stopped${r.signal ? ` by ${r.signal}` : ""} before it answered` : `git exited ${r.status}`;
  return { kind: "UNMEASURED", why };
}

/**
 * `board.id` for `root`, decided by `readBoardProjectId` (the reader
 * work-status and board-ready use). A config that cannot be read is
 * UNMEASURED with why, never "no board". An id that is not a node id's shape
 * is refused rather than printed into a command a person will paste.
 */
export function readBoardId(root: string): Reading<string | null> {
  let id: string | null;
  try {
    id = readBoardProjectId(root);
  } catch (e) {
    return { kind: "UNMEASURED", why: `the rungate config could not be read (${(e as Error).message})` };
  }
  if (id !== null && !/^[A-Za-z0-9_-]+$/.test(id)) return { kind: "UNMEASURED", why: `board.id ${JSON.stringify(id)} is not a project node id` };
  return { kind: "READ", value: id };
}

export interface HumanStepProbes {
  slug: (root: string) => Reading<string | null>;
  boardId: (root: string) => Reading<string | null>;
  secret: (slug: string) => Promise<Reading<boolean>>;
  variable: (slug: string) => Promise<Reading<string | null>>;
  protection: ProtectionProbe;
}

/** The same bound the protection probe puts on each GET: a hung socket is UNMEASURED, never a hung scaffold. */
export const PROBE_TIMEOUT_MS = 15_000;

/** `p`, or a rejection naming `what` after `ms`. The rejection carries no status, so it reads UNMEASURED. */
export function timed<T>(p: Promise<T>, what: string, ms: number = PROBE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

const status = (e: unknown) => (e as { status?: unknown })?.status;
const why = (e: unknown) => `${typeof status(e) === "number" ? `HTTP ${status(e)}: ` : ""}${(e as Error)?.message ?? e}`;

/** The live reads: two GETs here, three in the protection probe. No writes. */
export const LIVE_PROBES: HumanStepProbes = {
  boardId: readBoardId,
  slug: root => {
    const origin = readOrigin(root);
    return origin.kind === "READ" ? githubSlugOf(origin.value) : origin;
  },
  secret: async slug => {
    try {
      const { owner, repo } = parseOwnerRepo(slug);
      await timed(
        createGitHubClient().rest.actions.getRepoSecret({ owner, repo, secret_name: PROJECT_TOKEN_SECRET }),
        `GET the ${PROJECT_TOKEN_SECRET} secret`,
      );
      return { kind: "READ", value: true };
    } catch (e) {
      // 404 is the documented answer for an absent secret; anything else —
      // no credential, 403 for a token without admin — is not a reading.
      return status(e) === 404 ? { kind: "READ", value: false } : { kind: "UNMEASURED", why: why(e) };
    }
  },
  variable: async slug => {
    try {
      const { owner, repo } = parseOwnerRepo(slug);
      const r = await timed(
        createGitHubClient().rest.actions.getRepoVariable({ owner, repo, name: REQUIRE_CLOSING_REF_VARIABLE }),
        `GET the ${REQUIRE_CLOSING_REF_VARIABLE} variable`,
      );
      return { kind: "READ", value: String(r.data?.value ?? "") };
    } catch (e) {
      return status(e) === 404 ? { kind: "READ", value: null } : { kind: "UNMEASURED", why: why(e) };
    }
  },
  protection: githubProtectionProbe,
};

/** Read everything {@link humanSteps} needs for `root`. */
export async function readHumanSteps(root: string, probes: HumanStepProbes = LIVE_PROBES): Promise<HumanStepReadings> {
  const origin = probes.slug(root);
  const boardId = probes.boardId(root);
  const { checks: processChecks, unreadable: unreadableWorkflows } = processChecksIn(root);
  const slug = origin.kind === "READ" ? origin.value : null;
  if (slug === null) {
    const none = { kind: "UNMEASURED", why: "no repository" } as const;
    return { slug: origin, boardId, secretPresent: none, requireClosingRef: none, protection: none, processChecks, unreadableWorkflows };
  }
  const [secretPresent, requireClosingRef, facts] = await Promise.all([
    probes.secret(slug),
    probes.variable(slug),
    probes.protection(slug),
  ]);
  const protection: HumanStepReadings["protection"] =
    facts.unreadable || facts.branch === null
      ? { kind: "UNMEASURED", why: facts.unreadable ?? "the default branch could not be read" }
      : facts.statusChecks === undefined
        ? { kind: "UNMEASURED", why: "the protection probe did not say whether the branch is protected" }
        : { kind: "READ", value: { branch: facts.branch, contexts: facts.contexts, statusChecks: facts.statusChecks } };
  return { slug: origin, boardId, secretPresent, requireClosingRef, protection, processChecks, unreadableWorkflows };
}
