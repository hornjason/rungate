/**
 * Centralized Path Resolution
 *
 * Handles environment variable expansion for portable PAI configuration.
 * Claude Code doesn't expand $HOME in settings.json env values, so we do it here.
 *
 * Usage:
 *   import { getPaiDir, getSettingsPath } from './lib/paths';
 *   const paiDir = getPaiDir(); // Always returns expanded absolute path
 */

import { homedir } from 'os';
import { join } from 'path';

/**
 * Expand shell variables in a path string
 * Supports: $HOME, ${HOME}, ~
 */
export function expandPath(path: string): string {
  const home = homedir();

  return path
    .replace(/^\$HOME(?=\/|$)/, home)
    .replace(/^\$\{HOME\}(?=\/|$)/, home)
    .replace(/^~(?=\/|$)/, home);
}

/**
 * Get the PAI directory (expanded)
 * Priority: PAI_DIR env var (expanded) → ~/.claude
 */
export function getPaiDir(): string {
  const envPaiDir = process.env.PAI_DIR;

  if (envPaiDir) {
    return expandPath(envPaiDir);
  }

  return join(homedir(), '.claude');
}

/**
 * Get the settings.json path
 */
export function getSettingsPath(): string {
  return join(getPaiDir(), 'settings.json');
}

/**
 * Get a path relative to PAI_DIR
 */
export function paiPath(...segments: string[]): string {
  return join(getPaiDir(), ...segments);
}

/**
 * Get the hooks directory
 * Priority: PAI_HOOKS_DIR env var → ~/.pai/hooks
 */
export function getHooksDir(): string {
  const envHooksDir = process.env.PAI_HOOKS_DIR;
  if (envHooksDir) return expandPath(envHooksDir);
  return join(homedir(), '.pai', 'hooks');
}

/**
 * Get the skills directory
 */
export function getSkillsDir(): string {
  return paiPath('skills');
}

/**
 * Get the MEMORY directory
 */
export function getMemoryDir(): string {
  return paiPath('MEMORY');
}

/**
 * Get the PAI work directory (expanded)
 * Priority: RUNGATE_WORK_DIR → PAI_WORK_DIR → ~/.rungate, each expanded.
 *
 * `PAI_WORK_DIR` is the fallback six siblings already spell — VerifyPhaseLock,
 * StaleTTLCleanup, AgentVerdictCapture, findWorkflow, issue-filing-gate and
 * local-review-rounds — and this function did not, so a tree setting only
 * `PAI_WORK_DIR` sent these callers to `~/.rungate` while the rest of the
 * harness used the override (#1668).
 *
 * This is the ONE binding for the question. `hooks/lib/utils.ts` used to
 * declare a second one as `join(RUNGATE_WORK_DIR || HOME, '.rungate')` — the
 * `join` outside the `||`, so an absolute override resolved to
 * `$RUNGATE_WORK_DIR/.rungate` — and it now re-exports this instead of
 * carrying a ninth copy of the expression.
 */
export function getWorkDir(): string {
  const envWorkDir = process.env.RUNGATE_WORK_DIR || process.env.PAI_WORK_DIR;

  if (envWorkDir) {
    return expandPath(envWorkDir);
  }

  return join(homedir(), '.rungate');
}

/**
 * Get a path relative to WORK_DIR
 */
export function workPath(...segments: string[]): string {
  return join(getWorkDir(), ...segments);
}

/**
 * Get the signals directory
 */
export function getSignalDir(): string {
  return workPath('signals');
}

// Convenience constants (evaluated once at module load)
export const BASE_DIR = getPaiDir();
export const WORK_DIR = getWorkDir();
export const SIGNAL_DIR = getSignalDir();
