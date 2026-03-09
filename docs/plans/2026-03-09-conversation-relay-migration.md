# ConversationRelay Migration Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace raw audio pipeline (mu-law, resampling, OpenAI STT/TTS) with Twilio ConversationRelay, which handles STT+TTS server-side and sends/receives text over WebSocket.

**Architecture:** Twilio's ConversationRelay noun in TwiML connects to our WebSocket. Twilio handles all audio processing (STT via Deepgram, TTS via ElevenLabs). Our server only sends/receives JSON text messages. This eliminates ~400 lines of audio pipeline code.

**Tech Stack:** Twilio ConversationRelay, WebSocket (ws), TypeScript, Bun

---

### Task 1: Update PhoneProvider interface and TwilioPhoneProvider

**Files:**
- Modify: `server/src/providers/types.ts`
- Modify: `server/src/providers/phone-twilio.ts`

**Step 1: Update PhoneProvider interface**

In `types.ts`, rename `getStreamConnectXml` to `getConnectXml` and add ConversationRelay config:

```ts
// In PhoneProvider interface, replace:
getStreamConnectXml(streamUrl: string, statusCallbackUrl?: string): string;
// With:
getConnectXml(wsUrl: string, options?: { welcomeGreeting?: string; statusCallbackUrl?: string }): string;
```

Also add `ConversationRelayConfig` to types.ts:

```ts
export interface ConversationRelayConfig {
  ttsProvider?: string;       // 'ElevenLabs' | 'Google' | 'Amazon'
  voice?: string;             // Provider-specific voice ID
  language?: string;          // e.g. 'pt-BR'
  transcriptionProvider?: string; // 'Deepgram' | 'Google'
  speechModel?: string;
  interruptible?: boolean;
  dtmfDetection?: boolean;
  welcomeGreeting?: string;
}
```

**Step 2: Rewrite TwilioPhoneProvider.getConnectXml**

In `phone-twilio.ts`, replace `getStreamConnectXml` with:

```ts
getConnectXml(wsUrl: string, options?: { welcomeGreeting?: string; statusCallbackUrl?: string }): string {
  const greeting = options?.welcomeGreeting ? ` welcomeGreeting="${this.escapeXml(options.welcomeGreeting)}"` : '';
  const statusAttr = options?.statusCallbackUrl
    ? ` statusCallback="${options.statusCallbackUrl}" statusCallbackMethod="POST"`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect${statusAttr}>
    <ConversationRelay url="${wsUrl}" ttsProvider="ElevenLabs" voice="${this.voice || 'onwK4e9ZLuTAKqWW03F9'}" language="pt-BR" transcriptionProvider="Deepgram" dtmfDetection="true" interruptible="true"${greeting} />
  </Connect>
</Response>`;
}

private escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

Update `initialize()` to store voice:

```ts
private voice: string | null = null;

initialize(config: PhoneConfig): void {
  this.accountSid = config.accountSid;
  this.authToken = config.authToken;
  this.voice = config.voice || null;
  console.error(`Phone provider: Twilio (ConversationRelay)`);
}
```

Update `PhoneConfig` in types.ts to include optional `voice`:

```ts
export interface PhoneConfig {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
  voice?: string;  // TTS voice for ConversationRelay
}
```

**Step 3: Update providers/index.ts**

Pass voice config to phone provider:

```ts
export function createPhoneProvider(config: ProviderConfig): PhoneProvider {
  const provider = new TwilioPhoneProvider();
  provider.initialize({
    accountSid: config.phoneAccountSid,
    authToken: config.phoneAuthToken,
    phoneNumber: config.phoneNumber,
    voice: config.ttsVoice,
  });
  return provider;
}
```

Make STT provider optional in `ProviderRegistry` (only needed for WhatsApp audio transcription now):

```ts
export interface ProviderRegistry {
  phone: PhoneProvider;
  tts: TTSProvider;
  stt: RealtimeSTTProvider;  // Still needed for WhatsApp audio transcription
}
```

**Step 4: Commit**

```bash
git add server/src/providers/
git commit -m "feat: update PhoneProvider for ConversationRelay TwiML"
```

---

### Task 2: Rewrite phone-call.ts CallState and WebSocket handler

**Files:**
- Modify: `server/src/phone-call.ts`

This is the biggest task. The entire audio pipeline is replaced with text-based WebSocket messages.

**Step 1: Simplify CallState**

Remove all audio-related fields:

