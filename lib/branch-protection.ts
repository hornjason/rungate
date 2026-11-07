/**
 * branch-protection.ts — PROTECT-1: does this repo's protection serialise
 * every swarm's PRs? (#909)
 *
 * `required_status_checks.strict` is GitHub's "Require branches to be up to
 * date before merging". Under it, merging PR #1 invalidates #2..#N: each then
 * needs `gh pr update-branch`, a full CI re-run, then a merge. Measured on a
 * real consumer on 2026-10-21 at **2.5 minutes per PR, strictly serial** — 18
 * open PRs, every one `BEHIND`, not one of them broken. A 30-PR swarm is ~90
 * minutes of serialisation during which the swarm opens more PRs, so it never
 * converges. #909 has the repo and the figures.
 *
 * It is the single biggest throughput limit on a RunGate consumer and it is
 * invisible from every direction a reviewer looks: each PR is individually
 * healthy, CI is green, nothing is red anywhere. The only place the cause is
 * visible is a repo setting nothing in the harness had ever read.
 *
 * ## Why the remedy is not one sentence
 *
 * The normal fix is a merge queue, which batches N PRs into one speculative
 * commit and tests once. **It is not available on a user-owned repo.** GitHub
 * restricts merge queues to organization-owned repositories, and private org
 * repos additionally need Enterprise Cloud. Measured the same day:
 *
 *     gh api repos/hornjason/pai-harness -q .owner.type   -> "User"
 *     POST /repos/hornjason/pai-harness/rulesets, merge_queue rule
 *       -> 422 Validation Failed, "Invalid rule 'merge_queue': "
 *
 * The identical ruleset without that one rule is accepted, so the 422 is
 * GitHub refusing on owner type rather than rejecting a malformed payload.
 * And the LEGACY branch-protection endpoint silently *ignores* a
 * `required_merge_queue` field, which is why this reads as "configured" to
 * anyone who sets it there and then checks for an error.
 *
 * So one message for both owner types would be the defect, not the feature:
 * on a user-owned repo "enable a merge queue" is advice that cannot be
 * followed, and a gate that refuses with an impossible remedy gets switched
 * off. Organization → merge queue. User → `strict: false`.
 *
 * ## Why `strict: false` is not advised unconditionally
 *
 * `strict: true` is doing one real job: catching the SEMANTIC conflict — two
 * PRs each green alone and broken together, which no textual merge conflict
 * reports. Turning it off is safe only when something else catches that, and
 * the something else is CI on `push:` to the default branch: the pair lands,
 * main goes red within minutes, and a human sees it.
 *
 * Without push-CI, `strict: false` removes the only check standing between a
 * swarm and a quietly broken default branch. This module therefore REFUSES to
 * recommend `strict: false` on a repo whose required contexts do not run on
 * push, and says that is why. Recommending it there would be this gate
 * causing the outage it exists to prevent.
 *
 * ## Reads. Never writes.
 *
 * Nothing here calls a mutating endpoint. A scaffold that silently rewrote a
 * repository's security settings would be a worse problem than the one it
 * fixes — the operator's next read of their own protection config would be a
 * reading of what a tool decided, with no record that it decided it. The
 * output is a refusal naming the setting, the cost and the exact remedy; the
 * change is the operator's.
 *
 * ## UNMEASURED is not a pass
 *
 * The protection endpoint needs admin on the repo, and the default Actions
 * token does not have it — so 403 is the ORDINARY outcome in a consumer's CI,
 * not an exotic one. If a 403 fell through to "no violations found", this
 * check would report clean on every repo it cannot see, which is the whole of
 * `.claude/rules/checks-must-be-able-to-fail.md`: `0`, `{}`, `null` and SKIP
 * are indistinguishable from success. Every unreadable path lands on
 * UNMEASURED with the cause named.
 *
 * The one thing that is NOT UNMEASURED is an unprotected branch. That is read
 * from `GET /repos/{owner}/{repo}/branches/{branch}`, which needs only read
 * access and returns `protected`, so "not protected" is a fact this check
 * establishes rather than a status code it has to guess at.
 *
 * That pre-call is load-bearing, and the measurement says so. Probing
 * `oven-sh/bun` on 2026-10-21 with a token that has no admin there:
 *
 *     GET /repos/oven-sh/bun/branches/main             -> protected: true
 *     GET /repos/oven-sh/bun/branches/main/protection  -> 404 Not Found
 *
 * **404, not 403.** The non-admin response is byte-identical to the response
 * for a branch with no protection at all. Asking the protection endpoint
 * first and reading its 404 as "nothing configured" would therefore report a
 * confident PASS on every repo the token cannot see into — which is this
 * check certifying the exact thing it exists to find.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

import { createGitHubClient, parseOwnerRepo, type GitHubClient } from "./github";
import { AI_REVIEW_THREADS_STEP_ID } from "./scaffold/ai-review-step";
import { originSlug } from "./verified-push";

// ── Facts ───────────────────────────────────────────────

/** What one reading of a repo's protection established. */
export interface ProtectionFacts {
  /** `owner/name` the facts are about. */
  slug: string;
  /** The default branch the protection was read for, or null when unknown. */
  branch: string | null;
  /**
   * `required_status_checks.strict`, or null when it could not be determined.
   *
   * `false` is a measured fact and includes the unprotected branch: nothing
   * is requiring anything, so nothing is serialising.
   */
  strict: boolean | null;
  /** `owner.type` — "User", "Organization", or whatever GitHub said. */
  ownerType: string | null;
  /** `required_status_checks.contexts`, in the order GitHub returned them. */
  contexts: string[];
  /**
   * Whether a merge queue is already in front of this branch, or null when
   * the payload said nothing either way.
   *
   * Honest about its own limits: the legacy protection endpoint is not a
   * reliable reporter of merge-queue state, which is the same quirk that made
   * `required_merge_queue` writes vanish. `null` therefore means "not
   * established", never "absent", and only an explicit `true` is allowed to
   * excuse `strict: true`.
   */
  mergeQueueEnabled: boolean | null;
  /**
   * `required_conversation_resolution`, or null when the payload said nothing
   * either way — CRC-C3, #1650.
   *
   * GitHub's native implementation of *a finding blocks merge until somebody
   * dispositions it*. It is the only protection setting that can read a
   * review thread, so it is the only one that can tell "this finding was
   * answered" from "nobody looked".
   *
   * **It regresses silently, and did.** The protection endpoint's `PUT`
   * replaces the whole object, so any update that omits this field turns it
   * off and reports success. It was read `true` on 2026-10-25 and behaved
   * that way through 2026-10-27 — three separate pull requests sat at
   * `BLOCKED` on one unresolved thread with every check green, and flipped to
   * `CLEAN` on resolving it. On 2026-11-07 it read `false`, and #1857 merged
   * carrying five unresolved threads. Nothing in the tree read the field, so
   * thirteen days passed with the spec recording it as applied.
   */
  conversationResolution: boolean | null;
  /**
   * Non-null when something could not be read: no credential, no remote, a
   * 403, a network failure. Named, because a cause the operator cannot see is
   * a cause they cannot fix.
   */
  unreadable: string | null;
}

