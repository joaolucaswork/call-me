/**
 * Session Manager
 *
 * Manages inbound call sessions via filesystem (~/lein-workspace/sessions/).
 * When a call arrives and no Claude Code session is connected,
 * writes session files that a spawned Claude process can read.
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { SESSIONS_DIR } from './workspace.js';

export interface InboundSession {
  callId: string;
  from: string;
  transcript: string;
  timestamp: number;
  status: 'pending' | 'claimed' | 'completed';
  claimedBy?: string;  // PID of the Claude process that claimed it
}

function ensureDir(): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

export function writeSession(session: InboundSession): string {
  ensureDir();
  const filePath = join(SESSIONS_DIR, `${session.callId}.json`);
  writeFileSync(filePath, JSON.stringify(session, null, 2));
  console.error(`[Sessions] Wrote session: ${filePath}`);
  return filePath;
}

export function readSession(callId: string): InboundSession | null {
  const filePath = join(SESSIONS_DIR, `${callId}.json`);
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function claimSession(callId: string, pid: number): boolean {
  const session = readSession(callId);
  if (!session || session.status !== 'pending') return false;
  session.status = 'claimed';
  session.claimedBy = String(pid);
  writeFileSync(join(SESSIONS_DIR, `${callId}.json`), JSON.stringify(session, null, 2));
  console.error(`[Sessions] Session ${callId} claimed by PID ${pid}`);
  return true;
}

export function completeSession(callId: string): void {
  const filePath = join(SESSIONS_DIR, `${callId}.json`);
  try {
    unlinkSync(filePath);
    console.error(`[Sessions] Session ${callId} completed and removed`);
  } catch {
    // Already removed
  }
}

export function getPendingSessions(): InboundSession[] {
  ensureDir();
  const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  const sessions: InboundSession[] = [];
  const now = Date.now();

  for (const file of files) {
    try {
      const session: InboundSession = JSON.parse(readFileSync(join(SESSIONS_DIR, file), 'utf8'));
      // Clean up stale sessions (older than 5 minutes)
      if (now - session.timestamp > 5 * 60 * 1000) {
        unlinkSync(join(SESSIONS_DIR, file));
        continue;
      }
      if (session.status === 'pending') {
        sessions.push(session);
      }
    } catch {
      // Corrupted file, skip
    }
  }
  return sessions;
}

export function cleanupAllSessions(): void {
  ensureDir();
  const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try { unlinkSync(join(SESSIONS_DIR, file)); } catch {}
  }
}
