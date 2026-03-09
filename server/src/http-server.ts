#!/usr/bin/env bun

/**
 * Lein HTTP Server (standalone)
 *
 * Runs the HTTP server + ngrok independently of the MCP.
 * This allows PM2 to keep the server running while Claude connects via MCP.
 */

import { CallManager, loadServerConfig } from './phone-call.js';
import { startNgrok, stopNgrok } from './ngrok.js';
import { createServer } from 'http';
import { writeSession, completeSession, cleanupAllSessions, type InboundSession } from './session-manager.js';
import { spawnClaudeForCall, spawnClaudeForWhatsApp, hasActiveSpawn, getActiveSessionCount, resetSessionForPhone, getClaudeSessionIdForPhone } from './claude-spawner.js';
import { ensureWorkspace } from './workspace.js';
import { findMostRecentProject, formatProjectSummary } from './project-scanner.js';
import {
  handleWebhook as handleWhatsAppWebhook,
  sendText as whatsappSendText,
  sendLongText as whatsappSendLongText,
  sendImage as whatsappSendImage,
  sendAudio as whatsappSendAudio,
  sendDocument as whatsappSendDocument,
  getMessages as whatsappGetMessages,
  getSession as whatsappGetSession,
  cleanupIdleSessions,
  isWhatsAppConfigured,
  onNewMessage,
  parseMessagePrefix,
} from './whatsapp.js';
import { addMemory, searchMemory, getMemories, deleteMemory, isMem0Configured } from './mem0.js';

// Store call manager globally for API access
let callManager: CallManager | null = null;

// Track connected MCP sessions
let connectedSessions = 0;

// Pending WhatsApp messages per active call — drained when Claude's call session makes any API call
interface PendingWhatsAppMsg {
  from: string;
  text: string;
  type: string;
  mediaLocalPath?: string;
  mimeType?: string;
  timestamp: number;
}
const pendingWhatsAppByCall = new Map<string, PendingWhatsAppMsg[]>();

// Rate limiter for queue acknowledgment messages (per sender, once per 60s)
const lastQueueAckSent = new Map<string, number>();
const QUEUE_ACK_COOLDOWN_MS = 60_000;

function enqueuePendingWhatsApp(callId: string, msg: PendingWhatsAppMsg): void {
  if (!pendingWhatsAppByCall.has(callId)) {
    pendingWhatsAppByCall.set(callId, []);
  }
  pendingWhatsAppByCall.get(callId)!.push(msg);
  console.error(`[Lein] Enqueued WhatsApp message for call ${callId} (${pendingWhatsAppByCall.get(callId)!.length} pending)`);
}

function drainPendingWhatsApp(callId: string): PendingWhatsAppMsg[] {
  const msgs = pendingWhatsAppByCall.get(callId) || [];
  if (msgs.length > 0) {
    pendingWhatsAppByCall.delete(callId);
    console.error(`[Lein] Drained ${msgs.length} pending WhatsApp message(s) for call ${callId}`);
  }
  return msgs;
}

