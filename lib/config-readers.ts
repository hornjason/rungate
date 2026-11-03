/**
 * Thin typed accessors over the resolved config (#214, ADR-001 D1).
 *
 * ADR-001 decided on 2026-10-05 that `lib/config-loader.ts` is the sole config
 * access point and named the enforcement: a conformity check that FAILS the
 * suite. The check shipped under #309 as CONFIG-1/CONFIG-2 with a
 * known-violations ratchet. This module is the other half — the migration the
 * ratchet exists to let happen one commit at a time.
 *
 * ## Why accessors and not "just call the loader at each site"
 *
 * Six call sites wanted the same three values and each hand-rolled the whole
 * read: `existsSync`, `JSON.parse`, pick a key, and — at four of them — a bare
 * `catch` returning a default. Pointing six copies of that at the loader would
 * remove the path construction and keep the six private answers to "what does
 * unresolvable mean", which ADR-002 names as the defect under the defect:
 *
 *   > Drift was not the failure. Defaulting was.
 *
 * Each function here answers that question once, in the open:
 *
 *  - **absent config** — a legitimate state for every one of these callers
 *    (an unscaffolded directory, a consumer repo that has never run rungate),
 *    so the empty value is returned and that is the whole of the contract.
 *  - **malformed config** — THROWS, inherited from `tryLoadRungateConfig` and
 *    deliberately not caught here. ADR-001 D2's corollary: a malformed config
 *    is never a missing config. The bare `catch` at `scripts/fresh-eyes-test`
 *    and `scripts/grade-deterministic` converted a corrupt config into an
 *    unconfigured project, which is exactly how #70 stayed silent.
 *
 * ## What the migration actually fixes, beyond the policy
 *
 * Every site these replace read `.claude/rungate.json` and nothing else. A
 * consumer on the directory layout — the layout
 * `specs/CONFIG-DIRECTORY-STRUCTURE-SPEC.md` D-1 asks every consumer to
 * migrate to — got `{}` from all of them, silently: no roles, no slug, no
 * pre-flight hosts. The documented migration switched the features off.
 */

import { tryLoadRungateConfig } from "./config-loader";
import type { RoleConfig } from "./rungate-schema";

/**
 * Every configured role, keyed by name. `{}` when the project has no config.
 *
 * `roles` is `z.record(z.unknown()).default({})` in the resolved shape — the
 * loader merges `roles.json` in but does not validate each entry against
 * `RoleSchema`, so consumers carrying a role with a missing `brief` reach
 * here. Narrowing is therefore an assertion about shape, not a guarantee of
 * it; callers that index `brief` already handle it being absent.
 */
export function loadRoleConfig(projectRoot: string): Record<string, RoleConfig> {
  const config = tryLoadRungateConfig(projectRoot);
  if (!config) return {};
  return (config.roles ?? {}) as Record<string, RoleConfig>;
}

/**
 * The project slug, or null when the config does not name one.
 *
 * Null rather than a `"project"` default: the caller that wanted that default
 * uses it to name a worktree directory, and a second project falling back to
 * the same literal would collide with the first. The default belongs at the
 * site that can see the collision, not here.
 */
export function readProjectSlug(projectRoot: string): string | null {
  const config = tryLoadRungateConfig(projectRoot);
  const slug = config?.project;
  return typeof slug === "string" && slug.trim() ? slug : null;
}

/**
 * The project board this repository's readings are taken against — item **B4**.
 *
 * `null` when no `board` block is configured, or when it does not carry both
 * identifiers a field read needs. Null rather than a partial object: a caller
 * holding a project id with no field id cannot read a column, and handing it
 * half the block makes it decide for itself what to do about the other half —
 * which is a second decider in every caller.
 *
 * `board` is not in `ProjectHarnessSchema`; it reaches the resolved config
 * through `.passthrough()`, same as `remoteHosts`, which is why every field
 * access below is guarded rather than typed.
 *
 * **The field is named by ID, and only by id.** `lib/live-issues.ts` resolves
 * it to a name against the API. A name configured beside the id would be two
 * identifiers for one field, and a rename on the board would read every value
 * as blank with nothing saying so.
 */
export function readBoardConfig(projectRoot: string): { projectId: string; criteriaFieldId: string } | null {
  const config = tryLoadRungateConfig(projectRoot);
  const board = (config as Record<string, unknown> | null)?.board;
  if (!board || typeof board !== "object" || Array.isArray(board)) return null;
  const row = board as Record<string, unknown>;
  const fields = row.fields;
  const criteria =
    fields && typeof fields === "object" && !Array.isArray(fields)
      ? (fields as Record<string, unknown>).Criteria
      : undefined;
  const projectId = typeof row.id === "string" ? row.id.trim() : "";
  const criteriaFieldId = typeof criteria === "string" ? criteria.trim() : "";
  if (projectId === "" || criteriaFieldId === "") return null;
  return { projectId, criteriaFieldId };
}

/**
 * The label that marks an issue as being in the work queue, or `null`.
 *
 * **One binding, because the writer and the reading must not disagree.**
 * `scripts/plan-issues.ts` applies it when it creates an issue and
 * `scripts/board-conformance.ts`'s `queue-label` reading scores it, and
 * before #1727 only the second knew the name. `--decompose --write` created
 * seven issues on 2026-11-02 and the reading fell MET 12 of 12 → 5 of 12 on
 * a command that never consulted it; the repair was seven `gh issue edit`
 * calls by hand, which is what SC-2625 forbids.
 *
 * Spelling `"engine"` in the writer as well would have fixed that day and
 * built the *two deciders that agree* shape — no behavioural case can tell
 * them apart, and a mutation of either leaves the other holding every case
 * up (`.claude/rules/checks-must-be-able-to-fail.md`).
 *
 * `null` for absent, blank or non-string, and callers must say UNMEASURED
 * rather than substitute one: a tree that never configured a queue has not
 * got an empty queue, it has no queue.
 */
export function readQueueLabel(projectRoot: string): string | null {
  const config = tryLoadRungateConfig(projectRoot);
  const board = (config as Record<string, unknown> | null)?.board;
  if (!board || typeof board !== "object" || Array.isArray(board)) return null;
  const raw = (board as Record<string, unknown>).queueLabel;
  if (typeof raw !== "string") return null;
  const label = raw.trim();
  return label === "" ? null : label;
}

/**
 * Pre-flight SSH hosts, keyed by name. `{}` when none are configured.
 *
 * `remoteHosts` is not in `ProjectHarnessSchema`; it reaches the resolved
 * config through `.passthrough()`, which is why the value is `unknown` and
 * every field access downstream is guarded. Declaring it would be a schema
 * change affecting every consumer config in the wild — out of scope here, and
 * recorded rather than done.
 */
export function readRemoteHosts(projectRoot: string): Record<string, unknown> {
  const config = tryLoadRungateConfig(projectRoot);
  const hosts = (config as Record<string, unknown> | null)?.remoteHosts;
  if (!hosts || typeof hosts !== "object" || Array.isArray(hosts)) return {};
  return hosts as Record<string, unknown>;
}
