/**
 * Lein Claude Spawner
 *
 * Spawns Claude Code CLI sessions when inbound calls or WhatsApp messages
 * arrive. Supports multiple simultaneous sessions (OpenClaw-style).
 * Each session runs in ~/lein-workspace/ with global memory and project list.
 */

import { spawn } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { type InboundSession, claimSession } from './session-manager.js';
import { listProjects, readMemory, WORKSPACE_DIR, ensureWorkspace } from './workspace.js';
import { type WhatsAppMessage, getSession } from './whatsapp.js';

const CLAUDE_BIN = join(homedir(), '.local', 'bin', 'claude');

interface SpawnedSession {
  pid: number;
  sessionId: string;
  source: 'call' | 'whatsapp';
  startedAt: number;
  phone?: string;
}

// Track ALL active spawns (multi-session support)
const activeSessions = new Map<string, SpawnedSession>();

// Cleanup stale sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  for (const [id, session] of activeSessions) {
    if (now - session.startedAt > TWO_HOURS) {
      console.error(`[Lein:Spawner] Cleaning up stale session ${id} (PID ${session.pid})`);
      activeSessions.delete(id);
    }
  }
}, 5 * 60 * 1000);

function buildProjectList(): string {
  const projects = listProjects();
  if (projects.length === 0) return 'No projects found in ~/Documents/GitHub/';
  return projects.map(p => `- ${p.name} (${p.path})`).join('\n');
}

function buildBasePrompt(): string {
  const memory = readMemory();
  const projectList = buildProjectList();
  return [
    `--- LEIN MEMORY ---`,
    memory,
    `--- END MEMORY ---`,
    ``,
    `--- AVAILABLE PROJECTS ---`,
    projectList,
    `--- END PROJECTS ---`,
  ].join('\n');
}

/**
 * Spawn a Claude Code CLI process to handle an inbound call.
 */
export function spawnClaudeForCall(session: InboundSession): boolean {
  ensureWorkspace();
  const baseContext = buildBasePrompt();

  const prompt = [
    `URGENT: There is an active inbound phone call waiting for you!`,
    `You are Lein, a personal AI assistant. Treat yourself as feminine (a Lein).`,
    ``,
    `Call ID: ${session.callId}`,
    `Caller: ${session.from}`,
    `They said: "${session.transcript}"`,
    ``,
    baseContext,
    ``,
    `INSTRUCTIONS:`,
    `1. Use continue_call with call_id="${session.callId}" to respond to the caller immediately`,
    `2. Greet them warmly as Lein`,
    `3. Ask what they'd like to work on`,
    `4. Navigate to the relevant project directory if needed`,
    `5. Keep the call active and follow the caller's instructions`,
    `6. If the caller hangs up, wait for them to call back`,
    `7. Do NOT end the call unless explicitly asked to`,
    `8. Use read_whatsapp periodically to check for WhatsApp messages — the user may send text/images via WhatsApp during the call`,
    `9. If a WhatsApp notification plays on the call, immediately read_whatsapp to get the full message`,
  ].join('\n');

  return doSpawn(prompt, session.callId, 'call');
}

/**
 * Spawn a Claude Code CLI process to handle a WhatsApp message.
 */
export function spawnClaudeForWhatsApp(msg: WhatsAppMessage): boolean {
  ensureWorkspace();
  const baseContext = buildBasePrompt();
  const messageContent = msg.transcript || msg.text || msg.caption || '(media message)';
  const mediaInfo = msg.mediaLocalPath ? `\nMedia file saved at: ${msg.mediaLocalPath} (type: ${msg.mimeType})` : '';

  const prompt = [
    `You received a WhatsApp message from the user!`,
    `You are Lein, a personal AI assistant. Treat yourself as feminine (a Lein).`,
    ``,
    `From: ${msg.from}`,
    `Type: ${msg.type}`,
    `Message: "${messageContent}"${mediaInfo}`,
    ``,
    baseContext,
    ``,
    `INSTRUCTIONS:`,
    `1. Use send_whatsapp to respond to the user via WhatsApp`,
    `2. Read their message and respond helpfully`,
    `3. If they mention a project, navigate to it (see project list above)`,
    `4. If they sent audio, it has been auto-transcribed above`,
    `5. If they sent an image, you can read the file at the media path to view it`,
    `6. Use read_whatsapp periodically to check for new messages`,
    `7. Keep monitoring for new WhatsApp messages and respond to each one`,
    `8. You can also use phone calls (initiate_call) if voice communication is better`,
    `9. Send status updates via WhatsApp every 2-3 minutes during long tasks`,
  ].join('\n');

  return doSpawn(prompt, `whatsapp-${msg.id}`, 'whatsapp', msg.from);
}

function doSpawn(prompt: string, sessionId: string, source: 'call' | 'whatsapp', phone?: string): boolean {
  console.error(`[Lein:Spawner] Spawning Claude session ${sessionId} in ${WORKSPACE_DIR}`);

  try {
    const child = spawn(CLAUDE_BIN, [
      '--dangerously-skip-permissions',
      '-p',
      prompt,
    ], {
      cwd: WORKSPACE_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, HOME: homedir(), CLAUDECODE: '', CLAUDE_CODE_ENTRYPOINT: '' },
    });

    if (!child.pid) {
      console.error('[Lein:Spawner] Failed to spawn Claude process');
      return false;
    }

    activeSessions.set(sessionId, {
      pid: child.pid,
      sessionId,
      source,
      startedAt: Date.now(),
    });

    if (source === 'call') {
      claimSession(sessionId, child.pid);
    }

    console.error(`[Lein:Spawner] Claude spawned with PID ${child.pid} (session: ${sessionId})`);

    child.stdout?.on('data', (data: Buffer) => {
      console.error(`[Lein:${child.pid}:stdout] ${data.toString().trim()}`);
    });

    child.stderr?.on('data', (data: Buffer) => {
      console.error(`[Lein:${child.pid}:stderr] ${data.toString().trim()}`);
    });

    child.on('exit', (code) => {
      console.error(`[Lein:Spawner] Claude PID ${child.pid} exited with code ${code}`);
      activeSessions.delete(sessionId);
    });

    child.on('error', (err) => {
      console.error(`[Lein:Spawner] Claude spawn error:`, err.message);
      activeSessions.delete(sessionId);
    });

    child.unref();
    return true;
  } catch (err) {
    console.error('[Lein:Spawner] Failed to spawn:', err instanceof Error ? err.message : err);
    return false;
  }
}

export function hasActiveSpawn(): boolean {
  return activeSessions.size > 0;
}

export function getActiveSessions(): Map<string, SpawnedSession> {
  return activeSessions;
}

export function getActiveSessionCount(): number {
  return activeSessions.size;
}
