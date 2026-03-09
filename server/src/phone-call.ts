import WebSocket, { WebSocketServer } from 'ws';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  loadProviderConfig,
  createProviders,
  validateProviderConfig,
  type ProviderRegistry,
  type ProviderConfig,
} from './providers/index.js';
import {
  validateTwilioSignature,
  generateWebSocketToken,
  validateWebSocketToken,
} from './webhook-security.js';

// ─── Types ───

interface CallState {
  callId: string;
  callControlId: string | null;
  userPhoneNumber: string;
  ws: WebSocket | null;
  wsToken: string;
  conversationHistory: Array<{ speaker: 'claude' | 'user'; message: string }>;
  startTime: number;
  hungUp: boolean;
  hungUpAt?: number;
  isInbound?: boolean;
  relaySessionId?: string;
  pendingTranscript: {
    resolve: (text: string) => void;
    reject: (err: Error) => void;
  } | null;
}

export interface ServerConfig {
  publicUrl: string;
  port: number;
  phoneNumber: string;
  userPhoneNumber: string;
  providers: ProviderRegistry;
  providerConfig: ProviderConfig;
  transcriptTimeoutMs: number;
  inboundGreeting: string;
  getInboundGreeting?: () => string;
}

// ─── Config ───

const __dirname = dirname(fileURLToPath(import.meta.url));

function readEnvFile(key: string): string | undefined {
  try {
    const envPath = join(__dirname, '..', '.env');
    if (!existsSync(envPath)) return undefined;
    const content = readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex > 0) {
          const envKey = trimmed.substring(0, eqIndex).trim();
          if (envKey === key) {
            return trimmed.substring(eqIndex + 1).trim();
          }
        }
      }
    }
  } catch {}
  return undefined;
}

export function loadServerConfig(publicUrl: string): ServerConfig {
  const providerConfig = loadProviderConfig();
  const errors = validateProviderConfig(providerConfig);

  if (!process.env.LEIN_USER_PHONE_NUMBER) {
    errors.push('Missing LEIN_USER_PHONE_NUMBER (where to call you)');
  }

  if (errors.length > 0) {
    throw new Error(`Missing required configuration:\n  - ${errors.join('\n  - ')}`);
  }

  const providers = createProviders(providerConfig);
  const transcriptTimeoutMs = parseInt(process.env.LEIN_TRANSCRIPT_TIMEOUT_MS || '180000', 10);
  const inboundGreeting = process.env.LEIN_INBOUND_GREETING ||
    "Olá, aqui é a Lein. Como posso ajudar?";

  return {
    publicUrl,
    port: parseInt(process.env.LEIN_PORT || '3333', 10),
    phoneNumber: providerConfig.phoneNumber,
    userPhoneNumber: process.env.LEIN_USER_PHONE_NUMBER!,
    providers,
    providerConfig,
    transcriptTimeoutMs,
    inboundGreeting,
  };
}

// ─── CallManager ───

export class CallManager {
  private activeCalls = new Map<string, CallState>();
  private hungUpCalls = new Map<string, CallState>();
  private callControlIdToCallId = new Map<string, string>();
  private wsTokenToCallId = new Map<string, string>();
  private httpServer: ReturnType<typeof createServer> | null = null;
  private wss: WebSocketServer | null = null;
  private config: ServerConfig;
  private currentCallId = 0;
  private onInboundCall?: (callId: string, from: string, transcript: string) => void;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  setInboundCallHandler(handler: (callId: string, from: string, transcript: string) => void): void {
    this.onInboundCall = handler;
  }

  private getGreeting(): string {
    if (this.config.getInboundGreeting) {
      try {
        return this.config.getInboundGreeting();
      } catch {}
    }
    return this.config.inboundGreeting;
  }

  // ─── ConversationRelay: send/receive text ───

  private sendText(state: CallState, text: string): void {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    const msg = JSON.stringify({ type: 'text', token: text, last: true });
    console.error(`[${state.callId}] WS send: ${msg.substring(0, 200)}`);
    state.ws.send(msg);
  }

