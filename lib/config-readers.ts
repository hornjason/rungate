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

import { resolveConfig, tryLoadRungateConfig } from "./config-loader";
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
 * The two inputs `board-snapshot` cannot take a reading without: which spec
 * the board is supposed to mirror, and the milestone-name prefix that defines
 * the population it is scored over.
 *
 * **Why this exists at all (#1718, SC-2619).** Both arrived only as command
 * line arguments, so `rungate board-conformance` with no flags produced five
 * UNMEASURED readings whose stated reason was `B1 has not wired this
 * reading's source yet` — a sentence about the tool being unfinished, for a
 * tool that was finished. The real cause was that nobody had passed a spec.
 * A status command that misattributes its own silence is worse than one that
 * refuses, and that is the whole of what this project is trying to stop.
 *
 * **Absent is `null`, per key, and never a literal.** `"Pipeline"` and this
 * repository's own engine spec are the obvious defaults and both are wrong to
 * bake in: a consumer that scaffolded rungate and never configured a board has
 * no engine spec, and handing it ours would score its board against a
 * document it does not have. Absent must stay nameable by the caller —
 * *Silent Default Substitution*, `.claude/rules/config-access.md`.
 *
 * Blank and whitespace are `null` too, for the reason `readMilestonePrefix`
 * already encodes: a prefix of `"   "` matches no milestone on any board and
 * reports every phase as missing.
 */
export function readBoardInputs(projectRoot: string): {
  engineSpec: string | null;
  milestonePrefix: string | null;
} {
  const config = tryLoadRungateConfig(projectRoot);
  const board = (config as Record<string, unknown> | null)?.board;
  if (!board || typeof board !== "object" || Array.isArray(board)) {
    return { engineSpec: null, milestonePrefix: null };
  }
  const row = board as Record<string, unknown>;
  const read = (key: string): string | null => {
    const raw = row[key];
    if (typeof raw !== "string") return null;
    const value = raw.trim();
    return value === "" ? null : value;
  };
  return { engineSpec: read("engineSpec"), milestonePrefix: read("milestonePrefix") };
}

/**
 * The engine milestone family, AND whether the absence of one was measured.
 *
 * **Round 2 of #1965's review, and the finding was right.** The two scripts
 * that order Ready read `readBoardInputs(process.cwd()).milestonePrefix`, and
 * `readBoardInputs` returns `{milestonePrefix: null}` for a config it could
 * not find at all — the same value a tree that genuinely declares no engine
 * family gets. A `null` prefix means *order by phase alone*, which is exactly
 * the pre-#1943 behaviour this work exists to remove. So a run from the wrong
 * working directory — a wrapper, a cron job, a CI `working-directory` — turns
 * the fix off and reports the payload above the engine again, with nothing
 * saying it did. `.claude/rules/config-access.md` names that: *Silent Default
 * Substitution*, reached through `process.cwd()` rather than a missing key.
 *
 * Two `null`s with different meanings is the whole defect, so this returns
 * both the value and the reading. `resolveConfig` is what separates them —
 * the documented reporter for *which case did I hit* — rather than a second
 * existence check compiled here.
 *
 * `unmeasured` is a MESSAGE and not a boolean, because a warning that does
 * not name the directory it read is a warning nobody can act on: the whole
 * failure is that the directory was not the one the caller assumed.
 */
export function enginePrefixReading(projectRoot: string): {
  prefix: string | null;
  unmeasured: string | null;
} {
  const prefix = readBoardInputs(projectRoot).milestonePrefix;
  if (prefix !== null) return { prefix, unmeasured: null };
  if (resolveConfig(projectRoot).status !== "absent") return { prefix: null, unmeasured: null };
  return {
    prefix: null,
    unmeasured:
      `UNMEASURED: no rungate config under ${projectRoot}, so the engine milestone ` +
      `family could not be read. Ready is ordered by phase number alone, which ranks ` +
      `another family's lower phase above the engine's higher one (#1943). Run this from ` +
      `the project root.`,
  };
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
  return readBoardLabel(projectRoot, "queueLabel");
}

/**
 * The label that promotes an issue to the top of Ready, or `null` (SC-2735).
 *
 * It was the constant `WORK_NEXT_LABEL` in `lib/board-ready-rule.ts`, so a
 * consumer repository could not rename it and the library decided a
 * project's vocabulary. `null` is the honest reading for a tree that never
 * configured one: nothing can be promoted, and `workNextReading` says so as
 * `UNCONFIGURED` rather than honouring a name the project never chose.
 */
export function readExpediteLabel(projectRoot: string): string | null {
  return readBoardLabel(projectRoot, "expediteLabel");
}

/**
 * The label that waives a FindingArbiter refusal on a filing, or `null`
 * (SC-2735).
 *
 * It was the constant `FILING_OVERRIDE_LABEL` in `lib/issue-filing-gate.ts`.
 * `null` means **no waiver exists**, and that is the direction that matters:
 * a built-in name substituted for absent config would hand every
 * unscaffolded repository a way past the gate that its own config never
 * declared — *Silent Default Substitution*, `.claude/rules/config-access.md`.
 */
export function readFilingOverrideLabel(projectRoot: string): string | null {
  return readBoardLabel(projectRoot, "filingOverrideLabel");
}

/** One `board.<key>` label: absent, blank and non-string are all `null`. */
function readBoardLabel(projectRoot: string, key: string): string | null {
  const config = tryLoadRungateConfig(projectRoot);
  const board = (config as Record<string, unknown> | null)?.board;
  if (!board || typeof board !== "object" || Array.isArray(board)) return null;
  const raw = (board as Record<string, unknown>)[key];
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