/** What the local tree says about CI on `push:` to the default branch. */
export interface PushCiReading {
  /** Required contexts proven to run on push to the default branch. */
  onPush: string[];
  /** Required contexts with no such trigger. Non-empty blocks `strict: false`. */
  missing: string[];
  /**
   * Required contexts that DECLARE a push trigger and still cannot contribute
   * the semantic-conflict net, because the action they run rejects the event
   * at its own entry point — #1503.
   *
   * Counted apart from both other lists on purpose. In `onPush` it clears the
   * precondition vacuously, which is the defect. In `missing` the remedy
   * printed is *add a push trigger*, which is the change PR #1502 made: it
   * empties `missing`, lifts the refusal, and reviews nothing.
   */
  cannotRunOnPush: string[];
  /**
   * Non-null when the workflows could not be read at all, so neither list
   * means anything. An empty `missing` from an unread directory is the
   * fail-open this field exists to prevent.
   */
  unmeasured: string | null;
}

export type ProtectionVerdict = "PASS" | "FAIL" | "UNMEASURED";

export interface ProtectionReading {
  verdict: ProtectionVerdict;
  /** A sentence naming why, in every branch including PASS. */
  reason: string;
  /**
   * What to do about it, differing by owner type. Empty string on PASS and on
   * UNMEASURED — there is nothing to remedy and nothing established to remedy
   * it from.
   */
  remedy: string;
  /** Whether GitHub would allow a merge queue here. null when unestablished. */
  mergeQueuePossible: boolean | null;
}

// ── The measured cost, quoted once ──────────────────────

/**
 * One sentence, used in every FAIL. A refusal that says "this is slow"
 * is an opinion; one that says 2.5 minutes per PR over 18 PRs is a number the
 * operator can weigh against the thing they were about to do instead.
 *
 * The consumer it was measured on is NOT named, and this string is the reason
 * that matters more than the usual one. It is not a comment — it ships into
 * the findings report of whichever consumer runs this check, so naming the
 * repo would print one consumer's name to every other one. SC-A1 in
 * `test/anti.test.ts` refuses the harness naming a consumer anywhere under
 * `lib/`; #909 carries the repo and the full table.
 */
const MEASURED_COST =
  "measured 2026-10-21 on a real consumer at ~2.5 min per PR, strictly serial — " +
  "18 open PRs, every one BEHIND, none merging and none broken (rungate#909)";

const SERIALISES =
  "required_status_checks.strict = true (\"Require branches to be up to date before merging\") " +
  "means merging one PR invalidates every other open PR: each then needs a branch update, a " +
  "full CI re-run, and a merge, one at a time";

// ── The classification ──────────────────────────────────

/**
 * The verdict for one repo, from its protection facts and its push-CI.
 *
 * Pure, and separate from the fetching, because every interesting decision
 * here is a classification rather than a network call — and the
 * classification is the part that has to be wrong-proof. `readCi` in
 * `lib/github.ts` is split the same way for the same reason.
 *
 * **No branch reaches PASS by not finding a problem.** PASS requires either a
 * positively-read `strict === false`, or a merge queue explicitly reported as
 * enabled. Unknown owner type, unknown strict, unreadable anything: all
 * UNMEASURED.
 */
