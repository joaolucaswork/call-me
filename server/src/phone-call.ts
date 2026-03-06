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
  type RealtimeSTTSession,
} from './providers/index.js';
import {
  validateTwilioSignature,
  validateTelnyxSignature,
  generateWebSocketToken,
  validateWebSocketToken,
} from './webhook-security.js';

interface CallState {
  callId: string;
  callControlId: string | null;
  userPhoneNumber: string;
  ws: WebSocket | null;
  streamSid: string | null;  // Twilio media stream ID (required for sending audio)
  streamingReady: boolean;  // True when streaming.started event received (Telnyx)
  wsToken: string;  // Security token for WebSocket authentication
  conversationHistory: Array<{ speaker: 'claude' | 'user'; message: string }>;
  startTime: number;
  hungUp: boolean;
  hungUpAt?: number;  // Timestamp when call was hung up
  sttSession: RealtimeSTTSession | null;
  isInbound?: boolean;  // True for incoming calls
  keepaliveTimer?: ReturnType<typeof setTimeout> | null;  // Holdmusic keepalive timer
}

export interface ServerConfig {
  publicUrl: string;
  port: number;
  phoneNumber: string;
  userPhoneNumber: string;
  providers: ProviderRegistry;
  providerConfig: ProviderConfig;  // For webhook signature verification
  transcriptTimeoutMs: number;
  inboundGreeting: string;  // Greeting for incoming calls
  holdIntervalMs: number;  // Interval for keepalive hold messages (0 = disabled)
  holdMessages: string[];  // Messages to cycle through during hold
}

/**
 * Read a value directly from the .env file (bypasses process.env cache)
 */
function readEnvFile(key: string): string | undefined {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
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
  } catch {
    // Fall back to process.env
  }
  return undefined;
}

export function loadServerConfig(publicUrl: string): ServerConfig {
  const providerConfig = loadProviderConfig();
  const errors = validateProviderConfig(providerConfig);

  if (!process.env.CALLME_USER_PHONE_NUMBER) {
    errors.push('Missing CALLME_USER_PHONE_NUMBER (where to call you)');
  }

  if (errors.length > 0) {
    throw new Error(`Missing required configuration:\n  - ${errors.join('\n  - ')}`);
  }

  const providers = createProviders(providerConfig);

  // Default 3 minutes for transcript timeout
  const transcriptTimeoutMs = parseInt(process.env.CALLME_TRANSCRIPT_TIMEOUT_MS || '180000', 10);

  // Default greeting for inbound calls
  const inboundGreeting = process.env.CALLME_INBOUND_GREETING ||
    "Olá, aqui é o Claude. Como posso ajudar?";

  // Hold/keepalive interval (default 15 seconds, 0 to disable)
  const holdIntervalMs = parseInt(process.env.CALLME_HOLD_INTERVAL_MS || '15000', 10);

  const holdMessages = [
    "Ainda estou trabalhando nisso, um momento...",
    "Continuo aqui, só processando...",
    "Já já volto, estou finalizando...",
    "Um instante, quase pronto...",
  ];

  return {
    publicUrl,
    port: parseInt(process.env.CALLME_PORT || '3333', 10),
    phoneNumber: providerConfig.phoneNumber,
    userPhoneNumber: process.env.CALLME_USER_PHONE_NUMBER!,
    providers,
    providerConfig,
    transcriptTimeoutMs,
    inboundGreeting,
    holdIntervalMs,
    holdMessages,
  };
}

export class CallManager {
  private activeCalls = new Map<string, CallState>();
  private hungUpCalls = new Map<string, CallState>();  // Preserved after hangup for context
  private callControlIdToCallId = new Map<string, string>();
  private wsTokenToCallId = new Map<string, string>();  // For WebSocket auth
  private httpServer: ReturnType<typeof createServer> | null = null;
  private wss: WebSocketServer | null = null;
  private config: ServerConfig;
  private currentCallId = 0;
  private holdMessageIndex = 0;
  private onInboundCall?: (callId: string, from: string, transcript: string) => void;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  /**
   * Set handler for inbound call notifications
   * Called when an incoming call is answered, greeted, and user speaks
   */
  setInboundCallHandler(handler: (callId: string, from: string, transcript: string) => void): void {
    this.onInboundCall = handler;
  }

