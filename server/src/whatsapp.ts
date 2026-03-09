/**
 * WhatsApp Module for Lein
 *
 * Uses Kapso as a proxy to WhatsApp Business API.
 * Supports sending/receiving text, audio, and images.
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MEDIA_DIR, SESSIONS_DIR } from './workspace.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Kapso config
const KAPSO_API_KEY = process.env.LEIN_KAPSO_API_KEY || '';
const KAPSO_PHONE_NUMBER_ID = process.env.LEIN_KAPSO_PHONE_NUMBER_ID || '';
const KAPSO_API_URL = 'https://api.kapso.ai/meta/whatsapp/v24.0';
const KAPSO_PLATFORM_URL = 'https://api.kapso.ai/platform/v1';

// WhatsApp message length limit
const MAX_MESSAGE_LENGTH = 4000;

// Idle timeout for sessions (2 hours)
const SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export interface WhatsAppMessage {
  id: string;
  from: string;
  timestamp: number;
  type: 'text' | 'audio' | 'image' | 'video' | 'document' | 'reaction' | 'unknown';
  text?: string;
  mediaUrl?: string;
  mediaLocalPath?: string;
  mimeType?: string;
  caption?: string;
  transcript?: string; // For audio messages after transcription
}

export interface WhatsAppConfig {
  apiKey: string;
  phoneNumberId: string;
  userPhoneNumber: string;
  openaiApiKey: string;
}

export function loadWhatsAppConfig(): WhatsAppConfig | null {
  if (!KAPSO_API_KEY || !KAPSO_PHONE_NUMBER_ID) {
    return null;
  }
  return {
    apiKey: KAPSO_API_KEY,
    phoneNumberId: KAPSO_PHONE_NUMBER_ID,
    userPhoneNumber: process.env.LEIN_USER_PHONE_NUMBER || '',
    openaiApiKey: process.env.LEIN_OPENAI_API_KEY || '',
  };
}

/**
 * In-memory store for received messages (newest first)
 */
const receivedMessages: WhatsAppMessage[] = [];
const MAX_STORED_MESSAGES = 100;

/**
 * Callbacks for new message notifications
 */
type MessageCallback = (msg: WhatsAppMessage) => void;
const messageCallbacks: MessageCallback[] = [];

export function onNewMessage(cb: MessageCallback) {
  messageCallbacks.push(cb);
}

function notifyNewMessage(msg: WhatsAppMessage) {
  for (const cb of messageCallbacks) {
    try { cb(msg); } catch {}
  }
}

// ─── Message prefix parsing ───

export interface ParsedMessage {
  prefix: 'nova' | 'session' | 'sessoes' | null;
  sessionName: string | null;
  cleanMessage: string;
  originalMessage: string;
}

/**
 * Parse WhatsApp message for command prefixes.
 * Supported prefixes:
 *   /nova or /new — force new session
 *   /s:<name> or /sessão:<name> — route to named session
 *   No prefix — route to active call if exists
 */
export function parseMessagePrefix(text: string): ParsedMessage {
  const original = text;
  const trimmed = text.trim();

  // /nova or /new
  const novaMatch = trimmed.match(/^\/(nova|new)\s*/i);
  if (novaMatch) {
    return {
      prefix: 'nova',
      sessionName: null,
      cleanMessage: trimmed.slice(novaMatch[0].length).trim(),
      originalMessage: original,
    };
  }

  // /s:<name> or /sessão:<name> or /session:<name>
  const sessionMatch = trimmed.match(/^\/(s|sess[aã]o|session):(\S+)\s*/i);
  if (sessionMatch) {
    return {
      prefix: 'session',
      sessionName: sessionMatch[2],
      cleanMessage: trimmed.slice(sessionMatch[0].length).trim(),
      originalMessage: original,
    };
  }

  return {
    prefix: null,
    sessionName: null,
    cleanMessage: text,
    originalMessage: original,
  };
}

// ─── Kapso API helpers ───

