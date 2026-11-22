/**
 * Agent briefs generator — reads template files from templates/agent-briefs/
 * and fills variables from ProjectScan data.
 *
 * Extracted from scaffold-project.ts per SCAFFOLD-DECOMPOSITION-SPEC (D-2)
 * and AGENT-BRIEF-TEMPLATE-SPEC (SC-348).
 */
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, dirname, relative, sep } from "path";
import type { ProjectScan, AgentMeta } from "./types";
import { RUNGATE_CONFIG_RELATIVE_PATH, resolveConfig } from "../config-loader";
import { buildAgentMeta, DEFAULT_AGENT_META } from "../create-brief";

/**
 * Resolve the templates directory. Checks:
 * 1. Explicit harnessTemplatesDir from scan
 * 2. Relative to this file's location (lib/generators/ -> ../../templates/agent-briefs/)
 */
function resolveTemplatesDir(scan: ProjectScan): string {
  if (scan.harnessTemplatesDir && existsSync(scan.harnessTemplatesDir)) {
    return scan.harnessTemplatesDir;
  }
  // Default: relative to this module (lib/generators/../../templates/agent-briefs/)
  const fallback = join(dirname(dirname(__dirname)), "templates", "agent-briefs");
  return fallback;
}

/**
 * Generate all agent briefs from templates/agent-briefs/ templates.
 *
 * Returns a record mapping agent name to generated brief content.
 * Does NOT write files — caller decides where to write.
 */
/**
 * #2621: the rungate config file this consumer has, as a path from its root —
 * the one a brief tells its agent to read. The monolith's own path when that
 * is the layout in use (the scaffold keeps it and never rewrites it), the
 * directory layout's file otherwise, including a project with no config yet,
 * which the scaffold gives the directory layout. Asked of the loader, so no
 * generator spells either path.
 */
export function briefConfigFile(root: string): string {
  const resolved = resolveConfig(root);
  const rel = resolved.status === "resolved" && resolved.source === "monolith"
    ? relative(root, resolved.path)
    : RUNGATE_CONFIG_RELATIVE_PATH;
  return rel.split(sep).join("/");
}

