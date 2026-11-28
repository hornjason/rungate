/**
 * #2946: the one compiler for a brief-policy pattern. The brief guard
 * (`lib/agent-brief-validation.ts`) and the gates (`gates/brief-assembler.ts`)
 * both read `requiredPatterns` through it, so one policy file reads one way.
 *
 * The format is the one `config/brief-policies.json` ships in: a leading
 * `(?i)` means case-insensitive, which JavaScript's `RegExp` does not accept
 * inline. Without it the pattern is case-sensitive, as the gates always read
 * it. Before this the guard compiled every pattern with `new RegExp(p, 'i')`,
 * which throws on `(?i)`, so the shipped file read UNMEASURED there and fine
 * in the gates.
 *
 * An entry the compiler cannot read is refused, naming it, never compiled
 * into something that matches every brief: a missing pattern used to become
 * `new RegExp(undefined)`, an empty regex, and the policy passed silently.
 */
export type CompiledBriefPattern = { readonly ok: true; readonly re: RegExp } | { readonly ok: false; readonly why: string };

const CASE_INSENSITIVE = "(?i)";

export function compileBriefPattern(entry: unknown): CompiledBriefPattern {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return { ok: false, why: "an entry that is not an object" };
  }
  const { name, pattern } = entry as { name?: unknown; pattern?: unknown };
  // Review of #2960: the name is what a WARN reports as missing, so an entry
  // without one is refused rather than warned about as nothing.
  if (typeof name !== "string" || name.trim() === "") {
    return { ok: false, why: `an entry with no name (its pattern is ${JSON.stringify(pattern) ?? "absent"})` };
  }
  const label = JSON.stringify(name);
  if (pattern === undefined) return { ok: false, why: `${label} has no pattern` };
  if (typeof pattern !== "string") {
    return { ok: false, why: `${label} has a pattern that is ${pattern === null ? "null" : typeof pattern}, not a string` };
  }
  const insensitive = pattern.startsWith(CASE_INSENSITIVE);
  const source = insensitive ? pattern.slice(CASE_INSENSITIVE.length) : pattern;
  // An empty pattern matches every brief, which is no requirement at all.
  if (source === "") return { ok: false, why: `${label} has an empty pattern, which matches every brief` };
  try {
    return { ok: true, re: new RegExp(source, insensitive ? "i" : "") };
  } catch (e) {
    return { ok: false, why: `the pattern for ${label} is not a regular expression (${(e as Error).message})` };
  }
}

export type CompiledBriefPolicy =
  | { readonly ok: true; readonly patterns: readonly { readonly name: string; readonly re: RegExp }[] }
  | { readonly ok: false; readonly why: string };

/**
 * One agent's `requiredPatterns`, every entry compiled before any is tested
 * (review of #2960). The gates stopped at the first pattern a brief missed,
 * so an unreadable entry later in the list was never named. A list that is
 * absent, not an array or empty is refused too: an empty policy set passes
 * every brief and cannot be told apart from no validation at all, which the
 * gates refused and the guard read as clean.
 */
export function compileBriefPolicy(requiredPatterns: unknown): CompiledBriefPolicy {
  if (!Array.isArray(requiredPatterns) || requiredPatterns.length === 0) {
    return {
      ok: false,
      why:
        `declares no requiredPatterns (${Array.isArray(requiredPatterns) ? "an empty list" : JSON.stringify(requiredPatterns) ?? "absent"}). ` +
        `An empty policy set passes every brief and cannot be told apart from no validation at all`,
    };
  }
  const patterns: { name: string; re: RegExp }[] = [];
  for (const entry of requiredPatterns) {
    const compiled = compileBriefPattern(entry);
    if (!compiled.ok) return compiled;
    patterns.push({ name: (entry as { name: string }).name, re: compiled.re });
  }
  return { ok: true, patterns };
}
