import Twilio from 'twilio';
import WebSocket from 'ws';
import { createServer } from 'http';
import OpenAI from 'openai';

interface CallResult {
  status: 'completed' | 'failed' | 'timeout';
  transcript: string;
  duration: number;
  callId?: string;
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

function loadConfig(): Config {
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
 * Simple conversation bridge - NO AI here!
 * Just handles voice I/O and basic follow-up logic.
 * Claude Code (the main instance) provides ALL the intelligence.
 */
class ConversationBridge {
  private openai: OpenAI;
  private audioChunks: Buffer[] = [];
  private userResponses: string[] = [];
  private startTime: number;

  constructor(
    private config: Config,
    private initialQuestion: string
  ) {
    this.openai = new OpenAI({ apiKey: config.openaiApiKey });
    this.startTime = Date.now();
  }

  async handleCall(twilioWs: WebSocket): Promise<CallResult> {
    return new Promise(async (resolve, reject) => {
      try {
        // Greet and ask the question
        await this.speak(
          twilioWs,
          `Hello, I'm calling on behalf of Claude Code. ${this.initialQuestion}`
        );

        // Listen for response
        const response = await this.listenForResponse(twilioWs);
        this.userResponses.push(response);

        // Simple follow-up logic (no AI needed)
        if (response.split(' ').length < 10) {
          await this.speak(twilioWs, 'Could you elaborate a bit more?');
          const elaboration = await this.listenForResponse(twilioWs);
          this.userResponses.push(elaboration);
        }

        // Confirm and end
        await this.speak(
          twilioWs,
          "Thank you. I'll relay this information to Claude Code."
        );

        const duration = Math.round((Date.now() - this.startTime) / 1000);
        resolve({
          status: 'completed',
          transcript: this.userResponses.join('\n\n'),
          duration,
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private async speak(ws: WebSocket, text: string): Promise<void> {
    console.error(`Speaking: ${text}`);

    // Generate speech with OpenAI TTS ($0.015/1K chars ≈ $0.03-0.05/min)
    const mp3Response = await this.openai.audio.speech.create({
      model: 'tts-1', // Faster, cheaper model
      voice: 'onyx', // Clear male voice
      input: text,
      response_format: 'pcm', // Get raw PCM audio
      speed: 1.0,
    });

    // Convert response to buffer
    const arrayBuffer = await mp3Response.arrayBuffer();
    const pcmData = Buffer.from(arrayBuffer);

    // Convert PCM to μ-law for Twilio
    const muLawData = this.pcmToMuLaw(pcmData);

    // Send audio to Twilio in chunks
    const chunkSize = 160; // 20ms chunks for μ-law @ 8kHz

    for (let i = 0; i < muLawData.length; i += chunkSize) {
      const chunk = muLawData.slice(i, i + chunkSize);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            event: 'media',
            media: {
              payload: chunk.toString('base64'),
            },
          })
        );
      }
      // Small delay to avoid overwhelming the connection
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // Wait a bit for speech to finish
    await new Promise((resolve) => setTimeout(resolve, text.length * 50));
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

  private async listenForResponse(ws: WebSocket): Promise<string> {
    return new Promise((resolve, reject) => {
      this.audioChunks = [];
      let silenceTimer: NodeJS.Timeout | null = null;
      const SILENCE_THRESHOLD = 2000; // 2 seconds of silence = done speaking

      const onMessage = async (message: string) => {
        try {
          const msg = JSON.parse(message);

          if (msg.event === 'media' && msg.media?.payload) {
            const audioData = Buffer.from(msg.media.payload, 'base64');
            this.audioChunks.push(audioData);

            // Reset silence timer
            if (silenceTimer) clearTimeout(silenceTimer);
            silenceTimer = setTimeout(async () => {
              ws.off('message', onMessage);
              const transcript = await this.transcribeAudio();
              resolve(transcript);
            }, SILENCE_THRESHOLD);
          }
        } catch (error) {
          console.error('Error processing message:', error);
        }
      };

      ws.on('message', onMessage);

      // Timeout after 60 seconds
      setTimeout(() => {
        ws.off('message', onMessage);
        if (silenceTimer) clearTimeout(silenceTimer);
        reject(new Error('Response timeout'));
      }, 60000);
    });
  }

  private async transcribeAudio(): Promise<string> {
    if (this.audioChunks.length === 0) {
      return '';
    }

    // Combine all audio chunks
    const fullAudio = Buffer.concat(this.audioChunks);

    // Convert μ-law to WAV for Whisper
    const wavBuffer = this.muLawToWav(fullAudio);

    // Use Whisper API for transcription (cheap and accurate!)
    try {
      const file = new File([wavBuffer], 'audio.wav', { type: 'audio/wav' });
      const transcription = await this.openai.audio.transcriptions.create({
        file,
        model: 'whisper-1',
      });

      console.error('User said:', transcription.text);
      return transcription.text;
    } catch (error) {
      console.error('Transcription error:', error);
      return '[transcription failed]';
    }
  }

  private muLawToWav(muLawData: Buffer): Buffer {
    // Simple μ-law to PCM conversion
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
    header.writeUInt32LE(16, 16); // fmt chunk size
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(8000, 24); // sample rate
    header.writeUInt32LE(16000, 28); // byte rate
    header.writeUInt16LE(2, 32); // block align
    header.writeUInt16LE(16, 34); // bits per sample
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
}

export async function makePhoneCall(
  question: string,
  urgency: string = 'normal'
): Promise<CallResult> {
  const config = loadConfig();
  const twilioClient = Twilio(config.twilioAccountSid, config.twilioAuthToken);

  return new Promise((resolve, reject) => {
    let server: any;

    // Create HTTP server for Twilio webhooks
    const httpServer = createServer((req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);

      if (url.pathname === '/twiml') {
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${new URL(config.publicUrl).host}/media-stream" />
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
    const wss = new WebSocket.Server({ noServer: true });

    httpServer.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url!, `http://${request.headers.host}`);
      if (url.pathname === '/media-stream') {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    wss.on('connection', (ws) => {
      console.error('Twilio WebSocket connected');
      const bridge = new ConversationBridge(config, question);

      bridge
        .handleCall(ws)
        .then((result) => {
          cleanup();
          resolve(result);
        })
        .catch((error) => {
          cleanup();
          reject(error);
        });
    });

    httpServer.listen(config.port, () => {
      console.error(`Server listening on port ${config.port}`);

      // Initiate the call
      twilioClient.calls
        .create({
          url: `${config.publicUrl}/twiml`,
          to: config.userPhoneNumber,
          from: config.twilioPhoneNumber,
          timeout: 60,
        })
        .then((call) => {
          console.error('Call initiated:', call.sid);
        })
        .catch((error) => {
          console.error('Error initiating call:', error);
          cleanup();
          reject(error);
        });
    });

    function cleanup() {
      wss.close();
      httpServer.close();
    }

    // Cleanup after 6 minutes regardless
    setTimeout(() => {
      cleanup();
      reject(new Error('Call timeout'));
    }, 360000);
  });
}
