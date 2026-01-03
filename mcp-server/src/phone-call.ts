import Twilio from 'twilio';
import WebSocket from 'ws';
import { createServer } from 'http';
import OpenAI from 'openai';

interface CallState {
  callId: string;
  ws: WebSocket;
  conversationHistory: Array<{ speaker: 'claude' | 'user'; message: string }>;
  startTime: number;
  openai: OpenAI;
  config: Config;
}

interface Config {
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioPhoneNumber: string;
  userPhoneNumber: string;
  openaiApiKey: string;
  publicUrl: string;
  port: number;
}

export function loadConfig(): Config {
  const required = [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_PHONE_NUMBER',
    'USER_PHONE_NUMBER',
    'OPENAI_API_KEY',
    'PUBLIC_URL',
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
        'Please configure these in your .env file or Claude Code settings.'
    );
  }

  return {
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID!,
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN!,
    twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER!,
    userPhoneNumber: process.env.USER_PHONE_NUMBER!,
    openaiApiKey: process.env.OPENAI_API_KEY!,
    publicUrl: process.env.PUBLIC_URL!,
    port: parseInt(process.env.PORT || '3000', 10),
  };
}

/**
 * Stateful call manager - maintains active calls
 * Allows multi-turn conversations with Claude Code in control
 */
export class CallManager {
  private activeCalls = new Map<string, CallState>();
  private httpServer: any = null;
  private wss: WebSocket.Server | null = null;
  private twilioClient: Twilio.Twilio;
  private config: Config;
  private currentCallId = 0;

  constructor(config: Config) {
    this.config = config;
    this.twilioClient = Twilio(config.twilioAccountSid, config.twilioAuthToken);
    this.startServer();
  }