async function kapsoFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const url = path.startsWith('http') ? path : `${KAPSO_API_URL}/${KAPSO_PHONE_NUMBER_ID}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': KAPSO_API_KEY,
      ...(options.headers || {}),
    },
  });
}

// ─── Send messages ───

export async function sendText(to: string, body: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
  to = to || process.env.LEIN_USER_WHATSAPP_NUMBER || process.env.LEIN_USER_PHONE_NUMBER || '';
  if (!to) return { success: false, error: 'No recipient phone number' };
  try {
    const res = await kapsoFetch('/messages', {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: formatPhone(to),
        type: 'text',
        text: { body },
      }),
    });

    const data = await res.json() as any;
    if (!res.ok) {
      return { success: false, error: data.error?.message || JSON.stringify(data) };
    }
    // Persist outbound to session
    addToSessionHistory(formatPhone(to), 'assistant', body);
    return { success: true, messageId: data.messages?.[0]?.id };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function sendImage(to: string, imageUrl: string, caption?: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
  to = to || process.env.LEIN_USER_WHATSAPP_NUMBER || process.env.LEIN_USER_PHONE_NUMBER || '';
  if (!to) return { success: false, error: 'No recipient phone number' };
  try {
    const res = await kapsoFetch('/messages', {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: formatPhone(to),
        type: 'image',
        image: { link: imageUrl, ...(caption ? { caption } : {}) },
      }),
    });

    const data = await res.json() as any;
    if (!res.ok) {
      return { success: false, error: data.error?.message || JSON.stringify(data) };
    }
    return { success: true, messageId: data.messages?.[0]?.id };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function sendAudio(to: string, audioUrl: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
  to = to || process.env.LEIN_USER_WHATSAPP_NUMBER || process.env.LEIN_USER_PHONE_NUMBER || '';
  if (!to) return { success: false, error: 'No recipient phone number' };
  try {
    const res = await kapsoFetch('/messages', {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: formatPhone(to),
        type: 'audio',
        audio: { link: audioUrl },
      }),
    });

    const data = await res.json() as any;
    if (!res.ok) {
      return { success: false, error: data.error?.message || JSON.stringify(data) };
    }
    return { success: true, messageId: data.messages?.[0]?.id };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function sendDocument(to: string, documentUrl: string, filename?: string, caption?: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
  to = to || process.env.LEIN_USER_WHATSAPP_NUMBER || process.env.LEIN_USER_PHONE_NUMBER || '';
  if (!to) return { success: false, error: 'No recipient phone number' };
  try {
    const res = await kapsoFetch('/messages', {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: formatPhone(to),
        type: 'document',
        document: {
          link: documentUrl,
          ...(filename ? { filename } : {}),
          ...(caption ? { caption } : {}),
        },
      }),
    });

    const data = await res.json() as any;
    if (!res.ok) {
      return { success: false, error: data.error?.message || JSON.stringify(data) };
    }
    return { success: true, messageId: data.messages?.[0]?.id };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ─── Receive messages (webhook handler) ───

/**
 * Download media from WhatsApp via Kapso proxy
 */
async function downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string; localPath: string } | null> {
  try {
    // First get the media URL
    const metaRes = await kapsoFetch(`${KAPSO_API_URL}/${mediaId}`, {
      method: 'GET',
    });
    const meta = await metaRes.json() as any;
    if (!meta.url) return null;

    // Download the actual file
    const mediaRes = await fetch(meta.url, {
      headers: { 'X-API-Key': KAPSO_API_KEY },
    });
    if (!mediaRes.ok) return null;

    const buffer = Buffer.from(await mediaRes.arrayBuffer());
    const mimeType = meta.mime_type || mediaRes.headers.get('content-type') || 'application/octet-stream';

    // Save locally
    if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true });
    const ext = mimeTypeToExt(mimeType);
    const localPath = join(MEDIA_DIR, `${mediaId}.${ext}`);
    writeFileSync(localPath, buffer);

    return { buffer, mimeType, localPath };
  } catch (err) {
    console.error(`[WhatsApp] Failed to download media ${mediaId}:`, err);
    return null;
  }
}

/**
 * Transcribe audio using OpenAI Whisper API
 */
async function transcribeAudio(buffer: Buffer, mimeType: string): Promise<string | null> {
  const openaiKey = process.env.LEIN_OPENAI_API_KEY;
  if (!openaiKey) return null;

  try {
    const ext = mimeTypeToExt(mimeType);
    const formData = new FormData();
    formData.append('file', new Blob([buffer], { type: mimeType }), `audio.${ext}`);
    formData.append('model', 'whisper-1');
    formData.append('language', 'pt');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openaiKey}` },
      body: formData,
    });

    if (!res.ok) {
      console.error('[WhatsApp] Whisper error:', await res.text());
      return null;
    }

    const data = await res.json() as any;
    return data.text || null;
  } catch (err) {
    console.error('[WhatsApp] Transcription error:', err);
    return null;
  }
}

/**
 * Process incoming webhook from Kapso
 * Handles both Kapso-format and Meta-format webhooks
 */