```ts
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
  // ConversationRelay: pending transcript from user speech
  pendingTranscript: {
    resolve: (text: string) => void;
    reject: (err: Error) => void;
  } | null;
  // ConversationRelay session ID (from setup message)
  relaySessionId?: string;
}
```

**Step 2: Rewrite WebSocket message handler**

Replace the binary audio handler with ConversationRelay JSON protocol:

```ts
ws.on('message', (message: Buffer | string) => {
  const text = typeof message === 'string' ? message : message.toString();
  let msg: any;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }

  const state = this.activeCalls.get(callId);
  if (!state) return;

  switch (msg.type) {
    case 'setup':
      // ConversationRelay connected — store session info
      state.relaySessionId = msg.sessionId;
      console.error(`[${callId}] ConversationRelay setup: sessionId=${msg.sessionId}, from=${msg.from}`);
      break;

    case 'prompt':
      // User finished speaking — deliver transcript
      console.error(`[${callId}] User said: "${msg.voicePrompt}"`);
      if (state.pendingTranscript) {
        state.pendingTranscript.resolve(msg.voicePrompt);
        state.pendingTranscript = null;
      }
      break;

    case 'interrupt':
      // User interrupted TTS playback
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
  const state = this.activeCalls.get(callId);
  if (state) {
    state.hungUp = true;
    if (state.pendingTranscript) {
      state.pendingTranscript.reject(new Error('Call was hung up by user'));
      state.pendingTranscript = null;
    }
  }
});
```

**Step 3: Replace speak() with sendText()**

```ts
private sendText(state: CallState, text: string): void {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    throw new Error('WebSocket not connected');
  }
  state.ws.send(JSON.stringify({
    type: 'text',
    token: text,
    last: true,
  }));
}
```

**Step 4: Replace listen() with waitForPrompt()**

```ts
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
```

**Step 5: Simplify speakAndListen()**

```ts
private async speakAndListen(state: CallState, text: string): Promise<string> {
  this.sendText(state, text);
  return this.waitForPrompt(state, this.config.transcriptTimeoutMs);
}
```

**Step 6: Simplify speak() (now just sendText)**

The old `speak()` did TTS + resampling + chunking. Now it's just:

```ts
private async speak(state: CallState, text: string): Promise<void> {
  this.sendText(state, text);
  // Small delay to let TTS start playing before we do anything else
  await new Promise(r => setTimeout(r, 500));
}
```

**Step 7: Delete removed code**

Remove these methods entirely:
- `generateTTSAudio()`
- `sendMediaChunk()`
- `sendPreGeneratedAudio()`
- `speakStreaming()`
- `sendAudio()`
- `extractInboundAudio()`
- `resample24kTo8k()`
- `pcmToMuLaw()`
- `pcmToMuLawSample()`
- `startKeepalive()` / `stopKeepalive()` / `resetKeepalive()` (ConversationRelay keeps connection alive)

Remove from CallState:
- `streamSid`
- `streamingReady`
- `sttSession`
- `keepaliveTimer`
- `isSendingAudio`
- `isPlayingKeepalive`

Remove imports: STT provider types (no longer used in this file)

**Step 8: Update TwiML response in handleTwilioWebhook()**

Replace the stream URL construction with ConversationRelay:

```ts
// Old:
const xml = this.config.providers.phone.getStreamConnectXml(streamUrl, statusCallbackUrl);

// New:
const xml = this.config.providers.phone.getConnectXml(streamUrl, {
  statusCallbackUrl,
});
```

**Step 9: Update handleInboundCallTwilio()**

Major simplification — no STT session, no TTS greeting (welcomeGreeting handles it), no keepalive:

```ts
private async handleInboundCallTwilio(callSid: string, from: string, params: URLSearchParams, res: ServerResponse): Promise<void> {
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

  // Return TwiML with ConversationRelay — greeting is handled by welcomeGreeting attribute
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

    // Tell user we're connecting
    this.sendText(state, "Um momento, por favor. Estou conectando você ao Claude.");
  } catch (error) {
    console.error(`[${callId}] Inbound call error:`, error instanceof Error ? error.message : error);
    try { await this.hangUpCall(callId); } catch {}
  }
}
```

**Step 10: Update initiateCall()**

```ts
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

    await this.waitForConnection(callId, 45000);

    // Send message and wait for response (ConversationRelay handles TTS)
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
```

**Step 11: Update continueCall(), speakOnly(), endCall()**