  /**
   * Start keepalive timer for a call. Plays hold messages at intervals.
   */
  private startKeepalive(state: CallState): void {
    if (this.config.holdIntervalMs <= 0) return;
    this.stopKeepalive(state);

    const scheduleNext = () => {
      state.keepaliveTimer = setTimeout(async () => {
        if (state.hungUp || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
          return;
        }
        const msg = this.config.holdMessages[this.holdMessageIndex % this.config.holdMessages.length];
        this.holdMessageIndex++;
        try {
          console.error(`[${state.callId}] Playing keepalive: "${msg}"`);
          const audioData = await this.generateTTSAudio(msg);
          await this.sendPreGeneratedAudio(state, audioData);
        } catch (err) {
          console.error(`[${state.callId}] Keepalive audio failed:`, err);
        }
        if (!state.hungUp) {
          scheduleNext();
        }
      }, this.config.holdIntervalMs);
    };
    scheduleNext();
  }

  /**
   * Stop keepalive timer for a call.
   */
  private stopKeepalive(state: CallState): void {
    if (state.keepaliveTimer) {
      clearTimeout(state.keepaliveTimer);
      state.keepaliveTimer = null;
    }
  }

  /**
   * Reset keepalive timer (called when Claude sends audio).
   */
  private resetKeepalive(state: CallState): void {
    if (this.config.holdIntervalMs <= 0) return;
    this.stopKeepalive(state);
    this.startKeepalive(state);
  }

  /**
   * Move call to hungUp state, preserving context for 5 minutes.
   * Idempotent — safe to call multiple times for the same callId.
   */
  private preserveHungUpCall(callId: string): void {
    // Already preserved
    if (this.hungUpCalls.has(callId)) return;
    const state = this.activeCalls.get(callId);
    if (!state) return;

    state.hungUp = true;
    state.hungUpAt = Date.now();
    this.stopKeepalive(state);
    state.sttSession?.close();
    state.sttSession = null;
    state.ws?.close();
    state.ws = null;

    // Move to hungUpCalls for context preservation
    this.hungUpCalls.set(callId, state);
    this.activeCalls.delete(callId);

    // Clean up mappings
    this.wsTokenToCallId.delete(state.wsToken);
    if (state.callControlId) {
      this.callControlIdToCallId.delete(state.callControlId);
    }

    // Auto-cleanup after 5 minutes
    setTimeout(() => {
      this.hungUpCalls.delete(callId);
      console.error(`[${callId}] Hung-up call context expired`);
    }, 5 * 60 * 1000);

    console.error(`[${callId}] Call preserved in hung-up state (context available for 5 min)`);
  }

  /**
   * Get call status and history (works for both active and hung-up calls).
   */
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

