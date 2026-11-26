/**
 * Regression tests for AgentBriefGuard.hook.ts — the ship-active check
 * Covers:
 *   1. Engineer ALLOWED with an advisory when no .ship-active marker exists (#2881)
 *   2. Engineer ALLOWED, with no advisory, when a valid marker exists (< 4 hours old)
 *   3. Engineer ALLOWED with the advisory when the marker is > 4 hours old (#2881)
 *   4. Quinn/Rook NOT affected by ship-active check (they pass without marker)
 *   5. The permission-mode refusal still blocks an Engineer with no ship session
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { validateAgentBrief } from '../../lib/agent-brief-validation';

let tempDir: string;
let workDir: string;
let signalsDir: string;

const origPaiDir = process.env.PAI_DIR;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'ship-guard-test-'));
  workDir = join(tempDir, 'MEMORY', 'WORK');
  signalsDir = join(tempDir, 'MEMORY', 'LEARNING', 'SIGNALS');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(signalsDir, { recursive: true });
  // Create signals.jsonl so logSignal doesn't skip
  writeFileSync(join(signalsDir, 'signals.jsonl'), '');
  process.env.PAI_DIR = tempDir;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  if (origPaiDir !== undefined) {
    process.env.PAI_DIR = origPaiDir;
  } else {
    delete process.env.PAI_DIR;
  }
});

// ─── Reimplementation of checkShipActive matching the expected hook behavior ───

interface ShipMarker {
  issue: number;
  ts: string;
}

function checkShipActive(testWorkDir: string): ShipMarker | null {
  if (!existsSync(testWorkDir)) return null;

  const markers: ShipMarker[] = [];

  try {
    const entries = readdirSync(testWorkDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const markerPath = join(testWorkDir, entry.name, '.ship-active');
      if (!existsSync(markerPath)) continue;

      try {
        const raw = readFileSync(markerPath, 'utf-8');
        const parsed = JSON.parse(raw) as ShipMarker;
        if (parsed.issue && parsed.ts) {
          markers.push(parsed);
        }
      } catch {
        // Skip malformed markers
      }
    }
  } catch {
    return null;
  }

  if (markers.length === 0) return null;

  // Return most recent by ts
  markers.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  return markers[0];
}

function isMarkerStale(marker: ShipMarker, maxAgeMs = 4 * 60 * 60 * 1000): boolean {
  const age = Date.now() - new Date(marker.ts).getTime();
  return age > maxAgeMs;
}

// Helper: create a .ship-active marker
function createShipMarker(dirName: string, issue: number, ts: string) {
  const dir = join(workDir, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.ship-active'), JSON.stringify({ issue, ts }));
}

// Helper: create a CHECKPOINT.md with sizing (needed for existing checks)
function createCheckpointWithSizing(dirName: string, size: string) {
  const dir = join(workDir, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'CHECKPOINT.md'), `# Checkpoint\n**Size:** ${size}\n`);
}

describe('AgentBriefGuard — ship-active enforcement', () => {

  describe('checkShipActive function', () => {
    it('returns null when no .ship-active markers exist', () => {
      mkdirSync(join(workDir, '65-some-work'), { recursive: true });
      const result = checkShipActive(workDir);
      expect(result).toBeNull();
    });

    it('returns marker when valid .ship-active exists', () => {
      const now = new Date().toISOString();
      createShipMarker('65-engineer-guard', 65, now);
      const result = checkShipActive(workDir);
      expect(result).not.toBeNull();
      expect(result!.issue).toBe(65);
      expect(result!.ts).toBe(now);
    });

    it('returns most recent marker when multiple exist', () => {
      const older = '2026-06-29T10:00:00Z';
      const newer = '2026-06-29T14:00:00Z';
      createShipMarker('60-old-work', 60, older);
      createShipMarker('65-new-work', 65, newer);
      const result = checkShipActive(workDir);
      expect(result).not.toBeNull();
      expect(result!.issue).toBe(65);
      expect(result!.ts).toBe(newer);
    });

    it('returns null when WORK_DIR does not exist', () => {
      rmSync(workDir, { recursive: true, force: true });
      const result = checkShipActive(workDir);
      expect(result).toBeNull();
    });

    it('skips malformed marker files', () => {
      const dir = join(workDir, '65-bad-marker');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.ship-active'), 'not json');
      const result = checkShipActive(workDir);
      expect(result).toBeNull();
    });
  });

  describe('isMarkerStale', () => {
    it('marker < 4 hours old is NOT stale', () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const marker: ShipMarker = { issue: 65, ts: twoHoursAgo };
      expect(isMarkerStale(marker)).toBe(false);
    });

    it('marker > 4 hours old IS stale', () => {
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
      const marker: ShipMarker = { issue: 65, ts: fiveHoursAgo };
      expect(isMarkerStale(marker)).toBe(true);
    });

    it('marker slightly over 4 hours is stale', () => {
      const slightlyOver = new Date(Date.now() - 4 * 60 * 60 * 1000 - 1000).toISOString();
      const overMarker: ShipMarker = { issue: 65, ts: slightlyOver };
      expect(isMarkerStale(overMarker)).toBe(true);
    });
  });

  describe('Integration: hook blocks/allows Engineer spawns', () => {
    const hookPath = join(import.meta.dir, '..', '..', 'hooks', 'AgentBriefGuard.hook.ts');

    // Build a valid agent payload with correct template markers
    function makePayload(agentType: string, extras: Record<string, unknown> = {}) {
      const markers: Record<string, string[]> = {
        Engineer: ['## Context', '## Task', '## Verify', '## Report back'],
        QATester: ['## Context', '## Environment', '## Test scenarios'],
        Pentester: ['## Context', '## Scan scope', '## Report'],
      };

      const prompt = (markers[agentType] || []).join('\n\nContent here.\n\n');
      return JSON.stringify({
        tool_name: 'Agent',
        tool_input: {
          prompt,
          subagent_type: agentType,
          mode: 'bypassPermissions',
          ...extras,
        },
      });
    }

    // #2881: an agent working an issue outside a ship run may use the
    // Engineer; it is told what a ship run would have added instead.
    it('ALLOWS Engineer with an advisory when no .ship-active marker exists (#2881)', async () => {
      const proc = Bun.spawn(['bun', 'run', hookPath], {
        stdin: Buffer.from(makePayload('Engineer')),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, PAI_DIR: tempDir, RUNGATE_WORK_DIR: workDir, HOOK_EVENT: 'PreToolUse' },
      });

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      expect(stdout).not.toContain('"decision":"block"');
      expect(stdout).toContain('ADVISORY: no ship session');
      expect(stderr).toContain('spawn validated');
      expect(stderr).not.toContain('BLOCKED');
    });

    it('ALLOWS Engineer when valid .ship-active marker exists', async () => {
      const now = new Date().toISOString();
      createShipMarker('65-engineer-guard', 65, now);
      createCheckpointWithSizing('65-engineer-guard', 'S');

      const proc = Bun.spawn(['bun', 'run', hookPath], {
        stdin: Buffer.from(makePayload('Engineer')),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, PAI_DIR: tempDir, RUNGATE_WORK_DIR: workDir, HOOK_EVENT: 'PreToolUse' },
      });

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      expect(stdout).not.toContain('"decision":"block"');
      expect(stdout).toContain('system-reminder');
      expect(stderr).toContain('spawn validated');
    });

    it('ALLOWS Engineer with the advisory when the marker is stale (> 4 hours old) (#2881)', async () => {
      const staleTs = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
      createShipMarker('65-engineer-guard', 65, staleTs);

      const proc = Bun.spawn(['bun', 'run', hookPath], {
        stdin: Buffer.from(makePayload('Engineer')),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, PAI_DIR: tempDir, RUNGATE_WORK_DIR: workDir, HOOK_EVENT: 'PreToolUse' },
      });

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      expect(stdout).not.toContain('"decision":"block"');
      expect(stdout).toContain('ADVISORY: no ship session');
      expect(stderr).toContain('spawn validated');
    });

    it('ALLOWS Engineer with no advisory when a valid marker exists (#2881)', async () => {
      createShipMarker('65-engineer-guard', 65, new Date().toISOString());
      const proc = Bun.spawn(['bun', 'run', hookPath], {
        stdin: Buffer.from(makePayload('Engineer')),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, PAI_DIR: tempDir, RUNGATE_WORK_DIR: workDir, HOOK_EVENT: 'PreToolUse' },
      });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      expect(stdout).not.toContain('"decision":"block"');
      expect(stdout).not.toContain('ADVISORY: no ship session');
    });

    it('Quinn NOT affected — passes with active ship session', async () => {
      const now = new Date().toISOString();
      createShipMarker('65-engineer-guard', 65, now);

      const proc = Bun.spawn(['bun', 'run', hookPath], {
        stdin: Buffer.from(makePayload('QATester')),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, PAI_DIR: tempDir, RUNGATE_WORK_DIR: workDir, HOOK_EVENT: 'PreToolUse' },
      });

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      expect(stdout).not.toContain('"decision":"block"');
      expect(stdout).toContain('system-reminder');
      expect(stderr).toContain('spawn validated');
    });

    it('Rook NOT affected — passes with active ship session', async () => {
      const now = new Date().toISOString();
      createShipMarker('65-engineer-guard', 65, now);

      const proc = Bun.spawn(['bun', 'run', hookPath], {
        stdin: Buffer.from(makePayload('Pentester')),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, PAI_DIR: tempDir, RUNGATE_WORK_DIR: workDir, HOOK_EVENT: 'PreToolUse' },
      });

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      expect(stdout).not.toContain('"decision":"block"');
      expect(stdout).toContain('system-reminder');
      expect(stderr).toContain('spawn validated');
    });
  });

  // #2881: what the decision itself returns, read without the hook process.
  describe('validateAgentBrief: no ship session is an advisory, not a refusal (#2881)', () => {
    const brief = (mode: string | undefined) => ({
      tool_name: 'Agent',
      tool_input: {
        prompt: ['## Context', '## Task', '## Verify', '## Report back'].join('\n\nContent here.\n\n'),
        subagent_type: 'Engineer',
        ...(mode ? { mode } : {}),
      },
    });

    it('passes, names what a ship run adds, and logs an unblocked no_ship_session signal', () => {
      const r = validateAgentBrief(brief('bypassPermissions') as never, workDir, tempDir);
      expect(r.action).toBe('pass');
      const advisory = r.outputs.find(o => o.startsWith('ADVISORY: no ship session'));
      expect(advisory).toBeDefined();
      for (const word of ['scope', 'criteria', 'discovery', 'sizing']) expect(advisory!.toLowerCase()).toContain(word);
      expect(r.signalEvents).toContainEqual(expect.objectContaining({
        type: 'agent_spawn_advisory', agent: 'marcus', blocked: false, advisory_reason: 'no_ship_session',
      }));
      expect(r.signalEvents.some(e => e.blocked === true)).toBe(false);
    });

    it('a fresh marker gives no advisory and no no_ship_session signal', () => {
      createShipMarker('65-engineer-guard', 65, new Date().toISOString());
      const r = validateAgentBrief(brief('bypassPermissions') as never, workDir, tempDir);
      expect(r.action).toBe('pass');
      expect(r.outputs.some(o => o.startsWith('ADVISORY: no ship session'))).toBe(false);
      expect(r.signalEvents.some(e => e.advisory_reason === 'no_ship_session')).toBe(false);
    });

    // #2899 review round 1: a marker whose date cannot be read is no evidence
    // of a session, at either reader; and a stale marker must not hide a live
    // ship run's workflow-state.json.
    it('a marker with an unreadable date is no session: the advisory is printed', () => {
      createShipMarker('65-bad-date', 65, 'not-a-date');
      const r = validateAgentBrief(brief('bypassPermissions') as never, workDir, tempDir);
      expect(r.outputs.some(o => o.startsWith('ADVISORY: no ship session'))).toBe(true);
    });

    it('an unreadable date beside a fresh marker does not hide the fresh one', () => {
      createShipMarker('65-bad-date', 65, 'yesterday');
      createShipMarker('66-fresh', 66, new Date().toISOString());
      const r = validateAgentBrief(brief('bypassPermissions') as never, workDir, tempDir);
      expect(r.outputs.some(o => o.startsWith('ADVISORY: no ship session'))).toBe(false);
    });

    it('a stale marker does not hide a live ship run in workflow-state.json', () => {
      createShipMarker('60-old', 60, new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString());
      mkdirSync(join(workDir, '66-live'), { recursive: true });
      writeFileSync(join(workDir, '66-live', 'workflow-state.json'), JSON.stringify({ issue: 66, phase: 'BUILD' }));
      const r = validateAgentBrief(brief('bypassPermissions') as never, workDir, tempDir);
      expect(r.outputs.some(o => o.startsWith('ADVISORY: no ship session'))).toBe(false);
      expect(r.signalEvents.some(e => e.advisory_reason === 'no_ship_session')).toBe(false);
    });

    it('the permission-mode refusal is unchanged with no ship session', () => {
      const r = validateAgentBrief(brief(undefined) as never, workDir, tempDir);
      expect(r.action).toBe('block');
      expect(r.blockReason).toContain('bypassPermissions');
      expect(r.signalEvents).toContainEqual(expect.objectContaining({ blocked: true, block_reason: 'missing_bypass_permissions' }));
    });
  });
});
