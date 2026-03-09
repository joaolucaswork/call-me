/**
 * WhatsApp Module for CallMe
 *
 * Uses Kapso as a proxy to WhatsApp Business API.
 * Supports sending/receiving text, audio, and images.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Kapso config
const KAPSO_API_KEY = process.env.CALLME_KAPSO_API_KEY || '';
const KAPSO_PHONE_NUMBER_ID = process.env.CALLME_KAPSO_PHONE_NUMBER_ID || '';
const KAPSO_API_URL = 'https://api.kapso.ai/meta/whatsapp/v24.0';
const KAPSO_PLATFORM_URL = 'https://api.kapso.ai/platform/v1';

// Where to store downloaded media
const MEDIA_DIR = join(__dirname, '..', '.media');

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
    userPhoneNumber: process.env.CALLME_USER_PHONE_NUMBER || '',
    openaiApiKey: process.env.CALLME_OPENAI_API_KEY || '',
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
  to = to || process.env.CALLME_USER_PHONE_NUMBER || '';
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
    return { success: true, messageId: data.messages?.[0]?.id };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function sendImage(to: string, imageUrl: string, caption?: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
  to = to || process.env.CALLME_USER_PHONE_NUMBER || '';
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
  to = to || process.env.CALLME_USER_PHONE_NUMBER || '';
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
  to = to || process.env.CALLME_USER_PHONE_NUMBER || '';
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
  const openaiKey = process.env.CALLME_OPENAI_API_KEY;
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

export function isWhatsAppConfigured(): boolean {
  return !!KAPSO_API_KEY && !!KAPSO_PHONE_NUMBER_ID;
}