Replace speak/listen calls with sendText/waitForPrompt:

- `continueCall`: `speakAndListen(state, message)` stays (it now uses sendText + waitForPrompt internally). Remove keepalive calls.
- `speakOnly`: `speak(state, message)` → `this.sendText(state, message)`. Remove keepalive.
- `endCall`: `speak(state, message)` → `this.sendText(state, message)`. Remove 2s delay (ConversationRelay handles TTS completion). Send `{ type: "end" }` before hangup.

For endCall, add session end:

```ts
// After sending farewell message, end the ConversationRelay session
await new Promise(r => setTimeout(r, 2000)); // Let TTS finish
if (state.ws?.readyState === WebSocket.OPEN) {
  state.ws.send(JSON.stringify({ type: 'end' }));
}
```

**Step 12: Update waitForConnection()**

No longer needs `streamSid` — just wait for WebSocket:

```ts
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
```

**Step 13: Update notifyWhatsAppMessage()**

No more TTS — send text that ConversationRelay will speak:

```ts
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
```

**Step 14: Commit**

```bash
git add server/src/phone-call.ts
git commit -m "feat: rewrite phone-call.ts for ConversationRelay (text-based WebSocket)"
```

---

### Task 3: Update loadServerConfig and remove unused config

**Files:**
- Modify: `server/src/phone-call.ts` (loadServerConfig function)

**Step 1: Simplify ServerConfig**

Remove `holdIntervalMs`, `holdMessages` and other audio-specific config. Keep `transcriptTimeoutMs` (still used for waitForPrompt timeout).

Check if `inboundGreeting` and `getInboundGreeting` are still needed — yes, for the `welcomeGreeting` attribute.

**Step 2: Commit**

```bash
git add server/src/phone-call.ts
git commit -m "chore: clean up ServerConfig after ConversationRelay migration"
```

---

### Task 4: Update http-server.ts references

**Files:**
- Modify: `server/src/http-server.ts`

**Step 1: Update any references to old method names**

If `getStreamConnectXml` is called anywhere in http-server.ts, update to `getConnectXml`. (Currently it's only called from phone-call.ts internally, so http-server.ts may not need changes beyond what was already done.)

**Step 2: Verify the server starts**

```bash
cd server && bun run src/http-server.ts
```

Check logs for "Lein Server ready" without errors.

**Step 3: Commit**

```bash
git add server/src/http-server.ts
git commit -m "chore: update http-server references for ConversationRelay"
```

---

### Task 5: Manual integration test

**Step 1: Restart PM2**

```bash
pm2 restart lein --update-env
pm2 logs lein --lines 20 --nostream
```

Verify: "Lein Server ready" appears, no crashes.

**Step 2: Test outbound call**

```bash
curl -X POST http://localhost:3334/api/initiate_call \
  -H 'Content-Type: application/json' \
  -d '{"message": "Oi Lucas, testando o ConversationRelay. Pode me ouvir?"}'
```

Verify:
- Phone rings
- Greeting is spoken by ElevenLabs voice (via Twilio)
- User speech is transcribed and returned as `response`

**Step 3: Test inbound call**

Call the Lein phone number. Verify:
- Greeting plays automatically (welcomeGreeting)
- Speech is transcribed
- Claude session spawns

**Step 4: Test WhatsApp during call**

While on a call, send WhatsApp message. Verify:
- Message is piggybacked in next `continue_call` response
- No new Claude session spawned

**Step 5: Commit if any fixes needed**

```bash
git add -A
git commit -m "fix: adjustments from ConversationRelay integration test"
```

---

### Task 6: Clean up dead code

**Files:**
- Possibly modify: `server/src/providers/stt-openai-realtime.ts` (keep — still used for WhatsApp audio)
- Possibly modify: `server/src/providers/tts-openai.ts` (keep — may be used elsewhere)

**Step 1: Verify TTS/STT providers are still needed**

- STT provider: still used by WhatsApp audio transcription (Whisper in whatsapp.ts) — but that's a different code path (direct API call, not the realtime provider). Check if `stt-openai-realtime.ts` is imported anywhere besides phone-call.ts.
- TTS providers: check if imported anywhere besides phone-call.ts.

If stt-openai-realtime.ts is only used by phone-call.ts (which no longer needs it), it can stay but won't be instantiated for calls.

**Step 2: Commit**

```bash
git commit -m "chore: clean up unused audio pipeline references"
```