export async function handleWebhook(body: any): Promise<void> {
  // Kapso webhook v2 format: { message: { from, id, type, text, ... } }
  if (body.message) {
    await ingestMessage(body.message);
    return;
  }

  // Kapso webhook format (kind: kapso, event-based)
  if (body.event) {
    await processKapsoEvent(body);
    return;
  }

  // Meta webhook format (kind: meta) - raw forwarding
  if (body.entry) {
    for (const entry of body.entry) {
      for (const change of entry.changes || []) {
        if (change.field === 'messages') {
          const value = change.value;
          for (const message of value.messages || []) {
            await processMetaMessage(message, value.metadata);
          }
        }
      }
    }
    return;
  }

  console.error('[WhatsApp] Unknown webhook format:', JSON.stringify(body).slice(0, 200));
}

async function processKapsoEvent(event: any): Promise<void> {
  const eventType = event.event;

  if (eventType === 'whatsapp.message.received') {
    const payload = event.payload || event.data;
    if (!payload) return;

    // Kapso v2 payload
    const msg = payload.message || payload;
    await ingestMessage(msg);
  }
}

async function processMetaMessage(message: any, metadata: any): Promise<void> {
  await ingestMessage(message);
}

async function ingestMessage(raw: any): Promise<void> {
  const msgType = raw.type || 'unknown';
  const msg: WhatsAppMessage = {
    id: raw.id || `msg-${Date.now()}`,
    from: raw.from || 'unknown',
    timestamp: raw.timestamp ? parseInt(raw.timestamp) * 1000 : Date.now(),
    type: (['text', 'audio', 'image', 'video', 'document', 'reaction'].includes(msgType) ? msgType : 'unknown') as WhatsAppMessage['type'],
  };

  // Extract content based on type
  if (msgType === 'text' && raw.text) {
    msg.text = raw.text.body || raw.text;
  } else if (msgType === 'audio' && raw.audio) {
    const media = await downloadMedia(raw.audio.id);
    if (media) {
      msg.mediaLocalPath = media.localPath;
      msg.mimeType = media.mimeType;
      // Auto-transcribe
      const transcript = await transcribeAudio(media.buffer, media.mimeType);
      if (transcript) {
        msg.transcript = transcript;
        msg.text = transcript; // Make searchable
      }
    }
  } else if (msgType === 'image' && raw.image) {
    const media = await downloadMedia(raw.image.id);
    if (media) {
      msg.mediaLocalPath = media.localPath;
      msg.mimeType = media.mimeType;
      msg.caption = raw.image.caption;
    }
  } else if (msgType === 'video' && raw.video) {
    const media = await downloadMedia(raw.video.id);
    if (media) {
      msg.mediaLocalPath = media.localPath;
      msg.mimeType = media.mimeType;
      msg.caption = raw.video.caption;
    }
  } else if (msgType === 'document' && raw.document) {
    const media = await downloadMedia(raw.document.id);
    if (media) {
      msg.mediaLocalPath = media.localPath;
      msg.mimeType = media.mimeType;
      msg.caption = raw.document.caption;
    }
  }

  // Store
  receivedMessages.unshift(msg);
  if (receivedMessages.length > MAX_STORED_MESSAGES) {
    receivedMessages.length = MAX_STORED_MESSAGES;
  }

  // Persist to session history
  const content = msg.text || msg.transcript || msg.caption || `(${msg.type})`;
  addToSessionHistory(msg.from, 'user', content);

  console.error(`[WhatsApp] Received ${msg.type} from ${msg.from}: ${msg.text || msg.caption || '(media)'}`);
  notifyNewMessage(msg);
}

// ─── Read messages ───

/**
 * Get messages from in-memory store (populated by webhooks).
 * Falls back to Kapso Platform API if no messages in memory.
 */
export async function getMessages(limit = 20, sinceTimestamp?: number): Promise<WhatsAppMessage[]> {
  let msgs = receivedMessages;
  if (sinceTimestamp) {
    msgs = msgs.filter(m => m.timestamp > sinceTimestamp);
  }

  // If we have webhook messages, return those
  if (msgs.length > 0) {
    return msgs.slice(0, limit);
  }

  // Fall back to Kapso Platform API to fetch recent inbound messages
  try {
    const params = new URLSearchParams({
      phone_number_id: KAPSO_PHONE_NUMBER_ID,
      direction: 'inbound',
      per_page: String(limit),
    });
    const res = await fetch(`${KAPSO_PLATFORM_URL}/whatsapp/messages?${params}`, {
      headers: { 'X-API-Key': KAPSO_API_KEY },
    });
    if (!res.ok) return [];

    const data = await res.json() as any;
    const apiMessages: WhatsAppMessage[] = (data.data || []).map((m: any) => ({
      id: m.id,
      from: m.from || m.kapso?.phone_number || 'unknown',
      timestamp: m.timestamp ? parseInt(m.timestamp) * 1000 : Date.now(),
      type: (m.type || 'text') as WhatsAppMessage['type'],
      text: m.text?.body || m.kapso?.content || undefined,
      caption: m.image?.caption || m.video?.caption || m.document?.caption || undefined,
    }));

    return apiMessages;
  } catch {
    return [];
  }
}

