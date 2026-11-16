/**
 * Check a gate artifact against its declared schema, before it is written
 * (#1559, #2255, SC-2770).
 *
 * Lives in `lib/` rather than beside its first caller in
 * `gates/gate-executor.ts` because `gates/orchestrator.ts` needs it too, and
 * gate-executor already imports orchestrator. `gates/gate-executor.ts`
 * re-exports both names, so there is one definition and every existing import
 * keeps working.
 */

/**
 * Anything with zod's `safeParse` shape. Structural, so callers keep no
 * direct zod import and a test can hand it a stricter copy of a schema.
 */
export interface ArtifactSchema {
  safeParse(value: unknown): {
    success: boolean;
    error?: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> };
  };
}

/**
 * One `path: message` line per violation, `[]` when it validates.
 *
 * `config/prove-evidence.schema.json` declared a contract nothing read, so
 * writer and contract drifted apart: B3's artifact failed both the JSON
 * schema and the zod one, and no check said so. A refusal that names no
 * issue is still a refusal — an empty list there would read as a pass.
 */
export function validateArtifactSchema(artifact: unknown, schema: ArtifactSchema): string[] {
  const result = schema.safeParse(artifact);
  if (result.success) return [];
  const issues = result.error?.issues ?? [];
  if (issues.length === 0) return ["(root): the schema refused the artifact without naming a field"];
  return issues.map((i) => `${i.path.length > 0 ? i.path.map(String).join(".") : "(root)"}: ${i.message}`);
}
