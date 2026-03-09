/**
 * Lein Claude Spawner
 *
 * Spawns Claude Code CLI sessions when inbound calls or WhatsApp messages
 * arrive. Supports multiple simultaneous sessions (OpenClaw-style).
 * Each session runs in ~/lein-workspace/ with global memory and project list.
 */

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { join } from 'path';
import { homedir } from 'os';
import { type InboundSession, claimSession } from './session-manager.js';
import { listProjects, readMemory, WORKSPACE_DIR, ensureWorkspace } from './workspace.js';
import type { WhatsAppMessage } from './whatsapp.js';
import { getContextForSpawn, isMem0Configured } from './mem0.js';

const CLAUDE_BIN = join(homedir(), '.local', 'bin', 'claude');

interface SpawnedSession {
  pid: number;
  sessionId: string;
  source: 'call' | 'whatsapp';
  startedAt: number;
  phone?: string;
  claudeSessionId?: string; // UUID used with --session-id / --resume
}

// Track persistent Claude session UUIDs per user phone number
// Maps phone → { uuid, lastUsed } so we can resume sessions
const persistentSessions = new Map<string, { uuid: string; lastUsed: number }>();

// Sessions older than 2h get a fresh start
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

function getOrCreateSessionUuid(phone: string, forceNew = false): { uuid: string; isResume: boolean } {
  const existing = persistentSessions.get(phone);

  if (existing && !forceNew) {
    const age = Date.now() - existing.lastUsed;
    if (age < SESSION_TTL_MS) {
      existing.lastUsed = Date.now();
      return { uuid: existing.uuid, isResume: true };
    }
    // Session expired — create fresh
    console.error(`[Lein:Spawner] Session for ${phone} expired (${Math.round(age / 60000)}min), creating new`);
  }

  // New session — use timestamp in hash to get unique UUID each time
  const seed = forceNew || !existing
    ? `lein-session:${phone}:${Date.now()}`
    : `lein-session:${phone}`;
  const hash = createHash('sha256').update(seed).digest('hex');
  const uuid = [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    '8' + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
  persistentSessions.set(phone, { uuid, lastUsed: Date.now() });
  return { uuid, isResume: false };
}

/**
 * Force a new session for a phone number (used by /nova command).
 */
export function resetSessionForPhone(phone: string): void {
  persistentSessions.delete(phone);
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

async function buildBasePrompt(message?: string, project?: string): Promise<string> {
  const projectList = buildProjectList();
  let memoryContent: string;

  if (isMem0Configured()) {
    const mem0Context = await getContextForSpawn(message || '', project);
    if (mem0Context) {
      memoryContent = mem0Context;
    } else {
      memoryContent = readMemory();
    }
  } else {
    memoryContent = readMemory();
  }

  return [
    `--- LEIN MEMORY ---`,
    memoryContent,
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
export async function spawnClaudeForCall(session: InboundSession): Promise<boolean> {
  ensureWorkspace();
  const baseContext = await buildBasePrompt(session.transcript);

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
    `8. WhatsApp messages sent during this call are AUTOMATICALLY delivered in the response of continue_call/speak_to_user/get_call_status (look for "pendingWhatsApp" in the JSON). Do NOT call read_whatsapp or send_whatsapp — respond to WhatsApp messages via the CALL only.`,
    `9. MEMORY: Use \`recall\` at start to get relevant context. Use \`remember\` to save important decisions, findings, and a session summary before finishing. Include the project name if working on a specific project.`,
  ].join('\n');

  return doSpawn(prompt, session.callId, 'call');
}

/**
 * Spawn a Claude Code CLI process to handle a WhatsApp message.
 * Uses persistent sessions: first message creates a session, subsequent
 * messages resume it so Claude has full conversation history.
 */
export async function spawnClaudeForWhatsApp(msg: WhatsAppMessage): Promise<boolean> {
  ensureWorkspace();
  const messageContent = msg.transcript || msg.text || msg.caption || '(media message)';
  const mediaInfo = msg.mediaLocalPath ? `\nMedia file saved at: ${msg.mediaLocalPath} (type: ${msg.mimeType})` : '';

  const { uuid, isResume } = getOrCreateSessionUuid(msg.from);

  if (isResume) {
    // Resume existing session — just send the new message as prompt
    const prompt = [
      `New WhatsApp message from ${msg.from} (${msg.type}):`,
      `"${messageContent}"${mediaInfo}`,
      ``,
      `Respond via send_whatsapp. Check read_whatsapp for any other pending messages.`,
    ].join('\n');

    console.error(`[Lein:Spawner] Resuming session ${uuid} for ${msg.from}`);
    return doSpawn(prompt, `whatsapp-${msg.id}`, 'whatsapp', msg.from, { claudeSessionId: uuid, resume: true });
  }

  // First message — create new session with full context
  const baseContext = await buildBasePrompt(messageContent);

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
    `10. MEMORY: Use \`recall\` at start to get relevant context. Use \`remember\` to save important decisions, findings, and a session summary before finishing. Include the project name if working on a specific project.`,
  ].join('\n');

  console.error(`[Lein:Spawner] Creating new session ${uuid} for ${msg.from}`);
  return doSpawn(prompt, `whatsapp-${msg.id}`, 'whatsapp', msg.from, { claudeSessionId: uuid, resume: false });
}

interface SpawnOptions {
  claudeSessionId?: string;
  resume?: boolean;
}

function doSpawn(prompt: string, sessionId: string, source: 'call' | 'whatsapp', phone?: string, options?: SpawnOptions): boolean {
  console.error(`[Lein:Spawner] Spawning Claude session ${sessionId} in ${WORKSPACE_DIR}`);

  try {
    const args = ['--dangerously-skip-permissions', '-p', prompt];

    // Persistent session support
    if (options?.claudeSessionId) {
      if (options.resume) {
        args.unshift('--resume', options.claudeSessionId);
      } else {
        args.unshift('--session-id', options.claudeSessionId);
      }
    }

    const child = spawn(CLAUDE_BIN, args, {
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
      claudeSessionId: options?.claudeSessionId,
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