async function main() {
  // Initialize workspace directory structure
  ensureWorkspace();

  const port = parseInt(process.env.LEIN_PORT || '3333', 10);
  const apiPort = parseInt(process.env.LEIN_API_PORT || '3334', 10);

  // Use LEIN_PUBLIC_URL if set (external ngrok or other tunnel), otherwise start ngrok
  let publicUrl: string;
  let usingExternalTunnel = false;

  if (process.env.LEIN_PUBLIC_URL) {
    publicUrl = process.env.LEIN_PUBLIC_URL.replace(/\/$/, ''); // Remove trailing slash
    usingExternalTunnel = true;
    console.error(`Using external tunnel: ${publicUrl}`);
  } else {
    console.error('Starting ngrok tunnel...');
    try {
      publicUrl = await startNgrok(port);
      console.error(`ngrok tunnel: ${publicUrl}`);
    } catch (error) {
      console.error('Failed to start ngrok:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  }

  // Load config and start call manager
  let serverConfig;
  try {
    serverConfig = loadServerConfig(publicUrl);
  } catch (error) {
    console.error('Configuration error:', error instanceof Error ? error.message : error);
    await stopNgrok();
    process.exit(1);
  }

  // Dynamic greeting: scan most recent project and include in greeting
  serverConfig.getInboundGreeting = () => {
    const project = findMostRecentProject();
    if (project) {
      const commitSummary = project.recentCommits.slice(0, 3).map(c => {
        // Remove commit hash prefix
        const msg = c.replace(/^[a-f0-9]+ /, '');
        return msg;
      }).join(', ');

      return `Oi Lucas! Sou a Lein. Analisei seus projetos e o mais recente é ${project.name}, na branch ${project.branch}. ` +
        `Os últimos commits foram: ${commitSummary}. ` +
        (project.gitStatus !== '(clean)' ? `Tem mudanças pendentes. ` : '') +
        `Quer trabalhar nele ou em outro projeto?`;
    }
    return serverConfig.inboundGreeting;
  };

  callManager = new CallManager(serverConfig);

  // Clean up stale sessions from previous runs
  cleanupAllSessions();

  // Set up inbound call notification handler
  callManager.setInboundCallHandler(async (callId, from, transcript) => {
    console.error(`[Inbound] Call ${callId} from ${from}: "${transcript}"`);

    // Write session file
    const session: InboundSession = {
      callId,
      from,
      transcript,
      timestamp: Date.now(),
      status: 'pending',
    };
    writeSession(session);

    // Auto-spawn Claude if no sessions exist (connected OR spawning)
    if (connectedSessions === 0 && getActiveSessionCount() === 0) {
      console.error('[Lein] No sessions active — auto-spawning Claude CLI...');
      const spawned = await spawnClaudeForCall(session);
      if (spawned) {
        console.error('[Lein] Claude CLI spawned successfully');
      } else {
        console.error('[Lein] Failed to spawn Claude CLI — falling back to hooks');
      }
    } else {
      console.error(`[Lein] ${connectedSessions} MCP + ${getActiveSessionCount()} spawned session(s) — hooks will notify`);
    }
  });

  // Auto-spawn Claude when WhatsApp message arrives with no MCP sessions
  // Routes messages to active calls when appropriate
  onNewMessage(async (msg) => {
    const messageText = msg.text || msg.transcript || msg.caption || '(media)';

    // Parse prefix commands
    const parsed = parseMessagePrefix(messageText);

    // If /nova prefix: always spawn new session regardless of active calls
    if (parsed.prefix === 'nova') {
      console.error(`[Lein] WhatsApp /nova from ${msg.from} — forcing new session`);
      resetSessionForPhone(msg.from); // Clear persistent session AND kill active sessions
      // Override message text with clean (prefix-stripped) version
      msg.text = parsed.cleanMessage || messageText;
      // Always spawn — resetSessionForPhone already killed any active sessions for this phone
      await spawnClaudeForWhatsApp(msg);
      return;
    }

    // If /s:<name> prefix: route to named session (future — for now treat as default)
    if (parsed.prefix === 'session') {
      console.error(`[Lein] WhatsApp /s:${parsed.sessionName} from ${msg.from} — session routing (not yet implemented)`);
      msg.text = parsed.cleanMessage || messageText;
    }

    // Check if there's an active call with the same user
    // Try matching by WhatsApp number AND by call number (user may have different numbers)
    if (callManager) {
      const userCallNumber = process.env.LEIN_USER_PHONE_NUMBER || '';
      const userWhatsAppNumber = process.env.LEIN_USER_WHATSAPP_NUMBER || '';
      const activeCall = callManager.getActiveCallByPhone(msg.from)
        || (userWhatsAppNumber && msg.from.replace(/\D/g, '').includes(userWhatsAppNumber.replace(/\D/g, ''))
            ? callManager.getActiveCallByPhone(userCallNumber)
            : null);
      if (activeCall) {
        console.error(`[Lein] WhatsApp from ${msg.from} routed to active call ${activeCall.callId}`);
        // Enqueue for piggyback delivery on next call API response
        // This is the ONLY delivery mechanism — no TTS, no read_whatsapp needed
        enqueuePendingWhatsApp(activeCall.callId, {
          from: msg.from,
          text: messageText,
          type: msg.type,
          mediaLocalPath: msg.mediaLocalPath,
          mimeType: msg.mimeType,
          timestamp: msg.timestamp || Date.now(),
        });
        // Don't spawn a new session — message will be delivered via piggyback
        return;
      }
    }

    // No active call — default behavior
    if (connectedSessions === 0 && getActiveSessionCount() === 0) {
      console.error(`[Lein] WhatsApp from ${msg.from} — auto-spawning Claude session`);
      const spawned = await spawnClaudeForWhatsApp(msg);
      if (spawned) {
        console.error('[Lein] Claude CLI spawned for WhatsApp message');
      } else {
        console.error('[Lein] Failed to spawn Claude CLI for WhatsApp');
      }
    } else {
      console.error(`[Lein] ${connectedSessions} MCP + ${getActiveSessionCount()} spawned session(s) — message will be read via read_whatsapp`);
      // Send a rate-limited queue acknowledgment so the user knows their message was received
      const now = Date.now();
      const lastAck = lastQueueAckSent.get(msg.from) || 0;
      if (now - lastAck > QUEUE_ACK_COOLDOWN_MS) {
        lastQueueAckSent.set(msg.from, now);
        whatsappSendText(msg.from, 'Recebi! Estou processando outra mensagem, já te respondo.').catch(err => {
          console.error(`[Lein] Failed to send queue ack to ${msg.from}:`, err);
        });
      }
    }
  });

  callManager.startServer();

  // Start API server for MCP communication
  const apiServer = createServer(async (req, res) => {
    // CORS headers for local requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url!, `http://localhost:${apiPort}`);

    // Health check doesn't need POST or body
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', publicUrl, connectedSessions, activeSpawns: getActiveSessionCount() }));
      return;
    }

    // Session tracking endpoints
    if (url.pathname === '/api/connect') {
      connectedSessions++;
      console.error(`MCP session connected (${connectedSessions} active)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: connectedSessions }));
      return;
    }

    if (url.pathname === '/api/disconnect') {
      connectedSessions = Math.max(0, connectedSessions - 1);
      console.error(`MCP session disconnected (${connectedSessions} active)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: connectedSessions }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method not allowed');
      return;
    }

    // Parse JSON body
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);

        let result: unknown;

        // Helper: attach pending WhatsApp messages to call API responses
        const attachPendingWhatsApp = (callId: string, res: any): any => {
          const pending = drainPendingWhatsApp(callId);
          if (pending.length === 0) return res;
          const base = typeof res === 'object' && res !== null ? res : { response: res };
          return {
            ...base,
            pendingWhatsApp: pending,
            _whatsappNotice: `IMPORTANT: ${pending.length} WhatsApp message(s) arrived during this call. Respond to the user about their WhatsApp message(s) via continue_call ONLY. Do NOT send_whatsapp or read_whatsapp — the messages are already here.`,
          };
        };

        switch (url.pathname) {
          case '/api/initiate_call':
            result = await callManager!.initiateCall(data.message);
            break;
          case '/api/continue_call': {
            const continueResult = await callManager!.continueCall(data.call_id, data.message);
            // If hung up, returns object with context; otherwise returns string response
            result = typeof continueResult === 'string' ? { response: continueResult } : continueResult;
            result = attachPendingWhatsApp(data.call_id, result);
            break;
          }
          case '/api/speak_to_user': {
            const speakResult = await callManager!.speakOnly(data.call_id, data.message);
            // If hung up, returns object with context; otherwise returns void
            result = speakResult || { success: true };
            result = attachPendingWhatsApp(data.call_id, result);
            break;
          }
          case '/api/end_call':
            result = await callManager!.endCall(data.call_id, data.message);
            break;
          case '/api/get_call_status':
            result = callManager!.getCallStatus(data.call_id);
            result = attachPendingWhatsApp(data.call_id, result);
            break;

          // WhatsApp API routes
          case '/api/whatsapp/send_text': {
            // Prefix messages with Claude session ID so user can `claude --resume <id>`
            const resolvedTo = data.to || process.env.LEIN_USER_WHATSAPP_NUMBER || process.env.LEIN_USER_PHONE_NUMBER || '';
            const claudeSessionId = resolvedTo ? getClaudeSessionIdForPhone(resolvedTo) : undefined;
            const sessionPrefix = claudeSessionId ? `[${claudeSessionId}]\n` : '';
            result = await whatsappSendLongText(data.to, sessionPrefix + data.message);
            break;
          }
          case '/api/whatsapp/send_image':
            result = await whatsappSendImage(data.to, data.image_url, data.caption);
            break;
          case '/api/whatsapp/send_audio':
            result = await whatsappSendAudio(data.to, data.audio_url);
            break;
          case '/api/whatsapp/send_document':
            result = await whatsappSendDocument(data.to, data.document_url, data.filename, data.caption);
            break;
          case '/api/whatsapp/read_messages':
            result = { messages: await whatsappGetMessages(data.limit, data.since_timestamp) };
            break;
          case '/api/whatsapp/get_session':
            result = { session: whatsappGetSession(data.peer_id) };
            break;
          // Memory API routes (Mem0)
          case '/api/memory/remember': {
            if (!isMem0Configured()) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'MEM0_API_KEY not configured' }));
              return;
            }
            result = await addMemory(data.text, data.project);
            break;
          }
          case '/api/memory/recall': {
            if (!isMem0Configured()) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'MEM0_API_KEY not configured' }));
              return;
            }
            result = await searchMemory(data.query, data.project, data.limit);
            break;
          }
          case '/api/memory/list': {
            if (!isMem0Configured()) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'MEM0_API_KEY not configured' }));
              return;
            }
            result = await getMemories(data.project, data.limit);
            break;
          }
          case '/api/memory/forget': {
            if (!isMem0Configured()) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'MEM0_API_KEY not configured' }));
              return;
            }
            await deleteMemory(data.memory_id);
            result = { success: true };
            break;
          }
          default:
            res.writeHead(404);
            res.end('Not found');
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        // User hung up during call — return structured response, not a 500 error
        if (message.includes('hung up') || message.includes('Call was hung up')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ hungUp: true, error: message }));
          return;
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      }
    });
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.error('\nShutting down...');
    cleanupAllSessions();
    callManager?.shutdown();
    apiServer.close();
    if (!usingExternalTunnel) {
      await stopNgrok();
    }
    process.exit(0);
  };

  // Handle port binding errors (e.g. another HTTP server already running)
  apiServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`API port ${apiPort} already in use - another server is running`);
      process.exit(0); // Clean exit so parent MCP process connects to existing server
    }
    console.error('API server error:', err);
    process.exit(1);
  });

  apiServer.listen(apiPort, () => {
    console.error(`API server listening on port ${apiPort}`);
    console.error('');
    console.error('Lein Server ready');
    console.error(`Phone: ${serverConfig.phoneNumber} -> ${serverConfig.userPhoneNumber}`);
    console.error(`Webhook: ${publicUrl}/twiml`);
    if (isWhatsAppConfigured()) {
      console.error(`WhatsApp: ${publicUrl}/kapso (Kapso webhook)`);
    }
    console.error(`API: http://localhost:${apiPort}/api/*`);
    console.error('');
  });

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