export function getMessageCount(): number {
  return receivedMessages.length;
}

// ─── Helpers ───

function formatPhone(phone: string): string {
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = cleaned.substring(1);
  if (!cleaned.startsWith('55') && cleaned.length <= 11) {
    cleaned = '55' + cleaned;
  }
  return cleaned;
}

function mimeTypeToExt(mime: string): string {
  const map: Record<string, string> = {
    'audio/ogg': 'ogg',
    'audio/ogg; codecs=opus': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/amr': 'amr',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/3gpp': '3gp',
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/plain': 'txt',
  };
  return map[mime] || 'bin';
}

// ─── Session persistence (inspired by OpenClaw) ───

interface WhatsAppSession {
  peerId: string;           // Normalized phone number
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  history: Array<{ role: 'user' | 'assistant'; text: string; timestamp: number }>;
}

function sessionPath(peerId: string): string {
  const normalized = peerId.replace(/\D/g, '');
  return join(SESSIONS_DIR, `${normalized}.json`);
}

export function getSession(peerId: string): WhatsAppSession | null {
  const path = sessionPath(peerId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function saveSession(session: WhatsAppSession): void {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(sessionPath(session.peerId), JSON.stringify(session, null, 2));
}

export function getOrCreateSession(peerId: string): WhatsAppSession {
  const existing = getSession(peerId);
  if (existing) {
    existing.updatedAt = Date.now();
    return existing;
  }
  return {
    peerId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: 0,
    history: [],
  };
}

export function addToSessionHistory(peerId: string, role: 'user' | 'assistant', text: string): void {
  const session = getOrCreateSession(peerId);
  session.history.push({ role, text, timestamp: Date.now() });
  session.messageCount++;
  session.updatedAt = Date.now();
  // Keep last 50 messages in history
  if (session.history.length > 50) {
    session.history = session.history.slice(-50);
  }
  saveSession(session);
}

/**
 * Clean up sessions that have been idle for too long
 */
export function cleanupIdleSessions(): number {
  if (!existsSync(SESSIONS_DIR)) return 0;
  const now = Date.now();
  let cleaned = 0;
  for (const file of readdirSync(SESSIONS_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const path = join(SESSIONS_DIR, file);
      const session: WhatsAppSession = JSON.parse(readFileSync(path, 'utf8'));
      if (now - session.updatedAt > SESSION_IDLE_TIMEOUT_MS) {
        unlinkSync(path);
        cleaned++;
        console.error(`[WhatsApp] Cleaned idle session: ${session.peerId}`);
      }
    } catch {}
  }
  return cleaned;
}

// Run cleanup every 30 minutes
setInterval(cleanupIdleSessions, 30 * 60 * 1000);

// ─── Message chunking ───

/**
 * Split long messages into WhatsApp-safe chunks (max 4000 chars).
 * Tries to split at newlines or sentence boundaries.
 */
export function chunkMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at last newline within limit
    let splitAt = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    if (splitAt < MAX_MESSAGE_LENGTH * 0.5) {
      // Try sentence boundary
      splitAt = remaining.lastIndexOf('. ', MAX_MESSAGE_LENGTH);
      if (splitAt < MAX_MESSAGE_LENGTH * 0.5) {
        // Try space
        splitAt = remaining.lastIndexOf(' ', MAX_MESSAGE_LENGTH);
        if (splitAt < MAX_MESSAGE_LENGTH * 0.5) {
          // Hard split
          splitAt = MAX_MESSAGE_LENGTH;
        }
      }
      if (splitAt > 0) splitAt++; // Include the delimiter
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}

/**
 * Send a long text message, auto-chunking if needed
 */
export async function sendLongText(to: string, body: string): Promise<{ success: boolean; messageIds: string[]; error?: string }> {
  const chunks = chunkMessage(body);
  const messageIds: string[] = [];

  for (const chunk of chunks) {
    const result = await sendText(to, chunk);
    if (!result.success) {
      return { success: false, messageIds, error: result.error };
    }
    if (result.messageId) messageIds.push(result.messageId);
    // Small delay between chunks to maintain order
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 500));
  }

  return { success: true, messageIds };
}

export function isWhatsAppConfigured(): boolean {
  return !!KAPSO_API_KEY && !!KAPSO_PHONE_NUMBER_ID;
}