  private waitForPrompt(state: CallState, timeoutMs?: number): Promise<string> {
    if (state.hungUp) {
      this.preserveHungUpCall(state.callId);
      return Promise.reject(new Error('Call was hung up by user'));
    }

    return new Promise((resolve, reject) => {
      state.pendingTranscript = { resolve, reject };

      if (timeoutMs) {
        setTimeout(() => {
          if (state.pendingTranscript) {
            state.pendingTranscript = null;
            reject(new Error('Transcript timeout'));
          }
        }, timeoutMs);
      }
    });
  }

  private async speakAndListen(state: CallState, text: string): Promise<string> {
    this.sendText(state, text);
    return this.waitForPrompt(state, this.config.transcriptTimeoutMs);
  }

  // ─── Call state management ───

  private preserveHungUpCall(callId: string): void {
    if (this.hungUpCalls.has(callId)) return;
    const state = this.activeCalls.get(callId);
    if (!state) return;

    state.hungUp = true;
    state.hungUpAt = Date.now();
    state.ws?.close();
    state.ws = null;

    if (state.pendingTranscript) {
      state.pendingTranscript.reject(new Error('Call was hung up by user'));
      state.pendingTranscript = null;
    }

    this.hungUpCalls.set(callId, state);
    this.activeCalls.delete(callId);

    this.wsTokenToCallId.delete(state.wsToken);
    if (state.callControlId) {
      this.callControlIdToCallId.delete(state.callControlId);
    }

    setTimeout(() => {
      this.hungUpCalls.delete(callId);
      console.error(`[${callId}] Hung-up call context expired`);
    }, 5 * 60 * 1000);

    console.error(`[${callId}] Call preserved in hung-up state (context available for 5 min)`);
  }

  getActiveCallByPhone(phone: string): { callId: string; state: CallState } | null {
    const normalized = phone.replace(/\D/g, '');
    for (const [callId, state] of this.activeCalls) {
      const callPhone = state.userPhoneNumber.replace(/\D/g, '');
      if (callPhone === normalized || callPhone.endsWith(normalized) || normalized.endsWith(callPhone)) {
        return { callId, state };
      }
    }
    return null;
  }

  async notifyWhatsAppMessage(callId: string, messageText: string): Promise<void> {
    const state = this.activeCalls.get(callId);
    if (!state || state.hungUp) return;

    const preview = messageText.length > 100 ? messageText.slice(0, 100) + '...' : messageText;
    const notification = `Recebi sua mensagem no WhatsApp: ${preview}`;

    try {
      this.sendText(state, notification);
      state.conversationHistory.push({ speaker: 'claude', message: `[WhatsApp notification] ${notification}` });
    } catch (err) {
      console.error(`[${callId}] Failed to notify WhatsApp message:`, err);
    }
  }

  hasActiveCalls(): boolean {
    return this.activeCalls.size > 0;
  }

  getCallStatus(callId: string): { status: 'active' | 'hung_up' | 'not_found'; conversationHistory?: Array<{ speaker: string; message: string }>; durationSeconds?: number } {
    const active = this.activeCalls.get(callId);
    if (active) {
      return {
        status: 'active',
        conversationHistory: active.conversationHistory,
        durationSeconds: Math.round((Date.now() - active.startTime) / 1000),
      };
    }

    const hungUp = this.hungUpCalls.get(callId);
    if (hungUp) {
      return {
        status: 'hung_up',
        conversationHistory: hungUp.conversationHistory,
        durationSeconds: Math.round(((hungUp.hungUpAt || Date.now()) - hungUp.startTime) / 1000),
      };
    }

    return { status: 'not_found' };
  }

  // ─── HTTP + WebSocket server ───