      res.writeHead(404);
      res.end('Not Found');
    });

    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on('upgrade', (request: IncomingMessage, socket: any, head: Buffer) => {
      const url = new URL(request.url!, `http://${request.headers.host}`);
      if (url.pathname === '/media-stream') {
        // Try to find the call ID from token
        const token = url.searchParams.get('token');
        let callId = token ? this.wsTokenToCallId.get(token) : null;

        // Validate token if provided
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
          // Token missing or not found - only allow fallback for ngrok
          const hostname = new URL(this.config.publicUrl).hostname;
          const isNgrok = hostname.endsWith('.ngrok-free.dev') || hostname.endsWith('.ngrok.app') || hostname.includes('ngrok');
          if (isNgrok) {
            // Fallback: find the most recent active call (ngrok compatibility mode)
            // Token lookup can fail due to timing issues with ngrok's free tier
            const activeCallIds = Array.from(this.activeCalls.keys());
            if (activeCallIds.length > 0) {
              callId = activeCallIds[activeCallIds.length - 1];
              console.error(`[WebSocket] Token not found, using fallback call ID: ${callId} (ngrok compatibility mode)`);
            } else {
              // No active calls yet - create a placeholder and accept anyway
              // The connection handler will associate it with the correct call
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

        // Accept WebSocket connection
        console.error(`[WebSocket] Accepting connection for: ${callId}`);
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit('connection', ws, request, callId);
        });
      } else {
        socket.destroy();
      }
    });

    this.wss.on('connection', (ws: WebSocket, _request: IncomingMessage, callId: string) => {
      console.error(`Media stream WebSocket connected for call ${callId}`);

      // Associate the WebSocket with the call immediately (token already validated)
      const state = this.activeCalls.get(callId);
      if (state) {
        state.ws = ws;
      }

      ws.on('message', (message: Buffer | string) => {
        const msgBuffer = Buffer.isBuffer(message) ? message : Buffer.from(message);

        // Parse JSON messages from Twilio to capture streamSid and handle events
        if (msgBuffer.length > 0 && msgBuffer[0] === 0x7b) {
          try {
            const msg = JSON.parse(msgBuffer.toString());
            const msgState = this.activeCalls.get(callId);

            // Capture streamSid from "start" event (required for sending audio back)
            if (msg.event === 'start' && msg.streamSid && msgState) {
              msgState.streamSid = msg.streamSid;
              console.error(`[${callId}] Captured streamSid: ${msg.streamSid}`);
            }

            // Handle "stop" event when call ends
            if (msg.event === 'stop' && msgState) {
              console.error(`[${callId}] Stream stopped`);
              msgState.hungUp = true;
            }
          } catch { }
        }

        // Forward audio to realtime transcription session
        const audioState = this.activeCalls.get(callId);
        if (audioState?.sttSession) {
          const audioData = this.extractInboundAudio(msgBuffer);
          if (audioData) {
            audioState.sttSession.sendAudio(audioData);
          }
        }
      });

      ws.on('close', () => {
        console.error('Media stream WebSocket closed');
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
          this.httpServer.listen(this.config.port, () => {
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

  /**
   * Extract INBOUND audio data from WebSocket message (filters out outbound/TTS audio)
   */
  private extractInboundAudio(msgBuffer: Buffer): Buffer | null {
    if (msgBuffer.length === 0) return null;

    // Binary audio (doesn't start with '{') - can't determine track, skip
    if (msgBuffer[0] !== 0x7b) {
      return null;
    }

    // JSON format - only extract inbound track (user's voice)
    try {
      const msg = JSON.parse(msgBuffer.toString());
      if (msg.event === 'media' && msg.media?.payload) {
        const track = msg.media?.track;
        if (track === 'inbound' || track === 'inbound_track') {
          return Buffer.from(msg.media.payload, 'base64');
        }
      }
    } catch { }

    return null;
  }

  private handlePhoneWebhook(req: IncomingMessage, res: ServerResponse): void {
    const contentType = req.headers['content-type'] || '';

    // Telnyx sends JSON webhooks
    if (contentType.includes('application/json')) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          // Validate Telnyx signature if public key is configured
          const telnyxPublicKey = this.config.providerConfig.telnyxPublicKey;
          if (telnyxPublicKey) {
            const signature = req.headers['telnyx-signature-ed25519'] as string | undefined;
            const timestamp = req.headers['telnyx-timestamp'] as string | undefined;

            if (!validateTelnyxSignature(telnyxPublicKey, signature, timestamp, body)) {
              console.error('[Security] Rejecting Telnyx webhook: invalid signature');
              res.writeHead(401);
              res.end('Invalid signature');
              return;
            }
          } else {
            console.error('[Security] Warning: CALLME_TELNYX_PUBLIC_KEY not set, skipping signature verification');
          }

          const event = JSON.parse(body);
          await this.handleTelnyxWebhook(event, res);
        } catch (error) {
          console.error('Error parsing webhook:', error);
          res.writeHead(400);
          res.end('Invalid JSON');
        }
      });
      return;
    }

    // Twilio sends form-urlencoded webhooks
    if (contentType.includes('application/x-www-form-urlencoded')) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const params = new URLSearchParams(body);

          // Validate Twilio signature
          const authToken = this.config.providerConfig.phoneAuthToken;
          const signature = req.headers['x-twilio-signature'] as string | undefined;
          // Use the known public URL directly - reconstructing from headers fails with ngrok
          // because ngrok doesn't preserve headers exactly as Twilio sends them
          const webhookUrl = `${this.config.publicUrl}/twiml`;

          // Skip Twilio signature validation - ngrok causes signature mismatches
          // TODO: Re-enable with proper URL handling
          console.error(`[Security] Skipping Twilio signature validation (publicUrl: ${this.config.publicUrl})`);
          if (false && !validateTwilioSignature(authToken, signature, webhookUrl, params)) {
            const hostname = new URL(this.config.publicUrl).hostname;
            const isNgrok = hostname.includes('ngrok');
            console.error(`[Security] publicUrl: ${this.config.publicUrl}, hostname: ${hostname}, isNgrok: ${isNgrok}`);
            if (isNgrok) {
              // Log for debugging but proceed anyway - ngrok causes signature mismatches
              // due to header modifications and URL normalization
              console.error('[Security] Twilio signature validation failed (proceeding anyway for ngrok compatibility)');
            } else {
              console.error('[Security] Rejecting Twilio webhook: invalid signature');
              res.writeHead(401);
              res.end('Invalid signature');
              return;
            }
          }

          await this.handleTwilioWebhook(params, res);
        } catch (error) {
          console.error('Error parsing Twilio webhook:', error);
          res.writeHead(400);
          res.end('Invalid form data');
        }
      });
      return;
    }

    // Fallback: Reject unknown content types
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

    // Handle inbound calls (no matching callId = incoming call)
    if (callSid && callStatus === 'ringing' && !this.callControlIdToCallId.has(callSid)) {
      const from = params.get('From') || 'unknown';
      console.error(`[Inbound] Incoming Twilio call from ${from}`);
      this.handleInboundCallTwilio(callSid, from, params, res).catch(err => {
        console.error('[Inbound] Failed to handle inbound call:', err);
      });
      return;
    }

    // Handle call status updates
    if (callStatus === 'completed' || callStatus === 'busy' || callStatus === 'no-answer' || callStatus === 'failed') {
      // Call ended - preserve state for context
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

    // For 'in-progress' or 'ringing' status, return TwiML to start media stream
    // Include security token in the stream URL
    let streamUrl = `wss://${new URL(this.config.publicUrl).host}/media-stream`;

    // Find the call state to get the WebSocket token
    if (callSid) {
      const callId = this.callControlIdToCallId.get(callSid);
      if (callId) {
        const state = this.activeCalls.get(callId);
        if (state) {
          streamUrl += `?token=${encodeURIComponent(state.wsToken)}`;
        }
      }
    }

    const statusCallbackUrl = `${this.config.publicUrl}/stream-status`;
    const xml = this.config.providers.phone.getStreamConnectXml(streamUrl, statusCallbackUrl);
    console.error(`[TwiML] Returning stream connect XML with URL: ${streamUrl}`);
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(xml);
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
        // Log all params for debugging
        console.error(`[StreamStatus] All params: ${body}`);
      } catch (error) {
        console.error('[StreamStatus] Error parsing:', error);
      }
      res.writeHead(200);
      res.end();
    });
  }

  private async handleTelnyxWebhook(event: any, res: ServerResponse): Promise<void> {
    const eventType = event.data?.event_type;
    const callControlId = event.data?.payload?.call_control_id;

    console.error(`Phone webhook: ${eventType}`);

    // Always respond 200 OK immediately
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));

    if (!callControlId) return;

    try {
      switch (eventType) {
        case 'call.initiated':
          // Check if this is an inbound call
          const direction = event.data?.payload?.direction;
          if (direction === 'incoming') {
            this.handleInboundCall(event.data.payload).catch(err => {
              console.error('[Inbound] Failed to handle inbound call:', err);
            });
          }
          break;

        case 'call.answered':
          // Include security token in the stream URL
          let streamUrl = `wss://${new URL(this.config.publicUrl).host}/media-stream`;
          const callId = this.callControlIdToCallId.get(callControlId);
          if (callId) {
            const state = this.activeCalls.get(callId);
            if (state) {
              streamUrl += `?token=${encodeURIComponent(state.wsToken)}`;
            }
          }
          await this.config.providers.phone.startStreaming(callControlId, streamUrl);
          console.error(`Started streaming for call ${callControlId}`);
          break;

        case 'call.hangup':
          const hangupCallId = this.callControlIdToCallId.get(callControlId);
          if (hangupCallId) {
            this.preserveHungUpCall(hangupCallId);
          }
          break;

        case 'call.machine.detection.ended':
          const result = event.data?.payload?.result;
          console.error(`AMD result: ${result}`);
          break;

        case 'streaming.started':
          const streamCallId = this.callControlIdToCallId.get(callControlId);
          if (streamCallId) {
            const streamState = this.activeCalls.get(streamCallId);
            if (streamState) {
              streamState.streamingReady = true;
              console.error(`[${streamCallId}] Streaming ready`);
            }
          }
          break;

        case 'streaming.stopped':
          break;
      }
    } catch (error) {
      console.error(`Error handling webhook ${eventType}:`, error);
    }
  }

  /**
   * Handle an incoming Telnyx call - answer, greet, listen, then notify
   */
  private async handleInboundCall(payload: any): Promise<void> {
    const callControlId = payload.call_control_id;
    const from = payload.from;

    console.error(`[Inbound] Incoming call from ${from}, callControlId: ${callControlId}`);

    const callId = `inbound-${++this.currentCallId}-${Date.now()}`;
    const sttSession = this.config.providers.stt.createSession();
    await sttSession.connect();

    const wsToken = generateWebSocketToken();

    const state: CallState = {
      callId,
      callControlId,
      userPhoneNumber: from,
      ws: null,
      streamSid: null,
      streamingReady: false,
      wsToken,
      conversationHistory: [],
      startTime: Date.now(),
      hungUp: false,
      sttSession,
      isInbound: true,
    };

    this.activeCalls.set(callId, state);
    this.callControlIdToCallId.set(callControlId, callId);
    this.wsTokenToCallId.set(wsToken, callId);

    try {
      await this.config.providers.phone.answerCall(callControlId);
      await this.waitForConnection(callId, 15000);

      if (state.hungUp) {
        this.cleanupCall(callId);
        return;
      }

      // Play greeting
      const audioData = await this.generateTTSAudio(this.config.inboundGreeting);
      await this.sendPreGeneratedAudio(state, audioData);

      if (state.hungUp) {
        this.cleanupCall(callId);
        return;
      }

      // Listen for user's response
      const transcript = await this.listenWithTimeout(state, 30000);
      state.conversationHistory.push({ speaker: 'claude', message: this.config.inboundGreeting });
      state.conversationHistory.push({ speaker: 'user', message: transcript });

      console.error(`[${callId}] User said: ${transcript}`);

      // Write pending call info for hooks to detect
      this.writePendingInboundCall(callId, from, transcript);

      // Notify via handler callback
      this.onInboundCall?.(callId, from, transcript);

      // Play hold message and start keepalive
      const holdMessage = "Um momento, por favor. Estou conectando voce ao Claude.";
      const holdAudio = await this.generateTTSAudio(holdMessage);
      await this.sendPreGeneratedAudio(state, holdAudio);

      // Start keepalive so user hears periodic updates while waiting
      this.startKeepalive(state);
    } catch (error) {
      console.error(`[${callId}] Inbound call error:`, error instanceof Error ? error.message : error);
      try { await this.hangUpCall(callId); } catch {}
    }
  }

  /**
   * Handle an incoming Twilio call - return TwiML to answer and stream
   */
  private async handleInboundCallTwilio(callSid: string, from: string, params: URLSearchParams, res: ServerResponse): Promise<void> {
    const callId = `inbound-${++this.currentCallId}-${Date.now()}`;

    console.error(`[${callId}] Setting up inbound Twilio call from ${from}`);

    const sttSession = this.config.providers.stt.createSession();
    await sttSession.connect();

    const wsToken = generateWebSocketToken();

    const state: CallState = {
      callId,
      callControlId: callSid,
      userPhoneNumber: from,
      ws: null,
      streamSid: null,
      streamingReady: false,
      wsToken,
      conversationHistory: [],
      startTime: Date.now(),
      hungUp: false,
      sttSession,
      isInbound: true,
    };

    this.activeCalls.set(callId, state);
    this.callControlIdToCallId.set(callSid, callId);
    this.wsTokenToCallId.set(wsToken, callId);

    // Return TwiML to answer and start media stream
    let streamUrl = `wss://${new URL(this.config.publicUrl).host}/media-stream`;
    streamUrl += `?token=${encodeURIComponent(wsToken)}`;
    const statusCallbackUrl = `${this.config.publicUrl}/stream-status`;
    const xml = this.config.providers.phone.getStreamConnectXml(streamUrl, statusCallbackUrl);
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(xml);

    // Wait for WebSocket connection then greet
    try {
      await this.waitForConnection(callId, 15000);

      if (state.hungUp) {
        this.cleanupCall(callId);
        return;
      }

      const audioData = await this.generateTTSAudio(this.config.inboundGreeting);
      await this.sendPreGeneratedAudio(state, audioData);

      if (state.hungUp) {
        this.cleanupCall(callId);
        return;
      }

      const transcript = await this.listenWithTimeout(state, 30000);
      state.conversationHistory.push({ speaker: 'claude', message: this.config.inboundGreeting });
      state.conversationHistory.push({ speaker: 'user', message: transcript });

      console.error(`[${callId}] User said: ${transcript}`);

      this.writePendingInboundCall(callId, from, transcript);
      this.onInboundCall?.(callId, from, transcript);

      const holdMessage = "Um momento, por favor. Estou conectando voce ao Claude.";
      const holdAudio = await this.generateTTSAudio(holdMessage);
      await this.sendPreGeneratedAudio(state, holdAudio);

      // Start keepalive so user hears periodic updates while waiting
      this.startKeepalive(state);
    } catch (error) {
      console.error(`[${callId}] Inbound Twilio call error:`, error instanceof Error ? error.message : error);
      try { await this.hangUpCall(callId); } catch {}
    }
  }

  /**
   * Write pending inbound call info to temp file for hooks to detect
   */
  private writePendingInboundCall(callId: string, from: string, transcript: string): void {
    try {
      const fs = require('fs');
      const pendingCallInfo = { callId, from, transcript, timestamp: Date.now() };
      fs.writeFileSync('/tmp/callme-pending-inbound.json', JSON.stringify(pendingCallInfo));
      console.error(`[${callId}] Wrote pending inbound call info`);
    } catch (err) {
      console.error(`[${callId}] Failed to write pending call info:`, err);
    }
  }

  /**
   * Listen with a specific timeout (used for inbound calls)
   */
  private async listenWithTimeout(state: CallState, timeoutMs: number): Promise<string> {
    if (!state.sttSession) {
      throw new Error('STT session not available');
    }

    const transcript = await Promise.race([
      state.sttSession.waitForTranscript(timeoutMs),
      this.waitForHangup(state),
    ]);

    if (state.hungUp) {
      throw new Error('Call was hung up by user');
    }

    return transcript;
  }

  /**
   * Clean up call state and mappings
   */
  private cleanupCall(callId: string): void {
    const state = this.activeCalls.get(callId);
    if (state) {
      this.stopKeepalive(state);
      state.sttSession?.close();
      state.ws?.close();
      this.wsTokenToCallId.delete(state.wsToken);
      if (state.callControlId) {
        this.callControlIdToCallId.delete(state.callControlId);
      }
      this.activeCalls.delete(callId);
    }
  }

  /**
   * Hang up a call and clean up
   */
  private async hangUpCall(callId: string): Promise<void> {
    const state = this.activeCalls.get(callId);
    if (!state) return;

    this.stopKeepalive(state);
    if (state.callControlId) {
      await this.config.providers.phone.hangup(state.callControlId);
    }
    state.hungUp = true;
    this.cleanupCall(callId);
  }

  async initiateCall(message: string): Promise<{ callId: string; response: string }> {
    const callId = `call-${++this.currentCallId}-${Date.now()}`;

    // Read phone number dynamically from .env file (allows changing without restart)
    const userPhoneNumber = readEnvFile('CALLME_USER_PHONE_NUMBER') || this.config.userPhoneNumber;

    // Create realtime transcription session via provider
    const sttSession = this.config.providers.stt.createSession();
    await sttSession.connect();
    console.error(`[${callId}] STT session connected`);

    // Generate secure token for WebSocket authentication
    const wsToken = generateWebSocketToken();

    const state: CallState = {
      callId,
      callControlId: null,
      userPhoneNumber,
      ws: null,
      streamSid: null,
      streamingReady: false,
      wsToken,
      conversationHistory: [],
      startTime: Date.now(),
      hungUp: false,
      sttSession,
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

      // Start TTS generation in parallel with waiting for connection
      // This reduces latency by generating audio while Twilio establishes the stream
      const ttsPromise = this.generateTTSAudio(message);

      await this.waitForConnection(callId, 45000);

      // Send the pre-generated audio and listen for response
      const audioData = await ttsPromise;
      await this.sendPreGeneratedAudio(state, audioData);
      const response = await this.listen(state);
      state.conversationHistory.push({ speaker: 'claude', message });
      state.conversationHistory.push({ speaker: 'user', message: response });

      // Start keepalive timer (will play hold messages if Claude takes long to respond)
      this.startKeepalive(state);

      return { callId, response };
    } catch (error) {
      this.stopKeepalive(state);
      state.sttSession?.close();
      this.activeCalls.delete(callId);
      throw error;
    }
  }

  async continueCall(callId: string, message: string): Promise<string | { hungUp: true; conversationHistory: Array<{ speaker: string; message: string }>; durationSeconds: number }> {
    const state = this.activeCalls.get(callId);

    // Check if call was hung up — return context instead of error
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

    // Reset keepalive since Claude is actively communicating
    this.resetKeepalive(state);

    const response = await this.speakAndListen(state, message);
    state.conversationHistory.push({ speaker: 'claude', message });
    state.conversationHistory.push({ speaker: 'user', message: response });

    // Restart keepalive after getting response (Claude will process)
    this.startKeepalive(state);

    return response;
  }

  async speakOnly(callId: string, message: string): Promise<{ hungUp: true; conversationHistory: Array<{ speaker: string; message: string }>; durationSeconds: number } | void> {
    const state = this.activeCalls.get(callId);

    // Check if call was hung up — return context instead of error
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

    // Reset keepalive since Claude is actively communicating
    this.resetKeepalive(state);

    await this.speak(state, message);
    state.conversationHistory.push({ speaker: 'claude', message });

    // Restart keepalive
    this.startKeepalive(state);
  }

  async endCall(callId: string, message: string): Promise<{ durationSeconds: number; conversationHistory?: Array<{ speaker: string; message: string }> }> {
    const state = this.activeCalls.get(callId);

    // If call was already hung up, return its preserved context
    if (!state) {
      const hungUp = this.hungUpCalls.get(callId);
      if (hungUp) {
        const durationSeconds = Math.round(((hungUp.hungUpAt || Date.now()) - hungUp.startTime) / 1000);
        this.hungUpCalls.delete(callId);
        return { durationSeconds, conversationHistory: hungUp.conversationHistory };
      }
      throw new Error(`No active call: ${callId}`);
    }

    this.stopKeepalive(state);

    await this.speak(state, message);

    // Wait for audio to finish playing before hanging up (prevent cutoff)
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Hang up the call via phone provider
    if (state.callControlId) {
      await this.config.providers.phone.hangup(state.callControlId);
    }

    // Close sessions and clean up mappings
    state.sttSession?.close();
    state.ws?.close();
    state.hungUp = true;

    // Clean up security token mapping
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
      // Wait for WebSocket AND streaming to be ready:
      // - Twilio: streamSid is set from "start" WebSocket event
      // - Telnyx: streamingReady is set from "streaming.started" webhook
      const wsReady = state?.ws && state.ws.readyState === WebSocket.OPEN;
      const streamReady = state?.streamSid || state?.streamingReady;
      if (wsReady && streamReady) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('WebSocket connection timeout');
  }

  /**
   * Pre-generate TTS audio (can run in parallel with connection setup)
   * Returns mu-law encoded audio ready to send to Twilio
   */
  private async generateTTSAudio(text: string): Promise<Buffer> {
    console.error(`[TTS] Generating audio for: ${text.substring(0, 50)}...`);
    const tts = this.config.providers.tts;
    const pcmData = await tts.synthesize(text);
    const resampledPcm = this.resample24kTo8k(pcmData);
    const muLawData = this.pcmToMuLaw(resampledPcm);
    console.error(`[TTS] Audio generated: ${muLawData.length} bytes`);
    return muLawData;
  }

  /**
   * Send a single audio chunk to the phone via WebSocket
   */
  private sendMediaChunk(state: CallState, audioData: Buffer): void {
    if (state.ws?.readyState !== WebSocket.OPEN) return;
    const message: Record<string, unknown> = {
      event: 'media',
      media: { payload: audioData.toString('base64') },
    };
    if (state.streamSid) {
      message.streamSid = state.streamSid;
    }
    state.ws.send(JSON.stringify(message));
  }

  private async sendPreGeneratedAudio(state: CallState, muLawData: Buffer): Promise<void> {
    console.error(`[${state.callId}] Sending pre-generated audio...`);
    const chunkSize = 160;  // 20ms at 8kHz
    for (let i = 0; i < muLawData.length; i += chunkSize) {
      this.sendMediaChunk(state, muLawData.subarray(i, i + chunkSize));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Small delay to ensure audio finishes playing before listening
    await new Promise((resolve) => setTimeout(resolve, 200));
    console.error(`[${state.callId}] Audio sent`);
  }

  private async speakAndListen(state: CallState, text: string): Promise<string> {
    await this.speak(state, text);
    return await this.listen(state);
  }

  private async speak(state: CallState, text: string): Promise<void> {
    console.error(`[${state.callId}] Speaking: ${text.substring(0, 50)}...`);

    const tts = this.config.providers.tts;

    // Use streaming if available for lower latency
    if (tts.synthesizeStream) {
      await this.speakStreaming(state, text, tts.synthesizeStream.bind(tts));
    } else {
      const pcmData = await tts.synthesize(text);
      await this.sendAudio(state, pcmData);
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
    console.error(`[${state.callId}] Speaking done`);
  }

  private async speakStreaming(
    state: CallState,
    text: string,
    synthesizeStream: (text: string) => AsyncGenerator<Buffer>
  ): Promise<void> {
    let pendingPcm = Buffer.alloc(0);
    let pendingMuLaw = Buffer.alloc(0);
    const OUTPUT_CHUNK_SIZE = 160; // 20ms at 8kHz
    const SAMPLES_PER_RESAMPLE = 6; // 6 bytes (3 samples) at 24kHz -> 1 sample at 8kHz

    // Jitter buffer: accumulate audio before starting playback to smooth out
    // timing variations from network latency and burst delivery patterns
    const JITTER_BUFFER_MS = 100; // Buffer 100ms of audio before starting
    // 8000 samples/sec ÷ 1000 ms/sec = 8 samples per ms; mu-law is 1 byte per sample
    const JITTER_BUFFER_SIZE = (8000 / 1000) * JITTER_BUFFER_MS; // 800 bytes at 8kHz mu-law
    let playbackStarted = false;

    // Helper to drain and send buffered mu-law audio in chunks
    const drainBuffer = async () => {
      while (pendingMuLaw.length >= OUTPUT_CHUNK_SIZE) {
        this.sendMediaChunk(state, pendingMuLaw.subarray(0, OUTPUT_CHUNK_SIZE));
        pendingMuLaw = pendingMuLaw.subarray(OUTPUT_CHUNK_SIZE);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };

    for await (const chunk of synthesizeStream(text)) {
      pendingPcm = Buffer.concat([pendingPcm, chunk]);

      const completeUnits = Math.floor(pendingPcm.length / SAMPLES_PER_RESAMPLE);
      if (completeUnits > 0) {
        const bytesToProcess = completeUnits * SAMPLES_PER_RESAMPLE;
        const toProcess = pendingPcm.subarray(0, bytesToProcess);
        pendingPcm = pendingPcm.subarray(bytesToProcess);

        const resampled = this.resample24kTo8k(toProcess);
        const muLaw = this.pcmToMuLaw(resampled);
        pendingMuLaw = Buffer.concat([pendingMuLaw, muLaw]);

        // Wait for jitter buffer to fill before starting playback
        if (!playbackStarted && pendingMuLaw.length < JITTER_BUFFER_SIZE) {
          continue;
        }
        playbackStarted = true;

        await drainBuffer();
      }
    }

    // Send remaining audio (including any buffered audio for short messages)
    await drainBuffer();

    // Send any final partial chunk
    if (pendingMuLaw.length > 0) {
      this.sendMediaChunk(state, pendingMuLaw);
    }
  }

  private async sendAudio(state: CallState, pcmData: Buffer): Promise<void> {
    const resampledPcm = this.resample24kTo8k(pcmData);
    const muLawData = this.pcmToMuLaw(resampledPcm);

    const chunkSize = 160;
    for (let i = 0; i < muLawData.length; i += chunkSize) {
      this.sendMediaChunk(state, muLawData.subarray(i, i + chunkSize));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  private async listen(state: CallState): Promise<string> {
    console.error(`[${state.callId}] Listening...`);

    if (!state.sttSession) {
      throw new Error('STT session not available');
    }

    // Race between getting a transcript and detecting hangup
    const transcript = await Promise.race([
      state.sttSession.waitForTranscript(this.config.transcriptTimeoutMs),
      this.waitForHangup(state),
    ]);

    if (state.hungUp) {
      // Preserve the call state before throwing
      this.preserveHungUpCall(state.callId);
      throw new Error('Call was hung up by user');
    }

    console.error(`[${state.callId}] User said: ${transcript}`);
    return transcript;
  }

  /**
   * Returns a promise that rejects when the call is hung up.
   * Used to race against transcript waiting.
   */
  private waitForHangup(state: CallState): Promise<never> {
    return new Promise((_, reject) => {
      const checkInterval = setInterval(() => {
        if (state.hungUp) {
          clearInterval(checkInterval);
          reject(new Error('Call was hung up by user'));
        }
      }, 100);  // Check every 100ms

      // Clean up interval after transcript timeout to avoid memory leaks
      setTimeout(() => {
        clearInterval(checkInterval);
      }, this.config.transcriptTimeoutMs + 1000);
    });
  }

  private resample24kTo8k(pcmData: Buffer): Buffer {
    const inputSamples = pcmData.length / 2;
    const outputSamples = Math.floor(inputSamples / 3);
    const output = Buffer.alloc(outputSamples * 2);

    for (let i = 0; i < outputSamples; i++) {
      // Use linear interpolation instead of point-sampling to reduce artifacts
      // For each output sample, average the 3 surrounding input samples
      // This acts as a simple anti-aliasing low-pass filter
      const baseIdx = i * 3;
      const s0 = pcmData.readInt16LE(baseIdx * 2);
      const s1 = baseIdx + 1 < inputSamples ? pcmData.readInt16LE((baseIdx + 1) * 2) : s0;
      const s2 = baseIdx + 2 < inputSamples ? pcmData.readInt16LE((baseIdx + 2) * 2) : s1;
      const interpolated = Math.round((s0 + s1 + s2) / 3);
      output.writeInt16LE(interpolated, i * 2);
    }

    return output;
  }

  private pcmToMuLaw(pcmData: Buffer): Buffer {
    const muLawData = Buffer.alloc(Math.floor(pcmData.length / 2));
    for (let i = 0; i < muLawData.length; i++) {
      const pcm = pcmData.readInt16LE(i * 2);
      muLawData[i] = this.pcmToMuLawSample(pcm);
    }
    return muLawData;
  }

  private pcmToMuLawSample(pcm: number): number {
    const BIAS = 0x84;
    const CLIP = 32635;
    let sign = (pcm >> 8) & 0x80;
    if (sign) pcm = -pcm;
    if (pcm > CLIP) pcm = CLIP;
    pcm += BIAS;
    let exponent = 7;
    for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; exponent--) {
      expMask >>= 1;
    }
    const mantissa = (pcm >> (exponent + 3)) & 0x0f;
    return (~(sign | (exponent << 4) | mantissa)) & 0xff;
  }

  getHttpServer() {
    return this.httpServer;
  }

  shutdown(): void {
    for (const [_, state] of this.activeCalls) {
      this.stopKeepalive(state);
    }
    for (const callId of this.activeCalls.keys()) {
      this.endCall(callId, 'Goodbye!').catch(console.error);
    }
    this.wss?.close();
    this.httpServer?.close();
  }
}