  private startServer() {
    // Create HTTP server for Twilio webhooks
    this.httpServer = createServer((req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);

      if (url.pathname === '/twiml') {
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${new URL(this.config.publicUrl).host}/media-stream" />
  </Connect>
</Response>`;
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end(twiml);
      } else if (url.pathname === '/status') {
        res.writeHead(200);
        res.end('OK');
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    // Create WebSocket server
    this.wss = new WebSocket.Server({ noServer: true });

    this.httpServer.on('upgrade', (request: any, socket: any, head: any) => {
      const url = new URL(request.url!, `http://${request.headers.host}`);
      if (url.pathname === '/media-stream') {
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    this.wss.on('connection', (ws) => {
      console.error('Twilio WebSocket connected');
      // Connection will be associated with a call when we receive the 'start' event
      ws.on('message', (message: string) => {
        try {
          const msg = JSON.parse(message);
          if (msg.event === 'start') {
            const streamSid = msg.start.streamSid;
            console.error('Call started, streamSid:', streamSid);
            // Find the call waiting for this connection
            for (const [callId, state] of this.activeCalls.entries()) {
              if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
                state.ws = ws;
                console.error(`Associated streamSid ${streamSid} with callId ${callId}`);
                break;
              }
            }
          }
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      });
    });

    this.httpServer.listen(this.config.port, () => {
      console.error(`Call manager listening on port ${this.config.port}`);
    });
  }

  async initiateCall(message: string): Promise<{ callId: string; response: string }> {
    const callId = `call-${++this.currentCallId}`;

    // Create call state
    const state: CallState = {
      callId,
      ws: null as any, // Will be set when WebSocket connects
      conversationHistory: [],
      startTime: Date.now(),
      openai: new OpenAI({ apiKey: this.config.openaiApiKey }),
      config: this.config,
    };

    this.activeCalls.set(callId, state);

    // Initiate Twilio call
    try {
      const call = await this.twilioClient.calls.create({
        url: `${this.config.publicUrl}/twiml`,
        to: this.config.userPhoneNumber,
        from: this.config.twilioPhoneNumber,
        timeout: 60,
      });

      console.error(`Call initiated: ${call.sid} (callId: ${callId})`);

      // Wait for WebSocket connection (max 10 seconds)
      const ws = await this.waitForConnection(callId, 10000);
      state.ws = ws;

      // Speak the initial message and get response
      const response = await this.speakAndListen(callId, message);
      state.conversationHistory.push({ speaker: 'claude', message });
      state.conversationHistory.push({ speaker: 'user', message: response });

      return { callId, response };
    } catch (error) {
      this.activeCalls.delete(callId);
      throw error;
    }
  }

  async continueCall(callId: string, message: string): Promise<string> {
    const state = this.activeCalls.get(callId);
    if (!state) {
      throw new Error(`No active call found with ID: ${callId}`);
    }

    const response = await this.speakAndListen(callId, message);
    state.conversationHistory.push({ speaker: 'claude', message });
    state.conversationHistory.push({ speaker: 'user', message: response });

    return response;
  }

  async endCall(callId: string, message: string): Promise<void> {
    const state = this.activeCalls.get(callId);
    if (!state) {
      throw new Error(`No active call found with ID: ${callId}`);
    }

    // Speak final message
    await this.speak(state, message);
    state.conversationHistory.push({ speaker: 'claude', message });

    // Close the call
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.close();
    }

    // Clean up
    this.activeCalls.delete(callId);
    console.error(`Call ${callId} ended. Duration: ${Math.round((Date.now() - state.startTime) / 1000)}s`);
  }

  getActiveCallIds(): string[] {
    return Array.from(this.activeCalls.keys());
  }

  private async waitForConnection(callId: string, timeout: number): Promise<WebSocket> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const state = this.activeCalls.get(callId);
      if (state?.ws && state.ws.readyState === WebSocket.OPEN) {
        return state.ws;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('WebSocket connection timeout');
  }

  private async speakAndListen(callId: string, text: string): Promise<string> {
    const state = this.activeCalls.get(callId);
    if (!state) {
      throw new Error(`No active call: ${callId}`);
    }

    await this.speak(state, text);
    const response = await this.listen(state);
    return response;
  }

  private async speak(state: CallState, text: string): Promise<void> {
    console.error(`[${state.callId}] Speaking: ${text}`);

    // Generate speech with OpenAI TTS
    const audioResponse = await state.openai.audio.speech.create({
      model: 'tts-1',
      voice: 'onyx',
      input: text,
      response_format: 'pcm',
      speed: 1.0,
    });

    const arrayBuffer = await audioResponse.arrayBuffer();
    const pcmData = Buffer.from(arrayBuffer);
    const muLawData = this.pcmToMuLaw(pcmData);

    // Send audio to Twilio in chunks
    const chunkSize = 160; // 20ms chunks for μ-law @ 8kHz

    for (let i = 0; i < muLawData.length; i += chunkSize) {
      const chunk = muLawData.slice(i, i + chunkSize);
      if (state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(
          JSON.stringify({
            event: 'media',
            media: {
              payload: chunk.toString('base64'),
            },
          })
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // Wait for speech to finish
    await new Promise((resolve) => setTimeout(resolve, text.length * 50));
  }

  private async listen(state: CallState): Promise<string> {
    return new Promise((resolve, reject) => {
      const audioChunks: Buffer[] = [];
      let silenceTimer: NodeJS.Timeout | null = null;
      const SILENCE_THRESHOLD = 2000;

      const onMessage = async (message: string) => {
        try {
          const msg = JSON.parse(message);

          if (msg.event === 'media' && msg.media?.payload) {
            const audioData = Buffer.from(msg.media.payload, 'base64');
            audioChunks.push(audioData);

            if (silenceTimer) clearTimeout(silenceTimer);
            silenceTimer = setTimeout(async () => {
              state.ws.off('message', onMessage);
              const transcript = await this.transcribeAudio(state, audioChunks);
              console.error(`[${state.callId}] User said: ${transcript}`);
              resolve(transcript);
            }, SILENCE_THRESHOLD);
          }
        } catch (error) {
          console.error('Error processing message:', error);
        }
      };

      state.ws.on('message', onMessage);

      // Timeout after 60 seconds
      setTimeout(() => {
        state.ws.off('message', onMessage);
        if (silenceTimer) clearTimeout(silenceTimer);
        reject(new Error('Response timeout'));
      }, 60000);
    });
  }

  private async transcribeAudio(state: CallState, audioChunks: Buffer[]): Promise<string> {
    if (audioChunks.length === 0) {
      return '';
    }

    const fullAudio = Buffer.concat(audioChunks);
    const wavBuffer = this.muLawToWav(fullAudio);

    try {
      const file = new File([wavBuffer], 'audio.wav', { type: 'audio/wav' });
      const transcription = await state.openai.audio.transcriptions.create({
        file,
        model: 'whisper-1',
      });

      return transcription.text;
    } catch (error) {
      console.error('Transcription error:', error);
      return '[transcription failed]';
    }
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
    const muLaw = ~(sign | (exponent << 4) | mantissa);

    return muLaw & 0xff;
  }

  private muLawToWav(muLawData: Buffer): Buffer {
    const pcmData = Buffer.alloc(muLawData.length * 2);

    for (let i = 0; i < muLawData.length; i++) {
      const muLaw = muLawData[i];
      const pcm = this.muLawToPcm(muLaw);
      pcmData.writeInt16LE(pcm, i * 2);
    }

    // Create WAV header
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcmData.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(8000, 24);
    header.writeUInt32LE(16000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcmData.length, 40);

    return Buffer.concat([header, pcmData]);
  }

  private muLawToPcm(muLaw: number): number {
    const BIAS = 0x84;
    const sign = muLaw & 0x80;
    const exponent = (muLaw & 0x70) >> 4;
    const mantissa = muLaw & 0x0f;
    const step = 4 << (exponent + 1);
    const pcm = BIAS + mantissa * step;
    return sign ? -pcm : pcm;
  }

  shutdown() {
    // End all active calls
    for (const callId of this.activeCalls.keys()) {
      try {
        this.endCall(callId, 'The call manager is shutting down. Goodbye!').catch(console.error);
      } catch (error) {
        console.error(`Error ending call ${callId}:`, error);
      }
    }

    if (this.wss) {
      this.wss.close();
    }
    if (this.httpServer) {
      this.httpServer.close();
    }
  }
}