  startServer(): void {
    this.httpServer = createServer((req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);

      if (url.pathname === '/twiml') {
        this.handlePhoneWebhook(req, res);
        return;
      }

      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', activeCalls: this.activeCalls.size }));
        return;
      }

      if (url.pathname === '/stream-status') {
        this.handleStreamStatus(req, res);
        return;
      }

      if (url.pathname === '/kapso') {
        this.handleKapsoWebhook(req, res);
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on('upgrade', (request: IncomingMessage, socket: any, head: Buffer) => {
      const url = new URL(request.url!, `http://${request.headers.host}`);
      if (url.pathname === '/media-stream') {
        const token = url.searchParams.get('token');
        let callId = token ? this.wsTokenToCallId.get(token) : null;

        if (token && callId) {
          const state = this.activeCalls.get(callId);
          if (!state || !validateWebSocketToken(state.wsToken, token)) {
            console.error('[Security] Rejecting WebSocket: token validation failed');
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
          console.error(`[Security] WebSocket token validated for call ${callId}`);
        } else if (!callId) {
          // Fallback for ngrok compatibility
          const hostname = new URL(this.config.publicUrl).hostname;
          const isNgrok = hostname.endsWith('.ngrok-free.dev') || hostname.endsWith('.ngrok.app') || hostname.includes('ngrok');
          if (isNgrok) {
            const activeCallIds = Array.from(this.activeCalls.keys());
            if (activeCallIds.length > 0) {
              callId = activeCallIds[activeCallIds.length - 1];
              console.error(`[WebSocket] Token not found, using fallback call ID: ${callId} (ngrok compatibility mode)`);
            } else {
              callId = `pending-${Date.now()}`;
              console.error(`[WebSocket] No active calls, using placeholder: ${callId} (ngrok compatibility mode)`);
            }
          } else {
            console.error('[Security] Rejecting WebSocket: missing or invalid token');
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
        }

        console.error(`[WebSocket] Accepting connection for: ${callId}`);
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit('connection', ws, request, callId);
        });
      } else {
        socket.destroy();
      }
    });

    // ConversationRelay WebSocket handler — receives/sends JSON text messages
    this.wss.on('connection', (ws: WebSocket, _request: IncomingMessage, callId: string) => {
      console.error(`[${callId}] ConversationRelay WebSocket connected`);

      const state = this.activeCalls.get(callId);
      if (state) {
        state.ws = ws;
      }

      ws.on('message', (message: Buffer | string) => {
        const text = typeof message === 'string' ? message : message.toString();
        console.error(`[${callId}] WS recv: ${text.substring(0, 200)}`);
        let msg: any;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }

        const msgState = this.activeCalls.get(callId);
        if (!msgState) return;

        switch (msg.type) {
          case 'setup':
            msgState.relaySessionId = msg.sessionId;
            console.error(`[${callId}] ConversationRelay setup: sessionId=${msg.sessionId}, from=${msg.from}, to=${msg.to}`);
            break;

          case 'prompt':
            console.error(`[${callId}] User said: "${msg.voicePrompt}"`);
            if (msgState.pendingTranscript) {
              msgState.pendingTranscript.resolve(msg.voicePrompt);
              msgState.pendingTranscript = null;
            }
            break;

          case 'interrupt':
            console.error(`[${callId}] User interrupted after: "${msg.utteranceUntilInterrupt}"`);
            break;

          case 'dtmf':
            console.error(`[${callId}] DTMF: ${msg.digit}`);
            break;

          case 'error':
            console.error(`[${callId}] ConversationRelay error: ${msg.description}`);
            break;
        }
      });

      ws.on('close', () => {
        console.error(`[${callId}] ConversationRelay WebSocket closed`);
        const closeState = this.activeCalls.get(callId);
        if (closeState) {
          closeState.hungUp = true;
          if (closeState.pendingTranscript) {
            closeState.pendingTranscript.reject(new Error('Call was hung up by user'));
            closeState.pendingTranscript = null;
          }
        }
      });
    });

    this.httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${this.config.port} in use, killing existing process...`);
        const result = Bun.spawnSync(['lsof', '-ti', `:${this.config.port}`]);
        const pids = result.stdout.toString().trim().split('\n').filter(Boolean);
        for (const pid of pids) {
          try { process.kill(parseInt(pid), 'SIGTERM'); } catch {}
        }
        setTimeout(() => {
          this.httpServer!.listen(this.config.port, () => {
            console.error(`HTTP server listening on port ${this.config.port}`);
          });
        }, 2000);
      } else {
        console.error('HTTP server error:', err);
        process.exit(1);
      }
    });

    this.httpServer.listen(this.config.port, () => {
      console.error(`HTTP server listening on port ${this.config.port}`);
    });
  }

  // ─── Webhook handlers ───

  private handlePhoneWebhook(req: IncomingMessage, res: ServerResponse): void {
    const contentType = req.headers['content-type'] || '';

    if (contentType.includes('application/x-www-form-urlencoded')) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const params = new URLSearchParams(body);

          // Skip Twilio signature validation for ngrok compatibility
          // TODO: Re-enable with proper URL handling
          console.error(`[Security] Skipping Twilio signature validation (publicUrl: ${this.config.publicUrl})`);

          await this.handleTwilioWebhook(params, res);
        } catch (error) {
          console.error('Error parsing Twilio webhook:', error);
          res.writeHead(400);
          res.end('Invalid form data');
        }
      });
      return;
    }

    console.error('[Security] Rejecting webhook with unknown content type:', contentType);
    res.writeHead(400);
    res.end('Invalid content type');
  }

  private async handleTwilioWebhook(params: URLSearchParams, res: ServerResponse): Promise<void> {
    const callSid = params.get('CallSid');
    const callStatus = params.get('CallStatus');
    const errorCode = params.get('ErrorCode');
    const errorMessage = params.get('ErrorMessage');
    console.error(`Twilio webhook: CallSid=${callSid}, CallStatus=${callStatus}${errorCode ? `, Error=${errorCode}: ${errorMessage}` : ''}`);

    // Handle inbound calls
    if (callSid && callStatus === 'ringing' && !this.callControlIdToCallId.has(callSid)) {
      const from = params.get('From') || 'unknown';
      console.error(`[Inbound] Incoming Twilio call from ${from}`);
      this.handleInboundCallTwilio(callSid, from, res).catch(err => {
        console.error('[Inbound] Failed to handle inbound call:', err);
      });
      return;
    }

    // Handle call status updates
    if (callStatus === 'completed' || callStatus === 'busy' || callStatus === 'no-answer' || callStatus === 'failed') {
      if (callSid) {
        const callId = this.callControlIdToCallId.get(callSid);
        if (callId) {
          this.preserveHungUpCall(callId);
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      return;
    }

    // Only return ConversationRelay TwiML for 'in-progress' (call answered)
    // For 'initiated' and 'ringing', return empty response to avoid duplicate ConversationRelay sessions
    if (callStatus !== 'in-progress') {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      return;
    }

    let wsUrl = `wss://${new URL(this.config.publicUrl).host}/media-stream`;

    if (callSid) {
      const callId = this.callControlIdToCallId.get(callSid);
      if (callId) {
        const state = this.activeCalls.get(callId);
        if (state) {
          wsUrl += `?token=${encodeURIComponent(state.wsToken)}`;
        }
      }
    }

    const statusCallbackUrl = `${this.config.publicUrl}/stream-status`;
    const xml = this.config.providers.phone.getConnectXml(wsUrl, { statusCallbackUrl });
    console.error(`[TwiML] Returning ConversationRelay XML with URL: ${wsUrl}`);
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(xml);
  }

