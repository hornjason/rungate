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
 * printed `UNMEASURED` with why, never folded into "nothing owed", and the
 * all-clear names what it measured rather than saying "done".
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { createGitHubClient, parseOwnerRepo } from "../github";
import { githubProtectionProbe, jobContextNames, type ProtectionFacts, type ProtectionProbe } from "../branch-protection";
import { originSlug } from "../verified-push";

export type Reading<T> = { kind: "READ"; value: T } | { kind: "UNMEASURED"; why: string };

export const PROJECT_TOKEN_SECRET = "RUNGATE_PROJECT_TOKEN";
export const REQUIRE_CLOSING_REF_VARIABLE = "RUNGATE_REQUIRE_CLOSING_REF";

/** The process workflows whose jobs report a status on pull requests (ADR-014 decision 6's scope). */
export const PROCESS_CHECK_WORKFLOWS = ["closing-references.yml"] as const;

export interface HumanStepReadings {
  /** `owner/name`, or null when the origin remote names no GitHub repository. */
  slug: string | null;
  secretPresent: Reading<boolean>;
  /** The variable's value, or null when it is not set. */
  requireClosingRef: Reading<string | null>;
  /** The default branch, its required status checks, and which protection state it is in. */
  protection: Reading<{ branch: string; contexts: string[]; statusChecks: NonNullable<ProtectionFacts["statusChecks"]> }>;
  /** Job names of the process checks this tree's workflows define. */
  processChecks: string[];
}

/** One line per step owed or unread, then a line saying what was measured. Pure. */
export function humanSteps(r: HumanStepReadings): string[] {
  if (r.slug === null) {
    return [
      "UNMEASURED: human steps — the origin remote names no GitHub repository, so the project token, " +
        `${REQUIRE_CLOSING_REF_VARIABLE} and the required checks were not read.`,
    ];
  }
  const out: string[] = [];
  const measured: string[] = [];
  if (r.secretPresent.kind === "UNMEASURED") out.push(`UNMEASURED: ${PROJECT_TOKEN_SECRET} — ${r.secretPresent.why}`);
  else if (!r.secretPresent.value) {
    out.push(
      `OWED: gh secret set ${PROJECT_TOKEN_SECRET} -R ${r.slug}   # a token that can write the project board; every board step refuses without it`,
    );
  } else measured.push(`${PROJECT_TOKEN_SECRET} is set`);

  if (r.requireClosingRef.kind === "UNMEASURED") {
    out.push(`UNMEASURED: ${REQUIRE_CLOSING_REF_VARIABLE} — ${r.requireClosingRef.why}`);
  } else if (r.requireClosingRef.value !== "true") {
    out.push(
      `OWED: gh variable set ${REQUIRE_CLOSING_REF_VARIABLE} -R ${r.slug} --body true   # closing-references refuses instead of warning`,
    );
  } else measured.push(`${REQUIRE_CLOSING_REF_VARIABLE} is true`);

  if (r.processChecks.length > 0) {
    if (r.protection.kind === "UNMEASURED") {
      out.push(`UNMEASURED: required checks (${r.processChecks.join(", ")}) — ${r.protection.why}`);
    } else {
      const { branch, contexts, statusChecks } = r.protection.value;
      const missing = r.processChecks.filter(c => !contexts.includes(c));
      if (missing.length > 0 && statusChecks === "required-checks") {
        for (const check of missing) {
          out.push(
            `OWED: gh api -X POST repos/${r.slug}/branches/${branch}/protection/required_status_checks/contexts ` +
              `-f 'contexts[]=${check}'   # ${check} runs on every pull request and blocks nothing until it is required`,
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
          `OWED: gh api -X PUT repos/${r.slug}/branches/${branch}/protection --input - <<<'${JSON.stringify(body)}'` +
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
      const required = r.processChecks.filter(c => contexts.includes(c));
      if (required.length > 0) measured.push(`${required.join(", ")} required on ${branch}`);
    }
  }

  if (out.length === 0) out.push(`Human steps: none owed — measured: ${measured.join("; ")}.`);
  return out;
}

/** The job names of the process checks present in `root`'s workflows. */
export function processChecksIn(root: string): string[] {
  return PROCESS_CHECK_WORKFLOWS.flatMap(file => {
    const p = join(root, ".github", "workflows", file);
    return existsSync(p) ? jobContextNames(readFileSync(p, "utf-8")) : [];
  });
}

export interface HumanStepProbes {
  slug: (root: string) => string | null;
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
  slug: root => originSlug(root),
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
  const slug = probes.slug(root);
  const processChecks = processChecksIn(root);
  if (slug === null) {
    const none = { kind: "UNMEASURED", why: "no repository" } as const;
    return { slug, secretPresent: none, requireClosingRef: none, protection: none, processChecks };
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
  return { slug, secretPresent, requireClosingRef, protection, processChecks };
}