export function generateAgentBriefs(scan: ProjectScan): Record<string, string> {
  const templatesDir = resolveTemplatesDir(scan);
  const result: Record<string, string> = {};

  if (!existsSync(templatesDir)) {
    return result;
  }

  // Load shared rules partial
  const sharedRulesPath = join(templatesDir, "_shared.md");
  let sharedRules = existsSync(sharedRulesPath)
    ? readFileSync(sharedRulesPath, "utf-8").trim()
    : "";
  // Strip frontmatter from partials
  sharedRules = sharedRules.replace(/^---[\s\S]*?---\n*/, "");

  // Build project identity section
  const identitySection = scan.identity
    ? `## Project\n\n${scan.identity}\n`
    : "";

  // Build source dirs list, under a heading that says what it is (#2567):
  // the bare bullets used to land at the end of the Testing Rules list. No
  // directories, no heading, so nothing sits over an empty list.
  const dirList = scan.sourceDirs.length > 0
    ? "## Source Directories\n\nThe project's source code lives in these directories:\n\n" +
      scan.sourceDirs.map(d => `- \`${d}/\``).join("\n")
    : "";

  // Build consumer note
  const consumerNote = scan.consumers.length > 0
    ? `\n## Consumers (${scan.consumers.length})\n\n${scan.consumers.map(c => `- ${c}`).join("\n")}\n\nCheck cascade impact when modifying shared modules.\n`
    : "";

  // Harness config shortcuts
  const harness = scan.harnessConfig;
  const devUi = harness?.dev?.uiBase || null;
  const devApi = harness?.dev?.apiBase || null;
  // #488 — `scan.testCmd` already IS the decision: `testCommandDecision`
  // puts `dev.testCmd` on its first rung, so re-asking here was a second
  // ladder that could disagree with the first and never be noticed.
  const testCmd = scan.testCmd || "bun test";
  const configFile = briefConfigFile(scan.root);
  const typeCheck = harness?.dev?.typeCheck || "bunx tsc --noEmit";
  const pages = harness?.pages || {};
  const pagesTable = Object.keys(pages).length > 0
    ? "### Pages Map\n\n| Path | Page |\n|------|------|\n" +
      Object.entries(pages).map(([k, v]) => `| ${v} | ${k} |`).join("\n")
    : "";

  // Agent metadata: config > scan > defaults (AC-4: no hardcoded meta in this file)
  const harnessAgentMeta = buildAgentMeta(harness);
  const agentMeta: Record<string, AgentMeta> = { ...DEFAULT_AGENT_META, ...harnessAgentMeta, ...(scan.agentMeta || {}) };

  // Discover template files (excludes _shared.md partial)
  const templateFiles = readdirSync(templatesDir)
    .filter(f => f.endsWith(".md") && !f.startsWith("_"));

  for (const templateFile of templateFiles) {
    const agentName = templateFile.replace(".md", "");
    const templatePath = join(templatesDir, templateFile);

    let content = readFileSync(templatePath, "utf-8");
    // Strip any hook-injected frontmatter from template
    content = content.replace(/^---[\s\S]*?---\n*/, "");

    // Apply variable substitution
    content = content.replace(/\$\{PROJECT_IDENTITY\}/g, identitySection);
    content = content.replace(/\$\{SHARED_RULES\}/g, sharedRules);
    content = content.replace(/\$\{SOURCE_DIRS\}/g, dirList);
    content = content.replace(/\$\{CONSUMERS\}/g, consumerNote);
    content = content.replace(/\$\{PROMPT_PREFIX\}/g, scan.promptPrefix);
    content = content.replace(/\$\{DEV_UI_LINE\}/g, devUi ? `- **Dev UI:** ${devUi}` : `- **Dev UI:** not configured — check ${configFile}`);
    content = content.replace(/\$\{DEV_API_LINE\}/g, devApi ? `- **Dev API:** ${devApi}` : `- **Dev API:** not configured — check ${configFile}`);
    content = content.replace(/\$\{CONFIG_FILE\}/g, configFile);
    content = content.replace(/\$\{PAGES_TABLE\}/g, pagesTable);
    content = content.replace(/\$\{TEST_CMD\}/g, testCmd);
    content = content.replace(/\$\{TYPE_CHECK\}/g, typeCheck);

    // Prepend frontmatter with agent metadata
    const meta = agentMeta[agentName];
    if (meta) {
      let fm = `---\nname: ${agentName}\ndescription: ${meta.description}\ntools: ${meta.tools}\nmodel: ${meta.model}`;
      if (meta.memory) fm += `\nmemory: ${meta.memory}`;
      if (meta.maxTurns) fm += `\nmaxTurns: ${meta.maxTurns}`;
      if (meta.effort) fm += `\neffort: ${meta.effort}`;
      if (meta.isolation) fm += `\nisolation: ${meta.isolation}`;
      if (meta.omitClaudeMd) fm += `\nomitClaudeMd: true`;
      if (meta.disallowedTools?.length) fm += `\ndisallowedTools: [${meta.disallowedTools.join(", ")}]`;
      if (meta.hooks) fm += `\nhooks:\n${JSON.stringify(meta.hooks, null, 2).split("\n").map((l, i) => i === 0 ? "" : `  ${l}`).filter(Boolean).join("\n")}`;
      if (meta.tiers) {
        fm += `\ntiers:`;
        for (const [tier, sections] of Object.entries(meta.tiers)) {
          fm += `\n  ${tier}: [${sections.map(s => `'${s}'`).join(", ")}]`;
        }
      }
      fm += `\n---\n\n`;
      content = fm + content;
    }

    // Append prompt routing section if available
    const prompts = scan.promptRouting[agentName] || [];
    if (prompts.length > 0) {
      content += `\n## Reference (read when needed)\n\n| Prompt | When to Read |\n|--------|-------------|\n`;
      content += prompts.map(p => `| ${p.file} | ${p.when} |`).join("\n") + "\n";
    }

    result[agentName] = content;
  }

  return result;
}
