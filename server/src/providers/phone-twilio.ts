/**
 * Twilio Phone Provider
 *
 * Uses Twilio Programmable Voice API with Media Streams.
 *
 * Pricing (as of 2025):
 * - Outbound: ~$0.014/min
 * - Inbound: ~$0.0085/min
 * - Phone number: ~$1.15/month
 */

import type { PhoneProvider, PhoneConfig } from './types.js';

interface TwilioCallResponse {
  sid: string;
  status: string;
}

// Re-export for use in phone-call.ts
export type { TwilioCallResponse };

export class TwilioPhoneProvider implements PhoneProvider {
  readonly name = 'twilio';
  private accountSid: string | null = null;
  private authToken: string | null = null;

  initialize(config: PhoneConfig): void {
    this.accountSid = config.accountSid;
    this.authToken = config.authToken;
    console.error(`Phone provider: Twilio`);
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

  /**
   * Start media streaming for Twilio.
   * Note: For Twilio, streaming is started via TwiML response in the webhook,
   * not via a separate API call. This method is a no-op for Twilio.
   */
  async startStreaming(_callControlId: string, _streamUrl: string): Promise<void> {
    // Twilio starts streaming via TwiML response in getStreamConnectXml
    // This is a no-op for Twilio
  }

  /**
   * Hang up a call using Twilio REST API
   */
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
        body: new URLSearchParams({
          Status: 'completed',
        }).toString(),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error(`Twilio hangup failed: ${response.status} ${error}`);
    }
  }

  /**
   * Get TwiML response for connecting media stream
   * This is called when Twilio requests the webhook URL after call is answered
   */
  getStreamConnectXml(streamUrl: string, statusCallbackUrl?: string): string {
    // Using <Connect><Stream> for bidirectional audio
    // <Start><Stream> is unidirectional (receive-only) - cannot send audio back
    // <Connect><Stream> allows both sending and receiving audio via WebSocket
    const statusAttr = statusCallbackUrl ? ` statusCallback="${statusCallbackUrl}" statusCallbackMethod="POST"` : '';
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}"${statusAttr} />
  </Connect>
</Response>`;
  }
}
