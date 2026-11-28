/**
 * The ship skill's folder, found in one place (ADR-029 decision 4, #2932).
 *
 * The skill is being renamed from `ship` to `ship-issue`. While both names
 * can exist on a machine, every read of a file in the skill's folder looks in
 * the new folder first and the old one second. Three readers built this path
 * from parts and each was missed by a hand-kept list in turn, so this module
 * is the only place in source allowed to spell it.
 * `test/ship-skill-folder.test.ts` refuses the path elsewhere in non-test
 * source whole, in parts, or with a part held in a constant in the same file.
 * A name carried in from another module is out of its reach.
 */
import { existsSync } from "fs";
import { join } from "path";

/** The skill's folder names, the new name first. */
export const SHIP_SKILL_FOLDERS = ["ship-issue", "ship"] as const;

/**
 * `file` in the ship skill's folder under `claudeDir` (a `.claude` directory):
 * the `ship-issue` copy when there is one, else the `ship` copy, else the path
 * it would have in `ship-issue`, so a reader that reports an absent file names
 * where it belongs.
 */
export function shipSkillPath(claudeDir: string, file: string): string {
  for (const folder of SHIP_SKILL_FOLDERS) {
    const candidate = join(claudeDir, "skills", folder, file);
    if (existsSync(candidate)) return candidate;
  }
  return join(claudeDir, "skills", SHIP_SKILL_FOLDERS[0], file);
}

/**
 * Every folder of the ship skill that exists under `claudeDir`, the new name
 * first. For a sweep of the whole skill: `shipSkillPath` gives one answer,
 * and while both names exist that answer would leave the other folder unread
 * (review of #2952).
 */
export function shipSkillFolders(claudeDir: string): string[] {
  return SHIP_SKILL_FOLDERS.map(folder => join(claudeDir, "skills", folder)).filter(dir => existsSync(dir));
}
