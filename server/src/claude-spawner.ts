/**
 * Claude Spawner
 *
 * Auto-spawns a Claude Code CLI session when an inbound call arrives
 * and no active Claude session is connected. Uses project-scanner to
 * gather context about the most recent project before spawning.
 */

import { spawn } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { InboundSession, claimSession } from './session-manager.js';
import { findMostRecentProject, formatProjectSummary } from './project-scanner.js';

const CLAUDE_BIN = join(homedir(), '.local', 'bin', 'claude');

// Track spawned processes to avoid duplicates
let activeSpawn: { pid: number; callId: string } | null = null;

/**
 * Spawn a Claude Code CLI process to handle an inbound call.
 */
export function spawnClaudeForCall(session: InboundSession): boolean {
  // Don't spawn if there's already an active spawn
  if (activeSpawn) {
    console.error(`[Spawner] Already have active spawn (PID ${activeSpawn.pid}) for call ${activeSpawn.callId}, skipping`);
    return false;
  }

  const project = findMostRecentProject();
  if (!project) {
    console.error('[Spawner] No project found in ~/Documents/GitHub/');
    return false;
  }

  const summary = formatProjectSummary(project);
  console.error(`[Spawner] Most recent project: ${project.name} (${project.path})`);

  const prompt = [
    `URGENT: There is an active inbound phone call waiting for you!`,
    ``,
    `Call ID: ${session.callId}`,
    `Caller: ${session.from}`,
    `They said: "${session.transcript}"`,
    ``,
    `--- PROJECT CONTEXT ---`,
    summary,
    `--- END PROJECT CONTEXT ---`,
    ``,
    `INSTRUCTIONS:`,
    `1. Use continue_call with call_id="${session.callId}" to respond to the caller immediately`,
    `2. Greet them and present what you found about the project "${project.name}":`,
    `   - What the project is about (from description)`,
    `   - What was worked on recently (from commits)`,
    `   - Any pending changes (from git status)`,
    `3. Ask what they'd like to work on`,
    `4. Keep the call active and follow the caller's instructions`,
    `5. If the caller hangs up, wait for them to call back`,
    `6. Do NOT end the call unless explicitly asked to`,
  ].join('\n');

  console.error(`[Spawner] Spawning Claude CLI in ${project.path}...`);

  try {
    const child = spawn(CLAUDE_BIN, [
      '--dangerously-skip-permissions',
      '--print',
      prompt,
    ], {
      cwd: project.path,
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
