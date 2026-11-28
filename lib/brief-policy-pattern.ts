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
  const label = typeof name === "string" ? JSON.stringify(name) : "an entry with no name";
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