export function readMergeSerialisation(
  facts: ProtectionFacts,
  pushCi: PushCiReading,
): ProtectionReading {
  const where = facts.branch ? `${facts.slug}@${facts.branch}` : facts.slug;

  if (facts.unreadable) {
    return {
      verdict: "UNMEASURED",
      reason:
        `UNMEASURED: branch protection for ${where} was not read — ${facts.unreadable}. ` +
        "Nothing was checked, which is NOT the same as nothing being wrong: the protection " +
        "endpoint needs admin on the repo, so a token without it produces this and a correctly " +
        "configured repo must not look the same.",
      remedy: "",
      mergeQueuePossible: null,
    };
  }

  if (facts.strict === null) {
    return {
      verdict: "UNMEASURED",
      reason:
        `UNMEASURED: the protection payload for ${where} carried no ` +
        "required_status_checks.strict, so whether merges serialise here is not established.",
      remedy: "",
      mergeQueuePossible: null,
    };
  }

  if (facts.strict === false) {
    const ctx = facts.contexts.length
      ? `required contexts kept: ${facts.contexts.join(", ")}`
      : "no required contexts are configured";
    return {
      verdict: "PASS",
      reason: `${where} has required_status_checks.strict = false, so merging one PR does not invalidate the others — ${ctx}.`,
      remedy: "",
      mergeQueuePossible: facts.ownerType === "Organization",
    };
  }

  // strict === true from here down. The serialisation is a measured fact; the
  // only open question is what to tell the operator to do about it.

  if (facts.mergeQueueEnabled === true) {
    return {
      verdict: "PASS",
      reason:
        `${where} has required_status_checks.strict = true, but a merge queue is enabled in ` +
        "front of it — the queue batches PRs into one speculative commit and tests once, which " +
        "is what makes strict safe. This is the configuration strict was designed for.",
      remedy: "",
      mergeQueuePossible: true,
    };
  }

  if (facts.ownerType === null) {
    return {
      verdict: "UNMEASURED",
      reason:
        `UNMEASURED: ${where} has required_status_checks.strict = true, but owner.type was not ` +
        "read, and the remedy differs by it — an organization can enable a merge queue and a " +
        "user account cannot. Refusing with the wrong remedy is worse than not refusing.",
      remedy: "",
      mergeQueuePossible: null,
    };
  }

  if (facts.ownerType === "Organization") {
    return {
      verdict: "FAIL",
      reason:
        `${where} serialises every PR: ${SERIALISES} — ${MEASURED_COST}. ` +
        "This repo is organization-owned, so the proper fix is available.",
      remedy:
        "Enable a merge queue on the default branch (Settings → Branches, or a ruleset with a " +
        "merge_queue rule). It batches queued PRs into one speculative commit and tests once, " +
        "which keeps strict: true honest instead of serial. Note that a PRIVATE org repo needs " +
        "GitHub Enterprise Cloud for this; if that is not available, treat this repo as the " +
        "user-owned case and set strict: false with push-CI covering the required contexts. " +
        "Also give ci.yml and gates.yml a `merge_group:` trigger — without it the queue waits " +
        "forever on a required check that never reports.",
      mergeQueuePossible: true,
    };
  }

  // User-owned: no merge queue is possible here, at any price. GitHub refuses
  // the merge_queue rule on owner.type alone.
  const base =
    `${where} serialises every PR: ${SERIALISES} — ${MEASURED_COST}. ` +
    `This repo is owned by a ${facts.ownerType} account, and GitHub restricts merge queues to ` +
    "ORGANIZATION-owned repositories — POSTing a ruleset with a merge_queue rule here returns " +
    "422 \"Invalid rule 'merge_queue'\", while the identical ruleset without it is accepted. " +
    "So the usual advice does not apply: there is no merge queue to enable.";

  if (pushCi.unmeasured) {
    return {
      verdict: "FAIL",
      reason: `${base} ${pushCi.unmeasured}`,
      remedy:
        "REFUSING to recommend strict: false — this check could not establish that the required " +
        "contexts run on push: to the default branch, and strict: true is the only thing " +
        "catching a semantic conflict (two PRs each green alone, broken together) when they do " +
        "not. Fix the reading first, then re-run: the answer may well be that push-CI is " +
        "already there.",
      mergeQueuePossible: false,
    };
  }

  if (pushCi.missing.length > 0) {
    return {
      verdict: "FAIL",
      reason:
        `${base} It is ALSO not safe to simply turn strict off here: ` +
        `${pushCi.missing.join(", ")} ` +
        `${pushCi.missing.length === 1 ? "does" : "do"} not run on push: to ` +
        `${facts.branch ?? "the default branch"}.`,
      remedy:
        "REFUSING to recommend strict: false. strict: true is doing one real job — catching the " +
        "semantic conflict, two PRs each green alone and broken together, which no textual merge " +
        "conflict reports. Without CI on push: to the default branch, turning it off removes the " +
        "only thing that catches it and main breaks quietly. Do this first: add " +
        `\`on: push: branches: [${facts.branch ?? "main"}]\` to the workflow(s) providing ` +
        `${pushCi.missing.join(", ")}, confirm a push run reports, and only then set strict: false.`,
      mergeQueuePossible: false,
    };
  }

  // #1503: a context that DECLARES a push trigger but runs an action which
  // rejects the `push` event provides no net. It is deliberately not in
  // `missing` — the remedy printed there is *add a push trigger*, which this
  // context already has, and adding one is what produced this state.
  if (pushCi.cannotRunOnPush.length > 0) {
    const names = pushCi.cannotRunOnPush.join(", ");
    const plural = pushCi.cannotRunOnPush.length === 1;
    return {
      verdict: "FAIL",
      reason:
        `${base} Whether it is safe to turn strict off here is UNMEASURED: ${names} ` +
        `${plural ? "declares" : "declare"} a push: trigger but ${plural ? "runs" : "run"} ` +
        `${plural ? "an action" : "actions"} that ${plural ? "rejects" : "reject"} the push ` +
        `event at ${plural ? "its" : "their"} own entry point, so the run fails immediately ` +
        "and reviews nothing.",
      remedy:
        "REFUSING to recommend strict: false, and NOT because a push trigger is missing — " +
        `${names} ${plural ? "has" : "have"} one. The run it produces cannot go red for a ` +
        "semantic conflict (two PRs each green alone, broken together), so the trigger clears " +
        "this precondition without providing the net strict: true is being traded against. " +
        "Adding more push triggers will not fix it. Either give the default branch a required " +
        `context that genuinely runs the suite on push, or leave strict: true. The ` +
        `event-restricted actions this check knows about: ${EVENT_RESTRICTED_ACTIONS.join(", ")}.`,
      mergeQueuePossible: false,
    };
  }

  const covered = pushCi.onPush.length
    ? `All ${pushCi.onPush.length} required context(s) — ${pushCi.onPush.join(", ")} — already run on push: to ${facts.branch ?? "the default branch"}`
    : "No contexts are required, so nothing is lost by it";
  return {
    verdict: "FAIL",
    reason: `${base} ${covered}, so the safe remedy is available.`,
    remedy:
      "Set required_status_checks.strict = false and KEEP the required contexts " +
      `(${facts.contexts.length ? facts.contexts.join(", ") : "none configured"}). ` +
      `${covered}, so a semantic conflict — two PRs each green alone, broken together — still ` +
      "reds the default branch within minutes of landing, which is the thing strict was buying. " +
      "Apply it yourself; this check reads and refuses and never writes protection. " +
      "The read-only command that shows the current state: " +
      `gh api repos/${facts.slug}/branches/${facts.branch ?? "main"}/protection ` +
      "-q .required_status_checks",
    mergeQueuePossible: false,
  };
}

