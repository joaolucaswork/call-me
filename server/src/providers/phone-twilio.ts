/**
 * Twilio Phone Provider (ConversationRelay)
 *
 * Uses Twilio ConversationRelay for text-based WebSocket communication.
 * Twilio handles STT (Deepgram) and TTS (ElevenLabs) server-side.
 * Our server only sends/receives JSON text messages.
 */

import type { PhoneProvider, PhoneConfig } from './types.js';

interface TwilioCallResponse {
  sid: string;
  status: string;
}

export type { TwilioCallResponse };

export class TwilioPhoneProvider implements PhoneProvider {
  readonly name = 'twilio';
  private accountSid: string | null = null;
  private authToken: string | null = null;
  private voice: string | null = null;

  initialize(config: PhoneConfig): void {
    this.accountSid = config.accountSid;
    this.authToken = config.authToken;
    this.voice = config.voice || null;
    console.error(`Phone provider: Twilio (ConversationRelay)`);
  }

  async initiateCall(to: string, from: string, webhookUrl: string): Promise<string> {
    if (!this.accountSid || !this.authToken) {
      throw new Error('Twilio not initialized');
    }

    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Calls.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: (() => {
          const params = new URLSearchParams();
          params.append('To', to);
          params.append('From', from);
          params.append('Url', webhookUrl);
          params.append('StatusCallback', webhookUrl);
          params.append('StatusCallbackEvent', 'initiated');
          params.append('StatusCallbackEvent', 'ringing');
          params.append('StatusCallbackEvent', 'answered');
          params.append('StatusCallbackEvent', 'completed');
          params.append('MachineDetection', 'Enable');
          params.append('MachineDetectionTimeout', '5');
          return params.toString();
        })(),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Twilio call failed: ${response.status} ${error}`);
    }

    const data = await response.json() as TwilioCallResponse;
    return data.sid;
  }

  async answerCall(_callSid: string): Promise<void> {
    // Twilio answers via TwiML response in the webhook handler
  }

  async startStreaming(_callControlId: string, _streamUrl: string): Promise<void> {
    // ConversationRelay starts via TwiML — no-op
  }

  async hangup(callSid: string): Promise<void> {
    if (!this.accountSid || !this.authToken) {
      throw new Error('Twilio not initialized');
    }

    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Calls/${callSid}.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ Status: 'completed' }).toString(),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error(`Twilio hangup failed: ${response.status} ${error}`);
    }
  }

  getConnectXml(wsUrl: string, options?: { welcomeGreeting?: string; statusCallbackUrl?: string }): string {
    const voice = this.voice || 'onwK4e9ZLuTAKqWW03F9';
    const greeting = options?.welcomeGreeting
      ? ` welcomeGreeting="${this.escapeXml(options.welcomeGreeting)}"`
      : '';
    const statusAttr = options?.statusCallbackUrl
      ? ` statusCallback="${options.statusCallbackUrl}" statusCallbackMethod="POST"`
      : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect${statusAttr}>
    <ConversationRelay url="${wsUrl}" ttsProvider="ElevenLabs" voice="${voice}" language="pt-BR" transcriptionProvider="Deepgram" dtmfDetection="true" interruptible="true"${greeting} />
  </Connect>
</Response>`;
  }

  private escapeXml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