  private handleKapsoWebhook(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === 'GET') {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const mode = url.searchParams.get('hub.mode');
      const challenge = url.searchParams.get('hub.challenge');
      if (mode === 'subscribe' && challenge) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(challenge);
        return;
      }
      res.writeHead(200);
      res.end('ok');
      return;
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));

      try {
        const data = JSON.parse(body);
        const { handleWebhook } = await import('./whatsapp.js');
        await handleWebhook(data);
      } catch (err) {
        console.error('[Kapso] Webhook error:', err);
      }
    });
  }

  private handleStreamStatus(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const params = new URLSearchParams(body);
        const streamSid = params.get('StreamSid');
        const streamStatus = params.get('StreamStatus');
        const errorCode = params.get('ErrorCode');
        const errorMessage = params.get('ErrorMessage');
        console.error(`[StreamStatus] StreamSid=${streamSid}, Status=${streamStatus}${errorCode ? `, Error=${errorCode}: ${errorMessage}` : ''}`);
      } catch (error) {
        console.error('[StreamStatus] Error parsing:', error);
      }
      res.writeHead(200);
      res.end();
    });
  }

  // ─── Inbound call handling ───

  private async handleInboundCallTwilio(callSid: string, from: string, res: ServerResponse): Promise<void> {
    const callId = `inbound-${++this.currentCallId}-${Date.now()}`;
    console.error(`[${callId}] Setting up inbound Twilio call from ${from}`);

    const wsToken = generateWebSocketToken();

    const state: CallState = {
      callId,
      callControlId: callSid,
      userPhoneNumber: from,
      ws: null,
      wsToken,
      conversationHistory: [],
      startTime: Date.now(),
      hungUp: false,
      isInbound: true,
      pendingTranscript: null,
    };

    this.activeCalls.set(callId, state);
    this.callControlIdToCallId.set(callSid, callId);
    this.wsTokenToCallId.set(wsToken, callId);

    // Return TwiML with ConversationRelay — greeting handled by welcomeGreeting attribute
    let wsUrl = `wss://${new URL(this.config.publicUrl).host}/media-stream`;
    wsUrl += `?token=${encodeURIComponent(wsToken)}`;
    const statusCallbackUrl = `${this.config.publicUrl}/stream-status`;
    const greeting = this.getGreeting();

    const xml = this.config.providers.phone.getConnectXml(wsUrl, {
      welcomeGreeting: greeting,
      statusCallbackUrl,
    });
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(xml);

    // Wait for WebSocket + first user prompt
    try {
      await this.waitForConnection(callId, 15000);
      if (state.hungUp) { this.cleanupCall(callId); return; }

      const transcript = await this.waitForPrompt(state, 30000);
      state.conversationHistory.push({ speaker: 'claude', message: greeting });
      state.conversationHistory.push({ speaker: 'user', message: transcript });

      console.error(`[${callId}] User said: ${transcript}`);
      this.writePendingInboundCall(callId, from, transcript);
      this.onInboundCall?.(callId, from, transcript);

      this.sendText(state, "Um momento, por favor. Estou conectando você ao Claude.");
    } catch (error) {
      console.error(`[${callId}] Inbound call error:`, error instanceof Error ? error.message : error);
      try { await this.hangUpCall(callId); } catch {}
    }
  }

  private writePendingInboundCall(callId: string, from: string, transcript: string): void {
    try {
      const fs = require('fs');
      const pendingCallInfo = { callId, from, transcript, timestamp: Date.now() };
      fs.writeFileSync('/tmp/lein-pending-inbound.json', JSON.stringify(pendingCallInfo));
      console.error(`[${callId}] Wrote pending inbound call info`);
    } catch (err) {
      console.error(`[${callId}] Failed to write pending call info:`, err);
    }
  }

  private cleanupCall(callId: string): void {
    const state = this.activeCalls.get(callId);
    if (state) {
      state.ws?.close();
      this.wsTokenToCallId.delete(state.wsToken);
      if (state.callControlId) {
        this.callControlIdToCallId.delete(state.callControlId);
      }
      this.activeCalls.delete(callId);
    }
  }

  private async hangUpCall(callId: string): Promise<void> {
    const state = this.activeCalls.get(callId);
    if (!state) return;

    if (state.callControlId) {
      await this.config.providers.phone.hangup(state.callControlId);
    }
    state.hungUp = true;
    this.cleanupCall(callId);
  }

  // ─── Public API (used by MCP tools / HTTP API) ───

  async initiateCall(message: string): Promise<{ callId: string; response: string }> {
    const callId = `call-${++this.currentCallId}-${Date.now()}`;
    const userPhoneNumber = readEnvFile('LEIN_USER_PHONE_NUMBER') || this.config.userPhoneNumber;
    const wsToken = generateWebSocketToken();

    const state: CallState = {
      callId,
      callControlId: null,
      userPhoneNumber,
      ws: null,
      wsToken,
      conversationHistory: [],
      startTime: Date.now(),
      hungUp: false,
      pendingTranscript: null,
    };

    this.activeCalls.set(callId, state);

    try {
      const callControlId = await this.config.providers.phone.initiateCall(
        userPhoneNumber,
        this.config.phoneNumber,
        `${this.config.publicUrl}/twiml`
      );

      state.callControlId = callControlId;
      this.callControlIdToCallId.set(callControlId, callId);
      this.wsTokenToCallId.set(wsToken, callId);

      console.error(`Call initiated: ${callControlId} -> ${userPhoneNumber}`);

      await this.waitForConnection(callId, 45000);

      // Send message via ConversationRelay (Twilio handles TTS)
      this.sendText(state, message);
      const response = await this.waitForPrompt(state, this.config.transcriptTimeoutMs);
      state.conversationHistory.push({ speaker: 'claude', message });
      state.conversationHistory.push({ speaker: 'user', message: response });

      return { callId, response };
    } catch (error) {
      this.activeCalls.delete(callId);
      throw error;
    }
  }

  async continueCall(callId: string, message: string): Promise<string | { hungUp: true; conversationHistory: Array<{ speaker: string; message: string }>; durationSeconds: number }> {
    const state = this.activeCalls.get(callId);

    if (!state) {
      const hungUp = this.hungUpCalls.get(callId);
      if (hungUp) {
        return {
          hungUp: true,
          conversationHistory: hungUp.conversationHistory,
          durationSeconds: Math.round(((hungUp.hungUpAt || Date.now()) - hungUp.startTime) / 1000),
        };
      }
      throw new Error(`No active call: ${callId}`);
    }

    const response = await this.speakAndListen(state, message);
    state.conversationHistory.push({ speaker: 'claude', message });
    state.conversationHistory.push({ speaker: 'user', message: response });

    return response;
  }

  async speakOnly(callId: string, message: string): Promise<{ hungUp: true; conversationHistory: Array<{ speaker: string; message: string }>; durationSeconds: number } | void> {
    const state = this.activeCalls.get(callId);

    if (!state) {
      const hungUp = this.hungUpCalls.get(callId);
      if (hungUp) {
        return {
          hungUp: true,
          conversationHistory: hungUp.conversationHistory,
          durationSeconds: Math.round(((hungUp.hungUpAt || Date.now()) - hungUp.startTime) / 1000),
        };
      }
      throw new Error(`No active call: ${callId}`);
    }

    this.sendText(state, message);
    state.conversationHistory.push({ speaker: 'claude', message });
  }

  async endCall(callId: string, message: string): Promise<{ durationSeconds: number; conversationHistory?: Array<{ speaker: string; message: string }> }> {
    const state = this.activeCalls.get(callId);

    if (!state) {
      const hungUp = this.hungUpCalls.get(callId);
      if (hungUp) {
        const durationSeconds = Math.round(((hungUp.hungUpAt || Date.now()) - hungUp.startTime) / 1000);
        this.hungUpCalls.delete(callId);
        return { durationSeconds, conversationHistory: hungUp.conversationHistory };
      }
      throw new Error(`No active call: ${callId}`);
    }

    // Send farewell message
    this.sendText(state, message);

    // Wait for TTS to finish playing before hanging up
    await new Promise(r => setTimeout(r, 3000));

    // End ConversationRelay session
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'end' }));
    }

    // Hang up via Twilio API
    if (state.callControlId) {
      await this.config.providers.phone.hangup(state.callControlId);
    }

    state.ws?.close();
    state.hungUp = true;

    this.wsTokenToCallId.delete(state.wsToken);
    if (state.callControlId) {
      this.callControlIdToCallId.delete(state.callControlId);
    }

    const durationSeconds = Math.round((Date.now() - state.startTime) / 1000);
    this.activeCalls.delete(callId);

    return { durationSeconds };
  }

  private async waitForConnection(callId: string, timeout: number): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const state = this.activeCalls.get(callId);
      if (state?.ws && state.ws.readyState === WebSocket.OPEN) {
        return;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('WebSocket connection timeout');
  }

  getHttpServer() {
    return this.httpServer;
  }

  shutdown(): void {
    for (const callId of this.activeCalls.keys()) {
      this.endCall(callId, 'Goodbye!').catch(console.error);
    }
    this.wss?.close();
    this.httpServer?.close();
  }
}