// ── The probe: the one seam, used by production and by tests ────────────

/**
 * Establish the protection facts for one repo.
 *
 * This type IS the seam. `runBranchProtectionValidation` takes one of these
 * and defaults to `githubProtectionProbe`, so a test substituting a probe is
 * substituting the thing production substitutes into — not a parallel path
 * that only tests take. A test seam the production code does not go through
 * measures the seam.
 */
export type ProtectionProbe = (slug: string) => Promise<ProtectionFacts>;

/** A facts object that established nothing, with the cause named. */
export function unreadableFacts(slug: string, why: string): ProtectionFacts {
  return {
    slug,
    branch: null,
    strict: null,
    ownerType: null,
    contexts: [],
    mergeQueueEnabled: null,
    conversationResolution: null,
    unreadable: why,
  };
}

/** The status an Octokit error carried, or null for a non-HTTP failure. */
function httpStatus(e: unknown): number | null {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : null;
}

function describeError(e: unknown): string {
  const status = httpStatus(e);
  const msg = (e as Error)?.message ?? String(e);
  return status === null ? msg : `HTTP ${status}: ${msg}`;
}

/**
 * Give up rather than hang. A conformity suite that blocks on a socket is a
 * suite nobody runs, and an indefinite wait and a 403 are the same
 * non-answer — so the timeout lands on UNMEASURED like every other one.
 */
