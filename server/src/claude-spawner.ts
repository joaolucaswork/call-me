/**
 * Claude Spawner
 *
 * Auto-spawns a Claude Code CLI session when an inbound call arrives
 * and no active Claude session is connected. Finds the most recently
 * modified project in ~/Documents/GitHub/ to use as working directory.
 */

import { spawn } from 'child_process';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { InboundSession, claimSession } from './session-manager.js';

const CLAUDE_BIN = join(homedir(), '.local', 'bin', 'claude');
const GITHUB_DIR = join(homedir(), 'Documents', 'GitHub');

// Track spawned processes to avoid duplicates
let activeSpawn: { pid: number; callId: string } | null = null;

/**
 * Find the most recently modified project directory in ~/Documents/GitHub/
 */
function findMostRecentProject(): string | null {
  try {
    const entries = readdirSync(GITHUB_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'));

    let newest: { name: string; mtime: number } | null = null;

    for (const entry of entries) {
      const fullPath = join(GITHUB_DIR, entry.name);
      try {
        const stat = statSync(fullPath);
        if (!newest || stat.mtimeMs > newest.mtime) {
          newest = { name: entry.name, mtime: stat.mtimeMs };
        }
      } catch {
        continue;
      }
    }

    return newest ? join(GITHUB_DIR, newest.name) : null;
  } catch {
    return null;
  }
}

/**
 * Spawn a Claude Code CLI process to handle an inbound call.
 */
export function spawnClaudeForCall(session: InboundSession): boolean {
  // Don't spawn if there's already an active spawn
  if (activeSpawn) {
    console.error(`[Spawner] Already have active spawn (PID ${activeSpawn.pid}) for call ${activeSpawn.callId}, skipping`);
    return false;
  }

  const projectDir = findMostRecentProject();
  if (!projectDir) {
    console.error('[Spawner] No project found in ~/Documents/GitHub/');
    return false;
  }

  const projectName = projectDir.split('/').pop();
  console.error(`[Spawner] Most recent project: ${projectName} (${projectDir})`);

  const prompt = [
    `URGENT: There is an active inbound phone call waiting for you!`,
    ``,
    `Call ID: ${session.callId}`,
    `Caller: ${session.from}`,
    `They said: "${session.transcript}"`,
    ``,
    `You are working in the project "${projectName}" (${projectDir}).`,
    ``,
    `INSTRUCTIONS:`,
    `1. Use continue_call with call_id="${session.callId}" to respond to the caller immediately`,
    `2. After greeting them, suggest working on this project ("${projectName}")`,
    `3. Keep the call active and follow the caller's instructions`,
    `4. If the caller hangs up, wait for them to call back`,
    `5. Do NOT end the call unless explicitly asked to`,
  ].join('\n');

  console.error(`[Spawner] Spawning Claude CLI in ${projectDir}...`);

  try {
    const child = spawn(CLAUDE_BIN, [
      '--dangerously-skip-permissions',
      '--print',
      prompt,
    ], {
      cwd: projectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, HOME: homedir(), CLAUDECODE: '', CLAUDE_CODE_ENTRYPOINT: '' },
    });

    if (!child.pid) {
      console.error('[Spawner] Failed to spawn Claude process');
      return false;
    }

    activeSpawn = { pid: child.pid, callId: session.callId };
    claimSession(session.callId, child.pid);

    console.error(`[Spawner] Claude spawned with PID ${child.pid}`);

    child.stdout?.on('data', (data: Buffer) => {
      console.error(`[Claude:${child.pid}:stdout] ${data.toString().trim()}`);
    });

    child.stderr?.on('data', (data: Buffer) => {
      console.error(`[Claude:${child.pid}:stderr] ${data.toString().trim()}`);
    });

    child.on('exit', (code) => {
      console.error(`[Spawner] Claude PID ${child.pid} exited with code ${code}`);
      if (activeSpawn?.pid === child.pid) {
        activeSpawn = null;
      }
    });

    child.on('error', (err) => {
      console.error(`[Spawner] Claude spawn error:`, err.message);
      if (activeSpawn?.pid === child.pid) {
        activeSpawn = null;
      }
    });

    // Unref so the HTTP server can exit without waiting for Claude
    child.unref();

    return true;
  } catch (err) {
    console.error('[Spawner] Failed to spawn Claude:', err instanceof Error ? err.message : err);
    return false;
  }
}

export function hasActiveSpawn(): boolean {
  return activeSpawn !== null;
}

export function getActiveSpawn(): { pid: number; callId: string } | null {
  return activeSpawn;
}