const PROBE_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} did not answer within ${ms}ms`)), ms).unref?.(),
    ),
  ]);
}

/**
 * Read a repo's protection from GitHub. Three GETs, no writes.
 *
 * Order matters and is the reason this is not one call:
 *
 *   1. `GET /repos/{o}/{r}`                 — owner.type, default_branch
 *   2. `GET /repos/{o}/{r}/branches/{b}`    — `protected`, readable without admin
 *   3. `GET /…/branches/{b}/protection`     — strict, contexts; ADMIN ONLY
 *
 * Step 2 exists so that step 3's absence is never guessed at. Without it, an
 * unprotected branch and a token lacking admin both arrive as a 404 at step 3
 * and the check would have to pick one; with it, `protected: false` is a fact
 * and a 403/404 at step 3 is UNMEASURED.
 */
export const githubProtectionProbe: ProtectionProbe = async (slug) => {
  let client: GitHubClient;
  try {
    client = createGitHubClient();
  } catch (e) {
    return unreadableFacts(
      slug,
      `no usable GitHub credential (${(e as Error).message}); set GITHUB_TOKEN or GH_TOKEN to a ` +
        "token with admin:repo access to read branch protection",
    );
  }

  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = parseOwnerRepo(slug));
  } catch (e) {
    return unreadableFacts(slug, (e as Error).message);
  }

  let ownerType: string | null = null;
  let branch: string;
  try {
    const r = await withTimeout(client.rest.repos.get({ owner, repo }), PROBE_TIMEOUT_MS, `GET /repos/${slug}`);
    const t = r.data?.owner?.type;
    ownerType = typeof t === "string" ? t : null;
    const b = r.data?.default_branch;
    if (typeof b !== "string" || !b) {
      return unreadableFacts(slug, `GET /repos/${slug} returned no default_branch`);
    }
    branch = b;
  } catch (e) {
    return unreadableFacts(slug, `GET /repos/${slug} failed — ${describeError(e)}`);
  }

  const partial = (why: string): ProtectionFacts => ({
    ...unreadableFacts(slug, why),
    branch,
    ownerType,
  });

  let isProtected: boolean;
  try {
    const r = await withTimeout(
      client.rest.repos.getBranch({ owner, repo, branch }),
      PROBE_TIMEOUT_MS,
      `GET /repos/${slug}/branches/${branch}`,
    );
    const p = r.data?.protected;
    if (typeof p !== "boolean") {
      return partial(`GET /repos/${slug}/branches/${branch} returned no boolean 'protected' field`);
    }
    isProtected = p;
  } catch (e) {
    return partial(`GET /repos/${slug}/branches/${branch} failed — ${describeError(e)}`);
  }

  // An unprotected branch requires nothing, so nothing is strict and nothing
  // serialises. Measured false, not an unread null.
  //
  // `conversationResolution` is false here for the same reason and it is the
  // same kind of fact: an unprotected branch cannot hold a merge for an
  // unanswered finding, so a review that opens threads on one gates nothing.
  // Reading it as `null` would call that unestablished when it is the one
  // case the endpoint lets us establish without admin (#1650).
  if (!isProtected) {
    return { slug, branch, strict: false, ownerType, contexts: [], mergeQueueEnabled: null, conversationResolution: false, unreadable: null };
  }

  try {
    const r = await withTimeout(
      client.rest.repos.getBranchProtection({ owner, repo, branch }),
      PROBE_TIMEOUT_MS,
      `GET /repos/${slug}/branches/${branch}/protection`,
    );
    return protectionFactsFromPayload(slug, branch, ownerType, r.data);
  } catch (e) {
    const status = httpStatus(e);
    const note =
      status === 403 || status === 404
        ? " — this endpoint requires ADMIN on the repository, and the default GitHub Actions " +
          "token does not have it, so this is the ordinary outcome in CI rather than an error"
        : "";
    return partial(`GET /repos/${slug}/branches/${branch}/protection failed — ${describeError(e)}${note}`);
  }
};

/**
 * The protection payload reduced to the four fields a verdict depends on.
 *
 * Exported and pure so the shape-handling is testable without a network: the
 * API returns `required_status_checks` only when checks are required, and a
 * reader that assumed it was always present would throw on exactly the repos
 * that have nothing to report.
 */
export function protectionFactsFromPayload(
  slug: string,
  branch: string,
  ownerType: string | null,
  data: unknown,
): ProtectionFacts {
  const d = (data ?? {}) as Record<string, any>;
  const rsc = d.required_status_checks;

  // No required_status_checks block: protection exists but requires no
  // checks, so there is no strictness and nothing to be out of date against.
  if (!rsc || typeof rsc !== "object") {
    return { slug, branch, strict: false, ownerType, contexts: [], mergeQueueEnabled: mergeQueueFrom(d), conversationResolution: conversationResolutionFrom(d), unreadable: null };
  }

  const strict = typeof rsc.strict === "boolean" ? rsc.strict : null;
  // `contexts` is the legacy field and `checks[].context` the current one.
  // Both are read because branch protection still answers with either, and a
  // reader of one alone reports "no required contexts" on a repo that has
  // several — which would make the push-CI precondition vacuously satisfied.
  const legacy = Array.isArray(rsc.contexts) ? rsc.contexts : [];
  const modern = Array.isArray(rsc.checks) ? rsc.checks.map((c: any) => c?.context) : [];
  const contexts = [...new Set([...legacy, ...modern])].filter(
    (c: unknown): c is string => typeof c === "string" && c.length > 0,
  );

  return { slug, branch, strict, ownerType, contexts, mergeQueueEnabled: mergeQueueFrom(d), conversationResolution: conversationResolutionFrom(d), unreadable: null };
}

function mergeQueueFrom(d: Record<string, any>): boolean | null {
  const e = d.required_merge_queue?.enabled;
  return typeof e === "boolean" ? e : null;
}

/**
 * `required_conversation_resolution.enabled`, and **only** from that shape.
 *
 * The protection endpoint answers `{"enabled": false}` for off and omits the
 * key entirely on an unprotected branch, so a reader that coerced the object
 * itself would read the `false` case as truthy. Absent stays `null`: the
 * payload did not say, and "did not say" is not "off".
 */
function conversationResolutionFrom(d: Record<string, any>): boolean | null {
  const e = d.required_conversation_resolution?.enabled;
  return typeof e === "boolean" ? e : null;
}

/** The `owner/name` this tree pushes to, for the probe to ask about. */
export function protectionSubject(root: string): string | null {
  return originSlug(root);
}

// ── Push-CI, read from the local tree ───────────────────

const WORKFLOW_EXT = /\.ya?ml$/i;

/**
 * Which of `contexts` run on `push:` to `branch`, judged from
 * `.github/workflows/`.
 *
 * Read from the tree and not from GitHub's API on purpose: the question is
 * what the code in THIS commit does, and that is what the operator is about
 * to change protection against. A run-history query would answer a question
 * about the past.
 *
 * An absent or unreadable workflows directory is `unmeasured`, never an empty
 * `missing`. Those two produce byte-identical lists and mean opposite things,
 * and the empty one would silently clear the push-CI precondition for
 * `strict: false` — the gate recommending the change on exactly the repos
 * where it is least safe.
 */
export function readPushCi(root: string, contexts: string[], branch: string): PushCiReading {
  const dir = join(root, ".github", "workflows");

  let entries: string[];
  try {
    if (!statSync(dir).isDirectory()) {
      return unmeasuredPushCi(`${dir} is not a directory, so no push: trigger could be read`);
    }
    entries = readdirSync(dir).filter(n => WORKFLOW_EXT.test(n)).sort();
  } catch (e) {
    const why = (e as NodeJS.ErrnoException).code === "ENOENT"
      ? `${dir} does not exist`
      : `${dir} is unreadable — ${(e as Error).message}`;
    return unmeasuredPushCi(`${why}, so no push: trigger could be read`);
  }

  const unreadable: string[] = [];
  const pushContexts = new Set<string>();
  const restricted = new Set<string>();
  for (const name of entries) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf-8");
    } catch (e) {
      // Not "has no push trigger" and not "has one": both are claims about
      // bytes nobody read.
      unreadable.push(`${name} (${(e as Error).message})`);
      continue;
    }
    if (!runsOnPushTo(text, branch)) continue;
    for (const job of jobContextNames(text)) pushContexts.add(job);
    for (const job of eventRestrictedContexts(text)) restricted.add(job);
  }

  if (unreadable.length > 0) {
    return unmeasuredPushCi(
      `${unreadable.length} workflow file(s) could not be read — ${unreadable.join(", ")} — ` +
        "so whether the required contexts run on push is not established",
    );
  }

  return {
    // A restricted context is in NEITHER of the first two lists. `onPush`
    // would clear the precondition with a run that throws; `missing` would
    // print "add a push trigger", which is the change that produced it.
    onPush: contexts.filter(c => pushContexts.has(c) && !restricted.has(c)),
    missing: contexts.filter(c => !pushContexts.has(c) && !restricted.has(c)),
    cannotRunOnPush: contexts.filter(c => restricted.has(c)),
    unmeasured: null,
  };
}

/**
 * The refusal shape for a push-CI reading that could not be taken.
 *
 * Exported since #1503 so `lib/conformity.ts` stops hand-building the same
 * object literal: two spellings of one refusal are two deciders, and the
 * inline one silently lacked `cannotRunOnPush` the moment the field existed.
 */
export function unmeasuredPushCi(why: string): PushCiReading {
  return {
    onPush: [],
    missing: [],
    cannotRunOnPush: [],
    unmeasured: `UNMEASURED push-CI: ${why}.`,
  };
}

/**
 * Actions that reject a `push` event at their own entry point — #1503.
 *
 * A closed set in SOURCE, never config and never an allowlist a repository
 * can append to. The issue names why: a list anybody can extend turns the
 * refusal into an opt-out, and the first thing a blocked operator would add
 * is whichever context is blocking them.
 *
 * `anthropics/claude-code-action` is the measured instance. At the SHA this
 * repository pins, `src/github/context.ts` throws `Unsupported event type`
 * for anything outside `pull_request`, `issue_comment`, `issues`, `schedule`
 * and `workflow_dispatch`. So a job running it under `on: push` produces a
 * run that fails immediately and reviews nothing — it can never go red for
 * the semantic conflict `strict: false` is traded against.
 *
 * Adding a row here is a source change with a review, and it needs the same
 * evidence this one has: the line in the action that rejects the event.
 */
export const EVENT_RESTRICTED_ACTIONS = ["anthropics/claude-code-action"] as const;

/**
 * The context names of jobs that run an {@link EVENT_RESTRICTED_ACTIONS}
 * action, judged from the same per-job walk {@link jobContextNames} does.
 *
 * Same walk deliberately: two walks of the `jobs:` block would be two
 * deciders for "where does this job end", and a job whose context name one
 * of them resolved differently would be restricted under one and not the
 * other (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
export function eventRestrictedContexts(text: string): string[] {
  return jobBlocks(text)
    .filter(j => j.body.some(line => EVENT_RESTRICTED_ACTIONS.some(a => usesAction(line, a))))
    .map(j => j.context);
}

/** `uses: <action>@<ref>` on this line, matching the action and not a prefix. */
function usesAction(line: string, action: string): boolean {
  // The trailing `# v1` is not decoration — every pinned action in this repo
  // carries one, and a `\s*$` anchor that forgets it matches nothing at all.
  const m = line.trim().match(/^-?\s*uses\s*:\s*(["']?)([^"'\s]+)\1\s*(?:#.*)?$/);
  if (!m) return false;
  const ref = m[2];
  // `owner/name@sha` and `owner/name/sub@sha` both count; `owner/name-2` does
  // not, which is the prefix a bare `startsWith` would wrongly accept.
  return ref === action || ref.startsWith(`${action}@`) || ref.startsWith(`${action}/`);
}

// ── The small amount of YAML this needs ─────────────────
//
// A real parser is not pulled in for this. The two questions are "is there a
// `push:` under `on:` that matches this branch" and "what are the job context
// names", both of which are top-level structure in a file GitHub itself
// requires to be conventionally shaped. What a parser would buy is handling of
// forms no CI workflow uses; what it would cost is a dependency in the one
// module a consumer's conformity suite imports.
//
// Every function here is deliberately conservative: when the shape is not one
// it recognises, it reports NOT-matching rather than guessing, and the gate
// upstream turns a non-match into a refusal to recommend `strict: false`. The
// error direction is toward "we did not establish it", never toward "fine".

/** Lines with whole-line comments dropped and indentation preserved. */
function significantLines(text: string): string[] {
  return text
    .split("\n")
    .filter(l => l.trim() !== "" && !l.trimStart().startsWith("#"));
}

/** The lines of the block introduced by top-level `key:`, excluding the key line. */
function topLevelBlock(lines: string[], keys: string[]): { header: string; body: string[] } | null {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(["']?)([A-Za-z_][A-Za-z0-9_-]*)\1\s*:(.*)$/);
    if (!m || !keys.includes(m[2])) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\S/.test(lines[j])) break;
      body.push(lines[j]);
    }
    return { header: m[3].trim(), body };
  }
  return null;
}

/** Indentation width of a line, in spaces. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The sub-block of `key:` within an already-dedented-by-context block. */
function childBlock(body: string[], key: string): { header: string; body: string[] } | null {
  const base = body.length ? Math.min(...body.map(indentOf)) : 0;
  for (let i = 0; i < body.length; i++) {
    if (indentOf(body[i]) !== base) continue;
    const m = body[i].trim().match(/^(["']?)([A-Za-z_][A-Za-z0-9_-]*)\1\s*:(.*)$/);
    if (!m || m[2] !== key) continue;
    const out: string[] = [];
    for (let j = i + 1; j < body.length; j++) {
      if (indentOf(body[j]) <= base) break;
      out.push(body[j]);
    }
    return { header: m[3].trim(), body: out };
  }
  return null;
}

/** Entries of a YAML sequence in either flow (`[a, b]`) or block (`- a`) form. */
function sequenceEntries(header: string, body: string[]): string[] {
  const out: string[] = [];
  const flow = header.match(/^\[(.*)\]$/);
  if (flow) {
    for (const part of flow[1].split(",")) {
      const v = unquote(part.trim());
      if (v) out.push(v);
    }
    return out;
  }
  for (const line of body) {
    const m = line.trim().match(/^-\s*(.+)$/);
    if (m) out.push(unquote(m[1].trim()));
  }
  return out;
}

function unquote(s: string): string {
  const m = s.match(/^(["'])(.*)\1$/);
  return m ? m[2] : s;
}

/**
 * Does a `branches:` pattern cover `branch`?
 *
 * Supports exactly what GitHub's filter syntax does for the cases that occur:
 * a literal name, `*` within a path segment, and `**` across them. An
 * unrecognised pattern does not match, so an exotic filter produces "we did
 * not establish push-CI" rather than a confident wrong yes.
 */
export function branchPatternMatches(pattern: string, branch: string): boolean {
  if (pattern === branch) return true;
  if (!pattern.includes("*")) return false;
  const rx = pattern
    .split("**")
    .map(seg => seg.split("*").map(escapeRegex).join("[^/]*"))
    .join(".*");
  try {
    return new RegExp(`^${rx}$`).test(branch);
  } catch {
    return false;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether this workflow runs on a push to `branch`.
 *
 * The `on:` key is the one place YAML's own history bites: unquoted `on` is a
 * boolean in YAML 1.1, so files in the wild write `'on':` and `"on":` too, and
 * a reader matching only the bare form silently sees no triggers at all.
 */
export function runsOnPushTo(text: string, branch: string): boolean {
  const lines = significantLines(text);
  const on = topLevelBlock(lines, ["on"]);
  if (!on) return false;

  // `on: push` and `on: [push, pull_request]` carry no branch filter at all,
  // which in GitHub's semantics means every branch — including this one.
  if (on.header) {
    if (on.header === "push") return true;
    const flow = on.header.match(/^\[(.*)\]$/);
    if (flow) return flow[1].split(",").map(p => unquote(p.trim())).includes("push");
    return false;
  }

  const push = childBlock(on.body, "push");
  if (!push) return false;

  const ignore = childBlock(push.body, "branches-ignore");
  if (ignore) {
    return !sequenceEntries(ignore.header, ignore.body).some(p => branchPatternMatches(p, branch));
  }

  const branches = childBlock(push.body, "branches");
  // `push:` with no filter fires on every branch.
  if (!branches) return true;
  return sequenceEntries(branches.header, branches.body).some(p => branchPatternMatches(p, branch));
}

/**
 * The status-check context names a workflow contributes.
 *
 * A job's context is its `name:` when it has one and its key otherwise —
 * which is why the key alone is not enough: `test:` with `name: Suite`
 * reports as `Suite` in branch protection, and a check looking for `test`
 * would call a configured repo unconfigured.
 */
export function jobContextNames(text: string): string[] {
  return jobBlocks(text).map(j => j.context);
}

/** One job of a workflow: the context name it reports, and its own lines. */
export interface JobBlock {
  /** `name:` when the job has one, its key otherwise. */
  context: string;
  /** The job's significant lines, excluding the key line itself. */
  body: string[];
}

/**
 * Every job in a workflow, with the context name each reports.
 *
 * The single decider for *where a job ends and what it is called* — #1503.
 * {@link jobContextNames} and {@link eventRestrictedContexts} both read it
 * rather than walking `jobs:` themselves, because two walks would be two
 * deciders answering the same question: a job whose extent they resolved
 * differently would be restricted under one and named under the other, and
 * no behavioural test could tell which of them was live
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
export function jobBlocks(text: string): JobBlock[] {
  const lines = significantLines(text);
  const jobs = topLevelBlock(lines, ["jobs"]);
  if (!jobs || jobs.body.length === 0) return [];
  const base = Math.min(...jobs.body.map(indentOf));

  const out: JobBlock[] = [];
  for (let i = 0; i < jobs.body.length; i++) {
    if (indentOf(jobs.body[i]) !== base) continue;
    const key = jobs.body[i].trim().match(/^(["']?)([A-Za-z_][A-Za-z0-9_-]*)\1\s*:\s*$/);
    if (!key) continue;
    const block: string[] = [];
    for (let j = i + 1; j < jobs.body.length; j++) {
      if (indentOf(jobs.body[j]) <= base) break;
      block.push(jobs.body[j]);
    }
    const name = childBlock(block, "name");
    out.push({ context: name?.header ? unquote(name.header) : key[2], body: block });
  }
  return out;
}

// ── CRC-C3: a finding blocks merge until somebody dispositions it ──

/**
 * The step id the generated AI review uses to open one review thread per
 * finding — **re-exported from the generator that writes it**, never spelled
 * again here (ai-review review round 1 of #1858).
 *
 * The first version of this declared its own `"ai-review-threads"` literal
 * beside a comment claiming it was "spelled once". It was spelled twice:
 * `AI_REVIEW_THREADS_STEP_ID` in `lib/scaffold/ai-review-step.ts` is what
 * actually gets written into the generated workflow's `id:` line, and the two
 * agreed by coincidence rather than by construction.
 *
 * That is the *two deciders that agree* shape, and it fails in the direction
 * that matters: rename the step in the generator alone and `readThreadProducer`
 * stops matching, `produces` goes false, `readFindingDisposition` takes the
 * PASS branch below — and PROTECT-2 silently clears on a tree that still opens
 * a review thread per finding. The gate built to catch a silent regression
 * would have regressed silently.
 *
 * It is the PRECONDITION the whole check turns on: a repo that does not
 * produce threads has nothing for `required_conversation_resolution` to gate,
 * and refusing there would tell an operator to configure a setting that would
 * do nothing for them.
 */
export const THREAD_PRODUCER_STEP_ID = AI_REVIEW_THREADS_STEP_ID;

/** Whether this tree opens a review thread per finding. */
export interface ThreadProducerReading {
  /** True only when a workflow was read and declares the producing step. */
  produces: boolean;
  /** The workflow file it was found in, for the reason string. */
  where: string | null;
  /**
   * Non-null when the workflows could not be read, so `produces: false` means
   * nothing. An unread directory reporting "no producer" would clear this
   * check vacuously on every tree whose `.github/` is unreadable.
   */
  unmeasured: string | null;
}

export function readThreadProducer(root: string): ThreadProducerReading {
  const dir = join(root, ".github", "workflows");
  const unread = (why: string): ThreadProducerReading => ({ produces: false, where: null, unmeasured: why });

  let entries: string[];
  try {
    if (!statSync(dir).isDirectory()) return unread(`${dir} is not a directory`);
    entries = readdirSync(dir).filter(n => WORKFLOW_EXT.test(n)).sort();
  } catch (e) {
    const why = (e as NodeJS.ErrnoException).code === "ENOENT"
      ? `${dir} does not exist`
      : `${dir} is unreadable — ${(e as Error).message}`;
    return unread(why);
  }

  const unreadable: string[] = [];
  for (const name of entries) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf-8");
    } catch (e) {
      unreadable.push(`${name} (${(e as Error).message})`);
      continue;
    }
    // The step ID in a declaring position, not the string anywhere. The
    // workflow mentions `ai-review-threads` in a comment and in three env
    // var values; matching those would report a producer in a tree that had
    // deleted the step and left the prose.
    // `- id: x` is as legal as `id: x` — a step may lead with any key, and
    // the generator only happens to lead with `name:`. The first spelling of
    // this required the line to BEGIN with whitespace then `id:`, so a step
    // written the other way read as no producer at all. Found by a fixture
    // that spelled it the legal second way (#1858).
    //
    // `escapeRegex`, because the id is not this file's value to trust. It is
    // the generator's constant, imported — which is the whole point of the
    // re-export above — and a rename to anything containing `.`, `+` or `(`
    // would change what this pattern MEANS rather than throw. A `.` in the id
    // would quietly match any character. Round 2 of #1858; the helper was
    // already in use a few dozen lines up for exactly this reason.
    if (new RegExp(`^\\s*(?:-\\s*)?id:\\s*["']?${escapeRegex(THREAD_PRODUCER_STEP_ID)}["']?\\s*$`, "m").test(text)) {
      return { produces: true, where: name, unmeasured: null };
    }
  }

  if (unreadable.length > 0) {
    return unread(
      `${unreadable.length} workflow file(s) could not be read — ${unreadable.join(", ")} — ` +
        "so whether any opens a review thread is unestablished",
    );
  }
  return { produces: false, where: null, unmeasured: null };
}

/** One reading of whether a finding can be left undispositioned. */
export interface DispositionReading {
  verdict: ProtectionVerdict;
  /** A sentence naming why, in every branch including PASS. */
  reason: string;
  /** Empty on PASS and on UNMEASURED — nothing to remedy, or nothing established. */
  remedy: string;
}

/**
 * CRC-C3 — can a pull request merge with a finding nobody answered?
 *
 * `required_conversation_resolution` is GitHub's own implementation of it,
 * and the only protection setting that can read a review thread. It is
 * therefore the only one that can tell *this finding was answered* from
 * *nobody looked*.
 *
 * ## Why this check exists rather than a line in the spec
 *
 * It was ON and it silently went OFF. `specs/CODE-REVIEW-CONVERGENCE-SPEC.md`
 * records it applied on 2026-10-23 and read `true` from the API on
 * 2026-10-25, and three pull requests behaved accordingly through 2026-10-27:
 * each sat at `BLOCKED` on one unresolved thread with every required check
 * green, and each flipped to `CLEAN` when that thread was resolved — same
 * head, no push, no re-run.
 *
 * On 2026-11-07 the same field read `false`, and #1857 merged carrying five
 * unresolved threads, two of them not even outdated. **Nothing in the tree
 * read the field**, so thirteen days passed with the spec recording a setting
 * that was not in force. The protection endpoint's `PUT` replaces the whole
 * object, so any update that omits the field turns it off and returns 200 —
 * there is no event to notice and no error to read.
 *
 * That is the shape this repository keeps paying for: a documented status
 * that nothing re-reads. The remedy is not a better sentence in the spec.
 *
 * ## No branch reaches PASS by not finding a problem
 *
 * A tree that opens no review threads PASSES, and says that is why — there is
 * nothing for the setting to gate, and demanding it there would be advice
 * that changes nothing. Everything unread is UNMEASURED: the protection
 * endpoint needs admin and the default Actions token has none, so UNMEASURED
 * is the ordinary outcome in a consumer's CI and must never read as clean.
 */
export function readFindingDisposition(
  facts: ProtectionFacts,
  producer: ThreadProducerReading,
): DispositionReading {
  // **The producer reading comes FIRST, and the order is the finding** (ai-review
  // round 1 of #1858). A tree with no thread producer passes whatever the
  // protection says, because nothing depends on reading it — so asking about
  // protection before asking whether the question applies made the answer
  // depend on a fact that cannot change it.
  //
  // It is not a tidiness point. The two conditions it put in the wrong order
  // are BOTH the ordinary state of a consumer: most have not adopted
  // `ai-review-threads`, and most run with the default `GITHUB_TOKEN`, which
  // has no admin and so cannot read protection at all. Every one of them would
  // have got `UNMEASURED: this repo's protection could not be read` on every
  // run — a warning about a setting that would do nothing for them if they
  // set it. That is how a gate gets switched off.
  if (producer.unmeasured) {
    return {
      verdict: "UNMEASURED",
      reason:
        `UNMEASURED: ${producer.unmeasured}. With no reading of whether anything opens a review ` +
        "thread, the setting's relevance is unestablished and the protection reading alone " +
        "cannot decide it.",
      remedy: "",
    };
  }
  if (!producer.produces) {
    return {
      verdict: "PASS",
      reason:
        "no workflow in this tree declares a step that opens a review thread per finding, so " +
        "there is nothing for required_conversation_resolution to gate and requiring it here " +
        "would change nothing.",
      remedy: "",
    };
  }
  // Only now does protection matter: something opens threads, so whether they
  // have to be answered is a live question.
  if (facts.unreadable) {
    return {
      verdict: "UNMEASURED",
      reason:
        `UNMEASURED: this repo's protection could not be read — ${facts.unreadable}. Whether a ` +
        "finding can be left undispositioned is unestablished, which is not the same as fine.",
      remedy: "",
    };
  }
  if (facts.conversationResolution === null) {
    return {
      verdict: "UNMEASURED",
      reason:
        "UNMEASURED: the protection payload said nothing about " +
        "required_conversation_resolution, so it is unestablished rather than off. An absent " +
        "key and a false one are different facts.",
      remedy: "",
    };
  }
  if (facts.conversationResolution) {
    return {
      verdict: "PASS",
      reason:
        `required_conversation_resolution is on, and ${producer.where ?? "a workflow"} opens a ` +
        "review thread per finding — so a finding nobody answered blocks the merge.",
      remedy: "",
    };
  }
  return {
    verdict: "FAIL",
    reason:
      `${producer.where ?? "a workflow"} opens a review thread per finding and ` +
      "required_conversation_resolution is OFF, so a pull request merges with every one of them " +
      "unanswered. The review runs, writes its findings onto the diff, and gates nothing — " +
      "which reads as a reviewed change and is not one.",
    remedy:
      "Require conversation resolution before merging on this branch. It is a setting, not " +
      "engineering. **A branch with NO protection at all reaches this same verdict** — nothing " +
      "is requiring anything, so nothing can hold a merge for an unanswered finding — and there " +
      "the fix is to create the protection rather than amend it. Either way, write it with a " +
      "FULL PUT: `PUT /repos/{owner}/{repo}/branches/{branch}/protection` replaces the whole " +
      "object and requires required_status_checks, enforce_admins, " +
      "required_pull_request_reviews and restrictions to be present even when you are only " +
      "turning one thing on — so read the current protection first and restate every field you " +
      "want to keep. An update that omits a field silently disables it, which is how this regressed " +
      "once already. Clearing a false positive is a documented step, not a judgement call — " +
      "reference/clearing-a-false-positive.md.",
  };
}
